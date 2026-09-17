// bark's `MailboxAuthorization` wire format (lib/src/mailbox.rs,
// `ProtocolEncoding for MailboxAuthorization`):
//
//   33 bytes  mailbox identifier (compressed public key)
//    8 bytes  expiry, i64 little-endian UNIX timestamp in seconds
//   64 bytes  schnorr signature over the expiry
//
// The relay can't verify or mint these (only the wallet holds the mailbox
// key), but it can read the expiry, which lets it avoid sending the Ark server
// a token it already knows will be rejected.
const MAILBOX_ID_BYTES = 33;
const EXPIRY_BYTES = 8;
const SIGNATURE_BYTES = 64;
const AUTHORIZATION_BYTES = MAILBOX_ID_BYTES + EXPIRY_BYTES + SIGNATURE_BYTES;

// Generous bounds for "is this a plausible timestamp"; anything outside means
// the bytes aren't what we think they are.
const MIN_EXPIRY_SECONDS = 1600000000; // 2020-09
const MAX_EXPIRY_SECONDS = 4102444800; // 2100-01

// Returns the expiry as a millisecond timestamp, or null when the token isn't
// in the format above. Null means "unknown", never "expired": callers must
// then fall back to letting the Ark server decide, so a future format change
// degrades to the old behaviour instead of locking every mailbox out.
function parseAuthorizationExpiryMs(authorizationHex) {
  if (typeof authorizationHex !== 'string' || authorizationHex.length !== AUTHORIZATION_BYTES * 2) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(authorizationHex)) {
    return null;
  }

  const bytes = Buffer.from(authorizationHex, 'hex');
  const expirySeconds = bytes.readBigInt64LE(MAILBOX_ID_BYTES);
  if (expirySeconds < BigInt(MIN_EXPIRY_SECONDS) || expirySeconds > BigInt(MAX_EXPIRY_SECONDS)) {
    return null;
  }
  return Number(expirySeconds) * 1000;
}

function isExpired(expiresAtMs, nowMs = Date.now()) {
  return expiresAtMs !== null && expiresAtMs !== undefined && nowMs >= expiresAtMs;
}

module.exports = { parseAuthorizationExpiryMs, isExpired };
