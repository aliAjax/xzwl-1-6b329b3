const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { reminderGenerateValidation, reminderBatchQueryValidation, reminderDetailQueryValidation, reminderDetailStatusValidation, idParamValidation } = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');

const router = express.Router();

const EXCEPTION_TYPES = {
  NO_CONTACT: 'no_contact',
  INVALID_PHONE: 'invalid_phone',
  DUPLICATE_REMINDER: 'duplicate_reminder',
  OTHER: 'other'
};

const REMINDER_SKIP_DAYS = 30;

const generateBatchNo = () => {
  const now = moment();
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `REM-${now.format('YYYYMMDD')}-${random}`;
};

const isValidPhone = (phone) => {
  if (!phone) return false;
  const phoneRegex = /^1[3-9]\d{9}$/;
  return phoneRegex.test(phone);
};

const getEligiblePayments = async (reminderDays, area, plotIds) => {
  const today = moment().format('YYYY-MM-DD');
  const endDate = moment().add(parseInt(reminderDays), 'days').format('YYYY-MM-DD');

  let sql = `
    SELECT py.*,
           p.plot_number,
           p.area,
           c.id as contact_id,
           c.name as contact_name,
           c.phone as contact_phone,
           d.name as deceased_name,
           julianday(?) - julianday(py.due_date) as days_remaining
    FROM payments py
    LEFT JOIN plots p ON py.plot_id = p.id
    LEFT JOIN contacts c ON py.contact_id = c.id
    LEFT JOIN deceased d ON p.id = d.plot_id
    WHERE py.status != '已缴'
      AND py.due_date <= ?
  `;
  const params = [today, endDate];

  if (area) {
    sql += ' AND p.area = ?';
    params.push(area);
  }

  if (plotIds && plotIds.length > 0) {
    const placeholders = plotIds.map(() => '?').join(',');
    sql += ` AND p.id IN (${placeholders})`;
    params.push(...plotIds);
  }

  sql += ' ORDER BY py.due_date ASC';

  return await all(sql, params);
};

const checkDuplicateReminder = async (paymentId) => {
  const skipDate = moment().subtract(REMINDER_SKIP_DAYS, 'days').format('YYYY-MM-DD');
  const existing = await get(`
    SELECT id FROM reminder_details
    WHERE payment_id = ?
      AND is_exception = 0
      AND status = 'sent'
      AND created_at >= ?
    LIMIT 1
  `, [paymentId, skipDate]);
  return existing ? true : false;
};

const processPaymentForReminder = async (payment) => {
  const result = {
    payment_id: payment.id,
    plot_id: payment.plot_id,
    plot_number: payment.plot_number,
    area: payment.area,
    contact_id: payment.contact_id,
    contact_name: payment.contact_name,
    contact_phone: payment.contact_phone,
    deceased_name: payment.deceased_name,
    due_date: payment.due_date,
    amount: payment.amount,
    days_remaining: Math.ceil(payment.days_remaining * -1),
    is_overdue: payment.days_remaining > 0 ? 1 : 0,
    urgency: payment.days_remaining > 0 ? '已逾期' :
             payment.days_remaining >= -7 ? '即将到期' : '近期到期',
    is_exception: 0,
    exception_type: null,
    exception_message: null
  };

  if (!payment.contact_id) {
    result.is_exception = 1;
    result.exception_type = EXCEPTION_TYPES.NO_CONTACT;
    result.exception_message = '墓位未关联联系人，无法发送提醒';
    return result;
  }

  if (!isValidPhone(payment.contact_phone)) {
    result.is_exception = 1;
    result.exception_type = EXCEPTION_TYPES.INVALID_PHONE;
    result.exception_message = `手机号格式异常: ${payment.contact_phone || '空'}`;
    return result;
  }

  const isDuplicate = await checkDuplicateReminder(payment.id);
  if (isDuplicate) {
    result.is_exception = 1;
    result.exception_type = EXCEPTION_TYPES.DUPLICATE_REMINDER;
    result.exception_message = `该缴费记录${REMINDER_SKIP_DAYS}天内已生成过提醒，跳过重复生成`;
    return result;
  }

  return result;
};

router.post('/generate', authenticate, reminderGenerateValidation, async (req, res) => {
  try {
    const { reminder_days = 30, area, plot_ids, remark } = req.body;

    const payments = await getEligiblePayments(reminder_days, area, plot_ids);

    if (payments.length === 0) {
      return error(res, '没有符合条件的待提醒缴费记录', 400);
    }

    const batchNo = generateBatchNo();
    const today = moment().format('YYYY-MM-DD');
    const endDate = moment().add(parseInt(reminder_days), 'days').format('YYYY-MM-DD');

    const batchResult = await run(
      `INSERT INTO reminder_batches (batch_no, reminder_days, start_date, end_date, total_count, status, operator_id, operator_name, remark)
       VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?)`,
      [batchNo, reminder_days, today, endDate, payments.length, req.user.id, req.user.name, remark]
    );

    const batchId = batchResult.id;

    let successCount = 0;
    let skipCount = 0;
    let exceptionCount = 0;

    for (const payment of payments) {
      try {
        const result = await processPaymentForReminder(payment);

        if (result.exception_type === EXCEPTION_TYPES.DUPLICATE_REMINDER) {
          skipCount++;
        } else if (result.is_exception) {
          exceptionCount++;
        } else {
          successCount++;
        }

        await run(
          `INSERT INTO reminder_details (
            batch_id, payment_id, plot_id, plot_number, area,
            contact_id, contact_name, contact_phone, deceased_name,
            due_date, amount, days_remaining, is_overdue, urgency,
            status, is_exception, exception_type, exception_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [
            batchId,
            result.payment_id,
            result.plot_id,
            result.plot_number,
            result.area,
            result.contact_id,
            result.contact_name,
            result.contact_phone,
            result.deceased_name,
            result.due_date,
            result.amount,
            result.days_remaining,
            result.is_overdue,
            result.urgency,
            result.is_exception,
            result.exception_type,
            result.exception_message
          ]
        );
      } catch (err) {
        exceptionCount++;
        await run(
          `INSERT INTO reminder_details (
            batch_id, payment_id, plot_id, plot_number, area,
            contact_id, contact_name, contact_phone, deceased_name,
            due_date, amount, days_remaining, is_overdue, urgency,
            status, is_exception, exception_type, exception_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
          [
            batchId,
            payment.id,
            payment.plot_id,
            payment.plot_number,
            payment.area,
            payment.contact_id,
            payment.contact_name,
            payment.contact_phone,
            payment.deceased_name,
            payment.due_date,
            payment.amount,
            Math.ceil(payment.days_remaining * -1),
            payment.days_remaining > 0 ? 1 : 0,
            payment.days_remaining > 0 ? '已逾期' : '近期到期',
            EXCEPTION_TYPES.OTHER,
            `处理失败: ${err.message}`
          ]
        );
      }
    }

    await run(
      'UPDATE reminder_batches SET success_count = ?, skip_count = ?, exception_count = ?, status = ? WHERE id = ?',
      [successCount, skipCount, exceptionCount, 'completed', batchId]
    );

    const batchSummary = {
      batch_no: batchNo,
      reminder_days,
      start_date: today,
      end_date: endDate,
      total_count: payments.length,
      success_count: successCount,
      skip_count: skipCount,
      exception_count: exceptionCount
    };
    const summary = generateSummary(RESOURCE_TYPES.REMINDER_BATCH, ACTIONS.CREATE, batchSummary);
    await logOperation(req, RESOURCE_TYPES.REMINDER_BATCH, batchId, ACTIONS.CREATE, summary);

    success(res, {
      batch_id: batchId,
      batch_no: batchNo,
      reminder_days,
      start_date: today,
      end_date: endDate,
      total_count: payments.length,
      success_count: successCount,
      skip_count: skipCount,
      exception_count: exceptionCount
    }, '提醒批次生成完成');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/batches', authenticate, reminderBatchQueryValidation, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, start_date = '', end_date = '', status = '' } = req.query;

    let baseSql = `SELECT * FROM reminder_batches WHERE 1=1`;
    const params = [];

    if (start_date) {
      baseSql += ' AND DATE(created_at) >= ?';
      params.push(start_date);
    }

    if (end_date) {
      baseSql += ' AND DATE(created_at) <= ?';
      params.push(end_date);
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

    const batch = await get('SELECT * FROM reminder_batches WHERE id = ?', [id]);
    if (!batch) {
      return error(res, '批次不存在', 404);
    }

    const normalDetails = await all(`
      SELECT * FROM reminder_details
      WHERE batch_id = ? AND is_exception = 0
      ORDER BY due_date ASC
    `, [id]);

    const exceptionDetails = await all(`
      SELECT * FROM reminder_details
      WHERE batch_id = ? AND is_exception = 1
      ORDER BY id ASC
    `, [id]);

    const exceptionStats = await all(`
      SELECT exception_type, COUNT(*) as count
      FROM reminder_details
      WHERE batch_id = ? AND is_exception = 1
      GROUP BY exception_type
    `, [id]);

    const statusStats = await all(`
      SELECT status, COUNT(*) as count
      FROM reminder_details
      WHERE batch_id = ?
      GROUP BY status
    `, [id]);

    const statusSummary = {
      pending: 0,
      sent: 0,
      failed: 0,
      ignored: 0
    };
    statusStats.forEach(stat => {
      if (statusSummary.hasOwnProperty(stat.status)) {
        statusSummary[stat.status] = stat.count;
      }
    });

    success(res, {
      batch,
      normal_details: normalDetails,
      exception_details: exceptionDetails,
      exception_statistics: exceptionStats,
      status_summary: statusSummary
    }, '批次详情查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/exceptions', authenticate, reminderDetailQueryValidation, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, contact_name = '', contact_phone = '', plot_number = '' } = req.query;

    let baseSql = `
      SELECT rd.*, rb.batch_no, rb.created_at as batch_created_at
      FROM reminder_details rd
      LEFT JOIN reminder_batches rb ON rd.batch_id = rb.id
      WHERE rd.is_exception = 1
    `;
    const params = [];

    if (contact_name) {
      baseSql += ' AND rd.contact_name LIKE ?';
      params.push(`%${contact_name}%`);
    }

    if (contact_phone) {
      baseSql += ' AND rd.contact_phone LIKE ?';
      params.push(`%${contact_phone}%`);
    }

    if (plot_number) {
      baseSql += ' AND rd.plot_number LIKE ?';
      params.push(`%${plot_number}%`);
    }

    const result = await paginateQuery(baseSql, params, page, pageSize, 'rd.created_at DESC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/details', authenticate, reminderDetailQueryValidation, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, contact_name = '', contact_phone = '', plot_number = '', is_exception = '' } = req.query;

    let baseSql = `
      SELECT rd.*, rb.batch_no, rb.created_at as batch_created_at
      FROM reminder_details rd
      LEFT JOIN reminder_batches rb ON rd.batch_id = rb.id
      WHERE 1=1
    `;
    const params = [];

    if (contact_name) {
      baseSql += ' AND rd.contact_name LIKE ?';
      params.push(`%${contact_name}%`);
    }

    if (contact_phone) {
      baseSql += ' AND rd.contact_phone LIKE ?';
      params.push(`%${contact_phone}%`);
    }

    if (plot_number) {
      baseSql += ' AND rd.plot_number LIKE ?';
      params.push(`%${plot_number}%`);
    }

    if (is_exception !== '') {
      baseSql += ' AND rd.is_exception = ?';
      params.push(parseInt(is_exception));
    }

    const result = await paginateQuery(baseSql, params, page, pageSize, 'rd.created_at DESC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.patch('/details/:id/status', authenticate, idParamValidation, reminderDetailStatusValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, failure_reason } = req.body;

    const detail = await get('SELECT * FROM reminder_details WHERE id = ?', [id]);
    if (!detail) {
      return error(res, '提醒明细不存在', 404);
    }

    if (detail.status !== 'pending') {
      return error(res, `仅 pending 状态的记录可更新，当前状态为 ${detail.status}`, 400);
    }

    const now = moment().format('YYYY-MM-DD HH:mm:ss');

    await run(
      `UPDATE reminder_details SET 
        status = ?, 
        sent_at = ?, 
        operator_id = ?, 
        operator_name = ?, 
        failure_reason = ?
      WHERE id = ?`,
      [
        status,
        now,
        req.user.id,
        req.user.name,
        status === 'failed' ? failure_reason : null,
        id
      ]
    );

    const updatedDetail = await get('SELECT * FROM reminder_details WHERE id = ?', [id]);

    const summary = generateSummary(RESOURCE_TYPES.REMINDER_DETAIL, ACTIONS.STATUS_CHANGE, {
      id,
      from_status: 'pending',
      to_status: status,
      plot_number: detail.plot_number,
      contact_name: detail.contact_name,
      failure_reason: status === 'failed' ? failure_reason : null
    });
    await logOperation(req, RESOURCE_TYPES.REMINDER_DETAIL, id, ACTIONS.STATUS_CHANGE, summary);

    success(res, updatedDetail, '提醒状态更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/statistics', authenticate, async (req, res) => {
  try {
    const today = moment().format('YYYY-MM-DD');
    const last30Days = moment().subtract(30, 'days').format('YYYY-MM-DD');

    const totalReminders = await get(`
      SELECT COUNT(*) as count FROM reminder_details
      WHERE created_at >= ?
    `, [last30Days]);

    const exceptionCount = await get(`
      SELECT COUNT(*) as count FROM reminder_details
      WHERE is_exception = 1 AND created_at >= ?
    `, [last30Days]);

    const exceptionByType = await all(`
      SELECT exception_type, COUNT(*) as count
      FROM reminder_details
      WHERE is_exception = 1 AND created_at >= ?
      GROUP BY exception_type
    `, [last30Days]);

    const batchStats = await get(`
      SELECT 
        COUNT(*) as total_batches,
        SUM(total_count) as total_records,
        SUM(success_count) as total_success,
        SUM(skip_count) as total_skip,
        SUM(exception_count) as total_exceptions
      FROM reminder_batches
      WHERE created_at >= ?
    `, [last30Days]);

    const urgencyStats = await all(`
      SELECT urgency, COUNT(*) as count
      FROM reminder_details
      WHERE is_exception = 0 AND created_at >= ?
      GROUP BY urgency
    `, [last30Days]);

    success(res, {
      period: '最近30天',
      summary: {
        total_batches: batchStats.total_batches || 0,
        total_reminders: totalReminders.count || 0,
        success_count: batchStats.total_success || 0,
        skip_count: batchStats.total_skip || 0,
        exception_count: exceptionCount.count || 0
      },
      exception_by_type: exceptionByType,
      urgency_distribution: urgencyStats
    }, '提醒统计查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
