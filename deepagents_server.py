from __future__ import annotations

import asyncio
import json
import re
import sys
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
WORKSPACE_DIR = ROOT / "workspace"
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
HISTORY_PATH = DATA_DIR / "chat_history.json"
SESSION_STATE_PATH = DATA_DIR / "session_state.json"
_HISTORY_LOCK = asyncio.Lock()
_SESSION_STATE_LOCK = asyncio.Lock()
sys.path.insert(0, str(ROOT / "libs" / "deepagents-cli"))
sys.path.insert(0, str(ROOT / "libs" / "deepagents"))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, TypeAdapter, ValidationError
from langchain.agents.middleware.human_in_the_loop import HITLRequest, HITLResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command, Interrupt

from fastapi.middleware.cors import CORSMiddleware
import logging

from deepagents_cli.agent import create_cli_agent
from deepagents_cli.config import SessionState, create_model, settings
from deepagents_cli.file_ops import FileOpTracker
from deepagents_cli.integrations.docker import DockerSandboxBackend
from deepagents_cli.integrations.docker_pool import DockerPoolConfig, DockerSandboxPool
from deepagents_cli.tools import fetch_url, http_request, web_search

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(filename)s:%(lineno)d - %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "server.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)
client_logger = logging.getLogger("deepagents.web")
client_logger.setLevel(logging.INFO)
client_logger.propagate = False
if not any(isinstance(handler, logging.FileHandler) for handler in client_logger.handlers):
    _client_handler = logging.FileHandler(LOG_DIR / "web.log", encoding="utf-8")
    _client_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(filename)s:%(lineno)d - %(message)s")
    )
    client_logger.addHandler(_client_handler)

_HITL_REQUEST_ADAPTER = TypeAdapter(HITLRequest)


class CreateSessionRequest(BaseModel):
    assistant_id: str | None = None
    auto_approve: bool = False


class CreateSessionResponse(BaseModel):
    session_id: str
    sandbox_id: str | None = None
    workspace_dir: str | None = None


class DeleteSessionResponse(BaseModel):
    session_id: str
    sandbox_id: str | None = None
    synced: bool
    workspace_dir: str | None = None


class ClientLogRequest(BaseModel):
    event: str
    detail: dict[str, Any] | None = None
    level: str | None = None
    session_id: str | None = None
    ts: float | None = None


class HistoryPayload(BaseModel):
    history: list[dict[str, Any]]


class SessionStatePayload(BaseModel):
    session_id: str | None = None
    has_messages: bool = False
    timestamp: float | None = None


def _is_root_namespace(namespace: object) -> bool:
    if namespace is None:
        return True
    if isinstance(namespace, (tuple, list)):
        return len(namespace) == 0
    if isinstance(namespace, str):
        return namespace == ""
    return False


def _truncate_for_log(text: str, limit: int = 2000) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...(truncated)"


async def _read_json_file(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        raw = await asyncio.to_thread(path.read_text, encoding="utf-8")
    except OSError:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def _write_json_file(path: Path, payload: Any) -> None:
    serialized = json.dumps(payload, ensure_ascii=False, indent=2)
    await asyncio.to_thread(path.write_text, serialized, encoding="utf-8")


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
    sandbox_backend: DockerSandboxBackend
    workspace_dir: Path
    run_queue: asyncio.Queue[RunRequest] = field(default_factory=asyncio.Queue)
    run_status: dict[str, str] = field(default_factory=dict)
    connections: set[WebSocket] = field(default_factory=set)
    current_run: RunExecution | None = None
    current_task: asyncio.Task | None = None
    worker_task: asyncio.Task | None = None

    async def shutdown(self) -> None:
        if self.current_run is not None:
            await self.cancel_current_run()
        if self.worker_task is not None:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except asyncio.CancelledError:
                pass
        for ws in list(self.connections):
            try:
                await ws.close(code=1000)
            except Exception:
                pass
        self.connections.clear()

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
                logger.exception(
                    "Run failed: session_id=%s run_id=%s error=%s",
                    self.session_id,
                    run_request.run_id,
                    exc,
                )
                self.run_status[run_request.run_id] = "failed"
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
        self.run_status[run_request.run_id] = "queued"
        logger.info(
            "Run queued: session_id=%s run_id=%s input_len=%s",
            self.session_id,
            run_request.run_id,
            len(run_request.user_input or ""),
        )
        await self.broadcast(
            {"type": "run.queued", "run_id": run_request.run_id, "session_id": self.session_id}
        )

    async def cancel_current_run(self) -> bool:
        if self.current_run is None or self.current_task is None:
            return False
        self.current_run.cancel_event.set()
        self.current_task.cancel()
        self.run_status[self.current_run.run_id] = "cancelled"
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
        self.run_status[run_request.run_id] = "running"
        logger.info("Run started: session_id=%s run_id=%s", self.session_id, run_request.run_id)
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
                    is_root = _is_root_namespace(_namespace)

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
                        if is_root and isinstance(chunk_data, dict) and "todos" in chunk_data:
                            await self.broadcast(
                                {
                                    "type": "todos.updated",
                                    "run_id": run_request.run_id,
                                    "todos": chunk_data["todos"],
                                }
                            )

                    if current_stream_mode != "messages":
                        continue
                    if not is_root:
                        continue

                    if not isinstance(data, tuple) or len(data) != 2:
                        continue

                    message, _metadata = data

                    if isinstance(message, HumanMessage):
                        continue

                    if isinstance(message, AIMessage):
                        text = _normalize_text_content(message.content)
                        if text:
                            logger.info(
                                "LLM message: session_id=%s run_id=%s text=%s",
                                self.session_id,
                                run_request.run_id,
                                _truncate_for_log(text),
                            )
                            await self.broadcast(
                                {
                                    "type": "assistant.message",
                                    "run_id": run_request.run_id,
                                    "text": text,
                                }
                            )

                        for tool_call in _extract_tool_calls(message):
                            if isinstance(tool_call, dict):
                                tool_name = tool_call.get("name")
                                tool_call_id = tool_call.get("id") or tool_call.get("tool_call_id")
                                raw_args = tool_call.get("args")
                                if tool_name is None and isinstance(tool_call.get("function"), dict):
                                    tool_name = tool_call["function"].get("name")
                                    raw_args = raw_args or tool_call["function"].get("arguments")
                                if not tool_name:
                                    continue
                                parsed_args = _parse_tool_args(raw_args)
                                if parsed_args is None:
                                    continue
                                await _emit_tool_call_started(
                                    session=self,
                                    run_id=run_request.run_id,
                                    tool_name=str(tool_name),
                                    tool_call_id=str(tool_call_id) if tool_call_id else None,
                                    args=parsed_args,
                                    file_op_tracker=file_op_tracker,
                                    displayed_tool_ids=displayed_tool_ids,
                                )
                        continue

                    if isinstance(message, ToolMessage):
                        tool_name = getattr(message, "name", "") or "tool"
                        tool_status = getattr(message, "status", "success")
                        tool_full_content = _normalize_text_content(message.content)
                        record = file_op_tracker.complete_with_message(message)

                        if record is not None:
                            content = ""
                            content_preview = ""
                            content_truncated = False
                            meta: dict[str, Any] = {}
                            if record.tool_name == "read_file" and record.read_output is not None:
                                raw_content = record.read_output
                                content, content_truncated = _truncate_text(raw_content, limit=50000)
                                content_preview, _preview_truncated = _truncate_text(raw_content, limit=6000)
                                if record.display_path.lower().endswith("skill.md"):
                                    skill_name = _extract_skill_name(raw_content)
                                    if skill_name:
                                        meta["skill_name"] = skill_name
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
                                    "content": content,
                                    "content_preview": content_preview,
                                    "content_truncated": content_truncated,
                                    "meta": meta,
                                }
                            )

                        preview_limit = 400
                        logger.info(
                            "Tool call ended: session_id=%s run_id=%s tool=%s status=%s",
                            self.session_id,
                            run_request.run_id,
                            tool_name,
                            tool_status,
                        )
                        await self.broadcast(
                            {
                                "type": "tool.call.ended",
                                "run_id": run_request.run_id,
                                "tool_name": tool_name,
                                "status": tool_status,
                                "tool_call_id": getattr(message, "tool_call_id", None),
                                "content": tool_full_content,
                                "content_preview": _format_tool_content(tool_full_content, limit=preview_limit),
                                "content_truncated": len(tool_full_content) > preview_limit,
                            }
                        )
                        continue

                    tool_call_chunks = getattr(message, "tool_call_chunks", None)
                    if isinstance(tool_call_chunks, list) and tool_call_chunks:
                        for chunk in tool_call_chunks:
                            if isinstance(chunk, dict):
                                await _handle_tool_call_block(
                                    chunk,
                                    tool_call_buffers,
                                    displayed_tool_ids,
                                    file_op_tracker,
                                    run_request.run_id,
                                    self,
                                )

                    if not hasattr(message, "content_blocks"):
                        text_content = getattr(message, "content", None)
                        if isinstance(text_content, str) and text_content:
                            logger.info(
                                "LLM delta: session_id=%s run_id=%s delta_len=%s",
                                self.session_id,
                                run_request.run_id,
                                len(text_content),
                            )
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
                                logger.info(
                                    "LLM delta: session_id=%s run_id=%s delta_len=%s",
                                    self.session_id,
                                    run_request.run_id,
                                    len(text),
                                )
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
                        self.run_status[run_request.run_id] = "rejected"
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

            self.run_status[run_request.run_id] = "completed"
            logger.info("Run completed: session_id=%s run_id=%s", self.session_id, run_request.run_id)
            await self.broadcast(
                {"type": "run.completed", "run_id": run_request.run_id, "session_id": self.session_id}
            )
        except asyncio.CancelledError:
            self.run_status[run_request.run_id] = "cancelled"
            logger.info("Run cancelled: session_id=%s run_id=%s", self.session_id, run_request.run_id)
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
    def __init__(self, pool: DockerSandboxPool) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()
        self._pool = pool
        self._active_session_id: str | None = None
        self._activation_lock = asyncio.Lock()

    async def activate_session(self, session_id: str) -> None:
        async with self._activation_lock:
            async with self._lock:
                target = self._sessions.get(session_id)
                sessions = list(self._sessions.values())
            if target is None:
                return
            to_pause = [session for session in sessions if session.session_id != session_id]
            if to_pause:
                await asyncio.gather(*(self._pause_session(session) for session in to_pause))
            await self._resume_session(target)
            async with self._lock:
                self._active_session_id = session_id

    async def deactivate_session(self, session_id: str) -> None:
        async with self._activation_lock:
            async with self._lock:
                if self._active_session_id != session_id:
                    return
                session = self._sessions.get(session_id)
            if session is None:
                async with self._lock:
                    if self._active_session_id == session_id:
                        self._active_session_id = None
                return
            await self._pause_session(session)
            async with self._lock:
                if self._active_session_id == session_id:
                    self._active_session_id = None

    async def _pause_session(self, session: Session) -> None:
        if not isinstance(session.sandbox_backend, DockerSandboxBackend):
            return
        try:
            await asyncio.to_thread(session.sandbox_backend.pause)
            logger.info(
                "Session sandbox paused: session_id=%s sandbox_id=%s",
                session.session_id,
                session.sandbox_backend.id,
            )
        except Exception as exc:
            logger.warning(
                "Failed to pause sandbox for %s: %s",
                session.session_id,
                exc,
            )

    async def _resume_session(self, session: Session) -> None:
        if not isinstance(session.sandbox_backend, DockerSandboxBackend):
            return
        try:
            await asyncio.to_thread(session.sandbox_backend.unpause)
            logger.info(
                "Session sandbox unpaused: session_id=%s sandbox_id=%s",
                session.session_id,
                session.sandbox_backend.id,
            )
        except Exception as exc:
            logger.warning(
                "Failed to unpause sandbox for %s: %s",
                session.session_id,
                exc,
            )

    async def create_session(self, assistant_id: str | None, auto_approve: bool) -> Session:
        logger.info("Creating session: assistant_id=%s auto_approve=%s", assistant_id, auto_approve)
        session_id = uuid.uuid4().hex
        workspace_dir = WORKSPACE_DIR / session_id
        workspace_dir.mkdir(parents=True, exist_ok=True)
        model = create_model()
        tools = [http_request, fetch_url]
        logger.info(f"settings.has_tavily = {settings.has_tavily}, tavily_api_key = {settings.tavily_api_key[:10] if settings.tavily_api_key else None}...")
        if settings.has_tavily:
            tools.append(web_search)
            logger.info(f"web_search tool added, total tools: {[t.__name__ for t in tools]}")
        else:
            logger.warning("Tavily API key not configured, web_search disabled")

        session_state = SessionState(auto_approve=auto_approve)
        sandbox_backend = await self._pool.acquire_for_session(session_id)
        logger.info(
            "Session sandbox acquired: session_id=%s sandbox_id=%s",
            session_id,
            sandbox_backend.id,
        )
        agent, backend = create_cli_agent(
            model=model,
            assistant_id=assistant_id or "agent",
            tools=tools,
            sandbox=sandbox_backend,
            sandbox_type="docker",
            auto_approve=False,
        )
        session = Session(
            session_id=session_id,
            assistant_id=assistant_id or "agent",
            session_state=session_state,
            agent=agent,
            backend=backend,
            sandbox_backend=sandbox_backend,
            workspace_dir=workspace_dir,
        )
        await session.start()
        async with self._lock:
            self._sessions[session_id] = session
        logger.info("Session created: session_id=%s", session_id)
        return session

    async def get_session(self, session_id: str) -> Session | None:
        async with self._lock:
            return self._sessions.get(session_id)

    async def delete_session(self, session_id: str) -> tuple[Session | None, bool]:
        session: Session | None = None
        logger.info("Deleting session: session_id=%s", session_id)
        async with self._lock:
            session = self._sessions.pop(session_id, None)
            if self._active_session_id == session_id:
                self._active_session_id = None
        if session is None:
            return None, False

        synced = False
        try:
            await session.shutdown()
            if isinstance(session.sandbox_backend, DockerSandboxBackend):
                await self._pool.sync_workspace(
                    session.sandbox_backend, session.workspace_dir
                )
                synced = True
        except Exception as exc:
            logger.warning("Failed to sync workspace for %s: %s", session_id, exc)
        finally:
            if isinstance(session.sandbox_backend, DockerSandboxBackend):
                await self._pool.remove(session.sandbox_backend)
        logger.info("Session deleted: session_id=%s synced=%s", session_id, synced)
        return session, synced

    async def shutdown(self) -> None:
        async with self._lock:
            session_ids = list(self._sessions.keys())
        for session_id in session_ids:
            await self.delete_session(session_id)


docker_pool: DockerSandboxPool | None = None
manager: SessionManager | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global docker_pool, manager
    pool_config = DockerPoolConfig.from_env()
    logger.info("Lifespan startup: docker pool config=%s", pool_config)
    docker_pool = DockerSandboxPool(pool_config)
    await docker_pool.start()
    manager = SessionManager(docker_pool)
    try:
        yield
    finally:
        if manager is not None:
            await manager.shutdown()
        if docker_pool is not None:
            await docker_pool.shutdown()
        logger.info("Lifespan shutdown complete")


app = FastAPI(lifespan=lifespan)
app.mount("/files", StaticFiles(directory=WORKSPACE_DIR), name="files")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session(req: CreateSessionRequest) -> CreateSessionResponse:
    if manager is None:
        raise HTTPException(status_code=503, detail="Session manager unavailable")
    logger.info("Create session request: assistant_id=%s auto_approve=%s", req.assistant_id, req.auto_approve)
    session = await manager.create_session(req.assistant_id, req.auto_approve)
    try:
        workspace_dir = str(session.workspace_dir.relative_to(ROOT))
    except ValueError:
        workspace_dir = str(session.workspace_dir)
    return CreateSessionResponse(
        session_id=session.session_id,
        sandbox_id=session.sandbox_backend.id,
        workspace_dir=workspace_dir,
    )


@app.delete("/sessions/{session_id}", response_model=DeleteSessionResponse)
async def delete_session(session_id: str) -> DeleteSessionResponse:
    if manager is None:
        raise HTTPException(status_code=503, detail="Session manager unavailable")
    session, synced = await manager.delete_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        workspace_dir = str(session.workspace_dir.relative_to(ROOT))
    except ValueError:
        workspace_dir = str(session.workspace_dir)
    return DeleteSessionResponse(
        session_id=session.session_id,
        sandbox_id=session.sandbox_backend.id,
        synced=synced,
        workspace_dir=workspace_dir,
    )


@app.get("/history")
async def get_history() -> dict[str, Any]:
    async with _HISTORY_LOCK:
        payload = await _read_json_file(HISTORY_PATH)
    if not isinstance(payload, list):
        payload = []
    return {"history": payload}


@app.put("/history")
async def save_history(payload: HistoryPayload) -> dict[str, str]:
    async with _HISTORY_LOCK:
        await _write_json_file(HISTORY_PATH, payload.history)
    return {"status": "ok"}


@app.get("/session_state")
async def get_session_state() -> dict[str, Any]:
    async with _SESSION_STATE_LOCK:
        payload = await _read_json_file(SESSION_STATE_PATH)
    if not isinstance(payload, dict):
        payload = {}
    return payload


@app.put("/session_state")
async def save_session_state(payload: SessionStatePayload) -> dict[str, str]:
    data = payload.model_dump()
    if data.get("timestamp") is None:
        data["timestamp"] = time.time()
    async with _SESSION_STATE_LOCK:
        await _write_json_file(SESSION_STATE_PATH, data)
    return {"status": "ok"}


@app.post("/client_logs")
async def client_logs(req: ClientLogRequest) -> dict[str, str]:
    payload = {
        "event": req.event,
        "level": req.level or "info",
        "session_id": req.session_id,
        "ts": req.ts or time.time(),
        "detail": req.detail or {},
    }
    client_logger.info(json.dumps(payload, ensure_ascii=False))
    return {"status": "ok"}


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    if manager is None:
        await websocket.close(code=1011)
        return
    session = await manager.get_session(session_id)
    if session is None:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    logger.info("WebSocket connected: session_id=%s", session_id)
    session.connections.add(websocket)
    if manager is not None:
        await manager.activate_session(session_id)
    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            await _handle_client_message(session, data)
    except WebSocketDisconnect:
        session.connections.discard(websocket)
        logger.info("WebSocket disconnected: session_id=%s", session_id)
        if not session.connections and manager is not None:
            await manager.deactivate_session(session_id)
    except Exception:
        session.connections.discard(websocket)
        logger.exception("WebSocket error: session_id=%s", session_id)
        if not session.connections and manager is not None:
            await manager.deactivate_session(session_id)
        await websocket.close(code=1011)


async def _handle_client_message(session: Session, data: dict[str, Any]) -> None:
    msg_type = data.get("type")
    if msg_type == "run":
        if manager is not None:
            await manager.activate_session(session.session_id)
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
        else:
            logger.info("Run cancel requested: session_id=%s", session.session_id)
        return

    if msg_type == "run.status":
        run_id = data.get("run_id")
        if not run_id:
            await session.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "message": "Missing run_id for run.status request.",
                }
            )
            return
        current_run_id = session.current_run.run_id if session.current_run else None
        status = session.run_status.get(run_id)
        if status is None and current_run_id == run_id:
            status = "running"
        if status is None:
            status = "unknown"
        await session.broadcast(
            {
                "type": "run.status",
                "run_id": run_id,
                "status": status,
                "session_id": session.session_id,
                "current_run_id": current_run_id,
            }
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
    text = _normalize_text_content(content)
    if len(text) > limit:
        return text[:limit] + "...(truncated)"
    return text


def _normalize_text_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                if item:
                    parts.append(item)
                continue
            if isinstance(item, dict):
                if item.get("type") == "text" and isinstance(item.get("text"), str):
                    text = item["text"]
                    if text:
                        parts.append(text)
                continue
            parts.append(str(item))
        return "\n".join(parts)
    return str(content)


def _parse_tool_args(raw_args: Any) -> dict[str, Any] | None:
    if raw_args is None:
        return None
    if isinstance(raw_args, dict):
        return raw_args
    if isinstance(raw_args, str):
        if not raw_args:
            return None
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            return parsed
        return {"value": parsed}
    return {"value": raw_args}


def _truncate_text(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _extract_skill_name(text: str) -> str | None:
    # SKILL.md commonly uses a YAML header with `name: ...`.
    for line in text.splitlines()[:200]:
        match = re.match(r"\s*name\s*:\s*(.+?)\s*$", line)
        if not match:
            continue
        return match.group(1).strip().strip('"').strip("'") or None
    return None


def _extract_tool_calls(message: Any) -> list[dict[str, Any]]:
    tool_calls = getattr(message, "tool_calls", None)
    if isinstance(tool_calls, list) and tool_calls:
        return tool_calls
    additional_kwargs = getattr(message, "additional_kwargs", None)
    if isinstance(additional_kwargs, dict):
        maybe = additional_kwargs.get("tool_calls")
        if isinstance(maybe, list) and maybe:
            return maybe
    return []


async def _emit_tool_call_started(
    *,
    session: Session,
    run_id: str,
    tool_name: str,
    tool_call_id: str | None,
    args: dict[str, Any],
    file_op_tracker: FileOpTracker,
    displayed_tool_ids: set[str],
) -> None:
    if tool_call_id is not None:
        if tool_call_id not in displayed_tool_ids:
            displayed_tool_ids.add(tool_call_id)
            file_op_tracker.start_operation(tool_name, args, tool_call_id)
        else:
            file_op_tracker.update_args(tool_call_id, args)

    logger.info(
        "Tool call started: session_id=%s run_id=%s tool=%s tool_call_id=%s",
        session.session_id,
        run_id,
        tool_name,
        tool_call_id,
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
