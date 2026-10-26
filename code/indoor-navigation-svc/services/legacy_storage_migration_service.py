from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any
import json
import os

from services.draft_main_map_layout_service import DraftMainMapLayoutService
from services.login_service import LoginService
from services.main_map_layout_history_service import MainMapLayoutHistoryService
from services.main_map_layout_service import MainMapLayoutService
from services.navigation_graph_cache_service import NavigationGraphCacheService


PRIMARY_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FALLBACK_DATA_DIR = Path(__file__).resolve().parent.parent / "map-layouts-copy"
LEGACY_DATA_DIRS = [PRIMARY_DATA_DIR, FALLBACK_DATA_DIR]


class LegacyStorageMigrationService:
    @staticmethod
    def _find_legacy_file(relative_path: str) -> Path | None:
        for base_dir in LEGACY_DATA_DIRS:
            candidate = base_dir / relative_path
            if candidate.exists() and candidate.is_file():
                return candidate
        return None

    @staticmethod
    def _read_json_object(path: Path | None) -> dict[str, Any] | None:
        if path is None or not path.exists() or not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(payload, dict):
            return None
        return payload

    @staticmethod
    def _json_files(relative_folder: str) -> list[Path]:
        discovered: dict[str, Path] = {}
        for base_dir in LEGACY_DATA_DIRS:
            folder = base_dir / relative_folder
            if not folder.exists():
                continue
            for item in folder.iterdir():
                if not item.is_file() or item.suffix.lower() != ".json":
                    continue
                discovered.setdefault(item.name, item)
        return sorted(discovered.values(), key=lambda item: item.stat().st_mtime)

    @classmethod
    def migrate_from_legacy_files(cls, *, delete_files: bool = False) -> dict[str, Any]:
        summary = {
            "loginImported": False,
            "mainLayoutImported": False,
            "navigationGraphCacheImported": False,
            "historyImported": 0,
            "draftsImported": 0,
            "filesDeleted": 0,
        }

        credentials = cls._read_json_object(cls._find_legacy_file("auth_credentials.json"))
        if credentials:
            username = str(credentials.get("username", "")).strip()
            password = str(credentials.get("password", ""))
            if username and LoginService.get_account(username) is None:
                LoginService.create_or_update_account(username=username, password=password, is_active=True)
                summary["loginImported"] = True

        current_layout = cls._read_json_object(cls._find_legacy_file("map_layout.json"))
        if current_layout and MainMapLayoutService.get_current_record() is None:
            MainMapLayoutService.upsert_layout(current_layout)
            summary["mainLayoutImported"] = True

        navigation_graph_cache = cls._read_json_object(cls._find_legacy_file("navigation_graph_cache.json"))
        if navigation_graph_cache and NavigationGraphCacheService.load_cache() is None:
            cache_version = int(navigation_graph_cache.get("cache_version", 0) or 0)
            NavigationGraphCacheService.save_cache(
                navigation_graph_cache,
                cache_version=cache_version,
            )
            summary["navigationGraphCacheImported"] = True

        for history_path in cls._json_files("map_layout_history"):
            payload = cls._read_json_object(history_path)
            if payload is None:
                continue
            if MainMapLayoutHistoryService.get_history_item_by_filename(history_path.name) is not None:
                continue
            MainMapLayoutHistoryService.create_history_item(
                payload,
                filename=history_path.name,
                created_at=datetime.fromtimestamp(history_path.stat().st_mtime),
            )
            summary["historyImported"] += 1

        for draft_path in cls._json_files("draft_map"):
            payload = cls._read_json_object(draft_path)
            if payload is None:
                continue
            if DraftMainMapLayoutService.get_draft_by_filename(draft_path.name) is not None:
                continue
            DraftMainMapLayoutService.create_draft(
                payload,
                filename=draft_path.name,
                created_at=datetime.fromtimestamp(draft_path.stat().st_mtime),
            )
            summary["draftsImported"] += 1

        if delete_files or os.getenv("INDOOR_NAV_DELETE_LEGACY_JSON", "").strip() == "1":
            legacy_paths: list[Path] = []
            for base_dir in LEGACY_DATA_DIRS:
                if base_dir.exists():
                    legacy_paths.extend(base_dir.rglob("*.json"))
            for path in legacy_paths:
                if path.name == ".gitkeep":
                    continue
                if path.exists() and path.is_file():
                    path.unlink()
                    summary["filesDeleted"] += 1

        return summary
