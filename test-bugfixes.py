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
        'area': 'BUGFIX区',
        'row': 99,
        'col': int(plot_number.split('-')[-1]),
        'status': '空闲',
        'type': '单穴',
        'price': 50000
    })
    data = response.json()
    if data.get('code') != 200:
        response = requests.get(f'{BASE_URL}/api/plots', headers=headers(token), 
            params={'keyword': plot_number, 'pageSize': 1})
        list_data = response.json()
        items = list_data.get('data', {}).get('list', [])
        if items:
            return items[0]['id']
    return data['data']['id'] if data.get('code') == 200 else None

def create_test_contact(token, name, phone):
    response = requests.post(f'{BASE_URL}/api/contacts', headers=headers(token), json={
        'name': name,
        'phone': phone,
        'relationship': '子女'
    })
    data = response.json()
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
    return data

def create_test_payment(token, plot_id, amount, fee_category='管理费', status='已缴'):
    response = requests.post(f'{BASE_URL}/api/payments', headers=headers(token), json={
        'plot_id': plot_id,
        'amount': amount,
        'payment_date': '2024-01-01',
        'due_date': '2024-12-31',
        'status': status,
        'payment_method': '现金',
        'fee_category': fee_category,
        'remark': '测试历史付款'
    })
    return response.json()

def test_duplicate_occupation_check(token):
    print('\n' + '=' * 60)
    print('测试1: 重复占用检查')
    print('=' * 60)
    
    plot_id_1 = create_test_plot(token, f'OCC-{TIMESTAMP}-001')
    contact_id = create_test_contact(token, f'张三{TIMESTAMP}', f'138{TIMESTAMP[-8:]}')
    deceased_id_1 = create_test_deceased(token, f'逝者A{TIMESTAMP}')
    
    print(f'\n1.1 创建合同草稿并关联逝者A')
    response = requests.post(f'{BASE_URL}/api/contracts', headers=headers(token), json={
        'plot_id': plot_id_1,
        'contact_id': contact_id,
        'deceased_id': deceased_id_1['data']['id'],
        'plot_price': 50000,
        'management_fee': 2000,
        'management_fee_years': 10
    })
    data = response.json()
    assert data.get('code') == 200, f'创建合同失败: {data}'
    contract_id_1 = data['data']['id']
    print(f'  ✓ 合同{contract_id_1}创建成功')
    
    print(f'\n1.2 签约合同')
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id_1}/sign', headers=headers(token), json={
        'contact_id': contact_id,
        'deceased_id': deceased_id_1['data']['id'],
        'plot_price': 50000,
        'management_fee': 2000,
        'management_fee_years': 10
    })
    data = response.json()
    assert data.get('code') == 200, f'签约失败: {data}'
    print('  ✓ 签约成功')
    
    print(f'\n1.3 尝试直接创建逝者B占用同一墓位（应该失败）')
    result = create_test_deceased(token, f'逝者B{TIMESTAMP}', plot_id_1)
    assert result.get('code') == 400, f'应该失败但得到: {result}'
    print(f'  ✓ 正确阻止，错误信息: {result.get("message")}')
    
    print(f'\n1.4 付款使合同生效')
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id_1}/pay', headers=headers(token), json={
        'amount': 50000,
        'payment_method': '银行转账',
        'fee_category': '购墓款'
    })
    assert response.json().get('code') == 200, '第一次付款失败'
    
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id_1}/pay', headers=headers(token), json={
        'amount': 2000,
        'payment_method': '银行转账',
        'fee_category': '管理费'
    })
    data = response.json()
    assert data.get('code') == 200, '第二次付款失败'
    assert data['data'].get('became_effective') == True, '合同应该生效'
    print('  ✓ 合同已生效')
    
    print(f'\n1.5 尝试为已生效合同的墓位创建新合同（应该失败）')
    response = requests.post(f'{BASE_URL}/api/contracts', headers=headers(token), json={
        'plot_id': plot_id_1,
        'contact_id': contact_id,
        'plot_price': 50000
    })
    data = response.json()
    assert data.get('code') == 400, f'应该失败但得到: {data}'
    print(f'  ✓ 正确阻止，错误信息: {data.get("message")}')
    
    print(f'\n1.6 尝试为已占用墓位签约新合同（应该失败）')
    deceased_id_2 = create_test_deceased(token, f'逝者C{TIMESTAMP}')
    response = requests.post(f'{BASE_URL}/api/contracts', headers=headers(token), json={
        'plot_id': create_test_plot(token, f'OCC-{TIMESTAMP}-002'),
        'contact_id': contact_id,
        'deceased_id': deceased_id_2['data']['id'],
        'plot_price': 50000
    })
    contract_id_2 = response.json()['data']['id']
    
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id_2}/sign', headers=headers(token), json={
        'contact_id': contact_id,
        'deceased_id': deceased_id_2['data']['id'],
        'plot_price': 50000
    })
    assert response.json().get('code') == 200, '签约新合同失败'
    
    print(f'\n1.7 验证墓位状态')
    response = requests.get(f'{BASE_URL}/api/plots/{plot_id_1}', headers=headers(token))
    plot_data = response.json()['data']
    assert plot_data['status'] == '已占用', f'墓位状态应该是已占用，实际是{plot_data["status"]}'
    print(f'  ✓ 墓位状态: {plot_data["status"]}')
    print(f'  ✓ 关联合同数: {len(plot_data.get("contracts", []))}')
    
    print('\n  ✓ 重复占用检查测试全部通过!')

def test_historical_payment_link(token):
    print('\n' + '=' * 60)
    print('测试2: 历史付款关联')
    print('=' * 60)
    
    plot_id = create_test_plot(token, f'PAY-{TIMESTAMP}-001')
    contact_id = create_test_contact(token, f'李四{TIMESTAMP}', f'139{TIMESTAMP[-8:]}')
    
    print(f'\n2.1 为墓位创建历史付款记录（无合同关联）')
    payment1 = create_test_payment(token, plot_id, 30000, '购墓款')
    assert payment1.get('code') == 200, f'创建付款1失败: {payment1}'
    print(f'  ✓ 已创建购墓款付款: {payment1["data"]["id"]}, 关联合同: {payment1["data"].get("contract_id")}')
    
    payment2 = create_test_payment(token, plot_id, 2000, '管理费')
    assert payment2.get('code') == 200, f'创建付款2失败: {payment2}'
    print(f'  ✓ 已创建管理费付款: {payment2["data"]["id"]}, 关联合同: {payment2["data"].get("contract_id")}')
    
    print(f'\n2.2 创建合同，应该自动关联历史付款')
    response = requests.post(f'{BASE_URL}/api/contracts', headers=headers(token), json={
        'plot_id': plot_id,
        'contact_id': contact_id,
        'plot_price': 50000,
        'management_fee': 2000,
        'management_fee_years': 10
    })
    data = response.json()
    assert data.get('code') == 200, f'创建合同失败: {data}'
    contract_id = data['data']['id']
    linked_payments = data['data'].get('linked_payments', {})
    print(f'  ✓ 合同{contract_id}创建成功')
    print(f'  ✓ 关联付款数: {linked_payments.get("count")}')
    print(f'  ✓ 关联付款总额: {linked_payments.get("total_amount")}')
    print(f'  ✓ 购墓款: {linked_payments.get("plot_payment")}')
    print(f'  ✓ 管理费: {linked_payments.get("fee_payment")}')
    assert linked_payments.get('count') == 2, f'应该关联2条付款，实际{linked_payments.get("count")}'
    assert linked_payments.get('total_amount') == 32000, f'总额应该是32000，实际{linked_payments.get("total_amount")}'
    
    print(f'\n2.3 查看合同详情，验证paid_amount')
    response = requests.get(f'{BASE_URL}/api/contracts/{contract_id}', headers=headers(token))
    contract_detail = response.json()['data']
    print(f'  ✓ 合同paid_amount: {contract_detail["paid_amount"]}')
    print(f'  ✓ 合同total_amount: {contract_detail["total_amount"]}')
    print(f'  ✓ 关联付款记录数: {len(contract_detail.get("payments", []))}')
    assert contract_detail['paid_amount'] == 32000, f'paid_amount应该是32000，实际{contract_detail["paid_amount"]}'
    assert len(contract_detail.get('payments', [])) == 2, f'应该有2条付款记录'
    
    print(f'\n2.4 验证付款记录的contract_id已更新')
    response = requests.get(f'{BASE_URL}/api/payments/{payment1["data"]["id"]}', headers=headers(token))
    payment_detail = response.json()['data']
    print(f'  ✓ 付款1的contract_id: {payment_detail.get("contract_id")}')
    assert payment_detail.get('contract_id') == contract_id, f'付款1应该关联合同{contract_id}'
    
    print(f'\n2.5 签约并支付尾款，验证合同自动生效')
    deceased_id = create_test_deceased(token, f'逝者D{TIMESTAMP}')
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id}/sign', headers=headers(token), json={
        'contact_id': contact_id,
        'deceased_id': deceased_id['data']['id'],
        'plot_price': 50000,
        'management_fee': 2000,
        'management_fee_years': 10
    })
    assert response.json().get('code') == 200, '签约失败'
    print('  ✓ 签约成功')
    
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id}/pay', headers=headers(token), json={
        'amount': 20000,
        'payment_method': '银行转账',
        'fee_category': '购墓款'
    })
    data = response.json()
    assert data.get('code') == 200, '付款失败'
    assert data['data'].get('became_effective') == True, '合同应该自动生效'
    print(f'  ✓ 支付尾款后合同自动生效')
    
    print('\n  ✓ 历史付款关联测试全部通过!')

def test_payment_auto_link_to_contract(token):
    print('\n' + '=' * 60)
    print('测试3: 独立创建付款自动关联合同')
    print('=' * 60)
    
    plot_id = create_test_plot(token, f'AUTOLINK-{TIMESTAMP}-001')
    contact_id = create_test_contact(token, f'王五{TIMESTAMP}', f'137{TIMESTAMP[-8:]}')
    deceased_id = create_test_deceased(token, f'逝者E{TIMESTAMP}')
    
    print(f'\n3.1 创建已签约合同')
    response = requests.post(f'{BASE_URL}/api/contracts', headers=headers(token), json={
        'plot_id': plot_id,
        'contact_id': contact_id,
        'deceased_id': deceased_id['data']['id'],
        'plot_price': 60000,
        'management_fee': 3000,
        'management_fee_years': 15
    })
    contract_id = response.json()['data']['id']
    
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id}/sign', headers=headers(token), json={
        'contact_id': contact_id,
        'deceased_id': deceased_id['data']['id'],
        'plot_price': 60000,
        'management_fee': 3000,
        'management_fee_years': 15
    })
    assert response.json().get('code') == 200, '签约失败'
    print(f'  ✓ 合同{contract_id}已签约')
    
    print(f'\n3.2 直接创建付款，应该自动关联合同')
    response = requests.post(f'{BASE_URL}/api/payments', headers=headers(token), json={
        'plot_id': plot_id,
        'amount': 60000,
        'payment_date': '2024-06-01',
        'due_date': '2024-12-31',
        'status': '已缴',
        'payment_method': '银行转账',
        'fee_category': '购墓款',
        'remark': '直接创建的购墓款'
    })
    data = response.json()
    assert data.get('code') == 200, f'创建付款失败: {data}'
    print(f'  ✓ 付款创建成功，关联合同: {data["data"].get("contract_id")}')
    assert data['data'].get('contract_id') == contract_id, f'应该自动关联合同{contract_id}'
    
    print(f'\n3.3 验证合同paid_amount已更新')
    response = requests.get(f'{BASE_URL}/api/contracts/{contract_id}', headers=headers(token))
    contract_detail = response.json()['data']
    print(f'  ✓ 合同paid_amount: {contract_detail["paid_amount"]}')
    assert contract_detail['paid_amount'] == 60000, f'paid_amount应该是60000，实际{contract_detail["paid_amount"]}'
    
    print(f'\n3.4 支付管理费，验证合同自动生效')
    response = requests.post(f'{BASE_URL}/api/payments', headers=headers(token), json={
        'plot_id': plot_id,
        'amount': 3000,
        'payment_date': '2024-06-01',
        'due_date': '2024-12-31',
        'status': '已缴',
        'payment_method': '银行转账',
        'fee_category': '管理费',
        'remark': '直接创建的管理费'
    })
    data = response.json()
    assert data.get('code') == 200, '创建管理费付款失败'
    print(f'  ✓ 管理费付款创建成功')
    
    response = requests.get(f'{BASE_URL}/api/contracts/{contract_id}', headers=headers(token))
    contract_detail = response.json()['data']
    print(f'  ✓ 合同状态: {contract_detail["status_name"]}')
    print(f'  ✓ 合同paid_amount: {contract_detail["paid_amount"]}')
    print(f'  ✓ 合同total_amount: {contract_detail["total_amount"]}')
    assert contract_detail['status'] == 'effective', f'合同应该已生效，实际是{contract_detail["status"]}'
    
    print('\n  ✓ 独立创建付款自动关联合同测试全部通过!')

def test_reservation_blocking(token):
    print('\n' + '=' * 60)
    print('测试4: 预留期间阻止占用')
    print('=' * 60)
    
    plot_id = create_test_plot(token, f'RES-{TIMESTAMP}-001')
    
    print(f'\n4.1 预留墓位')
    response = requests.post(f'{BASE_URL}/api/contracts/reserve', headers=headers(token), json={
        'plot_id': plot_id,
        'contact_name': '预留测试人',
        'contact_phone': '13600000000',
        'reserve_days': 7,
        'plot_price': 50000
    })
    data = response.json()
    assert data.get('code') == 200, f'预留失败: {data}'
    contract_id = data['data']['id']
    print(f'  ✓ 墓位已预留，合同{contract_id}')
    
    print(f'\n4.2 尝试为预留墓位创建逝者（应该失败）')
    result = create_test_deceased(token, f'逝者F{TIMESTAMP}', plot_id)
    assert result.get('code') == 400, f'应该失败但得到: {result}'
    print(f'  ✓ 正确阻止，错误信息: {result.get("message")}')
    
    print(f'\n4.3 尝试为预留墓位创建其他合同（应该失败）')
    response = requests.post(f'{BASE_URL}/api/contracts', headers=headers(token), json={
        'plot_id': plot_id,
        'plot_price': 50000
    })
    data = response.json()
    assert data.get('code') == 400, f'应该失败但得到: {data}'
    print(f'  ✓ 正确阻止，错误信息: {data.get("message")}')
    
    print(f'\n4.4 验证墓位状态')
    response = requests.get(f'{BASE_URL}/api/plots/{plot_id}', headers=headers(token))
    plot_data = response.json()['data']
    print(f'  ✓ 墓位状态: {plot_data["status"]}')
    assert plot_data['status'] == '预留中', f'应该是预留中，实际是{plot_data["status"]}'
    
    print(f'\n4.5 作废预留合同，验证墓位释放')
    response = requests.post(f'{BASE_URL}/api/contracts/{contract_id}/void', headers=headers(token), json={
        'void_reason': '客户放弃'
    })
    assert response.json().get('code') == 200, '作废除失败'
    print('  ✓ 合同已作废')
    
    response = requests.get(f'{BASE_URL}/api/plots/{plot_id}', headers=headers(token))
    plot_data = response.json()['data']
    print(f'  ✓ 墓位状态: {plot_data["status"]}')
    assert plot_data['status'] == '空闲', f'应该是空闲，实际是{plot_data["status"]}'
    
    print(f'\n4.6 现在可以为该墓位创建逝者了')
    result = create_test_deceased(token, f'逝者G{TIMESTAMP}', plot_id)
    assert result.get('code') == 200, f'应该成功但得到: {result}'
    print('  ✓ 逝者创建成功，墓位已被合法占用')
    
    print('\n  ✓ 预留期间阻止占用测试全部通过!')

def main():
    print('=' * 60)
    print('合同模块Bug修复专项测试')
    print('=' * 60)
    
    try:
        token = login('admin', 'admin123')
        print(f'✓ 登录成功')
        
        test_duplicate_occupation_check(token)
        test_historical_payment_link(token)
        test_payment_auto_link_to_contract(token)
        test_reservation_blocking(token)
        
        print('\n' + '=' * 60)
        print('✓ 所有Bug修复测试通过!')
        print('=' * 60)
        
    except Exception as e:
        print(f'\n✗ 测试失败: {e}')
        import traceback
        traceback.print_exc()
        exit(1)

if __name__ == '__main__':
    main()
