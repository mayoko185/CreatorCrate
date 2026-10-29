import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// Release Detail heading tooltips in real Chromium: the project link's and
// Review & Publish's tooltips stay inside the viewport, hidden or shown, so
// the page never scrolls sideways. All data lives in a temporary root that is
// removed afterward.
const PROJECT_TITLE = 'A Considerably Long Project Title For Tooltip Width';

let server;
let db;
let app;
let root;
let baseURL;
let projectsRoot;
let fixtureCount = 0;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-heading-tooltips-browser-'));
  projectsRoot = path.join(root, 'projects');
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

function createRelease(state) {
  fixtureCount += 1;
  const projectTitle = `${PROJECT_TITLE} ${fixtureCount}`;
  const project = app.locals.projectService.create({ title: projectTitle });
  const { id } = db.prepare(`
    INSERT INTO releases (project_id, title, planned_date, published_date, archived_at)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).get(project.id, `${state} release`,
    state === 'scheduled' ? '2099-01-15' : null,
    state === 'published' ? '2026-01-15' : null,
    state === 'archived' ? '2026-01-15 00:00:00' : null);
  return { releaseId: id, projectTitle };
}

// The tooltip's box from its computed ::after style: its anchor's box (the
// trigger, or the trigger's offset parent when the trigger is static), the
// resolved inset, the border-box width, and the transform's horizontal offset.
const tooltipBox = (locator) => locator.evaluate((node) => {
  const anchor = getComputedStyle(node).position === 'static' ? node.offsetParent : node;
  const trigger = anchor.getBoundingClientRect();
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

const CASES = [
  { state: 'draft', width: 768, publish: true },
  { state: 'scheduled', width: 768, publish: true },
  { state: 'draft', width: 390, publish: true },
  { state: 'published', width: 390, publish: false },
  { state: 'archived', width: 390, publish: false },
  { state: 'published', width: 768, publish: false },
  { state: 'draft', width: 1440, publish: true },
  { state: 'archived', width: 1440, publish: false },
];

for (const { state, width, publish } of CASES) {
  test(`${state} Release Detail at ${width}px keeps its heading tooltips inside the viewport`, async ({ page }) => {
    const { releaseId, projectTitle } = createRelease(state);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseURL}/releases/${releaseId}`);

    const nav = page.locator('.page-heading > .page-heading-navigation--text');
    const leads = [
      { link: nav.getByRole('link', { name: 'Project', exact: true }), tooltip: 'Go to project details' },
      { link: nav.getByRole('link', { name: 'Assets', exact: true }), tooltip: 'Go to project assets' },
    ];
    const action = page.locator('.page-heading-actions .asset-tooltip[aria-label="Review & Publish"]');
    await expect(nav.getByRole('link')).toHaveCount(2);
    await expect(action).toHaveCount(publish ? 1 : 0);
    await expect(page.locator('.page-heading')).not.toContainText(projectTitle);

    for (const { link, tooltip } of leads) {
      await expect(link).toHaveAttribute('data-tooltip', tooltip);
      await expect(link).toHaveAccessibleDescription(tooltip);
      await expectTooltipInside(page, link, () => link.hover());
      // Keyboard focus shows the same tooltip in the same place.
      await page.mouse.move(0, 0);
      await link.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      await expectTooltipInside(page, link, async () => {});
      await link.blur();
    }
    const [projectBox, assetsBox] = await Promise.all(leads.map(({ link }) => link.boundingBox()));
    const headingBox = await page.locator('.page-heading').boundingBox();
    expect(projectBox.x).toBeCloseTo(headingBox.x, 0);
    expect(assetsBox.x).toBeGreaterThan(projectBox.x);
    if (publish) {
      await expectTooltipInside(page, action, () => action.hover());
      // Keyboard focus shows the same tooltip in the same place.
      await page.mouse.move(0, 0);
      await action.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(action).toBeFocused();
      await expectTooltipInside(page, action, async () => {});
    }
    await page.mouse.move(0, 0);
    await expectContained(page);
  });
}

// The Asset Viewer adds "← Release" for an asset a release uses. It ends the
// row at 360px and wraps to start a new one at 320px; either way its tooltip
// stays inside the viewport.
for (const width of [320, 360]) {
  test(`Asset Viewer at ${width}px keeps its Release tooltip inside the viewport`, async ({ page }) => {
    const project = app.locals.projectService.create({ title: `Asset Viewer ${width}` });
    const categories = app.locals.projectAssetCategoryService;
    if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
      categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
    }
    const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
    fs.mkdirSync(categoryDir, { recursive: true });
    fs.writeFileSync(path.join(categoryDir, 'notes.txt'), 'release asset');
    app.locals.assetScanner.scanProjectAssets(project.id);
    const { id: assetId } = db.prepare('SELECT id FROM assets WHERE project_id = ?').get(project.id);
    const { id: releaseId } = db.prepare('INSERT INTO releases (project_id, title) VALUES (?, ?) RETURNING id')
      .get(project.id, 'Viewer release');
    db.prepare('INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)').run(releaseId, assetId);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseURL}/projects/${project.id}/assets/${assetId}`);

    const nav = page.locator('.page-heading > .page-heading-navigation--text');
    const projectLink = nav.getByRole('link', { name: 'Project', exact: true });
    const release = nav.getByRole('link', { name: 'Release', exact: true });
    await expect(nav.getByRole('link')).toHaveCount(3);
    await expect(release).toHaveAttribute('href', `/releases/${releaseId}`);
    await expect(release).toHaveAttribute('data-tooltip', 'Go to release details');
    await expectTooltipInside(page, release, () => release.hover());
    // Keyboard focus shows the same tooltip in the same place.
    await page.mouse.move(0, 0);
    await release.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(release).toBeFocused();
    await expectTooltipInside(page, release, async () => {});
    await release.blur();
    // The links stay left-aligned: Release ends Project's row at 360px and
    // starts its own row at 320px.
    const [projectBox, releaseBox, headingBox] = await Promise.all([
      projectLink.boundingBox(), release.boundingBox(), page.locator('.page-heading').boundingBox(),
    ]);
    expect(projectBox.x).toBeCloseTo(headingBox.x, 0);
    if (width === 360) expect(releaseBox.y).toBeCloseTo(projectBox.y, 0);
    else expect(releaseBox.x).toBeCloseTo(headingBox.x, 0);
    await page.mouse.move(0, 0);
    await expectContained(page);
  });
}
