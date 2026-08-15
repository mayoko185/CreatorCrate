/**
 * Phase 1 — Settings asset-category defaults HTTP integration tests.
 *
 * Covers dependency injection into the Settings router, the global-default
 * list/add/edit/enable/disable/reorder/delete operations, validation and
 * conflict handling, the Preview category setting, the database-only guarantee
 * (no filesystem or project mutation), and authentication/CSRF behavior.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';
import {
  PREVIEW_CATEGORY_KEY,
  PREVIEW_CATEGORY_DISABLED_VALUE,
} from '../src/services/preview-category-settings-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function setupTmp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-cat-http-'));
  const appDataRoot = path.join(tmpDir, 'app');
  fs.mkdirSync(appDataRoot, { recursive: true });
  const projectsRoot = path.join(tmpDir, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
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

function getGlobalBrowserDefault(db) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get('asset_browser.default_category');
}

function getPreviewCategory(db) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(PREVIEW_CATEGORY_KEY);
}

function getProjectBrowserPreference(db, projectId) {
  return db.prepare(`
    SELECT default_category_mode, default_category_id
    FROM project_asset_browser_preferences
    WHERE project_id = ?
  `).get(projectId);
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
        { id: 1, display_name: 'Final', directory_slug: 'final', display_order: 0, enabled: 1 },
      ]);
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { assetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent } = await authenticate(app);

      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(fake.listDefaults).toHaveBeenCalled();
      expect(res.text).toContain('Final');
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
      const finalRow = ctx.db.prepare('SELECT id FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      await agent.post(`/settings/asset-categories/${finalRow.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(res.text).toContain('Final');
      expect(res.text).toContain('WIP');
      expect(res.text).toContain('Disabled');
      expect(res.text).toContain('Enabled');
      expect(res.text).toMatch(/newly created projects|future project/i);
      expect(listBefore.text).toContain('Final');
      expect(res.text).toMatch(/<input\s+type="checkbox"\s+id="global-category-enabled-\d+"[\s\S]*?checked/);
    });

    it('guards each default Delete with a confirmation and marks the details form for in-place save', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent } = await authenticate(app);

      const res = await agent.get('/settings/asset-categories').expect(200);
      // Every default-delete button must ask for confirmation before deleting.
      const deleteButtons = res.text.match(/<button[^>]*button-danger[^>]*>\s*Delete\s*<\/button>/g) || [];
      expect(deleteButtons.length).toBeGreaterThan(0);
      for (const button of deleteButtons) {
        expect(button).toContain('data-confirm=');
      }
      // The "Save details" form opts into the in-place (no full reload) submit.
      expect(res.text).toContain('data-category-details-form');
    });

    it('renders defaults in deterministic display_order then id order', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent } = await authenticate(app);

      const res = await agent.get('/settings/asset-categories').expect(200);
      const order = ['Final', 'WIP', 'KRZ', 'WM', 'WM-LQ'].map((name) => res.text.indexOf(`>${name}<`));
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

  describe('global asset-browser default control', () => {
    it('selects All by default and offers enabled global categories only', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const final = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      await agent.post(`/settings/asset-categories/${final.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get('/settings/asset-categories').expect(200);
      const section = res.text.match(
        /<section class="settings-section asset-browser-default-section" aria-labelledby="global-asset-browser-default-heading">[\s\S]*?<\/section>/
      )?.[0] || '';
      expect(section).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
      expect(section).toMatch(
        /<select id="global-asset-browser-default" name="defaultCategory" class="cc-dropdown-native-select form-control" data-cc-dropdown-native-select/
      );
      expect((section.match(/name="defaultCategory"/g) || [])).toHaveLength(1);
      expect(section).not.toMatch(/<input[^>]*name="defaultCategory"/);
      expect(section).not.toContain('aria-invalid');
      expect(section).toContain('type="radio" value="all" checked');
      expect(res.text).toMatch(/<option value="all" selected>All Categories/);
      expect(res.text).toContain('<option value="wip">WIP');
      expect(res.text).not.toContain('<option value="final">Final');
      expect(res.text).toMatch(/projects set to.*Inherit global default/i);
      expect(res.text).toMatch(/stable directory slug is stored/i);
    });

    it('selects an enabled global slug while displaying the category label', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      await agent.post('/settings/asset-categories/browser-default').type('form')
        .send({ defaultCategory: 'wip', _csrf: csrfToken }).expect(302);

      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(res.text).toMatch(/<option value="wip" selected>WIP/);
      expect(res.text).toContain('Saved:</span> <strong>WIP</strong>');
      expect(getGlobalBrowserDefault(ctx.db)).toBe('wip');
    });

    it('warns for stale, disabled, and malformed stored values without rewriting them', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const final = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');

      ctx.db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run('final', 'asset_browser.default_category');
      await agent.post(`/settings/asset-categories/${final.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      const disabled = await agent.get('/settings/asset-categories').expect(200);
      expect(disabled.text).toMatch(/saved global category is disabled/i);
      expect(disabled.text).toMatch(/Effective:<\/span>\s*<strong>All Categories<\/strong>\s*for inheriting projects/i);
      expect(getGlobalBrowserDefault(ctx.db)).toBe('final');

      ctx.db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run('does-not-exist', 'asset_browser.default_category');
      const stale = await agent.get('/settings/asset-categories').expect(200);
      expect(stale.text).toMatch(/unavailable or was deleted/i);
      expect(getGlobalBrowserDefault(ctx.db)).toBe('does-not-exist');

      ctx.db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run('category:12', 'asset_browser.default_category');
      const malformed = await agent.get('/settings/asset-categories').expect(200);
      expect(malformed.text).toMatch(/saved global default is malformed/i);
      expect(getGlobalBrowserDefault(ctx.db)).toBe('category:12');
    });

    it('saves All and an enabled slug without changing project preference rows or copied categories', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Global Default Independence');
      const categoriesBefore = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);
      const preferenceBefore = getProjectBrowserPreference(ctx.db, projectId);

      const all = await agent.post('/settings/asset-categories/browser-default').type('form')
        .send({ defaultCategory: 'all', _csrf: csrfToken }).expect(302);
      expect(all.headers.location).toBe('/settings/asset-categories?notice=global_default_saved');
      const slug = await agent.post('/settings/asset-categories/browser-default').type('form')
        .send({ defaultCategory: 'wip', _csrf: csrfToken }).expect(302);
      expect(slug.headers.location).toBe('/settings/asset-categories?notice=global_default_saved');

      expect(getGlobalBrowserDefault(ctx.db)).toBe('wip');
      expect(getProjectBrowserPreference(ctx.db, projectId)).toEqual(preferenceBefore);
      expect(ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId))
        .toEqual(categoriesBefore);
    });

    it('rejects unknown and disabled slugs with 422, retaining the submitted value and prior storage', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const finalDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      ctx.db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run('wip', 'asset_browser.default_category');

      const unknown = await agent.post('/settings/asset-categories/browser-default').type('form')
        .send({ defaultCategory: 'unknown-slug', _csrf: csrfToken }).expect(422);
      expect(unknown.text).toContain('unknown-slug');
      expect(unknown.text).toContain('Global preference must be all or an enabled global category slug');
      expect(unknown.text).toMatch(
        /<select id="global-asset-browser-default"[^>]*aria-describedby="global-asset-browser-default-help global-asset-browser-default-error"[^>]*aria-invalid/
      );
      expect(unknown.text).toMatch(
        /<summary[^>]*aria-describedby="global-asset-browser-default-error"[^>]*aria-invalid/
      );
      expect(getGlobalBrowserDefault(ctx.db)).toBe('wip');

      await agent.post(`/settings/asset-categories/${finalDefault.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      const disabled = await agent.post('/settings/asset-categories/browser-default').type('form')
        .send({ defaultCategory: 'final', _csrf: csrfToken }).expect(422);
      expect(disabled.text).toContain('final');
      expect(disabled.text).toContain('selected global category is disabled');
      expect(getGlobalBrowserDefault(ctx.db)).toBe('wip');
    });

    it('requires CSRF and does not render arbitrary notice values', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent } = await authenticate(app);

      await agent.post('/settings/asset-categories/browser-default').type('form')
        .send({ defaultCategory: 'all' }).expect(403);
      const res = await agent.get('/settings/asset-categories?notice=%3Cscript%3Ealert(1)%3C%2Fscript%3E').expect(200);
      expect(res.text).not.toContain('<script>alert(1)</script>');
      expect(res.text).not.toContain('alert(1)');
    });

    it('does not expose a global category using the reserved all slug as a second selectable meaning', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'Ambiguous All', directorySlug: 'all', enabled: 'on', _csrf: csrfToken }).expect(302);
      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(res.text).toMatch(/directory slug .*all.*reserved|reserved.*all.*sentinel/i);
      const browserDefaultSection = res.text.match(
        /<section class="settings-section asset-browser-default-section" aria-labelledby="global-asset-browser-default-heading">[\s\S]*?<\/section>/
      )?.[0] || '';
      expect((browserDefaultSection.match(/<option value="all"/g) || []).length).toBe(1);
    });
  });

  describe('preview category control', () => {
    function previewSection(html) {
      return html.match(
        /<section class="settings-section asset-browser-default-section" aria-labelledby="global-preview-category-heading">[\s\S]*?<\/section>/
      )?.[0] || '';
    }

    it('appears directly after Default category and selects Disabled when unset', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent } = await authenticate(app);

      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(res.text).toMatch(
        /id="global-asset-browser-default-heading"[\s\S]*?<\/section>\s*<section class="settings-section asset-browser-default-section" aria-labelledby="global-preview-category-heading"/
      );
      expect(res.text.indexOf('global-preview-category-heading')).toBeLessThan(
        res.text.indexOf('category-management-add')
      );
      const section = previewSection(res.text);
      expect(section).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
      expect(section).toMatch(
        /<select id="global-preview-category" name="previewCategory" class="cc-dropdown-native-select form-control" data-cc-dropdown-native-select/
      );
      expect((section.match(/name="previewCategory"/g) || [])).toHaveLength(1);
      expect(section).not.toMatch(/<input[^>]*name="previewCategory"/);
      expect(section).not.toContain('aria-invalid');
      expect(section).toContain(
        `<option value="${PREVIEW_CATEGORY_DISABLED_VALUE}" selected>Disabled`
      );
      expect(section).toContain(`type="radio" value="${PREVIEW_CATEGORY_DISABLED_VALUE}" checked`);
      expect(getPreviewCategory(ctx.db)).toBeUndefined();
    });

    it('offers enabled defaults and excludes disabled defaults', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const final = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      await agent.post(`/settings/asset-categories/${final.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const section = previewSection((await agent.get('/settings/asset-categories').expect(200)).text);
      expect(section).toContain('<option value="wip">WIP</option>');
      expect(section).not.toContain('<option value="final">Final</option>');
    });

    it('persists a valid global slug and reflects it on the page without changing the browser default', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const browserDefaultBefore = getGlobalBrowserDefault(ctx.db);

      const response = await agent.post('/settings/asset-categories/preview-category').type('form')
        .send({ previewCategory: 'wip', _csrf: csrfToken }).expect(302);
      expect(response.headers.location).toBe('/settings/asset-categories?notice=preview_category_saved');
      expect(getPreviewCategory(ctx.db)).toBe('wip');
      expect(getGlobalBrowserDefault(ctx.db)).toBe(browserDefaultBefore);

      const section = previewSection((await agent.get('/settings/asset-categories').expect(200)).text);
      expect(section).toContain('<option value="wip" selected>WIP</option>');
      expect(section).toContain('Saved:</span> <strong>WIP</strong>');
      expect((await agent.get(response.headers.location).expect(200)).text).toContain('Preview category saved.');
    });

    it('persists Disabled and turns the preview setting off', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      await agent.post('/settings/asset-categories/preview-category').type('form')
        .send({ previewCategory: 'wip', _csrf: csrfToken }).expect(302);
      await agent.post('/settings/asset-categories/preview-category').type('form')
        .send({ previewCategory: PREVIEW_CATEGORY_DISABLED_VALUE, _csrf: csrfToken }).expect(302);

      expect(getPreviewCategory(ctx.db)).toBe(PREVIEW_CATEGORY_DISABLED_VALUE);
      const section = previewSection((await agent.get('/settings/asset-categories').expect(200)).text);
      expect(section).toContain(`<option value="${PREVIEW_CATEGORY_DISABLED_VALUE}" selected>Disabled`);
    });

    it('rejects unknown, malformed, and disabled submissions with retained values and no overwrite', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const final = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      await agent.post('/settings/asset-categories/preview-category').type('form')
        .send({ previewCategory: 'wip', _csrf: csrfToken }).expect(302);

      const unknown = await agent.post('/settings/asset-categories/preview-category').type('form')
        .send({ previewCategory: 'unknown-slug', _csrf: csrfToken }).expect(422);
      expect(unknown.text).toContain('unknown-slug');
      expect(unknown.text).toContain('Preview category must be Disabled or an enabled global category slug');
      expect(unknown.text).toMatch(
        /<select id="global-preview-category"[^>]*aria-describedby="global-preview-category-help global-preview-category-error"[^>]*aria-invalid/
      );
      expect(unknown.text).toMatch(
        /<summary[^>]*aria-describedby="global-preview-category-error"[^>]*aria-invalid/
      );
      expect(getPreviewCategory(ctx.db)).toBe('wip');

      const malformed = await agent.post('/settings/asset-categories/preview-category').type('form')
        .send({ previewCategory: 'category:12', _csrf: csrfToken }).expect(422);
      expect(malformed.text).toContain('category:12');
      expect(getPreviewCategory(ctx.db)).toBe('wip');

      await agent.post(`/settings/asset-categories/${final.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      const disabled = await agent.post('/settings/asset-categories/preview-category').type('form')
        .send({ previewCategory: 'final', _csrf: csrfToken }).expect(422);
      expect(disabled.text).toContain('final');
      expect(disabled.text).toContain('selected preview category is disabled');
      expect(getPreviewCategory(ctx.db)).toBe('wip');
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
        .send({ displayName: 'Drafts', directorySlug: 'drafts', enabled: '0', _csrf: csrfToken })
        .expect(302);

      const rows = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug IN (?, ?)').all('storyboards', 'drafts');
      const storyboards = rows.find((r) => r.directory_slug === 'storyboards');
      const drafts = rows.find((r) => r.directory_slug === 'drafts');
      expect(storyboards.enabled).toBe(1);
      expect(drafts.enabled).toBe(0);
    });

    it('defaults an omitted enabled field to enabled', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'Drafts', directorySlug: 'drafts', _csrf: csrfToken }).expect(302);

      expect(ctx.db.prepare('SELECT enabled FROM asset_category_defaults WHERE directory_slug = ?').get('drafts').enabled).toBe(1);
    });

    it('retains switch state on add validation failure and rejects malformed values', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const unchecked = await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: '', directorySlug: 'unchecked', enabled: '0', _csrf: csrfToken }).expect(422);
      const uncheckedSwitch = unchecked.text.match(/<input\s+type="checkbox"\s+id="add-enabled"[\s\S]*?>/)?.[0] || '';
      expect(uncheckedSwitch).not.toContain('checked');

      const checked = await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: '', directorySlug: 'checked', enabled: ['0', '1'], _csrf: csrfToken }).expect(422);
      expect(checked.text).toMatch(/<input\s+type="checkbox"\s+id="add-enabled"[\s\S]*?checked/);

      const malformed = await agent.post('/settings/asset-categories').type('form')
        .send({ displayName: 'Malformed', directorySlug: 'malformed', enabled: 'maybe', _csrf: csrfToken }).expect(422);
      expect(malformed.text).toContain('Enabled value must be');
      expect(ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('malformed')).toBeUndefined();
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
        .send({ displayName: 'Dup', directorySlug: 'FINAL', _csrf: csrfToken })
        .expect(422);
      expect(res.text).not.toContain('SQLITE_CONSTRAINT');
      expect(res.text).not.toContain('idx_asset_category_defaults_slug');

      const count = ctx.db.prepare('SELECT COUNT(*) AS c FROM asset_category_defaults WHERE directory_slug = ?').get('final').c;
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
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');

      await agent.post(`/settings/asset-categories/${row.id}`).type('form')
        .send({ displayName: 'Raw Footage', directorySlug: 'final', _csrf: csrfToken })
        .expect(302);

      const updated = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(row.id);
      expect(updated.display_name).toBe('Raw Footage');
    });

    it('changes the directory slug', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');

      await agent.post(`/settings/asset-categories/${row.id}`).type('form')
        .send({ displayName: 'Final', directorySlug: 'raw', _csrf: csrfToken })
        .expect(302);

      const updated = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(row.id);
      expect(updated.directory_slug).toBe('raw');
    });

    it('rejects a case-insensitive slug conflict with another default', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('wip');

      const res = await agent.post(`/settings/asset-categories/${row.id}`).type('form')
        .send({ displayName: 'WIP', directorySlug: 'FINAL', _csrf: csrfToken })
        .expect(422);
      expect(res.text).not.toContain('SQLITE_CONSTRAINT');

      const unchanged = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(row.id);
      expect(unchanged.directory_slug).toBe('wip');
    });

    it('rerenders edit validation errors inside the affected card with retained values', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');

      const res = await agent.post(`/settings/asset-categories/${row.id}`).type('form')
        .send({ displayName: '   ', directorySlug: 'bad slug', _csrf: csrfToken })
        .expect(422);

      const card = res.text.match(
        new RegExp(`<article\\b[^>]*data-category-id="${row.id}"[\\s\\S]*?<\\/article>`)
      )?.[0] || '';
      expect(res.text).toContain('Could not save this category. Fix the fields below and try again.');
      expect(card).toContain(`id="global-category-${row.id}-display-name-error"`);
      expect(card).toContain(`id="global-category-${row.id}-directory-slug-error"`);
      expect(card).toContain('aria-invalid="true"');
      expect(card).toContain('value="   "');
      expect(card).toContain('value="bad slug"');
      expect(card).toContain('>Save details</button>');
    });

    it('leaves already-copied project-owned categories unchanged and performs no filesystem or manifest operation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const projectId = await createProject(agent, csrfToken, 'Edit Independence');
      const projectCategoriesBefore = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);
      expect(projectCategoriesBefore.length).toBeGreaterThan(0);

      const finalDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      const before = fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort();

      await agent.post(`/settings/asset-categories/${finalDefault.id}`).type('form')
        .send({ displayName: 'Renamed Final', directorySlug: 'renamed-final', _csrf: csrfToken })
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
    it('unified switch route parses unchecked and hidden-plus-checked values', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');

      await agent.post(`/settings/asset-categories/${row.id}/enabled`).type('form')
        .send({ enabled: '0', _csrf: csrfToken }).expect(302);
      expect(ctx.db.prepare('SELECT enabled FROM asset_category_defaults WHERE id = ?').get(row.id).enabled).toBe(0);

      await agent.post(`/settings/asset-categories/${row.id}/enabled`).type('form')
        .send({ enabled: ['0', '1'], _csrf: csrfToken }).expect(302);
      expect(ctx.db.prepare('SELECT enabled FROM asset_category_defaults WHERE id = ?').get(row.id).enabled).toBe(1);
    });

    it('rejects malformed switch values with 422 and retains the stored state', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');

      const res = await agent.post(`/settings/asset-categories/${row.id}/enabled`).type('form')
        .send({ enabled: ['0', '1', '1'], _csrf: csrfToken }).expect(422);
      expect(res.text).toContain('Enabled value must be');
      expect(ctx.db.prepare('SELECT enabled FROM asset_category_defaults WHERE id = ?').get(row.id).enabled).toBe(1);
    });

    it('disables an enabled default and re-enables it', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');

      await agent.post(`/settings/asset-categories/${row.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(ctx.db.prepare('SELECT enabled FROM asset_category_defaults WHERE id = ?').get(row.id).enabled).toBe(0);

      await agent.post(`/settings/asset-categories/${row.id}/enable`).type('form').send({ _csrf: csrfToken }).expect(302);
      expect(ctx.db.prepare('SELECT enabled FROM asset_category_defaults WHERE id = ?').get(row.id).enabled).toBe(1);
    });

    it('keeps a disabled default visible in the list', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');

      await agent.post(`/settings/asset-categories/${row.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);
      const res = await agent.get('/settings/asset-categories').expect(200);
      expect(res.text).toContain('Final');
    });

    it('leaves existing project-owned categories unchanged after disabling their default', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const projectId = await createProject(agent, csrfToken, 'Toggle Independence');
      const before = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);

      const finalDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      await agent.post(`/settings/asset-categories/${finalDefault.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const after = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);
      expect(after).toEqual(before);
    });

    it('only enabled defaults are copied into a newly created project', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const finalDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      await agent.post(`/settings/asset-categories/${finalDefault.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const projectId = await createProject(agent, csrfToken, 'Enabled Only Copy');
      const categories = ctx.db.prepare('SELECT directory_slug FROM project_asset_categories WHERE project_id = ?').all(projectId).map((r) => r.directory_slug);
      expect(categories).not.toContain('final');
      expect(categories).toContain('wip');
    });
  });

  // ─── Reorder ──────────────────────────────────────────────────────────────

  describe('reordering', () => {
    function listGlobalRows() {
      return ctx.db.prepare(
        'SELECT * FROM asset_category_defaults ORDER BY display_order ASC, id ASC'
      ).all();
    }

    function listProjectRows(projectId) {
      return ctx.db.prepare(
        'SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id'
      ).all(projectId);
    }

    it('persists a complete valid reorder as contiguous zero-based positions', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const reversed = [...ids].reverse();

      const response = await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: reversed.join(','), _csrf: csrfToken })
        .expect(302);
      expect(response.headers.location).toBe('/settings/asset-categories?notice=category_reordered');

      const rows = ctx.db.prepare('SELECT id, display_order FROM asset_category_defaults ORDER BY display_order').all();
      expect(rows.map((r) => r.id)).toEqual(reversed);
      expect(rows.map((r) => r.display_order)).toEqual(reversed.map((_, i) => i));
    });

    it('persists a valid arbitrary order through the single orderedCategoryIds field', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const rows = listGlobalRows();
      const orderedRows = [rows[2], rows[0], rows[4], rows[1], rows[3]];

      await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: orderedRows.map((row) => row.id).join(','), _csrf: csrfToken })
        .expect(302);

      expect(listGlobalRows().map((row) => row.id)).toEqual(orderedRows.map((row) => row.id));
      expect(listGlobalRows().map((row) => row.display_order)).toEqual([0, 1, 2, 3, 4]);
    });

    it('reorders enabled and disabled defaults together', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const finalDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      await agent.post(`/settings/asset-categories/${finalDefault.id}/disable`).type('form').send({ _csrf: csrfToken }).expect(302);

      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const reversed = [...ids].reverse();

      await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: reversed.join(','), _csrf: csrfToken })
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
        .send({ orderedCategoryIds: malformed.join(','), _csrf: csrfToken })
        .expect(422);
      expect(res.text).toContain('submitted category order is invalid');
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
        .send({ orderedCategoryIds: incomplete.join(','), _csrf: csrfToken })
        .expect(422);
      expect(res.text).toContain('submitted category order is invalid');
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
        .send({ orderedCategoryIds: withUnknown.join(','), _csrf: csrfToken })
        .expect(422);
      expect(res.text).toContain('submitted category order is invalid');
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
        .send({ orderedCategoryIds: malformed.join(','), _csrf: csrfToken })
        .expect(422);
      expect(res.text).toContain('submitted category order is invalid');
      expect(await reorderSnapshot(ctx)).toEqual(before);
    });

    it('rejects missing, empty, decimal, partial, non-positive, unsafe, and repeated-field payloads with 422', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = listGlobalRows().map((row) => row.id);
      const tail = ids.slice(1).join(',');
      const payloads = [
        {},
        { orderedCategoryIds: '' },
        { orderedCategoryIds: `${ids[0]}.5,${tail}` },
        { orderedCategoryIds: `${ids[0]}abc,${tail}` },
        { orderedCategoryIds: `0,${tail}` },
        { orderedCategoryIds: `-1,${tail}` },
        { orderedCategoryIds: `9007199254740992,${tail}` },
        { orderedCategoryIds: [String(ids[0]), ...ids.slice(1).map(String)] },
      ];

      for (const payload of payloads) {
        const res = await agent.post('/settings/asset-categories/reorder').type('form')
          .send({ ...payload, _csrf: csrfToken })
          .expect(422);
        expect(res.text).toContain('submitted category order is invalid');
        expect(res.text).not.toContain('9007199254740992');
      }
    });

    it('rejects project-owned and stale IDs as invalid exact sets without mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Global Reorder Isolation Input');
      await agent.post(`/projects/${projectId}/asset-categories`).type('form')
        .send({ displayName: 'Project Only', directorySlug: 'project-only', _csrf: csrfToken })
        .expect(302);

      const globalIds = listGlobalRows().map((row) => row.id);
      const projectOwnedId = Math.max(...listProjectRows(projectId).map((row) => row.id));
      const before = await reorderSnapshot(ctx);

      const projectOwned = await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: [projectOwnedId, ...globalIds.slice(1)].join(','), _csrf: csrfToken })
        .expect(422);
      expect(projectOwned.text).toContain('submitted category order is invalid');
      expect(await reorderSnapshot(ctx)).toEqual(before);

      ctx.db.prepare('DELETE FROM asset_category_defaults WHERE id = ?').run(globalIds[0]);
      const stale = await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: globalIds.join(','), _csrf: csrfToken })
        .expect(422);
      expect(stale.text).toContain('submitted category order is invalid');
    });

    it('accepts an empty order after the current global set is empty', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      ctx.db.prepare('DELETE FROM asset_category_defaults').run();

      const response = await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: '', _csrf: csrfToken })
        .expect(302);

      expect(response.headers.location).toBe('/settings/asset-categories?notice=category_reordered');
      expect(listGlobalRows()).toEqual([]);
    });

    it('rerenders the list in the new deterministic order after a successful reorder', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const ids = ctx.db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order').all().map((r) => r.id);
      const reversed = [...ids].reverse();

      const response = await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: reversed.join(','), _csrf: csrfToken })
        .expect(302);
      expect(response.headers.location).toBe('/settings/asset-categories?notice=category_reordered');

      const res = await agent.get(response.headers.location).expect(200);
      expect(res.text).toContain('Asset category order updated.');
      const wmLqIdx = res.text.indexOf('>WM-LQ<');
      const finalIdx = res.text.indexOf('>Final<');
      expect(wmLqIdx).toBeGreaterThan(-1);
      expect(finalIdx).toBeGreaterThan(-1);
      expect(wmLqIdx).toBeLessThan(finalIdx);
    });

    it('preserves the global browser default and all existing project state', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const projectId = await createProject(agent, csrfToken, 'Global Reorder Project Isolation');
      const projectCategoriesBefore = listProjectRows(projectId);
      const assignedCategory = projectCategoriesBefore[1];

      await agent.post(`/projects/${projectId}/asset-categories/default`).type('form')
        .send({ defaultCategory: `category:${assignedCategory.id}`, _csrf: csrfToken })
        .expect(302);
      ctx.db.prepare(`
        INSERT INTO assets (
          project_id, category_id, relative_path, nested_path, filename, extension,
          mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        assignedCategory.id,
        `${assignedCategory.directory_slug}/assigned.png`,
        '',
        'assigned.png',
        'png',
        'image/png',
        1,
        null,
        1,
        null,
        null,
      );

      const projectPreferenceBefore = getProjectBrowserPreference(ctx.db, projectId);
      const assetsBefore = ctx.db.prepare(`
        SELECT id, project_id, category_id, relative_path, nested_path, filename,
               extension, mime_type, size_bytes, modified_at, is_present
        FROM assets WHERE project_id = ? ORDER BY id
      `).all(projectId);
      const project = ctx.db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(projectId);
      const projectDir = resolveProjectDir(ctx.projectsRoot, project.project_dir);
      const filesBefore = fs.readdirSync(projectDir, { recursive: true }).sort();
      const manifestBefore = fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8');
      ctx.db.prepare('UPDATE app_meta SET value = ? WHERE key = ?')
        .run('wip', 'asset_browser.default_category');
      const globalPreferenceBefore = getGlobalBrowserDefault(ctx.db);
      const orderedIds = listGlobalRows().map((row) => row.id).reverse();

      await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: orderedIds.join(','), _csrf: csrfToken })
        .expect(302);

      expect(getGlobalBrowserDefault(ctx.db)).toBe(globalPreferenceBefore);
      expect(listProjectRows(projectId)).toEqual(projectCategoriesBefore);
      expect(getProjectBrowserPreference(ctx.db, projectId)).toEqual(projectPreferenceBefore);
      expect(ctx.db.prepare(`
        SELECT id, project_id, category_id, relative_path, nested_path, filename,
               extension, mime_type, size_bytes, modified_at, is_present
        FROM assets WHERE project_id = ? ORDER BY id
      `).all(projectId)).toEqual(assetsBefore);
      expect(fs.readdirSync(projectDir, { recursive: true }).sort()).toEqual(filesBefore);
      expect(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8')).toBe(manifestBefore);
    });

    it('calls the injected batch service once for the complete submitted order', async () => {
      ctx = setupTmp();
      const fake = makeFakeCategoryService([
        { id: 41, display_name: 'One', directory_slug: 'one', display_order: 0, enabled: 1 },
        { id: 42, display_name: 'Two', directory_slug: 'two', display_order: 1, enabled: 1 },
      ]);
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { assetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);

      await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: '42,41', _csrf: csrfToken })
        .expect(302);

      expect(fake.reorderDefaults).toHaveBeenCalledTimes(1);
      expect(fake.reorderDefaults).toHaveBeenCalledWith([42, 41]);
    });

    it('uses a controlled failure notice without exposing unexpected error text', async () => {
      ctx = setupTmp();
      const fake = makeFakeCategoryService();
      fake.reorderDefaults.mockImplementationOnce(() => {
        throw new Error('private database failure detail');
      });
      const app = createApp(
        { appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot },
        { assetCategoryService: fake, authConfig: AUTH_CONFIG }
      );
      const { agent, csrfToken } = await authenticate(app);

      const response = await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: '1', _csrf: csrfToken })
        .expect(302);
      expect(response.headers.location).toBe('/settings/asset-categories?notice=category_reorder_failed');

      const page = await agent.get(response.headers.location).expect(200);
      expect(page.text).toContain('Could not update the order. No changes were made.');
      expect(page.text).not.toContain('private database failure detail');
    });

    it('Move Up/Down controls persist a swap via the same reorder contract', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const wipRow = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('wip');

      await agent.post(`/settings/asset-categories/${wipRow.id}/move-up`).type('form').send({ _csrf: csrfToken }).expect(302);

      const rows = ctx.db.prepare('SELECT directory_slug FROM asset_category_defaults ORDER BY display_order').all();
      expect(rows[0].directory_slug).toBe('wip');
      expect(rows[1].directory_slug).toBe('final');
    });

    it('Move Down preserves the existing boundary and redirect behavior', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const krz = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('krz');

      const response = await agent.post(`/settings/asset-categories/${krz.id}/move-down`)
        .type('form').send({ _csrf: csrfToken }).expect(302);
      expect(response.headers.location).toBe('/settings/asset-categories?notice=category_reordered');

      const rows = ctx.db.prepare('SELECT directory_slug FROM asset_category_defaults ORDER BY display_order').all();
      expect(rows.map((row) => row.directory_slug)).toEqual([
        'final', 'wip', 'wm', 'krz', 'wm-lq',
      ]);
    });

    it('Move Up/Move Down at boundaries remain no-op successful moves', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const first = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      const last = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('wm-lq');
      const before = listGlobalRows().map((row) => row.id);

      await agent.post(`/settings/asset-categories/${first.id}/move-up`).type('form')
        .send({ _csrf: csrfToken }).expect(302);
      await agent.post(`/settings/asset-categories/${last.id}/move-down`).type('form')
        .send({ _csrf: csrfToken }).expect(302);

      expect(listGlobalRows().map((row) => row.id)).toEqual(before);
    });
  });

  // ─── Delete ───────────────────────────────────────────────────────────────

  describe('deleting', () => {
    it('deletes a default', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('wm-lq');

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

    it('leaves existing project-owned categories unchanged after deleting their default, with no directory or manifest mutation', async () => {
      ctx = setupTmp();
      const app = createApp({ appName: APP_NAME, db: ctx.db, projectsRoot: ctx.projectsRoot }, { authConfig: AUTH_CONFIG });
      const { agent, csrfToken } = await authenticate(app);

      const projectId = await createProject(agent, csrfToken, 'Delete Independence');
      const before = ctx.db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY id').all(projectId);
      const beforeFs = fs.readdirSync(ctx.projectsRoot, { recursive: true }).sort();

      const finalDefault = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      await agent.post(`/settings/asset-categories/${finalDefault.id}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);

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
      await agent.post('/settings/asset-categories/reorder').type('form')
        .send({ orderedCategoryIds: '1,2,3,4,5' })
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
      const row = ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE directory_slug = ?').get('final');
      await agent.get(`/settings/asset-categories/${row.id}/delete`).expect(404);
      expect(ctx.db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(row.id)).toBeTruthy();
    });
  });
});
