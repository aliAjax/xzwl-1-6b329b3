const express = require('express');
const { run, get, all, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { serviceItemCreateValidation, idParamValidation } = require('../middleware/validator');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, category = '', status = '', keyword = '' } = req.query;
    
    let baseSql = `SELECT * FROM service_items WHERE 1=1`;
    const params = [];
    
    if (category) {
      baseSql += ' AND category = ?';
      params.push(category);
    }
    
    if (status) {
      baseSql += ' AND status = ?';
      params.push(status);
    }
    
    if (keyword) {
      baseSql += ' AND name LIKE ?';
      params.push(`%${keyword}%`);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'sort ASC, id DESC');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/all', authenticate, async (req, res) => {
  try {
    const { category = '', status = '上架' } = req.query;
    
    let sql = `SELECT * FROM service_items WHERE 1=1`;
    const params = [];
    
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    
    sql += ' ORDER BY sort ASC, id DESC';
    
    const items = await all(sql, params);
    success(res, items);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/categories', authenticate, async (req, res) => {
  try {
    const categories = await all(`
      SELECT DISTINCT category 
      FROM service_items 
      WHERE status = '上架'
      ORDER BY category
    `);
    success(res, categories.map(c => c.category));
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const item = await get('SELECT * FROM service_items WHERE id = ?', [req.params.id]);
    
    if (!item) {
      return error(res, '服务项目不存在', 404);
    }
    
    const orderCount = await get('SELECT COUNT(*) as total FROM service_orders WHERE service_item_id = ?', [req.params.id]);
    
    success(res, {
      ...item,
      order_count: orderCount.total
    });
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, serviceItemCreateValidation, async (req, res) => {
  try {
    const { name, category, price, unit, description, status, sort, remark } = req.body;
    
    const existing = await get('SELECT id FROM service_items WHERE name = ? AND category = ?', [name, category]);
    if (existing) {
      return error(res, '该分类下已存在同名服务项目', 400);
    }
    
    const result = await run(
      'INSERT INTO service_items (name, category, price, unit, description, status, sort, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, category, price, unit || '次', description, status || '上架', sort || 0, remark]
    );
    
    success(res, { id: result.id }, '服务项目创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, price, unit, description, status, sort, remark } = req.body;
    
    const existing = await get('SELECT id FROM service_items WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '服务项目不存在', 404);
    }
    
    const duplicate = await get('SELECT id FROM service_items WHERE name = ? AND category = ? AND id != ?', [name, category, id]);
    if (duplicate) {
      return error(res, '该分类下已存在同名服务项目', 400);
    }
    
    await run(
      'UPDATE service_items SET name = ?, category = ?, price = ?, unit = ?, description = ?, status = ?, sort = ?, remark = ? WHERE id = ?',
      [name, category, price, unit || '次', description, status, sort || 0, remark, id]
    );
    
    success(res, null, '服务项目更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT id FROM service_items WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '服务项目不存在', 404);
    }
    
    const hasOrders = await get('SELECT COUNT(*) as count FROM service_orders WHERE service_item_id = ?', [id]);
    if (hasOrders.count > 0) {
      return error(res, '该服务项目有关联订单，无法删除', 400);
    }
    
    await run('DELETE FROM service_items WHERE id = ?', [id]);
    success(res, null, '服务项目删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
