const bcrypt = require('bcryptjs');
const { createTables } = require('../models');
const { run, get } = require('../utils/dbHelper');

const init = async () => {
  try {
    console.log('开始初始化数据库...');
    
    await createTables();
    console.log('数据库表创建完成');
    
    const adminExists = await get('SELECT id FROM users WHERE username = ?', ['admin']);
    if (!adminExists) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      await run(
        'INSERT INTO users (username, password, name, role, phone) VALUES (?, ?, ?, ?, ?)',
        ['admin', hashedPassword, '系统管理员', 'admin', '13800138000']
      );
      console.log('默认管理员账户已创建: admin / admin123');
    } else {
      console.log('管理员账户已存在，跳过创建');
    }
    
    const staffExists = await get('SELECT id FROM users WHERE username = ?', ['staff']);
    if (!staffExists) {
      const hashedPassword = bcrypt.hashSync('staff123', 10);
      await run(
        'INSERT INTO users (username, password, name, role, phone) VALUES (?, ?, ?, ?, ?)',
        ['staff', hashedPassword, '普通员工', 'staff', '13900139000']
      );
      console.log('默认员工账户已创建: staff / staff123');
    } else {
      console.log('员工账户已存在，跳过创建');
    }
    
    console.log('数据库初始化完成！');
    console.log('');
    console.log('默认账户:');
    console.log('  管理员: admin / admin123');
    console.log('  员工:   staff / staff123');
    console.log('');
    console.log('下一步: 运行 npm run seed 导入测试数据');
    
    process.exit(0);
  } catch (err) {
    console.error('初始化失败:', err);
    process.exit(1);
  }
};

init();
