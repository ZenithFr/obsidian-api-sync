"""
routers/ws.py — WebSocket endpoint and connection manager for Obsidian API Sync API.

Provides real-time bidirectional sync between the server vault and any connected
Obsidian plugin clients (or other consumers).  All file-write events are
broadcast to every active connection so that multiple clients stay in sync.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from auth import verify_ws_token
from database import add_audit, get_vault_path

router = APIRouter()


# ── Utilities ─────────────────────────────────────────────────────────────────

def _utcnow_iso() -> str:
    """Return the current UTC timestamp as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _sanitize_path(vault_path: str, relative_path: str) -> Path:
    """
    Resolve and validate that *relative_path* does not escape the vault root.

    Args:
        vault_path:    Absolute (or relative-to-cwd) vault directory path from DB.
        relative_path: Client-supplied path to a file within the vault.

    Returns:
        The fully resolved absolute :class:`~pathlib.Path` of the target file.

    Raises:
        ValueError: If the resolved path lies outside the vault root (traversal
                    attempt).
    """
    vault_root = Path(vault_path).resolve()
    target = (vault_root / relative_path).resolve()

    if not str(target).startswith(str(vault_root)):
        raise ValueError(
            f"Path traversal detected: '{relative_path}' escapes the vault root."
        )
    return target


# ── Connection Manager ────────────────────────────────────────────────────────

class ConnectionManager:
    """
    Tracks all active WebSocket connections and provides broadcast helpers.

    Thread-safety note: FastAPI runs in a single-threaded async event loop, so
    no locking is required for the list mutations below.
    """

    def __init__(self) -> None:
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        """
        Accept the WebSocket handshake and register the connection.

        Args:
            ws: The incoming WebSocket object.
        """
        await ws.accept()
        self.active.append(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        """
        Remove a WebSocket from the active list (idempotent).

        Args:
            ws: The WebSocket to deregister.
        """
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict) -> None:
        """
        Send a JSON-serialisable dict to every currently connected client.

        Clients that fail to receive the message (e.g. they disconnected mid-
        broadcast) are silently removed from the active list.

        Args:
            message: Any JSON-serialisable dict.
        """
        dead: list[WebSocket] = []
        payload = json.dumps(message)
        for ws in list(self.active):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(ws)


# Module-level singleton shared with files.py so REST writes also broadcast.
manager = ConnectionManager()


# ── WebSocket Endpoint ────────────────────────────────────────────────────────

@router.websocket("/ws/sync")
async def websocket_sync(websocket: WebSocket, token: str = "") -> None:
    """
    Real-time bidirectional vault sync endpoint.

    **Authentication:** Pass your Bearer token as the ``token`` query parameter:
    ``wss://your-server/ws/sync?token=<your_token>``

    **Incoming message format:**
    ```json
    {"type": "FILE_MODIFY", "path": "folder/note.md", "content": "# Hello"}
    ```

    **Outgoing broadcast on success:**
    ```json
    {"type": "FILE_CHANGED", "path": "...", "content": "...", "source": "ws", "ts": "..."}
    ```

    Close code ``4001`` is sent when authentication fails.
    """
    # ── Auth ──────────────────────────────────────────────────────────────────
    token_data = await verify_ws_token(token)
    if token_data is None:
        await websocket.close(code=4001)
        return

    # ── Handshake ─────────────────────────────────────────────────────────────
    await manager.connect(websocket)
    client_id = str(uuid4())
    await websocket.send_json({"type": "CONNECTED", "client_id": client_id})
    await add_audit(
        method="WS",
        path=None,
        token_id=token_data["id"],
        action="CONNECT",
    )

    try:
        while True:
            # ── Receive ───────────────────────────────────────────────────────
            raw = await websocket.receive_text()

            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    {
                        "type": "ERROR",
                        "code": "INVALID_JSON",
                        "message": "Message body is not valid JSON.",
                    }
                )
                continue

            msg_type = payload.get("type")

            if msg_type not in ("FILE_MODIFY", "FILE_DELETE", "FILE_RENAME"):
                await websocket.send_json(
                    {
                        "type": "ERROR",
                        "code": "UNKNOWN_TYPE",
                        "message": f"Unknown message type: '{msg_type}'. Expected FILE_MODIFY, FILE_DELETE, or FILE_RENAME.",
                    }
                )
                continue

            # ── Validate payload ──────────────────────────────────────────────
            file_path: str | None = payload.get("path")
            if not file_path:
                await websocket.send_json({"type": "ERROR", "code": "INVALID_PAYLOAD", "message": "'path' is required."})
                continue
            
            # ── Path sanitization ─────────────────────────────────────────────
            vault_path = await get_vault_path()
            try:
                target_file = _sanitize_path(vault_path, file_path)
            except ValueError as exc:
                await websocket.send_json({"type": "ERROR", "code": "PATH_TRAVERSAL", "message": str(exc)})
                continue
            # ── Handle FILE_MODIFY ────────────────────────────────────────────
            if msg_type == "FILE_MODIFY":
                content: str | None = payload.get("content")
                if content is None:
                    await websocket.send_json(
                        {
                            "type": "ERROR",
                            "code": "INVALID_PAYLOAD",
                            "message": "FILE_MODIFY requires 'content'.",
                        }
                    )
                    continue

                target_file.parent.mkdir(parents=True, exist_ok=True)
                target_file.write_text(content, encoding="utf-8")
                ts = _utcnow_iso()
                await manager.broadcast(
                    {
                        "type": "FILE_CHANGED",
                        "path": file_path,
                        "content": content,
                        "source": "ws",
                        "ts": ts,
                    }
                )
                await add_audit(method="WS", path=file_path, token_id=token_data["id"], action="WRITE")

            # ── Handle FILE_DELETE ────────────────────────────────────────────
            elif msg_type == "FILE_DELETE":
                if target_file.exists():
                    if target_file.is_file():
                        target_file.unlink()
                    elif target_file.is_dir():
                        import shutil
                        shutil.rmtree(target_file)
                
                ts = _utcnow_iso()
                await manager.broadcast(
                    {
                        "type": "FILE_DELETED",
                        "path": file_path,
                        "source": "ws",
                        "ts": ts,
                    }
                )
                await add_audit(method="WS", path=file_path, token_id=token_data["id"], action="DELETE")

            # ── Handle FILE_RENAME ────────────────────────────────────────────
            elif msg_type == "FILE_RENAME":
                new_path: str | None = payload.get("new_path")
                if not new_path:
                    await websocket.send_json(
                        {
                            "type": "ERROR",
                            "code": "INVALID_PAYLOAD",
                            "message": "FILE_RENAME requires 'new_path'.",
                        }
                    )
                    continue
                
                try:
                    target_new = _sanitize_path(vault_path, new_path)
                except ValueError as exc:
                    await websocket.send_json({"type": "ERROR", "code": "PATH_TRAVERSAL", "message": str(exc)})
                    continue

                if target_file.exists():
                    target_new.parent.mkdir(parents=True, exist_ok=True)
                    target_file.rename(target_new)

                ts = _utcnow_iso()
                await manager.broadcast(
                    {
                        "type": "FILE_RENAMED",
                        "old_path": file_path,
                        "new_path": new_path,
                        "source": "ws",
                        "ts": ts,
                    }
                )
                await add_audit(method="WS", path=f"{file_path} -> {new_path}", token_id=token_data["id"], action="RENAME")

    except WebSocketDisconnect:
        await manager.disconnect(websocket)
        await add_audit(
            method="WS",
            path=None,
            token_id=token_data["id"],
            action="DISCONNECT",
        )
    except Exception:
        # Catch-all: remove the dead connection and log; do not crash the server.
        await manager.disconnect(websocket)
        await add_audit(
            method="WS",
            path=None,
            token_id=token_data["id"],
            action="DISCONNECT_ERROR",
        )
