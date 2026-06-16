"""
main.py -- Application entry-point for Obsidian API Sync.

Includes:
  - All existing functionality (tokens, vault path, audit log, dashboard)
  - Google Drive OAuth2 flow (/auth/google, /auth/google/callback, /auth/google/disconnect)
  - Storage tab on the dashboard (switch between local and Google Drive backends)
"""

import asyncio
import logging
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
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.sessions import SessionMiddleware

from config import settings
from database import (
    add_audit,
    clear_gdrive_credentials,
    create_token,
    get_audit_log,
    get_gdrive_credentials,
    get_storage_backend,
    get_vault_path,
    init_db,
    list_tokens,
    revoke_token,
    set_gdrive_credentials,
    set_storage_backend,
    set_vault_path,
)
from routers.files import router as files_router
from routers.ws import router as ws_router

logger = logging.getLogger(__name__)

limiter = Limiter(
    key_func=get_remote_address,
    enabled=settings.RATE_LIMIT_ENABLED,
    default_limits=["200/minute"],
)

_TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATES_DIR))

_DANGEROUS_PATH_PATTERNS = re.compile(
    r"^(/etc|/root|/sys|/proc|/dev|/boot|/usr/bin|/usr/sbin|/bin|/sbin"
    r"|[Cc]:[/\\][Ww]indows|[Cc]:[/\\][Pp]rogram)",
    re.IGNORECASE,
)


def _validate_vault_path(path: str) -> None:
    resolved = str(Path(path).resolve())
    if _DANGEROUS_PATH_PATTERNS.match(resolved) or _DANGEROUS_PATH_PATTERNS.match(path):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Refused: vault path points to a protected system directory.",
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    vault_path = await get_vault_path()
    Path(vault_path).mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(
    title="Obsidian API Sync",
    description="""## Obsidian API Sync\n\nReal-time bidirectional markdown vault sync.\n\n### Authentication\nAll `/api/` endpoints require: `Authorization: Bearer <token>`\n\n### WebSocket\nConnect to `/ws/sync?token=<token>` for real-time sync.\n""",
    version="1.5.0",
    openapi_tags=[
        {"name": "files", "description": "Read and write markdown notes"},
        {"name": "admin", "description": "Token management and configuration"},
    ],
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SECRET_KEY,
    session_cookie="obsidian_api_sync_admin",
    max_age=86400,
    https_only=settings.HTTPS_ONLY,
    same_site="lax",
)

_cors_origins = settings.get_cors_origins()
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

app.include_router(files_router)
app.include_router(ws_router)

_STATIC_DIR = Path(__file__).parent / "static"
_STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")


# -- Auth Guard Helpers -------------------------------------------------------

def _require_dashboard_auth(request: Request) -> None:
    if not request.session.get("authenticated"):
        raise HTTPException(status_code=303, headers={"Location": "/dashboard/login"})


def _check_csrf(request_csrf: str | None, session_csrf: str | None) -> None:
    if not request_csrf or not session_csrf or request_csrf != session_csrf:
        raise HTTPException(status_code=403, detail="CSRF token mismatch.")


def _get_or_create_csrf(request: Request) -> str:
    if "csrf_token" not in request.session:
        request.session["csrf_token"] = secrets.token_hex(16)
    return request.session["csrf_token"]


# -- Dashboard Routes ---------------------------------------------------------

@app.get("/dashboard/login", response_class=HTMLResponse, include_in_schema=False)
async def dashboard_login_page(request: Request, error: str = "") -> HTMLResponse:
    return templates.TemplateResponse(request, "dashboard.html", {"view": "login", "error": error})


@app.post("/dashboard/login", include_in_schema=False)
@limiter.limit(settings.LOGIN_RATE_LIMIT)
async def dashboard_login_submit(request: Request) -> Response:
    form = await request.form()
    password: str = form.get("password", "")  # type: ignore[assignment]
    if password == settings.ADMIN_PASSWORD:
        request.session["authenticated"] = True
        request.session["csrf_token"] = secrets.token_hex(16)
        return RedirectResponse(url="/dashboard", status_code=303)
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
    storage_backend = await get_storage_backend()
    gdrive_creds = await get_gdrive_credentials()
    gdrive_enabled = bool(settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET)

    return templates.TemplateResponse(
        request, "dashboard.html",
        {
            "view": "dashboard",
            "vault_path": vault_path,
            "tokens": tokens,
            "audit": audit,
            "csrf_token": csrf_token,
            "storage_backend": storage_backend,
            "gdrive_creds": gdrive_creds,
            "gdrive_enabled": gdrive_enabled,
        },
    )


# -- Dashboard: Vault Path ----------------------------------------------------

@app.get("/dashboard/vault-path", tags=["admin"], summary="Get the current vault path")
async def api_get_vault_path(request: Request) -> JSONResponse:
    _require_dashboard_auth(request)
    return JSONResponse(content={"vault_path": await get_vault_path()})


@app.post("/dashboard/vault-path", tags=["admin"], summary="Update the vault path")
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
        raise HTTPException(status_code=400, detail="'path' must be non-empty.")

    path = path.strip()
    _validate_vault_path(path)
    await set_vault_path(path)
    Path(path).mkdir(parents=True, exist_ok=True)
    await add_audit(method="POST", path=path, token_id=None, action="SET_VAULT_PATH")
    return JSONResponse(content={"status": "ok", "vault_path": path})


# -- Dashboard: Tokens --------------------------------------------------------

@app.get("/dashboard/tokens", tags=["admin"], summary="List all API tokens")
async def api_list_tokens(request: Request) -> JSONResponse:
    _require_dashboard_auth(request)
    return JSONResponse(content={"tokens": await list_tokens()})


@app.post("/dashboard/tokens", tags=["admin"], summary="Generate a new API token")
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


@app.delete("/dashboard/tokens/{token_id}", tags=["admin"], summary="Revoke an API token", status_code=204)
async def api_revoke_token(token_id: int, request: Request) -> Response:
    _require_dashboard_auth(request)
    await revoke_token(token_id)
    await add_audit(method="DELETE", path=None, token_id=None, action=f"REVOKE_TOKEN id={token_id}")
    return Response(status_code=204)


# -- Dashboard: Audit Log -----------------------------------------------------

@app.get("/dashboard/audit", tags=["admin"], summary="Fetch recent audit log entries")
async def api_audit_log(request: Request, limit: int = 50) -> JSONResponse:
    _require_dashboard_auth(request)
    return JSONResponse(content={"entries": await get_audit_log(limit=min(limit, 200))})


# -- Google Drive OAuth2 Routes -----------------------------------------------

def _build_gdrive_flow():
    """Build a google_auth_oauthlib Flow object from current settings."""
    from google_auth_oauthlib.flow import Flow
    return Flow.from_client_config(
        {
            "web": {
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "redirect_uris": [settings.GOOGLE_REDIRECT_URI],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=["https://www.googleapis.com/auth/drive",
                "https://www.googleapis.com/auth/userinfo.email",
                "openid"],
        redirect_uri=settings.GOOGLE_REDIRECT_URI,
    )


@app.get("/auth/google", include_in_schema=False)
async def google_auth_start(request: Request) -> Response:
    """Initiate the Google OAuth2 login flow."""
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/dashboard/login", status_code=303)

    if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
        raise HTTPException(
            status_code=400,
            detail="Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file.",
        )

    flow = _build_gdrive_flow()
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",  # force refresh token on every login
    )
    request.session["gdrive_oauth_state"] = state
    return RedirectResponse(url=auth_url, status_code=302)


@app.get("/auth/google/callback", include_in_schema=False)
async def google_auth_callback(request: Request) -> Response:
    """Handle the OAuth2 callback from Google, store credentials, redirect to dashboard."""
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/dashboard/login", status_code=303)

    # Exchange code for tokens
    try:
        flow = _build_gdrive_flow()
        flow.fetch_token(
            authorization_response=str(request.url),
            state=request.session.pop("gdrive_oauth_state", None),
        )
        credentials = flow.credentials
        refresh_token = credentials.refresh_token
    except Exception as exc:
        logger.exception("Google OAuth callback error: %s", exc)
        return RedirectResponse(
            url="/dashboard?gdrive_error=OAuth+callback+failed.+Please+try+again.", status_code=303
        )

    # Get user email via Google userinfo
    try:
        import asyncio
        import httpx
        from google.auth.transport.requests import Request as GoogleRequest
        credentials.refresh(GoogleRequest())

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {credentials.token}"},
            )
        user_info = resp.json()
        user_email = user_info.get("email", "unknown")
    except Exception:
        user_email = "unknown"

    # Store the refresh token — folder selection happens in the dashboard
    request.session["gdrive_pending_refresh_token"] = refresh_token
    request.session["gdrive_pending_email"] = user_email

    await add_audit(method="GET", path=None, token_id=None, action=f"GDRIVE_AUTH user={user_email}")
    return RedirectResponse(url="/dashboard?tab=storage&gdrive_connected=1", status_code=303)


@app.get("/auth/google/folders", include_in_schema=False)
async def google_list_folders(request: Request) -> JSONResponse:
    """List the top-level Drive folders for the authenticated user (for folder picker)."""
    _require_dashboard_auth(request)

    refresh_token = request.session.get("gdrive_pending_refresh_token")
    creds = await get_gdrive_credentials()
    if not refresh_token and creds:
        refresh_token = creds["refresh_token"]
    if not refresh_token:
        raise HTTPException(status_code=400, detail="Not connected to Google Drive.")

    def _list():
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        cred_obj = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=settings.GOOGLE_CLIENT_ID,
            client_secret=settings.GOOGLE_CLIENT_SECRET,
            scopes=["https://www.googleapis.com/auth/drive"],
        )
        svc = build("drive", "v3", credentials=cred_obj, cache_discovery=False)
        resp = svc.files().list(
            q="mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false",
            fields="files(id, name)",
            pageSize=50,
        ).execute()
        return resp.get("files", [])

    import asyncio
    folders = await asyncio.to_thread(_list)
    return JSONResponse(content={"folders": folders})


@app.post("/auth/google/select-folder", include_in_schema=False)
async def google_select_folder(request: Request) -> JSONResponse:
    """Finalise Drive setup: store chosen folder ID + activate Drive backend."""
    _require_dashboard_auth(request)

    body: dict[str, Any] = await request.json()
    _check_csrf(body.get("csrf_token"), request.session.get("csrf_token"))

    folder_id: str = body.get("folder_id", "").strip()
    folder_name: str = body.get("folder_name", "ObsidianVault").strip()
    refresh_token = request.session.pop("gdrive_pending_refresh_token", None)
    user_email = request.session.pop("gdrive_pending_email", "unknown")

    if not folder_id or not refresh_token:
        raise HTTPException(status_code=400, detail="Missing folder_id or OAuth token. Please reconnect.")

    await set_gdrive_credentials(
        refresh_token=refresh_token,
        folder_id=folder_id,
        folder_name=folder_name,
        user_email=user_email,
    )
    await set_storage_backend("google_drive")
    await add_audit(method="POST", path=None, token_id=None, action=f"GDRIVE_ACTIVATE folder={folder_name}")

    return JSONResponse(content={"status": "ok", "backend": "google_drive", "folder_name": folder_name})


@app.post("/auth/google/disconnect", include_in_schema=False)
async def google_disconnect(request: Request) -> JSONResponse:
    """Disconnect Google Drive and revert to local storage."""
    _require_dashboard_auth(request)
    body: dict[str, Any] = await request.json()
    _check_csrf(body.get("csrf_token"), request.session.get("csrf_token"))

    # Invalidate the Drive backend cache if possible
    creds = await get_gdrive_credentials()
    if creds:
        try:
            from storage.google_drive import GoogleDriveBackend
            GoogleDriveBackend.invalidate_cache(creds["refresh_token"], creds["folder_id"])
        except Exception:
            pass

    await clear_gdrive_credentials()
    await set_storage_backend("local")
    await add_audit(method="POST", path=None, token_id=None, action="GDRIVE_DISCONNECT")
    return JSONResponse(content={"status": "ok", "backend": "local"})


@app.get("/dashboard/storage-status", include_in_schema=False)
async def storage_status(request: Request) -> JSONResponse:
    """Return the current storage backend and Drive connection status."""
    _require_dashboard_auth(request)
    backend = await get_storage_backend()
    creds = await get_gdrive_credentials()
    return JSONResponse(content={
        "backend": backend,
        "gdrive_connected": creds is not None,
        "gdrive_email": creds.get("user_email") if creds else None,
        "gdrive_folder_name": creds.get("folder_name") if creds else None,
        "gdrive_folder_id": creds.get("folder_id") if creds else None,
    })


# -- Root redirect ------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def root_redirect() -> Response:
    return RedirectResponse(url="/dashboard", status_code=302)


if __name__ == "__main__":
    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=True)
