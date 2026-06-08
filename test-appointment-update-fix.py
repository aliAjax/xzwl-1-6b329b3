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

print("=" * 60)
print("测试：预约局部更新空值写入回归修复")
print("=" * 60)

# 1. 创建一个完整的预约
print("\n1. 创建一个完整的预约...")
appointment_data = {
    "contact_id": None,
    "plot_id": None,
    "appointment_date": "2026-04-04",
    "appointment_time": "09:00",
    "number_of_people": 3,
    "vehicle_number": "京B88888",
    "remark": "测试局部更新",
    "status": "待确认"
}
response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
result = response.json()
print(f"创建结果: code={result['code']}, message={result['message']}")
appointment_id = result["data"]["id"]

# 2. 查询预约详情，记录原始值
print("\n2. 查询原始预约详情...")
response = requests.get(f"{BASE_URL}/appointments/{appointment_id}", headers=headers)
original = response.json()["data"]
print(f"  vehicle_number: {original['vehicle_number']}")
print(f"  remark: {original['remark']}")
print(f"  number_of_people: {original['number_of_people']}")
print(f"  appointment_time: {original['appointment_time']}")
print(f"  status: {original['status']}")

# 3. 只更新 status 为已确认，不传其他字段
print("\n3. 只更新 status 为已确认（局部更新，不传其他字段）...")
update_data = {
    "status": "已确认"
}
response = requests.put(f"{BASE_URL}/appointments/{appointment_id}", json=update_data, headers=headers)
result = response.json()
print(f"更新结果: code={result['code']}, message={result['message']}")

# 4. 再次查询，验证其他字段没有被清空
print("\n4. 查询更新后的预约详情（验证其他字段未被清空）...")
response = requests.get(f"{BASE_URL}/appointments/{appointment_id}", headers=headers)
updated = response.json()["data"]
print(f"  vehicle_number: {updated['vehicle_number']} (原值: {original['vehicle_number']})")
print(f"  remark: {updated['remark']} (原值: {original['remark']})")
print(f"  number_of_people: {updated['number_of_people']} (原值: {original['number_of_people']})")
print(f"  appointment_time: {updated['appointment_time']} (原值: {original['appointment_time']})")
print(f"  status: {updated['status']} (原值: {original['status']})")

# 验证
errors = []
if updated['vehicle_number'] != original['vehicle_number']:
    errors.append(f"vehicle_number 被错误修改: {original['vehicle_number']} -> {updated['vehicle_number']}")
if updated['remark'] != original['remark']:
    errors.append(f"remark 被错误修改: {original['remark']} -> {updated['remark']}")
if updated['number_of_people'] != original['number_of_people']:
    errors.append(f"number_of_people 被错误修改: {original['number_of_people']} -> {updated['number_of_people']}")
if updated['appointment_time'] != original['appointment_time']:
    errors.append(f"appointment_time 被错误修改: {original['appointment_time']} -> {updated['appointment_time']}")
if updated['status'] != '已确认':
    errors.append(f"status 未正确更新: {original['status']} -> {updated['status']}")

# 5. 测试只更新 remark
print("\n5. 只更新 remark（局部更新）...")
update_data2 = {
    "remark": "备注已更新"
}
response = requests.put(f"{BASE_URL}/appointments/{appointment_id}", json=update_data2, headers=headers)
result = response.json()
print(f"更新结果: code={result['code']}, message={result['message']}")

print("\n6. 查询更新后的预约详情...")
response = requests.get(f"{BASE_URL}/appointments/{appointment_id}", headers=headers)
updated2 = response.json()["data"]
print(f"  vehicle_number: {updated2['vehicle_number']}")
print(f"  remark: {updated2['remark']}")
print(f"  number_of_people: {updated2['number_of_people']}")
print(f"  status: {updated2['status']}")

if updated2['remark'] != '备注已更新':
    errors.append(f"remark 未正确更新: {updated['remark']} -> {updated2['remark']}")
if updated2['status'] != '已确认':
    errors.append(f"status 被错误修改: 已确认 -> {updated2['status']}")
if updated2['vehicle_number'] != original['vehicle_number']:
    errors.append(f"vehicle_number 被错误修改")

# 7. 测试清空可选关联字段
print("\n7. 清空 contact_id 和 plot_id（验证可选关联允许置空）...")
linked_data = {
    "contact_id": 1,
    "plot_id": 1,
    "appointment_date": "2026-04-04",
    "appointment_time": "09:30",
    "number_of_people": 1,
    "remark": "测试清空关联"
}
response = requests.post(f"{BASE_URL}/appointments", json=linked_data, headers=headers)
linked_result = response.json()
print(f"创建关联预约: code={linked_result['code']}, message={linked_result['message']}")
linked_appointment_id = linked_result["data"]["id"]

clear_data = {
    "contact_id": None,
    "plot_id": None
}
response = requests.put(f"{BASE_URL}/appointments/{linked_appointment_id}", json=clear_data, headers=headers)
clear_result = response.json()
print(f"清空关联结果: code={clear_result['code']}, message={clear_result['message']}")

response = requests.get(f"{BASE_URL}/appointments/{linked_appointment_id}", headers=headers)
cleared = response.json()["data"]
print(f"  contact_id: {cleared['contact_id']}")
print(f"  plot_id: {cleared['plot_id']}")

if clear_result['code'] != 200:
    errors.append(f"清空可选关联失败: {clear_result['message']}")
if cleared['contact_id'] is not None:
    errors.append(f"contact_id 未被清空: {cleared['contact_id']}")
if cleared['plot_id'] is not None:
    errors.append(f"plot_id 未被清空: {cleared['plot_id']}")

# 8. 测试更新人数，验证容量检查仍然有效
print("\n8. 更新人数（验证容量检查仍然有效）...")
update_data3 = {
    "number_of_people": 200
}
response = requests.put(f"{BASE_URL}/appointments/{appointment_id}", json=update_data3, headers=headers)
result = response.json()
print(f"更新结果: code={result['code']}, message={result['message']}")
if result['code'] == 400 and '容量' in result['message']:
    print("  ✓ 容量检查正常工作")
else:
    errors.append("容量检查未正常工作")

# 9. 测试更新日期和时间
print("\n9. 更新日期和时间（验证时段关联更新）...")
update_data4 = {
    "appointment_date": "2026-04-04",
    "appointment_time": "11:00"
}
response = requests.put(f"{BASE_URL}/appointments/{appointment_id}", json=update_data4, headers=headers)
result = response.json()
print(f"更新结果: code={result['code']}, message={result['message']}")

print("\n10. 查询更新后的预约详情（验证时段关联）...")
response = requests.get(f"{BASE_URL}/appointments/{appointment_id}", headers=headers)
updated4 = response.json()["data"]
print(f"  appointment_date: {updated4['appointment_date']}")
print(f"  appointment_time: {updated4['appointment_time']}")
if updated4.get('festival_slot'):
    print(f"  festival_slot: {updated4['festival_slot']['start_time']} - {updated4['festival_slot']['end_time']}")
    if updated4['festival_slot']['start_time'] <= '11:00' < updated4['festival_slot']['end_time']:
        print("  ✓ 时段关联正确更新")
    else:
        errors.append("时段关联未正确更新")
else:
    print("  未关联到节日时段（可能是非节日时段）")

print("\n" + "=" * 60)
if errors:
    print("❌ 测试失败，发现以下问题:")
    for err in errors:
        print(f"  - {err}")
else:
    print("✅ 所有测试通过！局部更新空值写入问题已修复。")
print("=" * 60)

# 清理：删除测试预约
print("\n清理测试数据...")
requests.delete(f"{BASE_URL}/appointments/{appointment_id}", headers=headers)
if 'linked_appointment_id' in locals():
    requests.delete(f"{BASE_URL}/appointments/{linked_appointment_id}", headers=headers)
print("完成！")
