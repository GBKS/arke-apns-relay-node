#!/usr/bin/env bash
set -euo pipefail

# Enables the read-only insights API (/insights/v1/*) on a relay server that
# was set up before that API existed. Run it from your local machine, after
# the server has been updated to a version that includes the API
# (./scripts/update-repo.sh). Safe to run more than once.
#
# It does three things on the server:
#   1. adds ADMIN_API_TOKEN to the relay's .env (keeps an existing one)
#   2. adds a `location /insights/v1/` block to the nginx site config
#      (backs the file up first, and restores it if nginx rejects the result)
#   3. reloads nginx and restarts the relay

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

main() {
	require_cmd ssh
	require_cmd openssl

	echo "Arke Relay: enable insights API"
	echo

	prompt_required SSH_USER "SSH user: "
	prompt_required SSH_HOST "Server host or IP: "
	prompt_default REMOTE_BASE "Remote base directory" "/opt/arke-relay"

	local ssh_target new_token
	ssh_target="$SSH_USER@$SSH_HOST"
	# Only used if the server doesn't already have a token.
	new_token="$(openssl rand -hex 32)"

	ssh "$ssh_target" bash -s -- "$REMOTE_BASE" "$new_token" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_BASE="$1"
NEW_TOKEN="$2"
ENV_FILE="$REMOTE_BASE/app/.env"
API_PATH="/insights/v1/"

if ! command -v sudo >/dev/null 2>&1; then
	echo "sudo is required on the remote server" >&2
	exit 1
fi

if ! sudo test -f "$ENV_FILE"; then
	echo "Relay config not found at $ENV_FILE" >&2
	exit 1
fi

if ! sudo test -f "$REMOTE_BASE/app/src/admin-api.js"; then
	echo "The relay on this server doesn't include the insights API yet." >&2
	echo "Run ./scripts/update-repo.sh first, then run this script again." >&2
	exit 1
fi

# ── 1. ADMIN_API_TOKEN in .env ───────────────────────────────────────────────

EXISTING_TOKEN="$(sudo sed -n 's/^ADMIN_API_TOKEN=//p' "$ENV_FILE" | tail -n 1)"
if [[ -n "$EXISTING_TOKEN" ]]; then
	TOKEN="$EXISTING_TOKEN"
	echo "ADMIN_API_TOKEN is already set in .env; keeping it."
else
	TOKEN="$NEW_TOKEN"
	sudo cp -p "$ENV_FILE" "$ENV_FILE.bak"
	if sudo grep -q '^ADMIN_API_TOKEN=' "$ENV_FILE"; then
		# Written through tee so the file keeps its owner and 600 mode.
		sudo sed "s/^ADMIN_API_TOKEN=.*/ADMIN_API_TOKEN=$TOKEN/" "$ENV_FILE.bak" | sudo tee "$ENV_FILE" > /dev/null
	else
		printf '\nADMIN_API_TOKEN=%s\n' "$TOKEN" | sudo tee -a "$ENV_FILE" > /dev/null
	fi
	echo "Added ADMIN_API_TOKEN to .env (previous file saved as .env.bak)."
fi

# ── 2. nginx location block ──────────────────────────────────────────────────

# The relay's site config is the one that already forwards /v1/.
# (Backups made by this script live in the same directory, hence the exclude.)
SITE_FILES="$(sudo grep -lE --exclude='*.bak.*' '^[[:space:]]*location /v1/ \{' /etc/nginx/sites-available/* 2>/dev/null || true)"
SITE_COUNT="$(printf '%s' "$SITE_FILES" | grep -c . || true)"
if [[ "$SITE_COUNT" != "1" ]]; then
	echo "Expected exactly one nginx site config with a 'location /v1/' block, found $SITE_COUNT:" >&2
	printf '%s\n' "$SITE_FILES" >&2
	echo "Nothing was changed in nginx. Add the block by hand (see README)." >&2
	exit 1
fi
SITE_FILE="$SITE_FILES"

if sudo grep -qF "location $API_PATH" "$SITE_FILE"; then
	echo "nginx already forwards $API_PATH; leaving $SITE_FILE alone."
else
	BACKUP_FILE="$SITE_FILE.bak.$(date +%Y%m%d%H%M%S)"
	sudo cp -p "$SITE_FILE" "$BACKUP_FILE"

	# Insert the new block directly above each `location /v1/`, copying its
	# indentation, so it lands in the same server block (the HTTPS one, once
	# certbot has rewritten the file).
	sudo awk -v api_path="$API_PATH" '
		/^[ \t]*location \/v1\/ \{/ {
			indent = $0
			sub(/location.*/, "", indent)
			print indent "location " api_path " {"
			print indent "    proxy_pass http://127.0.0.1:9898;"
			print indent "    proxy_http_version 1.1;"
			print indent "    proxy_set_header Host $host;"
			print indent "    proxy_set_header X-Real-IP $remote_addr;"
			print indent "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
			print indent "    proxy_set_header X-Forwarded-Proto $scheme;"
			print indent "}"
			print ""
		}
		{ print }
	' "$BACKUP_FILE" | sudo tee "$SITE_FILE" > /dev/null

	if ! sudo nginx -t; then
		echo "nginx rejected the new config; restoring the previous one." >&2
		sudo cp -p "$BACKUP_FILE" "$SITE_FILE"
		exit 1
	fi
	echo "Added 'location $API_PATH' to $SITE_FILE (previous file saved as $BACKUP_FILE)."
fi

# ── 3. apply ─────────────────────────────────────────────────────────────────

sudo nginx -t
sudo systemctl reload nginx
sudo systemctl restart arke-apns-relay
sleep 2
sudo systemctl --no-pager --full status arke-apns-relay | sed -n '1,8p'

DOMAIN="$(sudo sed -n 's/^[[:space:]]*server_name[[:space:]]\{1,\}\([^ ;]*\).*/\1/p' "$SITE_FILE" | head -n 1)"

echo
echo "Done. Your admin token (keep it secret; it is NOT the app's relay token):"
echo
echo "  $TOKEN"
echo
echo "Quick check:"
echo "  curl -s -H 'Authorization: Bearer $TOKEN' 'https://${DOMAIN:-<your-domain>}/insights/v1/summary'"
REMOTE_SCRIPT
}

main "$@"
