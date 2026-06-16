"""
storage/local.py -- Local disk StorageBackend implementation.

This is the default backend. All file operations use pathlib.Path directly,
exactly as the server worked before the storage abstraction was introduced.
"""

import shutil
from pathlib import Path

from config import settings


class LocalBackend:
    """Stores vault files on the local filesystem under vault_path."""

    MAX_FILE_SIZE = settings.MAX_FILE_SIZE_BYTES

    def __init__(self, vault_path: str) -> None:
        self.root = Path(vault_path).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    # -- Helpers --------------------------------------------------------------

    def _abs(self, path: str) -> Path:
        """Resolve a vault-relative path to an absolute path, checking for traversal."""
        target = (self.root / path).resolve()
        root_str = str(self.root)
        if not (str(target).startswith(root_str + "/") or str(target) == root_str):
            raise ValueError(f"Path traversal detected: '{path}'")
        return target

    # -- Interface ------------------------------------------------------------

    async def list_files(self) -> list[str]:
        return sorted(
            str(f.relative_to(self.root)).replace("\\", "/")
            for f in self.root.rglob("*.md")
            if f.is_file()
        )

    async def list_files_with_content(self) -> list[dict]:
        results = []
        for f in sorted(self.root.rglob("*.md")):
            if not f.is_file():
                continue
            if f.stat().st_size > self.MAX_FILE_SIZE:
                continue
            try:
                content = f.read_text(encoding="utf-8")
                relative = str(f.relative_to(self.root)).replace("\\", "/")
                results.append({"path": relative, "content": content})
            except Exception:
                pass
        return results

    async def read_file(self, path: str) -> str:
        return self._abs(path).read_text(encoding="utf-8")

    async def write_file(self, path: str, content: str) -> int:
        target = self._abs(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return target.stat().st_size

    async def delete(self, path: str) -> None:
        target = self._abs(path)
        if target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)

    async def create_folder(self, path: str) -> None:
        self._abs(path).mkdir(parents=True, exist_ok=True)

    async def exists(self, path: str) -> bool:
        return self._abs(path).exists()

    async def file_size(self, path: str) -> int:
        return self._abs(path).stat().st_size
