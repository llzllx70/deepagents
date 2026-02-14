"""Middleware to truncate oversized tool results before they reach the model.

Prevents single large ToolMessage results (e.g., from fetch_url, http_request,
web_search, MCP tools) from consuming too much context window.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import AgentState
from langchain_core.messages import ToolMessage
from langgraph.runtime import Runtime

from .message_utils import truncate_string

logger = logging.getLogger(__name__)

# ~7.5k tokens at ~4 chars/token
_MAX_TOOL_RESULT_CHARS = 30000


def _truncate_tool_result(content: str, max_chars: int = _MAX_TOOL_RESULT_CHARS) -> str:
    """Truncate a tool result string, keeping head and tail for context."""
    return truncate_string(content, max_chars, mode="head_tail")


class ToolResultTruncationMiddleware(AgentMiddleware):
    """Truncates oversized ToolMessage content in before_model.

    This protects against single tool results that could consume the entire
    context window (e.g., large web pages from fetch_url, huge API responses).
    """

    def __init__(self, max_chars: int = _MAX_TOOL_RESULT_CHARS) -> None:
        self._max_chars = max_chars

    def before_model(
        self,
        state: AgentState[Any],
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        messages = state.get("messages", [])
        if not messages:
            return None

        modified = False
        new_messages = []

        for msg in messages:
            if isinstance(msg, ToolMessage):
                content = msg.content
                if isinstance(content, str) and len(content) > self._max_chars:
                    tool_name = getattr(msg, "name", "unknown")
                    original_len = len(content)
                    truncated = _truncate_tool_result(content, self._max_chars)
                    logger.info(
                        "Truncating tool result: tool=%s original_chars=%d truncated_chars=%d",
                        tool_name, original_len, len(truncated),
                    )
                    new_msg = msg.model_copy()
                    new_msg.content = truncated
                    new_messages.append(new_msg)
                    modified = True
                else:
                    new_messages.append(msg)
            else:
                new_messages.append(msg)

        if not modified:
            return None

        from langchain_core.messages import RemoveMessage
        from langgraph.graph.message import REMOVE_ALL_MESSAGES

        return {
            "messages": [
                RemoveMessage(id=REMOVE_ALL_MESSAGES),
                *new_messages,
            ]
        }

    async def abefore_model(
        self,
        state: AgentState[Any],
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        return self.before_model(state, runtime)
