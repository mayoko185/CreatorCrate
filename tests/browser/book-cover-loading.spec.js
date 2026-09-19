import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function makeAnimatedCover() {
  const width = 40;
  const height = 60;
  const colors = [[220, 20, 20], [20, 190, 70], [30, 80, 220]];
  const raw = Buffer.alloc(width * height * colors.length * 3);
  colors.forEach((color, frame) => {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = (frame * width * height + pixel) * 3;
      raw.set(color, offset);
    }
  });
  return sharp(raw, { raw: { width, height: height * colors.length, channels: 3, pageHeight: height } })
    .webp({ lossless: true, delay: colors.map(() => 120), loop: 0 })
    .toBuffer();
}

test('Book covers explain delayed preview and thumbnail requests without layout shift', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-cover-loading-'));
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Delayed cover' });
    const bytes = await makeAnimatedCover();
    const { record } = await app.locals.managedImageService.createCommittedImage({ bytes });
    app.locals.bookPrimaryImageService.setManagedPrimaryImage(book.id, record.id);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const previewGate = deferred();
    const previewRequested = deferred();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/managed-assets/*/preview*', async (route) => {
      previewRequested.resolve();
      await previewGate.promise;
      await route.continue();
    });

    await page.goto(`${base}/notes/books/${book.id}/edit`, { waitUntil: 'domcontentloaded' });
    await previewRequested.promise;
    const detailCover = page.locator('.notes-book-detail-sidebar .notes-book-cover').first();
    const detailLoading = detailCover.locator('[data-preview-loading]');
    await expect(detailCover).toHaveAttribute('data-preview-state', 'loading');
    await expect(detailLoading).toBeVisible();
    await expect(detailLoading).toContainText('Loading cover…');
    await expect(detailCover.locator('img')).not.toBeVisible();
    const loadingBox = await detailCover.boundingBox();
    expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, x: scrollX })))
      .toEqual(expect.objectContaining({ x: 0 }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    const dialog = page.locator('#book-edit-dialog');
    const disclosure = dialog.locator('details').filter({ has: page.locator('summary', { hasText: /^Book cover$/ }) });
    await disclosure.locator('summary').click();
    await expect(disclosure.locator('[data-preview-loading]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    previewGate.resolve();
    await expect(detailCover).toHaveAttribute('data-preview-state', 'loaded');
    await expect(detailLoading).toBeHidden();
    await expect(detailCover.locator('img')).toBeVisible();
    expect(await detailCover.boundingBox()).toEqual(loadingBox);
    const preview = await app.locals.managedMediaService.getDerivative(record.id, 'preview');
    expect(await sharp(preview.bytes, { animated: true, pages: -1 }).metadata()).toMatchObject({
      pages: 3,
      pageHeight: 60,
      delay: [120, 120, 120],
    });
    expect(pageErrors).toEqual([]);

    await page.getByRole('link', { name: 'Edit book', exact: true }).click();
    if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
    await expect(disclosure.locator('.notes-book-cover')).toHaveAttribute('data-preview-state', 'loaded');
    await expect(disclosure.locator('img')).toBeVisible();
    await expect(disclosure.locator('[data-preview-loading]')).toBeHidden();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await detailCover.locator('.notes-book-cover-loading-indicator').evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
    await page.setViewportSize({ width: 390, height: 640 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && scrollX === 0)).toBe(true);

    await page.unroute('**/managed-assets/*/preview*');
    await page.goto(`${base}/notes`, { waitUntil: 'load' });
    const shelfCover = page.locator('.notes-book-card .notes-book-cover');
    await expect(shelfCover).toHaveAttribute('data-preview-state', 'loaded');
    await expect(shelfCover.locator('[data-preview-loading]')).toBeHidden();
    await expect(shelfCover.locator('img')).toBeVisible();
    const thumbnail = await app.locals.managedMediaService.getDerivative(record.id, 'thumbnail');
    expect((await sharp(thumbnail.bytes, { animated: true, pages: -1 }).metadata()).pages ?? 1).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth && scrollX === 0)).toBe(true);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
