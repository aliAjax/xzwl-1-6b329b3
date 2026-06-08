const express = require('express');
const moment = require('moment');
const { run, get, all, paginateQuery } = require('../utils/dbHelper');
const { success, error, paginate } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { plotCreateValidation, idParamValidation } = require('../middleware/validator');
const { RESOURCE_TYPES, ACTIONS, logOperation, generateSummary } = require('../utils/operationLog');
const { createAuditSnapshot, AUDITED_RESOURCE_TYPES } = require('../utils/audit');

const router = express.Router();

const checkAndReleaseExpiredReservations = async (plotId) => {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const expired = await all(`
    SELECT r.id, r.contract_id, r.plot_id
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    WHERE r.plot_id = ? 
      AND r.status = 'active' 
      AND c.status = 'reserved'
      AND r.expires_at < ?
  `, [plotId, now]);

  for (const r of expired) {
    await run("UPDATE plot_reservations SET status = 'expired' WHERE id = ?", [r.id]);
    await run("UPDATE contracts SET status = 'draft', reserved_at = NULL, reserved_expires_at = NULL WHERE id = ?", [r.contract_id]);
    
    const plot = await get('SELECT id, status FROM plots WHERE id = ?', [r.plot_id]);
    const hasOtherActive = await get(`
      SELECT COUNT(*) as count 
      FROM plot_reservations r
      INNER JOIN contracts c ON r.contract_id = c.id
      WHERE r.plot_id = ? AND r.status = 'active' AND c.status != 'voided' AND c.id != ?
    `, [r.plot_id, r.contract_id]);
    
    if (hasOtherActive.count === 0 && plot.status === '预留中') {
      await run('UPDATE plots SET status = ? WHERE id = ?', ['空闲', r.plot_id]);
    }
  }
};

const checkAndReleaseAllExpiredReservations = async () => {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const expired = await all(`
    SELECT r.id, r.contract_id, r.plot_id
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    WHERE r.status = 'active'
      AND c.status = 'reserved'
      AND r.expires_at < ?
  `, [now]);

  for (const r of expired) {
    await run("UPDATE plot_reservations SET status = 'expired' WHERE id = ?", [r.id]);
    await run("UPDATE contracts SET status = 'draft', reserved_at = NULL, reserved_expires_at = NULL WHERE id = ?", [r.contract_id]);
    
    const plot = await get('SELECT id, status FROM plots WHERE id = ?', [r.plot_id]);
    const hasOtherActive = await get(`
      SELECT COUNT(*) as count 
      FROM plot_reservations r
      INNER JOIN contracts c ON r.contract_id = c.id
      WHERE r.plot_id = ? AND r.status = 'active' AND c.status != 'voided' AND c.id != ?
    `, [r.plot_id, r.contract_id]);
    
    if (hasOtherActive.count === 0 && plot.status === '预留中') {
      await run('UPDATE plots SET status = ? WHERE id = ?', ['空闲', r.plot_id]);
    }
  }
};

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, area = '', status = '', keyword = '', auto_release = 'true' } = req.query;
    
    if (auto_release === 'true') {
      await checkAndReleaseAllExpiredReservations();
    }
    
    let baseSql = `
      SELECT p.*, 
             d.name as deceased_name,
             d.id as deceased_id
      FROM plots p 
      LEFT JOIN deceased d ON p.id = d.plot_id 
      WHERE 1=1
    `;
    const params = [];
    
    if (area) {
      baseSql += ' AND p.area = ?';
      params.push(area);
    }
    
    if (status) {
      baseSql += ' AND p.status = ?';
      params.push(status);
    }
    
    if (keyword) {
      baseSql += ' AND (p.plot_number LIKE ? OR d.name LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize, 'p.area, p.row, p.col');
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/areas', authenticate, async (req, res) => {
  try {
    const areas = await all('SELECT DISTINCT area FROM plots ORDER BY area');
    const areaList = areas.map(a => a.area);
    success(res, areaList);
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/area/:area/occupancy', authenticate, async (req, res) => {
  try {
    const { area } = req.params;
    const { auto_release = 'true' } = req.query;
    
    if (auto_release === 'true') {
      await checkAndReleaseAllExpiredReservations();
    }
    
    const areaExists = await get('SELECT COUNT(*) as count FROM plots WHERE area = ?', [area]);
    if (areaExists.count === 0) {
      return error(res, '该区域不存在', 404);
    }
    
    const plots = await all(`
      SELECT p.*, 
             d.name as deceased_name,
             d.gender as deceased_gender,
             c.name as contact_name,
             c.phone as contact_phone
      FROM plots p 
      LEFT JOIN deceased d ON p.id = d.plot_id 
      LEFT JOIN contacts c ON d.id = c.deceased_id 
      WHERE p.area = ? 
      ORDER BY p.row, p.col
    `, [area]);
    
    const total = plots.length;
    const occupied = plots.filter(p => p.status === '已占用').length;
    const available = plots.filter(p => p.status === '空闲').length;
    const maintenance = plots.filter(p => p.status === '维修中').length;
    const reserved = plots.filter(p => p.status === '预留中').length;
    
    const rows = [...new Set(plots.map(p => p.row))].sort((a, b) => a - b);
    const cols = [...new Set(plots.map(p => p.col))].sort((a, b) => a - b);
    
    const grid = rows.map(row => {
      return cols.map(col => {
        return plots.find(p => p.row === row && p.col === col) || null;
      });
    });
    
    success(res, {
      area,
      statistics: {
        total,
        occupied,
        available,
        maintenance,
        reserved,
        occupancyRate: total > 0 ? ((occupied / total) * 100).toFixed(1) + '%' : '0%'
      },
      rows,
      cols,
      grid,
      list: plots
    }, '区域占用情况查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/statistics', authenticate, async (req, res) => {
  try {
    const { auto_release = 'true' } = req.query;
    
    if (auto_release === 'true') {
      await checkAndReleaseAllExpiredReservations();
    }
    
    const stats = await get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = '空闲' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = '已占用' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = '维修中' THEN 1 ELSE 0 END) as maintenance,
        SUM(CASE WHEN status = '预留中' THEN 1 ELSE 0 END) as reserved
      FROM plots
    `);
    
    const areaStats = await all(`
      SELECT 
        area,
        COUNT(*) as total,
        SUM(CASE WHEN status = '空闲' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = '已占用' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = '预留中' THEN 1 ELSE 0 END) as reserved
      FROM plots 
      GROUP BY area 
      ORDER BY area
    `);
    
    success(res, {
      overall: {
        total: stats.total,
        available: stats.available,
        occupied: stats.occupied,
        maintenance: stats.maintenance,
        reserved: stats.reserved,
        occupancyRate: stats.total > 0 ? ((stats.occupied / stats.total) * 100).toFixed(1) + '%' : '0%'
      },
      byArea: areaStats
    }, '统计信息查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { auto_release = 'true' } = req.query;
    
    if (auto_release === 'true') {
      await checkAndReleaseExpiredReservations(req.params.id);
    }
    
    const plot = await get(`
      SELECT p.*, 
             d.id as deceased_id,
             d.name as deceased_name,
             d.gender as deceased_gender,
             d.birth_date,
             d.death_date,
             d.interment_date,
             c.id as contact_id,
             c.name as contact_name,
             c.phone as contact_phone,
             c.relationship as contact_relationship
      FROM plots p 
      LEFT JOIN deceased d ON p.id = d.plot_id 
      LEFT JOIN contacts c ON d.id = c.deceased_id 
      WHERE p.id = ?
    `, [req.params.id]);
    
    if (!plot) {
      return error(res, '墓位不存在', 404);
    }
    
    const payments = await all(`
      SELECT * FROM payments 
      WHERE plot_id = ? 
      ORDER BY due_date DESC 
      LIMIT 5
    `, [req.params.id]);
    
    const appointments = await all(`
      SELECT a.*, c.name as contact_name 
      FROM appointments a 
      LEFT JOIN contacts c ON a.contact_id = c.id 
      WHERE a.plot_id = ? 
      ORDER BY a.appointment_date DESC 
      LIMIT 5
    `, [req.params.id]);
    
    const contracts = await all(`
      SELECT c.*,
             ct.name as contact_name,
             ct.phone as contact_phone,
             d.name as deceased_name
      FROM contracts c
      LEFT JOIN contacts ct ON c.contact_id = ct.id
      LEFT JOIN deceased d ON c.deceased_id = d.id
      WHERE c.plot_id = ?
      ORDER BY c.created_at DESC
      LIMIT 5
    `, [req.params.id]);
    
    const statusNames = {
      draft: '草稿',
      reserved: '预留中',
      signed: '已签约',
      effective: '已生效',
      voided: '已作废'
    };
    
    const contractsWithNames = contracts.map(c => ({
      ...c,
      status_name: statusNames[c.status] || c.status
    }));
    
    success(res, { ...plot, payments, appointments, contracts: contractsWithNames });
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/', authenticate, plotCreateValidation, async (req, res) => {
  try {
    const { plot_number, area, row, col, status, type, price, remark } = req.body;
    
    const existing = await get('SELECT id FROM plots WHERE plot_number = ?', [plot_number]);
    if (existing) {
      return error(res, '墓位编号已存在', 400);
    }
    
    const existingPosition = await get('SELECT id FROM plots WHERE area = ? AND row = ? AND col = ?', [area, row, col]);
    if (existingPosition) {
      return error(res, '该位置已有墓位', 400);
    }
    
    const result = await run(
      'INSERT INTO plots (plot_number, area, row, col, status, type, price, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [plot_number, area, row, col, status || '空闲', type || '单穴', price || 0, remark]
    );

    const summary = generateSummary(RESOURCE_TYPES.PLOT, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.PLOT, result.id, ACTIONS.CREATE, summary);
    
    success(res, { id: result.id }, '墓位创建成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.post('/batch', authenticate, async (req, res) => {
  try {
    const { area, startRow, endRow, startCol, endCol, type, price } = req.body;
    
    if (!area || !startRow || !endRow || !startCol || !endCol) {
      return error(res, '请填写完整的批量生成信息', 400);
    }
    
    const created = [];
    const errors = [];
    
    for (let row = parseInt(startRow); row <= parseInt(endRow); row++) {
      for (let col = parseInt(startCol); col <= parseInt(endCol); col++) {
        const plotNumber = `${area}-${row}排${col}号`;
        
        const existing = await get('SELECT id FROM plots WHERE plot_number = ? OR (area = ? AND row = ? AND col = ?)', 
          [plotNumber, area, row, col]);
        
        if (existing) {
          errors.push(`墓位 ${plotNumber} 已存在，跳过`);
          continue;
        }
        
        const result = await run(
          'INSERT INTO plots (plot_number, area, row, col, status, type, price) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [plotNumber, area, row, col, '空闲', type || '单穴', price || 0]
        );

        const summary = generateSummary(RESOURCE_TYPES.PLOT, ACTIONS.CREATE, { plot_number: plotNumber, area, row, col });
        await logOperation(req, RESOURCE_TYPES.PLOT, result.id, ACTIONS.CREATE, summary);
        
        created.push({ id: result.id, plot_number: plotNumber });
      }
    }
    
    success(res, { created: created.length, errors, createdItems: created }, '批量创建完成');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { plot_number, area, row, col, status, type, price, remark } = req.body;
    
    const existing = await get('SELECT * FROM plots WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '墓位不存在', 404);
    }
    
    const duplicateNumber = await get('SELECT id FROM plots WHERE plot_number = ? AND id != ?', [plot_number, id]);
    if (duplicateNumber) {
      return error(res, '墓位编号已存在', 400);
    }
    
    const duplicatePosition = await get('SELECT id FROM plots WHERE area = ? AND row = ? AND col = ? AND id != ?', [area, row, col, id]);
    if (duplicatePosition) {
      return error(res, '该位置已有墓位', 400);
    }
    
    await run(
      'UPDATE plots SET plot_number = ?, area = ?, row = ?, col = ?, status = ?, type = ?, price = ?, remark = ? WHERE id = ?',
      [plot_number, area, row, col, status, type, price, remark, id]
    );

    const newData = { plot_number, area, row, col, status, type, price, remark };
    let action = ACTIONS.UPDATE;
    let summary;

    const auditResult = await createAuditSnapshot(
      AUDITED_RESOURCE_TYPES.PLOT,
      id,
      existing,
      newData,
      req,
      null
    );
    const snapshotId = auditResult?.snapshotId || null;

    if (existing.status !== status) {
      action = ACTIONS.STATUS_CHANGE;
      summary = generateSummary(RESOURCE_TYPES.PLOT, ACTIONS.STATUS_CHANGE, newData, existing);
    } else {
      summary = generateSummary(RESOURCE_TYPES.PLOT, ACTIONS.UPDATE, newData, existing);
    }
    await logOperation(req, RESOURCE_TYPES.PLOT, id, action, summary, snapshotId);
    
    success(res, null, '墓位更新成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const plot = await get('SELECT status FROM plots WHERE id = ?', [id]);
    if (!plot) {
      return error(res, '墓位不存在', 404);
    }
    
    if (plot.status === '已占用') {
      return error(res, '已占用的墓位不能删除', 400);
    }
    
    await run('DELETE FROM plots WHERE id = ?', [id]);

    const summary = generateSummary(RESOURCE_TYPES.PLOT, ACTIONS.DELETE, plot);
    await logOperation(req, RESOURCE_TYPES.PLOT, id, ACTIONS.DELETE, summary);

    success(res, null, '墓位删除成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
