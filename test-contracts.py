#!/usr/bin/env python3
import os
import requests
import json
import time
# 测试环境配置
PORT = int(os.environ.get('TEST_PORT', '3001'))
BASE_URL = os.environ.get('TEST_BASE_URL', f'http://localhost:{PORT}')
API_URL = f'{BASE_URL}/api'
TEST_USERNAME = os.environ.get('TEST_USERNAME', 'admin')
TEST_PASSWORD = os.environ.get('TEST_PASSWORD', 'admin123')
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
        'row': 99,
        'col': int(plot_number.split('-')[-1]),
        'status': '空闲',
        'type': '单穴',
        'price': 50000
    })
    data = response.json()
    print(f'Create plot {plot_number}:', data.get('message'), data.get('data', {}).get('id'))
    if data.get('code') != 200:
        response = requests.get(f'{BASE_URL}/api/plots', headers=headers(token), 
            params={'keyword': plot_number, 'pageSize': 1})
        list_data = response.json()
        items = list_data.get('data', {}).get('list', [])
        if items:
            print(f'  Plot already exists, using id: {items[0]["id"]}')
            return items[0]['id']
    return data['data']['id'] if data.get('code') == 200 else None

def create_test_contact(token, name, phone):
    response = requests.post(f'{BASE_URL}/api/contacts', headers=headers(token), json={
        'name': name,
        'phone': phone,
        'relationship': '子女'
    })
    data = response.json()
    print(f'Create contact {name}:', data.get('message'), data.get('data', {}).get('id'))
    return data['data']['id'] if data.get('code') == 200 else None

def create_test_deceased(token, name, plot_id=None):
    body = {
        'name': name,
        'gender': '男',
        'birth_date': '1950-01-01',
        'death_date': '2024-01-01'
    }
    if plot_id:
        body['plot_id'] = plot_id
    response = requests.post(f'{BASE_URL}/api/deceased', headers=headers(token), json=body)
    data = response.json()
    print(f'Create deceased {name}:', data.get('message'), data.get('data', {}).get('id'))
    return data['data']['id'] if data.get('code') == 200 else None

def test_check_availability(token, plot_id, should_be_available=True):
    response = requests.get(f'{BASE_URL}/api/contracts/check-plot-availability', 
        headers=headers(token), params={'plot_id': plot_id})
    data = response.json()
    print(f'Check availability plot {plot_id}:', data.get('data', {}).get('available'))
    if should_be_available:
        assert data.get('data', {}).get('available') == True, f'Expected available, got {data}'
    return data.get('data')

def test_create_contract_draft(token, plot_id, contact_id=None, deceased_id=None):
    body = {
        'plot_id': plot_id,
        'plot_price': 50000,
        'management_fee': 2000,
        'management_fee_years': 10,
        'remark': '测试合同'
    }
    if contact_id:
        body['contact_id'] = contact_id
    if deceased_id:
        body['deceased_id'] = deceased_id
    response = requests.post(f'{BASE_URL}/api/contracts', headers=headers(token), json=body)
    data = response.json()
    print(f'Create contract draft:', data.get('message'), data.get('data', {}))
    assert data.get('code') == 200, f'Failed: {data}'
    return data['data']['id']

def test_get_contract(token, contract_id):
    response = requests.get(f'{BASE_URL}/api/contracts/{contract_id}', headers=headers(token))
    data = response.json()
    print(f'Get contract {contract_id}: status =', data.get('data', {}).get('status_name'))
    assert data.get('code') == 200, f'Failed: {data}'
    return data.get('data')

def test_update_contract(token, contract_id, **kwargs):
    response = requests.put(f'{BASE_URL}/api/contracts/{contract_id}', 
        headers=headers(token), json=kwargs)
    data = response.json()
    print(f'Update contract {contract_id}:', data.get('message'))
    assert data.get('code') == 200, f'Failed: {data}'

def test_reserve_plot(token, plot_id, contact_name='张三', contact_phone='13800000000', reserve_days=7):
    body = {
        'plot_id': plot_id,
        'contact_name': contact_name,
        'contact_phone': contact_phone,
        'reserve_days': reserve_days,
        'plot_price': 50000
    }
    response = requests.post(f'{BASE_URL}/api/contracts/reserve', headers=headers(token), json=body)
    data = response.json()
    print(f'Reserve plot {plot_id}:', data.get('message'), data.get('data', {}).get('contract_no'))
    assert data.get('code') == 200, f'Failed: {data}'
    return data['data']['id']

def test_sign_contract(token, contract_id, contact_id, plot_price=50000, deceased_id=None):
    body = {
        'contact_id': contact_id,
        'plot_price': plot_price,
        'management_fee': 2000,
        'management_fee_years': 10,
        'fee_items': [
            {'fee_type': '墓位款', 'fee_category': '购墓款', 'amount': 50000, 'description': '墓位购买'},
            {'fee_type': '管理费', 'fee_category': '管理费', 'amount': 2000, 'quantity': 10, 'unit_price': 200, 'description': '10年管理费'}
        ]
    }
    if deceased_id:
        body['deceased_id'] = deceased_id
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id}/sign', 
        headers=headers(token), json=body)
    data = response.json()
    print(f'Sign contract {contract_id}:', data.get('message'))
    assert data.get('code') == 200, f'Failed: {data}'

def test_pay_contract(token, contract_id, amount, fee_category='购墓款'):
    body = {
        'amount': amount,
        'payment_method': '银行转账',
        'fee_category': fee_category,
        'remark': f'测试支付{fee_category}'
    }
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id}/pay', 
        headers=headers(token), json=body)
    data = response.json()
    print(f'Pay contract {contract_id} {amount}元 ({fee_category}):', data.get('message'))
    assert data.get('code') == 200, f'Failed: {data}'
    return data.get('data')

def test_void_contract(token, contract_id, reason='测试作废'):
    body = {'void_reason': reason}
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id}/void', 
        headers=headers(token), json=body)
    data = response.json()
    print(f'Void contract {contract_id}:', data.get('message'))
    assert data.get('code') == 200, f'Failed: {data}'

def test_renew_reservation(token, contract_id, days=7):
    body = {'reserve_days': days}
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id}/renew-reservation', 
        headers=headers(token), json=body)
    data = response.json()
    print(f'Renew reservation {contract_id}:', data.get('message'))
    assert data.get('code') == 200, f'Failed: {data}'

def test_delete_contract(token, contract_id):
    response = requests.delete(f'{BASE_URL}/api/contracts/{contract_id}', headers=headers(token))
    data = response.json()
    print(f'Delete contract {contract_id}:', data.get('message'))
    assert data.get('code') == 200, f'Failed: {data}'

def test_list_contracts(token, **kwargs):
    response = requests.get(f'{BASE_URL}/api/contracts', headers=headers(token), params=kwargs)
    data = response.json()
    print(f'List contracts: total =', data.get('data', {}).get('pagination', {}).get('total'))
    assert data.get('code') == 200, f'Failed: {data}'
    return data.get('data')

def test_contract_statistics(token):
    response = requests.get(f'{BASE_URL}/api/contracts/statistics', headers=headers(token))
    data = response.json()
    print(f'Contract statistics:', json.dumps(data.get('data', {}), ensure_ascii=False, indent=2)[:500])
    assert data.get('code') == 200, f'Failed: {data}'
    return data.get('data')

def test_plot_statistics(token):
    response = requests.get(f'{BASE_URL}/api/plots/statistics', headers=headers(token))
    data = response.json()
    print(f'Plot statistics - reserved count:', data.get('data', {}).get('overall', {}).get('reserved'))
    assert data.get('code') == 200, f'Failed: {data}'
    return data.get('data')

def test_deceased_with_reserved_plot(token, plot_id, deceased_name):
    body = {
        'name': deceased_name,
        'gender': '男',
        'birth_date': '1950-01-01',
        'death_date': '2024-01-01',
        'plot_id': plot_id
    }
    response = requests.post(f'{BASE_URL}/api/deceased', headers=headers(token), json=body)
    data = response.json()
    print(f'Try create deceased with reserved plot {plot_id}:', data.get('message'))
    assert data.get('code') == 400, f'Should have failed but got success: {data}'
    print('  ✓ Correctly blocked creating deceased for reserved plot')

def main():
    print('=' * 60)
    print('开始测试合同与墓位购买流程模块')
    print('=' * 60)
    
    try:
        token = login('admin', 'admin123')
        print(f'Login successful')
        
        print('\n' + '-' * 60)
        print('1. 准备测试数据')
        print('-' * 60)
        
        plot_id_1 = create_test_plot(token, f'HT-{TIMESTAMP}-001')
        plot_id_2 = create_test_plot(token, f'HT-{TIMESTAMP}-002')
        plot_id_3 = create_test_plot(token, f'HT-{TIMESTAMP}-003')
        plot_id_4 = create_test_plot(token, f'HT-{TIMESTAMP}-004')
        contact_id = create_test_contact(token, f'李四{TIMESTAMP}', f'139{TIMESTAMP[-8:]}')
        deceased_id = create_test_deceased(token, f'赵六{TIMESTAMP}')
        
        print('\n' + '-' * 60)
        print('2. 测试墓位可用性检查')
        print('-' * 60)
        
        test_check_availability(token, plot_id_1, should_be_available=True)
        
        print('\n' + '-' * 60)
        print('3. 测试创建合同草稿')
        print('-' * 60)
        
        contract_id_1 = test_create_contract_draft(token, plot_id_1)
        test_get_contract(token, contract_id_1)
        
        print('\n' + '-' * 60)
        print('4. 测试更新合同草稿')
        print('-' * 60)
        
        test_update_contract(token, contract_id_1, contact_id=contact_id, deceased_id=deceased_id, remark='已更新')
        contract = test_get_contract(token, contract_id_1)
        assert contract['contact_id'] == contact_id, 'Contact not updated'
        assert contract['deceased_id'] == deceased_id, 'Deceased not updated'
        print('  ✓ Contract updated correctly')
        
        print('\n' + '-' * 60)
        print('5. 测试墓位预留流程')
        print('-' * 60)
        
        reserved_contract_id = test_reserve_plot(token, plot_id_2, '王五', '13700000000', 7)
        test_get_contract(token, reserved_contract_id)
        test_check_availability(token, plot_id_2, should_be_available=False)
        test_plot_statistics(token)
        
        print('\n' + '-' * 60)
        print('6. 测试预留续期')
        print('-' * 60)
        
        test_renew_reservation(token, reserved_contract_id, 14)
        contract = test_get_contract(token, reserved_contract_id)
        print('  ✓ Reservation renewed')
        
        print('\n' + '-' * 60)
        print('7. 测试不能为预留墓位创建逝者（预留检查）')
        print('-' * 60)
        
        test_deceased_with_reserved_plot(token, plot_id_2, f'钱七{TIMESTAMP}')
        
        print('\n' + '-' * 60)
        print('8. 测试合同签约')
        print('-' * 60)
        
        test_sign_contract(token, contract_id_1, contact_id, deceased_id=deceased_id)
        contract = test_get_contract(token, contract_id_1)
        assert contract['status'] == 'signed', f'Expected signed, got {contract["status"]}'
        print('  ✓ Contract signed correctly')
        print('  Fee items count:', len(contract.get('fee_items', [])))
        
        print('\n' + '-' * 60)
        print('9. 测试合同付款（部分付款）')
        print('-' * 60)
        
        pay_result = test_pay_contract(token, contract_id_1, 30000, '购墓款')
        print('  Paid amount:', pay_result.get('new_paid_amount'))
        print('  Remaining:', pay_result.get('remaining_amount'))
        assert pay_result.get('remaining_amount') > 0, 'Should still have remaining'
        assert pay_result.get('became_effective') == False, 'Should not be effective yet'
        
        contract = test_get_contract(token, contract_id_1)
        assert contract['paid_amount'] == 30000, f'Expected 30000, got {contract["paid_amount"]}'
        
        print('\n' + '-' * 60)
        print('10. 测试合同付款（付清尾款自动生效）')
        print('-' * 60)
        
        pay_result = test_pay_contract(token, contract_id_1, 20000, '购墓款')
        print('  Paid amount:', pay_result.get('new_paid_amount'))
        print('  Remaining:', pay_result.get('remaining_amount'))
        print('  Became effective:', pay_result.get('became_effective'))
        assert pay_result.get('remaining_amount') == 2000, 'Should have remaining management fee'
        assert pay_result.get('became_effective') == False, 'Should not be effective until all paid'
        
        pay_result = test_pay_contract(token, contract_id_1, 2000, '管理费')
        print('  Final payment - Became effective:', pay_result.get('became_effective'))
        assert pay_result.get('became_effective') == True, 'Should be effective now'
        
        contract = test_get_contract(token, contract_id_1)
        assert contract['status'] == 'effective', f'Expected effective, got {contract["status"]}'
        print('  ✓ Contract became effective automatically')
        print('  Status logs count:', len(contract.get('status_logs', [])))
        
        print('\n' + '-' * 60)
        print('11. 验证墓位状态变为已占用')
        print('-' * 60)
        
        response = requests.get(f'{BASE_URL}/api/plots/{plot_id_1}', headers=headers(token))
        plot_data = response.json().get('data', {})
        print(f'  Plot {plot_id_1} status:', plot_data.get('status'))
        assert plot_data.get('status') == '已占用', f'Expected 已占用, got {plot_data.get("status")}'
        print('  ✓ Plot status updated to occupied')
        print('  Contracts linked to plot:', len(plot_data.get('contracts', [])))
        
        print('\n' + '-' * 60)
        print('12. 测试合同作废')
        print('-' * 60)
        
        test_void_contract(token, reserved_contract_id, '客户放弃购买')
        contract = test_get_contract(token, reserved_contract_id)
        assert contract['status'] == 'voided', f'Expected voided, got {contract["status"]}'
        print('  ✓ Contract voided')
        
        test_check_availability(token, plot_id_2, should_be_available=True)
        print('  ✓ Plot released after void')
        
        print('\n' + '-' * 60)
        print('13. 测试删除草稿合同')
        print('-' * 60)
        
        draft_contract_id = test_create_contract_draft(token, plot_id_3)
        test_delete_contract(token, draft_contract_id)
        print('  ✓ Draft contract deleted')
        
        print('\n' + '-' * 60)
        print('14. 测试合同列表查询')
        print('-' * 60)
        
        test_list_contracts(token)
        test_list_contracts(token, status='effective')
        test_list_contracts(token, keyword='HT')
        
        print('\n' + '-' * 60)
        print('15. 测试合同统计')
        print('-' * 60)
        
        stats = test_contract_statistics(token)
        print('  By status:', stats.get('byStatus'))
        print('  Total amount:', stats.get('amounts', {}).get('total_amount'))
        
        print('\n' + '=' * 60)
        print('✓ 所有测试通过！')
        print('=' * 60)
        
    except Exception as e:
        print(f'\n✗ 测试失败: {e}')
        import traceback
        traceback.print_exc()
        exit(1)

if __name__ == '__main__':
    main()
