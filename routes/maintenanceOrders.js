const express = require('express');
const { run, get, all, paginateQuery, runInTransaction } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const {
  maintenanceOrderCreateValidation,
  maintenanceOrderQueryValidation,
  maintenanceOrderStartValidation,
  maintenanceOrderCompleteValidation,
  maintenanceOrderCancelValidation,
  idParamValidation
} = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');

const router = express.Router();

const STATUS_FLOW = {
  '待处理': ['处理中', '已取消'],
  '处理中': ['已完成', '已取消'],
  '已完成': [],
  '已取消': []
};

const canTransition = (currentStatus, targetStatus) => {
  return STATUS_FLOW[currentStatus]?.includes(targetStatus) || false;
};

const getPlotStatusAfterMaintenance = async (plotId) => {
  const deceased = await get('SELECT id FROM deceased WHERE plot_id = ? LIMIT 1', [plotId]);
  return deceased ? '已占用' : '空闲';
};

const checkActiveMaintenance = async (plotId) => {
  const active = await get(
    "SELECT id FROM maintenance_orders WHERE plot_id = ? AND status IN ('待处理', '处理中') LIMIT 1",
    [plotId]
  );
  return !!active;
};

router.get('/', authenticate, maintenanceOrderQueryValidation, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status, plot_id, handler_id, start_date, end_date, keyword } = req.query;
    
    let baseSql = `
      SELECT mo.*,
             p.area,
             p.row,
             p.col,
             d.name as deceased_name
      FROM maintenance_orders mo
      LEFT JOIN plots p ON mo.plot_id = p.id
      LEFT JOIN deceased d ON p.id = d.plot_id
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      baseSql += ' AND mo.status = ?';
      params.push(status);
    }
    
    if (plot_id) {
      baseSql += ' AND mo.plot_id = ?';
      params.push(plot_id);
    }
    
    if (handler_id) {
      baseSql += ' AND mo.handler_id = ?';
      params.push(handler_id);
    }
    
    if (start_date) {
      baseSql += ' AND DATE(mo.created_at) >= ?';
      params.push(start_date);
    }
    
    if (end_date) {
      baseSql += ' AND DATE(mo.created_at) <= ?';
      params.push(end_date);
    }
    
    if (keyword) {
      baseSql += ' AND (mo.plot_number LIKE ? OR mo.reason LIKE ? OR d.name LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'mo.created_at DESC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/statistics', authenticate, async (req, res) => {
  try {
    const stats = await get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = '待处理' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = '处理中' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = '已取消' THEN 1 ELSE 0 END) as cancelled
      FROM maintenance_orders
    `);
    
    const monthlyStats = await all(`
      SELECT 
        strftime('%Y-%m', created_at) as month,
        COUNT(*) as count,
        SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END) as completed
      FROM maintenance_orders
      WHERE created_at >= date('now', '-6 months')
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY month DESC
    `);
    
    const reasonStats = await all(`
      SELECT 
        reason,
        COUNT(*) as count
      FROM maintenance_orders
      GROUP BY reason
      ORDER BY count DESC
      LIMIT 10
    `);
    
    success(res, {
      overall: {
        total: stats.total,
        pending: stats.pending,
        processing: stats.processing,
        completed: stats.completed,
        cancelled: stats.cancelled,
        completionRate: stats.total > 0 ? ((stats.completed / stats.total) * 100).toFixed(1) + '%' : '0%'
      },
      monthly: monthlyStats,
      byReason: reasonStats
    }, '统计信息查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const order = await get(`
      SELECT mo.*,
             p.area,
             p.row,
             p.col,
             p.status as plot_status,
             d.id as deceased_id,
             d.name as deceased_name,
             d.gender as deceased_gender,
             u.name as handler_name_full
      FROM maintenance_orders mo
      LEFT JOIN plots p ON mo.plot_id = p.id
      LEFT JOIN deceased d ON p.id = d.plot_id
      LEFT JOIN users u ON mo.handler_id = u.id
      WHERE mo.id = ?
    `, [req.params.id]);
    
    if (!order) {
      return error(res, '维修工单不存在', 404);
    }
    
    const logs = await all(`
      SELECT * FROM operation_logs 
      WHERE resource_type = ? AND resource_id = ? 
      ORDER BY created_at DESC
    `, [RESOURCE_TYPES.MAINTENANCE_ORDER, req.params.id]);
    
    success(res, { ...order, operation_logs: logs });
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, maintenanceOrderCreateValidation, async (req, res) => {
  try {
    const { plot_id, reason, plan_date, handler_id, remark } = req.body;
    
    const plot = await get('SELECT id, plot_number, status FROM plots WHERE id = ?', [plot_id]);
    if (!plot) {
      return error(res, '墓位不存在', 404);
    }
    
    const hasActive = await checkActiveMaintenance(plot_id);
    if (hasActive) {
      return error(res, '该墓位已有进行中的维修工单，请先完成或取消', 400);
    }
    
    let handlerName = null;
    if (handler_id) {
      const handler = await get('SELECT name FROM users WHERE id = ?', [handler_id]);
      if (!handler) {
        return error(res, '处理人不存在', 404);
      }
      handlerName = handler.name;
    }
    
    const orderId = await runInTransaction(async () => {
      const result = await run(
        `INSERT INTO maintenance_orders 
         (plot_id, plot_number, reason, plan_date, handler_id, handler_name, created_by, created_by_name, remark) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [plot_id, plot.plot_number, reason, plan_date, handler_id, handlerName, req.user.id, req.user.name, remark]
      );
      
      await run('UPDATE plots SET status = ? WHERE id = ?', ['维修中', plot_id]);
      
      return result.id;
    });
    
    const orderData = { id: orderId, plot_id, plot_number: plot.plot_number, reason, status: '待处理' };
    const summary = generateSummary(RESOURCE_TYPES.MAINTENANCE_ORDER, ACTIONS.CREATE, orderData);
    await logOperation(req, RESOURCE_TYPES.MAINTENANCE_ORDER, orderId, ACTIONS.CREATE, summary);
    
    const plotSummary = generateSummary(RESOURCE_TYPES.PLOT, ACTIONS.STATUS_CHANGE, 
      { status: '维修中' }, { status: plot.status });
    await logOperation(req, RESOURCE_TYPES.PLOT, plot_id, ACTIONS.STATUS_CHANGE, plotSummary);
    
    success(res, { id: orderId }, '维修工单创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/start', authenticate, idParamValidation, maintenanceOrderStartValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { handler_id } = req.body;
    
    const order = await get('SELECT * FROM maintenance_orders WHERE id = ?', [id]);
    if (!order) {
      return error(res, '维修工单不存在', 404);
    }
    
    if (!canTransition(order.status, '处理中')) {
      return error(res, `当前状态"${order.status}"不能开始处理`, 400);
    }
    
    let handlerId = handler_id || order.handler_id || req.user.id;
    let handlerName = order.handler_name;
    
    if (handler_id && handler_id !== order.handler_id) {
      const handler = await get('SELECT name FROM users WHERE id = ?', [handler_id]);
      if (!handler) {
        return error(res, '处理人不存在', 404);
      }
      handlerName = handler.name;
    } else if (!handlerId) {
      handlerId = req.user.id;
      handlerName = req.user.name;
    }
    
    const now = new Date().toISOString();
    const oldData = { ...order };
    
    await run(
      'UPDATE maintenance_orders SET status = ?, handler_id = ?, handler_name = ?, started_at = ? WHERE id = ?',
      ['处理中', handlerId, handlerName, now, id]
    );
    
    const newData = { status: '处理中', handler_id: handlerId, handler_name: handlerName };
    const summary = generateSummary(RESOURCE_TYPES.MAINTENANCE_ORDER, ACTIONS.STATUS_CHANGE, newData, oldData);
    await logOperation(req, RESOURCE_TYPES.MAINTENANCE_ORDER, id, ACTIONS.STATUS_CHANGE, summary);
    
    success(res, null, '开始处理成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/complete', authenticate, idParamValidation, maintenanceOrderCompleteValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { result, process } = req.body;
    
    const order = await get('SELECT * FROM maintenance_orders WHERE id = ?', [id]);
    if (!order) {
      return error(res, '维修工单不存在', 404);
    }
    
    if (!canTransition(order.status, '已完成')) {
      return error(res, `当前状态"${order.status}"不能完成`, 400);
    }
    
    const plot = await get('SELECT status FROM plots WHERE id = ?', [order.plot_id]);
    const targetPlotStatus = await getPlotStatusAfterMaintenance(order.plot_id);
    const now = new Date().toISOString();
    const oldData = { ...order };
    
    await runInTransaction(async () => {
      await run(
        'UPDATE maintenance_orders SET status = ?, result = ?, process = ?, completed_at = ? WHERE id = ?',
        ['已完成', result, process, now, id]
      );
      
      await run('UPDATE plots SET status = ? WHERE id = ?', [targetPlotStatus, order.plot_id]);
    });
    
    const newData = { status: '已完成', result, process };
    const summary = generateSummary(RESOURCE_TYPES.MAINTENANCE_ORDER, ACTIONS.STATUS_CHANGE, newData, oldData);
    await logOperation(req, RESOURCE_TYPES.MAINTENANCE_ORDER, id, ACTIONS.STATUS_CHANGE, summary);
    
    const plotSummary = generateSummary(RESOURCE_TYPES.PLOT, ACTIONS.STATUS_CHANGE,
      { status: targetPlotStatus }, { status: plot.status });
    await logOperation(req, RESOURCE_TYPES.PLOT, order.plot_id, ACTIONS.STATUS_CHANGE, plotSummary);
    
    success(res, null, '工单完成成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/cancel', authenticate, idParamValidation, maintenanceOrderCancelValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;
    
    const order = await get('SELECT * FROM maintenance_orders WHERE id = ?', [id]);
    if (!order) {
      return error(res, '维修工单不存在', 404);
    }
    
    if (!canTransition(order.status, '已取消')) {
      return error(res, `当前状态"${order.status}"不能取消`, 400);
    }
    
    const plot = await get('SELECT status FROM plots WHERE id = ?', [order.plot_id]);
    const targetPlotStatus = await getPlotStatusAfterMaintenance(order.plot_id);
    const now = new Date().toISOString();
    const oldData = { ...order };
    
    await runInTransaction(async () => {
      await run(
        'UPDATE maintenance_orders SET status = ?, completed_at = ?, remark = ? WHERE id = ?',
        ['已取消', now, remark, id]
      );
      
      await run('UPDATE plots SET status = ? WHERE id = ?', [targetPlotStatus, order.plot_id]);
    });
    
    const newData = { status: '已取消', remark };
    const summary = generateSummary(RESOURCE_TYPES.MAINTENANCE_ORDER, ACTIONS.STATUS_CHANGE, newData, oldData);
    await logOperation(req, RESOURCE_TYPES.MAINTENANCE_ORDER, id, ACTIONS.STATUS_CHANGE, summary);
    
    const plotSummary = generateSummary(RESOURCE_TYPES.PLOT, ACTIONS.STATUS_CHANGE,
      { status: targetPlotStatus }, { status: plot.status });
    await logOperation(req, RESOURCE_TYPES.PLOT, order.plot_id, ACTIONS.STATUS_CHANGE, plotSummary);
    
    success(res, null, '工单取消成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
