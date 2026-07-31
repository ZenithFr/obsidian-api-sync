"""
routers/versions.py -- REST endpoints for accessing file versions and the trash.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pathlib import Path
import shutil
import base64

from auth import get_current_token
from database import get_vault_path, add_audit
from version_control import list_versions, list_trash, move_to_trash, _get_versions_dir, _get_trash_dir

router = APIRouter(prefix="/api/history", tags=["history"])

def _sanitize_path(vault_path: str, relative_path: str) -> Path:
    vault_root = Path(vault_path).resolve()
    target = (vault_root / relative_path).resolve()
    if not str(target).startswith(str(vault_root) + "/") and str(target) != str(vault_root):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path traversal detected: '{relative_path}' escapes the vault root.",
        )
    return target

@router.get(
    "/versions/{path:path}",
    summary="List all historical versions of a file",
)
async def api_list_versions(path: str, token_data: dict = Depends(get_current_token)) -> JSONResponse:
    vault_path = await get_vault_path()
    _sanitize_path(vault_path, path) # Check for path traversal
    versions = list_versions(Path(vault_path), path)
    return JSONResponse(content={"path": path, "versions": versions})

@router.post(
    "/restore-version/{path:path}",
    summary="Restore a specific version of a file",
)
async def api_restore_version(path: str, ts: int, token_data: dict = Depends(get_current_token)) -> JSONResponse:
    vault_path = await get_vault_path()
    versions_dir = _get_versions_dir(Path(vault_path)) / path
    
    target_file = _sanitize_path(vault_path, path)
    
    # Backup current state before restoring
    if target_file.exists():
        move_to_trash(Path(vault_path), path)
        
    version_file = None
    if versions_dir.exists():
        for p in versions_dir.iterdir():
            if p.is_file() and (p.name.startswith(f"{ts}_") or p.name.startswith(f"{ts}-")):
                version_file = p
                break
            
    if not version_file:
        raise HTTPException(status_code=404, detail="Version not found")
        
    target_file.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(version_file, target_file)
    
    await add_audit(method="POST", path=path, token_id=token_data["id"], action=f"RESTORE_VERSION ts={ts}")
    return JSONResponse(content={"status": "restored", "path": path})

@router.get(
    "/trash",
    summary="List all files in the trash",
)
async def api_list_trash(token_data: dict = Depends(get_current_token)) -> JSONResponse:
    vault_path = await get_vault_path()
    trashed = list_trash(Path(vault_path))
    return JSONResponse(content={"trash": trashed})

@router.post(
    "/restore-trash",
    summary="Restore a file from the trash",
)
async def api_restore_trash(trash_path: str, original_path: str, token_data: dict = Depends(get_current_token)) -> JSONResponse:
    vault_path = await get_vault_path()
    vault_root = Path(vault_path).resolve()
    trash_dir = _get_trash_dir(vault_root)

    # trash_path is vault-relative (e.g. ".sync_trash/foo/1234_foo.md")
    trash_file = (vault_root / trash_path).resolve()

    # Security: must stay inside trash_dir
    if not str(trash_file).startswith(str(trash_dir) + "/"):
        raise HTTPException(status_code=400, detail="Invalid trash path: must reside inside the trash directory")

    if not trash_file.exists():
        raise HTTPException(status_code=404, detail="File not found in trash")

    target_file = _sanitize_path(vault_path, original_path)
    target_file.parent.mkdir(parents=True, exist_ok=True)
    
    import os
    try:
        fd = os.open(target_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
    except (FileExistsError, IsADirectoryError, OSError):
        raise HTTPException(status_code=409, detail="A file already exists at the original path. Delete it first.")
        
    target_file.unlink()
    shutil.move(str(trash_file), str(target_file))

    await add_audit(method="POST", path=original_path, token_id=token_data["id"], action="RESTORE_TRASH")
    return JSONResponse(content={"status": "restored", "path": original_path})
