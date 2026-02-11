from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, TYPE_CHECKING

from fastapi import WebSocket

if TYPE_CHECKING:
    from server.browser_bridge import BrowserBridge

logger = logging.getLogger(__name__)


class BrowserRouter:
    """Per-user router: one Extension WebSocket, many sessions."""

    def __init__(self, username: str) -> None:
        self.username = username
        self._ws: WebSocket | None = None
        self._bridges: dict[str, BrowserBridge] = {}          # session_id → bridge
        self._session_tabs: dict[str, set[int]] = {}          # session_id → tab_ids
        self._tab_session: dict[int, str] = {}                # tab_id → session_id
        self._pending_actions: dict[str, str] = {}            # action_id → session_id
        self._pending_snapshots: dict[str, str] = {}          # request_id → session_id
        self._unassigned_tabs: list[int] = []                 # tabs reported by hello but not yet assigned

    # ── WebSocket lifecycle ──────────────────────────────────

    async def attach_ws(self, websocket: WebSocket) -> None:
        if self._ws is not None and self._ws is not websocket:
            try:
                await self._ws.close(code=1012)
            except Exception:
                pass
        self._ws = websocket
        logger.info("[BrowserRouter] user=%s ws attached", self.username)

    async def detach_ws(self, websocket: WebSocket) -> None:
        if self._ws is websocket:
            self._ws = None
            logger.info("[BrowserRouter] user=%s ws detached", self.username)

    def is_ws_connected(self) -> bool:
        return self._ws is not None

    # ── Bridge registration ──────────────────────────────────

    def register_bridge(self, session_id: str, bridge: BrowserBridge) -> None:
        self._bridges[session_id] = bridge
        self._session_tabs.setdefault(session_id, set())
        logger.info("[BrowserRouter] user=%s registered bridge session=%s", self.username, session_id)

    def unregister_bridge(self, session_id: str) -> None:
        self._bridges.pop(session_id, None)
        tabs = self._session_tabs.pop(session_id, set())
        for tab_id in tabs:
            self._tab_session.pop(tab_id, None)
        logger.info("[BrowserRouter] user=%s unregistered bridge session=%s", self.username, session_id)

    # ── Tab assignment ───────────────────────────────────────

    def assign_tab(self, session_id: str, tab_id: int) -> None:
        old_session = self._tab_session.get(tab_id)
        if old_session and old_session != session_id:
            self._session_tabs.get(old_session, set()).discard(tab_id)
        self._tab_session[tab_id] = session_id
        self._session_tabs.setdefault(session_id, set()).add(tab_id)
        if tab_id in self._unassigned_tabs:
            self._unassigned_tabs.remove(tab_id)
        logger.info("[BrowserRouter] assign tab=%s → session=%s", tab_id, session_id)

    def resolve_tab(self, session_id: str) -> int | None:
        tabs = self._session_tabs.get(session_id, set())
        if tabs:
            return next(iter(tabs))
        if self._unassigned_tabs:
            tab_id = self._unassigned_tabs.pop(0)
            self.assign_tab(session_id, tab_id)
            return tab_id
        return None

    # ── Outbound: session → extension ────────────────────────

    async def send_to_extension(self, payload: dict[str, Any], session_id: str) -> None:
        if self._ws is None:
            return

        msg_type = payload.get("type", "")

        if "tab_id" not in payload:
            tab_id = self.resolve_tab(session_id)
            if tab_id is not None:
                payload["tab_id"] = tab_id

        action_id = payload.get("action_id")
        if action_id:
            self._pending_actions[action_id] = session_id

        request_id = payload.get("request_id")
        if request_id:
            self._pending_snapshots[request_id] = session_id

        try:
            await self._ws.send_text(json.dumps(payload, ensure_ascii=False))
        except Exception:
            logger.exception("[BrowserRouter] send_to_extension failed user=%s", self.username)

    # ── Inbound: extension → session ─────────────────────────

    async def handle_extension_message(self, data: dict[str, Any]) -> dict[str, Any] | None:
        msg_type = data.get("type", "")

        if msg_type == "ping":
            return {"type": "pong"}

        if msg_type == "browser.hello":
            return self._handle_hello(data)

        if msg_type == "browser.action.result":
            return await self._handle_action_result(data)

        if msg_type == "browser.snapshot":
            return await self._handle_snapshot(data)

        if msg_type == "browser.tab.created":
            return self._handle_tab_created(data)

        if msg_type == "browser.tab.closed":
            return self._handle_tab_closed(data)

        logger.debug("[BrowserRouter] unhandled message type=%s", msg_type)
        return None

    # ── Inbound handlers ─────────────────────────────────────

    def _handle_hello(self, data: dict[str, Any]) -> dict[str, Any]:
        tab_id = data.get("tab_id")
        if tab_id is not None and tab_id not in self._tab_session:
            if tab_id not in self._unassigned_tabs:
                self._unassigned_tabs.append(tab_id)
        logger.info("[BrowserRouter] hello from extension user=%s tab=%s", self.username, tab_id)
        return {
            "type": "browser.status",
            "status": "connected",
            "username": self.username,
            "sessions": list(self._bridges.keys()),
        }

    async def _handle_action_result(self, data: dict[str, Any]) -> dict[str, Any] | None:
        action_id = data.get("action_id")
        session_id = self._pending_actions.pop(action_id, None) if action_id else None
        if session_id and session_id in self._bridges:
            bridge = self._bridges[session_id]
            await bridge.handle_action_result(data)
        return None

    async def _handle_snapshot(self, data: dict[str, Any]) -> dict[str, Any] | None:
        request_id = data.get("request_id")
        session_id = self._pending_snapshots.pop(request_id, None) if request_id else None
        if session_id and session_id in self._bridges:
            bridge = self._bridges[session_id]
            return await bridge.handle_snapshot(data)
        return None

    def _handle_tab_created(self, data: dict[str, Any]) -> dict[str, Any] | None:
        tab_id = data.get("tab_id")
        action_id = data.get("action_id")
        if tab_id is not None and action_id:
            session_id = self._pending_actions.get(action_id)
            if session_id:
                self.assign_tab(session_id, tab_id)
        elif tab_id is not None:
            if tab_id not in self._tab_session and tab_id not in self._unassigned_tabs:
                self._unassigned_tabs.append(tab_id)
        return None

    def _handle_tab_closed(self, data: dict[str, Any]) -> dict[str, Any] | None:
        tab_id = data.get("tab_id")
        if tab_id is not None:
            session_id = self._tab_session.pop(tab_id, None)
            if session_id:
                self._session_tabs.get(session_id, set()).discard(tab_id)
            if tab_id in self._unassigned_tabs:
                self._unassigned_tabs.remove(tab_id)
        return None
