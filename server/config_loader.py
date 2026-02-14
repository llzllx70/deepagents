"""Unified YAML config loading for model and scene configuration.

Provides cached access to ``config/model.yml`` and ``config/llm-scene.yml``.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

_CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"


@lru_cache(maxsize=1)
def load_model_config() -> dict[str, dict[str, Any]]:
    """Load and cache ``config/model.yml`` models section."""
    config_path = _CONFIG_DIR / "model.yml"
    if not config_path.exists():
        return {}
    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    models = data.get("models")
    if not isinstance(models, dict):
        return {}
    return {key: value for key, value in models.items() if isinstance(value, dict)}


@lru_cache(maxsize=1)
def load_scene_config() -> dict[str, str]:
    """Load and cache ``config/llm-scene.yml``."""
    config_path = _CONFIG_DIR / "llm-scene.yml"
    if not config_path.exists():
        return {}
    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        key: value
        for key, value in data.items()
        if isinstance(key, str) and isinstance(value, str)
    }
