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

find_latest_backup_dir() {
  local matches=("$REPO_ROOT"/backup_*)
  if [[ ! -e "${matches[0]}" ]]; then
    return 0
  fi

  ls -td "$REPO_ROOT"/backup_* 2>/dev/null | head -1
}

upload_remote_file() {
  local local_path="$1"
  local ssh_target="$2"
  local remote_path="$3"
  local mode="$4"
  local owner="$5"
  local temp_name

  temp_name="/tmp/$(basename "$remote_path").$$.$RANDOM"
  scp "$local_path" "$ssh_target:$temp_name"
  ssh "$ssh_target" bash -s -- "$temp_name" "$remote_path" "$mode" "$owner" <<'REMOTE_SCRIPT'
set -euo pipefail
sudo install -o "$4" -g "$4" -m "$3" "$1" "$2"
rm -f "$1"
REMOTE_SCRIPT
}

main() {
  require_cmd ssh
  require_cmd scp

  echo "Arke Relay Remote Rollback"
  echo

  prompt_required SSH_USER "SSH user: "
  prompt_required SSH_HOST "Server host or IP: "
  prompt_default DOMAIN "Relay domain" "relay.example.com"
  prompt_default REMOTE_BASE "Remote base directory" "/opt/arke-relay"
  prompt_default LOCAL_BACKUP_DIR "Backup directory to restore from" "$(find_latest_backup_dir)"

  if [[ -z "$LOCAL_BACKUP_DIR" || ! -d "$LOCAL_BACKUP_DIR" ]]; then
    echo "Backup directory not found: $LOCAL_BACKUP_DIR" >&2
    exit 1
  fi

  echo
  echo "About to restore remote state on $SSH_HOST from $LOCAL_BACKUP_DIR"
  echo "This will overwrite the deployed .env, APNs key, relay database, and may replace service and nginx configuration."

  prompt_yes_no CONFIRM_ROLLBACK "Proceed with rollback?" "no"
  if [[ "$CONFIRM_ROLLBACK" != "1" ]]; then
    echo "Rollback cancelled."
    exit 0
  fi

  local ssh_target
  ssh_target="$SSH_USER@$SSH_HOST"

  upload_remote_file "$LOCAL_BACKUP_DIR/.env" "$ssh_target" "$REMOTE_BASE/app/.env" 600 arke-relay
  upload_remote_file "$LOCAL_BACKUP_DIR/apns.p8" "$ssh_target" "$REMOTE_BASE/keys/apns.p8" 600 arke-relay
  upload_remote_file "$LOCAL_BACKUP_DIR/relay.db" "$ssh_target" "$REMOTE_BASE/data/relay.db" 644 arke-relay

  if [[ -f "$LOCAL_BACKUP_DIR/arke-apns-relay.service" ]]; then
    upload_remote_file "$LOCAL_BACKUP_DIR/arke-apns-relay.service" "$ssh_target" "/etc/systemd/system/arke-apns-relay.service" 644 root
  fi

  if [[ -f "$LOCAL_BACKUP_DIR/nginx-${DOMAIN}.conf" ]]; then
    upload_remote_file "$LOCAL_BACKUP_DIR/nginx-${DOMAIN}.conf" "$ssh_target" "/etc/nginx/sites-available/$DOMAIN" 644 root
  fi

  ssh "$ssh_target" "sudo systemctl daemon-reload && sudo systemctl restart arke-apns-relay && { ! command -v nginx >/dev/null 2>&1 || sudo nginx -t; } && { ! command -v nginx >/dev/null 2>&1 || sudo systemctl reload nginx; }"

  echo "Rollback complete."
}

main "$@"
