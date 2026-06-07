const jwt = require('jsonwebtoken');
const { error } = require('../utils/response');
require('dotenv').config();

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return error(res, '未提供认证令牌', 401);
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return error(res, '认证令牌无效或已过期', 401);
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return error(res, '权限不足', 403);
    }
    next();
  };
};

module.exports = { authenticate, authorize };
