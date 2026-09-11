import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

async function openFixture(page) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-info-card-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    const project = app.locals.projectService.create({
      title: 'Popup Browser Project',
      status: 'tbd',
    });
    const assetDirectory = path.join(projectsRoot, project.project_dir, 'renders');
    fs.mkdirSync(assetDirectory, { recursive: true });
    await sharp({
      create: { width: 80, height: 60, channels: 4, background: '#4f46e5' },
    }).png().toFile(path.join(assetDirectory, 'popup.png'));
    app.locals.assetScanner.scanProjectAssets(project.id);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    await page.setViewportSize({ width: 900, height: 640 });
    return {
      baseURL,
      async close() {
        if (server) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          server = null;
        }
        closeDatabase(db);
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function expectPointerFollowing(page, previewSelector, infoSelector) {
  const preview = page.locator(previewSelector).first();
  const info = page.locator(infoSelector).first();
  const box = await preview.boundingBox();
  expect(box).not.toBeNull();
  const firstPoint = { x: box.x + Math.min(24, box.width / 3), y: box.y + Math.min(24, box.height / 3) };
  const secondPoint = {
    x: Math.min(box.x + box.width - 5, firstPoint.x + 28),
    y: Math.min(box.y + box.height - 5, firstPoint.y + 22),
  };

  await page.mouse.move(firstPoint.x, firstPoint.y);
  await expect(info).toBeVisible();
  expect(await info.evaluate((node) => node.matches(':popover-open'))).toBe(true);
  const first = await info.boundingBox();
  await page.mouse.move(secondPoint.x, secondPoint.y, { steps: 4 });
  await expect.poll(async () => info.boundingBox()).not.toEqual(first);
  const second = await info.boundingBox();
  expect(Math.abs((second.x - first.x) - (secondPoint.x - firstPoint.x))).toBeLessThanOrEqual(2);
  expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThan(10);
  return { preview, info };
}

test('shared Asset Viewer and Projects info cards use cursor, top-layer, dialog, focus, and refresh lifecycles', async ({ page }) => {
  const fixture = await openFixture(page);
  try {
    await page.goto(`${fixture.baseURL}/asset-viewer`, { waitUntil: 'domcontentloaded' });
    const asset = await expectPointerFollowing(
      page,
      '[data-asset-viewer-preview]',
      '[data-asset-info-card]',
    );

    await asset.preview.evaluate((node) => {
      node.dispatchEvent(new PointerEvent('pointerenter', {
        clientX: window.innerWidth - 2,
        clientY: window.innerHeight - 2,
      }));
    });
    await expect(asset.info).toBeVisible();
    const edgeInfo = await asset.info.boundingBox();
    expect(edgeInfo.x).toBeGreaterThanOrEqual(8);
    expect(edgeInfo.y).toBeGreaterThanOrEqual(8);
    expect(edgeInfo.x + edgeInfo.width).toBeLessThanOrEqual(892);
    expect(edgeInfo.y + edgeInfo.height).toBeLessThanOrEqual(632);

    const topLayerHit = await asset.info.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '2147483647', background: 'rgba(255, 0, 0, 0.01)',
      });
      document.body.append(overlay);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      overlay.remove();
      return Boolean(hit?.closest?.('[data-asset-info-card]'));
    });
    expect(topLayerHit).toBe(true);

    await page.mouse.move(2, 2);
    const assetPreviewLink = asset.preview.locator('a').first();
    await assetPreviewLink.focus();
    await expect(asset.info).toBeVisible();
    const focusPosition = await asset.info.boundingBox();
    await page.mouse.move(10, 10);
    expect(await asset.info.boundingBox()).toEqual(focusPosition);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(assetPreviewLink).toBeFocused();
    await expect(asset.info).toBeVisible();

    await page.getByRole('link', { name: 'Filter assets' }).click();
    const assetFilterDialog = page.locator('#asset-viewer-filter-dialog');
    await expect(assetFilterDialog).toBeVisible();
    await expect(asset.info).not.toBeVisible();
    const oldAssetRegion = await page.locator('[data-asset-library-live-region]').elementHandle();
    const response = page.waitForResponse((candidate) => (
      candidate.request().method() === 'GET' && new URL(candidate.url()).pathname === '/asset-viewer'
    ));
    await assetFilterDialog.locator('#asset-extension-filter > summary').click();
    await assetFilterDialog.locator('input[name="extension"][value="png"]').check();
    await response;
    await expect(assetFilterDialog).toBeVisible();
    await expect.poll(async () => oldAssetRegion.evaluate((node) => node.isConnected)).toBe(false);
    await expect(page.locator('[data-asset-info-card]:popover-open')).toHaveCount(0);
    await assetFilterDialog.getByRole('button', { name: 'Close Filter' }).click();

    await page.getByRole('link', { name: 'Asset Viewer defaults' }).click();
    await expect(page.locator('#asset-viewer-defaults-dialog')).toBeVisible();
    await expect(page.locator('[data-asset-info-card]:popover-open')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto(`${fixture.baseURL}/projects`, { waitUntil: 'domcontentloaded' });
    const project = await expectPointerFollowing(
      page,
      '[data-project-grid-preview]',
      '[data-project-info-card]',
    );
    await page.getByRole('link', { name: 'Filter projects' }).click();
    await expect(page.locator('#projects-filter-dialog')).toBeVisible();
    await expect(project.info).not.toBeVisible();
    await page.locator('#projects-filter-dialog').getByRole('button', { name: 'Close Filter' }).click();

    await project.preview.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      node.dispatchEvent(new PointerEvent('pointerenter', {
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      }));
    });
    await expect(project.info).toBeVisible();
    await page.getByRole('link', { name: 'Projects defaults' }).click();
    await expect(page.locator('#projects-defaults-dialog')).toBeVisible();
    await expect(project.info).not.toBeVisible();
  } finally {
    await fixture.close();
  }
});
