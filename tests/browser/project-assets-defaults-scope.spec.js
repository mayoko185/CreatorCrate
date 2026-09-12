import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// External runs intentionally edit defaults for two explicitly named projects.
// Without these environment variables all data is isolated and removed afterward.
async function fixture() {
  const external = process.env.CREATORCRATE_BROWSER_BASE_URL;
  if (external) {
    const ids = ['CREATORCRATE_BROWSER_PROJECT_A', 'CREATORCRATE_BROWSER_PROJECT_B']
      .map((key) => Number(process.env[key]));
    if (ids.some((id) => !Number.isInteger(id) || id <= 0) || ids[0] === ids[1]) {
      throw new Error('External scope regression requires two distinct explicit project IDs.');
    }
    return { baseURL: external, ids, close: async () => {} };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-scope-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  let db;
  let server;
  const close = async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (db) closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
    db = openDatabase(path.join(root, 'test.db'));
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
      assetManifest: createAssetManifest({ distRoot: viteDistRoot,
        manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
    });
    const ids = [];
    for (const title of ['Scope Browser A', 'Scope Browser B']) {
      const project = app.locals.projectService.create({ title, status: 'tbd' });
      ids.push(project.id);
      await sharp({ create: { width: 12, height: 12, channels: 3, background: '#336699' } })
        .png().toFile(path.join(projectsRoot, project.project_dir, 'final', 'scope.png'));
      app.locals.assetScanner.scanProjectAssets(project.id);
    }
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return { baseURL: `http://127.0.0.1:${server.address().port}`, ids, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('scope-only toggles live-refresh once, survive reloads, and preserve both projects', async ({ page, context }) => {
  const f = await fixture();
  const b = await context.newPage();
  const dialog = (p) => p.locator('#project-assets-defaults-dialog');
  const form = (p) => p.locator('#project-assets-defaults-form');
  const snapshots = (p) => form(p).locator('[data-project-assets-default-values]')
    .evaluate((el) => JSON.parse(el.textContent));
  const open = async (p, id) => {
    await p.goto(`${f.baseURL}/projects/${id}/assets`);
    await p.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
    await expect(dialog(p)).toBeVisible();
  };
  const settled = async (p) => {
    await expect(form(p)).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(p.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
  };
  const mutate = async (p, action) => {
    const posts = [];
    let navigations = 0;
    const onRequest = (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/assets/defaults')) posts.push(r);
      if (r.isNavigationRequest() && r.frame() === p.mainFrame()) navigations += 1;
    };
    p.on('request', onRequest);
    const saved = p.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    try {
      await action();
      expect((await saved).status()).toBe(302);
      await settled(p);
      expect(posts).toHaveLength(1);
      expect(navigations).toBe(0);
      await expect(dialog(p)).toBeVisible();
    } finally {
      p.off('request', onRequest);
    }
  };
  const scope = async (p, value) => {
    if (await form(p).locator('input[name="loadedScope"]').inputValue() === value) return;
    await mutate(p, () => dialog(p).getByText(value === 'global' ? 'Global' : 'Project only', { exact: true }).click());
    await expect(form(p).locator('input[name="loadedScope"]')).toHaveValue(value);
    expect(new URL(p.url()).searchParams.has('defaultsScope')).toBe(false);
  };
  const choose = async (p, key, label) => {
    const dropdown = dialog(p).locator(`#projectAssets-default-${key}-dropdown`);
    if ((await dropdown.locator('summary').getAttribute('aria-label')).endsWith(`: ${label}`)) return;
    await dropdown.locator('summary').click();
    await mutate(p, () => dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click());
  };
  const effective = async (p, view, sort) => {
    await expect(p.locator(`[data-project-assets-live-region] .asset-${view}`)).toHaveCount(1);
    expect(new URL(p.url()).searchParams.get('sort') || 'filename').toBe(sort);
  };
  const reload = async (p, active, view, sort) => {
    await p.reload();
    await effective(p, view, sort);
    await p.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
    await expect(form(p).locator('input[name="loadedScope"]')).toHaveValue(active);
    await expect(dialog(p).getByRole('radio', { name: active === 'global' ? 'Global' : 'Project only', exact: true })).toBeChecked();
  };
  try {
    await open(page, f.ids[0]);
    await scope(page, 'global');
    await choose(page, 'view', 'Grid');
    await choose(page, 'sort', 'Filename');
    await scope(page, 'project');
    await choose(page, 'view', 'List');
    await choose(page, 'sort', 'Modified date');
    const aRows = (await snapshots(page)).project;
    await dialog(page).getByRole('button', { name: 'Close Project Assets defaults' }).click();
    await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
    let releaseSave;
    let markIntercepted;
    const heldSave = new Promise((resolve) => { releaseSave = resolve; });
    const intercepted = new Promise((resolve) => { markIntercepted = resolve; });
    const defaultsRoute = `**/projects/${f.ids[0]}/assets/defaults`;
    const holdPost = async (route) => {
      if (route.request().method() === 'POST') {
        markIntercepted();
        await heldSave;
      }
      await route.continue();
    };
    await page.route(defaultsRoute, holdPost);
    try {
      await mutate(page, async () => {
        await dialog(page).getByText('Global', { exact: true }).click();
        await intercepted;
        await dialog(page).getByRole('button', { name: 'Close Project Assets defaults' }).click();
        await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
        await expect(form(page).locator('input[name="loadedScope"]')).toHaveValue('project');
        releaseSave();
      });
      await expect(form(page).locator('input[name="loadedScope"]')).toHaveValue('global');
      await expect(dialog(page).getByRole('radio', { name: 'Global', exact: true })).toBeChecked();
      await expect(form(page).locator('[data-dialog-field="view"] select')).toHaveValue('grid');
    } finally {
      releaseSave();
      await page.unroute(defaultsRoute, holdPost);
    }
    await effective(page, 'grid', 'filename');
    await reload(page, 'global', 'grid', 'filename');
    expect((await snapshots(page)).project).toEqual(aRows);
    await scope(page, 'project');
    await effective(page, 'list', 'modified');
    await reload(page, 'project', 'list', 'modified');
    expect((await snapshots(page)).project).toEqual(aRows);

    await open(b, f.ids[1]);
    await scope(b, 'project');
    await choose(b, 'view', 'List');
    await choose(b, 'sort', 'File size');
    const bRows = (await snapshots(b)).project;
    await scope(b, 'global');
    await effective(b, 'grid', 'filename');
    await choose(b, 'sort', 'Modified date');
    await reload(b, 'global', 'grid', 'modified');
    expect((await snapshots(b)).project).toEqual(bRows);
    await reload(page, 'project', 'list', 'modified');
    expect((await snapshots(page)).global.sort).toBe('modified');
    expect((await snapshots(page)).project).toEqual(aRows);
    await scope(page, 'global');
    await choose(page, 'sort', 'Filename');
    await scope(page, 'project');
    await open(b, f.ids[1]);
    await effective(b, 'grid', 'filename');
    await scope(b, 'project');
    await effective(b, 'list', 'size');
    expect((await snapshots(b)).project).toEqual(bRows);
    await scope(b, 'global');
    await reload(b, 'global', 'grid', 'filename');
    await reload(page, 'project', 'list', 'modified');
  } finally {
    await b.close();
    await f.close();
  }
});
