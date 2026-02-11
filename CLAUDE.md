# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Server (Python FastAPI)

```bash
# run.sh CLI: ./scripts/run.sh <action> [target] [model]
# Actions: start, stop, restart, deploy, update-web, update-all, process, log
# Targets: server, web, all (default depends on action)
# Model defaults to "main" entry in config/llm-scene.yml

./scripts/run.sh                          # Interactive menu mode
./scripts/run.sh start server             # Start server with default model
./scripts/run.sh start server glm         # Start server with specific model
./scripts/run.sh stop server              # Stop server
./scripts/run.sh restart server           # Restart with default model
./scripts/run.sh deploy all               # Update web + restart server
./scripts/run.sh update-web               # Copy web/ to WEB_DEPLOY_DIR
./scripts/run.sh process all              # Show running processes
./scripts/run.sh log server               # Tail server logs

# Direct Python execution
export DEEPAGENTS_MODEL=kimi
python -m server.deepagents_server

# Dependencies
pip install -r requirements.txt
npm install                               # Node deps for create_presentation.js

# Tests
pytest                                    # All tests
pytest test/test_kimi_tool_args.py        # Specific test file
```

Some tests are integration-heavy and skip unless env vars are set (Playwright, API keys).

### Web Client (vanilla JS, no build step)

```bash
cd web && python3 -m http.server 8080
```

## Architecture Overview

DeepAgents is an AI agent orchestration platform with a LangGraph-based backend and vanilla JavaScript web client.

```
Web Client (WebSocket) → FastAPI Server (sessions.py) → LangGraph Agent → Tools → LLM Providers
                              ↓
                        DockerSandboxPool (isolated execution)
```

### Backend Architecture

**Entry Point**: `server/deepagents_server.py` - Uvicorn server on port 8000

**Session Management** (`server/sessions.py`):
- Each WebSocket connection creates a session with unique `session_id`
- Sessions acquire containers from `DockerSandboxPool`
- Per-session workspace: `workspace/{session_id}/`
- Thread-based state with `InMemorySaver` checkpointer

**Agent Creation** (`server/agent.py:create_cli_agent`):
- Middleware stack (applied in order):
  1. `MemoryMiddleware` - Persistent memory from `agent.md` files
  2. `SkillsMiddleware` - Custom skill tools from `skills/` directory
  3. `ShellMiddleware` - Local shell (non-Docker mode only)
  4. `ToolCallArgsMiddleware` - Captures tool arguments for display
  5. Built-in deepagents middleware (TodoList, Filesystem, SubAgent, HITL, etc.)
- `interrupt_on` config for human-in-the-loop approval on destructive tools
- Returns tuple: `(agent_graph, composite_backend)`

**Docker Sandbox Pool** (`server/docker_pool.py`):
- Warm pool of pre-started containers
- Image: `deepagents-sandbox:22.04` (configurable via `DEEPAGENTS_DOCKER_IMAGE`)
- Pool config via env vars: `DEEPAGENTS_DOCKER_POOL_SIZE` (default: 10), `DEEPAGENTS_DOCKER_MIN_IDLE` (default: 2)
- Container workdir: `/workspace` mapped to `workspace/{session_id}/` on host
- Skills mounted read-only: `/user-skills` (user), `/skills` (project)
- Bind workspace mode: `DEEPAGENTS_DOCKER_BIND_WORKSPACE=1` for development

**Qwen-Specific Runner** (`server/qwen_runner.py`, `server/qwen_tools.py`):
- Qwen models require a dedicated runner and tool builder due to non-standard tool call streaming

**WebSocket Protocol** (`server/app.py`, `docs/protocol.md`):
- Server → Client events: `run.*`, `assistant.delta`, `assistant.message`, `tool.call.started`, `tool.call.ended`, `file.op`, `todos.updated`, `interrupt.*`
- Client → Server: `run`, `cancel`, `interrupt_response`, `auto_approve`

### Web Client Architecture

**Location**: `web/` - vanilla JavaScript, no build tools

**Entry Point**: `web/app.js` - `DeepAgentsClient` class

**Key modules** in `web/app/`: `network.js` (WebSocket), `messages.js` (rendering), `ui.js` (state), `auth.js` (authentication), `history.js` (LocalStorage persistence)

**Event Routing** (`handleMessage`): routes `run.*`, `assistant.delta`, `assistant.message`, `tool.call.started/ended`, `file.op`, `todos.updated`, `interrupt.request`

### Skills System

**Location**: `skills/` directory — each skill is a self-contained package with a `SKILL.md` file. Skills are loaded by `SkillsMiddleware` (`server/skills_middleware.py`) and injected as agent tools. Project skills in `.deepagents/skills/`, user skills at `settings.user_deepagents_dir`.

## Configuration Files

### `config/model.yml`

LLM provider configurations (kimi, glm, qwen, claude, openrouter, etc.):
```yaml
models:
  kimi:
    api_key: "..."
    base_url: "https://api.moonshot.cn/v1"
    model: "moonshot-v1-8k"
```

### `config/deepagents.yml`

Environment variables and paths (loaded by `run.sh` via `load_env_config`):
```yaml
env:
  LANGCHAIN_TRACING_V2: "true"
  LANGCHAIN_API_KEY: "..."
  DEEPAGENTS_DOCKER_BIND_WORKSPACE: "1"
  WEB_ROOT: "<project_root>/web"
  WEB_DEPLOY_DIR: "/path/to/nginx/root"
```

### `config/llm-scene.yml`

Scene-to-model mapping; `main` key sets the default model for `run.sh`:
```yaml
main: "glm"
```

### `.deepagents/agent.md`

Project-specific agent instructions (Chinese). Critical rules:
- Never delete any files, even when explicitly requested
- Tool calls must include intent descriptions in content (no empty `{"content": ""}`)
- All generated files must go in `workspace/` directory
- Download format: `下载：/files/<workspace相对路径>` (strict, no Markdown links or full URLs)
- HTML resources must use `/files/<workspace相对路径>` absolute paths

## File Path Handling (Critical)

- Workspace: `/workspace` inside container → `workspace/{session_id}/` on host
- Download prefix: `/files/` served from `workspace/` via `/files` route
- HTML resources: Use `/files/<workspace-relative-path>` format
- Example: `workspace/assets/img.png` → HTML references `/files/assets/img.png`
- Never reference paths outside `workspace/`

## LLM Provider Notes

Some providers (notably Qwen) do not stream tool call arguments. The `ToolCallArgsMiddleware` (`server/tool_args_middleware.py`) captures arguments at execution time so the web client can display them. This is why `tool.call.started` events may show empty `args: {}` for some providers. Set `DEEPAGENTS_DEBUG_TOOL_CALLS=1` for verbose logging.

## Code Style

- Python: 4-space indentation, snake_case filenames
- JavaScript: ES6 modules, arrow functions, template literals
- CSS: Custom properties in `:root`, BEM-like naming
- No repo-wide formatter; follow existing patterns in each file
- Commit messages: prefer imperative, scoped format (e.g., `server: fix session cleanup`)

## Key Dependencies

- **Core**: `deepagents`, `deepagents-cli` (pip packages) - Agent harness and CLI utilities
- **LLM Orchestration**: `langchain`, `langgraph`, `langsmith`
- **Web Server**: `fastapi`, `uvicorn`, `websockets`
- **LLM Providers**: `anthropic`, `openai`, `tavily-python`
- **Browser**: `playwright`
- **Document Processing**: `python-docx`, `python-pptx`, `pypdfium2`, `pdfplumber`, `fpdf2`, `weasyprint`, `pandoc`
- **Node**: `pptxgenjs`, `sharp` (for presentation generation)
