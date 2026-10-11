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

// One project whose first category holds a PNG and a Krita file, with a saved
// PNG extension default. All data is isolated and removed afterward.
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-scan-context-browser-'));
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
    const project = app.locals.projectService.create({ title: 'Scan Context Browser', status: 'tbd' });
    const [category] = app.locals.projectAssetCategoryService.list(project.id);
    const categoryDir = path.join(projectsRoot, project.project_dir, category.directory_slug);
    fs.mkdirSync(categoryDir, { recursive: true });
    await sharp({ create: { width: 12, height: 12, channels: 3, background: '#336699' } })
      .png().toFile(path.join(categoryDir, 'shown.png'));
    fs.writeFileSync(path.join(categoryDir, 'sketch.kra'), 'krita');
    app.locals.assetScanner.scanProjectAssets(project.id);
    app.locals.pageDefaultsService.saveDefault('projectAssets', 'extension', ['png'], ['png', 'kra']);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return { baseURL: `http://127.0.0.1:${server.address().port}`, id: project.id, categoryId: category.id, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('manual scan submits the current live-filter context instead of the initial render', async ({ page }) => {
  const f = await fixture();
  const region = page.locator('[data-project-assets-live-region]');
  const scanForm = page.locator(`form[action="/projects/${f.id}/scan/manual"]`);
  const scanContext = () => scanForm.locator('input[type="hidden"]:not([name="_csrf"])').evaluateAll(
    (inputs) => inputs.map((input) => [input.name, input.value]),
  );
  const settled = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const filterDialog = page.locator('#project-assets-filter-dialog');
  const openFilters = async () => {
    if (!(await filterDialog.isVisible())) {
      await page.getByRole('link', { name: 'Filter assets', exact: true }).click();
    }
    await expect(filterDialog).toBeVisible();
  };
  const card = (name) => region.locator('.asset-grid-item').filter({ hasText: name });
  try {
    // 1. Explicit category + PNG extension: only the PNG is in view.
    await page.goto(`${f.baseURL}/projects/${f.id}/assets?category=${f.categoryId}&extension=png`);
    await expect(card('shown.png')).toHaveCount(1);
    await expect(card('sketch.kra')).toHaveCount(0);
    expect(await scanContext()).toContainEqual(['extension', 'png']);

    // 2. Live Reset restores the saved defaults without a full navigation.
    let navigations = 0;
    const countNavigation = (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations += 1;
    };
    page.on('request', countNavigation);
    await openFilters();
    await page.locator('#project-assets-filter-dialog [data-project-assets-reset]').click();
    await settled();
    await expect(page).toHaveURL(/inheritedFilterDefaults=extension/);
    // The outside scan form follows the reset view, not the explicit subset.
    expect(await scanContext()).toContainEqual(['inheritedFilterDefaults', 'extension']);
    expect((await scanContext()).filter(([name]) => name === 'category')).toEqual([['category', 'all']]);
    expect(await scanContext()).toContainEqual(['extension', 'png']);

    // 3. Live category navigation suspends the inherited extension default.
    await openFilters();
    await page.locator('#asset-category-filter summary').click();
    await page.locator(`label[for="asset-category-option-${f.categoryId}"]`).click();
    await settled();
    await expect(page).toHaveURL(new RegExp(`category=${f.categoryId}`));
    page.off('request', countNavigation);
    expect(navigations).toBe(0);
    await page.keyboard.press('Escape');

    // 4. Both assets are visible and Auto Rename is eligible.
    await expect(card('sketch.kra')).toHaveCount(1);
    await expect(card('shown.png')).toHaveCount(1);
    await expect(region.locator('[data-auto-rename-surface]')).toHaveAttribute('data-auto-rename-enabled', 'true');
    const context = await scanContext();
    expect(context).toContainEqual(['category', String(f.categoryId)]);
    expect(context).toContainEqual(['inheritedFilterDefaults', 'extension']);
    // No duplicated or conflicting context fields.
    expect(new Set(context.map(([name]) => name)).size).toBe(context.length);
    expect(await scanForm.locator('input[name="_csrf"]').count()).toBe(1);

    // Back/Forward reloads the live region through the same path.
    await page.goBack();
    await expect(page).not.toHaveURL(new RegExp(`category=${f.categoryId}`));
    await settled();
    await expect(card('sketch.kra')).toHaveCount(0);
    expect(await scanContext()).toContainEqual(['category', 'all']);
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`category=${f.categoryId}`));
    await settled();
    await expect(card('sketch.kra')).toHaveCount(1);
    expect(await scanContext()).toEqual(context);

    // 5. Manual scan redirects back to the same complete category.
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/projects/${f.id}/assets` && url.searchParams.has('scan_result')),
      scanForm.getByRole('button', { name: 'Manually scan project files' }).click(),
    ]);
    const after = new URL(page.url());
    expect(after.searchParams.get('category')).toBe(String(f.categoryId));
    expect(after.searchParams.get('inheritedFilterDefaults')).toBe('extension');
    await expect(card('sketch.kra')).toHaveCount(1);
    await expect(card('shown.png')).toHaveCount(1);
    await expect(region.locator('.asset-grid-item')).toHaveCount(2);
    await expect(region.locator('[data-auto-rename-surface]')).toHaveAttribute('data-auto-rename-enabled', 'true');
    await region.getByRole('button', { name: 'Select all visible' }).click();
    await expect(region.locator('[data-auto-rename-submit]')).toBeEnabled();

    // An explicit extension filter chosen live still behaves as explicit.
    await page.goto(`${f.baseURL}/projects/${f.id}/assets?category=${f.categoryId}&extension=png`);
    await Promise.all([
      page.waitForURL((url) => url.searchParams.has('scan_result')),
      scanForm.getByRole('button', { name: 'Manually scan project files' }).click(),
    ]);
    const explicit = new URL(page.url());
    expect(explicit.searchParams.getAll('extension')).toEqual(['png']);
    expect(explicit.searchParams.has('inheritedFilterDefaults')).toBe(false);
    await expect(card('sketch.kra')).toHaveCount(0);
  } finally {
    await f.close();
  }
});
