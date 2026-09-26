const { parseAuthorizationExpiryMs } = require('./mailbox-auth');
const { StaleDeviceTokenError } = require('./apns-sender');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// How soon after expiry the first post-expiry wake goes out.
const POST_EXPIRY_GRACE_MS = HOUR_MS;
// A registration this soon after a wake is counted as caused by it.
const WAKE_ATTRIBUTION_WINDOW_MS = 30 * 60 * 1000;

// When is the next wake-up push for this token due? Returns a ms timestamp,
// or null when there is nothing (more) to send for it.
//
//   before expiry:  one wake `leadMs` before it, a second at half that
//   after expiry:   one shortly after, then one a day, `postExpiryAttempts`
//                   in total, and then the relay gives up
//
// `state` counts what has already been sent for *this* token; a new token
// (different expiry) starts from zero, which is how a successful registration
// resets the schedule.
function nextWakeDueAt({ expiresAt, state, nowMs, leadMs, postExpiryAttempts }) {
  const pre = state?.preAttempts || 0;
  const post = state?.postAttempts || 0;
  const lastSentAt = state?.lastSentAt || null;

  if (nowMs < expiresAt) {
    if (pre === 0) return expiresAt - leadMs;
    if (pre === 1) return Math.max(expiresAt - leadMs / 2, (lastSentAt || 0) + leadMs / 2);
    // Both pre-expiry wakes are spent; the next one is the first post-expiry.
    return post < postExpiryAttempts ? expiresAt + POST_EXPIRY_GRACE_MS : null;
  }

  if (post >= postExpiryAttempts) return null;
  const earliest = expiresAt + POST_EXPIRY_GRACE_MS;
  // The daily spacing only applies between post-expiry wakes; the first one
  // must not be pushed back by a pre-expiry wake sent an hour or two earlier.
  return post > 0 && lastSentAt ? Math.max(earliest, lastSentAt + DAY_MS) : earliest;
}

// Keeps mailbox authorizations alive by asking the app to renew them.
//
// The relay can't mint authorizations (only the wallet holds the mailbox key)
// and a token only lives as long as the wallet asked for (a fixed 24h before
// bark-ffi 0.25; the Arke app now mints 30-day tokens and renews them at
// mid-life), so a mailbox goes dark once its token lapses unless something
// wakes the app. iOS background tasks are too
// unreliable to be that something on their own. A silent push only needs the
// APNs device token, so it works even after the mailbox token has expired.
//
// This is the one place the relay acts on its own initiative, and it does so
// using nothing but the expiry inside the token the app gave it.
//
// A side effect worth having: mailboxes with expired tokens otherwise never
// receive a push, so the relay never learns their app was uninstalled. Wakes
// surface APNs `Unregistered` responses, and those devices get removed.
class AuthWakeScheduler {
  constructor({ store, sender, events, logger, config, onStaleDevice }) {
    this._store = store;
    this._sender = sender;
    this._events = events;
    this._log = logger;
    this._config = config;
    this._onStaleDevice = onStaleDevice;
    this._timer = null;
    this._ticking = false;
  }

  start() {
    if (this._timer || !this._config.authWakeEnabled) return;
    this._timer = setInterval(() => { this.tick(); }, this._config.authWakeTickMs);
    this._timer.unref();
    this._log.info(
      { leadMs: this._config.authWakeLeadMs, postExpiryAttempts: this._config.authWakePostExpiryAttempts },
      'auth wake scheduler started'
    );
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // One pass: find mailboxes whose wake is due and send at most
  // `authWakeMaxPerTick` of them, oldest-due first. The cap is what spreads a
  // backlog (e.g. the first run after deploy) out instead of bursting it.
  async tick(nowMs = Date.now()) {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const [mailboxes, states] = await Promise.all([
        this._store.getMailboxesWithDevices(),
        this._store.getAuthWakeStates()
      ]);

      const due = [];
      for (const mailbox of mailboxes) {
        const expiresAt = parseAuthorizationExpiryMs(mailbox.authorization_hex);
        if (expiresAt === null) continue;

        const stored = states.get(mailbox.mailbox_id);
        const state = stored && stored.authExpiresAt === expiresAt ? stored : null;
        const dueAt = nextWakeDueAt({
          expiresAt,
          state,
          nowMs,
          leadMs: this._config.authWakeLeadMs,
          postExpiryAttempts: this._config.authWakePostExpiryAttempts
        });
        if (dueAt !== null && dueAt <= nowMs) {
          due.push({ mailboxId: mailbox.mailbox_id, expiresAt, state, dueAt });
        }
      }

      due.sort((a, b) => a.dueAt - b.dueAt);
      for (const item of due.slice(0, this._config.authWakeMaxPerTick)) {
        await this._wake(item, nowMs);
      }
    } catch (err) {
      this._log.error({ err }, 'auth wake tick failed');
    } finally {
      this._ticking = false;
    }
  }

  async _wake({ mailboxId, expiresAt, state }, nowMs) {
    const phase = nowMs < expiresAt ? 'pre_expiry' : 'post_expiry';
    const devices = await this._store.getDevices(mailboxId);

    // Count the attempt whatever happens next, so an APNs outage or a mailbox
    // without devices can't turn into a retry loop.
    await this._store.setAuthWakeState(mailboxId, {
      authExpiresAt: expiresAt,
      preAttempts: (state?.preAttempts || 0) + (phase === 'pre_expiry' ? 1 : 0),
      postAttempts: (state?.postAttempts || 0) + (phase === 'post_expiry' ? 1 : 0),
      lastSentAt: nowMs
    });

    for (const device of devices) {
      const startedAt = Date.now();
      const record = (outcome, code, detail) => this._events.record({
        category: 'apns',
        name: 'auth_wake',
        outcome,
        code,
        mailboxId,
        durationMs: Date.now() - startedAt,
        detail: {
          phase,
          attempt: (state?.preAttempts || 0) + (state?.postAttempts || 0) + 1,
          deviceTokenSuffix: device.device_token.slice(-8),
          ...detail
        }
      });

      if (this._config.dryRun) {
        record('info', 'dry_run', {});
        continue;
      }

      try {
        const { environment } = await this._sender.sendAuthRefreshWake({
          mailboxId,
          deviceToken: device.device_token,
          topic: device.apns_topic,
          expiresAt
        });
        record('ok', phase, { environment });
      } catch (err) {
        if (err instanceof StaleDeviceTokenError) {
          record('fail', err.apnsReason, { environment: err.apnsEnvironment, deviceRemoved: true });
          await this._onStaleDevice(mailboxId, device.device_token, err.apnsReason);
        } else {
          record('fail', err.apnsReason || err.code || err.name || 'Error', {
            environment: err.apnsEnvironment,
            status: err.apnsStatus,
            message: String(err.message || err).slice(0, 300)
          });
          this._log.error({ err, mailboxId }, 'failed to send auth wake push');
        }
      }
    }
  }
}

module.exports = { AuthWakeScheduler, nextWakeDueAt, WAKE_ATTRIBUTION_WINDOW_MS };
