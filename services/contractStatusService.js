const moment = require('moment');
const { run, get } = require('../utils/dbHelper');
const {
  CONTRACT_STATUSES,
  STATUS_NAMES,
  ALLOWED_STATUS_TRANSITIONS,
  VALID_STATUSES_FOR_UPDATE,
  VALID_STATUSES_FOR_SIGN,
  VALID_STATUSES_FOR_PAY,
  VALID_STATUSES_FOR_DELETE,
  VALID_STATUSES_FOR_RENEW
} = require('./contractConstants');

const validateContractExists = async (contractId) => {
  const contract = await get('SELECT * FROM contracts WHERE id = ?', [contractId]);
  if (!contract) {
    return { valid: false, reason: '合同不存在' };
  }
  return { valid: true, contract };
};

const validateStatusTransition = (fromStatus, toStatus) => {
  const allowedTransitions = ALLOWED_STATUS_TRANSITIONS[fromStatus] || [];
  if (!allowedTransitions.includes(toStatus)) {
    return {
      valid: false,
      reason: `不允许从${STATUS_NAMES[fromStatus] || fromStatus}变更为${STATUS_NAMES[toStatus] || toStatus}`
    };
  }
  return { valid: true };
};

const validateForUpdate = (contract) => {
  if (!VALID_STATUSES_FOR_UPDATE.includes(contract.status)) {
    return { valid: false, reason: '已生效或已作废的合同不能修改' };
  }
  return { valid: true };
};

const validateForSign = (contract) => {
  if (!VALID_STATUSES_FOR_SIGN.includes(contract.status)) {
    return { valid: false, reason: '已生效或已作废的合同不能签约' };
  }
  return { valid: true };
};

const validateForPay = (contract) => {
  if (contract.status === CONTRACT_STATUSES.VOIDED) {
    return { valid: false, reason: '已作废的合同不能付款' };
  }
  if (contract.status === CONTRACT_STATUSES.DRAFT) {
    return { valid: false, reason: '草稿合同请先签约再付款' };
  }
  if (!VALID_STATUSES_FOR_PAY.includes(contract.status)) {
    return { valid: false, reason: '当前合同状态不允许付款' };
  }
  return { valid: true };
};

const validateForDelete = (contract) => {
  if (!VALID_STATUSES_FOR_DELETE.includes(contract.status)) {
    return { valid: false, reason: '只能删除草稿状态的合同，其他状态请使用作废功能' };
  }
  return { valid: true };
};

const validateForRenew = (contract) => {
  if (!VALID_STATUSES_FOR_RENEW.includes(contract.status)) {
    return { valid: false, reason: '只有预留中的合同才能续期' };
  }
  const now = moment();
  const currentExpiresAt = moment(contract.reserved_expires_at);
  if (currentExpiresAt.isBefore(now)) {
    return { valid: false, reason: '预留已过期，请重新预留' };
  }
  return { valid: true };
};

const validateDeceasedForContract = async (deceasedId, plotId, existingDeceasedId = null) => {
  if (!deceasedId || deceasedId === existingDeceasedId) {
    return { valid: true };
  }

  const deceased = await get('SELECT id, plot_id FROM deceased WHERE id = ?', [deceasedId]);
  if (!deceased) {
    return { valid: false, reason: '逝者信息不存在' };
  }
  if (deceased.plot_id && deceased.plot_id !== plotId) {
    return { valid: false, reason: '该逝者已关联其他墓位' };
  }
  return { valid: true, deceased };
};

const updateContractStatus = async (contractId, newStatus, additionalFields = {}) => {
  const setClauses = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [newStatus];

  for (const [key, value] of Object.entries(additionalFields)) {
    setClauses.push(`${key} = ?`);
    params.push(value);
  }

  params.push(contractId);

  const sql = `UPDATE contracts SET ${setClauses.join(', ')} WHERE id = ?`;
  await run(sql, params);
};

const updateContractToReserved = async (contractId, reservedAt, expiresAt) => {
  await updateContractStatus(contractId, CONTRACT_STATUSES.RESERVED, {
    reserved_at: reservedAt,
    reserved_expires_at: expiresAt
  });
};

const updateContractToSigned = async (contractId, signedAt, data = {}) => {
  const fields = { signed_at: signedAt };
  if (data.contact_id !== undefined) fields.contact_id = data.contact_id;
  if (data.deceased_id !== undefined) fields.deceased_id = data.deceased_id;
  if (data.plot_price !== undefined) fields.plot_price = data.plot_price;
  if (data.management_fee !== undefined) fields.management_fee = data.management_fee;
  if (data.management_fee_years !== undefined) fields.management_fee_years = data.management_fee_years;
  if (data.total_amount !== undefined) fields.total_amount = data.total_amount;

  await updateContractStatus(contractId, CONTRACT_STATUSES.SIGNED, fields);
};

const updateContractToEffective = async (contractId, effectiveAt) => {
  await updateContractStatus(contractId, CONTRACT_STATUSES.EFFECTIVE, {
    effective_at: effectiveAt
  });
};

const updateContractToVoided = async (contractId, voidedAt, voidReason) => {
  await updateContractStatus(contractId, CONTRACT_STATUSES.VOIDED, {
    voided_at: voidedAt,
    void_reason: voidReason
  });
};

const updateContractToDraft = async (contractId) => {
  await updateContractStatus(contractId, CONTRACT_STATUSES.DRAFT, {
    reserved_at: null,
    reserved_expires_at: null
  });
};

const updateContractPaidAmount = async (contractId, paidAmount) => {
  await run(
    'UPDATE contracts SET paid_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [paidAmount, contractId]
  );
};

const updateContractReservationExpiry = async (contractId, newExpiresAt) => {
  await run(
    'UPDATE contracts SET reserved_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [newExpiresAt, contractId]
  );
};

const updatePlotReservationExpiry = async (contractId, newExpiresAt) => {
  await run(
    "UPDATE plot_reservations SET expires_at = ? WHERE contract_id = ? AND status = 'active'",
    [newExpiresAt, contractId]
  );
};

const linkDeceasedToPlot = async (deceasedId, plotId) => {
  if (!deceasedId) return;
  await run('UPDATE deceased SET plot_id = ? WHERE id = ?', [plotId, deceasedId]);
};

const unlinkDeceasedFromPlot = async (deceasedId, plotId) => {
  if (!deceasedId) return;
  
  const hasOtherContract = await get(`
    SELECT COUNT(*) as count 
    FROM contracts 
    WHERE deceased_id = ? AND status != 'voided'
  `, [deceasedId]);
  
  if (hasOtherContract.count === 0) {
    const deceased = await get('SELECT plot_id FROM deceased WHERE id = ?', [deceasedId]);
    if (deceased && deceased.plot_id === plotId) {
      await run('UPDATE deceased SET plot_id = NULL WHERE id = ?', [deceasedId]);
    }
  }
};

const checkCanBecomeEffective = (contract, newPaidAmount) => {
  return newPaidAmount >= contract.total_amount && contract.status !== CONTRACT_STATUSES.EFFECTIVE;
};

module.exports = {
  validateContractExists,
  validateStatusTransition,
  validateForUpdate,
  validateForSign,
  validateForPay,
  validateForDelete,
  validateForRenew,
  validateDeceasedForContract,
  updateContractStatus,
  updateContractToReserved,
  updateContractToSigned,
  updateContractToEffective,
  updateContractToVoided,
  updateContractToDraft,
  updateContractPaidAmount,
  updateContractReservationExpiry,
  updatePlotReservationExpiry,
  linkDeceasedToPlot,
  unlinkDeceasedFromPlot,
  checkCanBecomeEffective
};
