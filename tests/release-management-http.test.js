import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

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
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
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

  async function createRelease(projectId, title, status = 'idea', extra = {}) {
    const req = agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`);
    for (const [key, value] of Object.entries(extra)) {
      req.send(`${key}=${encodeURIComponent(value)}`);
    }
    const res = await req.set('Content-Type', 'application/x-www-form-urlencoded').expect(302);
    return res.headers.location; // /releases/:id
  }

  it('GET /release-management renders the release-record list', async () => {
    const projectId = await createProject('Mgmt List Project');
    await createRelease(projectId, 'Mgmt List Release', 'idea');

    const res = await agent.get('/release-management').expect(200);
    expect(res.text).toContain('table-scroll');
    expect(res.text).toContain('Mgmt List Release');
  });

  it('GET /release-management?view=board renders the release-record board', async () => {
    const projectId = await createProject('Mgmt Board Project');
    await createRelease(projectId, 'Mgmt Board Release', 'planned');

    const res = await agent.get('/release-management?view=board').expect(200);
    expect(res.text).toContain('board-container');
    expect(res.text).toContain('Mgmt Board Release');
  });

  it('project filtering works with project=<id>', async () => {
    const projectA = await createProject('Mgmt Filter Project A');
    const projectB = await createProject('Mgmt Filter Project B');
    await createRelease(projectA, 'Release In A', 'idea');
    await createRelease(projectB, 'Release In B', 'idea');

    const res = await agent.get(`/release-management?project=${projectA}`).expect(200);
    expect(res.text).toContain('Release In A');
    expect(res.text).not.toContain('Release In B');
  });

  it('status filtering works', async () => {
    const projectId = await createProject('Mgmt Status Project');
    await createRelease(projectId, 'Idea Release', 'idea');
    await createRelease(projectId, 'Planned Release', 'planned');

    const res = await agent.get('/release-management?status=planned').expect(200);
    expect(res.text).toContain('Planned Release');
    expect(res.text).not.toContain('Idea Release');
  });

  it('schedule filtering works', async () => {
    const projectId = await createProject('Mgmt Schedule Project');
    await createRelease(projectId, 'Unscheduled Release', 'idea');
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
    const releaseLocation = await createRelease(projectId, 'To Be Archived Release', 'idea');
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
    await createRelease(projectId, 'A Title Release', 'idea');
    await createRelease(projectId, 'Z Title Release', 'idea');

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
      await createRelease(projectId, `Mgmt Page Release ${i}`, 'idea');
    }

    // Explicitly request page=1 to prove it gets normalized away rather than
    // carried through into rendered links (e.g. as a stray "page=1").
    const page1Res = await agent.get('/release-management?status=idea&page=1').expect(200);
    expect(page1Res.text).toContain('Page 1 of');
    expect(page1Res.text).toContain('Mgmt Page Release 29');
    expect(page1Res.text).not.toContain('Mgmt Page Release 0');

    // On page 1 there is no Previous link at all.
    expect(page1Res.text).not.toMatch(/>Previous<\/a>/);

    const page1LinkMatch = page1Res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Next<\/a>/);
    expect(page1LinkMatch).not.toBeNull();
    expect(page1LinkMatch[1]).not.toContain('page=1');
    expect(page1LinkMatch[1]).toContain('page=2');

    const res = await agent.get('/release-management?status=idea&page=2').expect(200);
    expect(res.text).toContain('Page 2 of');
    expect(res.text).toContain('Mgmt Page Release 0');
    expect(res.text).not.toContain('Mgmt Page Release 29');

    const prevMatch = res.text.match(/<a\s[^>]*href="(\/release-management\?[^"]*)"[^>]*>Previous<\/a>/);
    expect(prevMatch).not.toBeNull();
    expect(prevMatch[1]).toMatch(/^\/release-management\?/);
    expect(prevMatch[1]).toContain('status=idea');
    expect(prevMatch[1]).not.toContain('page=');
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
    const releaseLocation = await createRelease(projectId, 'Detail Link Release', 'idea');
    const releaseId = releaseLocation.replace('/releases/', '');

    const res = await agent.get('/release-management').expect(200);
    expect(res.text).toContain(`href="/releases/${releaseId}"`);
    expect(res.text).not.toContain(`href="/release-management/${releaseId}"`);
  });

  it('create-release links still point to /releases/new', async () => {
    const res = await agent.get('/release-management').expect(200);
    expect(res.text).toContain('href="/releases/new"');
  });

  it('GET /releases list still works unchanged alongside the new route', async () => {
    const projectId = await createProject('Legacy Route Project');
    await createRelease(projectId, 'Legacy Route Release', 'idea');

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('Legacy Route Release');
    expect(res.text).toContain('<form class="filters" method="get" action="/releases">');
  });

  it('/release-management does not expose the mutation-route surface', async () => {
    // Use a real release ID so these prove the management router itself
    // exposes no route for these paths, rather than merely rejecting an
    // invalid identifier (which would 404 for a different reason).
    const projectId = await createProject('Mgmt Boundary Project');
    const releaseLocation = await createRelease(projectId, 'Mgmt Boundary Release', 'idea');
    const releaseId = releaseLocation.replace('/releases/', '');

    await agent.get('/release-management/new').expect(404);
    await agent.get(`/release-management/${releaseId}`).expect(404);
    await agent
      .post('/release-management')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Should+Not+Be+Creatable')
      .send('status=idea')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(404);
    await agent
      .post(`/release-management/${releaseId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(404);
  });
});
