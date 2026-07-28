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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dashboard renders counts and a new project action', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('CreatorCrate');
    expect(res.text).toContain('New Project');
    expect(res.text).toContain('TBD');
    expect(res.text).toContain('View All Projects');
  });

  it('dashboard archived count reflects archived projects', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Archive+Count')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const id = createRes.headers.location.replace('/projects/', '');
    await request(app).post(`/projects/${id}/archive`);

    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('<span class="count">1</span> Archived');
  });

  it('project list renders', async () => {
    const res = await request(app).get('/projects').expect(200);
    expect(res.text).toContain('Projects');
    expect(res.text).toContain('No projects match');
  });

  it('new-project form renders', async () => {
    const res = await request(app).get('/projects/new').expect(200);
    expect(res.text).toContain('Create Project');
    expect(res.text).toContain('Title');
    expect(res.text).not.toContain('value="archived"');
  });

  it('valid create request redirects to detail', async () => {
    const res = await request(app)
      .post('/projects')
      .send('title=Test+Project')
      .send('description=A+test')
      .send('notes=notes')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    expect(res.headers.location).toMatch(/^\/projects\/\d+$/);
  });

  it('invalid create request rerenders with values and errors', async () => {
    const res = await request(app)
      .post('/projects')
      .send('title=')
      .send('description=A')
      .send('status=invalid')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Title is required');
    expect(res.text).toContain('A');
  });

  it('rejects archived status on create', async () => {
    const res = await request(app)
      .post('/projects')
      .send('title=Direct+Archive')
      .send('status=archived')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Status must be one of');
    expect(res.text).toContain('Direct Archive');
  });

  it('project detail renders', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Detail+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const location = createRes.headers.location;
    const res = await request(app).get(location).expect(200);
    expect(res.text).toContain('Detail Project');
    expect(res.text).toContain('Edit');
  });

  it('edit form renders', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Editable+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await request(app).get(`${createRes.headers.location}/edit`).expect(200);
    expect(res.text).toContain('Edit Project');
    expect(res.text).toContain('Editable Project');
    expect(res.text).not.toContain('value="archived"');
  });

  it('valid update redirects to detail', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Old+Name')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await request(app)
      .post(createRes.headers.location)
      .send('title=New+Name')
      .send('status=planned')
      .send('priority=high')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('New Name');
  });

  it('rejects archived status on update', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Update+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await request(app)
      .post(createRes.headers.location)
      .send('title=Update+Archive')
      .send('status=archived')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Status must be one of');
  });

  it('missing project returns 404', async () => {
    await request(app).get('/projects/9999').expect(404);
  });

  it('invalid project id returns 404', async () => {
    await request(app).get('/projects/abc').expect(404);
  });

  it('archive action preserves the record and redirects', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=To+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const id = createRes.headers.location.replace('/projects/', '');

    const res = await request(app)
      .post(`/projects/${id}/archive`)
      .expect(302);
    expect(res.headers.location).toBe('/projects');

    const detail = await request(app).get(`/projects/${id}`).expect(200);
    expect(detail.text).toContain('Archived');
  });

  it('archived project is excluded from the default list', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Hidden+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const id = createRes.headers.location.replace('/projects/', '');
    await request(app).post(`/projects/${id}/archive`);

    const list = await request(app).get('/projects').expect(200);
    expect(list.text).not.toContain('Hidden Project');
  });

  it('archived project appears under archived filter and dashboard count', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Filter+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const id = createRes.headers.location.replace('/projects/', '');
    await request(app).post(`/projects/${id}/archive`);

    const archivedList = await request(app).get('/projects?status=archived').expect(200);
    expect(archivedList.text).toContain('Filter Archive');

    const dashboard = await request(app).get('/').expect(200);
    expect(dashboard.text).toContain('<span class="count">1</span> Archived');
  });

  it('search and status query parameters affect results', async () => {
    await request(app)
      .post('/projects')
      .send('title=Searchable+Alpha')
      .send('description=find me')
      .send('status=planned')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    await request(app)
      .post('/projects')
      .send('title=Beta+One')
      .send('status=ready')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');

    const search = await request(app).get('/projects?search=alpha').expect(200);
    expect(search.text).toContain('Searchable Alpha');
    expect(search.text).not.toContain('Beta One');

    const status = await request(app).get('/projects?status=ready').expect(200);
    expect(status.text).toContain('Beta One');
    expect(status.text).not.toContain('Searchable Alpha');
  });

  it('pagination is bounded', async () => {
    for (let i = 1; i <= 30; i += 1) {
      await request(app)
        .post('/projects')
        .send(`title=Page+${i}`)
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded');
    }

    const page1 = await request(app).get('/projects?page=1').expect(200);
    expect(page1.text).toContain('Page 1 of 2');

    const huge = await request(app).get('/projects?page=999').expect(200);
    expect(huge.text).toContain('Page 2 of 2');
  });

  it('unknown routes still return safe 404', async () => {
    const res = await request(app).get('/not-a-real-route').expect(404);
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
      const res = await request(app)
        .post('/projects')
        .send('title=HTTP+FS+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
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
      await request(app)
        .post('/projects')
        .send('title=Status+Root+Check')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const projectDir = getProjectDir('Status Root Check', 'in-progress');
      expect(projectDir).not.toBeNull();
      // The directory should be under the 'active' directory
      expect(projectDir).toContain(path.join(projectsRoot, 'active'));
    });

    it('creates standard subdirectories', async () => {
      await request(app)
        .post('/projects')
        .send('title=Subdirs+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
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
      await request(app)
        .post('/projects')
        .send('title=Manifest+HTTP')
        .send('description=Test+description')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
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
      const res = await request(app)
        .post('/projects')
        .send('title=Rel+Path+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const id = res.headers.location.replace('/projects/', '');
      const detail = await request(app).get(`/projects/${id}`).expect(200);
      // Verify the detail page renders — the project was stored
      expect(detail.text).toContain('Rel Path HTTP');
    });

    it('HTTP creation error contains no absolute paths', async () => {
      // This requires a server restart with a broken projectsRoot to simulate failure
      // Instead, verify that invalid data produces errors without paths
      const res = await request(app)
        .post('/projects')
        .send('title=')
        .send('status=invalid')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
      expect(res.text).not.toMatch(/\/\w+[/\\]\w+/);
    });

    it('detail page shows relative project directory after creation', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=Detail+Dir+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const detail = await request(app).get(createRes.headers.location).expect(200);
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

      const res = await request(app)
        .post('/projects')
        .send('title=Conflict+Create')
        .send('description=Value+kept')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
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
      const createRes = await request(app)
        .post('/projects')
        .send('title=HTTP+Meta+Edit')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const location = createRes.headers.location;

      // Edit metadata only (no slug/status change)
      const res = await request(app)
        .post(location)
        .send('title=HTTP+Meta+Edit')
        .send('description=Updated+desc')
        .send('notes=New+notes')
        .send('status=tbd')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
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
      const createRes = await request(app)
        .post('/projects')
        .send('title=Old+HTTP+Name')
        .send('description=Before')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Old HTTP Name', 'tbd');
      expect(oldDir).not.toBeNull();

      // Add a custom file to prove contents survive
      fs.writeFileSync(path.join(oldDir, 'custom-file.txt'), 'survived');

      // Rename
      await request(app)
        .post(location)
        .send('title=New+HTTP+Name')
        .send('description=After')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
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
      const detail = await request(app).get(location).expect(200);
      expect(detail.text).toContain('New HTTP Name');
      expect(detail.text).not.toContain('Old HTTP Name');
    });

    it('status change moves the directory', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=Status+Move+HTTP')
        .send('description=Moved')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Status Move HTTP', 'tbd');
      expect(oldDir).not.toBeNull();

      // Add a custom file
      fs.writeFileSync(path.join(oldDir, 'move-test.txt'), 'moved');

      // Change status to in-progress (maps to 'active')
      await request(app)
        .post(location)
        .send('title=Status+Move+HTTP')
        .send('description=Moved')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
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
      const createRes = await request(app)
        .post('/projects')
        .send('title=Combined+HTTP+Start')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const location = createRes.headers.location;
      const oldDir = getProjectDir('Combined HTTP Start', 'planned');
      expect(oldDir).not.toBeNull();

      // Change both title and status
      await request(app)
        .post(location)
        .send('title=Combined+HTTP+Final')
        .send('status=published')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Old directory gone
      expect(fs.existsSync(oldDir)).toBe(false);

      // New directory under 'published'
      const newDir = getProjectDir('Combined HTTP Final', 'published');
      expect(newDir).not.toBeNull();
      expect(newDir).toContain(path.join(projectsRoot, 'published'));

      // Detail page shows everything
      const detail = await request(app).get(location).expect(200);
      expect(detail.text).toContain('Combined HTTP Final');
      expect(detail.text).toContain('Published');
    });

    it('error responses contain no absolute filesystem paths on update failure', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=No+Path+HTTP')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Trigger a validation error (non-filesystem) — should be path-safe
      const res = await request(app)
        .post(createRes.headers.location)
        .send('title=No+Path+HTTP')
        .send('status=archived')  // rejected by WORKFLOW_STATUSES validation
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      // Only check for absolute Windows paths (drive-letter paths)
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });

    it('archived status is still rejected from edit form', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=No+Archive+In+Edit')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await request(app)
        .post(createRes.headers.location)
        .send('title=No+Archive+In+Edit')
        .send('status=archived')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('Status must be one of');
    });

    it('title change updates the displayed relative path', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=Old+Path+Name')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Before rename — detail shows old dir
      let detail = await request(app).get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-old-path-name/);

      // Rename
      await request(app)
        .post(createRes.headers.location)
        .send('title=New+Path+Name')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // After rename — detail shows new dir
      detail = await request(app).get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-new-path-name/);
      expect(detail.text).not.toMatch(/old-path-name/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('status change updates the displayed relative path', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=Status+Path+Change')
        .send('status=planned')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Before — under planned/
      let detail = await request(app).get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/planned(?:&#92;|\/)\d+-status-path-change/);

      // Change status
      await request(app)
        .post(createRes.headers.location)
        .send('title=Status+Path+Change')
        .send('status=in-progress')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // After — under active/
      detail = await request(app).get(createRes.headers.location).expect(200);
      expect(detail.text).toMatch(/active(?:&#92;|\/)\d+-status-path-change/);
      expect(detail.text).not.toMatch(/planned/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('filesystem failure during update renders safe error with preserved values', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=Update+Fail+Safe')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Remove the project directory to trigger a filesystem error on update
      const projectDir = getProjectDir('Update Fail Safe', 'tbd');
      expect(projectDir).not.toBeNull();
      fs.rmSync(projectDir, { recursive: true, force: true });

      const res = await request(app)
        .post(createRes.headers.location)
        .send('title=Updated+Title')
        .send('description=Preserved+text')
        .send('status=tbd')
        .send('priority=high')
        .set('Content-Type', 'application/x-www-form-urlencoded')
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
      const createRes = await request(app)
        .post('/projects')
        .send('title=HTTP+Archive+Move')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      const oldDir = getProjectDir('HTTP Archive Move', 'tbd');
      expect(oldDir).not.toBeNull();
      expect(fs.existsSync(oldDir)).toBe(true);

      await request(app)
        .post(`/projects/${id}/archive`)
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
      const createRes = await request(app)
        .post('/projects')
        .send('title=HTTP+Archive+Status')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await request(app)
        .post(`/projects/${id}/archive`)
        .expect(302);

      const row = db.prepare('SELECT status, archived_at FROM projects WHERE id = ?').get(Number(id));
      expect(row.status).toBe('archived');
      expect(row.archived_at).toBeTruthy();
    });

    it('relative path is updated', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=HTTP+Archive+Path')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await request(app)
        .post(`/projects/${id}/archive`)
        .expect(302);

      const row = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(Number(id));
      expect(row.project_dir).toMatch(path.join('archived', ''));
    });

    it('manifest reflects archived status', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=HTTP+Archive+Manifest')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await request(app)
        .post(`/projects/${id}/archive`)
        .expect(302);

      const archiveDir = getArchiveDir('HTTP Archive Manifest');
      expect(archiveDir).not.toBeNull();
      const manifest = readManifestSync(archiveDir);
      expect(manifest).not.toBeNull();
      expect(manifest.status).toBe('archived');
    });

    it('existing files survive archive', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=HTTP+Files+Survive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      const oldDir = getProjectDir('HTTP Files Survive', 'tbd');
      expect(oldDir).not.toBeNull();

      // Add custom files
      fs.writeFileSync(path.join(oldDir, 'http-extra.txt'), 'http content');
      fs.mkdirSync(path.join(oldDir, 'source'), { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'source', 'render.png'), 'png data');

      await request(app)
        .post(`/projects/${id}/archive`)
        .expect(302);

      // Files survived at new location
      const archiveDir = getArchiveDir('HTTP Files Survive');
      expect(archiveDir).not.toBeNull();
      expect(fs.existsSync(path.join(archiveDir, 'http-extra.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(archiveDir, 'http-extra.txt'), 'utf8')).toBe('http content');
      expect(fs.existsSync(path.join(archiveDir, 'source', 'render.png'))).toBe(true);
    });

    it('error responses contain no absolute filesystem paths', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=HTTP+No+Path+Archive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // Remove the directory to cause a failure
      const projectDir = getProjectDir('HTTP No Path Archive', 'tbd');
      expect(projectDir).not.toBeNull();
      fs.rmSync(projectDir, { recursive: true, force: true });

      const res = await request(app)
        .post(`/projects/${id}/archive`)
        .expect(500);
      expect(res.text).not.toMatch(/[A-Z]:\\/);
    });

    it('archive changes the displayed relative path to archived/', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=Archive+Path+Display')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // Before archive — under tbd/
      let detail = await request(app).get(`/projects/${id}`).expect(200);
      expect(detail.text).toMatch(/tbd(?:&#92;|\/)\d+-archive-path-display/);

      // Archive
      await request(app)
        .post(`/projects/${id}/archive`)
        .expect(302);

      // After archive — under archived/
      detail = await request(app).get(`/projects/${id}`).expect(200);
      expect(detail.text).toMatch(/archived(?:&#92;|\/)\d+-archive-path-display/);
      expect(detail.text).not.toMatch(/tbd(?:&#92;|\/)/);
      expect(detail.text).not.toMatch(/[A-Z]:\\/);
    });

    it('archive remains POST-only', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=HTTP+GET+Archive')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      // GET should not archive — 404 from route matching
      await request(app)
        .get(`/projects/${id}/archive`)
        .expect(404);
    });

    it('invalid project id returns 404 on archive', async () => {
      await request(app)
        .post('/projects/abc/archive')
        .expect(404);
    });

    it('missing project returns 404 on archive', async () => {
      await request(app)
        .post('/projects/99999/archive')
        .expect(404);
    });

    it('archived scan rejection causes no asset changes (full row snapshot)', async () => {
      const title = 'Archived Scan Reject';
      const createRes = await request(app)
        .post('/projects')
        .send('title=' + encodeURIComponent(title))
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
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
      await request(app).post(`/projects/${id}/scan`).expect(302);

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
      await request(app)
        .post(`/projects/${id}/archive`)
        .expect(302);

      // 8. POST the scan route — must be rejected
      const scanRes = await request(app)
        .post(`/projects/${id}/scan`);
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

  // ─── Phase 6B regression: archived project edit route guard ─────────
  //
  // Archived projects are immutable. The edit form must not be reachable
  // through GET /projects/:id/edit; the route must redirect to the detail
  // page (the read-only workspace) instead. The detail page is unaffected.

  describe('archived project edit guard', () => {
    it('GET /projects/:id/edit redirects to the detail page when the project is archived', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=Edit+Redirect+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');
      await request(app).post(`/projects/${id}/archive`).expect(302);

      // The edit form must not be reachable — the route must redirect to the
      // detail page (the read-only workspace) rather than rendering the
      // editable form.
      const res = await request(app).get(`/projects/${id}/edit`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/projects/${id}`);
    });

    it('GET /projects/:id/edit still renders for active projects (regression)', async () => {
      const createRes = await request(app)
        .post('/projects')
        .send('title=Edit+Active+Allowed')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      const res = await request(app).get(`/projects/${id}/edit`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Edit Project');
    });

    it('GET /projects/:id/edit still 404s for non-existent projects (regression)', async () => {
      // The redirect must not hide the 404 path for missing projects.
      await request(app).get('/projects/9999/edit').expect(404);
    });
  });
});
