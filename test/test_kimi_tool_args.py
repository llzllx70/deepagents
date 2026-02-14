from __future__ import annotations

import asyncio

from server.tool_stream import handle_tool_call_block


class _DummyFileOpTracker:
    def __init__(self) -> None:
        self.started: list[tuple[str, dict[str, object], str | None]] = []
        self.updated: list[tuple[str, dict[str, object]]] = []

    def start_operation(self, name: str, args: dict[str, object], tool_call_id: str | None) -> None:
        self.started.append((name, args, tool_call_id))

    def update_args(self, tool_call_id: str, args: dict[str, object]) -> None:
        self.updated.append((tool_call_id, args))


class _DummySession:
    def __init__(self) -> None:
        self.session_id = "session-test"
        self.messages: list[dict[str, object]] = []

    async def broadcast(self, payload: dict[str, object]) -> None:
        self.messages.append(payload)


def test_kimi_double_encoded_tool_args_are_parsed() -> None:
    tool_call_buffers: dict[str | int, dict[str, object]] = {}
    displayed_tool_ids: set[str] = set()
    tracker = _DummyFileOpTracker()
    session = _DummySession()

    asyncio.run(
        handle_tool_call_block(
            {
                "name": "execute",
                "id": "call_1",
                "args": "\"{\\\"command\\\": \\\"ls -la\\\"}\"",
            },
            tool_call_buffers,
            displayed_tool_ids,
            tracker,
            "run_1",
            session,
        )
    )

    assert session.messages, "Expected a tool.call.started broadcast"
    message = session.messages[-1]
    assert message["type"] == "tool.call.started"
    assert message["tool_name"] == "execute"
    assert message["args"] == {"command": "ls -la"}
    assert message["display_content"] == "ls -la"


def test_kimi_chunked_tool_args_are_assembled() -> None:
    tool_call_buffers: dict[str | int, dict[str, object]] = {}
    displayed_tool_ids: set[str] = set()
    tracker = _DummyFileOpTracker()
    session = _DummySession()

    asyncio.run(
        handle_tool_call_block(
            {
                "name": "execute",
                "id": "call_2",
                "index": 0,
                "args": "\"{\\\"command\\\": \\\"ls -la",
            },
            tool_call_buffers,
            displayed_tool_ids,
            tracker,
            "run_2",
            session,
        )
    )
    assert not session.messages, "First chunk should not emit a tool call"

    asyncio.run(
        handle_tool_call_block(
            {
                "name": "execute",
                "id": "call_2",
                "index": 0,
                "args": "\\\"}\"",
            },
            tool_call_buffers,
            displayed_tool_ids,
            tracker,
            "run_2",
            session,
        )
    )

    assert session.messages, "Expected a tool.call.started broadcast after final chunk"
    message = session.messages[-1]
    assert message["type"] == "tool.call.started"
    assert message["tool_name"] == "execute"
    assert message["args"] == {"command": "ls -la"}
    assert message["display_content"] == "ls -la"


def test_kimi_cumulative_chunked_tool_args_are_assembled() -> None:
    tool_call_buffers: dict[str | int, dict[str, object]] = {}
    displayed_tool_ids: set[str] = set()
    tracker = _DummyFileOpTracker()
    session = _DummySession()

    asyncio.run(
        handle_tool_call_block(
            {
                "name": "execute",
                "id": "call_3",
                "index": 0,
                "args": "\"{\\\"command\\\": \\\"l",
            },
            tool_call_buffers,
            displayed_tool_ids,
            tracker,
            "run_3",
            session,
        )
    )
    assert not session.messages, "First cumulative chunk should not emit a tool call"

    asyncio.run(
        handle_tool_call_block(
            {
                "name": "execute",
                "id": "call_3",
                "index": 0,
                "args": "\"{\\\"command\\\": \\\"ls\\\"}\"",
            },
            tool_call_buffers,
            displayed_tool_ids,
            tracker,
            "run_3",
            session,
        )
    )

    assert session.messages, "Expected a tool.call.started broadcast after cumulative chunk"
    message = session.messages[-1]
    assert message["type"] == "tool.call.started"
    assert message["tool_name"] == "execute"
    assert message["args"] == {"command": "ls"}
    assert message["display_content"] == "ls"


def test_tool_call_block_accepts_arguments_key() -> None:
    tool_call_buffers: dict[str | int, dict[str, object]] = {}
    displayed_tool_ids: set[str] = set()
    tracker = _DummyFileOpTracker()
    session = _DummySession()

    asyncio.run(
        handle_tool_call_block(
            {
                "tool_name": "read_file",
                "tool_call_id": "call_4",
                "arguments": "{\"file_path\": \"/skills/stock-master/SKILL.md\"}",
            },
            tool_call_buffers,
            displayed_tool_ids,
            tracker,
            "run_4",
            session,
        )
    )

    assert session.messages, "Expected a tool.call.started broadcast"
    message = session.messages[-1]
    assert message["type"] == "tool.call.started"
    assert message["tool_name"] == "read_file"
    assert message["args"] == {"file_path": "/skills/stock-master/SKILL.md"}


def test_tool_call_block_prefers_arguments_when_args_empty() -> None:
    tool_call_buffers: dict[str | int, dict[str, object]] = {}
    displayed_tool_ids: set[str] = set()
    tracker = _DummyFileOpTracker()
    session = _DummySession()

    asyncio.run(
        handle_tool_call_block(
            {
                "tool_name": "read_file",
                "tool_call_id": "call_5",
                "args": {},
                "arguments": "{\"file_path\": \"/skills/stock-master/SKILL.md\"}",
            },
            tool_call_buffers,
            displayed_tool_ids,
            tracker,
            "run_5",
            session,
        )
    )

    assert session.messages, "Expected a tool.call.started broadcast"
    message = session.messages[-1]
    assert message["type"] == "tool.call.started"
    assert message["tool_name"] == "read_file"
    assert message["args"] == {"file_path": "/skills/stock-master/SKILL.md"}


def test_read_file_display_includes_offset_limit_range() -> None:
    tool_call_buffers: dict[str | int, dict[str, object]] = {}
    displayed_tool_ids: set[str] = set()
    tracker = _DummyFileOpTracker()
    session = _DummySession()

    asyncio.run(
        handle_tool_call_block(
            {
                "tool_name": "read_file",
                "tool_call_id": "call_6",
                "arguments": "{\"file_path\": \"/skills/stock-master/SKILL.md\", \"offset\": 2000, \"limit\": 2000}",
            },
            tool_call_buffers,
            displayed_tool_ids,
            tracker,
            "run_6",
            session,
        )
    )

    assert session.messages, "Expected a tool.call.started broadcast"
    message = session.messages[-1]
    assert message["tool_name"] == "read_file"
    assert message["display_content"] == "/skills/stock-master/SKILL.md (范围 2000-3999)"


def test_read_file_display_includes_line_range() -> None:
    tool_call_buffers: dict[str | int, dict[str, object]] = {}
    displayed_tool_ids: set[str] = set()
    tracker = _DummyFileOpTracker()
    session = _DummySession()

    asyncio.run(
        handle_tool_call_block(
            {
                "tool_name": "read_file",
                "tool_call_id": "call_7",
                "arguments": "{\"file_path\": \"/skills/stock-master/SKILL.md\", \"start_line\": 10, \"end_line\": 20}",
            },
            tool_call_buffers,
            displayed_tool_ids,
            tracker,
            "run_7",
            session,
        )
    )

    assert session.messages, "Expected a tool.call.started broadcast"
    message = session.messages[-1]
    assert message["tool_name"] == "read_file"
    assert message["display_content"] == "/skills/stock-master/SKILL.md (范围 10-20)"
