"""
auth.py — FastAPI authentication dependencies for Obsidian API Sync API.

Provides two helpers:
  - get_current_token: a FastAPI Depends() guard for HTTP routes.
  - verify_ws_token:   a plain async function for the WebSocket handshake,
                       which cannot use Depends() in the usual way.
"""

from typing import Any

from fastapi import HTTPException, Request, status

from database import verify_token


async def get_current_token(request: Request) -> dict[str, Any]:
    """
    FastAPI dependency that validates a Bearer token from the Authorization header.

    Extracts the token from the ``Authorization: Bearer <token>`` header,
    calls :func:`~database.verify_token`, updates ``last_used``, and returns
    the full token row as a dict so downstream handlers can read ``token_id``,
    ``label``, etc.

    Args:
        request: The incoming FastAPI/Starlette request object.

    Returns:
        A dict containing the token row columns: id, token, label, created,
        last_used.

    Raises:
        HTTPException 401: If the Authorization header is missing, malformed,
                           or the token does not exist in the database.
    """
    authorization: str | None = request.headers.get("Authorization")

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    parts = authorization.split(" ", maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be in the form 'Bearer <token>'.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    raw_token = parts[1].strip()
    if not raw_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token is empty.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token_data = await verify_token(raw_token)
    if token_data is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or revoked token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return token_data


async def verify_ws_token(token: str) -> dict[str, Any] | None:
    """
    Validate a bearer token passed as a WebSocket query parameter.

    This is the WebSocket-safe equivalent of :func:`get_current_token`.
    Rather than raising an HTTPException (which terminates an HTTP request),
    it returns None on failure so the WebSocket handler can close the
    connection with the appropriate close code (4001).

    Args:
        token: The raw token string from the WebSocket ``?token=`` query param.

    Returns:
        The token row dict on success, or None if the token is invalid/missing.
    """
    if not token or not token.strip():
        return None

    return await verify_token(token.strip())
