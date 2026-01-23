"""Qwen image client runnable inside the sandbox."""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
from pathlib import Path
from typing import Any

import requests

_RESULT_PREFIX = "RESULT_JSON:"


class QwenImageClient:
    """Client for Qwen image endpoints."""

    def __init__(self, api_key: str, api_base: str | None = None) -> None:
        self._api_key = api_key
        self._api_base = api_base or "https://dashscope.aliyuncs.com"
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    def _post(self, path: str, payload: dict[str, Any]) -> tuple[bool, dict[str, Any], int | None]:
        url = f"{self._api_base}{path}"
        resp = requests.post(url, headers=self._headers, json=payload, timeout=60)
        try:
            data = resp.json()
        except Exception:
            data = {"raw_text": resp.text}
        return resp.ok, data, resp.status_code

    def _get(self, path: str) -> dict[str, Any] | None:
        url = f"{self._api_base}{path}"
        resp = requests.get(url, headers=self._headers, timeout=60)
        try:
            return resp.json()
        except Exception:
            return None

    def understand(self, image_path: str, prompt: str, model: str) -> dict[str, Any]:
        if not os.path.isfile(image_path):
            return {"success": False, "error": f"Image not found: {image_path}"}

        with open(image_path, "rb") as f:
            image_bytes = f.read()
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        ext = Path(image_path).suffix.lstrip(".").lower() or "png"
        image_data_url = f"data:image/{ext};base64,{image_b64}"

        payload = {
            "model": model,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"image": image_data_url},
                            {"text": prompt},
                        ],
                    }
                ]
            },
        }

        ok, data, status_code = self._post(
            "/api/v1/services/aigc/multimodal-generation/generation",
            payload,
        )

        text = ""
        output = data.get("output") if isinstance(data, dict) else None
        if isinstance(output, dict):
            choices = output.get("choices") or []
            if choices:
                message = choices[0].get("message", {})
                content = message.get("content") if isinstance(message, dict) else None
                if isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and "text" in part:
                            text = part["text"]
                            break
                elif isinstance(content, str):
                    text = content

        result = {
            "success": bool(ok),
            "status_code": status_code,
            "text": text,
            "request_id": data.get("request_id") if isinstance(data, dict) else None,
        }
        if not ok:
            result["error"] = data.get("message") if isinstance(data, dict) else "Request failed"
        return result

    def generate(
        self,
        prompt: str,
        output_path: str,
        size: str,
        model: str,
    ) -> dict[str, Any]:
        payload = {
            "model": model,
            "input": {
                "prompt": prompt,
                "size": size,
            },
        }
        ok, data, _status = self._post(
            "/api/v1/services/aigc/text2image/generation",
            payload,
        )
        output = data.get("output", {}) if isinstance(data, dict) else {}
        task_id = output.get("task_id")
        task_status = output.get("task_status")

        if task_id and task_status not in ("SUCCEEDED", "FAILED"):
            for _ in range(60):
                time.sleep(2)
                poll_data = self._get(f"/api/v1/tasks/{task_id}")
                if not poll_data:
                    continue
                output = poll_data.get("output", {}) if isinstance(poll_data, dict) else {}
                task_status = output.get("task_status")
                if task_status in ("SUCCEEDED", "FAILED"):
                    break

        results = output.get("results") if isinstance(output, dict) else None
        image_url = None
        image_b64 = None
        if isinstance(results, list) and results:
            item = results[0]
            if isinstance(item, dict):
                image_url = item.get("url") or item.get("image_url")
                image_b64 = item.get("b64_json") or item.get("image") or item.get("base64")

        if not image_url and not image_b64:
            return {"success": False, "error": "No image returned", "task_id": task_id}

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        if image_b64:
            with open(output_path, "wb") as f:
                f.write(base64.b64decode(image_b64))
        else:
            try:
                image_resp = requests.get(image_url, timeout=60)
                image_resp.raise_for_status()
            except Exception as exc:
                return {"success": False, "error": str(exc), "task_id": task_id}
            with open(output_path, "wb") as f:
                f.write(image_resp.content)

        return {
            "success": bool(ok),
            "output_path": output_path,
            "task_id": task_id,
            "task_status": task_status,
        }


def _load_payload(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _emit_result(result: dict[str, Any]) -> None:
    print(_RESULT_PREFIX + json.dumps(result, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True, choices=["understand", "generate"])
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()

    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        _emit_result({"success": False, "error": "Missing DASHSCOPE_API_KEY"})
        return
    api_base = os.environ.get("DASHSCOPE_API_BASE")
    client = QwenImageClient(api_key=api_key, api_base=api_base)

    try:
        payload = _load_payload(args.payload)
    except Exception as exc:
        _emit_result({"success": False, "error": str(exc)})
        return

    try:
        if args.task == "understand":
            result = client.understand(
                image_path=payload.get("image_path", ""),
                prompt=payload.get("prompt", ""),
                model=payload.get("model", "qwen-image-max"),
            )
        else:
            result = client.generate(
                prompt=payload.get("prompt", ""),
                output_path=payload.get("output_path", ""),
                size=payload.get("size", "1024*1024"),
                model=payload.get("model", "qwen-image-max"),
            )
        _emit_result(result)
    except Exception as exc:
        _emit_result({"success": False, "error": str(exc)})


if __name__ == "__main__":
    main()
