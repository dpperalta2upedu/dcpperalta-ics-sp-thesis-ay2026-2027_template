from __future__ import annotations

import base64

from fastapi import HTTPException
from fastapi import Request

from services.login_service import LoginService


def _get_basic_auth_username(request: Request) -> str | None:
    header = request.headers.get("Authorization", "").strip()
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "basic" or not token:
        return None

    try:
        raw = base64.b64decode(token).decode("utf-8")
    except Exception:
        return None

    username, separator, password = raw.partition(":")
    username = username.strip()
    if not separator or not username or not password:
        return None
    if not LoginService.verify_credentials(username, password):
        return None
    return username


def require_admin(request: Request) -> str:
    token = request.cookies.get(LoginService.SESSION_COOKIE_NAME, "")
    username = LoginService.get_username_from_session_token(token)
    if not username:
        username = _get_basic_auth_username(request)
    if not username:
        raise HTTPException(
            status_code=401,
            detail="An active admin session is required for sandbox access.",
        )
    return username
