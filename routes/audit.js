const express = require('express');
const { paginateQuery, get, all } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { idParamValidation } = require('../middleware/validator');
const { getAuditTrail } = require('../utils/audit');

const router = express.Router();

const resourceTypeNames = {
  plot: '墓位',
  deceased: '逝者',
  contact: '联系人',
  payment: '缴费',
  appointment: '预约',
  service_order: '服务订单'
};

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
    resource_type_name: resourceTypeNames[snapshot.resource_type] || snapshot.resource_type
  };
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
    
    const formattedData = result.data.map(formatSnapshot);
    
    paginate(res, formattedData, result.total, pageNum, pageSizeNum);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/statistics', authenticate, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const start = start_date || defaultStart;
    const end = end_date || today;

    const totalStats = await get(`
      SELECT 
        COUNT(*) as total_snapshots,
        COUNT(DISTINCT resource_type || '-' || resource_id) as total_resources
      FROM audit_snapshots 
      WHERE DATE(created_at) BETWEEN ? AND ?
    `, [start, end]);

    const byResourceType = await all(`
      SELECT 
        as2.resource_type,
        COUNT(*) as snapshot_count,
        COUNT(DISTINCT as2.resource_id) as resource_count,
        SUM(CASE WHEN ol.action = 'create' THEN 1 ELSE 0 END) as create_count,
        SUM(CASE WHEN ol.action = 'update' THEN 1 ELSE 0 END) as update_count,
        SUM(CASE WHEN ol.action = 'delete' THEN 1 ELSE 0 END) as delete_count,
        SUM(CASE WHEN ol.action = 'status_change' THEN 1 ELSE 0 END) as status_change_count
      FROM audit_snapshots as2
      LEFT JOIN operation_logs ol ON as2.operation_log_id = ol.id
      WHERE DATE(as2.created_at) BETWEEN ? AND ?
      GROUP BY as2.resource_type
      ORDER BY snapshot_count DESC
    `, [start, end]);

    const byAction = await all(`
      SELECT 
        ol.action,
        COUNT(*) as count
      FROM audit_snapshots as2
      LEFT JOIN operation_logs ol ON as2.operation_log_id = ol.id
      WHERE DATE(as2.created_at) BETWEEN ? AND ?
      GROUP BY ol.action
      ORDER BY count DESC
    `, [start, end]);

    const byUser = await all(`
      SELECT 
        u.id,
        u.name,
        u.username,
        COUNT(*) as snapshot_count
      FROM audit_snapshots as2
      LEFT JOIN users u ON as2.created_by = u.id
      WHERE DATE(as2.created_at) BETWEEN ? AND ?
      GROUP BY u.id, u.name, u.username
      ORDER BY snapshot_count DESC
      LIMIT 10
    `, [start, end]);

    const fieldDiffStats = await get(`
      SELECT COUNT(*) as total_field_diffs
      FROM audit_field_diffs 
      WHERE DATE(created_at) BETWEEN ? AND ?
    `, [start, end]);

    const formattedByResourceType = byResourceType.map(item => ({
      ...item,
      resource_type_name: resourceTypeNames[item.resource_type] || item.resource_type
    }));

    success(res, {
      period: { start, end },
      summary: {
        ...totalStats,
        ...fieldDiffStats
      },
      byResourceType: formattedByResourceType,
      byAction,
      byUser
    }, '审计统计查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const snapshot = await get(`
      SELECT as2.*, ol.action, ol.summary, u.name as operator_name, u.username
      FROM audit_snapshots as2
      LEFT JOIN operation_logs ol ON as2.operation_log_id = ol.id
      LEFT JOIN users u ON as2.created_by = u.id
      WHERE as2.id = ?
    `, [req.params.id]);

    if (!snapshot) {
      return error(res, '快照不存在', 404);
    }

    const fieldDiffs = await all(`
      SELECT * FROM audit_field_diffs WHERE snapshot_id = ? ORDER BY id
    `, [snapshot.id]);

    const formattedSnapshot = formatSnapshot(snapshot);
    formattedSnapshot.field_diffs = fieldDiffs;

    success(res, formattedSnapshot);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/resource/:resourceType/:resourceId', authenticate, async (req, res) => {
  try {
    const { resourceType, resourceId } = req.params;
    const { page, pageSize } = req.query;
    
    const pageNum = page ? parseInt(page, 10) : 1;
    const pageSizeNum = pageSize ? parseInt(pageSize, 10) : 20;

    const result = await getAuditTrail(resourceType, parseInt(resourceId), pageNum, pageSizeNum);
    
    const formattedData = result.data.map(formatSnapshot);
    
    paginate(res, formattedData, result.total, pageNum, pageSizeNum);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/field-diffs/:snapshotId', authenticate, async (req, res) => {
  try {
    const { snapshotId } = req.params;
    
    const snapshot = await get('SELECT * FROM audit_snapshots WHERE id = ?', [snapshotId]);
    
    if (!snapshot) {
      return error(res, '快照不存在', 404);
    }

    const fieldDiffs = await all(`
      SELECT * FROM audit_field_diffs WHERE snapshot_id = ? ORDER BY id
    `, [snapshotId]);

    success(res, {
      snapshot_id: parseInt(snapshotId),
      resource_type: snapshot.resource_type,
      resource_id: snapshot.resource_id,
      field_diffs: fieldDiffs
    });
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
