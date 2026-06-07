const express = require('express');
const crypto = require('crypto');
const { run, get, all, runInTransaction } = require('../utils/dbHelper');
const { success, error } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { importPreviewValidation, importConfirmValidation } = require('../middleware/validator');

const router = express.Router();

const importCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const PHONE_REGEX = /^1[3-9]\d{9}$/;

const isValidPlotStatus = (status) => {
  return ['空闲', '已占用', '维修中'].includes(status);
};

const isValidPlotType = (type) => {
  return ['单穴', '双穴', '家族墓'].includes(type);
};

const validatePlotItem = async (item, index, existingPlots, batchPlotNumbers, batchPositions) => {
  const errors = [];

  if (!item.plot_number || typeof item.plot_number !== 'string' || item.plot_number.trim() === '') {
    errors.push('墓位编号不能为空');
  } else {
    const plotNumber = item.plot_number.trim();
    if (batchPlotNumbers.has(plotNumber)) {
      errors.push(`墓位编号 ${plotNumber} 在导入批次中重复`);
    } else {
      batchPlotNumbers.add(plotNumber);
      if (existingPlots.byNumber.has(plotNumber)) {
        errors.push(`墓位编号 ${plotNumber} 已存在`);
      }
    }
  }

  if (!item.area || typeof item.area !== 'string' || item.area.trim() === '') {
    errors.push('区域不能为空');
  }

  if (item.row === undefined || item.row === null || isNaN(parseInt(item.row))) {
    errors.push('排号必须是数字');
  } else if (parseInt(item.row) <= 0) {
    errors.push('排号必须大于0');
  }

  if (item.col === undefined || item.col === null || isNaN(parseInt(item.col))) {
    errors.push('列号必须是数字');
  } else if (parseInt(item.col) <= 0) {
    errors.push('列号必须大于0');
  }

  if (!errors.some(e => e.includes('区域') || e.includes('排号') || e.includes('列号'))) {
    const area = item.area.trim();
    const row = parseInt(item.row);
    const col = parseInt(item.col);
    const positionKey = `${area}-${row}-${col}`;
    
    if (batchPositions.has(positionKey)) {
      errors.push(`位置 ${area} ${row}排${col}号 在导入批次中重复`);
    } else {
      batchPositions.add(positionKey);
      if (existingPlots.byPosition.has(positionKey)) {
        errors.push(`位置 ${area} ${row}排${col}号 已存在`);
      }
    }
  }

  if (item.status && !isValidPlotStatus(item.status)) {
    errors.push('状态只能是 空闲、已占用 或 维修中');
  }

  if (item.type && !isValidPlotType(item.type)) {
    errors.push('类型只能是 单穴、双穴 或 家族墓');
  }

  if (item.price !== undefined && item.price !== null && isNaN(parseFloat(item.price))) {
    errors.push('价格必须是数字');
  } else if (item.price !== undefined && item.price !== null && parseFloat(item.price) < 0) {
    errors.push('价格不能小于0');
  }

  return {
    index,
    data: item,
    valid: errors.length === 0,
    errors
  };
};

const validateContactItem = async (item, index, existingContacts, existingDeceased, batchPhones) => {
  const errors = [];

  if (!item.name || typeof item.name !== 'string' || item.name.trim() === '') {
    errors.push('联系人姓名不能为空');
  }

  if (!item.phone || typeof item.phone !== 'string' || item.phone.trim() === '') {
    errors.push('联系电话不能为空');
  } else if (!PHONE_REGEX.test(item.phone.trim())) {
    errors.push('联系电话格式不正确，必须是11位有效手机号');
  } else {
    const phone = item.phone.trim();
    if (batchPhones.has(phone)) {
      errors.push(`手机号 ${phone} 在导入批次中重复`);
    } else {
      batchPhones.add(phone);
    }
  }

  if (item.deceased_id !== undefined && item.deceased_id !== null && item.deceased_id !== '') {
    const deceasedId = parseInt(item.deceased_id);
    if (isNaN(deceasedId)) {
      errors.push('关联逝者ID必须是数字');
    } else if (!existingDeceased.has(deceasedId)) {
      errors.push(`关联逝者ID ${deceasedId} 不存在`);
    }
  }

  if (item.id_card && typeof item.id_card === 'string') {
    const idCard = item.id_card.trim();
    if (idCard.length !== 15 && idCard.length !== 18) {
      errors.push('身份证号格式不正确');
    }
  }

  return {
    index,
    data: item,
    valid: errors.length === 0,
    errors
  };
};

const getExistingPlots = async () => {
  const plots = await all('SELECT plot_number, area, row, col FROM plots');
  const byNumber = new Set();
  const byPosition = new Set();
  
  plots.forEach(plot => {
    byNumber.add(plot.plot_number);
    byPosition.add(`${plot.area}-${plot.row}-${plot.col}`);
  });
  
  return { byNumber, byPosition };
};

const getExistingDeceased = async () => {
  const deceased = await all('SELECT id FROM deceased');
  return new Set(deceased.map(d => d.id));
};

const getExistingContacts = async () => {
  const contacts = await all('SELECT phone FROM contacts');
  return new Set(contacts.map(c => c.phone));
};

const generateImportToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

router.post('/preview', authenticate, importPreviewValidation, async (req, res) => {
  try {
    const { type, data } = req.body;
    const totalCount = data.length;
    
    let validationResults = [];
    let existingData = {};
    const batchPlotNumbers = new Set();
    const batchPositions = new Set();
    const batchPhones = new Set();

    if (type === 'plot') {
      existingData.plots = await getExistingPlots();
      
      for (let i = 0; i < data.length; i++) {
        const result = await validatePlotItem(data[i], i, existingData.plots, batchPlotNumbers, batchPositions);
        validationResults.push(result);
      }
    } else if (type === 'contact') {
      existingData.deceased = await getExistingDeceased();
      existingData.contacts = await getExistingContacts();
      
      for (let i = 0; i < data.length; i++) {
        const result = await validateContactItem(data[i], i, existingData.contacts, existingData.deceased, batchPhones);
        validationResults.push(result);
      }
    }

    const validItems = validationResults.filter(r => r.valid);
    const invalidItems = validationResults.filter(r => !r.valid);
    const importableCount = validItems.length;

    const duplicateItems = validationResults.filter(r => 
      r.errors.some(e => e.includes('导入批次中重复'))
    );

    const errorDetails = invalidItems.map(r => ({
      index: r.index,
      data: r.data,
      errors: r.errors
    }));

    const fieldValidation = {
      totalFields: type === 'plot' ? totalCount * 5 : totalCount * 3,
      validFields: 0,
      invalidFields: 0
    };
    
    validationResults.forEach(r => {
      if (type === 'plot') {
        const requiredFields = ['plot_number', 'area', 'row', 'col'];
        requiredFields.forEach(field => {
          if (r.errors.some(e => e.includes(field === 'plot_number' ? '墓位编号' : 
                                                field === 'area' ? '区域' :
                                                field === 'row' ? '排号' : '列号'))) {
            fieldValidation.invalidFields++;
          } else {
            fieldValidation.validFields++;
          }
        });
      } else {
        const requiredFields = ['name', 'phone'];
        requiredFields.forEach(field => {
          if (r.errors.some(e => e.includes(field === 'name' ? '姓名' : '电话'))) {
            fieldValidation.invalidFields++;
          } else {
            fieldValidation.validFields++;
          }
        });
      }
    });

    const importToken = generateImportToken();
    const cacheData = {
      type,
      validItems: validItems.map(r => r.data),
      createdAt: Date.now(),
      userId: req.user.id
    };
    
    importCache.set(importToken, cacheData);
    
    setTimeout(() => {
      importCache.delete(importToken);
    }, CACHE_TTL);

    success(res, {
      import_token: importToken,
      type,
      total_count: totalCount,
      importable_count: importableCount,
      invalid_count: invalidItems.length,
      duplicate_count: duplicateItems.length,
      field_validation: fieldValidation,
      error_details: errorDetails,
      duplicate_items: duplicateItems.map(r => ({
        index: r.index,
        data: r.data,
        errors: r.errors
      })),
      preview: validItems.map(r => r.data)
    }, '数据预览校验完成');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/confirm', authenticate, importConfirmValidation, async (req, res) => {
  try {
    const { import_token } = req.body;
    
    const cacheData = importCache.get(import_token);
    if (!cacheData) {
      return error(res, '导入凭证无效或已过期，请重新预览', 400);
    }

    if (cacheData.userId !== req.user.id) {
      return error(res, '无权限确认此导入', 403);
    }

    const { type, validItems } = cacheData;
    const importedIds = [];

    if (validItems.length === 0) {
      return error(res, '没有可导入的有效数据', 400);
    }

    await runInTransaction(async () => {
      if (type === 'plot') {
        for (const item of validItems) {
          const result = await run(
            'INSERT INTO plots (plot_number, area, row, col, status, type, price, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              item.plot_number.trim(),
              item.area.trim(),
              parseInt(item.row),
              parseInt(item.col),
              item.status || '空闲',
              item.type || '单穴',
              item.price !== undefined && item.price !== null ? parseFloat(item.price) : 0,
              item.remark || null
            ]
          );
          importedIds.push({ id: result.id, plot_number: item.plot_number });
        }
      } else if (type === 'contact') {
        for (const item of validItems) {
          const deceasedId = item.deceased_id !== undefined && item.deceased_id !== null && item.deceased_id !== ''
            ? parseInt(item.deceased_id)
            : null;
            
          const result = await run(
            'INSERT INTO contacts (name, phone, id_card, address, relationship, deceased_id, remark) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
              item.name.trim(),
              item.phone.trim(),
              item.id_card ? item.id_card.trim() : null,
              item.address ? item.address.trim() : null,
              item.relationship ? item.relationship.trim() : null,
              deceasedId,
              item.remark || null
            ]
          );
          importedIds.push({ id: result.id, name: item.name, phone: item.phone });
        }
      }
    });

    importCache.delete(import_token);

    success(res, {
      type,
      imported_count: importedIds.length,
      imported_items: importedIds
    }, '数据导入成功');
  } catch (err) {
    error(res, `导入失败: ${err.message}`, 500);
  }
});

module.exports = router;
