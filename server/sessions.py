from __future__ import annotations

import asyncio
import importlib
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import WebSocket
from langchain.agents.middleware.human_in_the_loop import HITLRequest, HITLResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command, Interrupt
from pydantic import TypeAdapter, ValidationError

from .config import WORKSPACE_DIR, logger

from .agent import create_cli_agent
from deepagents_cli.config import SessionState, create_model, settings
from deepagents_cli.file_ops import FileOpTracker, format_display_path
from deepagents_cli.skills.load import list_skills
from deepagents_cli.tools import fetch_url, http_request, web_search
from .browser_bridge import BrowserBridge
from .browser_tools import build_browser_tools
from .docker import DockerSandboxBackend
from .docker_pool import DockerSandboxPool
from .context import inject_file_context
from .message_utils import (
    extract_skill_name,
    extract_tool_calls,
    format_tool_display,
    format_tool_content,
    is_root_namespace,
    normalize_text_content,
    parse_tool_args,
    truncate_for_log,
    truncate_text,
)
from .tool_stream import emit_tool_call_started, handle_tool_call_block
from .qwen_tools import build_qwen_tools
from .sandbox_tools import build_sandbox_tools
from .mcp_tools import get_mcp_tools
from .tool_call_args import pop_tool_call_args

_HITL_REQUEST_ADAPTER = TypeAdapter(HITLRequest)

_LANGSMITH_ENV_LOCK: asyncio.Lock | None = None
_LANGSMITH_TRACING_CONTEXT: Any | None = None
_LANGSMITH_CONTEXT_RESOLVED = False
DEBUG_TOOL_CALLS = os.getenv("DEEPAGENTS_DEBUG_TOOL_CALLS") == "1"


def _resolve_langsmith_tracing_context() -> Any | None:
    global _LANGSMITH_TRACING_CONTEXT, _LANGSMITH_CONTEXT_RESOLVED
    if _LANGSMITH_CONTEXT_RESOLVED:
        return _LANGSMITH_TRACING_CONTEXT
    _LANGSMITH_CONTEXT_RESOLVED = True
    for module_name in ("langsmith.run_helpers", "langsmith.utils"):
        try:
            module = importlib.import_module(module_name)
        except Exception:
            continue
        tracing_context = getattr(module, "tracing_context", None)
        if tracing_context is not None:
            _LANGSMITH_TRACING_CONTEXT = tracing_context
            break
    return _LANGSMITH_TRACING_CONTEXT


def _get_langsmith_env_lock() -> asyncio.Lock:
    global _LANGSMITH_ENV_LOCK
    if _LANGSMITH_ENV_LOCK is None:
        _LANGSMITH_ENV_LOCK = asyncio.Lock()
    return _LANGSMITH_ENV_LOCK


@asynccontextmanager
async def _langsmith_project_context(project_name: str) -> AsyncIterator[None]:
    if not project_name:
        yield
        return
    tracing_context = _resolve_langsmith_tracing_context()
    if tracing_context is not None:
        try:
            with tracing_context(project_name=project_name):
                yield
            return
        except TypeError:
            pass
    async with _get_langsmith_env_lock():
        old_langchain_project = os.environ.get("LANGCHAIN_PROJECT")
        old_langsmith_project = os.environ.get("LANGSMITH_PROJECT")
        os.environ["LANGCHAIN_PROJECT"] = project_name
        os.environ["LANGSMITH_PROJECT"] = project_name
        try:
            yield
        finally:
            if old_langchain_project is None:
                os.environ.pop("LANGCHAIN_PROJECT", None)
            else:
                os.environ["LANGCHAIN_PROJECT"] = old_langchain_project
            if old_langsmith_project is None:
                os.environ.pop("LANGSMITH_PROJECT", None)
            else:
                os.environ["LANGSMITH_PROJECT"] = old_langsmith_project


def _format_stream_input_for_log(value: object) -> str:
    if isinstance(value, Command):
        resume = getattr(value, "resume", None)
        if isinstance(resume, dict):
            return f"Command(resume_interrupts={list(resume.keys())})"
        return "Command(resume=<non-dict>)"
    if isinstance(value, dict):
        messages = value.get("messages")
        if isinstance(messages, list) and messages:
            last = messages[-1]
            if isinstance(last, dict):
                role = last.get("role")
                content = last.get("content")
                if isinstance(content, str):
                    content_preview = content.replace("\n", "\\n")
                    if len(content_preview) > 200:
                        content_preview = content_preview[:200] + "...(truncated)"
                    return f"dict(messages[-1].role={role!r}, content={content_preview!r})"
                return f"dict(messages[-1].role={role!r}, content_type={type(content).__name__})"
        return f"dict(keys={list(value.keys())})"
    return f"{type(value).__name__}({value!r})"


def _parse_tool_payload(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _describe_model(model: Any) -> str:
    if isinstance(model, str):
        return model
    for attr in ("model_name", "model", "model_id", "name"):
        value = getattr(model, attr, None)
        if isinstance(value, str) and value:
            return value
    return model.__class__.__name__


def _configure_kimi_thinking(model: Any) -> None:
    model_name = None
    for attr in ("model_name", "model", "model_id", "name"):
        value = getattr(model, attr, None)
        if isinstance(value, str) and value:
            model_name = value
            break
    if not model_name or not model_name.lower().startswith("kimi"):
        return

    if not hasattr(model, "extra_body"):
        return

    raw_mode = os.getenv("DEEPAGENTS_KIMI_THINKING")
    if raw_mode is None:
        desired_mode = "disabled"
    else:
        desired_mode = raw_mode.strip().lower()
        if desired_mode in ("auto", "default", ""):
            return

    if desired_mode in ("disabled", "off", "false", "0", "instant"):
        thinking_value = {"type": "disabled"}
    elif desired_mode in ("enabled", "on", "true", "1", "thinking"):
        thinking_value = {"type": "enabled"}
    else:
        return

    extra_body = getattr(model, "extra_body", None)
    if not isinstance(extra_body, dict):
        extra_body = {}
    extra_body = {**extra_body, "thinking": thinking_value}
    model.extra_body = extra_body


def _describe_tool(tool: Any) -> str:
    name = getattr(tool, "name", None)
    if isinstance(name, str) and name:
        return name
    name = getattr(tool, "__name__", None)
    if isinstance(name, str) and name:
        return name
    return tool.__class__.__name__


def _preview_raw_args(value: Any, limit: int = 300) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False)
        except TypeError:
            text = str(value)
    if len(text) > limit:
        return text[:limit] + "...(truncated)"
    return text


def _preview_json(value: Any, limit: int = 600) -> str:
    if value is None:
        return ""
    try:
        text = json.dumps(value, ensure_ascii=False)
    except TypeError:
        text = str(value)
    if len(text) > limit:
        return text[:limit] + "...(truncated)"
    return text


def _extract_tool_call_fields(tool_call: dict[str, Any]) -> tuple[str | None, Any, str | None, int | None]:
    tool_name = tool_call.get("name") or tool_call.get("tool_name")
    raw_args = tool_call.get("args")
    if raw_args in (None, "", {}):
        for key in ("arguments", "input", "parameters", "params"):
            if key in tool_call:
                raw_args = tool_call.get(key)
                break

    func = tool_call.get("function")
    if tool_name is None and isinstance(func, dict):
        tool_name = func.get("name")
    if raw_args in (None, "", {}) and isinstance(func, dict):
        for key in ("arguments", "input", "parameters", "params"):
            if key in func:
                raw_args = func.get(key)
                break

    tool_call_id = tool_call.get("id") or tool_call.get("tool_call_id") or tool_call.get("call_id")
    tool_call_index = tool_call.get("index") or tool_call.get("tool_call_index")
    return tool_name, raw_args, tool_call_id, tool_call_index


def _fallback_tool_call_id(tool_name: str, tool_call: dict[str, Any]) -> str | None:
    index = tool_call.get("index")
    if index is None:
        return None
    return f"{tool_name}:{index}"


def _should_buffer_tool_args(raw_args: Any, parsed_args: dict[str, Any] | None) -> bool:
    if parsed_args is None:
        return isinstance(raw_args, str)
    if not isinstance(raw_args, str):
        return False
    if set(parsed_args.keys()) != {"value"}:
        return False
    value = parsed_args.get("value")
    if not isinstance(value, str):
        return False
    raw = raw_args.strip()
    if raw.startswith('"'):
        return True
    if any(ch in value for ch in "{}[]"):
        stripped = value.strip()
        if not ((stripped.startswith("{") and stripped.endswith("}")) or (stripped.startswith("[") and stripped.endswith("]"))):
            return True
    return False


def _is_message_chunk(message: Any) -> bool:
    return message.__class__.__name__.endswith("Chunk")


def _extract_message_id(message: Any, metadata: Any) -> str | None:
    for attr in ("id", "message_id", "messageId"):
        value = getattr(message, attr, None)
        if isinstance(value, str) and value:
            return value
    if isinstance(metadata, dict):
        for key in ("id", "message_id", "messageId"):
            value = metadata.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _is_message_final(message: Any, metadata: Any) -> bool:
    if not _is_message_chunk(message):
        return True
    for container in (
        getattr(message, "response_metadata", None),
        getattr(message, "additional_kwargs", None),
        metadata,
    ):
        if isinstance(container, dict):
            if container.get("final") is True or container.get("is_final") is True:
                return True
            finish_reason = container.get("finish_reason")
            stop_reason = container.get("stop_reason")
            if finish_reason is not None or stop_reason is not None:
                return True
    return False


def _list_skill_names(assistant_id: str) -> list[str]:
    try:
        user_skills_dir = settings.ensure_user_skills_dir(assistant_id)
        project_skills_dir = settings.get_project_skills_dir()
        skills = list_skills(
            user_skills_dir=user_skills_dir,
            project_skills_dir=project_skills_dir,
        )
    except Exception as exc:
        logger.warning("Failed to list skills for logging: %s", exc)
        return []
    names: list[str] = []
    for skill in skills:
        name = getattr(skill, "name", None) or getattr(skill, "id", None)
        if not name:
            name = getattr(skill, "path", None)
        if name:
            names.append(str(name))
        else:
            names.append(str(skill))
    return names


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
class UploadedFile:
    file_id: str
    filename: str
    content_type: str | None
    size: int
    host_path: Path
    container_path: str
    uploaded_at: float = field(default_factory=time.time)
    extracted_text: str | None = None
    extracted_text_truncated: bool = False
    extracted_at: float | None = None
    extracted_tool: str | None = None
    extraction_error: str | None = None


@dataclass
class Session:
    session_id: str
    assistant_id: str
    session_state: SessionState
    agent: Any
    backend: Any
    sandbox_backend: DockerSandboxBackend
    workspace_dir: Path
    browser_bridge: BrowserBridge | None = None
    run_queue: asyncio.Queue[RunRequest] = field(default_factory=asyncio.Queue)
    run_status: dict[str, str] = field(default_factory=dict)
    connections: set[WebSocket] = field(default_factory=set)
    current_run: RunExecution | None = None
    current_task: asyncio.Task | None = None
    worker_task: asyncio.Task | None = None
    uploaded_files: dict[str, UploadedFile] = field(default_factory=dict)
    uploaded_files_by_path: dict[str, str] = field(default_factory=dict)

    def register_uploaded_file(self, attachment: UploadedFile) -> None:
        normalized_path = self._normalize_container_path(attachment.container_path)
        attachment.container_path = normalized_path
        self.uploaded_files[attachment.file_id] = attachment
        self.uploaded_files_by_path[normalized_path] = attachment.file_id

    def remove_uploaded_file(self, file_id: str) -> UploadedFile | None:
        attachment = self.uploaded_files.pop(file_id, None)
        if attachment is None:
            return None
        normalized_path = self._normalize_container_path(attachment.container_path)
        self.uploaded_files_by_path.pop(normalized_path, None)
        return attachment

    def _normalize_container_path(self, path: str) -> str:
        workdir = getattr(self.sandbox_backend, "workdir", "/workspace")
        candidate = os.path.normpath(path)
        if not candidate.startswith("/"):
            candidate = os.path.normpath(os.path.join(workdir, candidate))
        return candidate

    def _find_uploaded_file(self, container_path: str) -> UploadedFile | None:
        normalized = self._normalize_container_path(container_path)
        file_id = self.uploaded_files_by_path.get(normalized)
        if not file_id:
            return None
        return self.uploaded_files.get(file_id)

    def record_extracted_text(
        self,
        *,
        container_path: str,
        tool_name: str,
        text: str | None,
        truncated: bool | None = None,
        error: str | None = None,
    ) -> None:
        attachment = self._find_uploaded_file(container_path)
        if attachment is None:
            return
        attachment.extracted_tool = tool_name
        attachment.extracted_at = time.time()
        attachment.extraction_error = error
        if text is None:
            return
        content, was_truncated = truncate_text(text, limit=50000)
        attachment.extracted_text = content
        attachment.extracted_text_truncated = was_truncated or bool(truncated)

    def format_uploaded_files_context(self) -> str | None:
        if not self.uploaded_files:
            return None
        lines = ["## 已上传文件"]
        pending = False
        for attachment in sorted(
            self.uploaded_files.values(), key=lambda item: item.uploaded_at
        ):
            lines.append(f"### {attachment.filename}")
            lines.append(f"路径: `{attachment.container_path}`")
            if attachment.content_type:
                lines.append(f"类型: {attachment.content_type}")
            if attachment.extracted_text:
                lines.append("内容:")
                lines.append("```")
                lines.append(attachment.extracted_text)
                lines.append("```")
                if attachment.extracted_text_truncated:
                    lines.append("(内容已截断)")
            else:
                status = "待解析"
                if attachment.extraction_error:
                    status = f"解析失败：{attachment.extraction_error}"
                lines.append(f"状态: {status}")
                pending = True
        if pending:
            lines.append("")
            lines.append("如需解析内容，请调用：")
            lines.append("- 图片理解/解释/内容提取：`qwen_image_understand`")
            lines.append("- 文本/pdf/docx/xlsx/xls：`extract_file_text`")
            lines.append("如需文生图/生成图片，请调用：`qwen_image_generate`")
            lines.append("解析结果会自动加入到本上下文中。")
        return "\n".join(lines)

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
        stale: list[Any] = []
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
        logger.info(
            "User input: session_id=%s run_id=%s text=%s",
            self.session_id,
            run_request.run_id,
            truncate_for_log(run_request.user_input),
        )

        prompt_text, warnings = inject_file_context(run_request.user_input)
        uploaded_context = self.format_uploaded_files_context()
        if uploaded_context:
            prompt_text = f"{prompt_text}\n\n{uploaded_context}"
        if self.browser_bridge and self.browser_bridge.is_connected():
            browser_context = self.browser_bridge.format_snapshot_for_prompt()
            if browser_context:
                prompt_text = (
                    f"{prompt_text}\n\n## Browser Snapshot\n{browser_context}\n\n"
                    "If you need a fresh snapshot, call browser_request_snapshot."
                )
            else:
                prompt_text = (
                    f"{prompt_text}\n\n## Browser Snapshot\n"
                    "No snapshot yet. Call browser_request_snapshot first."
                )
        for warning in warnings:
            await self.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "run_id": run_request.run_id,
                    "message": warning,
                }
            )

        stream_input: dict[str, Any] | Command = {"messages": [{"role": "user", "content": prompt_text}]}
        stream_round = 0
        auto_approve = (
            run_request.auto_approve
            if run_request.auto_approve is not None
            else self.session_state.auto_approve
        )

        config = {
            "configurable": {"thread_id": self.session_state.thread_id},
            "metadata": {
                "assistant_id": self.assistant_id,
                "session_id": self.session_id,
                "run_id": run_request.run_id,
            },
        }

        file_op_tracker = FileOpTracker(assistant_id=self.assistant_id, backend=self.backend)
        tool_call_buffers: dict[str | int, dict[str, Any]] = {}
        displayed_tool_ids: set[str] = set()
        message_buffer = ""
        message_buffer_id: str | None = None
        emitted_message_ids: set[str] = set()
        last_emitted_message: str | None = None
        streamed_message_ids: set[str] = set()
        last_streamed_message: str | None = None
        streamed_message_pending = False
        delta_emitted = False
        logged_message_ids: set[str] = set()
        last_logged_message: str | None = None

        async def log_full_ai_message(text: str, message_id: str | None) -> None:
            nonlocal last_logged_message
            if not text:
                return
            if message_id and message_id in logged_message_ids:
                return
            if last_logged_message == text:
                return
            if message_id:
                logged_message_ids.add(message_id)
            last_logged_message = text
            logger.info(
                "LLM message: session_id=%s run_id=%s text=%s",
                self.session_id,
                run_request.run_id,
                truncate_for_log(text),
            )

        async def emit_full_ai_message(text: str, message_id: str | None) -> None:
            nonlocal last_emitted_message
            if not text:
                return
            if message_id:
                if message_id in emitted_message_ids:
                    return
                emitted_message_ids.add(message_id)
            else:
                if last_emitted_message == text:
                    return
            last_emitted_message = text
            await log_full_ai_message(text, message_id)
            await self.broadcast(
                {
                    "type": "assistant.message",
                    "run_id": run_request.run_id,
                    "text": text,
                }
            )

        async def flush_message_buffer() -> None:
            nonlocal message_buffer, message_buffer_id, last_streamed_message, streamed_message_pending
            if not message_buffer:
                message_buffer_id = None
                return
            last_streamed_message = message_buffer
            streamed_message_pending = True
            await log_full_ai_message(message_buffer, message_buffer_id)
            message_buffer = ""
            message_buffer_id = None

        try:
            async with _langsmith_project_context(self.session_id):
                while True:
                    stream_round += 1
                    if os.getenv("DEEPAGENTS_CLI_DEBUG_STREAM_INPUT"):
                        logger.info(
                            "Stream round %s: %s",
                            stream_round,
                            _format_stream_input_for_log(stream_input),
                        )
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
    
                        namespace, current_stream_mode, data = chunk
                        is_root = is_root_namespace(namespace)
    
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
                            text = normalize_text_content(message.content)
                            message_id = _extract_message_id(message, _metadata)
                            is_chunk = _is_message_chunk(message)
                            if text:
                                if is_chunk:
                                    streamed_message_pending = False
                                    if message_id:
                                        streamed_message_ids.add(message_id)
                                    if message_buffer_id is None:
                                        message_buffer_id = message_id
                                    elif message_id and message_buffer_id and message_id != message_buffer_id:
                                        await flush_message_buffer()
                                        message_buffer_id = message_id
                                    message_buffer += text
                                    await self.broadcast(
                                        {
                                            "type": "assistant.delta",
                                            "run_id": run_request.run_id,
                                            "text": text,
                                        }
                                    )
                                    delta_emitted = True
                                else:
                                    if message_buffer:
                                        if message_buffer_id and message_id and message_buffer_id != message_id:
                                            await flush_message_buffer()
                                        elif text.startswith(message_buffer) or message_buffer.startswith(text):
                                            message_buffer = ""
                                            message_buffer_id = None
                                        else:
                                            await flush_message_buffer()
                                    is_duplicate_stream = False
                                    if message_id and message_id in streamed_message_ids:
                                        is_duplicate_stream = True
                                    elif streamed_message_pending and last_streamed_message and (
                                        text == last_streamed_message
                                        or text.startswith(last_streamed_message)
                                        or last_streamed_message.startswith(text)
                                    ):
                                        is_duplicate_stream = True
                                    streamed_message_pending = False
                                    if is_duplicate_stream:
                                        await log_full_ai_message(text, message_id)
                                    elif delta_emitted:
                                        await log_full_ai_message(text, message_id)
                                    else:
                                        await emit_full_ai_message(text, message_id)
                            if is_chunk and _is_message_final(message, _metadata):
                                await flush_message_buffer()
    
                            for tool_call in extract_tool_calls(message):
                                if isinstance(tool_call, dict):
                                    tool_name, raw_args, tool_call_id, tool_call_index = _extract_tool_call_fields(tool_call)
                                    if not tool_name:
                                        continue
                                    if tool_call_id is None and tool_call_index is not None:
                                        tool_call_id = _fallback_tool_call_id(str(tool_name), tool_call)
                                    parsed_args = parse_tool_args(raw_args)
                                    if parsed_args in (None, {}) and raw_args not in (None, "", {}):
                                        logger.info(
                                            "Tool call raw args incomplete: session_id=%s run_id=%s tool=%s tool_call_id=%s raw_args=%s",
                                            self.session_id,
                                            run_request.run_id,
                                            tool_name,
                                            tool_call_id,
                                            _preview_raw_args(raw_args),
                                        )
                                    if parsed_args == {} and tool_name in {"read_file", "write_file", "edit_file", "execute", "shell"}:
                                        additional = getattr(message, "additional_kwargs", None)
                                        response_metadata = getattr(message, "response_metadata", None)
                                        logger.info(
                                            "Tool call missing args: session_id=%s run_id=%s tool=%s tool_call_id=%s tool_call=%s additional=%s response_metadata=%s",
                                            self.session_id,
                                            run_request.run_id,
                                            tool_name,
                                            tool_call_id,
                                            _preview_json(tool_call),
                                            _preview_json(additional),
                                            _preview_json(response_metadata),
                                        )
                                    if DEBUG_TOOL_CALLS and parsed_args in (None, {}):
                                        logger.info(
                                            "Tool call payload: session_id=%s run_id=%s tool=%s tool_call_id=%s tool_call=%s",
                                            self.session_id,
                                            run_request.run_id,
                                            tool_name,
                                            tool_call_id,
                                            _preview_json(tool_call),
                                        )
                                        additional = getattr(message, "additional_kwargs", None)
                                        if isinstance(additional, dict) and additional:
                                            logger.info(
                                                "Tool call additional_kwargs: session_id=%s run_id=%s keys=%s payload=%s",
                                                self.session_id,
                                                run_request.run_id,
                                                list(additional.keys()),
                                                _preview_json(additional),
                                            )
                                        response_metadata = getattr(message, "response_metadata", None)
                                        if isinstance(response_metadata, dict) and response_metadata:
                                            logger.info(
                                                "Tool call response_metadata: session_id=%s run_id=%s keys=%s payload=%s",
                                                self.session_id,
                                                run_request.run_id,
                                                list(response_metadata.keys()),
                                                _preview_json(response_metadata),
                                            )
                                    if _should_buffer_tool_args(raw_args, parsed_args):
                                        await handle_tool_call_block(
                                            {
                                                "name": tool_name,
                                                "args": raw_args,
                                                "id": tool_call_id,
                                                "index": tool_call_index,
                                            },
                                            tool_call_buffers,
                                            displayed_tool_ids,
                                            file_op_tracker,
                                            run_request.run_id,
                                            self,
                                        )
                                        continue
                                    await emit_tool_call_started(
                                        session=self,
                                        run_id=run_request.run_id,
                                        tool_name=str(tool_name),
                                        tool_call_id=str(tool_call_id) if tool_call_id else None,
                                        args=parsed_args,
                                        file_op_tracker=file_op_tracker,
                                        displayed_tool_ids=displayed_tool_ids,
                                    )
                            tool_call_chunks = getattr(message, "tool_call_chunks", None)
                            if isinstance(tool_call_chunks, list) and tool_call_chunks:
                                for chunk in tool_call_chunks:
                                    if isinstance(chunk, dict):
                                        await handle_tool_call_block(
                                            chunk,
                                            tool_call_buffers,
                                            displayed_tool_ids,
                                            file_op_tracker,
                                            run_request.run_id,
                                            self,
                                        )
    
                            content_blocks = getattr(message, "content_blocks", None)
                            if isinstance(content_blocks, list) and content_blocks:
                                for block in content_blocks:
                                    if DEBUG_TOOL_CALLS and isinstance(block, dict):
                                        block_type = block.get("type")
                                        if block_type in ("tool_call_chunk", "tool_call"):
                                            logger.info(
                                                "Tool call content_block: session_id=%s run_id=%s type=%s payload=%s",
                                                self.session_id,
                                                run_request.run_id,
                                                block_type,
                                                _preview_json(block),
                                            )
                                    block_type = block.get("type")
                                    if block_type in ("tool_call_chunk", "tool_call"):
                                        await handle_tool_call_block(
                                            block,
                                            tool_call_buffers,
                                            displayed_tool_ids,
                                            file_op_tracker,
                                            run_request.run_id,
                                            self,
                                        )
                            continue
    
                        if isinstance(message, ToolMessage):
                            tool_name = getattr(message, "name", "") or "tool"
                            tool_status = getattr(message, "status", "success")
                            tool_full_content = normalize_text_content(message.content)
                            tool_call_id = getattr(message, "tool_call_id", None)
                            tool_call_payload = pop_tool_call_args(
                                self.session_id,
                                tool_call_id,
                                thread_id=self.session_state.thread_id,
                            )
                            args_from_store = None
                            if isinstance(tool_call_payload, dict):
                                args_from_store = tool_call_payload.get("args")
                            if tool_call_id and isinstance(args_from_store, dict) and args_from_store:
                                file_op_tracker.update_args(tool_call_id, args_from_store)
                                active_record = file_op_tracker.active.get(tool_call_id)
                                if active_record and active_record.tool_name == "read_file":
                                    path_str = args_from_store.get("file_path") or args_from_store.get("path")
                                    if isinstance(path_str, str) and path_str:
                                        active_record.display_path = format_display_path(path_str)
                            record = file_op_tracker.complete_with_message(message)
    
                            tool_call_args: dict[str, Any] | None = None
                            if isinstance(args_from_store, dict) and args_from_store:
                                tool_call_args = args_from_store
                            if tool_call_args is None and record is not None:
                                if isinstance(record.args, dict) and record.args:
                                    tool_call_args = record.args
                                content = ""
                                content_preview = ""
                                content_truncated = False
                                meta: dict[str, Any] = {}
                                if record.tool_name == "read_file" and record.read_output is not None:
                                    raw_content = record.read_output
                                    content, content_truncated = truncate_text(raw_content, limit=50000)
                                    content_preview, _preview_truncated = truncate_text(raw_content, limit=6000)
                                    if record.display_path.lower().endswith("skill.md"):
                                        skill_name = extract_skill_name(raw_content)
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
    
                            if tool_name in ("qwen_image_understand", "qwen_image_image_understand", "extract_file_text"):
                                payload = _parse_tool_payload(tool_full_content)
                                if payload:
                                    container_path = payload.get("image_path") or payload.get("file_path")
                                    if isinstance(container_path, str) and container_path:
                                        success = payload.get("success", True)
                                        error = payload.get("error") if not success else None
                                        text = payload.get("text")
                                        if text is not None and not isinstance(text, str):
                                            text = str(text)
                                        truncated_flag = payload.get("truncated")
                                        truncated = truncated_flag if isinstance(truncated_flag, bool) else None
                                        self.record_extracted_text(
                                            container_path=container_path,
                                            tool_name=tool_name,
                                            text=text if success or text else None,
                                            truncated=truncated,
                                            error=error,
                                        )
    
                            preview_limit = 400
                            logger.info(
                                "Tool call ended: session_id=%s run_id=%s tool=%s status=%s",
                                self.session_id,
                                run_request.run_id,
                                tool_name,
                                tool_status,
                            )
                            display = format_tool_display(tool_name, tool_call_args)
                            await self.broadcast(
                                {
                                    "type": "tool.call.ended",
                                    "run_id": run_request.run_id,
                                    "tool_name": tool_name,
                                    "status": tool_status,
                                    "tool_call_id": getattr(message, "tool_call_id", None),
                                    "args": tool_call_args,
                                    "content": tool_full_content,
                                    "content_preview": format_tool_content(tool_full_content, limit=preview_limit),
                                    "content_truncated": len(tool_full_content) > preview_limit,
                                    "display_title": display["title"],
                                    "display_content": display["content"],
                                }
                            )
                            continue
    
                        tool_call_chunks = getattr(message, "tool_call_chunks", None)
                        if isinstance(tool_call_chunks, list) and tool_call_chunks:
                            for chunk in tool_call_chunks:
                                if isinstance(chunk, dict):
                                    await handle_tool_call_block(
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
                                logger.debug(
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
                                delta_emitted = True
                            continue
    
                        for block in message.content_blocks:
                            block_type = block.get("type")
                            if block_type == "text":
                                text = block.get("text", "")
                                if text:
                                    logger.debug(
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
                                    delta_emitted = True
                            elif block_type in ("tool_call_chunk", "tool_call"):
                                await handle_tool_call_block(
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
    
                    if message_buffer:
                        await flush_message_buffer()
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
                if session_id in self._sessions:
                    self._active_session_id = session_id

    async def deactivate_session(self, session_id: str) -> None:
        async with self._activation_lock:
            async with self._lock:
                if self._active_session_id != session_id:
                    return
                self._active_session_id = None


    async def create_session(self, assistant_id: str | None, auto_approve: bool) -> Session:
        logger.info("Creating session: assistant_id=%s auto_approve=%s", assistant_id, auto_approve)
        session_id = uuid.uuid4().hex
        session_workspace_dir = WORKSPACE_DIR / session_id
        session_workspace_dir.mkdir(parents=True, exist_ok=True)
        model = create_model()
        _configure_kimi_thinking(model)
        tools = [http_request, fetch_url]
        logger.info(
            "settings.has_tavily = %s, tavily_api_key = %s...",
            settings.has_tavily,
            settings.tavily_api_key[:10] if settings.tavily_api_key else None,
        )
        if settings.has_tavily:
            tools.append(web_search)
            logger.info("web_search tool added, total tools: %s", [t.__name__ for t in tools])
        else:
            logger.warning("Tavily API key not configured, web_search disabled")

        try:
            mcp_tools = await get_mcp_tools()
        except Exception as exc:
            logger.warning("Failed to load MCP tools: %s", exc)
            mcp_tools = []
        if mcp_tools:
            tools.extend(mcp_tools)
            logger.info("MCP tools added: %s", [_describe_tool(t) for t in mcp_tools])

        session_state = SessionState(auto_approve=auto_approve)
        browser_bridge = BrowserBridge(session_id=session_id)
        tools.extend(build_browser_tools(browser_bridge))
        sandbox_backend = await self._pool.acquire_for_session(session_id, session_workspace_dir)
        tools.extend(
            build_qwen_tools(
                sandbox_backend=sandbox_backend,
                workspace_dir=session_workspace_dir,
            )
        )
        tools.extend(
            build_sandbox_tools(
                sandbox_backend=sandbox_backend,
                workspace_dir=session_workspace_dir,
            )
        )
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
        tool_names = [_describe_tool(tool) for tool in tools]
        skill_names = _list_skill_names(assistant_id or "agent")
        logger.info(
            "Agent bindings: session_id=%s model=%s tools=%s skills=%s",
            session_id,
            _describe_model(model),
            tool_names,
            skill_names,
        )
        session = Session(
            session_id=session_id,
            assistant_id=assistant_id or "agent",
            session_state=session_state,
            agent=agent,
            backend=backend,
            sandbox_backend=sandbox_backend,
            workspace_dir=session_workspace_dir,
            browser_bridge=browser_bridge,
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
                if self._pool.config.bind_workspace:
                    synced = True
                else:
                    await self._pool.sync_workspace(session.sandbox_backend, session.workspace_dir)
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
