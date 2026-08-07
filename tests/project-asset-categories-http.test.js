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
import { resolveProjectDir } from '../src/storage/project-storage.js';
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

function listReleaseAssets(db, releaseId) {
  return db
    .prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC')
    .all(releaseId);
}

function categoryReleasePath(projectId, categoryId) {
  return `/projects/${projectId}/asset-categories/${categoryId}/create-release`;
}

function hasNestedForms(html) {
  let depth = 0;
  for (const tag of html.match(/<\/?form\b[^>]*>/gi) || []) {
    if (tag.startsWith('</')) {
      depth -= 1;
    } else {
      if (depth > 0) return true;
      depth += 1;
    }
  }
  return depth !== 0;
}

function findProjectPreference(db, projectId) {
  return db.prepare(`
    SELECT default_category_mode, default_category_id
    FROM project_asset_browser_preferences
    WHERE project_id = ?
  `).get(projectId);
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
        .send({ orderedCategoryIds: '1,2', _csrf: csrfToken })
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
        `/projects/${projectId}/asset-categories/${category.id}/create-release`,
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

  // ─── Create release from category ─────────────────────────────────────

  describe('create release from category', () => {
    it('creates one release with the category assets and redirects to asset management', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Category Release');
      const [category] = listProjectCategories(ctx.db, projectId);
      const assetRepository = createAssetRepository(ctx.db);
      const first = assetRepository.upsert(projectId, `${category.directory_slug}/first.txt`, {
        filename: 'first.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        modifiedAt: null,
        categoryId: category.id,
      });
      const second = assetRepository.upsert(projectId, `${category.directory_slug}/second.txt`, {
        filename: 'second.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 20,
        modifiedAt: null,
        categoryId: category.id,
      });

      const res = await agent
        .post(categoryReleasePath(projectId, category.id))
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(302);

      const releaseId = Number(res.headers.location.match(/^\/releases\/(\d+)\/assets$/)?.[1]);
      expect(Number.isInteger(releaseId)).toBe(true);
      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);
      expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM releases WHERE project_id = ?').get(projectId).count).toBe(1);
      expect(listReleaseAssets(ctx.db, releaseId)).toEqual([
        { asset_id: first.id, role: 'attachment', sort_order: 0 },
        { asset_id: second.id, role: 'attachment', sort_order: 1 },
      ]);

      const assetPage = await agent.get(res.headers.location).expect(200);
      expect(assetPage.text).toContain('first.txt');
      expect(assetPage.text).toContain('second.txt');
    });

    it('maps malformed, missing, and cross-project IDs to the existing not-found response', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Category Release IDs');
      const otherProjectId = await createProject(agent, csrfToken, 'Other Category Release IDs');
      const [category] = listProjectCategories(ctx.db, projectId);
      const [otherCategory] = listProjectCategories(ctx.db, otherProjectId);

      await agent.post(categoryReleasePath('not-an-id', category.id)).type('form').send({ _csrf: csrfToken }).expect(404);
      await agent.post(categoryReleasePath(projectId, 'not-an-id')).type('form').send({ _csrf: csrfToken }).expect(404);
      await agent.post(categoryReleasePath(999999, category.id)).type('form').send({ _csrf: csrfToken }).expect(404);
      await agent.post(categoryReleasePath(projectId, 999999)).type('form').send({ _csrf: csrfToken }).expect(404);
      await agent.post(categoryReleasePath(projectId, otherCategory.id)).type('form').send({ _csrf: csrfToken }).expect(404);

      expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM releases').get().count).toBe(0);
    });

    it('rejects archived projects with the existing controlled 409 handling', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Archived Category Release');
      const [category] = listProjectCategories(ctx.db, projectId);
      await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

      const res = await agent
        .post(categoryReleasePath(projectId, category.id))
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(409);

      expect(res.text).toMatch(/archived/i);
      expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM releases WHERE project_id = ?').get(projectId).count).toBe(0);
    });

    it('does not create a release for GET requests to the POST-only path', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Category Release GET');
      const [category] = listProjectCategories(ctx.db, projectId);

      await agent.get(categoryReleasePath(projectId, category.id)).expect(404);

      expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM releases WHERE project_id = ?').get(projectId).count).toBe(0);
    });

    it('allows repeated valid POSTs to create separate releases', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Repeated Category Release');
      const [category] = listProjectCategories(ctx.db, projectId);

      const first = await agent.post(categoryReleasePath(projectId, category.id)).type('form').send({ _csrf: csrfToken }).expect(302);
      const second = await agent.post(categoryReleasePath(projectId, category.id)).type('form').send({ _csrf: csrfToken }).expect(302);
      const firstId = Number(first.headers.location.match(/^\/releases\/(\d+)\/assets$/)?.[1]);
      const secondId = Number(second.headers.location.match(/^\/releases\/(\d+)\/assets$/)?.[1]);

      expect(firstId).not.toBe(secondId);
      expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM releases WHERE project_id = ?').get(projectId).count).toBe(2);
    });

    it('passes unexpected service failures to the existing generic error handler', async () => {
      ctx = setupTmp();
      const releaseService = {
        createReleaseFromCategory: vi.fn(() => {
          throw new Error('internal release creation detail');
        }),
      };
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { releaseService, authConfig: AUTH_CONFIG },
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Category Release Failure');
      const [category] = listProjectCategories(ctx.db, projectId);

      const res = await agent
        .post(categoryReleasePath(projectId, category.id))
        .set('Accept', 'text/html')
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(500);

      expect(releaseService.createReleaseFromCategory).toHaveBeenCalledWith(projectId, category.id);
      expect(res.text).toContain('Something went wrong.');
      expect(res.text).not.toContain('internal release creation detail');
      expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM releases WHERE project_id = ?').get(projectId).count).toBe(0);
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

      await agent.post(`/projects/${projectId}/asset-categories/default`).type('form').send({ defaultCategory: 'all' }).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories`).type('form').send({ displayName: 'X', directorySlug: 'x' }).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form').send({ orderedCategoryIds: String(category.id) }).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/name`).type('form').send({ displayName: 'X' }).expect(403);
      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/enabled`).type('form').send({ enabled: '0' }).expect(403);
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
      const order = rows.map((r) => res.text.indexOf(`data-category-id="${r.id}"`));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      for (const idx of order) expect(idx).toBeGreaterThan(-1);
      expect(res.text).toContain('Disabled');
      expect(res.text).toContain('Enabled');
      expect(res.text).not.toContain('<th>Position</th>');
      expect(res.text).not.toContain('>Move Up</button>');
      expect(res.text).not.toContain('>Move Down</button>');
       expect(res.text).toContain('>Save status</button>');
      expect(res.text).toMatch(/<form method="post" action="\/projects\/\d+\/asset-categories\/\d+\/enabled" class="category-enabled-form">[\s\S]*?data-autosubmit[\s\S]*?<\/form>/);
      expect((res.text.match(/Changing a display name does not rename its directory\./g) || []).length).toBe(1);
      expect(res.text).not.toContain('Changes the label only — the folder on disk is not renamed.');
    });

    it('renders the complete mutable category card contract without nested forms', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Card Markup');
      const rows = listProjectCategories(ctx.db, projectId);

      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(res.text).toContain('data-category-reorder-list');
      expect(res.text).toContain(`data-reorder-url="/projects/${projectId}/asset-categories/reorder"`);
      expect(res.text).toContain('data-category-reorder-form');
      expect(res.text).toContain('name="orderedCategoryIds"');
      expect(res.text).toContain('data-category-reorder-live');

      const cards = res.text.match(/<article\b[^>]*data-category-reorder-item[^>]*>[\s\S]*?<\/article>/g) || [];
      expect(cards).toHaveLength(rows.length);
      expect(cards.map((card) => card.match(/data-category-id="(\d+)"/)?.[1])).toEqual(rows.map((row) => String(row.id)));
      for (const [index, card] of cards.entries()) {
        expect((card.match(/data-category-reorder-handle/g) || []).length).toBe(1);
        expect(card).toContain(`aria-label="Reorder ${rows[index].display_name}"`);
        expect(card).toContain(`aria-posinset="${index + 1}"`);
        expect(card).toContain(`aria-setsize="${rows.length}"`);
        expect(card).toContain('Save name');
        expect(card).toContain(`<code>${rows[index].directory_slug}</code>`);
        expect(card).toContain('data-autosubmit');
        expect(card).toContain(`method="post" action="/projects/${projectId}/asset-categories/${rows[index].id}/create-release" class="inline-form"`);
        expect(card).toContain(`aria-label="Create a new release from ${rows[index].display_name}"`);
        expect(card).toContain('>Create release</button>');
        expect(card).not.toContain(`href="/projects/${projectId}/asset-categories/${rows[index].id}/create-release"`);
        expect(card).toContain('>Delete</button>');
         expect(card).toContain('Save status');
      }

      expect(res.text).not.toContain('<th>Position</th>');
      expect(res.text).not.toContain('>Move Up</button>');
      expect(res.text).not.toContain('>Move Down</button>');
      expect(res.text).not.toContain('category-management-status');
      expect(hasNestedForms(res.text)).toBe(false);
      expect((res.text.match(/<form\b/gi) || []).length).toBe((res.text.match(/<\/form>/gi) || []).length);
    });

    it('shows an editable display name and a read-only directory slug separately', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Name Slug Probe');
      const [category] = listProjectCategories(ctx.db, projectId);

      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      const nameForm = res.text.match(new RegExp(
        `<form method="post" action="/projects/${projectId}/asset-categories/${category.id}/name"[^>]*>[\\s\\S]*?<\\/form>`
      ))?.[0];
      expect(nameForm).toBeDefined();
      expect(nameForm).toContain('name="_csrf"');
      expect(nameForm).toContain('name="displayName"');
      expect(nameForm).toContain(`value="${category.display_name}"`);
      expect(nameForm).toContain('>Save name</button>');
      expect(nameForm).toContain(`<label class="sr-only" for="name-${category.id}">`);
      expect(nameForm).not.toContain('directorySlug');
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
      expect(res.text).not.toContain('data-category-reorder-list');
      expect(res.text).not.toContain('data-category-reorder-form');
      expect(res.text).not.toContain('data-category-reorder-handle');
      expect(res.text).not.toContain('data-category-reorder-item');
      expect(res.text).not.toContain('draggable="true"');
      const [category] = listProjectCategories(ctx.db, projectId);
      expect(res.text).not.toContain(`/projects/${projectId}/asset-categories/${category.id}/delete`);
      expect(res.text).not.toContain(`/projects/${projectId}/asset-categories/${category.id}/name`);
      expect(res.text).not.toContain('category-name-form');
      expect(res.text).not.toContain(`id="name-${category.id}"`);
      expect(res.text).not.toContain(`/projects/${projectId}/asset-categories/${category.id}/enable`);
       expect(res.text).not.toContain(`/projects/${projectId}/asset-categories/${category.id}/disable`);
       expect(res.text).not.toContain(`/projects/${projectId}/asset-categories/${category.id}/create-release`);
       expect(res.text).not.toContain('id="add-displayName"');
    });
  });

  describe('project asset-browser default control', () => {
    it('uses the shared option semantics and shows enabled categories only', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Category Default Inherit');
      const categories = listProjectCategories(ctx.db, projectId);
      const disabled = categories[0];
      const enabled = categories[1];
      await agent.post(`/projects/${projectId}/asset-categories/${disabled.id}/disable`)
        .type('form').send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(res.text).toMatch(/<option value="inherit" selected>Inherit global default/);
      expect(res.text).toContain(`<option value="category:${enabled.id}"`);
      expect(res.text).not.toContain(`<option value="category:${disabled.id}"`);
      expect(res.text).toContain('Add a category');
      expect(res.text).toContain('asset-browser-default-section--project');
      expect(res.text).toContain('asset-browser-default-control-row');
      expect(res.text).toContain('name="defaultCategory" class="form-control"');
      expect(res.text).toContain('>Save default</button>');
    });

    it('keeps Add Category immediately after its fields without the enabled-default helper copy', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Category Add Layout');

      const res = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      const addForm = res.text.match(new RegExp(
        `<form method="post" action="/projects/${projectId}/asset-categories" class="[^"]*project-category-management-form[^"]*"[^>]*>[\\s\\S]*?<\\/form>`
      ))?.[0];

      expect(addForm).toBeDefined();
      expect(addForm).toContain('class="field-row"');
      expect(addForm).toContain('class="category-management-action-row"');
      expect(addForm.indexOf('class="field-row"')).toBeLessThan(addForm.indexOf('class="category-management-action-row"'));
      expect(addForm).toContain('>Add Category</button>');
      expect(addForm).toMatch(/id="add-enabled"[\s\S]*?checked/);
      expect(addForm).not.toContain('New categories are enabled by default.');
    });

    it('saves inherit, all, and a valid project category without filesystem or manifest mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Category Default Saves');
      const beforeFiles = fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort();
      const categories = listProjectCategories(ctx.db, projectId);

      for (const [value, mode, categoryId] of [
        ['inherit', 'inherit', null],
        ['all', 'all', null],
        [`category:${categories[0].id}`, 'category', categories[0].id],
      ]) {
        const res = await agent.post(`/projects/${projectId}/asset-categories/default`).type('form')
          .send({ defaultCategory: value, _csrf: csrfToken }).expect(302);
        expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=project_default_saved`);
        expect(findProjectPreference(ctx.db, projectId)).toEqual({
          default_category_mode: mode,
          default_category_id: categoryId,
        });
      }

      expect(fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort()).toEqual(beforeFiles);
    });

    it('retains submitted invalid values with 422 and leaves the stored preference unchanged', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Category Default Invalid');
      const otherProjectId = await createProject(agent, csrfToken, 'Category Default Other');
      const ownCategory = listProjectCategories(ctx.db, projectId)[0];
      const otherCategory = listProjectCategories(ctx.db, otherProjectId)[0];
      const before = findProjectPreference(ctx.db, projectId);

      const wrongProject = await agent.post(`/projects/${projectId}/asset-categories/default`).type('form')
        .send({ defaultCategory: `category:${otherCategory.id}`, _csrf: csrfToken }).expect(422);
      expect(wrongProject.text).toContain('belong to this project');
      expect(wrongProject.text).toContain(`<option value="category:${otherCategory.id}" selected>`);

      await agent.post(`/projects/${projectId}/asset-categories/${ownCategory.id}/disable`)
        .type('form').send({ _csrf: csrfToken }).expect(302);
      const disabled = await agent.post(`/projects/${projectId}/asset-categories/default`).type('form')
        .send({ defaultCategory: `category:${ownCategory.id}`, _csrf: csrfToken }).expect(422);
      expect(disabled.text).toContain('Disabled categories cannot be selected directly');
      expect(disabled.text).toContain(`<option value="category:${ownCategory.id}" selected>`);

      const malformed = await agent.post(`/projects/${projectId}/asset-categories/default`).type('form')
        .send({ defaultCategory: 'unexpected', _csrf: csrfToken }).expect(422);
      expect(malformed.text).toContain('Preference must be inherit, all, or category');
      expect(malformed.text).toContain('<option value="unexpected" selected>');
      expect(findProjectPreference(ctx.db, projectId)).toEqual(before);
    });

    it('requires CSRF and keeps archived preference controls read-only while rejecting direct POSTs', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Category Default Archived');
      const [category] = listProjectCategories(ctx.db, projectId);
      await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

      await agent.post(`/projects/${projectId}/asset-categories/default`).type('form')
        .send({ defaultCategory: 'all' }).expect(403);
      const page = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(page.text).toMatch(/shown read-only/i);
      expect(page.text).not.toContain(`action="/projects/${projectId}/asset-categories/default"`);

      const rejected = await agent.post(`/projects/${projectId}/asset-categories/default`).type('form')
        .send({ defaultCategory: `category:${category.id}`, _csrf: csrfToken }).expect(409);
      expect(rejected.text).toMatch(/archived/i);
      expect(rejected.text).not.toContain(`action="/projects/${projectId}/asset-categories/default"`);
      expect(findProjectPreference(ctx.db, projectId)).toEqual({
        default_category_mode: 'inherit',
        default_category_id: null,
      });
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
        .send({ displayName: 'Drafts', directorySlug: 'drafts', enabled: '0', _csrf: csrfToken }).expect(302);

      expect(fake.add).toHaveBeenNthCalledWith(1, projectId, expect.objectContaining({ enabled: true }));
      expect(fake.add).toHaveBeenNthCalledWith(2, projectId, expect.objectContaining({ enabled: false }));
    });

    it('defaults an omitted enabled field to enabled', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Add Default Enabled');

      await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: 'Drafts', directorySlug: 'drafts', _csrf: csrfToken }).expect(302);

      expect(ctx.db.prepare(`
        SELECT enabled FROM project_asset_categories
        WHERE project_id = ? AND directory_slug = ?
      `).get(projectId, 'drafts').enabled).toBe(1);
    });

    it('renders the initial switch checked and retains checked or unchecked state on validation failure', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Add Switch State');

      const initial = await agent.get(`/projects/${projectId}/asset-categories`).expect(200);
      expect(initial.text).toMatch(/<input\s+type="checkbox"\s+id="add-enabled"[\s\S]*?checked/);

      const unchecked = await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: '', directorySlug: 'unchecked', enabled: '0', _csrf: csrfToken }).expect(422);
      const uncheckedSwitch = unchecked.text.match(/<input\s+type="checkbox"\s+id="add-enabled"[\s\S]*?>/)?.[0] || '';
      expect(uncheckedSwitch).not.toContain('checked');

      const checked = await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: '', directorySlug: 'checked', enabled: ['0', '1'], _csrf: csrfToken }).expect(422);
      expect(checked.text).toMatch(/<input\s+type="checkbox"\s+id="add-enabled"[\s\S]*?checked/);
    });

    it('rejects a malformed enabled value with 422 and does not create a category', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Add Malformed Enabled');

      const res = await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: 'Malformed', directorySlug: 'malformed', enabled: 'maybe', _csrf: csrfToken }).expect(422);
      expect(res.text).toContain('Enabled value must be');
      expect(listProjectCategories(ctx.db, projectId).some((row) => row.directory_slug === 'malformed')).toBe(false);
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
      const categoriesBefore = listProjectCategories(ctx.db, projectId);
      const [category] = categoriesBefore;
      const otherCategory = categoriesBefore.find((row) => row.id !== category.id);
      const preferenceBefore = findProjectPreference(ctx.db, projectId);
      const project = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      const projectDir = resolveProjectDir(ctx.projectsRoot, project.project_dir);
      const directoriesBefore = fs.readdirSync(projectDir).sort();

      const okRes = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/name`).type('form')
        .send({ displayName: 'New Label', _csrf: csrfToken }).expect(302);
      expect(okRes.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_name_updated`);

      const afterSuccess = listProjectCategories(ctx.db, projectId);
      expect(afterSuccess.find((row) => row.id === category.id).display_name).toBe('New Label');
      expect(afterSuccess.find((row) => row.id === category.id).directory_slug).toBe(category.directory_slug);
      expect(afterSuccess.map((row) => ({ id: row.id, enabled: row.enabled })))
        .toEqual(categoriesBefore.map((row) => ({ id: row.id, enabled: row.enabled })));
      expect(findProjectPreference(ctx.db, projectId)).toEqual(preferenceBefore);
      expect(fs.readdirSync(projectDir).sort()).toEqual(directoriesBefore);

      const invalidValue = '   ';
      const failRes = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/name`).type('form')
        .send({ displayName: invalidValue, _csrf: csrfToken }).expect(422);
      expect(failRes.text).toContain('Display name is required');

      const affectedRow = failRes.text.match(new RegExp(
        `<article\\b[^>]*class="category-management-card"[^>]*data-category-id="${category.id}"[\\s\\S]*?<\\/article>`
      ))?.[0];
      expect(affectedRow).toBeDefined();
      expect(affectedRow).toMatch(new RegExp(`id="name-${category.id}"[^>]*value="\\s{3}"`));
      expect(affectedRow).toContain(`aria-describedby="name-${category.id}-error"`);
      expect(affectedRow).toContain(`id="name-${category.id}-error"`);

      if (otherCategory) {
        const otherRow = failRes.text.match(new RegExp(
          `<article\\b[^>]*class="category-management-card"[^>]*data-category-id="${otherCategory.id}"[\\s\\S]*?<\\/article>`
        ))?.[0];
        expect(otherRow).toBeDefined();
        expect(otherRow).toContain(`value="${otherCategory.display_name}"`);
      }

      const afterFailure = listProjectCategories(ctx.db, projectId);
      expect(afterFailure.find((row) => row.id === category.id).display_name).toBe('New Label');
      expect(afterFailure.map((row) => ({ id: row.id, enabled: row.enabled })))
        .toEqual(categoriesBefore.map((row) => ({ id: row.id, enabled: row.enabled })));
      expect(findProjectPreference(ctx.db, projectId)).toEqual(preferenceBefore);
      expect(fs.readdirSync(projectDir).sort()).toEqual(directoriesBefore);
    });
  });

  // ─── Enable and disable ─────────────────────────────────────────────────

  describe('enable and disable', () => {
    it('unified switch route parses unchecked and hidden-plus-checked values', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Unified Switch Ops');
      const [category] = listProjectCategories(ctx.db, projectId);
      fake._state.categories.push({ ...category });

      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/enabled`).type('form')
        .send({ enabled: '0', _csrf: csrfToken }).expect(302);
      expect(fake.setEnabled).toHaveBeenLastCalledWith(projectId, category.id, false);

      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/enabled`).type('form')
        .send({ enabled: ['0', '1'], _csrf: csrfToken }).expect(302);
      expect(fake.setEnabled).toHaveBeenLastCalledWith(projectId, category.id, true);
    });

    it('rejects malformed switch values with 422 and preserves the category', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Malformed Switch');
      const [category] = listProjectCategories(ctx.db, projectId);

      const res = await agent.post(`/projects/${projectId}/asset-categories/${category.id}/enabled`).type('form')
        .send({ enabled: ['0', '1', '1'], _csrf: csrfToken }).expect(422);
      expect(res.text).toContain('Enabled value must be');
      expect(ctx.db.prepare('SELECT enabled FROM project_asset_categories WHERE id = ?').get(category.id).enabled).toBe(1);
    });

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

      await agent.post(`/projects/${projectId}/asset-categories/${category.id}/enabled`).type('form')
        .send({ enabled: '0', _csrf: csrfToken }).expect(409);
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
        .send({ orderedCategoryIds: '3,1,2', _csrf: csrfToken }).expect(302);
      expect(fake.reorder).toHaveBeenCalledWith(projectId, [3, 1, 2]);
    });

    it('persists a valid arbitrary order, redirects with a controlled notice, and renders it on the following GET', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Reorder Success');
      const rows = listProjectCategories(ctx.db, projectId);
      const orderedRows = [rows[2], rows[0], rows[4], rows[1], rows[3]];
      const orderedCategoryIds = orderedRows.map((row) => row.id).join(',');

      const res = await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form')
        .send({ orderedCategoryIds, _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_reordered`);
      expect(listProjectCategories(ctx.db, projectId).map((row) => row.id)).toEqual(orderedRows.map((row) => row.id));
      expect(listProjectCategories(ctx.db, projectId).map((row) => row.display_order)).toEqual([0, 1, 2, 3, 4]);

      const page = await agent.get(res.headers.location).expect(200);
      expect(page.text).toContain('Category order updated.');
      const positions = orderedRows.map((row) => page.text.indexOf(`id="name-${row.id}"`));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('duplicate, malformed, and unknown IDs are controlled, not thrown to the client', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Reorder Bad Input');
      const [category] = listProjectCategories(ctx.db, projectId);
      const before = listProjectCategories(ctx.db, projectId);

      const res = await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form')
        .send({ orderedCategoryIds: `${category.id},${category.id},not-a-number`, _csrf: csrfToken }).expect(422);
      expect(res.text).toContain('submitted category order is invalid');
      expect(res.text).not.toContain('not-a-number');
      expect(listProjectCategories(ctx.db, projectId)).toEqual(before);
    });

    it('rejects missing, empty, decimal, partial, negative, and unsafe payload values with 422', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Reorder Strict Input');
      const [first] = listProjectCategories(ctx.db, projectId);
      const before = listProjectCategories(ctx.db, projectId);
      const payloads = [
        {},
        { orderedCategoryIds: '' },
        { orderedCategoryIds: `${first.id}.5` },
        { orderedCategoryIds: `${first.id}abc` },
        { orderedCategoryIds: '0' },
        { orderedCategoryIds: '-1' },
        { orderedCategoryIds: '9007199254740992' },
        { orderedCategoryIds: `${first.id}, ${first.id}` },
      ];

      for (const payload of payloads) {
        const res = await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form')
          .send({ ...payload, _csrf: csrfToken }).expect(422);
        expect(res.text).toContain('submitted category order is invalid');
        expect(res.text).not.toContain('9007199254740992');
      }

      expect(listProjectCategories(ctx.db, projectId)).toEqual(before);
    });

    it('rejects duplicate, missing, extra, and cross-project IDs with 422 and no mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Reorder Exact Set');
      const otherProjectId = await createProject(agent, csrfToken, 'Reorder Other Project');
      const ownRows = listProjectCategories(ctx.db, projectId);
      const otherRows = listProjectCategories(ctx.db, otherProjectId);
      const ids = ownRows.map((row) => row.id);
      const invalidOrders = [
        [...ids.slice(0, -1), ids[0], ids[0]],
        ids.slice(0, -1),
        [...ids.slice(0, -1), 999999],
        [otherRows[0].id, ...ids.slice(1)],
      ];

      for (const orderedCategoryIds of invalidOrders) {
        const res = await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form')
          .send({ orderedCategoryIds: orderedCategoryIds.join(','), _csrf: csrfToken }).expect(422);
        expect(res.text).toContain('submitted category order is invalid');
        expect(res.text).not.toContain('999999');
      }

      expect(listProjectCategories(ctx.db, projectId)).toEqual(ownRows);
      expect(listProjectCategories(ctx.db, otherProjectId)).toEqual(otherRows);
    });

    it('maps an unexpected reorder failure to a controlled notice without exposing raw error text', async () => {
      ctx = setupTmp();
      const fake = makeFakeProjectAssetCategoryService();
      fake.reorder.mockImplementationOnce(() => {
        throw new Error('internal reorder detail at a private path');
      });
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { projectAssetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Reorder Failure');

      const res = await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form')
        .send({ orderedCategoryIds: '1', _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe(`/projects/${projectId}/asset-categories?notice=category_reorder_failed`);

      const page = await agent.get(res.headers.location).expect(200);
      expect(page.text).toContain('Could not update the order. No changes were made.');
      expect(page.text).not.toContain('internal reorder detail');
    });

    it('returns controlled 409 for an archived project and leaves its order unchanged', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Reorder Archived');
      const before = listProjectCategories(ctx.db, projectId);
      await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);

      const res = await agent.post(`/projects/${projectId}/asset-categories/reorder`).type('form')
        .send({ orderedCategoryIds: before.map((row) => row.id).reverse().join(','), _csrf: csrfToken }).expect(409);

      expect(res.text).toMatch(/archived/i);
      expect(res.text).not.toContain('Category order updated.');
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
      await agent.post(`/projects/${projectA}/asset-categories/${categoryB.id}/enabled`).type('form')
        .send({ enabled: '0', _csrf: csrfToken }).expect(404);

      const untouched = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE id = ?').get(categoryB.id);
      expect(untouched.project_id).toBe(projectB);
      expect(untouched.display_name).not.toBe('Hijack');
    });
  });

  // ─── Delete ──────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('safe deletion succeeds, including deleting the final category', async () => {
      ctx = setupTmp();
      ctx.db.prepare('UPDATE asset_category_defaults SET enabled = 0 WHERE directory_slug != ?').run('final');
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Delete Final');
      const rows = listProjectCategories(ctx.db, projectId);
      expect(rows).toHaveLength(1);
      expect(rows[0].directory_slug).toBe('final');

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
