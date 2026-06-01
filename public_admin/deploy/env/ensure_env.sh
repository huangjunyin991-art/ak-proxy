#!/bin/bash
# Shell wrapper for ensure_env.py
# Usage: bash public_admin/deploy/env/ensure_env.sh [--dry-run]
#
# Looks for Python venv in these locations (in order):
#   1. $REPO_DIR/venv/bin/python
#   2. /usr/bin/python3
#   3. python3

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../../" && pwd)"

# Find Python interpreter
if [ -x "$REPO_DIR/venv/bin/python" ]; then
    PYTHON="$REPO_DIR/venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON="python"
else
    echo "[ensure_env] ERROR: Python not found" >&2
    exit 1
fi

# Load existing env if available (so script can use same path defaults)
ENV_FILE_DEFAULT="/etc/ak-proxy/ak-proxy.env"
if [ -f "$ENV_FILE_DEFAULT" ]; then
    set -a
    . "$ENV_FILE_DEFAULT"
    set +a
fi

exec "$PYTHON" -B "$SCRIPT_DIR/ensure_env.py" "$@"
