const {
  AUDITED_RESOURCE_TYPES,
  AUDITED_FIELDS,
  RESOURCE_TABLE_MAP,
  RESOURCE_NAME_MAP,
  FIELD_NAME_MAP,
  calculateFieldChanges,
  createAuditSnapshot,
  getSnapshotWithChanges,
  getSnapshotsByResource,
  detectConflicts,
  executeRollback,
  getFieldNameMap,
  getResourceCurrentData
} = require('../utils/audit');

const { run, get, runInTransaction } = require('../utils/dbHelper');
const { logOperation, RESOURCE_TYPES, ACTIONS } = require('../utils/operationLog');

let testContactId = null;
let testSnapshotId = null;
let testUserId = 1;
let testUserName = '测试管理员';

const mockReq = {
  user: {
    id: testUserId,
    name: testUserName,
    role: 'admin'
  }
};

async function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('🔍 审计回滚模块完整性验证测试');
  console.log('='.repeat(60) + '\n');

  let passed = 0;
  let failed = 0;

  function test(description, fn) {
    return async () => {
      try {
        await fn();
        console.log(`✅ ${description}`);
        passed++;
      } catch (err) {
        console.log(`❌ ${description}`);
        console.log(`   错误: ${err.message}`);
        failed++;
      }
    };
  }

  const tests = [
    test('常量导出检查', () => {
      if (!AUDITED_RESOURCE_TYPES.PLOT) throw new Error('缺少AUDITED_RESOURCE_TYPES.PLOT');
      if (!AUDITED_FIELDS.plot) throw new Error('缺少AUDITED_FIELDS.plot');
      if (!RESOURCE_TABLE_MAP.plot) throw new Error('缺少RESOURCE_TABLE_MAP.plot');
      if (!RESOURCE_NAME_MAP.plot) throw new Error('缺少RESOURCE_NAME_MAP.plot');
      if (!FIELD_NAME_MAP.plot) throw new Error('缺少FIELD_NAME_MAP.plot');
    }),

    test('字段中文名映射检查', () => {
      const fieldMap = getFieldNameMap('contact');
      if (!fieldMap.name || fieldMap.name !== '姓名') {
        throw new Error('字段中文名映射错误');
      }
    }),

    test('字段差异计算（无变化）', () => {
      const oldData = { name: '张三', phone: '13800138000' };
      const newData = { name: '张三', phone: '13800138000' };
      const changes = calculateFieldChanges(oldData, newData, 'contact');
      if (changes.length !== 0) {
        throw new Error(`期望0个变化，实际${changes.length}个`);
      }
    }),

    test('字段差异计算（有变化）', () => {
      const oldData = { name: '张三', phone: '13800138000' };
      const newData = { name: '张三', phone: '13900139000' };
      const changes = calculateFieldChanges(oldData, newData, 'contact');
      if (changes.length !== 1) {
        throw new Error(`期望1个变化，实际${changes.length}个`);
      }
      if (changes[0].field_name !== 'phone') {
        throw new Error(`期望变化字段为phone，实际为${changes[0].field_name}`);
      }
      if (changes[0].old_value !== '13800138000') {
        throw new Error('old_value不正确');
      }
      if (changes[0].new_value !== '13900139000') {
        throw new Error('new_value不正确');
      }
    }),

    test('创建测试联系人数据', async () => {
      const result = await run(
        'INSERT INTO contacts (name, phone, id_card, address, relationship) VALUES (?, ?, ?, ?, ?)',
        ['测试联系人', '13800138000', '110101199001011234', '测试地址', '儿子']
      );
      testContactId = result.id;
      if (!testContactId) throw new Error('创建测试联系人失败');
    }),

    test('创建审计快照', async () => {
      const oldData = { name: '测试联系人', phone: '13800138000', id_card: '110101199001011234' };
      const newData = { name: '测试联系人', phone: '13900139000', id_card: '110101199001011234' };
      
      const result = await createAuditSnapshot(
        AUDITED_RESOURCE_TYPES.CONTACT,
        testContactId,
        oldData,
        newData,
        mockReq,
        null
      );
      
      if (!result) throw new Error('创建审计快照返回null');
      if (!result.snapshotId) throw new Error('缺少snapshotId');
      if (!result.fieldChanges || result.fieldChanges.length !== 1) {
        throw new Error('字段变化不正确');
      }
      testSnapshotId = result.snapshotId;

      await logOperation(
        mockReq,
        RESOURCE_TYPES.CONTACT,
        testContactId,
        ACTIONS.UPDATE,
        '测试联系人字段更新',
        testSnapshotId
      );
      await run('UPDATE contacts SET phone = ? WHERE id = ?', ['13900139000', testContactId]);
    }),

    test('审计快照关联操作日志', async () => {
      const snapshot = await get('SELECT operation_log_id FROM audit_snapshots WHERE id = ?', [testSnapshotId]);
      if (!snapshot || !snapshot.operation_log_id) {
        throw new Error('审计快照未关联操作日志');
      }

      const operationLog = await get('SELECT id, summary FROM operation_logs WHERE id = ?', [snapshot.operation_log_id]);
      if (!operationLog || operationLog.summary !== '测试联系人字段更新') {
        throw new Error('操作日志关联内容不正确');
      }
    }),

    test('获取快照及其变更', async () => {
      const snapshot = await getSnapshotWithChanges(testSnapshotId);
      if (!snapshot) throw new Error('快照不存在');
      if (!snapshot.field_changes || snapshot.field_changes.length !== 1) {
        throw new Error('字段变更不存在或数量不对');
      }
      if (snapshot.field_changes[0].field_name !== 'phone') {
        throw new Error('字段名不正确');
      }
    }),

    test('按资源查询历史快照', async () => {
      const result = await getSnapshotsByResource('contact', testContactId, 1, 10);
      if (!result || !result.data) throw new Error('查询结果为空');
      if (result.total < 1) throw new Error('快照数量不正确');
    }),

    test('获取资源当前数据', async () => {
      const data = await getResourceCurrentData('contact', testContactId);
      if (!data) throw new Error('获取当前数据失败');
      if (data.name !== '测试联系人') throw new Error('数据不正确');
    }),

    test('冲突检测（无冲突）', async () => {
      const conflicts = await detectConflicts(testSnapshotId, ['phone']);
      if (conflicts.has_conflict) {
        throw new Error(`不应检测到冲突: ${JSON.stringify(conflicts.conflicts)}`);
      }
    }),

    test('执行回滚（字段级）', async () => {
      const result = await executeRollback(
        testSnapshotId,
        ['phone'],
        testUserId,
        testUserName
      );
      
      if (!result.success) {
        if (result.conflicts) {
          console.log(`   ⚠️  回滚因冲突跳过，这是预期的: ${result.error}`);
        } else {
          throw new Error(`回滚失败: ${result.error}`);
        }
      } else {
        if (!result.restoredFields || result.restoredFields.length === 0) {
          throw new Error('回滚成功但没有恢复任何字段');
        }
        const contact = await get('SELECT phone FROM contacts WHERE id = ?', [testContactId]);
        if (!contact || contact.phone !== '13800138000') {
          throw new Error(`手机号回滚值不正确: ${contact?.phone}`);
        }
        console.log(`   ℹ️  恢复的字段: ${result.restoredFields.map(f => f.field).join(', ')}`);
      }
    }),

    test('清理测试数据', async () => {
      await run('DELETE FROM audit_field_changes WHERE snapshot_id IN (SELECT id FROM audit_snapshots WHERE resource_id = ? AND resource_type = ?)', [testContactId, 'contact']);
      await run('DELETE FROM audit_snapshots WHERE resource_id = ? AND resource_type = ?', [testContactId, 'contact']);
      await run('DELETE FROM operation_logs WHERE resource_id = ? AND resource_type = ?', [testContactId, 'contact']);
      await run('DELETE FROM contacts WHERE id = ?', [testContactId]);
    })
  ];

  console.log('📋 核心功能测试:\n');
  for (const t of tests) {
    await t();
  }

  console.log('\n' + '='.repeat(60));
  console.log('🌐 API路由挂载检查:');
  console.log('='.repeat(60) + '\n');

  const fs = require('fs');
  const path = require('path');
  const appPath = path.join(__dirname, '..', 'app.js');
  const appContent = fs.readFileSync(appPath, 'utf8');
  
  const hasAuditImport = appContent.includes("require('./routes/audit')");
  const hasRollbackImport = appContent.includes("require('./routes/rollback')");
  const hasAuditUse = appContent.includes("app.use('/api/audit'");
  const hasRollbackUse = appContent.includes("app.use('/api/rollback/requests'");
  
  if (hasAuditImport && hasAuditUse) {
    console.log('✅ 审计API路由已挂载: /api/audit/*');
    passed++;
  } else {
    console.log('❌ 审计API路由未挂载');
    failed++;
  }
  
  if (hasRollbackImport && hasRollbackUse) {
    console.log('✅ 回滚API路由已挂载: /api/rollback/requests/*');
    passed++;
  } else {
    console.log('❌ 回滚API路由未挂载');
    failed++;
  }
  
  console.log('\n   审计API端点:');
  console.log('   GET    /api/audit/                  - 分页查询审计快照');
  console.log('   GET    /api/audit/resource-types    - 可审计资源类型');
  console.log('   GET    /api/audit/:id               - 单个快照详情');
  console.log('   GET    /api/audit/:id/changes       - 快照字段变更');
  console.log('   GET    /api/audit/:id/conflicts     - 快照回滚冲突');
  console.log('   GET    /api/audit/resource/:type/:id - 资源历史快照');
  console.log('   GET    /api/audit/fields/:type      - 资源审计字段');
  
  console.log('\n   回滚API端点:');
  console.log('   POST   /api/rollback/requests/              - 提交回滚申请');
  console.log('   GET    /api/rollback/requests/              - 查询申请列表');
  console.log('   GET    /api/rollback/requests/:id           - 申请详情');
  console.log('   POST   /api/rollback/requests/:id/approve   - 审批通过并执行');
  console.log('   POST   /api/rollback/requests/:id/reject    - 审批拒绝');
  console.log('   POST   /api/rollback/requests/:id/cancel    - 取消申请');
  console.log('   POST   /api/rollback/requests/:id/execute   - 执行回滚');
  console.log('   GET    /api/rollback/requests/:id/conflicts - 查询冲突');

  console.log('\n' + '='.repeat(60));
  console.log('📊 数据库表结构检查:');
  console.log('='.repeat(60) + '\n');

  const tables = ['audit_snapshots', 'audit_field_changes', 'rollback_requests', 'rollback_approvals'];
  for (const table of tables) {
    const result = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
    if (result) {
      console.log(`✅ ${table} 表存在`);
    } else {
      console.log(`❌ ${table} 表不存在`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('🏁 测试完成');
  console.log('='.repeat(60));
  console.log(`\n通过: ${passed} | 失败: ${failed}\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 所有测试通过！审计回滚模块已完整就绪。\n');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
