const { run, get, all, runInTransaction } = require('./dbHelper');

const AUDITED_RESOURCE_TYPES = {
  PLOT: 'plot',
  DECEASED: 'deceased',
  CONTACT: 'contact',
  PAYMENT: 'payment',
  APPOINTMENT: 'appointment',
  SERVICE_ORDER: 'service_order'
};

const AUDITED_FIELDS = {
  plot: ['status', 'plot_number', 'area', 'type', 'price', 'row', 'col', 'remark'],
  deceased: ['name', 'gender', 'birth_date', 'death_date', 'plot_id', 'relationship', 'interment_date', 'remark'],
  contact: ['name', 'phone', 'id_card', 'address', 'relationship', 'deceased_id', 'remark'],
  payment: ['status', 'amount', 'payment_date', 'due_date', 'fee_category', 'payment_method', 'plot_id', 'contact_id', 'remark'],
  appointment: ['status', 'appointment_date', 'appointment_time', 'number_of_people', 'contact_id', 'plot_id', 'purpose', 'remark'],
  service_order: ['status', 'service_date', 'service_time', 'quantity', 'total_amount', 'contact_id', 'plot_id', 'service_type', 'remark']
};

const RESOURCE_TABLE_MAP = {
  plot: 'plots',
  deceased: 'deceased',
  contact: 'contacts',
  payment: 'payments',
  appointment: 'appointments',
  service_order: 'service_orders'
};

const RESOURCE_NAME_MAP = {
  plot: '墓位',
  deceased: '逝者',
  contact: '联系人',
  payment: '缴费',
  appointment: '预约',
  service_order: '服务订单'
};

const FIELD_NAME_MAP = {
  plot: {
    status: '状态',
    plot_number: '墓位编号',
    area: '区域',
    type: '类型',
    price: '价格',
    row: '排号',
    col: '列号',
    remark: '备注'
  },
  deceased: {
    name: '姓名',
    gender: '性别',
    birth_date: '出生日期',
    death_date: '逝世日期',
    plot_id: '墓位ID',
    relationship: '与联系人关系',
    interment_date: '安葬日期',
    remark: '备注'
  },
  contact: {
    name: '姓名',
    phone: '联系电话',
    id_card: '身份证号',
    address: '联系地址',
    relationship: '与逝者关系',
    deceased_id: '逝者ID',
    remark: '备注'
  },
  payment: {
    status: '状态',
    amount: '金额',
    payment_date: '缴费日期',
    due_date: '到期日期',
    fee_category: '费用类别',
    payment_method: '支付方式',
    plot_id: '墓位ID',
    contact_id: '联系人ID',
    remark: '备注'
  },
  appointment: {
    status: '状态',
    appointment_date: '预约日期',
    appointment_time: '预约时间',
    number_of_people: '人数',
    contact_id: '联系人ID',
    plot_id: '墓位ID',
    purpose: '预约目的',
    remark: '备注'
  },
  service_order: {
    status: '状态',
    service_date: '服务日期',
    service_time: '服务时间',
    quantity: '数量',
    total_amount: '总金额',
    contact_id: '联系人ID',
    plot_id: '墓位ID',
    service_type: '服务类型',
    remark: '备注'
  }
};

const normalizeValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const denormalizeValue = (value) => {
  if (value === null || value === 'null') return null;
  if (value !== null && !isNaN(parseFloat(value)) && Number(value).toString() === value) {
    return Number(value);
  }
  return value;
};

const calculateFieldChanges = (oldData, newData, resourceType) => {
  const changes = [];
  const keyFields = AUDITED_FIELDS[resourceType] || [];
  const fieldsToCheck = keyFields.length > 0 ? keyFields : Object.keys(newData || {});

  for (const field of fieldsToCheck) {
    const oldVal = normalizeValue(oldData?.[field]);
    const newVal = normalizeValue(newData?.[field]);
    
    if (oldVal !== newVal) {
      changes.push({
        field_name: field,
        old_value: oldVal,
        new_value: newVal
      });
    }
  }

  return changes;
};

const createAuditSnapshot = async (resourceType, resourceId, oldData, newData, req, operationLogId = null) => {
  try {
    const userId = req.user?.id;
    const userName = req.user?.name || '未知用户';

    if (!userId || !userName) {
      console.warn('创建审计快照时缺少用户信息');
      return null;
    }

    const fieldChanges = calculateFieldChanges(oldData, newData, resourceType);
    
    if (fieldChanges.length === 0) {
      return null;
    }

    const result = await runInTransaction(async () => {
      const snapshotResult = await run(
        'INSERT INTO audit_snapshots (resource_type, resource_id, snapshot_data, operation_log_id, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?)',
        [
          resourceType,
          resourceId,
          JSON.stringify(oldData || {}),
          operationLogId,
          userId,
          userName
        ]
      );

      const snapshotId = snapshotResult.id;

      for (const change of fieldChanges) {
        await run(
          'INSERT INTO audit_field_changes (snapshot_id, resource_type, resource_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
          [
            snapshotId,
            resourceType,
            resourceId,
            change.field_name,
            change.old_value,
            change.new_value
          ]
        );
      }

      return {
        snapshotId,
        fieldChanges
      };
    });

    return result;
  } catch (err) {
    console.error('创建审计快照失败:', err);
    return null;
  }
};

const getResourceCurrentData = async (resourceType, resourceId) => {
  const tableName = RESOURCE_TABLE_MAP[resourceType];
  if (!tableName) return null;

  try {
    const data = await get(`SELECT * FROM ${tableName} WHERE id = ?`, [resourceId]);
    return data;
  } catch (err) {
    console.error('获取当前资源数据失败:', err);
    return null;
  }
};

const getFieldNameMap = (resourceType) => {
  return FIELD_NAME_MAP[resourceType] || {};
};

const getSnapshotWithChanges = async (snapshotId) => {
  try {
    const snapshot = await get(`
      SELECT s.*, 
             u.name as created_by_user_name,
             o.summary as operation_summary,
             o.action as operation_action
      FROM audit_snapshots s
      LEFT JOIN users u ON s.created_by = u.id
      LEFT JOIN operation_logs o ON s.operation_log_id = o.id
      WHERE s.id = ?
    `, [snapshotId]);

    if (!snapshot) {
      return null;
    }

    const fieldChanges = await all(
      'SELECT * FROM audit_field_changes WHERE snapshot_id = ? ORDER BY id',
      [snapshotId]
    );

    if (snapshot.snapshot_data) {
      try {
        snapshot.snapshot_data = JSON.parse(snapshot.snapshot_data);
      } catch (e) {
        // 保持原样
      }
    }

    return {
      ...snapshot,
      field_changes: fieldChanges
    };
  } catch (err) {
    console.error('获取快照及变更失败:', err);
    throw err;
  }
};

const getSnapshotsByResource = async (resourceType, resourceId, page = 1, pageSize = 20) => {
  try {
    const baseSql = `
      SELECT s.*,
             u.name as created_by_user_name,
             o.summary as operation_summary,
             o.action as operation_action
      FROM audit_snapshots s
      LEFT JOIN users u ON s.created_by = u.id
      LEFT JOIN operation_logs o ON s.operation_log_id = o.id
      WHERE s.resource_type = ? AND s.resource_id = ?
    `;
    const params = [resourceType, resourceId];

    const countResult = await get(`SELECT COUNT(*) as total FROM (${baseSql})`, params);
    const total = countResult.total;

    const offset = (page - 1) * pageSize;
    const data = await all(
      `${baseSql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    for (const snapshot of data) {
      snapshot.field_changes = await all(
        'SELECT * FROM audit_field_changes WHERE snapshot_id = ? ORDER BY id',
        [snapshot.id]
      );
      if (snapshot.snapshot_data) {
        try {
          snapshot.snapshot_data = JSON.parse(snapshot.snapshot_data);
        } catch (e) {
          // 保持原样
        }
      }
    }

    return { data, total, page, pageSize };
  } catch (err) {
    console.error('按资源查询历史快照失败:', err);
    throw err;
  }
};

const detectConflicts = async (snapshotId, fieldNames = []) => {
  try {
    const snapshot = await get('SELECT * FROM audit_snapshots WHERE id = ?', [snapshotId]);
    if (!snapshot) {
      return { has_conflict: true, conflicts: [], reason: '快照不存在' };
    }

    const currentData = await getResourceCurrentData(snapshot.resource_type, snapshot.resource_id);
    if (!currentData) {
      return { 
        has_conflict: true, 
        conflicts: [{ field: 'record', reason: '目标记录已被删除' }],
        current_data: null,
        reason: '目标记录已被删除'
      };
    }

    const snapshotData = JSON.parse(snapshot.snapshot_data || '{}');
    
    let changesSql = 'SELECT * FROM audit_field_changes WHERE snapshot_id = ?';
    const params = [snapshotId];
    
    if (fieldNames.length > 0) {
      const placeholders = fieldNames.map(() => '?').join(', ');
      changesSql += ` AND field_name IN (${placeholders})`;
      params.push(...fieldNames);
    }

    const targetChanges = await all(changesSql, params);
    
    const conflicts = [];
    for (const change of targetChanges) {
      const currentVal = normalizeValue(currentData[change.field_name]);
      const newValFromSnapshot = change.new_value;
      
      if (currentVal !== newValFromSnapshot) {
        const laterChanges = await all(`
          SELECT afc.*, as2.created_by_name, as2.created_at
          FROM audit_field_changes afc
          INNER JOIN audit_snapshots as2 ON afc.snapshot_id = as2.id
          WHERE afc.resource_type = ? 
            AND afc.resource_id = ? 
            AND afc.field_name = ? 
            AND as2.created_at > ?
          ORDER BY as2.created_at DESC
        `, [snapshot.resource_type, snapshot.resource_id, change.field_name, snapshot.created_at]);

        conflicts.push({
          field: change.field_name,
          expected_after_change: newValFromSnapshot,
          current_value: currentVal,
          snapshot_value: normalizeValue(snapshotData[change.field_name]),
          later_changes: laterChanges
        });
      }
    }

    return {
      has_conflict: conflicts.length > 0,
      conflicts,
      current_data: currentData,
      snapshot_data: snapshotData
    };
  } catch (err) {
    console.error('检测冲突失败:', err);
    return { has_conflict: true, conflicts: [], reason: err.message };
  }
};

const executeRollback = async (snapshotId, fieldNames, userId, userName) => {
  try {
    const snapshot = await get('SELECT * FROM audit_snapshots WHERE id = ?', [snapshotId]);
    if (!snapshot) {
      return { success: false, error: '快照不存在' };
    }

    const tableName = RESOURCE_TABLE_MAP[snapshot.resource_type];
    if (!tableName) {
      return { success: false, error: '未知的资源类型' };
    }

    const conflictCheck = await detectConflicts(snapshotId, fieldNames);
    if (conflictCheck.has_conflict) {
      return {
        success: false,
        error: '检测到数据冲突',
        conflicts: conflictCheck.conflicts
      };
    }

    let changesSql = 'SELECT * FROM audit_field_changes WHERE snapshot_id = ?';
    const params = [snapshotId];
    
    if (fieldNames.length > 0) {
      const placeholders = fieldNames.map(() => '?').join(', ');
      changesSql += ` AND field_name IN (${placeholders})`;
      params.push(...fieldNames);
    }

    const fieldChanges = await all(changesSql, params);

    if (fieldChanges.length === 0) {
      return { success: false, error: '没有需要回滚的字段' };
    }

    const result = await runInTransaction(async () => {
      const currentData = await getResourceCurrentData(snapshot.resource_type, snapshot.resource_id);
      
      const updateFields = [];
      const updateParams = [];
      const rollbackOldData = {};
      const rollbackNewData = {};

      for (const change of fieldChanges) {
        updateFields.push(`${change.field_name} = ?`);
        
        const valueToRestore = denormalizeValue(change.old_value);
        updateParams.push(valueToRestore);

        rollbackOldData[change.field_name] = currentData[change.field_name];
        rollbackNewData[change.field_name] = valueToRestore;
      }

      updateParams.push(snapshot.resource_id);

      await run(
        `UPDATE ${tableName} SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );

      const restoredFields = fieldChanges.map(c => ({
        field: c.field_name,
        from: c.new_value,
        to: c.old_value
      }));

      const rollbackSnapshotResult = await run(
        'INSERT INTO audit_snapshots (resource_type, resource_id, snapshot_data, operation_log_id, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?)',
        [
          snapshot.resource_type,
          snapshot.resource_id,
          JSON.stringify(rollbackOldData || {}),
          null,
          userId,
          userName
        ]
      );

      const rollbackChanges = calculateFieldChanges(rollbackOldData, rollbackNewData, snapshot.resource_type);
      for (const rc of rollbackChanges) {
        await run(
          'INSERT INTO audit_field_changes (snapshot_id, resource_type, resource_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
          [
            rollbackSnapshotResult.id,
            snapshot.resource_type,
            snapshot.resource_id,
            rc.field_name,
            rc.old_value,
            rc.new_value
          ]
        );
      }

      return { restoredFields, rollbackSnapshotId: rollbackSnapshotResult.id };
    });

    return {
      success: true,
      ...result
    };
  } catch (err) {
    console.error('执行回滚失败:', err);
    return { success: false, error: err.message };
  }
};

module.exports = {
  AUDITED_RESOURCE_TYPES,
  AUDITED_FIELDS,
  RESOURCE_TABLE_MAP,
  RESOURCE_NAME_MAP,
  FIELD_NAME_MAP,
  calculateFieldChanges,
  createAuditSnapshot,
  getSnapshotWithChanges,
  getSnapshotsByResource,
  detectConflicts,
  executeRollback,
  getFieldNameMap,
  getResourceCurrentData
};
