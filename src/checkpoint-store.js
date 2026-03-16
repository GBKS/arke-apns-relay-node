const sqlite3 = require('sqlite3');

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
    await this.run(
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
    await this.run(
      `
      INSERT INTO device_registration (mailbox_id, device_token, apns_topic, created_at, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(mailbox_id, device_token) DO UPDATE SET
        apns_topic = excluded.apns_topic,
        updated_at = CURRENT_TIMESTAMP
      `,
      [mailboxId, deviceToken, apnsTopic]
    );
  }

  async unregisterDevice(mailboxId, deviceToken) {
    const result = await this.run(
      'DELETE FROM device_registration WHERE mailbox_id = ? AND device_token = ?',
      [mailboxId, deviceToken]
    );
    return result.changes || 0;
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

  run(sql, args = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, args, function runResult(err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = { CheckpointStore };
