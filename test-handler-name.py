#!/usr/bin/env python3
import os
import requests
import json
import sys
import time
# 测试环境配置
PORT = int(os.environ.get('TEST_PORT', '3001'))
BASE_URL = os.environ.get('TEST_BASE_URL', f'http://localhost:{PORT}') + '/api'
TEST_USERNAME = os.environ.get('TEST_USERNAME', 'admin')
TEST_PASSWORD = os.environ.get('TEST_PASSWORD', 'admin123')

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
    suffix = str(int(time.time() * 1000))
    row_number = int(suffix)
    
    print_section("测试1: 创建测试墓位")
    r = requests.post(f"{BASE_URL}/plots", headers=headers, json={
        "plot_number": f"TEST-HANDLER-001-{suffix}",
        "area": "测试区",
        "row": row_number,
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
        test_results.append(print_result("创建墓位失败", False, result["message"]))
        return
    
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
        requests.post(f"{BASE_URL}/maintenance-orders/{order_id}/cancel", headers=headers, json={
            "remark": "默认处理人姓名测试清理"
        })
    else:
        test_results.append(print_result("创建工单失败", False, result["message"]))
        return
    
    print_section("测试3: 创建工单指定处理人ID - 应自动获取姓名")
    r = requests.post(f"{BASE_URL}/plots", headers=headers, json={
        "plot_number": f"TEST-HANDLER-002-{suffix}",
        "area": "测试区",
        "row": row_number,
        "col": 2,
        "status": "空闲",
        "type": "单穴",
        "price": 10000
    })
    result = r.json()
    if result["code"] == 200:
        plot_id_2 = result["data"]["id"]
    else:
        test_results.append(print_result("创建第二个墓位失败", False, result["message"]))
        return
    
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
        requests.post(f"{BASE_URL}/maintenance-orders/{order_id_2}/cancel", headers=headers, json={
            "remark": "指定处理人姓名测试清理"
        })
    else:
        test_results.append(print_result("创建工单失败", False, result["message"]))
        return
    
    print_section("测试4: 开始处理时补齐处理人姓名")
    r = requests.post(f"{BASE_URL}/plots", headers=headers, json={
        "plot_number": f"TEST-HANDLER-003-{suffix}",
        "area": "测试区",
        "row": row_number,
        "col": 3,
        "status": "空闲",
        "type": "单穴",
        "price": 10000
    })
    result = r.json()
    if result["code"] == 200:
        plot_id_3 = result["data"]["id"]
    else:
        test_results.append(print_result("创建第三个墓位失败", False, result["message"]))
        return
    
    r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
        "plot_id": plot_id_3,
        "reason": "测试开始处理时补齐姓名",
        "handler_id": current_user['id']
    })
    result = r.json()
    if result["code"] != 200:
        test_results.append(print_result("创建待处理工单失败", False, result["message"]))
        return
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
        requests.post(f"{BASE_URL}/maintenance-orders/{order_id_3}/cancel", headers=headers, json={
            "remark": "开始处理补齐姓名测试清理"
        })
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
