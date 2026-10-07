const net = require('net');

// Ark servers the relay will open connections to. `ark_addr` comes from the
// request body and RELAY_API_TOKEN ships inside the app, so without this list
// anyone could point the relay at a server of their own: an unbounded number
// of workers and gRPC channels, connections into private networks, and pushes
// sent with our APNs key whenever that server says so.
const DEFAULT_ARK_ADDR_ALLOWLIST = 'https://ark.second.tech,https://ark.signet.2nd.dev';

// Returns null when every address is allowed ("*"), otherwise a Set of origins.
function parseArkAddrAllowlist(value) {
  const entries = String(value ?? DEFAULT_ARK_ADDR_ALLOWLIST)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.includes('*')) return null;

  const origins = new Set();
  for (const entry of entries) {
    const origin = arkAddrOrigin(entry);
    if (!origin) throw new Error(`ARK_ADDR_ALLOWLIST entry is not an http(s) origin: ${entry}`);
    origins.add(origin);
  }
  return origins;
}

// The address reduced to scheme://host[:port], or null if it carries anything
// else (a path, query, credentials) or isn't http(s). The gRPC client only
// uses host and port, so extra parts could only be used to dodge the allowlist.
function arkAddrOrigin(arkAddr) {
  let url;
  try {
    url = new URL(String(arkAddr));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

function isAllowedArkAddr(arkAddr, allowlist) {
  const origin = arkAddrOrigin(arkAddr);
  if (!origin) return false;
  return allowlist === null || allowlist.has(origin);
}

// Exponential backoff with jitter for reconnecting to the Ark server. The
// delay doubles with each consecutive failure, from `baseMs` up to `maxMs`, and
// is drawn from the upper half of that value so workers that failed together
// (an Ark outage hits all of them at once) don't retry in lockstep.
function retryDelayMs(consecutiveFailures, baseMs, maxMs, random = Math.random) {
  const exponent = Math.max(0, Number(consecutiveFailures || 1) - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(exponent, 30));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

// Bucket key for per-client rate limiting. IPv6 clients usually get a whole
// /64, so keying on the full address would hand each of them billions of
// buckets; IPv4-mapped IPv6 addresses are reduced to the IPv4 address.
function rateLimitKey(ip) {
  const address = String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (net.isIP(address) !== 6) return address || 'unknown';
  return `${expandIpv6(address).slice(0, 4).join(':')}::/64`;
}

function expandIpv6(address) {
  let text = address.split('%')[0].toLowerCase();
  // A trailing embedded IPv4 (e.g. 64:ff9b::1.2.3.4) is two more groups.
  const v4 = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = text.slice(0, -v4[0].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...Array(missing).fill('0'), ...tailGroups].map((group) => group.padStart(4, '0'));
}

// Fixed-window counter per key. Expired buckets are dropped by sweep(), which
// the caller runs on a timer, so memory is bounded by the number of distinct
// clients seen within one window.
function createRateLimiter({ windowMs, max, now = Date.now }) {
  const buckets = new Map();

  return {
    hit(key) {
      const ts = now();
      const entry = buckets.get(key);
      if (!entry || ts >= entry.resetAt) {
        buckets.set(key, { count: 1, resetAt: ts + windowMs });
        return { allowed: true };
      }
      entry.count += 1;
      if (entry.count <= max) return { allowed: true };
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - ts) / 1000)) };
    },
    sweep() {
      const ts = now();
      for (const [key, entry] of buckets) {
        if (ts >= entry.resetAt) buckets.delete(key);
      }
    },
    get size() {
      return buckets.size;
    }
  };
}

module.exports = {
  DEFAULT_ARK_ADDR_ALLOWLIST,
  parseArkAddrAllowlist,
  arkAddrOrigin,
  isAllowedArkAddr,
  retryDelayMs,
  rateLimitKey,
  createRateLimiter
};
