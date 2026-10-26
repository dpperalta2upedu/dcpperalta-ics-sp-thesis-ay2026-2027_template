from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import importlib
from pathlib import Path
import site
import sys
from typing import Any
import os
from dotenv import load_dotenv

# Explicitly load the .env file
load_dotenv()

try:
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:  # pragma: no cover - handled at runtime with a clear error message.
    pymysql = None
    DictCursor = None


SCHEMA_SQL_PATH = Path(__file__).resolve().parent.parent / "sql" / "indoor_navigation_db.sql"
DEFAULT_DB_APP_USER = "indoor_nav_app"


@dataclass(frozen=True)
class DatabaseSettings:
    host: str
    port: int
    user: str
    password: str
    database: str
    charset: str = "utf8mb4"


def get_database_settings() -> DatabaseSettings:
    password = os.getenv("INDOOR_NAV_DB_PASSWORD", "").strip()
    if not password:
        raise RuntimeError("INDOOR_NAV_DB_PASSWORD must be set.")
    return DatabaseSettings(
        host=os.getenv("INDOOR_NAV_DB_HOST", "127.0.0.1"),
        port=int(os.getenv("INDOOR_NAV_DB_PORT", "3306")),
        user=os.getenv("INDOOR_NAV_DB_USER", DEFAULT_DB_APP_USER),
        password=password,
        database=os.getenv("INDOOR_NAV_DB_NAME", "indoor_navigation_db"),
    )


def get_database_bootstrap_settings() -> DatabaseSettings | None:
    user = os.getenv("INDOOR_NAV_DB_BOOTSTRAP_USER")
    password = os.getenv("INDOOR_NAV_DB_BOOTSTRAP_PASSWORD")

    if user is None and password is None:
        return None
    if user is None or password is None:
        raise RuntimeError(
            "INDOOR_NAV_DB_BOOTSTRAP_USER and INDOOR_NAV_DB_BOOTSTRAP_PASSWORD must be set together."
        )

    return DatabaseSettings(
        host=os.getenv("INDOOR_NAV_DB_BOOTSTRAP_HOST", os.getenv("INDOOR_NAV_DB_HOST", "127.0.0.1")),
        port=int(os.getenv("INDOOR_NAV_DB_BOOTSTRAP_PORT", os.getenv("INDOOR_NAV_DB_PORT", "3306"))),
        user=user,
        password=password,
        database=os.getenv("INDOOR_NAV_DB_NAME", "indoor_navigation_db"),
    )


def _require_driver() -> None:
    global pymysql
    global DictCursor
    if pymysql is None:
        _try_load_driver()
    if pymysql is None:
        raise RuntimeError(
            "PyMySQL is required for MariaDB access. Install requirements.txt before starting the service."
        )


def _candidate_site_packages() -> list[Path]:
    version_tag = f"Python{sys.version_info.major}{sys.version_info.minor}"
    candidates: list[Path] = []

    for raw_path in site.getsitepackages():
        candidates.append(Path(raw_path))

    try:
        candidates.append(Path(site.getusersitepackages()))
    except Exception:
        pass

    appdata = os.getenv("APPDATA", "").strip()
    if appdata:
        candidates.append(Path(appdata) / "Python" / version_tag / "site-packages")

    localappdata = os.getenv("LOCALAPPDATA", "").strip()
    if localappdata:
        candidates.append(
            Path(localappdata)
            / "Packages"
            / "PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0"
            / "LocalCache"
            / "local-packages"
            / version_tag
            / "site-packages"
        )

    ordered: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(candidate)
    return ordered


def _try_load_driver() -> None:
    global pymysql
    global DictCursor

    try:
        pymysql = importlib.import_module("pymysql")
        DictCursor = importlib.import_module("pymysql.cursors").DictCursor
        return
    except ImportError:
        pass

    for candidate in _candidate_site_packages():
        if not candidate.exists():
            continue
        candidate_text = str(candidate)
        if candidate_text not in sys.path:
            sys.path.append(candidate_text)
        try:
            pymysql = importlib.import_module("pymysql")
            DictCursor = importlib.import_module("pymysql.cursors").DictCursor
            return
        except ImportError:
            continue


def _connection_kwargs(*, include_database: bool, settings: DatabaseSettings | None = None) -> dict[str, Any]:
    settings = settings or get_database_settings()
    kwargs: dict[str, Any] = {
        "host": settings.host,
        "port": settings.port,
        "user": settings.user,
        "password": settings.password,
        "charset": settings.charset,
        "cursorclass": DictCursor,
        "autocommit": False,
    }
    if include_database:
        kwargs["database"] = settings.database
    return kwargs


@contextmanager
def get_connection(*, include_database: bool = True, settings: DatabaseSettings | None = None):
    _require_driver()
    connection = pymysql.connect(**_connection_kwargs(include_database=include_database, settings=settings))
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _read_sql_statements(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    statements: list[str] = []
    current: list[str] = []
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("--"):
            continue
        current.append(raw_line)
        if stripped.endswith(";"):
            statement = "\n".join(current).strip()
            if statement.endswith(";"):
                statement = statement[:-1]
            if statement:
                statements.append(statement)
            current = []

    tail = "\n".join(current).strip()
    if tail:
        statements.append(tail)
    return statements


def _table_exists(cursor, table_name: str) -> bool:
    cursor.execute("SHOW TABLES LIKE %s", (table_name,))
    return cursor.fetchone() is not None


def _column_exists(cursor, table_name: str, column_name: str) -> bool:
    cursor.execute(f"SHOW COLUMNS FROM `{table_name}` LIKE %s", (column_name,))
    return cursor.fetchone() is not None


def _index_exists(cursor, table_name: str, index_name: str) -> bool:
    cursor.execute(f"SHOW INDEX FROM `{table_name}` WHERE Key_name = %s", (index_name,))
    return cursor.fetchone() is not None


def _migrate_map_layout_tables(cursor) -> None:
    if not _table_exists(cursor, "map_layouts"):
        return

    has_main_table = _table_exists(cursor, "main_map_layout")
    has_history_table = _table_exists(cursor, "map_layout_history")
    if not has_main_table and not has_history_table:
        return

    cursor.execute("SELECT COUNT(*) AS row_count FROM map_layouts")
    map_layouts_count = int(cursor.fetchone()["row_count"])

    if map_layouts_count == 0 and has_history_table:
        cursor.execute(
            """
            INSERT INTO map_layouts (
                filename, layout_json, layout_version, source_draft_id, is_current, created_at, updated_at
            )
            SELECT
                filename,
                layout_json,
                layout_version,
                source_draft_id,
                0,
                created_at,
                created_at
            FROM map_layout_history
            ORDER BY created_at ASC, id ASC
            """
        )

    if map_layouts_count == 0 and has_main_table:
        cursor.execute(
            """
            INSERT INTO map_layouts (
                filename, layout_json, layout_version, source_draft_id, is_current, created_at, updated_at
            )
            SELECT
                NULL,
                layout_json,
                layout_version,
                source_draft_id,
                1,
                created_at,
                updated_at
            FROM main_map_layout
            """
        )
    elif has_main_table:
        cursor.execute("SELECT COUNT(*) AS current_count FROM map_layouts WHERE is_current = 1")
        current_count = int(cursor.fetchone()["current_count"])
        if current_count == 0:
            cursor.execute(
                """
                INSERT INTO map_layouts (
                    filename, layout_json, layout_version, source_draft_id, is_current, created_at, updated_at
                )
                SELECT
                    NULL,
                    layout_json,
                    layout_version,
                    source_draft_id,
                    1,
                    created_at,
                    updated_at
                FROM main_map_layout
                """
            )

    cursor.execute(
        """
        SELECT id
        FROM map_layouts
        WHERE is_current = 0
        ORDER BY created_at DESC, id DESC
        """
    )
    history_rows = cursor.fetchall()
    stale_history_ids = [row["id"] for row in history_rows[15:]]
    if stale_history_ids:
        placeholders = ", ".join(["%s"] * len(stale_history_ids))
        cursor.execute(
            f"""
            DELETE FROM map_layouts
            WHERE id IN ({placeholders})
            """,
            stale_history_ids,
        )

    if has_main_table:
        cursor.execute("DROP TABLE main_map_layout")
    if has_history_table:
        cursor.execute("DROP TABLE map_layout_history")


def _ensure_map_layout_display_name_column(cursor) -> None:
    if not _table_exists(cursor, "map_layouts"):
        return

    if not _column_exists(cursor, "map_layouts", "is_sandbox"):
        cursor.execute(
            """
            ALTER TABLE map_layouts
            ADD COLUMN is_sandbox TINYINT(1) NOT NULL DEFAULT 0 AFTER layout_version
            """
        )

    if not _column_exists(cursor, "map_layouts", "display_name"):
        cursor.execute(
            """
            ALTER TABLE map_layouts
            ADD COLUMN display_name VARCHAR(255) NULL AFTER filename
            """
        )

    if _index_exists(cursor, "map_layouts", "uq_map_layouts_filename"):
        cursor.execute("ALTER TABLE map_layouts DROP INDEX uq_map_layouts_filename")

    if not _index_exists(cursor, "map_layouts", "uq_map_layouts_filename_is_sandbox"):
        cursor.execute(
            """
            ALTER TABLE map_layouts
            ADD UNIQUE KEY uq_map_layouts_filename_is_sandbox (filename, is_sandbox)
            """
        )

    if _index_exists(cursor, "map_layouts", "idx_map_layouts_is_current_updated_at"):
        cursor.execute("ALTER TABLE map_layouts DROP INDEX idx_map_layouts_is_current_updated_at")
    if not _index_exists(cursor, "map_layouts", "idx_map_layouts_scope_current_updated_at"):
        cursor.execute(
            """
            ALTER TABLE map_layouts
            ADD KEY idx_map_layouts_scope_current_updated_at (is_sandbox, is_current, updated_at)
            """
        )

    if _index_exists(cursor, "map_layouts", "idx_map_layouts_created_at"):
        cursor.execute("ALTER TABLE map_layouts DROP INDEX idx_map_layouts_created_at")
    if not _index_exists(cursor, "map_layouts", "idx_map_layouts_scope_created_at"):
        cursor.execute(
            """
            ALTER TABLE map_layouts
            ADD KEY idx_map_layouts_scope_created_at (is_sandbox, created_at)
            """
        )

    if _index_exists(cursor, "map_layouts", "idx_map_layouts_source_draft_id"):
        cursor.execute("ALTER TABLE map_layouts DROP INDEX idx_map_layouts_source_draft_id")
    if not _index_exists(cursor, "map_layouts", "idx_map_layouts_scope_source_draft_id"):
        cursor.execute(
            """
            ALTER TABLE map_layouts
            ADD KEY idx_map_layouts_scope_source_draft_id (is_sandbox, source_draft_id)
            """
        )

    cursor.execute(
        """
        UPDATE map_layouts
        SET display_name = CASE
            WHEN is_sandbox = 1 AND is_current = 1 THEN 'Current Sandbox Layout'
            WHEN is_sandbox = 1 THEN CONCAT(
                'Sandbox Layout - ',
                DATE_FORMAT(COALESCE(updated_at, created_at, CURRENT_TIMESTAMP), '%d-%b-%Y %h:%i:%s %p')
            )
            WHEN is_current = 1 THEN 'Current Main Layout'
            ELSE CONCAT(
                'Main Layout - ',
                DATE_FORMAT(COALESCE(updated_at, created_at, CURRENT_TIMESTAMP), '%d-%b-%Y %h:%i:%s %p')
            )
        END
        WHERE display_name IS NULL OR TRIM(display_name) = ''
        """
    )

    cursor.execute(
        """
        UPDATE map_layouts
        SET filename = CASE
            WHEN is_sandbox = 1 THEN 'sandbox_map_layout.json'
            ELSE 'map_layout.json'
        END
        WHERE is_current = 1
          AND (
            filename IS NULL
            OR TRIM(filename) = ''
            OR (is_sandbox = 0 AND filename <> 'map_layout.json')
            OR (is_sandbox = 1 AND filename <> 'sandbox_map_layout.json')
          )
        """
    )


def _ensure_draft_map_layout_display_name_column(cursor) -> None:
    if not _table_exists(cursor, "draft_map_layouts"):
        return

    if not _column_exists(cursor, "draft_map_layouts", "is_sandbox"):
        cursor.execute(
            """
            ALTER TABLE draft_map_layouts
            ADD COLUMN is_sandbox TINYINT(1) NOT NULL DEFAULT 0 AFTER layout_version
            """
        )

    if not _column_exists(cursor, "draft_map_layouts", "display_name"):
        cursor.execute(
            """
            ALTER TABLE draft_map_layouts
            ADD COLUMN display_name VARCHAR(255) NULL AFTER filename
            """
        )

    if not _column_exists(cursor, "draft_map_layouts", "source_map_layout_id"):
        cursor.execute(
            """
            ALTER TABLE draft_map_layouts
            ADD COLUMN source_map_layout_id BIGINT UNSIGNED NULL AFTER is_sandbox
            """
        )

    if _index_exists(cursor, "draft_map_layouts", "uq_draft_map_layouts_filename"):
        cursor.execute("ALTER TABLE draft_map_layouts DROP INDEX uq_draft_map_layouts_filename")

    if not _index_exists(cursor, "draft_map_layouts", "uq_draft_map_layouts_filename_is_sandbox"):
        cursor.execute(
            """
            ALTER TABLE draft_map_layouts
            ADD UNIQUE KEY uq_draft_map_layouts_filename_is_sandbox (filename, is_sandbox)
            """
        )

    if not _index_exists(cursor, "draft_map_layouts", "idx_draft_map_layouts_is_sandbox_created_at"):
        cursor.execute(
            """
            ALTER TABLE draft_map_layouts
            ADD KEY idx_draft_map_layouts_is_sandbox_created_at (is_sandbox, created_at)
            """
        )

    if not _index_exists(cursor, "draft_map_layouts", "idx_draft_map_layouts_is_sandbox_deleted_created_at"):
        cursor.execute(
            """
            ALTER TABLE draft_map_layouts
            ADD KEY idx_draft_map_layouts_is_sandbox_deleted_created_at (is_sandbox, is_deleted, created_at)
            """
        )

    if not _index_exists(cursor, "draft_map_layouts", "idx_draft_map_layouts_scope_source_map_layout_id"):
        cursor.execute(
            """
            ALTER TABLE draft_map_layouts
            ADD KEY idx_draft_map_layouts_scope_source_map_layout_id (is_sandbox, source_map_layout_id)
            """
        )

    cursor.execute(
        """
        UPDATE draft_map_layouts
        SET display_name = CASE
            WHEN is_sandbox = 1 THEN CONCAT(
                'Sandbox Draft - ',
                DATE_FORMAT(COALESCE(updated_at, created_at, CURRENT_TIMESTAMP), '%d-%b-%Y %h:%i:%s %p')
            )
            ELSE CONCAT(
                'Draft Map - ',
                DATE_FORMAT(COALESCE(updated_at, created_at, CURRENT_TIMESTAMP), '%d-%b-%Y %h:%i:%s %p')
            )
        END
        WHERE display_name IS NULL OR TRIM(display_name) = ''
        """
    )


def _merge_sandbox_draft_map_layouts(cursor) -> None:
    if not _table_exists(cursor, "draft_map_layouts") or not _table_exists(cursor, "sandbox_draft_map_layouts"):
        return

    sandbox_has_source_map_layout_id = _column_exists(cursor, "sandbox_draft_map_layouts", "source_map_layout_id")

    cursor.execute(
        (
            """
            INSERT INTO draft_map_layouts (
                filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
            )
            SELECT
                source.filename,
                source.display_name,
                source.layout_json,
                source.layout_version,
                1,
                source.source_map_layout_id,
                source.is_deleted,
                source.created_at,
                source.updated_at,
                source.deleted_at
            FROM sandbox_draft_map_layouts source
            LEFT JOIN draft_map_layouts target
              ON target.filename = source.filename
             AND target.is_sandbox = 1
            WHERE target.id IS NULL
            """
            if sandbox_has_source_map_layout_id
            else
            """
            INSERT INTO draft_map_layouts (
                filename, display_name, layout_json, layout_version, is_sandbox, source_map_layout_id, is_deleted, created_at, updated_at, deleted_at
            )
            SELECT
                source.filename,
                source.display_name,
                source.layout_json,
                source.layout_version,
                1,
                NULL,
                source.is_deleted,
                source.created_at,
                source.updated_at,
                source.deleted_at
            FROM sandbox_draft_map_layouts source
            LEFT JOIN draft_map_layouts target
              ON target.filename = source.filename
             AND target.is_sandbox = 1
            WHERE target.id IS NULL
            """
        )
    )

    if _table_exists(cursor, "sandbox_map_layouts"):
        cursor.execute(
            """
            UPDATE sandbox_map_layouts layouts
            INNER JOIN sandbox_draft_map_layouts source
              ON layouts.source_draft_id = source.id
            INNER JOIN draft_map_layouts target
              ON target.filename = source.filename
             AND target.is_sandbox = 1
            SET layouts.source_draft_id = target.id
            WHERE layouts.source_draft_id IS NOT NULL
            """
        )

    cursor.execute("DROP TABLE sandbox_draft_map_layouts")


def _merge_sandbox_map_layouts(cursor) -> None:
    if not _table_exists(cursor, "map_layouts") or not _table_exists(cursor, "sandbox_map_layouts"):
        return

    cursor.execute(
        """
        INSERT INTO map_layouts (
            filename, display_name, layout_json, layout_version, source_draft_id, is_sandbox, is_current, created_at, updated_at
        )
        SELECT
            source.filename,
            source.display_name,
            source.layout_json,
            source.layout_version,
            source.source_draft_id,
            1,
            source.is_current,
            source.created_at,
            source.updated_at
        FROM sandbox_map_layouts source
        LEFT JOIN map_layouts target
          ON target.is_sandbox = 1
         AND (
              (target.filename = source.filename)
              OR (
                  target.filename IS NULL
                  AND source.filename IS NULL
                  AND target.is_current = source.is_current
              )
         )
        WHERE target.id IS NULL
        """
    )

    cursor.execute("DROP TABLE sandbox_map_layouts")


_NAVIGATION_GRAPH_CACHE_LEGACY_KEYS = {"default", "sandbox-default"}
_NAVIGATION_GRAPH_CACHE_TEMP_PREFIX = "__nav_cache_migrating__:"


def _coerce_optional_db_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _resolve_navigation_graph_cache_target(
    row: dict[str, Any],
    *,
    current_layout_id_by_scope: dict[int, int],
) -> tuple[int | None, str]:
    scope = int(row.get("is_sandbox") or 0)
    cache_key = str(row.get("cache_key") or "")
    map_layout_id = _coerce_optional_db_int(row.get("map_layout_id"))

    if map_layout_id is not None:
        return map_layout_id, f"layout:{map_layout_id}"

    current_layout_id = current_layout_id_by_scope.get(scope)
    if current_layout_id is not None and cache_key in _NAVIGATION_GRAPH_CACHE_LEGACY_KEYS:
        return current_layout_id, f"layout:{current_layout_id}"

    return None, cache_key


def _navigation_graph_cache_rank(
    row: dict[str, Any],
    *,
    target_layout_id: int | None,
    target_cache_key: str,
) -> tuple[int, int]:
    row_id = int(row["id"])
    row_layout_id = _coerce_optional_db_int(row.get("map_layout_id"))
    row_cache_key = str(row.get("cache_key") or "")

    if target_layout_id is not None and row_layout_id == target_layout_id and row_cache_key == target_cache_key:
        return (0, row_id)
    if target_layout_id is not None and row_layout_id == target_layout_id:
        return (1, row_id)
    if row_cache_key == target_cache_key:
        return (2, row_id)
    return (3, row_id)


def _delete_navigation_graph_cache_rows_by_id(cursor, row_ids: list[int]) -> None:
    if not row_ids:
        return
    placeholders = ", ".join(["%s"] * len(row_ids))
    cursor.execute(
        f"""
        DELETE FROM navigation_graph_caches
        WHERE id IN ({placeholders})
        """,
        tuple(row_ids),
    )


def _normalize_navigation_graph_cache_rows(cursor) -> None:
    cursor.execute(
        """
        SELECT id, is_sandbox
        FROM map_layouts
        WHERE is_current = 1
        """
    )
    current_layout_id_by_scope: dict[int, int] = {}
    for row in cursor.fetchall() or []:
        layout_id = _coerce_optional_db_int(row.get("id"))
        if layout_id is None:
            continue
        current_layout_id_by_scope[int(row.get("is_sandbox") or 0)] = layout_id

    cursor.execute(
        """
        SELECT id, cache_key, map_layout_id, is_sandbox
        FROM navigation_graph_caches
        ORDER BY id ASC
        """
    )
    rows = list(cursor.fetchall() or [])
    if not rows:
        return

    grouped_rows: dict[tuple[int, int | None, str], list[dict[str, Any]]] = {}
    for row in rows:
        target_layout_id, target_cache_key = _resolve_navigation_graph_cache_target(
            row,
            current_layout_id_by_scope=current_layout_id_by_scope,
        )
        group_key = (int(row.get("is_sandbox") or 0), target_layout_id, target_cache_key)
        grouped_rows.setdefault(group_key, []).append(
            {
                "row": row,
                "target_layout_id": target_layout_id,
                "target_cache_key": target_cache_key,
            }
        )

    row_ids_to_delete: list[int] = []
    rows_to_update: list[dict[str, Any]] = []
    for items in grouped_rows.values():
        keep_item = min(
            items,
            key=lambda item: _navigation_graph_cache_rank(
                item["row"],
                target_layout_id=item["target_layout_id"],
                target_cache_key=item["target_cache_key"],
            ),
        )
        keep_row = keep_item["row"]
        keep_row_id = int(keep_row["id"])
        for item in items:
            row_id = int(item["row"]["id"])
            if row_id == keep_row_id:
                continue
            row_ids_to_delete.append(row_id)
        if keep_item["target_layout_id"] is None:
            continue
        current_layout_id = _coerce_optional_db_int(keep_row.get("map_layout_id"))
        current_cache_key = str(keep_row.get("cache_key") or "")
        if current_layout_id == keep_item["target_layout_id"] and current_cache_key == keep_item["target_cache_key"]:
            continue
        rows_to_update.append(
            {
                "id": keep_row_id,
                "target_layout_id": keep_item["target_layout_id"],
                "target_cache_key": keep_item["target_cache_key"],
                "current_cache_key": current_cache_key,
            }
        )

    _delete_navigation_graph_cache_rows_by_id(cursor, sorted(set(row_ids_to_delete)))

    # Temporary keys avoid transient unique-key collisions when imported rows
    # need to swap from one layout-scoped cache key to another.
    for row in rows_to_update:
        temp_cache_key = f"{_NAVIGATION_GRAPH_CACHE_TEMP_PREFIX}{row['id']}"
        if row["current_cache_key"] == temp_cache_key:
            continue
        cursor.execute(
            """
            UPDATE navigation_graph_caches
            SET cache_key = %s
            WHERE id = %s
            """,
            (temp_cache_key, row["id"]),
        )

    for row in rows_to_update:
        cursor.execute(
            """
            UPDATE navigation_graph_caches
            SET cache_key = %s,
                map_layout_id = %s
            WHERE id = %s
            """,
            (row["target_cache_key"], row["target_layout_id"], row["id"]),
        )


def _ensure_navigation_graph_cache_scope_column(cursor) -> None:
    if not _table_exists(cursor, "navigation_graph_caches"):
        return

    if not _column_exists(cursor, "navigation_graph_caches", "id"):
        cursor.execute(
            """
            ALTER TABLE navigation_graph_caches
            ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT FIRST,
            ADD UNIQUE KEY uq_navigation_graph_caches_id (id)
            """
        )

    if not _column_exists(cursor, "navigation_graph_caches", "map_layout_id"):
        cursor.execute(
            """
            ALTER TABLE navigation_graph_caches
            ADD COLUMN map_layout_id BIGINT UNSIGNED NULL AFTER cache_key
            """
        )

    if not _column_exists(cursor, "navigation_graph_caches", "is_sandbox"):
        cursor.execute(
            """
            ALTER TABLE navigation_graph_caches
            ADD COLUMN is_sandbox TINYINT(1) NOT NULL DEFAULT 0 AFTER cache_version
            """
        )

    cursor.execute(
        """
        SELECT COUNT(*) AS row_count
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'navigation_graph_caches'
          AND CONSTRAINT_NAME = 'PRIMARY'
          AND COLUMN_NAME = 'id'
        """
    )
    id_is_primary = int(cursor.fetchone()["row_count"]) > 0
    if not id_is_primary:
        cursor.execute(
            """
            SELECT COUNT(*) AS row_count
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'navigation_graph_caches'
              AND CONSTRAINT_NAME = 'PRIMARY'
            """
        )
        primary_key_columns = int(cursor.fetchone()["row_count"])
        if primary_key_columns > 0:
            cursor.execute("ALTER TABLE navigation_graph_caches DROP PRIMARY KEY")
        cursor.execute(
            """
            ALTER TABLE navigation_graph_caches
            ADD PRIMARY KEY (id)
            """
        )

    _normalize_navigation_graph_cache_rows(cursor)

    if _index_exists(cursor, "navigation_graph_caches", "uq_navigation_graph_caches_cache_key"):
        cursor.execute("ALTER TABLE navigation_graph_caches DROP INDEX uq_navigation_graph_caches_cache_key")

    if not _index_exists(cursor, "navigation_graph_caches", "uq_navigation_graph_caches_cache_key_is_sandbox"):
        cursor.execute(
            """
            ALTER TABLE navigation_graph_caches
            ADD UNIQUE KEY uq_navigation_graph_caches_cache_key_is_sandbox (cache_key, is_sandbox)
            """
        )

    if not _index_exists(cursor, "navigation_graph_caches", "uq_navigation_graph_caches_map_layout_id"):
        cursor.execute(
            """
            ALTER TABLE navigation_graph_caches
            ADD UNIQUE KEY uq_navigation_graph_caches_map_layout_id (map_layout_id)
            """
        )

    if _index_exists(cursor, "navigation_graph_caches", "idx_navigation_graph_caches_updated_at"):
        cursor.execute("ALTER TABLE navigation_graph_caches DROP INDEX idx_navigation_graph_caches_updated_at")

    if not _index_exists(cursor, "navigation_graph_caches", "idx_navigation_graph_caches_scope_updated_at"):
        cursor.execute(
            """
            ALTER TABLE navigation_graph_caches
            ADD KEY idx_navigation_graph_caches_scope_updated_at (is_sandbox, updated_at)
            """
        )

    cursor.execute(
        """
        DELETE legacy
        FROM navigation_graph_caches legacy
        INNER JOIN map_layouts layout
          ON layout.is_sandbox = legacy.is_sandbox
         AND layout.is_current = 1
        INNER JOIN navigation_graph_caches existing
          ON existing.is_sandbox = legacy.is_sandbox
         AND existing.id <> legacy.id
         AND (
            existing.map_layout_id = layout.id
            OR existing.cache_key = CONCAT('layout:', layout.id)
         )
        WHERE legacy.map_layout_id IS NULL
          AND (
            legacy.cache_key = 'default'
            OR legacy.cache_key = 'sandbox-default'
          )
        """
    )

    cursor.execute(
        """
        UPDATE navigation_graph_caches cache
        INNER JOIN map_layouts layout
          ON layout.is_sandbox = cache.is_sandbox
         AND layout.is_current = 1
        SET
          cache.map_layout_id = layout.id,
          cache.cache_key = CONCAT('layout:', layout.id)
        WHERE cache.map_layout_id IS NULL
          AND (
            cache.cache_key = 'default'
            OR cache.cache_key = 'sandbox-default'
          )
        """
    )

    cursor.execute(
        """
        UPDATE navigation_graph_caches
        SET cache_key = CONCAT('layout:', map_layout_id)
        WHERE map_layout_id IS NOT NULL
          AND cache_key <> CONCAT('layout:', map_layout_id)
        """
    )


def _merge_sandbox_navigation_graph_caches(cursor) -> None:
    if not _table_exists(cursor, "navigation_graph_caches") or not _table_exists(cursor, "sandbox_navigation_graph_caches"):
        return

    cursor.execute(
        """
        INSERT INTO navigation_graph_caches (
            cache_key, map_layout_id, graph_json, cache_version, is_sandbox, created_at, updated_at
        )
        SELECT
            CASE
              WHEN current_layout.id IS NOT NULL THEN CONCAT('layout:', current_layout.id)
              ELSE source.cache_key
            END,
            current_layout.id,
            source.graph_json,
            source.cache_version,
            1,
            source.created_at,
            source.updated_at
        FROM sandbox_navigation_graph_caches source
        LEFT JOIN (
            SELECT id
            FROM map_layouts
            WHERE is_sandbox = 1 AND is_current = 1
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
        ) current_layout
          ON 1 = 1
        LEFT JOIN navigation_graph_caches target
          ON target.is_sandbox = 1
         AND (
            (current_layout.id IS NOT NULL AND target.map_layout_id = current_layout.id)
            OR (current_layout.id IS NULL AND target.cache_key = source.cache_key)
         )
        WHERE target.id IS NULL
        """
    )

    cursor.execute("DROP TABLE sandbox_navigation_graph_caches")


def _run_schema_statements(cursor, statements: list[str], *, include_database_bootstrap: bool) -> None:
    for statement in statements:
        normalized = " ".join(statement.strip().split()).lower()
        if not include_database_bootstrap and (
            normalized.startswith("create database ")
            or normalized.startswith("use ")
            or normalized.startswith("create user ")
            or normalized.startswith("alter user ")
            or normalized.startswith("grant ")
            or normalized.startswith("flush privileges")
        ):
            continue
        cursor.execute(statement)
    _migrate_map_layout_tables(cursor)
    _ensure_draft_map_layout_display_name_column(cursor)
    _merge_sandbox_draft_map_layouts(cursor)
    _ensure_draft_map_layout_display_name_column(cursor)
    _ensure_map_layout_display_name_column(cursor)
    _merge_sandbox_map_layouts(cursor)
    _ensure_map_layout_display_name_column(cursor)
    _ensure_navigation_graph_cache_scope_column(cursor)
    _merge_sandbox_navigation_graph_caches(cursor)
    _ensure_navigation_graph_cache_scope_column(cursor)


def _should_try_bootstrap(error: Exception) -> bool:
    message = str(error).lower()
    return error.__class__.__name__ == "OperationalError" or any(
        token in message
        for token in (
            "access denied",
            "permission denied",
            "unknown database",
            "can't connect",
            "connection refused",
            "not allowed",
            "denied",
        )
    )


def _ensure_application_user(connection, cursor, settings: DatabaseSettings) -> None:
    quoted_user = connection.escape(settings.user)
    quoted_password = connection.escape(settings.password)
    database_name = settings.database.replace("`", "``")
    application_host = os.getenv("INDOOR_NAV_DB_APP_HOST", "localhost").strip() or "localhost"
    for host in (application_host,):
        cursor.execute(
            f"CREATE USER IF NOT EXISTS {quoted_user}@'{host}' IDENTIFIED BY {quoted_password}"
        )
        cursor.execute(f"ALTER USER {quoted_user}@'{host}' IDENTIFIED BY {quoted_password}")
        cursor.execute(f"GRANT ALL PRIVILEGES ON `{database_name}`.* TO {quoted_user}@'{host}'")
    cursor.execute("FLUSH PRIVILEGES")


def ensure_database_ready() -> None:
    if not SCHEMA_SQL_PATH.exists():
        raise RuntimeError(f"Schema SQL file not found: {SCHEMA_SQL_PATH}")

    statements = _read_sql_statements(SCHEMA_SQL_PATH)
    try:
        with get_connection() as connection:
            with connection.cursor() as cursor:
                _run_schema_statements(cursor, statements, include_database_bootstrap=False)
        return
    except Exception as error:
        bootstrap_settings = get_database_bootstrap_settings()
        if bootstrap_settings is None or not _should_try_bootstrap(error):
            if bootstrap_settings is None and _should_try_bootstrap(error):
                app_settings = get_database_settings()
                raise RuntimeError(
                    "Unable to initialize the database with the application account "
                    f"'{app_settings.user}'. Run sql/initialize_db.sql with an admin account or set "
                    "INDOOR_NAV_DB_BOOTSTRAP_USER and INDOOR_NAV_DB_BOOTSTRAP_PASSWORD for first-time setup."
                ) from error
            raise

    app_settings = get_database_settings()
    with get_connection(include_database=False, settings=bootstrap_settings) as connection:
        with connection.cursor() as cursor:
            _ensure_application_user(connection, cursor, app_settings)
            _run_schema_statements(cursor, statements, include_database_bootstrap=True)

    with get_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
