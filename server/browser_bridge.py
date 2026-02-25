from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from server.browser_router import BrowserRouter


@dataclass
class BrowserSnapshot:
    payload: dict[str, Any]
    received_at: float


class BrowserBridge:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._router: BrowserRouter | None = None
        self._snapshot: BrowserSnapshot | None = None
        self._snapshot_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._action_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    def set_router(self, router: BrowserRouter) -> None:
        self._router = router

    def is_connected(self) -> bool:
        return self._router is not None and self._router.is_ws_connected()

    def last_snapshot(self) -> dict[str, Any] | None:
        return self._snapshot.payload if self._snapshot else None

    def snapshot_age_seconds(self) -> float | None:
        """Return seconds elapsed since the last snapshot was received, or None."""
        if not self._snapshot:
            return None
        return time.time() - self._snapshot.received_at

    # ── Inbound handlers (called by BrowserRouter) ───────────

    async def handle_snapshot(self, data: dict[str, Any]) -> dict[str, Any] | None:
        snapshot = data.get("snapshot")
        if not isinstance(snapshot, dict):
            snapshot = {k: v for k, v in data.items() if k not in ("type", "request_id")}
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

    async def handle_action_result(self, data: dict[str, Any]) -> None:
        action_id = data.get("action_id")
        if action_id and action_id in self._action_waiters:
            waiter = self._action_waiters.pop(action_id)
            if not waiter.done():
                waiter.set_result(data)
        snapshot = data.get("snapshot")
        if isinstance(snapshot, dict):
            self._snapshot = BrowserSnapshot(payload=snapshot, received_at=time.time())

    # ── Outbound requests ────────────────────────────────────

    async def request_snapshot(
        self,
        *,
        mode: str = "compact",
        timeout: float = 8.0,
        reason: str | None = None,
    ) -> dict[str, Any]:
        if not self.is_connected():
            return {"success": False, "error": "Browser Bridge not connected"}
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
        if not self.is_connected():
            return {"success": False, "error": "Browser Bridge not connected"}
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

    def format_snapshot_for_tool(
        self,
        mode: str = "compact",
        snapshot_data: dict[str, Any] | None = None,
    ) -> str:
        """Format a snapshot as compact text for LLM tool returns.

        More generous than ``format_snapshot_for_prompt`` since the Agent
        explicitly requested this data, but still much smaller than raw JSON.

        If *snapshot_data* is provided it is used directly; otherwise the last
        cached snapshot is used.
        """
        snapshot = snapshot_data
        if snapshot is None:
            snapshot = self._snapshot.payload if self._snapshot else None
        if not isinstance(snapshot, dict):
            return "(no snapshot data)"
        max_chars = 6000
        max_elements = 80 if mode == "compact" else 150
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
            compact_text = text.strip()
            text_limit = 4000 if mode == "compact" else 6000
            if len(compact_text) > text_limit:
                compact_text = compact_text[:text_limit] + "..."
            lines.append("VisibleText:")
            lines.append(compact_text)

        if isinstance(elements, list) and elements:
            lines.append("Elements:")
            count = 0
            for item in elements:
                if not isinstance(item, dict):
                    continue
                if count >= max_elements:
                    remaining = sum(1 for e in elements[count:] if isinstance(e, dict))
                    if remaining:
                        lines.append(f"... and {remaining} more elements")
                    break
                label = _format_element_compact(item)
                if label:
                    lines.append(label)
                    count += 1

        if not lines:
            return "(page snapshot is empty — no visible text or interactive elements)"
        result = "\n".join(lines)
        if len(result) > max_chars:
            result = result[:max_chars] + "\n...(truncated)"
        return result

    def describe_element(self, element_id: str) -> str | None:
        """Look up a human-readable description for an element from the last snapshot."""
        if not self._snapshot or not element_id:
            return None
        elements = self._snapshot.payload.get("elements")
        if not isinstance(elements, list):
            return None
        for item in elements:
            if not isinstance(item, dict):
                continue
            if str(item.get("id", "")) == element_id:
                return _describe_element(item)
        return None

    # ── Private ──────────────────────────────────────────────

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._router is None:
            return
        await self._router.send_to_extension(payload, self.session_id)

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


def _describe_element(item: dict[str, Any]) -> str | None:
    """Return a short human-readable description for a snapshot element.

    Example outputs: ``button "提交"``, ``input "搜索"``, ``a "首页"``
    """
    tag = item.get("tag") or item.get("role")
    text = item.get("text") or item.get("ariaLabel") or ""
    if isinstance(text, str):
        text = " ".join(text.split()).strip()
        if len(text) > 40:
            text = text[:40] + "..."
    if tag and text:
        return f'{tag} "{text}"'
    if tag:
        return str(tag)
    if text:
        return f'"{text}"'
    return None


def _format_element_compact(item: dict[str, Any]) -> str | None:
    """Format a single element as a compact one-liner for tool returns.

    Example outputs::

        [da-1] button "提交"
        [da-3] input type=text value="搜索..."
        [da-5] a "首页" href=/home
    """
    el_id = item.get("id")
    if not el_id:
        return None
    tag = item.get("tag") or item.get("role") or ""
    text = item.get("text") or item.get("ariaLabel") or ""
    if isinstance(text, str):
        text = " ".join(text.split()).strip()
        if len(text) > 60:
            text = text[:60] + "..."

    parts: list[str] = [f"[{el_id}]"]
    if tag:
        parts.append(str(tag))
    if text:
        parts.append(f'"{text}"')
    # Include only meaningful attributes
    for attr in ("type", "href", "value"):
        val = item.get(attr)
        if val:
            val_str = str(val)
            if len(val_str) > 60:
                val_str = val_str[:60] + "..."
            parts.append(f"{attr}={val_str}")
    if item.get("disabled"):
        parts.append("disabled")
    return " ".join(parts)


def _format_element_line(item: dict[str, Any]) -> str | None:
    el_id = item.get("id")
    tag = item.get("tag") or item.get("role")
    text = item.get("text") or item.get("ariaLabel") or ""
    parts: list[str] = []
    if el_id:
        parts.append(f"id={el_id}")
    if tag:
        parts.append(str(tag))
    if text:
        compact = " ".join(str(text).split())
        if len(compact) > 120:
            compact = compact[:120] + "..."
        parts.append(f"text={compact}")
    if not parts:
        return None
    return " - " + " | ".join(parts)
