# Database and API reference

## Persistence model

MariaDB is the source of truth for application accounts, map layouts, drafts, layout history, and navigation graph caches. The schema is in [sql/indoor_navigation_db.sql](sql/indoor_navigation_db.sql); [sql/initialize_db.sql](sql/initialize_db.sql) runs the schema followed by the bundled seed dump, [sql/initial_data.sql](sql/initial_data.sql).

At startup, `services/database.py` connects using the configured application database account and applies compatible table and column migrations. It runs database/user bootstrap statements only when bootstrap credentials are available. If `login_accounts` is empty, `services/login_service.py` creates the initial account from environment variables.

## Connection configuration

| Variable | Default |
| --- | --- |
| `INDOOR_NAV_DB_HOST` | `127.0.0.1` |
| `INDOOR_NAV_DB_PORT` | `3306` |
| `INDOOR_NAV_DB_NAME` | `indoor_navigation_db` |
| `INDOOR_NAV_DB_USER` | `indoor_nav_app` |
| `INDOOR_NAV_DB_PASSWORD` | Required |

Set `INDOOR_NAV_SESSION_SECRET` for every deployment. When the account table is empty, also set `INDOOR_NAV_INITIAL_ADMIN_USERNAME` and `INDOOR_NAV_INITIAL_ADMIN_PASSWORD` to create the first application account.

For first-time bootstrap, set both `INDOOR_NAV_DB_BOOTSTRAP_USER` and `INDOOR_NAV_DB_BOOTSTRAP_PASSWORD`. `INDOOR_NAV_DB_BOOTSTRAP_HOST` and `INDOOR_NAV_DB_BOOTSTRAP_PORT` are optional; they default to the normal database host and port. `INDOOR_NAV_DB_APP_HOST` defaults to `localhost`; set it to the specific host permitted to use the application database account when the service runs elsewhere.

For a local initialization using an administrative MariaDB account:

```powershell
Get-Content -Raw sql/initialize_db.sql | & "C:\Program Files\MariaDB 10.5\bin\mysql.exe" --host=127.0.0.1 --port=3306 --user=root -p
```

## Tables

| Table | Purpose |
| --- | --- |
| `login_accounts` | Application usernames, passwords, active status, and timestamps. This is separate from MariaDB server accounts. |
| `map_layouts` | Current and historical live/sandbox layouts. `is_sandbox` separates scopes and `is_current` identifies the active layout in each scope. |
| `draft_map_layouts` | Live and sandbox drafts. Draft deletion is soft deletion through `is_deleted`. |
| `navigation_graph_caches` | Serialized route graphs. A cache can be tied to a specific `map_layout_id`; live and sandbox caches are scoped with `is_sandbox`. |

Current layouts use `map_layout.json` for live and `sandbox_map_layout.json` for sandbox. History is capped at 15 records per scope. Sandbox drafts are capped at 15 active records; live drafts currently have no configured cap.

## Legacy JSON import

`LegacyStorageMigrationService` checks `data/` first, then `map-layouts-copy/`, and imports legacy credentials, current layouts, graph caches, history, and drafts only when the equivalent database record is absent. After verifying that the database contains the imported records, those JSON files can be archived or removed. Set `INDOOR_NAV_DELETE_LEGACY_JSON=1` only when you intentionally want the migration service to delete legacy JSON files after processing them.

## API routes

### Public routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/status` | Service health check. |
| POST | `/search` | Computes a route from the `origin` and `destination` request fields. |
| GET | `/auth/status` | Returns the primary active application account. |
| POST | `/auth/login` | Validates credentials and sets the admin session cookie. |
| POST | `/auth/logout` | Clears the session cookie. |
| POST | `/auth/change-password` | Changes an account password after current-password verification. |
| GET, POST, PUT, DELETE | `/map-layout` | Reads, creates, updates, or removes the current live layout. |
| POST, PUT | `/map-layout/publish` | Publishes a layout, archives the previous current layout, and updates its route cache. |
| GET | `/map-svg` | Returns the current live layout as SVG. |
| GET, POST | `/draft-maps` | Lists or creates live drafts. |
| GET, PUT, DELETE | `/draft-maps/{draft_id}` | Reads, updates, or soft-deletes a live draft. |
| POST | `/draft-maps/save` | Compatibility route that creates a live draft. |
| POST | `/draft-maps/delete` | Compatibility route that soft-deletes a draft by filename. |
| GET, POST | `/map-layout-history` | Lists or creates live history records. |
| GET, PUT, DELETE | `/map-layout-history/{history_id}` | Reads, updates, or deletes a live history record. |

### Sandbox routes

Every `/sandbox/*` route requires an active session cookie or valid HTTP Basic credentials. Its layout, draft, history, SVG, search, and publish routes mirror the live route families under the `/sandbox` prefix. It additionally provides:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/sandbox/status` | Sandbox health check. |
| POST | `/sandbox/layout-arranger/plan` | Builds a sandbox layout-arrangement plan from the supplied message and configuration. |

## Operational notes

- New application passwords are stored using salted PBKDF2-SHA256 hashes. A legacy plaintext password is upgraded after its next successful login.
- `INDOOR_NAV_SESSION_SECRET` signs session tokens and is required at startup.
- Route caches are rebuilt when a layout’s routing entities change, and missing caches are created during startup warmup.
