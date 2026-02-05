from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from .config import ROOT, logger

_CONFIG_PATH = ROOT / "config" / "deepagents.yml"
_ENV_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)\}")


def _expand_env_string(
    value: str,
    missing: set[str],
    env_overrides: dict[str, Any] | None,
) -> str:
    def repl(match: re.Match[str]) -> str:
        var = match.group(1)
        env_value = os.environ.get(var)
        if env_value is not None:
            return env_value
        if env_overrides and var in env_overrides:
            return str(env_overrides[var])
        missing.add(var)
        return ""

    return _ENV_PATTERN.sub(repl, value)


def _expand_env(
    value: Any,
    missing: set[str],
    env_overrides: dict[str, Any] | None,
) -> Any:
    if isinstance(value, str):
        return _expand_env_string(value, missing, env_overrides)
    if isinstance(value, list):
        return [_expand_env(item, missing, env_overrides) for item in value]
    if isinstance(value, dict):
        return {key: _expand_env(val, missing, env_overrides) for key, val in value.items()}
    return value


def _normalize_servers(raw_servers: Any) -> list[dict[str, Any]]:
    servers: list[dict[str, Any]] = []
    if isinstance(raw_servers, dict):
        for name, config in raw_servers.items():
            if config is None:
                config = {}
            if not isinstance(config, dict):
                logger.warning("Skipping MCP server %s: expected mapping config", name)
                continue
            cfg = dict(config)
            cfg.setdefault("name", str(name))
            servers.append(cfg)
    elif isinstance(raw_servers, list):
        for item in raw_servers:
            if not isinstance(item, dict):
                logger.warning("Skipping MCP server entry: expected mapping config")
                continue
            servers.append(dict(item))
    elif raw_servers:
        logger.warning("Unsupported MCP servers config: %s", type(raw_servers))
    return servers


def load_mcp_servers(config_path: Path | None = None) -> list[dict[str, Any]]:
    path = config_path or _CONFIG_PATH
    if not path.exists():
        return []

    try:
        import yaml
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("PyYAML not available; MCP config disabled: %s", exc)
        return []

    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        logger.warning("Failed to load MCP config from %s: %s", path, exc)
        return []

    if not isinstance(data, dict):
        logger.warning("Invalid config structure in %s", path)
        return []

    mcp_config = data.get("mcp") or {}
    if not isinstance(mcp_config, dict):
        logger.warning("Invalid MCP config in %s", path)
        return []

    if mcp_config.get("enabled") is False:
        return []

    raw_servers = mcp_config.get("servers") or []
    env_overrides = data.get("env") if isinstance(data.get("env"), dict) else None
    servers = _normalize_servers(raw_servers)

    missing: set[str] = set()
    expanded: list[dict[str, Any]] = []
    for server in servers:
        expanded.append(_expand_env(server, missing, env_overrides))

    if missing:
        logger.warning("Missing MCP env vars: %s", ", ".join(sorted(missing)))

    normalized: list[dict[str, Any]] = []
    for server in expanded:
        name = server.get("name")
        if not isinstance(name, str) or not name.strip():
            logger.warning("Skipping MCP server with missing name: %s", server)
            continue
        normalized.append(server)

    return normalized
