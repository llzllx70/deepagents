#!/usr/bin/env python3
from __future__ import annotations

"""CLI tool for reading YAML config files used by shell scripts.

Usage:
    python scripts/config_parser.py env               <deepagents.yml> [profile]
    python scripts/config_parser.py default-profile   <deepagents.yml>
    python scripts/config_parser.py profile-list      <deepagents.yml>
    python scripts/config_parser.py profile-exists    <deepagents.yml> <profile>
    python scripts/config_parser.py profile-model     <deepagents.yml> <profile>
    python scripts/config_parser.py profile-scene-val <deepagents.yml> <profile> <scene>
    python scripts/config_parser.py scene-val         <llm-scene.yml> <scene>
    python scripts/config_parser.py model-val         <model.yml> <model> <key>
    python scripts/config_parser.py model-keys        <model.yml>
    python scripts/config_parser.py model-exists      <model.yml> <model>
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
    """Minimal nested YAML parser for map-like config files.

    Supports arbitrary nested dictionaries using indentation.
    List items are ignored in fallback mode.
    """
    result: dict[str, Any] = {}
    # Stack entries are (indent_level, container_dict)
    stack: list[tuple[int, dict[str, Any]]] = [(-1, result)]

    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- "):
            continue
        if ":" not in stripped:
            continue

        indent = len(raw_line) - len(raw_line.lstrip(" "))
        key, _, raw_value = stripped.partition(":")
        key = key.strip()
        value = raw_value.strip()
        if not key:
            continue

        while stack and indent <= stack[-1][0]:
            stack.pop()
        if not stack:
            stack = [(-1, result)]

        parent = stack[-1][1]
        if value:
            parent[key] = _strip_quotes(value)
            continue

        child: dict[str, Any] = {}
        parent[key] = child
        stack.append((indent, child))

    return result


def _strip_quotes(value: str) -> str:
    if (value.startswith('"') and value.endswith('"')) or \
       (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def _profiles(data: dict) -> dict[str, dict]:
    profiles = data.get("profiles", {})
    if not isinstance(profiles, dict):
        return {}
    normalized: dict[str, dict] = {}
    for key, value in profiles.items():
        if isinstance(key, str) and isinstance(value, dict):
            normalized[key] = value
    return normalized


def _default_profile(data: dict) -> str:
    value = data.get("default_profile")
    if isinstance(value, str) and value:
        return value
    profiles = _profiles(data)
    if profiles:
        return next(iter(profiles.keys()))
    return ""


def _resolve_profile(data: dict, profile: str | None) -> str:
    if profile:
        return profile
    return _default_profile(data)


def _profile_env(data: dict, profile: str) -> dict[str, Any]:
    profiles = _profiles(data)
    section = profiles.get(profile, {})
    env = section.get("env", {})
    if isinstance(env, dict):
        return env
    return {}


def _profile_scenes(data: dict, profile: str) -> dict[str, Any]:
    profiles = _profiles(data)
    section = profiles.get(profile, {})
    scenes = section.get("scenes", {})
    if isinstance(scenes, dict):
        return scenes
    return {}


def cmd_env(args: list[str]) -> int:
    """Print env vars from deepagents.yml as KEY\\tVALUE lines.

    Merges top-level env and profile.env (profile values override top-level).
    """
    if len(args) < 1:
        print("Usage: config_parser.py env <deepagents.yml> [profile]", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    env_merged: dict[str, Any] = {}
    root_env = data.get("env", {})
    if isinstance(root_env, dict):
        env_merged.update(root_env)
    profile = _resolve_profile(data, args[1] if len(args) > 1 else None)
    if profile:
        env_merged.update(_profile_env(data, profile))
    for key, value in env_merged.items():
        sys.stdout.write(f"{key}\t{_strip_quotes(str(value))}\n")
    return 0


def cmd_default_profile(args: list[str]) -> int:
    if len(args) < 1:
        print("Usage: config_parser.py default-profile <deepagents.yml>", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    sys.stdout.write(_default_profile(data))
    return 0


def cmd_profile_list(args: list[str]) -> int:
    if len(args) < 1:
        print("Usage: config_parser.py profile-list <deepagents.yml>", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    profiles = _profiles(data)
    sys.stdout.write("\n".join(profiles.keys()))
    return 0


def cmd_profile_exists(args: list[str]) -> int:
    if len(args) < 2:
        print("Usage: config_parser.py profile-exists <deepagents.yml> <profile>", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    profiles = _profiles(data)
    return 0 if args[1] in profiles else 1


def cmd_profile_model(args: list[str]) -> int:
    """Legacy alias: return profiles.<profile>.scenes.main."""
    if len(args) < 2:
        print("Usage: config_parser.py profile-model <deepagents.yml> <profile>", file=sys.stderr)
        return 1
    data = _load_yaml(args[0])
    scenes = _profile_scenes(data, args[1])
    main_model = scenes.get("main", "")
    if isinstance(main_model, str):
        sys.stdout.write(_strip_quotes(main_model))
    return 0


def cmd_profile_scene_val(args: list[str]) -> int:
    if len(args) < 3:
        print(
            "Usage: config_parser.py profile-scene-val <deepagents.yml> <profile> <scene>",
            file=sys.stderr,
        )
        return 1
    data = _load_yaml(args[0])
    scene = args[2]
    scenes = _profile_scenes(data, args[1])
    value = scenes.get(scene, "")
    if isinstance(value, str):
        sys.stdout.write(_strip_quotes(value))
    return 0


def cmd_scene_val(args: list[str]) -> int:
    """Print value for a scene key from llm-scene.yml (legacy)."""
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
    "default-profile": cmd_default_profile,
    "profile-list": cmd_profile_list,
    "profile-exists": cmd_profile_exists,
    "profile-model": cmd_profile_model,
    "profile-scene-val": cmd_profile_scene_val,
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
