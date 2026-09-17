# Node.js Mailbox Relay Prototype

First-draft mailbox → APNs relay prototype. For the Ark implementation by [Second](https://second.tech) ([repo](https://gitlab.com/ark-bitcoin/bark)).

## Done

- Reads and subscribes to Ark mailbox RPCs (`ReadMailbox`, `SubscribeMailbox`)
- Sends APNs notifications for mailbox `Arkoor`, `RoundParticipationCompleted`, `IncomingLightningPayment`, `RecoveryVtxoIds`, and `LightningSendFinished` messages
- Sends user-visible alerts for `Arkoor`, `IncomingLightningPayment`, and `LightningSendFinished`, and silent background pushes for `RoundParticipationCompleted` and `RecoveryVtxoIds`
- Stores a per-mailbox checkpoint in SQLite
- Stores persistent global lifetime activity counters in SQLite and exposes them on `/metrics`
- Supports registration fanout (`mailbox_id -> many APNs device tokens`)
- Validates registration mailbox authorization by calling Ark `ReadMailbox`
- Multi-mailbox, multi-server: each wallet registers with its own Ark server address; one subscription worker per mailbox
- Workers start/stop dynamically as devices are registered/unregistered
- Workers resume automatically when a fresh auth token arrives via re-registration
- Exposes `GET /healthz`, `GET /metrics`, `POST /v1/register`, `DELETE /v1/register`, `GET /v1/registrations`
- Persistent event log (HTTP requests, Ark gRPC calls, APNs sends, worker state changes) with a read-only, token-protected admin API under `/insights/v1/*` for building a dashboard

## Still missing

- No APNs retry queue / dead-letter queue
- No end-to-end test suite yet

## Quick start

1. Install dependencies:

```bash
npm ci
```

2. Create config:

```bash
cp .env.example .env
```

3. Fill required values in `.env`:

- `APNS_KEY_FILE`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_TOPIC`

## `.env` reference

### APNs values

- `APNS_KEY_FILE` — filesystem path to your Apple `.p8` key.
- `APNS_KEY_ID` — Apple Key ID for that `.p8` key.
- `APNS_TEAM_ID` — Apple Developer Team ID.
- `APNS_TOPIC` — iOS app bundle id used as APNs topic (example: `com.example.app`).
- `APNS_PRODUCTION` — `1` for production APNs, `0` for sandbox APNs.
- `APNS_ALLOW_BOTH_ENVIRONMENTS` — if `1`, relay retries once against the opposite APNs environment after `BadDeviceToken`/`Unregistered`.
- `APNS_FALLBACK_KEY_FILE`, `APNS_FALLBACK_KEY_ID`, `APNS_FALLBACK_TEAM_ID` — optional dedicated credentials for the fallback environment when dual-mode is enabled. Set all three together.

### Runtime values

- `PROTO_PATH`: path to `mailbox_server.proto` (default: `./protos/mailbox_server.proto`).
- `CHECKPOINT_DB`: SQLite file path for checkpoints + registration tables.
- `SUBSCRIBE_RETRY_MS`: delay before re-subscribing after a transient stream error/end.
- `AUTH_RETRY_MS`: delay before retrying after a mailbox authorization is rejected (expired/invalid), instead of the short `SUBSCRIBE_RETRY_MS` interval (default `900000` / 15 min). A fresh `POST /v1/register` wakes the worker immediately regardless of this delay, so it's just a safety-net ceiling.
- `METRICS_PORT`: HTTP port for health/metrics/registration endpoints.
- `DRY_RUN=1`: do not send APNs, but still process and advance checkpoints.
- `RELAY_API_TOKEN`: if set, `/v1/*` endpoints require either `x-relay-token: <token>` or `Authorization: Bearer <token>`.
- `RATE_LIMIT_WINDOW_MS`: in-memory per-IP window for `/v1/*` requests (default `60000`).
- `RATE_LIMIT_MAX`: max requests per IP per window for `/v1/*` (default `30`).
- `TRUST_PROXY=1`: enable if relay runs behind reverse proxy and should trust forwarded IP.

### Event log and admin API values

- `EVENTS_DB`: SQLite file for the event log (default: `relay-events.db` next to `CHECKPOINT_DB`). Separate from the checkpoint DB and safe to delete.
- `EVENT_RETENTION_DAYS`: days to keep individual event rows (default `30`). Hourly rollup counts are kept forever.
- `EVENT_MAX_ROWS`: hard cap on event rows, oldest dropped first (default `2000000`).
- `ADMIN_API_TOKEN`: bearer token for `/insights/v1/*`. If empty, the admin endpoints are not mounted at all. Keep it different from `RELAY_API_TOKEN`, which ships inside the app and can't be treated as a secret.
- `ADMIN_CORS_ORIGIN`: comma-separated browser origins allowed to read the admin API (default `localhost`, which means `http://localhost` / `http://127.0.0.1` on any port).
- `ADMIN_RATE_LIMIT_MAX`: max admin requests per IP per minute (default `300`).

## How wallet credentials work

- `mailbox_id` is the wallet's mailbox identifier bytes (hex), used as `MailboxRequest.mailbox_id`.
- `authorization_hex` is a short-lived serialized `MailboxAuthorization`. When it expires the worker logs an error and pauses; the next `POST /v1/register` from the wallet delivers a fresh token and the worker resumes immediately.
- `ark_addr` is the gRPC endpoint of the Ark server the wallet is connected to. The relay creates one cached gRPC channel per unique address.

4. Run relay:

```bash
npm start
```

## Automated server setup (Hetzner runbook script)


If you want one command instead of manual copy/paste, run:

```bash
./scripts/setup-relay-server.sh
```

It runs from your local machine, prompts for required values, uploads your `.p8` key and both `mailbox_server.proto` and its required `core.proto`, and configures the remote server over SSH (node, systemd, nginx, optional certbot, optional ufw).

**Important:** You must have both `mailbox_server.proto` and `core.proto` (from the [`bark`](https://gitlab.com/ark-bitcoin/bark) repo) in the same directory before running the setup script. Both files are required for the relay to start.

## Notes

- Method names can vary by dynamic gRPC loader casing; this draft tries multiple candidates.
- Checkpoint is persisted after message processing, even if APNs delivery fails, to avoid repeated delivery attempts for the same message.
- Backfill loop continues while `have_more=true`, then switches to streaming mode.

## Persistent lifetime metrics

The relay now persists these lifetime counters in the same SQLite database configured by `CHECKPOINT_DB`, reloads them on startup, and exports them through `GET /metrics`:

- `lifetime_vtxos_processed`
- `lifetime_sats_processed`
- `lifetime_sats_notified_incoming_lightning` (sats seen in pending-claim Lightning receive notifications; not yet-settled value, tracked separately from `lifetime_sats_processed`)
- `lifetime_mailbox_messages_received`
- `lifetime_registrations`
- `lifetime_unregistrations`
- `lifetime_stale_device_removals`

These survive relay restarts because they are backed by SQLite rather than process memory.

./scripts/show-lifetime-stats.sh /opt/arke-relay/data/relay.db

## Event log and admin API

Every HTTP request, Ark gRPC call, APNs send and worker state change is recorded in a second SQLite database (`EVENTS_DB`):

- `event` — one row per distinct thing that happened. Identical events (same category, name, outcome, code, mailbox, server and client IP) within an hour collapse into one row with a `count`, `ts` (first seen) and `last_ts`, so a flapping worker can't flood the table. Rows are pruned after `EVENT_RETENTION_DAYS`.
- `rollup_hourly` — exact counts per hour and `(category, name, outcome, code)`. No mailbox or IP, never pruned; this is what charts are drawn from.

| Category | Names | Codes |
|---|---|---|
| `http` | `POST /v1/register`, `DELETE /v1/register`, `GET /v1/registrations`, `<METHOD> /v1/*` (rejected before routing), `unmatched` | HTTP status on success; otherwise a reason: `missing_fields`, `invalid_mailbox_id`, `invalid_authorization_hex`, `invalid_ark_addr`, `invalid_device_token`, `invalid_apns_topic`, `invalid_body`, `body_too_large`, `ark_auth_rejected`, `ark_<grpc status>` (e.g. `ark_unavailable`), `unauthorized`, `rate_limited`, `internal_error` |
| `ark` | `ReadMailbox`, `SubscribeMailbox` | gRPC status name (`OK`, `UNAUTHENTICATED`, `UNAVAILABLE`, …). `CANCELLED` is the relay stopping its own stream and is recorded as `info`, not `fail` |
| `apns` | `send`, `fallback_retry`, `skipped_no_devices`, `skipped_dry_run` | APNs reason (`BadDeviceToken`, `Unregistered`, `TooManyRequests`, …) or `transport_error` |
| `mailbox` | `message` | message type, or `unsupported` |
| `worker` | `backfilling`, `streaming`, `retrying`, `auth_paused`, `stopped`, `message_processing_error` | error code that caused the transition (`STREAM_ENDED` when the server closed the stream cleanly) |
| `db` | where it happened | SQLite error code |
| `admin` | failed requests under `/insights/v1/` only | reason |
| `relay` | `started`, `stopped` | signal |

Privacy: only the first 8 hex chars of a mailbox id and the last 8 of a device token are stored; authorization tokens never are. Client IPs are stored only on `401` and `429` responses.

### Endpoints

All require `Authorization: Bearer <ADMIN_API_TOKEN>` and are read-only. The path is deliberately not `/admin`, which every scanner probes; nginx should forward only the exact `/insights/v1/` prefix so that probe traffic never reaches the relay or its event log.

- `GET /insights/v1/summary?hours=24` — ok/fail/info totals and failure rate per category, top 20 failures, worker counts by state (plus `flapping`: 3+ consecutive failures), registered devices, lifetime counters, event log status.
- `GET /insights/v1/workers?state=auth_paused` — live per-mailbox worker state: `state`, `state_since`, `consecutive_failures`, `connects`, `messages_processed`, `last_message_at`, `last_auth_refresh_at`, `last_error`, `next_retry_at`. Sorted worst first.
- `GET /insights/v1/events?category=&name=&outcome=&code=&mailbox=&limit=100` — newest first; page back with `before_id=<min_id>`. To tail, pass `since_id=<max_id>`: rows then come oldest first. Collapsed repeats update `count`/`last_ts` on their existing row and keep their id.
- `GET /insights/v1/timeseries?hours=48&category=&name=&outcome=&code=&group_by=outcome` — hourly counts as `{ series: { <key>: [[hour_ms, count], …] } }`. `group_by` is one of `category`, `name`, `outcome`, `code`.

```bash
curl -s -H 'Authorization: Bearer <ADMIN_API_TOKEN>' https://relay.example.com/insights/v1/summary
```

### Enabling it on an existing server

New installs get this from `setup-relay-server.sh`. On a server that is already running:

1. Add `ADMIN_API_TOKEN=<openssl rand -hex 32>` to `/opt/arke-relay/app/.env` (the event log itself needs no configuration).
2. Add this block to the nginx site config, next to `location /v1/`, then `sudo nginx -t && sudo systemctl reload nginx`:

```nginx
location /insights/v1/ {
    proxy_pass http://127.0.0.1:9898;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

3. `sudo systemctl restart arke-apns-relay`

To keep the admin API off the public internet instead, skip step 2 and reach it through an SSH tunnel: `ssh -L 9898:127.0.0.1:9898 <server>`, then use `http://localhost:9898/insights/v1/...`.

## iOS registration API

If `RELAY_API_TOKEN` is configured, include auth header on all `/v1/*` calls:

```bash
-H 'x-relay-token: <RELAY_API_TOKEN>'
```

Register device:

```bash
curl -X POST http://localhost:9898/v1/register \
	-H 'x-relay-token: <RELAY_API_TOKEN>' \
	-H 'content-type: application/json' \
	-d '{
		"mailbox_id": "<UNBLINDED_ID_HEX>",
		"authorization_hex": "<MAILBOX_AUTH_HEX>",
		"ark_addr": "https://ark.example.com:3535",
		"device_token": "<APNS_DEVICE_TOKEN>",
		"apns_topic": "com.example.app"
	}'
```

Unregister device:

```bash
curl -X DELETE http://localhost:9898/v1/register \
	-H 'x-relay-token: <RELAY_API_TOKEN>' \
	-H 'content-type: application/json' \
	-d '{
		"mailbox_id": "<UNBLINDED_ID_HEX>",
		"device_token": "<APNS_DEVICE_TOKEN>"
	}'
```

List registrations:

```bash
curl -H 'x-relay-token: <RELAY_API_TOKEN>' \
	"http://localhost:9898/v1/registrations?mailbox_id=<UNBLINDED_ID_HEX>"
```

## Next hardening steps

- Add retry/dead-letter queue for APNs transient failures
- Add tests for registration and stream recovery behavior
