from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.database import _normalize_navigation_graph_cache_rows


class _FakeCursor:
    def __init__(self, *, current_layout_rows: list[dict], cache_rows: list[dict]):
        self.current_layout_rows = current_layout_rows
        self.cache_rows = cache_rows
        self.executed: list[tuple[str, object]] = []
        self._fetchall_result: list[dict] = []

    def execute(self, sql, params=None):
        compact_sql = " ".join(str(sql).split())
        self.executed.append((compact_sql, params))
        if compact_sql.startswith("SELECT id, is_sandbox FROM map_layouts WHERE is_current = 1"):
            self._fetchall_result = list(self.current_layout_rows)
            return
        if compact_sql.startswith(
            "SELECT id, cache_key, map_layout_id, is_sandbox FROM navigation_graph_caches ORDER BY id ASC"
        ):
            self._fetchall_result = list(self.cache_rows)
            return
        self._fetchall_result = []

    def fetchall(self):
        return self._fetchall_result


def test_normalize_navigation_graph_cache_rows_deletes_duplicate_legacy_current_cache():
    fake_cursor = _FakeCursor(
        current_layout_rows=[{"id": 23, "is_sandbox": 0}],
        cache_rows=[
            {"id": 7, "cache_key": "default", "map_layout_id": None, "is_sandbox": 0},
            {"id": 11, "cache_key": "layout:23", "map_layout_id": 23, "is_sandbox": 0},
        ],
    )

    _normalize_navigation_graph_cache_rows(fake_cursor)

    delete_sql, delete_params = next(
        (sql, params) for sql, params in fake_cursor.executed if sql.startswith("DELETE FROM navigation_graph_caches")
    )
    assert "WHERE id IN (%s)" in delete_sql
    assert delete_params == (7,)
    assert not any(
        sql.startswith("UPDATE navigation_graph_caches SET cache_key = %s WHERE id = %s")
        for sql, _ in fake_cursor.executed
    )


def test_normalize_navigation_graph_cache_rows_uses_temporary_keys_before_swapped_layout_updates():
    fake_cursor = _FakeCursor(
        current_layout_rows=[{"id": 23, "is_sandbox": 0}],
        cache_rows=[
            {"id": 22, "cache_key": "layout:24", "map_layout_id": 23, "is_sandbox": 0},
            {"id": 24, "cache_key": "layout:23", "map_layout_id": 24, "is_sandbox": 0},
        ],
    )

    _normalize_navigation_graph_cache_rows(fake_cursor)

    temp_updates = [
        (sql, params)
        for sql, params in fake_cursor.executed
        if sql.startswith("UPDATE navigation_graph_caches SET cache_key = %s WHERE id = %s")
    ]
    assert temp_updates == [
        ("UPDATE navigation_graph_caches SET cache_key = %s WHERE id = %s", ("__nav_cache_migrating__:22", 22)),
        ("UPDATE navigation_graph_caches SET cache_key = %s WHERE id = %s", ("__nav_cache_migrating__:24", 24)),
    ]

    final_updates = [
        (sql, params)
        for sql, params in fake_cursor.executed
        if sql.startswith("UPDATE navigation_graph_caches SET cache_key = %s, map_layout_id = %s WHERE id = %s")
    ]
    assert final_updates == [
        ("UPDATE navigation_graph_caches SET cache_key = %s, map_layout_id = %s WHERE id = %s", ("layout:23", 23, 22)),
        ("UPDATE navigation_graph_caches SET cache_key = %s, map_layout_id = %s WHERE id = %s", ("layout:24", 24, 24)),
    ]
