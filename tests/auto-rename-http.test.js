import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { buildAutoRenamePlanRenderModel } from '../src/routes/assets.js';
import { projectImagePolicyFingerprint, projectImagePresentationPolicy } from '../src/services/project-image-policy.js';
import { AUTO_RENAME_ERROR_CODES, createAutoRenameService } from '../src/services/auto-rename-service.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
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

  it('changes the rendered Auto Rename thumbnail revision when image policy changes', async () => {
    const { id, projectDir } = await createProject('Policy Rename');
    const category = categories(id)[0];
    const asset = writeAsset(id, projectDir, 'source.png', 'image', { categoryId: category.id });
    const thumbnailRevision = (html) => html.match(new RegExp(
      `/projects/${id}/assets/${asset.id}/thumbnail\\?v=([a-f0-9]{16})`,
    ))?.[1];
    const before = await previewRequest(id, category.id, [asset.id]).expect(200);
    const previous = thumbnailRevision(before.text);
    expect(previous).toMatch(/^[a-f0-9]{16}$/);
    createAppMetaRepository(db).setValue('images.thumbnail.max_dimension', '128');
    const after = await previewRequest(id, category.id, [asset.id]).expect(200);
    expect(thumbnailRevision(after.text)).toMatch(/^[a-f0-9]{16}$/);
    expect(thumbnailRevision(after.text)).not.toBe(previous);
  });

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

  // The attempt this rendered review issued; every Apply must name it.
  function attemptFromConfirmation(html) {
    const matches = [...html.matchAll(/name="attemptId" value="([0-9a-f]{32})"/g)];
    if (matches.length !== 1) throw new Error('Auto Rename confirmation did not render exactly one attempt.');
    return matches[0][1];
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

  function decodeHtmlAttribute(value) {
    return value
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  // Collects a rendered form's enabled hidden inputs in document order, as a
  // browser submission would.
  function hiddenFormFields(form) {
    const fields = new URLSearchParams();
    for (const [input] of form.matchAll(/<input\b(?=[^>]*\btype="hidden")[^>]*>/g)) {
      if (/\sdisabled\b/.test(input)) continue;
      const name = input.match(/\bname="([^"]*)"/)?.[1];
      const value = input.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
      if (name) fields.append(decodeHtmlAttribute(name), decodeHtmlAttribute(value));
    }
    return fields;
  }

  function autoRenamePreviewForm(html) {
    return html.match(/<form id="auto-rename-assets-form"[\s\S]*?<\/form>/)?.[0];
  }

  function autoRenameCancelUrl(html) {
    const href = html.match(/<a class="button button-secondary" href="([^"]+)">Cancel<\/a>/)?.[1];
    return href ? new URL(decodeHtmlAttribute(href), 'http://localhost') : null;
  }

  function browsingContextParams(url) {
    return [...url.searchParams.entries()]
      .filter(([key]) => key !== 'notice' && !key.startsWith('auto_rename_'));
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

  // The real service with a fixed key, so identical inputs sign identical
  // plans; hooks inject faults into its own phase-two and compensation moves.
  function realAutoRenameService({ hooks = {}, coordinator = createProjectOperationCoordinator() } = {}) {
    return createAutoRenameService({
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectRepository: createProjectRepository(db),
      assetRepository,
      assetCategoryRepository: createAssetCategoryRepository(db),
      projectsRoot,
      projectOperationCoordinator: coordinator,
      signingKey: Buffer.from('creatorcrate-auto-rename-attempt-key'),
      _hooks: hooks,
    });
  }

  // A native review on an injected app; its rendered form is what a browser
  // without JavaScript would submit.
  async function nativeInjectedPreview(injected, projectId, categoryId, orderedAssetIds) {
    return (await injected.agent
      .post(`/projects/${projectId}/assets/auto-rename/preview`)
      .type('form')
      .send({ categoryId: String(categoryId), orderedAssetIds: JSON.stringify(orderedAssetIds), _csrf: injected.csrfToken })
      .expect(200)).text;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auto-rename-http-'));
    appDataRoot = path.join(tmpDir, 'app');
    projectsRoot = path.join(tmpDir, 'projects');
    previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(appDataRoot, { recursive: true });
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(previewRoot, { recursive: true });

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

  it('renders the confirmation dialog on the project assets page with thumbnails and token-only Apply fields', async () => {
    const { id, projectDir } = await createProject('Confirmation Category');
    const category = categories(id)[0];
    const first = writeAsset(id, projectDir, 'nested/first.png', 'first', { categoryId: category.id });
    const second = writeAsset(id, projectDir, 'nested/second.kra', 'second', {
      categoryId: category.id,
      mimeType: 'application/x-krita',
    });

    const response = await previewRequest(id, category.id, [second.id, first.id], { view: 'list' }).expect(200);
    expect(response.text).toContain('Assets — Confirmation Category');
    expect(response.text).toContain('id="auto-rename-confirmation-dialog" class="app-dialog" data-app-dialog open');
    expect(response.text).toContain('aria-labelledby="auto-rename-confirmation-dialog-title"');
    expect(response.text).toContain('aria-describedby="auto-rename-confirmation-description"');
    expect(response.text).toContain('id="auto-rename-confirmation-description"');
    expect(response.text).toContain('data-dialog-async="false"');
    expect(response.text).toContain('Confirmation Category');
    expect(response.text).toContain('first.png');
    expect(response.text).toContain('second.kra');
    expect(response.text).toContain(`confirmation-category-${category.directory_slug}-01.kra`);
    expect(response.text).toContain(`confirmation-category-${category.directory_slug}-02.png`);
    expect(response.text).toContain('auto-rename-confirmation-names');
    expect(response.text).toContain('status-badge status-badge--success');
    expect(response.text).not.toContain('data-auto-rename-drag-handle');
    expect(response.text).not.toContain('Move Up');
    expect(response.text).not.toContain('Move Down');
    expect(response.text).not.toContain('data-auto-rename-proposed-name');

    const applyForm = formMarkup(response.text, `/projects/${id}/assets/auto-rename/apply`);
    expect(applyForm).toBeDefined();
    expect(hiddenInputValues(applyForm, '_csrf')).toHaveLength(1);
    expect(hiddenInputValues(applyForm, 'planToken')).toHaveLength(1);
    expect(hiddenInputValues(applyForm, 'categoryId')).toEqual([String(category.id)]);
    expect(hiddenInputValues(applyForm, 'view')).toEqual(['list']);
    expect(response.text).toContain(`href="/projects/${id}/assets?category=${category.id}&amp;view=list"`);
    expect(applyForm).not.toContain('orderedAssetIds');
    expect(applyForm).not.toContain('selectedAssetIds');
    expect(applyForm).not.toContain('proposedFilename');
    expect(applyForm).not.toContain('destinationPath');
  });

  it('previews and applies only selected assets with selected-only numbering', async () => {
    const { id, projectDir, project } = await createProject('Selected Subset');
    const category = categories(id)[0];
    const assets = [
      writeAsset(id, projectDir, 'first.png', 'first', { categoryId: category.id }),
      writeAsset(id, projectDir, 'second.png', 'second', { categoryId: category.id }),
      writeAsset(id, projectDir, 'third.png', 'third', { categoryId: category.id }),
      writeAsset(id, projectDir, 'fourth.png', 'fourth', { categoryId: category.id }),
      writeAsset(id, projectDir, 'fifth.png', 'fifth', { categoryId: category.id }),
    ];
    const order = assets.map((asset) => asset.id);
    const selectedAssetIds = [assets[2].id, assets[4].id];
    const generatedPrefix = `${project.slug}-${category.directory_slug}`;

    const preview = await previewRequest(id, category.id, order, {
      selectedAssetIds: JSON.stringify(selectedAssetIds),
      view: 'list',
    }).expect(200);
    const confirmationForm = formMarkup(preview.text, `/projects/${id}/assets/auto-rename/apply`);
    expect(confirmationForm).toContain('2 assets:');
    expect(confirmationForm).toContain('2 to rename');
    expect(confirmationForm).toContain('0 unchanged');
    expect(confirmationForm).toContain(assets[2].filename);
    expect(confirmationForm).toContain(assets[4].filename);
    expect(confirmationForm).not.toContain(assets[0].filename);
    expect(confirmationForm).not.toContain(assets[1].filename);
    expect(confirmationForm).not.toContain(assets[3].filename);
    expect(confirmationForm).toContain(`${generatedPrefix}-01.png`);
    expect(confirmationForm).toContain(`${generatedPrefix}-02.png`);
    const token = tokenFromConfirmation(preview.text);

    await applyRequest(id, {
      _csrf: csrfToken,
      planToken: token,
      attemptId: attemptFromConfirmation(preview.text),
      categoryId: String(category.id),
    }).expect(302);

    expect(fs.existsSync(path.join(projectDir, 'first.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'second.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'third.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'fourth.png'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'fifth.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, `${generatedPrefix}-01.png`))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, `${generatedPrefix}-02.png`))).toBe(true);
    expect(assetRepository.findById(assets[2].id)).toMatchObject({
      relative_path: `${generatedPrefix}-01.png`,
    });
    expect(assetRepository.findById(assets[4].id)).toMatchObject({
      relative_path: `${generatedPrefix}-02.png`,
    });
    expect(assetRepository.findById(assets[0].id)).toMatchObject({ relative_path: 'first.png' });
    expect(assetRepository.findById(assets[1].id)).toMatchObject({ relative_path: 'second.png' });
    expect(assetRepository.findById(assets[3].id)).toMatchObject({ relative_path: 'fourth.png' });
  });

  it('keeps blocked and no-change confirmation plans unappliable', async () => {
    const blockedProject = await createProject('Blocked Confirmation');
    const blockedCategory = categories(blockedProject.id)[0];
    writeAsset(blockedProject.id, blockedProject.projectDir, 'missing.png', 'missing', {
      categoryId: blockedCategory.id,
    });
    fs.rmSync(path.join(blockedProject.projectDir, 'missing.png'));

    const blockedResponse = await previewRequest(
      blockedProject.id,
      blockedCategory.id,
      [assetRepository.findProjectAssetsByCategoryInBrowserOrder(blockedProject.id, blockedCategory.id)[0].id],
    ).expect(200);
    const blockedForm = formMarkup(blockedResponse.text, `/projects/${blockedProject.id}/assets/auto-rename/apply`);
    expect(blockedResponse.text).toContain('one or more category assets are blocked');
    expect(blockedResponse.text).toContain('Apply is unavailable until all blocked category assets are resolved.');
    expect(blockedForm).toMatch(/<button[^>]*disabled[^>]*>Apply Auto Rename<\/button>/);
    await applyRequest(blockedProject.id, {
      _csrf: csrfToken,
      planToken: tokenFromConfirmation(blockedResponse.text),
      attemptId: attemptFromConfirmation(blockedResponse.text),
      categoryId: String(blockedCategory.id),
    }).expect(409);

    const unchangedProject = await createProject('No Change Confirmation');
    const unchangedCategory = categories(unchangedProject.id)[0];
    const unchangedFilename = `${unchangedProject.project.slug}-${unchangedCategory.directory_slug}-01.png`;
    const unchanged = writeAsset(
      unchangedProject.id,
      unchangedProject.projectDir,
      `${unchangedCategory.directory_slug}/${unchangedFilename}`,
      'unchanged',
      { categoryId: unchangedCategory.id },
    );

    const unchangedResponse = await previewRequest(
      unchangedProject.id,
      unchangedCategory.id,
      [unchanged.id],
    ).expect(200);
    const unchangedForm = formMarkup(unchangedResponse.text, `/projects/${unchangedProject.id}/assets/auto-rename/apply`);
    expect(unchangedResponse.text).toContain('There are no changes to apply because all category assets are unchanged.');
    expect(unchangedForm).toMatch(/<button[^>]*disabled[^>]*>Apply Auto Rename<\/button>/);
    await applyRequest(unchangedProject.id, {
      _csrf: csrfToken,
      planToken: tokenFromConfirmation(unchangedResponse.text),
      attemptId: attemptFromConfirmation(unchangedResponse.text),
      categoryId: String(unchangedCategory.id),
    }).expect(409);
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
    expect(malformed.text).not.toContain('id="auto-rename-confirmation-dialog" class="app-dialog" data-app-dialog open');

    const malformedSelection = await previewRequest(owner.id, category.id, [first.id, second.id], {
      selectedAssetIds: '[1,]',
    }).expect(422);
    expect(malformedSelection.text).toContain('must contain every category asset exactly once');

    const stringIds = await previewRequest(owner.id, category.id, [String(first.id), String(second.id)]).expect(422);
    expect(stringIds.text).toContain('must contain every category asset exactly once');
    await previewRequest(owner.id, category.id, [first.id, first.id]).expect(422);
    await previewRequest(owner.id, category.id, [first.id]).expect(422);
    await previewRequest(owner.id, category.id, [first.id, otherAsset.id]).expect(422);
    await previewRequest(owner.id, category.id, [first.id, foreignAsset.id]).expect(422);
    await previewRequest(owner.id, category.id, [first.id, second.id, 999999]).expect(422);
    await previewRequest(owner.id, category.id, [first.id, second.id], {
      selectedAssetIds: JSON.stringify([otherAsset.id]),
    }).expect(422);
    await previewRequest(owner.id, category.id, [first.id, second.id], {
      selectedAssetIds: JSON.stringify([foreignAsset.id]),
    }).expect(422);

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
    const attemptId = attemptFromConfirmation(preview.text);
    const apply = await applyRequest(id, {
      _csrf: csrfToken,
      planToken: token,
      attemptId,
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
    // Supported browsing context round-trips; Auto Rename plan fields do not.
    expect(redirect.searchParams.get('search')).toBe('drop-me');
    expect(redirect.searchParams.get('page')).toBe('9');
    expect(redirect.searchParams.has('orderedAssetIds')).toBe(false);
    expect(redirect.searchParams.has('selectedAssetIds')).toBe(false);

    expect(fs.existsSync(path.join(projectDir, 'first.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'second.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'third.png'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, `${project.slug}-${category.directory_slug}-01.png`))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, `${project.slug}-${category.directory_slug}-02.png`))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, `${project.slug}-${category.directory_slug}-03.png`))).toBe(true);

    // Resubmitting the same reviewed form is refused as already used.
    const duplicate = await applyRequest(id, {
      _csrf: csrfToken, planToken: token, attemptId, categoryId: String(category.id),
    }).expect(409);
    expect(duplicate.text).toContain('already submitted, so it was not applied again');
    expect(duplicate.text).not.toContain('AUTO_RENAME');
    expect(fs.existsSync(path.join(projectDir, `${project.slug}-${category.directory_slug}-01.png`))).toBe(true);

    // The old token paired with a later review's attempt is not that review.
    const freshAttempt = attemptFromConfirmation(
      (await previewRequest(id, category.id, order, { view: 'list' }).expect(200)).text,
    );
    const stale = await applyRequest(id, {
      _csrf: csrfToken, planToken: token, attemptId: freshAttempt, categoryId: String(category.id),
    }).expect(409);
    expect(stale.text).toContain('review is no longer available. No files were renamed.');
  });

  it('passes only project ID and opaque token to the token-only Apply API', async () => {
    const { id, projectDir } = await createProject('Injected Token Apply');
    const category = categories(id)[0];
    const asset = writeAsset(id, projectDir, 'asset.png', 'asset', { categoryId: category.id });
    const calls = [];
    const planner = realAutoRenameService();
    const injected = await buildInjectedApp({
      buildPlan: (input) => ({ ...planner.buildPlan(input), token: 'opaque-token' }),
      applyPlan(...args) {
        calls.push(args);
        return { renamed: 1, unchanged: 0 };
      },
    });
    const preview = await nativeInjectedPreview(injected, id, category.id, [asset.id]);

    await applyRequest(id, {
      _csrf: injected.csrfToken,
      planToken: tokenFromConfirmation(preview),
      attemptId: attemptFromConfirmation(preview),
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
      attemptId: attemptFromConfirmation(preview.text),
      categoryId: String(category.id),
      orderedAssetIds: '[999]',
      selectedAssetIds: String(asset.id),
    }).expect(409);
    expect(stale.text).toContain('rename preview is no longer current');
    expect(stale.text).not.toContain('999');

    const planner = realAutoRenameService();
    const failing = await buildInjectedApp({
      buildPlan: (input) => ({ ...planner.buildPlan(input), token: 'opaque' }),
      applyPlan() {
        const error = new Error(`raw failure ${tmpDir} SQLITE /tmp`);
        error.code = AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED;
        throw error;
      },
    });
    const failingPreview = await nativeInjectedPreview(failing, id, category.id, [asset.id]);
    const response = await applyRequest(id, {
      _csrf: failing.csrfToken,
      planToken: tokenFromConfirmation(failingPreview),
      attemptId: attemptFromConfirmation(failingPreview),
      categoryId: String(category.id),
    }, failing.agent).expect(500);
    expect(response.text).toContain('Auto Rename failed. No files were renamed.');
    expect(response.text).not.toContain('raw failure');
    expect(response.text).not.toContain(tmpDir);
    expect(response.text).not.toContain('SQLITE');

  });

  it('reports ownership failures distinctly for Preview and Apply without renaming anything', async () => {
    const { id, projectDir } = await createProject('Ownership Conflict');
    const category = categories(id)[0];
    const asset = writeAsset(id, projectDir, 'source.png', 'source', { categoryId: category.id });
    const preview = await previewRequest(id, category.id, [asset.id]).expect(200);
    const token = tokenFromConfirmation(preview.text);
    // Another project's marker now sits at this project's root.
    fs.writeFileSync(path.join(projectDir, '.creatorcrate-owner'), `creatorcrate-owner/1 ${'c'.repeat(64)}\n`);

    const refusedPreview = await previewRequest(id, category.id, [asset.id]).expect(409);
    expect(refusedPreview.text).toContain('could not verify that the project folder belongs to this project');
    const refusedApply = await applyRequest(id, {
      _csrf: csrfToken, planToken: token, attemptId: attemptFromConfirmation(preview.text), categoryId: String(category.id),
    }).expect(409);
    expect(refusedApply.text).toContain('could not verify that the project folder belongs to this project. No files were renamed.');
    expect(refusedApply.text).not.toContain('PROJECT_OWNERSHIP');
    expect(fs.existsSync(path.join(projectDir, 'source.png'))).toBe(true);
    expect(assetRepository.findById(asset.id).relative_path).toBe('source.png');
  });

  describe('browsing context through Preview, Cancel and Apply', () => {
    async function filteredCategoryProject(title) {
      const created = await createProject(title);
      const category = categories(created.id)[0];
      const assets = [
        writeAsset(created.id, created.projectDir, 'one.png', 'one', { categoryId: category.id }),
        writeAsset(created.id, created.projectDir, 'two.png', 'two', { categoryId: category.id }),
        writeAsset(created.id, created.projectDir, 'three.kra', 'three', {
          categoryId: category.id,
          mimeType: 'application/x-krita',
        }),
      ];
      return { ...created, category, assets };
    }

    function postForm(url, fields) {
      return agent.post(url).type('form').send(fields.toString());
    }

    it('round-trips explicit filters, sort, view and page size without duplicate or plan fields', async () => {
      const { id, project, projectDir, category } = await filteredCategoryProject('Filtered Context');
      const browse = await agent
        .get(`/projects/${id}/assets?category=${category.id}&extension=png&sort=modified&order=desc&view=list&pageSize=50`)
        .expect(200);

      // The Preview request carries the active browsing context.
      const previewForm = autoRenamePreviewForm(browse.text);
      expect(previewForm).toBeDefined();
      const previewFields = hiddenFormFields(previewForm);
      expect(previewFields.getAll('categoryId')).toEqual([String(category.id)]);
      expect(previewFields.getAll('extension')).toEqual(['png']);
      expect(previewFields.getAll('sort')).toEqual(['modified']);
      expect(previewFields.getAll('order')).toEqual(['desc']);
      expect(previewFields.getAll('view')).toEqual(['list']);
      expect(previewFields.getAll('pageSize')).toEqual(['50']);
      expect(previewFields.has('inheritedFilterDefaults')).toBe(false);
      // categoryId stays the only category field; plan contract fields stay single.
      expect(previewFields.has('category')).toBe(false);
      for (const name of ['_csrf', 'orderedAssetIds', 'selectedAssetIds', 'view', 'sort', 'order', 'page', 'pageSize']) {
        expect(previewFields.getAll(name).length).toBeLessThanOrEqual(1);
      }
      for (const name of ['_csrf', 'orderedAssetIds', 'selectedAssetIds']) {
        expect(previewFields.getAll(name)).toHaveLength(1);
      }

      const preview = await postForm(`/projects/${id}/assets/auto-rename/preview`, previewFields).expect(200);
      expect(preview.text).toContain('id="auto-rename-confirmation-dialog" class="app-dialog" data-app-dialog open');

      // Cancel returns to the same category, filters, sort, view and page size.
      const cancelUrl = autoRenameCancelUrl(preview.text);
      expect(cancelUrl.pathname).toBe(`/projects/${id}/assets`);
      expect(cancelUrl.searchParams.get('category')).toBe(String(category.id));
      expect(cancelUrl.searchParams.getAll('extension')).toEqual(['png']);
      expect(cancelUrl.searchParams.get('sort')).toBe('modified');
      expect(cancelUrl.searchParams.get('order')).toBe('desc');
      expect(cancelUrl.searchParams.get('view')).toBe('list');
      expect(cancelUrl.searchParams.get('pageSize')).toBe('50');
      expect(cancelUrl.searchParams.has('inheritedFilterDefaults')).toBe(false);

      const applyFields = hiddenFormFields(formMarkup(preview.text, `/projects/${id}/assets/auto-rename/apply`));
      expect(applyFields.getAll('_csrf')).toHaveLength(1);
      expect(applyFields.getAll('planToken')).toHaveLength(1);
      expect(applyFields.getAll('categoryId')).toEqual([String(category.id)]);
      expect(applyFields.has('category')).toBe(false);
      expect(applyFields.getAll('view')).toEqual(['list']);
      expect(applyFields.getAll('extension')).toEqual(['png']);
      expect(applyFields.getAll('sort')).toEqual(['modified']);
      expect(applyFields.getAll('order')).toEqual(['desc']);
      for (const name of ['orderedAssetIds', 'selectedAssetIds', 'proposedFilename', 'destinationPath']) {
        expect(applyFields.has(name)).toBe(false);
      }

      // Apply lands on the Cancel context; the explicit extension stays explicit.
      const apply = await postForm(`/projects/${id}/assets/auto-rename/apply`, applyFields).expect(302);
      const redirect = new URL(apply.headers.location, 'http://localhost');
      expect(redirect.pathname).toBe(`/projects/${id}/assets`);
      expect(redirect.searchParams.get('notice')).toBe('auto-rename-success');
      expect(browsingContextParams(redirect)).toEqual(browsingContextParams(cancelUrl));
      for (const original of ['one.png', 'two.png', 'three.kra']) {
        expect(fs.existsSync(path.join(projectDir, original))).toBe(false);
      }
      expect(fs.readdirSync(projectDir).filter((name) => name.startsWith(`${project.slug}-${category.directory_slug}-`)))
        .toHaveLength(3);

      const landed = await agent.get(apply.headers.location).expect(200);
      expect(hiddenFormFields(autoRenamePreviewForm(landed.text)).getAll('extension')).toEqual(['png']);
      expect(landed.text).not.toContain('name="inheritedFilterDefaults"');
    });

    it('keeps saved inherited defaults marked through Preview, Cancel and Apply', async () => {
      const { id, category, assets } = await filteredCategoryProject('Inherited Context');
      db.prepare(`
        INSERT INTO app_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(PAGE_DEFAULT_DEFINITIONS.projectAssets.extension.key, 'png');

      const browse = await agent
        .get(`/projects/${id}/assets?category=${category.id}&view=list&inheritedFilterDefaults=extension`)
        .expect(200);
      // The inherited extension stays suspended for a concrete category.
      expect([...surfaceAssetIds(browse.text)].sort()).toEqual(assets.map((asset) => asset.id).sort());

      const previewFields = hiddenFormFields(autoRenamePreviewForm(browse.text));
      expect(previewFields.getAll('inheritedFilterDefaults')).toEqual(['extension']);
      expect(previewFields.has('extension')).toBe(false);
      expect(previewFields.getAll('view')).toEqual(['list']);
      expect(previewFields.has('category')).toBe(false);

      const preview = await postForm(`/projects/${id}/assets/auto-rename/preview`, previewFields).expect(200);
      const cancelUrl = autoRenameCancelUrl(preview.text);
      expect(cancelUrl.searchParams.get('category')).toBe(String(category.id));
      expect(cancelUrl.searchParams.get('inheritedFilterDefaults')).toBe('extension');
      expect(cancelUrl.searchParams.has('extension')).toBe(false);

      const applyFields = hiddenFormFields(formMarkup(preview.text, `/projects/${id}/assets/auto-rename/apply`));
      expect(applyFields.getAll('inheritedFilterDefaults')).toEqual(['extension']);
      expect(applyFields.has('extension')).toBe(false);

      const apply = await postForm(`/projects/${id}/assets/auto-rename/apply`, applyFields).expect(302);
      const redirect = new URL(apply.headers.location, 'http://localhost');
      expect(browsingContextParams(redirect)).toEqual(browsingContextParams(cancelUrl));
      expect(redirect.searchParams.get('inheritedFilterDefaults')).toBe('extension');
      expect(redirect.searchParams.has('extension')).toBe(false);
    });

    it('preserves the browsing context when Preview validation and stale Apply re-render the page', async () => {
      const { id, category, assets } = await filteredCategoryProject('Error Context');
      const context = { extension: 'png', sort: 'modified', order: 'desc', view: 'list', search: 'o' };
      const browserFormFields = (html) => hiddenFormFields(formMarkup(html, `/projects/${id}/assets/add-to-release`));
      const expectContext = (fields) => {
        expect(fields.getAll('category')).toEqual([String(category.id)]);
        expect(fields.getAll('extension')).toEqual(['png']);
        expect(fields.getAll('sort')).toEqual(['modified']);
        expect(fields.getAll('order')).toEqual(['desc']);
        expect(fields.getAll('view')).toEqual(['list']);
        expect(fields.getAll('search')).toEqual(['o']);
      };

      const invalid = await previewRequest(id, category.id, [assets[0].id], context).expect(422);
      expect(invalid.text).toContain('must contain every category asset exactly once');
      expectContext(browserFormFields(invalid.text));

      const preview = await previewRequest(id, category.id, assets.map((asset) => asset.id), context).expect(200);
      const applyFields = hiddenFormFields(formMarkup(preview.text, `/projects/${id}/assets/auto-rename/apply`));
      db.prepare('UPDATE assets SET filename = ? WHERE id = ?').run('changed.png', assets[0].id);
      const stale = await postForm(`/projects/${id}/assets/auto-rename/apply`, applyFields).expect(409);
      expect(stale.text).toContain('rename preview is no longer current');
      expectContext(browserFormFields(stale.text));
    });

    it('rebuilds the Apply redirect only from allowlisted context fields', async () => {
      const { id, category, assets } = await filteredCategoryProject('Allowlisted Context');
      const planner = realAutoRenameService();
      const injected = await buildInjectedApp({
        buildPlan: (input) => ({ ...planner.buildPlan(input), token: 'opaque-token' }),
        applyPlan() { return { renamed: 1, unchanged: 0 }; },
      });
      const preview = await nativeInjectedPreview(injected, id, category.id, assets.map((asset) => asset.id));
      const fields = new URLSearchParams({
        _csrf: injected.csrfToken,
        planToken: tokenFromConfirmation(preview),
        attemptId: attemptFromConfirmation(preview),
        categoryId: String(category.id),
        category: '999999',
        view: 'list',
        returnTo: '/elsewhere',
        notice: 'injected',
        defaults: '1',
        inheritedFilterDefaults: 'extension,bogus',
      });
      fields.append('search[nested]', 'object');

      const apply = await injected.agent
        .post(`/projects/${id}/assets/auto-rename/apply`)
        .type('form')
        .send(fields.toString())
        .expect(302);
      const redirect = new URL(apply.headers.location, 'http://localhost');
      expect(redirect.pathname).toBe(`/projects/${id}/assets`);
      expect(redirect.searchParams.get('category')).toBe(String(category.id));
      expect(redirect.searchParams.get('view')).toBe('list');
      expect(redirect.searchParams.get('notice')).toBe('auto-rename-success');
      expect(redirect.searchParams.get('inheritedFilterDefaults')).toBe('extension');
      for (const key of ['returnTo', 'defaults', 'search', 'search[nested]', 'categoryId', 'planToken', 'attemptId', '_csrf']) {
        expect(redirect.searchParams.has(key)).toBe(false);
      }
    });
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
    const basePolicy = {
      thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
      preview: { format: 'webp', webpQuality: 90, maxDimension: 1600 },
    };
    const firstPolicy = buildAutoRenamePlanRenderModel(plan, projectImagePolicyFingerprint(basePolicy));
    const secondPolicy = buildAutoRenamePlanRenderModel(plan, projectImagePolicyFingerprint({
      ...basePolicy, thumbnail: { ...basePolicy.thumbnail, webpQuality: 70 },
    }));
    expect(firstPolicy.items[0].thumbnailUrl).not.toBe(secondPolicy.items[0].thumbnailUrl);
    const pngPolicy = { ...basePolicy, preview: { ...basePolicy.preview, format: 'png' } };
    const withQuality = { ...pngPolicy, preview: { ...pngPolicy.preview, webpQuality: 71 } };
    for (const [sourceAnimated, changes] of [[0, false], [1, true]]) {
      const sourcePlan = { ...plan, items: [{ ...plan.items[0], sourceAnimated }] };
      const before = buildAutoRenamePlanRenderModel(sourcePlan, projectImagePresentationPolicy(pngPolicy));
      const after = buildAutoRenamePlanRenderModel(sourcePlan, projectImagePresentationPolicy(withQuality));
      expect(before.items[0].previewRevision === after.items[0].previewRevision).toBe(!changes);
    }
    expect(model.items[1].blockedReason).toContain('regular file');
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();

    const selectedModel = buildAutoRenamePlanRenderModel({
      ...plan,
      selectedAssetIds: [11],
    });
    expect(selectedModel.selectionMode).toBe('selected');
    expect(selectedModel.orderedAssetIds).toEqual([10, 11]);
    expect(selectedModel.items.map((item) => item.assetId)).toEqual([11]);
    expect(selectedModel.items[0].status).toBe('blocked');
  });

  describe('JSON Preview, Apply and state for the local review', () => {
    function jsonPreview(projectId, categoryId, orderedAssetIds, extra = {}) {
      return agent
        .post(`/projects/${projectId}/assets/auto-rename/preview`)
        .set('Accept', 'application/json')
        .type('form')
        .send({
          categoryId: String(categoryId),
          orderedAssetIds: JSON.stringify(orderedAssetIds),
          _csrf: csrfToken,
          ...extra,
        });
    }

    function jsonApply(projectId, fields, currentAgent = agent) {
      return currentAgent
        .post(`/projects/${projectId}/assets/auto-rename/apply`)
        .set('Accept', 'application/json')
        .type('form')
        .send(fields);
    }

    async function fourAssetCategory(title) {
      const created = await createProject(title);
      const category = categories(created.id)[0];
      const dir = category.directory_slug;
      const [a, b, c, d] = ['a.png', 'b.jpg', 'c.png', 'd.jpg'].map((name) => writeAsset(
        created.id, created.projectDir, `${dir}/${name}`, name, { categoryId: category.id },
      ));
      const generated = (number, extension) => `${created.project.slug}-${dir}-${String(number).padStart(2, '0')}.${extension}`;
      return { ...created, category, dir, a, b, c, d, generated };
    }

    const leaks = (text, value) => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1));

    it('returns the reviewed complete order, the visible selection and the async confirmation fragment', async () => {
      const f = await fourAssetCategory('Json Preview');
      // Filtered to A and C, reordered C, A: the complete order keeps B and D in place.
      const order = [f.c.id, f.b.id, f.a.id, f.d.id];
      const response = await jsonPreview(f.id, f.category.id, order, {
        selectedAssetIds: JSON.stringify([f.c.id, f.a.id]),
        extension: 'png',
        view: 'list',
      }).expect(200).expect('Content-Type', /json/);
      const payload = response.body;

      expect(payload).toMatchObject({
        status: 'success',
        projectId: f.id,
        categoryId: f.category.id,
        category: { id: f.category.id, displayName: f.category.display_name },
        selectionMode: 'selected',
        orderedAssetIds: order,
        counts: { selected: 2, rename: 2, unchanged: 0, blocked: 0 },
        canApply: true,
      });
      expect([...payload.selectedAssetIds].sort((x, y) => x - y)).toEqual([f.a.id, f.c.id].sort((x, y) => x - y));
      expect(payload.items.map((item) => [item.assetId, item.status, item.currentRelativePath, item.proposedRelativePath])).toEqual([
        [f.c.id, 'rename', `${f.dir}/c.png`, `${f.dir}/${f.generated(1, 'png')}`],
        [f.a.id, 'rename', `${f.dir}/a.png`, `${f.dir}/${f.generated(2, 'png')}`],
      ]);
      expect(payload.planToken).toMatch(/\S{20,}/);
      expect(payload).not.toHaveProperty('snapshot');
      expect(payload).not.toHaveProperty('projectRelativePath');
      expect(leaks(response.text, tmpDir)).toBe(false);

      const html = payload.dialogHtml;
      expect(html).toContain('id="auto-rename-confirmation-dialog"');
      expect(html).not.toContain('data-app-dialog open');
      expect(html).not.toContain('<html');
      expect(html).not.toContain('data-project-assets-live-region');
      expect(html).toContain('data-dialog-async="true"');
      expect(html).toMatch(/<button class="button button-secondary" type="button" data-dialog-close>Cancel<\/button>/);
      expect(html).not.toMatch(/<a [^>]*>Cancel<\/a>/);
      expect(html).toContain('data-dialog-error hidden');
      expect(html).toContain('data-dialog-status');
      expect(html).toContain('c.png');
      expect(html).toContain(f.generated(2, 'png'));
      expect(html).not.toContain('b.jpg');
      expect(html).not.toContain('d.jpg');
      const applyForm = formMarkup(html, `/projects/${f.id}/assets/auto-rename/apply`);
      expect(applyForm).toMatch(/<button[^>]*data-dialog-submit[^>]*>Apply Auto Rename<\/button>/);
      expect(hiddenInputValues(applyForm, 'planToken')).toEqual([payload.planToken]);
      expect(hiddenInputValues(applyForm, '_csrf')).toHaveLength(1);
      expect(hiddenInputValues(applyForm, 'categoryId')).toEqual([String(f.category.id)]);
      expect(applyForm).not.toContain('orderedAssetIds');
      expect(applyForm).not.toContain('selectedAssetIds');
      // Preview renamed nothing.
      expect(assetRepository.findById(f.a.id).relative_path).toBe(`${f.dir}/a.png`);
      expect(fs.existsSync(path.join(f.projectDir, f.dir, 'a.png'))).toBe(true);
    });

    it('refuses invalid Preview input with distinct JSON codes', async () => {
      const f = await fourAssetCategory('Json Preview Refusals');
      const order = [f.a.id, f.b.id, f.c.id, f.d.id];
      const foreign = await createProject('Json Preview Foreign');
      const foreignCategory = categories(foreign.id)[0];

      const cases = [
        [() => jsonPreview(f.id, '', order), 422, AUTO_RENAME_ERROR_CODES.CATEGORY_REQUIRED],
        [() => jsonPreview(f.id, foreignCategory.id, order), 422, AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID],
        [() => jsonPreview(f.id, f.category.id, [f.a.id, f.b.id, f.c.id]), 422, AUTO_RENAME_ERROR_CODES.ORDER_INVALID],
        [() => jsonPreview(f.id, f.category.id, order, { orderedAssetIds: '[1,' }), 422, AUTO_RENAME_ERROR_CODES.ORDER_INVALID],
        [() => jsonPreview(f.id, f.category.id, order, { selectedAssetIds: JSON.stringify([999999]) }), 422, AUTO_RENAME_ERROR_CODES.ORDER_INVALID],
        [() => jsonPreview(f.id, f.category.id, order, { selectedAssetIds: '7' }), 422, AUTO_RENAME_ERROR_CODES.ORDER_INVALID],
        [() => jsonPreview(999999, f.category.id, order), 404, AUTO_RENAME_ERROR_CODES.PROJECT_NOT_FOUND],
      ];
      for (const [send, status, code] of cases) {
        const response = await send().expect(status).expect('Content-Type', /json/);
        expect(response.body).toMatchObject({ status: 'error', code });
        expect(typeof response.body.message).toBe('string');
        expect(response.body).not.toHaveProperty('dialogHtml');
      }

      await agent.post(`/projects/${f.id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
      const archived = await jsonPreview(f.id, f.category.id, order).expect(409);
      expect(archived.body).toMatchObject({
        status: 'error',
        code: AUTO_RENAME_ERROR_CODES.PROJECT_ARCHIVED,
        message: 'This project is archived and read-only.',
      });
    });

    it('applies the signed review and reports the committed renames', async () => {
      const f = await fourAssetCategory('Json Apply');
      const preview = await jsonPreview(f.id, f.category.id, [f.c.id, f.b.id, f.a.id, f.d.id], {
        selectedAssetIds: JSON.stringify([f.c.id, f.a.id]),
      }).expect(200);

      const response = await jsonApply(f.id, {
        _csrf: csrfToken,
        planToken: preview.body.planToken,
        attemptId: preview.body.attemptId,
        categoryId: String(f.category.id),
      }).expect(200).expect('Content-Type', /json/);
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'committed',
        message: 'Renamed 2 assets. Skipped 0 unchanged assets.',
        projectId: f.id,
        attemptId: preview.body.attemptId,
        renamed: 2,
        unchanged: 0,
        selected: 2,
        items: expect.any(Array),
      });
      const renamedItems = response.body.items.filter((item) => item.status === 'rename');
      expect(renamedItems.map((item) => [item.assetId, item.previousRelativePath, item.relativePath])).toEqual([
        [f.c.id, `${f.dir}/c.png`, `${f.dir}/${f.generated(1, 'png')}`],
        [f.a.id, `${f.dir}/a.png`, `${f.dir}/${f.generated(2, 'png')}`],
      ]);
      expect(assetRepository.findById(f.c.id).relative_path).toBe(`${f.dir}/${f.generated(1, 'png')}`);
      expect(assetRepository.findById(f.a.id).relative_path).toBe(`${f.dir}/${f.generated(2, 'png')}`);
      expect(assetRepository.findById(f.b.id).relative_path).toBe(`${f.dir}/b.jpg`);
      expect(fs.existsSync(path.join(f.projectDir, f.dir, f.generated(1, 'png')))).toBe(true);
      expect(fs.existsSync(path.join(f.projectDir, f.dir, 'c.png'))).toBe(false);

      // The same review cannot be applied twice: its attempt is spent, and a
      // fresh review of the renamed files is stale for the old token.
      const replay = await jsonApply(f.id, {
        _csrf: csrfToken, planToken: preview.body.planToken, attemptId: preview.body.attemptId, categoryId: String(f.category.id),
      }).expect(409);
      expect(replay.body).toMatchObject({
        status: 'error', code: 'AUTO_RENAME_ATTEMPT_USED', outcome: 'unknown', recoveryRequired: false,
      });
      const another = await jsonPreview(f.id, f.category.id, [f.c.id, f.b.id, f.a.id, f.d.id], {
        selectedAssetIds: JSON.stringify([f.c.id, f.a.id]),
      }).expect(200);
      const staleReplay = await jsonApply(f.id, {
        _csrf: csrfToken, planToken: preview.body.planToken, attemptId: another.body.attemptId,
      }).expect(409);
      expect(staleReplay.body).toMatchObject({ code: 'AUTO_RENAME_ATTEMPT_UNKNOWN', outcome: 'refused' });
      expect(assetRepository.findById(f.c.id).relative_path).toBe(`${f.dir}/${f.generated(1, 'png')}`);
    });

    it('refuses tampered, stale, blocked, archived and CSRF-less Apply without renaming', async () => {
      const f = await fourAssetCategory('Json Apply Refusals');
      const order = [f.a.id, f.b.id, f.c.id, f.d.id];
      const review = async () => (await jsonPreview(f.id, f.category.id, order, {
        selectedAssetIds: JSON.stringify([f.a.id]),
      }).expect(200)).body;
      const unchanged = () => {
        expect(assetRepository.findById(f.a.id).relative_path).toBe(`${f.dir}/a.png`);
        expect(fs.existsSync(path.join(f.projectDir, f.dir, 'a.png'))).toBe(true);
      };

      const reviewed = await review();
      const signed = reviewed.planToken;
      const tampered = `${signed.slice(0, -2)}${signed.endsWith('AA') ? 'BB' : 'AA'}`;
      // A tampered token is not the plan the attempt reviewed.
      const tamperedResponse = await jsonApply(f.id, { _csrf: csrfToken, planToken: tampered, attemptId: reviewed.attemptId }).expect(409);
      expect(tamperedResponse.body).toMatchObject({ status: 'error', code: 'AUTO_RENAME_ATTEMPT_UNKNOWN', outcome: 'refused' });
      const missing = await jsonApply(f.id, { _csrf: csrfToken }).expect(422);
      expect(missing.body).toMatchObject({ code: 'AUTO_RENAME_ATTEMPT_REQUIRED', outcome: 'refused' });
      const missingToken = await jsonApply(f.id, { _csrf: csrfToken, attemptId: reviewed.attemptId }).expect(409);
      expect(missingToken.body).toMatchObject({ code: 'AUTO_RENAME_ATTEMPT_UNKNOWN', outcome: 'refused' });
      unchanged();

      // Membership changed after the review.
      const membershipReview = await review();
      const added = writeAsset(f.id, f.projectDir, `${f.dir}/e.png`, 'e', { categoryId: f.category.id });
      const stale = await jsonApply(f.id, { _csrf: csrfToken, planToken: membershipReview.planToken, attemptId: membershipReview.attemptId }).expect(409);
      expect(stale.body).toMatchObject({
        code: AUTO_RENAME_ERROR_CODES.STALE_PLAN,
        outcome: 'refused',
        message: 'The rename preview is no longer current. Review the selected files again.',
      });
      unchanged();
      order.push(added.id);

      // An untracked file occupies the generated name: the review is blocked.
      fs.writeFileSync(path.join(f.projectDir, f.dir, f.generated(1, 'png')), 'occupied');
      const blocked = await review();
      expect(blocked.canApply).toBe(false);
      expect(blocked.items[0]).toMatchObject({ assetId: f.a.id, status: 'blocked', blockedReason: 'The generated destination is occupied on disk.' });
      expect(blocked.dialogHtml).toMatch(/<button[^>]*data-dialog-submit[^>]*disabled[^>]*>Apply Auto Rename<\/button>/);
      const blockedApply = await jsonApply(f.id, { _csrf: csrfToken, planToken: blocked.planToken, attemptId: blocked.attemptId }).expect(409);
      expect(blockedApply.body).toMatchObject({ code: AUTO_RENAME_ERROR_CODES.PLAN_BLOCKED, outcome: 'refused' });
      fs.rmSync(path.join(f.projectDir, f.dir, f.generated(1, 'png')));

      const current = await review();
      const currentFields = { planToken: current.planToken, attemptId: current.attemptId };
      const noCsrf = await jsonApply(f.id, currentFields).expect(403);
      expect(noCsrf.body).toMatchObject({ status: 'error' });
      await jsonApply(f.id, { _csrf: csrfToken, ...currentFields }, request.agent(app)).expect(403);
      unchanged();

      await agent.post(`/projects/${f.id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
      // The signed review covers the project's state, so archiving retires it.
      const archived = await jsonApply(f.id, { _csrf: csrfToken, ...currentFields }).expect(409);
      expect(archived.body).toMatchObject({ code: AUTO_RENAME_ERROR_CODES.STALE_PLAN, outcome: 'refused' });
      unchanged();
      const missingProject = await jsonApply(999999, { _csrf: csrfToken, ...currentFields }).expect(404);
      expect(missingProject.body).toMatchObject({ code: AUTO_RENAME_ERROR_CODES.PROJECT_NOT_FOUND });
    });

    it('distinguishes restored, recovery-required, ownership and unexpected Apply failures without leaking details', async () => {
      const { id, projectDir } = await createProject('Json Apply Failures');
      const category = categories(id)[0];
      const source = writeAsset(id, projectDir, 'source.png', 'source', { categoryId: category.id });
      const planner = realAutoRenameService();
      const failWith = async (code) => {
        const injected = await buildInjectedApp({
          buildPlan: (input) => planner.buildPlan(input),
          applyPlan() {
            const error = new Error(`raw failure ${tmpDir} SQLITE`);
            if (code) error.code = code;
            error.details = { items: [{ temporaryRelativePath: '.creatorcrate-tmp/x' }] };
            throw error;
          },
        });
        const reviewed = await injectedPreview(injected, id, category.id, [source.id]);
        return jsonApply(id, { _csrf: injected.csrfToken, planToken: reviewed.planToken, attemptId: reviewed.attemptId }, injected.agent);
      };

      const restored = await failWith(AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED);
      expect(restored.body).toEqual({
        status: 'error',
        code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED,
        message: 'Auto Rename failed. No files were renamed.',
        outcome: 'restored',
        recoveryRequired: false,
      });

      const recovery = await failWith(AUTO_RENAME_ERROR_CODES.AUTO_RENAME_RECOVERY_REQUIRED);
      expect(recovery.body).toEqual({
        status: 'error',
        code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_RECOVERY_REQUIRED,
        message: 'Auto Rename could not fully restore the project files. Review the project directory before trying again.',
        outcome: 'recovery-required',
        recoveryRequired: true,
      });

      const ownership = await failWith(AUTO_RENAME_ERROR_CODES.PROJECT_OWNERSHIP_UNAVAILABLE);
      expect(ownership.body).toMatchObject({ outcome: 'refused', message: expect.stringContaining('No files were renamed.') });

      const unexpected = await failWith(null);
      expect(unexpected.body).toEqual({
        status: 'error',
        code: 'AUTO_RENAME_UNEXPECTED',
        message: 'Auto Rename could not be applied. Please try again.',
        outcome: 'unknown',
        recoveryRequired: false,
      });
      expect([restored, recovery, ownership, unexpected].map((response) => response.status)).toEqual([500, 500, 409, 500]);
      for (const response of [restored, recovery, ownership, unexpected]) {
        expect(response.text).not.toContain('raw failure');
        expect(response.text).not.toContain('SQLITE');
        expect(response.text).not.toContain('creatorcrate-tmp');
        expect(leaks(response.text, tmpDir)).toBe(false);
      }
    });

    it('reads the complete category paths for outcome reconciliation without changing anything', async () => {
      const f = await fourAssetCategory('Json State');
      const response = await agent
        .get(`/projects/${f.id}/assets/auto-rename/state?categoryId=${f.category.id}`)
        .set('Accept', 'application/json')
        .expect(200);
      expect(response.body).toEqual({
        status: 'success',
        projectId: f.id,
        categoryId: f.category.id,
        archived: false,
        assets: expect.arrayContaining([f.a, f.b, f.c, f.d].map((asset) => ({
          assetId: asset.id,
          relativePath: asset.relative_path,
        }))),
      });
      expect(response.body.assets).toHaveLength(4);
      expect(leaks(response.text, tmpDir)).toBe(false);

      const foreign = await createProject('Json State Foreign');
      await agent.get(`/projects/${f.id}/assets/auto-rename/state?categoryId=${categories(foreign.id)[0].id}`).expect(422);
      await agent.get(`/projects/${f.id}/assets/auto-rename/state`).expect(422);
      await agent.get(`/projects/999999/assets/auto-rename/state?categoryId=${f.category.id}`).expect(404);
      await agent.post(`/projects/${f.id}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
      const archived = await agent.get(`/projects/${f.id}/assets/auto-rename/state?categoryId=${f.category.id}`).expect(200);
      expect(archived.body.archived).toBe(true);
      expect(assetRepository.findById(f.a.id).relative_path).toBe(f.a.relative_path);
    });

    const stateRead = (projectId, categoryId, attempt, currentAgent = agent) => currentAgent
      .get(`/projects/${projectId}/assets/auto-rename/state?categoryId=${categoryId}${attempt === undefined ? '' : `&attempt=${attempt}`}`)
      .set('Accept', 'application/json');

    async function injectedPreview(injected, projectId, categoryId, orderedAssetIds) {
      return (await injected.agent
        .post(`/projects/${projectId}/assets/auto-rename/preview`)
        .set('Accept', 'application/json')
        .type('form')
        .send({ categoryId: String(categoryId), orderedAssetIds: JSON.stringify(orderedAssetIds), _csrf: injected.csrfToken })
        .expect(200)).body;
    }

    const injectedApply = (injected, projectId, reviewed) => jsonApply(projectId, {
      _csrf: injected.csrfToken, planToken: reviewed.planToken, attemptId: reviewed.attemptId,
    }, injected.agent);

    it('records what each reviewed Apply attempt did, and reads it back only by that attempt', async () => {
      const f = await fourAssetCategory('Json Receipt');
      const order = [f.a.id, f.b.id, f.c.id, f.d.id];
      const reviewed = (await jsonPreview(f.id, f.category.id, order).expect(200)).body;
      expect(reviewed.attemptId).toMatch(/^[0-9a-f]{32}$/);
      expect(reviewed).not.toHaveProperty('receiptId');
      expect(reviewed.planToken).not.toContain(reviewed.attemptId);
      expect(reviewed.dialogHtml).toContain(`name="attemptId" value="${reviewed.attemptId}"`);

      // Before the Apply arrives: issued, no result, and the names are only observations.
      const before = await stateRead(f.id, f.category.id, reviewed.attemptId).expect(200);
      expect(before.body.operation).toEqual({ attemptId: reviewed.attemptId, state: 'issued', recorded: false });
      expect(before.body.assets).toContainEqual({ assetId: f.a.id, relativePath: f.a.relative_path });

      const applied = await jsonApply(f.id, { _csrf: csrfToken, planToken: reviewed.planToken, attemptId: reviewed.attemptId }).expect(200);
      expect(applied.body).toMatchObject({ outcome: 'committed', renamed: 4, attemptId: reviewed.attemptId });
      const after = await stateRead(f.id, f.category.id, reviewed.attemptId).expect(200);
      expect(after.body.operation).toEqual({
        attemptId: reviewed.attemptId, state: 'completed', recorded: true,
        outcome: 'committed', message: applied.body.message, renamed: 4, unchanged: 0,
      });
      expect(after.text).not.toContain(reviewed.planToken);

      // Sending the same attempt again runs nothing and never hides the first Apply.
      const repeated = await jsonApply(f.id, { _csrf: csrfToken, planToken: reviewed.planToken, attemptId: reviewed.attemptId }).expect(409);
      expect(repeated.body).toMatchObject({ code: 'AUTO_RENAME_ATTEMPT_USED', outcome: 'unknown' });
      expect((await stateRead(f.id, f.category.id, reviewed.attemptId).expect(200)).body.operation.outcome).toBe('committed');

      // A refused attempt is recorded as refused.
      const stale = (await jsonPreview(f.id, f.category.id, order).expect(200)).body;
      db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2001-01-01T00:00:00.000Z', f.a.id);
      await jsonApply(f.id, { _csrf: csrfToken, planToken: stale.planToken, attemptId: stale.attemptId }).expect(409);
      expect((await stateRead(f.id, f.category.id, stale.attemptId).expect(200)).body.operation)
        .toMatchObject({ attemptId: stale.attemptId, state: 'completed', recorded: true, outcome: 'refused' });

      // Attempts belong to their project, and a malformed one is refused.
      const other = await fourAssetCategory('Json Receipt Other');
      expect((await stateRead(other.id, other.category.id, reviewed.attemptId).expect(200)).body.operation)
        .toEqual({ attemptId: reviewed.attemptId, state: 'unknown', recorded: false });
      await stateRead(f.id, f.category.id, 'not-an-attempt').expect(422);
      await stateRead(f.id, f.category.id, reviewed.planToken).expect(422);
      await stateRead(f.id, f.category.id, reviewed.attemptId.toUpperCase()).expect(422);
      await agent.get(`/projects/${f.id}/assets/auto-rename/state?categoryId=${f.category.id}&attempt=${reviewed.attemptId}&attempt=${stale.attemptId}`)
        .set('Accept', 'application/json').expect(422);
      // A request that never reached the route (no CSRF) leaves its attempt issued.
      const unsent = (await jsonPreview(other.id, other.category.id, [other.a.id, other.b.id, other.c.id, other.d.id]).expect(200)).body;
      await jsonApply(other.id, { planToken: unsent.planToken, attemptId: unsent.attemptId }).expect(403);
      expect((await stateRead(other.id, other.category.id, unsent.attemptId).expect(200)).body.operation)
        .toEqual({ attemptId: unsent.attemptId, state: 'issued', recorded: false });
    });

    it('records a real recovery-required Apply, so original database names are never read as unchanged files', async () => {
      const f = await fourAssetCategory('Json Receipt Recovery');
      const service = createAutoRenameService({
        projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
        projectRepository: createProjectRepository(db),
        assetRepository,
        assetCategoryRepository: createAssetCategoryRepository(db),
        projectsRoot,
        projectOperationCoordinator: createProjectOperationCoordinator(),
        signingKey: Buffer.from('creatorcrate-auto-rename-receipt-recovery-key'),
        _hooks: {
          // The second file fails its final move, then restoring the first fails too.
          beforePhase2Move({ index }) { if (index === 1) throw new Error('injected phase two failure'); },
          beforeCompensationMove() { throw new Error('injected compensation failure'); },
        },
      });
      const injected = await buildInjectedApp(service);
      const reviewed = (await injected.agent
        .post(`/projects/${f.id}/assets/auto-rename/preview`)
        .set('Accept', 'application/json')
        .type('form')
        .send({ categoryId: String(f.category.id), orderedAssetIds: JSON.stringify([f.a.id, f.b.id, f.c.id, f.d.id]), _csrf: injected.csrfToken })
        .expect(200)).body;

      const failed = await jsonApply(f.id, { _csrf: injected.csrfToken, planToken: reviewed.planToken, attemptId: reviewed.attemptId }, injected.agent).expect(500);
      expect(failed.body).toMatchObject({ code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_RECOVERY_REQUIRED, outcome: 'recovery-required' });

      // Partial filesystem: one file at its new name, the rest in temporary files.
      const dir = path.join(f.projectDir, f.dir);
      const files = fs.readdirSync(dir);
      expect(files).toContain(f.generated(1, 'png'));
      expect(files).not.toContain('a.png');
      expect(files.filter((name) => name.includes('__creatorcrate_auto_rename_')).length).toBeGreaterThan(0);
      // The database still lists the original names.
      const state = await stateRead(f.id, f.category.id, reviewed.attemptId, injected.agent).expect(200);
      expect(state.body.assets).toContainEqual({ assetId: f.a.id, relativePath: f.a.relative_path });
      expect(assetRepository.findById(f.a.id).relative_path).toBe(f.a.relative_path);
      // The receipt, not the names, says what happened.
      expect(state.body.operation).toEqual({
        attemptId: reviewed.attemptId,
        state: 'completed',
        recorded: true,
        outcome: 'recovery-required',
        message: 'Auto Rename could not fully restore the project files. Review the project directory before trying again.',
      });
      expect(state.text).not.toContain('injected');
      expect(leaks(state.text, tmpDir)).toBe(false);
    });

    describe('Apply attempts of identical signed plans', () => {
      const tempFiles = (f) => fs.readdirSync(path.join(f.projectDir, f.dir)).filter((name) => name.includes('__creatorcrate_auto_rename_'));
      const order = (f) => [f.a.id, f.b.id, f.c.id, f.d.id];

      it('A: gives every review its own attempt and keeps each attempt’s state apart', async () => {
        const f = await fourAssetCategory('Attempt Identity');
        const injected = await buildInjectedApp(realAutoRenameService());
        const first = await injectedPreview(injected, f.id, f.category.id, order(f));
        const second = await injectedPreview(injected, f.id, f.category.id, order(f));
        // The signed plans are the same; the attempts are not.
        expect(second.planToken).toBe(first.planToken);
        expect(first.attemptId).toMatch(/^[0-9a-f]{32}$/);
        expect(second.attemptId).toMatch(/^[0-9a-f]{32}$/);
        expect(second.attemptId).not.toBe(first.attemptId);

        expect((await stateRead(f.id, f.category.id, first.attemptId, injected.agent).expect(200)).body.operation)
          .toEqual({ attemptId: first.attemptId, state: 'issued', recorded: false });
        const applied = await injectedApply(injected, f.id, first).expect(200);
        expect(applied.body).toMatchObject({ outcome: 'committed', renamed: 4, attemptId: first.attemptId });
        // A's result is A's alone: B has still not run.
        expect((await stateRead(f.id, f.category.id, first.attemptId, injected.agent).expect(200)).body.operation)
          .toMatchObject({ attemptId: first.attemptId, state: 'completed', outcome: 'committed', renamed: 4 });
        expect((await stateRead(f.id, f.category.id, second.attemptId, injected.agent).expect(200)).body.operation)
          .toEqual({ attemptId: second.attemptId, state: 'issued', recorded: false });

        // B runs and is refused as stale; A's committed receipt is untouched.
        const late = await injectedApply(injected, f.id, second).expect(409);
        expect(late.body).toMatchObject({ code: AUTO_RENAME_ERROR_CODES.STALE_PLAN, outcome: 'refused' });
        expect((await stateRead(f.id, f.category.id, second.attemptId, injected.agent).expect(200)).body.operation)
          .toMatchObject({ attemptId: second.attemptId, state: 'completed', outcome: 'refused' });
        expect((await stateRead(f.id, f.category.id, first.attemptId, injected.agent).expect(200)).body.operation)
          .toMatchObject({ attemptId: first.attemptId, outcome: 'committed', renamed: 4 });
        expect(assetRepository.findById(f.a.id).relative_path).toBe(`${f.dir}/${f.generated(1, 'png')}`);
      });

      it('B: an earlier restored attempt never stands in for a later recovery-required one', async () => {
        const f = await fourAssetCategory('Attempt Restored Then Recovery');
        const faults = { phase2: false, compensation: false };
        const injected = await buildInjectedApp(realAutoRenameService({
          hooks: {
            beforePhase2Move({ index }) { if (faults.phase2 && index === 1) throw new Error('injected phase two failure'); },
            beforeCompensationMove() { if (faults.compensation) throw new Error('injected compensation failure'); },
          },
        }));
        const originalFiles = fs.readdirSync(path.join(f.projectDir, f.dir)).sort();

        // A fails and the service restores every file.
        faults.phase2 = true;
        const attemptA = await injectedPreview(injected, f.id, f.category.id, order(f));
        const failedA = await injectedApply(injected, f.id, attemptA).expect(500);
        expect(failedA.body).toMatchObject({ code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED, outcome: 'restored' });
        expect(fs.readdirSync(path.join(f.projectDir, f.dir)).sort()).toEqual(originalFiles);
        expect((await stateRead(f.id, f.category.id, attemptA.attemptId, injected.agent).expect(200)).body.operation)
          .toMatchObject({ attemptId: attemptA.attemptId, state: 'completed', outcome: 'restored' });

        // B reviews the identical plan, fails, and restoring fails too.
        const attemptB = await injectedPreview(injected, f.id, f.category.id, order(f));
        expect(attemptB.planToken).toBe(attemptA.planToken);
        expect(attemptB.attemptId).not.toBe(attemptA.attemptId);
        faults.compensation = true;
        const failedB = await injectedApply(injected, f.id, attemptB).expect(500);
        expect(failedB.body).toMatchObject({ code: AUTO_RENAME_ERROR_CODES.AUTO_RENAME_RECOVERY_REQUIRED, outcome: 'recovery-required' });

        // B's answer is lost; its own receipt is what the page reads.
        const stateB = await stateRead(f.id, f.category.id, attemptB.attemptId, injected.agent).expect(200);
        expect(stateB.body.operation).toEqual({
          attemptId: attemptB.attemptId,
          state: 'completed',
          recorded: true,
          outcome: 'recovery-required',
          message: 'Auto Rename could not fully restore the project files. Review the project directory before trying again.',
        });
        expect((await stateRead(f.id, f.category.id, attemptA.attemptId, injected.agent).expect(200)).body.operation)
          .toMatchObject({ attemptId: attemptA.attemptId, outcome: 'restored' });
        // The real partial state; the database still lists original names,
        // which the receipt, not the names, explains.
        const files = fs.readdirSync(path.join(f.projectDir, f.dir));
        expect(files).toContain(f.generated(1, 'png'));
        expect(files).not.toContain('a.png');
        expect(tempFiles(f).length).toBeGreaterThan(0);
        expect(stateB.body.assets).toContainEqual({ assetId: f.a.id, relativePath: f.a.relative_path });
        expect(assetRepository.findById(f.a.id).relative_path).toBe(f.a.relative_path);
        expect(leaks(stateB.text, tmpDir)).toBe(false);
        expect(stateB.text).not.toContain('injected');
      });

      it('C: an earlier refusal never settles a later attempt whose POST has not run yet', async () => {
        const f = await fourAssetCategory('Attempt Refused Then Delayed');
        const coordinator = createProjectOperationCoordinator();
        const injected = await buildInjectedApp(realAutoRenameService({ coordinator }));

        // A meets a genuine project operation in progress.
        const attemptA = await injectedPreview(injected, f.id, f.category.id, order(f));
        let release;
        const held = coordinator.runAsync(f.id, () => new Promise((resolve) => { release = resolve; }));
        const busy = await injectedApply(injected, f.id, attemptA).expect(409);
        expect(busy.body).toMatchObject({ code: AUTO_RENAME_ERROR_CODES.PROJECT_BUSY, outcome: 'refused' });
        release();
        await held;
        expect((await stateRead(f.id, f.category.id, attemptA.attemptId, injected.agent).expect(200)).body.operation)
          .toMatchObject({ attemptId: attemptA.attemptId, state: 'completed', outcome: 'refused' });

        // B reviews the identical plan; its POST is still in the network.
        const attemptB = await injectedPreview(injected, f.id, f.category.id, order(f));
        expect(attemptB.planToken).toBe(attemptA.planToken);
        expect(attemptB.attemptId).not.toBe(attemptA.attemptId);
        const early = await stateRead(f.id, f.category.id, attemptB.attemptId, injected.agent).expect(200);
        expect(early.body.operation).toEqual({ attemptId: attemptB.attemptId, state: 'issued', recorded: false });
        expect(assetRepository.findById(f.a.id).relative_path).toBe(f.a.relative_path);

        // B finally runs and commits; only B's lookup reports it.
        const delivered = await injectedApply(injected, f.id, attemptB).expect(200);
        expect(delivered.body).toMatchObject({ outcome: 'committed', renamed: 4, attemptId: attemptB.attemptId });
        expect((await stateRead(f.id, f.category.id, attemptB.attemptId, injected.agent).expect(200)).body.operation)
          .toMatchObject({ attemptId: attemptB.attemptId, state: 'completed', outcome: 'committed', renamed: 4 });
        expect((await stateRead(f.id, f.category.id, attemptA.attemptId, injected.agent).expect(200)).body.operation)
          .toMatchObject({ attemptId: attemptA.attemptId, outcome: 'refused' });
        expect(assetRepository.findById(f.a.id).relative_path).toBe(`${f.dir}/${f.generated(1, 'png')}`);
      });

      it('D: refuses an attempt on another project or plan, malformed or missing, without running anything', async () => {
        const f = await fourAssetCategory('Attempt Security');
        const g = await fourAssetCategory('Attempt Security Other');
        const reviewF = (await jsonPreview(f.id, f.category.id, order(f)).expect(200)).body;
        const reviewG = (await jsonPreview(g.id, g.category.id, order(g)).expect(200)).body;
        const otherPlanF = (await jsonPreview(f.id, f.category.id, [f.d.id, f.c.id, f.b.id, f.a.id]).expect(200)).body;
        expect(otherPlanF.planToken).not.toBe(reviewF.planToken);
        const untouched = () => {
          for (const asset of [f.a, f.b, f.c, f.d, g.a, g.b, g.c, g.d]) {
            expect(assetRepository.findById(asset.id).relative_path).toBe(asset.relative_path);
          }
        };

        const refusals = [
          // F's attempt transplanted onto G with G's own valid plan.
          [g.id, { planToken: reviewG.planToken, attemptId: reviewF.attemptId }, 409, 'AUTO_RENAME_ATTEMPT_UNKNOWN'],
          // One of F's attempts with another F plan.
          [f.id, { planToken: otherPlanF.planToken, attemptId: reviewF.attemptId }, 409, 'AUTO_RENAME_ATTEMPT_UNKNOWN'],
          [f.id, { planToken: reviewF.planToken, attemptId: 'f'.repeat(32) }, 409, 'AUTO_RENAME_ATTEMPT_UNKNOWN'],
          [f.id, { planToken: reviewF.planToken, attemptId: 'not-an-attempt' }, 422, 'AUTO_RENAME_ATTEMPT_INVALID'],
          [f.id, { planToken: reviewF.planToken, attemptId: reviewF.attemptId.toUpperCase() }, 422, 'AUTO_RENAME_ATTEMPT_INVALID'],
          [f.id, { planToken: reviewF.planToken, attemptId: [reviewF.attemptId, reviewF.attemptId] }, 422, 'AUTO_RENAME_ATTEMPT_INVALID'],
          [f.id, { planToken: reviewF.planToken }, 422, 'AUTO_RENAME_ATTEMPT_REQUIRED'],
          [f.id, { planToken: reviewF.planToken, attemptId: '' }, 422, 'AUTO_RENAME_ATTEMPT_REQUIRED'],
        ];
        for (const [projectId, fields, status, code] of refusals) {
          const response = await jsonApply(projectId, { _csrf: csrfToken, ...fields }).expect(status);
          expect(response.body).toMatchObject({ status: 'error', code, outcome: 'refused', recoveryRequired: false });
          expect(leaks(response.text, tmpDir)).toBe(false);
          expect(response.text).not.toContain(reviewF.planToken);
        }
        // CSRF and session checks still run first, and leave the attempt issued.
        await jsonApply(f.id, { planToken: reviewF.planToken, attemptId: reviewF.attemptId }).expect(403);
        await jsonApply(f.id, { _csrf: csrfToken, planToken: reviewF.planToken, attemptId: reviewF.attemptId }, request.agent(app)).expect(403);
        untouched();

        // No refusal spent or settled an attempt, and lookups stay project-scoped.
        for (const [projectId, categoryId, attemptId, state] of [
          [f.id, f.category.id, reviewF.attemptId, 'issued'],
          [f.id, f.category.id, otherPlanF.attemptId, 'issued'],
          [g.id, g.category.id, reviewG.attemptId, 'issued'],
          [g.id, g.category.id, reviewF.attemptId, 'unknown'],
          [f.id, f.category.id, reviewG.attemptId, 'unknown'],
        ]) {
          expect((await stateRead(projectId, categoryId, attemptId).expect(200)).body.operation)
            .toEqual({ attemptId, state, recorded: false });
        }
        // The rightful pairing still applies once.
        await jsonApply(f.id, { _csrf: csrfToken, planToken: reviewF.planToken, attemptId: reviewF.attemptId }).expect(200);
        expect(assetRepository.findById(f.a.id).relative_path).toBe(`${f.dir}/${f.generated(1, 'png')}`);
        expect(assetRepository.findById(g.a.id).relative_path).toBe(g.a.relative_path);
      });

      it('E: never runs one attempt twice, and an evicted attempt is unknown, never another attempt’s result', async () => {
        const f = await fourAssetCategory('Attempt Replay');
        let applies = 0;
        const service = realAutoRenameService();
        const injected = await buildInjectedApp({
          buildPlan: (input) => service.buildPlan(input),
          applyPlan: (...args) => { applies += 1; return service.applyPlan(...args); },
        });
        const reviewed = await injectedPreview(injected, f.id, f.category.id, order(f));
        await injectedApply(injected, f.id, reviewed).expect(200);
        const replays = await Promise.all([1, 2, 3].map(() => injectedApply(injected, f.id, reviewed)));
        expect(replays.map((response) => [response.status, response.body.code, response.body.outcome]))
          .toEqual(Array(3).fill([409, 'AUTO_RENAME_ATTEMPT_USED', 'unknown']));
        expect(applies).toBe(1);
        expect((await stateRead(f.id, f.category.id, reviewed.attemptId, injected.agent).expect(200)).body.operation)
          .toMatchObject({ outcome: 'committed', renamed: 4 });
        expect(fs.readdirSync(path.join(f.projectDir, f.dir)).sort()).toEqual(
          [f.generated(1, 'png'), f.generated(2, 'jpg'), f.generated(3, 'png'), f.generated(4, 'jpg')].sort(),
        );

        // Another explicit review is a new attempt.
        const again = await injectedPreview(injected, f.id, f.category.id, order(f));
        expect(again.attemptId).not.toBe(reviewed.attemptId);
        expect((await stateRead(f.id, f.category.id, again.attemptId, injected.agent).expect(200)).body.operation)
          .toEqual({ attemptId: again.attemptId, state: 'issued', recorded: false });

        // Enough later reviews evict both; neither falls back to anything else.
        let newest = null;
        for (let index = 0; index < 500; index += 1) newest = await injectedPreview(injected, f.id, f.category.id, order(f));
        for (const attemptId of [reviewed.attemptId, again.attemptId]) {
          expect((await stateRead(f.id, f.category.id, attemptId, injected.agent).expect(200)).body.operation)
            .toEqual({ attemptId, state: 'unknown', recorded: false });
        }
        const evicted = await injectedApply(injected, f.id, again).expect(409);
        expect(evicted.body).toMatchObject({ code: 'AUTO_RENAME_ATTEMPT_UNKNOWN', outcome: 'refused' });
        expect(applies).toBe(1);
        expect((await stateRead(f.id, f.category.id, newest.attemptId, injected.agent).expect(200)).body.operation)
          .toEqual({ attemptId: newest.attemptId, state: 'issued', recorded: false });
      }, 60000);
    });

    it('keeps native Preview and Apply and mounts the async review only on ordinary pages', async () => {
      const f = await fourAssetCategory('Native Compatibility');
      const page = await agent.get(`/projects/${f.id}/assets?category=${f.category.id}`).expect(200);
      expect(page.text).toContain('data-auto-rename-dialog-mount');
      expect(page.text).not.toContain('id="auto-rename-confirmation-dialog"');

      const native = await previewRequest(f.id, f.category.id, [f.a.id, f.b.id, f.c.id, f.d.id])
        .expect(200).expect('Content-Type', /html/);
      expect(native.text).toContain('data-dialog-async="false"');
      expect(native.text).toMatch(/<a class="button button-secondary" href="[^"]+">Cancel<\/a>/);
      expect(native.text).not.toContain('data-auto-rename-dialog-mount');
      expect(native.text.match(/id="auto-rename-confirmation-dialog"/g)).toHaveLength(1);

      // The native form carries its own issued attempt, and submits as rendered.
      const form = formMarkup(native.text, `/projects/${f.id}/assets/auto-rename/apply`);
      const attemptId = attemptFromConfirmation(form);
      expect(hiddenInputValues(form, 'attemptId')).toEqual([attemptId]);
      const fields = hiddenFormFields(form);
      expect(fields.getAll('attemptId')).toEqual([attemptId]);
      expect((await stateRead(f.id, f.category.id, attemptId).expect(200)).body.operation)
        .toEqual({ attemptId, state: 'issued', recorded: false });

      const applied = await agent.post(`/projects/${f.id}/assets/auto-rename/apply`)
        .type('form').send(fields.toString()).expect(302);
      const redirect = new URL(applied.headers.location, 'http://localhost');
      expect(redirect.pathname).toBe(`/projects/${f.id}/assets`);
      expect(redirect.searchParams.get('notice')).toBe('auto-rename-success');
      expect(redirect.searchParams.get('auto_rename_renamed')).toBe('4');
      expect(redirect.searchParams.has('attemptId')).toBe(false);
      const renamed = [
        [f.a, f.generated(1, 'png')], [f.b, f.generated(2, 'jpg')], [f.c, f.generated(3, 'png')], [f.d, f.generated(4, 'jpg')],
      ];
      const expectRenamed = () => {
        for (const [asset, filename] of renamed) {
          expect(assetRepository.findById(asset.id).relative_path).toBe(`${f.dir}/${filename}`);
        }
        expect(fs.readdirSync(path.join(f.projectDir, f.dir)).sort()).toEqual(renamed.map(([, filename]) => filename).sort());
      };
      expectRenamed();
      const receipt = (await stateRead(f.id, f.category.id, attemptId).expect(200)).body.operation;
      expect(receipt).toMatchObject({ attemptId, state: 'completed', recorded: true, outcome: 'committed', renamed: 4, unchanged: 0 });

      // Submitting the same native form again runs nothing and keeps the receipt.
      const resubmitted = await agent.post(`/projects/${f.id}/assets/auto-rename/apply`)
        .type('form').send(fields.toString()).expect(409).expect('Content-Type', /html/);
      expect(resubmitted.text).toContain('already submitted, so it was not applied again');
      expect(resubmitted.text).not.toContain('AUTO_RENAME_ATTEMPT');
      expectRenamed();
      expect((await stateRead(f.id, f.category.id, attemptId).expect(200)).body.operation).toEqual(receipt);
    });

    it('refuses every native Apply without its own issued attempt before anything runs', async () => {
      const f = await fourAssetCategory('Native Attempt Required');
      const g = await fourAssetCategory('Native Attempt Other');
      let applies = 0;
      const service = realAutoRenameService();
      const injected = await buildInjectedApp({
        buildPlan: (input) => service.buildPlan(input),
        applyPlan: (...args) => { applies += 1; return service.applyPlan(...args); },
      });
      const fullOrder = (project) => [project.a.id, project.b.id, project.c.id, project.d.id];
      const reviewF = await nativeInjectedPreview(injected, f.id, f.category.id, fullOrder(f));
      const reviewG = await nativeInjectedPreview(injected, g.id, g.category.id, fullOrder(g));
      const otherPlanF = await nativeInjectedPreview(injected, f.id, f.category.id, [f.d.id, f.c.id, f.b.id, f.a.id]);
      const tokenF = tokenFromConfirmation(reviewF);
      const attemptF = attemptFromConfirmation(reviewF);
      expect(tokenFromConfirmation(otherPlanF)).not.toBe(tokenF);
      const nativeApply = (projectId, fields, currentAgent = injected.agent) => currentAgent
        .post(`/projects/${projectId}/assets/auto-rename/apply`)
        .type('form')
        .send(new URLSearchParams(fields).toString());
      const untouched = () => {
        for (const project of [f, g]) {
          for (const asset of [project.a, project.b, project.c, project.d]) {
            expect(assetRepository.findById(asset.id).relative_path).toBe(asset.relative_path);
          }
          expect(fs.readdirSync(path.join(project.projectDir, project.dir)).sort()).toEqual(['a.png', 'b.jpg', 'c.png', 'd.jpg']);
        }
      };
      const base = (projectId, token) => [['_csrf', injected.csrfToken], ['planToken', token], ['categoryId', String(projectId === f.id ? f.category.id : g.category.id)]];

      const required = 'This Auto Rename review cannot be identified. No files were renamed.';
      const unavailable = 'This Auto Rename review is no longer available. No files were renamed.';
      const refusals = [
        // A valid signed plan alone no longer applies.
        [f.id, base(f.id, tokenF), 422, required],
        [f.id, [...base(f.id, tokenF), ['attemptId', '']], 422, required],
        [f.id, [...base(f.id, tokenF), ['attemptId', 'not-an-attempt']], 422, required],
        [f.id, [...base(f.id, tokenF), ['attemptId', attemptF.toUpperCase()]], 422, required],
        [f.id, [...base(f.id, tokenF), ['attemptId', attemptF], ['attemptId', attemptF]], 422, required],
        [f.id, [...base(f.id, tokenF), ['attemptId', 'f'.repeat(32)]], 409, unavailable],
        // F's attempt on G with G's own valid plan, and with another F plan.
        [g.id, [...base(g.id, tokenFromConfirmation(reviewG)), ['attemptId', attemptF]], 409, unavailable],
        [f.id, [...base(f.id, tokenFromConfirmation(otherPlanF)), ['attemptId', attemptF]], 409, unavailable],
      ];
      for (const [projectId, fields, status, message] of refusals) {
        const response = await nativeApply(projectId, fields).expect(status).expect('Content-Type', /html/);
        expect(response.headers.location).toBeUndefined();
        expect(response.text).toContain(message);
        expect(response.text).not.toContain('AUTO_RENAME_ATTEMPT');
        expect(response.text).not.toContain(tokenF);
      }
      // CSRF and session checks still run first; the attempt does not replace them.
      await nativeApply(f.id, [['planToken', tokenF], ['attemptId', attemptF], ['categoryId', String(f.category.id)]]).expect(403);
      await nativeApply(f.id, [...base(f.id, tokenF), ['attemptId', attemptF]], request.agent(injected.app)).expect(403);
      expect(applies).toBe(0);
      untouched();

      // No refusal spent or settled an attempt, so no false receipt exists.
      for (const [project, html] of [[f, reviewF], [g, reviewG], [f, otherPlanF]]) {
        const attemptId = attemptFromConfirmation(html);
        expect((await stateRead(project.id, project.category.id, attemptId, injected.agent).expect(200)).body.operation)
          .toEqual({ attemptId, state: 'issued', recorded: false });
      }

      // The rightful pairing applies once; its replay is refused as already used.
      await nativeApply(f.id, [...base(f.id, tokenF), ['attemptId', attemptF]]).expect(302);
      expect(applies).toBe(1);
      const replay = await nativeApply(f.id, [...base(f.id, tokenF), ['attemptId', attemptF]]).expect(409);
      expect(replay.text).toContain('already submitted, so it was not applied again');
      expect(applies).toBe(1);
      expect((await stateRead(f.id, f.category.id, attemptF, injected.agent).expect(200)).body.operation)
        .toMatchObject({ state: 'completed', outcome: 'committed', renamed: 4 });
      expect(assetRepository.findById(f.a.id).relative_path).toBe(`${f.dir}/${f.generated(1, 'png')}`);
      expect(assetRepository.findById(g.a.id).relative_path).toBe(g.a.relative_path);
    });
  });
});
