"""
storage/__init__.py -- Storage backend factory.

Selects the active backend at request-time from the database config so
switching backends takes effect immediately without a server restart.
"""

from storage.base import StorageBackend
from storage.local import LocalBackend
from storage.google_drive import GoogleDriveBackend
from database import get_storage_backend, get_gdrive_credentials, get_vault_path


async def get_backend() -> StorageBackend:
    """
    Return the active StorageBackend instance.

    Reads `storage_backend` from the DB on every call so that a switch
    from the dashboard is picked up instantly.
    """
    backend_name = await get_storage_backend()

    if backend_name == "google_drive":
        creds = await get_gdrive_credentials()
        if creds:
            return GoogleDriveBackend(
                refresh_token=creds["refresh_token"],
                folder_id=creds["folder_id"],
            )
        # Credentials missing — fall back to local and warn
        print("[storage] Google Drive selected but credentials missing — falling back to local.")

    vault_path = await get_vault_path()
    return LocalBackend(vault_path=vault_path)
