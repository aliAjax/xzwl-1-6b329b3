const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery, runInTransaction } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const {
  festivalScheduleCreateValidation,
  festivalScheduleUpdateValidation,
  festivalScheduleQueryValidation,
  festivalTimeSlotCreateValidation,
  festivalTimeSlotUpdateValidation,
  festivalStaffScheduleCreateValidation,
  festivalQueryByDateValidation,
  idParamValidation,
  slotIdParamValidation,
  staffIdParamValidation
} = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');

const router = express.Router();

const getSlotOccupancy = async (slotId, date, startTime, endTime) => {
  const result = await get(`
    SELECT 
      COUNT(*) as appointment_count,
      COALESCE(SUM(number_of_people), 0) as total_people
    FROM appointments
    WHERE appointment_date = ?
      AND appointment_time >= ?
      AND appointment_time < ?
      AND status IN ('待确认', '已确认')
      AND id IN (
        SELECT appointment_id 
        FROM festival_appointment_slots 
        WHERE time_slot_id = ?
      )
  `, [date, startTime, endTime, slotId]);

  if (result && result.appointment_count > 0) {
    return {
      appointment_count: result.appointment_count,
      total_people: result.total_people
    };
  }

  const fallback = await get(`
    SELECT 
      COUNT(*) as appointment_count,
      COALESCE(SUM(number_of_people), 0) as total_people
    FROM appointments
    WHERE appointment_date = ?
      AND appointment_time >= ?
      AND appointment_time < ?
      AND status IN ('待确认', '已确认')
  `, [date, startTime, endTime]);

  return {
    appointment_count: fallback.appointment_count || 0,
    total_people: fallback.total_people || 0
  };
};

const getStaffForSlot = async (slotId) => {
  return await all(`
    SELECT fss.id, fss.user_id, fss.user_name, fss.duty,
           u.role, u.phone
    FROM festival_staff_schedules fss
    LEFT JOIN users u ON fss.user_id = u.id
    WHERE fss.time_slot_id = ?
    ORDER BY fss.id ASC
  `, [slotId]);
};

const getAppointmentsForSlot = async (slotId, date, startTime, endTime) => {
  const directSlots = await all(`
    SELECT a.id, a.contact_id, a.plot_id, a.appointment_date, a.appointment_time,
           a.number_of_people, a.status, a.vehicle_number, a.remark,
           c.name as contact_name, c.phone as contact_phone,
           p.plot_number, p.area
    FROM appointments a
    INNER JOIN festival_appointment_slots fas ON a.id = fas.appointment_id
    LEFT JOIN contacts c ON a.contact_id = c.id
    LEFT JOIN plots p ON a.plot_id = p.id
    WHERE fas.time_slot_id = ?
      AND a.status IN ('待确认', '已确认')
    ORDER BY a.appointment_time ASC
  `, [slotId]);

  if (directSlots.length > 0) {
    return directSlots;
  }

  return await all(`
    SELECT a.id, a.contact_id, a.plot_id, a.appointment_date, a.appointment_time,
           a.number_of_people, a.status, a.vehicle_number, a.remark,
           c.name as contact_name, c.phone as contact_phone,
           p.plot_number, p.area
    FROM appointments a
    LEFT JOIN contacts c ON a.contact_id = c.id
    LEFT JOIN plots p ON a.plot_id = p.id
    WHERE a.appointment_date = ?
      AND a.appointment_time >= ?
      AND a.appointment_time < ?
      AND a.status IN ('待确认', '已确认')
    ORDER BY a.appointment_time ASC
  `, [date, startTime, endTime]);
};

router.get('/', authenticate, festivalScheduleQueryValidation, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, festival_type = '', status = '', start_date = '', end_date = '' } = req.query;

    let baseSql = `
      SELECT fs.*,
             (SELECT COUNT(*) FROM festival_time_slots fts WHERE fts.festival_schedule_id = fs.id) as slot_count
      FROM festival_schedules fs
      WHERE 1=1
    `;
    const params = [];

    if (festival_type) {
      baseSql += ' AND fs.festival_type = ?';
      params.push(festival_type);
    }

    if (status) {
      baseSql += ' AND fs.status = ?';
      params.push(status);
    }

    if (start_date) {
      baseSql += ' AND fs.start_date >= ?';
      params.push(start_date);
    }

    if (end_date) {
      baseSql += ' AND fs.end_date <= ?';
      params.push(end_date);
    }

    const result = await paginateQuery(baseSql, params, page, pageSize, 'fs.start_date DESC, fs.created_at DESC');

    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/calendar', authenticate, async (req, res) => {
  try {
    const { month = moment().format('YYYY-MM') } = req.query;
    const startOfMonth = moment(month).startOf('month').format('YYYY-MM-DD');
    const endOfMonth = moment(month).endOf('month').format('YYYY-MM-DD');

    const schedules = await all(`
      SELECT fs.*,
             fts.date,
             fts.id as time_slot_id,
             fts.start_time,
             fts.end_time,
             fts.capacity
      FROM festival_schedules fs
      LEFT JOIN festival_time_slots fts ON fs.id = fts.festival_schedule_id
      WHERE fs.status = 'active'
        AND fts.date >= ?
        AND fts.date <= ?
      ORDER BY fts.date ASC, fts.start_time ASC
    `, [startOfMonth, endOfMonth]);

    const calendarData = {};
    const dateSchedules = {};

    for (const slot of schedules) {
      if (!dateSchedules[slot.date]) {
        dateSchedules[slot.date] = {
          date: slot.date,
          festival_name: slot.festival_name,
          festival_type: slot.festival_type,
          festival_schedule_id: slot.id,
          description: slot.description,
          has_schedule: true,
          slots: []
        };
      }

      const occupancy = await getSlotOccupancy(slot.time_slot_id, slot.date, slot.start_time, slot.end_time);
      const remaining = Math.max(0, slot.capacity - occupancy.total_people);

      dateSchedules[slot.date].slots.push({
        id: slot.time_slot_id,
        start_time: slot.start_time,
        end_time: slot.end_time,
        capacity: slot.capacity,
        booked: occupancy.total_people,
        remaining: remaining,
        is_full: remaining === 0,
        appointment_count: occupancy.appointment_count
      });
    }

    success(res, {
      month: month,
      dates: Object.values(dateSchedules)
    }, '日历数据查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/available-slots', authenticate, festivalQueryByDateValidation, async (req, res) => {
  try {
    const { date } = req.query;

    const slots = await all(`
      SELECT fts.*,
             fs.festival_name,
             fs.festival_type,
             fs.description as festival_description
      FROM festival_time_slots fts
      INNER JOIN festival_schedules fs ON fts.festival_schedule_id = fs.id
      WHERE fs.status = 'active'
        AND fts.date = ?
      ORDER BY fts.start_time ASC
    `, [date]);

    const result = [];
    for (const slot of slots) {
      const occupancy = await getSlotOccupancy(slot.id, date, slot.start_time, slot.end_time);
      const staff = await getStaffForSlot(slot.id);
      const remaining = Math.max(0, slot.capacity - occupancy.total_people);

      result.push({
        id: slot.id,
        festival_schedule_id: slot.festival_schedule_id,
        festival_name: slot.festival_name,
        festival_type: slot.festival_type,
        date: slot.date,
        start_time: slot.start_time,
        end_time: slot.end_time,
        capacity: slot.capacity,
        booked_people: occupancy.total_people,
        appointment_count: occupancy.appointment_count,
        remaining: remaining,
        is_full: remaining === 0,
        staff: staff,
        remark: slot.remark
      });
    }

    success(res, {
      date: date,
      slots: result,
      total_capacity: result.reduce((sum, s) => sum + s.capacity, 0),
      total_booked: result.reduce((sum, s) => sum + s.booked_people, 0),
      total_remaining: result.reduce((sum, s) => sum + s.remaining, 0)
    }, '可预约时段查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;

    const schedule = await get(`
      SELECT fs.*,
             (SELECT COUNT(*) FROM festival_time_slots fts WHERE fts.festival_schedule_id = fs.id) as slot_count,
             (SELECT COUNT(DISTINCT date) FROM festival_time_slots fts WHERE fts.festival_schedule_id = fs.id) as date_count
      FROM festival_schedules fs
      WHERE fs.id = ?
    `, [id]);

    if (!schedule) {
      return error(res, '节日排班不存在', 404);
    }

    const slots = await all(`
      SELECT fts.*
      FROM festival_time_slots fts
      WHERE fts.festival_schedule_id = ?
      ORDER BY fts.date ASC, fts.start_time ASC
    `, [id]);

    const slotsWithDetails = [];
    for (const slot of slots) {
      const occupancy = await getSlotOccupancy(slot.id, slot.date, slot.start_time, slot.end_time);
      const staff = await getStaffForSlot(slot.id);
      const remaining = Math.max(0, slot.capacity - occupancy.total_people);

      slotsWithDetails.push({
        ...slot,
        booked_people: occupancy.total_people,
        appointment_count: occupancy.appointment_count,
        remaining: remaining,
        is_full: remaining === 0,
        staff: staff
      });
    }

    const dates = [];
    const dateMap = {};
    for (const slot of slotsWithDetails) {
      if (!dateMap[slot.date]) {
        dateMap[slot.date] = {
          date: slot.date,
          slots: [],
          total_capacity: 0,
          total_booked: 0,
          total_remaining: 0
        };
        dates.push(dateMap[slot.date]);
      }
      dateMap[slot.date].slots.push(slot);
      dateMap[slot.date].total_capacity += slot.capacity;
      dateMap[slot.date].total_booked += slot.booked_people;
      dateMap[slot.date].total_remaining += slot.remaining;
    }

    success(res, {
      ...schedule,
      dates: dates
    }, '节日排班详情查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/slots/:slotId/detail', authenticate, slotIdParamValidation, async (req, res) => {
  try {
    const { slotId } = req.params;

    const slot = await get(`
      SELECT fts.*,
             fs.festival_name,
             fs.festival_type
      FROM festival_time_slots fts
      INNER JOIN festival_schedules fs ON fts.festival_schedule_id = fs.id
      WHERE fts.id = ?
    `, [slotId]);

    if (!slot) {
      return error(res, '时段不存在', 404);
    }

    const occupancy = await getSlotOccupancy(slot.id, slot.date, slot.start_time, slot.end_time);
    const staff = await getStaffForSlot(slot.id);
    const appointments = await getAppointmentsForSlot(slot.id, slot.date, slot.start_time, slot.end_time);
    const remaining = Math.max(0, slot.capacity - occupancy.total_people);

    success(res, {
      id: slot.id,
      festival_schedule_id: slot.festival_schedule_id,
      festival_name: slot.festival_name,
      festival_type: slot.festival_type,
      date: slot.date,
      start_time: slot.start_time,
      end_time: slot.end_time,
      capacity: slot.capacity,
      booked_people: occupancy.total_people,
      appointment_count: occupancy.appointment_count,
      remaining: remaining,
      is_full: remaining === 0,
      remark: slot.remark,
      staff: staff,
      appointments: appointments
    }, '时段详情查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, festivalScheduleCreateValidation, async (req, res) => {
  try {
    const { festival_name, festival_type = 'custom', start_date, end_date, description, time_slots } = req.body;

    if (moment(start_date).isAfter(end_date)) {
      return error(res, '开始日期不能晚于结束日期', 400);
    }

    const result = await runInTransaction(async () => {
      const scheduleResult = await run(
        `INSERT INTO festival_schedules (festival_name, festival_type, start_date, end_date, description, created_by, created_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [festival_name, festival_type, start_date, end_date, description, req.user.id, req.user.name]
      );

      const scheduleId = scheduleResult.id;

      for (const slot of time_slots) {
        if (moment(slot.date).isBefore(start_date) || moment(slot.date).isAfter(end_date)) {
          throw new Error(`时段日期 ${slot.date} 不在节日日期范围内 [${start_date}, ${end_date}]`);
        }

        const slotResult = await run(
          `INSERT INTO festival_time_slots (festival_schedule_id, date, start_time, end_time, capacity, remark)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [scheduleId, slot.date, slot.start_time, slot.end_time, slot.capacity, slot.remark || null]
        );

        if (slot.staff && slot.staff.length > 0) {
          for (const staff of slot.staff) {
            const user = await get('SELECT id, name FROM users WHERE id = ?', [staff.user_id]);
            if (!user) {
              throw new Error(`用户ID ${staff.user_id} 不存在`);
            }
            await run(
              `INSERT INTO festival_staff_schedules (time_slot_id, user_id, user_name, duty)
               VALUES (?, ?, ?, ?)`,
              [slotResult.id, staff.user_id, user.name, staff.duty || null]
            );
          }
        }
      }

      return { id: scheduleId };
    });

    const summary = generateSummary(RESOURCE_TYPES.FESTIVAL_SCHEDULE, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.FESTIVAL_SCHEDULE, result.id, ACTIONS.CREATE, summary);

    success(res, result, '节日排班创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, festivalScheduleUpdateValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { festival_name, festival_type, start_date, end_date, status, description } = req.body;

    const existing = await get('SELECT * FROM festival_schedules WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '节日排班不存在', 404);
    }

    const updateFields = [];
    const updateParams = [];

    if (festival_name !== undefined) {
      updateFields.push('festival_name = ?');
      updateParams.push(festival_name);
    }
    if (festival_type !== undefined) {
      updateFields.push('festival_type = ?');
      updateParams.push(festival_type);
    }
    if (start_date !== undefined) {
      updateFields.push('start_date = ?');
      updateParams.push(start_date);
    }
    if (end_date !== undefined) {
      updateFields.push('end_date = ?');
      updateParams.push(end_date);
    }
    if (status !== undefined) {
      updateFields.push('status = ?');
      updateParams.push(status);
    }
    if (description !== undefined) {
      updateFields.push('description = ?');
      updateParams.push(description);
    }

    if (start_date && end_date && moment(start_date).isAfter(end_date)) {
      return error(res, '开始日期不能晚于结束日期', 400);
    }

    updateParams.push(id);

    await run(`UPDATE festival_schedules SET ${updateFields.join(', ')} WHERE id = ?`, updateParams);

    const newData = { festival_name, festival_type, start_date, end_date, status, description };
    const summary = generateSummary(RESOURCE_TYPES.FESTIVAL_SCHEDULE, ACTIONS.UPDATE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.FESTIVAL_SCHEDULE, id, ACTIONS.UPDATE, summary);

    success(res, null, '节日排班更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await get('SELECT * FROM festival_schedules WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '节日排班不存在', 404);
    }

    await runInTransaction(async () => {
      const slotIds = await all('SELECT id FROM festival_time_slots WHERE festival_schedule_id = ?', [id]);

      for (const slot of slotIds) {
        await run('DELETE FROM festival_staff_schedules WHERE time_slot_id = ?', [slot.id]);
      }

      await run('DELETE FROM festival_time_slots WHERE festival_schedule_id = ?', [id]);
      await run('DELETE FROM festival_schedules WHERE id = ?', [id]);
    });

    const summary = generateSummary(RESOURCE_TYPES.FESTIVAL_SCHEDULE, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.FESTIVAL_SCHEDULE, id, ACTIONS.DELETE, summary);

    success(res, null, '节日排班删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/slots', authenticate, festivalTimeSlotCreateValidation, async (req, res) => {
  try {
    const { festival_schedule_id, date, start_time, end_time, capacity, remark } = req.body;

    const schedule = await get('SELECT * FROM festival_schedules WHERE id = ?', [festival_schedule_id]);
    if (!schedule) {
      return error(res, '节日排班不存在', 404);
    }

    if (moment(date).isBefore(schedule.start_date) || moment(date).isAfter(schedule.end_date)) {
      return error(res, `时段日期不在节日日期范围内 [${schedule.start_date}, ${schedule.end_date}]`, 400);
    }

    const existingSlot = await get(`
      SELECT id FROM festival_time_slots
      WHERE festival_schedule_id = ? AND date = ? AND start_time = ? AND end_time = ?
    `, [festival_schedule_id, date, start_time, end_time]);

    if (existingSlot) {
      return error(res, '该时段已存在', 400);
    }

    const result = await run(
      `INSERT INTO festival_time_slots (festival_schedule_id, date, start_time, end_time, capacity, remark)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [festival_schedule_id, date, start_time, end_time, capacity, remark]
    );

    const summary = generateSummary(RESOURCE_TYPES.FESTIVAL_TIME_SLOT, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.FESTIVAL_TIME_SLOT, result.id, ACTIONS.CREATE, summary);

    success(res, { id: result.id }, '时段创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/slots/:slotId', authenticate, slotIdParamValidation, festivalTimeSlotUpdateValidation, async (req, res) => {
  try {
    const { slotId } = req.params;
    const { capacity, remark } = req.body;

    const existing = await get('SELECT * FROM festival_time_slots WHERE id = ?', [slotId]);
    if (!existing) {
      return error(res, '时段不存在', 404);
    }

    const updateFields = [];
    const updateParams = [];

    if (capacity !== undefined) {
      updateFields.push('capacity = ?');
      updateParams.push(capacity);
    }
    if (remark !== undefined) {
      updateFields.push('remark = ?');
      updateParams.push(remark);
    }

    updateParams.push(slotId);

    await run(`UPDATE festival_time_slots SET ${updateFields.join(', ')} WHERE id = ?`, updateParams);

    const newData = { capacity, remark };
    const summary = generateSummary(RESOURCE_TYPES.FESTIVAL_TIME_SLOT, ACTIONS.UPDATE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.FESTIVAL_TIME_SLOT, slotId, ACTIONS.UPDATE, summary);

    success(res, null, '时段更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/slots/:slotId', authenticate, slotIdParamValidation, async (req, res) => {
  try {
    const { slotId } = req.params;

    const existing = await get('SELECT * FROM festival_time_slots WHERE id = ?', [slotId]);
    if (!existing) {
      return error(res, '时段不存在', 404);
    }

    await runInTransaction(async () => {
      await run('DELETE FROM festival_staff_schedules WHERE time_slot_id = ?', [slotId]);
      await run('DELETE FROM festival_time_slots WHERE id = ?', [slotId]);
    });

    const summary = generateSummary(RESOURCE_TYPES.FESTIVAL_TIME_SLOT, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.FESTIVAL_TIME_SLOT, slotId, ACTIONS.DELETE, summary);

    success(res, null, '时段删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/staff', authenticate, festivalStaffScheduleCreateValidation, async (req, res) => {
  try {
    const { time_slot_id, user_id, duty } = req.body;

    const slot = await get('SELECT id FROM festival_time_slots WHERE id = ?', [time_slot_id]);
    if (!slot) {
      return error(res, '时段不存在', 404);
    }

    const user = await get('SELECT id, name FROM users WHERE id = ?', [user_id]);
    if (!user) {
      return error(res, '用户不存在', 404);
    }

    const existingStaff = await get(`
      SELECT id FROM festival_staff_schedules WHERE time_slot_id = ? AND user_id = ?
    `, [time_slot_id, user_id]);

    if (existingStaff) {
      return error(res, '该工作人员已在此时段排班', 400);
    }

    const result = await run(
      `INSERT INTO festival_staff_schedules (time_slot_id, user_id, user_name, duty)
       VALUES (?, ?, ?, ?)`,
      [time_slot_id, user_id, user.name, duty]
    );

    const summary = generateSummary(RESOURCE_TYPES.FESTIVAL_STAFF_SCHEDULE, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.FESTIVAL_STAFF_SCHEDULE, result.id, ACTIONS.CREATE, summary);

    success(res, { id: result.id }, '工作人员排班成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/staff/:staffId', authenticate, staffIdParamValidation, async (req, res) => {
  try {
    const { staffId } = req.params;

    const existing = await get('SELECT * FROM festival_staff_schedules WHERE id = ?', [staffId]);
    if (!existing) {
      return error(res, '排班记录不存在', 404);
    }

    await run('DELETE FROM festival_staff_schedules WHERE id = ?', [staffId]);

    const summary = generateSummary(RESOURCE_TYPES.FESTIVAL_STAFF_SCHEDULE, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.FESTIVAL_STAFF_SCHEDULE, staffId, ACTIONS.DELETE, summary);

    success(res, null, '排班已取消');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/stats/overview', authenticate, async (req, res) => {
  try {
    const { start_date = moment().format('YYYY-MM-DD'), end_date = moment().add(30, 'days').format('YYYY-MM-DD') } = req.query;

    const activeScheduleCount = await get(`
      SELECT COUNT(*) as count FROM festival_schedules WHERE status = 'active'
    `);

    const upcomingSchedules = await all(`
      SELECT fs.*,
             (SELECT COUNT(*) FROM festival_time_slots fts WHERE fts.festival_schedule_id = fs.id) as slot_count
      FROM festival_schedules fs
      WHERE fs.status = 'active'
        AND fs.end_date >= ?
        AND fs.start_date <= ?
      ORDER BY fs.start_date ASC
    `, [start_date, end_date]);

    const totalCapacity = await get(`
      SELECT COALESCE(SUM(fts.capacity), 0) as total_capacity,
             COUNT(*) as total_slots
      FROM festival_time_slots fts
      INNER JOIN festival_schedules fs ON fts.festival_schedule_id = fs.id
      WHERE fs.status = 'active'
        AND fts.date >= ?
        AND fts.date <= ?
    `, [start_date, end_date]);

    const slotIds = await all(`
      SELECT fts.id, fts.date, fts.start_time, fts.end_time, fts.capacity
      FROM festival_time_slots fts
      INNER JOIN festival_schedules fs ON fts.festival_schedule_id = fs.id
      WHERE fs.status = 'active'
        AND fts.date >= ?
        AND fts.date <= ?
    `, [start_date, end_date]);

    let totalBooked = 0;
    let totalAppointments = 0;
    let fullSlots = 0;

    for (const slot of slotIds) {
      const occupancy = await getSlotOccupancy(slot.id, slot.date, slot.start_time, slot.end_time);
      totalBooked += occupancy.total_people;
      totalAppointments += occupancy.appointment_count;
      if (occupancy.total_people >= slot.capacity) {
        fullSlots++;
      }
    }

    success(res, {
      date_range: { start_date, end_date },
      active_schedule_count: activeScheduleCount.count || 0,
      upcoming_schedules: upcomingSchedules,
      capacity_stats: {
        total_slots: totalCapacity.total_slots || 0,
        total_capacity: totalCapacity.total_capacity || 0,
        total_booked: totalBooked,
        total_appointments: totalAppointments,
        total_remaining: Math.max(0, (totalCapacity.total_capacity || 0) - totalBooked),
        full_slots: fullSlots,
        booking_rate: totalCapacity.total_capacity > 0 ? ((totalBooked / totalCapacity.total_capacity) * 100).toFixed(1) : '0'
      }
    }, '预约占用统计查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
