const { get, run, all } = require('./dbHelper');

const findMatchingTimeSlot = async (date, time) => {
  if (time) {
    const slot = await get(`
      SELECT fts.*,
             fs.status as festival_status
      FROM festival_time_slots fts
      INNER JOIN festival_schedules fs ON fts.festival_schedule_id = fs.id
      WHERE fs.status = 'active'
        AND fts.date = ?
        AND fts.start_time <= ?
        AND fts.end_time > ?
      ORDER BY fts.start_time ASC
      LIMIT 1
    `, [date, time, time]);

    return slot || null;
  }

  const slots = await all(`
    SELECT fts.*,
           fs.status as festival_status
    FROM festival_time_slots fts
    INNER JOIN festival_schedules fs ON fts.festival_schedule_id = fs.id
    WHERE fs.status = 'active'
      AND fts.date = ?
    ORDER BY fts.start_time ASC
  `, [date]);

  if (!slots || slots.length === 0) {
    return null;
  }

  let bestSlot = null;
  let maxRemaining = -1;

  for (const slot of slots) {
    const occupancy = await getSlotOccupancy(slot.id, slot.date, slot.start_time, slot.end_time);
    const remaining = slot.capacity - occupancy.total_people;
    if (remaining > maxRemaining) {
      maxRemaining = remaining;
      bestSlot = slot;
    }
  }

  return bestSlot;
};

const getTimeSlotById = async (slotId) => {
  const slot = await get(`
    SELECT fts.*,
           fs.status as festival_status,
           fs.festival_name,
           fs.festival_type
    FROM festival_time_slots fts
    INNER JOIN festival_schedules fs ON fts.festival_schedule_id = fs.id
    WHERE fs.status = 'active'
      AND fts.id = ?
  `, [slotId]);

  return slot || null;
};

const hasFestivalSlotsOnDate = async (date) => {
  const count = await get(`
    SELECT COUNT(*) as count
    FROM festival_time_slots fts
    INNER JOIN festival_schedules fs ON fts.festival_schedule_id = fs.id
    WHERE fs.status = 'active'
      AND fts.date = ?
  `, [date]);

  return count && count.count > 0;
};

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
    return result;
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

const checkCapacity = async (date, time, numberOfPeople = 1) => {
  const slot = await findMatchingTimeSlot(date, time);
  
  if (!slot) {
    return {
      hasSlot: false,
      isAvailable: true,
      remaining: Infinity,
      slot: null
    };
  }

  const occupancy = await getSlotOccupancy(slot.id, slot.date, slot.start_time, slot.end_time);
  const remaining = slot.capacity - occupancy.total_people;

  return {
    hasSlot: true,
    isAvailable: remaining >= numberOfPeople,
    capacity: slot.capacity,
    booked: occupancy.total_people,
    remaining: remaining,
    slot: slot,
    autoAssignedTime: !time ? slot.start_time : null
  };
};

const linkAppointmentToSlot = async (appointmentId, date, time) => {
  const slot = await findMatchingTimeSlot(date, time);
  
  if (!slot) {
    return null;
  }

  const existingLink = await get(`
    SELECT id FROM festival_appointment_slots 
    WHERE appointment_id = ?
  `, [appointmentId]);

  if (existingLink) {
    await run('DELETE FROM festival_appointment_slots WHERE appointment_id = ?', [appointmentId]);
  }

  const result = await run(
    'INSERT INTO festival_appointment_slots (appointment_id, time_slot_id) VALUES (?, ?)',
    [appointmentId, slot.id]
  );

  if (!time) {
    await run('UPDATE appointments SET appointment_time = ? WHERE id = ?', [slot.start_time, appointmentId]);
  }

  return {
    linkId: result.id,
    slotId: slot.id,
    slot: slot,
    autoAssignedTime: !time ? slot.start_time : null
  };
};

const unlinkAppointmentFromSlot = async (appointmentId) => {
  const result = await run(
    'DELETE FROM festival_appointment_slots WHERE appointment_id = ?',
    [appointmentId]
  );

  return result.changes > 0;
};

const linkAppointmentToSlotById = async (appointmentId, slotId) => {
  const slot = await getTimeSlotById(slotId);

  if (!slot) {
    return null;
  }

  const existingLink = await get(`
    SELECT id FROM festival_appointment_slots
    WHERE appointment_id = ?
  `, [appointmentId]);

  if (existingLink) {
    await run('DELETE FROM festival_appointment_slots WHERE appointment_id = ?', [appointmentId]);
  }

  const result = await run(
    'INSERT INTO festival_appointment_slots (appointment_id, time_slot_id) VALUES (?, ?)',
    [appointmentId, slotId]
  );

  return {
    linkId: result.id,
    slotId: slotId,
    slot: slot
  };
};

module.exports = {
  findMatchingTimeSlot,
  getTimeSlotById,
  getSlotOccupancy,
  checkCapacity,
  linkAppointmentToSlot,
  linkAppointmentToSlotById,
  unlinkAppointmentFromSlot,
  hasFestivalSlotsOnDate
};
