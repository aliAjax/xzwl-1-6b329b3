const moment = require('moment');
const { get, all } = require('../utils/dbHelper');
const { PLOT_STATUSES, CONTRACT_STATUSES, STATUS_NAMES } = require('./contractConstants');

const validatePlotExists = async (plotId) => {
  const plot = await get('SELECT id, status, plot_number FROM plots WHERE id = ?', [plotId]);
  if (!plot) {
    return { valid: false, reason: '墓位不存在' };
  }
  return { valid: true, plot };
};

const validatePlotNotUnderMaintenance = (plot) => {
  if (plot.status === PLOT_STATUSES.MAINTENANCE) {
    return { valid: false, reason: '墓位正在维修中' };
  }
  return { valid: true };
};

const checkDeceasedOccupancy = async (plotId, excludeDeceasedId = null) => {
  const params = excludeDeceasedId ? [plotId, excludeDeceasedId] : [plotId];
  const occupyingDeceased = await get(`
    SELECT id, name 
    FROM deceased 
    WHERE plot_id = ? 
      ${excludeDeceasedId ? 'AND id != ?' : ''}
    LIMIT 1
  `, params);

  if (occupyingDeceased) {
    return {
      occupied: true,
      reason: `墓位已被逝者"${occupyingDeceased.name}"占用`,
      occupied_by: 'deceased',
      occupant_id: occupyingDeceased.id,
      occupant_name: occupyingDeceased.name
    };
  }
  return { occupied: false };
};

const checkActiveReservation = async (plotId, excludeContractId = null) => {
  const now = moment();
  const activeReservation = await get(`
    SELECT r.id, r.expires_at, c.contract_no, c.id as contract_id, c.status as contract_status
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    WHERE r.plot_id = ? 
      AND r.status = 'active' 
      AND c.status = 'reserved'
      ${excludeContractId ? 'AND c.id != ?' : ''}
  `, excludeContractId ? [plotId, excludeContractId] : [plotId]);

  if (activeReservation) {
    const isExpired = moment(activeReservation.expires_at).isBefore(now);
    if (!isExpired) {
      return {
        occupied: true,
        reason: `墓位已被合同${activeReservation.contract_no}预留，有效期至${activeReservation.expires_at}`,
        occupied_by: 'reservation',
        contract_id: activeReservation.contract_id,
        contract_no: activeReservation.contract_no,
        expires_at: activeReservation.expires_at,
        is_expired: false
      };
    }
    return {
      occupied: true,
      reason: `墓位预留已过期，请刷新后重试`,
      occupied_by: 'reservation',
      contract_id: activeReservation.contract_id,
      contract_no: activeReservation.contract_no,
      expires_at: activeReservation.expires_at,
      is_expired: true
    };
  }
  return { occupied: false };
};

const checkActiveContract = async (plotId, excludeContractId = null) => {
  const activeContract = await get(`
    SELECT id, contract_no, status, deceased_id
    FROM contracts 
    WHERE plot_id = ? 
      AND status IN ('signed', 'effective')
      ${excludeContractId ? 'AND id != ?' : ''}
    LIMIT 1
  `, excludeContractId ? [plotId, excludeContractId] : [plotId]);

  if (activeContract) {
    const contractDeceased = activeContract.deceased_id 
      ? await get('SELECT name FROM deceased WHERE id = ?', [activeContract.deceased_id]) 
      : null;
    return {
      occupied: true,
      reason: `墓位已关联${STATUS_NAMES[activeContract.status]}合同${activeContract.contract_no}${contractDeceased ? `，关联逝者：${contractDeceased.name}` : ''}`,
      occupied_by: 'contract',
      contract_id: activeContract.id,
      contract_no: activeContract.contract_no,
      contract_status: activeContract.status
    };
  }
  return { occupied: false };
};

const checkPlotAvailability = async (plotId, excludeContractId = null, excludeDeceasedId = null) => {
  const plotValidation = await validatePlotExists(plotId);
  if (!plotValidation.valid) {
    return { available: false, reason: plotValidation.reason };
  }

  const plot = plotValidation.plot;
  const maintenanceCheck = validatePlotNotUnderMaintenance(plot);
  if (!maintenanceCheck.valid) {
    return { available: false, reason: maintenanceCheck.reason };
  }

  const deceasedCheck = await checkDeceasedOccupancy(plotId, excludeDeceasedId);
  if (deceasedCheck.occupied) {
    return { available: false, ...deceasedCheck };
  }

  const reservationCheck = await checkActiveReservation(plotId, excludeContractId);
  if (reservationCheck.occupied && !reservationCheck.is_expired) {
    return { available: false, ...reservationCheck };
  }

  const contractCheck = await checkActiveContract(plotId, excludeContractId);
  if (contractCheck.occupied) {
    return { available: false, ...contractCheck };
  }

  return { available: true, plot };
};

const checkAvailabilityForSign = async (plotId, contractId, deceasedId = null) => {
  const availability = await checkPlotAvailability(plotId, contractId, deceasedId);
  if (!availability.available) {
    return { valid: false, reason: availability.reason };
  }

  const deceasedCheck = deceasedId
    ? await checkDeceasedOccupancy(plotId, deceasedId)
    : await checkDeceasedOccupancy(plotId);
  
  if (deceasedCheck.occupied) {
    return { 
      valid: false, 
      reason: `墓位已被逝者"${deceasedCheck.occupant_name}"占用，不能重复签约` 
    };
  }

  return { valid: true, plot: availability.plot };
};

const checkAvailabilityForEffective = async (plotId, contractId, deceasedId = null) => {
  return await checkAvailabilityForSign(plotId, contractId, deceasedId);
};

const findExpiredReservationsForPlot = async (plotId) => {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  return await get(`
    SELECT
      r.id as reservation_id,
      r.contract_id,
      r.plot_id,
      c.contract_no,
      p.plot_number
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    INNER JOIN plots p ON r.plot_id = p.id
    WHERE r.plot_id = ? 
      AND r.status = 'active' 
      AND c.status = 'reserved'
      AND r.expires_at < ?
    LIMIT 1
  `, [plotId, now]);
};

const findAllExpiredReservations = async () => {
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

module.exports = {
  validatePlotExists,
  validatePlotNotUnderMaintenance,
  checkDeceasedOccupancy,
  checkActiveReservation,
  checkActiveContract,
  checkPlotAvailability,
  checkAvailabilityForSign,
  checkAvailabilityForEffective,
  findExpiredReservationsForPlot,
  findAllExpiredReservations
};
