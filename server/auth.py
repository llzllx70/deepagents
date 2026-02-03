from __future__ import annotations

import time
import uuid

from .storage import read_auth_sessions, write_auth_sessions

USERS: dict[str, str] = {
    "xh1": "xh1",
    "xh2": "xh2",
    "xh3": "xh3",
    "xh4": "xh4",
    "xh5": "xh5",
    "xh6": "xh6",
    "xh7": "xh7",
    "xh8": "xh8",
    "xh9": "xh9",
    "xh10": "xh10",
}


def verify_credentials(username: str, password: str) -> bool:
    if not username:
        return False
    return USERS.get(username) == password


async def create_auth_token(username: str) -> str:
    token = uuid.uuid4().hex
    sessions = await read_auth_sessions()
    sessions[token] = {"username": username, "created_at": time.time()}
    await write_auth_sessions(sessions)
    return token


async def get_user_for_token(token: str | None) -> str | None:
    if not token:
        return None
    sessions = await read_auth_sessions()
    entry = sessions.get(token)
    if isinstance(entry, dict):
        username = entry.get("username")
        if isinstance(username, str) and username:
            return username
    return None


async def delete_auth_token(token: str | None) -> None:
    if not token:
        return
    sessions = await read_auth_sessions()
    if token in sessions:
        sessions.pop(token, None)
        await write_auth_sessions(sessions)
