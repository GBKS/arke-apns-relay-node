#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

download_remote_file() {
	local ssh_target="$1"
	local remote_path="$2"
	local local_path="$3"
	ssh "$ssh_target" bash -s -- "$remote_path" <<'REMOTE_SCRIPT' > "$local_path"
set -euo pipefail
sudo cat -- "$1"
REMOTE_SCRIPT
}

download_remote_file_if_exists() {
	local ssh_target="$1"
	local remote_path="$2"
	local local_path="$3"
	if ssh "$ssh_target" bash -s -- "$remote_path" <<'REMOTE_SCRIPT'
set -euo pipefail
sudo test -f "$1"
REMOTE_SCRIPT
	then
		download_remote_file "$ssh_target" "$remote_path" "$local_path"
	fi
}

main() {
	require_cmd ssh

	echo "Arke Relay Remote Backup"
	echo

	prompt_required SSH_USER "SSH user: "
	prompt_required SSH_HOST "Server host or IP: "
	prompt_default DOMAIN "Relay domain" "relay.arke.cash"
	prompt_default REMOTE_BASE "Remote base directory" "/opt/arke-relay"
	prompt_default LOCAL_BACKUP_DIR "Local backup directory" "$REPO_ROOT/backup_$(date +%Y%m%d_%H%M%S)"

	local ssh_target
	ssh_target="$SSH_USER@$SSH_HOST"

	umask 077
	mkdir -p "$LOCAL_BACKUP_DIR"

	download_remote_file "$ssh_target" "$REMOTE_BASE/app/.env" "$LOCAL_BACKUP_DIR/.env"
	download_remote_file "$ssh_target" "$REMOTE_BASE/keys/apns.p8" "$LOCAL_BACKUP_DIR/apns.p8"
	download_remote_file "$ssh_target" "$REMOTE_BASE/data/relay.db" "$LOCAL_BACKUP_DIR/relay.db"
	download_remote_file "$ssh_target" "/etc/systemd/system/arke-apns-relay.service" "$LOCAL_BACKUP_DIR/arke-apns-relay.service"
	download_remote_file_if_exists "$ssh_target" "/etc/nginx/sites-available/$DOMAIN" "$LOCAL_BACKUP_DIR/nginx-${DOMAIN}.conf"

	echo "Backup complete in $LOCAL_BACKUP_DIR"
}

main "$@"