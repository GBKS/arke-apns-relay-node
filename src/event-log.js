const sqlite3 = require('sqlite3');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_PENDING_EVENTS = 10000;
const MAX_DETAIL_CHARS = 2000;
const MAILBOX_PREFIX_CHARS = 8;

const OUTCOMES = Object.freeze(['ok', 'fail', 'info']);
const ROLLUP_GROUP_COLUMNS = Object.freeze(['category', 'name', 'outcome', 'code']);

// Mailbox ids are wallet identifiers, so the event log only ever stores (and
// the admin API only ever returns) a short prefix.
function mailboxPrefix(mailboxId) {
  if (!mailboxId) return null;
  return String(mailboxId).toLowerCase().slice(0, MAILBOX_PREFIX_CHARS);
}

function clip(value, max) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function serializeDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  try {
    const json = JSON.stringify(detail);
    if (json === '{}') return null;
    return json.length > MAX_DETAIL_CHARS
      ? JSON.stringify({ truncated: json.slice(0, MAX_DETAIL_CHARS) })
      : json;
  } catch (_) {
    return null;
  }
}

// Persistent, queryable record of what the relay did and how it went. Lives in
// its own SQLite file with its own connection so it can never interfere with
// checkpoint/registration transactions, and can be deleted freely.
//
// Two tables:
// - `event`: one row per distinct thing that happened. Identical events
//   (same category/name/outcome/code/mailbox/server/ip) within the collapse
//   window fold into a single row with a `count`, so a flapping worker or a
//   misbehaving client can't flood the table.
// - `rollup_hourly`: exact counts per hour with no mailbox or IP. Kept forever;
//   this is what long-term charts are drawn from.
//
// Recording is fire-and-forget: `record()` only buffers in memory, a timer
// flushes the buffer in one transaction, and any failure here is logged and
// swallowed. The event log must never take the relay down.
class EventLog {
  constructor({
    dbPath,
    retentionDays = 30,
    maxRows = 2000000,
    logger,
    flushMs = 1000,
    pruneMs = 10 * 60 * 1000,
    collapseWindowMs = HOUR_MS
  }) {
    this._dbPath = dbPath;
    this._retentionMs = Math.max(1, Number(retentionDays) || 30) * DAY_MS;
    this._maxRows = Math.max(1000, Number(maxRows) || 2000000);
    this._log = logger;
    this._flushMs = flushMs;
    this._pruneMs = pruneMs;
    this._collapseWindowMs = collapseWindowMs;

    this._db = null;
    this._disabled = true;
    this._pending = [];
    this._rollups = new Map();
    this._open = new Map(); // fingerprint -> { id, firstTs }
    this._flushing = null;
    this._flushTimer = null;
    this._pruneTimer = null;
    this._dropped = 0;
    this._writeErrors = 0;
    this.retentionDays = Math.round(this._retentionMs / DAY_MS);
  }

  async init() {
    await new Promise((resolve, reject) => {
      this._db = new sqlite3.Database(this._dbPath, (err) => (err ? reject(err) : resolve()));
    });
    await this._run('PRAGMA journal_mode = WAL');
    await this._run('PRAGMA synchronous = NORMAL');

    await this._run(`
      CREATE TABLE IF NOT EXISTS event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        last_ts INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        code TEXT,
        mailbox TEXT,
        ark_addr TEXT,
        duration_ms INTEGER,
        client_ip TEXT,
        detail TEXT
      );
    `);
    await this._run('CREATE INDEX IF NOT EXISTS event_last_ts ON event(last_ts)');
    await this._run('CREATE INDEX IF NOT EXISTS event_category_outcome ON event(category, outcome, id)');
    await this._run('CREATE INDEX IF NOT EXISTS event_mailbox ON event(mailbox, id)');

    await this._run(`
      CREATE TABLE IF NOT EXISTS rollup_hourly (
        hour INTEGER NOT NULL,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        code TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 0,
        duration_ms_sum INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour, category, name, outcome, code)
      );
    `);

    this._disabled = false;

    this._flushTimer = setInterval(() => { this.flush(); }, this._flushMs);
    this._flushTimer.unref();
    this._pruneTimer = setInterval(() => { this.prune(); }, this._pruneMs);
    this._pruneTimer.unref();
    await this.prune();
  }

  get enabled() {
    return !this._disabled;
  }

  // Buffer one event. Never throws, never blocks.
  record({ category, name, outcome = 'info', code = null, mailboxId, arkAddr, durationMs, clientIp, detail }) {
    if (this._disabled || !category || !name) return;

    const ts = Date.now();
    const event = {
      ts,
      category: clip(category, 32),
      name: clip(name, 64),
      outcome: OUTCOMES.includes(outcome) ? outcome : 'info',
      code: clip(code, 64),
      mailbox: mailboxPrefix(mailboxId),
      arkAddr: clip(arkAddr, 255),
      durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      clientIp: clip(clientIp, 64),
      detail: serializeDetail(detail)
    };

    // Rollups are always counted, even if the event row itself gets dropped.
    const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
    const rollupKey = [hour, event.category, event.name, event.outcome, event.code || ''].join('|');
    const rollup = this._rollups.get(rollupKey);
    if (rollup) {
      rollup.count += 1;
      rollup.durationMsSum += event.durationMs || 0;
    } else {
      this._rollups.set(rollupKey, {
        hour,
        category: event.category,
        name: event.name,
        outcome: event.outcome,
        code: event.code || '',
        count: 1,
        durationMsSum: event.durationMs || 0
      });
    }

    if (this._pending.length >= MAX_PENDING_EVENTS) {
      this._dropped += 1;
      return;
    }
    this._pending.push(event);
  }

  flush() {
    if (this._disabled) return Promise.resolve();
    if (this._flushing) return this._flushing;
    if (this._pending.length === 0 && this._rollups.size === 0) return Promise.resolve();

    this._flushing = this._flush().finally(() => { this._flushing = null; });
    return this._flushing;
  }

  async _flush() {
    const events = this._pending;
    const rollups = this._rollups;
    this._pending = [];
    this._rollups = new Map();

    try {
      await this._run('BEGIN');
      for (const event of events) {
        await this._writeEvent(event);
      }
      for (const rollup of rollups.values()) {
        await this._run(
          `INSERT INTO rollup_hourly (hour, category, name, outcome, code, count, duration_ms_sum)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hour, category, name, outcome, code) DO UPDATE SET
             count = rollup_hourly.count + excluded.count,
             duration_ms_sum = rollup_hourly.duration_ms_sum + excluded.duration_ms_sum`,
          [rollup.hour, rollup.category, rollup.name, rollup.outcome, rollup.code, rollup.count, rollup.durationMsSum]
        );
      }
      await this._run('COMMIT');
    } catch (err) {
      try { await this._run('ROLLBACK'); } catch (_) {}
      // Row ids handed out inside the rolled-back transaction can be reused,
      // so none of the remembered collapse targets can be trusted any more.
      this._open.clear();
      this._dropped += events.length;
      this._writeErrors += 1;
      if (this._writeErrors <= 5 || this._writeErrors % 100 === 0) {
        this._log.error({ err, lostEvents: events.length, writeErrors: this._writeErrors }, 'event log flush failed');
      }
    }

    const cutoff = Date.now() - this._collapseWindowMs;
    for (const [fingerprint, open] of this._open) {
      if (open.firstTs < cutoff) this._open.delete(fingerprint);
    }
  }

  async _writeEvent(event) {
    const fingerprint = [
      event.category, event.name, event.outcome, event.code, event.mailbox, event.arkAddr, event.clientIp
    ].join('|');

    const open = this._open.get(fingerprint);
    if (open && event.ts - open.firstTs < this._collapseWindowMs) {
      const updated = await this._run(
        `UPDATE event
         SET count = count + 1, last_ts = ?, duration_ms = COALESCE(?, duration_ms), detail = COALESCE(?, detail)
         WHERE id = ?`,
        [event.ts, event.durationMs, event.detail, open.id]
      );
      if ((updated.changes || 0) > 0) return;
    }

    const inserted = await this._run(
      `INSERT INTO event (ts, last_ts, category, name, outcome, code, mailbox, ark_addr, duration_ms, client_ip, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.ts, event.ts, event.category, event.name, event.outcome, event.code,
        event.mailbox, event.arkAddr, event.durationMs, event.clientIp, event.detail
      ]
    );
    this._open.set(fingerprint, { id: inserted.lastID, firstTs: event.ts });
  }

  // Drops event rows past the retention window, then enforces the hard row cap
  // (oldest first). Rollups are never pruned.
  async prune() {
    if (this._disabled) return;
    try {
      await this._run('DELETE FROM event WHERE last_ts < ?', [Date.now() - this._retentionMs]);
      await this._run(
        'DELETE FROM event WHERE id <= (SELECT id FROM event ORDER BY id DESC LIMIT 1 OFFSET ?)',
        [this._maxRows]
      );
    } catch (err) {
      this._log.error({ err }, 'event log prune failed');
    }
  }

  // Newest first by default. With `sinceId` the order flips to oldest first so
  // a client can tail the log by passing the highest id it has seen.
  async queryEvents({ sinceId, beforeId, category, name, outcome, code, mailbox, limit = 100 } = {}) {
    const where = [];
    const args = [];
    const tailing = Number.isFinite(sinceId);

    if (tailing) { where.push('id > ?'); args.push(sinceId); }
    if (Number.isFinite(beforeId)) { where.push('id < ?'); args.push(beforeId); }
    if (category) { where.push('category = ?'); args.push(category); }
    if (name) { where.push('name = ?'); args.push(name); }
    if (outcome) { where.push('outcome = ?'); args.push(outcome); }
    if (code) { where.push('code = ?'); args.push(code); }
    if (mailbox) { where.push('mailbox = ?'); args.push(mailboxPrefix(mailbox)); }

    const cappedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = await this._all(
      `SELECT id, ts, last_ts, count, category, name, outcome, code, mailbox, ark_addr, duration_ms, client_ip, detail
       FROM event
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id ${tailing ? 'ASC' : 'DESC'}
       LIMIT ?`,
      [...args, cappedLimit]
    );

    return rows.map((row) => {
      let detail = null;
      if (row.detail) {
        try { detail = JSON.parse(row.detail); } catch (_) { detail = null; }
      }
      return { ...row, detail };
    });
  }

  // Hourly counts from `fromMs` onwards, grouped by one of the rollup columns.
  async queryRollups({ fromMs, toMs = Date.now(), category, name, outcome, code, groupBy = 'outcome' } = {}) {
    if (!ROLLUP_GROUP_COLUMNS.includes(groupBy)) {
      throw new Error(`group_by must be one of: ${ROLLUP_GROUP_COLUMNS.join(', ')}`);
    }
    const where = ['hour >= ?', 'hour <= ?'];
    const args = [Math.floor(fromMs / HOUR_MS) * HOUR_MS, toMs];
    if (category) { where.push('category = ?'); args.push(category); }
    if (name) { where.push('name = ?'); args.push(name); }
    if (outcome) { where.push('outcome = ?'); args.push(outcome); }
    if (code) { where.push('code = ?'); args.push(code); }

    return this._all(
      `SELECT hour, ${groupBy} AS key, SUM(count) AS count, SUM(duration_ms_sum) AS duration_ms_sum
       FROM rollup_hourly
       WHERE ${where.join(' AND ')}
       GROUP BY hour, ${groupBy}
       ORDER BY hour ASC`,
      args
    );
  }

  // Totals since `fromMs`, one row per (category, name, outcome, code).
  queryTotals({ fromMs }) {
    return this._all(
      `SELECT category, name, outcome, code, SUM(count) AS count, SUM(duration_ms_sum) AS duration_ms_sum
       FROM rollup_hourly
       WHERE hour >= ?
       GROUP BY category, name, outcome, code
       ORDER BY count DESC`,
      [Math.floor(fromMs / HOUR_MS) * HOUR_MS]
    );
  }

  async status() {
    const row = this._disabled ? null : await this._get('SELECT COUNT(*) AS cnt, MIN(ts) AS oldest FROM event');
    return {
      enabled: !this._disabled,
      rows: Number(row?.cnt || 0),
      oldest_ts: row?.oldest || null,
      retention_days: this.retentionDays,
      max_rows: this._maxRows,
      dropped_events: this._dropped,
      write_errors: this._writeErrors
    };
  }

  async close() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    if (this._disabled) return;
    try {
      await this.flush();
    } finally {
      this._disabled = true;
      await new Promise((resolve) => this._db.close(() => resolve()));
    }
  }

  _run(sql, args = []) {
    return new Promise((resolve, reject) => {
      this._db.run(sql, args, function runResult(err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  _all(sql, args = []) {
    return new Promise((resolve, reject) => {
      this._db.all(sql, args, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  _get(sql, args = []) {
    return new Promise((resolve, reject) => {
      this._db.get(sql, args, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
  }
}

module.exports = { EventLog, mailboxPrefix, HOUR_MS };
