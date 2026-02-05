from __future__ import annotations

import os
from typing import Any, Awaitable, Callable

from langchain.agents.middleware.types import AgentMiddleware
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from .message_utils import parse_tool_args
from .config import logger
from .tool_call_args import record_tool_call_args

DEBUG_TOOL_CALLS = os.getenv("DEEPAGENTS_DEBUG_TOOL_CALLS") == "1"


class ToolCallArgsMiddleware(AgentMiddleware):
    """Capture tool call arguments from execution-time requests."""

    def _record(self, request: ToolCallRequest) -> None:
        tool_call = request.tool_call or {}
        tool_call_id = tool_call.get("id") or tool_call.get("tool_call_id")
        tool_name = tool_call.get("name") or tool_call.get("tool_name")
        raw_args = tool_call.get("args")
        if raw_args in (None, "", {}):
            for key in ("arguments", "input", "parameters", "params"):
                if key in tool_call:
                    raw_args = tool_call.get(key)
                    break
        if raw_args in (None, "", {}) and isinstance(tool_call.get("function"), dict):
            func = tool_call.get("function", {})
            for key in ("arguments", "input", "parameters", "params"):
                if key in func:
                    raw_args = func.get(key)
                    break
        parsed_args = parse_tool_args(raw_args)
        if DEBUG_TOOL_CALLS and tool_name in {"read_file", "write_file", "edit_file", "execute", "shell"}:
            logger.info(
                "Tool runtime capture: tool=%s id=%s parsed_args=%s",
                tool_name,
                tool_call_id,
                parsed_args,
            )
        if parsed_args in (None, {}) and tool_name in {"read_file", "write_file", "edit_file", "execute", "shell"}:
            logger.info(
                "Tool runtime args missing: tool=%s id=%s raw=%s tool_call=%s",
                tool_name,
                tool_call_id,
                raw_args,
                tool_call,
            )
        elif DEBUG_TOOL_CALLS and parsed_args in (None, {}):
            logger.info(
                "Tool runtime args missing: tool=%s id=%s raw=%s",
                tool_name,
                tool_call_id,
                raw_args,
            )
        if parsed_args is None:
            return
        metadata = {}
        configurable = {}
        if request.runtime and request.runtime.config:
            metadata = request.runtime.config.get("metadata", {}) or {}
            configurable = request.runtime.config.get("configurable", {}) or {}
        session_id = metadata.get("session_id")
        run_id = metadata.get("run_id")
        thread_id = configurable.get("thread_id")
        record_tool_call_args(
            session_id=str(session_id) if session_id else "",
            thread_id=str(thread_id) if thread_id else None,
            tool_call_id=str(tool_call_id) if tool_call_id else "",
            tool_name=str(tool_name) if tool_name else None,
            args=parsed_args,
            run_id=str(run_id) if run_id else None,
        )

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        self._record(request)
        return handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        self._record(request)
        return await handler(request)
