const { parseAuthorizationExpiryMs } = require('./mailbox-auth');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_TICK_MS = 60 * 60 * 1000;

// Mailboxes whose authorization expired more than `retentionMs` ago, or `[]`
// when retention is off. A token whose expiry can't be read is never selected:
// the Ark server is the only judge of those.
function expiredMailboxes(mailboxes, nowMs, retentionMs) {
  if (!(retentionMs > 0)) return [];
  return mailboxes.filter((mailbox) => {
    const expiresAt = parseAuthorizationExpiryMs(mailbox.authorization_hex);
    return expiresAt !== null && nowMs - expiresAt > retentionMs;
  });
}

// Deletes mailboxes the relay can no longer do anything for. Wake pushes stop
// about a week after a token expires, so by the retention cutoff the relay
// holds the data for nobody's benefit. If the wallet comes back it simply
// registers again, and its first backfill is caught up silently.
class RetentionJob {
  constructor({ store, workerManager, events, logger, config }) {
    this._store = store;
    this._workerManager = workerManager;
    this._events = events;
    this._log = logger;
    this._retentionMs = config.expiredMailboxRetentionDays * DAY_MS;
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._timer) return;
    this.run();
    this._timer = setInterval(() => { this.run(); }, RETENTION_TICK_MS);
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async run(nowMs = Date.now()) {
    if (this._running) return;
    this._running = true;
    try {
      const mailboxes = await this._store.getAllMailboxes();
      let deleted = 0;
      for (const mailbox of expiredMailboxes(mailboxes, nowMs, this._retentionMs)) {
        if (!await this._store.deleteMailbox(mailbox.mailbox_id, mailbox.authorization_hex)) continue;
        this._workerManager.stopWorker(mailbox.mailbox_id);
        deleted += 1;
        this._events.record({
          category: 'registration',
          name: 'expired_deleted',
          outcome: 'info',
          mailboxId: mailbox.mailbox_id,
          detail: { authExpiresAt: new Date(parseAuthorizationExpiryMs(mailbox.authorization_hex)).toISOString() }
        });
      }
      const orphans = await this._store.deleteOrphans();
      if (deleted > 0 || orphans > 0) {
        this._log.info({ deleted, orphans }, 'deleted mailboxes past retention');
      }
      return { deleted, orphans };
    } catch (err) {
      this._log.error({ err }, 'retention run failed');
      return null;
    } finally {
      this._running = false;
    }
  }
}

module.exports = { RetentionJob, expiredMailboxes };
