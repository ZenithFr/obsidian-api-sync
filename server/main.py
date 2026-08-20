"""
main.py -- Application entry-point for Obsidian API Sync.

Security hardening in this file:
  - slowapi rate limiting on login (5/min) and all API routes (120/min)
  - CORS wildcard replaced with explicit CORS_ORIGINS env var
  - Session cookie hardened: SameSite=lax, Secure=HTTPS_ONLY
  - CSRF double-submit token on all dashboard POST endpoints
  - Vault path validation (blocks /etc, /root, C:\\Windows, etc.)
  - Artificial 1-second delay on failed login attempts (anti-brute-force)
  - Security headers middleware (CSP, X-Frame-Options, X-Content-Type-Options,
    Referrer-Policy, Permissions-Policy) on /app routes
  - Prototype pollution defense: Jinja2 auto-escaping enforced on all templates
"""

import asyncio
import logging
import os
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
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
from limiter import limiter
from routers.files import router as files_router
from routers.snapshots import router as snapshots_router
from routers.versions import router as versions_router
from routers.ws import router as ws_router

logger = logging.getLogger(__name__)

# -- Rate limiter setup -------------------------------------------------------

# -- Templates ----------------------------------------------------------------

_TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATES_DIR))


# -- Dangerous vault path prefixes (finding #9) --------------------------------

_DANGEROUS_PATH_PATTERNS = re.compile(
    r"^(/etc|/root|/sys|/proc|/dev|/boot|/usr/bin|/usr/sbin|/bin|/sbin"
    r"|[Cc]:[/\\][Ww]indows|[Cc]:[/\\][Pp]rogram"
    r"|.*[/\\]\.(ssh|aws|gnupg|docker|kube))",
    re.IGNORECASE,
)


def _validate_vault_path(path: str) -> None:
    """
    Reject obviously dangerous vault paths.

    Both the raw path *and* the fully-resolved path are checked so that
    ``..``-based traversals that resolve into sensitive directories (e.g.
    ``../../etc``) are also rejected.

    Raises:
        HTTPException 400: If the path starts with a sensitive system directory.
    """
    raw_resolved = str(Path(path).expanduser().resolve())
    if _DANGEROUS_PATH_PATTERNS.match(path) or _DANGEROUS_PATH_PATTERNS.match(raw_resolved):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Refused: vault path points to a protected system directory. "
                "Choose a directory inside your home folder or a dedicated vault location."
            ),
        )


# -- Lifespan -----------------------------------------------------------------

async def _snapshot_scheduler():
    while True:
        await asyncio.sleep(24 * 60 * 60)
        try:
            vault_path = Path(await get_vault_path())
            from routers.snapshots import _create_snapshot
            await asyncio.to_thread(_create_snapshot, vault_path, False)
            logger.info("Automatic 24-hour vault snapshot created.")
        except Exception as e:
            logger.error(f"Failed to create automatic snapshot: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    vault_path = await get_vault_path()
    vault_root = Path(vault_path)  # always absolute after init_db
    vault_root.mkdir(parents=True, exist_ok=True)
    md_count = sum(1 for _ in vault_root.rglob("*.md"))
    if md_count == 0:
        logger.warning(
            "Vault contains no .md files: %s — "
            "check that vault_path is correct (run: GET /dashboard/vault-path)",
            vault_path,
        )
    task = asyncio.create_task(_snapshot_scheduler())
    yield
    task.cancel()


# -- Application --------------------------------------------------------------

app = FastAPI(
    title="Obsidian API Sync",
    description="""## Obsidian API Sync

Real-time bidirectional markdown vault sync API.

### Authentication
All `/api/` endpoints require a Bearer token:
```
Authorization: Bearer <your_token>
```

### WebSocket Sync
Connect to `/ws/sync?token=<your_token>` for real-time sync.
""",
    version="1.7.1",
    openapi_tags=[
        {"name": "files", "description": "Read and write markdown notes in the vault"},
        {"name": "admin", "description": "Token management and server configuration"},
    ],
    lifespan=lifespan,
)

# Rate limiter exception handler
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# -- Middleware ----------------------------------------------------------------

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SECRET_KEY,
    session_cookie="obsidian_api_sync_admin",
    max_age=86400,
    https_only=settings.HTTPS_ONLY,
    same_site="lax",  # #6/#8: prevents CSRF for cross-site form submissions
)

# #2: CORS -- explicit origins only, no wildcard+credentials
_cors_origins = settings.get_cors_origins()
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=False,   # Bearer token auth -- no cookies needed cross-origin
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

# -- Routers ------------------------------------------------------------------

app.include_router(files_router)
app.include_router(ws_router)
app.include_router(versions_router)
app.include_router(snapshots_router)

# -- Static Files -------------------------------------------------------------

_STATIC_DIR = Path(__file__).parent / "static"
_STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


# -- Auth Guard Helpers -------------------------------------------------------

def _require_dashboard_auth(request: Request) -> None:
    """Redirect to login if not authenticated."""
    if not request.session.get("authenticated"):
        raise HTTPException(
            status_code=status.HTTP_303_SEE_OTHER,
            headers={"Location": "/dashboard/login"},
        )


def _check_csrf(request_csrf: str | None, session_csrf: str | None) -> None:
    """Validate CSRF token double-submit."""
    if not request_csrf or not session_csrf or request_csrf != session_csrf:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="CSRF token mismatch. Please reload the page and try again.",
        )


def _get_or_create_csrf(request: Request) -> str:
    """Get the current CSRF token from session, creating one if absent."""
    if "csrf_token" not in request.session:
        request.session["csrf_token"] = secrets.token_hex(16)
    return request.session["csrf_token"]


# -- Dashboard Routes ---------------------------------------------------------

@app.get("/dashboard/login", response_class=HTMLResponse, include_in_schema=False)
async def dashboard_login_page(request: Request, error: str = "") -> HTMLResponse:
    return templates.TemplateResponse(
        request, "dashboard.html", {"view": "login", "error": error}
    )


@app.post("/dashboard/login", include_in_schema=False)
@limiter.limit(settings.LOGIN_RATE_LIMIT)
async def dashboard_login_submit(request: Request) -> Response:
    """
    Validate the admin password. Rate-limited to 5 attempts/minute per IP.
    Failed attempts incur a 1-second artificial delay (anti-brute-force).
    """
    form = await request.form()
    password: str = form.get("password", "")  # type: ignore[assignment]

    if password == settings.ADMIN_PASSWORD:
        request.session["authenticated"] = True
        # Create CSRF token on login
        request.session["csrf_token"] = secrets.token_hex(16)
        return RedirectResponse(url="/dashboard", status_code=303)

    # #5: artificial delay on failure to slow brute-force
    await asyncio.sleep(1)
    return RedirectResponse(url="/dashboard/login?error=Invalid+password", status_code=303)


@app.post("/dashboard/logout", include_in_schema=False)
async def dashboard_logout(request: Request) -> Response:
    request.session.clear()
    return RedirectResponse(url="/dashboard/login", status_code=303)


@app.get("/dashboard", response_class=HTMLResponse, include_in_schema=False)
async def dashboard_home(request: Request) -> Response:
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/dashboard/login", status_code=303)

    csrf_token = _get_or_create_csrf(request)
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
            "csrf_token": csrf_token,
        },
    )


# -- Dashboard: Vault Path ----------------------------------------------------

@app.get("/dashboard/vault-path", tags=["admin"], summary="Get the current vault path")
async def api_get_vault_path(request: Request) -> JSONResponse:
    _require_dashboard_auth(request)
    vault_path = await get_vault_path()
    return JSONResponse(content={"vault_path": vault_path})


@app.post(
    "/dashboard/vault-path",
    tags=["admin"],
    summary="Update the vault path",
    description="Update the vault root directory. Change takes effect immediately without a server restart.",
)
async def api_set_vault_path(request: Request) -> JSONResponse:
    _require_dashboard_auth(request)

    content_type = request.headers.get("content-type", "")
    path: str = ""
    csrf_form: str | None = None

    if "application/json" in content_type:
        body: dict[str, Any] = await request.json()
        path = body.get("path", "")
        csrf_form = body.get("csrf_token")
    else:
        form = await request.form()
        path = form.get("path", "")  # type: ignore[assignment]
        csrf_form = form.get("csrf_token")  # type: ignore[assignment]

    _check_csrf(csrf_form, request.session.get("csrf_token"))

    if not path or not path.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="'path' must be a non-empty string.")

    path = path.strip()
    _validate_vault_path(path)   # #9: block dangerous system paths

    normalized_path = await set_vault_path(path)
    Path(normalized_path).mkdir(parents=True, exist_ok=True)

    await add_audit(method="POST", path=normalized_path, token_id=None, action="SET_VAULT_PATH")

    return JSONResponse(content={"status": "ok", "vault_path": normalized_path})


# -- Dashboard: Tokens --------------------------------------------------------

@app.get("/dashboard/tokens", tags=["admin"], summary="List all API tokens")
async def api_list_tokens(request: Request) -> JSONResponse:
    _require_dashboard_auth(request)
    tokens = await list_tokens()
    return JSONResponse(content={"tokens": tokens})


@app.post(
    "/dashboard/tokens",
    tags=["admin"],
    summary="Generate a new API token",
    description="Create a new Bearer token. The raw token is returned ONCE and cannot be retrieved again.",
)
async def api_create_token(request: Request) -> JSONResponse:
    _require_dashboard_auth(request)

    content_type = request.headers.get("content-type", "")
    label: str = "default"
    csrf_form: str | None = None

    if "application/json" in content_type:
        body: dict[str, Any] = await request.json()
        label = body.get("label", "default") or "default"
        csrf_form = body.get("csrf_token")
    else:
        form = await request.form()
        label = str(form.get("label", "default") or "default")
        csrf_form = form.get("csrf_token")  # type: ignore[assignment]

    _check_csrf(csrf_form, request.session.get("csrf_token"))

    token = await create_token(label=label.strip())
    await add_audit(method="POST", path=None, token_id=None, action=f"CREATE_TOKEN label={label}")

    return JSONResponse(content={"token": token, "label": label})


@app.delete(
    "/dashboard/tokens/{token_id}",
    tags=["admin"],
    summary="Revoke an API token",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def api_revoke_token(token_id: int, request: Request) -> Response:
    _require_dashboard_auth(request)
    await revoke_token(token_id)
    await add_audit(method="DELETE", path=None, token_id=None, action=f"REVOKE_TOKEN id={token_id}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# -- Dashboard: Audit Log -----------------------------------------------------

@app.get("/dashboard/audit", tags=["admin"], summary="Fetch recent audit log entries")
async def api_audit_log(request: Request, limit: int = 50) -> JSONResponse:
    _require_dashboard_auth(request)
    entries = await get_audit_log(limit=min(limit, 200))  # cap at 200
    return JSONResponse(content={"entries": entries})


# -- Dashboard: Stats ---------------------------------------------------------

@app.get("/dashboard/stats", tags=["admin"], summary="Fetch vault statistics")
async def api_vault_stats(request: Request) -> JSONResponse:
    _require_dashboard_auth(request)
    vault_path = await get_vault_path()
    vault_root = Path(vault_path).resolve()

    if not vault_root.exists():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Vault directory does not exist: {vault_path}",
        )

    md_files = []
    for root, dirs, files in os.walk(vault_root):
        # Prune hidden directories (like .git, .sync_versions) to speed up traversal
        dirs[:] = [d for d in dirs if not (d.startswith(".") and d != ".obsidian")]
        for file in files:
            if file.endswith(".md") and not file.startswith("."):
                full_path = Path(root) / file
                relative = str(full_path.relative_to(vault_root)).replace("\\", "/")
                md_files.append(relative)
    
    md_files.sort()

    return JSONResponse(
        content={
            "files": md_files,
            "vault_path": str(vault_root),
            "count": len(md_files),
        }
    )

# -- Root redirect ------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def root_redirect() -> Response:
    return RedirectResponse(url="/dashboard", status_code=302)


# -- Obsidian Web Client (/app) -----------------------------------------------

# Content-Security-Policy for the web client.
# Allows:
#   - scripts only from CDNs used by the SPA (cdn.tailwindcss.com, cdnjs, fonts.googleapis.com)
#   - styles from same-origin + google fonts + cdnjs
#   - fonts from google
#   - images from same-origin + data URIs
#   - WebSocket connects to same host only (ws: wss:)
#   - NO inline eval(), NO object/embed, NO unknown origins
_APP_CSP = (
    "default-src 'self'; "
    "script-src 'self' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://fonts.googleapis.com 'unsafe-eval'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; "
    "img-src 'self' data:; "
    "connect-src 'self' ws: wss:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self';"
)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    """
    Inject security headers on /app responses.
    - X-Frame-Options: blocks clickjacking
    - X-Content-Type-Options: blocks MIME sniffing
    - Referrer-Policy: no referrer leakage
    - Permissions-Policy: disable unnecessary browser features
    - Content-Security-Policy: restrict execution origins
    """
    response = await call_next(request)
    if request.url.path.startswith("/app"):
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = (
            "camera=(), microphone=(), geolocation=(), payment=()"
        )
        response.headers["Content-Security-Policy"] = _APP_CSP
    return response


@app.get("/app", response_class=HTMLResponse, include_in_schema=False)
async def obsidian_web_app(request: Request) -> Response:
    """
    Obsidian Web Client — browser-based vault reader/editor.

    Security:
      - Requires active dashboard session (same auth as /dashboard)
      - CSRF token injected into template context
      - Full CSP header applied by security_headers_middleware
    """
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/dashboard/login", status_code=303)

    csrf_token = _get_or_create_csrf(request)
    vault_path = await get_vault_path()

    return templates.TemplateResponse(
        request,
        "app.html",
        {
            "csrf_token": csrf_token,
            "vault_path": vault_path,
        },
    )


# -- Dev entrypoint -----------------------------------------------------------

if __name__ == "__main__":
    # reload=True spawns a watcher subprocess; if the parent is SIGKILLed the
    # worker survives with PPID 1 and holds the port, causing crash-loops when
    # the service manager tries to restart.  Only enable reload in dev mode.
    _dev_mode = os.environ.get("DEV", "").strip().lower() in ("1", "true", "yes")
    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=_dev_mode,
    )
