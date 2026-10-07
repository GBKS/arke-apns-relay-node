const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArkAddrAllowlist,
  isAllowedArkAddr,
  retryDelayMs,
  rateLimitKey,
  createRateLimiter
} = require('../src/guards');

test('default allowlist accepts the Second servers and nothing else', () => {
  const allowlist = parseArkAddrAllowlist(undefined);
  assert.equal(isAllowedArkAddr('https://ark.second.tech', allowlist), true);
  assert.equal(isAllowedArkAddr('https://ark.second.tech/', allowlist), true);
  assert.equal(isAllowedArkAddr('https://ARK.second.tech', allowlist), true);
  assert.equal(isAllowedArkAddr('https://ark.signet.2nd.dev', allowlist), true);

  assert.equal(isAllowedArkAddr('https://evil.example', allowlist), false);
  assert.equal(isAllowedArkAddr('http://ark.second.tech', allowlist), false);
  assert.equal(isAllowedArkAddr('https://ark.second.tech:8443', allowlist), false);
  assert.equal(isAllowedArkAddr('http://127.0.0.1:3000', allowlist), false);
});

test('allowlist rejects addresses that smuggle extra parts', () => {
  const allowlist = parseArkAddrAllowlist(undefined);
  assert.equal(isAllowedArkAddr('https://ark.second.tech/path', allowlist), false);
  assert.equal(isAllowedArkAddr('https://ark.second.tech?x=1', allowlist), false);
  assert.equal(isAllowedArkAddr('https://user@ark.second.tech', allowlist), false);
  assert.equal(isAllowedArkAddr('https://ark.second.tech.evil.example', allowlist), false);
  assert.equal(isAllowedArkAddr('not a url', allowlist), false);
});

test('custom allowlist, and "*" allows any http(s) origin', () => {
  const custom = parseArkAddrAllowlist(' https://ark.example.com:3535 , http://localhost:3535 ');
  assert.equal(isAllowedArkAddr('https://ark.example.com:3535', custom), true);
  assert.equal(isAllowedArkAddr('http://localhost:3535', custom), true);
  assert.equal(isAllowedArkAddr('https://ark.second.tech', custom), false);

  const any = parseArkAddrAllowlist('*');
  assert.equal(any, null);
  assert.equal(isAllowedArkAddr('https://anything.example', any), true);
  assert.equal(isAllowedArkAddr('ftp://anything.example', any), false);

  assert.throws(() => parseArkAddrAllowlist('ark.second.tech'), /not an http\(s\) origin/);
});

test('retry delay doubles per failure, stays in the upper half, and is capped', () => {
  const low = () => 0;
  const high = () => 1;
  assert.equal(retryDelayMs(1, 3000, 300000, low), 1500);
  assert.equal(retryDelayMs(1, 3000, 300000, high), 3000);
  assert.equal(retryDelayMs(2, 3000, 300000, high), 6000);
  assert.equal(retryDelayMs(5, 3000, 300000, high), 48000);
  assert.equal(retryDelayMs(8, 3000, 300000, high), 300000);
  assert.equal(retryDelayMs(8, 3000, 300000, low), 150000);
  assert.equal(retryDelayMs(10000, 3000, 300000, high), 300000);
  assert.equal(retryDelayMs(0, 3000, 300000, high), 3000);
});

test('rate limit key groups IPv6 by /64 and unwraps IPv4-mapped addresses', () => {
  assert.equal(rateLimitKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitKey('2001:db8:1:2:aaaa::1'), '2001:0db8:0001:0002::/64');
  assert.equal(rateLimitKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:0db8:0001:0002::/64');
  assert.equal(rateLimitKey('2001:db8::1'), '2001:0db8:0000:0000::/64');
  assert.equal(rateLimitKey('::1'), '0000:0000:0000:0000::/64');
  assert.equal(rateLimitKey('64:ff9b::203.0.113.7'), '0064:ff9b:0000:0000::/64');
  assert.equal(rateLimitKey(undefined), 'unknown');
});

test('rate limiter blocks past the max and forgets expired buckets on sweep', () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, now: () => clock });

  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('a').allowed, true);
  const blocked = limiter.hit('a');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);
  assert.equal(limiter.hit('b').allowed, true);

  clock = 30000;
  limiter.sweep();
  assert.equal(limiter.size, 2);

  clock = 60000;
  limiter.sweep();
  assert.equal(limiter.size, 0);
  assert.equal(limiter.hit('a').allowed, true);
});
