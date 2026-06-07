#!/usr/bin/env python3
import requests
import json
import sys

BASE_URL = "http://localhost:3000/api"

def print_section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")

def print_result(description, success, details=""):
    mark = "✓" if success else "✗"
    status = "PASS" if success else "FAIL"
    print(f"{mark} [{status}] {description}")
    if details:
        print(f"    {details}")
    return success

def main():
    print_section("维修工单默认处理人姓名 - 测试")
    
    login_data = {"username": "admin", "password": "admin123"}
    r = requests.post(f"{BASE_URL}/auth/login", json=login_data)
    result = r.json()
    
    if result["code"] != 200:
        print("✗ 登录失败")
        return
    
    token = result["data"]["token"]
    headers = {"Authorization": f"Bearer {token}"}
    current_user = result["data"]["user"]
    print(f"✓ 登录成功，用户: {current_user['name']} (ID: {current_user['id']})")
    
    test_results = []
    
    print_section("测试1: 创建测试墓位")
    r = requests.post(f"{BASE_URL}/plots", headers=headers, json={
        "plot_number": "TEST-HANDLER-001",
        "area": "测试区",
        "row": 98,
        "col": 1,
        "status": "空闲",
        "type": "单穴",
        "price": 10000
    })
    result = r.json()
    if result["code"] == 200:
        plot_id = result["data"]["id"]
        test_results.append(print_result("创建墓位成功", True, f"墓位ID: {plot_id}"))
    else:
        r = requests.get(f"{BASE_URL}/plots?keyword=TEST-HANDLER-001", headers=headers)
        result = r.json()
        plot_id = result["data"]["list"][0]["id"]
        test_results.append(print_result("找到已存在的墓位", True, f"墓位ID: {plot_id}"))
    
    print_section("测试2: 创建工单不指定处理人 - 应默认使用当前用户")
    r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
        "plot_id": plot_id,
        "reason": "测试默认处理人"
    })
    result = r.json()
    if result["code"] == 200:
        order_id = result["data"]["id"]
        
        r = requests.get(f"{BASE_URL}/maintenance-orders/{order_id}", headers=headers)
        order = r.json()["data"]
        
        test_results.append(print_result(
            "工单创建成功",
            True,
            f"工单ID: {order_id}"
        ))
        test_results.append(print_result(
            f"handler_id = {order['handler_id']} (期望: {current_user['id']})",
            order['handler_id'] == current_user['id'],
            f"handler_id: {order['handler_id']}"
        ))
        test_results.append(print_result(
            f"handler_name = '{order['handler_name']}' (期望: '{current_user['name']}')",
            order['handler_name'] == current_user['name'],
            f"handler_name: {order['handler_name']}"
        ))
    else:
        test_results.append(print_result("创建工单失败", False, result["message"]))
        return
    
    print_section("测试3: 创建工单指定处理人ID - 应自动获取姓名")
    r = requests.post(f"{BASE_URL}/plots", headers=headers, json={
        "plot_number": "TEST-HANDLER-002",
        "area": "测试区",
        "row": 98,
        "col": 2,
        "status": "空闲",
        "type": "单穴",
        "price": 10000
    })
    result = r.json()
    if result["code"] == 200:
        plot_id_2 = result["data"]["id"]
    else:
        r = requests.get(f"{BASE_URL}/plots?keyword=TEST-HANDLER-002", headers=headers)
        result = r.json()
        plot_id_2 = result["data"]["list"][0]["id"]
    
    r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
        "plot_id": plot_id_2,
        "reason": "测试指定处理人",
        "handler_id": current_user['id']
    })
    result = r.json()
    if result["code"] == 200:
        order_id_2 = result["data"]["id"]
        
        r = requests.get(f"{BASE_URL}/maintenance-orders/{order_id_2}", headers=headers)
        order = r.json()["data"]
        
        test_results.append(print_result(
            "指定处理人创建工单成功",
            True,
            f"工单ID: {order_id_2}"
        ))
        test_results.append(print_result(
            f"handler_name自动填充: '{order['handler_name']}' (期望: '{current_user['name']}')",
            order['handler_name'] == current_user['name'],
            f"handler_name: {order['handler_name']}"
        ))
    else:
        test_results.append(print_result("创建工单失败", False, result["message"]))
    
    print_section("测试4: 开始处理时补齐处理人姓名")
    r = requests.post(f"{BASE_URL}/plots", headers=headers, json={
        "plot_number": "TEST-HANDLER-003",
        "area": "测试区",
        "row": 98,
        "col": 3,
        "status": "空闲",
        "type": "单穴",
        "price": 10000
    })
    result = r.json()
    if result["code"] == 200:
        plot_id_3 = result["data"]["id"]
    else:
        r = requests.get(f"{BASE_URL}/plots?keyword=TEST-HANDLER-003", headers=headers)
        result = r.json()
        plot_id_3 = result["data"]["list"][0]["id"]
    
    r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
        "plot_id": plot_id_3,
        "reason": "测试开始处理时补齐姓名",
        "handler_id": current_user['id']
    })
    result = r.json()
    order_id_3 = result["data"]["id"]
    
    r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_3}/start", headers=headers, json={})
    result = r.json()
    
    if result["code"] == 200:
        r = requests.get(f"{BASE_URL}/maintenance-orders/{order_id_3}", headers=headers)
        order = r.json()["data"]
        
        test_results.append(print_result(
            "开始处理成功",
            True,
            f"工单状态: {order['status']}"
        ))
        test_results.append(print_result(
            f"处理人姓名已记录: '{order['handler_name']}' (期望: '{current_user['name']}')",
            order['handler_name'] == current_user['name'],
            f"handler_name: {order['handler_name']}"
        ))
    else:
        test_results.append(print_result("开始处理失败", False, result["message"]))
    
    print_section("测试总结")
    passed = sum(1 for r in test_results if r)
    total = len(test_results)
    print(f"\n测试结果: {passed}/{total} 通过")
    
    if passed == total:
        print("\n✓ 所有测试通过！")
        return 0
    else:
        print(f"\n✗ {total - passed} 个测试失败")
        return 1

if __name__ == "__main__":
    sys.exit(main())
