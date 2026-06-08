const moment = require('moment');
const { run, get, all, runInTransaction } = require('../utils/dbHelper');

const {
  CONTRACT_STATUSES,
  STATUS_NAMES,
  PLOT_STATUSES,
  ALLOWED_STATUS_TRANSITIONS,
  VALID_STATUSES_FOR_UPDATE,
  VALID_STATUSES_FOR_SIGN,
  VALID_STATUSES_FOR_PAY,
  VALID_STATUSES_FOR_DELETE,
  VALID_STATUSES_FOR_RENEW
} = require('../services/contractConstants');

const {
  validatePlotExists,
  validatePlotNotUnderMaintenance,
  checkDeceasedOccupancy,
  checkActiveReservation,
  checkActiveContract,
  checkPlotAvailability,
  checkAvailabilityForSign,
  checkAvailabilityForEffective
} = require('../services/plotAvailabilityService');

const {
  validateContractExists,
  validateStatusTransition,
  validateForUpdate,
  validateForSign,
  validateForPay,
  validateForDelete,
  validateForRenew,
  validateDeceasedForContract,
  checkCanBecomeEffective
} = require('../services/contractStatusService');

const {
  getOperatorInfo,
  logContractStatusChange,
  logOperationWithOperator,
  generateStatusChangeSummary
} = require('../services/operationLogService');

const {
  hasOtherActiveReservations,
  hasOtherActiveContracts,
  hasOtherDeceasedOccupants,
  syncPlotStatusAfterContractChange
} = require('../services/plotStatusSyncService');

const {
  validateReservationForRelease
} = require('../services/reservationReleaseService');

let passed = 0;
let failed = 0;
let timestamp = Date.now();

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

async function createTestPlot(plotNumber, status = '空闲') {
  const result = await run(
    `INSERT INTO plots (plot_number, area, row, col, status, type, price) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [plotNumber, 'REFACTOR-TEST', 99, parseInt(plotNumber.split('-').pop()), status, '双穴', 80000]
  );
  return result.id;
}

async function createTestDeceased(name, plotId = null) {
  const result = await run(
    `INSERT INTO deceased (name, gender, birth_date, death_date, plot_id) 
     VALUES (?, ?, ?, ?, ?)`,
    [name, '男', '1950-01-01', '2024-01-01', plotId]
  );
  return result.id;
}

async function createTestContract(plotId, status, reservedExpiresAt = null, deceasedId = null) {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const contractNo = `HT${moment().format('YYYYMMDD')}${Math.floor(Math.random() * 10000)}`;
  const data = [
    contractNo, plotId, status, 80000, 3000, 20, 83000, 1, '测试管理员'
  ];
  const fields = [
    'contract_no', 'plot_id', 'status', 'plot_price', 'management_fee', 
    'management_fee_years', 'total_amount', 'created_by', 'created_by_name'
  ];
  
  if (reservedExpiresAt) {
    fields.splice(6, 0, 'reserved_at', 'reserved_expires_at');
    data.splice(6, 0, now, reservedExpiresAt);
  }
  if (deceasedId) {
    const idx = fields.indexOf('total_amount') + 1;
    fields.splice(idx, 0, 'deceased_id');
    data.splice(idx, 0, deceasedId);
  }
  
  const result = await run(
    `INSERT INTO contracts (${fields.join(', ')})
     VALUES (${data.map(() => '?').join(', ')})`,
    data
  );
  return result.id;
}

async function createTestReservation(plotId, contractId, contactName, contactPhone, expiresAt, status = 'active') {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await run(
    `INSERT INTO plot_reservations (plot_id, contract_id, contact_name, contact_phone, reserved_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [plotId, contractId, contactName, contactPhone, now, expiresAt, status]
  );
}

async function cleanupTestData() {
  await run(`DELETE FROM plot_reservations WHERE plot_id IN (SELECT id FROM plots WHERE area = 'REFACTOR-TEST')`);
  await run(`DELETE FROM contract_status_logs WHERE contract_id IN (SELECT id FROM contracts WHERE plot_id IN (SELECT id FROM plots WHERE area = 'REFACTOR-TEST'))`);
  await run(`DELETE FROM contracts WHERE plot_id IN (SELECT id FROM plots WHERE area = 'REFACTOR-TEST')`);
  await run(`DELETE FROM deceased WHERE plot_id IN (SELECT id FROM plots WHERE area = 'REFACTOR-TEST') OR name LIKE 'REFACTOR-%'`);
  await run(`DELETE FROM plots WHERE area = 'REFACTOR-TEST'`);
  await run(`DELETE FROM operation_logs WHERE summary LIKE '%REFACTOR%' OR summary LIKE '%refactor%'`);
}

const tests = [
  test('常量定义正确性验证', async () => {
    if (Object.keys(CONTRACT_STATUSES).length !== 5) {
      throw new Error('CONTRACT_STATUSES 常量数量不正确');
    }
    if (Object.keys(PLOT_STATUSES).length !== 4) {
      throw new Error('PLOT_STATUSES 常量数量不正确');
    }
    if (!ALLOWED_STATUS_TRANSITIONS[CONTRACT_STATUSES.DRAFT].includes(CONTRACT_STATUSES.RESERVED)) {
      throw new Error('状态流转定义不正确');
    }
    console.log('   ℹ️  常量定义正确');
  }),

  test('墓位可用性检查 - 墓位不存在', async () => {
    const result = await validatePlotExists(999999);
    if (result.valid !== false) {
      throw new Error('应该返回墓位不存在');
    }
    console.log('   ℹ️  正确识别不存在的墓位');
  }),

  test('墓位可用性检查 - 维修中墓位', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-001`, PLOT_STATUSES.MAINTENANCE);
    const plotResult = await validatePlotExists(plotId);
    const result = validatePlotNotUnderMaintenance(plotResult.plot);
    if (result.valid !== false) {
      throw new Error('应该返回墓位正在维修中');
    }
    console.log('   ℹ️  正确识别维修中墓位');
  }),

  test('墓位可用性检查 - 被逝者占用', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-002`);
    const deceasedId = await createTestDeceased('REFACTOR-逝者-001', plotId);
    
    const result = await checkDeceasedOccupancy(plotId);
    if (result.occupied !== true) {
      throw new Error('应该返回墓位被逝者占用');
    }
    if (result.occupant_id !== deceasedId) {
      throw new Error('占用者ID不正确');
    }
    console.log('   ℹ️  正确识别被逝者占用的墓位');
  }),

  test('墓位可用性检查 - 被有效预留占用', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-003`);
    const expiresAt = moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
    const contractId = await createTestContract(plotId, CONTRACT_STATUSES.RESERVED, expiresAt);
    await createTestReservation(plotId, contractId, '测试用户', '13800000000', expiresAt);
    
    const result = await checkActiveReservation(plotId);
    if (result.occupied !== true) {
      throw new Error('应该返回墓位被预留占用');
    }
    if (result.contract_id !== contractId) {
      throw new Error('预留合同ID不正确');
    }
    console.log('   ℹ️  正确识别被有效预留占用的墓位');
  }),

  test('墓位可用性检查 - 过期预留应该可以通过', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-004`);
    const expiresAt = moment().subtract(1, 'day').format('YYYY-MM-DD HH:mm:ss');
    const contractId = await createTestContract(plotId, CONTRACT_STATUSES.RESERVED, expiresAt);
    await createTestReservation(plotId, contractId, '过期用户', '13900000000', expiresAt);
    
    const reservationResult = await checkActiveReservation(plotId);
    const availabilityResult = await checkPlotAvailability(plotId);
    
    if (!reservationResult.is_expired) {
      throw new Error('应该识别为过期预留');
    }
    if (availabilityResult.available !== true) {
      throw new Error('过期预留应该允许通过可用性检查');
    }
    console.log('   ℹ️  正确处理过期预留');
  }),

  test('墓位可用性检查 - 已签约合同占用', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-005`);
    const contractId = await createTestContract(plotId, CONTRACT_STATUSES.SIGNED);
    
    const result = await checkActiveContract(plotId);
    if (result.occupied !== true) {
      throw new Error('应该返回墓位被已签约合同占用');
    }
    if (result.contract_status !== CONTRACT_STATUSES.SIGNED) {
      throw new Error('合同状态不正确');
    }
    console.log('   ℹ️  正确识别被已签约合同占用的墓位');
  }),

  test('墓位可用性检查 - 排除指定合同', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-006`);
    const expiresAt = moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
    const contractId = await createTestContract(plotId, CONTRACT_STATUSES.RESERVED, expiresAt);
    await createTestReservation(plotId, contractId, '测试用户', '13800000000', expiresAt);
    
    const resultWithExclude = await checkActiveReservation(plotId, contractId);
    if (resultWithExclude.occupied !== false) {
      throw new Error('排除指定合同后应该返回未被占用');
    }
    console.log('   ℹ️  正确处理排除指定合同的情况');
  }),

  test('合同状态校验 - 更新操作状态检查', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-007`);
    const draftContractId = await createTestContract(plotId, CONTRACT_STATUSES.DRAFT);
    const effectiveContractId = await createTestContract(plotId, CONTRACT_STATUSES.EFFECTIVE);
    
    const draftContract = (await validateContractExists(draftContractId)).contract;
    const effectiveContract = (await validateContractExists(effectiveContractId)).contract;
    
    const draftValidation = validateForUpdate(draftContract);
    const effectiveValidation = validateForUpdate(effectiveContract);
    
    if (draftValidation.valid !== true) {
      throw new Error('草稿合同应该允许更新');
    }
    if (effectiveValidation.valid !== false) {
      throw new Error('已生效合同不应该允许更新');
    }
    console.log('   ℹ️  正确校验更新操作的合同状态');
  }),

  test('合同状态校验 - 签约操作状态检查', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-008`);
    const reservedContractId = await createTestContract(plotId, CONTRACT_STATUSES.RESERVED, moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss'));
    const voidedContractId = await createTestContract(plotId, CONTRACT_STATUSES.VOIDED);
    
    const reservedContract = (await validateContractExists(reservedContractId)).contract;
    const voidedContract = (await validateContractExists(voidedContractId)).contract;
    
    const reservedValidation = validateForSign(reservedContract);
    const voidedValidation = validateForSign(voidedContract);
    
    if (reservedValidation.valid !== true) {
      throw new Error('预留合同应该允许签约');
    }
    if (voidedValidation.valid !== false) {
      throw new Error('已作废合同不应该允许签约');
    }
    console.log('   ℹ️  正确校验签约操作的合同状态');
  }),

  test('合同状态校验 - 付款操作状态检查', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-009`);
    const signedContractId = await createTestContract(plotId, CONTRACT_STATUSES.SIGNED);
    const draftContractId = await createTestContract(plotId, CONTRACT_STATUSES.DRAFT);
    const voidedContractId = await createTestContract(plotId, CONTRACT_STATUSES.VOIDED);
    
    const signedContract = (await validateContractExists(signedContractId)).contract;
    const draftContract = (await validateContractExists(draftContractId)).contract;
    const voidedContract = (await validateContractExists(voidedContractId)).contract;
    
    const signedValidation = validateForPay(signedContract);
    const draftValidation = validateForPay(draftContract);
    const voidedValidation = validateForPay(voidedContract);
    
    if (signedValidation.valid !== true) {
      throw new Error('已签约合同应该允许付款');
    }
    if (draftValidation.valid !== false) {
      throw new Error('草稿合同不应该允许付款');
    }
    if (voidedValidation.valid !== false) {
      throw new Error('已作废合同不应该允许付款');
    }
    console.log('   ℹ️  正确校验付款操作的合同状态');
  }),

  test('合同状态校验 - 删除操作状态检查', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-010`);
    const draftContractId = await createTestContract(plotId, CONTRACT_STATUSES.DRAFT);
    const signedContractId = await createTestContract(plotId, CONTRACT_STATUSES.SIGNED);
    
    const draftContract = (await validateContractExists(draftContractId)).contract;
    const signedContract = (await validateContractExists(signedContractId)).contract;
    
    const draftValidation = validateForDelete(draftContract);
    const signedValidation = validateForDelete(signedContract);
    
    if (draftValidation.valid !== true) {
      throw new Error('草稿合同应该允许删除');
    }
    if (signedValidation.valid !== false) {
      throw new Error('已签约合同不应该允许删除');
    }
    console.log('   ℹ️  正确校验删除操作的合同状态');
  }),

  test('合同状态校验 - 续期操作状态检查', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-011`);
    const validExpiresAt = moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
    const expiredExpiresAt = moment().subtract(1, 'day').format('YYYY-MM-DD HH:mm:ss');
    
    const validContractId = await createTestContract(plotId, CONTRACT_STATUSES.RESERVED, validExpiresAt);
    const expiredContractId = await createTestContract(plotId, CONTRACT_STATUSES.RESERVED, expiredExpiresAt);
    const draftContractId = await createTestContract(plotId, CONTRACT_STATUSES.DRAFT);
    
    const validContract = (await validateContractExists(validContractId)).contract;
    const expiredContract = (await validateContractExists(expiredContractId)).contract;
    const draftContract = (await validateContractExists(draftContractId)).contract;
    
    const validValidation = validateForRenew(validContract);
    const expiredValidation = validateForRenew(expiredContract);
    const draftValidation = validateForRenew(draftContract);
    
    if (validValidation.valid !== true) {
      throw new Error('有效预留合同应该允许续期');
    }
    if (expiredValidation.valid !== false) {
      throw new Error('过期预留合同不应该允许续期');
    }
    if (draftValidation.valid !== false) {
      throw new Error('草稿合同不应该允许续期');
    }
    console.log('   ℹ️  正确校验续期操作的合同状态');
  }),

  test('合同状态流转校验', async () => {
    const validTransitions = [
      [CONTRACT_STATUSES.DRAFT, CONTRACT_STATUSES.RESERVED],
      [CONTRACT_STATUSES.DRAFT, CONTRACT_STATUSES.SIGNED],
      [CONTRACT_STATUSES.RESERVED, CONTRACT_STATUSES.SIGNED],
      [CONTRACT_STATUSES.RESERVED, CONTRACT_STATUSES.DRAFT],
      [CONTRACT_STATUSES.SIGNED, CONTRACT_STATUSES.EFFECTIVE],
      [CONTRACT_STATUSES.SIGNED, CONTRACT_STATUSES.VOIDED],
      [CONTRACT_STATUSES.EFFECTIVE, CONTRACT_STATUSES.VOIDED]
    ];
    
    const invalidTransitions = [
      [CONTRACT_STATUSES.DRAFT, CONTRACT_STATUSES.EFFECTIVE],
      [CONTRACT_STATUSES.RESERVED, CONTRACT_STATUSES.EFFECTIVE],
      [CONTRACT_STATUSES.EFFECTIVE, CONTRACT_STATUSES.SIGNED],
      [CONTRACT_STATUSES.VOIDED, CONTRACT_STATUSES.DRAFT]
    ];
    
    for (const [from, to] of validTransitions) {
      const result = validateStatusTransition(from, to);
      if (result.valid !== true) {
        throw new Error(`状态流转 ${from} -> ${to} 应该有效`);
      }
    }
    
    for (const [from, to] of invalidTransitions) {
      const result = validateStatusTransition(from, to);
      if (result.valid !== false) {
        throw new Error(`状态流转 ${from} -> ${to} 应该无效`);
      }
    }
    console.log('   ℹ️  正确校验所有状态流转');
  }),

  test('逝者关联校验 - 未关联其他墓位', async () => {
    const plotId1 = await createTestPlot(`REFACTOR-${timestamp}-012`);
    const plotId2 = await createTestPlot(`REFACTOR-${timestamp}-013`);
    const deceasedId = await createTestDeceased('REFACTOR-逝者-002');
    
    const result = await validateDeceasedForContract(deceasedId, plotId1);
    if (result.valid !== true) {
      throw new Error('未关联其他墓位的逝者应该允许关联');
    }
    console.log('   ℹ️  正确校验未关联其他墓位的逝者');
  }),

  test('逝者关联校验 - 已关联其他墓位', async () => {
    const plotId1 = await createTestPlot(`REFACTOR-${timestamp}-014`);
    const plotId2 = await createTestPlot(`REFACTOR-${timestamp}-015`);
    const deceasedId = await createTestDeceased('REFACTOR-逝者-003', plotId1);
    
    const result = await validateDeceasedForContract(deceasedId, plotId2);
    if (result.valid !== false) {
      throw new Error('已关联其他墓位的逝者不应该允许关联');
    }
    console.log('   ℹ️  正确校验已关联其他墓位的逝者');
  }),

  test('合同生效条件检查', async () => {
    const contract1 = { status: CONTRACT_STATUSES.SIGNED, total_amount: 83000 };
    const contract2 = { status: CONTRACT_STATUSES.EFFECTIVE, total_amount: 83000 };
    
    if (!checkCanBecomeEffective(contract1, 83000)) {
      throw new Error('已签约且全额付款的合同应该可以生效');
    }
    if (checkCanBecomeEffective(contract1, 80000)) {
      throw new Error('未全额付款的合同不应该可以生效');
    }
    if (checkCanBecomeEffective(contract2, 83000)) {
      throw new Error('已生效合同不应该重复生效');
    }
    console.log('   ℹ️  正确判断合同生效条件');
  }),

  test('墓位状态同步 - 检查是否有其他活跃合同', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-016`);
    const contractId1 = await createTestContract(plotId, CONTRACT_STATUSES.SIGNED);
    const contractId2 = await createTestContract(plotId, CONTRACT_STATUSES.VOIDED);
    
    const hasOther1 = await hasOtherActiveContracts(plotId, contractId1);
    const hasOther2 = await hasOtherActiveContracts(plotId, contractId2);
    
    if (hasOther1 !== false) {
      throw new Error('排除已签约合同后应该没有其他活跃合同');
    }
    if (hasOther2 !== true) {
      throw new Error('排除已作废合同后应该还有其他活跃合同');
    }
    console.log('   ℹ️  正确检查其他活跃合同');
  }),

  test('墓位状态同步 - 检查是否有其他逝者占用', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-017`);
    const deceasedId1 = await createTestDeceased('REFACTOR-逝者-004', plotId);
    const deceasedId2 = await createTestDeceased('REFACTOR-逝者-005');
    
    const hasOther1 = await hasOtherDeceasedOccupants(plotId, deceasedId1);
    const hasOther2 = await hasOtherDeceasedOccupants(plotId, deceasedId2);
    
    if (hasOther1 !== false) {
      throw new Error('排除已关联逝者后应该没有其他逝者占用');
    }
    if (hasOther2 !== true) {
      throw new Error('排除未关联逝者后应该还有其他逝者占用');
    }
    console.log('   ℹ️  正确检查其他逝者占用');
  }),

  test('预留释放校验 - 已签约合同不能释放', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-018`);
    const expiresAt = moment().subtract(1, 'day').format('YYYY-MM-DD HH:mm:ss');
    const contractId = await createTestContract(plotId, CONTRACT_STATUSES.SIGNED);
    await createTestReservation(plotId, contractId, '测试用户', '13800000000', expiresAt);
    
    const reservation = { id: 1, contract_id: contractId, plot_id: plotId };
    const result = await validateReservationForRelease(reservation);
    
    if (result.valid !== false) {
      throw new Error('已签约合同的预留不应该能释放');
    }
    if (!result.reason.includes('已签约')) {
      throw new Error('错误提示应该包含已签约');
    }
    console.log('   ℹ️  正确阻止释放已签约合同的预留');
  }),

  test('预留释放校验 - 未过期预留不能释放', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-019`);
    const expiresAt = moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
    const contractId = await createTestContract(plotId, CONTRACT_STATUSES.RESERVED, expiresAt);
    await createTestReservation(plotId, contractId, '测试用户', '13800000000', expiresAt);
    
    const reservation = { id: 1, contract_id: contractId, plot_id: plotId };
    const result = await validateReservationForRelease(reservation);
    
    if (result.valid !== false) {
      throw new Error('未过期的预留不应该能释放');
    }
    if (!result.reason.includes('尚未过期')) {
      throw new Error('错误提示应该包含尚未过期');
    }
    console.log('   ℹ️  正确阻止释放未过期的预留');
  }),

  test('操作日志服务 - 操作者信息提取', async () => {
    const mockReq = {
      user: { id: 1, name: '测试用户' },
      headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1' },
      ip: '127.0.0.1'
    };
    
    const info = getOperatorInfo(mockReq);
    if (info.operatorId !== 1) {
      throw new Error('操作者ID提取不正确');
    }
    if (info.operatorName !== '测试用户') {
      throw new Error('操作者名称提取不正确');
    }
    if (info.ipAddress !== '192.168.1.1') {
      throw new Error('IP地址提取不正确');
    }
    console.log('   ℹ️  正确提取操作者信息');
  }),

  test('操作日志服务 - 状态变更摘要生成', async () => {
    const summary1 = generateStatusChangeSummary(
      CONTRACT_STATUSES.RESERVED,
      CONTRACT_STATUSES.DRAFT,
      '预留过期自动释放',
      'HT202401010001',
      'A-001'
    );
    
    if (!summary1.includes('HT202401010001')) {
      throw new Error('摘要应该包含合同号');
    }
    if (!summary1.includes('A-001')) {
      throw new Error('摘要应该包含墓位号');
    }
    if (!summary1.includes('预留过期自动释放')) {
      throw new Error('摘要应该包含原因');
    }
    console.log('   ℹ️  正确生成状态变更摘要');
  }),

  test('签约时可用性检查 - 排除自身合同', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-020`);
    const expiresAt = moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
    const contractId = await createTestContract(plotId, CONTRACT_STATUSES.RESERVED, expiresAt);
    await createTestReservation(plotId, contractId, '测试用户', '13800000000', expiresAt);
    
    const result = await checkAvailabilityForSign(plotId, contractId);
    if (result.valid !== true) {
      throw new Error('排除自身合同后应该可以签约');
    }
    console.log('   ℹ️  签约时正确排除自身合同');
  }),

  test('事务边界 - 回滚测试', async () => {
    const plotId = await createTestPlot(`REFACTOR-${timestamp}-021`);
    let contractCreated = false;
    let contractId = null;
    
    try {
      await runInTransaction(async () => {
        const result = await run(
          `INSERT INTO contracts (contract_no, plot_id, status, plot_price, management_fee, management_fee_years, total_amount, created_by, created_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ['HT-ROLLBACK-TEST', plotId, CONTRACT_STATUSES.DRAFT, 80000, 3000, 20, 83000, 1, '测试管理员']
        );
        contractId = result.id;
        contractCreated = true;
        throw new Error('模拟事务回滚');
      });
    } catch (err) {
      if (!err.message.includes('模拟事务回滚')) {
        throw err;
      }
    }
    
    if (contractCreated && contractId) {
      const contract = await get('SELECT id FROM contracts WHERE id = ?', [contractId]);
      if (contract) {
        throw new Error('事务回滚后合同不应该存在');
      }
    }
    console.log('   ℹ️  事务回滚正确工作');
  }),

  test('清理测试数据', async () => {
    await cleanupTestData();
    console.log('   ℹ️  测试数据清理完成');
  })
];

async function runTests() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 合同模块服务层重构 回归验证测试');
  console.log('='.repeat(80));
  console.log(`测试时间: ${moment().format('YYYY-MM-DD HH:mm:ss')}`);
  console.log(`时间戳: ${timestamp}`);
  console.log(`测试项: ${tests.length}个\n`);

  console.log('📋 一、常量定义测试:\n');
  await tests[0]();

  console.log('\n📋 二、墓位可用性检查测试:\n');
  for (let i = 1; i < 8; i++) {
    await tests[i]();
  }

  console.log('\n📋 三、合同状态校验测试:\n');
  for (let i = 8; i < 16; i++) {
    await tests[i]();
  }

  console.log('\n📋 四、逝者关联校验测试:\n');
  for (let i = 16; i < 18; i++) {
    await tests[i]();
  }

  console.log('\n📋 五、墓位状态同步测试:\n');
  for (let i = 18; i < 20; i++) {
    await tests[i]();
  }

  console.log('\n📋 六、预留释放校验测试:\n');
  for (let i = 20; i < 22; i++) {
    await tests[i]();
  }

  console.log('\n📋 七、操作日志服务测试:\n');
  for (let i = 22; i < 24; i++) {
    await tests[i]();
  }

  console.log('\n📋 八、集成与事务测试:\n');
  for (let i = 24; i < tests.length; i++) {
    await tests[i]();
  }

  console.log('\n' + '='.repeat(80));
  console.log('📊 测试结果汇总');
  console.log('='.repeat(80));
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  console.log(`📈 通过率: ${(passed / (passed + failed) * 100).toFixed(1)}%`);
  console.log('='.repeat(80) + '\n');

  if (failed > 0) {
    console.log('⚠️  部分测试失败，请检查相关功能');
    process.exit(1);
  } else {
    console.log('🎉 所有回归验证测试通过！服务层重构完成。');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
