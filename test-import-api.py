#!/usr/bin/env python3
import os
import requests
import json
# 测试环境配置
PORT = int(os.environ.get('TEST_PORT', '3001'))
BASE_URL = os.environ.get('TEST_BASE_URL', f'http://localhost:{PORT}')
API_URL = f'{BASE_URL}/api'
TEST_USERNAME = os.environ.get('TEST_USERNAME', 'admin')
TEST_PASSWORD = os.environ.get('TEST_PASSWORD', 'admin123')

def login():
    response = requests.post(f'{BASE_URL}/api/auth/login', 
        json={'username': 'admin', 'password': 'admin123'})
    if response.status_code == 200:
        return response.json()['data']['token']
    return None

def test_plot_preview(token):
    print('\n=== 测试墓位数据预览 ===')
    
    test_data = {
        'type': 'plot',
        'data': [
            {
                'plot_number': 'A-1排1号',
                'area': 'A',
                'row': 1,
                'col': 1,
                'status': '空闲',
                'type': '单穴',
                'price': 50000,
                'remark': '测试墓位1'
            },
            {
                'plot_number': 'A-1排2号',
                'area': 'A',
                'row': 1,
                'col': 2,
                'status': '空闲',
                'type': '双穴',
                'price': 80000
            },
            {
                'plot_number': 'A-1排1号',
                'area': 'A',
                'row': 1,
                'col': 1,
                'status': '已占用'
            },
            {
                'plot_number': '',
                'area': 'A',
                'row': 'abc',
                'col': 3,
                'status': '无效状态'
            },
            {
                'plot_number': 'A-1排5号',
                'area': 'A',
                'row': 1,
                'col': 5,
                'status': '空闲',
                'type': '单穴',
                'price': -100
            }
        ]
    }
    
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    response = requests.post(f'{BASE_URL}/api/import/preview', 
        json=test_data, headers=headers)
    
    print(f'状态码: {response.status_code}')
    result = response.json()
    print(f'响应: {json.dumps(result, ensure_ascii=False, indent=2)}')
    
    return result['data']['import_token'] if result['code'] == 200 else None

def test_contact_preview(token):
    print('\n=== 测试联系人数据预览 ===')
    
    test_data = {
        'type': 'contact',
        'data': [
            {
                'name': '张三',
                'phone': '13800138001',
                'id_card': '110101199001011234',
                'address': '北京市朝阳区',
                'relationship': '儿子',
                'deceased_id': 1,
                'remark': '主要联系人'
            },
            {
                'name': '李四',
                'phone': '13800138002',
                'relationship': '女儿'
            },
            {
                'name': '张三',
                'phone': '13800138001',
                'relationship': '儿子'
            },
            {
                'name': '赵六',
                'phone': '13800138000',
                'relationship': '父亲'
            },
            {
                'name': '',
                'phone': '12345',
                'deceased_id': 9999
            },
            {
                'name': '王五',
                'phone': '13800138005',
                'id_card': '12345'
            }
        ]
    }
    
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    response = requests.post(f'{BASE_URL}/api/import/preview', 
        json=test_data, headers=headers)
    
    print(f'状态码: {response.status_code}')
    result = response.json()
    print(f'响应: {json.dumps(result, ensure_ascii=False, indent=2)}')
    
    return result['data']['import_token'] if result['code'] == 200 else None

def test_import_confirm(token, import_token, data_type):
    print(f'\n=== 测试{data_type}数据确认导入 ===')
    
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    response = requests.post(f'{BASE_URL}/api/import/confirm', 
        json={'import_token': import_token}, headers=headers)
    
    print(f'状态码: {response.status_code}')
    result = response.json()
    print(f'响应: {json.dumps(result, ensure_ascii=False, indent=2)}')
    
    return result

def test_invalid_preview(token):
    print('\n=== 测试无效数据类型 ===')
    
    test_data = {
        'type': 'invalid_type',
        'data': [{'name': 'test'}]
    }
    
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    response = requests.post(f'{BASE_URL}/api/import/preview', 
        json=test_data, headers=headers)
    
    print(f'状态码: {response.status_code}')
    result = response.json()
    print(f'响应: {json.dumps(result, ensure_ascii=False, indent=2)}')

def test_empty_data(token):
    print('\n=== 测试空数据 ===')
    
    test_data = {
        'type': 'plot',
        'data': []
    }
    
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    response = requests.post(f'{BASE_URL}/api/import/preview', 
        json=test_data, headers=headers)
    
    print(f'状态码: {response.status_code}')
    result = response.json()
    print(f'响应: {json.dumps(result, ensure_ascii=False, indent=2)}')

def test_expired_token(token):
    print('\n=== 测试无效token ===')
    
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    response = requests.post(f'{BASE_URL}/api/import/confirm', 
        json={'import_token': 'invalid_token'}, headers=headers)
    
    print(f'状态码: {response.status_code}')
    result = response.json()
    print(f'响应: {json.dumps(result, ensure_ascii=False, indent=2)}')

def main():
    print('开始测试数据导入API...')
    
    token = login()
    if not token:
        print('登录失败')
        return
    
    print('登录成功')
    
    test_invalid_preview(token)
    test_empty_data(token)
    
    plot_token = test_plot_preview(token)
    if plot_token:
        test_import_confirm(token, plot_token, '墓位')
    
    contact_token = test_contact_preview(token)
    if contact_token:
        test_import_confirm(token, contact_token, '联系人')
    
    test_expired_token(token)
    
    print('\n=== 测试完成 ===')

if __name__ == '__main__':
    main()
