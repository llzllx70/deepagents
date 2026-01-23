from __future__ import annotations

import json
from typing import Any, TYPE_CHECKING

from .config import logger

if TYPE_CHECKING:
    from deepagents_cli.file_ops import FileOpTracker

    from .sessions import Session


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

    logger.info(
        "Tool call started: session_id=%s run_id=%s tool=%s tool_call_id=%s args=%s",
        session.session_id,
        run_id,
        tool_name,
        tool_call_id,
        args,
    )
    await session.broadcast(
        {
            "type": "tool.call.started",
            "run_id": run_id,
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "args": args,
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
    chunk_name = block.get("name")
    chunk_args = block.get("args")
    chunk_id = block.get("id")
    chunk_index = block.get("index")

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
            parts: list[str] = buffer.setdefault("args_parts", [])
            if not parts or chunk_args != parts[-1]:
                parts.append(chunk_args)
            buffer["args"] = "".join(parts)
    elif chunk_args is not None:
        buffer["args"] = chunk_args

    buffer_name = buffer.get("name")
    buffer_id = buffer.get("id")
    if buffer_name is None:
        return

    parsed_args = buffer.get("args")
    if isinstance(parsed_args, str):
        if not parsed_args:
            return
        try:
            parsed_args = json.loads(parsed_args)
        except json.JSONDecodeError:
            return
    elif parsed_args is None:
        return

    if not isinstance(parsed_args, dict):
        parsed_args = {"value": parsed_args}

    if buffer_id is not None:
        if buffer_id not in displayed_tool_ids:
            displayed_tool_ids.add(buffer_id)
            file_op_tracker.start_operation(buffer_name, parsed_args, buffer_id)
        else:
            file_op_tracker.update_args(buffer_id, parsed_args)

    tool_call_buffers.pop(buffer_key, None)

    await session.broadcast(
        {
            "type": "tool.call.started",
            "run_id": run_id,
            "tool_name": buffer_name,
            "tool_call_id": buffer_id,
            "args": parsed_args,
        }
    )
