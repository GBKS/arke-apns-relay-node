# Beginner Server Setup Runbook (Hetzner + APNs Relay)

This guide is written for developers who are not deeply familiar with server setup.

It is intentionally copy/paste-friendly.

This guide assumes you are adding the relay to **your existing Hetzner server** that already runs the Ark Bitcoin faucet (nginx is already installed and running).

The relay will be reachable at `relay.example.com`.

---

## Before You Start

You need:

- SSH access to your Hetzner server
- A DNS A record for `relay.example.com` pointing to your server's IP address (add this in your DNS provider before continuing)
- Your APNs `.p8` key file on your local machine (see next section)
  - The `mailbox_server.proto` **and its required `core.proto`** files from the [`bark`](https://gitlab.com/ark-bitcoin/bark) repository on your local machine (both are required)
- These relay values ready:
  - `APNS_KEY_ID`
  - `APNS_TEAM_ID`
  - `APNS_TOPIC`

You can stop and resume this guide at any time.

---

## Fast Path (Automated)

If you prefer not to copy/paste the full runbook manually, use the bootstrap script from your local machine:

```bash
./scripts/setup-relay-server.sh
```

It prompts for the required values, uploads your `.p8`, and configures node, systemd, nginx, optional certbot, and optional firewall rules over SSH.

By default, it uses `./protos/mailbox_server.proto` and `./protos/core.proto` from this repo if they exist. If they are missing, it prompts you for local proto file paths.

If you use this script, you can skip to **9) Verify It Works (3 quick checks)** after it finishes.

---

## Getting Your APNs `.p8` Key File

This key lets the relay send push notifications through Apple's servers on behalf of your app.

1. Go to [developer.apple.com](https://developer.apple.com) and sign in
2. Click **Account** → **Certificates, Identifiers & Profiles** → **Keys** (in the left sidebar)
3. Click the **+** button to create a new key
4. Give it a name (e.g. `Arke APNs Relay`) and check **Apple Push Notifications service (APNs)**
5. Click **Continue**, then **Register**
6. On the confirmation page, note the **Key ID** — you will need it as `APNS_KEY_ID`
7. Click **Download** — this downloads a file named `AuthKey_XXXXXXXXXX.p8`

> **Important:** You can only download the `.p8` file once. If you close this page without downloading, you will need to revoke the key and create a new one. Store the file somewhere safe.

While you are in the portal, also grab:

- **Team ID**: shown in the top-right corner of the developer portal (or under **Membership** → **Team ID**)
- **Bundle ID** (`APNS_TOPIC`): your app's bundle identifier (e.g. `com.example.yourapp`), found under **Identifiers**

---

## 1) Check Node.js is Installed

SSH into your server:

```bash
ssh <your-user>@<your-server-ip>
```

Check if Node.js 20+ is already installed:

```bash
node -v
```

If it prints `v20.x.x` or higher, skip the rest of this section.

If Node.js is missing or older than v20, install it:

```bash
sudo apt update
sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Also make sure `sqlite3` is installed (likely already present):

```bash
sqlite3 --version || sudo apt install -y sqlite3
```

Create an isolated user and folders for the relay:

```bash
sudo adduser --system --group --home /opt/arke-relay arke-relay
sudo mkdir -p /opt/arke-relay/{app,data,keys}
sudo chown -R arke-relay:arke-relay /opt/arke-relay
sudo chmod 750 /opt/arke-relay/keys
```

---

## 2) Put App Code on Server

Clone the repo:

```bash
sudo -u arke-relay git clone https://github.com/GBKS/arke-apns-relay-node /opt/arke-relay/app
```

Install dependencies:

```bash
cd /opt/arke-relay/app
sudo -u arke-relay npm ci --omit=dev
```

Expected result: install finishes without errors.


### Copy the gRPC proto files

From your local machine, upload both proto files:

```bash
scp /local/path/to/mailbox_server.proto <your-user>@<your-server-ip>:/tmp/mailbox_server.proto
scp /local/path/to/core.proto <your-user>@<your-server-ip>:/tmp/core.proto
```

Back on server shell:

```bash
sudo -u arke-relay mkdir -p /opt/arke-relay/app/protos
sudo install -o arke-relay -g arke-relay -m 644 /tmp/mailbox_server.proto /opt/arke-relay/app/protos/mailbox_server.proto
sudo install -o arke-relay -g arke-relay -m 644 /tmp/core.proto /opt/arke-relay/app/protos/core.proto
rm /tmp/mailbox_server.proto /tmp/core.proto
```

Expected result: files exist at `/opt/arke-relay/app/protos/mailbox_server.proto` and `/opt/arke-relay/app/protos/core.proto`.

---

## 3) Upload APNs Key Securely

From your local machine (not from server shell), run:

```bash
scp /local/path/AuthKey_XXXXXX.p8 <your-user>@<your-server-ip>:/tmp/apns.p8
```

Back on server shell:

```bash
sudo install -o arke-relay -g arke-relay -m 600 /tmp/apns.p8 /opt/arke-relay/keys/apns.p8
rm /tmp/apns.p8
```

Expected result:

- Key exists at `/opt/arke-relay/keys/apns.p8`
- Only relay user can read it

---

## 4) Create `.env` (Secrets + Settings)

For normal operation, you only need APNs + runtime values in `.env`.

Create env file:

```bash
sudo tee /opt/arke-relay/app/.env > /dev/null << 'EOF'
PROTO_PATH=/opt/arke-relay/app/protos/mailbox_server.proto

CHECKPOINT_DB=/opt/arke-relay/data/relay.db
SUBSCRIBE_RETRY_MS=3000
METRICS_PORT=9898
DRY_RUN=0

APNS_KEY_FILE=/opt/arke-relay/keys/apns.p8
APNS_KEY_ID=<APNS_KEY_ID>
APNS_TEAM_ID=<APNS_TEAM_ID>
APNS_TOPIC=<APNS_TOPIC>
APNS_PRODUCTION=0
APNS_PUSH_TYPE=alert

RELAY_API_TOKEN=<LONG_RANDOM_SECRET>
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
TRUST_PROXY=1
EOF
```

> **Warning — APNs sandbox vs production:** The template above sets `APNS_PRODUCTION=0` (sandbox). Sandbox only works with **development** app builds and their device tokens. Before going live with real users, change this to `APNS_PRODUCTION=1`.

Generate a strong token and replace `<LONG_RANDOM_SECRET>` if needed:

```bash
openssl rand -hex 32
```

Lock env permissions:

```bash
sudo chown arke-relay:arke-relay /opt/arke-relay/app/.env
sudo chmod 600 /opt/arke-relay/app/.env
```

---

## 5) Create `systemd` Service (Auto-start + Restart)

Create service file:

```bash
sudo tee /etc/systemd/system/arke-apns-relay.service > /dev/null << 'EOF'
[Unit]
Description=Arke APNs Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=arke-relay
Group=arke-relay
WorkingDirectory=/opt/arke-relay/app
EnvironmentFile=/opt/arke-relay/app/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/opt/arke-relay/data

[Install]
WantedBy=multi-user.target
EOF
```

Start service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now arke-apns-relay
sudo systemctl status arke-apns-relay --no-pager
```

Expected result:

- status shows `active (running)`

If not running, check logs:

```bash
journalctl -u arke-apns-relay -n 100 --no-pager
```

---

## 6) Put Relay Behind Nginx

Since nginx is already running for your faucet, create a **new** site config for `relay.example.com`:

```bash
sudo tee /etc/nginx/sites-available/relay.example.com > /dev/null << 'EOF'
server {
    listen 80;
    server_name relay.example.com;

    location /v1/ {
        proxy_pass http://127.0.0.1:9898;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /healthz {
        proxy_pass http://127.0.0.1:9898/healthz;
    }

    location = /metrics {
        deny all;
    }
}
EOF
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/relay.example.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Expected result:

- `nginx -t` says `syntax is ok` and `test is successful`

---

## 7) TLS Certificate (HTTPS)

Get a certificate for `relay.example.com` (certbot is already installed from your faucet setup; if not, install it first with `sudo apt install -y certbot python3-certbot-nginx`):

```bash
sudo certbot --nginx -d relay.example.com
```

Expected result: certbot finishes successfully, edits the nginx config, and HTTPS works. Certbot's auto-renewal cron/timer is already active from your faucet setup.

---

## 8) Firewall (Recommended)

Your faucet may already have ufw configured. Make sure port `9898` (relay internals) is not publicly exposed:

```bash
sudo ufw deny 9898/tcp
sudo ufw status
```

If ufw is not yet enabled at all:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw deny 9898/tcp
sudo ufw --force enable
sudo ufw status
```

Expected result:

- SSH + nginx ports allowed
- Port `9898` not publicly exposed

---

## 9) Verify It Works (3 quick checks)

```bash
export RELAY_DOMAIN=relay.example.com
export MAILBOX_ID=<UNBLINDED_ID_HEX>
export RELAY_API_TOKEN=<YOUR_RELAY_API_TOKEN>
```

### Check A: Health

```bash
curl -i https://$RELAY_DOMAIN/healthz
```

Expected: `HTTP/1.1 200` and body `ok`.

### Check B: Auth enforced

```bash
curl -i "https://$RELAY_DOMAIN/v1/registrations?mailbox_id=$MAILBOX_ID"
```

Expected: `401 unauthorized`.

### Check C: Auth succeeds

```bash
curl -i -H "x-relay-token: $RELAY_API_TOKEN" \
  "https://$RELAY_DOMAIN/v1/registrations?mailbox_id=$MAILBOX_ID"
```

Expected: `200` with JSON response.

---

## 10) Day-2 Operations (Simple)

Update app:

```bash
cd /opt/arke-relay/app
sudo -u arke-relay git pull
sudo -u arke-relay npm ci --omit=dev
sudo systemctl restart arke-apns-relay
```

Watch logs live:

```bash
journalctl -u arke-apns-relay -f
```

Backup database:

```bash
sudo cp /opt/arke-relay/data/relay.db /opt/arke-relay/data/relay.db.backup-$(date +%F-%H%M%S)
```

---

## 11) Ongoing Health Checks

Run these whenever you want to confirm everything is still working.

**Service status** (running, uptime, recent crashes):

```bash
sudo systemctl status arke-apns-relay --no-pager
```

**Watch live logs:**

```bash
journalctl -u arke-apns-relay -f
```

**Scan last 24 hours for errors:**

```bash
journalctl -u arke-apns-relay --since "24 hours ago" | grep -i "error\|warn\|fail"
```

**Health endpoint** (tests the full nginx → relay path; run this from your laptop too):

```bash
curl -si https://relay.example.com/healthz
```

Expected: `200` and body `ok`.

**Registration count** (confirms the database and API are alive):

```bash
curl -si -H "x-relay-token: <YOUR_RELAY_API_TOKEN>" \
  "https://relay.example.com/v1/registrations?mailbox_id=<MAILBOX_ID>"
```

Expected: `200` with a JSON response.

**Database file size** (slow growth is healthy; no growth at all may mean checkpointing is stuck):

```bash
ls -lh /opt/arke-relay/data/relay.db
```

**Passive uptime monitoring (recommended):**

Set up a free external monitor at [UptimeRobot](https://uptimerobot.com) or [Betterstack Uptime](https://betterstack.com/uptime). Both have free tiers. Point the monitor at:

```
https://relay.example.com/healthz
```

Configure it to ping every 5 minutes and alert you by email if it goes down. This way you get notified without having to check manually.

---

## Quick Troubleshooting

### Service won’t start

- Run: `journalctl -u arke-apns-relay -n 100 --no-pager`
- Common causes:
  - Wrong `PROTO_PATH`
  - Wrong APNs key path
  - Missing env var

### `/v1/*` always returns 401

- Confirm header is sent:
  - `x-relay-token: <token>`
- Confirm token matches exactly in `.env`
- Restart service after editing `.env`:
  - `sudo systemctl restart arke-apns-relay`

### Real client IP not showing in rate limit

- Ensure `TRUST_PROXY=1`
- Ensure nginx sets `X-Forwarded-For`

### Relay stops forwarding notifications (logs show `"mailbox authorization expired"`)

- `authorization_hex` is short-lived. When it expires, gRPC calls for that mailbox are rejected and APNs notifications for that mailbox stop.
- Fix: the wallet/client should send a fresh `authorization_hex` by calling `POST /v1/register` again.
- Tip: scan logs daily for `"mailbox authorization expired"` (the log scan command in section 11) so you catch this before users notice.

---

## Optional Next Step

After this is stable, the next meaningful hardening step is adding APNs retry/DLQ so temporary APNs failures do not lose notifications.
