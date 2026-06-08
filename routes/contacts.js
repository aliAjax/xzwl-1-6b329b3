const express = require('express');
const { run, get, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { contactCreateValidation, idParamValidation } = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');
const { createAuditSnapshot, AUDITED_RESOURCE_TYPES } = require('../utils/audit');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, keyword = '', deceased_id = '' } = req.query;
    
    let baseSql = `
      SELECT c.*, 
             d.name as deceased_name,
             p.plot_number,
             p.area
      FROM contacts c 
      LEFT JOIN deceased d ON c.deceased_id = d.id 
      LEFT JOIN plots p ON d.plot_id = p.id 
      WHERE 1=1
    `;
    const params = [];
    
    if (keyword) {
      baseSql += ' AND (c.name LIKE ? OR c.phone LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    
    if (deceased_id) {
      baseSql += ' AND c.deceased_id = ?';
      params.push(deceased_id);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize);
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const contact = await get(`
      SELECT c.*, 
             d.name as deceased_name,
             d.id as deceased_id,
             p.plot_number,
             p.area,
             p.id as plot_id
      FROM contacts c 
      LEFT JOIN deceased d ON c.deceased_id = d.id 
      LEFT JOIN plots p ON d.plot_id = p.id 
      WHERE c.id = ?
    `, [req.params.id]);
    
    if (!contact) {
      return error(res, '联系人不存在', 404);
    }
    
    const visitRecords = await get(`
      SELECT COUNT(*) as total 
      FROM visit_records 
      WHERE contact_id = ?
    `, [req.params.id]);
    
    const appointments = await get(`
      SELECT COUNT(*) as total 
      FROM appointments 
      WHERE contact_id = ?
    `, [req.params.id]);
    
    success(res, {
      ...contact,
      visit_count: visitRecords.total,
      appointment_count: appointments.total
    });
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, contactCreateValidation, async (req, res) => {
  try {
    const { name, phone, id_card, address, relationship, deceased_id, remark } = req.body;
    
    if (deceased_id) {
      const deceased = await get('SELECT id FROM deceased WHERE id = ?', [deceased_id]);
      if (!deceased) {
        return error(res, '逝者信息不存在', 400);
      }
    }
    
    const result = await run(
      'INSERT INTO contacts (name, phone, id_card, address, relationship, deceased_id, remark) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, phone, id_card, address, relationship, deceased_id, remark]
    );

    const summary = generateSummary(RESOURCE_TYPES.CONTACT, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.CONTACT, result.id, ACTIONS.CREATE, summary);
    
    success(res, { id: result.id }, '联系人创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, id_card, address, relationship, deceased_id, remark } = req.body;
    
    const existing = await get('SELECT * FROM contacts WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '联系人不存在', 404);
    }
    
    if (deceased_id) {
      const deceased = await get('SELECT id FROM deceased WHERE id = ?', [deceased_id]);
      if (!deceased) {
        return error(res, '逝者信息不存在', 400);
      }
    }
    
    await run(
      'UPDATE contacts SET name = ?, phone = ?, id_card = ?, address = ?, relationship = ?, deceased_id = ?, remark = ? WHERE id = ?',
      [name, phone, id_card, address, relationship, deceased_id, remark, id]
    );

    const newData = { name, phone, id_card, address, relationship, deceased_id, remark };
    const summary = generateSummary(RESOURCE_TYPES.CONTACT, ACTIONS.UPDATE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.CONTACT, id, ACTIONS.UPDATE, summary);
    
    success(res, null, '联系人更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT * FROM contacts WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '联系人不存在', 404);
    }
    
    const hasRecords = await get(`
      SELECT 
        (SELECT COUNT(*) FROM visit_records WHERE contact_id = ?) +
        (SELECT COUNT(*) FROM appointments WHERE contact_id = ?) +
        (SELECT COUNT(*) FROM payments WHERE contact_id = ?) as count
    `, [id, id, id]);
    
    if (hasRecords.count > 0) {
      return error(res, '该联系人有关联记录，无法删除', 400);
    }
    
    await run('DELETE FROM contacts WHERE id = ?', [id]);

    const summary = generateSummary(RESOURCE_TYPES.CONTACT, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.CONTACT, id, ACTIONS.DELETE, summary);

    success(res, null, '联系人删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
