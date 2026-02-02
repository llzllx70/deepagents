"""Integration test for Qwen image generation via DashScope SDK."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import pytest

CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "model.yml"

DEFAULT_API_BASE = "https://dashscope.aliyuncs.com/api/v1"
DEFAULT_MODEL = "qwen-image-max"
DEFAULT_IMAGE_SIZE = "1664*928"
DEFAULT_NEGATIVE_PROMPT = (
    "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，"
    "人脸无细节，过度光滑，画面具有AI感。构图混乱。文字模糊，扭曲。"
)
DEFAULT_MESSAGES = [
    {
        "role": "user",
        "content": [
            {
                "text": (
                    "一副典雅庄重的对联悬挂于厅堂之中，房间是个安静古典的中式布置，桌子上放着一些青花瓷，"
                    "对联上左书“义本生知人机同道善思新”，右书“通云赋智乾坤启数高志远”， "
                    "横批“智启通义”，字体飘逸，在中间挂着一幅中国风的画作，内容是岳阳楼。"
                )
            }
        ],
    }
]
_IMAGE_DATA_KEYS = {"b64_json", "image", "base64"}


@lru_cache(maxsize=1)
def _load_models_config() -> dict[str, dict[str, str]]:
    if not CONFIG_PATH.is_file():
        return {}

    models: dict[str, dict[str, str]] = {}
    current_section = None
    current_model = None

    for raw_line in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            current_section = stripped.rstrip(":")
            current_model = None
            continue
        if current_section != "models":
            continue
        if indent == 2 and stripped.endswith(":"):
            current_model = stripped[:-1].strip()
            models.setdefault(current_model, {})
            continue
        if indent == 4 and ":" in stripped and current_model:
            raw_key, raw_value = stripped.split(":", 1)
            value = raw_value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            models[current_model][raw_key.strip()] = value

    return models


def _sanitize_payload(payload: Any) -> Any:
    if isinstance(payload, dict):
        sanitized = {key: _sanitize_payload(value) for key, value in payload.items()}
        results = sanitized.get("results")
        if isinstance(results, list):
            trimmed_results: list[Any] = []
            for item in results:
                if isinstance(item, dict):
                    trimmed_results.append({key: value for key, value in item.items() if key not in _IMAGE_DATA_KEYS})
                else:
                    trimmed_results.append(item)
            sanitized["results"] = trimmed_results
        return sanitized
    if isinstance(payload, list):
        return [_sanitize_payload(item) for item in payload]
    return payload


def _response_payload(response: Any) -> Any:
    if isinstance(response, dict):
        return response
    to_dict = getattr(response, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return getattr(response, "__dict__", str(response))


def test_qwen_image_generation() -> None:
    models = _load_models_config()
    qwen_image = models.get("qwen-image-max", {})

    api_key = os.getenv("DASHSCOPE_API_KEY") or qwen_image.get("api_key", "")
    if not api_key:
        pytest.skip("DASHSCOPE_API_KEY not set")

    try:
        import dashscope
        from dashscope import MultiModalConversation
    except ModuleNotFoundError:
        pytest.skip("dashscope is not installed")

    api_base = os.getenv("DASHSCOPE_API_BASE") or qwen_image.get("base_url", "") or DEFAULT_API_BASE
    model = os.getenv("QWEN_IMAGE_MODEL") or qwen_image.get("model", "") or DEFAULT_MODEL

    dashscope.base_http_api_url = api_base

    response = MultiModalConversation.call(
        api_key=api_key,
        model=model,
        messages=DEFAULT_MESSAGES,
        result_format="message",
        stream=False,
        watermark=False,
        prompt_extend=True,
        negative_prompt=DEFAULT_NEGATIVE_PROMPT,
        size=DEFAULT_IMAGE_SIZE,
    )

    status_code = getattr(response, "status_code", None)
    if status_code != 200:
        code = getattr(response, "code", None)
        message = getattr(response, "message", None)
        pytest.fail(f"DashScope error: status={status_code} code={code} message={message}")

    payload = _sanitize_payload(_response_payload(response))
    try:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    except TypeError:
        print(payload)
