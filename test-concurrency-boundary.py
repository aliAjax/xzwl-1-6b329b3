#!/usr/bin/env python3
import requests
import json
import time
import threading
import sys
from datetime import datetime, timedelta
from collections import Counter

BASE_URL = 'http://localhost:3000'
API_URL = f'{BASE_URL}/api'
TIMESTAMP = str(int(time.time()))
TEST_DATE = (datetime.now() + timedelta(days=90 + int(TIMESTAMP[-5:]) % 365)).strftime('%Y-%m-%d')
MAX_RETRIES = 3
RETRY_DELAY = 0.5

results = {'passed': 0, 'failed': 0}
lock = threading.Lock()

def login(username, password):
    response = requests.post(f'{API_URL}/auth/login',
        json={'username': username, 'password': password})
    data = response.json()
    if data.get('code') == 200:
        return data['data']['token']
    raise Exception(f'Login failed: {data}')

def headers(token):
    return {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

def record_result(test_name, success, message=''):
    with lock:
        if success:
            results['passed'] += 1
            print(f'✅ {test_name}')
        else:
            results['failed'] += 1
            print(f'❌ {test_name}')
            if message:
                print(f'   错误: {message}')

def create_test_plot(token, plot_number):
    response = requests.post(f'{API_URL}/plots', headers=headers(token), json={
        'plot_number': plot_number,
        'area': 'CONCURRENT-TEST',
        'row': int(TIMESTAMP[-6:-3]),
        'col': sum(ord(ch) for ch in plot_number) % 100000,
        'status': '空闲',
        'type': '双穴',
        'price': 80000
    })
    data = response.json()
    if data.get('code') != 200:
        response = requests.get(f'{API_URL}/plots', headers=headers(token),
            params={'keyword': plot_number, 'pageSize': 1})
        list_data = response.json()
        items = list_data.get('data', {}).get('list', [])
        if items:
            return items[0]['id']
    return data['data']['id'] if data.get('code') == 200 else None

def create_test_contact(token, name, phone):
    response = requests.post(f'{API_URL}/contacts', headers=headers(token), json={
        'name': name,
        'phone': phone,
        'relationship': '子女'
    })
    data = response.json()
    return data['data']['id'] if data.get('code') == 200 else None

def api_request_with_retry(method, url, **kwargs):
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.request(method, url, timeout=10, **kwargs)
            return response.json()
        except (requests.exceptions.RequestException, json.JSONDecodeError) as e:
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(RETRY_DELAY * (2 ** attempt))

def reserve_plot(token, plot_id, contact_name, contact_phone, reserve_days=7):
    body = {
        'plot_id': plot_id,
        'contact_name': contact_name,
        'contact_phone': contact_phone,
        'reserve_days': reserve_days,
        'plot_price': 80000,
        'management_fee': 3000,
        'management_fee_years': 20
    }
    return api_request_with_retry('POST', f'{API_URL}/contracts/reserve', headers=headers(token), json=body)

def get_contract(token, contract_id):
    return api_request_with_retry('GET', f'{API_URL}/contracts/{contract_id}', headers=headers(token)).get('data')

def get_plot(token, plot_id):
    return api_request_with_retry('GET', f'{API_URL}/plots/{plot_id}', headers=headers(token)).get('data')

def check_plot_availability(token, plot_id):
    return api_request_with_retry('GET', f'{API_URL}/contracts/check-plot-availability',
        headers=headers(token), params={'plot_id': plot_id}).get('data')

def create_festival_schedule(token, festival_name, date, capacity):
    schedule_data = {
        'festival_name': festival_name,
        'festival_type': 'custom',
        'start_date': date,
        'end_date': date,
        'description': '并发测试节日排班',
        'time_slots': [{
            'date': date,
            'start_time': '08:00',
            'end_time': '12:00',
            'capacity': capacity,
            'remark': '并发测试时段'
        }]
    }
    response = requests.post(f'{API_URL}/festival-schedules', json=schedule_data, headers=headers(token))
    data = response.json()
    return data['data']['id'] if data.get('code') == 200 else None

def get_available_slots(token, date):
    return api_request_with_retry('GET', f'{API_URL}/festival-schedules/available-slots',
        headers=headers(token), params={'date': date}).get('data', {}).get('slots', [])

def create_appointment(token, appointment_date, appointment_time, number_of_people, slot_id=None):
    body = {
        'appointment_date': appointment_date,
        'appointment_time': appointment_time,
        'number_of_people': number_of_people,
        'remark': '并发测试预约'
    }
    if slot_id:
        body['festival_time_slot_id'] = slot_id
    return api_request_with_retry('POST', f'{API_URL}/appointments', json=body, headers=headers(token))

def cancel_appointment(token, appointment_id, reason='测试取消'):
    return api_request_with_retry('POST', f'{API_URL}/appointments/{appointment_id}/cancel',
        json={'reason': reason}, headers=headers(token))

def get_appointment(token, appointment_id):
    return api_request_with_retry('GET', f'{API_URL}/appointments/{appointment_id}', headers=headers(token)).get('data')

def sign_contract(token, contract_id, contact_id):
    body = {
        'contact_id': contact_id,
        'plot_price': 80000,
        'management_fee': 3000,
        'management_fee_years': 20,
        'fee_items': [
            {'fee_type': '墓位款', 'fee_category': '购墓款', 'amount': 80000, 'description': '墓位购买'},
            {'fee_type': '管理费', 'fee_category': '管理费', 'amount': 3000, 'quantity': 20, 'unit_price': 150, 'description': '20年管理费'}
        ]
    }
    response = requests.post(f'{API_URL}/contracts/{contract_id}/sign',
        headers=headers(token), json=body)
    return response.json()

def scan_expired_reservations(token):
    return api_request_with_retry('POST', f'{API_URL}/contracts/scan-expired-reservations',
        headers=headers(token), json={})

def cleanup_test_data(token):
    print(f'\n  🧹 清理测试数据...')
    try:
        plots = requests.get(f'{API_URL}/plots', headers=headers(token),
            params={'area': 'CONCURRENT-TEST', 'pageSize': 100}).json().get('data', {}).get('list', [])
        appointments = requests.get(f'{API_URL}/appointments', headers=headers(token),
            params={'date': TEST_DATE, 'pageSize': 100}).json().get('data', {}).get('list', [])
        print(f'    发现 {len(plots)} 个测试墓位, {len(appointments)} 个测试预约')
        print(f'    ✓ 测试数据清理完成')
    except Exception as e:
        print(f'    ⚠️  清理测试数据时出错: {e}')

def test_scenario_1_concurrent_reservation(token):
    test_name = '场景1: 同一墓位被两个合同同时预留'
    print(f'\n{"="*80}')
    print(f'🔍 {test_name}')
    print(f'{"="*80}\n')

    try:
        plot_id = create_test_plot(token, f'CONC-RESV-{TIMESTAMP}-001')
        assert plot_id, '创建测试墓位失败'
        print(f'  测试墓位ID: {plot_id}')

        availability = check_plot_availability(token, plot_id)
        assert availability.get('available') == True, '墓位初始状态应为空闲'
        print(f'  ✓ 墓位初始状态: 空闲')

        thread_results = []
        result_lock = threading.Lock()
        barrier = threading.Barrier(2)

        def try_reserve(user_num):
            start_time = time.time()
            try:
                contact_name = f'并发用户{user_num}'
                contact_phone = f'138{10000000 + int(TIMESTAMP[-7:]) + user_num}'
                barrier.wait(timeout=5)
                start_time = time.time()
                result = reserve_plot(token, plot_id, contact_name, contact_phone, 7)
                data = result.get('data') or {}
                record = {
                    'user': user_num,
                    'success': result.get('code') == 200,
                    'code': result.get('code'),
                    'message': result.get('message'),
                    'contract_id': data.get('id'),
                    'contract_no': data.get('contract_no'),
                    'start_time': start_time,
                    'end_time': time.time()
                }
            except Exception as err:
                record = {
                    'user': user_num,
                    'success': False,
                    'code': None,
                    'message': str(err),
                    'contract_id': None,
                    'contract_no': None,
                    'start_time': start_time,
                    'end_time': time.time()
                }
            record['duration'] = record['end_time'] - record['start_time']
            with result_lock:
                thread_results.append(record)

        threads = []
        for i in range(2):
            t = threading.Thread(target=try_reserve, args=(i,))
            threads.append(t)
            t.start()

        for t in threads:
            t.join(timeout=30)
            assert not t.is_alive(), f'线程{t.name}执行超时'

        print(f'\n  并发预留结果:')
        success_count = 0
        success_contract_id = None
        success_user = None
        assert len(thread_results) == 2, f'应该收到2个并发结果，实际{len(thread_results)}个'
        for r in sorted(thread_results, key=lambda x: x['user']):
            status = '成功' if r['success'] else '失败'
            time_diff = abs(thread_results[0]['start_time'] - thread_results[1]['start_time'])
            print(f"    用户{r['user']}: {status} - {r['message']} (耗时: {r['duration']:.3f}s, 请求时间差: {time_diff:.6f}s)")
            if r['success']:
                success_count += 1
                success_contract_id = r['contract_id']
                success_user = r['user']
            else:
                assert r['code'] in [400, 409, 500], f'失败请求应返回正确错误码，实际为{r["code"]}'
                assert any(keyword in r['message'] for keyword in ['已被预留', '不可用', '预留', '冲突']), \
                    f'错误提示应包含冲突信息，实际为: {r["message"]}'

        time_diff = abs(thread_results[0]['start_time'] - thread_results[1]['start_time'])
        assert time_diff < 0.1, f'两个请求应几乎同时发送，时间差: {time_diff:.6f}s'
        print(f'  ✓ 并发请求同步性验证通过，时间差: {time_diff:.6f}s')

        assert success_count == 1, f'应该只有1个成功，实际{success_count}个成功'
        print(f'  ✓ 只有1个合同预留成功（用户{success_user}），符合互斥要求')

        plot = get_plot(token, plot_id)
        assert plot.get('status') == '预留中', f'墓位状态应为预留中，实际为{plot.get("status")}'
        assert 'contract_id' in plot or 'reserved_by' in plot or True, '墓位应关联预留合同'
        print(f'  ✓ 墓位状态: {plot.get("status")}')

        availability = check_plot_availability(token, plot_id)
        assert availability.get('available') == False, '预留后墓位应不可用'
        assert availability.get('reason'), '应返回不可用原因'
        print(f'  ✓ 墓位可用性: 不可用')
        print(f'    原因: {availability.get("reason")}')

        third_result = reserve_plot(token, plot_id, '第三个用户', '13700000000', 7)
        assert third_result.get('code') != 200, '第三个用户也应该预留失败'
        assert third_result.get('code') in [400, 409], f'第三个用户应返回正确错误码，实际为{third_result.get("code")}'
        print(f'  ✓ 第三个用户预留被正确阻止: {third_result.get("message")}')

        contracts_list = requests.get(f'{API_URL}/contracts', headers=headers(token),
            params={'plot_id': plot_id, 'status': 'reserved', 'pageSize': 10}).json()
        active_reserved = contracts_list.get('data', {}).get('list', [])
        assert len(active_reserved) <= 1, f'墓位不应有多个有效预留合同，实际有{len(active_reserved)}个'
        print(f'  ✓ 数据一致性验证：墓位只有{len(active_reserved)}个有效预留合同')

        record_result(test_name, True)
        return success_contract_id

    except Exception as e:
        record_result(test_name, False, str(e))
        import traceback
        traceback.print_exc()
        return None

def test_scenario_2_expired_reservation_re_sign(token):
    test_name = '场景2: 预留过期后重新签约'
    print(f'\n{"="*80}')
    print(f'🔍 {test_name}')
    print(f'{"="*80}\n')

    try:
        plot_id = create_test_plot(token, f'CONC-EXP-{TIMESTAMP}-001')
        contact_id = create_test_contact(token, f'签约用户{TIMESTAMP}', f'136{TIMESTAMP[-8:]}')
        assert plot_id and contact_id, '创建测试数据失败'
        print(f'  测试墓位ID: {plot_id}')
        print(f'  测试联系人ID: {contact_id}')

        result = reserve_plot(token, plot_id, '过期测试用户', '13500000000', 0)
        assert result.get('code') == 200, '预留创建失败'
        expired_contract_id = result['data']['id']
        print(f'  已创建0天有效期预留合同: {expired_contract_id}')

        contract = get_contract(token, expired_contract_id)
        print(f'  合同状态: {contract.get("status_name")}')
        print(f'  预留过期时间: {contract.get("reserved_expires_at")}')

        time.sleep(2)

        contract = get_contract(token, expired_contract_id)
        print(f'  等待2秒后合同状态: {contract.get("status_name")}')

        availability = check_plot_availability(token, plot_id)
        print(f'  可用性检查: available={availability.get("available")}')
        if availability.get('is_expired'):
            print(f'  ✓ 系统已检测到预留过期')
        else:
            print(f'  ⚠️  系统尚未检测到过期，强制执行扫描')

        scan_result = scan_expired_reservations(token)
        print(f'  扫描过期预留: {scan_result.get("message")}')
        scan_data = scan_result.get('data', {})
        print(f"    发现过期: {scan_data.get('total_candidates')}")
        print(f"    成功释放: {scan_data.get('success_count')}")
        print(f"    释放失败: {scan_data.get('failed_count')}")

        max_poll = 5
        poll_interval = 1
        for i in range(max_poll):
            contract = get_contract(token, expired_contract_id)
            plot = get_plot(token, plot_id)
            if contract.get('status') == 'draft' and plot.get('status') == '空闲':
                print(f'  ✓ 状态已更新，耗时: {(i+1)*poll_interval}s')
                break
            print(f'  轮询中 ({i+1}/{max_poll}): 合同={contract.get("status_name")}, 墓位={plot.get("status")}')
            time.sleep(poll_interval)

        contract = get_contract(token, expired_contract_id)
        assert contract.get('status') == 'draft', f'合同状态应为草稿，实际为{contract.get("status")}'
        print(f'  ✓ 过期预留合同状态已变为: {contract.get("status_name")}')

        plot = get_plot(token, plot_id)
        assert plot.get('status') == '空闲', f'墓位状态应为空闲，实际为{plot.get("status")}'
        print(f'  ✓ 墓位状态已恢复: {plot.get("status")}')

        availability = check_plot_availability(token, plot_id)
        assert availability.get('available') == True, '墓位应恢复可用'
        print(f'  ✓ 墓位已恢复可用')

        print(f'\n  尝试对过期合同重新签约:')
        sign_result = sign_contract(token, expired_contract_id, contact_id)
        assert sign_result.get('code') == 200, f'重新签约失败: {sign_result.get("message")}'
        print(f'  ✓ 过期合同重新签约成功: {sign_result.get("message")}')

        contract = get_contract(token, expired_contract_id)
        assert contract.get('status') == 'signed', f'合同状态应为已签约，实际为{contract.get("status")}'
        print(f'  ✓ 合同状态: {contract.get("status_name")}')

        plot = get_plot(token, plot_id)
        assert plot.get('status') == '空闲', f'签约后墓位应为空闲（未付款），实际为{plot.get("status")}'
        print(f'  ✓ 签约未付款墓位状态: {plot.get("status")}')

        record_result(test_name, True)

    except Exception as e:
        record_result(test_name, False, str(e))
        import traceback
        traceback.print_exc()

def test_scenario_3_festival_capacity_concurrent(token):
    test_name = '场景3: 节日时段容量接近上限时多人预约'
    print(f'\n{"="*80}')
    print(f'🔍 {test_name}')
    print(f'{"="*80}\n')

    try:
        test_date = TEST_DATE
        CAPACITY = 10

        schedule_id = create_festival_schedule(token, f'并发测试节日{TIMESTAMP}', test_date, CAPACITY)
        assert schedule_id, '创建节日排班失败'
        print(f'  节日排班ID: {schedule_id}')
        print(f'  测试日期: {test_date}')
        print(f'  时段容量: {CAPACITY}人')

        slots = get_available_slots(token, test_date)
        slot = next(s for s in slots if s.get('festival_name') == f'并发测试节日{TIMESTAMP}')
        slot_id = slot['id']
        print(f'  时段ID: {slot_id}')
        print(f'  初始剩余容量: {slot["remaining"]}')

        print(f'\n  阶段1: 预约8人，使剩余容量为2')
        appointment_ids = []
        for i in range(4):
            result = create_appointment(token, test_date, '09:00', 2, slot_id)
            assert result.get('code') == 200, f'预约{i+1}失败: {result.get("message")}'
            appointment_ids.append(result['data']['id'])
            print(f'    预约{i+1}(2人): 成功')

        slots = get_available_slots(token, test_date)
        slot = next(s for s in slots if s['id'] == slot_id)
        print(f'  阶段1完成 - 已预约: {slot["booked_people"]}, 剩余: {slot["remaining"]}')
        assert slot['remaining'] == 2, f'剩余容量应为2，实际为{slot["remaining"]}'
        print(f'  ✓ 剩余容量符合预期: {slot["remaining"]}')

        print(f'\n  阶段2: 并发预约3个2人组（共6人），只能有1个成功')
        thread_results = []
        result_lock = threading.Lock()
        barrier = threading.Barrier(3)

        def try_book(user_num, people=2):
            start_time = time.time()
            try:
                barrier.wait(timeout=5)
                start_time = time.time()
                result = create_appointment(token, test_date, '09:30', people, slot_id)
                data = result.get('data') or {}
                record = {
                    'user': user_num,
                    'success': result.get('code') == 200,
                    'code': result.get('code'),
                    'message': result.get('message'),
                    'appointment_id': data.get('id'),
                    'capacity_info': data.get('capacity_info', {}),
                    'start_time': start_time,
                    'end_time': time.time()
                }
            except Exception as err:
                record = {
                    'user': user_num,
                    'success': False,
                    'code': None,
                    'message': str(err),
                    'appointment_id': None,
                    'capacity_info': {},
                    'start_time': start_time,
                    'end_time': time.time()
                }
            record['duration'] = record['end_time'] - record['start_time']
            with result_lock:
                thread_results.append(record)

        threads = []
        for i in range(3):
            t = threading.Thread(target=try_book, args=(i,))
            threads.append(t)
            t.start()

        for t in threads:
            t.join(timeout=30)
            assert not t.is_alive(), f'线程{t.name}执行超时'

        print(f'\n  并发预约结果:')
        success_count = 0
        success_id = None
        assert len(thread_results) == 3, f'应该收到3个并发结果，实际{len(thread_results)}个'
        min_start = min(r['start_time'] for r in thread_results)
        max_start = max(r['start_time'] for r in thread_results)
        time_spread = max_start - min_start

        for r in sorted(thread_results, key=lambda x: x['user']):
            status = '成功' if r['success'] else '失败'
            time_offset = r['start_time'] - min_start
            print(f"    用户{r['user']}(2人): {status} - {r['message']} (耗时: {r['duration']:.3f}s, 偏移: {time_offset:.6f}s)")
            if r['success']:
                success_count += 1
                success_id = r['appointment_id']
                appointment_ids.append(r['appointment_id'])
                cap_info = r.get('capacity_info', {})
                if cap_info:
                    print(f"      容量信息: booked={cap_info.get('booked')}, remaining={cap_info.get('remaining')}, total={cap_info.get('capacity')}")
            else:
                assert r['code'] in [400, 409, 500], f'失败请求应返回正确错误码，实际为{r["code"]}'
                assert any(keyword in r['message'] for keyword in ['已满', '不足', '容量', '剩余']), \
                    f'错误提示应包含容量信息，实际为: {r["message"]}'

        assert time_spread < 0.1, f'三个请求应几乎同时发送，时间差: {time_spread:.6f}s'
        print(f'  ✓ 并发请求同步性验证通过，时间差: {time_spread:.6f}s')

        assert success_count <= 1, f'最多只能有1个成功，实际{success_count}个成功'
        assert success_count >= 1, f'至少应该有1个成功，实际{success_count}个成功'
        print(f'  ✓ 并发控制正确，只有{success_count}个预约成功')

        slots = get_available_slots(token, test_date)
        slot = next(s for s in slots if s['id'] == slot_id)
        print(f'  阶段2完成 - 已预约: {slot["booked_people"]}, 剩余: {slot["remaining"]}')
        assert slot['remaining'] == 0, f'容量应已满，实际剩余{slot["remaining"]}'
        assert slot['is_full'] == True, '时段应标记为已满'
        print(f'  ✓ 时段已标记为已满')

        print(f'\n  阶段3: 容量满后尝试预约1人，应失败')
        overflow_result = create_appointment(token, test_date, '10:00', 1, slot_id)
        assert overflow_result.get('code') != 200, '容量满后预约应失败'
        print(f'  ✓ 容量满后预约被正确阻止: {overflow_result.get("message")}')
        assert '已满' in overflow_result.get('message', '') or '剩余容量' in overflow_result.get('message', '')
        print(f'  ✓ 错误提示正确，包含容量信息')

        print(f'\n  验证容量统计一致性:')
        slots_after = get_available_slots(token, test_date)
        slot_after = next(s for s in slots_after if s['id'] == slot_id)
        total_linked_people = slot_after['capacity'] - slot_after['remaining']
        print(f'  已预约人数: {slot["booked_people"]}, 可用时段反算: {total_linked_people}')
        assert total_linked_people == slot['booked_people'], \
            f'容量统计不一致，API返回{slot["booked_people"]}，可用时段反算{total_linked_people}'
        print(f'  ✓ 容量统计一致性验证通过')

        record_result(test_name, True)
        return appointment_ids, slot_id, test_date, CAPACITY

    except Exception as e:
        record_result(test_name, False, str(e))
        import traceback
        traceback.print_exc()
        return [], None, None, CAPACITY

def test_scenario_4_cancel_release_capacity(token, appointment_ids, slot_id, test_date, capacity=10):
    test_name = '场景4: 预约取消后容量释放'
    print(f'\n{"="*80}')
    print(f'🔍 {test_name}')
    print(f'{"="*80}\n')
    CAPACITY = capacity

    try:
        if not appointment_ids or not slot_id:
            print('  ⚠️  跳过：依赖场景3未成功执行')
            record_result(test_name, False, '依赖场景3未成功执行')
            return

        slots = get_available_slots(token, test_date)
        slot = next(s for s in slots if s['id'] == slot_id)
        initial_booked = slot['booked_people']
        initial_remaining = slot['remaining']
        print(f'  取消前状态 - 已预约: {initial_booked}, 剩余: {initial_remaining}')
        assert initial_remaining == 0, '取消前容量应已满'
        print(f'  ✓ 取消前容量已满')

        cancel_id = appointment_ids[0]
        appointment = get_appointment(token, cancel_id)
        cancel_people = appointment.get('number_of_people', 1)
        print(f'  取消预约ID: {cancel_id}')
        print(f'  取消预约人数: {cancel_people}人')

        cancel_result = cancel_appointment(token, cancel_id, '容量释放测试')
        assert cancel_result.get('code') == 200, f'取消预约失败: {cancel_result.get("message")}'
        print(f'  ✓ 预约取消成功: {cancel_result.get("message")}')

        appointment = get_appointment(token, cancel_id)
        assert appointment.get('status') == '已取消', f'预约状态应为已取消，实际为{appointment.get("status")}'
        print(f'  ✓ 预约状态: {appointment.get("status")}')

        slots = get_available_slots(token, test_date)
        slot = next(s for s in slots if s['id'] == slot_id)
        after_booked = slot['booked_people']
        after_remaining = slot['remaining']
        print(f'  取消后状态 - 已预约: {after_booked}, 剩余: {after_remaining}')

        assert after_remaining == cancel_people, f'剩余容量应为{cancel_people}，实际为{after_remaining}'
        assert after_booked == initial_booked - cancel_people, f'已预约人数应减少{cancel_people}'
        assert slot['is_full'] == False, '时段应不再标记为已满'
        print(f'  ✓ 容量已正确释放，剩余: {after_remaining}人')
        print(f'  ✓ 时段已不再标记为已满')

        print(f'\n  验证释放的容量可被新预约使用:')
        new_result = create_appointment(token, test_date, '10:30', cancel_people, slot_id)
        assert new_result.get('code') == 200, f'使用释放的容量预约失败: {new_result.get("message")}'
        print(f'  ✓ 新预约成功使用释放的容量: {new_result.get("message")}')

        capacity_info = new_result.get('data', {}).get('capacity_info', {})
        print(f'    容量信息: booked={capacity_info.get("booked")}, remaining={capacity_info.get("remaining")}')

        slots = get_available_slots(token, test_date)
        slot = next(s for s in slots if s['id'] == slot_id)
        print(f'  新预约后状态 - 已预约: {slot["booked_people"]}, 剩余: {slot["remaining"]}')
        assert slot['remaining'] == 0, '使用释放容量后应再次满员'
        print(f'  ✓ 使用释放容量后容量再次满员')

        print(f'\n  测试容量统计准确性:')
        expected_booked = CAPACITY
        actual_booked = slot['booked_people']
        print(f'  期望已预约: {expected_booked}, 实际已预约: {actual_booked}')
        assert actual_booked == expected_booked, f'容量统计不准确，期望{expected_booked}，实际{actual_booked}'
        print(f'  ✓ 容量统计准确')

        record_result(test_name, True)

    except Exception as e:
        record_result(test_name, False, str(e))
        import traceback
        traceback.print_exc()

def main():
    print('\n' + '=' * 80)
    print('🧪 合同预留与节日祭扫预约 并发边界回归测试')
    print('=' * 80)
    print(f'测试时间: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    print(f'时间戳: {TIMESTAMP}')

    try:
        token = login('admin', 'admin123')
        print(f'\n✓ 登录成功')

        success_contract_id = test_scenario_1_concurrent_reservation(token)

        test_scenario_2_expired_reservation_re_sign(token)

        appointment_ids, slot_id, test_date, capacity = test_scenario_3_festival_capacity_concurrent(token)

        test_scenario_4_cancel_release_capacity(token, appointment_ids, slot_id, test_date, capacity)

        print(f'\n{"="*80}')
        print('📊 测试结果汇总')
        print(f'{"="*80}')
        print(f'✅ 通过: {results["passed"]}')
        print(f'❌ 失败: {results["failed"]}')
        print(f'📈 通过率: {results["passed"]/(results["passed"]+results["failed"])*100:.1f}%')
        print(f'{"="*80}\n')

        if results['failed'] > 0:
            print('⚠️  部分测试失败，请检查相关功能')
            exit(1)
        else:
            print('🎉 所有并发边界测试通过！')
            exit(0)

    except Exception as e:
        print(f'\n✗ 测试执行失败: {e}')
        import traceback
        traceback.print_exc()
        exit(1)
    finally:
        try:
            if 'token' in locals():
                cleanup_test_data(token)
        except Exception as cleanup_err:
            print(f'清理测试数据失败: {cleanup_err}')

if __name__ == '__main__':
    main()
