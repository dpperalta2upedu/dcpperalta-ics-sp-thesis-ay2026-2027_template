from __future__ import annotations

import argparse
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.database import ensure_database_ready
from services.database import get_connection
from services.database import get_database_settings


DEFAULT_OUTPUT_PATH = REPO_ROOT / "sql" / "initial_data.sql"
EXCLUDED_TABLES = {"login_accounts"}

HEADER_LINES = (
    "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;",
    "/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;",
    "/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;",
    "/*!40101 SET NAMES utf8mb4 */;",
    "/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;",
    "/*!40103 SET TIME_ZONE='+00:00' */;",
    "/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;",
    "/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;",
    "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
    "/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;",
    "",
)

FOOTER_LINES = (
    "/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;",
    "",
    "/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;",
    "/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;",
    "/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;",
    "/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;",
    "/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;",
    "/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;",
    "/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;",
    "",
)


def _write_lines(handle, lines: tuple[str, ...] | list[str]) -> None:
    for line in lines:
        handle.write(f"{line}\n")


def _get_tables(cursor) -> list[str]:
    cursor.execute("SHOW TABLES")
    rows = cursor.fetchall()
    if not rows:
        return []
    return [str(next(iter(row.values()))) for row in rows]


def _get_create_table(cursor, table_name: str) -> str:
    cursor.execute(f"SHOW CREATE TABLE `{table_name}`")
    row = cursor.fetchone()
    return str(row["Create Table"])


def _get_columns(cursor, table_name: str) -> list[str]:
    cursor.execute(f"SHOW COLUMNS FROM `{table_name}`")
    return [str(row["Field"]) for row in cursor.fetchall()]


def _get_primary_key_columns(cursor, table_name: str) -> list[str]:
    cursor.execute(f"SHOW KEYS FROM `{table_name}` WHERE Key_name = 'PRIMARY'")
    rows = cursor.fetchall()
    rows.sort(key=lambda row: int(row["Seq_in_index"]))
    return [str(row["Column_name"]) for row in rows]


def _fetch_rows(cursor, table_name: str, column_names: list[str], order_columns: list[str]) -> list[dict]:
    select_list = ", ".join(f"`{column}`" for column in column_names)
    query = f"SELECT {select_list} FROM `{table_name}`"
    if order_columns:
        order_by = ", ".join(f"`{column}`" for column in order_columns)
        query += f" ORDER BY {order_by}"
    cursor.execute(query)
    return cursor.fetchall()


def _sql_literal(connection, value) -> str:
    return str(connection.escape(value))


def export_initial_data(output_path: Path, only_tables: list[str] | None = None) -> None:
    settings = get_database_settings()
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    ensure_database_ready()

    with get_connection() as connection:
        with connection.cursor() as cursor:
            all_tables = _get_tables(cursor)
            requested_tables = [t for t in all_tables if t in only_tables] if only_tables else all_tables
            tables = [table for table in requested_tables if table not in EXCLUDED_TABLES]

            with output_path.open("w", encoding="utf-8", newline="\n") as handle:
                _write_lines(handle, HEADER_LINES)
                handle.write(
                    f"CREATE DATABASE /*!32312 IF NOT EXISTS*/ `{settings.database}` "
                    "/*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci */;\n\n"
                )
                handle.write(f"USE `{settings.database}`;\n")

                for table_name in tables:
                    create_table_sql = _get_create_table(cursor, table_name)
                    column_names = _get_columns(cursor, table_name)
                    primary_key_columns = _get_primary_key_columns(cursor, table_name)
                    rows = _fetch_rows(cursor, table_name, column_names, primary_key_columns)

                    handle.write(f"DROP TABLE IF EXISTS `{table_name}`;\n")
                    handle.write("/*!40101 SET @saved_cs_client     = @@character_set_client */;\n")
                    handle.write("/*!40101 SET character_set_client = utf8 */;\n")
                    handle.write(f"{create_table_sql};\n")
                    handle.write("/*!40101 SET character_set_client = @saved_cs_client */;\n\n")
                    handle.write(f"LOCK TABLES `{table_name}` WRITE;\n")
                    handle.write(f"/*!40000 ALTER TABLE `{table_name}` DISABLE KEYS */;\n")

                    if rows:
                        handle.write(f"INSERT INTO `{table_name}` VALUES ")
                        for index, row in enumerate(rows):
                            if index > 0:
                                handle.write(",\n")
                            values_sql = ", ".join(_sql_literal(connection, row[column]) for column in column_names)
                            handle.write(f"({values_sql})")
                        handle.write(";\n")

                    handle.write(f"/*!40000 ALTER TABLE `{table_name}` ENABLE KEYS */;\n")
                    handle.write("UNLOCK TABLES;\n\n")

                _write_lines(handle, FOOTER_LINES)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export non-credential MariaDB data into an initial_data.sql dump."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_PATH,
        help="Path to the SQL dump output file.",
    )
    parser.add_argument(
        "--tables",
        nargs="+",
        metavar="TABLE",
        default=None,
        help="Limit export to these table names (space-separated). login_accounts is always excluded.",
    )
    args = parser.parse_args()

    export_initial_data(args.output, only_tables=args.tables)
    print(args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
