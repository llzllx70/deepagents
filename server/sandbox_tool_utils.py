"""Shared helpers for sandbox-backed tools."""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

from deepagents.backends.protocol import SandboxBackendProtocol

from .message_utils import truncate_string

_RESULT_PREFIX = "RESULT_JSON:"
_WORKSPACE_ROOT = Path("/workspace")


def _extract_result(output: str) -> dict[str, Any] | None:
    for line in reversed(output.splitlines()):
        if line.startswith(_RESULT_PREFIX):
            payload = line[len(_RESULT_PREFIX) :]
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                return None
    return None


def _truncate_text(text: str, limit: int = 4000) -> str:
    return truncate_string(text, limit, suffix="\n... (truncated)")


def _parse_sandbox_result(output: str, exit_code: int | None) -> dict[str, Any]:
    parsed = _extract_result(output)
    if parsed is None:
        return {
            "success": False,
            "error": "Sandbox script did not return structured output.",
            "exit_code": exit_code,
            "output": _truncate_text(output),
        }
    if exit_code not in (0, None) and parsed.get("success", True):
        parsed["success"] = False
        parsed.setdefault("error", f"Sandbox exit code {exit_code}")
    return parsed


def _run_python_in_sandbox(
    sandbox_backend: SandboxBackendProtocol,
    script: str,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    env_prefix = ""
    if env:
        assignments = [
            f"{key}={shlex.quote(value)}" for key, value in env.items() if value
        ]
        if assignments:
            env_prefix = " ".join(assignments) + " "
    command = f"{env_prefix}python3 - <<'PY'\n{script}\nPY"
    result = sandbox_backend.execute(command)
    return _parse_sandbox_result(result.output, result.exit_code)


def _ensure_workspace_path(path: str) -> str:
    candidate = Path(path)
    if candidate.is_absolute():
        return str(candidate)
    return str(_WORKSPACE_ROOT / candidate)


def _sync_to_host(
    sandbox_backend: SandboxBackendProtocol,
    workspace_dir: Path | None,
    container_path: str,
) -> str | None:
    if workspace_dir is None:
        return None
    path = Path(container_path)
    try:
        relative = path.relative_to(_WORKSPACE_ROOT)
    except ValueError:
        return None

    host_path = workspace_dir / relative
    if host_path.exists():
        return str(host_path)

    try:
        response = sandbox_backend.download_files([container_path])[0]
    except Exception:
        return None
    if response.error or response.content is None:
        return None

    host_path.parent.mkdir(parents=True, exist_ok=True)
    host_path.write_bytes(response.content)
    return str(host_path)


__all__ = [
    "_ensure_workspace_path",
    "_parse_sandbox_result",
    "_run_python_in_sandbox",
    "_sync_to_host",
]
