const express = require('express');
const bcrypt = require('bcryptjs');
const { run, get, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate, authorize } = require('../middleware/auth');
const { userCreateValidation, idParamValidation } = require('../middleware/validator');

const router = express.Router();

router.get('/me', authenticate, (req, res) => {
  success(res, req.user, '获取用户信息成功');
});

router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { page = 1, pageSize = 10, keyword = '', role = '' } = req.query;
    
    let baseSql = 'SELECT id, username, name, role, phone, status, created_at FROM users WHERE 1=1';
    const params = [];
    
    if (keyword) {
      baseSql += ' AND (username LIKE ? OR name LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    
    if (role) {
      baseSql += ' AND role = ?';
      params.push(role);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize);
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, authorize('admin'), idParamValidation, async (req, res) => {
  try {
    const user = await get('SELECT id, username, name, role, phone, status, created_at FROM users WHERE id = ?', [req.params.id]);
    
    if (!user) {
      return error(res, '用户不存在', 404);
    }
    
    success(res, user);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, authorize('admin'), userCreateValidation, async (req, res) => {
  try {
    const { username, password, name, role, phone } = req.body;
    
    const existingUser = await get('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUser) {
      return error(res, '用户名已存在', 400);
    }
    
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    const result = await run(
      'INSERT INTO users (username, password, name, role, phone) VALUES (?, ?, ?, ?, ?)',
      [username, hashedPassword, name, role, phone]
    );
    
    success(res, { id: result.id }, '用户创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, authorize('admin'), idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, phone, status, password } = req.body;
    
    const existingUser = await get('SELECT id FROM users WHERE id = ?', [id]);
    if (!existingUser) {
      return error(res, '用户不存在', 404);
    }
    
    let sql = 'UPDATE users SET name = ?, role = ?, phone = ?, status = ?';
    const params = [name, role, phone, status];
    
    if (password) {
      const hashedPassword = bcrypt.hashSync(password, 10);
      sql += ', password = ?';
      params.push(hashedPassword);
    }
    
    sql += ' WHERE id = ?';
    params.push(id);
    
    await run(sql, params);
    
    success(res, null, '用户更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, authorize('admin'), idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (parseInt(id) === req.user.id) {
      return error(res, '不能删除自己', 400);
    }
    
    const result = await run('DELETE FROM users WHERE id = ?', [id]);
    
    if (result.changes === 0) {
      return error(res, '用户不存在', 404);
    }
    
    success(res, null, '用户删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
