"""Qwen image tools executed inside the sandbox."""

from __future__ import annotations

import json
import os
import shlex
import uuid
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool, tool

from deepagents.backends.protocol import SandboxBackendProtocol

from .sandbox_tool_utils import (
    _ensure_workspace_path,
    _parse_sandbox_result,
    _sync_to_host,
)


def _get_qwen_env() -> tuple[dict[str, str] | None, str | None]:
    api_key = os.environ.get("DASHSCOPE_API_KEY") or os.environ.get(
        "QWEN_OPENAI_API_KEY"
    )
    if not api_key:
        return None, "Missing DASHSCOPE_API_KEY or QWEN_OPENAI_API_KEY"
    env = {"DASHSCOPE_API_KEY": api_key}
    api_base = os.environ.get("DASHSCOPE_API_BASE")
    if api_base:
        env["DASHSCOPE_API_BASE"] = api_base
    return env, None


class QwenSandboxClient:
    """Run Qwen image tasks inside the sandbox using a real module."""

    def __init__(
        self,
        *,
        sandbox_backend: SandboxBackendProtocol,
        workspace_dir: Path | None,
    ) -> None:
        self._sandbox_backend = sandbox_backend
        self._workspace_dir = workspace_dir
        self._remote_dir = "/workspace/.deepagents/tools"
        self._remote_runner = f"{self._remote_dir}/qwen_runner.py"
        self._local_runner = Path(__file__).with_name("qwen_runner.py")

    def _ensure_runner(self) -> tuple[bool, str | None]:
        if not self._local_runner.exists():
            return False, f"Runner not found: {self._local_runner}"
        self._sandbox_backend.execute(
            f"mkdir -p {shlex.quote(self._remote_dir)}"
        )
        upload = self._sandbox_backend.upload_files(
            [(self._remote_runner, self._local_runner.read_bytes())]
        )
        if upload and upload[0].error:
            return False, f"Upload failed: {upload[0].error}"
        return True, None

    def _upload_payload(self, payload: dict[str, Any]) -> tuple[str | None, str | None]:
        payload_path = f"{self._remote_dir}/qwen_payload_{uuid.uuid4().hex}.json"
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        upload = self._sandbox_backend.upload_files([(payload_path, content)])
        if upload and upload[0].error:
            return None, f"Upload failed: {upload[0].error}"
        return payload_path, None

    def _run_task(self, task: str, payload: dict[str, Any]) -> dict[str, Any]:
        env, error = _get_qwen_env()
        if error:
            return {"success": False, "error": error}

        ready, error = self._ensure_runner()
        if not ready:
            return {"success": False, "error": error or "Runner setup failed"}

        payload_path, error = self._upload_payload(payload)
        if error or payload_path is None:
            return {"success": False, "error": error or "Payload upload failed"}

        env_prefix = ""
        if env:
            assignments = [
                f"{key}={shlex.quote(value)}" for key, value in env.items() if value
            ]
            if assignments:
                env_prefix = " ".join(assignments) + " "

        command = (
            f"{env_prefix}python3 {shlex.quote(self._remote_runner)} "
            f"--task {shlex.quote(task)} --payload {shlex.quote(payload_path)}"
        )
        result = self._sandbox_backend.execute(command)
        return _parse_sandbox_result(result.output, result.exit_code)

    def understand(
        self,
        image_path: str,
        prompt: str,
        model: str,
    ) -> dict[str, Any]:
        image_path = _ensure_workspace_path(image_path)
        payload = {"image_path": image_path, "prompt": prompt, "model": model}
        return self._run_task("understand", payload)

    def generate(
        self,
        prompt: str,
        output_path: str | None,
        size: str,
        model: str,
    ) -> dict[str, Any]:
        if not output_path:
            output_path = f"/workspace/generated/qwen_image_{uuid.uuid4().hex[:8]}.png"
        output_path = _ensure_workspace_path(output_path)
        payload = {
            "prompt": prompt,
            "output_path": output_path,
            "size": size,
            "model": model,
        }
        result = self._run_task("generate", payload)
        output_path = result.get("output_path")
        if isinstance(output_path, str):
            host_path = _sync_to_host(
                self._sandbox_backend, self._workspace_dir, output_path
            )
            if host_path:
                result["host_path"] = host_path
        return result


def build_qwen_tools(
    *, sandbox_backend: SandboxBackendProtocol, workspace_dir: Path | None = None
) -> list[BaseTool]:
    """Build Qwen image tools that execute inside the sandbox."""
    client = QwenSandboxClient(
        sandbox_backend=sandbox_backend,
        workspace_dir=workspace_dir,
    )

    @tool(
        "qwen_image_understand",
        description=(
            "Understand an image using Qwen image model inside the sandbox. "
            "Provide image_path (inside /workspace) and an optional prompt."
        ),
    )
    def qwen_image_understand(
        image_path: str,
        prompt: str = "Describe the image in detail.",
        model: str = "qwen-image-max",
    ) -> dict[str, Any]:
        return client.understand(image_path, prompt, model)

    @tool(
        "qwen_image_generate",
        description=(
            "Generate an image using Qwen image model inside the sandbox. "
            "Provide prompt, optional output_path (inside /workspace), and size like '1024*1024'."
        ),
    )
    def qwen_image_generate(
        prompt: str,
        output_path: str | None = None,
        size: str = "1024*1024",
        model: str = "qwen-image-max",
    ) -> dict[str, Any]:
        return client.generate(prompt, output_path, size, model)

    return [qwen_image_understand, qwen_image_generate]


__all__ = ["build_qwen_tools"]
