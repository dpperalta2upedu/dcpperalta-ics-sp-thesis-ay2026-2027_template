from __future__ import annotations

from typing import Any

from services.database import get_connection
from services.storage_common import deserialize_json
from services.storage_common import serialize_json


DEFAULT_CACHE_KEY = "default"


class NavigationGraphCacheService:
    IS_SANDBOX = False

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
    def _row_to_payload(cls, row: dict[str, Any]) -> dict[str, Any]:
        payload = cls._deserialize_json(row["graph_json"])
        payload["cacheId"] = row["id"]
        payload["cacheKey"] = row["cache_key"]
        payload["cache_version"] = row["cache_version"]
        payload["mapLayoutId"] = row.get("map_layout_id")
        payload["isSandbox"] = bool(row.get("is_sandbox"))
        payload["createdAt"] = row["created_at"].isoformat() if row.get("created_at") else None
        payload["updatedAt"] = row["updated_at"].isoformat() if row.get("updated_at") else None
        return payload

    @classmethod
    def get_cache_metadata_by_layout_id(cls, layout_id: int | None) -> dict[str, Any] | None:
        if layout_id is None:
            return None
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, cache_key, map_layout_id, cache_version, is_sandbox, created_at, updated_at
                    FROM navigation_graph_caches
                    WHERE map_layout_id = %s AND is_sandbox = %s
                    LIMIT 1
                    """,
                    (layout_id, cls._scope_value()),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return {
            "routeCacheId": row["id"],
            "routeCacheKey": row["cache_key"],
            "routeCacheVersion": row["cache_version"],
            "routeCacheMapLayoutId": row.get("map_layout_id"),
            "routeCacheCreatedAt": row["created_at"].isoformat() if row.get("created_at") else None,
            "routeCacheUpdatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
        }

    @classmethod
    def load_cache_by_layout_id(cls, layout_id: int | None) -> dict[str, Any] | None:
        if layout_id is None:
            return None
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, cache_key, map_layout_id, graph_json, cache_version, is_sandbox, created_at, updated_at
                    FROM navigation_graph_caches
                    WHERE map_layout_id = %s AND is_sandbox = %s
                    LIMIT 1
                    """,
                    (layout_id, cls._scope_value()),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return cls._row_to_payload(row)

    @classmethod
    def load_cache(
        cls,
        *,
        cache_key: str = DEFAULT_CACHE_KEY,
        layout_id: int | None = None,
    ) -> dict[str, Any] | None:
        if layout_id is not None:
            return cls.load_cache_by_layout_id(layout_id)
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, cache_key, map_layout_id, graph_json, cache_version, is_sandbox, created_at, updated_at
                    FROM navigation_graph_caches
                    WHERE cache_key = %s AND is_sandbox = %s
                    LIMIT 1
                    """,
                    (cache_key, cls._scope_value()),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return cls._row_to_payload(row)

    @classmethod
    def _is_duplicate_key_error(cls, error: Exception) -> bool:
        return bool(getattr(error, "args", None)) and error.args[0] == 1062

    @classmethod
    def _select_rows_for_layout_save(cls, cursor, *, cache_key: str, layout_id: int) -> list[dict[str, Any]]:
        cursor.execute(
            """
            SELECT id, cache_key, map_layout_id
            FROM navigation_graph_caches
            WHERE is_sandbox = %s
              AND (cache_key = %s OR map_layout_id = %s)
            ORDER BY
              CASE
                WHEN map_layout_id = %s THEN 0
                WHEN cache_key = %s THEN 1
                ELSE 2
              END,
              id ASC
            FOR UPDATE
            """,
            (cls._scope_value(), cache_key, layout_id, layout_id, cache_key),
        )
        return list(cursor.fetchall() or [])

    @classmethod
    def _delete_rows_by_id(cls, cursor, row_ids: list[int]) -> None:
        if not row_ids:
            return
        placeholders = ", ".join(["%s"] * len(row_ids))
        cursor.execute(
            f"""
            DELETE FROM navigation_graph_caches
            WHERE id IN ({placeholders}) AND is_sandbox = %s
            """,
            (*row_ids, cls._scope_value()),
        )

    @classmethod
    def _insert_or_update_by_key(
        cls,
        cursor,
        *,
        raw_json: str,
        cache_version: int,
        cache_key: str,
        layout_id: int | None = None,
    ) -> None:
        if layout_id is not None:
            cursor.execute(
                """
                INSERT INTO navigation_graph_caches (cache_key, map_layout_id, graph_json, cache_version, is_sandbox)
                VALUES (%s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                  cache_key = VALUES(cache_key),
                  graph_json = VALUES(graph_json),
                  cache_version = VALUES(cache_version)
                """,
                (cache_key, layout_id, raw_json, cache_version, cls._scope_value()),
            )
            return
        cursor.execute(
            """
            INSERT INTO navigation_graph_caches (cache_key, map_layout_id, graph_json, cache_version, is_sandbox)
            VALUES (%s, NULL, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              graph_json = VALUES(graph_json),
              cache_version = VALUES(cache_version)
            """,
            (cache_key, raw_json, cache_version, cls._scope_value()),
        )

    @classmethod
    def _reconcile_and_update_layout_cache(
        cls,
        cursor,
        *,
        raw_json: str,
        cache_version: int,
        cache_key: str,
        layout_id: int,
    ) -> bool:
        matching_rows = cls._select_rows_for_layout_save(cursor, cache_key=cache_key, layout_id=layout_id)
        if not matching_rows:
            return False
        keep_row = matching_rows[0]
        duplicate_ids = [int(row["id"]) for row in matching_rows[1:] if row.get("id") is not None]
        cls._delete_rows_by_id(cursor, duplicate_ids)
        cursor.execute(
            """
            UPDATE navigation_graph_caches
            SET
              cache_key = %s,
              map_layout_id = %s,
              graph_json = %s,
              cache_version = %s
            WHERE id = %s AND is_sandbox = %s
            """,
            (cache_key, layout_id, raw_json, cache_version, keep_row["id"], cls._scope_value()),
        )
        return True

    @classmethod
    def _save_raw_cache(
        cls,
        cursor,
        *,
        raw_json: str,
        cache_version: int,
        cache_key: str,
        layout_id: int | None = None,
    ) -> None:
        if layout_id is None:
            cls._insert_or_update_by_key(
                cursor,
                raw_json=raw_json,
                cache_version=cache_version,
                cache_key=cache_key,
            )
            return
        if cls._reconcile_and_update_layout_cache(
            cursor,
            raw_json=raw_json,
            cache_version=cache_version,
            cache_key=cache_key,
            layout_id=layout_id,
        ):
            return
        try:
            cls._insert_or_update_by_key(
                cursor,
                raw_json=raw_json,
                cache_version=cache_version,
                cache_key=cache_key,
                layout_id=layout_id,
            )
        except Exception as error:
            if not cls._is_duplicate_key_error(error):
                raise
            if cls._reconcile_and_update_layout_cache(
                cursor,
                raw_json=raw_json,
                cache_version=cache_version,
                cache_key=cache_key,
                layout_id=layout_id,
            ):
                return
            raise

    @classmethod
    def save_cache(
        cls,
        payload: dict[str, Any],
        *,
        cache_version: int,
        cache_key: str = DEFAULT_CACHE_KEY,
        layout_id: int | None = None,
    ) -> None:
        raw_json = cls._serialize_json(payload)
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cls._save_raw_cache(
                    cursor,
                    raw_json=raw_json,
                    cache_version=cache_version,
                    cache_key=cache_key,
                    layout_id=layout_id,
                )

    @classmethod
    def clone_cache(
        cls,
        *,
        source_layout_id: int | None,
        target_layout_id: int | None,
        cache_key: str | None = None,
    ) -> bool:
        if source_layout_id is None or target_layout_id is None:
            return False
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT graph_json, cache_version
                    FROM navigation_graph_caches
                    WHERE map_layout_id = %s AND is_sandbox = %s
                    LIMIT 1
                    """,
                    (source_layout_id, cls._scope_value()),
                )
                source = cursor.fetchone()
                if source is None:
                    return False
                next_cache_key = cache_key or f"layout:{target_layout_id}"
                cls._save_raw_cache(
                    cursor,
                    raw_json=source["graph_json"],
                    cache_version=source["cache_version"],
                    cache_key=next_cache_key,
                    layout_id=target_layout_id,
                )
                return True

    @classmethod
    def delete_cache(
        cls,
        *,
        cache_key: str = DEFAULT_CACHE_KEY,
        layout_id: int | None = None,
    ) -> bool:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                cls.delete_cache_with_cursor(cursor, cache_key=cache_key, layout_id=layout_id)
                return cursor.rowcount > 0

    @classmethod
    def delete_cache_with_cursor(
        cls,
        cursor,
        *,
        cache_key: str = DEFAULT_CACHE_KEY,
        layout_id: int | None = None,
    ) -> None:
        if layout_id is not None:
            cursor.execute(
                """
                DELETE FROM navigation_graph_caches
                WHERE map_layout_id = %s AND is_sandbox = %s
                """,
                (layout_id, cls._scope_value()),
            )
            return
        cursor.execute(
            """
            DELETE FROM navigation_graph_caches
            WHERE cache_key = %s AND is_sandbox = %s
            """,
            (cache_key, cls._scope_value()),
        )
