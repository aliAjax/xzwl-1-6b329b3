import os
import requests
import json
# 测试环境配置
PORT = int(os.environ.get('TEST_PORT', '3001'))
BASE_URL = os.environ.get('TEST_BASE_URL', f'http://localhost:{PORT}') + '/api'
TEST_USERNAME = os.environ.get('TEST_USERNAME', 'admin')
TEST_PASSWORD = os.environ.get('TEST_PASSWORD', 'admin123')

def login():
    response = requests.post(f"{BASE_URL}/auth/login", json={
        "username": "admin",
        "password": "admin123"
    })
    return response.json()["data"]["token"]

def test_festival_schedules(token):
    headers = {"Authorization": f"Bearer {token}"}
    
    print("\n" + "="*60)
    print("测试1: 创建节日排班")
    print("="*60)
    schedule_data = {
        "festival_name": "2026年清明节祭扫",
        "festival_type": "清明节",
        "start_date": "2026-04-04",
        "end_date": "2026-04-06",
        "description": "2026年清明节祭扫高峰时段排班",
        "time_slots": [
            {
                "date": "2026-04-04",
                "start_time": "08:00",
                "end_time": "10:00",
                "capacity": 100,
                "remark": "早高峰时段",
                "staff": [
                    {"user_id": 1, "duty": "现场引导"},
                    {"user_id": 2, "duty": "预约核验"}
                ]
            },
            {
                "date": "2026-04-04",
                "start_time": "10:00",
                "end_time": "12:00",
                "capacity": 80,
                "remark": "上午次高峰",
                "staff": [
                    {"user_id": 2, "duty": "现场引导"}
                ]
            },
            {
                "date": "2026-04-04",
                "start_time": "13:00",
                "end_time": "15:00",
                "capacity": 80,
                "remark": "下午高峰时段"
            },
            {
                "date": "2026-04-05",
                "start_time": "08:00",
                "end_time": "10:00",
                "capacity": 120,
                "remark": "清明节正日早高峰"
            },
            {
                "date": "2026-04-05",
                "start_time": "10:00",
                "end_time": "12:00",
                "capacity": 100,
                "remark": "清明节正日上午"
            },
            {
                "date": "2026-04-06",
                "start_time": "08:00",
                "end_time": "12:00",
                "capacity": 60,
                "remark": "节后时段"
            }
        ]
    }
    response = requests.post(f"{BASE_URL}/festival-schedules", json=schedule_data, headers=headers)
    result = response.json()
    print(f"创建结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    schedule_id = result["data"]["id"]
    
    print("\n" + "="*60)
    print("测试2: 查询节日排班列表")
    print("="*60)
    response = requests.get(f"{BASE_URL}/festival-schedules", headers=headers)
    result = response.json()
    print(f"列表结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试3: 查询某日可预约时段")
    print("="*60)
    response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
    result = response.json()
    print(f"时段查询结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试4: 查询日历数据")
    print("="*60)
    response = requests.get(f"{BASE_URL}/festival-schedules/calendar?month=2026-04", headers=headers)
    result = response.json()
    print(f"日历数据: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试5: 查询节日排班详情")
    print("="*60)
    response = requests.get(f"{BASE_URL}/festival-schedules/{schedule_id}", headers=headers)
    result = response.json()
    print(f"详情结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试6: 创建预约 - 测试容量检查")
    print("="*60)
    appointment_data = {
        "appointment_date": "2026-04-04",
        "appointment_time": "08:30",
        "number_of_people": 5,
        "vehicle_number": "京A12345",
        "remark": "清明祭扫预约"
    }
    response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
    result = response.json()
    print(f"预约创建结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    appointment_id = result["data"]["id"]
    
    print("\n" + "="*60)
    print("测试7: 再次查询可预约时段 - 验证容量减少")
    print("="*60)
    response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
    result = response.json()
    print(f"时段查询结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试8: 查询预约详情 - 验证节日时段关联")
    print("="*60)
    response = requests.get(f"{BASE_URL}/appointments/{appointment_id}", headers=headers)
    result = response.json()
    print(f"预约详情: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试9: 查询时段详情 - 查看预约和工作人员安排")
    print("="*60)
    slots = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers).json()["data"]["slots"]
    slot_id = slots[0]["id"]
    response = requests.get(f"{BASE_URL}/festival-schedules/slots/{slot_id}/detail", headers=headers)
    result = response.json()
    print(f"时段详情: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试10: 调整时段容量")
    print("="*60)
    update_data = {
        "capacity": 150,
        "remark": "容量调整为150"
    }
    response = requests.put(f"{BASE_URL}/festival-schedules/slots/{slot_id}", json=update_data, headers=headers)
    result = response.json()
    print(f"容量调整结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试11: 验证容量已更新")
    print("="*60)
    response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
    result = response.json()
    print(f"时段查询结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试12: 取消预约 - 验证容量释放")
    print("="*60)
    response = requests.post(f"{BASE_URL}/appointments/{appointment_id}/cancel", json={"reason": "行程变更"}, headers=headers)
    result = response.json()
    print(f"取消预约结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试13: 验证容量已释放")
    print("="*60)
    response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
    result = response.json()
    print(f"时段查询结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试14: 添加工作人员排班")
    print("="*60)
    staff_data = {
        "time_slot_id": slot_id,
        "user_id": 1,
        "duty": "秩序维护"
    }
    response = requests.post(f"{BASE_URL}/festival-schedules/staff", json=staff_data, headers=headers)
    result = response.json()
    print(f"添加排班结果(用户1已存在，应该失败): {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    staff_data2 = {
        "time_slot_id": 3,
        "user_id": 1,
        "duty": "秩序维护"
    }
    response = requests.post(f"{BASE_URL}/festival-schedules/staff", json=staff_data2, headers=headers)
    result = response.json()
    print(f"添加排班结果(时段3，应该成功): {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试15: 预约占用统计")
    print("="*60)
    response = requests.get(f"{BASE_URL}/festival-schedules/stats/overview?start_date=2026-04-01&end_date=2026-04-30", headers=headers)
    result = response.json()
    print(f"统计结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("测试16: 测试容量不足的情况")
    print("="*60)
    small_slot_data = {
        "festival_schedule_id": schedule_id,
        "date": "2026-04-04",
        "start_time": "15:00",
        "end_time": "17:00",
        "capacity": 3,
        "remark": "小容量测试时段"
    }
    response = requests.post(f"{BASE_URL}/festival-schedules/slots", json=small_slot_data, headers=headers)
    small_slot_id = response.json()["data"]["id"]
    
    appointment1 = requests.post(f"{BASE_URL}/appointments", json={
        "appointment_date": "2026-04-04",
        "appointment_time": "15:30",
        "number_of_people": 2
    }, headers=headers).json()
    print(f"预约1(2人): {appointment1['code']} - {appointment1['message']}")
    
    appointment2 = requests.post(f"{BASE_URL}/appointments", json={
        "appointment_date": "2026-04-04",
        "appointment_time": "15:30",
        "number_of_people": 2
    }, headers=headers).json()
    print(f"预约2(2人，应该失败): {appointment2['code']} - {appointment2['message']}")
    
    print("\n" + "="*60)
    print("测试17: 更新节日排班信息")
    print("="*60)
    update_schedule_data = {
        "description": "2026年清明节祭扫高峰时段排班 - 已更新",
        "status": "active"
    }
    response = requests.put(f"{BASE_URL}/festival-schedules/{schedule_id}", json=update_schedule_data, headers=headers)
    result = response.json()
    print(f"更新排班结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
    
    print("\n" + "="*60)
    print("所有测试完成!")
    print("="*60)

if __name__ == "__main__":
    print("="*60)
    print("节日祭扫接待排班模块 API 测试")
    print("="*60)
    
    token = login()
    print(f"登录成功，获取Token: {token[:20]}...")
    
    test_festival_schedules(token)
