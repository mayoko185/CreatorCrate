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
let fixtureCount = 0;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-heading-tooltips-browser-'));
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

    const lead = page.locator('.page-heading > .page-heading-lead');
    const action = page.locator('.page-heading-actions .asset-tooltip[aria-label="Review & Publish"]');
    await expect(lead).toHaveAttribute('data-tooltip', `Back to main project page: ${projectTitle}`);
    await expect(action).toHaveCount(publish ? 1 : 0);

    await expectTooltipInside(page, lead, () => lead.hover());
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
