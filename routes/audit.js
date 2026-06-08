const express = require('express');
const { paginateQuery, get, all } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { idParamValidation } = require('../middleware/validator');
const {
  getSnapshotWithChanges,
  getSnapshotsByResource,
  getFieldNameMap,
  RESOURCE_NAME_MAP,
  AUDITED_RESOURCE_TYPES,
  AUDITED_FIELDS,
  detectConflicts
} = require('../utils/audit');

const router = express.Router();

const formatSnapshot = (snapshot) => {
  if (!snapshot) return snapshot;
  if (snapshot.snapshot_data) {
    try {
      snapshot.snapshot_data = JSON.parse(snapshot.snapshot_data);
    } catch (e) {
    }
  }
  return {
    ...snapshot,
    resource_type_name: RESOURCE_NAME_MAP[snapshot.resource_type] || snapshot.resource_type
  };
};

const formatFieldChanges = (fieldChanges, resourceType) => {
  const fieldNameMap = getFieldNameMap(resourceType);
  return fieldChanges.map(change => ({
    ...change,
    field_name_cn: fieldNameMap[change.field_name] || change.field_name
  }));
};

router.get('/', authenticate, async (req, res) => {
  try {
    const { page, pageSize, resource_type, resource_id, user_id, start_date, end_date } = req.query;
    
    const pageNum = page ? parseInt(page, 10) : 1;
    const pageSizeNum = pageSize ? parseInt(pageSize, 10) : 10;
    const resourceType = resource_type || '';
    const resourceId = resource_id || '';
    const userId = user_id || '';
    const startDate = start_date || '';
    const endDate = end_date || '';

    let baseSql = `
      SELECT as2.*, ol.action, ol.summary, u.name as operator_name, u.username
      FROM audit_snapshots as2
      LEFT JOIN operation_logs ol ON as2.operation_log_id = ol.id
      LEFT JOIN users u ON as2.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (resourceType) {
      baseSql += ' AND as2.resource_type = ?';
      params.push(resourceType);
    }

    if (resourceId) {
      baseSql += ' AND as2.resource_id = ?';
      params.push(resourceId);
    }

    if (userId) {
      baseSql += ' AND as2.created_by = ?';
      params.push(userId);
    }

    if (startDate) {
      baseSql += ' AND DATE(as2.created_at) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      baseSql += ' AND DATE(as2.created_at) <= ?';
      params.push(endDate);
    }

    const result = await paginateQuery(baseSql, params, pageNum, pageSizeNum, 'as2.created_at DESC, as2.id DESC');
    
    const formattedData = result.data.map(snapshot => {
      const formatted = formatSnapshot(snapshot);
      if (formatted.field_changes) {
        formatted.field_changes = formatFieldChanges(formatted.field_changes, formatted.resource_type);
      }
      return formatted;
    });
    
    paginate(res, formattedData, result.total, pageNum, pageSizeNum);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/resource-types', authenticate, async (req, res) => {
  try {
    const resourceTypes = Object.values(AUDITED_RESOURCE_TYPES);
    const result = resourceTypes.map(type => ({
      value: type,
      label: RESOURCE_NAME_MAP[type] || type,
      fields: AUDITED_FIELDS[type] || [],
      field_name_map: getFieldNameMap(type)
    }));
    success(res, result, '资源类型查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const snapshotId = parseInt(req.params.id);
    const snapshot = await getSnapshotWithChanges(snapshotId);

    if (!snapshot) {
      return error(res, '快照不存在', 404);
    }

    const formattedSnapshot = formatSnapshot(snapshot);
    formattedSnapshot.field_changes = formatFieldChanges(formattedSnapshot.field_changes, formattedSnapshot.resource_type);
    formattedSnapshot.field_name_map = getFieldNameMap(formattedSnapshot.resource_type);

    success(res, formattedSnapshot);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id/changes', authenticate, idParamValidation, async (req, res) => {
  try {
    const snapshotId = parseInt(req.params.id);
    const snapshot = await get('SELECT * FROM audit_snapshots WHERE id = ?', [snapshotId]);
    
    if (!snapshot) {
      return error(res, '快照不存在', 404);
    }

    const fieldChanges = await all(`
      SELECT * FROM audit_field_changes WHERE snapshot_id = ? ORDER BY id
    `, [snapshotId]);

    const formattedChanges = formatFieldChanges(fieldChanges, snapshot.resource_type);

    success(res, {
      snapshot_id: snapshotId,
      resource_type: snapshot.resource_type,
      resource_id: snapshot.resource_id,
      resource_type_name: RESOURCE_NAME_MAP[snapshot.resource_type] || snapshot.resource_type,
      field_changes: formattedChanges,
      field_name_map: getFieldNameMap(snapshot.resource_type)
    });
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id/conflicts', authenticate, idParamValidation, async (req, res) => {
  try {
    const snapshotId = parseInt(req.params.id);
    const { field_names } = req.query;
    const fieldNames = field_names ? field_names.split(',').filter(Boolean) : [];
    
    const conflictsResult = await detectConflicts(snapshotId, fieldNames);

    if (conflictsResult.conflicts && conflictsResult.conflicts.length > 0) {
      const snapshot = await get('SELECT resource_type FROM audit_snapshots WHERE id = ?', [snapshotId]);
      const fieldNameMap = snapshot ? getFieldNameMap(snapshot.resource_type) : {};
      
      conflictsResult.conflicts = conflictsResult.conflicts.map(conflict => ({
        ...conflict,
        field_name_cn: fieldNameMap[conflict.field] || conflict.field
      }));
    }

    success(res, conflictsResult);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/resource/:resource_type/:resource_id', authenticate, async (req, res) => {
  try {
    const { resource_type, resource_id } = req.params;
    const { page, pageSize } = req.query;
    
    const pageNum = page ? parseInt(page, 10) : 1;
    const pageSizeNum = pageSize ? parseInt(pageSize, 10) : 20;

    const result = await getSnapshotsByResource(resource_type, parseInt(resource_id), pageNum, pageSizeNum);
    
    const formattedData = result.data.map(snapshot => {
      const formatted = formatSnapshot(snapshot);
      formatted.field_changes = formatFieldChanges(formatted.field_changes, formatted.resource_type);
      return formatted;
    });
    
    paginate(res, formattedData, result.total, pageNum, pageSizeNum);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/fields/:resource_type', authenticate, async (req, res) => {
  try {
    const { resource_type } = req.params;
    const fieldNameMap = getFieldNameMap(resource_type);
    const auditedFields = AUDITED_FIELDS[resource_type] || [];
    
    const fields = auditedFields.map(field => ({
      field_name: field,
      field_name_cn: fieldNameMap[field] || field
    }));

    success(res, {
      resource_type,
      resource_type_name: RESOURCE_NAME_MAP[resource_type] || resource_type,
      fields,
      field_name_map: fieldNameMap
    }, '字段查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
