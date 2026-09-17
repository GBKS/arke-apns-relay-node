const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { name, version } = require('../package.json');

// The bark server buckets client telemetry by this header (`<name>/<version>`,
// see server-rpc's `x-user-agent` handling); it must be a lowercase
// alphanumeric/dash/underscore name of at most 32 chars, or the server
// rejects the RPC outright.
const USER_AGENT_HEADER = 'x-user-agent';
const USER_AGENT_VALUE = `${name}/${version}`;

function userAgentInterceptor(options, nextCall) {
  return new grpc.InterceptingCall(nextCall(options), {
    start(metadata, listener, next) {
      metadata.add(USER_AGENT_HEADER, USER_AGENT_VALUE);
      next(metadata, listener);
    }
  });
}

const STATUS_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(grpc.status)
      .filter(([, value]) => typeof value === 'number')
      .map(([key, value]) => [value, key])
  )
);

function statusName(code) {
  return STATUS_NAMES[code] || String(code);
}

// Reports every finished RPC (unary or stream) to `onCall` with its final
// status and duration. For SubscribeMailbox the duration is the stream's
// lifetime. A throwing `onCall` must never break the RPC itself.
function createCallReportInterceptor(arkAddr, onCall) {
  return function callReportInterceptor(options, nextCall) {
    const startedAt = Date.now();
    const method = String(options.method_definition?.path || '').split('/').pop() || 'unknown';
    const streaming = Boolean(options.method_definition?.responseStream);
    let mailboxId = null;

    return new grpc.InterceptingCall(nextCall(options), {
      start(metadata, listener, next) {
        next(metadata, {
          onReceiveStatus(status, nextStatus) {
            try {
              onCall({
                method,
                streaming,
                arkAddr,
                mailboxId,
                code: status.code,
                codeName: statusName(status.code),
                details: status.details || '',
                durationMs: Date.now() - startedAt
              });
            } catch (_) {}
            nextStatus(status);
          }
        });
      },
      sendMessage(message, next) {
        if (Buffer.isBuffer(message?.mailbox_id)) {
          mailboxId = message.mailbox_id.toString('hex');
        }
        next(message);
      }
    });
  };
}

// Returns a factory function `getClient(arkAddr)` that creates (and caches)
// one gRPC channel per unique Ark server address. If `onCall` is given it is
// invoked once per finished RPC (see `createCallReportInterceptor`).
function createClientFactory(protoPath, { onCall } = {}) {
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });
  const loaded = grpc.loadPackageDefinition(packageDef);
  const mailbox = loaded.mailbox_server;
  if (!mailbox || !mailbox.MailboxService) {
    throw new Error('Could not load mailbox_server.MailboxService from proto file');
  }

  const cache = new Map();

  return function getClient(arkAddr) {
    if (cache.has(arkAddr)) return cache.get(arkAddr);
    const creds = arkAddr.startsWith('https://')
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    const addr = arkAddr.replace(/^https?:\/\//, '');
    const interceptors = [userAgentInterceptor];
    if (onCall) {
      interceptors.push(createCallReportInterceptor(arkAddr, onCall));
    }
    const client = new mailbox.MailboxService(addr, creds, { interceptors });
    cache.set(arkAddr, client);
    return client;
  };
}

function unary(client, methodCandidates, req) {
  return new Promise((resolve, reject) => {
    const name = methodCandidates.find((m) => typeof client[m] === 'function');
    if (!name) {
      return reject(new Error(`No unary method found in candidates: ${methodCandidates.join(', ')}`));
    }
    client[name](req, (err, resp) => {
      if (err) return reject(err);
      resolve(resp);
    });
  });
}

function stream(client, methodCandidates, req) {
  const name = methodCandidates.find((m) => typeof client[m] === 'function');
  if (!name) {
    throw new Error(`No stream method found in candidates: ${methodCandidates.join(', ')}`);
  }
  return client[name](req);
}

async function readMailbox(client, req) {
  return unary(client, ['ReadMailbox', 'readMailbox', 'read_mailbox'], req);
}

function subscribeMailbox(client, req) {
  return stream(client, ['SubscribeMailbox', 'subscribeMailbox', 'subscribe_mailbox'], req);
}

module.exports = {
  createClientFactory,
  statusName,
  readMailbox,
  subscribeMailbox
};
