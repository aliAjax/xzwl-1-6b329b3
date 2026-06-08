#!/usr/bin/env python3
import requests
import json
import time
from datetime import datetime, timedelta

BASE_URL = 'http://localhost:3000'
TIMESTAMP = str(int(time.time()))

def login(username, password):
    response = requests.post(f'{BASE_URL}/api/auth/login', 
        json={'username': username, 'password': password})
    data = response.json()
    if data.get('code') == 200:
        return data['data']['token']
    raise Exception(f'Login failed: {data}')

def headers(token):
    return {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

def create_test_plot(token, plot_number):
    response = requests.post(f'{BASE_URL}/api/plots', headers=headers(token), json={
        'plot_number': plot_number,
        'area': 'TEST区',
        'row': 88,
        'col': int(plot_number.split('-')[-1]),
        'status': '空闲',
        'type': '单穴',
        'price': 50000
    })
    data = response.json()
    print(f'Create plot {plot_number}:', data.get('message'))
    if data.get('code') != 200:
        response = requests.get(f'{BASE_URL}/api/plots', headers=headers(token), 
            params={'keyword': plot_number, 'pageSize': 1})
        list_data = response.json()
        items = list_data.get('data', {}).get('list', [])
        if items:
            return items[0]['id']
    return data['data']['id'] if data.get('code') == 200 else None

def reserve_plot_with_custom_expiry(token, plot_id, contact_name='测试用户', contact_phone='13800000000', days=7):
    body = {
        'plot_id': plot_id,
        'contact_name': contact_name,
        'contact_phone': contact_phone,
        'reserve_days': days,
        'plot_price': 50000
    }
    response = requests.post(f'{BASE_URL}/api/contracts/reserve', headers=headers(token), json=body)
    data = response.json()
    print(f'Reserve plot {plot_id} for {days} days:', data.get('message'), data.get('data', {}).get('contract_no'))
    assert data.get('code') == 200, f'Failed: {data}'
    return data['data']

def get_contract(token, contract_id):
    response = requests.get(f'{BASE_URL}/api/contracts/{contract_id}', headers=headers(token))
    data = response.json()
    print(f'Get contract {contract_id}: status =', data.get('data', {}).get('status_name'))
    return data.get('data')

def get_plot(token, plot_id):
    response = requests.get(f'{BASE_URL}/api/plots/{plot_id}', headers=headers(token))
    data = response.json()
    print(f'Get plot {plot_id}: status =', data.get('data', {}).get('status'))
    return data.get('data')

def check_plot_availability(token, plot_id):
    response = requests.get(f'{BASE_URL}/api/contracts/check-plot-availability', 
        headers=headers(token), params={'plot_id': plot_id})
    data = response.json()
    print(f'Check availability plot {plot_id}:', data.get('data', {}))
    return data.get('data')

def get_expired_reservations(token):
    response = requests.get(f'{BASE_URL}/api/contracts/expired-reservations', headers=headers(token))
    data = response.json()
    print(f'Get expired reservations: total =', data.get('data', {}).get('pagination', {}).get('total'))
    return data.get('data')

def scan_expired_reservations(token):
    response = requests.post(f'{BASE_URL}/api/contracts/scan-expired-reservations', headers=headers(token), json={})
    data = response.json()
    print(f'Scan expired reservations:', data.get('message'))
    print(f'  Results:', json.dumps(data.get('data', {}), ensure_ascii=False, indent=2))
    return data.get('data')

def release_single_expired_reservation(token, reservation_id):
    response = requests.post(f'{BASE_URL}/api/contracts/release-expired-reservation/{reservation_id}', headers=headers(token), json={})
    data = response.json()
    print(f'Release reservation {reservation_id}:', data.get('message'))
    return data

def list_contracts(token, **kwargs):
    response = requests.get(f'{BASE_URL}/api/contracts', headers=headers(token), params=kwargs)
    data = response.json()
    print(f'List contracts: total =', data.get('data', {}).get('pagination', {}).get('total'))
    return data.get('data')

def get_plot_statistics(token):
    response = requests.get(f'{BASE_URL}/api/plots/statistics', headers=headers(token))
    data = response.json()
    print(f'Plot statistics:', json.dumps(data.get('data', {}).get('overall', {}), ensure_ascii=False))
    return data.get('data')

def get_operation_logs(token):
    response = requests.get(f'{BASE_URL}/api/operation-logs', headers=headers(token), 
        params={'pageSize': 20, 'resource_type': 'contract'})
    data = response.json()
    logs = data.get('data', {}).get('list', [])
    print(f'Recent operation logs ({len(logs)}):')
    for log in logs[:5]:
        print(f'  - {log.get("created_at")}: {log.get("summary")}')
    return logs

def get_contract_status_logs(token, contract_id):
    contract = get_contract(token, contract_id)
    logs = contract.get('status_logs', [])
    print(f'Contract {contract_id} status logs ({len(logs)}):')
    for log in logs:
        print(f'  - {log.get("created_at")}: {log.get("from_status_name")} → {log.get("to_status_name")} ({log.get("operator_name")}) - {log.get("remark", "")}')
    return logs

def test_expired_reservation_workflow():
    print('=' * 80)
    print('测试过期预留扫描和释放功能')
    print('=' * 80)
    
    try:
        token = login('admin', 'admin123')
        print(f'Login successful')
        
        print('\n' + '-' * 80)
        print('1. 创建测试墓位')
        print('-' * 80)
        
        plot_id_1 = create_test_plot(token, f'EXP-{TIMESTAMP}-001')
        plot_id_2 = create_test_plot(token, f'EXP-{TIMESTAMP}-002')
        plot_id_3 = create_test_plot(token, f'EXP-{TIMESTAMP}-003')
        
        print('\n' + '-' * 80)
        print('2. 创建不同有效期的预留')
        print('-' * 80)
        
        reserve_1 = reserve_plot_with_custom_expiry(token, plot_id_1, '用户A', '13800000001', 0)
        reserve_2 = reserve_plot_with_custom_expiry(token, plot_id_2, '用户B', '13800000002', 7)
        reserve_3 = reserve_plot_with_custom_expiry(token, plot_id_3, '用户C', '13800000003', 30)
        
        print('\n' + '-' * 80)
        print('3. 验证预留状态')
        print('-' * 80)
        
        get_contract(token, reserve_1['id'])
        get_plot(token, plot_id_1)
        check_plot_availability(token, plot_id_1)
        
        print('\n' + '-' * 80)
        print('4. 查看过期预留列表')
        print('-' * 80)
        
        expired = get_expired_reservations(token)
        
        print('\n' + '-' * 80)
        print('5. 测试手动扫描释放过期预留')
        print('-' * 80)
        
        scan_result = scan_expired_reservations(token)
        
        print('\n' + '-' * 80)
        print('6. 验证扫描结果 - 检查合同和墓位状态')
        print('-' * 80)
        
        print(f'\n验证 plot {plot_id_1} (预留0天，应已释放):')
        contract_1 = get_contract(token, reserve_1['id'])
        plot_1 = get_plot(token, plot_id_1)
        availability_1 = check_plot_availability(token, plot_id_1)
        
        assert contract_1['status'] == 'draft', f'Expected draft, got {contract_1["status"]}'
        print('  ✓ Contract status is draft')
        assert plot_1['status'] == '空闲', f'Expected 空闲, got {plot_1["status"]}'
        print('  ✓ Plot status is 空闲')
        assert availability_1['available'] == True, 'Plot should be available now'
        print('  ✓ Plot is available')
        
        print(f'\n验证 plot {plot_id_2} (预留7天，应仍为预留状态):')
        contract_2 = get_contract(token, reserve_2['id'])
        plot_2 = get_plot(token, plot_id_2)
        availability_2 = check_plot_availability(token, plot_id_2)
        
        assert contract_2['status'] == 'reserved', f'Expected reserved, got {contract_2["status"]}'
        print('  ✓ Contract status is reserved')
        assert plot_2['status'] == '预留中', f'Expected 预留中, got {plot_2["status"]}'
        print('  ✓ Plot status is 预留中')
        assert availability_2['available'] == False, 'Plot should not be available'
        print('  ✓ Plot is not available')
        
        print('\n' + '-' * 80)
        print('7. 验证合同状态日志')
        print('-' * 80)
        
        get_contract_status_logs(token, reserve_1['id'])
        
        print('\n' + '-' * 80)
        print('8. 验证操作日志')
        print('-' * 80)
        
        get_operation_logs(token)
        
        print('\n' + '-' * 80)
        print('9. 验证合同列表查询自动释放过期预留')
        print('-' * 80)
        
        list_contracts(token, status='reserved')
        list_contracts(token, auto_release='true')
        
        print('\n' + '-' * 80)
        print('10. 验证墓位统计查询自动释放过期预留')
        print('-' * 80)
        
        get_plot_statistics(token)
        
        print('\n' + '-' * 80)
        print('11. 测试安全校验 - 尝试释放已签约合同的预留')
        print('-' * 80)
        
        print('\n首先签约第二个合同:')
        contact_id = create_test_contact(token, '联系人', '13900000000')
        sign_contract(token, reserve_2['id'], contact_id)
        
        print('\n尝试释放已签约合同的预留（应失败）:')
        reservation = get_contract_reservation(token, reserve_2['id'])
        if reservation:
            result = release_single_expired_reservation(token, reservation['id'])
            print(f'  释放结果: {result.get("message")}')
            assert result.get('code') != 200, 'Should have failed to release signed contract'
            print('  ✓ 正确阻止了释放已签约合同的预留')
        
        print('\n' + '=' * 80)
        print('✓ 所有测试通过！')
        print('=' * 80)
        
    except Exception as e:
        print(f'\n✗ 测试失败: {e}')
        import traceback
        traceback.print_exc()
        exit(1)

def create_test_contact(token, name, phone):
    response = requests.post(f'{BASE_URL}/api/contacts', headers=headers(token), json={
        'name': name,
        'phone': phone,
        'relationship': '子女'
    })
    data = response.json()
    print(f'Create contact {name}:', data.get('message'))
    return data['data']['id'] if data.get('code') == 200 else None

def sign_contract(token, contract_id, contact_id):
    body = {
        'contact_id': contact_id,
        'plot_price': 50000,
        'management_fee': 2000,
        'management_fee_years': 10,
        'fee_items': [
            {'fee_type': '墓位款', 'fee_category': '购墓款', 'amount': 50000, 'description': '墓位购买'},
            {'fee_type': '管理费', 'fee_category': '管理费', 'amount': 2000, 'quantity': 10, 'unit_price': 200, 'description': '10年管理费'}
        ]
    }
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id}/sign', 
        headers=headers(token), json=body)
    data = response.json()
    print(f'Sign contract {contract_id}:', data.get('message'))
    assert data.get('code') == 200, f'Failed: {data}'

def get_contract_reservation(token, contract_id):
    contract = get_contract(token, contract_id)
    return contract.get('reservation')

if __name__ == '__main__':
    test_expired_reservation_workflow()
