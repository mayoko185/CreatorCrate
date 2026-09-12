/**
 * Processing actions placement on /projects/:id/assets.
 *
 * This page has a real history of one action-panel branch (the complete
 * category/auto-rename surface) diverging from the other (the ordinary
 * selection-only surface), causing content to disappear when viewing All or
 * when browser controls downgraded the surface. These tests prove the new
 * "Processing" subcard is rendered from the one shared partial in
 * every branch, additive to the existing Release / File subcards, and correctly gated on archived state — not on Auto
 * Rename availability.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const CSS_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));

function processingActionsCard(html) {
  const match = html.match(/<section class="asset-action-group processing-action-group"[^>]*>[\s\S]*?<\/section>/);
  return match ? match[0] : '';
}

function actionGroupHeadings(html) {
  const matches = html.match(/<h3 class="asset-action-group-heading">([^<]+)<\/h3>/g) || [];
  return matches.map((markup) => markup.replace(/<[^>]+>/g, ''));
}

describe('Processing actions placement', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let assetRepo;
  let assetCategoryRepo;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-actions-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    assetRepo = createAssetRepository(db);
    assetCategoryRepo = createAssetCategoryRepository(db);
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

  async function createProject(title) {
    const res = await agent
      .post('/projects')
      .send(`title=${encodeURIComponent(title)}`)
      .send('status=tbd')
      .send('priority=normal')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded');
    return Number(res.headers.location.replace('/projects/', ''));
  }

  function addAsset(projectId, relativePath, { categoryId } = {}) {
    return assetRepo.upsert(projectId, relativePath, {
      filename: path.basename(relativePath),
      extension: path.extname(relativePath).slice(1) || 'png',
      mimeType: 'image/png',
      sizeBytes: 10,
      modifiedAt: null,
      ...(categoryId ? { categoryId, nestedPath: '' } : {}),
    });
  }

  function iconButton(card, label) {
    return card.match(new RegExp(`<button\\b(?=[^>]*aria-label="${label}")[^>]*>[\\s\\S]*?<\\/button>`))?.[0] || '';
  }

  function expectProcessingButtons(card) {
    for (const label of ['Watermark', 'Image workflows editor', 'Archives']) {
      const button = iconButton(card, label);
      expect(button).not.toBe('');
      expect(button).toContain(`data-tooltip="${label}"`);
      expect(button).toMatch(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
      expect(button.replace(/<[^>]+>/g, '').trim()).toBe('');
    }
    expect(card).not.toContain('aria-label="Convert"');
    expect(card).not.toContain('data-dialog-open="processing-convert-dialog"');
    const workflow = iconButton(card, 'Image workflows editor');
    expect(workflow).toContain('<path d="M4 6h5"/>');
    expect(workflow).not.toContain('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>');
  }

  function expectUnavailableAutoRename(card, tooltip) {
    const button = iconButton(card, 'Auto Rename');
    expect(button).not.toBe('');
    expect(button).toContain('type="button"');
    expect(button).toMatch(/\bdisabled\b/);
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain(`data-tooltip="${tooltip}"`);
    expect(button).not.toContain('form="auto-rename-assets-form"');
    expect(button).not.toContain('data-auto-rename-submit');
    expect(button).toContain('<path d="M8 6h12M8 12h8M8 18h4"/>');
    expect(button).not.toContain('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>');
  }

  it('renders on the ordinary branch when viewing All', async () => {
    const id = await createProject('All View Processing');
    addAsset(id, 'a.png');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    const card = processingActionsCard(res.text);
    expect(card).not.toBe('');
    expectProcessingButtons(card);
    expect(card).toContain('data-dialog-open="processing-watermark-dialog"');
    expect(card).toContain('data-dialog-open="processing-workflow-dialog"');
    expect(card).toContain('data-dialog-open="processing-archive-dialog"');
    expectUnavailableAutoRename(card, 'Auto Rename — available only for a complete category with selected assets');
    // Exactly one card — no duplicate render in a single response.
    expect((res.text.match(/class="asset-action-group processing-action-group"/g) || [])).toHaveLength(1);
  });

  it('renders on the ordinary branch when viewing Uncategorized', async () => {
    const id = await createProject('Uncategorized Processing');
    addAsset(id, 'a.png');
    const res = await agent.get(`/projects/${id}/assets?category=uncategorized`).expect(200);
    const card = processingActionsCard(res.text);
    expect(card).not.toBe('');
    expectProcessingButtons(card);
    expectUnavailableAutoRename(card, 'Auto Rename — available only for a complete category with selected assets');
  });

  it('renders on the complete-category/auto-rename surface for a concrete category', async () => {
    const id = await createProject('Concrete Category Processing');
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    addAsset(id, 'renders/keep.png', { categoryId: category.id });
    const res = await agent.get(`/projects/${id}/assets?category=${category.id}`).expect(200);
    expect(res.text).toContain('data-auto-rename-surface');
    const card = processingActionsCard(res.text);
    expect(card).not.toBe('');
    expectProcessingButtons(card);
    const autoRename = iconButton(card, 'Auto Rename');
    expect(autoRename).toContain('type="submit"');
    expect(autoRename).toContain('form="auto-rename-assets-form"');
    expect(autoRename).toContain('data-auto-rename-submit');
    expect(autoRename).toMatch(/\bdisabled\b/);
    expect(autoRename).toContain('aria-disabled="true"');
    expect(autoRename).toContain('<path d="M8 6h12M8 12h8M8 18h4"/>');
    expect(autoRename).not.toContain('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>');
    expect((res.text.match(/class="asset-action-group processing-action-group"/g) || [])).toHaveLength(1);
  });

  it('renders on the downgraded/ordinary surface when a concrete category uses search', async () => {
    const id = await createProject('Downgraded Category Processing');
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    addAsset(id, 'renders/keep.png', { categoryId: category.id });
    const res = await agent.get(`/projects/${id}/assets?category=${category.id}&search=keep`).expect(200);
    expect(res.text).not.toContain('data-auto-rename-surface');
    const card = processingActionsCard(res.text);
    expect(card).not.toBe('');
    expectProcessingButtons(card);
    expectUnavailableAutoRename(card, 'Auto Rename — available only for a complete category with selected assets');
  });

  it('renders disabled Auto Rename for an unavailable disabled-category surface', async () => {
    const id = await createProject('Unavailable Category Processing');
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Disabled', directorySlug: 'disabled', displayOrder: 0, enabled: false,
    });
    addAsset(id, 'disabled/keep.png', { categoryId: category.id });
    const res = await agent.get(`/projects/${id}/assets?category=${category.id}`).expect(200);
    const card = processingActionsCard(res.text);
    expect(card).not.toBe('');
    expectUnavailableAutoRename(card, 'Auto Rename — available only for a complete category with selected assets');
  });

  it('keeps Processing and disabled Auto Rename on empty and no-results pages', async () => {
    const emptyId = await createProject('Empty Processing');
    const empty = await agent.get(`/projects/${emptyId}/assets`).expect(200);
    expectUnavailableAutoRename(
      processingActionsCard(empty.text),
      'Auto Rename — available only for a complete category with selected assets',
    );

    const filteredId = await createProject('No Results Processing');
    addAsset(filteredId, 'present.png');
    const noResults = await agent.get(`/projects/${filteredId}/assets?search=absent`).expect(200);
    expectUnavailableAutoRename(
      processingActionsCard(noResults.text),
      'Auto Rename — available only for a complete category with selected assets',
    );
  });

  it('is additive: Release and File remain present alongside it', async () => {
    const id = await createProject('Additive Processing Check');
    addAsset(id, 'a.png');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res.text).toContain('<h3 class="asset-action-group-heading">Release</h3>');
    expect(res.text).toContain('<h3 class="asset-action-group-heading">File</h3>');
    expect((res.text.match(/<section class="asset-action-group processing-action-group"/g) || [])).toHaveLength(1);
    // The three original sections plus Processing actions = four distinct action-group sections.
    const allGroups = res.text.match(/<section class="asset-action-group[^>]*>/g) || [];
    expect(allGroups.length).toBeGreaterThanOrEqual(3);
  });

  it('disables all four processing buttons with an explanation on archived projects, including Auto Rename', async () => {
    const id = await createProject('Archived Processing Check');
    addAsset(id, 'a.png');
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    const card = processingActionsCard(res.text);
    expect(card).not.toBe('');
    expect(card).not.toContain('data-dialog-open="processing-watermark-dialog"');
    for (const label of ['Auto Rename', 'Watermark', 'Image workflows editor', 'Archives']) {
      const button = iconButton(card, label);
      expect(button).toMatch(/\bdisabled\b/);
      expect(button).toContain('aria-disabled="true"');
      expect(button).toContain(`data-tooltip="${label} — unavailable for archived projects"`);
      expect(button).toMatch(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
      expect(button.replace(/<[^>]+>/g, '').trim()).toBe('');
    }
    expectUnavailableAutoRename(card, 'Auto Rename — unavailable for archived projects');
    const workflow = iconButton(card, 'Image workflows editor');
    expect(workflow).toContain('<path d="M4 6h5"/>');
    expect(workflow).not.toContain('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>');
    expect(card).not.toContain('aria-label="Convert"');
    expect(res.text).not.toContain('id="processing-watermark-dialog"');
  });

  it('does not send raw JSON, stack traces, SQL, or filesystem paths in the processing card markup', async () => {
    const id = await createProject('No Leak Processing Check');
    addAsset(id, 'a.png');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    const card = processingActionsCard(res.text);
    expect(card).not.toMatch(/[A-Za-z]:\\/);
    expect(card).not.toContain('SELECT ');
  });

  it('uses exactly Release / File / Processing subcard headings on every branch', async () => {
    const id = await createProject('Headings Check');
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    addAsset(id, 'renders/keep.png', { categoryId: category.id });
    addAsset(id, 'loose.png');

    const all = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(actionGroupHeadings(all.text)).toEqual(
      expect.arrayContaining(['Release', 'File', 'Processing']),
    );
    expect(actionGroupHeadings(all.text).filter((h) => h === 'Release')).toHaveLength(1);
    expect(actionGroupHeadings(all.text).filter((h) => h === 'File')).toHaveLength(1);
    expect(actionGroupHeadings(all.text).filter((h) => h === 'Processing')).toHaveLength(1);
    expect(all.text).toMatch(
      /<section class="project-detail-section asset-actions-panel asset-actions-panel--selection-only" data-asset-actions-panel aria-labelledby="project-actions-heading">\s*<h2 id="project-actions-heading">Project actions<\/h2>\s*<div class="project-detail-section-body">/,
    );
    expect(all.text).not.toMatch(/<h2 class="app-section-title"[^>]*>Project actions<\/h2>/);
    expect(all.text).not.toMatch(/<h2[^>]*(?:class|style)=[^>]*>Project actions<\/h2>/);
    expect(all.text).not.toContain('>Release actions<');
    expect(all.text).not.toContain('>Category &amp; file actions<');

    const concrete = await agent.get(`/projects/${id}/assets?category=${category.id}`).expect(200);
    expect(actionGroupHeadings(concrete.text)).toEqual(
      expect.arrayContaining(['Release', 'File', 'Processing']),
    );

    const downgraded = await agent.get(`/projects/${id}/assets?category=${category.id}&search=keep`).expect(200);
    expect(actionGroupHeadings(downgraded.text)).toEqual(
      expect.arrayContaining(['Release', 'File', 'Processing']),
    );

    const uncategorized = await agent.get(`/projects/${id}/assets?category=uncategorized`).expect(200);
    expect(actionGroupHeadings(uncategorized.text)).toEqual(
      expect.arrayContaining(['Release', 'File', 'Processing']),
    );
  });

  it('keeps the disabled Processing subcard in archived projects', async () => {
    const id = await createProject('Archived Headings Check');
    addAsset(id, 'a.png');
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    const card = processingActionsCard(res.text);
    expect(card).toContain('<h3 class="asset-action-group-heading">Processing</h3>');
    expect(card).not.toContain('>Release<');
    expect(card).not.toContain('>File<');
  });

  it('keeps disabled Auto Rename visible for an archived project with no assets', async () => {
    const id = await createProject('Archived Empty Processing');
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    expectUnavailableAutoRename(processingActionsCard(res.text), 'Auto Rename — unavailable for archived projects');
  });

  function releaseSectionHtml(html) {
    const match = html.match(/<section class="asset-action-group">\s*<h3 class="asset-action-group-heading">Release<\/h3>[\s\S]*?<\/section>/);
    return match ? match[0] : '';
  }

  function fileSectionHtml(html) {
    const match = html.match(/<section class="asset-action-group">\s*<h3 class="asset-action-group-heading">File<\/h3>[\s\S]*?<\/section>/);
    return match ? match[0] : '';
  }

  it('keeps compact accessible Release and File controls consistent across both action-panel branches', async () => {
    const id = await createProject('Control Order Check');
    const category = assetCategoryRepo.addProjectCategory({
      projectId: id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
    });
    addAsset(id, 'a.png');
    addAsset(id, 'renders/b.png', { categoryId: category.id });

    for (const url of [`/projects/${id}/assets`, `/projects/${id}/assets?category=${category.id}`]) {
      const res = await agent.get(url).expect(200);
      const releaseSection = releaseSectionHtml(res.text);
      const fileSection = fileSectionHtml(res.text);

      expect(releaseSection).not.toBe('');
      expect(releaseSection).toContain('<legend class="sr-only">Add to release</legend>');
      expect(releaseSection).not.toContain('asset-action-group-controls--stacked');
      expect(releaseSection.indexOf('data-cc-dropdown')).toBeLessThan(releaseSection.indexOf('data-bulk-submit'));
      for (const label of ['Add to release', 'New release']) {
        const button = iconButton(releaseSection, label);
        expect(button).toContain(`data-tooltip="${label}"`);
        expect(button).toMatch(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
        expect(button.replace(/<[^>]+>/g, '').trim()).toBe('');
      }
      expect(res.text).toContain(`action="/projects/${id}/assets/add-to-release"`);
      expect(releaseSection).toContain(`formaction="/projects/${id}/assets/create-release"`);

      expect(fileSection).not.toBe('');
      expect(fileSection).toContain('<legend class="sr-only">Move selected to</legend>');
      expect(fileSection).not.toContain('asset-action-group-controls--stacked');
      for (const [label, path] of [
        ['Move selected', 'move-selected'],
        ['Copy selected', 'copy-selected'],
        ['Delete selected', 'delete-selected'],
      ]) {
        const button = iconButton(fileSection, label);
        expect(button).toContain(`data-tooltip="${label}"`);
        expect(button).toContain(`formaction="/projects/${id}/assets/${path}"`);
        expect(button).toMatch(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
        expect(button.replace(/<[^>]+>/g, '').trim()).toBe('');
      }
      const renameButton = iconButton(fileSection, 'Rename');
      expect(renameButton).toContain('type="button"');
      expect(renameButton).toContain('data-processing-rename-trigger');
      expect(renameButton).toContain('data-dialog-open="processing-rename-dialog"');
      expect(renameButton).toContain('data-tooltip="Rename"');
      expect(renameButton).toMatch(/\bdisabled\b/);
      expect(renameButton.replace(/<[^>]+>/g, '').trim()).toBe('');
      const convertButton = iconButton(fileSection, 'Convert');
      expect(convertButton).toContain('type="button"');
      expect(convertButton).toContain('data-dialog-open="processing-convert-dialog"');
      expect(convertButton).toContain('data-tooltip="Convert"');
      expect(convertButton.replace(/<[^>]+>/g, '').trim()).toBe('');
      const fileActionOrder = [
        'id="destination-category-action"',
        'data-dialog-open="processing-convert-dialog"',
        'data-processing-rename-trigger',
        `formaction="/projects/${id}/assets/move-selected"`,
        `formaction="/projects/${id}/assets/copy-selected"`,
        `formaction="/projects/${id}/assets/delete-selected"`,
      ].map((marker) => fileSection.indexOf(marker));
      expect(fileActionOrder.every((index) => index >= 0)).toBe(true);
      expect(fileActionOrder).toEqual([...fileActionOrder].sort((a, b) => a - b));

      const processingSection = processingActionsCard(res.text);
      expect(processingSection).not.toContain('data-dialog-open="processing-convert-dialog"');
      expect(res.text).toContain('<h2 id="processing-workflow-dialog-title">Image workflows editor</h2>');
      expect(res.text).toContain('data-processing-operation="convert"');
      expect(res.text).toContain('<h2 id="processing-rename-dialog-title">Rename</h2>');
      expect(res.text).toContain('data-processing-operation="rename"');
      expect(res.text).toMatch(/data-processing-operation="rename"[\s\S]*?data-processing-apply[^>]*>Save<\/button>/);
      expect(res.text).toMatch(/data-asset-basename="[^"]+"/);
      expect(res.text).toMatch(/data-asset-filename="[^"]+\.png"/);
      expect(res.text).toContain('data-asset-extension="png"');
    }
  });

  it('keeps Project Actions intrinsic on desktop and full-width on mobile', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    expect(css).toMatch(/\.asset-action-groups\s*\{\s*display:\s*grid;/);
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');

    const desktopGroupsRule = css.match(/@media\s*\(\s*min-width:\s*1024px\s*\)\s*\{\s*\.asset-action-groups\s*\{([^}]*)\}/)?.[1] || '';
    expect(desktopGroupsRule).toMatch(/grid-template-columns:\s*repeat\(3\s*,\s*minmax\(0\s*,\s*max-content\)\)/);
    expect(desktopGroupsRule).toMatch(/justify-content:\s*start/);

    const panelBodyRule = css.match(/\.asset-actions-panel\s*>\s*\.project-detail-section-body\s*\{([^}]*)\}/)?.[1] || '';
    expect(panelBodyRule).toMatch(/display:\s*flex/);
    expect(panelBodyRule).toMatch(/flex-flow:\s*row wrap/);
    expect(panelBodyRule).toMatch(/justify-content:\s*space-between/);

    const bulkFormRule = css.match(/\.asset-actions-panel\s*>\s*\.project-detail-section-body\s*>\s*\.bulk-select-form\s*\{([^}]*)\}/)?.[1] || '';
    expect(bulkFormRule).toMatch(/flex:\s*0 0 auto/);
    expect(bulkFormRule).toMatch(/max-width:\s*100%/);

    const actionControlsRule = css.match(/(?:^|})\s*\.asset-action-group-controls\s*\{([^}]*)\}/)?.[1] || '';
    expect(actionControlsRule).toMatch(/flex-wrap:\s*wrap/);
    expect(actionControlsRule).toMatch(/align-self:\s*flex-start/);
    expect(actionControlsRule).toMatch(/gap:\s*var\(--space-sm\)/);

    const moveFieldRule = css.match(/\.asset-action-group-controls\s*>\s*\.bulk-move-field\s*\{([^}]*)\}/)?.[1] || '';
    expect(moveFieldRule).toMatch(/flex:\s*0 1 auto/);
    expect(moveFieldRule).toMatch(/width:\s*max-content/);
    expect(moveFieldRule).toMatch(/max-width:\s*12rem/);
    expect(moveFieldRule).not.toMatch(/(?:^|[;\s])(?:flex|width):\s*12rem/);

    expect(css).toMatch(/@media\s*\(\s*max-width:\s*767px\s*\)\s*\{[\s\S]*?\.asset-action-groups\s*\{\s*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/\.asset-action-group-controls\s*>\s*\.bulk-release-field,\s*\.asset-action-group-controls\s*>\s*\.bulk-move-field\s*\{[\s\S]*?flex-basis:\s*100%;[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%/);

    const actionButtonRule = css.match(/\.asset-actions-panel\s+\.project-filter-control\s*\{([^}]*)\}/)?.[1] || '';
    const actionIconRule = css.match(/\.asset-actions-panel\s+\.project-filter-control svg\s*\{([^}]*)\}/)?.[1] || '';
    expect(actionButtonRule).toMatch(/min-block-size:\s*2\.25rem/);
    expect(actionButtonRule).toMatch(/min-inline-size:\s*2\.25rem/);
    expect(actionButtonRule).toMatch(/padding:\s*var\(--space-sm\)/);
    expect(actionIconRule).toMatch(/width:\s*1\.25rem/);
    expect(actionIconRule).toMatch(/height:\s*1\.25rem/);
    expect(css).not.toContain('padding: calc(var(--space-sm) - 1px)');
    expect(css).toMatch(/\[data-project-assets-live-region\] \.asset-viewer-display-controls \.project-filter-actions--projects\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?gap:\s*var\(--space-sm\)/);
  });

  it('lets Project Actions dropdown panels escape the shared section clipping boundary', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    expect(css).toMatch(/\.project-detail-section\s*\{[\s\S]*?overflow:\s*hidden/);
    expect(css).toMatch(/\.asset-actions-panel\s*\{[\s\S]*?overflow:\s*visible/);
    expect(css).toMatch(/\.asset-actions-panel\s*>\s*h2\s*\{[\s\S]*?border-radius:\s*calc\(var\(--radius-lg\) - 1px\) calc\(var\(--radius-lg\) - 1px\) 0 0/);
    expect(css).toMatch(/\.asset-filter-multiselect summary:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px/);
  });

  it('sizes View asset details only within Project Assets grid and list cards', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/static/creatorcrate.css'), 'utf8');
    expect(css).toMatch(/\.asset-details-link\s*\{[\s\S]*?flex:\s*0\s+0\s+1\.75rem;[\s\S]*?width:\s*1\.75rem;[\s\S]*?height:\s*1\.75rem;/);
    expect(css).toMatch(/\.asset-details-link svg\s*\{\s*width:\s*1\.125rem;\s*height:\s*1\.125rem;/);
    expect(css).toMatch(/\.asset-card--project \.asset-details-link,\s*\.asset-list-card--project \.asset-list-card-status \.asset-details-link\s*\{[\s\S]*?flex-basis:\s*2rem;[\s\S]*?width:\s*2rem;[\s\S]*?height:\s*2rem;/);
    expect(css).toMatch(/\.asset-card--project \.asset-details-link svg,\s*\.asset-list-card--project \.asset-list-card-status \.asset-details-link svg\s*\{\s*width:\s*1\.25rem;\s*height:\s*1\.25rem;/);
  });
});
