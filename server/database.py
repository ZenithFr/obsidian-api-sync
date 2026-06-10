"""
database.py — Async SQLite access layer for Obsidian API Sync API.

All DB operations are fully async via aiosqlite.  The vault path is stored in
the `server_config` table so it can be updated at runtime without restarting
the server process.
"""

import secrets
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from config import settings

# Module-level constant so callers can reference the configured DB file path.
DATABASE_PATH: str = settings.DB_PATH


# ── Schema ────────────────────────────────────────────────────────────────────

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tokens (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    token     TEXT UNIQUE NOT NULL,
    label     TEXT NOT NULL DEFAULT 'default',
    created   TEXT NOT NULL,
    last_used TEXT
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


# ── Helpers ───────────────────────────────────────────────────────────────────

def _utcnow_iso() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    """Convert an aiosqlite Row to a plain Python dict."""
    return dict(row)


# ── Lifecycle ─────────────────────────────────────────────────────────────────

async def init_db() -> None:
    """
    Create all tables and seed the default vault path if it is not already set.

    Called once at application startup via the FastAPI lifespan handler.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(_SCHEMA_SQL)
        await db.execute(
            """
            INSERT OR IGNORE INTO server_config (key, value)
            VALUES ('vault_path', ?)
            """,
            (settings.DEFAULT_VAULT_PATH,),
        )
        await db.commit()


# ── Vault Path ────────────────────────────────────────────────────────────────

async def get_vault_path() -> str:
    """
    Read the vault_path from server_config.

    Always performs a DB round-trip so that changes made via the dashboard
    are immediately visible without restarting the server.

    Returns:
        The vault path string stored in the database.

    Raises:
        RuntimeError: If for some reason the key is missing (should not happen
                      after init_db has run).
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT value FROM server_config WHERE key = 'vault_path'"
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError(
                    "vault_path is not set in server_config. "
                    "Ensure init_db() has been called."
                )
            return row["value"]


async def set_vault_path(path: str) -> None:
    """
    Upsert the vault_path key in server_config.

    Args:
        path: The new absolute or relative path to the Obsidian vault directory.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            """
            INSERT INTO server_config (key, value) VALUES ('vault_path', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (path,),
        )
        await db.commit()


# ── Token Management ──────────────────────────────────────────────────────────

async def create_token(label: str) -> str:
    """
    Generate a new URL-safe bearer token, persist it, and return the raw string.

    Args:
        label: Human-readable description for this token (e.g. "obsidian-plugin").

    Returns:
        The newly created raw token string.  This is the only time it is
        returned in full — it is stored as-is (not hashed) for simplicity
        in this single-operator deployment model.
    """
    token = secrets.token_urlsafe(32)
    created = _utcnow_iso()
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO tokens (token, label, created) VALUES (?, ?, ?)",
            (token, label, created),
        )
        await db.commit()
    return token


async def verify_token(token: str) -> dict[str, Any] | None:
    """
    Look up a token by its value, update last_used, and return the row.

    Args:
        token: The raw bearer token string from the Authorization header.

    Returns:
        A dict with all token columns, or None if the token does not exist.
    """
    now = _utcnow_iso()
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, token, label, created, last_used FROM tokens WHERE token = ?",
            (token,),
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
    """
    Return all token rows (token value is included for dashboard display).

    Returns:
        A list of dicts, one per token row, ordered by id ascending.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, token, label, created, last_used FROM tokens ORDER BY id ASC"
        ) as cursor:
            rows = await cursor.fetchall()
    return [_row_to_dict(r) for r in rows]


async def revoke_token(token_id: int) -> None:
    """
    Permanently delete a token by its numeric primary-key id.

    Args:
        token_id: The integer PK of the token to delete.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM tokens WHERE id = ?", (token_id,))
        await db.commit()


# ── Audit Log ─────────────────────────────────────────────────────────────────

async def add_audit(
    method: str,
    path: str | None,
    token_id: int | None,
    action: str,
) -> None:
    """
    Append one row to the audit log.

    Args:
        method:   HTTP method string (GET, POST, DELETE, WS, …).
        path:     Vault-relative file path, or None for non-file actions.
        token_id: The id of the authenticating token, or None for unauthenticated.
        action:   Short human-readable description (e.g. "READ", "WRITE", "CONNECT").
    """
    ts = _utcnow_iso()
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO audit_log (ts, method, path, token_id, action) VALUES (?, ?, ?, ?, ?)",
            (ts, method, path, token_id, action),
        )
        await db.commit()


async def get_audit_log(limit: int = 50) -> list[dict[str, Any]]:
    """
    Retrieve the most recent audit log entries, newest first.

    Args:
        limit: Maximum number of rows to return (default 50).

    Returns:
        A list of dicts representing audit_log rows.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, ts, method, path, token_id, action FROM audit_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ) as cursor:
            rows = await cursor.fetchall()
    return [_row_to_dict(r) for r in rows]
