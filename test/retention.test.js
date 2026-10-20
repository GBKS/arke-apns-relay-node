const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CheckpointStore } = require('../src/checkpoint-store');
const { RetentionJob, expiredMailboxes } = require('../src/retention');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20);

// 33-byte mailbox id, 8-byte little-endian expiry (seconds), 64-byte signature.
function authorization(expiresAtMs) {
  const bytes = Buffer.alloc(33 + 8 + 64);
  bytes.writeBigInt64LE(BigInt(Math.floor(expiresAtMs / 1000)), 33);
  return bytes.toString('hex');
}

const token = (i) => i.toString(16).padStart(64, '0');
const noopLogger = { info() {}, error() {} };

test('only mailboxes expired longer than the retention period are selected', () => {
  const mailboxes = [
    { mailbox_id: 'old', authorization_hex: authorization(NOW - 31 * DAY_MS) },
    { mailbox_id: 'recent', authorization_hex: authorization(NOW - 29 * DAY_MS) },
    { mailbox_id: 'live', authorization_hex: authorization(NOW + DAY_MS) },
    { mailbox_id: 'unreadable', authorization_hex: 'abcd' }
  ];
  assert.deepEqual(expiredMailboxes(mailboxes, NOW, 30 * DAY_MS).map((m) => m.mailbox_id), ['old']);
  assert.deepEqual(expiredMailboxes(mailboxes, NOW, 0), []);
});

test('the retention job deletes expired mailboxes and stops their workers', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
  const store = new CheckpointStore(path.join(dir, 'relay.sqlite'));
  await store.init();
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await store.registerDevice('old', 'https://ark.example', authorization(NOW - 40 * DAY_MS), token(0), 'topic');
  await store.registerDevice('live', 'https://ark.example', authorization(NOW + DAY_MS), token(1), 'topic');

  const stopped = [];
  const recorded = [];
  const job = new RetentionJob({
    store,
    workerManager: { stopWorker: (id) => stopped.push(id) },
    events: { record: (event) => recorded.push(event) },
    logger: noopLogger,
    config: { expiredMailboxRetentionDays: 30 }
  });

  assert.deepEqual(await job.run(NOW), { deleted: 1, orphans: 0 });
  assert.deepEqual(stopped, ['old']);
  assert.equal(recorded[0].name, 'expired_deleted');
  assert.equal(await store.getMailbox('old'), null);
  assert.equal(await store.countDevices('old'), 0);
  assert.notEqual(await store.getMailbox('live'), null);
});
