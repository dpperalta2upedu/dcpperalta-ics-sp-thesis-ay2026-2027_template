from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import sys
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.database import ensure_database_ready
from services.database import get_connection
from services.storage_common import serialize_json


DEFAULT_SOURCE_DIR = REPO_ROOT / "map-layouts-copy"


@dataclass
class ImportSummary:
    current_layout_inserted: bool = False
    current_layout_updated: bool = False
    history_inserted: int = 0
    history_updated: int = 0
    drafts_inserted: int = 0
    drafts_updated: int = 0
    caches_inserted: int = 0
    caches_updated: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "current_layout_inserted": self.current_layout_inserted,
            "current_layout_updated": self.current_layout_updated,
            "history_inserted": self.history_inserted,
            "history_updated": self.history_updated,
            "drafts_inserted": self.drafts_inserted,
            "drafts_updated": self.drafts_updated,
            "caches_inserted": self.caches_inserted,
            "caches_updated": self.caches_updated,
        }


def _read_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return payload


def _json_files(folder: Path) -> list[Path]:
    if not folder.exists():
        return []
    return sorted(
        [item for item in folder.iterdir() if item.is_file() and item.suffix.lower() == ".json"],
        key=lambda item: (item.stat().st_mtime, item.name.lower()),
    )


def _file_timestamp(path: Path) -> datetime:
    return datetime.fromtimestamp(path.stat().st_mtime)


def _cache_key_for_path(path: Path) -> str:
    if path.name == "navigation_graph_cache.json":
        return "default"
    return path.stem


def _upsert_current_layout(cursor, path: Path, summary: ImportSummary) -> None:
    payload = _read_json_object(path)
    raw_json = serialize_json(payload)
    timestamp = _file_timestamp(path)

    cursor.execute(
        """
        SELECT id, layout_json
        FROM map_layouts
        WHERE is_current = 1
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
        """
    )
    existing = cursor.fetchone()

    if existing is None:
        cursor.execute(
            """
            INSERT INTO map_layouts (
                filename, layout_json, layout_version, source_draft_id, is_current, created_at, updated_at
            )
            VALUES (NULL, %s, 1, NULL, 1, %s, %s)
            """,
            (raw_json, timestamp, timestamp),
        )
        summary.current_layout_inserted = True
        return

    changed = str(existing["layout_json"]) != raw_json
    cursor.execute(
        """
        UPDATE map_layouts
        SET
          layout_json = %s,
          updated_at = %s,
          layout_version = CASE
            WHEN layout_json <> %s THEN layout_version + 1
            ELSE layout_version
          END
        WHERE id = %s
        """,
        (raw_json, timestamp, raw_json, existing["id"]),
    )
    summary.current_layout_updated = changed


def _upsert_history(cursor, path: Path) -> bool:
    payload = _read_json_object(path)
    raw_json = serialize_json(payload)
    timestamp = _file_timestamp(path)

    cursor.execute(
        """
        SELECT id
        FROM map_layouts
        WHERE filename = %s AND is_current = 0
        LIMIT 1
        """,
        (path.name,),
    )
    existing = cursor.fetchone()

    cursor.execute(
        """
        INSERT INTO map_layouts (
            filename, layout_json, layout_version, source_draft_id, is_current, created_at, updated_at
        )
        VALUES (%s, %s, 1, NULL, 0, %s, %s)
        ON DUPLICATE KEY UPDATE
          layout_json = VALUES(layout_json),
          updated_at = VALUES(updated_at)
        """,
        (path.name, raw_json, timestamp, timestamp),
    )
    return existing is None


def _trim_history(cursor, limit: int = 15) -> None:
    cursor.execute(
        """
        SELECT id
        FROM map_layouts
        WHERE is_current = 0
        ORDER BY created_at DESC, id DESC
        """
    )
    rows = cursor.fetchall()
    stale_ids = [row["id"] for row in rows[limit:]]
    if not stale_ids:
        return
    placeholders = ", ".join(["%s"] * len(stale_ids))
    cursor.execute(
        f"""
        DELETE FROM map_layouts
        WHERE id IN ({placeholders})
        """,
        stale_ids,
    )


def _upsert_draft(cursor, path: Path) -> bool:
    payload = _read_json_object(path)
    raw_json = serialize_json(payload)
    timestamp = _file_timestamp(path)

    cursor.execute(
        """
        SELECT id
        FROM draft_map_layouts
        WHERE filename = %s
        LIMIT 1
        """,
        (path.name,),
    )
    existing = cursor.fetchone()

    cursor.execute(
        """
        INSERT INTO draft_map_layouts (
            filename, layout_json, layout_version, is_deleted, created_at, updated_at, deleted_at
        )
        VALUES (%s, %s, 1, 0, %s, %s, NULL)
        ON DUPLICATE KEY UPDATE
          layout_json = VALUES(layout_json),
          is_deleted = 0,
          deleted_at = NULL,
          updated_at = VALUES(updated_at)
        """,
        (path.name, raw_json, timestamp, timestamp),
    )
    return existing is None


def _upsert_cache(cursor, path: Path) -> bool:
    payload = _read_json_object(path)
    raw_json = serialize_json(payload)
    cache_version = int(payload.get("cache_version", 0) or 0)
    timestamp = _file_timestamp(path)
    cache_key = _cache_key_for_path(path)

    cursor.execute(
        """
        SELECT cache_key
        FROM navigation_graph_caches
        WHERE cache_key = %s
        LIMIT 1
        """,
        (cache_key,),
    )
    existing = cursor.fetchone()

    cursor.execute(
        """
        INSERT INTO navigation_graph_caches (
            cache_key, graph_json, cache_version, created_at, updated_at
        )
        VALUES (%s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
          graph_json = VALUES(graph_json),
          cache_version = VALUES(cache_version),
          updated_at = VALUES(updated_at)
        """,
        (cache_key, raw_json, cache_version, timestamp, timestamp),
    )
    return existing is None


def import_map_layouts_copy(source_dir: Path) -> ImportSummary:
    source_dir = source_dir.resolve()
    map_layout_path = source_dir / "map_layout.json"
    history_dir = source_dir / "map_layout_history"
    drafts_dir = source_dir / "draft_map"
    cache_files = _json_files(source_dir)

    if not source_dir.exists():
        raise FileNotFoundError(f"Source directory not found: {source_dir}")
    if not map_layout_path.exists():
        raise FileNotFoundError(f"Current map layout JSON not found: {map_layout_path}")

    ensure_database_ready()
    summary = ImportSummary()

    with get_connection() as connection:
        with connection.cursor() as cursor:
            _upsert_current_layout(cursor, map_layout_path, summary)

            for history_path in _json_files(history_dir):
                inserted = _upsert_history(cursor, history_path)
                if inserted:
                    summary.history_inserted += 1
                else:
                    summary.history_updated += 1
            _trim_history(cursor)

            for draft_path in _json_files(drafts_dir):
                inserted = _upsert_draft(cursor, draft_path)
                if inserted:
                    summary.drafts_inserted += 1
                else:
                    summary.drafts_updated += 1

            for cache_path in cache_files:
                if not cache_path.name.startswith("navigation_graph_cache"):
                    continue
                inserted = _upsert_cache(cursor, cache_path)
                if inserted:
                    summary.caches_inserted += 1
                else:
                    summary.caches_updated += 1

    return summary


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Import map-layouts-copy JSON files into the MariaDB persistence tables.",
    )
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=DEFAULT_SOURCE_DIR,
        help="Path to the map-layouts-copy folder.",
    )
    args = parser.parse_args()

    summary = import_map_layouts_copy(args.source_dir)
    print(json.dumps(summary.as_dict(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
