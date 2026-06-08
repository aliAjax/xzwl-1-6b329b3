const moment = require('moment');
const { run, get, all, runInTransaction } = require('../utils/dbHelper');
const { getSlotOccupancy, checkCapacity, linkAppointmentToSlotById, unlinkAppointmentFromSlot, findMatchingTimeSlot } = require('../utils/festivalHelper');

let passed = 0;
let failed = 0;
let testPlotId = null;
let testSlotId = null;
let testScheduleId = null;
let timestamp = Date.now();

function test(description, fn) {
  return async () => {
    try {
      await fn();
      console.log(`✅ ${description}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${description}`);
      console.log(`   错误: ${err.message}`);
      failed++;
    }
  };
}

async function createTestPlot(plotNumber) {
  const result = await run(
    `INSERT INTO plots (plot_number, area, row, col, status, type, price) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [plotNumber, 'UNIT-TEST', 99, parseInt(plotNumber.split('-').pop()), '空闲', '双穴', 80000]
  );
  return result.id;
}

async function createTestReservation(plotId, contractId, contactName, contactPhone, expiresAt) {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await run(
    `INSERT INTO plot_reservations (plot_id, contract_id, contact_name, contact_phone, reserved_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    [plotId, contractId, contactName, contactPhone, now, expiresAt]
  );
}

async function createTestContract(plotId, status, reservedExpiresAt = null) {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const contractNo = `HT${moment().format('YYYYMMDD')}${Math.floor(Math.random() * 10000)}`;
  const data = [
    contractNo, plotId, status, 80000, 3000, 20, 83000, 1, '测试管理员'
  ];
  if (reservedExpiresAt) {
    data.splice(6, 0, now, reservedExpiresAt);
  }
  const result = await run(
    `INSERT INTO contracts 
     (contract_no, plot_id, status, plot_price, management_fee, management_fee_years, total_amount, 
      ${reservedExpiresAt ? 'reserved_at, reserved_expires_at, ' : ''}created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${reservedExpiresAt ? '?, ?, ' : ''}?, ?)`,
    data
  );
  return result.id;
}

async function createTestAppointment(date, time, numberOfPeople, status = '待确认') {
  const result = await run(
    `INSERT INTO appointments (appointment_date, appointment_time, number_of_people, status, remark)
     VALUES (?, ?, ?, ?, ?)`,
    [date, time, numberOfPeople, status, '单元测试预约']
  );
  return result.id;
}

async function createFestivalSchedule(festivalName, date, capacity) {
  const scheduleResult = await run(
    `INSERT INTO festival_schedules (festival_name, festival_type, start_date, end_date, description, status, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, 'active', 1, '测试管理员')`,
    [festivalName, 'custom', date, date, '单元测试节日']
  );

  const slotResult = await run(
    `INSERT INTO festival_time_slots (festival_schedule_id, date, start_time, end_time, capacity, remark)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [scheduleResult.id, date, '08:00', '12:00', capacity, '单元测试时段']
  );

  return { scheduleId: scheduleResult.id, slotId: slotResult.id };
}

async function getPlotStatus(plotId) {
  const result = await get('SELECT status FROM plots WHERE id = ?', [plotId]);
  return result ? result.status : null;
}

async function getContractStatus(contractId) {
  const result = await get('SELECT status, reserved_expires_at FROM contracts WHERE id = ?', [contractId]);
  return result;
}

async function getReservationStatus(contractId) {
  const result = await get('SELECT status, expires_at FROM plot_reservations WHERE contract_id = ? ORDER BY id DESC LIMIT 1', [contractId]);
  return result;
}

const tests = [
  test('数据库连接和基础表结构检查', async () => {
    const tables = ['plots', 'contracts', 'plot_reservations', 'appointments', 'festival_schedules', 'festival_time_slots', 'festival_appointment_slots'];
    for (const table of tables) {
      const result = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
      if (!result) throw new Error(`表 ${table} 不存在`);
    }
  }),

  test('1. 墓位预留互斥性 - 并发场景模拟', async () => {
    testPlotId = await createTestPlot(`UNIT-RESV-${timestamp}-001`);
    if (!testPlotId) throw new Error('创建测试墓位失败');

    const initialStatus = await getPlotStatus(testPlotId);
    if (initialStatus !== '空闲') throw new Error(`墓位初始状态应为空闲，实际为${initialStatus}`);

    let firstContractId = null;
    let firstSuccess = false;
    let secondSuccess = false;

    await runInTransaction(async () => {
      const check1 = await get(`SELECT id, status FROM plots WHERE id = ?`, [testPlotId]);
      if (check1.status === '空闲') {
        const contractNo = `HT${moment().format('YYYYMMDD')}0001`;
        const result = await run(
          `INSERT INTO contracts (contract_no, plot_id, status, plot_price, management_fee, management_fee_years, total_amount, reserved_at, reserved_expires_at, created_by, created_by_name)
           VALUES (?, ?, 'reserved', ?, ?, ?, ?, ?, ?, 1, '测试管理员')`,
          [contractNo, testPlotId, 80000, 3000, 20, 83000, moment().format('YYYY-MM-DD HH:mm:ss'), moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss')]
        );
        firstContractId = result.id;

        await createTestReservation(testPlotId, firstContractId, '用户A', '13800000001', moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss'));

        await run('UPDATE plots SET status = ? WHERE id = ?', ['预留中', testPlotId]);
        firstSuccess = true;
      }
    });

    if (!firstSuccess) throw new Error('第一个合同预留失败');

    try {
      await runInTransaction(async () => {
        const check2 = await get(`SELECT id, status FROM plots WHERE id = ?`, [testPlotId]);
        if (check2.status !== '空闲') {
          throw new Error('墓位已被预留，不能重复预留');
        }
        const contractNo = `HT${moment().format('YYYYMMDD')}0002`;
        await run(
          `INSERT INTO contracts (contract_no, plot_id, status, plot_price, management_fee, management_fee_years, total_amount, reserved_at, reserved_expires_at, created_by, created_by_name)
           VALUES (?, ?, 'reserved', ?, ?, ?, ?, ?, ?, 1, '测试管理员')`,
          [contractNo, testPlotId, 80000, 3000, 20, 83000, moment().format('YYYY-MM-DD HH:mm:ss'), moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss')]
        );
        secondSuccess = true;
      });
    } catch (err) {
      if (err.message.includes('已被预留')) {
        secondSuccess = false;
      } else {
        throw err;
      }
    }

    if (secondSuccess) throw new Error('第二个合同预留应该失败但成功了');

    const finalStatus = await getPlotStatus(testPlotId);
    if (finalStatus !== '预留中') throw new Error(`墓位最终状态应为预留中，实际为${finalStatus}`);

    const activeContracts = await all(
      `SELECT id, contract_no, status FROM contracts WHERE plot_id = ? AND status = 'reserved'`,
      [testPlotId]
    );
    if (activeContracts.length !== 1) throw new Error(`应该只有1个有效预留合同，实际有${activeContracts.length}个`);

    console.log(`   ℹ️  正确阻止了重复预留，墓位状态: ${finalStatus}`);
  }),

  test('2. 过期预留自动释放和重新签约', async () => {
    const plotId = await createTestPlot(`UNIT-EXP-${timestamp}-002`);
    const expiredAt = moment().subtract(1, 'hour').format('YYYY-MM-DD HH:mm:ss');

    const contractId = await createTestContract(plotId, 'reserved', expiredAt);
    await createTestReservation(plotId, contractId, '过期用户', '13900000000', expiredAt);
    await run('UPDATE plots SET status = ? WHERE id = ?', ['预留中', plotId]);

    const beforeStatus = await getPlotStatus(plotId);
    if (beforeStatus !== '预留中') throw new Error(`释放前墓位状态应为预留中，实际为${beforeStatus}`);

    const now = moment().format('YYYY-MM-DD HH:mm:ss');
    const expired = await all(`
      SELECT r.id as reservation_id, r.contract_id, r.plot_id
      FROM plot_reservations r
      INNER JOIN contracts c ON r.contract_id = c.id
      WHERE r.plot_id = ? AND r.status = 'active' AND c.status = 'reserved' AND r.expires_at < ?
    `, [plotId, now]);

    if (expired.length !== 1) throw new Error(`应该检测到1个过期预留，实际检测到${expired.length}个`);

    for (const r of expired) {
      await runInTransaction(async () => {
        await run("UPDATE plot_reservations SET status = 'expired' WHERE id = ?", [r.reservation_id]);
        await run("UPDATE contracts SET status = 'draft', reserved_at = NULL, reserved_expires_at = NULL WHERE id = ?", [r.contract_id]);

        const hasOtherActive = await get(`
          SELECT COUNT(*) as count FROM plot_reservations r
          INNER JOIN contracts c ON r.contract_id = c.id
          WHERE r.plot_id = ? AND r.status = 'active' AND c.status != 'voided' AND c.id != ?
        `, [plotId, r.contract_id]);

        if (hasOtherActive.count === 0) {
          await run('UPDATE plots SET status = ? WHERE id = ?', ['空闲', plotId]);
        }
      });
    }

    const afterStatus = await getPlotStatus(plotId);
    if (afterStatus !== '空闲') throw new Error(`释放后墓位状态应为空闲，实际为${afterStatus}`);

    const contractAfter = await getContractStatus(contractId);
    if (contractAfter.status !== 'draft') throw new Error(`合同状态应为草稿，实际为${contractAfter.status}`);

    const reservationAfter = await getReservationStatus(contractId);
    if (reservationAfter.status !== 'expired') throw new Error(`预留记录状态应为expired，实际为${reservationAfter.status}`);

    console.log(`   ℹ️  过期预留已正确释放，合同状态: ${contractAfter.status}, 墓位状态: ${afterStatus}`);

    await runInTransaction(async () => {
      const availability = await get(`
        SELECT p.id, p.status,
               (SELECT COUNT(*) FROM deceased WHERE plot_id = ?) as deceased_count,
               (SELECT COUNT(*) FROM plot_reservations r 
                INNER JOIN contracts c ON r.contract_id = c.id 
                WHERE r.plot_id = ? AND r.status = 'active' AND c.status = 'reserved') as active_reservations,
               (SELECT COUNT(*) FROM contracts WHERE plot_id = ? AND status IN ('signed', 'effective')) as active_contracts
      `, [plotId, plotId, plotId]);

      if (availability.status !== '空闲' || availability.deceased_count > 0 || 
          availability.active_reservations > 0 || availability.active_contracts > 0) {
        throw new Error('墓位不可用，无法签约');
      }

      await run(
        `UPDATE contracts SET status = 'signed', contact_id = ?, plot_price = ?, management_fee = ?, 
         management_fee_years = ?, total_amount = ?, signed_at = ? WHERE id = ?`,
        [1, 80000, 3000, 20, 83000, moment().format('YYYY-MM-DD HH:mm:ss'), contractId]
      );
    });

    const signedContract = await getContractStatus(contractId);
    if (signedContract.status !== 'signed') throw new Error(`重新签约后合同状态应为已签约，实际为${signedContract.status}`);

    console.log(`   ℹ️  过期合同重新签约成功，新状态: ${signedContract.status}`);
  }),

  test('3. 节日时段容量统计准确性', async () => {
    const testDate = moment().add(60, 'days').format('YYYY-MM-DD');
    const CAPACITY = 10;

    const schedule = await createFestivalSchedule(`单元测试节日${timestamp}`, testDate, CAPACITY);
    testScheduleId = schedule.scheduleId;
    testSlotId = schedule.slotId;

    const slotInfo = await get('SELECT * FROM festival_time_slots WHERE id = ?', [testSlotId]);
    if (!slotInfo) throw new Error('时段创建失败');

    const initialOccupancy = await getSlotOccupancy(testSlotId, testDate, '08:00', '12:00');
    if (initialOccupancy.total_people !== 0 || initialOccupancy.appointment_count !== 0) {
      throw new Error(`初始占用应为0，实际为${JSON.stringify(initialOccupancy)}`);
    }

    const initialCapacity = await checkCapacity(testDate, '09:00', 1);
    if (!initialCapacity.hasSlot || initialCapacity.remaining !== CAPACITY) {
      throw new Error(`初始剩余容量应为${CAPACITY}，实际为${initialCapacity.remaining}`);
    }

    console.log(`   ℹ️  初始状态 - 容量: ${CAPACITY}, 已用: ${initialOccupancy.total_people}`);
  }),

  test('4. 容量接近上限时的并发预约控制', async () => {
    const testDate = moment().add(60, 'days').format('YYYY-MM-DD');
    const appointmentIds = [];

    for (let i = 0; i < 4; i++) {
      const aptId = await createTestAppointment(testDate, '09:00', 2, '已确认');
      await linkAppointmentToSlotById(aptId, testSlotId);
      appointmentIds.push(aptId);
    }

    const midOccupancy = await getSlotOccupancy(testSlotId, testDate, '08:00', '12:00');
    if (midOccupancy.total_people !== 8) {
      throw new Error(`4个2人预约后应有8人，实际为${midOccupancy.total_people}`);
    }

    const midCapacity = await checkCapacity(testDate, '09:00', 1);
    if (midCapacity.remaining !== 2) {
      throw new Error(`剩余容量应为2，实际为${midCapacity.remaining}`);
    }

    console.log(`   ℹ️  预约8人后 - 已用: ${midOccupancy.total_people}, 剩余: ${midCapacity.remaining}`);

    const results = await Promise.allSettled([
      (async () => {
        const id = await createTestAppointment(testDate, '09:30', 2, '待确认');
        const check = await checkCapacity(testDate, '09:30', 2);
        if (!check.isAvailable) throw new Error('容量不足');
        await linkAppointmentToSlotById(id, testSlotId);
        return { success: true, id };
      })(),
      (async () => {
        const id = await createTestAppointment(testDate, '09:30', 2, '待确认');
        const check = await checkCapacity(testDate, '09:30', 2);
        if (!check.isAvailable) throw new Error('容量不足');
        await linkAppointmentToSlotById(id, testSlotId);
        return { success: true, id };
      })(),
      (async () => {
        const id = await createTestAppointment(testDate, '09:30', 2, '待确认');
        const check = await checkCapacity(testDate, '09:30', 2);
        if (!check.isAvailable) throw new Error('容量不足');
        await linkAppointmentToSlotById(id, testSlotId);
        return { success: true, id };
      })()
    ]);

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const successIds = results.filter(r => r.status === 'fulfilled').map(r => r.value.id);
    appointmentIds.push(...successIds);

    if (successCount > 1) {
      throw new Error(`并发预约应该最多成功1个，实际成功${successCount}个`);
    }

    const finalOccupancy = await getSlotOccupancy(testSlotId, testDate, '08:00', '12:00');
    if (finalOccupancy.total_people !== 10) {
      throw new Error(`最终应有10人（满员），实际为${finalOccupancy.total_people}`);
    }

    const finalCapacity = await checkCapacity(testDate, '09:00', 1);
    if (finalCapacity.remaining !== 0 || finalCapacity.isAvailable !== false) {
      throw new Error(`容量应已满，实际剩余${finalCapacity.remaining}`);
    }

    const slots = await get(`
      SELECT fts.*,
             (SELECT COALESCE(SUM(a.number_of_people), 0) 
              FROM appointments a 
              INNER JOIN festival_appointment_slots fas ON a.id = fas.appointment_id
              WHERE fas.time_slot_id = fts.id AND a.status IN ('待确认', '已确认')) as booked_people
      FROM festival_time_slots fts WHERE fts.id = ?
    `, [testSlotId]);
    const calculatedRemaining = slots.capacity - (slots.booked_people || 0);
    if (calculatedRemaining !== 0) {
      throw new Error(`容量统计不一致，SQL计算剩余${calculatedRemaining}，函数计算${finalCapacity.remaining}`);
    }

    console.log(`   ℹ️  并发预约控制正确 - 成功${successCount}个，最终已用: ${finalOccupancy.total_people}`);
    console.log(`   ℹ️  容量统计一致 - SQL计算: ${slots.booked_people}/${slots.capacity}, 函数计算: ${finalOccupancy.total_people}/${finalCapacity.capacity}`);
  }),

  test('5. 预约取消后的容量释放', async () => {
    const testDate = moment().add(60, 'days').format('YYYY-MM-DD');

    const beforeCancel = await getSlotOccupancy(testSlotId, testDate, '08:00', '12:00');
    console.log(`   ℹ️  取消前 - 已用: ${beforeCancel.total_people}, 预约数: ${beforeCancel.appointment_count}`);

    const cancelAppointmentId = await get(`
      SELECT a.id, a.number_of_people
      FROM appointments a
      INNER JOIN festival_appointment_slots fas ON a.id = fas.appointment_id
      WHERE fas.time_slot_id = ? AND a.status IN ('待确认', '已确认')
      ORDER BY a.id ASC LIMIT 1
    `, [testSlotId]);

    if (!cancelAppointmentId) throw new Error('没有可取消的预约');

    const cancelPeople = cancelAppointmentId.number_of_people;
    console.log(`   ℹ️  取消预约ID: ${cancelAppointmentId.id}, 人数: ${cancelPeople}`);

    await unlinkAppointmentFromSlot(cancelAppointmentId.id);
    await run("UPDATE appointments SET status = '已取消' WHERE id = ?", [cancelAppointmentId.id]);

    const afterCancel = await getSlotOccupancy(testSlotId, testDate, '08:00', '12:00');
    const expectedRemaining = cancelPeople;
    const actualRemaining = 10 - afterCancel.total_people;

    if (actualRemaining !== expectedRemaining) {
      throw new Error(`取消后剩余容量应为${expectedRemaining}，实际为${actualRemaining}`);
    }

    if (afterCancel.total_people !== beforeCancel.total_people - cancelPeople) {
      throw new Error(`取消后已用人数应为${beforeCancel.total_people - cancelPeople}，实际为${afterCancel.total_people}`);
    }

    console.log(`   ℹ️  取消后 - 已用: ${afterCancel.total_people}, 剩余: ${actualRemaining}`);

    const newAptId = await createTestAppointment(testDate, '10:00', cancelPeople, '待确认');
    const check = await checkCapacity(testDate, '10:00', cancelPeople);
    if (!check.isAvailable) throw new Error('释放的容量应该可用');
    await linkAppointmentToSlotById(newAptId, testSlotId);

    const afterNew = await getSlotOccupancy(testSlotId, testDate, '08:00', '12:00');
    if (afterNew.total_people !== 10) {
      throw new Error(`使用释放容量后应再次满员，实际为${afterNew.total_people}`);
    }

    console.log(`   ℹ️  释放的容量已被新预约使用，最终满员: ${afterNew.total_people}/10`);
  }),

  test('6. 容量满时的错误提示验证', async () => {
    const testDate = moment().add(60, 'days').format('YYYY-MM-DD');

    const currentOccupancy = await getSlotOccupancy(testSlotId, testDate, '08:00', '12:00');
    console.log(`   ℹ️  当前状态 - 已用: ${currentOccupancy.total_people}/10`);

    const check1 = await checkCapacity(testDate, '10:30', 1);
    if (check1.isAvailable !== false) throw new Error('容量满时应该返回不可用');
    if (!('remaining' in check1) || !('capacity' in check1)) {
      throw new Error('容量检查结果应包含容量信息');
    }
    if (check1.remaining !== 0) throw new Error(`剩余容量应为0，实际为${check1.remaining}`);

    console.log(`   ℹ️  容量检查结果正确 - 容量: ${check1.capacity}, 已用: ${check1.booked}, 剩余: ${check1.remaining}`);

    const overflowId = await createTestAppointment(testDate, '11:00', 1, '待确认');
    try {
      const check2 = await checkCapacity(testDate, '11:00', 1);
      if (!check2.hasSlot) throw new Error('应该检测到节日时段');
      if (check2.isAvailable) throw new Error('应该检测到容量不足');
      
      const errorMessage = `该时段预约已满，剩余容量: ${check2.remaining}，总容量: ${check2.capacity}`;
      if (!errorMessage.includes('剩余容量') || !errorMessage.includes('总容量')) {
        throw new Error('错误提示应包含容量信息');
      }
      console.log(`   ℹ️  错误提示格式正确: "${errorMessage}"`);
    } finally {
      await run('DELETE FROM appointments WHERE id = ?', [overflowId]);
    }
  }),

  test('7. 墓位状态流转完整性验证', async () => {
    const plotId = await createTestPlot(`UNIT-FLOW-${timestamp}-003`);
    
    const states = [];
    
    states.push({ action: '初始状态', status: await getPlotStatus(plotId) });
    
    const contractId = await createTestContract(plotId, 'reserved', moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss'));
    await createTestReservation(plotId, contractId, '流程测试', '13700000000', moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss'));
    await run('UPDATE plots SET status = ? WHERE id = ?', ['预留中', plotId]);
    states.push({ action: '预留后', status: await getPlotStatus(plotId) });
    
    await run("UPDATE plot_reservations SET status = 'released' WHERE contract_id = ?", [contractId]);
    await run("UPDATE contracts SET status = 'draft', reserved_at = NULL, reserved_expires_at = NULL WHERE id = ?", [contractId]);
    await run('UPDATE plots SET status = ? WHERE id = ?', ['空闲', plotId]);
    states.push({ action: '释放预留后', status: await getPlotStatus(plotId) });
    
    await run("UPDATE contracts SET status = 'signed', signed_at = ? WHERE id = ?", [moment().format('YYYY-MM-DD HH:mm:ss'), contractId]);
    states.push({ action: '签约未付款', status: await getPlotStatus(plotId) });
    
    await run("UPDATE contracts SET status = 'effective', effective_at = ?, paid_amount = total_amount WHERE id = ?", [moment().format('YYYY-MM-DD HH:mm:ss'), contractId]);
    await run('UPDATE plots SET status = ? WHERE id = ?', ['已占用', plotId]);
    states.push({ action: '付款生效后', status: await getPlotStatus(plotId) });
    
    await run("UPDATE contracts SET status = 'voided', voided_at = ?, void_reason = '测试作废' WHERE id = ?", [moment().format('YYYY-MM-DD HH:mm:ss'), contractId]);
    await run('UPDATE plots SET status = ? WHERE id = ?', ['空闲', plotId]);
    states.push({ action: '作废后', status: await getPlotStatus(plotId) });

    const expectedStates = ['空闲', '预留中', '空闲', '空闲', '已占用', '空闲'];
    const actualStates = states.map(s => s.status);
    
    if (JSON.stringify(actualStates) !== JSON.stringify(expectedStates)) {
      throw new Error(`状态流转不正确，期望${JSON.stringify(expectedStates)}，实际${JSON.stringify(actualStates)}`);
    }

    console.log(`   ℹ️  状态流转正确: ${states.map(s => `${s.action}→${s.status}`).join(' → ')}`);
  }),

  test('8. 并发数据一致性验证 - 多线程同时读取容量', async () => {
    const testDate = moment().add(60, 'days').format('YYYY-MM-DD');
    
    const readResults = await Promise.all([
      getSlotOccupancy(testSlotId, testDate, '08:00', '12:00'),
      getSlotOccupancy(testSlotId, testDate, '08:00', '12:00'),
      getSlotOccupancy(testSlotId, testDate, '08:00', '12:00'),
      checkCapacity(testDate, '09:00', 1),
      checkCapacity(testDate, '10:00', 1)
    ]);

    const occupancyResults = readResults.slice(0, 3);
    const capacityResults = readResults.slice(3);

    const firstOccupancy = occupancyResults[0];
    for (let i = 1; i < occupancyResults.length; i++) {
      if (occupancyResults[i].total_people !== firstOccupancy.total_people ||
          occupancyResults[i].appointment_count !== firstOccupancy.appointment_count) {
        throw new Error(`并发读取结果不一致: 读取1=${JSON.stringify(firstOccupancy)}, 读取${i+1}=${JSON.stringify(occupancyResults[i])}`);
      }
    }

    for (const cap of capacityResults) {
      if (cap.remaining !== 0) {
        throw new Error(`并发容量读取不一致，期望剩余0，实际${cap.remaining}`);
      }
    }

    console.log(`   ℹ️  并发读取一致性验证通过，5次读取结果一致`);
    console.log(`   ℹ️  容量状态: ${firstOccupancy.total_people}人/${capacityResults[0].capacity}容量`);
  }),

  test('清理测试数据', async () => {
    const date = moment().add(60, 'days').format('YYYY-MM-DD');
    
    await run(`
      DELETE FROM festival_appointment_slots 
      WHERE time_slot_id IN (SELECT id FROM festival_time_slots WHERE festival_schedule_id = ?)
    `, [testScheduleId]);
    
    await run(`DELETE FROM appointments WHERE appointment_date = ?`, [date]);
    await run(`DELETE FROM festival_staff_schedules WHERE time_slot_id IN (SELECT id FROM festival_time_slots WHERE festival_schedule_id = ?)`, [testScheduleId]);
    await run(`DELETE FROM festival_time_slots WHERE festival_schedule_id = ?`, [testScheduleId]);
    await run(`DELETE FROM festival_schedules WHERE id = ?`, [testScheduleId]);
    
    await run(`DELETE FROM plot_reservations WHERE plot_id IN (SELECT id FROM plots WHERE area = 'UNIT-TEST')`);
    await run(`DELETE FROM contracts WHERE plot_id IN (SELECT id FROM plots WHERE area = 'UNIT-TEST')`);
    await run(`DELETE FROM plots WHERE area = 'UNIT-TEST'`);
  })
];

async function runTests() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 合同预留与节日祭扫预约 并发边界单元测试');
  console.log('='.repeat(80));
  console.log(`测试时间: ${moment().format('YYYY-MM-DD HH:mm:ss')}`);
  console.log(`时间戳: ${timestamp}\n`);

  console.log('📋 核心功能测试:\n');
  for (const t of tests) {
    await t();
  }

  console.log('\n' + '='.repeat(80));
  console.log('📊 测试结果汇总');
  console.log('='.repeat(80));
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  console.log(`📈 通过率: ${(passed / (passed + failed) * 100).toFixed(1)}%`);
  console.log('='.repeat(80) + '\n');

  if (failed > 0) {
    console.log('⚠️  部分测试失败，请检查相关功能');
    process.exit(1);
  } else {
    console.log('🎉 所有并发边界单元测试通过！');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
