#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Stop existing processes (ignore if not running)
pkill -f "deepagents_server.py" >/dev/null 2>&1 || true
pkill -f "python -m http.server 8080" >/dev/null 2>&1 || true
