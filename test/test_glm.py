"""Integration test for GLM chat completion (default: glm-5)."""

from __future__ import annotations

import os

import pytest
import requests

from conftest import load_models_config

# DEFAULT_MODEL = "glm-5"
DEFAULT_MODEL = "glm-4.7"
DEFAULT_PROMPT = "Reply with only one word: pong"


def _env_truthy(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _resolve_glm_api_key(glm: dict[str, str]) -> str:
    if os.getenv("GLM_API_KEY"):
        return os.getenv("GLM_API_KEY", "")
    if _env_truthy("GLM_USE_PROD_KEY"):
        return glm.get("api_key_prod", "") or glm.get("api_key", "")
    return glm.get("api_key", "") or glm.get("api_key_prod", "")


def test_glm5_chat_completions() -> None:
    config = load_models_config()
    glm = config.get("glm", {})

    api_key = _resolve_glm_api_key(glm)
    base_url = os.getenv("GLM_BASE_URL") or glm.get("base_url", "")
    model = os.getenv("GLM_MODEL") or glm.get("model", "") or DEFAULT_MODEL
    prompt = os.getenv("GLM_TEST_PROMPT") or DEFAULT_PROMPT

    if not api_key or not base_url:
        pytest.skip("Missing GLM credentials or base_url")

    response = requests.post(
        url=f"{base_url.rstrip('/')}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": 'glm-5',
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "max_tokens": 64,
        },
        timeout=60,
    )

    assert response.status_code == 200, (
        f"GLM request failed: status={response.status_code}, body={response.text[:500]}"
    )

    body = response.json()
    choices = body.get("choices", [])
    assert choices, f"No choices in response: {body}"

    content = (choices[0].get("message") or {}).get("content")
    assert isinstance(content, str) and content.strip(), f"Unexpected content: {body}"
