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

// Delete Page in Edit Page: nothing is deleted without a completed confirmation,
// however the submit was requested, and one confirmation sends one POST. A draft
// survives anything short of a confirmed deletion, and a POST is never repeated.
// The real editor exists only in the built client, so these tests run against it.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

async function withPage(page, run, { content = 'Saved body', direct = false, entry = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-delete-flow-'));
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

    const { noteService, chapterService, bookService } = app.locals;
    const book = bookService.createBook({ title: 'Host Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Host Chapter' });
    const sibling = noteService.createNote({ chapterId: chapter.id, title: 'Sibling Page', content: '' });
    const note = noteService.createNote({ ...(direct ? { bookId: book.id } : { chapterId: chapter.id }), title: 'Doomed Page', content });
    noteService.updateNote(note.id, { title: 'Doomed Page', content: `${content} revised` });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const hostPath = `/notes/${note.id}`;
    const deletePath = `${hostPath}/delete`;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const log = { deletes: 0, saves: 0, gets: [] };
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST' && pathname === deletePath) log.deletes += 1;
      if (request.method() === 'POST' && pathname === hostPath) log.saves += 1;
      if (request.method() === 'GET' && request.resourceType() === 'fetch' && pathname === hostPath) log.gets.push(pathname);
    });

    const dialog = page.locator('#note-edit-dialog');
    const editor = dialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]');
    const confirmation = page.locator('#app-confirmation-dialog');
    await page.goto(origin + hostPath + entry);
    await page.evaluate(() => { window.__pageDeleteDocument = true; });
    if (!entry) await page.locator('.page-heading [data-dialog-open="note-edit-dialog"]').click();
    await expect(editor).toBeVisible();
    await dialog.locator('.notes-workspace-disclosure--delete > summary').click();

    const t = {
      app, db, book, chapter, sibling, note, origin, hostPath, deletePath, log, dialog, editor, confirmation, noteService,
      title: dialog.locator('[name="title"]'),
      save: dialog.getByRole('button', { name: 'Save', exact: true }),
      close: dialog.getByRole('button', { name: 'Close Edit Page' }),
      remove: dialog.locator('button[form="note-delete-form"]'),
      form: dialog.locator('#note-form'),
      error: dialog.locator('[data-dialog-delete-error]'),
      checkAgain: dialog.locator('[data-dialog-delete-check-retry]'),
      confirm: confirmation.locator('[data-app-dialog-confirmation-confirm]'),
      cancel: confirmation.locator('[data-app-dialog-confirmation-cancel]'),
      markdown: () => dialog.locator('#note-form').evaluate((form) => form.__creatorCrateNotesEditor.getMarkdown()),
      exists: () => Boolean(db.prepare('SELECT id FROM notes WHERE id = ?').get(note.id)),
      revisions: () => db.prepare('SELECT COUNT(*) AS n FROM note_revisions WHERE note_id = ?').get(note.id).n,
      type: async (text) => {
        await editor.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(text);
      },
      kept: async () => {
        expect(await page.evaluate(() => window.__pageDeleteDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(hostPath);
        expect(t.exists()).toBe(true);
      },
      arrivedAt: async (parentPath) => {
        await expect(page).toHaveURL(new RegExp(`${parentPath}$`));
        expect(t.exists()).toBe(false);
      },
    };
    await run(t);
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

async function holdRoute(page, url, method = 'POST') {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let arrive;
  const arrived = new Promise((resolve) => { arrive = resolve; });
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    arrive();
    await released;
    return route.continue();
  });
  return { arrived, release };
}

test('pointer: Cancel sends nothing; Delete Page sends one POST and the parent says so', async ({ page }) => {
  await withPage(page, async (t) => {
    expect(t.revisions()).toBeGreaterThan(0);
    await expect(t.dialog.locator('.notes-workspace-warning', { hasText: 'revision history' })).toBeVisible();
    await t.remove.click();
    await expect(t.confirmation).toBeVisible();
    await expect(t.confirmation).toContainText('Delete Page?');
    await expect(t.confirmation).toContainText('saved content, revision history and connections will be removed');
    await expect(t.confirmation).not.toContainText('unsaved');
    await expect(t.cancel).toHaveText('Cancel');
    await expect(t.confirm).toHaveText('Delete Page');
    await t.cancel.click();
    await expect(t.confirmation).toBeHidden();
    await expect(t.remove).toBeFocused();
    expect(t.log.deletes).toBe(0);
    await t.kept();

    await t.remove.click();
    await t.confirm.click();
    await t.arrivedAt(`/notes/chapters/${t.chapter.id}`);
    expect(t.log.deletes).toBe(1);
    expect(t.revisions()).toBe(0);
    const notice = page.locator('[data-page-deletion-undo-alert]');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveClass(/notice--success/);
    await expect(notice).toContainText('Page “Doomed Page” deleted.');
    await expect(notice.getByRole('button', { name: /undo/i })).toBeVisible();

    // The claim leaves the URL, and dismissing it holds across a reload; the page still works.
    expect(new URL(page.url()).search).toBe('');
    const dismiss = notice.locator('[data-chapter-feedback-dismiss]');
    const noticeBox = await notice.boundingBox();
    const dismissBox = await dismiss.boundingBox();
    expect(noticeBox.x + noticeBox.width - (dismissBox.x + dismissBox.width)).toBeLessThan(40);
    await dismiss.click();
    await expect(notice).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.notes-chapter-pages a', { hasText: 'Sibling Page' })).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(page.locator('[data-page-deletion-notice]')).toHaveCount(0);
    await page.locator('.notes-chapter-pages a', { hasText: 'Sibling Page' }).click();
    await expect(page).toHaveURL(new RegExp(`/notes/${t.sibling.id}$`));
  });
});

test('keyboard: the same confirmation, one POST, and a direct Book Page returns to its Book', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.remove.focus();
    await page.keyboard.press('Enter');
    await expect(t.confirmation).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(t.confirmation).toBeHidden();
    await expect(t.remove).toBeFocused();
    expect(t.log.deletes).toBe(0);

    await page.keyboard.press('Space');
    await expect(t.confirmation).toBeVisible();
    await t.confirm.focus();
    await page.keyboard.press('Enter');
    await t.arrivedAt(`/notes/books/${t.book.id}`);
    expect(t.log.deletes).toBe(1);
    await expect(page.locator('[data-page-deletion-undo-alert]')).toContainText('Page “Doomed Page” deleted.');
  }, { direct: true, content: '' });
});

test('requestSubmit takes the confirmation: nothing is sent until it completes, and only once', async ({ page }) => {
  await withPage(page, async (t) => {
    const requestSubmit = () => page.locator('#note-delete-form').evaluate((form) => form.requestSubmit());
    await requestSubmit();
    await expect(t.confirmation).toBeVisible();
    expect(t.log.deletes).toBe(0);
    await requestSubmit();
    await t.cancel.click();
    await expect(t.confirmation).toBeHidden();
    expect(t.log.deletes).toBe(0);
    await t.kept();

    await requestSubmit();
    const held = await holdRoute(page, `**${t.deletePath}`);
    await t.confirm.click();
    await held.arrived;
    // The authorization went with the replay: nothing can reuse it, and the pending
    // lock refuses the rest.
    await requestSubmit();
    await t.remove.evaluate((button) => button.click());
    await t.form.evaluate((form) => form.requestSubmit());
    await expect(t.confirmation).toBeHidden();
    expect(t.log.deletes).toBe(1);
    expect(t.log.saves).toBe(0);
    held.release();
    await t.arrivedAt(`/notes/chapters/${t.chapter.id}`);
    expect(t.log.deletes).toBe(1);
  }, { content: '' });
});

test('an unsaved draft is named, Keep Editing returns to it, and Discard stays separate', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Draft Title');
    await t.type(' draft words');
    await t.remove.click();
    await expect(t.confirmation).toContainText('not just your unsaved changes');
    await expect(t.cancel).toHaveText('Keep Editing');
    await t.cancel.click();
    await expect(t.confirmation).toBeHidden();
    await expect(t.title).toHaveValue('Draft Title');
    expect(await t.markdown()).toContain('draft words');
    expect(t.log.deletes).toBe(0);
    await t.kept();

    await t.close.click();
    await expect(t.confirmation).toContainText('Discard changes?');
    await expect(t.cancel).toHaveText('Cancel');
    await t.cancel.click();
    await expect(t.confirmation).toBeHidden();
    await t.remove.click();
    await expect(t.cancel).toHaveText('Keep Editing');
    await t.confirm.click();
    await t.arrivedAt(`/notes/chapters/${t.chapter.id}`);
    expect(t.log.deletes).toBe(1);
    expect(t.log.saves).toBe(0);
  });
});

test('a pending save refuses Delete and any replay of its confirmation', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Saved Title');
    await t.remove.click();
    await expect(t.confirmation).toBeVisible();
    // A save begun behind an open confirmation: its replay meets the lock.
    const held = await holdRoute(page, `**${t.hostPath}`);
    await t.form.evaluate((form) => form.requestSubmit());
    await held.arrived;
    await t.confirm.click();
    await expect(t.confirmation).toBeHidden();
    await t.remove.evaluate((button) => button.click());
    await page.locator('#note-delete-form').evaluate((form) => form.requestSubmit());
    await expect(t.confirmation).toBeHidden();
    expect(t.log.deletes).toBe(0);
    held.release();
    await expect(t.dialog).toBeHidden();
    expect(t.noteService.getNote(t.note.id).title).toBe('Saved Title');
    expect(t.log.deletes).toBe(0);
    await t.kept();

    await page.locator('.page-heading [data-dialog-open="note-edit-dialog"]').click();
    await t.remove.click();
    await expect(t.confirmation).toBeVisible();
    await t.confirm.click();
    await t.arrivedAt(`/notes/chapters/${t.chapter.id}`);
    expect(t.log.deletes).toBe(1);
  });
});

test('a refusal stays on Page Detail with the draft, and Delete works again', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Draft Title');
    await t.type(' draft words');
    await page.route(`**${t.deletePath}`, (route) => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ status: 'error', code: 'PAGE_OPERATION_FAILED', message: 'The Page could not be deleted. No changes were made.' }),
    }), { times: 1 });
    await t.remove.click();
    await t.confirm.click();
    await expect(t.error).toContainText('could not be deleted');
    await expect(t.remove).toBeFocused();
    expect(t.log.deletes).toBe(1);
    await expect(t.title).toHaveValue('Draft Title');
    expect(await t.markdown()).toContain('draft words');
    await t.kept();

    // A real server refusal: the token is enforced with JSON.
    await page.locator('#note-delete-form [name="_csrf"]').evaluate((input) => { input.value = 'wrong'; });
    await t.remove.click();
    await t.confirm.click();
    await expect(t.error).toContainText('CSRF');
    expect(t.log.deletes).toBe(2);
    await t.kept();
  });
});

test('a lost answer is settled by reading, never by repeating: Page still there', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Draft Title');
    await page.route(`**${t.deletePath}`, (route) => route.abort(), { times: 1 });
    const read = await holdRoute(page, `**${t.hostPath}`, 'GET');
    await t.remove.click();
    await t.confirm.click();
    await read.arrived;
    await expect(t.error).toContainText('Could not confirm');
    read.release();
    await expect(t.error).toContainText('still exists');
    expect(t.log.deletes).toBe(1);
    await expect(t.title).toHaveValue('Draft Title');
    await t.kept();
  });
});

test('an unreadable outcome offers GET-only Check again, and a gone Page is not claimed as deleted here', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Draft Title');
    await page.route(`**${t.deletePath}`, (route) => route.abort(), { times: 1 });
    await page.route(`**${t.hostPath}`, (route) => (route.request().method() === 'GET' ? route.abort() : route.fallback()));
    await t.remove.click();
    await t.confirm.click();
    await expect(t.checkAgain).toBeVisible();
    await expect(t.error).toContainText('could not be checked');
    expect(t.log.deletes).toBe(1);
    await expect(t.title).toHaveValue('Draft Title');

    // Neither Delete nor Save can run on an unknown outcome.
    await page.locator('#note-delete-form').evaluate((form) => form.requestSubmit());
    await t.form.evaluate((form) => form.requestSubmit());
    expect(t.log.deletes).toBe(1);
    expect(t.log.saves).toBe(0);

    await t.checkAgain.click();
    await expect(t.checkAgain).toBeVisible();
    expect(t.log.deletes).toBe(1);

    await page.unroute(`**${t.hostPath}`);
    t.noteService.deleteNote(t.note.id);
    await t.checkAgain.click();
    await t.arrivedAt(`/notes/chapters/${t.chapter.id}`);
    expect(t.log.deletes).toBe(1);
    const notice = page.locator('[data-page-deletion-notice]');
    await expect(notice).toContainText('That Page is no longer available.');
    await expect(notice).not.toContainText('deleted');
    await expect(notice).toHaveClass(/notice--warning/);
  });
});

test('a Page already deleted elsewhere is reported as gone, not as this deletion', async ({ page }) => {
  await withPage(page, async (t) => {
    t.noteService.deleteNote(t.note.id);
    await t.remove.click();
    await t.confirm.click();
    await t.arrivedAt(`/notes/chapters/${t.chapter.id}`);
    expect(t.log.deletes).toBe(1);
    await expect(page.locator('[data-page-deletion-notice]')).toContainText('That Page is no longer available.');
  });
});

test('a directly visited edit URL stays native, confirmed, and reaches the parent with its notice', async ({ page }) => {
  await withPage(page, async (t) => {
    await expect(t.form).toHaveAttribute('data-dialog-async', 'false');
    await page.locator('#note-delete-form').evaluate((form) => form.requestSubmit());
    await expect(t.confirmation).toBeVisible();
    expect(t.log.deletes).toBe(0);
    await t.cancel.click();
    await t.remove.click();
    await t.confirm.click();
    await expect(page).toHaveURL(new RegExp(`/notes/chapters/${t.chapter.id}$`));
    expect(t.exists()).toBe(false);
    expect(t.log.deletes).toBe(1);
    await expect(page.locator('[data-page-deletion-undo-alert] [data-page-deletion-undo]')).toBeVisible();
  }, { entry: '/edit' });
});
