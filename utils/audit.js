const { run, get, all, runInTransaction } = require('./dbHelper');

const RESOURCE_TABLES = {
  plot: 'plots',
  deceased: 'deceased',
  contact: 'contacts',
  payment: 'payments',
  appointment: 'appointments',
  service_order: 'service_orders'
};

const RESOURCE_KEY_FIELDS = {
  plot: ['status', 'plot_number', 'area', 'type', 'price'],
  deceased: ['name', 'gender', 'birth_date', 'death_date', 'plot_id', 'relationship', 'interment_date'],
  contact: ['name', 'phone', 'id_card', 'address', 'relationship', 'deceased_id'],
  payment: ['status', 'amount', 'payment_date', 'due_date', 'fee_category', 'payment_method', 'plot_id', 'contact_id'],
  appointment: ['status', 'appointment_date', 'appointment_time', 'number_of_people', 'contact_id', 'plot_id'],
  service_order: ['status', 'service_date', 'service_time', 'quantity', 'total_amount', 'contact_id', 'plot_id']
};

const getTableName = (resourceType) => RESOURCE_TABLES[resourceType];

const getKeyFields = (resourceType) => RESOURCE_KEY_FIELDS[resourceType] || [];

const normalizeValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const calculateFieldDiffs = (oldData, newData, resourceType) => {
  const diffs = [];
  const keyFields = getKeyFields(resourceType);
  const fieldsToCheck = keyFields.length > 0 ? keyFields : Object.keys(newData || {});

  for (const field of fieldsToCheck) {
    const oldVal = normalizeValue(oldData?.[field]);
    const newVal = normalizeValue(newData?.[field]);
    
    if (oldVal !== newVal) {
      diffs.push({
        field_name: field,
        old_value: oldVal,
        new_value: newVal
      });
    }
  }

  return diffs;
};

const createAuditRecord = async (req, resourceType, resourceId, oldData, newData, operationLogId = null) => {
  try {
    const userId = req.user?.id;
    const userName = req.user?.name || '未知用户';

    if (!userId || !userName) {
      console.warn('创建审计记录时缺少用户信息');
      return null;
    }

    const fieldDiffs = calculateFieldDiffs(oldData, newData, resourceType);
    
    if (fieldDiffs.length === 0) {
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

      for (const diff of fieldDiffs) {
        await run(
          'INSERT INTO audit_field_diffs (snapshot_id, resource_type, resource_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
          [
            snapshotId,
            resourceType,
            resourceId,
            diff.field_name,
            diff.old_value,
            diff.new_value
          ]
        );
      }

      return {
        snapshotId,
        fieldDiffs
      };
    });

    return result;
  } catch (err) {
    console.error('创建审计记录失败:', err);
    return null;
  }
};

const getCurrentResourceData = async (resourceType, resourceId) => {
  const tableName = getTableName(resourceType);
  if (!tableName) return null;

  try {
    const data = await get(`SELECT * FROM ${tableName} WHERE id = ?`, [resourceId]);
    return data;
  } catch (err) {
    console.error('获取当前资源数据失败:', err);
    return null;
  }
};

const checkForConflicts = async (snapshotId, fieldDiffIds = []) => {
  try {
    const snapshot = await get('SELECT * FROM audit_snapshots WHERE id = ?', [snapshotId]);
    if (!snapshot) {
      return { hasConflict: true, reason: '快照不存在' };
    }

    const currentData = await getCurrentResourceData(snapshot.resource_type, snapshot.resource_id);
    if (!currentData) {
      return { hasConflict: true, reason: '目标记录已被删除' };
    }

    const snapshotData = JSON.parse(snapshot.snapshot_data || '{}');
    
    let diffSql = 'SELECT * FROM audit_field_diffs WHERE snapshot_id = ?';
    const params = [snapshotId];
    
    if (fieldDiffIds.length > 0) {
      const placeholders = fieldDiffIds.map(() => '?').join(', ');
      diffSql += ` AND id IN (${placeholders})`;
      params.push(...fieldDiffIds);
    }

    const targetDiffs = await all(diffSql, params);
    
    const conflicts = [];
    for (const diff of targetDiffs) {
      const currentVal = normalizeValue(currentData[diff.field_name]);
      const newValFromSnapshot = diff.new_value;
      
      if (currentVal !== newValFromSnapshot) {
        const laterChanges = await all(`
          SELECT afd.*, as2.created_by_name, as2.created_at
          FROM audit_field_diffs afd
          INNER JOIN audit_snapshots as2 ON afd.snapshot_id = as2.id
          WHERE afd.resource_type = ? 
            AND afd.resource_id = ? 
            AND afd.field_name = ? 
            AND as2.created_at > ?
          ORDER BY as2.created_at DESC
        `, [snapshot.resource_type, snapshot.resource_id, diff.field_name, snapshot.created_at]);

        conflicts.push({
          field_name: diff.field_name,
          expected_after_change: newValFromSnapshot,
          current_value: currentVal,
          snapshot_value: normalizeValue(snapshotData[diff.field_name]),
          later_changes: laterChanges
        });
      }
    }

    return {
      hasConflict: conflicts.length > 0,
      conflicts,
      currentData,
      snapshotData
    };
  } catch (err) {
    console.error('检查冲突失败:', err);
    return { hasConflict: true, reason: err.message };
  }
};

const executeRollback = async (rollbackRequestId, operatorId, operatorName) => {
  try {
    const request = await get('SELECT * FROM rollback_requests WHERE id = ?', [rollbackRequestId]);
    if (!request) {
      return { success: false, error: '回滚申请不存在' };
    }

    if (request.status !== 'approved') {
      return { success: false, error: '回滚申请未通过审批' };
    }

    if (request.rollback_executed_at) {
      return { success: false, error: '该回滚申请已执行过' };
    }

    const fieldDiffIds = (request.field_diff_ids || '')
      .split(',')
      .map(id => parseInt(id.trim()))
      .filter(id => !isNaN(id));

    const conflictCheck = await checkForConflicts(request.snapshot_id, fieldDiffIds);
    if (conflictCheck.hasConflict) {
      return {
        success: false,
        error: '检测到数据冲突',
        conflicts: conflictCheck.conflicts
      };
    }

    const tableName = getTableName(request.resource_type);
    if (!tableName) {
      return { success: false, error: '未知的资源类型' };
    }

    const fieldDiffs = await all(
      `SELECT * FROM audit_field_diffs WHERE id IN (${fieldDiffIds.map(() => '?').join(', ')})`,
      fieldDiffIds
    );

    const result = await runInTransaction(async () => {
      const updateFields = [];
      const updateParams = [];

      for (const diff of fieldDiffs) {
        updateFields.push(`${diff.field_name} = ?`);
        
        let valueToRestore = diff.old_value;
        if (valueToRestore === 'null') valueToRestore = null;
        if (valueToRestore !== null && !isNaN(parseFloat(valueToRestore)) && Number(valueToRestore).toString() === valueToRestore) {
          valueToRestore = Number(valueToRestore);
        }
        
        updateParams.push(valueToRestore);
      }

      updateParams.push(request.resource_id);

      await run(
        `UPDATE ${tableName} SET ${updateFields.join(', ')} WHERE id = ?`,
        updateParams
      );

      await run(
        'UPDATE rollback_requests SET rollback_executed_at = CURRENT_TIMESTAMP, rollback_result = ? WHERE id = ?',
        ['success', rollbackRequestId]
      );

      const restoredFields = fieldDiffs.map(d => ({
        field: d.field_name,
        from: d.new_value,
        to: d.old_value
      }));

      return { restoredFields };
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

const getAuditTrail = async (resourceType, resourceId, page = 1, pageSize = 20) => {
  try {
    const baseSql = `
      SELECT 
        as2.*,
        u.name as operator_name,
        u.username
      FROM audit_snapshots as2
      LEFT JOIN users u ON as2.created_by = u.id
      WHERE as2.resource_type = ? AND as2.resource_id = ?
    `;
    const params = [resourceType, resourceId];

    const countResult = await get(`SELECT COUNT(*) as total FROM (${baseSql})`, params);
    const total = countResult.total;

    const offset = (page - 1) * pageSize;
    const data = await all(
      `${baseSql} ORDER BY as2.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    for (const snapshot of data) {
      snapshot.field_diffs = await all(
        'SELECT * FROM audit_field_diffs WHERE snapshot_id = ? ORDER BY id',
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
    console.error('获取审计轨迹失败:', err);
    throw err;
  }
};

module.exports = {
  RESOURCE_TABLES,
  RESOURCE_KEY_FIELDS,
  getTableName,
  getKeyFields,
  calculateFieldDiffs,
  createAuditRecord,
  getCurrentResourceData,
  checkForConflicts,
  executeRollback,
  getAuditTrail
};
