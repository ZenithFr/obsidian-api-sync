"""
config.py — Application settings loaded from .env via pydantic-settings.

All runtime configuration lives here.  The vault path itself is stored in
SQLite (see database.py) so it can be changed at runtime without a restart;
DEFAULT_VAULT_PATH is only the one-time seed value written to the DB when
the row does not yet exist.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application-wide settings, sourced from environment variables / .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Network ────────────────────────────────────────────────────────────────
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # ── Security ───────────────────────────────────────────────────────────────
    SECRET_KEY: str  # Required — no default. Used for session signing.
    ADMIN_PASSWORD: str  # Required — no default. Protects /dashboard.

    # ── Persistence ────────────────────────────────────────────────────────────
    DB_PATH: str = "./obsidian-sync.db"

    # Seed value only: written to server_config on first run if vault_path is absent.
    DEFAULT_VAULT_PATH: str = "./vault"


# Singleton instance imported everywhere else.
settings = Settings()
