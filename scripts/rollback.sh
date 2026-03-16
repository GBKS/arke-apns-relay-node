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
  require_cmd scp

  echo "Arke Relay Remote Rollback"
  echo

  prompt_required SSH_USER "SSH user: "
  prompt_required SSH_HOST "Server host or IP: "
  prompt_default REMOTE_BASE "Remote base directory" "/opt/arke-relay"
  prompt_default LOCAL_BACKUP_DIR "Backup directory to restore from" "$(ls -td ./backup_* 2>/dev/null | head -1)"

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

  scp "$LOCAL_BACKUP_DIR/.env" "$ssh_target:$REMOTE_BASE/app/.env"
  scp "$LOCAL_BACKUP_DIR/apns.p8" "$ssh_target:$REMOTE_BASE/keys/apns.p8"
  scp "$LOCAL_BACKUP_DIR/relay.db" "$ssh_target:$REMOTE_BASE/data/relay.db"

  if [[ -f "$LOCAL_BACKUP_DIR/arke-apns-relay.service" ]]; then
    scp "$LOCAL_BACKUP_DIR/arke-apns-relay.service" "$ssh_target:/tmp/arke-apns-relay.service"
    ssh "$ssh_target" "sudo mv /tmp/arke-apns-relay.service /etc/systemd/system/arke-apns-relay.service"
  fi

  if [[ -f "$LOCAL_BACKUP_DIR/nginx-relay.conf" ]]; then
    scp "$LOCAL_BACKUP_DIR/nginx-relay.conf" "$ssh_target:/tmp/nginx-relay.conf"
    ssh "$ssh_target" "sudo mv /tmp/nginx-relay.conf /etc/nginx/sites-available/relay.arke.cash"
  fi

  ssh "$ssh_target" "sudo chown arke-relay:arke-relay '$REMOTE_BASE/app/.env' '$REMOTE_BASE/keys/apns.p8' '$REMOTE_BASE/data/relay.db' && sudo chmod 600 '$REMOTE_BASE/app/.env' '$REMOTE_BASE/keys/apns.p8' && sudo systemctl daemon-reload && sudo systemctl restart arke-apns-relay && sudo nginx -t && sudo systemctl reload nginx"

  echo "Rollback complete."
}

main "$@"
