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
import logging
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from config import settings

logger = logging.getLogger(__name__)

# Module-level constant so callers can reference the configured DB file path.
# Resolved to an absolute path so aiosqlite opens the same file regardless of
# the process working directory (fixes cwd-coupling for the DB itself).
DATABASE_PATH: str = str(Path(settings.DB_PATH).expanduser().resolve())


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

CREATE TABLE IF NOT EXISTS file_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT NOT NULL UNIQUE,
    server_mtime_ms INTEGER NOT NULL,
    synced_at_ms    INTEGER NOT NULL
);
"""


# -- Helpers ------------------------------------------------------------------

# SQLite busy timeout: how long aiosqlite will retry acquiring the write lock
# before raising OperationalError("database is locked").  Without this, any
# two concurrent requests that both try to write (e.g. an audit INSERT while
# a list SELECT holds a read transaction) immediately fail with a 500.
_DB_TIMEOUT_SECONDS: int = 10


def _connect() -> aiosqlite.Connection:
    """Open the database with a sensible busy timeout."""
    return aiosqlite.connect(DATABASE_PATH, timeout=_DB_TIMEOUT_SECONDS)


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
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(_SCHEMA_SQL)

        # Migration: add token_prefix column to existing databases that lack it.
        async with db.execute("PRAGMA table_info(tokens)") as cursor:
            cols = {row["name"] async for row in cursor}
        if "token_prefix" not in cols:
            await db.execute(
                "ALTER TABLE tokens ADD COLUMN token_prefix TEXT NOT NULL DEFAULT ''"
            )

        # Seed vault_path as an absolute, cwd-independent path.
        abs_vault = str(Path(settings.DEFAULT_VAULT_PATH).expanduser().resolve())
        await db.execute(
            "INSERT OR IGNORE INTO server_config (key, value) VALUES ('vault_path', ?)",
            (abs_vault,),
        )

        # P3: auto-generate a first-run token so a fresh install can
        # authenticate immediately without touching the database manually.
        async with db.execute("SELECT COUNT(*) AS n FROM tokens") as cursor:
            row = await cursor.fetchone()
            token_count: int = row["n"]

        await db.commit()

    if token_count == 0:
        raw_token = await create_token(label="first-run")
        logger.warning(
            "\n"
            "=================================================================\n"
            " FIRST-RUN TOKEN (shown once — copy it now):\n"
            " %s\n"
            "=================================================================\n"
            " Configure this token in the Obsidian plugin or API client.\n"
            " You can also create additional tokens via the /dashboard.\n"
            "=================================================================",
            raw_token,
        )


# -- Vault Path ---------------------------------------------------------------

async def get_vault_path() -> str:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT value FROM server_config WHERE key = 'vault_path'"
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError("vault_path is not set in server_config.")
            return row["value"]


async def set_vault_path(path: str) -> str:
    """
    Normalize *path* to an absolute, cwd-independent location and persist it.

    The resolved absolute path is returned so callers (e.g. the dashboard
    endpoint) can display exactly what was stored.
    """
    normalized = str(Path(path).expanduser().resolve())
    async with _connect() as db:
        await db.execute(
            "INSERT INTO server_config (key, value) VALUES ('vault_path', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (normalized,),
        )
        await db.commit()
    return normalized


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

    async with _connect() as db:
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

    async with _connect() as db:
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
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, token_prefix, label, created, last_used FROM tokens ORDER BY id ASC"
        ) as cursor:
            rows = await cursor.fetchall()
    return [_row_to_dict(r) for r in rows]


async def revoke_token(token_id: int) -> None:
    async with _connect() as db:
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
    async with _connect() as db:
        await db.execute(
            "INSERT INTO audit_log (ts, method, path, token_id, action) VALUES (?, ?, ?, ?, ?)",
            (ts, method, path, token_id, action),
        )
        await db.commit()


async def get_audit_log(limit: int = 50) -> list[dict[str, Any]]:
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, ts, method, path, token_id, action FROM audit_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ) as cursor:
            rows = await cursor.fetchall()
    return [_row_to_dict(r) for r in rows]


# -- File Ledger --------------------------------------------------------------

async def upsert_ledger(path: str, server_mtime_ms: int) -> None:
    """
    Record that `path` is now confirmed in-sync at the given server mtime.

    Called after every successful write (WS or REST) so we have a stable
    baseline to compare future client/server timestamps against.
    """
    synced_at_ms = int(time.time() * 1000)
    async with _connect() as db:
        await db.execute(
            """
            INSERT INTO file_ledger (path, server_mtime_ms, synced_at_ms)
            VALUES (?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                server_mtime_ms = excluded.server_mtime_ms,
                synced_at_ms    = excluded.synced_at_ms
            """,
            (path, server_mtime_ms, synced_at_ms),
        )
        await db.commit()


async def get_ledger(path: str) -> dict[str, Any] | None:
    """Return the ledger row for a single file, or None if never synced."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT path, server_mtime_ms, synced_at_ms FROM file_ledger WHERE path = ?",
            (path,),
        ) as cursor:
            row = await cursor.fetchone()
    return _row_to_dict(row) if row else None


async def get_all_ledger() -> dict[str, dict[str, Any]]:
    """Return the entire ledger as {path: {server_mtime_ms, synced_at_ms}}."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT path, server_mtime_ms, synced_at_ms FROM file_ledger"
        ) as cursor:
            rows = await cursor.fetchall()
    return {r["path"]: _row_to_dict(r) for r in [dict(row) for row in rows]}
