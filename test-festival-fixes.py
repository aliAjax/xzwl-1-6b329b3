import requests
import json

BASE_URL = "http://localhost:3000/api"

def login():
    response = requests.post(f"{BASE_URL}/auth/login", json={
        "username": "admin",
        "password": "admin123"
    })
    return response.json()["data"]["token"]

token = login()
headers = {"Authorization": f"Bearer {token}"}

print("=== 测试修复后的API ===\n")

print("1. 查询时段详情")
response = requests.get(f"{BASE_URL}/festival-schedules/slots/1/detail", headers=headers)
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
response = requests.put(f"{BASE_URL}/festival-schedules/slots/1", json={"capacity": 150, "remark": "容量调整为150"}, headers=headers)
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
response = requests.delete(f"{BASE_URL}/festival-schedules/staff/4", headers=headers)
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
