from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from langchain_core.tools import BaseTool, StructuredTool

from .config import logger
from .mcp_config import load_mcp_servers

_MCP_TOOLS_CACHE: list[BaseTool] | None = None
_MCP_TOOLS_LOCK = asyncio.Lock()


def _sanitize_tool_prefix(name: str) -> str:
    cleaned = name.strip().replace(" ", "-")
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "-", cleaned)
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    return cleaned or "mcp-server"


@asynccontextmanager
async def _connect_mcp(server: dict[str, Any]) -> AsyncIterator[Any]:
    transport = str(server.get("transport", "http")).lower()
    command = server.get("command")
    args = server.get("args") or []
    if isinstance(args, str):
        args = [args]
    env = server.get("env")
    url = server.get("url")
    headers = server.get("headers") or {}

    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.sse import sse_client
        from mcp.client.stdio import stdio_client
        from mcp.client.streamable_http import streamablehttp_client
    except Exception as exc:
        raise RuntimeError(f"mcp package is required for MCP tools: {exc}") from exc

    if transport == "stdio":
        if not command:
            raise ValueError("stdio transport requires command")
        ctx = stdio_client(StdioServerParameters(command=command, args=args, env=env))
    elif transport == "sse":
        if not url:
            raise ValueError("sse transport requires url")
        ctx = sse_client(url=url, headers=headers)
    elif transport in ("http", "streamable_http", "streamable-http"):
        if not url:
            raise ValueError("http transport requires url")
        ctx = streamablehttp_client(url=url, headers=headers)
    else:
        raise ValueError(f"Unsupported MCP transport: {transport}")

    async with ctx as result:
        if len(result) == 2:
            read, write = result
        elif len(result) == 3:
            read, write, _ = result
        else:
            raise ValueError(f"Unexpected MCP context result: {result}")
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def _list_tools(server: dict[str, Any]) -> list[dict[str, Any]]:
    async with _connect_mcp(server) as session:
        response = await session.list_tools()
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.inputSchema,
            }
            for tool in response.tools
        ]


async def _call_tool(
    server: dict[str, Any],
    tool_name: str,
    arguments: dict[str, Any] | None,
) -> Any:
    async with _connect_mcp(server) as session:
        result = await session.call_tool(tool_name, arguments=arguments or {})
        return result.content


def _build_server_tools(server: dict[str, Any]) -> list[BaseTool]:
    name = str(server["name"])
    tool_prefix = _sanitize_tool_prefix(str(server.get("tool_prefix") or name))
    tools_cache: list[dict[str, Any]] | None = None

    async def list_tools() -> list[dict[str, Any]]:
        nonlocal tools_cache
        if tools_cache is None:
            tools_cache = await _list_tools(server)
        return tools_cache

    async def tool_call(tool_name: str, arguments: dict[str, Any]) -> Any:
        return await _call_tool(server, tool_name=tool_name, arguments=arguments)

    list_description = (
        f"List available MCP tools for server '{name}'. "
        "Returns tool name, description, and input_schema."
    )
    call_description = (
        f"Call a tool on MCP server '{name}'. "
        "Use tool_name from LIST_TOOLS and pass arguments matching input_schema."
    )

    list_tool = StructuredTool.from_function(
        list_tools,
        name=f"mcp__{tool_prefix}__LIST_TOOLS",
        description=list_description,
    )
    call_tool = StructuredTool.from_function(
        tool_call,
        name=f"mcp__{tool_prefix}__TOOL_CALL",
        description=call_description,
    )

    return [list_tool, call_tool]


async def _build_mcp_tools() -> list[BaseTool]:
    servers = load_mcp_servers()
    if not servers:
        return []

    try:
        __import__("mcp")
    except Exception as exc:
        logger.warning("MCP tools disabled: mcp package not available (%s)", exc)
        return []

    tools: list[BaseTool] = []
    for server in servers:
        try:
            tools.extend(_build_server_tools(server))
        except Exception as exc:
            logger.warning("Failed to build MCP tools for %s: %s", server.get("name"), exc)
    return tools


async def get_mcp_tools() -> list[BaseTool]:
    global _MCP_TOOLS_CACHE
    if _MCP_TOOLS_CACHE is not None:
        return _MCP_TOOLS_CACHE
    async with _MCP_TOOLS_LOCK:
        if _MCP_TOOLS_CACHE is None:
            _MCP_TOOLS_CACHE = await _build_mcp_tools()
    return _MCP_TOOLS_CACHE
