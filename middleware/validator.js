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

const slotIdParamValidation = [
  param('slotId').isInt().withMessage('时段ID无效'),
  validate
];

const staffIdParamValidation = [
  param('staffId').isInt().withMessage('排班ID无效'),
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

const festivalScheduleCreateValidation = [
  body('festival_name').notEmpty().withMessage('节日名称不能为空'),
  body('festival_type').optional({ checkFalsy: true }).isIn(['清明节', '中元节', '寒衣节', '春节', 'custom']).withMessage('节日类型无效'),
  body('start_date').isISO8601().withMessage('开始日期格式无效'),
  body('end_date').isISO8601().withMessage('结束日期格式无效'),
  body('description').optional({ checkFalsy: true }).isString().withMessage('描述必须是字符串'),
  body('time_slots').isArray({ min: 1 }).withMessage('时段配置不能为空且必须是数组'),
  body('time_slots.*.date').isISO8601().withMessage('时段日期格式无效'),
  body('time_slots.*.start_time').notEmpty().withMessage('开始时间不能为空'),
  body('time_slots.*.end_time').notEmpty().withMessage('结束时间不能为空'),
  body('time_slots.*.capacity').isInt({ min: 1 }).withMessage('容量必须是大于0的整数'),
  body('time_slots.*.staff').optional({ checkFalsy: true }).isArray().withMessage('工作人员配置必须是数组'),
  body('time_slots.*.staff.*.user_id').isInt().withMessage('工作人员ID无效'),
  body('time_slots.*.staff.*.duty').optional({ checkFalsy: true }).isString().withMessage('职责必须是字符串'),
  validate
];

const festivalScheduleUpdateValidation = [
  body('festival_name').optional({ checkFalsy: true }).notEmpty().withMessage('节日名称不能为空'),
  body('festival_type').optional({ checkFalsy: true }).isIn(['清明节', '中元节', '寒衣节', '春节', 'custom']).withMessage('节日类型无效'),
  body('start_date').optional({ checkFalsy: true }).isISO8601().withMessage('开始日期格式无效'),
  body('end_date').optional({ checkFalsy: true }).isISO8601().withMessage('结束日期格式无效'),
  body('status').optional({ checkFalsy: true }).isIn(['active', 'inactive']).withMessage('状态无效'),
  body('description').optional({ checkFalsy: true }).isString().withMessage('描述必须是字符串'),
  validate
];

const festivalScheduleQueryValidation = [
  query('festival_type').optional({ checkFalsy: true }).isIn(['清明节', '中元节', '寒衣节', '春节', 'custom']).withMessage('节日类型无效'),
  query('status').optional({ checkFalsy: true }).isIn(['active', 'inactive']).withMessage('状态无效'),
  query('start_date').optional({ checkFalsy: true }).isISO8601().withMessage('开始日期格式无效'),
  query('end_date').optional({ checkFalsy: true }).isISO8601().withMessage('结束日期格式无效'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('页码无效'),
  query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).withMessage('每页数量无效'),
  validate
];

const festivalTimeSlotCreateValidation = [
  body('festival_schedule_id').isInt().withMessage('节日排班ID无效'),
  body('date').isISO8601().withMessage('日期格式无效'),
  body('start_time').notEmpty().withMessage('开始时间不能为空'),
  body('end_time').notEmpty().withMessage('结束时间不能为空'),
  body('capacity').isInt({ min: 1 }).withMessage('容量必须是大于0的整数'),
  body('remark').optional({ checkFalsy: true }).isString().withMessage('备注必须是字符串'),
  validate
];

const festivalTimeSlotUpdateValidation = [
  body('capacity').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('容量必须是大于0的整数'),
  body('remark').optional({ checkFalsy: true }).isString().withMessage('备注必须是字符串'),
  validate
];

const festivalStaffScheduleCreateValidation = [
  body('time_slot_id').isInt().withMessage('时段ID无效'),
  body('user_id').isInt().withMessage('用户ID无效'),
  body('duty').optional({ checkFalsy: true }).isString().withMessage('职责必须是字符串'),
  validate
];

const festivalQueryByDateValidation = [
  query('date').isISO8601().withMessage('日期格式无效'),
  validate
];

const contractCreateValidation = [
  body('plot_id').isInt().withMessage('墓位ID无效'),
  body('contact_id').optional({ checkFalsy: true }).isInt().withMessage('联系人ID无效'),
  body('deceased_id').optional({ checkFalsy: true }).isInt().withMessage('逝者ID无效'),
  body('plot_price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('墓位价格无效'),
  body('management_fee').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('管理费金额无效'),
  body('management_fee_years').optional({ checkFalsy: true }).isInt({ min: 0 }).withMessage('管理年限无效'),
  body('remark').optional({ checkFalsy: true }).isString().withMessage('备注必须是字符串'),
  validate
];

const contractUpdateValidation = [
  body('contact_id').optional({ checkFalsy: true }).isInt().withMessage('联系人ID无效'),
  body('deceased_id').optional({ checkFalsy: true }).isInt().withMessage('逝者ID无效'),
  body('plot_price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('墓位价格无效'),
  body('management_fee').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('管理费金额无效'),
  body('management_fee_years').optional({ checkFalsy: true }).isInt({ min: 0 }).withMessage('管理年限无效'),
  body('remark').optional({ checkFalsy: true }).isString().withMessage('备注必须是字符串'),
  validate
];

const contractReserveValidation = [
  body('plot_id').isInt().withMessage('墓位ID无效'),
  body('contact_name').notEmpty().withMessage('联系人姓名不能为空'),
  body('contact_phone').notEmpty().withMessage('联系电话不能为空'),
  body('reserve_days').optional({ checkFalsy: true }).isInt({ min: 1, max: 365 }).withMessage('预留天数无效，范围1-365天'),
  body('plot_price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('墓位价格无效'),
  body('management_fee').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('管理费金额无效'),
  body('management_fee_years').optional({ checkFalsy: true }).isInt({ min: 0 }).withMessage('管理年限无效'),
  validate
];

const contractSignValidation = [
  body('contact_id').isInt().withMessage('联系人ID无效'),
  body('deceased_id').optional({ checkFalsy: true }).isInt().withMessage('逝者ID无效'),
  body('plot_price').isFloat({ min: 0 }).withMessage('墓位价格无效'),
  body('management_fee').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('管理费金额无效'),
  body('management_fee_years').optional({ checkFalsy: true }).isInt({ min: 0 }).withMessage('管理年限无效'),
  body('fee_items').optional({ checkFalsy: true }).isArray().withMessage('费用明细必须是数组'),
  body('fee_items.*.fee_type').notEmpty().withMessage('费用类型不能为空'),
  body('fee_items.*.fee_category').isIn(['购墓款', '管理费', '其他']).withMessage('费用分类无效'),
  body('fee_items.*.amount').isFloat({ min: 0 }).withMessage('费用金额无效'),
  validate
];

const contractPayValidation = [
  body('amount').isFloat({ min: 0.01 }).withMessage('付款金额无效'),
  body('payment_method').notEmpty().withMessage('付款方式不能为空'),
  body('fee_category').isIn(['购墓款', '管理费']).withMessage('费用分类无效'),
  body('payment_date').optional({ checkFalsy: true }).isISO8601().withMessage('付款日期格式无效'),
  body('remark').optional({ checkFalsy: true }).isString().withMessage('备注必须是字符串'),
  validate
];

const contractVoidValidation = [
  body('void_reason').notEmpty().withMessage('作废原因不能为空'),
  validate
];

const contractQueryValidation = [
  query('status').optional({ checkFalsy: true }).isIn(['draft', 'reserved', 'signed', 'effective', 'voided']).withMessage('合同状态无效'),
  query('plot_id').optional({ checkFalsy: true }).isInt().withMessage('墓位ID无效'),
  query('contact_id').optional({ checkFalsy: true }).isInt().withMessage('联系人ID无效'),
  query('keyword').optional({ checkFalsy: true }).notEmpty().withMessage('搜索关键词不能为空'),
  query('start_date').optional({ checkFalsy: true }).isISO8601().withMessage('开始日期格式无效'),
  query('end_date').optional({ checkFalsy: true }).isISO8601().withMessage('结束日期格式无效'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('页码无效'),
  query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }).withMessage('每页数量无效'),
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
  slotIdParamValidation,
  staffIdParamValidation,
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
  maintenanceOrderCancelValidation,
  festivalScheduleCreateValidation,
  festivalScheduleUpdateValidation,
  festivalScheduleQueryValidation,
  festivalTimeSlotCreateValidation,
  festivalTimeSlotUpdateValidation,
  festivalStaffScheduleCreateValidation,
  festivalQueryByDateValidation,
  contractCreateValidation,
  contractUpdateValidation,
  contractReserveValidation,
  contractSignValidation,
  contractPayValidation,
  contractVoidValidation,
  contractQueryValidation
};
