from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket


@dataclass
class BrowserSnapshot:
    payload: dict[str, Any]
    received_at: float


@dataclass
class BrowserConnection:
    websocket: WebSocket
    meta: dict[str, Any] = field(default_factory=dict)
    connected_at: float = field(default_factory=time.time)


class BrowserBridge:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._connection: BrowserConnection | None = None
        self._snapshot: BrowserSnapshot | None = None
        self._snapshot_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._action_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    def is_connected(self) -> bool:
        return self._connection is not None

    def last_snapshot(self) -> dict[str, Any] | None:
        return self._snapshot.payload if self._snapshot else None

    async def attach(self, websocket: WebSocket, meta: dict[str, Any] | None = None) -> None:
        async with self._lock:
            if self._connection and self._connection.websocket is not websocket:
                try:
                    await self._connection.websocket.close(code=1012)
                except Exception:
                    pass
            self._connection = BrowserConnection(websocket=websocket, meta=meta or {})

    async def detach(self, websocket: WebSocket) -> None:
        async with self._lock:
            if self._connection and self._connection.websocket is websocket:
                self._connection = None

    async def handle_message(self, data: dict[str, Any]) -> dict[str, Any] | None:
        msg_type = data.get("type")
        if msg_type == "browser.hello":
            meta = self._connection.meta if self._connection else {}
            meta.update({k: v for k, v in data.items() if k != "type"})
            if self._connection:
                self._connection.meta = meta
            return {
                "type": "browser.status",
                "status": "connected",
                "session_id": self.session_id,
                "meta": meta,
            }

        if msg_type == "browser.snapshot":
            snapshot = data.get("snapshot")
            if not isinstance(snapshot, dict):
                snapshot = {k: v for k, v in data.items() if k != "type"}
            self._snapshot = BrowserSnapshot(payload=snapshot, received_at=time.time())
            request_id = data.get("request_id")
            if request_id and request_id in self._snapshot_waiters:
                waiter = self._snapshot_waiters.pop(request_id)
                if not waiter.done():
                    waiter.set_result(snapshot)
            return {
                "type": "browser.snapshot",
                "session_id": self.session_id,
                "summary": self._summarize_snapshot(snapshot),
            }

        if msg_type == "browser.action.result":
            action_id = data.get("action_id")
            if action_id and action_id in self._action_waiters:
                waiter = self._action_waiters.pop(action_id)
                if not waiter.done():
                    waiter.set_result(data)
            snapshot = data.get("snapshot")
            if isinstance(snapshot, dict):
                self._snapshot = BrowserSnapshot(payload=snapshot, received_at=time.time())
            return None

        return None

    async def request_snapshot(
        self,
        *,
        mode: str = "compact",
        timeout: float = 8.0,
        reason: str | None = None,
    ) -> dict[str, Any]:
        if self._connection is None:
            return {"success": False, "error": "Browser not connected"}
        request_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._snapshot_waiters[request_id] = future
        await self._send(
            {
                "type": "browser.request_snapshot",
                "request_id": request_id,
                "mode": mode,
                "reason": reason,
            }
        )
        try:
            snapshot = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._snapshot_waiters.pop(request_id, None)
            return {"success": False, "error": "Snapshot timeout"}
        return {"success": True, "snapshot": snapshot}

    async def send_action(
        self,
        action_payload: dict[str, Any],
        *,
        timeout: float = 12.0,
    ) -> dict[str, Any]:
        if self._connection is None:
            return {"success": False, "error": "Browser not connected"}
        action_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._action_waiters[action_id] = future
        await self._send(
            {
                "type": "browser.action",
                "action_id": action_id,
                **action_payload,
            }
        )
        try:
            result = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._action_waiters.pop(action_id, None)
            return {"success": False, "error": "Action timeout", "action_id": action_id}
        return result

    def format_snapshot_for_prompt(self, max_chars: int = 8000, max_elements: int = 60) -> str | None:
        if not self._snapshot:
            return None
        snapshot = self._snapshot.payload
        page = snapshot.get("page") if isinstance(snapshot, dict) else None
        text = snapshot.get("text") if isinstance(snapshot, dict) else None
        elements = snapshot.get("elements") if isinstance(snapshot, dict) else None
        lines: list[str] = []
        if isinstance(page, dict):
            url = page.get("url")
            title = page.get("title")
            if url:
                lines.append(f"URL: {url}")
            if title:
                lines.append(f"Title: {title}")
        if isinstance(text, str) and text:
            compact = text.strip()
            if len(compact) > 3000:
                compact = compact[:3000] + "..."
            lines.append("VisibleText:")
            lines.append(compact)
        if isinstance(elements, list) and elements:
            lines.append("Elements:")
            count = 0
            for item in elements:
                if not isinstance(item, dict):
                    continue
                if count >= max_elements:
                    break
                label = _format_element_line(item)
                if label:
                    lines.append(label)
                    count += 1
        result = "\n".join(lines)
        if len(result) > max_chars:
            result = result[:max_chars] + "..."
        return result

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._connection is None:
            return
        await self._connection.websocket.send_text(_json_dumps(payload))

    def _summarize_snapshot(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        page = snapshot.get("page") if isinstance(snapshot, dict) else None
        url = page.get("url") if isinstance(page, dict) else None
        title = page.get("title") if isinstance(page, dict) else None
        elements = snapshot.get("elements") if isinstance(snapshot, dict) else None
        text = snapshot.get("text") if isinstance(snapshot, dict) else None
        return {
            "url": url,
            "title": title,
            "elements": len(elements) if isinstance(elements, list) else 0,
            "text_len": len(text) if isinstance(text, str) else 0,
        }


def _format_element_line(item: dict[str, Any]) -> str | None:
    el_id = item.get("id")
    tag = item.get("tag") or item.get("role")
    text = item.get("text") or item.get("ariaLabel") or ""
    selector = item.get("selector")
    parts: list[str] = []
    if el_id:
        parts.append(f"id={el_id}")
    if tag:
        parts.append(str(tag))
    if selector:
        parts.append(f"selector={selector}")
    if text:
        compact = " ".join(str(text).split())
        if len(compact) > 120:
            compact = compact[:120] + "..."
        parts.append(f"text={compact}")
    if not parts:
        return None
    return " - " + " | ".join(parts)


def _json_dumps(payload: dict[str, Any]) -> str:
    import json

    return json.dumps(payload, ensure_ascii=False)
