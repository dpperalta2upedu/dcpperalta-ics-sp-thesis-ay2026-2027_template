from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from typing import Any

from services.database import get_connection


class LoginService:
    SESSION_COOKIE_NAME = "indoor_nav_admin_session"
    SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60
    _PASSWORD_SCHEME = "pbkdf2_sha256"
    _PASSWORD_ITERATIONS = 600_000

    @staticmethod
    def _initial_admin_credentials() -> tuple[str, str]:
        username = os.getenv("INDOOR_NAV_INITIAL_ADMIN_USERNAME", "").strip()
        password = os.getenv("INDOOR_NAV_INITIAL_ADMIN_PASSWORD", "")
        if not username or not password:
            raise RuntimeError(
                "INDOOR_NAV_INITIAL_ADMIN_USERNAME and INDOOR_NAV_INITIAL_ADMIN_PASSWORD "
                "must be set when the login_accounts table has no accounts."
            )
        if len(password) < 8:
            raise RuntimeError("INDOOR_NAV_INITIAL_ADMIN_PASSWORD must be at least 8 characters long.")
        return username, password

    @classmethod
    def validate_configuration(cls) -> None:
        if not os.getenv("INDOOR_NAV_SESSION_SECRET", "").strip():
            raise RuntimeError("INDOOR_NAV_SESSION_SECRET must be set.")

    @classmethod
    def _hash_password(cls, password: str) -> str:
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, cls._PASSWORD_ITERATIONS
        )
        return "{}${}${}${}".format(
            cls._PASSWORD_SCHEME,
            cls._PASSWORD_ITERATIONS,
            base64.urlsafe_b64encode(salt).decode("ascii"),
            base64.urlsafe_b64encode(digest).decode("ascii"),
        )

    @classmethod
    def _verify_password(cls, password: str, stored_password: str) -> tuple[bool, bool]:
        parts = stored_password.split("$")
        if len(parts) == 4 and parts[0] == cls._PASSWORD_SCHEME:
            try:
                iterations = int(parts[1])
                salt = base64.urlsafe_b64decode(parts[2].encode("ascii"))
                expected = base64.urlsafe_b64decode(parts[3].encode("ascii"))
            except (ValueError, UnicodeError):
                return False, False
            digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
            return hmac.compare_digest(digest, expected), False
        return hmac.compare_digest(password, stored_password), True

    @classmethod
    def ensure_default_account(cls) -> None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT COUNT(*) AS account_count FROM login_accounts")
                row = cursor.fetchone()
                if int(row["account_count"]) > 0:
                    return
                username, password = cls._initial_admin_credentials()
                cursor.execute(
                    """
                    INSERT INTO login_accounts (username, password, is_active)
                    VALUES (%s, %s, 1)
                    """,
                    (username, cls._hash_password(password)),
                )

    @staticmethod
    def _row_to_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return {
            "id": row["id"],
            "username": row["username"],
            "isActive": bool(row["is_active"]),
            "createdAt": row["created_at"].isoformat() if row.get("created_at") else None,
            "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
        }

    @classmethod
    def _session_signature(cls, username: str, password: str) -> str:
        payload = f"{username}:{password}".encode("utf-8")
        secret = os.environ["INDOOR_NAV_SESSION_SECRET"].encode("utf-8")
        return hmac.new(secret, payload, hashlib.sha256).hexdigest()

    @classmethod
    def get_account(cls, username: str) -> dict[str, Any] | None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, username, password, is_active, created_at, updated_at
                    FROM login_accounts
                    WHERE username = %s
                    LIMIT 1
                    """,
                    (username,),
                )
                return cursor.fetchone()

    @classmethod
    def get_primary_account(cls) -> dict[str, Any]:
        cls.ensure_default_account()
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, username, password, is_active, created_at, updated_at
                    FROM login_accounts
                    WHERE is_active = 1
                    ORDER BY id ASC
                    LIMIT 1
                    """
                )
                row = cursor.fetchone()
        if row is None:
            raise RuntimeError("No active login account is available.")
        return row

    @classmethod
    def get_status(cls) -> dict[str, Any]:
        return cls._row_to_payload(cls.get_primary_account()) or {}

    @classmethod
    def verify_credentials(cls, username: str, password: str) -> bool:
        row = cls.get_account(username)
        if row is None or not bool(row["is_active"]):
            return False
        valid, needs_upgrade = cls._verify_password(password, str(row["password"]))
        if valid and needs_upgrade:
            with get_connection() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "UPDATE login_accounts SET password = %s WHERE id = %s",
                        (cls._hash_password(password), row["id"]),
                    )
        return valid

    @classmethod
    def create_session_token(cls, username: str) -> str:
        row = cls.get_account(username)
        if row is None or not bool(row["is_active"]):
            return ""
        signature = cls._session_signature(username, str(row["password"]))
        token = f"{username}:{signature}".encode("utf-8")
        return base64.urlsafe_b64encode(token).decode("ascii").rstrip("=")

    @classmethod
    def get_username_from_session_token(cls, token: str | None) -> str | None:
        encoded = str(token or "").strip()
        if not encoded:
            return None
        padding = "=" * (-len(encoded) % 4)
        try:
            raw = base64.urlsafe_b64decode((encoded + padding).encode("ascii")).decode("utf-8")
        except Exception:
            return None
        username, separator, signature = raw.partition(":")
        username = username.strip()
        if not separator or not username or not signature:
            return None
        row = cls.get_account(username)
        if row is None or not bool(row["is_active"]):
            return None
        expected = cls._session_signature(username, str(row["password"]))
        if not hmac.compare_digest(signature, expected):
            return None
        return username

    @classmethod
    def change_password(cls, username: str, current_password: str, new_password: str) -> bool:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, password
                    FROM login_accounts
                    WHERE username = %s AND is_active = 1
                    LIMIT 1
                    """,
                    (username,),
                )
                row = cursor.fetchone()
                if row is None or not cls._verify_password(current_password, str(row["password"]))[0]:
                    return False

                cursor.execute(
                    """
                    UPDATE login_accounts
                    SET password = %s
                    WHERE id = %s
                    """,
                    (cls._hash_password(new_password), row["id"]),
                )
        return True

    @classmethod
    def create_or_update_account(
        cls,
        *,
        username: str,
        password: str,
        is_active: bool = True,
    ) -> dict[str, Any]:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO login_accounts (username, password, is_active)
                    VALUES (%s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                      password = VALUES(password),
                      is_active = VALUES(is_active)
                    """,
                    (username, cls._hash_password(password), int(is_active)),
                )
                cursor.execute(
                    """
                    SELECT id, username, password, is_active, created_at, updated_at
                    FROM login_accounts
                    WHERE username = %s
                    LIMIT 1
                    """,
                    (username,),
                )
                row = cursor.fetchone()
        return cls._row_to_payload(row) or {}
