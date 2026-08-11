"""
routers/files.py -- REST endpoints for reading and writing vault markdown files.

All routes require Bearer token authentication via the get_current_token
dependency.  Write operations also broadcast a WebSocket event to all
connected clients through the shared ConnectionManager instance in ws.py.
"""

import asyncio
import base64
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from auth import get_current_token
from config import settings
from database import add_audit, get_vault_path
from limiter import limiter
from locks import file_locks
from routers.ws import manager
from version_control import _get_versions_dir, move_to_trash, save_version

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


from hashing import fnv1a as _fnv1a


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
@limiter.limit(settings.API_RATE_LIMIT)
async def list_files(
    request: Request,
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

    filtered_files = []
    for file in unique_files:
        parts = file.relative_to(vault_root).parts
        if any(p.startswith(".") and p != ".obsidian" for p in parts):
            continue
        filtered_files.append(file)

    if include_content:
        total_size = 0
        for f in filtered_files:
            try:
                total_size += f.stat().st_size
            except FileNotFoundError:
                pass
        if total_size > 50 * 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Vault too large for bulk fetch. Max 50MB allowed.",
            )

    for file in filtered_files:
        relative = str(file.relative_to(vault_root)).replace("\\", "/")
        
        # Don't sync our own token or version/trash folders
        if relative == ".obsidian/plugins/obsidian-api-sync/data.json":
            continue
        if relative.startswith(".sync_versions/") or relative.startswith(".sync_trash/") or relative.startswith(".sync_tmp/"):
            continue

        if include_content:
            try:
                size = file.stat().st_size
                # Guard against reading enormous files into memory
                if size > MAX_FILE_SIZE_BYTES:
                    md_files.append({"path": relative, "content": None, "is_binary": True, "size_bytes": size, "hash": ""})
                    continue
                try:
                    content = await asyncio.to_thread(file.read_text, encoding="utf-8")
                    h = _fnv1a(content)
                    md_files.append({"path": relative, "content": content, "is_binary": False, "size_bytes": size, "hash": h})
                except UnicodeDecodeError:
                    # Binary file
                    raw_bytes = await asyncio.to_thread(file.read_bytes)
                    b64_content = base64.b64encode(raw_bytes).decode("ascii")
                    # Only send content if small, otherwise force client to download separately
                    if size > settings.MAX_INLINE_BINARY_BYTES:
                        md_files.append({"path": relative, "content": None, "is_binary": True, "size_bytes": size, "hash": ""})
                    else:
                        md_files.append({"path": relative, "content": b64_content, "is_binary": True, "size_bytes": size, "hash": ""})
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
    description="""Returns the raw file content.

The `path` parameter is the vault-relative path using forward slashes
(e.g. `journal/2026-06-03.md`).

Returns HTTP 404 if the file does not exist.
""",
)
@limiter.limit(settings.API_RATE_LIMIT)
async def read_file(
    request: Request,
    path: str,
    token_data: dict = Depends(get_current_token),
) -> FileResponse:
    # The generic /{path:path} route is registered before /download/{path:path},
    # so FastAPI hands download/... requests to this handler. Route them on.
    if path.startswith("download/"):
        return await download_file(path[len("download/"):], token_data)

    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, path)

    if not target.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")

    if not target.is_file():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Path is not a file: {path}")

    try:
        size_bytes = target.stat().st_size
        try:
            content = await asyncio.to_thread(target.read_text, encoding="utf-8")
            is_binary = False
        except UnicodeDecodeError:
            raw_bytes = await asyncio.to_thread(target.read_bytes)
            content = base64.b64encode(raw_bytes).decode("ascii")
            is_binary = True
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")

    await add_audit(method="GET", path=path, token_id=token_data["id"], action="READ")

    return JSONResponse(content={"path": path, "content": content, "size_bytes": size_bytes, "is_binary": is_binary})


# -- GET /api/files/download/{path} -------------------------------------------

from fastapi.responses import FileResponse


@router.get(
    "/download/{path:path}",
    summary="Download raw file content",
    description="Returns the raw file as a streaming binary response, supporting Range headers.",
)
async def download_file(
    path: str,
    token_data: dict = Depends(get_current_token),
) -> FileResponse:
    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, path)

    if not target.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")

    if not target.is_file():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Path is not a file: {path}")

    await add_audit(method="GET", path=path, token_id=token_data["id"], action="READ_DOWNLOAD")

    return FileResponse(target)


# -- POST /api/files/chunk ----------------------------------------------------

class ChunkPayload(BaseModel):
    upload_id: str
    chunk_index: int
    total_chunks: int
    data: str  # Base64

@router.delete(
    "/chunk/{upload_id}",
    summary="Cancel a chunked upload",
    description="Deletes temporary chunks for an aborted upload.",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def cancel_chunked_upload(
    upload_id: str,
    token_data: dict = Depends(get_current_token),
) -> Response:
    vault_path = await get_vault_path()
    if not upload_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid upload ID")
    tmp_dir = Path(vault_path) / ".sync_tmp" / upload_id
    if tmp_dir.exists():
        import shutil
        await asyncio.to_thread(shutil.rmtree, tmp_dir, ignore_errors=True)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

@router.post(
    "/chunk",
    summary="Upload a file chunk",
    description="Upload a base64 encoded chunk for a large file.",
    status_code=status.HTTP_200_OK,
)
async def upload_chunk(
    payload: ChunkPayload,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    if not payload.upload_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid upload ID")
    vault_path = await get_vault_path()
    tmp_dir = Path(vault_path) / ".sync_tmp" / payload.upload_id
    tmp_dir.mkdir(parents=True, exist_ok=True)
    
    chunk_file = tmp_dir / str(payload.chunk_index)
    raw_bytes = base64.b64decode(payload.data)
    
    await asyncio.to_thread(chunk_file.write_bytes, raw_bytes)
    return JSONResponse(content={"status": "ok", "chunk": payload.chunk_index})


# -- POST /api/files/commit ---------------------------------------------------

class CommitPayload(BaseModel):
    upload_id: str
    path: str
    is_binary: bool
    total_chunks: int

@router.post(
    "/commit",
    summary="Commit a chunked upload",
    description="Assembles chunks and saves the final file.",
    status_code=status.HTTP_200_OK,
)
async def commit_chunked_upload(
    payload: CommitPayload,
    token_data: dict = Depends(get_current_token),
    x_base_hash: str | None = Header(None, alias="X-Base-Hash"),
) -> JSONResponse:
    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, payload.path)
    if not payload.upload_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid upload ID")
    tmp_dir = Path(vault_path) / ".sync_tmp" / payload.upload_id

    if not tmp_dir.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload ID not found")

    chunks = sorted([f for f in tmp_dir.iterdir() if f.is_file()], key=lambda x: int(x.name))
    
    if len(chunks) != payload.total_chunks:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Expected {payload.total_chunks} chunks, found {len(chunks)}")
        
    for i, chunk in enumerate(chunks):
        if int(chunk.name) != i:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Missing chunk {i}")
    
    lock = await file_locks.acquire(str(target))
    async with lock:
        if target.exists() and x_base_hash and not payload.is_binary:
            try:
                current_text = await asyncio.to_thread(target.read_text, encoding="utf-8", errors="replace")
                current_hash = _fnv1a(current_text)
                if current_hash != x_base_hash:
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    return JSONResponse(
                        status_code=409,
                        content={
                            "type": "CONFLICT",
                            "path": payload.path,
                            "server_content": current_text,
                            "client_content": "", # Too large to send back in conflict
                        }
                    )
            except OSError:
                pass
        
        if target.exists():
            await asyncio.to_thread(save_version, Path(vault_path), payload.path)
        
        target.parent.mkdir(parents=True, exist_ok=True)
        
        def _assemble():
            tmp_final = target.with_name(f"{target.name}.{uuid4().hex}.tmp")
            with open(tmp_final, "wb") as outfile:
                for chunk in chunks:
                    with open(chunk, "rb") as infile:
                        import shutil
                        shutil.copyfileobj(infile, outfile)
            os.replace(tmp_final, target)
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)
            
        await asyncio.to_thread(_assemble)
        size_bytes = target.stat().st_size

    ts = _utcnow_iso()
    await manager.broadcast(
        {"type": "FILE_CHANGED", "path": payload.path, "content": None, "is_binary": payload.is_binary, "source": "rest", "ts": ts}
    )

    await add_audit(method="POST", path=payload.path, token_id=token_data["id"], action="WRITE_CHUNKED")

    return JSONResponse(content={"path": payload.path, "status": "written", "size_bytes": size_bytes})

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
@limiter.limit(settings.API_RATE_LIMIT)
async def write_file(
    path: str,
    request: Request,
    token_data: dict = Depends(get_current_token),
    x_base_hash: str | None = Header(None, alias="X-Base-Hash"),
    x_is_binary: str | None = Header(None, alias="X-Is-Binary"),
    x_force_overwrite: str | None = Header(None, alias="X-Force-Overwrite"),
) -> JSONResponse:
    # The generic /{path:path} route is registered before /rename, so FastAPI
    # hands rename/... requests to this handler. Route them on.
    if path.startswith("rename"):
        import json as _json
        try:
            payload = RenamePayload.model_validate(_json.loads(await request.body()))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid rename payload: {exc}")
        return await rename_file(request, payload, token_data)

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
    content = None
    if x_is_binary and x_is_binary.lower() == "true":
        is_binary = True
    else:
        try:
            content = body_bytes.decode("utf-8")
        except UnicodeDecodeError:
            is_binary = True

    lock = await file_locks.acquire(str(target))
    async with lock:
        # Conflict detection and automatic resolution based on config
        if target.exists() and x_base_hash and not is_binary:
            try:
                current_text = await asyncio.to_thread(target.read_text, encoding="utf-8", errors="replace")
                current_hash = _fnv1a(current_text)
                if current_hash != x_base_hash:
                    resolution = settings.CONFLICT_RESOLUTION.lower()
                    if resolution == "client":
                        # Client wins – overwrite without conflict
                        pass
                    elif resolution == "server":
                        # Server wins – reject client change, return server content
                        return JSONResponse(
                            status_code=409,
                            content={
                                "type": "CONFLICT",
                                "path": path,
                                "server_content": current_text,
                                "client_content": content,
                            }
                        )
                    else:
                        # Fallback to explicit force overwrite header if provided
                        if x_force_overwrite and x_force_overwrite.lower() == "true":
                            pass
                        else:
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
        # Conflict detection for write to a file that is in trash
        trash_path = Path(vault_path) / ".sync_trash" / path
        if trash_path.exists():
            resolution = settings.CONFLICT_RESOLUTION.lower()
            if resolution == "server":
                return JSONResponse(
                    status_code=409,
                    content={
                        "type": "CONFLICT",
                        "path": path,
                        "detail": "File has been deleted on server.",
                    }
                )
            # client/manual: only allow resurrection when force header is set
            if not (x_force_overwrite and x_force_overwrite.lower() == "true"):
                return JSONResponse(
                    status_code=409,
                    content={
                        "type": "CONFLICT",
                        "path": path,
                        "detail": "File is in trash. Use X-Force-Overwrite: true to restore.",
                    }
                )
        # Save version before modifying existing file
        if target.exists():
            await asyncio.to_thread(save_version, Path(vault_path), path)
    
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            def _atomic_write():
                tmp = target.with_name(f"{target.name}.{uuid4().hex}.tmp")
                tmp.write_bytes(body_bytes)
                os.replace(tmp, target)
            await asyncio.to_thread(_atomic_write)
        except IsADirectoryError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Target path is a directory.")
        size_bytes = target.stat().st_size

    ts = _utcnow_iso()
    # For binary files, we do not broadcast the content. The client will fetch it.
    await manager.broadcast(
        {"type": "FILE_CHANGED", "path": path, "content": None if is_binary else content, "is_binary": is_binary, "source": "rest", "ts": ts}
    )

    await add_audit(method="POST", path=path, token_id=token_data["id"], action="WRITE")

    return JSONResponse(content={"path": path, "status": "written", "size_bytes": size_bytes, "is_binary": is_binary})


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
@limiter.limit(settings.API_RATE_LIMIT)
async def rename_file(
    request: Request,
    payload: RenamePayload,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    vault_path = await get_vault_path()
    target_old = _sanitize_path(vault_path, payload.old_path)
    target_new = _sanitize_path(vault_path, payload.new_path)

    lock_old = await file_locks.acquire(str(target_old))
    lock_new = await file_locks.acquire(str(target_new))
    locks = [lock_old, lock_new] if str(target_old) < str(target_new) else [lock_new, lock_old]
    async with locks[0]:
        async with locks[1]:
            if not target_old.exists():
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {payload.old_path}")
        
            if target_old.exists():
                await asyncio.to_thread(save_version, Path(vault_path), payload.old_path)
        
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
@limiter.limit(settings.API_RATE_LIMIT)
async def delete_file(
    request: Request,
    path: str,
    token_data: dict = Depends(get_current_token),
) -> Response:
    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, path)

    lock = await file_locks.acquire(str(target))
    async with lock:
        if not target.exists():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")
    
        if not target.is_file():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Path is not a file: {path}")
    
        await asyncio.to_thread(move_to_trash, Path(vault_path), path)

    ts = _utcnow_iso()
    await manager.broadcast({"type": "FILE_DELETED", "path": path, "source": "rest", "ts": ts})

    await add_audit(method="DELETE", path=path, token_id=token_data["id"], action="DELETE")

    return Response(status_code=status.HTTP_204_NO_CONTENT)
