# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Server (Python FastAPI)

```bash
# Primary method via run.sh script (interactive or command-line)
./scripts/run.sh                          # Interactive menu mode
./scripts/run.sh start [server|all] [model-name]
./scripts/run.sh stop [server|all]
./scripts/run.sh restart [server|all] [model-name]
./scripts/run.sh deploy [server|web|all] [model-name]  # Update web + restart server
./scripts/run.sh log [server|web|all]                 # Follow logs
./scripts/run.sh process [server|web|all]              # Show running processes

# Direct Python execution (sets DEEPAGENTS_MODEL env var)
export DEEPAGENTS_MODEL=kimi
python -m server.deepagents_server

# Install/update Python dependencies
pip install -r requirements.txt

# Run tests
pytest                              # All tests
pytest test/test_kimi_tool_args.py # Specific test file
```

### Web Client (vanilla JS, no build step)

```bash
cd web
python3 -m http.server 8080
# Open http://localhost:8080
```

### Deployment

```bash
# Update web assets to nginx (requires WEB_DEPLOY_DIR in config/deepagents.yml)
./scripts/deploy_nginx.sh

# Or via run.sh
./scripts/run.sh update-web   # Copy web/ to WEB_DEPLOY_DIR
./scripts/run.sh update-all   # Restart server + update web
```

## Architecture Overview

DeepAgents is an AI agent orchestration platform with a LangGraph-based backend and vanilla JavaScript web client.

### Component Flow

```
Web Client (WebSocket) → FastAPI Server (sessions.py) → LangGraph Agent → Tools → LLM Providers
                              ↓
                        DockerSandboxPool (isolated execution)
```

### Backend Architecture

**Entry Point**: `server/deepagents_server.py` - Uvicorn server on port 8000

**Session Management** (`server/sessions.py` - 1328 lines):
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
- Environment passthrough: `COZE_TOKEN`, `COZE_FLOW_ID`, `COZE_APP_ID`
- Bind workspace mode: `DEEPAGENTS_DOCKER_BIND_WORKSPACE=1` for development

**WebSocket Protocol** (`server/app.py`, `docs/protocol.md`):
- Server → Client events: `run.*`, `assistant.delta`, `assistant.message`, `tool.call.started`, `tool.call.ended`, `file.op`, `todos.updated`, `interrupt.*`
- Client → Server: `run`, `cancel`, `interrupt_response`, `auto_approve`

### Web Client Architecture

**Location**: `web/` - vanilla JavaScript, no build tools

**Entry Point**: `web/app.js` - `DeepAgentsClient` class (~1095 lines)

**State Management**:
- `currentRunId`, `isRunning` - Active agent run tracking
- `autoApprove` - Per-session toggle for automatic approval
- `messageBuffer` (Map) - Assemble streaming text chunks
- `currentToolCalls` (Map) - Track active tool calls
- `chatHistory` - LocalStorage persistence

**Event Routing** (`handleMessage`):
- `run.queued`, `run.started`, `run.completed`, `run.failed`, `run.cancelled`, `run.rejected`
- `assistant.delta` (streaming), `assistant.message` (full)
- `tool.call.started`, `tool.call.ended`
- `file.op` (with diff highlighting)
- `todos.updated`
- `interrupt.request`

**Files**:
- `web/index.html` - Main HTML structure
- `web/styles.css` - All styles (dark theme, ~1347 lines)
- `web/libs/` - Local copies of `marked.js`, `highlight.js`, `python.js`
- `web/app/auth.js` - Authentication handling
- `web/app/history.js` - Chat history persistence
- `web/app/network.js` - WebSocket communication
- `web/app/messages.js` - Message rendering
- `web/app/ui.js` - UI state management

### Skills System

**Location**: `skills/` directory (27+ skills)

Each skill is a self-contained package with `SKILL.md` documentation:
- Document skills: `docx`, `pdf`, `html2pdf`, `html2pptx`, `pptxgen2`, `doc-coauthoring`
- Research: `arxiv-search`, `web-research`, `langgraph-docs`, `deep-research`, `coze-search`
- Design: `canvas-design`, `algorithmic-art`, `frontend-design`, `web-artifacts-builder`, `theme-factory`, `brand-guidelines`
- Specialized: `stock-master`, `webapp-testing`, `mcp-builder`, `skill-creator`, `slack-gif-creator`, `internal-comms`
- Chinese-specific: `admission-advice`, `career-growth-planner`, `job-match`, `job-search-report`, `xuegong-web-research`

Skills are loaded by `SkillsMiddleware` and injected as agent tools.

## Configuration Files

### `config/model.yml`

LLM provider configurations (kimi, glm, qwen, qwen3-vl-plus, qwen-image-max, claude, openrouter):
```yaml
models:
  kimi:
    api_key: "..."
    base_url: "https://api.moonshot.cn/v1"
    model: "moonshot-v1-8k"
  glm:
    api_key: "..."
    base_url: "https://open.bigmodel.cn/api/paas/v4"
    model: "glm-4"
```

### `config/deepagents.yml`

Environment variables and paths:
```yaml
env:
  LANGCHAIN_TRACING_V2: "true"
  LANGCHAIN_API_KEY: "..."
  DEEPAGENTS_DOCKER_BIND_WORKSPACE: "1"  # Enable bind workspace for development
  COZE_TOKEN: "..."
  COZE_FLOW_ID: "..."
  COZE_APP_ID: "..."
  WEB_ROOT: "/Users/double/vsproject/deepagents/web"
  WEB_DEPLOY_DIR: "/path/to/nginx/root"
```

### `config/llm-scene.yml`

Scene-to-model mapping for run.sh:
```yaml
main: "glm"
```

### `.deepagents/agent.md`

Project-specific agent instructions (Chinese):

**Critical Rules**:
- 不能删除任何文件 - Never delete any files, even during cleanup or when explicitly requested
- Tool calls must include intent descriptions in content (no empty `{"content": ""}`)
- All generated files must go in `workspace/` directory
- Download URL format: `下载：/files/<workspace相对路径>` (strict format, no Markdown links or full URLs)
- HTML resources must use `/files/<workspace相对路径>` absolute paths
- Never reference paths outside `workspace/`

## File Path Handling (Critical)

- All paths must be absolute (e.g., `/Users/double/vsproject/deepagents/file.txt`)
- Workspace: `/workspace` inside container → `workspace/{session_id}/` on host
- Download prefix: `/files/` served from `workspace/` via `/files` route
- HTML resources: Use `/files/<workspace-relative-path>` format
- Example: Image at `workspace/assets/img.png` → HTML references `/files/assets/img.png`

## Download Output Format (Strict)

When providing file downloads to users, use **only** this exact format:
- `下载：/files/<workspace相对路径>` (e.g., `下载：/files/report.pdf`)
- **Forbidden**: Markdown links (`[text](url)`), wrapped links, full URLs, or paths without `/files/`
- The full URL is constructed at runtime by the frontend using hostname+8000 and `?server=` parameter

## LLM Provider Notes

Some providers (notably Qwen) do not stream tool call arguments. The `ToolCallArgsMiddleware` (`server/tool_args_middleware.py`) captures arguments at execution time to ensure the web client can display them correctly. This is why `tool.call.started` events may show empty `args: {}` for some providers.

## Code Style

- Python: 4-space indentation, snake_case filenames
- JavaScript: ES6 modules, arrow functions, template literals
- CSS: Custom properties in `:root`, BEM-like naming
- No repo-wide formatter; `black` is available in requirements.txt if needed
- Follow existing patterns in each file

## Key Dependencies

### Core Framework
- `deepagents==0.3.8` - Agent harness with built-in tools
- `deepagents-cli==0.0.13` - CLI utilities
- `langchain`, `langgraph` - LLM orchestration
- `langsmith==0.4.59` - LLM tracing

### Web Server
- `fastapi==0.127.0`, `uvicorn==0.40.0` - ASGI server
- `websockets==15.0.1` - WebSocket client

### LLM Providers
- `anthropic==0.75.0` - Claude API
- `openai==2.11.0` - OpenAI-compatible API
- `tavily-python==0.7.14` - Web search

### Browser & Automation
- `playwright==1.57.0` - Browser automation

### Document Processing
- `python-docx`, `python-pptx`, `pypdfium2`, `pdfplumber`, `fpdf2`, `weasyprint`, `pandoc`

## Important Files

- `server/sessions.py` - Session & run execution
- `server/agent.py` - Agent creation (`create_cli_agent`)
- `server/docker_pool.py` - Docker pool management
- `server/app.py` - FastAPI routes & WebSocket handler
- `server/browser_bridge.py` - Browser integration
- `server/tool_args_middleware.py` - Tool argument capture
- `server/skills_middleware.py` - Skill tool injection
- `server/config.py` - Server configuration and path setup
- `server/tool_call_args.py` - Tool call argument storage
- `web/app.js` - Main web client logic
- `web/app/network.js` - WebSocket communication
- `web/app/messages.js` - Message rendering
- `scripts/run.sh` - Server management script

## Security Notes

- Secrets in `config/` files - keep out of git
- Server writes user history to `data/users/` - avoid committing runtime artifacts
- WebSocket requires authentication for history/session access
- All file operations happen in Docker sandbox (or local shell in non-Docker mode)

## Debug Tool Calls

Set `DEEPAGENTS_DEBUG_TOOL_CALLS=1` to enable verbose logging of tool call arguments in `server/tool_args_middleware.py`. This helps diagnose issues with providers that don't stream tool call arguments (like Qwen).
