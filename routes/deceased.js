const express = require('express');
const moment = require('moment');
const { run, get, paginateQuery, all, runInTransaction } = require('../utils/dbHelper');
const { success, error, paginate, handleError } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { deceasedCreateValidation, idParamValidation } = require('../middleware/validator');
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

const checkPlotAvailabilityForDeceased = async (plotId, excludeDeceasedId = null, autoReleaseExpired = true) => {
  if (autoReleaseExpired) {
    await checkAndReleaseExpiredReservations(plotId);
  }

  const plot = await get('SELECT id, status FROM plots WHERE id = ?', [plotId]);
  if (!plot) {
    return { available: false, reason: '墓位不存在' };
  }

  if (plot.status === '维修中') {
    return { available: false, reason: '墓位正在维修中' };
  }

  const params = excludeDeceasedId ? [plotId, excludeDeceasedId] : [plotId];
  const occupyingDeceased = await get(`
    SELECT id, name 
    FROM deceased 
    WHERE plot_id = ? 
      ${excludeDeceasedId ? 'AND id != ?' : ''}
    LIMIT 1
  `, params);
  if (occupyingDeceased) {
    return { 
      available: false, 
      reason: `墓位已被逝者"${occupyingDeceased.name}"占用` 
    };
  }

  const now = moment();
  const activeReservation = await get(`
    SELECT r.id, r.expires_at, c.contract_no, c.status as contract_status
    FROM plot_reservations r
    INNER JOIN contracts c ON r.contract_id = c.id
    WHERE r.plot_id = ? 
      AND r.status = 'active' 
      AND c.status = 'reserved'
    LIMIT 1
  `, [plotId]);

  if (activeReservation) {
    if (moment(activeReservation.expires_at).isAfter(now)) {
      return { 
        available: false, 
        reason: `墓位已被合同${activeReservation.contract_no}预留，有效期至${activeReservation.expires_at}，请先通过合同流程处理`,
        is_expired: false
      };
    } else {
      return {
        available: false,
        reason: `墓位预留已过期，请刷新后重试`,
        is_expired: true
      };
    }
  }

  const activeContract = await get(`
    SELECT id, contract_no, status
    FROM contracts 
    WHERE plot_id = ? 
      AND status IN ('signed', 'effective')
    LIMIT 1
  `, [plotId]);

  if (activeContract) {
    const statusNames = { signed: '已签约', effective: '已生效' };
    return { 
      available: false, 
      reason: `墓位已关联${statusNames[activeContract.status]}合同${activeContract.contract_no}，请先通过合同流程处理` 
    };
  }

  return { available: true, plot };
};

router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, keyword = '', plot_id = '' } = req.query;
    
    let baseSql = `
      SELECT d.*, 
             p.plot_number,
             p.area,
             c.name as contact_name,
             c.phone as contact_phone
      FROM deceased d 
      LEFT JOIN plots p ON d.plot_id = p.id 
      LEFT JOIN contacts c ON d.id = c.deceased_id 
      WHERE 1=1
    `;
    const params = [];
    
    if (keyword) {
      baseSql += ' AND d.name LIKE ?';
      params.push(`%${keyword}%`);
    }
    
    if (plot_id) {
      baseSql += ' AND d.plot_id = ?';
      params.push(plot_id);
    }
    
    const result = await paginateQuery(baseSql, params, page, pageSize);
    paginate(res, result.data, result.total, page, pageSize);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const deceased = await get(`
      SELECT d.*, 
             p.plot_number,
             p.area,
             c.id as contact_id,
             c.name as contact_name,
             c.phone as contact_phone,
             c.id_card as contact_id_card,
             c.address as contact_address,
             c.relationship as contact_relationship
      FROM deceased d 
      LEFT JOIN plots p ON d.plot_id = p.id 
      LEFT JOIN contacts c ON d.id = c.deceased_id 
      WHERE d.id = ?
    `, [req.params.id]);
    
    if (!deceased) {
      return error(res, '逝者信息不存在', 404);
    }
    
    success(res, deceased);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/', authenticate, deceasedCreateValidation, async (req, res) => {
  try {
    const { name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark } = req.body;
    
    const result = await runInTransaction(async () => {
      let deceasedId;
      
      if (plot_id) {
        const availability = await checkPlotAvailabilityForDeceased(plot_id);
        if (!availability.available) {
          throw new Error(availability.reason);
        }
        
        const otherOccupant = await get(`
          SELECT id, name FROM deceased 
          WHERE plot_id = ?
          LIMIT 1
        `, [plot_id]);
        if (otherOccupant) {
          throw new Error(`墓位已被逝者"${otherOccupant.name}"占用，不能重复占用`);
        }
        
        const activeContract = await get(`
          SELECT c.id, c.contract_no, c.status, c.deceased_id
          FROM contracts c
          WHERE c.plot_id = ? 
            AND c.status IN ('signed', 'effective')
            AND c.deceased_id IS NOT NULL
          LIMIT 1
        `, [plot_id]);
        if (activeContract && activeContract.deceased_id) {
          const statusNames = { signed: '已签约', effective: '已生效' };
          const contractDeceased = await get('SELECT name FROM deceased WHERE id = ?', [activeContract.deceased_id]);
          throw new Error(`墓位已${statusNames[activeContract.status]}合同${activeContract.contract_no}关联逝者${contractDeceased ? `"${contractDeceased.name}"` : ''}，请先通过合同流程处理`);
        }
      }
      
      deceasedId = (await run(
        'INSERT INTO deceased (name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark]
      )).id;
      
      if (plot_id) {
        await run('UPDATE plots SET status = "已占用" WHERE id = ?', [plot_id]);
      }
      
      return deceasedId;
    });

    const summary = generateSummary(RESOURCE_TYPES.DECEASED, ACTIONS.CREATE, req.body);
    await logOperation(req, RESOURCE_TYPES.DECEASED, result, ACTIONS.CREATE, summary);
    
    success(res, { id: result }, '逝者信息创建成功');
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark } = req.body;
    
    const existing = await get('SELECT * FROM deceased WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '逝者信息不存在', 404);
    }
    
    await runInTransaction(async () => {
      if (plot_id !== undefined && plot_id !== existing.plot_id) {
        if (plot_id !== null) {
          const availability = await checkPlotAvailabilityForDeceased(plot_id, id);
          if (!availability.available) {
            throw new Error(availability.reason);
          }
          
          const otherOccupant = await get(`
            SELECT id, name FROM deceased 
            WHERE plot_id = ? AND id != ?
            LIMIT 1
          `, [plot_id, id]);
          if (otherOccupant) {
            throw new Error(`墓位已被逝者"${otherOccupant.name}"占用，不能重复占用`);
          }
          
          const activeContract = await get(`
            SELECT c.id, c.contract_no, c.status, c.deceased_id
            FROM contracts c
            WHERE c.plot_id = ? 
              AND c.status IN ('signed', 'effective')
              AND c.deceased_id IS NOT NULL
              AND c.deceased_id != ?
            LIMIT 1
          `, [plot_id, id]);
          if (activeContract && activeContract.deceased_id) {
            const statusNames = { signed: '已签约', effective: '已生效' };
            const contractDeceased = await get('SELECT name FROM deceased WHERE id = ?', [activeContract.deceased_id]);
            throw new Error(`墓位已${statusNames[activeContract.status]}合同${activeContract.contract_no}关联逝者${contractDeceased ? `"${contractDeceased.name}"` : ''}，请先通过合同流程处理`);
          }
        }
        
        if (existing.plot_id) {
          const hasOtherDeceased = await get('SELECT COUNT(*) as count FROM deceased WHERE plot_id = ? AND id != ?', [existing.plot_id, id]);
          if (hasOtherDeceased.count === 0) {
            await run('UPDATE plots SET status = "空闲" WHERE id = ?', [existing.plot_id]);
          }
        }
        
        if (plot_id !== null) {
          await run('UPDATE plots SET status = "已占用" WHERE id = ?', [plot_id]);
        }
      }
      
      await run(
        'UPDATE deceased SET name = ?, gender = ?, birth_date = ?, death_date = ?, plot_id = ?, relationship = ?, interment_date = ?, remark = ? WHERE id = ?',
        [name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark, id]
      );
    });

    const newData = { name, gender, birth_date, death_date, plot_id, relationship, interment_date, remark };

    const auditResult = await createAuditSnapshot(
      AUDITED_RESOURCE_TYPES.DECEASED,
      id,
      existing,
      newData,
      req,
      null
    );
    const snapshotId = auditResult?.snapshotId || null;

    const summary = generateSummary(RESOURCE_TYPES.DECEASED, ACTIONS.UPDATE, newData, existing);
    await logOperation(req, RESOURCE_TYPES.DECEASED, id, ACTIONS.UPDATE, summary, snapshotId);
    
    success(res, null, '逝者信息更新成功');
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/:id', authenticate, idParamValidation, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await get('SELECT id, plot_id FROM deceased WHERE id = ?', [id]);
    if (!existing) {
      return error(res, '逝者信息不存在', 404);
    }
    
    await run('DELETE FROM deceased WHERE id = ?', [id]);
    
    if (existing.plot_id) {
      const hasOtherDeceased = await get('SELECT COUNT(*) as count FROM deceased WHERE plot_id = ?', [existing.plot_id]);
      if (hasOtherDeceased.count === 0) {
        await run('UPDATE plots SET status = "空闲" WHERE id = ?', [existing.plot_id]);
      }
    }

    const summary = generateSummary(RESOURCE_TYPES.DECEASED, ACTIONS.DELETE, existing);
    await logOperation(req, RESOURCE_TYPES.DECEASED, id, ACTIONS.DELETE, summary);
    
    success(res, null, '逝者信息删除成功');
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
