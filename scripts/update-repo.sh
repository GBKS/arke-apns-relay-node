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

	echo "Arke Relay Remote Update"
	echo

	prompt_required SSH_USER "SSH user: "
	prompt_required SSH_HOST "Server host or IP: "
	prompt_default REMOTE_BASE "Remote base directory" "/opt/arke-relay"

	local ssh_target
	ssh_target="$SSH_USER@$SSH_HOST"

	ssh "$ssh_target" bash -s -- "$REMOTE_BASE" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_BASE="$1"

if ! command -v sudo >/dev/null 2>&1; then
	echo "sudo is required on the remote server" >&2
	exit 1
fi

if [[ ! -d "$REMOTE_BASE/app/.git" ]]; then
	echo "Remote application checkout not found at $REMOTE_BASE/app" >&2
	exit 1
fi

sudo -u arke-relay git -C "$REMOTE_BASE/app" pull --ff-only
sudo -u arke-relay npm --prefix "$REMOTE_BASE/app" ci --omit=dev
sudo systemctl restart arke-apns-relay
sudo systemctl --no-pager --full status arke-apns-relay | sed -n '1,12p'
REMOTE_SCRIPT
}

main "$@"
