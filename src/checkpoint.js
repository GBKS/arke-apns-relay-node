// Mailbox checkpoints are uint64s: the Ark server's message time in ms,
// shifted left 20 bits, so around 1.9e18 today. That is far past what a JS
// number holds exactly (2^53), and a checkpoint rounded down makes the Ark
// server hand the last message back on every reconnect, which the relay then
// pushes again. So the relay keeps them as decimal strings throughout: the
// gRPC layer reads uint64s as strings (`longs: String`) and accepts them back,
// and SQLite stores them as exact 64-bit integers.
function toCheckpoint(value, fallback = '0') {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error(`invalid mailbox checkpoint: ${text}`);
  }
  return BigInt(text).toString();
}

module.exports = { toCheckpoint };
