const { run } = require('../utils/dbHelper');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');
const { STATUS_NAMES } = require('./contractConstants');

const getClientIp = (req) => {
  const xForwardedFor = req?.headers?.['x-forwarded-for'];
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim();
  }
  return req?.ip || req?.connection?.remoteAddress || '';
};

const getOperatorInfo = (req, operatorId = null, operatorName = null, ipAddress = null) => {
  return {
    operatorId: operatorId ?? req?.user?.id,
    operatorName: operatorName ?? req?.user?.name ?? '系统',
    ipAddress: ipAddress ?? getClientIp(req)
  };
};

const logOperationWithOperator = async (resourceType, resourceId, action, summary, operatorId, operatorName, ipAddress = '') => {
  try {
    await run(
      'INSERT INTO operation_logs (user_id, user_name, resource_type, resource_id, action, summary, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [operatorId, operatorName, resourceType, resourceId, action, summary, ipAddress]
    );
  } catch (err) {
    console.error('操作日志记录失败:', err);
  }
};

const logContractStatusChange = async (contractId, fromStatus, toStatus, operatorId, operatorName, remark = '') => {
  await run(
    'INSERT INTO contract_status_logs (contract_id, from_status, to_status, operator_id, operator_name, remark) VALUES (?, ?, ?, ?, ?, ?)',
    [contractId, fromStatus, toStatus, operatorId, operatorName, remark]
  );
};

const logContractStatusChangeFromRequest = async (req, contractId, fromStatus, toStatus, remark = '') => {
  const { operatorId, operatorName } = getOperatorInfo(req);
  await logContractStatusChange(contractId, fromStatus, toStatus, operatorId, operatorName, remark);
};

const generateStatusChangeSummary = (fromStatus, toStatus, remark = '', contractNo = '', plotNumber = '') => {
  const fromName = STATUS_NAMES[fromStatus] || fromStatus;
  const toName = STATUS_NAMES[toStatus] || toStatus;
  let summary = `合同状态变更: ${fromName} → ${toName}`;
  if (contractNo) {
    summary = `合同${contractNo}状态变更: ${fromName} → ${toName}`;
  }
  if (remark) {
    summary += `，原因: ${remark}`;
  }
  if (plotNumber) {
    summary += `，墓位${plotNumber}`;
  }
  return summary;
};

const logOperationForStatusChange = async (req, contractId, fromStatus, toStatus, remark = '', contractNo = '', plotNumber = '') => {
  const summary = generateStatusChangeSummary(fromStatus, toStatus, remark, contractNo, plotNumber);
  await logOperation(req, RESOURCE_TYPES.CONTRACT, contractId, ACTIONS.STATUS_CHANGE, summary);
};

const logOperationForStatusChangeWithOperator = async (contractId, fromStatus, toStatus, remark, operatorId, operatorName, ipAddress = '', contractNo = '', plotNumber = '') => {
  const summary = generateStatusChangeSummary(fromStatus, toStatus, remark, contractNo, plotNumber);
  await logOperationWithOperator(RESOURCE_TYPES.CONTRACT, contractId, ACTIONS.STATUS_CHANGE, summary, operatorId, operatorName, ipAddress);
};

const logPlotStatusChangeWithOperator = async (plotId, plotNumber, changeReason, operatorId, operatorName, ipAddress = '') => {
  const summary = `墓位${plotNumber}${changeReason}`;
  await logOperationWithOperator(RESOURCE_TYPES.PLOT, plotId, ACTIONS.STATUS_CHANGE, summary, operatorId, operatorName, ipAddress);
};

const logContractOperation = async (req, contractId, action, data, oldData = null) => {
  const summary = generateSummary(RESOURCE_TYPES.CONTRACT, action, data, oldData);
  await logOperation(req, RESOURCE_TYPES.CONTRACT, contractId, action, summary);
};

module.exports = {
  getOperatorInfo,
  getClientIp,
  logOperationWithOperator,
  logContractStatusChange,
  logContractStatusChangeFromRequest,
  generateStatusChangeSummary,
  logOperationForStatusChange,
  logOperationForStatusChangeWithOperator,
  logPlotStatusChangeWithOperator,
  logContractOperation
};
