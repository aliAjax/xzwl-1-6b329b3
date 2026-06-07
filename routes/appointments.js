const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { appointmentCreateValidation, idParamValidation } = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');
const { checkCapacity, linkAppointmentToSlot, unlinkAppointmentFromSlot, findMatchingTimeSlot } = require('../utils/festivalHelper');

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

    const slotInfo = await get(`
      SELECT fts.id as time_slot_id,
             fts.date,
             fts.start_time,
             fts.end_time,
             fts.capacity,
             fs.festival_name,
             fs.festival_type
      FROM festival_appointment_slots fas
      INNER JOIN festival_time_slots fts ON fas.time_slot_id = fts.id
      INNER JOIN festival_schedules fs ON fts.festival_schedule_id = fs.id
      WHERE fas.appointment_id = ?
    `, [req.params.id]);

    const result = {
      ...appointment,
      festival_slot: slotInfo || null
    };
    
    success(res, result);
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
    
    const capacityCheck = await checkCapacity(appointment_date, appointment_time, number_of_people || 1);
    if (capacityCheck.hasSlot && !capacityCheck.isAvailable) {
      return error(res, `该时段预约已满，剩余容量: ${capacityCheck.remaining}，总容量: ${capacityCheck.capacity}`, 400);
    }
    
    const existingCount = await get(`
      SELECT COUNT(*) as count 
      FROM appointments 
      WHERE appointment_date = ? AND status IN ('待确认', '已确认')
    `, [appointment_date]);
    
    if (existingCount.count >= 50 && !capacityCheck.hasSlot) {
      return error(res, '该日预约已满，请选择其他日期', 400);
    }
    
    const result = await run(
      'INSERT INTO appointments (contact_id, plot_id, appointment_date, appointment_time, number_of_people, vehicle_number, remark) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [contact_id, plot_id, appointment_date, appointment_time, number_of_people || 1, vehicle_number, remark]
    );

    if (capacityCheck.hasSlot) {
      await linkAppointmentToSlot(result.id, appointment_date, appointment_time);
    }

    const summary = generateSummary(RESOURCE_TYPES.APPOINTMENT, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.APPOINTMENT, result.id, ACTIONS.CREATE, summary);
    
    success(res, { 
      id: result.id,
      capacity_info: capacityCheck.hasSlot ? {
        has_slot: true,
        capacity: capacityCheck.capacity,
        booked: capacityCheck.booked + (number_of_people || 1),
        remaining: capacityCheck.remaining - (number_of_people || 1)
      } : { has_slot: false }
    }, '预约创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/confirm', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT * FROM appointments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '预约记录不存在', 404);
    }
    
    if (existing.status !== '待确认') {
      return error(res, '当前状态不允许确认', 400);
    }
    
    await run('UPDATE appointments SET status = "已确认" WHERE id = ?', [id]);

    const newData = { status: '已确认' };
    const summary = generateSummary(RESOURCE_TYPES.APPOINTMENT, ACTIONS.STATUS_CHANGE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.APPOINTMENT, id, ACTIONS.STATUS_CHANGE, summary);

    success(res, null, '预约已确认');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/complete', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT * FROM appointments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '预约记录不存在', 404);
    }
    
    if (!['待确认', '已确认'].includes(existing.status)) {
      return error(res, '当前状态不允许标记完成', 400);
    }
    
    await run('UPDATE appointments SET status = "已完成" WHERE id = ?', [id]);

    const newData = { status: '已完成' };
    const summary = generateSummary(RESOURCE_TYPES.APPOINTMENT, ACTIONS.STATUS_CHANGE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.APPOINTMENT, id, ACTIONS.STATUS_CHANGE, summary);

    success(res, null, '预约已完成');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/cancel', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const existing = await get('SELECT * FROM appointments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '预约记录不存在', 404);
    }
    
    if (!['待确认', '已确认'].includes(existing.status)) {
      return error(res, '当前状态不允许取消', 400);
    }
    
    const remark = reason ? `${existing.remark || ''} 取消原因: ${reason}`.trim() : existing.remark;
    await run('UPDATE appointments SET status = "已取消", remark = ? WHERE id = ?', [remark, id]);

    await unlinkAppointmentFromSlot(id);

    const newData = { status: '已取消', remark };
    const summary = generateSummary(RESOURCE_TYPES.APPOINTMENT, ACTIONS.STATUS_CHANGE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.APPOINTMENT, id, ACTIONS.STATUS_CHANGE, summary);

    success(res, null, '预约已取消');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { contact_id, plot_id, appointment_date, appointment_time, number_of_people, status, vehicle_number, remark } = req.body;
    
    const existing = await get('SELECT * FROM appointments WHERE id = ?', [id]);
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

    const newDate = appointment_date || existing.appointment_date;
    const newTime = appointment_time !== undefined ? appointment_time : existing.appointment_time;
    const newNumberOfPeople = number_of_people !== undefined ? number_of_people : existing.number_of_people;
    const newStatus = status || existing.status;

    const dateOrTimeChanged = (appointment_date && appointment_date !== existing.appointment_date) || 
                              (appointment_time !== undefined && appointment_time !== existing.appointment_time);
    const peopleChanged = number_of_people !== undefined && number_of_people !== existing.number_of_people;

    if (dateOrTimeChanged || peopleChanged) {
      const oldSlot = await findMatchingTimeSlot(existing.appointment_date, existing.appointment_time);
      const newSlot = await findMatchingTimeSlot(newDate, newTime);

      if (oldSlot && (!newSlot || oldSlot.id !== newSlot.id)) {
        await unlinkAppointmentFromSlot(id);
      }

      if (newSlot && ['待确认', '已确认'].includes(newStatus)) {
        const { getSlotOccupancy } = require('../utils/festivalHelper');
        const currentOccupancy = await getSlotOccupancy(newSlot.id, newSlot.date, newSlot.start_time, newSlot.end_time);
        
        let bookedCount = currentOccupancy.total_people;
        if (oldSlot && oldSlot.id === newSlot.id) {
          bookedCount -= existing.number_of_people;
        }
        
        const remaining = newSlot.capacity - bookedCount;
        if (newNumberOfPeople > remaining) {
          return error(res, `该时段容量不足，剩余容量: ${remaining}，需要: ${newNumberOfPeople}`, 400);
        }
      }

      if (newSlot && ['待确认', '已确认'].includes(newStatus)) {
        await linkAppointmentToSlot(id, newDate, newTime);
      }
    }

    if (status && status !== existing.status && ['已完成', '已取消'].includes(status)) {
      await unlinkAppointmentFromSlot(id);
    }

    if (status && status !== existing.status && ['待确认', '已确认'].includes(status)) {
      const slot = await findMatchingTimeSlot(newDate, newTime);
      if (slot) {
        const capacityCheck = await checkCapacity(newDate, newTime, newNumberOfPeople);
        if (!capacityCheck.isAvailable) {
          return error(res, `该时段预约已满，剩余容量: ${capacityCheck.remaining}`, 400);
        }
        await linkAppointmentToSlot(id, newDate, newTime);
      }
    }
    
    await run(
      'UPDATE appointments SET contact_id = ?, plot_id = ?, appointment_date = ?, appointment_time = ?, number_of_people = ?, status = ?, vehicle_number = ?, remark = ? WHERE id = ?',
      [contact_id, plot_id, appointment_date, appointment_time, number_of_people, status, vehicle_number, remark, id]
    );

    const newData = { contact_id, plot_id, appointment_date, appointment_time, number_of_people, status, vehicle_number, remark };
    let action = ACTIONS.UPDATE;
    let summary;

    if (existing.status !== status) {
      action = ACTIONS.STATUS_CHANGE;
      summary = generateSummary(RESOURCE_TYPES.APPOINTMENT, ACTIONS.STATUS_CHANGE, newData, existing);
    } else {
      summary = generateSummary(RESOURCE_TYPES.APPOINTMENT, ACTIONS.UPDATE, newData, existing);
    }
    await logOperation(req, RESOURCE_TYPES.APPOINTMENT, id, action, summary);
    
    success(res, null, '预约更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT * FROM appointments WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '预约记录不存在', 404);
    }
    
    await unlinkAppointmentFromSlot(id);
    await run('DELETE FROM appointments WHERE id = ?', [id]);

    const summary = generateSummary(RESOURCE_TYPES.APPOINTMENT, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.APPOINTMENT, id, ACTIONS.DELETE, summary);
    
    success(res, null, '预约删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
