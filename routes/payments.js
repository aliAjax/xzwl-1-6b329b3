const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { paymentCreateValidation, idParamValidation } = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, plot_id = '', status = '', keyword = '' } = req.query;
    
    let baseSql = `
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
      WHERE 1=1
    `;
    const params = [];
    
    if (plot_id) {
      baseSql += ' AND py.plot_id = ?';
      params.push(plot_id);
    }
    
    if (status) {
      baseSql += ' AND py.status = ?';
      params.push(status);
    }
    
    if (keyword) {
      baseSql += ' AND (p.plot_number LIKE ? OR c.name LIKE ? OR d.name LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'py.due_date ASC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/reminders', authenticate, async (req, res) => {
  try {
    const { days = 30, page = 1, pageSize = 20 } = req.query;
    
    const today = moment().format('YYYY-MM-DD');
    const reminderDate = moment().add(parseInt(days), 'days').format('YYYY-MM-DD');
    
    let baseSql = `
      SELECT py.*, 
             p.plot_number,
             p.area,
             c.name as contact_name,
             c.phone as contact_phone,
             d.name as deceased_name,
             julianday(?) - julianday(py.due_date) as days_remaining
      FROM payments py 
      LEFT JOIN plots p ON py.plot_id = p.id 
      LEFT JOIN contacts c ON py.contact_id = c.id 
      LEFT JOIN deceased d ON p.id = d.plot_id 
      WHERE py.due_date <= ? 
        AND py.due_date >= ?
        AND py.status != '已缴'
    `;
    const params = [today, reminderDate, today];
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'py.due_date ASC');
    
    const dataWithDays = result.data.map(item => ({
      ...item,
      days_remaining: Math.ceil(item.days_remaining * -1),
      is_overdue: item.days_remaining > 0,
      urgency: item.days_remaining > 0 ? '已逾期' : 
               item.days_remaining >= -7 ? '即将到期' : '近期到期'
    }));
    
    const overdueCount = await get(`
      SELECT COUNT(*) as count 
      FROM payments 
      WHERE due_date < ? AND status != '已缴'
    `, [today]);
    
    const upcomingCount = await get(`
      SELECT COUNT(*) as count 
      FROM payments 
      WHERE due_date >= ? AND due_date <= ? AND status != '已缴'
    `, [today, reminderDate]);
    
    success(res, {
      list: dataWithDays,
      pagination: {
        total: result.total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        totalPages: Math.ceil(result.total / pageSize)
      },
      statistics: {
        overdue: overdueCount.count,
        upcoming: upcomingCount.count,
        total: overdueCount.count + upcomingCount.count
      }
    }, '到期提醒查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/overdue', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.query;
    
    const today = moment().format('YYYY-MM-DD');
    
    let baseSql = `
      SELECT py.*, 
             p.plot_number,
             p.area,
             c.name as contact_name,
             c.phone as contact_phone,
             d.name as deceased_name,
             julianday(?) - julianday(py.due_date) as days_overdue
      FROM payments py 
      LEFT JOIN plots p ON py.plot_id = p.id 
      LEFT JOIN contacts c ON py.contact_id = c.id 
      LEFT JOIN deceased d ON p.id = d.plot_id 
      WHERE py.due_date < ? 
        AND py.status != '已缴'
    `;
    const params = [today, today];
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'py.due_date ASC');
    
    const dataWithDays = result.data.map(item => ({
      ...item,
      days_overdue: Math.floor(item.days_overdue)
    }));
    
    const totalOverdue = await get(`
      SELECT SUM(amount) as total 
      FROM payments 
      WHERE due_date < ? AND status != '已缴'
    `, [today]);
    
    success(res, {
      list: dataWithDays,
      pagination: {
        total: result.total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        totalPages: Math.ceil(result.total / pageSize)
      },
      statistics: {
        count: result.total,
        totalAmount: totalOverdue.total || 0
      }
    }, '逾期费用查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/statistics', authenticate, async (req, res) => {
  try {
    const { year = moment().year() } = req.query;
    
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const today = moment().format('YYYY-MM-DD');
    
    const totalPaid = await get(`
      SELECT SUM(amount) as total, COUNT(*) as count 
      FROM payments 
      WHERE payment_date BETWEEN ? AND ? AND status = '已缴'
    `, [yearStart, yearEnd]);
    
    const totalUnpaid = await get(`
      SELECT SUM(amount) as total, COUNT(*) as count 
      FROM payments 
      WHERE status != '已缴'
    `);
    
    const overdue = await get(`
      SELECT SUM(amount) as total, COUNT(*) as count 
      FROM payments 
      WHERE due_date < ? AND status != '已缴'
    `, [today]);
    
    const monthlyStats = await all(`
      SELECT 
        strftime('%m', payment_date) as month,
        SUM(amount) as total,
        COUNT(*) as count
      FROM payments 
      WHERE payment_date BETWEEN ? AND ? AND status = '已缴'
      GROUP BY strftime('%m', payment_date)
      ORDER BY month
    `, [yearStart, yearEnd]);
    
    const monthlyData = Array(12).fill(0).map((_, i) => {
      const month = String(i + 1).padStart(2, '0');
      const found = monthlyStats.find(m => m.month === month);
      return {
        month: `${i + 1}月`,
        monthNum: month,
        total: found ? found.total : 0,
        count: found ? found.count : 0
      };
    });
    
    success(res, {
      year,
      summary: {
        totalPaid: totalPaid.total || 0,
        paidCount: totalPaid.count || 0,
        totalUnpaid: totalUnpaid.total || 0,
        unpaidCount: totalUnpaid.count || 0,
        overdueAmount: overdue.total || 0,
        overdueCount: overdue.count || 0
      },
      monthly: monthlyData
    }, '缴费统计查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const payment = await get(`
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
      WHERE py.id = ?
    `, [req.params.id]);
    
    if (!payment) {
      return error(res, '缴费记录不存在', 404);
    }
    
    success(res, payment);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, paymentCreateValidation, async (req, res) => {
  try {
    const { plot_id, contact_id, amount, payment_date, start_date, due_date, status, payment_method, remark, bill_type, bill_year } = req.body;
    
    const plot = await get('SELECT id FROM plots WHERE id = ?', [plot_id]);
    if (!plot) {
      return error(res, '墓位不存在', 400);
    }
    
    if (contact_id) {
      const contact = await get('SELECT id FROM contacts WHERE id = ?', [contact_id]);
      if (!contact) {
        return error(res, '联系人不存在', 400);
      }
    }
    
    const result = await run(
      'INSERT INTO payments (plot_id, contact_id, amount, payment_date, start_date, due_date, status, payment_method, remark, bill_type, bill_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [plot_id, contact_id, amount, payment_date, start_date, due_date, status || '未缴', payment_method, remark, bill_type || 'manual', bill_year]
    );

    const summary = generateSummary(RESOURCE_TYPES.PAYMENT, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.PAYMENT, result.id, ACTIONS.CREATE, summary);
    
    success(res, { id: result.id }, '缴费记录创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/pay', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_date, payment_method, amount, remark } = req.body;
    
    const existing = await get('SELECT * FROM payments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '缴费记录不存在', 404);
    }
    
    const payAmount = amount || existing.amount;
    const payDate = payment_date || moment().format('YYYY-MM-DD');
    
    await run(
      'UPDATE payments SET status = "已缴", payment_date = ?, payment_method = ?, amount = ?, remark = COALESCE(?, remark) WHERE id = ?',
      [payDate, payment_method, payAmount, remark, id]
    );

    const newData = { status: '已缴', payment_date: payDate, payment_method, amount: payAmount };
    const summary = generateSummary(RESOURCE_TYPES.PAYMENT, ACTIONS.STATUS_CHANGE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.PAYMENT, id, ACTIONS.STATUS_CHANGE, summary);
    
    success(res, null, '缴费成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { plot_id, contact_id, amount, payment_date, start_date, due_date, status, payment_method, remark, bill_type, bill_year } = req.body;
    
    const existing = await get('SELECT * FROM payments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '缴费记录不存在', 404);
    }
    
    if (plot_id) {
      const plot = await get('SELECT id FROM plots WHERE id = ?', [plot_id]);
      if (!plot) {
        return error(res, '墓位不存在', 400);
      }
    }
    
    await run(
      'UPDATE payments SET plot_id = ?, contact_id = ?, amount = ?, payment_date = ?, start_date = ?, due_date = ?, status = ?, payment_method = ?, remark = ?, bill_type = COALESCE(?, bill_type), bill_year = COALESCE(?, bill_year) WHERE id = ?',
      [plot_id, contact_id, amount, payment_date, start_date, due_date, status, payment_method, remark, bill_type, bill_year, id]
    );

    const newData = { plot_id, contact_id, amount, payment_date, start_date, due_date, status, payment_method, remark, bill_type, bill_year };
    let action = ACTIONS.UPDATE;
    let summary;

    if (existing.status !== status) {
      action = ACTIONS.STATUS_CHANGE;
      summary = generateSummary(RESOURCE_TYPES.PAYMENT, ACTIONS.STATUS_CHANGE, newData, existing);
    } else {
      summary = generateSummary(RESOURCE_TYPES.PAYMENT, ACTIONS.UPDATE, newData, existing);
    }
    await logOperation(req, RESOURCE_TYPES.PAYMENT, id, action, summary);
    
    success(res, null, '缴费记录更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT * FROM payments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '缴费记录不存在', 404);
    }
    
    await run('DELETE FROM payments WHERE id = ?', [id]);

    const summary = generateSummary(RESOURCE_TYPES.PAYMENT, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.PAYMENT, id, ACTIONS.DELETE, summary);
    
    success(res, null, '缴费记录删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
