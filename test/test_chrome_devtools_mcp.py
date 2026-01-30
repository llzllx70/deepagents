"""Integration test for chrome-devtools-mcp."""

from __future__ import annotations

import asyncio
import json
import math
import os
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

DEFAULT_NAV_URL = "https://www.zhipin.com/hangzhou/?seoRefer=index"
DEFAULT_SCROLL_OFFSET = 800
SCROLL_STEP_DELAY_SECONDS = 0.6
SCROLL_MAX_STEPS = 60
SCROLL_BOTTOM_THRESHOLD_PX = 2
METRICS_SCRIPT = (
    "(() => {"
    "const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;"
    "const innerHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight || 0;"
    "const scrollHeight = Math.max(document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0);"
    "return {scrollTop, innerHeight, scrollHeight};"
    "})()"
)
SCROLL_TO_BOTTOM_SCRIPT = "window.scrollTo(0, document.body.scrollHeight);"
REPO_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class PageMetrics:
    scroll_top: float
    scroll_height: float
    inner_height: float


def _load_json_env(key: str) -> dict[str, Any]:
    raw = os.getenv(key)
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{key} must be valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be a JSON object")
    return value


def _resolve_command_and_args() -> tuple[str | None, list[str]]:
    command_env = os.getenv("CHROME_DEVTOOLS_MCP_COMMAND", "").strip()
    args_env = os.getenv("CHROME_DEVTOOLS_MCP_ARGS", "")
    if command_env:
        if args_env:
            return command_env, shlex.split(args_env)
        parts = shlex.split(command_env)
        if not parts:
            return None, []
        return parts[0], parts[1:]

    local_bin = REPO_ROOT / "node_modules" / ".bin" / "chrome-devtools-mcp"
    if local_bin.is_file():
        return str(local_bin), shlex.split(args_env)

    path_cmd = shutil.which("chrome-devtools-mcp")
    if path_cmd:
        return path_cmd, shlex.split(args_env)

    return None, []


def _resolve_transport() -> tuple[str | None, str | None, list[str], str | None]:
    transport = os.getenv("CHROME_DEVTOOLS_MCP_TRANSPORT", "").strip().lower()
    command, args = _resolve_command_and_args()
    url = os.getenv("CHROME_DEVTOOLS_MCP_URL")
    if not transport:
        if command:
            transport = "stdio"
        elif url:
            transport = "sse"
    return transport or None, command, args, url


def _tool_args_override() -> tuple[str | None, dict[str, Any]]:
    tool_name = os.getenv("CHROME_DEVTOOLS_MCP_TOOL")
    tool_args = _load_json_env("CHROME_DEVTOOLS_MCP_TOOL_ARGS_JSON")
    return tool_name, tool_args


def _as_float(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _extract_structured_content(result: Any) -> dict[str, Any] | None:
    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict):
        return structured
    for block in getattr(result, "content", []) or []:
        if getattr(block, "type", None) != "text":
            continue
        text = getattr(block, "text", None)
        if not isinstance(text, str):
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return None


def _find_metrics_payload(payload: Any) -> dict[str, Any] | None:
    if isinstance(payload, dict):
        if {
            "scrollTop",
            "scrollY",
            "scrollHeight",
            "innerHeight",
            "clientHeight",
            "viewportHeight",
            "documentHeight",
        }.intersection(payload.keys()):
            return payload
        for value in payload.values():
            found = _find_metrics_payload(value)
            if found:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _find_metrics_payload(item)
            if found:
                return found
    return None


def _extract_metrics(payload: Any) -> PageMetrics | None:
    metrics = _find_metrics_payload(payload)
    if not metrics:
        return None
    scroll_height = _as_float(
        metrics.get("scrollHeight") or metrics.get("documentHeight") or metrics.get("height")
    )
    inner_height = _as_float(
        metrics.get("innerHeight") or metrics.get("clientHeight") or metrics.get("viewportHeight")
    )
    if scroll_height is None or inner_height is None:
        return None
    if scroll_height <= 0 or inner_height <= 0:
        return None
    scroll_top = _as_float(metrics.get("scrollTop") or metrics.get("scrollY") or metrics.get("top"))
    if scroll_top is None:
        scroll_top = 0.0
    return PageMetrics(scroll_top=scroll_top, scroll_height=scroll_height, inner_height=inner_height)


def _scroll_script(default_offset: int) -> str:
    return (
        "(() => {"
        f"const fallback = {default_offset};"
        "const step = Math.max(1, window.innerHeight || document.documentElement.clientHeight || "
        "document.body.clientHeight || fallback);"
        "window.scrollBy(0, step);"
        "return step;"
        "})()"
    )


def _is_at_bottom(metrics: PageMetrics) -> bool:
    return metrics.scroll_top + metrics.inner_height >= metrics.scroll_height - SCROLL_BOTTOM_THRESHOLD_PX


def _estimate_max_steps(metrics: PageMetrics) -> int:
    remaining = max(0.0, metrics.scroll_height - (metrics.scroll_top + metrics.inner_height))
    if metrics.inner_height <= 0:
        return SCROLL_MAX_STEPS
    steps = math.ceil(remaining / metrics.inner_height)
    return max(1, min(SCROLL_MAX_STEPS, steps + 2))


def _build_args(
    schema: dict[str, Any] | None,
    candidate_args: dict[str, Any],
    fallback_args: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if not schema:
        return candidate_args
    required = schema.get("required") or []
    properties = schema.get("properties") or {}
    additional_allowed = schema.get("additionalProperties", True)
    args: dict[str, Any] = {}

    def add_if_allowed(key: str, value: Any) -> None:
        if additional_allowed or key in properties:
            args[key] = value

    if required:
        for key in required:
            if key in candidate_args:
                args[key] = candidate_args[key]
            elif fallback_args and key in fallback_args:
                args[key] = fallback_args[key]
            else:
                return None
        for key, value in candidate_args.items():
            if key in args:
                continue
            add_if_allowed(key, value)
        return args

    for key, value in candidate_args.items():
        add_if_allowed(key, value)
    if not args and fallback_args:
        for key, value in fallback_args.items():
            add_if_allowed(key, value)
    if not args and candidate_args:
        return None
    return args


def _select_tool(
    tools: list[Any],
    candidates: list[tuple[str, dict[str, Any], dict[str, Any] | None]],
) -> tuple[str | None, dict[str, Any]]:
    for tool in tools:
        tool_name = getattr(tool, "name", "")
        if not tool_name:
            continue
        schema = getattr(tool, "inputSchema", None)
        schema_dict = schema if isinstance(schema, dict) else None
        name_lower = tool_name.lower()
        for key, args, fallback in candidates:
            if key in name_lower:
                built_args = _build_args(schema_dict, args, fallback)
                if built_args is not None:
                    return tool_name, built_args
    return None, {}


def _auto_pick_navigation_tool(tools: list[Any]) -> tuple[str | None, dict[str, Any]]:
    candidates = [
        ("page.navigate", {"url": DEFAULT_NAV_URL}, None),
        ("navigate", {"url": DEFAULT_NAV_URL}, None),
        ("open_url", {"url": DEFAULT_NAV_URL}, None),
        ("goto", {"url": DEFAULT_NAV_URL}, None),
    ]
    return _select_tool(tools, candidates)


def _auto_pick_evaluate_tool(tools: list[Any], script: str) -> tuple[str | None, dict[str, Any]]:
    candidate_args = {
        "expression": script,
        "returnByValue": True,
        "awaitPromise": True,
    }
    eval_defaults = {
        "expression": script,
        "script": script,
        "source": script,
        "code": script,
        "javascript": script,
        "input": script,
        "text": script,
        "returnByValue": True,
        "awaitPromise": True,
    }
    eval_candidates = [
        ("runtime.evaluate", candidate_args, eval_defaults),
        ("page.evaluate", candidate_args, eval_defaults),
        ("evaluate", candidate_args, eval_defaults),
        ("eval", candidate_args, eval_defaults),
        ("execute", candidate_args, eval_defaults),
    ]
    return _select_tool(tools, eval_candidates)


def _auto_pick_scroll_tool(
    tools: list[Any],
    scroll_offset: int,
    scroll_script: str,
) -> tuple[str | None, dict[str, Any]]:
    scroll_defaults = {
        "deltaY": scroll_offset,
        "deltaX": 0,
        "x": 0,
        "y": scroll_offset,
        "dx": 0,
        "dy": scroll_offset,
        "amount": scroll_offset,
        "scrollY": scroll_offset,
        "scrollX": 0,
        "pixels": scroll_offset,
        "distance": scroll_offset,
        "wheelDeltaY": scroll_offset,
        "wheelDeltaX": 0,
    }
    scroll_candidates = [
        ("scroll", {"deltaY": scroll_offset}, scroll_defaults),
        ("mousewheel", {"deltaY": scroll_offset}, scroll_defaults),
        ("wheel", {"deltaY": scroll_offset}, scroll_defaults),
        (
            "input.dispatchmouseevent",
            {"type": "mouseWheel", "deltaY": scroll_offset},
            scroll_defaults,
        ),
    ]
    tool_name, tool_args = _select_tool(tools, scroll_candidates)
    if tool_name:
        return tool_name, tool_args

    return _auto_pick_evaluate_tool(tools, scroll_script)


async def _run_test() -> None:
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.sse import sse_client
        from mcp.client.stdio import stdio_client
        from mcp.client.streamable_http import streamablehttp_client
    except ModuleNotFoundError:
        pytest.skip("mcp is not installed")

    transport, command, args, url = _resolve_transport()
    if not transport:
        pytest.skip(
            "Set CHROME_DEVTOOLS_MCP_COMMAND or CHROME_DEVTOOLS_MCP_URL to run this test, "
            "or install chrome-devtools-mcp on PATH."
        )

    headers = _load_json_env("CHROME_DEVTOOLS_MCP_HEADERS_JSON")
    env_overrides = _load_json_env("CHROME_DEVTOOLS_MCP_ENV_JSON")
    env = {**os.environ, **env_overrides} if env_overrides else None

    if transport == "stdio":
        if not command:
            pytest.skip("CHROME_DEVTOOLS_MCP_COMMAND is required for stdio transport.")
        ctx = stdio_client(StdioServerParameters(command=command, args=args, env=env))
    elif transport == "sse":
        if not url:
            pytest.skip("CHROME_DEVTOOLS_MCP_URL is required for sse transport.")
        ctx = sse_client(url=url, headers=headers)
    elif transport in {"http", "streamable_http", "streamable-http"}:
        if not url:
            pytest.skip("CHROME_DEVTOOLS_MCP_URL is required for http transport.")
        ctx = streamablehttp_client(url=url, headers=headers)
    else:
        pytest.fail(f"Unsupported transport: {transport}")

    async with ctx as result:
        if len(result) == 2:
            read, write = result
        else:
            read, write, _ = result
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools_response = await session.list_tools()
            tools = list(tools_response.tools)
            if not tools:
                pytest.fail("No tools returned by chrome-devtools-mcp.")

            tool_name, tool_args = _tool_args_override()
            if tool_name:
                tool_name = tool_name.strip()
            if not tool_name:
                tool_name, tool_args = _auto_pick_navigation_tool(tools)

            if not tool_name:
                pytest.skip(
                    "No suitable navigation tool found. Set CHROME_DEVTOOLS_MCP_TOOL and "
                    "CHROME_DEVTOOLS_MCP_TOOL_ARGS_JSON to run a specific tool."
                )

            result = await session.call_tool(tool_name, arguments=tool_args)
            assert result.content is not None

            await asyncio.sleep(1)

            metrics_tool, metrics_args = _auto_pick_evaluate_tool(tools, METRICS_SCRIPT)
            metrics: PageMetrics | None = None
            if metrics_tool:
                metrics_result = await session.call_tool(metrics_tool, arguments=metrics_args)
                assert metrics_result.content is not None
                payload = _extract_structured_content(metrics_result)
                if payload is not None:
                    metrics = _extract_metrics(payload)

            scroll_offset = DEFAULT_SCROLL_OFFSET
            if metrics:
                scroll_offset = max(1, int(metrics.inner_height))

            scroll_script = _scroll_script(scroll_offset)
            scroll_tool, scroll_args = _auto_pick_scroll_tool(tools, scroll_offset, scroll_script)
            if not scroll_tool:
                pytest.skip(
                    "No suitable scroll tool found. Update CHROME_DEVTOOLS_MCP_TOOL to "
                    "a scroll-capable tool or ensure an evaluate/scroll tool is available."
                )

            max_steps = SCROLL_MAX_STEPS
            if metrics:
                max_steps = _estimate_max_steps(metrics)

            for _ in range(max_steps):
                scroll_result = await session.call_tool(scroll_tool, arguments=scroll_args)
                assert scroll_result.content is not None
                await asyncio.sleep(SCROLL_STEP_DELAY_SECONDS)

                if not metrics_tool:
                    continue
                metrics_result = await session.call_tool(metrics_tool, arguments=metrics_args)
                assert metrics_result.content is not None
                payload = _extract_structured_content(metrics_result)
                if payload is None:
                    continue
                metrics = _extract_metrics(payload)
                if metrics and _is_at_bottom(metrics):
                    break

            if metrics_tool and metrics and not _is_at_bottom(metrics):
                bottom_tool, bottom_args = _auto_pick_evaluate_tool(tools, SCROLL_TO_BOTTOM_SCRIPT)
                if bottom_tool:
                    bottom_result = await session.call_tool(bottom_tool, arguments=bottom_args)
                    assert bottom_result.content is not None


def test_chrome_devtools_mcp_smoke() -> None:
    asyncio.run(_run_test())
