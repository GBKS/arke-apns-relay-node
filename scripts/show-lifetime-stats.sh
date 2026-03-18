#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DB_PATH="${1:-${CHECKPOINT_DB:-$REPO_ROOT/relay.db}}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Error: sqlite3 is not installed or not in PATH." >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "Error: database file not found: $DB_PATH" >&2
  echo "Pass a path as the first argument or set CHECKPOINT_DB." >&2
  exit 1
fi

sqlite3 -readonly "$DB_PATH" <<'SQL'
.headers on
.mode column
SELECT stat_key, stat_value, updated_at
FROM relay_stat
WHERE stat_key IN (
  'lifetime_vtxos_processed',
  'lifetime_sats_processed',
  'lifetime_mailbox_messages_received',
  'lifetime_registrations',
  'lifetime_unregistrations',
  'lifetime_stale_device_removals'
)
ORDER BY stat_key;
SQL
