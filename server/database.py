"""
database.py — Async SQLite access layer for Obsidian API Sync API.

All DB operations are fully async via aiosqlite.  The vault path is stored in
the `server_config` table so it can be updated at runtime without restarting
the server process.

Security: API tokens are stored as SHA-256 hashes.  Only the first 8 chars of
the raw token (token_prefix) are persisted for display purposes.  The raw token
is returned once at creation and never stored.
"""

import hashlib
import secrets
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from config import settings

# Module-level constant so callers can reference the configured DB file path.
DATABASE_PATH: str = settings.DB_PATH


# -- Schema -------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token        TEXT UNIQUE NOT NULL,
    token_prefix TEXT NOT NULL DEFAULT '',
    label        TEXT NOT NULL DEFAULT 'default',
    created      TEXT NOT NULL,
    last_used    TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    method    TEXT NOT NULL,
    path      TEXT,
    token_id  INTEGER,
    action    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_config (
    key       TEXT PRIMARY KEY,
    value     TEXT NOT NULL
);
"""


# -- Helpers ------------------------------------------------------------------

def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    return dict(row)


def _hash_token(raw_token: str) -> str:
    """Return the SHA-256 hex digest of a raw token string."""
    return hashlib.sha256(raw_token.encode()).hexdigest()


# -- Lifecycle ----------------------------------------------------------------

async def init_db() -> None:
    """
    Create all tables, run schema migrations, and seed the default vault path.
    Called once at application startup via the FastAPI lifespan handler.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(_SCHEMA_SQL)

        # Migration: add token_prefix column to existing databases that lack it.
        async with db.execute("PRAGMA table_info(tokens)") as cursor:
            cols = {row["name"] async for row in cursor}
        if "token_prefix" not in cols:
            await db.execute(
                "ALTER TABLE tokens ADD COLUMN token_prefix TEXT NOT NULL DEFAULT ''"
            )

        await db.execute(
            "INSERT OR IGNORE INTO server_config (key, value) VALUES ('vault_path', ?)",
            (settings.DEFAULT_VAULT_PATH,),
        )
        await db.commit()


# -- Vault Path ---------------------------------------------------------------

async def get_vault_path() -> str:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT value FROM server_config WHERE key = 'vault_path'"
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError("vault_path is not set in server_config.")
            return row["value"]


async def set_vault_path(path: str) -> None:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO server_config (key, value) VALUES ('vault_path', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (path,),
        )
        await db.commit()


# -- Token Management ---------------------------------------------------------

async def create_token(label: str) -> str:
    """
    Generate a URL-safe bearer token, store its SHA-256 hash, and return the
    raw string (returned ONCE — never stored).
    """
    raw_token = secrets.token_urlsafe(32)
    token_hash = _hash_token(raw_token)
    token_prefix = raw_token[:8]
    created = _utcnow_iso()

    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO tokens (token, token_prefix, label, created) VALUES (?, ?, ?, ?)",
            (token_hash, token_prefix, label, created),
        )
        await db.commit()
    return raw_token


async def verify_token(raw_token: str) -> dict[str, Any] | None:
    """
    Hash the incoming token, look it up, update last_used, and return the row
    without exposing the stored hash.
    """
    token_hash = _hash_token(raw_token)
    now = _utcnow_iso()

    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, token_prefix, label, created, last_used FROM tokens WHERE token = ?",
            (token_hash,),
        ) as cursor:
            row = await cursor.fetchone()

        if row is None:
            return None

        row_dict = _row_to_dict(row)
        await db.execute(
            "UPDATE tokens SET last_used = ? WHERE id = ?",
            (now, row_dict["id"]),
        )
        await db.commit()
        row_dict["last_used"] = now
        return row_dict


async def list_tokens() -> list[dict[str, Any]]:
    """Return all token rows — hash is NOT returned, only token_prefix."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, token_prefix, label, created, last_used FROM tokens ORDER BY id ASC"
        ) as cursor:
            rows = await cursor.fetchall()
    return [_row_to_dict(r) for r in rows]


async def revoke_token(token_id: int) -> None:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM tokens WHERE id = ?", (token_id,))
        await db.commit()


# -- Audit Log ----------------------------------------------------------------

async def add_audit(
    method: str,
    path: str | None,
    token_id: int | None,
    action: str,
) -> None:
    ts = _utcnow_iso()
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO audit_log (ts, method, path, token_id, action) VALUES (?, ?, ?, ?, ?)",
            (ts, method, path, token_id, action),
        )
        await db.commit()


async def get_audit_log(limit: int = 50) -> list[dict[str, Any]]:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, ts, method, path, token_id, action FROM audit_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ) as cursor:
            rows = await cursor.fetchall()
    return [_row_to_dict(r) for r in rows]


# -- Storage Backend ----------------------------------------------------------

async def get_storage_backend() -> str:
    """
    Return the active storage backend name ('local' or 'google_drive').
    Defaults to 'local' if not set.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT value FROM server_config WHERE key = 'storage_backend'"
        ) as cursor:
            row = await cursor.fetchone()
    return row["value"] if row else "local"


async def set_storage_backend(backend: str) -> None:
    """Set the active storage backend ('local' or 'google_drive')."""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO server_config (key, value) VALUES ('storage_backend', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (backend,),
        )
        await db.commit()


async def get_gdrive_credentials() -> dict[str, str] | None:
    """
    Return stored Google Drive OAuth credentials or None if not connected.
    Returns: dict with keys: refresh_token, folder_id, folder_name, user_email
    """
    keys = ("gdrive_refresh_token", "gdrive_folder_id", "gdrive_folder_name", "gdrive_user_email")
    result: dict[str, str] = {}
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        for key in keys:
            async with db.execute(
                "SELECT value FROM server_config WHERE key = ?", (key,)
            ) as cursor:
                row = await cursor.fetchone()
            if row:
                short_key = key.replace("gdrive_", "")
                result[short_key] = row["value"]
    if "refresh_token" not in result:
        return None
    return result


async def set_gdrive_credentials(
    refresh_token: str,
    folder_id: str,
    folder_name: str,
    user_email: str,
) -> None:
    """Store Google Drive OAuth credentials and metadata."""
    entries = {
        "gdrive_refresh_token": refresh_token,
        "gdrive_folder_id": folder_id,
        "gdrive_folder_name": folder_name,
        "gdrive_user_email": user_email,
    }
    async with aiosqlite.connect(DATABASE_PATH) as db:
        for key, value in entries.items():
            await db.execute(
                "INSERT INTO server_config (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
        await db.commit()


async def clear_gdrive_credentials() -> None:
    """Remove all stored Google Drive credentials (disconnect)."""
    keys = ("gdrive_refresh_token", "gdrive_folder_id", "gdrive_folder_name", "gdrive_user_email")
    async with aiosqlite.connect(DATABASE_PATH) as db:
        for key in keys:
            await db.execute("DELETE FROM server_config WHERE key = ?", (key,))
        await db.commit()
