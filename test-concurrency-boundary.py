#!/usr/bin/env python3
import requests
import json
import time
import threading
from datetime import datetime, timedelta
from collections import Counter

BASE_URL = 'http://localhost:3000'
API_URL = f'{BASE_URL}/api'
TIMESTAMP = str(int(time.time()))

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
        'row': 99,
        'col': int(plot_number.split('-')[-1]),
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
    response = requests.post(f'{API_URL}/contracts/reserve', headers=headers(token), json=body)
    return response.json()

def get_contract(token, contract_id):
    response = requests.get(f'{API_URL}/contracts/{contract_id}', headers=headers(token))
    return response.json().get('data')

def get_plot(token, plot_id):
    response = requests.get(f'{API_URL}/plots/{plot_id}', headers=headers(token))
    return response.json().get('data')

def check_plot_availability(token, plot_id):
    response = requests.get(f'{API_URL}/contracts/check-plot-availability',
        headers=headers(token), params={'plot_id': plot_id})
    return response.json().get('data')

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
    response = requests.get(f'{API_URL}/festival-schedules/available-slots',
        headers=headers(token), params={'date': date})
    return response.json().get('data', {}).get('slots', [])

def create_appointment(token, appointment_date, appointment_time, number_of_people, slot_id=None):
    body = {
        'appointment_date': appointment_date,
        'appointment_time': appointment_time,
        'number_of_people': number_of_people,
        'remark': '并发测试预约'
    }
    if slot_id:
        body['festival_time_slot_id'] = slot_id
    response = requests.post(f'{API_URL}/appointments', json=body, headers=headers(token))
    return response.json()

def cancel_appointment(token, appointment_id, reason='测试取消'):
    response = requests.post(f'{API_URL}/appointments/{appointment_id}/cancel',
        json={'reason': reason}, headers=headers(token))
    return response.json()

def get_appointment(token, appointment_id):
    response = requests.get(f'{API_URL}/appointments/{appointment_id}', headers=headers(token))
    return response.json().get('data')

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
    response = requests.post(f'{API_URL}/contracts/scan-expired-reservations',
        headers=headers(token), json={})
    return response.json()

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

        def try_reserve(user_num):
            contact_name = f'并发用户{user_num}'
            contact_phone = f'138{10000000 + int(TIMESTAMP[-7:]) + user_num}'
            result = reserve_plot(token, plot_id, contact_name, contact_phone, 7)
            with result_lock:
                thread_results.append({
                    'user': user_num,
                    'success': result.get('code') == 200,
                    'message': result.get('message'),
                    'contract_id': result.get('data', {}).get('id'),
                    'contract_no': result.get('data', {}).get('contract_no')
                })

        threads = []
        for i in range(2):
            t = threading.Thread(target=try_reserve, args=(i,))
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        print(f'\n  并发预留结果:')
        success_count = 0
        success_contract_id = None
        for r in sorted(thread_results, key=lambda x: x['user']):
            status = '成功' if r['success'] else '失败'
            print(f"    用户{r['user']}: {status} - {r['message']}")
            if r['success']:
                success_count += 1
                success_contract_id = r['contract_id']

        assert success_count == 1, f'应该只有1个成功，实际{success_count}个成功'
        print(f'  ✓ 只有1个合同预留成功，符合互斥要求')

        plot = get_plot(token, plot_id)
        assert plot.get('status') == '预留中', f'墓位状态应为预留中，实际为{plot.get("status")}'
        print(f'  ✓ 墓位状态: {plot.get("status")}')

        availability = check_plot_availability(token, plot_id)
        assert availability.get('available') == False, '预留后墓位应不可用'
        print(f'  ✓ 墓位可用性: 不可用')
        print(f'    原因: {availability.get("reason")}')

        third_result = reserve_plot(token, plot_id, '第三个用户', '13700000000', 7)
        assert third_result.get('code') != 200, '第三个用户也应该预留失败'
        print(f'  ✓ 第三个用户预留被正确阻止: {third_result.get("message")}')

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

        time.sleep(1)

        contract = get_contract(token, expired_contract_id)
        print(f'  合同状态: {contract.get("status_name")}')
        print(f'  预留过期时间: {contract.get("reserved_expires_at")}')

        availability = check_plot_availability(token, plot_id)
        print(f'  可用性检查: available={availability.get("available")}')
        if availability.get('is_expired'):
            print(f'  ✓ 系统已检测到预留过期')

        scan_result = scan_expired_reservations(token)
        print(f'  扫描过期预留: {scan_result.get("message")}')
        scan_data = scan_result.get('data', {})
        print(f"    发现过期: {scan_data.get('total_candidates')}")
        print(f"    成功释放: {scan_data.get('success_count')}")
        print(f"    释放失败: {scan_data.get('failed_count')}")

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
        test_date = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        CAPACITY = 10

        schedule_id = create_festival_schedule(token, f'并发测试节日{TIMESTAMP}', test_date, CAPACITY)
        assert schedule_id, '创建节日排班失败'
        print(f'  节日排班ID: {schedule_id}')
        print(f'  测试日期: {test_date}')
        print(f'  时段容量: {CAPACITY}人')

        slots = get_available_slots(token, test_date)
        slot_id = slots[0]['id']
        print(f'  时段ID: {slot_id}')
        print(f'  初始剩余容量: {slots[0]["remaining"]}')

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

        def try_book(user_num, people=2):
            result = create_appointment(token, test_date, '09:30', people, slot_id)
            with result_lock:
                thread_results.append({
                    'user': user_num,
                    'success': result.get('code') == 200,
                    'message': result.get('message'),
                    'appointment_id': result.get('data', {}).get('id')
                })

        threads = []
        for i in range(3):
            t = threading.Thread(target=try_book, args=(i,))
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        print(f'\n  并发预约结果:')
        success_count = 0
        success_id = None
        for r in sorted(thread_results, key=lambda x: x['user']):
            status = '成功' if r['success'] else '失败'
            print(f"    用户{r['user']}(2人): {status} - {r['message']}")
            if r['success']:
                success_count += 1
                success_id = r['appointment_id']
                appointment_ids.append(r['appointment_id'])

        assert success_count == 1, f'应该只有1个成功，实际{success_count}个成功'
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

        record_result(test_name, True)
        return appointment_ids, slot_id, test_date

    except Exception as e:
        record_result(test_name, False, str(e))
        import traceback
        traceback.print_exc()
        return [], None, None

def test_scenario_4_cancel_release_capacity(token, appointment_ids, slot_id, test_date):
    test_name = '场景4: 预约取消后容量释放'
    print(f'\n{"="*80}')
    print(f'🔍 {test_name}')
    print(f'{"="*80}\n')

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
        expected_booked = CAPACITY = 10
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

        appointment_ids, slot_id, test_date = test_scenario_3_festival_capacity_concurrent(token)

        test_scenario_4_cancel_release_capacity(token, appointment_ids, slot_id, test_date)

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

if __name__ == '__main__':
    main()
