from __future__ import annotations

import json
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import HISTORY_PATH, SESSION_STATE_PATH, WORKSPACE_DIR, client_logger, logger
from deepagents_cli.integrations.docker_pool import DockerPoolConfig, DockerSandboxPool
from .models import (
    ClientLogRequest,
    CreateSessionRequest,
    CreateSessionResponse,
    DeleteSessionResponse,
    HistoryPayload,
    SessionStatePayload,
)
from .sessions import RunRequest, Session, SessionManager
from .storage import HISTORY_LOCK, SESSION_STATE_LOCK, read_json_file, write_json_file

docker_pool: DockerSandboxPool | None = None
manager: SessionManager | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global docker_pool, manager
    pool_config = DockerPoolConfig.from_env()
    logger.info("Lifespan startup: docker pool config=%s", pool_config)
    docker_pool = DockerSandboxPool(pool_config)
    await docker_pool.start()
    manager = SessionManager(docker_pool)
    try:
        yield
    finally:
        if manager is not None:
            await manager.shutdown()
        if docker_pool is not None:
            await docker_pool.shutdown()
        logger.info("Lifespan shutdown complete")


app = FastAPI(lifespan=lifespan)
app.mount("/files", StaticFiles(directory=WORKSPACE_DIR), name="files")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session(req: CreateSessionRequest) -> CreateSessionResponse:
    if manager is None:
        raise HTTPException(status_code=503, detail="Session manager unavailable")
    logger.info(
        "Create session request: assistant_id=%s auto_approve=%s",
        req.assistant_id,
        req.auto_approve,
    )
    session = await manager.create_session(req.assistant_id, req.auto_approve)
    return CreateSessionResponse(
        session_id=session.session_id,
        sandbox_id=session.sandbox_backend.id,
    )


@app.delete("/sessions/{session_id}", response_model=DeleteSessionResponse)
async def delete_session(session_id: str) -> DeleteSessionResponse:
    if manager is None:
        raise HTTPException(status_code=503, detail="Session manager unavailable")
    session, synced = await manager.delete_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return DeleteSessionResponse(
        session_id=session.session_id,
        sandbox_id=session.sandbox_backend.id,
        synced=synced,
    )


@app.get("/history")
async def get_history() -> dict[str, Any]:
    async with HISTORY_LOCK:
        payload = await read_json_file(HISTORY_PATH)
    if not isinstance(payload, list):
        payload = []
    return {"history": payload}


@app.put("/history")
async def save_history(payload: HistoryPayload) -> dict[str, str]:
    async with HISTORY_LOCK:
        await write_json_file(HISTORY_PATH, payload.history)
    return {"status": "ok"}


@app.get("/session_state")
async def get_session_state(client_id: str | None = None) -> dict[str, Any]:
    async with SESSION_STATE_LOCK:
        payload = await read_json_file(SESSION_STATE_PATH)
    if not isinstance(payload, dict):
        payload = {}
    if client_id:
        clients = payload.get("clients")
        if isinstance(clients, dict):
            return clients.get(client_id, {}) or {}
        return {}
    return payload


@app.put("/session_state")
async def save_session_state(payload: SessionStatePayload) -> dict[str, str]:
    data = payload.model_dump()
    if data.get("timestamp") is None:
        data["timestamp"] = time.time()
    async with SESSION_STATE_LOCK:
        state = await read_json_file(SESSION_STATE_PATH)
        if not isinstance(state, dict):
            state = {}
        clients = state.get("clients")
        if not isinstance(clients, dict):
            clients = {}
        client_id = data.get("client_id")
        if client_id:
            entry = {
                "session_id": data.get("session_id"),
                "chat_id": data.get("chat_id"),
                "has_messages": data.get("has_messages", False),
                "timestamp": data.get("timestamp"),
            }
            clients[client_id] = entry
            state["clients"] = clients
            await write_json_file(SESSION_STATE_PATH, state)
        else:
            await write_json_file(SESSION_STATE_PATH, data)
    return {"status": "ok"}


@app.post("/client_logs")
async def client_logs(req: ClientLogRequest) -> dict[str, str]:
    payload = {
        "event": req.event,
        "level": req.level or "info",
        "session_id": req.session_id,
        "ts": req.ts or time.time(),
        "detail": req.detail or {},
    }
    client_logger.info(json.dumps(payload, ensure_ascii=False))
    return {"status": "ok"}


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    if manager is None:
        await websocket.accept()
        await websocket.close(code=1011)
        return
    session = await manager.get_session(session_id)
    if session is None:
        await websocket.accept()
        await websocket.close(code=1008)
        return
    await websocket.accept()
    logger.info("WebSocket connected: session_id=%s", session_id)
    session.connections.add(websocket)
    if manager is not None:
        await manager.activate_session(session_id)
    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            await handle_client_message(session, data)
    except WebSocketDisconnect:
        session.connections.discard(websocket)
        logger.info("WebSocket disconnected: session_id=%s", session_id)
        if not session.connections and manager is not None:
            await manager.deactivate_session(session_id)
    except Exception:
        session.connections.discard(websocket)
        logger.exception("WebSocket error: session_id=%s", session_id)
        if not session.connections and manager is not None:
            await manager.deactivate_session(session_id)
        await websocket.close(code=1011)


async def handle_client_message(session: Session, data: dict[str, Any]) -> None:
    msg_type = data.get("type")
    if msg_type == "run":
        if manager is not None:
            await manager.activate_session(session.session_id)
        user_input = str(data.get("input", "")).strip()
        if not user_input:
            await session.broadcast(
                {"type": "log", "level": "warning", "message": "Empty input ignored."}
            )
            return
        run_request = RunRequest(
            run_id=data.get("run_id") or uuid.uuid4().hex,
            user_input=user_input,
            auto_approve=data.get("auto_approve"),
        )
        await session.enqueue_run(run_request)
        return

    if msg_type == "cancel":
        cancelled = await session.cancel_current_run()
        if not cancelled:
            await session.broadcast(
                {"type": "log", "level": "warning", "message": "No active run to cancel."}
            )
        else:
            logger.info("Run cancel requested: session_id=%s", session.session_id)
        return

    if msg_type == "run.status":
        run_id = data.get("run_id")
        if not run_id:
            await session.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "message": "Missing run_id for run.status request.",
                }
            )
            return
        current_run_id = session.current_run.run_id if session.current_run else None
        status = session.run_status.get(run_id)
        if status is None and current_run_id == run_id:
            status = "running"
        if status is None:
            status = "unknown"
        await session.broadcast(
            {
                "type": "run.status",
                "run_id": run_id,
                "status": status,
                "session_id": session.session_id,
                "current_run_id": current_run_id,
            }
        )
        return

    if msg_type == "interrupt_response":
        run_id = data.get("run_id")
        interrupt_id = data.get("interrupt_id")
        response = data.get("response")
        if not run_id or not interrupt_id or not response:
            await session.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "message": "Invalid interrupt response payload.",
                }
            )
            return
        if session.current_run is None or session.current_run.run_id != run_id:
            await session.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "message": "Interrupt response does not match active run.",
                }
            )
            return
        resolved = session.current_run.resolve_interrupt(interrupt_id, response)
        if not resolved:
            await session.broadcast(
                {
                    "type": "log",
                    "level": "warning",
                    "message": "Interrupt response already handled.",
                }
            )
        return

    if msg_type == "auto_approve":
        enabled = bool(data.get("enabled"))
        session.session_state.auto_approve = enabled
        await session.broadcast({"type": "session.auto_approve", "enabled": enabled})
        return

    await session.broadcast(
        {"type": "log", "level": "warning", "message": f"Unknown message type: {msg_type}"}
    )
