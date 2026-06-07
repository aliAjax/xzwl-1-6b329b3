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
        amount REAL NOT NULL,
        payment_date TEXT,
        start_date TEXT,
        due_date TEXT,
        status TEXT DEFAULT '未缴',
        payment_method TEXT,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plot_id) REFERENCES plots(id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
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
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
};

module.exports = { createTables, db };
