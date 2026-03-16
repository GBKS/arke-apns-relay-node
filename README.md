# Node.js Mailbox Relay Prototype

First-draft mailbox → APNs relay prototype. For the Ark implementation by [Second](https://second.tech) ([repo](https://gitlab.com/ark-bitcoin/bark)).

## Done

- Reads and subscribes to Ark mailbox RPCs (`ReadMailbox`, `SubscribeMailbox`)
- Sends APNs notifications for mailbox `Arkoor` messages
- Stores a per-mailbox checkpoint in SQLite
- Supports registration fanout (`mailbox_id -> many APNs device tokens`)
- Validates registration mailbox authorization by calling Ark `ReadMailbox`
- Multi-mailbox, multi-server: each wallet registers with its own Ark server address; one subscription worker per mailbox
- Workers start/stop dynamically as devices are registered/unregistered
- Workers resume automatically when a fresh auth token arrives via re-registration
- Exposes `GET /healthz`, `GET /metrics`, `POST /v1/register`, `DELETE /v1/register`, `GET /v1/registrations`

## Still missing

- No APNs retry queue / dead-letter queue
- No persistent audit/event log for registration changes
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

### Runtime values

- `PROTO_PATH`: path to `mailbox_server.proto` (default: `./protos/mailbox_server.proto`).
- `CHECKPOINT_DB`: SQLite file path for checkpoints + registration tables.
- `SUBSCRIBE_RETRY_MS`: delay before re-subscribing after stream error/end.
- `METRICS_PORT`: HTTP port for health/metrics/registration endpoints.
- `DRY_RUN=1`: do not send APNs, but still process and advance checkpoints.
- `RELAY_API_TOKEN`: if set, `/v1/*` endpoints require either `x-relay-token: <token>` or `Authorization: Bearer <token>`.
- `RATE_LIMIT_WINDOW_MS`: in-memory per-IP window for `/v1/*` requests (default `60000`).
- `RATE_LIMIT_MAX`: max requests per IP per window for `/v1/*` (default `30`).
- `TRUST_PROXY=1`: enable if relay runs behind reverse proxy and should trust forwarded IP.

## How wallet credentials work

- `mailbox_id` is the wallet's mailbox identifier bytes (hex), used as `MailboxRequest.unblinded_id`.
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
- Checkpoint is persisted only after successful APNs send (or always in `DRY_RUN=1`).
- Backfill loop continues while `have_more=true`, then switches to streaming mode.

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
