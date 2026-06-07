const moment = require('moment');
const { db } = require('../models');
const { run, get } = require('../utils/dbHelper');

const migrate = async () => {
  try {
    console.log('开始数据库迁移...');

    const checkColumn = (tableName, columnName) => {
      return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
          if (err) reject(err);
          const exists = columns.some(col => col.name === columnName);
          resolve(exists);
        });
      });
    };

    const hasBillType = await checkColumn('payments', 'bill_type');
    const hasBillYear = await checkColumn('payments', 'bill_year');
    const hasBillBatchId = await checkColumn('payments', 'bill_batch_id');

    if (!hasBillType) {
      await new Promise((resolve, reject) => {
        db.run(`ALTER TABLE payments ADD COLUMN bill_type TEXT DEFAULT 'manual'`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log('已添加 payments.bill_type 字段');
    } else {
      console.log('payments.bill_type 字段已存在，跳过');
    }

    if (!hasBillYear) {
      await new Promise((resolve, reject) => {
        db.run(`ALTER TABLE payments ADD COLUMN bill_year INTEGER`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log('已添加 payments.bill_year 字段');
    } else {
      console.log('payments.bill_year 字段已存在，跳过');
    }

    if (!hasBillBatchId) {
      await new Promise((resolve, reject) => {
        db.run(`ALTER TABLE payments ADD COLUMN bill_batch_id INTEGER`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log('已添加 payments.bill_batch_id 字段');
    } else {
      console.log('payments.bill_batch_id 字段已存在，跳过');
    }

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS bill_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_no TEXT UNIQUE NOT NULL,
        bill_year INTEGER NOT NULL,
        fee_standard REAL NOT NULL,
        total_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        skip_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'processing',
        operator_id INTEGER NOT NULL,
        operator_name TEXT NOT NULL,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (operator_id) REFERENCES users(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log('bill_batches 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS bill_batch_exceptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        plot_id INTEGER,
        plot_number TEXT,
        error_type TEXT NOT NULL,
        error_message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (batch_id) REFERENCES bill_batches(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log('bill_batch_exceptions 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS system_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT UNIQUE NOT NULL,
        config_value TEXT,
        description TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log('system_config 表已就绪');

    const feeConfig = await get('SELECT config_key FROM system_config WHERE config_key = ?', ['default_annual_fee']);
    if (!feeConfig) {
      await run(
        'INSERT INTO system_config (config_key, config_value, description) VALUES (?, ?, ?)',
        ['default_annual_fee', '200', '默认年度管理费标准（元/年）']
      );
      console.log('已初始化默认年度管理费标准：200元/年');
    } else {
      console.log('默认年度管理费配置已存在，跳过');
    }

    const nullBillTypeCount = await get('SELECT COUNT(*) as count FROM payments WHERE bill_type IS NULL');
    if (nullBillTypeCount.count > 0) {
      await run("UPDATE payments SET bill_type = 'manual' WHERE bill_type IS NULL");
      console.log(`已更新 ${nullBillTypeCount.count} 条历史缴费记录的 bill_type 为 manual`);
    }

    console.log('');
    console.log('数据库迁移完成！');
    process.exit(0);
  } catch (err) {
    console.error('迁移失败:', err);
    process.exit(1);
  }
};

migrate();
