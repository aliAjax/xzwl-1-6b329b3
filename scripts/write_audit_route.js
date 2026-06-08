const fs = require('fs');
const path = require('path');

const content = `const express = require('express');
const { paginateQuery, get, all } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { idParamValidation } = require('../middleware/validator');
const { 
  AUDITED_RESOURCE_TYPES, 
  RESOURCE_NAME_MAP, 
  getSnapshotWithChanges, 
  getSnapshotsByResource, 
  getFieldNameMap,
  detectConflicts 
} = require('../utils/audit');

const router = express.Router();

const resourceTypeNames = {
  plot: '墓位',
  deceased: '逝者',
  contact: '联系人',
  payment: '缴费',
  appointment: '预约',
  service_order: '服务订单'
};

const formatFieldChange = (change, fieldNameMap) => {
  return {
    ...change,
    field_name_cn: fieldNameMap[change.field_name] || change.field_name
  };
};

const formatSnapshot = (snapshot) => {
  if (!snapshot) return snapshot;
  
  const fieldNameMap = getFieldNameMap(snapshot.resource_type);
  const formattedChanges = snapshot.field_changes 
    ? snapshot.field_changes.map(c => formatFieldChange(c, fieldNameMap))
    : [];
  
  return {
    ...snapshot,
    resource_type_name: resourceTypeNames[snapshot.resource_type] || snapshot.resource_type,
    field_changes: formattedChanges
  };
};

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, resource_type, resource_id, start_date, end_date, user_id } = req.query;
    
    let baseSql = \`
      SELECT s.*, 
             u.name as created_by_user_name,
             o.summary as operation_summary,
             o.action as operation_action
      FROM audit_snapshots s
      LEFT JOIN users u ON s.created_by = u.id
      LEFT JOIN operation_logs o ON s.operation_log_id = o.id
      WHERE 1=1
    \`;
    const params = [];

    if (resource_type) {
      baseSql += ' AND s.resource_type = ?';
      params.push(resource_type);
    }

    if (resource_id) {
      baseSql += ' AND s.resource_id = ?';
      params.push(resource_id);
    }

    if (user_id) {
      baseSql += ' AND s.created_by = ?';
      params.push(user_id);
    }

    if (start_date) {
      baseSql += ' AND DATE(s.created_at) >= ?';
      params.push(start_date);
    }

    if (end_date) {
      baseSql += ' AND DATE(s.created_at) <= ?';
      params.push(end_date);
    }

    const result = await paginateQuery(baseSql, params, page, pageSize, 's.created_at DESC, s.id DESC');
    
    const dataWithChanges = await Promise.all(
      result.data.map(async (snapshot) => {
        const fieldChanges = await all(\`
          SELECT * FROM audit_field_changes WHERE snapshot_id = ? ORDER BY id
        \`, [snapshot.id]);
        
        return formatSnapshot({
          ...snapshot,
          snapshot_data: JSON.parse(snapshot.snapshot_data),
          field_changes: fieldChanges
        });
      })
    );

    paginate(res, dataWithChanges, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/resource-types', authenticate, async (req, res) => {
  try {
    const types = Object.entries(resourceTypeNames).map(([value, label]) => ({
      value,
      label
    }));
    success(res, types);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const snapshot = await getSnapshotWithChanges(req.params.id);
    
    if (!snapshot) {
      return error(res, '审计快照不存在', 404);
    }

    success(res, formatSnapshot(snapshot));
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id/changes', authenticate, idParamValidation, async (req, res) => {
  try {
    const snapshot = await getSnapshotWithChanges(req.params.id);
    
    if (!snapshot) {
      return error(res, '审计快照不存在', 404);
    }

    const fieldNameMap = getFieldNameMap(snapshot.resource_type);
    const formattedChanges = snapshot.field_changes.map(c => formatFieldChange(c, fieldNameMap));

    success(res, {
      snapshot_id: snapshot.id,
      resource_type: snapshot.resource_type,
      resource_type_name: resourceTypeNames[snapshot.resource_type],
      resource_id: snapshot.resource_id,
      created_at: snapshot.created_at,
      created_by: snapshot.created_by_user_name,
      operation_summary: snapshot.operation_summary,
      operation_action: snapshot.operation_action,
      field_changes: formattedChanges
    });
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id/conflicts', authenticate, idParamValidation, async (req, res) => {
  try {
    const conflictCheck = await detectConflicts(req.params.id);
    
    const snapshot = await getSnapshotWithChanges(req.params.id);
    if (!snapshot) {
      return error(res, '审计快照不存在', 404);
    }

    const fieldNameMap = getFieldNameMap(snapshot.resource_type);
    const formattedConflicts = conflictCheck.conflicts.map(c => ({
      ...c,
      field_name_cn: c.field === 'record' ? '记录' : (fieldNameMap[c.field] || c.field)
    }));

    success(res, {
      has_conflict: conflictCheck.has_conflict,
      conflicts: formattedConflicts,
      current_data: conflictCheck.current_data
    });
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/resource/:resource_type/:resource_id', authenticate, async (req, res) => {
  try {
    const { resource_type, resource_id } = req.params;
    const { page = 1, pageSize = 20 } = req.query;

    if (!Object.values(AUDITED_RESOURCE_TYPES).includes(resource_type)) {
      return error(res, '不支持的资源类型', 400);
    }

    const result = await getSnapshotsByResource(resource_type, parseInt(resource_id), page, pageSize);
    
    const formattedData = result.data.map(snapshot => formatSnapshot(snapshot));

    paginate(res, formattedData, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/fields/:resource_type', authenticate, async (req, res) => {
  try {
    const { resource_type } = req.params;
    
    if (!Object.values(AUDITED_RESOURCE_TYPES).includes(resource_type)) {
      return error(res, '不支持的资源类型', 400);
    }

    const fieldNameMap = getFieldNameMap(resource_type);
    const fields = Object.entries(fieldNameMap).map(([key, label]) => ({
      key,
      label
    }));

    success(res, {
      resource_type,
      resource_type_name: resourceTypeNames[resource_type],
      fields
    });
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
`;

const filePath = path.join(__dirname, '..', 'routes', 'audit.js');
fs.writeFileSync(filePath, content, 'utf8');
console.log('File written successfully:', filePath);
console.log('Content length:', content.length);
