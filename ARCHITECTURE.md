# CreatorCrate Architecture

## 1. Purpose and scope

This document describes how CreatorCrate is built: what the major parts are,
why they exist, how they interact, and which rules must hold when the system
changes. It is written for contributors who need to decide **where new
behavior belongs** and **which boundaries they must not cross**.

It is not an installation, configuration, or operations guide. Environment
variables, Docker Compose, persistent-storage layout, security posture for
operators, and day-to-day commands are documented in [README.md](README.md)
and are deliberately not repeated here.

Two conventions are used throughout:

- **Enforced** means a rule the code or the test suite fails on. Enforcement
  points are named explicitly.
- **Convention** means a rule the codebase follows consistently but does not
  mechanically verify. Breaking a convention will not fail a test; it will
  make the codebase inconsistent.

Historical `Phase ...` markers appear in many source comments. They record
when something was introduced and carry no architectural meaning; this
document describes the system as it stands.

---

## 2. Overall system shape

CreatorCrate is a **single-process, single-operator Express application**
with server-rendered HTML, a SQLite metadata store, and a filesystem that is
authoritative for media.

```
                        ┌──────────────────────────────────────────┐
   browser  ───────────▶│  node:http server  (src/server.js)       │
   (progressive         │    └─ Vite middleware (development only) │
    enhancement)        │    └─ appContext.handleRequest           │
                        └──────────────────┬───────────────────────┘
                                           │
                        ┌──────────────────▼───────────────────────┐
                        │  Express app  (src/app.js)               │
                        │   middleware → routers → views (njk)     │
                        └───────┬──────────────────────┬───────────┘
                                │                      │
                        ┌───────▼────────┐    ┌────────▼─────────┐
                        │   services/    │    │    storage/      │
                        │ domain logic,  │    │ path safety,     │
                        │ orchestration  │    │ atomic writes    │
                        └───────┬────────┘    └────────┬─────────┘
                                │                      │
                        ┌───────▼────────┐    ┌────────▼─────────┐
                        │     data/      │    │  filesystem      │
                        │  SQL only      │    │  PROJECTS_ROOT   │
                        │  (better-sqlite3)   │  APP_DATA_ROOT   │
                        └────────────────┘    └──────────────────┘
```

Three properties shape almost every design decision:

1. **The filesystem is the source of truth for media.** SQLite holds an
   *index* of what exists on disk plus workflow metadata (projects, releases,
   notes, tags, categories). Deleting the database loses metadata; it never
   loses artwork. Scanning rebuilds the index from disk.
2. **Everything is synchronous where the filesystem is involved.**
   `better-sqlite3` is synchronous, and the scanner, manifest writer, and
   storage helpers all use `fs.*Sync`. Asynchronous code appears only where
   an external library requires it (image encoding via `sharp`, archive
   generation, SQLite's online backup API).
3. **There is exactly one process and one operator.** Locks are in-memory
   and process-local, sessions are server-side rows, and there is no
   clustering story. Anything that assumes multiple workers is wrong here.

Top-level layout:

| Path | Role |
| --- | --- |
| [`src/`](src/) | The application |
| [`client/`](client/) | Vite entry point for the production browser bundle |
| [`migrations/`](migrations/) | Forward-only SQL schema migrations |
| [`tests/`](tests/) | Vitest suites plus a Playwright browser suite |
| [`helper/windows/`](helper/windows/) | Separate .NET "Open locally" protocol helper |
| [`scripts/`](scripts/) | Host-side recovery CLIs |
| [`downloads/`](downloads/) | Prebuilt artifact served by the downloads route |

---

## 3. Runtime startup and shutdown lifecycle

[`src/server.js`](src/server.js) is the process entry point and the only
place that reads the environment, touches `process.exit`, or owns timers and
signals. Its `main()` runs a fixed, fail-fast sequence:

1. **Configure** — `createConfig()` from [`src/config.js`](src/config.js)
   validates and freezes every setting. Invalid input throws `ConfigError`
   and the process exits before anything else happens.
2. **Validate mounts** — `validateMounts()` from
   [`src/filesystem.js`](src/filesystem.js) proves `APP_DATA_ROOT`,
   `PROJECTS_ROOT`, and the database's parent directory exist and are
   readable/writable. A misconfigured bind mount fails here, not at the first
   request.
3. **Ensure derived roots** — `ensurePreviewRoot()` creates the preview cache
   root. Derived directories (`previews/`, `backups/`) are computed from
   `APP_DATA_ROOT` and are deliberately *not* configurable; they are owned
   directories, not operator inputs.
4. **Load the asset manifest** — in production only, the Vite manifest is
   read and validated (see §16). A missing or malformed build aborts startup.
5. **Open the database and migrate** — `openDatabase()` then
   `runMigrations()` from [`src/db.js`](src/db.js).
6. **Resolve authentication state** — `ensureAuthEnablement()` reads (or
   lazily creates as explicitly *disabled*) the managed auth-enablement file.
   If auth is enabled, a managed credential provider is constructed; an
   enabled state with no credential file is a hard startup failure rather
   than a silent default.
7. **Build the application context** — `createApplicationContext()` builds
   the Express app around the open connection (see §4 and §5).
8. **Run the initial watermark scan** — a one-shot reconciliation of the
   global watermark library; a failure is logged, not fatal.
9. **Create the HTTP server, attach Vite in development, start the scheduler,
   and listen.**

Shutdown is idempotent and signal-driven (`SIGTERM`, `SIGINT`): stop the
scan scheduler, close the Vite server, close the HTTP server, then close
**whichever database connection is currently active** — `appContext.db`,
not the handle opened at startup, because a live restore may have replaced
it (see §4).

`main()` runs only when the module is the process entry point. Everything
above it in the file is exported and independently testable — that is why
`loadProductionAssetManifest`, `createDevelopmentViteServer`,
`createApplicationRequestHandler`, and `runInitialWatermarkScan` are named
exports rather than inline steps.

---

## 4. The application-context rebuild/swap model

[`src/app-context.js`](src/app-context.js) exists to solve one specific
problem: **every repository and service resolves its database handle at
construction time.** None of them look the connection up per request. So
replacing the live SQLite connection — which a backup restore must do —
cannot work by reassigning a `db` variable; every already-constructed object
would still close over the old, now-closed connection.

The context therefore owns a `{ db, app }` pair and rebuilds the *entire*
service graph when the connection changes:

- `replaceDatabase(newDb)` calls `createApp` against `newDb`, and only on
  success assigns `current = { db: newDb, app: newApp }`. The swap is a
  single reference assignment, so a request that already read `current`
  finishes against a consistent context and no request ever observes a
  half-swapped state.
- On failure, `current` is untouched and `newDb` is closed here so it is
  never leaked.
- `replaceAuthConfig(newAuthConfig)` does the same for an auth
  enable/disable transition, against the *current* database. It builds a
  candidate options object first and commits `activeAppOpts` only after the
  rebuild succeeds, so a malformed auth config can never desynchronize the
  live context from what it claims to be running.

**Connection-ownership invariant.** `app-context.js` never closes a
connection the caller still owns. The backup service owns closing the
previous connection and opening the restored one; the context only ever
closes a *new* connection it was just handed, and only when building around
it threw.

**Identity that must survive a rebuild** is created once per context and
threaded into every `buildApp` call *after* `...opts`, so a stray same-named
key in the options object can never shadow it:

- the **Auto Rename signing key**, so a database restore does not invalidate
  outstanding plan tokens mid-session;
- the **project operation coordinator** and the **processing-job service**,
  so scanners and mutation services retain the same per-project exclusion and
  any later permitted rebuild keeps the same process-local job registry;
- the `onDatabaseReplaced` / `onAuthConfigReplaced` hooks, so a restore
  triggered by a request always adopts back into the same context that
  served it.

Before either database or auth-context replacement, the context refuses the
rebuild while the processing-job service has queued or running work. That
prevents maintenance from replacing dependencies that a job still needs.
Processing job state is process-local and in-memory, so it is intentionally
lost on a process restart.

Anything else — repositories, services, routers, the Nunjucks environment —
is rebuilt from scratch. If you add state that must outlive a restore, it
belongs in `app-context.js` alongside the items above, not in `app.js`.

---

## 5. Composition root and dependency injection

[`src/app.js`](src/app.js)'s `createApp({ appName, db, projectsRoot,
previewRoot }, opts)` is the **single composition root**. It is the only
place in the application that constructs repositories and services and wires
them together.

The wiring style is deliberate and consistent:

- Each dependency is constructed **once** and threaded explicitly downward:
  a repository receives the database, a service receives the repository, a
  router receives the already-built service. Nothing downstream constructs
  its own repository.
- Shared repositories are reused rather than duplicated — services reach
  them through `projectService.repository` and `assetScanner.repository`
  rather than calling `createProjectRepository(db)` a second time. Two
  instances of a repository would be harmless for reads but would defeat the
  "one lock, one identity" invariants above.
- `createApp()` constructs and composes dependencies explicitly. Many support
  an `opts.thing || createThing(...)` whole-instance override, which is an
  important **test seam**: unit and HTTP tests build a real app and inject a
  fake for the collaborator under test. Others are constructed unconditionally
  while accepting lower-level collaborator overrides, so `opts` is not a
  universal whole-instance replacement mechanism. Production never passes
  these test overrides.
- Constructed services are published on `app.locals` so out-of-band callers
  (the scan scheduler in `server.js`, tests) can reach the *currently built*
  instances after a rebuild.
- The processing-job service is injected into each processing router. The
  application context owns its instance so that a permitted later rebuild
  keeps the same process-local job registry and project coordinator; a direct
  `createApp` caller receives a fresh in-memory instance instead.

**Rooted vs rootless builds.** `projectsRoot` and `previewRoot` are optional.
When `projectsRoot` is absent, the filesystem-backed services
(`assetActionService`, `assetProcessingService`, `assetProcessingPlanner`,
`autoRenameService`, `projectAssetCategoryService`,
`assetWorkflowMetadataService`) are not constructed, and the routers that
depend on them are **not mounted at all** rather than mounted with `null`
dependencies that would fail at request time. The same applies to
`previewRoot` and the preview/media services. Tests exercising pure
metadata behavior use rootless builds; production always supplies both.

When you add a service, construct it in `createApp`, give it an `opts`
override, publish it on `app.locals` if anything outside the request path
needs it, and — if it requires a filesystem root — guard both its
construction and its router mount on that root.

---

## 6. Routes → services → repositories

The application is layered, and the layering is the primary architectural
constraint.

| Layer | Directory | Responsibility | Must not |
| --- | --- | --- | --- |
| Routes | [`src/routes/`](src/routes/) | HTTP shape: parse/validate input, choose status codes, render a view or JSON | Import a repository module (enforced); contain domain rules; touch the filesystem |
| Services | [`src/services/`](src/services/) | Domain logic, orchestration, transactions, invariants | Know about `req`/`res` |
| Repositories | [`src/data/`](src/data/) | SQL statements and row mapping for one table/aggregate | Contain domain rules or filesystem access |
| Storage | [`src/storage/`](src/storage/) | Path safety, containment, atomic writes, on-disk formats | Know about the database or HTTP |

**Enforced:** [`tests/route-boundary.test.js`](tests/route-boundary.test.js)
statically scans every file in `src/routes/` and fails if any of them
imports, `require()`s, or dynamically imports a `*-repository` module from
`src/data/`. This is the one layering rule with mechanical teeth, and its
teeth are narrow: it constrains **imports only**. It says nothing about what
a router may be *handed*.

**What routers actually receive today.** The table above states the
direction the codebase leans, not a wall. Two exceptions are real and
widespread, and a design that assumes they do not exist will be wrong:

- **Routers do receive repository instances by injection.** `createApp`
  passes `assetRepository` into the notes and processing routers and
  `appMetaRepository` into the settings router, and those routers call
  repository methods directly (`notes.js` drives the asset/project pickers
  through `assetRepository` and `projectService.repository`; `processing.js`
  resolves scopes through `assetRepository`). The enforced test permits this
  because nothing is imported.
- **Routers do receive the raw `better-sqlite3` handle.** `createApp` threads
  `db` into the health, projects, asset-library, assets, releases, and
  settings routers. Most of them only forward it onward, but three execute
  database work directly: [`health.js`](src/routes/health.js) runs
  `db.prepare('SELECT 1').get()` as its liveness probe, and
  [`settings.js`](src/routes/settings.js) and the shared
  [`page-defaults.js`](src/routes/page-defaults.js) handler wrap a batch of
  service calls in `db.transaction(...)` (see §8).

The convention is still that new query logic belongs in a repository behind a
service, and that a router reaching for `db` should be the exception it is
today — a liveness ping or an atomic wrapper around existing service calls,
not new SQL. But a contributor should design against the boundary as it is:
only the import rule is verified, and "routers never see `db`" is not true of
this codebase.

**Conventions** (consistently followed, not test-enforced):

- Services do not import routes, and routes do not import other routes'
  internals. Route-support modules that grew too large live beside their
  router with an explicit name — [`asset-library-query.js`](src/routes/asset-library-query.js),
  [`dashboard-render.js`](src/routes/dashboard-render.js),
  [`project-assets-shared.js`](src/routes/project-assets-shared.js).
- One `createXRouter({ deps })` factory per file, returning an
  `express.Router`. Routers validate their required dependencies at
  construction time (`createProcessingRouter` throws `TypeError` for a
  missing service) so a wiring mistake surfaces at startup, not on the first
  request.
- A router may conditionally register a subset of its routes. `processing.js`
  mounts application-global managed-resource routes unconditionally under
  `/processing`, but registers per-project execution routes under `/projects`
  only when the rooted processing dependencies are all present.

**Failure flows across layers as typed errors, not strings.** Each layer
defines its own error class — `ConfigError`, `FilesystemError`,
`StorageError`, `DatabaseError`, `AssetManifestError`, `BackupError`,
`PreviewCacheError`, `MediaError`, `AssetProcessingError`,
`WatermarkServiceError`, `ProjectOperationError`, `AutoRenameError`,
`ProjectValidationError`, `ProjectNotFoundError`, `AuthStateError`,
`CredentialError` — usually with a machine-readable `code`. The layer above
maps the type to an HTTP status. Two consequences worth preserving:

- The distinction between *source* failure and *derived-cache* failure is
  carried by the type. `StorageError` (missing/unsafe/unreadable source)
  becomes 404; `PreviewCacheError` (unwritable cache, full disk) becomes 503
  so the client retries. Callers never guess from message text.
- Error messages that cross a boundary use basenames and relative paths.
  **Absolute host paths are never leaked to a client**, and the storage and
  service layers are written to preserve that.

---

## 7. Request and middleware lifecycle

`createApp` builds a fixed middleware chain. The order encodes real
constraints; changing it is an architectural decision, not a refactor.

1. **Maintenance gate.** The very first middleware. While a restore holds
   `maintenanceState.active`, every request except `/health` and static
   assets gets a 503 (HTML or JSON by content negotiation) before body
   parsing, static lookup, or routing can touch a closing database. The
   `maintenanceState` object is shared **by reference** with the settings
   router and survives rebuilds; it is mutated, never reassigned. Static
   assets are recognized by having a file extension — application routes
   never do.
2. **Security headers** — CSP, `X-Content-Type-Options`, `Referrer-Policy`,
   `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and optional HSTS.
   The development CSP relaxes `style-src` and allows `ws:`/`wss:` for Vite
   HMR; every other mode uses the strict policy.
3. **Body parsing** — `express.json()` and `express.urlencoded()`.
4. **Static assets** — [`src/static/`](src/static/) at the root, and the
   Vite build output under `/vite` with long-lived immutable caching. Static
   files are served **before authentication**, which is why the auth
   middleware never has to reason about them.
5. **`resolveSession`** — resolves the session cookie into
   `res.locals.auth`. Exposes only safe state (`enabled`, `authenticated`,
   `username`, and the CSRF secret for the next middleware); never the raw
   token. A stale cookie is cleared.
6. **Cache policy** — `private, no-store` for `/login`, anything under
   `/settings`, and all HTML responses while auth is enabled.
7. **`exposeCsrfToken`** — must run after session resolution and before any
   handler renders a form.
8. **`requireCsrf`** — must run before the auth router so `POST /logout` is
   protected too. `GET`/`HEAD`/`OPTIONS` are exempt; login verifies its own
   pre-auth token.
9. **Auth router** (or, when auth is disabled, a `/login` redirect to
   Settings › Security, since there is no login form to render).
10. **Shell model** — `buildShellModel({ appName, path })` from
    [`src/shell/navigation.js`](src/shell/navigation.js) computes the
    navigation model once per request from `req.path` and puts it on
    `res.locals.shell`. **Routes never assemble navigation themselves**, and
    the error handler builds its own with `noActive: true` so a 404 never
    highlights a section the request never reached.
11. **`requireAuth`** — protects everything mounted below. It independently
    exempts `/health`, `/login`, and `/logout` regardless of mount order.
    HTML `GET`s redirect to `/login?next=…` (validated against open-redirect
    payloads); everything else gets a flat `401` JSON, so a mutation is
    rejected outright rather than answered with a redirect.
12. **Feature routers**, then a catch-all that raises a 404 `Error`.
13. **Centralized error handler.** Negotiates HTML (`error.njk`) versus JSON.
    Client errors (4xx) surface their message; server errors (5xx) are
    replaced with a generic message, marked `no-store`, and have
    content/disposition/ETag headers stripped so a partially-written or
    sensitive response cannot be cached or sniffed.

Mount order carries meaning in one more place: the media routes are mounted
under `/projects` **before** the asset browser/viewer router, so the deeper
media paths can never be shadowed by a future broadening of the viewer route.

---

## 8. SQLite persistence and the migration model

[`src/db.js`](src/db.js) is small on purpose. It owns three things:

- `openDatabase(path)` — opens `better-sqlite3` with `journal_mode = WAL`
  and `foreign_keys = ON`. Both pragmas are part of the contract: WAL for
  concurrent readers during a backup, foreign keys for referential
  integrity.
- `runMigrations(db, dir)` — the migration runner.
- `closeDatabase(db)`.

**Migration model.** [`migrations/`](migrations/) holds forward-only SQL
files named `NNN_description.sql`. The runner:

- creates `schema_migrations (filename, applied_at)` if absent;
- sorts files with a numeric-aware collation and applies each unapplied file
  **inside a transaction together with its own `schema_migrations` row**, so
  a file is either fully applied and recorded, or neither;
- toggles `PRAGMA foreign_keys = OFF` **around** (never inside) each
  transaction, restoring the prior value in a `finally`. This is required
  because SQLite cannot change that pragma inside a transaction, and
  table-rebuild migrations — the standard way to alter a `CHECK` constraint
  — would cascade-delete child rows if foreign keys were on while the parent
  table is recreated.

There is no down-migration mechanism. Reversing a schema change means
writing a new forward migration. Table-rebuild migrations follow the SQLite
twelve-step pattern and are visible in the history as `*_new` intermediate
tables.

The schema covers projects and their per-project asset categories, the asset
index, releases and release assets, notes/books/chapters and their
associations, tags and their project/asset joins, watermarks and watermark
scale maps, processing presets, generated artifacts, project primary images,
per-project and global page defaults, sessions, and a generic `app_meta`
key/value table.

`app_meta` deserves a note: it is the **application-scoped settings store**,
accessed exclusively through
[`app-meta-repository.js`](src/data/app-meta-repository.js) and wrapped by
narrow settings services (preview category, NSFW filter, Open-locally root,
dashboard and page defaults, default watermark, automatic-scan timing).
Adding a new global setting means adding a key and a small service, not a
migration.

**Transactions are owned above the repository layer, usually by a service.**
Repositories expose statements and single-purpose operations; a caller
composes them with `db.transaction(...)` when several must succeed together.
Repository methods deliberately do not open nested transactions, so the
caller's transaction can roll the whole unit back — `projectService.create`
relies on exactly this.

That caller is normally a service, and for anything with domain rules it
should be. It is not always one, though: the page-defaults save paths open
their transaction in the route layer. The shared
[`page-defaults.js`](src/routes/page-defaults.js) handler wraps its
`pageDefaultsService.saveDefault` loop in `db.transaction(save)()` (falling
back to a plain call when the injected `db` has no `transaction`, which is
what lets rootless and faked builds reuse the handler), and the Settings
defaults POST in [`settings.js`](src/routes/settings.js) does the same across
every page section. Both wrap *existing* service calls to make a multi-row
save atomic; neither introduces SQL of its own. Treat that as the shape a
route-level transaction is allowed to take (see §6), not as licence for a
route to own domain logic.

---

## 9. Filesystem and storage architecture

[`src/storage/`](src/storage/) is the boundary between domain code and the
filesystem. Its job is to make unsafe filesystem operations impossible to
express, and it deliberately **does not trust upstream validation**.

Two roots, with different ownership:

- **`PROJECTS_ROOT`** — operator media. CreatorCrate creates and manages
  project directories and their category subdirectories, and writes a
  `project.json` manifest, but the operator is expected to add and edit
  files directly (including over SMB). Project directories are **flat direct
  children** of `PROJECTS_ROOT`, named `<zero-padded-id>-<slug>`.
- **`APP_DATA_ROOT`** — application-owned. The SQLite database and its WAL
  sidecars, `backups/`, `previews/`, and the managed auth files. Only
  CreatorCrate writes here.

The safety rules, all implemented in
[`project-storage.js`](src/storage/project-storage.js) and
[`asset-file.js`](src/storage/asset-file.js) and enforced at runtime:

- Relative paths only; absolute inputs are rejected outright.
- Resolved paths must remain contained under their root — checked via
  `path.relative`, not string prefixes.
- **Every existing path component is `lstat`ed and any symbolic link is
  refused**, including the final target. This closes symlink-escape attacks
  that a containment check alone would miss.
- Project directories must be direct children of `PROJECTS_ROOT`; category
  directories must be direct children of a project directory. Historical
  status-nested paths are invalid.
- Category directory slugs are re-validated at the storage boundary against
  a portable pattern (lowercase alphanumeric, hyphen-separated) with
  explicit rejection of control characters, separators, `.`/`..`, trailing
  dots, `project.json`, and Windows reserved device names — *independently
  of* the service-layer validator that already ran.
- Destinations are never silently overwritten. `ensureNoConflict` and
  case-insensitive destination preflight reject collisions before anything
  is created.
- Removal is never recursive at this layer. `removeProjectDir` verifies
  containment, ID ownership, non-symlink, and emptiness before removing.

**Identity capture and quarantine.** Where a rollback might have to delete
something, storage captures `{dev, ino}` at creation time and refuses to
remove a path whose identity no longer matches. Where a directory must be
removed safely, it is first renamed to an unpredictable sibling
(`.cc-<kind>-<pid>-<time>-<rand>`) so a concurrent actor can no longer
influence what the subsequent check-and-remove inspects. Deliberately
absent: a "restore quarantined directory" operation. Node has no portable
atomic rename-if-absent for directories, so
`restoreQuarantinedCategoryDir` **reports** why it cannot restore and mutates
nothing, rather than racing a concurrent creator.

**Manifest.** [`manifest.js`](src/storage/manifest.js) serializes
`project.json` and writes it via temp-file-plus-rename. Its temp files use a
distinct pattern (`.{hex}.project.json.tmp`) that the scanner explicitly
skips, and that cannot collide with the quarantine names above.

---

## 10. Asset scanning

[`asset-scanner.js`](src/services/asset-scanner.js) turns "what is on disk"
into "what the database says exists". It is the mechanism that makes the
filesystem authoritative.

`scanProjectAssets(projectId)` runs entirely inside the project's
coordinator lock (§11), covering project validation, directory traversal,
and the reconciliation transaction as one protected region — so a rename or
a processing run can never begin between traversal and reconciliation.

Inside the lock:

1. Resolve the project directory through the storage layer (containment and
   symlink checks), then verify it exists, is a directory, and is not a
   symlink.
2. Walk it recursively, collecting **relative paths and metadata only** —
   no absolute path is ever stored. Skips CreatorCrate-managed files
   (`project.json` and its temp form), OS junk, archive extensions, root-level
   dotfiles, hidden directories, and symlinks of any kind.
3. **Abort on permission or I/O errors.** This is the critical invariant: a
   traversal that cannot see the whole tree must not reconcile, because a
   partial snapshot would mark real files as missing.
4. Load the project's categories once and classify every discovered path
   against them (both enabled and disabled, so disabled-category files still
   classify correctly).
5. Hand the **complete snapshot** to `reconcileScannedAssets` for a single
   atomic transaction: insert new paths, restore and update existing ones,
   and mark undiscovered paths missing. No database transaction is held
   while walking the directory.
6. Optionally apply automatic primary-image selection, which is fail-closed:
   any non-automatic (or unrecognized) provenance on an existing primary
   image is treated as manual and left alone.

Assets are soft-deleted: a vanished file is marked *missing*, not removed,
so that a temporarily unmounted share or a moved file does not destroy tags,
release membership, or notes.

---

## 11. Processing invariants

Asset processing (format conversion, watermarking, archive generation,
ComfyUI workflow-prompt editing) is the most invariant-dense part of the
system. The rules below hold across all of it.

### Serialization

[`project-operation-coordinator.js`](src/services/project-operation-coordinator.js)
is a **process-local, per-project mutual exclusion primitive**. One instance
is created per application context and shared by the scanner, the asset
action service, the processing service, and Auto Rename — which is precisely
what makes a scan and a mutation mutually exclusive for one project.

Its deliberate limitations are part of the contract: it is not distributed
and does not persist across process restarts. The synchronous `run()` path
remains fail-fast: a same-project conflict is rejected immediately with
`PROJECT_OPERATION_IN_PROGRESS`. The asynchronous `runAsync()` path instead
queues same-project callbacks FIFO; a rejected callback does not prevent the
next queued callback from running. Different projects still proceed
independently. A project remains active until its asynchronous queue drains,
and synchronous callers release it in `finally`.

### Background processing jobs

Processing Apply validates the request and resolves its concrete asset scope,
then submits an in-memory job rather than waiting for the mutation to finish.
It returns HTTP `202 Accepted` with an opaque job ID. The process-local
processing-job service schedules each job through `runAsync()` and exposes a
snapshot lifecycle of `queued`, `running`, `succeeded`, `failed`, or
`cancelled`, plus coarse `{ completed, total }` progress once the work is
running. Only `queued` jobs are cancellable; a running job always runs to its
existing completion or failure path.

The browser polls `GET /processing/jobs/:id` for status and may request
`POST /processing/jobs/:id/cancel` while the job is queued. This is HTTP
polling, not SSE or WebSockets. Queued and running jobs also block backup
maintenance and application-context database or auth replacement. The job
registry is intentionally in-memory and restart-volatile. Terminal jobs are
retained for up to five minutes, with at most 100 terminal completions kept;
queued and running jobs are never retention-eviction candidates, and the
oldest terminal completions are evicted first when the cap is exceeded. An
expired or evicted job is no longer available from the status endpoint and
returns the existing job-not-found `404` condition. The client treats that as
permanent: it stops polling, clears its active/busy state, and reports that
the processing result is no longer available. Other transient polling errors
remain retryable.

### Bounded staging concurrency

Processing is **not fully serial anymore**. The application context owns one
shared [`processing-concurrency-service.js`](src/services/processing-concurrency-service.js)
limiter for all processing operations, including concurrent batches from
different projects. Its default capacity is `availableParallelism()`, clamped
to a minimum of 1 and a maximum of 4; every batch draws from that same
application-wide capacity rather than creating an independent pool.

Only selected staging and preparation work is bounded concurrently. Convert
stages outputs per asset. Watermark stages per source, keeping all outputs for
one source together and in their required order. Archive staging bounds each
entry's read, render, and buffer preparation. The limiter returns results in
input order even when workers complete out of order. On a worker failure, the
failed batch drains its already-running workers before it rejects, so rollback
cannot begin while another staging worker is still mutating temporary state.

Safety-critical phases remain serial and deterministic: operation
planning/preflight; final publication; repository and result mapping where
order matters; rollback/restoration; identity-sensitive publication and
rollback checks; and final archive compression, verification, and publication.
`7z-wasm` compression remains serial on the current path. Sharp/libvips is
configured once per process before application services are constructed:
Sharp concurrency is fixed at `1`, while its cache is explicitly pinned to
the installed Sharp 0.35.3 defaults of 50 MB memory, 20 files, and 100 items.
This keeps the shared `1..4` application pool as the owner of independent
image-pipeline parallelism instead of multiplying it by another CPU-sized
libvips pool. Worker-thread/C2 behavior has not been implemented.

### Plan then apply

Apply reserves a pending submission before awaiting planner work. The processing-job service counts that reservation as active work, then transfers it synchronously to the queued job when enqueue succeeds. Validation or planning failures release the reservation, so database restore and auth-context replacement cannot slip through the planning-to-enqueue boundary.

Processing is a two-phase contract, visible in the route surface as
`.../processing/<operation>/plan` and `.../processing/<operation>/apply`.

[`asset-processing-planner.js`](src/services/asset-processing-planner.js)
produces a **read-only snapshot**: it resolves scope, inspects sources,
derives output paths, detects conflicts and intra-plan collisions, and marks
blocked items — without mutating anything and, importantly, **without taking
the project lock**. A plan is advisory by construction.

[`asset-processing-service.js`](src/services/asset-processing-service.js)
applies. It takes the lock and **re-runs authoritative preflight from
scratch** inside it. A plan is never trusted as authorization; it is a
preview. Auto Rename adds a signed plan token on top of this — signed with
the context-scoped key described in §4, so outstanding tokens survive a
database restore — but the apply path still re-validates.

### Stage, publish, roll back

Every mutating operation follows the same shape:

1. **Stage** — outputs are written to a staging directory inside the project
   (never to the final destination), and originals that must be moved or
   deleted are staged aside rather than removed.
2. **Verify** — staged output is inspected and, where relevant, hashed.
3. **Publish** — staged artifacts are moved into place, and the database is
   updated to match.
4. **Roll back** — on any failure, staged files are removed and staged
   originals are restored, guarded by identity checks so a rollback never
   deletes or overwrites something it did not itself create.

Rollback is **identity-verified, never blind**. `{dev, ino}` captured at
staging time is compared before any removal, and a mismatch aborts the
cleanup rather than deleting an unproven path. Generated artifacts carry a
`sha256` so a destination can be recognized as previously generated by this
operation rather than as unrelated operator content — that check is what
allows a re-run to replace its own prior output while refusing to clobber a
file it does not own.

### Recovery over compensation

Some sequences cannot be safely undone, and the codebase says so explicitly
rather than attempting a best-effort reverse. The clearest case is
[`asset-action-service.js`](src/services/asset-action-service.js): if the
physical `fs.renameSync` succeeds but a later step fails, **no rename-back is
attempted**. The destination file is left alone and the caller receives
`RECOVERY_REQUIRED`, because renaming back races with concurrent actors and
could silently overwrite a newly created file. A rescan re-indexes whatever
is actually on disk.

The same principle governs `createCategoryDirExclusive` (never remove a
pathname whose occupant was not verified) and
`removeEmptyDirIfIdentityMatches` (an unreadable directory is never treated
as empty).

When you add a mutating operation, reuse this shape: plan read-only, apply
under the lock with fresh preflight, stage-verify-publish, identity-checked
rollback, and prefer a clear recovery signal to a risky automatic undo.

---

## 12. Preview generation and media delivery

Previews are a **rebuildable derived cache** under
`APP_DATA_ROOT/previews/projects/<project-id>/<asset-id>/`, with no database
persistence. Deleting the whole preview root is always safe.

[`preview-cache.js`](src/storage/preview-cache.js) defines the on-disk
contract, which is an atomic-set publication scheme:

- `tmp-<rand>/` stages a **complete** set (thumbnail, preview, meta).
- Once validated, the staging directory is renamed to an immutable
  `r-<revision>-<rand>/`.
- `current.json` is then replaced atomically (temp + fsync + rename). **That
  single-file replacement is the publication event.** A reader sees either
  the complete prior cache or the complete new one — never a mixed set.
- Stale revision directories are harmless derived data; cleanup is deferred
  by design rather than racing readers.

Directory names are always **server-generated**; a client-supplied revision
string never influences directory or pointer identity, and no absolute host
path is written into `meta.json` or `current.json`. Freshness is decided by
comparing recorded source size/mtime plus schema and derivative-config
version markers, so bumping the derivative configuration invalidates every
existing entry without a migration.

[`preview-service.js`](src/services/preview-service.js) owns generation and
holds a per-asset in-process lock so concurrent requests for the same asset
generate once. [`media-service.js`](src/services/media-service.js) sits above
it and turns the result into an HTTP response — ETag, `Cache-Control` chosen
by whether the client asked for the current revision, and a carefully
sanitized RFC 5987 `Content-Disposition` for original downloads.
[`media.js`](src/routes/media.js) maps `MediaError` subclasses to statuses
and nothing else.

Krita files are a special case: rather than rendering them,
[`krita-preview-extractor.js`](src/storage/krita-preview-extractor.js) reads
the embedded preview out of the `.kra`/`.krz` ZIP container through a bounded,
range-limited stream reader that refuses encrypted entries and enforces size
limits — it never extracts the archive to disk.

---

## 13. Background and automatic behavior

There is exactly one recurring background job:
[`automatic-project-scan-scheduler.js`](src/services/automatic-project-scan-scheduler.js).
It is created and owned by `server.js`, not by `createApp`, because it
outlives any individual app build.

Its architecturally interesting property is how it resolves dependencies.
The scheduler holds **no service references**. It is given a
`getScanDependencies()` callback and calls it fresh for every cycle *and
again for every project within a cycle*, so a live database restore between
two projects can never leave the cycle using a closed connection.

Other properties: disabled entirely when no interval is configured; a
non-reentrant overlap guard that skips (and logs) rather than queueing; the
first cycle fires after one interval, not at startup; per-project failures
are counted and logged without aborting the cycle; and cycle timestamps are
persisted to `app_meta` through the same fresh-resolution path, with
persistence failures logged rather than thrown.

Request-created processing jobs (§11) are separate from this scheduler: they
are in-memory, process-local work submitted by Apply rather than recurring
background tasks. The only other automatic behavior at startup is the one-shot
global watermark scan, which is best-effort and never blocks the server from
listening.

---

## 14. Authentication and security architecture

Authentication is **optional, browser-managed, and outside the database.**

**Identity lives in `APP_DATA_ROOT`, never in the environment and never in
SQLite.** Two managed files, both written atomically with `0600` permissions
and a directory fsync:

- an auth-enablement record (whether login is required, the session secret,
  and a CSRF pepper), handled by
  [`auth-state.js`](src/auth/auth-state.js);
- an operator credential record (username and password hash), handled by
  [`credential-provider.js`](src/auth/credential-provider.js).

`config.js` contributes only genuinely deployment-level settings — session
TTL, cookie `Secure`, proxy trust, HSTS — which apply whether or not auth is
currently enabled. This split is why a database restore cannot change who
can log in, and why enabling auth needs no redeploy.

**Fail-closed startup.** An absent enablement file means "never enabled" and
is lazily written as an explicit *disabled* state with a fresh pepper —
nothing identity-related is ever silently defaulted. An *enabled* state with
no credential file is a malformed configuration and aborts startup rather
than bootstrapping a default account.

**Transitions are centralized.** Every enable/disable goes through
[`auth-transition-service.js`](src/auth/auth-transition-service.js), which
enforces one ordering in one place: stage the file writes → invalidate all
sessions → adopt the new auth mode via the context's `replaceAuthConfig` →
roll the files back if adoption fails. Sessions are invalidated *before*
adoption, deliberately: the worst outcome of a failed transition is
"everyone was logged out and can log back in", never "the mode changed but
sessions were not actually revoked". Routes and the recovery CLI never touch
the managed files directly.

**Sessions** are server-side rows. The cookie carries an opaque token; the
database stores only its HMAC. Session state reaches templates solely
through `res.locals.auth`.

**CSRF** ([`csrf.js`](src/middleware/csrf.js)) is session-bound, not a plain
double-submit cookie. The token is `HMAC(session secret, "csrf")`, verified
in constant time, and destroyed with the session row. Two supplementary
modes exist because there is not always a session:

- *Login*: a short-lived, `HttpOnly`, `/login`-scoped anonymous cookie holds
  a secret from which the form token is derived, so the login form is
  protected without being exempted.
- *Auth-disabled*: state-changing forms are still protected, using an
  anonymous cookie combined with the persistent server-only pepper from the
  enablement file — which is exactly why the pepper is created even when auth
  has never been enabled.

**Other defenses**: a strict CSP with no inline script; `no-store` on
`/login`, `/settings/*`, and all HTML while auth is enabled; open-redirect
hardening on the post-login `next` parameter that bounded-decodes
percent-encoding and fails closed on malformed input; and bounded in-memory
login throttling keyed by username plus client address (forwarded addresses
are trusted only when proxy trust is explicitly configured).

**Recovery** is host-side by design:
[`scripts/auth-reset.js`](scripts/auth-reset.js) and
[`scripts/hash-password.js`](scripts/hash-password.js) require filesystem
access to `APP_DATA_ROOT`, so a lockout cannot be resolved over the network.

---

## 15. Backup and restore architecture

Backups cover the **SQLite database only** — never project media, previews,
or the managed auth files. That scope is intentional and is what makes a
restore safe: it can never modify artwork, and it cannot change who can log
in.

[`backup-service.js`](src/services/backup-service.js) is built once in
`server.js` and reused across restores, because it holds no connection
reference — callers pass a live `db` per call.

**Create** uses SQLite's online backup API (safe against concurrent readers
and writers), writes to a `.staging` file, switches the copy's journal mode
to `DELETE` so a managed backup is always exactly one file with no WAL
sidecars, validates it, and only then renames it into place. A failure never
leaves a valid-looking partial backup behind. Retention pruning runs only
after the new backup is installed, never deletes the backup just created,
and reports failures as warnings rather than turning a successful backup
into a failed one.

**Validate** rejects symlinks, non-regular files, and empty files, then
opens the candidate read-only and checks `integrity_check`, the presence of
`schema_migrations`, the required initial-migration marker, and — critically
— that it contains **no migration this application version does not know
about**, so a newer database cannot be restored into an older binary.

**Restore** is the only operation that replaces the live connection. Its
contract:

1. Only a managed filename resolved through `resolveBackupFile` is accepted
   (traversal, separators, symlinked components, and the `.staging`/
   `.rollback` shapes are all rejected).
2. It is validated again immediately before use.
3. The backup is copied to a staging file beside the live database and
   fsynced.
4. The live connection is checkpointed and **closed by this call**, then the
   live database (and its WAL/SHM) is renamed aside to `.rollback` and the
   staged file is renamed into place — all same-filesystem renames.
5. The new file is opened, migrated, and health-checked.
6. **On any failure after the original was moved aside, the original is
   restored and reopened**, and the resulting `BackupError` carries that
   recovered connection on `.db`. The prior database is never silently
   discarded.

The **maintenance boundary** is the caller's responsibility, and the
settings route drives it: it sets `maintenanceState.active` before starting
and clears it in a `finally`. It also checks that flag, the service's own
`isRestoreInProgress()` guard, and whether the processing-job service has
queued or running work. The first two checks close the near-simultaneous
restore-submission window; the job check refuses maintenance until active
processing is no longer using the current context.

Finally, the route adopts the connection: it wipes session rows on the
connection about to become live (a restored database may carry stale,
no-longer-trustworthy sessions) and then calls `replaceDatabase`. It does
this **in both the success and the failure path**, because a `BackupError`
carrying `.db` means the old handle is already closed and every route would
otherwise be left holding it.

---

## 16. Client architecture and Vite asset handling

The UI is **server-rendered Nunjucks with progressive enhancement**. Every
page works without JavaScript; client modules only enhance what the server
already rendered.

**Server-side rendering.** Templates live in [`src/views/`](src/views/), with
[`layout.njk`](src/views/layout.njk) as the shell and
[`src/views/partials/`](src/views/partials/) holding the shared component
macros (page headings, dialogs, dropdowns, status badges, empty states, the
inline-SVG icon macro, asset presentation cards). Nunjucks runs with
`autoescape: true` and `noCache: true`. Pages compose partials rather than
duplicating markup — several test suites assert that structural contract
(§17).

**Client-side enhancement.** [`src/static/creatorcrate.js`](src/static/creatorcrate.js)
is the aggregator: it imports focused modules from
[`src/static/client/`](src/static/client/), re-exports them for tests, and on
`DOMContentLoaded` runs each enhancer against `document`. The consistent
module contract is `enhanceX(root)` — idempotent, data-attribute driven,
delegated events, and a no-op when the relevant markup is absent. Shared DOM
helpers live in [`dom.js`](src/static/client/dom.js). Styling is one
stylesheet, [`creatorcrate.css`](src/static/creatorcrate.css), built on CSS
custom properties; inline presentation styles are actively tested against.

The processing enhancement turns an Apply `202` response into a centralized
HTTP polling loop for that dialog. It renders queued/running progress and
terminal success, failure, or cancellation from job snapshots. Closing a
dialog requests cancellation only when its locally known job is `queued`, never
when it is known to be `running`. If close precedes the Apply `202`, the client
makes the initial queued-cancellation attempt; a `409` means the job started in
the race, so it is retained and polling resumes when the dialog reopens. No
SSE/WebSocket transport is used for processing progress.

**Three asset modes**, resolved once by `resolveAssetMode(nodeEnv)` and
exposed to templates as `assetMode`:

| Mode | `NODE_ENV` | How the browser gets JS/CSS |
| --- | --- | --- |
| `production` | `production` | Hashed Vite bundle under `/vite`, resolved through the manifest |
| `development` | `development` | Vite middleware in-process: `/@vite/client` + `/client/main.js`, with HMR over the same HTTP server |
| `test` | anything else | The raw ES modules and stylesheet straight from `src/static/`, no build step |

The `test` mode is what lets the entire Vitest suite render real pages
without running a build.

**The Vite bundle entry** is [`client/main.js`](client/main.js), which
imports [`client/main.css`](client/main.css) (a single `@import` of the
application stylesheet) and the two static entry modules. So there is one
source of truth for client code, consumed either as raw modules or through
the bundler. [`vite.config.js`](vite.config.js) sets `base: '/vite/'`,
outputs to `dist/client`, and emits a manifest.

**Manifest resolution** ([`src/asset-manifest.js`](src/asset-manifest.js)) is
the strictest part of the client story, because manifest data becomes URLs in
rendered HTML. Every entry key, `file`, `css`, `assets`, `imports`, and
`dynamicImports` value is validated as a safe relative path — rejecting
backslashes, null bytes, `%`, `?`, `#`, `:`, leading `/`, and empty/`.`/`..`
segments — and every asset path is proven to resolve *inside* the dist root.
Import references must resolve to entries that actually exist. `entry(key)`
returns a frozen `{ js, css, preload, assets }` with static imports collected
depth-first and de-duplicated. Outside production the app installs
`createUnavailableAssetManifest()`, which throws if a template ever tries to
resolve a Vite asset in a mode that has no build.

**In development, Vite is a middleware in front of the app**, not a separate
server: `createDevelopmentViteServer` runs Vite in `middlewareMode` sharing
the Node HTTP server (so HMR uses the same port), and
`createApplicationRequestHandler` composes it with the app context so Vite
gets first refusal on each request and falls through to Express.

---

## 17. Testing architecture

Two suites with different jobs, configured by
[`vitest.config.js`](vitest.config.js) and
[`playwright.config.js`](playwright.config.js). Commands are in
[README.md](README.md).

**Vitest** ([`tests/`](tests/), `node` environment, no globals) is the
primary suite and covers several distinct kinds of test:

- **HTTP tests** (`*-http.test.js`) build a real app with `createApp` over a
  temporary directory and a migrated temporary SQLite file, then drive it
  with `supertest`. These are the main behavioral contract.
- **Service and repository tests** exercise a unit against a real migrated
  database, injecting fakes through the `createApp`/factory `opts` seam
  rather than mocking modules.
- **Storage tests** ([`tests/storage/`](tests/storage/)) target the path
  safety, atomicity, and symlink-refusal guarantees of §9 directly.
- **Migration tests** (`*-migration.test.js`) assert that a specific
  migration transforms data as intended — the schema history is covered by
  tests, not just by the runner.
- **Structural tests** encode architectural rules mechanically:
  [`route-boundary.test.js`](tests/route-boundary.test.js) (§6),
  [`app-construction.test.js`](tests/app-construction.test.js) (shared
  coordinator and single-instance wiring),
  [`asset-browser-parity.test.js`](tests/asset-browser-parity.test.js)
  (two pages must keep using the same shared macros),
  [`icon-contract.test.js`](tests/icon-contract.test.js),
  [`page-components.test.js`](tests/page-components.test.js) and
  [`visual-system.test.js`](tests/visual-system.test.js) (rendered-DOM
  contracts: one `<h1>` per page, no duplicate IDs, no nested interactive
  controls, no inline presentation styles, contrast and breakpoint
  containment).
- **Client-module tests** (`*-client.test.js`) import the enhancement
  modules and drive them against a synthetic DOM.
- [`vite-build.test.js`](tests/vite-build.test.js) runs a real build and
  validates the emitted manifest through the production resolver.

**Tests authenticate through the real routes.**
[`tests/helpers/auth.js`](tests/helpers/auth.js) logs in via `POST /login`,
extracts CSRF tokens from rendered HTML, and preserves cookie jars — it never
bypasses the security middleware. A parallel helper derives the
auth-disabled-mode CSRF token from the anonymous cookie and the pepper.
Unit tests targeting session internals may inject directly; integration
tests use the helpers.

**Playwright** ([`tests/browser/`](tests/browser/), Chromium, serial, single
worker) covers what a DOM simulation cannot: it boots a real server in both
development and production asset modes against temporary data directories,
verifies that Vite dev assets load and the HMR WebSocket opens, and that the
production build's hashed assets execute. It is a small smoke suite, run
separately and requiring an explicitly installed browser — not a second
functional suite.

---

## 18. The Windows "Open locally" helper

[`helper/windows/`](helper/windows/) is a **separate subsystem with its own
language, toolchain, and lifecycle**: a .NET 8 console application
(`OpenLocally`) that registers the `creatorcrate-open://` URI scheme per-user
under `HKCU`, plus an Inno Setup installer. It ships as a self-contained
single-file executable and is not part of the Node build, the Node test
suite, or the server process.

The boundary between the two systems is **one versioned URI contract**, and
nothing else:

```
creatorcrate-open://open?v=2&path=<absolute-windows-path>&select=<0|1>
```

The web side of that contract is [`src/util/open-locally.js`](src/util/open-locally.js)
— a **pure string builder** with no filesystem or database access and no
knowledge of `PROJECTS_ROOT` or any container path. It composes the absolute
Windows path from an operator-configured Windows projects root (stored in
`app_meta` via
[`open-locally-settings-service.js`](src/services/open-locally-settings-service.js))
plus the project directory and asset relative path, and it returns `null`
rather than an unsafe URI when validation fails. The helper independently
re-validates everything it receives; neither side trusts the other.

This design is why the server can run in Docker on Linux while the operator
opens files in Explorer on Windows: the server never resolves a host path,
and the helper never learns anything about the server's own layout. The
helper keeps no configuration of its own — the path is supplied with every
request.

[`downloads.js`](src/routes/downloads.js) serves the built installer from
[`downloads/`](downloads/) under **one fixed constant filename**; the route
never resolves user input, and an exported availability probe lets Settings
hide the download action when the artifact was not built into the image.

Changing the URI contract means changing both sides and bumping `v`. Adding
behavior to the helper does not touch the Node application at all.

---

## 19. Adding or changing functionality

### Where things go

| You are adding… | It belongs in… | And you must also… |
| --- | --- | --- |
| A new page or endpoint | a router in [`src/routes/`](src/routes/) | wire it in `createApp`; guard the mount if it needs a filesystem root |
| Domain logic or a multi-step operation | a service in [`src/services/`](src/services/) | construct it once in `createApp` with an `opts` override |
| A new query or table access | a repository in [`src/data/`](src/data/) | never import it from a route (enforced); reach it through a service rather than by taking `db` into a router — see §6 for what routers are handed today |
| A multi-step save that must be atomic | a service that owns the `db.transaction(...)` | the route-level transactions in `page-defaults.js` and `settings.js` are the existing exceptions (§8), not the pattern to copy |
| A schema change | a new `NNN_*.sql` in [`migrations/`](migrations/) | write forward-only; add a migration test |
| Anything that resolves a path or writes a file | [`src/storage/`](src/storage/) | validate independently — do not trust the caller |
| A new global setting | a small service over `app_meta` | no migration needed |
| Shared markup | a macro in [`src/views/partials/`](src/views/partials/) | reuse it; parity tests may assert you did |
| Browser behavior | a module in [`src/static/client/`](src/static/client/) | export an idempotent `enhanceX(root)`, register it in `creatorcrate.js`, and keep the page working without it |
| State that must survive a database restore | [`src/app-context.js`](src/app-context.js) | thread it through `buildApp` after `...opts` |
| A recurring background task | `server.js`, resolving deps through a getter | never capture a service reference directly |

### Checks to run against a design

- **Does it hold a lock while touching a project's files?** Any operation
  that mutates a project directory must run inside
  `projectOperationCoordinator` for that project — and a plan/preview must
  not.
- **Can it leave a half-applied state?** If so, restructure it as
  stage → verify → publish, with an identity-checked rollback. If a safe undo
  genuinely does not exist, return a clear recovery signal instead of
  guessing.
- **Does it delete or overwrite anything it did not create?** Capture
  `{dev, ino}` (or a content hash for generated artifacts) and verify before
  removing.
- **Does it assume the database connection is stable?** It must not. Resolve
  services through `app.locals` or a getter if you run outside the request
  path.
- **Does it leak an absolute host path** into an HTTP response, a log line, a
  manifest, or a cache metadata file? None of those may contain one.
- **Does it construct a repository that already exists?** Reuse the instance
  from `createApp`; a duplicate silently breaks the shared-instance
  invariants.
- **Is the router doing database work itself?** The boundary test only
  catches a repository *import*, so nothing will fail if a router runs SQL or
  opens a transaction with an injected `db`. Some already do (§6); adding
  more is a deliberate choice, and new query logic should go behind a
  service instead.
- **Does the page still work with JavaScript disabled?** Enhancement is
  additive.
- **Does it need a filesystem root?** Then both the service and its router
  must be conditional on that root being present.

### Things that are deliberately not architecture

Do not generalize from these: the `Phase ...` comments (historical markers),
the `opts.x || createX()` fallbacks (a test seam, not a plugin system), and
the `app.locals` surface (an escape hatch for out-of-band callers, not a
service locator for request handlers — routers receive their dependencies
explicitly).
