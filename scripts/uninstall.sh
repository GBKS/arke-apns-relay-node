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

main() {
	require_cmd ssh

	echo "Arke Relay Remote Uninstall"
	echo

	prompt_required SSH_USER "SSH user: "
	prompt_required SSH_HOST "Server host or IP: "
	prompt_default DOMAIN "Relay domain" "relay.arke.cash"
	prompt_default REMOTE_BASE "Remote base directory" "/opt/arke-relay"

	echo
	echo "About to remove the remote relay deployment on $SSH_HOST"
	echo "This will stop the service, remove nginx and systemd configuration, delete $REMOTE_BASE, and remove the arke-relay user if present."

	prompt_yes_no CONFIRM_UNINSTALL "Proceed with uninstall?" "no"
	if [[ "$CONFIRM_UNINSTALL" != "1" ]]; then
		echo "Uninstall cancelled."
		exit 0
	fi

	local ssh_target
	ssh_target="$SSH_USER@$SSH_HOST"

	ssh "$ssh_target" bash -s -- "$REMOTE_BASE" "$DOMAIN" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_BASE="$1"
DOMAIN="$2"

if ! command -v sudo >/dev/null 2>&1; then
	echo "sudo is required on the remote server" >&2
	exit 1
fi

sudo systemctl disable --now arke-apns-relay 2>/dev/null || true
sudo rm -f /etc/systemd/system/arke-apns-relay.service
sudo systemctl daemon-reload

sudo rm -f "/etc/nginx/sites-enabled/$DOMAIN"
sudo rm -f "/etc/nginx/sites-available/$DOMAIN"

if command -v nginx >/dev/null 2>&1; then
	if sudo nginx -t; then
		sudo systemctl reload nginx || true
	else
		echo "Warning: nginx configuration test failed after removing $DOMAIN; nginx was not reloaded." >&2
	fi
fi

sudo rm -rf "$REMOTE_BASE"

if id -u arke-relay >/dev/null 2>&1; then
	sudo deluser --remove-home arke-relay 2>/dev/null || sudo userdel arke-relay
fi

echo "Remote uninstall complete."
REMOTE_SCRIPT
}

main "$@"
