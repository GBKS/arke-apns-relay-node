const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// Returns a factory function `getClient(arkAddr)` that creates (and caches)
// one gRPC channel per unique Ark server address.
function createClientFactory(protoPath) {
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
    const client = new mailbox.MailboxService(addr, creds);
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
  readMailbox,
  subscribeMailbox
};
