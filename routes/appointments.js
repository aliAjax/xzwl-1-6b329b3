const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { appointmentCreateValidation, idParamValidation } = require('../middleware/validator');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status = '', date = '', keyword = '' } = req.query;
    
    let baseSql = `
      SELECT a.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             p.plot_number,
             p.area
      FROM appointments a 
      LEFT JOIN contacts c ON a.contact_id = c.id 
      LEFT JOIN plots p ON a.plot_id = p.id 
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      baseSql += ' AND a.status = ?';
      params.push(status);
    }
    
    if (date) {
      baseSql += ' AND a.appointment_date = ?';
      params.push(date);
    }
    
    if (keyword) {
      baseSql += ' AND (c.name LIKE ? OR p.plot_number LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'a.appointment_date DESC, a.appointment_time DESC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/upcoming', authenticate, async (req, res) => {
  try {
    const { days = 7, page = 1, pageSize = 20 } = req.query;
    
    const today = moment().format('YYYY-MM-DD');
    const endDate = moment().add(parseInt(days), 'days').format('YYYY-MM-DD');
    
    let baseSql = `
      SELECT a.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             p.plot_number,
             p.area
      FROM appointments a 
      LEFT JOIN contacts c ON a.contact_id = c.id 
      LEFT JOIN plots p ON a.plot_id = p.id 
      WHERE a.appointment_date >= ? 
        AND a.appointment_date <= ?
        AND a.status IN ('待确认', '已确认')
    `;
    const params = [today, endDate];
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'a.appointment_date ASC, a.appointment_time ASC');
    
    const byDate = {};
    result.data.forEach(item => {
      if (!byDate[item.appointment_date]) {
        byDate[item.appointment_date] = [];
      }
      byDate[item.appointment_date].push(item);
    });
    
    success(res, {
      list: result.data,
      byDate,
      pagination: {
        total: result.total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        totalPages: Math.ceil(result.total / pageSize)
      }
    }, '近期预约查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/today', authenticate, async (req, res) => {
  try {
    const today = moment().format('YYYY-MM-DD');
    
    const appointments = await all(`
      SELECT a.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             p.plot_number,
             p.area
      FROM appointments a 
      LEFT JOIN contacts c ON a.contact_id = c.id 
      LEFT JOIN plots p ON a.plot_id = p.id 
      WHERE a.appointment_date = ?
      ORDER BY a.appointment_time ASC
    `, [today]);
    
    const stats = await get(`
      SELECT 
        SUM(CASE WHEN status = '待确认' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = '已确认' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = '已取消' THEN 1 ELSE 0 END) as cancelled,
        SUM(number_of_people) as total_people
      FROM appointments 
      WHERE appointment_date = ?
    `, [today]);
    
    success(res, {
      date: today,
      list: appointments,
      statistics: {
        total: appointments.length,
        pending: stats.pending || 0,
        confirmed: stats.confirmed || 0,
        completed: stats.completed || 0,
        cancelled: stats.cancelled || 0,
        total_people: stats.total_people || 0
      }
    }, '今日预约查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const appointment = await get(`
      SELECT a.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             c.id_card as contact_id_card,
             p.plot_number,
             p.area,
             d.name as deceased_name
      FROM appointments a 
      LEFT JOIN contacts c ON a.contact_id = c.id 
      LEFT JOIN plots p ON a.plot_id = p.id 
      LEFT JOIN deceased d ON p.id = d.plot_id 
      WHERE a.id = ?
    `, [req.params.id]);
    
    if (!appointment) {
      return error(res, '预约记录不存在', 404);
    }
    
    success(res, appointment);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, appointmentCreateValidation, async (req, res) => {
  try {
    const { contact_id, plot_id, appointment_date, appointment_time, number_of_people, vehicle_number, remark } = req.body;
    
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
    
    const existingCount = await get(`
      SELECT COUNT(*) as count 
      FROM appointments 
      WHERE appointment_date = ? AND status IN ('待确认', '已确认')
    `, [appointment_date]);
    
    if (existingCount.count >= 50) {
      return error(res, '该日预约已满，请选择其他日期', 400);
    }
    
    const result = await run(
      'INSERT INTO appointments (contact_id, plot_id, appointment_date, appointment_time, number_of_people, vehicle_number, remark) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [contact_id, plot_id, appointment_date, appointment_time, number_of_people || 1, vehicle_number, remark]
    );
    
    success(res, { id: result.id }, '预约创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/confirm', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT id, status FROM appointments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '预约记录不存在', 404);
    }
    
    if (existing.status !== '待确认') {
      return error(res, '当前状态不允许确认', 400);
    }
    
    await run('UPDATE appointments SET status = "已确认" WHERE id = ?', [id]);
    success(res, null, '预约已确认');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/complete', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT id, status FROM appointments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '预约记录不存在', 404);
    }
    
    if (!['待确认', '已确认'].includes(existing.status)) {
      return error(res, '当前状态不允许标记完成', 400);
    }
    
    await run('UPDATE appointments SET status = "已完成" WHERE id = ?', [id]);
    success(res, null, '预约已完成');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/cancel', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const existing = await get('SELECT id, status FROM appointments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '预约记录不存在', 404);
    }
    
    if (!['待确认', '已确认'].includes(existing.status)) {
      return error(res, '当前状态不允许取消', 400);
    }
    
    const remark = reason ? `${existing.remark || ''} 取消原因: ${reason}`.trim() : existing.remark;
    await run('UPDATE appointments SET status = "已取消", remark = ? WHERE id = ?', [remark, id]);
    success(res, null, '预约已取消');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { contact_id, plot_id, appointment_date, appointment_time, number_of_people, status, vehicle_number, remark } = req.body;
    
    const existing = await get('SELECT id FROM appointments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '预约记录不存在', 404);
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
    
    await run(
      'UPDATE appointments SET contact_id = ?, plot_id = ?, appointment_date = ?, appointment_time = ?, number_of_people = ?, status = ?, vehicle_number = ?, remark = ? WHERE id = ?',
      [contact_id, plot_id, appointment_date, appointment_time, number_of_people, status, vehicle_number, remark, id]
    );
    
    success(res, null, '预约更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await run('DELETE FROM appointments WHERE id = ?', [id]);
    
    if (result.changes === 0) {
      return error(res, '预约记录不存在', 404);
    }
    
    success(res, null, '预约删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
