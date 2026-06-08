#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.test') });

const TEST_PORT = process.env.PORT || 3001;
const TEST_DB_PATH = path.resolve(__dirname, '..', process.env.DB_PATH || './data/test-cemetery.db');
const PROJECT_ROOT = path.resolve(__dirname, '..');

const log = (msg, type = 'info') => {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`[${timestamp}] ${prefix} ${msg}`);
};

const logSection = (title) => {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70) + '\n');
};

const runCommand = (cmd, args, options = {}) => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      stdio: options.stdio || 'inherit',
      env: { ...process.env, ...options.env },
      shell: process.platform === 'win32'
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || options.allowFailure) {
        resolve(code);
      } else {
        reject(new Error(`Command failed with code ${code}: ${cmd} ${args.join(' ')}`));
      }
    });
  });
};

const cleanupTestDb = () => {
  log('清理旧的测试数据库...');
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
    log(`已删除测试数据库: ${TEST_DB_PATH}`);
  }
  const shmPath = TEST_DB_PATH + '-shm';
  const walPath = TEST_DB_PATH + '-wal';
  [shmPath, walPath].forEach(p => {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  });
};

const initTestDb = async () => {
  log('初始化测试数据库...');
  await runCommand('node', ['scripts/init-db.js'], {
    env: {
      ...process.env,
      DB_PATH: process.env.DB_PATH,
      PORT: TEST_PORT
    }
  });
  log('测试数据库初始化完成');
};

const runMigrations = async () => {
  log('执行数据库迁移...');
  await runCommand('node', ['scripts/migrate-db.js'], {
    env: {
      ...process.env,
      DB_PATH: process.env.DB_PATH,
      PORT: TEST_PORT
    }
  });
  log('数据库迁移完成');
};

const seedTestData = async () => {
  log('导入测试数据...');
  await runCommand('node', ['scripts/seed-data.js'], {
    env: {
      ...process.env,
      DB_PATH: process.env.DB_PATH,
      PORT: TEST_PORT
    }
  });
  log('测试数据导入完成');
};

const waitForServer = async (timeout = 30000) => {
  const startTime = Date.now();
  const http = require('http');

  while (Date.now() - startTime < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${TEST_PORT}/api/health`, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Status: ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.end();
      });
      return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`服务器在 ${timeout}ms 内未就绪`);
};

const startTestServer = () => {
  return new Promise((resolve, reject) => {
    log(`启动测试服务器 (端口: ${TEST_PORT})...`);

    const serverProcess = spawn('node', ['app.js'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DB_PATH: process.env.DB_PATH,
        PORT: TEST_PORT,
        NODE_ENV: 'test'
      },
      shell: process.platform === 'win32'
    });

    let serverReady = false;
    let outputBuffer = '';

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      outputBuffer += msg;
      process.stdout.write(`[SERVER] ${msg}`);

      if (!serverReady && msg.includes('服务器运行在')) {
        serverReady = true;
      }
    });

    serverProcess.stderr.on('data', (data) => {
      process.stderr.write(`[SERVER ERR] ${data.toString()}`);
    });

    serverProcess.on('error', (err) => {
      if (!serverReady) reject(err);
    });

    serverProcess.on('exit', (code) => {
      if (!serverReady && code !== 0) {
        reject(new Error(`服务器启动失败，退出码: ${code}`));
      }
    });

    const checkReady = async () => {
      try {
        await waitForServer(15000);
        log('测试服务器已就绪');
        resolve(serverProcess);
      } catch (e) {
        serverProcess.kill();
        reject(e);
      }
    };

    checkReady();
  });
};

const runNodeTests = async () => {
  logSection('执行 Node.js 单元测试');

  const testFiles = [
    'tests/verify-audit-rollback.js',
    'tests/verify-concurrency-boundary.js'
  ];

  const results = [];

  for (const testFile of testFiles) {
    log(`运行测试: ${testFile}`);
    try {
      await runCommand('node', [testFile], {
        env: {
          ...process.env,
          DB_PATH: process.env.DB_PATH,
          TEST_PORT,
          TEST_BASE_URL: `http://localhost:${TEST_PORT}`
        }
      });
      results.push({ file: testFile, passed: true });
      log(`✅ ${testFile} 测试通过`, 'success');
    } catch (e) {
      results.push({ file: testFile, passed: false, error: e.message });
      log(`❌ ${testFile} 测试失败: ${e.message}`, 'error');
    }
  }

  return results;
};

const runPythonTests = async () => {
  logSection('执行 Python API 测试');

  const testFiles = [
    'test-minimal.py',
    'test-api.py',
    'test-contracts.py',
    'test-bill-generation.py',
    'test-bill-fixes.py',
    'test-expired-reservations.py',
    'test-festival-api.py',
    'test-festival-fixes.py',
    'test-festival-slot-id.py',
    'test-auto-festival-slot.py',
    'test-reminder-tasks.py',
    'test-staff-followup.py',
    'test-maintenance-orders.py',
    'test-service-api.py',
    'test-service-fix.py',
    'test-import-api.py',
    'test-handler-name.py',
    'test-empty-update-fix.py',
    'test-appointment-update-fix.py',
    'test-bugfixes.py',
    'test-concurrency-boundary.py'
  ];

  const results = [];

  for (const testFile of testFiles) {
    const filePath = path.join(PROJECT_ROOT, testFile);
    if (!fs.existsSync(filePath)) {
      log(`⚠️  跳过不存在的测试文件: ${testFile}`, 'warn');
      continue;
    }

    log(`运行测试: ${testFile}`);
    try {
      await runCommand('python3', [testFile], {
        env: {
          ...process.env,
          TEST_PORT,
          TEST_BASE_URL: `http://localhost:${TEST_PORT}`
        }
      });
      results.push({ file: testFile, passed: true });
      log(`✅ ${testFile} 测试通过`, 'success');
    } catch (e) {
      results.push({ file: testFile, passed: false, error: e.message });
      log(`❌ ${testFile} 测试失败: ${e.message}`, 'error');
    }
    console.log('');
  }

  return results;
};

const printSummary = (nodeResults, pythonResults) => {
  logSection('测试结果汇总');

  const allResults = [...nodeResults, ...pythonResults];
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;
  const total = allResults.length;

  console.log(`总测试数: ${total}`);
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  console.log(`通过率: ${((passed / total) * 100).toFixed(1)}%`);

  if (failed > 0) {
    console.log('\n失败的测试:');
    allResults.filter(r => !r.passed).forEach(r => {
      console.log(`  ❌ ${r.file}`);
      console.log(`     ${r.error}`);
    });
  }

  console.log('\n' + '='.repeat(70));

  return failed === 0;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  return {
    nodeOnly: args.includes('--node-only'),
    pythonOnly: args.includes('--python-only')
  };
};

const main = async () => {
  const options = parseArgs();
  let serverProcess = null;
  let allPassed = false;

  const runNode = !options.pythonOnly;
  const runPython = !options.nodeOnly;

  try {
    logSection('本地回归测试开始');
    log(`测试端口: ${TEST_PORT}`);
    log(`测试数据库: ${TEST_DB_PATH}`);
    if (options.nodeOnly) log('运行模式: 仅 Node.js 测试');
    if (options.pythonOnly) log('运行模式: 仅 Python 测试');

    cleanupTestDb();

    logSection('数据库初始化');
    await initTestDb();
    await runMigrations();
    await seedTestData();

    logSection('启动测试服务');
    serverProcess = await startTestServer();

    logSection('执行测试');
    const nodeResults = runNode ? await runNodeTests() : [];
    const pythonResults = runPython ? await runPythonTests() : [];

    allPassed = printSummary(nodeResults, pythonResults);

  } catch (error) {
    log(`测试执行出错: ${error.message}`, 'error');
    console.error(error.stack);
    allPassed = false;
  } finally {
    logSection('清理环境');

    if (serverProcess && !serverProcess.killed) {
      log('停止测试服务器...');
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
      log('测试服务器已停止');
    }

    log('清理测试数据库...');
    cleanupTestDb();
    log('测试数据库已清理');

    logSection(allPassed ? '所有测试通过 ✅' : '测试失败 ❌');
    process.exit(allPassed ? 0 : 1);
  }
};

process.on('SIGINT', () => {
  log('\n收到中断信号，正在清理...', 'warn');
  cleanupTestDb();
  process.exit(1);
});

main();
