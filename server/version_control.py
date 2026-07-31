import os
import shutil
import time
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Max versions per file
MAX_VERSIONS = 20
# Max age of a version in days
MAX_VERSION_AGE_DAYS = 30

def _get_versions_dir(vault_path: Path) -> Path:
    versions_dir = vault_path / ".sync_versions"
    versions_dir.mkdir(parents=True, exist_ok=True)
    return versions_dir

def _get_trash_dir(vault_path: Path) -> Path:
    trash_dir = vault_path / ".sync_trash"
    trash_dir.mkdir(parents=True, exist_ok=True)
    return trash_dir

def save_version(vault_path: Path, relative_file_path: str) -> None:
    """Save a copy of the current file state before it gets modified."""
    file_path = vault_path / relative_file_path
    if not file_path.exists() or not file_path.is_file():
        return

    versions_dir = _get_versions_dir(vault_path)
    # Use unix timestamp for easy sorting and age calculation
    ts = int(time.time() * 1000)
    uid = uuid.uuid4().hex[:6]
    
    # We store the version under .sync_versions/{relative_path}/{ts}-{uid}_{filename}
    file_version_dir = versions_dir / relative_file_path
    file_version_dir.mkdir(parents=True, exist_ok=True)
    
    version_path = file_version_dir / f"{ts}-{uid}_{file_path.name}"
    
    # Copy the file
    shutil.copy2(file_path, version_path)
    
    # Cleanup old versions
    cleanup_versions(file_version_dir)

def cleanup_versions(file_version_dir: Path) -> None:
    """Keep only the last MAX_VERSIONS versions, and remove versions older than MAX_VERSION_AGE_DAYS."""
    if not file_version_dir.exists():
        return
        
    versions = []
    for p in file_version_dir.iterdir():
        if p.is_file():
            try:
                # Filename format: {ts}-{uid}_{name} or {ts}_{name}
                ts_str = p.name.split('_', 1)[0]
                ts = int(ts_str.split('-')[0])
                versions.append((ts, p))
            except (ValueError, OverflowError, OSError):
                pass
                
    # Sort by timestamp descending (newest first)
    versions.sort(key=lambda x: x[0], reverse=True)
    
    cutoff_ts = int((datetime.now(timezone.utc) - timedelta(days=MAX_VERSION_AGE_DAYS)).timestamp() * 1000)
    
    # Keep up to MAX_VERSIONS, and filter out those older than cutoff
    kept_count = 0
    for ts, p in versions:
        if kept_count < MAX_VERSIONS and ts >= cutoff_ts:
            kept_count += 1
        else:
            try:
                p.unlink()
            except Exception:
                pass
                
    # If directory is empty, we can remove it
    try:
        if not any(file_version_dir.iterdir()):
            os.removedirs(str(file_version_dir))
    except Exception:
        pass

def move_to_trash(vault_path: Path, relative_file_path: str) -> None:
    """Move a file to the trash instead of deleting it permanently."""
    file_path = vault_path / relative_file_path
    if not file_path.exists():
        return
        
    trash_dir = _get_trash_dir(vault_path)
    ts = int(time.time() * 1000)
    uid = uuid.uuid4().hex[:6]
    
    # Trash path: .sync_trash/{relative_path}/{ts}-{uid}_{filename}
    # For folders, just move the folder.
    
    trash_target_dir = trash_dir / relative_file_path
    trash_target_dir.mkdir(parents=True, exist_ok=True)
    
    trash_path = trash_target_dir / f"{ts}-{uid}_{file_path.name}"
    
    if file_path.is_file():
        shutil.move(str(file_path), str(trash_path))
    elif file_path.is_dir():
        shutil.move(str(file_path), str(trash_path))
        
    cleanup_trash(trash_dir)

def cleanup_trash(trash_dir: Path) -> None:
    """Keep trash items for MAX_VERSION_AGE_DAYS."""
    if not trash_dir.exists():
        return
    
    cutoff_ts = int((datetime.now(timezone.utc) - timedelta(days=MAX_VERSION_AGE_DAYS)).timestamp() * 1000)
    
    to_delete = []
    for p in trash_dir.rglob('*'):
        try:
            ts_str, orig_name = p.name.split('_', 1)
            if orig_name == p.parent.name:
                ts = int(ts_str.split('-')[0])
                if ts < cutoff_ts:
                    to_delete.append(p)
        except (ValueError, OverflowError, OSError, IndexError):
            pass
            
    for p in to_delete:
        try:
            if p.is_file():
                p.unlink()
            elif p.is_dir():
                shutil.rmtree(p)
            
            # Remove parent folder if empty
            if p.parent.exists() and not any(p.parent.iterdir()):
                shutil.rmtree(p.parent)
        except Exception:
            pass

def list_versions(vault_path: Path, relative_file_path: str) -> list[dict]:
    """List all available versions for a given file."""
    file_version_dir = _get_versions_dir(vault_path) / relative_file_path
    if not file_version_dir.exists():
        return []
        
    versions = []
    for p in file_version_dir.iterdir():
        if p.is_file():
            try:
                ts_str = p.name.split('_', 1)[0]
                ts = int(ts_str.split('-')[0])
                dt = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc)
                versions.append({
                    "ts": ts,
                    "date": dt.isoformat(),
                    "path": str(p.relative_to(vault_path)).replace('\\', '/'),
                    "size": p.stat().st_size
                })
            except (ValueError, OverflowError, OSError, IndexError):
                pass
                
    versions.sort(key=lambda x: x["ts"], reverse=True)
    return versions

def list_trash(vault_path: Path) -> list[dict]:
    """List all deleted files in the trash."""
    trash_dir = _get_trash_dir(vault_path)
    if not trash_dir.exists():
        return []
        
    trashed = []
    for p in trash_dir.rglob('*'):
        try:
            ts_str, orig_name = p.name.split('_', 1)
            if orig_name == p.parent.name:
                ts = int(ts_str.split('-')[0])
                dt = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc)
                
                orig_rel_path = p.parent.relative_to(trash_dir)
                
                size = 0
                if p.is_file():
                    size = p.stat().st_size
                elif p.is_dir():
                    size = sum(f.stat().st_size for f in p.rglob('*') if f.is_file())
                
                trashed.append({
                    "ts": ts,
                    "date": dt.isoformat(),
                    "original_path": str(orig_rel_path).replace('\\', '/'),
                    "trash_path": str(p.relative_to(vault_path)).replace('\\', '/'),
                    "size": size
                })
        except (ValueError, OverflowError, OSError, IndexError):
            pass
                
    trashed.sort(key=lambda x: x["ts"], reverse=True)
    return trashed
