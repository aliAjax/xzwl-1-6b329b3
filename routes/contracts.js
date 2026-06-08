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

const {
  CONTRACT_STATUSES,
  STATUS_NAMES,
  PLOT_STATUSES
} = require('../services/contractConstants');

const {
  checkPlotAvailability,
  checkAvailabilityForSign,
  checkAvailabilityForEffective
} = require('../services/plotAvailabilityService');

const {
  getOperatorInfo,
  logContractStatusChangeFromRequest,
  logOperationForStatusChange,
  logContractOperation
} = require('../services/operationLogService');

const {
  releasePlotReservation,
  setPlotReserved,
  setPlotOccupied,
  setPlotAvailableIfNoOtherUse
} = require('../services/plotStatusSyncService');

const {
  validateContractExists,
  validateForUpdate,
  validateForSign,
  validateForPay,
  validateForDelete,
  validateForRenew,
  validateDeceasedForContract,
  updateContractToReserved,
  updateContractToSigned,
  updateContractToEffective,
  updateContractToVoided,
  updateContractPaidAmount,
  updateContractReservationExpiry,
  updatePlotReservationExpiry,
  linkDeceasedToPlot,
  unlinkDeceasedFromPlot,
  checkCanBecomeEffective
} = require('../services/contractStatusService');

const {
  validateReservationForRelease,
  releaseSingleExpiredReservation,
  checkAndReleaseExpiredReservationsForPlot,
  scanAndReleaseExpiredReservations,
  findExpiredReservations
} = require('../services/reservationReleaseService');

const router = express.Router();

const generateContractNo = () => {
  const date = moment().format('YYYYMMDD');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `HT${date}${random}`;
};

const logStatusChange = async (req, contractId, fromStatus, toStatus, remark = '') => {
  await logContractStatusChangeFromRequest(req, contractId, fromStatus, toStatus, remark);
  await logOperationForStatusChange(req, contractId, fromStatus, toStatus, remark);
};

const autoReleaseExpiredReservations = async (operatorId = null, operatorName = '系统', ipAddress = '', releaseInTransaction = true) => {
  const expired = await findExpiredReservations();
  for (const r of expired) {
    const reservation = {
      id: r.reservation_id,
      contract_id: r.contract_id,
      plot_id: r.plot_id,
      contract_no: r.contract_no,
      plot_number: r.plot_number
    };
    await releaseSingleExpiredReservation(reservation, operatorId, operatorName, ipAddress);
  }
};

const checkPlotAvailabilityWithAutoRelease = async (plotId, excludeContractId = null, excludeDeceasedId = null, autoReleaseExpired = true, operatorId = null, operatorName = '系统', ipAddress = '', releaseInTransaction = true) => {
  if (autoReleaseExpired) {
    await checkAndReleaseExpiredReservationsForPlot(plotId, operatorId, operatorName, ipAddress);
  }
  return await checkPlotAvailability(plotId, excludeContractId, excludeDeceasedId);
};

router.get('/check-plot-availability', authenticate, async (req, res) => {
  try {
    const { plot_id } = req.query;
    const { operatorId, operatorName, ipAddress } = getOperatorInfo(req);

    if (!plot_id) {
      return error(res, '请提供墓位ID', 400);
    }

    await checkAndReleaseExpiredReservationsForPlot(plot_id, operatorId, operatorName, ipAddress);
    const result = await checkPlotAvailabilityWithAutoRelease(plot_id, null, null, true, operatorId, operatorName, ipAddress);

    success(res, result);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/expired-reservations', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.query;
    const now = moment().format('YYYY-MM-DD HH:mm:ss');

    const baseSql = `
      SELECT 
        r.id as reservation_id,
        r.contract_id,
        r.plot_id,
        r.contact_name,
        r.contact_phone,
        r.reserved_at,
        r.expires_at,
        c.contract_no,
        c.status as contract_status,
        p.plot_number,
        p.area,
        p.status as plot_status
      FROM plot_reservations r
      INNER JOIN contracts c ON r.contract_id = c.id
      INNER JOIN plots p ON r.plot_id = p.id
      WHERE r.status = 'active'
        AND c.status = 'reserved'
        AND r.expires_at < ?
    `;

    const result = await paginateQuery(baseSql, [now], page, pageSize, 'r.expires_at ASC');

    const dataWithExpiryInfo = result.data.map(item => {
      const expiresAt = moment(item.expires_at);
      const nowMoment = moment();
      const daysExpired = Math.floor(nowMoment.diff(expiresAt, 'days'));
      const hoursExpired = Math.floor(nowMoment.diff(expiresAt, 'hours') % 24);

      return {
        ...item,
        status_name: STATUS_NAMES[item.contract_status] || item.contract_status,
        days_expired: daysExpired,
        hours_expired: hoursExpired,
        expired_duration: daysExpired > 0
          ? `${daysExpired}天${hoursExpired}小时`
          : `${hoursExpired}小时`
      };
    });

    paginate(res, dataWithExpiryInfo, result.total, page, pageSize);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/scan-expired-reservations', authenticate, async (req, res) => {
  try {
    const { operatorId, operatorName, ipAddress } = getOperatorInfo(req);

    const results = await scanAndReleaseExpiredReservations(operatorId, operatorName, ipAddress);

    const summary = `手动扫描过期预留：共发现${results.total_candidates}个过期预留，成功释放${results.success_count}个，失败${results.failed_count}个`;
    await logOperation(req, RESOURCE_TYPES.CONTRACT, 0, ACTIONS.STATUS_CHANGE, summary);

    success(res, results, summary);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/release-expired-reservation/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { operatorId, operatorName, ipAddress } = getOperatorInfo(req);

    const reservation = await get(`
      SELECT 
        r.id,
        r.contract_id,
        r.plot_id,
        c.contract_no,
        p.plot_number
      FROM plot_reservations r
      INNER JOIN contracts c ON r.contract_id = c.id
      INNER JOIN plots p ON r.plot_id = p.id
      WHERE r.id = ?
    `, [id]);

    if (!reservation) {
      return error(res, '预留记录不存在', 404);
    }

    const result = await releaseSingleExpiredReservation(reservation, operatorId, operatorName, ipAddress);

    if (result.success) {
      success(res, result, '过期预留释放成功');
    } else {
      error(res, result.reason, 400);
    }
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/', authenticate, contractQueryValidation, async (req, res) => {
  try {
    const {
      page = 1, pageSize = 10, status = '', plot_id = '',
      contact_id = '', keyword = '', start_date = '', end_date = '',
      expiring_within_days = '', auto_release = 'true'
    } = req.query;
    const { operatorId, operatorName, ipAddress } = getOperatorInfo(req);

    if (auto_release === 'true') {
      await autoReleaseExpiredReservations(operatorId, operatorName, ipAddress);
    }

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
    const { operatorId, operatorName, ipAddress } = getOperatorInfo(req);

    const availability = await checkPlotAvailabilityWithAutoRelease(plot_id, null, null, true, operatorId, operatorName, ipAddress);
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
    const { operatorId, operatorName, ipAddress } = getOperatorInfo(req);

    await checkAndReleaseExpiredReservationsForPlot(plot_id, operatorId, operatorName, ipAddress);

    const result = await runInTransaction(async () => {
      const lockCheck = await checkPlotAvailabilityWithAutoRelease(plot_id, null, null, true, operatorId, operatorName, ipAddress);
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

      await setPlotReserved(plot_id);

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

    const contractValidation = await validateContractExists(id);
    if (!contractValidation.valid) {
      return error(res, contractValidation.reason, 404);
    }
    const existing = contractValidation.contract;

    const updateValidation = validateForUpdate(existing);
    if (!updateValidation.valid) {
      return error(res, updateValidation.reason, 400);
    }

    const deceasedValidation = await validateDeceasedForContract(deceased_id, existing.plot_id, existing.deceased_id);
    if (!deceasedValidation.valid) {
      return error(res, deceasedValidation.reason, 400);
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
    await logContractOperation(req, id, ACTIONS.UPDATE, newData, existing);

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
    const { operatorId, operatorName, ipAddress } = getOperatorInfo(req);

    const contractValidation = await validateContractExists(id);
    if (!contractValidation.valid) {
      return error(res, contractValidation.reason, 404);
    }
    const existing = contractValidation.contract;

    const signValidation = validateForSign(existing);
    if (!signValidation.valid) {
      return error(res, signValidation.reason, 400);
    }

    const deceasedValidation = await validateDeceasedForContract(deceased_id, existing.plot_id, existing.deceased_id);
    if (!deceasedValidation.valid) {
      return error(res, deceasedValidation.reason, 400);
    }

    const result = await runInTransaction(async () => {
      const availability = await checkAvailabilityForSign(existing.plot_id, id, deceased_id);
      if (!availability.valid) {
        throw new Error(availability.reason);
      }

      const finalManagementFee = management_fee !== undefined ? management_fee : existing.management_fee;
      const finalManagementFeeYears = management_fee_years !== undefined ? management_fee_years : existing.management_fee_years;
      const totalAmount = plot_price + finalManagementFee;
      const signedAt = moment().format('YYYY-MM-DD HH:mm:ss');

      await updateContractToSigned(id, signedAt, {
        contact_id,
        deceased_id,
        plot_price,
        management_fee: finalManagementFee,
        management_fee_years: finalManagementFeeYears,
        total_amount: totalAmount
      });

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

      await setPlotAvailableIfNoOtherUse(existing.plot_id, id);

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
    const { operatorId, operatorName, ipAddress } = getOperatorInfo(req);

    const contractData = await get(`
      SELECT c.*, p.plot_number 
      FROM contracts c 
      LEFT JOIN plots p ON c.plot_id = p.id 
      WHERE c.id = ?
    `, [id]);
    if (!contractData) {
      return error(res, '合同不存在', 404);
    }

    const payValidation = validateForPay(contractData);
    if (!payValidation.valid) {
      return error(res, payValidation.reason, 400);
    }

    const payDate = payment_date || moment().format('YYYY-MM-DD');

    const result = await runInTransaction(async () => {
      const newPaidAmount = contractData.paid_amount + amount;

      await updateContractPaidAmount(id, newPaidAmount);

      const paymentResult = await run(`
        INSERT INTO payments (
          plot_id, contact_id, contract_id, amount, payment_date,
          status, payment_method, fee_category, remark, bill_type
        ) VALUES (?, ?, ?, ?, ?, '已缴', ?, ?, ?, 'contract')
      `, [
        contractData.plot_id, contractData.contact_id, id, amount, payDate,
        payment_method, fee_category, remark
      ]);

      let becameEffective = false;
      let effectiveAt = null;
      if (checkCanBecomeEffective(contractData, newPaidAmount)) {
        const finalCheck = await checkAvailabilityForEffective(contractData.plot_id, id, contractData.deceased_id);
        if (!finalCheck.valid) {
          throw new Error(`合同无法生效：${finalCheck.reason}`);
        }

        effectiveAt = moment().format('YYYY-MM-DD HH:mm:ss');

        await updateContractToEffective(id, effectiveAt);

        if (contractData.deceased_id) {
          await linkDeceasedToPlot(contractData.deceased_id, contractData.plot_id);
        }

        await setPlotOccupied(contractData.plot_id);

        await logStatusChange(req, id, contractData.status, CONTRACT_STATUSES.EFFECTIVE, '款项已付清，合同自动生效');
        becameEffective = true;
      }

      const paymentSummary = `支付${fee_category} ${amount}元，${payment_method}`;
      await logOperation(req, RESOURCE_TYPES.CONTRACT, id, ACTIONS.UPDATE, paymentSummary);

      return {
        payment_id: paymentResult.id,
        new_paid_amount: newPaidAmount,
        remaining_amount: Math.max(0, contractData.total_amount - newPaidAmount),
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

    const contractValidation = await validateContractExists(id);
    if (!contractValidation.valid) {
      return error(res, contractValidation.reason, 404);
    }
    const existing = contractValidation.contract;

    if (existing.status === CONTRACT_STATUSES.VOIDED) {
      return error(res, '合同已作废，不能重复操作', 400);
    }

    await runInTransaction(async () => {
      const voidedAt = moment().format('YYYY-MM-DD HH:mm:ss');

      await updateContractToVoided(id, voidedAt, void_reason);

      await releasePlotReservation(existing.plot_id, id);

      if (existing.deceased_id) {
        await unlinkDeceasedFromPlot(existing.deceased_id, existing.plot_id);
      }

      await setPlotAvailableIfNoOtherUse(existing.plot_id, id, existing.deceased_id);

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

    const contractValidation = await validateContractExists(id);
    if (!contractValidation.valid) {
      return error(res, contractValidation.reason, 404);
    }
    const existing = contractValidation.contract;

    const renewValidation = validateForRenew(existing);
    if (!renewValidation.valid) {
      return error(res, renewValidation.reason, 400);
    }

    const currentExpiresAt = moment(existing.reserved_expires_at);
    const newExpiresAt = currentExpiresAt.clone().add(reserve_days, 'days').format('YYYY-MM-DD HH:mm:ss');

    await updateContractReservationExpiry(id, newExpiresAt);
    await updatePlotReservationExpiry(id, newExpiresAt);

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

    const contractValidation = await validateContractExists(id);
    if (!contractValidation.valid) {
      return error(res, contractValidation.reason, 404);
    }
    const existing = contractValidation.contract;

    const deleteValidation = validateForDelete(existing);
    if (!deleteValidation.valid) {
      return error(res, deleteValidation.reason, 400);
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

      await setPlotAvailableIfNoOtherUse(existing.plot_id, id);
    });

    await logContractOperation(req, id, ACTIONS.DELETE, existing);

    success(res, null, '合同删除成功');
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;

module.exports.checkAndReleaseExpiredReservations = checkAndReleaseExpiredReservationsForPlot;
module.exports.autoReleaseExpiredReservations = autoReleaseExpiredReservations;
module.exports.checkPlotAvailability = checkPlotAvailabilityWithAutoRelease;
module.exports.releaseSingleExpiredReservation = releaseSingleExpiredReservation;
module.exports.validateReservationForRelease = validateReservationForRelease;
module.exports.logStatusChangeWithOperator = require('../services/operationLogService').logContractStatusChange;
module.exports.logOperationWithOperator = require('../services/operationLogService').logOperationWithOperator;
