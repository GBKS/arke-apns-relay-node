require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const clientMetrics = require('prom-client');
const grpc = require('@grpc/grpc-js');

const { loadConfig } = require('./config');
const { CheckpointStore, STAT_KEYS } = require('./checkpoint-store');
const { ApnsSender, StaleDeviceTokenError } = require('./apns-sender');
const { createClientFactory, readMailbox, subscribeMailbox, statusName } = require('./mailbox-client');
const { decodeVtxoSats } = require('./vtxo-decoder');
const { EventLog, mailboxPrefix } = require('./event-log');
const { parseAuthorizationExpiryMs, isExpired } = require('./mailbox-auth');
const { AuthWakeScheduler, WAKE_ATTRIBUTION_WINDOW_MS } = require('./auth-wake');
const { createAdminRouter, ADMIN_API_PATH } = require('./admin-api');
const { version } = require('../package.json');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Replaced with the real EventLog in run(); a no-op until then (and for good
// if the event database can't be opened) so call sites never need to check.
let events = { enabled: false, record() {} };

const metricMessages = new clientMetrics.Counter({
  name: 'mailbox_messages_received_total',
  help: 'Total number of mailbox messages received'
});

const metricApnsSuccess = new clientMetrics.Counter({
  name: 'apns_success_total',
  help: 'Successful APNs sends'
});

const metricApnsFailure = new clientMetrics.Counter({
  name: 'apns_failure_total',
  help: 'Failed APNs sends'
});

const metricRegistrations = new clientMetrics.Gauge({
  name: 'relay_registered_devices',
  help: 'Total registered APNs device tokens across all mailboxes'
});

const metricWorkers = new clientMetrics.Gauge({
  name: 'relay_active_workers',
  help: 'Number of active mailbox subscription workers'
});

const lifetimeMetrics = {
  [STAT_KEYS.lifetimeVtxosProcessed]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeVtxosProcessed,
    help: 'Lifetime VTXOs processed, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeSatsProcessed]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeSatsProcessed,
    help: 'Lifetime sats processed, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeSatsNotifiedIncomingLightning]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeSatsNotifiedIncomingLightning,
    help: 'Lifetime sats seen in incomingLightningPayment notifications (pending claim, not yet settled), persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeMailboxMessagesReceived]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeMailboxMessagesReceived,
    help: 'Lifetime mailbox messages received, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeMailboxMessagesReceivedArkoor]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeMailboxMessagesReceivedArkoor,
    help: 'Lifetime arkoor messages received, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeMailboxMessagesReceivedRoundParticipationCompleted]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeMailboxMessagesReceivedRoundParticipationCompleted,
    help: 'Lifetime roundParticipationCompleted messages received, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeMailboxMessagesReceivedIncomingLightningPayment]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeMailboxMessagesReceivedIncomingLightningPayment,
    help: 'Lifetime incomingLightningPayment messages received, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeMailboxMessagesReceivedRecoveryVtxoIds]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeMailboxMessagesReceivedRecoveryVtxoIds,
    help: 'Lifetime recoveryVtxoIds messages received, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeMailboxMessagesReceivedLightningSendFinished]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeMailboxMessagesReceivedLightningSendFinished,
    help: 'Lifetime lightningSendFinished messages received, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeRegistrations]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeRegistrations,
    help: 'Lifetime device registrations created, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeUnregistrations]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeUnregistrations,
    help: 'Lifetime explicit device unregistrations, persisted in SQLite'
  }),
  [STAT_KEYS.lifetimeStaleDeviceRemovals]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeStaleDeviceRemovals,
    help: 'Lifetime stale device removals, persisted in SQLite'
  })
};

function isHex(str) {
  return typeof str === 'string' && str.length > 0 && str.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(str);
}

function isValidApnsToken(str) {
  return typeof str === 'string' && /^[0-9a-f]{64}$/.test(str);
}

function isValidApnsTopic(str) {
  return typeof str === 'string' && str.length > 0 && str.length <= 255 && /^[a-zA-Z0-9.-]+$/.test(str);
}

function isValidArkAddr(str) {
  if (typeof str !== 'string') return false;
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Optional, app-reported reason for a registration (`foreground`, `timer`,
// `background_task`, `wake_push`, ...). Free-form but tightly bounded, because
// it becomes an event code and those feed the never-pruned rollups.
function normalizeTrigger(raw) {
  return typeof raw === 'string' && /^[a-z_]{1,32}$/.test(raw) ? raw : 'unspecified';
}

function normalizeToken(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/[<>\s]/g, '').toLowerCase();
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // constant-time dummy compare
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Short machine-readable code for an error: gRPC status name, SQLite/Node
// error code, or the error class name.
function errorCode(err) {
  if (!err) return 'unknown';
  if (typeof err.code === 'number') return statusName(err.code);
  if (typeof err.code === 'string' && err.code) return err.code;
  return err.name || 'Error';
}

function clipText(value, max) {
  return String(value || '').slice(0, max);
}

function recordIfDbError(err, mailboxId, where) {
  if (typeof err?.code === 'string' && err.code.startsWith('SQLITE')) {
    events.record({
      category: 'db',
      name: where,
      outcome: 'fail',
      code: err.code,
      mailboxId,
      detail: { message: String(err.message || err) }
    });
  }
}

// Sends an error response and tags it with a machine-readable reason, which
// the request-event middleware stores as the event code.
function rejectRequest(res, status, reason, body) {
  res.locals.reason = reason;
  return res.status(status).json(body);
}

// Records one event per finished HTTP request. Mounted before auth and rate
// limiting so 401s and 429s are captured too. Health/metrics scrapes are
// skipped, as are successful admin reads (the dashboard polling itself).
function createRequestEventMiddleware() {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const urlPath = req.originalUrl.split('?')[0];
      if (urlPath === '/healthz' || urlPath === '/metrics') return;

      const status = res.statusCode;
      const isAdmin = urlPath.startsWith(`${ADMIN_API_PATH}/`);
      if (isAdmin && status < 400) return;

      const durationMs = Date.now() - startedAt;
      // Event names feed the (never pruned) rollups, so they must come from a
      // bounded set: the matched route, or the mount point when a middleware
      // rejected the request before routing. The raw path only goes in detail.
      let name = 'unmatched';
      if (req.route) name = `${req.method} ${req.baseUrl}${req.route.path}`;
      else if (res.locals.reason) name = `${req.method} ${req.baseUrl}/*`;
      const code = res.locals.reason || String(status);
      const outcome = status < 400 ? 'ok' : 'fail';

      events.record({
        category: isAdmin ? 'admin' : 'http',
        name,
        outcome,
        code,
        mailboxId: res.locals.mailboxId,
        arkAddr: res.locals.arkAddr,
        durationMs,
        // Only kept where it helps tell an attacker from a broken client.
        clientIp: status === 401 || status === 429 ? req.ip : null,
        detail: {
          status,
          ...(req.route ? {} : { method: clipText(req.method, 16), path: clipText(urlPath, 64) }),
          ...res.locals.eventDetail
        }
      });

      const line = { request: name, status, code, durationMs };
      if (status >= 400) logger.warn(line, 'http request failed');
      else logger.info(line, 'http request');
    });
    next();
  };
}

function createAuthMiddleware(config) {
  if (!config.relayApiToken) {
    logger.warn('RELAY_API_TOKEN is empty; /v1 endpoints are unauthenticated');
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const headerToken = String(req.get('x-relay-token') || '');
    if (headerToken && timingSafeStringEqual(headerToken, config.relayApiToken)) {
      return next();
    }

    const authHeader = String(req.get('authorization') || '');
    const bearerPrefix = 'Bearer ';
    const bearerToken = authHeader.startsWith(bearerPrefix) ? authHeader.slice(bearerPrefix.length) : '';
    if (bearerToken && timingSafeStringEqual(bearerToken, config.relayApiToken)) {
      return next();
    }

    return rejectRequest(res, 401, 'unauthorized', { error: 'unauthorized' });
  };
}

function createRateLimitMiddleware(config) {
  const windowMs = Math.max(1000, Number(config.rateLimitWindowMs) || 60000);
  const max = Math.max(1, Number(config.rateLimitMax) || 30);
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const entry = buckets.get(key);

    if (!entry || now >= entry.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return rejectRequest(res, 429, 'rate_limited', { error: 'rate_limited', retry_after_seconds: retryAfterSeconds });
    }

    return next();
  };
}

async function validateMailboxAuthorization(client, mailboxIdHex, authHex, checkpoint = 0) {
  if (!isHex(mailboxIdHex) || !isHex(authHex)) {
    throw new Error('mailbox_id and authorization_hex must be valid hex');
  }

  const request = {
    mailbox_id: Buffer.from(mailboxIdHex, 'hex'),
    authorization: Buffer.from(authHex, 'hex'),
    checkpoint
  };

  await readMailbox(client, request);
}

async function refreshRegistrationMetric(store) {
  const total = await store.countAllDevices();
  metricRegistrations.set(total);
}

async function refreshLifetimeMetrics(store) {
  const stats = await store.getStats();
  for (const [statKey, metric] of Object.entries(lifetimeMetrics)) {
    metric.set(Number(stats[statKey] || 0));
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function resolveMailboxMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const envelope = message.message && typeof message.message === 'object'
    ? message.message
    : null;

  const candidates = [
    ['arkoor', firstDefined(envelope?.arkoor, message.arkoor)],
    [
      'roundParticipationCompleted',
      firstDefined(
        envelope?.roundParticipationCompleted,
        envelope?.round_participation_completed,
        message.roundParticipationCompleted,
        message.round_participation_completed
      )
    ],
    [
      'incomingLightningPayment',
      firstDefined(
        envelope?.incomingLightningPayment,
        envelope?.incoming_lightning_payment,
        message.incomingLightningPayment,
        message.incoming_lightning_payment
      )
    ],
    [
      'recoveryVtxoIds',
      firstDefined(
        envelope?.recoveryVtxoIds,
        envelope?.recovery_vtxo_ids,
        message.recoveryVtxoIds,
        message.recovery_vtxo_ids
      )
    ],
    [
      'lightningSendFinished',
      firstDefined(
        envelope?.lightningSendFinished,
        envelope?.lightning_send_finished,
        message.lightningSendFinished,
        message.lightning_send_finished
      )
    ]
  ];

  const resolved = candidates.find(([, payload]) => payload);
  if (!resolved) {
    return null;
  }

  return { type: resolved[0], payload: resolved[1] };
}

function getMailboxMessageKeys(message) {
  const envelope = message?.message && typeof message.message === 'object'
    ? Object.keys(message.message)
    : [];
  const topLevel = message && typeof message === 'object'
    ? Object.keys(message)
    : [];

  return [...new Set([...envelope, ...topLevel])].filter(
    (key) => key !== 'message' && key !== 'checkpoint'
  );
}

function summarizeArkoorMessage(arkoorMessage) {
  const vtxos = arkoorMessage?.vtxos || [];
  const vtxoCount = vtxos.length;
  let totalSats = 0;
  for (const vtxo of vtxos) {
    try { totalSats += decodeVtxoSats(vtxo); } catch (_) {}
  }

  return {
    stats: { vtxoCount, totalSats },
    notification: { messageType: 'arkoor', vtxoCount, totalSats }
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
  const paymentHash =
    incomingLightningPaymentMessage?.paymentHash
    || incomingLightningPaymentMessage?.payment_hash
    || null;
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
      hasPaymentHash: Boolean(paymentHash),
      amountSat
    }
  };
}

function summarizeLightningSendFinishedMessage(lightningSendFinishedMessage) {
  const paymentHash =
    lightningSendFinishedMessage?.paymentHash
    || lightningSendFinishedMessage?.payment_hash
    || null;
  const preimage = lightningSendFinishedMessage?.preimage || null;
  // `preimage` is an `optional bytes` field; proto-loader may hand back an
  // empty (but non-null) buffer when it's unset, so check length, not truthiness.
  const success = Boolean(preimage) && preimage.length > 0;

  return {
    stats: { vtxoCount: 0, totalSats: 0 },
    notification: {
      messageType: 'lightningSendFinished',
      hasPaymentHash: Boolean(paymentHash),
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

async function sendMailboxNotificationToRecipients({
  mailboxId,
  checkpoint,
  messageType,
  notification,
  sender,
  store,
  config
}) {
  const recipients = await store.getDevices(mailboxId);
  let successfulSends = 0;

  if (recipients.length === 0) {
    logger.warn({ mailboxId, checkpoint, messageType }, 'no registered devices, skipping APNs send');
    events.record({
      category: 'apns',
      name: 'skipped_no_devices',
      outcome: 'info',
      code: messageType,
      mailboxId,
      detail: { checkpoint }
    });
    return successfulSends;
  }

  if (config.dryRun) {
    logger.info(
      { checkpoint, mailboxId, messageType, recipientCount: recipients.length },
      'dry-run enabled, skipping APNs send'
    );
    events.record({
      category: 'apns',
      name: 'skipped_dry_run',
      outcome: 'info',
      code: messageType,
      mailboxId,
      detail: { checkpoint, recipientCount: recipients.length }
    });
    return recipients.length;
  }

  for (const recipient of recipients) {
    const sendStartedAt = Date.now();
    const recordSend = (outcome, code, detail) => events.record({
      category: 'apns',
      name: 'send',
      outcome,
      code,
      mailboxId,
      durationMs: Date.now() - sendStartedAt,
      detail: {
        messageType,
        checkpoint,
        topic: recipient.apns_topic,
        deviceTokenSuffix: recipient.device_token.slice(-8),
        ...detail
      }
    });

    try {
      const { environment } = await sender.sendMailboxNotification({
        checkpoint,
        mailboxId,
        deviceToken: recipient.device_token,
        topic: recipient.apns_topic,
        ...notification
      });
      successfulSends += 1;
      metricApnsSuccess.inc();
      recordSend('ok', null, { environment });
    } catch (err) {
      if (err instanceof StaleDeviceTokenError) {
        recordSend('fail', err.apnsReason, { environment: err.apnsEnvironment, deviceRemoved: true });
        logger.warn(
          {
            deviceTokenSuffix: recipient.device_token.slice(-8),
            messageType,
            reason: err.apnsReason
          },
          'removing stale APNs device token'
        );
        const removed = await store.unregisterDevice(
          mailboxId,
          recipient.device_token,
          STAT_KEYS.lifetimeStaleDeviceRemovals
        );
        if (removed > 0) {
          lifetimeMetrics[STAT_KEYS.lifetimeStaleDeviceRemovals].inc(removed);
        }
        await refreshRegistrationMetric(store);
      } else {
        metricApnsFailure.inc();
        recordSend('fail', err.apnsReason || errorCode(err), {
          environment: err.apnsEnvironment,
          status: err.apnsStatus,
          message: clipText(err.message, 300)
        });
        logger.error(
          {
            err,
            checkpoint,
            deviceTokenSuffix: recipient.device_token.slice(-8),
            messageType
          },
          'failed to send APNs notification to device'
        );
      }
    }
  }

  return successfulSends;
}

async function recordProcessedMailboxMessage(store, mailboxId, checkpoint, stats, messageType = null) {
  await store.recordMailboxMessage(mailboxId, checkpoint, stats, messageType);
  lifetimeMetrics[STAT_KEYS.lifetimeMailboxMessagesReceived].inc();
  if (messageType) {
    const typeMetricKey = {
      arkoor: STAT_KEYS.lifetimeMailboxMessagesReceivedArkoor,
      roundParticipationCompleted: STAT_KEYS.lifetimeMailboxMessagesReceivedRoundParticipationCompleted,
      incomingLightningPayment: STAT_KEYS.lifetimeMailboxMessagesReceivedIncomingLightningPayment,
      recoveryVtxoIds: STAT_KEYS.lifetimeMailboxMessagesReceivedRecoveryVtxoIds,
      lightningSendFinished: STAT_KEYS.lifetimeMailboxMessagesReceivedLightningSendFinished
    }[messageType];
    if (typeMetricKey) {
      lifetimeMetrics[typeMetricKey].inc();
    }
  }
  if (stats.vtxoCount > 0) {
    lifetimeMetrics[STAT_KEYS.lifetimeVtxosProcessed].inc(stats.vtxoCount);
  }
  if (stats.totalSats > 0) {
    lifetimeMetrics[STAT_KEYS.lifetimeSatsProcessed].inc(stats.totalSats);
  }
  if (stats.lightningReceiveSats > 0) {
    lifetimeMetrics[STAT_KEYS.lifetimeSatsNotifiedIncomingLightning].inc(stats.lightningReceiveSats);
  }
}

async function processMailboxMessage(message, mailboxId, sender, store, config) {
  if (!message) {
    return;
  }

  const checkpoint = Number(message.checkpoint || 0);
  metricMessages.inc();

  const resolvedMessage = resolveMailboxMessage(message);
  if (!resolvedMessage) {
    logger.warn(
      { checkpoint, mailboxId, messageKeys: getMailboxMessageKeys(message) },
      'unsupported mailbox message type, advancing checkpoint without APNs send'
    );
    events.record({
      category: 'mailbox',
      name: 'message',
      outcome: 'info',
      code: 'unsupported',
      mailboxId,
      detail: { checkpoint, messageKeys: getMailboxMessageKeys(message) }
    });
    await recordProcessedMailboxMessage(store, mailboxId, checkpoint, { vtxoCount: 0, totalSats: 0 });
    return;
  }

  const handler = mailboxMessageHandlers[resolvedMessage.type];
  const { stats, notification } = handler(resolvedMessage.payload);

  events.record({
    category: 'mailbox',
    name: 'message',
    outcome: 'ok',
    code: resolvedMessage.type,
    mailboxId,
    detail: { checkpoint }
  });

  await sendMailboxNotificationToRecipients({
    mailboxId,
    checkpoint,
    messageType: resolvedMessage.type,
    notification,
    sender,
    store,
    config
  });

  // Always advance checkpoint after processing, even if no sends succeeded,
  // to avoid repeated delivery attempts for the same message.
  await recordProcessedMailboxMessage(store, mailboxId, checkpoint, stats, resolvedMessage.type);
}

// ─── per-mailbox subscription worker ────────────────────────────────────────

// A rejected/expired mailbox authorization surfaces as UNAUTHENTICATED or
// PERMISSION_DENIED from the Ark server (or, on older servers, only shows up
// in the error message). Distinguishing this from transient network errors
// lets the worker stop hammering the server on the short retry interval and
// instead wait for a fresh token via re-registration (see `refreshAuth`).
function isAuthError(err) {
  if (!err) return false;
  if (err.code === grpc.status.UNAUTHENTICATED || err.code === grpc.status.PERMISSION_DENIED) {
    return true;
  }
  return /unauthenticated|permission.denied|expired|invalid.authorization/i.test(String(err.message || ''));
}

// A worker whose stream has stayed up this long is considered healthy again,
// which resets its consecutive-failure count.
const WORKER_STABLE_STREAM_MS = 60 * 1000;
const WORKER_STATE_OUTCOMES = Object.freeze({
  starting: 'info',
  backfilling: 'info',
  streaming: 'ok',
  retrying: 'fail',
  auth_paused: 'fail',
  auth_expired: 'fail',
  stopped: 'info'
});

class MailboxWorker {
  constructor({ mailboxId, arkAddr, authorizationHex, store, sender, clientFactory, config }) {
    this.mailboxId = mailboxId;
    this.arkAddr = arkAddr;
    this.authorizationHex = authorizationHex;
    this._store = store;
    this._sender = sender;
    this._clientFactory = clientFactory;
    this._config = config;
    this._log = logger.child({ mailboxId, arkAddr });
    this._stopped = false;
    this._loopPromise = null;
    this._currentCall = null;
    this._sleepResolve = null;

    // Observable state, surfaced through snapshot() on the admin API.
    const now = Date.now();
    this._state = 'starting';
    this._stateSince = now;
    this._startedAt = now;
    this._connects = 0;
    this._consecutiveFailures = 0;
    this._messagesProcessed = 0;
    this._lastMessageAt = null;
    this._lastAuthRefreshAt = null;
    this._lastError = null;
    this._nextRetryAt = null;
    // Null when the token isn't in a format we can read; the Ark server then
    // stays the only judge of whether it is still valid.
    this._authExpiresAt = parseAuthorizationExpiryMs(authorizationHex);
  }

  _setState(state, err = null) {
    if (this._stopped && state !== 'stopped') return;
    this._state = state;
    this._stateSince = Date.now();
    if (err) {
      this._lastError = {
        code: errorCode(err),
        message: clipText(err.details || err.message || err, 300),
        ts: this._stateSince
      };
    }
    events.record({
      category: 'worker',
      name: state,
      outcome: WORKER_STATE_OUTCOMES[state] || 'info',
      code: err ? errorCode(err) : null,
      mailboxId: this.mailboxId,
      arkAddr: this.arkAddr,
      detail: err
        ? { message: this._lastError.message, consecutiveFailures: this._consecutiveFailures }
        : null
    });
  }

  _streamIsStable() {
    return this._state === 'streaming' && Date.now() - this._stateSince >= WORKER_STABLE_STREAM_MS;
  }

  snapshot() {
    return {
      mailbox: mailboxPrefix(this.mailboxId),
      ark_addr: this.arkAddr,
      state: this._state,
      state_since: this._stateSince,
      started_at: this._startedAt,
      connects: this._connects,
      consecutive_failures: this._streamIsStable() ? 0 : this._consecutiveFailures,
      messages_processed: this._messagesProcessed,
      last_message_at: this._lastMessageAt,
      last_auth_refresh_at: this._lastAuthRefreshAt,
      auth_expires_at: this._authExpiresAt,
      last_error: this._lastError,
      next_retry_at: this._nextRetryAt
    };
  }

  async _processMessage(message) {
    await processMailboxMessage(message, this.mailboxId, this._sender, this._store, this._config);
    this._messagesProcessed += 1;
    this._lastMessageAt = Date.now();
  }

  start() {
    if (this._stopped || this._loopPromise) return;
    this._loopPromise = this._loop();
  }

  stop() {
    this._stopped = true;
    this._nextRetryAt = null;
    this._setState('stopped');
    if (this._currentCall) {
      try { this._currentCall.cancel(); } catch (_) {}
      this._currentCall = null;
    }
    if (this._sleepResolve) {
      this._sleepResolve();
      this._sleepResolve = null;
    }
  }

  // Called when a fresh registration arrives for this mailbox. Updates the
  // stored auth token and immediately wakes the worker if it is sleeping
  // between retries (e.g. after an auth-expiry error).
  refreshAuth(authorizationHex) {
    this.authorizationHex = authorizationHex;
    this._authExpiresAt = parseAuthorizationExpiryMs(authorizationHex);
    this._lastAuthRefreshAt = Date.now();
    if (this._sleepResolve) {
      this._sleepResolve();
      this._sleepResolve = null;
    }
  }

  async _loop() {
    while (!this._stopped) {
      // A token we can see has expired is guaranteed to be rejected, so don't
      // spend an Ark request finding that out. Nothing but a fresh token can
      // change the outcome, so there is no retry timer either: the worker idles
      // until refreshAuth() (a new registration) or stop() wakes it.
      if (isExpired(this._authExpiresAt)) {
        const expiredAt = new Date(this._authExpiresAt).toISOString();
        this._log.info({ expiredAt }, 'mailbox authorization expired; idle until a fresh token arrives via re-registration');
        this._nextRetryAt = null;
        this._setState(
          'auth_expired',
          Object.assign(new Error(`mailbox authorization expired at ${expiredAt}`), { code: 'AUTH_EXPIRED' })
        );
        await this._sleep(null);
        continue;
      }

      let authFailure = false;
      let loopErr = null;
      try {
        const client = this._clientFactory(this.arkAddr);
        this._connects += 1;
        this._setState('backfilling');
        const checkpoint = await this._backfill(client);
        this._log.info({ checkpoint }, 'backfill complete, starting subscription stream');
        this._setState('streaming');
        await this._subscribe(client, checkpoint);
      } catch (err) {
        loopErr = err;
        authFailure = isAuthError(err);
        if (authFailure) {
          this._log.warn({ err }, 'mailbox authorization rejected; pausing until a fresh token arrives via re-registration');
        } else {
          this._log.error({ err }, 'worker loop iteration failed');
        }
        recordIfDbError(err, this.mailboxId, 'worker_loop');
      }
      if (!this._stopped) {
        // Reaching here always means the connection was lost, cleanly or not.
        if (this._streamIsStable()) this._consecutiveFailures = 0;
        this._consecutiveFailures += 1;
        const retryMs = authFailure ? this._config.authRetryMs : this._config.subscribeRetryMs;
        this._nextRetryAt = Date.now() + retryMs;
        this._setState(
          authFailure ? 'auth_paused' : 'retrying',
          loopErr || Object.assign(new Error('subscription stream ended by server'), { code: 'STREAM_ENDED' })
        );
        await this._sleep(retryMs);
        this._nextRetryAt = null;
      }
    }
    this._loopPromise = null;
  }

  async _backfill(client) {
    let checkpoint = await this._store.get(this.mailboxId);

    for (;;) {
      const response = await readMailbox(client, this._makeRequest(checkpoint));
      const messages = response.messages || [];

      if (messages.length === 0 && !response.have_more) {
        return checkpoint;
      }

      for (const message of messages) {
        await this._processMessage(message);
        checkpoint = Number(message.checkpoint || checkpoint);
      }

      if (!response.have_more) {
        return checkpoint;
      }
    }
  }

  async _subscribe(client, checkpoint) {
    const call = subscribeMailbox(client, this._makeRequest(checkpoint));
    this._currentCall = call;
    let streamErr = null;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      call.on('data', async (message) => {
        call.pause();
        try {
          await this._processMessage(message);
        } catch (err) {
          this._log.error({ err }, 'error processing mailbox message (stream data handler)');
          recordIfDbError(err, this.mailboxId, 'stream_message');
          events.record({
            category: 'worker',
            name: 'message_processing_error',
            outcome: 'fail',
            code: errorCode(err),
            mailboxId: this.mailboxId,
            arkAddr: this.arkAddr,
            detail: { checkpoint: Number(message?.checkpoint || 0), message: clipText(err.message, 300) }
          });
        } finally {
          call.resume();
        }
      });

      call.on('error', (err) => {
        const cancelledByClient = err?.code === 1 || /cancelled on client/i.test(String(err?.message || ''));
        if (this._stopped && cancelledByClient) {
          this._log.info('subscription stream cancelled during worker stop');
          finish();
          return;
        }

        this._log.warn({ err }, 'subscription stream error, reconnecting');
        streamErr = err;
        finish();
      });

      call.on('end', () => {
        if (this._stopped) {
          this._log.info('subscription stream ended during worker stop');
          finish();
          return;
        }

        this._log.warn('subscription stream ended, reconnecting');
        finish();
      });
    });

    this._currentCall = null;
    if (streamErr) throw streamErr;
  }

  _makeRequest(checkpoint) {
    return {
      mailbox_id: Buffer.from(this.mailboxId, 'hex'),
      authorization: Buffer.from(this.authorizationHex, 'hex'),
      checkpoint
    };
  }

  // With `ms` null there is no timer: only refreshAuth() or stop() resolves it.
  _sleep(ms) {
    return new Promise((resolve) => {
      this._sleepResolve = resolve;
      if (ms === null) return;
      setTimeout(() => {
        if (this._sleepResolve === resolve) this._sleepResolve = null;
        resolve();
      }, ms);
    });
  }
}

class WorkerManager {
  constructor({ store, sender, clientFactory, config }) {
    this._store = store;
    this._sender = sender;
    this._clientFactory = clientFactory;
    this._config = config;
    this._workers = new Map(); // mailboxId -> MailboxWorker
  }

  // Start a worker for every mailbox in the DB that still has registered devices.
  async startAll() {
    const mailboxes = await this._store.getAllMailboxes();
    for (const m of mailboxes) {
      const count = await this._store.countDevices(m.mailbox_id);
      if (count > 0) {
        this._startWorker(m.mailbox_id, m.ark_addr, m.authorization_hex);
      }
    }
    metricWorkers.set(this._workers.size);
    logger.info({ count: this._workers.size }, 'started workers for all registered mailboxes');
  }

  // Ensure a worker is running for the given mailbox. If one already exists,
  // hand it a fresh auth token in case the previous one has expired.
  ensureWorker(mailboxId, arkAddr, authorizationHex) {
    const existing = this._workers.get(mailboxId);
    if (existing) {
      existing.refreshAuth(authorizationHex);
      return;
    }
    this._startWorker(mailboxId, arkAddr, authorizationHex);
    metricWorkers.set(this._workers.size);
  }

  stopWorker(mailboxId) {
    const worker = this._workers.get(mailboxId);
    if (worker) {
      worker.stop();
      this._workers.delete(mailboxId);
      metricWorkers.set(this._workers.size);
      logger.info({ mailboxId }, 'stopped mailbox worker (no devices remaining)');
    }
  }

  snapshot() {
    return [...this._workers.values()].map((worker) => worker.snapshot());
  }

  stopAll() {
    for (const worker of this._workers.values()) worker.stop();
    this._workers.clear();
    metricWorkers.set(0);
  }

  _startWorker(mailboxId, arkAddr, authorizationHex) {
    const worker = new MailboxWorker({
      mailboxId, arkAddr, authorizationHex,
      store: this._store,
      sender: this._sender,
      clientFactory: this._clientFactory,
      config: this._config
    });
    this._workers.set(mailboxId, worker);
    worker.start();
    logger.info({ mailboxId, arkAddr }, 'started mailbox worker');
  }
}

function startHttpServer({ port, config, store, workerManager, clientFactory }) {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.use(createRequestEventMiddleware());
  app.use(express.json({ limit: '32kb' }));
  app.use('/v1', createAuthMiddleware(config), createRateLimitMiddleware(config));

  if (config.adminApiToken) {
    app.use(ADMIN_API_PATH, createAdminRouter({
      config,
      events,
      store,
      workerManager,
      logger,
      rejectRequest,
      timingSafeStringEqual,
      rateLimit: createRateLimitMiddleware({
        rateLimitWindowMs: 60000,
        rateLimitMax: config.adminRateLimitMax
      })
    }));
  } else {
    logger.info(`ADMIN_API_TOKEN is empty; ${ADMIN_API_PATH} endpoints are disabled`);
  }

  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', clientMetrics.register.contentType);
    res.end(await clientMetrics.register.metrics());
  });

  app.post('/v1/register', async (req, res) => {
    try {
      const mailboxId = String(req.body?.mailbox_id || '').toLowerCase();
      const authorizationHex = String(req.body?.authorization_hex || '');
      const arkAddr = String(req.body?.ark_addr || '');
      const deviceToken = normalizeToken(req.body?.device_token);
      const apnsTopic = String(req.body?.apns_topic || config.apns.topic);

      if (!mailboxId || !authorizationHex || !arkAddr || !deviceToken || !apnsTopic) {
        res.locals.eventDetail = {
          missing: Object.entries({ mailboxId, authorizationHex, arkAddr, deviceToken, apnsTopic })
            .filter(([, value]) => !value)
            .map(([key]) => key)
        };
        return rejectRequest(res, 400, 'missing_fields', { error: 'mailbox_id, authorization_hex, ark_addr, device_token and apns_topic are required' });
      }
      if (!isHex(mailboxId)) {
        return rejectRequest(res, 400, 'invalid_mailbox_id', { error: 'mailbox_id must be valid hex' });
      }
      res.locals.mailboxId = mailboxId;
      if (!isHex(authorizationHex)) {
        return rejectRequest(res, 400, 'invalid_authorization_hex', { error: 'authorization_hex must be valid hex' });
      }
      if (!isValidArkAddr(arkAddr)) {
        return rejectRequest(res, 400, 'invalid_ark_addr', { error: 'ark_addr must be a valid http:// or https:// URL' });
      }
      res.locals.arkAddr = arkAddr;
      if (!isValidApnsToken(deviceToken)) {
        return rejectRequest(res, 400, 'invalid_device_token', { error: 'device_token must be a 64-char hex APNs token' });
      }
      if (!isValidApnsTopic(apnsTopic)) {
        return rejectRequest(res, 400, 'invalid_apns_topic', { error: 'apns_topic must contain only letters, numbers, dots, or dashes' });
      }
      const authExpiresAt = parseAuthorizationExpiryMs(authorizationHex);
      if (isExpired(authExpiresAt)) {
        res.locals.eventDetail = { authExpiredAt: new Date(authExpiresAt).toISOString() };
        return rejectRequest(res, 400, 'authorization_expired', {
          error: 'registration failed',
          detail: 'mailbox authorization expired'
        });
      }

      const checkpoint = await store.get(mailboxId);
      const client = clientFactory(arkAddr);
      await validateMailboxAuthorization(client, mailboxId, authorizationHex, checkpoint);

      // Read before registerDevice() so it still describes the token being replaced.
      const trigger = normalizeTrigger(req.body?.trigger);
      // A wake is only credited to the registration that replaces the token
      // it was sent for, not to every registration in the following minutes.
      const previous = await store.getMailbox(mailboxId);
      const wakeState = await store.getAuthWakeState(mailboxId);
      const wakeWasForPreviousToken = Boolean(wakeState?.lastSentAt)
        && wakeState.authExpiresAt === parseAuthorizationExpiryMs(previous?.authorization_hex);
      const sinceLastWakeMs = wakeWasForPreviousToken ? Date.now() - wakeState.lastSentAt : null;
      const afterWake = sinceLastWakeMs !== null && sinceLastWakeMs <= WAKE_ATTRIBUTION_WINDOW_MS;

      const registrationResult = await store.registerDevice(mailboxId, arkAddr, authorizationHex, deviceToken, apnsTopic);
      workerManager.ensureWorker(mailboxId, arkAddr, authorizationHex);
      if (registrationResult.inserted) {
        lifetimeMetrics[STAT_KEYS.lifetimeRegistrations].inc();
      }

      const totalDevices = await store.countDevices(mailboxId);
      await refreshRegistrationMetric(store);

      res.locals.eventDetail = {
        newDevice: registrationResult.inserted,
        totalDevices,
        apnsTopic,
        deviceTokenSuffix: deviceToken.slice(-8),
        authExpiresAt: authExpiresAt ? new Date(authExpiresAt).toISOString() : null,
        trigger
      };
      // Counted separately from the HTTP event so the rollups can answer "what
      // is keeping authorizations alive?": which triggers registrations come
      // from, and how many arrive on the back of a wake push.
      events.record({
        category: 'registration',
        name: afterWake ? 'refresh_after_wake' : 'refresh',
        outcome: 'ok',
        code: trigger,
        mailboxId,
        detail: { newDevice: registrationResult.inserted, sinceLastWakeMs }
      });
      return res.status(201).json({
        status: 'registered',
        mailbox_id: mailboxId,
        ark_addr: arkAddr,
        device_token_suffix: deviceToken.slice(-8),
        total_devices: totalDevices,
        // UNIX seconds, as encoded in the token; null if it couldn't be read.
        authorization_expires_at: authExpiresAt ? authExpiresAt / 1000 : null
      });
    } catch (err) {
      logger.warn(
        { err, mailboxId: res.locals.mailboxId, arkAddr: res.locals.arkAddr },
        'registration request rejected'
      );
      recordIfDbError(err, res.locals.mailboxId, 'register');
      // A numeric code means the Ark server (or the connection to it) rejected
      // the ReadMailbox used to validate the authorization.
      let reason = 'internal_error';
      if (isAuthError(err)) reason = 'ark_auth_rejected';
      else if (typeof err?.code === 'number') reason = `ark_${statusName(err.code).toLowerCase()}`;
      res.locals.eventDetail = { message: clipText(err.details || err.message || err, 300) };
      return rejectRequest(res, 400, reason, { error: 'registration failed', detail: String(err.message || err) });
    }
  });

  app.delete('/v1/register', async (req, res) => {
    try {
      const mailboxId = String(req.body?.mailbox_id || '').toLowerCase();
      const deviceToken = normalizeToken(req.body?.device_token);
      if (!mailboxId || !deviceToken) {
        return rejectRequest(res, 400, 'missing_fields', { error: 'mailbox_id and device_token are required' });
      }
      if (!isHex(mailboxId)) {
        return rejectRequest(res, 400, 'invalid_mailbox_id', { error: 'mailbox_id must be valid hex' });
      }
      res.locals.mailboxId = mailboxId;
      if (!isValidApnsToken(deviceToken)) {
        return rejectRequest(res, 400, 'invalid_device_token', { error: 'device_token must be a 64-char hex APNs token' });
      }

      const removed = await store.unregisterDevice(
        mailboxId,
        deviceToken,
        STAT_KEYS.lifetimeUnregistrations
      );
      const remaining = await store.countDevices(mailboxId);
      if (remaining === 0) {
        workerManager.stopWorker(mailboxId);
      }
      if (removed > 0) {
        lifetimeMetrics[STAT_KEYS.lifetimeUnregistrations].inc(removed);
      }
      await refreshRegistrationMetric(store);
      res.locals.eventDetail = { removed, totalDevices: remaining };
      return res.status(200).json({
        status: 'unregistered',
        mailbox_id: mailboxId,
        removed,
        total_devices: remaining
      });
    } catch (err) {
      logger.warn({ err, mailboxId: res.locals.mailboxId }, 'unregister request failed');
      recordIfDbError(err, res.locals.mailboxId, 'unregister');
      res.locals.eventDetail = { message: clipText(err.message || err, 300) };
      return rejectRequest(res, 500, 'internal_error', { error: 'unregister failed', detail: String(err.message || err) });
    }
  });

  app.get('/v1/registrations', async (req, res) => {
    try {
      const mailboxId = String(req.query.mailbox_id || '').toLowerCase();
      if (!mailboxId) {
        return rejectRequest(res, 400, 'missing_fields', { error: 'mailbox_id query parameter is required' });
      }
      if (!isHex(mailboxId)) {
        return rejectRequest(res, 400, 'invalid_mailbox_id', { error: 'mailbox_id must be valid hex' });
      }
      res.locals.mailboxId = mailboxId;

      const rows = await store.getDevices(mailboxId);
      return res.status(200).json({
        mailbox_id: mailboxId,
        count: rows.length,
        registrations: rows.map((row) => ({
          apns_topic: row.apns_topic,
          device_token_suffix: String(row.device_token).slice(-8),
          updated_at: row.updated_at
        }))
      });
    } catch (err) {
      logger.warn({ err, mailboxId: res.locals.mailboxId }, 'list registrations failed');
      res.locals.eventDetail = { message: clipText(err.message || err, 300) };
      return rejectRequest(res, 500, 'internal_error', { error: 'failed to list registrations', detail: String(err.message || err) });
    }
  });

  // Body-parser failures (malformed or oversized JSON) land here instead of in
  // express's default handler so they get a reason code like everything else.
  app.use((err, _req, res, _next) => {
    const status = Number(err.status || err.statusCode) || 500;
    const reason = status === 413 ? 'body_too_large' : status < 500 ? 'invalid_body' : 'internal_error';
    if (status >= 500) logger.error({ err }, 'unhandled http error');
    return rejectRequest(res, status, reason, { error: reason });
  });

  app.listen(port, () => {
    logger.info({ port }, 'relay HTTP server listening');
  });
}

async function run() {
  const config = loadConfig();

  const store = new CheckpointStore(config.checkpointDb);
  await store.init();

  const eventLog = new EventLog({
    dbPath: config.eventsDb,
    retentionDays: config.eventRetentionDays,
    maxRows: config.eventMaxRows,
    logger
  });
  try {
    await eventLog.init();
    events = eventLog;
    logger.info({ eventsDb: config.eventsDb, retentionDays: eventLog.retentionDays }, 'event log ready');
  } catch (err) {
    logger.error({ err, eventsDb: config.eventsDb }, 'event log unavailable; continuing without it');
  }
  events.record({ category: 'relay', name: 'started', outcome: 'info', detail: { version, dryRun: config.dryRun } });

  const sender = new ApnsSender(config.apns, logger, {
    onFallbackRetry: ({ deviceToken, reason, fromEnvironment, toEnvironment }) => events.record({
      category: 'apns',
      name: 'fallback_retry',
      outcome: 'info',
      code: reason,
      detail: { fromEnvironment, toEnvironment, deviceTokenSuffix: deviceToken.slice(-8) }
    })
  });
  const clientFactory = createClientFactory(config.protoPath, {
    onCall: ({ method, streaming, arkAddr, mailboxId, code, codeName, details, durationMs }) => {
      // CANCELLED is how our own worker.stop() ends a stream, not a failure.
      const outcome = code === grpc.status.OK ? 'ok' : code === grpc.status.CANCELLED ? 'info' : 'fail';
      events.record({
        category: 'ark',
        name: method,
        outcome,
        code: codeName,
        mailboxId,
        arkAddr,
        // A stream's duration is its lifetime, which would swamp the latency sums.
        durationMs: streaming ? null : durationMs,
        detail: {
          ...(streaming ? { streamLifetimeMs: durationMs } : {}),
          ...(details && code !== grpc.status.OK ? { details: clipText(details, 300) } : {})
        }
      });
      logger.debug({ method, arkAddr, code: codeName, durationMs }, 'ark rpc finished');
    }
  });
  const workerManager = new WorkerManager({ store, sender, clientFactory, config });

  await refreshRegistrationMetric(store);
  await refreshLifetimeMetrics(store);
  await workerManager.startAll();

  const authWake = new AuthWakeScheduler({
    store,
    sender,
    events,
    logger,
    config,
    onStaleDevice: async (mailboxId, deviceToken, reason) => {
      logger.warn(
        { mailboxId, deviceTokenSuffix: deviceToken.slice(-8), reason },
        'removing stale APNs device token (auth wake)'
      );
      const removed = await store.unregisterDevice(mailboxId, deviceToken, STAT_KEYS.lifetimeStaleDeviceRemovals);
      if (removed > 0) {
        lifetimeMetrics[STAT_KEYS.lifetimeStaleDeviceRemovals].inc(removed);
      }
      if ((await store.countDevices(mailboxId)) === 0) {
        workerManager.stopWorker(mailboxId);
      }
      await refreshRegistrationMetric(store);
    }
  });
  authWake.start();

  startHttpServer({ port: config.metricsPort, config, store, workerManager, clientFactory });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    authWake.stop();
    workerManager.stopAll();
    sender.shutdown();
    store.close();
    events.record({ category: 'relay', name: 'stopped', outcome: 'info', code: signal });
    // Give the event log a moment to flush, but never hang the shutdown on it.
    await Promise.race([
      eventLog.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

run().catch((err) => {
  logger.error({ err }, 'fatal startup failure');
  process.exit(1);
});
