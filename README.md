# 墓园管理后端系统

适合小型墓园管理处使用的后端管理系统，基于 Node.js + Express + SQLite 开发。

## 功能特性

### 核心功能
- **墓位管理**: 墓位编号、状态管理、按区域查询占用情况（网格视图）、批量生成
- **逝者信息**: 逝者基本信息、关联墓位、安葬信息
- **联系人管理**: 家属联系方式、与逝者关系
- **缴费管理**: 缴费记录、到期提醒、逾期费用查询、按年度统计
- **祭扫预约**: 预约登记、状态流转、今日/近期预约查询、人流控制
- **沟通记录**: 客户来访/电话沟通记录、待跟进提醒、沟通统计

### 系统特性
- JWT 身份认证
- 角色权限控制（admin / staff）
- RESTful API 设计
- 统一响应格式
- 参数验证
- SQLite 数据库（无需额外数据库服务器）

## 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 初始化数据库
```bash
npm run init
```

这将创建数据库表和默认账户：
- 管理员: `admin` / `admin123`
- 员工: `staff` / `staff123`

### 3. 导入测试数据（可选）
```bash
npm run seed
```

### 4. 启动服务
```bash
npm start
```

服务将运行在 `http://localhost:3000`

### 开发模式
```bash
npm run dev
```

## 角色说明

| 角色 | 权限 |
|------|------|
| admin | 所有功能，包括用户管理 |
| staff | 业务操作功能，不可管理用户 |

## API 文档

### 通用说明
- 所有接口返回格式: `{ code: 200, message: "...", data: {...} }`
- 需要认证的接口需在请求头携带: `Authorization: Bearer <token>`
- 分页查询参数: `page` (页码), `pageSize` (每页条数)

---

### 1. 认证接口

#### 登录
```
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "admin123"
}
```

---

### 2. 用户管理（仅 admin）

#### 获取当前用户信息
```
GET /api/users/me
Authorization: Bearer <token>
```

#### 用户列表
```
GET /api/users?page=1&pageSize=10&keyword=&role=
```

#### 获取用户详情
```
GET /api/users/:id
```

#### 创建用户
```
POST /api/users
{
  "username": "zhangsan",
  "password": "123456",
  "name": "张三",
  "role": "staff",
  "phone": "13800000000"
}
```

#### 更新用户
```
PUT /api/users/:id
{
  "name": "张三",
  "role": "staff",
  "phone": "13800000000",
  "status": "active",
  "password": "newpassword"
}
```

#### 删除用户
```
DELETE /api/users/:id
```

---

### 3. 墓位管理

#### 墓位列表
```
GET /api/plots?page=1&pageSize=10&area=&status=&keyword=
```

#### 获取所有区域
```
GET /api/plots/areas
```

#### 查询区域占用情况
```
GET /api/plots/area/:area/occupancy
```
返回网格视图和统计信息，可直观查看区域内墓位占用情况

#### 统计信息
```
GET /api/plots/statistics
```
返回整体和各区域的墓位统计

#### 墓位详情
```
GET /api/plots/:id
```
包含关联的逝者、联系人、缴费记录、预约记录

#### 创建墓位
```
POST /api/plots
{
  "plot_number": "A-1排1号",
  "area": "A区",
  "row": 1,
  "col": 1,
  "status": "空闲",
  "type": "单穴",
  "price": 5000,
  "remark": ""
}
```

#### 批量生成墓位
```
POST /api/plots/batch
{
  "area": "D区",
  "startRow": 1,
  "endRow": 5,
  "startCol": 1,
  "endCol": 10,
  "type": "单穴",
  "price": 5000
}
```

#### 更新墓位
```
PUT /api/plots/:id
```

#### 删除墓位
```
DELETE /api/plots/:id
```

---

### 4. 逝者信息

#### 逝者列表
```
GET /api/deceased?page=1&pageSize=10&keyword=&plot_id=
```

#### 逝者详情
```
GET /api/deceased/:id
```

#### 创建逝者信息
```
POST /api/deceased
{
  "name": "张三",
  "gender": "男",
  "birth_date": "1940-01-01",
  "death_date": "2020-01-01",
  "plot_id": 1,
  "relationship": "父亲",
  "interment_date": "2020-02-01",
  "remark": ""
}
```
*关联墓位后自动更新墓位状态为"已占用"*

#### 更新逝者信息
```
PUT /api/deceased/:id
```

#### 删除逝者信息
```
DELETE /api/deceased/:id
```

---

### 5. 联系人管理

#### 联系人列表
```
GET /api/contacts?page=1&pageSize=10&keyword=&deceased_id=
```

#### 联系人详情
```
GET /api/contacts/:id
```
包含关联的来访记录数和预约记录数

#### 创建联系人
```
POST /api/contacts
{
  "name": "张小华",
  "phone": "13812345678",
  "id_card": "110101197001011234",
  "address": "北京市朝阳区XX小区",
  "relationship": "儿子",
  "deceased_id": 1,
  "remark": ""
}
```

#### 更新联系人
```
PUT /api/contacts/:id
```

#### 删除联系人
```
DELETE /api/contacts/:id
```

---

### 6. 缴费管理

#### 缴费记录列表
```
GET /api/payments?page=1&pageSize=10&plot_id=&status=&keyword=
```

#### 到期提醒
```
GET /api/payments/reminders?days=30&page=1&pageSize=20
```
查询指定天数内即将到期和已逾期的缴费记录

#### 逾期费用
```
GET /api/payments/overdue?page=1&pageSize=20
```

#### 缴费统计
```
GET /api/payments/statistics?year=2024
```
按年度统计缴费情况，包含月度明细

#### 缴费详情
```
GET /api/payments/:id
```

#### 创建缴费记录
```
POST /api/payments
{
  "plot_id": 1,
  "contact_id": 1,
  "amount": 200,
  "payment_date": "2024-01-01",
  "start_date": "2024-01-01",
  "due_date": "2025-01-01",
  "status": "未缴",
  "payment_method": "现金",
  "remark": ""
}
```

#### 执行缴费
```
POST /api/payments/:id/pay
{
  "payment_date": "2024-01-01",
  "payment_method": "微信",
  "amount": 200,
  "remark": ""
}
```

#### 更新缴费记录
```
PUT /api/payments/:id
```

#### 删除缴费记录
```
DELETE /api/payments/:id
```

---

### 7. 祭扫预约

#### 预约列表
```
GET /api/appointments?page=1&pageSize=10&status=&date=&keyword=
```

#### 近期预约
```
GET /api/appointments/upcoming?days=7&page=1&pageSize=20
```
按日期分组显示

#### 今日预约
```
GET /api/appointments/today
```
包含当日预约统计

#### 预约详情
```
GET /api/appointments/:id
```

#### 创建预约
```
POST /api/appointments
{
  "contact_id": 1,
  "plot_id": 1,
  "appointment_date": "2024-04-05",
  "appointment_time": "09:00",
  "number_of_people": 3,
  "vehicle_number": "京A12345",
  "remark": ""
}
```
*每日预约上限50个*

#### 确认预约
```
POST /api/appointments/:id/confirm
```

#### 标记完成
```
POST /api/appointments/:id/complete
```

#### 取消预约
```
POST /api/appointments/:id/cancel
{
  "reason": "客户临时有事"
}
```

#### 更新预约
```
PUT /api/appointments/:id
```

#### 删除预约
```
DELETE /api/appointments/:id
```

---

### 8. 沟通记录

#### 记录列表
```
GET /api/visit-records?page=1&pageSize=10&type=&status=&contact_id=&user_id=&keyword=&start_date=&end_date=
```

#### 待跟进提醒
```
GET /api/visit-records/followup?days=7&page=1&pageSize=20
```
包含已逾期和即将到期的待跟进记录

#### 我的记录
```
GET /api/visit-records/my?page=1&pageSize=10&status=
```

#### 沟通统计
```
GET /api/visit-records/statistics?start_date=&end_date=
```
按人员和日期统计沟通情况

#### 记录详情
```
GET /api/visit-records/:id
```
包含该联系人的历史沟通记录

#### 创建记录
```
POST /api/visit-records
{
  "contact_id": 1,
  "type": "来访",
  "visit_date": "2024-01-01",
  "content": "客户前来咨询续费事宜...",
  "follow_up_date": "2024-01-05",
  "status": "待跟进",
  "remark": ""
}
```
*type: 来访 / 电话*
*status: 待跟进 / 已完成*

#### 标记跟进完成
```
POST /api/visit-records/:id/complete
{
  "follow_up_remark": "已完成缴费"
}
```

#### 更新记录
```
PUT /api/visit-records/:id
```

#### 删除记录
```
DELETE /api/visit-records/:id
```

---

## 数据库结构

### 核心表
- `users` - 用户表
- `plots` - 墓位表
- `deceased` - 逝者表
- `contacts` - 联系人表
- `payments` - 缴费记录表
- `appointments` - 预约表
- `visit_records` - 沟通记录表

## 项目结构

```
xzwl-1/
├── app.js                 # 主应用入口
├── package.json           # 项目配置
├── .env                   # 环境变量
├── data/                  # 数据库文件目录
├── config/
│   └── database.js        # 数据库配置
├── middleware/
│   ├── auth.js           # 认证中间件
│   └── validator.js      # 参数验证
├── models/
│   └── index.js          # 数据库模型
├── routes/
│   ├── auth.js           # 认证接口
│   ├── users.js          # 用户管理
│   ├── plots.js          # 墓位管理
│   ├── deceased.js       # 逝者管理
│   ├── contacts.js       # 联系人管理
│   ├── payments.js       # 缴费管理
│   ├── appointments.js   # 预约管理
│   └── visitRecords.js   # 沟通记录
├── scripts/
│   ├── init-db.js        # 数据库初始化
│   └── seed-data.js      # 测试数据导入
└── utils/
    ├── dbHelper.js       # 数据库操作工具
    └── response.js       # 响应格式工具
```

## 技术栈

- **Node.js** - 运行环境
- **Express.js** - Web 框架
- **SQLite3** - 数据库
- **JWT** - 身份认证
- **bcryptjs** - 密码加密
- **express-validator** - 参数验证
- **moment.js** - 日期处理
- **cors** - 跨域支持

## 注意事项

1. 首次使用请先运行 `npm run init` 初始化数据库
2. 默认账户密码请及时修改
3. 数据库文件位于 `data/cemetery.db`，请定期备份
4. 生产环境请修改 `.env` 中的 `JWT_SECRET`
