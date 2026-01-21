from __future__ import annotations

import re
from pathlib import Path


def inject_file_context(user_input: str) -> tuple[str, list[str]]:
    pattern = r"@((?:[^\s@]|(?<=\\)\s)+)"
    matches = re.findall(pattern, user_input)
    warnings: list[str] = []
    if not matches:
        return user_input, warnings
    context_parts = [user_input, "\n\n## Referenced Files\n"]
    for match in matches:
        clean_path = match.replace("\\ ", " ")
        path = Path(clean_path).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        try:
            path = path.resolve()
        except Exception as exc:
            warnings.append(f"Invalid path {match}: {exc}")
            continue
        if not path.exists() or not path.is_file():
            warnings.append(f"File not found: {match}")
            continue
        try:
            content = path.read_text()
        except Exception as exc:
            warnings.append(f"Failed to read {match}: {exc}")
            continue
        if len(content) > 50000:
            content = content[:50000] + "\n... (file truncated)"
        context_parts.append(f"\n### {path.name}\nPath: `{path}`\n```\n{content}\n```")
    return "\n".join(context_parts), warnings
