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

def login():
    response = requests.post(f'{BASE_URL}/auth/login', json={
        'username': 'admin',
        'password': 'admin123'
    })
    if response.status_code == 200:
        return response.json()['data']['token']
    else:
        print(f'登录失败: {response.text}')
        sys.exit(1)

def headers(token):
    return {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    }

def test_config(token):
    print('\n=== 测试获取收费标准配置 ===')
    response = requests.get(f'{BASE_URL}/bills/config', headers=headers(token))
    print(f'状态码: {response.status_code}')
    print(f'响应: {json.dumps(response.json(), ensure_ascii=False, indent=2)}')
    assert response.status_code == 200
    assert 'default_annual_fee' in response.json()['data']
    print('✓ 获取配置成功')

def test_update_config(token):
    print('\n=== 测试更新收费标准配置 ===')
    response = requests.put(f'{BASE_URL}/bills/config', headers=headers(token), json={
        'default_annual_fee': 200
    })
    print(f'状态码: {response.status_code}')
    print(f'响应: {json.dumps(response.json(), ensure_ascii=False, indent=2)}')
    assert response.status_code == 200
    assert response.json()['data']['default_annual_fee'] == 200
    print('✓ 更新配置成功')

def test_preview(token):
    print('\n=== 测试账单预览 ===')
    response = requests.post(f'{BASE_URL}/bills/preview', headers=headers(token), json={
        'bill_year': 2026,
        'fee_standard': 200
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'总墓位数: {data["data"]["total_count"]}')
    print(f'待生成数: {data["data"]["to_generate_count"]}')
    print(f'跳过数: {data["data"]["skip_count"]}')
    print(f'异常数: {data["data"]["error_count"]}')
    if data['data']['preview_list']:
        print(f'预览示例: {json.dumps(data["data"]["preview_list"][0], ensure_ascii=False, indent=2)}')
    if data['data']['exception_list']:
        print(f'异常示例: {json.dumps(data["data"]["exception_list"][0], ensure_ascii=False, indent=2)}')
    assert response.status_code == 200
    print('✓ 预览成功')

def test_generate(token):
    print('\n=== 测试账单生成 ===')
    response = requests.post(f'{BASE_URL}/bills/generate', headers=headers(token), json={
        'bill_year': 2026,
        'fee_standard': 200,
        'remark': '2026年度管理费批量生成'
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    assert response.status_code == 200
    assert 'batch_id' in data['data']
    assert 'batch_no' in data['data']
    print('✓ 生成成功')
    return data['data']['batch_id']

def test_generate_duplicate(token):
    print('\n=== 测试重复生成（去重验证） ===')
    response = requests.post(f'{BASE_URL}/bills/generate', headers=headers(token), json={
        'bill_year': 2026,
        'fee_standard': 200
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'总墓位数: {data["data"]["total_count"]}')
    print(f'成功生成: {data["data"]["success_count"]}')
    print(f'跳过（重复）: {data["data"]["skip_count"]}')
    assert response.status_code == 200
    assert data['data']['success_count'] == 0
    assert data['data']['skip_count'] > 0
    print('✓ 去重机制生效')

def test_get_batches(token):
    print('\n=== 测试批次列表查询 ===')
    response = requests.get(f'{BASE_URL}/bills/batches', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'批次总数: {data["data"]["pagination"]["total"]}')
    if data['data']['list']:
        print(f'最新批次: {json.dumps(data["data"]["list"][0], ensure_ascii=False, indent=2)}')
    assert response.status_code == 200
    print('✓ 批次列表查询成功')

def test_get_batch_detail(token, batch_id):
    print(f'\n=== 测试批次详情查询 (ID: {batch_id}) ===')
    response = requests.get(f'{BASE_URL}/bills/batches/{batch_id}', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'批次信息: {json.dumps(data["data"]["batch"], ensure_ascii=False, indent=2)}')
    print(f'生成账单数: {len(data["data"]["generated_bills"])}')
    print(f'异常数: {len(data["data"]["exceptions"])}')
    if data['data']['generated_bills']:
        print(f'账单示例: {json.dumps(data["data"]["generated_bills"][0], ensure_ascii=False, indent=2)}')
    if data['data']['exceptions']:
        print(f'异常示例: {json.dumps(data["data"]["exceptions"][0], ensure_ascii=False, indent=2)}')
    assert response.status_code == 200
    print('✓ 批次详情查询成功')

def test_get_batch_detail_enhanced(token, batch_id):
    print(f'\n=== 测试批次详情增强字段 (ID: {batch_id}) ===')
    response = requests.get(f'{BASE_URL}/bills/batches/{batch_id}', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    assert response.status_code == 200
    
    assert 'success_bills' in data['data']
    assert 'skip_items' in data['data']
    assert 'error_items' in data['data']
    assert 'unresolved_error_items' in data['data']
    assert 'resolved_error_items' in data['data']
    assert 'summary' in data['data']
    
    summary = data['data']['summary']
    print(f'汇总信息: {json.dumps(summary, ensure_ascii=False, indent=2)}')
    
    assert 'total_amount' in summary
    assert 'success_amount' in summary
    assert 'skip_amount' in summary
    assert 'error_amount' in summary
    assert 'resolved_amount' in summary
    assert 'unresolved_error_count' in summary
    assert 'resolved_error_count' in summary
    
    print(f'总金额: {summary["total_amount"]}')
    print(f'成功金额: {summary["success_amount"]}')
    print(f'跳过金额: {summary["skip_amount"]}')
    print(f'待解决异常金额: {summary["error_amount"]}')
    print(f'已解决异常金额: {summary["resolved_amount"]}')
    
    print('✓ 批次详情增强字段验证成功')

def test_retry_exceptions(token, batch_id):
    print(f'\n=== 测试重试异常项 (ID: {batch_id}) ===')
    response = requests.post(f'{BASE_URL}/bills/batches/{batch_id}/retry', headers=headers(token), json={
        'remark': '重试异常账单'
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    assert response.status_code == 200
    
    retry_total = data['data'].get('total_retry_count', data['data'].get('retry_count', 0))
    retry_success = data['data'].get('retry_success_count', data['data'].get('success_count', 0))
    retry_error = data['data'].get('retry_error_count', data['data'].get('error_count', 0))

    print(f'重试总数: {retry_total}')
    print(f'重试成功: {retry_success}')
    print(f'重试失败: {retry_error}')
    print('✓ 重试异常项接口正常')

def test_existing_payments(token):
    print('\n=== 验证现有缴费接口兼容性 ===')
    response = requests.get(f'{BASE_URL}/payments', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'缴费记录总数: {data["data"]["pagination"]["total"]}')
    if data['data']['list']:
        first = data['data']['list'][0]
        print(f'记录包含新字段: bill_type={first.get("bill_type")}, bill_year={first.get("bill_year")}')
    assert response.status_code == 200
    print('✓ 现有缴费列表接口正常')

def test_existing_reminders(token):
    print('\n=== 验证到期提醒接口兼容性 ===')
    response = requests.get(f'{BASE_URL}/payments/reminders', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'到期提醒总数: {data["data"]["statistics"]["total"]}')
    assert response.status_code == 200
    print('✓ 到期提醒接口正常')

def test_existing_overdue(token):
    print('\n=== 验证逾期统计接口兼容性 ===')
    response = requests.get(f'{BASE_URL}/payments/overdue', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'逾期总数: {data["data"]["statistics"]["count"]}')
    print(f'逾期总金额: {data["data"]["statistics"]["totalAmount"]}')
    assert response.status_code == 200
    print('✓ 逾期统计接口正常')

def test_create_manual_payment(token):
    print('\n=== 测试手工创建缴费记录 ===')
    response = requests.post(f'{BASE_URL}/payments', headers=headers(token), json={
        'plot_id': 1,
        'contact_id': 1,
        'amount': 300,
        'start_date': '2029-01-01',
        'due_date': '2029-12-31',
        'status': '未缴',
        'remark': '手工录入测试'
    })
    print(f'状态码: {response.status_code}')
    print(f'响应: {json.dumps(response.json(), ensure_ascii=False, indent=2)}')
    assert response.status_code == 200
    print('✓ 手工创建缴费记录成功')

def test_preview_with_area(token):
    print('\n=== 测试按区域预览 ===')
    response = requests.post(f'{BASE_URL}/bills/preview', headers=headers(token), json={
        'bill_year': 2027,
        'fee_standard': 200,
        'area': 'A区'
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'A区墓位数: {data["data"]["total_count"]}')
    assert response.status_code == 200
    print('✓ 按区域预览成功')

def test_preview_with_plot_ids(token):
    print('\n=== 测试按指定墓位预览 ===')
    response = requests.post(f'{BASE_URL}/bills/preview', headers=headers(token), json={
        'bill_year': 2027,
        'fee_standard': 200,
        'plot_ids': [1, 2, 6]
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'指定墓位数: {data["data"]["total_count"]}')
    assert response.status_code == 200
    print('✓ 按指定墓位预览成功')

if __name__ == '__main__':
    print('=== 缴费账单生成模块测试 ===')
    
    token = login()
    print(f'登录成功，Token: {token[:20]}...')

    try:
        test_config(token)
        test_update_config(token)
        test_preview(token)
        test_preview_with_area(token)
        test_preview_with_plot_ids(token)
        
        batch_id = test_generate(token)
        test_generate_duplicate(token)
        
        test_get_batches(token)
        test_get_batch_detail(token, batch_id)
        test_get_batch_detail_enhanced(token, batch_id)
        test_retry_exceptions(token, batch_id)
        
        test_existing_payments(token)
        test_existing_reminders(token)
        test_existing_overdue(token)
        
        test_create_manual_payment(token)
        
        print('\n' + '='*50)
        print('✅ 所有测试通过！')
        print('='*50)
        
    except AssertionError as e:
        print(f'\n❌ 测试失败: {e}')
        sys.exit(1)
    except Exception as e:
        print(f'\n❌ 发生错误: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)
