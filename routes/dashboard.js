const express = require('express');
const moment = require('moment');
const { get, all } = require('../utils/dbHelper');
const { success, error } = require('../utils/response');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/overview', authenticate, async (req, res) => {
  try {
    const today = moment().format('YYYY-MM-DD');
    const thirtyDaysLater = moment().add(30, 'days').format('YYYY-MM-DD');

    const plotStats = await get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = '空闲' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = '已占用' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = '维修中' THEN 1 ELSE 0 END) as maintenance
      FROM plots
    `);

    const todayAppointments = await all(`
      SELECT a.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             p.plot_number,
             p.area
      FROM appointments a 
      LEFT JOIN contacts c ON a.contact_id = c.id 
      LEFT JOIN plots p ON a.plot_id = p.id 
      WHERE a.appointment_date = ?
      ORDER BY a.appointment_time ASC
    `, [today]);

    const appointmentStats = await get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = '待确认' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = '已确认' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = '已取消' THEN 1 ELSE 0 END) as cancelled,
        SUM(number_of_people) as total_people
      FROM appointments 
      WHERE appointment_date = ?
    `, [today]);

    const upcomingPayments = await all(`
      SELECT py.*, 
             p.plot_number,
             p.area,
             c.name as contact_name,
             c.phone as contact_phone,
             d.name as deceased_name,
             julianday(py.due_date) - julianday(?) as days_remaining
      FROM payments py 
      LEFT JOIN plots p ON py.plot_id = p.id 
      LEFT JOIN contacts c ON py.contact_id = c.id 
      LEFT JOIN deceased d ON p.id = d.plot_id 
      WHERE py.due_date >= ? 
        AND py.due_date <= ?
        AND py.status != '已缴'
      ORDER BY py.due_date ASC
      LIMIT 10
    `, [today, today, thirtyDaysLater]);

    const paymentStats = await get(`
      SELECT 
        SUM(CASE WHEN due_date >= ? AND due_date <= ? AND status != '已缴' THEN 1 ELSE 0 END) as upcoming,
        SUM(CASE WHEN due_date < ? AND status != '已缴' THEN 1 ELSE 0 END) as overdue
      FROM payments
    `, [today, thirtyDaysLater, today]);

    const overdueFollowUps = await all(`
      SELECT v.*, 
             c.name as contact_name,
             c.phone as contact_phone,
             u.name as user_name,
             julianday(?) - julianday(v.follow_up_date) as days_overdue
      FROM visit_records v 
      LEFT JOIN contacts c ON v.contact_id = c.id 
      LEFT JOIN users u ON v.user_id = u.id 
      WHERE v.status = '待跟进'
        AND v.follow_up_date < ?
      ORDER BY v.follow_up_date ASC
      LIMIT 10
    `, [today, today]);

    const followUpStats = await get(`
      SELECT 
        SUM(CASE WHEN status = '待跟进' AND follow_up_date < ? THEN 1 ELSE 0 END) as overdue,
        SUM(CASE WHEN status = '待跟进' AND follow_up_date >= ? AND follow_up_date <= ? THEN 1 ELSE 0 END) as upcoming
      FROM visit_records
    `, [today, today, thirtyDaysLater]);

    const plotOccupancy = {
      total: plotStats.total,
      available: plotStats.available,
      occupied: plotStats.occupied,
      maintenance: plotStats.maintenance,
      occupancyRate: plotStats.total > 0 ? ((plotStats.occupied / plotStats.total) * 100).toFixed(1) + '%' : '0%'
    };

    const todayAppointmentData = {
      date: today,
      list: todayAppointments,
      statistics: {
        total: appointmentStats.total || 0,
        pending: appointmentStats.pending || 0,
        confirmed: appointmentStats.confirmed || 0,
        completed: appointmentStats.completed || 0,
        cancelled: appointmentStats.cancelled || 0,
        total_people: appointmentStats.total_people || 0
      }
    };

    const upcomingPaymentData = upcomingPayments.map(item => ({
      ...item,
      days_remaining: Math.ceil(item.days_remaining),
      is_overdue: false,
      urgency: item.days_remaining <= 7 ? '即将到期' : '近期到期'
    }));

    const paymentOverview = {
      upcoming: paymentStats.upcoming || 0,
      overdue: paymentStats.overdue || 0,
      list: upcomingPaymentData
    };

    const overdueFollowUpData = overdueFollowUps.map(item => ({
      ...item,
      days_overdue: Math.floor(item.days_overdue)
    }));

    const followUpOverview = {
      overdue: followUpStats.overdue || 0,
      upcoming: followUpStats.upcoming || 0,
      overdue_list: overdueFollowUpData
    };

    success(res, {
      plot_occupancy: plotOccupancy,
      today_appointments: todayAppointmentData,
      upcoming_payments: paymentOverview,
      overdue_follow_ups: followUpOverview
    }, '首页概览查询成功');
  } catch (err) {
    error(res, err.message, 500);
  }
});

module.exports = router;
