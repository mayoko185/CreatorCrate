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

// Move Page in Edit Page stays on Page Detail: the document, its URL and an unsaved
// draft all survive, the draft is not saved by the move, and a POST is never repeated.
// The real editor exists only in the built client, so these tests run against it.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

async function withPage(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-move-flow-'));
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
    const book = bookService.createBook({ title: 'Source Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Source Chapter' });
    const sameBookChapter = chapterService.createChapter({ bookId: book.id, title: 'Sibling Chapter' });
    const otherBook = bookService.createBook({ title: 'Other Book' });
    const otherChapter = chapterService.createChapter({ bookId: otherBook.id, title: 'Other Chapter' });
    const resident = noteService.createNote({ chapterId: otherChapter.id, title: 'Resident Page', content: '' });
    const project = db.prepare("INSERT INTO projects (title, slug, description, notes, status, project_type) VALUES ('Alpha', 'alpha', '', '', 'tbd', 'images')").run().lastInsertRowid;
    const note = noteService.createNote({ chapterId: chapter.id, title: 'Original Title', content: 'Original body' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const hostPath = `/notes/${note.id}`;
    const movePath = `${hostPath}/move`;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const log = { navigations: [], posts: [], moves: [], gets: [] };
    let visited = false;
    page.on('framenavigated', (frame) => {
      if (visited && frame === page.mainFrame()) log.navigations.push(frame.url());
    });
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST') log.posts.push(pathname);
      if (request.method() === 'POST' && pathname === movePath) log.moves.push(request.postData());
      if (request.method() === 'GET' && request.resourceType() === 'fetch' && pathname === hostPath) log.gets.push(pathname);
    });

    const dialog = page.locator('#note-edit-dialog');
    const editor = dialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]');
    await page.goto(origin + hostPath);
    visited = true;
    log.navigations.length = 0;
    await page.evaluate(() => { window.__movePageDocument = true; });
    await page.locator('.page-heading [data-dialog-open="note-edit-dialog"]').click();
    await expect(editor).toBeVisible();
    await dialog.locator('.notes-workspace-disclosure--move > summary').click();

    const t = {
      app, book, chapter, sameBookChapter, otherBook, otherChapter, resident, project, note, hostPath, movePath, log, dialog, editor, noteService,
      title: dialog.locator('[name="title"]'),
      save: dialog.getByRole('button', { name: 'Save', exact: true }),
      close: dialog.getByRole('button', { name: 'Close Edit Page' }),
      move: dialog.locator('button[form="note-move-form"]'),
      target: dialog.locator('#note-move-target'),
      notice: dialog.locator('[data-dialog-move-notice]'),
      form: dialog.locator('#note-form'),
      confirmation: page.locator('#app-confirmation-dialog'),
      feedback: page.locator('[data-dialog-feedback]'),
      sidebarNav: page.locator('.notes-page-detail-sidebar .notes-book-nav'),
      markdown: () => dialog.locator('#note-form').evaluate((form) => form.__creatorCrateNotesEditor.getMarkdown()),
      saved: () => noteService.getNote(note.id),
      choose: (value) => dialog.locator('#note-move-target').evaluate((select, next) => { select.value = next; }, value),
      type: async (text) => {
        await editor.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(text);
      },
      kept: async () => {
        expect(log.navigations).toEqual([]);
        expect(await page.evaluate(() => window.__movePageDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(hostPath);
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

// Holds the next request of a method to a path until release() says how to answer.
async function hold(page, pathname, method = 'POST', { fetchOnly = false } = {}) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  let held = false;
  await page.route((url) => url.pathname === pathname, async (route) => {
    const request = route.request();
    if (request.method() !== method || held || (fetchOnly && request.resourceType() !== 'fetch')) {
      await route.fallback();
      return;
    }
    held = true;
    reached();
    await (await released)(route);
  });
  return { arrived, release: (answer = (route) => route.fallback()) => release(answer) };
}

test('a move keeps every unsaved edit unsaved, and a later Save lands on the moved Page', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Draft Title');
    await t.type(' draft words');
    await t.dialog.locator('#note-projects-form summary').click();
    await t.dialog.locator(`#note-projects-form input[value="${t.project}"]`).check();
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeVisible();

    await t.choose(`chapter:${t.otherChapter.id}`);
    await t.move.click();

    await expect(t.notice).toContainText('Page moved to Chapter “Other Book / Other Chapter”.');
    await expect(t.notice).toContainText('Your unsaved edits are still here.');
    expect(t.log.moves).toHaveLength(1);
    expect(t.log.moves[0]).toContain(`targetContainer=chapter%3A${t.otherChapter.id}`);
    expect(t.log.moves[0]).not.toContain('Draft');
    await t.kept();
    await expect(t.dialog).toBeVisible();

    // Saved: the location only. Drafted: everything else, still in the dialog.
    expect(t.saved()).toMatchObject({
      id: t.note.id, book_id: t.otherBook.id, chapter_id: t.otherChapter.id, title: 'Original Title', content: 'Original body', projectIds: [],
    });
    await expect(t.title).toHaveValue('Draft Title');
    expect(await t.markdown()).toContain('draft words');
    await expect(t.dialog.locator(`#note-projects-form input[value="${t.project}"]`)).toBeChecked();

    // Page Detail follows the saved values, not the draft.
    await expect(t.sidebarNav).toHaveAttribute('aria-label', 'Contents of Other Book');
    await expect(t.sidebarNav.locator('.notes-book-nav-page-link[aria-current="page"]')).toHaveText('Original Title');
    await expect(page.locator('#notes-detail-content-heading')).toHaveText('Original Title');
    await expect(t.dialog.locator('.notes-book-nav')).toHaveAttribute('aria-label', 'Contents of Other Book');
    await expect(t.target).toHaveValue(`chapter:${t.otherChapter.id}`);
    await expect(page.locator('.notes-page-detail-sidebar .notes-book-cover-link')).toHaveAttribute('href', `/notes/books/${t.otherBook.id}`);
    const order = t.noteService.listNotesForChapter(t.otherChapter.id).map((item) => item.id);
    expect(order).toEqual([t.resident.id, t.note.id]);

    // The guard still sees the draft: Escape asks, and Keep Editing keeps it.
    await t.title.focus();
    await page.keyboard.press('Escape');
    await expect(t.confirmation).toBeVisible();
    await t.confirmation.locator('[data-app-dialog-confirmation-cancel]').click();
    await expect(t.title).toHaveValue('Draft Title');

    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toMatchObject({ title: 'Draft Title', book_id: t.otherBook.id, chapter_id: t.otherChapter.id, projectIds: [t.project] });
    expect(t.saved().content).toContain('draft words');
    expect(t.log.moves).toHaveLength(1);
    await t.kept();
  });
});

test('moving to a Book, the destination link waits for the dialog to close', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Draft Title');
    await t.choose(`book:${t.otherBook.id}`);
    await t.move.focus();
    await page.keyboard.press('Enter');
    await expect(t.notice).toContainText('Page moved to Book “Other Book”.');
    await expect(t.move).toBeFocused();
    expect(t.saved()).toMatchObject({ book_id: t.otherBook.id, chapter_id: null, title: 'Original Title' });
    await expect(t.sidebarNav.locator(':scope > .notes-book-nav-list > .notes-book-nav-page .notes-book-nav-page-link[aria-current="page"]')).toHaveText('Original Title');
    await expect(t.title).toHaveValue('Draft Title');
    await t.kept();

    // The explicit choice about the draft comes before the way off this page.
    await t.close.click();
    await expect(t.confirmation).toBeVisible();
    await t.confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page moved to Book “Other Book”.');
    await t.kept();
    await expect(t.title).toHaveValue('Original Title');
    await expect(t.notice).toHaveCount(0);

    await t.feedback.locator('[data-page-move-destination]').click();
    await expect(page).toHaveURL(new RegExp(`/notes/books/${t.otherBook.id}$`));
    expect(t.log.moves).toHaveLength(1);
  });
});

test('moving to another Chapter of the Book opens it in the navigator, with the sibling state kept', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.type(' draft');
    const destination = () => t.sidebarNav.locator(`[data-book-nav-chapter="${t.sameBookChapter.id}"]`).locator('xpath=ancestor::details[1]');
    await expect(destination()).not.toHaveAttribute('open', '');
    await t.choose(`chapter:${t.sameBookChapter.id}`);
    await t.move.click();
    await expect(t.notice).toContainText('Page moved to Chapter “Source Book / Sibling Chapter”.');
    await expect(destination()).toHaveAttribute('open', '');
    await expect(destination().locator('[aria-current="page"]')).toHaveText('Original Title');
    expect(t.saved()).toMatchObject({ book_id: t.book.id, chapter_id: t.sameBookChapter.id });
    expect(await t.markdown()).toContain(' draft');
    await t.kept();
  });
});

test('a refusal stays local, keeps the draft and the choice, and sends nothing again', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Draft Title');
    // Stale: another tab removes this Chapter after the page was read.
    const stale = t.app.locals.chapterService.createChapter({ bookId: t.otherBook.id, title: 'Doomed Chapter' });
    await page.evaluate(({ id }) => {
      const select = document.querySelector('#note-move-target');
      select.add(new Option('Chapter: Other Book / Doomed Chapter', `chapter:${id}`));
    }, { id: stale.id });
    t.app.locals.chapterService.deleteChapter(stale.id);
    await t.choose(`chapter:${stale.id}`);
    await t.move.click();

    await expect(t.notice).toHaveText('This Chapter is no longer available.');
    await expect(t.notice).toHaveAttribute('role', 'alert');
    await expect(t.move).toBeFocused();
    expect(t.log.moves).toHaveLength(1);
    expect(t.saved().chapter_id).toBe(t.chapter.id);
    await expect(t.title).toHaveValue('Draft Title');
    await t.kept();
    // The read that follows drops the destination that has gone, back to the saved one.
    await expect(t.target).toHaveValue(`chapter:${t.chapter.id}`);
    await expect(t.sidebarNav).toHaveAttribute('aria-label', 'Contents of Source Book');

    // A choice that still exists is kept for correction, and controls work again.
    const refused = await hold(page, t.movePath);
    await t.choose(`book:${t.otherBook.id}`);
    await t.move.click();
    await refused.arrived;
    refused.release((route) => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ status: 'error', code: 'PAGE_OPERATION_FAILED', message: 'The Page could not be moved. No changes were made.' }),
    }));
    await expect(t.notice).toHaveText('The Page could not be moved. No changes were made.');
    await expect(t.target).toHaveValue(`book:${t.otherBook.id}`);
    await expect(t.form).not.toHaveAttribute('aria-busy', 'true');
    await t.title.fill('Still Editable');
    await expect(t.title).toHaveValue('Still Editable');
    expect(t.log.moves).toHaveLength(2);
    await t.kept();

    // Closing ends that choice; the next open shows the saved location.
    await t.close.click();
    await t.confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    await expect(t.dialog).toBeHidden();
    await expect(t.target).toHaveValue(`chapter:${t.chapter.id}`);
    expect(t.log.moves).toHaveLength(2);
  });
});

test('Move Page waits out a pending Save, and a pending move holds everything else', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Saved Title');
    const save = await hold(page, t.hostPath);
    await t.save.click();
    await save.arrived;
    await t.choose(`book:${t.otherBook.id}`);
    await t.move.click();
    await page.locator('#note-move-form').evaluate((form) => form.requestSubmit());
    expect(t.log.moves).toEqual([]);
    await t.kept();
    save.release();
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toMatchObject({ title: 'Saved Title', chapter_id: t.chapter.id });
    expect(t.log.moves).toEqual([]);

    // Now the move: duplicates, a competing Save and dismissal all wait for it.
    await page.locator('.page-heading [data-dialog-open="note-edit-dialog"]').click();
    await expect(t.editor).toBeVisible();
    await t.title.fill('Next Draft');
    await t.choose(`book:${t.otherBook.id}`);
    const move = await hold(page, t.movePath);
    await t.move.click();
    await move.arrived;
    await expect(t.form).toHaveAttribute('aria-busy', 'true');
    await page.locator('#note-move-form').evaluate((form) => form.requestSubmit());
    await page.locator('#note-form').evaluate((form) => form.requestSubmit());
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeVisible();
    await expect(t.confirmation).toBeHidden();
    await expect(t.target.locator('xpath=ancestor::*[@inert][1]')).toBeAttached();
    expect(t.log.moves).toHaveLength(1);
    expect(t.log.posts.filter((pathname) => pathname === t.hostPath)).toHaveLength(1);

    move.release();
    await expect(t.notice).toContainText('Page moved to Book “Other Book”.');
    await expect(t.form).not.toHaveAttribute('aria-busy', 'true');
    await expect(t.title).toHaveValue('Next Draft');
    await t.title.fill('Next Draft Again');
    await expect(t.title).toHaveValue('Next Draft Again');
    expect(t.log.moves).toHaveLength(1);
    expect(t.saved().title).toBe('Saved Title');
    await t.kept();
  });
});

test('a lost answer is never retried: a read settles it, whichever way it went', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Draft Title');
    await t.choose(`book:${t.otherBook.id}`);
    // The POST commits, but its answer is lost; the first read fails too.
    let failReads = true;
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (failReads && route.request().resourceType() === 'fetch') await route.abort('failed');
      else await route.fallback();
    });
    await page.route((url) => url.pathname === t.movePath, async (route) => {
      await route.fetch();
      await route.abort('failed');
    });
    await t.move.click();

    const checkAgain = t.dialog.locator('[data-page-move-check-retry]');
    await expect(checkAgain).toBeFocused();
    await expect(t.notice).toContainText('Could not confirm whether the Page was moved');
    await expect(t.move).toBeDisabled();
    await expect(t.title).toHaveValue('Draft Title');
    // The draft stays usable while the location is unknown, and Move stays refused.
    await t.title.fill('Draft While Unknown');
    await page.locator('#note-move-form').evaluate((form) => form.requestSubmit());
    expect(t.log.moves).toHaveLength(1);
    await checkAgain.focus();

    failReads = false;
    await checkAgain.click();
    await expect(t.notice).toHaveText('This Page is now in “Book: Other Book (direct Pages)”.');
    await expect(t.sidebarNav).toHaveAttribute('aria-label', 'Contents of Other Book');
    await expect(t.target).toHaveValue(`book:${t.otherBook.id}`);
    await expect(t.move).toBeEnabled();
    await expect(t.title).toHaveValue('Draft While Unknown');
    expect(t.log.moves).toHaveLength(1);
    await t.kept();
  });
});

test('a lost answer that never reached the server reports the Page as not moved', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.type(' draft');
    await t.choose(`book:${t.otherBook.id}`);
    await page.route((url) => url.pathname === t.movePath, (route) => route.abort('failed'));
    await t.move.click();
    await expect(t.notice).toHaveText('The Page was not moved. It is still in “Chapter: Source Book / Source Chapter”.');
    await expect(t.target).toHaveValue(`book:${t.otherBook.id}`);
    await expect(t.move).toBeEnabled();
    expect(t.saved().chapter_id).toBe(t.chapter.id);
    expect(await t.markdown()).toContain(' draft');
    expect(t.log.moves).toHaveLength(1);
    expect(t.log.gets).toHaveLength(1);
    await t.kept();
  });
});

test('a confirmed move stays reported when its read fails, and Retry refresh only reads', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.title.fill('Draft Title');
    await t.choose(`book:${t.otherBook.id}`);
    let failReads = true;
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (failReads && route.request().resourceType() === 'fetch') await route.abort('failed');
      else await route.fallback();
    });
    await t.move.click();
    await expect(t.notice).toContainText('Page moved to Book “Other Book”.');
    await expect(t.notice).toContainText('This page could not refresh.');
    await expect(t.target).toHaveValue(`book:${t.otherBook.id}`);
    await expect(t.sidebarNav).toHaveAttribute('aria-label', 'Contents of Source Book');
    const retry = t.dialog.locator('[data-page-move-refresh-retry]');
    await expect(retry).toBeVisible();

    failReads = false;
    await retry.click();
    await expect(t.sidebarNav).toHaveAttribute('aria-label', 'Contents of Other Book');
    await expect(retry).toHaveCount(0);
    await expect(t.notice).toContainText('Page moved to Book “Other Book”.');
    await expect(t.notice).not.toContainText('could not refresh');
    await expect(t.title).toHaveValue('Draft Title');
    expect(t.log.moves).toHaveLength(1);
    await t.kept();
  });
});

test('a read begun before the move cannot restore the old location', async ({ page }) => {
  await withPage(page, async (t) => {
    // A Save whose refresh is held has read this Page in its old location.
    await t.title.fill('Saved Title');
    const staleRead = await hold(page, t.hostPath, 'GET', { fetchOnly: true });
    let staleBody;
    await t.save.click();
    await staleRead.arrived;
    await expect(t.dialog).toBeHidden();
    await page.locator('.page-heading [data-dialog-open="note-edit-dialog"]').click();
    await expect(t.editor).toBeVisible();

    await t.title.fill('Next Draft');
    await t.choose(`book:${t.otherBook.id}`);
    staleBody = await page.evaluate(async (url) => (await fetch(`${url}?stale`, { headers: { Accept: 'text/html' } })).text(), t.hostPath);
    await t.move.click();
    await expect(t.notice).toContainText('Page moved to Book “Other Book”.');
    await expect(t.sidebarNav).toHaveAttribute('aria-label', 'Contents of Other Book');

    staleRead.release((route) => route.fulfill({ status: 200, contentType: 'text/html', body: staleBody }));
    await page.waitForTimeout(100);
    await expect(t.sidebarNav).toHaveAttribute('aria-label', 'Contents of Other Book');
    await expect(t.target).toHaveValue(`book:${t.otherBook.id}`);
    await expect(t.title).toHaveValue('Next Draft');
    expect(t.log.moves).toHaveLength(1);
    await t.kept();
  });
});

test('a direct /notes/:id/edit visit keeps the native move and its redirect', async ({ page }) => {
  await withPage(page, async (t) => {
    await page.goto(`${new URL(page.url()).origin}${t.hostPath}/edit`);
    await page.locator('.notes-workspace-disclosure--move > summary').click();
    await t.choose(`book:${t.otherBook.id}`);
    await t.move.click();
    await expect(page).toHaveURL(new RegExp(`/notes/books/${t.otherBook.id}$`));
    expect(t.saved()).toMatchObject({ book_id: t.otherBook.id, chapter_id: null });
  });
});
