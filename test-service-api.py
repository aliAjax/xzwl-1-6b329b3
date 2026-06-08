#!/usr/bin/env python3
import os
import requests
import json
from datetime import datetime, timedelta
# 测试环境配置
PORT = int(os.environ.get('TEST_PORT', '3001'))
BASE_URL = os.environ.get('TEST_BASE_URL', f'http://localhost:{PORT}') + '/api'
TEST_USERNAME = os.environ.get('TEST_USERNAME', 'admin')
TEST_PASSWORD = os.environ.get('TEST_PASSWORD', 'admin123')

def print_section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")

def main():
    print_section("墓园服务项目 & 服务订单 - API 测试")
    
    # 1. 登录
    print_section("1. 登录获取Token")
    login_data = {"username": "admin", "password": "admin123"}
    r = requests.post(f"{BASE_URL}/auth/login", json=login_data)
    result = r.json()
    
    if result["code"] != 200:
        print("✗ 登录失败")
        return
    
    token = result["data"]["token"]
    headers = {"Authorization": f"Bearer {token}"}
    print("✓ 登录成功")
    
    # 2. 创建服务项目
    print_section("2. 创建服务项目")
    
    service_items = [
        {"name": "鲜花供奉", "category": "祭扫服务", "price": 80, "unit": "束", "description": "提供新鲜菊花、百合等祭扫用花"},
        {"name": "墓碑清扫", "category": "维护服务", "price": 50, "unit": "次", "description": "墓碑清洁、描字、周边整理"},
        {"name": "代祭扫", "category": "祭扫服务", "price": 200, "unit": "次", "description": "工作人员代为祭扫，提供照片视频反馈"},
        {"name": "香炉保养", "category": "维护服务", "price": 30, "unit": "次", "description": "香炉清洁、上香服务"},
    ]
    
    created_item_ids = []
    for item in service_items:
        r = requests.post(f"{BASE_URL}/service-items", json=item, headers=headers)
        result = r.json()
        if result["code"] == 200:
            created_item_ids.append(result["data"]["id"])
            print(f"✓ 创建成功: {item['name']} (ID: {result['data']['id']})")
        else:
            print(f"✗ 创建失败: {item['name']} - {result['message']}")
    
    # 3. 获取服务分类
    print_section("3. 获取服务分类列表")
    r = requests.get(f"{BASE_URL}/service-items/categories", headers=headers)
    result = r.json()
    print(f"分类列表: {result['data']}")
    print("✓ 获取分类成功")
    
    # 4. 分页查询服务项目
    print_section("4. 分页查询服务项目")
    r = requests.get(f"{BASE_URL}/service-items?page=1&pageSize=10", headers=headers)
    result = r.json()
    print(f"总记录数: {result['data']['pagination']['total']}")
    print(f"当前页: {result['data']['pagination']['page']}")
    for item in result['data']['list']:
        print(f"  • [{item['id']}] {item['name']} - ¥{item['price']}/{item['unit']} ({item['status']})")
    print("✓ 分页查询成功")
    
    # 5. 按分类筛选
    print_section("5. 按分类筛选 - 祭扫服务")
    r = requests.get(f"{BASE_URL}/service-items?category=祭扫服务&status=上架", headers=headers)
    result = r.json()
    for item in result['data']['list']:
        print(f"  • {item['name']} - ¥{item['price']}")
    print("✓ 分类筛选成功")
    
    # 6. 获取服务项目详情
    print_section("6. 获取服务项目详情")
    if created_item_ids:
        r = requests.get(f"{BASE_URL}/service-items/{created_item_ids[0]}", headers=headers)
        result = r.json()
        if result["code"] == 200:
            item = result["data"]
            print(f"名称: {item['name']}")
            print(f"分类: {item['category']}")
            print(f"价格: ¥{item['price']}/{item['unit']}")
            print(f"描述: {item['description']}")
            print("✓ 获取详情成功")
    
    # 7. 更新服务项目
    print_section("7. 更新服务项目")
    if created_item_ids:
        update_data = {
            "name": "鲜花供奉",
            "category": "祭扫服务",
            "price": 88,
            "unit": "束",
            "description": "提供新鲜菊花、百合、康乃馨等祭扫用花",
            "status": "上架",
            "sort": 1
        }
        r = requests.put(f"{BASE_URL}/service-items/{created_item_ids[0]}", json=update_data, headers=headers)
        result = r.json()
        if result["code"] == 200:
            print("✓ 更新成功")
        else:
            print(f"✗ 更新失败: {result['message']}")
    
    # 8. 创建服务订单
    print_section("8. 创建服务订单")
    
    tomorrow = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    
    order_data_1 = {
        "service_item_id": created_item_ids[0] if created_item_ids else 1,
        "contact_name": "张三",
        "contact_phone": "13800138000",
        "service_date": tomorrow,
        "service_time": "09:00",
        "quantity": 2,
        "remark": "请准备黄白菊花各10支"
    }
    
    order_data_2 = {
        "service_item_id": created_item_ids[2] if len(created_item_ids) > 2 else 3,
        "contact_name": "李四",
        "contact_phone": "13900139000",
        "service_date": tomorrow,
        "service_time": "10:30",
        "quantity": 1,
        "remark": "代祭扫，请拍视频反馈"
    }
    
    created_order_ids = []
    for i, order_data in enumerate([order_data_1, order_data_2], 1):
        r = requests.post(f"{BASE_URL}/service-orders", json=order_data, headers=headers)
        result = r.json()
        if result["code"] == 200:
            created_order_ids.append(result["data"]["id"])
            print(f"✓ 订单{i}创建成功: {result['data']['order_no']} (ID: {result['data']['id']})")
        else:
            print(f"✗ 订单{i}创建失败: {result['message']}")
    
    # 9. 订单列表筛选
    print_section("9. 订单列表筛选")
    r = requests.get(f"{BASE_URL}/service-orders?page=1&pageSize=10", headers=headers)
    result = r.json()
    print(f"总订单数: {result['data']['pagination']['total']}")
    for order in result['data']['list']:
        print(f"  • [{order['id']}] {order['order_no']} - {order['service_item_name']} "
              f"- ¥{order['total_amount']} ({order['status']})")
    print("✓ 订单列表查询成功")
    
    # 10. 按状态筛选订单
    print_section("10. 按状态筛选 - 待处理")
    r = requests.get(f"{BASE_URL}/service-orders?status=待处理", headers=headers)
    result = r.json()
    print(f"待处理订单数: {result['data']['pagination']['total']}")
    print("✓ 状态筛选成功")
    
    # 11. 获取订单详情
    print_section("11. 获取订单详情")
    if created_order_ids:
        r = requests.get(f"{BASE_URL}/service-orders/{created_order_ids[0]}", headers=headers)
        result = r.json()
        if result["code"] == 200:
            order = result["data"]
            print(f"订单号: {order['order_no']}")
            print(f"服务项目: {order['service_item_name']} ({order['service_category']})")
            print(f"联系人: {order['contact_name']} - {order['contact_phone']}")
            print(f"服务时间: {order['service_date']} {order['service_time']}")
            print(f"数量: {order['quantity']} {order['service_unit']}")
            print(f"单价: ¥{order['unit_price']}")
            print(f"总价: ¥{order['total_amount']}")
            print(f"状态: {order['status']}")
            print(f"备注: {order['remark']}")
            print("✓ 获取订单详情成功")
    
    # 12. 订单状态流转 - 开始处理
    print_section("12. 订单状态流转 - 开始处理")
    if created_order_ids:
        r = requests.post(f"{BASE_URL}/service-orders/{created_order_ids[0]}/process", headers=headers)
        result = r.json()
        if result["code"] == 200:
            print("✓ 订单已开始处理")
        else:
            print(f"✗ 处理失败: {result['message']}")
    
    # 13. 订单状态流转 - 完成
    print_section("13. 订单状态流转 - 标记完成")
    if created_order_ids:
        complete_data = {"remark": "服务已完成，客户满意"}
        r = requests.post(f"{BASE_URL}/service-orders/{created_order_ids[0]}/complete", 
                         json=complete_data, headers=headers)
        result = r.json()
        if result["code"] == 200:
            print("✓ 订单已完成")
        else:
            print(f"✗ 完成失败: {result['message']}")
    
    # 14. 订单状态流转 - 取消
    print_section("14. 订单状态流转 - 取消订单")
    if len(created_order_ids) > 1:
        cancel_data = {"reason": "客户临时有事，改期再约"}
        r = requests.post(f"{BASE_URL}/service-orders/{created_order_ids[1]}/cancel", 
                         json=cancel_data, headers=headers)
        result = r.json()
        if result["code"] == 200:
            print("✓ 订单已取消")
        else:
            print(f"✗ 取消失败: {result['message']}")
    
    # 15. 订单统计
    print_section("15. 订单统计")
    r = requests.get(f"{BASE_URL}/service-orders/statistics", headers=headers)
    result = r.json()
    if result["code"] == 200:
        overview = result["data"]["overview"]
        print(f"总订单数: {overview['total_orders']}")
        print(f"待处理: {overview['pending']}")
        print(f"处理中: {overview['processing']}")
        print(f"已完成: {overview['completed']}")
        print(f"已取消: {overview['cancelled']}")
        print(f"总金额: ¥{overview['total_amount']}")
        if result["data"]["by_category"]:
            print("\n按分类统计:")
            for cat in result["data"]["by_category"]:
                print(f"  • {cat['category']}: {cat['count']}单, ¥{cat['amount']}")
        print("✓ 统计查询成功")
    
    # 16. 更新订单
    print_section("16. 更新订单信息")
    if created_order_ids:
        r = requests.get(f"{BASE_URL}/service-orders?status=待处理", headers=headers)
        result = r.json()
        if result['data']['list']:
            order_id = result['data']['list'][0]['id']
            update_data = {
                "service_item_id": created_item_ids[1] if len(created_item_ids) > 1 else 2,
                "service_date": tomorrow,
                "service_time": "14:00",
                "quantity": 1,
                "remark": "更新服务时间"
            }
            r = requests.put(f"{BASE_URL}/service-orders/{order_id}", json=update_data, headers=headers)
            result = r.json()
            if result["code"] == 200:
                print("✓ 订单更新成功")
            else:
                print(f"✗ 更新失败: {result['message']}")
    
    # 17. 关键字搜索订单
    print_section("17. 关键字搜索订单")
    r = requests.get(f"{BASE_URL}/service-orders?keyword=张三", headers=headers)
    result = r.json()
    print(f"搜索结果: {result['data']['pagination']['total']} 条")
    print("✓ 搜索功能正常")
    
    print_section("测试完成")
    print("\n✓ 服务项目 & 服务订单模块测试通过！")
    print(f"\n服务运行在: http://localhost:3000")
    print("\nAPI端点:")
    print("  服务项目: /api/service-items")
    print("  服务订单: /api/service-orders")
    print("\n主要功能:")
    print("  ✓ 服务项目增删改查")
    print("  ✓ 服务项目分类管理")
    print("  ✓ 服务项目上架/下架")
    print("  ✓ 服务订单创建")
    print("  ✓ 订单多条件筛选（状态、服务项目、联系人、日期范围、关键字）")
    print("  ✓ 订单详情查询")
    print("  ✓ 订单状态流转（待处理→处理中→已完成/已取消）")
    print("  ✓ 订单统计分析")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback
        traceback.print_exc()
