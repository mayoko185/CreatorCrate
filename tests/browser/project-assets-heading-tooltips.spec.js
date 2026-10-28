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

// Project Assets heading tooltips in real Chromium: Manually scan, Remove
// missing assets, and Edit project keep their tooltips inside the viewport,
// hidden or shown, so the page never scrolls sideways. All data lives in a
// temporary root that is removed afterward.
let server;
let db;
let app;
let root;
let baseURL;
let activeId;
let archivedId;

async function createProject(title, projectsRoot) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const [category] = app.locals.projectAssetCategoryService.list(project.id);
  const categoryDir = path.join(projectsRoot, project.project_dir, category.directory_slug);
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const name of ['kept.png', 'gone.png']) {
    await sharp({ create: { width: 12, height: 12, channels: 3, background: '#336699' } })
      .png().toFile(path.join(categoryDir, name));
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  // A missing asset adds Remove missing assets between Scan and Edit.
  fs.rmSync(path.join(categoryDir, 'gone.png'));
  app.locals.assetScanner.scanProjectAssets(project.id);
  return project.id;
}

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-assets-heading-tooltips-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  fs.mkdirSync(previewRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  activeId = await createProject('Heading Tooltips Active', projectsRoot);
  archivedId = await createProject('Heading Tooltips Archived', projectsRoot);
  app.locals.projectService.archive(archivedId);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// The tooltip's box from its computed ::after style: the trigger's box, the
// resolved inset, the border-box width, and the transform's horizontal offset.
const tooltipBox = (locator) => locator.evaluate((node) => {
  const trigger = node.getBoundingClientRect();
  const style = getComputedStyle(node, '::after');
  const width = ['width', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
    .reduce((sum, property) => sum + parseFloat(style[property]), 0);
  const shift = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform).m41;
  const left = style.left !== 'auto'
    ? trigger.left + parseFloat(style.left)
    : trigger.right - parseFloat(style.right) - width;
  return { left: left + shift, right: left + shift + width, opacity: Number(style.opacity) };
});

const pageWidths = (page) => page.evaluate(() => ({
  viewport: document.documentElement.clientWidth,
  scroll: document.documentElement.scrollWidth,
}));

async function expectContained(page) {
  const { viewport, scroll } = await pageWidths(page);
  expect(scroll).toBeLessThanOrEqual(viewport);
}

async function expectTooltipInside(page, trigger, reveal) {
  const { viewport } = await pageWidths(page);
  const hidden = await tooltipBox(trigger);
  expect(hidden.left).toBeGreaterThanOrEqual(0);
  expect(hidden.right).toBeLessThanOrEqual(viewport);
  await reveal();
  await expect.poll(async () => (await tooltipBox(trigger)).opacity).toBe(1);
  const shown = await tooltipBox(trigger);
  expect(shown.left).toBeGreaterThanOrEqual(0);
  expect(shown.right).toBeLessThanOrEqual(viewport);
  await expectContained(page);
}

const ACTIONS = ['Manually scan project files', 'Remove missing assets', 'Edit project'];

const CASES = [
  { view: 'grid', width: 768 },
  { view: 'list', width: 768 },
  { view: 'grid', width: 390 },
  { view: 'list', width: 1440 },
];

for (const { view, width } of CASES) {
  test(`Project Assets ${view} at ${width}px keeps its heading tooltips inside the viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseURL}/projects/${activeId}/assets?view=${view}`);
    await expectContained(page);

    for (const label of ACTIONS) {
      const action = page.locator(`.page-heading-actions .asset-tooltip[aria-label="${label}"]`);
      await expect(action).toHaveAttribute('data-tooltip', label);
      await expectTooltipInside(page, action, () => action.hover());
      // Keyboard focus shows the same tooltip in the same place.
      await page.mouse.move(0, 0);
      await action.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(action).toBeFocused();
      await expectTooltipInside(page, action, async () => {});
      await action.blur();
    }
    await page.mouse.move(0, 0);
    await expectContained(page);
  });
}

test('archived Project Assets at 768px has no heading actions and no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`${baseURL}/projects/${archivedId}/assets`);
  await expect(page.locator('.page-heading-actions .project-assets-heading-action')).toHaveCount(0);
  await expectContained(page);
});
