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

// Phase 2B: GET /releases is now the "Published Work" page — a project-derived
// listing of published projects, requiring no release record. This suite
// covers that page plus the compatibility redirects that send stale
// release-record-list links (?view=, ?status=, etc.) to /release-management.

describe('Published Work HTTP route (Phase 2B)', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let appDataRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pubwork-'));
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

  async function createProject(title, options = {}) {
    const {
      status = 'tbd',
      priority = 'normal',
      plannedDate,
      publishedDate,
      patreonUrl,
      description,
      notes,
    } = options;

    const req = agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .send(`priority=${priority}`);
    if (plannedDate) req.send(`plannedDate=${plannedDate}`);
    if (publishedDate) req.send(`publishedDate=${publishedDate}`);
    if (patreonUrl) req.send(`patreonUrl=${encodeURIComponent(patreonUrl)}`);
    if (description) req.send(`description=${encodeURIComponent(description)}`);
    if (notes) req.send(`notes=${encodeURIComponent(notes)}`);

    const res = await req.set('Content-Type', 'application/x-www-form-urlencoded').expect(302);
    return res.headers.location.replace('/projects/', '');
  }

  async function archiveProject(projectId) {
    await agent
      .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
  }

  async function createRelease(projectId, title, status = 'idea') {
    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    return res.headers.location;
  }

  // ─── Page identity ──────────────────────────────────────────────────────

  it('renders the Published Work heading, not the release-record list', async () => {
    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('Published Work');
    expect(res.text).toContain('Projects published through CreatorCrate.');
  });

  // ─── Membership ─────────────────────────────────────────────────────────

  it('a published project with no release record appears', async () => {
    await createProject('Solo Published Project', { status: 'published', publishedDate: '2026-01-05' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('Solo Published Project');
  });

  it('a published project with a release record appears exactly once', async () => {
    const projectId = await createProject('Published With Release', { status: 'published', publishedDate: '2026-01-06' });
    await createRelease(projectId, 'Its Release', 'idea');

    const res = await agent.get('/releases').expect(200);
    const occurrences = res.text.split('Published With Release').length - 1;
    expect(occurrences).toBe(1);
  });

  it('an unpublished project does not appear', async () => {
    await createProject('Still Drafting Project', { status: 'in-progress' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).not.toContain('Still Drafting Project');
  });

  it('an archived project does not appear', async () => {
    const projectId = await createProject('Archived Published Project', { status: 'published', publishedDate: '2026-01-07' });
    await archiveProject(projectId);

    const res = await agent.get('/releases').expect(200);
    expect(res.text).not.toContain('Archived Published Project');
  });

  // ─── Row content ────────────────────────────────────────────────────────

  it('project title links to /projects/:id', async () => {
    const projectId = await createProject('Linked Project', { status: 'published', publishedDate: '2026-01-08' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain(`href="/projects/${projectId}"`);
  });

  it('project status badge renders', async () => {
    await createProject('Badge Project', { status: 'published', publishedDate: '2026-01-09' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('status-badge--published');
    expect(res.text).toContain('Published');
  });

  it('published date renders', async () => {
    await createProject('Dated Project', { status: 'published', publishedDate: '2026-02-14' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('2026-02-14');
  });

  it('missing published date renders "Not recorded"', async () => {
    await createProject('Undated Published Project', { status: 'published' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('Undated Published Project');
    expect(res.text).toContain('Not recorded');
  });

  it('Patreon URL renders only when present', async () => {
    await createProject('Patreon Project', {
      status: 'published',
      publishedDate: '2026-01-10',
      patreonUrl: 'https://www.patreon.com/creator',
    });
    await createProject('No Patreon Project', { status: 'published', publishedDate: '2026-01-11' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('href="https://www.patreon.com/creator"');
  });

  it('release-record title, readiness, and asset fields do not appear', async () => {
    const projectId = await createProject('Release Data Hidden Project', { status: 'published', publishedDate: '2026-01-12' });
    await createRelease(projectId, 'Unmistakable Release Title Xyz', 'ready');

    const res = await agent.get('/releases').expect(200);
    expect(res.text).not.toContain('Unmistakable Release Title Xyz');
    expect(res.text).not.toContain('readiness-publishable');
    expect(res.text).not.toContain('readiness-blocked');
    expect(res.text).not.toContain('missing-indicator');
  });

  it('no primary New Release action appears', async () => {
    await createProject('No Primary Action Project', { status: 'published', publishedDate: '2026-01-13' });

    const res = await agent.get('/releases').expect(200);
    expect(res.text).not.toContain('New Release');
  });

  // ─── Search ─────────────────────────────────────────────────────────────

  it('search matches title', async () => {
    await createProject('Findable By Title', { status: 'published', publishedDate: '2026-01-14' });
    await createProject('Unrelated Published', { status: 'published', publishedDate: '2026-01-15' });

    const res = await agent.get('/releases?search=Findable').expect(200);
    expect(res.text).toContain('Findable By Title');
    expect(res.text).not.toContain('Unrelated Published');
  });

  it('search matches description', async () => {
    await createProject('Description Match Project', {
      status: 'published',
      publishedDate: '2026-01-16',
      description: 'a very distinctive marker phrase',
    });
    await createProject('Other Published Project', { status: 'published', publishedDate: '2026-01-17' });

    const res = await agent.get('/releases?search=distinctive+marker').expect(200);
    expect(res.text).toContain('Description Match Project');
    expect(res.text).not.toContain('Other Published Project');
  });

  it('search matches notes', async () => {
    await createProject('Notes Match Project', {
      status: 'published',
      publishedDate: '2026-01-18',
      notes: 'an unusual internal note keyword',
    });
    await createProject('Untouched Published Project', { status: 'published', publishedDate: '2026-01-19' });

    const res = await agent.get('/releases?search=unusual+internal').expect(200);
    expect(res.text).toContain('Notes Match Project');
    expect(res.text).not.toContain('Untouched Published Project');
  });

  it('search excludes nonmatching projects', async () => {
    await createProject('Alpha Match', { status: 'published', publishedDate: '2026-01-20' });
    await createProject('Beta Nomatch', { status: 'published', publishedDate: '2026-01-21' });

    const res = await agent.get('/releases?search=Alpha').expect(200);
    expect(res.text).toContain('Alpha Match');
    expect(res.text).not.toContain('Beta Nomatch');
  });

  it('search-empty state renders correctly', async () => {
    await createProject('Existing Published Project', { status: 'published', publishedDate: '2026-01-22' });

    const res = await agent.get('/releases?search=NoSuchThingAtAll').expect(200);
    expect(res.text).toContain('No published work matches your search');
    expect(res.text).not.toContain('New Release');
  });

  it('reset-search link targets /releases', async () => {
    await createProject('Reset Search Project', { status: 'published', publishedDate: '2026-01-23' });

    const res = await agent.get('/releases?search=NoSuchThingAtAll').expect(200);
    expect(res.text).toContain('href="/releases"');
  });

  it('no-published-projects empty state renders correctly', async () => {
    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('No published work yet');
    expect(res.text).toContain('Publish a project to see it here.');
    expect(res.text).not.toContain('/releases/new');
  });

  // ─── Sorting ────────────────────────────────────────────────────────────

  it('published-date default ordering is descending', async () => {
    await createProject('Earlier Published', { status: 'published', publishedDate: '2026-01-01' });
    await createProject('Later Published', { status: 'published', publishedDate: '2026-06-01' });

    const res = await agent.get('/releases').expect(200);
    const laterIdx = res.text.indexOf('Later Published');
    const earlierIdx = res.text.indexOf('Earlier Published');
    expect(laterIdx).toBeGreaterThan(-1);
    expect(earlierIdx).toBeGreaterThan(-1);
    expect(laterIdx).toBeLessThan(earlierIdx);
  });

  it('null published dates sort last', async () => {
    await createProject('Has Published Date', { status: 'published', publishedDate: '2026-01-01' });
    await createProject('No Published Date At All', { status: 'published' });

    const res = await agent.get('/releases').expect(200);
    const datedIdx = res.text.indexOf('Has Published Date');
    const undatedIdx = res.text.indexOf('No Published Date At All');
    expect(datedIdx).toBeGreaterThan(-1);
    expect(undatedIdx).toBeGreaterThan(-1);
    expect(datedIdx).toBeLessThan(undatedIdx);
  });

  it('title sorting works', async () => {
    await createProject('Zeta Sort Project', { status: 'published', publishedDate: '2026-01-01' });
    await createProject('Alpha Sort Project', { status: 'published', publishedDate: '2026-01-02' });

    const res = await agent.get('/releases?sort=title&order=asc').expect(200);
    const alphaIdx = res.text.indexOf('Alpha Sort Project');
    const zetaIdx = res.text.indexOf('Zeta Sort Project');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it('updated-date sorting works', async () => {
    const firstId = await createProject('First Updated Project', { status: 'published', publishedDate: '2026-01-01' });
    const secondId = await createProject('Second Updated Project', { status: 'published', publishedDate: '2026-01-02' });
    // updated_at has 1-second SQLite resolution, so set it explicitly rather
    // than relying on real-clock ordering between two requests in the same test.
    db.prepare("UPDATE projects SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(Number(secondId));
    db.prepare("UPDATE projects SET updated_at = '2020-01-02 00:00:00' WHERE id = ?").run(Number(firstId));

    const res = await agent.get('/releases?sort=updated&order=desc').expect(200);
    const firstIdx = res.text.indexOf('First Updated Project');
    const secondIdx = res.text.indexOf('Second Updated Project');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  // ─── Pagination ─────────────────────────────────────────────────────────

  it('pagination works', async () => {
    for (let i = 0; i < 30; i++) {
      const padded = String(i).padStart(2, '0');
      await createProject(`Pub Page ${padded}`, { status: 'published', publishedDate: '2026-01-01' });
    }

    const page1 = await agent.get('/releases?sort=title&order=asc').expect(200);
    expect(page1.text).toContain('Pub Page 00');
    expect(page1.text).not.toContain('Pub Page 29');

    const page2 = await agent.get('/releases?sort=title&order=asc&page=2').expect(200);
    expect(page2.text).toContain('Pub Page 29');
    expect(page2.text).not.toContain('Pub Page 00');
  });

  it('pagination preserves Published Work query parameters', async () => {
    for (let i = 0; i < 30; i++) {
      const padded = String(i).padStart(2, '0');
      await createProject(`Preserve Page ${padded}`, { status: 'published', publishedDate: '2026-01-01' });
    }

    const res = await agent.get('/releases?sort=title&order=asc').expect(200);
    const nextMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Next<\/a>/);
    expect(nextMatch).not.toBeNull();
    expect(nextMatch[1]).toContain('sort=title');
    expect(nextMatch[1]).toContain('order=asc');
    expect(nextMatch[1]).toContain('page=2');
  });

  it('page=1 normalization is correct', async () => {
    for (let i = 0; i < 30; i++) {
      const padded = String(i).padStart(2, '0');
      await createProject(`Norm Page ${padded}`, { status: 'published', publishedDate: '2026-01-01' });
    }

    const res = await agent.get('/releases?sort=title&order=asc&page=1').expect(200);
    const nextMatch = res.text.match(/<a\s[^>]*href="(\/releases\?[^"]*)"[^>]*>Next<\/a>/);
    expect(nextMatch).not.toBeNull();
    expect(nextMatch[1]).not.toContain('page=1');
  });

  // ─── Compatibility redirects ────────────────────────────────────────────

  describe('compatibility redirects to /release-management', () => {
    it('view redirects to /release-management', async () => {
      const res = await agent.get('/releases?view=board').expect(302);
      expect(res.headers.location).toBe('/release-management?view=board');
    });

    it('project redirects to /release-management', async () => {
      const res = await agent.get('/releases?project=12').expect(302);
      expect(res.headers.location).toBe('/release-management?project=12');
    });

    it('status redirects to /release-management', async () => {
      const res = await agent.get('/releases?status=ready').expect(302);
      expect(res.headers.location).toBe('/release-management?status=ready');
    });

    it('schedule redirects to /release-management', async () => {
      const res = await agent.get('/releases?schedule=overdue').expect(302);
      expect(res.headers.location).toBe('/release-management?schedule=overdue');
    });

    it('readiness redirects to /release-management', async () => {
      const res = await agent.get('/releases?readiness=publishable').expect(302);
      expect(res.headers.location).toBe('/release-management?readiness=publishable');
    });

    it('includeArchived redirects to /release-management', async () => {
      const res = await agent.get('/releases?includeArchived=1').expect(302);
      expect(res.headers.location).toBe('/release-management?includeArchived=1');
    });

    it('redirects preserve all query parameters', async () => {
      const res = await agent.get('/releases?status=ready&sort=planned&page=2').expect(302);
      expect(res.headers.location).toBe('/release-management?status=ready&sort=planned&page=2');
    });

    it('search-only request does not redirect', async () => {
      const res = await agent.get('/releases?search=studio').expect(200);
      expect(res.text).toContain('Published Work');
    });

    it('sort/order/page-only request does not redirect', async () => {
      const res = await agent.get('/releases?sort=published&order=desc&page=1').expect(200);
      expect(res.text).toContain('Published Work');
    });

    it('pageSize-only request does not redirect', async () => {
      const res = await agent.get('/releases?pageSize=10').expect(200);
      expect(res.text).toContain('Published Work');
    });
  });

  // ─── Neighboring routes remain unchanged ───────────────────────────────

  describe('unaffected release-record routes', () => {
    it('/calendar remains 200 and project-backed', async () => {
      const res = await agent.get('/calendar').expect(200);
      expect(res.text).toContain('calendar');
    });

    it('/releases/calendar redirects to the canonical /calendar route', async () => {
      const res = await agent.get('/releases/calendar');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/calendar');
    });

    it('/releases/new remains the existing release-record creation page', async () => {
      await createProject('New Release Form Project', { status: 'tbd' });
      const res = await agent.get('/releases/new').expect(200);
      expect(res.text).toContain('New Release Form Project');
    });

    it('/releases/:id remains the existing release-record detail page', async () => {
      const projectId = await createProject('Detail Route Project', { status: 'tbd' });
      const releaseLocation = await createRelease(projectId, 'Detail Route Release', 'idea');

      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toContain('Detail Route Release');
    });

    it('general /projects list remains unchanged', async () => {
      await createProject('Projects Page Smoke Project', { status: 'tbd' });

      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('Projects Page Smoke Project');
      expect(res.text).toContain('<h1>Projects</h1>');
    });
  });
});
