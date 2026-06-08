const express = require('express');
const { run, get, all, paginateQuery, runInTransaction } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate, authorize } = require('../middleware/auth');
const { idParamValidation } = require('../middleware/validator');
const { detectConflicts, executeRollback, getSnapshotWithChanges, getFieldNameMap, RESOURCE_NAME_MAP } = require('../utils/audit');
const { logOperation } = require('../utils/operationLog');
const { body, query, validationResult } = require('express-validator');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, errors.array()[0].msg, 400);
  }
  next();
};

const rollbackRequestCreateValidation = [
  body('snapshot_id').isInt().withMessage('快照ID无效'),
  body('field_names').isArray({ min: 1 }).withMessage('字段名数组不能为空'),
  body('field_names.*').isString().withMessage('字段名必须是字符串'),
  body('reason').notEmpty().withMessage('回滚原因不能为空'),
  validate
];

const rollbackRequestQueryValidation = [
  query('status').optional({ checkFalsy: true }).isIn(['pending', 'approved', 'rejected', 'executed', 'failed', 'cancelled']).withMessage('状态无效'),
  query('resource_type').optional({ checkFalsy: true }).isIn(['plot', 'deceased', 'contact', 'payment', 'appointment', 'service_order', 'contract', 'maintenance_order']).withMessage('资源类型无效'),
  query('requester_id').optional({ checkFalsy: true }).isInt().withMessage('申请人ID无效'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('页码无效'),
  query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).withMessage('每页数量无效'),
  validate
];

const rollbackApproveValidation = [
  body('approval_remark').optional({ checkFalsy: true }).isString().withMessage('审批备注必须是字符串'),
  validate
];

const rollbackRejectValidation = [
  body('approval_remark').notEmpty().withMessage('拒绝原因不能为空'),
  validate
];

const statusNames = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已拒绝',
  executed: '已执行',
  failed: '执行失败',
  cancelled: '已取消'
};

const parseFieldChanges = (fieldChangesStr) => {
  try {
    const parsed = JSON.parse(fieldChangesStr || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

const parseConflictInfo = (conflictInfoStr) => {
  if (!conflictInfoStr) return null;
  try {
    return JSON.parse(conflictInfoStr);
  } catch (e) {
    return null;
  }
};

router.post('/', authenticate, authorize('admin', 'staff'), rollbackRequestCreateValidation, async (req, res) => {
  try {
    const { snapshot_id, field_names, reason } = req.body;

    const fieldNames = Array.isArray(field_names) ? field_names : [];
    if (fieldNames.length === 0) {
      return error(res, '字段名数组不能为空', 400);
    }

    const snapshot = await getSnapshotWithChanges(snapshot_id);
    if (!snapshot) {
      return error(res, '快照不存在', 404);
    }

    const availableFieldNames = snapshot.field_changes.map(fc => fc.field_name);
    const invalidFields = fieldNames.filter(f => !availableFieldNames.includes(f));
    if (invalidFields.length > 0) {
      return error(res, `以下字段不属于该快照: ${invalidFields.join(', ')}`, 400);
    }

    const existingPending = await get(`
      SELECT id FROM rollback_requests 
      WHERE snapshot_id = ? AND status = 'pending'
      LIMIT 1
    `, [snapshot_id]);

    if (existingPending) {
      return error(res, '该快照已有待审批的回滚申请', 400);
    }

    const requestId = await runInTransaction(async () => {
      const result = await run(
        `INSERT INTO rollback_requests 
         (snapshot_id, field_changes, resource_type, resource_id, reason, status, 
          requester_id, requester_name) 
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          snapshot_id,
          JSON.stringify(fieldNames),
          snapshot.resource_type,
          snapshot.resource_id,
          reason,
          req.user.id,
          req.user.name
        ]
      );

      return result.id;
    });

    await logOperation(req, snapshot.resource_type, snapshot.resource_id, 'update',
      `提交回滚申请: ${reason}`);

    success(res, { id: requestId }, '回滚申请提交成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/', authenticate, rollbackRequestQueryValidation, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status, resource_type, requester_id } = req.query;

    let baseSql = `
      SELECT rr.*,
             as2.created_at as snapshot_created_at,
             as2.created_by_name as snapshot_created_by_name
      FROM rollback_requests rr
      LEFT JOIN audit_snapshots as2 ON rr.snapshot_id = as2.id
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role !== 'admin') {
      baseSql += ' AND rr.requester_id = ?';
      params.push(req.user.id);
    }

    if (status) {
      baseSql += ' AND rr.status = ?';
      params.push(status);
    }

    if (resource_type) {
      baseSql += ' AND rr.resource_type = ?';
      params.push(resource_type);
    }

    if (requester_id) {
      if (req.user.role === 'admin' || parseInt(requester_id) === req.user.id) {
        baseSql += ' AND rr.requester_id = ?';
        params.push(requester_id);
      }
    }

    const result = await paginateQuery(baseSql, params, page, pageSize, 'rr.created_at DESC, rr.id DESC');

    const formattedData = result.data.map(item => ({
      ...item,
      resource_type_name: RESOURCE_NAME_MAP[item.resource_type] || item.resource_type,
      status_name: statusNames[item.status] || item.status,
      field_changes: parseFieldChanges(item.field_changes),
      conflict_info: parseConflictInfo(item.conflict_info)
    }));

    paginate(res, formattedData, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;

    const request = await get(`
      SELECT rr.*,
             as2.snapshot_data,
             as2.created_at as snapshot_created_at,
             as2.created_by_name as snapshot_created_by_name,
             u1.name as requester_name_full,
             u2.name as approver_name_full
      FROM rollback_requests rr
      LEFT JOIN audit_snapshots as2 ON rr.snapshot_id = as2.id
      LEFT JOIN users u1 ON rr.requester_id = u1.id
      LEFT JOIN users u2 ON rr.approver_id = u2.id
      WHERE rr.id = ?
    `, [id]);

    if (!request) {
      return error(res, '回滚申请不存在', 404);
    }

    if (req.user.role !== 'admin' && request.requester_id !== req.user.id) {
      return error(res, '权限不足', 403);
    }

    const fieldNames = parseFieldChanges(request.field_changes);
    let fieldChanges = [];
    if (fieldNames.length > 0) {
      const placeholders = fieldNames.map(() => '?').join(', ');
      fieldChanges = await all(
        `SELECT * FROM audit_field_changes WHERE snapshot_id = ? AND field_name IN (${placeholders}) ORDER BY id`,
        [request.snapshot_id, ...fieldNames]
      );
    }

    const approvals = await all(`
      SELECT ra.*
      FROM rollback_approvals ra
      WHERE ra.rollback_request_id = ?
      ORDER BY ra.created_at DESC
    `, [id]);

    if (request.snapshot_data) {
      try {
        request.snapshot_data = JSON.parse(request.snapshot_data);
      } catch (e) {
      }
    }

    request.resource_type_name = RESOURCE_NAME_MAP[request.resource_type] || request.resource_type;
    request.status_name = statusNames[request.status] || request.status;
    request.field_changes_parsed = fieldChanges;
    request.field_names = fieldNames;
    request.approvals = approvals;
    request.conflict_info = parseConflictInfo(request.conflict_info);

    success(res, request);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/approve', authenticate, authorize('admin'), idParamValidation, rollbackApproveValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { approval_remark } = req.body;

    const request = await get('SELECT * FROM rollback_requests WHERE id = ?', [id]);
    if (!request) {
      return error(res, '回滚申请不存在', 404);
    }

    if (request.status !== 'pending') {
      return error(res, '该申请状态不是待审批，无法审批', 400);
    }

    const fieldNames = parseFieldChanges(request.field_changes);

    const conflictCheck = await detectConflicts(request.snapshot_id, fieldNames);
    if (conflictCheck.has_conflict) {
      await run(
        `UPDATE rollback_requests SET conflict_info = ? WHERE id = ?`,
        [JSON.stringify(conflictCheck), id]
      );
      return error(res, '检测到数据冲突，请先处理冲突后再审批', 400);
    }

    const rollbackResult = await executeRollback(request.snapshot_id, fieldNames, req.user.id, req.user.name);
    if (!rollbackResult.success) {
      await runInTransaction(async () => {
        await run(
          `UPDATE rollback_requests 
           SET status = 'failed', approver_id = ?, approver_name = ?, 
               approved_at = CURRENT_TIMESTAMP, approval_remark = ?,
               conflict_info = ?
           WHERE id = ?`,
          [req.user.id, req.user.name, approval_remark || '', JSON.stringify(rollbackResult), id]
        );

        await run(
          `INSERT INTO rollback_approvals 
           (rollback_request_id, approval_action, approval_remark, approver_id, approver_name) 
           VALUES (?, 'approve', ?, ?, ?)`,
          [id, approval_remark || '', req.user.id, req.user.name]
        );
      });

      return error(res, `回滚执行失败: ${rollbackResult.error}`, 400);
    }

    await runInTransaction(async () => {
      await run(
        `UPDATE rollback_requests 
         SET status = 'executed', approver_id = ?, approver_name = ?, 
             approved_at = CURRENT_TIMESTAMP, approval_remark = ?,
             executed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [req.user.id, req.user.name, approval_remark || '', id]
      );

      await run(
        `INSERT INTO rollback_approvals 
         (rollback_request_id, approval_action, approval_remark, approver_id, approver_name) 
         VALUES (?, 'approve', ?, ?, ?)`,
        [id, approval_remark || '', req.user.id, req.user.name]
      );
    });

    const fieldNameMap = getFieldNameMap(request.resource_type);
    const restoredFieldNames = rollbackResult.restoredFields?.map(f => fieldNameMap[f.field] || f.field).join(', ') || '';
    const summary = `审批通过并执行回滚，恢复字段: ${restoredFieldNames}`;
    await logOperation(req, request.resource_type, request.resource_id, 'update', summary, rollbackResult.rollbackSnapshotId);

    success(res, { restored_fields: rollbackResult.restoredFields }, '审批通过，回滚执行成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/reject', authenticate, authorize('admin'), idParamValidation, rollbackRejectValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { approval_remark } = req.body;

    const request = await get('SELECT * FROM rollback_requests WHERE id = ?', [id]);
    if (!request) {
      return error(res, '回滚申请不存在', 404);
    }

    if (request.status !== 'pending') {
      return error(res, '该申请状态不是待审批，无法审批', 400);
    }

    await runInTransaction(async () => {
      await run(
        `UPDATE rollback_requests 
         SET status = 'rejected', approver_id = ?, approver_name = ?, 
             approved_at = CURRENT_TIMESTAMP, approval_remark = ?
         WHERE id = ?`,
        [req.user.id, req.user.name, approval_remark || '', id]
      );

      await run(
        `INSERT INTO rollback_approvals 
         (rollback_request_id, approval_action, approval_remark, approver_id, approver_name) 
         VALUES (?, 'reject', ?, ?, ?)`,
        [id, approval_remark || '', req.user.id, req.user.name]
      );
    });

    const summary = `回滚申请被拒绝: ${approval_remark || ''}`;
    await logOperation(req, request.resource_type, request.resource_id, 'update', summary);

    success(res, null, '审批拒绝成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/cancel', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;

    const request = await get('SELECT * FROM rollback_requests WHERE id = ?', [id]);
    if (!request) {
      return error(res, '回滚申请不存在', 404);
    }

    if (request.status !== 'pending') {
      return error(res, '该申请状态不是待审批，无法取消', 400);
    }

    if (request.requester_id !== req.user.id) {
      return error(res, '只能取消自己提交的申请', 403);
    }

    await run(
      `UPDATE rollback_requests SET status = 'cancelled' WHERE id = ?`,
      [id]
    );

    const summary = `取消回滚申请`;
    await logOperation(req, request.resource_type, request.resource_id, 'update', summary);

    success(res, null, '取消申请成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/execute', authenticate, authorize('admin'), idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;

    const request = await get('SELECT * FROM rollback_requests WHERE id = ?', [id]);
    if (!request) {
      return error(res, '回滚申请不存在', 404);
    }

    if (request.status !== 'approved') {
      return error(res, '该申请未通过审批，无法执行', 400);
    }

    if (request.executed_at) {
      return error(res, '该回滚申请已执行过', 400);
    }

    const fieldNames = parseFieldChanges(request.field_changes);

    const conflictCheck = await detectConflicts(request.snapshot_id, fieldNames);
    if (conflictCheck.has_conflict) {
      await run(
        `UPDATE rollback_requests SET conflict_info = ? WHERE id = ?`,
        [JSON.stringify(conflictCheck), id]
      );
      return error(res, '检测到数据冲突，请先处理冲突后再执行', 400);
    }

    const rollbackResult = await executeRollback(request.snapshot_id, fieldNames, req.user.id, req.user.name);

    if (!rollbackResult.success) {
      await run(
        `UPDATE rollback_requests SET status = 'failed', conflict_info = ? WHERE id = ?`,
        [JSON.stringify(rollbackResult), id]
      );
      return error(res, `回滚执行失败: ${rollbackResult.error}`, 400);
    }

    await run(
      `UPDATE rollback_requests SET status = 'executed', executed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );

    const fieldNameMap = getFieldNameMap(request.resource_type);
    const restoredFieldNames = rollbackResult.restoredFields?.map(f => fieldNameMap[f.field] || f.field).join(', ') || '';
    const summary = `执行回滚，恢复字段: ${restoredFieldNames}`;
    await logOperation(req, request.resource_type, request.resource_id, 'update', summary, rollbackResult.rollbackSnapshotId);

    success(res, { restored_fields: rollbackResult.restoredFields }, '回滚执行成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id/conflicts', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;

    const request = await get('SELECT * FROM rollback_requests WHERE id = ?', [id]);
    if (!request) {
      return error(res, '回滚申请不存在', 404);
    }

    if (req.user.role !== 'admin' && request.requester_id !== req.user.id) {
      return error(res, '权限不足', 403);
    }

    const fieldNames = parseFieldChanges(request.field_changes);
    const conflictCheck = await detectConflicts(request.snapshot_id, fieldNames);

    success(res, conflictCheck);
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
