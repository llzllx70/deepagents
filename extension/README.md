# DeepAgents Browser Bridge Extension

This is an unpacked Chrome extension that connects a user's local browser to the DeepAgents server via WebSocket + CDP.

## Load (Unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `deepagents/extension`

## Connect

1. Start the DeepAgents server.
2. Log in via the web client and create a session.
3. Copy `session_id` and `token`.
4. Click the extension icon, fill:
   - Server WS Base: `ws://localhost:8000/ws/browser`
   - Session ID: `<session_id>`
   - Token: `<token>`
5. Click **Connect** then **Bind Active Tab**.

The server can now request snapshots and send CDP actions.

ws://172.16.2.4:8000/ws/browser
e7a203d0040f489cb2fb6798e45b0810

