from __future__ import annotations

import json
import os
from typing import Any, TYPE_CHECKING

from .config import logger
from .message_utils import format_tool_display, parse_tool_args

if TYPE_CHECKING:
    from deepagents_cli.file_ops import FileOpTracker

    from .sessions import Session

DEBUG_TOOL_CALLS = os.getenv("DEEPAGENTS_DEBUG_TOOL_CALLS") == "1"


def _preview_args(value: Any, limit: int = 200) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        text = json.dumps(value)
    else:
        text = str(value)
    text = text.replace("\n", "\\n")
    if len(text) > limit:
        return text[:limit] + "...(truncated)"
    return text


def _merge_stream_text(current: str | None, incoming: str) -> str:
    if not current:
        return incoming
    if incoming == current:
        return current
    if incoming.startswith(current):
        return incoming
    if current.startswith(incoming):
        return current
    return current + incoming


def _log_write_file_debug(tool_name: str, args: Any, tool_call_id: str | None) -> None:
    if not DEBUG_TOOL_CALLS or tool_name != "write_file":
        return
    args_dict = args if isinstance(args, dict) else {}
    content = args_dict.get("content")
    content_len = len(content) if isinstance(content, str) else 0
    logger.info(
        "write_file invoke: tool_call_id=%s file_path=%s content_len=%s args_type=%s",
        tool_call_id,
        args_dict.get("file_path"),
        content_len,
        type(args).__name__,
    )


async def emit_tool_call_started(
    *,
    session: "Session",
    run_id: str,
    tool_name: str,
    tool_call_id: str | None,
    args: dict[str, Any],
    file_op_tracker: "FileOpTracker",
    displayed_tool_ids: set[str],
) -> None:
    if tool_call_id is not None:
        if tool_call_id not in displayed_tool_ids:
            displayed_tool_ids.add(tool_call_id)
            file_op_tracker.start_operation(tool_name, args, tool_call_id)
        else:
            file_op_tracker.update_args(tool_call_id, args)

    if tool_name == "write_file":
        print('get')

    _log_write_file_debug(tool_name, args, tool_call_id)

    logger.info(
        "Tool call started: session_id=%s run_id=%s tool=%s tool_call_id=%s args=%s",
        session.session_id,
        run_id,
        tool_name,
        tool_call_id,
        args,
    )
    if not args and tool_name in {"read_file", "write_file", "edit_file", "execute", "shell"}:
        logger.info(
            "Tool call started with empty args: session_id=%s run_id=%s tool=%s tool_call_id=%s",
            session.session_id,
            run_id,
            tool_name,
            tool_call_id,
        )
    display = format_tool_display(tool_name, args)
    await session.broadcast(
        {
            "type": "tool.call.started",
            "run_id": run_id,
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "args": args,
            "display_title": display["title"],
            "display_content": display["content"],
        }
    )


async def handle_tool_call_block(
    block: dict[str, Any],
    tool_call_buffers: dict[str | int, dict[str, Any]],
    displayed_tool_ids: set[str],
    file_op_tracker: "FileOpTracker",
    run_id: str,
    session: "Session",
) -> None:
    chunk_name = block.get("name") or block.get("tool_name")
    chunk_args = block.get("args")
    if chunk_args in (None, "", {}):
        for key in ("arguments", "input", "parameters", "params"):
            if key in block:
                chunk_args = block.get(key)
                break
    if chunk_name is None and isinstance(block.get("function"), dict):
        function_block = block.get("function", {})
        chunk_name = function_block.get("name") or chunk_name
        if chunk_args in (None, "", {}):
            for key in ("arguments", "input", "parameters", "params"):
                if key in function_block:
                    chunk_args = function_block.get(key)
                    break

    chunk_id = block.get("id") or block.get("tool_call_id") or block.get("call_id")
    chunk_index = block.get("index") or block.get("tool_call_index")

    if DEBUG_TOOL_CALLS:
        logger.info(
            "Tool call chunk: run_id=%s name=%s id=%s index=%s args_preview=%s",
            run_id,
            chunk_name,
            chunk_id,
            chunk_index,
            _preview_args(chunk_args),
        )

    if chunk_index is not None:
        buffer_key: str | int = chunk_index
    elif chunk_id is not None:
        buffer_key = chunk_id
    else:
        buffer_key = f"unknown-{len(tool_call_buffers)}"

    buffer = tool_call_buffers.setdefault(
        buffer_key,
        {"name": None, "id": None, "args": None, "args_parts": []},
    )

    if chunk_name:
        buffer["name"] = chunk_name
    if chunk_id:
        buffer["id"] = chunk_id

    if isinstance(chunk_args, dict):
        buffer["args"] = chunk_args
        buffer["args_parts"] = []
    elif isinstance(chunk_args, str):
        if chunk_args:
            current = buffer.get("args")
            if isinstance(current, str):
                buffer["args"] = _merge_stream_text(current, chunk_args)
            else:
                buffer["args"] = chunk_args
    elif chunk_args is not None:
        buffer["args"] = chunk_args

    buffer_name = buffer.get("name")
    buffer_id = buffer.get("id")
    if buffer_id is None and buffer_name is not None and chunk_index is not None:
        buffer_id = f"{buffer_name}:{chunk_index}"
        buffer["id"] = buffer_id
    if buffer_name is None:
        return

    parsed_args = parse_tool_args(buffer.get("args"))
    if parsed_args in (None, {}):
        if buffer_name in {"read_file", "write_file", "edit_file", "execute", "shell"}:
            logger.info(
                "Tool call args missing: run_id=%s name=%s id=%s args_preview=%s block=%s",
                run_id,
                buffer_name,
                buffer_id,
                _preview_args(buffer.get("args")),
                _preview_args(block),
            )
        if DEBUG_TOOL_CALLS:
            logger.info(
                "Tool call args incomplete: run_id=%s name=%s id=%s args_preview=%s",
                run_id,
                buffer_name,
                buffer_id,
                _preview_args(buffer.get("args")),
            )
            logger.info(
                "Tool call block payload: run_id=%s name=%s id=%s block=%s",
                run_id,
                buffer_name,
                buffer_id,
                _preview_args(block),
            )
        if parsed_args is None:
            return

    if buffer_id is not None:
        if buffer_id not in displayed_tool_ids:
            displayed_tool_ids.add(buffer_id)
            file_op_tracker.start_operation(buffer_name, parsed_args, buffer_id)
        else:
            file_op_tracker.update_args(buffer_id, parsed_args)

    tool_call_buffers.pop(buffer_key, None)

    _log_write_file_debug(buffer_name, parsed_args, buffer_id)

    if DEBUG_TOOL_CALLS:
        logger.info(
            "Tool call assembled: run_id=%s name=%s id=%s args_preview=%s",
            run_id,
            buffer_name,
            buffer_id,
            _preview_args(parsed_args),
        )

    display = format_tool_display(buffer_name, parsed_args)
    await session.broadcast(
        {
            "type": "tool.call.started",
            "run_id": run_id,
            "tool_name": buffer_name,
            "tool_call_id": buffer_id,
            "args": parsed_args,
            "display_title": display["title"],
            "display_content": display["content"],
        }
    )
