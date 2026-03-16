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

main() {
	require_cmd ssh
	require_cmd scp

	echo "Arke Relay Remote Backup"
	echo

	prompt_required SSH_USER "SSH user: "
	prompt_required SSH_HOST "Server host or IP: "
	prompt_default REMOTE_BASE "Remote base directory" "/opt/arke-relay"
	prompt_default LOCAL_BACKUP_DIR "Local backup directory" "./backup_$(date +%Y%m%d_%H%M%S)"

	local ssh_target
	ssh_target="$SSH_USER@$SSH_HOST"

	mkdir -p "$LOCAL_BACKUP_DIR"

	scp "$ssh_target:$REMOTE_BASE/app/.env" "$LOCAL_BACKUP_DIR/.env"
	scp "$ssh_target:$REMOTE_BASE/keys/apns.p8" "$LOCAL_BACKUP_DIR/apns.p8"
	scp "$ssh_target:$REMOTE_BASE/data/relay.db" "$LOCAL_BACKUP_DIR/relay.db"

	ssh "$ssh_target" "sudo test -f /etc/systemd/system/arke-apns-relay.service"
	scp "$ssh_target:/etc/systemd/system/arke-apns-relay.service" "$LOCAL_BACKUP_DIR/arke-apns-relay.service"

	if ssh "$ssh_target" "sudo test -f /etc/nginx/sites-available/relay.arke.cash"; then
		scp "$ssh_target:/etc/nginx/sites-available/relay.arke.cash" "$LOCAL_BACKUP_DIR/nginx-relay.conf"
	fi

	echo "Backup complete in $LOCAL_BACKUP_DIR"
}

main "$@"