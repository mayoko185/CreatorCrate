import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// New Book creates in place from the Books shelf: the shelf is never navigated
// or replaced as a document, and its content refreshes locally.

async function withBooksApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-create-flow-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run(`http://127.0.0.1:${server.address().port}`, app, db, root);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const countBooks = (db) => db.prepare('SELECT COUNT(*) AS count FROM books').get().count;
const markDocument = (page) => page.evaluate(() => { window.__bookCreateFlowDocument = true; });
const documentKept = (page) => page.evaluate(() => window.__bookCreateFlowDocument === true);
const isCreatePost = (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books';

function track(page) {
  const log = { navigations: [], posts: [], shelfGets: [] };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) log.navigations.push(frame.url()); });
  page.on('request', (request) => {
    if (isCreatePost(request)) log.posts.push(request);
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/notes') log.shelfGets.push(request);
  });
  return log;
}

const toolbarTrigger = (page) => page.locator('.page-heading [data-dialog-open="book-create-dialog"]');
const createButton = (dialog) => dialog.getByRole('button', { name: 'Create', exact: true });
const shelfTitles = (page) => page.locator('.notes-book-card-title a').allTextContents();

async function expectFreshDialog(dialog) {
  await expect(dialog.locator('#title')).toHaveValue('');
  expect(await dialog.locator('#book-cover').evaluate((input) => input.files.length)).toBe(0);
  await expect(dialog.locator('[aria-invalid="true"]')).toHaveCount(0);
  await expect(dialog.locator('[data-dialog-error]')).toBeHidden();
  await expect(dialog.locator('details')).not.toHaveAttribute('open');
}

test('creates in place from the toolbar, updates every Book list and links to the record', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await withBooksApp(async (origin, app, db) => {
    for (let index = 0; index < 8; index += 1) app.locals.bookService.createBook({ title: `Existing ${index}` });
    await page.setViewportSize({ width: 1000, height: 400 });
    await page.goto(`${origin}/notes`);
    const log = track(page);
    await markDocument(page);
    await page.evaluate(() => window.scrollTo(0, 150));
    const scroll = await page.evaluate(() => window.scrollY);
    const before = await shelfTitles(page);

    await toolbarTrigger(page).click();
    const dialog = page.locator('#book-create-dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
    await dialog.locator('#title').fill('Second Book');
    await createButton(dialog).click();

    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Book “Second Book” created.');
    await expect(dialog).toBeHidden();
    await expect.poll(() => shelfTitles(page)).toEqual([...before, 'Second Book']);
    const book = db.prepare("SELECT id FROM books WHERE title = 'Second Book'").get();
    expect(log.posts).toHaveLength(1);
    expect(log.posts[0].headers()['content-type']).toMatch(/^multipart\/form-data/);
    await expect(feedback.locator('[data-book-create-view]')).toHaveAttribute('href', `/notes/books/${book.id}`);
    await expect(toolbarTrigger(page)).toBeFocused();
    // Scroll anchoring may settle by a couple of pixels; the view does not jump.
    expect(Math.abs(await page.evaluate(() => window.scrollY) - scroll)).toBeLessThanOrEqual(4);
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);

    // Lists beside the shelf follow without any navigation.
    await expect(page.locator(`#books-order-dialog [data-book-id="${book.id}"]`)).toHaveCount(1);
    await expect(page.locator(`#book-transfer-dialog [data-book-export-choice][value="${book.id}"]`)).toHaveCount(1);

    await toolbarTrigger(page).click();
    await expectFreshDialog(dialog);
    await page.keyboard.press('Escape');

    await feedback.locator('[data-book-create-view]').click();
    await expect(page).toHaveURL(`${origin}/notes/books/${book.id}`);
    expect(pageErrors).toEqual([]);
  });
});

test('empty state opens locally and the first Books bring the order control with them', async ({ page }) => {
  await withBooksApp(async (origin, app) => {
    await page.goto(`${origin}/notes`);
    const log = track(page);
    await markDocument(page);
    const dialog = page.locator('#book-create-dialog');
    const empty = page.locator('[data-notes-books-live-region] [data-dialog-open="book-create-dialog"]');
    await empty.click();
    await expect(dialog).toBeVisible();
    await dialog.locator('#title').fill('Only Book');
    await createButton(dialog).click();
    await expect.poll(() => shelfTitles(page)).toEqual(['Only Book']);
    await expect(page.locator('[data-notes-books-live-region] .empty-state')).toHaveCount(0);
    // The empty-state trigger left with the old region.
    await expect(toolbarTrigger(page)).toBeFocused();
    const order = page.locator('.page-heading [data-dialog-open="books-order-dialog"]');
    await expect(order).toHaveCount(0);

    await toolbarTrigger(page).click();
    await dialog.locator('#title').fill('Other Book');
    await page.keyboard.press('Enter');
    await expect.poll(() => shelfTitles(page)).toEqual(['Only Book', 'Other Book']);
    await expect(order).toHaveCount(1);
    await order.click();
    const orderDialog = page.locator('#books-order-dialog');
    await expect(orderDialog).toBeVisible();
    await expect(orderDialog.locator('[data-book-reorder-handle]')).toHaveCount(2);
    await orderDialog.locator('[data-book-reorder-handle]').first().focus();
    const reorder = page.waitForResponse((response) => response.url().endsWith('/notes/books/reorder'));
    await page.keyboard.press('ArrowDown');
    expect((await reorder).ok()).toBe(true);
    await expect.poll(() => app.locals.bookService.listBooks().map((book) => book.title))
      .toEqual(['Other Book', 'Only Book']);
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('validation stays in the dialog and keeps the title and cover selection', async ({ page }) => {
  await withBooksApp(async (origin, _app, db) => {
    await page.goto(`${origin}/notes`);
    const log = track(page);
    await markDocument(page);
    const png = await sharp({ create: { width: 20, height: 30, channels: 3, background: 'red' } }).png().toBuffer();
    const dialog = page.locator('#book-create-dialog');
    await toolbarTrigger(page).click();
    await dialog.locator('summary').click();
    await dialog.locator('#book-cover').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
    await createButton(dialog).click();

    await expect(dialog.locator('#title-error')).toHaveText('Title is required.');
    await expect(dialog.locator('#title')).toBeFocused();
    expect(await dialog.locator('#book-cover').evaluate((input) => input.files[0]?.name)).toBe('cover.png');
    expect(countBooks(db)).toBe(0);

    await dialog.locator('#title').fill('Kept title');
    await dialog.locator('#book-cover').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await dialog.locator('summary').click();
    await expect(dialog.locator('details')).not.toHaveAttribute('open');
    await createButton(dialog).click();
    await expect(dialog.locator('#book-cover-error')).toContainText('A valid PNG, JPEG or WebP image');
    await expect(dialog.locator('details')).toHaveAttribute('open');
    await expect(dialog.locator('#book-cover')).toBeFocused();
    await expect(dialog.locator('#title')).toHaveValue('Kept title');
    await expect(dialog.locator('#title-error')).toHaveCount(0);
    expect(countBooks(db)).toBe(0);

    await dialog.locator('#book-cover').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
    await createButton(dialog).click();
    await expect(dialog.locator('[data-dialog-error-text]')).toContainText('exceeds 10 MiB');
    await expect(dialog.locator('#title')).toHaveValue('Kept title');
    expect(countBooks(db)).toBe(0);

    await dialog.locator('#book-cover').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
    await createButton(dialog).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => shelfTitles(page)).toEqual(['Kept title']);
    await expect(page.locator('.notes-book-card img')).toHaveCount(1);
    await expect.poll(() => page.locator('.notes-book-card img').evaluate((image) => image.naturalWidth)).toBe(20);
    expect(countBooks(db)).toBe(1);
    expect(log.posts.length).toBeGreaterThanOrEqual(4);
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('every dismissal stays on the shelf, clears the draft and restores focus', async ({ page }) => {
  await withBooksApp(async (origin, app) => {
    app.locals.bookService.createBook({ title: 'Existing' });
    await page.goto(`${origin}/notes`);
    const log = track(page);
    await markDocument(page);
    const dialog = page.locator('#book-create-dialog');
    const dismissals = {
      close: () => dialog.getByRole('button', { name: 'Close New Book', exact: true }).click(),
      escape: () => page.keyboard.press('Escape'),
      backdrop: () => page.mouse.click(5, 5),
    };
    for (const dismiss of Object.values(dismissals)) {
      await toolbarTrigger(page).click();
      await dialog.locator('summary').click();
      await dialog.locator('#book-cover').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('x') });
      await createButton(dialog).click();
      await expect(dialog.locator('#title-error')).toBeVisible();
      await dialog.locator('#title').fill('Draft');
      await dismiss();
      await expect(dialog).toBeHidden();
      await expect(toolbarTrigger(page)).toBeFocused();
      await toolbarTrigger(page).click();
      await expectFreshDialog(dialog);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('a multipart create held pending freezes the title and cover, through refusal and success', async ({ page }) => {
  await withBooksApp(async (origin, _app, db) => {
    await page.goto(`${origin}/notes`);
    const log = track(page);
    await markDocument(page);
    const png = await sharp({ create: { width: 20, height: 30, channels: 3, background: 'red' } }).png().toBuffer();
    let release;
    let gate;
    const hold = () => { gate = new Promise((resolve) => { release = resolve; }); };
    await page.route('**/notes/books', async (route) => {
      if (route.request().method() === 'POST') await gate;
      return route.continue();
    });
    let choosers = 0;
    page.on('filechooser', () => { choosers += 1; });

    const dialog = page.locator('#book-create-dialog');
    const title = dialog.locator('#title');
    const cover = dialog.locator('#book-cover');
    const clickCenter = async (locator) => {
      const box = await locator.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    const attemptEdits = async () => {
      await clickCenter(title);
      await page.keyboard.type('LATE');
      await clickCenter(cover);
      await clickCenter(dialog.locator('summary'));
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('details')).toHaveAttribute('open');
      await expect(title).toHaveValue('Frozen Book');
    };

    await toolbarTrigger(page).click();
    await title.fill('Frozen Book');
    await dialog.locator('summary').click();
    await cover.setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    hold();
    await createButton(dialog).click();
    await expect(dialog).toHaveAttribute('data-dialog-state', 'pending');
    await attemptEdits();
    expect(await cover.evaluate((input) => input.files[0]?.name)).toBe('bad.png');
    release();

    await expect(dialog.locator('#book-cover-error')).toContainText('A valid PNG, JPEG or WebP image');
    await expect(dialog.locator('[inert]')).toHaveCount(0);
    await expect(cover).toBeFocused();
    await expect(title).toHaveValue('Frozen Book');
    expect(await cover.evaluate((input) => input.files[0]?.name)).toBe('bad.png');
    await expect(createButton(dialog)).toBeEnabled();
    expect(countBooks(db)).toBe(0);

    await cover.setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
    hold();
    await createButton(dialog).click();
    await expect(dialog).toHaveAttribute('data-dialog-state', 'pending');
    await attemptEdits();
    expect(await cover.evaluate((input) => input.files[0]?.name)).toBe('cover.png');
    release();

    await expect(dialog).toBeHidden();
    await expect.poll(() => shelfTitles(page)).toEqual(['Frozen Book']);
    await expect.poll(() => page.locator('.notes-book-card img').evaluate((image) => image.naturalWidth)).toBe(20);
    expect(choosers).toBe(0);
    expect(log.posts).toHaveLength(2);
    expect(log.posts[0].headers()['content-type']).toMatch(/^multipart\/form-data/);
    expect(countBooks(db)).toBe(1);
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);

    await toolbarTrigger(page).click();
    await expectFreshDialog(dialog);
    await title.fill('Editable again');
    await expect(title).toHaveValue('Editable again');
  });
});

test('a create in flight cannot be dismissed or submitted twice', async ({ page }) => {
  await withBooksApp(async (origin, _app, db) => {
    await page.goto(`${origin}/notes`);
    const log = track(page);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route('**/notes/books', async (route) => { await gate; await route.continue(); });
    const dialog = page.locator('#book-create-dialog');
    await toolbarTrigger(page).click();
    await dialog.locator('#title').fill('Once');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveAttribute('data-dialog-state', 'pending');
    await expect(createButton(dialog)).toBeDisabled();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Close New Book', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#title')).toHaveValue('Once');
    release();
    await expect(dialog).toBeHidden();
    await expect.poll(() => shelfTitles(page)).toEqual(['Once']);
    expect(log.posts).toHaveLength(1);
    expect(countBooks(db)).toBe(1);
  });
});

test('a failed shelf refresh keeps the confirmation and only retries with a GET', async ({ page }) => {
  await withBooksApp(async (origin, _app, db) => {
    await page.goto(`${origin}/notes`);
    const log = track(page);
    await markDocument(page);
    let failRefresh = true;
    await page.route('**/notes', async (route) => {
      if (failRefresh && route.request().method() === 'GET') await route.fulfill({ status: 500, body: 'no' });
      else await route.continue();
    });
    const dialog = page.locator('#book-create-dialog');
    await toolbarTrigger(page).click();
    await dialog.locator('#title').fill('Refresh Book');
    await createButton(dialog).click();

    const feedback = page.locator('[data-dialog-feedback]');
    const retry = feedback.locator('[data-book-create-refresh-retry]');
    await expect(retry).toBeVisible();
    await expect(feedback).toContainText('Book “Refresh Book” created.');
    await expect(feedback).toContainText('Books could not refresh.');
    const book = db.prepare('SELECT id FROM books').get();
    await expect(feedback.locator('[data-book-create-view]')).toHaveAttribute('href', `/notes/books/${book.id}`);
    expect(await shelfTitles(page)).toEqual([]);

    await retry.click();
    await expect(retry).toBeVisible();
    await expect(feedback.locator('[data-book-create-view]')).toHaveCount(1);

    failRefresh = false;
    await retry.click();
    await expect.poll(() => shelfTitles(page)).toEqual(['Refresh Book']);
    await expect(retry).toHaveCount(0);
    await expect(feedback).not.toContainText('could not refresh');
    expect(log.posts).toHaveLength(1);
    expect(log.shelfGets).toHaveLength(3);
    expect(countBooks(db)).toBe(1);
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

for (const [label, respond] of [
  ['lost response', (route) => route.abort('connectionreset')],
  ['unexpected HTML', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Sign in</html>' })],
  ['committed then unhandled 500', async (route) => {
    await route.fetch();
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"status":"error","message":"Internal server error."}' });
  }],
]) {
  test(`${label} reports an unconfirmed create and never retries`, async ({ page }) => {
    await withBooksApp(async (origin) => {
      await page.goto(`${origin}/notes`);
      const log = track(page);
      await markDocument(page);
      await page.route('**/notes/books', respond);
      const dialog = page.locator('#book-create-dialog');
      await toolbarTrigger(page).click();
      await dialog.locator('#title').fill('Unknown');
      await createButton(dialog).click();
      await expect(dialog.locator('[data-dialog-error-text]')).toContainText('Could not confirm whether the Book was created');
      await expect(dialog.locator('[data-dialog-error-text]')).not.toContainText('could not be created');
      await expect(dialog.locator('#title')).toHaveValue('Unknown');
      await expect(page.locator('[data-dialog-feedback]')).toBeHidden();
      await expect(createButton(dialog)).toBeEnabled();
      expect(log.posts).toHaveLength(1);
      expect(log.navigations).toEqual([]);
      expect(await documentKept(page)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
}

test('a directly visited New Book keeps its native submission and redirect', async ({ page }) => {
  await withBooksApp(async (origin) => {
    await page.goto(`${origin}/notes/books/new`);
    const dialog = page.locator('#book-create-dialog[open]');
    await dialog.locator('#title').fill('Standalone');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/notes\/books\/\d+$/);
  });
});
