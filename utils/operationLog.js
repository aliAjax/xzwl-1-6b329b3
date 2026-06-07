const db = require('../config/database');
const { run } = require('./dbHelper');

const RESOURCE_TYPES = {
  PLOT: 'plot',
  DECEASED: 'deceased',
  CONTACT: 'contact',
  PAYMENT: 'payment',
  APPOINTMENT: 'appointment',
  VISIT_RECORD: 'visit_record',
  BILL_BATCH: 'bill_batch',
  REMINDER_BATCH: 'reminder_batch',
  MAINTENANCE_ORDER: 'maintenance_order',
  FESTIVAL_SCHEDULE: 'festival_schedule',
  FESTIVAL_TIME_SLOT: 'festival_time_slot',
  FESTIVAL_STAFF_SCHEDULE: 'festival_staff_schedule'
};

const ACTIONS = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  STATUS_CHANGE: 'status_change'
};

const getClientIp = (req) => {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim();
  }
  return req.ip || req.connection.remoteAddress || '';
};

const logOperation = async (req, resourceType, resourceId, action, summary) => {
  try {
    const userId = req.user?.id;
    const userName = req.user?.name || '未知用户';
    const ipAddress = getClientIp(req);

    await run(
      'INSERT INTO operation_logs (user_id, user_name, resource_type, resource_id, action, summary, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, userName, resourceType, resourceId, action, summary, ipAddress]
    );
  } catch (err) {
    console.error('操作日志记录失败:', err);
  }
};

const generateSummary = (resourceType, action, data, oldData = null) => {
  const resourceNames = {
    plot: '墓位',
    deceased: '逝者',
    contact: '联系人',
    payment: '缴费',
    appointment: '预约',
    visit_record: '沟通记录',
    bill_batch: '账单批次',
    reminder_batch: '提醒批次',
    maintenance_order: '维修工单',
    festival_schedule: '节日排班',
    festival_time_slot: '时段容量',
    festival_staff_schedule: '工作人员排班'
  };

  const actionNames = {
    create: '新增',
    update: '修改',
    delete: '删除',
    status_change: '状态变更'
  };

  const resourceName = resourceNames[resourceType] || resourceType;
  const actionName = actionNames[action] || action;

  if (action === 'create') {
    return `${actionName}${resourceName}`;
  }

  if (action === 'delete') {
    return `${actionName}${resourceName}`;
  }

  if (action === 'status_change') {
    const oldStatus = oldData?.status || '未知';
    const newStatus = data?.status || '未知';
    return `${actionName}${resourceName}状态: ${oldStatus} → ${newStatus}`;
  }

  if (action === 'update') {
    const changedFields = [];
    if (oldData && data) {
      for (const key of Object.keys(data)) {
        if (key === 'id' || key === 'created_at' || key === 'updated_at') continue;
        if (oldData[key] !== data[key] && data[key] !== undefined) {
          changedFields.push(key);
        }
      }
    }
    if (changedFields.length > 0) {
      return `${actionName}${resourceName}字段: ${changedFields.join(', ')}`;
    }
    return `${actionName}${resourceName}`;
  }

  return `${actionName}${resourceName}`;
};

module.exports = {
  RESOURCE_TYPES,
  ACTIONS,
  logOperation,
  generateSummary
};
