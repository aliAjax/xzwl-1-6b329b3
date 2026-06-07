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

module.exports = { success, error, paginate };
