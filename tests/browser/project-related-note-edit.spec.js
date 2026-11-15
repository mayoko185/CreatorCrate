import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { createAssetManifest, VITE_ENTRY_KEY } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createAssetRepository } from '../../src/data/asset-repository.js';

// WP4: Edit on a Project Detail Related Notes card opens the Notes Edit Page
// dialog in place. Each Edit reads GET /notes/:id and mounts that Page's own
// dialog, so Save, Move, Delete, the editor and the unsaved-changes guard are the
// Notes ones. Project Detail is never navigated (except by Delete, which goes to
// the Page's parent with Undo, as on Page Detail), one dialog is mounted at a
// time, and an acknowledged save or move is announced for WP5. The real editor
// exists only in the built client, so these tests run against it.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

const COMMITTED = 'creatorcrate:note-edit-committed';

async function withProject(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-related-note-edit-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
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

    const { projectService, bookService, chapterService, noteService } = app.locals;
    const project = projectService.create({ title: 'Host Project', status: 'tbd' });
    const other = projectService.create({ title: 'Other Project', status: 'tbd' });
    const book = bookService.createBook({ title: 'Lore' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'First Chapter' });
    const otherChapter = chapterService.createChapter({ bookId: book.id, title: 'Second Chapter' });
    const alpha = noteService.createNote({ chapterId: chapter.id, title: 'Alpha Page', content: 'Alpha body', projectIds: [project.id] });
    const beta = noteService.createNote({ chapterId: chapter.id, title: 'Beta Page', content: 'Beta body', projectIds: [project.id] });
    const art = createAssetRepository(db).upsert(project.id, 'art/cover.png', {
      filename: 'cover.png', extension: 'png', mimeType: 'image/png', sizeBytes: 4096, modifiedAt: '2026-08-06 12:00:00',
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const hostPath = `/projects/${project.id}`;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const log = { navigations: [], posts: [], gets: [], refreshes: [], projectPosts: [] };
    let visited = false;
    page.on('framenavigated', (frame) => {
      if (visited && frame === page.mainFrame()) log.navigations.push(frame.url());
    });
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === hostPath && request.resourceType() === 'fetch') log.refreshes.push(request.method());
      if (pathname.startsWith(`${hostPath}/`) && request.method() === 'POST') log.projectPosts.push(pathname);
      if (!/^\/notes\/\d+$/.test(pathname)) return;
      if (request.method() === 'POST') log.posts.push(request);
      if (request.method() === 'GET' && request.resourceType() === 'fetch') log.gets.push(pathname);
    });

    const dialog = page.locator('#note-edit-dialog');
    const t = {
      app, db, origin, project, other, book, chapter, otherChapter, alpha, beta, art, noteService, log, dialog, hostPath,
      editor: dialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]'),
      title: dialog.locator('[name="title"]'),
      save: dialog.getByRole('button', { name: 'Save', exact: true }),
      close: dialog.getByRole('button', { name: 'Close Edit Page' }),
      summary: dialog.locator('[data-dialog-error]'),
      confirmation: page.locator('#app-confirmation-dialog'),
      feedback: page.locator('[data-dialog-feedback]'),
      edit: (note) => page.locator(`[data-project-related-note-edit="${note.id}"]`),
      card: (note) => page.locator(`[data-project-related-note="${note.id}"]`),
      projectInput: (id) => dialog.locator(`#note-projects-form input[value="${id}"]`),
      assetInput: (id) => dialog.locator(`#note-assets-form input[value="${id}"]`),
      region: page.locator('[data-project-related-notes-region]'),
      section: page.locator('[data-project-related-notes]'),
      noteTitle: (note) => page.locator(`[data-project-related-note="${note.id}"] .project-related-note-title`),
      disclosure: (note) => page.locator(`[data-project-related-note-disclosure="${note.id}"]`),
      pin: (note) => page.locator(`[data-project-related-note-pin="${note.id}"]`),
      refreshNote: page.locator('[data-project-related-notes-refresh-note]'),
      retry: page.locator('[data-project-related-notes-refresh-retry]'),
      markdown: () => dialog.locator('#note-form').evaluate((form) => form.__creatorCrateNotesEditor.getMarkdown()),
      saved: (note) => noteService.getNote(note.id),
      committed: () => page.evaluate(() => window.__committed),
      visit: async () => {
        visited = false;
        await page.goto(origin + hostPath);
        await expect(page.locator('[data-project-related-note-editor][data-project-related-note-editor-bound="true"]')).toBeAttached();
        log.navigations.length = 0;
        visited = true;
        await page.evaluate((type) => {
          window.__projectDetailDocument = true;
          window.__committed = [];
          document.addEventListener(type, (event) => {
            window.__committed.push({
              kind: event.detail.kind,
              noteId: event.detail.noteId,
              dialogOpen: event.target.open,
              title: event.detail.payload?.values?.title ?? null,
            });
          });
        }, COMMITTED);
      },
      kept: async () => {
        expect(log.navigations).toEqual([]);
        expect(await page.evaluate(() => window.__projectDetailDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(hostPath);
      },
      open: async (note) => {
        await t.edit(note).click();
        await expect(dialog).toBeVisible();
        await expect(t.editor).toBeVisible();
        await expect(dialog.locator('#note-form')).toHaveAttribute('action', `/notes/${note.id}`);
      },
      type: async (text) => {
        await t.editor.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(text);
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

// Holds the next matching request until release() says how to answer it.
async function hold(page, pathname, method) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  let held = false;
  await page.route((url) => url.pathname === pathname, async (route) => {
    if (route.request().method() !== method || held) {
      await route.fallback();
      return;
    }
    held = true;
    reached();
    await (await released)(route);
  });
  return { arrived, release: (answer = (route) => route.fallback()) => release(answer) };
}

test('Edit opens the Page’s own dialog in place, fully enhanced, one at a time, for each note', async ({ page }) => {
  // Net document click/mousedown listeners: the editor's own come and go with it.
  // Net document pointerup/pointercancel listeners: the dialog's backdrop
  // tracking holds them only during a press, so replaced dialogs leave none.
  await page.addInitScript(() => {
    window.__documentListeners = 0;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const types = new Set(['click', 'mousedown', 'pointerup', 'pointercancel']);
    const counted = (target, type) => target === document && types.has(type);
    EventTarget.prototype.addEventListener = function patchedAdd(type, ...rest) {
      if (counted(this, type)) window.__documentListeners += 1;
      return add.call(this, type, ...rest);
    };
    EventTarget.prototype.removeEventListener = function patchedRemove(type, ...rest) {
      if (counted(this, type)) window.__documentListeners -= 1;
      return remove.call(this, type, ...rest);
    };
  });
  await withProject(page, async (t) => {
    await t.visit();
    await expect(t.dialog).toHaveCount(0);
    await expect(t.edit(t.alpha)).toHaveAttribute('type', 'button');
    await expect(t.edit(t.alpha)).toHaveAccessibleName('Edit Alpha Page');

    // Keyboard: the control is a native button.
    await t.edit(t.alpha).focus();
    await page.keyboard.press('Enter');
    await expect(t.dialog).toBeVisible();
    await expect(t.editor).toBeVisible();
    await t.kept();
    expect(await t.dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
    await expect(t.dialog).toHaveAccessibleName('Edit Page');
    expect(await t.dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await expect(t.title).toHaveValue('Alpha Page');
    await expect(t.editor).toContainText('Alpha body');
    await expect(t.projectInput(t.project.id)).toBeChecked();
    expect(t.log.gets).toEqual([`/notes/${t.alpha.id}`]);

    // The same enhancers bound it as on Page Detail.
    const bound = () => t.dialog.evaluate((node) => [...new Set([node, ...node.querySelectorAll('*')]
      .flatMap((element) => Object.keys(element.dataset).filter((key) => key.endsWith('Bound'))))].sort());
    const projectBound = await bound();
    const listeners = () => page.evaluate(() => window.__documentListeners);
    const withOneEditor = await listeners();
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.edit(t.alpha)).toBeFocused();

    // A change made elsewhere is what the next Edit shows.
    t.noteService.updateNote(t.beta.id, { title: 'Beta Renamed', content: 'Beta changed', projectIds: [t.project.id] });
    await t.open(t.beta);
    await expect(t.title).toHaveValue('Beta Renamed');
    await expect(t.editor).toContainText('Beta changed');
    await expect(page.locator('[data-app-dialog]#note-edit-dialog')).toHaveCount(1);
    await expect(page.locator('#note-form')).toHaveCount(1);
    await expect(page.locator('[data-notes-editor-host] .toastui-editor-defaultUI')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    await expect(t.edit(t.beta)).toBeFocused();

    // Back to Alpha: nothing of Beta's carries over, and reopening works again.
    await t.open(t.alpha);
    await expect(t.title).toHaveValue('Alpha Page');
    await expect(t.editor).not.toContainText('Beta');
    await t.close.click();
    await t.open(t.alpha);
    await expect(t.title).toHaveValue('Alpha Page');
    // A replaced dialog still dismisses from a genuine backdrop press, once.
    const frame = await t.dialog.boundingBox();
    await page.mouse.click(Math.max(2, frame.x / 2), Math.max(2, frame.y / 2));
    await expect(t.dialog).toBeHidden();
    await expect(t.edit(t.alpha)).toBeFocused();
    expect(await t.confirmation.evaluate((node) => node.open)).toBe(false);
    expect(t.log.gets).toEqual([`/notes/${t.alpha.id}`, `/notes/${t.beta.id}`, `/notes/${t.alpha.id}`, `/notes/${t.alpha.id}`]);
    await t.kept();
    // Each replaced editor released its document listeners once its last toolbar update ran.
    await expect.poll(listeners, { timeout: 5000 }).toBe(withOneEditor);

    await page.goto(`${t.origin}/notes/${t.alpha.id}`);
    await page.locator('.page-heading [data-dialog-open="note-edit-dialog"]').click();
    await expect(t.editor).toBeVisible();
    expect(await bound()).toEqual(projectBound);
  });
});

test('Save uses the Notes save once, reaches the server, and announces only a confirmed save', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const documentTitle = await page.title();
    await t.open(t.alpha);
    await t.title.fill('Alpha Edited');
    await t.editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Plain then ');
    await t.dialog.locator('.toastui-editor-toolbar-icons.bold').click();
    await page.keyboard.type('bold words');
    await t.dialog.locator('#note-projects-form summary').click();
    await t.projectInput(t.other.id).check();
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeVisible();

    // A refusal keeps the draft, says why, and announces nothing.
    await t.title.fill('');
    await t.save.click();
    await expect(t.dialog.locator('#note-edit-title-error')).toHaveText('Title is required.');
    await expect(t.title).toBeFocused();
    await expect(t.editor.locator('strong')).toHaveText('bold words');
    await expect(t.projectInput(t.other.id)).toBeChecked();
    expect(await t.committed()).toEqual([]);

    // A lost answer is unconfirmed: the draft stays, nothing is announced or resent.
    await t.title.fill('Alpha Edited');
    await page.route(`**/notes/${t.alpha.id}`, (route) => (route.request().method() === 'POST'
      ? route.abort('connectionreset') : route.fallback()), { times: 1 });
    await t.save.click();
    await expect(t.summary).toContainText('Could not confirm whether the Page was saved. Your draft is kept here');
    await expect(t.dialog).toBeVisible();
    await expect(t.title).toHaveValue('Alpha Edited');
    expect(await t.committed()).toEqual([]);
    expect(t.saved(t.alpha).title).toBe('Alpha Page');

    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page “Alpha Edited” saved.');
    await expect(t.edit(t.alpha)).toBeFocused();
    expect(t.log.posts).toHaveLength(3);
    expect(t.log.posts[2].postData()).toContain('Plain+then+**bold+words**');
    expect(t.saved(t.alpha)).toMatchObject({
      title: 'Alpha Edited', content: 'Plain then **bold words**', projectIds: [t.project.id, t.other.id],
    });
    expect(await t.committed()).toEqual([
      { kind: 'saved', noteId: String(t.alpha.id), dialogOpen: false, title: 'Alpha Edited' },
    ]);
    // The Notes Page host code leaves Project Detail's title; WP5 refreshes the cards.
    await expect(page).toHaveTitle(documentTitle);
    await expect(t.card(t.alpha).locator('.project-related-note-title')).toHaveText('Alpha Edited');
    await expect(page.locator('[data-chapter-refresh-note]')).toHaveCount(0);
    await t.kept();

    // Reopened: the saved values, with nothing unsaved to ask about.
    await t.open(t.alpha);
    await expect(t.title).toHaveValue('Alpha Edited');
    await expect(t.editor.locator('strong')).toHaveText('bold words');
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();
    expect(t.log.posts).toHaveLength(3);
  });
});

test('Markdown mode content reaches the server', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await t.open(t.beta);
    await t.dialog.locator('.toastui-editor-mode-switch .tab-item', { hasText: 'Markdown' }).click();
    const source = t.dialog.locator('.toastui-editor-md-container .ProseMirror[contenteditable="true"]');
    await source.fill('# Fresh heading\n\n- one');
    expect(await t.markdown()).toBe('# Fresh heading\n\n- one');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved(t.beta).content).toBe('# Fresh heading\n\n- one');
    await t.kept();
  });
});

test('the unsaved-changes guard and a pending save keep the dialog, and its draft', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await t.open(t.alpha);
    await t.type(' draft');

    // As on Page Detail, Escape from a field (the editor surface keeps its own).
    await t.title.focus();
    await page.keyboard.press('Escape');
    await expect(t.confirmation).toBeVisible();
    await t.confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(t.dialog).toBeVisible();
    await expect(t.editor).toContainText('Alpha body draft');

    const post = await hold(page, `/notes/${t.alpha.id}`, 'POST');
    await t.save.click();
    await post.arrived;
    await page.keyboard.press('Escape');
    await t.close.click({ force: true });
    await expect(t.dialog).toBeVisible();
    await expect(t.confirmation).toBeHidden();
    // Nothing behind the modal dialog can start another Edit.
    expect(await t.edit(t.beta).evaluate((node) => document.elementFromPoint(
      node.getBoundingClientRect().x + 2, node.getBoundingClientRect().y + 2,
    ) === node)).toBe(false);
    post.release();
    await expect(t.dialog).toBeHidden();
    expect(t.saved(t.alpha).content).toBe('Alpha body draft');

    // Discard restores the saved values for the next open.
    await t.open(t.alpha);
    await t.type(' throwaway');
    await t.close.click();
    await t.confirmation.getByRole('button', { name: 'Discard' }).click();
    await expect(t.dialog).toBeHidden();
    await expect(t.edit(t.alpha)).toBeFocused();
    await t.open(t.alpha);
    await expect(t.editor).toContainText('Alpha body draft');
    await expect(t.editor).not.toContainText('throwaway');
    expect(t.log.posts).toHaveLength(1);
  });
});

test('rapid Edits install only the newest note, and a load that lost its card or turn mounts nothing', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    // Alpha's answer comes after Beta's.
    const alphaGet = await hold(page, `/notes/${t.alpha.id}`, 'GET');
    await t.edit(t.alpha).click();
    await alphaGet.arrived;
    await expect(t.edit(t.alpha)).toHaveAttribute('aria-busy', 'true');
    await t.edit(t.beta).click();
    await expect(t.dialog).toBeVisible();
    await expect(t.title).toHaveValue('Beta Page');
    await expect(t.edit(t.alpha)).not.toHaveAttribute('aria-busy', 'true');
    alphaGet.release((route) => route.fallback().catch(() => {}));
    await page.waitForTimeout(300);
    await expect(t.title).toHaveValue('Beta Page');
    await expect(page.locator('#note-edit-dialog')).toHaveCount(1);
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await page.unrouteAll({ behavior: 'wait' });

    // Pressing the same Edit twice reads once.
    t.log.gets.length = 0;
    await t.edit(t.alpha).dblclick();
    await expect(t.dialog).toBeVisible();
    await expect(t.title).toHaveValue('Alpha Page');
    expect(t.log.gets).toEqual([`/notes/${t.alpha.id}`]);
    await t.close.click();

    // The card goes away while its editor loads.
    const gone = await hold(page, `/notes/${t.beta.id}`, 'GET');
    await t.edit(t.beta).click();
    await gone.arrived;
    await t.card(t.beta).evaluate((card) => card.closest('li').remove());
    gone.release((route) => route.fallback().catch(() => {}));
    await page.waitForTimeout(300);
    await expect(t.dialog).toBeHidden();
    await expect(page.locator('#note-form')).toHaveAttribute('action', `/notes/${t.alpha.id}`);
    await t.kept();
  });
});

test('a failed load leaves Project Detail usable with a message, and Edit can try again', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const path = `**/notes/${t.alpha.id}`;
    const failures = [
      (route) => route.abort('failed'),
      (route) => route.fulfill({ status: 500, contentType: 'text/html', body: '<html><body>Error</body></html>' }),
      (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
      // A page without this Page's dialog (a sign-in page, say).
      (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><dialog id="note-edit-dialog" data-app-dialog><form id="note-form" action="/notes/999"></form></dialog>' }),
    ];
    for (const failure of failures) {
      await page.route(path, failure, { times: 1 });
      await t.edit(t.alpha).click();
      await expect(t.feedback).toContainText('The Page editor could not be opened. Try again.');
      await expect(t.feedback).toHaveClass(/notice--error/);
      await expect(t.feedback).toHaveAttribute('role', 'status');
      await expect(page.locator('#note-edit-dialog')).toHaveCount(0);
      await expect(t.edit(t.alpha)).not.toHaveAttribute('aria-busy', 'true');
      await expect(t.edit(t.alpha)).toBeFocused();
    }
    // Pin and disclosure still work.
    await t.card(t.alpha).locator('[data-project-related-note-disclosure]').click();
    await expect(t.card(t.alpha).locator('[data-project-related-note-preview]')).toBeVisible();
    await t.card(t.alpha).locator('[data-project-related-note-pin]').click();
    await expect(t.card(t.alpha).locator('[data-project-related-note-pin]')).toHaveAttribute('aria-pressed', 'true');

    await t.open(t.alpha);
    await t.close.click();

    // A Page deleted elsewhere is reported as gone.
    t.noteService.deleteNote(t.beta.id);
    await t.edit(t.beta).click();
    await expect(t.feedback).toContainText('This Page is no longer available.');
    await expect(page.locator('#note-edit-dialog')).toHaveAttribute('aria-labelledby', 'note-edit-dialog-title');
    await expect(page.locator('#note-form')).toHaveAttribute('action', `/notes/${t.alpha.id}`);
    await t.kept();
  });
});

test('Move stays on Project Detail and is announced; Delete goes to the parent with Undo', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await t.open(t.alpha);
    await t.type(' draft');
    await t.dialog.locator('#note-move-target').evaluate((select, value) => { select.value = value; }, `chapter:${t.otherChapter.id}`);
    await t.dialog.locator('summary', { hasText: 'Move Page' }).click();
    await t.dialog.locator('button[form="note-move-form"]').click();
    const notice = t.dialog.locator('[data-dialog-move-notice]');
    await expect(notice).toContainText('Your unsaved edits are still here.');
    await expect(t.dialog).toBeVisible();
    expect(t.saved(t.alpha)).toMatchObject({ chapter_id: t.otherChapter.id, content: 'Alpha body' });
    expect(await t.committed()).toEqual([
      { kind: 'moved', noteId: String(t.alpha.id), dialogOpen: true, title: null },
    ]);
    // The read after the move adopted its saved location without any Notes Page markup.
    await expect(page.locator('[data-chapter-refresh-note]')).toHaveCount(0);
    await expect(t.dialog.locator('#note-move-target')).toHaveValue(`chapter:${t.otherChapter.id}`);
    await expect(t.editor).toContainText('Alpha body draft');
    await t.kept();

    // The draft is still guarded, and Save lands on the moved Page.
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved(t.alpha)).toMatchObject({ chapter_id: t.otherChapter.id, content: 'Alpha body draft' });
    await t.kept();

    // Delete keeps its confirmation, then leaves for the Page's parent with Undo.
    await t.open(t.beta);
    await t.dialog.locator('summary', { hasText: 'Delete Page' }).click();
    const remove = t.dialog.locator('button[form="note-delete-form"]');
    await remove.click();
    await expect(t.confirmation).toContainText('Delete Page?');
    await t.confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(t.dialog).toBeVisible();
    expect(t.saved(t.beta)).toBeTruthy();
    await remove.click();
    await t.confirmation.getByRole('button', { name: 'Delete Page' }).click();
    await expect(page).toHaveURL(new RegExp(`/notes/chapters/${t.chapter.id}$`));
    await expect(page.locator('[data-page-deletion-undo-alert]')).toContainText('Page “Beta Page” deleted.');
  });
});

// WP4-F2 (P2): a press tracked on the dialog adds document pointerup/pointercancel
// listeners. A dialog closed (Escape) while the press is held must drop them at
// closure, so a press released later and the dialog's replacement leave none.
test('a dialog closed mid-press retains no document pointer listeners, and backdrop dismissal still works', async ({ page }) => {
  await page.addInitScript(() => {
    window.__pointerListeners = 0;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const counted = (target, type) => target === document && (type === 'pointerup' || type === 'pointercancel');
    EventTarget.prototype.addEventListener = function patchedAdd(type, ...rest) {
      if (counted(this, type)) window.__pointerListeners += 1;
      return add.call(this, type, ...rest);
    };
    EventTarget.prototype.removeEventListener = function patchedRemove(type, ...rest) {
      if (counted(this, type)) window.__pointerListeners -= 1;
      return remove.call(this, type, ...rest);
    };
  });
  await withProject(page, async (t) => {
    await t.visit();
    const listeners = () => page.evaluate(() => window.__pointerListeners);
    const before = await listeners();

    // Press inside, Escape closes, release afterwards, then the next Edit replaces it.
    for (const note of [t.alpha, t.beta, t.alpha]) {
      await t.open(note);
      const field = await t.title.boundingBox();
      await page.mouse.move(field.x + 5, field.y + 5);
      await page.mouse.down();
      expect(await listeners()).toBe(before + 2);
      await page.keyboard.press('Escape');
      await expect(t.dialog).toBeHidden();
      expect(await listeners()).toBe(before);
      await page.mouse.up();
      expect(await listeners()).toBe(before);
    }
    await t.open(t.beta);
    await expect(page.locator('#note-edit-dialog')).toHaveCount(1);
    expect(await listeners()).toBe(before);

    // A cancelled press drops them and dismisses nothing.
    await t.dialog.evaluate((dialog) => {
      dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
    });
    expect(await listeners()).toBe(before + 2);
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 7 })));
    expect(await listeners()).toBe(before);
    await t.dialog.evaluate((dialog) => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await expect(t.dialog).toBeVisible();

    // Another pointer's release leaves the tracked press alone.
    await t.dialog.evaluate((dialog) => {
      dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
    });
    expect(await listeners()).toBe(before + 2);
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8 })));
    expect(await listeners()).toBe(before);

    // A genuine backdrop press still dismisses, and leaves nothing behind.
    const frame = await t.dialog.boundingBox();
    await page.mouse.click(Math.max(2, frame.x / 2), Math.max(2, frame.y / 2));
    await expect(t.dialog).toBeHidden();
    await expect(t.edit(t.beta)).toBeFocused();
    expect(await listeners()).toBe(before);
    await t.kept();
  });
});

// WP4-F2 (P3): Alpha's post-save read answers after Beta's dialog replaced it.
// The detached dialog is still a Project Detail editor: its answer adopts only
// its own state, reports no failure, and leaves Beta and the page alone.
test('a saved Page’s late read after its dialog was replaced reports nothing and touches nothing else', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const heading = await page.locator('h1').first().textContent();
    const documentTitle = await page.title();
    await t.open(t.alpha);
    await t.title.fill('Alpha Edited');
    const read = await hold(page, `/notes/${t.alpha.id}`, 'GET');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await read.arrived;
    await expect(t.feedback).toContainText('Page “Alpha Edited” saved.');

    await t.open(t.beta);
    await t.title.fill('Beta Draft');
    let answered;
    const status = new Promise((resolve) => { answered = resolve; });
    read.release(async (route) => {
      const response = await route.fetch();
      answered(response.status());
      await route.fulfill({ response });
    });
    expect(await status).toBe(200);
    await page.waitForTimeout(300);

    await expect(t.feedback).not.toContainText('could not be read again');
    await expect(page.locator('[data-chapter-refresh-note]')).toHaveCount(0);
    await expect(page.locator('[data-chapter-refresh-retry]')).toHaveCount(0);
    await expect(t.dialog).toBeVisible();
    await expect(page.locator('#note-form')).toHaveAttribute('action', `/notes/${t.beta.id}`);
    await expect(t.title).toHaveValue('Beta Draft');
    await t.type(' still editable');
    expect(await t.markdown()).toContain('still editable');
    expect(await page.locator('h1').first().textContent()).toBe(heading);
    await expect(page).toHaveTitle(documentTitle);
    expect(await t.committed()).toEqual([
      { kind: 'saved', noteId: String(t.alpha.id), dialogOpen: false, title: 'Alpha Edited' },
    ]);
    expect(t.saved(t.alpha).title).toBe('Alpha Edited');
    await t.kept();
  });
});

test('a current Project Detail editor’s failed read after a save still reports it, with Retry', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await t.open(t.alpha);
    await t.title.fill('Alpha Edited');
    let failed = false;
    await page.route(`**/notes/${t.alpha.id}`, (route) => {
      if (route.request().method() !== 'GET' || failed) return route.fallback();
      failed = true;
      return route.fulfill({ status: 500, contentType: 'text/html', body: 'Error' });
    });
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('The Page was saved, but its saved version could not be read again.');
    const retry = page.locator('[data-chapter-refresh-retry]');
    await expect(retry).toHaveCount(1);
    await retry.click();
    await expect(page.locator('[data-chapter-refresh-note]')).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    expect(await t.committed()).toEqual([
      { kind: 'saved', noteId: String(t.alpha.id), dialogOpen: false, title: 'Alpha Edited' },
    ]);
    await t.open(t.alpha);
    await expect(t.title).toHaveValue('Alpha Edited');
    await t.kept();
  });
});

// ─── WP5: Related Notes refresh in place ───────────────────────────────────
// A confirmed save or Move (the commit event above) runs the Project Detail
// refresh (one GET of the page), whose "related-notes" region replaces the
// cards. Expansion is kept for surviving notes, pins are only read, a failed
// refresh keeps the cards with a GET-only Retry, and older answers never win.

// Assets are offered for the selected projects; a saved asset whose project is
// dropped stays as a retained asset.
async function setAssociations(t, page, { project, asset }) {
  if (asset !== undefined) {
    const offered = t.dialog.locator('#note-assets-form summary');
    if (await offered.isVisible()) {
      await offered.click();
      await t.assetInput(t.art.id).setChecked(asset);
      await page.keyboard.press('Escape');
    } else {
      await t.dialog.locator(`[data-note-retained-options] input[value="${t.art.id}"]`).setChecked(asset);
    }
  }
  if (project !== undefined) {
    await t.dialog.locator('#note-projects-form summary').click();
    await t.projectInput(t.project.id).setChecked(project);
    await page.keyboard.press('Escape');
  }
  await expect(t.dialog).toBeVisible();
}

test('a confirmed save refreshes Related Notes in place with one GET, keeping scroll and focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await withProject(page, async (t) => {
    await t.visit();
    await t.edit(t.alpha).scrollIntoViewIfNeeded();
    const before = await t.card(t.alpha).elementHandle();
    await t.open(t.alpha);
    await t.title.fill('Alpha Renamed');
    await t.editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Fresh preview words');
    // The refresh waits until the save's own notice is on show, so what the
    // refresh does to scroll is measured alone.
    const refresh = await hold(page, t.hostPath, 'GET');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await refresh.arrived;
    await expect(t.feedback).toContainText('Page “Alpha Renamed” saved.');
    await page.evaluate(() => window.scrollBy(0, 40));
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);
    refresh.release();

    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Renamed');
    await expect(t.edit(t.alpha)).toHaveAccessibleName('Edit Alpha Renamed');
    await expect(t.edit(t.alpha)).toBeFocused();
    expect(await before.evaluate((card) => card.isConnected)).toBe(false);
    expect(Math.abs(await page.evaluate(() => window.scrollY) - scrollY)).toBeLessThanOrEqual(2);
    await t.disclosure(t.alpha).click();
    await expect(page.locator(`[data-project-related-note-preview="${t.alpha.id}"]`)).toContainText('Fresh preview words');
    await expect(t.feedback).toContainText('Page “Alpha Renamed” saved.');
    await expect(t.refreshNote).toHaveCount(0);
    await expect(t.section).toHaveCount(1);
    await expect(page.locator('[data-project-related-note]')).toHaveCount(2);
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET']);
    await t.kept();
  });
});

test('association changes reconcile membership; the last note leaves the empty section; a Project Edit refresh repopulates', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();

    // Beta loses its only association: its card goes, focus to the section heading.
    await t.open(t.beta);
    await setAssociations(t, page, { project: false });
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.card(t.beta)).toHaveCount(0);
    await expect(page.locator('[data-project-related-note]')).toHaveCount(1);
    await expect(page.locator('#project-related-notes-heading')).toBeFocused();

    // Alpha gains one of the project's assets, then drops its project link.
    await t.open(t.alpha);
    await setAssociations(t, page, { asset: true });
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    // WP6.1: no association badges; the linked asset preview shows membership.
    await expect(t.card(t.alpha).locator('[data-project-related-note-association]')).toHaveCount(0);
    await expect(t.card(t.alpha).locator(`[data-project-related-note-asset="${t.art.id}"]`)).toHaveCount(1);
    await t.open(t.alpha);
    await setAssociations(t, page, { project: false });
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.card(t.alpha).locator('[data-project-related-note-association]')).toHaveCount(0);
    await expect(t.card(t.alpha).locator(`[data-project-related-note-asset="${t.art.id}"]`)).toHaveCount(1);
    await expect(page.locator('[data-project-related-note]')).toHaveCount(1);
    await expect(t.edit(t.alpha)).toBeFocused();

    // The last qualifying note goes (WP6.5): the section stays, with its
    // heading, Create new note and empty state; focus goes to its heading.
    await t.open(t.alpha);
    await setAssociations(t, page, { asset: false });
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.section).toHaveCount(1);
    await expect(t.region).toHaveCount(1);
    await expect(page.locator('[data-project-related-note]')).toHaveCount(0);
    await expect(t.section.locator('#project-related-notes-heading')).toHaveText('Related Notes');
    await expect(t.section.locator('[data-project-related-notes-empty]')).toHaveText('No related notes yet.');
    await expect(t.section.getByRole('button', { name: 'Create new note' })).toBeVisible();
    await expect(page.locator('.project-detail-releases h2')).toHaveText('Releases');
    await expect(page.locator('#project-related-notes-heading')).toBeFocused();
    expect(t.log.posts).toHaveLength(4);

    // Empty -> populated through the existing Project Edit refresh, together
    // with the project regions it already replaces (one GET).
    t.noteService.updateNote(t.beta.id, { title: 'Beta Back', content: 'Beta body', projectIds: [t.project.id] });
    await page.locator('.project-detail-action-toolbar [data-project-edit-id]').click();
    const projectDialog = page.locator('#project-edit-dialog');
    await expect(projectDialog.locator('button[data-dialog-submit]')).toBeEnabled();
    await projectDialog.locator('#title').fill('Host Project Renamed');
    expect(t.log.refreshes).toHaveLength(4);
    const opened = t.log.refreshes.length;
    await projectDialog.locator('button[data-dialog-submit]').click();
    await expect(projectDialog).toBeHidden();
    await expect(t.feedback).toHaveText('Project updated.');
    await expect(page.locator('.app-section-title')).toContainText('Host Project Renamed');
    await expect(t.section).toHaveCount(1);
    await expect(t.section.locator('[data-project-related-notes-empty]')).toHaveCount(0);
    await expect(page.locator('#project-related-notes-heading')).toHaveCount(1);
    await expect(t.noteTitle(t.beta)).toHaveText('Beta Back');
    await expect(t.card(t.beta)).toHaveAttribute('data-project-related-note-bound', 'true');
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'false');
    await t.disclosure(t.beta).click();
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.region).toHaveCount(1);
    // Four note refreshes, then the Project Edit save and its one refresh.
    expect(t.log.refreshes.slice(opened)).toEqual(['POST', 'GET']);
    await t.kept();
  });
});

test('a refresh keeps manual expansion and pins, and new notes start from their own pin', async ({ page }) => {
  await withProject(page, async (t) => {
    const key = (note) => `creatorcrate:related-notes:v1:note:${note.id}`;
    const gamma = t.noteService.createNote({ chapterId: t.chapter.id, title: 'Gamma Page', content: 'Gamma body' });
    const delta = t.noteService.createNote({
      chapterId: t.chapter.id,
      title: 'Delta Page',
      content: ['Delta body', ...Array.from({ length: 25 }, (_, i) => `Delta paragraph ${i}`), '```\ncopy me\n```', 'Delta final line.'].join('\n\n'),
    });
    await t.visit();
    await page.evaluate(([alpha, gammaKey]) => {
      localStorage.setItem(alpha, '1');
      localStorage.setItem(gammaKey, '1');
    }, [key(t.alpha), key(gamma)]);
    await t.visit();
    await expect(t.disclosure(t.alpha)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'false');
    // Pinned Alpha collapsed by hand; unpinned Beta expanded by hand.
    await t.disclosure(t.alpha).click();
    await t.disclosure(t.beta).click();

    // Gamma (pinned) and Delta (unpinned) join while Beta is edited.
    for (const note of [gamma, delta]) {
      t.noteService.updateNote(note.id, { title: note.title, content: note.content, projectIds: [t.project.id] });
    }
    await t.open(t.beta);
    await t.title.fill('Beta Edited');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.noteTitle(t.beta)).toHaveText('Beta Edited');

    await expect(t.disclosure(t.alpha)).toHaveAttribute('aria-expanded', 'false');
    await expect(t.pin(t.alpha)).toHaveAttribute('aria-pressed', 'true');
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.pin(t.beta)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(`[data-project-related-note-preview="${t.beta.id}"]`)).toBeVisible();
    await expect(t.disclosure(gamma)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.disclosure(delta)).toHaveAttribute('aria-expanded', 'false');
    // WP6.1: refreshed cards keep the corrected presentation: the visible
    // Show/Hide note text follows each card's restored expansion, the icon
    // controls keep their names and tooltips, and the whole Page is there
    // with its code block enhanced.
    const label = (note) => t.disclosure(note).locator('[data-project-related-note-disclosure-label]');
    await expect(label(t.alpha)).toHaveText('Show note');
    await expect(label(t.beta)).toHaveText('Hide note');
    await expect(label(gamma)).toHaveText('Hide note');
    await expect(label(delta)).toHaveText('Show note');
    await expect(t.pin(gamma)).toHaveAttribute('data-tooltip', 'Unpin note');
    await expect(t.pin(gamma)).toHaveAccessibleName('Unpin Gamma Page');
    await expect(t.edit(t.beta)).toHaveAccessibleName('Edit Beta Edited');
    await expect(t.edit(t.beta)).toHaveAttribute('data-tooltip', 'Edit note');
    await expect(page.locator('[data-project-related-note-association]')).toHaveCount(0);
    const deltaPreview = page.locator(`[data-project-related-note-preview="${delta.id}"]`);
    await expect(deltaPreview.locator('p').filter({ hasText: 'Delta final line.' })).toHaveCount(1);
    await expect(deltaPreview.locator('pre.notes-code-block-enhanced .notes-code-copy')).toHaveCount(1);
    expect(await page.evaluate((keys) => keys.map((k) => localStorage.getItem(k)),
      [key(t.alpha), key(t.beta), key(gamma), key(delta)])).toEqual(['1', null, '1', null]);

    // Each replaced card is bound once: one click toggles once, Pin still works.
    await t.disclosure(t.beta).click();
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'false');
    await expect(label(t.beta)).toHaveText('Show note');
    await t.disclosure(t.beta).click();
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'true');
    await expect(label(t.beta)).toHaveText('Hide note');
    await t.pin(delta).click();
    await expect(t.pin(delta)).toHaveAttribute('aria-pressed', 'true');
    await expect(t.disclosure(delta)).toHaveAttribute('aria-expanded', 'true');
    await expect(label(delta)).toHaveText('Hide note');
    await expect(deltaPreview).toBeVisible();
    await expect(deltaPreview.locator('pre .notes-code-copy')).toHaveCount(1);
    expect(await page.evaluate((k) => localStorage.getItem(k), key(delta))).toBe('1');
    await expect(page.locator('[data-project-related-note]')).toHaveCount(4);
    await expect(page.locator('[data-project-related-note]:not([data-project-related-note-bound="true"])')).toHaveCount(0);
  });
});

test('a failed refresh after a save says the Page was saved, keeps the cards, and Retry only reads', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    let failNext = true;
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (failNext && route.request().method() === 'GET' && route.request().resourceType() === 'fetch') {
        failNext = false;
        await route.fulfill({ status: 500, contentType: 'text/html', body: '<p>broken</p>' });
        return;
      }
      await route.fallback();
    });
    await t.open(t.alpha);
    await t.title.fill('Alpha Saved');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page “Alpha Saved” saved.');
    await expect(t.refreshNote).toHaveText('Related Notes could not be updated, so they may be out of date.');
    await expect(t.retry).toHaveText('Retry refresh');
    await expect(t.feedback).not.toContainText(/not saved|could not be saved/i);
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Page');
    expect(t.saved(t.alpha).title).toBe('Alpha Saved');

    // A page whose Notes read failed is not a refresh either: the cards stay.
    const service = t.noteService;
    const read = service.listRelatedNotesForProject;
    service.listRelatedNotesForProject = () => { throw new Error('SQLITE_BUSY'); };
    await t.retry.click();
    await expect.poll(() => t.log.refreshes.length).toBe(2);
    await expect(t.retry).toBeVisible();
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Page');
    await expect(page.locator('[data-project-related-notes-error]')).toHaveCount(0);
    service.listRelatedNotesForProject = read;

    // Retry from the keyboard recovers, and focus goes to the saved note's Edit.
    await t.retry.focus();
    await page.keyboard.press('Enter');
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Saved');
    await expect(t.refreshNote).toHaveCount(0);
    await expect(t.retry).toHaveCount(0);
    await expect(t.edit(t.alpha)).toBeFocused();
    await expect(t.feedback).toContainText('Page “Alpha Saved” saved.');
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET', 'GET', 'GET']);

    // The editor still works afterwards.
    await t.open(t.alpha);
    await expect(t.title).toHaveValue('Alpha Saved');
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await t.kept();
  });
});

test('an older refresh answering late never overwrites a newer one, and an Edit during a refresh opens the same note', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const staleHtml = await (await page.request.get(t.origin + t.hostPath)).text();

    // Two confirmed saves close together; the first refresh answers last, stale.
    const first = await hold(page, t.hostPath, 'GET');
    await t.open(t.alpha);
    await t.title.fill('Alpha One');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await first.arrived;
    await t.open(t.beta);
    await t.title.fill('Beta Two');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.noteTitle(t.beta)).toHaveText('Beta Two');
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha One');
    first.release((route) => route.fulfill({ status: 200, contentType: 'text/html', body: staleHtml }).catch(() => {}));
    await page.waitForTimeout(300);
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha One');
    await expect(t.noteTitle(t.beta)).toHaveText('Beta Two');
    await expect(page.locator('[data-project-related-note]')).toHaveCount(2);
    await expect(t.refreshNote).toHaveCount(0);

    // Edit pressed while a refresh is replacing its card still opens that note.
    const refresh = await hold(page, t.hostPath, 'GET');
    await t.open(t.beta);
    await t.title.fill('Beta Three');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await refresh.arrived;
    const load = await hold(page, `/notes/${t.alpha.id}`, 'GET');
    await t.edit(t.alpha).click();
    await load.arrived;
    refresh.release();
    await expect(t.noteTitle(t.beta)).toHaveText('Beta Three');
    load.release();
    await expect(t.dialog).toBeVisible();
    await expect(t.title).toHaveValue('Alpha One');
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.edit(t.alpha)).toBeFocused();
    await expect(t.edit(t.alpha)).not.toHaveAttribute('aria-busy', 'true');
    expect(t.log.posts).toHaveLength(3);
    await t.kept();
  });
});

test('a confirmed Move refreshes Related Notes under the open editor, and closing returns focus to the note’s Edit', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const oldEdit = await t.edit(t.alpha).elementHandle();
    await t.open(t.alpha);
    await t.dialog.locator('#note-move-target').evaluate((select, value) => { select.value = value; }, `chapter:${t.otherChapter.id}`);
    await t.dialog.locator('summary', { hasText: 'Move Page' }).click();
    await t.dialog.locator('button[form="note-move-form"]').click();
    await expect.poll(() => t.committed()).toEqual([
      { kind: 'moved', noteId: String(t.alpha.id), dialogOpen: true, title: null },
    ]);
    await expect.poll(() => t.log.refreshes).toEqual(['GET']);
    await expect.poll(() => oldEdit.evaluate((edit) => edit.isConnected)).toBe(false);
    // The open editor is untouched and keeps focus.
    await expect(t.dialog).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('note-edit-dialog').contains(document.activeElement))).toBe(true);
    await expect(page.locator('#note-edit-dialog')).toHaveCount(1);
    expect(t.saved(t.alpha).chapter_id).toBe(t.otherChapter.id);
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.edit(t.alpha)).toBeFocused();
    expect(t.log.posts).toHaveLength(0);
    await t.kept();
  });
});

// ─── Milestone 2 F2: a committed save whose answer was lost ────────────────
// The POST reaches the server and commits, but its answer never arrives. The
// Notes binder keeps its draft and unconfirmed message and reads the Page
// (GET /notes/:id). When that read installs and holds exactly the draft sent,
// the dialog announces NOTE_EDIT_RECONCILED_EVENT (never the commit event),
// and Project Detail runs its GET-only Related Notes refresh.

const RECONCILED = 'creatorcrate:note-edit-reconciled';

async function watchReconciled(page) {
  await page.evaluate((type) => {
    window.__reconciled = [];
    document.addEventListener(type, (event) => window.__reconciled.push(String(event.detail.noteId)));
  }, RECONCILED);
}

// The next POST of this Page reaches the server, which commits it, and its
// answer is then dropped before the page receives it.
async function commitThenDrop(page, note) {
  let dropped = false;
  await page.route((url) => url.pathname === `/notes/${note.id}`, async (route) => {
    if (route.request().method() !== 'POST' || dropped) return route.fallback();
    dropped = true;
    await route.fetch();
    return route.abort('connectionreset');
  });
}

async function draftReconciled(t, page) {
  await t.title.fill('Reconciled Title');
  await t.editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Reconciled body words');
}

test('F2: a committed save whose answer was lost refreshes Related Notes once its read shows the draft saved', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await watchReconciled(page);
    // Beta expanded by hand, Alpha pinned: both survive the refresh.
    await t.disclosure(t.beta).click();
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'true');
    await t.pin(t.alpha).click();
    await expect(t.pin(t.alpha)).toHaveAttribute('aria-pressed', 'true');
    const pins = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));

    await t.open(t.alpha);
    await draftReconciled(t, page);
    await commitThenDrop(page, t.alpha);
    await t.save.click();

    await expect(t.summary).toContainText('Could not confirm whether the Page was saved.');
    await expect(t.noteTitle(t.alpha)).toHaveText('Reconciled Title');
    expect(t.saved(t.alpha)).toMatchObject({ title: 'Reconciled Title', content: 'Reconciled body words' });
    await expect(t.dialog).toBeVisible();
    await expect(t.title).toHaveValue('Reconciled Title');
    // The refresh never takes focus from the open dialog.
    expect(await page.evaluate(() => document.getElementById('note-edit-dialog').contains(document.activeElement))).toBe(true);
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET']);
    expect(await t.committed()).toEqual([]);
    expect(await page.evaluate(() => window.__reconciled)).toEqual([String(t.alpha.id)]);
    await expect(t.refreshNote).toHaveCount(0);
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.pin(t.alpha)).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()))).toBe(pins);

    // The draft is the saved version now: Close asks nothing, and focus goes
    // to the refreshed card's Edit.
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();
    await expect(t.edit(t.alpha)).toBeFocused();
    await expect(page.locator(`[data-project-related-note-preview="${t.alpha.id}"]`)).toContainText('Reconciled body words');
    await page.waitForTimeout(300);
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET']);
    expect(await page.evaluate(() => window.__reconciled)).toHaveLength(1);
    expect(await page.locator('#note-edit-dialog').count()).toBe(1);
    await t.kept();
  });
});

test('F2: a refusal, an unread outcome or a draft the server does not hold refreshes nothing', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await watchReconciled(page);
    await t.open(t.alpha);

    // A refusal wrote nothing: no read, no announcement.
    await t.title.fill('');
    await t.save.click();
    await expect(t.dialog.locator('#note-edit-title-error')).toHaveText('Title is required.');

    // Committed, answer lost, and the read after it fails: still unconfirmed.
    await draftReconciled(t, page);
    let failedRead = false;
    await page.route((url) => url.pathname === `/notes/${t.alpha.id}`, (route) => {
      if (route.request().method() !== 'GET' || failedRead) return route.fallback();
      failedRead = true;
      return route.fulfill({ status: 500, contentType: 'text/html', body: 'Error' });
    });
    await commitThenDrop(page, t.alpha);
    await t.save.click();
    await expect(t.summary).toContainText('Could not confirm whether the Page was saved.');
    await expect.poll(() => failedRead).toBe(true);
    await page.waitForTimeout(300);
    expect(t.saved(t.alpha).title).toBe('Reconciled Title');
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Page');
    await expect(t.dialog).toBeVisible();
    await expect(t.title).toHaveValue('Reconciled Title');
    await expect(t.editor).toContainText('Reconciled body words');
    await expect(page.locator('[data-chapter-refresh-note]')).toHaveCount(0);
    await expect(t.refreshNote).toHaveCount(0);
    expect(t.log.refreshes).toEqual([]);
    expect(await page.evaluate(() => window.__reconciled)).toEqual([]);
    expect(await t.committed()).toEqual([]);

    // Lost before it reached the server: the read installs, but the server holds
    // something else, so nothing is announced.
    await t.title.fill('Never Saved');
    await page.route((url) => url.pathname === `/notes/${t.alpha.id}`, (route) => (route.request().method() === 'POST'
      ? route.abort('connectionreset') : route.fallback()), { times: 1 });
    const read = page.waitForResponse((response) => new URL(response.url()).pathname === `/notes/${t.alpha.id}`
      && response.request().method() === 'GET');
    await t.save.click();
    expect((await read).status()).toBe(200);
    await page.waitForTimeout(300);
    await expect(t.title).toHaveValue('Never Saved');
    expect(t.saved(t.alpha).title).toBe('Reconciled Title');
    expect(t.log.refreshes).toEqual([]);
    expect(await page.evaluate(() => window.__reconciled)).toEqual([]);
    expect(await t.committed()).toEqual([]);
    expect(t.log.posts).toHaveLength(3);
    await t.kept();
  });
});

test('F2: a failed refresh after a reconciled save keeps the cards, says nothing was saved, and Retry only reads', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await watchReconciled(page);
    let failNext = true;
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (failNext && route.request().method() === 'GET' && route.request().resourceType() === 'fetch') {
        failNext = false;
        await route.fulfill({ status: 500, contentType: 'text/html', body: '<p>broken</p>' });
        return;
      }
      await route.fallback();
    });
    await t.open(t.alpha);
    await draftReconciled(t, page);
    await commitThenDrop(page, t.alpha);
    await t.save.click();
    await expect(t.summary).toContainText('Could not confirm whether the Page was saved.');
    await expect(t.refreshNote).toHaveText('Related Notes could not be updated, so they may be out of date.');
    await expect(t.retry).toHaveText('Retry refresh');
    await expect(t.feedback).not.toContainText(/saved/i);
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Page');
    expect(await page.evaluate(() => window.__reconciled)).toEqual([String(t.alpha.id)]);

    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();
    await t.retry.click();
    await expect(t.noteTitle(t.alpha)).toHaveText('Reconciled Title');
    await expect(t.refreshNote).toHaveCount(0);
    await expect(t.retry).toHaveCount(0);
    await expect(t.edit(t.alpha)).toBeFocused();
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET', 'GET']);
    expect(await t.committed()).toEqual([]);
    await t.kept();
  });
});

test('F2: a reconciled read answering after its dialog was replaced refreshes the page and leaves the new editor alone', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await watchReconciled(page);
    await t.open(t.alpha);
    await draftReconciled(t, page);
    const read = await hold(page, `/notes/${t.alpha.id}`, 'GET');
    await commitThenDrop(page, t.alpha);
    await t.save.click();
    await expect(t.summary).toContainText('Could not confirm whether the Page was saved.');
    await read.arrived;

    // Settled once the draft is discarded, so Beta's Edit replaces it.
    await t.close.click();
    await t.confirmation.getByRole('button', { name: 'Discard' }).click();
    await expect(t.dialog).toBeHidden();
    await t.open(t.beta);
    await t.title.fill('Beta Draft');
    read.release();

    await expect(t.noteTitle(t.alpha)).toHaveText('Reconciled Title');
    expect(await page.evaluate(() => window.__reconciled)).toEqual([String(t.alpha.id)]);
    await expect(t.dialog).toBeVisible();
    await expect(page.locator('#note-form')).toHaveAttribute('action', `/notes/${t.beta.id}`);
    await expect(t.title).toHaveValue('Beta Draft');
    await t.type(' still editable');
    expect(await t.markdown()).toContain('still editable');
    await expect(t.feedback).not.toContainText('could not be read again');
    await expect(page.locator('[data-chapter-refresh-note]')).toHaveCount(0);
    await expect(t.refreshNote).toHaveCount(0);
    expect(await page.locator('#note-edit-dialog').count()).toBe(1);
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET']);
    expect(await t.committed()).toEqual([]);
    expect(t.saved(t.beta).title).toBe('Beta Page');
    await t.kept();
  });
});

// ─── Milestone 2 F2-F1 ───────────────────────────────────────────────────────
// (P2) The server trims a saved title (note-service.js normalizeTitle), so a
// reconciling read holds the trimmed title the draft was saved as.
// (P2) A reconciling read must hold the whole saved state: an omitted or
// malformed field is not an empty one, so it confirms nothing, is not adopted
// as the saved values, and the draft stays unsaved.

function dialogBaseline(page) {
  return page.locator('#note-edit-dialog [data-note-dialog-baseline]')
    .evaluate((node) => JSON.parse(node.textContent));
}

// The next POST of this Page never reaches the server; the read after it answers
// with its saved values passed through mutate(). Resolves once rewritten.
async function lostWithRewrittenRead(page, note, mutate) {
  let posted = false;
  let rewrote = false;
  let rewritten;
  const done = new Promise((resolve) => { rewritten = resolve; });
  await page.route((url) => url.pathname === `/notes/${note.id}`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && !posted) {
      posted = true;
      return route.abort('connectionreset');
    }
    if (request.method() !== 'GET' || !posted || rewrote || request.resourceType() !== 'fetch') return route.fallback();
    rewrote = true;
    const response = await route.fetch();
    const pattern = /(<script type="application\/json" data-note-dialog-baseline>)([\s\S]*?)(<\/script>)/;
    const html = await response.text();
    expect(html).toMatch(pattern);
    const body = html.replace(pattern, (whole, open, json, close) => {
      const values = JSON.parse(json);
      mutate(values);
      return open + JSON.stringify(values).replace(/</g, '\\u003c') + close;
    });
    await route.fulfill({ response, body });
    rewritten();
  });
  return { rewritten: done };
}

async function expectUnreconciledDraft(t, page, saved) {
  await page.waitForTimeout(400);
  await expect(t.summary).toContainText('Could not confirm whether the Page was saved.');
  expect(await page.evaluate(() => window.__reconciled)).toEqual([]);
  expect(t.log.refreshes).toEqual([]);
  expect(await t.committed()).toEqual([]);
  // The rendered saved values stay: nothing incomplete was adopted.
  expect(await dialogBaseline(page)).toMatchObject(saved);
  await expect(t.dialog).toBeVisible();
  // Still unsaved: Close asks before the draft is discarded.
  await t.close.click();
  await expect(t.confirmation).toBeVisible();
  await t.confirmation.getByRole('button', { name: 'Discard' }).click();
  await expect(t.dialog).toBeHidden();
}

test('F2-F1: a lost save the server stored with a trimmed title reconciles and refreshes Related Notes', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await watchReconciled(page);
    await t.open(t.alpha);
    await t.title.fill('  Trimmed Saved Title  ');
    await commitThenDrop(page, t.alpha);
    await t.save.click();

    await expect(t.summary).toContainText('Could not confirm whether the Page was saved.');
    await expect(t.noteTitle(t.alpha)).toHaveText('Trimmed Saved Title');
    expect(t.saved(t.alpha).title).toBe('Trimmed Saved Title');
    expect((await dialogBaseline(page)).title).toBe('Trimmed Saved Title');
    await page.waitForTimeout(300);
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET']);
    expect(await t.committed()).toEqual([]);
    expect(await page.evaluate(() => window.__reconciled)).toEqual([String(t.alpha.id)]);
    await t.kept();
  });
});

test('F2-F1: a reconciling read without assetIds confirms no removal and keeps the draft unsaved', async ({ page }) => {
  await withProject(page, async (t) => {
    t.noteService.updateNote(t.alpha.id, {
      title: 'Alpha Page', content: 'Alpha body', projectIds: [t.project.id], assetIds: [t.art.id],
    });
    await t.visit();
    await watchReconciled(page);
    await t.open(t.alpha);
    await setAssociations(t, page, { asset: false });
    const { rewritten } = await lostWithRewrittenRead(page, t.alpha, (values) => { delete values.assetIds; });
    await t.save.click();
    await rewritten;
    await expectUnreconciledDraft(t, page, { assetIds: [String(t.art.id)], projectIds: [String(t.project.id)] });
    expect(t.saved(t.alpha).assetIds).toEqual([t.art.id]);
    await expect(t.card(t.alpha).locator(`[data-project-related-note-asset="${t.art.id}"]`)).toHaveCount(1);
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('F2-F1: a reconciling read without projectIds confirms no unlink and keeps the draft unsaved', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await watchReconciled(page);
    await t.open(t.alpha);
    await setAssociations(t, page, { project: false });
    const { rewritten } = await lostWithRewrittenRead(page, t.alpha, (values) => { delete values.projectIds; });
    await t.save.click();
    await rewritten;
    await expectUnreconciledDraft(t, page, { assetIds: [], projectIds: [String(t.project.id)] });
    expect(t.saved(t.alpha).projectIds).toEqual([t.project.id]);
    await expect(t.card(t.alpha)).toHaveCount(1);
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('F2-F1: malformed saved values in a reconciling read are not normalized into a saved state', async ({ page }) => {
  await withProject(page, async (t) => {
    t.noteService.updateNote(t.alpha.id, {
      title: 'Alpha Page', content: 'Alpha body', projectIds: [t.project.id], assetIds: [t.art.id],
    });
    await t.visit();
    await watchReconciled(page);
    // Each would read as the draft's removal if coerced (String / Array.from).
    const cases = [
      { name: 'assetIds null', draft: { asset: false }, mutate: (v) => { v.assetIds = null; } },
      { name: 'assetIds object', draft: { asset: false }, mutate: (v) => { v.assetIds = {}; } },
      { name: 'projectIds number', draft: { project: false }, mutate: (v) => { v.projectIds = 0; } },
      { name: 'title array', draft: { asset: false }, mutate: (v) => { v.title = [v.title]; v.assetIds = []; } },
    ];
    for (const { name, draft, mutate } of cases) {
      await test.step(name, async () => {
        await t.open(t.alpha);
        await setAssociations(t, page, draft);
        const { rewritten } = await lostWithRewrittenRead(page, t.alpha, mutate);
        await t.save.click();
        await rewritten;
        await expectUnreconciledDraft(t, page, {
          title: 'Alpha Page', assetIds: [String(t.art.id)], projectIds: [String(t.project.id)],
        });
        await page.unrouteAll({ behavior: 'wait' });
      });
    }
    expect(t.saved(t.alpha)).toMatchObject({ projectIds: [t.project.id], assetIds: [t.art.id], title: 'Alpha Page' });
    expect(t.log.posts).toHaveLength(cases.length);
    expect(await t.committed()).toEqual([]);
    await t.kept();
  });
});

test('F2-F1: a complete read with explicitly empty connections still reconciles a lost save', async ({ page }) => {
  await withProject(page, async (t) => {
    // Alpha relates through its asset alone: its saved projectIds are [].
    t.noteService.updateNote(t.alpha.id, {
      title: 'Alpha Page', content: 'Alpha body', projectIds: [], assetIds: [t.art.id],
    });
    await t.visit();
    await watchReconciled(page);
    await t.open(t.alpha);
    await t.title.fill('Asset Only Title');
    await commitThenDrop(page, t.alpha);
    await t.save.click();
    await expect(t.noteTitle(t.alpha)).toHaveText('Asset Only Title');
    expect(await dialogBaseline(page)).toMatchObject({ projectIds: [], assetIds: [String(t.art.id)] });
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();

    // Beta has no assets: its saved assetIds are [].
    await t.open(t.beta);
    await t.title.fill('No Assets Title');
    await commitThenDrop(page, t.beta);
    await t.save.click();
    await expect(t.noteTitle(t.beta)).toHaveText('No Assets Title');
    expect(await dialogBaseline(page)).toMatchObject({ projectIds: [String(t.project.id)], assetIds: [] });
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();

    expect(await page.evaluate(() => window.__reconciled)).toEqual([String(t.alpha.id), String(t.beta.id)]);
    expect(t.log.posts).toHaveLength(2);
    expect(t.log.refreshes).toEqual(['GET', 'GET']);
    expect(await t.committed()).toEqual([]);
    await t.kept();
  });
});
