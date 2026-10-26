from __future__ import annotations

from datetime import datetime
from typing import Any

from services.database import get_connection
from services.navigation_graph_cache_service import NavigationGraphCacheService
from services.storage_common import deserialize_json
from services.storage_common import dt_to_epoch_ms
from services.storage_common import make_draft_map_display_name
from services.storage_common import make_draft_filename
from services.storage_common import serialize_json


class DraftMainMapLayoutService:
    IS_SANDBOX = False
    CACHE_SERVICE = NavigationGraphCacheService
    DRAFT_LIMIT: int | None = None

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
    def _make_draft_filename(cls, dt: datetime) -> str:
        return make_draft_filename(dt)

    @classmethod
    def _make_draft_map_display_name(cls, dt: datetime) -> str:
        return make_draft_map_display_name(dt)

    @classmethod
    def _row_to_payload(cls, row: dict[str, Any]) -> dict[str, Any]:
        updated_at = row.get("updated_at") or row.get("created_at")
        payload = {
            "id": row["id"],
            "filename": row["filename"],
            "displayName": row.get("display_name"),
            "mtimeMs": dt_to_epoch_ms(updated_at),
            "payload": cls._deserialize_json(row["layout_json"]),
            "layoutVersion": row["layout_version"],
            "isSandbox": bool(row.get("is_sandbox")),
            "sourceMapLayoutId": row.get("source_map_layout_id"),
            "isDeleted": bool(row["is_deleted"]),
            "createdAt": row["created_at"].isoformat() if row.get("created_at") else None,
            "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
            "deletedAt": row["deleted_at"].isoformat() if row.get("deleted_at") else None,
        }
        source_cache = cls.CACHE_SERVICE.get_cache_metadata_by_layout_id(row.get("source_map_layout_id"))
        payload["sourceRouteCache"] = source_cache
        return payload

    @classmethod
    def list_drafts(cls, *, include_deleted: bool = False) -> list[dict[str, Any]]:
        where_clause = "WHERE is_sandbox = %s" if include_deleted else "WHERE is_sandbox = %s AND is_deleted = 0"
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT id, filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
                    FROM draft_map_layouts
                    {where_clause}
                    ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
                    """,
                    (cls._scope_value(),),
                )
                rows = cursor.fetchall()
        return [cls._row_to_payload(row) for row in rows]

    @classmethod
    def get_draft(cls, draft_id: int) -> dict[str, Any] | None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
                    FROM draft_map_layouts
                    WHERE id = %s AND is_sandbox = %s
                    LIMIT 1
                    """,
                    (draft_id, cls._scope_value()),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return cls._row_to_payload(row)

    @classmethod
    def get_draft_by_filename(cls, filename: str) -> dict[str, Any] | None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
                    FROM draft_map_layouts
                    WHERE filename = %s AND is_sandbox = %s
                    LIMIT 1
                    """,
                    (filename, cls._scope_value()),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return cls._row_to_payload(row)

    @classmethod
    def create_draft(
        cls,
        payload: dict[str, Any],
        *,
        filename: str | None = None,
        display_name: str | None = None,
        source_map_layout_id: int | None = None,
        created_at: datetime | None = None,
    ) -> dict[str, Any]:
        now = created_at or datetime.now()
        filename = filename or cls._make_draft_filename(now)
        display_name = display_name or cls._make_draft_map_display_name(now)
        raw_json = cls._serialize_json(payload)
        trimmed_drafts: list[str] = []
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO draft_map_layouts (
                        filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
                    )
                    VALUES (%s, %s, %s, 1, %s, %s, 0, %s, %s, NULL)
                    ON DUPLICATE KEY UPDATE
                      display_name = VALUES(display_name),
                      source_map_layout_id = COALESCE(VALUES(source_map_layout_id), draft_map_layouts.source_map_layout_id),
                      layout_json = VALUES(layout_json),
                      is_deleted = 0,
                      deleted_at = NULL,
                      updated_at = VALUES(updated_at),
                      layout_version = draft_map_layouts.layout_version + 1
                    """,
                    (filename, display_name, raw_json, cls._scope_value(), source_map_layout_id, now, now),
                )
                trimmed_drafts = cls._trim_drafts(cursor)
                cursor.execute(
                    """
                    SELECT id, filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
                    FROM draft_map_layouts
                    WHERE filename = %s AND is_sandbox = %s
                    LIMIT 1
                    """,
                    (filename, cls._scope_value()),
                )
                row = cursor.fetchone()
        result = cls._row_to_payload(row)
        result["trimmedDrafts"] = trimmed_drafts
        return result

    @classmethod
    def _trim_drafts(cls, cursor) -> list[str]:
        limit = cls.DRAFT_LIMIT
        if limit is None or limit < 1:
            return []

        cursor.execute(
            """
            SELECT id, filename
            FROM draft_map_layouts
            WHERE is_sandbox = %s AND is_deleted = 0
            ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
            """,
            (cls._scope_value(),),
        )
        rows = cursor.fetchall()
        rows_to_delete = rows[limit:]
        if not rows_to_delete:
            return []

        ids = [int(row["id"]) for row in rows_to_delete]
        placeholders = ", ".join(["%s"] * len(ids))
        cursor.execute(
            f"""
            UPDATE draft_map_layouts
            SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
            WHERE is_sandbox = %s AND is_deleted = 0 AND id IN ({placeholders})
            """,
            [cls._scope_value(), *ids],
        )
        return [str(row["filename"]) for row in rows_to_delete if row.get("filename")]

    @classmethod
    def update_draft(
        cls,
        draft_id: int,
        payload: dict[str, Any],
        *,
        filename: str | None = None,
        display_name: str | None = None,
        source_map_layout_id: int | None = None,
    ) -> dict[str, Any] | None:
        raw_json = cls._serialize_json(payload)
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE draft_map_layouts
                    SET
                      filename = COALESCE(%s, filename),
                      display_name = COALESCE(%s, display_name),
                      source_map_layout_id = COALESCE(%s, source_map_layout_id),
                      layout_json = %s,
                      is_deleted = 0,
                      deleted_at = NULL,
                      layout_version = layout_version + 1
                    WHERE id = %s AND is_sandbox = %s
                    """,
                    (filename, display_name, source_map_layout_id, raw_json, draft_id, cls._scope_value()),
                )
                if cursor.rowcount == 0:
                    return None
                cursor.execute(
                    """
                    SELECT id, filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
                    FROM draft_map_layouts
                    WHERE id = %s AND is_sandbox = %s
                    LIMIT 1
                    """,
                    (draft_id, cls._scope_value()),
                )
                row = cursor.fetchone()
        return cls._row_to_payload(row)

    @classmethod
    def delete_draft(cls, *, draft_id: int | None = None, filename: str | None = None) -> dict[str, Any] | None:
        if draft_id is None and not filename:
            raise ValueError("draft_id or filename is required")

        with get_connection() as connection:
            with connection.cursor() as cursor:
                if draft_id is not None:
                    cursor.execute(
                        """
                        UPDATE draft_map_layouts
                        SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
                        WHERE id = %s AND is_sandbox = %s AND is_deleted = 0
                        """,
                        (draft_id, cls._scope_value()),
                    )
                    cursor.execute(
                        """
                        SELECT id, filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
                        FROM draft_map_layouts
                        WHERE id = %s AND is_sandbox = %s
                        LIMIT 1
                        """,
                        (draft_id, cls._scope_value()),
                    )
                else:
                    cursor.execute(
                        """
                        UPDATE draft_map_layouts
                        SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
                        WHERE filename = %s AND is_sandbox = %s AND is_deleted = 0
                        """,
                        (filename, cls._scope_value()),
                    )
                    cursor.execute(
                        """
                        SELECT id, filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
                        FROM draft_map_layouts
                        WHERE filename = %s AND is_sandbox = %s
                        LIMIT 1
                        """,
                        (filename, cls._scope_value()),
                    )
                row = cursor.fetchone()
        if row is None:
            return None
        return cls._row_to_payload(row)
