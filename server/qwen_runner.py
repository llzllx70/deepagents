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
_IMAGE_DATA_KEYS = {"b64_json", "image", "base64"}
_IMAGE_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


class QwenImageClient:
    """Client for Qwen image endpoints."""

    def __init__(self, api_key: str, api_base: str | None = None) -> None:
        self._api_key = api_key
        self._api_base = api_base or "https://dashscope.aliyuncs.com/api/v1"
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    def _build_url(self, path: str) -> str:
        base = self._api_base.rstrip("/")
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{base}{path}"

    def _is_compatible_mode(self) -> bool:
        return "compatible-mode" in self._api_base

    def _post(self, path: str, payload: dict[str, Any]) -> tuple[bool, dict[str, Any], int | None]:
        url = self._build_url(path)
        resp = requests.post(url, headers=self._headers, json=payload, timeout=60)
        try:
            data = resp.json()
        except Exception:
            data = {"raw_text": resp.text}
        return resp.ok, data, resp.status_code

    def _get(self, path: str) -> dict[str, Any] | None:
        url = self._build_url(path)
        resp = requests.get(url, headers=self._headers, timeout=60)
        try:
            return resp.json()
        except Exception:
            return None

    def _extract_image_from_results(
        self, output: dict[str, Any] | None
    ) -> tuple[str | None, str | None]:
        results = output.get("results") if isinstance(output, dict) else None
        if not isinstance(results, list) or not results:
            return None, None
        item = results[0]
        if not isinstance(item, dict):
            return None, None
        image_url = item.get("url") or item.get("image_url")
        image_b64 = item.get("b64_json") or item.get("image") or item.get("base64")
        return image_url, image_b64

    def _extract_image_from_content(self, content: Any) -> tuple[str | None, str | None]:
        if isinstance(content, list):
            for part in content:
                image_url, image_b64 = self._extract_image_from_part(part)
                if image_url or image_b64:
                    return image_url, image_b64
        elif isinstance(content, dict):
            return self._extract_image_from_part(content)
        return None, None

    def _extract_image_from_part(self, part: Any) -> tuple[str | None, str | None]:
        if not isinstance(part, dict):
            return None, None
        image_url = None
        image_b64 = None
        image_url_part = part.get("image_url")
        if isinstance(image_url_part, dict):
            image_url = image_url_part.get("url")
        elif isinstance(image_url_part, str):
            image_url = image_url_part
        for key in ("url", "image"):
            value = part.get(key)
            if isinstance(value, str) and value:
                if value.startswith("http"):
                    image_url = value
                elif value.startswith("data:image/"):
                    image_b64 = value.split(",", 1)[-1]
                else:
                    image_b64 = value
        for key in ("b64_json", "base64"):
            value = part.get(key)
            if isinstance(value, str) and value:
                image_b64 = value
        return image_url, image_b64

    def _extract_image_from_multimodal(self, data: dict[str, Any]) -> tuple[str | None, str | None]:
        output = data.get("output") if isinstance(data, dict) else None
        if not isinstance(output, dict):
            return None, None
        choices = output.get("choices")
        if not isinstance(choices, list):
            return None, None
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            image_url, image_b64 = self._extract_image_from_content(content)
            if image_url or image_b64:
                return image_url, image_b64
        return None, None

    def _extract_first_image(
        self,
        data: dict[str, Any] | None,
        output: dict[str, Any] | None = None,
    ) -> tuple[str | None, str | None]:
        """Try all extraction strategies and return the first image found.

        Attempts multimodal (choices) format first, then results-array format.
        """
        if isinstance(data, dict):
            image_url, image_b64 = self._extract_image_from_multimodal(data)
            if image_url or image_b64:
                return image_url, image_b64
        if output is None and isinstance(data, dict):
            output = data.get("output")
            if not isinstance(output, dict):
                output = None
        if output is not None:
            image_url, image_b64 = self._extract_image_from_results(output)
            if image_url or image_b64:
                return image_url, image_b64
        return None, None

    def _write_image(
        self,
        output_path: str,
        image_url: str | None,
        image_b64: str | None,
    ) -> dict[str, Any] | None:
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        if image_url and image_url.startswith("data:image/"):
            image_b64 = image_url.split(",", 1)[-1]
            image_url = None
        if image_b64:
            with open(output_path, "wb") as f:
                f.write(base64.b64decode(image_b64))
            return None
        if image_url:
            try:
                image_resp = requests.get(image_url, timeout=60)
                image_resp.raise_for_status()
            except Exception as exc:
                return {"success": False, "error": str(exc)}
            with open(output_path, "wb") as f:
                f.write(image_resp.content)
            return None
        return {"success": False, "error": "No image returned"}

    def understand(self, image_path: str, prompt: str, model: str) -> dict[str, Any]:
        if not os.path.isfile(image_path):
            return {"success": False, "error": f"Image not found: {image_path}"}

        with open(image_path, "rb") as f:
            image_bytes = f.read()
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        suffix = Path(image_path).suffix.lower()
        mime = _IMAGE_MIME_BY_SUFFIX.get(suffix, "image/png")
        image_data_url = f"data:{mime};base64,{image_b64}"

        if self._is_compatible_mode():
            payload = {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": image_data_url}},
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
            }
            ok, data, status_code = self._post("/chat/completions", payload)
        else:
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
                "/services/aigc/multimodal-generation/generation",
                payload,
            )

        text = ""
        if isinstance(data, dict):
            if self._is_compatible_mode():
                choices = data.get("choices") or []
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
            else:
                output = data.get("output")
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
            error_message = None
            if isinstance(data, dict):
                error = data.get("error")
                if isinstance(error, dict):
                    error_message = error.get("message")
                if not error_message:
                    error_message = data.get("message")
            result["error"] = error_message or "Request failed"
            result["response_summary"] = _summarize_response(data)
        return result

    def generate(
        self,
        prompt: str,
        output_path: str,
        size: str,
        model: str,
    ) -> dict[str, Any]:
        multimodal_payload = {
            "model": model,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"text": prompt},
                        ],
                    }
                ]
            },
            "parameters": {
                "size": size,
                "result_format": "message",
                "watermark": False,
                "prompt_extend": True,
            },
        }
        ok, data, status_code = self._post(
            "/services/aigc/multimodal-generation/generation",
            multimodal_payload,
        )
        output = data.get("output", {}) if isinstance(data, dict) else {}
        task_id = output.get("task_id")
        task_status = output.get("task_status")
        response_summary = _summarize_response(data)

        if task_id and task_status not in ("SUCCEEDED", "FAILED"):
            for _ in range(60):
                time.sleep(2)
                poll_data = self._get(f"/tasks/{task_id}")
                if not poll_data:
                    continue
                output = poll_data.get("output", {}) if isinstance(poll_data, dict) else {}
                response_summary = _summarize_response(poll_data) or response_summary
                task_status = output.get("task_status")
                if task_status in ("SUCCEEDED", "FAILED"):
                    data = poll_data
                    break

        image_url, image_b64 = self._extract_first_image(data, output)
        if not image_url and not image_b64:
            fallback = self._generate_text2image(prompt, output_path, size, model)
            if fallback.get("success"):
                return fallback
            result = {
                "success": False,
                "error": "No image returned",
                "task_id": task_id,
                "task_status": task_status,
                "status_code": status_code,
                "request_id": data.get("request_id") if isinstance(data, dict) else None,
                "response_summary": response_summary,
            }
            result["fallback"] = {
                "error": fallback.get("error"),
                "status_code": fallback.get("status_code"),
                "response_summary": fallback.get("response_summary"),
            }
            return result

        write_error = self._write_image(output_path, image_url, image_b64)
        if write_error:
            write_error["task_id"] = task_id
            return write_error

        return {
            "success": True,
            "output_path": output_path,
            "task_id": task_id,
            "task_status": task_status,
            "status_code": status_code,
            "request_id": data.get("request_id") if isinstance(data, dict) else None,
            "response_summary": response_summary,
        }

    def _generate_text2image(
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
            },
            "parameters": {
                "size": size,
            },
        }
        ok, data, status_code = self._post(
            "/services/aigc/text2image/generation",
            payload,
        )
        output = data.get("output", {}) if isinstance(data, dict) else {}
        task_id = output.get("task_id")
        task_status = output.get("task_status")
        response_summary = _summarize_response(data)

        if task_id and task_status not in ("SUCCEEDED", "FAILED"):
            for _ in range(60):
                time.sleep(2)
                poll_data = self._get(f"/tasks/{task_id}")
                if not poll_data:
                    continue
                output = poll_data.get("output", {}) if isinstance(poll_data, dict) else {}
                response_summary = _summarize_response(poll_data) or response_summary
                task_status = output.get("task_status")
                if task_status in ("SUCCEEDED", "FAILED"):
                    break

        image_url, image_b64 = self._extract_first_image(data, output)

        if not image_url and not image_b64:
            return {
                "success": False,
                "error": "No image returned",
                "task_id": task_id,
                "task_status": task_status,
                "status_code": status_code,
                "request_id": data.get("request_id") if isinstance(data, dict) else None,
                "response_summary": response_summary,
            }

        write_error = self._write_image(output_path, image_url, image_b64)
        if write_error:
            write_error["task_id"] = task_id
            return write_error

        return {
            "success": bool(ok),
            "output_path": output_path,
            "task_id": task_id,
            "task_status": task_status,
            "status_code": status_code,
            "request_id": data.get("request_id") if isinstance(data, dict) else None,
            "response_summary": response_summary,
        }


def _sanitize_output(output: Any) -> Any:
    if not isinstance(output, dict):
        return output
    sanitized = dict(output)
    results = sanitized.get("results")
    if isinstance(results, list):
        trimmed_results: list[Any] = []
        for item in results:
            if isinstance(item, dict):
                trimmed_results.append(
                    {key: value for key, value in item.items() if key not in _IMAGE_DATA_KEYS}
                )
            else:
                trimmed_results.append(item)
        sanitized["results"] = trimmed_results
    choices = sanitized.get("choices")
    if isinstance(choices, list):
        trimmed_choices: list[Any] = []
        for choice in choices:
            if not isinstance(choice, dict):
                trimmed_choices.append(choice)
                continue
            choice_copy = dict(choice)
            message = choice_copy.get("message")
            if isinstance(message, dict):
                message_copy = dict(message)
                content = message_copy.get("content")
                if isinstance(content, list):
                    trimmed_content: list[Any] = []
                    for part in content:
                        if isinstance(part, dict):
                            trimmed_content.append(
                                {key: value for key, value in part.items() if key not in _IMAGE_DATA_KEYS}
                            )
                        else:
                            trimmed_content.append(part)
                    message_copy["content"] = trimmed_content
                elif isinstance(content, dict):
                    message_copy["content"] = {
                        key: value for key, value in content.items() if key not in _IMAGE_DATA_KEYS
                    }
                choice_copy["message"] = message_copy
            trimmed_choices.append(choice_copy)
        sanitized["choices"] = trimmed_choices
    return sanitized


def _summarize_response(data: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    summary: dict[str, Any] = {}
    for key in ("request_id", "code", "message", "output", "usage"):
        if key in data:
            summary[key] = _sanitize_output(data[key]) if key == "output" else data[key]
    return summary or None


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
                model=payload.get("model", "qwen3-vl-plus"),
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
