#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Backing up remote state before deploy..."
"$SCRIPT_DIR/backup-config.sh"

echo "Deploying latest application version..."
"$SCRIPT_DIR/update-repo.sh"

echo "Deployment complete."