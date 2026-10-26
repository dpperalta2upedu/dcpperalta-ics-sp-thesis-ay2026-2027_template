from __future__ import annotations

from services.login_service import LoginService


def load_credentials() -> dict[str, str]:
    record = LoginService.get_primary_account()
    return {
        "username": str(record["username"]).strip(),
        "password": str(record["password"]),
    }


def verify_credentials(username: str, password: str) -> bool:
    return LoginService.verify_credentials(username, password)


def save_credentials(username: str, password: str) -> None:
    LoginService.create_or_update_account(
        username=username.strip(),
        password=password,
        is_active=True,
    )


def change_password(
    username: str,
    current_password: str,
    new_password: str,
) -> bool:
    return LoginService.change_password(username, current_password, new_password)

