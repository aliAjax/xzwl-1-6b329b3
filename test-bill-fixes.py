#!/usr/bin/env python3
import requests
import json
import sys

BASE_URL = 'http://localhost:3000/api'

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

def test_historical_data_migration(token):
    print('\n=== 测试1: 验证历史数据迁移（bill_year已补充）===')
    response = requests.get(f'{BASE_URL}/payments', headers=headers(token))
    data = response.json()
    records = data['data']['list']
    
    original_history_ids = [1, 2, 3, 4, 5]
    original_records = [r for r in records if r['id'] in original_history_ids]
    
    all_records_have_bill_year = all(r.get('bill_year') is not None for r in records)
    all_records_have_bill_type = all(r.get('bill_type') is not None for r in records)
    original_are_manual = all(r.get('bill_type') == 'manual' for r in original_records)
    
    print(f'总记录数: {len(records)}')
    print(f'原始历史记录数: {len(original_records)}')
    print(f'所有记录有bill_year: {all_records_have_bill_year}')
    print(f'所有记录有bill_type: {all_records_have_bill_type}')
    print(f'原始历史记录都是manual: {original_are_manual}')
    
    for r in records:
        print(f'  ID:{r["id"]} plot_id:{r["plot_id"]} bill_type:{r.get("bill_type")} bill_year:{r.get("bill_year")} start_date:{r.get("start_date")} due_date:{r.get("due_date")}')
    
    assert all_records_have_bill_year, '存在 bill_year 为空的记录'
    assert all_records_have_bill_type, '存在 bill_type 为空的记录'
    assert original_are_manual, '原始历史记录 bill_type 应为 manual'
    print('✓ 历史数据迁移验证通过')

def test_manual_payment_duplicate_check(token):
    print('\n=== 测试2: 验证手工录入同年度账单去重 ===')
    
    response = requests.post(f'{BASE_URL}/payments', headers=headers(token), json={
        'plot_id': 1,
        'contact_id': 1,
        'amount': 200,
        'start_date': '2026-01-01',
        'due_date': '2026-12-31',
        'status': '未缴',
        'remark': '测试手工录入同年度账单'
    })
    
    print(f'状态码: {response.status_code}')
    print(f'响应: {json.dumps(response.json(), ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 400, '应该返回400错误提示重复'
    assert '已存在' in response.json()['message'], '错误信息应包含"已存在"'
    assert '系统生成' in response.json()['message'], '错误信息应说明是"系统生成"的账单'
    print('✓ 手工录入同年度去重验证通过')

def test_bill_generation_skips_manual(token):
    print('\n=== 测试3: 验证系统生成账单时跳过已存在的手工账单 ===')
    
    response = requests.post(f'{BASE_URL}/bills/preview', headers=headers(token), json={
        'bill_year': 2026,
        'fee_standard': 200,
        'plot_ids': [6]
    })
    data = response.json()
    
    print(f'总墓位数: {data["data"]["total_count"]}')
    print(f'跳过数: {data["data"]["skip_count"]}')
    print(f'异常列表: {json.dumps(data["data"]["exception_list"], ensure_ascii=False, indent=2)}')
    
    assert data["data"]["skip_count"] >= 1, '应该跳过（墓位6已有2026年手工账单）'
    
    manual_skip_found = any(
        '手工录入' in exc["error_message"] 
        for exc in data["data"]["exception_list"]
    )
    assert manual_skip_found, '异常信息应说明是手工录入的账单'
    print('✓ 系统生成账单跳过手工账单验证通过')

def test_duplicate_check_both_types(token):
    print('\n=== 测试4: 验证去重逻辑同时检查system和manual类型 ===')
    
    response = requests.post(f'{BASE_URL}/bills/preview', headers=headers(token), json={
        'bill_year': 2026,
        'fee_standard': 200
    })
    data = response.json()
    
    print(f'总墓位数: {data["data"]["total_count"]}')
    print(f'待生成数: {data["data"]["to_generate_count"]}')
    print(f'跳过数: {data["data"]["skip_count"]}')
    
    for exc in data["data"]["exception_list"]:
        print(f'  {exc["plot_number"]}: {exc["error_message"]}')
    
    assert data["data"]["skip_count"] >= 1, '应该跳过已存在的账单'
    print('✓ 去重逻辑同时检查两种类型验证通过')

def test_create_manual_infers_bill_year(token):
    print('\n=== 测试5: 验证手工录入自动推断bill_year ===')
    
    response = requests.post(f'{BASE_URL}/payments', headers=headers(token), json={
        'plot_id': 2,
        'contact_id': 2,
        'amount': 200,
        'start_date': '2027-01-01',
        'due_date': '2027-12-31',
        'status': '未缴',
        'remark': '测试自动推断bill_year'
    })
    
    print(f'状态码: {response.status_code}')
    print(f'响应: {json.dumps(response.json(), ensure_ascii=False, indent=2)}')
    assert response.status_code == 200, '应该创建成功'
    
    payment_id = response.json()['data']['id']
    
    response = requests.get(f'{BASE_URL}/payments/{payment_id}', headers=headers(token))
    data = response.json()
    print(f'新记录 bill_year: {data["data"]["bill_year"]}')
    print(f'新记录 bill_type: {data["data"]["bill_type"]}')
    
    assert data["data"]["bill_year"] == 2027, '应自动推断 bill_year 为 2027'
    assert data["data"]["bill_type"] == 'manual', 'bill_type 应为 manual'
    print('✓ 手工录入自动推断bill_year验证通过')

def test_duplicate_prevents_both_ways(token):
    print('\n=== 测试6: 验证双向去重（手工→系统，系统→手工）===')
    
    print('先验证：已存在手工账单时，系统生成会跳过')
    response = requests.post(f'{BASE_URL}/bills/preview', headers=headers(token), json={
        'bill_year': 2027,
        'fee_standard': 200,
        'plot_ids': [2]
    })
    data = response.json()
    assert data["data"]["skip_count"] == 1, '墓位2已有2027年手工账单，应该跳过'
    print('  ✓ 手工账单存在时，系统生成跳过')
    
    print('再验证：已存在系统账单时，手工录入会拒绝')
    response = requests.post(f'{BASE_URL}/bills/generate', headers=headers(token), json={
        'bill_year': 2028,
        'fee_standard': 200,
        'plot_ids': [1]
    })
    assert response.status_code == 200, '生成2028年账单应该成功'
    
    response = requests.post(f'{BASE_URL}/payments', headers=headers(token), json={
        'plot_id': 1,
        'contact_id': 1,
        'amount': 200,
        'start_date': '2028-01-01',
        'due_date': '2028-12-31',
        'status': '未缴',
        'remark': '测试系统账单存在时手工录入'
    })
    print(f'状态码: {response.status_code}')
    print(f'响应: {json.dumps(response.json(), ensure_ascii=False, indent=2)}')
    assert response.status_code == 400, '应该拒绝重复录入'
    assert '系统生成' in response.json()['message'], '错误信息应说明是系统生成'
    print('  ✓ 系统账单存在时，手工录入拒绝')
    
    print('✓ 双向去重验证通过')

if __name__ == '__main__':
    print('=== 缴费账单生成模块修复验证 ===')
    
    token = login()
    print(f'登录成功，Token: {token[:20]}...')

    try:
        test_historical_data_migration(token)
        test_manual_payment_duplicate_check(token)
        test_bill_generation_skips_manual(token)
        test_duplicate_check_both_types(token)
        test_create_manual_infers_bill_year(token)
        test_duplicate_prevents_both_ways(token)
        
        print('\n' + '='*60)
        print('✅ 所有修复验证测试通过！')
        print('='*60)
        print('\n修复总结：')
        print('1. 历史数据迁移：已为所有历史记录补充 bill_type 和 bill_year')
        print('2. 去重逻辑：同时检查 system 和 manual 类型的账单')
        print('3. 异常提示：明确说明重复账单的类型（手工录入/系统生成）')
        print('4. 自动推断：手工录入时根据 start_date/due_date 自动推断 bill_year')
        print('5. 双向去重：手工→系统，系统→手工 都能正确拦截重复')
        
    except AssertionError as e:
        print(f'\n❌ 测试失败: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)
    except Exception as e:
        print(f'\n❌ 发生错误: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)
