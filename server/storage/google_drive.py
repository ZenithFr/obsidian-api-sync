"""
storage/google_drive.py -- Google Drive StorageBackend implementation.

Uses the Google Drive REST API v3 via google-api-python-client.
The Drive API is synchronous; all calls are wrapped in asyncio.to_thread()
to avoid blocking the FastAPI event loop.

Folder/file ID caching:
  Drive identifies files by opaque IDs, not paths.  This backend maintains
  an in-memory cache of { vault_relative_path -> drive_file_id } that is
  built lazily on the first operation and updated on every create/delete.
  The cache is per-instance (i.e. per-request since get_backend() creates
  a new instance each time) for correctness; a module-level shared cache
  is used as an optimisation when credentials have not changed.
"""

import asyncio
import io
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Module-level cache keyed by (refresh_token, folder_id) so it survives
# across requests without being rebuilt every time.
_shared_cache: dict[tuple[str, str], dict[str, str]] = {}
_shared_folder_cache: dict[tuple[str, str], dict[str, str]] = {}


def _build_service(refresh_token: str) -> Any:
    """Build and return an authenticated Google Drive service object."""
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    from config import settings

    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=settings.GOOGLE_CLIENT_ID,
        client_secret=settings.GOOGLE_CLIENT_SECRET,
        scopes=["https://www.googleapis.com/auth/drive"],
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)


class GoogleDriveBackend:
    """
    Reads and writes vault files in a specific Google Drive folder tree.

    Args:
        refresh_token: The stored OAuth2 refresh token for the user.
        folder_id: The Drive folder ID that acts as the vault root.
    """

    MIME_FOLDER = "application/vnd.google-apps.folder"
    MIME_TEXT = "text/plain"

    def __init__(self, refresh_token: str, folder_id: str) -> None:
        self._refresh_token = refresh_token
        self._folder_id = folder_id
        self._cache_key = (refresh_token, folder_id)
        # file cache:   path -> file_id
        # folder cache: relative_folder_path -> folder_id  ("" = root)
        if self._cache_key not in _shared_cache:
            _shared_cache[self._cache_key] = {}
            _shared_folder_cache[self._cache_key] = {"": folder_id}
        self._files = _shared_cache[self._cache_key]
        self._folders = _shared_folder_cache[self._cache_key]

    # -- Internal Drive helpers (sync, called via to_thread) ------------------

    def _service(self) -> Any:
        return _build_service(self._refresh_token)

    def _list_children(self, svc: Any, parent_id: str) -> list[dict]:
        """List all non-trashed children of a Drive folder (one level deep)."""
        results = []
        page_token = None
        while True:
            resp = svc.files().list(
                q=f"'{parent_id}' in parents and trashed = false",
                fields="nextPageToken, files(id, name, mimeType)",
                pageSize=1000,
                pageToken=page_token,
            ).execute()
            results.extend(resp.get("files", []))
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
        return results

    def _build_cache_sync(self) -> None:
        """Walk the entire Drive folder tree and populate both caches."""
        svc = self._service()

        def _walk(folder_id: str, prefix: str) -> None:
            children = self._list_children(svc, folder_id)
            for item in children:
                rel_path = f"{prefix}/{item['name']}" if prefix else item["name"]
                if item["mimeType"] == self.MIME_FOLDER:
                    self._folders[rel_path] = item["id"]
                    _walk(item["id"], rel_path)
                else:
                    self._files[rel_path] = item["id"]

        _walk(self._folder_id, "")

    def _ensure_folder_sync(self, svc: Any, rel_folder_path: str) -> str:
        """
        Ensure a folder hierarchy exists in Drive, creating missing levels.
        Returns the Drive folder ID of the deepest folder.
        """
        if rel_folder_path == "" or rel_folder_path == ".":
            return self._folder_id

        if rel_folder_path in self._folders:
            return self._folders[rel_folder_path]

        parts = rel_folder_path.replace("\\", "/").split("/")
        current_id = self._folder_id
        accumulated = ""
        for part in parts:
            accumulated = f"{accumulated}/{part}" if accumulated else part
            if accumulated in self._folders:
                current_id = self._folders[accumulated]
                continue
            # Create the missing folder
            meta = {"name": part, "mimeType": self.MIME_FOLDER, "parents": [current_id]}
            folder = svc.files().create(body=meta, fields="id").execute()
            current_id = folder["id"]
            self._folders[accumulated] = current_id

        return current_id

    def _get_or_create_file_id_sync(self, svc: Any, path: str) -> str | None:
        """Return the Drive file ID for a path, or None if it doesn't exist."""
        return self._files.get(path)

    def _read_file_sync(self, path: str) -> str:
        from googleapiclient.http import MediaIoBaseDownload
        svc = self._service()
        if not self._files:
            self._build_cache_sync()
        file_id = self._files.get(path)
        if not file_id:
            raise FileNotFoundError(f"File not found in Drive: {path}")
        request = svc.files().get_media(fileId=file_id)
        buf = io.BytesIO()
        downloader = MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return buf.getvalue().decode("utf-8")

    def _write_file_sync(self, path: str, content: str) -> int:
        from googleapiclient.http import MediaIoBaseUpload
        svc = self._service()
        parts = path.replace("\\", "/").rsplit("/", 1)
        folder_rel = parts[0] if len(parts) == 2 else ""
        file_name = parts[-1]
        parent_id = self._ensure_folder_sync(svc, folder_rel)

        encoded = content.encode("utf-8")
        media = MediaIoBaseUpload(io.BytesIO(encoded), mimetype=self.MIME_TEXT, resumable=False)

        existing_id = self._files.get(path)
        if existing_id:
            svc.files().update(fileId=existing_id, media_body=media).execute()
        else:
            meta = {"name": file_name, "parents": [parent_id]}
            f = svc.files().create(body=meta, media_body=media, fields="id").execute()
            self._files[path] = f["id"]

        return len(encoded)

    def _delete_sync(self, path: str) -> None:
        svc = self._service()
        if not self._files and not self._folders:
            self._build_cache_sync()

        file_id = self._files.pop(path, None)
        if not file_id:
            # Could be a folder
            file_id = self._folders.pop(path, None)
            if not file_id:
                return  # Already gone
            # Also remove all children from caches
            prefix = path + "/"
            for k in list(self._files.keys()):
                if k.startswith(prefix):
                    del self._files[k]
            for k in list(self._folders.keys()):
                if k.startswith(prefix):
                    del self._folders[k]

        svc.files().delete(fileId=file_id).execute()

    def _create_folder_sync(self, path: str) -> None:
        svc = self._service()
        self._ensure_folder_sync(svc, path)

    def _list_files_sync(self) -> list[str]:
        if not self._files:
            self._build_cache_sync()
        return sorted(p for p in self._files if p.endswith(".md"))

    def _list_files_with_content_sync(self) -> list[dict]:
        from googleapiclient.http import MediaIoBaseDownload
        svc = self._service()
        if not self._files:
            self._build_cache_sync()

        md_paths = [p for p in self._files if p.endswith(".md")]
        results = []
        for path in sorted(md_paths):
            try:
                file_id = self._files[path]
                request = svc.files().get_media(fileId=file_id)
                buf = io.BytesIO()
                MediaIoBaseDownload(buf, request).next_chunk()
                content = buf.getvalue().decode("utf-8")
                results.append({"path": path, "content": content})
            except Exception as exc:
                logger.warning("Could not read Drive file %s: %s", path, exc)
        return results

    def _exists_sync(self, path: str) -> bool:
        if not self._files:
            self._build_cache_sync()
        return path in self._files or path in self._folders

    def _file_size_sync(self, path: str) -> int:
        content = self._read_file_sync(path)
        return len(content.encode("utf-8"))

    # -- Public async interface -----------------------------------------------

    async def list_files(self) -> list[str]:
        return await asyncio.to_thread(self._list_files_sync)

    async def list_files_with_content(self) -> list[dict]:
        return await asyncio.to_thread(self._list_files_with_content_sync)

    async def read_file(self, path: str) -> str:
        return await asyncio.to_thread(self._read_file_sync, path)

    async def write_file(self, path: str, content: str) -> int:
        return await asyncio.to_thread(self._write_file_sync, path, content)

    async def delete(self, path: str) -> None:
        await asyncio.to_thread(self._delete_sync, path)

    async def create_folder(self, path: str) -> None:
        await asyncio.to_thread(self._create_folder_sync, path)

    async def exists(self, path: str) -> bool:
        return await asyncio.to_thread(self._exists_sync, path)

    async def file_size(self, path: str) -> int:
        return await asyncio.to_thread(self._file_size_sync, path)

    @classmethod
    def invalidate_cache(cls, refresh_token: str, folder_id: str) -> None:
        """Clear the shared cache for a given credential set."""
        key = (refresh_token, folder_id)
        _shared_cache.pop(key, None)
        _shared_folder_cache.pop(key, None)
