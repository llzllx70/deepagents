from __future__ import annotations

import json
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import WORKSPACE_DIR, client_logger, logger
from .docker_pool import DockerPoolConfig, DockerSandboxPool
from .models import (
    ClientLogRequest,
    CreateSessionRequest,
    CreateSessionResponse,
    DeleteSessionResponse,
    HistoryPayload,
    LoginRequest,
    LoginResponse,
    SessionStatePayload,
    UserConfigPayload,
)
from .sessions import RunRequest, Session, SessionManager
from .browser_bridge import BrowserBridge
from .storage import (
    read_session_owners,
    read_user_config,
    read_user_history,
    read_user_session_state,
    write_session_owners,
    write_user_config,
    write_user_history,
    write_user_session_state,
)
from .auth import create_auth_token, delete_auth_token, get_user_for_token, verify_credentials

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


def extract_auth_token(request: Request) -> str | None:
    token = request.headers.get("X-Auth-Token")
    if token:
        return token.strip()
    query_token = request.query_params.get("token")
    if query_token:
        return query_token.strip()
    return None


async def require_user(request: Request) -> str:
    token = extract_auth_token(request)
    username = await get_user_for_token(token)
    if not username:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return username


async def get_session_owner(session_id: str) -> str | None:
    owners = await read_session_owners()
    entry = owners.get(session_id)
    if isinstance(entry, dict):
        owner = entry.get("username")
        if isinstance(owner, str) and owner:
            return owner
    return None


async def set_session_owner(session_id: str, username: str) -> None:
    owners = await read_session_owners()
    owners[session_id] = {"username": username, "created_at": time.time()}
    await write_session_owners(owners)


async def clear_session_owner(session_id: str) -> None:
    owners = await read_session_owners()
    if session_id in owners:
        owners.pop(session_id, None)
        await write_session_owners(owners)


@app.post("/login", response_model=LoginResponse)
async def login(payload: LoginRequest) -> LoginResponse:
    username = payload.username.strip()
    if not verify_credentials(username, payload.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = await create_auth_token(username)
    return LoginResponse(token=token, username=username)


@app.post("/logout")
async def logout(request: Request) -> dict[str, str]:
    token = extract_auth_token(request)
    await delete_auth_token(token)
    return {"status": "ok"}


@app.get("/me")
async def me(request: Request) -> dict[str, str]:
    username = await require_user(request)
    return {"username": username}


@app.get("/user_config")
async def get_user_config(request: Request) -> dict[str, Any]:
    username = await require_user(request)
    payload = await read_user_config(username)
    auto_approve = payload.get("auto_approve") if isinstance(payload, dict) else None
    if auto_approve is None:
        auto_approve = True
    return {"auto_approve": bool(auto_approve)}


@app.put("/user_config")
async def save_user_config(payload: UserConfigPayload, request: Request) -> dict[str, str]:
    username = await require_user(request)
    data = payload.model_dump()
    if data.get("auto_approve") is None:
        data["auto_approve"] = True
    await write_user_config(username, data)
    return {"status": "ok"}


@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session(req: CreateSessionRequest, request: Request) -> CreateSessionResponse:
    username = await require_user(request)
    if manager is None:
        raise HTTPException(status_code=503, detail="Session manager unavailable")
    logger.info(
        "Create session request: assistant_id=%s auto_approve=%s",
        req.assistant_id,
        req.auto_approve,
    )
    session = await manager.create_session(req.assistant_id, req.auto_approve)
    await set_session_owner(session.session_id, username)
    return CreateSessionResponse(
        session_id=session.session_id,
        sandbox_id=session.sandbox_backend.id,
    )


@app.delete("/sessions/{session_id}", response_model=DeleteSessionResponse)
async def delete_session(session_id: str, request: Request) -> DeleteSessionResponse:
    username = await require_user(request)
    if manager is None:
        raise HTTPException(status_code=503, detail="Session manager unavailable")
    owner = await get_session_owner(session_id)
    if owner and owner != username:
        raise HTTPException(status_code=403, detail="Forbidden")
    session, synced = await manager.delete_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await clear_session_owner(session_id)
    return DeleteSessionResponse(
        session_id=session.session_id,
        sandbox_id=session.sandbox_backend.id,
        synced=synced,
    )


@app.get("/history")
async def get_history(request: Request) -> dict[str, Any]:
    username = await require_user(request)
    payload = await read_user_history(username)
    return {"history": payload}


@app.put("/history")
async def save_history(payload: HistoryPayload, request: Request) -> dict[str, str]:
    username = await require_user(request)
    await write_user_history(username, payload.history)
    return {"status": "ok"}


@app.get("/session_state")
async def get_session_state(request: Request) -> dict[str, Any]:
    username = await require_user(request)
    payload = await read_user_session_state(username)
    return payload


@app.put("/session_state")
async def save_session_state(payload: SessionStatePayload, request: Request) -> dict[str, str]:
    username = await require_user(request)
    data = payload.model_dump()
    if data.get("timestamp") is None:
        data["timestamp"] = time.time()
    data.pop("client_id", None)
    await write_user_session_state(username, data)
    return {"status": "ok"}


@app.post("/client_logs")
async def client_logs(req: ClientLogRequest, request: Request) -> dict[str, str]:
    username = await get_user_for_token(extract_auth_token(request))
    payload = {
        "event": req.event,
        "level": req.level or "info",
        "session_id": req.session_id,
        "ts": req.ts or time.time(),
        "detail": req.detail or {},
    }
    if username:
        payload["user"] = username
    client_logger.info(json.dumps(payload, ensure_ascii=False))
    return {"status": "ok"}


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    if manager is None:
        await websocket.accept()
        await websocket.close(code=1011)
        return
    token = websocket.query_params.get("token")
    username = await get_user_for_token(token)
    if not username:
        await websocket.accept()
        await websocket.close(code=1008)
        return
    owner = await get_session_owner(session_id)
    if owner and owner != username:
        await websocket.accept()
        await websocket.close(code=1008)
        return
    if owner is None:
        await set_session_owner(session_id, username)
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


@app.websocket("/ws/browser/{session_id}")
async def browser_websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    if manager is None:
        await websocket.accept()
        await websocket.close(code=1011)
        return
    token = websocket.query_params.get("token")
    username = await get_user_for_token(token)
    if not username:
        await websocket.accept()
        await websocket.close(code=1008)
        return
    owner = await get_session_owner(session_id)
    if owner and owner != username:
        await websocket.accept()
        await websocket.close(code=1008)
        return
    if owner is None:
        await set_session_owner(session_id, username)
    session = await manager.get_session(session_id)
    if session is None:
        await websocket.accept()
        await websocket.close(code=1008)
        return

    await websocket.accept()
    if session.browser_bridge is None:
        session.browser_bridge = BrowserBridge(session_id=session_id)
    await session.browser_bridge.attach(websocket, meta={"username": username})
    logger.info("Browser WS connected: session_id=%s", session_id)
    await session.broadcast({"type": "browser.connected", "session_id": session_id})
    if manager is not None:
        await manager.activate_session(session_id)

    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            response = await session.browser_bridge.handle_message(data)
            if response is not None:
                await websocket.send_text(json.dumps(response, ensure_ascii=False))
                if response.get("type") == "browser.snapshot":
                    await session.broadcast(
                        {
                            "type": "browser.snapshot",
                            "session_id": session_id,
                            "summary": response.get("summary"),
                        }
                    )
    except WebSocketDisconnect:
        logger.info("Browser WS disconnected: session_id=%s", session_id)
    except Exception:
        logger.exception("Browser WS error: session_id=%s", session_id)
    finally:
        if session.browser_bridge is not None:
            await session.browser_bridge.detach(websocket)
        await session.broadcast({"type": "browser.disconnected", "session_id": session_id})
        if not session.connections and manager is not None:
            await manager.deactivate_session(session_id)


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
