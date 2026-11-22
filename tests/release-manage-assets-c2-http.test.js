// Manage Assets Package C2: HTTP SQL pagination, filter, membership and
// read-only coverage for the bounded Package A/B implementation.
//
// Every test builds its own database, application and fixture in
// beforeEach / inside the test, so tests run individually, as a group, in any
// order and alongside other files. Expected IDs, totals and pages come from
// the fixture DEFINITION through a small JavaScript oracle (never from the
// repository method under test, and never from SQL), and key cases are also
// pinned to literal fixture indices so the oracle itself is checked.
//
// SQL evidence is recorded per request by wrapping the better-sqlite3
// Statement prototype (so statements the app prepared at construction are
// included) and by the connection's `verbose` hook (transaction control).

import { describe, it as vitestIt, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { runMigrations, closeDatabase, registerSqlFunctions } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createReleaseService } from '../src/services/release-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// The 10,000-asset cases build a large fixture and issue up to 13 measured
// requests; under concurrent suites they approach the 5 s default (about 4 s
// observed). Test-local, not a file-wide or global override.
const SCALE_TEST_TIMEOUT_MS = 30000;

// ─── SQL classification ──────────────────────────────────────────────────

const SQL_CLASSES = [
  ['page', (e) => e.sql.includes('AS is_saved_member') && e.sql.endsWith('LIMIT ? OFFSET ?')],
  ['viewAllPage', (e) => e.sql.includes('AS is_saved_member') && !/\bLIMIT\b/.test(e.sql)],
  ['count', (e) => e.sql.includes('AS candidate_total')],
  ['aggregates', (e) => e.sql.includes('AS present_candidates')],
  ['membership', (e) => e.sql.startsWith('SELECT ra.asset_id, ra.role, ra.sort_order, a.is_present FROM releases r')],
  ['savedCollection', (e) => e.sql.startsWith('SELECT ra.release_id, ra.asset_id, ra.role, ra.sort_order, ra.created_at, a.project_id')],
  ['validation', (e) => /^SELECT id, project_id, is_present FROM assets WHERE id IN \(/.test(e.sql)],
  ['recovery', (e) => /\bWHERE a\.project_id = \? AND a\.id IN \(/.test(e.sql)],
  ['perIdAssetRead', (e) => /^SELECT\b(?=.*\bFROM assets(?: a)?\b)(?=.*\bWHERE (?:a\.)?id = \?(?:\s|$))/.test(e.sql)],
  ['membershipWrite', (e) => e.method === 'run' && /^(?:INSERT|UPDATE|DELETE)\b.*\brelease_assets\b/.test(e.sql)],
  ['appMeta', (e) => /\bapp_meta\b/.test(e.sql)],
  ['other', () => true],
];

function classify(entry) {
  return SQL_CLASSES.find(([, test]) => test(entry))[0];
}

const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const isMetadataRow = (row) => row !== null && typeof row === 'object' && 'filename' in row && 'relative_path' in row;

// ─── Fixture oracle (independent of SQL) ─────────────────────────────────

// SQLite NOCASE folds ASCII A-Z only; fixture filenames used for ordering are
// ASCII, so code-unit comparison of the ASCII-folded names matches it.
const asciiFold = (value) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());

function browserOrder(a, b) {
  const x = asciiFold(a.filename);
  const y = asciiFold(b.filename);
  if (x < y) return -1;
  if (x > y) return 1;
  return a.id - b.id;
}

/**
 * The documented Manage Assets predicate, written over the fixture
 * definition: Selected keeps saved members only; a saved member that is not
 * present is always kept; every other row must be present and satisfy every
 * active filter (literal case-insensitive filename substring, exact
 * lower-cased extension, exact category).
 */
function oracle(defs, saved, q = {}) {
  const search = typeof q.search === 'string' && q.search.trim() !== '' ? q.search.trim().toLowerCase() : null;
  const extension = q.extension ?? null;
  const categoryId = q.categoryId ?? null;
  const selection = q.selection === 'all' ? 'all' : 'selected';
  const matching = defs.filter((d) => {
    const isSaved = saved.has(d.id);
    if (selection === 'selected' && !isSaved) return false;
    if (isSaved && !d.present) return true;
    if (!d.present) return false;
    if (categoryId !== null && d.categoryId !== categoryId) return false;
    if (extension !== null && d.extension.toLowerCase() !== extension) return false;
    if (search !== null && !d.filename.toLowerCase().includes(search)) return false;
    return true;
  }).sort(browserOrder);
  const total = matching.length;
  const candidateTotal = matching.filter((d) => !saved.has(d.id)).length;
  const size = q.pageSize ?? 25;
  if (size === 'all') {
    return { ids: matching.map((d) => d.id), total, candidateTotal, page: 1, pageCount: 1, all: matching };
  }
  const pageCount = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(q.page ?? 1, 1), pageCount);
  const slice = matching.slice((page - 1) * size, page * size);
  return { ids: slice.map((d) => d.id), total, candidateTotal, page, pageCount, all: matching };
}

// ─── HTML parsing ────────────────────────────────────────────────────────

const decodeHtml = (value) => value
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function liveRegion(html) {
  const start = html.indexOf('<section data-release-assets-live-region>');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

function hrefQuery(href) {
  if (!href) return null;
  const url = new URL(decodeHtml(href), 'http://local');
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

function parsePage(html) {
  const region = liveRegion(html);
  const items = region.split(/<li class="asset-(?:grid|list)-item/).slice(1).map((chunk) => ({
    missing: chunk.startsWith(' is-missing"'),
    id: Number(/data-asset-id="(\d+)"/.exec(chunk)?.[1]),
    html: chunk,
  }));
  const checkboxes = [...region.matchAll(/<input type="checkbox" form="release-assets-form" id="release-asset-select-(\d+)"[^>]*>/g)];
  const meta = /<p class="results-meta release-asset-results-meta">\s*(\d+) (selected|project) assets? (?:matches|match) the current filters\./.exec(region);
  const info = /<span class="pagination-info">Page (\d+) of (\d+)<\/span>/.exec(region);
  const hiddenStart = html.indexOf('<span data-release-assets-hidden-membership>');
  const hidden = hiddenStart < 0 ? null : html.slice(hiddenStart, html.indexOf('</span>', hiddenStart));
  return {
    region,
    ids: items.map((item) => item.id),
    missingIds: items.filter((item) => item.missing).map((item) => item.id),
    items,
    selectableIds: checkboxes.map((m) => Number(m[1])),
    checkedIds: checkboxes.filter((m) => /\schecked(?=[\s>])/.test(m[0])).map((m) => Number(m[1])),
    total: meta ? Number(meta[1]) : null,
    totalKind: meta ? meta[2] : null,
    page: info ? Number(info[1]) : null,
    pageCount: info ? Number(info[2]) : null,
    prev: hrefQuery(/<a class="pagination-prev" href="([^"]*)"/.exec(region)?.[1]),
    next: hrefQuery(/<a class="pagination-next" href="([^"]*)"/.exec(region)?.[1]),
    persistedIds: [...html.matchAll(/<input type="hidden" data-release-assets-persisted-id value="(\d+)">/g)].map((m) => Number(m[1])),
    hiddenIds: hidden === null ? null : [...hidden.matchAll(/name="selectedAssetIds" value="(\d+)"/g)].map((m) => Number(m[1])),
    hasSaveForm: html.includes('<form id="release-assets-form"'),
  };
}

function cardFacts(item) {
  return {
    role: /data-release-asset-stored-fact-label="Role">Role<\/dt><dd>([^<]*)<\/dd>/.exec(item.html)?.[1] ?? null,
    order: /data-release-asset-stored-fact-label="Order">Order<\/dt><dd>([^<]*)<\/dd>/.exec(item.html)?.[1] ?? null,
  };
}

// ─── Fixture ownership and lifecycle (C2-F2) ─────────────────────────────
//
// Vitest does not cancel a timed-out test body: it runs afterEach and the next
// test while the old body (and its HTTP request) may still be pending. So:
//
// * Every test builds one fixture object (db, server, agent, temp dir, trace
//   state, tracked client requests and server-side responses). Each body runs
//   inside AsyncLocalStorage owned by that fixture (see `it` below), and the
//   shared `db` / `agent` bindings are proxies that refuse any caller whose
//   owner is not that live fixture. A stale body therefore cannot read or
//   mutate a newer fixture, even through code after an await.
// * SQL tracing is a registry keyed by the raw connection. A measurement can
//   only detach its own sink, and the Statement prototype is restored as soon
//   as no sink remains, so a stale finally cannot touch a newer trace.
// * afterEach drains both the client request and the server-side response
//   (res.end reached and the socket closed) before closing SQLite. If that
//   does not happen by the deadline, it cancels (abort + destroy sockets),
//   detaches the trace and, if server work still has not settled, quarantines
//   the fixture with its connection open (reaped later, reported in afterAll).
//   Expiry always fails afterEach explicitly; it never cleans up silently.

const C2_DRAIN_LIMIT_MS = 15000;
const C2_CANCEL_GRACE_MS = 2000;
const C2_AFTER_EACH_TIMEOUT_MS = C2_DRAIN_LIMIT_MS + C2_CANCEL_GRACE_MS + 5000;

const fixtureOwner = new AsyncLocalStorage();
const quarantined = new Set();
let liveFixture = null;
let fixtureSequence = 0;

class StaleFixtureError extends Error {}

function assertOwner(fixture, what) {
  const caller = fixtureOwner.getStore();
  if (caller !== fixture) {
    throw new StaleFixtureError(`C2 ${what}: test body of fixture #${caller?.id ?? 'none'} cannot use fixture #${fixture.id}`);
  }
  if (fixture.state !== 'live') {
    throw new StaleFixtureError(`C2 ${what}: fixture #${fixture.id} is ${fixture.state}; a timed-out test body must not continue`);
  }
}

/** The live fixture, only for a caller that owns it. */
function currentFixture(what = 'fixture access') {
  if (!liveFixture) throw new StaleFixtureError(`C2 ${what}: no live fixture`);
  assertOwner(liveFixture, what);
  return liveFixture;
}

function ownedProxy(fixture, target, label) {
  return new Proxy(target, {
    get(object, property) {
      assertOwner(fixture, `${label}.${String(property)}`);
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
    set(object, property, value) {
      assertOwner(fixture, `${label}.${String(property)} =`);
      return Reflect.set(object, property, value, object);
    },
  });
}

/** Runs each test body inside its fixture's ownership context. */
function ownedBody(fn) {
  return function c2OwnedBody(...args) {
    const fixture = liveFixture;
    if (!fixture || fixture.state !== 'live') throw new StaleFixtureError('C2 test body started without a live fixture');
    return fixtureOwner.run(fixture, () => fn.apply(this, args));
  };
}

const it = (name, fn, options) => vitestIt(name, ownedBody(fn), options);
it.each = (table) => (name, fn, options) => vitestIt.each(table)(name, ownedBody(fn), options);

// SQL tracing registry: raw connection → sink. Installed while any sink exists.
const TRACED_METHODS = ['all', 'get', 'run', 'iterate'];
const tracing = { proto: null, originals: null, wrappers: null, sinks: new Map() };

function attachTrace(database, sink) {
  if (tracing.sinks.has(database)) throw new Error('C2 measure() calls must not overlap on one connection');
  if (tracing.sinks.size === 0) {
    const proto = Object.getPrototypeOf(database.prepare('SELECT 1'));
    const originals = {};
    const wrappers = {};
    for (const method of TRACED_METHODS) {
      const original = proto[method];
      originals[method] = original;
      wrappers[method] = function traced(...args) {
        const result = original.apply(this, args);
        const owner = tracing.sinks.get(this.database);
        if (owner) owner(this, method, args, result);
        return result;
      };
      proto[method] = wrappers[method];
    }
    Object.assign(tracing, { proto, originals, wrappers });
  }
  tracing.sinks.set(database, sink);
}

/** Detaches only `sink`; restores the prototype when no sink remains. */
function detachTrace(database, sink) {
  if (tracing.sinks.get(database) !== sink) return false;
  tracing.sinks.delete(database);
  if (tracing.sinks.size === 0 && tracing.proto) {
    for (const method of TRACED_METHODS) {
      if (tracing.proto[method] !== tracing.wrappers[method]) {
        throw new Error(`C2 tracing: Statement.prototype.${method} was replaced by someone else while traced`);
      }
      tracing.proto[method] = tracing.originals[method];
    }
    Object.assign(tracing, { proto: null, originals: null, wrappers: null });
  }
  return true;
}

function notifyFixture(fixture) {
  for (const waiter of [...fixture.waiters]) waiter();
}

const fixtureIdle = (fixture) => fixture.requests.size === 0 && fixture.responses.size === 0;

/** Resolves true once no client request or server response is outstanding; false at the deadline. */
function drainFixture(fixture, limitMs) {
  if (fixtureIdle(fixture)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const check = () => {
      if (!fixtureIdle(fixture)) return;
      clearTimeout(timer);
      fixture.waiters.delete(check);
      resolve(true);
    };
    const timer = setTimeout(() => { fixture.waiters.delete(check); resolve(false); }, limitMs);
    fixture.waiters.add(check);
  });
}

/** Per-fixture HTTP entry: tracks server-side work and refuses a disposed fixture. */
function serveFixture(fixture, req, res) {
  if (fixture.state !== 'live' && fixture.state !== 'building') {
    res.statusCode = 503;
    res.end(`C2 fixture #${fixture.id} is ${fixture.state}`);
    return;
  }
  const work = { ended: false, closed: false };
  fixture.responses.add(work);
  const settle = () => {
    if (!work.ended || !work.closed || !fixture.responses.has(work)) return;
    // Let code that runs right after res.end() finish before reporting idle.
    setImmediate(() => { fixture.responses.delete(work); notifyFixture(fixture); });
  };
  const end = res.end;
  res.end = function c2TrackedEnd(...args) {
    work.ended = true;
    const result = end.apply(this, args);
    settle();
    return result;
  };
  res.once('close', () => { work.closed = true; settle(); });
  fixture.app(req, res);
}

/** Closes server, connection and temp dir in order; every step runs; failures are reported together. */
async function closeFixture(fixture) {
  const errors = [];
  const step = async (label, action) => {
    try { await action(); } catch (error) { errors.push(new Error(`C2 teardown of fixture #${fixture.id}: ${label}: ${error.message}`, { cause: error })); }
  };
  await step('SQL trace still attached', () => {
    const sink = tracing.sinks.get(fixture.db);
    if (sink) { detachTrace(fixture.db, sink); throw new Error('a measurement trace outlived its request'); }
  });
  await step('server close', () => new Promise((resolve, reject) => {
    if (!fixture.server?.listening) { resolve(); return; }
    fixture.server.closeAllConnections();
    fixture.server.close((error) => (error ? reject(error) : resolve()));
  }));
  await step('database close', () => { if (fixture.db?.open) closeDatabase(fixture.db); });
  await step('temp dir removal', () => { if (fixture.tmpDir) fs.rmSync(fixture.tmpDir, { recursive: true, force: true }); });
  fixture.state = 'closed';
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `C2 teardown of fixture #${fixture.id} failed in ${errors.length} steps`);
}

/** Keeps a fixture whose server work never settled: connection stays open until that work ends. */
function quarantineFixture(fixture) {
  fixture.state = 'quarantined';
  quarantined.add(fixture);
  fixture.reaped = new Promise((resolve) => {
    const reap = () => {
      if (!fixtureIdle(fixture)) return;
      fixture.waiters.delete(reap);
      closeFixture(fixture).then(
        () => { quarantined.delete(fixture); resolve(); },
        (error) => { fixture.reapError = error; resolve(); },
      );
    };
    fixture.waiters.add(reap);
    reap();
  });
}

async function disposeFixture(fixture) {
  fixture.state = 'disposing';
  if (await drainFixture(fixture, C2_DRAIN_LIMIT_MS)) {
    await closeFixture(fixture);
    return;
  }
  // Drain deadline expired: cancel and stop tracing, but never close SQLite
  // while server-side work for this fixture may still use it.
  fixture.expired = true;
  const pending = `${fixture.requests.size} client request(s), ${fixture.responses.size} server response(s)`;
  for (const [database, sink] of tracing.sinks) if (database === fixture.db) detachTrace(database, sink);
  for (const request of fixture.requests) request.abort?.();
  fixture.server.closeAllConnections();
  fixture.server.close(() => {});
  if (await drainFixture(fixture, C2_CANCEL_GRACE_MS)) {
    // Built before cleanup so a cleanup failure cannot mask the expiry.
    const expiry = new Error(`C2 drain deadline (${C2_DRAIN_LIMIT_MS} ms) expired with ${pending} outstanding; cancelled, and closed only after the server work settled`);
    try {
      await closeFixture(fixture);
    } catch (cleanup) {
      throw new AggregateError([expiry, cleanup], `C2 fixture #${fixture.id}: ${expiry.message}; cleanup then failed: ${cleanup.message}`);
    }
    throw expiry;
  }
  quarantineFixture(fixture);
  throw new Error(`C2 drain deadline (${C2_DRAIN_LIMIT_MS} ms) expired with ${pending} outstanding; server work did not settle after cancellation, so fixture #${fixture.id} is quarantined with its connection open (${fixture.tmpDir})`);
}

// ─── Harness ─────────────────────────────────────────────────────────────

describe('Manage Assets C2: HTTP SQL pagination, filters, membership and read-only coverage', () => {
  // Bindings for the test bodies. `db` and `agent` are owner-checked proxies
  // of the live fixture (see the ownership section above).
  let dbPath;
  let db;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    const fixture = {
      id: ++fixtureSequence,
      state: 'building',
      requests: new Set(),
      responses: new Set(),
      waiters: new Set(),
      verboseLog: [],
      verboseOn: false,
      statementHook: null,
    };
    // Registered before anything can fail, so afterEach tears down a partial build.
    liveFixture = fixture;
    fixture.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-c2-'));
    const projectsRoot = path.join(fixture.tmpDir, 'projects');
    const appDataRoot = path.join(fixture.tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    fixture.dbPath = path.join(fixture.tmpDir, 'test.db');
    const raw = new Database(fixture.dbPath, {
      verbose: (sql) => { if (fixture.verboseOn) fixture.verboseLog.push(normalizeSql(sql)); },
    });
    fixture.db = raw;
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    registerSqlFunctions(raw);
    runMigrations(raw, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    fixture.app = createApp({ appName: 'CreatorCrate', db: raw, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    fixture.server = http.createServer((req, res) => serveFixture(fixture, req, res));
    await new Promise((resolve, reject) => {
      fixture.server.once('error', reject);
      fixture.server.listen(0, '127.0.0.1', resolve);
    });
    const session = await getDisabledModeCsrf(fixture.server, appDataRoot);
    fixture.state = 'live';
    dbPath = fixture.dbPath;
    db = ownedProxy(fixture, raw, 'db');
    agent = ownedProxy(fixture, session.agent, 'agent');
    csrfToken = session.csrfToken;
  });

  afterEach(async () => {
    const fixture = liveFixture;
    liveFixture = null;
    if (fixture) await disposeFixture(fixture);
  }, C2_AFTER_EACH_TIMEOUT_MS);

  afterAll(async () => {
    const problems = [];
    const unsettled = [...quarantined];
    await Promise.race([
      Promise.all(unsettled.map((fixture) => fixture.reaped)),
      new Promise((resolve) => { setTimeout(resolve, C2_DRAIN_LIMIT_MS).unref(); }),
    ]);
    for (const fixture of unsettled) {
      if (fixture.reapError) problems.push(`fixture #${fixture.id} reap failed: ${fixture.reapError.message}`);
      else if (quarantined.has(fixture)) problems.push(`fixture #${fixture.id} server work never settled; connection left open at ${fixture.tmpDir}`);
    }
    if (tracing.sinks.size > 0 || tracing.proto) problems.push(`SQL tracing still installed (${tracing.sinks.size} sink(s))`);
    if (problems.length) throw new Error(`C2 lifecycle: ${problems.join('; ')}`);
  }, C2_DRAIN_LIMIT_MS + 5000);

  // Record every statement execution on THIS fixture's connection for one request.
  async function measure(send) {
    const fixture = currentFixture('measure()');
    if (fixture.requests.size) throw new Error('C2 measure() calls must not overlap');
    const log = [];
    const sink = (statement, method, args, result) => {
      const rows = method === 'all' ? result : (method === 'get' && result !== undefined ? [result] : []);
      const entry = {
        sql: normalizeSql(statement.source),
        method,
        args: args.flat(),
        rows: Array.isArray(rows) ? rows.length : 0,
        metadataRows: Array.isArray(rows) ? rows.filter(isMetadataRow).length : 0,
        inTransaction: fixture.db.inTransaction,
      };
      entry.kind = classify(entry);
      log.push(entry);
      if (fixture.statementHook) fixture.statementHook(entry);
    };
    attachTrace(fixture.db, sink);
    fixture.verboseLog.length = 0;
    fixture.verboseOn = true;
    let request;
    let res;
    let failure = null;
    try {
      request = send();
      fixture.requests.add(request);
      res = await request;
    } catch (error) {
      failure = error;
    } finally {
      // Only this measurement's own sink and own fixture are touched here.
      detachTrace(fixture.db, sink);
      fixture.verboseOn = false;
      if (fixture.requests.delete(request)) notifyFixture(fixture);
    }
    // A body whose fixture was disposed meanwhile stops here, before it can
    // reach any shared binding with the result.
    if (fixture.state !== 'live' || fixtureOwner.getStore() !== fixture) {
      throw new StaleFixtureError(`C2 measure() settled after fixture #${fixture.id} became ${fixture.state}`, { cause: failure ?? undefined });
    }
    if (failure) throw failure;
    const of = (kind) => log.filter((entry) => entry.kind === kind);
    const counts = {};
    for (const entry of log) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return {
      res,
      log,
      of,
      counts,
      control: fixture.verboseLog.filter((sql) => /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)),
      metadataRows: log.reduce((sum, entry) => sum + entry.metadataRows, 0),
      maxMetadataRowsPerStatement: Math.max(0, ...log.map((entry) => entry.metadataRows)),
    };
  }

  const get = (url) => measure(() => agent.get(url));

  function postForm(url, entries, contentType = 'application/x-www-form-urlencoded') {
    const body = [['_csrf', csrfToken], ...entries]
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('&');
    return measure(() => agent.post(url).set('Content-Type', contentType).send(body));
  }

  // ─── Fixture builders ──────────────────────────────────────────────────

  function insertProject(title, { archivedAt = null } = {}) {
    return db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type, archived_at, updated_at)
      VALUES (?, ?, '', '', 'tbd', 'images', ?, datetime('now'))
      RETURNING id
    `).get(title, `c2-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2)}`, archivedAt).id;
  }

  function addCategory(projectId, displayName, displayOrder = 0) {
    return createAssetCategoryRepository(db).addProjectCategory({
      projectId, displayName, directorySlug: displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), displayOrder, enabled: true,
    }).id;
  }

  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain' };

  /**
   * Insert asset definitions directly; returns the definitions with their
   * assigned IDs. A definition is { filename, relativePath?, extension?,
   * categoryId?, present? }.
   */
  function insertAssets(projectId, definitions) {
    const insert = db.prepare(`
      INSERT INTO assets (project_id, category_id, relative_path, filename, extension, mime_type, size_bytes,
        is_present, last_seen_at, missing_since)
      VALUES (?, ?, ?, ?, ?, ?, 100, ?, '2025-01-01T00:00:00Z', ?)
      RETURNING id
    `);
    return db.transaction(() => definitions.map((definition) => {
      const extension = definition.extension ?? definition.filename.split('.').pop();
      const present = definition.present ?? true;
      const id = insert.get(
        projectId,
        definition.categoryId ?? null,
        definition.relativePath ?? definition.filename,
        definition.filename,
        extension,
        MIME[extension.toLowerCase()] ?? 'application/octet-stream',
        present ? 1 : 0,
        present ? null : '2025-02-01T00:00:00Z',
      ).id;
      return { ...definition, id, projectId, extension, present, categoryId: definition.categoryId ?? null };
    }))();
  }

  function createRelease(projectId, title = 'C2 Release') {
    return createReleaseService({ db }).createRelease(projectId, {
      title, description: '', notes: '', plannedDate: null, patreonUrl: null,
    }).id;
  }

  /** entries: [assetId, role, sortOrder][] — returns Map id → { role, order }. */
  function saveMembership(releaseId, entries) {
    const insert = db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
    db.transaction(() => { for (const [assetId, role, order] of entries) insert.run(releaseId, assetId, role, order); })();
    return new Map(entries.map(([assetId, role, order]) => [assetId, { role, order }]));
  }

  function membership(releaseId) {
    return db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order, asset_id')
      .all(releaseId).map((row) => [row.asset_id, row.role, row.sort_order]);
  }

  const savedIdsInStoredOrder = (saved) => [...saved.entries()]
    .sort(([idA, a], [idB, b]) => (a.order - b.order) || (idA - idB))
    .map(([id]) => id);

  const pad = (value, width) => String(value).padStart(width, '0');

  function sequentialAssets(projectId, count, prefix, extension = 'png') {
    const width = String(count - 1).length;
    return insertAssets(projectId, Array.from({ length: count }, (_, index) => ({
      filename: `${prefix}-${pad(index, Math.max(width, 2))}.${extension}`,
    })));
  }

  /** The editable page result asserted end to end against an oracle result. */
  function expectEditablePage(m, expected, { selection = 'all' } = {}) {
    expect(m.res.status).toBe(200);
    const page = parsePage(m.res.text);
    expect(page.ids).toEqual(expected.ids);
    expect(new Set(page.ids).size).toBe(page.ids.length);
    expect(page.total).toBe(expected.total);
    expect(page.totalKind).toBe(selection === 'all' ? 'project' : 'selected');
    if (expected.pageCount > 1 && expected.ids.length > 0) {
      expect([page.page, page.pageCount]).toEqual([expected.page, expected.pageCount]);
    } else {
      expect(page.page).toBeNull();
    }
    // SQL: the one filtered COUNT and the one page read agree with the oracle.
    const [count] = m.of('count');
    expect(m.of('count')).toHaveLength(1);
    const pageReads = [...m.of('page'), ...m.of('viewAllPage')];
    if (expected.total === 0) {
      expect(pageReads).toHaveLength(0);
    } else {
      expect(pageReads).toHaveLength(1);
      expect(pageReads[0].metadataRows).toBe(expected.ids.length);
    }
    return { page, count, pageRead: pageReads[0] };
  }

  // ═══ 5 / 6 / 7. Primary scale test ════════════════════════════════════

  describe('numeric pagination at 250 / 2,000 / 10,000 assets', () => {
    // asset-NNNNN.png, one saved member every 50 assets (index 0, 50, 100…).
    function buildScaleFixture(count, title = `Scale ${count}`) {
      const projectId = insertProject(title);
      const defs = insertAssets(projectId, Array.from({ length: count }, (_, index) => ({
        filename: `asset-${pad(index, 5)}.png`,
      })));
      const releaseId = createRelease(projectId, `${title} Release`);
      const saved = saveMembership(releaseId, defs
        .filter((_, index) => index % 50 === 0)
        .map((d, order) => [d.id, order === 0 ? 'primary' : 'attachment', order]));
      return { projectId, releaseId, defs, saved };
    }

    async function measuredScalePage(fixture) {
      return get(`/releases/${fixture.releaseId}/assets?selection=all&pageSize=25&page=3`);
    }

    function expectBoundedScalePage(fixture, m, count) {
      // Independently known page 3 of 25: fixture indices 50..74.
      const expectedIds = fixture.defs.slice(50, 75).map((d) => d.id);
      expect(oracle(fixture.defs, fixture.saved, { selection: 'all', pageSize: 25, page: 3 }).ids).toEqual(expectedIds);

      expect(m.res.status).toBe(200);
      const page = parsePage(m.res.text);
      expect(page.ids).toEqual(expectedIds);
      expect(page.total).toBe(count);
      expect([page.page, page.pageCount]).toEqual([3, count / 25]);
      expect(page.checkedIds).toEqual([fixture.defs[50].id]);
      expect(page.prev.query).toEqual({ selection: 'all', page: '2' });
      expect(page.next.query).toEqual({ selection: 'all', page: '4' });

      // Exactly one bounded page read: LIMIT 25 OFFSET 50, 25 metadata rows.
      expect(m.of('page')).toHaveLength(1);
      const [pageRead] = m.of('page');
      expect(pageRead.args.slice(-2)).toEqual([25, 50]);
      expect(pageRead.rows).toBe(25);
      expect(pageRead.metadataRows).toBe(25);
      expect(m.of('viewAllPage')).toHaveLength(0);

      // Exactly one filtered COUNT, returning the full total.
      expect(m.of('count')).toHaveLength(1);
      expect(m.of('count')[0].rows).toBe(1);
      expect(m.of('aggregates')).toHaveLength(1);

      // Complete lightweight membership (IDs only, no metadata) — scales with
      // the saved collection, not with full asset metadata.
      expect(m.of('membership')).toHaveLength(1);
      expect(m.of('membership')[0].rows).toBe(count / 50);
      expect(m.of('membership')[0].metadataRows).toBe(0);
      expect(page.persistedIds).toEqual(savedIdsInStoredOrder(fixture.saved));

      // No whole-project metadata read, no saved-collection read, no N+1.
      expect(m.metadataRows).toBe(25);
      expect(m.maxMetadataRowsPerStatement).toBe(25);
      expect(m.of('savedCollection')).toHaveLength(0);
      expect(m.of('perIdAssetRead')).toHaveLength(0);
      expect(m.of('membershipWrite')).toHaveLength(0);

      // No off-page asset metadata serialized into the response.
      expect(m.res.text).toContain('asset-00050.png');
      expect(m.res.text).toContain('asset-00074.png');
      expect(m.res.text).not.toContain('asset-00049.png');
      expect(m.res.text).not.toContain('asset-00075.png');
    }

    it.each([250, 2000, 10000])('GET selection=all&pageSize=25&page=3 on %i assets reads one bounded 25-row page', async (count) => {
      const fixture = buildScaleFixture(count);
      const m = await measuredScalePage(fixture);
      expectBoundedScalePage(fixture, m, count);
    }, SCALE_TEST_TIMEOUT_MS);

    it('statement shape by class is independent of project scale (self-contained 250 / 2,000 / 10,000 run)', async () => {
      const results = [];
      for (const count of [250, 2000, 10000]) {
        const fixture = buildScaleFixture(count, `Stable ${count}`);
        const m = await measuredScalePage(fixture);
        expectBoundedScalePage(fixture, m, count);
        results.push({ count, m });
      }
      const byClass = results.map(({ m }) => m.counts);
      // Every statement class executes the same number of times at every scale.
      expect(byClass[1]).toEqual(byClass[0]);
      expect(byClass[2]).toEqual(byClass[0]);
      // The only row counts that grow are the COUNT result value and the
      // lightweight membership (one saved member per 50 assets).
      const shape = ({ m }) => m.log
        .filter((entry) => entry.kind !== 'membership')
        .map((entry) => [entry.kind, entry.rows, entry.metadataRows]);
      expect(shape(results[1])).toEqual(shape(results[0]));
      expect(shape(results[2])).toEqual(shape(results[0]));
      expect(results.map(({ m }) => m.of('membership')[0].rows)).toEqual([5, 40, 200]);
      expect(results.map(({ m }) => m.metadataRows)).toEqual([25, 25, 25]);
      expect(results.map(({ m }) => m.log.length)).toEqual(Array(3).fill(results[0].m.log.length));
    }, SCALE_TEST_TIMEOUT_MS);
  });

  // ═══ 8. Page-size contract ════════════════════════════════════════════

  describe('page-size contract', () => {
    function buildSizeFixture() {
      const projectId = insertProject('Sizes');
      const defs = sequentialAssets(projectId, 437, 'size');
      const releaseId = createRelease(projectId);
      const saved = saveMembership(releaseId, [[defs[3].id, 'primary', 0], [defs[260].id, 'attachment', 1]]);
      return { projectId, releaseId, defs, saved };
    }

    it('each supported numeric size bounds the page with LIMIT and exact first/last IDs on page 2 and the last page', async () => {
      const fixture = buildSizeFixture();
      for (const size of [10, 25, 50, 100, 150, 200]) {
        const pageCount = Math.ceil(437 / size);
        for (const pageNumber of [2, pageCount]) {
          const m = await get(`/releases/${fixture.releaseId}/assets?selection=all&pageSize=${size}&page=${pageNumber}`);
          const expected = oracle(fixture.defs, fixture.saved, { selection: 'all', pageSize: size, page: pageNumber });
          // Literal independent check of the oracle (sequential fixture).
          const first = (pageNumber - 1) * size;
          const last = Math.min(pageNumber * size, 437) - 1;
          expect(expected.ids).toEqual(fixture.defs.slice(first, last + 1).map((d) => d.id));
          const { page, pageRead } = expectEditablePage(m, expected);
          expect(page.ids.length).toBeLessThanOrEqual(size);
          expect(page.ids[0]).toBe(fixture.defs[first].id);
          expect(page.ids.at(-1)).toBe(fixture.defs[last].id);
          expect(pageRead.kind).toBe('page');
          expect(pageRead.args.slice(-2)).toEqual([size, first]);
          expect(page.pageCount).toBe(pageCount);
          expect(m.metadataRows).toBe(page.ids.length);
          if (size !== 25) {
            const nav = page.prev ?? page.next;
            expect(nav.query.pageSize).toBe(String(size));
          }
        }
      }
    });

    it('defaults to 25 and normalizes unsupported, malformed and repeated sizes to 25 (never View All)', async () => {
      const fixture = buildSizeFixture();
      const expected = oracle(fixture.defs, fixture.saved, { selection: 'all', pageSize: 25, page: 1 });
      expect(expected.ids).toEqual(fixture.defs.slice(0, 25).map((d) => d.id));
      for (const query of ['', '&pageSize=7', '&pageSize=1000', '&pageSize=ALL', '&pageSize=25.0', '&pageSize=%2010',
        '&pageSize=-25', '&pageSize=', '&pageSize=10&pageSize=50', '&pageSize[]=50']) {
        const m = await get(`/releases/${fixture.releaseId}/assets?selection=all${query}`);
        const { page, pageRead } = expectEditablePage(m, expected);
        expect(page.pageCount, query).toBe(18);
        expect(pageRead.args.slice(-2), query).toEqual([25, 0]);
        // The default size stays implicit in navigation.
        expect(page.next.query, query).toEqual({ selection: 'all', page: '2' });
      }
    });

    it('View All uses the explicit unbounded read, keeps the total and renders no pagination', async () => {
      const fixture = buildSizeFixture();
      for (const [query, selection] of [['selection=all&pageSize=all', 'all'], ['pageSize=all', 'selected'], ['selection=all&pageSize=all&page=7', 'all']]) {
        const m = await get(`/releases/${fixture.releaseId}/assets?${query}`);
        const expected = oracle(fixture.defs, fixture.saved, { selection, pageSize: 'all' });
        const { page, pageRead } = expectEditablePage(m, expected, { selection });
        expect(pageRead.kind).toBe('viewAllPage');
        expect(m.of('page')).toHaveLength(0);
        expect(page.total).toBe(selection === 'all' ? 437 : 2);
        expect(page.ids).toHaveLength(selection === 'all' ? 437 : 2);
        expect(page.region).not.toContain('aria-label="Release asset pages"');
        expect(page.checkedIds.sort((a, b) => a - b)).toEqual([fixture.defs[3].id, fixture.defs[260].id]);
      }
    });
  });

  // ═══ 9. Page boundaries ═══════════════════════════════════════════════

  describe('page boundaries', () => {
    function buildBoundaryFixture() {
      const projectId = insertProject('Boundaries');
      const groups = [];
      for (const [label, count] of [['main', 437], ['g25', 25], ['g50', 50], ['g51', 51]]) {
        groups.push(...Array.from({ length: count }, (_, index) => ({ filename: `${label}-${pad(index, 3)}.png` })));
      }
      const defs = insertAssets(projectId, groups);
      const releaseId = createRelease(projectId);
      return { projectId, releaseId, defs, saved: new Map() };
    }

    it('first, middle, last, beyond-last, very large, invalid and repeated page numbers clamp to the documented page', async () => {
      const fixture = buildBoundaryFixture();
      const main = (q) => ({ selection: 'all', search: 'main-', pageSize: 25, ...q });
      const cases = [
        ['page=1', 1], ['page=9', 9], ['page=18', 18], ['page=19', 18], ['page=500', 18],
        ['page=99999999999999999999999', 18], ['page=0', 1], ['page=-3', 1], ['page=abc', 1],
        ['page=2.5', 1], ['page=', 1], ['page=%202', 1], ['page=02', 1], ['page=2&page=3', 1], ['page[]=4&page[]=5', 1],
      ];
      for (const [query, expectedPage] of cases) {
        const m = await get(`/releases/${fixture.releaseId}/assets?selection=all&search=main-&${query}`);
        const expected = oracle(fixture.defs, fixture.saved, main({ page: expectedPage }));
        expect(expected.page, query).toBe(expectedPage);
        const { page } = expectEditablePage(m, expected);
        expect(page.page, query).toBe(expectedPage);
        expect(page.pageCount, query).toBe(18);
        expect(page.ids.length, query).toBe(expectedPage === 18 ? 12 : 25);
        // Navigation: Previous only after page 1; Next only before the last.
        expect(page.prev === null, query).toBe(expectedPage === 1);
        expect(page.next === null, query).toBe(expectedPage === 18);
        if (page.prev) expect(page.prev.query, query).toEqual({ search: 'main-', selection: 'all', ...(expectedPage > 2 ? { page: String(expectedPage - 1) } : {}) });
        if (page.next) expect(page.next.query, query).toEqual({ search: 'main-', selection: 'all', page: String(expectedPage + 1) });
        const [pageRead] = m.of('page');
        expect(pageRead.args.slice(-2), query).toEqual([25, (expectedPage - 1) * 25]);
      }

      // Observation (not asserted as a contract): a single-element bracket
      // array `page[]=4` stringifies to '4' and is currently honoured as page
      // 4, whereas `pageSize[]=50` falls back to 25. Whatever page is chosen,
      // the response must be internally consistent and in range.
      const bracket = await get(`/releases/${fixture.releaseId}/assets?selection=all&search=main-&page[]=4`);
      const shown = parsePage(bracket.res.text);
      expect(shown.page).toBeGreaterThanOrEqual(1);
      expect(shown.page).toBeLessThanOrEqual(18);
      expectEditablePage(bracket, oracle(fixture.defs, fixture.saved, main({ page: shown.page })));
      expect(bracket.of('page')[0].args.slice(-2)).toEqual([25, (shown.page - 1) * 25]);
    });

    it('empty result, exactly one page, exact multiple and one row beyond a page boundary', async () => {
      const fixture = buildBoundaryFixture();
      const cases = [
        ['nothing-matches', 1, { total: 0, pageCount: 1, rows: 0 }],
        ['nothing-matches&page=5', 1, { total: 0, pageCount: 1, rows: 0 }],
        ['g25-', 1, { total: 25, pageCount: 1, rows: 25 }],
        ['g25-&page=2', 1, { total: 25, pageCount: 1, rows: 25 }],
        ['g50-&page=2', 2, { total: 50, pageCount: 2, rows: 25 }],
        ['g50-&page=3', 2, { total: 50, pageCount: 2, rows: 25 }],
        ['g51-&page=3', 3, { total: 51, pageCount: 3, rows: 1 }],
      ];
      for (const [query, expectedPage, shape] of cases) {
        const [search, pageQuery] = query.split('&');
        const requested = pageQuery ? Number(pageQuery.split('=')[1]) : 1;
        const m = await get(`/releases/${fixture.releaseId}/assets?selection=all&search=${search}${pageQuery ? `&${pageQuery}` : ''}`);
        const expected = oracle(fixture.defs, fixture.saved, { selection: 'all', search, pageSize: 25, page: requested });
        expect([expected.total, expected.pageCount, expected.page, expected.ids.length], query)
          .toEqual([shape.total, shape.pageCount, expectedPage, shape.rows]);
        const { page } = expectEditablePage(m, expected);
        if (shape.total === 0) {
          expect(page.region).toContain('No matching project assets');
          expect(m.of('page')).toHaveLength(0);
        }
        if (shape.pageCount === 1) expect(page.region).not.toContain('aria-label="Release asset pages"');
        if (search === 'g51-' && expectedPage === 3) {
          expect(page.ids).toEqual([fixture.defs.find((d) => d.filename === 'g51-050.png').id]);
        }
      }
    });
  });

  // ═══ 10. Deterministic ordering ═══════════════════════════════════════

  it('orders by case-insensitive filename then asset ID, stably across repeated paged requests', async () => {
    const projectId = insertProject('Ordering');
    // Inserted in a deliberately scrambled order: ties on filename (equal or
    // case-variant) must resolve by ascending asset ID, not insertion position.
    const names = [
      ['dup.png', 'z/dup.png'], ['B.png', 'B.png'], ['a.png', 'x/a.png'], ['Dup.png', 'Dup.png'], ['_under.png', '_under.png'],
      ['b.png', 'b.png'], ['10.png', '10.png'], ['A.png', 'A.png'], ['9.png', '9.png'], ['dup.png', 'a/dup.png'],
      ['Zeta.png', 'Zeta.png'], ['zeta.png', 'y/zeta.png'], ['a.png', 'w/a.png'], ['DUP.png', 'q/DUP.png'], ['c.png', 'c.png'],
      ['a-b.png', 'a-b.png'], ['a_b.png', 'a_b.png'], ['aB.png', 'aB.png'], ['ab.png', 'v/ab.png'], ['~tilde.png', '~tilde.png'],
      ['Ab.png', 'u/Ab.png'], ['dup.png', 'm/dup.png'],
    ];
    const defs = insertAssets(projectId, names.map(([filename, relativePath]) => ({ filename, relativePath })));
    const releaseId = createRelease(projectId);
    const expected = [...defs].sort(browserOrder).map((d) => d.id);
    // Literal spot checks of the oracle: ties resolve by insertion (ID) order.
    const idOf = (relativePath) => defs.find((d) => d.relativePath === relativePath).id;
    const expectedNames = [...defs].sort(browserOrder).map((d) => d.relativePath);
    // NOCASE folds A-Z only: '_' (0x5F) sorts before 'a' (0x61), '~' last.
    expect(expectedNames.slice(0, 4)).toEqual(['10.png', '9.png', '_under.png', 'a-b.png']);
    expect(expectedNames.filter((name) => /dup\.png$/i.test(name))).toEqual(['z/dup.png', 'Dup.png', 'a/dup.png', 'q/DUP.png', 'm/dup.png']);
    expect(expectedNames.indexOf('_under.png')).toBeLessThan(expectedNames.indexOf('x/a.png'));
    expect(expectedNames.indexOf('~tilde.png')).toBe(expectedNames.length - 1);
    expect(idOf('x/a.png')).toBeLessThan(idOf('w/a.png'));

    const collect = async () => {
      const seen = [];
      for (const pageNumber of [1, 2, 3]) {
        const m = await get(`/releases/${releaseId}/assets?selection=all&pageSize=10&page=${pageNumber}`);
        const page = parsePage(m.res.text);
        expect(m.of('page')[0].sql).toContain('ORDER BY a.filename COLLATE NOCASE ASC, a.id ASC LIMIT ? OFFSET ?');
        seen.push(page.ids);
      }
      return seen;
    };
    const first = await collect();
    const second = await collect();
    expect(second).toEqual(first);
    expect(first.flat()).toEqual(expected);
    expect(new Set(first.flat()).size).toBe(defs.length);
    expect(first.map((ids) => ids.length)).toEqual([10, 10, 2]);
  });

  // ═══ 11. Search ═══════════════════════════════════════════════════════

  it('Search is a trimmed literal case-insensitive filename substring with no wildcard interpretation or cross-project rows', async () => {
    const projectId = insertProject('Search');
    const defs = insertAssets(projectId, [
      { filename: 'plain-alpha.png' },
      { filename: '100%-off.png' },
      { filename: '100x-off.png' },
      { filename: 'under_score.png' },
      { filename: 'underXscore.png' },
      { filename: 'back\\slash.png' },
      { filename: 'backXslash.png' },
      { filename: 'MiXeD-CaSe.PNG', extension: 'PNG' },
      { filename: 'Ärger-café.png' },
      { filename: 'cafe-plain.png' },
      ...Array.from({ length: 25 }, (_, index) => ({ filename: `zz-late-${pad(index, 2)}.png` })),
    ]);
    const foreignProjectId = insertProject('Search Foreign');
    insertAssets(foreignProjectId, [{ filename: 'plain-alpha-foreign-secret.png' }, { filename: '100%-foreign-secret.png' }]);
    const releaseId = createRelease(projectId);
    const saved = new Map();
    const byName = (name) => defs.find((d) => d.filename === name).id;

    const cases = [
      [null, 1, defs.length],
      ['   ', 1, defs.length],
      ['  MIXED  ', 1, ['MiXeD-CaSe.PNG']],
      ['mixed-case', 1, ['MiXeD-CaSe.PNG']],
      ['%', 1, ['100%-off.png']],
      ['0%-', 1, ['100%-off.png']],
      ['_', 1, ['under_score.png']],
      ['r_s', 1, ['under_score.png']],
      ['\\s', 1, ['back\\slash.png']],
      ['ÄRGER-CAFÉ', 1, ['Ärger-café.png']],
      ['CAFÉ', 1, ['Ärger-café.png']],
      ['cafe', 1, ['cafe-plain.png']],
      ['plain-alpha', 1, ['plain-alpha.png']],
      ['no-such-asset', 1, []],
      ['zz-late-2', 1, ['zz-late-20.png', 'zz-late-21.png', 'zz-late-22.png', 'zz-late-23.png', 'zz-late-24.png']],
      ['LATE', 3, ['zz-late-20.png', 'zz-late-21.png', 'zz-late-22.png', 'zz-late-23.png', 'zz-late-24.png']],
    ];
    for (const [search, pageNumber, literal] of cases) {
      const query = `selection=all&pageSize=10&page=${pageNumber}${search === null ? '' : `&search=${encodeURIComponent(search)}`}`;
      const expected = oracle(defs, saved, { selection: 'all', search, pageSize: 10, page: pageNumber });
      if (Array.isArray(literal)) {
        expect(expected.ids, String(search)).toEqual(literal.map(byName));
      } else {
        expect(expected.total, String(search)).toBe(literal);
      }
      const m = await get(`/releases/${releaseId}/assets?${query}`);
      const { page, count } = expectEditablePage(m, expected);
      expect(m.res.text).not.toContain('foreign-secret');
      const trimmed = search === null ? '' : search.trim();
      if (trimmed !== '') {
        // The bound Search parameter is the trimmed, JavaScript-lowercased term.
        expect(count.args, String(search)).toContain(trimmed.toLowerCase());
        expect(count.sql).toContain('instr(cc_js_lower(a.filename), ?) > 0');
        expect(count.sql).not.toMatch(/\bLIKE\b/);
        // Navigation keeps the trimmed Search.
        const nav = page.next ?? page.prev;
        if (nav) expect(nav.query.search, String(search)).toBe(trimmed);
      }
    }
    // A later-page-only match moves to page 1 under Search.
    const unfiltered = oracle(defs, saved, { selection: 'all', pageSize: 10 });
    expect(unfiltered.all.findIndex((d) => d.filename === 'zz-late-20.png')).toBeGreaterThanOrEqual(20);
  });

  // ═══ 12. Extension ════════════════════════════════════════════════════

  it('Extension filter normalizes case and whitespace and combines with Search, Category and Selection', async () => {
    const projectId = insertProject('Extension');
    const catA = addCategory(projectId, 'Cat A', 0);
    const defs = insertAssets(projectId, [
      { filename: 'e-01.png' },
      { filename: 'e-02.PNG', extension: 'PNG' },
      { filename: 'e-03.jpg' },
      { filename: 'e-04.jpeg' },
      { filename: 'e-05.txt' },
      { filename: 'e-06.png', categoryId: catA },
      { filename: 'e-07.jpg', categoryId: catA },
      { filename: 'e-08.png', present: false },
      ...Array.from({ length: 25 }, (_, index) => ({ filename: `e-bulk-${pad(index, 2)}.png`, categoryId: catA })),
    ]);
    const releaseId = createRelease(projectId);
    const byName = (name) => defs.find((d) => d.filename === name).id;
    const saved = saveMembership(releaseId, [[byName('e-02.PNG'), 'primary', 0], [byName('e-03.jpg'), 'preview', 1], [byName('e-07.jpg'), 'attachment', 2]]);
    const bulk = Array.from({ length: 25 }, (_, index) => `e-bulk-${pad(index, 2)}.png`);

    const cases = [
      // [query, oracle query, literal expected filenames on the requested page or total]
      ['selection=all', { selection: 'all' }, { total: 32 }],
      ['selection=all&extension=png', { selection: 'all', extension: 'png' }, { total: 28 }],
      ['selection=all&extension=PNG', { selection: 'all', extension: 'png' }, { total: 28 }],
      ['selection=all&extension=%20%20PnG%20', { selection: 'all', extension: 'png' }, { total: 28 }],
      ['selection=all&extension=jpg', { selection: 'all', extension: 'jpg' }, { names: ['e-03.jpg', 'e-07.jpg'] }],
      ['selection=all&extension=jpeg', { selection: 'all', extension: 'jpeg' }, { names: ['e-04.jpeg'] }],
      // A leading dot is not stripped by the Manage Assets contract: '.png'
      // is a valid token that matches no stored extension.
      ['selection=all&extension=.png', { selection: 'all', extension: '.png' }, { names: [] }],
      ['selection=all&extension=webp', { selection: 'all', extension: 'webp' }, { names: [] }],
      // Tokens outside [a-z0-9._-] are unrestricted (no filter).
      ['selection=all&extension=p*g', { selection: 'all' }, { total: 32 }],
      ['selection=all&extension=png&extension=jpg', { selection: 'all' }, { total: 32 }],
      ['selection=all&extension=png&search=e-0', { selection: 'all', extension: 'png', search: 'e-0' }, { names: ['e-01.png', 'e-02.PNG', 'e-06.png'] }],
      [`selection=all&extension=jpg&category=${catA}`, { selection: 'all', extension: 'jpg', categoryId: catA }, { names: ['e-07.jpg'] }],
      ['extension=png', { selection: 'selected', extension: 'png' }, { names: ['e-02.PNG'] }],
      ['extension=jpg', { selection: 'selected', extension: 'jpg' }, { names: ['e-03.jpg', 'e-07.jpg'] }],
      [`selection=all&extension=png&category=${catA}&pageSize=10&page=2`, { selection: 'all', extension: 'png', categoryId: catA, pageSize: 10, page: 2 },
        { names: bulk.slice(9, 19), total: 26 }],
    ];
    for (const [query, q, literal] of cases) {
      const expected = oracle(defs, saved, { pageSize: 25, ...q });
      if (literal.names) expect(expected.ids, query).toEqual(literal.names.map(byName));
      if (literal.total !== undefined) expect(expected.total, query).toBe(literal.total);
      const m = await get(`/releases/${releaseId}/assets?${query}`);
      const { page, count, pageRead } = expectEditablePage(m, expected, { selection: q.selection });
      // The COUNT and page read bind the same normalized extension.
      if (q.extension) {
        expect(count.args, query).toContain(q.extension);
        expect(count.sql).toContain('cc_js_lower(a.extension) = ?');
        if (pageRead) expect(pageRead.args.slice(0, count.args.length), query).toEqual(count.args);
      } else {
        expect(count.sql, query).not.toContain('a.extension');
      }
      expect(page.ids).not.toContain(byName('e-08.png'));
    }

    // Navigation under combined Category + Extension + Selection + size.
    const m = await get(`/releases/${releaseId}/assets?selection=all&extension=PNG&category=${catA}&pageSize=10&page=2`);
    const page = parsePage(m.res.text);
    expect([page.page, page.pageCount]).toEqual([2, 3]);
    expect(page.prev.query).toEqual({ extension: 'png', category: String(catA), selection: 'all', pageSize: '10' });
    expect(page.next.query).toEqual({ extension: 'png', category: String(catA), selection: 'all', page: '3', pageSize: '10' });
  });

  // ═══ 13. Category ═════════════════════════════════════════════════════

  it('Category filter: project categories, combinations, 422 syntax, 404 unknown/foreign without foreign metadata', async () => {
    const projectId = insertProject('Category');
    const catA = addCategory(projectId, 'Cat A', 0);
    const catB = addCategory(projectId, 'Cat B', 1);
    const foreignProjectId = insertProject('Category Foreign');
    const foreignCat = addCategory(foreignProjectId, 'Foreign Cat', 0);
    insertAssets(foreignProjectId, [{ filename: 'foreign-secret-cat.png', categoryId: foreignCat }]);
    const defs = insertAssets(projectId, [
      ...Array.from({ length: 14 }, (_, i) => ({ filename: `cat-a-${pad(i, 2)}.${i % 2 ? 'jpg' : 'png'}`, categoryId: catA })),
      ...Array.from({ length: 6 }, (_, i) => ({ filename: `cat-b-${pad(i, 2)}.png`, categoryId: catB })),
      { filename: 'cat-a-missing-saved.png', categoryId: catA, present: false },
      { filename: 'cat-b-missing-unsaved.png', categoryId: catB, present: false },
      ...Array.from({ length: 4 }, (_, i) => ({ filename: `uncat-${pad(i, 2)}.png` })),
    ]);
    const byName = (name) => defs.find((d) => d.filename === name).id;
    const releaseId = createRelease(projectId);
    const saved = saveMembership(releaseId, [
      [byName('cat-a-03.jpg'), 'primary', 0], [byName('cat-b-02.png'), 'preview', 1],
      [byName('cat-a-missing-saved.png'), 'attachment', 2], [byName('uncat-01.png'), 'attachment', 3],
      [byName('cat-a-10.png'), 'attachment', 4],
    ]);

    const cases = [
      [`selection=all&category=${catA}`, { selection: 'all', categoryId: catA }, 15],
      [`selection=all&category=${catB}`, { selection: 'all', categoryId: catB }, 7],
      [`selection=all&category=${catA}&search=a-1`, { selection: 'all', categoryId: catA, search: 'a-1' }, 5],
      [`selection=all&category=${catA}&extension=jpg`, { selection: 'all', categoryId: catA, extension: 'jpg' }, 8],
      [`category=${catA}`, { selection: 'selected', categoryId: catA }, 3],
      [`category=${catB}`, { selection: 'selected', categoryId: catB }, 2],
      [`categoryId=${catB}&selection=all`, { selection: 'all', categoryId: catB }, 7],
      [`selection=all&category=%20${catA}%20`, { selection: 'all', categoryId: catA }, 15],
      [`selection=all&category=${catA}&pageSize=10&page=2`, { selection: 'all', categoryId: catA, pageSize: 10, page: 2 }, 15],
    ];
    for (const [query, q, total] of cases) {
      const expected = oracle(defs, saved, { pageSize: 25, ...q });
      expect(expected.total, query).toBe(total);
      const m = await get(`/releases/${releaseId}/assets?${query}`);
      const { page, count } = expectEditablePage(m, expected, { selection: q.selection });
      expect(count.args, query).toContain(q.categoryId);
      expect(count.sql).toContain('a.category_id = ?');
      // The saved missing member is retained by every Category filter.
      if (q.selection === 'selected' || q.categoryId === catA) {
        expect(expected.all.map((d) => d.id), query).toContain(byName('cat-a-missing-saved.png'));
      }
      expect(page.ids).not.toContain(byName('cat-b-missing-unsaved.png'));
      expect(m.res.text).not.toContain('foreign-secret');
      // Aggregates are whole-project, not filtered or page-local.
      expect(m.res.text).toContain('All categories (26)');
      expect(m.res.text).toContain('Cat A (15)');
      expect(m.res.text).toContain('Cat B (7)');
    }
    // The saved missing member stays in a Category B filter (exception).
    const catBAll = oracle(defs, saved, { selection: 'all', categoryId: catB });
    expect(catBAll.ids).toContain(byName('cat-a-missing-saved.png'));

    for (const [value, status] of [['abc', 422], ['0', 422], ['-1', 422], ['1.5', 422], [`${catA}&category=${catB}`, 422],
      ['999999', 404], [String(foreignCat), 404]]) {
      const m = await get(`/releases/${releaseId}/assets?selection=all&category=${value}`);
      expect(m.res.status, value).toBe(status);
      expect(m.res.text).not.toContain('foreign-secret');
      expect(m.res.text).not.toContain('Foreign Cat');
      expect(m.of('page'), value).toHaveLength(0);
      expect(m.of('count'), value).toHaveLength(0);
      expect(m.metadataRows, value).toBe(0);
      expect(db.inTransaction).toBe(false);
    }
  });

  // ═══ 14 / 15. Selected versus All, missing-asset rules ═════════════════

  it('Selected and All agree with the oracle across Search, Extension and Category, with missing-member rules', async () => {
    const projectId = insertProject('Selection');
    const catA = addCategory(projectId, 'Sel A', 0);
    const defs = insertAssets(projectId, Array.from({ length: 60 }, (_, i) => ({
      filename: `m-${pad(i, 2)}.${i % 3 === 0 ? 'jpg' : 'png'}`,
      categoryId: i < 20 ? catA : null,
      present: !(i === 27 || i === 30),
    })));
    const at = (index) => defs[index].id;
    const releaseId = createRelease(projectId);
    const savedIndices = [58, 2, 5, 9, 14, 18, 22, 27, 33, 37, 41, 46, 50, 55];
    const saved = saveMembership(releaseId, savedIndices.map((index, order) => [
      at(index), order === 0 ? 'primary' : order === 1 ? 'preview' : 'attachment', order,
    ]));

    // Literal checks of the documented rules.
    expect(oracle(defs, saved, { selection: 'selected', pageSize: 'all' }).ids)
      .toEqual([2, 5, 9, 14, 18, 22, 27, 33, 37, 41, 46, 50, 55, 58].map(at));
    expect(oracle(defs, saved, { selection: 'all', pageSize: 'all' }).total).toBe(59);
    expect(oracle(defs, saved, { selection: 'all', pageSize: 'all' }).candidateTotal).toBe(45);
    expect(oracle(defs, saved, { selection: 'selected', search: 'm-1', pageSize: 'all' }).ids).toEqual([14, 18, 27].map(at));
    expect(oracle(defs, saved, { selection: 'all', search: 'm-1', pageSize: 'all' }).total).toBe(11);
    expect(oracle(defs, saved, { selection: 'all', search: 'm-3', pageSize: 'all' }).ids)
      .toEqual([27, 31, 32, 33, 34, 35, 36, 37, 38, 39].map(at));

    const service = createReleaseService({ db });
    const searches = [null, 'm-1', 'm-3', 'M-5'];
    const extensions = [null, 'png', 'jpg'];
    const categories = [null, catA];
    for (const selection of ['selected', 'all', undefined]) {
      for (const search of searches) {
        for (const extension of extensions) {
          for (const categoryId of categories) {
            for (const pageNumber of [1, 2]) {
              const params = new URLSearchParams();
              if (selection) params.set('selection', selection);
              if (search) params.set('search', search);
              if (extension) params.set('extension', extension);
              if (categoryId) params.set('category', String(categoryId));
              params.set('pageSize', '10');
              params.set('page', String(pageNumber));
              const query = params.toString();
              const effective = selection === 'all' ? 'all' : 'selected';
              const expected = oracle(defs, saved, { selection: effective, search, extension, categoryId, pageSize: 10, page: pageNumber });
              const m = await get(`/releases/${releaseId}/assets?${query}`);
              const { page } = expectEditablePage(m, expected, { selection: effective });
              // Selected indicators are exactly the saved members on the page.
              expect(page.checkedIds, query).toEqual(page.ids.filter((id) => saved.has(id)));
              // Missing indicators: only saved missing members are ever shown.
              expect(page.missingIds, query).toEqual(page.ids.includes(at(27)) ? [at(27)] : []);
              expect(page.ids, query).not.toContain(at(30));
              // Complete saved authority regardless of page and filters.
              expect(page.persistedIds, query).toEqual(savedIdsInStoredOrder(saved));
              expect([...page.hiddenIds, ...page.ids.filter((id) => saved.has(id))].sort((a, b) => a - b), query)
                .toEqual([...saved.keys()].sort((a, b) => a - b));
              // Candidate totals (view model) match the oracle.
              const vm = service.getReleaseAssetManagementPage(releaseId, Object.fromEntries(params));
              expect([vm.assetTotal, vm.candidateTotal, vm.assetPageNumber, vm.assetPageCount], query)
                .toEqual([expected.total, expected.candidateTotal, expected.page, expected.pageCount]);
            }
          }
        }
      }
    }
  }, 120000);

  // ═══ 16. Membership completeness ══════════════════════════════════════

  it('a numeric page keeps complete saved membership, role and order by ID, and off-page carriers on every page', async () => {
    const projectId = insertProject('Membership');
    const defs = sequentialAssets(projectId, 90, 'c');
    db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(defs[27].id);
    defs[27].present = false;
    const at = (index) => defs[index].id;
    const releaseId = createRelease(projectId);
    const saved = saveMembership(releaseId, [
      [at(12), 'primary', 0], [at(27), 'attachment', 1], [at(25), 'preview', 2],
      [at(61), 'attachment', 3], [at(3), 'attachment', 4], [at(88), 'attachment', 5],
    ]);
    const stored = [12, 27, 25, 61, 3, 88].map(at);
    expect(savedIdsInStoredOrder(saved)).toEqual(stored);

    const m = await get(`/releases/${releaseId}/assets?selection=all&pageSize=10&page=3&view=list`);
    const expected = oracle(defs, saved, { selection: 'all', pageSize: 10, page: 3 });
    expect(expected.ids).toEqual(Array.from({ length: 10 }, (_, i) => at(20 + i)));
    const { page } = expectEditablePage(m, expected);
    expect(page.checkedIds).toEqual([at(25), at(27)]);
    expect(page.missingIds).toEqual([at(27)]);
    expect(page.persistedIds).toEqual(stored);
    expect(page.hiddenIds).toEqual([12, 61, 3, 88].map(at));
    const facts = Object.fromEntries(page.items.map((item) => [item.id, cardFacts(item)]));
    expect(facts[at(25)]).toEqual({ role: 'Preview', order: '2' });
    expect(facts[at(27)]).toEqual({ role: 'Attachment', order: '1' });
    // An unsaved candidate carries no stored role/order of its own.
    expect(facts[at(26)]).toEqual({ role: null, order: null });
    expect(m.of('membership')).toHaveLength(1);
    expect(m.of('membership')[0].rows).toBe(6);
    expect(m.of('membership')[0].metadataRows).toBe(0);
    expect(m.metadataRows).toBe(10);
    expect(m.res.text).not.toContain('c-12.png');
    expect(m.res.text).not.toContain('c-88.png');

    // Every page: the same complete membership; visible ∪ hidden = saved.
    for (let pageNumber = 1; pageNumber <= 9; pageNumber += 1) {
      const each = await get(`/releases/${releaseId}/assets?selection=all&pageSize=10&page=${pageNumber}`);
      const p = parsePage(each.res.text);
      expect(p.persistedIds, `page ${pageNumber}`).toEqual(stored);
      const visibleSaved = p.ids.filter((id) => saved.has(id));
      expect(p.hiddenIds, `page ${pageNumber}`).toEqual(stored.filter((id) => !visibleSaved.includes(id)));
      expect(new Set([...p.hiddenIds, ...visibleSaved]).size).toBe(6);
    }

    // Selected mode: the saved collection in filename order, with Search.
    const selected = await get(`/releases/${releaseId}/assets?pageSize=10`);
    expectEditablePage(selected, oracle(defs, saved, { pageSize: 10 }), { selection: 'selected' });
    expect(parsePage(selected.res.text).ids).toEqual([3, 12, 25, 27, 61, 88].map(at));
    const searched = await get(`/releases/${releaseId}/assets?pageSize=10&search=c-2`);
    expect(parsePage(searched.res.text).ids).toEqual([25, 27].map(at));
    const searchedFar = await get(`/releases/${releaseId}/assets?pageSize=10&search=c-8`);
    // The missing saved member stays even when Search excludes its filename.
    expect(parsePage(searchedFar.res.text).ids).toEqual([27, 88].map(at));
    expect(membership(releaseId)).toEqual(stored.map((id) => [id, saved.get(id).role, saved.get(id).order]));
  });

  // ═══ 23. Aggregates ═══════════════════════════════════════════════════

  it('aggregates are whole-project, one grouped statement, and not replaced by page-local or filtered counts', async () => {
    const projectId = insertProject('Aggregates');
    const catA = addCategory(projectId, 'Agg A', 0);
    const catB = addCategory(projectId, 'Agg B', 1);
    const catEmpty = addCategory(projectId, 'Agg Empty', 2);
    const defs = insertAssets(projectId, [
      ...Array.from({ length: 12 }, (_, i) => ({ filename: `agg-a-${pad(i, 2)}.png`, categoryId: catA })),
      { filename: 'agg-a-missing-saved.png', categoryId: catA, present: false },
      { filename: 'agg-a-missing-unsaved.png', categoryId: catA, present: false },
      ...Array.from({ length: 7 }, (_, i) => ({ filename: `agg-b-${pad(i, 2)}.jpg`, categoryId: catB })),
      ...Array.from({ length: 5 }, (_, i) => ({ filename: `agg-u-${pad(i, 2)}.txt` })),
    ]);
    const byName = (name) => defs.find((d) => d.filename === name).id;
    const releaseId = createRelease(projectId);
    const saved = saveMembership(releaseId, [
      [byName('agg-a-02.png'), 'primary', 0], [byName('agg-a-missing-saved.png'), 'attachment', 1],
      [byName('agg-b-04.jpg'), 'preview', 2],
    ]);
    // Independent expectations from the definition.
    const total = defs.length; // 26
    const present = defs.filter((d) => d.present).length; // 24
    const presentCandidates = defs.filter((d) => d.present && !saved.has(d.id)).length; // 22
    expect([total, present, presentCandidates]).toEqual([26, 24, 22]);

    const service = createReleaseService({ db });
    for (const query of ['', 'selection=all&pageSize=10&page=2', `selection=all&category=${catB}&search=b-0&extension=jpg`, 'search=nothing']) {
      const vm = service.getReleaseAssetManagementPage(releaseId, Object.fromEntries(new URLSearchParams(query)));
      expect(vm.categoryNavigation, query).toEqual({ totalCount: 26, uncategorizedCount: 5, byCategoryId: { [catA]: 14, [catB]: 7 } });
      expect([vm.eligibleAssetCount, vm.eligibleCandidateCount], query).toEqual([24, 22]);
      const m = await get(`/releases/${releaseId}/assets?${query}`);
      expect(m.res.status).toBe(200);
      expect(m.of('aggregates'), query).toHaveLength(1);
      expect(m.of('aggregates')[0].rows, query).toBe(3);
      expect(m.of('aggregates')[0].metadataRows).toBe(0);
      expect(m.res.text, query).toContain('All categories (26)');
      expect(m.res.text, query).toContain('Agg A (14)');
      expect(m.res.text, query).toContain('Agg B (7)');
      expect(m.res.text, query).toContain('Agg Empty (0)');
    }
    // Filtered page count differs from the aggregates (not page-local).
    const filtered = await get(`/releases/${releaseId}/assets?selection=all&category=${catA}&pageSize=10&page=2`);
    const expected = oracle(defs, saved, { selection: 'all', categoryId: catA, pageSize: 10, page: 2 });
    expect([expected.total, expected.pageCount, expected.ids.length]).toEqual([13, 2, 3]);
    expectEditablePage(filtered, expected);
    expect(filtered.res.text).toContain('Agg A (14)');
    void catEmpty;

    // No eligible new candidates: every present asset saved.
    const fullRelease = createRelease(projectId, 'All saved');
    const allPresent = defs.filter((d) => d.present);
    const fullSaved = saveMembership(fullRelease, allPresent.map((d, order) => [d.id, 'attachment', order]));
    const vm = service.getReleaseAssetManagementPage(fullRelease, { selection: 'all', pageSize: 'all' });
    expect([vm.eligibleAssetCount, vm.eligibleCandidateCount, vm.candidateTotal, vm.assetTotal]).toEqual([24, 0, 0, 24]);
    const all = await get(`/releases/${fullRelease}/assets?selection=all&pageSize=all`);
    const fullExpected = oracle(defs, fullSaved, { selection: 'all', pageSize: 'all' });
    expect(fullExpected.candidateTotal).toBe(0);
    const { page } = expectEditablePage(all, fullExpected);
    expect(page.checkedIds).toEqual(page.ids);
    expect(page.ids).not.toContain(byName('agg-a-missing-unsaved.png'));
  });

  // ═══ 17 / 18. Read-only GET at scale ══════════════════════════════════

  const READ_ONLY_STATES = [
    ['published release', ({ releaseId }) => db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(releaseId),
      ({ releaseId }) => db.prepare('UPDATE releases SET published_date = NULL WHERE id = ?').run(releaseId),
      'This release is published. Asset selections are locked and read-only.'],
    ['archived release', ({ releaseId }) => db.prepare("UPDATE releases SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(releaseId),
      ({ releaseId }) => db.prepare('UPDATE releases SET archived_at = NULL WHERE id = ?').run(releaseId),
      'This release is archived. Asset selections are read-only.'],
    ['archived parent project', ({ projectId }) => db.prepare("UPDATE projects SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(projectId),
      ({ projectId }) => db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(projectId),
      'The parent project is archived. Asset selections are read-only.'],
  ];

  /** count project assets; `savedCount` saved members in reverse-filename stored order. */
  function buildReadOnlyFixture(count, savedCount, title = 'Read-only') {
    const projectId = insertProject(title);
    const defs = insertAssets(projectId, Array.from({ length: count }, (_, index) => ({
      filename: `ro-${pad(index, 5)}.png`,
    })));
    const releaseId = createRelease(projectId, `${title} Release`);
    const step = Math.floor(count / savedCount);
    const savedDefs = Array.from({ length: savedCount }, (_, index) => defs[index * step + 1]).reverse();
    const roleOf = (order) => (order === 0 ? 'primary' : order === 1 ? 'preview' : 'attachment');
    const saved = saveMembership(releaseId, savedDefs.map((d, order) => [d.id, roleOf(order), order]));
    const missing = savedDefs[5];
    db.prepare("UPDATE assets SET is_present = 0, missing_since = '2025-02-01T00:00:00Z' WHERE id IN (?, ?)").run(missing.id, defs[0].id);
    return { projectId, releaseId, defs, savedDefs, saved, missing, unsavedMissing: defs[0] };
  }

  function expectReadOnlyDisplay(m, fixture, notice) {
    const page = parsePage(m.res.text);
    const savedIds = fixture.savedDefs.map((d) => d.id);
    expect(page.ids).toEqual(savedIds);
    expect(page.missingIds).toEqual([fixture.missing.id]);
    expect(page.ids).not.toContain(fixture.unsavedMissing.id);
    const roles = page.items.map((item) => cardFacts(item).role);
    const orders = page.items.map((item) => cardFacts(item).order);
    expect(roles.slice(0, 3)).toEqual(['Primary', 'Preview', 'Attachment']);
    expect(roles.filter((role) => role !== 'Attachment')).toEqual(['Primary', 'Preview']);
    expect(orders).toEqual(savedIds.map((_, index) => String(index)));
    expect(m.res.text).toContain(notice);
    expect(page.hasSaveForm).toBe(false);
    expect(page.selectableIds).toEqual([]);
    expect(page.region).not.toContain('release-asset-role-form');
    expect(page.region).not.toContain('aria-label="Release asset pages"');
    expect(page.region).not.toContain('data-release-assets-live-page-size-form');
    expect(page.total).toBeNull();
    // SQL: no editable page/COUNT, one saved-collection read bounded by
    // membership, no whole-project metadata.
    expect(m.of('page')).toHaveLength(0);
    expect(m.of('viewAllPage')).toHaveLength(0);
    expect(m.of('count')).toHaveLength(0);
    expect(m.of('savedCollection')).toHaveLength(1);
    expect(m.of('savedCollection')[0].metadataRows).toBe(savedIds.length);
    expect(m.metadataRows).toBe(savedIds.length);
    expect(Math.max(...m.log.map((entry) => entry.rows))).toBeLessThanOrEqual(savedIds.length);
    expect(m.of('membershipWrite')).toHaveLength(0);
    expect(m.of('recovery')).toHaveLength(0);
  }

  it('read-only GET on 10,000 assets with 60 saved members loads only saved metadata in every read-only state', async () => {
    const fixture = buildReadOnlyFixture(10000, 60);
    const before = membership(fixture.releaseId);
    // Editable control on the same fixture: bounded page, no saved collection.
    const editable = await get(`/releases/${fixture.releaseId}/assets?selection=all&view=list`);
    expect(editable.of('page')).toHaveLength(1);
    expect(editable.of('savedCollection')).toHaveLength(0);
    expect(editable.metadataRows).toBe(25);
    for (const [label, apply, revert, notice] of READ_ONLY_STATES) {
      apply(fixture);
      for (const query of ['view=list', 'selection=all&pageSize=all&view=list', 'selection=all&pageSize=10&page=40&view=list',
        `search=ro-0&extension=png&pageSize=200&view=list`]) {
        const m = await get(`/releases/${fixture.releaseId}/assets?${query}`);
        expect(m.res.status, `${label} ${query}`).toBe(200);
        expectReadOnlyDisplay(m, fixture, notice);
      }
      revert(fixture);
    }
    expect(membership(fixture.releaseId)).toEqual(before);
  }, SCALE_TEST_TIMEOUT_MS);

  it('read-only grid view renders the same complete saved collection with role indicators (larger saved set)', async () => {
    const fixture = buildReadOnlyFixture(2000, 240, 'Read-only grid');
    READ_ONLY_STATES[0][1](fixture);
    const m = await get(`/releases/${fixture.releaseId}/assets?selection=all&pageSize=25&page=3`);
    const page = parsePage(m.res.text);
    expect(page.ids).toEqual(fixture.savedDefs.map((d) => d.id));
    const roles = [...page.region.matchAll(/<span class="release-asset-grid-role-value">([A-Za-z]+)<\/span>/g)].map((x) => x[1]);
    expect(roles).toHaveLength(240);
    expect(roles.slice(0, 2)).toEqual(['Primary', 'Preview']);
    expect(m.of('count')).toHaveLength(0);
    expect(m.of('page')).toHaveLength(0);
    expect(m.metadataRows).toBe(240);
  });

  // ═══ 19. Read-only malformed POST (B-F4) ══════════════════════════════

  it.each(READ_ONLY_STATES.map(([label, apply, , notice]) => [label, apply, notice]))(
    'read-only (%s) malformed Save: 422, persisted collection, no carrier, no foreign metadata, zero writes',
    async (_label, apply, notice) => {
      const fixture = buildReadOnlyFixture(400, 12, 'Read-only POST');
      const foreignProjectId = insertProject('RO Foreign');
      const [foreign] = insertAssets(foreignProjectId, [{ filename: 'foreign-secret-ro.png' }]);
      apply(fixture);
      const before = membership(fixture.releaseId);
      const url = `/releases/${fixture.releaseId}/assets?selection=all&pageSize=10&page=2&view=list`;
      for (const entries of [
        [['selectedAssetIds', 'abc'], ['selectedAssetIds', String(foreign.id)]],
        [['selectedAssetIds', String(foreign.id)], ['roleOrder', 'not json']],
        [['selectedAssetIds[__proto__]', String(fixture.defs[3].id)]],
      ]) {
        const m = await postForm(url, entries);
        expect(m.res.status).toBe(422);
        expect(m.res.text).toContain('role="alert"');
        expectReadOnlyDisplay(m, fixture, notice);
        expect(m.res.text).not.toContain('name="roleOrder"');
        expect(m.res.text).not.toContain('data-release-assets-submitted-role-order');
        expect(m.res.text).not.toContain('foreign-secret');
        expect(m.of('validation')).toHaveLength(0);
        expect(m.of('perIdAssetRead')).toHaveLength(0);
        expect(membership(fixture.releaseId)).toEqual(before);
      }
      // Unsupported media type boundary control: refused before the draft.
      // CSRF travels in the header here, since a text/plain body is not parsed.
      const refused = await measure(() => agent.post(url)
        .set('Content-Type', 'text/plain')
        .set('X-CSRF-Token', csrfToken)
        .send(`selectedAssetIds=${fixture.defs[3].id}`));
      expect(refused.res.status).toBe(415);
      expect(refused.of('membershipWrite')).toHaveLength(0);
      expect(refused.of('validation')).toHaveLength(0);
      expect(refused.metadataRows).toBe(0);
      expect(membership(fixture.releaseId)).toEqual(before);
      expect(db.inTransaction).toBe(false);
    },
  );

  // ═══ 20. Snapshot consistency ═════════════════════════════════════════

  describe('read snapshot', () => {
    function buildSnapshotFixture() {
      const projectId = insertProject('Snapshot');
      const catA = addCategory(projectId, 'Snap A', 0);
      const catB = addCategory(projectId, 'Snap B', 1);
      const defs = insertAssets(projectId, Array.from({ length: 30 }, (_, i) => ({
        filename: `s-${pad(i, 2)}.png`, categoryId: i < 10 ? catA : null,
      })));
      const at = (index) => defs[index].id;
      const releaseId = createRelease(projectId);
      saveMembership(releaseId, [[at(1), 'primary', 0], [at(3), 'attachment', 1], [at(20), 'attachment', 2]]);
      return { projectId, releaseId, defs, at, catA, catB };
    }

    // After the GET has read saved membership (inside its read transaction),
    // a second connection commits changes to membership, presence and
    // categories. The rest of the GET must still see the earlier snapshot.
    function armConcurrentWriter(fixture) {
      const { at, catB, releaseId } = fixture;
      let fired = false;
      const owner = currentFixture('armConcurrentWriter');
      const writer = new Database(dbPath);
      // The hook belongs to this fixture; disarm() only clears its own hook.
      const hook = (entry) => {
        if (fired || entry.kind !== 'membership') return;
        fired = true;
        expect(entry.inTransaction).toBe(true);
        writer.transaction(() => {
          writer.prepare('DELETE FROM release_assets WHERE release_id = ? AND asset_id = ?').run(releaseId, at(3));
          writer.prepare("INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', 9)").run(releaseId, at(7));
          writer.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(at(5));
          writer.prepare(`UPDATE assets SET category_id = ? WHERE id IN (${[0, 1, 2, 3, 4].map(at).join(',')})`).run(catB);
        })();
      };
      owner.statementHook = hook;
      const disarm = () => {
        if (owner.statementHook === hook) owner.statementHook = null;
        writer.close();
      };
      return { writer, wasFired: () => fired, disarm };
    }

    it('one GET reads COUNT, membership, aggregates and rows from one snapshot while another connection commits', async () => {
      const fixture = buildSnapshotFixture();
      const { at, releaseId } = fixture;
      const { writer, wasFired, disarm } = armConcurrentWriter(fixture);
      let m;
      try {
        m = await get(`/releases/${releaseId}/assets?selection=all&pageSize=10`);
        expect(wasFired()).toBe(true);
        // The writer committed.
        expect(writer.prepare('SELECT is_present FROM assets WHERE id = ?').get(at(5)).is_present).toBe(0);
      } finally {
        disarm();
      }

      expect(m.res.status).toBe(200);
      const page = parsePage(m.res.text);
      // Pre-commit snapshot throughout: total, rows, saved flags, carriers, aggregates.
      expect(page.total).toBe(30);
      expect(page.ids).toEqual(Array.from({ length: 10 }, (_, i) => at(i)));
      expect(page.missingIds).toEqual([]);
      expect(page.checkedIds).toEqual([at(1), at(3)]);
      expect(page.persistedIds).toEqual([at(1), at(3), at(20)]);
      expect(page.hiddenIds).toEqual([at(20)]);
      expect(m.res.text).toContain('Snap A (10)');
      expect(m.res.text).toContain('Snap B (0)');
      expect(m.of('count')[0].inTransaction).toBe(true);
      expect(m.of('page')[0].inTransaction).toBe(true);
      expect(m.of('aggregates')[0].inTransaction).toBe(true);
      expect(m.control[0]).toMatch(/^BEGIN/);
      expect(m.control.at(-1)).toMatch(/^COMMIT/);
      expect(db.inTransaction).toBe(false);

      // The next GET sees the committed state consistently.
      const after = await get(`/releases/${releaseId}/assets?selection=all&pageSize=10`);
      const next = parsePage(after.res.text);
      expect(next.total).toBe(29);
      expect(next.ids).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9, 10].map(at));
      expect(next.checkedIds).toEqual([at(1), at(7)]);
      expect(next.persistedIds).toEqual([at(1), at(20), at(7)]);
      expect(after.res.text).toContain('Snap A (5)');
      expect(after.res.text).toContain('Snap B (5)');
    });

    it('failed or invalid reads leave no open transaction and do not block a writer', async () => {
      const fixture = buildSnapshotFixture();
      for (const [url, status] of [
        [`/releases/${fixture.releaseId}/assets?category=abc`, 422],
        [`/releases/${fixture.releaseId}/assets?category=999999`, 404],
        ['/releases/999999/assets', 404],
        ['/releases/abc/assets', 404],
      ]) {
        const m = await get(url);
        expect(m.res.status, url).toBe(status);
        expect(db.inTransaction, url).toBe(false);
        const begins = m.control.filter((sql) => /^BEGIN/.test(sql)).length;
        const ends = m.control.filter((sql) => /^(?:COMMIT|ROLLBACK)/.test(sql)).length;
        expect(ends, url).toBe(begins);
        if (begins > 0) expect(m.control.at(-1), url).toMatch(/^ROLLBACK/);
        const writer = new Database(dbPath, { timeout: 0 });
        try {
          writer.prepare('UPDATE releases SET updated_at = updated_at WHERE id = ?').run(fixture.releaseId);
        } finally {
          writer.close();
        }
      }
      const ok = await get(`/releases/${fixture.releaseId}/assets?selection=all`);
      expect(ok.res.status).toBe(200);
      expect(parsePage(ok.res.text).total).toBe(30);
    });
  });

  // ═══ 21. Save validation bounds (517) ═════════════════════════════════

  describe('Save validation bounds', () => {
    function buildSaveFixture() {
      const projectId = insertProject('Save Bounds');
      const defs = sequentialAssets(projectId, 620, 'save');
      const foreignProjectId = insertProject('Save Foreign');
      const [foreign] = insertAssets(foreignProjectId, [{ filename: 'foreign-secret-save.png' }]);
      const releaseId = createRelease(projectId);
      return { projectId, defs, foreign, releaseId };
    }

    it('a valid 517-member Save validates in two bounded batches (500 + 17) and persists all members', async () => {
      const fixture = buildSaveFixture();
      // Spread across the whole project and submitted out of filename order.
      const submitted = fixture.defs.filter((_, index) => index % 6 !== 5).slice(0, 517).reverse().map((d) => d.id);
      expect(submitted).toHaveLength(517);
      const m = await postForm(`/releases/${fixture.releaseId}/assets?selection=all&pageSize=10&page=4`,
        submitted.map((id) => ['selectedAssetIds', String(id)]));
      expect(m.res.status).toBe(302);
      // B3-F2: exactly /releases/:id plus only the Save's own one-time ticket.
      expect(m.res.headers.location).toMatch(new RegExp(`^/releases/${fixture.releaseId}\\?assetsSaved=[A-Za-z0-9_-]{43}$`));
      const validation = m.of('validation');
      expect(validation.map((entry) => entry.args.length)).toEqual([500, 17]);
      expect(validation.map((entry) => entry.rows)).toEqual([500, 17]);
      expect(validation.every((entry) => entry.metadataRows === 0)).toBe(true);
      expect(m.of('perIdAssetRead')).toHaveLength(0);
      expect(m.of('recovery')).toHaveLength(0);
      expect(m.of('page')).toHaveLength(0);
      // No full metadata per selected asset: the only metadata-bearing read
      // is ONE saved-collection statement (after the write), bounded by the
      // release's membership size — never per ID, never project-wide (620).
      const metadataReads = m.log.filter((entry) => entry.metadataRows > 0);
      expect(metadataReads.map((entry) => [entry.kind, entry.metadataRows])).toEqual([['savedCollection', 517]]);
      expect(m.metadataRows).toBe(517);
      expect(m.of('membershipWrite').length).toBeGreaterThan(0);
      expect(membership(fixture.releaseId)).toEqual(submitted.map((id, order) => [id, 'attachment', order]));
    });

    it('a 517-ID Save with a foreign ID: two batches, no writes, persisted membership kept, no foreign metadata', async () => {
      const fixture = buildSaveFixture();
      const preset = fixture.defs.slice(0, 517).map((d, order) => [d.id, order === 0 ? 'primary' : 'attachment', order]);
      saveMembership(fixture.releaseId, preset);
      const before = membership(fixture.releaseId);
      const submitted = [...fixture.defs.slice(100, 400).map((d) => d.id), fixture.foreign.id, ...fixture.defs.slice(400, 616).map((d) => d.id)];
      expect(submitted).toHaveLength(517);
      const m = await postForm(`/releases/${fixture.releaseId}/assets?selection=all&pageSize=10`,
        submitted.map((id) => ['selectedAssetIds', String(id)]));
      expect(m.res.status).toBe(422);
      expect(m.res.text).toContain(`Asset ${fixture.foreign.id} does not belong to the release&#39;s project.`);
      expect(m.res.text).not.toContain('foreign-secret');
      expect(m.of('validation').map((entry) => entry.args.length)).toEqual([500, 17]);
      expect(m.of('perIdAssetRead')).toHaveLength(0);
      expect(m.of('membershipWrite')).toHaveLength(0);
      expect(membership(fixture.releaseId)).toEqual(before);
      // Recovery metadata is project-scoped and batched.
      const recovery = m.of('recovery');
      expect(recovery.length).toBeGreaterThan(0);
      expect(recovery.every((entry) => entry.args[0] === fixture.projectId && entry.args.length - 1 <= 500)).toBe(true);
      expect(recovery.some((entry) => entry.args.includes(fixture.foreign.id))).toBe(true);
      expect(m.maxMetadataRowsPerStatement).toBeLessThanOrEqual(517);
      expect(recovery.reduce((sum, entry) => sum + entry.metadataRows, 0)).toBeLessThan(submitted.length);
    });
  });

  // ═══ 22. Rejected-Save metadata ═══════════════════════════════════════

  it('a recoverable rejected Save keeps the complete multi-page draft with roles and order and hydrates only scoped metadata', async () => {
    const projectId = insertProject('Rejected Save');
    const defs = sequentialAssets(projectId, 120, 'rj');
    db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(defs[70].id);
    const foreignProjectId = insertProject('Rejected Foreign');
    insertAssets(foreignProjectId, [{ filename: 'foreign-secret-rj.png' }]);
    const at = (index) => defs[index].id;
    const releaseId = createRelease(projectId);
    saveMembership(releaseId, [[at(5), 'primary', 0], [at(50), 'preview', 1], [at(95), 'attachment', 2]]);
    const before = membership(releaseId);
    const draft = [[at(95), 'primary', 0], [at(5), 'preview', 1], [at(50), 'attachment', 2], [at(110), 'attachment', 3],
      [at(70), 'attachment', 4], [at(15), 'attachment', 5]];
    const entries = [['roleOrder', JSON.stringify(draft)], ...draft.map(([id]) => ['selectedAssetIds', String(id)])];

    const m = await postForm(`/releases/${releaseId}/assets?selection=all&pageSize=10&page=2&view=list`, entries);
    expect(m.res.status).toBe(422);
    expect(m.res.text).toContain(`Asset ${at(70)} is currently missing and cannot be selected.`);
    expect(membership(releaseId)).toEqual(before);
    expect(m.of('membershipWrite')).toHaveLength(0);
    expect(m.of('validation').map((entry) => entry.args.length)).toEqual([6]);

    const page = parsePage(m.res.text);
    // Page 2 of All (missing unsaved rj-070 excluded): rj-010..rj-019.
    expect(page.ids).toEqual(Array.from({ length: 10 }, (_, i) => at(10 + i)));
    expect(page.checkedIds).toEqual([at(15)]);
    // Complete draft carried: on-page checkbox + off-page hidden carriers.
    expect([...page.hiddenIds, ...page.checkedIds].sort((a, b) => a - b)).toEqual(draft.map(([id]) => id).sort((a, b) => a - b));
    const roleOrder = /<input type="hidden" name="roleOrder" value="([^"]*)">/.exec(m.res.text);
    expect(JSON.parse(decodeHtml(roleOrder[1]))).toEqual(draft);
    const facts = cardFacts(page.items.find((item) => item.id === at(15)));
    expect(facts).toEqual({ role: 'Attachment', order: '5' });

    // Metadata: the bounded page (10), the persisted collection the Save path
    // read (3), and one project-scoped recovery batch for the off-page draft
    // IDs (5) — never a project-wide read.
    expect(m.of('page')).toHaveLength(1);
    expect(m.of('page')[0].metadataRows).toBe(10);
    const recovery = m.of('recovery');
    expect(recovery).toHaveLength(1);
    expect(recovery[0].args[0]).toBe(projectId);
    expect(recovery[0].args.slice(1).sort((a, b) => a - b)).toEqual([at(5), at(50), at(70), at(95), at(110)].sort((a, b) => a - b));
    expect(recovery[0].metadataRows).toBe(5);
    expect(m.metadataRows).toBe(10 + 3 + 5);
    expect(m.maxMetadataRowsPerStatement).toBe(10);
    expect(m.of('perIdAssetRead')).toHaveLength(0);
    expect(m.res.text).not.toContain('foreign-secret');
  });
});
