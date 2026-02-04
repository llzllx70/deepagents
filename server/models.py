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


class AttachmentUploadItem(BaseModel):
    file_id: str
    filename: str
    content_type: str | None = None
    size: int
    container_path: str
    status: str
    error: str | None = None


class AttachmentUploadResponse(BaseModel):
    session_id: str
    files: list[AttachmentUploadItem]
