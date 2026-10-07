# Follow-ups

Open work for the relay, most important first. Numbers come from the production admin API (`/insights/v1`); the date says when they were pulled. Remove an item once it ships, and note anything that was learned on the way in the commit or PR.

Last updated: 2026-10-07

## Soon

### Find out why a push reached a second device an hour late

On 2026-10-06 a mailbox with two devices (one production, one sandbox build) got an `arkoor` message at 22:00 UTC. The relay pushed it to the sandbox device right away but to the production device only at 23:00:03, and the send itself took 151 ms. No message or push was logged for the payout expected at 23:00, and at 00:00 the sandbox device's push went through the environment fallback without a `send` event. Every other message that day went to the production device only. The pattern points at sending to more than one device per mailbox (`sendMailboxNotificationToRecipients` in `src/index.js` sends to them one at a time, and the dual-environment fallback is involved). The event log can't show more; the next step is `journalctl -u arke-apns-relay` for 21:55–00:05 UTC on 2026-10-06.

### Scale the wake-push lead to each token's lifetime

The app mints 30-day mailbox authorizations since 2026-09-26 and renews them at mid-life. Wake pushes still go out 2h and 1h before expiry (`AUTH_WAKE_LEAD_MS`), which was sized for 24h tokens. With 30-day tokens they only reach devices idle for over 15 days, and 2h leaves iOS little chance to deliver a throttled silent push. Proposal: a lead of a quarter of the token's lifetime, kept between 2h and 7 days, measured from registration time, with one wake per day inside that window plus the existing final wakes.

Do **not** simply raise `AUTH_WAKE_LEAD_MS`: devices on older app builds still send 24h tokens, and a multi-day lead is already in the past when they register, so the relay would wake them immediately and they'd re-register in a loop.

Deadline: the first 30-day tokens expire around 2026-10-26.

### Check that mid-life renewals happen (around 2026-10-15)

About 33 of the 47 live mailboxes minted their 30-day token on 2026-09-26..29, so renewals should start arriving around 2026-10-11..14. Expect roughly one registration per updated device per 15 days. If they don't show up, the app's renewal on launch, foreground and background task isn't firing.

## Worth doing

### Delete mailboxes whose authorization expired long ago

106 of 153 mailboxes sit in `auth_expired`. Most belong to wallets that are gone: 58 mainnet mailboxes expired before 2026-08-29, 18 more before 2026-09-21, and 24 are on signet. They cost no Ark calls, but they keep devices, get wake pushes and inflate the numbers. Proposal: delete mailboxes (and their devices) whose token expired more than 30 days ago.

### Stop counting the Ark server's hourly stream close as a failure

Since early October, `SubscribeMailbox` streams end with `RST_STREAM INTERNAL` after exactly 60 minutes (`streamLifetimeMs` ≈ 3,600,000), so it's a server-side limit rather than an error. These ~1,200 events a day make the `ark` and `worker` failure rates read ~50%. Record a reset after a stable stream as `info`, and keep it a failure when the stream dies young.

### Give the registration's Ark check a deadline

`POST /v1/register` validates the token with a `ReadMailbox` call that has no gRPC deadline. When the Ark server is slow or under attack, registrations hang until the connection gives up.

### Update `sqlite3`

`npm audit` reports 20 vulnerabilities (3 critical), mostly in the packages `sqlite3` pulls in to build itself (`tar`, `glob`, `prebuild-install`). Check whether a current `sqlite3` drops them.

## Security

From the review on 2026-10-07. The allowlist, caps, backoff and rate limits from that review shipped in #11.

- **DDoS protection in front of the server**, such as Cloudflare or the host's own. A single VPS behind Caddy can't absorb a flood. The app only talks HTTPS to `/v1`, so this should be transparent to it.
- **Restrict `/insights/v1` to known IPs** in Caddy, or reach it over an SSH tunnel. It's token-protected but public, and gets the occasional unauthorized request.
- **Set `TRUST_PROXY=loopback`** instead of `1`. Today per-IP limits rely on Caddy (2.5+) replacing any client-sent `X-Forwarded-For`.

## Small

- **Deploy scripts:** `backup-config.sh` and `rollback.sh` ask for a domain only to find an nginx site config. Servers on Caddy should back up and restore `/etc/caddy/Caddyfile` instead, and skip the question.
- **Leaked stream on stop:** `worker.stop()` during backfill doesn't prevent the subscribe stream from opening afterwards.
- **`auth_paused` workers retry every 15 min forever.** A worker lands there when the Ark server rejects a token the relay couldn't see was expired.
- **No APNs retry or dead-letter queue** for transient send failures.
- **No end-to-end tests** for registration and stream recovery.
