#!/usr/bin/env python3
import requests
import json

BASE_URL = "http://localhost:3000/api"

def print_section(title):
    print(f"\n{'='*50}")
    print(f"  {title}")
    print(f"{'='*50}")

def main():
    print_section("墓园管理系统 - API 测试")
    
    # 1. 登录
    print_section("1. 登录测试")
    login_data = {"username": "admin", "password": "admin123"}
    r = requests.post(f"{BASE_URL}/auth/login", json=login_data)
    result = r.json()
    print(f"状态码: {r.status_code}")
    print(f"响应: {json.dumps(result, ensure_ascii=False, indent=2)[:300]}...")
    
    if result["code"] != 200:
        print("✗ 登录失败")
        return
    
    token = result["data"]["token"]
    headers = {"Authorization": f"Bearer {token}"}
    print("✓ 登录成功")
    
    # 2. 用户信息
    print_section("2. 获取当前用户信息")
    r = requests.get(f"{BASE_URL}/users/me", headers=headers)
    result = r.json()
    print(f"用户: {result['data']['name']}")
    print(f"角色: {result['data']['role']}")
    print("✓ 获取用户信息成功")
    
    # 3. 墓位统计
    print_section("3. 墓位统计")
    r = requests.get(f"{BASE_URL}/plots/statistics", headers=headers)
    result = r.json()
    overall = result["data"]["overall"]
    print(f"总墓位数: {overall['total']}")
    print(f"空闲: {overall['available']}")
    print(f"已占用: {overall['occupied']}")
    print(f"维修中: {overall['maintenance']}")
    print(f"使用率: {overall['occupancyRate']}")
    print("✓ 墓位统计正常")
    
    # 4. 区域占用情况
    print_section("4. A区占用情况")
    r = requests.get(f"{BASE_URL}/plots/area/A%E5%8C%BA/occupancy", headers=headers)
    result = r.json()
    stats = result["data"]["statistics"]
    print(f"区域: {result['data']['area']}")
    print(f"总数: {stats['total']}")
    print(f"已占用: {stats['occupied']}")
    print(f"空闲: {stats['available']}")
    print(f"使用率: {stats['occupancyRate']}")
    print("✓ 区域查询正常")
    
    # 5. 缴费到期提醒
    print_section("5. 缴费到期提醒 (60天内)")
    r = requests.get(f"{BASE_URL}/payments/reminders?days=60", headers=headers)
    result = r.json()
    stats = result["data"]["statistics"]
    print(f"逾期: {stats['overdue']} 条")
    print(f"即将到期: {stats['upcoming']} 条")
    print(f"总计: {stats['total']} 条")
    if result["data"]["list"]:
        print("\n前3条记录:")
        for item in result["data"]["list"][:3]:
            urgency = item["urgency"]
            print(f"  • {item['plot_number']} - {item['contact_name']}")
            print(f"    到期日: {item['due_date']} ({urgency})")
            print(f"    金额: ¥{item['amount']}")
    print("✓ 到期提醒正常")
    
    # 6. 今日预约
    print_section("6. 今日预约")
    r = requests.get(f"{BASE_URL}/appointments/today", headers=headers)
    result = r.json()
    stats = result["data"]["statistics"]
    print(f"今日预约总数: {stats['total']} 条")
    print(f"已确认: {stats['confirmed']} 条")
    print(f"待确认: {stats['pending']} 条")
    print(f"预计人数: {stats['total_people']} 人")
    print("✓ 预约查询正常")
    
    # 7. 待跟进记录
    print_section("7. 待跟进记录 (7天内)")
    r = requests.get(f"{BASE_URL}/visit-records/followup?days=7", headers=headers)
    result = r.json()
    stats = result["data"]["statistics"]
    print(f"待跟进: {stats['upcoming']} 条")
    print(f"已逾期: {stats['overdue']} 条")
    print("✓ 待跟进查询正常")
    
    # 8. 缴费统计
    print_section("8. 缴费统计")
    r = requests.get(f"{BASE_URL}/payments/statistics", headers=headers)
    result = r.json()
    summary = result["data"]["summary"]
    print(f"年度: {result['data']['year']}")
    print(f"已收费用: ¥{summary['totalPaid']}")
    print(f"未缴费用: ¥{summary['totalUnpaid']}")
    print(f"逾期金额: ¥{summary['overdueAmount']}")
    print("✓ 缴费统计正常")
    
    # 9. 沟通统计
    print_section("9. 沟通记录统计")
    r = requests.get(f"{BASE_URL}/visit-records/statistics", headers=headers)
    result = r.json()
    summary = result["data"]["summary"]
    print(f"统计周期: {result['data']['period']['start']} 至 {result['data']['period']['end']}")
    print(f"总记录: {summary['total']} 条")
    print(f"来访: {summary['visit_count']} 次")
    print(f"电话: {summary['call_count']} 次")
    print(f"待跟进: {summary['pending']} 条")
    print("✓ 沟通统计正常")
    
    print_section("测试完成")
    print("\n✓ 所有核心接口测试通过！")
    print(f"\n服务运行在: http://localhost:3000")
    print("\n默认账户:")
    print("  管理员: admin / admin123")
    print("  员工:   staff / staff123")
    print("\n详细API文档请查看: README.md")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback
        traceback.print_exc()
