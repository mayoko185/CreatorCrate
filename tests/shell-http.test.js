/**
 * Phase 10.4A — application-shell HTTP tests.
 *
 * Verifies the rendered shell: navigation destinations, route-aware active
 * state, document title, single-<h1> invariant, preserved body classes,
 * icon presence, and the no-active rule on controlled not-found pages.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const APP_NAME = 'CreatorCrate';

/** Keys of the nav items marked active, in document order (desktop only). */
function activeNavKeys(html) {
  const re = /class="app-nav-link" data-nav-key="([^"]+)" aria-current="page"/g;
  const keys = [];
  let m;
  while ((m = re.exec(html)) !== null) keys.push(m[1]);
  return keys;
}

/** Count active desktop nav links only (scoped to class="app-nav-link"). */
function countActive(html) {
  return (html.match(/class="app-nav-link" data-nav-key="[^"]+" aria-current="page"/g) || []).length;
}

/** hrefs of every rendered nav link, in document order. */
function navHrefs(html) {
  const re = /<a href="([^"]+)" class="app-nav-link"/g;
  const hrefs = [];
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

/** Count opening <h1> tags. */
function countH1(html) {
  return (html.match(/<h1[\s>]/g) || []).length;
}

/** Count decorative icons rendered in the shell (brand svg has no aria-hidden). */
function countNavIcons(html) {
  return (html.match(/aria-hidden="true"/g) || []).length;
}

describe('application shell — navigation model', () => {
  let db;
  let app;
  let agent;
  let csrfToken;
  let tmpDir;
  let projectsRoot;
  let projectId;
  let assetId;
  let releaseLocation;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shell-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: APP_NAME, db, projectsRoot }, { authConfig: AUTH_CONFIG });

    const auth = await authenticate(app);
    agent = auth.agent;
    csrfToken = auth.csrfToken;

    // A project with one scanned asset, for browser/viewer routes.
    const projRes = await agent
      .post('/projects')
      .type('form')
      .send({ title: 'Shell Test Project', status: 'tbd', priority: 'normal', _csrf: csrfToken })
      .expect(302);
    projectId = projRes.headers.location.replace('/projects/', '');

    const slug = slugify('Shell Test Project', { lowercase: true });
    const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
    const dirName = entries.find((e) => e.endsWith(`-${slug}`));
    fs.writeFileSync(
      path.join(projectsRoot, 'tbd', dirName, 'cover.png'),
      Buffer.from('png'),
    );
    await agent.post(`/projects/${projectId}/scan`).type('form').send({ _csrf: csrfToken }).expect(302);
    const assetRepo = createAssetRepository(db);
    assetId = String(assetRepo.findByProjectId(Number(projectId))[0].id);

    // A release, for release routes.
    const relRes = await agent
      .post('/releases')
      .type('form')
      .send({ projectId, title: 'Shell Test Release', status: 'idea', _csrf: csrfToken })
      .expect(302);
    releaseLocation = relRes.headers.location;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('destinations', () => {
    it('renders only existing top-level destinations', async () => {
      const res = await agent.get('/').expect(200);
      expect(navHrefs(res.text)).toEqual(['/', '/projects', '/releases', '/settings']);
    });

    it('renders a decorative icon for every nav item', async () => {
      const res = await agent.get('/').expect(200);
      expect(countNavIcons(res.text)).toBe(4);
      expect(res.text).toContain('aria-hidden="true"');
    });
  });

  describe('active state — dashboard', () => {
    it('marks only Dashboard active on /', async () => {
      const res = await agent.get('/').expect(200);
      expect(activeNavKeys(res.text)).toEqual(['dashboard']);
      expect(countActive(res.text)).toBe(1);
    });
  });

  describe('active state — projects family', () => {
    it('marks Projects active on the project list', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(activeNavKeys(res.text)).toEqual(['projects']);
      expect(countActive(res.text)).toBe(1);
    });

    it('marks Projects active on project detail', async () => {
      const res = await agent.get(`/projects/${projectId}`).expect(200);
      expect(activeNavKeys(res.text)).toEqual(['projects']);
    });

    it('marks Projects active on project edit', async () => {
      const res = await agent.get(`/projects/${projectId}/edit`).expect(200);
      expect(activeNavKeys(res.text)).toEqual(['projects']);
    });

    it('marks Projects active on the asset browser', async () => {
      const res = await agent.get(`/projects/${projectId}/assets`).expect(200);
      expect(activeNavKeys(res.text)).toEqual(['projects']);
    });

    it('marks Projects active on the asset viewer', async () => {
      const res = await agent.get(`/projects/${projectId}/assets/${assetId}`)
        .expect(200);
      expect(activeNavKeys(res.text)).toEqual(['projects']);
    });
  });

  describe('active state — releases family', () => {
    it('marks Releases active on the release list', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(activeNavKeys(res.text)).toEqual(['releases']);
      expect(countActive(res.text)).toBe(1);
    });

    it('marks Releases active on release detail', async () => {
      const res = await agent.get(releaseLocation).expect(200);
      expect(activeNavKeys(res.text)).toEqual(['releases']);
    });
  });

  describe('active state — prefix safety', () => {
    it('does not activate Projects for a sibling prefix like /projects-old', async () => {
      const res = await agent.get('/projects-old').expect(404);
      expect(activeNavKeys(res.text)).toEqual([]);
      expect(countActive(res.text)).toBe(0);
    });
  });

  describe('active state — controlled not-found', () => {
    it('marks no item active on a missing project record', async () => {
      const res = await agent.get('/projects/999999').expect(404);
      expect(activeNavKeys(res.text)).toEqual([]);
      expect(countActive(res.text)).toBe(0);
    });

    it('marks no item active on a missing release record', async () => {
      const res = await agent.get('/releases/999999').expect(404);
      expect(activeNavKeys(res.text)).toEqual([]);
      expect(countActive(res.text)).toBe(0);
    });
  });

  describe('page-title and heading contract', () => {
    it('the document title is present and correct on the dashboard', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain(`<title>${APP_NAME}</title>`);
    });

    it('the shell brand is not an <h1> (no duplicate page heading)', async () => {
      const res = await agent.get('/').expect(200);
      // Exactly one h1, supplied by the page template — the shell adds none.
      expect(countH1(res.text)).toBe(1);
    });

    it('project pages still render exactly one <h1>', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(countH1(res.text)).toBe(1);
    });

    it('asset viewer customizes the document title via its title block', async () => {
      const res = await agent.get(`/projects/${projectId}/assets/${assetId}`)
        .expect(200);
      // Separator-agnostic: title must include the filename and the app name,
      // and must not collapse to the bare app-name default.
      expect(res.text).toMatch(/<title>[^<]*cover\.png[^<]*CreatorCrate<\/title>/);
      expect(res.text).not.toContain('<title>CreatorCrate</title>');
      expect(countH1(res.text)).toBe(1);
    });
  });

  describe('body-class preservation', () => {
    it('the asset-browser body class remains available', async () => {
      const res = await agent.get(`/projects/${projectId}/assets`)
        .expect(200);
      expect(res.text).toContain('asset-browser-page');
    });

    it('the asset-viewer body class remains available', async () => {
      const res = await agent.get(`/projects/${projectId}/assets/${assetId}`)
        .expect(200);
      expect(res.text).toContain('asset-viewer-page');
    });
  });
});
