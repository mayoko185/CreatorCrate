/**
 * Phase 1 — Settings asset-category defaults HTTP integration tests.
 *
 * Covers dependency injection into the Settings router, the global-default
 * list/add/edit/enable/disable/reorder/delete operations, validation and
 * conflict handling, the database-only guarantee (no filesystem or project
 * mutation), and authentication/CSRF behavior.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function setupTmp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-cat-http-'));
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

function makeFakeCategoryService(seed = []) {
  const state = { defaults: seed.map((row) => ({ ...row })) };
  let nextId = 1000;
  return {
    listDefaults: vi.fn(() => state.defaults),
    addDefault: vi.fn((input) => {
      const row = {
        id: nextId++,
        display_name: input.displayName,
        directory_slug: input.directorySlug,
        display_order: state.defaults.length,
        enabled: input.enabled ? 1 : 0,
      };
      state.defaults.push(row);
      return row;
    }),
    editDefault: vi.fn((id, input) => {
      const row = state.defaults.find((d) => d.id === id);
      if (row) {
        row.display_name = input.displayName;
        row.directory_slug = input.directorySlug;
      }
      return row;
    }),
    setDefaultEnabled: vi.fn((id, enabled) => {
      const row = state.defaults.find((d) => d.id === id);
      if (row) row.enabled = enabled ? 1 : 0;
      return row;
    }),
    reorderDefaults: vi.fn((ids) => ids),
    deleteDefault: vi.fn((id) => {
      const idx = state.defaults.findIndex((d) => d.id === id);
      if (idx === -1) return false;
      state.defaults.splice(idx, 1);
      return true;
    }),
    listProjectCategories: vi.fn(() => []),
    copyDefaultsForProject: vi.fn(() => []),
  };
}

async function createProject(agent, csrfToken, title) {
  const res = await agent
    .post('/projects')
    .type('form')
    .send({ title, status: 'tbd', priority: 'normal', _csrf: csrfToken })
    .expect(302);
  return Number(res.headers.location.replace('/projects/', ''));
}

describe('settings — asset category defaults HTTP', () => {
  let ctx;

  afterEach(() => {
    if (!ctx) return;
    try { closeDatabase(ctx.db); } catch {}
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    ctx = null;
  });

  // ─── Dependency injection ────────────────────────────────────────────────

  describe('dependency injection', () => {
    it('createSettingsRouter uses the explicitly injected asset-category service', async () => {
      ctx = setupTmp();
      const fake = makeFakeCategoryService([
        { id: 1, display_name: 'Source', directory_slug: 'source', display_order: 0, enabled: 1 },
      ]);
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { assetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent } = await authenticate(app);

      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(fake.listDefaults).toHaveBeenCalled();
      expect(res.text).toContain('Source');
    });

    it('the same injected service instance backs both project creation and Settings', async () => {
      ctx = setupTmp();
      const fake = makeFakeCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { assetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);

      await createProject(agent, csrfToken, 'DI Probe');
      expect(fake.copyDefaultsForProject).toHaveBeenCalled();

      await agent.get('/settings/asset-categories').expect(200);
      expect(fake.listDefaults).toHaveBeenCalled();
    });

    it('existing Settings routes (backups) still receive their prior dependencies when the category service is injected', async () => {
      ctx = setupTmp();
      const fake = makeFakeCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        {
          assetCategoryService: fake,
          authConfig: AUTH_CONFIG,
          appDataRoot: ctx.appDataRoot,
          databasePath: ctx.databasePath,
        }
      );
      const { agent } = await authenticate(app);
      const res = await agent.get('/settings/backups').expect(200);
      expect(res.text).toContain('Backups');
    });

    it('a focused fake category service can be injected and drives route behavior', async () => {
      ctx = setupTmp();
      const fake = makeFakeCategoryService();
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { assetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);

      await agent
        .post('/settings/asset-categories')
        .type('form')
        .send({ displayName: 'Storyboards', directorySlug: 'storyboards', _csrf: csrfToken })
        .expect(302);

      expect(fake.addDefault).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Storyboards', directorySlug: 'storyboards' })
      );
    });
  });

  // ─── Listing ──────────────────────────────────────────────────────────────

  describe('listing', () => {
    it('renders both enabled and disabled defaults, plus the future-projects notice', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const listBefore = await agent.get('/settings/asset-categories').expect(200);
      const sourceRow = ctx.db.prepare('SELECT id FROM asset_category_defaults WHERE directory_slug = ?').get('source');
      await agent.post(`/settings/asset-categories/${sourceRow.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(res.text).toContain('Source');
      expect(res.text).toContain('Exports');
      expect(res.text).toContain('Disabled');
      expect(res.text).toContain('Enabled');
      expect(res.text).toMatch(/newly created projects|future project/i);
      expect(listBefore.text).toContain('Source');
    });

    it('renders defaults in deterministic display_order then id order', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent } = await authenticate(app);

      const res = await agent.get('/settings/asset-categories').expect(200);
      const order = ['Source', 'Exports', 'Extras', 'References', 'Thumbnails'].map((name) => res.text.indexOf(`>${name}<`));
      const sorted = [...order].sort((a, b) => a - b);
      expect(order).toEqual(sorted);
      for (const idx of order) expect(idx).toBeGreaterThan(-1);
    });

    it('renders an empty state once every default has been deleted', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults').all().map((r) => r.id);
      for (const id of ids) {
        await agent.post(`/settings/asset-categories/${id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
      }

      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(res.text).toContain('No asset category defaults');
    });
  });

  // ─── Add ──────────────────────────────────────────────────────────────────

  describe('adding', () => {
    it('adds a valid default and persists enabled/disabled creation state', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'Storyboards', directorySlug: 'storyboards', enabled: 'on', _csrf: csrfToken })
        .expect(302);
      await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'Drafts', directorySlug: 'drafts', _csrf: csrfToken })
        .expect(302);

      const rows = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug IN (?, ?)').all('storyboards', 'drafts');
      const storyboards = rows.find((r) => r.directory_slug === 'storyboards');
      const drafts = rows.find((r) => r.directory_slug === 'drafts');
      expect(storyboards.enabled).toBe(1);
      expect(drafts.enabled).toBe(0);
    });

    it('trims display name and validates through the service', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: '  Storyboards  ', directorySlug: 'storyboards', _csrf: csrfToken })
        .expect(302);

      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('storyboards');
      expect(row.display_name).toBe('Storyboards');
    });

    it('rejects an invalid display name with a controlled response', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const res = await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: '   ', directorySlug: 'valid-slug', _csrf: csrfToken })
        .expect(422);
      expect(res.text).toContain('Display name is required');

      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('valid-slug');
      expect(row).toBeUndefined();
    });

    it('rejects an invalid directory slug with a controlled response', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const res = await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'Valid Name', directorySlug: '../escape', _csrf: csrfToken })
        .expect(422);
      expect(res.text).not.toContain('SqliteError');
      expect(res.text.toLowerCase()).toContain('slug');
    });

    it('rejects a duplicate case-insensitive slug safely, without a stack trace', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const res = await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'Dup', directorySlug: 'SOURCE', _csrf: csrfToken })
        .expect(422);
      expect(res.text).not.toContain('SQLITE_CONSTRAINT');
      expect(res.text).not.toContain('idx_asset_category_defaults_slug');

      const count = ctx.db.prepare('SELECT COUNT(*) AS c FROM asset_category_defaults WHERE directory_slug = ?').get('source').c;
      expect(count).toBe(1);
    });

    it('performs no filesystem operation when adding a default', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const before = fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort();
      await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'Storyboards', directorySlug: 'storyboards', _csrf: csrfToken })
        .expect(302);
      const after = fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort();
      expect(after).toEqual(before);
    });
  });

  // ─── Edit ─────────────────────────────────────────────────────────────────

  describe('editing', () => {
    it('changes the display name', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');

      await agent.post(`/settings/asset-categories/${row.id}`).type('form')
        .send({ displayName: 'Raw Footage', directorySlug: 'source', _csrf: csrfToken })
        .expect(302);

      const updated = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(row.id);
      expect(updated.display_name).toBe('Raw Footage');
    });

    it('changes the directory slug', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');

      await agent.post(`/settings/asset-categories/${row.id}`).type('form')
        .send({ displayName: 'Source', directorySlug: 'raw', _csrf: csrfToken })
        .expect(302);

      const updated = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(row.id);
      expect(updated.directory_slug).toBe('raw');
    });

    it('rejects a case-insensitive slug conflict with another default', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('exports');

      const res = await agent.post(`/settings/asset-categories/${row.id}`).type('form')
        .send({ displayName: 'Exports', directorySlug: 'SOURCE', _csrf: csrfToken })
        .expect(422);
      expect(res.text).not.toContain('SQLITE_CONSTRAINT');

      const unchanged = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(row.id);
      expect(unchanged.directory_slug).toBe('exports');
    });

    it('leaves already-copied project-owned categories unchanged and performs no filesystem or manifest operation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const projectId = await createProject(agent, csrfToken, 'Edit Independence');
      const projectCategoriesBefore = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);
      expect(projectCategoriesBefore.length).toBeGreaterThan(0);

      const sourceDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');
      const before = fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort();

      await agent.post(`/settings/asset-categories/${sourceDefault.id}`).type('form')
        .send({ displayName: 'Renamed Source', directorySlug: 'renamed-source', _csrf: csrfToken })
        .expect(302);

      const projectCategoriesAfter = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);
      expect(projectCategoriesAfter).toEqual(projectCategoriesBefore);

      const after = fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort();
      expect(after).toEqual(before);
    });

    it('returns a not-found response for an unknown default ID', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      await agent.post('/settings/asset-categories/999999').type('form')
        .send({ displayName: 'X', directorySlug: 'x', _csrf: csrfToken })
        .expect(404);
    });
  });

  // ─── Toggle ───────────────────────────────────────────────────────────────

  describe('enable/disable', () => {
    it('disables an enabled default and re-enables it', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');

      await agent.post(`/settings/asset-categories/${row.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(ctx.db.prepare('SELECT enabled FROM asset_category_defaults WHERE id = ?').get(row.id).enabled).toBe(0);

      await agent.post(`/settings/asset-categories/${row.id}/enable`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(ctx.db.prepare('SELECT enabled FROM asset_category_defaults WHERE id = ?').get(row.id).enabled).toBe(1);
    });

    it('keeps a disabled default visible in the list', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');

      await agent.post(`/settings/asset-categories/${row.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(res.text).toContain('Source');
    });

    it('leaves existing project-owned categories unchanged after disabling their source default', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const projectId = await createProject(agent, csrfToken, 'Toggle Independence');
      const before = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);

      const sourceDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');
      await agent.post(`/settings/asset-categories/${sourceDefault.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const after = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);
      expect(after).toEqual(before);
    });

    it('only enabled defaults are copied into a newly created project', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const sourceDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');
      await agent.post(`/settings/asset-categories/${sourceDefault.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const projectId = await createProject(agent, csrfToken, 'Enabled Only Copy');
      const categories = ctx.db.prepare('SELECT directory_slug FROM project_asset_categories WHERE project_id = ?').all(projectId).map((r) => r.directory_slug);
      expect(categories).not.toContain('source');
      expect(categories).toContain('exports');
    });
  });

  // ─── Reorder ──────────────────────────────────────────────────────────────

  describe('reordering', () => {
    it('persists a complete valid reorder as contiguous zero-based positions', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const reversed = [...ids].reverse();

      await agent.post('/settings/asset-categories/reorder').type('form')
        .send(reversed.map((id) => `order=${id}`).join('&') + `&_csrf=${encodeURIComponent(csrfToken)}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const rows = ctx.db.prepare('SELECT id, display_order FROM asset_category_defaults ORDER BY display_order').all();
      expect(rows.map((r) => r.id)).toEqual(reversed);
      expect(rows.map((r) => r.display_order)).toEqual(reversed.map((_, i) => i));
    });

    it('reorders enabled and disabled defaults together', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const sourceDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');
      await agent.post(`/settings/asset-categories/${sourceDefault.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const reversed = [...ids].reverse();

      await agent.post('/settings/asset-categories/reorder').type('form')
        .send(reversed.map((id) => `order=${id}`).join('&') + `&_csrf=${encodeURIComponent(csrfToken)}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const rows = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all();
      expect(rows.map((r) => r.id)).toEqual(reversed);
    });

    async function reorderSnapshot(ctx) {
      return ctx.db.prepare('SELECT id, display_order FROM asset_category_defaults ORDER BY display_order').all();
    }

    it('rejects duplicate IDs without partial mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const before = await reorderSnapshot(ctx);
      const malformed = [ids[0], ids[0], ...ids.slice(2)];

      const res = await agent.post('/settings/asset-categories/reorder').type('form')
        .send(malformed.map((id) => `order=${id}`).join('&') + `&_csrf=${encodeURIComponent(csrfToken)}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      expect(res.headers.location).toBe('/settings/asset-categories?notice=category_reorder_failed');
      expect(await reorderSnapshot(ctx)).toEqual(before);
    });

    it('rejects a missing/incomplete ID set without partial mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const before = await reorderSnapshot(ctx);
      const incomplete = ids.slice(0, ids.length - 1);

      const res = await agent.post('/settings/asset-categories/reorder').type('form')
        .send(incomplete.map((id) => `order=${id}`).join('&') + `&_csrf=${encodeURIComponent(csrfToken)}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      expect(res.headers.location).toBe('/settings/asset-categories?notice=category_reorder_failed');
      expect(await reorderSnapshot(ctx)).toEqual(before);
    });

    it('rejects an unknown ID without partial mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const before = await reorderSnapshot(ctx);
      const withUnknown = [...ids.slice(1), 999999];

      const res = await agent.post('/settings/asset-categories/reorder').type('form')
        .send(withUnknown.map((id) => `order=${id}`).join('&') + `&_csrf=${encodeURIComponent(csrfToken)}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      expect(res.headers.location).toBe('/settings/asset-categories?notice=category_reorder_failed');
      expect(await reorderSnapshot(ctx)).toEqual(before);
    });

    it('rejects malformed (non-integer) IDs without partial mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const before = await reorderSnapshot(ctx);
      const malformed = [...ids.slice(1), 'not-a-number'];

      const res = await agent.post('/settings/asset-categories/reorder').type('form')
        .send(malformed.map((id) => `order=${id}`).join('&') + `&_csrf=${encodeURIComponent(csrfToken)}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      expect(res.headers.location).toBe('/settings/asset-categories?notice=category_reorder_failed');
      expect(await reorderSnapshot(ctx)).toEqual(before);
    });

    it('rerenders the list in the new deterministic order after a successful reorder', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const reversed = [...ids].reverse();

      await agent.post('/settings/asset-categories/reorder').type('form')
        .send(reversed.map((id) => `order=${id}`).join('&') + `&_csrf=${encodeURIComponent(csrfToken)}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/settings/asset-categories').expect(200);
      const thumbnailsIdx = res.text.indexOf('>Thumbnails<');
      const sourceIdx = res.text.indexOf('>Source<');
      expect(thumbnailsIdx).toBeGreaterThan(-1);
      expect(sourceIdx).toBeGreaterThan(-1);
      expect(thumbnailsIdx).toBeLessThan(sourceIdx);
    });

    it('Move Up/Down controls persist a swap via the same reorder contract', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const exportsRow = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('exports');

      await agent.post(`/settings/asset-categories/${exportsRow.id}/move-up`).type('form').send({ _csrf: csrfToken }).expect(302);

      const rows = ctx.db.prepare('SELECT directory_slug FROM asset_category_defaults ORDER BY display_order').all();
      expect(rows[0].directory_slug).toBe('exports');
      expect(rows[1].directory_slug).toBe('source');
    });
  });

  // ─── Delete ───────────────────────────────────────────────────────────────

  describe('deleting', () => {
    it('deletes a default', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('thumbnails');

      await agent.post(`/settings/asset-categories/${row.id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(row.id)).toBeUndefined();
    });

    it('supports deleting the final remaining default, leaving an empty but valid list', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults').all().map((r) => r.id);
      for (const id of ids) {
        await agent.post(`/settings/asset-categories/${id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
      }
      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(res.status).toBe(200);
      expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM asset_category_defaults').get().c).toBe(0);
    });

    it('leaves existing project-owned categories unchanged after deleting their source default, with no directory or manifest mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const projectId = await createProject(agent, csrfToken, 'Delete Independence');
      const before = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);
      const beforeFs = fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort();

      const sourceDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');
      await agent.post(`/settings/asset-categories/${sourceDefault.id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);

      const after = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);
      expect(after).toEqual(before);
      const afterFs = fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort();
      expect(afterFs).toEqual(beforeFs);
    });

    it('returns a not-found response deleting an unknown ID', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      await agent.post('/settings/asset-categories/999999/delete').type('form').send({ _csrf: csrfToken }).expect(404);
    });
  });

  // ─── Auth / CSRF ────────────────────────────────────────────────────────

  describe('authentication and CSRF', () => {
    it('requires authentication to view the page', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const request = (await import('supertest')).default;
      await request(app).get('/settings/asset-categories').expect(302);
    });

    it('rejects a mutation POST with a missing CSRF token', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent } = await authenticate(app);
      await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'X', directorySlug: 'x' })
        .expect(403);
    });

    it('rejects a mutation POST with an invalid CSRF token', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent } = await authenticate(app);
      await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'X', directorySlug: 'x', _csrf: 'not-a-real-token' })
        .expect(403);
    });

    it('GET never mutates state', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent } = await authenticate(app);
      const before = ctx.db.prepare('SELECT * FROM asset_category_defaults ORDER BY id').all();
      await agent.get('/settings/asset-categories?edit=1').expect(200);
      const after = ctx.db.prepare('SELECT * FROM asset_category_defaults ORDER BY id').all();
      expect(after).toEqual(before);
    });

    it('destructive delete is not exposed through GET', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('source');
      await agent.get(`/settings/asset-categories/${row.id}/delete`).expect(404);
      expect(ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(row.id)).toBeTruthy();
    });
  });
});
