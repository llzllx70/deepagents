from __future__ import annotations

import json
import os
import platform
import shlex
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import DATA_DIR, LOG_DIR, ROOT, WORKSPACE_DIR, logger
from .docker_pool import DockerPoolConfig, DockerSandboxPool
from .models import (
    CreateSessionRequest,
    CreateSessionResponse,
    DeleteSessionResponse,
    HistoryPayload,
    AttachmentUploadItem,
    AttachmentUploadResponse,
    LoginRequest,
    LoginResponse,
    SessionStatePayload,
    UserConfigPayload,
)
from .sessions import RunRequest, Session, SessionManager, UploadedFile
from .browser_bridge import BrowserBridge
from .browser_router import BrowserRouter
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
browser_routers: dict[str, BrowserRouter] = {}


def get_or_create_router(username: str) -> BrowserRouter:
    if username not in browser_routers:
        browser_routers[username] = BrowserRouter(username)
    return browser_routers[username]

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"}
_TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".log",
    ".ini",
    ".cfg",
}
_DOC_EXTENSIONS = {".pdf", ".docx"}
_EXCEL_EXTENSIONS = {".xlsx", ".xls"}
_ALLOWED_EXTENSIONS = _IMAGE_EXTENSIONS | _TEXT_EXTENSIONS | _DOC_EXTENSIONS | _EXCEL_EXTENSIONS


def _guess_extension(content_type: str | None) -> str | None:
    if not content_type:
        return None
    content_type = content_type.lower()
    if content_type.startswith("image/"):
        return f".{content_type.split('/')[-1]}"
    if content_type in ("application/pdf",):
        return ".pdf"
    if content_type in (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ):
        return ".docx"
    if content_type in (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
    ):
        return ".xlsx"
    if content_type.startswith("text/"):
        return ".txt"
    return None


def _is_allowed_upload(ext: str | None, content_type: str | None) -> bool:
    if ext and ext.lower() in _ALLOWED_EXTENSIONS:
        return True
    if content_type and content_type.lower().startswith("image/"):
        return True
    if content_type and content_type.lower().startswith("text/"):
        return True
    if content_type and content_type.lower() == "application/pdf":
        return True
    return False


def _format_runtime_environment() -> dict[str, str | None]:
    return {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": platform.platform(),
        "cwd": os.getcwd(),
        "root": str(ROOT),
        "workspace": str(WORKSPACE_DIR),
        "data_dir": str(DATA_DIR),
        "log_dir": str(LOG_DIR),
        "project_skills_dir": os.environ.get("DEEPAGENTS_PROJECT_SKILLS_DIR"),
        "user_skills_root": os.environ.get("DEEPAGENTS_USER_SKILLS_ROOT"),
        "docker_image": os.environ.get("DEEPAGENTS_DOCKER_IMAGE"),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    global docker_pool, manager
    pool_config = DockerPoolConfig.from_env()
    logger.info(
        "Runtime environment: %s",
        json.dumps(_format_runtime_environment(), ensure_ascii=False),
    )
    logger.info("Lifespan startup: docker pool config=%s", pool_config)
    docker_pool = DockerSandboxPool(pool_config)
    await docker_pool.start()
    manager = SessionManager(docker_pool)
    try:
        yield
    finally:
        browser_routers.clear()
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
    router = browser_routers.get(username)
    session = await manager.create_session(req.assistant_id, req.auto_approve, username=username, browser_router=router)
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
    if owner is None:
        await set_session_owner(session_id, username)
    session, synced = await manager.delete_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await clear_session_owner(session_id)
    return DeleteSessionResponse(
        session_id=session.session_id,
        sandbox_id=session.sandbox_backend.id,
        synced=synced,
    )


@app.post("/sessions/{session_id}/attachments", response_model=AttachmentUploadResponse)
async def upload_attachments(
    session_id: str,
    request: Request,
    files: list[UploadFile] = File(...),
) -> AttachmentUploadResponse:
    username = await require_user(request)
    if manager is None:
        raise HTTPException(status_code=503, detail="Session manager unavailable")
    owner = await get_session_owner(session_id)
    if owner and owner != username:
        raise HTTPException(status_code=403, detail="Forbidden")
    session = await manager.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    responses: list[AttachmentUploadItem] = []
    upload_dir = session.workspace_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    container_root = getattr(session.sandbox_backend, "workdir", "/workspace").rstrip("/")

    for upload in files:
        filename = Path(upload.filename or "").name or "upload"
        ext = Path(filename).suffix.lower()
        if not ext:
            guessed = _guess_extension(upload.content_type)
            if guessed:
                ext = guessed
                filename = f"{filename}{guessed}"
        if not _is_allowed_upload(ext, upload.content_type):
            responses.append(
                AttachmentUploadItem(
                    file_id="",
                    filename=filename,
                    content_type=upload.content_type,
                    size=0,
                    container_path="",
                    status="error",
                    error="Unsupported file type",
                )
            )
            await upload.close()
            continue

        content = await upload.read()
        size = len(content)
        file_id = uuid.uuid4().hex
        unique_name = f"{file_id}_{filename}"
        host_path = upload_dir / unique_name
        try:
            host_path.write_bytes(content)
        except Exception as exc:
            responses.append(
                AttachmentUploadItem(
                    file_id=file_id,
                    filename=filename,
                    content_type=upload.content_type,
                    size=size,
                    container_path="",
                    status="error",
                    error=f"Failed to save file: {exc}",
                )
            )
            await upload.close()
            continue

        container_path = f"{container_root}/uploads/{unique_name}"
        upload_results = session.sandbox_backend.upload_files([(container_path, content)])
        if upload_results and upload_results[0].error:
            responses.append(
                AttachmentUploadItem(
                    file_id=file_id,
                    filename=filename,
                    content_type=upload.content_type,
                    size=size,
                    container_path=container_path,
                    status="error",
                    error=f"Upload to sandbox failed: {upload_results[0].error}",
                )
            )
            await upload.close()
            continue

        attachment = UploadedFile(
            file_id=file_id,
            filename=filename,
            content_type=upload.content_type,
            size=size,
            host_path=host_path,
            container_path=container_path,
        )
        session.register_uploaded_file(attachment)

        responses.append(
            AttachmentUploadItem(
                file_id=file_id,
                filename=filename,
                content_type=upload.content_type,
                size=size,
                container_path=container_path,
                status="ok",
            )
        )
        await upload.close()

    return AttachmentUploadResponse(session_id=session_id, files=responses)


@app.delete("/sessions/{session_id}/attachments/{file_id}")
async def delete_attachment(session_id: str, file_id: str, request: Request) -> dict[str, str]:
    username = await require_user(request)
    if manager is None:
        raise HTTPException(status_code=503, detail="Session manager unavailable")
    owner = await get_session_owner(session_id)
    if owner and owner != username:
        raise HTTPException(status_code=403, detail="Forbidden")
    session = await manager.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    attachment = session.remove_uploaded_file(file_id)
    if attachment is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    try:
        if attachment.host_path.exists():
            attachment.host_path.unlink()
    except Exception as exc:
        logger.warning("Failed to remove attachment file: %s (%s)", attachment.host_path, exc)

    if attachment.container_path:
        try:
            quoted = shlex.quote(attachment.container_path)
            result = session.sandbox_backend.execute(f"rm -f {quoted}")
            if result.exit_code != 0:
                logger.warning("Failed to remove attachment from sandbox: %s (%s)", attachment.container_path, result.output)
        except Exception as exc:
            logger.warning("Failed to remove attachment from sandbox: %s (%s)", attachment.container_path, exc)

    return {"status": "ok"}


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


@app.websocket("/ws/browser")
async def browser_websocket_endpoint(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    username = await get_user_for_token(token)
    if not username:
        await websocket.accept()
        await websocket.close(code=1008)
        return
    await websocket.accept()
    router = get_or_create_router(username)
    await router.attach_ws(websocket)

    # Bind router to any existing sessions for this user
    if manager is not None:
        for session_id, session in manager.sessions.items():
            owner = await get_session_owner(session_id)
            if owner == username and session.browser_bridge is not None:
                if session.browser_bridge._router is None:
                    session.browser_bridge.set_router(router)
                    router.register_bridge(session_id, session.browser_bridge)

    # Broadcast connected to all user sessions
    if manager is not None:
        for session_id in list(router._bridges.keys()):
            session = await manager.get_session(session_id)
            if session is not None:
                await session.broadcast({"type": "browser.connected", "username": username})

    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            response = await router.handle_extension_message(data)
            if response is not None:
                await websocket.send_text(json.dumps(response, ensure_ascii=False))
                # Forward snapshot summaries to the main session WS
                if response.get("type") == "browser.snapshot":
                    sid = response.get("session_id")
                    if sid and manager is not None:
                        session = await manager.get_session(sid)
                        if session is not None:
                            await session.broadcast(
                                {
                                    "type": "browser.snapshot",
                                    "session_id": sid,
                                    "summary": response.get("summary"),
                                }
                            )
    except WebSocketDisconnect:
        logger.info("Browser WS disconnected: user=%s", username)
    except Exception:
        logger.exception("Browser WS error: user=%s", username)
    finally:
        await router.detach_ws(websocket)
        # Broadcast disconnected to all user sessions
        if manager is not None:
            for session_id in list(router._bridges.keys()):
                session = await manager.get_session(session_id)
                if session is not None:
                    await session.broadcast({"type": "browser.disconnected", "username": username})


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
