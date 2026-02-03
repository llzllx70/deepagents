from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import WebSocket
from langchain.agents.middleware.human_in_the_loop import HITLRequest, HITLResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command, Interrupt
from pydantic import TypeAdapter, ValidationError

from .config import WORKSPACE_DIR, logger

from .agent import create_cli_agent
from deepagents_cli.config import SessionState, create_model, settings
from deepagents_cli.file_ops import FileOpTracker
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

_HITL_REQUEST_ADAPTER = TypeAdapter(HITLRequest)


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


def _describe_tool(tool: Any) -> str:
    name = getattr(tool, "name", None)
    if isinstance(name, str) and name:
        return name
    name = getattr(tool, "__name__", None)
    if isinstance(name, str) and name:
        return name
    return tool.__class__.__name__


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
            "metadata": {"assistant_id": self.assistant_id},
        }

        file_op_tracker = FileOpTracker(assistant_id=self.assistant_id, backend=self.backend)
        tool_call_buffers: dict[str | int, dict[str, Any]] = {}
        displayed_tool_ids: set[str] = set()

        try:
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
                        if text:
                            logger.info(
                                "LLM message: session_id=%s run_id=%s text=%s",
                                self.session_id,
                                run_request.run_id,
                                truncate_for_log(text),
                            )
                            await self.broadcast(
                                {
                                    "type": "assistant.message",
                                    "run_id": run_request.run_id,
                                    "text": text,
                                }
                            )

                        for tool_call in extract_tool_calls(message):
                            if isinstance(tool_call, dict):
                                tool_name = tool_call.get("name")
                                tool_call_id = tool_call.get("id") or tool_call.get("tool_call_id")
                                raw_args = tool_call.get("args")
                                if tool_name is None and isinstance(tool_call.get("function"), dict):
                                    tool_name = tool_call["function"].get("name")
                                    raw_args = raw_args or tool_call["function"].get("arguments")
                                if not tool_name:
                                    continue
                                parsed_args = parse_tool_args(raw_args)
                                if parsed_args is None:
                                    if isinstance(raw_args, str) and tool_call_id:
                                        await handle_tool_call_block(
                                            {"name": tool_name, "args": raw_args, "id": tool_call_id},
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
                        record = file_op_tracker.complete_with_message(message)

                        if record is not None:
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

                        if tool_name in ("qwen_image_understand", "extract_file_text"):
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
                        display = format_tool_display(tool_name, None)
                        await self.broadcast(
                            {
                                "type": "tool.call.ended",
                                "run_id": run_request.run_id,
                                "tool_name": tool_name,
                                "status": tool_status,
                                "tool_call_id": getattr(message, "tool_call_id", None),
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
