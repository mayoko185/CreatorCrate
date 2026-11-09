import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// B2: the shared viewer dialog shell on a real opted-in page (Asset
// Library), driven through its controller from an isolated test opener.
// No page trigger opens it yet; hosts migrate in later packages.

const DIALOG = '#unified-viewer-dialog';

async function startApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-unified-viewer-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const app = createApp(
    { appName: 'CreatorCrate', db, projectsRoot },
    { appDataRoot, authState: { csrfPepper } },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(db);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let fixture;
test.beforeAll(async () => { fixture = await startApp(); });
test.afterAll(async () => { await fixture?.close(); });

async function openLibrary(page) {
  await page.goto(`${fixture.baseURL}/assets`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    const viewer = await import('/client/unified-viewer.js');
    return Boolean(viewer.unifiedViewerFor(document));
  });
  // An isolated opener and a stable host fallback inside the page's main.
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'test-viewer-host';
    host.innerHTML = '<button type="button" id="test-opener">Open viewer</button>'
      + '<button type="button" id="test-fallback">Fallback</button>';
    document.querySelector('main').prepend(host);
    document.body.style.minHeight = '300vh';
    window.scrollTo(0, 120);
  });
}

// Opens a non-wrapping three-item sequence (or `options.single`) from #test-opener.
async function openViewer(page, { single = false, fallback = false } = {}) {
  await page.locator('#test-opener').focus();
  return page.evaluate(async ({ single, fallback }) => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    const items = [1, 2, 3].map((id) => ({
      projectId: 7,
      assetId: id,
      title: `<b>image-${id}</b>.png`,
      mediaUrl: `/projects/7/assets/${id}/preview`,
      detailsUrl: `/projects/7/assets/${id}`,
    }));
    const opener = document.getElementById('test-opener');
    return unifiedViewerFor(document).open(createViewerSource({
      key: 'test',
      label: 'Test project',
      mode: single ? 'single' : 'sequence',
      items: single ? items.slice(1, 2) : items,
    }), {
      opener,
      fallbackFocus: fallback ? () => document.getElementById('test-fallback') : undefined,
    });
  }, { single, fallback });
}

const activeInDialog = (page) => page.evaluate((selector) => {
  const dialog = document.querySelector(selector);
  return dialog.contains(document.activeElement);
}, DIALOG);

test('mounts one closed viewer shell outside the page content', async ({ page }) => {
  await openLibrary(page);
  await expect(page.locator(DIALOG)).toHaveCount(1);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await page.locator(`main ${DIALOG}`).count()).toBe(0);
  // B5b retired the library's legacy slideshow scaffold: no second viewer.
  await expect(page.locator('[data-slideshow-scaffold]')).toHaveCount(0);
});

test('opens modally with predictable focus, contains focus and locks background scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLibrary(page);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(0);
  const urlBefore = page.url();

  expect(await openViewer(page)).toBeGreaterThan(0);
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
  await expect(dialog).toHaveAccessibleName('Viewer');
  await expect(page.getByRole('button', { name: 'Close Viewer' })).toBeFocused();
  await expect(page.locator('body')).toHaveClass(/app-dialog-open/);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

  // Title is text, not markup.
  await expect(dialog.locator('[data-unified-viewer-title]')).toHaveText('<b>image-1</b>.png');
  await expect(dialog.locator('[data-unified-viewer-title] b')).toHaveCount(0);
  await expect(dialog.locator('[data-unified-viewer-source]')).toHaveText('Test project');
  await expect(dialog.getByRole('link', { name: 'View details' })).toHaveAttribute('href', '/projects/7/assets/1');
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('1 of 3');

  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 600);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    expect(await activeInDialog(page)).toBe(true);
  }
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await activeInDialog(page)).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  expect(page.url()).toBe(urlBefore);
});

test('navigates with buttons and arrows inside non-wrapping boundaries', async ({ page }) => {
  await openLibrary(page);
  await openViewer(page);
  const dialog = page.locator(DIALOG);
  const previous = dialog.getByRole('button', { name: 'Previous' });
  const next = dialog.getByRole('button', { name: 'Next' });
  const position = dialog.locator('[data-unified-viewer-position]');

  await expect(previous).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveText('2 of 3');
  await expect(dialog.locator('[data-unified-viewer-title]')).toHaveText('<b>image-2</b>.png');
  await page.keyboard.press('ArrowLeft');
  await expect(position).toHaveText('1 of 3');

  await next.click();
  await next.click();
  await expect(position).toHaveText('3 of 3');
  await expect(next).toBeDisabled();
  await expect(previous).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveText('3 of 3');

  await dialog.getByRole('button', { name: 'Close Viewer' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
});

test('a single image has no sequence controls', async ({ page }) => {
  await openLibrary(page);
  await openViewer(page, { single: true });
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('[data-unified-viewer-title]')).toHaveText('<b>image-2</b>.png');
  await expect(dialog.getByRole('button', { name: 'Previous' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Next' })).toHaveCount(0);
  await expect(dialog.locator('[data-unified-viewer-controls]')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('backdrop presses and drags off the stage never dismiss it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLibrary(page);
  await openViewer(page);
  const dialog = page.locator(DIALOG);

  const box = await dialog.boundingBox();
  // The dialog leaves a backdrop margin around it.
  expect(box.x).toBeGreaterThan(4);
  await page.mouse.click(box.x / 2, box.y + box.height / 2);
  await expect(dialog).toBeVisible();

  const stage = await dialog.locator('[data-unified-viewer-stage]').boundingBox();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x / 2, box.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('reopens repeatedly and falls back when the opener was replaced', async ({ page }) => {
  await openLibrary(page);
  const dialog = page.locator(DIALOG);
  const sessions = [];
  for (let round = 0; round < 3; round += 1) {
    sessions.push(await openViewer(page));
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('1 of 3');
    await page.keyboard.press('ArrowRight');
    await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('2 of 3');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#test-opener')).toBeFocused();
  }
  expect(new Set(sessions).size).toBe(3);

  await openViewer(page, { fallback: true });
  await page.evaluate(() => document.getElementById('test-opener').remove());
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-fallback')).toBeFocused();

  // Without an opener or a host fallback, focus lands on the main landmark.
  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.id = 'test-opener';
    document.getElementById('test-viewer-host').append(opener);
  });
  await openViewer(page);
  await page.evaluate(() => document.getElementById('test-opener').remove());
  await page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    unifiedViewerFor(document).close();
  });
  await expect(dialog).toBeHidden();
  await expect(page.locator('main#main-content')).toBeFocused();
});

test('closes on a refresh that empties the source', async ({ page }) => {
  await openLibrary(page);
  const session = await openViewer(page);
  const dialog = page.locator(DIALOG);
  const result = await page.evaluate(async (current) => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const viewer = unifiedViewerFor(document);
    const stale = viewer.update([], { session: current + 1 });
    const kept = viewer.update([{ projectId: 7, assetId: 1, title: 'renamed.png', mediaUrl: '/p/1' }], { session: current });
    return { stale, kept: kept.outcome };
  }, session);
  expect(result).toEqual({ stale: null, kept: 'kept' });
  await expect(dialog.locator('[data-unified-viewer-title]')).toHaveText('renamed.png');
  await expect(dialog.getByRole('link', { name: 'View details' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Next' })).toHaveCount(0);

  await page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    unifiedViewerFor(document).update([]);
  });
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
});

test('coexists with the page’s other app dialogs', async ({ page }) => {
  await openLibrary(page);
  const defaults = page.locator('[data-dialog-open="asset-viewer-defaults-dialog"]').first();
  await expect(defaults).toBeVisible();
  await defaults.click();
  const defaultsDialog = page.locator('#asset-viewer-defaults-dialog');
  await expect(defaultsDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(defaultsDialog).toBeHidden();
  await expect(defaults).toBeFocused();

  await openViewer(page);
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(defaultsDialog).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();

  await defaults.click();
  await expect(defaultsDialog).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(defaultsDialog).toBeHidden();
});

test('fits a narrow viewport with usable controls', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await openLibrary(page);
  await page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    unifiedViewerFor(document).open(createViewerSource({
      key: 'narrow',
      label: 'A project label that is long enough to wrap on a phone screen',
      mode: 'sequence',
      items: [1, 2].map((id) => ({
        projectId: 7,
        assetId: id,
        title: `an-extremely-long-filename-without-spaces-${'x'.repeat(60)}-${id}.png`,
        mediaUrl: `/p/${id}`,
        detailsUrl: `/projects/7/assets/${id}`,
      })),
    }), { opener: document.getElementById('test-opener') });
  });
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const card = element.querySelector('.app-dialog-card');
    const stage = element.querySelector('[data-unified-viewer-stage]').getBoundingClientRect();
    const controls = element.querySelector('[data-unified-viewer-controls]').getBoundingClientRect();
    const next = element.querySelector('[data-unified-viewer-next]').getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      cardOverflowX: card.scrollWidth - card.clientWidth,
      stageHeight: stage.height,
      controlsBottom: controls.bottom,
      nextWidth: next.width,
      nextHeight: next.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.cardOverflowX).toBeLessThanOrEqual(0);
  expect(geometry.stageHeight).toBeGreaterThan(200);
  expect(geometry.controlsBottom).toBeLessThanOrEqual(geometry.bottom);
  expect(geometry.nextWidth).toBeGreaterThanOrEqual(44);
  expect(geometry.nextHeight).toBeGreaterThanOrEqual(44);
  await expect(dialog.getByRole('link', { name: 'View details' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close Viewer' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
