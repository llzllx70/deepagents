"""Integration test: VLM-guided browsing with Playwright."""

from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from openai import OpenAI

DEFAULT_NAV_URL = "https://www.zhipin.com/hangzhou/?seoRefer=index"
DEFAULT_VIEWPORT = {"width": 1280, "height": 720}
MAX_LINK_CANDIDATES = 40
MAX_STEPS = 8
MAX_DEPTH = 3
INFO_LIMIT = 2
CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "model.yml"
PROMPT_MODEL_DEFAULT = "qwen3-vl-plus"
VLM_TARGET_QUERY = "搜索AI相关的职位详细信息"


@dataclass(frozen=True)
class LinkCandidate:
    dom_index: int
    text: str
    href: str


def _env_truthy(name: str) -> bool:
    value = os.getenv(name, "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _extract_index(text: str) -> int | None:
    if not text:
        return None
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            value = payload.get("index")
            if isinstance(value, int):
                return value
            if isinstance(value, str) and value.isdigit():
                return int(value)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\bindex\b\s*[:=]\s*(\d+)", text, flags=re.IGNORECASE)
    if match:
        return int(match.group(1))
    match = re.search(r"\b(\d+)\b", text)
    if match:
        return int(match.group(1))
    return None


def _extract_action(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    try:
        payload = json.loads(text)
        return payload if isinstance(payload, dict) else None
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return None
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _raise(message: str) -> None:
    raise RuntimeError(message)


def _load_models_config() -> dict[str, dict[str, str]]:
    if not CONFIG_PATH.is_file():
        pytest.skip(f"Missing model config file: {CONFIG_PATH}")

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


def _encode_image(path: Path) -> str:
    data = path.read_bytes()
    ext = path.suffix.lstrip(".").lower() or "png"
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:image/{ext};base64,{b64}"


def _vlm_request(image_path: Path, prompt: str) -> str:
    models = _load_models_config()
    config = models.get("qwen3-vl-plus", {})

    api_key = config.get("api_key") or os.getenv("QWEN3_VL_API_KEY", "")
    base_url = config.get("base_url") or os.getenv("QWEN3_VL_BASE_URL", "")
    model = config.get("model") or os.getenv("QWEN3_VL_MODEL", PROMPT_MODEL_DEFAULT)

    if not api_key or not base_url:
        pytest.skip("Missing qwen3-vl-plus config in config/model.yml")

    image_data_url = _encode_image(image_path)
    client = OpenAI(api_key=api_key, base_url=base_url)
    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": image_data_url}},
                    ],
                }
            ],
            max_tokens=200,
            temperature=0,
        )
    except Exception as exc:
        raise RuntimeError(f"VLM request failed: {exc}") from exc

    content = completion.choices[0].message.content or ""
    return str(content)


def _collect_link_candidates(page: Any) -> list[LinkCandidate]:
    raw_links = page.eval_on_selector_all(
        "a",
        """
        (els) => els.map((el, idx) => {
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
            return {
                idx,
                href: el.href || '',
                text,
                rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
                visible: rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0
            };
        })
        """,
    )
    candidates: list[LinkCandidate] = []
    for item in raw_links:
        if not isinstance(item, dict):
            continue
        if not item.get("visible"):
            continue
        text = str(item.get("text") or "").strip()
        href = str(item.get("href") or "").strip()
        if not href:
            continue
        candidates.append(
            LinkCandidate(
                dom_index=int(item.get("idx", 0)),
                text=text,
                href=href,
            )
        )
    return candidates[:MAX_LINK_CANDIDATES]


def _build_prompt(target: str, candidates: list[LinkCandidate]) -> str:
    lines = [
        "You are an agent that decides the next action based on a webpage screenshot.",
        "Return JSON only in one of the following forms:",
        '{"action":"extract","reason":"..."}',
        '{"action":"search","query":"...","reason":"..."}',
        '{"action":"click","index":<candidate_index>,"reason":"..."}',
        '{"action":"stop","reason":"..."}',
        f"Target description: {target}",
        "Candidates:",
    ]
    for i, cand in enumerate(candidates):
        text = cand.text or "(no text)"
        href = cand.href
        lines.append(f"{i}: text={text!r} href={href!r}")
    return "\n".join(lines)


def _build_state_prompt(step: int, depth: int, info_count: int, max_depth: int) -> str:
    return (
        f"State: step={step}, depth={depth}, info_count={info_count}.\n"
        f"Stop when info is sufficient or depth reaches {max_depth}."
    )


def _extract_basic_info(page: Any) -> dict[str, str]:
    title = page.title()
    body = page.eval_on_selector("body", "(el) => el.innerText || ''") or ""
    body = body.strip()
    if len(body) > 2000:
        body = body[:2000]
    return {"title": title, "url": page.url, "body": body}


def _try_search(page: Any, query: str) -> bool:
    selectors = [
        "input[type='search']",
        "input[placeholder*='搜索']",
        "input[placeholder*='Search']",
        "input[name*='search']",
        "input[name*='query']",
        "input[type='text']",
        "textarea",
    ]
    for sel in selectors:
        locator = page.locator(sel)
        try:
            count = locator.count()
        except Exception:
            count = 0
        for idx in range(count):
            item = locator.nth(idx)
            try:
                if not item.is_visible():
                    continue
                if not item.is_enabled():
                    continue
                item.click(timeout=1000)
                item.fill(query, timeout=1000)
                page.keyboard.press("Enter")
                page.wait_for_load_state("domcontentloaded")
                return True
            except Exception:
                continue

    try:
        role_boxes = page.get_by_role("textbox")
        count = role_boxes.count()
    except Exception:
        count = 0
    for idx in range(count):
        item = role_boxes.nth(idx)
        try:
            if not item.is_visible():
                continue
            if not item.is_enabled():
                continue
            item.click(timeout=1000)
            item.fill(query, timeout=1000)
            page.keyboard.press("Enter")
            page.wait_for_load_state("domcontentloaded")
            return True
        except Exception:
            continue
    return False


def _run_vlm_click() -> None:
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError:
        pytest.skip("playwright is not installed")

    target = os.getenv("VLM_TARGET_QUERY", VLM_TARGET_QUERY).strip()
    if not target:
        pytest.skip("VLM_TARGET_QUERY not set (describe which link to click)")

    entry_url = os.getenv("VLM_ENTRY_URL", DEFAULT_NAV_URL).strip() or DEFAULT_NAV_URL
    max_steps = int(os.getenv("VLM_MAX_STEPS", str(MAX_STEPS)))
    max_depth = int(os.getenv("VLM_MAX_DEPTH", str(MAX_DEPTH)))
    info_limit = int(os.getenv("VLM_INFO_LIMIT", str(INFO_LIMIT)))

    headless = _env_truthy("PLAYWRIGHT_HEADLESS")
    if _env_truthy("PLAYWRIGHT_HEADFUL"):
        headless = False
    slow_mo = 0
    if not headless:
        slow_mo = int(os.getenv("PLAYWRIGHT_SLOW_MO_MS", "200"))

    screenshot_dir = Path(__file__).resolve().parents[1] / "workspace" / "vlm_click"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    screenshot_path = screenshot_dir / "page.png"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless, slow_mo=slow_mo)
            try:
                context = browser.new_context(viewport=DEFAULT_VIEWPORT)
                page = context.new_page()
                page.goto(entry_url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_load_state("networkidle")

                info_collected: list[dict[str, str]] = []
                visited: set[str] = set()
                depth = 0

                for step in range(1, max_steps + 1):
                    if len(info_collected) >= info_limit or depth >= max_depth:
                        break

                    page.screenshot(path=str(screenshot_path), full_page=False)
                    candidates = _collect_link_candidates(page)
                    prompt = _build_prompt(target, candidates)
                    prompt = f"{_build_state_prompt(step, depth, len(info_collected), max_depth)}\n{prompt}"

                    response_text = _vlm_request(screenshot_path, prompt)
                    action_payload = _extract_action(response_text)
                    if not action_payload:
                        _raise("VLM did not return a valid JSON action payload")

                    action = str(action_payload.get("action") or "").lower()
                    if action == "stop":
                        break

                    if action == "extract":
                        info_collected.append(_extract_basic_info(page))
                        continue

                    if action == "search":
                        query = str(action_payload.get("query") or "").strip()
                        if not query:
                            _raise("VLM search action missing query")
                        if not _try_search(page, query):
                            _raise("Failed to locate search input for VLM query")
                        continue

                    if action == "click":
                        index = _extract_index(str(action_payload.get("index") or ""))
                        if index is None or index < 0 or index >= len(candidates):
                            _raise("VLM click action returned invalid index")
                        target_candidate = candidates[index]
                        href = target_candidate.href or ""
                        if href and href not in visited:
                            visited.add(href)
                        page.locator("a").nth(target_candidate.dom_index).click()
                        page.wait_for_load_state("domcontentloaded")
                        depth += 1
                        continue

                    _raise(f"Unsupported action from VLM: {action!r}")
            finally:
                browser.close()
    except PlaywrightError as exc:
        lowered = str(exc).lower()
        if "executable doesn't exist" in lowered or "playwright install" in lowered:
            pytest.skip("Playwright browsers are not installed. Run `playwright install`.")
        raise


def test_playwright_vlm_click() -> None:
    _run_vlm_click()
