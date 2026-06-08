#!/usr/bin/env python3
import requests
import json
import sys
import sqlite3
import os
from datetime import datetime, timedelta
# 测试环境配置
PORT = int(os.environ.get('TEST_PORT', '3001'))
BASE_URL = os.environ.get('TEST_BASE_URL', f'http://localhost:{PORT}') + '/api'
TEST_USERNAME = os.environ.get('TEST_USERNAME', 'admin')
TEST_PASSWORD = os.environ.get('TEST_PASSWORD', 'admin123')
DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'cemetery.db')

def login(username, password):
    response = requests.post(f'{BASE_URL}/auth/login', json={
        'username': username,
        'password': password
    })
    if response.status_code == 200:
        return response.json()['data']['token']
    else:
        print(f'登录失败 ({username}): {response.text}')
        sys.exit(1)

def headers(token):
    return {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    }

def setup_test_data():
    print('\n=== 准备测试数据 ===')
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    today = datetime.now()
    future_3d = (today + timedelta(days=3)).strftime('%Y-%m-%d')
    future_5d = (today + timedelta(days=5)).strftime('%Y-%m-%d')
    future_10d = (today + timedelta(days=10)).strftime('%Y-%m-%d')
    overdue_2d = (today - timedelta(days=2)).strftime('%Y-%m-%d')
    overdue_5d = (today - timedelta(days=5)).strftime('%Y-%m-%d')
    visit_date = (today - timedelta(days=7)).strftime('%Y-%m-%d')

    try:
        cursor.execute("SELECT id FROM users WHERE username = 'staff1' AND status = 'active'")
        staff1 = cursor.fetchone()
        cursor.execute("SELECT id FROM users WHERE username = 'staff2' AND status = 'active'")
        staff2 = cursor.fetchone()
        if not staff1 or not staff2:
            print('需要staff1和staff2用户进行测试，请先创建用户')
            sys.exit(1)

        staff1_id = staff1[0]
        staff2_id = staff2[0]

        cursor.execute("SELECT id FROM contacts LIMIT 3")
        contacts = cursor.fetchall()
        if len(contacts) < 3:
            print('需要至少3个联系人进行测试')
            sys.exit(1)

        contact1_id = contacts[0][0]
        contact2_id = contacts[1][0]
        contact3_id = contacts[2][0]

        cursor.execute("DELETE FROM visit_records WHERE content LIKE '测试跟进%'")

        long_content = '测试跟进内容1 - 未来3天待跟进，这是一段很长的内容，用来测试摘要截断功能，当内容超过50个字符的时候应该自动截断并在末尾加上省略号，确保摘要不会过长影响显示效果。'
        visit_records = [
            (contact1_id, staff1_id, '来访', visit_date, long_content, future_3d, '待跟进', None),
            (contact2_id, staff1_id, '电话', visit_date, '测试跟进内容2 - 已逾期2天', overdue_2d, '待跟进', None),
            (contact3_id, staff1_id, '来访', visit_date, '测试跟进内容3 - 未来10天（不在7天范围内）', future_10d, '待跟进', None),
            (contact1_id, staff2_id, '电话', visit_date, '测试跟进内容4 - 已逾期5天', overdue_5d, '待跟进', None),
            (contact2_id, staff2_id, '来访', visit_date, '测试跟进内容5 - 未来5天待跟进', future_5d, '待跟进', None),
            (contact3_id, staff1_id, '电话', visit_date, '测试跟进内容6 - 已完成，不应显示', overdue_2d, '已完成', None),
        ]

        cursor.executemany("""
            INSERT INTO visit_records (contact_id, user_id, type, visit_date, content, follow_up_date, status, remark)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, visit_records)

        conn.commit()
        print(f'✓ 测试数据准备完成')
        print(f'  - staff1_id: {staff1_id} (未来3天 + 已逾期2天 + 未来10天 + 1条已完成)')
        print(f'  - staff2_id: {staff2_id} (已逾期5天 + 未来5天)')

        return {
            'staff1_id': staff1_id,
            'staff2_id': staff2_id,
            'today': today.strftime('%Y-%m-%d'),
            'future_3d': future_3d,
            'future_5d': future_5d,
            'overdue_2d': overdue_2d,
            'overdue_5d': overdue_5d
        }

    except Exception as e:
        conn.rollback()
        print(f'准备测试数据失败: {e}')
        sys.exit(1)
    finally:
        conn.close()

def cleanup_test_data():
    print('\n=== 清理测试数据 ===')
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM visit_records WHERE content LIKE '测试跟进%'")
        conn.commit()
        print('✓ 测试数据清理完成')
    except Exception as e:
        conn.rollback()
        print(f'清理数据失败: {e}')
    finally:
        conn.close()

def test_staff_view_own_followup(token, test_data):
    print('\n=== 测试1: 普通员工查看自己的跟进任务 ===')
    response = requests.get(f'{BASE_URL}/visit-records/followup/staff', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200, f'预期200，实际{response.status_code}'
    assert 'list' in data['data']
    assert 'pagination' in data['data']
    assert 'statistics' in data['data']
    
    list_data = data['data']['list']
    stats = data['data']['statistics']
    
    print(f'记录数: {len(list_data)}')
    print(f'未来7天: {stats["upcoming_7_days"]}')
    print(f'已逾期: {stats["overdue"]}')
    
    assert len(list_data) >= 2, f'预期至少2条记录（未来3天+已逾期2天），实际{len(list_data)}'
    assert stats['upcoming_7_days'] >= 1, f'预期至少1条未来7天记录，实际{stats["upcoming_7_days"]}'
    assert stats['overdue'] >= 1, f'预期至少1条已逾期记录，实际{stats["overdue"]}'
    
    for item in list_data:
        assert 'contact_name' in item, '缺少contact_name字段'
        assert 'contact_phone' in item, '缺少contact_phone字段'
        assert 'follow_up_date' in item, '缺少follow_up_date字段'
        assert 'is_overdue' in item, '缺少is_overdue字段'
        assert 'days_overdue' in item, '缺少days_overdue字段'
        assert 'days_remaining' in item, '缺少days_remaining字段'
        assert 'summary' in item, '缺少summary字段'
        
        if item['is_overdue']:
            assert item['days_overdue'] > 0, '逾期记录的days_overdue应大于0'
            assert item['days_remaining'] == 0, '逾期记录的days_remaining应为0'
        else:
            assert item['days_overdue'] == 0, '未逾期记录的days_overdue应为0'
            assert item['days_remaining'] >= 0, '未逾期记录的days_remaining应大于等于0'
    
    long_content_item = next((x for x in list_data if '摘要截断功能' in x['summary'] or '测试跟进内容1' in x['summary']), None)
    if long_content_item:
        print(f'摘要内容: {long_content_item["summary"]}')
        print(f'摘要长度: {len(long_content_item["summary"])}')
        assert len(long_content_item['summary']) <= 53, '摘要超过50字符时应截断并加省略号'
        assert long_content_item['summary'].endswith('...'), '截断的摘要应以省略号结尾'
    
    print('✓ 普通员工查看自己的跟进任务成功')

def test_staff_cannot_view_others(token, test_data):
    print('\n=== 测试2: 普通员工尝试查看其他员工的跟进任务（应失败） ===')
    response = requests.get(f'{BASE_URL}/visit-records/followup/staff', 
                           headers=headers(token),
                           params={'staff_id': test_data['staff2_id']})
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 403, f'预期403，实际{response.status_code}'
    assert '权限不足' in data['message'], '应返回权限不足提示'
    
    print('✓ 普通员工无法查看其他员工的跟进任务')

def test_admin_view_own_followup(admin_token, test_data):
    print('\n=== 测试3: 管理员查看自己的跟进任务 ===')
    response = requests.get(f'{BASE_URL}/visit-records/followup/staff', headers=headers(admin_token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    
    assert response.status_code == 200, f'预期200，实际{response.status_code}'
    assert 'list' in data['data']
    
    print(f'记录数: {len(data["data"]["list"])}')
    print('✓ 管理员查看自己的跟进任务成功')

def test_admin_view_any_staff(admin_token, test_data):
    print('\n=== 测试4: 管理员查看指定员工的跟进任务 ===')
    response = requests.get(f'{BASE_URL}/visit-records/followup/staff', 
                           headers=headers(admin_token),
                           params={'staff_id': test_data['staff1_id']})
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200, f'预期200，实际{response.status_code}'
    
    list_data = data['data']['list']
    stats = data['data']['statistics']
    
    print(f'staff1记录数: {len(list_data)}')
    print(f'未来7天: {stats["upcoming_7_days"]}')
    print(f'已逾期: {stats["overdue"]}')
    
    assert len(list_data) >= 2, f'预期至少2条记录，实际{len(list_data)}'
    
    has_overdue = any(x['is_overdue'] for x in list_data)
    has_upcoming = any(not x['is_overdue'] for x in list_data)
    assert has_overdue, '应包含已逾期记录'
    assert has_upcoming, '应包含未来7天内记录'
    
    future_10d_item = next((x for x in list_data if x['follow_up_date'] == test_data['future_5d']), None)
    assert future_10d_item is None, '未来10天的记录不应显示在7天范围内'
    
    completed_item = next((x for x in list_data if '已完成' in x.get('summary', '')), None)
    assert completed_item is None, '已完成的记录不应显示'
    
    print('✓ 管理员查看指定员工的跟进任务成功')

def test_admin_view_nonexistent_staff(admin_token):
    print('\n=== 测试5: 管理员查看不存在的员工 ===')
    response = requests.get(f'{BASE_URL}/visit-records/followup/staff', 
                           headers=headers(admin_token),
                           params={'staff_id': 99999})
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 404, f'预期404，实际{response.status_code}'
    assert '不存在' in data['message'], '应返回员工不存在提示'
    
    print('✓ 不存在员工处理正确')

def test_pagination(admin_token, test_data):
    print('\n=== 测试6: 分页功能 ===')
    response = requests.get(f'{BASE_URL}/visit-records/followup/staff', 
                           headers=headers(admin_token),
                           params={
                               'staff_id': test_data['staff1_id'],
                               'page': 1,
                               'pageSize': 1
                           })
    print(f'状态码: {response.status_code}')
    data = response.json()
    
    assert response.status_code == 200
    assert len(data['data']['list']) == 1, '每页1条时应只返回1条'
    assert data['data']['pagination']['page'] == 1
    assert data['data']['pagination']['pageSize'] == 1
    assert data['data']['pagination']['totalPages'] >= 2
    
    response2 = requests.get(f'{BASE_URL}/visit-records/followup/staff', 
                            headers=headers(admin_token),
                            params={
                                'staff_id': test_data['staff1_id'],
                                'page': 2,
                                'pageSize': 1
                            })
    data2 = response2.json()
    assert len(data2['data']['list']) == 1
    
    assert data['data']['list'][0]['id'] != data2['data']['list'][0]['id'], '不同页应返回不同记录'
    
    print('✓ 分页功能正常')

def test_invalid_params(admin_token):
    print('\n=== 测试7: 无效参数验证 ===')
    response = requests.get(f'{BASE_URL}/visit-records/followup/staff', 
                           headers=headers(admin_token),
                           params={'staff_id': 'abc'})
    print(f'状态码: {response.status_code}')
    data = response.json()
    
    assert response.status_code == 400, f'预期400，实际{response.status_code}'
    assert '无效' in data['message'], '应返回参数无效提示'
    
    response2 = requests.get(f'{BASE_URL}/visit-records/followup/staff', 
                            headers=headers(admin_token),
                            params={'page': 0})
    print(f'状态码: {response2.status_code}')
    data2 = response2.json()
    assert response2.status_code == 400
    
    print('✓ 参数验证正常')

def test_no_auth():
    print('\n=== 测试8: 未授权访问 ===')
    response = requests.get(f'{BASE_URL}/visit-records/followup/staff')
    print(f'状态码: {response.status_code}')
    data = response.json()
    
    assert response.status_code == 401, f'预期401，实际{response.status_code}'
    
    print('✓ 未授权访问拦截正常')

def main():
    print('=' * 60)
    print('按员工维度跟进任务接口测试')
    print('=' * 60)
    
    cleanup_test_data()
    test_data = setup_test_data()
    
    staff1_token = login('staff1', 'staff123')
    print(f'staff1登录成功')
    
    staff2_token = login('staff2', 'staff123')
    print(f'staff2登录成功')
    
    admin_token = login('admin', 'admin123')
    print(f'admin登录成功')
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE username = 'staff1'")
    staff1_id = cursor.fetchone()[0]
    cursor.execute("SELECT id FROM users WHERE username = 'staff2'")
    staff2_id = cursor.fetchone()[0]
    conn.close()
    
    print(f'staff1_id: {staff1_id}, staff2_id: {staff2_id}')
    
    test_data['staff1_id'] = staff1_id
    test_data['staff2_id'] = staff2_id
    
    try:
        test_staff_view_own_followup(staff1_token, test_data)
        test_staff_cannot_view_others(staff1_token, test_data)
        test_admin_view_own_followup(admin_token, test_data)
        test_admin_view_any_staff(admin_token, test_data)
        test_admin_view_nonexistent_staff(admin_token)
        test_pagination(admin_token, test_data)
        test_invalid_params(admin_token)
        test_no_auth()
        
        print('\n' + '=' * 60)
        print('✓ 所有测试通过！')
        print('=' * 60)
        
    except AssertionError as e:
        print(f'\n✗ 测试失败: {e}')
        sys.exit(1)
    except Exception as e:
        print(f'\n✗ 发生错误: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        cleanup_test_data()

if __name__ == '__main__':
    main()
