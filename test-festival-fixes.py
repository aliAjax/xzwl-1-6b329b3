import os
import requests
import json
import time
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

token = login()
headers = {"Authorization": f"Bearer {token}"}

print("=== 测试修复后的API ===\n")

suffix = int(time.time())
schedule = requests.post(f"{BASE_URL}/festival-schedules", json={
    "festival_name": f"测试节日{suffix}",
    "festival_type": "清明节",
    "start_date": "2026-04-04",
    "end_date": "2026-04-04",
    "description": "测试排班",
    "time_slots": [{
        "date": "2026-04-04",
        "start_time": "08:00",
        "end_time": "10:00",
        "capacity": 100,
        "remark": "测试时段",
        "staff": [{"user_id": 1, "duty": "现场协调"}]
    }]
}, headers=headers).json()
print(f"创建排班: code={schedule['code']}, message={schedule['message']}")
assert schedule["code"] == 200, schedule
schedule_id = schedule["data"]["id"]
schedule_detail = requests.get(f"{BASE_URL}/festival-schedules/{schedule_id}", headers=headers).json()
slot_id = schedule_detail["data"]["dates"][0]["slots"][0]["id"]
staff_id = schedule_detail["data"]["dates"][0]["slots"][0]["staff"][0]["id"]

print("1. 查询时段详情")
response = requests.get(f"{BASE_URL}/festival-schedules/slots/{slot_id}/detail", headers=headers)
result = response.json()
print(f"时段1详情: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    print(f"  时段容量: {result['data']['capacity']}")
    print(f"  已预约人数: {result['data']['booked_people']}")
    print(f"  剩余容量: {result['data']['remaining']}")
    print(f"  工作人员数: {len(result['data']['staff'])}")
    print(f"  预约数: {len(result['data']['appointments'])}")

print()

print("2. 调整时段容量")
response = requests.put(f"{BASE_URL}/festival-schedules/slots/{slot_id}", json={"capacity": 150, "remark": "容量调整为150"}, headers=headers)
result = response.json()
print(f"调整结果: code={result['code']}, message={result['message']}")

print()

print("3. 验证容量调整")
response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
result = response.json()
if result['code'] == 200:
    slot1 = result['data']['slots'][0]
    print(f"时段1容量: {slot1['capacity']}, 剩余: {slot1['remaining']}, 已预约: {slot1['booked_people']}")

print()

print("4. 删除排班记录")
response = requests.delete(f"{BASE_URL}/festival-schedules/staff/{staff_id}", headers=headers)
result = response.json()
print(f"删除结果: code={result['code']}, message={result['message']}")

print()

print("5. 测试容量限制")
appointment1 = requests.post(f"{BASE_URL}/appointments", json={
    "appointment_date": "2026-04-04",
    "appointment_time": "08:30",
    "number_of_people": 145
}, headers=headers).json()
print(f"预约1(145人): code={appointment1['code']}, message={appointment1['message']}")

appointment2 = requests.post(f"{BASE_URL}/appointments", json={
    "appointment_date": "2026-04-04",
    "appointment_time": "08:30",
    "number_of_people": 10
}, headers=headers).json()
print(f"预约2(10人): code={appointment2['code']}, message={appointment2['message']}")

appointment3 = requests.post(f"{BASE_URL}/appointments", json={
    "appointment_date": "2026-04-04",
    "appointment_time": "08:30",
    "number_of_people": 10
}, headers=headers).json()
print(f"预约3(10人，应该失败): code={appointment3['code']}, message={appointment3['message']}")

print()

print("=== 测试完成! ===")
