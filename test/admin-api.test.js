const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAuthRefresh } = require('../src/admin-api');

test('refreshes_by_trigger counts registrations only', () => {
  const summary = summarizeAuthRefresh([
    { category: 'registration', name: 'refresh', outcome: 'ok', code: 'foreground', count: 3 },
    { category: 'registration', name: 'refresh', outcome: 'ok', code: null, count: 1 },
    { category: 'registration', name: 'refresh_after_wake', outcome: 'ok', code: 'wake_push', count: 2 },
    { category: 'registration', name: 'expired_deleted', outcome: 'info', code: null, count: 156 },
    { category: 'apns', name: 'auth_wake', outcome: 'ok', code: null, count: 5 },
    { category: 'apns', name: 'auth_wake', outcome: 'fail', code: 'Unregistered', count: 1 }
  ]);

  assert.deepEqual(summary, {
    wakes_sent: 5,
    wakes_failed: 1,
    refreshes_after_wake: 2,
    refreshes_by_trigger: { foreground: 3, unspecified: 1, wake_push: 2 }
  });
});
