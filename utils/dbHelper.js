const db = require('../config/database');

const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const paginateQuery = (baseSql, params = [], page = 1, pageSize = 10, orderBy = 'id DESC') => {
  return new Promise(async (resolve, reject) => {
    try {
      const countSql = `SELECT COUNT(*) as total FROM (${baseSql})`;
      const countResult = await get(countSql, params);
      const total = countResult.total;
      
      const offset = (page - 1) * pageSize;
      const dataSql = `${baseSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
      const data = await all(dataSql, [...params, pageSize, offset]);
      
      resolve({ data, total });
    } catch (err) {
      reject(err);
    }
  });
};

const beginTransaction = () => {
  return new Promise((resolve, reject) => {
    db.run('BEGIN TRANSACTION', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

const commitTransaction = () => {
  return new Promise((resolve, reject) => {
    db.run('COMMIT', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

const rollbackTransaction = () => {
  return new Promise((resolve, reject) => {
    db.run('ROLLBACK', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

let transactionQueue = Promise.resolve();

const runInTransaction = async (operations) => {
  const execute = async () => {
    let started = false;
    try {
      await beginTransaction();
      started = true;
      const results = await operations();
      await commitTransaction();
      started = false;
      return results;
    } catch (err) {
      if (started) {
        try {
          await rollbackTransaction();
        } catch (rollbackErr) {
          err.rollbackError = rollbackErr;
        }
      }
      throw err;
    }
  };

  const result = transactionQueue.then(execute, execute);
  transactionQueue = result.catch(() => {});
  return result;
};

module.exports = { run, get, all, paginateQuery, beginTransaction, commitTransaction, rollbackTransaction, runInTransaction };
