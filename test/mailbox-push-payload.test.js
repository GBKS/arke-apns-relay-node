const test = require('node:test');
const assert = require('node:assert/strict');
const { ApnsSender } = require('../src/apns-sender');
const {
  bytesToHex,
  summarizeIncomingLightningPaymentMessage,
  summarizeLightningSendFinishedMessage
} = require('../src/mailbox-messages');

const HASH = Buffer.alloc(32, 0xab);
const HASH_HEX = 'ab'.repeat(32);

// Builds notes without APNs providers or a key file.
function buildNote(fields) {
  const sender = Object.create(ApnsSender.prototype);
  sender.config = { topic: 'com.example.app', pushType: 'alert' };
  return sender._buildMailboxNotification({
    messageType: 'lightningSendFinished',
    checkpoint: '1900000000000000000',
    mailboxId: 'ff'.repeat(33),
    ...fields
  });
}

// The JSON Apple actually receives.
function wire(note) {
  return JSON.parse(note.compile());
}

// The full path: decoded mailbox message -> handler -> APNs payload.
function payloadFor(message) {
  const { notification } = summarizeLightningSendFinishedMessage(message);
  return wire(buildNote(notification));
}

test('bytesToHex treats unset and empty bytes as missing', () => {
  assert.equal(bytesToHex(undefined), null);
  assert.equal(bytesToHex(null), null);
  assert.equal(bytesToHex(Buffer.alloc(0)), null);
  assert.equal(bytesToHex(Buffer.from([0x0a, 0xff])), '0aff');
  assert.equal(bytesToHex(new Uint8Array([0xab])), 'ab');
});

test('successful send push carries the payment hash', () => {
  const payload = payloadFor({ payment_hash: HASH, preimage: Buffer.alloc(32, 1) });
  assert.equal(payload.type, 'mailbox_lightning_send_finished');
  assert.equal(payload.success, true);
  assert.equal(payload.payment_hash, HASH_HEX);
});

test('failed send push carries the payment hash', () => {
  // proto-loader hands back an empty Buffer for the unset preimage.
  const payload = payloadFor({ payment_hash: HASH, preimage: Buffer.alloc(0) });
  assert.equal(payload.success, false);
  assert.equal(payload.payment_hash, HASH_HEX);
});

test('payment_hash is left out when the message has none', () => {
  for (const message of [{ payment_hash: Buffer.alloc(0) }, {}]) {
    const payload = payloadFor({ ...message, preimage: Buffer.alloc(32, 1) });
    assert.equal('payment_hash' in payload, false);
    assert.equal(payload.success, true);
  }
});

test('alert text is unchanged', () => {
  assert.deepEqual(wire(buildNote({ success: true, paymentHash: HASH_HEX })).aps.alert, {
    title: 'Payment sent',
    body: 'Your Lightning payment completed.'
  });
  assert.deepEqual(wire(buildNote({ success: false, paymentHash: HASH_HEX })).aps.alert, {
    title: 'Payment failed',
    body: 'Your Lightning payment did not go through.'
  });
});

test('other push types do not gain a payment_hash', () => {
  const note = buildNote({
    messageType: 'incomingLightningPayment',
    hasPaymentHash: true,
    amountSat: 1000,
    paymentHash: HASH_HEX
  });
  assert.equal('payment_hash' in wire(note), false);
});

test('incoming payment has_payment_hash reflects whether a hash was sent', () => {
  const incomingPayload = (message) => {
    const { notification } = summarizeIncomingLightningPaymentMessage(message);
    return wire(buildNote(notification));
  };

  const withHash = incomingPayload({ payment_hash: HASH, amount_msat: '21000000' });
  assert.equal(withHash.has_payment_hash, true);
  assert.equal(withHash.amount_sat, 21000);

  // proto-loader hands back an empty Buffer for an unset bytes field.
  assert.equal(incomingPayload({ payment_hash: Buffer.alloc(0), amount_msat: '1000' }).has_payment_hash, false);
  assert.equal(incomingPayload({ amount_msat: '1000' }).has_payment_hash, false);
});
