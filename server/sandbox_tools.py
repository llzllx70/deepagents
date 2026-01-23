"""Sandbox-only tools for media processing and conversions."""

from __future__ import annotations

import base64
import json
import textwrap
import uuid
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool, tool

from deepagents.backends.protocol import SandboxBackendProtocol

from .sandbox_tool_utils import (
    _ensure_workspace_path,
    _run_python_in_sandbox,
    _sync_to_host,
)


def build_sandbox_tools(
    *, sandbox_backend: SandboxBackendProtocol, workspace_dir: Path | None = None
) -> list[BaseTool]:
    """Build sandbox-backed tools that execute inside the container."""

    @tool(
        "pdf_to_word",
        description=(
            "Convert a PDF to DOCX inside the sandbox. Provide pdf_path and optional output_path."
        ),
    )
    def pdf_to_word(
        pdf_path: str,
        output_path: str | None = None,
    ) -> dict[str, Any]:
        pdf_path = _ensure_workspace_path(pdf_path)
        if not output_path:
            stem = Path(pdf_path).stem or f"document_{uuid.uuid4().hex[:6]}"
            output_path = f"/workspace/converted/{stem}.docx"
        output_path = _ensure_workspace_path(output_path)

        args = {"pdf_path": pdf_path, "output_path": output_path}
        args_b64 = base64.b64encode(json.dumps(args).encode("utf-8")).decode("ascii")

        script = textwrap.dedent(
            f"""
            import base64
            import json
            import os
            from pdf2docx import Converter

            args = json.loads(base64.b64decode("{args_b64}").decode("utf-8"))
            pdf_path = args.get("pdf_path", "")
            output_path = args.get("output_path", "")

            if not os.path.isfile(pdf_path):
                print("RESULT_JSON:" + json.dumps({{"success": False, "error": f"PDF not found: {{pdf_path}}"}}, ensure_ascii=False))
                raise SystemExit(0)

            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
            try:
                converter = Converter(pdf_path)
                converter.convert(output_path)
                converter.close()
            except Exception as exc:
                print("RESULT_JSON:" + json.dumps({{"success": False, "error": str(exc)}}, ensure_ascii=False))
                raise SystemExit(0)

            print("RESULT_JSON:" + json.dumps({{"success": True, "output_path": output_path}}, ensure_ascii=False))
            """
        )
        result = _run_python_in_sandbox(sandbox_backend, script)
        output_path = result.get("output_path")
        if isinstance(output_path, str):
            host_path = _sync_to_host(sandbox_backend, workspace_dir, output_path)
            if host_path:
                result["host_path"] = host_path
        return result

    return [pdf_to_word]


__all__ = ["build_sandbox_tools"]
