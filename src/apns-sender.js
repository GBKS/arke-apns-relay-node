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

  async sendMailboxNotification({
    messageType,
    checkpoint,
    vtxoCount,
    totalSats,
    paymentHashCount,
    hasPaymentHash,
    recoveryVtxoCount,
    mailboxId,
    deviceToken,
    topic
  }) {
    const note = this._buildMailboxNotification({
      messageType,
      checkpoint,
      vtxoCount,
      totalSats,
      paymentHashCount,
      hasPaymentHash,
      recoveryVtxoCount,
      mailboxId,
      topic
    });

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

    this.logger.info({ checkpoint, messageType, topic }, 'apns notification delivered');
  }

  _buildMailboxNotification({
    messageType,
    checkpoint,
    vtxoCount,
    totalSats,
    paymentHashCount,
    hasPaymentHash,
    recoveryVtxoCount,
    mailboxId,
    topic
  }) {
    const note = new apn.Notification();
    note.topic = topic || this.config.topic;

    switch (messageType) {
      case 'arkoor': {
        this._configureAlertNotification(note);
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
        return note;
      }

      case 'roundParticipationCompleted': {
        this._configureBackgroundNotification(note);
        note.payload = {
          type: 'mailbox_round_participation_completed',
          checkpoint,
          payment_hash_count: paymentHashCount,
          mailbox_id: mailboxId
        };
        return note;
      }

      case 'incomingLightningPayment': {
        this._configureAlertNotification(note);
        note.payload = {
          type: 'mailbox_incoming_lightning_payment',
          checkpoint,
          has_payment_hash: hasPaymentHash,
          mailbox_id: mailboxId
        };
        note.alert = {
          title: 'Incoming payment',
          body: 'Open Arké to accept it.'
        };
        return note;
      }

      case 'recoveryVtxoIds': {
        this._configureBackgroundNotification(note);
        note.payload = {
          type: 'mailbox_recovery_vtxo_ids',
          checkpoint,
          recovery_vtxo_count: recoveryVtxoCount,
          mailbox_id: mailboxId
        };
        return note;
      }

      default:
        throw new Error(`unsupported mailbox notification type: ${messageType}`);
    }
  }

  _configureAlertNotification(note) {
    note.pushType = this.config.pushType;
    note.sound = 'default';
  }

  _configureBackgroundNotification(note) {
    note.pushType = 'background';
    note.priority = 5;
    note.contentAvailable = 1;
    delete note.sound;
    delete note.alert;
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
