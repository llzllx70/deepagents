from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class CreateSessionRequest(BaseModel):
    assistant_id: str | None = None
    auto_approve: bool = False


class CreateSessionResponse(BaseModel):
    session_id: str
    sandbox_id: str | None = None
    workspace_dir: str | None = None


class DeleteSessionResponse(BaseModel):
    session_id: str
    sandbox_id: str | None = None
    synced: bool
    workspace_dir: str | None = None


class ClientLogRequest(BaseModel):
    event: str
    detail: dict[str, Any] | None = None
    level: str | None = None
    session_id: str | None = None
    ts: float | None = None


class HistoryPayload(BaseModel):
    history: list[dict[str, Any]]


class SessionStatePayload(BaseModel):
    session_id: str | None = None
    has_messages: bool = False
    timestamp: float | None = None
