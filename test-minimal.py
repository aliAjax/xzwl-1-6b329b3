import os
import requests
import time
# 测试环境配置
PORT = int(os.environ.get('TEST_PORT', '3001'))
BASE_URL = os.environ.get('TEST_BASE_URL', f'http://localhost:{PORT}')
API_URL = f'{BASE_URL}/api'
TEST_USERNAME = os.environ.get('TEST_USERNAME', 'admin')
TEST_PASSWORD = os.environ.get('TEST_PASSWORD', 'admin123')

resp = requests.post(f'{BASE_URL}/api/auth/login', json={'username': 'admin', 'password': 'admin123'})
token = resp.json()['data']['token']
h = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

print('=== Bug修复验证测试 ===')
print()

resp = requests.get(f'{BASE_URL}/api/plots', headers=h, params={'status': '空闲', 'pageSize': 10})
plots = resp.json()['data']['list']
print(f'可用墓位数: {len(plots)}')

if len(plots) < 3:
    print('需要至少3个可用墓位，正在创建...')
    for i in range(3):
        ts = int(time.time() * 1000)
        requests.post(f'{BASE_URL}/api/plots', headers=h, json={
            'plot_number': f'TEST-{ts}-{i}',
            'area': '测试区', 'row': 100 + i, 'col': ts + i,
            'status': '空闲', 'type': '单穴', 'price': 50000
        })
    resp = requests.get(f'{BASE_URL}/api/plots', headers=h, params={'status': '空闲', 'pageSize': 10})
    plots = resp.json()['data']['list']

pid1 = plots[0]['id']
pid2 = plots[1]['id']
pid3 = plots[2]['id']
print(f'使用墓位: {pid1}, {pid2}, {pid3}')

print()
print('=== 测试1: 重复占用检查 ===')
d1 = requests.post(f'{BASE_URL}/api/deceased', headers=h, json={
    'name': '逝者A', 'gender': '男', 'birth_date': '1950-01-01', 'death_date': '2024-01-01'
}).json()['data']['id']

c1 = requests.post(f'{BASE_URL}/api/contracts', headers=h, json={
    'plot_id': pid1, 'deceased_id': d1,
    'plot_price': 50000, 'management_fee': 2000, 'management_fee_years': 10
}).json()['data']['id']
print(f'✓ 创建合同 {c1}')

resp = requests.post(f'{BASE_URL}/api/contracts/{c1}/sign', headers=h, json={
    'deceased_id': d1, 'plot_price': 50000, 'management_fee': 2000, 'management_fee_years': 10
})
assert resp.json()['code'] == 200, '签约失败'
print('✓ 签约成功')

result = requests.post(f'{BASE_URL}/api/deceased', headers=h, json={
    'name': '逝者B', 'gender': '男', 'birth_date': '1950-01-01', 'death_date': '2024-01-01',
    'plot_id': pid1
}).json()
assert result['code'] == 400, f'应该阻止但返回 {result}'
print(f'✓ 正确阻止直接创建逝者占用: {result["message"]}')

resp = requests.post(f'{BASE_URL}/api/contracts/{c1}/pay', headers=h, json={
    'amount': 52000, 'payment_method': '现金', 'fee_category': '购墓款'
})
assert resp.json()['code'] == 200, '付款失败'
print('✓ 合同已生效')

result = requests.post(f'{BASE_URL}/api/contracts', headers=h, json={
    'plot_id': pid1, 'plot_price': 50000
}).json()
assert result['code'] == 400, f'应该阻止但返回 {result}'
print(f'✓ 正确阻止创建重复合同: {result["message"]}')

print()
print('=== 测试2: 历史付款关联 ===')
p1 = requests.post(f'{BASE_URL}/api/payments', headers=h, json={
    'plot_id': pid2, 'amount': 30000, 'payment_date': '2024-01-01',
    'due_date': '2024-12-31', 'status': '已缴', 'payment_method': '现金',
    'fee_category': '购墓款'
}).json()['data']['id']

p2 = requests.post(f'{BASE_URL}/api/payments', headers=h, json={
    'plot_id': pid2, 'amount': 2000, 'payment_date': '2024-01-01',
    'due_date': '2024-12-31', 'status': '已缴', 'payment_method': '现金',
    'fee_category': '管理费'
}).json()['data']['id']
print(f'✓ 创建历史付款 {p1}, {p2}')

resp = requests.post(f'{BASE_URL}/api/contracts', headers=h, json={
    'plot_id': pid2, 'plot_price': 50000, 'management_fee': 2000, 'management_fee_years': 10
}).json()
c2 = resp['data']['id']
linked = resp['data'].get('linked_payments', {})
print(f'✓ 创建合同 {c2}, 关联付款 {linked.get("count")} 条, 金额 {linked.get("total_amount")}')
assert linked.get('count') == 2, '应该关联2条付款'
assert linked.get('total_amount') == 32000, '总金额应该是32000'

detail = requests.get(f'{BASE_URL}/api/contracts/{c2}', headers=h).json()['data']
assert detail['paid_amount'] == 32000, f'paid_amount应该是32000，实际{detail["paid_amount"]}'
print(f'✓ 合同paid_amount正确: {detail["paid_amount"]}')

print()
print('=== 测试3: 独立付款自动关联 ===')
d3 = requests.post(f'{BASE_URL}/api/deceased', headers=h, json={
    'name': '逝者C', 'gender': '男', 'birth_date': '1950-01-01', 'death_date': '2024-01-01'
}).json()['data']['id']

c3 = requests.post(f'{BASE_URL}/api/contracts', headers=h, json={
    'plot_id': pid3, 'deceased_id': d3,
    'plot_price': 60000, 'management_fee': 3000, 'management_fee_years': 15
}).json()['data']['id']

requests.post(f'{BASE_URL}/api/contracts/{c3}/sign', headers=h, json={
    'deceased_id': d3, 'plot_price': 60000, 'management_fee': 3000, 'management_fee_years': 15
})
print(f'✓ 创建并签约合同 {c3}')

resp = requests.post(f'{BASE_URL}/api/payments', headers=h, json={
    'plot_id': pid3, 'amount': 60000, 'payment_date': '2024-06-01',
    'due_date': '2024-12-31', 'status': '已缴', 'payment_method': '银行转账',
    'fee_category': '购墓款'
}).json()
print(f'✓ 创建独立付款，关联合同: {resp["data"].get("contract_id")}')
assert resp['data'].get('contract_id') == c3, '应该自动关联合同'

detail = requests.get(f'{BASE_URL}/api/contracts/{c3}', headers=h).json()['data']
assert detail['paid_amount'] == 60000, f'paid_amount应该是60000，实际{detail["paid_amount"]}'
print(f'✓ 合同paid_amount已更新: {detail["paid_amount"]}')

resp = requests.post(f'{BASE_URL}/api/payments', headers=h, json={
    'plot_id': pid3, 'amount': 3000, 'payment_date': '2024-06-01',
    'due_date': '2024-12-31', 'status': '已缴', 'payment_method': '银行转账',
    'fee_category': '管理费'
}).json()

detail = requests.get(f'{BASE_URL}/api/contracts/{c3}', headers=h).json()['data']
assert detail['status'] == 'effective', f'合同应该生效，实际{detail["status"]}'
print(f'✓ 款项付清，合同自动生效: {detail["status"]}')

print()
print('=== 测试4: 预留阻止 ===')
resp = requests.post(f'{BASE_URL}/api/contracts', headers=h, json={
    'plot_id': pid1, 'plot_price': 50000
})
c4 = resp.json()['data']['id']
resp = requests.post(f'{BASE_URL}/api/contracts/{c4}/reserve', headers=h, json={
    'contact_name': '测试客户', 'contact_phone': '13800000000', 'reserve_days': 7
})
print(f'✓ 预留合同 {c4}')

result = requests.post(f'{BASE_URL}/api/deceased', headers=h, json={
    'name': '逝者D', 'gender': '男', 'birth_date': '1950-01-01', 'death_date': '2024-01-01',
    'plot_id': pid1
}).json()
assert result['code'] == 400, f'应该阻止但返回 {result}'
print(f'✓ 预留期间阻止创建逝者: {result["message"]}')

requests.post(f'{BASE_URL}/api/contracts/{c4}/void', headers=h, json={'void_reason': '测试作废'})
print('✓ 作废预留合同')

result = requests.post(f'{BASE_URL}/api/deceased', headers=h, json={
    'name': '逝者E', 'gender': '男', 'birth_date': '1950-01-01', 'death_date': '2024-01-01'
}).json()
print('✓ 作废后可正常操作')

print()
print('=== 所有测试通过! ===')
