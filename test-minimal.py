import time

import requests


BASE_URL = 'http://localhost:8080'
TIMESTAMP = str(int(time.time() * 1000))


def api(method, path, token=None, **kwargs):
    headers = kwargs.pop('headers', {})
    if token:
        headers.update({
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        })
    response = requests.request(method, f'{BASE_URL}{path}', headers=headers, **kwargs)
    return response.json()


def require_ok(data, message):
    assert data.get('code') == 200, f'{message}: {data}'
    return data['data']


def login():
    data = api('POST', '/api/auth/login', json={'username': 'admin', 'password': 'admin123'})
    return require_ok(data, '登录失败')['token']


def create_plot(token, label, price=50000):
    suffix = f'{TIMESTAMP}-{time.time_ns() % 1000000}'
    data = api('POST', '/api/plots', token, json={
        'plot_number': f'{label}-{suffix}',
        'area': 'MIN测试区',
        'row': int(suffix.split('-')[-1]) + 1000,
        'col': int(time.time() * 1000) % 1000000,
        'status': '空闲',
        'type': '单穴',
        'price': price
    })
    return require_ok(data, '创建墓位失败')['id']


def create_deceased(token, name, plot_id=None):
    body = {
        'name': name,
        'gender': '男',
        'birth_date': '1950-01-01',
        'death_date': '2024-01-01'
    }
    if plot_id is not None:
        body['plot_id'] = plot_id
    return api('POST', '/api/deceased', token, json=body)


def create_contact(token, name):
    data = api('POST', '/api/contacts', token, json={
        'name': name,
        'phone': f'13{str(time.time_ns())[-9:]}',
        'relationship': '子女'
    })
    return require_ok(data, '创建联系人失败')['id']


def create_contract(token, plot_id, deceased_id=None, contact_id=None, plot_price=50000, management_fee=2000):
    body = {
        'plot_id': plot_id,
        'plot_price': plot_price,
        'management_fee': management_fee,
        'management_fee_years': 10
    }
    if contact_id:
        body['contact_id'] = contact_id
    if deceased_id:
        body['deceased_id'] = deceased_id
    data = api('POST', '/api/contracts', token, json=body)
    return require_ok(data, '创建合同失败')['id']


def sign_contract(token, contract_id, contact_id, deceased_id=None, plot_price=50000, management_fee=2000):
    body = {
        'contact_id': contact_id,
        'plot_price': plot_price,
        'management_fee': management_fee,
        'management_fee_years': 10
    }
    if deceased_id:
        body['deceased_id'] = deceased_id
    data = api('POST', f'/api/contracts/{contract_id}/sign', token, json=body)
    require_ok(data, '合同签约失败')


def contract_detail(token, contract_id):
    data = api('GET', f'/api/contracts/{contract_id}', token)
    return require_ok(data, '查询合同失败')


def create_payment(token, plot_id, amount, fee_category, due_date, status='已缴'):
    return api('POST', '/api/payments', token, json={
        'plot_id': plot_id,
        'amount': amount,
        'payment_date': '2026-01-01',
        'due_date': due_date,
        'status': status,
        'payment_method': '现金',
        'fee_category': fee_category
    })


def test_duplicate_occupation(token):
    plot_id = create_plot(token, 'MIN-DUP')
    contact_id = create_contact(token, f'最小重复联系人{TIMESTAMP}')
    deceased = require_ok(create_deceased(token, f'最小重复A{TIMESTAMP}'), '创建逝者失败')
    contract_id = create_contract(token, plot_id, deceased['id'], contact_id)
    sign_contract(token, contract_id, contact_id, deceased['id'])

    duplicate = create_deceased(token, f'最小重复B{TIMESTAMP}', plot_id)
    assert duplicate.get('code') == 400, f'应阻止重复占用: {duplicate}'
    print(f'✓ 重复占用已阻止: {duplicate["message"]}')


def test_historical_payment_link(token):
    plot_id = create_plot(token, 'MIN-HIST')
    plot_payment = require_ok(
        create_payment(token, plot_id, 30000, '购墓款', '2024-12-31'),
        '创建历史购墓款失败'
    )
    fee_payment = require_ok(
        create_payment(token, plot_id, 2000, '管理费', '2025-12-31'),
        '创建历史管理费失败'
    )

    contract_id = create_contract(token, plot_id, plot_price=50000, management_fee=2000)
    detail = contract_detail(token, contract_id)

    payment_ids = {payment['id'] for payment in detail.get('payments', [])}
    assert plot_payment['id'] in payment_ids and fee_payment['id'] in payment_ids, detail
    assert detail['paid_amount'] == 32000, detail
    print('✓ 历史付款已自动关联合同')


def test_failed_payment_does_not_dirty_paid_amount(token):
    plot_id = create_plot(token, 'MIN-PAYDIRTY')
    contact_id = create_contact(token, f'最小付款联系人{TIMESTAMP}')
    deceased = require_ok(create_deceased(token, f'最小付款逝者{TIMESTAMP}'), '创建逝者失败')
    contract_id = create_contract(token, plot_id, deceased['id'], contact_id, plot_price=50000, management_fee=2000)
    sign_contract(token, contract_id, contact_id, deceased['id'], plot_price=50000, management_fee=2000)

    first_payment = create_payment(token, plot_id, 100, '管理费', '2026-12-31')
    require_ok(first_payment, '创建首笔管理费失败')
    before = contract_detail(token, contract_id)['paid_amount']

    duplicate_payment = create_payment(token, plot_id, 77, '管理费', '2026-10-01')
    assert duplicate_payment.get('code') == 400, f'重复管理费应失败: {duplicate_payment}'
    after = contract_detail(token, contract_id)['paid_amount']
    assert after == before, f'失败付款不应改变paid_amount，之前{before}，之后{after}'
    print('✓ 失败付款不会污染合同已付金额')


def test_reservation_blocking(token):
    plot_id = create_plot(token, 'MIN-RES')
    reserved = api('POST', '/api/contracts/reserve', token, json={
        'plot_id': plot_id,
        'contact_name': '最小预留客户',
        'contact_phone': '13800000000',
        'reserve_days': 7,
        'plot_price': 50000
    })
    require_ok(reserved, '预留墓位失败')

    blocked = create_deceased(token, f'最小预留逝者{TIMESTAMP}', plot_id)
    assert blocked.get('code') == 400, f'预留期间应阻止逝者占用: {blocked}'
    print(f'✓ 预留期间已阻止占用: {blocked["message"]}')


def main():
    print('=== Bug修复最小验证测试 ===')
    token = login()
    test_duplicate_occupation(token)
    test_historical_payment_link(token)
    test_failed_payment_does_not_dirty_paid_amount(token)
    test_reservation_blocking(token)
    print('=== 最小验证通过 ===')


if __name__ == '__main__':
    main()
