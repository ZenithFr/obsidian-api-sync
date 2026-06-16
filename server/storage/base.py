"""
storage/base.py -- Abstract StorageBackend protocol.

Every backend (local disk, Google Drive, etc.) must implement this interface.
All methods are async; sync implementations must wrap calls in asyncio.to_thread().
"""

from typing import Protocol, runtime_checkable


@runtime_checkable
class StorageBackend(Protocol):
    """Common interface for all vault storage backends."""

    async def list_files(self) -> list[str]:
        """
        Return vault-relative paths of all .md files, forward-slash separated.
        Example: ["journal/2026-06-16.md", "projects/ideas.md"]
        """
        ...

    async def list_files_with_content(self) -> list[dict]:
        """
        Return list of {"path": str, "content": str} for all .md files.
        Used by the plugin bulk-pull on first connect.
        """
        ...

    async def read_file(self, path: str) -> str:
        """Read and return the UTF-8 content of a vault-relative file path."""
        ...

    async def write_file(self, path: str, content: str) -> int:
        """
        Write content to a vault-relative path. Creates parent dirs/folders
        as needed. Returns the number of bytes written.
        """
        ...

    async def delete(self, path: str) -> None:
        """Delete a file or folder at the vault-relative path."""
        ...

    async def create_folder(self, path: str) -> None:
        """Ensure a folder exists at the vault-relative path."""
        ...

    async def exists(self, path: str) -> bool:
        """Return True if a file or folder exists at the vault-relative path."""
        ...

    async def file_size(self, path: str) -> int:
        """Return the size in bytes of the file at the vault-relative path."""
        ...
