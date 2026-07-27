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

## Phase 2 scope

This phase adds project metadata and a basic project-management workflow:

- `projects` SQLite table with title, slug, description, notes, status, priority, planned and published dates, Patreon URL, timestamps, and archive state.
- Project statuses: `tbd`, `planned`, `in-progress`, `ready`, `published`, `archived`.
- Project priorities: `low`, `normal`, `high`.
- Dashboard with counts per status and recently updated projects.
- Project list with search, status filter, sorting, and pagination.
- Create, edit, archive, and detail pages for projects.
- Slug generation from the title with safe collision handling.
- Validation for required fields, status/priority values, dates, and Patreon URLs.
- Focused tests for the migration, repository, service, validation, and HTTP workflow.

Project directories and `project.json` manifest files are **not** created yet. File uploads, asset indexing, thumbnails, tags, filesystem watchers, authentication, Patreon API integration, and backup automation remain deferred.

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

## Phase 2 usage

After starting the application, open <http://localhost:3000> to see the dashboard.

### Dashboard

The dashboard shows:

- The application name.
- Counts for every status: TBD, Planned, In Progress, Ready, Published, and Archived.
- The most recently updated non-archived projects.
- A **New Project** button and a link to the full project list.

### Project list

`/projects` lists active projects by default. Each row shows the title, status, priority, updated timestamp, planned date, and published date.

Use the filter bar to:

- Search titles, descriptions, and notes.
- Filter by status, including `archived` for archived records.
- Sort by recently updated, newest, oldest, or title, ascending or descending.

The list is paginated and preserves search, status, sort, and page parameters when navigating.

### Creating and editing projects

Click **New Project** to create a project. Required fields are marked with `*`:

- **Title** (required, up to 200 characters).
- Description (up to 4000 characters).
- Notes (up to 10000 characters).
- Status (one of `tbd`, `planned`, `in-progress`, `ready`, `published`; archiving is handled by the dedicated Archive action).
- Priority (one of `low`, `normal`, `high`).
- Planned date and Published date (`YYYY-MM-DD` when present).
- Patreon URL (must be an `https://` URL on a `patreon.com` host when present).

The slug is generated automatically from the title. If the title collides with another project, the form shows a field-level error.

Validation failures rerender the form with the entered values and errors. Successful creation or editing redirects to the project detail page.

### Archiving

The project detail page has an **Archive** action. Archiving sets the status to `archived`, records the archived timestamp, and preserves the database record. Archived projects are excluded from the default project list but can still be viewed and filtered on the list page.

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

- Project directories on disk
- `project.json` metadata files
- Asset indexing
- File uploads, deletion, and rename
- Filesystem watchers
- Authentication and authorization
- Patreon API integration
- Tags and file-type filtering
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

# Create a project through the API or UI, then verify persistence across recreation.
curl -X POST -d 'title=Smoke+Test' -d 'status=tbd' -d 'priority=normal' \
  http://localhost:3000/projects
docker compose down
docker compose up -d
curl http://localhost:3000/health
curl -s http://localhost:3000/projects?search=Smoke | grep 'Smoke Test'
docker compose down
```
