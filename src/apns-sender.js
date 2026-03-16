const fs = require('fs');
const apn = require('apn');

class StaleDeviceTokenError extends Error {
  constructor(deviceToken, reason) {
    super(`APNs device token stale: ${reason} (token suffix ${deviceToken.slice(-8)})`);
    this.name = 'StaleDeviceTokenError';
    this.deviceToken = deviceToken;
    this.apnsReason = reason;
  }
}

class ApnsSender {
  constructor(config, logger) {
    this.logger = logger;
    this.config = config;
    this.provider = new apn.Provider({
      token: {
        key: fs.readFileSync(config.keyFile),
        keyId: config.keyId,
        teamId: config.teamId
      },
      production: config.production
    });
  }

  async sendMailboxNotification({ checkpoint, vtxoCount, mailboxId, deviceToken, topic }) {
    const note = new apn.Notification();
    note.topic = topic || this.config.topic;
    note.pushType = this.config.pushType;
    note.sound = 'default';
    note.payload = {
      type: 'mailbox_arkoor',
      checkpoint,
      vtxo_count: vtxoCount,
      mailbox_id: mailboxId
    };
    note.alert = {
      title: 'New Ark mailbox event',
      body: `Checkpoint ${checkpoint} (${vtxoCount} VTXO${vtxoCount === 1 ? '' : 's'})`
    };

    const result = await this.provider.send(note, deviceToken);
    if (result.failed.length > 0) {
      const failure = result.failed[0];
      const reason = failure.response?.reason;
      if (reason === 'BadDeviceToken' || reason === 'Unregistered') {
        throw new StaleDeviceTokenError(deviceToken, reason);
      }
      throw new Error(`APNs send failed: ${JSON.stringify(failure)}`);
    }

    this.logger.info({ checkpoint, vtxoCount, topic }, 'apns notification delivered');
  }

  shutdown() {
    this.provider.shutdown();
  }
}

module.exports = { ApnsSender, StaleDeviceTokenError };
