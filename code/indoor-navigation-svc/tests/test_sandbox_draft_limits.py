from __future__ import annotations

from datetime import datetime
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sandbox.sb_router import save_sandbox_draft_map
from sandbox.services.sb_draft_main_map_layout_service import SandboxDraftMainMapLayoutService
import services.draft_main_map_layout_service as draft_service_module


class _DummyCacheService:
    @staticmethod
    def get_cache_metadata_by_layout_id(_layout_id):
        return None


class _FakeCursor:
    def __init__(self, *, trim_rows: list[dict], saved_row: dict):
        self.trim_rows = trim_rows
        self.saved_row = saved_row
        self.executed: list[tuple[str, object]] = []
        self._fetchall_result = None
        self._fetchone_result = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        compact_sql = " ".join(str(sql).split())
        if compact_sql.startswith("SELECT id, filename FROM draft_map_layouts"):
            self._fetchall_result = self.trim_rows
            self._fetchone_result = None
            return
        if "SELECT id, filename, display_name, layout_json" in compact_sql and "WHERE filename = %s" in compact_sql:
            self._fetchone_result = self.saved_row
            self._fetchall_result = None
            return
        self._fetchall_result = None
        self._fetchone_result = None

    def fetchall(self):
        return self._fetchall_result

    def fetchone(self):
        return self._fetchone_result


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self):
        return self._cursor


def test_sandbox_create_draft_trims_oldest_entries_to_limit(monkeypatch):
    now = datetime(2026, 4, 14, 12, 0, 0)
    saved_row = {
        "id": 99,
        "filename": "sandbox-draft-new.json",
        "display_name": "Sandbox Draft New",
        "layout_json": "{}",
        "layout_version": 1,
        "is_sandbox": 1,
        "source_map_layout_id": None,
        "is_deleted": 0,
        "created_at": now,
        "updated_at": now,
        "deleted_at": None,
    }
    trim_rows = [{"id": index, "filename": f"sandbox-draft-{index:02d}.json"} for index in range(1, 19)]
    fake_cursor = _FakeCursor(trim_rows=trim_rows, saved_row=saved_row)

    monkeypatch.setattr(draft_service_module, "get_connection", lambda: _FakeConnection(fake_cursor))
    monkeypatch.setattr(SandboxDraftMainMapLayoutService, "CACHE_SERVICE", _DummyCacheService)

    item = SandboxDraftMainMapLayoutService.create_draft({"draftId": "Sandbox Draft New"})

    assert item["filename"] == "sandbox-draft-new.json"
    assert item["trimmedDrafts"] == [
        "sandbox-draft-16.json",
        "sandbox-draft-17.json",
        "sandbox-draft-18.json",
    ]
    trim_update = next(
        sql for sql, _params in fake_cursor.executed if "SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP" in sql
    )
    assert "id IN (%s, %s, %s)" in trim_update


def test_save_sandbox_draft_map_returns_trimmed_deleted_entries(monkeypatch):
    monkeypatch.setattr(
        SandboxDraftMainMapLayoutService,
        "create_draft",
        classmethod(
            lambda cls, draft, **kwargs: {
                "filename": "sandbox-draft-new.json",
                "displayName": "Sandbox Draft New",
                "trimmedDrafts": ["sandbox-draft-01.json"],
            }
        ),
    )

    response = save_sandbox_draft_map({"draft": {"draftId": "Sandbox Draft New"}, "displayName": "Sandbox Draft New"})

    assert response["ok"] is True
    assert response["filename"] == "sandbox-draft-new.json"
    assert response["deleted"] == ["sandbox-draft-01.json"]
