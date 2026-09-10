<p align="center">
  <img src="src/static/logo.png" width="96" alt="CreatorCrate logo">
</p>

# CreatorCrate

CreatorCrate is a self-hosted workspace for one creator to organize art projects, their files, and the releases built from them. It keeps project media on your own filesystem, well suited to a server that also exposes those files through SMB, while CreatorCrate stores searchable metadata and workflow state in SQLite.

## What it does

- Manage projects with statuses, dates, notes, search, sorting, pagination, and archiving.
- Create and maintain a canonical project directory and atomic `project.json` manifest for every project.
- Scan project files into an asset index, organize them with categories, and browse supported media through generated previews and original files.
- Build releases from project assets, choose asset roles and ordering, publish completed work, and view releases on a calendar.
- Protect a self-hosted instance with optional single-operator authentication, server-side sessions, CSRF protection, security headers, and login throttling.
- Create, retain, restore, and delete managed SQLite backups from Settings.

In Notes, click a chapter title or its arrow in **Book contents** to expand or collapse its Pages. Page links open their Pages. New/Edit Page dialogs start with their outer **Book contents** disclosure collapsed; use its compact Expand/Collapse tab to reveal the polished navigator, which has no **View Chapter** links.

Book, Chapter, and Page create/edit dialogs open on their host pages, including through the direct URLs below. They use native form POSTs; validation errors return the host with the dialog open, submitted values preserved, and errors shown (422). With JavaScript enabled, X, Escape, and backdrop dismissal use the shared dialog lifecycle.

- **New Book**: hosted on the Books index; direct URL `/notes/books/new`. Success opens the created Book.
- **Book cover uploads**: Covers are optional. New/Edit Book accepts PNG, JPEG, or WebP images; leaving the file input untouched creates a Book without a cover or preserves its existing cover on Edit. Replacing an existing cover asks for confirmation; the previous image or Asset is not deleted. After a validation error, select the file again.
- **Edit Page (Note)**: hosted on Note detail; `/notes/:id/edit` opens the same dialog directly. The single-column order is Book contents, Page contents, Connections, separate Move/Delete actions, then Save. Validation preserves Note-specific Project/Asset selections; success returns to Note detail. Move/Delete retain their independent forms and confirmation behavior.
- **Page revision history**: Note detail has a collapsed Revision history section beneath Details. `/notes/:id/revisions/:revisionId` shows sanitized historical content and retained Project/Asset references, including unavailable deleted targets. Restore uses the shared confirmation dialog and posts to `/notes/:id/revisions/:revisionId/restore`; unavailable associations leave the current Page unchanged.
- **New Page (Note)**: hosted on Book detail for `/notes/new?bookId=:bookId`, or Chapter detail for `/notes/new?chapterId=:chapterId`. Exactly one valid container is required; bare, invalid, missing, or ambiguous containers return 404. The single-column form orders Book contents, Page contents, then Connections and Create. Validation preserves text and Project/Asset selections; success opens the created Page.
  In New/Edit Page **Connections → Assets**, enhanced option rows show decorative thumbnails (or neutral fallback boxes), respecting the existing NSFW blur preference. Selected summaries and the no-JavaScript native multiple select remain text-only.
- **New Chapter**: hosted on Book detail; direct URL `/notes/books/:bookId/chapters/new`. Success opens the new Chapter.
- **Edit Book**: hosted on Book detail; direct URL `/notes/books/:bookId/edit`. Success returns to Book detail. Delete Book remains a separate, collapsed form.
- **Books shelf order**: Change order on Notes opens a hosted dialog; `/notes/books/order` opens the same dialog directly. Save preserves Book ordering; X and Escape close without saving. Invalid submissions reopen with canonical order.
- **Chapter Page order**: Change order on Chapter detail uses the same hosted dialog lifecycle, including the direct `/notes/chapters/:chapterId/notes/order` fallback and canonical-order validation rerender.
- **Book hierarchy**: hosted on Book detail; `/notes/books/:bookId/order` opens the Change order dialog directly. Page and Chapter titles in the Book hierarchy section are plain text. Drag the Page and Chapter cards to reorder them or move Pages between the Book root and any Chapter, including empty Chapters; Chapters remain root-only and carry their nested Pages. Keyboard users can reorder within the current container with Up, Down, Home, and End through the existing handle. Drag and keyboard edits update only the draft `hierarchy` field, while Save performs one aggregate, atomic submission guarded by the loaded expected hierarchy. X and Escape discard the unsaved DOM draft and restore the hierarchy loaded by the current response, including a safe 422 draft where `target` differs from `expected`; backdrop clicking does not dismiss this dialog. Invalid safe submissions return 422, stale submissions return 409 with the current hierarchy refreshed, and no schema migration is required. The existing flat Books-shelf and Chapter-Page reorder consumers remain separate; the legacy root-only Book endpoint is available for compatibility.
- **Book Defaults**: the existing Book-detail Defaults dialog keeps expanded/collapsed Chapter navigation as a global preference and stores Random/Selected Page-preview configuration per Book. Choose Selected Pages from the searchable multi-select dropdown, including direct and Chapter-contained Pages; the shared Save is atomic across both scopes.
- **Page previews**: Book detail replaces the redundant main Book outline with Page previews. Configure its Book-scoped Random/Selected settings in the existing **Book Defaults** dialog; Random defaults to 5 and draws without replacement on each request, while Selected follows saved Page membership. Every valid Page in the Book is eligible and previews remain in authoritative Book order—there is no current-Page exclusion because Book detail has no current Page.
- **Edit Chapter**: hosted on Chapter detail; direct URL `/notes/chapters/:chapterId/edit`. Success returns to Chapter detail. Delete Chapter remains a separate, collapsed form and requires an empty Chapter.

## Quick start

### Local development

**Requirements:** Node.js 24.19.0 and pnpm 11.21.0 (via Corepack).

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

For real-browser frontend smoke coverage, install the dedicated Chromium binary explicitly and run the separate Playwright suite:

```bash
pnpm test:browser:install
pnpm test:browser
```

The browser suite uses temporary application data, projects, and SQLite state; it does not use the local `data/` directories.

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
| `AUTO_SCAN_INTERVAL_MINUTES` | Optional deployment environment variable controlling the recurring scan interval for eligible projects; must be a positive whole number from `1` to `35791` minutes | Automatic scanning disabled when unset or empty; no default automatic scan interval |
| `PERSIST_DEBUG_LOGS` | Persist internal `debug` application-log records | `false` when unset; accepts `true` and `false` case-insensitively with surrounding whitespace ignored |
| `SESSION_TTL_HOURS` | Fixed server-side session lifetime | `24` when unset |
| `COOKIE_SECURE` | Require HTTPS cookies | `false` when unset |
| `TRUST_PROXY` | Trust forwarded client addresses for login throttling | `false` when unset |
| `HSTS_ENABLED` | Send HSTS headers | `false` when unset |

`AUTO_SCAN_INTERVAL_MINUTES` controls how often CreatorCrate automatically scans eligible projects. Automatic scans use the same normal project-scanning behavior as manual scans and begin on the configured recurring interval, not immediately at startup. Malformed values or values outside the supported `1`-to-`35791` minute range fail configuration validation. For example:

```text
AUTO_SCAN_INTERVAL_MINUTES=60
```

`TZ` is also accepted by the Compose service and defaults to `UTC`. If you need the optional auth, session, backup, or automatic-scanning settings inside Docker, add them explicitly to the service environment.

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

Manage Project Status and Project Type options under **Settings > Defaults**.
You can add, reorder, recolor, and delete options, but existing names cannot be
renamed. When Projects use an option, deletion can reassign them to another option
from the same catalogue. If a saved default uses the option, change that default
before deleting it.

New Project has configurable default Status and Type values. Their initial values
are `tbd` and `images`; these are seeded defaults rather than permanently protected
options, so either can be deleted after its saved default is changed and any Project
references are resolved. Archived is system-managed and remains available in
Projects filtering and Dashboard rather than as an editable workflow Status.

The filesystem is authoritative for media contents. SQLite stores project, asset, release, and workflow metadata; it is not a replacement for the project-file directory.

### Releases, publishing, and calendar

Create releases from project work, select and order the included assets, and assign their release roles. When a release is ready, use the publishing workflow to record published work. The calendar provides a date-based view of planned and published release activity.

### Application logs

**Settings > Logs** shows CreatorCrate's operational and activity records.
Entries are newest first and can be filtered by level, kind (activity or
diagnostic), subsystem, and bounded time presets (last hour, 24 hours, 7 days,
or 30 days). Choose 25, 50, 75, or 100 items per page; this setting and a
Logs display timezone (Local / Browser, UTC, Eastern, Central, Mountain, or
Pacific) can be saved in **Logs defaults**. Timestamps initially render as UTC
without JavaScript, then format in the selected timezone when JavaScript is
available. The page supports pagination and a per-entry context/details
disclosure. With JavaScript, filter changes and **Refresh** update the results
in place while preserving the URL; the normal server-rendered GET form remains
the fallback.

Auto-refresh is enabled by default and is available only on page 1. When
enabled, it refreshes every 30 seconds, pauses while the tab is hidden, and
uses the current filters through the same request-ownership path.

Use **Clear Logs** to open a confirmation page. On confirmation, existing log
records are cleared and a new `logging.cleared` marker remains. This is an
operational log, not an immutable or tamper-proof audit history.

CreatorCrate retains application logs for 90 days and keeps at most 50,000
records. `info`, `warn`, `error`, and `fatal` records persist by default.
To persist internal `debug` records too, set `PERSIST_DEBUG_LOGS=true`; when
unset it is `false`. The configuration accepts `true` and `false`
case-insensitively and ignores surrounding whitespace; other values are rejected.

The log intentionally avoids sensitive request/authentication information,
absolute local paths, raw processing options, and stack traces. It uses bounded
context for practical operations and diagnostics, but is not a compliance or
immutable-audit facility.

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
| Run Chromium browser smoke tests | `pnpm test:browser` |
| Install the Chromium browser for smoke tests | `pnpm test:browser:install` |
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

Use pnpm 11.21.0 and Node.js 24.19.0. Before submitting a change, run the narrowest relevant tests; the full suite is:

```bash
pnpm test
```

Keep application data and project files out of Git, and preserve the separation between filesystem media and SQLite metadata when changing workflows.
