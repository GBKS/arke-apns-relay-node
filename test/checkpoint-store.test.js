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
  await store.registerDevice('mb2', 'https://ark.example', 'auth', token(2), 'topic');

  await Promise.all([
    store.registerDevice('mb1', 'https://ark.example', 'auth', token(1), 'topic'),
    store.unregisterDevice('mb0', token(0), STAT_KEYS.lifetimeUnregistrations),
    store.recordMailboxMessage('mb1', 5, { vtxoCount: 1, totalSats: 1000 }, 'arkoor'),
    store.setAuthWakeState('mb1', { authExpiresAt: 1, preAttempts: 1, postAttempts: 0, lastSentAt: 2 }),
    store.set('mb2', 7)
  ]);

  const stats = await store.getStats();
  assert.equal(await store.countAllDevices(), 2);
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

async function mailboxRowCounts(store, mailboxId) {
  const counts = {};
  for (const table of ['device_registration', 'mailbox_registration', 'mailbox_checkpoint', 'auth_wake']) {
    const row = await store._get(`SELECT COUNT(*) AS cnt FROM ${table} WHERE mailbox_id = ?`, [mailboxId]);
    counts[table] = row.cnt;
  }
  return counts;
}

const NO_ROWS = { device_registration: 0, mailbox_registration: 0, mailbox_checkpoint: 0, auth_wake: 0 };

test('unregistering the last device deletes everything stored about the mailbox', async (t) => {
  const store = await openStore(t);
  await store.registerDevice('mb', 'https://ark.example', 'auth', token(0), 'topic');
  await store.registerDevice('mb', 'https://ark.example', 'auth', token(1), 'topic');
  await store.set('mb', 5);
  await store.setAuthWakeState('mb', { authExpiresAt: 1, preAttempts: 1, postAttempts: 0, lastSentAt: 2 });

  await store.unregisterDevice('mb', token(0));
  assert.deepEqual(await mailboxRowCounts(store, 'mb'), {
    device_registration: 1, mailbox_registration: 1, mailbox_checkpoint: 1, auth_wake: 1
  });

  assert.equal(await store.unregisterDevice('mb', token(1)), 1);
  assert.deepEqual(await mailboxRowCounts(store, 'mb'), NO_ROWS);
});

test('a worker finishing a message cannot bring a deleted mailbox back', async (t) => {
  const store = await openStore(t);
  await store.registerDevice('mb', 'https://ark.example', 'auth', token(0), 'topic');
  await store.unregisterDevice('mb', token(0));

  await store.recordMailboxMessage('mb', 9, { vtxoCount: 1, totalSats: 1000 }, 'arkoor');
  await store.set('mb', 10);
  await store.setAuthWakeState('mb', { authExpiresAt: 1, preAttempts: 1, postAttempts: 0, lastSentAt: 2 });

  assert.deepEqual(await mailboxRowCounts(store, 'mb'), NO_ROWS);
  // Aggregate counters still count the message.
  assert.equal((await store.getStats())[STAT_KEYS.lifetimeMailboxMessagesReceived], 1);
});

test('getCheckpoint tells a mailbox never read apart from one at checkpoint 0', async (t) => {
  const store = await openStore(t);
  await store.registerDevice('mb', 'https://ark.example', 'auth', token(0), 'topic');
  assert.equal(await store.getCheckpoint('mb'), null);
  assert.equal(await store.get('mb'), 0);

  await store.set('mb', 0);
  assert.equal(await store.getCheckpoint('mb'), 0);
  await store.set('mb', 42);
  assert.equal(await store.getCheckpoint('mb'), 42);
});

test('mailboxes registered before silent catch-up existed keep notifying', async (t) => {
  const store = await openStore(t);
  await store.registerDevice('mb', 'https://ark.example', 'auth', token(0), 'topic');
  await store.run('PRAGMA user_version = 0');

  await store.init();
  assert.equal(await store.getCheckpoint('mb'), 0);

  // Runs once: a mailbox registered after the upgrade is left to catch up.
  await store.registerDevice('mb2', 'https://ark.example', 'auth', token(1), 'topic');
  await store.init();
  assert.equal(await store.getCheckpoint('mb2'), null);
});

test('deleteMailbox leaves a mailbox whose authorization was renewed meanwhile', async (t) => {
  const store = await openStore(t);
  await store.registerDevice('mb', 'https://ark.example', 'old', token(0), 'topic');
  await store.registerDevice('mb', 'https://ark.example', 'new', token(0), 'topic');

  assert.equal(await store.deleteMailbox('mb', 'old'), false);
  assert.equal(await store.countDevices('mb'), 1);

  await store.set('mb', 3);
  assert.equal(await store.deleteMailbox('mb', 'new'), true);
  assert.deepEqual(await mailboxRowCounts(store, 'mb'), NO_ROWS);
});

test('deleteOrphans removes rows of mailboxes without devices', async (t) => {
  const store = await openStore(t);
  await store.registerDevice('kept', 'https://ark.example', 'auth', token(0), 'topic');
  await store.set('kept', 1);
  // What older versions left behind after the last device unregistered.
  await store.run(`INSERT INTO mailbox_registration (mailbox_id, ark_addr, authorization_hex) VALUES ('old', 'https://ark.example', 'auth')`);
  await store.run(`INSERT INTO mailbox_checkpoint (mailbox_id, checkpoint) VALUES ('old', 4), ('stray', 5)`);
  await store.run(`INSERT INTO auth_wake (mailbox_id, auth_expires_at) VALUES ('old', 1)`);

  assert.equal(await store.deleteOrphans(), 1);
  assert.deepEqual(await mailboxRowCounts(store, 'old'), NO_ROWS);
  assert.equal(await store.getCheckpoint('stray'), null);
  assert.equal(await store.getCheckpoint('kept'), 1);
  assert.equal(await store.countDevices('kept'), 1);
});

test('authorization_since only moves when the authorization changes', async (t) => {
  const store = await openStore(t);
  const since = async () => (await store._get('SELECT authorization_since FROM mailbox_registration WHERE mailbox_id = ?', ['mb'])).authorization_since;

  await store.registerDevice('mb', 'https://ark.example', 'first', token(0), 'topic');
  await store.run('UPDATE mailbox_registration SET authorization_since = 1000');
  await store.registerDevice('mb', 'https://ark.example', 'first', token(1), 'topic');
  assert.equal(await since(), 1000);

  await store.registerDevice('mb', 'https://ark.example', 'second', token(0), 'topic');
  assert.ok(await since() > 1000);
  assert.ok((await store.getMailboxesWithDevices())[0].authorization_since > 1000);
});

test('existing registrations get authorization_since from their last registration', async (t) => {
  const store = await openStore(t);
  await store.registerDevice('mb', 'https://ark.example', 'auth', token(0), 'topic');
  // A database from before the column existed.
  await store.run('ALTER TABLE mailbox_registration DROP COLUMN authorization_since');
  await store.run(`UPDATE mailbox_registration SET updated_at = '2026-09-26 12:00:00'`);

  await store.init();
  const row = await store._get('SELECT authorization_since FROM mailbox_registration');
  assert.equal(row.authorization_since, Date.UTC(2026, 8, 26, 12));
});
