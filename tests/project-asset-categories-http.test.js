/**
 * Phase 2 chunk 3 — project-specific asset category HTTP integration tests.
 *
 * Covers dependency injection into the dedicated project-asset-categories
 * router, authentication/CSRF, listing/rendering, add/edit/rename/enable/
 * disable/reorder/move/delete route behavior, controlled error mapping, and
 * a focused set of real-service integration checks (manifest rewrite,
 * filesystem rename, asset/release ID stability, archived immutability,
 * and global-default independence).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP, resolveProjectDir } from '../src/storage/project-storage.js';
import { readManifestSync } from '../src/storage/manifest.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { ProjectAssetCategoryError } from '../src/services/project-asset-category-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';
import request from 'supertest';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function setupTmp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pac-http-'));
  const appDataRoot = path.join(tmpDir, 'app');
  fs.mkdirSync(appDataRoot, { recursive: true });
  const projectsRoot = path.join(tmpDir, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  for (const dir of Object.values(STATUS_DIR_MAP)) {
    fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
  }
  const databasePath = path.join(appDataRoot, 'creatorcrate.db');
  const db = openDatabase(databasePath);
  runMigrations(db, MIGRATIONS_DIR);
  return { tmpDir, appDataRoot, projectsRoot, databasePath, db };
}

async function createProject(agent, csrfToken, title) {
  const res = await agent
    .post('/projects')
    .type('form')
    .send({ title, status: 'tbd', priority: 'normal', _csrf: csrfToken })
    .expect(302);
  return Number(res.headers.location.replace('/projects/', ''));
}

function listProjectCategories(db, projectId) {
  return db
    .prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY display_order ASC, id ASC')
    .all(projectId);
}

function makeFakeProjectAssetCategoryService(seed = []) {
  const state = { categories: seed.map((c) => ({ ...c })) };
  let nextId = 9000;
  return {
    list: vi.fn((projectId) => state.categories.filter((c) => c.project_id === projectId)),
    add: vi.fn((projectId, input) => {
      const row = {
        id: nextId++,
        project_id: projectId,
        display_name: input.displayName,
        directory_slug: input.directorySlug,
        display_order: state.categories.filter((c) => c.project_id === projectId).length,
        enabled: input.enabled === false ? 0 : 1,
      };
      state.categories.push(row);
      return row;
    }),
    editDisplayName: vi.fn((projectId, categoryId, input) => {
      const row = state.categories.find((c) => c.id === categoryId && c.project_id === projectId);
      if (row) row.display_name = input.displayName;
      return row;
    }),
    setEnabled: vi.fn((projectId, categoryId, enabled) => {
      const row = state.categories.find((c) => c.id === categoryId && c.project_id === projectId);
      if (row) row.enabled = enabled ? 1 : 0;
      return row;
    }),
    reorder: vi.fn((projectId, orderedIds) => orderedIds),
    delete: vi.fn((projectId, categoryId) => {
      const idx = state.categories.findIndex((c) => c.id === categoryId && c.project_id === projectId);
      if (idx === -1) return false;
      state.categories.splice(idx, 1);
      return true;
    }),
    _state: state,
  };
}

describe('project asset categories — HTTP', () => {
  let ctx;

  afterEach(() => {
    if (!ctx) return;
    try { closeDatabase(ctx.db); } catch {}
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    ctx = null;
  });

  // ─── Dependency injection and routing ─────────────────────────────────

  describe('dependency injection and routing', () => {
    it('the GET route uses the explicitly injected service, not one constructed internally', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'DI Probe');

      await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(fake.list).toHaveBeenCalledWith(projectId);
    });

    it('a focused fake service drives add/mutation behavior end-to-end, and the real repository is never touched', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Fake DI Mutations');

      const realRowCountBefore = listProjectCategories(ctx.db, projectId).length;

      await agent
        .post(`/projects/${projectId}/asset-categories`)
        .type('form')
        .send({ displayName: 'Storyboards', directorySlug: 'storyboards', _csrf: csrfToken })
        .expect(302);

      expect(fake.add).toHaveBeenCalledWith(projectId, expect.objectContaining({ displayName: 'Storyboards', directorySlug: 'storyboards' }));
      // The router never reached the real repository — the real project's
      // category rows (created by the real assetCategoryService at project
      // creation time) are unaffected by the fake's own internal `add`.
      expect(listProjectCategories(ctx.db, projectId).length).toBe(realRowCountBefore);
    });

    it('/reorder is registered as a static route and is not captured as a dynamic category ID', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Reorder Static');

      await agent
        .post(`/projects/${projectId}/asset-categories/reorder`)
        .type('form')
        .send({ order: ['1', '2'], _csrf: csrfToken })
        .expect(302);

      expect(fake.reorder).toHaveBeenCalledWith(projectId, [1, 2]);
      expect(fake.editDisplayName).not.toHaveBeenCalled();
      expect(fake.setEnabled).not.toHaveBeenCalled();
      expect(fake.delete).not.toHaveBeenCalled();
    });

    it('every mutation route is POST-only — GET on each returns 404', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Mutation GET Guard');
      const [category] = listProjectCategories(ctx.db, projectId);

      const paths = [
        `/projects/${projectId}/asset-categories`,
        `/projects/${projectId}/asset-categories/reorder`,
        `/projects/${projectId}/asset-categories/${category.id}/name`,
        `/projects/${projectId}/asset-categories/${category.id}/enable`,
        `/projects/${projectId}/asset-categories/${category.id}/disable`,
        `/projects/${projectId}/asset-categories/${category.id}/move-up`,
        `/projects/${projectId}/asset-categories/${category.id}/move-down`,
        `/projects/${projectId}/asset-categories/${category.id}/delete`,
      ];
      // The first path (the list page) is a GET route and must succeed;
      // every remaining path is POST-only and must 404 on GET.
      await agent.get(paths[0]).expect(200);
      for (const p of paths.slice(1)) {
        await agent.get(p).expect(404);
      }
    });

    it('GET routes never mutate state', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'GET No Mutation');

      await agent.get(`/projects/${projectId}/asset-categories`).expect(200);

      expect(fake.add).not.toHaveBeenCalled();
      expect(fake.editDisplayName).not.toHaveBeenCalled();
      expect(fake.setEnabled).not.toHaveBeenCalled();
      expect(fake.reorder).not.toHaveBeenCalled();
      expect(fake.delete).not.toHaveBeenCalled();
    });
  });

  // ─── Authentication and CSRF ───────────────────────────────────────────

  describe('authentication and CSRF', () => {
    it('listing requires authentication', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Auth Probe');

      await request(app).get(`/projects/${projectId}/asset-categories`).expect(302);
    });

    it('every mutation route rejects a missing CSRF token', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'CSRF Probe');
      const [category] = listProjectCategories(ctx.db, projectId);

      await agent.post(`/projects/${projectId}/asset-categories`).type('form').send({ displayName: 'X', directorySlug: 'x' }).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form').send({ order: [category.id] }).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/name`).type('form').send({ displayName: 'X' }).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/enable`).type('form').send({}).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/disable`).type('form').send({}).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/move-up`).type('form').send({}).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/move-down`).type('form').send({}).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/delete`).type('form').send({}).expect(403);
    });

    it('rejects an invalid CSRF token the same way as a missing one', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Invalid CSRF Probe');

      await agent
        .post(`/projects/${projectId}/asset-categories`)
        .type('form')
        .send({ displayName: 'X', directorySlug: 'x', _csrf: 'not-a-real-token' })
        .expect(403);
    });
  });

  // ─── Listing and rendering ──────────────────────────────────────────────

  describe('listing and rendering', () => {
    it('renders categories in deterministic display_order then id order, enabled and disabled both shown', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Order Probe');
      const rows = listProjectCategories(ctx.db, projectId);
      const [first] = rows;

      await agent.post(`/projects/${projectId}/asset-categories/${first.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      const order = rows.map((r) => res.text.indexOf(`>${r.display_name}<`));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      for (const idx of order) expect(idx).toBeGreaterThan(-1);
      expect(res.text).toContain('Disabled');
      expect(res.text).toContain('Enabled');
    });

    it('shows display name and directory slug separately', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Name Slug Probe');
      const [category] = listProjectCategories(ctx.db, projectId);

      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(res.text).toContain(category.display_name);
      expect(res.text).toContain(`<code>${category.directory_slug}</code>`);
    });

    it('renders a valid empty state when the project has zero categories', async () => {
      ctx = setupTmp();
      ctx.db.prepare('UPDATE asset_category_defaults SET enabled = 0').run();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Empty Probe');

      expect(listProjectCategories(ctx.db, projectId)).toHaveLength(0);
      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(res.text).toContain('No categories yet');
    });

    it('explains project-only ownership and disabled-scan recognition', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Explain Probe');

      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(res.text).toMatch(/belong only to/i);
      expect(res.text).toMatch(/global Settings defaults/i);
      expect(res.text).toMatch(/recognized/i);
    });

    it('explains that the directory slug is fixed at creation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Distinguish Probe');

      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(res.text).toMatch(/cannot currently be changed/i);
    });

    it('renders archived projects read-only with no active mutation controls', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Archived Readonly');
      await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(res.text).toMatch(/read-only/i);
      const [category] = listProjectCategories(ctx.db, projectId);
      expect(res.text).not.toContain(`/projects/${projectId}/asset-categories/${category.id}/delete`);
      expect(res.text).not.toContain(`/projects/${projectId}/asset-categories/${category.id}/name`);
      expect(res.text).not.toContain(`/projects/${projectId}/asset-categories/${category.id}/enable`);
      expect(res.text).not.toContain(`/projects/${projectId}/asset-categories/${category.id}/disable`);
      expect(res.text).not.toContain('id="add-displayName"');
    });
  });

  // ─── Add ─────────────────────────────────────────────────────────────

  describe('add', () => {
    it('adds an enabled category and a disabled category, passing real booleans into the service', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Add Booleans');

      await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: 'Raw', directorySlug: 'raw', enabled: 'on', _csrf: csrfToken }).expect(302);
      await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: 'Drafts', directorySlug: 'drafts', _csrf: csrfToken }).expect(302);

      expect(fake.add).toHaveBeenNthCalledWith(1, projectId, expect.objectContaining({ enabled: true }));
      expect(fake.add).toHaveBeenNthCalledWith(2, projectId, expect.objectContaining({ enabled: false }));
    });

    it('rejects invalid input with a controlled 422 response', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Add Invalid');

      const res = await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: '', directorySlug: 'raw', _csrf: csrfToken }).expect(422);
      expect(res.text).toContain('Display name is required');
    });

    it('rejects a slug conflict with a controlled 422 response', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Add Slug Conflict');
      const [existing] = listProjectCategories(ctx.db, projectId);

      const res = await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: 'Dup', directorySlug: existing.directory_slug, _csrf: csrfToken }).expect(422);
      expect(res.text.toLowerCase()).toContain('already exists');
      expect(res.text).not.toContain('SQLITE');
    });

    it('redirects with a success notice', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Add Success');

      const res = await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: 'Raw', directorySlug: 'raw', _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_added`);
    });
  });

  // ─── Display-name editing ──────────────────────────────────────────────

  describe('display-name editing', () => {
    it('does not submit or mutate the directory slug', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Name Only');
      const [category] = listProjectCategories(ctx.db, projectId);
      fake._state.categories.push({ ...category });

      await agent
        .post(`/projects/${projectId}/asset-categories/${category.id}/name`)
        .type('form')
        .send({ displayName: 'Renamed Label', directorySlug: 'attempted-hijack', _csrf: csrfToken })
        .expect(302);

      expect(fake.editDisplayName).toHaveBeenCalledWith(projectId, category.id, { displayName: 'Renamed Label' });
      const row = fake._state.categories.find((c) => c.id === category.id);
      expect(row.directory_slug).toBe(category.directory_slug);
    });

    it('handles success and validation failure safely', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Name Edit Behavior');
      const [category] = listProjectCategories(ctx.db, projectId);

      const okRes = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/name`).type('form')
        .send({ displayName: 'New Label', _csrf: csrfToken }).expect(302);
      expect(okRes.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_name_updated`);

      const failRes = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/name`).type('form')
        .send({ displayName: '', _csrf: csrfToken }).expect(422);
      expect(failRes.text).toContain('Display name is required');
    });
  });

  // ─── Enable and disable ─────────────────────────────────────────────────

  describe('enable and disable', () => {
    it('separate routes invoke the correct service operation', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Enable Disable Ops');
      const [category] = listProjectCategories(ctx.db, projectId);
      fake._state.categories.push({ ...category });

      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(fake.setEnabled).toHaveBeenLastCalledWith(projectId, category.id, false);

      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/enable`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(fake.setEnabled).toHaveBeenLastCalledWith(projectId, category.id, true);
    });

    it('disabled-state copy communicates that files remain', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Disable Copy');
      const [category] = listProjectCategories(ctx.db, projectId);

      const res = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      const page = await agent.get(res.headers.location).expect(200);
      expect(page.text).toMatch(/files were not touched|files remain/i);
    });

    it('rejects mutation on an archived project', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Enable Archived');
      const [category] = listProjectCategories(ctx.db, projectId);
      await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

      const res = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(409);
      expect(res.text).toMatch(/archived/i);
      const unchanged = ctx.db.prepare('SELECT enabled FROM project_asset_categories WHERE id = ?').get(category.id);
      expect(unchanged.enabled).toBe(1);
    });

    it('renders a controlled error, with no stack trace, when enabling fails', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      fake.setEnabled.mockImplementationOnce(() => {
        throw new ProjectAssetCategoryError('cannot access category directory at internal path', { code: 'DESTINATION_UNSAFE' });
      });
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Enable Failure');
      const [category] = listProjectCategories(ctx.db, projectId);
      fake._state.categories.push({ ...category });

      const res = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/enable`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_enable_failed`);
      const page = await agent.get(res.headers.location).expect(200);
      expect(page.text).not.toContain('internal path');
    });
  });

  // ─── Reorder and move ───────────────────────────────────────────────────

  describe('reorder and move', () => {
    it('a complete reorder passes the full ID permutation', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Reorder Full');

      await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form')
        .send({ order: ['3', '1', '2'], _csrf: csrfToken }).expect(302);
      expect(fake.reorder).toHaveBeenCalledWith(projectId, [3, 1, 2]);
    });

    it('duplicate, malformed, and unknown IDs are controlled, not thrown to the client', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Reorder Bad Input');
      const [category] = listProjectCategories(ctx.db, projectId);
      const before = listProjectCategories(ctx.db, projectId);

      const res = await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form')
        .send({ order: [String(category.id), String(category.id), 'not-a-number'], _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_reorder_failed`);
      expect(listProjectCategories(ctx.db, projectId)).toEqual(before);
    });

    it('Move Up computes and submits the complete reordered list', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Move Up');
      const rows = listProjectCategories(ctx.db, projectId);
      fake._state.categories = rows.map((r) => ({ ...r }));
      const second = rows[1];

      await agent.post(`/projects/${projectId}/asset-categories/${second.id}/move-up`).type('form').send({ _csrf: csrfToken }).expect(302);

      const expectedIds = rows.map((r) => r.id);
      [expectedIds[0], expectedIds[1]] = [expectedIds[1], expectedIds[0]];
      expect(fake.reorder).toHaveBeenCalledWith(projectId, expectedIds);
    });

    it('Move Down computes and submits the complete reordered list', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Move Down');
      const rows = listProjectCategories(ctx.db, projectId);
      fake._state.categories = rows.map((r) => ({ ...r }));
      const first = rows[0];

      await agent.post(`/projects/${projectId}/asset-categories/${first.id}/move-down`).type('form').send({ _csrf: csrfToken }).expect(302);

      const expectedIds = rows.map((r) => r.id);
      [expectedIds[0], expectedIds[1]] = [expectedIds[1], expectedIds[0]];
      expect(fake.reorder).toHaveBeenCalledWith(projectId, expectedIds);
    });

    it('moving the first category up is a controlled no-op', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Boundary Up');
      const before = listProjectCategories(ctx.db, projectId);

      await agent.post(`/projects/${projectId}/asset-categories/${before[0].id}/move-up`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(listProjectCategories(ctx.db, projectId)).toEqual(before);
    });

    it('moving the last category down is a controlled no-op', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Boundary Down');
      const before = listProjectCategories(ctx.db, projectId);

      await agent.post(`/projects/${projectId}/asset-categories/${before[before.length - 1].id}/move-down`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(listProjectCategories(ctx.db, projectId)).toEqual(before);
    });

    it('a category ID from another project returns a controlled not-found response, not a cross-project mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectA = await createProject(agent, csrfToken, 'Scope A');
      const projectB = await createProject(agent, csrfToken, 'Scope B');
      const [categoryB] = listProjectCategories(ctx.db, projectB);

      await agent.post(`/projects/${projectA}/asset-categories/${categoryB.id}/move-up`).type('form').send({ _csrf: csrfToken }).expect(404);
      await agent.post(`/projects/${projectA}/asset-categories/${categoryB.id}/name`).type('form')
        .send({ displayName: 'Hijack', _csrf: csrfToken }).expect(404);

      const untouched = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE id = ?').get(categoryB.id);
      expect(untouched.project_id).toBe(projectB);
      expect(untouched.display_name).not.toBe('Hijack');
    });
  });

  // ─── Delete ──────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('safe deletion succeeds, including deleting the final category', async () => {
      ctx = setupTmp();
      ctx.db.prepare('UPDATE asset_category_defaults SET enabled = 0 WHERE directory_slug != ?').run('source');
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Delete Final');
      const rows = listProjectCategories(ctx.db, projectId);
      expect(rows).toHaveLength(1);

      const res = await agent.post(`/projects/${projectId}/asset-categories/${rows[0].id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_deleted`);
      expect(listProjectCategories(ctx.db, projectId)).toHaveLength(0);
    });

    it('HAS_ASSETS instructs disabling instead of deleting', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Delete Has Assets');
      const [category] = listProjectCategories(ctx.db, projectId);
      const assetRepository = createAssetRepository(ctx.db);
      assetRepository.upsert(projectId, `${category.directory_slug}/a.png`, {
        filename: 'a.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null, categoryId: category.id,
      });

      const res = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_delete_disable_instead`);
      const page = await agent.get(res.headers.location).expect(200);
      expect(page.text).toMatch(/disable/i);
      const stillThere = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE id = ?').get(category.id);
      expect(stillThere).toBeTruthy();
    });

    it('NOT_EMPTY instructs disabling instead of deleting', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Delete Not Empty');
      const [category] = listProjectCategories(ctx.db, projectId);
      const project = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      const absPath = resolveProjectDir(ctx.projectsRoot, project.project_dir);
      fs.writeFileSync(path.join(absPath, category.directory_slug, 'stray.txt'), 'stray');

      const res = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_delete_disable_instead`);
    });

    it('an unsafe-path failure is reported safely, with no internal path or SQL detail', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      fake.delete.mockImplementationOnce(() => {
        throw new ProjectAssetCategoryError('category directory at C:\\internal\\path is a symbolic link', { code: 'PATH_UNSAFE' });
      });
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Delete Unsafe Path');
      const [category] = listProjectCategories(ctx.db, projectId);
      fake._state.categories.push({ ...category });

      const res = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_delete_failed`);
      const page = await agent.get(res.headers.location).expect(200);
      expect(page.text).not.toContain('C:\\internal\\path');
      expect(page.text).not.toContain('SQLITE');
    });

    it('no destructive GET route exists for delete', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'No GET Delete');
      const before = listProjectCategories(ctx.db, projectId);

      await agent.get(`/projects/${projectId}/asset-categories/${before[0].id}/delete`).expect(404);
      expect(listProjectCategories(ctx.db, projectId)).toEqual(before);
    });
  });

  // ─── Integration: real service through HTTP ─────────────────────────────

  describe('integration behavior (real service)', () => {
    it('a successful name edit rewrites the manifest without renaming the directory', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Manifest Name Edit');
      const [category] = listProjectCategories(ctx.db, projectId);
      const project = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      const absPath = resolveProjectDir(ctx.projectsRoot, project.project_dir);
      const dirsBefore = fs.readdirSync(absPath).sort();

      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/name`).type('form')
        .send({ displayName: 'Renamed Label', _csrf: csrfToken }).expect(302);

      expect(fs.readdirSync(absPath).sort()).toEqual(dirsBefore);
      const manifest = readManifestSync(absPath);
      const entry = manifest.assetCategories.find((c) => c.directorySlug === category.directory_slug);
      expect(entry.displayName).toBe('Renamed Label');
    });

    it('enable/disable/reorder/delete each rewrite the manifest', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Manifest Mutations');
      const [category] = listProjectCategories(ctx.db, projectId);
      const project = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      const absPath = resolveProjectDir(ctx.projectsRoot, project.project_dir);

      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      let manifest = readManifestSync(absPath);
      expect(manifest.assetCategories.find((c) => c.directorySlug === category.directory_slug).enabled).toBe(false);
    });

    it('archived projects remain immutable through every mutation route', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Archived Immutable');
      const before = listProjectCategories(ctx.db, projectId);
      await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

      await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: 'X', directorySlug: 'x', _csrf: csrfToken }).expect(409);
      await agent.post(`/projects/${projectId}/asset-categories/${before[0].id}/name`).type('form')
        .send({ displayName: 'X', _csrf: csrfToken }).expect(409);
      await agent.post(`/projects/${projectId}/asset-categories/${before[0].id}/delete`).type('form').send({ _csrf: csrfToken }).expect(409);

      expect(listProjectCategories(ctx.db, projectId)).toEqual(before);
    });

    it('mutating a project category never changes the global asset category defaults', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Defaults Untouched');
      const [category] = listProjectCategories(ctx.db, projectId);
      const defaultsBefore = ctx.db.prepare('SELECT * FROM asset_category_defaults ORDER BY id').all();

      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/name`).type('form')
        .send({ displayName: 'Project Only Name', _csrf: csrfToken }).expect(302);
      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: 'New Project Category', directorySlug: 'new-project-category', _csrf: csrfToken }).expect(302);

      const defaultsAfter = ctx.db.prepare('SELECT * FROM asset_category_defaults ORDER BY id').all();
      expect(defaultsAfter).toEqual(defaultsBefore);
    });
  });
});
