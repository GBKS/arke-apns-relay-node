const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CheckpointStore, STAT_KEYS } = require('../src/checkpoint-store');

async function openStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-store-'));
  const store = new CheckpointStore(path.join(dir, 'relay.sqlite'));
  await store.init();
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

const token = (i) => i.toString(16).padStart(64, '0');

test('concurrent registrations all succeed', async (t) => {
  const store = await openStore(t);
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => store.registerDevice(`mb${i}`, 'https://ark.example', 'auth', token(i), 'topic'))
  );

  assert.deepEqual(results.filter((r) => r.status === 'rejected'), []);
  assert.equal(await store.countAllDevices(), 20);
  assert.equal((await store.getAllMailboxes()).length, 20);
  assert.equal((await store.getStats())[STAT_KEYS.lifetimeRegistrations], 20);
});

test('concurrent writes of every kind all succeed', async (t) => {
  const store = await openStore(t);
  await store.registerDevice('mb0', 'https://ark.example', 'auth', token(0), 'topic');

  await Promise.all([
    store.registerDevice('mb1', 'https://ark.example', 'auth', token(1), 'topic'),
    store.unregisterDevice('mb0', token(0), STAT_KEYS.lifetimeUnregistrations),
    store.recordMailboxMessage('mb1', 5, { vtxoCount: 1, totalSats: 1000 }, 'arkoor'),
    store.setAuthWakeState('mb1', { authExpiresAt: 1, preAttempts: 1, postAttempts: 0, lastSentAt: 2 }),
    store.set('mb2', 7)
  ]);

  const stats = await store.getStats();
  assert.equal(await store.countAllDevices(), 1);
  assert.equal(stats[STAT_KEYS.lifetimeUnregistrations], 1);
  assert.equal(stats[STAT_KEYS.lifetimeMailboxMessagesReceivedArkoor], 1);
  assert.equal(await store.get('mb1'), 5);
  assert.equal(await store.get('mb2'), 7);
  assert.equal((await store.getAuthWakeState('mb1')).preAttempts, 1);
});

test('a failed registration saves nothing and does not block later writes', async (t) => {
  const store = await openStore(t);

  // Fail after the mailbox and device rows are written, before COMMIT.
  const incrementStats = store._incrementStats;
  store._incrementStats = async () => { throw new Error('boom'); };
  await assert.rejects(
    store.registerDevice('mb0', 'https://ark.example', 'auth', token(0), 'topic'),
    /boom/
  );
  store._incrementStats = incrementStats;
  assert.equal(await store.getMailbox('mb0'), null);
  assert.equal(await store.countAllDevices(), 0);

  await store.registerDevice('mb1', 'https://ark.example', 'auth', token(1), 'topic');
  assert.equal(await store.countAllDevices(), 1);
});

test('a new device beyond maxDevices replaces the least recently registered ones', async (t) => {
  const store = await openStore(t);
  const register = (i, opts) => store.registerDevice('mb', 'https://ark.example', 'auth', token(i), 'topic', opts);

  for (let i = 0; i < 3; i += 1) await register(i);
  // Device 0 re-registered most recently, so device 1 is now the oldest.
  await store.run(`UPDATE device_registration SET updated_at = '2020-01-01 00:00:00'`);
  await store.run(`UPDATE device_registration SET updated_at = '2020-01-02 00:00:00' WHERE device_token = ?`, [token(0)]);

  const result = await register(3, { maxDevices: 2 });
  assert.equal(result.inserted, true);
  assert.equal(result.evicted, 2);
  const remaining = (await store.getDevices('mb')).map((row) => row.device_token).sort();
  assert.deepEqual(remaining, [token(0), token(3)]);

  // Re-registering a known device never evicts anything.
  assert.equal((await register(0, { maxDevices: 1 })).evicted, 0);
  assert.equal(await store.countDevices('mb'), 2);
  assert.equal(await store.countMailboxesWithDevices(), 1);
});
