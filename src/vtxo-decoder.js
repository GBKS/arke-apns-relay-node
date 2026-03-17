function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function reversedHex(bytes) {
  return hex(Uint8Array.from(bytes).reverse());
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  remaining() {
    return this.bytes.length - this.offset;
  }

  ensure(count) {
    if (this.offset + count > this.bytes.length) {
      throw new Error(`unexpected EOF at offset ${this.offset}, need ${count} more bytes`);
    }
  }

  u8() {
    this.ensure(1);
    return this.bytes[this.offset++];
  }

  u16() {
    this.ensure(2);
    const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return value;
  }

  u32() {
    this.ensure(4);
    const value =
      this.bytes[this.offset] |
      (this.bytes[this.offset + 1] << 8) |
      (this.bytes[this.offset + 2] << 16) |
      (this.bytes[this.offset + 3] << 24);
    this.offset += 4;
    return value >>> 0;
  }

  u64() {
    const low = BigInt(this.u32());
    const high = BigInt(this.u32());
    return low | (high << 32n);
  }

  readBytes(count) {
    this.ensure(count);
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  compactSize() {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const value = this.u16();
      if (value < 0xfd) throw new Error('non-minimal CompactSize');
      return value;
    }
    if (first === 0xfe) {
      const value = this.u32();
      if (value < 0x10000) throw new Error('non-minimal CompactSize');
      return value;
    }

    const value = this.u64();
    if (value < 0x100000000n) throw new Error('non-minimal CompactSize');
    return value;
  }
}

function readPublicKey(r) {
  return hex(r.readBytes(33));
}

function readXOnlyPublicKey(r) {
  return hex(r.readBytes(32));
}

function readSha256(r) {
  return hex(r.readBytes(32));
}

function readOptionalSchnorrSignature(r) {
  const sig = r.readBytes(64);
  let allZero = true;
  for (const byte of sig) {
    if (byte !== 0) {
      allZero = false;
      break;
    }
  }
  return allZero ? null : hex(sig);
}

function readOutPoint(r) {
  const txidLittleEndian = r.readBytes(32);
  const vout = r.u32();

  return {
    txid: reversedHex(txidLittleEndian),
    txid_bytes_le: hex(txidLittleEndian),
    vout
  };
}

function readTxOut(r) {
  const valueSat = r.u64();
  const scriptLen = r.compactSize();
  if (typeof scriptLen === 'bigint') {
    throw new Error('script length unexpectedly exceeded JS safe integer range');
  }

  const scriptPubKey = r.readBytes(scriptLen);
  return {
    value_sat: valueSat,
    script_pubkey: hex(scriptPubKey)
  };
}

function readVector(r, itemReader) {
  const count = r.compactSize();
  if (typeof count === 'bigint') {
    throw new Error('vector length unexpectedly exceeded JS safe integer range');
  }

  const items = [];
  for (let index = 0; index < count; index++) {
    items.push(itemReader(r));
  }
  return items;
}

function readGenesisTransition(r) {
  const type = r.u8();

  switch (type) {
    case 1:
      return {
        type: 'Cosigned',
        pubkeys: readVector(r, readPublicKey),
        signature: readOptionalSchnorrSignature(r)
      };

    case 2:
      return {
        type: 'Arkoor',
        client_cosigners: readVector(r, readPublicKey),
        tap_tweak: readSha256(r),
        signature: readOptionalSchnorrSignature(r)
      };

    case 3: {
      const userPubkey = readPublicKey(r);
      const signature = readOptionalSchnorrSignature(r);
      const kind = r.u8();

      if (kind === 0) {
        return {
          type: 'HashLockedCosigned',
          user_pubkey: userPubkey,
          signature,
          unlock: {
            type: 'Preimage',
            value: hex(r.readBytes(32))
          }
        };
      }

      if (kind === 1) {
        return {
          type: 'HashLockedCosigned',
          user_pubkey: userPubkey,
          signature,
          unlock: {
            type: 'Hash',
            value: readSha256(r)
          }
        };
      }

      throw new Error(`invalid MaybePreimage tag ${kind}`);
    }

    default:
      throw new Error(`invalid GenesisTransition tag ${type}`);
  }
}

function readGenesis(r, version) {
  const itemCount = r.compactSize();
  if (typeof itemCount === 'bigint') {
    throw new Error('genesis item count unexpectedly exceeded JS safe integer range');
  }

  const items = [];
  for (let index = 0; index < itemCount; index++) {
    const transition = readGenesisTransition(r);
    const outputCount = r.u8();
    const outputIndex = r.u8();

    if (outputCount < 1) {
      throw new Error('genesis item had zero outputs');
    }

    const otherOutputs = [];
    for (let output = 0; output < outputCount - 1; output++) {
      otherOutputs.push(readTxOut(r));
    }

    const feeAmountSat = version === 1 ? 0n : r.u64();

    items.push({
      transition,
      output_count: outputCount,
      output_idx: outputIndex,
      other_outputs: otherOutputs,
      fee_amount_sat: feeAmountSat
    });
  }

  return { items };
}

function readPolicy(r) {
  const tag = r.u8();

  switch (tag) {
    case 0x00:
      return {
        type: 'Pubkey',
        user_pubkey: readPublicKey(r)
      };

    case 0x01:
      return {
        type: 'ServerHtlcSend',
        user_pubkey: readPublicKey(r),
        payment_hash: readSha256(r),
        htlc_expiry: r.u32()
      };

    case 0x02:
      return {
        type: 'ServerHtlcRecv',
        user_pubkey: readPublicKey(r),
        payment_hash: readSha256(r),
        htlc_expiry: r.u32(),
        htlc_expiry_delta: r.u16()
      };

    case 0x03:
      return {
        type: 'Checkpoint',
        user_pubkey: readPublicKey(r)
      };

    case 0x04:
      return {
        type: 'Expiry',
        internal_key: readXOnlyPublicKey(r)
      };

    case 0x05:
      return {
        type: 'HarkLeaf',
        user_pubkey: readPublicKey(r),
        unlock_hash: readSha256(r)
      };

    case 0x06:
      return {
        type: 'HarkForfeit',
        user_pubkey: readPublicKey(r),
        unlock_hash: readSha256(r)
      };

    default:
      throw new Error(`invalid VtxoPolicy tag ${tag}`);
  }
}

function decodeVtxoBytes(bytes) {
  const r = new Reader(bytes);

  const version = r.u16();
  if (version !== 1 && version !== 2) {
    throw new Error(`unsupported VTXO version ${version}`);
  }

  const amountSat = r.u64();
  const expiryHeight = r.u32();
  const serverPubkey = readPublicKey(r);
  const exitDelta = r.u16();
  const anchorPoint = readOutPoint(r);
  const genesis = readGenesis(r, version);
  const policy = readPolicy(r);
  const point = readOutPoint(r);

  if (r.remaining() !== 0) {
    throw new Error(`trailing bytes after VTXO decode: ${r.remaining()}`);
  }

  return {
    version,
    amount_sat: amountSat,
    expiry_height: expiryHeight,
    server_pubkey: serverPubkey,
    exit_delta: exitDelta,
    anchor_point: anchorPoint,
    genesis,
    policy,
    point
  };
}

function decodeVtxoSats(vtxoBuffer) {
  const bytes = vtxoBuffer instanceof Uint8Array ? vtxoBuffer : new Uint8Array(vtxoBuffer);
  const decoded = decodeVtxoBytes(bytes);
  const amountSat = decoded.amount_sat;
  if (amountSat > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('amount_sat exceeds Number.MAX_SAFE_INTEGER');
  }
  return Number(amountSat);
}

module.exports = {
  decodeVtxoBytes,
  decodeVtxoSats
};