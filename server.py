from __future__ import annotations

import asyncio
import json
import re
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "libs" / "deepagents-cli"))
sys.path.insert(0, str(ROOT / "libs" / "deepagents"))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, TypeAdapter, ValidationError
from langchain.agents.middleware.human_in_the_loop import HITLRequest, HITLResponse
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.types import Command, Interrupt

from fastapi.middleware.cors import CORSMiddleware
import logging

from deepagents_cli.agent import create_cli_agent
from deepagents_cli.config import SessionState, create_model, settings
from deepagents_cli.file_ops import FileOpTracker
from deepagents_cli.tools import fetch_url, http_request, web_search

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_HITL_REQUEST_ADAPTER = TypeAdapter(HITLRequest)


class CreateSessionRequest(BaseModel):
    assistant_id: str | None = None
    auto_approve: bool = False


class CreateSessionResponse(BaseModel):
    session_id: str


@dataclass
class RunRequest:
    run_id: str
    user_input: str
    auto_approve: bool | None = None
    created_at: float = field(default_factory=time.time)


@dataclass
class RunExecution:
    run_id: str
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    interrupt_waiters: dict[str, asyncio.Future[HITLResponse]] = field(default_factory=dict)

    def register_interrupt(self, interrupt_id: str) -> asyncio.Future[HITLResponse]:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[HITLResponse] = loop.create_future()
        self.interrupt_waiters[interrupt_id] = future
        return future

    def resolve_interrupt(self, interrupt_id: str, response: HITLResponse) -> bool:
        future = self.interrupt_waiters.get(interrupt_id)
        if future is None or future.done():
            return False
        future.set_result(response)
        return True

    def cancel_pending(self) -> None:
        for future in self.interrupt_waiters.values():
            if not future.done():
                future.cancel()


@dataclass
class Session:
    session_id: str
    assistant_id: str
    session_state: SessionState
    agent: Any
    backend: Any
    run_queue: asyncio.Queue[RunRequest] = field(default_factory=asyncio.Queue)
    connections: set[WebSocket] = field(default_factory=set)
    current_run: RunExecution | None = None
    current_task: asyncio.Task | None = None
    worker_task: asyncio.Task | None = None

    async def start(self) -> None:
        if self.worker_task is None:
            self.worker_task = asyncio.create_task(self._run_worker())

    async def _run_worker(self) -> None:
        while True:
            run_request = await self.run_queue.get()
            run_task = asyncio.create_task(self._execute_run(run_request))
            self.current_task = run_task
            try:
                await run_task
            except asyncio.CancelledError:
                worker_task = asyncio.current_task()
                if worker_task is not None and worker_task.cancelling():
                    raise
            except Exception as exc:
                await self.broadcast(
                    {
                        "type": "run.failed",
                        "run_id": run_request.run_id,
                        "error": str(exc),
                    }
                )
            finally:
                self.current_task = None
                self.run_queue.task_done()

    async def enqueue_run(self, run_request: RunRequest) -> None:
        await self.run_queue.put(run_request)
        await self.broadcast(
            {"type": "run.queued", "run_id": run_request.run_id, "session_id": self.session_id}
        )

    async def cancel_current_run(self) -> bool:
        if self.current_run is None or self.current_task is None:
            return False
        self.current_run.cancel_event.set()
        self.current_task.cancel()
        await self.broadcast(
            {
                "type": "run.cancelled",
                "run_id": self.current_run.run_id,
                "session_id": self.session_id,
            }
        )
        return True

    async def broadcast(self, event: dict[str, Any]) -> None:
        if not self.connections:
            return
        message = json.dumps(event, ensure_ascii=False)
        stale: list[WebSocket] = []
        for ws in list(self.connections):
            try:
                await ws.send_text(message)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.connections.discard(ws)

    async def _execute_run(self, run_request: RunRequest) -> None:
        run_ctx = RunExecution(run_id=run_request.run_id)
        self.current_run = run_ctx
        await self.broadcast(
            {"type": "run.started", "run_id": run_request.run_id, "session_id": self.session_id}
        )

        prompt_text, warnings = _inject_file_context(run_request.user_input)
        for warning in warnings:
            await self.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "run_id": run_request.run_id,
                    "message": warning,
                }
            )

        stream_input: dict[str, Any] | Command = {
            "messages": [{"role": "user", "content": prompt_text}]
        }
        auto_approve = (
            run_request.auto_approve
            if run_request.auto_approve is not None
            else self.session_state.auto_approve
        )

        config = {
            "configurable": {"thread_id": self.session_state.thread_id},
            "metadata": {"assistant_id": self.assistant_id},
        }

        file_op_tracker = FileOpTracker(assistant_id=self.assistant_id, backend=self.backend)
        tool_call_buffers: dict[str | int, dict[str, Any]] = {}
        displayed_tool_ids: set[str] = set()

        try:
            while True:
                interrupt_occurred = False
                pending_interrupts: dict[str, HITLRequest] = {}
                hitl_response: dict[str, HITLResponse] = {}

                async for chunk in self.agent.astream(
                    stream_input,
                    stream_mode=["messages", "updates"],
                    subgraphs=True,
                    config=config,
                    durability="exit",
                ):
                    if run_ctx.cancel_event.is_set():
                        raise asyncio.CancelledError()

                    if not isinstance(chunk, tuple) or len(chunk) != 3:
                        continue

                    _namespace, current_stream_mode, data = chunk

                    if current_stream_mode == "updates":
                        if not isinstance(data, dict):
                            continue
                        if "__interrupt__" in data:
                            interrupts: list[Interrupt] = data["__interrupt__"]
                            for interrupt_obj in interrupts:
                                try:
                                    validated = _HITL_REQUEST_ADAPTER.validate_python(
                                        interrupt_obj.value
                                    )
                                    pending_interrupts[interrupt_obj.id] = validated
                                    interrupt_occurred = True
                                except ValidationError:
                                    await self.broadcast(
                                        {
                                            "type": "log",
                                            "level": "error",
                                            "run_id": run_request.run_id,
                                            "message": "Invalid interrupt payload received.",
                                        }
                                    )
                        chunk_data = next(iter(data.values())) if data else None
                        if isinstance(chunk_data, dict) and "todos" in chunk_data:
                            await self.broadcast(
                                {
                                    "type": "todos.updated",
                                    "run_id": run_request.run_id,
                                    "todos": chunk_data["todos"],
                                }
                            )

                    if current_stream_mode != "messages":
                        continue

                    if not isinstance(data, tuple) or len(data) != 2:
                        continue

                    message, _metadata = data

                    if isinstance(message, HumanMessage):
                        if message.text:
                            await self.broadcast(
                                {
                                    "type": "assistant.message",
                                    "run_id": run_request.run_id,
                                    "text": message.text,
                                }
                            )
                        continue

                    if isinstance(message, ToolMessage):
                        tool_name = getattr(message, "name", "") or "tool"
                        tool_status = getattr(message, "status", "success")
                        tool_content = _format_tool_content(message.content)
                        record = file_op_tracker.complete_with_message(message)

                        if record is not None:
                            await self.broadcast(
                                {
                                    "type": "file.op",
                                    "run_id": run_request.run_id,
                                    "tool_name": record.tool_name,
                                    "path": record.display_path,
                                    "status": record.status,
                                    "error": record.error,
                                    "metrics": {
                                        "lines_read": record.metrics.lines_read,
                                        "lines_written": record.metrics.lines_written,
                                        "lines_added": record.metrics.lines_added,
                                        "lines_removed": record.metrics.lines_removed,
                                        "bytes_written": record.metrics.bytes_written,
                                    },
                                    "diff": record.diff,
                                }
                            )

                        await self.broadcast(
                            {
                                "type": "tool.call.ended",
                                "run_id": run_request.run_id,
                                "tool_name": tool_name,
                                "status": tool_status,
                                "tool_call_id": getattr(message, "tool_call_id", None),
                                "content_preview": tool_content,
                            }
                        )
                        continue

                    if not hasattr(message, "content_blocks"):
                        text_content = getattr(message, "content", None)
                        if isinstance(text_content, str) and text_content:
                            await self.broadcast(
                                {
                                    "type": "assistant.delta",
                                    "run_id": run_request.run_id,
                                    "text": text_content,
                                }
                            )
                        continue

                    for block in message.content_blocks:
                        block_type = block.get("type")
                        if block_type == "text":
                            text = block.get("text", "")
                            if text:
                                await self.broadcast(
                                    {
                                        "type": "assistant.delta",
                                        "run_id": run_request.run_id,
                                        "text": text,
                                    }
                                )
                        elif block_type in ("tool_call_chunk", "tool_call"):
                            await _handle_tool_call_block(
                                block,
                                tool_call_buffers,
                                displayed_tool_ids,
                                file_op_tracker,
                                run_request.run_id,
                                self,
                            )

                if interrupt_occurred:
                    for interrupt_id, hitl_request in pending_interrupts.items():
                        if auto_approve:
                            decisions = [
                                {"type": "approve"}
                                for _ in hitl_request.get("action_requests", [])
                            ]
                            hitl_response[interrupt_id] = {"decisions": decisions}
                            await self.broadcast(
                                {
                                    "type": "interrupt.auto_approved",
                                    "run_id": run_request.run_id,
                                    "interrupt_id": interrupt_id,
                                }
                            )
                            continue

                        waiter = run_ctx.register_interrupt(interrupt_id)
                        await self.broadcast(
                            {
                                "type": "interrupt.request",
                                "run_id": run_request.run_id,
                                "interrupt_id": interrupt_id,
                                "request": hitl_request,
                            }
                        )
                        response = await waiter
                        hitl_response[interrupt_id] = response

                    if any(
                        decision.get("type") == "reject"
                        for response in hitl_response.values()
                        for decision in response.get("decisions", [])
                    ):
                        await self.broadcast(
                            {
                                "type": "run.rejected",
                                "run_id": run_request.run_id,
                                "session_id": self.session_id,
                            }
                        )
                        return

                    stream_input = Command(resume=hitl_response)
                    continue

                break

            await self.broadcast(
                {"type": "run.completed", "run_id": run_request.run_id, "session_id": self.session_id}
            )
        except asyncio.CancelledError:
            await self._update_cancelled_state(config)
            raise
        finally:
            run_ctx.cancel_pending()
            self.current_run = None

    async def _update_cancelled_state(self, config: dict[str, Any]) -> None:
        try:
            await self.agent.aupdate_state(
                config=config,
                values={
                    "messages": [
                        HumanMessage(content="[The previous request was cancelled by the system]")
                    ]
                },
            )
        except Exception:
            await self.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "message": "Failed to update agent state after cancellation.",
                }
            )


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()

    async def create_session(self, assistant_id: str | None, auto_approve: bool) -> Session:
        session_id = uuid.uuid4().hex
        model = create_model()
        tools = [http_request, fetch_url]
        logger.info(f"settings.has_tavily = {settings.has_tavily}, tavily_api_key = {settings.tavily_api_key[:10] if settings.tavily_api_key else None}...")
        if settings.has_tavily:
            tools.append(web_search)
            logger.info(f"web_search tool added, total tools: {[t.__name__ for t in tools]}")
        else:
            logger.warning("Tavily API key not configured, web_search disabled")

        session_state = SessionState(auto_approve=auto_approve)
        agent, backend = create_cli_agent(
            model=model,
            assistant_id=assistant_id or "agent",
            tools=tools,
            auto_approve=False,
        )
        session = Session(
            session_id=session_id,
            assistant_id=assistant_id or "agent",
            session_state=session_state,
            agent=agent,
            backend=backend,
        )
        await session.start()
        async with self._lock:
            self._sessions[session_id] = session
        return session

    async def get_session(self, session_id: str) -> Session | None:
        async with self._lock:
            return self._sessions.get(session_id)


app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = SessionManager()


@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session(req: CreateSessionRequest) -> CreateSessionResponse:
    session = await manager.create_session(req.assistant_id, req.auto_approve)
    return CreateSessionResponse(session_id=session.session_id)


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    session = await manager.get_session(session_id)
    if session is None:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    session.connections.add(websocket)
    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            await _handle_client_message(session, data)
    except WebSocketDisconnect:
        session.connections.discard(websocket)
    except Exception:
        session.connections.discard(websocket)
        await websocket.close(code=1011)


async def _handle_client_message(session: Session, data: dict[str, Any]) -> None:
    msg_type = data.get("type")
    if msg_type == "run":
        user_input = str(data.get("input", "")).strip()
        if not user_input:
            await session.broadcast(
                {"type": "log", "level": "warning", "message": "Empty input ignored."}
            )
            return
        run_request = RunRequest(
            run_id=data.get("run_id") or uuid.uuid4().hex,
            user_input=user_input,
            auto_approve=data.get("auto_approve"),
        )
        await session.enqueue_run(run_request)
        return

    if msg_type == "cancel":
        cancelled = await session.cancel_current_run()
        if not cancelled:
            await session.broadcast(
                {"type": "log", "level": "warning", "message": "No active run to cancel."}
            )
        return

    if msg_type == "interrupt_response":
        run_id = data.get("run_id")
        interrupt_id = data.get("interrupt_id")
        response = data.get("response")
        if not run_id or not interrupt_id or not response:
            await session.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "message": "Invalid interrupt response payload.",
                }
            )
            return
        if session.current_run is None or session.current_run.run_id != run_id:
            await session.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "message": "Interrupt response does not match active run.",
                }
            )
            return
        resolved = session.current_run.resolve_interrupt(interrupt_id, response)
        if not resolved:
            await session.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "message": "Interrupt response already handled.",
                }
            )
        return

    if msg_type == "auto_approve":
        enabled = bool(data.get("enabled"))
        session.session_state.auto_approve = enabled
        await session.broadcast({"type": "session.auto_approve", "enabled": enabled})
        return

    await session.broadcast(
        {"type": "log", "level": "warning", "message": f"Unknown message type: {msg_type}"}
    )


def _inject_file_context(user_input: str) -> tuple[str, list[str]]:
    pattern = r"@((?:[^\s@]|(?<=\\)\s)+)"
    matches = re.findall(pattern, user_input)
    warnings: list[str] = []
    if not matches:
        return user_input, warnings
    context_parts = [user_input, "\n\n## Referenced Files\n"]
    for match in matches:
        clean_path = match.replace("\\ ", " ")
        path = Path(clean_path).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        try:
            path = path.resolve()
        except Exception as exc:
            warnings.append(f"Invalid path {match}: {exc}")
            continue
        if not path.exists() or not path.is_file():
            warnings.append(f"File not found: {match}")
            continue
        try:
            content = path.read_text()
        except Exception as exc:
            warnings.append(f"Failed to read {match}: {exc}")
            continue
        if len(content) > 50000:
            content = content[:50000] + "\n... (file truncated)"
        context_parts.append(f"\n### {path.name}\nPath: `{path}`\n```\n{content}\n```")
    return "\n".join(context_parts), warnings


def _format_tool_content(content: Any, limit: int = 400) -> str:
    if content is None:
        return ""
    if isinstance(content, list):
        content = "\n".join(str(item) for item in content)
    if not isinstance(content, str):
        content = str(content)
    if len(content) > limit:
        return content[:limit] + "...(truncated)"
    return content


async def _handle_tool_call_block(
    block: dict[str, Any],
    tool_call_buffers: dict[str | int, dict[str, Any]],
    displayed_tool_ids: set[str],
    file_op_tracker: FileOpTracker,
    run_id: str,
    session: Session,
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
