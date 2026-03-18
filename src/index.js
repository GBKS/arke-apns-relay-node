require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const clientMetrics = require('prom-client');

const { loadConfig } = require('./config');
const { CheckpointStore, STAT_KEYS } = require('./checkpoint-store');
const { ApnsSender, StaleDeviceTokenError } = require('./apns-sender');
const { createClientFactory, readMailbox, subscribeMailbox } = require('./mailbox-client');
const { decodeVtxoSats } = require('./vtxo-decoder');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

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
  [STAT_KEYS.lifetimeMailboxMessagesReceived]: new clientMetrics.Gauge({
    name: STAT_KEYS.lifetimeMailboxMessagesReceived,
    help: 'Lifetime mailbox messages received, persisted in SQLite'
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

    return res.status(401).json({ error: 'unauthorized' });
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
      return res.status(429).json({ error: 'rate_limited', retry_after_seconds: retryAfterSeconds });
    }

    return next();
  };
}

async function validateMailboxAuthorization(client, mailboxIdHex, authHex, checkpoint = 0) {
  if (!isHex(mailboxIdHex) || !isHex(authHex)) {
    throw new Error('mailbox_id and authorization_hex must be valid hex');
  }

  const request = {
    unblinded_id: Buffer.from(mailboxIdHex, 'hex'),
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

async function processMailboxMessage(message, mailboxId, sender, store, config) {
  // Depending on proto/runtime version, oneof payload may appear either as
  // `message.arkoor` or at top-level as `arkoor`.
  const arkoorMessage = message?.message?.arkoor || message?.arkoor;
  if (!message || !arkoorMessage) {
    return;
  }

  const checkpoint = Number(message.checkpoint || 0);
  const vtxos = arkoorMessage.vtxos || [];
  const vtxoCount = vtxos.length;
  let totalSats = 0;
  for (const vtxo of vtxos) {
    try { totalSats += decodeVtxoSats(vtxo); } catch (_) {}
  }

  metricMessages.inc();

  const recipients = await store.getDevices(mailboxId);
  let successfulSends = 0;

  if (recipients.length === 0) {
    logger.warn({ mailboxId, checkpoint }, 'no registered devices, skipping APNs send');
  } else if (config.dryRun) {
    logger.info({ checkpoint, vtxoCount, recipientCount: recipients.length }, 'dry-run enabled, skipping APNs send');
    successfulSends = recipients.length; // treat as success for checkpoint
  } else {
    for (const recipient of recipients) {
      try {
        await sender.sendMailboxNotification({
          checkpoint,
          vtxoCount,
          totalSats,
          mailboxId,
          deviceToken: recipient.device_token,
          topic: recipient.apns_topic
        });
        successfulSends += 1;
        metricApnsSuccess.inc();
      } catch (err) {
        if (err instanceof StaleDeviceTokenError) {
          logger.warn(
            { deviceTokenSuffix: recipient.device_token.slice(-8), reason: err.apnsReason },
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
          logger.error(
            { err, checkpoint, deviceTokenSuffix: recipient.device_token.slice(-8) },
            'failed to send APNs notification to device'
          );
        }
      }
    }
  }

  // Always advance checkpoint after processing, even if no sends succeeded,
  // to avoid repeated delivery attempts for the same message.
  await store.recordMailboxMessage(mailboxId, checkpoint, { vtxoCount, totalSats });
  lifetimeMetrics[STAT_KEYS.lifetimeMailboxMessagesReceived].inc();
  if (vtxoCount > 0) {
    lifetimeMetrics[STAT_KEYS.lifetimeVtxosProcessed].inc(vtxoCount);
  }
  if (totalSats > 0) {
    lifetimeMetrics[STAT_KEYS.lifetimeSatsProcessed].inc(totalSats);
  }
}

// ─── per-mailbox subscription worker ────────────────────────────────────────

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
  }

  start() {
    if (this._stopped || this._loopPromise) return;
    this._loopPromise = this._loop();
  }

  stop() {
    this._stopped = true;
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
    if (this._sleepResolve) {
      this._sleepResolve();
      this._sleepResolve = null;
    }
  }

  async _loop() {
    while (!this._stopped) {
      try {
        const client = this._clientFactory(this.arkAddr);
        const checkpoint = await this._backfill(client);
        this._log.info({ checkpoint }, 'backfill complete, starting subscription stream');
        await this._subscribe(client, checkpoint);
      } catch (err) {
        this._log.error({ err }, 'worker loop iteration failed');
      }
      if (!this._stopped) {
        await this._sleep(this._config.subscribeRetryMs);
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
        await processMailboxMessage(message, this.mailboxId, this._sender, this._store, this._config);
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
          await processMailboxMessage(message, this.mailboxId, this._sender, this._store, this._config);
        } catch (err) {
          this._log.error({ err }, 'error processing mailbox message (stream data handler)');
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
  }

  _makeRequest(checkpoint) {
    return {
      unblinded_id: Buffer.from(this.mailboxId, 'hex'),
      authorization: Buffer.from(this.authorizationHex, 'hex'),
      checkpoint
    };
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._sleepResolve = resolve;
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
  app.use(express.json({ limit: '32kb' }));
  app.use('/v1', createAuthMiddleware(config), createRateLimitMiddleware(config));

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
        return res.status(400).json({ error: 'mailbox_id, authorization_hex, ark_addr, device_token and apns_topic are required' });
      }
      if (!isHex(mailboxId)) {
        return res.status(400).json({ error: 'mailbox_id must be valid hex' });
      }
      if (!isHex(authorizationHex)) {
        return res.status(400).json({ error: 'authorization_hex must be valid hex' });
      }
      if (!isValidArkAddr(arkAddr)) {
        return res.status(400).json({ error: 'ark_addr must be a valid http:// or https:// URL' });
      }
      if (!isValidApnsToken(deviceToken)) {
        return res.status(400).json({ error: 'device_token must be a 64-char hex APNs token' });
      }
      if (!isValidApnsTopic(apnsTopic)) {
        return res.status(400).json({ error: 'apns_topic must contain only letters, numbers, dots, or dashes' });
      }

      const checkpoint = await store.get(mailboxId);
      const client = clientFactory(arkAddr);
      await validateMailboxAuthorization(client, mailboxId, authorizationHex, checkpoint);

      await store.setMailbox(mailboxId, arkAddr, authorizationHex);
      const registrationResult = await store.registerDevice(mailboxId, deviceToken, apnsTopic);
      workerManager.ensureWorker(mailboxId, arkAddr, authorizationHex);
      if (registrationResult.inserted) {
        lifetimeMetrics[STAT_KEYS.lifetimeRegistrations].inc();
      }

      const totalDevices = await store.countDevices(mailboxId);
      await refreshRegistrationMetric(store);

      return res.status(201).json({
        status: 'registered',
        mailbox_id: mailboxId,
        ark_addr: arkAddr,
        device_token_suffix: deviceToken.slice(-8),
        total_devices: totalDevices
      });
    } catch (err) {
      logger.warn({ err }, 'registration request rejected');
      return res.status(400).json({ error: 'registration failed', detail: String(err.message || err) });
    }
  });

  app.delete('/v1/register', async (req, res) => {
    try {
      const mailboxId = String(req.body?.mailbox_id || '').toLowerCase();
      const deviceToken = normalizeToken(req.body?.device_token);
      if (!mailboxId || !deviceToken) {
        return res.status(400).json({ error: 'mailbox_id and device_token are required' });
      }
      if (!isHex(mailboxId)) {
        return res.status(400).json({ error: 'mailbox_id must be valid hex' });
      }
      if (!isValidApnsToken(deviceToken)) {
        return res.status(400).json({ error: 'device_token must be a 64-char hex APNs token' });
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
      return res.status(200).json({
        status: 'unregistered',
        mailbox_id: mailboxId,
        removed,
        total_devices: remaining
      });
    } catch (err) {
      logger.warn({ err }, 'unregister request failed');
      return res.status(500).json({ error: 'unregister failed', detail: String(err.message || err) });
    }
  });

  app.get('/v1/registrations', async (req, res) => {
    try {
      const mailboxId = String(req.query.mailbox_id || '').toLowerCase();
      if (!mailboxId) {
        return res.status(400).json({ error: 'mailbox_id query parameter is required' });
      }
      if (!isHex(mailboxId)) {
        return res.status(400).json({ error: 'mailbox_id must be valid hex' });
      }

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
      logger.warn({ err }, 'list registrations failed');
      return res.status(500).json({ error: 'failed to list registrations', detail: String(err.message || err) });
    }
  });

  app.listen(port, () => {
    logger.info({ port }, 'relay HTTP server listening');
  });
}

async function run() {
  const config = loadConfig();

  const store = new CheckpointStore(config.checkpointDb);
  await store.init();

  const sender = new ApnsSender(config.apns, logger);
  const clientFactory = createClientFactory(config.protoPath);
  const workerManager = new WorkerManager({ store, sender, clientFactory, config });

  await refreshRegistrationMetric(store);
  await refreshLifetimeMetrics(store);
  await workerManager.startAll();

  startHttpServer({ port: config.metricsPort, config, store, workerManager, clientFactory });

  process.on('SIGINT', () => {
    workerManager.stopAll();
    sender.shutdown();
    store.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    workerManager.stopAll();
    sender.shutdown();
    store.close();
    process.exit(0);
  });
}

run().catch((err) => {
  logger.error({ err }, 'fatal startup failure');
  process.exit(1);
});
