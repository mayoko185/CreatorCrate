import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function selectedOptionValue(html, selectId) {
  const select = html.match(new RegExp(`<select id="${selectId}"[\\s\\S]*?</select>`))?.[0];
  if (!select) throw new Error(`Select ${selectId} was not rendered.`);
  return select.match(/<option value="([^"]+)"\s+selected(?:\s|>)/)?.[1];
}

// Phase 2A: GET /release-management reuses the exact same list/board handler
// as GET /releases (handleReleaseListOrBoard in src/routes/releases.js), so
// this suite mirrors the relevant coverage from tests/releases-http.test.js
// against the new mount point without duplicating the full fixture matrix.
// GET /releases itself keeps its own full coverage untouched.

describe('release-management HTTP route (Phase 2A)', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let appDataRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-relmgmt-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject(title) {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`title=${encodeURIComponent(title)}`)
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    return projRes.headers.location.replace('/projects/', '');
  }

  async function createRelease(projectId, title, projectStatus = null, extra = {}) {
    if (projectStatus !== null) {
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(projectStatus, projectId);
    }
    const req = agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`);
    for (const [key, value] of Object.entries(extra)) {
      req.send(`${key}=${encodeURIComponent(value)}`);
    }
    const res = await req.set('Content-Type', 'application/x-www-form-urlencoded').expect(302);
    return res.headers.location;
  }

  function saveReleaseManagementDefault(option, value) {
    return app.locals.pageDefaultsService.saveDefault('releaseManagement', option, value);
  }

  function writeStoredReleaseManagementDefault(option, value) {
    const key = PAGE_DEFAULT_DEFINITIONS.releaseManagement[option].key;
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  it('GET /release-management renders the release-record list', async () => {
    const projectId = await createProject('Mgmt List Project');
    await createRelease(projectId, 'Mgmt List Release', 'ready');

    const res = await agent.get('/release-management').expect(200);
    expect(res.text).toContain('table-scroll');
    expect(res.text).toContain('Mgmt List Release');
    expect(res.text).toContain('Project status');
    expect(res.text).toMatch(/<span class="status-badge status-badge--active">Ready<\/span>/);
    expect(res.text).not.toContain('id="list-status"');
  });

  it('GET /release-management?view=board renders the release-record board', async () => {
    const projectId = await createProject('Mgmt Board Project');
    const publishedLocation = await createRelease(projectId, 'Mgmt Board Published Release', 'planned');
    await createRelease(projectId, 'Mgmt Board Planned Release', 'planned');
    const publishedId = Number(publishedLocation.replace('/releases/', ''));
    db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(publishedId);

    const res = await agent.get('/release-management?view=board').expect(200);
    expect(res.text).toContain('board-container');
    expect(res.text).toContain('Mgmt Board Published Release');
    expect(res.text).toContain('Mgmt Board Planned Release');
    expect(res.text).toContain('Published');
    expect(res.text).toContain('Planned');
    expect(res.text).not.toContain('Cancelled');
    expect(res.text).not.toContain('id="board-status"');
  });

  it('bare Release Management requests canonicalize valid saved non-fallback defaults', async () => {
    saveReleaseManagementDefault('view', 'board');
    saveReleaseManagementDefault('sort', 'title');
    saveReleaseManagementDefault('order', 'asc');

    const redirect = await agent.get('/release-management').expect(302);
    expect(redirect.headers.location)
      .toBe('/release-management?view=board&sort=title&order=asc');

    const rendered = await agent.get(redirect.headers.location).expect(200);
    expect(rendered.text).toContain('board-container');
    expect(rendered.text).toContain('<input type="hidden" name="sort" value="title">');
    expect(rendered.text).toContain('<input type="hidden" name="order" value="asc">');
  });

  it('does not redirect for missing, fallback-equivalent, or invalid stored values', async () => {
    const missing = await agent.get('/release-management').expect(200);
    expect(missing.headers.location).toBeUndefined();

    saveReleaseManagementDefault('view', 'list');
    saveReleaseManagementDefault('sort', 'updated');
    saveReleaseManagementDefault('order', 'desc');
    const fallback = await agent.get('/release-management').expect(200);
    expect(fallback.headers.location).toBeUndefined();

    writeStoredReleaseManagementDefault('view', 'grid');
    writeStoredReleaseManagementDefault('sort', 'published');
    writeStoredReleaseManagementDefault('order', 'forwards');
    const invalid = await agent.get('/release-management').expect(200);
    expect(invalid.headers.location).toBeUndefined();
    expect(invalid.text).toContain('<option value="updated" selected>Updated</option>');
    expect(invalid.text).toContain('<option value="desc" selected>Desc</option>');
    expect(invalid.text).not.toContain('board-container');
  });

  it('valid explicit values override saved defaults', async () => {
    saveReleaseManagementDefault('view', 'board');
    saveReleaseManagementDefault('sort', 'title');
    saveReleaseManagementDefault('order', 'asc');

    const res = await agent
      .get('/release-management?view=list&sort=updated&order=desc')
      .expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.text).not.toContain('board-container');
    expect(selectedOptionValue(res.text, 'list-sort')).toBe('updated');
    expect(selectedOptionValue(res.text, 'list-order')).toBe('desc');
    expect(res.text).toContain('<input type="hidden" name="view" value="list">');
  });

  it('omitted presentation options use saved defaults when a filter or another option is explicit', async () => {
    saveReleaseManagementDefault('view', 'board');
    saveReleaseManagementDefault('sort', 'title');
    saveReleaseManagementDefault('order', 'asc');

    const res = await agent
      .get('/release-management?view=list&search=Mgmt')
      .expect(200);

    expect(res.text).not.toContain('board-container');
    expect(selectedOptionValue(res.text, 'list-sort')).toBe('title');
    expect(selectedOptionValue(res.text, 'list-order')).toBe('asc');
    expect(res.text).toContain('search=Mgmt');
  });

  it('explicit invalid presentation values use route fallbacks instead of saved defaults', async () => {
    saveReleaseManagementDefault('view', 'board');
    saveReleaseManagementDefault('sort', 'title');
    saveReleaseManagementDefault('order', 'asc');

    const res = await agent
      .get('/release-management?view=grid&sort=published&order=forwards')
      .expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.text).not.toContain('board-container');
    expect(selectedOptionValue(res.text, 'list-sort')).toBe('updated');
    expect(selectedOptionValue(res.text, 'list-order')).toBe('desc');
    expect(res.text).toContain('<input type="hidden" name="view" value="list">');
    expect(res.text).toContain('sort=updated');
    expect(res.text).toContain('order=desc');
    expect(res.text).not.toContain('sort=published');
    expect(res.text).not.toContain('order=forwards');
  });

  it('project filtering works with project=<id>', async () => {
    const projectA = await createProject('Mgmt Filter Project A');
    const projectB = await createProject('Mgmt Filter Project B');
    await createRelease(projectA, 'Release In A', 'tbd');
    await createRelease(projectB, 'Release In B', 'tbd');

    const res = await agent.get(`/release-management?project=${projectA}`).expect(200);
    expect(res.text).toContain('Release In A');
    expect(res.text).not.toContain('Release In B');
  });

  it('ignores obsolete status filtering without mapping it to project status', async () => {
    const projectId = await createProject('Mgmt Status Project');
    await createRelease(projectId, 'Idea Release', 'tbd');
    await createRelease(projectId, 'Planned Release', 'planned');

    const res = await agent.get('/release-management?status=planned').expect(200);
    expect(res.text).toContain('Planned Release');
    expect(res.text).toContain('Idea Release');
  });

  it('schedule filtering works', async () => {
    const projectId = await createProject('Mgmt Schedule Project');
    await createRelease(projectId, 'Unscheduled Release', 'tbd');
    await createRelease(projectId, 'Scheduled Release', 'planned', { plannedDate: '2026-08-01' });

    const res = await agent.get('/release-management?schedule=unscheduled').expect(200);
    expect(res.text).toContain('Unscheduled Release');
    expect(res.text).not.toContain('Scheduled Release');
  });

  it('readiness filtering works', async () => {
    const projectId = await createProject('Mgmt Readiness Project');
    await createRelease(projectId, 'Blocked Ready Release', 'ready');

    const res = await agent.get('/release-management?readiness=blocked-ready').expect(200);
    expect(res.text).toContain('Blocked Ready Release');

    const resPublishable = await agent.get('/release-management?readiness=publishable').expect(200);
    expect(resPublishable.text).not.toContain('Blocked Ready Release');
  });

  it('includeArchived works', async () => {
    const projectId = await createProject('Mgmt Archived Project');
    const releaseLocation = await createRelease(projectId, 'To Be Archived Release', 'tbd');
    await agent
      .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const withoutArchived = await agent.get('/release-management').expect(200);
    expect(withoutArchived.text).not.toContain('To Be Archived Release');

    const withArchived = await agent.get('/release-management?includeArchived=1').expect(200);
    expect(withArchived.text).toContain('To Be Archived Release');
  });

  it('sorting and ordering work', async () => {
    const projectId = await createProject('Mgmt Sort Project');
    await createRelease(projectId, 'A Title Release', 'tbd');
    await createRelease(projectId, 'Z Title Release', 'tbd');

    const res = await agent.get('/release-management?sort=title&order=asc').expect(200);
    const aIdx = res.text.indexOf('A Title Release');
    const zIdx = res.text.indexOf('Z Title Release');
    expect(aIdx).toBeGreaterThan(-1);
    expect(zIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(zIdx);
  });

  it('pagination works, proves page contents, and preserves filters', async () => {
    // Default sort is updated desc with an id-desc tiebreak (deterministic
    // regardless of updated_at timestamp precision — see buildOrderClauseWithTable
    // in src/data/release-repository.js), so the most-recently-created release
    // (highest id) is always first and the first-created (lowest id) is always
    // last. With PAGE_SIZE=25 and 30 records, release 29 is guaranteed on page 1
    // and release 0 is guaranteed on page 2.
    const projectId = await createProject('Mgmt Page Project');
    for (let i = 0; i < 30; i++) {
      await createRelease(projectId, `Mgmt Page Release ${i}`, 'tbd');
    }

    // Explicitly request page=1 to prove it gets normalized away rather than
    // carried through into rendered links (e.g. as a stray "page=1").
    const page1Res = await agent.get('/release-management?page=1').expect(200);
    expect(page1Res.text).toContain('Page 1 of');
    expect(page1Res.text).toContain('Mgmt Page Release 29');
    expect(page1Res.text).not.toContain('Mgmt Page Release 0');

    // On page 1 there is no Previous link at all.
    expect(page1Res.text).not.toMatch(/>Previous<\/a>/);

    const page1LinkMatch = page1Res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Next<\/a>/);
    expect(page1LinkMatch).not.toBeNull();
    expect(page1LinkMatch[1]).not.toContain('page=1');
    expect(page1LinkMatch[1]).toContain('page=2');

    const res = await agent.get('/release-management?page=2').expect(200);
    expect(res.text).toContain('Page 2 of');
    expect(res.text).toContain('Mgmt Page Release 0');
    expect(res.text).not.toContain('Mgmt Page Release 29');

    const prevMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Previous<\/a>/);
    expect(prevMatch).not.toBeNull();
    expect(prevMatch[1]).toMatch(/^\/release-management\?/);
    expect(prevMatch[1]).not.toContain('status=');
    expect(prevMatch[1]).not.toContain('page=');
  });

  it('preserves filters, page size, and effective presentation values across pagination, switching, and clear links', async () => {
    saveReleaseManagementDefault('view', 'list');
    saveReleaseManagementDefault('sort', 'title');
    saveReleaseManagementDefault('order', 'asc');

    const projectId = await createProject('Mgmt Defaults Context Project');
    for (let i = 0; i < 30; i++) {
      await createRelease(projectId, `Mgmt Defaults Context Release ${String(i).padStart(2, '0')}`);
    }

    const res = await agent
      .get(`/release-management?project=${projectId}&schedule=unscheduled&readiness=all&includeArchived=1&page=2&pageSize=10&view=list`)
      .expect(200);

    expect(res.text).toContain('Page 2 of 3');
    expect(selectedOptionValue(res.text, 'list-sort')).toBe('title');
    expect(selectedOptionValue(res.text, 'list-order')).toBe('asc');
    expect(res.text).toContain('<input type="hidden" name="view" value="list">');
    expect(res.text).toContain('<input type="hidden" name="pageSize" value="10">');

    const boardHref = res.text.match(/<a class="view-switcher-option" href="([^"]+)"[^>]*>Board<\/a>/)?.[1];
    expect(boardHref).toBeDefined();
    const boardUrl = new URL(boardHref.replace(/&amp;/g, '&'), 'http://localhost');
    expect(boardUrl.searchParams.get('view')).toBe('board');
    expect(boardUrl.searchParams.get('project')).toBe(projectId);
    expect(boardUrl.searchParams.has('status')).toBe(false);
    expect(boardUrl.searchParams.get('schedule')).toBe('unscheduled');
    expect(boardUrl.searchParams.get('includeArchived')).toBe('1');
    expect(boardUrl.searchParams.get('sort')).toBe('title');
    expect(boardUrl.searchParams.get('order')).toBe('asc');
    expect(boardUrl.searchParams.get('pageSize')).toBe('10');
    expect(boardUrl.searchParams.has('page')).toBe(false);

    const clearHref = res.text.match(/<a class="button button-secondary" href="([^"]+)">Clear<\/a>/)?.[1];
    expect(clearHref).toBeDefined();
    const clearUrl = new URL(clearHref.replace(/&amp;/g, '&'), 'http://localhost');
    expect(clearUrl.searchParams.get('view')).toBe('list');
    expect(clearUrl.searchParams.get('sort')).toBe('title');
    expect(clearUrl.searchParams.get('order')).toBe('asc');
    expect(clearUrl.searchParams.get('pageSize')).toBe('10');
    expect(clearUrl.searchParams.has('project')).toBe(false);
    expect(clearUrl.searchParams.has('status')).toBe(false);
    expect(clearUrl.searchParams.has('schedule')).toBe(false);
    expect(clearUrl.searchParams.has('includeArchived')).toBe(false);
    expect(clearUrl.searchParams.has('page')).toBe(false);

    const board = await agent.get(boardUrl.pathname + boardUrl.search).expect(200);
    expect(board.text).toContain('board-container');
    expect(board.text).toContain('<input type="hidden" name="sort" value="title">');
    expect(board.text).toContain('<input type="hidden" name="order" value="asc">');
    expect(board.text).toContain('<input type="hidden" name="pageSize" value="10">');

    const listHref = board.text.match(/<a class="view-switcher-option" href="([^"]+)"[^>]*>List<\/a>/)?.[1];
    expect(listHref).toBeDefined();
    const listUrl = new URL(listHref.replace(/&amp;/g, '&'), 'http://localhost');
    expect(listUrl.searchParams.get('view')).toBe('list');
    expect(listUrl.searchParams.get('project')).toBe(projectId);
    expect(listUrl.searchParams.get('sort')).toBe('title');
    expect(listUrl.searchParams.get('order')).toBe('asc');
    expect(listUrl.searchParams.get('pageSize')).toBe('10');
    expect(listUrl.searchParams.has('page')).toBe(false);
  });

  it('list/board view switching stays under /release-management', async () => {
    const res = await agent.get('/release-management').expect(200);
    const boardMatch = res.text.match(/<a class="view-switcher-option" href="([^"]+)"[^>]*>Board<\/a>/);
    expect(boardMatch).not.toBeNull();
    expect(boardMatch[1]).toMatch(/^\/release-management/);

    const boardRes = await agent.get('/release-management?view=board').expect(200);
    const listMatch = boardRes.text.match(/<a class="view-switcher-option" href="([^"]+)"[^>]*>List<\/a>/);
    expect(listMatch).not.toBeNull();
    expect(listMatch[1]).toMatch(/^\/release-management/);
  });

  it('filter forms submit to /release-management', async () => {
    const listRes = await agent.get('/release-management').expect(200);
    expect(listRes.text).toContain('<form class="filters" method="get" action="/release-management">');

    const boardRes = await agent.get('/release-management?view=board').expect(200);
    expect(boardRes.text).toContain('<form method="get" action="/release-management">');
  });

  it('release-detail links still point to /releases/:id', async () => {
    const projectId = await createProject('Mgmt Detail Link Project');
    const releaseLocation = await createRelease(projectId, 'Detail Link Release', 'tbd');
    const releaseId = releaseLocation.replace('/releases/', '');

    const res = await agent.get('/release-management').expect(200);
    expect(res.text).toContain(`href="/releases/${releaseId}"`);
    expect(res.text).not.toContain(`href="/release-management/${releaseId}"`);
  });

  it('create-release links still point to /releases/new', async () => {
    const res = await agent.get('/release-management').expect(200);
    expect(res.text).toContain('href="/releases/new"');
  });

  it('GET /releases?view=board renders the release board without redirecting', async () => {
    const res = await agent.get('/releases?view=board&sort=title').expect(200);
    expect(res.text).toContain('board-container');
    expect(res.text).toContain('<input type="hidden" name="sort" value="title">');
  });

  it('Release Management defaults do not affect Releases at /releases', async () => {
    saveReleaseManagementDefault('view', 'board');
    saveReleaseManagementDefault('sort', 'title');
    saveReleaseManagementDefault('order', 'asc');

    const res = await agent.get('/releases').expect(200);

    expect(res.headers.location).toBeUndefined();
    expect(res.text).not.toContain('board-container');
    expect(res.text).toContain('<option value="planned" selected>Planned</option>');
    expect(res.text).toContain('<option value="asc" selected>Asc</option>');
  });

  it('/release-management does not expose the mutation-route surface', async () => {
    // Use a real release ID so these prove the management router itself
    // exposes no route for these paths, rather than merely rejecting an
    // invalid identifier (which would 404 for a different reason).
    const projectId = await createProject('Mgmt Boundary Project');
    const releaseLocation = await createRelease(projectId, 'Mgmt Boundary Release', 'tbd');
    const releaseId = releaseLocation.replace('/releases/', '');

    await agent.get('/release-management/new').expect(404);
    await agent.get(`/release-management/${releaseId}`).expect(404);
    await agent
      .post('/release-management')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Should+Not+Be+Creatable')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(404);
    await agent
      .post(`/release-management/${releaseId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(404);
  });

  describe('release URL construction from normalized filters', () => {
    /**
     * Parse query parameters from a URL string (handles HTML-escaped &amp;).
     */
    function parseQuery(url) {
      const qIdx = url.indexOf('?');
      if (qIdx === -1) return {};
      // Unescape HTML entities before parsing
      const search = url.slice(qIdx + 1).replace(/&amp;/g, '&');
      const params = new URLSearchParams(search);
      const obj = {};
      for (const [k, v] of params) {
        obj[k] = v;
      }
      return obj;
    }

    it('unknown query parameters are stripped from generated links', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=URL+Strip+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=URL+Strip+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .get('/release-management?view=list&junk=x&status=bogus&project=1junk&pageSize=bad')
        .expect(200);

      // Locate the "Board" link (view switcher) and parse its URL
      const boardMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      // Valid normalized filters are preserved
      expect(boardQuery.view).toBe('board');
      // Invalid and unknown parameters are absent
      expect(boardQuery.junk).toBeUndefined();
      expect(boardQuery.status).toBeUndefined();
      expect(boardQuery.project).toBeUndefined();
      expect(boardQuery.pageSize).toBeUndefined();
    });

    it('invalid status is not preserved in pagination links', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=URL+Status+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Create enough releases to trigger pagination
      for (let i = 0; i < 30; i++) {
        await agent
          .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send(`title=URL+Status+Release+${i}`)
          .send('status=tbd')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent
        .get('/release-management?status=bogus&page=2')
        .expect(200);

      // Locate the "Previous" pagination link
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      // Invalid status must not appear
      expect(prevQuery.status).toBeUndefined();
      // Page=1 is the default so it's omitted from generated URLs
      expect(prevQuery.page).toBeUndefined();
    });

    it('invalid project ID is not preserved in list-to-board switch', async () => {
      const res = await agent
        .get('/release-management?project=1junk&view=list')
        .expect(200);

      const boardMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      // Invalid project must not appear
      expect(boardQuery.project).toBeUndefined();
      // View must be board
      expect(boardQuery.view).toBe('board');
    });

    it('invalid pageSize is not preserved in generated links', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=URL+PageSize+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await agent
          .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send(`title=URL+PageSize+Release+${i}`)
          .send('status=tbd')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent
        .get('/release-management?pageSize=bad&page=2')
        .expect(200);

      // Pagination link must not contain the invalid pageSize
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.pageSize).toBeUndefined();
      // Page=1 is the default so it's omitted from generated URLs
      expect(prevQuery.page).toBeUndefined();
    });

    it('valid filters are preserved through list/board switching', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=URL+Preserve+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=URL+Preserve+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
      .get('/release-management?view=list')
        .expect(200);

    // Board link must preserve the supported filters.
      const boardMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
    expect(boardQuery.status).toBeUndefined();
      expect(boardQuery.view).toBe('board');
    });

    it('default readiness=all is omitted from generated links', async () => {
      const res = await agent
        .get('/release-management?readiness=all')
        .expect(200);

      // Board link must not contain readiness=all
      const boardMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      expect(boardQuery.readiness).toBeUndefined();
    });

    it('valid readiness filter is preserved in generated links', async () => {
      const res = await agent
        .get('/release-management?readiness=publishable')
        .expect(200);

      const boardMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      expect(boardQuery.readiness).toBe('publishable');
    });

    it('invalid readiness is not preserved in generated links', async () => {
      const res = await agent
        .get('/release-management?readiness=bogus')
        .expect(200);

      const boardMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      expect(boardQuery.readiness).toBeUndefined();
    });

    // ─── Phase 7D-4: Canonical page state in generated URLs ──────────────

    it('page=2 Previous link omits page and retains pageSize', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Page+Canon+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await agent
          .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send(`title=Page+Canon+Release+${i}`)
          .send('status=tbd')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent
        .get('/release-management?pageSize=10&page=2')
        .expect(200);

      // Previous URL must omit page (page=1 is the default)
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.page).toBeUndefined();
      // pageSize=10 must be retained
      expect(prevQuery.pageSize).toBe('10');
    });

    it('list page 2 → Board link has no page', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Page+Board+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await agent
          .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send(`title=Page+Board+Release+${i}`)
          .send('status=tbd')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent
        .get('/release-management?page=2')
        .expect(200);

      // Board link must not contain page
      const boardMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Board<\/a>/);
      expect(boardMatch).not.toBeNull();
      const boardQuery = parseQuery(boardMatch[1]);
      expect(boardQuery.page).toBeUndefined();
      expect(boardQuery.view).toBe('board');
    });

    it('Board → List link has no stale page', async () => {
      const res = await agent
        .get('/release-management?view=board')
        .expect(200);

      // List link must not contain page
      const listMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>List<\/a>/);
      expect(listMatch).not.toBeNull();
      const listQuery = parseQuery(listMatch[1]);
      expect(listQuery.page).toBeUndefined();
      expect(listQuery.view).toBe('list');
    });

    it('list page 3 → Previous link contains page=2', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Page+Prev+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 60; i++) {
        await agent
          .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send(`title=Page+Prev+Release+${i}`)
          .send('status=tbd')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent
        .get('/release-management?page=3')
        .expect(200);

      const prevMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.page).toBe('2');
    });

    it('Next-page URL contains the correct page number', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Page+Next+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await agent
          .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send(`title=Page+Next+Release+${i}`)
          .send('status=tbd')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent
        .get('/release-management')
        .expect(200);

      const nextMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Next<\/a>/);
      expect(nextMatch).not.toBeNull();
      const nextQuery = parseQuery(nextMatch[1]);
      expect(nextQuery.page).toBe('2');
    });

    it('valid project filters remain preserved while page is canonicalized', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Page+Filter+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      for (let i = 0; i < 30; i++) {
        await agent
          .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send(`title=Page+Filter+Release+${i}`)
          .send('status=tbd')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent
        .get(`/release-management?project=${projectId}&page=2`)
        .expect(200);

      // Previous link must retain the project filter and omit page
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.project).toBe(projectId);
      expect(prevQuery.status).toBeUndefined();
      expect(prevQuery.page).toBeUndefined();
    });
  });
  describe('release-management list empty-state detection', () => {
    async function createReleaseWithTitle(title) {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`title=${encodeURIComponent(title + ' Project')}`)
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send(`title=${encodeURIComponent(title)}`)
        .send('status=stale-release-status')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return createRes.headers.location;
    }

    /**
     * Extract the empty-state block from rendered HTML by counting div nesting.
     * Returns the raw HTML from <div class="empty-state"> through its matching
     * closing </div>, or null if not found.
     */
    function extractEmptyState(html) {
      const startMarker = '<div class="empty-state">';
      const startIdx = html.indexOf(startMarker);
      if (startIdx === -1) return null;
      let pos = startIdx + startMarker.length;
      let depth = 1;
      while (depth > 0 && pos < html.length) {
        const openIdx = html.indexOf('<div', pos);
        const closeIdx = html.indexOf('</div>', pos);
        if (closeIdx === -1) return null;
        if (openIdx !== -1 && openIdx < closeIdx) {
          depth++;
          pos = openIdx + 4;
        } else {
          depth--;
          pos = closeIdx + 6;
        }
      }
      return html.slice(startIdx, pos);
    }

    it('zero releases with no filters shows "No releases yet" and New Release action', async () => {
      const res = await agent.get('/release-management').expect(200);
      const emptyBlock = extractEmptyState(res.text);
      expect(emptyBlock).not.toBeNull();
      expect(emptyBlock).toContain('No releases yet');
      expect(emptyBlock).toContain('href="/releases/new"');
      expect(emptyBlock).toContain('New Release');
    });

    it('zero releases with only sort/order params shows "No releases yet" (not filtered)', async () => {
      const res = await agent.get('/release-management?sort=created&order=asc').expect(200);
      const emptyBlock = extractEmptyState(res.text);
      expect(emptyBlock).not.toBeNull();
      expect(emptyBlock).toContain('No releases yet');
      // New Release is the primary remedy, not Reset Filters
      expect(emptyBlock).toContain('href="/releases/new"');
      expect(emptyBlock).not.toContain('Reset Filters');
    });

    it('releases exist but an obsolete status query does not filter them', async () => {
      await createReleaseWithTitle('Visible Release');

      const res = await agent.get('/release-management?status=published').expect(200);
      expect(res.text).toContain('table-scroll');
      expect(res.text).toContain('Visible Release');
      expect(extractEmptyState(res.text)).toBeNull();
    });

    it('releases exist but project filter returns none shows filtered-empty state', async () => {
      await createReleaseWithTitle('Existing Release', 'tbd');

      // Project ID 999 does not exist
      const res = await agent.get('/release-management?project=999').expect(200);
      const emptyBlock = extractEmptyState(res.text);
      expect(emptyBlock).not.toBeNull();
      expect(emptyBlock).toContain('No releases match');
      expect(emptyBlock).toContain('Reset Filters');
      expect(emptyBlock).toContain('href="/release-management"');
    });

    it('Reset Filters URL has the exact canonical path and no query keys', async () => {
      await createReleaseWithTitle('Reset URL Release', 'tbd');

      const res = await agent.get('/release-management?search=not-found').expect(200);
      const emptyBlock = extractEmptyState(res.text);
      expect(emptyBlock).not.toBeNull();
      // The reset link must be exactly /releases with no query string
      const resetMatch = emptyBlock.match(/href="(\/release-management(?:\?[^"]*)?)"/);
      expect(resetMatch).not.toBeNull();
      expect(resetMatch[1]).toBe('/release-management');
    });

    it('New Release does not appear in the filtered-empty state', async () => {
      await createReleaseWithTitle('Filter Test Release', 'tbd');

      const res = await agent.get('/release-management?search=not-found').expect(200);
      const emptyBlock = extractEmptyState(res.text);
      expect(emptyBlock).not.toBeNull();
      expect(emptyBlock).not.toContain('href="/releases/new"');
      expect(emptyBlock).not.toContain('New Release');
    });

    it('releases exist and are visible shows the table, not an empty state', async () => {
      await createReleaseWithTitle('Shown Release', 'tbd');

      const res = await agent.get('/release-management').expect(200);
      expect(res.text).toContain('table-scroll');
      expect(res.text).toContain('Shown Release');
      // No empty-state block in the rendered content
      expect(extractEmptyState(res.text)).toBeNull();
    });
  });

});
