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
   `better-sqlite3` is synchronous, and the scanner and storage helpers all
   use `fs.*Sync`. Asynchronous code appears only where
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
| [`helper/windows/`](helper/windows/) | Separate .NET protocol helper for Open Locally and social-preparation activation (see §18) |
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
   the Express app around the open connection (see §4 and §5), then recovers
   the generated-image rebuild record, runs the publication lifecycle's
   synchronous `prepare()` (lifecycle record, unresolved-intent recovery
   set, durable repair admission; §12), and only then signals both
   background runners. Every later database adoption repeats that order.
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
- the **application logger and its active `application-log-repository`**. The
  logger retains one process-local identity; an auth-only rebuild reuses the
  repository already bound to the unchanged database, while a database
  replacement constructs a new repository and rebinds the logger only for that
  candidate. This preserves per-repository daily prune eligibility across
  same-database rebuilds without sending retained workers to a closed/restored
  database. The logger owns redaction and persistence policy, and sink failures
  remain non-fatal;
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

1. **Maintenance admission gate.** The very first middleware. While a restore
   holds `maintenanceState.active`, every request except exact `/health` and
   extension-shaped `GET`/`HEAD` static candidates gets a 503 (HTML or JSON by
   content negotiation) before body parsing, static lookup, or routing can
   touch a closing database. The
   `maintenanceState` object is shared **by reference** with the settings
   router and survives rebuilds; it is mutated, never reassigned. Static
   candidates are recognized by having a file extension — application routes
   never do. Exemption here is admission to the database-independent chain,
   not permission to fall through into application routing.
2. **Security headers** — CSP, `X-Content-Type-Options`, `Referrer-Policy`,
   `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and optional HSTS.
   The development CSP relaxes `style-src` and allows `ws:`/`wss:` for Vite
   HMR; every other mode uses the strict policy.
3. **Body parsing** — the ordinary application parser accepts JSON and
   URL-encoded forms through global `express.json()` and
   `express.urlencoded({ extended: true })` middleware.
4. **Static assets** — [`src/static/`](src/static/) at the root, and the
   Vite build output under `/vite` with long-lived immutable caching. Static
   files are served **before authentication**, which is why the auth
   middleware never has to reason about them.
5. **Database-independent maintenance termination** — while maintenance is
   active, the existing health router answers exact `/health` after security
   headers but before session resolution. After both existing static mounts, a
   second boundary returns the same maintenance 503 for every admitted request
   that remains, so extension-shaped misses cannot reach database-bound
   middleware. Outside maintenance this boundary is transparent and `/health`
   continues through the ordinary authentication chain to its normal mount.
6. **Social Preparation capability router** — its JSON and URL-encoded
   redemption endpoint follows maintenance, security headers, and body
   parsing, but deliberately precedes session resolution, ordinary CSRF, and
   `requireAuth`. The short-lived, single-use intent digest is its
   authentication; it must not be added to shared auth or CSRF exemptions.
   Redeemed helper media requests use a separate bearer capability boundary:
   authenticate the digest before revealing session state, then enforce the
   attempt deadline and authoritative state. The authenticated status probe is
   read-only; a platform status callback uses a session-owned conditional update
   and completes the redeemed session in that same transaction when its last
   owned non-terminal platform becomes terminal. Asset authorization is immutable
   from `social_prep_session_assets`; only file resolution uses the current
   asset and project rows through the hardened asset-file boundary.
7. **`resolveSession`** — resolves the session cookie into
   `res.locals.auth`. Exposes only safe state (`enabled`, `authenticated`,
   `username`, and the CSRF secret for the next middleware); never the raw
   token. A stale cookie is cleared.
8. **Cache policy** — `private, no-store` for `/login`, anything under
   `/settings`, and all HTML responses while auth is enabled.
9. **`exposeCsrfToken`** — must run after session resolution and before any
   handler renders a form.
10. **`requireCsrf`** — must run before the auth router so `POST /logout` is
   protected too. `GET`/`HEAD`/`OPTIONS` are exempt; login verifies its own
   pre-auth token.
11. **Auth router** (or, when auth is disabled, a `/login` redirect to
    Settings › Security, since there is no login form to render).
12. **Shell model** — `buildShellModel({ appName, path })` from
    [`src/shell/navigation.js`](src/shell/navigation.js) computes the
    navigation model once per request from `req.path` and puts it on
    `res.locals.shell`. **Routes never assemble navigation themselves**, and
    the error handler builds its own with `noActive: true` so a 404 never
    highlights a section the request never reached.
13. **`requireAuth`** — protects everything mounted below. It independently
    exempts `/health`, `/login`, and `/logout` regardless of mount order.
    HTML `GET`s redirect to `/login?next=…` (validated against open-redirect
    payloads); everything else gets a flat `401` JSON, so a mutation is
    rejected outright rather than answered with a redirect.
14. **Feature routers**, then a catch-all that raises a 404 `Error`.
15. **Centralized error handler.** Negotiates HTML (`error.njk`) versus JSON.
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
index, releases and release assets, Social Preparation session/platform/asset
snapshots (including hashed redemption material and attempt deadlines), notes/books/chapters and their
associations, tags and their project/asset joins, watermarks and watermark
scale maps, processing presets, generated artifacts, generated-image
publication snapshots and intents (written by preview publication and the
publication lifecycle; committed snapshots are the normal generated-image
serving authority, switched by the SQLite finalization transaction, while
`current.json` and revision-local `meta.json` remain filesystem
publication/recovery witnesses; see section 12),
project primary images,
per-project and global page defaults, independently persisted per-project/page
active-default scopes, sessions, and a generic `app_meta` key/value table.

`app_meta` deserves a note: it is the **application-scoped settings store**,
accessed exclusively through
[`app-meta-repository.js`](src/data/app-meta-repository.js) and wrapped by
narrow settings services (preview category, NSFW filter, Open-locally root,
dashboard and page defaults, default watermark, automatic-scan timing).
Adding a new global setting means adding a key and a small service, not a
migration.

Project Assets Global defaults are shared through `app_meta`, while Project-only
values are stored independently in `project_page_defaults`. The active
`global`/`project` scope for each Project and page is separate durable state in
`project_page_default_scopes`; Project option-row existence never selects the
active scope. Project-only rows may therefore remain dormant while Global is
active. When Project is active, each missing or invalid Project field falls back
to its Global value without materializing a Project row.

The Project Assets Defaults POST writes submitted options and the selected active
scope in one transaction, then resolves the live-refresh destination using that
persisted scope. Scope toggles use the existing serialized autosave queue and live
region engine, keeping the dialog open. Reloaded dialogs read persisted scope;
query parameters do not select a defaults scope. Global saves preserve every
project's stored Project-only values.

**Configurable Project options.** Projects retain `status` and `project_type`
as literal strings. Their configurable metadata lives in separate versioned
Project Status and Project Type catalogue documents in `app_meta`; each entry
owns a stable value, an immutable label, a color, and its catalogue order. The
Project-option catalogue service is the membership and mutation authority, and
the presenter supplies that metadata to Project forms, filters, cards, detail,
and Dashboard cards. Catalogue reads are live, so accepted changes do not
require an application restart.

Existing option labels cannot be renamed. The `tbd` Status value and `images` Type
value are seeded entries, not protected built-ins, and may be deleted once no saved
default references them. Settings supports adding,
reordering, recoloring, and deleting entries. A deletion is blocked while the value
is selected by an applicable persisted default, including the New Project Status or
Type default and global or Project-scoped Projects Status/Type filter defaults; saved
defaults are never silently remapped. Dashboard section state is not a deletion
blocker. If Projects reference an otherwise deletable value, the operator selects a
valid replacement from the same catalogue, and the catalogue service bulk-reassigns
all affected Projects and deletes the source atomically. A saved-default blocker is
checked before reassignment, so the combined case cannot partially update Projects
or the catalogue.

New Project Status and New Project Type are explicit persisted Page Defaults and
are the authority when creation omits either field. Migration 034 initially
materializes `tbd` and `images`, respectively. Creation validates each configured
value against the current editable catalogue and fails clearly when the setting is
missing, stale, or invalid; it does not fall back to either seeded value or to the
first catalogue entry. Consequently, deleting a seeded entry cannot cause omitted
creation to recreate or silently reuse it.

`archived` is a system operational Project state, not an editable workflow Status.
It is absent from the Status catalogue, reserved against ordinary addition, excluded
from New/Edit selectors and reassignment targets, and cannot be the New Project
Status default. The dedicated archive transition writes the operational state, while
Projects filtering and Dashboard retain system Archived views. Compatibility reads
treat a Project as operationally Archived when either `archived_at` is present or
the stored Status is the legacy literal `archived`.

Catalogue order controls editable Status option ordering. Dashboard section order
is persisted independently: normalization preserves surviving section order, removes
deleted workflow Status sections, incorporates newly introduced ones, and keeps the
system Archived section independently of catalogue membership.

Migration 033 rebuilt `projects` without the former fixed Status and Type enumeration
checks while preserving existing Project values and data. Migration 034 first
validates the persisted version-1 Status catalogue and aborts transactionally if it
is missing, malformed, or invalid; historical validation is pinned to the frozen v1
catalogue contract shared with runtime validation rather than drifting with future
catalogue versions. It then removes operational `archived` from the editable Status
catalogue, materializes missing New Project Status/Type defaults, and rebuilds
`projects` without database defaults on `status` or `project_type`. Existing data,
IDs, foreign keys, indexes, and the sequence are preserved. Both columns remain
required literal strings, but valid membership is owned by the application catalogue.
Removing the database defaults prevents static schema behavior from recreating a
catalogue option after an operator deletes it.

Note history stores old-state snapshots in `note_revisions`; each changed
`saveWithAssociations()` snapshots title, raw Markdown, and independent project
and asset ID sets before replacing the current Note, then prunes that Note's
history in the same transaction. Unchanged saves neither snapshot nor prune.
The retention limit comes from the `notes.revision_retention_count` `app_meta`
setting (default 10) through the Note revision settings service. Restore runs in
an outer SQLite `IMMEDIATE` transaction: it materializes the Note-scoped source
revision, verifies every historical association still exists, and invokes the
same save seam exactly once. Missing targets, malformed history, replacement
failures, and pruning failures therefore leave the current Note, associations,
and history unchanged. Historical reads do not require those live targets, so
deleted associations remain inspectable even when restore is blocked.
The Notes router exposes Note-scoped historical GET and restore POST routes,
projects only revision summaries into current detail, reuses the shared sanitized
Markdown and confirmation paths, and delegates restoration semantics entirely to
the Note service.

Book aggregate hierarchy validation is a read-only contract in
[`book-hierarchy.js`](src/services/book-hierarchy.js), not a mutation endpoint.
`parseBookHierarchyPayload()` accepts one JSON string containing exactly
`{ version: 1, expected, target }`. Each hierarchy is an ordered array of
`{ type: 'page', id }` or `{ type: 'chapter', id, pages: [pageId, ...] }` nodes;
IDs are positive safe integers, with no duplicate Chapters or Pages. Unknown
fields, nested Chapters, and root Page children are rejected rather than repaired.
`buildCurrentBookHierarchy()` validates ownership and complete root membership
before constructing the canonical sequence. Mixed root order comes only from
`book_contents.sort_order` (nonnegative safe integers, no ties; gaps allowed).
Chapter Pages use `notes.sort_order`, with the existing repository's ID tie-breaker;
neither `chapters.sort_order` nor root Page `notes.sort_order` determines root order.
`noteRepository.listAllForBook()` supplies every Page owned by `notes.book_id`,
including Chapter Pages, in deterministic ID order; `listForBook()` stays root-only.

`planBookHierarchy(snapshot, payload)` checks exact current/expected hierarchy
equality, then requires the target to contain the exact current Chapter and Page
sets. It returns detached current/target hierarchies, root target items, a Map of
Chapter target Page orders, changed Page destinations, and a `changed` flag.
Corruption raises `BookContentIntegrityError`; invalid submissions and stale
expectations raise `BookHierarchyValidationError` (a `BookValidationError`, with
`errors.hierarchy`; stale code `HIERARCHY_STALE`, status 409). The helper does not
read repositories, write, log, or call move/reorder methods.

`noteService.reorderBookHierarchy()` is the atomic persistence coordinator. Its
outer synchronous `better-sqlite3` immediate transaction rereads the Book, all
Chapters, all Book Pages, and root memberships; the transaction then reruns the
pure integrity, exact-expected, complete-target, and planning checks. A plan made
before that transaction is never accepted as authorization. True Page-container
changes run first through the existing private move coordinator, followed by the
exact mixed-root `bookContentRepository.reorder()` and every Chapter's exact
`noteRepository.reorder()`. A final authoritative reread and canonical equality
check occur before commit, so any move, membership, reorder, or verification
failure rolls the whole hierarchy back. Exact no-ops perform no writes. One
`book.hierarchy.reordered` activity event is emitted only after a changed commit;
the internal moves emit no per-Page events. No schema migration is required for
aggregate hierarchy persistence. `noteService.getBookHierarchy()` exposes the
same validated canonical read model to Book detail. The hosted Change Order form
submits exactly one versioned `hierarchy` JSON field to
`POST /notes/books/:bookId/hierarchy/reorder`; the route parses through
`parseBookHierarchyPayload()` and delegates persistence only to
`reorderBookHierarchy()`. Initial and stale renders use the current hierarchy for
both `expected` and `target`; a safe non-stale 422 rerender may retain the submitted
target while rebuilding all labels from current server entities. Stale submissions
return 409 with the current hierarchy, and current-integrity or persistence failures
remain server errors. The template opts into the connected mode in
`dedicated-reorder.js`; the legacy flat adapter remains unchanged for its existing
consumers. The Book hierarchy section renders Page and Chapter titles as plain text.
Connected mode owns one editor-wide drag state, uses each Page or Chapter card as the
drag surface, and enumerates direct children
of explicit hierarchy containers, accepts Chapters only at root and Pages at root or
in Chapters (including empty Chapters), and serializes the current DOM into only the
form's `data-book-hierarchy-input` after successful drag mutations. The original
`expected` hierarchy remains immutable, hierarchy movement sends no request, and Save
remains the sole aggregate POST. The same editor-wide controller handles Page and
Chapter Up/Down/Home/End movement within the current container through the existing
keyboard handle, focus restoration, and hierarchy-scoped live announcements. Page
ownership is always derived from its current DOM container. After app-dialog
enhancement, the controller composes with its existing
open/close lifecycle hooks. It captures the hierarchy actually rendered for the
current response as the loaded baseline (not `expected`), restores the existing item
nodes structurally on unsaved X/Escape close, and regenerates `target` while preserving
`expected`; backdrop clicking does not close this dialog. A native form-submit guard
prevents close restoration from replacing a
genuine Save draft before navigation. The legacy root-only reorder and Page Move paths
remain independent and available.

Book Page-preview configuration is deliberately not global metadata. Migration
030 adds one `book_page_preview_settings` row per configured Book plus the
`book_page_preview_pages` membership table. No row means the domain defaults
`random` mode, count `5`, and no selected Pages; defaults are resolved without
backfilling storage. The repository replaces the settings row and complete
selected-ID set in one SQLite transaction, while the service validates the
`random`/`selected` mode, the inclusive `1..25` count, and canonicalizes IDs.
Reads join selections back to `notes.book_id`, and writes reject missing or
foreign Pages, so Book ownership is enforced below the HTTP/UI layer. The
existing Book Defaults POST validates both the global navigation preference and
Book-scoped preview submission before saving either, then uses the shared page-
defaults custom-save hook inside one outer database transaction. This keeps the
single visible Save atomic across `app_meta` navigation and both Book preview
tables, including when either persistence path fails.
Foreign keys cascade Book and Page deletion. An `AFTER UPDATE OF book_id`
trigger removes the old Book's selection only when Page ownership changes;
Chapter/direct moves within one Book retain it, and moving away then back does
not resurrect it.

Book detail is the preview consumer. `renderBookDetail()` reads these settings
through the Book-scoped service and resolves them against the same authoritative
`listBookContents()` hierarchy already used by its navigator and Defaults dialog.
The hierarchy is flattened in Book order, including direct and Chapter-contained
Pages. Random mode samples eligible Pages without replacement on each request and
restores Book order for presentation; Selected mode filters stored IDs through
that catalogue. Every valid Book Page is eligible because Book detail has no
current Page. The existing `resolveBookPagePreviews()` resolver supplies the shared
`partials/book-page-previews.njk` partial. Page detail does not load preview settings
or build a preview model for rendering; it retains hierarchy resolution, Book
cover/navigation, Edit, and conditional Project/Asset associations.

Book detail presents the Book cover and polished navigation in the left column
and Page previews in the main column; the redundant main `.book-outline` is
retired. New/Edit Page dialogs reuse the polished navigator inside a native outer
Book-contents disclosure. That disclosure is presentation-only, starts collapsed,
and has no persisted default; its inner Chapter disclosures retain their own
navigation state semantics, with no duplicate Book cover in the dialog. Chapter
detail reuses the Book-cover presentation pipeline and polished shared navigator,
retains its Book ancestor link, and automatically opens the current Chapter
independently of the Book-detail navigation default. On Page detail, suppression of a leading Markdown H1
applies only to rendered output when its visible text matches the Page title.
Stored Markdown and the Edit form value remain unchanged, and other headings
continue to render.

**Transactions are normally owned above the repository layer, by a service or
a narrow coordinating route.** Repositories expose statements and
single-purpose operations; a caller composes them with `db.transaction(...)`
when several must succeed together. Repository methods normally avoid opening
nested transactions, so the caller's transaction can roll the whole unit back
— `projectService.create` relies on exactly this.

`book-page-preview-settings-repository.replace()` is an intentional exception:
it owns the atomic replacement of its settings row and complete membership set.
When Book Defaults calls it inside the outer Defaults transaction,
better-sqlite3 nests that transaction as a savepoint. The inner replacement is
therefore savepoint-safe, and any failure still propagates to roll back the
combined Defaults operation across `app_meta` and both preview tables.

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

### Application logging

Application logging is a process/application-context concern, not a service-local
one. The context creates one `applicationLogger` and the composition root
injects that identity into the services and routers that record it. The logger
owns record shaping, redaction, persistence selection, fallback, and retention;
callers supply only a bounded, domain-relevant event. Services do not construct
loggers of their own.

A log has a **level** — `debug`, `info`, `warn`, `error`, or `fatal` —
and a separate **kind**: `activity` for a committed user-visible/domain
outcome and `diagnostic` for operational state or failure information.
`info` and above persist by default. `debug` persistence is controlled only
by the deployment setting `PERSIST_DEBUG_LOGS`: it defaults to `false`, and
configuration accepts `true` and `false` case-insensitively after trimming
surrounding whitespace; other values are rejected. There is no mutable UI
logging-level setting.

Migration 026 adds the SQLite `application_logs` table, using the existing
`better-sqlite3` connection. Its optional project ID deliberately has no
foreign key, so historical records survive project deletion. Records contain
bounded structured context and are retrieved deterministically newest first.
The repository keeps at most 90 days and 50,000 rows. The logger attempts a
prune when an application graph is built and, after a successfully persisted
record, no more than once per 24 hours for each active repository identity.
An auth-only rebuild reuses the same repository and therefore its eligibility;
a genuine database replacement creates and rebinds a replacement repository.

Logging is observational: a repository/sink failure must not alter primary
application behavior. Persistence failures use the logger's direct console
fallback where available; optional context gathering is likewise isolated from
the operation it describes. Critical dependency-injection boundaries, including
the final unhandled-5xx diagnostic, additionally contain a throwing injected
logger. Failures that happen before persistent logging exists, such as migration
startup failures, remain console-visible.

Privacy is an explicit boundary, not a compliance claim. The logger persists
bounded structured context built from safe numeric IDs, aggregate counts, enums,
and (where useful) sanitized error identity/message. It intentionally excludes
credentials, authentication/token/CSRF/session/cookie values, request bodies,
raw processing options, stack traces, absolute local paths, and arbitrary
user-authored content when an ID or count suffices. The resulting viewer is an
operational/activity log, not a tamper-resistant audit system.

Settings → Logs **Export logs** is a read-only `GET /settings/logs/export`
returning one UTF-8 TXT attachment of every entry matching the level, kind,
subsystem, and time filters, across all pages. Absent filters resolve through
saved Logs defaults; an explicitly empty filter means unfiltered. Page, page
size, and auto-refresh never affect the export. The export is built fully in
memory and refused with a controlled error above 50,000 matching entries or
20 MiB of output. Text redaction is best-effort, and the file tells readers to
review it before sharing. The viewer requests it with the current filter
controls (empty values included) via fetch, saves only a `text/plain`
attachment under the server-provided filename, and shows JSON, authentication,
and network failures as status text without leaving the page.

The same logger identity survives an application-context database replacement.
It is rebound while a candidate app is built; a failed candidate restores the
previous repository/state. A restored backup runs migrations before publication,
and `backup.restored` is recorded only after the restored app and database are
active, so that record belongs to the restored database.

Instrumentation records committed outcomes rather than endpoint receipt:
semantic no-ops are normally silent, bulk operations use aggregate committed
counts, and cascades/internal maintenance avoid activity spam. There is no
blanket per-request, polling, or progress logging. High-value coverage spans
processing; projects and scans; assets, categories, and tags; releases;
Books, chapters, and notes; Settings, security, and authentication; backups;
and runtime diagnostics.

The `processing-job-service` is the central owner of processing job lifecycle
entries — queued, started, succeeded, failed, cancelled, and rejected
cancellation. Recovery and resource events remain separate so they do not
duplicate the job lifecycle. Runtime diagnostics cover completed migrations,
the initial Watermark scan outcome, server readiness, requested/completed
shutdown, and the final unhandled 5xx boundary. The initial Watermark scan is
distinct from user-triggered Watermark processing; migration failures before a
logger exists remain console-only.

---

## 9. Filesystem and storage architecture

[`src/storage/`](src/storage/) is the boundary between domain code and the
filesystem. Its job is to make unsafe filesystem operations impossible to
express, and it deliberately **does not trust upstream validation**.

Two roots, with different ownership:

- **`PROJECTS_ROOT`** — operator media. CreatorCrate creates and manages
  project directories and their category subdirectories, but the operator is
  expected to add and edit files directly (including over SMB). Project
  directories are **flat direct children** of `PROJECTS_ROOT`, named
  `<zero-padded-id>-<slug>`. They hold artwork/content only: project and
  category business metadata lives in SQLite (see **Legacy `project.json`**
  below), so a project directory on its own is not a complete CreatorCrate
  recovery or interchange format — database backups are.
- **`APP_DATA_ROOT`** — application-owned. The SQLite database and its WAL
  sidecars, `backups/`, `previews/`, `assets/`, and the managed auth files. Only
  CreatorCrate writes here.

`managedAssetRoot` derives from `appDataRoot/assets`, never the database's
parent directory or `PROJECTS_ROOT`; the existing app-data mount persists it.
Migration 029 adds `managed_assets`: string identity, unique relative storage
key, namespace (initially `book-covers`), verified MIME type, byte size,
dimensions, SHA-256 and creation time. These records have no Project ownership.
The SQL-only managed-asset repository accepts committed metadata and provides
single-record reads and a reference check; it does not perform filesystem work.

WP7A2 adds `managed-image-service.js` and Project-independent
`storage/managed-asset-storage.js`. `app.locals.managedImageService` exposes
`createCommittedImage({ bytes, namespace: 'book-covers' })`, returning
`{ record, ownershipToken }`. Only a Buffer containing one still PNG, JPEG or
WebP is accepted: at most 10 MiB encoded, 40 million pixels, and 16,384 pixels
per axis. Sharp verifies format and fully decodes with warning failures enabled;
APNG animation control chunks are independently rejected. WebP validation walks
the complete RIFF chunk framing and zero padding, requiring exactly one still
VP8/VP8L payload with optional extended-header/alpha and metadata chunks; animation,
duplicate image payloads and nested RIFF content are rejected. Filenames and MIME
hints are not inputs to storage or validation. Original bytes are preserved.

Private writes are flushed under `assets/.staging/operation-<random>/source`.
After validation, a hard link exclusively publishes
`book-covers/<generated-uuid>/source.<png|jpg|webp>` beneath the managed root.
Directory/file collisions fail without replacement; no API modifies published
originals. Links at or below the managed root are rejected. As with existing
identity-guarded filesystem operations, the configured parent and filesystem
must be application-controlled; this is not protection against a hostile local
process racing individual filesystem calls.

**Book-cover multipart foundation (WP7D1).** `services/book-cover-multipart.js`
exports `parseBookCoverMultipart(req)` for an unread multipart request, returning
`{ fields, cover }`; `fields` is a null-prototype string map and `cover` is null
or `{ bytes: Buffer, size }`. WP7D2A/WP7D2B mount the same HTTP adapter only on
`POST /notes/books` and the numeric `POST /notes/books/:bookId` Edit endpoint
for multipart requests (not reorder, delete, or nested Book actions). Ordinary URL-encoded Book forms
and the global CSRF middleware remain unchanged.

Direct production dependency Busboy 1.6.0 streams into bounded memory: one file
named `cover`, inclusive 10 MiB file maximum, 16 text fields, 100 UTF-8 bytes per
field name, 8 KiB per field value, and 100 KiB total decoded field names plus
values (matching the existing URL-encoded parser's default overall body budget).
An additional 11 MiB wire-body ceiling bounds multipart framing, preamble and
epilogue; an 18th multipart part is rejected, including skipped parts.
Duplicate text names are rejected rather than silently overwriting
values, including `_csrf`. Busboy also bounds each part header to 16 KiB.
Only a zero-byte part with an empty or omitted filename and generic
`application/octet-stream` MIME is normalized to no cover, matching an untouched
optional browser file input. A named zero-byte file remains an upload candidate
and is rejected by the unchanged image validation. Filename and declared MIME
are otherwise discarded; WP7A remains authoritative for image eligibility.
No filesystem APIs, staging, managed ingestion or Book mutation are
used. File chunks and the final concatenation can coexist briefly (about 20 MiB
at the file maximum, plus bounded parser/request buffers).

The `middleware/book-create-multipart.js` adapter parses before the existing
global `requireCsrf` gate, sets `req.body = result.fields`, and lets that gate
validate `_csrf` against the session or auth-disabled visitor token.
The existing `X-CSRF-Token` path is also supported. Parsing is not authorization;
never exempt multipart or defer CSRF until after ingestion/mutation. Merely
adding a parser inside the current Book router is too late for native multipart
tokens because the global gate precedes that router.

Failures reject with `BookCoverMultipartError` and fixed `code`, `status` and
`message` (400 malformed/duplicate/unexpected files, 413 limits, 415 wrong type).
Adapters must serialize only those safe properties, never stack, body or bytes.
On streaming failure the helper unpipes/pauses the request, destroys its parser
and releases retained chunks; it leaves the response socket available. The
HTTP adapter sends the safe error and closes the connection for an unread
failed body rather than resuming an unbounded drain. Existing installations need
the normal `pnpm install` dependency upgrade; no migrations or native builds
are introduced by this parser.

**New Book upload orchestration (WP7D2A).** Multipart without a file uses the
unchanged `bookService.createBook` path. With a cover, the adapter first calls
`bookService.validateCreateBook`, reusing the service's existing normalization
without mutation. Ordinary validation errors retain the 422 hosted New Book
dialog, submitted title and errors. No file selection is restored or UI added.
After CSRF and validation, WP7A `createCommittedImage({ bytes, namespace:
'book-covers' })` completes outside any Book transaction; WP7B
`createBookWithManagedPrimaryImage` then atomically creates the Book and selects
the managed source. Existing service activity logs follow durable commit and
the destination remains `/notes/books/:id`.

If compound save fails, the operation token goes through WP7A
`rollbackCommitted` before `compensate`. A refused/uncertain cleanup stops safe
deletion and surfaces a sanitized 500 `RECOVERY_REQUIRED`, overriding ordinary
validation failures. Invalid images return a sanitized 422; parser errors keep
their fixed 400/413/415 distinctions. Logs never receive upload bytes, filenames,
paths or raw parser errors.

Parser aborts release transient buffers. Before ingestion and after it settles,
the adapter checks request abort/response destruction; a disconnected request
does not proceed to Book creation and uses guarded cleanup for its ingested
source. WP7A has no mid-decode cancellation hook, so in-flight ingestion settles
before cleanup. Once the synchronous Book transaction succeeds, disconnects
never undo the Book or source and no automatic retry occurs. Cross-context replacement protection is described under WP7D3B2 below.

**Edit Book upload orchestration (WP7D2B).** URL-encoded and multipart no-cover
updates use the unchanged `updateBook` path and hosted Edit Book 422 rerender.
With a file, `middleware/book-edit-multipart.js` preflights ordinary fields via
`validateUpdateBook`, then reuses WP7D2A's request-local ingestion/rollback helper.
WP7E must submit `expectedCoverKind=none|project_asset|managed_asset` and
`expectedCoverId` (empty/omitted for none, canonical positive integer for Project,
exact opaque string for managed). Either existing kind additionally requires
`coverReplacementConfirmed=true`; missing/false confirmation fails before ingestion.
These fields are ignored without a file. No file restoration or upload UI is added.
The expected identity is always passed to WP7B's compound
`updateBookWithManagedPrimaryImage` transaction: confirmation cannot bypass its
source-kind-and-ID check. A stale identity returns sanitized `409 STALE_SOURCE`,
rolls back Book fields, and triggers guarded WP7A rollback then compensation of
the newly ingested source. Claiming `none` cannot replace an existing cover.
Successful replacement retains the old Project asset or managed row/file.
Cleanup uncertainty returns sanitized `500 RECOVERY_REQUIRED`; disconnect handling
is shared with New Book, including no undo after durable commit. Upload controls
and replacement warning dialogs remain WP7E; active-upload tracking is shared through WP7D3A.

**Managed-upload admission (WP7D3B1).** `services/managed-upload-tracker.js`
owns one process-local singleton, exposed as `app.locals.managedUploadTracker`.
`begin()` synchronously registers an independent operation or returns `null`
while admission is closed. Handles retain `signal`, `cancel()` and idempotent
`complete()`; `activeCount` / `hasActive()` count all admitted nonterminal
multipart Book requests, including requests without a cover. Uploads remain
concurrent, with no queue.

The first maintenance middleware in `app.js` admits multipart New Book and
numeric Edit Book POSTs before `next()`, session resolution, parsing or CSRF.
The existing case-insensitive, optional-trailing-slash matching and multipart
content-type recognition are shared with the parser mounts. The request carries
one lease into New/Edit orchestration; ingestion never registers another lease.
Parser and route finally boundaries hold it through prevalidation, image work,
compound saves, rollback/compensation and asynchronous validation rendering.
Callback-based template rendering also holds ownership. Response end/terminal
handler completion releases only after all those holds settle; socket close
alone is not terminal (even router fallthrough may defer `next()`). Parser,
CSRF/auth, no-cover, validation, recovery-required and response-write failures
all use the same lifetime. Recovery artifacts do not keep settled work active.
Disconnect signals cancellation without releasing ownership. In-flight ingestion
settles before guarded cleanup; durable Book commits are never undone on disconnect.

`tryBeginMaintenance()` synchronously returns `null` if admission is closed or
any upload is active; failure changes/cancels no operations and leaves admission
open when it was open. Otherwise it closes admission and returns an opaque owner
capability with idempotent `release()` (true only for its current ownership).
A stale release cannot release a later owner. `bindMaintenanceState(state)` binds
the existing shared object's `active` property to the authority's closed state.
Legacy boolean maintenance writes remain compatible, but clearing
them cannot release token ownership. Maintenance-first uploads receive the
unchanged 503 response before parser, CSRF, prevalidation or ingestion.

**Replacement ownership (WP7D3B2).** Database/context replacement and auth
transitions reuse this same singleton. `beginReplacement()` synchronously
acquires maintenance, then runs `assertNoActiveProcessingJobs()` while upload
admission is closed. Upload or processing conflicts refuse without cancellation,
waiting, or changing live resources; only the attempted owner is released.
Capabilities are bound to the originating connection and current graph identity.

Settings holds its owner across validation, asynchronous restore, old-DB close,
verification/recovery, and awaited graph adoption. Immediately before checkpoint
and close, `restoreBackup(filename, db, owner)` validates authentic, still-current
ownership. Unowned or delayed stale calls cannot retire a connection. Adoption
accepts the existing owner without reacquisition; direct replacement acquires its
own. Rejected candidates are still closed, never the current live connection.

Pre-close failure releases maintenance with the original usable graph intact.
Recovered connections are adopted before release. Post-close failure without a
usable adopted graph keeps admission closed and uses the existing error handler.
Successful restore activity is logged only after adoption. Auth enable/disable
hold ownership from the existing conflict seam through session invalidation,
rebuild and rollback. Every graph retains the same tracker and active counts.

**Shutdown drain (WP7D3B3).** At shutdown entry, the same process tracker calls
`beginShutdown()` synchronously before any asynchronous gap. Admission remains
closed permanently, including after maintenance-owner release, legacy flag writes,
and graph replacement. The existing maintenance middleware refuses New/Edit
multipart requests before parsing. Shutdown stops the scan scheduler, closes Vite,
and awaits HTTP server close, then drains managed uploads and accepted processing
work before logging completion, closing the current database and exiting. The
processing drain includes planning reservations and queued or running jobs, whether
they succeed or fail. Tracker-owned promise waiters resolve on
the final lease completion (or immediately when idle), without polling or timeout.
Disconnect cancellation does not release a lease: graph-dependent cleanup must
settle first. Shutdown does not cancel uploads, undo durable commits, or delete
retained recovery artifacts. Restore remains fail-fast; no processing admission
gate is added. Cross-restart
tracking and staging recovery remain deferred.

**Managed media foundation (WP7C1).** `managed-media-service.js`, composed as
`app.locals.managedMediaService`, is independent of Project context. Its ID-only
`resolveSource(id)` returns verified owned bytes, a record snapshot and revision;
`getDerivative(id, 'thumbnail' | 'preview')` returns WebP bytes, dimensions,
revision and cache-hit status. It accepts only committed Book-cover UUID/source
keys produced by managed ingestion. Containment, non-symlink component checks,
device/inode checks around a bounded read-only descriptor read, committed size
and SHA-256, format/dimensions and full decoding gate every request, including
cache hits. The decoder never reopens the original path. The same local-writer
race limitation described above applies; the root's ancestors are trusted config.

Managed derivatives use `previews/managed-assets/<id>/<revision>/<kind>.webp`.
The revision hashes source ID/key/hash/metadata, the shared derivative version
and actual shared sizing/quality configuration. The existing preview service's
source-neutral Sharp pipeline is reused unchanged: auto-orientation, inside fit,
no enlargement, metadata stripping and WebP (thumbnail 256px/quality 80;
preview 1600px/quality 90). Source-neutral preview-cache containment/directory
and atomic-write helpers are shared. Each independently requested derivative is
atomically published, so no Project-shaped metadata or two-file pointer is needed.
Cache reads require still WebP, expected dimensions, stripped metadata and full
decode; absent/corrupt cache data is rebuilt under per-ID FIFO serialization.

Missing, unsafe, unreadable or invalid sources raise `ManagedMediaError` with
`MEDIA_UNAVAILABLE`; cache infrastructure failures use `CACHE_UNAVAILABLE`.
Neither path mutates originals, managed records or Book selections. WP7C2 serves only
`GET /managed-assets/:id/thumbnail` and `/managed-assets/:id/preview` behind the
existing application authentication boundary, with no static managed-root mount.
Routes pass only ID and fixed kind to the service and return its derivative MIME
type and bytes with `nosniff` and private revalidation caching. Source failures
return safe 404 responses; cache failures return 503, both with `no-store`. Old derivatives are rebuildable cache;
garbage collection remains deferred.

Only after publication does the service synchronously insert verified metadata
through the repository (including its default creation timestamp). Filesystem
and SQLite commits are not atomic. Failed persistence removes only operation-owned
files and directories, checked by operation-captured device/inode identity (also
shared by the staging/publication hard link). Mutable timestamps, including
fallback birth times, are not identity components; unavailable stable IDs fail
closed. Uncertain ownership or
persistence retains files and returns a sanitized `RECOVERY_REQUIRED` error.
Operation staging is cleaned on success and failure without recursive deletion.
After a later Book/database failure, call `rollbackCommitted(ownershipToken)`
on the creating image-service instance, then `compensate(ownershipToken)`.
The first step removes only that operation's still-unreferenced database record;
the second removes only its positively identified file and still refuses while
the record exists. These are separate explicit operations, not general deletion.
The SQL-only repository's `rollbackCommitted(record)` requires the exact object
returned by its own `insertCommitted`, not an ID, copied record or lookup result.
It returns false on refusal; the service reports `ROLLBACK_REFUSED` (or
`INVALID_TOKEN` for an unknown token). The delete atomically checks all original
metadata, a private creation receipt and absence of Book references.
Connection-local TEMP receipts/triggers invalidate ownership on row mutation or
replacement, even when metadata is identical, without changing migration 029.
Rollback also refuses after another connection commits: its writes cannot be
observed by the TEMP triggers. This intentionally conservative check favors
retention over uncertain cleanup. Receipts disappear when the connection closes;
tokens are not restart/recovery credentials. No synchronous SQLite transaction
is held across asynchronous image ingestion.

The ingestion/storage layer itself exposes no arbitrary filesystem or static routes;
the application serves only the authenticated fixed managed thumbnail/preview routes
described above, without statically serving `APP_DATA_ROOT`. Managed-upload admission
and request lifetime, maintenance ownership, destructive restore/database/context
adoption coordination, auth-transition conflict protection and shutdown drain are
implemented as described above. Cross-restart stale `.staging` recovery and crash-recovery
cleanup beyond current-process lifetime guarantees remain deferred. No startup sweeps
are added; committed files are never swept for being unreferenced.

`book_primary_images` retains its Book primary key and existing Project Asset
cascade foreign key, with exactly one of `asset_id` or `managed_asset_id` set.
The managed foreign key restricts deletion of referenced records. Existing
selections remain Project Asset references without moving files. Committed
managed originals may remain unreferenced: clearing a selection or deleting a
Book does not delete them. This is persistent original storage, not a rebuildable
preview cache; no garbage collection or backup archive redesign is introduced.

**Book cover domain (WP7B).** `book-primary-image-service` remains the single
selection authority. Repository records include both nullable foreign keys and
an explicit `source: { kind: 'project_asset' | 'managed_asset', id }`; replacing
a cover always clears the other foreign key. Source-aware expected checks and
guarded clears compare both kind and ID, including an explicit `null` expectation
for no cover. Legacy Project selection, lookup and guarded-clear APIs retain
their Project-only meaning.

Managed selection accepts committed `book-covers` records with verified PNG,
JPEG or WebP MIME metadata from WP7A, without Project eligibility or tagging.
Book presentation adds `selectedSource`; `selectedAssetId` remains Project-only.
The asynchronous Book presentation boundary verifies managed sources through
`resolveSource`: available covers receive managed thumbnail/preview URLs; missing
or corrupt sources retain their selection with `source_unavailable` and no URLs.
The shared cover partial remains source-neutral; no Project identity is invented.
Notes applies Project/tag-derived NSFW classification only to Project sources.

Book service's `createBookWithManagedPrimaryImage` and
`updateBookWithManagedPrimaryImage` compose validated Book writes with selection
through the existing authority's synchronous `saveBookWithManagedPrimaryImage`.
That operation owns the outer SQLite transaction; Book and cover completion logs
are emitted only after commit. It accepts no image bytes and performs no ingestion.
On failure the caller retains WP7A's ownership token and may invoke
`rollbackCommitted(token)` followed by guarded `compensate(token)`; neither
replacement nor clearing deletes a previous managed original.

The Project filesystem safety rules, all implemented in
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

**Legacy `project.json`.** SQLite is the sole runtime authority for project
and project-category metadata (title, slug, description, notes, link, status,
type, category names/slugs/order/enabled state). Earlier versions also wrote a
duplicate `project.json` manifest into each project directory; CreatorCrate no
longer creates, requires, reads, validates, or rewrites it during normal
operation:

- Project creation produces the database rows, the directory tree, and the
  `.creatorcrate-owner` ownership marker (below) — never a manifest.
- Metadata updates, archiving, and project-category mutations (add, rename,
  enable/disable, reorder, delete) are database operations; only real
  directory work (creating, enabling, or deleting a category directory)
  touches the filesystem, and only that work carries filesystem
  compensation.
- A slug-changing rename proves directory ownership without any manifest,
  through the ownership witness below: the source path comes only from the
  stored `project_dir` (never from the request), `resolveProjectDir` enforces
  a direct, symlink-free child of `PROJECTS_ROOT`, the directory name must
  carry the project's unique zero-padded database ID, the source must be a
  real directory carrying the project's bound marker, and the destination
  must not exist. If the stored-path update fails after the move, the
  directory is moved back.

Manifests already on disk — valid, stale, corrupt, unsupported-version, or
naming another project ID — are ignored by normal operation; one simply moves
with its directory on rename and is never imported into SQLite. The scanner
keeps skipping `project.json` and the legacy writer's temp pattern
(`.{hex}.project.json.tmp`), so they are never indexed as assets.
[`manifest.js`](src/storage/manifest.js) retains only the legacy format's
parsing, validation, and serialization definitions. Its runtime readers are
`readLegacyManifestEvidence`, used by PM-1C1 ownership adoption (below) as
one-time upgrade evidence of a project ID, and the PM-2 legacy manifest
cleanup lifecycle (below), which removes only manifests proven to be exact
duplicates of SQLite state and retains everything else. No request path calls
this module.

**Project-directory ownership witness.** Removing the manifest also removed
its role as evidence that the directory at a stored `project_dir` is still
*that* project's directory. Its replacement is a two-part witness:

- SQLite table `project_directory_ownership` (migration 042) binds a project
  to an opaque 64-character lowercase-hex token from `crypto.randomBytes(32)`,
  with state `pending` (token persisted, marker not yet confirmed) or `bound`.
  No row means unbound. Rows cascade with their project.
  [`project-directory-ownership-repository.js`](src/data/project-directory-ownership-repository.js)
  offers only conditional, exact-(project, token) transitions: create pending
  without replacing an existing row, pending → bound, and removal of a pending
  row.
- A `.creatorcrate-owner` marker, a direct child of the project directory,
  containing exactly `creatorcrate-owner/1 <token>` plus one LF and nothing
  else — no title, slug, ID, category, status, or timestamp. It is filesystem
  ownership metadata, not a business-metadata sidecar.
  [`project-ownership-marker.js`](src/storage/project-ownership-marker.js)
  generates tokens, creates the marker exclusively (never overwriting any
  existing entry) with fsync and read-back verification, and reads it
  strictly (bounded size, regular non-symlink file only), reporting
  `missing`, `malformed`, `unsafe`, and `unreadable` distinctly so I/O
  uncertainty is never mistaken for an ownership mismatch.

The witness represents **logical** project ownership, not physical directory
identity: no inode or file ID is persisted, and a marker-preserving move or
copy of the project tree carries the same token — a legitimate same-project
rename therefore keeps a valid binding. Operations may still compare `dev/ino`
*within* one mutation for continuity; that identity is never stored.

**New projects are bound at creation.** Inside the single creation
transaction: insert the project row → generate a token and insert it as the
project's `pending` row → exclusively create the project root (an existing
directory is never adopted) → create category directories → exclusively
create the marker (read back and verified) → mark exactly that
(project, token) `bound` → store `project_dir` → commit. Because every
database write, including the pending and bound transitions, lives in that
one transaction, a failed or interrupted creation leaves no project row and no
ownership row; compensation removes only the tracked, identity-checked
artifacts this call created (category directories, its own marker, the empty
root) and never touches a marker or directory it did not create. If the
marker pathname was exposed but the marker could not be confirmed
(`RECOVERY_REQUIRED`), no filesystem compensation runs at all: the public
entry may already be foreign, so the directory stays for inspection. A crash
before commit can leave an orphan directory (with a marker whose token no row
holds) — the same orphan-directory outcome as before PM-1B, never adopted by
token presence alone.

**Ownership-sensitive operations require the witness.** An operation is
ownership-sensitive when it mutates project-root filesystem state, or reads
project-root content and then changes SQLite authority from those bytes.
[`project-directory-ownership.js`](src/services/project-directory-ownership.js)
is the one verifier: bound row + safe stored path (containment, direct child,
ID prefix, no symlinks, real directory) + marker token exactly equal to the
SQLite token. Failures are distinct, fail closed, and are never repaired
(`UNBOUND`, `PROJECT_DIRECTORY_INVALID`/`_MISSING`/`_UNREADABLE`,
`MARKER_MISSING`/`_MALFORMED`/`_UNSAFE`/`_UNREADABLE`/`_MISMATCH`,
`IDENTITY_CHANGED`). It gates:

- **Project rename** (slug change): verified before the database update,
  re-verified (same directory, same token) immediately before the rename, and
  verified again at the destination before the new `project_dir` can commit;
  a failure moves the directory back — only if the destination still holds
  the directory this operation moved and the original path is free — and
  never rewrites the marker.
- **Project deletion**: verified before quarantine and again on the
  quarantined directory (restored on mismatch), and once more before the
  irreversible recursive removal. A missing or unavailable project directory
  no longer authorizes database deletion — an offline `PROJECTS_ROOT` share
  looks the same as a deleted folder — so deletion fails closed and the
  project and its relationships survive. The only database-only deletion is a
  row with no stored `project_dir` and no ownership row.
- **Category directory work**: `add` with `enabled: true`, `setEnabled(true)`,
  and `delete`. `add` with `enabled: false`, `setEnabled(false)`,
  display-name edits, and reorder stay SQLite-only and never resolve the
  project directory.

- **Asset actions**: the shared project-path preflight of
  [`asset-action-service.js`](src/services/asset-action-service.js) — rename,
  basename rename, move, batch move, copy, batch copy, delete, and batch
  delete, and queued processing Rename, which reuses the same prepared rename.
  Move and copy remain same-project only.
- **Processing execution**: the one project preflight of
  [`asset-processing-service.js`](src/services/asset-processing-service.js),
  run under the project lock before conversion/re-encode, watermarking,
  archive generation, and workflow/prompt edits inspect, stage, publish,
  replace, move to Originals, or delete anything.
- **Auto Rename**: Preview and Apply each verify independently; Apply reuses
  its one verification across plan rebuild, revalidation, and the temporary and
  final rename phases, with existing rollback unchanged.
- **Source-derived SQLite authority**: the asset scan (§10), source
  animation/tuple/generation reconciliation
  ([`source-animation-service.js`](src/services/source-animation-service.js)),
  and KRA merged-preview eligibility when it authorizes a project or Book
  primary-image selection (`previewService.inspectKritaPreviewSource`).

**Planning is not execution authority.** Processing plans (Convert, Watermark,
Archives, Prompt Editor, Rename) verify once at the planning boundary, so
ownership errors surface early and no plan is built from a substituted root.
Nothing a plan, a Preview token, or a held coordinator lock carries is an
ownership witness: queued execution and Auto Rename Apply verify again.

**Once per logical operation, never per file.** `verifier.beginOperation()`
returns an operation-local handle that verifies each distinct project at its
initial gate and reuses that result for the rest of the operation — a batch of
N assets, one processing execution, one scan, one Preview, one Apply, one
presentation policy. A scan with unusable filesystem identity re-verifies
ownership once after traversal (§10), independent of asset count. Handles
have no TTL, live in no module or service state, and are never carried across
requests, scans, queued executions, plan/apply boundaries, or
app-context reconstruction; a later operation verifies afresh. Verification is
therefore not a hot-path sidecar: ordinary generated Thumbnail/Preview serving
does not read the marker, and source reconciliation reads it only on the rare
path where a source change or unknown animation state must be written.

Project metadata edits (title without slug change, description, notes, link,
status, type, tags), archiving, DB-only category operations, and DB-only
primary-image selection/clear remain SQLite-only and never read the marker.
The service graph shares one ownership repository across every gated service.

**Pure read-only source serving is deliberately not gated.** Original-media
HTTP serving and downloads, Social Prep downloads, read-only workflow and
dimension/metadata inspection, and the viewer's KRA eligibility *hint*
(`inspectKritaPreviewPresentation`, which never authorizes a stored selection)
add no marker read; they keep their existing safe-descriptor and containment
protections. Residual limitation: if an entire project root is substituted
before such a pure read, the read may return whatever file is at the safe
relative path inside the substituted directory. This is accepted and
documented rather than hidden behind an ownership cache or per-request marker
reads.

**SMB and external edits.** Ownership binds the project *root*, not the
artwork. Editing, adding, or removing files and category subfolders inside an
owned root is supported and keeps being detected and reconciled — the marker
does not change when artwork changes and a matching marker never implies the
source bytes are unchanged. No persistent inode/file ID is stored, so a share
remount with new inode numbers, or a project-directory rename, keeps ownership.
A transient share or marker I/O failure (`PROJECT_DIRECTORY_MISSING`,
`_UNREADABLE`, `MARKER_UNREADABLE`) fails the current operation without any
destructive reconciliation; a later retry succeeds once the share is back.
Replacing or moving an entire project directory concurrently with an
ownership-sensitive CreatorCrate operation remains outside the supported
external-edit contract.

**Error surfaces.** Asset actions, processing, and scans propagate
`ProjectOwnershipError` (HTTP 409 with a path-free message through the generic
handler). A JSON scan request maps it to 409 `PROJECT_OWNERSHIP_UNAVAILABLE`;
the form scan uses the existing `scan_error=filesystem` notice — never an
apparent empty success. Auto Rename wraps it as
`PROJECT_OWNERSHIP_UNAVAILABLE` (409) with `details.ownershipCode` and the
original error as `cause`. Background processing jobs keep their generic
job-failed presentation; the job diagnostic retains the underlying error.
Optional source-derived enrichment (a listing learning an unknown animation
state) keeps the prior safe state when ownership cannot be proven.

**Existing projects are adopted automatically (PM-1C1).** Projects that
existed before PM-1B have a `projects` row and a stored `project_dir` but no
ownership row and no marker. Until adopted, every gated operation above fails
closed with `UNBOUND` (metadata-only operations, DB-only category and
selection operations, and pure read-only serving keep working).
[`project-ownership-adoption-service.js`](src/services/project-ownership-adoption-service.js)
binds those that can be proven from existing installation evidence and
recovers interrupted marker publication; it never runs inside a SQL
migration.

- *Proof.* The only accepted legacy fact is "manifest project ID equals the
  SQLite project ID": a `project.json` that is a regular non-symlink file
  directly inside the safely resolved stored project directory (same
  containment, direct-child, ID-prefix, and no-symlink rules as the
  verifier), and that parses and validates under the established legacy
  manifest parser at a supported schema version. Every other manifest field —
  title, slug, description, notes, link, categories — may be stale and is
  ignored: nothing from the manifest is ever written into SQLite, and the
  file is never rewritten or removed. Pathname, ID prefix, directory
  contents, asset similarity, timestamps, and inode identity never prove
  ownership on their own. The manifest is one-time upgrade evidence only:
  once a project is bound, rename, deletion, asset actions, scans,
  categories, and processing never consult it, and the lifecycle never
  revisits a bound project, so no `project.json` is read for it again.
- *Restart-safe binding.* Establish proof → persist a `pending` token →
  exclusively create the marker (read back and verified) → mark exactly that
  (project, token) `bound`. Each project's step runs synchronously, so no
  scan or request interleaves with it. A crash before the pending commit
  leaves nothing; after it, the next run re-establishes proof before
  publishing the marker; after a durable marker, the next run completes the
  binding; a partial marker is reported `malformed` and left untouched.
- *Existing markers are never replaced.* No row + matching manifest + valid
  marker: the marker's token is adopted (pending → re-verify → bound) — the
  case of an older database restored beside newer project files. No row +
  malformed/unsafe marker, or a marker token already bound elsewhere: left
  unbound. `pending X` + marker `X`: bound without re-reading the manifest
  (the random token only this protocol writes, at the safely resolved stored
  path, is the proof). `pending X` + no marker: published only after
  re-establishing legacy proof. `pending X` + marker `Y` or a
  malformed/unsafe marker: left pending. `bound` + missing, different,
  malformed, or unsafe marker: never repaired. A project with no stored
  `project_dir` needs no binding and is left DB-only.
- *Classification.* Every project is classified as bound, not-required
  (DB-only), `retryable` (could not currently inspect), or
  `recovery-required` (definitively unprovable or conflicting, with a
  path-free reason). `getProjectStatus(projectId)`, `listUnresolved()`, and
  `readiness()` expose this for diagnostics; explicit recovery (PM-1C2A,
  below) reads and clears it.
- *Durable progress.* One bounded `app_meta` record
  (`project_ownership.adoption.v1`: phase, committed cursor, fixed upper
  bound, outcome counts) drives the one-time pass over SQLite projects —
  archived included, never directory enumeration — in stable ID order up to
  the maximum ID captured at its start; projects created later bind
  themselves at creation. Each unresolved project has one small `app_meta`
  row (`project_ownership.adoption.v1.project.<id>`: status and reason);
  bound and DB-only projects have none. The pass is complete once every
  project up to the bound is classified, not when every project is bound.
- *SMB.* An unavailable `PROJECTS_ROOT`, a missing project directory, and any
  I/O or permission failure reading the directory, marker, or manifest (or
  writing the marker) are uncertainty, never evidence: nothing is created or
  overwritten, the current unbound/pending/bound state is kept, the project
  is `retryable`, and the pass moves on, so one offline project never blocks
  the rest. Retryable projects (and unclassified pending rows) are retried on
  a bounded backoff timer (1 min doubling to 30 min, unref'd), on `signal()`,
  and on every startup. `recovery-required` projects stay quiet: they are not
  re-read until explicit operator recovery (below).
- *Startup.* After migrations the application context calls `prepare()`
  (lifecycle record) and `signal()` (background pass) before the
  generated-image rebuild and publication lifecycles, and again on every
  database adoption (a restored database predating PM-1C1 starts its own
  pass); replacement maintenance pauses it with the other background runners.
  The automatic scan scheduler waits for an in-flight adoption run and skips
  project scans for a cycle while the one-time pass is incomplete; afterwards
  it scans normally and each still-unresolved project fails closed alone. The
  verifier reads the ownership row per operation, so a newly bound project's
  next scan or mutation works without a restart.

**Explicit operator recovery (PM-1C2A, backend only).** Projects PM-1C1
leaves `recovery-required` — missing, unsafe, malformed, unsupported, or
mismatched legacy manifests; malformed or conflicting markers; pending rows
without proof or with a conflicting marker; bound rows whose marker is
missing, different, or malformed — and bound projects whose marker a PM-1B
gate later finds missing or wrong, can be recovered by an explicit operator
request through
[`project-ownership-recovery-service.js`](src/services/project-ownership-recovery-service.js).
The operator attests that the directory already stored for the project is
that project's directory; that attestation replaces PM-1C1's legacy proof,
and on success the SQLite row is `bound` to token X and the marker carries X.

- *Explicit only.* Nothing calls it automatically — not scan, rename,
  delete, edit, processing, reconciliation, startup, or retry timers. The
  only entry point is `POST /projects/:id/ownership-recovery` (auth + CSRF
  through the application-wide middleware); `GET` on the same path returns
  the status. The operator UI (PM-1C2B) is a Project Detail notice plus
  dialog ([`project-ownership-recovery.js`](src/static/client/project-ownership-recovery.js)):
  the notice is rendered only from SQLite state (`getAttentionHint`: the
  adoption classification and ownership row, never the marker), so browsing
  a project costs no ownership-marker I/O; the marker-reading `GET` runs only
  when the operator opens the dialog or presses "Check again", and the `POST`
  only after the shared confirmation dialog, carrying the displayed
  `statusVersion` and never retried automatically. A bound project whose
  marker later vanished has no durable signal, so it gets no notice; the
  gated operation reports it.
- *Stored path only.* Recovery considers only `projects.project_dir`,
  resolved under the same safe-path rules as PM-1B/PM-1C1 (shared
  `inspectStoredProjectDirectory`). An invalid or unsafe stored path is
  refused, never "fixed"; `project_dir` is never changed and no other path
  can be supplied. Relocation is a separate future design.
- *Token choice.* Existing bound token, else existing pending token, else a
  valid marker token no row holds, else a fresh token. A marker token held by
  another project (bound or pending) is never taken: recovery refuses
  (`marker-token-in-use`) and touches neither project's row nor the marker.
  A symlinked or non-regular marker is refused (`marker-unsafe`).
- *Plans.* no row + no marker: pending → exclusive create → bind.
  no row + free valid marker X: pending X → re-verify → bind (marker never
  rewritten). pending X + X: re-verify → bind. pending X + none: create X →
  bind. bound X + none: create X (row already bound). A malformed or
  different (free) marker: *replacement* — the entry is fingerprinted,
  atomically renamed to a random `.creatorcrate-owner.quarantine-*` sibling,
  proven to be the inspected entry (else restored without clobbering), the
  new marker is created exclusively (an entry that appears meanwhile is never
  overwritten), and the quarantined file is removed only after the binding
  committed. Before publication, failure removes this attempt's own pending
  row (exact project/token/state) and restores the old marker. A new marker
  whose pathname was exposed but never confirmed is left in place with the
  quarantine (`marker-write-remnant`); after
  publication the attempt rolls forward (pending X + marker X, completable on
  retry), keeping the old marker quarantined as evidence. SQLite is never
  `bound` to a token whose marker is not in place.
- *Consistency.* No transaction spans filesystem I/O; each SQLite step is one
  conditional statement on exact (project, token, state). The attempt runs
  synchronously under the project's operation lock. A confirmation must carry
  the opaque `statusVersion` of the status the operator saw (a hash of the
  row, marker content fingerprint, and plan — no token, path, or inode); any
  change in between is refused as stale.
- *SMB.* An unavailable root, a missing project directory, or an I/O or
  permission failure at any step is "retry later": the attempt fails, the
  prior state and classification are kept, and nothing becomes a permanent
  conflict. Filesystem identity (dev/ino, where reported) is used only within
  one attempt and never persisted; content fingerprints cover shares that
  report no file ID. Projects PM-1C1 still owns (retryable, not yet reached
  by the pass, unclassified pending) are reported as retry-later, not offered
  for recovery.
- *After success.* The project's adoption classification is cleared. PM-1B
  gates read the row and marker per operation, so the next scan or mutation
  verifies the new marker normally — no restart, no scanner bypass, and no
  scan inside recovery. Business metadata stays SQLite-authoritative: no
  `project.json` is read, written, or imported.

The scanner never indexes the marker (root-level dotfiles are skipped), and
asset rename, move, and copy refuse to place an asset at the project-root
marker name.

**Legacy manifest cleanup (PM-2).**
[`legacy-manifest-cleanup-service.js`](src/services/legacy-manifest-cleanup-service.js)
is a background maintenance lifecycle that removes historical `project.json`
files only when it can prove they are obsolete duplicates. "SQLite is
authoritative now" is never, on its own, a reason to delete; anything
ambiguous is retained and reported. There is no guarantee that every historical
manifest is removed.

- *Targets.* Only three exact name families directly in a project root:
  `project.json`, the legacy writer's temp file `.<12 hex>.project.json.tmp`,
  and the lifecycle's own interrupted-removal quarantine
  `.project.json.cleanup-<time>-<18 hex>`. Nothing is found by pattern
  matching on `*.json`: arbitrary user JSON (including lookalike names such as
  `project.json.bak` or a nested `project.json`), Book exports,
  processing-preset exports, auth files, and all `APP_DATA_ROOT` files —
  generated-image `current.json`, revision `meta.json`, managed media — are
  never inspected. Generated/publication JSON is retained on purpose; the
  generated-image publication design depends on it.
- *Ownership first.* A project is considered only when its
  `project_directory_ownership` row is `bound`, PM-1C1/PM-1C2 hold no
  adoption classification for it (not pending, retryable, or
  recovery-required), its stored directory passes the canonical path rules,
  and its `.creatorcrate-owner` marker matches the SQLite token. Otherwise it
  is `ownership-not-ready` and reconsidered on later runs. The lifecycle also
  waits for PM-1C1's one-time adoption pass, and each project step runs
  synchronously under the project's operation lock, so it never interleaves
  with a scan, a mutation, or explicit recovery of that project.
- *Proof of redundancy.* The file must be a regular non-symlink file of at
  most 1 MiB, strict UTF-8, parse and validate as a schema-3 legacy manifest,
  name this project's ID, and match what the legacy serializer
  (`serializeManifest`) would produce for the current SQLite row and its
  project-owned categories (`describeLegacyManifestDivergence`): the exact
  serializer key set; equal `id`, `title`, `slug`, `description`, `notes`,
  `patreonUrl`, `createdAt`; every category's name, slug, order, and enabled
  flag, in order; `tags: []` and `thumbnail: null` exactly as the old
  placeholders (they never represented modern tags or primary images). The one
  tolerance is `updatedAt`, which may be *older* than the row's value in the
  same exact format: the legacy writer never rewrote the manifest for
  status/type/archive changes that still bumped `updated_at`, and never read
  that field back. A newer or differently formatted value is divergent.
- *Retained, never overwritten, imported, or deleted:* divergent manifests
  (old title, description, notes, category labels/order, non-placeholder tags
  or thumbnail, unexpected fields), malformed or unsupported ones, ones naming
  another project, symlinks and non-regular entries, oversized files, temp
  files whose contents differ from current state (for example a partially
  written temp), and interrupted-removal quarantines that are not proven
  duplicates (kept where they are, never guessed back into place). A divergent
  file may be the only copy of that historical metadata. Manifests in
  directories with no SQLite project are never touched: the lifecycle is
  driven by SQLite projects, never by enumerating `PROJECTS_ROOT`.
- *Race-safe removal.* Removal is never "compare, then unlink the path". The
  proven entry is renamed to an unpredictable sibling quarantine name, the
  moved entry is re-read and must match the inspected content fingerprint
  (size + SHA-256) and, where the filesystem reports a non-zero file ID, the
  same operation-local dev/ino; only then is the quarantine unlinked.
  Ownership is re-verified immediately before the rename. A replacement that
  appeared in between is put back without clobbering (link(2), else an
  exclusive-create copy) and judged on its own merits in a later run; if it
  cannot be put back it stays in quarantine rather than being deleted. A zero
  file ID (SMB) is "unknown", never continuity proof, so the fingerprint
  decides. File IDs are never persisted.
- *SMB and retries.* An unavailable root, EIO, a permission failure, a file
  that changed while it was read, or a busy project leaves every file in
  place, classifies the project `retryable`, and the pass continues with the
  next project. Retryable and not-ready projects are revisited with a bounded,
  non-busy backoff (1 min doubling to 30 min), on `signal()`, and on every
  startup. Nothing in normal operation waits for cleanup.
- *State (`app_meta`, no migration).* `legacy_manifest_cleanup.v1` holds the
  one-time pass's phase, committed cursor over project IDs, fixed upper bound
  (projects created later never get a manifest), and cumulative counts
  (`removed`, `tempRemoved`, `noManifest`, `notRequired`).
  `legacy_manifest_cleanup.v1.project.<id>` exists only for projects with
  something to report: `retryable`, `ownership-not-ready`, or terminal
  `retained`, each with short reason codes (for example `manifest-divergent`,
  `temp-malformed`, `marker-unavailable`) — never paths or manifest content.
  After the pass completes, only retryable/not-ready projects are revisited;
  removed and retained projects are never re-read. The whole pass restarts
  idempotently if its record is lost or untrusted (for example a restored
  database). Rows of deleted projects are pruned.
- *Visibility.* Diagnostic log events (`projects.legacy_manifest.removed`,
  `.unresolved`, `.cleanup_pass_completed` with the counts) and the service's
  `readiness()` report removed, absent, retained (divergent / invalid /
  unsafe), retryable, and not-ready totals without manifest contents.
  `dryRun()` classifies every project (`would-remove`, `retain-divergent`,
  `retain-invalid`, `retain-unsafe`, `retry`, `ownership-not-ready`,
  `no-manifest`, `not-required`) with the same predicate, deleting and
  writing nothing; it is a service capability with no UI or CLI.

Removing a manifest changes no SQLite state, marker, asset, release,
category, Book reference, or primary image. Project directories remain
artwork only and are still not a complete application backup: database
backups are.

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

1. Load the current project and verify its root through the canonical
   ownership verifier (§9): bound row, safe stored path, real non-symlink
   directory, matching `.creatorcrate-owner` token. Traversal uses only the
   verifier-returned path. Any ownership failure — unbound, mismatch, missing
   or malformed marker, an unreadable marker, a missing root, an unavailable
   share — aborts here, so the project is never reconciled as empty, another
   project's files are never imported, and source generations and automatic
   primary selection never move on unverified content.
2. Walk it recursively, collecting **relative paths and metadata only** —
   no absolute path is ever stored. Skips legacy CreatorCrate sidecars
   (`project.json` and its temp form), OS junk, archive extensions, root-level
   dotfiles (including the `.creatorcrate-owner` ownership marker), hidden
   directories, and symlinks of any kind.
3. **Abort on permission or I/O errors.** This is the critical invariant: a
   traversal that cannot see the whole tree must not reconcile, because a
   partial snapshot would mark real files as missing.
   Before reconciling, the scanner establishes root continuity. When the
   operation-local filesystem identity is trustworthy, it compares the
   directory identity after traversal; a change aborts with
   `IDENTITY_CHANGED`. A zero, unavailable, non-numeric, or numerically unsafe
   file ID is never positive continuity proof. On such filesystems (including
   SMB shares without usable IDs), the scanner instead repeats canonical
   ownership verification once after traversal: the SQLite binding, stored
   path, and ownership marker must still match. This adds constant work per
   scan, regardless of asset count. A substituted root is rejected before
   reconciliation, with either `IDENTITY_CHANGED` or an ownership-verification
   error such as `MARKER_MISMATCH`, depending on the branch. Reconciliation
   never uses a root whose continuity cannot be established. Child files
   appearing, changing, or disappearing during the walk keep their existing
   semantics.
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

Each asset row also carries an application-controlled `source_generation`
(migration 040; existing and new rows start at 0). It is the durable
disambiguator for logically different source-file instances when the persisted
path/size/mtime tuple alone cannot tell them apart. It only increments, and
only when CreatorCrate establishes a new source instance: a scan observing a
changed size/mtime (or a known animation state flipping), a missing row being
restored (so a returning file never regains an old immutable revision merely
because its tuple matches), an in-app rewrite of the file (prompt edits,
conversion re-encode, watermark replacement, a copy/upsert over a changed or
missing row), and a request-time reconciliation after a descriptor/path
identity check proved the file was replaced — including the same-size,
same-mtime case. Unchanged scans, path-derived repairs, removal alone, and
first-time animation classification leave it unchanged. Platform
inode/file-index identities are used only transiently by those checks and are
never persisted.

---

## 11. Processing invariants

Asset processing (format conversion, watermarking, archive generation,
ComfyUI workflow-prompt editing, and explicit selected-file Rename) is the most invariant-dense part of the
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
existing completion or failure path. The job service is also the sole owner of the correlated application-log lifecycle: it records queued, started, succeeded, failed, queued-cancelled, and running-cancellation-rejected events through the context-scoped logger. Route and lower-level processing services do not duplicate those entries; log-sink failures cannot change a job result.

The Apply route captures the planner's concrete ordered asset IDs and normalized
options in the job closure. Capability-gated already-coordinated executors then
run inside the job service's existing `runAsync()` owner; they must not reacquire
the same project lock. Rename follows this seam through the asset action service,
so its private locked primitive remains unavailable to ordinary callers.

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

Project thumbnail/preview generation shares this admission boundary. The
preview service acquires one permit (`run`) only after it holds the per-asset
generation lock and has confirmed generation is still needed, and holds it
for the whole staged attempt, including selective reuse copies and the bounded
second attempt. Target authority is rechecked after the permit is granted and
before any source read. Fresh cache reads and prior-policy fallbacks never
take a permit, so cold browser previews, Book export's current-preview request,
and rebuild generation queue fairly with conversion work while cached browsing
stays outside the queue. The pool is not reentrant: no caller may hold a
permit while calling into preview generation. Lock order is always per-asset
lock, then processing permit.

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
the project lock**. Rename accepts only an explicit selected scope plus
`options.renames`, an array containing exactly one `{ assetId, basename }`
entry per selected asset. Its planner normalizes the mapping into selected-asset
order and delegates single-file validation/destination derivation to the asset
action service's capability-gated read-only adapter. A plan is advisory by
construction.

[`asset-processing-service.js`](src/services/asset-processing-service.js)
and the asset action service provide the operation executors. The processing-job
service takes the lock, and those executors **re-run authoritative preflight
from scratch** inside the already-coordinated region. A plan is never trusted as
authorization; it is a preview. Queued Rename invokes the established
single-file basename primitive in deterministic planned order. If a later item
fails, prior successful renames remain committed and the job fails; there is no
unsafe batch rename-back compensation. Auto Rename adds a signed plan token on top of this — signed with
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
`APP_DATA_ROOT/previews/projects/<project-id>/<asset-id>/`. Publication is
journaled in SQLite, and the committed SQLite publication is what runtime
serving resolves (below); the derivative bytes stay on disk. Deleting the
whole preview root is always safe: the affected pairs fail byte validation and
are regenerated.

**Normalized publication state (the runtime authority).** Migration
`041_add_generated_image_publications.sql` adds three SQLite tables that are the
normalized runtime representation of a published pair:
`generated_image_publications` (one committed publication per asset: revision
directory basename, revision token, versions, source tuple and generation, and
the optional legacy fields — policy fingerprint, animation, frame count, Krita
preview quality, identity version — kept `NULL` when absent rather than
defaulted), `generated_image_derivatives` (exactly one `thumbnail` and one
`preview` row: format, dimensions, byte size, optional generation identity),
and `generated_image_publication_intents` (at most one unresolved candidate per
asset: owning intent ID, candidate/staging/previous directory basenames,
expected revision). All three cascade from the owning asset through the
composite `(project_id, asset_id)` ownership key; no absolute path, URL, ETag,
or freshness result is stored. The migration only creates empty tables — it
does not scan any root or backfill.
[`generated-image-publication-repository.js`](src/data/generated-image-publication-repository.js)
validates one canonical complete snapshot, reads it with a single statement
that returns nothing unless both derivatives exist, acquires an intent without
replacing a competing owner, clears an intent only for its owning ID, and
finalizes in one transaction that verifies the owning intent and its recorded
candidate, upserts the parent, replaces both derivative rows, and deletes the
intent. An intent is writer/recovery coordination state only; it never hides
the committed snapshot.

**Journaled publication (writer only).** The Preview Service receives this
repository from application construction (`app.js`; direct constructions bind
one to their `db`) and journals every new publication around the unchanged
filesystem steps below. After the staged set is generated, its `meta.json` is
written, the complete set is validated, and the pre-promotion source/policy
recheck passes, the normalized snapshot is built from that validated in-memory
meta (never re-read, never current row values) and an intent is committed
naming the exact candidate `r-<revision>-<rand>` directory, its staging
directory, expected revision, and the directory `current.json` named before.
Only then is staging promoted; the existing pointer-boundary recheck and the
atomic `current.json` replacement follow unchanged, and only after the pointer
names the candidate is the snapshot finalized in one synchronous transaction
(parent upsert, both derivative rows replaced, owning intent deleted). A
same-token force rebuild is therefore a distinct publication by directory.
Per-asset serialization means an intent already present for the asset is an
unresolved earlier publication: it is never overwritten or cleared, and the
new publication fails before promotion. Any failure before the pointer names
the candidate removes the operation's staging or promoted directory as before
and conditionally releases its own intent. If the pointer write fails, the
pointer is re-read: only a readable pointer naming another directory, or none,
proves the candidate unpublished. Once the pointer names the candidate — or its
outcome cannot be proven — a failure (including finalization) keeps the
candidate directory and its intent, leaves the prior committed snapshot, and is
reported as an unresolved publication rather than success; background
recovery (below) resolves it. The writer notifies the lifecycle service of
such a journal error (and of a `pending` refusal) so recovery runs in the
background; the failing request itself recovers nothing.

**Publication lifecycle (backfill, intent recovery, restore, repair).**
[`generated-image-publication-lifecycle-service.js`](src/services/generated-image-publication-lifecycle-service.js)
makes the tables trustworthy before anything reads them as the runtime
authority. Its durable state is one versioned `app_meta` record,
`images.publication_lifecycle.v1`
([`generated-image-publication-lifecycle-repository.js`](src/data/generated-image-publication-lifecycle-repository.js)):
`mode` (`upgrade`, `restore`, or `reset`), `phase` (`running` or
`completed`), `cursor`, a fixed `upperBound`, per-outcome `counts`, and a
durable `repairRequired` flag. `phase: 'completed'` is the readiness signal
(`isPublicationIndexReady()`) that the one-time import or restore reset is
finished; per asset, `isAssetRecoverySettled(assetId)` is false only while
an unresolved intent for that asset still awaits recovery.

- *One-time upgrade backfill.* The first start with no record captures
  `upperBound` = the highest previewable asset ID and traverses SQLite assets
  (never cache directories) in ID order, including archived projects and
  not-present sources; orphan cache directories are never visited, and later
  assets are journaled by the writer itself. Per asset, under the per-asset
  lock, an existing committed row or intent decides it without touching the
  filesystem. Otherwise only the generation `current.json` names is
  considered (never the newest directory): the directory must be real, its
  `meta.json` must parse, name this project/asset, and hash (from its own
  recorded source/policy/generation) to the pointer revision; both
  derivatives must match `meta.json` and decode; the snapshot must normalize
  through the publication contract; and the pair must be what today's reader
  would serve for the asset's current source: fresh, or differing only by
  policy (prior-policy). Legacy-absent fields stay `NULL`, a missing source
  generation is 0, and nothing is written to asset or project rows. The
  conditional install (only while the asset has neither a committed row nor
  an intent) and the cursor/count advance are one transaction, so a crash
  never leaves the cursor past a lost import and a rerun is idempotent. Every
  other outcome (`missing`, `malformed`, `unreadable`, `invalid`,
  `incomplete`, `stale`, `unnormalizable`) records no row, advances the
  cursor so one bad entry cannot block the pass, and sets `repairRequired`.
  Once the record is `completed`, ordinary restarts do no publication JSON
  scan; only unresolved intents are inspected.
- *Targeted intent recovery.* The recovery set is the intent table
  (`listIntents()`), re-read at `prepare()` and at the start of every run;
  the cache is never enumerated to find work. Each intent is decided under
  the per-asset lock after re-checking that its `intent_id` still owns the
  asset (a live writer holds that lock from intent to finalization), and
  every write is conditional on that ID, so a newer intent is never
  finalized or cleared. By what `current.json` names: the candidate: its
  directory, `meta.json`, correspondence, and derivative pair are validated
  and the snapshot of its immutable `meta.json` is finalized through the
  repository transaction; the recorded previous directory: the candidate
  never published, so the operation's own candidate/staging directories are
  removed (never one the pointer or committed row names) and the intent is
  cleared; missing, malformed, unsafe, or naming any other directory: the
  candidate is established as unpublishable, so the intent is cleared and
  `repairRequired` set in one transaction, without touching the pointer or
  choosing a directory by existence or time. A definitively invalid or
  incomplete candidate is treated the same way. A possibly transient read
  failure retains the intent (actionable, retried on the next run) and
  blocks only that asset. The committed snapshot is never an input and is
  never deleted or invalidated: while an intent exists it remains the last
  known-good generation, and candidate uncertainty says nothing about it.
- *Restore reset.* See §15: the staged restore database has its three
  publication tables emptied and a `mode: 'restore'`, `completed`,
  `repairRequired` record written before it can replace the live database.
  A restored database is therefore never mistaken for an unfinished upgrade
  and never imports whatever the current cache holds; its assets are
  regenerated. Cache directories are left as ignored derived remnants. An
  untrusted record is handled the same way (`mode: 'reset'`) without
  deleting committed rows.
- *Repair admission.* A `repairRequired` need on a completed record is
  admitted to the existing generated-image rebuild service
  (`queueRepair()`) in the same transaction that clears the flag: an
  automatic reconcile-all run under the saved policy (marked
  `reason: 'publication-repair'`), using the approved window and shared
  processing pool unchanged. An unstarted repair or manual run already
  covers it; a started manual run defers it (the flag stays durable). No
  per-asset queue is stored: `ensureTargetGeneration` probes only the
  committed SQLite publication, so an asset without a committed row, or
  whose committed pair fails validation, is published through the journal
  (derivative reuse still allowed) and the rebuild's normal traversal is the
  repair. `requestRepair()` remains the explicit admission entry point for
  maintenance callers; request paths do not call it (below).

**Runtime authority (committed SQLite publication).** Every normal
generated-image consumer resolves the committed SQLite publication and never
inspects `current.json` or a revision-local `meta.json` — no read, open,
stat/lstat, access, or path inspection of either file, on the first request
after an ordinary restart or on any later one. The consumers are the
pre-lock presentation read (`getThumbnail`, `getPreview`, including
prior-policy presentation), the locked serving path and its post-admission
fresh recheck, `ensureCurrentPreview` (Book export), automatic
`ensureTargetGeneration` probes, and selective derivative reuse discovery.
There is no in-memory publication cache, TTL, watcher, or pointer stat check:
each request reads SQLite.

- *One snapshot, existing rules.* One statement returns the parent row and
  both derivatives. An in-memory, parsed-meta-shaped view of that snapshot
  (the inverse of the writer's snapshot builder) feeds the existing
  freshness comparison, prior-policy eligibility, animation authority, and
  per-kind identity rules unchanged, so no second implementation exists. The
  revision directory is derived from the preview root, the IDs, and the
  validated committed `directory_name`; derivative filenames are
  `<kind>.<format>`. The committed revision must still equal the hash of its
  own recorded source/policy (the check that replaced the old pointer
  correspondence re-read), and a prior-policy pair needs its recorded
  fingerprint.
- *Actual bytes stay filesystem-validated.* Both derivative files must exist
  as regular, non-symlinked files under the preview root (complete pair); the
  requested derivative is size-, decode-, dimension-, and animation-validated
  (both, for prior-policy); then the existing source proof and final
  DB/policy recheck run before the pair is served. SQLite replaces the JSON
  lookup, not byte validation, and source freshness remains request-time
  filesystem authority (source identity, source generation, animation
  classification, same-tuple replacement handling). JSON-only path checks
  are gone from this path.
- *Pending intents.* Readers never consult the intent table. While committed
  generation A has an unresolved candidate B — during staging, promotion,
  after `current.json` already names B, while finalization is delayed or has
  failed, and while recovery inspects B — requests keep evaluating A and serve
  it when A passes its own checks, without waiting on the asset lock. The
  runtime switch to B is the finalization transaction; a same-token force
  rebuild is distinguished by directory name. A request already holding A
  finishes under its own validation. If A itself is no longer servable (stale
  source or policy), the request's republication meets the unresolved intent
  and is refused as a retryable journal error (503) while recovery owns it.
- *Missing or damaged state.* A missing committed row (a never-published
  asset, a restore reset, a deleted row) or a committed pair whose bytes are
  missing, wrong-sized, undecodable, or unsafe (including a deleted preview
  root) is regenerated on demand by the locked path through the journaling
  writer, exactly like any other absent or corrupt cache: legacy JSON is never
  read, imported, or served, nothing is synchronously backfilled or
  recovered, and the committed row is replaced only by that journaled
  publication. The publication JSON the writer itself reads and writes is
  publication activity, not runtime lookup.
- *Readiness.* Before the one-time upgrade backfill completes
  (`isPublicationIndexReady()` is false), a presentation request for an asset
  without a committed row cannot tell "not generated" from "not imported
  yet": it fails as `PreviewPublicationNotReadyError` (a controlled,
  retryable 503) without JSON fallback, generation, or repair. Rows that are
  already committed are complete snapshots and serve normally; automatic
  rebuild probes publish row-less assets through the journal. A service
  constructed without a lifecycle has no legacy cache to import and treats
  its index as ready. After an ordinary restart with a completed record, the
  first request reads SQLite directly.
- *Restore.* A restored database's empty index is never refilled from the
  surviving host cache by a request: row-less assets regenerate through the
  journal while the lifecycle's durable repair pass covers the rest.

`current.json` and each revision's `meta.json` remain the durable filesystem
publication witness and immutable generation description. They are still
written by every publication and read only by the journaling writer, explicit
intent recovery, the one-time legacy backfill, and scoped maintenance.

[`preview-cache.js`](src/storage/preview-cache.js) defines the on-disk
contract, which is an atomic-set publication scheme:

- `tmp-<rand>/` stages a **complete** set (thumbnail, preview, meta).
- Once validated, the staging directory is renamed to an immutable
  `r-<revision>-<rand>/`.
- `current.json` is then replaced atomically (temp + fsync + rename). **That
  single-file replacement is the filesystem publication event**; the runtime
  switch is the SQLite finalization that follows it. A reader sees either
  the complete prior committed pair or the complete new one — never a mixed
  set.
- Stale revision directories are harmless derived data; cleanup is deferred
  by design rather than racing readers.

Directory names are always **server-generated**; a client-supplied revision
string never influences directory or pointer identity, and no absolute host
path is written into `meta.json` or `current.json`. Freshness is decided by
comparing recorded source size/mtime plus schema and derivative-config
version markers, the asset's source generation, and the fingerprint of the
validated effective project-image policy. That same fingerprint contributes to
rendered project derivative URL revisions. The source generation is part of
the authoritative pair revision (the committed publication, `meta.json`,
`current.json`, and the public `v=` token, hence the immutable-response ETag): generation 0 adds nothing to
the token, so pre-existing revisions stay stable, while any later generation
yields a distinct revision even for an identical tuple. Metadata written
without a generation reads as generation 0 and therefore qualifies only while
the row is still at 0. A generation mismatch is a source difference: it is
never fresh, never a policy-only prior-policy fallback, and never proof for
derivative reuse. Present legacy GIF/WebP assets with unknown animation state are
inspected through the contained source descriptor when animation-sensitive
identity is needed. The result is stored on the existing asset row without
changing its source revision or asset modification timestamp. Known rows need
no source probe, and unavailable sources retain an unknown state until they can
be read. If generation finds that a known animation value disagrees with the
source, it re-inspects the contained source, conditionally updates its size,
mtime, and animation value, and retries within the existing two-attempt bound.
Incomplete GIF/WebP containers remain unknown. Metadata records each
derivative's actual format and filename;
`thumbnail.png` and `preview.png` are used only for actual PNG output. An
animated source with PNG preview selected produces `preview.webp` to preserve
animation. The generated fallback for Original selection remains WebP at
quality 90 and 1600px. Policy and source revisions are rechecked under the
asset lock before publication; a changed snapshot discards staging and retries
once. When an ordinary raster's descriptor/path identity shows the file was
replaced — after reading it, at either publication recheck, or (for a request
that queued for processing admission) against the identity pinned before
queueing while the tuple is unchanged — the row's tuple and source generation
are reconciled in one conditional update that pins the old row including its
generation, so a scan or request that won first is reloaded rather than
counted twice. The bounded retry then generates under the new revision with
reuse disabled; a replacement that cannot be reconciled, or one seen again
during the final attempt, fails safely without publishing. A same-tuple
replacement that no request observes against a pinned identity (for example
while the published pair is already fresh) is still not detected; content
hashing remains deferred. Managed Book covers retain their fixed WebP policy and revision identity.
The project media route forwards the derivative service's path and MIME.
Ordinary presentation requests (not `ensureCurrent` callers such as Book
export) read the published pair before taking the generation lock. A pair that
is fresh for the current source and policy authority is served as-is, exactly
as the locked path would serve it, so browsing never waits behind an in-flight
generation of that asset, including a manual force rebuild that is only
replacing it; published revision directories are immutable and the committed
SQLite publication switches only at finalization. Absent, stale,
source-mismatched, or corrupt pairs still queue on the lock. For a policy-only mismatch, presentation may likewise read
the prior published pair before taking the generation lock. Both files, metadata, cache schema, source
tuple, source descriptor/path identity, and animation authority must remain
valid. The service reports the pair's actual revision and `prior-policy`
state; media always sends a revalidating response without an immutable ETag
for that state, even when the request names the old revision. A cold or
source-invalid asset still uses the normal one-asset generation path. Internal
target generation uses the same staging and pointer publication path with an
explicit validated policy and an authority check immediately before
publication. Book export explicitly ensures a current generated preview.
Effective-output comparison scopes automatic rebuild work per asset, while the
thumbnail and preview remain one atomic published pair.

New generations also record versioned per-kind generation identities in
`meta.json`. They come from the shared image-policy module and cover the
effective encoder output rather than the selected presentation. Hidden WebP
quality is ignored for PNG output, an animated source with PNG selected is
identified as animated WebP, and Original keeps its fixed WebP 90/1600px
generated-fallback identity. Inside the asset lock, after each attempt's
source checks, generation re-inspects the committed SQLite publication (never
`current.json`/`meta.json`) for ordinary raster sources. Reuse requires a
complete pair on disk, a committed revision matching its own recorded
source/policy, a matching cache version, source tuple, and animation state,
plus a current-version identity for the kind. When those match, generation copies that derivative's bytes into the new
staging directory as an independent file and validates the copy like a freshly
encoded one. Only the other kind is encoded. The staged pair gets entirely new
metadata and passes the same authority and source rechecks before
`current.json` is swapped. Legacy entries without identities, Krita sources,
manual force rebuilds, and any failed copy fall back to encoding.

Image Settings saves persist an `images.project_rebuild.v1` JSON record in
`app_meta` in the same transaction as the policy change, then signal one
application-owned rebuild runner after commit. The record contains a version,
run ID, mode, target policy, phase, eligible asset count and upper ID bound,
progress counts, a bounded failure sample, and a monotonic asset-ID cursor.
The runner reads present, previewable indexed project assets in keyset pages;
archived projects remain eligible, while managed media is outside this query.
It keeps a bounded window of up to `B = C > 1 ? min(C - 1, 2) : 1` logical
assets in flight, where `C` is the shared processing pool's capacity (the runner only
reads `concurrency`). `B` counts every submitted asset not yet durably
checkpointed: waiting on the per-asset lock or a pool permit, generating, or
finished out of order behind an earlier unfinished asset. It never enumerates
or submits more than that, so the pool's FIFO queue never holds a project's
worth of rebuild calls. Each asset holds its own maintenance lifetime until it
settles. The runner does not acquire processing capacity itself: each asset
calls the preview service, which admits its generation through the shared
pool, so the runner never holds a permit while waiting on one. Leaving at least
one of `C` slots unsubmitted lets a cold foreground preview proceed while the
pool is otherwise idle. `B` is capped at 2 because each rebuilt asset also does
substantial synchronous cache and source-safety filesystem work on the Node
main thread; beyond two in flight that work, not Sharp, bounds throughput while
interactive requests queue behind it. Force rebuilds skip the pre-generation
cache probe whose result they would discard, and generation reads the source
asynchronously from its validated descriptor so a large or network-mounted
source does not block the event loop. The window is a submission reservation,
not priority scheduling, and
conversion, watermark, and archive work still share the same FIFO pool. At
`C = 1` the rebuild is sequential. It never holds the project-operation
coordinator across the library. The preview service remains the only
generation and atomic-publication authority.

New Settings saves replace the run ID and reset traversal, so an in-flight
obsolete target fails the preview service's publication authority check. The
superseded runner stops filling its window immediately and drains its
outstanding assets before the successor starts, so old and new windows never
overlap. A failed automatic run with unresolved traversal, or any started
(`running`/`started`) run, makes its successor reconcile all eligible assets
directly against the latest saved policy, because a started run may have
published assets beyond its durable cursor; a completed run does not widen
later changes. Failed manual force runs do not carry automatic
policy-transition scope. A manual **Rebuild generated images** POST creates a
force-mode run for the saved policy; it regenerates fresh pairs without
clearing prior generations.
Assets finish out of order, so the window is an ordered completion frontier in
traversal (keyset) order. Each entry keeps its terminal outcome in memory; the
cursor, counts, and failure sample advance only through the longest contiguous
completed prefix, applied in traversal order and possibly committed as one
batch. A slot is refilled only after that checkpoint is persisted; a failed
checkpoint stops dispatch, drains the window without further checkpoints, and
leaves the prior durable record. After a crash, later assets may already be
published ahead of the cursor; they are revisited (bounded by the window) and
become cheap no-ops for a non-force target, while the durable counts count
each asset once. Startup re-enumerates an unfinished automatic run and skips
pairs already fresh for its target. A manual force run resumes from its
cursor, repeating at most the window active during interruption.
Invalid JSON or an unsupported rebuild record is replaced during recovery by
a new automatic run for the saved validated policy, starting at cursor zero
with full reconciliation. Runner-level faults retry the authoritative run up
to three times with 250, 500, and 1000 ms delays. Exhaustion records a failed
phase and retains progress; only a durable asset checkpoint or completed run
resets the retry budget. Startup can resume a failed run from its durable cursor.
Shutdown stops new dispatch, drains the window without further checkpoints,
and leaves the marker unfinished. A restore or auth-transition request pauses
dispatch, waits for every outstanding asset to finish and checkpoint, then
acquires maintenance ownership. The pause remains
held until ownership is released; the authoritative app graph then resumes
the durable target. An auth
replacement preserves the automatic cursor, while a restored database uses
startup recovery semantics. Both stop the old graph's runner before publishing
the new graph. Per-asset failures are counted and traversal continues, ending in
`completed_with_failures`.
Settings renders the durable rebuild state on the Defaults page and polls its
authenticated status endpoint only while a run is queued or running. Successful
image-setting saves and manual rebuild requests refresh that state immediately;
the client ignores responses started before newer save or status requests.
While rebuild runs, normal media requests may use the validated prior-policy
pair described above; a cold asset still generates individually on demand.
The shared asset presentation model selects the existing authenticated
`/original` URL for present PNG, JPEG, WebP, and GIF assets when Preview is
Original; Krita keeps the generated `/preview` fallback. Generated URLs retain
the policy-aware revision, while `/original` uses its existing no-store response.
Fitted slideshows use the selected normal preview URL, and Original Size keeps
its separate source URL and natural-size display behavior.

Supported browser video is WebM (`video/webm`) and MP4 (`video/mp4`), decided
by `classifySupportedVideo()` in
[`asset-metadata.js`](src/services/asset-metadata.js) from a matching extension
and recorded MIME. That classifier is deliberately separate from
`classifyPreviewable()`: a video is never previewable, so it never reaches
Sharp, thumbnail/preview generation or rebuild, source-animation inspection,
image processing operations, or project/Book primary-image selection. The
presentation model gives it a `video` state with null thumbnail/preview URLs
and a `playbackUrl` on the authenticated `/original` route. Grid, list, and
release cards render an inert `<video preload="metadata">` frame (no controls,
never played) so the card takes the file's intrinsic aspect ratio, falling back
to a static placeholder on error. On every card surface (Project Assets, Asset
Library, release selection, release detail) an unmodified activation of the
video media link opens the one layout-level `asset-video-preview-dialog` (not
the image-only slideshow), which inserts a fresh native `<video controls
playsinline preload="metadata">` and calls `play()` on it from that same click;
modified clicks still navigate to the Asset Viewer. Closing pauses and removes
the player. The Asset Viewer embeds the same native player but never plays it
programmatically. Both offer a transient Loop checkbox that only sets `.loop`,
starts off for every opened video, and is never persisted. Card frames, page
load, and filter or view changes never play anything. For videos only, `/original`
honors a single `bytes=` Range (206/416) for seeking. Videos are otherwise
ordinary assets for categories, ordering, Auto Rename, rename/move, tags, and
release selection.

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
and writers) and gives each invocation a private staging directory beneath
`backups/`. It switches the staged copy's journal mode to `DELETE` so a managed
backup is always exactly one file with no WAL sidecars, validates it, then
allocates the timestamped managed filename immediately before the synchronous
rename. Concurrent backups therefore cannot share staging or publication
paths, and cleanup removes only the invocation's private directory. A failure
never leaves a valid-looking partial backup behind. Retention pruning runs only
after the new backup is installed, never deletes the backup just created,
and reports failures as warnings rather than turning a successful backup
into a failed one. The shared service counts every admitted backup from its
synchronous entry until operation-owned cleanup finishes. Concurrent backups
remain allowed, but restore admission fails while that count is non-zero.

Retention enumerates only managed-file metadata (regular-file status, size,
mtime, and managed filename) and applies the same newest-first ordering used by
Settings; it does not open historical snapshots. Settings listing layers live
validation over that metadata, and restore independently validates the selected
backup again immediately before any destructive work.

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
3. The backup is copied to a staging file beside the live database,
   opened, migrated, and its derived generated-image publication index reset
   in one transaction (all publication, derivative, and intent rows removed;
   the lifecycle record set to `restore`/`completed`/`repairRequired`, see
   §12). The staged file is returned to a single rollback-journal file and
   fsynced. All of this happens before the live database is touched, so a
   failed restore reopens the original with its publication rows and intents
   intact, and the only file that can ever be installed is already reset.
   Generated cache directories are not deleted.
4. The live connection is checkpointed and **closed by this call**, then the
   live database (and its WAL/SHM) is renamed aside to `.rollback` and the
   staged file is renamed into place — all same-filesystem renames.
5. The new file is opened, migrated, and health-checked.
6. **On any failure after the original was moved aside, the original is
   restored and reopened**, and the resulting `BackupError` carries that
   recovered connection on `.db`. The prior database is never silently
   discarded.

The **maintenance boundary** is the caller's responsibility. Settings acquires
current-graph managed-upload ownership before invoking restore and checks the
existing processing and backup-service conflicts. The service's `beginRestore` /
`endRestore` exclusion is supplementary: it ends before graph adoption, whereas
Settings retains the owner until a usable graph is adopted (see WP7D3B2 above).
The backup service also rejects restore atomically at its own admission boundary
while any backup creation remains active. The final pre-checkpoint/close gate
independently verifies the current-graph owner and live connection. No
unconditional boolean reset reopens a dead graph.

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

Cross-page hosted-dialog return is an explicit, opt-in contract. An invoking
link marked with `data-dialog-invocation` adds the live browser pathname,
query, and fragment as `returnTo` at activation time; an opted-in submit
control writes the same value to its form's existing `returnTo` field. For an
already-hosted dialog, capture happens after the dialog opens so restoration of
the form's initial snapshot cannot overwrite the live invocation value. The
owning route must
validate that value for its exact entity and allowed host path before carrying
it through the host redirect and native form. A validated hidden
`data-dialog-return-location` field lets `appDialogRequestClose()` navigate
only after the existing close guard accepts a terminal cancellation; ordinary
dialog close lifecycles do not navigate. Project Assets -> Edit Project,
Calendar -> Edit Release, Books -> Edit Book, and Project Assets -> selected-assets
New Release adopt this contract. Projects-list New Project and Releases-list
New Release also retain exact list context through create validation/error
rerenders; their route owners accept only canonical `/projects` and `/releases`
paths and keep their established post-create detail destinations. The edit flows may also use the validated
destination after a successful mutation; selected-assets Release creation
deliberately retains its canonical `/releases/:id/assets` success destination.

New Release forms omit Published date. The `POST /releases` route passes
`publishedDate: null` to both creation service paths, so submitted form data
cannot publish a release during creation. Publication remains available through
the existing edit and explicit publish routes. The server sets `isFreshCreate`
on creation form models: initial list, standalone, and selected-assets handoff
forms are fresh; validation rerenders are preserved drafts. Create forms expose
this state as `data-release-create-fresh` for later client behavior.

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
language, toolchain, and lifecycle**: the `OpenLocally` assembly and
`OpenLocally.exe` executable in `CreatorCrate.OpenLocally.sln`. It targets .NET
10 LTS (`net10.0-windows10.0.17763.0`), remains a Windows GUI (`WinExe`) application, and
has zero third-party production `PackageReference`s. It registers its URI
protocols per-user under `HKCU` and has an Inno Setup installer. Its canonical
production publish is a self-contained, unpackaged, multi-file `win-x64`
payload with the private .NET and Windows App SDK/WinUI runtimes included;
trimming, NativeAOT, and ReadyToRun are disabled. The installer recursively
preserves that validated publish tree and writes setup artifacts to a separate
directory, so its output cannot become its own input. The helper remains
outside the Node build, the Node test suite, and the server process.

The stable Inno AppId also defines the per-user uninstall identity under
`HKCU`. Setup reads that identity's `DisplayVersion` during `InitializeSetup`
and uses Inno's numeric packed-version comparison against the canonical
`MyAppVersion`: upgrades and same-version repair remain allowed, while a newer
installed helper blocks an older candidate before installation mutates files or
protocol registration. Missing or malformed installed version metadata is
logged and allowed as repair rather than silently treated as newer.

Direct inspection of the retained 1.0.0 and shipped 1.1.0 setup binaries,
cross-checked against their historical `[Files]` rules, proves that each
installed only `OpenLocally.exe` under the application directory. They shipped
no loose browser/CDP automation files or directories, and the current package
naturally replaces that executable. No manifest-backed obsolete file is known;
cleanup remains a D2B2 decision and no deletion rule is present in D2B1.

The existing Open Locally boundary remains **one versioned URI contract**:

```
creatorcrate-open://open?v=2&path=<absolute-windows-path>&select=<0|1>
```

The Open Locally web side of that contract is
[`src/util/open-locally.js`](src/util/open-locally.js) — a **pure string
builder** with no filesystem or database access and no
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
Open Locally pathway keeps no configuration of its own — the path is supplied
with every request. Social preparation maintains only its separately documented
per-user trust state.

[`downloads.js`](src/routes/downloads.js) serves the built installer from
[`downloads/`](downloads/) under **one fixed constant filename**; the route
never resolves user input, and an exported availability probe lets Settings
hide the download action when the artifact was not built into the image.

Changing the existing `creatorcrate-open://` URI contract means changing both
sides and bumping `v`; its helper pathway remains independent of the Node
application.

### Social-preparation activation and dispatch

Social preparation is an **additive** second protocol family handled by the
same executable, not a second helper:

```
creatorcrate-social://prepare?v=2&server=<origin>&intent=<opaque-token>
```

The activation envelope carries only the protocol version, the CreatorCrate
server origin, and a short-lived opaque intent. The helper strictly parses
that shape; a version it does not support produces update-required behavior.
Content, media, and bearer capability material never enter the activation URI.
Version 1 identifies the removed automated-browser lifecycle. Manual-companion
handoffs use version 2 even though the envelope fields remain minimal and
unchanged. The current helper rejects a structurally valid v1 activation with
`unsupported_social_workflow` before trust, redemption, staging, or manual
companion construction. There is no version fallback.

An authenticated, CSRF-protected browser may replace a launch intent only by
naming the exact current issued session. The service verifies that every
platform still owned by that session is `pending`, conditionally expires the
issued row, and creates the replacement through the shared validation,
content, snapshot, and platform-assignment path inside one `BEGIN IMMEDIATE`
transaction. The replacement receives a new session and intent; the old intent
cannot redeem. A redeemed session, including one already in `staging`, cannot
be expired through this path. The live-session unique index and conditional
state update serialize concurrent reissue/redeem attempts without changing
Release publication fields or activity.

The command dispatcher preserves the Open Locally isolation boundary. A
`creatorcrate-open://` activation takes its established path and does not
initialize social trust, HTTP, media, or manual-companion components.
The existing `--register` and `--unregister` commands stay independent.
`--register-social` and `--unregister-social` register only the
`creatorcrate-social` protocol. The production installer invokes both command
pairs around its lifecycle, with each quoted protocol command pointing to the
same installed executable. Unregister removes a scheme tree only while its
command is still owned by that executable.

### Unsupported v1 and manual v2 dispatch

The helper retains no implementation of the legacy v1 automated-browser
workflow. A v1 activation fails deterministically with
`unsupported_social_workflow` directly after strict URI parsing, before any
trust prompt, DNS or network activity, redemption, media sweep, or companion
construction.

The v2 activation takes a separate manual preparation path. Its production
composition owns only origin trust, the existing social HTTP/redeem/capability
clients, the local-media resolver, and the staging service. It has no Chrome,
remote-debugging, CDP, WebSocket-browser, readiness bridge, or platform-adapter
dependency. After one redemption it moves every targeted platform to `staging`,
resolves and immediately revalidates every selected asset in authoritative
server order, constructs an immutable in-memory manual-session handoff, and
then moves each platform to `ready`. The handoff retains the origin, release ID,
server-supplied release title, exact per-platform title/body, complete asset
metadata, provenance, and usable path; it exposes no bearer capability. Failure
of any required asset produces
`failed` for that platform and `cancelled` for the other unfinished targets,
never a partial `ready`. The native manual publishing companion is implemented,
and `ready` is reported only after its operator-ready boundary. At that terminal
server-preparation boundary, the helper-owned staging lease transfers to the
companion and remains held while its window is open; closing an already-ready
window does not report cancellation or imply that publishing occurred. When the
window closes, the local lease releases and normal 24-hour retention resumes,
without extending the server capability or session through the human publishing
period.

### Trusted CreatorCrate origins and capability use

First-use server trust is for one exact normalized HTTP(S) origin and persists
per Windows user. Scheme, host, and effective port identify distinct origins;
the store contains origins only. An unknown origin requires native confirmation,
and denial happens before DNS or network activity.

HTTPS uses normal platform TLS validation without a certificate bypass.
Plain HTTP is accepted only for approved loopback, private, or local
addresses; public plaintext HTTP is rejected. Sensitive social requests disable
redirect following. For a permitted plaintext hostname, the approved DNS
answers are pinned for the connection so a later resolution cannot rebind it.

The helper redeems an intent with `POST /social-prep/redeem`, sending the
intent in the JSON body. Its response is authoritative: the helper neither
recomputes title or body, reads `notes`, nor role-filters the asset
snapshot. The subsequent media/status capability is bearer authorization only.
Capability outcomes retain meaningful distinctions, including expired,
superseded, already-finished, and invalid states.

### Trusted local media roots

Origin trust never authorizes arbitrary local-file upload. For a
server-provided Windows candidate path, the helper correlates the candidate
with the asset snapshot `relativePath` to derive a local project root. The
exact normalized origin/root pair needs separate per-user approval in the
trusted-media-root store. The candidate must satisfy containment, reparse-point,
existence and regular-file checks, and an exact-size check.

A valid Strategy A source remains external source media. It is never modified
or deleted by helper cleanup.

### Authenticated media staging and cleanup

When the candidate is unavailable, invalid, or not trusted, Strategy B downloads
the immutable server snapshot through the authenticated media endpoint. The
bearer token stays in the Authorization header, never a URL. The response
streams into helper-owned temporary storage under a deterministic safe final
filename, first through a partial file and then finalization. Per-file and
aggregate limits are 2 GiB and 8 GiB respectively, and the helper verifies
the actual byte count against the snapshot. Within one session, each asset ID
is resolved once and reused only when all safe staging metadata agrees; a
contradictory repeated representation fails closed rather than reusing a path.

Helper-owned session directories use a safe derived identifier rather than
token material and carry an ownership marker. The helper validates the complete
configured staging-root-to-session chain as non-reparse before it creates,
reuses, or reads that marker; it never claims an existing unmarked directory.
While a process actively uses a session directory it holds the marker open for
shared read access without sharing writes or deletion. This prevents the live
marker from being deleted, renamed, or replaced; other active helper processes
may still hold the same read lease. A sweeper opens that marker with read and
DELETE access under `FileShare.None`, so it conflicts with owners and other
sweepers. It also opens the staging root and session directory without following
reparse points, validates their handle attributes, and pins both identities by
withholding delete sharing throughout cleanup. The marker remains intact while
expected top-level children are removed. Only after that succeeds does the
sweeper create durable recovery ownership metadata on the session directory,
mark the marker delete-pending, and release its handle. Windows releases owner
and sweeper leases automatically on process exit. Ending a preparation run
disposes its lease deterministically but does not delete successfully staged
media.

A successfully finalized download creates dedicated last-use metadata. Its
filesystem last-write timestamp is refreshed after finalization and after each
successful pre-use revalidation; those are the only events that extend the
retention clock. Completed media remains available through exactly 24 hours
after that timestamp and becomes sweep-eligible only after the boundary. The
on-demand sweep first acquires the directory lease and validates every child as
an expected top-level regular staging file or metadata file. It removes safe
abandoned partial files, and then deletes only expired, positively owned session
directories without recursive traversal. Any nested directory, reparse point,
or unexpected object fails closed. File replacement can at most make a
non-recursive file deletion fail. Final session removal is committed with
`SetFileInformationByHandle` against the already validated, pinned directory
handle; it never resolves the session pathname again. The pinned staging-root
and session handles prevent ancestor or session replacement during that final
window. If final disposition fails after marker removal, the recovery metadata
restores the ordinary marker; if recovery streams are unavailable, cleanup
retains the marker and directory instead of attempting unsafe final removal.
Older v1 marker directories without last-use metadata retain completed
files using their newest file/directory timestamp, while failed or partial-only
directories may be removed immediately. Missing directories and competing
sweepers are benign. Malformed or reparse metadata fails closed. There is no
daemon, service, scheduled task, or resident cleanup loop, and Strategy A
sources are excluded from cleanup.

Before the manual companion exposes media, it revalidates the exact
expected path, provenance, size, regular-file status, ownership/containment,
and reparse safety. Failures return stable codes instead of dropping an item.
A missing or size-mismatched helper-owned download can be restaged through the
same authenticated capability client; capability expiry remains authoritative
and requires a new preparation. External Strategy A sources are only
revalidated and are never copied, renamed, deleted, or silently restaged by
that recovery path. This local retention lifecycle remains separate from the
server attempt, which may terminate at `ready` immediately.

Native thumbnail extraction uses a separate side-effect-free read lease,
not the availability/recovery operation. Acquisition reuses the approved
expected-path, provenance, staging-ownership, and external-root trust rules,
then pins the validated boundary directories, ownership marker when applicable,
and exact regular file with non-delete-sharing Windows handles for the bounded
extraction duration. It performs no download, restaging, trust prompt, or
retention refresh. A preview failure is local to preview presentation and does
not change the prepared asset, selection, or drag eligibility. This lease is
the exclusive filesystem boundary for the Shell/ImageList preview pipeline
described below.

### Native manual Social Preparation helper

Social Preparation v2 is implemented exclusively as a native manual publishing workflow. The helper supports manual copying of prepared social text, dragging prepared local files, and explicit **Mark as posted** confirmation back to CreatorCrate after the operator manually publishes. Close, Copy, and Drag do not mean Posted. The helper does not post to, control, or automate social websites. It strictly parses and trusts the activation origin, redeems the single-use intent, uses the protected capability APIs, resolves and stages media with the existing containment and reparse protections, and presents the native manual publishing companion. The companion preserves Patreon title/body separation and the exact X and Bluesky post text supplied by the server.

The production helper contains no Chrome discovery or control, remote-debugging support, CDP transport, browser WebSocket connection, DOM evaluation, automated typing or upload, browser readiness/approval bridge, platform adapter, or site-specific composer automation. It never exposes media URLs or bearer tokens as a fallback. The retained native operator-host and failure-dialog infrastructure provide desktop-safe manual UI only; they do not connect to or manipulate a browser.

### Deferred social-preparation work

After a successful Release publication initializes at least one configured
Social Preparation target, the existing publication route redirects once to the
Release detail page with `prep=1`. That exact marker invokes the same release-level
publishing-companion action that remains available for explicit use: client
initialization removes only `prep` with `history.replaceState` and submits the
action once. The Social Preparation service projects the safe mode from current
session/platform state: active/non-reissuable attempts suppress reopening;
issued unredeemed intents use exact-session reissue; and failed/cancelled or
otherwise server-retryable work uses normal server-authoritative activation.
Only when Reopen is the authoritative action does the release-level reprepare
target the full safe configured set of completed `ready` and legacy `prepared`
platforms, preserving their existing deterministic order in one fresh session,
single-use intent, and v2 URI. The existing authenticated, CSRF-protected
activation and reissue routes remain the only mutation paths, and none of these
actions republishes the Release.

Every successful activation, reprepare, or reissue response replaces the page's
ephemeral current session ID before one best-effort `location.assign` attempt
with the fresh v2 URI. The next click therefore performs exact-session reissue
without a refresh, even when the protocol call throws. Neither the URI nor its
intent is written to markup or browser storage, and the browser attempt is never
interpreted as helper success or used to mutate preparation status. Requests are
serialized per page action; failures and `409` conflicts remain bounded local
feedback and cannot change Release publication metadata or activity.

The following work remains deliberately outside Milestone 2:

- production Patreon, X, and Bluesky adapters;
- real platform selectors and composer behavior;
- live Social Preparation polling or social-publication tracking;
- final submission, posting, publishing, and platform API posting;
- NativeAOT, ReadyToRun, and trimming decisions.

#### Partial Social Preparation checkpoint — pause/resume (WP-E)

This partial checkpoint is not completion of Milestone 3 or the full Social
Posting feature: **Milestone 3 remains incomplete**. It does not activate
production helper integration. The list above records the Milestone 2 boundary;
the following is the current restart status. A release may target multiple
platforms. `prepared` means a composer prepared for human submission, not posted;
normal final social submission remains human-operated.

The native manual-publishing workflow extends the persisted platform-state
vocabulary without rewriting that history. `staging` means the companion is
resolving and making outgoing content and files available; `ready` means those
materials are available for manual publishing. `ready` is terminal only for the
preparation attempt and is not evidence that the operator posted or published
anything. `posted` is separate current-state evidence created only by explicit
operator confirmation, with its first server UTC time stored in `posted_at`.
Legacy `prepared` rows and `prepared_at` timestamps keep their original
browser-composer meaning and are never interpreted as posting evidence.

`release_social_platforms.is_selected` records the release's current platform
selection independently of preparation and posting history. Existing rows
migrate as selected. Exact-set replacement retains deselected rows and their
lifecycle fields, and reselecting a row restores selection without resetting
that history. It rejects deselection of a target owned by a live `issued` or
`redeemed` preparation session. New and Edit Release own and save platform
selections through the release service in the same SQLite transaction as release
metadata and any selected assets. Edit also offers its saved selected platforms
when they are no longer globally configured. A submitted presence marker
distinguishes an intentional empty selection from a request that does not own
the control. Review & Publish renders shared preparation details once and
summarizes saved selected platforms; publication uses that same saved
selected-platform set.

The manual lifecycle is `pending -> staging -> ready`, with `failed` and
`cancelled` allowed while work is pending or staging. `staging` participates in
the existing 15-minute inactivity and 30-minute hard-deadline recovery policy;
`ready` is terminal and immediately contributes to finishing the redeemed
session, so manual composition after handoff cannot extend the capability.

Redeeming a v2 manual session also fixes a distinct 24-hour
`manual_confirmation_expires_at` deadline on the already-redeemed bearer digest.
The preparation/media capability remains governed by its existing shorter
deadline and redeemed-state rules; finishing a preparation session does not
reopen media or preparation-status authority. The confirmation-specific
authentication path accepts only redeemed or finished, non-superseded sessions
within the confirmation deadline. In one `BEGIN IMMEDIATE` transaction,
`POST /social-prep/:sessionId/platforms/:platform/posted` reauthenticates that
narrow authority, verifies current target ownership, and changes only `ready ->
posted`. The POST accepts no request entity: positive `Content-Length` or any
`Transfer-Encoding` framing is rejected before confirmation. Repeating a
`posted -> posted` transition returns the original `posted_at`. The
matching confirmation-specific GET provides canonical readback when a committed
POST response is lost.

Manual Social Posts completion is a selected-platform aggregate, not Release
publication: at least one currently selected platform must exist and every
selected platform must have a current `posted` row. Unselected configured
platforms and deselected historical rows do not contribute. Explicit reprepare
honors the requested platform subset. Selecting a posted target creates fresh
session ownership, resets only that target to preparation state, and clears
only its `posted_at`; other posted targets retain their evidence. Each selected,
currently configured Posted target exposes
an explicit per-platform `Prepare another post` action. This targeted action is
the only normal UI path that intentionally starts a new attempt and clears that
target's posting confirmation; unrelated Posted targets remain untouched. An
untargeted ordinary reopen continues to cover
only `ready` and legacy `prepared`, so it cannot silently clear posting evidence.

The production v2 helper presents one raw-Win32, resizable manual publishing
window on the existing `NativeOperatorUiHost` STA/input-desktop path. The window
shows release/origin identity, switches only among the authoritative prepared
Patreon/X/Bluesky targets, copies the exact immutable prepared strings, and keeps
ordered asset selections mapped to the prepared asset objects for the later drag
package. `NativeFailureDialog` and this companion share the single
`NativeUnicodeClipboard` CF_UNICODETEXT implementation. The companion contains
no browser, CDP, adapter, embedded web surface, upload, or publish behavior. Its
asset report is also the source for generic Windows filesystem drag/drop. A
native `SysListView32` `LVN_BEGINDRAG` notification snapshots the full selected
set through stable prepared-asset ordinals in authoritative server order, feeds
that immutable snapshot into the existing drag coordinator, asynchronously
revalidates it through the WP4 availability path, and returns to the same STA for
copy-only OLE `CF_HDROP` dragging.

The companion's native visual layer is deliberately local to that window and
reuses CreatorCrate's web hierarchy rather than introducing a helper-wide UI
framework. In Windows dark app mode its page, surface, card, hover, border,
text, cyan/violet accent, focus, success, and danger values map directly to the
authoritative tokens in `src/static/creatorcrate.css`. Windows light app mode
uses a restrained companion-only adaptation of the same hierarchy and product
accents; it is not a canonical or pre-existing CreatorCrate web palette. Windows
High Contrast takes precedence over both palettes and uses system window,
text, highlight, highlight-text, and disabled-text colors with native focus
indicators and meaningful status text. Owner-drawn companion Buttons delegate
their High Contrast frame to the Windows system button renderer and use system
button-face, button-text, disabled-text, and focus cues rather than decorative
CreatorCrate colors.

The companion's current A1 hierarchy places compact release identity above one
Content card, then Assets, then the existing footer. Content begins with its
integrated platform selector. Patreon title and body, or the X/Bluesky post,
each put the model-backed Copy button in the field header immediately above the
reusable WinUI editor. The platform posting status, action, and measured helper
guidance follow the editor as one bounded group; canonical aggregate completion
is displayed as readable text at the left of a compact divided footer, with the
secondary Close action aligned at the right. The footer background and divider may
span the full window, while aggregate text, operational feedback, and Close align
to the bounded A1 content column. The footer normally uses 12 logical pixels of
vertical and 16 logical pixels of column-relative horizontal padding and adds a measured,
bounded second line only for transient operational feedback. Native layout keeps
the supported 820 by 754 logical client minimum, shares normal height growth
between the post editor and Assets, bounds editor and Assets growth on very tall
windows, and centers a main column capped at 1152 logical pixels on wide windows. A2 removes Select
All and adds selection count and drag guidance to Assets. B1 owns the ListView
header, B2A owns responsive columns, B2B owns selection chrome, and C owns final
button, footer, and native chrome styling.

Package C1 establishes the native Button hierarchy without replacing any Button
HWND: Mark as posted and its reconciliation-only Retry confirmation state are the
single primary action role, while model-backed Copy actions and Close use the
restrained secondary role. Dark and light modes provide distinct normal, hover,
pressed, keyboard-focus, and disabled treatments; pressed geometry and visible
focus cues supplement color changes. The compact footer retains the controller's
server-authoritative aggregate, may use the existing success role only for the
readable all-posted message, and does not infer completion from preparation actions.

Package C2A keeps Platform as the production native `ComboBox` with its existing
selection and platform-change authority. It harmonizes only the closed selector,
dropdown rows, local arrow chrome, border, hover, and visible focus presentation
with the companion's dark and light theme roles. Native keyboard navigation,
dropdown behavior, UI Automation patterns, and selection items remain supplied by
Windows; High Contrast retains system-owned control chrome and system colors.
The authoritative theme refresh reapplies the DPI-derived owner-drawn dropdown-row
height to the live ComboBox, while leaving its separately sized closed selection
field unchanged. Each legitimate dropdown opening reacquires the current
`ComboLBox` through `GetComboBoxInfo` and immediately applies the active local
dark, light, or system-owned High Contrast theme; popup identity is not retained
as a lifecycle invariant. Per-opening observation records the actual native
theme-operation result; in High Contrast, success specifically means the native
reset to system-owned chrome succeeded. Regression coverage proves this supported
per-opening reacquisition path against the real USER32-owned popup; it does not manufacture
or require popup replacement while the production ComboBox remains alive.
Package C2B completes the code implementation of the whole-window presentation
system without replacing native controls or changing A1 geometry. Native typography
has four DPI-aware logical-pixel roles built through one GDI path: a 20-pixel
semibold release heading, 12-pixel semibold section headings, 14-pixel normal
labels/body controls, and 12-pixel normal supporting text. These logical-pixel
values become negative `LOGFONT` heights at the current window DPI; they are not
point sizes and do not add a Windows Text Size multiplier. WinUI continues to own
its separately documented 16-effective-pixel accessible text scaling.

C2B also makes the shared presentation hierarchy explicit: the page surrounds
12-pixel-radius section surfaces, each section uses a compact inset raised header
panel with an 8-pixel radius, and nested editor/ListView details use the raised
surface and six-pixel control radius where the owning control safely supports it.
The native and WinUI sides now share section, nested, normal-border, strong-border,
text, muted, focus, success, and danger roles. Primary field labels and selected
asset information remain primary text; release metadata, helper guidance, and
supplementary status remain supporting text. Ready/confirming/posted/unknown state
is still stated in text, with success or danger color only as a supplement.

Dark and light use the same structural hierarchy. High Contrast bypasses C2B
decorative section panels and radii, keeps system colors/focus/selection
authoritative, and removes WinUI decorative resource overrides. Theme refreshes
reuse the production native HWNDs and both WinUI islands. Automated role, real-HWND
font, 96/144/192-DPI construction, native/WinUI resource, transition, accessibility,
and lifetime coverage verifies objective behavior but did not establish subjective
visual quality. Integrated manual visual acceptance has passed through user desktop
inspection of the completed visual packages, including the content-aware Assets
viewport correction and executable/window icon. The later real browser drop proves
the production generic multi-file source path; the earlier one-file outcome is not
reproducible as a generalized source defect. WP10D clean-machine, offline-runtime,
prerequisite, and installer validation remains outstanding.

A1 changes layout and hierarchy only. B2A keeps the native report columns
responsive to the actual ListView client width: File is the flexible primary
column, Role, Size, and Status retain compact DPI-scaled widths, and Path/staged
name remains available within a bounded useful region. If the useful minimums
exceed the viewport, the existing native horizontal scrolling remains the
overflow mechanism. Automatic sizing runs only when ListView client geometry or
DPI changes, so ordinary selection, posting, preview, and platform refreshes do
not overwrite a manual header-divider adjustment; native column reordering
remains disabled. B2B keeps the native `LVIS_SELECTED` item state authoritative
and extends the production ListView custom-draw path without replacing native
thumbnail or text painting. In dark and light modes, every selected row retains
a full-row selected surface after keyboard focus leaves the ListView and receives
a clipped, DPI-scaled CreatorCrate accent edge at the visible client leading edge.
The edge is decorative only; native focused-item state and system focus painting
remain separate from selection. High Contrast bypasses the custom selected-row
surface and accent entirely so Windows supplies system selection and focus colors.
B2 is complete through B2A and B2B; Package C1 button/footer styling, C2A
Platform selector presentation, and C2B whole-window presentation harmonization
are code-complete, and their integrated manual visual acceptance passed through
user desktop inspection rather than automated aesthetic proof. Visual redesign was
not drag/`CF_HDROP` fix evidence and no production source fix was needed: later real
browser acceptance proved the unchanged generic multi-file drag path. Individual
destination acceptance and WP10D installer/deployment validation remain outstanding;
this visual acceptance did not finalize the installer.

The executable embeds the supported Common Controls v6 dependency through its
MSBuild `ApplicationManifest`; no adjacent arbitrarily named manifest controls
activation. The raw-Win32 window uses DPI-scaled Segoe UI heading, body/control,
section, and metadata fonts plus one bounded owner for its GDI brushes/fonts.
Documented control-color, common-control theme, and custom-draw paths theme the
platform ComboBox, action Buttons, status, and native
asset ListView/report control without changing its keyboard or multiple-selection
semantics. Native click, Ctrl, Shift, and keyboard selection retain every valid
visible row by stable ordinal, including an unavailable row explicitly selected
by the operator. All available assets start selected; unavailable assets start
unselected. The operator adjusts each platform's selection through the native
ListView, and Assets shows `N of M selected` for all displayed rows plus guidance
for dragging the selected set or explaining an empty or unavailable selection.
The unchanged production multi-file path was later proven through a real browser
drop; the earlier one-file result is not a generalized source defect. Report rows
expose File, Role, Size, Status, and Path/staged-name text;

The report header remains the ListView-owned native `SysHeader32`, resolved with
documented `LVM_GETHEADER`; it is not replaced and retains native column and
accessibility semantics. Because that header sends `WM_NOTIFY` to its immediate
ListView parent, a narrow ListView subclass routes only the real header's
`NM_CUSTOMDRAW` notifications to an `NMCUSTOMDRAW` handler, while top-level
ListView notification validation remains unchanged. Dark and light modes use
documented prepaint, item-prepaint, and postpaint stages to paint the existing
labels, restrained dividers and bottom edge, and unused trailing header area
from companion theme roles. Parent-relative item rectangles are mapped into the
Header client before that trailing area is calculated; mapping failure skips the
trailing fill. High Contrast returns to system/native header drawing. B2A owns
responsive column sizing while B2B still owns selected-row chrome; this header work
did not change drag behavior or Package C chrome. Later browser acceptance proved
the unchanged generic multi-file path independently.

the File column now combines that filename with a DPI-scaled native thumbnail or
purpose-specific placeholder from a 32-bit-alpha ListView ImageList. Image
previews are extracted with `IShellItemImageFactory` only while one reviewed
`ManualAssetPreviewAccess` read lease pins the validated pathname. The UI installs
the placeholder and enqueues every preview request; only a background worker may
acquire a fresh lease and then consult the cache. Each lease exposes immutable
cache identity derived from its already-pinned handle: volume serial, 128-bit file
ID, verified size, and handle-reported change time. A same-path, same-size file
replacement or in-place content change therefore cannot authorize stale pixels.
If the filesystem cannot provide the complete strong identity and version, that
acquisition remains previewable through Shell extraction but is not eligible for
cache lookup or insertion. Two dedicated background threads are configured as STA
before either thread starts; each then balances its successful explicit
`CoInitializeEx(COINIT_APARTMENTTHREADED)` call with one `CoUninitialize`. These
workers bound the Shell work; on a miss each copies the returned HBITMAP into CreatorCrate-owned
BGRA pixels, releases the Shell bitmap and COM interface, and then disposes that
extraction's lease. A small synchronized per-window LRU stores only copied pixels
keyed by stable asset/path/provenance/expected-size, requested pixel size, and the
proven pinned-file identity/version. It never stores a lease or filesystem handle.

Preview requests and results carry the window generation, platform identity,
stable asset ordinal/reference, and DPI pixel size. The UI applies a result only
when all identities still match, so platform switches, DPI changes, and close
discard stale completion safely. Unavailable assets, non-image files, preview
access failures, and Shell extraction failures use distinct neutral/generated
placeholders; none changes Status, selection, prepared availability, drag
eligibility, server state, retention, staging, or capability use. Preview failure
has no network or restaging fallback. DPI and theme changes recreate the
ImageList/placeholders; each accepted request reacquires preview access and may
then use same-size cached pixels for the unchanged pinned file, while
one 256-item budget bounds all accepted work across the request queue, active
Shell extraction, and completed results awaiting the UI. Completed-result storage
has its own 64-item bound; overflow is discarded without blocking Shell workers
and releases its total-budget charge. A single interlocked notification latch
coalesces result-ready window messages, and the drain resets then rechecks the
bounded result queue so a completion racing that reset cannot be stranded.
Window shutdown synchronizes request acceptance with queue completion, drops
queued work, lets an active Shell call release its lease safely, discards late
results, and destroys the ImageList/cache after the workers finish. The documented DWM immersive dark-mode window attribute is
best-effort and nonfatal. DPI, system-color, theme, and settings notifications
rebuild the scoped resources and recalculate the header, framed
platform/content and asset sections, and footer layout.

Window creation, required controls, initial content, visibility, and the usable
message-loop boundary all precede the server `ready` writes. After those writes,
server state remains terminal `ready`, while a narrow companion availability
service retains the capability solely for WP4 revalidation and controlled
restaging until the operator closes the window. A pre-ready presentation failure
reports a bounded preparation failure and never reports `ready`; normal closure
after `ready` does not relabel the completed attempt as cancelled.

Manual-social failures carry a bounded structured diagnostic beginning at v2
activation-URI parsing and continuing through redeem parsing, preparation, command
dispatch, and process-level reporting. Stable machine
codes remain available alongside fixed stage and reason vocabulary, optional safe
platform/asset ordinals, validated numeric release identity, and numeric HTTP
status. The existing native failure dialog presents and copies that safe context,
and stderr receives the same bounded report when available. Raw activation URIs,
intent or media tokens, response bodies, outgoing social text, filenames/paths,
credentials, protected URLs, exception messages, and stack traces are never
displayed or logged by this path.

The production Windows helper treats native companion usability as the final
precondition for `ready`. After redeem and `staging`, it resolves, stages, and
revalidates the authoritative content and ordered assets, opens one resizable
raw-Win32 companion on the existing `NativeOperatorUiHost` STA/input-desktop
path, and waits until the main window and required controls are visible and
usable. Only then does it write `ready` once per target. The server runtime stays
locally owned until window close only so selected media can use the approved WP4
availability operation; it performs no later platform-status writes. Closing an
already-ready window therefore does not write `cancelled` or claim that
publishing occurred.

`ManualSocialSession` remains the immutable source for Patreon title/body and
X/Bluesky post text. Copy commands use those exact strings through the shared
native Unicode clipboard implementation rather than reading rendered controls.
The helper retains the redeemed posting-confirmation authority separately in a
private companion-lifetime client; the bearer, session identifier, and optional
server deadline do not enter `ManualSocialSession` or native presentation rows.
A narrow controller exposes independent Ready, Confirming, Posted, and
confirmation-unknown state for each captured platform. Its empty-entity POST
uses the confirmation endpoint directly, while an ambiguous POST is reconciled
through the matching authenticated GET before Posted can be shown. A lost or
unreachable response never implies Posted, retries from unknown reconcile first,
and only canonical server responses supply `posted_at` and replace the retained
selected-platform completion aggregate. The helper accepts that aggregate
only when its non-negative integer counts are ordered and `isComplete` exactly
matches `totalCount > 0 && postedCount == totalCount`. The controller serializes
complete cross-platform confirmation workflows—including an ambiguous POST and
its reconciliation GET—so the last completed local workflow retains the newest
authoritative aggregate without assuming that counts are monotonic. The
orchestrator remains the controller's sole owner and disposer; the native
companion borrows it only until the companion closes.

The native companion exposes one explicit per-platform **Mark as posted** action.
That action is enabled only for the current Ready or confirmation-unknown target,
captures that platform identity, and runs the controller workflow off the native
message loop. The UI shows Posted only after canonical server acknowledgment;
ambiguous delivery remains confirmation-unknown and offers the controller-owned
reconciliation/retry path. Switching platforms while a request is pending changes
only the displayed platform, while the eventual response remains attached to the
captured target. Close, window X, Escape, copy, drag, platform switching, and the
preparation `ready` transition never invoke posting confirmation. The controller's
retained server aggregate alone drives the compact count and all-posted message;
the all-posted state leaves the window open for review and Close.

The companion keeps server asset order and maps native multi-selection directly
to the prepared asset objects. At `LVN_BEGINDRAG`, the complete current native
selection is resolved in authoritative order; any unavailable selected row
rejects the whole drag locally before coordinator preparation, while an eligible
set becomes an immutable selection snapshot. The retained WP4 availability path
then remains authoritative for later revalidation. Helper-owned files may be restaged
only through the retained authenticated WP4 path; external files are only
revalidated. The dedicated OLE data object exposes only Unicode `CF_HDROP` in
movable `HGLOBAL` storage and creates independently owned storage for every
`GetData` call. `DoDragDrop` offers COPY only. No browser, CDP, or platform
adapter dependency exists in this v2 path.

A production-window component regression drives the real `SysListView32` with
native left-button messages and crosses `SM_CXDRAG`/`SM_CYDRAG`; Common Controls,
not the test, generates `LVN_BEGINDRAG`. It proves that an unmodified drag from an
already selected row preserves the full native multi-selection at that boundary,
while click completion collapses to that row and dragging an unselected row makes
it the sole selected drag target. `LVIS_SELECTED` remains the only selection
authority, so Ctrl/Shift pointer selection and keyboard navigation stay native.
The regression stops at the immutable coordinator snapshot. A later real physical
pointer drag from the production companion into a browser/web destination proved
the generic CreatorCrate OLE delivery boundary: all three initially selected
available assets arrived in Release/list order, repeatably, regardless of which
selected row began the drag. The original one-file outcome is therefore not
reproducible as a generalized CreatorCrate source defect; this evidence does not
guarantee that every destination accepts every file or preserves the same semantics.

Package B adds an opt-in proof-only local native window beside the unchanged
production companion. On the companion STA and message pump it registers a real
`IDropTarget`, accepts COPY-only `CF_HDROP` (`DVASPECT_CONTENT`, `lindex=-1`,
`TYMED_HGLOBAL`), calls the incoming `IDataObject.GetData`, enumerates the received
`HDROP` with `DragQueryFileW`, and releases the caller-owned `STGMEDIUM` before
returning. The drag-proof fixture availability provider is local-only: it validates
the three real generated fixture paths in incoming snapshot order and still rejects
the unavailable fourth row. The receiver never copies or moves files. This harness
isolates real production `WindowsFileDrag`/`DoDragDrop` delivery from browsers; the
local harness is diagnostic/test infrastructure and is not a prerequisite for the
production result already demonstrated through the real browser drop. Patreon, X,
and Bluesky remain destination-specific manual acceptance boundaries.

When helper-owned media exists, `SocialMediaStager` transfers its existing
exclusive marker lease to the companion. The terminal preparation attempt is not
reopened; its capability remains encapsulated by the local availability service
until close and expiry remains authoritative. The companion releases the local
lease only after pending preparation and any active `DoDragDrop` have ended,
then the existing 24-hour last-use retention policy again governs sweeping.
Successful, cancelled, and rejected drops do not shorten that lifetime. External
source files never produce or receive this lease and remain untouched.

The raw-Win32 companion now uses two production WinUI 3 `RichEditBox` islands as
its only social text presentation surfaces: one reusable Patreon-title surface
and one reusable Patreon-body/X-post/Bluesky-post surface. The islands share the
companion STA dispatcher and XAML environment, use
`DesktopWindowXamlSource`/`SiteBridge` for parenting, and take their physical
bounds directly from the current native `NativeCompanionLayout` title/body
rectangles. Platform switching updates the plain-text documents, accessible
names, visibility, and tab participation without recreating either island. The
immutable `ManualSocialSession` strings remain authoritative; dedicated Copy
buttons continue to write those exact model strings rather than reading XAML
documents, while presentation-only newline conversion is confined to the
display boundary. Those two islands inherit CreatorCrate's visual language from
the same palette hierarchy as the native companion: in dark mode the section
surface frames a nested raised graphite surface with the authoritative primary text,
subtle/strong borders, and focus-blue values from `creatorcrate.css`; light mode
uses the existing companion-only card, surface, text, border, and focus
adaptation. High Contrast is detected by the native `SPI_GETHIGHCONTRAST` theme
boundary, switches each island to `ElementTheme.Default`, removes every
CreatorCrate foreground/background/border/focus resource, and clears any
previously resolved editor brush values. Text, background, selection, and focus
then remain owned by Windows system resources.

Both content surfaces use 16-effective-pixel Segoe UI Variable Text with normal
body weight, while the Patreon title uses the same size and semibold weight. A
12-by-8-effective-pixel inset, one-pixel border, six-pixel corner radius, and
1.35-times document paragraph line spacing apply inside the existing native
island rectangles; paragraph before/after spacing remains zero so model-owned
blank lines keep their meaning. Wrapping and the standard WinUI vertical
scrollbar remain enabled, horizontal scrolling remains disabled, and focus keeps
the WinUI system focus visual plus the CreatorCrate focus-border resource.

Each visible `RichEditBox` is a UIA Control-view `Edit` with class
`RichEditBox`, a platform-specific accessible name, `TextPattern`, current text,
read-only text attributes, selection ranges, and keyboard focus. The hidden
Patreon title is removed from Control view as well as tab and hit-test routing
for X and Bluesky, then restored on Patreon without recreating its island.
Out-of-process Windows UI Automation exercises these contracts against the
production companion rather than a detached proof control.

The 16-pixel `FontSize` values are effective XAML pixels and
`IsTextScaleFactorEnabled` remains enabled, so WinUI applies the Windows
accessibility text scale without a CreatorCrate multiplier. That text scale is
independent of Per-Monitor v2 DPI: native layout owns the physical island
rectangles for the current monitor DPI, while WinUI scales and scrolls text
inside those fixed rectangles. DPI changes and settings/theme changes update
the existing islands on the companion STA; they do not recreate islands or add
Windows settings event subscriptions.

WinUI initialization, both island creations, initial content application, and
native layout now precede manual-companion readiness. Initialization failure is
bounded, unwinds partial XAML state, and fails readiness with reinstall guidance;
there is no classic social-text `Edit` fallback. Dark and light companion theme
refreshes update `RequestedTheme` without island recreation, while system High
Contrast remains `Default` so system behavior takes precedence. Automated WP10C2
coverage establishes the UIA, resource-clearing, text-scale opt-in, keyboard,
layout, theme-refresh, and lifecycle contracts, but does not claim spoken
Narrator output, genuine High Contrast visuals, non-default Windows Text Size,
or physical mixed-monitor movement; those remain manual acceptance items. By explicit approval,
clean-machine Windows 11, offline private-runtime launch, and Visual C++
prerequisite validation are deferred to WP10D installer/deployment validation;
this production-surface change does not claim those gates or alter the installer.

The removed legacy browser workflow used the historical `prepared` state. Existing persisted `prepared` rows and timestamps remain readable compatibility data, but the helper can no longer create them. Current v2 runs use only the manual `staging` and terminal `ready` lifecycle described above. Completed `ready` and historical `prepared` targets can be opened again only through the explicit release-level reprepare activation, which creates a new session and leaves the published Release and prior session unchanged.

**Current helper state:** the reviewed v2 manual companion is the only production Social Preparation implementation. The old Chrome/CDP/browser transport, browser readiness bridge, automated X, Bluesky, and Patreon adapters, legacy orchestrator/runtime, and automation-only diagnostic harnesses have been removed. The stable per-user installer now delivers that helper and registers both `creatorcrate-open` and `creatorcrate-social` to the same executable.

**Git hygiene (approved; closed once committed):** test-project generated `bin`/`obj`
output is excluded from future tracking and is no longer intended to remain tracked.
This checkpoint removes the 115 generated test `bin`/`obj` files from Git tracking
while preserving their local copies. Narrow ignore rules keep future test build
output untracked. The shipped `downloads/CreatorCrate.OpenLocally-Setup.exe`
remains intentionally tracked because the current helper download/Docker path
uses it.

**Future planning task — CreatorCrate Windows Helper — selectable Open Locally
and Social Preparation modules:** evaluate shared core versus optional components;
installing Open Locally alone, Social Preparation alone, or both; independent
protocol registration; per-user installation; existing-install upgrade and uninstall
safety; preservation of settings/trust/configuration; user-facing rename versus
internal executable/project naming; and compatibility with the existing helper
download/distribution path. No mechanics are decided here. This checkpoint does
not rename projects, executables, installer files, download routes, or internal
namespaces, and does not modify the installer.

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
