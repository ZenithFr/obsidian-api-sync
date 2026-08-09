"""
config.py -- Application settings loaded from .env via pydantic-settings.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Stable directory that contains this file — used to anchor default paths so
# that relative defaults never silently resolve to a wrong directory when the
# process is started from a different cwd (e.g. systemd WorkingDirectory).
_SERVER_DIR: Path = Path(__file__).parent.resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Network
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Security
    SECRET_KEY: str        # Required -- used for session signing.
    ADMIN_PASSWORD: str    # Required -- protects /dashboard.

    # CORS: comma-separated list of allowed origins.
    # Leave empty to disallow all cross-origin requests (safe default).
    # Example: CORS_ORIGINS=http://localhost:5173,https://my.vault.example.com
    CORS_ORIGINS: str = ""

    # Set True when running behind TLS (marks session cookie as Secure).
    HTTPS_ONLY: bool = False

    # Rate limiting (set False in local dev to skip)
    RATE_LIMIT_ENABLED: bool = True
    # Max login attempts per minute per IP
    LOGIN_RATE_LIMIT: str = "120/minute"
    # Max API requests per minute per token
    API_RATE_LIMIT: str = "240/minute"

    # Max size of a single file write (REST or WebSocket), in bytes.
    MAX_FILE_SIZE_BYTES: int = 10 * 1024 * 1024  # 10 MB

    # Binaries under this size are sent inline as base64 in bulk listings;
    # larger ones are listed with content=None and clients fetch them
    # individually via /api/files/download/{path}. Keeps the bulk pull
    # payload small enough for low-memory clients (mobile Obsidian).
    MAX_INLINE_BINARY_BYTES: int = 64 * 1024  # 64 KB

    # Persistence
    # Defaults are absolute paths anchored to the server/ directory so the
    # process produces the same result regardless of its working directory.
    # Values supplied in .env are accepted as-is and resolved in database.py.
    DB_PATH: str = str(_SERVER_DIR / "obsidian-sync.db")
    DEFAULT_VAULT_PATH: str = str(_SERVER_DIR / "vault")

    def get_cors_origins(self) -> list[str]:
        """Parse CORS_ORIGINS env var into a list."""
        if not self.CORS_ORIGINS or not self.CORS_ORIGINS.strip():
            return []
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
