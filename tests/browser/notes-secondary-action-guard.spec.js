import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { createAssetManifest, VITE_ENTRY_KEY } from '../../src/asset-manifest.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// Move and Delete beside a Notes edit are refused while that edit is unresolved:
// no competing POST, no navigation, nothing queued, and usable again once it settles.
// The real editor exists only in the built client, so these tests run against it.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

async function withNotes(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-secondary-action-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot,
      authState: { csrfPepper },
      assetMode: 'production',
      assetManifest: createAssetManifest({ requiredEntries: [VITE_ENTRY_KEY] }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const posts = [];
    const navigations = [];
    let watching = false;
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
    });
    page.on('framenavigated', (frame) => {
      if (watching && frame === page.mainFrame()) navigations.push(frame.url());
    });
    await run({
      app,
      posts,
      origin: `http://127.0.0.1:${server.address().port}`,
      confirmation: page.locator('#app-confirmation-dialog'),
      visit: async (url) => {
        watching = false;
        await page.goto(url);
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

// Holds the next POST to a path until release() says how to answer it.
async function holdPost(page, pathname) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  let held = false;
  await page.route((url) => url.pathname === pathname, async (route) => {
    if (route.request().method() !== 'POST' || held) {
      await route.fallback();
      return;
    }
    held = true;
    reached();
    await (await released)(route);
  });
  return { arrived, release: (answer = (route) => route.fallback()) => release(answer) };
}

async function openEditPage(t, page) {
  const { app, origin } = t;
  const book = app.locals.bookService.createBook({ title: 'Host Book' });
  const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Host Chapter' });
  const note = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Original Title', content: 'Original body' });
  const hostPath = `/notes/${note.id}`;
  await t.visit(origin + hostPath);
  const dialog = page.locator('#note-edit-dialog');
  const trigger = page.locator('.page-heading [data-dialog-open="note-edit-dialog"]');
  const editor = dialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]');
  await trigger.click();
  await expect(editor).toBeVisible();
  await dialog.locator('.notes-workspace-disclosure--move > summary').click();
  await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
  return {
    book,
    note,
    hostPath,
    dialog,
    trigger,
    editor,
    title: dialog.locator('[name="title"]'),
    save: dialog.getByRole('button', { name: 'Save', exact: true }),
    move: dialog.locator('button[form="note-move-form"]'),
    remove: dialog.locator('button[form="note-delete-form"]'),
    status: dialog.locator('[data-dialog-status]'),
    saved: () => app.locals.noteService.getNote(note.id),
  };
}

test('Edit Page: Move Page cannot interrupt a pending save by pointer, keyboard or submit', async ({ page }) => {
  await withNotes(page, async (t) => {
    const p = await openEditPage(t, page);
    await p.title.fill('Edited Title');
    await p.editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' plus more');
    const held = await holdPost(page, p.hostPath);
    await p.save.click();
    await held.arrived;

    await p.move.click();
    await expect(p.status).toContainText('Wait for the save to finish');
    await p.move.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.locator('#note-move-form').evaluate((form) => form.requestSubmit());
    expect(t.posts).toEqual([p.hostPath]);
    await t.kept(p.hostPath);
    await expect(p.dialog).toBeVisible();
    await expect(p.dialog.locator('#note-form')).toHaveAttribute('aria-busy', 'true');
    await expect(p.title).toHaveValue('Edited Title');
    // F1's freeze is still in force, and dismissal still waits for the save.
    await expect(p.dialog.locator('#note-form > [inert]').first()).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(p.dialog).toBeVisible();

    held.release();
    await expect(p.dialog).toBeHidden();
    await expect(p.trigger).toBeFocused();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Edited Title');
    await t.kept(p.hostPath);
    expect(t.posts).toEqual([p.hostPath]);
    expect(p.saved()).toMatchObject({ title: 'Edited Title' });
    expect(p.saved().content).toContain('plus more');

    // Nothing was queued, and Move Page works again when asked.
    await p.trigger.click();
    await expect(p.editor).toBeVisible();
    await p.dialog.locator('#note-move-target').evaluate((select, value) => { select.value = value; }, `book:${p.book.id}`);
    await p.move.click();
    await expect.poll(() => p.saved().chapter_id).toBeNull();
    await t.kept(p.hostPath);
    expect(t.posts).toEqual([p.hostPath, `${p.hostPath}/move`]);
  });
});

test('Edit Page: Delete Page offers no confirmation during a save, and one already open cannot submit', async ({ page }) => {
  await withNotes(page, async (t) => {
    const p = await openEditPage(t, page);
    await p.title.fill('Kept Title');
    const held = await holdPost(page, p.hostPath);
    await p.save.click();
    await held.arrived;
    await p.remove.click();
    await expect(t.confirmation).toBeHidden();
    await p.remove.focus();
    await page.keyboard.press('Enter');
    await expect(t.confirmation).toBeHidden();
    await page.locator('#note-delete-form').evaluate((form) => form.requestSubmit());
    expect(t.posts).toEqual([p.hostPath]);
    await t.kept(p.hostPath);
    held.release();
    await expect(p.dialog).toBeHidden();
    expect(p.saved().title).toBe('Kept Title');

    // A save that begins behind an open confirmation still stops the confirmed Delete.
    await p.trigger.click();
    await expect(p.editor).toBeVisible();
    await p.title.fill('Second Title');
    const second = await holdPost(page, p.hostPath);
    await p.remove.click();
    await expect(t.confirmation).toBeVisible();
    await page.locator('#note-form').evaluate((form) => form.requestSubmit());
    await second.arrived;
    await t.confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    await expect(t.confirmation).toBeHidden();
    expect(t.posts).toEqual([p.hostPath, p.hostPath]);
    await t.kept(p.hostPath);
    second.release();
    await expect(p.dialog).toBeHidden();
    expect(p.saved().title).toBe('Second Title');
    expect(t.posts).toEqual([p.hostPath, p.hostPath]);
  });
});

test('Edit Chapter: Delete Chapter waits out a pending save, then works', async ({ page }) => {
  await withNotes(page, async (t) => {
    const book = t.app.locals.bookService.createBook({ title: 'Host Book' });
    const chapter = t.app.locals.chapterService.createChapter({ bookId: book.id, title: 'Before' });
    const hostPath = `/notes/chapters/${chapter.id}`;
    await t.visit(t.origin + hostPath);
    const dialog = page.locator('#chapter-edit-dialog');
    const remove = dialog.getByRole('button', { name: 'Delete Chapter', exact: true });
    await page.locator('.page-heading [data-dialog-open="chapter-edit-dialog"]').click();
    await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
    await dialog.locator('[name="title"]').fill('After');
    const held = await holdPost(page, hostPath);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await held.arrived;

    await remove.click();
    await remove.focus();
    await page.keyboard.press('Space');
    await page.locator('#chapter-delete-form').evaluate((form) => form.requestSubmit());
    await expect(t.confirmation).toBeHidden();
    expect(t.posts).toEqual([hostPath]);
    await t.kept(hostPath);

    held.release();
    await expect(dialog).toBeHidden();
    expect(t.app.locals.chapterService.getChapter(chapter.id).title).toBe('After');
    await t.kept(hostPath);

    await page.locator('.page-heading [data-dialog-open="chapter-edit-dialog"]').click();
    await remove.click();
    await t.confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    await expect(page).toHaveURL(new RegExp(`/notes/books/${book.id}$`));
    expect(t.posts).toEqual([hostPath, `${hostPath}/delete`]);
  });
});

const bookHosts = {
  'Book Detail': async (page, t, book) => {
    await t.visit(`${t.origin}/notes/books/${book.id}`);
    await page.locator('[data-book-detail-toolbar] [data-dialog-open="book-edit-dialog"]').click();
    return `/notes/books/${book.id}`;
  },
  'the Books shelf': async (page, t, book) => {
    await t.visit(`${t.origin}/notes`);
    await page.locator(`[data-book-edit-open="${book.id}"]`).click();
    return '/notes';
  },
};

for (const [name, openHost] of Object.entries(bookHosts)) {
  test(`Edit Book on ${name}: Delete Book cannot cancel an autosave`, async ({ page }) => {
    await withNotes(page, async (t) => {
      const book = t.app.locals.bookService.createBook({ title: 'Before' });
      const bookPath = `/notes/books/${book.id}`;
      const hostPath = await openHost(page, t, book);
      const dialog = page.locator('#book-edit-dialog');
      const title = dialog.locator('[name="title"]');
      const remove = dialog.getByRole('button', { name: 'Delete Book', exact: true });
      await expect(title).toHaveValue('Before');
      await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
      const held = await holdPost(page, bookPath);
      await title.fill('After');

      // Leaving the title for Delete Book is what starts the autosave.
      await remove.click();
      await held.arrived;
      await expect(t.confirmation).toBeHidden();
      await remove.focus();
      await page.keyboard.press('Enter');
      await expect(t.confirmation).toBeHidden();
      await dialog.locator('form[action$="/delete"]').evaluate((form) => form.requestSubmit());
      expect(t.posts).toEqual([bookPath]);
      await t.kept(hostPath);

      held.release();
      await expect(dialog.locator('form[data-book-edit-autosave]')).toHaveAttribute('data-book-edit-save-state', 'saved');
      await expect(dialog.locator('form[data-book-edit-autosave]')).not.toHaveAttribute('aria-busy', 'true');
      expect(t.app.locals.bookService.getBook(book.id).title).toBe('After');
      expect(t.posts).toEqual([bookPath]);
      await t.kept(hostPath);

      await remove.click();
      await t.confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
      await expect.poll(() => t.posts).toEqual([bookPath, `${bookPath}/delete`]);
      await expect.poll(() => { try { return t.app.locals.bookService.getBook(book.id); } catch { return null; } }).toBeNull();
    });
  });
}

test('recovery: a refused Page save releases the lock with its draft and errors kept', async ({ page }) => {
  await withNotes(page, async (t) => {
    const p = await openEditPage(t, page);
    await p.title.fill('');
    const held = await holdPost(page, p.hostPath);
    await p.save.click();
    await held.arrived;
    await p.remove.click();
    await expect(t.confirmation).toBeHidden();
    held.release();

    await expect(p.dialog.locator('#note-edit-title-error')).toHaveText('Title is required.');
    await expect(p.status).not.toContainText('Wait for the save');
    await expect(p.dialog).toBeVisible();
    await expect(p.title).toHaveValue('');
    expect(p.saved().title).toBe('Original Title');

    // Usable again: the confirmation opens, and declining it leaves the draft.
    await p.remove.click();
    await expect(t.confirmation).toBeVisible();
    await t.confirmation.locator('[data-app-dialog-confirmation-cancel]').click();
    await expect(t.confirmation).toBeHidden();
    await expect(p.title).toHaveValue('');
    expect(t.posts).toEqual([p.hostPath]);
    await t.kept(p.hostPath);
  });
});

test('recovery: a lost Page answer is not retried and releases the lock', async ({ page }) => {
  await withNotes(page, async (t) => {
    const p = await openEditPage(t, page);
    await p.title.fill('Unconfirmed Title');
    const held = await holdPost(page, p.hostPath);
    await p.save.click();
    await held.arrived;
    await p.move.click();
    expect(t.posts).toEqual([p.hostPath]);
    held.release((route) => route.abort('failed'));

    await expect(p.dialog.locator('[data-dialog-error-text]')).toContainText('Could not confirm');
    await expect(p.title).toHaveValue('Unconfirmed Title');
    await p.remove.click();
    await expect(t.confirmation).toBeVisible();
    await t.confirmation.locator('[data-app-dialog-confirmation-cancel]').click();
    expect(t.posts).toEqual([p.hostPath]);
    await t.kept(p.hostPath);
  });
});

test('recovery: a Book reconciliation holds the lock until its authority is restored', async ({ page }) => {
  await withNotes(page, async (t) => {
    const book = t.app.locals.bookService.createBook({ title: 'Before' });
    const bookPath = `/notes/books/${book.id}`;
    await t.visit(t.origin + bookPath);
    const dialog = page.locator('#book-edit-dialog');
    const form = dialog.locator('form[data-book-edit-autosave]');
    const remove = dialog.getByRole('button', { name: 'Delete Book', exact: true });
    let failReads = true;
    await page.route((url) => url.pathname === bookPath, async (route) => {
      const request = route.request();
      if (request.method() === 'POST') await route.abort('failed');
      else if (failReads && request.resourceType() === 'fetch') await route.abort('failed');
      else await route.fallback();
    });
    await page.locator('[data-book-detail-toolbar] [data-dialog-open="book-edit-dialog"]').click();
    await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
    await dialog.locator('[name="title"]').fill('Uncertain');
    await dialog.locator('[name="title"]').press('Tab');
    await expect(form).toHaveAttribute('data-book-edit-save-state', 'reconciliation-error');

    await remove.click();
    await expect(t.confirmation).toBeHidden();
    await dialog.locator('form[action$="/delete"]').evaluate((node) => node.requestSubmit());
    expect(t.posts).toEqual([bookPath]);
    await t.kept(bookPath);
    await expect(dialog.locator('[data-book-edit-save-status]')).toContainText('Retry reconciliation');

    failReads = false;
    await dialog.locator('[data-book-edit-reconciliation-retry]').click();
    await expect(form).toHaveAttribute('data-book-edit-save-state', 'reconciled');
    await expect(form).not.toHaveAttribute('aria-busy', 'true');
    await remove.click();
    await expect(t.confirmation).toBeVisible();
    await t.confirmation.locator('[data-app-dialog-confirmation-cancel]').click();
    expect(t.posts).toEqual([bookPath]);
    await t.kept(bookPath);
  });
});
