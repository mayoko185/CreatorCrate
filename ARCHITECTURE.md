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
scale maps, processing presets, generated artifacts, project primary images,
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
  project directories and their category subdirectories, and writes a
  `project.json` manifest, but the operator is expected to add and edit
  files directly (including over SMB). Project directories are **flat direct
  children** of `PROJECTS_ROOT`, named `<zero-padded-id>-<slug>`.
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
and awaits HTTP server close, then awaits `waitForIdle()` before logging completion,
closing the current database and exiting. Tracker-owned promise waiters resolve on
the final lease completion (or immediately when idle), without polling or timeout.
Disconnect cancellation does not release a lease: graph-dependent cleanup must
settle first. Shutdown does not cancel uploads, undo durable commits, or delete
retained recovery artifacts. Restore remains fail-fast; processing-job shutdown
semantics are unchanged and no processing admission gate is added. Cross-restart
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
`OpenLocally.exe` executable in `CreatorCrate.OpenLocally.sln`. It remains a
`net8.0-windows` application with zero third-party production
`PackageReference`s, registers its URI protocols per-user under `HKCU`, and has
an Inno Setup installer. It ships as a self-contained single-file executable
and is not part of the Node build, the Node test suite, or the server process.

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
creatorcrate-social://prepare?v=1&server=<origin>&intent=<opaque-token>
```

The activation envelope carries only the protocol version, the CreatorCrate
server origin, and a short-lived opaque intent. The helper strictly parses
that shape; a version it does not support produces update-required behavior.
Content, media, and bearer capability material never enter the activation URI.

The command dispatcher preserves the Open Locally isolation boundary. A
`creatorcrate-open://` activation takes its established path and does not
initialize social trust, HTTP, media, Chrome, WebSocket, or CDP components.
The existing `--register` and `--unregister` commands stay independent.
`--register-social` and `--unregister-social` register only the
`creatorcrate-social` protocol. Installer invocation of those social
commands is intentionally not wired yet.

### Production availability gate

Milestone 2 deliberately ships an empty production adapter registry. Before
constructing any social runtime dependency, the dispatcher verifies coverage
for the frozen platform vocabulary. The current production result is
`production_adapters_unavailable`; therefore it occurs before a trust
prompt, DNS or network activity, redemption, media sweep or access, Chrome
discovery, and WebSocket or CDP work. This preserves the real attempt: the
activation URI does not name the selected platforms, so redeeming just to
discover a missing adapter would mutate an attempt unnecessarily.

Production social preparation is consequently **not** platform-ready in this
milestone. The runtime composition and orchestration seams exist so adapters
can be supplied later without weakening this pre-side-effect gate.

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
Cleanup is idempotent and refuses to traverse reparse points. The on-demand
abandonment sweep deletes only positively owned directories older than 24 hours.
There is no daemon, service, scheduled task, or resident cleanup loop, and
Strategy A sources are excluded from cleanup.

### Chrome, CDP, and generic browser preparation

The production browser architecture remains the frozen Milestone 0/Milestone 2
model: the operator's normal installed stable Chrome profile and session. On
each run the helper re-reads Chrome-owned `DevToolsActivePort`; it does not
cache a browser WebSocket identifier, scan arbitrary ports, launch or relaunch
Chrome with debugging flags, or create another profile. It accepts only the
loopback browser endpoint, makes one BCL `ClientWebSocket` connection
attempt, uses Chrome's normal Allow/Deny consent, reuses that approved
connection throughout the preparation run, and never reconnects automatically.
The Chrome prompt and banner are intentional.

A run owns one WebSocket and one shared CDP transport. The transport assigns
monotonically unique command IDs, correlates responses, reassembles fragmented
messages, bounds message size and its event queue, routes browser-level and
flattened-session events separately, honors command cancellation and bounded
timeouts, and propagates terminal transport failure to pending calls.
`CdpSession` is a session router over that transport; it neither owns nor
reconnects the browser socket. The transport also retains an internal terminal
reason (`local_dispose`, `remote_close`, `receive_failure`, `send_failure`, or a
protocol/internal failure) for bounded lifecycle diagnostics. Caller command
cancellation remains non-terminal and does not relabel the shared transport.

The reusable browser foundation provides target enumeration and filtering,
explicitly owned target creation, flattened attach/detach, navigation and
readiness, DOM and accessibility discovery, ordinary input/textarea text
insertion and root-value verification, direct `DOM.setFileInputFiles` against a
known `backendNodeId`, optional chooser interception with session-exact
`Page.fileChooserOpened` handling, and generic upload-ready observation. It
has no platform-specific selectors. Generic rich-contenteditable exactness is
not a foundation guarantee: platform adapters own rich-editor behavior,
site-specific activation, exact readback evidence, and fail-closed handling
when exact preparation cannot be shown. Only targets explicitly created by the
fixture, test, or helper may be closed automatically; operator tabs are never
closed arbitrarily, and a successfully prepared future composer tab may remain
open.

### Preparation adapters and orchestration

The adapter contract is preparation-only. An adapter identifies one platform
and implements `PrepareAsync` with server-generated title/body and ordered
resolved media. The orchestrator retains CreatorCrate lifecycle and status
authority; adapters receive no capability and have no authority to submit or
publish.

**There is no submit, post, or publish method in the adapter or browser
preparation contract.**

The injected orchestration flow is reusable for multiple platforms: it trusts
and redeems once, validates the capability, resolves media, opens one Chrome
connection, and prepares platform adapters sequentially. Immediately before
each platform, it performs an authoritative status probe; the orchestrator owns
all status writes. An ordinary per-platform preparation failure does not erase
platforms already prepared or prevent later platforms from being considered.
By contrast, a terminal shared CDP transport failure aborts the remaining
browser preparation: the current row is failed and each unstarted row is
cancelled with `cdp_transport_failed`; no later adapter or reconnect runs.
Supersession hard-aborts the obsolete run, an already-finished attempt is a soft
successful stop, and expired or invalid capability outcomes terminate the run.
Media cleanup executes on every exit path.

### Test-only Manual foundation harness

`NativeOperatorUiHost` owns the dedicated STA thread, checked input-desktop
open/attachment, desktop lifetime, and bounded failure containment shared by
Ready consent and the full-report failure dialog. Dialog content, controls,
keyboard handling, and decisions remain separate. No dialog body runs after
desktop attachment failure; visible window style alone is not operator visibility.

Manual invocations may explicitly inject a correlated Ready response directory
and unique request ID. Only after local Ready returns `DisplayFailed` and its
thread/resources are gone may the parent present Ready once while the same child
waits at consent. Responses are atomically published and consumed once before
validation. Missing, stale, replayed, malformed, or mismatched responses fail
closed. Child exit cancels parent presentation. Normal runtime uses local native
consent and requires neither this bridge nor the harness.

The harness `-VerifyReadyConsent` mode requires `CREATORCRATE_M2_MANUAL=1`, publishes
the actual helper, and uses its existing redirected, no-console launch function
with `--verify-ready-consent`. Dispatch requires both that exact sole argument
and the manual gate. It invokes the real Ready implementation, reports bounded
decision evidence, and exits directly without constructing browser dependencies;
even Continue cannot reach Chrome in this mode. Real operator Continue and Cancel
checks are required separately; machine markers are not proof of physical visibility.

Manual social-preparation failures use the shared raw-Win32 full-report dialog;
stderr and durable capture are secondary evidence, not the operator interface.
`NativeFailureDialog.Show` returns bounded presentation evidence. Confirmation
requires an input desktop, selected thread desktop, main window and required
report/buttons, visibility, and a message loop ending after normal dismissal.
The child reporter emits a fixed `CREATORCRATE_MANUAL_PRESENTATION` stdout
record after presentation returns, without replacing the primary failure or
its exit code. The parent accepts only one exact, valid completed-presentation
record. After child exit, failed, missing, malformed, or multiple records cause
one parent fallback attempt with the full report plus safe child presentation
evidence. Confirmed child presentation or an attempted parent fallback prevents
cleanup from presenting again. Native errors retain only fixed stages, numeric
Win32/session values, and desktop/window flags, never raw exception text.

`-VerifyPublishedManualPresentation` exercises the actual published helper and
parent launch function with nonblocking offline outcomes. The explicit
`-VerifyPublishedManualDesktop` mode uses the same path with real native UI and
requires operator confirmation; automated outcomes are not desktop evidence.
Both use the existing invalid-argument manual preflight before environment,
browser, or platform access. Only the exact three-argument offline invocation
in `Program` can select stub outcomes; normal manual invocations cannot.

Manual Patreon execution owns a bounded `ManualPreparationEvidence` snapshot
from composition through runtime disposal. The wrapper, Chrome consent workflow,
socket owner, and browser-wrapper construction record their actual boundary
states (`not_started`, `entered`, `completed`, `failed`). Socket setup is distinct
from the connection attempt. Consent records only the child-consumed decision,
the existing parent bridge's Requested/Accepted flags, and a fixed local
presentation result; presentation success never implies Continue. No Ready
transport, retry, or platform behavior is changed by this observation.

The primary adapter diagnostic (including Create-resolution, CDP, lifecycle,
and cleanup evidence) is retained before outer runtime disposal can replace its
exception. Disposal still has its existing exception/return-code authority;
its state and safe exception category supplement the primary report. Adapter-
owned cleanup remains in the adapter diagnostic, not a fabricated wrapper
disposal boundary. Returned failures and caught exceptions have distinct fixed
failure kinds. `Serialize()` and `FormatForDisplay()` use the same manual evidence
payload, with no raw exception messages, type names, IDs, paths, or endpoints.
The existing 6144-byte UTF-8 transport bound applies to the combined diagnostic;
the server explicitly reconstructs the fixed manual schema and rejects malformed
or unknown nested fields. The existing native dialog displays the full report.

The existing xUnit test project contains a complete Manual foundation harness.
It is test-only and requires caller-provided `CREATORCRATE_M2_MANUAL=1`; ordinary
automated tests cannot activate its live side effects. Safe verifier and recovery
modes dispatch and return before the live activation guard. The wrapper never
self-authorizes: it validates that exact incoming value before it creates its
Manual workspace, publishes the helper, or starts any parent/testhost process.
Its controlled fixtures cover
CreatorCrate, trust and media behavior, and harmless browser preparation. The
browser fixture creates, attaches, navigates, verifies ordinary input/textarea
text, assigns its existing file input directly, observes upload readiness, and
closes one helper-owned target over the existing shared transport. It neither
tests generic rich-contenteditable exactness nor activates chooser
interception. The one target has a three-second total cleanup deadline and no
reconnect. A terminal transport stops further close commands and the session
subscription is then released locally. If preparation and cleanup both fail,
the original preparation exception remains primary and the cleanup result is
emitted as bounded secondary Manual diagnostics. A cleanup-only failure instead
surfaces the fixture-specific `owned_target_cleanup_failed` lifecycle result.
The wrapper snapshots and
restores the relevant registry state, publishes the helper to an isolated
temporary workspace, and can later exercise the normal-Chrome foundation at
the operator checkpoint. Before it starts VSTest,
the wrapper verifies the real published apphost's existence, full and final
path, readable attributes, and an owned working directory, then runs its safe
production-adapter gate preflight. Operator evidence confirms that both the
parent PowerShell launch and the VSTest/testhost launch currently reach the
managed production-adapter gate under the corrected launch configuration. The
historical native apphost startup failure remains unexplained and is not
otherwise generalized. The testhost performs the same preflight before its own
process launch and records its selected safe launch context; the wrapper
compares that record with its parent-PowerShell launch context. The actual
testhost process-stage ownership is retained until that differential evidence
proves a context failure. Its one deterministic workflow fact emits each stage
checkpoint to the wrapper before starting the stage; the writer serializes,
newline-terminates, locks, and flushes JSONL records, and the wrapper parses
only complete newline-terminated records while retaining a trailing fragment
across reads. Testhost never reads operator input: it emits a correlated
operator-confirmation event and waits for one matching response. The parent
wrapper is the canonical operator-facing owner, asks for an explicit Y/N
answer, atomically writes a JSON response in its owned workspace, and the
testhost claims that response once before it accepts only an affirmative
answer. Stage cancellation bounds an absent response; stale request IDs cannot
satisfy later checkpoints. The wrapper enforces each announced stage timeout
before its existing restoration `finally` runs. The wrapper owns only its unique
workspace: it retries
transient testhost/VSTest file locks for a bounded eight-second window, reports
one workspace-level failure if cleanup remains blocked, and keeps the recovery
export. `-RecoverFrom` restores registry state and retries that workspace
cleanup without running the Manual workflow. The Manual checkpoint remains
**incomplete**.

### Deferred social-preparation work

The following work remains deliberately outside Milestone 2:

- production Patreon, X, and Bluesky adapters;
- real platform selectors and composer behavior;
- automatic Review & Publish-to-helper activation;
- release-page Social Preparation status/retry UI, Send to helper again, and Prepare again;
- final submission, posting, publishing, and platform API posting;
- installer social-protocol wiring and helper download replacement; and
- .NET 10 migration plus NativeAOT, ReadyToRun, and trimming decisions.

#### Partial Social Preparation checkpoint — pause/resume (WP-E)

This partial checkpoint is not completion of Milestone 3 or the full Social
Posting feature: **Milestone 3 remains incomplete**. It does not activate
production helper integration. The list above records the Milestone 2 boundary;
the following is the current restart status. A release may target multiple
platforms. `prepared` means a composer prepared for human submission, not posted;
normal final social submission remains human-operated.

**Closed / reuse:** Milestone 1 server foundation, Milestone 2 helper/Chrome
foundation, Milestone 3 WP-3A, Bluesky and X adapters (both closed/pass), and
reviewed native/diagnostic failure-reporting work. This checkpoint completes
read-only release Social Preparation presentation on release detail, the canonical
release list (including its project-filtered form), and project-detail recent
release summaries. Patreon is substantially implemented, but live validation
and normal production adapter registration/integration are incomplete.

**Frozen Ready blocker:** child presentation failed at `set_thread_desktop`
with Win32 code `170`. The parent Ready request was accepted, but the decision
became `display_failed`. Chrome discovery never began, no platform adapter ran,
and no automated post/publication occurred. **Do not resume by immediately
rerunning live validation.** The next technical step is read-only diagnosis using
retained Ready evidence; no cause is inferred here.

**Incomplete / deferred:** Ready presentation diagnosis/fix; Patreon final live
**no-submit** validation and operator inspection/discard of its prepared draft;
normal production adapter registration/integration; Patreon creator vanity sourced
from CreatorCrate Settings/database; working **Send to helper again** and
**Prepare again** recovery actions; remaining runtime/performance work; and
installer/documentation work outside this checkpoint. Current release-detail
recovery presentation is read-only/unavailable and does not fulfill the eventual
working recovery requirement.

**Patreon privacy:** the real creator vanity must never be hardcoded or committed
in source, tests, defaults, documentation, or committed configuration. Keep private
live evidence out of this record.

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

**Resume order (not scheduled or begun):**

1. Inspect retained Ready evidence read-only.
2. Resolve the Ready presentation blocker using the established native UI/harness;
   do not reopen proven browser/adapter infrastructure absent a concrete regression.
3. Complete Patreon live no-submit validation and operator draft inspection/discard.
4. Complete normal production adapter registration/integration and Settings/database
   Patreon creator configuration.
5. Implement and test working recovery actions.
6. Separately plan future helper packaging/modular installation.
7. Continue later milestone/runtime/performance work only under new operator direction.

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


## Manual workflow operator-confirmation boundary

The Windows PowerShell Manual wrapper owns operator input; it uses bounded console-key polling rather than a blocking host read. A confirmation retains the currently announced stage deadline, reports the correlated question code on timeout, and writes only the existing one-use structured response file.

A structured testhost `stage-failed` event is a workflow result: the wrapper records it, drains final JSONL events, and grants a finite normal-exit window for testhost cleanup before any forced termination. Wrapper infrastructure failures—such as timeout, EOF, invalid input, response-write failure, malformed event data, or a controlled-failure cleanup overrun—use the exact owned VSTest Process object with Windows `taskkill /PID <pid> /T /F`. The taskkill helper has one absolute three-second total deadline, including any post-timeout Kill cleanup; the owned-child observation remains a separate five-second policy. Terminator timeout/nonzero and a child that remains alive are reported separately. This cleanup boundary does not change the production trust, Chrome, media-staging, or Manual workflow contracts.
