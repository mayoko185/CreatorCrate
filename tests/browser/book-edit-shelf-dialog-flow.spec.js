import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// Edit Book from the Books shelf runs the Book Detail form and autosave in
// place: the shelf document is never navigated or replaced.

async function withBooksApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-edit-shelf-'));
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
    await run(`http://127.0.0.1:${server.address().port}`, app);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const png = async (color) => ({
  name: `${color}.png`,
  mimeType: 'image/png',
  buffer: await sharp({ create: { width: 20, height: 20, channels: 3, background: color } }).png().toBuffer(),
});

async function openShelf(page, base) {
  await page.goto(`${base}/notes`);
  await page.evaluate(() => { window.__shelfDocument = true; });
  const log = { navigations: [], posts: [], gets: [] };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) log.navigations.push(frame.url()); });
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'POST') log.posts.push(pathname);
    if (request.method() === 'GET' && request.resourceType() === 'fetch') log.gets.push(pathname);
  });
  return log;
}

const shelfKept = async (page, base, log) => {
  expect(await page.evaluate(() => window.__shelfDocument === true)).toBe(true);
  expect(log.navigations).toEqual([]);
  expect(page.url()).toBe(`${base}/notes`);
};
const editTrigger = (page, bookId) => page.locator(`[data-book-edit-open="${bookId}"]`);
const editDialog = (page) => page.locator('#book-edit-dialog');
const titleInput = (page) => editDialog(page).locator('[name="title"]');
const shelfTitles = (page) => page.locator('.notes-book-card-title a').allTextContents();
const saveState = (page, state) => expect(editDialog(page).locator('form[data-book-edit-autosave]'))
  .toHaveAttribute('data-book-edit-save-state', state);

test('edits a Book in place, keeps the shelf order and returns focus', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const first = app.locals.bookService.createBook({ title: 'First' });
    const second = app.locals.bookService.createBook({ title: 'Second' });
    const third = app.locals.bookService.createBook({ title: 'Third' });
    const log = await openShelf(page, base);
    const before = await shelfTitles(page);
    await page.evaluate(() => { window.scrollTo(0, 40); });

    await editTrigger(page, second.id).click();
    await expect(editDialog(page)).toBeVisible();
    await expect(titleInput(page)).toHaveValue('Second');
    await expect(editDialog(page).getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(editDialog(page).locator('button[data-confirm]', { hasText: 'Delete Book' })).toHaveCount(1);
    // Saved elsewhere after the shelf rendered: the dialog shows the server's value.
    await page.keyboard.press('Escape');
    await expect(editDialog(page)).toBeHidden();
    await expect(editTrigger(page, second.id)).toBeFocused();
    app.locals.bookService.updateBook(second.id, { title: 'Second elsewhere' });
    await editTrigger(page, second.id).click();
    await expect(titleInput(page)).toHaveValue('Second elsewhere');

    await titleInput(page).fill('Second renamed');
    await titleInput(page).press('Tab');
    await saveState(page, 'saved');
    await expect(editDialog(page).locator('[data-book-edit-save-status]')).toHaveText('Book saved.');
    expect(app.locals.bookService.getBook(second.id).title).toBe('Second renamed');
    expect(log.posts).toEqual([`/notes/books/${second.id}`]);
    expect(log.gets).toContain('/notes');
    await expect(page.locator('.notes-book-card-title a', { hasText: 'Second renamed' })).toHaveCount(1);
    expect(await shelfTitles(page)).toEqual(before.map((title) => (title === 'Second' ? 'Second renamed' : title)));
    await expect(page.locator('.notes-book-card')).toHaveCount(3);
    await expect(page.locator('#books-order-dialog', { hasText: 'Second renamed' })).toHaveCount(1);
    expect(await page.title()).not.toContain('Second renamed');

    // The opener was replaced by the refresh; focus goes to its replacement.
    await editDialog(page).getByRole('button', { name: 'Close Edit Book' }).click();
    await expect(editDialog(page)).toBeHidden();
    await expect(editTrigger(page, second.id)).toBeFocused();
    expect(log.posts).toHaveLength(1);

    await editTrigger(page, second.id).click();
    await expect(titleInput(page)).toHaveValue('Second renamed');
    const box = await editDialog(page).locator('.app-dialog-card').boundingBox();
    await page.mouse.click(Math.max(box.x - 20, 2), Math.max(box.y - 20, 2));
    await expect(editDialog(page)).toBeHidden();
    await shelfKept(page, base, log);
    expect(third.id).toBeGreaterThan(first.id);
  });
});

test('keeps a refused title in the dialog and uses non-conflicting field IDs', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const book = app.locals.bookService.createBook({ title: 'Kept' });
    const log = await openShelf(page, base);
    await editTrigger(page, book.id).click();
    await expect(titleInput(page)).toHaveValue('Kept');

    await titleInput(page).fill('   ');
    await titleInput(page).press('Tab');
    const error = editDialog(page).locator('#book-edit-title-error');
    await expect(error).toHaveText('Title is required.');
    await expect(titleInput(page)).toHaveAttribute('aria-describedby', 'book-edit-title-error');
    expect(app.locals.bookService.getBook(book.id).title).toBe('Kept');

    const duplicates = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    expect(duplicates).toEqual([]);
    await expect(editDialog(page).getByLabel('Title')).toHaveCount(1);
    await expect(page.locator('#book-create-dialog #title')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await editTrigger(page, book.id).click();
    await expect(titleInput(page)).toHaveValue('Kept');
    await expect(error).toHaveCount(0);
    await shelfKept(page, base, log);
  });
});

test('adds, confirms and rejects cover replacement without leaking between Books', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const covered = app.locals.bookService.createBook({ title: 'Covered' });
    const plain = app.locals.bookService.createBook({ title: 'Plain' });
    const log = await openShelf(page, base);
    const cover = editDialog(page).locator('[name="cover"]');

    await editTrigger(page, covered.id).click();
    await expect(titleInput(page)).toHaveValue('Covered');
    await editDialog(page).locator('summary', { hasText: 'Book cover' }).click();
    await cover.setInputFiles(await png('red'));
    await saveState(page, 'saved');
    await expect(editDialog(page).locator('[data-book-current-cover-presentation] img')).toHaveCount(1);
    await expect(editDialog(page).locator('input[name="expectedCoverKind"]')).toHaveValue('managed_asset');
    await expect(page.locator('.notes-book-card', { hasText: 'Covered' }).locator('img')).toHaveCount(1);
    const firstSource = app.locals.bookPrimaryImageService.getPrimaryImageSource(covered.id).id;

    // Declined replacement posts nothing.
    const postsBefore = log.posts.length;
    await cover.setInputFiles(await png('blue'));
    const confirmDialog = page.getByRole('dialog', { name: 'Replace cover image?' });
    await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(editDialog(page)).toBeVisible();
    expect(log.posts).toHaveLength(postsBefore);

    await cover.setInputFiles(await png('blue'));
    await confirmDialog.getByRole('button', { name: 'Replace cover' }).click();
    await expect.poll(() => app.locals.bookPrimaryImageService.getPrimaryImageSource(covered.id).id).not.toBe(firstSource);
    await saveState(page, 'saved');

    await cover.setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await confirmDialog.getByRole('button', { name: 'Replace cover' }).click();
    await expect(editDialog(page).locator('.error-summary')).toBeVisible();
    await saveState(page, 'error');
    await page.keyboard.press('Escape');

    // The next Book starts from its own cover, with no replacement prompt.
    await editTrigger(page, plain.id).click();
    await expect(titleInput(page)).toHaveValue('Plain');
    await expect(editDialog(page).locator('input[name="expectedCoverKind"]')).toHaveValue('none');
    await expect(editDialog(page).locator('[data-book-current-cover-presentation] img')).toHaveCount(0);
    await expect(editDialog(page).locator('.error-summary')).toHaveCount(0);
    await shelfKept(page, base, log);
  });
});

test('a delayed load never fills another Book or reopens a dismissed dialog', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const a = app.locals.bookService.createBook({ title: 'Book A' });
    const b = app.locals.bookService.createBook({ title: 'Book B' });
    const log = await openShelf(page, base);
    let releaseA;
    const holdA = new Promise((resolve) => { releaseA = resolve; });
    await page.route(`**/notes/books/${a.id}`, async (route) => {
      await holdA;
      await route.continue().catch(() => {});
    });

    await editTrigger(page, a.id).click();
    await expect(editDialog(page).locator('[data-book-edit-shelf-load]')).toHaveText('Loading Book…');
    await page.keyboard.press('Escape');
    await expect(editDialog(page)).toBeHidden();
    await expect(editTrigger(page, a.id)).toBeFocused();

    await editTrigger(page, a.id).click();
    await expect(editDialog(page)).toBeVisible();
    // The shelf is inert behind the modal, so this is the rapid-switch path only a script reaches.
    await editTrigger(page, b.id).evaluate((trigger) => trigger.click());
    await expect(titleInput(page)).toHaveValue('Book B');
    releaseA();
    await page.waitForTimeout(150);
    await expect(titleInput(page)).toHaveValue('Book B');
    await expect(editDialog(page).locator('form[data-book-edit-autosave]')).toHaveCount(1);

    await titleInput(page).fill('Book B renamed');
    await titleInput(page).press('Tab');
    await saveState(page, 'saved');
    expect(log.posts).toEqual([`/notes/books/${b.id}`]);
    expect(app.locals.bookService.getBook(a.id).title).toBe('Book A');
    await page.keyboard.press('Escape');
    await expect(editDialog(page)).toBeHidden();
    await page.waitForTimeout(100);
    await expect(editDialog(page)).toBeHidden();
    await expect(editTrigger(page, b.id)).toBeFocused();
  });
});

test('reopening waits for a write still in flight when the dialog closed', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const book = app.locals.bookService.createBook({ title: 'Before' });
    const log = await openShelf(page, base);
    let releasePost;
    const holdPost = new Promise((resolve) => { releasePost = resolve; });
    await page.route(`**/notes/books/${book.id}`, async (route) => {
      if (route.request().method() === 'POST') await holdPost;
      await route.continue();
    });
    await editTrigger(page, book.id).click();
    await expect(titleInput(page)).toHaveValue('Before');
    await titleInput(page).fill('After');
    await editDialog(page).getByRole('button', { name: 'Close Edit Book' }).click();
    await expect(editDialog(page)).toBeHidden();

    await editTrigger(page, book.id).click();
    await expect(editDialog(page).locator('[data-book-edit-shelf-load]')).toHaveText('Loading Book…');
    releasePost();
    await expect(titleInput(page)).toHaveValue('After');
    expect(log.posts).toEqual([`/notes/books/${book.id}`]);
  });
});

test('a saved edit whose shelf refresh fails reports truthfully and recovers with GET only', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const book = app.locals.bookService.createBook({ title: 'Saved' });
    const other = app.locals.bookService.createBook({ title: 'Other' });
    const log = await openShelf(page, base);
    let failShelf = true;
    await page.route('**/notes', async (route) => {
      if (failShelf && route.request().resourceType() === 'fetch') await route.abort('failed');
      else await route.continue();
    });

    await editTrigger(page, book.id).click();
    await expect(titleInput(page)).toHaveValue('Saved');
    await titleInput(page).fill('Saved twice');
    await titleInput(page).press('Tab');
    await saveState(page, 'saved-refresh-error');
    await expect(editDialog(page).locator('[data-book-edit-save-status]'))
      .toContainText('The Book was saved, but the Books shelf could not refresh.');
    expect(app.locals.bookService.getBook(book.id).title).toBe('Saved twice');
    await expect(page.locator('.notes-book-card-title a', { hasText: 'Saved twice' })).toHaveCount(0);

    // Retried inside the dialog, then dismissed with the shelf still stale.
    await editDialog(page).locator('[data-book-edit-refresh-retry]').click();
    await saveState(page, 'saved-refresh-error');
    await editDialog(page).getByRole('button', { name: 'Close Edit Book' }).click();
    await expect(editDialog(page)).toBeHidden();
    const note = page.locator('[data-book-edit-refresh-note]');
    await expect(note).toContainText('The Book was saved, but Books could not refresh.');
    await expect(editTrigger(page, book.id)).toBeFocused();

    failShelf = false;
    await note.locator('[data-book-edit-refresh-note-retry]').click();
    await expect(page.locator('.notes-book-card-title a', { hasText: 'Saved twice' })).toHaveCount(1);
    await expect(note).toHaveCount(0);
    await expect(page.locator('[data-dialog-feedback]')).toBeHidden();
    await expect(editTrigger(page, book.id)).toBeFocused();
    expect(log.posts).toEqual([`/notes/books/${book.id}`]);
    await expect(editTrigger(page, other.id)).toHaveCount(1);
    await shelfKept(page, base, log);
  });
});

test('an uncertain write is reconciled from the server and never repeated', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const book = app.locals.bookService.createBook({ title: 'Uncertain' });
    const log = await openShelf(page, base);
    let loseResponse = true;
    let failReads = false;
    await page.route(`**/notes/books/${book.id}`, async (route) => {
      const { method } = { method: route.request().method() };
      if (method === 'POST' && loseResponse) {
        loseResponse = false;
        await route.fetch();
        await route.abort('failed');
      } else if (method === 'GET' && failReads) await route.abort('failed');
      else await route.continue();
    });

    await editTrigger(page, book.id).click();
    await expect(titleInput(page)).toHaveValue('Uncertain');
    failReads = true;
    await titleInput(page).fill('Committed');
    await titleInput(page).press('Tab');
    await saveState(page, 'reconciliation-error');
    await expect(titleInput(page)).toBeDisabled();
    failReads = false;
    await editDialog(page).locator('[data-book-edit-reconciliation-retry]').click();
    await saveState(page, 'reconciled');
    await expect(titleInput(page)).toHaveValue('Committed');
    await expect(titleInput(page)).toBeEnabled();
    await expect(page.locator('.notes-book-card-title a', { hasText: 'Committed' })).toHaveCount(1);
    expect(log.posts).toEqual([`/notes/books/${book.id}`]);
    await shelfKept(page, base, log);
  });
});

test('reports load failures in the dialog and drops a Book deleted elsewhere', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const book = app.locals.bookService.createBook({ title: 'Fragile' });
    const gone = app.locals.bookService.createBook({ title: 'Gone' });
    const log = await openShelf(page, base);
    let failRead = true;
    await page.route(`**/notes/books/${book.id}`, async (route) => {
      if (failRead) await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Not the Book</p>' });
      else await route.continue();
    });

    await editTrigger(page, book.id).click();
    const load = editDialog(page).locator('[data-book-edit-shelf-load]');
    await expect(load).toContainText('Could not load this Book.');
    failRead = false;
    await load.getByRole('button', { name: 'Try again' }).click();
    await expect(titleInput(page)).toHaveValue('Fragile');
    await page.keyboard.press('Escape');

    app.locals.bookService.deleteBook(gone.id);
    await editTrigger(page, gone.id).click();
    await expect(load).toContainText('This Book is no longer available.');
    await expect(editTrigger(page, gone.id)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(editDialog(page)).toBeHidden();
    await expect(page.locator('.page-heading [data-dialog-open="book-create-dialog"]')).toBeFocused();
    expect(log.posts).toEqual([]);
    await shelfKept(page, base, log);
  });
});

test('New Book and Edit Book coexist, and a created Book can be edited in place', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const existing = app.locals.bookService.createBook({ title: 'Existing' });
    const log = await openShelf(page, base);
    await editTrigger(page, existing.id).click();
    await expect(titleInput(page)).toHaveValue('Existing');
    await page.keyboard.press('Escape');

    const createDialog = page.locator('#book-create-dialog');
    await page.locator('.page-heading [data-dialog-open="book-create-dialog"]').click();
    await expect(createDialog.locator('#title')).toHaveValue('');
    await page.getByLabel('Title').first().fill('');
    await createDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(createDialog.locator('[aria-invalid="true"]')).toHaveCount(1);
    await createDialog.locator('#title').fill('Created');
    await createDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(createDialog).toBeHidden();
    const created = page.locator('.notes-book-card', { hasText: 'Created' });
    await expect(created).toHaveCount(1);

    await created.locator('[data-book-edit-open]').click();
    await expect(titleInput(page)).toHaveValue('Created');
    await titleInput(page).fill('Created renamed');
    await titleInput(page).press('Tab');
    await saveState(page, 'saved');
    await editDialog(page).getByRole('button', { name: 'Close Edit Book' }).click();
    await expect(page.locator('.notes-book-card-title a', { hasText: 'Created renamed' })).toHaveCount(1);
    await page.locator('.page-heading [data-dialog-open="book-create-dialog"]').click();
    await expect(createDialog.locator('#title')).toHaveValue('');
    await shelfKept(page, base, log);
  });
});

test('Book Detail keeps its own Edit Book and direct edit links open there', async ({ page }) => {
  await withBooksApp(async (base, app) => {
    const book = app.locals.bookService.createBook({ title: 'Detail' });
    await page.goto(`${base}/notes/books/${book.id}/edit`);
    const dialog = editDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#title')).toHaveValue('Detail');
    await dialog.locator('#title').fill('Detail renamed');
    await dialog.locator('#title').press('Tab');
    await expect(dialog.locator('form[data-book-edit-autosave]')).toHaveAttribute('data-book-edit-save-state', 'saved');
    await expect(page.locator('.app-section-title')).toContainText('Detail renamed');
    expect(new URL(page.url()).pathname).toBe(`/notes/books/${book.id}/edit`);
  });
});
