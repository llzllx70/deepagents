"""Integration test for OpenRouter free model access."""

from __future__ import annotations

import logging
import os

import pytest
from langchain_openai import ChatOpenAI
from langchain_core.globals import set_debug, set_verbose

from conftest import load_models_config

def test_openrouter_free_model() -> None:
    config = load_models_config()
    openrouter = config.get("openrouter", {})

    api_key = os.getenv("OPENROUTER_API_KEY") or openrouter.get("api_key", "")
    if not api_key:
        pytest.skip("OPENROUTER_API_KEY not set")

    os.environ.setdefault("OPENAI_LOG", "debug")
    logging.basicConfig(level=logging.DEBUG)
    set_debug(True)
    set_verbose(True)

    model_name = openrouter.get("model", "qwen/qwen3-4b:free")
    base_url = openrouter.get("base_url", "https://openrouter.ai/api/v1")
    referer = openrouter.get("referer", "http://localhost")
    title = openrouter.get("title", "deepagents-cli-tests")

    print(f"[openrouter] model={model_name} base_url={base_url} max_tokens=32")

    model = ChatOpenAI(
        model=model_name,
        api_key=api_key,
        base_url=base_url,
        default_headers={
            "HTTP-Referer": referer,
            "X-Title": title,
        },
        max_tokens=32,
        model_kwargs={
            "max_completion_tokens": 32,
        },
        temperature=0,
    )

    # response = model.invoke("Reply with only the word: pong")
    response = model.invoke("1+1=?")
    print(f"[openrouter] response={response.content!r}")
    assert isinstance(response.content, str)
    # assert "pong" in response.content.lower()


def test_2():
    config = load_models_config()
    openrouter = config.get("openrouter", {})
    api_key = os.getenv("OPENROUTER_API_KEY") or openrouter.get("api_key", "")
    if not api_key:
        pytest.skip("OPENROUTER_API_KEY not set")

    base_url = openrouter.get("base_url", "https://openrouter.ai/api/v1")
    model_name = openrouter.get("model", "qwen/qwen3-4b:free")
    import requests
    import json

    response = requests.post(
        url=f"{base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        data=json.dumps(
            {
                "model": model_name,
                "messages": [
                    {"role": "user", "content": "What is the meaning of life?"}
                ],
                "max_completion_tokens": 10000,
            }
        ),
    )

    print(f"[openrouter] status={response.status_code}")
    # print(f"[openrouter] headers={dict(response.headers)}")
    try:
        response_json = response.json()
    except json.JSONDecodeError:
        print(f"[openrouter] body={response.text!r}")
    else:
        print("[openrouter] body_json=")
        print(json.dumps(response_json, ensure_ascii=True, indent=2, sort_keys=True))

def test_wildcard():
    
    config = load_models_config()
    claude = config.get("claude", {})
    api_key = os.getenv("CLAUDE_API_KEY") or claude.get("api_key", "")
    base_url = claude.get("base_url", "")
    model = claude.get("model", "")
    if not api_key or not base_url or not model:
        pytest.skip("CLAUDE_API_KEY or claude config not set")

    import requests
    import json

    response = requests.post(
        url=f"{base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        data=json.dumps(
            {
                "model": model,
                "messages": [
                    {"role": "user", "content": "What is the meaning of life?"}
                ],
                "max_completion_tokens": 100,
            }
        ),
    )

    print(f"[openrouter] status={response.status_code}")
    # print(f"[openrouter] headers={dict(response.headers)}")
    try:
        response_json = response.json()
    except json.JSONDecodeError:
        print(f"[openrouter] body={response.text!r}")
    else:
        print("[openrouter] body_json=")
        print(json.dumps(response_json, ensure_ascii=True, indent=2, sort_keys=True))
