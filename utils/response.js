const success = (res, data = null, message = '操作成功') => {
  res.json({
    code: 200,
    message,
    data
  });
};

const error = (res, message = '操作失败', code = 400) => {
  res.status(code).json({
    code,
    message,
    data: null
  });
};

const paginate = (res, data, total, page, pageSize, message = '查询成功') => {
  res.json({
    code: 200,
    message,
    data: {
      list: data,
      pagination: {
        total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        totalPages: Math.ceil(total / pageSize)
      }
    }
  });
};

const handleTransactionError = (res, err) => {
  const message = err.message;
  const businessErrorPatterns = [
    '不存在', '已占用', '已被逝者', '已签约', '已生效', '已作废',
    '不能', '无法', '请先', '超过', '不足', '重复', '预留',
    '墓位', '合同', '付款', '缴费'
  ];
  const isBusinessError = businessErrorPatterns.some(pattern => 
    message.includes(pattern)
  );
  const statusCode = isBusinessError ? 400 : 500;
  error(res, message, statusCode);
};

class BusinessError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.name = 'BusinessError';
    this.statusCode = code;
  }
}

const handleError = (res, err) => {
  if (err instanceof BusinessError) {
    error(res, err.message, err.statusCode);
  } else {
    handleTransactionError(res, err);
  }
};

module.exports = { success, error, paginate, handleTransactionError, handleError, BusinessError };
