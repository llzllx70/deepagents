from __future__ import annotations

from threading import Lock
from typing import Any

_LOCK = Lock()
_STORE: dict[tuple[str, str, str], dict[str, Any]] = {}


def record_tool_call_args(
    *,
    session_id: str,
    thread_id: str | None = None,
    tool_call_id: str,
    tool_name: str | None,
    args: dict[str, Any] | None,
    run_id: str | None = None,
) -> None:
    if not tool_call_id or args is None:
        return
    with _LOCK:
        if session_id:
            _STORE[("session", session_id, tool_call_id)] = {
                "tool_name": tool_name,
                "args": args,
                "run_id": run_id,
            }
        if thread_id:
            _STORE[("thread", thread_id, tool_call_id)] = {
                "tool_name": tool_name,
                "args": args,
                "run_id": run_id,
            }


def pop_tool_call_args(
    session_id: str | None,
    tool_call_id: str | None,
    *,
    thread_id: str | None = None,
) -> dict[str, Any] | None:
    if not tool_call_id:
        return None
    with _LOCK:
        if session_id:
            payload = _STORE.pop(("session", session_id, tool_call_id), None)
            if payload is not None:
                if thread_id:
                    _STORE.pop(("thread", thread_id, tool_call_id), None)
                return payload
        if thread_id:
            return _STORE.pop(("thread", thread_id, tool_call_id), None)
    return None
