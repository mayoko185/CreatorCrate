import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// Delete Book and Delete Chapter run in place: one POST after confirmation, a
// refusal keeps the page and its drafts, and recovery only ever reads.

async function withNotes(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-record-delete-'));
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
    await new Promise((resolve) => server.once('listening', resolve));

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const posts = [];
    const gets = [];
    const navigations = [];
    let watching = false;
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST') posts.push(pathname);
      if (request.method() === 'GET' && request.resourceType() === 'fetch') gets.push(pathname);
    });
    page.on('framenavigated', (frame) => {
      if (watching && frame === page.mainFrame()) navigations.push(frame.url());
    });
    await run({
      services: app.locals,
      posts,
      gets,
      visit: async (pathname) => {
        watching = false;
        await page.goto(`http://127.0.0.1:${server.address().port}${pathname}`);
        navigations.length = 0;
        watching = true;
        await page.evaluate(() => { window.__hostDocument = true; });
      },
      kept: async (pathname) => {
        expect(navigations).toEqual([]);
        expect(await page.evaluate(() => window.__hostDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(pathname);
      },
    });
    expect(errors).toEqual([]);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const confirmation = (page) => page.locator('#app-confirmation-dialog');
const confirmDelete = (page) => confirmation(page).locator('[data-app-dialog-confirmation-confirm]').click();
const deleteError = (dialog) => dialog.locator('[data-dialog-delete-error]');
const bookGone = (services, id) => { try { services.bookService.getBook(id); return false; } catch { return true; } };
const chapterGone = (services, id) => { try { services.chapterService.getChapter(id); return false; } catch { return true; } };

async function openShelfBook(page, bookId) {
  await page.locator(`[data-book-edit-open="${bookId}"]`).click();
  const dialog = page.locator('#book-edit-dialog');
  await expect(dialog.locator('[name="title"]')).toBeVisible();
  await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
  return { dialog, remove: dialog.getByRole('button', { name: 'Delete Book', exact: true }) };
}

async function openChapter(page, t, chapterId) {
  const hostPath = `/notes/chapters/${chapterId}`;
  await t.visit(hostPath);
  const dialog = page.locator('#chapter-edit-dialog');
  await page.locator('.page-heading [data-dialog-open="chapter-edit-dialog"]').click();
  await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
  return {
    hostPath,
    dialog,
    title: dialog.locator('[name="title"]'),
    remove: dialog.getByRole('button', { name: 'Delete Chapter', exact: true }),
  };
}

test('shelf: a confirmed Delete Book stays on the document and syncs the shelf', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService } = t.services;
    const first = bookService.createBook({ title: 'First' });
    const second = bookService.createBook({ title: 'Second' });
    const third = bookService.createBook({ title: 'Third' });
    await t.visit('/notes');
    const { dialog, remove } = await openShelfBook(page, second.id);

    await remove.click();
    await expect(confirmation(page)).toBeVisible();
    await confirmation(page).locator('[data-app-dialog-confirmation-cancel]').click();
    await expect(confirmation(page)).toBeHidden();
    expect(t.posts).toEqual([]);
    await expect(dialog).toBeVisible();

    await remove.click();
    await confirmDelete(page);
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Book “Second” deleted.');
    await expect(page.locator('.notes-book-card')).toHaveCount(2);
    await expect(page.locator('#books-order-dialog [data-book-id]')).toHaveCount(2);
    await expect(page.locator('[data-book-export-choice]')).toHaveCount(2);
    expect(await page.locator('.notes-book-card-title a').allTextContents()).toEqual(['First', 'Third']);
    expect(t.posts).toEqual([`/notes/books/${second.id}/delete`]);
    expect(bookService.listBooks().map((book) => book.id)).toEqual([first.id, third.id]);
    await t.kept('/notes');
    await expect(page.locator(`[data-book-edit-open="${third.id}"]`)).toBeFocused();

    // Later Book actions still work.
    const next = await openShelfBook(page, first.id);
    await expect(next.dialog.locator('[name="title"]')).toHaveValue('First');
    await page.keyboard.press('Escape');
    await expect(next.dialog).toBeHidden();
    await page.locator('.page-heading [data-dialog-open="book-create-dialog"]').click();
    await expect(page.locator('#book-create-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await t.kept('/notes');
  });
});

test('shelf: deleting down to one and then no Books renders the empty shelf', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService } = t.services;
    const first = bookService.createBook({ title: 'First' });
    const last = bookService.createBook({ title: 'Last' });
    await t.visit('/notes');
    const order = page.locator('.page-heading [data-dialog-open="books-order-dialog"]');
    await expect(order).toHaveCount(1);

    let open = await openShelfBook(page, first.id);
    await open.remove.click();
    await confirmDelete(page);
    await expect(open.dialog).toBeHidden();
    await expect(page.locator('.notes-book-card')).toHaveCount(1);
    await expect(order).toHaveCount(0);
    await expect(page.locator(`[data-book-edit-open="${last.id}"]`)).toBeFocused();

    open = await openShelfBook(page, last.id);
    await open.remove.click();
    await confirmDelete(page);
    await expect(open.dialog).toBeHidden();
    const empty = page.locator('[data-notes-books-live-region]');
    await expect(empty).toContainText('No books yet');
    await expect(page.locator('.notes-book-card')).toHaveCount(0);
    await expect(page.locator('.page-heading [data-dialog-open="book-create-dialog"]')).toBeFocused();

    await empty.locator('[data-dialog-open="book-create-dialog"]').click();
    await expect(page.locator('#book-create-dialog')).toBeVisible();
    await t.kept('/notes');
  });
});

test('shelf: a refused Delete Book keeps the card and dialog', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService, chapterService } = t.services;
    const book = bookService.createBook({ title: 'Full' });
    chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
    await t.visit('/notes');
    const { dialog, remove } = await openShelfBook(page, book.id);
    await remove.click();
    await confirmDelete(page);
    await expect(deleteError(dialog)).toContainText('still contains Chapters');
    await expect(dialog).toBeVisible();
    await expect(remove).toBeFocused();
    await expect(page.locator('.notes-book-card')).toHaveCount(1);
    expect(t.posts).toEqual([`/notes/books/${book.id}/delete`]);
    await t.kept('/notes');
    await dialog.locator('[name="title"]').fill('Renamed');
    await dialog.locator('[name="title"]').press('Tab');
    await expect(dialog.locator('form[data-book-edit-autosave]')).toHaveAttribute('data-book-edit-save-state', 'saved');
    expect(bookService.getBook(book.id).title).toBe('Renamed');
  });
});

test('Book Detail: a refusal stays in place and a success returns to the shelf', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService, chapterService } = t.services;
    const book = bookService.createBook({ title: 'Detail Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
    const hostPath = `/notes/books/${book.id}`;
    await t.visit(hostPath);
    const dialog = page.locator('#book-edit-dialog');
    await page.locator('[data-book-detail-toolbar] [data-dialog-open="book-edit-dialog"]').click();
    await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
    const remove = dialog.getByRole('button', { name: 'Delete Book', exact: true });
    await remove.click();
    await confirmDelete(page);
    await expect(deleteError(dialog)).toContainText('still contains Chapters');
    await t.kept(hostPath);

    chapterService.deleteChapter(chapter.id);
    await remove.click();
    await confirmDelete(page);
    await expect(page).toHaveURL(/\/notes$/);
    expect(bookGone(t.services, book.id)).toBe(true);
    expect(t.posts).toEqual([`${hostPath}/delete`, `${hostPath}/delete`]);
  });
});

test('Chapter Detail: a refusal keeps the document, draft, Pages and focus', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService, chapterService, noteService } = t.services;
    const book = bookService.createBook({ title: 'Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Saved Title' });
    noteService.createNote({ chapterId: chapter.id, title: 'Kept Page', content: '' });
    const c = await openChapter(page, t, chapter.id);
    await c.title.fill('Unsaved Draft');
    await c.remove.click();
    await confirmDelete(page);

    await expect(deleteError(c.dialog)).toContainText('still contains Pages');
    await expect(c.dialog).toBeVisible();
    await expect(c.title).toHaveValue('Unsaved Draft');
    await expect(c.remove).toBeFocused();
    await expect(page.locator('.notes-chapter-pages')).toContainText('Kept Page');
    expect(t.posts).toEqual([`${c.hostPath}/delete`]);
    await t.kept(c.hostPath);
    expect(chapterService.getChapter(chapter.id).title).toBe('Saved Title');
    await expect(c.dialog.locator('form[id="chapter-form"]')).not.toHaveAttribute('aria-busy', 'true');
    await expect(c.title).toBeEditable();

    // The draft can still be saved, and dismissal clears the old refusal.
    await c.dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(c.dialog).toBeHidden();
    expect(chapterService.getChapter(chapter.id).title).toBe('Unsaved Draft');
    await expect(deleteError(c.dialog)).toHaveCount(0);
    await t.kept(c.hostPath);
  });
});

test('Chapter Detail: a directly visited edit URL keeps its native Delete', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService, chapterService, noteService } = t.services;
    const book = bookService.createBook({ title: 'Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Full' });
    noteService.createNote({ chapterId: chapter.id, title: 'Page', content: '' });
    await t.visit(`/notes/chapters/${chapter.id}/edit`);
    const dialog = page.locator('#chapter-edit-dialog');
    await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
    await dialog.getByRole('button', { name: 'Delete Chapter', exact: true }).click();
    const refusal = page.waitForResponse((response) => response.url().endsWith('/delete'));
    await confirmDelete(page);
    expect((await refusal).status()).toBe(409);
    await expect(page.locator('.error-status')).toHaveText('409');
  });
});

test('Chapter Detail: a success goes to the parent Book once it is confirmed', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService, chapterService } = t.services;
    const book = bookService.createBook({ title: 'Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Empty' });
    const c = await openChapter(page, t, chapter.id);
    await c.remove.click();
    await confirmation(page).locator('[data-app-dialog-confirmation-cancel]').click();
    expect(t.posts).toEqual([]);

    let release;
    const released = new Promise((resolve) => { release = resolve; });
    await page.route(`**${c.hostPath}/delete`, async (route) => { await released; await route.fallback(); });
    await c.remove.click();
    await confirmDelete(page);
    await expect.poll(() => t.posts).toEqual([`${c.hostPath}/delete`]);

    // Nothing moves, and nothing else can be sent, until the answer arrives.
    await t.kept(c.hostPath);
    await page.keyboard.press('Escape');
    await expect(c.dialog).toBeVisible();
    await page.locator('#chapter-delete-form').evaluate((form) => form.requestSubmit());
    await page.locator('#chapter-form').evaluate((form) => form.requestSubmit());
    expect(t.posts).toEqual([`${c.hostPath}/delete`]);

    release();
    await expect(page).toHaveURL(new RegExp(`/notes/books/${book.id}$`));
    expect(chapterGone(t.services, chapter.id)).toBe(true);
    expect(t.posts).toEqual([`${c.hostPath}/delete`]);
  });
});

test('recovery: a shelf refresh failure after deletion only reads, and leaves nothing to act on', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService } = t.services;
    const gone = bookService.createBook({ title: 'Gone' });
    const a = bookService.createBook({ title: 'A' });
    const b = bookService.createBook({ title: 'B' });
    await t.visit('/notes');
    const { dialog, remove } = await openShelfBook(page, gone.id);
    await page.evaluate(() => {
      document.querySelector('#book-create-dialog [name="title"]').value = 'Kept New Book draft';
    });
    let failReads = true;
    await page.route((url) => url.pathname === '/notes', async (route) => {
      if (failReads && route.request().resourceType() === 'fetch') await route.abort('failed');
      else await route.fallback();
    });
    await remove.click();
    await confirmDelete(page);
    await expect(dialog).toBeHidden();

    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Book “Gone” deleted.');
    await expect(feedback).toContainText('Books could not refresh.');
    await expect(page.locator(`[data-book-edit-open="${gone.id}"]`)).toHaveCount(0);
    await expect(page.locator('.page-heading [data-dialog-open="books-order-dialog"]')).toHaveCount(0);
    await expect(page.locator(`[data-book-export-choice][value="${gone.id}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-book-edit-open="${a.id}"]`)).toBeFocused();
    expect(t.posts).toEqual([`/notes/books/${gone.id}/delete`]);

    failReads = false;
    await page.locator('[data-book-edit-refresh-note-retry]').click();
    await expect(feedback).not.toContainText('could not refresh');
    await expect(page.locator('.page-heading [data-dialog-open="books-order-dialog"]')).toHaveCount(1);
    await expect(page.locator('#books-order-dialog [data-book-id]')).toHaveCount(2);
    await expect(page.locator(`[data-book-edit-open="${b.id}"]`)).toHaveCount(1);
    expect(t.posts).toEqual([`/notes/books/${gone.id}/delete`]);
    await expect(page.locator('#book-create-dialog [name="title"]')).toHaveValue('Kept New Book draft');
    await t.kept('/notes');
  });
});

test('recovery: a lost Delete Chapter answer is settled by reading, never by resending', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService, chapterService } = t.services;
    const book = bookService.createBook({ title: 'Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Saved' });
    const c = await openChapter(page, t, chapter.id);
    await c.title.fill('Draft');
    let failReads = true;
    await page.route((url) => url.pathname === `${c.hostPath}/delete`, (route) => route.abort('failed'));
    await page.route((url) => url.pathname === c.hostPath, async (route) => {
      if (failReads && route.request().resourceType() === 'fetch') await route.abort('failed');
      else await route.fallback();
    });
    await c.remove.click();
    await confirmDelete(page);

    const check = c.dialog.locator('[data-dialog-delete-check-retry]');
    await expect(deleteError(c.dialog)).toContainText('Could not confirm whether the Chapter was deleted');
    await expect(check).toBeFocused();
    await expect(c.title).toHaveValue('Draft');
    await t.kept(c.hostPath);
    // Unknown means locked: neither Delete nor Save can be sent.
    await page.locator('#chapter-delete-form').evaluate((form) => form.requestSubmit());
    expect(t.posts).toEqual([`${c.hostPath}/delete`]);

    failReads = false;
    await check.click();
    await expect(deleteError(c.dialog)).toContainText('still exists');
    await expect(c.remove).toBeFocused();
    await expect(c.title).toBeEditable();
    await expect(c.title).toHaveValue('Draft');
    expect(t.posts).toEqual([`${c.hostPath}/delete`]);
    await t.kept(c.hostPath);
  });
});

test('recovery: a lost answer whose delete committed goes to the parent Book', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService, chapterService } = t.services;
    const book = bookService.createBook({ title: 'Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Empty' });
    const c = await openChapter(page, t, chapter.id);
    await page.route((url) => url.pathname === `${c.hostPath}/delete`, async (route) => {
      await route.fetch();
      await route.abort('failed');
    });
    await c.remove.click();
    await confirmDelete(page);
    await expect(page).toHaveURL(new RegExp(`/notes/books/${book.id}$`));
    expect(chapterGone(t.services, chapter.id)).toBe(true);
    expect(t.posts).toEqual([`${c.hostPath}/delete`]);
    expect(t.gets).toContain(c.hostPath);
  });
});

test('recovery: an unreadable success is not believed, and a lost shelf answer is checked', async ({ page }) => {
  await withNotes(page, async (t) => {
    const { bookService } = t.services;
    const book = bookService.createBook({ title: 'Still Here' });
    const other = bookService.createBook({ title: 'Other' });
    await t.visit('/notes');
    const { dialog, remove } = await openShelfBook(page, book.id);
    await page.route((url) => url.pathname === `/notes/books/${book.id}/delete`, (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: '<p>Sign in</p>',
    }));
    await remove.click();
    await confirmDelete(page);
    await expect(deleteError(dialog)).toContainText('still exists');
    await expect(page.locator(`[data-book-edit-open="${book.id}"]`)).toHaveCount(1);
    await t.kept('/notes');
    expect(t.posts).toHaveLength(1);

    // Unknown at dismissal: the shelf takes over the report, and it stays usable.
    await page.unroute((url) => url.pathname === `/notes/books/${book.id}/delete`);
    await page.route((url) => url.pathname === `/notes/books/${book.id}/delete`, (route) => route.abort('failed'));
    let failReads = true;
    const reads = async (route) => {
      if (failReads && route.request().resourceType() === 'fetch') await route.abort('failed');
      else await route.fallback();
    };
    await page.route((url) => url.pathname === `/notes/books/${book.id}` || url.pathname === '/notes', reads);
    await remove.click();
    await confirmDelete(page);
    await expect(dialog.locator('[data-dialog-delete-check-retry]')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close Edit Book' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Could not confirm whether the Book was deleted');
    expect(t.posts).toHaveLength(2);
    failReads = false;
    await page.locator('[data-book-edit-refresh-note-retry]').click();
    await expect(page.locator('[data-dialog-feedback]')).toBeHidden();
    const next = await openShelfBook(page, other.id);
    await expect(next.dialog.locator('[name="title"]')).toHaveValue('Other');
    expect(t.posts).toHaveLength(2);
    await t.kept('/notes');
  });
});
