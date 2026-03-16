#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Cleaning local workspace artifacts..."

rm -rf "$REPO_ROOT/node_modules" "$REPO_ROOT/dist" "$REPO_ROOT/build" "$REPO_ROOT/tmp" "$REPO_ROOT/logs"
find "$REPO_ROOT" -maxdepth 1 -type f \( -name '*.log' -o -name 'npm-debug.log*' \) -delete

echo "Cleanup complete."