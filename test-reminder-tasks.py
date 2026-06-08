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
DB_PATH = os.environ.get('TEST_DB_PATH', os.environ.get('DB_PATH', os.path.join(os.path.dirname(__file__), 'data', 'cemetery.db')))

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

def setup_test_data():
    print('\n=== 准备测试数据 ===')
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    today = datetime.now()
    due_date_7d = (today + timedelta(days=7)).strftime('%Y-%m-%d')
    due_date_15d = (today + timedelta(days=15)).strftime('%Y-%m-%d')
    due_date_30d = (today + timedelta(days=30)).strftime('%Y-%m-%d')
    due_date_overdue = (today - timedelta(days=5)).strftime('%Y-%m-%d')

    try:
        cursor.execute("SELECT id FROM plots WHERE status = '已占用' LIMIT 4")
        plots = cursor.fetchall()
        if len(plots) < 4:
            print('需要至少4个已占用的墓位进行测试')
            sys.exit(1)

        plot_normal = plots[0][0]
        plot_no_contact = plots[1][0]
        plot_bad_phone = plots[2][0]
        plot_dup_test = plots[3][0]

        cursor.execute("SELECT id FROM contacts WHERE phone LIKE '1%' AND length(phone) = 11 LIMIT 1")
        contact_good = cursor.fetchone()
        if not contact_good:
            cursor.execute("""
                INSERT INTO contacts (name, phone, relationship)
                VALUES ('测试联系人', '13800138000', '家属')
            """)
            contact_good_id = cursor.lastrowid
        else:
            contact_good_id = contact_good[0]

        cursor.execute("SELECT id FROM contacts WHERE phone NOT LIKE '1%' OR length(phone) != 11 LIMIT 1")
        contact_bad = cursor.fetchone()
        if not contact_bad:
            cursor.execute("""
                INSERT INTO contacts (name, phone, relationship)
                VALUES ('异常手机号联系人', '12345', '家属')
            """)
            contact_bad_id = cursor.lastrowid
        else:
            contact_bad_id = contact_bad[0]

        cursor.execute("DELETE FROM payments WHERE plot_id IN (?, ?, ?, ?)", 
                      (plot_normal, plot_no_contact, plot_bad_phone, plot_dup_test))

        payments_to_insert = [
            (plot_normal, contact_good_id, 200.0, due_date_7d, '未缴', due_date_overdue),
            (plot_no_contact, None, 200.0, due_date_15d, '未缴', due_date_overdue),
            (plot_bad_phone, contact_bad_id, 200.0, due_date_30d, '未缴', due_date_overdue),
            (plot_dup_test, contact_good_id, 200.0, due_date_7d, '未缴', due_date_overdue),
        ]

        cursor.executemany("""
            INSERT INTO payments (plot_id, contact_id, amount, due_date, status, start_date)
            VALUES (?, ?, ?, ?, ?, ?)
        """, payments_to_insert)

        conn.commit()
        print(f'✓ 测试数据准备完成')
        print(f'  - 正常墓位(有有效联系人): plot_id={plot_normal}, due_date={due_date_7d}')
        print(f'  - 无联系人墓位: plot_id={plot_no_contact}, due_date={due_date_15d}')
        print(f'  - 异常手机号墓位: plot_id={plot_bad_phone}, due_date={due_date_30d}')
        print(f'  - 重复提醒测试墓位: plot_id={plot_dup_test}, due_date={due_date_7d}')

        return {
            'plot_normal': plot_normal,
            'plot_no_contact': plot_no_contact,
            'plot_bad_phone': plot_bad_phone,
            'plot_dup_test': plot_dup_test,
            'contact_good_id': contact_good_id,
            'contact_bad_id': contact_bad_id
        }

    except Exception as e:
        conn.rollback()
        print(f'准备测试数据失败: {e}')
        sys.exit(1)
    finally:
        conn.close()

def cleanup_reminder_data():
    print('\n=== 清理旧的提醒测试数据 ===')
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM reminder_details WHERE id > 0")
        cursor.execute("DELETE FROM reminder_batches WHERE id > 0")
        conn.commit()
        print('✓ 旧提醒数据清理完成')
    except Exception as e:
        conn.rollback()
        print(f'清理数据失败: {e}')
    finally:
        conn.close()

def test_generate_first_batch(token, test_data):
    print('\n=== 测试1: 首次生成提醒批次 ===')
    response = requests.post(f'{BASE_URL}/reminders/generate', headers=headers(token), json={
        'reminder_days': 30,
        'remark': '测试提醒批次1'
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200, f'预期200，实际{response.status_code}'
    assert 'batch_id' in data['data']
    assert 'batch_no' in data['data']
    assert data['data']['batch_no'].startswith('REM-')
    
    total = data['data']['total_count']
    success = data['data']['success_count']
    skip = data['data']['skip_count']
    exception = data['data']['exception_count']
    
    print(f'总记录数: {total}')
    print(f'成功生成: {success}')
    print(f'跳过(重复): {skip}')
    print(f'异常: {exception}')
    
    assert total >= 4, f'预期至少4条记录，实际{total}'
    assert success >= 2, f'预期至少2条成功（正常+重复测试），实际{success}'
    assert skip == 0, f'首次生成跳过数应为0，实际{skip}'
    assert exception >= 2, f'预期至少2条异常（无联系人+异常手机号），实际{exception}'
    
    print('✓ 首次批次生成成功')
    return data['data']['batch_id']

def mark_normal_details_as_sent(token, batch_id, limit=1):
    print(f'\n=== 将批次{batch_id}的正常明细标记为 sent ===')
    response = requests.get(f'{BASE_URL}/reminders/batches/{batch_id}', headers=headers(token))
    data = response.json()
    normal_details = data['data']['normal_details']

    marked_count = 0
    for detail in normal_details:
        if marked_count >= limit:
            break
        if detail['status'] == 'pending':
            update_resp = requests.patch(
                f'{BASE_URL}/reminders/details/{detail["id"]}/status',
                headers=headers(token),
                json={'status': 'sent'}
            )
            if update_resp.status_code == 200:
                marked_count += 1

    print(f'✓ 已将 {marked_count} 条正常明细标记为 sent')
    return marked_count

def test_generate_duplicate_batch(token, expected_skip=0):
    print('\n=== 测试2: 重复生成提醒批次（验证去重） ===')
    response = requests.post(f'{BASE_URL}/reminders/generate', headers=headers(token), json={
        'reminder_days': 30,
        'remark': '测试提醒批次2（重复生成）'
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200, f'预期200，实际{response.status_code}'
    
    total = data['data']['total_count']
    success = data['data']['success_count']
    skip = data['data']['skip_count']
    exception = data['data']['exception_count']

    print(f'总记录数: {total}')
    print(f'成功生成: {success}')
    print(f'跳过(重复): {skip}')
    print(f'异常: {exception}')

    assert total >= 4, f'预期至少4条记录，实际{total}'
    if expected_skip > 0:
        assert skip == expected_skip, f'预期跳过{expected_skip}条，实际{skip}'
        assert success >= 1, f'应保留未sent记录用于后续状态流转测试，实际成功数{success}'
    else:
        assert success >= 2, f'无sent记录时成功数应>=2，实际{success}'
        assert skip == 0, f'无sent记录时跳过数应为0，实际{skip}'
    assert exception >= 2, f'预期至少2条异常（无联系人+异常手机号），实际{exception}'

    print('✓ 重复生成去重机制生效')
    return data['data']['batch_id']

def test_get_batches(token):
    print('\n=== 测试3: 查询批次列表 ===')
    response = requests.get(f'{BASE_URL}/reminders/batches', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200
    assert 'list' in data['data']
    assert 'pagination' in data['data']
    assert len(data['data']['list']) >= 2
    
    batch = data['data']['list'][0]
    assert 'batch_no' in batch
    assert 'status' in batch
    assert 'total_count' in batch
    
    print(f'✓ 批次列表查询成功，共{len(data["data"]["list"])}条记录')
    return data['data']['list'][0]['id']

def test_get_batch_detail(token, batch_id):
    print(f'\n=== 测试4: 查询批次详情 (batch_id={batch_id}) ===')
    response = requests.get(f'{BASE_URL}/reminders/batches/{batch_id}', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200
    assert 'batch' in data['data']
    assert 'normal_details' in data['data']
    assert 'exception_details' in data['data']
    assert 'exception_statistics' in data['data']
    
    batch = data['data']['batch']
    normal = data['data']['normal_details']
    exceptions = data['data']['exception_details']
    stats = data['data']['exception_statistics']
    
    print(f'批次号: {batch["batch_no"]}')
    print(f'正常明细: {len(normal)}条')
    print(f'异常明细: {len(exceptions)}条')
    print(f'异常统计: {json.dumps(stats, ensure_ascii=False)}')
    
    assert len(normal) == batch['success_count']
    assert len(exceptions) == batch['exception_count'] + batch['skip_count']
    
    exception_types = [s['exception_type'] for s in stats]
    assert 'no_contact' in exception_types or 'invalid_phone' in exception_types or 'duplicate_reminder' in exception_types
    
    print('✓ 批次详情查询成功')

def test_get_exceptions(token):
    print('\n=== 测试5: 查询异常明细 ===')
    response = requests.get(f'{BASE_URL}/reminders/exceptions', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200
    assert 'list' in data['data']
    assert 'pagination' in data['data']
    
    exceptions = data['data']['list']
    print(f'异常记录数: {len(exceptions)}')
    
    if exceptions:
        for e in exceptions[:3]:
            print(f'  - {e["exception_type"]}: {e["exception_message"]}')
    
    print('✓ 异常明细查询成功')

def test_search_by_contact_name(token):
    print('\n=== 测试6: 按联系人姓名查询提醒记录 ===')
    response = requests.get(f'{BASE_URL}/reminders/details', headers=headers(token), params={
        'contact_name': '测试'
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200
    assert 'list' in data['data']
    print(f'查询结果: {len(data["data"]["list"])}条记录')
    print('✓ 按联系人姓名查询成功')

def test_search_by_plot_number(token):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT plot_number FROM plots WHERE status = '已占用' LIMIT 1")
    plot = cursor.fetchone()
    conn.close()
    
    if plot:
        plot_number = plot[0]
        print(f'\n=== 测试7: 按墓位编号查询提醒记录 (plot_number={plot_number}) ===')
        response = requests.get(f'{BASE_URL}/reminders/details', headers=headers(token), params={
            'plot_number': plot_number
        })
        print(f'状态码: {response.status_code}')
        data = response.json()
        print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
        
        assert response.status_code == 200
        assert 'list' in data['data']
        print(f'查询结果: {len(data["data"]["list"])}条记录')
        print('✓ 按墓位编号查询成功')

def test_search_by_phone(token):
    print('\n=== 测试8: 按手机号查询提醒记录 ===')
    response = requests.get(f'{BASE_URL}/reminders/details', headers=headers(token), params={
        'contact_phone': '13800138000'
    })
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200
    assert 'list' in data['data']
    print(f'查询结果: {len(data["data"]["list"])}条记录')
    print('✓ 按手机号查询成功')

def test_statistics(token):
    print('\n=== 测试9: 查询提醒统计信息 ===')
    response = requests.get(f'{BASE_URL}/reminders/statistics', headers=headers(token))
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200
    assert 'summary' in data['data']
    assert 'exception_by_type' in data['data']
    assert 'urgency_distribution' in data['data']
    
    summary = data['data']['summary']
    print(f'统计周期: {data["data"]["period"]}')
    print(f'总批次数: {summary["total_batches"]}')
    print(f'总提醒数: {summary["total_reminders"]}')
    print(f'成功数: {summary["success_count"]}')
    print(f'跳过数: {summary["skip_count"]}')
    print(f'异常数: {summary["exception_count"]}')
    
    assert summary['total_batches'] >= 2
    assert summary['total_reminders'] >= 8
    
    print('✓ 统计信息查询成功')

def test_exception_types(token):
    print('\n=== 测试10: 验证异常类型分类 ===')
    response = requests.get(f'{BASE_URL}/reminders/exceptions', headers=headers(token), params={
        'pageSize': 100
    })
    data = response.json()
    
    exceptions = data['data']['list']
    exception_types = {}
    
    for e in exceptions:
        etype = e['exception_type']
        exception_types[etype] = exception_types.get(etype, 0) + 1
    
    print(f'异常类型分布:')
    for etype, count in exception_types.items():
        print(f'  - {etype}: {count}条')
    
    assert 'no_contact' in exception_types, '缺少no_contact异常类型'
    assert 'invalid_phone' in exception_types, '缺少invalid_phone异常类型'
    assert 'duplicate_reminder' in exception_types, '缺少duplicate_reminder异常类型'
    
    print('✓ 异常类型分类正确')

def get_pending_reminder_id(token):
    response = requests.get(f'{BASE_URL}/reminders/details', headers=headers(token), params={
        'pageSize': 100,
        'is_exception': '0'
    })
    data = response.json()
    for detail in data['data']['list']:
        if detail['status'] == 'pending':
            return detail['id']
    return None

def test_update_status_to_sent(token):
    print('\n=== 测试11: 更新提醒状态为 sent ===')
    detail_id = get_pending_reminder_id(token)
    assert detail_id is not None, '没有找到 pending 状态的提醒明细'
    
    response = requests.patch(f'{BASE_URL}/reminders/details/{detail_id}/status', 
                             headers=headers(token), 
                             json={'status': 'sent'})
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200, f'预期200，实际{response.status_code}'
    assert data['data']['status'] == 'sent'
    assert data['data']['sent_at'] is not None
    assert data['data']['operator_id'] is not None
    assert data['data']['operator_name'] is not None
    
    print('✓ 状态更新为 sent 成功')
    return detail_id

def test_update_status_to_failed(token):
    print('\n=== 测试12: 更新提醒状态为 failed ===')
    detail_id = get_pending_reminder_id(token)
    assert detail_id is not None, '没有找到 pending 状态的提醒明细'
    
    response = requests.patch(f'{BASE_URL}/reminders/details/{detail_id}/status', 
                             headers=headers(token), 
                             json={'status': 'failed', 'failure_reason': '短信网关异常'})
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200, f'预期200，实际{response.status_code}'
    assert data['data']['status'] == 'failed'
    assert data['data']['failure_reason'] == '短信网关异常'
    assert data['data']['sent_at'] is not None
    
    print('✓ 状态更新为 failed 成功')

def test_update_status_to_ignored(token):
    print('\n=== 测试13: 更新提醒状态为 ignored ===')
    detail_id = get_pending_reminder_id(token)
    assert detail_id is not None, '没有找到 pending 状态的提醒明细'
    
    response = requests.patch(f'{BASE_URL}/reminders/details/{detail_id}/status', 
                             headers=headers(token), 
                             json={'status': 'ignored'})
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 200, f'预期200，实际{response.status_code}'
    assert data['data']['status'] == 'ignored'
    assert data['data']['sent_at'] is not None
    
    print('✓ 状态更新为 ignored 成功')

def test_update_status_invalid(token):
    print('\n=== 测试14: 验证无效状态更新 ===')
    detail_id = get_pending_reminder_id(token)
    assert detail_id is not None, '没有找到 pending 状态的提醒明细'
    
    response = requests.patch(f'{BASE_URL}/reminders/details/{detail_id}/status', 
                             headers=headers(token), 
                             json={'status': 'invalid_status'})
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 400, f'预期400，实际{response.status_code}'
    print('✓ 无效状态更新被正确拒绝')

def test_update_status_failed_without_reason(token):
    print('\n=== 测试15: 验证 failed 状态缺少失败原因 ===')
    detail_id = get_pending_reminder_id(token)
    assert detail_id is not None, '没有找到 pending 状态的提醒明细'
    
    response = requests.patch(f'{BASE_URL}/reminders/details/{detail_id}/status', 
                             headers=headers(token), 
                             json={'status': 'failed'})
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 400, f'预期400，实际{response.status_code}'
    print('✓ failed 状态缺少失败原因被正确拒绝')

def test_update_non_pending_status(token, sent_detail_id):
    print('\n=== 测试16: 验证非 pending 状态无法更新 ===')
    response = requests.patch(f'{BASE_URL}/reminders/details/{sent_detail_id}/status', 
                             headers=headers(token), 
                             json={'status': 'ignored'})
    print(f'状态码: {response.status_code}')
    data = response.json()
    print(f'响应: {json.dumps(data, ensure_ascii=False, indent=2)}')
    
    assert response.status_code == 400, f'预期400，实际{response.status_code}'
    assert '仅 pending 状态的记录可更新' in data['message']
    print('✓ 非 pending 状态更新被正确拒绝')

def test_batch_detail_with_status_summary(token, batch_id):
    print(f'\n=== 测试17: 批次详情包含状态汇总 (batch_id={batch_id}) ===')
    response = requests.get(f'{BASE_URL}/reminders/batches/{batch_id}', headers=headers(token))
    data = response.json()
    
    assert response.status_code == 200
    assert 'status_summary' in data['data']
    
    status_summary = data['data']['status_summary']
    print(f'状态汇总: {json.dumps(status_summary, ensure_ascii=False)}')
    
    assert 'pending' in status_summary
    assert 'sent' in status_summary
    assert 'failed' in status_summary
    assert 'ignored' in status_summary
    
    total = sum(status_summary.values())
    batch = data['data']['batch']
    assert total == batch['total_count'], f'状态汇总总数{total}应等于批次总数{batch["total_count"]}'
    
    print('✓ 批次详情状态汇总正确')

def test_ignored_not_duplicate(token, test_data):
    print('\n=== 测试18: 验证 ignored 记录不影响重复提醒判断 ===')
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("""
            UPDATE reminder_details
            SET status = 'pending', sent_at = NULL, operator_id = NULL, operator_name = NULL, failure_reason = NULL
            WHERE payment_id IN (
                SELECT id FROM payments WHERE plot_id = ?
            )
        """, (test_data['plot_dup_test'],))
        conn.commit()

        cursor.execute("""
            UPDATE reminder_details
            SET status = 'ignored', sent_at = datetime('now')
            WHERE payment_id IN (
                SELECT id FROM payments WHERE plot_id = ?
            ) AND status = 'pending'
        """, (test_data['plot_dup_test'],))
        conn.commit()
        print('✓ 已将测试记录重置并标记为 ignored')
    finally:
        conn.close()
    
    response = requests.post(f'{BASE_URL}/reminders/generate', headers=headers(token), json={
        'reminder_days': 30,
        'remark': '测试ignored去重'
    })
    data = response.json()
    
    print(f'状态码: {response.status_code}')
    print(f'成功数: {data["data"]["success_count"]}, 跳过数: {data["data"]["skip_count"]}')
    
    assert data['data']['success_count'] >= 1, 'ignored 记录不应阻止重新生成提醒'
    print('✓ ignored 记录不影响重复提醒判断')

def main():
    print('=' * 60)
    print('墓位续费提醒任务模块测试')
    print('=' * 60)
    
    token = login()
    print(f'登录成功，token获取成功')
    
    cleanup_reminder_data()
    
    test_data = setup_test_data()
    
    try:
        batch_id1 = test_generate_first_batch(token, test_data)
        sent_count = mark_normal_details_as_sent(token, batch_id1, limit=1)
        batch_id2 = test_generate_duplicate_batch(token, expected_skip=sent_count)
        first_batch_id = test_get_batches(token)
        test_get_batch_detail(token, first_batch_id)
        test_get_exceptions(token)
        test_search_by_contact_name(token)
        test_search_by_plot_number(token)
        test_search_by_phone(token)
        test_statistics(token)
        test_exception_types(token)
        
        sent_detail_id = test_update_status_to_sent(token)
        test_update_status_to_failed(token)
        test_update_status_to_ignored(token)
        test_update_status_invalid(token)
        test_update_status_failed_without_reason(token)
        test_update_non_pending_status(token, sent_detail_id)
        test_batch_detail_with_status_summary(token, first_batch_id)
        test_ignored_not_duplicate(token, test_data)
        
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

if __name__ == '__main__':
    main()
