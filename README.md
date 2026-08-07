<p align="center">
  <img src="src/static/logo.svg" width="96" alt="CreatorCrate logo">
</p>

# CreatorCrate

CreatorCrate is a self-hosted workspace for one creator to organize art projects, their files, and the releases built from them. It keeps project media on your own filesystem, well suited to a server that also exposes those files through SMB, while CreatorCrate stores searchable metadata and workflow state in SQLite.

<p align="center">
  <img src="src/static/creatorcrate-overview.svg" alt="CreatorCrate project, asset, release, and calendar workflow" width="100%">
</p>

## What it does

- Manage projects with statuses, priorities, dates, notes, search, sorting, pagination, and archiving.
- Create and maintain a canonical project directory and atomic `project.json` manifest for every project.
- Scan project files into an asset index, organize them with categories, and browse supported media through generated previews and original files.
- Build releases from project assets, choose asset roles and ordering, publish completed work, and view releases on a calendar.
- Protect a self-hosted instance with optional single-operator authentication, server-side sessions, CSRF protection, security headers, and login throttling.
- Create, retain, restore, and delete managed SQLite backups from Settings.

## Quick start

### Local development

**Requirements:** Node.js 22 or later and pnpm 9.12 (via Corepack).

```bash
corepack enable
pnpm install
mkdir -p data/app data/projects
cp .env.example .env
pnpm dev
```

Open <http://localhost:3000>. Run the test suite with:

```bash
pnpm test
```

### Docker Compose

CreatorCrate uses two host bind mounts: one for application data and one for project files. Create the directories first, then add the required paths to `.env`:

```text
CREATORCRATE_APP_DATA_PATH=/srv/creatorcrate/app
CREATORCRATE_PROJECTS_PATH=/srv/creatorcrate/projects
CREATORCRATE_PORT=3000
APP_NAME=CreatorCrate
```

Start the service and verify it:

```bash
docker compose up -d --build
curl http://localhost:3000/health
```

Stop it with `docker compose down`. The container can be recreated without losing persistent data as long as the bind-mounted directories remain intact.

## Configuration

Copy `.env.example` for local runs. The Compose file supplies the in-container paths and requires both `CREATORCRATE_*_PATH` variables; it publishes `${CREATORCRATE_PORT:-3000}` to container port `3000`.

| Setting | Purpose | Default |
| --- | --- | --- |
| `NODE_ENV` | Application environment | `development` in `.env.example` |
| `PORT` | Local server port | `3000` |
| `APP_NAME` | Display name | `CreatorCrate` |
| `APP_DATA_ROOT` | SQLite database, backups, previews, and managed application state | `./data/app` |
| `PROJECTS_ROOT` | Project directories and original media | `./data/projects` |
| `DATABASE_PATH` | SQLite database location | `./data/app/creatorcrate.db` |
| `BACKUP_RETENTION_COUNT` | Managed database backups to retain; `0` disables pruning | `10` when unset |
| `SESSION_TTL_HOURS` | Fixed server-side session lifetime | `24` when unset |
| `COOKIE_SECURE` | Require HTTPS cookies | `false` when unset |
| `TRUST_PROXY` | Trust forwarded client addresses for login throttling | `false` when unset |
| `HSTS_ENABLED` | Send HSTS headers | `false` when unset |

`TZ` is also accepted by the Compose service and defaults to `UTC`. If you need the optional auth, session, or backup settings inside Docker, add them explicitly to the service environment.

## Data and workflows

### Persistent storage

| Location | Contents |
| --- | --- |
| `APP_DATA_ROOT` | SQLite database and WAL files, managed database backups, generated previews, and managed authentication state |
| `PROJECTS_ROOT` | Project directories, `project.json` manifests, and original project files |

Project directories live directly under `PROJECTS_ROOT`; each is named with its zero-padded ID and slug, for example `000042-summer-illustration/`. Project status is application metadata only — it is not represented by filesystem parent folders, and status changes or archiving never move project files. CreatorCrate does not create or use an `inbox` folder under `PROJECTS_ROOT`.

Each project receives a `project.json` manifest plus standard working folders: `final/`, `wip/`, `krz/`, `wm/`, and `wm-lq/`. CreatorCrate updates the manifest atomically as project metadata changes.

### Projects and assets

Create a project in the web app, then place its working files in its project directory. Use the project asset screen to scan the filesystem and refresh indexed metadata. Categories help organize indexed assets; previewable media is served through generated derivatives while original files remain filesystem-backed.

The filesystem is authoritative for media contents. SQLite stores project, asset, release, and workflow metadata; it is not a replacement for the project-file directory.

### Releases, publishing, and calendar

Create releases from project work, select and order the included assets, and assign their release roles. When a release is ready, use the publishing workflow to record published work. The calendar provides a date-based view of planned and published release activity.

## Authentication and security

Authentication is **disabled by default**. Enable it in **Settings > Security** to create the one supported operator account; no password hash or session secret needs to be added to `.env` for the normal browser-managed setup.

- Credentials, auth enablement, and the session secret are managed under `APP_DATA_ROOT`, not stored in SQLite.
- Password rotation and disabling authentication are available in Settings. For lockout recovery, run `pnpm auth:reset` on the host and restart the application.
- The app uses server-side sessions, CSRF protection, security headers, no-store policies for sensitive pages, and bounded in-memory login throttling.
- Use TLS and a controlled reverse proxy, VPN, or network ACLs for every network-accessible deployment. An instance with authentication disabled is accessible to anyone who can reach it.

Set `COOKIE_SECURE=true` only when HTTPS is enforced. Set `TRUST_PROXY=true` only behind a proxy you control. Enable `HSTS_ENABLED=true` only after HTTPS is correctly configured for the hostname.

## Backups and restore

Settings can create, list, restore, and delete managed SQLite backups. Restore runs in maintenance mode, replaces the database, and invalidates active sessions.

> **Important:** Managed backups contain database data only. They do **not** include project files, generated previews, `operator-credential.json`, or `auth-enablement.json`. Back up both `APP_DATA_ROOT` and `PROJECTS_ROOT` at the host/filesystem level, preferably off-host, for disaster recovery.

Restoring a database does not change the current authentication enablement or operator password, because those files are kept outside the database. It also does not modify project files.

## Operations

| Task | Command or endpoint |
| --- | --- |
| Start production server locally | `pnpm start` |
| Start development server | `pnpm dev` |
| Run tests once | `pnpm test` |
| Run tests interactively | `pnpm test:watch` |
| Run the project check | `pnpm check` |
| Generate a password hash for scripted deployments | `pnpm auth:hash` |
| Reset browser-managed authentication after lockout | `pnpm auth:reset` |
| Health check | `GET /health` |

The Compose service has a built-in health check against `http://localhost:3000/health`.

## Limitations and non-goals

- CreatorCrate is designed for one self-hosted operator, not multi-user collaboration or public sharing.
- It indexes files that you manage on disk; it is not a cloud storage or synchronization service.
- Authentication does not replace network controls or TLS.
- Managed SQLite backups are not full-system backups.
- CreatorCrate does not synchronize with external publishing platforms.

## Contributing

Use pnpm and Node 22+. Before submitting a change, run the narrowest relevant tests; the full suite is:

```bash
pnpm test
```

Keep application data and project files out of Git, and preserve the separation between filesystem media and SQLite metadata when changing workflows.
