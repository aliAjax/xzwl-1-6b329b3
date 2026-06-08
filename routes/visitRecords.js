const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { visitRecordCreateValidation, idParamValidation, staffFollowUpQueryValidation } = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, type = '', status = '', contact_id = '', user_id = '', keyword = '', start_date = '', end_date = '' } = req.query;
    
    let baseSql = `
      SELECT v.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             u.name as user_name
      FROM visit_records v 
      LEFT JOIN contacts c ON v.contact_id = c.id 
      LEFT JOIN users u ON v.user_id = u.id 
      WHERE 1=1
    `;
    const params = [];
    
    if (type) {
      baseSql += ' AND v.type = ?';
      params.push(type);
    }
    
    if (status) {
      baseSql += ' AND v.status = ?';
      params.push(status);
    }
    
    if (contact_id) {
      baseSql += ' AND v.contact_id = ?';
      params.push(contact_id);
    }
    
    if (user_id) {
      baseSql += ' AND v.user_id = ?';
      params.push(user_id);
    }
    
    if (start_date) {
      baseSql += ' AND v.visit_date >= ?';
      params.push(start_date);
    }
    
    if (end_date) {
      baseSql += ' AND v.visit_date <= ?';
      params.push(end_date);
    }
    
    if (keyword) {
      baseSql += ' AND (c.name LIKE ? OR c.phone LIKE ? OR v.content LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'v.visit_date DESC, v.created_at DESC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/followup', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, days = 7 } = req.query;
    
    const today = moment().format('YYYY-MM-DD');
    const endDate = moment().add(parseInt(days), 'days').format('YYYY-MM-DD');
    
    let baseSql = `
      SELECT v.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             u.name as user_name
      FROM visit_records v 
      LEFT JOIN contacts c ON v.contact_id = c.id 
      LEFT JOIN users u ON v.user_id = u.id 
      WHERE v.status = '待跟进'
        AND v.follow_up_date >= ?
        AND v.follow_up_date <= ?
    `;
    const params = [today, endDate];
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'v.follow_up_date ASC');
    
    const overdue = await all(`
      SELECT v.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             u.name as user_name
      FROM visit_records v 
      LEFT JOIN contacts c ON v.contact_id = c.id 
      LEFT JOIN users u ON v.user_id = u.id 
      WHERE v.status = '待跟进'
        AND v.follow_up_date < ?
      ORDER BY v.follow_up_date ASC
      LIMIT 10
    `, [today]);
    
    success(res, {
      list: result.data,
      overdue,
      pagination: {
        total: result.total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        totalPages: Math.ceil(result.total / pageSize)
      },
      statistics: {
        upcoming: result.total,
        overdue: overdue.length
      }
    }, '待跟进记录查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/followup/staff', authenticate, staffFollowUpQueryValidation, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, staff_id } = req.query;
    const currentUserId = req.user.id;
    const currentUserRole = req.user.role;

    let targetUserId = currentUserId;
    if (staff_id) {
      if (currentUserRole === 'admin') {
        targetUserId = parseInt(staff_id);
        const staff = await get('SELECT id, name FROM users WHERE id = ? AND status = "active"', [targetUserId]);
        if (!staff) {
          return error(res, '员工不存在或已停用', 404);
        }
      } else if (parseInt(staff_id) !== currentUserId) {
        return error(res, '权限不足，只能查看自己的跟进任务', 403);
      }
    }

    const today = moment().format('YYYY-MM-DD');
    const sevenDaysLater = moment().add(7, 'days').format('YYYY-MM-DD');

    const baseSql = `
      SELECT v.id,
             v.contact_id,
             v.follow_up_date,
             v.content,
             v.status,
             c.name as contact_name,
             c.phone as contact_phone,
             julianday(?) - julianday(v.follow_up_date) as days_overdue_raw,
             CASE 
               WHEN v.follow_up_date < ? THEN 1
               ELSE 0
             END as is_overdue
      FROM visit_records v
      LEFT JOIN contacts c ON v.contact_id = c.id
      WHERE v.status = '待跟进'
        AND v.user_id = ?
        AND (v.follow_up_date <= ? OR v.follow_up_date < ?)
    `;
    const params = [today, today, targetUserId, sevenDaysLater, today];

    const countSql = `
      SELECT COUNT(*) as total
      FROM visit_records v
      WHERE v.status = '待跟进'
        AND v.user_id = ?
        AND (v.follow_up_date <= ? OR v.follow_up_date < ?)
    `;
    const countParams = [targetUserId, sevenDaysLater, today];

    const countResult = await get(countSql, countParams);
    const total = countResult.total;

    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    const dataSql = baseSql + ' ORDER BY is_overdue DESC, v.follow_up_date ASC LIMIT ? OFFSET ?';
    const dataParams = [...params, parseInt(pageSize), offset];

    const records = await all(dataSql, dataParams);

    const formattedRecords = records.map(record => {
      const daysOverdue = record.days_overdue_raw;
      let displayDays = 0;
      if (record.is_overdue === 1) {
        displayDays = Math.floor(daysOverdue);
      } else {
        displayDays = Math.ceil(-daysOverdue);
      }

      let summary = record.content || '';
      if (summary.length > 50) {
        summary = summary.substring(0, 50) + '...';
      }

      return {
        id: record.id,
        contact_name: record.contact_name,
        contact_phone: record.contact_phone,
        follow_up_date: record.follow_up_date,
        is_overdue: record.is_overdue === 1,
        days_overdue: record.is_overdue === 1 ? displayDays : 0,
        days_remaining: record.is_overdue === 0 ? displayDays : 0,
        summary: summary
      };
    });

    const upcomingCountSql = `
      SELECT COUNT(*) as count
      FROM visit_records
      WHERE status = '待跟进'
        AND user_id = ?
        AND follow_up_date >= ?
        AND follow_up_date <= ?
    `;
    const upcomingResult = await get(upcomingCountSql, [targetUserId, today, sevenDaysLater]);

    const overdueCountSql = `
      SELECT COUNT(*) as count
      FROM visit_records
      WHERE status = '待跟进'
        AND user_id = ?
        AND follow_up_date < ?
    `;
    const overdueResult = await get(overdueCountSql, [targetUserId, today]);

    success(res, {
      list: formattedRecords,
      pagination: {
        total: total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        totalPages: Math.ceil(total / pageSize)
      },
      statistics: {
        upcoming_7_days: upcomingResult.count || 0,
        overdue: overdueResult.count || 0
      }
    }, '员工跟进任务查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/my', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status = '' } = req.query;
    const userId = req.user.id;
    
    let baseSql = `
      SELECT v.*, 
             c.name as contact_name,
             c.phone as contact_phone
      FROM visit_records v 
      LEFT JOIN contacts c ON v.contact_id = c.id 
      WHERE v.user_id = ?
    `;
    const params = [userId];
    
    if (status) {
      baseSql += ' AND v.status = ?';
      params.push(status);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'v.visit_date DESC, v.created_at DESC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/statistics', authenticate, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const today = moment().format('YYYY-MM-DD');
    const defaultStart = moment().subtract(30, 'days').format('YYYY-MM-DD');
    
    const start = start_date || defaultStart;
    const end = end_date || today;
    
    const totalStats = await get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN type = '来访' THEN 1 ELSE 0 END) as visit_count,
        SUM(CASE WHEN type = '电话' THEN 1 ELSE 0 END) as call_count,
        SUM(CASE WHEN status = '待跟进' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END) as completed
      FROM visit_records 
      WHERE visit_date BETWEEN ? AND ?
    `, [start, end]);
    
    const byUser = await all(`
      SELECT 
        u.id,
        u.name,
        COUNT(*) as total,
        SUM(CASE WHEN v.type = '来访' THEN 1 ELSE 0 END) as visit_count,
        SUM(CASE WHEN v.type = '电话' THEN 1 ELSE 0 END) as call_count
      FROM visit_records v 
      LEFT JOIN users u ON v.user_id = u.id 
      WHERE v.visit_date BETWEEN ? AND ?
      GROUP BY u.id, u.name
      ORDER BY total DESC
    `, [start, end]);
    
    const byDate = await all(`
      SELECT 
        visit_date as date,
        COUNT(*) as total,
        SUM(CASE WHEN type = '来访' THEN 1 ELSE 0 END) as visit_count,
        SUM(CASE WHEN type = '电话' THEN 1 ELSE 0 END) as call_count
      FROM visit_records 
      WHERE visit_date BETWEEN ? AND ?
      GROUP BY visit_date
      ORDER BY date DESC
      LIMIT 30
    `, [start, end]);
    
    success(res, {
      period: { start, end },
      summary: totalStats,
      byUser,
      byDate
    }, '沟通记录统计查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const record = await get(`
      SELECT v.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             c.address as contact_address,
             u.name as user_name
      FROM visit_records v 
      LEFT JOIN contacts c ON v.contact_id = c.id 
      LEFT JOIN users u ON v.user_id = u.id 
      WHERE v.id = ?
    `, [req.params.id]);
    
    if (!record) {
      return error(res, '记录不存在', 404);
    }
    
    const history = await all(`
      SELECT v.*, u.name as user_name 
      FROM visit_records v 
      LEFT JOIN users u ON v.user_id = u.id 
      WHERE v.contact_id = ? AND v.id != ?
      ORDER BY v.visit_date DESC 
      LIMIT 10
    `, [record.contact_id, req.params.id]);
    
    success(res, { ...record, history });
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, visitRecordCreateValidation, async (req, res) => {
  try {
    const { contact_id, type, visit_date, content, follow_up_date, status, remark } = req.body;
    const userId = req.user.id;
    
    if (contact_id) {
      const contact = await get('SELECT id FROM contacts WHERE id = ?', [contact_id]);
      if (!contact) {
        return error(res, '联系人不存在', 400);
      }
    }
    
    const result = await run(
      'INSERT INTO visit_records (contact_id, user_id, type, visit_date, content, follow_up_date, status, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [contact_id, userId, type, visit_date, content, follow_up_date, status || '待跟进', remark]
    );

    const summary = generateSummary(RESOURCE_TYPES.VISIT_RECORD, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.VISIT_RECORD, result.id, ACTIONS.CREATE, summary);
    
    success(res, { id: result.id }, '记录创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/complete', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { follow_up_remark } = req.body;
    
    const existing = await get('SELECT * FROM visit_records WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '记录不存在', 404);
    }
    
    const remark = follow_up_remark ? `${existing.remark || ''} 跟进结果: ${follow_up_remark}`.trim() : existing.remark;
    
    await run('UPDATE visit_records SET status = "已完成", remark = ? WHERE id = ?', [remark, id]);

    const newData = { status: '已完成', remark };
    const summary = generateSummary(RESOURCE_TYPES.VISIT_RECORD, ACTIONS.STATUS_CHANGE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.VISIT_RECORD, id, ACTIONS.STATUS_CHANGE, summary);

    success(res, null, '跟进已完成');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { contact_id, type, visit_date, content, follow_up_date, status, remark } = req.body;
    
    const existing = await get('SELECT * FROM visit_records WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '记录不存在', 404);
    }
    
    if (contact_id) {
      const contact = await get('SELECT id FROM contacts WHERE id = ?', [contact_id]);
      if (!contact) {
        return error(res, '联系人不存在', 400);
      }
    }
    
    await run(
      'UPDATE visit_records SET contact_id = ?, type = ?, visit_date = ?, content = ?, follow_up_date = ?, status = ?, remark = ? WHERE id = ?',
      [contact_id, type, visit_date, content, follow_up_date, status, remark, id]
    );

    const newData = { contact_id, type, visit_date, content, follow_up_date, status, remark };
    let action = ACTIONS.UPDATE;
    let summary;

    if (existing.status !== status) {
      action = ACTIONS.STATUS_CHANGE;
      summary = generateSummary(RESOURCE_TYPES.VISIT_RECORD, ACTIONS.STATUS_CHANGE, newData, existing);
    } else {
      summary = generateSummary(RESOURCE_TYPES.VISIT_RECORD, ACTIONS.UPDATE, newData, existing);
    }
    await logOperation(req, RESOURCE_TYPES.VISIT_RECORD, id, action, summary);
    
    success(res, null, '记录更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT * FROM visit_records WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '记录不存在', 404);
    }
    
    await run('DELETE FROM visit_records WHERE id = ?', [id]);

    const summary = generateSummary(RESOURCE_TYPES.VISIT_RECORD, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.VISIT_RECORD, id, ACTIONS.DELETE, summary);
    
    success(res, null, '记录删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
