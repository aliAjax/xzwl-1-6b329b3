#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawn, execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_TEST_PATH = path.resolve(PROJECT_ROOT, '.env.test');

if (fs.existsSync(ENV_TEST_PATH)) {
  require('dotenv').config({ path: ENV_TEST_PATH });
}

const TEST_PORT = parseInt(process.env.TEST_PORT || process.env.PORT || '3001', 10);
const TEST_DB_REL_PATH = process.env.TEST_DB_PATH || process.env.DB_PATH || './data/test-cemetery.db';
const TEST_DB_PATH = path.resolve(PROJECT_ROOT, TEST_DB_REL_PATH);
const TEST_TIMEOUT = parseInt(process.env.TEST_TIMEOUT || '600000', 10);
const STEP_TIMEOUT = parseInt(process.env.STEP_TIMEOUT || '120000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

const PID_FILE = path.resolve(PROJECT_ROOT, 'data', '.test-server.pid');

const log = (msg, type = 'info') => {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warn' ? '⚠️' : type === 'debug' ? '🔍' : 'ℹ️';
  console.log(`[${timestamp}] ${prefix} ${msg}`);
};

const logSection = (title) => {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70) + '\n');
};

const logStep = (step, total, msg) => {
  console.log(`\n  [${step}/${total}] ${msg}`);
};

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

const withTimeout = (promise, timeout, operationName) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`${operationName} 超时 (${timeout}ms)`));
    }, timeout);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

const withRetry = async (fn, retries = MAX_RETRIES, operationName) => {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < retries - 1) {
        const delay = Math.pow(2, i) * 1000;
        log(`⚠️  ${operationName} 失败，${delay / 1000}秒后重试 (${i + 1}/${retries}): ${err.message}`, 'warn');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
};

const checkPortInUse = (port) => {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
};

const getProcessIdOnPort = (port) => {
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const { spawnSync } = require('child_process');
      const result = spawnSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const output = (result.stdout || '').trim();
      return output ? output.split('\n').map(p => parseInt(p, 10)).filter(Boolean) : [];
    } else if (process.platform === 'win32') {
      const result = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf8',
        timeout: 2000
      });
      const matches = result.match(/LISTENING\s+(\d+)/g);
      return matches ? matches.map(m => parseInt(m.split(/\s+/).pop(), 10)).filter(Boolean) : [];
    }
  } catch (e) {
    log(`⚠️  获取端口进程失败: ${e.message}`, 'debug');
  }
  return [];
};

const killProcess = (pid, signal = 'SIGTERM') => {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid} 2>/dev/null || true`);
    } else {
      process.kill(pid, signal);
    }
    return true;
  } catch (e) {
    return false;
  }
};

const cleanupOrphanProcesses = async () => {
  log('检查并清理孤儿测试进程...', 'debug');

  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid && !isNaN(pid)) {
        log(`发现遗留的PID文件，进程ID: ${pid}`, 'warn');
        try {
          process.kill(pid, 0);
          log(`进程 ${pid} 仍在运行，正在强制终止...`, 'warn');
          killProcess(pid, 'SIGKILL');
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          log(`进程 ${pid} 已不存在`, 'debug');
        }
      }
      fs.unlinkSync(PID_FILE);
    } catch (e) {
      log(`⚠️  清理PID文件失败: ${e.message}`, 'warn');
    }
  }

  const pids = await getProcessIdOnPort(TEST_PORT);
  if (pids.length > 0) {
    log(`发现端口 ${TEST_PORT} 被以下进程占用: ${pids.join(', ')}`, 'warn');
    for (const pid of pids) {
      log(`正在终止进程 ${pid}...`, 'warn');
      killProcess(pid, 'SIGKILL');
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const portInUse = await checkPortInUse(TEST_PORT);
    if (!portInUse) {
      log('孤儿进程清理完成', 'debug');
      return;
    }
    log(`端口仍在使用中，等待释放... (尝试 ${attempt + 1}/3)`, 'warn');
    await new Promise(r => setTimeout(r, 1000));
  }

  const portInUse = await checkPortInUse(TEST_PORT);
  if (portInUse) {
    log(`⚠️  端口 ${TEST_PORT} 可能仍在使用中（可能是 TIME_WAIT 状态），继续执行...`, 'warn');
  } else {
    log('孤儿进程清理完成', 'debug');
  }
};

const isDbFileLocked = (dbPath) => {
  try {
    const fd = fs.openSync(dbPath, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EACCES') {
      return true;
    }
    return false;
  }
};

const cleanupTestDb = async () => {
  log('清理旧的测试数据库...');

  const filesToClean = [
    TEST_DB_PATH,
    TEST_DB_PATH + '-shm',
    TEST_DB_PATH + '-wal',
    TEST_DB_PATH + '-journal'
  ];

  for (const filePath of filesToClean) {
    if (fs.existsSync(filePath)) {
      if (isDbFileLocked(filePath)) {
        log(`⚠️  数据库文件被锁定，等待解锁...`, 'warn');
        await withTimeout(new Promise((resolve) => {
          const check = () => {
            if (!isDbFileLocked(filePath)) {
              resolve();
            } else {
              setTimeout(check, 500);
            }
          };
          check();
        }), 5000, '等待数据库解锁');
      }

      try {
        fs.unlinkSync(filePath);
        log(`已删除: ${path.basename(filePath)}`);
      } catch (e) {
        log(`⚠️  删除失败: ${filePath} - ${e.message}`, 'warn');
      }
    }
  }

  log('测试数据库清理完成');
};

const ensureDataDir = () => {
  const dataDir = path.dirname(TEST_DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    log(`已创建数据目录: ${dataDir}`);
  }
};

const getTestEnv = () => {
  return {
    ...process.env,
    DB_PATH: TEST_DB_PATH,
    TEST_DB_PATH: TEST_DB_PATH,
    PORT: TEST_PORT.toString(),
    TEST_PORT: TEST_PORT.toString(),
    TEST_BASE_URL: `http://localhost:${TEST_PORT}`,
    NODE_ENV: 'test',
    DOTENV_CONFIG_PATH: ENV_TEST_PATH
  };
};

const runCommand = (cmd, args, options = {}) => {
  return new Promise((resolve, reject) => {
    const env = { ...getTestEnv(), ...options.env };
    const timeout = options.timeout || STEP_TIMEOUT;
    const operationName = options.operationName || `${cmd} ${args.join(' ')}`;

    log(`执行命令: ${cmd} ${args.join(' ')}`, 'debug');

    const child = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      stdio: options.stdio || 'inherit',
      env,
      shell: process.platform === 'win32'
    });

    let timer;
    let timedOut = false;

    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        log(`⚠️  命令超时，正在终止: ${operationName}`, 'warn');
        if (process.platform === 'win32') {
          try { execSync(`taskkill /F /T /PID ${child.pid}`); } catch (e) {}
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {
            try { child.kill('SIGKILL'); } catch (e2) {}
          }
        }
        reject(new TimeoutError(`${operationName} 超时 (${timeout}ms)`));
      }, timeout);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (!timedOut) reject(err);
    });

    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return;

      if (code === 0 || options.allowFailure) {
        resolve(code);
      } else {
        reject(new Error(`${operationName} 失败，退出码: ${code}, 信号: ${signal}`));
      }
    });
  });
};

const checkDependencies = async () => {
  log('检查运行依赖...', 'debug');

  const errors = [];

  try {
    execSync('node --version', { stdio: 'ignore' });
  } catch (e) {
    errors.push('Node.js 未安装');
  }

  try {
    execSync('python3 --version', { stdio: 'ignore' });
  } catch (e) {
    errors.push('Python 3 未安装');
  }

  try {
    execSync('python3 -c "import requests"', { stdio: 'ignore' });
  } catch (e) {
    errors.push('Python requests 库未安装 (pip install requests)');
  }

  if (errors.length > 0) {
    throw new Error(`依赖检查失败:\n  ${errors.join('\n  ')}`);
  }

  log('依赖检查通过', 'debug');
};

const initTestDb = async () => {
  log('初始化测试数据库...');
  await withRetry(
    () => runCommand('node', ['scripts/init-db.js'], {
      operationName: '数据库初始化'
    }),
    2,
    '数据库初始化'
  );
  log('✅ 测试数据库初始化完成', 'success');
};

const runMigrations = async () => {
  log('执行数据库迁移...');
  await withRetry(
    () => runCommand('node', ['scripts/migrate-db.js'], {
      operationName: '数据库迁移'
    }),
    2,
    '数据库迁移'
  );
  log('✅ 数据库迁移完成', 'success');
};

const seedTestData = async () => {
  log('导入测试数据...');
  await withRetry(
    () => runCommand('node', ['scripts/seed-data.js'], {
      operationName: '测试数据导入'
    }),
    2,
    '测试数据导入'
  );
  log('✅ 测试数据导入完成', 'success');
};

const verifyDbInitialized = async () => {
  log('验证数据库初始化...', 'debug');

  if (!fs.existsSync(TEST_DB_PATH)) {
    throw new Error(`测试数据库不存在: ${TEST_DB_PATH}`);
  }

  const stats = fs.statSync(TEST_DB_PATH);
  if (stats.size < 1024) {
    throw new Error('测试数据库文件过小，可能初始化失败');
  }

  log(`✅ 数据库文件大小: ${(stats.size / 1024).toFixed(1)}KB`, 'debug');
};

const waitForServer = async (timeout = 30000) => {
  const startTime = Date.now();
  const http = require('http');
  let attempt = 0;

  while (Date.now() - startTime < timeout) {
    attempt++;
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${TEST_PORT}/api/health`, {
          timeout: 3000
        }, (res) => {
          if (res.statusCode === 200) {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const health = JSON.parse(data);
                if (health.code === 200) {
                  resolve();
                } else {
                  reject(new Error(`健康检查返回异常: ${health.message}`));
                }
              } catch (e) {
                resolve();
              }
            });
          } else {
            reject(new Error(`HTTP状态: ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('请求超时'));
        });
        req.end();
      });
      log(`✅ 健康检查通过 (第${attempt}次尝试)`, 'debug');
      return true;
    } catch (e) {
      const elapsed = Date.now() - startTime;
      const remaining = Math.ceil((timeout - elapsed) / 1000);
      if (remaining > 0) {
        log(`⏳ 等待服务就绪... (${e.message}, 剩余${remaining}秒)`, 'debug');
        await new Promise(r => setTimeout(r, Math.min(1000 * attempt, 3000)));
      }
    }
  }
  throw new Error(`服务器在 ${timeout}ms 内未就绪（尝试了${attempt}次）`);
};

const startTestServer = async () => {
  log(`启动测试服务器 (端口: ${TEST_PORT})...`);

  const serverProcess = spawn('node', ['app.js'], {
    cwd: PROJECT_ROOT,
    env: getTestEnv(),
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32'
  });

  fs.writeFileSync(PID_FILE, serverProcess.pid.toString());
  log(`服务器进程ID: ${serverProcess.pid}`, 'debug');

  let serverReady = false;
  let startupError = null;
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
    const msg = data.toString();
    outputBuffer += msg;
    process.stderr.write(`[SERVER ERR] ${data.toString()}`);
  });

  serverProcess.on('error', (err) => {
    startupError = err;
    log(`服务器启动错误: ${err.message}`, 'error');
  });

  serverProcess.on('exit', (code, signal) => {
    try {
      if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE);
      }
    } catch (e) {}

    if (!serverReady && code !== 0 && code !== null) {
      startupError = new Error(`服务器启动失败，退出码: ${code}, 信号: ${signal}`);
    }
  });

  try {
    await withTimeout(waitForServer(20000), 25000, '等待服务启动');
    log('✅ 测试服务器已就绪', 'success');
    return serverProcess;
  } catch (e) {
    if (startupError) {
      e.message = `${e.message}\n启动错误: ${startupError.message}`;
    }
    if (outputBuffer) {
      e.message = `${e.message}\n最后输出:\n${outputBuffer.slice(-1000)}`;
    }

    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${serverProcess.pid} 2>/dev/null || true`);
      } else {
        process.kill(-serverProcess.pid, 'SIGKILL');
      }
    } catch (killErr) {}

    throw e;
  }
};

const stopServer = async (serverProcess) => {
  if (!serverProcess || serverProcess.killed) {
    return;
  }

  log('停止测试服务器...');

  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch (e) {}

  return new Promise((resolve) => {
    let stopped = false;

    serverProcess.once('exit', () => {
      stopped = true;
      log('✅ 测试服务器已停止', 'success');
      resolve();
    });

    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /F /T /PID ${serverProcess.pid} 2>/dev/null || true`);
      } catch (e) {}
    } else {
      try {
        process.kill(-serverProcess.pid, 'SIGTERM');
      } catch (e) {
        try {
          serverProcess.kill('SIGTERM');
        } catch (e2) {}
      }
    }

    setTimeout(() => {
      if (!stopped) {
        log('⚠️  优雅停止超时，强制终止', 'warn');
        if (process.platform === 'win32') {
          try { execSync(`taskkill /F /T /PID ${serverProcess.pid} 2>/dev/null || true`); } catch (e) {}
        } else {
          try { process.kill(-serverProcess.pid, 'SIGKILL'); } catch (e) {
            try { serverProcess.kill('SIGKILL'); } catch (e2) {}
          }
        }
        setTimeout(resolve, 500);
      }
    }, 3000);
  });
};

const filterTestFiles = (testFiles, selectedFiles) => {
  if (!selectedFiles || selectedFiles.length === 0) {
    return testFiles;
  }

  const selected = new Set(selectedFiles.map(file => file.replace(/\\/g, '/')));
  return testFiles.filter(file => selected.has(file) || selected.has(path.basename(file)));
};

const runNodeTests = async (prepareTest, selectedFiles = []) => {
  logSection('执行 Node.js 单元测试');

  const testFiles = [
    'tests/verify-audit-rollback.js',
    'tests/verify-concurrency-boundary.js'
  ];

  const selectedTestFiles = filterTestFiles(testFiles, selectedFiles);
  const results = [];
  let step = 0;
  const total = selectedTestFiles.length;

  for (const testFile of selectedTestFiles) {
    step++;
    const filePath = path.join(PROJECT_ROOT, testFile);
    if (!fs.existsSync(filePath)) {
      log(`⚠️  跳过不存在的测试文件: ${testFile}`, 'warn');
      results.push({ file: testFile, passed: false, skipped: true, error: '文件不存在' });
      continue;
    }

    try {
      await prepareTest(testFile);
      logStep(step, total, `运行测试: ${testFile}`);
      await withTimeout(
        runCommand('node', [testFile], {
          operationName: testFile,
          timeout: 120000
        }),
        120000,
        testFile
      );
      results.push({ file: testFile, passed: true });
      log(`✅ ${testFile} 测试通过`, 'success');
    } catch (e) {
      results.push({ file: testFile, passed: false, error: e.message });
      log(`❌ ${testFile} 测试失败: ${e.message}`, 'error');
    }
  }

  return results;
};

const runPythonTests = async (prepareTest, selectedFiles = []) => {
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

  const selectedTestFiles = filterTestFiles(testFiles, selectedFiles);
  const results = [];
  let step = 0;
  const total = selectedTestFiles.length;

  for (const testFile of selectedTestFiles) {
    step++;
    const filePath = path.join(PROJECT_ROOT, testFile);
    if (!fs.existsSync(filePath)) {
      log(`⚠️  跳过不存在的测试文件: ${testFile}`, 'warn');
      results.push({ file: testFile, passed: false, skipped: true, error: '文件不存在' });
      continue;
    }

    try {
      await prepareTest(testFile);
      logStep(step, total, `运行测试: ${testFile}`);
      await withTimeout(
        runCommand('python3', [testFile], {
          operationName: testFile,
          timeout: 120000
        }),
        120000,
        testFile
      );
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
  const failed = allResults.filter(r => !r.passed && !r.skipped).length;
  const skipped = allResults.filter(r => r.skipped).length;
  const total = allResults.length;

  console.log(`总测试数: ${total}`);
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  if (skipped > 0) {
    console.log(`⏭️  跳过: ${skipped}`);
  }
  console.log(`通过率: ${((passed / (total - skipped)) * 100).toFixed(1)}%`);

  if (failed > 0) {
    console.log('\n失败的测试:');
    allResults.filter(r => !r.passed && !r.skipped).forEach(r => {
      console.log(`  ❌ ${r.file}`);
      console.log(`     ${r.error}`);
    });
  }

  if (skipped > 0) {
    console.log('\n跳过的测试:');
    allResults.filter(r => r.skipped).forEach(r => {
      console.log(`  ⏭️  ${r.file} - ${r.error}`);
    });
  }

  console.log('\n' + '='.repeat(70));

  return failed === 0;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const selectedFiles = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' || args[i] === '--test-file') {
      if (args[i + 1]) {
        selectedFiles.push(args[i + 1]);
        i++;
      }
    } else if (!args[i].startsWith('--')) {
      selectedFiles.push(args[i]);
    }
  }

  return {
    nodeOnly: args.includes('--node-only'),
    pythonOnly: args.includes('--python-only'),
    noCleanup: args.includes('--no-cleanup'),
    verbose: args.includes('--verbose'),
    selectedFiles
  };
};

const main = async () => {
  const options = parseArgs();
  let serverProcess = null;
  let allPassed = false;
  const startTime = Date.now();

  const runNode = !options.pythonOnly;
  const runPython = !options.nodeOnly;

  const globalTimer = setTimeout(() => {
    log(`⚠️  测试总超时 (${TEST_TIMEOUT}ms)，强制终止...`, 'error');
    process.emit('SIGINT');
    setTimeout(() => process.exit(1), 2000);
  }, TEST_TIMEOUT);

  const cleanup = async () => {
    clearTimeout(globalTimer);
    logSection('清理环境');

    try {
      if (serverProcess && !serverProcess.killed) {
        await stopServer(serverProcess);
      }
    } catch (e) {
      log(`⚠️  停止服务器时出错: ${e.message}`, 'warn');
    }

    try {
      await cleanupOrphanProcesses();
    } catch (e) {
      log(`⚠️  清理孤儿进程时出错: ${e.message}`, 'warn');
    }

    try {
      if (!options.noCleanup) {
        await cleanupTestDb();
      } else {
        log('⚠️  --no-cleanup 模式，保留测试数据库', 'warn');
      }
    } catch (e) {
      log(`⚠️  清理测试数据库时出错: ${e.message}`, 'warn');
    }
  };

  try {
    logSection('本地回归测试开始');
    log(`测试端口: ${TEST_PORT}`);
    log(`测试数据库: ${TEST_DB_PATH}`);
    log(`总超时: ${TEST_TIMEOUT / 1000 / 60}分钟`);
    if (options.nodeOnly) log('运行模式: 仅 Node.js 测试');
    if (options.pythonOnly) log('运行模式: 仅 Python 测试');
    if (options.noCleanup) log('⚠️  清理模式: 保留测试数据库');
    if (options.selectedFiles.length > 0) log(`测试文件过滤: ${options.selectedFiles.join(', ')}`);

    await checkDependencies();
    ensureDataDir();
    await cleanupOrphanProcesses();
    await cleanupTestDb();

    const prepareTest = async (testFile) => {
      logSection(`准备测试环境: ${testFile}`);

      if (serverProcess && !serverProcess.killed) {
        await stopServer(serverProcess);
        serverProcess = null;
      }

      await cleanupOrphanProcesses();
      await cleanupTestDb();

      await initTestDb();
      await runMigrations();
      await seedTestData();
      await verifyDbInitialized();

      serverProcess = await startTestServer();
    };

    logSection('执行测试');
    const nodeResults = runNode ? await runNodeTests(prepareTest, options.selectedFiles) : [];
    const pythonResults = runPython ? await runPythonTests(prepareTest, options.selectedFiles) : [];

    allPassed = printSummary(nodeResults, pythonResults);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`总耗时: ${duration}秒`, 'debug');

  } catch (error) {
    log(`测试执行出错: ${error.message}`, 'error');
    if (options.verbose || process.env.VERBOSE) {
      console.error(error.stack);
    }
    allPassed = false;
  } finally {
    await cleanup();

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logSection(allPassed ? `所有测试通过 ✅ (${duration}s)` : `测试失败 ❌ (${duration}s)`);
    process.exit(allPassed ? 0 : 1);
  }
};

let cleanupStarted = false;
const forceCleanup = async () => {
  if (cleanupStarted) return;
  cleanupStarted = true;

  try {
    const pids = getProcessIdOnPort(TEST_PORT);
    for (const pid of pids) {
      try {
        log(`终止残留进程 ${pid}...`, 'warn');
        killProcess(pid, 'SIGKILL');
      } catch (e) {}
    }
  } catch (e) {}

  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch (e) {}

  try {
    const filesToClean = [
      TEST_DB_PATH,
      TEST_DB_PATH + '-shm',
      TEST_DB_PATH + '-wal',
      TEST_DB_PATH + '-journal'
    ];
    for (const filePath of filesToClean) {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          log(`已清理: ${path.basename(filePath)}`, 'debug');
        } catch (e) {}
      }
    }
  } catch (e) {}
};

const handleSignal = async (signal) => {
  if (cleanupStarted) return;
  log(`\n收到信号 ${signal}，正在强制清理...`, 'warn');
  await forceCleanup();
  process.exit(1);
};

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('uncaughtException', (err) => {
  log(`未捕获异常: ${err.message}`, 'error');
  console.error(err.stack);
  handleSignal('uncaughtException');
});

main().catch((err) => {
  log(`致命错误: ${err.message}`, 'error');
  console.error(err.stack);
  process.exit(1);
});
