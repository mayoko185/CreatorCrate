/**
 * Phase 10.4A — application-shell HTTP tests.
 *
 * Verifies that authenticated HTTP pages consume the shared navigation model,
 * render route-aware current state, integrate route-specific titles, and apply
 * the no-active rule on controlled not-found pages.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
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

describe('application shell — navigation model', () => {
  let db;
  let app;
  let agent;
  let csrfToken;
  let tmpDir;
  let projectsRoot;
  let projectId;
  let assetId;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shell-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
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
    const entries = fs.readdirSync(projectsRoot);
    const dirName = entries.find((e) => e.endsWith(`-${slug}`));
    fs.writeFileSync(
      path.join(projectsRoot, dirName, 'cover.png'),
      Buffer.from('png'),
    );
    await agent.post(`/projects/${projectId}/scan`).type('form').send({ _csrf: csrfToken }).expect(302);
    const assetRepo = createAssetRepository(db);
    assetId = String(assetRepo.findByProjectId(Number(projectId))[0].id);
  });

  afterAll(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('destinations', () => {
    it('renders the shared top-level destinations with Dashboard current', async () => {
      const res = await agent.get('/').expect(200);
      expect(navHrefs(res.text)).toEqual([
        '/', '/projects', '/asset-viewer', '/releases', '/calendar', '/notes', '/settings',
      ]);
      expect(activeNavKeys(res.text)).toEqual(['dashboard']);
      expect(countActive(res.text)).toBe(1);
    });

    it('uses the canonical PNG branding in both navs and the favicon', async () => {
      const page = await agent.get('/').expect(200);
      expect(page.text).toContain('<img src="/logo.png" alt="" class="app-sidebar-logo">');
      expect(page.text).toContain('<img src="/logo.png" alt="" class="mobile-nav-logo">');
      expect(page.text).toContain('<link rel="icon" type="image/png" href="/logo.png">');
      expect(page.text).not.toContain('/logo.svg');

      const logo = await agent.get('/logo.png').expect(200);
      expect(logo.headers['content-type']).toMatch(/^image\/png(?:;|$)/);
      expect(logo.body).toBeInstanceOf(Buffer);
      expect(logo.body.length).toBeGreaterThan(0);
    });
  });

  describe('rendered active state', () => {
    it('marks a representative nested project route as Projects current', async () => {
      const res = await agent.get(`/projects/${projectId}/assets/${assetId}`)
        .expect(200);
      expect(activeNavKeys(res.text)).toEqual(['projects']);
      expect(countActive(res.text)).toBe(1);
    });

    it('marks the direct Asset Viewer destination current', async () => {
      const res = await agent.get('/asset-viewer').expect(200);
      expect(activeNavKeys(res.text)).toEqual(['assets']);
      expect(countActive(res.text)).toBe(1);
    });

    it('renders the Settings parent active with one current child', async () => {
      const res = await agent.get('/settings/security').expect(200);
      const children = res.text.match(/<ul class="app-nav-children">([\s\S]*?)<\/ul>/)?.[1] || '';

      expect(res.text).toContain(
        '<li class="app-nav-item app-nav-item--active app-nav-item--has-children">',
      );
      expect(children.match(/aria-current="page"/g) || []).toHaveLength(1);
      expect(children).toMatch(
        /<a\b(?=[^>]*\bclass="app-nav-child-link")(?=[^>]*\bdata-nav-key="settings-security")(?=[^>]*\baria-current="page")[^>]*>/,
      );
    });
  });

  describe('active state — controlled not-found', () => {
    it('renders the error title and marks no item active on a missing record', async () => {
      const res = await agent.get('/projects/999999').expect(404);
      expect(activeNavKeys(res.text)).toEqual([]);
      expect(countActive(res.text)).toBe(0);
      expect(res.text).toContain(`<title>${APP_NAME} — Error 404</title>`);
      expect(res.text).toContain('<h1 class="app-section-title">Error 404</h1>');
    });
  });

  describe('page-title and heading contract', () => {
    it('uses route-specific rendered headings for dynamic page titles', async () => {
      const cases = [
        { path: `/projects/${projectId}`, status: 200, heading: 'Projects — Shell Test Project' },
        {
          path: `/projects/${projectId}/assets/${assetId}`,
          status: 200,
          heading: 'Assets — Shell Test Project — cover.png',
        },
      ];

      for (const { path, status, heading } of cases) {
        const res = await agent.get(path).expect(status);
        expect(res.text).toContain(`<title>${APP_NAME} — ${heading}</title>`);
        expect(res.text).toContain(`<h1 class="app-section-title">${heading}</h1>`);
      }
    });
  });
});
