const express = require('express');
const { paginateQuery, get, all } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate, authorize } = require('../middleware/auth');
const { operationLogQueryValidation, idParamValidation } = require('../middleware/validator');

const router = express.Router();

const resourceTypeNames = {
  plot: '墓位',
  deceased: '逝者',
  contact: '联系人',
  payment: '缴费',
  appointment: '预约',
  visit_record: '沟通记录'
};

const actionNames = {
  create: '新增',
  update: '修改',
  delete: '删除',
  status_change: '状态变更'
};

const formatLog = (log) => {
  if (!log) return log;
  return {
    ...log,
    resource_type_name: resourceTypeNames[log.resource_type] || log.resource_type,
    action_name: actionNames[log.action] || log.action
  };
};

router.get('/', authenticate, operationLogQueryValidation, async (req, res) => {
  try {
    const { 
      page = 1, 
      pageSize = 10, 
      resource_type = '', 
      user_id = '', 
      start_date = '', 
      end_date = '', 
      action = '',
      keyword = ''
    } = req.query;

    let baseSql = `
      SELECT o.*, u.name as user_name, u.username
      FROM operation_logs o 
      LEFT JOIN users u ON o.user_id = u.id 
      WHERE 1=1
    `;
    const params = [];

    if (resource_type) {
      baseSql += ' AND o.resource_type = ?';
      params.push(resource_type);
    }

    if (user_id) {
      baseSql += ' AND o.user_id = ?';
      params.push(user_id);
    }

    if (action) {
      baseSql += ' AND o.action = ?';
      params.push(action);
    }

    if (start_date) {
      baseSql += ' AND DATE(o.created_at) >= ?';
      params.push(start_date);
    }

    if (end_date) {
      baseSql += ' AND DATE(o.created_at) <= ?';
      params.push(end_date);
    }

    if (keyword) {
      baseSql += ' AND (o.summary LIKE ? OR u.name LIKE ? OR u.username LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const result = await paginateQuery(baseSql, params, page, pageSize, 'o.created_at DESC, o.id DESC');
    
    const formattedData = result.data.map(formatLog);
    
    paginate(res, formattedData, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/statistics', authenticate, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const start = start_date || defaultStart;
    const end = end_date || today;

    const totalStats = await get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN action = 'create' THEN 1 ELSE 0 END) as create_count,
        SUM(CASE WHEN action = 'update' THEN 1 ELSE 0 END) as update_count,
        SUM(CASE WHEN action = 'delete' THEN 1 ELSE 0 END) as delete_count,
        SUM(CASE WHEN action = 'status_change' THEN 1 ELSE 0 END) as status_change_count
      FROM operation_logs 
      WHERE DATE(created_at) BETWEEN ? AND ?
    `, [start, end]);

    const byResourceType = await all(`
      SELECT 
        resource_type,
        COUNT(*) as total,
        SUM(CASE WHEN action = 'create' THEN 1 ELSE 0 END) as create_count,
        SUM(CASE WHEN action = 'update' THEN 1 ELSE 0 END) as update_count,
        SUM(CASE WHEN action = 'delete' THEN 1 ELSE 0 END) as delete_count,
        SUM(CASE WHEN action = 'status_change' THEN 1 ELSE 0 END) as status_change_count
      FROM operation_logs 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY resource_type
      ORDER BY total DESC
    `, [start, end]);

    const byUser = await all(`
      SELECT 
        u.id,
        u.name,
        u.username,
        COUNT(*) as total
      FROM operation_logs o 
      LEFT JOIN users u ON o.user_id = u.id 
      WHERE DATE(o.created_at) BETWEEN ? AND ?
      GROUP BY u.id, u.name, u.username
      ORDER BY total DESC
      LIMIT 10
    `, [start, end]);

    const byDate = await all(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as total
      FROM operation_logs 
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30
    `, [start, end]);

    const formattedByResourceType = byResourceType.map(item => ({
      ...item,
      resource_type_name: resourceTypeNames[item.resource_type] || item.resource_type
    }));

    success(res, {
      period: { start, end },
      summary: totalStats,
      byResourceType: formattedByResourceType,
      byUser,
      byDate
    }, '操作日志统计查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/resource-types', authenticate, async (req, res) => {
  try {
    const types = Object.entries(resourceTypeNames).map(([value, label]) => ({
      value,
      label
    }));
    success(res, types);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/actions', authenticate, async (req, res) => {
  try {
    const actions = Object.entries(actionNames).map(([value, label]) => ({
      value,
      label
    }));
    success(res, actions);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const log = await get(`
      SELECT o.*, u.name as user_name, u.username
      FROM operation_logs o 
      LEFT JOIN users u ON o.user_id = u.id 
      WHERE o.id = ?
    `, [req.params.id]);

    if (!log) {
      return error(res, '日志不存在', 404);
    }

    success(res, formatLog(log));
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
