from __future__ import annotations

import os
import sys
from pathlib import Path

import uvicorn

try:
    from .app import app
except ImportError:
    ROOT = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(ROOT))
    from server.app import app


def run() -> None:
    host = os.environ.get("SERVER_HOST", "0.0.0.0")
    port_raw = os.environ.get("SERVER_PORT", "8000")
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        port = 8000
    uvicorn.run(app, host=host, port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    run()
