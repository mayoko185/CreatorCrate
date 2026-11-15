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

// WP7.1: Project Detail refreshes Related Notes when the user returns to it
// (another tab or window, Back, a back-forward restoration). The return runs
// the existing Project Detail refresh (one GET, named regions replaced), once
// per return, never on an ordinary load or a move of focus within the page,
// and never through a Notes dialog mounted on the page.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

async function withProject(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-related-notes-refresh-'));
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
    const beta = noteService.createNote({ chapterId: chapter.id, title: 'Beta Page', content: 'Beta body', projectIds: [project.id] });
    const loose = noteService.createNote({ chapterId: chapter.id, title: 'Loose Page', content: 'Loose body', projectIds: [other.id] });
    const art = createAssetRepository(db).upsert(project.id, 'art/cover.png', {
      filename: 'cover.png', extension: 'png', mimeType: 'image/png', sizeBytes: 4096, modifiedAt: '2026-08-06 12:00:00',
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const hostPath = `/projects/${project.id}`;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const log = { refreshes: [], notePosts: [], projectPosts: [] };
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === hostPath && request.resourceType() === 'fetch' && request.method() === 'POST') log.projectPosts.push(pathname);
      else if (pathname === hostPath && request.resourceType() === 'fetch') log.refreshes.push(request.method());
      if (pathname.startsWith('/notes') && request.method() === 'POST') log.notePosts.push(pathname);
    });

    const t = {
      app, db, origin, project, other, book, chapter, alpha, beta, loose, art, noteService, projectService, log, hostPath,
      section: page.locator('[data-project-related-notes]'),
      card: (note) => page.locator(`[data-project-related-note="${note.id}"]`),
      cards: page.locator('[data-project-related-note]'),
      noteTitle: (note) => page.locator(`[data-project-related-note="${note.id}"] .project-related-note-title`),
      preview: (note) => page.locator(`[data-project-related-note-preview="${note.id}"]`),
      disclosure: (note) => page.locator(`[data-project-related-note-disclosure="${note.id}"]`),
      pin: (note) => page.locator(`[data-project-related-note-pin="${note.id}"]`),
      edit: (note) => page.locator(`[data-project-related-note-edit="${note.id}"]`),
      feedback: page.locator('[data-dialog-feedback]'),
      refreshNote: page.locator('[data-project-related-notes-refresh-note]'),
      retry: page.locator('[data-project-detail-return-refresh-retry]'),
      releases: page.locator('.project-detail-releases'),
      visit: async () => {
        await page.goto(origin + hostPath);
        await expect(page.locator('[data-project-related-note-editor][data-project-related-note-editor-bound="true"]')).toBeAttached();
        await page.evaluate(() => { window.__projectDetailDocument = true; });
      },
      sameDocument: async () => {
        expect(await page.evaluate(() => window.__projectDetailDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(hostPath);
      },
      // Settles one return-triggered refresh GET.
      refreshed: () => page.waitForResponse((response) => new URL(response.url()).pathname === hostPath
        && response.request().resourceType() === 'fetch' && response.request().method() === 'GET'),
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

// The lifecycle signals a browser sends when a tab or window is left and
// returned to. visibilityState is set as the browser would report it.
async function signal(page, ...steps) {
  await page.evaluate((list) => {
    const visibility = (value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    for (const step of list) {
      if (step === 'blur' || step === 'focus') window.dispatchEvent(new FocusEvent(step));
      else if (step === 'hidden' || step === 'visible') visibility(step);
      else if (step === 'pagehide' || step === 'pageshow') {
        window.dispatchEvent(new PageTransitionEvent(step, { persisted: true }));
      }
    }
  }, steps);
}

const leave = (page) => signal(page, 'blur', 'hidden');
const comeBack = (page) => signal(page, 'visible', 'focus');

// Holds the next matching request until release() says how to answer it.
async function hold(page, pathname, method) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  let held = false;
  await page.route((url) => url.pathname === pathname, async (route) => {
    if (route.request().method() !== method || route.request().resourceType() !== 'fetch' || held) {
      await route.fallback();
      return;
    }
    held = true;
    reached();
    await (await released)(route);
  });
  return { arrived, release: (answer = (route) => route.fallback()) => release(answer) };
}

test('A: a Notes Page edit shows on Project Detail after Back, and after a back-forward restoration', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Page');

    // Away on the Notes Page; the Page changes there (its own service path).
    await page.goto(`${t.origin}/notes/${t.alpha.id}`);
    t.noteService.updateNote(t.alpha.id, { title: 'Alpha Renamed', content: 'Alpha **rewritten**' });
    await page.goBack();
    await expect(page).toHaveURL(t.origin + t.hostPath);
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Renamed');
    await expect(t.feedback).toBeHidden();
    await expect(t.releases).toBeVisible();
    await expect(page.locator(`[data-project-detail="${t.project.id}"]`)).toBeAttached();
    await expect(page.locator('.app-section-title').first()).toContainText('Host Project');

    // A restoration from the back-forward cache keeps the old document, so the
    // page refreshes itself as the restoration is announced.
    await t.visit();
    const before = t.log.refreshes.length;
    t.noteService.updateNote(t.alpha.id, { title: 'Alpha Restored', content: 'Restored **body**' });
    await signal(page, 'pagehide', 'hidden');
    const done = t.refreshed();
    await signal(page, 'pageshow', 'visible', 'focus');
    await done;
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Restored');
    await t.disclosure(t.alpha).click();
    await expect(t.preview(t.alpha).locator('strong')).toHaveText('body');
    expect(t.log.refreshes.length - before).toBe(1);
    await t.sameDocument();
    expect(t.log.notePosts).toEqual([]);
  });
});

test('B/D: project and asset associations added or removed while away change membership; one GET per return', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    // An ordinary load and focus moving within the page refresh nothing.
    await t.edit(t.alpha).focus();
    await t.pin(t.alpha).focus();
    await page.waitForTimeout(300);
    expect(t.log.refreshes).toEqual([]);
    await expect(t.card(t.loose)).toHaveCount(0);

    // Project association added while away: visibilitychange then focus.
    await leave(page);
    t.noteService.updateNote(t.loose.id, { projectIds: [t.other.id, t.project.id] });
    let done = t.refreshed();
    await comeBack(page);
    await done;
    await expect(t.card(t.loose)).toBeVisible();
    await page.waitForTimeout(300);
    expect(t.log.refreshes).toEqual(['GET']);

    // Focus first, then visibilitychange: still one GET.
    await leave(page);
    t.noteService.updateNote(t.loose.id, { projectIds: [t.other.id], assetIds: [t.art.id] });
    done = t.refreshed();
    await signal(page, 'focus', 'visible');
    await done;
    // Kept through its asset of this project alone.
    await expect(t.card(t.loose)).toBeVisible();
    await page.waitForTimeout(300);
    expect(t.log.refreshes).toEqual(['GET', 'GET']);

    // Its final qualifying association removed: the card goes.
    await leave(page);
    t.noteService.updateNote(t.loose.id, { assetIds: [] });
    done = t.refreshed();
    await comeBack(page);
    await done;
    await expect(t.card(t.loose)).toHaveCount(0);

    // Every association gone: the section stays, empty.
    await leave(page);
    t.noteService.updateNote(t.alpha.id, { projectIds: [] });
    t.noteService.updateNote(t.beta.id, { projectIds: [] });
    done = t.refreshed();
    await comeBack(page);
    await done;
    await expect(t.cards).toHaveCount(0);
    await expect(t.section).toBeVisible();
    await expect(page.locator('[data-project-related-note-create]')).toBeVisible();

    // A return without a departure does nothing.
    await signal(page, 'focus', 'visible', 'focus');
    await page.waitForTimeout(300);
    expect(t.log.refreshes).toHaveLength(4);
    await expect(t.feedback).toBeHidden();
    await t.sameDocument();
    expect(t.log.notePosts).toEqual([]);
  });
});

test('C: a Page edited in another tab shows when this tab is returned to; expansion, pins and scroll survive', async ({ page }) => {
  await withProject(page, async (t) => {
    await page.setViewportSize({ width: 1100, height: 500 });
    await t.visit();
    // Beta pinned (shown); Alpha opened by hand.
    await t.pin(t.beta).click();
    await expect(t.pin(t.beta)).toHaveAttribute('aria-pressed', 'true');
    await t.disclosure(t.alpha).click();
    await expect(t.disclosure(t.alpha)).toHaveAttribute('aria-expanded', 'true');
    await t.disclosure(t.alpha).focus();
    await page.evaluate(() => window.scrollTo(0, 200));
    const scrollY = await page.evaluate(() => window.scrollY);

    await leave(page);
    const other = await page.context().newPage();
    await other.goto(`${t.origin}/notes/${t.alpha.id}/edit`);
    const dialog = other.locator('#note-edit-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('[name="title"]').fill('Alpha From Tab');
    const saved = other.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/notes/${t.alpha.id}`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await saved;
    await expect.poll(() => t.noteService.getNote(t.alpha.id).title).toBe('Alpha From Tab');
    // A note newly related while away starts from its stored pin (none).
    t.noteService.updateNote(t.loose.id, { projectIds: [t.project.id] });
    await other.close();

    await page.bringToFront();
    const done = t.refreshed();
    await comeBack(page);
    await done;
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha From Tab');
    await expect(t.disclosure(t.alpha)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.disclosure(t.alpha)).toHaveAccessibleName(/Hide note/);
    await expect(t.disclosure(t.alpha)).toBeFocused();
    await expect(t.pin(t.beta)).toHaveAttribute('aria-pressed', 'true');
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.disclosure(t.loose)).toHaveAttribute('aria-expanded', 'false');
    await expect(t.pin(t.loose)).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await t.sameDocument();
    // Nothing on Project Detail posted: the save was the other tab's.
    expect(t.log.notePosts).toEqual([]);
  });
});

test('E: a return follows a refresh in flight, and an older answer never overwrites a newer refresh', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    // A refresh in flight (a confirmed Project Edit save's) is followed, not superseded.
    const saveRefresh = await hold(page, t.hostPath, 'GET');
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent('project-edit-saved', { detail: { projectId: id } })), t.project.id);
    await saveRefresh.arrived;
    await leave(page);
    t.noteService.updateNote(t.alpha.id, { title: 'Alpha While Held' });
    await comeBack(page);
    await page.waitForTimeout(300);
    expect(t.log.refreshes).toEqual(['GET']);
    const followed = page.waitForResponse((response) => new URL(response.url()).pathname === t.hostPath
      && response.request().resourceType() === 'fetch' && t.log.refreshes.length === 2);
    saveRefresh.release();
    await followed;
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha While Held');
    await expect(t.feedback).toContainText('Project updated.');

    // A held return GET carrying an old render loses to a newer save refresh.
    const oldHtml = await (await page.request.get(t.origin + t.hostPath)).text();
    const returnRefresh = await hold(page, t.hostPath, 'GET');
    await leave(page);
    await comeBack(page);
    await returnRefresh.arrived;
    t.noteService.updateNote(t.alpha.id, { title: 'Alpha Newest' });
    const newer = t.refreshed();
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent('project-edit-saved', { detail: { projectId: id } })), t.project.id);
    await newer;
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Newest');
    returnRefresh.release((route) => route.fulfill({ status: 200, contentType: 'text/html', body: oldHtml }).catch(() => {}));
    await page.waitForTimeout(500);
    await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Newest');
    await expect(t.refreshNote).toHaveCount(0);
    expect(t.log.notePosts).toEqual([]);
  });
});

test('F: a failed return refresh keeps the cards, says so neutrally, and a GET-only Retry recovers', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const failing = (url) => url.pathname === t.hostPath;
    await page.route(failing, (route) => (route.request().resourceType() === 'fetch'
      ? route.fulfill({ status: 500, contentType: 'text/html', body: '<p>Internal detail</p>' })
      : route.fallback()));
    t.noteService.updateNote(t.loose.id, { projectIds: [t.project.id] });
    await leave(page);
    await comeBack(page);
    await expect(t.refreshNote).toHaveText('Project Detail could not check for changes, so Related Notes may be out of date.');
    await expect(t.feedback).toBeVisible();
    await expect(t.feedback).not.toContainText(/saved|created|Internal detail/i);
    await expect(t.retry).toHaveText('Retry refresh');
    await expect(t.card(t.alpha)).toBeVisible();
    await t.disclosure(t.alpha).click();
    await expect(t.disclosure(t.alpha)).toHaveAttribute('aria-expanded', 'true');

    await page.unroute(failing);
    const done = t.refreshed();
    await t.retry.click();
    await done;
    await expect(t.card(t.loose)).toBeVisible();
    await expect(t.disclosure(t.alpha)).toHaveAttribute('aria-expanded', 'true');
    await expect(t.retry).toHaveCount(0);
    await expect(t.feedback).toBeHidden();
    await expect(page.locator('#main-content')).toBeFocused();
    expect(t.log.refreshes).toEqual(['GET', 'GET']);
    expect(t.log.notePosts).toEqual([]);

    // A render whose Notes read failed is not taken as Related Notes refreshed.
    t.noteService.updateNote(t.alpha.id, { title: 'Alpha Unread' });
    const original = t.noteService.listRelatedNotesForProject;
    t.noteService.listRelatedNotesForProject = () => { throw new Error('read failed'); };
    try {
      await leave(page);
      const failed = t.refreshed();
      await comeBack(page);
      await failed;
      await expect(t.refreshNote).toContainText('Related Notes may be out of date');
      await expect(t.noteTitle(t.alpha)).toHaveText('Alpha Page');
      await expect(page.locator('[data-project-related-notes-state="unavailable"]')).toHaveCount(0);
    } finally {
      t.noteService.listRelatedNotesForProject = original;
    }
  });
});

test('G: a return refresh leaves open Edit, Create and Edit Project dialogs and their drafts alone', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    // Notes Edit Page with an unsaved title.
    await t.edit(t.alpha).click();
    const editDialog = page.locator('#note-edit-dialog');
    await expect(editDialog).toBeVisible();
    await editDialog.locator('[name="title"]').fill('Alpha Draft');
    await editDialog.locator('[name="title"]').focus();
    await editDialog.evaluate((dialog) => { dialog.__marker = true; });
    t.noteService.updateNote(t.beta.id, { title: 'Beta Elsewhere' });
    await leave(page);
    let done = t.refreshed();
    await comeBack(page);
    await done;
    await expect(t.noteTitle(t.beta)).toHaveText('Beta Elsewhere');
    await expect(editDialog).toBeVisible();
    expect(await editDialog.evaluate((dialog) => dialog.__marker === true)).toBe(true);
    await expect(editDialog.locator('[name="title"]')).toHaveValue('Alpha Draft');
    await expect(editDialog.locator('[name="title"]')).toBeFocused();
    // Discarding returns focus to the replacement Edit, not a detached one.
    await editDialog.getByRole('button', { name: 'Close Edit Page' }).click();
    const confirmation = page.locator('#app-confirmation-dialog');
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: /Discard/ }).click();
    await expect(editDialog).toBeHidden();
    await expect(t.edit(t.alpha)).toBeFocused();
    expect(t.noteService.getNote(t.alpha.id).title).toBe('Alpha Page');

    // Create Note with an unsaved draft.
    await page.locator('[data-project-related-note-create]').click();
    const createDialog = page.locator('#project-note-create-dialog');
    await expect(createDialog).toBeVisible();
    await createDialog.locator('[name="title"]').fill('Held Note');
    await leave(page);
    done = t.refreshed();
    await comeBack(page);
    await done;
    await expect(createDialog).toBeVisible();
    await expect(createDialog.locator('[name="title"]')).toHaveValue('Held Note');
    await page.keyboard.press('Escape');

    // Edit Project: its Edit action is replaced under it; dismissal still
    // returns to the (new) Edit action.
    const confirmationOpen = await confirmation.isVisible();
    if (confirmationOpen) await confirmation.getByRole('button', { name: /Discard/ }).click();
    await expect(createDialog).toBeHidden();
    await page.locator(`[data-project-edit-id="${t.project.id}"]`).click();
    const projectDialog = page.locator('#project-edit-dialog');
    await expect(projectDialog).toBeVisible();
    await expect(projectDialog.locator('[name="title"]')).toHaveValue('Host Project');
    await leave(page);
    done = t.refreshed();
    await comeBack(page);
    await done;
    await expect(projectDialog).toBeVisible();
    await projectDialog.getByRole('button', { name: /Close|Cancel/ }).first().click();
    await expect(projectDialog).toBeHidden();
    await expect(page.locator(`[data-project-edit-id="${t.project.id}"]`)).toBeFocused();
    expect(t.log.notePosts).toEqual([]);
    await t.sameDocument();
  });
});

// WP7.1-F1: refresh failures share the page feedback with every other
// operation. A refresh clears only the failures it resolves, all of them, and
// never a message another operation wrote.
const STALE_SAVE = 'Project saved, but Project Detail could not refresh.';
const STALE_RETURN = 'Project Detail could not check for changes, so Related Notes may be out of date.';
const EDITOR_FAILURE = 'The Page editor could not be opened. Try again.';

// Saves Edit Project through its dialog while every Project Detail GET fetch
// fails; returns the switch that lets them through again.
async function saveProjectWithFailedRefresh(page, t, title) {
  const state = { fail: true };
  await page.route((url) => url.pathname === t.hostPath, (route) => (state.fail
    && route.request().method() === 'GET' && route.request().resourceType() === 'fetch'
    ? route.fulfill({ status: 500, contentType: 'text/html', body: '<p>Internal detail</p>' })
    : route.fallback()));
  await page.locator(`[data-project-edit-id="${t.project.id}"]`).click();
  const dialog = page.locator('#project-edit-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#title').fill(title);
  await dialog.locator('button[data-dialog-submit]').click();
  await expect(dialog).toBeHidden();
  await expect(t.feedback).toContainText(STALE_SAVE);
  await expect(page.locator('[data-project-detail-refresh-retry]')).toHaveCount(1);
  expect(t.log.projectPosts).toHaveLength(1);
  return state;
}

const anyRetry = (page) => page.locator('[data-project-detail-refresh-retry], [data-project-detail-return-refresh-retry]');

test('H: a save refresh failure and a later return failure both clear when a GET-only Retry recovers', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const network = await saveProjectWithFailedRefresh(page, t, 'Host Renamed');

    // Away and back: the return GET fails too, beside the save's failure.
    await leave(page);
    const failed = t.refreshed();
    await comeBack(page);
    await failed;
    await expect(t.refreshNote).toHaveText(STALE_RETURN);
    await expect(t.retry).toHaveCount(1);

    network.fail = false;
    const done = t.refreshed();
    await t.retry.click();
    await done;
    await expect(page.locator('.app-section-title').first()).toContainText('Host Renamed');
    await expect(t.refreshNote).toHaveCount(0);
    await expect(anyRetry(page)).toHaveCount(0);
    // Nothing on show still says Project Detail is out of date.
    await expect(t.feedback).toBeHidden();
    expect(await t.feedback.textContent()).not.toMatch(/could not refresh|out of date/);
    expect(t.log.projectPosts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET', 'GET', 'GET']);
    expect(t.log.notePosts).toEqual([]);
  });
});

test('I: a successful return refresh clears its own stale warning but keeps a newer Notes editor error', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const network = await saveProjectWithFailedRefresh(page, t, 'Host Renamed');

    await page.route(`**/notes/${t.alpha.id}`, (route) => route.abort('failed'), { times: 1 });
    await t.edit(t.alpha).click();
    await expect(t.feedback).toContainText(EDITOR_FAILURE);
    await expect(page.locator('#note-edit-dialog')).toBeHidden();

    network.fail = false;
    await leave(page);
    const done = t.refreshed();
    await comeBack(page);
    await done;
    await expect(page.locator('.app-section-title').first()).toContainText('Host Renamed');
    await page.waitForTimeout(200);
    // The editor error stays on show in the page's status notice.
    await expect(t.feedback).toBeVisible();
    await expect(t.feedback).toHaveAttribute('role', 'status');
    await expect(t.feedback).toHaveText(EDITOR_FAILURE);
    await expect(t.feedback).toHaveClass(/notice--error/);
    await expect(anyRetry(page)).toHaveCount(0);
    expect(t.log.projectPosts).toHaveLength(1);
    expect(t.log.notePosts).toEqual([]);
  });
});

test('J: feedback written while a return refresh is in flight survives its success and its failure', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const network = await saveProjectWithFailedRefresh(page, t, 'Host Renamed');
    network.fail = false;

    // A return GET held; the Notes editor fails meanwhile; the return succeeds.
    let held = await hold(page, t.hostPath, 'GET');
    await leave(page);
    await comeBack(page);
    await held.arrived;
    await page.route(`**/notes/${t.alpha.id}`, (route) => route.abort('failed'), { times: 1 });
    await t.edit(t.alpha).click();
    await expect(t.feedback).toHaveText(EDITOR_FAILURE);
    let done = t.refreshed();
    held.release();
    await done;
    await expect(page.locator('.app-section-title').first()).toContainText('Host Renamed');
    await page.waitForTimeout(200);
    await expect(t.feedback).toBeVisible();
    await expect(t.feedback).toHaveText(EDITOR_FAILURE);

    // A return GET held and then failed: its note goes beside the error, and
    // its Retry's success takes the note away and nothing else.
    held = await hold(page, t.hostPath, 'GET');
    await leave(page);
    await comeBack(page);
    await held.arrived;
    done = t.refreshed();
    held.release((route) => route.fulfill({ status: 500, contentType: 'text/html', body: '<p>Internal detail</p>' }));
    await done;
    await expect(t.refreshNote).toHaveText(STALE_RETURN);
    await expect(t.feedback).toContainText(EDITOR_FAILURE);
    done = t.refreshed();
    await t.retry.click();
    await done;
    await expect(t.refreshNote).toHaveCount(0);
    await expect(anyRetry(page)).toHaveCount(0);
    await expect(t.feedback).toBeVisible();
    await expect(t.feedback).toHaveText(EDITOR_FAILURE);
    expect(t.log.projectPosts).toHaveLength(1);
    expect(t.log.notePosts).toEqual([]);
  });
});

// WP7.1-F2: a Project Edit or Archive refresh completes into the notice only
// while nothing newer was written there; otherwise its message (and Retry,
// which lives inside that message) goes beside the newer one.
const SAVE_RETRY = '[data-project-detail-refresh-retry]';
const REFRESH_MESSAGE = '[data-project-detail-refresh-message]';

// Saves Edit Project through its dialog with its refresh GET held.
async function saveProjectWithHeldRefresh(page, t, title) {
  const held = await hold(page, t.hostPath, 'GET');
  await page.locator(`[data-project-edit-id="${t.project.id}"]`).click();
  const dialog = page.locator('#project-edit-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#title').fill(title);
  await dialog.locator('button[data-dialog-submit]').click();
  await held.arrived;
  await expect(dialog).toBeHidden();
  expect(t.log.projectPosts).toHaveLength(1);
  return held;
}

async function failNotesEditor(page, t) {
  await page.route(`**/notes/${t.alpha.id}`, (route) => route.abort('failed'), { times: 1 });
  await t.edit(t.alpha).click();
  await expect(t.feedback).toHaveText(EDITOR_FAILURE);
  await expect(page.locator('#note-edit-dialog')).toBeHidden();
}

const failWith500 = (route) => route.fulfill({ status: 500, contentType: 'text/html', body: '<p>Internal detail</p>' });

test('K: a successful Project Edit refresh landing after a Notes editor error keeps the error', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const held = await saveProjectWithHeldRefresh(page, t, 'Host Renamed');
    await failNotesEditor(page, t);
    const done = t.refreshed();
    held.release();
    await done;
    await expect(page.locator('.app-section-title').first()).toContainText('Host Renamed');
    await page.waitForTimeout(200);
    await expect(t.feedback).toBeVisible();
    await expect(t.feedback).toHaveText(EDITOR_FAILURE);
    await expect(t.feedback).toHaveClass(/notice--error/);
    await expect(t.feedback).not.toContainText('Project updated.');
    await expect(anyRetry(page)).toHaveCount(0);
    expect(t.log.projectPosts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET']);
    expect(t.log.notePosts).toEqual([]);
  });
});

test('L: a failed Project Edit refresh adds its warning and Retry beside a newer Notes editor error', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const held = await saveProjectWithHeldRefresh(page, t, 'Host Renamed');
    await failNotesEditor(page, t);
    let done = t.refreshed();
    held.release(failWith500);
    await done;
    await expect(t.feedback).toContainText(EDITOR_FAILURE);
    await expect(t.feedback).toContainText(STALE_SAVE);
    await expect(t.feedback).toHaveAttribute('role', 'status');
    await expect(t.feedback).toHaveClass(/notice--error/);
    await expect(page.locator(SAVE_RETRY)).toHaveCount(1);
    // The Retry belongs to the warning it can resolve.
    await expect(page.locator(`${REFRESH_MESSAGE} ${SAVE_RETRY}`)).toHaveCount(1);
    await expect(page.locator(REFRESH_MESSAGE)).toContainText(STALE_SAVE);
    await expect(page.locator(REFRESH_MESSAGE)).not.toContainText(EDITOR_FAILURE);
    await expect(page.locator(SAVE_RETRY)).toHaveAccessibleName('Retry refresh');

    // A Retry that fails again: still one warning and one Retry, error kept.
    const failing = (url) => url.pathname === t.hostPath;
    await page.route(failing, (route) => (route.request().resourceType() === 'fetch' ? failWith500(route) : route.fallback()));
    done = t.refreshed();
    await page.locator(SAVE_RETRY).click();
    await done;
    await expect(page.locator(SAVE_RETRY)).toHaveCount(1);
    await expect(page.locator(REFRESH_MESSAGE)).toHaveCount(1);
    await expect(t.feedback).toContainText(EDITOR_FAILURE);
    await expect(t.feedback).toContainText(STALE_SAVE);

    // A Retry that recovers (keyboard): its warning goes, the error stays.
    await page.unroute(failing);
    done = t.refreshed();
    await page.locator(SAVE_RETRY).focus();
    await page.keyboard.press('Enter');
    await done;
    await expect(page.locator('.app-section-title').first()).toContainText('Host Renamed');
    await expect(page.locator(SAVE_RETRY)).toHaveCount(0);
    await expect(page.locator(REFRESH_MESSAGE)).toHaveCount(0);
    await expect(t.feedback).toBeVisible();
    await expect(t.feedback).toHaveText(EDITOR_FAILURE);
    expect(t.log.projectPosts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET', 'GET', 'GET']);
    expect(t.log.notePosts).toEqual([]);
  });
});

test('M: a confirmed Archive refresh landing after a Notes editor error keeps the error', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const archivePosts = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `${t.hostPath}/archive`) archivePosts.push(request.url());
    });
    await page.locator(`[data-project-edit-id="${t.project.id}"]`).click();
    const dialog = page.locator('#project-edit-dialog');
    await expect(dialog.locator('button[data-dialog-submit]')).toBeEnabled();
    const archive = dialog.locator('[data-project-edit-action="archive"]');
    if (!(await archive.evaluate((node) => node.open))) await archive.locator('summary').click();
    await archive.getByRole('button', { name: 'Archive project' }).click();
    const confirmation = page.locator('#app-confirmation-dialog');
    await expect(confirmation).toBeVisible();
    const held = await hold(page, t.hostPath, 'GET');
    await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    await held.arrived;
    await expect(t.feedback).toHaveText('Project “Host Project” archived.');
    await failNotesEditor(page, t);
    const done = t.refreshed();
    held.release();
    await done;
    await expect(page.locator(`[data-project-edit-id="${t.project.id}"]`)).toHaveCount(0);
    await page.waitForTimeout(200);
    await expect(t.feedback).toBeVisible();
    await expect(t.feedback).toHaveText(EDITOR_FAILURE);
    await expect(anyRetry(page)).toHaveCount(0);
    expect(archivePosts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET']);
    expect(t.log.notePosts).toEqual([]);
  });
});

test('N: a Notes editor error that replaces a save refresh warning takes its Retry with it', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    await saveProjectWithFailedRefresh(page, t, 'Host Renamed');
    await failNotesEditor(page, t);
    await expect(t.feedback).toHaveText(EDITOR_FAILURE);
    await expect(t.feedback).not.toContainText(STALE_SAVE);
    await expect(anyRetry(page)).toHaveCount(0);
    await expect(t.feedback.getByRole('button')).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(t.log.refreshes).toEqual(['GET']);
    expect(t.log.projectPosts).toHaveLength(1);
    expect(t.log.notePosts).toEqual([]);
  });
});

test('O: a save refresh failure alone recovers through its GET-only Retry and says the project updated', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const network = await saveProjectWithFailedRefresh(page, t, 'Host Renamed');
    await expect(t.feedback).toHaveClass(/notice--error/);
    network.fail = false;
    const done = t.refreshed();
    await page.locator(SAVE_RETRY).focus();
    await page.keyboard.press('Enter');
    await done;
    await expect(t.feedback).toHaveText('Project updated.');
    await expect(t.feedback).toHaveClass(/notice--success/);
    await expect(anyRetry(page)).toHaveCount(0);
    await expect(page.locator('.app-section-title').first()).toContainText('Host Renamed');
    await expect(page.locator(`[data-project-edit-id="${t.project.id}"]`)).toBeFocused();
    expect(t.log.projectPosts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET', 'GET']);
    expect(t.log.notePosts).toEqual([]);
  });
});

test('P: repeated return failures beside a newer error never pile up, and recovery leaves only the error', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.visit();
    const network = await saveProjectWithFailedRefresh(page, t, 'Host Renamed');
    await failNotesEditor(page, t);
    for (let round = 0; round < 2; round += 1) {
      await leave(page);
      const failed = t.refreshed();
      await comeBack(page);
      await failed;
      await expect(t.refreshNote).toHaveCount(1);
      await expect(t.refreshNote).toHaveText(STALE_RETURN);
      await expect(anyRetry(page)).toHaveCount(1);
      await expect(t.retry).toHaveCount(1);
      await expect(t.feedback).toContainText(EDITOR_FAILURE);
      await expect(t.feedback).not.toContainText(STALE_SAVE);
    }
    network.fail = false;
    const done = t.refreshed();
    await t.retry.click();
    await done;
    await expect(t.refreshNote).toHaveCount(0);
    await expect(anyRetry(page)).toHaveCount(0);
    await expect(t.feedback).toBeVisible();
    await expect(t.feedback).toHaveText(EDITOR_FAILURE);
    expect(t.log.projectPosts).toHaveLength(1);
    expect(t.log.refreshes).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(t.log.notePosts).toEqual([]);
  });
});
