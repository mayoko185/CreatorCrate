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

// New Page saves in place: its host is never navigated or replaced, a draft stays
// in the dialog until it is created or discarded, and a POST is never repeated.
// The real editor exists only in the built client, so these tests run against it.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

async function withHosts(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-new-page-flow-'));
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
    const origin = `http://127.0.0.1:${server.address().port}`;
    const projectId = db.prepare("INSERT INTO projects (title, slug, description, notes, status, project_type) VALUES ('Alpha', 'alpha', '', '', 'tbd', 'images')").run().lastInsertRowid;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const log = { navigations: [], posts: [], gets: [] };
    let hostPath = null;
    page.on('framenavigated', (frame) => {
      if (hostPath && frame === page.mainFrame()) log.navigations.push(frame.url());
    });
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST' && pathname === '/notes') log.posts.push(request);
      if (request.method() === 'GET' && pathname === hostPath) log.gets.push(request);
    });

    const dialog = page.locator('#note-create-dialog');
    const editor = dialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]');
    await run({
      app, db, origin, book, chapter, projectId, log, dialog, editor, noteService,
      title: dialog.locator('[name="title"]'),
      create: dialog.getByRole('button', { name: 'Create', exact: true }),
      close: dialog.getByRole('button', { name: 'Close New Page' }),
      summary: dialog.locator('[data-dialog-error]'),
      feedback: page.locator('[data-dialog-feedback]'),
      trigger: page.locator('.page-heading [data-dialog-open="note-create-dialog"]'),
      orderTrigger: page.locator('.page-heading [data-dialog-open="chapter-order-dialog"]'),
      project: dialog.locator(`#note-projects-form input[value="${projectId}"]`),
      projectSummary: dialog.locator('#note-projects-form summary'),
      mainTitles: () => page.locator('.notes-chapter-pages .notes-page-nav-link').allTextContents(),
      navTitles: () => page.locator('.notes-chapter-detail-sidebar .notes-book-nav-item--current .notes-book-nav-pages a').allTextContents(),
      saved: () => noteService.listNotes().map((note) => note.title),
      visit: async (pathname) => {
        hostPath = pathname;
        log.navigations.length = 0;
        await page.goto(origin + pathname);
        log.navigations.length = 0;
        await page.evaluate(() => { window.__newPageDocument = true; });
      },
      kept: async () => {
        expect(log.navigations).toEqual([]);
        expect(await page.evaluate(() => window.__newPageDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(hostPath);
      },
      openDialog: async (trigger) => {
        await trigger.click();
        await expect(dialog).toBeVisible();
        await expect(editor).toBeVisible();
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

test('Chapter Detail creates in place from the editor, once, and the host follows', async ({ page }) => {
  await withHosts(page, async (t) => {
    t.noteService.createNote({ chapterId: t.chapter.id, title: 'First Page' });
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    await expect(t.orderTrigger).toHaveCount(0);
    await page.evaluate(() => {
      document.querySelector('.notes-chapter-detail-sidebar [data-book-nav-chapter]').closest('details').open = true;
      window.scrollTo(0, 20);
    });

    await t.openDialog(t.trigger);
    expect(await t.dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
    await t.kept();
    await t.title.fill('Second Page');
    await t.editor.click();
    await page.keyboard.type('Typed in the editor');
    // A real click: the request is built before the editor's own submit listener runs.
    await t.create.click();

    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page “Second Page” created.');
    await expect(t.trigger).toBeFocused();
    await t.kept();
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.posts[0].postData()).toContain('Typed+in+the+editor');
    const created = t.noteService.listNotesForChapter(t.chapter.id).at(-1);
    expect(created).toMatchObject({ title: 'Second Page', chapter_id: t.chapter.id, book_id: t.book.id });
    expect(created.content).toBe('Typed in the editor');
    await expect(page.locator('[data-page-view]')).toHaveAttribute('href', `/notes/${created.id}`);

    await expect.poll(t.mainTitles).toEqual(['First Page', 'Second Page']);
    await expect.poll(t.navTitles).toEqual(['First Page', 'Second Page']);
    await expect(page.locator('#note-create-dialog .notes-book-nav-pages a')).toHaveText(['First Page', 'Second Page']);
    expect(await page.evaluate(() => document.querySelector('.notes-chapter-detail-sidebar [data-book-nav-chapter]').closest('details').open)).toBe(true);

    // The count crossed the server's threshold: Change order arrives, with the new Page.
    await expect(t.orderTrigger).toHaveCount(1);
    await t.orderTrigger.click();
    await expect(page.locator('#chapter-order-dialog')).toBeVisible();
    await expect(page.locator('#chapter-order-dialog .notes-chapter-page-title')).toHaveText(['First Page', 'Second Page']);
    await page.locator('#chapter-order-dialog [data-dialog-close]').first().click();

    await t.openDialog(t.trigger);
    await expect(t.title).toHaveValue('');
    await expect(t.editor).not.toContainText('Typed in the editor');
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(page.locator('#app-confirmation-dialog')).toBeHidden();
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('the empty Chapter action opens the dialog and gives way to the Page list', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    await t.openDialog(page.locator('.notes-chapter-pages .empty-state a'));
    await t.title.fill('Only Page');
    await page.keyboard.press('Enter');
    await expect(t.dialog).toBeHidden();
    await expect.poll(t.mainTitles).toEqual(['Only Page']);
    await expect(page.locator('.notes-chapter-pages .empty-state')).toHaveCount(0);
    await expect(t.orderTrigger).toHaveCount(0);
    await expect(t.trigger).toBeFocused();
    expect(t.log.posts).toHaveLength(1);
    // A second create, from the trigger that survived, crosses the threshold.
    await t.openDialog(t.trigger);
    await t.title.fill('Next Page');
    await t.create.click();
    await expect.poll(t.mainTitles).toEqual(['Only Page', 'Next Page']);
    await expect(t.orderTrigger).toHaveCount(1);
    await t.kept();
  });
});

test('Book Detail creates a direct Page and updates navigator, previews and choices', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/books/${t.book.id}`);
    await expect(page.locator('.notes-page-previews-empty')).toBeVisible();
    await t.openDialog(t.trigger);
    await t.title.fill('Direct Page');
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    await t.kept();
    expect(t.log.posts).toHaveLength(1);

    const created = t.noteService.listNotes().at(-1);
    expect(created).toMatchObject({ title: 'Direct Page', book_id: t.book.id, chapter_id: null });
    await expect(page.locator('[data-page-view]')).toHaveAttribute('href', `/notes/${created.id}`);
    const sidebarPages = page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav a.notes-book-nav-page-link');
    await expect(sidebarPages).toHaveText(['Direct Page']);
    await expect(page.locator('.notes-page-preview-title')).toHaveText(['Direct Page']);
    await expect(page.locator(`#book-preview-pages option[value="${created.id}"]`)).toHaveCount(1);
    await expect(page.locator(`#book-preview-pages-dropdown input[value="${created.id}"]`)).toHaveCount(1);
    await expect(page.locator('[data-book-detail-toolbar] [data-dialog-open="book-order-dialog"]')).toHaveCount(1);
  });
});

test('Book Detail keeps a random preview sample rather than redrawing it', async ({ page }) => {
  await withHosts(page, async (t) => {
    const titles = Array.from({ length: 8 }, (_, index) => `Sampled ${index}`);
    titles.forEach((title) => t.noteService.createNote({ bookId: t.book.id, title }));
    // Pins each read's sample so the two differ: the host's first read, then the refresh's.
    const [first, second] = [titles.slice(0, 2), titles.slice(2, 4)];
    const hostPath = `/notes/books/${t.book.id}`;
    t.app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(t.book.id, {
      mode: 'selected', randomCount: 2, selectedPageIds: t.noteService.listNotes().filter((note) => first.includes(note.title)).map((note) => note.id),
    });
    await t.visit(hostPath);
    t.app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(t.book.id, {
      mode: 'selected', randomCount: 2, selectedPageIds: t.noteService.listNotes().filter((note) => second.includes(note.title)).map((note) => note.id),
    });
    const previews = page.locator('.notes-page-preview-title');
    await expect(previews).toHaveText(first);
    await t.openDialog(t.trigger);
    await t.title.fill('Newest Page');
    await t.create.click();
    await expect(page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav a', { hasText: 'Newest Page' })).toHaveCount(1);
    await expect(previews).toHaveText(first);
  });
});

test('a refusal keeps the draft, editor and connections, and the corrected draft creates once', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    await t.openDialog(t.trigger);
    await t.editor.click();
    await page.keyboard.type('Keep this draft');
    await t.projectSummary.click();
    await t.project.check();
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeVisible();

    await t.create.click();
    await expect(t.summary).toBeVisible();
    await expect(t.dialog.locator('#note-create-title-error')).toHaveText('Title is required.');
    await expect(t.title).toBeFocused();
    await expect(t.title).toHaveAttribute('aria-invalid', 'true');
    await expect(t.editor).toContainText('Keep this draft');
    await expect(t.project).toBeChecked();
    await expect(t.create).toBeEnabled();
    expect(t.saved()).toEqual([]);
    await t.kept();

    // The editor still works after a refusal, and the error clears on the next try.
    await t.editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' and more');
    await t.title.fill('Corrected');
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(2);
    const created = t.noteService.listNotes().at(-1);
    expect(created.content).toBe('Keep this draft and more');
    expect(t.noteService.getNote(created.id).projectIds).toEqual([t.projectId]);

    await t.openDialog(t.trigger);
    await expect(t.summary).toBeHidden();
    await expect(t.dialog.locator('#note-create-title-error')).toHaveCount(0);
    await expect(t.project).not.toBeChecked();
    await expect(t.projectSummary).toContainText('No projects selected');
    await expect(t.editor).not.toContainText('Keep this draft');
  });
});

test('a connection gone stale is reported on its field with the draft kept', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    await t.openDialog(t.trigger);
    await t.title.fill('Stale connection');
    await t.projectSummary.click();
    await t.project.check();
    await page.keyboard.press('Escape');
    await t.project.evaluate((input) => { input.value = '999999'; });
    await t.create.click();
    await expect(t.dialog.locator('[data-dialog-field="projectIds"] .field-error-message')).toHaveText('Project 999999 not found.');
    await expect(t.projectSummary).toBeFocused();
    await expect(t.title).toHaveValue('Stale connection');
    expect(t.saved()).toEqual([]);
    await t.kept();
  });
});

test('every dismissal stays local, honors the unsaved-changes guard and reopens clean', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    const confirmation = page.locator('#app-confirmation-dialog');
    const backdrop = async () => {
      const box = await t.dialog.boundingBox();
      await page.mouse.click(box.x > 4 ? box.x - 3 : 2, 2);
    };

    for (const [name, dismiss] of [
      ['Close', () => t.close.click()],
      ['Escape', () => page.keyboard.press('Escape')],
      ['backdrop', backdrop],
    ]) {
      await test.step(name, async () => {
        await t.openDialog(t.trigger);
        await t.title.fill(`Draft ${name}`);
        await t.editor.click();
        await page.keyboard.type('Unsaved words');
        await t.title.focus();
        await dismiss();
        await expect(confirmation).toBeVisible();
        await confirmation.getByRole('button', { name: 'Cancel' }).click();
        await expect(t.dialog).toBeVisible();
        await expect(t.title).toHaveValue(`Draft ${name}`);
        await dismiss();
        await confirmation.getByRole('button', { name: 'Discard' }).click();
        await expect(t.dialog).toBeHidden();
        await expect(t.trigger).toBeFocused();
        await t.kept();
        await t.openDialog(t.trigger);
        await expect(t.title).toHaveValue('');
        await expect(t.editor).not.toContainText('Unsaved words');
        await page.keyboard.press('Escape');
        await expect(t.dialog).toBeHidden();
        await expect(t.trigger).toBeFocused();
      });
    }
    expect(t.log.posts).toHaveLength(0);
    expect(t.saved()).toEqual([]);
  });
});

test('a save in flight cannot be dismissed or sent twice', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/notes', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await held;
      return route.continue();
    });
    await t.openDialog(t.trigger);
    await t.title.fill('Held Page');
    await t.title.press('Enter');
    await expect(t.create).toBeDisabled();
    await t.title.press('Enter');
    await page.keyboard.press('Escape');
    await t.close.click();
    await expect(t.dialog).toBeVisible();
    await expect(page.locator('#app-confirmation-dialog')).toBeHidden();
    release();
    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(1);
    expect(t.saved()).toEqual(['Held Page']);
    await t.kept();
  });
});

test('a create held pending refuses later edits and creates exactly what was submitted', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/notes', async (route) => {
      if (route.request().method() === 'POST') await held;
      return route.continue();
    });
    await t.openDialog(t.trigger);
    await t.title.fill('Frozen Page');
    await t.editor.click();
    await page.keyboard.type('Frozen words');
    await t.create.click();
    await expect(t.dialog).toHaveAttribute('data-dialog-state', 'pending');

    // Real pointer and keyboard input against the frozen form.
    const clickCenter = async (locator) => {
      await locator.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      const box = await locator.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await clickCenter(t.title);
    await page.keyboard.type('LATE');
    await clickCenter(t.editor);
    await page.keyboard.type('LATE');
    await clickCenter(t.projectSummary);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(t.dialog).toBeVisible();
    await expect(t.title).toHaveValue('Frozen Page');
    expect(await t.dialog.locator('#note-form').evaluate((form) => form.__creatorCrateNotesEditor.getMarkdown())).toBe('Frozen words');
    await expect(t.project).not.toBeChecked();
    await expect(t.dialog.locator('#note-projects-form')).not.toHaveAttribute('open');

    release();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page “Frozen Page” created.');
    await expect(t.trigger).toBeFocused();
    await t.kept();

    expect(t.log.posts).toHaveLength(1);
    const sent = new URLSearchParams(t.log.posts[0].postData());
    expect(sent.get('title')).toBe('Frozen Page');
    expect(sent.get('content')).toBe('Frozen words');
    expect(sent.get('chapterId')).toBe(String(t.chapter.id));
    const created = t.noteService.listNotesForChapter(t.chapter.id).at(-1);
    expect(created).toMatchObject({ title: 'Frozen Page', content: 'Frozen words', chapter_id: t.chapter.id });
    await expect.poll(t.mainTitles).toEqual(['Frozen Page']);

    await t.openDialog(t.trigger);
    await expect(t.title).toHaveValue('');
    await expect(t.editor).not.toContainText('Frozen words');
    await t.title.fill('Editable again');
    await expect(t.title).toHaveValue('Editable again');
    await t.title.fill('');
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(1);
  });
});

test('a held create keeps its connection and a held refusal returns the draft editable', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/notes', async (route) => {
      if (route.request().method() === 'POST') await held;
      return route.continue();
    });
    await t.openDialog(t.trigger);
    await t.editor.click();
    await page.keyboard.type('Refused words');
    await t.projectSummary.click();
    await t.project.check();
    await page.keyboard.press('Escape');
    await t.create.click();
    await expect(t.dialog).toHaveAttribute('data-dialog-state', 'pending');
    const box = await t.editor.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type('LATE');

    release();
    await expect(t.dialog.locator('#note-create-title-error')).toHaveText('Title is required.');
    await expect(t.title).toBeFocused();
    await expect(t.dialog.locator('[inert]')).toHaveCount(0);
    await expect(t.project).toBeChecked();
    expect(await t.dialog.locator('#note-form').evaluate((form) => form.__creatorCrateNotesEditor.getMarkdown())).toBe('Refused words');

    await page.keyboard.type('Corrected');
    await t.editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' fixed');
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(2);
    const created = t.noteService.listNotes().at(-1);
    expect(created).toMatchObject({ title: 'Corrected', content: 'Refused words fixed' });
    expect(t.noteService.getNote(created.id).projectIds).toEqual([t.projectId]);
    await t.kept();
  });
});

test('a lost or unreadable response is reported as uncertain and never retried', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    await t.openDialog(t.trigger);
    await t.title.fill('Uncertain Page');

    // The write lands, but its answer never arrives.
    await page.route('**/notes', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      return route.abort('connectionreset');
    }, { times: 1 });
    await t.create.click();
    await expect(t.summary).toContainText('Could not confirm whether the Page was created');
    await expect(t.dialog).toBeVisible();
    await expect(t.title).toHaveValue('Uncertain Page');
    await expect(t.create).toBeEnabled();
    await expect(t.feedback).toBeHidden();
    // The read it offers shows the Page without another POST.
    await expect.poll(t.mainTitles).toEqual(['Uncertain Page']);
    expect(t.log.posts).toHaveLength(1);
    expect(t.saved()).toEqual(['Uncertain Page']);

    // An answer that is not the application's own.
    await page.route('**/notes', (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Sign in</html>' })
      : route.continue()), { times: 1 });
    await t.create.click();
    await expect(t.summary).toContainText('Could not confirm whether the Page was created');
    await expect(t.dialog).toBeVisible();
    await expect(page.locator('[data-page-view]')).toHaveCount(0);

    // A coded refusal wrote nothing, so it is reported as that.
    await page.route('**/notes', (route) => (route.request().method() === 'POST'
      ? route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', code: 'PAGE_OPERATION_FAILED', message: 'The Page could not be created. No changes were made.' }),
      })
      : route.continue()), { times: 1 });
    await t.create.click();
    await expect(t.summary).toContainText('No changes were made.');
    await expect(t.create).toBeFocused();
    await t.kept();
  });
});

test('a deleted parent is refused with the draft kept', async ({ page }) => {
  await withHosts(page, async (t) => {
    await t.visit(`/notes/chapters/${t.chapter.id}`);
    await t.openDialog(t.trigger);
    await t.title.fill('Orphan');
    t.app.locals.chapterService.deleteChapter(t.chapter.id);
    await t.create.click();
    await expect(t.summary).toContainText('This Chapter is no longer available.');
    await expect(t.title).toHaveValue('Orphan');
    await expect(t.create).toBeFocused();
    await t.kept();
  });
});

test('a failed refresh keeps the confirmation and recovers with reads only', async ({ page }) => {
  await withHosts(page, async (t) => {
    t.noteService.createNote({ chapterId: t.chapter.id, title: 'First Page' });
    const hostPath = `/notes/chapters/${t.chapter.id}`;
    await t.visit(hostPath);
    await page.route(`**${hostPath}`, (route) => route.abort('failed'));
    await t.openDialog(t.trigger);
    await t.title.fill('Second Page');
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page “Second Page” created.');
    await expect(t.feedback).toContainText('The Page was created, but this page could not refresh.');
    const created = t.noteService.listNotesForChapter(t.chapter.id).at(-1);
    await expect(page.locator('[data-page-view]')).toHaveAttribute('href', `/notes/${created.id}`);
    expect(await t.mainTitles()).toEqual(['First Page']);

    await page.unroute(`**${hostPath}`);
    await page.locator('[data-chapter-refresh-retry]').click();
    await expect.poll(t.mainTitles).toEqual(['First Page', 'Second Page']);
    await expect(t.orderTrigger).toHaveCount(1);
    await expect(page.locator('[data-chapter-refresh-retry]')).toHaveCount(0);
    await expect(page.locator('[data-page-view]')).toBeVisible();
    expect(t.log.posts).toHaveLength(1);
    expect(t.saved()).toEqual(['First Page', 'Second Page']);
    await t.kept();
  });
});

test('a refresh landing over a Change order draft leaves that draft alone', async ({ page }) => {
  await withHosts(page, async (t) => {
    ['Page A', 'Page B'].forEach((title) => t.noteService.createNote({ chapterId: t.chapter.id, title }));
    const hostPath = `/notes/chapters/${t.chapter.id}`;
    await t.visit(hostPath);

    const order = page.locator('#chapter-order-dialog');
    const handles = order.locator('[data-chapter-page-reorder-handle]');
    const orderTitles = order.locator('.notes-chapter-page-title');
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**${hostPath}`, async (route) => {
      await held;
      return route.continue();
    });
    await t.openDialog(t.trigger);
    await t.title.fill('Page C');
    await t.create.click();
    await expect(t.dialog).toBeHidden();

    await t.orderTrigger.click();
    await expect(order).toBeVisible();
    await handles.first().focus();
    await page.keyboard.press('End');
    await expect(orderTitles).toHaveText(['Page B', 'Page A']);

    release();
    await expect.poll(t.mainTitles).toEqual(['Page A', 'Page B', 'Page C']);
    await expect(orderTitles).toHaveText(['Page B', 'Page A']);

    // Dismissal gives way to the newest Pages, and the next open lists them all.
    await order.locator('[data-dialog-close]').first().click();
    await expect(order).toBeHidden();
    await page.unroute(`**${hostPath}`);
    await t.orderTrigger.click();
    await expect(orderTitles).toHaveText(['Page A', 'Page B', 'Page C']);
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('direct /notes/new stays a native form that opens the created Page', async ({ page }) => {
  await withHosts(page, async (t) => {
    await page.goto(`${t.origin}/notes/new?chapterId=${t.chapter.id}`);
    await expect(t.dialog).toBeVisible();
    await t.title.fill('Native Page');
    await t.create.click();
    await expect(page).toHaveURL(/\/notes\/\d+$/);
    expect(t.saved()).toEqual(['Native Page']);
  });
});
