# DeepAgents Web Client

A modern web-based client for interacting with the DeepAgents server, inspired by Kimi's clean interface design.

## Features

- **Real-time WebSocket Communication**: Low-latency bidirectional communication with the server
- **Chat Interface**: Clean, modern UI with message history
- **Tool Call Visualization**: View tool execution with expandable details
- **File Operation Tracking**: See file reads, writes, and edits with diff highlighting
- **Todo List Display**: Track agent task progress
- **Human-in-the-Loop**: Approve or reject agent actions when needed
- **Auto-Approve Mode**: Toggle automatic action approval
- **History Persistence**: Chat history saved to local storage
- **Run Cancellation**: Stop running agent tasks
- **Responsive Design**: Works on desktop and mobile devices
- **Markdown Rendering**: Rich text display for assistant messages
- **Syntax Highlighting**: Code blocks with syntax highlighting

## Installation & Setup

### 1. Start the Server

First, make sure the DeepAgents server is running:

```bash
cd /Users/double/vsproject/deepagents
python server.py
```

The server will start on `http://127.0.0.1:8000` by default.

### 2. Open the Web Client

Open `web/index.html` in a web browser:

**Option 1: Direct file open**
```bash
open web/index.html
# or on Linux
xdg-open web/index.html
```

**Option 2: Using a simple HTTP server** (recommended for better compatibility)
```bash
cd web
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

**Option 3: Using an extension**
- VS Code: Install "Live Server" extension, right-click `index.html` → "Open with Live Server"

### 3. Connect to a Custom Server

To connect to a different server, add the `?server=` parameter to the URL:

```
http://localhost:8080/?server=http://192.168.1.100:8000
```

## Usage

### Basic Chat

1. Type your message in the input box at the bottom
2. Press `Cmd+Enter` (Mac) or `Ctrl+Enter` (Windows/Linux) to send
3. Or click the send button

### Commands

- **Cancel Current Run**: Click the square icon in the header to stop the current agent task
- **Auto Approve**: Toggle the switch in the sidebar to automatically approve all agent actions
- **New Chat**: Click the "New Chat" button to start a fresh conversation

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Enter` / `Ctrl+Enter` | Send message |
| `Escape` | Close modal dialogs |

### Understanding the Interface

#### Sidebar
- **Sessions**: List of active sessions (future feature)
- **History**: Previously saved conversations
- **Auto Approve Toggle**: Enable/disable automatic action approval
- **Connection Status**: Shows if connected to the server

#### Message Types

1. **User Messages**: Shown on the right with a gray background
2. **Assistant Messages**: Shown on the left with streaming text support
3. **Tool Calls**: Expandable cards showing:
   - Tool name
   - Arguments passed
   - Execution status (running/success/error)
   - Result preview
4. **File Operations**: Shows file paths, operation type, and diffs
5. **Todo Lists**: Task progress tracking
6. **Log Messages**: Info, warnings, and errors

#### Status Indicators

- **Running**: Blue spinner animation
- **Completed**: Green checkmark
- **Failed**: Red error indicator
- **Cancelled**: Orange warning indicator

## WebSocket Protocol

The web client communicates with the server using WebSocket. Here's the message format:

### Client → Server Messages

```javascript
// Start a new run
{ "type": "run", "input": "your message here", "run_id": "optional-id" }

// Cancel current run
{ "type": "cancel" }

// Respond to interrupt (approval request)
{
  "type": "interrupt_response",
  "run_id": "run-123",
  "interrupt_id": "interrupt-456",
  "response": {
    "decisions": [{ "type": "approve" }]  // or { "type": "reject", "message": "reason" }
  }
}

// Toggle auto approve
{ "type": "auto_approve", "enabled": true }
```

### Server → Client Events

```javascript
// Run lifecycle
{ "type": "run.queued", "run_id": "...", "session_id": "..." }
{ "type": "run.started", "run_id": "...", "session_id": "..." }
{ "type": "run.completed", "run_id": "...", "session_id": "..." }
{ "type": "run.failed", "run_id": "...", "error": "..." }
{ "type": "run.cancelled", "run_id": "...", "session_id": "..." }
{ "type": "run.rejected", "run_id": "...", "session_id": "..." }

// Assistant messages
{ "type": "assistant.delta", "run_id": "...", "text": "streaming text" }
{ "type": "assistant.message", "run_id": "...", "text": "full message" }

// Tool execution
{ "type": "tool.call.started", "run_id": "...", "tool_name": "...", "args": {...}, "tool_call_id": "..." }
{ "type": "tool.call.ended", "run_id": "...", "tool_name": "...", "status": "success", "content_preview": "..." }

// File operations
{
  "type": "file.op",
  "run_id": "...",
  "tool_name": "write_file",
  "path": "/path/to/file.py",
  "status": "success",
  "metrics": { "lines_added": 5, "lines_removed": 2 },
  "diff": "@@ -1,3 +1,5 @@..."
}

// Other events
{ "type": "todos.updated", "run_id": "...", "todos": [...] }
{ "type": "interrupt.request", "run_id": "...", "interrupt_id": "...", "request": {...} }
{ "type": "log", "level": "info", "message": "..." }
```

## File Structure

```
web/
├── index.html    # Main HTML structure
├── styles.css    # All styles (dark theme, responsive)
├── app.js        # Main application logic
└── README.md     # This file
```

## Browser Compatibility

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Opera 76+

## Development

### Adding New Features

1. **New Message Types**: Add handlers in `handleMessage()` method
2. **UI Components**: Create helper methods following `create*Element()` pattern
3. **Styles**: Add CSS classes to `styles.css`

### Customization

- **Theme Colors**: Modify CSS variables in `:root`
- **Server URL**: Change `this.serverUrl` in `getServerUrl()` method
- **History Limit**: Adjust slice value in `saveCurrentChat()`

## Troubleshooting

### Connection Issues

1. **Server not running**: Start `python server.py` first
2. **CORS errors**: Use an HTTP server instead of opening file directly
3. **Wrong URL**: Check the server URL in browser console

### Messages Not Appearing

1. Check browser console for errors
2. Verify WebSocket connection status in sidebar
3. Look for error messages in the chat

### History Not Saving

1. Check if localStorage is enabled in browser
2. Clear browser cache and try again
3. Check browser console for storage errors

## Security Notes

- The web client connects via WebSocket to the server
- All communication happens client-side; no data is sent to external services
- Chat history is stored locally in the browser
- For production use, consider adding authentication

## License

Same as the parent DeepAgents project.
