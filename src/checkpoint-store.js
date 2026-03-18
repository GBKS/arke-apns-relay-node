const sqlite3 = require('sqlite3');

const STAT_KEYS = Object.freeze({
  lifetimeVtxosProcessed: 'lifetime_vtxos_processed',
  lifetimeSatsProcessed: 'lifetime_sats_processed',
  lifetimeMailboxMessagesReceived: 'lifetime_mailbox_messages_received',
  lifetimeRegistrations: 'lifetime_registrations',
  lifetimeUnregistrations: 'lifetime_unregistrations',
  lifetimeStaleDeviceRemovals: 'lifetime_stale_device_removals'
});

const ALL_STAT_KEYS = Object.freeze(Object.values(STAT_KEYS));

class CheckpointStore {
  constructor(dbPath) {
    this.db = new sqlite3.Database(dbPath);
  }

  async init() {
    await this.run(`
      CREATE TABLE IF NOT EXISTS mailbox_checkpoint (
        mailbox_id TEXT PRIMARY KEY,
        checkpoint INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS device_registration (
        mailbox_id TEXT NOT NULL,
        device_token TEXT NOT NULL,
        apns_topic TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (mailbox_id, device_token)
      );
    `);

    // Stores which Ark server each mailbox lives on, plus the most-recent
    // authorization token so workers can resume after a process restart.
    await this.run(`
      CREATE TABLE IF NOT EXISTS mailbox_registration (
        mailbox_id TEXT PRIMARY KEY,
        ark_addr TEXT NOT NULL,
        authorization_hex TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS relay_stat (
        stat_key TEXT PRIMARY KEY,
        stat_value INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  get(mailboxId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT checkpoint FROM mailbox_checkpoint WHERE mailbox_id = ?',
        [mailboxId],
        (err, row) => {
          if (err) return reject(err);
          resolve(row ? Number(row.checkpoint) : 0);
        }
      );
    });
  }

  async set(mailboxId, checkpoint) {
    await this._setCheckpoint(mailboxId, checkpoint);
  }

  getDevices(mailboxId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT mailbox_id, device_token, apns_topic, updated_at
         FROM device_registration
         WHERE mailbox_id = ?
         ORDER BY updated_at DESC`,
        [mailboxId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  }

  countDevices(mailboxId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT COUNT(*) AS cnt FROM device_registration WHERE mailbox_id = ?',
        [mailboxId],
        (err, row) => {
          if (err) return reject(err);
          resolve(Number(row?.cnt || 0));
        }
      );
    });
  }

  async registerDevice(mailboxId, deviceToken, apnsTopic) {
    await this.run('BEGIN IMMEDIATE');
    try {
      const inserted = await this._registerDevice(mailboxId, deviceToken, apnsTopic);
      if (inserted) {
        await this._incrementStats({
          [STAT_KEYS.lifetimeRegistrations]: 1
        });
      }
      await this.run('COMMIT');
      return { inserted, updated: !inserted };
    } catch (err) {
      await this._rollback(err);
    }
  }

  async unregisterDevice(mailboxId, deviceToken, statKey = null) {
    await this.run('BEGIN IMMEDIATE');
    try {
      const result = await this._unregisterDevice(mailboxId, deviceToken);
      const removed = result.changes || 0;
      if (removed > 0 && statKey) {
        await this._incrementStats({ [statKey]: removed });
      }
      await this.run('COMMIT');
      return removed;
    } catch (err) {
      await this._rollback(err);
    }
  }

  setMailbox(mailboxId, arkAddr, authorizationHex) {
    return this.run(
      `INSERT INTO mailbox_registration (mailbox_id, ark_addr, authorization_hex, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(mailbox_id) DO UPDATE SET
         ark_addr = excluded.ark_addr,
         authorization_hex = excluded.authorization_hex,
         updated_at = CURRENT_TIMESTAMP`,
      [mailboxId, arkAddr, authorizationHex]
    );
  }

  getMailbox(mailboxId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT mailbox_id, ark_addr, authorization_hex FROM mailbox_registration WHERE mailbox_id = ?',
        [mailboxId],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    });
  }

  getAllMailboxes() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT mailbox_id, ark_addr, authorization_hex FROM mailbox_registration',
        [],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  }

  countAllDevices() {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT COUNT(*) AS cnt FROM device_registration',
        [],
        (err, row) => {
          if (err) return reject(err);
          resolve(Number(row?.cnt || 0));
        }
      );
    });
  }

  getStats(statKeys = ALL_STAT_KEYS) {
    if (!Array.isArray(statKeys) || statKeys.length === 0) {
      return Promise.resolve({});
    }

    const placeholders = statKeys.map(() => '?').join(', ');
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT stat_key, stat_value FROM relay_stat WHERE stat_key IN (${placeholders})`,
        statKeys,
        (err, rows) => {
          if (err) return reject(err);
          const stats = Object.fromEntries(statKeys.map((statKey) => [statKey, 0]));
          for (const row of rows || []) {
            stats[row.stat_key] = Number(row.stat_value || 0);
          }
          resolve(stats);
        }
      );
    });
  }

  async recordMailboxMessage(mailboxId, checkpoint, { vtxoCount, totalSats }) {
    await this.run('BEGIN IMMEDIATE');
    try {
      await this._setCheckpoint(mailboxId, checkpoint);
      await this._incrementStats({
        [STAT_KEYS.lifetimeMailboxMessagesReceived]: 1,
        [STAT_KEYS.lifetimeVtxosProcessed]: vtxoCount,
        [STAT_KEYS.lifetimeSatsProcessed]: totalSats
      });
      await this.run('COMMIT');
    } catch (err) {
      await this._rollback(err);
    }
  }

  run(sql, args = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, args, function runResult(err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  _setCheckpoint(mailboxId, checkpoint) {
    return this.run(
      `
      INSERT INTO mailbox_checkpoint(mailbox_id, checkpoint, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mailbox_id) DO UPDATE SET
        checkpoint = excluded.checkpoint,
        updated_at = CURRENT_TIMESTAMP
      `,
      [mailboxId, checkpoint]
    );
  }

  async _registerDevice(mailboxId, deviceToken, apnsTopic) {
    const insertResult = await this.run(
      `
      INSERT OR IGNORE INTO device_registration (mailbox_id, device_token, apns_topic, created_at, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      [mailboxId, deviceToken, apnsTopic]
    );

    if ((insertResult.changes || 0) > 0) {
      return true;
    }

    await this.run(
      `
      UPDATE device_registration
      SET apns_topic = ?, updated_at = CURRENT_TIMESTAMP
      WHERE mailbox_id = ? AND device_token = ?
      `,
      [apnsTopic, mailboxId, deviceToken]
    );

    return false;
  }

  _unregisterDevice(mailboxId, deviceToken) {
    return this.run(
      'DELETE FROM device_registration WHERE mailbox_id = ? AND device_token = ?',
      [mailboxId, deviceToken]
    );
  }

  async _incrementStats(increments) {
    for (const [statKey, delta] of Object.entries(increments)) {
      const amount = Number(delta || 0);
      if (!Number.isFinite(amount) || amount === 0) {
        continue;
      }

      await this.run(
        `
        INSERT INTO relay_stat(stat_key, stat_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(stat_key) DO UPDATE SET
          stat_value = relay_stat.stat_value + excluded.stat_value,
          updated_at = CURRENT_TIMESTAMP
        `,
        [statKey, amount]
      );
    }
  }

  async _rollback(err) {
    try {
      await this.run('ROLLBACK');
    } catch (_) {}
    throw err;
  }

  close() {
    this.db.close();
  }
}

module.exports = { CheckpointStore, STAT_KEYS, ALL_STAT_KEYS };
