from __future__ import annotations

from typing import Any

from langchain_core.tools import BaseTool, tool

from .browser_bridge import BrowserBridge
from .browser_target_utils import normalize_browser_target


def build_browser_tools(browser_bridge: BrowserBridge) -> list[BaseTool]:
    @tool(
        "browser_request_snapshot",
        description=(
            "Request a compact snapshot of the user's current browser tab via the extension. "
            "Use when you need current page content before deciding the next action."
        ),
    )
    async def browser_request_snapshot(
        mode: str = "compact",
        reason: str | None = None,
        timeout_s: float = 8.0,
    ) -> dict[str, Any]:
        return await browser_bridge.request_snapshot(
            mode=mode,
            timeout=timeout_s,
            reason=reason,
        )

    @tool(
        "browser_action",
        description=(
            "Execute a browser action via the user's Chrome extension (CDP). "
            "Supported actions: click, type, scroll, open, wait. "
            "Provide action plus optional target {id, selector}, text, delta, url, new_tab, activate_tab, detach_after, wait_ms, return_snapshot."
        ),
    )
    async def browser_action(
        action: str,
        target: dict[str, Any] | str | None = None,
        text: str | None = None,
        delta: int | None = None,
        url: str | None = None,
        new_tab: bool | None = None,
        activate_tab: bool | None = None,
        detach_after: bool | None = None,
        wait_ms: int | None = None,
        return_snapshot: bool | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"action": action}
        normalized_target = normalize_browser_target(target)
        if normalized_target is not None:
            payload["target"] = normalized_target
        if text is not None:
            payload["text"] = text
        if delta is not None:
            payload["delta"] = delta
        if url is not None:
            payload["url"] = url
        if new_tab is not None:
            payload["new_tab"] = new_tab
        if activate_tab is not None:
            payload["activate_tab"] = activate_tab
        if detach_after is not None:
            payload["detach_after"] = detach_after
        if wait_ms is not None:
            payload["wait_ms"] = wait_ms
        if return_snapshot is not None:
            payload["return_snapshot"] = return_snapshot
        return await browser_bridge.send_action(payload)

    return [browser_request_snapshot, browser_action]


__all__ = ["build_browser_tools"]
