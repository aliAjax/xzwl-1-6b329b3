const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { billPreviewValidation, billGenerateValidation, billBatchQueryValidation, idParamValidation, billConfigUpdateValidation } = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');

const router = express.Router();

const ERROR_TYPES = {
  NO_CONTACT: 'no_contact',
  NO_PREVIOUS_PAYMENT: 'no_previous_payment',
  DUPLICATE_BILL: 'duplicate_bill',
  INVALID_STATUS: 'invalid_status',
  OTHER: 'other'
};

const getDefaultFeeStandard = async () => {
  const config = await get('SELECT config_value FROM system_config WHERE config_key = ?', ['default_annual_fee']);
  return config ? parseFloat(config.config_value) : 200;
};

const findLastPaymentForPlot = async (plotId) => {
  const payment = await get(`
    SELECT * FROM payments 
    WHERE plot_id = ? 
    ORDER BY due_date DESC 
    LIMIT 1
  `, [plotId]);
  return payment;
};

const checkExistingBill = async (plotId, billYear) => {
  const existing = await get(`
    SELECT id, bill_type FROM payments 
    WHERE plot_id = ? AND bill_year = ?
    LIMIT 1
  `, [plotId, billYear]);
  return existing ? { exists: true, bill_type: existing.bill_type } : { exists: false, bill_type: null };
};

const generateBatchNo = () => {
  const now = moment();
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `BILL-${now.format('YYYYMMDD')}-${random}`;
};

const getEligiblePlots = async (area, plotIds) => {
  let sql = `
    SELECT DISTINCT p.*, 
           c.id as contact_id,
           c.name as contact_name,
           c.phone as contact_phone,
           d.name as deceased_name
    FROM plots p
    LEFT JOIN deceased d ON p.id = d.plot_id
    LEFT JOIN contacts c ON d.id = c.deceased_id
    WHERE p.status = '已占用'
  `;
  const params = [];

  if (area) {
    sql += ' AND p.area = ?';
    params.push(area);
  }

  if (plotIds && plotIds.length > 0) {
    const placeholders = plotIds.map(() => '?').join(',');
    sql += ` AND p.id IN (${placeholders})`;
    params.push(...plotIds);
  }

  sql += ' ORDER BY p.area, p.row, p.col';

  return await all(sql, params);
};

const processPlotForBill = async (plot, billYear, feeStandard) => {
  const result = {
    plot_id: plot.id,
    plot_number: plot.plot_number,
    area: plot.area,
    contact_id: plot.contact_id,
    contact_name: plot.contact_name,
    contact_phone: plot.contact_phone,
    deceased_name: plot.deceased_name,
    fee_standard: feeStandard,
    bill_year: billYear,
    start_date: null,
    due_date: null,
    amount: feeStandard,
    is_duplicate: false,
    error_type: null,
    error_message: null
  };

  if (!plot.contact_id) {
    result.error_type = ERROR_TYPES.NO_CONTACT;
    result.error_message = '墓位未关联联系人，无法生成账单';
    return result;
  }

  const duplicateCheck = await checkExistingBill(plot.id, billYear);
  if (duplicateCheck.exists) {
    result.is_duplicate = true;
    result.error_type = ERROR_TYPES.DUPLICATE_BILL;
    const billTypeDesc = duplicateCheck.bill_type === 'manual' ? '手工录入' : '系统生成';
    result.error_message = `${billYear}年度账单已存在（${billTypeDesc}），跳过生成`;
    return result;
  }

  const lastPayment = await findLastPaymentForPlot(plot.id);
  if (lastPayment && lastPayment.due_date) {
    result.start_date = moment(lastPayment.due_date).add(1, 'day').format('YYYY-MM-DD');
  } else {
    result.start_date = `${billYear}-01-01`;
  }

  result.due_date = moment(result.start_date).add(1, 'year').subtract(1, 'day').format('YYYY-MM-DD');

  return result;
};

router.get('/config', authenticate, async (req, res) => {
  try {
    const config = await get('SELECT * FROM system_config WHERE config_key = ?', ['default_annual_fee']);
    if (!config) {
      return success(res, { default_annual_fee: 200, description: '默认年度管理费标准（元/年）' });
    }
    success(res, {
      default_annual_fee: parseFloat(config.config_value),
      description: config.description
    });
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/config', authenticate, billConfigUpdateValidation, async (req, res) => {
  try {
    const { default_annual_fee } = req.body;

    const existing = await get('SELECT * FROM system_config WHERE config_key = ?', ['default_annual_fee']);
    if (existing) {
      await run(
        'UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?',
        [default_annual_fee.toString(), 'default_annual_fee']
      );
    } else {
      await run(
        'INSERT INTO system_config (config_key, config_value, description) VALUES (?, ?, ?)',
        ['default_annual_fee', default_annual_fee.toString(), '默认年度管理费标准（元/年）']
      );
    }

    success(res, { default_annual_fee }, '收费标准更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/preview', authenticate, billPreviewValidation, async (req, res) => {
  try {
    const { bill_year, area, plot_ids } = req.body;
    let { fee_standard } = req.body;

    if (!fee_standard) {
      fee_standard = await getDefaultFeeStandard();
    }

    const plots = await getEligiblePlots(area, plot_ids);

    if (plots.length === 0) {
      return success(res, {
        bill_year,
        fee_standard,
        total_count: 0,
        to_generate_count: 0,
        skip_count: 0,
        error_count: 0,
        preview_list: [],
        exception_list: []
      }, '没有符合条件的墓位');
    }

    const previewList = [];
    const exceptionList = [];
    let skipCount = 0;
    let errorCount = 0;

    for (const plot of plots) {
      const result = await processPlotForBill(plot, bill_year, fee_standard);
      
      if (result.error_type) {
        exceptionList.push(result);
        if (result.error_type === ERROR_TYPES.DUPLICATE_BILL) {
          skipCount++;
        } else {
          errorCount++;
        }
      } else {
        previewList.push(result);
      }
    }

    success(res, {
      bill_year,
      fee_standard,
      total_count: plots.length,
      to_generate_count: previewList.length,
      skip_count: skipCount,
      error_count: errorCount,
      preview_list: previewList,
      exception_list: exceptionList
    }, '预览成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/generate', authenticate, billGenerateValidation, async (req, res) => {
  try {
    const { bill_year, fee_standard, area, plot_ids, remark } = req.body;

    const plots = await getEligiblePlots(area, plot_ids);

    if (plots.length === 0) {
      return error(res, '没有符合条件的墓位', 400);
    }

    const batchNo = generateBatchNo();
    const batchResult = await run(
      `INSERT INTO bill_batches (batch_no, bill_year, fee_standard, total_count, status, operator_id, operator_name, remark) 
       VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
      [batchNo, bill_year, fee_standard, plots.length, req.user.id, req.user.name, remark]
    );

    const batchId = batchResult.id;

    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const plot of plots) {
      try {
        const result = await processPlotForBill(plot, bill_year, fee_standard);

        if (result.error_type) {
          await run(
            'INSERT INTO bill_batch_exceptions (batch_id, plot_id, plot_number, error_type, error_message) VALUES (?, ?, ?, ?, ?)',
            [batchId, plot.id, plot.plot_number, result.error_type, result.error_message]
          );
          if (result.error_type === ERROR_TYPES.DUPLICATE_BILL) {
            skipCount++;
          } else {
            errorCount++;
          }
          continue;
        }

        await run(
          `INSERT INTO payments (plot_id, contact_id, amount, start_date, due_date, status, remark, bill_type, bill_year, bill_batch_id) 
           VALUES (?, ?, ?, ?, ?, '未缴', ?, 'system', ?, ?)`,
          [
            result.plot_id,
            result.contact_id,
            result.amount,
            result.start_date,
            result.due_date,
            `${bill_year}年度管理费（系统生成）`,
            bill_year,
            batchId
          ]
        );
        successCount++;
      } catch (err) {
        errorCount++;
        await run(
          'INSERT INTO bill_batch_exceptions (batch_id, plot_id, plot_number, error_type, error_message) VALUES (?, ?, ?, ?, ?)',
          [batchId, plot.id, plot.plot_number, ERROR_TYPES.OTHER, `生成失败: ${err.message}`]
        );
      }
    }

    await run(
      'UPDATE bill_batches SET success_count = ?, skip_count = ?, error_count = ?, status = ? WHERE id = ?',
      [successCount, skipCount, errorCount, 'completed', batchId]
    );

    const batchSummary = {
      batch_no: batchNo,
      bill_year,
      fee_standard,
      total_count: plots.length,
      success_count: successCount,
      skip_count: skipCount,
      error_count: errorCount
    };
    const summary = generateSummary(RESOURCE_TYPES.BILL_BATCH, ACTIONS.CREATE, batchSummary);
    await logOperation(req, RESOURCE_TYPES.BILL_BATCH, batchId, ACTIONS.CREATE, summary);

    success(res, {
      batch_id: batchId,
      batch_no: batchNo,
      bill_year,
      fee_standard,
      total_count: plots.length,
      success_count: successCount,
      skip_count: skipCount,
      error_count: errorCount
    }, '账单生成完成');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/batches', authenticate, billBatchQueryValidation, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, bill_year = '', status = '' } = req.query;

    let baseSql = `
      SELECT * FROM bill_batches 
      WHERE 1=1
    `;
    const params = [];

    if (bill_year) {
      baseSql += ' AND bill_year = ?';
      params.push(parseInt(bill_year));
    }

    if (status) {
      baseSql += ' AND status = ?';
      params.push(status);
    }

    const result = await paginateQuery(baseSql, params, page, pageSize, 'created_at DESC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/batches/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;

    const batch = await get('SELECT * FROM bill_batches WHERE id = ?', [id]);
    if (!batch) {
      return error(res, '批次不存在', 404);
    }

    const generatedBills = await all(`
      SELECT py.*,
             p.plot_number,
             p.area,
             c.name as contact_name,
             c.phone as contact_phone,
             d.name as deceased_name
      FROM payments py
      LEFT JOIN plots p ON py.plot_id = p.id
      LEFT JOIN contacts c ON py.contact_id = c.id
      LEFT JOIN deceased d ON p.id = d.plot_id
      WHERE py.bill_batch_id = ?
      ORDER BY py.id DESC
    `, [id]);

    const exceptions = await all(`
      SELECT * FROM bill_batch_exceptions 
      WHERE batch_id = ? 
      ORDER BY id ASC
    `, [id]);

    success(res, {
      batch,
      generated_bills: generatedBills,
      exceptions
    }, '批次详情查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
