"""
config.py -- Application settings loaded from .env via pydantic-settings.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


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
    LOGIN_RATE_LIMIT: str = "5/minute"
    # Max API requests per minute per token
    API_RATE_LIMIT: str = "120/minute"

    # Max size of a single file write (REST or WebSocket), in bytes.
    MAX_FILE_SIZE_BYTES: int = 10 * 1024 * 1024  # 10 MB

    # Persistence
    DB_PATH: str = "./obsidian-sync.db"
    DEFAULT_VAULT_PATH: str = "./vault"

    # -- Google Drive OAuth2 (optional) ---------------------------------------
    # Required only when using the Google Drive storage backend.
    # Get these from: console.cloud.google.com -> APIs -> OAuth 2.0 Client IDs
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    # Must match an Authorized Redirect URI in your Google Cloud OAuth config.
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/auth/google/callback"

    def get_cors_origins(self) -> list[str]:
        """Parse CORS_ORIGINS env var into a list."""
        if not self.CORS_ORIGINS or not self.CORS_ORIGINS.strip():
            return []
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
