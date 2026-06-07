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
  importConfirmValidation
};
