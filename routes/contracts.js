const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery, runInTransaction } = require('../utils/dbHelper');
const { success, error, paginate, handleError } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const {
  contractCreateValidation,
  contractUpdateValidation,
  contractReserveValidation,
  contractSignValidation,
  contractPayValidation,
  contractVoidValidation,
  contractQueryValidation,
  idParamValidation
} = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');

const router = express.Router();

const CONTRACT_STATUSES = {
  DRAFT: 'draft',
  RESERVED: 'reserved',
  SIGNED: 'signed',
  EFFECTIVE: 'effective',
  VOIDED: 'voided'
};

const STATUS_NAMES = {
  draft: '草稿',
  reserved: '预留中',
  signed: '已签约',
  effective: '已生效',
  voided: '已作废'
};

const PLOT_STATUSES = {
  AVAILABLE: '空闲',
  RESERVED: '预留中',
  OCCUPIED: '已占用',
  MAINTENANCE: '维修中'
};

const generateContractNo = () => {
  const date = moment().format('YYYYMMDD');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `HT${date}${random}`;
};

const checkPlotAvailability = async (plotId, excludeContractId = null, excludeDeceasedId = null) => {
  const plot = await get('SELECT id, status FROM plots WHERE id = ?', [plotId]);
  if (!plot) {
    return { available: false, reason: '墓位不存在' };
  }

  if (plot.status === PLOT_STATUSES.MAINTENANCE) {
    return { available: false, reason: '墓位正在维修中' };
  }

  const deceasedParams = excludeDeceasedId ? [plotId, excludeDeceasedId] : [plotId];
  const occupyingDeceased = await get(`
    SELECT id, name 
    FROM deceased 
    WHERE plot_id = ? 
      ${excludeDeceasedId ? 'AND id != ?' : ''}
    LIMIT 1
  `, deceasedParams);
  if (occupyingDeceased) {
    return { 
      available: false, 
      reason: `墓位已被逝者"${occupyingDeceased.name}"占用`,
      occupied_by: 'deceased',
      occupant_id: occupyingDeceased.id,
      occupant_name: occupyingDeceased.name
    };
  }

  const activeReservation = await get(`
    SELECT r.id, r.expires_at, c.contract_no, c.id as contract_id
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    WHERE r.plot_id = ? 
      AND r.status = 'active' 
      AND c.status != 'voided'
      ${excludeContractId ? 'AND c.id != ?' : ''}
  `, excludeContractId ? [plotId, excludeContractId] : [plotId]);

  if (activeReservation) {
    if (moment(activeReservation.expires_at).isAfter(moment())) {
      return { 
        available: false, 
        reason: `墓位已被合同${activeReservation.contract_no}预留，有效期至${activeReservation.expires_at}`,
        occupied_by: 'reservation',
        contract_id: activeReservation.contract_id,
        contract_no: activeReservation.contract_no
      };
    }
  }

  const activeContract = await get(`
    SELECT id, contract_no, status, deceased_id
    FROM contracts 
    WHERE plot_id = ? 
      AND status IN ('reserved', 'signed', 'effective')
      ${excludeContractId ? 'AND id != ?' : ''}
    LIMIT 1
  `, excludeContractId ? [plotId, excludeContractId] : [plotId]);

  if (activeContract) {
    const contractDeceased = activeContract.deceased_id ? await get('SELECT name FROM deceased WHERE id = ?', [activeContract.deceased_id]) : null;
    return { 
      available: false, 
      reason: `墓位已关联${STATUS_NAMES[activeContract.status]}合同${activeContract.contract_no}${contractDeceased ? `，关联逝者：${contractDeceased.name}` : ''}`,
      occupied_by: 'contract',
      contract_id: activeContract.id,
      contract_no: activeContract.contract_no,
      contract_status: activeContract.status
    };
  }

  return { available: true, plot };
};

const logStatusChange = async (req, contractId, fromStatus, toStatus, remark = '') => {
  const operatorId = req.user?.id;
  const operatorName = req.user?.name || '系统';

  await run(
    'INSERT INTO contract_status_logs (contract_id, from_status, to_status, operator_id, operator_name, remark) VALUES (?, ?, ?, ?, ?, ?)',
    [contractId, fromStatus, toStatus, operatorId, operatorName, remark]
  );

  const summary = `合同状态变更: ${STATUS_NAMES[fromStatus]} → ${STATUS_NAMES[toStatus]}${remark ? `，原因: ${remark}` : ''}`;
  await logOperation(req, RESOURCE_TYPES.CONTRACT, contractId, ACTIONS.STATUS_CHANGE, summary);
};

const updatePlotStatus = async (plotId, status) => {
  await run('UPDATE plots SET status = ? WHERE id = ?', [status, plotId]);
};

const releasePlotReservation = async (plotId, contractId) => {
  await run(
    "UPDATE plot_reservations SET status = 'released' WHERE plot_id = ? AND contract_id = ?",
    [plotId, contractId]
  );
};

const checkAndReleaseExpiredReservations = async (plotId) => {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const expired = await all(`
    SELECT r.id, r.contract_id, r.plot_id
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    WHERE r.plot_id = ? 
      AND r.status = 'active' 
      AND c.status = 'reserved'
      AND r.expires_at < ?
  `, [plotId, now]);

  for (const r of expired) {
    await run("UPDATE plot_reservations SET status = 'expired' WHERE id = ?", [r.id]);
    await run("UPDATE contracts SET status = 'draft', reserved_at = NULL, reserved_expires_at = NULL WHERE id = ?", [r.contract_id]);
    
    const plot = await get('SELECT id, status FROM plots WHERE id = ?', [r.plot_id]);
    const hasOtherActive = await get(`
      SELECT COUNT(*) as count 
      FROM plot_reservations r
      INNER JOIN contracts c ON r.contract_id = c.id
      WHERE r.plot_id = ? AND r.status = 'active' AND c.status != 'voided'
    `, [r.plot_id]);
    
    if (hasOtherActive.count === 0 && plot.status === PLOT_STATUSES.RESERVED) {
      await updatePlotStatus(r.plot_id, PLOT_STATUSES.AVAILABLE);
    }
  }
};

const checkPlotAvailabilityInTransaction = async (plotId, excludeContractId = null, excludeDeceasedId = null) => {
  await run('BEGIN IMMEDIATE');
  
  try {
    const lockedPlot = await get('SELECT id, status FROM plots WHERE id = ?', [plotId]);
    if (!lockedPlot) {
      await run('ROLLBACK');
      return { available: false, reason: '墓位不存在' };
    }
    
    const availability = await checkPlotAvailability(plotId, excludeContractId, excludeDeceasedId);
    return { ...availability, _locked: true };
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  }
};

router.get('/check-plot-availability', authenticate, async (req, res) => {
  try {
    const { plot_id } = req.query;
    
    if (!plot_id) {
      return error(res, '请提供墓位ID', 400);
    }

    await checkAndReleaseExpiredReservations(plot_id);
    const result = await checkPlotAvailability(plot_id);
    
    success(res, result);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/', authenticate, contractQueryValidation, async (req, res) => {
  try {
    const { 
      page = 1, pageSize = 10, status = '', plot_id = '', 
      contact_id = '', keyword = '', start_date = '', end_date = '',
      expiring_within_days = ''
    } = req.query;

    let baseSql = `
      SELECT c.*,
             p.plot_number,
             p.area,
             p.status as plot_status,
             ct.name as contact_name,
             ct.phone as contact_phone,
             d.name as deceased_name,
             u.name as creator_name
      FROM contracts c
      LEFT JOIN plots p ON c.plot_id = p.id
      LEFT JOIN contacts ct ON c.contact_id = ct.id
      LEFT JOIN deceased d ON c.deceased_id = d.id
      LEFT JOIN users u ON c.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    const now = moment();
    
    if (expiring_within_days) {
      const cutoffDate = now.clone().add(parseInt(expiring_within_days), 'days').format('YYYY-MM-DD HH:mm:ss');
      baseSql += " AND c.status = 'reserved' AND c.reserved_expires_at <= ?";
      params.push(cutoffDate);
    } else if (status) {
      baseSql += ' AND c.status = ?';
      params.push(status);
    }

    if (plot_id) {
      baseSql += ' AND c.plot_id = ?';
      params.push(plot_id);
    }

    if (contact_id) {
      baseSql += ' AND c.contact_id = ?';
      params.push(contact_id);
    }

    if (keyword) {
      baseSql += ' AND (c.contract_no LIKE ? OR p.plot_number LIKE ? OR ct.name LIKE ? OR d.name LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    if (start_date) {
      baseSql += ' AND DATE(c.created_at) >= ?';
      params.push(start_date);
    }

    if (end_date) {
      baseSql += ' AND DATE(c.created_at) <= ?';
      params.push(end_date);
    }

    const result = await paginateQuery(baseSql, params, page, pageSize, 'c.created_at DESC');
    
    const dataWithStatusNames = result.data.map(item => {
      let days_remaining = null;
      let is_expired = null;
      
      if (item.status === 'reserved' && item.reserved_expires_at) {
        const expiresAt = moment(item.reserved_expires_at);
        const diffMs = expiresAt.diff(now);
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        days_remaining = Math.ceil(diffDays);
        is_expired = expiresAt.isBefore(now);
      }
      
      return {
        ...item,
        status_name: STATUS_NAMES[item.status] || item.status,
        days_remaining,
        is_expired
      };
    });

    paginate(res, dataWithStatusNames, result.total, page, pageSize);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/statistics', authenticate, async (req, res) => {
  try {
    const { year = moment().year() } = req.query;
    
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const statusStats = await get(`
      SELECT 
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft_count,
        SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) as reserved_count,
        SUM(CASE WHEN status = 'signed' THEN 1 ELSE 0 END) as signed_count,
        SUM(CASE WHEN status = 'effective' THEN 1 ELSE 0 END) as effective_count,
        SUM(CASE WHEN status = 'voided' THEN 1 ELSE 0 END) as voided_count,
        COUNT(*) as total_count
      FROM contracts
    `);

    const amountStats = await get(`
      SELECT 
        COALESCE(SUM(CASE WHEN status != 'voided' THEN plot_price ELSE 0 END), 0) as total_plot_price,
        COALESCE(SUM(CASE WHEN status != 'voided' THEN management_fee ELSE 0 END), 0) as total_management_fee,
        COALESCE(SUM(CASE WHEN status != 'voided' THEN total_amount ELSE 0 END), 0) as total_amount,
        COALESCE(SUM(CASE WHEN status != 'voided' THEN paid_amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN status != 'voided' THEN (total_amount - paid_amount) ELSE 0 END), 0) as total_unpaid
      FROM contracts
    `);

    const yearlyStats = await get(`
      SELECT 
        COUNT(*) as year_total,
        COALESCE(SUM(total_amount), 0) as year_total_amount,
        COALESCE(SUM(paid_amount), 0) as year_total_paid
      FROM contracts
      WHERE DATE(created_at) BETWEEN ? AND ?
    `, [yearStart, yearEnd]);

    const monthlyStats = await all(`
      SELECT 
        strftime('%m', created_at) as month,
        COUNT(*) as count,
        COALESCE(SUM(total_amount), 0) as total_amount,
        COALESCE(SUM(paid_amount), 0) as paid_amount
      FROM contracts
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY strftime('%m', created_at)
      ORDER BY month
    `, [yearStart, yearEnd]);

    const monthlyData = Array(12).fill(0).map((_, i) => {
      const month = String(i + 1).padStart(2, '0');
      const found = monthlyStats.find(m => m.month === month);
      return {
        month: `${i + 1}月`,
        monthNum: month,
        count: found ? found.count : 0,
        total_amount: found ? found.total_amount : 0,
        paid_amount: found ? found.paid_amount : 0
      };
    });

    const paymentStats = await get(`
      SELECT 
        COALESCE(SUM(CASE WHEN fee_category = '购墓款' THEN amount ELSE 0 END), 0) as total_plot_payment,
        COALESCE(SUM(CASE WHEN fee_category = '管理费' THEN amount ELSE 0 END), 0) as total_fee_payment,
        COUNT(*) as payment_count
      FROM payments
      WHERE fee_category IN ('购墓款', '管理费')
        AND status = '已缴'
        AND DATE(payment_date) BETWEEN ? AND ?
    `, [yearStart, yearEnd]);

    success(res, {
      year,
      byStatus: {
        draft: statusStats.draft_count || 0,
        reserved: statusStats.reserved_count || 0,
        signed: statusStats.signed_count || 0,
        effective: statusStats.effective_count || 0,
        voided: statusStats.voided_count || 0,
        total: statusStats.total_count || 0
      },
      amounts: {
        total_plot_price: amountStats.total_plot_price || 0,
        total_management_fee: amountStats.total_management_fee || 0,
        total_amount: amountStats.total_amount || 0,
        total_paid: amountStats.total_paid || 0,
        total_unpaid: amountStats.total_unpaid || 0
      },
      yearly: {
        total: yearlyStats.year_total || 0,
        total_amount: yearlyStats.year_total_amount || 0,
        total_paid: yearlyStats.year_total_paid || 0
      },
      monthly: monthlyData,
      payments: {
        total_plot_payment: paymentStats.total_plot_payment || 0,
        total_fee_payment: paymentStats.total_fee_payment || 0,
        total_count: paymentStats.payment_count || 0
      }
    }, '合同统计查询成功');
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await get(`
      SELECT c.*,
             p.plot_number,
             p.area,
             p.row,
             p.col,
             p.type as plot_type,
             p.price as plot_original_price,
             p.status as plot_status,
             ct.name as contact_name,
             ct.phone as contact_phone,
             ct.id_card as contact_id_card,
             ct.address as contact_address,
             ct.relationship as contact_relationship,
             d.name as deceased_name,
             d.gender as deceased_gender,
             d.birth_date as deceased_birth_date,
             d.death_date as deceased_death_date,
             d.interment_date as deceased_interment_date,
             u.name as creator_name
      FROM contracts c
      LEFT JOIN plots p ON c.plot_id = p.id
      LEFT JOIN contacts ct ON c.contact_id = ct.id
      LEFT JOIN deceased d ON c.deceased_id = d.id
      LEFT JOIN users u ON c.created_by = u.id
      WHERE c.id = ?
    `, [id]);

    if (!contract) {
      return error(res, '合同不存在', 404);
    }

    const feeItems = await all(`
      SELECT * FROM contract_fee_items 
      WHERE contract_id = ? 
      ORDER BY id
    `, [id]);

    const payments = await all(`
      SELECT * FROM payments 
      WHERE contract_id = ? 
      ORDER BY payment_date DESC, created_at DESC
    `, [id]);

    const statusLogs = await all(`
      SELECT l.*,
             u.name as operator_name
      FROM contract_status_logs l
      LEFT JOIN users u ON l.operator_id = u.id
      WHERE l.contract_id = ? 
      ORDER BY l.created_at DESC
    `, [id]);

    const reservation = await get(`
      SELECT * FROM plot_reservations 
      WHERE contract_id = ? 
      ORDER BY id DESC 
      LIMIT 1
    `, [id]);

    const statusLogsWithNames = statusLogs.map(log => ({
      ...log,
      from_status_name: STATUS_NAMES[log.from_status] || log.from_status,
      to_status_name: STATUS_NAMES[log.to_status] || log.to_status
    }));

    success(res, {
      ...contract,
      status_name: STATUS_NAMES[contract.status] || contract.status,
      fee_items: feeItems,
      payments,
      status_logs: statusLogsWithNames,
      reservation
    }, '合同详情查询成功');
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/', authenticate, contractCreateValidation, async (req, res) => {
  try {
    const { 
      plot_id, contact_id, deceased_id, 
      plot_price, management_fee, management_fee_years, 
      remark 
    } = req.body;

    const availability = await checkPlotAvailability(plot_id);
    if (!availability.available) {
      return error(res, availability.reason, 400);
    }

    const plot = availability.plot;
    const finalPlotPrice = plot_price !== undefined ? plot_price : (plot.price || 0);
    const finalManagementFee = management_fee || 0;
    const finalManagementFeeYears = management_fee_years || 0;
    const totalAmount = finalPlotPrice + finalManagementFee;

    const contractNo = generateContractNo();
    const createdBy = req.user?.id;
    const createdByName = req.user?.name || '未知';

    const result = await runInTransaction(async () => {
      const contractResult = await run(`
        INSERT INTO contracts (
          contract_no, plot_id, contact_id, deceased_id, status,
          plot_price, management_fee, management_fee_years, total_amount,
          remark, created_by, created_by_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        contractNo, plot_id, contact_id, deceased_id, CONTRACT_STATUSES.DRAFT,
        finalPlotPrice, finalManagementFee, finalManagementFeeYears, totalAmount,
        remark, createdBy, createdByName
      ]);

      const existingPayments = await all(`
        SELECT id, amount, fee_category, status, payment_date
        FROM payments 
        WHERE plot_id = ? 
          AND contract_id IS NULL
          AND status = '已缴'
        ORDER BY payment_date ASC
      `, [plot_id]);

      let linkedPaymentCount = 0;
      let linkedPaymentAmount = 0;
      let linkedPlotPayment = 0;
      let linkedFeePayment = 0;

      for (const payment of existingPayments) {
        const category = payment.fee_category || '管理费';
        let shouldLink = false;
        
        if (category === '购墓款' && finalPlotPrice > 0) {
          shouldLink = true;
          linkedPlotPayment += payment.amount;
        } else if (category === '管理费' && finalManagementFee > 0) {
          shouldLink = true;
          linkedFeePayment += payment.amount;
        } else if (!payment.fee_category && finalManagementFee > 0) {
          shouldLink = true;
          linkedFeePayment += payment.amount;
        }
        
        if (shouldLink) {
          await run('UPDATE payments SET contract_id = ? WHERE id = ?', [contractResult.id, payment.id]);
          linkedPaymentCount++;
          linkedPaymentAmount += payment.amount;
        }
      }

      if (linkedPaymentCount > 0) {
        await run(`
          UPDATE contracts SET 
            paid_amount = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [linkedPaymentAmount, contractResult.id]);
      }

      return {
        id: contractResult.id,
        contract_no: contractNo,
        linked_payments: {
          count: linkedPaymentCount,
          total_amount: linkedPaymentAmount,
          plot_payment: linkedPlotPayment,
          fee_payment: linkedFeePayment
        }
      };
    });

    const summary = generateSummary(RESOURCE_TYPES.CONTRACT, ACTIONS.CREATE, { 
      contract_no: contractNo, 
      plot_id,
      linked_payments: result.linked_payments
    });
    await logOperation(req, RESOURCE_TYPES.CONTRACT, result.id, ACTIONS.CREATE, summary);

    const message = result.linked_payments.count > 0 
      ? `合同草稿创建成功，已自动关联${result.linked_payments.count}条历史付款记录，共计${result.linked_payments.total_amount}元`
      : '合同草稿创建成功';

    success(res, { id: result.id, contract_no: result.contract_no, linked_payments: result.linked_payments }, message);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/reserve', authenticate, contractReserveValidation, async (req, res) => {
  try {
    const { 
      plot_id, contact_name, contact_phone, reserve_days = 7,
      plot_price, management_fee, management_fee_years
    } = req.body;

    await checkAndReleaseExpiredReservations(plot_id);

    const result = await runInTransaction(async () => {
      const lockCheck = await checkPlotAvailability(plot_id);
      if (!lockCheck.available) {
        throw new Error(lockCheck.reason);
      }
      const plot = await get('SELECT id, plot_number, price FROM plots WHERE id = ?', [plot_id]);
      const finalPlotPrice = plot_price !== undefined ? plot_price : (plot.price || 0);
      const finalManagementFee = management_fee || 0;
      const finalManagementFeeYears = management_fee_years || 0;
      const totalAmount = finalPlotPrice + finalManagementFee;

      const contractNo = generateContractNo();
      const createdBy = req.user?.id;
      const createdByName = req.user?.name || '未知';
      const now = moment();
      const expiresAt = now.clone().add(reserve_days, 'days').format('YYYY-MM-DD HH:mm:ss');
      const reservedAt = now.format('YYYY-MM-DD HH:mm:ss');

      const contractResult = await run(`
        INSERT INTO contracts (
          contract_no, plot_id, status,
          plot_price, management_fee, management_fee_years, total_amount,
          reserved_at, reserved_expires_at,
          created_by, created_by_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        contractNo, plot_id, CONTRACT_STATUSES.RESERVED,
        finalPlotPrice, finalManagementFee, finalManagementFeeYears, totalAmount,
        reservedAt, expiresAt,
        createdBy, createdByName
      ]);

      await run(`
        INSERT INTO plot_reservations (
          plot_id, contract_id, contact_name, contact_phone,
          reserved_at, expires_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'active')
      `, [
        plot_id, contractResult.id, contact_name, contact_phone,
        reservedAt, expiresAt
      ]);

      await updatePlotStatus(plot_id, PLOT_STATUSES.RESERVED);

      await logStatusChange(req, contractResult.id, CONTRACT_STATUSES.DRAFT, CONTRACT_STATUSES.RESERVED, `预留${reserve_days}天`);

      return { id: contractResult.id, contract_no: contractNo, reserved_at: reservedAt, expires_at: expiresAt };
    });

    success(res, result, '墓位预留成功');
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/:id', authenticate, idParamValidation, contractUpdateValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      contact_id, deceased_id, 
      plot_price, management_fee, management_fee_years, 
      remark 
    } = req.body;

    const existing = await get('SELECT * FROM contracts WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '合同不存在', 404);
    }

    if (existing.status === CONTRACT_STATUSES.EFFECTIVE || existing.status === CONTRACT_STATUSES.VOIDED) {
      return error(res, '已生效或已作废的合同不能修改', 400);
    }

    if (deceased_id && deceased_id !== existing.deceased_id) {
      const deceased = await get('SELECT id, plot_id FROM deceased WHERE id = ?', [deceased_id]);
      if (!deceased) {
        return error(res, '逝者信息不存在', 400);
      }
      if (deceased.plot_id && deceased.plot_id !== existing.plot_id) {
        return error(res, '该逝者已关联其他墓位', 400);
      }
    }

    const finalPlotPrice = plot_price !== undefined ? plot_price : existing.plot_price;
    const finalManagementFee = management_fee !== undefined ? management_fee : existing.management_fee;
    const finalManagementFeeYears = management_fee_years !== undefined ? management_fee_years : existing.management_fee_years;
    const totalAmount = finalPlotPrice + finalManagementFee;

    await run(`
      UPDATE contracts SET 
        contact_id = COALESCE(?, contact_id),
        deceased_id = COALESCE(?, deceased_id),
        plot_price = ?,
        management_fee = ?,
        management_fee_years = ?,
        total_amount = ?,
        remark = COALESCE(?, remark),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      contact_id, deceased_id,
      finalPlotPrice, finalManagementFee, finalManagementFeeYears, totalAmount,
      remark, id
    ]);

    const newData = { 
      contact_id, deceased_id, plot_price: finalPlotPrice, 
      management_fee: finalManagementFee, management_fee_years: finalManagementFeeYears,
      total_amount: totalAmount, remark 
    };
    const summary = generateSummary(RESOURCE_TYPES.CONTRACT, ACTIONS.UPDATE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.CONTRACT, id, ACTIONS.UPDATE, summary);

    success(res, null, '合同更新成功');
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:id/sign', authenticate, idParamValidation, contractSignValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      contact_id, deceased_id, 
      plot_price, management_fee, management_fee_years,
      fee_items = []
    } = req.body;

    const existing = await get('SELECT * FROM contracts WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '合同不存在', 404);
    }

    if (existing.status === CONTRACT_STATUSES.EFFECTIVE || existing.status === CONTRACT_STATUSES.VOIDED) {
      return error(res, '已生效或已作废的合同不能签约', 400);
    }

    if (deceased_id) {
      const deceased = await get('SELECT id, plot_id FROM deceased WHERE id = ?', [deceased_id]);
      if (!deceased) {
        return error(res, '逝者信息不存在', 400);
      }
      if (deceased.plot_id && deceased.plot_id !== existing.plot_id) {
        return error(res, '该逝者已关联其他墓位', 400);
      }
    }

    const result = await runInTransaction(async () => {
      const availability = await checkPlotAvailability(existing.plot_id, id, deceased_id);
      if (!availability.available) {
        throw new Error(availability.reason);
      }

      if (deceased_id) {
        const otherDeceased = await get(`
          SELECT id, name FROM deceased 
          WHERE plot_id = ? AND id != ?
          LIMIT 1
        `, [existing.plot_id, deceased_id]);
        if (otherDeceased) {
          throw new Error(`墓位已被逝者"${otherDeceased.name}"占用，不能重复签约`);
        }
      } else {
        const anyDeceased = await get(`
          SELECT id, name FROM deceased 
          WHERE plot_id = ?
          LIMIT 1
        `, [existing.plot_id]);
        if (anyDeceased) {
          throw new Error(`墓位已被逝者"${anyDeceased.name}"占用，不能重复签约`);
        }
      }
      const finalManagementFee = management_fee !== undefined ? management_fee : existing.management_fee;
      const finalManagementFeeYears = management_fee_years !== undefined ? management_fee_years : existing.management_fee_years;
      const totalAmount = plot_price + finalManagementFee;
      const signedAt = moment().format('YYYY-MM-DD HH:mm:ss');

      await run(`
        UPDATE contracts SET 
          contact_id = ?,
          deceased_id = COALESCE(?, deceased_id),
          plot_price = ?,
          management_fee = ?,
          management_fee_years = ?,
          total_amount = ?,
          status = ?,
          signed_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        contact_id, deceased_id,
        plot_price, finalManagementFee, finalManagementFeeYears, totalAmount,
        CONTRACT_STATUSES.SIGNED, signedAt,
        id
      ]);

      await run('DELETE FROM contract_fee_items WHERE contract_id = ?', [id]);

      const hasPlotItem = fee_items.some(f => f.fee_category === '购墓款');
      if (!hasPlotItem && plot_price > 0) {
        await run(`
          INSERT INTO contract_fee_items (contract_id, fee_type, fee_category, amount, description)
          VALUES (?, '墓位款', '购墓款', ?, '墓位购买费用')
        `, [id, plot_price]);
      }

      const hasFeeItem = fee_items.some(f => f.fee_category === '管理费');
      if (!hasFeeItem && finalManagementFee > 0) {
        const description = `${finalManagementFeeYears}年管理费`;
        await run(`
          INSERT INTO contract_fee_items (contract_id, fee_type, fee_category, amount, quantity, unit_price, description)
          VALUES (?, '管理费', '管理费', ?, ?, ?, ?)
        `, [id, finalManagementFee, finalManagementFeeYears, finalManagementFee / (finalManagementFeeYears || 1), description]);
      }

      for (const item of fee_items) {
        await run(`
          INSERT INTO contract_fee_items (contract_id, fee_type, fee_category, amount, quantity, unit_price, description)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          id, item.fee_type, item.fee_category, item.amount,
          item.quantity || 1, item.unit_price || item.amount, item.description || ''
        ]);
      }

      await releasePlotReservation(existing.plot_id, id);

      const plot = await get('SELECT status FROM plots WHERE id = ?', [existing.plot_id]);
      if (plot.status === PLOT_STATUSES.RESERVED) {
        await updatePlotStatus(existing.plot_id, PLOT_STATUSES.AVAILABLE);
      }

      await logStatusChange(req, id, existing.status, CONTRACT_STATUSES.SIGNED, '正式签约');

      return { signed_at: signedAt };
    });

    success(res, result, '合同签约成功');
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:id/pay', authenticate, idParamValidation, contractPayValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, payment_method, fee_category, payment_date, remark } = req.body;

    const existing = await get(`
      SELECT c.*, p.plot_number 
      FROM contracts c 
      LEFT JOIN plots p ON c.plot_id = p.id 
      WHERE c.id = ?
    `, [id]);
    if (!existing) {
      return error(res, '合同不存在', 404);
    }

    if (existing.status === CONTRACT_STATUSES.VOIDED) {
      return error(res, '已作废的合同不能付款', 400);
    }

    if (existing.status === CONTRACT_STATUSES.DRAFT) {
      return error(res, '草稿合同请先签约再付款', 400);
    }

    const payDate = payment_date || moment().format('YYYY-MM-DD');

    const result = await runInTransaction(async () => {
      const newPaidAmount = existing.paid_amount + amount;

      await run(`
        UPDATE contracts SET 
          paid_amount = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [newPaidAmount, id]);

      const paymentResult = await run(`
        INSERT INTO payments (
          plot_id, contact_id, contract_id, amount, payment_date,
          status, payment_method, fee_category, remark, bill_type
        ) VALUES (?, ?, ?, ?, ?, '已缴', ?, ?, ?, 'contract')
      `, [
        existing.plot_id, existing.contact_id, id, amount, payDate,
        payment_method, fee_category, remark
      ]);

      let becameEffective = false;
      let effectiveAt = null;
      if (newPaidAmount >= existing.total_amount && existing.status !== CONTRACT_STATUSES.EFFECTIVE) {
        const finalCheck = await checkPlotAvailability(existing.plot_id, id, existing.deceased_id);
        if (!finalCheck.available) {
          throw new Error(`合同无法生效：${finalCheck.reason}`);
        }

        if (existing.deceased_id) {
          const otherOccupant = await get(`
            SELECT id, name FROM deceased 
            WHERE plot_id = ? AND id != ?
            LIMIT 1
          `, [existing.plot_id, existing.deceased_id]);
          if (otherOccupant) {
            throw new Error(`墓位已被逝者"${otherOccupant.name}"占用，合同无法生效`);
          }
        } else {
          const anyOccupant = await get(`
            SELECT id, name FROM deceased 
            WHERE plot_id = ?
            LIMIT 1
          `, [existing.plot_id]);
          if (anyOccupant) {
            throw new Error(`墓位已被逝者"${anyOccupant.name}"占用，合同无法生效`);
          }
        }

        effectiveAt = moment().format('YYYY-MM-DD HH:mm:ss');
        
        await run(`
          UPDATE contracts SET 
            status = ?, 
            effective_at = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [CONTRACT_STATUSES.EFFECTIVE, effectiveAt, id]);

        if (existing.deceased_id) {
          await run('UPDATE deceased SET plot_id = ? WHERE id = ?', [existing.plot_id, existing.deceased_id]);
        }

        await updatePlotStatus(existing.plot_id, PLOT_STATUSES.OCCUPIED);

        await logStatusChange(req, id, existing.status, CONTRACT_STATUSES.EFFECTIVE, '款项已付清，合同自动生效');
        becameEffective = true;
      }

      const paymentSummary = `支付${fee_category} ${amount}元，${payment_method}`;
      await logOperation(req, RESOURCE_TYPES.CONTRACT, id, ACTIONS.UPDATE, paymentSummary);

      return {
        payment_id: paymentResult.id,
        new_paid_amount: newPaidAmount,
        remaining_amount: Math.max(0, existing.total_amount - newPaidAmount),
        became_effective: becameEffective,
        effective_at: effectiveAt
      };
    });

    const message = result.became_effective 
      ? '付款成功，款项已付清，合同已自动生效' 
      : '付款成功';

    success(res, result, message);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:id/void', authenticate, idParamValidation, contractVoidValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { void_reason } = req.body;

    const existing = await get('SELECT * FROM contracts WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '合同不存在', 404);
    }

    if (existing.status === CONTRACT_STATUSES.VOIDED) {
      return error(res, '合同已作废，不能重复操作', 400);
    }

    await runInTransaction(async () => {
      const voidedAt = moment().format('YYYY-MM-DD HH:mm:ss');

      await run(`
        UPDATE contracts SET 
          status = ?, 
          voided_at = ?, 
          void_reason = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [CONTRACT_STATUSES.VOIDED, voidedAt, void_reason, id]);

      await releasePlotReservation(existing.plot_id, id);

      if (existing.deceased_id) {
        const hasOtherContract = await get(`
          SELECT COUNT(*) as count 
          FROM contracts 
          WHERE deceased_id = ? AND id != ? AND status != 'voided'
        `, [existing.deceased_id, id]);
        
        if (hasOtherContract.count === 0) {
          const deceased = await get('SELECT plot_id FROM deceased WHERE id = ?', [existing.deceased_id]);
          if (deceased && deceased.plot_id === existing.plot_id) {
            await run('UPDATE deceased SET plot_id = NULL WHERE id = ?', [existing.deceased_id]);
          }
        }
      }

      const hasOtherActiveContract = await get(`
        SELECT COUNT(*) as count 
        FROM contracts 
        WHERE plot_id = ? AND id != ? AND status IN ('reserved', 'signed', 'effective')
      `, [existing.plot_id, id]);

      const hasOtherDeceased = await get(`
        SELECT COUNT(*) as count 
        FROM deceased 
        WHERE plot_id = ? AND id != COALESCE(?, 0)
      `, [existing.plot_id, existing.deceased_id]);

      if (hasOtherActiveContract.count === 0 && hasOtherDeceased.count === 0) {
        await updatePlotStatus(existing.plot_id, PLOT_STATUSES.AVAILABLE);
      }

      await logStatusChange(req, id, existing.status, CONTRACT_STATUSES.VOIDED, void_reason);
    });

    success(res, null, '合同作废成功，墓位已释放');
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:id/renew-reservation', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { reserve_days = 7 } = req.body;

    const existing = await get('SELECT * FROM contracts WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '合同不存在', 404);
    }

    if (existing.status !== CONTRACT_STATUSES.RESERVED) {
      return error(res, '只有预留中的合同才能续期', 400);
    }

    const now = moment();
    const currentExpiresAt = moment(existing.reserved_expires_at);
    
    if (currentExpiresAt.isBefore(now)) {
      return error(res, '预留已过期，请重新预留', 400);
    }

    const newExpiresAt = currentExpiresAt.clone().add(reserve_days, 'days').format('YYYY-MM-DD HH:mm:ss');

    await run(`
      UPDATE contracts SET 
        reserved_expires_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [newExpiresAt, id]);

    await run(`
      UPDATE plot_reservations SET 
        expires_at = ?
      WHERE contract_id = ? AND status = 'active'
    `, [newExpiresAt, id]);

    const summary = `续期预留${reserve_days}天，新有效期至${newExpiresAt}`;
    await logOperation(req, RESOURCE_TYPES.CONTRACT, id, ACTIONS.UPDATE, summary);

    success(res, { new_expires_at: newExpiresAt }, '预留续期成功');
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await get('SELECT * FROM contracts WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '合同不存在', 404);
    }

    if (existing.status !== CONTRACT_STATUSES.DRAFT) {
      return error(res, '只能删除草稿状态的合同，其他状态请使用作废功能', 400);
    }

    const hasPayments = await get('SELECT COUNT(*) as count FROM payments WHERE contract_id = ?', [id]);
    if (hasPayments.count > 0) {
      return error(res, '该合同已有付款记录，不能删除', 400);
    }

    await runInTransaction(async () => {
      await releasePlotReservation(existing.plot_id, id);
      await run('DELETE FROM contract_fee_items WHERE contract_id = ?', [id]);
      await run('DELETE FROM contract_status_logs WHERE contract_id = ?', [id]);
      await run('DELETE FROM contracts WHERE id = ?', [id]);

      const hasOtherActive = await get(`
        SELECT COUNT(*) as count 
        FROM plot_reservations r
        INNER JOIN contracts c ON r.contract_id = c.id
        WHERE r.plot_id = ? AND r.status = 'active' AND c.status != 'voided'
      `, [existing.plot_id]);

      const plot = await get('SELECT status FROM plots WHERE id = ?', [existing.plot_id]);
      if (hasOtherActive.count === 0 && plot.status === PLOT_STATUSES.RESERVED) {
        await updatePlotStatus(existing.plot_id, PLOT_STATUSES.AVAILABLE);
      }
    });

    const summary = generateSummary(RESOURCE_TYPES.CONTRACT, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.CONTRACT, id, ACTIONS.DELETE, summary);

    success(res, null, '合同删除成功');
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
