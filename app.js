const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { createTables } = require('./models');
const { migrateDatabase } = require('./scripts/migrate-db');
const { error } = require('./utils/response');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const plotRoutes = require('./routes/plots');
const deceasedRoutes = require('./routes/deceased');
const contactRoutes = require('./routes/contacts');
const paymentRoutes = require('./routes/payments');
const billGenerationRoutes = require('./routes/billGeneration');
const reminderTaskRoutes = require('./routes/reminderTasks');
const appointmentRoutes = require('./routes/appointments');
const visitRecordRoutes = require('./routes/visitRecords');
const dashboardRoutes = require('./routes/dashboard');
const serviceItemRoutes = require('./routes/serviceItems');
const serviceOrderRoutes = require('./routes/serviceOrders');
const importRoutes = require('./routes/imports');
const operationLogRoutes = require('./routes/operationLogs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/plots', plotRoutes);
app.use('/api/deceased', deceasedRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/bills', billGenerationRoutes);
app.use('/api/reminders', reminderTaskRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/visit-records', visitRecordRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/service-items', serviceItemRoutes);
app.use('/api/service-orders', serviceOrderRoutes);
app.use('/api/import', importRoutes);
app.use('/api/operation-logs', operationLogRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    code: 200,
    message: '服务运行正常',
    data: {
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    }
  });
});

app.use((req, res) => {
  error(res, '接口不存在', 404);
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  error(res, '服务器内部错误', 500);
});

const startServer = async () => {
  try {
    await createTables();
    console.log('数据库表初始化完成');
    await migrateDatabase();
    
    app.listen(PORT, () => {
      console.log(`服务器运行在 http://localhost:${PORT}`);
      console.log(`API文档: 请参考 README.md 文件`);
    });
  } catch (err) {
    console.error('启动服务器失败:', err);
    process.exit(1);
  }
};

startServer();

module.exports = app;
