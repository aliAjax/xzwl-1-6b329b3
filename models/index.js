const db = require('../config/database');

const createTables = () => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'staff',
        phone TEXT,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS plots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plot_number TEXT UNIQUE NOT NULL,
        area TEXT NOT NULL,
        row INTEGER NOT NULL,
        col INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT '空闲',
        type TEXT DEFAULT '单穴',
        price REAL DEFAULT 0,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

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
      )`);

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
      )`);

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
      )`);

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
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS deceased (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        gender TEXT,
        birth_date TEXT,
        death_date TEXT,
        plot_id INTEGER,
        relationship TEXT,
        interment_date TEXT,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plot_id) REFERENCES plots(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        id_card TEXT,
        address TEXT,
        relationship TEXT,
        deceased_id INTEGER,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (deceased_id) REFERENCES deceased(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plot_id INTEGER NOT NULL,
        contact_id INTEGER,
        contract_id INTEGER,
        amount REAL NOT NULL,
        payment_date TEXT,
        start_date TEXT,
        due_date TEXT,
        status TEXT DEFAULT '未缴',
        payment_method TEXT,
        fee_category TEXT DEFAULT '管理费',
        remark TEXT,
        bill_type TEXT DEFAULT 'manual',
        bill_year INTEGER,
        bill_batch_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plot_id) REFERENCES plots(id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id),
        FOREIGN KEY (contract_id) REFERENCES contracts(id),
        FOREIGN KEY (bill_batch_id) REFERENCES bill_batches(id)
      )`);

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
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS bill_batch_exceptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        plot_id INTEGER,
        plot_number TEXT,
        error_type TEXT NOT NULL,
        error_message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (batch_id) REFERENCES bill_batches(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS system_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT UNIQUE NOT NULL,
        config_value TEXT,
        description TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER,
        plot_id INTEGER,
        appointment_date TEXT NOT NULL,
        appointment_time TEXT,
        number_of_people INTEGER DEFAULT 1,
        status TEXT DEFAULT '待确认',
        vehicle_number TEXT,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id),
        FOREIGN KEY (plot_id) REFERENCES plots(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS visit_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER,
        user_id INTEGER,
        type TEXT NOT NULL,
        visit_date TEXT NOT NULL,
        content TEXT NOT NULL,
        follow_up_date TEXT,
        status TEXT DEFAULT '待跟进',
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS service_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price REAL NOT NULL DEFAULT 0,
        unit TEXT DEFAULT '次',
        description TEXT,
        status TEXT DEFAULT '上架',
        sort INTEGER DEFAULT 0,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS service_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no TEXT UNIQUE NOT NULL,
        service_item_id INTEGER NOT NULL,
        contact_id INTEGER,
        plot_id INTEGER,
        appointment_id INTEGER,
        contact_name TEXT,
        contact_phone TEXT,
        service_date TEXT,
        service_time TEXT,
        quantity INTEGER DEFAULT 1,
        unit_price REAL DEFAULT 0,
        total_amount REAL DEFAULT 0,
        status TEXT DEFAULT '待处理',
        operator_id INTEGER,
        remark TEXT,
        completed_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (service_item_id) REFERENCES service_items(id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id),
        FOREIGN KEY (plot_id) REFERENCES plots(id),
        FOREIGN KEY (appointment_id) REFERENCES appointments(id),
        FOREIGN KEY (operator_id) REFERENCES users(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        ip_address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS reminder_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_no TEXT UNIQUE NOT NULL,
        reminder_days INTEGER NOT NULL DEFAULT 30,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        total_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        skip_count INTEGER DEFAULT 0,
        exception_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'processing',
        operator_id INTEGER NOT NULL,
        operator_name TEXT NOT NULL,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (operator_id) REFERENCES users(id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS reminder_details (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        payment_id INTEGER NOT NULL,
        plot_id INTEGER NOT NULL,
        plot_number TEXT NOT NULL,
        area TEXT,
        contact_id INTEGER,
        contact_name TEXT,
        contact_phone TEXT,
        deceased_name TEXT,
        due_date TEXT NOT NULL,
        amount REAL NOT NULL,
        days_remaining INTEGER NOT NULL,
        is_overdue INTEGER NOT NULL DEFAULT 0,
        urgency TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        is_exception INTEGER NOT NULL DEFAULT 0,
        exception_type TEXT,
        exception_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (batch_id) REFERENCES reminder_batches(id),
        FOREIGN KEY (payment_id) REFERENCES payments(id),
        FOREIGN KEY (plot_id) REFERENCES plots(id)
      )`);

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
      )`);

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
      )`);

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
      )`);

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
      )`);

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
  });
};

module.exports = { createTables, db };
