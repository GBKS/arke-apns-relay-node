#!/usr/bin/env bash
set -euo pipefail

# Enables the read-only insights API (/insights/v1/*) on a relay server that
# was set up before that API existed. Run it from your local machine, after
# the server has been updated to a version that includes the API
# (./scripts/update-repo.sh). Safe to run more than once.
#
# It does three things on the server:
#   1. adds ADMIN_API_TOKEN to the relay's .env (keeps an existing one)
#   2. forwards /insights/v1/ to the relay in whichever web server already
#      forwards /v1/ (Caddy or nginx), backing the config up first and
#      restoring it if the web server rejects the result
#   3. restarts the relay and prints the token

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

# ── 2. reverse proxy (Caddy or nginx) ────────────────────────────────────────

# Whichever web server already forwards /v1/ to the relay gets a matching
# entry for the insights path. Failures here never abort the script: the relay
# still gets restarted and the token still gets printed, then the problem is
# reported at the end.
CADDYFILE="/etc/caddy/Caddyfile"
PROXY_STATUS="not_found" # ok | not_found | failed
PROXY_NOTE=""
DOMAIN=""

enable_in_caddy() {
	# The site address is the last top-level line opening a block before /v1/.
	DOMAIN="$(sudo awk '
		/^[^ \t#}].*\{[ \t]*$/ { site = $1 }
		/^[ \t]*handle \/v1\/\* \{/ { print site; exit }
	' "$CADDYFILE")"

	if sudo grep -qF "handle ${API_PATH}* {" "$CADDYFILE"; then
		echo "Caddy already forwards $API_PATH; leaving $CADDYFILE alone."
		PROXY_STATUS="ok"
		return 0
	fi

	local backup upstream
	backup="$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
	sudo cp -p "$CADDYFILE" "$backup"

	# Reuse whatever upstream the existing /v1/ block points at.
	upstream="$(sudo awk '
		/^[ \t]*handle \/v1\/\* \{/ { inside = 1; next }
		inside && /reverse_proxy/ { print $2; exit }
		inside && /\}/ { exit }
	' "$backup")"
	upstream="${upstream:-localhost:9898}"

	sudo awk -v api_path="$API_PATH" -v upstream="$upstream" '
		/^[ \t]*handle \/v1\/\* \{/ {
			indent = $0
			sub(/handle.*/, "", indent)
			print indent "handle " api_path "* {"
			print indent "    reverse_proxy " upstream
			print indent "}"
			print ""
		}
		{ print }
	' "$backup" | sudo tee "$CADDYFILE" > /dev/null

	if ! sudo caddy adapt --config "$CADDYFILE" --adapter caddyfile > /dev/null; then
		sudo cp -p "$backup" "$CADDYFILE"
		PROXY_STATUS="failed"
		PROXY_NOTE="Caddy rejected the new config, so the previous Caddyfile was restored."
		return 0
	fi
	if ! sudo systemctl reload caddy; then
		sudo cp -p "$backup" "$CADDYFILE"
		sudo systemctl reload caddy || true
		PROXY_STATUS="failed"
		PROXY_NOTE="Caddy failed to reload, so the previous Caddyfile was restored."
		return 0
	fi
	echo "Added 'handle ${API_PATH}*' to $CADDYFILE (previous file saved as $backup)."
	PROXY_STATUS="ok"
}

enable_in_nginx() {
	local site_file="$1" backup
	DOMAIN="$(sudo sed -n 's/^[[:space:]]*server_name[[:space:]]\{1,\}\([^ ;]*\).*/\1/p' "$site_file" | head -n 1)"

	if sudo grep -qF "location $API_PATH" "$site_file"; then
		echo "nginx already forwards $API_PATH; leaving $site_file alone."
		PROXY_STATUS="ok"
		return 0
	fi

	backup="$site_file.bak.$(date +%Y%m%d%H%M%S)"
	sudo cp -p "$site_file" "$backup"

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
	' "$backup" | sudo tee "$site_file" > /dev/null

	if ! sudo nginx -t; then
		sudo cp -p "$backup" "$site_file"
		PROXY_STATUS="failed"
		PROXY_NOTE="nginx rejected the new config, so the previous one was restored."
		return 0
	fi
	if ! sudo systemctl reload nginx; then
		sudo cp -p "$backup" "$site_file"
		sudo systemctl reload nginx || true
		PROXY_STATUS="failed"
		PROXY_NOTE="nginx failed to reload, so the previous config was restored."
		return 0
	fi
	echo "Added 'location $API_PATH' to $site_file (previous file saved as $backup)."
	PROXY_STATUS="ok"
}

# (Backups made by this script live next to the originals, hence the exclude.)
NGINX_SITE_FILES="$(sudo grep -lE --exclude='*.bak.*' '^[[:space:]]*location /v1/ \{' /etc/nginx/sites-available/* 2>/dev/null || true)"
NGINX_SITE_COUNT="$(printf '%s' "$NGINX_SITE_FILES" | grep -c . || true)"

if sudo test -f "$CADDYFILE" && sudo grep -qE '^[[:space:]]*handle /v1/\* \{' "$CADDYFILE"; then
	enable_in_caddy
elif [[ "$NGINX_SITE_COUNT" == "1" ]]; then
	enable_in_nginx "$NGINX_SITE_FILES"
else
	PROXY_NOTE="Couldn't find a Caddyfile or a single nginx site config that forwards /v1/ to the relay."
fi

# ── 3. restart the relay and report ──────────────────────────────────────────

sudo systemctl restart arke-apns-relay
sleep 2
sudo systemctl --no-pager --full status arke-apns-relay | sed -n '1,8p'

echo
echo "Your admin token (keep it secret; it is NOT the app's relay token):"
echo
echo "  $TOKEN"
echo

if [[ "$PROXY_STATUS" != "ok" ]]; then
	echo "The relay is ready, but the web server was NOT updated:" >&2
	echo "  $PROXY_NOTE" >&2
	echo "Forward $API_PATH to the relay by hand (see 'Enabling it on an existing server' in the README)." >&2
	exit 1
fi

echo "Quick check:"
echo "  curl -s -H 'Authorization: Bearer $TOKEN' 'https://${DOMAIN:-<your-domain>}/insights/v1/summary'"
REMOTE_SCRIPT
}

main "$@"
