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

Project directories and `project.json` manifest files are created, renamed, moved, or cleaned up as part of every project create, edit, and archive operation. File uploads, asset indexing, thumbnails, tags, filesystem watchers, authentication, Patreon API integration, and backup automation remain deferred.

## Phase 3 scope

This phase adds the filesystem project directory lifecycle to the Phase 2 metadata workflow:

- **Canonical project directories** — every project receives a standard directory tree on disk at creation time.
- **`project.json` manifest** — each project directory contains an atomic-write manifest with schema version 1.
- **Standard subdirectories** — `source/`, `references/`, `extras/`, `thumbnails/`, `exports/full/`, `exports/web/`.
- **Title-change rename** — changing a project's title renames its directory (same-filesystem rename, no copy).
- **Status-change move** — changing status moves the directory to the corresponding status root.
- **Archive move** — archiving moves the directory to `archived/`; the manifest and `archived_at` are both updated.
- **Existing-record backfill** — projects created before Phase 3 receive directories on next startup (adoption or fresh creation).
- **Safe error handling** — creation, update, and archive failures are fully compensated (filesystem and database rollback) and never expose absolute paths to the user.
- **Error-preserving forms** — when a filesystem failure occurs during create or edit, the form is rerendered with the submitted values and a safe error message.

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

## Project directory structure

### Canonical layout

```
PROJECTS_ROOT/
├── active/           # tbd, planned, in-progress, ready, published
│   ├── 000001-my-project/
│   │   ├── project.json
│   │   ├── source/
│   │   ├── references/
│   │   ├── extras/
│   │   ├── thumbnails/
│   │   └── exports/
│   │       ├── full/
│   │       └── web/
│   └── 000042-another-project/
│       └── ...
├── published/        # published projects (mapped from active/ on status change)
│   └── ...
└── archived/         # archived projects (moved here by archive action)
    └── ...
```

### Status-to-directory mapping

| Project status | Status root directory |
|---|---|
| `tbd` | `active/` |
| `planned` | `active/` |
| `in-progress` | `active/` |
| `ready` | `active/` |
| `published` | `published/` |
| `archived` | `archived/` |

### Directory naming

Each project directory is named `{padded-id}-{slug}`:

```
000001-my-project
000042-another-project
```

- `padded-id` — zero-padded to 6 digits (e.g., project 1 → `000001`).
- `slug` — generated from the title by `@sindresorhus/slugify`.

### Standard subdirectories

Every project directory contains:

| Directory | Purpose |
|---|---|
| `source/` | Original source files (render inputs, PSDs, etc.) |
| `references/ | Reference images and materials |
| `extras/` | Extra deliverables not part of the primary export set |
| `thumbnails/` | Generated or manually placed thumbnails |
| `exports/full/` | Full-resolution exports |
| `exports/web/` | Web-optimized exports |

### project.json manifest

Every project directory contains a `project.json` manifest written atomically (write to temp file, fsync, rename). Schema version 1 fields:

```json
{
  "schemaVersion": 1,
  "id": 1,
  "title": "My Project",
  "slug": "my-project",
  "status": "tbd",
  "priority": "normal",
  "description": "",
  "notes": "",
  "tags": [],
  "createdAt": "2026-07-26T00:00:00.000Z",
  "updatedAt": "2026-07-26T12:00:00.000Z",
  "plannedDate": null,
  "publishedDate": null,
  "patreonUrl": null,
  "thumbnail": null
}
```

## Phase 4 scope

This phase adds awareness of files inside project directories:

- **Asset indexing** — each project directory can be manually scanned to discover files.
- **Asset database records** — discovered files are stored in an `assets` table with metadata (filename, extension, MIME type, size, modified date, relative path).
- **Asset listing page** — `GET /projects/:id/assets` shows all assets for a project with extension filtering, filename search, and sorting by filename, size, or modified date.
- **Manual scan trigger** — `POST /projects/:id/scan` triggers an on-demand scan and redirects to the asset listing with a summary of changes.
- **Reconciliation** — scans detect new, changed, and deleted files; the database is updated to match the filesystem.
- **Path safety** — only relative paths (forward-slash-normalized) are stored; existing `resolveProjectDir` safety checks (containment, symlink rejection) are reused.
- **Supported types** — images (`png`, `webp`, `jpg`, `jpeg`, `gif`) and Krita files (`kra`, `krz`) are recognized; other files are indexed as unknown.
- **Ignore rules** — `project.json`, temporary manifest files, `.DS_Store`, and hidden files/directories are excluded from indexing.
- **Dashboard asset count** — the home page shows the total number of indexed assets across all projects.

No filesystem watchers, file uploads, file modification, thumbnail generation, image processing, or automatic scanning. The filesystem remains authoritative — files added, modified, or removed externally are discovered on the next scan.

### Source of truth model

The **SQLite database is the authoritative source of truth** for project metadata (title, status, dates, notes, etc.). The filesystem mirror (directories + `project.json`) is derived from the database:

- **Creation** — database record first (to obtain the numeric ID), then filesystem.
- **Update** — database updated first, then filesystem (directory rename + manifest rewrite). On manifest failure, database is rolled back.
- **Archive** — filesystem move first, then database archive. On database failure, filesystem is rolled back.
- **Backfill** — database records without a `project_dir` path are reconciled on startup: existing directories are adopted if they match, otherwise a new directory is created.

### Filesystem lifecycle operations

**Title change** — when the project title changes, the slug is regenerated and the directory is renamed (same-filesystem `renameSync`, atomic on the same filesystem). The manifest is rewritten at the new path.

**Status change** — changing the status moves the directory to the corresponding status root (e.g., `active/` → `published/`). The manifest is updated with the new status.

**Archive** — the directory is moved to `archived/`, the manifest is updated, and the database record is marked with an `archived_at` timestamp. Archived projects are excluded from the default list view.

**Existing-record backfill** — on startup, any project record whose `project_dir` is `NULL` receives a canonical directory:
- If a directory already exists at the canonical path and passes all safety checks (real directory, not a symlink, matching manifest), it is **adopted** — the path is stored without modification.
- If no directory exists, one is **created fresh** with standard subdirectories and a manifest.
- Conflicts (symlinks, wrong manifest content, non-matching ownership) are logged and skipped.

**Warning**: do not manually rename or restructure project directories inside `PROJECTS_ROOT`. The application manages directory names and paths based on the database slug and status. Manual changes will cause ownership verification failures until the next operation on the project (which will report a clear error). Path-based access (`project_dir` in the database) is equally important — moving directories without updating the database breaks the association.

**Source and exported files remain directly accessible over SMB** — the directory structure under `PROJECTS_ROOT` is a plain POSIX filesystem tree with no symlinks or bind-mount indirection. Any SMB/NFS export of `PROJECTS_ROOT` sees the same layout.

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

## Phase 4 usage

### Asset scanning workflow

1. Create a project through the web UI (or use an existing one).
2. Project files are added externally through the SMB share — place `.kra`, `.png`, `.webp`, `.jpg`, `.jpeg`, `.gif`, or `.krz` files in the project directory or its subdirectories.
3. Navigate to the project detail page and click **View Assets**.
4. Click **Scan Now** to discover files. The scan compares the filesystem against the database and returns a summary (`X added`, `Y updated`, `Z removed`).
5. Assets appear in the listing with their filename, relative path, type, extension, size, and modified date.

### Asset listing

The asset list supports:

- **Filter by type** — select a file extension from the dropdown.
- **Search by filename** — type a search term to filter by filename.
- **Sorting** — sort by filename, size, or modified date, ascending or descending.

### Scanning behavior

- Scanning is always manual — there is no background watcher.
- The filesystem is authoritative. Files added, modified, or deleted through the SMB share are reflected in the asset index after the next scan.
- Only relative paths (forward-slash-normalized) are stored in the database.
- `project.json`, temporary manifest files, `.DS_Store`, `Thumbs.db`, and hidden files/directories are ignored.
- Symlinks are rejected. The scan verifies the project directory is a real directory before walking it.
- Unknown file types are indexed with `application/octet-stream` as their MIME type.
- Scanning does not modify, move, rename, or delete any files on disk.

### Dashboard

The home page now shows a **Total assets** count across all projects.

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

On success, the application also creates or updates the project's on-disk directory tree under the configured `PROJECTS_ROOT` share (see [Project directory structure](#project-directory-structure)). Each project receives a canonical directory with standard subdirectories and an atomic-written `project.json` manifest. If the filesystem operation fails, the database state is rolled back and the form is rerendered with a safe error message.

**Title changes** rename the project directory. **Status changes** move the directory to the appropriate status root (`active/`, `published/`, or `archived/`). Both operations use same-filesystem rename — no data is copied, and custom files inside the directory survive.

### Archiving

The project detail page has an **Archive** action. Archiving moves the project directory to the `archived/` status root, rewrites the manifest with the archived status, sets the status to `archived` in the database, and records the archived timestamp. Archived projects are excluded from the default project list but can still be viewed and filtered on the list page.

If the filesystem move or database update fails, the operation is fully compensated (directory moved back if already moved, database restored).

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

- Filesystem watchers and automatic background scanning
- File uploads, deletion, and rename through the web UI
- Thumbnail generation and image processing
- Duplicate detection
- Cloud storage integration
- Authentication and authorization
- Patreon API integration
- Tags and file-type filtering beyond extension
- Backup automation

These will be added in subsequent phases.

## Public media access (Phase 10.1C)

CreatorCrate has no authentication. Anyone who can reach the web application
can request its media routes:

```text
GET /projects/:projectId/assets/:assetId/thumbnail
GET /projects/:projectId/assets/:assetId/preview
GET /projects/:projectId/assets/:assetId/original
```

Path containment (the safe resolver under `PROJECTS_ROOT`) prevents
filesystem escape but is NOT authentication. It does not restrict which
users may view which assets — every reachable project and asset is
readable through these routes. Original files are served inline only when
both the stored extension and recorded MIME match an allowlisted image pair:
`png` + `image/png`, `jpg`/`jpeg` + `image/jpeg`, `webp` + `image/webp`,
or `gif` + `image/gif`. Krita, unknown extensions, missing MIME,
`application/octet-stream`, and extension/MIME mismatches are rejected with
`415`. The raw database filename is never trusted: the filename in
`Content-Disposition` is sanitized with an ASCII-only `filename=` fallback
(transliterated via NFD decomposition, no non-ASCII code points, no path
separators, no control characters, no header delimiters, bounded to 128
characters with safe extension retention) and a bounded UTF-8 RFC 5987
`filename*=` value that percent-encodes disallowed bytes with uppercase
hexadecimal digits.

Preview freshness is best-effort and is based on metadata from the last
completed asset scan. Thumbnail and preview cache freshness uses the scanned
source size, modification time, relative path, and derivative version; same-size
content changes with preserved modification time may not be detected until a
later scanned filesystem change or cache rebuild. The browser revision token is
for cache selection only; it is not a content hash or authorization mechanism.

Deployment access controls (network ACLs, reverse-proxy auth, VPN,
firewall) remain the operator's responsibility. Authentication is
deferred to a later phase and is not added in this pass.

## Verification

Run the focused verification order used during development:

```bash
pnpm test
git diff --check
docker compose config
docker compose build
docker compose up -d
curl http://localhost:3000/health

# Create a project through the web UI, then verify persistence across recreation.
curl -X POST -d 'title=Smoke+Test' -d 'status=tbd' -d 'priority=normal' \
  http://localhost:3000/projects
docker compose down
docker compose up -d
curl http://localhost:3000/health
curl -s http://localhost:3000/projects?search=Smoke | grep 'Smoke Test'
docker compose down
```
