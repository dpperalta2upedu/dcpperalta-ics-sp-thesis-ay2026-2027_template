from __future__ import annotations

from datetime import datetime
from typing import Any

from services.database import get_connection
from services.navigation_graph_cache_service import NavigationGraphCacheService
from services.storage_common import deserialize_json
from services.storage_common import dt_to_epoch_ms
from services.storage_common import make_map_layout_history_display_name
from services.storage_common import make_map_layout_history_filename
from services.storage_common import serialize_json


HISTORY_LIMIT = 15


class MainMapLayoutHistoryService:
    IS_SANDBOX = False
    CACHE_SERVICE = NavigationGraphCacheService

    @classmethod
    def _scope_value(cls) -> int:
        return 1 if cls.IS_SANDBOX else 0

    @classmethod
    def _deserialize_json(cls, raw: str) -> dict[str, Any]:
        return deserialize_json(raw)

    @classmethod
    def _serialize_json(cls, payload: dict[str, Any]) -> str:
        return serialize_json(payload)

    @classmethod
    def _make_history_filename(cls, dt: datetime) -> str:
        return make_map_layout_history_filename(dt)

    @classmethod
    def _make_history_display_name(cls, dt: datetime) -> str:
        return make_map_layout_history_display_name(dt)

    @classmethod
    def _row_to_payload(cls, row: dict[str, Any]) -> dict[str, Any]:
        timestamp = row.get("updated_at") or row.get("created_at")
        payload = {
            "id": row["id"],
            "filename": row["filename"],
            "displayName": row.get("display_name"),
            "mtimeMs": dt_to_epoch_ms(timestamp),
            "payload": cls._deserialize_json(row["layout_json"]),
            "layoutVersion": row["layout_version"],
            "sourceDraftId": row["source_draft_id"],
            "isSandbox": bool(row.get("is_sandbox")),
            "isCurrent": bool(row["is_current"]),
            "createdAt": row["created_at"].isoformat() if row.get("created_at") else None,
            "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
        }
        cache_metadata = cls.CACHE_SERVICE.get_cache_metadata_by_layout_id(row["id"])
        if cache_metadata:
            payload.update(cache_metadata)
        return payload

    @classmethod
    def _trim_history(cls, cursor) -> list[str]:
        cursor.execute(
            """
            SELECT id, filename
            FROM map_layouts
            WHERE is_sandbox = %s AND is_current = 0
            ORDER BY created_at DESC, id DESC
            """,
            (cls._scope_value(),),
        )
        rows = cursor.fetchall()
        rows_to_delete = rows[HISTORY_LIMIT:]
        if not rows_to_delete:
            return []

        ids = [row["id"] for row in rows_to_delete]
        placeholders = ", ".join(["%s"] * len(ids))
        for layout_id in ids:
            cls.CACHE_SERVICE.delete_cache_with_cursor(cursor, layout_id=int(layout_id))
        cursor.execute(
            f"""
            DELETE FROM map_layouts
            WHERE is_sandbox = %s AND id IN ({placeholders})
            """,
            [cls._scope_value(), *ids],
        )
        return [str(row["filename"] or row["id"]) for row in rows_to_delete]

    @classmethod
    def list_history(cls) -> list[dict[str, Any]]:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current, created_at, updated_at
                    FROM map_layouts
                    WHERE is_sandbox = %s AND is_current = 0
                    ORDER BY created_at DESC, id DESC
                    """,
                    (cls._scope_value(),),
                )
                rows = cursor.fetchall()
        return [cls._row_to_payload(row) for row in rows]

    @classmethod
    def get_history_item(cls, history_id: int) -> dict[str, Any] | None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current, created_at, updated_at
                    FROM map_layouts
                    WHERE id = %s AND is_sandbox = %s AND is_current = 0
                    LIMIT 1
                    """,
                    (history_id, cls._scope_value()),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return cls._row_to_payload(row)

    @classmethod
    def get_history_item_by_filename(cls, filename: str) -> dict[str, Any] | None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current, created_at, updated_at
                    FROM map_layouts
                    WHERE filename = %s AND is_sandbox = %s AND is_current = 0
                    LIMIT 1
                    """,
                    (filename, cls._scope_value()),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return cls._row_to_payload(row)

    @classmethod
    def create_history_item(
        cls,
        payload: dict[str, Any],
        *,
        filename: str | None = None,
        display_name: str | None = None,
        source_draft_id: int | None = None,
        layout_version: int = 1,
        created_at: datetime | None = None,
    ) -> dict[str, Any]:
        now = created_at or datetime.now()
        filename = filename or cls._make_history_filename(now)
        display_name = display_name or cls._make_history_display_name(now)
        raw_json = cls._serialize_json(payload)
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO map_layouts (
                        filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current, created_at, updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, 0, %s, %s)
                    ON DUPLICATE KEY UPDATE
                      display_name = VALUES(display_name),
                      layout_json = VALUES(layout_json),
                      layout_version = VALUES(layout_version),
                      source_draft_id = VALUES(source_draft_id),
                      updated_at = VALUES(updated_at)
                    """,
                    (filename, display_name, raw_json, layout_version, source_draft_id, cls._scope_value(), now, now),
                )
                cls._trim_history(cursor)
                cursor.execute(
                    """
                    SELECT id, filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current, created_at, updated_at
                    FROM map_layouts
                    WHERE filename = %s AND is_sandbox = %s AND is_current = 0
                    LIMIT 1
                    """,
                    (filename, cls._scope_value()),
                )
                row = cursor.fetchone()
        return cls._row_to_payload(row)

    @classmethod
    def update_history_item(
        cls,
        history_id: int,
        payload: dict[str, Any],
        *,
        filename: str | None = None,
        display_name: str | None = None,
        source_draft_id: int | None = None,
    ) -> dict[str, Any] | None:
        raw_json = cls._serialize_json(payload)
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE map_layouts
                    SET
                      filename = COALESCE(%s, filename),
                      display_name = COALESCE(%s, display_name),
                      source_draft_id = COALESCE(%s, source_draft_id),
                      layout_json = %s,
                      layout_version = layout_version + 1
                    WHERE id = %s AND is_sandbox = %s AND is_current = 0
                    """,
                    (filename, display_name, source_draft_id, raw_json, history_id, cls._scope_value()),
                )
                if cursor.rowcount == 0:
                    return None
                cursor.execute(
                    """
                    SELECT id, filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current, created_at, updated_at
                    FROM map_layouts
                    WHERE id = %s AND is_sandbox = %s
                    LIMIT 1
                    """,
                    (history_id, cls._scope_value()),
                )
                row = cursor.fetchone()
        return cls._row_to_payload(row)

    @classmethod
    def delete_history_item(cls, history_id: int) -> bool:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    DELETE FROM map_layouts
                    WHERE id = %s AND is_sandbox = %s AND is_current = 0
                    """,
                    (history_id, cls._scope_value()),
                )
                if cursor.rowcount > 0:
                    cls.CACHE_SERVICE.delete_cache_with_cursor(cursor, layout_id=history_id)
                return cursor.rowcount > 0
