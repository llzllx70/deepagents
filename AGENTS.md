# Repository Guidelines

## Project Structure & Module Organization
- `libs/deepagents/`: core Python package (agent runtime, backends, middleware).
- `libs/deepagents-cli/`: CLI package, including integrations and UI.
- `libs/*/tests/`: unit and integration tests (`test_*.py`).
- `skills/`: built-in skill definitions and scripts; `.deepagents/skills` symlinks here.
- `scripts/`: repo-level helper scripts.

## Build, Test, and Development Commands
- `make -C libs/deepagents lint` / `make -C libs/deepagents format`: run Ruff formatting/linting for core package.
- `make -C libs/deepagents test` / `make -C libs/deepagents integration_test`: run unit/integration tests with coverage.
- `make -C libs/deepagents-cli lint` / `make -C libs/deepagents-cli format`: format and lint CLI code.
- `make -C libs/deepagents-cli test` / `make -C libs/deepagents-cli test_integration`: run CLI tests.
- `make -C libs/deepagents-cli run`: run the CLI from source via `uvx`.

## Coding Style & Naming Conventions
- Python uses Ruff formatting and linting; prefer running `uv run ruff format`/`ruff check` via the Makefiles.
- Line length: 150 in `libs/deepagents`, 100 in `libs/deepagents-cli` (see `pyproject.toml` in each package).
- Type checking is strict (`mypy`), so keep type hints accurate and avoid implicit `Any`.
- Tests follow `test_*.py` naming inside `tests/` folders.

## Testing Guidelines
- Framework: `pytest` with coverage enabled in `libs/deepagents` (`--cov=deepagents`).
- Unit tests live in `libs/deepagents/tests/unit_tests` and `libs/deepagents-cli/tests/unit_tests`.
- Integration tests live in `libs/deepagents/tests/integration_tests` and `libs/deepagents-cli/tests/integration_tests`.
- Prefer adding a focused test near the module being changed.

## Commit & Pull Request Guidelines
- History shows a mix of simple imperative messages (`add`, `modify`) and Conventional Commit prefixes (`feat:`, `chore:`). Prefer conventional prefixes when possible.
- Keep the subject short and action-oriented; add context in the body if needed.
- PRs should include a brief summary, testing notes (commands run), and screenshots only when UI changes apply.

## Configuration & Agent Notes
- Optional tools in examples require environment variables like `TAVILY_API_KEY`; document new env vars in relevant READMEs.
- Project skills are loaded from `.deepagents/skills` (symlinked to `skills/`), so updates here affect local agent behavior.
