#!/usr/bin/env bash
set -euo pipefail

echo "Cleaning local workspace artifacts..."

rm -rf node_modules dist build tmp logs
find . -maxdepth 1 -type f \( -name '*.log' -o -name 'npm-debug.log*' \) -delete

echo "Cleanup complete."