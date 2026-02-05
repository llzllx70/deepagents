from __future__ import annotations

import json
import re
from typing import Any

from .browser_target_utils import normalize_browser_target

TOOL_TITLE_MAP: dict[str, str] = {
    "task": "任务分解",
    "write_todos": "任务列表",
    "web_search": "搜索",
    "fetch_url": "浏览",
    "http_request": "浏览",
    "read_file": "读取文件",
    "write_file": "创建文件",
    "edit_file": "编辑文件",
    "shell": "执行命令",
    "execute": "执行命令",
    "ls": "查看目录",
    "pdf_to_word": "转换文件格式",
    "extract_file_text": "解析文件",
    "qwen_image_understand": "图片理解",
    "qwen_image_image_understand": "图片理解",
    "qwen_image_generate": "文生图",
    "browser_request_snapshot": "浏览器快照",
    "browser_action": "浏览器操作",
}

TOOL_DISPLAY_LIMIT = 160

BROWSER_ACTION_LABELS: dict[str, str] = {
    "open": "打开页面",
    "click": "点击元素",
    "type": "输入文本",
    "scroll": "滚动页面",
    "wait": "等待",
}

BROWSER_SNAPSHOT_MODE_LABELS: dict[str, str] = {
    "compact": "紧凑快照",
    "full": "完整快照",
}


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


def _try_parse_json(text: str) -> Any | None:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        stripped = text.strip()
        if stripped.startswith("```") and stripped.endswith("```"):
            inner = stripped.strip("`").strip()
            if inner.lower().startswith("json"):
                inner = inner[4:].strip()
            try:
                return json.loads(inner)
            except json.JSONDecodeError:
                pass
        if "{" in stripped and "}" in stripped:
            start = stripped.find("{")
            end = stripped.rfind("}")
            if start < end:
                snippet = stripped[start : end + 1]
                try:
                    return json.loads(snippet)
                except json.JSONDecodeError:
                    pass
        if "[" in stripped and "]" in stripped:
            start = stripped.find("[")
            end = stripped.rfind("]")
            if start < end:
                snippet = stripped[start : end + 1]
                try:
                    return json.loads(snippet)
                except json.JSONDecodeError:
                    pass
        return None


def parse_tool_args(raw_args: Any) -> dict[str, Any] | None:
    if raw_args is None:
        return None
    if isinstance(raw_args, dict):
        if len(raw_args) == 1:
            wrapper_key = next(iter(raw_args.keys()))
            if wrapper_key in ("input", "arguments", "parameters", "params"):
                return parse_tool_args(raw_args.get(wrapper_key))
        parsed = raw_args
        normalized_target = normalize_browser_target(parsed.get("target"))
        if normalized_target is not None:
            parsed = dict(parsed)
            parsed["target"] = normalized_target
        return parsed
    if isinstance(raw_args, str):
        if not raw_args:
            return None
        parsed = _try_parse_json(raw_args)
        if parsed is None:
            return None
        if isinstance(parsed, str):
            nested = parsed.strip()
            if nested.startswith(("{", "[")):
                nested_parsed = _try_parse_json(nested)
                if nested_parsed is not None:
                    parsed = nested_parsed
        if isinstance(parsed, dict):
            normalized_target = normalize_browser_target(parsed.get("target"))
            if normalized_target is not None:
                parsed = dict(parsed)
                parsed["target"] = normalized_target
            return parsed
        return {"value": parsed}
    return {"value": raw_args}


def truncate_text(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _compact_single_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _truncate_inline(text: str, limit: int = TOOL_DISPLAY_LIMIT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "..."


def _first_arg(args: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = args.get(key)
        if value is None or value == "":
            continue
        return str(value)
    return None


def _extract_target_hint(target: Any) -> str | None:
    if isinstance(target, dict):
        target_id = target.get("id")
        selector = target.get("selector")
        if target_id not in (None, "") and selector not in (None, ""):
            return _truncate_inline(_compact_single_line(f"{target_id} ({selector})"))
        value = target_id or selector
        if value is None or value == "":
            return None
        return str(value)
    if isinstance(target, str):
        value = target.strip()
        if not value:
            return None
        return value
    return None


def _format_wait_duration(wait_ms: Any) -> str | None:
    if wait_ms is None or wait_ms == "":
        return None
    try:
        ms = float(wait_ms)
    except (TypeError, ValueError):
        return str(wait_ms)
    if ms < 0:
        ms = abs(ms)
    if ms >= 1000:
        seconds = ms / 1000
        if seconds.is_integer():
            return f"{int(seconds)}秒"
        return f"{seconds:.1f}秒"
    if ms.is_integer():
        return f"{int(ms)}毫秒"
    return f"{ms:.1f}毫秒"


def _format_scroll_delta(delta: Any) -> str | None:
    if delta is None or delta == "":
        return None
    try:
        value = int(float(delta))
    except (TypeError, ValueError):
        return str(delta)
    if value == 0:
        return "不移动"
    direction = "向下" if value > 0 else "向上"
    return f"{direction}{abs(value)}px"


def _format_browser_action_display(args: dict[str, Any]) -> tuple[str | None, str | None]:
    action = _first_arg(args, ["action"])
    if not action:
        return None, None
    action_key = action.strip().lower()
    action_label = BROWSER_ACTION_LABELS.get(action_key, action)
    target_hint = _extract_target_hint(args.get("target"))
    detail: str | None = None

    if action_key == "open":
        detail = _first_arg(args, ["url"]) or target_hint
    elif action_key == "click":
        detail = target_hint
    elif action_key == "type":
        text = _first_arg(args, ["text"])
        if text and target_hint:
            detail = f"{text} -> {target_hint}"
        else:
            detail = text or target_hint
    elif action_key == "scroll":
        detail = _format_scroll_delta(args.get("delta")) or target_hint
    elif action_key == "wait":
        detail = _format_wait_duration(args.get("wait_ms"))
    else:
        detail = target_hint or _first_arg(args, ["url", "text", "delta", "wait_ms"])

    if detail:
        return f"{action_label}:", detail
    return action_label, None


def _format_snapshot_display(args: dict[str, Any]) -> tuple[str | None, str | None]:
    mode = _first_arg(args, ["mode"])
    reason = _first_arg(args, ["reason"])
    mode_label = None
    if mode:
        mode_label = BROWSER_SNAPSHOT_MODE_LABELS.get(mode.strip().lower(), mode)

    detail: str | None = None
    if mode_label and reason:
        detail = f"{mode_label}（{reason}）"
    elif mode_label:
        detail = mode_label
    elif reason:
        detail = f"原因：{reason}"

    if detail:
        return "浏览器快照", detail
    return None, None


def _summarize_todos(todos: Any) -> str | None:
    if not isinstance(todos, list) or not todos:
        return None
    counts = {"pending": 0, "in_progress": 0, "completed": 0}
    for item in todos:
        status = str(item.get("status") if isinstance(item, dict) else "pending")
        if status == "completed":
            counts["completed"] += 1
        elif status == "in_progress":
            counts["in_progress"] += 1
        else:
            counts["pending"] += 1
    total = counts["pending"] + counts["in_progress"] + counts["completed"]
    if not total:
        return None
    return f"处理中：{counts['in_progress']}  待处理：{counts['pending']}  已完成：{counts['completed']}"


def format_tool_display(
    tool_name: str | None, args: dict[str, Any] | None
) -> dict[str, str | None]:
    name = str(tool_name or "")
    title = TOOL_TITLE_MAP.get(name, name or "tool")
    parsed_args: dict[str, Any] = args if isinstance(args, dict) else {}
    content: str | None = None
    title_override: str | None = None

    if name in ("read_file", "write_file", "edit_file"):
        content = _first_arg(parsed_args, ["file_path", "path", "file"])
    elif name == "ls":
        content = _first_arg(parsed_args, ["path", "dir", "directory"]) or "当前目录"
    elif name == "web_search":
        content = _first_arg(parsed_args, ["query", "q", "text"])
    elif name == "fetch_url":
        content = _first_arg(parsed_args, ["url"])
    elif name == "http_request":
        method = _first_arg(parsed_args, ["method"])
        url = _first_arg(parsed_args, ["url"])
        if method or url:
            parts = []
            if method:
                parts.append(method.upper())
            if url:
                parts.append(url)
            content = " ".join(parts)
    elif name in ("shell", "execute"):
        content = _first_arg(parsed_args, ["command", "cmd", "value"])
    elif name == "write_todos":
        content = _summarize_todos(parsed_args.get("todos"))
    elif name == "task":
        content = _first_arg(parsed_args, ["description"])
    elif name == "pdf_to_word":
        content = _first_arg(parsed_args, ["output_path", "output", "out_path", "pdf_path"])
    elif name == "extract_file_text":
        content = _first_arg(parsed_args, ["file_path", "path"])
    elif name == "qwen_image_understand":
        content = _first_arg(parsed_args, ["image_path", "path"])
    elif name == "qwen_image_image_understand":
        content = _first_arg(parsed_args, ["image_path", "path"])
    elif name == "qwen_image_generate":
        content = _first_arg(parsed_args, ["output_path", "path"])
    elif name == "browser_request_snapshot":
        title_override, content = _format_snapshot_display(parsed_args)
        if content is None:
            content = _first_arg(parsed_args, ["mode", "reason"]) or "请求快照"
    elif name == "browser_action":
        title_override, content = _format_browser_action_display(parsed_args)

    if content:
        content = _truncate_inline(_compact_single_line(content))
        if not content:
            content = None

    if title_override:
        title = title_override

    return {"title": title, "content": content}


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
