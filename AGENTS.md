# Repository Guidelines

## Project Structure & Module Organization
- `server/`: Python backend (FastAPI/Uvicorn app, auth, sessions, tool middleware, sandboxes).
- `web/`: Static web client (HTML/CSS/JS, no build step). See `web/README.md`.
- `skills/`: Codex skill packages and reference assets.
- `scripts/`: Utility scripts (e.g., Docker helpers, document conversion, report generation).
- `test/`: Pytest-based integration tests.
- `config/`: Runtime configs such as `model.yml` and `deepagents.yml`.
- `data/`: Server state and user history (written at runtime).

## Build, Test, and Development Commands
- `python -m server.deepagents_server`: Run the API server on port 8000 (Uvicorn). 
- `python3 -m http.server 8080` (from `web/`): Serve the web client locally.
- `npm install`: Install Node dependencies (used by `create_presentation.js`).
- `npm run build`: Run `node create_presentation.js` (generates the presentation defined by `package.json`).
- `pip install -r requirements.txt`: Install Python dependencies for server/tools/tests.

## Coding Style & Naming Conventions
- Python and JS/CSS use 4-space indentation in existing files.
- Prefer explicit typing and small, single-purpose modules (see `server/`).
- Filenames follow snake_case for Python, kebab-case or plain names for web assets.
- No repo-wide formatter config is committed; follow local patterns and avoid reformatting unrelated code. `black` is in `requirements.txt` if you need it.

## Testing Guidelines
- Tests live in `test/` and follow `test_*.py` naming.
- Run all tests with `pytest`.
- Some tests are integration-heavy and may skip unless env vars are set (e.g., Playwright or API keys in `test/test_playwright_*` and `test/test_qwen_image.py`).

## Commit & Pull Request Guidelines
- Recent commit history uses very short, generic messages (e.g., `modify`), so no formal convention is enforced.
- Prefer imperative, scoped messages when possible (e.g., `server: fix session cleanup`).
- No PR template is present; include a clear summary, steps to validate, and screenshots/GIFs for UI changes.

## Security & Configuration Tips
- Keep secrets out of git; use environment variables and `config/` files as intended.
- Server writes user history under `data/`; avoid committing runtime artifacts.
