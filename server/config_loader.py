"""Unified YAML config loading for model and scene configuration."""

from __future__ import annotations

from functools import lru_cache
import os
from pathlib import Path
from typing import Any

import yaml

_CONFIG_DIR = Path(__file__).resolve().parents[1] / "config"
_SCENE_ENV_KEYS = {
    "main": "DEEPAGENTS_SCENE_MAIN",
    "image-understand": "DEEPAGENTS_SCENE_IMAGE_UNDERSTAND",
    "image-create": "DEEPAGENTS_SCENE_IMAGE_CREATE",
}


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
    """Load scene-model mapping from env/profile config with legacy fallback."""
    result: dict[str, str] = {}

    for scene, env_key in _SCENE_ENV_KEYS.items():
        value = os.environ.get(env_key)
        if value:
            result[scene] = value

    deepagents_path = _CONFIG_DIR / "deepagents.yml"
    if deepagents_path.exists():
        try:
            deepagents = yaml.safe_load(deepagents_path.read_text(encoding="utf-8")) or {}
        except Exception:
            deepagents = {}
        if isinstance(deepagents, dict):
            profiles = deepagents.get("profiles", {})
            if isinstance(profiles, dict):
                selected_profile = os.environ.get("DEEPAGENTS_PROFILE")
                if not selected_profile:
                    raw_default = deepagents.get("default_profile")
                    if isinstance(raw_default, str):
                        selected_profile = raw_default
                if not selected_profile and profiles:
                    selected_profile = next(iter(profiles.keys()))
                profile_data = profiles.get(selected_profile, {})
                if isinstance(profile_data, dict):
                    scenes = profile_data.get("scenes", {})
                    if isinstance(scenes, dict):
                        for key, value in scenes.items():
                            if isinstance(key, str) and isinstance(value, str) and key not in result:
                                result[key] = value

    # Legacy compatibility during migration.
    config_path = _CONFIG_DIR / "llm-scene.yml"
    if not config_path.exists():
        return result
    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return result
    if not isinstance(data, dict):
        return result
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, str) and key not in result:
            result[key] = value
    return result
