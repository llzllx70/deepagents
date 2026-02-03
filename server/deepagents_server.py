from __future__ import annotations

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
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info", access_log=False)


if __name__ == "__main__":
    run()
