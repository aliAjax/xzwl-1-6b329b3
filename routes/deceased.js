const express = require('express');
const { run, get, paginateQuery, all } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { deceasedCreateValidation, idParamValidation } = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');

const router = express.Router();

const checkPlotReservation = async (plotId) => {
  const activeReservation = await get(`
    SELECT r.id, r.expires_at, c.contract_no
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    WHERE r.plot_id = ? 
      AND r.status = 'active' 
      AND c.status != 'voided'
      AND c.status != 'effective'
    LIMIT 1
  `, [plotId]);

  if (activeReservation) {
    const moment = require('moment');
    if (moment(activeReservation.expires_at).isAfter(moment())) {
      return { 
        reserved: true, 
        reason: `墓位已被合同${activeReservation.contract_no}预留，有效期至${activeReservation.expires_at}` 
      };
    }
  }

  const activeContract = await get(`
    SELECT id, contract_no, status
    FROM contracts 
    WHERE plot_id = ? 
      AND status IN ('reserved', 'signed')
    LIMIT 1
  `, [plotId]);

  if (activeContract) {
    const statusNames = { reserved: '预留中', signed: '已签约' };
    return { 
      reserved: true, 
      reason: `墓位已关联${statusNames[activeContract.status]}合同${activeContract.contract_no}` 
    };
  }

  return { reserved: false };
};

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, keyword = '', plot_id = '' } = req.query;
    
    let baseSql = `
      SELECT d.*, 
             p.plot_number,
             p.area,
             c.name as contact_name,
             c.phone as contact_phone
      FROM deceased d 
      LEFT JOIN plots p ON d.plot_id = p.id 
      LEFT JOIN contacts c ON d.id = c.deceased_id 
      WHERE 1=1
    `;
    const params = [];
    
    if (keyword) {
      baseSql += ' AND d.name LIKE ?';
      params.push(`%${keyword}%`);
    }
    
    if (plot_id) {
      baseSql += ' AND d.plot_id = ?';
      params.push(plot_id);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize);
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const deceased = await get(`
      SELECT d.*, 
             p.plot_number,
             p.area,
             c.id as contact_id,
             c.name as contact_name,
             c.phone as contact_phone,
             c.id_card as contact_id_card,
             c.address as contact_address,
             c.relationship as contact_relationship
      FROM deceased d 
      LEFT JOIN plots p ON d.plot_id = p.id 
      LEFT JOIN contacts c ON d.id = c.deceased_id 
      WHERE d.id = ?
    `, [req.params.id]);
    
    if (!deceased) {
      return error(res, '逝者信息不存在', 404);
    }
    
    success(res, deceased);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, deceasedCreateValidation, async (req, res) => {
  try {
    const { name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark } = req.body;
    
    if (plot_id) {
      const plot = await get('SELECT id, status FROM plots WHERE id = ?', [plot_id]);
      if (!plot) {
        return error(res, '墓位不存在', 400);
      }
      
      const reservation = await checkPlotReservation(plot_id);
      if (reservation.reserved) {
        return error(res, reservation.reason + '，请先通过合同流程处理', 400);
      }
      
      if (plot.status === '维修中') {
        return error(res, '该墓位正在维修中，不能占用', 400);
      }
    }
    
    const result = await run(
      'INSERT INTO deceased (name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark]
    );
    
    if (plot_id) {
      await run('UPDATE plots SET status = "已占用" WHERE id = ?', [plot_id]);
    }

    const summary = generateSummary(RESOURCE_TYPES.DECEASED, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.DECEASED, result.id, ACTIONS.CREATE, summary);
    
    success(res, { id: result.id }, '逝者信息创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark } = req.body;
    
    const existing = await get('SELECT * FROM deceased WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '逝者信息不存在', 404);
    }
    
    if (plot_id && plot_id !== existing.plot_id) {
      const plot = await get('SELECT id, status FROM plots WHERE id = ?', [plot_id]);
      if (!plot) {
        return error(res, '新墓位不存在', 400);
      }
      
      const reservation = await checkPlotReservation(plot_id);
      if (reservation.reserved) {
        return error(res, reservation.reason + '，请先通过合同流程处理', 400);
      }
      
      if (plot.status === '维修中') {
        return error(res, '该墓位正在维修中，不能占用', 400);
      }
      
      if (existing.plot_id) {
        const hasOtherDeceased = await get('SELECT COUNT(*) as count FROM deceased WHERE plot_id = ? AND id != ?', [existing.plot_id, id]);
        if (hasOtherDeceased.count === 0) {
          await run('UPDATE plots SET status = "空闲" WHERE id = ?', [existing.plot_id]);
        }
      }
      
      await run('UPDATE plots SET status = "已占用" WHERE id = ?', [plot_id]);
    }
    
    await run(
      'UPDATE deceased SET name = ?, gender = ?, birth_date = ?, death_date = ?, plot_id = ?, relationship = ?, interment_date = ?, remark = ? WHERE id = ?',
      [name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark, id]
    );

    const newData = { name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark };
    const summary = generateSummary(RESOURCE_TYPES.DECEASED, ACTIONS.UPDATE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.DECEASED, id, ACTIONS.UPDATE, summary);
    
    success(res, null, '逝者信息更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT id, plot_id FROM deceased WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '逝者信息不存在', 404);
    }
    
    await run('DELETE FROM deceased WHERE id = ?', [id]);
    
    if (existing.plot_id) {
      const hasOtherDeceased = await get('SELECT COUNT(*) as count FROM deceased WHERE plot_id = ?', [existing.plot_id]);
      if (hasOtherDeceased.count === 0) {
        await run('UPDATE plots SET status = "空闲" WHERE id = ?', [existing.plot_id]);
      }
    }

    const summary = generateSummary(RESOURCE_TYPES.DECEASED, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.DECEASED, id, ACTIONS.DELETE, summary);
    
    success(res, null, '逝者信息删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
