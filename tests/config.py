#!/usr/bin/env python3
import os

PORT = int(os.environ.get('TEST_PORT', os.environ.get('PORT', '3001')))
BASE_URL = os.environ.get('TEST_BASE_URL', f'http://localhost:{PORT}')
API_URL = f'{BASE_URL}/api'

TEST_USERNAME = os.environ.get('TEST_USERNAME', 'admin')
TEST_PASSWORD = os.environ.get('TEST_PASSWORD', 'admin123')

TEST_DB_PATH = os.environ.get('TEST_DB_PATH', os.environ.get('DB_PATH', './data/test-cemetery.db'))
