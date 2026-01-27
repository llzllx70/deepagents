from __future__ import annotations

import asyncio
import json
from typing import Any

from pathlib import Path

from .config import AUTH_SESSIONS_PATH, SESSION_OWNERS_PATH, USERS_DIR

USER_DATA_LOCK = asyncio.Lock()
AUTH_LOCK = asyncio.Lock()
SESSION_OWNER_LOCK = asyncio.Lock()


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


def _user_dir(username: str) -> Path:
    safe = username.strip()
    return USERS_DIR / safe


def _ensure_user_dir(username: str) -> Path:
    path = _user_dir(username)
    path.mkdir(parents=True, exist_ok=True)
    return path


def user_history_path(username: str) -> Path:
    return _ensure_user_dir(username) / "chat_history.json"


def user_session_state_path(username: str) -> Path:
    return _ensure_user_dir(username) / "session_state.json"


def user_config_path(username: str) -> Path:
    return _ensure_user_dir(username) / "config.json"


async def read_user_history(username: str) -> list[Any]:
    async with USER_DATA_LOCK:
        payload = await read_json_file(user_history_path(username))
    return payload if isinstance(payload, list) else []


async def write_user_history(username: str, payload: list[Any]) -> None:
    async with USER_DATA_LOCK:
        await write_json_file(user_history_path(username), payload)


async def read_user_session_state(username: str) -> dict[str, Any]:
    async with USER_DATA_LOCK:
        payload = await read_json_file(user_session_state_path(username))
    return payload if isinstance(payload, dict) else {}


async def write_user_session_state(username: str, payload: dict[str, Any]) -> None:
    async with USER_DATA_LOCK:
        await write_json_file(user_session_state_path(username), payload)


async def read_user_config(username: str) -> dict[str, Any]:
    async with USER_DATA_LOCK:
        payload = await read_json_file(user_config_path(username))
    return payload if isinstance(payload, dict) else {}


async def write_user_config(username: str, payload: dict[str, Any]) -> None:
    async with USER_DATA_LOCK:
        await write_json_file(user_config_path(username), payload)


async def read_auth_sessions() -> dict[str, Any]:
    async with AUTH_LOCK:
        payload = await read_json_file(AUTH_SESSIONS_PATH)
    return payload if isinstance(payload, dict) else {}


async def write_auth_sessions(payload: dict[str, Any]) -> None:
    async with AUTH_LOCK:
        await write_json_file(AUTH_SESSIONS_PATH, payload)


async def read_session_owners() -> dict[str, Any]:
    async with SESSION_OWNER_LOCK:
        payload = await read_json_file(SESSION_OWNERS_PATH)
    return payload if isinstance(payload, dict) else {}


async def write_session_owners(payload: dict[str, Any]) -> None:
    async with SESSION_OWNER_LOCK:
        await write_json_file(SESSION_OWNERS_PATH, payload)
