"""Integration test using Playwright to navigate and scroll."""

from __future__ import annotations

import math
from dataclasses import dataclass
import os
from typing import Any

import pytest

DEFAULT_NAV_URL = "https://www.sina.com.cn"
DEFAULT_SCROLL_OFFSET = 800
SCROLL_STEP_DELAY_SECONDS = 0.6
SCROLL_MAX_STEPS = 60
SCROLL_BOTTOM_THRESHOLD_PX = 2
METRICS_SCRIPT = (
    "(() => {"
    "const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;"
    "const innerHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight || 0;"
    "const scrollHeight = Math.max(document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0);"
    "return {scrollTop, innerHeight, scrollHeight};"
    "})()"
)
SCROLL_TO_BOTTOM_SCRIPT = "window.scrollTo(0, document.body.scrollHeight);"


@dataclass(frozen=True)
class PageMetrics:
    scroll_top: float
    scroll_height: float
    inner_height: float


def _as_float(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _extract_metrics(payload: Any) -> PageMetrics | None:
    if not isinstance(payload, dict):
        return None
    scroll_height = _as_float(payload.get("scrollHeight"))
    inner_height = _as_float(payload.get("innerHeight"))
    if scroll_height is None or inner_height is None:
        return None
    if scroll_height <= 0 or inner_height <= 0:
        return None
    scroll_top = _as_float(payload.get("scrollTop"))
    if scroll_top is None:
        scroll_top = 0.0
    return PageMetrics(scroll_top=scroll_top, scroll_height=scroll_height, inner_height=inner_height)


def _scroll_script(default_offset: int) -> str:
    return (
        "(() => {"
        f"const fallback = {default_offset};"
        "const step = Math.max(1, window.innerHeight || document.documentElement.clientHeight || "
        "document.body.clientHeight || fallback);"
        "window.scrollBy(0, step);"
        "return step;"
        "})()"
    )


def _is_at_bottom(metrics: PageMetrics) -> bool:
    return metrics.scroll_top + metrics.inner_height >= metrics.scroll_height - SCROLL_BOTTOM_THRESHOLD_PX


def _estimate_max_steps(metrics: PageMetrics) -> int:
    remaining = max(0.0, metrics.scroll_height - (metrics.scroll_top + metrics.inner_height))
    if metrics.inner_height <= 0:
        return SCROLL_MAX_STEPS
    steps = math.ceil(remaining / metrics.inner_height)
    return max(1, min(SCROLL_MAX_STEPS, steps + 2))


def _should_skip_error(message: str) -> bool:
    lowered = message.lower()
    return "executable doesn't exist" in lowered or "playwright install" in lowered


def _env_truthy(name: str) -> bool:
    value = os.getenv(name, "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _run_playwright_scroll() -> None:
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError:
        pytest.skip("playwright is not installed")

    try:
        with sync_playwright() as p:
            headless = _env_truthy("PLAYWRIGHT_HEADLESS")
            if _env_truthy("PLAYWRIGHT_HEADFUL"):
                headless = False
            slow_mo = 0
            if not headless:
                slow_mo = int(os.getenv("PLAYWRIGHT_SLOW_MO_MS", "200"))
            browser = p.chromium.launch(headless=headless, slow_mo=slow_mo)
            try:
                page = browser.new_page()
                page.goto(DEFAULT_NAV_URL, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(1000)

                payload = page.evaluate(METRICS_SCRIPT)
                metrics = _extract_metrics(payload)

                scroll_offset = DEFAULT_SCROLL_OFFSET
                if metrics:
                    scroll_offset = max(1, int(metrics.inner_height))

                scroll_script = _scroll_script(scroll_offset)
                max_steps = SCROLL_MAX_STEPS if metrics is None else _estimate_max_steps(metrics)

                for _ in range(max_steps):
                    page.evaluate(scroll_script)
                    page.wait_for_timeout(int(SCROLL_STEP_DELAY_SECONDS * 1000))
                    payload = page.evaluate(METRICS_SCRIPT)
                    metrics = _extract_metrics(payload) or metrics
                    if metrics and _is_at_bottom(metrics):
                        break

                if metrics and not _is_at_bottom(metrics):
                    page.evaluate(SCROLL_TO_BOTTOM_SCRIPT)
            finally:
                browser.close()
    except PlaywrightError as exc:
        if _should_skip_error(str(exc)):
            pytest.skip("Playwright browsers are not installed. Run `playwright install`.")
        raise


def test_playwright_smoke() -> None:
    _run_playwright_scroll()
