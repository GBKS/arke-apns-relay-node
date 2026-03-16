#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

prompt_required() {
  local var_name="$1"
  local prompt_text="$2"
  local value=""
  while [[ -z "$value" ]]; do
    read -r -p "$prompt_text" value
  done
  printf -v "$var_name" '%s' "$value"
}

prompt_default() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="$3"
  local value=""
  read -r -p "$prompt_text [$default_value]: " value
  if [[ -z "$value" ]]; then
    value="$default_value"
  fi
  printf -v "$var_name" '%s' "$value"
}

prompt_yes_no() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="$3"
  local answer=""

  while true; do
    read -r -p "$prompt_text [$default_value]: " answer
    answer="${answer:-$default_value}"
    case "${answer,,}" in
      y|yes)
        printf -v "$var_name" '1'
        return
        ;;
      n|no)
        printf -v "$var_name" '0'
        return
        ;;
    esac
    echo "Please answer yes or no."
  done
}

check_file_exists() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "File not found: $path" >&2
    exit 1
  fi
}

main() {
  require_cmd ssh
  require_cmd scp
  require_cmd openssl

  echo "Arke Relay Server Bootstrap"
  echo "This script runs from your local machine and configures the remote server over SSH."
  echo

  prompt_required SSH_USER "SSH user: "
  prompt_required SSH_HOST "Server host or IP: "
  prompt_default DOMAIN "Relay domain" "relay.arke.cash"
  prompt_default REPO_URL "Git repository URL" "https://github.com/GBKS/arke-apns-relay-node"
  prompt_default REMOTE_BASE "Remote base directory" "/opt/arke-relay"

  prompt_required APNS_KEY_FILE_LOCAL "Local path to AuthKey_XXXXXX.p8: "
  check_file_exists "$APNS_KEY_FILE_LOCAL"

  # Use repo protos by default when running from project root.
  local default_proto_path default_core_proto_path
  default_proto_path="./protos/mailbox_server.proto"
  default_core_proto_path="./protos/core.proto"

  if [[ -f "$default_proto_path" ]]; then
    PROTO_FILE_LOCAL="$default_proto_path"
    echo "Using default mailbox_server.proto: $PROTO_FILE_LOCAL"
  else
    prompt_required PROTO_FILE_LOCAL "Local path to mailbox_server.proto: "
  fi
  check_file_exists "$PROTO_FILE_LOCAL"

  if [[ -f "$default_core_proto_path" ]]; then
    CORE_PROTO_FILE_LOCAL="$default_core_proto_path"
    echo "Using default core.proto: $CORE_PROTO_FILE_LOCAL"
  else
    prompt_required CORE_PROTO_FILE_LOCAL "Local path to core.proto (required by mailbox_server.proto): "
  fi
  check_file_exists "$CORE_PROTO_FILE_LOCAL"

  prompt_required APNS_KEY_ID "APNS_KEY_ID: "
  prompt_required APNS_TEAM_ID "APNS_TEAM_ID: "
  prompt_required APNS_TOPIC "APNS_TOPIC (bundle id): "

  prompt_default APNS_PRODUCTION "Use APNS production? (1 for production, 0 for sandbox)" "0"
  if [[ "$APNS_PRODUCTION" != "0" && "$APNS_PRODUCTION" != "1" ]]; then
    echo "APNS_PRODUCTION must be 0 or 1" >&2
    exit 1
  fi

  prompt_yes_no INSTALL_CERT "Run certbot nginx setup now?" "yes"
  CERTBOT_EMAIL=""
  if [[ "$INSTALL_CERT" == "1" ]]; then
    prompt_required CERTBOT_EMAIL "Email for certbot registration: "
  fi

  prompt_yes_no CONFIGURE_UFW "Configure UFW rules (recommended)?" "yes"

  RELAY_API_TOKEN="$(openssl rand -hex 32)"
  echo
  echo "Generated RELAY_API_TOKEN: $RELAY_API_TOKEN"
  echo "Save this value. You will need it for /v1 API calls."
  echo

  local ssh_target
  ssh_target="$SSH_USER@$SSH_HOST"

  local remote_proto_tmp remote_core_proto_tmp remote_key_tmp
  remote_proto_tmp="/tmp/mailbox_server.proto.$RANDOM.$RANDOM"
  remote_core_proto_tmp="/tmp/core.proto.$RANDOM.$RANDOM"
  remote_key_tmp="/tmp/apns.p8.$RANDOM.$RANDOM"

  local uploaded_files



  cleanup_remote_tmp() {
    if [[ "$uploaded_files" == "1" ]]; then
      ssh "$ssh_target" "rm -f '$remote_proto_tmp' '$remote_core_proto_tmp' '$remote_key_tmp'" >/dev/null 2>&1 || true
    fi
  }

  trap cleanup_remote_tmp EXIT


  echo "Uploading proto files and APNs key..."
  scp "$PROTO_FILE_LOCAL" "$ssh_target:$remote_proto_tmp"
  scp "$CORE_PROTO_FILE_LOCAL" "$ssh_target:$remote_core_proto_tmp"
  scp "$APNS_KEY_FILE_LOCAL" "$ssh_target:$remote_key_tmp"
  uploaded_files="1"

  echo "Running remote setup..."
  ssh "$ssh_target" bash -s -- \
    "$DOMAIN" "$REPO_URL" "$REMOTE_BASE" "$APNS_KEY_ID" "$APNS_TEAM_ID" "$APNS_TOPIC" "$APNS_PRODUCTION" "$RELAY_API_TOKEN" "$INSTALL_CERT" "$CERTBOT_EMAIL" "$CONFIGURE_UFW" "$remote_proto_tmp" "$remote_core_proto_tmp" "$remote_key_tmp" <<'REMOTE_SCRIPT'
set -euo pipefail

DOMAIN="$1"
REPO_URL="$2"
REMOTE_BASE="$3"
APNS_KEY_ID="$4"
APNS_TEAM_ID="$5"
APNS_TOPIC="$6"
APNS_PRODUCTION="$7"
RELAY_API_TOKEN="$8"
INSTALL_CERT="$9"
CERTBOT_EMAIL="${10}"
CONFIGURE_UFW="${11}"
REMOTE_PROTO_TMP="${12}"
REMOTE_CORE_PROTO_TMP="${13}"
REMOTE_KEY_TMP="${14}"

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required on the remote server" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

sudo apt update
sudo apt install -y curl git nginx sqlite3 ufw

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$NODE_MAJOR" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
  fi
fi

if [[ "$INSTALL_CERT" == "1" ]]; then
  sudo apt install -y certbot python3-certbot-nginx
fi

if ! id -u arke-relay >/dev/null 2>&1; then
  sudo adduser --system --group --home "$REMOTE_BASE" arke-relay
fi

sudo mkdir -p "$REMOTE_BASE/app" "$REMOTE_BASE/data" "$REMOTE_BASE/keys"
sudo chown -R arke-relay:arke-relay "$REMOTE_BASE"
sudo chmod 750 "$REMOTE_BASE/keys"

if [[ -d "$REMOTE_BASE/app/.git" ]]; then
  sudo -u arke-relay git -C "$REMOTE_BASE/app" pull --ff-only
else
  if [[ -n "$(ls -A "$REMOTE_BASE/app" 2>/dev/null)" ]]; then
    sudo find "$REMOTE_BASE/app" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  fi
  sudo -u arke-relay git clone "$REPO_URL" "$REMOTE_BASE/app"
fi

sudo -u arke-relay npm --prefix "$REMOTE_BASE/app" ci --omit=dev


sudo -u arke-relay mkdir -p "$REMOTE_BASE/app/protos"
sudo install -o arke-relay -g arke-relay -m 644 "$REMOTE_PROTO_TMP" "$REMOTE_BASE/app/protos/mailbox_server.proto"
sudo install -o arke-relay -g arke-relay -m 644 "$REMOTE_CORE_PROTO_TMP" "$REMOTE_BASE/app/protos/core.proto"
sudo install -o arke-relay -g arke-relay -m 600 "$REMOTE_KEY_TMP" "$REMOTE_BASE/keys/apns.p8"
rm -f "$REMOTE_PROTO_TMP" "$REMOTE_CORE_PROTO_TMP" "$REMOTE_KEY_TMP"

sudo tee "$REMOTE_BASE/app/.env" > /dev/null <<EOF
PROTO_PATH=$REMOTE_BASE/app/protos/mailbox_server.proto
CHECKPOINT_DB=$REMOTE_BASE/data/relay.db
SUBSCRIBE_RETRY_MS=3000
METRICS_PORT=9898
DRY_RUN=0

APNS_KEY_FILE=$REMOTE_BASE/keys/apns.p8
APNS_KEY_ID=$APNS_KEY_ID
APNS_TEAM_ID=$APNS_TEAM_ID
APNS_TOPIC=$APNS_TOPIC
APNS_PRODUCTION=$APNS_PRODUCTION
APNS_PUSH_TYPE=alert

RELAY_API_TOKEN=$RELAY_API_TOKEN
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
TRUST_PROXY=1
EOF

sudo chown arke-relay:arke-relay "$REMOTE_BASE/app/.env"
sudo chmod 600 "$REMOTE_BASE/app/.env"

sudo tee /etc/systemd/system/arke-apns-relay.service > /dev/null <<EOF
[Unit]
Description=Arke APNs Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=arke-relay
Group=arke-relay
WorkingDirectory=$REMOTE_BASE/app
EnvironmentFile=$REMOTE_BASE/app/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=$REMOTE_BASE/data

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now arke-apns-relay

sudo tee /etc/nginx/sites-available/$DOMAIN > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location /v1/ {
        proxy_pass http://127.0.0.1:9898;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location = /healthz {
        proxy_pass http://127.0.0.1:9898/healthz;
    }

    location = /metrics {
        deny all;
    }
}
EOF

if [[ ! -L /etc/nginx/sites-enabled/$DOMAIN ]]; then
  sudo ln -s /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
fi

sudo nginx -t
sudo systemctl reload nginx

if [[ "$INSTALL_CERT" == "1" ]]; then
  sudo certbot --nginx --non-interactive --agree-tos --email "$CERTBOT_EMAIL" -d "$DOMAIN" --redirect
fi

if [[ "$CONFIGURE_UFW" == "1" ]]; then
  sudo ufw allow OpenSSH
  sudo ufw allow 'Nginx Full'
  sudo ufw deny 9898/tcp
  if sudo ufw status | grep -qi "Status: inactive"; then
    sudo ufw --force enable
  fi
fi

echo
echo "Remote setup completed."
sudo systemctl status arke-apns-relay --no-pager | sed -n '1,12p'
REMOTE_SCRIPT

  uploaded_files="0"

  echo
  echo "Done. Quick checks:"
  echo "curl -si https://$DOMAIN/healthz"
  echo "curl -si -H 'x-relay-token: $RELAY_API_TOKEN' 'https://$DOMAIN/v1/registrations?mailbox_id=<MAILBOX_ID>'"
}

main "$@"
