#!/usr/bin/env python3
"""CLI tool for reading YAML config files used by run.sh.

Replaces the inline Python heredocs that were duplicated across
load_env_config, scene_config_value, model_config_value,
model_config_keys, and model_exists in run.sh.

Usage:
    python scripts/config_parser.py env       <config.yml>
    python scripts/config_parser.py scene-val <llm-scene.yml> <scene>
    python scripts/config_parser.py model-val <model.yml> <model> <key>
    python scripts/config_parser.py model-keys <model.yml>
    python scripts/config_parser.py model-exists <model.yml> <model>
"""
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None


def _load_yaml(path: str) -> dict:
    """Load a YAML file, returns dict (empty on error)."""
    p = Path(path)
    if not p.exists():
        return {}
    text = p.read_text(encoding="utf-8")
    if yaml is not None:
        return yaml.safe_load(text) or {}
    # Fallback: minimal manual parser for simple key-value YAML
    return _parse_simple_yaml(text)


def _parse_simple_yaml(text: str) -> dict:
    """Minimal YAML parser for the config files used in this project.

    Handles up to 3 indent levels (0, 2, 4 spaces) with string values.
    """
    result = {}
    current_section = None
    current_key = None

    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))

        if indent == 0:
            current_section = stripped.rstrip(":").strip()
            result.setdefault(current_section, {})
            current_key = None
            continue

        if ":" not in stripped:
            continue

        key, _, raw_value = stripped.partition(":")
        key = key.strip()
        value = raw_value.strip()
        if (value.startswith('"') and value.endswith('"')) or \
           (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]

        if indent == 2 and current_section is not None:
            if value:
                if isinstance(result.get(current_section), dict):
                    result[current_section][key] = value
                current_key = None
            else:
                # Sub-section (e.g. model name under "models:")
                if isinstance(result.get(current_section), dict):
                    result[current_section].setdefault(key, {})
                current_key = key
        elif indent == 4 and current_section is not None and current_key is not None:
            section = result.get(current_section)
            if isinstance(section, dict) and isinstance(section.get(current_key), dict):
                section[current_key][key] = value

    return result


def _strip_quotes(value: str) -> str:
    if (value.startswith('"') and value.endswith('"')) or \
       (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def cmd_env(args: list[str]) -> int:
    """Print env vars from deepagents.yml as KEY\\tVALUE lines."""
    if len(args) < 1:
        print("Usage: config_parser.py env <config.yml>", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    env = data.get("env", {})
    if not isinstance(env, dict):
        return 0
    for key, value in env.items():
        sys.stdout.write(f"{key}\t{_strip_quotes(str(value))}\n")
    return 0


def cmd_scene_val(args: list[str]) -> int:
    """Print value for a scene key from llm-scene.yml."""
    if len(args) < 2:
        print("Usage: config_parser.py scene-val <llm-scene.yml> <scene>", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    scene = args[1]
    value = data.get(scene, "")
    if isinstance(value, dict):
        value = ""
    sys.stdout.write(_strip_quotes(str(value)))
    return 0


def cmd_model_val(args: list[str]) -> int:
    """Print a model's config value from model.yml."""
    if len(args) < 3:
        print("Usage: config_parser.py model-val <model.yml> <model> <key>", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    models = data.get("models", {})
    if not isinstance(models, dict):
        sys.stdout.write("")
        return 0
    model_data = models.get(args[1], {})
    if not isinstance(model_data, dict):
        sys.stdout.write("")
        return 0
    value = model_data.get(args[2], "")
    sys.stdout.write(_strip_quotes(str(value)))
    return 0


def cmd_model_keys(args: list[str]) -> int:
    """Print model names from model.yml, one per line."""
    if len(args) < 1:
        print("Usage: config_parser.py model-keys <model.yml>", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    models = data.get("models", {})
    if not isinstance(models, dict):
        return 0
    sys.stdout.write("\n".join(models.keys()))
    return 0


def cmd_model_exists(args: list[str]) -> int:
    """Exit 0 if model exists, 1 otherwise."""
    if len(args) < 2:
        print("Usage: config_parser.py model-exists <model.yml> <model>", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    models = data.get("models", {})
    if not isinstance(models, dict):
        return 1
    return 0 if args[1] in models else 1


COMMANDS = {
    "env": cmd_env,
    "scene-val": cmd_scene_val,
    "model-val": cmd_model_val,
    "model-keys": cmd_model_keys,
    "model-exists": cmd_model_exists,
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"Usage: {sys.argv[0]} <{'|'.join(COMMANDS)}> ...", file=sys.stderr)
        return 1
    return COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    sys.exit(main())
