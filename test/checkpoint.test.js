const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const protoLoader = require('@grpc/proto-loader');
const { toCheckpoint } = require('../src/checkpoint');
const { PROTO_LOADER_OPTIONS } = require('../src/mailbox-client');

// Past 2^53, so a JS number would round it down to ...544.
const CHECKPOINT = '1878100646160236545';

test('toCheckpoint keeps uint64 values exact', () => {
  assert.equal(toCheckpoint(CHECKPOINT), CHECKPOINT);
  assert.equal(toCheckpoint('0042'), '42');
  assert.equal(toCheckpoint(7), '7');
});

test('toCheckpoint falls back when the message has none', () => {
  assert.equal(toCheckpoint(undefined), '0');
  assert.equal(toCheckpoint(null, CHECKPOINT), CHECKPOINT);
  assert.equal(toCheckpoint('', CHECKPOINT), CHECKPOINT);
});

test('toCheckpoint rejects anything that is not a whole number', () => {
  for (const value of ['-1', '1.5', '1e21', 'abc', 1e21]) {
    assert.throws(() => toCheckpoint(value), /invalid mailbox checkpoint/);
  }
});

test('checkpoints survive the gRPC encoding exactly in both directions', () => {
  const packageDef = protoLoader.loadSync(
    path.join(__dirname, '..', 'protos', 'mailbox_server.proto'),
    PROTO_LOADER_OPTIONS
  );
  const readMailbox = packageDef['mailbox_server.MailboxService'].ReadMailbox;

  const request = readMailbox.requestDeserialize(readMailbox.requestSerialize({
    mailbox_id: Buffer.alloc(33),
    authorization: Buffer.alloc(105),
    checkpoint: CHECKPOINT
  }));
  assert.equal(request.checkpoint, CHECKPOINT);

  const response = readMailbox.responseDeserialize(readMailbox.responseSerialize({
    messages: [{ checkpoint: CHECKPOINT }]
  }));
  assert.equal(response.messages[0].checkpoint, CHECKPOINT);
  assert.equal(toCheckpoint(response.messages[0].checkpoint), CHECKPOINT);
});
