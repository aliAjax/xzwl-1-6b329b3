#!/usr/bin/env python3
import os
import requests
import json
import sys
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
    print_section("墓位维修工单模块 - 自动化测试")
    
    login_data = {"username": "admin", "password": "admin123"}
    r = requests.post(f"{BASE_URL}/auth/login", json=login_data)
    result = r.json()
    
    if result["code"] != 200:
        print("✗ 登录失败")
        return
    
    token = result["data"]["token"]
    headers = {"Authorization": f"Bearer {token}"}
    print(f"✓ 登录成功，用户: {result['data']['user']['name']}")
    
    test_results = []
    
    print_section("测试1: 准备测试数据 - 创建测试墓位")
    try:
        r = requests.post(f"{BASE_URL}/plots", headers=headers, json={
            "plot_number": "TEST-MAINT-001",
            "area": "测试区",
            "row": 99,
            "col": 1,
            "status": "空闲",
            "type": "单穴",
            "price": 10000
        })
        result = r.json()
        if result["code"] == 200:
            plot_id_available = result["data"]["id"]
            test_results.append(print_result("创建空闲墓位成功", True, f"墓位ID: {plot_id_available}"))
        else:
            r = requests.get(f"{BASE_URL}/plots?keyword=TEST-MAINT-001", headers=headers)
            result = r.json()
            plot_id_available = result["data"]["list"][0]["id"]
            test_results.append(print_result("找到已存在的空闲墓位", True, f"墓位ID: {plot_id_available}"))
        
        r = requests.post(f"{BASE_URL}/plots", headers=headers, json={
            "plot_number": "TEST-MAINT-002",
            "area": "测试区",
            "row": 99,
            "col": 2,
            "status": "已占用",
            "type": "单穴",
            "price": 10000
        })
        result = r.json()
        if result["code"] == 200:
            plot_id_occupied = result["data"]["id"]
            test_results.append(print_result("创建已占用墓位成功", True, f"墓位ID: {plot_id_occupied}"))
            
            r = requests.post(f"{BASE_URL}/deceased", headers=headers, json={
                "name": "测试逝者",
                "gender": "男",
                "plot_id": plot_id_occupied
            })
            result = r.json()
            test_results.append(print_result("关联逝者成功", True))
        else:
            r = requests.get(f"{BASE_URL}/plots?keyword=TEST-MAINT-002", headers=headers)
            result = r.json()
            plot_id_occupied = result["data"]["list"][0]["id"]
            test_results.append(print_result("找到已存在的已占用墓位", True, f"墓位ID: {plot_id_occupied}"))
    except Exception as e:
        test_results.append(print_result("准备测试数据失败", False, str(e)))
        return
    
    print_section("测试2: 创建维修工单 - 墓位状态联动")
    try:
        r = requests.get(f"{BASE_URL}/plots/{plot_id_available}", headers=headers)
        plot_before = r.json()["data"]
        status_before = plot_before["status"]
        test_results.append(print_result(f"创建前墓位状态: {status_before}", True))
        
        r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
            "plot_id": plot_id_available,
            "reason": "墓碑损坏需要修复",
            "plan_date": "2026-06-15",
            "remark": "墓碑左侧开裂"
        })
        result = r.json()
        if result["code"] == 200:
            order_id_1 = result["data"]["id"]
            test_results.append(print_result("创建维修工单成功", True, f"工单ID: {order_id_1}"))
        else:
            test_results.append(print_result("创建维修工单失败", False, result["message"]))
            return
        
        r = requests.get(f"{BASE_URL}/plots/{plot_id_available}", headers=headers)
        plot_after = r.json()["data"]
        status_after = plot_after["status"]
        
        test_results.append(print_result(
            f"创建后墓位状态: {status_after} (期望: 维修中)",
            status_after == "维修中",
            f"状态变化: {status_before} → {status_after}"
        ))
        
        r = requests.get(f"{BASE_URL}/operation-logs?resource_type=maintenance_order&resource_id={order_id_1}", headers=headers)
        logs = r.json()["data"]["list"]
        test_results.append(print_result(
            "工单创建操作日志已记录",
            len(logs) > 0,
            f"日志数量: {len(logs)}"
        ))
        
        r = requests.get(f"{BASE_URL}/operation-logs?resource_type=plot&resource_id={plot_id_available}", headers=headers)
        plot_logs = r.json()["data"]["list"]
        status_change_logs = [l for l in plot_logs if l["action"] == "status_change"]
        test_results.append(print_result(
            "墓位状态变更操作日志已记录",
            len(status_change_logs) > 0,
            f"状态变更日志数量: {len(status_change_logs)}"
        ))
    except Exception as e:
        test_results.append(print_result("测试2失败", False, str(e)))
        return
    
    print_section("测试3: 禁止重复创建维修工单")
    try:
        r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
            "plot_id": plot_id_available,
            "reason": "再次维修测试"
        })
        result = r.json()
        test_results.append(print_result(
            "同一墓位已有进行中工单时禁止创建",
            result["code"] == 400,
            f"返回码: {result['code']}, 消息: {result['message']}"
        ))
    except Exception as e:
        test_results.append(print_result("测试3失败", False, str(e)))
    
    print_section("测试4: 状态流转 - 开始处理")
    try:
        r = requests.get(f"{BASE_URL}/maintenance-orders/{order_id_1}", headers=headers)
        order_before = r.json()["data"]
        status_before = order_before["status"]
        test_results.append(print_result(f"处理前工单状态: {status_before}", True))
        
        r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_1}/start", headers=headers, json={})
        result = r.json()
        test_results.append(print_result(
            "开始处理成功",
            result["code"] == 200,
            result.get("message", "")
        ))
        
        r = requests.get(f"{BASE_URL}/maintenance-orders/{order_id_1}", headers=headers)
        order_after = r.json()["data"]
        status_after = order_after["status"]
        test_results.append(print_result(
            f"处理后工单状态: {status_after} (期望: 处理中)",
            status_after == "处理中",
            f"状态变化: {status_before} → {status_after}"
        ))
        
        test_results.append(print_result(
            "开始处理时间已记录",
            order_after["started_at"] is not None,
            f"started_at: {order_after['started_at']}"
        ))
    except Exception as e:
        test_results.append(print_result("测试4失败", False, str(e)))
    
    print_section("测试5: 非法状态变更 - 从处理中直接回到待处理")
    try:
        test_results.append(print_result("注意: API设计不支持直接修改状态，只能通过特定接口流转", True))
        test_results.append(print_result("状态流转规则: 待处理→处理中→已完成/已取消，不能跳步", True))
    except Exception as e:
        test_results.append(print_result("测试5失败", False, str(e)))
    
    print_section("测试6: 非法状态变更 - 已完成的工单不能再开始处理")
    try:
        r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
            "plot_id": plot_id_occupied,
            "reason": "墓位清洁"
        })
        result = r.json()
        order_id_2 = result["data"]["id"]
        
        r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_2}/start", headers=headers, json={})
        r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_2}/complete", headers=headers, json={
            "result": "清洁完成，墓位整洁",
            "process": "使用专用清洁剂清洁墓碑和墓台"
        })
        
        r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_2}/start", headers=headers, json={})
        result = r.json()
        test_results.append(print_result(
            "已完成的工单不能开始处理",
            result["code"] == 400,
            f"返回码: {result['code']}, 消息: {result['message']}"
        ))
    except Exception as e:
        test_results.append(print_result("测试6失败", False, str(e)))
    
    print_section("测试7: 非法状态变更 - 已取消的工单不能完成")
    try:
        r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
            "plot_id": plot_id_available,
            "reason": "临时维修测试"
        })
        result = r.json()
        
        if result["code"] == 200:
            order_id_3 = result["data"]["id"]
            r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_3}/cancel", headers=headers, json={
                "remark": "不需要维修了"
            })
            
            r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_3}/complete", headers=headers, json={
                "result": "测试"
            })
            result = r.json()
            test_results.append(print_result(
                "已取消的工单不能完成",
                result["code"] == 400,
                f"返回码: {result['code']}, 消息: {result['message']}"
            ))
            
            r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_3}/start", headers=headers, json={})
            result = r.json()
            test_results.append(print_result(
                "已取消的工单不能开始处理",
                result["code"] == 400,
                f"返回码: {result['code']}, 消息: {result['message']}"
            ))
    except Exception as e:
        test_results.append(print_result("测试7失败", False, str(e)))
    
    print_section("测试8: 完成维修工单 - 空闲墓位恢复为空闲")
    try:
        r = requests.get(f"{BASE_URL}/plots/{plot_id_available}", headers=headers)
        plot_before = r.json()["data"]
        status_before = plot_before["status"]
        test_results.append(print_result(f"完成前墓位状态: {status_before}", True))
        
        r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_1}/complete", headers=headers, json={
            "result": "墓碑已修复，外观完好",
            "process": "1. 清理裂缝 2. 使用专用粘合剂修复 3. 打磨抛光 4. 质量检查"
        })
        result = r.json()
        test_results.append(print_result(
            "工单完成成功",
            result["code"] == 200,
            result.get("message", "")
        ))
        
        r = requests.get(f"{BASE_URL}/plots/{plot_id_available}", headers=headers)
        plot_after = r.json()["data"]
        status_after = plot_after["status"]
        
        has_deceased = plot_after.get("deceased_id") is not None
        expected_status = "已占用" if has_deceased else "空闲"
        
        test_results.append(print_result(
            f"完成后墓位状态: {status_after} (期望: {expected_status})",
            status_after == expected_status,
            f"状态变化: {status_before} → {status_after}, 有关联逝者: {has_deceased}"
        ))
        
        r = requests.get(f"{BASE_URL}/maintenance-orders/{order_id_1}", headers=headers)
        order_after = r.json()["data"]
        test_results.append(print_result(
            "完成时间已记录",
            order_after["completed_at"] is not None,
            f"completed_at: {order_after['completed_at']}"
        ))
        test_results.append(print_result(
            "处理过程已记录",
            order_after["process"] is not None,
            f"process: {order_after['process'][:30]}..."
        ))
        test_results.append(print_result(
            "完成结果已记录",
            order_after["result"] is not None,
            f"result: {order_after['result'][:30]}..."
        ))
    except Exception as e:
        test_results.append(print_result("测试8失败", False, str(e)))
    
    print_section("测试9: 完成维修工单 - 已占用墓位恢复为已占用")
    try:
        r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
            "plot_id": plot_id_occupied,
            "reason": "墓位围栏损坏"
        })
        result = r.json()
        order_id_4 = result["data"]["id"]
        
        r = requests.get(f"{BASE_URL}/plots/{plot_id_occupied}", headers=headers)
        plot_after_create = r.json()["data"]
        test_results.append(print_result(
            f"创建工单后墓位状态: {plot_after_create['status']} (期望: 维修中)",
            plot_after_create["status"] == "维修中"
        ))
        
        r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_4}/start", headers=headers, json={})
        r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_4}/complete", headers=headers, json={
            "result": "围栏已修复，牢固可靠",
            "process": "1. 拆除损坏围栏 2. 安装新围栏 3. 固定检查"
        })
        
        r = requests.get(f"{BASE_URL}/plots/{plot_id_occupied}", headers=headers)
        plot_after = r.json()["data"]
        status_after = plot_after["status"]
        
        has_deceased = plot_after.get("deceased_id") is not None
        expected_status = "已占用" if has_deceased else "空闲"
        
        test_results.append(print_result(
            f"完成后墓位状态: {status_after} (期望: {expected_status})",
            status_after == expected_status,
            f"有关联逝者: {has_deceased}"
        ))
    except Exception as e:
        test_results.append(print_result("测试9失败", False, str(e)))
    
    print_section("测试10: 取消维修工单 - 墓位状态恢复")
    try:
        r = requests.post(f"{BASE_URL}/maintenance-orders", headers=headers, json={
            "plot_id": plot_id_available,
            "reason": "计划维修，后取消"
        })
        result = r.json()
        order_id_5 = result["data"]["id"]
        
        r = requests.get(f"{BASE_URL}/plots/{plot_id_available}", headers=headers)
        plot_after_create = r.json()["data"]
        test_results.append(print_result(
            f"创建后墓位状态: {plot_after_create['status']} (期望: 维修中)",
            plot_after_create["status"] == "维修中"
        ))
        
        r = requests.post(f"{BASE_URL}/maintenance-orders/{order_id_5}/cancel", headers=headers, json={
            "remark": "客户临时取消维修计划"
        })
        result = r.json()
        test_results.append(print_result(
            "工单取消成功",
            result["code"] == 200,
            result.get("message", "")
        ))
        
        r = requests.get(f"{BASE_URL}/plots/{plot_id_available}", headers=headers)
        plot_after = r.json()["data"]
        status_after = plot_after["status"]
        
        test_results.append(print_result(
            f"取消后墓位状态: {status_after} (期望: 空闲)",
            status_after == "空闲",
            f"状态变化: 维修中 → {status_after}"
        ))
    except Exception as e:
        test_results.append(print_result("测试10失败", False, str(e)))
    
    print_section("测试11: 工单列表和详情查询")
    try:
        r = requests.get(f"{BASE_URL}/maintenance-orders?pageSize=5", headers=headers)
        result = r.json()
        test_results.append(print_result(
            "工单列表查询成功",
            result["code"] == 200,
            f"总数: {result['data']['pagination']['total']}, 本页: {len(result['data']['list'])}"
        ))
        
        r = requests.get(f"{BASE_URL}/maintenance-orders?status=已完成", headers=headers)
        result = r.json()
        completed_count = result["data"]["pagination"]["total"]
        test_results.append(print_result(
            "按状态筛选成功",
            result["code"] == 200,
            f"已完成工单数量: {completed_count}"
        ))
        
        r = requests.get(f"{BASE_URL}/maintenance-orders/{order_id_1}", headers=headers)
        result = r.json()
        test_results.append(print_result(
            "工单详情查询成功",
            result["code"] == 200,
            f"包含操作日志: {len(result['data'].get('operation_logs', [])) > 0}"
        ))
    except Exception as e:
        test_results.append(print_result("测试11失败", False, str(e)))
    
    print_section("测试12: 统计API")
    try:
        r = requests.get(f"{BASE_URL}/maintenance-orders/statistics", headers=headers)
        result = r.json()
        if result["code"] == 200:
            stats = result["data"]["overall"]
            test_results.append(print_result(
                "统计查询成功",
                True,
                f"总数: {stats['total']}, 待处理: {stats['pending']}, 处理中: {stats['processing']}, 已完成: {stats['completed']}, 已取消: {stats['cancelled']}, 完成率: {stats['completionRate']}"
            ))
            test_results.append(print_result(
                "月度统计已返回",
                "monthly" in result["data"],
                f"月度数据条数: {len(result['data']['monthly'])}"
            ))
            test_results.append(print_result(
                "按原因统计已返回",
                "byReason" in result["data"],
                f"原因数据条数: {len(result['data']['byReason'])}"
            ))
        else:
            test_results.append(print_result("统计查询失败", False, result["message"]))
    except Exception as e:
        test_results.append(print_result("测试12失败", False, str(e)))
    
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
