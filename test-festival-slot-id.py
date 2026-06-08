#!/usr/bin/env python3
import requests
import json

BASE_URL = "http://localhost:3000/api"

def login():
    response = requests.post(f"{BASE_URL}/auth/login", json={
        "username": "admin",
        "password": "admin123"
    })
    return response.json()["data"]["token"]

def print_test_result(test_name, success, message=""):
    status = "✓ PASS" if success else "✗ FAIL"
    print(f"{status} - {test_name}")
    if message:
        print(f"  {message}")

def main():
    print("=" * 70)
    print("测试：预约创建和更新时 festival_time_slot_id 参数支持")
    print("=" * 70)

    token = login()
    headers = {"Authorization": f"Bearer {token}"}

    print(f"\n登录成功，获取Token: {token[:20]}...")

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
                "date": "2026-04-05",
                "start_time": "13:00",
                "end_time": "17:00",
                "capacity": 60,
                "remark": "清明节正日下午"
            }
        ]
    }
    response = requests.post(f"{BASE_URL}/festival-schedules", json=schedule_data, headers=headers)
    result = response.json()
    if result['code'] == 200:
        schedule_id = result["data"]["id"]
        print(f"✓ 节日排班创建成功，ID: {schedule_id}")
    else:
        print(f"✗ 创建失败: {result['message']}")
        return

    print("\n" + "=" * 70)
    print("步骤2: 查询2026-04-04的可预约时段，获取时段ID")
    print("=" * 70)
    response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
    result = response.json()
    slots = result['data']['slots']
    slot1_id = slots[0]['id']
    slot2_id = slots[1]['id']
    print(f"时段1: ID={slot1_id}, 08:00-10:00, 容量={slots[0]['capacity']}, 剩余={slots[0]['remaining']}")
    print(f"时段2: ID={slot2_id}, 10:00-12:00, 容量={slots[1]['capacity']}, 剩余={slots[1]['remaining']}")

    print("\n" + "=" * 70)
    print("测试用例1: 通过 festival_time_slot_id 创建预约（指定时段1）")
    print("=" * 70)
    appointment_data = {
        "appointment_date": "2026-04-04",
        "appointment_time": "08:30",
        "number_of_people": 5,
        "festival_time_slot_id": slot1_id,
        "remark": "通过时段ID创建预约"
    }
    response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
    result = response.json()
    if result['code'] == 200:
        appointment_id1 = result["data"]["id"]
        print(f"✓ 预约创建成功，ID: {appointment_id1}")
        ci = result["data"]["capacity_info"]
        if ci.get("time_slot_id") == slot1_id:
            print(f"  ✓ 正确关联时段ID: {ci['time_slot_id']}")
        else:
            print(f"  ✗ 时段ID不匹配: {ci.get('time_slot_id')}")
        print(f"  容量信息: 容量={ci['capacity']}, 已预约={ci['booked']}, 剩余={ci['remaining']}")
    else:
        print(f"✗ 创建失败: {result['message']}")
        return

    print("\n" + "=" * 70)
    print("测试用例2: 查询预约详情，验证节日时段关联")
    print("=" * 70)
    response = requests.get(f"{BASE_URL}/appointments/{appointment_id1}", headers=headers)
    result = response.json()
    if result['code'] == 200:
        data = result['data']
        if data.get('festival_slot'):
            fs = data['festival_slot']
            if fs['time_slot_id'] == slot1_id:
                print(f"✓ 预约详情正确关联时段: {fs['festival_name']} {fs['start_time']}-{fs['end_time']}")
                print(f"  时段ID: {fs['time_slot_id']}")
            else:
                print(f"✗ 时段ID不匹配")
        else:
            print("✗ 未关联节日时段")
    else:
        print(f"✗ 查询失败: {result['message']}")

    print("\n" + "=" * 70)
    print("测试用例3: 验证时段容量已更新")
    print("=" * 70)
    response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
    result = response.json()
    slots = result['data']['slots']
    for slot in slots:
        if slot['id'] == slot1_id:
            if slot['booked_people'] == 5:
                print(f"✓ 时段1已预约人数正确: {slot['booked_people']}人")
            else:
                print(f"✗ 时段1已预约人数错误: {slot['booked_people']}，应为5")
            print(f"  容量={slot['capacity']}, 剩余={slot['remaining']}")

    print("\n" + "=" * 70)
    print("测试用例4: 日期不匹配应该失败")
    print("=" * 70)
    appointment_data = {
        "appointment_date": "2026-04-05",
        "appointment_time": "08:30",
        "number_of_people": 3,
        "festival_time_slot_id": slot1_id,
        "remark": "日期不匹配测试"
    }
    response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
    result = response.json()
    if result['code'] == 400 and "不匹配" in result['message']:
        print_test_result("日期不匹配校验", True, f"正确拒绝: {result['message']}")
    else:
        print_test_result("日期不匹配校验", False, f"应该失败但结果: code={result['code']}, message={result['message']}")

    print("\n" + "=" * 70)
    print("测试用例5: 时间不在时段范围内应该失败")
    print("=" * 70)
    appointment_data = {
        "appointment_date": "2026-04-04",
        "appointment_time": "11:30",
        "number_of_people": 3,
        "festival_time_slot_id": slot1_id,
        "remark": "时间不匹配测试"
    }
    response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
    result = response.json()
    if result['code'] == 400 and "不在时段范围内" in result['message']:
        print_test_result("时间范围校验", True, f"正确拒绝: {result['message']}")
    else:
        print_test_result("时间范围校验", False, f"应该失败但结果: code={result['code']}, message={result['message']}")

    print("\n" + "=" * 70)
    print("测试用例6: 容量不足应该失败")
    print("=" * 70)
    appointment_data = {
        "appointment_date": "2026-04-04",
        "appointment_time": "09:00",
        "number_of_people": 100,
        "festival_time_slot_id": slot1_id,
        "remark": "容量不足测试"
    }
    response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
    result = response.json()
    if result['code'] == 400 and "已满" in result['message']:
        print_test_result("容量不足校验", True, f"正确拒绝: {result['message']}")
    else:
        print_test_result("容量不足校验", False, f"应该失败但结果: code={result['code']}, message={result['message']}")

    print("\n" + "=" * 70)
    print("测试用例7: 不指定时间，通过时段ID创建预约（自动分配时间）")
    print("=" * 70)
    appointment_data = {
        "appointment_date": "2026-04-04",
        "number_of_people": 8,
        "festival_time_slot_id": slot2_id,
        "remark": "不指定时间，通过时段ID创建"
    }
    response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
    result = response.json()
    if result['code'] == 200:
        appointment_id2 = result["data"]["id"]
        print(f"✓ 预约创建成功，ID: {appointment_id2}")
        if "auto_assigned_time" in result["data"]:
            print(f"  ✓ 自动分配时间: {result['data']['auto_assigned_time']}")
        ci = result["data"]["capacity_info"]
        print(f"  容量信息: 容量={ci['capacity']}, 已预约={ci['booked']}, 剩余={ci['remaining']}")
    else:
        print(f"✗ 创建失败: {result['message']}")

    print("\n" + "=" * 70)
    print("测试用例8: 非节日日期预约，保持原有行为")
    print("=" * 70)
    appointment_data = {
        "appointment_date": "2026-03-15",
        "appointment_time": "10:00",
        "number_of_people": 3,
        "remark": "非节日预约"
    }
    response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
    result = response.json()
    if result['code'] == 200:
        appointment_id3 = result["data"]["id"]
        print(f"✓ 非节日预约创建成功，ID: {appointment_id3}")
        if not result["data"]["capacity_info"]["has_slot"]:
            print("  ✓ 正确保持原有行为（未关联节日时段）")
        else:
            print("  ✗ 错误关联了节日时段")
    else:
        print(f"✗ 创建失败: {result['message']}")

    print("\n" + "=" * 70)
    print("测试用例9: 更新预约，修改为另一个时段")
    print("=" * 70)
    update_data = {
        "festival_time_slot_id": slot2_id,
        "appointment_time": "10:30"
    }
    response = requests.put(f"{BASE_URL}/appointments/{appointment_id1}", json=update_data, headers=headers)
    result = response.json()
    if result['code'] == 200:
        print("✓ 预约更新成功")
        response = requests.get(f"{BASE_URL}/appointments/{appointment_id1}", headers=headers)
        result = response.json()
        if result['code'] == 200:
            data = result['data']
            if data.get('festival_slot') and data['festival_slot']['time_slot_id'] == slot2_id:
                print(f"  ✓ 已成功修改为时段2: {data['festival_slot']['start_time']}-{data['festival_slot']['end_time']}")
            else:
                print(f"  ✗ 时段未正确修改")
    else:
        print(f"✗ 更新失败: {result['message']}")

    print("\n" + "=" * 70)
    print("测试用例10: 更新预约，解除节日时段关联")
    print("=" * 70)
    update_data = {
        "festival_time_slot_id": None
    }
    response = requests.put(f"{BASE_URL}/appointments/{appointment_id2}", json=update_data, headers=headers)
    result = response.json()
    if result['code'] == 200:
        print("✓ 预约更新成功")
        response = requests.get(f"{BASE_URL}/appointments/{appointment_id2}", headers=headers)
        result = response.json()
        if result['code'] == 200:
            data = result['data']
            if not data.get('festival_slot'):
                print("  ✓ 已成功解除节日时段关联")
            else:
                print(f"  ✗ 时段关联仍存在: {data.get('festival_slot')}")
    else:
        print(f"✗ 更新失败: {result['message']}")

    print("\n" + "=" * 70)
    print("测试用例11: 时段不存在应该失败")
    print("=" * 70)
    appointment_data = {
        "appointment_date": "2026-04-04",
        "appointment_time": "09:00",
        "number_of_people": 3,
        "festival_time_slot_id": 99999,
        "remark": "不存在的时段ID"
    }
    response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
    result = response.json()
    if result['code'] == 400 and "不存在" in result['message']:
        print_test_result("时段不存在校验", True, f"正确拒绝: {result['message']}")
    else:
        print_test_result("时段不存在校验", False, f"应该失败但结果: code={result['code']}, message={result['message']}")

    print("\n" + "=" * 70)
    print("测试用例12: 取消预约，验证容量释放")
    print("=" * 70)
    response = requests.post(f"{BASE_URL}/appointments/{appointment_id1}/cancel", json={"reason": "测试取消"}, headers=headers)
    result = response.json()
    if result['code'] == 200:
        print("✓ 预约取消成功")
        response = requests.get(f"{BASE_URL}/festival-schedules/available-slots?date=2026-04-04", headers=headers)
        result = response.json()
        slots = result['data']['slots']
        for slot in slots:
            if slot['id'] == slot2_id:
                print(f"  时段2: 已预约={slot['booked_people']}人")

    print("\n" + "=" * 70)
    print("测试用例13: 普通预约（不指定festival_time_slot_id）自动匹配时段")
    print("=" * 70)
    appointment_data = {
        "appointment_date": "2026-04-04",
        "appointment_time": "08:15",
        "number_of_people": 6,
        "remark": "普通预约自动匹配"
    }
    response = requests.post(f"{BASE_URL}/appointments", json=appointment_data, headers=headers)
    result = response.json()
    if result['code'] == 200:
        appointment_id4 = result["data"]["id"]
        print(f"✓ 预约创建成功，ID: {appointment_id4}")
        ci = result["data"]["capacity_info"]
        if ci["has_slot"]:
            print(f"  ✓ 自动匹配到时段，时段ID: {ci.get('time_slot_id')}")
            print(f"    容量={ci['capacity']}, 已预约={ci['booked']}, 剩余={ci['remaining']}")
        else:
            print("  ✗ 未自动匹配时段")
    else:
        print(f"✗ 创建失败: {result['message']}")

    print("\n" + "=" * 70)
    print("所有测试完成！")
    print("=" * 70)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback
        traceback.print_exc()
