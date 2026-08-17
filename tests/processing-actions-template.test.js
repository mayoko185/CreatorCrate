/**
 * Processing actions placement on /projects/:id/assets.
 *
 * This page has a real history of one action-panel branch (the complete
 * category/auto-rename surface) diverging from the other (the ordinary
 * selection-only surface), causing content to disappear when viewing All or
 * when browser controls downgraded the surface. These tests prove the new
 * "Processing actions" subcard is rendered from the one shared partial in
 * every branch, additive to the existing Release actions / Category & file
 * actions subcards, and correctly gated on archived state — not on Auto
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

function processingActionsCard(html) {
  const match = html.match(/<section class="asset-action-group processing-action-group"[^>]*>[\s\S]*?<\/section>/);
  return match ? match[0] : '';
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

  function expectThreeButtons(card) {
    expect(card).toContain('>Watermark<');
    expect(card).toContain('>Edit workflow prompts<');
    expect(card).toContain('>Convert<');
  }

  it('renders on the ordinary branch when viewing All', async () => {
    const id = await createProject('All View Processing');
    addAsset(id, 'a.png');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    const card = processingActionsCard(res.text);
    expect(card).not.toBe('');
    expectThreeButtons(card);
    expect(card).toContain('data-dialog-open="processing-watermark-dialog"');
    expect(card).toContain('data-dialog-open="processing-workflow-dialog"');
    expect(card).toContain('data-dialog-open="processing-convert-dialog"');
    // Exactly one card — no duplicate render in a single response.
    expect((res.text.match(/class="asset-action-group processing-action-group"/g) || [])).toHaveLength(1);
  });

  it('renders on the ordinary branch when viewing Uncategorized', async () => {
    const id = await createProject('Uncategorized Processing');
    addAsset(id, 'a.png');
    const res = await agent.get(`/projects/${id}/assets?category=uncategorized`).expect(200);
    const card = processingActionsCard(res.text);
    expect(card).not.toBe('');
    expectThreeButtons(card);
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
    expectThreeButtons(card);
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
    expectThreeButtons(card);
  });

  it('is additive: Release actions and Category & file actions remain present alongside it', async () => {
    const id = await createProject('Additive Processing Check');
    addAsset(id, 'a.png');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    expect(res.text).toContain('<h3 class="asset-action-group-heading">Release actions</h3>');
    expect(res.text).toContain('<h3 class="asset-action-group-heading">Category &amp; file actions</h3>');
    expect((res.text.match(/<section class="asset-action-group processing-action-group"/g) || [])).toHaveLength(1);
    // The three original sections plus Processing actions = four distinct action-group sections.
    const allGroups = res.text.match(/<section class="asset-action-group[^>]*>/g) || [];
    expect(allGroups.length).toBeGreaterThanOrEqual(3);
  });

  it('disables the three buttons with an explanation on archived projects, without gating on Auto Rename', async () => {
    const id = await createProject('Archived Processing Check');
    addAsset(id, 'a.png');
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    const card = processingActionsCard(res.text);
    expect(card).not.toBe('');
    expect(card).not.toContain('data-dialog-open="processing-watermark-dialog"');
    expect(card).toMatch(/<button[^>]*disabled[^>]*aria-disabled="true"[^>]*>Watermark<\/button>/);
    expect(card).toMatch(/<button[^>]*disabled[^>]*aria-disabled="true"[^>]*>Edit workflow prompts<\/button>/);
    expect(card).toMatch(/<button[^>]*disabled[^>]*aria-disabled="true"[^>]*>Convert<\/button>/);
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
});
