const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery, runInTransaction } = require('../utils/dbHelper');
const { success, error, paginate, handleError } = require('../utils/response');
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
    handleError(res, err);
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
    handleError(res, err);
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
    handleError(res, err);
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
    handleError(res, err);
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
    handleError(res, err);
  }
});

router.post('/', authenticate, paymentCreateValidation, async (req, res) => {
  try {
    const { plot_id, contact_id, contract_id, fee_category, amount, payment_date, start_date, due_date, status, payment_method, remark, bill_type, bill_year } = req.body;
    
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
    
    let finalContractId = contract_id;
    let finalFeeCategory = fee_category || '管理费';
    
    if (!finalContractId) {
      const activeContract = await get(`
        SELECT id, status, contact_id as contract_contact_id, total_amount, paid_amount
        FROM contracts 
        WHERE plot_id = ? 
          AND status IN ('signed', 'effective')
          AND (contact_id IS NULL OR contact_id = COALESCE(?, contact_id))
        ORDER BY 
          CASE status WHEN 'effective' THEN 1 WHEN 'signed' THEN 2 ELSE 3 END,
          created_at DESC
        LIMIT 1
      `, [plot_id, contact_id]);
      
      if (activeContract) {
        finalContractId = activeContract.id;
        if (activeContract.contract_contact_id && !contact_id) {
          req.body.contact_id = activeContract.contract_contact_id;
        }
      }
    }

    let finalBillYear = bill_year;
    if (!finalBillYear) {
      if (start_date) {
        finalBillYear = moment(start_date).year();
      } else if (due_date) {
        finalBillYear = moment(due_date).year();
      }
    }
    
    if (finalBillYear && finalFeeCategory === '管理费') {
      const existingBill = await get(`
        SELECT id, bill_type FROM payments 
        WHERE plot_id = ? AND bill_year = ? AND fee_category = '管理费'
        LIMIT 1
      `, [plot_id, finalBillYear]);
      
      if (existingBill) {
        const typeDesc = existingBill.bill_type === 'manual' ? '手工录入' : '系统生成';
        return error(res, `${finalBillYear}年度已存在${typeDesc}的管理费缴费记录，请勿重复录入`, 400);
      }
    }

    const result = await runInTransaction(async () => {
      const paymentResult = await run(
        'INSERT INTO payments (plot_id, contact_id, contract_id, fee_category, amount, payment_date, start_date, due_date, status, payment_method, remark, bill_type, bill_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [plot_id, req.body.contact_id || contact_id, finalContractId, finalFeeCategory, amount, payment_date, start_date, due_date, status || '未缴', payment_method, remark, bill_type || 'manual', finalBillYear]
      );

      if (finalContractId && status === '已缴') {
        const contract = await get('SELECT id, status, total_amount, paid_amount FROM contracts WHERE id = ?', [finalContractId]);
        if (contract && contract.status !== 'voided') {
          const newPaidAmount = contract.paid_amount + amount;

          await run(`
            UPDATE contracts SET 
              paid_amount = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `, [newPaidAmount, finalContractId]);

          if (newPaidAmount >= contract.total_amount && contract.status === 'signed') {
            const effectiveAt = moment().format('YYYY-MM-DD HH:mm:ss');

            const contractDetail = await get(`
              SELECT c.*, p.status as plot_status
              FROM contracts c
              LEFT JOIN plots p ON c.plot_id = p.id
              WHERE c.id = ?
            `, [finalContractId]);

            if (contractDetail) {
              const occupyingDeceased = await get(`
                SELECT id, name FROM deceased WHERE plot_id = ? AND id != COALESCE(?, 0) LIMIT 1
              `, [contractDetail.plot_id, contractDetail.deceased_id]);

              if (!occupyingDeceased) {
                await run(`
                  UPDATE contracts SET 
                    status = 'effective', 
                    effective_at = ?,
                    updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?
                `, [effectiveAt, finalContractId]);

                if (contractDetail.deceased_id) {
                  await run('UPDATE deceased SET plot_id = ? WHERE id = ?', [contractDetail.plot_id, contractDetail.deceased_id]);
                }

                await run("UPDATE plots SET status = '已占用' WHERE id = ?", [contractDetail.plot_id]);
              }
            }
          }
        }
      }

      return paymentResult;
    });

    const summaryData = { 
      ...req.body, 
      contract_id: finalContractId, 
      fee_category: finalFeeCategory 
    };
    const summary = generateSummary(RESOURCE_TYPES.PAYMENT, ACTIONS.CREATE, summaryData);
    await logOperation(req, RESOURCE_TYPES.PAYMENT, result.id, ACTIONS.CREATE, summary);
    
    const message = finalContractId 
      ? `缴费记录创建成功${status === '已缴' ? '，已同步更新合同付款信息' : ''}`
      : '缴费记录创建成功';
    
    success(res, { id: result.id, contract_id: finalContractId, fee_category: finalFeeCategory }, message);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:id/pay', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_date, payment_method, amount, remark, fee_category } = req.body;
    
    const existing = await get('SELECT * FROM payments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '缴费记录不存在', 404);
    }
    
    if (existing.status === '已缴') {
      return error(res, '该缴费记录已完成缴费，无需重复操作', 400);
    }
    
    const payAmount = amount || existing.amount;
    const payDate = payment_date || moment().format('YYYY-MM-DD');
    const finalFeeCategory = fee_category || existing.fee_category || '管理费';
    
    await runInTransaction(async () => {
      await run(
        'UPDATE payments SET status = "已缴", payment_date = ?, payment_method = ?, amount = ?, fee_category = COALESCE(?, fee_category), remark = COALESCE(?, remark) WHERE id = ?',
        [payDate, payment_method, payAmount, finalFeeCategory, remark, id]
      );
      
      if (existing.contract_id) {
        const contract = await get('SELECT id, status, total_amount, paid_amount, plot_id, deceased_id FROM contracts WHERE id = ?', [existing.contract_id]);
        if (contract && contract.status !== 'voided') {
          const newPaidAmount = contract.paid_amount + payAmount;
          
          await run(`
            UPDATE contracts SET 
              paid_amount = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `, [newPaidAmount, contract.id]);
          
          if (newPaidAmount >= contract.total_amount && contract.status === 'signed') {
            const occupyingDeceased = await get(`
              SELECT id, name FROM deceased WHERE plot_id = ? AND id != COALESCE(?, 0) LIMIT 1
            `, [contract.plot_id, contract.deceased_id]);
            
            if (!occupyingDeceased) {
              const effectiveAt = moment().format('YYYY-MM-DD HH:mm:ss');
              
              await run(`
                UPDATE contracts SET 
                  status = 'effective', 
                  effective_at = ?,
                  updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `, [effectiveAt, contract.id]);
              
              if (contract.deceased_id) {
                await run('UPDATE deceased SET plot_id = ? WHERE id = ?', [contract.plot_id, contract.deceased_id]);
              }
              
              await run("UPDATE plots SET status = '已占用' WHERE id = ?", [contract.plot_id]);
            }
          }
        }
      }
    });

    const newData = { status: '已缴', payment_date: payDate, payment_method, amount: payAmount, fee_category: finalFeeCategory };
    const summary = generateSummary(RESOURCE_TYPES.PAYMENT, ACTIONS.STATUS_CHANGE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.PAYMENT, id, ACTIONS.STATUS_CHANGE, summary);
    
    let message = '缴费成功';
    if (existing.contract_id) {
      message += '，已同步更新合同付款信息';
    }
    
    success(res, null, message);
  } catch (err) {
    handleError(res, err);
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
    handleError(res, err);
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
    handleError(res, err);
  }
});

module.exports = router;
