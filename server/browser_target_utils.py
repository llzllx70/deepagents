from __future__ import annotations

import json
import re
from typing import Any

_DATA_DA_ID_RE = re.compile(r"\[data-da-id=(?:\"|')?([^\]\"']+)(?:\"|')?\]")
_ATTR_ID_RE = re.compile(r"\[id=(?:\"|')?([^\]\"']+)(?:\"|')?\]")
_CSS_ID_RE = re.compile(r"#([A-Za-z_][\w\-\:\.]*)")
# Match bare [da-*] attribute selectors — common LLM mistake where the model
# treats the da-id value as an attribute name instead of using data-da-id="..."
_BARE_DA_ATTR_RE = re.compile(r"^\[(da-[^\]\"']+)\]$")
# Match bare "da-*" strings without brackets
_BARE_DA_STR_RE = re.compile(r"^(da-\S+)$")
# Match Playwright-style text selectors — common LLM mistake where the model
# uses Playwright syntax (text=xxx, text="xxx") instead of target.text
_TEXT_SELECTOR_RE = re.compile(r'^text=(?:"([^"]+)"|\'([^\']+)\'|(.+))$', re.IGNORECASE)


def _extract_selector_id(selector: str) -> str | None:
    for pattern in (_DATA_DA_ID_RE, _ATTR_ID_RE, _CSS_ID_RE):
        match = pattern.search(selector)
        if match:
            return match.group(1)
    return None


def _enrich_target(target: dict[str, Any]) -> dict[str, Any]:
    current_id = target.get("id")
    if current_id not in (None, ""):
        return target
    selector = target.get("selector")
    if isinstance(selector, str):
        selector = selector.strip()
        if selector:
            # Fix Playwright-style text selectors: text=其他方式 → {text: "其他方式"}
            # LLMs trained on Playwright docs often emit this syntax, but
            # querySelector doesn't support it — convert to text-based targeting.
            text_match = _TEXT_SELECTOR_RE.match(selector)
            if text_match:
                text_value = text_match.group(1) or text_match.group(2) or text_match.group(3)
                enriched = {k: v for k, v in target.items() if k != "selector"}
                enriched["text"] = text_value.strip()
                return enriched
            # Fix bare [da-*] selectors: [da-4] → [data-da-id="da-4"]
            bare_attr = _BARE_DA_ATTR_RE.match(selector)
            if bare_attr:
                da_id = bare_attr.group(1)
                enriched = dict(target)
                enriched["id"] = da_id
                enriched["selector"] = f'[data-da-id="{da_id}"]'
                return enriched
            # Fix bare da-* strings: da-4 → [data-da-id="da-4"]
            bare_str = _BARE_DA_STR_RE.match(selector)
            if bare_str:
                da_id = bare_str.group(1)
                enriched = dict(target)
                enriched["id"] = da_id
                enriched["selector"] = f'[data-da-id="{da_id}"]'
                return enriched
            extracted = _extract_selector_id(selector)
            if extracted:
                enriched = dict(target)
                enriched["id"] = extracted
                return enriched
    return target


def normalize_browser_target(raw: dict[str, Any] | str | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    if isinstance(raw, dict):
        return _enrich_target(raw)
    if isinstance(raw, str):
        candidate = raw.strip()
        if not candidate:
            return None
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            return _enrich_target({"selector": candidate})
        if isinstance(parsed, dict):
            return _enrich_target(parsed)
        if isinstance(parsed, str):
            return _enrich_target({"selector": parsed})
        return _enrich_target({"selector": candidate})
    raise TypeError("target must be a dict, JSON string, or selector string")
