const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { get } = require('../utils/dbHelper');
const { success, error } = require('../utils/response');
const { loginValidation } = require('../middleware/validator');
require('dotenv').config();

const router = express.Router();

router.post('/login', loginValidation, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = await get('SELECT * FROM users WHERE username = ? AND status = "active"', [username]);
    
    if (!user) {
      return error(res, '用户名或密码错误', 401);
    }
    
    const isPasswordValid = bcrypt.compareSync(password, user.password);
    
    if (!isPasswordValid) {
      return error(res, '用户名或密码错误', 401);
    }
    
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        name: user.name, 
        role: user.role 
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );
    
    success(res, {
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        phone: user.phone
      }
    }, '登录成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
