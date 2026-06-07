const bcrypt = require('bcryptjs');
const moment = require('moment');
const { run, get } = require('../utils/dbHelper');

const seed = async () => {
  try {
    console.log('开始导入测试数据...');
    
    const areas = ['A区', 'B区', 'C区'];
    for (const area of areas) {
      for (let row = 1; row <= 5; row++) {
        for (let col = 1; col <= 10; col++) {
          const plotNumber = `${area}-${row}排${col}号`;
          const existing = await get('SELECT id FROM plots WHERE plot_number = ?', [plotNumber]);
          if (!existing) {
            await run(
              'INSERT INTO plots (plot_number, area, row, col, status, type, price) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [plotNumber, area, row, col, '空闲', '单穴', 5000]
            );
          }
        }
      }
    }
    console.log('墓位数据导入完成');
    
    const deceasedData = [
      { name: '张三', gender: '男', birth_date: '1940-01-15', death_date: '2020-03-20', plot_id: 1, interment_date: '2020-04-01', relationship: '父亲' },
      { name: '李四', gender: '女', birth_date: '1945-05-20', death_date: '2021-06-10', plot_id: 2, interment_date: '2021-07-01', relationship: '母亲' },
      { name: '王五', gender: '男', birth_date: '1938-11-08', death_date: '2019-12-25', plot_id: 6, interment_date: '2020-01-15', relationship: '祖父' },
      { name: '赵六', gender: '女', birth_date: '1950-08-12', death_date: '2022-02-14', plot_id: 11, interment_date: '2022-03-01', relationship: '祖母' },
      { name: '钱七', gender: '男', birth_date: '1942-03-25', death_date: '2023-01-05', plot_id: 16, interment_date: '2023-02-01', relationship: '岳父' }
    ];
    
    for (const d of deceasedData) {
      const existing = await get('SELECT id FROM deceased WHERE name = ? AND plot_id = ?', [d.name, d.plot_id]);
      if (!existing) {
        await run(
          'INSERT INTO deceased (name, gender, birth_date, death_date, plot_id, relationship, interment_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [d.name, d.gender, d.birth_date, d.death_date, d.plot_id, d.relationship, d.interment_date]
        );
        await run('UPDATE plots SET status = "已占用" WHERE id = ?', [d.plot_id]);
      }
    }
    console.log('逝者数据导入完成');
    
    const contactData = [
      { name: '张小华', phone: '13812345678', id_card: '110101197001011234', address: '北京市朝阳区XX小区', relationship: '儿子', deceased_id: 1 },
      { name: '李小华', phone: '13987654321', id_card: '110101197505055678', address: '北京市海淀区XX小区', relationship: '女儿', deceased_id: 2 },
      { name: '王小明', phone: '13611112222', id_card: '110101198010109012', address: '北京市西城区XX小区', relationship: '孙子', deceased_id: 3 },
      { name: '赵小明', phone: '13733334444', id_card: '110101198508083456', address: '北京市东城区XX小区', relationship: '孙女', deceased_id: 4 },
      { name: '钱小明', phone: '13555556666', id_card: '110101199003037890', address: '北京市丰台区XX小区', relationship: '女婿', deceased_id: 5 }
    ];
    
    for (const c of contactData) {
      const existing = await get('SELECT id FROM contacts WHERE phone = ?', [c.phone]);
      if (!existing) {
        await run(
          'INSERT INTO contacts (name, phone, id_card, address, relationship, deceased_id) VALUES (?, ?, ?, ?, ?, ?)',
          [c.name, c.phone, c.id_card, c.address, c.relationship, c.deceased_id]
        );
      }
    }
    console.log('联系人数据导入完成');
    
    const paymentData = [
      { plot_id: 1, contact_id: 1, amount: 200, payment_date: moment().subtract(1, 'year').format('YYYY-MM-DD'), start_date: moment().subtract(1, 'year').format('YYYY-MM-DD'), due_date: moment().add(11, 'months').format('YYYY-MM-DD'), status: '已缴', payment_method: '现金' },
      { plot_id: 2, contact_id: 2, amount: 200, payment_date: moment().subtract(6, 'months').format('YYYY-MM-DD'), start_date: moment().subtract(6, 'months').format('YYYY-MM-DD'), due_date: moment().add(6, 'months').format('YYYY-MM-DD'), status: '已缴', payment_method: '微信' },
      { plot_id: 6, contact_id: 3, amount: 200, payment_date: moment().subtract(1, 'month').format('YYYY-MM-DD'), start_date: moment().subtract(1, 'month').format('YYYY-MM-DD'), due_date: moment().add(11, 'months').format('YYYY-MM-DD'), status: '已缴', payment_method: '支付宝' },
      { plot_id: 11, contact_id: 4, amount: 200, payment_date: null, start_date: moment().format('YYYY-MM-DD'), due_date: moment().add(15, 'days').format('YYYY-MM-DD'), status: '未缴', payment_method: null },
      { plot_id: 16, contact_id: 5, amount: 200, payment_date: null, start_date: moment().subtract(2, 'months').format('YYYY-MM-DD'), due_date: moment().subtract(5, 'days').format('YYYY-MM-DD'), status: '未缴', payment_method: null }
    ];
    
    for (const p of paymentData) {
      await run(
        'INSERT INTO payments (plot_id, contact_id, amount, payment_date, start_date, due_date, status, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [p.plot_id, p.contact_id, p.amount, p.payment_date, p.start_date, p.due_date, p.status, p.payment_method]
      );
    }
    console.log('缴费数据导入完成');
    
    const appointmentData = [
      { contact_id: 1, plot_id: 1, appointment_date: moment().add(3, 'days').format('YYYY-MM-DD'), appointment_time: '09:00', number_of_people: 3, status: '已确认', vehicle_number: '京A12345' },
      { contact_id: 2, plot_id: 2, appointment_date: moment().add(5, 'days').format('YYYY-MM-DD'), appointment_time: '10:30', number_of_people: 2, status: '待确认', vehicle_number: null },
      { contact_id: 3, plot_id: 6, appointment_date: moment().format('YYYY-MM-DD'), appointment_time: '14:00', number_of_people: 4, status: '已确认', vehicle_number: '京B67890' },
      { contact_id: 1, plot_id: 1, appointment_date: moment().subtract(1, 'days').format('YYYY-MM-DD'), appointment_time: '09:00', number_of_people: 2, status: '已完成', vehicle_number: null }
    ];
    
    for (const a of appointmentData) {
      await run(
        'INSERT INTO appointments (contact_id, plot_id, appointment_date, appointment_time, number_of_people, status, vehicle_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [a.contact_id, a.plot_id, a.appointment_date, a.appointment_time, a.number_of_people, a.status, a.vehicle_number]
      );
    }
    console.log('预约数据导入完成');
    
    const visitRecordData = [
      { contact_id: 1, user_id: 2, type: '来访', visit_date: moment().subtract(3, 'days').format('YYYY-MM-DD'), content: '客户前来咨询续费事宜，已详细说明费用标准和缴费流程', follow_up_date: moment().add(2, 'days').format('YYYY-MM-DD'), status: '待跟进' },
      { contact_id: 2, user_id: 2, type: '电话', visit_date: moment().subtract(2, 'days').format('YYYY-MM-DD'), content: '电话提醒管理费即将到期，客户表示近期会来缴费', follow_up_date: null, status: '已完成' },
      { contact_id: 3, user_id: 1, type: '电话', visit_date: moment().subtract(1, 'day').format('YYYY-MM-DD'), content: '电话确认祭扫预约信息，已告知注意事项', follow_up_date: null, status: '已完成' },
      { contact_id: 4, user_id: 2, type: '来访', visit_date: moment().format('YYYY-MM-DD'), content: '客户前来办理缴费，对逾期费用有异议，需进一步沟通', follow_up_date: moment().add(3, 'days').format('YYYY-MM-DD'), status: '待跟进' }
    ];
    
    for (const v of visitRecordData) {
      await run(
        'INSERT INTO visit_records (contact_id, user_id, type, visit_date, content, follow_up_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [v.contact_id, v.user_id, v.type, v.visit_date, v.content, v.follow_up_date, v.status]
      );
    }
    console.log('来访记录数据导入完成');
    
    console.log('');
    console.log('测试数据导入完成！');
    console.log('');
    console.log('已创建测试数据:');
    console.log('  - 150个墓位 (A/B/C区, 每区5排10列)');
    console.log('  - 5位逝者信息');
    console.log('  - 5位联系人');
    console.log('  - 5条缴费记录 (含即将到期和逾期)');
    console.log('  - 4条祭扫预约');
    console.log('  - 4条沟通记录');
    console.log('');
    console.log('现在可以运行 npm start 启动服务器');
    
    process.exit(0);
  } catch (err) {
    console.error('导入失败:', err);
    process.exit(1);
  }
};

seed();
