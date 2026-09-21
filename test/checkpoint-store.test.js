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
