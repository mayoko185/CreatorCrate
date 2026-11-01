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

// Edit Page saves in place on Page Detail: the page is never navigated or replaced,
// a draft stays in the dialog until saved or discarded, and a POST is never repeated.
// The real editor exists only in the built client, so these tests run against it.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

async function withPage(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-edit-page-flow-'));
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
    const insertProject = db.prepare("INSERT INTO projects (title, slug, description, notes, status, project_type) VALUES (?, ?, '', '', 'tbd', 'images')");
    const alpha = insertProject.run('Alpha', 'alpha').lastInsertRowid;
    const beta = insertProject.run('Beta', 'beta').lastInsertRowid;
    const note = noteService.createNote({
      chapterId: chapter.id, title: 'Original Title', content: 'Original body', projectIds: [alpha],
    });
    noteService.createNote({ chapterId: chapter.id, title: 'Sibling Page', content: 'Sibling body' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const hostPath = `/notes/${note.id}`;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const log = { navigations: [], posts: [], gets: [] };
    let visited = false;
    page.on('framenavigated', (frame) => {
      if (visited && frame === page.mainFrame()) log.navigations.push(frame.url());
    });
    page.on('request', (request) => {
      if (new URL(request.url()).pathname !== hostPath) return;
      if (request.method() === 'POST') log.posts.push(request);
      if (request.method() === 'GET' && request.resourceType() === 'fetch') log.gets.push(request);
    });

    const dialog = page.locator('#note-edit-dialog');
    const editor = dialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]');
    const confirmation = page.locator('#app-confirmation-dialog');
    const trigger = page.locator('.page-heading [data-dialog-open="note-edit-dialog"]');
    await run({
      app, db, origin, book, chapter, note, alpha, beta, log, dialog, editor, confirmation, trigger, noteService, hostPath,
      title: dialog.locator('[name="title"]'),
      save: dialog.getByRole('button', { name: 'Save', exact: true }),
      close: dialog.getByRole('button', { name: 'Close Edit Page' }),
      summary: dialog.locator('[data-dialog-error]'),
      feedback: page.locator('[data-dialog-feedback]'),
      heading: page.locator('#notes-detail-content-heading'),
      body: page.locator('.notes-content'),
      navCurrent: page.locator('.notes-page-detail-sidebar .notes-book-nav-page-link[aria-current="page"]'),
      projectInput: (id) => dialog.locator(`#note-projects-form input[value="${id}"]`),
      projectSummary: dialog.locator('#note-projects-form summary'),
      markdown: () => dialog.locator('#note-form').evaluate((form) => form.__creatorCrateNotesEditor.getMarkdown()),
      saved: () => noteService.getNote(note.id),
      visit: async (pathname = hostPath) => {
        visited = false;
        await page.goto(origin + pathname);
        log.navigations.length = 0;
        visited = true;
        await page.evaluate(() => { window.__editPageDocument = true; });
      },
      kept: async () => {
        expect(log.navigations).toEqual([]);
        expect(await page.evaluate(() => window.__editPageDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(hostPath);
      },
      openDialog: async () => {
        await trigger.click();
        await expect(dialog).toBeVisible();
        await expect(editor).toBeVisible();
      },
      type: async (text) => {
        await editor.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(text);
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

test('Page Detail saves edited Markdown and connections in place, once, and the host follows', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await page.evaluate(() => {
      document.querySelector('.notes-page-detail-sidebar [data-book-nav-chapter]').closest('details').open = false;
      window.scrollTo(0, 15);
    });
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await t.openDialog();
    await t.kept();
    expect(await t.dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
    await expect(t.title).toHaveValue('Original Title');
    await expect(t.editor).toContainText('Original body');
    await expect(t.projectInput(t.alpha)).toBeChecked();

    await t.title.fill('Edited Title');
    await t.editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Plain then ');
    await t.dialog.locator('.toastui-editor-toolbar-icons.bold').click();
    await page.keyboard.type('bold words');
    await t.projectSummary.click();
    await t.projectInput(t.alpha).uncheck();
    await t.projectInput(t.beta).check();
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeVisible();

    // A real click: the request is built before the editor's own submit listener runs.
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();
    await expect(t.feedback).toContainText('Page “Edited Title” saved.');
    await expect(t.trigger).toBeFocused();
    await t.kept();
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.posts[0].postData()).toContain('Plain+then+**bold+words**');

    expect(t.saved()).toMatchObject({
      title: 'Edited Title', content: 'Plain then **bold words**', chapter_id: t.chapter.id, book_id: t.book.id, projectIds: [t.beta],
    });

    await expect(t.body.locator('strong')).toHaveText('bold words');
    await expect(t.heading).toHaveText('Edited Title');
    await expect(t.navCurrent).toHaveText('Edited Title');
    await expect(page.locator('#note-edit-dialog .notes-book-nav-page-link[aria-current="page"]')).toHaveText('Edited Title');
    await expect(page.locator('.notes-detail-projects a')).toHaveText(['Beta']);
    await expect(page).toHaveTitle(/Edited Title$/);
    await expect(page.locator('.notes-revision-history a', { hasText: 'View' })).toHaveCount(1);
    expect(await page.evaluate(() => document.querySelector('.notes-page-detail-sidebar [data-book-nav-chapter]').closest('details').open)).toBe(false);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

    // Reopened: the saved values, and nothing counts as unsaved.
    await t.openDialog();
    await expect(t.title).toHaveValue('Edited Title');
    await expect(t.editor.locator('strong')).toHaveText('bold words');
    await expect(t.projectInput(t.beta)).toBeChecked();
    await expect(t.projectInput(t.alpha)).not.toBeChecked();
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();
    await expect(t.trigger).toBeFocused();
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('Markdown mode content reaches the server and saves can follow one another', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await t.openDialog();
    await t.dialog.locator('.toastui-editor-mode-switch .tab-item', { hasText: 'Markdown' }).click();
    const source = t.dialog.locator('.toastui-editor-md-container .ProseMirror[contenteditable="true"]');
    await source.fill('# Fresh heading');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved().content).toBe('# Fresh heading');
    await expect(t.body.locator('h1')).toHaveText('Fresh heading');

    // The editor stays in the mode the user chose.
    await t.trigger.click();
    await expect(source).toBeVisible();
    await expect(source).toContainText('# Fresh heading');
    await t.title.fill('Second save');
    await page.keyboard.press('Enter');
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toMatchObject({ title: 'Second save', content: '# Fresh heading' });
    expect(t.log.posts).toHaveLength(2);
    await expect(t.heading).toHaveText('Second save');
    await t.kept();
  });
});

test('a refusal keeps the draft and its dirty state, and the corrected draft saves once', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await t.openDialog();
    await t.title.fill('');
    await t.type(' with draft');
    await t.projectSummary.click();
    await t.projectInput(t.beta).check();
    await page.keyboard.press('Escape');
    await t.save.click();

    await expect(t.dialog.locator('#note-edit-title-error')).toHaveText('Title is required.');
    await expect(t.title).toBeFocused();
    await expect(t.editor).toContainText('Original body with draft');
    await expect(t.projectInput(t.beta)).toBeChecked();
    await expect(t.save).toBeEnabled();
    expect(t.saved().title).toBe('Original Title');
    await t.kept();

    // Still unsaved after the refusal.
    await page.keyboard.press('Escape');
    await expect(t.confirmation).toBeVisible();
    await t.confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(t.dialog).toBeVisible();
    await expect(t.editor).toContainText('Original body with draft');

    await t.type(' and more');
    await t.title.fill('Corrected');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(2);
    expect(t.saved()).toMatchObject({
      title: 'Corrected', content: 'Original body with draft and more', projectIds: [t.alpha, t.beta],
    });
    await t.openDialog();
    await expect(t.summary).toBeHidden();
    await expect(t.dialog.locator('#note-edit-title-error')).toHaveCount(0);
  });
});

test('a connection gone stale is reported on its field with the draft kept', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await t.openDialog();
    await t.type(' draft');
    await t.projectInput(t.beta).evaluate((input) => { input.value = '999999'; input.checked = true; });
    await t.save.click();
    await expect(t.dialog.locator('[data-dialog-field="projectIds"] .field-error-message')).toHaveText('Project 999999 not found.');
    await expect(t.editor).toContainText('Original body draft');
    expect(t.saved().content).toBe('Original body');
    await t.kept();
  });
});

test('every dismissal honors the guard: Keep Editing keeps, Discard restores the newest saved values', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await t.openDialog();
    await t.title.fill('Saved first');
    await t.type(' saved');
    await t.save.click();
    await expect(t.dialog).toBeHidden();

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
        await t.openDialog();
        await t.title.fill(`Draft ${name}`);
        await t.type(' unsaved');
        await t.projectSummary.click();
        await t.projectInput(t.beta).check();
        await page.keyboard.press('Escape');
        await t.title.focus();
        await dismiss();
        await expect(t.confirmation).toBeVisible();
        await t.confirmation.getByRole('button', { name: 'Cancel' }).click();
        await expect(t.dialog).toBeVisible();
        await expect(t.title).toHaveValue(`Draft ${name}`);
        await expect(t.editor).toContainText('unsaved');
        await dismiss();
        await t.confirmation.getByRole('button', { name: 'Discard' }).click();
        await expect(t.dialog).toBeHidden();
        await expect(t.trigger).toBeFocused();
        await t.kept();
        await t.openDialog();
        await expect(t.title).toHaveValue('Saved first');
        await expect.poll(t.markdown).toBe('Original body saved');
        await expect(t.projectInput(t.beta)).not.toBeChecked();
        await page.keyboard.press('Escape');
        await expect(t.dialog).toBeHidden();
        await expect(t.confirmation).toBeHidden();
      });
    }
    expect(t.log.posts).toHaveLength(1);
    expect(t.saved().title).toBe('Saved first');
  });
});

test('a save in flight cannot be dismissed or sent twice', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**${t.hostPath}`, async (route) => {
      if (route.request().method() === 'POST') await held;
      return route.continue();
    });
    await t.openDialog();
    await t.title.fill('Held Title');
    await t.title.press('Enter');
    await expect(t.save).toBeDisabled();
    await t.title.press('Enter');
    await page.keyboard.press('Escape');
    await t.close.click();
    await expect(t.dialog).toBeVisible();
    await expect(t.confirmation).toBeHidden();
    release();
    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(1);
    expect(t.saved().title).toBe('Held Title');
    await t.kept();
  });
});

// Real pointer and keyboard input against the frozen form, where a user would try it.
async function attemptPendingEdits(page, t) {
  const clickCenter = async (locator) => {
    await locator.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    const box = await locator.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  await clickCenter(t.title);
  await page.keyboard.type('LATE');
  await clickCenter(t.editor);
  await page.keyboard.type('LATE');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await clickCenter(t.dialog.locator('.toastui-editor-toolbar-icons.bold'));
  await clickCenter(t.projectSummary);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

function holdPosts(page, hostPath) {
  const held = {};
  held.gate = new Promise((resolve) => { held.release = resolve; });
  return page.route(`**${hostPath}`, async (route) => {
    if (route.request().method() === 'POST') await held.gate;
    return route.continue();
  }).then(() => held);
}

test('a save held pending refuses later edits and saves exactly what was submitted', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    const held = await holdPosts(page, t.hostPath);
    await t.openDialog();
    await t.title.fill('Frozen Title');
    await t.type(' frozen');
    await t.projectSummary.click();
    await t.projectInput(t.beta).check();
    await page.keyboard.press('Escape');
    await t.save.click();
    await expect(t.dialog).toHaveAttribute('data-dialog-state', 'pending');
    await expect(t.dialog.locator('[data-dialog-status]')).toHaveText('Saving Page…');

    await attemptPendingEdits(page, t);

    await expect(t.dialog).toBeVisible();
    await expect(t.confirmation).toBeHidden();
    await expect(t.title).toHaveValue('Frozen Title');
    expect(await t.markdown()).toBe('Original body frozen');
    await expect(t.projectInput(t.alpha)).toBeChecked();
    await expect(t.projectInput(t.beta)).toBeChecked();
    await expect(t.dialog.locator('#note-projects-form')).not.toHaveAttribute('open');
    expect(await t.dialog.evaluate((dialog) => !dialog.querySelector('#note-form').contains(document.activeElement))).toBe(true);

    held.release();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page “Frozen Title” saved.');
    await expect(t.trigger).toBeFocused();
    await expect(t.heading).toHaveText('Frozen Title');
    await expect(t.body).toContainText('Original body frozen');
    await t.kept();

    expect(t.log.posts).toHaveLength(1);
    const sent = new URLSearchParams(t.log.posts[0].postData());
    expect(sent.get('title')).toBe('Frozen Title');
    expect(sent.get('content')).toBe('Original body frozen');
    expect(sent.getAll('projectIds[]').map(Number).sort()).toEqual([t.alpha, t.beta].sort());
    expect(sent.get('_csrf')).toBeTruthy();
    expect(t.saved()).toMatchObject({ title: 'Frozen Title', content: 'Original body frozen', projectIds: [t.alpha, t.beta] });

    await t.openDialog();
    await expect(t.title).toHaveValue('Frozen Title');
    await expect.poll(t.markdown).toBe('Original body frozen');
    await expect(t.projectInput(t.beta)).toBeChecked();
    await t.title.fill('Editable again');
    await t.type(' again');
    await expect(t.title).toHaveValue('Editable again');
    await expect.poll(t.markdown).toBe('Original body frozen again');
    await t.title.focus();
    await page.keyboard.press('Escape');
    await t.confirmation.getByRole('button', { name: 'Discard' }).click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(1);
  });
});

test('a refusal held pending freezes the draft, then returns it editable and saves once corrected', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    const held = await holdPosts(page, t.hostPath);
    await t.openDialog();
    await t.title.fill('');
    await t.type(' refused');
    await t.projectSummary.click();
    await t.projectInput(t.beta).check();
    await page.keyboard.press('Escape');
    await t.save.click();
    await expect(t.dialog).toHaveAttribute('data-dialog-state', 'pending');

    await attemptPendingEdits(page, t);
    await expect(t.title).toHaveValue('');
    expect(await t.markdown()).toBe('Original body refused');

    held.release();
    await expect(t.dialog.locator('#note-edit-title-error')).toHaveText('Title is required.');
    await expect(t.title).toBeFocused();
    await expect(t.dialog.locator('[inert]')).toHaveCount(0);
    await expect(t.save).toBeEnabled();
    expect(await t.markdown()).toBe('Original body refused');
    await expect(t.projectInput(t.beta)).toBeChecked();
    expect(t.saved().title).toBe('Original Title');

    // Still unsaved after the refusal.
    await page.keyboard.press('Escape');
    await expect(t.confirmation).toBeVisible();
    await t.confirmation.getByRole('button', { name: 'Cancel' }).click();

    await page.keyboard.press('Tab');
    await t.title.click();
    await page.keyboard.type('Corrected');
    await t.type(' fixed');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(2);
    expect(t.saved()).toMatchObject({
      title: 'Corrected', content: 'Original body refused fixed', projectIds: [t.alpha, t.beta],
    });
    await t.kept();
  });
});

for (const [name, answer] of [
  ['a recoverable server error', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'error', code: 'PAGE_OPERATION_FAILED', message: 'The Page could not be saved. No changes were made.' }),
  })],
  ['a lost connection', (route) => route.abort('connectionreset')],
  ['an unreadable answer', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Sign in</html>' })],
]) {
  test(`${name} held pending returns the draft editable and sends nothing more`, async ({ page }) => {
    await withPage(page, async (t) => {
      await t.visit();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      await page.route(`**${t.hostPath}`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await gate;
        return answer(route);
      });
      await t.openDialog();
      await t.title.fill('Unanswered');
      await t.type(' draft');
      await t.save.click();
      await expect(t.dialog).toHaveAttribute('data-dialog-state', 'pending');
      await attemptPendingEdits(page, t);
      await expect(t.title).toHaveValue('Unanswered');
      expect(await t.markdown()).toBe('Original body draft');

      release();
      await expect(t.summary).toBeVisible();
      await expect(t.dialog.locator('[inert]')).toHaveCount(0);
      await expect(t.save).toBeEnabled();
      await expect(t.title).toHaveValue('Unanswered');
      expect(await t.markdown()).toBe('Original body draft');
      await t.title.click();
      await page.keyboard.press('End');
      await page.keyboard.type(' more');
      await expect(t.title).toHaveValue('Unanswered more');
      await t.type(' typed');
      await expect.poll(t.markdown).toBe('Original body draft typed');
      expect(t.log.posts).toHaveLength(1);
      await t.kept();
    });
  });
}

test('a lost answer stays uncertain, reconciles by reading, and is never retried', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await t.openDialog();
    await t.title.fill('Landed Title');
    await t.type(' landed');
    // The write lands, but its answer never arrives.
    await page.route(`**${t.hostPath}`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      return route.abort('connectionreset');
    }, { times: 1 });
    await t.save.click();
    await expect(t.summary).toContainText('Could not confirm whether the Page was saved');
    await expect(t.dialog).toBeVisible();
    await expect(t.title).toHaveValue('Landed Title');
    await expect(t.feedback).toBeHidden();
    await expect(t.save).toBeEnabled();
    // The read shows what the server holds, with no second POST.
    await expect(t.heading).toHaveText('Landed Title');
    await expect(t.body).toContainText('Original body landed');
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
    // The draft now matches the saved Page, so closing asks nothing.
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();
  });
});

test('an unreadable answer keeps a differing draft unsaved; a coded refusal says nothing was written', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await t.openDialog();
    await t.title.fill('Not written');
    await page.route(`**${t.hostPath}`, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Sign in</html>' })
      : route.continue()), { times: 1 });
    await t.save.click();
    await expect(t.summary).toContainText('Could not confirm whether the Page was saved');
    await expect(t.feedback).toBeHidden();
    await expect.poll(() => t.log.gets.length).toBeGreaterThan(0);
    await expect(t.heading).toHaveText('Original Title');
    await expect(t.title).toHaveValue('Not written');

    await page.route(`**${t.hostPath}`, (route) => (route.request().method() === 'POST'
      ? route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', code: 'PAGE_OPERATION_FAILED', message: 'The Page could not be saved. No changes were made.' }),
      })
      : route.continue()), { times: 1 });
    await t.save.click();
    await expect(t.summary).toContainText('No changes were made.');
    await expect(t.save).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(t.confirmation).toBeVisible();
    await t.confirmation.getByRole('button', { name: 'Discard' }).click();
    await expect(t.dialog).toBeHidden();
    await t.kept();
  });
});

test('a Page deleted elsewhere is refused with the draft kept', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await t.openDialog();
    await t.title.fill('Too late');
    t.noteService.deleteNote(t.note.id);
    await t.save.click();
    await expect(t.summary).toContainText('This Page is no longer available.');
    await expect(t.title).toHaveValue('Too late');
    await expect(t.save).toBeFocused();
    await t.kept();
  });
});

test('a failed refresh keeps the confirmation and recovers with reads only', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await page.route(`**${t.hostPath}`, (route) => (route.request().method() === 'GET' ? route.abort('failed') : route.continue()));
    await t.openDialog();
    await t.title.fill('Saved anyway');
    await t.type(' saved anyway');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page “Saved anyway” saved.');
    await expect(t.feedback).toContainText('The Page was saved, but this page could not refresh.');
    // Acknowledged values show at once; the body waits for a read.
    await expect(t.heading).toHaveText('Saved anyway');
    await expect(t.body).not.toContainText('saved anyway');

    // Reopening before any read succeeds still shows what was saved.
    await t.openDialog();
    await expect(t.title).toHaveValue('Saved anyway');
    await expect.poll(t.markdown).toBe('Original body saved anyway');
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();

    await page.unroute(`**${t.hostPath}`);
    await page.locator('[data-chapter-refresh-retry]').click();
    await expect(t.body).toContainText('saved anyway');
    await expect(page.locator('[data-chapter-refresh-retry]')).toHaveCount(0);
    await expect(t.feedback).toContainText('Page “Saved anyway” saved.');
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('a refresh landing over a newer draft leaves it alone and keeps open disclosures', async ({ page }) => {
  await withPage(page, async (t) => {
    t.noteService.updateNote(t.note.id, { title: 'Original Title', content: 'Has a revision', projectIds: [t.alpha] });
    await t.visit();
    await page.locator('.notes-revision-history summary').click();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**${t.hostPath}`, async (route) => {
      if (route.request().method() === 'GET') await held;
      return route.continue();
    });
    await t.openDialog();
    await t.title.fill('First save');
    await t.save.click();
    await expect(t.dialog).toBeHidden();

    await t.openDialog();
    await t.title.fill('Newer draft');
    await t.type(' typing');
    release();
    await expect(t.body).toContainText('Has a revision');
    await expect.poll(() => t.log.gets.length).toBeGreaterThan(0);
    await expect(page.locator('.notes-revision-history a', { hasText: 'View' })).toHaveCount(2);
    await expect(page.locator('.notes-revision-history details')).toHaveAttribute('open', '');
    await expect(t.title).toHaveValue('Newer draft');
    await expect(t.editor).toContainText('typing');

    await t.title.focus();
    await page.keyboard.press('Escape');
    await t.confirmation.getByRole('button', { name: 'Discard' }).click();
    await expect(t.dialog).toBeHidden();
    await t.openDialog();
    await expect(t.title).toHaveValue('First save');
    await t.kept();
  });
});

test('a change saved elsewhere reaches a dialog holding no draft, and its Discard baseline', async ({ page }) => {
  await withPage(page, async (t) => {
    await t.visit();
    await t.openDialog();
    await t.title.fill('From here');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.heading).toHaveText('From here');
    await expect(page.locator('[data-chapter-refresh-retry]')).toHaveCount(0);

    // Another tab saves; the next read of this host is what reveals it.
    t.noteService.updateNote(t.note.id, { title: 'From elsewhere', content: 'Elsewhere body', projectIds: [] });
    await page.route(`**${t.hostPath}`, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' })
      : route.continue()), { times: 1 });
    await t.openDialog();
    await t.title.fill('Stale draft');
    await t.save.click();
    await expect(t.summary).toContainText('Could not confirm');
    await expect(t.heading).toHaveText('From elsewhere');
    await expect(t.title).toHaveValue('Stale draft');

    await page.keyboard.press('Escape');
    await t.confirmation.getByRole('button', { name: 'Discard' }).click();
    await expect(t.dialog).toBeHidden();
    await t.openDialog();
    await expect(t.title).toHaveValue('From elsewhere');
    await expect.poll(t.markdown).toBe('Elsewhere body');
    await expect(t.projectInput(t.alpha)).not.toBeChecked();
    await t.close.click();
    await expect(t.confirmation).toBeHidden();
  });
});

test('each Page edits only itself', async ({ page }) => {
  await withPage(page, async (t) => {
    const sibling = t.noteService.listNotesForChapter(t.chapter.id).find((note) => note.title === 'Sibling Page');
    await t.visit();
    await t.openDialog();
    await t.title.fill('Only this Page');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(page.locator(`.notes-page-detail-sidebar a[href="/notes/${sibling.id}"]`)).toHaveText('Sibling Page');

    // Explicit navigation still navigates, to a form holding that Page.
    await page.locator('.notes-page-detail-sidebar details').first().evaluate((node) => { node.open = true; });
    await page.locator(`.notes-page-detail-sidebar a[href="/notes/${sibling.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/notes/${sibling.id}$`));
    await t.openDialog();
    await expect(t.title).toHaveValue('Sibling Page');
    await expect(t.editor).toContainText('Sibling body');
    await expect(t.projectInput(t.alpha)).not.toBeChecked();
    await t.close.click();
    expect(t.noteService.getNote(sibling.id)).toMatchObject({ title: 'Sibling Page', content: 'Sibling body' });
    expect(t.saved().title).toBe('Only this Page');
  });
});

test('a newly saved asset becomes retained like any other saved connection', async ({ page }) => {
  await withPage(page, async (t) => {
    const asset = t.db.prepare("INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at) VALUES (?, 'a.png', 'a.png', 'png', 'image/png', 1, 1, datetime('now'))").run(t.alpha).lastInsertRowid;
    await t.visit();
    await t.openDialog();
    await t.dialog.locator('#note-assets-form summary').click();
    await t.dialog.locator(`#note-assets-form input[value="${asset}"]`).check();
    await page.keyboard.press('Escape');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved().assetIds).toEqual([asset]);
    await expect(page.locator('.notes-detail-assets a')).toHaveText(['a.png']);

    await t.openDialog();
    await t.projectSummary.click();
    await t.projectInput(t.alpha).uncheck();
    await page.keyboard.press('Escape');
    await expect(t.dialog.locator(`[data-note-retained-options] input[value="${asset}"]`)).toBeChecked();
    await t.dialog.locator(`[data-note-retained-options] input[value="${asset}"]`).uncheck();
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toMatchObject({ assetIds: [], projectIds: [] });
    await expect(page.locator('.notes-detail-assets')).toHaveCount(0);
  });
});

test('direct /notes/:id/edit stays a native form, and returns to a Page Detail that moves in place', async ({ page }) => {
  await withPage(page, async (t) => {
    await page.goto(`${t.origin}/notes/${t.note.id}/edit`);
    await expect(t.dialog).toBeVisible();
    await t.title.fill('');
    await t.save.click();
    await expect(page).toHaveURL(new RegExp(`/notes/${t.note.id}$`));
    await expect(t.dialog.locator('#note-edit-title-error')).toHaveText('Title is required.');
    await t.title.fill('Native title');
    await t.save.click();
    await expect(page.locator('#notes-detail-content-heading')).toHaveText('Native title');
    await expect(t.dialog).toBeHidden();
    expect(t.saved().title).toBe('Native title');

    await t.openDialog();
    await t.dialog.locator('.notes-workspace-disclosure--move > summary').click();
    await t.dialog.locator('#note-move-target').evaluate((select, value) => { select.value = value; }, `book:${t.book.id}`);
    await t.dialog.getByRole('button', { name: 'Move Page', exact: true }).click();
    await expect.poll(() => t.saved().chapter_id).toBeNull();
    await expect(page).toHaveURL(new RegExp(`/notes/${t.note.id}$`));
    await expect(t.dialog).toBeVisible();
  });
});
