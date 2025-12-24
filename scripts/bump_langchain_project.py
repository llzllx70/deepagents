#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def _parse_current_project(text: str) -> str | None:
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == "LANGCHAIN_PROJECT":
            return value.strip()
    return None


def _parse_project_from_launch_json(text: str) -> str | None:
    # `launch.json` may contain comments, so use a tolerant regex.
    match = re.search(r'"LANGCHAIN_PROJECT"\s*:\s*"([^"]+)"', text)
    return match.group(1) if match else None


def _next_number(prefix: str, current: str | None, counter_text: str) -> int:
    return _next_number_with_fallback(prefix, current, counter_text, fallback_last=0)


def _next_number_with_fallback(
    prefix: str, current: str | None, counter_text: str, *, fallback_last: int
) -> int:
    counter_text = counter_text.strip()
    if counter_text.isdigit():
        return int(counter_text) + 1

    if current and current.startswith(prefix):
        suffix = current[len(prefix) :]
        if suffix.isdigit():
            return int(suffix) + 1

    return fallback_last + 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Increment LANGCHAIN_PROJECT and write an env file for VSCode debug sessions."
    )
    parser.add_argument("--prefix", required=True, help="Project name prefix, e.g. admission-debug-")
    parser.add_argument("--counter-file", required=True, help="Path to store the last used integer.")
    parser.add_argument("--env-file", required=True, help="Path to write LANGCHAIN_PROJECT=... for envFile.")
    parser.add_argument(
        "--start-from",
        type=int,
        default=0,
        help="Used only when no counter/seed exists; treated as the last used integer (next will be +1).",
    )
    parser.add_argument(
        "--launch-json",
        default="",
        help="Optional path to .vscode/launch.json to seed the first value when counter is missing.",
    )
    args = parser.parse_args()

    prefix = args.prefix
    counter_file = Path(args.counter_file)
    env_file = Path(args.env_file)
    launch_json = Path(args.launch_json) if args.launch_json else None

    current_project = _parse_current_project(_read_text(env_file))
    if not current_project and launch_json:
        current_project = _parse_project_from_launch_json(_read_text(launch_json))

    next_n = _next_number_with_fallback(
        prefix,
        current_project,
        _read_text(counter_file),
        fallback_last=args.start_from,
    )
    project = f"{prefix}{next_n}"

    counter_file.parent.mkdir(parents=True, exist_ok=True)
    env_file.parent.mkdir(parents=True, exist_ok=True)
    counter_file.write_text(f"{next_n}\n", encoding="utf-8")
    env_file.write_text(f"LANGCHAIN_PROJECT={project}\n", encoding="utf-8")
    print(project)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
