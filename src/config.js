const path = require('path');

function parseBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function parseIntOr(v, fallback) {
  const parsed = Number.parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function must(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function loadConfig() {
  const fallbackKeyFile = process.env.APNS_FALLBACK_KEY_FILE || '';
  const fallbackKeyId = process.env.APNS_FALLBACK_KEY_ID || '';
  const fallbackTeamId = process.env.APNS_FALLBACK_TEAM_ID || '';
  const fallbackCredsConfigured = Boolean(fallbackKeyFile || fallbackKeyId || fallbackTeamId);

  if (fallbackCredsConfigured && !(fallbackKeyFile && fallbackKeyId && fallbackTeamId)) {
    throw new Error(
      'APNS_FALLBACK_KEY_FILE, APNS_FALLBACK_KEY_ID, and APNS_FALLBACK_TEAM_ID must all be set together'
    );
  }

  return {
    protoPath: path.resolve(process.cwd(), process.env.PROTO_PATH || './protos/mailbox_server.proto'),
    checkpointDb: path.resolve(process.cwd(), process.env.CHECKPOINT_DB || './relay.db'),
    subscribeRetryMs: parseIntOr(process.env.SUBSCRIBE_RETRY_MS, 3000),
    metricsPort: parseIntOr(process.env.METRICS_PORT, 9898),
    relayApiToken: process.env.RELAY_API_TOKEN || '',
    rateLimitWindowMs: parseIntOr(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax: parseIntOr(process.env.RATE_LIMIT_MAX, 30),
    trustProxy: parseBool(process.env.TRUST_PROXY, false),
    dryRun: parseBool(process.env.DRY_RUN, false),
    apns: {
      keyFile: must('APNS_KEY_FILE'),
      keyId: must('APNS_KEY_ID'),
      teamId: must('APNS_TEAM_ID'),
      topic: must('APNS_TOPIC'),
      production: parseBool(process.env.APNS_PRODUCTION, true),
      allowBothEnvironments: parseBool(process.env.APNS_ALLOW_BOTH_ENVIRONMENTS, false),
      fallbackCredentials: fallbackCredsConfigured
        ? {
            keyFile: fallbackKeyFile,
            keyId: fallbackKeyId,
            teamId: fallbackTeamId
          }
        : null,
      pushType: process.env.APNS_PUSH_TYPE || 'alert'
    }
  };
}

module.exports = { loadConfig };
