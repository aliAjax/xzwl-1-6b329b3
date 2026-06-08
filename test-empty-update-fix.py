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

print("=" * 70)
print("测试：修复清空预约时间时生成空UPDATE语句的回归")
print("=" * 70)

print("\n" + "=" * 70)
print("步骤1: 创建节日排班")
print("=" * 70)
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
            "capacity": 50,
            "remark": "早高峰时段"
        },
        {
            "date": "2026-04-04",
            "start_time": "10:00",
            "end_time": "12:00",
            "capacity": 40,
            "remark": "上午次高峰"
        }
    ]
}
response = requests.post(f"{BASE_URL}/festival-schedules", json=schedule_data, headers=headers)
result = response.json()
print(f"创建结果: code={result['code']}, message={result['message']}")
if result['code'] != 200:
    print(f"错误: {json.dumps(result, ensure_ascii=False, indent=2)}")
    exit(1)

print("\n" + "=" * 70)
print("步骤2: 创建一个带指定时间的预约")
print("=" * 70)
appointment_data = {
    "appointment_date": "2026-04-04",
    "appointment_time": "09:00",
    "number_of_people": 5,
    "remark": "测试预约"
}
response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
result = response.json()
print(f"创建结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    appointment_id = result["data"]["id"]
    print(f"预约ID: {appointment_id}")
    print(f"预约时间: 09:00")
else:
    print(f"错误: {result['message']}")
    exit(1)

print("\n" + "=" * 70)
print("测试用例1: 只清空预约时间（不修改其他字段）- 有节日时段")
print("=" * 70)
update_data = {
    "appointment_time": ""
}
response = requests.put(f"{BASE_URL}/appointments/{appointment_id}", json=update_data, headers=headers)
result = response.json()
print(f"更新结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    print("✓ 更新成功，没有生成空UPDATE语句")
    response = requests.get(f"{BASE_URL}/appointments/{appointment_id}", headers=headers)
    result = response.json()
    if result['code'] == 200:
        data = result['data']
        print(f"更新后时间: {data['appointment_time']}")
        if data.get('festival_slot'):
            print(f"✓ 仍关联节日时段: {data['festival_slot']['start_time']}-{data['festival_slot']['end_time']}")
        else:
            print("✗ 关联丢失")
else:
    print(f"✗ 更新失败: {result['message']}")

print("\n" + "=" * 70)
print("步骤3: 创建一个非节日日期的预约")
print("=" * 70)
appointment_data2 = {
    "appointment_date": "2026-03-15",
    "appointment_time": "10:00",
    "number_of_people": 3,
    "remark": "非节日预约"
}
response = requests.post(f"{BASE_URL}/appointments", json=appointment_data2, headers=headers)
result = response.json()
print(f"创建结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    appointment_id2 = result["data"]["id"]
    print(f"预约ID: {appointment_id2}")
else:
    print(f"错误: {result['message']}")
    exit(1)

print("\n" + "=" * 70)
print("测试用例2: 只清空预约时间（不修改其他字段）- 无节日时段")
print("=" * 70)
update_data = {
    "appointment_time": ""
}
response = requests.put(f"{BASE_URL}/appointments/{appointment_id2}", json=update_data, headers=headers)
result = response.json()
print(f"更新结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    print("✓ 更新成功，没有生成空UPDATE语句")
    response = requests.get(f"{BASE_URL}/appointments/{appointment_id2}", headers=headers)
    result = response.json()
    if result['code'] == 200:
        data = result['data']
        print(f"更新后时间: {data['appointment_time']}")
        if data['appointment_time'] is None or data['appointment_time'] == "":
            print("✓ 时间已正确清空")
        else:
            print("✗ 时间未正确清空")
else:
    print(f"✗ 更新失败: {result['message']}")

print("\n" + "=" * 70)
print("测试用例3: 同时清空时间并修改其他字段")
print("=" * 70)
update_data = {
    "appointment_time": "",
    "number_of_people": 8,
    "remark": "更新人数并清空时间"
}
response = requests.put(f"{BASE_URL}/appointments/{appointment_id}", json=update_data, headers=headers)
result = response.json()
print(f"更新结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    print("✓ 更新成功")
    response = requests.get(f"{BASE_URL}/appointments/{appointment_id}", headers=headers)
    result = response.json()
    if result['code'] == 200:
        data = result['data']
        print(f"更新后时间: {data['appointment_time']}")
        print(f"更新后人数: {data['number_of_people']}")
        print(f"更新后备注: {data['remark']}")
        if data.get('festival_slot'):
            print(f"✓ 仍关联节日时段: {data['festival_slot']['start_time']}-{data['festival_slot']['end_time']}")
else:
    print(f"✗ 更新失败: {result['message']}")

print("\n" + "=" * 70)
print("测试完成！")
print("=" * 70)
