"""Qwen image tools executed inside the sandbox."""

from __future__ import annotations

import json
import os
import shlex
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from langchain_core.tools import BaseTool, tool

from deepagents.backends.protocol import SandboxBackendProtocol

from .config import logger
from .sandbox_tool_utils import (
    _ensure_workspace_path,
    _parse_sandbox_result,
    _sync_to_host,
)


def _get_qwen_env(scene: str) -> tuple[dict[str, str] | None, str | None]:
    config_api_key, config_api_base, _model = _get_scene_qwen_config(scene)
    api_key = config_api_key or os.environ.get("DASHSCOPE_API_KEY") or os.environ.get(
        "QWEN_OPENAI_API_KEY"
    )
    api_base = config_api_base or os.environ.get("DASHSCOPE_API_BASE")
    if not api_key:
        return None, "Missing DASHSCOPE_API_KEY or QWEN_OPENAI_API_KEY"
    env = {"DASHSCOPE_API_KEY": api_key}
    if api_base:
        env["DASHSCOPE_API_BASE"] = api_base
    return env, None


def _log_qwen_failure(
    task: str,
    result: dict[str, Any],
    *,
    model: str | None = None,
    api_base: str | None = None,
) -> None:
    details = {
        "task": task,
        "error": result.get("error"),
        "status_code": result.get("status_code"),
        "request_id": result.get("request_id"),
        "task_id": result.get("task_id"),
        "task_status": result.get("task_status"),
        "exit_code": result.get("exit_code"),
        "response_summary": result.get("response_summary"),
        "model": model,
        "api_base": api_base,
    }
    logger.warning("Qwen tool failure: %s", json.dumps(details, ensure_ascii=False))


@lru_cache(maxsize=1)
def _load_model_config() -> dict[str, dict[str, Any]]:
    config_path = Path(__file__).resolve().parents[1] / "config" / "model.yml"
    if not config_path.exists():
        return {}
    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    models = data.get("models")
    if not isinstance(models, dict):
        return {}
    return {key: value for key, value in models.items() if isinstance(value, dict)}


@lru_cache(maxsize=1)
def _load_scene_config() -> dict[str, str]:
    config_path = Path(__file__).resolve().parents[1] / "config" / "llm-scene.yml"
    if not config_path.exists():
        return {}
    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        key: value
        for key, value in data.items()
        if isinstance(key, str) and isinstance(value, str)
    }


def _scene_model(scene: str) -> str | None:
    return _load_scene_config().get(scene)


def _get_model_config(model_key: str | None) -> tuple[str | None, str | None, str | None]:
    if not model_key:
        return None, None, None
    models = _load_model_config()
    config = models.get(model_key)
    if not isinstance(config, dict):
        return None, None, None
    api_key = config.get("api_key")
    api_base = config.get("base_url")
    model = config.get("model")
    api_key = api_key if isinstance(api_key, str) and api_key else None
    api_base = api_base if isinstance(api_base, str) and api_base else None
    model = model if isinstance(model, str) and model else None
    return api_key, api_base, model


def _scene_fallback_model(scene: str) -> str:
    if scene == "image-create":
        return "qwen-image-max"
    return "qwen3-vl-plus"


def _get_scene_qwen_config(scene: str) -> tuple[str | None, str | None, str | None]:
    model_key = _scene_model(scene) or _scene_fallback_model(scene)
    return _get_model_config(model_key)


def _default_qwen_understand_model() -> str:
    _api_key, _api_base, model = _get_scene_qwen_config("image-understand")
    return model or "qwen3-vl-plus"


def _default_qwen_generate_model() -> str:
    _api_key, _api_base, model = _get_scene_qwen_config("image-create")
    return model or "qwen-image-max"


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

    def _run_task(self, task: str, payload: dict[str, Any], scene: str) -> dict[str, Any]:
        env, error = _get_qwen_env(scene)
        model = payload.get("model") if isinstance(payload, dict) else None
        api_base = None
        if env and env.get("DASHSCOPE_API_BASE"):
            api_base = env["DASHSCOPE_API_BASE"]
        else:
            api_base = "https://dashscope.aliyuncs.com"
        if error:
            result = {"success": False, "error": error}
            _log_qwen_failure(task, result, model=model, api_base=api_base)
            return result

        ready, error = self._ensure_runner()
        if not ready:
            result = {"success": False, "error": error or "Runner setup failed"}
            _log_qwen_failure(task, result, model=model, api_base=api_base)
            return result

        payload_path, error = self._upload_payload(payload)
        if error or payload_path is None:
            result = {"success": False, "error": error or "Payload upload failed"}
            _log_qwen_failure(task, result, model=model, api_base=api_base)
            return result

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
        parsed = _parse_sandbox_result(result.output, result.exit_code)
        if not parsed.get("success", True):
            _log_qwen_failure(task, parsed, model=model, api_base=api_base)
        return parsed

    def understand(
        self,
        image_path: str,
        prompt: str,
        model: str,
    ) -> dict[str, Any]:
        image_path = _ensure_workspace_path(image_path)
        payload = {"image_path": image_path, "prompt": prompt, "model": model}
        return self._run_task("understand", payload, "image-understand")

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
        result = self._run_task("generate", payload, "image-create")
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

    def _run_image_understand(
        image_path: str,
        prompt: str,
        model: str | None,
    ) -> dict[str, Any]:
        selected_model = model or _default_qwen_understand_model()
        result = client.understand(image_path, prompt, selected_model)
        result["image_path"] = image_path
        return result

    @tool(
        "qwen_image_understand",
        description=(
            "Use this tool to explain/describe/understand an existing image and extract its content. "
            "Examples: image captioning, OCR, object recognition, scene understanding. "
            "Do NOT use for text-to-image generation. "
            "Provide image_path (inside /workspace) and an optional prompt."
        ),
    )
    def qwen_image_understand(
        image_path: str,
        prompt: str = "Describe the image in detail and extract any key text.",
        model: str | None = None,
    ) -> dict[str, Any]:
        return _run_image_understand(image_path, prompt, model)

    @tool(
        "qwen_image_image_understand",
        description=(
            "Deprecated alias of qwen_image_understand (typo compatibility). "
            "Use qwen_image_understand instead."
        ),
    )
    def qwen_image_image_understand(
        image_path: str,
        prompt: str = "Describe the image in detail and extract any key text.",
        model: str | None = None,
    ) -> dict[str, Any]:
        return _run_image_understand(image_path, prompt, model)

    @tool(
        "qwen_image_generate",
        description=(
            "Use this tool to generate/create an image from text (text-to-image). "
            "Examples: draw/illustrate a scene, create a poster, generate artwork. "
            "Do NOT use for explaining or extracting content from an existing image. "
            "Provide prompt, optional output_path (inside /workspace), and size like '1024*1024'."
        ),
    )
    def qwen_image_generate(
        prompt: str,
        output_path: str | None = None,
        size: str = "1024*1024",
        model: str | None = None,
    ) -> dict[str, Any]:
        selected_model = model or _default_qwen_generate_model()
        return client.generate(prompt, output_path, size, selected_model)

    return [qwen_image_understand, qwen_image_image_understand, qwen_image_generate]


__all__ = ["build_qwen_tools"]
