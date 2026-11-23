const { decodeVtxoSats } = require('./vtxo-decoder');

// Lowercase hex for a `bytes` field, or null when it is unset. The gRPC loader
// runs with `defaults: true`, so an unset field arrives as an empty Buffer,
// not null: check length, not truthiness.
function bytesToHex(value) {
  if (!value || value.length === 0) return null;
  return Buffer.from(value).toString('hex');
}

function summarizeArkoorMessage(arkoorMessage) {
  const vtxos = arkoorMessage?.vtxos || [];
  const vtxoCount = vtxos.length;
  let totalSats = 0;
  const decodeErrors = [];
  for (const vtxo of vtxos) {
    try {
      totalSats += decodeVtxoSats(vtxo);
    } catch (err) {
      decodeErrors.push(err);
    }
  }

  return {
    stats: { vtxoCount, totalSats },
    notification: { messageType: 'arkoor', vtxoCount, totalSats },
    decodeErrors
  };
}

function summarizeRoundParticipationCompletedMessage(roundParticipationCompletedMessage) {
  const unlockHash =
    roundParticipationCompletedMessage?.unlockHash
    || roundParticipationCompletedMessage?.unlock_hash
    || null;
  // payment_hashes is deprecated (kept by the server for <= v0.1.1 compat); prefer unlock_hash.
  const paymentHashes =
    roundParticipationCompletedMessage?.paymentHashes
    || roundParticipationCompletedMessage?.payment_hashes
    || [];
  const paymentHashCount = unlockHash ? 1 : paymentHashes.length;

  return {
    stats: { vtxoCount: 0, totalSats: 0 },
    notification: {
      messageType: 'roundParticipationCompleted',
      paymentHashCount
    }
  };
}

function summarizeIncomingLightningPaymentMessage(incomingLightningPaymentMessage) {
  const paymentHash = bytesToHex(
    incomingLightningPaymentMessage?.paymentHash
    || incomingLightningPaymentMessage?.payment_hash
  );
  const amountMsat = Number(
    incomingLightningPaymentMessage?.amountMsat
    || incomingLightningPaymentMessage?.amount_msat
    || 0
  );
  const amountSat = Math.floor(amountMsat / 1000);

  return {
    // Not folded into totalSats/lifetimeSatsProcessed: this is a pending
    // claim notification, not value already deposited in the mailbox (unlike
    // arkoor), and the wallet may never claim it. Tracked separately below.
    stats: { vtxoCount: 0, totalSats: 0, lightningReceiveSats: amountSat },
    notification: {
      messageType: 'incomingLightningPayment',
      hasPaymentHash: paymentHash !== null,
      amountSat
    }
  };
}

function summarizeLightningSendFinishedMessage(lightningSendFinishedMessage) {
  const paymentHash = bytesToHex(
    lightningSendFinishedMessage?.paymentHash
    || lightningSendFinishedMessage?.payment_hash
  );
  const preimage = lightningSendFinishedMessage?.preimage || null;
  // `preimage` is an `optional bytes` field; proto-loader may hand back an
  // empty (but non-null) buffer when it's unset, so check length, not truthiness.
  const success = Boolean(preimage) && preimage.length > 0;

  return {
    stats: { vtxoCount: 0, totalSats: 0 },
    notification: {
      messageType: 'lightningSendFinished',
      hasPaymentHash: paymentHash !== null,
      paymentHash,
      success
    }
  };
}

function summarizeRecoveryVtxoIdsMessage(recoveryVtxoIdsMessage) {
  const vtxoIds =
    recoveryVtxoIdsMessage?.vtxoIds
    || recoveryVtxoIdsMessage?.vtxo_ids
    || [];

  return {
    stats: { vtxoCount: 0, totalSats: 0 },
    notification: {
      messageType: 'recoveryVtxoIds',
      recoveryVtxoCount: vtxoIds.length
    }
  };
}

const mailboxMessageHandlers = {
  arkoor: summarizeArkoorMessage,
  roundParticipationCompleted: summarizeRoundParticipationCompletedMessage,
  incomingLightningPayment: summarizeIncomingLightningPaymentMessage,
  recoveryVtxoIds: summarizeRecoveryVtxoIdsMessage,
  lightningSendFinished: summarizeLightningSendFinishedMessage
};

module.exports = {
  mailboxMessageHandlers,
  bytesToHex,
  summarizeArkoorMessage,
  summarizeRoundParticipationCompletedMessage,
  summarizeIncomingLightningPaymentMessage,
  summarizeLightningSendFinishedMessage,
  summarizeRecoveryVtxoIdsMessage
};
