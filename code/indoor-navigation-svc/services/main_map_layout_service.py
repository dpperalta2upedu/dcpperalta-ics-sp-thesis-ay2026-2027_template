from __future__ import annotations

from datetime import datetime
from typing import Any

from services.database import get_connection
from services.navigation_graph_cache_service import NavigationGraphCacheService
from services.storage_common import default_current_map_layout_display_name
from services.storage_common import deserialize_json
from services.storage_common import make_map_layout_history_display_name
from services.storage_common import make_map_layout_history_filename
from services.storage_common import serialize_json


HISTORY_LIMIT = 15


class MainMapLayoutService:
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
    def _default_current_display_name(cls) -> str:
        return default_current_map_layout_display_name()

    @classmethod
    def _current_filename(cls) -> str:
        return "map_layout.json"

    @classmethod
    def _make_history_filename(cls, dt: datetime) -> str:
        return make_map_layout_history_filename(dt)

    @classmethod
    def _make_history_display_name(cls, dt: datetime) -> str:
        return make_map_layout_history_display_name(dt)

    @classmethod
    def _row_to_payload(cls, row: dict[str, Any]) -> dict[str, Any]:
        payload = {
            "id": row["id"],
            "filename": row.get("filename"),
            "displayName": row.get("display_name"),
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
    def _select_current_row(cls, cursor) -> dict[str, Any] | None:
        cursor.execute(
            """
            SELECT id, filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current, created_at, updated_at
            FROM map_layouts
            WHERE is_sandbox = %s AND is_current = 1
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            """,
            (cls._scope_value(),),
        )
        return cursor.fetchone()

    @classmethod
    def _select_row_by_id(cls, cursor, layout_id: int) -> dict[str, Any] | None:
        cursor.execute(
            """
            SELECT id, filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current, created_at, updated_at
            FROM map_layouts
            WHERE id = %s AND is_sandbox = %s
            LIMIT 1
            """,
            (layout_id, cls._scope_value()),
        )
        return cursor.fetchone()

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
    def get_current_record(cls) -> dict[str, Any] | None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                row = cls._select_current_row(cursor)
        if row is None:
            return None
        return cls._row_to_payload(row)

    @classmethod
    def get_record_by_id(cls, layout_id: int) -> dict[str, Any] | None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                row = cls._select_row_by_id(cursor, layout_id)
        if row is None:
            return None
        return cls._row_to_payload(row)

    @classmethod
    def get_current_layout(cls) -> dict[str, Any]:
        record = cls.get_current_record()
        if record is None:
            raise FileNotFoundError("Main map layout not found in the database.")
        return record["payload"]

    @classmethod
    def get_cache_token(cls) -> int | None:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                row = cls._select_current_row(cursor)
        if row is None:
            return None
        return int(row["layout_version"])

    @classmethod
    def create_layout(
        cls,
        payload: dict[str, Any],
        *,
        source_draft_id: int | None = None,
        display_name: str | None = None,
    ) -> dict[str, Any]:
        raw_json = cls._serialize_json(payload)
        next_display_name = display_name or cls._default_current_display_name()
        with get_connection() as connection:
            with connection.cursor() as cursor:
                existing = cls._select_current_row(cursor)
                if existing is not None:
                    raise ValueError("Main map layout already exists.")
                cursor.execute(
                    """
                    INSERT INTO map_layouts (
                        filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current
                    )
                    VALUES (%s, %s, %s, 1, %s, %s, 1)
                    """,
                    (cls._current_filename(), next_display_name, raw_json, source_draft_id, cls._scope_value()),
                )
                row = cls._select_current_row(cursor)
        return cls._row_to_payload(row)

    @classmethod
    def upsert_layout(
        cls,
        payload: dict[str, Any],
        *,
        source_draft_id: int | None = None,
        display_name: str | None = None,
    ) -> dict[str, Any]:
        raw_json = cls._serialize_json(payload)
        with get_connection() as connection:
            with connection.cursor() as cursor:
                current_row = cls._select_current_row(cursor)
                if current_row is None:
                    next_display_name = display_name or cls._default_current_display_name()
                    cursor.execute(
                        """
                        INSERT INTO map_layouts (
                            filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current
                        )
                        VALUES (%s, %s, %s, 1, %s, %s, 1)
                        """,
                        (cls._current_filename(), next_display_name, raw_json, source_draft_id, cls._scope_value()),
                    )
                else:
                    next_display_name = display_name or str(
                        current_row.get("display_name") or cls._default_current_display_name()
                    )
                    cursor.execute(
                        """
                        UPDATE map_layouts
                        SET
                          filename = %s,
                          display_name = %s,
                          layout_json = %s,
                          source_draft_id = %s,
                          layout_version = layout_version + 1
                        WHERE id = %s AND is_sandbox = %s
                        """,
                        (
                            cls._current_filename(),
                            next_display_name,
                            raw_json,
                            source_draft_id,
                            current_row["id"],
                            cls._scope_value(),
                        ),
                    )
                row = cls._select_current_row(cursor)
        return cls._row_to_payload(row)

    @classmethod
    def delete_layout(cls) -> bool:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                current_row = cls._select_current_row(cursor)
                cursor.execute(
                    """
                    DELETE FROM map_layouts
                    WHERE is_sandbox = %s AND is_current = 1
                    """,
                    (cls._scope_value(),),
                )
                if cursor.rowcount > 0 and current_row is not None:
                    cls.CACHE_SERVICE.delete_cache_with_cursor(cursor, layout_id=int(current_row["id"]))
                return cursor.rowcount > 0

    @classmethod
    def publish_layout(
        cls,
        payload: dict[str, Any],
        *,
        source_draft_id: int | None = None,
        draft_filename: str | None = None,
        display_name: str | None = None,
        source_map_layout_id: int | None = None,
    ) -> dict[str, Any]:
        raw_json = cls._serialize_json(payload)
        now = datetime.now()
        history_filename = cls._make_history_filename(now)
        history_display_name = cls._make_history_display_name(now)
        current_display_name = display_name or cls._default_current_display_name()
        deleted_draft = ""
        history_record: dict[str, Any] | None = None
        trimmed_history: list[str] = []

        with get_connection() as connection:
            with connection.cursor() as cursor:
                current_row = cls._select_current_row(cursor)

                if source_draft_id is None and draft_filename:
                    cursor.execute(
                        """
                        SELECT id, source_map_layout_id
                        FROM draft_map_layouts
                        WHERE filename = %s AND is_sandbox = %s
                        LIMIT 1
                        """,
                        (draft_filename, cls._scope_value()),
                    )
                    draft_row = cursor.fetchone()
                    if draft_row is not None:
                        source_draft_id = int(draft_row["id"])
                        if source_map_layout_id is None and draft_row.get("source_map_layout_id") is not None:
                            source_map_layout_id = int(draft_row["source_map_layout_id"])
                elif source_draft_id is not None and source_map_layout_id is None:
                    cursor.execute(
                        """
                        SELECT source_map_layout_id
                        FROM draft_map_layouts
                        WHERE id = %s AND is_sandbox = %s
                        LIMIT 1
                        """,
                        (source_draft_id, cls._scope_value()),
                    )
                    draft_row = cursor.fetchone()
                    if draft_row is not None and draft_row.get("source_map_layout_id") is not None:
                        source_map_layout_id = int(draft_row["source_map_layout_id"])

                next_layout_version = 1
                if current_row is not None:
                    next_layout_version = int(current_row["layout_version"]) + 1
                    current_filename = str(current_row.get("filename") or "").strip()
                    if current_filename and current_filename != cls._current_filename():
                        history_filename = current_filename
                    current_row_display_name = str(current_row.get("display_name") or "").strip()
                    if current_row_display_name and current_row_display_name != cls._default_current_display_name():
                        history_display_name = current_row_display_name
                    cursor.execute(
                        """
                        UPDATE map_layouts
                        SET
                          filename = %s,
                          display_name = %s,
                          is_current = 0,
                          source_draft_id = COALESCE(%s, source_draft_id)
                        WHERE id = %s AND is_sandbox = %s
                        """,
                        (history_filename, history_display_name, source_draft_id, current_row["id"], cls._scope_value()),
                    )
                    updated_history_row = cls._select_row_by_id(cursor, int(current_row["id"]))
                    if updated_history_row is not None:
                        history_record = cls._row_to_payload(updated_history_row)

                cursor.execute(
                    """
                    INSERT INTO map_layouts (
                        filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, 1)
                    """,
                    (
                        cls._current_filename(),
                        current_display_name,
                        raw_json,
                        next_layout_version,
                        source_draft_id,
                        cls._scope_value(),
                    ),
                )

                if source_draft_id is not None:
                    cursor.execute(
                        """
                        UPDATE draft_map_layouts
                        SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
                        WHERE id = %s AND is_sandbox = %s AND is_deleted = 0
                        """,
                        (source_draft_id, cls._scope_value()),
                    )
                    cursor.execute(
                        """
                        SELECT filename
                        FROM draft_map_layouts
                        WHERE id = %s AND is_sandbox = %s
                        LIMIT 1
                        """,
                        (source_draft_id, cls._scope_value()),
                    )
                    deleted_row = cursor.fetchone()
                    if deleted_row is not None:
                        deleted_draft = str(deleted_row["filename"])
                elif draft_filename:
                    cursor.execute(
                        """
                        UPDATE draft_map_layouts
                        SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
                        WHERE filename = %s AND is_sandbox = %s AND is_deleted = 0
                        """,
                        (draft_filename, cls._scope_value()),
                    )
                    if cursor.rowcount > 0:
                        deleted_draft = draft_filename

                trimmed_history = cls._trim_history(cursor)
                row = cls._select_current_row(cursor)

        return {
            "current": cls._row_to_payload(row),
            "history": history_record,
            "deletedDraft": deleted_draft,
            "trimmedHistory": trimmed_history,
            "sourceMapLayoutId": source_map_layout_id,
        }
