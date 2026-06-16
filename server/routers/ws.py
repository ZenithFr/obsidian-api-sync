"""
routers/ws.py -- WebSocket endpoint and connection manager for Obsidian API Sync.

Provides real-time bidirectional sync between the server vault and any connected
Obsidian plugin clients.  All file-write events are broadcast to every active
connection so multiple clients stay in sync.

Security hardening:
  - 10 MB message size cap
  - Async ping/pong keepalive every 30 seconds
  - Proper exception logging (no silent swallowing)
"""

import asyncio
import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from auth import verify_ws_token
from config import settings
from database import add_audit, get_vault_path
from storage import get_backend

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_FILE_SIZE_BYTES = settings.MAX_FILE_SIZE_BYTES
PING_INTERVAL_SECONDS = 30


# -- Utilities ----------------------------------------------------------------

def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize_path(vault_path: str, relative_path: str) -> Path:
    """
    Resolve and validate that relative_path does not escape the vault root.

    Raises:
        ValueError: If the resolved path lies outside the vault root.
    """
    vault_root = Path(vault_path).resolve()
    target = (vault_root / relative_path).resolve()

    if not str(target).startswith(str(vault_root) + "/") and str(target) != str(vault_root):
        raise ValueError(f"Path traversal detected: '{relative_path}' escapes the vault root.")
    return target


# -- Connection Manager -------------------------------------------------------

class ConnectionManager:
    """
    Tracks all active WebSocket connections and provides broadcast helpers.
    Thread-safety: FastAPI runs in a single-threaded async event loop.
    """

    def __init__(self) -> None:
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.append(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict, exclude: WebSocket | None = None) -> None:
        """
        Send a JSON message to every connected client, optionally skipping one
        (used to avoid echoing a message back to its sender).
        Dead connections are silently removed.
        """
        dead: list[WebSocket] = []
        payload = json.dumps(message)
        for ws in list(self.active):
            if ws is exclude:
                continue
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(ws)


# Module-level singleton shared with files.py so REST writes also broadcast.
manager = ConnectionManager()


# -- WebSocket Endpoint -------------------------------------------------------

@router.websocket("/ws/sync")
async def websocket_sync(websocket: WebSocket, token: str = "") -> None:
    """
    Real-time bidirectional vault sync endpoint.

    Authentication: pass your Bearer token as the `token` query parameter:
        wss://your-server/ws/sync?token=<your_token>

    Close code 4001 is sent when authentication fails.
    """
    # Auth
    token_data = await verify_ws_token(token)
    if token_data is None:
        await websocket.accept()
        await websocket.close(code=4001)
        return

    await manager.connect(websocket)
    client_id = str(uuid4())
    await websocket.send_json({"type": "CONNECTED", "client_id": client_id})
    await add_audit(method="WS", path=None, token_id=token_data["id"], action="CONNECT")

    # Ping task: keeps the connection alive and detects dead peers proactively
    async def _ping_loop() -> None:
        while True:
            await asyncio.sleep(PING_INTERVAL_SECONDS)
            try:
                await websocket.send_json({"type": "PING", "ts": _utcnow_iso()})
            except Exception:
                break

    ping_task = asyncio.create_task(_ping_loop())

    try:
        while True:
            raw = await websocket.receive_text()

            # Size guard (#7) — reject oversized messages before parsing
            if len(raw.encode("utf-8")) > MAX_FILE_SIZE_BYTES:
                await websocket.send_json({
                    "type": "ERROR",
                    "code": "PAYLOAD_TOO_LARGE",
                    "message": f"Message exceeds maximum size of {MAX_FILE_SIZE_BYTES // (1024*1024)} MB.",
                })
                continue

            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({
                    "type": "ERROR", "code": "INVALID_JSON",
                    "message": "Message body is not valid JSON.",
                })
                continue

            msg_type = payload.get("type")

            # Client responding to our PING -- no-op
            if msg_type == "PONG":
                continue

            if msg_type not in ("FILE_MODIFY", "FILE_DELETE", "FILE_RENAME", "FOLDER_CREATE"):
                await websocket.send_json({
                    "type": "ERROR", "code": "UNKNOWN_TYPE",
                    "message": f"Unknown message type: '{msg_type}'.",
                })
                continue

            # Validate path present
            file_path: str | None = payload.get("path")
            if not file_path:
                await websocket.send_json({"type": "ERROR", "code": "INVALID_PAYLOAD", "message": "'path' is required."})
                continue

            # Path sanitization
            vault_path = await get_vault_path()
            try:
                target_file = _sanitize_path(vault_path, file_path)
            except ValueError as exc:
                await websocket.send_json({"type": "ERROR", "code": "PATH_TRAVERSAL", "message": str(exc)})
                continue

            # -- FILE_MODIFY --------------------------------------------------
            if msg_type == "FILE_MODIFY":
                content: str | None = payload.get("content")
                if content is None:
                    await websocket.send_json({"type": "ERROR", "code": "INVALID_PAYLOAD", "message": "FILE_MODIFY requires 'content'."})
                    continue

                backend = await get_backend()
                size_bytes = await backend.write_file(file_path, content)
                ts = _utcnow_iso()
                await manager.broadcast(
                    {"type": "FILE_CHANGED", "path": file_path, "content": content, "source": "ws", "ts": ts},
                    exclude=websocket,
                )
                await add_audit(method="WS", path=file_path, token_id=token_data["id"], action="WRITE")

            # -- FILE_DELETE --------------------------------------------------
            elif msg_type == "FILE_DELETE":
                backend = await get_backend()
                if await backend.exists(file_path):
                    await backend.delete(file_path)

                ts = _utcnow_iso()
                await manager.broadcast(
                    {"type": "FILE_DELETED", "path": file_path, "source": "ws", "ts": ts},
                    exclude=websocket,
                )
                await add_audit(method="WS", path=file_path, token_id=token_data["id"], action="DELETE")

            # -- FILE_RENAME --------------------------------------------------
            elif msg_type == "FILE_RENAME":
                new_path: str | None = payload.get("new_path")
                if not new_path:
                    await websocket.send_json({"type": "ERROR", "code": "INVALID_PAYLOAD", "message": "FILE_RENAME requires 'new_path'."})
                    continue

                backend = await get_backend()
                if await backend.exists(file_path):
                    old_content = await backend.read_file(file_path)
                    await backend.write_file(new_path, old_content)
                    await backend.delete(file_path)

                ts = _utcnow_iso()
                await manager.broadcast(
                    {"type": "FILE_RENAMED", "old_path": file_path, "new_path": new_path, "source": "ws", "ts": ts},
                    exclude=websocket,
                )
                await add_audit(method="WS", path=f"{file_path} -> {new_path}", token_id=token_data["id"], action="RENAME")

            # -- FOLDER_CREATE ------------------------------------------------
            elif msg_type == "FOLDER_CREATE":
                backend = await get_backend()
                await backend.create_folder(file_path)
                ts = _utcnow_iso()
                await manager.broadcast(
                    {"type": "FOLDER_CREATED", "path": file_path, "source": "ws", "ts": ts},
                    exclude=websocket,
                )
                await add_audit(method="WS", path=file_path, token_id=token_data["id"], action="CREATE_DIR")

    except WebSocketDisconnect:
        pass  # Normal client disconnect
    except Exception as exc:
        # Log unexpected errors for intrusion detection / debugging (#12)
        logger.exception("Unexpected WebSocket error for client %s: %s", client_id, exc)
    finally:
        ping_task.cancel()
        await manager.disconnect(websocket)
        await add_audit(method="WS", path=None, token_id=token_data["id"], action="DISCONNECT")
