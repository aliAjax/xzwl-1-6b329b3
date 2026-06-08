const { run, get } = require('../utils/dbHelper');
const { PLOT_STATUSES, CONTRACT_STATUSES } = require('./contractConstants');

const updatePlotStatus = async (plotId, status) => {
  await run('UPDATE plots SET status = ? WHERE id = ?', [status, plotId]);
};

const releasePlotReservation = async (plotId, contractId) => {
  await run(
    "UPDATE plot_reservations SET status = 'released' WHERE plot_id = ? AND contract_id = ?",
    [plotId, contractId]
  );
};

const expirePlotReservation = async (reservationId) => {
  await run(
    "UPDATE plot_reservations SET status = 'expired' WHERE id = ?",
    [reservationId]
  );
};

const hasOtherActiveReservations = async (plotId, excludeContractId = null) => {
  const sql = `
    SELECT COUNT(*) as count 
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    WHERE r.plot_id = ? 
      AND r.status = 'active' 
      AND c.status != 'voided'
      ${excludeContractId ? 'AND c.id != ?' : ''}
  `;
  const params = excludeContractId ? [plotId, excludeContractId] : [plotId];
  const result = await get(sql, params);
  return result.count > 0;
};

const hasOtherActiveContracts = async (plotId, excludeContractId = null) => {
  const sql = `
    SELECT COUNT(*) as count 
    FROM contracts 
    WHERE plot_id = ? 
      AND status IN ('reserved', 'signed', 'effective')
      ${excludeContractId ? 'AND id != ?' : ''}
  `;
  const params = excludeContractId ? [plotId, excludeContractId] : [plotId];
  const result = await get(sql, params);
  return result.count > 0;
};

const hasOtherDeceasedOccupants = async (plotId, excludeDeceasedId = null) => {
  const sql = `
    SELECT COUNT(*) as count 
    FROM deceased 
    WHERE plot_id = ? 
      ${excludeDeceasedId ? 'AND id != ?' : ''}
  `;
  const params = excludeDeceasedId ? [plotId, excludeDeceasedId] : [plotId];
  const result = await get(sql, params);
  return result.count > 0;
};

const syncPlotStatusAfterContractChange = async (plotId, currentPlotStatus, excludeContractId = null, excludeDeceasedId = null) => {
  const hasOtherActive = await hasOtherActiveContracts(plotId, excludeContractId);
  if (hasOtherActive) {
    return { status: currentPlotStatus, changed: false };
  }

  const hasOtherDeceased = await hasOtherDeceasedOccupants(plotId, excludeDeceasedId);
  if (hasOtherDeceased) {
    const newStatus = PLOT_STATUSES.OCCUPIED;
    if (currentPlotStatus !== newStatus) {
      await updatePlotStatus(plotId, newStatus);
      return { status: newStatus, changed: true };
    }
    return { status: currentPlotStatus, changed: false };
  }

  const hasOtherReservations = await hasOtherActiveReservations(plotId, excludeContractId);
  if (hasOtherReservations) {
    const newStatus = PLOT_STATUSES.RESERVED;
    if (currentPlotStatus !== newStatus) {
      await updatePlotStatus(plotId, newStatus);
      return { status: newStatus, changed: true };
    }
    return { status: currentPlotStatus, changed: false };
  }

  const newStatus = PLOT_STATUSES.AVAILABLE;
  if (currentPlotStatus !== newStatus) {
    await updatePlotStatus(plotId, newStatus);
    return { status: newStatus, changed: true };
  }
  return { status: currentPlotStatus, changed: false };
};

const setPlotReserved = async (plotId) => {
  await updatePlotStatus(plotId, PLOT_STATUSES.RESERVED);
};

const setPlotOccupied = async (plotId) => {
  await updatePlotStatus(plotId, PLOT_STATUSES.OCCUPIED);
};

const setPlotAvailableIfNoOtherUse = async (plotId, excludeContractId = null, excludeDeceasedId = null) => {
  const plot = await get('SELECT status FROM plots WHERE id = ?', [plotId]);
  if (!plot) return { status: null, changed: false };
  
  return await syncPlotStatusAfterContractChange(
    plotId, 
    plot.status, 
    excludeContractId, 
    excludeDeceasedId
  );
};

module.exports = {
  updatePlotStatus,
  releasePlotReservation,
  expirePlotReservation,
  hasOtherActiveReservations,
  hasOtherActiveContracts,
  hasOtherDeceasedOccupants,
  syncPlotStatusAfterContractChange,
  setPlotReserved,
  setPlotOccupied,
  setPlotAvailableIfNoOtherUse
};
