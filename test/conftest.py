"""Shared test fixtures and helpers."""

from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

import pytest

# Ensure `server` package is importable from the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from server.config_loader import load_model_config


@lru_cache(maxsize=1)
def load_models_config() -> dict[str, dict[str, str]]:
    """Load model configs via the shared config loader.

    Returns a simplified ``{model_key: {param: value}}`` dict suitable for
    test helpers.  Skips the test suite if the config file is missing.
    """
    models = load_model_config()
    if not models:
        pytest.skip("Missing or empty model config file")
    # Flatten Any values to str for test compatibility
    return {
        key: {k: str(v) for k, v in cfg.items()}
        for key, cfg in models.items()
    }


@pytest.fixture
def models_config() -> dict[str, dict[str, str]]:
    """Pytest fixture providing the model configuration dict."""
    return load_models_config()
