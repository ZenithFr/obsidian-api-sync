"""
routers/files.py -- REST endpoints for reading and writing vault files.

All file I/O is routed through the active StorageBackend so the same
endpoints work transparently whether the vault is on local disk or Google Drive.
"""

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from auth import get_current_token
from config import settings
from database import add_audit
from routers.ws import manager
from storage import get_backend

router = APIRouter(prefix="/api/files", tags=["files"])

MAX_FILE_SIZE_BYTES = settings.MAX_FILE_SIZE_BYTES


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_path(path: str) -> None:
    """Reject paths with traversal sequences."""
    if ".." in Path(path).parts:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path traversal detected: '{path}'",
        )


# -- GET /api/files -----------------------------------------------------------

@router.get(
    "",
    summary="List all markdown notes in the vault",
    description="Returns all .md file paths relative to the vault root. Pass `include_content=true` to bulk-fetch content.",
)
async def list_files(
    include_content: bool = False,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    backend = await get_backend()
    if include_content:
        files = await backend.list_files_with_content()
    else:
        files = await backend.list_files()

    await add_audit(
        method="GET", path=None, token_id=token_data["id"],
        action="READ_LIST_BULK" if include_content else "READ_LIST",
    )
    return JSONResponse(content={"files": files, "count": len(files)})


# -- GET /api/files/{path} ----------------------------------------------------

@router.get("/{path:path}", summary="Read the raw content of a markdown note")
async def read_file(
    path: str,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    _validate_path(path)
    backend = await get_backend()

    if not await backend.exists(path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")

    content = await backend.read_file(path)
    size_bytes = await backend.file_size(path)

    await add_audit(method="GET", path=path, token_id=token_data["id"], action="READ")
    return JSONResponse(content={"path": path, "content": content, "size_bytes": size_bytes})


# -- POST /api/files/{path} ---------------------------------------------------

@router.post("/{path:path}", summary="Create or overwrite a markdown note", status_code=status.HTTP_200_OK)
async def write_file(
    path: str,
    request: Request,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    _validate_path(path)
    body_bytes = await request.body()

    if len(body_bytes) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large. Maximum is {MAX_FILE_SIZE_BYTES // (1024*1024)} MB.",
        )

    try:
        content = body_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid UTF-8: {exc}") from exc

    backend = await get_backend()
    size_bytes = await backend.write_file(path, content)

    ts = _utcnow_iso()
    await manager.broadcast(
        {"type": "FILE_CHANGED", "path": path, "content": content, "source": "rest", "ts": ts}
    )
    await add_audit(method="POST", path=path, token_id=token_data["id"], action="WRITE")
    return JSONResponse(content={"path": path, "status": "written", "size_bytes": size_bytes})


# -- POST /api/files/rename ---------------------------------------------------

class RenamePayload(BaseModel):
    old_path: str
    new_path: str


@router.post("/rename", summary="Rename or move a markdown note", status_code=status.HTTP_200_OK)
async def rename_file(
    payload: RenamePayload,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    _validate_path(payload.old_path)
    _validate_path(payload.new_path)
    backend = await get_backend()

    if not await backend.exists(payload.old_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {payload.old_path}")

    content = await backend.read_file(payload.old_path)
    await backend.write_file(payload.new_path, content)
    await backend.delete(payload.old_path)

    ts = _utcnow_iso()
    await manager.broadcast(
        {"type": "FILE_RENAMED", "old_path": payload.old_path, "new_path": payload.new_path, "source": "rest", "ts": ts}
    )
    await add_audit(
        method="POST", path=f"{payload.old_path} -> {payload.new_path}",
        token_id=token_data["id"], action="RENAME",
    )
    return JSONResponse(content={"old_path": payload.old_path, "new_path": payload.new_path, "status": "renamed"})


# -- DELETE /api/files/{path} -------------------------------------------------

@router.delete("/{path:path}", summary="Delete a markdown note from the vault", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    path: str,
    token_data: dict = Depends(get_current_token),
) -> Response:
    _validate_path(path)
    backend = await get_backend()

    if not await backend.exists(path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")

    await backend.delete(path)

    ts = _utcnow_iso()
    await manager.broadcast({"type": "FILE_DELETED", "path": path, "source": "rest", "ts": ts})
    await add_audit(method="DELETE", path=path, token_id=token_data["id"], action="DELETE")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
