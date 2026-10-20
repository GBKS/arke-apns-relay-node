const test = require('node:test');
const assert = require('node:assert/strict');
const { nextWakeDueAt, wakeLeadMs } = require('../src/auth-wake');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_LEAD = 2 * HOUR_MS;
const MAX_LEAD = 7 * DAY_MS;
const EXPIRES = Date.UTC(2026, 9, 26);

const lead = (lifetimeMs) => wakeLeadMs({
  expiresAt: EXPIRES,
  issuedAt: EXPIRES - lifetimeMs,
  minLeadMs: MIN_LEAD,
  maxLeadMs: MAX_LEAD
});

// Every wake a token gets before expiry, if it is sent the moment it is due.
function preExpiryWakes(leadMs, startMs = 0) {
  const wakes = [];
  let state = null;
  let nowMs = startMs;
  for (;;) {
    const dueAt = nextWakeDueAt({ expiresAt: EXPIRES, state, nowMs, leadMs, postExpiryAttempts: 7 });
    if (dueAt >= EXPIRES) return wakes;
    nowMs = Math.max(nowMs, dueAt);
    wakes.push((EXPIRES - nowMs) / HOUR_MS);
    state = { preAttempts: (state?.preAttempts || 0) + 1, postAttempts: 0, lastSentAt: nowMs };
  }
}

test('the lead is a quarter of the lifetime, between the limits', () => {
  assert.equal(lead(DAY_MS), 6 * HOUR_MS);
  assert.equal(lead(30 * DAY_MS), MAX_LEAD);
  assert.equal(lead(4 * HOUR_MS), MIN_LEAD);
  assert.equal(wakeLeadMs({ expiresAt: EXPIRES, issuedAt: null, minLeadMs: MIN_LEAD, maxLeadMs: MAX_LEAD }), MIN_LEAD);
});

test('a 2h lead keeps the original schedule', () => {
  assert.deepEqual(preExpiryWakes(MIN_LEAD), [2, 1]);
});

test('a 24h token is woken 6h and 3h before expiry', () => {
  assert.deepEqual(preExpiryWakes(lead(DAY_MS)), [6, 3]);
});

test('a 30-day token is woken once a day for its last week', () => {
  assert.deepEqual(preExpiryWakes(lead(30 * DAY_MS)), [168, 144, 120, 96, 72, 48, 24]);
});

test('a window entered late does not send its missed wakes at once', () => {
  // Deployed 2.5 days before expiry: wake now, then a day apart.
  assert.deepEqual(preExpiryWakes(lead(30 * DAY_MS), EXPIRES - 60 * HOUR_MS), [60, 36, 12]);
});

test('the first wake is never due before the token was registered', () => {
  for (const lifetime of [3 * HOUR_MS, DAY_MS, 7 * DAY_MS, 30 * DAY_MS, 365 * DAY_MS]) {
    const firstDue = nextWakeDueAt({ expiresAt: EXPIRES, state: null, nowMs: 0, leadMs: lead(lifetime), postExpiryAttempts: 7 });
    assert.ok(firstDue > EXPIRES - lifetime, `lifetime ${lifetime / HOUR_MS}h`);
  }
});

test('after the pre-expiry wakes come the post-expiry ones', () => {
  const state = { preAttempts: 7, postAttempts: 0, lastSentAt: EXPIRES - DAY_MS };
  const args = { expiresAt: EXPIRES, leadMs: MAX_LEAD, postExpiryAttempts: 7 };
  assert.equal(nextWakeDueAt({ ...args, state, nowMs: EXPIRES - HOUR_MS }), EXPIRES + HOUR_MS);
  assert.equal(nextWakeDueAt({ ...args, state: { ...state, postAttempts: 7 }, nowMs: EXPIRES + 8 * DAY_MS }), null);
});
