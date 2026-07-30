/**
 * Phase 10.5B — Visual consolidation of dashboard and project pages.
 *
 * Verifies:
 *  - Project list action hierarchy
 *  - Archived project asset page notice
 *  - Asset browser shared page heading
 *  - Asset viewer shared page heading and action hierarchy
 *  - One <h1> per page
 *  - Contextual empty states
 *
 * Asset-viewer/browser and archived-asset-page tests remain here until a
 * dedicated asset test owner exists. Other cases previously covered here
 * have moved to projects-http.test.js and dashboard-http.test.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function countTags(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'g');
  return (html.match(re) || []).length;
}

function hasClass(html, className) {
  const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`);
  return re.test(html);
}

async function makePng(width = 64, height = 64) {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 80, g: 120, b: 200 },
    },
  }).png().toBuffer();
}

describe('Phase 10.5B: Dashboard and project visual consolidation', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-105b-'));
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

  // ─── 6. Archived notice ──────────────────────────────────────────────

  describe('archived project notice', () => {
    it('archived project asset page shows archived notice', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archived+Asset+Notice')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(res.text).toContain('archived');
      expect(res.text).toContain('read-only');
    });
  });

  // ─── 9. Asset browser shared heading ────────────────────────────────

  describe('asset browser shared heading', () => {
    it('has page-heading with project title', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Asset+Heading+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/projects/${id}/assets`).expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(res.text).toContain('Assets — Asset Heading Test');
      expect(countTags(res.text, 'h1')).toBe(1);
    });
  });

  // ─── 10. Viewer action hierarchy ────────────────────────────────────

  describe('asset viewer shared heading', () => {
    it('has page-heading with filename and required viewer contract', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Viewer+Heading+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const id = Number(projRes.headers.location.replace('/projects/', ''));
      const projectDir = path.join(projectsRoot, STATUS_DIR_MAP.tbd);
      const entries = fs.readdirSync(projectDir);
      const matching = entries.find(e => e.includes('viewer-heading-test'));
      fs.writeFileSync(path.join(projectDir, matching, 'viewer-contract.png'), await makePng());

      await agent.post(`/projects/${id}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const asset = db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(id, 'viewer-contract.png');
      expect(asset).toBeDefined();

      const viewerRes = await agent.get(`/projects/${id}/assets/${asset.id}`).expect(200);
      expect(hasClass(viewerRes.text, 'page-heading')).toBe(true);
      expect(countTags(viewerRes.text, 'h1')).toBe(1);
      expect(viewerRes.text).toContain('<h1>viewer-contract.png</h1>');
      expect(viewerRes.text).toContain('Asset preview, metadata, and release usage.');
      expect(viewerRes.text).toContain('asset-viewer-back');
      expect(viewerRes.text).toContain('asset-viewer-original');
      expect(viewerRes.text).toContain('<dl class="detail-list asset-metadata">');
      expect(viewerRes.text).toContain('class="asset-preview-image"');
    });
  });

  // ─── 11. Contextual empty states ────────────────────────────────────

  describe('contextual empty states', () => {
    it('dashboard empty attention uses empty-state', async () => {
      const res = await agent.get('/').expect(200);
      // Empty attention state uses the empty-state class
      expect(res.text).toContain('empty-state');
    });
  });

});
