# Indoor Navigation Service

FastAPI backend for indoor route search, map-layout management, authentication, and an admin-only sandbox. MariaDB is the system of record for application accounts, layouts, drafts, history, and route caches.

## Requirements

- Python 3.11
- MariaDB or MySQL compatible with the schema in `sql/indoor_navigation_db.sql`
- Optional: Conda, Docker, or Render for the matching deployment workflow

## Local setup

From the repository root:

```powershell
conda create -n indoor-svc python=3.11
conda activate indoor-svc
pip install -r requirements.txt
```

Conda is optional. A regular Python virtual environment works as well.

### Database setup

For a local database, initialize the schema and bundled seed data with an administrator account:

```powershell
Get-Content -Raw sql/initialize_db.sql | & "C:\Program Files\MariaDB 10.5\bin\mysql.exe" --host=127.0.0.1 --port=3306 --user=root -p
```

This creates the `indoor_navigation_db` database and imports sanitized layout seed data. Before starting the service, configure these required values in your deployment environment:

- Host: `127.0.0.1`
- Port: `3306`
- Database: `indoor_navigation_db`
- `INDOOR_NAV_DB_USER` and `INDOOR_NAV_DB_PASSWORD`
- `INDOOR_NAV_SESSION_SECRET`
- `INDOOR_NAV_INITIAL_ADMIN_USERNAME` and `INDOOR_NAV_INITIAL_ADMIN_PASSWORD` when the database has no application account

The database host, port, database name, and database user have development-friendly defaults. `INDOOR_NAV_DB_PASSWORD` does not. For first-time account creation by the service, also provide both `INDOOR_NAV_DB_BOOTSTRAP_USER` and `INDOOR_NAV_DB_BOOTSTRAP_PASSWORD`; the optional bootstrap host, port, and application-account host variables are documented in `.env.render.example`.

See [DATABASE_README.md](DATABASE_README.md) for the persistence model and full API route list.

### Start the service

```powershell
uvicorn main:app --reload
```

Verify it at <http://127.0.0.1:8000/status>.

The first application account is created from `INDOOR_NAV_INITIAL_ADMIN_USERNAME` and `INDOOR_NAV_INITIAL_ADMIN_PASSWORD`. Set a strong, stable `INDOOR_NAV_SESSION_SECRET` for every environment.


# Indoor Navigation UI

A React and TypeScript single-page application for indoor route search, map visualization, and authenticated floor-layout editing.

## Prerequisites

- Node.js 20 or later (Node 20 is used by the Dockerfile and Render configuration)
- The indoor-navigation backend when using search, login, layout persistence, or sandbox features

On Windows, [nvm-windows](https://github.com/coreybutler/nvm-windows/releases) is one way to install and switch Node versions.

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the Vite development server:

   ```bash
   npm run dev
   ```

3. Open the application at `http://localhost:5173/`. The sandbox application is available at `http://localhost:5173/sandbox`.

With no environment variables set, the UI uses `/api` and the Vite dev server proxies the supported API paths to `http://127.0.0.1:8000`. Start the backend there, or configure the service URLs described below.

## Build and preview

```bash
npm run build
npm run preview
```

`npm run preview` serves the generated `dist/` files locally; it does not provide the development API proxy.

`npm run lint` is available, but the current codebase has existing lint violations, primarily in the sandbox components. It is not presently a passing quality gate.

## Application routes and access

- `/` — route search and map visualization.
- `#/configurator` — authenticated layout builder. Unauthenticated visitors are returned to the home screen.
- `/sandbox` — sandbox application with its own admin credentials when it uses a separate service.

The main session is stored in browser local storage and expires after eight hours. The application uses hash routing for the configurator, so a static host only needs an SPA fallback for pathname routes such as `/sandbox`.

## Main technologies

- React 18, TypeScript, and Vite
- `react-konva` / Konva for the layout-editing canvas
- SVG and Three.js for map and route views
- `mdb-react-ui-kit` and Font Awesome for UI styling

The canonical layout schema and renderers are in `src/layout/`. The checked-in main layout artifact is `src/data/main_layout.json`; the sandbox copy is `sandbox/data/main_layout.json`.

## Backend integration

The main application calls the configured service for login, search, and layouts. The layout builder uses endpoints including:

- `GET /map-layout`
- `GET /draft-maps` and `POST /draft-maps/save`
- `POST /draft-maps/delete`
- `GET /map-layout-history`
- `POST /map-layout/publish`

The sandbox uses the corresponding paths below its sandbox service URL, as well as `GET /status` and `POST /layout-arranger/plan`.

### Environment variables

Vite embeds `VITE_*` variables when the application is built. Set them before `npm run build`; changing them after a static build is deployed does not change the bundle.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_SERVICE_BASE_URL` | `/api` | Base URL for the main backend. |
| `VITE_SANDBOX_SERVICE_BASE_URL` | `<VITE_SERVICE_BASE_URL>/sandbox` | Base URL for the sandbox backend. |
| `VITE_UI_MAIN_LAYOUT_BACKUP_URL` | `<VITE_SERVICE_BASE_URL>/ui-main-layout/save` | Optional main-layout backup endpoint. Set to `off` to disable it. |
| `VITE_SANDBOX_UI_MAIN_LAYOUT_BACKUP_URL` | `<VITE_SANDBOX_SERVICE_BASE_URL>/ui-main-layout/save` | Optional sandbox-layout backup endpoint. Set to `off` to disable it. |

For a separately hosted frontend, use an absolute backend URL, for example:

```env
VITE_SERVICE_BASE_URL=https://your-backend-service.example.com
VITE_UI_MAIN_LAYOUT_BACKUP_URL=off
VITE_SANDBOX_UI_MAIN_LAYOUT_BACKUP_URL=off
```

The backend must permit the frontend origin through CORS when the URL is on another origin.

## Local layout backups

During `npm run dev`, Vite handles these local-only POST routes and writes the checked-in JSON artifacts:

- `/api/ui-main-layout/save` → `src/data/main_layout.json`
- `/api/sandbox/ui-main-layout/save` → `sandbox/data/main_layout.json`

These handlers are not included in `npm run build` output. In a deployed build, configure the matching backend endpoint or set the appropriate backup variable to `off`.

## Render deployment

This repository includes `render.yaml` for a Render Static Site:

1. Push the repository to GitHub or GitLab.
2. Create a Render Blueprint from `render.yaml`.
3. Set `VITE_SERVICE_BASE_URL` to the public backend URL, without appending `/api`.
4. Deploy.

The blueprint runs `npm run build`, publishes `dist`, and rewrites `/*` to `/index.html`. It disables both optional layout-backup URLs by default. See `.env.render.example` for the same environment-variable template.

## Docker and EC2 note

The Dockerfile builds the static bundle and serves it with Nginx. It does not inject Vite environment variables at container runtime, so provide the `VITE_*` values during the image build (for example through a build-time `.env.production.local` file) and rebuild whenever they change.

`deploy-ui.sh` builds and runs that image on an existing Docker network. It can expose ports 80 and 443 when certificate files exist, but the current Nginx configuration only supplies the base Nginx settings; it does not configure TLS virtual hosts, ACME handling, or an `/api` reverse proxy. Configure those server blocks and the backend connection before relying on this script for an HTTPS or same-origin API deployment.
