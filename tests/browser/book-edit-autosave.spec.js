import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

test('Edit Book persists committed title and cover changes while the dialog remains open', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-edit-autosave-'));
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Original title' });
    app.locals.noteService.createNote({ bookId: book.id, title: 'Ordered Page' });
    const coverExpectations = [];
    const updateBookWithManagedPrimaryImage = app.locals.bookService.updateBookWithManagedPrimaryImage.bind(app.locals.bookService);
    app.locals.bookService.updateBookWithManagedPrimaryImage = (...args) => {
      coverExpectations.push(args[3]?.expectedSource ?? null);
      return updateBookWithManagedPrimaryImage(...args);
    };
    const image = async (color) => ({
      name: `${color}.png`,
      mimeType: 'image/png',
      buffer: await sharp({ create: { width: 20, height: 20, channels: 3, background: color } }).png().toBuffer(),
    });
    const red = await image('red');
    const blue = await image('blue');
    const yellow = await image('yellow');
    const green = await image('green');
    const invalid = { name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('not an image') };
    const posts = [];
    let delayedFirstTitle = false;
    let loseNextPostResponse = false;
    let failNextGet = false;
    let responseLossDelay = 0;
    await page.route(`**/notes/books/${book.id}`, async (route) => {
      const request = route.request();
      if (failNextGet && request.method() === 'GET') {
        failNextGet = false;
        await route.abort('failed');
        return;
      }
      if (!delayedFirstTitle && request.method() === 'POST'
        && request.headers()['content-type']?.includes('application/x-www-form-urlencoded')
        && request.postData()?.includes('title=Older+title')) {
        delayedFirstTitle = true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (loseNextPostResponse && request.method() === 'POST') {
        loseNextPostResponse = false;
        await route.fetch();
        if (responseLossDelay > 0) await new Promise((resolve) => setTimeout(resolve, responseLossDelay));
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/notes/books/${book.id}`) {
        posts.push({
          type: request.headers()['content-type'],
          body: request.postDataBuffer()?.toString('utf8') || request.postData() || '',
        });
      }
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/notes/books/${book.id}`);
    await page.getByRole('link', { name: 'Edit book', exact: true }).click();
    const dialog = page.locator('#book-edit-dialog');
    const title = dialog.locator('[name="title"]');
    const cover = dialog.locator('[name="cover"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(dialog.locator('button[form="book-delete-form"]', { hasText: 'Delete Book' })).toHaveCount(1);

    await title.fill('   ');
    await title.press('Tab');
    await expect(dialog.locator('#title-error')).toHaveText('Title is required.');
    expect(app.locals.bookService.getBook(book.id).title).toBe('Original title');
    await expect(dialog).toBeVisible();

    await title.fill('Older title');
    await title.press('Tab');
    await title.fill('  Immediate title  ');
    await title.press('Tab');
    await expect.poll(() => app.locals.bookService.getBook(book.id).title).toBe('Immediate title');
    await expect(page.locator('.app-section-title')).toHaveText('Notes — Immediate title');
    await expect(dialog).toBeVisible();
    expect(posts[0].type).toContain('application/x-www-form-urlencoded');
    expect(posts[0].body).not.toContain('cover');

    loseNextPostResponse = true;
    failNextGet = true;
    responseLossDelay = 150;
    await title.fill('Uncertain committed title');
    await title.press('Tab');
    await title.fill('Queued after uncertainty');
    await title.press('Tab');
    const reconciliationRetry = dialog.getByRole('button', { name: 'Retry reconciliation', exact: true });
    await reconciliationRetry.focus();
    await expect(reconciliationRetry).toBeFocused();
    await reconciliationRetry.press('Enter');
    await expect(reconciliationRetry).toHaveCount(0);
    await expect(title).toBeFocused();
    await expect.poll(() => page.evaluate(() => ({
      connected: document.activeElement?.isConnected,
      insideDialog: Boolean(document.querySelector('#book-edit-dialog')?.contains(document.activeElement)),
      tagName: document.activeElement?.tagName,
    }))).toEqual({ connected: true, insideDialog: true, tagName: 'INPUT' });
    await expect.poll(() => app.locals.bookService.getBook(book.id).title).toBe('Queued after uncertainty');
    await expect(page.locator('.app-section-title')).toHaveText('Notes — Queued after uncertainty');
    await expect(dialog).toHaveAttribute('open', '');
    expect(posts.filter(({ body }) => body.includes('title=Uncertain+committed+title'))).toHaveLength(1);
    expect(posts.filter(({ body }) => body.includes('title=Queued+after+uncertainty'))).toHaveLength(1);

    await title.fill('Uncommitted cover-time title');
    await cover.setInputFiles(red);
    await expect.poll(() => app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)?.kind).toBe('managed_asset');
    const firstSource = app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id);
    expect(app.locals.bookService.getBook(book.id).title).toBe('Queued after uncertainty');
    await expect(title).toHaveValue('Uncommitted cover-time title');
    const firstCoverPost = posts.filter(({ type }) => type?.includes('multipart/form-data')).at(-1);
    expect(firstCoverPost.body).toMatch(/name="title"\r\n\r\nQueued after uncertainty\r\n/);
    const firstVisibleCover = `/managed-assets/${firstSource.id}/preview`;
    await expect(dialog.locator('[name="expectedCoverId"]')).toHaveValue(firstSource.id);
    await expect(page.locator('[data-book-detail-live-region] .notes-book-cover-image')).toHaveAttribute('src', firstVisibleCover);
    await expect(dialog.locator('[data-book-current-cover-presentation] .notes-book-cover-image')).toHaveAttribute('src', firstVisibleCover);
    await expect(dialog).toBeVisible();

    await title.press('Tab');
    await expect.poll(() => app.locals.bookService.getBook(book.id).title).toBe('Uncommitted cover-time title');

    await title.evaluate((element) => {
      element.value = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await cover.setInputFiles(blue);
    const confirmation = page.getByRole('dialog', { name: 'Replace cover image?' });
    await confirmation.getByRole('button', { name: 'Replace cover', exact: true }).click();
    await expect.poll(() => app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)?.id).not.toBe(firstSource.id);
    const blankDraftCoverSource = app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id);
    const blankDraftVisibleCover = `/managed-assets/${blankDraftCoverSource.id}/preview`;
    expect(app.locals.bookService.getBook(book.id).title).toBe('Uncommitted cover-time title');
    await expect(title).toHaveValue('');
    await expect(page.locator('[data-book-detail-live-region] .notes-book-cover-image')).toHaveAttribute('src', blankDraftVisibleCover);
    await expect(dialog.locator('[data-book-current-cover-presentation] .notes-book-cover-image')).toHaveAttribute('src', blankDraftVisibleCover);
    await title.evaluate((element) => {
      element.value = 'Uncommitted cover-time title';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await cover.setInputFiles(invalid);
    await confirmation.getByRole('button', { name: 'Replace cover', exact: true }).click();
    await expect(dialog.locator('.error-summary')).toContainText('A valid PNG, JPEG or WebP image, including bounded animated WebP');
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual(blankDraftCoverSource);
    await expect(dialog).toBeVisible();

    await cover.setInputFiles(blue);
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => db.prepare('SELECT count(*) AS n FROM managed_assets').get().n).toBe(2);
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual(blankDraftCoverSource);

    await cover.setInputFiles(blue);
    await confirmation.getByRole('button', { name: 'Replace cover', exact: true }).click();
    await expect.poll(() => app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)?.id).not.toBe(blankDraftCoverSource.id);
    const secondSource = app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id);
    const secondVisibleCover = `/managed-assets/${secondSource.id}/preview`;
    await expect(dialog.locator('[name="expectedCoverId"]')).toHaveValue(secondSource.id);
    await expect(page.locator('[data-book-detail-live-region] .notes-book-cover-image')).toHaveAttribute('src', secondVisibleCover);
    await expect(dialog.locator('[data-book-current-cover-presentation] .notes-book-cover-image')).toHaveAttribute('src', secondVisibleCover);

    loseNextPostResponse = true;
    responseLossDelay = 0;
    await cover.setInputFiles(yellow);
    await confirmation.getByRole('button', { name: 'Replace cover', exact: true }).click();
    await expect.poll(() => app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)?.id).not.toBe(secondSource.id);
    const uncertainCoverSource = app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id);
    await expect(dialog.locator('[name="expectedCoverId"]')).toHaveValue(uncertainCoverSource.id);

    await cover.setInputFiles(green);
    await confirmation.getByRole('button', { name: 'Replace cover', exact: true }).click();
    await expect.poll(() => app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)?.id).not.toBe(uncertainCoverSource.id);
    const multipart = posts.filter(({ type }) => type?.includes('multipart/form-data'));
    expect(multipart).toHaveLength(6);
    expect(coverExpectations.at(-1)).toEqual(uncertainCoverSource);
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(`${base}/notes/books/${book.id}`);

    await dialog.getByRole('button', { name: 'Close Edit Book' }).click();
    await page.goto(`${base}/notes/books/${book.id}/order`);
    await expect(page.locator('#book-order-dialog').getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(page.locator('#book-order-dialog').getByText('Changes are saved immediately.', { exact: false })).toBeVisible();
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Edit Book retries acknowledged title and cover presentation with GET only', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-edit-refresh-retry-'));
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Original title' });
    const coverFile = {
      name: 'retry-cover.png',
      mimeType: 'image/png',
      buffer: await sharp({ create: { width: 20, height: 20, channels: 3, background: 'purple' } }).png().toBuffer(),
    };
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const bookUrl = `${base}/notes/books/${book.id}`;
    await page.goto(bookUrl);
    await page.getByRole('link', { name: 'Edit book', exact: true }).click();
    const dialog = page.locator('#book-edit-dialog');
    const title = dialog.locator('[name="title"]');
    const cover = dialog.locator('[name="cover"]');
    const status = dialog.locator('[data-book-edit-save-status]');
    const posts = [];
    let failNextGet = true;
    await page.route(`**/notes/books/${book.id}`, async (route) => {
      if (route.request().method() === 'GET' && failNextGet) {
        failNextGet = false;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    page.on('request', (request) => {
      if (request.method() === 'POST'
        && new URL(request.url()).pathname === `/notes/books/${book.id}`) {
        posts.push(request.headers()['content-type'] || '');
      }
    });

    await title.fill('Acknowledged title');
    await title.press('Tab');
    await expect(status).toContainText('The Book was saved, but its detail could not refresh.');
    let retry = dialog.getByRole('button', { name: 'Retry refresh', exact: true });
    await expect(retry).toBeVisible();
    failNextGet = true;
    await retry.focus();
    await retry.press('Enter');
    retry = dialog.getByRole('button', { name: 'Retry refresh', exact: true });
    await expect(retry).toBeFocused();
    await retry.press('Enter');
    await expect(status).toHaveText('Book saved. Presentation refreshed.');
    await expect(page.locator('.app-section-title')).toHaveText('Notes — Acknowledged title');
    await expect(title).toHaveValue('Acknowledged title');
    await expect(title).toBeFocused();
    await expect.poll(() => page.evaluate(() => ({
      connected: document.activeElement?.isConnected,
      insideDialog: Boolean(document.querySelector('#book-edit-dialog')?.contains(document.activeElement)),
      tagName: document.activeElement?.tagName,
    }))).toEqual({ connected: true, insideDialog: true, tagName: 'INPUT' });
    expect(posts.filter((type) => type.includes('application/x-www-form-urlencoded'))).toHaveLength(1);

    failNextGet = true;
    await cover.setInputFiles(coverFile);
    await expect(status).toContainText('The Book was saved, but its detail could not refresh.');
    const acknowledgedCover = app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id);
    await expect(dialog.locator('[name="expectedCoverId"]')).toHaveValue(acknowledgedCover.id);
    retry = dialog.getByRole('button', { name: 'Retry refresh', exact: true });
    await expect(retry).toBeVisible();
    await retry.click();

    const visibleCover = `/managed-assets/${acknowledgedCover.id}/preview`;
    await expect(status).toHaveText('Book saved. Presentation refreshed.');
    await expect(retry).toHaveCount(0);
    await expect(title).toBeFocused();
    await expect(page.locator('[data-book-detail-live-region] .notes-book-cover-image')).toHaveAttribute('src', visibleCover);
    await expect(dialog.locator('[data-book-current-cover-presentation] .notes-book-cover-image')).toHaveAttribute('src', visibleCover);
    expect(posts.filter((type) => type.includes('multipart/form-data'))).toHaveLength(1);
    expect(page.url()).toBe(bookUrl);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Edit Book reconciles a controlled stale cover before another replacement', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-edit-stale-cover-'));
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Canonical title' });
    const coverExpectations = [];
    const updateBookWithManagedPrimaryImage = app.locals.bookService.updateBookWithManagedPrimaryImage.bind(app.locals.bookService);
    app.locals.bookService.updateBookWithManagedPrimaryImage = (...args) => {
      coverExpectations.push(args[3]?.expectedSource ?? null);
      return updateBookWithManagedPrimaryImage(...args);
    };
    const image = async (name, color) => ({
      name,
      mimeType: 'image/png',
      buffer: await sharp({ create: { width: 20, height: 20, channels: 3, background: color } }).png().toBuffer(),
    });
    const coverA = await image('cover-a.png', 'red');
    const coverB = await image('cover-b.png', 'blue');
    const rejectedC = await image('rejected-c.png', 'yellow');
    const deliberateD = await image('deliberate-d.png', 'green');

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/notes/books/${book.id}`);
    await page.getByRole('link', { name: 'Edit book', exact: true }).click();
    const dialog = page.locator('#book-edit-dialog');
    const title = dialog.locator('[name="title"]');
    const cover = dialog.locator('[name="cover"]');
    const status = dialog.locator('[data-book-edit-save-status]');
    const confirmation = page.getByRole('dialog', { name: 'Replace cover image?' });

    await cover.setInputFiles(coverA);
    await expect.poll(() => app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)?.kind).toBe('managed_asset');
    const sourceA = app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id);
    const visibleA = `/managed-assets/${sourceA.id}/preview`;
    await page.reload();
    await page.getByRole('link', { name: 'Edit book', exact: true }).click();
    await expect(page.locator('[data-book-detail-live-region] .notes-book-cover-image')).toHaveAttribute('src', visibleA);
    await expect(dialog.locator('[data-book-current-cover-presentation] .notes-book-cover-image')).toHaveAttribute('src', visibleA);

    await title.evaluate((element) => {
      element.value = 'Local uncommitted title';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const csrf = await dialog.locator('#book-form [name="_csrf"]').inputValue();
    const external = await page.request.post(`${base}/notes/books/${book.id}`, {
      headers: { Accept: 'application/json' },
      multipart: {
        _csrf: csrf,
        title: 'Canonical title',
        expectedCoverKind: sourceA.kind,
        expectedCoverId: sourceA.id,
        coverReplacementConfirmed: 'true',
        cover: coverB,
      },
    });
    expect(external.status()).toBe(200);
    const sourceB = app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id);
    expect(sourceB.id).not.toBe(sourceA.id);
    const visibleB = `/managed-assets/${sourceB.id}/preview`;
    await expect(page.locator('[data-book-detail-live-region] .notes-book-cover-image')).toHaveAttribute('src', visibleA);
    await expect(dialog.locator('[data-book-current-cover-presentation] .notes-book-cover-image')).toHaveAttribute('src', visibleA);

    const stalePost = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/notes/books/${book.id}`
      && response.status() === 409);
    const reconciliationGet = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/notes/books/${book.id}`);
    await cover.setInputFiles(rejectedC);
    await confirmation.getByRole('button', { name: 'Replace cover', exact: true }).click();
    await stalePost;
    expect((await reconciliationGet).status()).toBe(200);

    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)).toEqual(sourceB);
    await expect(title).toHaveValue('Local uncommitted title');
    await expect(cover).toHaveValue('');
    await expect(page.locator('[data-book-detail-live-region] .notes-book-cover-image')).toHaveAttribute('src', visibleB);
    await expect(dialog.locator('[data-book-current-cover-presentation] .notes-book-cover-image')).toHaveAttribute('src', visibleB);
    await expect(dialog.locator('[name="expectedCoverKind"]')).toHaveValue('managed_asset');
    await expect(dialog.locator('[name="expectedCoverId"]')).toHaveValue(sourceB.id);
    await expect(status).toContainText('selected replacement was not applied');
    await expect(status).toContainText('choose the file again');
    await expect(status).not.toContainText('changes were kept');

    await cover.setInputFiles(deliberateD);
    await confirmation.getByRole('button', { name: 'Replace cover', exact: true }).click();
    await expect.poll(() => app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id)?.id).not.toBe(sourceB.id);
    expect(coverExpectations.at(-1)).toEqual(sourceB);
    expect(app.locals.bookService.getBook(book.id).title).toBe('Canonical title');

    await title.evaluate((element) => element.dispatchEvent(new Event('change', { bubbles: true })));
    await expect.poll(() => app.locals.bookService.getBook(book.id).title).toBe('Local uncommitted title');
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
