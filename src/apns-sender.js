const fs = require('fs');
const apn = require('apn');

class StaleDeviceTokenError extends Error {
  constructor(deviceToken, reason, environment = '') {
    const envSuffix = environment ? ` [${environment}]` : '';
    super(`APNs device token stale${envSuffix}: ${reason} (token suffix ${deviceToken.slice(-8)})`);
    this.name = 'StaleDeviceTokenError';
    this.deviceToken = deviceToken;
    this.apnsReason = reason;
    this.apnsEnvironment = environment;
  }
}

class ApnsSender {
  constructor(config, logger) {
    this.logger = logger;
    this.config = config;
    const primaryToken = {
      key: fs.readFileSync(config.keyFile),
      keyId: config.keyId,
      teamId: config.teamId
    };
    this.primaryEnvironment = config.production ? 'production' : 'sandbox';
    this.primaryProvider = new apn.Provider({
      token: primaryToken,
      production: config.production
    });

    this.fallbackEnvironment = null;
    this.fallbackProvider = null;
    if (config.allowBothEnvironments) {
      this.fallbackEnvironment = config.production ? 'sandbox' : 'production';
      const fallbackCreds = config.fallbackCredentials || {
        keyFile: config.keyFile,
        keyId: config.keyId,
        teamId: config.teamId
      };
      const fallbackToken = {
        key: fs.readFileSync(fallbackCreds.keyFile),
        keyId: fallbackCreds.keyId,
        teamId: fallbackCreds.teamId
      };
      this.fallbackProvider = new apn.Provider({
        token: fallbackToken,
        production: !config.production
      });
    }
  }

  async sendMailboxNotification({ checkpoint, vtxoCount, totalSats, mailboxId, deviceToken, topic }) {
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
    const title = totalSats > 0
      ? `Received \u20BF${totalSats.toLocaleString('en-US')}`
      : 'Received bitcoin';
    const body = vtxoCount === 1 ? 'View payment.' : `View ${vtxoCount} payments.`;
    note.alert = { title, body };

    try {
      await this._sendViaProvider(this.primaryProvider, this.primaryEnvironment, note, deviceToken);
    } catch (err) {
      const canTryFallback =
        this.fallbackProvider
        && err instanceof StaleDeviceTokenError
        && (err.apnsReason === 'BadDeviceToken' || err.apnsReason === 'Unregistered');

      if (!canTryFallback) throw err;

      this.logger.warn(
        {
          deviceTokenSuffix: deviceToken.slice(-8),
          fromEnvironment: this.primaryEnvironment,
          toEnvironment: this.fallbackEnvironment,
          reason: err.apnsReason
        },
        'retrying APNs send in fallback environment after stale-token response'
      );

      await this._sendViaProvider(this.fallbackProvider, this.fallbackEnvironment, note, deviceToken);
      this.logger.info(
        {
          deviceTokenSuffix: deviceToken.slice(-8),
          environment: this.fallbackEnvironment
        },
        'apns notification delivered via fallback environment'
      );
    }

    this.logger.info({ checkpoint, vtxoCount, topic }, 'apns notification delivered');
  }

  async _sendViaProvider(provider, environment, note, deviceToken) {
    const result = await provider.send(note, deviceToken);
    if ((result.failed || []).length > 0) {
      const failure = result.failed[0];
      const reason = failure.response?.reason;
      if (reason === 'BadDeviceToken' || reason === 'Unregistered') {
        throw new StaleDeviceTokenError(deviceToken, reason, environment);
      }
      throw new Error(`APNs send failed: ${JSON.stringify(failure)}`);
    }
  }

  shutdown() {
    this.primaryProvider.shutdown();
    if (this.fallbackProvider) {
      this.fallbackProvider.shutdown();
    }
  }
}

module.exports = { ApnsSender, StaleDeviceTokenError };
