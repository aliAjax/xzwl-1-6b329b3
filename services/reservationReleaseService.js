const moment = require('moment');
const { get, all, runInTransaction } = require('../utils/dbHelper');
const { CONTRACT_STATUSES, STATUS_NAMES, PLOT_STATUSES } = require('./contractConstants');
const {
  validateContractExists,
  validateStatusTransition,
  updateContractToDraft
} = require('./contractStatusService');
const {
  expirePlotReservation,
  setPlotAvailableIfNoOtherUse
} = require('./plotStatusSyncService');
const {
  logContractStatusChange,
  logOperationForStatusChangeWithOperator,
  logPlotStatusChangeWithOperator
} = require('./operationLogService');

const validateReservationForRelease = async (reservation) => {
  const contractValidation = await validateContractExists(reservation.contract_id);
  if (!contractValidation.valid) {
    return { valid: false, reason: contractValidation.reason };
  }

  const contract = contractValidation.contract;

  const transitionValidation = validateStatusTransition(contract.status, CONTRACT_STATUSES.DRAFT);
  if (!transitionValidation.valid) {
    if (contract.status === CONTRACT_STATUSES.SIGNED) {
      return { valid: false, reason: '合同已签约，不能释放预留' };
    }
    if (contract.status === CONTRACT_STATUSES.EFFECTIVE) {
      return { valid: false, reason: '合同已生效，不能释放预留' };
    }
    if (contract.status === CONTRACT_STATUSES.VOIDED) {
      return { valid: false, reason: '合同已作废，不能释放预留' };
    }
    if (contract.status !== CONTRACT_STATUSES.RESERVED) {
      return { valid: false, reason: `合同状态为${STATUS_NAMES[contract.status]}，不是预留状态` };
    }
  }

  const now = moment();
  const expiresAt = moment(contract.reserved_expires_at);
  if (expiresAt.isAfter(now)) {
    return { valid: false, reason: `预留尚未过期，有效期至${contract.reserved_expires_at}` };
  }

  const plot = await get('SELECT id, plot_number, status FROM plots WHERE id = ?', [contract.plot_id]);
  if (!plot) {
    return { valid: false, reason: '墓位不存在' };
  }

  return { valid: true, contract, plot };
};

const executeReleaseOperations = async (reservation, contract, plot, operatorId, operatorName, ipAddress) => {
  await expirePlotReservation(reservation.id);

  await updateContractToDraft(contract.id);

  const plotSyncResult = await setPlotAvailableIfNoOtherUse(plot.id, contract.id);

  await logContractStatusChange(
    contract.id,
    CONTRACT_STATUSES.RESERVED,
    CONTRACT_STATUSES.DRAFT,
    operatorId,
    operatorName,
    '预留过期自动释放'
  );

  const contractSummary = `合同${contract.contract_no}预留过期已释放`;
  await logOperationForStatusChangeWithOperator(
    contract.id,
    CONTRACT_STATUSES.RESERVED,
    CONTRACT_STATUSES.DRAFT,
    '预留过期自动释放',
    operatorId,
    operatorName,
    ipAddress,
    contract.contract_no,
    plot.plot_number
  );

  if (plotSyncResult.changed) {
    await logPlotStatusChangeWithOperator(
      plot.id,
      plot.plot_number,
      `因合同${contract.contract_no}预留过期已释放，状态变更为空闲`,
      operatorId,
      operatorName,
      ipAddress
    );
  }

  return {
    success: true,
    reservation_id: reservation.id,
    contract_id: contract.id,
    contract_no: contract.contract_no,
    plot_id: plot.id,
    plot_number: plot.plot_number,
    expires_at: contract.reserved_expires_at,
    released_at: moment().format('YYYY-MM-DD HH:mm:ss'),
    plot_status_changed: plotSyncResult.changed,
    new_plot_status: plotSyncResult.status
  };
};

const releaseSingleExpiredReservation = async (reservation, operatorId, operatorName, ipAddress = '', useTransaction = true) => {
  const validation = await validateReservationForRelease(reservation);

  if (!validation.valid) {
    return {
      success: false,
      reservation_id: reservation.id,
      contract_id: reservation.contract_id,
      contract_no: reservation.contract_no,
      plot_id: reservation.plot_id,
      plot_number: reservation.plot_number,
      reason: validation.reason
    };
  }

  const { contract, plot } = validation;

  try {
    const releaseOperations = async () => {
      return await executeReleaseOperations(reservation, contract, plot, operatorId, operatorName, ipAddress);
    };

    const result = useTransaction
      ? await runInTransaction(releaseOperations)
      : await releaseOperations();

    return result;
  } catch (err) {
    return {
      success: false,
      reservation_id: reservation.id,
      contract_id: contract.id,
      contract_no: contract.contract_no,
      plot_id: plot.id,
      plot_number: plot.plot_number,
      reason: `释放失败: ${err.message}`
    };
  }
};

const findExpiredReservations = async (plotId = null) => {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  let sql = `
    SELECT
      r.id as reservation_id,
      r.contract_id,
      r.plot_id,
      c.contract_no,
      p.plot_number
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    INNER JOIN plots p ON r.plot_id = p.id
    WHERE r.status = 'active'
      AND c.status = 'reserved'
      AND r.expires_at < ?
  `;
  const params = [now];

  if (plotId) {
    sql += ' AND r.plot_id = ?';
    params.push(plotId);
  }

  sql += ' ORDER BY r.expires_at ASC';

  return await all(sql, params);
};

const findAllExpiredReservationsForScan = async () => {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  return await all(`
    SELECT 
      r.id as reservation_id,
      r.contract_id,
      r.plot_id,
      r.expires_at,
      c.contract_no,
      c.status as contract_status,
      p.plot_number
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    INNER JOIN plots p ON r.plot_id = p.id
    WHERE r.status = 'active'
      AND c.status = 'reserved'
      AND r.expires_at < ?
    ORDER BY r.expires_at ASC
  `, [now]);
};

const checkAndReleaseExpiredReservationsForPlot = async (plotId, operatorId = null, operatorName = '系统', ipAddress = '', releaseInTransaction = true) => {
  const expired = await findExpiredReservations(plotId);

  for (const r of expired) {
    const reservation = {
      id: r.reservation_id,
      contract_id: r.contract_id,
      plot_id: r.plot_id,
      contract_no: r.contract_no,
      plot_number: r.plot_number
    };
    await releaseSingleExpiredReservation(reservation, operatorId, operatorName, ipAddress, releaseInTransaction);
  }
};

const scanAndReleaseExpiredReservations = async (operatorId, operatorName, ipAddress = '') => {
  const candidates = await findAllExpiredReservationsForScan();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  const results = {
    scan_time: now,
    total_candidates: candidates.length,
    success_count: 0,
    failed_count: 0,
    success_details: [],
    failed_details: []
  };

  for (const candidate of candidates) {
    const reservation = {
      id: candidate.reservation_id,
      contract_id: candidate.contract_id,
      plot_id: candidate.plot_id,
      contract_no: candidate.contract_no,
      plot_number: candidate.plot_number,
      expires_at: candidate.expires_at
    };

    const result = await releaseSingleExpiredReservation(reservation, operatorId, operatorName, ipAddress);

    if (result.success) {
      results.success_count++;
      results.success_details.push(result);
    } else {
      results.failed_count++;
      results.failed_details.push(result);
    }
  }

  return results;
};

module.exports = {
  validateReservationForRelease,
  executeReleaseOperations,
  releaseSingleExpiredReservation,
  findExpiredReservations,
  findAllExpiredReservationsForScan,
  checkAndReleaseExpiredReservationsForPlot,
  scanAndReleaseExpiredReservations
};
