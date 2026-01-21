from __future__ import annotations

import json
import re
from typing import Any


def is_root_namespace(namespace: object) -> bool:
    if namespace is None:
        return True
    if isinstance(namespace, (tuple, list)):
        return len(namespace) == 0
    if isinstance(namespace, str):
        return namespace == ""
    return False


def truncate_for_log(text: str, limit: int = 2000) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...(truncated)"


def format_tool_content(content: Any, limit: int = 400) -> str:
    text = normalize_text_content(content)
    if len(text) > limit:
        return text[:limit] + "...(truncated)"
    return text


def normalize_text_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                if item:
                    parts.append(item)
                continue
            if isinstance(item, dict):
                if item.get("type") == "text" and isinstance(item.get("text"), str):
                    text = item["text"]
                    if text:
                        parts.append(text)
                continue
            parts.append(str(item))
        return "\n".join(parts)
    return str(content)


def parse_tool_args(raw_args: Any) -> dict[str, Any] | None:
    if raw_args is None:
        return None
    if isinstance(raw_args, dict):
        return raw_args
    if isinstance(raw_args, str):
        if not raw_args:
            return None
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            return parsed
        return {"value": parsed}
    return {"value": raw_args}


def truncate_text(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def extract_skill_name(text: str) -> str | None:
    # SKILL.md commonly uses a YAML header with `name: ...`.
    for line in text.splitlines()[:200]:
        match = re.match(r"\s*name\s*:\s*(.+?)\s*$", line)
        if not match:
            continue
        return match.group(1).strip().strip('"').strip("'") or None
    return None


def extract_tool_calls(message: Any) -> list[dict[str, Any]]:
    tool_calls = getattr(message, "tool_calls", None)
    if isinstance(tool_calls, list) and tool_calls:
        return tool_calls
    additional_kwargs = getattr(message, "additional_kwargs", None)
    if isinstance(additional_kwargs, dict):
        maybe = additional_kwargs.get("tool_calls")
        if isinstance(maybe, list) and maybe:
            return maybe
    return []
