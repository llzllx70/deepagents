"""Integration test: VLM-guided browsing with Playwright."""

from __future__ import annotations

import base64
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

DEFAULT_NAV_URL = "https://www.zhipin.com/hangzhou/?seoRefer=index"
# DEFAULT_NAV_URL = "https://www.sina.com.cn"
DEFAULT_VIEWPORT = {"width": 1280, "height": 720}
DEFAULT_LOCALE = "zh-CN"
DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_0) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
DEFAULT_USER_DATA_DIR = Path(__file__).resolve().parents[1] / "workspace" / "playwright_profile"
DEFAULT_CHROME_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--no-first-run",
    "--no-default-browser-check",
]
MAX_LINK_CANDIDATES = 80
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


def _env_truthy_default(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    return value in {"1", "true", "yes", "on"}


def _guess_accept_language(locale: str) -> str:
    if not locale:
        return "en-US,en;q=0.9"
    if locale.lower().startswith("zh"):
        return "zh-CN,zh;q=0.9,en;q=0.8"
    if locale.lower().startswith("ja"):
        return "ja-JP,ja;q=0.9,en;q=0.8"
    if locale.lower().startswith("ko"):
        return "ko-KR,ko;q=0.9,en;q=0.8"
    return f"{locale},{locale.split('-')[0]};q=0.9,en;q=0.8"


def _chrome_args() -> list[str]:
    extra = os.getenv("PLAYWRIGHT_EXTRA_ARGS", "").strip()
    args = list(DEFAULT_CHROME_ARGS)
    if extra:
        for raw in extra.split(","):
            item = raw.strip()
            if item:
                args.append(item)
    return args


def _stealth_script() -> str:
    return """
(() => {
  Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
  Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en-US', 'en']});
  Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
  Object.defineProperty(navigator, 'platform', {get: () => 'MacIntel'});
  Object.defineProperty(navigator, 'vendor', {get: () => 'Google Inc.'});
  Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8});
  Object.defineProperty(navigator, 'deviceMemory', {get: () => 8});
  Object.defineProperty(navigator, 'maxTouchPoints', {get: () => 0});
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => {
    if (parameters && parameters.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission });
    }
    return originalQuery(parameters);
  };
})();
"""


def _guard_nav_script(
    block_blank: bool,
    prevent_close: bool,
    log_nav: bool,
    force_same_tab: bool,
) -> str:
    from string import Template

    template = Template(
        """
(() => {
  const blockBlank = $block_blank;
  const preventClose = $prevent_close;
  const logNav = $log_nav;
  const forceSameTab = $force_same_tab;
  const shouldBlock = (url) => blockBlank && (url === 'about:blank' || url.startsWith('about:blank#'));
  const log = (label, url) => {
    if (!logNav) return;
    try {
      const stack = new Error().stack || '';
      console.warn('[vlm-guard]', label, url || '', stack);
    } catch (e) {}
  };
  const wrap = (obj, name) => {
    const orig = obj[name];
    if (!orig) return;
    obj[name] = function(url, ...rest) {
      const target = String(url || '');
      if (shouldBlock(target)) {
        log(name + ':blocked', target);
        return;
      }
      log(name, target);
      return orig.apply(this, [url, ...rest]);
    };
  };
  try { wrap(window.location, 'assign'); } catch (e) {}
  try { wrap(window.location, 'replace'); } catch (e) {}
  try {
    const origOpen = window.open;
    window.open = function(url, ...rest) {
      const target = String(url || '');
      log('window.open', target);
      if (forceSameTab) {
        if (target && !shouldBlock(target)) {
          window.location.assign(target);
        }
        return window;
      }
      return origOpen.apply(this, [url, ...rest]);
    };
  } catch (e) {}
  if (preventClose) {
    try {
      const origClose = window.close;
      window.close = function() {
        log('window.close', '');
        return undefined;
      };
      if (origClose && origClose.toString) {
        window.close.toString = () => 'function close() { [native code] }';
      }
    } catch (e) {}
  }
  try {
    const desc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (desc && desc.set && desc.get) {
      Object.defineProperty(window.location, 'href', {
        set: function(url) {
          const target = String(url || '');
          if (shouldBlock(target)) {
            log('location.href:blocked', target);
            return;
          }
          log('location.href', target);
          return desc.set.call(this, url);
        },
        get: function() {
          return desc.get.call(this);
        }
      });
    }
  } catch (e) {}
})();
"""
    )
    return template.substitute(
        block_blank=str(block_blank).lower(),
        prevent_close=str(prevent_close).lower(),
        log_nav=str(log_nav).lower(),
        force_same_tab=str(force_same_tab).lower(),
    )


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


def _is_real_url(url: str) -> bool:
    if not url or url == "about:blank":
        return False
    if url.startswith("chrome-error://"):
        return False
    return url.startswith("http://") or url.startswith("https://")


def _attach_debug_listeners(context: Any, page: Any) -> None:
    if not _env_truthy("VLM_DEBUG"):
        return

    def _describe(p: Any) -> str:
        url = getattr(p, "url", "") or ""
        return f"id={id(p)} url={url!r}"

    def _log(message: str) -> None:
        print(f"[vlm-debug] {message}")

    def _wire(p: Any) -> None:
        _log(f"page.open {_describe(p)}")
        p.on("close", lambda: _log(f"page.close {_describe(p)}"))
        p.on("crash", lambda: _log(f"page.crash {_describe(p)}"))
        p.on("domcontentloaded", lambda: _log(f"page.domcontentloaded {_describe(p)}"))
        p.on("load", lambda: _log(f"page.load {_describe(p)}"))

        def _on_nav(frame: Any) -> None:
            try:
                if frame == p.main_frame:
                    _log(f"page.navigate {_describe(p)}")
            except Exception:
                _log(f"page.navigate {_describe(p)}")

        p.on("framenavigated", _on_nav)
        p.on("popup", lambda popup: _log(f"page.popup parent={_describe(p)} child={_describe(popup)}"))
        p.on(
            "requestfailed",
            lambda request: _log(
                f"request.failed url={request.url!r} type={request.resource_type} error={request.failure}"
            ),
        )
        p.on(
            "response",
            lambda response: _log(
                f"response url={response.url!r} status={response.status}"
            )
            if response.request.resource_type == "document"
            else None,
        )
        p.on(
            "console",
            lambda message: _log(f"console.{message.type} {message.text}")
            if "vlm-guard" in message.text or _env_truthy("VLM_DEBUG_CONSOLE_ALL")
            else None,
        )

    context.on("page", _wire)
    _wire(page)


def _wait_for_page_ready(page: Any, timeout_ms: int) -> None:
    try:
        page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
    except Exception:
        pass
    try:
        page.wait_for_load_state("networkidle", timeout=min(10000, timeout_ms))
    except Exception:
        pass


def _pick_non_blank_page(context: Any) -> Any | None:
    for candidate in reversed(getattr(context, "pages", []) or []):
        if candidate.is_closed():
            continue
        url = getattr(candidate, "url", "") or ""
        if url and url != "about:blank":
            return candidate
    return None


def _ensure_active_page(context: Any, page: Any) -> Any:
    if page.is_closed():
        return _pick_non_blank_page(context) or page
    if page.url and page.url != "about:blank":
        return page
    page.wait_for_timeout(500)
    return _pick_non_blank_page(context) or page


def _wait_for_real_page(context: Any, timeout_ms: int) -> Any | None:
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        candidate = _pick_non_blank_page(context)
        if candidate and _is_real_url(candidate.url):
            return candidate
        time.sleep(0.2)
    return None


def _goto_stable(context: Any, page: Any, url: str, timeout_ms: int, retries: int) -> Any:
    for attempt in range(1, retries + 1):
        if page.is_closed():
            page = context.new_page()
            _attach_debug_listeners(context, page)
        if _env_truthy("VLM_DEBUG"):
            print(f"[vlm-debug] goto attempt={attempt} url={url!r}")
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        except Exception:
            pass
        page = _ensure_active_page(context, page)
        _wait_for_page_ready(page, min(15000, timeout_ms))
        page = _ensure_active_page(context, page)
        if _is_real_url(page.url):
            return page
        replacement = _wait_for_real_page(context, 3000)
        if replacement:
            return replacement
    _raise(f"Failed to open a stable page for {url!r} after {retries} attempts")
    return page


def _wait_until_closed(page: Any) -> None:
    try:
        while not page.is_closed():
            page.wait_for_timeout(500)
    except Exception:
        pass


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

    try:
        from openai import OpenAI
    except ModuleNotFoundError:
        pytest.skip("openai is not installed")

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
    nav_retries = int(os.getenv("PLAYWRIGHT_NAV_RETRIES", "3"))
    nav_timeout_ms = int(os.getenv("PLAYWRIGHT_NAV_TIMEOUT_MS", "30000"))
    use_chrome = _env_truthy_default("PLAYWRIGHT_USE_CHROME", True)
    persistent = _env_truthy_default("PLAYWRIGHT_PERSISTENT", True)
    nav_only = _env_truthy_default("VLM_NAV_ONLY", False)
    block_blank = _env_truthy_default("PLAYWRIGHT_BLOCK_BLANK", True)
    prevent_close = _env_truthy_default("PLAYWRIGHT_PREVENT_CLOSE", True)
    log_nav = _env_truthy_default("PLAYWRIGHT_LOG_NAV", True)
    force_same_tab = _env_truthy_default("PLAYWRIGHT_FORCE_SAME_TAB", True)
    keep_open = _env_truthy_default("PLAYWRIGHT_KEEP_OPEN", True)
    cdp_url = os.getenv("PLAYWRIGHT_CDP_URL", "").strip()

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
            browser = None
            context = None
            close_browser = True
            close_context = True
            try:
                locale = os.getenv("PLAYWRIGHT_LOCALE", DEFAULT_LOCALE).strip() or DEFAULT_LOCALE
                timezone_id = os.getenv("PLAYWRIGHT_TIMEZONE", DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
                user_agent = os.getenv("PLAYWRIGHT_USER_AGENT", DEFAULT_USER_AGENT).strip() or DEFAULT_USER_AGENT
                stealth = _env_truthy_default("PLAYWRIGHT_STEALTH", True)
                channel = "chrome" if use_chrome else None
                launch_args = _chrome_args()

                if cdp_url:
                    browser = p.chromium.connect_over_cdp(cdp_url)
                    close_browser = False
                    if browser.contexts:
                        context = browser.contexts[0]
                        close_context = False
                    else:
                        context = browser.new_context(
                            viewport=DEFAULT_VIEWPORT,
                            locale=locale,
                            timezone_id=timezone_id,
                            user_agent=user_agent,
                        )
                elif persistent:
                    user_data_dir = Path(
                        os.getenv("PLAYWRIGHT_USER_DATA_DIR", str(DEFAULT_USER_DATA_DIR)).strip()
                        or str(DEFAULT_USER_DATA_DIR)
                    )
                    user_data_dir.mkdir(parents=True, exist_ok=True)
                    try:
                        context = p.chromium.launch_persistent_context(
                            user_data_dir=str(user_data_dir),
                            headless=headless,
                            slow_mo=slow_mo,
                            channel=channel,
                            args=launch_args,
                            viewport=DEFAULT_VIEWPORT,
                            locale=locale,
                            timezone_id=timezone_id,
                            user_agent=user_agent,
                        )
                    except PlaywrightError:
                        if not use_chrome:
                            raise
                        channel = None
                        context = p.chromium.launch_persistent_context(
                            user_data_dir=str(user_data_dir),
                            headless=headless,
                            slow_mo=slow_mo,
                            channel=channel,
                            args=launch_args,
                            viewport=DEFAULT_VIEWPORT,
                            locale=locale,
                            timezone_id=timezone_id,
                            user_agent=user_agent,
                        )
                else:
                    try:
                        browser = p.chromium.launch(
                            headless=headless,
                            slow_mo=slow_mo,
                            channel=channel,
                            args=launch_args,
                        )
                    except PlaywrightError:
                        if not use_chrome:
                            raise
                        browser = p.chromium.launch(
                            headless=headless,
                            slow_mo=slow_mo,
                            args=launch_args,
                        )
                    context = browser.new_context(
                        viewport=DEFAULT_VIEWPORT,
                        locale=locale,
                        timezone_id=timezone_id,
                        user_agent=user_agent,
                    )

                if context is None:
                    _raise("Failed to create a browser context")

                context.set_extra_http_headers({"Accept-Language": _guess_accept_language(locale)})
                context.set_default_timeout(nav_timeout_ms)
                context.set_default_navigation_timeout(nav_timeout_ms)
                if stealth:
                    context.add_init_script(_stealth_script())
                if block_blank or prevent_close or log_nav or force_same_tab:
                    context.add_init_script(
                        _guard_nav_script(block_blank, prevent_close, log_nav, force_same_tab)
                    )

                page = context.pages[0] if context.pages else context.new_page()
                _attach_debug_listeners(context, page)
                page = _goto_stable(context, page, entry_url, nav_timeout_ms, nav_retries)

                if nav_only:
                    page.screenshot(path=str(screenshot_path), full_page=False)
                    if keep_open:
                        print("[vlm-debug] waiting for manual close (PLAYWRIGHT_KEEP_OPEN=1)")
                        _wait_until_closed(page)
                    return

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
                if keep_open:
                    print("[vlm-debug] waiting for manual close (PLAYWRIGHT_KEEP_OPEN=1)")
                    _wait_until_closed(page)
            finally:
                if context is not None and close_context:
                    context.close()
                if browser is not None and close_browser:
                    browser.close()
    except PlaywrightError as exc:
        lowered = str(exc).lower()
        if "executable doesn't exist" in lowered or "playwright install" in lowered:
            pytest.skip("Playwright browsers are not installed. Run `playwright install`.")
        raise


def _run_playwright_open_only() -> None:
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError:
        pytest.skip("playwright is not installed")

    entry_url = os.getenv("VLM_ENTRY_URL", DEFAULT_NAV_URL).strip() or DEFAULT_NAV_URL
    nav_retries = int(os.getenv("PLAYWRIGHT_NAV_RETRIES", "3"))
    nav_timeout_ms = int(os.getenv("PLAYWRIGHT_NAV_TIMEOUT_MS", "30000"))
    use_chrome = _env_truthy_default("PLAYWRIGHT_USE_CHROME", True)
    persistent = _env_truthy_default("PLAYWRIGHT_PERSISTENT", True)
    block_blank = _env_truthy_default("PLAYWRIGHT_BLOCK_BLANK", True)
    prevent_close = _env_truthy_default("PLAYWRIGHT_PREVENT_CLOSE", True)
    log_nav = _env_truthy_default("PLAYWRIGHT_LOG_NAV", True)
    force_same_tab = _env_truthy_default("PLAYWRIGHT_FORCE_SAME_TAB", True)
    keep_open = _env_truthy_default("PLAYWRIGHT_KEEP_OPEN", False)
    cdp_url = os.getenv("PLAYWRIGHT_CDP_URL", "").strip()

    headless = _env_truthy("PLAYWRIGHT_HEADLESS")
    if _env_truthy("PLAYWRIGHT_HEADFUL"):
        headless = False
    slow_mo = 0
    if not headless:
        slow_mo = int(os.getenv("PLAYWRIGHT_SLOW_MO_MS", "200"))

    try:
        with sync_playwright() as p:
            browser = None
            context = None
            close_browser = True
            close_context = True
            try:
                locale = os.getenv("PLAYWRIGHT_LOCALE", DEFAULT_LOCALE).strip() or DEFAULT_LOCALE
                timezone_id = os.getenv("PLAYWRIGHT_TIMEZONE", DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
                user_agent = os.getenv("PLAYWRIGHT_USER_AGENT", DEFAULT_USER_AGENT).strip() or DEFAULT_USER_AGENT
                stealth = _env_truthy_default("PLAYWRIGHT_STEALTH", True)
                channel = "chrome" if use_chrome else None
                launch_args = _chrome_args()

                if cdp_url:
                    browser = p.chromium.connect_over_cdp(cdp_url)
                    close_browser = False
                    if browser.contexts:
                        context = browser.contexts[0]
                        close_context = False
                    else:
                        context = browser.new_context(
                            viewport=DEFAULT_VIEWPORT,
                            locale=locale,
                            timezone_id=timezone_id,
                            user_agent=user_agent,
                        )
                elif persistent:
                    user_data_dir = Path(
                        os.getenv("PLAYWRIGHT_USER_DATA_DIR", str(DEFAULT_USER_DATA_DIR)).strip()
                        or str(DEFAULT_USER_DATA_DIR)
                    )
                    user_data_dir.mkdir(parents=True, exist_ok=True)
                    try:
                        context = p.chromium.launch_persistent_context(
                            user_data_dir=str(user_data_dir),
                            headless=headless,
                            slow_mo=slow_mo,
                            channel=channel,
                            args=launch_args,
                            viewport=DEFAULT_VIEWPORT,
                            locale=locale,
                            timezone_id=timezone_id,
                            user_agent=user_agent,
                        )
                    except PlaywrightError:
                        if not use_chrome:
                            raise
                        channel = None
                        context = p.chromium.launch_persistent_context(
                            user_data_dir=str(user_data_dir),
                            headless=headless,
                            slow_mo=slow_mo,
                            channel=channel,
                            args=launch_args,
                            viewport=DEFAULT_VIEWPORT,
                            locale=locale,
                            timezone_id=timezone_id,
                            user_agent=user_agent,
                        )
                else:
                    try:
                        browser = p.chromium.launch(
                            headless=headless,
                            slow_mo=slow_mo,
                            channel=channel,
                            args=launch_args,
                        )
                    except PlaywrightError:
                        if not use_chrome:
                            raise
                        browser = p.chromium.launch(
                            headless=headless,
                            slow_mo=slow_mo,
                            args=launch_args,
                        )
                    context = browser.new_context(
                        viewport=DEFAULT_VIEWPORT,
                        locale=locale,
                        timezone_id=timezone_id,
                        user_agent=user_agent,
                    )

                if context is None:
                    _raise("Failed to create a browser context")

                context.set_extra_http_headers({"Accept-Language": _guess_accept_language(locale)})
                context.set_default_timeout(nav_timeout_ms)
                context.set_default_navigation_timeout(nav_timeout_ms)
                if stealth:
                    context.add_init_script(_stealth_script())
                if block_blank or prevent_close or log_nav or force_same_tab:
                    context.add_init_script(
                        _guard_nav_script(block_blank, prevent_close, log_nav, force_same_tab)
                    )

                page = context.pages[0] if context.pages else context.new_page()
                _attach_debug_listeners(context, page)
                page = _goto_stable(context, page, entry_url, nav_timeout_ms, nav_retries)
                if keep_open:
                    print("[vlm-debug] waiting for manual close (PLAYWRIGHT_KEEP_OPEN=1)")
                    _wait_until_closed(page)
            finally:
                if context is not None and close_context:
                    context.close()
                if browser is not None and close_browser:
                    browser.close()
    except PlaywrightError as exc:
        lowered = str(exc).lower()
        if "executable doesn't exist" in lowered or "playwright install" in lowered:
            pytest.skip("Playwright browsers are not installed. Run `playwright install`.")
        raise


def test_playwright_vlm_click() -> None:
    if _env_truthy("PLAYWRIGHT_OPEN_ONLY"):
        pytest.skip("PLAYWRIGHT_OPEN_ONLY enabled; use test_playwright_open_only instead.")
    _run_vlm_click()


def test_playwright_open_only() -> None:
    if not _env_truthy("PLAYWRIGHT_OPEN_ONLY"):
        pytest.skip("Set PLAYWRIGHT_OPEN_ONLY=1 to enable the open-only test.")
    _run_playwright_open_only()


def test_playwright_open_only_cdp() -> None:
    if not _env_truthy("PLAYWRIGHT_OPEN_ONLY"):
        pytest.skip("Set PLAYWRIGHT_OPEN_ONLY=1 to enable the open-only test.")
    cdp_url = os.getenv("PLAYWRIGHT_CDP_URL", "").strip()
    if not cdp_url:
        pytest.skip("Set PLAYWRIGHT_CDP_URL to use the CDP (方案3) workflow.")
    _run_playwright_open_only()
