"""
main.py — Application entry-point for Obsidian API Sync.

Wires together:
  - FastAPI application with lifespan (DB init + vault dir creation)
  - CORS + session middleware
  - File and WebSocket routers
  - /dashboard routes (Jinja2 HTML, session-protected)
  - All admin REST API routes for token/config management
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from config import settings
from database import (
    add_audit,
    create_token,
    get_audit_log,
    get_vault_path,
    init_db,
    list_tokens,
    revoke_token,
    set_vault_path,
)
from routers.files import router as files_router
from routers.ws import router as ws_router

# ── Templates ─────────────────────────────────────────────────────────────────

_TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATES_DIR))


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan handler.

    On startup:
      1. Initialise the SQLite database (create tables, seed vault_path).
      2. Create the default vault directory if it does not yet exist.

    On shutdown: nothing special required (aiosqlite connections are short-lived).
    """
    # Initialise DB schema + seed default vault path.
    await init_db()

    # Ensure the vault directory exists on disk.
    vault_path = await get_vault_path()
    Path(vault_path).mkdir(parents=True, exist_ok=True)

    yield  # Application runs here.


# ── Application ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="Obsidian API Sync",
    description="""## Obsidian API Sync

This API is the Single Source of Truth (SSOT) for a markdown vault.
It allows both a human (via the Obsidian API Sync plugin) and an AI agent
to read, write, and delete markdown notes in real-time.

### Authentication
All `/api/` endpoints require a Bearer token in the Authorization header:
```
Authorization: Bearer <your_token>
```
Generate tokens via the web dashboard at `/dashboard`.

### WebSocket Sync
Connect to `/ws/sync?token=<your_token>` for real-time bidirectional sync.
All file changes are broadcast instantly to all connected clients.

### AI Agent Integration
This schema is designed to be ingested as an MCP tool definition.
Each endpoint description explains exactly when and how an AI agent should use it.
""",
    version="1.2.1",
    openapi_tags=[
        {"name": "files", "description": "Read and write markdown notes in the vault"},
        {"name": "admin", "description": "Token management and server configuration"},
    ],
    lifespan=lifespan,
)

# ── Middleware ────────────────────────────────────────────────────────────────

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SECRET_KEY,
    session_cookie="obsidian_api_sync_admin",
    max_age=86400,  # 24 hours
    https_only=False,  # Set True behind TLS in production.
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(files_router)
app.include_router(ws_router)

# ── Static Files ──────────────────────────────────────────────────────────────

_STATIC_DIR = Path(__file__).parent / "static"
_STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


# ── Auth Guard Helper ─────────────────────────────────────────────────────────

def _require_dashboard_auth(request: Request) -> None:
    """
    Raise a redirect to the login page if the session is not authenticated.

    Args:
        request: The current Starlette request.

    Raises:
        HTTPException 303: Redirects to /dashboard/login.
    """
    if not request.session.get("authenticated"):
        raise HTTPException(
            status_code=status.HTTP_303_SEE_OTHER,
            headers={"Location": "/dashboard/login"},
        )


# ── Dashboard Routes ──────────────────────────────────────────────────────────


@app.get("/dashboard/login", response_class=HTMLResponse, include_in_schema=False)
async def dashboard_login_page(request: Request, error: str = "") -> HTMLResponse:
    """Render the dashboard login page."""
    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "view": "login",
            "error": error,
        },
    )


@app.post("/dashboard/login", include_in_schema=False)
async def dashboard_login_submit(request: Request) -> Response:
    """
    Validate the admin password from the login form.

    On success: set session cookie and redirect to /dashboard.
    On failure: redirect to /dashboard/login with an error flag.
    """
    form = await request.form()
    password: str = form.get("password", "")  # type: ignore[assignment]

    if password == settings.ADMIN_PASSWORD:
        request.session["authenticated"] = True
        return RedirectResponse(url="/dashboard", status_code=303)

    return RedirectResponse(
        url="/dashboard/login?error=Invalid+password", status_code=303
    )


@app.post("/dashboard/logout", include_in_schema=False)
async def dashboard_logout(request: Request) -> Response:
    """Clear the session and redirect to the login page."""
    request.session.clear()
    return RedirectResponse(url="/dashboard/login", status_code=303)


@app.get("/dashboard", response_class=HTMLResponse, include_in_schema=False)
async def dashboard_home(request: Request) -> Response:
    """Render the main dashboard (requires authentication)."""
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/dashboard/login", status_code=303)

    vault_path = await get_vault_path()
    tokens = await list_tokens()
    audit = await get_audit_log(limit=50)

    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "view": "dashboard",
            "vault_path": vault_path,
            "tokens": tokens,
            "audit": audit,
        },
    )


# ── Dashboard: Vault Path ─────────────────────────────────────────────────────


@app.get(
    "/dashboard/vault-path",
    tags=["admin"],
    summary="Get the current vault path",
)
async def api_get_vault_path(request: Request) -> JSONResponse:
    """Return the currently configured vault path from the database."""
    _require_dashboard_auth(request)
    vault_path = await get_vault_path()
    return JSONResponse(content={"vault_path": vault_path})


@app.post(
    "/dashboard/vault-path",
    tags=["admin"],
    summary="Update the vault path",
    description="""Update the vault root directory.  The change takes effect immediately
— all subsequent file operations use the new path without a server restart.""",
)
async def api_set_vault_path(request: Request) -> JSONResponse:
    """
    Update the vault path in the database.

    Accepts JSON body ``{"path": "/abs/path/to/vault"}`` or form-encoded ``path=...``.
    """
    _require_dashboard_auth(request)

    content_type = request.headers.get("content-type", "")
    path: str = ""

    if "application/json" in content_type:
        body: dict[str, Any] = await request.json()
        path = body.get("path", "")
    else:
        form = await request.form()
        path = form.get("path", "")  # type: ignore[assignment]

    if not path or not path.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="'path' must be a non-empty string.",
        )

    path = path.strip()
    await set_vault_path(path)
    # Ensure the new directory exists.
    Path(path).mkdir(parents=True, exist_ok=True)

    await add_audit(
        method="POST",
        path=path,
        token_id=None,
        action="SET_VAULT_PATH",
    )

    return JSONResponse(content={"status": "ok", "vault_path": path})


# ── Dashboard: Tokens ─────────────────────────────────────────────────────────


@app.get(
    "/dashboard/tokens",
    tags=["admin"],
    summary="List all API tokens",
)
async def api_list_tokens(request: Request) -> JSONResponse:
    """Return all token rows (id, label, created, last_used)."""
    _require_dashboard_auth(request)
    tokens = await list_tokens()
    return JSONResponse(content={"tokens": tokens})


@app.post(
    "/dashboard/tokens",
    tags=["admin"],
    summary="Generate a new API token",
    description="""Create a new Bearer token with an optional human-readable label.
The raw token string is returned **once** — it cannot be retrieved again.""",
)
async def api_create_token(request: Request) -> JSONResponse:
    """
    Generate a new bearer token.

    Accepts JSON ``{"label": "my-label"}`` or form-encoded ``label=...``.
    """
    _require_dashboard_auth(request)

    content_type = request.headers.get("content-type", "")
    label: str = "default"

    if "application/json" in content_type:
        body: dict[str, Any] = await request.json()
        label = body.get("label", "default") or "default"
    else:
        form = await request.form()
        label = str(form.get("label", "default") or "default")

    token = await create_token(label=label.strip())

    await add_audit(
        method="POST",
        path=None,
        token_id=None,
        action=f"CREATE_TOKEN label={label}",
    )

    return JSONResponse(content={"token": token, "label": label})


@app.delete(
    "/dashboard/tokens/{token_id}",
    tags=["admin"],
    summary="Revoke an API token",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def api_revoke_token(token_id: int, request: Request) -> Response:
    """Permanently delete the token with the given id."""
    _require_dashboard_auth(request)
    await revoke_token(token_id)

    await add_audit(
        method="DELETE",
        path=None,
        token_id=None,
        action=f"REVOKE_TOKEN id={token_id}",
    )

    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Dashboard: Audit Log ──────────────────────────────────────────────────────


@app.get(
    "/dashboard/audit",
    tags=["admin"],
    summary="Fetch recent audit log entries",
)
async def api_audit_log(request: Request, limit: int = 50) -> JSONResponse:
    """Return the most recent audit log rows (newest first)."""
    _require_dashboard_auth(request)
    entries = await get_audit_log(limit=limit)
    return JSONResponse(content={"entries": entries})


# ── Root redirect ─────────────────────────────────────────────────────────────


@app.get("/", include_in_schema=False)
async def root_redirect() -> Response:
    """Redirect bare root requests to the dashboard."""
    return RedirectResponse(url="/dashboard", status_code=302)


# ── Dev entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=True,
    )
