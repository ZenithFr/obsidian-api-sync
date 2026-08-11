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
import base64
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from auth import verify_ws_token
from config import settings
from database import add_audit, get_vault_path
from locks import file_locks
from version_control import _get_versions_dir, move_to_trash, save_version
from hashing import fnv1a as _fnv1a

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

    try:
        rel_parts = target.relative_to(vault_root).parts
        if rel_parts and rel_parts[0] in (".sync_versions", ".sync_trash"):
            raise ValueError("Access to internal sync folders is forbidden.")
    except ValueError:
        pass

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
    if not token and websocket.session.get("authenticated"):
        token_data = {"id": None, "label": "dashboard-session"}
    else:
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

            try:
                # -- FILE_MODIFY --------------------------------------------------
                if msg_type == "FILE_MODIFY":
                    content: str | None = payload.get("content")
                    is_binary: bool = payload.get("is_binary", False)
                    if content is None:
                        await websocket.send_json({"type": "ERROR", "code": "INVALID_PAYLOAD", "message": "FILE_MODIFY requires 'content'."})
                        continue

                    lock = await file_locks.acquire(str(target_file))
                    async with lock:
                        if target_file.exists():
                            conflict = False
                            if not is_binary:
                                base_hash: str | None = payload.get("base_hash")
                                if base_hash:
                                    current_content = await asyncio.to_thread(target_file.read_text, encoding="utf-8", errors="replace")
                                    current_hash = _fnv1a(current_content)
                                    if current_hash != base_hash:
                                        resolution = settings.CONFLICT_RESOLUTION.lower()
                                        if resolution == "client":
                                            conflict = False  # client wins – overwrite
                                        elif resolution == "server":
                                            conflict = True
                                        else:
                                            conflict = True
                                        if conflict:
                                            mtime_ts = int(target_file.stat().st_mtime * 1000)
                                            await websocket.send_json({"type": "ERROR", "code": "CONFLICT", "message": "File modified on server.", "path": file_path, "server_mtime": mtime_ts})
                                            continue
                            await asyncio.to_thread(save_version, Path(vault_path), file_path)
                        else:
                            # File does not exist – check trash for resurrection
                            trash_candidate = Path(vault_path) / ".sync_trash" / file_path
                            if trash_candidate.exists():
                                resolution = settings.CONFLICT_RESOLUTION.lower()
                                if resolution == "server":
                                    await websocket.send_json({"type": "ERROR", "code": "CONFLICT", "message": "File has been deleted on server.", "path": file_path})
                                    continue
                                # client/manual: only allow resurrection when explicit force
                                if not payload.get("force", False):
                                    await websocket.send_json({"type": "ERROR", "code": "CONFLICT", "message": "File is in trash. Send with force=true to resurrect.", "path": file_path})
                                    continue
        
                        target_file.parent.mkdir(parents=True, exist_ok=True)
                        
                        if is_binary:
                            try:
                                raw_bytes = base64.b64decode(content)
                                def _atomic_write_bin(target_file=target_file, raw_bytes=raw_bytes):
                                    tmp = target_file.with_name(f"{target_file.name}.{uuid4().hex}.tmp")
                                    tmp.write_bytes(raw_bytes)
                                    os.replace(tmp, target_file)
                                await asyncio.to_thread(_atomic_write_bin)
                            except IsADirectoryError:
                                await websocket.send_json({"type": "ERROR", "code": "INVALID_PATH", "message": "Target path is a directory."})
                                continue
                            except Exception as e:
                                await websocket.send_json({"type": "ERROR", "code": "INVALID_PAYLOAD", "message": f"Failed to decode base64: {e}"})
                                continue
                        else:
                            try:
                                def _atomic_write_txt(target_file=target_file, content=content):
                                    tmp = target_file.with_name(f"{target_file.name}.{uuid4().hex}.tmp")
                                    tmp.write_text(content, encoding="utf-8")
                                    os.replace(tmp, target_file)
                                await asyncio.to_thread(_atomic_write_txt)
                            except IsADirectoryError:
                                await websocket.send_json({"type": "ERROR", "code": "INVALID_PATH", "message": "Target path is a directory."})
                                continue
                        
                    ts = _utcnow_iso()
                    # Broadcast to all OTHER clients (exclude sender to prevent echo)
                    await manager.broadcast(
                        {"type": "FILE_CHANGED", "path": file_path, "content": None if is_binary else content, "is_binary": is_binary, "source": "ws", "ts": ts},
                        exclude=websocket,
                    )
                    await add_audit(method="WS", path=file_path, token_id=token_data["id"], action="WRITE")

                # -- FILE_DELETE --------------------------------------------------
                elif msg_type == "FILE_DELETE":
                    lock = await file_locks.acquire(str(target_file))
                    async with lock:
                        if target_file.exists():
                            await asyncio.to_thread(move_to_trash, Path(vault_path), file_path)

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

                    try:
                        target_new = _sanitize_path(vault_path, new_path)
                    except ValueError as exc:
                        await websocket.send_json({"type": "ERROR", "code": "PATH_TRAVERSAL", "message": str(exc)})
                        continue

                    lock_old = await file_locks.acquire(str(target_file))
                    lock_new = await file_locks.acquire(str(target_new))
                    locks = [lock_old, lock_new] if str(target_file) < str(target_new) else [lock_new, lock_old]
                    async with locks[0], locks[1]:
                        if target_file.exists():
                            await asyncio.to_thread(save_version, Path(vault_path), file_path)
                            target_new.parent.mkdir(parents=True, exist_ok=True)
                            try:
                                await asyncio.to_thread(target_file.rename, target_new)
                            except IsADirectoryError:
                                await websocket.send_json({"type": "ERROR", "code": "INVALID_PATH", "message": "Target path is a directory."})
                                continue
                                
                            old_versions_dir = _get_versions_dir(Path(vault_path)) / file_path
                            if old_versions_dir.exists():
                                new_versions_dir = _get_versions_dir(Path(vault_path)) / new_path
                                new_versions_dir.parent.mkdir(parents=True, exist_ok=True)
                                await asyncio.to_thread(old_versions_dir.rename, new_versions_dir)

                    ts = _utcnow_iso()
                    await manager.broadcast(
                        {"type": "FILE_RENAMED", "old_path": file_path, "new_path": new_path, "source": "ws", "ts": ts},
                        exclude=websocket,
                    )
                    await add_audit(method="WS", path=f"{file_path} -> {new_path}", token_id=token_data["id"], action="RENAME")

                # -- FOLDER_CREATE ------------------------------------------------
                elif msg_type == "FOLDER_CREATE":
                    lock = await file_locks.acquire(str(target_file))
                    async with lock:
                        if target_file.exists():
                            await websocket.send_json({"type": "NO_UPDATE_NEEDED", "code": "PATH_EXISTS", "message": "Path already exists."})
                            continue
                        try:
                            await asyncio.to_thread(target_file.mkdir, parents=True, exist_ok=True)
                        except FileExistsError:
                            await websocket.send_json({"type": "NO_UPDATE_NEEDED", "code": "PATH_EXISTS", "message": "A file already exists at this path."})
                            continue
                    ts = _utcnow_iso()
                    await manager.broadcast(
                        {"type": "FOLDER_CREATED", "path": file_path, "source": "ws", "ts": ts},
                        exclude=websocket,
                    )
                    await add_audit(method="WS", path=file_path, token_id=token_data["id"], action="CREATE_DIR")
            except Exception as e:
                logger.error(f"File operation failed in WS: {e}")
                await websocket.send_json({"type": "ERROR", "code": "FS_ERROR", "message": str(e)})

    except WebSocketDisconnect:
        pass  # Normal client disconnect
    except Exception:
        # Log unexpected errors for intrusion detection / debugging (#12)
        logger.exception("Unexpected WebSocket error for client %s", client_id)
    finally:
        ping_task.cancel()
        await manager.disconnect(websocket)
        await add_audit(method="WS", path=None, token_id=token_data["id"], action="DISCONNECT")
