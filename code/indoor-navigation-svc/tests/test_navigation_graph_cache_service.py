from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import services.navigation_graph_cache_service as cache_service_module
from services.navigation_graph_cache_service import NavigationGraphCacheService


class _DuplicateKeyError(Exception):
    pass


class _FakeCursor:
    def __init__(self, *, select_results: list[list[dict]], raise_duplicate_on_insert: bool = False):
        self.select_results = list(select_results)
        self.raise_duplicate_on_insert = raise_duplicate_on_insert
        self.executed: list[tuple[str, object]] = []
        self._fetchall_result = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        compact_sql = " ".join(str(sql).split())
        self.executed.append((compact_sql, params))
        if compact_sql.startswith("SELECT id, cache_key, map_layout_id FROM navigation_graph_caches"):
            next_rows = self.select_results.pop(0) if self.select_results else []
            self._fetchall_result = next_rows
            return
        self._fetchall_result = None
        if compact_sql.startswith("INSERT INTO navigation_graph_caches") and self.raise_duplicate_on_insert:
            self.raise_duplicate_on_insert = False
            raise _DuplicateKeyError(
                1062,
                "Duplicate entry 'layout:1-0' for key 'uq_navigation_graph_caches_cache_key_is_sandbox'",
            )

    def fetchall(self):
        return self._fetchall_result


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self):
        return self._cursor


def test_save_cache_merges_split_layout_identity_rows(monkeypatch):
    fake_cursor = _FakeCursor(
        select_results=[
            [
                {"id": 22, "cache_key": "stale-key", "map_layout_id": 1},
                {"id": 11, "cache_key": "layout:1", "map_layout_id": None},
            ]
        ]
    )
    monkeypatch.setattr(cache_service_module, "get_connection", lambda: _FakeConnection(fake_cursor))

    NavigationGraphCacheService.save_cache({"nodes": []}, cache_version=9, cache_key="layout:1", layout_id=1)

    assert not any(sql.startswith("INSERT INTO navigation_graph_caches") for sql, _ in fake_cursor.executed)

    delete_sql, delete_params = next(
        (sql, params) for sql, params in fake_cursor.executed if sql.startswith("DELETE FROM navigation_graph_caches")
    )
    assert "WHERE id IN (%s) AND is_sandbox = %s" in delete_sql
    assert delete_params == (11, 0)

    update_sql, update_params = next(
        (sql, params) for sql, params in fake_cursor.executed if sql.startswith("UPDATE navigation_graph_caches")
    )
    assert "SET cache_key = %s, map_layout_id = %s, graph_json = %s, cache_version = %s" in update_sql
    assert update_params[0] == "layout:1"
    assert update_params[1] == 1
    assert update_params[4] == 22
    assert update_params[5] == 0


def test_save_cache_retries_after_duplicate_insert_and_reconciles_rows(monkeypatch):
    fake_cursor = _FakeCursor(
        select_results=[
            [],
            [
                {"id": 22, "cache_key": "stale-key", "map_layout_id": 1},
                {"id": 11, "cache_key": "layout:1", "map_layout_id": None},
            ],
        ],
        raise_duplicate_on_insert=True,
    )
    monkeypatch.setattr(cache_service_module, "get_connection", lambda: _FakeConnection(fake_cursor))

    NavigationGraphCacheService.save_cache({"nodes": []}, cache_version=9, cache_key="layout:1", layout_id=1)

    insert_calls = [sql for sql, _ in fake_cursor.executed if sql.startswith("INSERT INTO navigation_graph_caches")]
    assert len(insert_calls) == 1
    assert any(sql.startswith("DELETE FROM navigation_graph_caches") for sql, _ in fake_cursor.executed)
    assert any(sql.startswith("UPDATE navigation_graph_caches") for sql, _ in fake_cursor.executed)
