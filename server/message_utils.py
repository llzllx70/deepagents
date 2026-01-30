from __future__ import annotations

import json
import re
from typing import Any

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
    "qwen_image_understand": "查看图片",
    "qwen_image_generate": "生成图片",
    "browser_request_snapshot": "浏览器快照",
    "browser_action": "浏览器操作",
}

TOOL_DISPLAY_LIMIT = 160


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
    elif name == "qwen_image_understand":
        content = _first_arg(parsed_args, ["image_path", "path"])
    elif name == "qwen_image_generate":
        content = _first_arg(parsed_args, ["output_path", "path"])
    elif name == "browser_request_snapshot":
        content = _first_arg(parsed_args, ["mode", "reason"]) or "请求快照"
    elif name == "browser_action":
        action = _first_arg(parsed_args, ["action"])
        target = parsed_args.get("target") if isinstance(parsed_args, dict) else None
        target_hint = None
        if isinstance(target, dict):
            target_hint = target.get("id") or target.get("selector")
        if action and target_hint:
            content = f"{action} {target_hint}"
        elif action:
            content = action

    if content:
        content = _truncate_inline(_compact_single_line(content))
        if not content:
            content = None

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
