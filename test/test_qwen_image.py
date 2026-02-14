"""Integration test for Qwen image generation via DashScope SDK."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
import base64

import pytest

from conftest import load_models_config

DEFAULT_API_BASE = "https://dashscope.aliyuncs.com/api/v1"
DEFAULT_COMPAT_API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
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
DEFAULT_UNDERSTAND_MODEL = "qwen3-vl-plus"
DEFAULT_UNDERSTAND_PROMPT = "请详细描述图片内容，并提取其中的文字信息。"
DEFAULT_UNDERSTAND_IMAGE = Path(__file__).resolve().parents[1] / "web" / "logo.png"
_IMAGE_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def _load_models_config() -> dict[str, dict[str, str]]:
    return load_models_config()


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


def _image_to_data_url(image_path: str) -> str:
    suffix = Path(image_path).suffix.lower()
    mime = _IMAGE_MIME_BY_SUFFIX.get(suffix, "image/png")
    with open(image_path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("utf-8")
    return f"data:{mime};base64,{encoded}"


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


def test_qwen_image_understand() -> None:
    models = _load_models_config()
    qwen_understand = models.get("qwen3-vl-plus", {})

    api_key = os.getenv("DASHSCOPE_API_KEY") or qwen_understand.get("api_key", "")
    if not api_key:
        pytest.skip("DASHSCOPE_API_KEY not set")

    try:
        from openai import OpenAI
    except ModuleNotFoundError:
        pytest.skip("openai is not installed")

    api_base = os.getenv("DASHSCOPE_API_BASE") or qwen_understand.get("base_url", "") or DEFAULT_COMPAT_API_BASE
    model = os.getenv("QWEN_IMAGE_UNDERSTAND_MODEL") or qwen_understand.get("model", "") or DEFAULT_UNDERSTAND_MODEL

    image_path = os.getenv("QWEN_IMAGE_UNDERSTAND_PATH")
    if image_path:
        image_path = str(Path(image_path).expanduser())
    else:
        image_path = str(DEFAULT_UNDERSTAND_IMAGE)

    if not Path(image_path).is_file():
        pytest.skip(f"Image not found: {image_path}")

    image_url = _image_to_data_url(image_path)
    client = OpenAI(api_key=api_key, base_url=api_base)
    completion = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_url}},
                    {"type": "text", "text": DEFAULT_UNDERSTAND_PROMPT},
                ],
            }
        ],
    )

    text = completion.choices[0].message.content
    print(json.dumps(completion.model_dump(), ensure_ascii=False, indent=2, sort_keys=True))
    assert isinstance(text, str)
    assert text.strip()
