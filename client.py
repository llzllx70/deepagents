from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass, field
from typing import Any

import requests
import websockets


@dataclass
class ClientState:
    session_id: str
    current_run_id: str | None = None
    pending_interrupts: list[dict[str, Any]] = field(default_factory=list)
    streaming: bool = False
    stopping: bool = False


def _print_line(state: ClientState, text: str) -> None:
    if state.streaming:
        print()
        state.streaming = False
    print(text)


def _format_args(args: Any, limit: int = 180) -> str:
    try:
        payload = json.dumps(args, ensure_ascii=False)
    except TypeError:
        payload = str(args)
    if len(payload) > limit:
        return payload[:limit] + "...(truncated)"
    return payload


async def _handle_interrupt(ws, state: ClientState, event: dict[str, Any]) -> None:
    request = event.get("request", {})
    action_requests = request.get("action_requests", [])
    decisions = []
    for action in action_requests:
        name = action.get("name", "tool")
        desc = action.get("description") or name
        args = action.get("args", {})
        _print_line(state, f"[interrupt] {desc} args={_format_args(args)}")
        while True:
            choice = await asyncio.to_thread(input, "Approve? (y/n): ")
            choice = choice.strip().lower()
            if choice in {"y", "yes"}:
                decisions.append({"type": "approve"})
                break
            if choice in {"n", "no"}:
                decisions.append({"type": "reject", "message": "User rejected the action"})
                break
            _print_line(state, "Please answer y or n.")

    response = {"decisions": decisions}
    await ws.send(
        json.dumps(
            {
                "type": "interrupt_response",
                "run_id": event.get("run_id"),
                "interrupt_id": event.get("interrupt_id"),
                "response": response,
            }
        )
    )


async def _event_listener(ws, state: ClientState) -> None:
    async for raw in ws:
        event = json.loads(raw)
        event_type = event.get("type")

        if event_type == "assistant.delta":
            text = event.get("text", "")
            if text:
                print(text, end="", flush=True)
                state.streaming = True
            continue

        if event_type == "run.started":
            state.current_run_id = event.get("run_id")
            _print_line(state, f"[run] started {state.current_run_id}")
            continue

        if event_type in {"run.completed", "run.failed", "run.cancelled", "run.rejected"}:
            run_id = event.get("run_id")
            status = event_type.split(".")[-1]
            suffix = ""
            if event_type == "run.failed" and event.get("error"):
                suffix = f" error={event.get('error')}"
            _print_line(state, f"[run] {status} {run_id}{suffix}")
            if run_id == state.current_run_id:
                state.current_run_id = None
            continue

        if event_type == "run.queued":
            _print_line(state, f"[run] queued {event.get('run_id')}")
            continue

        if event_type == "tool.call.started":
            tool_name = event.get("tool_name")
            args = event.get("args")
            _print_line(state, f"[tool] {tool_name} args={_format_args(args)}")
            continue

        if event_type == "tool.call.ended":
            tool_name = event.get("tool_name")
            status = event.get("status")
            preview = event.get("content_preview")
            suffix = f" preview={_format_args(preview)}" if preview else ""
            _print_line(state, f"[tool] {tool_name} {status}{suffix}")
            continue

        if event_type == "file.op":
            status = event.get("status")
            path = event.get("path")
            tool = event.get("tool_name")
            _print_line(state, f"[file] {tool} {status} {path}")
            diff = event.get("diff")
            if diff:
                _print_line(state, diff)
            continue

        if event_type == "todos.updated":
            _print_line(state, f"[todos] {event.get('todos')}")
            continue

        if event_type == "interrupt.request":
            _print_line(state, "[interrupt] approval required")
            state.pending_interrupts.append(event)
            continue

        if event_type == "interrupt.auto_approved":
            _print_line(state, "[interrupt] auto-approved")
            continue

        if event_type == "session.auto_approve":
            enabled = event.get("enabled")
            _print_line(state, f"[session] auto_approve={enabled}")
            continue

        if event_type == "log":
            level = event.get("level", "info")
            message = event.get("message", "")
            _print_line(state, f"[{level}] {message}")
            continue

        _print_line(state, f"[event] {event_type}: {event}")


async def _input_loop(ws, state: ClientState) -> None:
    _print_line(
        state,
        "Commands: /cancel, /auto on|off, /exit. Send any other text to run a task.",
    )
    while not state.stopping:
        if state.pending_interrupts:
            event = state.pending_interrupts.pop(0)
            await _handle_interrupt(ws, state, event)
            continue

        user_input = await asyncio.to_thread(input, ">> ")
        if user_input is None:
            continue
        user_input = user_input.strip()
        if not user_input:
            continue

        if user_input.startswith("/"):
            parts = user_input[1:].split()
            command = parts[0] if parts else ""
            if command in {"exit", "quit"}:
                state.stopping = True
                break
            if command == "cancel":
                await ws.send(json.dumps({"type": "cancel"}))
                continue
            if command == "auto":
                if len(parts) < 2 or parts[1] not in {"on", "off"}:
                    _print_line(state, "Usage: /auto on|off")
                    continue
                enabled = parts[1] == "on"
                await ws.send(json.dumps({"type": "auto_approve", "enabled": enabled}))
                continue
            _print_line(state, f"Unknown command: {command}")
            continue

        await ws.send(json.dumps({"type": "run", "input": user_input}))


def _create_session(server_url: str, assistant_id: str | None) -> str:
    payload = {"assistant_id": assistant_id}
    response = requests.post(f"{server_url}/sessions", json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    session_id = data.get("session_id")
    if not session_id:
        raise RuntimeError("Server did not return session_id")
    return session_id


def _build_ws_url(server_url: str, session_id: str) -> str:
    if server_url.startswith("https://"):
        ws_base = "wss://" + server_url[len("https://") :]
    elif server_url.startswith("http://"):
        ws_base = "ws://" + server_url[len("http://") :]
    else:
        ws_base = "ws://" + server_url
    return f"{ws_base}/ws/{session_id}"


async def main() -> None:
    parser = argparse.ArgumentParser(description="DeepAgents client")
    parser.add_argument("--server", default="http://127.0.0.1:8000")
    parser.add_argument("--assistant-id", default="agent")
    args = parser.parse_args()

    server_url = args.server.rstrip("/")
    session_id = _create_session(server_url, args.assistant_id)
    ws_url = _build_ws_url(server_url, session_id)

    print(f"Connected session: {session_id}")
    async with websockets.connect(ws_url) as ws:
        state = ClientState(session_id=session_id)
        listener_task = asyncio.create_task(_event_listener(ws, state))
        input_task = asyncio.create_task(_input_loop(ws, state))
        done, pending = await asyncio.wait(
            {listener_task, input_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            if task.exception():
                raise task.exception()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
