# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DeepAgents is an open-source AI agent framework built on LangGraph. It has two main packages:

- **`deepagents`** (`libs/deepagents/`): Core library with agent runtime, backends, and middleware
- **`deepagents-cli`** (`libs/deepagents-cli/`): Interactive CLI with skills, memory, and HITL workflows

## Development Commands

### Core Package (`libs/deepagents/`)

```bash
cd libs/deepagents

make lint           # Ruff format + check + mypy (line-length: 150)
make lint_diff      # Lint only changed files vs master
make format         # Format and fix all files
make test           # Unit tests with coverage
make integration_test
```

### CLI Package (`libs/deepagents-cli/`)

```bash
cd libs/deepagents-cli

make lint           # Line-length: 100
make format
make format_unsafe  # Apply unsafe fixes
make test           # Unit tests (--disable-socket)
make test_integration
make run            # Run CLI via uvx
```

### Running Tests

```bash
# Specific test file
cd libs/deepagents && uv run pytest tests/unit_tests/test_backend.py
cd libs/deepagents-cli && uv run pytest tests/unit_tests/test_agent.py

# With coverage
uv run pytest --cov=deepagents --cov-report=term-missing
```

### Running the Application

```bash
# CLI mode
deepagents --agent mybot --auto-approve --sandbox modal

# Server mode (WebSocket)
python server.py                    # Runs on http://127.0.0.1:8000
python client.py --server http://127.0.0.1:8000 --assistant-id agent
```

## Architecture

The agent uses a **middleware stack** applied in `create_deep_agent()`:

1. **TodoListMiddleware** - Task planning (`write_todos`, `read_todos`)
2. **FilesystemMiddleware** - File ops (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `execute`)
3. **SubAgentMiddleware** - Delegate to sub-agents (`task` tool)
4. **SummarizationMiddleware** - Auto-summarize at ~170k tokens
5. **AnthropicPromptCachingMiddleware** - Cache system prompts (Anthropic only)
6. **PatchToolCallsMiddleware** - Fix dangling tool calls from interruptions
7. **HumanInTheLoopMiddleware** - Pauses for approval (if `interrupt_on` configured)

CLI adds:
- **AgentMemoryMiddleware** - Load user/project memory files
- **SkillsMiddleware** - Progressive disclosure skill loading
- **ShellMiddleware** - Local shell execution

### Key Files

- `libs/deepagents/deepagents/graph.py` - `create_deep_agent()` entry point
- `libs/deepagents-cli/deepagents_cli/main.py` - CLI entry point
- `libs/deepagents-cli/deepagents_cli/execution.py` - Stream execution engine
- `server.py` / `client.py` - WebSocket server/client mode

### Memory & Skills System

- **User Memory**: `~/.deepagents/agent/agent.md`
- **Project Memory**: `.deepagents/agent.md` (preferred) or `agent.md` in project root
- **Skills**: `.deepagents/skills/*/SKILL.md` - progressive disclosure, indexed but loaded on-demand
- Skills defined in `/skills/` are symlinked to `.deepagents/skills/`

## Code Style

- Python 3.11+
- Package manager: `uv` (preferred) or pip
- Linter: Ruff + mypy (strict)
- Line length: 150 (core), 100 (CLI)
- Tests: `test_*.py` naming in `tests/` folders

## Environment Variables

- `ANTHROPIC_API_KEY` - Required for Anthropic models
- `TAVILY_API_KEY` - Optional, for web search
- `OPENAI_API_KEY` - Optional, for OpenAI models
