/**
 * Structural parity tests: /releases/:id/assets vs /projects/:id/assets.
 *
 * Both pages use the same asset-browser-layout shell, the same grid/list
 * card macros from asset-presentation.njk, and the same view-switcher and
 * page-size-form contracts.  These tests verify the structural contract at
 * the rendered-DOM level so that a drift in either template is caught.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset-browser structural parity: releases vs projects', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let agent;
  let csrfToken;

  // Shared fixture state
  let projectId;
  let releaseLocation;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-parity-'));
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

    // Create project with scanned assets
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Parity+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    projectId = projRes.headers.location.replace('/projects/', '');

    const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
    const slug = 'parity-test-project';
    const matching = entries.filter((e) => e.endsWith(`-${slug}`));
    const projectDir = path.join(projectsRoot, 'tbd', matching[0]);
    fs.writeFileSync(path.join(projectDir, 'alpha.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'beta.txt'), 'txt');
    await agent
      .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    // Create release for this project
    const relRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Parity+Test+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    releaseLocation = relRes.headers.location;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Browser shell ──────────────────────────────────────────────────────

  describe('browser shell contract', () => {
    it('both pages render asset-browser-layout wrapping asset-browser-content', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toContain('class="asset-browser-layout"');
        expect(html).toContain('class="asset-browser-content"');
        expect(html.indexOf('asset-browser-layout')).toBeLessThan(html.indexOf('asset-browser-content'));
      }
    });

    it('both pages render a view-switcher nav inside the browser shell', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toMatch(/<nav class="view-switcher"/);
        expect(html.indexOf('asset-browser-content')).toBeLessThan(html.indexOf('view-switcher'));
      }
    });

    it('filter form is inside asset-browser-content on both pages', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        const contentStart = html.indexOf('asset-browser-content');
        expect(contentStart).toBeGreaterThan(-1);
        const filterPos = html.indexOf('class="filters');
        expect(filterPos).toBeGreaterThan(contentStart);
      }
    });
  });

  // ── Grid view contract ─────────────────────────────────────────────────

  describe('grid view card structure', () => {
    it('both pages use <ul class="asset-grid" role="listbox"> as the grid wrapper', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toMatch(/<ul class="asset-grid" role="listbox"/);
      }
    });

    it('both pages wrap each grid card in <li class="asset-grid-item">', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toContain('class="asset-grid-item"');
      }
    });

    it('both pages render <article class="asset-card" ...> inside each grid item', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toMatch(/<article class="asset-card[^"]*"\s+data-asset-id="\d+"/);
      }
    });

    it('asset-card-top, asset-card-media, asset-card-body appear on both pages', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toContain('class="asset-card-top"');
        expect(html).toContain('class="asset-card-media');
        expect(html).toContain('class="asset-card-body"');
        expect(html).toContain('class="asset-card-title-controls"');
        expect(html).toContain('class="asset-card-title-row"');
      }
    });

    it('grid cards on both pages carry role="option" and aria-selected', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toMatch(/role="option" aria-selected="(true|false)"/);
      }
    });
  });

  // ── List view contract ─────────────────────────────────────────────────

  describe('list view card structure', () => {
    it('both pages use <ul class="asset-list ..."> with role="list" as the list wrapper', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?view=list`).expect(200),
        agent.get(`${releaseLocation}/assets?view=list`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toMatch(/<ul class="asset-list[^"]*" role="list"/);
      }
    });

    it('both pages wrap each list card in <li class="asset-list-item">', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?view=list`).expect(200),
        agent.get(`${releaseLocation}/assets?view=list`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toContain('class="asset-list-item"');
      }
    });

    it('both pages render <article class="asset-list-card ..."> inside each list item', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?view=list`).expect(200),
        agent.get(`${releaseLocation}/assets?view=list`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toMatch(/<article class="asset-list-card[^"]*" data-asset-id="\d+"/);
      }
    });

    it('list card structural regions appear on both pages', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?view=list`).expect(200),
        agent.get(`${releaseLocation}/assets?view=list`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toContain('class="asset-list-card-media');
        expect(html).toContain('class="asset-list-card-body"');
      }
    });
  });

  // ── Page-size form contract ────────────────────────────────────────────

  describe('page-size-form contract', () => {
    // Use pageSize=1 so both pages have pageCount > 1 and render the form
    it('both pages render <form class="page-size-form"> when there are multiple pages', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?pageSize=1`).expect(200),
        agent.get(`${releaseLocation}/assets?pageSize=1`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        expect(html).toContain('class="page-size-form"');
      }
    });

    it('both pages render a <select id="pageSize"> inside the page-size-form', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?pageSize=1`).expect(200),
        agent.get(`${releaseLocation}/assets?pageSize=1`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        const pageSizeFormStart = html.indexOf('page-size-form');
        expect(pageSizeFormStart).toBeGreaterThan(-1);
        const formSection = html.slice(pageSizeFormStart, pageSizeFormStart + 200);
        expect(formSection).toContain('id="pageSize"');
      }
    });

    it('page-size select includes value="10" on both pages', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?pageSize=1`).expect(200),
        agent.get(`${releaseLocation}/assets?pageSize=1`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        const pageSizeFormStart = html.indexOf('page-size-form');
        expect(pageSizeFormStart).toBeGreaterThan(-1);
        const formSection = html.slice(pageSizeFormStart, pageSizeFormStart + 600);
        expect(formSection).toContain('value="10"');
      }
    });
  });

  // ── Pagination link contract ───────────────────────────────────────────

  describe('pagination link contract', () => {
    it('pagination uses <a class="pagination-prev/next"> links, not buttons, on both pages', async () => {
      // Need enough assets to produce a second page — use pageSize=1
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?pageSize=1`).expect(200),
        agent.get(`${releaseLocation}/assets?pageSize=1`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        if (html.includes('pagination-next')) {
          expect(html).toMatch(/<a [^>]*class="pagination-next"/);
          expect(html).not.toMatch(/<button [^>]*class="pagination-next"/);
        }
        if (html.includes('pagination-prev')) {
          expect(html).toMatch(/<a [^>]*class="pagination-prev"/);
          expect(html).not.toMatch(/<button [^>]*class="pagination-prev"/);
        }
      }
    });
  });

  // ── Selection control location contract ───────────────────────────────

  describe('selection control contract', () => {
    it('grid card checkbox is inside asset-card-top on both pages', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        const topStart = html.indexOf('class="asset-card-top"');
        const checkboxPos = html.indexOf('class="asset-select-checkbox"');
        const topEnd = html.indexOf('class="asset-card-media', topStart);
        if (checkboxPos > -1 && topStart > -1 && topEnd > -1) {
          expect(checkboxPos).toBeGreaterThan(topStart);
          expect(checkboxPos).toBeLessThan(topEnd);
        }
      }
    });

    it('list card checkbox is inside asset-list-card-top on both pages', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?view=list`).expect(200),
        agent.get(`${releaseLocation}/assets?view=list`).expect(200),
      ]);
      for (const html of [proj.text, rel.text]) {
        const topStart = html.indexOf('class="asset-list-card-top"');
        const checkboxPos = html.indexOf('class="asset-select-checkbox"');
        const topEnd = html.indexOf('class="asset-list-card-media', topStart);
        if (checkboxPos > -1 && topStart > -1 && topEnd > -1) {
          expect(checkboxPos).toBeGreaterThan(topStart);
          expect(checkboxPos).toBeLessThan(topEnd);
        }
      }
    });
  });

  // ── Release-specific extensions stay contained ─────────────────────────

  describe('release-specific extensions do not break base geometry', () => {
    it('release grid card has same top-level article class prefix as project grid card', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets`).expect(200),
        agent.get(`${releaseLocation}/assets`).expect(200),
      ]);
      // Both must open with class="asset-card"
      expect(proj.text).toMatch(/<article class="asset-card[^"]*"/);
      expect(rel.text).toMatch(/<article class="asset-card[^"]*"/);
    });

    it('release list card has same top-level article class prefix as project list card', async () => {
      const [proj, rel] = await Promise.all([
        agent.get(`/projects/${projectId}/assets?view=list`).expect(200),
        agent.get(`${releaseLocation}/assets?view=list`).expect(200),
      ]);
      expect(proj.text).toMatch(/<article class="asset-list-card[^"]*"/);
      expect(rel.text).toMatch(/<article class="asset-list-card[^"]*"/);
    });

    it('release grid view does not introduce nested forms', async () => {
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      if (assets.length > 0) {
        // Select an asset so controls appear
        await agent
          .post(`${releaseLocation}/assets`)
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`selectedAssetIds[]=${assets[0].id}`)
          .send('roles[]=primary')
          .send('sortOrder[]=0')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      // No <form> should appear inside another <form>
      let depth = 0;
      let maxNested = 0;
      for (const token of res.text.matchAll(/<\/?form[\s>]/g)) {
        if (token[0].startsWith('</')) {
          depth = Math.max(0, depth - 1);
        } else {
          depth++;
          maxNested = Math.max(maxNested, depth);
        }
      }
      expect(maxNested).toBeLessThanOrEqual(1);
    });
  });
});
