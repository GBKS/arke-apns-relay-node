const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeVtxoBytes, decodeVtxoSats } = require('../src/vtxo-decoder');

const u8 = (v) => Buffer.from([v]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const bytes = (n, fill) => Buffer.alloc(n, fill);
const outPoint = (fill) => Buffer.concat([bytes(32, fill), u32(0)]);

// A v2 VTXO in the lib-0.7.1 encoding: a HashLockedCosigned genesis step with
// the current transition tag 4 and the current HTLC-receive policy tag 8.
function buildVtxo({ version = 2, amountSat = 21000, transitionTag = 4, policyTag = 8 } = {}) {
  return Buffer.concat([
    u16(version),
    u64(amountSat),
    u32(900000),                 // expiry_height
    bytes(33, 2),                // server_pubkey
    u16(144),                    // exit_delta
    outPoint(3),                 // anchor_point
    u8(1),                       // genesis item count
    u8(transitionTag),
    bytes(33, 4),                // user_pubkey
    bytes(64, 0),                // no signature
    u8(1), bytes(32, 5),         // unlock: hash
    u8(1), u8(0),                // output_count, output_idx
    ...(version >= 2 ? [u64(0)] : []), // fee_amount_sat
    u8(policyTag),
    bytes(33, 6),                // user_pubkey
    bytes(32, 7),                // payment_hash
    u32(900100),                 // htlc_expiry
    u16(40),                     // htlc_expiry_delta
    outPoint(8)                  // point
  ]);
}

test('reads the amount of a VTXO that uses the current bark tags', () => {
  assert.equal(decodeVtxoSats(buildVtxo()), 21000);
});

test('reads the amount even when the rest of the VTXO uses unknown tags', () => {
  assert.equal(decodeVtxoSats(buildVtxo({ transitionTag: 99, policyTag: 99 })), 21000);
});

test('reads the amount of a v1 VTXO', () => {
  assert.equal(decodeVtxoSats(buildVtxo({ version: 1, transitionTag: 3, policyTag: 2 })), 21000);
});

test('rejects an unknown VTXO version instead of guessing the amount', () => {
  assert.throws(() => decodeVtxoSats(buildVtxo({ version: 3 })), /unsupported VTXO version 3/);
});

test('full decode accepts current and legacy tags', () => {
  const current = decodeVtxoBytes(buildVtxo());
  assert.equal(current.genesis.items[0].transition.type, 'HashLockedCosigned');
  assert.equal(current.policy.type, 'ServerHtlcRecv');

  const legacy = decodeVtxoBytes(buildVtxo({ transitionTag: 3, policyTag: 2 }));
  assert.equal(legacy.policy.type, 'ServerHtlcRecv');
});
