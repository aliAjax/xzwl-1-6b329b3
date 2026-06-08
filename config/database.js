const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const envPath = process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env');
if (require('fs').existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || './data/cemetery.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('数据库连接成功:', dbPath);
  }
});

db.run('PRAGMA foreign_keys = ON');

module.exports = db;
