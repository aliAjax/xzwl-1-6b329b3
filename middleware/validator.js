const { body, param, query, validationResult } = require('express-validator');
const { error } = require('../utils/response');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, errors.array()[0].msg, 400);
  }
  next();
};

const loginValidation = [
  body('username').notEmpty().withMessage('用户名不能为空'),
  body('password').notEmpty().withMessage('密码不能为空'),
  validate
];

const userCreateValidation = [
  body('username').notEmpty().withMessage('用户名不能为空'),
  body('password').notEmpty().withMessage('密码不能为空'),
  body('name').notEmpty().withMessage('姓名不能为空'),
  body('role').isIn(['admin', 'staff']).withMessage('角色无效'),
  validate
];

const plotCreateValidation = [
  body('plot_number').notEmpty().withMessage('墓位编号不能为空'),
  body('area').notEmpty().withMessage('区域不能为空'),
  body('row').isInt().withMessage('排号必须是数字'),
  body('col').isInt().withMessage('列号必须是数字'),
  validate
];

const deceasedCreateValidation = [
  body('name').notEmpty().withMessage('逝者姓名不能为空'),
  validate
];

const contactCreateValidation = [
  body('name').notEmpty().withMessage('联系人姓名不能为空'),
  body('phone').notEmpty().withMessage('联系电话不能为空'),
  validate
];

const paymentCreateValidation = [
  body('plot_id').isInt().withMessage('墓位ID无效'),
  body('amount').isFloat({ min: 0 }).withMessage('金额无效'),
  validate
];

const appointmentCreateValidation = [
  body('appointment_date').notEmpty().withMessage('预约日期不能为空'),
  validate
];

const visitRecordCreateValidation = [
  body('type').isIn(['来访', '电话']).withMessage('记录类型无效'),
  body('visit_date').notEmpty().withMessage('访问日期不能为空'),
  body('content').notEmpty().withMessage('沟通内容不能为空'),
  validate
];

const idParamValidation = [
  param('id').isInt().withMessage('ID无效'),
  validate
];

const serviceItemCreateValidation = [
  body('name').notEmpty().withMessage('服务名称不能为空'),
  body('category').notEmpty().withMessage('服务分类不能为空'),
  body('price').isFloat({ min: 0 }).withMessage('价格无效'),
  validate
];

const serviceOrderCreateValidation = [
  body('service_item_id').isInt().withMessage('服务项目ID无效'),
  body('quantity').isInt({ min: 1 }).withMessage('数量无效'),
  validate
];

const serviceOrderStatusValidation = [
  body('status').isIn(['待处理', '处理中', '已完成', '已取消']).withMessage('状态无效'),
  validate
];

const importPreviewValidation = [
  body('type').isIn(['plot', 'contact']).withMessage('导入类型无效，只能是 plot 或 contact'),
  body('data').isArray({ min: 1 }).withMessage('导入数据不能为空且必须是数组'),
  validate
];

const importConfirmValidation = [
  body('import_token').notEmpty().withMessage('import_token 不能为空'),
  validate
];

const operationLogQueryValidation = [
  query('resource_type').optional({ checkFalsy: true }).isIn(['plot', 'deceased', 'contact', 'payment', 'appointment', 'visit_record', 'bill_batch', 'reminder_batch', 'maintenance_order']).withMessage('资源类型无效'),
  query('user_id').optional({ checkFalsy: true }).isInt().withMessage('操作人ID无效'),
  query('start_date').optional({ checkFalsy: true }).isISO8601().withMessage('开始日期格式无效'),
  query('end_date').optional({ checkFalsy: true }).isISO8601().withMessage('结束日期格式无效'),
  query('action').optional({ checkFalsy: true }).isIn(['create', 'update', 'delete', 'status_change']).withMessage('操作类型无效'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('页码无效'),
  query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).withMessage('每页数量无效'),
  validate
];

const billPreviewValidation = [
  body('bill_year').isInt({ min: 2000, max: 2100 }).withMessage('账单年度无效，范围2000-2100'),
  body('fee_standard').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('收费标准无效'),
  body('area').optional({ checkFalsy: true }).notEmpty().withMessage('区域不能为空'),
  body('plot_ids').optional({ checkFalsy: true }).isArray().withMessage('墓位ID列表必须是数组'),
  validate
];

const billGenerateValidation = [
  body('bill_year').isInt({ min: 2000, max: 2100 }).withMessage('账单年度无效，范围2000-2100'),
  body('fee_standard').isFloat({ min: 0 }).withMessage('收费标准无效'),
  body('area').optional({ checkFalsy: true }).notEmpty().withMessage('区域不能为空'),
  body('plot_ids').optional({ checkFalsy: true }).isArray().withMessage('墓位ID列表必须是数组'),
  body('remark').optional({ checkFalsy: true }).isString().withMessage('备注必须是字符串'),
  validate
];

const billBatchQueryValidation = [
  query('bill_year').optional({ checkFalsy: true }).isInt({ min: 2000, max: 2100 }).withMessage('账单年度无效'),
  query('status').optional({ checkFalsy: true }).isIn(['processing', 'completed', 'failed']).withMessage('状态无效'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('页码无效'),
  query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).withMessage('每页数量无效'),
  validate
];

const billConfigUpdateValidation = [
  body('default_annual_fee').isFloat({ min: 0 }).withMessage('默认年度管理费无效'),
  validate
];

const reminderGenerateValidation = [
  body('reminder_days').optional({ checkFalsy: true }).isInt({ min: 1, max: 365 }).withMessage('提醒天数无效，范围1-365'),
  body('area').optional({ checkFalsy: true }).notEmpty().withMessage('区域不能为空'),
  body('plot_ids').optional({ checkFalsy: true }).isArray().withMessage('墓位ID列表必须是数组'),
  body('remark').optional({ checkFalsy: true }).isString().withMessage('备注必须是字符串'),
  validate
];

const reminderBatchQueryValidation = [
  query('start_date').optional({ checkFalsy: true }).isISO8601().withMessage('开始日期格式无效'),
  query('end_date').optional({ checkFalsy: true }).isISO8601().withMessage('结束日期格式无效'),
  query('status').optional({ checkFalsy: true }).isIn(['processing', 'completed', 'failed']).withMessage('状态无效'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('页码无效'),
  query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).withMessage('每页数量无效'),
  validate
];

const reminderDetailQueryValidation = [
  query('contact_name').optional({ checkFalsy: true }).notEmpty().withMessage('联系人姓名不能为空'),
  query('contact_phone').optional({ checkFalsy: true }).notEmpty().withMessage('联系电话不能为空'),
  query('plot_number').optional({ checkFalsy: true }).notEmpty().withMessage('墓位编号不能为空'),
  query('is_exception').optional({ checkFalsy: true }).isIn(['0', '1']).withMessage('异常标记无效'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('页码无效'),
  query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).withMessage('每页数量无效'),
  validate
];

const maintenanceOrderCreateValidation = [
  body('plot_id').isInt().withMessage('墓位ID无效'),
  body('reason').notEmpty().withMessage('维修原因不能为空'),
  body('plan_date').optional({ checkFalsy: true }).isISO8601().withMessage('计划完成日期格式无效'),
  body('handler_id').optional({ checkFalsy: true }).isInt().withMessage('处理人ID无效'),
  body('remark').optional({ checkFalsy: true }).isString().withMessage('备注必须是字符串'),
  validate
];

const maintenanceOrderQueryValidation = [
  query('status').optional({ checkFalsy: true }).isIn(['待处理', '处理中', '已完成', '已取消']).withMessage('状态无效'),
  query('plot_id').optional({ checkFalsy: true }).isInt().withMessage('墓位ID无效'),
  query('handler_id').optional({ checkFalsy: true }).isInt().withMessage('处理人ID无效'),
  query('start_date').optional({ checkFalsy: true }).isISO8601().withMessage('开始日期格式无效'),
  query('end_date').optional({ checkFalsy: true }).isISO8601().withMessage('结束日期格式无效'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('页码无效'),
  query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).withMessage('每页数量无效'),
  validate
];

const maintenanceOrderStartValidation = [
  body('handler_id').optional({ checkFalsy: true }).isInt().withMessage('处理人ID无效'),
  validate
];

const maintenanceOrderCompleteValidation = [
  body('result').notEmpty().withMessage('完成结果不能为空'),
  body('process').optional({ checkFalsy: true }).isString().withMessage('处理过程必须是字符串'),
  validate
];

const maintenanceOrderCancelValidation = [
  body('remark').optional({ checkFalsy: true }).isString().withMessage('取消备注必须是字符串'),
  validate
];

module.exports = {
  loginValidation,
  userCreateValidation,
  plotCreateValidation,
  deceasedCreateValidation,
  contactCreateValidation,
  paymentCreateValidation,
  appointmentCreateValidation,
  visitRecordCreateValidation,
  serviceItemCreateValidation,
  serviceOrderCreateValidation,
  serviceOrderStatusValidation,
  idParamValidation,
  importPreviewValidation,
  importConfirmValidation,
  operationLogQueryValidation,
  billPreviewValidation,
  billGenerateValidation,
  billBatchQueryValidation,
  billConfigUpdateValidation,
  reminderGenerateValidation,
  reminderBatchQueryValidation,
  reminderDetailQueryValidation,
  maintenanceOrderCreateValidation,
  maintenanceOrderQueryValidation,
  maintenanceOrderStartValidation,
  maintenanceOrderCompleteValidation,
  maintenanceOrderCancelValidation
};
