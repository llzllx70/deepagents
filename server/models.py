from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class CreateSessionRequest(BaseModel):
    assistant_id: str | None = None
    auto_approve: bool = False


class CreateSessionResponse(BaseModel):
    session_id: str
    sandbox_id: str | None = None


class DeleteSessionResponse(BaseModel):
    session_id: str
    sandbox_id: str | None = None
    synced: bool


class ClientLogRequest(BaseModel):
    event: str
    detail: dict[str, Any] | None = None
    level: str | None = None
    session_id: str | None = None
    ts: float | None = None


class HistoryPayload(BaseModel):
    history: list[dict[str, Any]]


class SessionStatePayload(BaseModel):
    client_id: str | None = None
    session_id: str | None = None
    chat_id: str | None = None
    has_messages: bool = False
    timestamp: float | None = None


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    username: str


class UserConfigPayload(BaseModel):
    auto_approve: bool | None = None
