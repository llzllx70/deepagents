from __future__ import annotations

import json
import re
from typing import Any

_DATA_DA_ID_RE = re.compile(r"\[data-da-id=(?:\"|')?([^\]\"']+)(?:\"|')?\]")
_ATTR_ID_RE = re.compile(r"\[id=(?:\"|')?([^\]\"']+)(?:\"|')?\]")
_CSS_ID_RE = re.compile(r"#([A-Za-z_][\w\-\:\.]*)")


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
