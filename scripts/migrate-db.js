const moment = require('moment');
const { db } = require('../models');
const { run, get, all } = require('../utils/dbHelper');

const migrateDatabase = async ({ exitOnComplete = false, log = console.log } = {}) => {
  try {
    log('开始数据库迁移...');

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
      log('已添加 payments.bill_type 字段');
    } else {
      log('payments.bill_type 字段已存在，跳过');
    }

    if (!hasBillYear) {
      await new Promise((resolve, reject) => {
        db.run(`ALTER TABLE payments ADD COLUMN bill_year INTEGER`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      log('已添加 payments.bill_year 字段');
    } else {
      log('payments.bill_year 字段已存在，跳过');
    }

    if (!hasBillBatchId) {
      await new Promise((resolve, reject) => {
        db.run(`ALTER TABLE payments ADD COLUMN bill_batch_id INTEGER`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      log('已添加 payments.bill_batch_id 字段');
    } else {
      log('payments.bill_batch_id 字段已存在，跳过');
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
    log('bill_batches 表已就绪');

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
    log('bill_batch_exceptions 表已就绪');

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
    log('system_config 表已就绪');

    const feeConfig = await get('SELECT config_key FROM system_config WHERE config_key = ?', ['default_annual_fee']);
    if (!feeConfig) {
      await run(
        'INSERT INTO system_config (config_key, config_value, description) VALUES (?, ?, ?)',
        ['default_annual_fee', '200', '默认年度管理费标准（元/年）']
      );
      log('已初始化默认年度管理费标准：200元/年');
    } else {
      log('默认年度管理费配置已存在，跳过');
    }

    const nullBillTypeCount = await get('SELECT COUNT(*) as count FROM payments WHERE bill_type IS NULL');
    if (nullBillTypeCount.count > 0) {
      await run("UPDATE payments SET bill_type = 'manual' WHERE bill_type IS NULL");
      log(`已更新 ${nullBillTypeCount.count} 条历史缴费记录的 bill_type 为 manual`);
    }

    const nullBillYearRecords = await all(`
      SELECT id, start_date, due_date FROM payments 
      WHERE bill_year IS NULL AND (start_date IS NOT NULL OR due_date IS NOT NULL)
    `);
    
    if (nullBillYearRecords.length > 0) {
      let updatedCount = 0;
      for (const record of nullBillYearRecords) {
        let billYear = null;
        if (record.start_date) {
          billYear = moment(record.start_date).year();
        } else if (record.due_date) {
          billYear = moment(record.due_date).year();
        }
        
        if (billYear) {
          await run('UPDATE payments SET bill_year = ? WHERE id = ?', [billYear, record.id]);
          updatedCount++;
        }
      }
      log(`已为 ${updatedCount} 条历史缴费记录补充 bill_year（根据 start_date/due_date 推断）`);
    }

    const stillNullBillYearCount = await get('SELECT COUNT(*) as count FROM payments WHERE bill_year IS NULL');
    if (stillNullBillYearCount.count > 0) {
      log(`注意：仍有 ${stillNullBillYearCount.count} 条记录 bill_year 为空（无 start_date 和 due_date），需手工处理`);
    }

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS maintenance_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plot_id INTEGER NOT NULL,
        plot_number TEXT NOT NULL,
        reason TEXT NOT NULL,
        plan_date TEXT,
        handler_id INTEGER,
        handler_name TEXT,
        process TEXT,
        result TEXT,
        status TEXT NOT NULL DEFAULT '待处理',
        created_by INTEGER NOT NULL,
        created_by_name TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plot_id) REFERENCES plots(id),
        FOREIGN KEY (handler_id) REFERENCES users(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('maintenance_orders 表已就绪');

    const maintenanceOrderColumns = await new Promise((resolve, reject) => {
      db.all(`PRAGMA table_info(maintenance_orders)`, (err, columns) => {
        if (err) reject(err);
        else resolve(columns.map(c => c.name));
      });
    });
    log(`maintenance_orders 表字段: ${maintenanceOrderColumns.join(', ')}`);

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS festival_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        festival_name TEXT NOT NULL,
        festival_type TEXT NOT NULL DEFAULT 'custom',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_by INTEGER NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('festival_schedules 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS festival_time_slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        festival_schedule_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 50,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (festival_schedule_id) REFERENCES festival_schedules(id),
        UNIQUE(festival_schedule_id, date, start_time, end_time)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('festival_time_slots 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS festival_staff_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time_slot_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        duty TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (time_slot_id) REFERENCES festival_time_slots(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(time_slot_id, user_id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('festival_staff_schedules 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS festival_appointment_slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appointment_id INTEGER NOT NULL,
        time_slot_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (appointment_id) REFERENCES appointments(id),
        FOREIGN KEY (time_slot_id) REFERENCES festival_time_slots(id),
        UNIQUE(appointment_id, time_slot_id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('festival_appointment_slots 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_no TEXT UNIQUE NOT NULL,
        plot_id INTEGER NOT NULL,
        contact_id INTEGER,
        deceased_id INTEGER,
        status TEXT NOT NULL DEFAULT 'draft',
        plot_price REAL DEFAULT 0,
        management_fee REAL DEFAULT 0,
        management_fee_years INTEGER DEFAULT 0,
        total_amount REAL DEFAULT 0,
        paid_amount REAL DEFAULT 0,
        reserved_at TEXT,
        reserved_expires_at TEXT,
        signed_at TEXT,
        effective_at TEXT,
        voided_at TEXT,
        void_reason TEXT,
        remark TEXT,
        created_by INTEGER,
        created_by_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plot_id) REFERENCES plots(id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id),
        FOREIGN KEY (deceased_id) REFERENCES deceased(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('contracts 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS contract_fee_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id INTEGER NOT NULL,
        fee_type TEXT NOT NULL,
        fee_category TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        quantity INTEGER DEFAULT 1,
        unit_price REAL DEFAULT 0,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contract_id) REFERENCES contracts(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('contract_fee_items 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS plot_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plot_id INTEGER NOT NULL,
        contract_id INTEGER NOT NULL,
        contact_name TEXT,
        contact_phone TEXT,
        reserved_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plot_id) REFERENCES plots(id),
        FOREIGN KEY (contract_id) REFERENCES contracts(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('plot_reservations 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS contract_status_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id INTEGER NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        operator_id INTEGER,
        operator_name TEXT,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contract_id) REFERENCES contracts(id),
        FOREIGN KEY (operator_id) REFERENCES users(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('contract_status_logs 表已就绪');

    const hasContractId = await checkColumn('payments', 'contract_id');
    if (!hasContractId) {
      await new Promise((resolve, reject) => {
        db.run(`ALTER TABLE payments ADD COLUMN contract_id INTEGER`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      log('已添加 payments.contract_id 字段');
    } else {
      log('payments.contract_id 字段已存在，跳过');
    }

    const hasFeeCategory = await checkColumn('payments', 'fee_category');
    if (!hasFeeCategory) {
      await new Promise((resolve, reject) => {
        db.run(`ALTER TABLE payments ADD COLUMN fee_category TEXT DEFAULT '管理费'`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      log('已添加 payments.fee_category 字段');
    } else {
      log('payments.fee_category 字段已存在，跳过');
    }

    const nullFeeCategoryCount = await get('SELECT COUNT(*) as count FROM payments WHERE fee_category IS NULL');
    if (nullFeeCategoryCount.count > 0) {
      await run("UPDATE payments SET fee_category = '管理费' WHERE fee_category IS NULL");
      log(`已更新 ${nullFeeCategoryCount.count} 条历史缴费记录的 fee_category 为 管理费`);
    }

    const existingDeceasedWithPlot = await all(`
      SELECT d.id as deceased_id, d.plot_id, d.created_at as deceased_created_at,
             p.price as plot_price, p.plot_number,
             c.id as contact_id, c.name as contact_name
      FROM deceased d
      INNER JOIN plots p ON d.plot_id = p.id
      LEFT JOIN contacts c ON d.id = c.deceased_id
      WHERE d.plot_id IS NOT NULL
        AND d.id NOT IN (SELECT deceased_id FROM contracts WHERE deceased_id IS NOT NULL AND status != 'voided')
    `);

    if (existingDeceasedWithPlot.length > 0) {
      log(`发现 ${existingDeceasedWithPlot.length} 条历史逝者占用墓位数据，正在创建兼容合同...`);
      
      let createdCount = 0;
      let linkedPaymentCount = 0;
      for (const item of existingDeceasedWithPlot) {
        try {
          const existingContract = await get(`
            SELECT id FROM contracts 
            WHERE plot_id = ? AND deceased_id = ? AND status = 'effective'
          `, [item.plot_id, item.deceased_id]);
          
          if (existingContract) {
            continue;
          }
          
          const contractNo = `HTLS${moment(item.deceased_created_at || moment()).format('YYYYMMDD')}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
          const plotPrice = item.plot_price || 0;
          
          const existingPayments = await all(`
            SELECT id, amount, fee_category, status, payment_date
            FROM payments 
            WHERE plot_id = ? 
              AND contract_id IS NULL
              AND status = '已缴'
            ORDER BY payment_date ASC
          `, [item.plot_id]);
          
          let totalPaid = 0;
          let plotPayment = 0;
          let feePayment = 0;
          
          for (const payment of existingPayments) {
            const category = payment.fee_category || '管理费';
            if (category === '购墓款') {
              plotPayment += payment.amount;
            } else {
              feePayment += payment.amount;
            }
            totalPaid += payment.amount;
          }
          
          const finalPlotPrice = Math.max(plotPrice, plotPayment);
          const totalAmount = finalPlotPrice + feePayment;
          
          const contractResult = await run(`
            INSERT INTO contracts (
              contract_no, plot_id, contact_id, deceased_id, status,
              plot_price, management_fee, management_fee_years, total_amount, paid_amount,
              signed_at, effective_at,
              remark, created_by, created_by_name,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'effective', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            contractNo, item.plot_id, item.contact_id, item.deceased_id,
            finalPlotPrice, feePayment, feePayment > 0 ? Math.ceil(feePayment / 100) : 0, totalAmount, totalPaid,
            item.deceased_created_at, item.deceased_created_at,
            '历史数据兼容-自动生成合同', 1, '系统',
            item.deceased_created_at, item.deceased_created_at
          ]);
          
          if (finalPlotPrice > 0) {
            await run(`
              INSERT INTO contract_fee_items (contract_id, fee_type, fee_category, amount, description)
              VALUES (?, '墓位款', '购墓款', ?, '历史墓位购买费用')
            `, [contractResult.id, finalPlotPrice]);
          }
          
          if (feePayment > 0) {
            await run(`
              INSERT INTO contract_fee_items (contract_id, fee_type, fee_category, amount, quantity, unit_price, description)
              VALUES (?, '管理费', '管理费', ?, ?, ?, '历史管理费')
            `, [contractResult.id, feePayment, feePayment > 0 ? Math.ceil(feePayment / 100) : 1, feePayment > 0 ? 100 : 0]);
          }
          
          for (const payment of existingPayments) {
            await run('UPDATE payments SET contract_id = ? WHERE id = ?', [contractResult.id, payment.id]);
            linkedPaymentCount++;
          }
          
          await run(`
            INSERT INTO contract_status_logs (contract_id, from_status, to_status, operator_id, operator_name, remark, created_at)
            VALUES (?, 'draft', 'effective', ?, '系统', ?, ?)
          `, [contractResult.id, 1, `历史数据兼容-直接生效，已关联${existingPayments.length}条历史付款记录`, item.deceased_created_at]);
          
          createdCount++;
        } catch (e) {
          log(`创建兼容合同时出错（逝者ID: ${item.deceased_id}）:`, e.message);
        }
      }
      
      log(`已为 ${createdCount} 条历史数据创建兼容合同，关联 ${linkedPaymentCount} 条历史付款记录`);
    } else {
      log('无需要处理的历史逝者占用墓位数据');
    }
    
    const unlinkedEffectiveContracts = await all(`
      SELECT c.id, c.plot_id, c.paid_amount, c.total_amount
      FROM contracts c
      WHERE c.status = 'effective'
        AND c.paid_amount = 0
        AND c.id NOT IN (SELECT DISTINCT contract_id FROM payments WHERE contract_id IS NOT NULL)
    `);
    
    if (unlinkedEffectiveContracts.length > 0) {
      log(`发现 ${unlinkedEffectiveContracts.length} 个已生效合同没有关联付款记录，正在检查历史付款...`);
      
      let updatedCount = 0;
      for (const contract of unlinkedEffectiveContracts) {
        try {
          const existingPayments = await all(`
            SELECT id, amount, fee_category, status
            FROM payments 
            WHERE plot_id = ? 
              AND contract_id IS NULL
              AND status = '已缴'
            ORDER BY payment_date ASC
          `, [contract.plot_id]);
          
          if (existingPayments.length > 0) {
            let totalPaid = 0;
            for (const payment of existingPayments) {
              await run('UPDATE payments SET contract_id = ? WHERE id = ?', [contract.id, payment.id]);
              totalPaid += payment.amount;
            }
            
            if (totalPaid > 0) {
              await run(`
                UPDATE contracts SET 
                  paid_amount = ?,
                  updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `, [totalPaid, contract.id]);
            }
            
            updatedCount++;
          }
        } catch (e) {
          log(`关联付款记录时出错（合同ID: ${contract.id}）:`, e.message);
        }
      }
      
      log(`已为 ${updatedCount} 个合同关联历史付款记录`);
    }

    const existingPaymentsWithoutCategory = await get('SELECT COUNT(*) as count FROM payments WHERE fee_category IS NULL OR fee_category = ?', ['管理费']);
    log(`当前缴费记录中，管理费类型: ${existingPaymentsWithoutCategory.count} 条`);

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS audit_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_type TEXT NOT NULL,
        resource_id INTEGER NOT NULL,
        snapshot_data TEXT NOT NULL,
        operation_log_id INTEGER,
        created_by INTEGER NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (operation_log_id) REFERENCES operation_logs(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('audit_snapshots 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS audit_field_diffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (snapshot_id) REFERENCES audit_snapshots(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('audit_field_diffs 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS rollback_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL,
        field_diff_ids TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_by INTEGER NOT NULL,
        requested_by_name TEXT NOT NULL,
        reviewed_by INTEGER,
        reviewed_by_name TEXT,
        reviewed_at DATETIME,
        review_remark TEXT,
        rollback_executed_at DATETIME,
        rollback_result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (snapshot_id) REFERENCES audit_snapshots(id),
        FOREIGN KEY (requested_by) REFERENCES users(id),
        FOREIGN KEY (reviewed_by) REFERENCES users(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('rollback_requests 表已就绪');

    await new Promise((resolve, reject) => {
      db.run(`CREATE TABLE IF NOT EXISTS rollback_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rollback_request_id INTEGER NOT NULL,
        approval_action TEXT NOT NULL,
        approval_remark TEXT,
        approved_by INTEGER NOT NULL,
        approved_by_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (rollback_request_id) REFERENCES rollback_requests(id),
        FOREIGN KEY (approved_by) REFERENCES users(id)
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    log('rollback_approvals 表已就绪');

    log('');
    log('数据库迁移完成！');
    if (exitOnComplete) {
      process.exit(0);
    }
  } catch (err) {
    console.error('迁移失败:', err);
    if (exitOnComplete) {
      process.exit(1);
    }
    throw err;
  }
};

if (require.main === module) {
  migrateDatabase({ exitOnComplete: true });
}

module.exports = { migrateDatabase };
