# CreatorCrate

CreatorCrate is a single-user, self-hosted web application for organizing Patreon art projects and their files. It runs in Docker on the same server as an SMB file share so project files stay directly accessible on the host filesystem.

## Phase 1 scope

This phase establishes the application foundation:

- Node.js 22 + Express server
- Nunjucks server-rendered pages
- SQLite database through `better-sqlite3`
- pnpm package management
- Vitest + Supertest tests
- Dockerfile and Docker Compose
- Separate bind mounts for application data and project files
- Environment-based configuration
- `/health` endpoint
- Basic application shell
- Startup validation of mounted directories

Project management, file indexing, uploads, search, and other features are intentionally deferred.

## Required software

For local development:

- Node.js 22
- pnpm 9 (enabled via Corepack)

For Docker deployment:

- Docker Engine with BuildKit
- Docker Compose

## Local setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create the required local directories:

   ```bash
   mkdir -p data/app data/projects
   ```

3. Copy the example environment file and adjust if needed:

   ```bash
   cp .env.example .env
   ```

4. Run the tests:

   ```bash
   pnpm test
   ```

5. Start the development server:

   ```bash
   pnpm dev
   ```

   The application will be available at <http://localhost:3000>.

## Docker Compose setup

1. Create host directories for the two bind mounts:

   ```bash
   mkdir -p /srv/creatorcrate/app /srv/creatorcrate/projects
   ```

2. Create a `.env` file with the host paths.
   Both `CREATORCRATE_APP_DATA_PATH` and `CREATORCRATE_PROJECTS_PATH` are required; Docker Compose fails with an actionable error if either is unset or empty.

   ```text
   CREATORCRATE_APP_DATA_PATH=/srv/creatorcrate/app
   CREATORCRATE_PROJECTS_PATH=/srv/creatorcrate/projects
   CREATORCRATE_PORT=3000
   APP_NAME=CreatorCrate
   ```

3. Build and start the service:

   ```bash
   docker compose up -d
   ```

4. Check health:

   ```bash
   curl http://localhost:3000/health
   ```

5. Stop the service:

   ```bash
   docker compose down
   ```

## Two-bind-mount design

CreatorCrate stores all persistent data outside the container filesystem:

| Mount | Container path | Purpose |
| --- | --- | --- |
| Application data | `/data/app` | SQLite database, WAL files, and generated application state |
| Projects | `/data/projects` | Creator project files exposed through the host SMB share |

No permanent data lives inside the container. Recreating the container leaves the SQLite database and project files intact in the host directories.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `PORT` | `3000` | HTTP port |
| `APP_NAME` | `CreatorCrate` | Application display name |
| `APP_DATA_ROOT` | `./data/app` | Host/container path to application data root |
| `PROJECTS_ROOT` | `./data/projects` | Host/container path to project files root |
| `DATABASE_PATH` | `./data/app/creatorcrate.db` | SQLite database path |
| `CREATORCRATE_APP_DATA_PATH` | (required in Docker) | Host bind-mount source for application data (Docker Compose only) |
| `CREATORCRATE_PROJECTS_PATH` | (required in Docker) | Host bind-mount source for project files (Docker Compose only) |

Inside Docker the defaults are set to `/data/app/creatorcrate.db` and the bind mounts provide `/data/app` and `/data/projects`. The two `CREATORCRATE_*_PATH` variables are required when using Docker Compose; an unset or empty value produces an actionable error.

## Health endpoint

`GET /health` returns JSON:

```json
{
  "status": "ok",
  "database": "ok"
}
```

If the database readiness check fails the status becomes `503` and `database` becomes `error`. The response does not expose host paths, database paths, stack traces, or secrets.

## File ownership and permissions

The container runs as a non-root `creatorcrate` user. The host bind-mount directories must be readable and writable by that user’s UID/GID, or by a group the runtime user belongs to. The startup script validates this and exits with a clear message if a directory is missing, not a directory, or not writable.

## Startup and shutdown

Local:

```bash
pnpm dev      # start with file watching
pnpm start    # start without watching
```

Docker:

```bash
docker compose up -d     # start
docker compose down        # stop and remove container
docker compose build       # rebuild image
```

## Features intentionally deferred

- Project CRUD and project directories
- `project.json` metadata files
- Asset indexing
- File uploads, deletion, and rename
- Filesystem watchers
- Authentication and authorization
- Patreon API integration
- Tags and search
- Thumbnail generation
- Backup automation

These will be added in subsequent phases.

## Verification

Run the focused verification order used during development:

```bash
pnpm test
git diff --check
docker compose config
docker compose build
docker compose up -d
curl http://localhost:3000/health
docker compose down
```
