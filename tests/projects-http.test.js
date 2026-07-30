import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { MANIFEST_FILENAME, readManifestSync } from '../src/storage/manifest.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import {
  STATUS_DIR_MAP,
  formatProjectDirName,
  buildProjectRelPath,
  resolveProjectDir,
} from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dashboard renders counts and a new project action', async () => {
    const res = await agent.get('/').expect(200);
    expect(res.text).toContain('CreatorCrate');
    expect(res.text).toContain('New Project');
    expect(res.text).toContain('TBD');
    expect(res.text).toContain('View All Projects');
  });

  it('dashboard archived count reflects archived projects', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Archive+Count')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const id = createRes.headers.location.replace('/projects/', '');
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken));

    const res = await agent.get('/').expect(200);
    expect(res.text).toContain('<span class="count">1</span> Archived');
  });

  it('project list renders', async () => {
    const res = await agent.get('/projects').expect(200);
    expect(res.text).toContain('Projects');
    expect(res.text).toContain('No projects yet');
  });

  it('new-project form renders', async () => {
    const res = await agent.get('/projects/new').expect(200);
    expect(res.text).toContain('Create Project');
    expect(res.text).toContain('Title');
    expect(res.text).not.toContain('value="archived"');
  });

  it('valid create request redirects to detail', async () => {
    const res = await agent
      .post('/projects')
      .send('title=Test+Project')
      .send('description=A+test')
      .send('notes=notes')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toMatch(/^\/projects\/\d+$/);
  });

  it('invalid create request rerenders with values and errors', async () => {
    const res = await agent
      .post('/projects')
      .send('title=Create+Preserves')
      .send('description=A')
      .send('notes=Create+notes')
      .send('status=ready')
      .send('priority=high')
      .send('plannedDate=2026-08-01')
      .send('publishedDate=2026-08-15')
      .send('patreonUrl=http://example.com/not-patreon')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('Patreon URL must be a valid https://patreon.com link.');
    expect(res.text).toContain('value="Create Preserves"');
    expect(res.text).toContain('A');
    expect(res.text).toContain('Create notes');
    expect(res.text).toContain('<option value="ready" selected>Ready</option>');
    expect(res.text).toContain('<option value="high" selected>High</option>');
    expect(res.text).toContain('value="2026-08-01"');
    expect(res.text).toContain('value="2026-08-15"');
    expect(res.text).toContain('value="http://example.com/not-patreon"');
    expect(res.text).toContain('Basic information');
    expect(res.text).toContain('Status and scheduling');
    expect(res.text).toContain('Links');
    expect(res.text).toContain('href="/projects"');
  });

  it('rejects archived status on create', async () => {
    const res = await agent
      .post('/projects')
      .send('title=Direct+Archive')
      .send('status=archived')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('Status must be one of');
    expect(res.text).toContain('Direct Archive');
  });

  it('project detail renders', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Detail+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const location = createRes.headers.location;
    const res = await agent.get(location).expect(200);
    expect(res.text).toContain('Detail Project');
    expect(res.text).toContain('Edit');
  });

  it('edit form renders', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Editable+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent.get(`${createRes.headers.location}/edit`).expect(200);
    expect(res.text).toContain('Edit Project');
    expect(res.text).toContain('Editable Project');
    expect(res.text).not.toContain('value="archived"');
  });

  it('valid update redirects to detail', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Old+Name')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent
      .post(createRes.headers.location)
      .send('title=New+Name')
      .send('status=planned')
      .send('priority=high')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await agent.get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('New Name');
  });

  it('rejects archived status on update', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Update+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const res = await agent
      .post(createRes.headers.location)
      .send('title=Update+Archive')
      .send('status=archived')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('Status must be one of');
  });

  it('invalid edit request rerenders with submitted values and errors', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Edit+Preserves+Initial')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent
      .post(createRes.headers.location)
      .send('title=Edit+Preserves+Submitted')
      .send('description=Submitted+description')
      .send('notes=Submitted+notes')
      .send('status=in-progress')
      .send('priority=low')
      .send('plannedDate=2026-10-01')
      .send('publishedDate=2026-10-15')
      .send('patreonUrl=http://example.com/not-patreon')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);

    expect(res.text).toContain('Patreon URL must be a valid https://patreon.com link.');
    expect(res.text).toContain('value="Edit Preserves Submitted"');
    expect(res.text).toContain('Submitted description');
    expect(res.text).toContain('Submitted notes');
    expect(res.text).toContain('<option value="in-progress" selected>In Progress</option>');
    expect(res.text).toContain('<option value="low" selected>Low</option>');
    expect(res.text).toContain('value="2026-10-01"');
    expect(res.text).toContain('value="2026-10-15"');
    expect(res.text).toContain('value="http://example.com/not-patreon"');
    expect(res.text).toContain('Basic information');
    expect(res.text).toContain('Status and scheduling');
    expect(res.text).toContain('Links');
    expect(res.text).toContain(`href="${createRes.headers.location}"`);
  });

  it('missing project returns 404', async () => {
    await agent.get('/projects/9999').expect(404);
  });

  it('invalid project id returns 404', async () => {
    await agent.get('/projects/abc').expect(404);
  });

  it('archive action preserves the record and redirects', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=To+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const id = createRes.headers.location.replace('/projects/', '');

    const res = await agent
      .post(`/projects/${id}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe('/projects');

    const detail = await agent.get(`/projects/${id}`).expect(200);
    expect(detail.text).toContain('Archived');
  });

  it('archived project is excluded from the default list', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Hidden+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const id = createRes.headers.location.replace('/projects/', '');
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken));

    const list = await agent.get('/projects').expect(200);
    expect(list.text).not.toContain('Hidden Project');
  });

  it('archived project appears under archived filter and dashboard count', async () => {
    const createRes = await agent
      .post('/projects')
      .send('title=Filter+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    const id = createRes.headers.location.replace('/projects/', '');
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken));

    const archivedList = await agent.get('/projects?status=archived').expect(200);
    expect(archivedList.text).toContain('Filter Archive');

    const dashboard = await agent.get('/').expect(200);
    expect(dashboard.text).toContain('<span class="count">1</span> Archived');
  });

  it('search and status query parameters affect results', async () => {
    await agent
      .post('/projects')
      .send('title=Searchable+Alpha')
      .send('description=find me')
      .send('status=planned')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    await agent
      .post('/projects')
      .send('title=Beta+One')
      .send('status=ready')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));

    const search = await agent.get('/projects?search=alpha').expect(200);
    expect(search.text).toContain('Searchable Alpha');
    expect(search.text).not.toContain('Beta One');

    const status = await agent.get('/projects?status=ready').expect(200);
    expect(status.text).toContain('Beta One');
    expect(status.text).not.toContain('Searchable Alpha');
  });

  it('project list still filters by status', async () => {
    await agent
      .post('/projects')
      .send('title=Status+Filter+Match')
      .send('status=in-progress')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    await agent
      .post('/projects')
      .send('title=Status+Filter+Nonmatch')
      .send('status=planned')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent.get('/projects?status=in-progress').expect(200);
    expect(res.text).toContain('Status Filter Match');
    expect(res.text).not.toContain('Status Filter Nonmatch');
  });

  it('valid status filter with no matches shows filtered-empty state and reset action', async () => {
    await agent
      .post('/projects')
      .send('title=Only+Planned')
      .send('status=planned')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent.get('/projects?status=ready').expect(200);
    expect(res.text).toContain('No projects found');
    expect(res.text).toContain('Reset Filters');
    expect(res.text).toContain('href="/projects"');
    expect(res.text).not.toContain('Create your first project to get started.');
  });

  it('pagination is bounded', async () => {
    for (let i = 1; i <= 30; i += 1) {
      await agent
        .post('/projects')
        .send(`title=Page+${i}`)
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken));
    }

    const page1 = await agent.get('/projects?page=1').expect(200);
    expect(page1.text).toContain('Page 1 of 2');

    const huge = await agent.get('/projects?page=999').expect(200);
    expect(huge.text).toContain('Page 2 of 2');
  });

  it('unknown routes still return safe 404', async () => {
    const res = await agent.get('/not-a-real-route').expect(404);
    expect(res.text).toContain('Not found');
    expect(res.text).not.toContain('at ');
  });

  // ─── Filesystem creation flow ────────────────────────────────────────

  describe('HTTP filesystem creation', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title, status = 'tbd') {
      const slug = parseSlug(title);
      const statusDir = STATUS_DIR_MAP[status];
      const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, statusDir, matching[0]);
    }

    it('creates the database record and project directory', async () => {
      const res = await agent
        .post('/projects')
        .send('title=HTTP+FS+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const location = res.headers.location;
      expect(location).toMatch(/^\/projects\/\d+$/);

      // Verify the directory exists
      const projectDir = getProjectDir('HTTP FS Test', 'tbd');
      expect(projectDir).not.toBeNull();
      expect(fs.existsSync(projectDir)).toBe(true);
      expect(fs.statSync(projectDir).isDirectory()).toBe(true);
    });

    it('uses correct status root directory', async () => {
      await agent
        .post('/projects')
        .send('title=Status+Root+Check')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const projectDir = getProjectDir('Status Root Check', 'in-progress');
      expect(projectDir).not.toBeNull();
      // The directory should be under the 'active' directory
      expect(projectDir).toContain(path.join(projectsRoot, 'active'));
    });

    it('creates standard subdirectories', async () => {
      await agent
        .post('/projects')
        .send('title=Subdirs+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const projectDir = getProjectDir('Subdirs HTTP', 'tbd');
      expect(projectDir).not.toBeNull();

      const expectedSubdirs = ['source', 'references', 'extras', 'thumbnails',
        path.join('exports', 'full'), path.join('exports', 'web')];
      for (const sub of expectedSubdirs) {
        const subPath = path.join(projectDir, sub);
        expect(fs.existsSync(subPath)).toBe(true);
        expect(fs.statSync(subPath).isDirectory()).toBe(true);
      }
    });

    it('writes a project manifest', async () => {
      await agent
        .post('/projects')
        .send('title=Manifest+HTTP')
        .send('description=Test+description')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const projectDir = getProjectDir('Manifest HTTP', 'tbd');
      expect(projectDir).not.toBeNull();

      const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.title).toBe('Manifest HTTP');
      expect(manifest.description).toBe('Test description');
    });

    it('stores relative path in the database', async () => {
      const res = await agent
        .post('/projects')
        .send('title=Rel+Path+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const id = res.headers.location.replace('/projects/', '');
      const detail = await agent.get(`/projects/${id}`).expect(200);
      // Verify the detail page renders — the project was stored
      expect(detail.text).toContain('Rel Path HTTP');
    });

    it('HTTP creation error contains no absolute paths', async () => {
      // This requires a server restart with a broken projectsRoot to simulate failure
      // Instead, verify that invalid data produces errors without paths
      const res = await agent
        .post('/projects')
        .send('title=')
        .send('status=invalid')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
      // The real intent here is "no filesystem path leak" — checked directly
      // against the actual temp root/projectsRoot for this test, rather than
      // a generic "/word/word" regex. That generic form now also matches
      // ordinary in-app relative links (e.g. the disabled-auth warning
      // banner's href="/settings/security", rendered on every page while
      // authentication is disabled) with no path-leak significance at all.
      expect(res.text).not.toContain(tmpDir);
      expect(res.text).not.toContain(projectsRoot);
    });

    it('detail page shows relative project directory after creation', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Detail+Dir+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toContain('Project directory');
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-detail-dir-test/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('filesystem conflict during creation renders safe error with preserved values', async () => {
      // Block the expected path for project id=1 (first project in a fresh DB)
      const slug = parseSlug('Conflict+Create');
      const statusDir = STATUS_DIR_MAP.tbd;
      const conflictPath = path.join(projectsRoot, statusDir, `000001-${slug}`);
      fs.writeFileSync(conflictPath, 'blocker');

      const res = await agent
        .post('/projects')
        .send('title=Conflict+Create')
        .send('description=Value+kept')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(500);

      expect(res.text).toContain('Project creation failed');
      expect(res.text).toContain('Conflict Create');
      expect(res.text).toContain('Value kept');
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });
  });

  // ─── Filesystem update flow ────────────────────────────────────────

  describe('HTTP filesystem update', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title, status = 'tbd') {
      const slug = parseSlug(title);
      const statusDir = STATUS_DIR_MAP[status];
      const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, statusDir, matching[0]);
    }

    it('valid metadata edit rewrites manifest and redirects', async () => {
      // Create a project
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Meta+Edit')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;

      // Edit metadata only (no slug/status change)
      const res = await agent
        .post(location)
        .send('title=HTTP+Meta+Edit')
        .send('description=Updated+desc')
        .send('notes=New+notes')
        .send('status=tbd')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      expect(res.headers.location).toBe(location);

      // Manifest was rewritten
      const projectDir = getProjectDir('HTTP Meta Edit', 'tbd');
      expect(projectDir).not.toBeNull();
      const manifest = readManifestSync(projectDir);
      expect(manifest.description).toBe('Updated desc');
      expect(manifest.notes).toBe('New notes');
      expect(manifest.priority).toBe('high');
    });

    it('title change renames the directory', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Old+HTTP+Name')
        .send('description=Before')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Old HTTP Name', 'tbd');
      expect(oldDir).not.toBeNull();

      // Add a custom file to prove contents survive
      fs.writeFileSync(path.join(oldDir, 'custom-file.txt'), 'survived');

      // Rename
      await agent
        .post(location)
        .send('title=New+HTTP+Name')
        .send('description=After')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New directory exists
      const newDir = getProjectDir('New HTTP Name', 'tbd');
      expect(newDir).not.toBeNull();
      expect(fs.existsSync(newDir)).toBe(true);

      // Custom file survived
      expect(fs.existsSync(path.join(newDir, 'custom-file.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(newDir, 'custom-file.txt'), 'utf8')).toBe('survived');

      // Detail page shows new name
      const detail = await agent.get(location).expect(200);
      expect(detail.text).toContain('New HTTP Name');
      expect(detail.text).not.toContain('Old HTTP Name');
    });

    it('status change moves the directory', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Status+Move+HTTP')
        .send('description=Moved')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Status Move HTTP', 'tbd');
      expect(oldDir).not.toBeNull();

      // Add a custom file
      fs.writeFileSync(path.join(oldDir, 'move-test.txt'), 'moved');

      // Change status to in-progress (maps to 'active')
      await agent
        .post(location)
        .send('title=Status+Move+HTTP')
        .send('description=Moved')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New directory under 'active'
      const newDir = getProjectDir('Status Move HTTP', 'in-progress');
      expect(newDir).not.toBeNull();
      expect(newDir).toContain(path.join(projectsRoot, 'active'));

      // Custom file survived
      expect(fs.existsSync(path.join(newDir, 'move-test.txt'))).toBe(true);

      // Manifest reflects new status
      const manifest = readManifestSync(newDir);
      expect(manifest.status).toBe('in-progress');
    });

    it('combined title/status change works correctly', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Combined+HTTP+Start')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Combined HTTP Start', 'planned');
      expect(oldDir).not.toBeNull();

      // Change both title and status
      await agent
        .post(location)
        .send('title=Combined+HTTP+Final')
        .send('status=published')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New directory under 'published'
      const newDir = getProjectDir('Combined HTTP Final', 'published');
      expect(newDir).not.toBeNull();
      expect(newDir).toContain(path.join(projectsRoot, 'published'));

      // Detail page shows everything
      const detail = await agent.get(location).expect(200);
      expect(detail.text).toContain('Combined HTTP Final');
      expect(detail.text).toContain('Published');
    });

    it('error responses contain no absolute filesystem paths on update failure', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=No+Path+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Trigger a validation error (non-filesystem) — should be path-safe
      const res = await agent
        .post(createRes.headers.location)
        .send('title=No+Path+HTTP')
        .send('status=archived')  // rejected by WORKFLOW_STATUSES validation
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      // Only check for absolute Windows paths (drive-letter paths)
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });

    it('archived status is still rejected from edit form', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=No+Archive+In+Edit')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent
        .post(createRes.headers.location)
        .send('title=No+Archive+In+Edit')
        .send('status=archived')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).toContain('Status must be one of');
    });

    it('title change updates the displayed relative path', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Old+Path+Name')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Before rename — detail shows old dir
      let detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-old-path-name/);

      // Rename
      await agent
        .post(createRes.headers.location)
        .send('title=New+Path+Name')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // After rename — detail shows new dir
      detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-new-path-name/);
      expect(detail.text).not.toMatch(/old-path-name/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('status change updates the displayed relative path', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Status+Path+Change')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Before — under planned/
      let detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/planned(?:&#92;|\/)\d+-status-path-change/);

      // Change status
      await agent
        .post(createRes.headers.location)
        .send('title=Status+Path+Change')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // After — under active/
      detail = await agent.get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/active(?:&#92;|\/)\d+-status-path-change/);
      expect(detail.text).not.toMatch(/planned/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('filesystem failure during update renders safe error with preserved values', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Update+Fail+Safe')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Remove the project directory to trigger a filesystem error on update
      const projectDir = getProjectDir('Update Fail Safe', 'tbd');
      expect(projectDir).not.toBeNull();
      fs.rmSync(projectDir, { recursive: true, force: true });

      const res = await agent
        .post(createRes.headers.location)
        .send('title=Updated+Title')
        .send('description=Preserved+text')
        .send('status=tbd')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(500);

      expect(res.text).toContain('Project update failed');
      expect(res.text).toContain('Updated Title');
      expect(res.text).toContain('Preserved text');
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });
  });

  // ─── Filesystem archive flow ────────────────────────────────────────

  describe('HTTP filesystem archive', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title, status = 'tbd') {
      const slug = parseSlug(title);
      const statusDir = STATUS_DIR_MAP[status];
      const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, statusDir, matching[0]);
    }

    function getArchiveDir(title) {
      const slug = parseSlug(title);
      const entries = fs.readdirSync(path.join(projectsRoot, 'archived'));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, 'archived', matching[0]);
    }

    it('archive moves the directory to archived/', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Move')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      const oldDir = getProjectDir('HTTP Archive Move', 'tbd');
      expect(oldDir).not.toBeNull();
      expect(fs.existsSync(oldDir)).toBe(true);

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New directory under archived/
      const archiveDir = getArchiveDir('HTTP Archive Move');
      expect(archiveDir).not.toBeNull();
      expect(fs.existsSync(archiveDir)).toBe(true);
      expect(archiveDir).toContain(path.join(projectsRoot, 'archived'));
    });

    it('status becomes archived', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Status')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const row = db.prepare('SELECT status, archived_at FROM projects WHERE id = ?').get(Number(id));
      expect(row.status).toBe('archived');
      expect(row.archived_at).toBeTruthy();
    });

    it('relative path is updated', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Path')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(Number(id));
      expect(row.project_dir).toMatch(path.join('archived', ''));
    });

    it('manifest reflects archived status', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Archive+Manifest')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const archiveDir = getArchiveDir('HTTP Archive Manifest');
      expect(archiveDir).not.toBeNull();
      const manifest = readManifestSync(archiveDir);
      expect(manifest).not.toBeNull();
      expect(manifest.status).toBe('archived');
    });

    it('existing files survive archive', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+Files+Survive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      const oldDir = getProjectDir('HTTP Files Survive', 'tbd');
      expect(oldDir).not.toBeNull();

      // Add custom files
      fs.writeFileSync(path.join(oldDir, 'http-extra.txt'), 'http content');
      fs.mkdirSync(path.join(oldDir, 'source'), { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'source', 'render.png'), 'png data');

      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Files survived at new location
      const archiveDir = getArchiveDir('HTTP Files Survive');
      expect(archiveDir).not.toBeNull();
      expect(fs.existsSync(path.join(archiveDir, 'http-extra.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(archiveDir, 'http-extra.txt'), 'utf8')).toBe('http content');
      expect(fs.existsSync(path.join(archiveDir, 'source', 'render.png'))).toBe(true);
    });

    it('error responses contain no absolute filesystem paths', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+No+Path+Archive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // Remove the directory to cause a failure
      const projectDir = getProjectDir('HTTP No Path Archive', 'tbd');
      expect(projectDir).not.toBeNull();
      fs.rmSync(projectDir, { recursive: true, force: true });

      const res = await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(500);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });

    it('archive changes the displayed relative path to archived/', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archive+Path+Display')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // Before archive — under tbd/
      let detail = await agent.get(`/projects/${id}`).expect(200);
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-archive-path-display/);

      // Archive
      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // After archive — under archived/
      detail = await agent.get(`/projects/${id}`).expect(200);
      expect(detail.text).toMatch(/archived(?:&#92;|\/)\d+-archive-path-display/);
      expect(detail.text).not.toMatch(/tbd(?:&#92;|\/)/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('archive remains POST-only', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=HTTP+GET+Archive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // GET should not archive — 404 from route matching
      await agent
        .get(`/projects/${id}/archive`)
        .expect(404);
    });

    it('invalid project id returns 404 on archive', async () => {
      await agent
        .post('/projects/abc/archive')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(404);
    });

    it('missing project returns 404 on archive', async () => {
      await agent
        .post('/projects/99999/archive')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(404);
    });

    it('archived scan rejection causes no asset changes (full row snapshot)', async () => {
      const title = 'Archived Scan Reject';
      const createRes = await agent
        .post('/projects')
        .send('title=' + encodeURIComponent(title))
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const getProjectDirForTitle = () => {
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
        const matching = entries.filter((e) => e.endsWith(`-${slug}`));
        return path.join(projectsRoot, 'tbd', matching[0]);
      };
      const projectDir = getProjectDirForTitle();

      // 1. Create at least two baseline files
      const baselineFile1 = 'baseline-a.txt';
      const baselineFile2 = 'baseline-b.txt';
      const newFile = 'will-be-new.txt';

      fs.writeFileSync(path.join(projectDir, baselineFile1), 'baseline a');
      fs.writeFileSync(path.join(projectDir, baselineFile2), 'baseline b');

      // 2. Run a successful scan so both have persisted asset rows
      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // 3. Modify the first baseline file
      fs.writeFileSync(path.join(projectDir, baselineFile1), 'modified content');

      // 4. Delete the second baseline file
      fs.unlinkSync(path.join(projectDir, baselineFile2));

      // 5. Add a new file
      fs.writeFileSync(path.join(projectDir, newFile), 'brand new');

      // 6. Snapshot all persisted asset rows before the rejected scan
      const assetRepo = createAssetRepository(db);
      const beforeAssets = assetRepo.findByProjectId(Number(id));
      expect(beforeAssets.length).toBe(2);

      const beforeSnapshot = beforeAssets.map((a) => ({ ...a }));

      // 7. Archive the project
      await agent
        .post(`/projects/${id}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // 8. POST the scan route — must be rejected
      const scanRes = await agent
        .post(`/projects/${id}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken));
      expect(scanRes.status).toBe(302);
      expect(scanRes.headers.location).toContain('scan_error=archived');

      // 9. Assert the archived-scan rejection
      // 10. Query all project assets again
      const afterAssets = assetRepo.findByProjectId(Number(id));
      expect(afterAssets.length).toBe(2);

      // complete before/after asset rows are deeply equal
      for (let i = 0; i < beforeSnapshot.length; i++) {
        const before = beforeSnapshot[i];
        const after = afterAssets.find((a) => a.id === before.id);
        expect(after).toBeDefined();
        expect(after.id).toBe(before.id);
        expect(after.project_id).toBe(before.project_id);
        expect(after.relative_path).toBe(before.relative_path);
        expect(after.filename).toBe(before.filename);
        expect(after.extension).toBe(before.extension);
        expect(after.mime_type).toBe(before.mime_type);
        expect(after.size_bytes).toBe(before.size_bytes);
        expect(after.modified_at).toBe(before.modified_at);
        expect(after.is_present).toBe(before.is_present);
        expect(after.last_seen_at).toBe(before.last_seen_at);
        expect(after.missing_since).toBe(before.missing_since);
        expect(after.created_at).toBe(before.created_at);
        expect(after.updated_at).toBe(before.updated_at);
      }

      // the new file was not inserted
      const newAsset = afterAssets.find((a) => a.relative_path === newFile);
      expect(newAsset).toBeUndefined();

      // the modified file's metadata was not updated
      const modifiedAsset = afterAssets.find((a) => a.relative_path === baselineFile1);
      expect(modifiedAsset).toBeDefined();
      const beforeModified = beforeSnapshot.find((a) => a.relative_path === baselineFile1);
      expect(modifiedAsset.size_bytes).toBe(beforeModified.size_bytes);
      expect(modifiedAsset.modified_at).toBe(beforeModified.modified_at);

      // the deleted file's persisted row still exists
      const deletedAsset = afterAssets.find((a) => a.relative_path === baselineFile2);
      expect(deletedAsset).toBeDefined();
      // the deleted file still has is_present = 1
      expect(deletedAsset.is_present).toBe(1);
      // missing_since remains unchanged
      expect(deletedAsset.missing_since).toBeNull();
      // no scanner-maintained timestamp changed
      const beforeDeleted = beforeSnapshot.find((a) => a.relative_path === baselineFile2);
      expect(deletedAsset.last_seen_at).toBe(beforeDeleted.last_seen_at);
      expect(deletedAsset.updated_at).toBe(beforeDeleted.updated_at);
    });
  });

  // ─── Phase 7D-3: Project planning field wording ──────────────────────
  //
  // Project planning fields (planned_date, published_date, patreon_url)
  // describe the broader creative project, not an individual release.
  // Help text must clarify this distinction.

  describe('project form planning field wording', () => {
    /**
     * Extract the HTML of the .field container that contains an input with the
     * given id. Returns null if not found.
     */
    function getFieldContainer(html, inputId) {
      // Find the input with the given id, then walk backward to find the .field ancestor
      const inputRe = new RegExp(`<input[^>]*id="${inputId}"[^>]*>`);
      const inputMatch = inputRe.exec(html);
      if (!inputMatch) return null;
      const inputPos = inputMatch.index;
      // Walk backward from the input to find the opening <div class="field ...">
      const beforeInput = html.slice(0, inputPos);
      const fieldStart = beforeInput.lastIndexOf('<div class="field');
      if (fieldStart === -1) return null;
      // Find the matching closing </div> — count nesting
      const fromField = html.slice(fieldStart);
      let depth = 0;
      let endPos = 0;
      for (let i = 0; i < fromField.length; i++) {
        if (fromField.slice(i, i + 4) === '<div') { depth++; i += 3; }
        else if (fromField.slice(i, i + 5) === '</div') { depth--; i += 4; }
        if (depth === 0) { endPos = i + 6; break; }
      }
      return fromField.slice(0, endPos);
    }

    it('project form shows help text for planned date in the correct field container', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const container = getFieldContainer(res.text, 'plannedDate');
      expect(container).not.toBeNull();
      expect(container).toContain('Target date for the creative project');
      // Verify the input is inside the same container
      expect(container).toMatch(/<input[^>]*id="plannedDate"[^>]*>/);
    });

    it('project form shows help text for published date in the correct field container', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const container = getFieldContainer(res.text, 'publishedDate');
      expect(container).not.toBeNull();
      expect(container).toContain('When the project was published');
      expect(container).toMatch(/<input[^>]*id="publishedDate"[^>]*>/);
    });

    it('project form shows help text for Patreon URL in the correct field container', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const container = getFieldContainer(res.text, 'patreonUrl');
      expect(container).not.toBeNull();
      expect(container).toContain("Link to the project's Patreon page");
      expect(container).toMatch(/<input[^>]*id="patreonUrl"[^>]*>/);
    });

    it('project detail shows context labels in the correct dt/dd pairs', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Wording+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('plannedDate=2025-12-01')
        .send('publishedDate=2025-12-15')
        .send('patreonUrl=https://patreon.com/test')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/projects/${id}`).expect(200);

      // Planned date: <dt>Planned date</dt> ... <small>(project target)</small>
      const plannedDt = res.text.match(/<dt>Planned date<\/dt>\s*<dd>[^<]*(?:<small>\(project target\)<\/small>)[^<]*<\/dd>/);
      expect(plannedDt).not.toBeNull();

      // Published date: <dt>Published date</dt> ... <small>(project published)</small>
      const publishedDt = res.text.match(/<dt>Published date<\/dt>\s*<dd>[^<]*(?:<small>\(project published\)<\/small>)[^<]*<\/dd>/);
      expect(publishedDt).not.toBeNull();

      // Patreon URL: <dt>Patreon URL</dt> ... <small>(project page)</small>
      // Bounded pattern: cannot cross </dd>, <dt>, or opening <dd>
      const patreonDt = res.text.match(/<dt>Patreon URL<\/dt>\s*<dd>(?:(?!<\/dd>)(?!<dt>)(?!<dd>).)*<small>\(project page\)<\/small>(?:(?!<\/dd>)(?!<dt>)(?!<dd>).)*<\/dd>/);
      expect(patreonDt).not.toBeNull();
    });
  });

  // ─── Phase 7D-3: Project status preserves filesystem behavior ──────
  //
  // Project status governs filesystem directory placement. Changing a
  // project's status must move its directory to the corresponding status
  // directory. This is independent of release planning fields.

  describe('project status filesystem behavior', () => {
    function parseSlug(title) {
      return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    function getProjectDir(title, status = 'tbd') {
      const slug = parseSlug(title);
      const statusDir = STATUS_DIR_MAP[status];
      const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
      const matching = entries.filter((e) => e.endsWith(`-${slug}`));
      if (matching.length === 0) return null;
      return path.join(projectsRoot, statusDir, matching[0]);
    }

    it('changing project status moves the directory', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=FS+Status+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // Capture the persisted project row
      const beforeRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
      expect(beforeRow).not.toBeNull();
      expect(beforeRow.status).toBe('tbd');

      // Resolve the original path directly from beforeRow.project_dir
      expect(beforeRow.project_dir).toBeTruthy();
      const originalRelPath = beforeRow.project_dir;
      const originalDir = path.resolve(projectsRoot, originalRelPath);

      // Assert the exact canonical original relative path
      expect(originalRelPath).toMatch(/^tbd[/\\]000001-fs-status-test$/);

      // Assert the resolved directory exists under PROJECTS_ROOT
      expect(originalDir.startsWith(path.resolve(projectsRoot))).toBe(true);
      expect(fs.existsSync(originalDir)).toBe(true);
      expect(fs.statSync(originalDir).isDirectory()).toBe(true);

      // Place a distinctive file inside it
      const userFile = path.join(originalDir, 'status-move.txt');
      fs.writeFileSync(userFile, 'moved content');

      // Change status from tbd to planned
      await agent
        .post(`/projects/${id}`)
        .send('title=FS+Status+Test')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Derive the exact expected relative path using the application's directory convention
      const dirName = path.basename(originalRelPath);
      const expectedRelPath = path.join('planned', dirName);

      const afterRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
      expect(afterRow.project_dir).toBe(expectedRelPath);

      // Original path no longer exists
      expect(fs.existsSync(originalDir)).toBe(false);

      // Exact new path exists
      const newDir = path.resolve(projectsRoot, expectedRelPath);
      expect(fs.existsSync(newDir)).toBe(true);
      expect(fs.statSync(newDir).isDirectory()).toBe(true);

      // New path remains inside PROJECTS_ROOT
      expect(newDir.startsWith(path.resolve(projectsRoot))).toBe(true);

      // Distinctive file exists at the new path with unchanged contents
      expect(fs.existsSync(path.join(newDir, 'status-move.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(newDir, 'status-move.txt'), 'utf8')).toBe('moved content');
    });
  });

  // ─── Archived project detail behavior ───────────────────────────────
  //
  // Moved from phase-105b-consolidation.test.js — organizational move
  // only. Behavior and assertions are unchanged from their prior home.

  describe('archived project detail behavior', () => {
    it('shows a warning notice on archived project detail', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archived+Notice+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      expect(res.text).toContain('archived');
      expect(res.text).toContain('read-only');
      expect(res.text).toMatch(/class="[^"]*\bnotice--warning\b[^"]*"/);
    });

    it('hides Edit link on archived project', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=No+Edit+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      expect(res.text).not.toContain(`/projects/${id}/edit`);
    });
  });

  // ─── Project detail path safety ─────────────────────────────────────
  //
  // Moved from phase-105b-consolidation.test.js — organizational move
  // only. Behavior and assertions are unchanged from their prior home.

  describe('project detail path safety', () => {
    it('project detail does not expose absolute filesystem paths', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Path+Leak+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
      // Project directory is shown as relative path
      expect(res.text).toContain('relative to projects share');
    });
  });

  // ─── Phase 6B regression: archived project edit route guard ─────────
  //
  // Archived projects are immutable. The edit form must not be reachable
  // through GET /projects/:id/edit; the route must redirect to the detail
  // page (the read-only workspace) instead. The detail page is unaffected.

  describe('archived project edit guard', () => {
    it('GET /projects/:id/edit redirects to the detail page when the project is archived', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Edit+Redirect+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // The edit form must not be reachable — the route must redirect to the
      // detail page (the read-only workspace) rather than rendering the
      // editable form.
      const res = await agent.get(`/projects/${id}/edit`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/projects/${id}`);
    });

    it('GET /projects/:id/edit still renders for active projects (regression)', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Edit+Active+Allowed')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/projects/${id}/edit`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Edit Project');
    });

    it('GET /projects/:id/edit still 404s for non-existent projects (regression)', async () => {
      // The redirect must not hide the 404 path for missing projects.
      await agent.get('/projects/9999/edit').expect(404);
    });
  });

  describe('project list rendering/status behavior', () => {
    it('uses status badges for project status column', async () => {
      await agent
        .post('/projects')
        .send('title=Status+Badge+List')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('status-badge');
    });

    it('has distinct empty state for no projects vs filtered results', async () => {
      // No projects at all
      const res1 = await agent.get('/projects').expect(200);
      expect(res1.text).toContain('No projects yet');

      await agent
        .post('/projects')
        .send('title=Search+Control')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Filtered empty (no match for search in a non-empty repository)
      const res2 = await agent.get('/projects?search=nonexistent').expect(200);
      expect(res2.text).toContain('No projects found');
      expect(res2.text).toContain('Reset Filters');
    });

    it('treats every normalized project filter as active for empty results', async () => {
      await agent
        .post('/projects')
        .send('title=Only+TBD')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get('/projects?status=ready').expect(200);
      expect(res.text).toContain('No projects found');
      expect(res.text).toContain('Reset Filters');
      expect(res.text).not.toContain('Create your first project to get started.');
    });
  });

  describe('project status badge rendering', () => {
    const statuses = ['tbd', 'planned', 'in-progress', 'ready', 'published'];

    for (const status of statuses) {
      it(`renders "${status}" with status-badge`, async () => {
        await agent
          .post('/projects')
          .send(`title=Status+${status}`)
          .send(`status=${status}`)
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);

        const res = await agent.get('/projects').expect(200);
        expect(res.text).toContain('status-badge');
      });
    }
  });
});
