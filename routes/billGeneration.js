const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { billPreviewValidation, billGenerateValidation, billBatchQueryValidation, idParamValidation, billConfigUpdateValidation, billBatchRetryValidation } = require('../middleware/validator');
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

    const successBills = await all(`
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

    const allExceptions = await all(`
      SELECT be.*,
             p.area
      FROM bill_batch_exceptions be
      LEFT JOIN plots p ON be.plot_id = p.id
      WHERE be.batch_id = ? 
      ORDER BY be.id ASC
    `, [id]);

    const skipItems = allExceptions.filter(e => e.error_type === ERROR_TYPES.DUPLICATE_BILL);
    const errorItems = allExceptions.filter(e => e.error_type !== ERROR_TYPES.DUPLICATE_BILL);
    const resolvedItems = errorItems.filter(e => e.resolved === 1);
    const unresolvedItems = errorItems.filter(e => e.resolved === 0);

    const successAmount = successBills.reduce((sum, bill) => sum + (bill.amount || 0), 0);
    const skipAmount = skipItems.length * batch.fee_standard;
    const errorAmount = unresolvedItems.length * batch.fee_standard;
    const resolvedAmount = resolvedItems.length * batch.fee_standard;
    const totalAmount = successAmount + skipAmount + errorAmount;

    success(res, {
      batch,
      success_bills: successBills,
      skip_items: skipItems,
      error_items: errorItems,
      unresolved_error_items: unresolvedItems,
      resolved_error_items: resolvedItems,
      generated_bills: successBills,
      exceptions: allExceptions,
      summary: {
        total_count: batch.total_count,
        success_count: batch.success_count,
        skip_count: batch.skip_count,
        error_count: batch.error_count,
        unresolved_error_count: unresolvedItems.length,
        resolved_error_count: resolvedItems.length,
        total_amount: totalAmount,
        success_amount: successAmount,
        skip_amount: skipAmount,
        error_amount: errorAmount,
        resolved_amount: resolvedAmount,
        fee_standard: batch.fee_standard
      }
    }, '批次详情查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/batches/:id/retry', authenticate, billBatchRetryValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;

    const batch = await get('SELECT * FROM bill_batches WHERE id = ?', [id]);
    if (!batch) {
      return error(res, '批次不存在', 404);
    }

    if (batch.status !== 'completed') {
      return error(res, '批次尚未完成，无法重试', 400);
    }

    const errorExceptions = await all(`
      SELECT be.*,
             p.area,
             p.plot_number,
             p.status as plot_status
      FROM bill_batch_exceptions be
      LEFT JOIN plots p ON be.plot_id = p.id
      WHERE be.batch_id = ? 
        AND be.error_type != ?
        AND be.resolved = 0
      ORDER BY be.id ASC
    `, [id, ERROR_TYPES.DUPLICATE_BILL]);

    if (errorExceptions.length === 0) {
      return success(res, {
        batch_id: id,
        batch_no: batch.batch_no,
        retry_count: 0,
        success_count: 0,
        error_count: 0,
        message: '没有需要重试的异常项'
      }, '无异常项需要重试');
    }

    const { bill_year, fee_standard } = batch;
    let retrySuccessCount = 0;
    let retryErrorCount = 0;

    for (const exception of errorExceptions) {
      try {
        const plot = await get(`
          SELECT DISTINCT p.*, 
                 c.id as contact_id,
                 c.name as contact_name,
                 c.phone as contact_phone,
                 d.name as deceased_name
          FROM plots p
          LEFT JOIN deceased d ON p.id = d.plot_id
          LEFT JOIN contacts c ON d.id = c.deceased_id
          WHERE p.id = ?
        `, [exception.plot_id]);

        if (!plot) {
          await run(
            'UPDATE bill_batch_exceptions SET retry_count = retry_count + 1, last_retried_at = CURRENT_TIMESTAMP, error_message = ? WHERE id = ?',
            [`重试失败: 墓位不存在`, exception.id]
          );
          retryErrorCount++;
          continue;
        }

        const result = await processPlotForBill(plot, bill_year, fee_standard);

        if (result.error_type) {
          await run(
            'UPDATE bill_batch_exceptions SET retry_count = retry_count + 1, last_retried_at = CURRENT_TIMESTAMP, error_type = ?, error_message = ? WHERE id = ?',
            [result.error_type, result.error_message, exception.id]
          );
          if (result.error_type === ERROR_TYPES.DUPLICATE_BILL) {
            await run(
              'UPDATE bill_batches SET skip_count = skip_count + 1, error_count = error_count - 1 WHERE id = ?',
              [id]
            );
          }
          retryErrorCount++;
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
            `${bill_year}年度管理费（重试生成）`,
            bill_year,
            id
          ]
        );

        await run(
          'UPDATE bill_batch_exceptions SET retry_count = retry_count + 1, last_retried_at = CURRENT_TIMESTAMP, resolved = 1 WHERE id = ?',
          [exception.id]
        );

        await run(
          'UPDATE bill_batches SET success_count = success_count + 1, error_count = error_count - 1 WHERE id = ?',
          [id]
        );

        retrySuccessCount++;
      } catch (err) {
        retryErrorCount++;
        await run(
          'UPDATE bill_batch_exceptions SET retry_count = retry_count + 1, last_retried_at = CURRENT_TIMESTAMP, error_type = ?, error_message = ? WHERE id = ?',
          [ERROR_TYPES.OTHER, `重试失败: ${err.message}`, exception.id]
        );
      }
    }

    const updatedBatch = await get('SELECT * FROM bill_batches WHERE id = ?', [id]);

    const retrySummary = {
      batch_no: batch.batch_no,
      bill_year,
      fee_standard,
      total_retry_count: errorExceptions.length,
      retry_success_count: retrySuccessCount,
      retry_error_count: retryErrorCount,
      success_count: updatedBatch.success_count,
      skip_count: updatedBatch.skip_count,
      error_count: updatedBatch.error_count
    };
    const summary = generateSummary(RESOURCE_TYPES.BILL_BATCH, ACTIONS.UPDATE, retrySummary);
    await logOperation(req, RESOURCE_TYPES.BILL_BATCH, id, ACTIONS.UPDATE, summary);

    success(res, {
      batch_id: id,
      batch_no: batch.batch_no,
      bill_year,
      fee_standard,
      total_retry_count: errorExceptions.length,
      retry_success_count: retrySuccessCount,
      retry_error_count: retryErrorCount,
      success_count: updatedBatch.success_count,
      skip_count: updatedBatch.skip_count,
      error_count: updatedBatch.error_count
    }, '异常项重试完成');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/batches/:id/export', authenticate, idParamValidation, async (req, res) => {
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
      ORDER BY py.id ASC
    `, [id]);

    const exceptions = await all(`
      SELECT be.*,
             p.area
      FROM bill_batch_exceptions be
      LEFT JOIN plots p ON be.plot_id = p.id
      WHERE be.batch_id = ?
      ORDER BY be.id ASC
    `, [id]);

    const exportList = [];
    let index = 1;

    for (const bill of generatedBills) {
      exportList.push({
        '序号': index++,
        '墓位编号': bill.plot_number || '',
        '区域': bill.area || '',
        '联系人姓名': bill.contact_name || '',
        '联系电话': bill.contact_phone || '',
        '逝者姓名': bill.deceased_name || '',
        '账单年度': bill.bill_year || '',
        '起始日期': bill.start_date || '',
        '截止日期': bill.due_date || '',
        '应缴金额': bill.amount || 0,
        '记录类型': '成功生成',
        '跳过原因': '',
        '异常原因': ''
      });
    }

    for (const exc of exceptions) {
      const isSkip = exc.error_type === ERROR_TYPES.DUPLICATE_BILL;
      const isResolved = exc.resolved === 1;
      let recordType = '异常';
      if (isSkip) {
        recordType = '跳过';
      } else if (isResolved) {
        recordType = '已重试成功';
      }
      exportList.push({
        '序号': index++,
        '墓位编号': exc.plot_number || '',
        '区域': exc.area || '',
        '联系人姓名': '',
        '联系电话': '',
        '逝者姓名': '',
        '账单年度': batch.bill_year || '',
        '起始日期': '',
        '截止日期': '',
        '应缴金额': isResolved ? batch.fee_standard : 0,
        '记录类型': recordType,
        '跳过原因': isSkip ? exc.error_message : '',
        '异常原因': isSkip ? '' : exc.error_message,
        '重试次数': exc.retry_count || 0,
        '最后重试时间': exc.last_retried_at || '',
        '是否已解决': isResolved ? '是' : '否'
      });
    }

    success(res, {
      batch_info: {
        batch_no: batch.batch_no,
        bill_year: batch.bill_year,
        fee_standard: batch.fee_standard,
        total_count: batch.total_count,
        success_count: batch.success_count,
        skip_count: batch.skip_count,
        error_count: batch.error_count,
        status: batch.status,
        operator_name: batch.operator_name,
        remark: batch.remark,
        created_at: batch.created_at
      },
      export_list: exportList
    }, '批次明细导出成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
