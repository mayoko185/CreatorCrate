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

// WP6.4: Create Note on Project Detail. The host that mounts the Notes Edit Page
// dialog (WP4) also mounts the closed Create Note dialog read from
// GET /notes/projects/:projectId/new, in the same slot, and it saves through the
// New Page lifecycle to the WP6.2 POST. WP6.5: its trigger is the Related Notes
// section's own Create new note button (always rendered), and a confirmed
// creation refreshes Related Notes in place through the WP5 refresh (one GET).
// The real editor exists only in the built client.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

const CREATED = 'creatorcrate:note-create-committed';
const EDITED = 'creatorcrate:note-edit-committed';

async function withProject(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-related-note-create-'));
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
    const alpha = noteService.createNote({ chapterId: chapter.id, title: 'Alpha Page', content: 'Alpha body', projectIds: [project.id] });
    const assets = createAssetRepository(db);
    const art = assets.upsert(project.id, 'art/cover.png', {
      filename: 'cover.png', extension: 'png', mimeType: 'image/png', sizeBytes: 4096, modifiedAt: '2026-08-06 12:00:00',
    });
    assets.upsert(other.id, 'art/elsewhere.png', {
      filename: 'elsewhere.png', extension: 'png', mimeType: 'image/png', sizeBytes: 4096, modifiedAt: '2026-08-06 12:00:00',
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const hostPath = `/projects/${project.id}`;
    const createPath = `/notes/projects/${project.id}`;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const log = { navigations: [], posts: [], gets: [], editGets: [], refreshes: [] };
    let visited = false;
    page.on('framenavigated', (frame) => {
      if (visited && frame === page.mainFrame()) log.navigations.push(frame.url());
    });
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === createPath && request.method() === 'POST') log.posts.push(request);
      if (pathname === `${createPath}/new` && request.method() === 'GET') log.gets.push(pathname);
      if (/^\/notes\/\d+$/.test(pathname) && request.method() === 'GET' && request.resourceType() === 'fetch') log.editGets.push(pathname);
      if (/^\/projects\/\d+$/.test(pathname) && request.resourceType() === 'fetch') log.refreshes.push(`${request.method()} ${pathname}`);
    });

    const dialog = page.locator('#project-note-create-dialog');
    const editDialog = page.locator('#note-edit-dialog');
    const t = {
      app, db, origin, project, other, book, chapter, alpha, art, noteService, log, dialog, editDialog, hostPath, createPath,
      editor: dialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]'),
      title: dialog.locator('[name="title"]'),
      location: dialog.locator('#note-location-target'),
      locationSummary: dialog.locator('#note-location-dropdown summary'),
      create: dialog.getByRole('button', { name: 'Create', exact: true }),
      close: dialog.getByRole('button', { name: 'Close Create Note' }),
      summary: dialog.locator('[data-dialog-error]'),
      confirmation: page.locator('#app-confirmation-dialog'),
      feedback: page.locator('[data-dialog-feedback]'),
      opener: page.locator('[data-project-related-notes-region] [data-project-related-note-create]'),
      section: page.locator('[data-project-related-notes]'),
      card: (id) => page.locator(`[data-project-related-note="${id}"]`),
      disclosure: (id) => page.locator(`[data-project-related-note-disclosure="${id}"]`),
      refreshNote: page.locator('[data-project-related-notes-refresh-note]'),
      retry: page.locator('[data-project-related-notes-refresh-retry]'),
      edit: (note) => page.locator(`[data-project-related-note-edit="${note.id}"]`),
      assetInput: (id) => dialog.locator(`#note-assets-form input[value="${id}"]`),
      markdown: () => dialog.locator('#note-form').evaluate((form) => form.__creatorCrateNotesEditor.getMarkdown()),
      created: () => page.evaluate(() => window.__created),
      results: () => page.evaluate(() => window.__createResults),
      notes: () => t.db.prepare('SELECT id FROM notes ORDER BY id').all().map((row) => row.id),
      visit: async (at = hostPath) => {
        visited = false;
        t.at = at;
        await page.goto(origin + at);
        await expect(page.locator('[data-project-related-note-editor][data-project-related-note-editor-bound="true"]')).toBeAttached();
        await page.evaluate(({ created, edited }) => {
          // The host's own controller, as the bundled page holds it. What the
          // section's Create new note asks of it is recorded; a direct call is not.
          const ctrl = document.querySelector('[data-project-related-note-editor]').__creatorCrateProjectRelatedNoteEditor;
          const openCreate = ctrl.openCreate;
          window.__openCreate = (options) => openCreate(options?.opener);
          window.__projectDetailDocument = true;
          window.__created = [];
          window.__edited = [];
          window.__createResults = [];
          ctrl.openCreate = (opener) => {
            const result = openCreate(opener);
            result.then((opened) => window.__createResults.push(opened));
            return result;
          };
          document.addEventListener(created, (event) => {
            window.__created.push({
              noteId: event.detail.noteId,
              projectId: event.detail.projectId,
              pageId: event.detail.payload?.page?.id ?? null,
              dialogId: event.target.id,
              dialogOpen: event.target.open,
            });
          });
          document.addEventListener(edited, (event) => window.__edited.push(event.detail.kind));
        }, { created: CREATED, edited: EDITED });
        log.navigations.length = 0;
        visited = true;
      },
      kept: async () => {
        expect(log.navigations).toEqual([]);
        expect(await page.evaluate(() => window.__projectDetailDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(t.at || hostPath);
      },
      open: async () => {
        await t.opener.click();
        await expect(dialog).toBeVisible();
        await expect(t.editor).toBeVisible();
      },
      type: async (text) => {
        await t.editor.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(text);
      },
      choose: async (label) => {
        await t.locationSummary.click();
        await dialog.locator('#note-location-dropdown label', { hasText: label }).click();
        await expect(t.locationSummary).toContainText(label);
      },
      pickAsset: async (checked = true) => {
        await dialog.locator('#note-assets-form summary').click();
        await t.assetInput(art.id).setChecked(checked);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
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

// Whether the Create Note dialog holds a creation whose outcome is unknown.
function unresolved(t) {
  return t.dialog.evaluate((node) => {
    const state = node.__creatorCrateAppDialogState;
    return state.unresolvedOutcome === true && state.submitLocked?.() === true;
  });
}

// A whole draft: title, Markdown, a Chapter location and this project's Asset.
async function fillDraft(t, page, title = 'Held Note') {
  await t.open();
  await t.title.fill(title);
  await t.type('Held body');
  await t.choose('Chapter: Lore / First Chapter');
  await t.pickAsset();
}

const KEPT_CREATE_MESSAGE = 'A new Note’s creation could not be confirmed, and its draft is kept.';

// The whole held draft, readable whether its dialog is open or closed.
async function expectDraft(t, title) {
  await expect(t.title).toHaveValue(title);
  expect(await t.markdown()).toBe('Held body');
  await expect(t.location).toHaveValue(`chapter:${t.chapter.id}`);
  await expect(t.assetInput(t.art.id)).toBeChecked();
  await expect(t.dialog.locator(`#note-projects-form input[value="${t.project.id}"]`)).toBeChecked();
  await expect(t.dialog.locator(`#note-projects-form input[value="${t.project.id}"]`)).toBeDisabled();
  await expect(t.summary).toBeAttached();
  expect(await t.summary.evaluate((node) => node.hidden)).toBe(false);
  await expect(t.summary).toContainText('Could not confirm whether the Note was created.');
  // By its markup: a closed dialog's controls have no accessible role.
  await expect(t.dialog.locator('[data-dialog-submit]')).toBeDisabled();
  expect(await unresolved(t)).toBe(true);
}

// Marks the mounted dialog and its editor, so a reopen can show they are the
// very same ones, not a new mount.
function markMounted(t) {
  return t.dialog.evaluate((node) => {
    node.__keptMarker = true;
    node.querySelector('#note-form').__creatorCrateNotesEditor.__keptMarker = true;
  });
}

function sameMounted(t) {
  return t.dialog.evaluate((node) => node.__keptMarker === true
    && node.querySelector('#note-form').__creatorCrateNotesEditor.__keptMarker === true);
}

// Nothing is sent again, by Save, Enter or a scripted submit.
async function expectNoResend(t, page, posts) {
  await t.create.click({ force: true });
  await t.title.press('Enter').catch(() => {});
  await t.dialog.locator('#note-form').evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(200);
  expect(t.log.posts).toHaveLength(posts);
}

// WP6.4-F1 + WP6-F4: an unknown creation outcome keeps the dialog, its draft,
// its message and its locked Save. Close, Escape and the backdrop only hide it
// (no Discard question, no reset); Create new note reopens that same dialog,
// with no read and no new form; Edit is refused with a message; nothing resends.
async function expectHeld(t, page, { title = 'Held Note', posts }) {
  await expect(t.summary).toBeVisible();
  await expect(t.summary).toContainText('Could not confirm whether the Note was created.');
  await expect(t.dialog).toBeVisible();
  expect(await unresolved(t)).toBe(true);
  await expect(t.create).toBeDisabled();
  await expect(t.feedback).not.toContainText('created.');
  expect(await t.created()).toEqual([]);
  await expectDraft(t, title);
  await expectNoResend(t, page, posts);

  // While it is open, another Create is refused: the modal is already in front.
  expect(await page.evaluate(() => window.__openCreate())).toBe(false);
  await markMounted(t);
  const gets = t.log.gets.length;

  const dismissals = [
    ['Close', () => t.close.click()],
    ['Escape', async () => {
      await t.title.focus();
      await page.keyboard.press('Escape');
    }],
    ['backdrop', () => page.mouse.click(4, 4)],
  ];
  for (const [, dismiss] of dismissals) {
    await dismiss();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();
    await expect(t.opener).toBeFocused();
    // Closed, nothing in it takes focus or keys.
    expect(await t.dialog.evaluate((node) => node.open || node.contains(document.activeElement))).toBe(false);
    expect(await page.evaluate(() => document.body.classList.contains('app-dialog-open'))).toBe(false);
    await expectDraft(t, title);

    // Edit on another note does not replace it, and says why.
    await t.edit(t.alpha).click();
    await expect(t.feedback).toContainText(KEPT_CREATE_MESSAGE);
    await expect(t.feedback).toHaveClass(/notice--error/);
    await expect(t.feedback).toHaveAttribute('role', 'status');
    await page.waitForTimeout(150);
    await expect(t.editDialog).toHaveCount(0);
    expect(t.log.editGets).toEqual([]);

    // Create new note brings the same dialog back, as it was left.
    await t.opener.click();
    await expect(t.dialog).toBeVisible();
    expect(await sameMounted(t)).toBe(true);
    expect(await t.dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await expect(t.summary).toBeVisible();
    await expectDraft(t, title);
  }
  // No read, no second form or editor, nothing sent.
  expect(t.log.gets).toHaveLength(gets);
  await expect(page.locator('#note-form')).toHaveCount(1);
  await expect(page.locator('[data-project-related-note-editor] dialog')).toHaveCount(1);
  await expect(page.locator('.toastui-editor-defaultUI')).toHaveCount(1);
  await expectNoResend(t, page, posts);
  expect(await t.created()).toEqual([]);
}

test('Create Note opens in place, fully enhanced, named, with its project fixed, one dialog at a time', async ({ page }) => {
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

    // Keyboard: the opener is a native button.
    await t.opener.focus();
    await page.keyboard.press('Enter');
    await expect(t.dialog).toBeVisible();
    await expect(t.editor).toBeVisible();
    await t.kept();
    expect(await t.dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
    await expect(t.dialog).toHaveAccessibleName('Create Note');
    expect(await t.dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await expect(t.dialog.locator('#note-form')).toHaveAttribute('action', t.createPath);
    await expect(t.dialog.locator('#note-form')).toHaveAttribute('data-dialog-async', 'true');
    await expect(t.dialog.getByLabel('Note title')).toHaveValue('');
    await expect(t.location).toHaveValue('');
    await expect(t.locationSummary).toContainText('Choose a Book or Chapter');
    // The project is the fixed connection: a disabled control that says so.
    const projectSummary = t.dialog.locator('#note-projects-form summary');
    // WP6-F3: the enhanced name is the shared dropdown's own "Label: summary";
    // the disabled state and help text say the Project cannot be changed.
    await expect(projectSummary).toHaveAccessibleName('Project: Host Project');
    await expect(projectSummary).toHaveAttribute('aria-disabled', 'true');
    await expect(projectSummary).toHaveAccessibleDescription('Notes created here are always connected to this project. The Project cannot be changed.');
    await expect(t.dialog.locator('#notes-editor-heading')).toHaveText('Note contents');
    await expect(t.dialog.locator('.notes-connections-description')).toHaveText('Link this Note to assets from this project.');
    await expect(t.dialog.locator(`#note-projects-form input[value="${t.project.id}"]`)).toBeChecked();
    await expect(t.dialog.locator(`#note-projects-form input[value="${t.project.id}"]`)).toBeDisabled();
    expect(await page.locator('[name="projectIds[]"]').evaluateAll((controls) => controls.every((control) => control.disabled))).toBe(true);
    expect(t.log.gets).toEqual([`${t.createPath}/new`]);
    expect(await t.results()).toEqual([true]);

    // Tab stays inside the modal dialog: past either end it wraps.
    await t.close.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(t.create).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(t.close).toBeFocused();
    // The location dropdown is reached by keyboard.
    await t.locationSummary.focus();
    await expect(t.locationSummary).toBeFocused();

    const bound = () => t.dialog.evaluate((node) => [...new Set([node, ...node.querySelectorAll('*')]
      .flatMap((element) => Object.keys(element.dataset).filter((key) => key.endsWith('Bound'))))].sort());
    const createBound = await bound();
    for (const key of ['appDialogBound', 'appDialogFormBound', 'noteDialogDirtyBound', 'notesEditorBound']) {
      expect(createBound).toContain(key);
    }
    const listeners = () => page.evaluate(() => window.__documentListeners);
    const withOneEditor = await listeners();

    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.opener).toBeFocused();

    // Each Create reads afresh and replaces the settled dialog; Edit shares the slot.
    await t.open();
    await expect(page.locator('#note-form')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    await t.edit(t.alpha).click();
    await expect(t.editDialog).toBeVisible();
    await expect(t.dialog).toHaveCount(0);
    for (const id of ['note-form', 'note-projects-form', 'note-assets-native']) {
      await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
    }
    await page.keyboard.press('Escape');
    await expect(t.editDialog).toBeHidden();
    await t.open();
    await expect(t.editDialog).toHaveCount(0);
    for (const id of ['note-form', 'note-projects-form', 'note-assets-native']) {
      await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
    }
    await expect(page.locator('[data-notes-editor-host] .toastui-editor-defaultUI')).toHaveCount(1);
    expect(await bound()).toEqual(createBound);
    await t.close.click();
    await expect(t.opener).toBeFocused();
    expect(t.log.gets).toHaveLength(3);
    await t.kept();
    // Replaced editors released their document listeners once their last toolbar update ran.
    await expect.poll(listeners, { timeout: 5000 }).toBe(withOneEditor);
  });
});

test('a Chapter or a Book location, the title, Markdown and Assets reach the WP6.2 POST once, announced once', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const before = t.notes();
    await t.open();
    await t.dialog.getByLabel('Note title').fill('Chapter Note');
    await t.editor.click();
    await page.keyboard.type('Plain then ');
    await t.dialog.locator('.toastui-editor-toolbar-icons.bold').click();
    await page.keyboard.type('bold words');
    await t.choose('Chapter: Lore / First Chapter');
    await expect(t.location).toHaveValue(`chapter:${t.chapter.id}`);
    // Only this project's Assets are offered, and the selector works beside the locked project.
    await expect(t.dialog.locator('#note-assets-form input[type="checkbox"]')).toHaveCount(1);
    await t.pickAsset();
    await expect(t.assetInput(t.art.id)).toBeChecked();

    const post = await hold(page, t.createPath, 'POST');
    await t.create.click();
    await post.arrived;
    await expect(t.dialog.locator('[data-dialog-status]')).toHaveText('Creating Note…');
    await expect(t.dialog.locator('#note-form')).toHaveAttribute('aria-busy', 'true');
    // Pending: no dismissal, no second POST.
    await page.keyboard.press('Escape');
    await t.close.click({ force: true });
    await t.title.press('Enter').catch(() => {});
    await t.dialog.locator('#note-form').evaluate((form) => form.requestSubmit());
    await expect(t.dialog).toBeVisible();
    await expect(t.confirmation).toBeHidden();
    expect(await t.created()).toEqual([]);
    post.release();

    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(1);
    const body = new URLSearchParams(t.log.posts[0].postData());
    expect(body.get('title')).toBe('Chapter Note');
    expect(body.get('content')).toBe('Plain then **bold words**');
    expect(body.get('targetContainer')).toBe(`chapter:${t.chapter.id}`);
    // The form's own empty marker field, then the chosen Asset.
    expect(body.getAll('assetIds[]').filter(Boolean)).toEqual([String(t.art.id)]);
    expect(body.getAll('projectIds[]')).toEqual([]);
    expect(body.get('_csrf')).toBeTruthy();
    expect(t.log.posts[0].headers().accept).toBe('application/json');

    const [createdId] = t.notes().filter((id) => !before.includes(id));
    expect(t.noteService.getNote(createdId)).toMatchObject({
      title: 'Chapter Note', content: 'Plain then **bold words**', chapter_id: t.chapter.id, book_id: t.book.id,
      projectIds: [t.project.id], assetIds: [t.art.id],
    });
    expect(await t.created()).toEqual([{
      noteId: String(createdId), projectId: String(t.project.id), pageId: createdId,
      dialogId: 'project-note-create-dialog', dialogOpen: false,
    }]);
    await expect(t.feedback).toContainText('Note “Chapter Note” created.');
    await expect(t.feedback).toHaveClass(/notice--success/);
    await expect(t.feedback.locator('a[data-page-view]')).toHaveText('View Note');
    await expect(t.feedback.locator('a[data-page-view]')).toHaveAttribute('href', `/notes/${createdId}`);
    await expect(t.opener).toBeFocused();
    // The settled dialog is back at its rendered baseline: nothing chosen, nothing kept.
    await expect(t.location).toHaveValue('');
    await expect(t.title).toHaveValue('');
    expect(await t.markdown()).toBe('');
    await expect(t.assetInput(t.art.id)).not.toBeChecked();
    expect(await t.dialog.evaluate((node) => node.__creatorCrateAppDialogState.savedValues)).toMatchObject({ title: '', content: '' });
    // WP6.5: the server render brings the new card in, collapsed (unpinned).
    await expect(t.card(createdId)).toHaveCount(1);
    await expect(t.card(createdId).locator('.project-related-note-title')).toHaveText('Chapter Note');
    await expect(t.disclosure(createdId)).toHaveAttribute('aria-expanded', 'false');
    await expect(t.card(createdId).locator(`[data-project-related-note-asset="${t.art.id}"]`)).toHaveCount(1);
    expect(t.log.refreshes).toEqual([`GET ${t.hostPath}`]);
    expect(await page.evaluate(() => window.__edited)).toEqual([]);
    await t.kept();

    // A Book's direct Pages, with no Assets, chosen by keyboard.
    await t.open();
    await expect(t.location).toHaveValue('');
    await t.title.fill('Book Note');
    await t.locationSummary.focus();
    await page.keyboard.press('Enter');
    const bookOption = t.dialog.locator('#note-location-dropdown input[type="radio"]').nth(1);
    await bookOption.focus();
    await page.keyboard.press('Space');
    await expect(t.location).toHaveValue(`book:${t.book.id}`);
    // A single choice closes the list itself; Escape is only for a list left open.
    if (await t.dialog.locator('#note-location-dropdown[open]').count()) await page.keyboard.press('Escape');
    await expect(t.dialog).toBeVisible();
    await expect(t.confirmation).toBeHidden();
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    const bookId = t.notes().filter((id) => !before.includes(id)).pop();
    expect(t.noteService.getNote(bookId)).toMatchObject({
      title: 'Book Note', book_id: t.book.id, chapter_id: null, projectIds: [t.project.id], assetIds: [],
    });
    expect((await t.created()).map((entry) => entry.noteId)).toEqual([String(createdId), String(bookId)]);
    expect(t.log.posts).toHaveLength(2);
    await expect(t.card(bookId)).toHaveCount(1);
    await expect(page.locator('[data-project-related-note]')).toHaveCount(3);
    expect(t.log.refreshes).toEqual([`GET ${t.hostPath}`, `GET ${t.hostPath}`]);
    await t.kept();
  });
});

test('location, title, Markdown and Asset changes are each unsaved changes; Keep Editing keeps them, Discard resets', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await t.open();

    // Location only.
    await t.choose('Book: Lore (direct Pages)');
    await t.close.click();
    await expect(t.confirmation).toBeVisible();
    await expect(t.confirmation).toHaveAccessibleName('Discard changes?');
    await t.confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(t.dialog).toBeVisible();
    await expect(t.location).toHaveValue(`book:${t.book.id}`);
    // Back to no location is clean again.
    await t.choose('Choose a Book or Chapter');
    await expect(t.location).toHaveValue('');
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();

    // Title, Markdown and Assets, each alone.
    for (const change of [
      () => t.title.fill('Draft title'),
      () => t.type('Draft words'),
      () => t.pickAsset(),
    ]) {
      await t.open();
      await change();
      // Close, since the editor surface keeps Escape for itself.
      await t.close.click();
      await expect(t.confirmation).toBeVisible();
      await t.confirmation.getByRole('button', { name: 'Cancel' }).click();
      await expect(t.dialog).toBeVisible();
      await t.close.click();
      await t.confirmation.getByRole('button', { name: 'Discard' }).click();
      await expect(t.dialog).toBeHidden();
      await expect(t.opener).toBeFocused();
    }

    // Everything at once: Keep Editing keeps it all; Discard restores the baseline.
    await t.open();
    await t.title.fill('Kept title');
    await t.type('Kept words');
    await t.choose('Chapter: Lore / First Chapter');
    await t.pickAsset();
    await t.close.click();
    await t.confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(t.title).toHaveValue('Kept title');
    expect(await t.markdown()).toBe('Kept words');
    await expect(t.location).toHaveValue(`chapter:${t.chapter.id}`);
    await expect(t.assetInput(t.art.id)).toBeChecked();
    // Edit cannot be reached behind the modal, and asking for Create changes nothing.
    expect(await page.evaluate(() => window.__openCreate())).toBe(false);
    await expect(t.title).toHaveValue('Kept title');
    await t.close.click();
    await t.confirmation.getByRole('button', { name: 'Discard' }).click();
    await expect(t.dialog).toBeHidden();
    await expect(t.title).toHaveValue('');
    expect(await t.markdown()).toBe('');
    await expect(t.location).toHaveValue('');
    await expect(t.locationSummary).toContainText('Choose a Book or Chapter');
    await expect(t.assetInput(t.art.id)).not.toBeChecked();
    expect(t.log.posts).toHaveLength(0);
    expect(await t.created()).toEqual([]);
    await t.kept();
  });
});

test('refused and failed creates keep the draft, announce nothing, stay editable and never resend', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const before = t.notes();
    await t.open();
    await t.title.fill('Draft Note');
    await t.type('Draft body');
    await t.pickAsset();

    // No location: refused by the server, shown on the location field.
    await t.create.click();
    const locationError = t.dialog.locator('[data-dialog-field="targetContainer"] .field-error-message');
    await expect(locationError).toHaveText('Choose a Book or Chapter for this Note.');
    await expect(t.locationSummary).toHaveAttribute('aria-invalid', 'true');
    await expect(t.dialog).toBeVisible();

    // No title: the chosen location and Assets stay.
    await t.choose('Chapter: Lore / First Chapter');
    await t.title.fill('');
    await t.create.click();
    await expect(t.dialog.locator('#note-create-title-error')).toHaveText('Title is required.');
    await expect(t.title).toBeFocused();
    await expect(t.location).toHaveValue(`chapter:${t.chapter.id}`);
    await expect(t.assetInput(t.art.id)).toBeChecked();
    expect(await t.markdown()).toBe('Draft body');
    await expect(locationError).toHaveCount(0);

    // Refusals are not unresolved outcomes: Create stays usable.
    expect(await unresolved(t)).toBe(false);
    await expect(t.create).toBeEnabled();

    // A server failure the route names (rolled back, nothing written) is a
    // confirmed failure, not an unknown outcome.
    await t.title.fill('Draft Note');
    await page.route(`**${t.createPath}`, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"status":"error","code":"PAGE_OPERATION_FAILED","message":"The Note could not be created."}' })
      : route.fallback()), { times: 1 });
    await t.create.click();
    await expect(t.summary).toContainText('The Note could not be created.');
    await expect(t.summary).not.toContainText('Could not confirm');
    await expect(t.dialog).toBeVisible();
    expect(await unresolved(t)).toBe(false);
    await expect(t.title).toHaveValue('Draft Note');
    expect(await t.markdown()).toBe('Draft body');
    await expect(t.location).toHaveValue(`chapter:${t.chapter.id}`);
    await expect(t.assetInput(t.art.id)).toBeChecked();
    expect(await t.created()).toEqual([]);
    expect(t.notes()).toEqual(before);
    expect(t.log.posts).toHaveLength(3);
    // Nothing read Project Detail meanwhile.
    expect(await page.evaluate(() => performance.getEntriesByType('resource')
      .filter((entry) => new URL(entry.name).pathname === location.pathname).length)).toBe(0);

    // The user's own retry creates exactly once.
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.posts).toHaveLength(4);
    expect(t.notes()).toHaveLength(before.length + 1);
    expect(await t.created()).toHaveLength(1);
    await t.kept();
  });
});

test('loads that fail, lose their turn or outlive their page mount nothing, and Edit and Create supersede each other', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const newPath = `**${t.createPath}/new`;
    const failures = [
      [(route) => route.abort('failed'), 'Create Note could not be opened. Try again.'],
      [(route) => route.fulfill({ status: 500, contentType: 'text/html', body: '<html><body>Error</body></html>' }), 'Create Note could not be opened.'],
      [(route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }), 'Create Note could not be opened.'],
      [(route) => route.fulfill({ status: 401, contentType: 'text/html', body: '' }), 'sign-in has expired'],
      [(route) => route.fulfill({ status: 302, headers: { location: '/login' } }), 'sign-in has expired'],
      [(route) => route.fulfill({ status: 404, contentType: 'text/html', body: 'Not found' }), 'This project is no longer available'],
      // Unrelated or malformed markup: another project's form, an open dialog,
      // a plain Notes create, or two forms.
      [(route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<dialog id="project-note-create-dialog" data-app-dialog><form id="note-form" method="post" action="/notes/projects/${t.other.id}" data-dialog-form data-notes-editor-form data-note-dialog-dirty data-dialog-async="true"><script type="application/json" data-note-dialog-baseline>{"title":"","content":"","targetContainer":""}</script><section data-note-location></section></form></dialog>` }), 'Create Note could not be opened.'],
      [(route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<dialog id="project-note-create-dialog" data-app-dialog open><form id="note-form" method="post" action="${t.createPath}" data-dialog-form data-notes-editor-form data-note-dialog-dirty data-dialog-async="true"><script type="application/json" data-note-dialog-baseline>{"title":"","content":"","targetContainer":""}</script><section data-note-location></section></form></dialog>` }), 'Create Note could not be opened.'],
      [(route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<dialog id="project-note-create-dialog" data-app-dialog><form id="note-form" method="post" action="${t.createPath}" data-dialog-form data-notes-editor-form data-note-dialog-dirty data-dialog-async="true"><script type="application/json" data-note-dialog-baseline>{"title":"","content":""}</script></form></dialog>` }), 'Create Note could not be opened.'],
    ];
    for (const [failure, message] of failures) {
      await page.route(newPath, failure, { times: 1 });
      await t.opener.click();
      await expect(t.feedback).toContainText(message);
      await expect(t.feedback).toHaveClass(/notice--error/);
      await expect(t.feedback).toHaveAttribute('role', 'status');
      await expect(t.dialog).toHaveCount(0);
      await expect(t.opener).not.toHaveAttribute('aria-busy', 'true');
      await expect(t.opener).toBeFocused();
      await t.kept();
    }
    expect(await t.results()).toEqual(failures.map(() => false));

    // Repeated requests read once.
    t.log.gets.length = 0;
    await t.opener.dblclick();
    await expect(t.dialog).toBeVisible();
    expect(t.log.gets).toHaveLength(1);
    await t.close.click();

    // Edit asked for while Create loads wins; Create's late answer mounts nothing.
    const createGet = await hold(page, `${t.createPath}/new`, 'GET');
    await t.opener.click();
    await createGet.arrived;
    await expect(t.opener).toHaveAttribute('aria-busy', 'true');
    await t.edit(t.alpha).click();
    await expect(t.editDialog).toBeVisible();
    await expect(t.opener).not.toHaveAttribute('aria-busy', 'true');
    createGet.release((route) => route.fallback().catch(() => {}));
    await page.waitForTimeout(300);
    await expect(t.editDialog).toBeVisible();
    await expect(t.dialog).toHaveCount(0);
    await page.unrouteAll({ behavior: 'wait' });

    // Create asked for while Edit holds a draft is refused, and the draft stays.
    await t.editDialog.locator('[name="title"]').fill('Alpha draft');
    expect(await page.evaluate(() => window.__openCreate())).toBe(false);
    await expect(t.editDialog.locator('[name="title"]')).toHaveValue('Alpha draft');
    await t.editDialog.getByRole('button', { name: 'Close Edit Page' }).click();
    await t.confirmation.getByRole('button', { name: 'Discard' }).click();
    await expect(t.editDialog).toBeHidden();

    // Create asked for while Edit loads wins; Edit's late answer mounts nothing.
    const editGet = await hold(page, `/notes/${t.alpha.id}`, 'GET');
    await t.edit(t.alpha).click();
    await editGet.arrived;
    await t.opener.click();
    await expect(t.dialog).toBeVisible();
    editGet.release((route) => route.fallback().catch(() => {}));
    await page.waitForTimeout(300);
    await expect(t.dialog).toBeVisible();
    await expect(t.editDialog).toHaveCount(0);
    await expect(t.edit(t.alpha)).not.toHaveAttribute('aria-busy', 'true');
    await t.close.click();
    await page.unrouteAll({ behavior: 'wait' });

    // The page's project changing under a load (a retired page) mounts nothing.
    const retired = await hold(page, `${t.createPath}/new`, 'GET');
    const result = page.evaluate(() => window.__openCreate());
    await retired.arrived;
    await page.evaluate(() => document.querySelector('[data-project-detail]').setAttribute('data-project-detail', '999999'));
    retired.release();
    expect(await result).toBe(false);
    await expect(t.dialog).toBeHidden();
    await t.kept();
  });
});

test('an open Create draft cannot be replaced by Edit, and a created note leaves Edit and Pin working', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await t.open();
    await t.title.fill('Unsaved create');
    // Nothing behind the modal dialog can start an Edit.
    expect(await t.edit(t.alpha).evaluate((node) => document.elementFromPoint(
      node.getBoundingClientRect().x + 2, node.getBoundingClientRect().y + 2,
    ) === node)).toBe(false);
    // Even a programmatic click on Edit is refused while the draft is open.
    await t.edit(t.alpha).evaluate((node) => node.click());
    await page.waitForTimeout(200);
    await expect(t.dialog).toBeVisible();
    await expect(t.editDialog).toHaveCount(0);
    await expect(t.title).toHaveValue('Unsaved create');
    expect(t.log.editGets).toEqual([]);

    await t.choose('Chapter: Lore / First Chapter');
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    expect(await t.created()).toHaveLength(1);

    // Edit replaces the settled Create dialog and saves as before.
    await t.edit(t.alpha).click();
    await expect(t.editDialog).toBeVisible();
    await expect(t.dialog).toHaveCount(0);
    await t.editDialog.locator('[name="title"]').fill('Alpha Edited');
    await t.editDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(t.editDialog).toBeHidden();
    expect(t.noteService.getNote(t.alpha.id).title).toBe('Alpha Edited');
    expect(await page.evaluate(() => window.__edited)).toEqual(['saved']);
    expect(await t.created()).toHaveLength(1);
    const pin = page.locator(`[data-project-related-note-pin="${t.alpha.id}"]`);
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await t.kept();
  });
});

test('WP6.4-F1 A / WP6-F4 A: a create the server committed whose answer was lost stays unresolved; it closes and reopens intact, never replaced or resent', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const before = t.notes();
    await fillDraft(t, page);
    // The request reaches the server and commits; only its answer is dropped.
    let committed = false;
    await page.route(`**${t.createPath}`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch();
      committed = response.status() === 201;
      return route.abort('connectionreset');
    }, { times: 1 });
    await t.create.click();
    await expect(t.summary).toContainText('Could not confirm whether the Note was created.');
    expect(committed).toBe(true);
    const created = t.notes().filter((id) => !before.includes(id));
    expect(created).toHaveLength(1);
    await expectHeld(t, page, { posts: 1 });
    // Still exactly the one Note the lost request created.
    expect(t.notes().filter((id) => !before.includes(id))).toEqual(created);
    await t.kept();
  });
});

test('WP6.4-F1 B / WP6-F4 D: a status-only 201 confirms nothing and holds the draft unresolved across close and reopen', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const before = t.notes();
    await fillDraft(t, page);
    await page.route(`**${t.createPath}`, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 201, contentType: 'application/json', body: '{"status":"success"}' })
      : route.fallback()), { times: 1 });
    await t.create.click();
    await expectHeld(t, page, { posts: 1 });
    expect(t.notes()).toEqual(before);
    await t.kept();
  });
});

test('WP6.4-F1 D: acknowledgements with missing, malformed or contradictory identity confirm nothing', async ({ page }) => {
  // Nine acknowledgements, each held through every close and reopen (WP6-F4).
  test.setTimeout(480_000);
  await withProject(page, async (t) => {
    const page201 = (overrides = {}) => ({
      status: 'success',
      message: 'Note “Held Note” created.',
      page: { id: 999, title: 'Held Note', url: '/notes/999' },
      project: { id: t.project.id, url: `/projects/${t.project.id}` },
      values: { title: '', content: '' },
      ...overrides,
    });
    const cases = [
      ['missing Note id', 201, page201({ page: { title: 'Held Note', url: '/notes/999' } })],
      ['zero Note id', 201, page201({ page: { id: 0, title: 'Held Note', url: '/notes/0' } })],
      ['non-canonical Note id', 201, page201({ page: { id: '0999', title: 'Held Note', url: '/notes/0999' } })],
      ['array Note id', 201, page201({ page: { id: [999], title: 'Held Note', url: '/notes/999' } })],
      ['contradictory Note URL', 201, page201({ page: { id: 999, title: 'Held Note', url: '/notes/998' } })],
      ['missing Project', 201, page201({ project: undefined })],
      ['mismatched Project', 201, page201({ project: { id: t.other.id, url: `/projects/${t.other.id}` } })],
      ['contradictory Project URL', 201, page201({ project: { id: t.project.id, url: `/projects/${t.other.id}` } })],
      ['not a 201', 200, page201()],
    ];
    for (const [, status, body] of cases) {
      t.log.posts.length = 0;
      await t.visit();
      await fillDraft(t, page);
      await page.route(`**${t.createPath}`, (route) => (route.request().method() === 'POST'
        ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
        : route.fallback()), { times: 1 });
      await t.create.click();
      await expectHeld(t, page, { posts: 1 });
      await page.unrouteAll({ behavior: 'wait' });
    }
    await t.kept();
  });
});

test('WP6.4-F1 C/E: a refusal stays editable, and a whole acknowledgement confirms once and leaves Create and Edit fresh', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const before = t.notes();
    await t.open();
    await t.title.fill('Confirmed Note');
    await t.type('Confirmed body');
    await t.pickAsset();
    // E: a 422 refusal keeps the draft, shows the field error and is not held.
    await t.create.click();
    await expect(t.dialog.locator('[data-dialog-field="targetContainer"] .field-error-message'))
      .toHaveText('Choose a Book or Chapter for this Note.');
    expect(await unresolved(t)).toBe(false);
    await expect(t.create).toBeEnabled();
    await expect(t.title).toHaveValue('Confirmed Note');
    expect(await t.markdown()).toBe('Confirmed body');
    await expect(t.assetInput(t.art.id)).toBeChecked();
    expect(await t.created()).toEqual([]);

    // C: the real WP6.2 201.
    await t.choose('Chapter: Lore / First Chapter');
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    const [createdId] = t.notes().filter((id) => !before.includes(id));
    expect(await t.created()).toEqual([{
      noteId: String(createdId), projectId: String(t.project.id), pageId: createdId,
      dialogId: 'project-note-create-dialog', dialogOpen: false,
    }]);
    await expect(t.feedback).toContainText('Note “Confirmed Note” created.');
    await expect(t.opener).toBeFocused();
    expect(t.log.posts).toHaveLength(2);

    // A fresh Create, then Edit, both usable.
    await t.open();
    expect(await unresolved(t)).toBe(false);
    await expect(t.title).toHaveValue('');
    expect(await t.markdown()).toBe('');
    await expect(t.location).toHaveValue('');
    await expect(t.assetInput(t.art.id)).not.toBeChecked();
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await t.edit(t.alpha).click();
    await expect(t.editDialog).toBeVisible();
    await t.editDialog.locator('[name="title"]').fill('Alpha After Create');
    await t.editDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(t.editDialog).toBeHidden();
    expect(t.noteService.getNote(t.alpha.id).title).toBe('Alpha After Create');
    expect(await t.created()).toHaveLength(1);
    await t.kept();
  });
});

// ─── WP6.5: the always-visible section, its Create new note, and the refresh ───

const PIN_PREFIX = 'creatorcrate:related-notes:v1:note:';

// Replaces Related Notes through the page's own refresh (as a Project Edit save
// does), and waits for the new region.
async function refreshRegion(page, projectId) {
  await page.evaluate((id) => {
    window.__oldRegion = document.querySelector('[data-project-related-notes-region]');
    document.dispatchEvent(new CustomEvent('project-edit-saved', { detail: { projectId: id } }));
  }, projectId);
  await expect.poll(() => page.evaluate(() => window.__oldRegion.isConnected === false
    && Boolean(document.querySelector('[data-project-related-notes-region]')))).toBe(true);
}

test('WP6.5: an empty section shows Create new note; created notes appear in place, keeping expansion, pins, focus and scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await withProject(page, async (t) => {
    // No qualifying note: the section, heading, empty state and action still show.
    t.noteService.updateNote(t.alpha.id, { title: 'Alpha Page', content: 'Alpha body', projectIds: [] });
    await t.visit();
    await expect(page.locator('[data-project-detail-region="related-notes"]')).toHaveCount(1);
    await expect(t.section).toHaveCount(1);
    await expect(t.section.locator('#project-related-notes-heading')).toHaveText('Related Notes');
    await expect(t.section.locator('[data-project-related-notes-empty]')).toHaveText('No related notes yet.');
    await expect(page.locator('[data-project-related-note]')).toHaveCount(0);
    await expect(t.opener).toHaveCount(1);
    await expect(t.opener).toHaveAccessibleName('Create new note');
    await expect(t.opener).toBeVisible();
    // Above Releases, with nothing between them.
    expect(await t.section.evaluate((section) => section.parentElement.nextElementSibling
      .matches('.project-detail-releases'))).toBe(true);

    // Empty -> populated: keyboard opens it in place; Create brings the card in.
    const before = t.notes();
    await t.opener.focus();
    await page.keyboard.press('Enter');
    await expect(t.dialog).toBeVisible();
    await expect(t.editor).toBeVisible();
    await t.title.fill('First Note');
    await t.type('First body');
    await t.choose('Chapter: Lore / First Chapter');
    await t.pickAsset();
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    const [first] = t.notes().filter((id) => !before.includes(id));
    await expect(t.card(first)).toHaveCount(1);
    await expect(t.section.locator('[data-project-related-notes-empty]')).toHaveCount(0);
    await expect(page.locator('#project-related-notes-heading')).toHaveCount(1);
    await expect(page.locator('[data-project-related-notes-region]')).toHaveCount(1);
    await expect(t.disclosure(first)).toHaveAttribute('aria-expanded', 'false');
    await expect(t.disclosure(first)).toContainText('Show note');
    await expect(t.card(first).locator(`[data-project-related-note-asset="${t.art.id}"]`)).toHaveCount(1);
    await expect(t.opener).toBeFocused();
    await expect(t.feedback).toContainText('Note “First Note” created.');
    await expect(t.refreshNote).toHaveCount(0);
    expect(t.log.refreshes).toEqual([`GET ${t.hostPath}`]);
    expect(t.log.posts).toHaveLength(1);
    expect(t.noteService.getNote(first)).toMatchObject({ chapter_id: t.chapter.id, projectIds: [t.project.id], assetIds: [t.art.id] });

    // The first note is expanded by hand; the next id is already pinned here.
    await t.disclosure(first).click();
    await expect(t.disclosure(first)).toContainText('Hide note');
    const next = Math.max(...t.notes()) + 1;
    await page.evaluate((key) => localStorage.setItem(key, '1'), `${PIN_PREFIX}${next}`);
    await t.opener.click();
    await expect(t.dialog).toBeVisible();
    await t.title.fill('Second Note');
    await t.type('Second body');
    await t.choose('Book: Lore');
    const scrolled = await page.evaluate(() => {
      window.scrollTo(0, 120);
      return window.scrollY;
    });
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.card(next)).toHaveCount(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    // Kept, pinned default, and no pin rewritten or added.
    await expect(t.disclosure(first)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.disclosure(next)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.disclosure(next)).toContainText('Hide note');
    await expect(t.card(next).locator('.notes-content')).toContainText('Second body');
    await expect(page.locator(`[data-project-related-note-pin="${next}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`[data-project-related-note-pin="${first}"]`)).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)), PIN_PREFIX))
      .toEqual([`${PIN_PREFIX}${next}`]);
    // Every card bound once: each press toggles exactly once.
    await expect(page.locator('[data-project-related-note]:not([data-project-related-note-bound="true"])')).toHaveCount(0);
    await t.disclosure(next).click();
    await expect(t.disclosure(next)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(`[data-project-related-note-pin="${next}"]`)).toHaveAttribute('aria-pressed', 'true');
    await t.disclosure(first).click();
    await expect(t.disclosure(first)).toHaveAttribute('aria-expanded', 'false');
    // Manual expansion never pinned anything; the pin survives a reload.
    expect(await page.evaluate((key) => localStorage.getItem(key), `${PIN_PREFIX}${first}`)).toBeNull();
    expect(t.log.posts).toHaveLength(2);
    expect(t.log.refreshes).toEqual([`GET ${t.hostPath}`, `GET ${t.hostPath}`]);
    await t.kept();
    await t.visit();
    await expect(t.disclosure(next)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.disclosure(first)).toHaveAttribute('aria-expanded', 'false');
  });
});

test('WP6.5: a created note whose refresh fails stays created; Retry only reads, and a failed Notes read is no refresh', async ({ page }) => {
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
    const before = t.notes();
    await t.open();
    await t.title.fill('Retry Note');
    await t.choose('Chapter: Lore / First Chapter');
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    const created = t.notes().filter((id) => !before.includes(id));
    expect(created).toHaveLength(1);
    await expect(t.feedback).toContainText('Note “Retry Note” created.');
    await expect(t.feedback).toHaveClass(/notice--success/);
    await expect(t.feedback).not.toContainText(/not created|could not be created/i);
    await expect(t.refreshNote).toHaveText('Related Notes could not be updated, so they may be out of date.');
    await expect(t.retry).toHaveText('Retry refresh');
    await expect(t.card(created[0])).toHaveCount(0);
    await expect(t.card(t.alpha.id)).toHaveCount(1);
    await expect(t.opener).toBeEnabled();

    // HTTP 200 whose Notes read failed: not a refresh; the cards and Retry stay.
    const service = t.noteService;
    const read = service.listRelatedNotesForProject;
    service.listRelatedNotesForProject = () => { throw new Error('SQLITE_BUSY'); };
    await t.retry.click();
    await expect.poll(() => t.log.refreshes.length).toBe(2);
    await expect(t.retry).toBeVisible();
    await expect(t.card(t.alpha.id)).toHaveCount(1);
    await expect(page.locator('[data-project-related-notes-error]')).toHaveCount(0);
    await expect(t.opener).toBeVisible();
    service.listRelatedNotesForProject = read;

    // Retry from the keyboard recovers; focus goes to Create new note, not the new note.
    await t.retry.focus();
    await page.keyboard.press('Enter');
    await expect(t.card(created[0])).toHaveCount(1);
    await expect(t.refreshNote).toHaveCount(0);
    await expect(t.retry).toHaveCount(0);
    await expect(t.opener).toBeFocused();
    await expect(t.feedback).toContainText('Note “Retry Note” created.');
    expect(t.log.posts).toHaveLength(1);
    expect(t.log.refreshes).toEqual([`GET ${t.hostPath}`, `GET ${t.hostPath}`, `GET ${t.hostPath}`]);
    expect(t.notes().filter((id) => !before.includes(id))).toEqual(created);

    // Create still opens afterwards.
    await t.open();
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await t.kept();
  });
});

test('WP6.5: Create new note survives region replacement, hands over while loading, and stale refreshes never win', async ({ page }) => {
  await page.addInitScript(() => {
    window.__documentClicks = 0;
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function patchedAdd(type, ...rest) {
      if (this === document && type === 'click') window.__documentClicks += 1;
      return add.call(this, type, ...rest);
    };
  });
  await withProject(page, async (t) => {
    await t.visit();

    // A refresh replacing the button while its dialog loads: the replacement
    // is the opener, and focus returns to it.
    const load = await hold(page, `${t.createPath}/new`, 'GET');
    await t.opener.click();
    await load.arrived;
    await expect(t.opener).toHaveAttribute('aria-busy', 'true');
    await refreshRegion(page, t.project.id);
    load.release();
    await expect(t.dialog).toBeVisible();
    await expect(t.editor).toBeVisible();
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.opener).toBeFocused();
    await expect(t.opener).not.toHaveAttribute('aria-busy', 'true');
    await page.unrouteAll({ behavior: 'wait' });

    // After several replacements: one press, one read, one dialog, one editor.
    // Replacing the region adds no document click listeners.
    const clicks = await page.evaluate(() => window.__documentClicks);
    await refreshRegion(page, t.project.id);
    await refreshRegion(page, t.project.id);
    expect(await page.evaluate(() => window.__documentClicks)).toBe(clicks);
    t.log.gets.length = 0;
    await t.opener.dblclick();
    await expect(t.dialog).toBeVisible();
    await page.waitForTimeout(200);
    expect(t.log.gets).toHaveLength(1);
    await expect(page.locator('#project-note-create-dialog')).toHaveCount(1);
    await expect(page.locator('#note-form')).toHaveCount(1);
    await t.close.click();
    await expect(t.dialog).toBeHidden();

    // The creation's refresh answers late, after a newer refresh: it is dropped.
    const stale = await page.evaluate(async (path) => (await fetch(path, { cache: 'no-store' })).text(), t.hostPath);
    const late = await hold(page, t.hostPath, 'GET');
    const before = t.notes();
    await t.open();
    await t.title.fill('Raced Note');
    await t.choose('Chapter: Lore / First Chapter');
    await t.create.click();
    await expect(t.dialog).toBeHidden();
    await late.arrived;
    const [raced] = t.notes().filter((id) => !before.includes(id));
    await refreshRegion(page, t.project.id);
    await expect(t.card(raced)).toHaveCount(1);
    late.release((route) => route.fulfill({ status: 200, contentType: 'text/html', body: stale }));
    await page.waitForTimeout(300);
    await expect(t.card(raced)).toHaveCount(1);
    await expect(t.refreshNote).toHaveCount(0);
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

// ─── WP6-F4: an unresolved Create Note closes and reopens without loss ───

test('WP6-F4 B: a pending create blocks every dismissal and replacement; once unresolved, it closes and reopens', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const before = t.notes();
    await fillDraft(t, page);
    const post = await hold(page, t.createPath, 'POST');
    await t.create.click();
    await post.arrived;
    await expect(t.dialog.locator('#note-form')).toHaveAttribute('aria-busy', 'true');

    // Close, Escape and the backdrop dismiss nothing while it is in flight.
    await t.close.click();
    await page.keyboard.press('Escape');
    await page.mouse.click(4, 4);
    await page.waitForTimeout(150);
    await expect(t.dialog).toBeVisible();
    await expect(t.confirmation).toBeHidden();
    expect(await t.dialog.evaluate((node) => node.__creatorCrateAppDialogState.beforeClose({
      lifecycle: node.__creatorCrateAppDialogState.lifecycle, opener: null,
    }))).toBe(false);
    // Neither Edit nor Create replaces it.
    await t.edit(t.alpha).evaluate((node) => node.click());
    expect(await page.evaluate(() => window.__openCreate())).toBe(false);
    await page.waitForTimeout(150);
    await expect(t.editDialog).toHaveCount(0);
    expect(t.log.editGets).toEqual([]);

    // The answer is lost before it reaches the server: unresolved, and held.
    post.release((route) => route.abort('connectionreset'));
    await expectHeld(t, page, { posts: 1 });
    expect(t.notes()).toEqual(before);
    await t.kept();
  });
});

test('WP6-F4 C: repeated Create reopens the one kept dialog; a kept Create outlasts Edit attempts', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await fillDraft(t, page, 'Repeat Note');
    await page.route(`**${t.createPath}`, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 201, contentType: 'application/json', body: '{"status":"success"}' })
      : route.fallback()), { times: 1 });
    await t.create.click();
    await expect(t.summary).toContainText('Could not confirm whether the Note was created.');
    await markMounted(t);
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    const gets = t.log.gets.length;

    // Several presses at once: one reopen, nothing mounted, nothing read.
    await page.evaluate(() => { window.__createResults = []; });
    await t.opener.evaluate((node) => { node.click(); node.click(); node.click(); });
    await expect(t.dialog).toBeVisible();
    expect(await t.results()).toEqual([true, false, false]);
    expect(await sameMounted(t)).toBe(true);
    await expect(page.locator('#note-form')).toHaveCount(1);
    await expect(page.locator('.toastui-editor-defaultUI')).toHaveCount(1);
    expect(t.log.gets).toHaveLength(gets);

    // Typing into the kept draft goes into the one editor, once.
    await t.type(' more');
    expect(await t.markdown()).toBe('Held body more');
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.confirmation).toBeHidden();

    // Edit, twice, is refused each time; the kept Create stays mounted.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await t.edit(t.alpha).click();
      await expect(t.feedback).toContainText(KEPT_CREATE_MESSAGE);
    }
    await page.waitForTimeout(150);
    await expect(t.editDialog).toHaveCount(0);
    expect(t.log.editGets).toEqual([]);
    await t.opener.click();
    await expect(t.dialog).toBeVisible();
    expect(await sameMounted(t)).toBe(true);
    await expect(t.title).toHaveValue('Repeat Note');
    expect(await t.markdown()).toBe('Held body more');
    await expect(t.create).toBeDisabled();
    expect(t.log.posts).toHaveLength(1);
    expect(await t.created()).toEqual([]);
    await t.kept();
  });
});

test('WP6-F4 F: a Related Notes refresh while a kept Create is closed leaves it mounted, and the new Create new note reopens it', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await fillDraft(t, page);
    await page.route(`**${t.createPath}`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fetch();
      return route.abort('connectionreset');
    }, { times: 1 });
    await t.create.click();
    await expect(t.summary).toContainText('Could not confirm whether the Note was created.');
    await markMounted(t);
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    const oldOpener = await t.opener.elementHandle();
    const gets = t.log.gets.length;

    t.log.refreshes.length = 0;
    await refreshRegion(page, t.project.id);
    expect(t.log.refreshes).toEqual([`GET ${t.hostPath}`]);
    expect(await oldOpener.evaluate((node) => node.isConnected)).toBe(false);
    // Still the one kept dialog, its draft and its lock, closed.
    await expect(t.dialog).toBeHidden();
    expect(await sameMounted(t)).toBe(true);
    await expectDraft(t, 'Held Note');

    // The replacement Create new note reopens it, and takes focus back.
    await t.opener.click();
    await expect(t.dialog).toBeVisible();
    expect(await sameMounted(t)).toBe(true);
    await expectDraft(t, 'Held Note');
    await t.close.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.opener).toBeFocused();
    expect(t.log.gets).toHaveLength(gets);
    expect(t.log.posts).toHaveLength(1);
    await expect(page.locator('#note-form')).toHaveCount(1);
    await expect(page.locator('.toastui-editor-defaultUI')).toHaveCount(1);
    expect(await t.created()).toEqual([]);
    // A tracked backdrop press that a close ended leaves no document listener.
    expect(await t.dialog.evaluate((node) => node.__creatorCrateAppDialogState.backdropPointer)).toBe(null);
    await t.kept();
  });
});
