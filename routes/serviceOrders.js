const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery, runInTransaction } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { serviceOrderCreateValidation, serviceOrderBatchCreateFromAppointmentValidation, serviceOrderStatusValidation, idParamValidation } = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');
const { createAuditSnapshot, AUDITED_RESOURCE_TYPES } = require('../utils/audit');

const router = express.Router();

const generateOrderNo = () => {
  const date = moment().format('YYYYMMDD');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `SO${date}${random}`;
};

const calculateAmount = (unitPrice, quantity) => {
  const priceInCents = Math.round(parseFloat(unitPrice) * 100);
  const qty = parseInt(quantity) || 1;
  const totalInCents = priceInCents * qty;
  return Math.round(totalInCents) / 100;
};

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status = '', service_item_id = '', contact_id = '', plot_id = '', start_date = '', end_date = '', keyword = '' } = req.query;
    
    let baseSql = `
      SELECT so.*,
             si.name as service_item_name,
             si.category as service_category,
             COALESCE(c.name, so.contact_name) as contact_name,
             COALESCE(c.phone, so.contact_phone) as contact_phone,
             p.plot_number,
             p.area,
             a.appointment_date,
             a.appointment_time,
             u.name as operator_name
      FROM service_orders so
      LEFT JOIN service_items si ON so.service_item_id = si.id
      LEFT JOIN contacts c ON so.contact_id = c.id
      LEFT JOIN plots p ON so.plot_id = p.id
      LEFT JOIN appointments a ON so.appointment_id = a.id
      LEFT JOIN users u ON so.operator_id = u.id
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      baseSql += ' AND so.status = ?';
      params.push(status);
    }
    
    if (service_item_id) {
      baseSql += ' AND so.service_item_id = ?';
      params.push(service_item_id);
    }
    
    if (contact_id) {
      baseSql += ' AND so.contact_id = ?';
      params.push(contact_id);
    }
    
    if (plot_id) {
      baseSql += ' AND so.plot_id = ?';
      params.push(plot_id);
    }
    
    if (start_date) {
      baseSql += ' AND so.service_date >= ?';
      params.push(start_date);
    }
    
    if (end_date) {
      baseSql += ' AND so.service_date <= ?';
      params.push(end_date);
    }
    
    if (keyword) {
      baseSql += ' AND (so.order_no LIKE ? OR so.contact_name LIKE ? OR so.contact_phone LIKE ? OR p.plot_number LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'so.created_at DESC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/statistics', authenticate, async (req, res) => {
  try {
    const { start_date = '', end_date = '' } = req.query;
    
    let sql = `
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = '待处理' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = '处理中' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = '已取消' THEN 1 ELSE 0 END) as cancelled,
        SUM(total_amount) as total_amount
      FROM service_orders
      WHERE 1=1
    `;
    const params = [];
    
    if (start_date) {
      sql += ' AND service_date >= ?';
      params.push(start_date);
    }
    
    if (end_date) {
      sql += ' AND service_date <= ?';
      params.push(end_date);
    }
    
    const stats = await get(sql, params);
    
    const categoryStats = await all(`
      SELECT 
        si.category,
        COUNT(*) as count,
        SUM(so.total_amount) as amount
      FROM service_orders so
      LEFT JOIN service_items si ON so.service_item_id = si.id
      WHERE so.status = '已完成'
      ${start_date ? 'AND so.service_date >= ?' : ''}
      ${end_date ? 'AND so.service_date <= ?' : ''}
      GROUP BY si.category
      ORDER BY count DESC
    `, params);
    
    success(res, {
      overview: {
        total_orders: stats.total_orders || 0,
        pending: stats.pending || 0,
        processing: stats.processing || 0,
        completed: stats.completed || 0,
        cancelled: stats.cancelled || 0,
        total_amount: stats.total_amount || 0
      },
      by_category: categoryStats
    }, '统计查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const order = await get(`
      SELECT so.*,
             si.name as service_item_name,
             si.category as service_category,
             si.description as service_description,
             si.unit as service_unit,
             COALESCE(c.name, so.contact_name) as contact_name,
             COALESCE(c.phone, so.contact_phone) as contact_phone,
             c.id_card as contact_id_card,
             c.address as contact_address,
             p.plot_number,
             p.area,
             a.appointment_date,
             a.appointment_time,
             a.status as appointment_status,
             u.name as operator_name
      FROM service_orders so
      LEFT JOIN service_items si ON so.service_item_id = si.id
      LEFT JOIN contacts c ON so.contact_id = c.id
      LEFT JOIN plots p ON so.plot_id = p.id
      LEFT JOIN appointments a ON so.appointment_id = a.id
      LEFT JOIN users u ON so.operator_id = u.id
      WHERE so.id = ?
    `, [req.params.id]);
    
    if (!order) {
      return error(res, '服务订单不存在', 404);
    }
    
    success(res, order);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, serviceOrderCreateValidation, async (req, res) => {
  try {
    const { service_item_id, contact_id, plot_id, appointment_id, contact_name, contact_phone, service_date, service_time, quantity, unit_price, total_amount, remark } = req.body;
    
    const serviceItem = await get('SELECT id, price, status FROM service_items WHERE id = ?', [service_item_id]);
    if (!serviceItem) {
      return error(res, '服务项目不存在', 400);
    }
    if (serviceItem.status !== '上架') {
      return error(res, '该服务项目已下架', 400);
    }
    
    if (contact_id) {
      const contact = await get('SELECT id, name, phone FROM contacts WHERE id = ?', [contact_id]);
      if (!contact) {
        return error(res, '联系人不存在', 400);
      }
    }
    
    if (plot_id) {
      const plot = await get('SELECT id FROM plots WHERE id = ?', [plot_id]);
      if (!plot) {
        return error(res, '墓位不存在', 400);
      }
    }
    
    if (appointment_id) {
      const appointment = await get('SELECT id FROM appointments WHERE id = ?', [appointment_id]);
      if (!appointment) {
        return error(res, '预约记录不存在', 400);
      }
    }
    
    const orderNo = generateOrderNo();
    const finalUnitPrice = unit_price !== undefined ? Number(unit_price) : Number(serviceItem.price);
    const finalTotalAmount = total_amount !== undefined ? Number(total_amount) : calculateAmount(finalUnitPrice, quantity || 1);
    
    const result = await run(
      `INSERT INTO service_orders 
       (order_no, service_item_id, contact_id, plot_id, appointment_id, contact_name, contact_phone, 
        service_date, service_time, quantity, unit_price, total_amount, remark) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderNo, service_item_id, contact_id, plot_id, appointment_id, contact_name, contact_phone, 
       service_date, service_time, quantity || 1, finalUnitPrice, finalTotalAmount, remark]
    );
    
    success(res, { id: result.id, order_no: orderNo }, '服务订单创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/from-appointment/:id', authenticate, idParamValidation, serviceOrderBatchCreateFromAppointmentValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { services } = req.body;

    const appointment = await get(`
      SELECT a.*,
             c.name as contact_name,
             c.phone as contact_phone
      FROM appointments a
      LEFT JOIN contacts c ON a.contact_id = c.id
      WHERE a.id = ?
    `, [id]);

    if (!appointment) {
      return error(res, '预约记录不存在', 404);
    }

    const serviceItemIds = services.map(s => s.service_item_id);
    const placeholders = serviceItemIds.map(() => '?').join(',');
    const serviceItems = await all(`
      SELECT id, name, price, status, category
      FROM service_items
      WHERE id IN (${placeholders})
    `, serviceItemIds);

    const serviceItemMap = {};
    serviceItems.forEach(item => {
      serviceItemMap[item.id] = item;
    });

    const seenIds = new Set();
    const batchDuplicates = [];
    for (const service of services) {
      if (seenIds.has(service.service_item_id)) {
        batchDuplicates.push(service.service_item_id);
      } else {
        seenIds.add(service.service_item_id);
      }
    }
    if (batchDuplicates.length > 0) {
      const duplicateNames = batchDuplicates
        .map(id => serviceItemMap[id]?.name || id)
        .join('、');
      return error(res, `同批请求中存在重复服务项目：${duplicateNames}`, 400);
    }

    for (const service of services) {
      const item = serviceItemMap[service.service_item_id];
      if (!item) {
        return error(res, `服务项目ID ${service.service_item_id} 不存在`, 400);
      }
      if (item.status !== '上架') {
        return error(res, `服务项目"${item.name}"已下架，无法下单`, 400);
      }
    }

    const existingOrders = await all(`
      SELECT service_item_id
      FROM service_orders
      WHERE appointment_id = ?
    `, [id]);

    const existingServiceItemIds = existingOrders.map(o => o.service_item_id);
    const duplicateServices = services.filter(s => existingServiceItemIds.includes(s.service_item_id));
    if (duplicateServices.length > 0) {
      const duplicateNames = duplicateServices
        .map(s => serviceItemMap[s.service_item_id]?.name || s.service_item_id)
        .join('、');
      return error(res, `该预约已存在服务订单：${duplicateNames}，请勿重复创建`, 400);
    }

    const results = await runInTransaction(async () => {
      const createdOrders = [];

      for (const service of services) {
        const serviceItem = serviceItemMap[service.service_item_id];
        const orderNo = generateOrderNo();
        const finalUnitPrice = service.unit_price !== undefined ? Number(service.unit_price) : Number(serviceItem.price);
        const finalTotalAmount = calculateAmount(finalUnitPrice, service.quantity || 1);

        const result = await run(
          `INSERT INTO service_orders
           (order_no, service_item_id, contact_id, plot_id, appointment_id, contact_name, contact_phone,
            service_date, service_time, quantity, unit_price, total_amount, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderNo,
            service.service_item_id,
            appointment.contact_id,
            appointment.plot_id,
            id,
            appointment.contact_name,
            appointment.contact_phone,
            appointment.appointment_date,
            appointment.appointment_time,
            service.quantity || 1,
            finalUnitPrice,
            finalTotalAmount,
            service.remark || null
          ]
        );

        createdOrders.push({
          id: result.id,
          order_no: orderNo,
          service_item_id: service.service_item_id,
          service_item_name: serviceItem.name,
          quantity: service.quantity || 1,
          unit_price: finalUnitPrice,
          total_amount: finalTotalAmount
        });
      }

      return createdOrders;
    });

    for (const order of results) {
      const summary = generateSummary(RESOURCE_TYPES.SERVICE_ORDER, ACTIONS.CREATE, {
        service_item_name: order.service_item_name,
        quantity: order.quantity,
        total_amount: order.total_amount
      });
      await logOperation(req, RESOURCE_TYPES.SERVICE_ORDER, order.id, ACTIONS.CREATE, summary);
    }

    success(res, {
      appointment_id: id,
      total_count: results.length,
      orders: results
    }, '批量创建服务订单成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/process', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const operator_id = req.user.id;
    
    const existing = await get('SELECT id, status FROM service_orders WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '服务订单不存在', 404);
    }
    
    if (existing.status !== '待处理') {
      return error(res, '当前状态不允许开始处理', 400);
    }
    
    await run('UPDATE service_orders SET status = "处理中", operator_id = ? WHERE id = ?', [operator_id, id]);
    success(res, null, '服务订单已开始处理');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/complete', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;
    const operator_id = req.user.id;
    const completedAt = moment().format('YYYY-MM-DD HH:mm:ss');
    
    const existing = await get('SELECT id, status, remark FROM service_orders WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '服务订单不存在', 404);
    }
    
    if (!['待处理', '处理中'].includes(existing.status)) {
      return error(res, '当前状态不允许标记完成', 400);
    }
    
    let finalRemark = existing.remark || '';
    if (remark) {
      finalRemark = finalRemark ? `${finalRemark} ${remark}` : remark;
    }
    
    await run(
      'UPDATE service_orders SET status = "已完成", operator_id = ?, completed_at = ?, remark = ? WHERE id = ?',
      [operator_id, completedAt, finalRemark || null, id]
    );
    success(res, null, '服务订单已完成');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/cancel', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const existing = await get('SELECT id, status, remark FROM service_orders WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '服务订单不存在', 404);
    }
    
    if (!['待处理', '处理中'].includes(existing.status)) {
      return error(res, '当前状态不允许取消', 400);
    }
    
    const finalRemark = reason ? `${existing.remark || ''} 取消原因: ${reason}`.trim() : existing.remark;
    
    await run('UPDATE service_orders SET status = "已取消", remark = ? WHERE id = ?', [finalRemark, id]);
    success(res, null, '服务订单已取消');
  } catch (err) {
    error(res, err.message, 500);
  }
});

const validateStatusTransition = (currentStatus, newStatus) => {
  const allowedTransitions = {
    '待处理': ['处理中', '已完成', '已取消'],
    '处理中': ['已完成', '已取消', '待处理'],
    '已完成': [],
    '已取消': []
  };
  
  const allowed = allowedTransitions[currentStatus] || [];
  return allowed.includes(newStatus);
};

router.put('/:id/status', authenticate, idParamValidation, serviceOrderStatusValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, remark } = req.body;
    const operator_id = req.user.id;
    
    const existing = await get('SELECT id, status, remark FROM service_orders WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '服务订单不存在', 404);
    }
    
    if (existing.status === status) {
      return success(res, null, '订单状态未变更');
    }
    
    if (!validateStatusTransition(existing.status, status)) {
      return error(res, `不允许从"${existing.status}"状态变更为"${status}"状态`, 400);
    }
    
    let completed_at = null;
    if (status === '已完成') {
      completed_at = moment().format('YYYY-MM-DD HH:mm:ss');
    }
    
    let finalRemark = existing.remark || '';
    if (remark) {
      finalRemark = finalRemark ? `${finalRemark} ${remark}` : remark;
    }
    
    await run(
      'UPDATE service_orders SET status = ?, operator_id = ?, completed_at = ?, remark = ? WHERE id = ?',
      [status, operator_id, completed_at, finalRemark || null, id]
    );

    const newData = { status, operator_id, completed_at, remark: finalRemark };
    const auditResult = await createAuditSnapshot(
      AUDITED_RESOURCE_TYPES.SERVICE_ORDER,
      id,
      existing,
      newData,
      req,
      null
    );
    const snapshotId = auditResult?.snapshotId || null;

    const summary = generateSummary(RESOURCE_TYPES.SERVICE_ORDER, ACTIONS.STATUS_CHANGE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.SERVICE_ORDER, id, ACTIONS.STATUS_CHANGE, summary, snapshotId);
    
    success(res, null, '订单状态更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { service_item_id, contact_id, plot_id, appointment_id, contact_name, contact_phone, service_date, service_time, quantity, unit_price, total_amount, remark } = req.body;
    
    const existing = await get('SELECT id, status FROM service_orders WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '服务订单不存在', 404);
    }
    
    if (existing.status === '已完成' || existing.status === '已取消') {
      return error(res, '已完成或已取消的订单无法修改', 400);
    }
    
    if (service_item_id) {
      const serviceItem = await get('SELECT id, status FROM service_items WHERE id = ?', [service_item_id]);
      if (!serviceItem) {
        return error(res, '服务项目不存在', 400);
      }
      if (serviceItem.status !== '上架') {
        return error(res, '该服务项目已下架', 400);
      }
    }
    
    if (contact_id) {
      const contact = await get('SELECT id FROM contacts WHERE id = ?', [contact_id]);
      if (!contact) {
        return error(res, '联系人不存在', 400);
      }
    }
    
    if (plot_id) {
      const plot = await get('SELECT id FROM plots WHERE id = ?', [plot_id]);
      if (!plot) {
        return error(res, '墓位不存在', 400);
      }
    }
    
    if (appointment_id) {
      const appointment = await get('SELECT id FROM appointments WHERE id = ?', [appointment_id]);
      if (!appointment) {
        return error(res, '预约记录不存在', 400);
      }
    }
    
    const finalUnitPrice = unit_price !== undefined ? Number(unit_price) : Number(existing.unit_price);
    const finalTotalAmount = total_amount !== undefined ? Number(total_amount) : calculateAmount(finalUnitPrice, quantity || existing.quantity || 1);
    
    await run(
      `UPDATE service_orders 
       SET service_item_id = ?, contact_id = ?, plot_id = ?, appointment_id = ?, 
           contact_name = ?, contact_phone = ?, service_date = ?, service_time = ?, 
           quantity = ?, unit_price = ?, total_amount = ?, remark = ? 
       WHERE id = ?`,
      [service_item_id || existing.service_item_id, contact_id, plot_id, appointment_id, 
       contact_name, contact_phone, service_date, service_time, 
       quantity || existing.quantity, finalUnitPrice, finalTotalAmount, remark, id]
    );

    const newData = { service_item_id, contact_id, plot_id, appointment_id, contact_name, contact_phone, service_date, service_time, quantity, unit_price: finalUnitPrice, total_amount: finalTotalAmount, remark };
    const auditResult = await createAuditSnapshot(
      AUDITED_RESOURCE_TYPES.SERVICE_ORDER,
      id,
      existing,
      newData,
      req,
      null
    );
    const snapshotId = auditResult?.snapshotId || null;

    const summary = generateSummary(RESOURCE_TYPES.SERVICE_ORDER, ACTIONS.UPDATE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.SERVICE_ORDER, id, ACTIONS.UPDATE, summary, snapshotId);
    
    success(res, null, '服务订单更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT id, status FROM service_orders WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '服务订单不存在', 404);
    }
    
    if (existing.status !== '待处理') {
      return error(res, '仅待处理状态的订单可删除', 400);
    }
    
    await run('DELETE FROM service_orders WHERE id = ?', [id]);
    success(res, null, '服务订单删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
