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

token = login()
headers = {"Authorization": f"Bearer {token}"}

print("=" * 70)
print("测试：普通预约自动识别节日时段功能")
print("=" * 70)

print("\n" + "=" * 70)
print("步骤1: 创建节日排班（2026年清明节，4月4日-4月6日）")
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
        },
        {
            "date": "2026-04-04",
            "start_time": "13:00",
            "end_time": "15:00",
            "capacity": 40,
            "remark": "下午高峰时段"
        },
        {
            "date": "2026-04-05",
            "start_time": "08:00",
            "end_time": "12:00",
            "capacity": 100,
            "remark": "清明节正日"
        }
    ]
}
response = requests.post(f"{BASE_URL}/festival-schedules", json=schedule_data, headers=headers)
result = response.json()
print(f"创建结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    schedule_id = result["data"]["id"]
    print(f"节日排班ID: {schedule_id}")
else:
    print(f"错误详情: {json.dumps(result, ensure_ascii=False, indent=2)}")
    exit(1)

print("\n" + "=" * 70)
print("步骤2: 查询2026-04-04的可预约时段")
print("=" * 70)
response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
result = response.json()
if result['code'] == 200:
    slots = result['data']['slots']
    print(f"查询到 {len(slots)} 个时段:")
    for slot in slots:
        print(f"  - {slot['start_time']}-{slot['end_time']}: 容量={slot['capacity']}, 剩余={slot['remaining']}")
else:
    print(f"查询失败: {result['message']}")

print("\n" + "=" * 70)
print("测试用例1: 创建普通预约（不指定时间），应自动识别节日时段")
print("=" * 70)
appointment_data = {
    "appointment_date": "2026-04-04",
    "number_of_people": 5,
    "vehicle_number": "京A12345",
    "remark": "清明祭扫预约（未指定时间）"
}
response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
result = response.json()
print(f"创建结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    appointment_id1 = result["data"]["id"]
    print(f"预约ID: {appointment_id1}")
    if "auto_assigned_time" in result["data"]:
        print(f"✓ 自动分配时间: {result['data']['auto_assigned_time']}")
    else:
        print("✗ 未自动分配时间")
    if result["data"]["capacity_info"]["has_slot"]:
        ci = result["data"]["capacity_info"]
        print(f"✓ 已关联节日时段: 容量={ci['capacity']}, 已预约={ci['booked']}, 剩余={ci['remaining']}")
    else:
        print("✗ 未关联节日时段")
else:
    print(f"错误: {json.dumps(result, ensure_ascii=False, indent=2)}")

print("\n" + "=" * 70)
print("测试用例2: 查询预约详情，验证节日时段关联")
print("=" * 70)
response = requests.get(f"{BASE_URL}/appointments/{appointment_id1}", headers=headers)
result = response.json()
if result['code'] == 200:
    data = result['data']
    print(f"预约日期: {data['appointment_date']}")
    print(f"预约时间: {data['appointment_time']}")
    print(f"人数: {data['number_of_people']}")
    if data.get('festival_slot'):
        fs = data['festival_slot']
        print(f"✓ 关联节日时段: {fs['festival_name']} {fs['start_time']}-{fs['end_time']}")
        print(f"  时段容量: {fs['capacity']}")
    else:
        print("✗ 未关联节日时段")
else:
    print(f"查询失败: {result['message']}")

print("\n" + "=" * 70)
print("测试用例3: 创建普通预约（指定时间11:00），应落入第二个时段")
print("=" * 70)
appointment_data = {
    "appointment_date": "2026-04-04",
    "appointment_time": "11:00",
    "number_of_people": 10,
    "remark": "清明祭扫预约（指定11:00）"
}
response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
result = response.json()
print(f"创建结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    appointment_id2 = result["data"]["id"]
    print(f"预约ID: {appointment_id2}")
    if result["data"]["capacity_info"]["has_slot"]:
        ci = result["data"]["capacity_info"]
        print(f"✓ 已关联节日时段: 容量={ci['capacity']}, 已预约={ci['booked']}, 剩余={ci['remaining']}")
else:
    print(f"错误: {result['message']}")
    appointment_id2 = appointment_id1

print("\n" + "=" * 70)
print("测试用例4: 查询时段详情，验证预约人数统计")
print("=" * 70)
response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
result = response.json()
if result['code'] == 200:
    slots = result['data']['slots']
    for slot in slots:
        print(f"  {slot['start_time']}-{slot['end_time']}: 容量={slot['capacity']}, 已预约={slot['booked_people']}, 剩余={slot['remaining']}")
    total_booked = result['data']['total_booked']
    print(f"\n总计: 已预约 {total_booked} 人 (测试用例1+2 = 5+10 = 15人)")

print("\n" + "=" * 70)
print("测试用例5: 创建非节日日期的预约，应保持原有行为")
print("=" * 70)
appointment_data = {
    "appointment_date": "2026-03-15",
    "number_of_people": 3,
    "remark": "非节日预约"
}
response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
result = response.json()
print(f"创建结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    appointment_id3 = result["data"]["id"]
    print(f"预约ID: {appointment_id3}")
    if not result["data"]["capacity_info"]["has_slot"]:
        print("✓ 非节日日期，正确保持原有行为（未关联节日时段）")
    else:
        print("✗ 非节日日期错误关联了节日时段")

print("\n" + "=" * 70)
print("测试用例6: 测试容量不足的情况")
print("=" * 70)
appointment_data = {
    "appointment_date": "2026-04-04",
    "appointment_time": "09:00",
    "number_of_people": 100,
    "remark": "测试超容量"
}
response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
result = response.json()
print(f"创建结果: code={result['code']}, message={result['message']}")
if result['code'] == 400 and "已满" in result['message']:
    print("✓ 正确拒绝超容量预约")
else:
    print("✗ 未正确拒绝超容量预约")

print("\n" + "=" * 70)
print("测试用例7: 更新预约，清空时间，验证重新自动分配时段")
print("=" * 70)
update_data = {
    "appointment_time": "",
    "number_of_people": 8
}
response = requests.put(f"{BASE_URL}/appointments/{appointment_id2}", json=update_data, headers=headers)
result = response.json()
print(f"更新结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    response = requests.get(f"{BASE_URL}/appointments/{appointment_id2}", headers=headers)
    result = response.json()
    if result['code'] == 200:
        data = result['data']
        print(f"更新后时间: {data['appointment_time']}")
        if data.get('festival_slot'):
            print(f"✓ 仍关联节日时段: {data['festival_slot']['start_time']}-{data['festival_slot']['end_time']}")
        else:
            print("✗ 关联丢失")
else:
    print(f"错误: {result['message']}")

print("\n" + "=" * 70)
print("测试用例8: 取消预约，验证容量释放")
print("=" * 70)
response = requests.post(f"{BASE_URL}/appointments/{appointment_id1}/cancel", json={"reason": "测试取消"}, headers=headers)
result = response.json()
print(f"取消结果: code={result['code']}, message={result['message']}")
if result['code'] == 200:
    response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
    result = response.json()
    if result['code'] == 200:
        slots = result['data']['slots']
        for slot in slots:
            print(f"  {slot['start_time']}-{slot['end_time']}: 容量={slot['capacity']}, 已预约={slot['booked_people']}, 剩余={slot['remaining']}")
        print(f"\n总计: 已预约 {result['data']['total_booked']} 人 (取消5人后应为 15-5=10 人)")

print("\n" + "=" * 70)
print("测试完成！")
print("=" * 70)
