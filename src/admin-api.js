const express = require('express');
const { name, version } = require('../package.json');
const { HOUR_MS } = require('./event-log');

// Deliberately not `/admin`: that path is on every scanner wordlist, and the
// resulting probe traffic would drown out real entries in the event log.
const ADMIN_API_PATH = '/insights/v1';

const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_WINDOW_HOURS = 24 * 90;

// `ADMIN_CORS_ORIGIN` is a comma-separated list of exact origins. The special
// entry `localhost` (the default) allows a locally served dashboard on any
// port. CORS only decides which pages may *read* responses in a browser; every
// request still needs the admin bearer token.
function isAllowedOrigin(origin, allowed) {
  if (!origin) return false;
  return allowed.some((entry) => (entry === 'localhost' ? LOCALHOST_ORIGIN.test(origin) : entry === origin));
}

function parseHours(raw, fallback) {
  const hours = Number.parseInt(raw, 10);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(hours, MAX_WINDOW_HOURS);
}

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) && id >= 0 ? id : undefined;
}

function optionalString(raw) {
  return typeof raw === 'string' && raw.length > 0 ? raw.slice(0, 128) : undefined;
}

// Read-only view of the relay for a personal dashboard: event log, hourly
// rollups, and live worker state. Mounted only when ADMIN_API_TOKEN is set.
// This deliberately does not accept RELAY_API_TOKEN, which ships inside the
// iOS app and so can't be treated as a secret.
function createAdminRouter({
  config,
  events,
  store,
  workerManager,
  logger,
  rejectRequest,
  timingSafeStringEqual,
  rateLimit
}) {
  const router = express.Router();
  const startedAt = Date.now();

  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (isAllowedOrigin(origin, config.adminCorsOrigins)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'authorization, content-type');
      res.set('Access-Control-Max-Age', '600');
    }
    // Preflights carry no credentials, so they have to be answered before auth.
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  router.use(rateLimit);

  router.use((req, res, next) => {
    const authHeader = String(req.get('authorization') || '');
    const bearerPrefix = 'Bearer ';
    const token = authHeader.startsWith(bearerPrefix) ? authHeader.slice(bearerPrefix.length) : '';
    if (token && timingSafeStringEqual(token, config.adminApiToken)) {
      return next();
    }
    return rejectRequest(res, 401, 'unauthorized', { error: 'unauthorized' });
  });

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const handle = (fn, { needsEvents = false } = {}) => async (req, res) => {
    try {
      if (needsEvents && !events.enabled) {
        return rejectRequest(res, 503, 'event_log_unavailable', { error: 'event log unavailable' });
      }
      return res.status(200).json(await fn(req));
    } catch (err) {
      if (err.badRequest) {
        return rejectRequest(res, 400, 'invalid_query', { error: String(err.message) });
      }
      logger.error({ err }, 'admin request failed');
      return rejectRequest(res, 500, 'internal_error', { error: 'internal error' });
    }
  };

  // One-screen overview: failure rates per category, the most frequent
  // failures, worker health, and lifetime counters.
  router.get('/summary', handle(async (req) => {
    const hours = parseHours(req.query.hours, 24);
    const now = Date.now();

    const workers = workerManager.snapshot();
    const workerStates = {};
    for (const worker of workers) {
      workerStates[worker.state] = (workerStates[worker.state] || 0) + 1;
    }

    const categories = {};
    let topFailures = [];
    if (events.enabled) {
      const totals = await events.queryTotals({ fromMs: now - hours * HOUR_MS });
      for (const row of totals) {
        const bucket = categories[row.category] || (categories[row.category] = { ok: 0, fail: 0, info: 0 });
        bucket[row.outcome] = (bucket[row.outcome] || 0) + row.count;
      }
      for (const bucket of Object.values(categories)) {
        const judged = bucket.ok + bucket.fail;
        bucket.failure_rate = judged > 0 ? Number((bucket.fail / judged).toFixed(4)) : 0;
      }
      topFailures = totals
        .filter((row) => row.outcome === 'fail')
        .slice(0, 20)
        .map(({ category, name: eventName, code, count }) => ({ category, name: eventName, code, count }));
    }

    return {
      relay: {
        name,
        version,
        now,
        started_at: startedAt,
        uptime_seconds: Math.round((now - startedAt) / 1000),
        dry_run: config.dryRun
      },
      window_hours: hours,
      categories,
      top_failures: topFailures,
      workers: {
        total: workers.length,
        by_state: workerStates,
        flapping: workers.filter((worker) => worker.state !== 'auth_paused' && worker.consecutive_failures >= 3).length
      },
      registered_devices: await store.countAllDevices(),
      lifetime: await store.getStats(),
      event_log: await events.status?.() || { enabled: false }
    };
  }));

  router.get('/workers', handle(async (req) => {
    const state = optionalString(req.query.state);
    const workers = workerManager
      .snapshot()
      .filter((worker) => !state || worker.state === state)
      .sort((a, b) => b.consecutive_failures - a.consecutive_failures || a.state_since - b.state_since);
    return { now: Date.now(), count: workers.length, workers };
  }));

  // Newest first, page back with `before_id`. Pass `since_id` instead to tail:
  // rows then come oldest first, starting after that id. Collapsed repeats
  // update `count`/`last_ts` on their existing row and keep their id.
  router.get('/events', handle(async (req) => {
    const rows = await events.queryEvents({
      sinceId: parseId(req.query.since_id),
      beforeId: parseId(req.query.before_id),
      category: optionalString(req.query.category),
      name: optionalString(req.query.name),
      outcome: optionalString(req.query.outcome),
      code: optionalString(req.query.code),
      mailbox: optionalString(req.query.mailbox),
      limit: req.query.limit
    });
    const ids = rows.map((row) => row.id);
    return {
      count: rows.length,
      max_id: ids.length ? Math.max(...ids) : null,
      min_id: ids.length ? Math.min(...ids) : null,
      events: rows
    };
  }, { needsEvents: true }));

  // Hourly counts for charts. Filter with category/name/outcome/code and pick
  // what each series represents with `group_by` (default: outcome).
  router.get('/timeseries', handle(async (req) => {
    const hours = parseHours(req.query.hours, 48);
    const now = Date.now();
    let rows;
    try {
      rows = await events.queryRollups({
        fromMs: now - hours * HOUR_MS,
        toMs: now,
        category: optionalString(req.query.category),
        name: optionalString(req.query.name),
        outcome: optionalString(req.query.outcome),
        code: optionalString(req.query.code),
        groupBy: optionalString(req.query.group_by) || 'outcome'
      });
    } catch (err) {
      if (/group_by/.test(String(err.message))) err.badRequest = true;
      throw err;
    }

    const series = {};
    for (const row of rows) {
      const key = row.key === '' ? '(none)' : row.key;
      (series[key] || (series[key] = [])).push([row.hour, row.count]);
    }
    return { from: now - hours * HOUR_MS, to: now, bucket_ms: HOUR_MS, series };
  }, { needsEvents: true }));

  return router;
}

module.exports = { createAdminRouter, ADMIN_API_PATH };
