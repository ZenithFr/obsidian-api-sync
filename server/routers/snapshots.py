"""
routers/snapshots.py -- Point-in-Time Vault Recovery endpoints.
"""

import asyncio
import os
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse

from auth import get_current_token
from database import add_audit, get_vault_path
from locks import file_locks
from routers.ws import manager

router = APIRouter(prefix="/api/snapshots", tags=["snapshots"])

def _get_snapshots_dir(vault_path: Path) -> Path:
    snapshots_dir = vault_path / ".sync_snapshots"
    snapshots_dir.mkdir(parents=True, exist_ok=True)
    return snapshots_dir

def _create_snapshot(vault_path: Path, is_pre_restore: bool = False) -> str:
    snapshots_dir = _get_snapshots_dir(vault_path)
    
    # Prune old snapshots (keep 7)
    existing_snaps = []
    for p in snapshots_dir.glob("*.zip"):
        if p.is_file():
            existing_snaps.append(p)
    existing_snaps.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    
    # We want to keep 7 regular snapshots (ignoring pre-restores if we wanted to be strict, but let's just keep 7 total for safety/disk space)
    while len(existing_snaps) >= 7:
        oldest = existing_snaps.pop()
        try:
            oldest.unlink()
        except OSError:
            pass

    ts = int(time.time())
    prefix = "pre_restore" if is_pre_restore else "snapshot"
    snap_filename = f"{prefix}_{ts}.zip"
    snap_path = snapshots_dir / snap_filename
    
    # Create ZIP
    with zipfile.ZipFile(snap_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(vault_path):
            # Ignore sync folders and git
            dirs[:] = [d for d in dirs if d.startswith('.sync_') or d == '.git' or d == '.obsidian']
            # Wait, if I do dirs[:] = [...], I'm KEEPING the ignored ones, which is wrong.
            # I should keep only the ones that are NOT ignored.
            dirs[:] = [d for d in dirs if not d.startswith('.sync_') and d != '.git']
            
            for file in files:
                file_path = Path(root) / file
                rel_path = file_path.relative_to(vault_path)
                
                # Ignore plugin data
                if rel_path.as_posix() == ".obsidian/plugins/obsidian-api-sync/data.json":
                    continue
                
                zf.write(file_path, arcname=rel_path)
                
    return snap_filename

@router.get("", summary="List available vault snapshots")
async def list_snapshots(token_data: dict = Depends(get_current_token)) -> JSONResponse:
    vault_path = Path(await get_vault_path())
    snapshots_dir = _get_snapshots_dir(vault_path)
    
    snaps = []
    for p in snapshots_dir.glob("*.zip"):
        if p.is_file():
            st = p.stat()
            dt = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
            snaps.append({
                "id": p.name,
                "date": dt.isoformat(),
                "size_bytes": st.st_size,
                "is_pre_restore": p.name.startswith("pre_restore")
            })
            
    snaps.sort(key=lambda x: x["date"], reverse=True)
    await add_audit(method="GET", path=None, token_id=token_data["id"], action="LIST_SNAPSHOTS")
    return JSONResponse(content={"snapshots": snaps})

@router.post("/create", summary="Create a manual vault snapshot")
async def create_snapshot(token_data: dict = Depends(get_current_token)) -> JSONResponse:
    vault_path = Path(await get_vault_path())
    
    # We acquire a lock on the vault root to prevent concurrent sync operations during zip
    # Since we can't lock the whole vault easily, we just do it synchronously and it will take a second.
    # Actually, file_locks is string-based, we can use a special string.
    lock = await file_locks.acquire("__GLOBAL_VAULT_LOCK__")
    async with lock:
        snap_filename = await asyncio.to_thread(_create_snapshot, vault_path, False)
        
    await add_audit(method="POST", path=snap_filename, token_id=token_data["id"], action="CREATE_SNAPSHOT")
    return JSONResponse(content={"status": "ok", "snapshot_id": snap_filename})

@router.post("/restore/{snapshot_id}", summary="Restore vault from a snapshot")
async def restore_snapshot(snapshot_id: str, token_data: dict = Depends(get_current_token)) -> JSONResponse:
    vault_path = Path(await get_vault_path())
    snapshots_dir = _get_snapshots_dir(vault_path)
    snap_path = snapshots_dir / snapshot_id
    
    if not snap_path.exists() or not snap_path.is_file() or not snapshot_id.endswith(".zip"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Snapshot not found")
        
    lock = await file_locks.acquire("__GLOBAL_VAULT_LOCK__")
    async with lock:
        # 1. Take a pre-restore backup
        await asyncio.to_thread(_create_snapshot, vault_path, True)
        
        # 2. Wipe vault (excluding .sync_ folders and our own plugin data)
        def _wipe_and_restore():
            dirs_to_check = []
            for root, dirs, files in os.walk(vault_path, topdown=True):
                # Filter dirs to not descend into ignored ones during wipe
                dirs[:] = [d for d in dirs if not (d.startswith('.sync_') or d == '.git')]
                        
                for file in files:
                    file_path = Path(root) / file
                    if file_path.relative_to(vault_path).as_posix() == ".obsidian/plugins/obsidian-api-sync/data.json":
                        continue
                    try:
                        file_path.unlink()
                    except OSError:
                        pass
                
                dirs_to_check.append(Path(root))
                        
            # Also remove empty directories bottom-up
            for dir_path in reversed(dirs_to_check):
                if dir_path == vault_path:
                    continue
                try:
                    if not any(dir_path.iterdir()):
                        dir_path.rmdir()
                except OSError:
                    pass
                        
            # 3. Unzip snapshot
            with zipfile.ZipFile(snap_path, 'r') as zf:
                zf.extractall(vault_path)
                
        await asyncio.to_thread(_wipe_and_restore)
        
    # 4. Broadcast restore event
    ts = datetime.now(timezone.utc).isoformat()
    await manager.broadcast({
        "type": "VAULT_RESTORED",
        "snapshot_id": snapshot_id,
        "ts": ts
    })
    
    await add_audit(method="POST", path=snapshot_id, token_id=token_data["id"], action="RESTORE_SNAPSHOT")
    return JSONResponse(content={"status": "ok", "message": "Vault restored"})
