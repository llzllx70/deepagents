from __future__ import annotations

import asyncio
import json
from typing import Any

from pathlib import Path

HISTORY_LOCK = asyncio.Lock()
SESSION_STATE_LOCK = asyncio.Lock()


async def read_json_file(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        raw = await asyncio.to_thread(path.read_text, encoding="utf-8")
    except OSError:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def write_json_file(path: Path, payload: Any) -> None:
    serialized = json.dumps(payload, ensure_ascii=False, indent=2)
    await asyncio.to_thread(path.write_text, serialized, encoding="utf-8")
