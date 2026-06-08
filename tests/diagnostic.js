console.log('Step 1: Loading moment...');
const moment = require('moment');
console.log('Step 1: OK');

console.log('Step 2: Loading dbHelper...');
const { run, get, all, runInTransaction } = require('../utils/dbHelper');
console.log('Step 2: OK');

console.log('Step 3: Loading contractConstants...');
const constants = require('../services/contractConstants');
console.log('Step 3: OK');

console.log('Step 4: Loading plotAvailabilityService...');
const plotService = require('../services/plotAvailabilityService');
console.log('Step 4: OK');

console.log('Step 5: Loading contractStatusService...');
const contractService = require('../services/contractStatusService');
console.log('Step 5: OK');

console.log('Step 6: Loading operationLogService...');
const logService = require('../services/operationLogService');
console.log('Step 6: OK');

console.log('Step 7: Loading plotStatusSyncService...');
const plotSyncService = require('../services/plotStatusSyncService');
console.log('Step 7: OK');

console.log('Step 8: Loading reservationReleaseService...');
const reservationService = require('../services/reservationReleaseService');
console.log('Step 8: OK');

console.log('\nAll imports successful!');
console.log('\nAvailable exports:');
console.log('plotAvailabilityService:', Object.keys(plotService));
console.log('contractStatusService:', Object.keys(contractService));
console.log('operationLogService:', Object.keys(logService));
console.log('plotStatusSyncService:', Object.keys(plotSyncService));
console.log('reservationReleaseService:', Object.keys(reservationService));
console.log('contractConstants:', Object.keys(constants));
