# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **web client** for DeepAgents - a browser-based UI for interacting with the DeepAgents AI agent server via WebSocket. It is a **vanilla JavaScript application** with no build tools, npm, or framework dependencies.

## Development Commands

### Start Local HTTP Server

```bash
cd /Users/double/vsproject/deepagents/web
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

### VS Code Tasks

- Use `Tasks: Run Task` → "start-server" to start the HTTP server via VS Code
- Debug configurations available in `.vscode/launch.json` for Chrome (port 8080)

### No Build/Test/Lint Commands

This is a static HTML/CSS/JS project with no build toolchain, tests, or linter configured.

## Architecture

### Technology Stack

- **Pure HTML/CSS/JavaScript** - No frameworks or build tools
- **WebSocket API** - Real-time bidirectional communication with the server
- **External Libraries** (local copies in `/libs/`):
  - `marked.js` - Markdown parsing
  - `highlight.js` + `python.js` - Syntax highlighting

### File Structure

```
web/
├── index.html       # Main HTML structure
├── styles.css       # All styles (dark theme, responsive, ~1347 lines)
├── app.js           # Main application logic (DeepAgentsClient class, ~1095 lines)
├── libs/            # Third-party libraries (local copies)
│   ├── marked.js
│   ├── highlight.js
│   ├── highlight.css
│   └── python.js
├── .vscode/         # VS Code configuration
│   ├── settings.json
│   ├── launch.json
│   └── tasks.json
├── README.md        # User documentation
└── CLAUDE.md        # This file
```

### Core Architecture Patterns

**Single Class Design**: The entire application is encapsulated in the `DeepAgentsClient` class in `app.js`:
- `constructor()` - Initializes state, configuration, and WebSocket
- `init()` - Entry point that caches elements, sets up listeners, and connects
- `handleMessage()` - Central event dispatcher for WebSocket messages
- `create*Element()` methods - Helper functions for creating UI components

**State Management**:
- `this.currentRunId`, `this.isRunning` - Track active agent run
- `this.autoApprove` - Auto-approve mode toggle
- `this.messageBuffer` (Map) - Assemble streaming text chunks
- `this.currentToolCalls` (Map) - Track active tool calls by ID
- `this.chatHistory` - LocalStorage persistence

**Event-Driven WebSocket**:
- All server-to-client events flow through `handleMessage()`
- Event type routing: `run.*`, `assistant.*`, `tool.*`, `file.op`, `todos.updated`, `interrupt.*`, `log`
- Client-to-server: `run`, `cancel`, `interrupt_response`, `auto_approve`

### CSS Architecture

- **CSS Custom Properties** in `:root` for theming (colors, spacing, shadows, border-radius)
- **Dark theme** by default with Kimi-inspired color palette
- **BEM-like naming**: `.tool-call`, `.tool-call-header`, `.tool-call-body`
- **Flexbox** for layout
- **Responsive**: Mobile breakpoint at `@media (max-width: 768px)`

### WebSocket Protocol Reference

**Client → Server**:
```javascript
{ "type": "run", "input": "message", "run_id": "optional" }
{ "type": "cancel" }
{ "type": "interrupt_response", "run_id": "...", "interrupt_id": "...", "response": {...} }
{ "type": "auto_approve", "enabled": true }
```

**Server → Client** (key events):
- `run.queued`, `run.started`, `run.completed`, `run.failed`, `run.cancelled`, `run.rejected`
- `assistant.delta` (streaming), `assistant.message` (full)
- `tool.call.started`, `tool.call.ended`
- `file.op` (with diff)
- `todos.updated`
- `interrupt.request`
- `log`

## Code Style

**JavaScript**:
- ES6+ class syntax
- Arrow functions for callbacks
- Template literals for HTML generation
- `escapeHtml()` function for XSS prevention on user content
- Event delegation for dynamically added elements

**CSS**:
- CSS custom properties (variables) in `:root`
- Dark theme color palette
- BEM-like naming convention
- Flexbox layouts

## Key Features

- **Tool Call Visualization**: Expandable cards with args/results
- **File Operation Tracking**: Read/write/edit with diff highlighting
- **Todo List Display**: Task progress tracking
- **Human-in-the-Loop**: Modal-based approve/reject workflow
- **Auto-Approve Mode**: Toggle for automatic approval
- **History Persistence**: Server-side per user (max 50 chats)
- **Markdown Rendering**: Via `marked.js`
- **Syntax Highlighting**: Via `highlight.js`
- **Responsive Design**: Mobile-friendly with collapsible sidebar

## Browser Compatibility

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Opera 76+

## Security

- All WebSocket communication is client-side; no external services
- Chat history stored on the server under `data/users/`
- User input sanitized via `escapeHtml()` before rendering
- Authentication required for history/session access
