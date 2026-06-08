const express = require('express');
const { run, get, all, paginateQuery, runInTransaction } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate, authorize } = require('../middleware/auth');
const { idParamValidation } = require('../middleware/validator');
const { checkForConflicts, executeRollback } = require('../utils/audit');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');
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
  body('field_diff_ids').notEmpty().withMessage('字段差异ID不能为空'),
  body('reason').notEmpty().withMessage('回滚原因不能为空'),
  validate
];

const rollbackRequestQueryValidation = [
  query('status').optional({ checkFalsy: true }).isIn(['pending', 'approved', 'rejected', 'executed', 'failed']).withMessage('状态无效'),
  query('resource_type').optional({ checkFalsy: true }).isIn(['plot', 'deceased', 'contact', 'payment', 'appointment', 'service_order', 'contract', 'maintenance_order']).withMessage('资源类型无效'),
  query('requested_by').optional({ checkFalsy: true }).isInt().withMessage('申请人ID无效'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('页码无效'),
  query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).withMessage('每页数量无效'),
  validate
];

const rollbackApproveValidation = [
  body('approval_action').isIn(['approve', 'reject']).withMessage('审批操作无效，只能是 approve 或 reject'),
  body('review_remark').optional({ checkFalsy: true }).isString().withMessage('审批备注必须是字符串'),
  validate
];

const resourceTypeNames = {
  plot: '墓位',
  deceased: '逝者',
  contact: '联系人',
  payment: '缴费',
  appointment: '预约',
  service_order: '服务订单',
  contract: '合同',
  maintenance_order: '维修工单'
};

const statusNames = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已拒绝',
  executed: '已执行',
  failed: '执行失败'
};

const parseFieldDiffIds = (fieldDiffIdsStr) => {
  return (fieldDiffIdsStr || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id) && id > 0);
};

router.post('/', authenticate, authorize('admin', 'staff'), rollbackRequestCreateValidation, async (req, res) => {
  try {
    const { snapshot_id, field_diff_ids, reason } = req.body;
    
    const fieldDiffIds = parseFieldDiffIds(field_diff_ids);
    if (fieldDiffIds.length === 0) {
      return error(res, '字段差异ID格式无效', 400);
    }
    
    const snapshot = await get('SELECT * FROM audit_snapshots WHERE id = ?', [snapshot_id]);
    if (!snapshot) {
      return error(res, '快照不存在', 404);
    }
    
    const placeholders = fieldDiffIds.map(() => '?').join(', ');
    const diffs = await all(
      `SELECT * FROM audit_field_diffs WHERE snapshot_id = ? AND id IN (${placeholders})`,
      [snapshot_id, ...fieldDiffIds]
    );
    
    if (diffs.length !== fieldDiffIds.length) {
      return error(res, '部分字段差异不属于该快照', 400);
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
         (snapshot_id, field_diff_ids, resource_type, resource_id, reason, status, 
          requested_by, requested_by_name) 
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          snapshot_id,
          field_diff_ids,
          snapshot.resource_type,
          snapshot.resource_id,
          reason,
          req.user.id,
          req.user.name
        ]
      );
      
      return result.id;
    });
    
    const summary = generateSummary(snapshot.resource_type, 'update', { reason }, null);
    await logOperation(req, snapshot.resource_type, snapshot.resource_id, 'update', 
      `提交回滚申请: ${reason}`);
    
    success(res, { id: requestId }, '回滚申请提交成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/', authenticate, rollbackRequestQueryValidation, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status, resource_type, requested_by } = req.query;
    
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
      baseSql += ' AND rr.requested_by = ?';
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
    
    if (requested_by) {
      if (req.user.role === 'admin' || parseInt(requested_by) === req.user.id) {
        baseSql += ' AND rr.requested_by = ?';
        params.push(requested_by);
      }
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'rr.created_at DESC, rr.id DESC');
    
    const formattedData = result.data.map(item => ({
      ...item,
      resource_type_name: resourceTypeNames[item.resource_type] || item.resource_type,
      status_name: statusNames[item.status] || item.status
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
             u1.name as requested_by_name_full,
             u2.name as reviewed_by_name_full
      FROM rollback_requests rr
      LEFT JOIN audit_snapshots as2 ON rr.snapshot_id = as2.id
      LEFT JOIN users u1 ON rr.requested_by = u1.id
      LEFT JOIN users u2 ON rr.reviewed_by = u2.id
      WHERE rr.id = ?
    `, [id]);
    
    if (!request) {
      return error(res, '回滚申请不存在', 404);
    }
    
    if (req.user.role !== 'admin' && request.requested_by !== req.user.id) {
      return error(res, '权限不足', 403);
    }
    
    const fieldDiffIds = parseFieldDiffIds(request.field_diff_ids);
    let fieldDiffs = [];
    if (fieldDiffIds.length > 0) {
      const placeholders = fieldDiffIds.map(() => '?').join(', ');
      fieldDiffs = await all(
        `SELECT * FROM audit_field_diffs WHERE id IN (${placeholders}) ORDER BY id`,
        fieldDiffIds
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
    
    request.resource_type_name = resourceTypeNames[request.resource_type] || request.resource_type;
    request.status_name = statusNames[request.status] || request.status;
    request.field_diffs = fieldDiffs;
    request.approvals = approvals;
    
    success(res, request);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/:id/approve', authenticate, authorize('admin'), idParamValidation, rollbackApproveValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { approval_action, review_remark } = req.body;
    
    const request = await get('SELECT * FROM rollback_requests WHERE id = ?', [id]);
    if (!request) {
      return error(res, '回滚申请不存在', 404);
    }
    
    if (request.status !== 'pending') {
      return error(res, '该申请状态不是待审批，无法审批', 400);
    }
    
    const fieldDiffIds = parseFieldDiffIds(request.field_diff_ids);
    
    if (approval_action === 'approve') {
      const conflictCheck = await checkForConflicts(request.snapshot_id, fieldDiffIds);
      if (conflictCheck.hasConflict) {
        return error(res, '检测到数据冲突，请先处理冲突后再审批', 400);
      }
      
      const rollbackResult = await executeRollback(id, req.user.id, req.user.name);
      if (!rollbackResult.success) {
        await runInTransaction(async () => {
          await run(
            `UPDATE rollback_requests 
             SET status = 'failed', reviewed_by = ?, reviewed_by_name = ?, 
                 reviewed_at = CURRENT_TIMESTAMP, review_remark = ?,
                 rollback_result = ?
             WHERE id = ?`,
            [req.user.id, req.user.name, review_remark || '', rollbackResult.error, id]
          );
          
          await run(
            `INSERT INTO rollback_approvals 
             (rollback_request_id, approval_action, approval_remark, approved_by, approved_by_name) 
             VALUES (?, 'approve', ?, ?, ?)`,
            [id, review_remark || '', req.user.id, req.user.name]
          );
        });
        
        return error(res, `回滚执行失败: ${rollbackResult.error}`, 400);
      }
      
      await runInTransaction(async () => {
        await run(
          `UPDATE rollback_requests 
           SET status = 'executed', reviewed_by = ?, reviewed_by_name = ?, 
               reviewed_at = CURRENT_TIMESTAMP, review_remark = ?
           WHERE id = ?`,
          [req.user.id, req.user.name, review_remark || '', id]
        );
        
        await run(
          `INSERT INTO rollback_approvals 
           (rollback_request_id, approval_action, approval_remark, approved_by, approved_by_name) 
           VALUES (?, 'approve', ?, ?, ?)`,
          [id, review_remark || '', req.user.id, req.user.name]
        );
      });
      
      const summary = `审批通过并执行回滚，恢复字段: ${rollbackResult.restoredFields?.map(f => f.field).join(', ') || ''}`;
      await logOperation(req, request.resource_type, request.resource_id, 'update', summary);
      
      success(res, { restored_fields: rollbackResult.restoredFields }, '审批通过，回滚执行成功');
    } else {
      await runInTransaction(async () => {
        await run(
          `UPDATE rollback_requests 
           SET status = 'rejected', reviewed_by = ?, reviewed_by_name = ?, 
               reviewed_at = CURRENT_TIMESTAMP, review_remark = ?
           WHERE id = ?`,
          [req.user.id, req.user.name, review_remark || '', id]
        );
        
        await run(
          `INSERT INTO rollback_approvals 
           (rollback_request_id, approval_action, approval_remark, approved_by, approved_by_name) 
           VALUES (?, 'reject', ?, ?, ?)`,
          [id, review_remark || '', req.user.id, req.user.name]
        );
      });
      
      const summary = `回滚申请被拒绝: ${review_remark || ''}`;
      await logOperation(req, request.resource_type, request.resource_id, 'update', summary);
      
      success(res, null, '审批拒绝成功');
    }
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id/conflicts', authenticate, authorize('admin'), idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const request = await get('SELECT * FROM rollback_requests WHERE id = ?', [id]);
    if (!request) {
      return error(res, '回滚申请不存在', 404);
    }
    
    const fieldDiffIds = parseFieldDiffIds(request.field_diff_ids);
    const conflictCheck = await checkForConflicts(request.snapshot_id, fieldDiffIds);
    
    success(res, conflictCheck);
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
    
    if (request.rollback_executed_at) {
      return error(res, '该回滚申请已执行过', 400);
    }
    
    const rollbackResult = await executeRollback(id, req.user.id, req.user.name);
    
    if (!rollbackResult.success) {
      await run(
        `UPDATE rollback_requests SET status = 'failed', rollback_result = ? WHERE id = ?`,
        [rollbackResult.error, id]
      );
      return error(res, `回滚执行失败: ${rollbackResult.error}`, 400);
    }
    
    const summary = `执行回滚，恢复字段: ${rollbackResult.restoredFields?.map(f => f.field).join(', ') || ''}`;
    await logOperation(req, request.resource_type, request.resource_id, 'update', summary);
    
    success(res, { restored_fields: rollbackResult.restoredFields }, '回滚执行成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
