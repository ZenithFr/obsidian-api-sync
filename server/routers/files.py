"""
routers/files.py -- REST endpoints for reading and writing vault markdown files.

All routes require Bearer token authentication via the get_current_token
dependency.  Write operations also broadcast a WebSocket event to all
connected clients through the shared ConnectionManager instance in ws.py.
"""

from datetime import datetime, timezone
from pathlib import Path
import base64
import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, status, Header
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from auth import get_current_token
from config import settings
from database import add_audit, get_vault_path
from routers.ws import manager
from version_control import save_version, move_to_trash, _get_versions_dir

router = APIRouter(prefix="/api/files", tags=["files"])

MAX_FILE_SIZE_BYTES = settings.MAX_FILE_SIZE_BYTES


# -- Utilities ----------------------------------------------------------------

def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize_path(vault_path: str, relative_path: str) -> Path:
    """
    Resolve relative_path against the vault root and verify it does not escape.

    Raises:
        HTTPException 400: If path traversal is detected.
    """
    vault_root = Path(vault_path).resolve()
    target = (vault_root / relative_path).resolve()

    if not str(target).startswith(str(vault_root) + "/") and str(target) != str(vault_root):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path traversal detected: '{relative_path}' escapes the vault root.",
        )

    try:
        rel_parts = target.relative_to(vault_root).parts
        if rel_parts and rel_parts[0] in (".sync_versions", ".sync_trash"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access to internal sync folders is forbidden.",
            )
    except ValueError:
        pass

    return target


def _fnv1a(content: str) -> str:
    """FNV-1a 32-bit hash — matches the TypeScript client exactly.
    Used for conflict detection only; not a security primitive."""
    h = 0x811c9dc5
    for ch in content.encode("utf-8", errors="replace"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, '08x')


# -- GET /api/files -----------------------------------------------------------


@router.get(
    "",
    summary="List all markdown notes in the vault",
    description="""Returns a JSON array of all .md file paths relative to the configured vault root.

If `include_content=true`, the `files` array will contain objects with `path` and `content`.
Use this endpoint to discover which notes exist before reading or modifying them, or to bulk pull.
Paths use forward-slash separators regardless of the host operating system.
""",
)
async def list_files(
    include_content: bool = False,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    """List all markdown files in the vault directory, optionally including their content."""
    vault_path = await get_vault_path()
    vault_root = Path(vault_path).resolve()

    if not vault_root.exists():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Vault directory does not exist: {vault_path}",
        )

    md_files = []

    raw_files = await asyncio.to_thread(lambda: list(vault_root.rglob("*")))
        
    unique_files = list({f.resolve(): f for f in raw_files if f.is_file()}.values())

    if include_content:
        total_size = sum(f.stat().st_size for f in unique_files)
        if total_size > 50 * 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Vault too large for bulk fetch. Max 50MB allowed.",
            )

    for file in unique_files:
        relative = str(file.relative_to(vault_root)).replace("\\", "/")
        
        # Don't sync our own token or version/trash folders
        if relative == ".obsidian/plugins/obsidian-api-sync/data.json":
            continue
        if relative.startswith(".sync_versions/") or relative.startswith(".sync_trash/"):
            continue

        if include_content:
            try:
                # Guard against reading enormous files into memory
                if file.stat().st_size > MAX_FILE_SIZE_BYTES:
                    continue
                try:
                    content = await asyncio.to_thread(file.read_text, encoding="utf-8")
                    md_files.append({"path": relative, "content": content, "is_binary": False})
                except UnicodeDecodeError:
                    # Binary file
                    raw_bytes = await asyncio.to_thread(file.read_bytes)
                    b64_content = base64.b64encode(raw_bytes).decode("ascii")
                    md_files.append({"path": relative, "content": b64_content, "is_binary": True})
            except Exception:
                pass
        else:
            md_files.append(relative)

    if not include_content:
        md_files.sort()
    else:
        md_files.sort(key=lambda x: x["path"])

    await add_audit(
        method="GET",
        path=None,
        token_id=token_data["id"],
        action="READ_LIST_BULK" if include_content else "READ_LIST",
    )

    return JSONResponse(
        content={
            "files": md_files,
            "vault_path": str(vault_root),
            "count": len(md_files),
        }
    )


# -- GET /api/files/{path} ----------------------------------------------------


@router.get(
    "/{path:path}",
    summary="Read the raw content of a markdown note",
    description="""Returns the complete UTF-8 text content of a single markdown file.

The `path` parameter is the vault-relative path using forward slashes
(e.g. `journal/2026-06-03.md`).

Returns HTTP 404 if the file does not exist.
""",
)
async def read_file(
    path: str,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, path)

    if not target.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")

    if not target.is_file():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Path is not a file: {path}")

    size_bytes = target.stat().st_size
    try:
        content = await asyncio.to_thread(target.read_text, encoding="utf-8")
        is_binary = False
    except UnicodeDecodeError:
        raw_bytes = await asyncio.to_thread(target.read_bytes)
        content = base64.b64encode(raw_bytes).decode("ascii")
        is_binary = True

    await add_audit(method="GET", path=path, token_id=token_data["id"], action="READ")

    return JSONResponse(content={"path": path, "content": content, "size_bytes": size_bytes, "is_binary": is_binary})


# -- POST /api/files/{path} ---------------------------------------------------


@router.post(
    "/{path:path}",
    summary="Create or overwrite a markdown note",
    description="""Creates a new file or completely replaces the content of an existing markdown file.

Request body must be plain text (`Content-Type: text/plain`) containing the full markdown content.
Parent directories are created automatically if they do not exist.
Maximum file size: 10 MB.

All connected Obsidian clients instantly receive a `FILE_CHANGED` WebSocket broadcast.
""",
    status_code=status.HTTP_200_OK,
)
async def write_file(
    path: str,
    request: Request,
    token_data: dict = Depends(get_current_token),
    x_base_hash: str | None = Header(None, alias="X-Base-Hash"),
) -> JSONResponse:
    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, path)

    body_bytes = await request.body()

    # Guard #7: cap request body size
    if len(body_bytes) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large. Maximum allowed size is {MAX_FILE_SIZE_BYTES // (1024*1024)} MB.",
        )

    is_binary = False
    try:
        content = body_bytes.decode("utf-8")
    except UnicodeDecodeError:
        is_binary = True
        content = base64.b64encode(body_bytes).decode("ascii")

    # Conflict detection
    if target.exists() and x_base_hash and not is_binary:
        try:
            current_text = await asyncio.to_thread(target.read_text, encoding="utf-8", errors="replace")
            current_hash = _fnv1a(current_text)
            if current_hash != x_base_hash:
                return JSONResponse(
                    status_code=409,
                    content={
                        "type": "CONFLICT",
                        "path": path,
                        "server_content": current_text,
                        "client_content": content,
                    }
                )
        except OSError:
            pass  # Proceed if read fails

    # Save version before modifying existing file
    if target.exists():
        await asyncio.to_thread(save_version, Path(vault_path), path)

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        await asyncio.to_thread(target.write_bytes, body_bytes)
    except IsADirectoryError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Target path is a directory.")
    size_bytes = target.stat().st_size

    ts = _utcnow_iso()
    await manager.broadcast(
        {"type": "FILE_CHANGED", "path": path, "content": content, "is_binary": is_binary, "source": "rest", "ts": ts}
    )

    await add_audit(method="POST", path=path, token_id=token_data["id"], action="WRITE")

    return JSONResponse(content={"path": path, "status": "written", "size_bytes": size_bytes})


# -- POST /api/files/rename ---------------------------------------------------


class RenamePayload(BaseModel):
    old_path: str
    new_path: str


@router.post(
    "/rename",
    summary="Rename or move a markdown note",
    description="Renames or moves a file to a new path. Broadcasts FILE_RENAMED to all WebSocket clients.",
    status_code=status.HTTP_200_OK,
)
async def rename_file(
    payload: RenamePayload,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    vault_path = await get_vault_path()
    target_old = _sanitize_path(vault_path, payload.old_path)
    target_new = _sanitize_path(vault_path, payload.new_path)

    if not target_old.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {payload.old_path}")

    if target_old.exists():
        save_version(Path(vault_path), payload.old_path)

    target_new.parent.mkdir(parents=True, exist_ok=True)
    try:
        await asyncio.to_thread(target_old.rename, target_new)
    except IsADirectoryError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Target path is a directory.")
    
    old_versions_dir = _get_versions_dir(Path(vault_path)) / payload.old_path
    if old_versions_dir.exists():
        new_versions_dir = _get_versions_dir(Path(vault_path)) / payload.new_path
        new_versions_dir.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(old_versions_dir.rename, new_versions_dir)

    ts = _utcnow_iso()
    await manager.broadcast(
        {"type": "FILE_RENAMED", "old_path": payload.old_path, "new_path": payload.new_path, "source": "rest", "ts": ts}
    )

    await add_audit(
        method="POST",
        path=f"{payload.old_path} -> {payload.new_path}",
        token_id=token_data["id"],
        action="RENAME",
    )

    return JSONResponse(content={"old_path": payload.old_path, "new_path": payload.new_path, "status": "renamed"})


# -- DELETE /api/files/{path} -------------------------------------------------


@router.delete(
    "/{path:path}",
    summary="Delete a markdown note from the vault",
    description="Permanently deletes the specified markdown file. Returns HTTP 404 if the file does not exist.",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_file(
    path: str,
    token_data: dict = Depends(get_current_token),
) -> Response:
    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, path)

    if not target.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")

    if not target.is_file():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Path is not a file: {path}")

    await asyncio.to_thread(move_to_trash, Path(vault_path), path)

    ts = _utcnow_iso()
    await manager.broadcast({"type": "FILE_DELETED", "path": path, "source": "rest", "ts": ts})

    await add_audit(method="DELETE", path=path, token_id=token_data["id"], action="DELETE")

    return Response(status_code=status.HTTP_204_NO_CONTENT)
