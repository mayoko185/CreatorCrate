import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { buildAutoRenamePlanRenderModel } from '../src/routes/assets.js';
import { AUTO_RENAME_ERROR_CODES } from '../src/services/auto-rename-service.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('category-scoped Auto Rename HTTP integration', () => {
  let db;
  let app;
  let agent;
  let csrfToken;
  let tmpDir;
  let appDataRoot;
  let projectsRoot;
  let previewRoot;
  let assetRepository;
  let preferenceRepository;

  function projectRecord(projectId) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  }

  async function createProject(title) {
    const response = await agent
      .post('/projects')
      .type('form')
      .send({ title, status: 'tbd', priority: 'normal', _csrf: csrfToken })
      .expect(302);
    const id = Number(response.headers.location.replace('/projects/', ''));
    const project = projectRecord(id);
    return {
      id,
      project,
      projectDir: path.resolve(projectsRoot, project.project_dir),
    };
  }

  function categories(projectId) {
    return db.prepare(
      'SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY display_order ASC, id ASC'
    ).all(projectId);
  }

  function addCategory(projectId, displayName, directorySlug, displayOrder = 99, enabled = 1) {
    return db.prepare(`
      INSERT INTO project_asset_categories
        (project_id, display_name, directory_slug, display_order, enabled)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `).get(projectId, displayName, directorySlug, displayOrder, enabled);
  }

  function writeAsset(projectId, projectDir, relativePath, content = 'asset', overrides = {}) {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const absolutePath = path.join(projectDir, ...normalizedPath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
    const stats = fs.lstatSync(absolutePath);
    const filename = path.posix.basename(normalizedPath);
    const dot = filename.lastIndexOf('.');
    const extension = dot > 0 && dot < filename.length - 1
      ? filename.slice(dot + 1).toLowerCase()
      : '';
    const defaultCategory = categories(projectId)[0];
    return assetRepository.upsert(projectId, normalizedPath, {
      filename,
      extension,
      mimeType: extension === 'png' ? 'image/png' : 'application/octet-stream',
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      categoryId: overrides.categoryId ?? defaultCategory?.id ?? null,
      nestedPath: path.posix.dirname(normalizedPath) === '.' ? '' : path.posix.dirname(normalizedPath),
      ...overrides,
    });
  }

  function previewRequest(projectId, categoryId, orderedAssetIds, extra = {}) {
    return agent
      .post(`/projects/${projectId}/assets/auto-rename/preview`)
      .type('form')
      .send({
        categoryId: String(categoryId),
        orderedAssetIds: JSON.stringify(orderedAssetIds),
        _csrf: csrfToken,
        ...extra,
      });
  }

  function applyRequest(projectId, fields, currentAgent = agent) {
    return currentAgent
      .post(`/projects/${projectId}/assets/auto-rename/apply`)
      .type('form')
      .send(fields);
  }

  function tokenFromConfirmation(html) {
    const match = html.match(/name="planToken" value="([^"]+)"/);
    if (!match) throw new Error('Auto Rename confirmation did not render a plan token.');
    return match[1];
  }

  function hiddenInputValues(html, name) {
    const pattern = new RegExp(
      `<input\\b(?=[^>]*\\btype="hidden")(?=[^>]*\\bname="${name}")(?=[^>]*\\bvalue="([^"]*)")[^>]*>`,
      'g',
    );
    return [...html.matchAll(pattern)].map((match) => match[1]);
  }

  function formMarkup(html, action) {
    return html.match(new RegExp(`<form[^>]*action="${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?<\\/form>`))?.[0];
  }

  function surfaceAssetIds(html) {
    return [...html.matchAll(/data-auto-rename-asset-id="(\d+)"/g)].map((match) => Number(match[1]));
  }

  async function buildInjectedApp(autoRenameService) {
    const isolatedAppDataRoot = path.join(tmpDir, `injected-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(isolatedAppDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(isolatedAppDataRoot);
    const injectedApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { appDataRoot: isolatedAppDataRoot, authState: { csrfPepper }, autoRenameService }
    );
    const csrf = await getDisabledModeCsrf(injectedApp, isolatedAppDataRoot);
    return { app: injectedApp, ...csrf };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auto-rename-http-'));
    appDataRoot = path.join(tmpDir, 'app');
    projectsRoot = path.join(tmpDir, 'projects');
    previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(appDataRoot, { recursive: true });
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(previewRoot, { recursive: true });
    for (const directory of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, directory), { recursive: true });
    }

    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    assetRepository = createAssetRepository(db);
    preferenceRepository = createAssetBrowserPreferenceRepository(db);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      {
        appDataRoot,
        authState: { csrfPepper },
        autoRenameSigningKey: Buffer.from('creatorcrate-http-auto-rename-key'),
      }
    );
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the ordinary results surface for a concrete category with non-default search', async () => {
    const { id, projectDir } = await createProject('Complete Category');
    const category = categories(id)[0];
    const assets = [];
    for (let index = 0; index < 30; index += 1) {
      assets.push(writeAsset(id, projectDir, `category/${String(index).padStart(2, '0')}-asset-${index}.png`, String(index), {
        categoryId: category.id,
      }));
    }
    const expected = assetRepository.findProjectAssetsByCategoryInBrowserOrder(id, category.id).map((asset) => asset.id);

    const response = await agent.get(`/projects/${id}/assets?category=${category.id}&view=list&search=does-not-match&extension=kra&presence=missing&usage=used&page=9&pageSize=1`).expect(200);
    expect(surfaceAssetIds(response.text)).toEqual([]);
    expect(response.text).not.toContain('data-auto-rename-surface');
    expect(response.text).toContain('id="search"');
    expect(response.text).toContain('value="does-not-match"');
    expect(response.text).toContain('No missing assets');
    expect(response.text).not.toContain('Category order');
    expect(response.text).not.toContain('Selection applies to this page');
    expect(expected).toHaveLength(30);
  });

  it('renders the default concrete category completely and strips subset context while retaining view', async () => {
    const { id, projectDir } = await createProject('Default Category');
    const category = categories(id)[0];
    preferenceRepository.upsertProjectPreference(id, 'category', category.id);
    const assets = [
      writeAsset(id, projectDir, 'default/z.png', 'z', { categoryId: category.id }),
      writeAsset(id, projectDir, 'default/a.png', 'a', { categoryId: category.id }),
    ];

    const response = await agent.get(`/projects/${id}/assets?view=grid&search=missing&page=99&pageSize=1`).expect(200);
    expect(surfaceAssetIds(response.text)).toEqual(
      assetRepository.findProjectAssetsByCategoryInBrowserOrder(id, category.id).map((asset) => asset.id),
    );
    expect(response.text).toContain('data-auto-rename-surface');
    expect(response.text).toContain('name="view" value="grid"');
    expect(response.text).toContain('id="search"');
    expect(response.text).toContain('value="filename" selected');
    expect(response.text).not.toContain('name="page"');
    expect(response.text).not.toContain('pagination-info');
    expect(assets).toHaveLength(2);
  });

  it.each(['all', 'uncategorized'])('keeps explicit %s paginated behavior without an Auto Rename surface', async (categoryValue) => {
    const { id, projectDir } = await createProject(`Ordinary ${categoryValue}`);
    const category = categories(id)[0];
    writeAsset(id, projectDir, 'category/one.png', 'one', { categoryId: category.id });
    writeAsset(id, projectDir, 'category/two.png', 'two', { categoryId: category.id });
    if (categoryValue === 'uncategorized') writeAsset(id, projectDir, 'uncategorized.bin', 'u', { categoryId: null });

    const response = await agent.get(`/projects/${id}/assets?category=${categoryValue}&pageSize=1`).expect(200);
    expect(response.text).not.toContain('data-auto-rename-surface');
    expect(response.text).not.toContain('data-auto-rename-drag-handle');
    expect(response.text).not.toContain('name="/projects/');
    expect(response.text).toContain('bulk-select-form');
  });

  it('does not expose ordering for disabled, invalid, cross-project, empty, or archived categories', async () => {
    const owner = await createProject('Unavailable Owner');
    const ownerCategory = categories(owner.id)[0];
    writeAsset(owner.id, owner.projectDir, 'owner.png', 'owner', { categoryId: ownerCategory.id });
    const disabled = addCategory(owner.id, 'Disabled', 'disabled', 3, 0);
    const empty = addCategory(owner.id, 'Empty', 'empty', 4, 1);
    const foreign = await createProject('Unavailable Foreign');
    const foreignCategory = categories(foreign.id)[0];

    for (const categoryId of [disabled.id, empty.id, 999999, foreignCategory.id]) {
      const response = await agent.get(`/projects/${owner.id}/assets?category=${categoryId}`).expect(200);
      expect(response.text).not.toContain('data-auto-rename-surface');
      expect(response.text).not.toContain('data-auto-rename-drag-handle');
    }

    await agent.post(`/projects/${owner.id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
    const archived = await agent.get(`/projects/${owner.id}/assets?category=${ownerCategory.id}`).expect(200);
    expect(archived.text).not.toContain('data-auto-rename-surface');
    expect(archived.text).not.toContain('data-auto-rename-drag-handle');
  });

  it('renders a read-only category confirmation with thumbnails, safe paths, and token-only Apply fields', async () => {
    const { id, projectDir } = await createProject('Confirmation Category');
    const category = categories(id)[0];
    const first = writeAsset(id, projectDir, 'nested/first.png', 'first', { categoryId: category.id });
    const second = writeAsset(id, projectDir, 'nested/second.kra', 'second', {
      categoryId: category.id,
      mimeType: 'application/x-krita',
    });

    const response = await previewRequest(id, category.id, [second.id, first.id], { view: 'list' }).expect(200);
    expect(response.text).toContain('Auto Rename — Confirmation Category');
    expect(response.text).toContain('Confirmation Category');
    expect(response.text).toContain('Source');
    expect(response.text).toContain('nested/first.png');
    expect(response.text).toContain('nested/second.kra');
    expect(response.text).toContain('confirmation-category-source-01.kra');
    expect(response.text).toContain('confirmation-category-source-02.png');
    expect(response.text).toContain('data-preview-enhancement');
    expect(response.text).toContain('data-preview-fallback');
    expect(response.text).not.toContain('data-auto-rename-drag-handle');
    expect(response.text).not.toContain('Move Up');
    expect(response.text).not.toContain('Move Down');
    expect(response.text).not.toContain('draggable');
    expect(response.text).not.toContain('name="orderedAssetIds"');
    expect(response.text).not.toContain('data-auto-rename-proposed-name');
    expect(response.text).not.toContain('data-auto-rename-live');

    const applyForm = formMarkup(response.text, `/projects/${id}/assets/auto-rename/apply`);
    expect(applyForm).toBeDefined();
    expect(hiddenInputValues(applyForm, '_csrf')).toHaveLength(1);
    expect(hiddenInputValues(applyForm, 'planToken')).toHaveLength(1);
    expect(hiddenInputValues(applyForm, 'categoryId')).toEqual([String(category.id)]);
    expect(hiddenInputValues(applyForm, 'view')).toEqual(['list']);
    expect(applyForm).not.toContain('orderedAssetIds');
    expect(applyForm).not.toContain('selectedAssetIds');
    expect(applyForm).not.toContain('proposedFilename');
    expect(applyForm).not.toContain('destinationPath');
  });

  it('rejects malformed JSON before planning and rejects incomplete, duplicate, added, and cross-category orders', async () => {
    const owner = await createProject('Order Validation');
    const category = categories(owner.id)[0];
    const other = addCategory(owner.id, 'Other', 'other', 3, 1);
    const first = writeAsset(owner.id, owner.projectDir, 'first.png', 'first', { categoryId: category.id });
    const second = writeAsset(owner.id, owner.projectDir, 'second.png', 'second', { categoryId: category.id });
    const otherAsset = writeAsset(owner.id, owner.projectDir, 'other.png', 'other', { categoryId: other.id });
    const foreign = await createProject('Order Foreign');
    const foreignCategory = categories(foreign.id)[0];
    const foreignAsset = writeAsset(foreign.id, foreign.projectDir, 'foreign.png');

    const malformed = await agent
      .post(`/projects/${owner.id}/assets/auto-rename/preview`)
      .type('form')
      .send({ categoryId: String(category.id), orderedAssetIds: '[1,]', _csrf: csrfToken })
      .expect(422);
    expect(malformed.text).toContain('must contain every category asset exactly once');

    const stringIds = await previewRequest(owner.id, category.id, [String(first.id), String(second.id)]).expect(422);
    expect(stringIds.text).toContain('must contain every category asset exactly once');
    await previewRequest(owner.id, category.id, [first.id, first.id]).expect(422);
    await previewRequest(owner.id, category.id, [first.id]).expect(422);
    await previewRequest(owner.id, category.id, [first.id, otherAsset.id]).expect(422);
    await previewRequest(owner.id, category.id, [first.id, foreignAsset.id]).expect(422);
    await previewRequest(owner.id, category.id, [first.id, second.id, 999999]).expect(422);

    const invalidCategory = await previewRequest(owner.id, foreignCategory.id, [first.id, second.id]).expect(422);
    expect(invalidCategory.text).toContain('invalid or unavailable');
    expect(other).toMatchObject({ id: expect.any(Number) });
  });

  it('preserves the selected complete order through Preview and token-only Apply', async () => {
    const { id, projectDir, project } = await createProject('Token Order');
    const category = categories(id)[0];
    const first = writeAsset(id, projectDir, 'first.png', 'first', { categoryId: category.id });
    const second = writeAsset(id, projectDir, 'second.png', 'second', { categoryId: category.id });
    const third = writeAsset(id, projectDir, 'third.png', 'third', { categoryId: category.id });
    const order = [third.id, first.id, second.id];

    const preview = await previewRequest(id, category.id, order, { view: 'list', search: 'ignored', page: '7' }).expect(200);
    const token = tokenFromConfirmation(preview.text);
    const apply = await applyRequest(id, {
      _csrf: csrfToken,
      planToken: token,
      categoryId: String(category.id),
      view: 'list',
      orderedAssetIds: JSON.stringify([first.id, second.id, third.id]),
      selectedAssetIds: String(first.id),
      proposedFilename: 'client-supplied.txt',
      destinationPath: 'client-supplied.txt',
      search: 'drop-me',
      page: '9',
    }).expect(302);

    const redirect = new URL(apply.headers.location, 'http://localhost');
    expect(redirect.pathname).toBe(`/projects/${id}/assets`);
    expect(redirect.searchParams.get('category')).toBe(String(category.id));
    expect(redirect.searchParams.get('view')).toBe('list');
    expect(redirect.searchParams.has('search')).toBe(false);
    expect(redirect.searchParams.has('page')).toBe(false);
    expect(redirect.searchParams.has('orderedAssetIds')).toBe(false);
    expect(redirect.searchParams.has('selectedAssetIds')).toBe(false);

    expect(fs.existsSync(path.join(projectDir, 'first.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'second.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'third.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, `${project.slug}-source-01.png`))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, `${project.slug}-source-02.png`))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, `${project.slug}-source-03.png`))).toBe(true);

    const duplicate = await applyRequest(id, { _csrf: csrfToken, planToken: token, categoryId: String(category.id) }).expect(409);
    expect(duplicate.text).toContain('rename preview is no longer current');
    expect(duplicate.text).not.toContain('AUTO_RENAME');
  });

  it('passes only project ID and opaque token to the token-only Apply API', async () => {
    const { id, projectDir } = await createProject('Injected Token Apply');
    const category = categories(id)[0];
    writeAsset(id, projectDir, 'asset.png', 'asset', { categoryId: category.id });
    const calls = [];
    const injected = await buildInjectedApp({
      buildPlan() {},
      applyPlan(...args) {
        calls.push(args);
        return { renamed: 1, unchanged: 0 };
      },
    });

    await applyRequest(id, {
      _csrf: injected.csrfToken,
      planToken: 'opaque-token',
      categoryId: String(category.id),
      orderedAssetIds: '[999]',
      selectedAssetIds: '999',
      categoryIds: String(category.id),
      proposedRelativePath: 'client/path.txt',
    }, injected.agent).expect(302);

    expect(calls).toEqual([[id, 'opaque-token']]);
  });

  it('returns controlled stale and service failures without leaking request or filesystem details', async () => {
    const { id, projectDir } = await createProject('Failure Messages');
    const category = categories(id)[0];
    const asset = writeAsset(id, projectDir, 'source.png', 'source', { categoryId: category.id });
    const preview = await previewRequest(id, category.id, [asset.id]).expect(200);
    const token = tokenFromConfirmation(preview.text);

    db.prepare('UPDATE assets SET filename = ? WHERE id = ?').run('changed.png', asset.id);
    const stale = await applyRequest(id, {
      _csrf: csrfToken,
      planToken: token,
      categoryId: String(category.id),
      orderedAssetIds: '[999]',
      selectedAssetIds: String(asset.id),
    }).expect(409);
    expect(stale.text).toContain('rename preview is no longer current');
    expect(stale.text).not.toContain('999');

    const failing = await buildInjectedApp({
      buildPlan() {},
      applyPlan() {
        const error = new Error(`raw failure ${tmpDir} SQLITE /tmp`);
        error.code = AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED;
        throw error;
      },
    });
    const response = await applyRequest(id, {
      _csrf: failing.csrfToken,
      planToken: 'opaque',
      categoryId: String(category.id),
    }, failing.agent).expect(500);
    expect(response.text).toContain('Auto Rename failed. No files were renamed.');
    expect(response.text).not.toContain('raw failure');
    expect(response.text).not.toContain(tmpDir);
    expect(response.text).not.toContain('SQLITE');
  });

  it('keeps render-model media/path safety independent of filesystem reads', () => {
    const plan = {
      projectId: 42,
      category: { id: 20, displayName: 'Print', directorySlug: 'print' },
      orderedAssetIds: [10, 11],
      items: [
        {
          assetId: 10,
          categoryId: 20,
          categoryDisplayName: 'Print',
          categoryDirectorySlug: 'print',
          currentRelativePath: 'nested/print.kra',
          proposedRelativePath: 'nested/creator-print-01.kra',
          currentFilename: 'print.kra',
          proposedFilename: 'creator-print-01.kra',
          extension: 'kra',
          mimeType: 'application/x-krita',
          presenceState: 'present',
          sizeBytes: 128,
          modifiedAt: '2026-08-02T12:00:00.000Z',
          status: 'rename',
          reason: null,
        },
        {
          assetId: 11,
          categoryId: 20,
          categoryDisplayName: 'Print',
          categoryDirectorySlug: 'print',
          currentRelativePath: 'nested/design.bin',
          proposedRelativePath: null,
          currentFilename: 'design.bin',
          proposedFilename: null,
          extension: 'bin',
          mimeType: 'application/octet-stream',
          presenceState: 'present',
          sizeBytes: 128,
          modifiedAt: '2026-08-02T12:00:00.000Z',
          status: 'blocked',
          reason: 'unsupported-source',
        },
      ],
      counts: { selected: 2, rename: 1, unchanged: 0, blocked: 1 },
    };
    const openSpy = vi.spyOn(fs, 'openSync');
    const model = buildAutoRenamePlanRenderModel(plan);
    expect(model.categoryGroups).toHaveLength(1);
    expect(model.categoryGroups[0].items.map((item) => item.assetId)).toEqual([10, 11]);
    expect(model.items[0].thumbnailUrl).toMatch(/thumbnail\?v=[a-f0-9]{16}$/);
    expect(model.items[1].blockedReason).toContain('regular file');
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
