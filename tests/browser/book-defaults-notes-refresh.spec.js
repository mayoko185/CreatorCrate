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

// A Book Defaults read that began before a New Chapter or New Page save must not
// put the older Book contents back, and the Defaults change must still arrive.
// New Page needs the real editor, which exists only in the built client.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

// Each armed step applies to the next GET of the host, in order: `hold` answers
// with what the server said when the request arrived, on release; `fail` aborts.
async function controlHostReads(page, hostPath) {
  const steps = [];
  await page.route((url) => url.pathname === hostPath, async (route) => {
    const step = route.request().method() === 'GET' ? steps.shift() : null;
    if (!step) {
      await route.fallback();
      return;
    }
    if (step.fail) {
      await route.abort();
      step.markArrived();
      return;
    }
    const snapshot = await route.fetch();
    step.markArrived();
    await step.released;
    await route.fulfill({ response: snapshot }).catch(() => {});
    step.markDelivered();
  });
  const arm = (fail) => {
    const step = { fail };
    step.arrived = new Promise((resolve) => { step.markArrived = resolve; });
    step.delivered = new Promise((resolve) => { step.markDelivered = resolve; });
    step.released = new Promise((resolve) => { step.release = resolve; });
    steps.push(step);
    return step;
  };
  return { hold: () => arm(false), fail: () => arm(true) };
}

async function withBook(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-defaults-race-'));
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

    const { bookService, chapterService, noteService, bookPagePreviewSettingsService } = app.locals;
    const book = bookService.createBook({ title: 'Race Book' });
    const opened = chapterService.createChapter({ bookId: book.id, title: 'Open Chapter' });
    noteService.createNote({ chapterId: opened.id, title: 'Nested Page' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const hostPath = `/notes/books/${book.id}`;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + hostPath);
    await page.evaluate(() => { window.__raceDocument = true; });
    const reads = await controlHostReads(page, hostPath);
    const log = { navigations: [], chapterPosts: [], pagePosts: [], defaultsPosts: [], otherWrites: [] };
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) log.navigations.push(frame.url()); });
    page.on('request', (request) => {
      if (request.method() !== 'POST') return;
      const { pathname } = new URL(request.url());
      if (pathname === `${hostPath}/chapters`) log.chapterPosts.push(request);
      else if (pathname === '/notes') log.pagePosts.push(request);
      else if (pathname === `${hostPath}/defaults`) log.defaultsPosts.push(request);
      else log.otherWrites.push(request);
    });

    const sidebar = page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav');
    const defaultsDialog = page.locator('#book-defaults-dialog');
    const chapterDialog = page.locator('#chapter-create-dialog');
    const pageDialog = page.locator('#note-create-dialog');
    const pageEditor = pageDialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]');
    const t = {
      app, book, opened, reads, log, sidebar, hostPath, noteService, chapterService, defaultsDialog, chapterDialog, pageDialog,
      chapterTitles: () => sidebar.locator('.notes-book-nav-chapter-title').allTextContents(),
      pageTitles: () => sidebar.locator('a.notes-book-nav-page-link').allTextContents(),
      feedback: page.locator('[data-dialog-feedback]'),
      savedCount: () => bookPagePreviewSettingsService.getBookPagePreviewSettings(book.id).randomCount,
      // Autosaves through the real form, which closes while its refresh is outstanding.
      changeDefaults: async (count, { close = true } = {}) => {
        await page.locator('[data-book-defaults-link]').click();
        await expect(defaultsDialog).toBeVisible();
        await page.locator('#book-preview-count').evaluate((select, value) => {
          select.value = value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(count));
        await expect.poll(() => bookPagePreviewSettingsService.getBookPagePreviewSettings(book.id).randomCount).toBe(count);
        if (close) {
          await defaultsDialog.locator('[data-dialog-close]').first().click();
          await expect(defaultsDialog).toBeHidden();
        }
      },
      createChapter: async (title) => {
        await page.locator('.page-heading [data-dialog-open="chapter-create-dialog"]').click();
        await chapterDialog.locator('[name="title"]').fill(title);
        await chapterDialog.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(chapterDialog).toBeHidden();
      },
      openNewPage: async () => {
        await page.locator('.page-heading [data-dialog-open="note-create-dialog"]').click();
        await expect(pageDialog).toBeVisible();
        await expect(pageEditor).toBeVisible();
      },
      kept: async () => {
        expect(log.navigations).toEqual([]);
        expect(await page.evaluate(() => window.__raceDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(hostPath);
      },
    };
    await run(t);
    expect(log.otherWrites).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a New Chapter survives an older Book Defaults read, and the defaults still apply', async ({ page }) => {
  await withBook(page, async (t) => {
    const old = t.reads.hold();
    await t.changeDefaults(7);
    await old.arrived;

    await t.createChapter('Fresh Chapter');
    await expect(t.feedback).toContainText('Chapter “Fresh Chapter” created.');
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);
    expect(t.log.chapterPosts).toHaveLength(1);

    old.release();
    await old.delivered;
    await page.waitForFunction(() => document.querySelector('[data-book-detail-live-region]').getAttribute('aria-busy') === null);
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);

    const created = t.chapterService.listChapters(t.book.id).at(-1);
    await expect(t.feedback.locator('[data-chapter-view]')).toHaveAttribute('href', `/notes/chapters/${created.id}`);
    await expect(page.locator('#note-create-dialog .notes-book-nav-chapter-title')).toHaveText(['Open Chapter', 'Fresh Chapter']);
    await expect(t.sidebar.locator(`[data-book-nav-chapter="${created.id}"]`)).toHaveCount(1);
    await expect(page.locator(`#book-order-dialog [data-content-key="chapter:${created.id}"]`)).toHaveCount(1);
    await expect(page.locator('[data-book-detail-toolbar] [data-dialog-open="book-order-dialog"]')).toHaveCount(1);
    expect(t.log.chapterPosts).toHaveLength(1);
    await t.kept();

    // The Defaults read finished as a save, not as a failure, and its controls work.
    await page.locator('[data-book-defaults-link]').click();
    await expect(t.defaultsDialog.locator('[data-settings-fetch-save-status]')).toHaveText('Settings saved.');
    await page.locator('#book-preview-count').evaluate((select) => {
      select.value = '9';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(t.savedCount).toBe(9);
    await expect.poll(() => t.log.defaultsPosts.length).toBe(2);
    await expect(t.defaultsDialog.locator('[data-settings-fetch-save-status]')).toHaveText('Settings saved.');
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);
  });
});

test('a New Page survives an older Book Defaults read', async ({ page }) => {
  await withBook(page, async (t) => {
    const old = t.reads.hold();
    await t.changeDefaults(7);
    await old.arrived;

    await t.openNewPage();
    await t.pageDialog.locator('[name="title"]').fill('Fresh Page');
    await t.pageDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(t.pageDialog).toBeHidden();
    await expect(t.sidebar.locator('a.notes-book-nav-page-link', { hasText: 'Fresh Page' })).toHaveCount(1);
    expect(t.log.pagePosts).toHaveLength(1);

    old.release();
    await old.delivered;
    await page.waitForFunction(() => document.querySelector('[data-book-detail-live-region]').getAttribute('aria-busy') === null);

    const created = t.noteService.listNotes().find(({ title }) => title === 'Fresh Page');
    expect(created).toMatchObject({ book_id: t.book.id, chapter_id: null });
    await expect(t.sidebar.locator(`a[href="/notes/${created.id}"]`)).toHaveText('Fresh Page');
    await expect(t.sidebar.locator('.notes-book-nav-chapter-title')).toHaveText(['Open Chapter']);
    await expect(page.locator('[data-book-detail-live-region] .notes-page-preview-title', { hasText: 'Fresh Page' })).toHaveCount(1);
    await expect(page.locator(`#book-preview-pages option[value="${created.id}"]`)).toHaveCount(1);
    await expect(page.locator('[data-book-detail-toolbar] [data-dialog-open="book-order-dialog"]')).toHaveCount(1);
    expect(t.log.pagePosts).toHaveLength(1);
    await t.kept();
  });
});

test('reads that finish in either order settle on the server state', async ({ page }) => {
  await withBook(page, async (t) => {
    // The older Defaults read lands first, before the save.
    const old = t.reads.hold();
    await t.changeDefaults(7);
    await old.arrived;
    old.release();
    await old.delivered;
    await t.createChapter('First Chapter');
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'First Chapter']);

    // A Notes read older than a newer Defaults save reads again rather than landing.
    const notesRead = t.reads.hold();
    await t.createChapter('Second Chapter');
    await notesRead.arrived;
    await t.changeDefaults(9);
    await expect(t.sidebar.locator('.notes-book-nav-chapter-title')).toHaveText(['Open Chapter', 'First Chapter', 'Second Chapter']);
    notesRead.release();
    await notesRead.delivered;
    await expect(page.locator('#note-create-dialog .notes-book-nav-chapter-title'))
      .toHaveText(['Open Chapter', 'First Chapter', 'Second Chapter']);
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'First Chapter', 'Second Chapter']);
    await expect(t.feedback.locator('[data-chapter-refresh-retry]')).toHaveCount(0);
    expect(t.log.chapterPosts).toHaveLength(2);
    await t.kept();
  });
});

test('a read landing behind an open draft leaves the draft, disclosures and focus alone', async ({ page }) => {
  await withBook(page, async (t) => {
    const old = t.reads.hold();
    const restarted = t.reads.hold();
    await t.changeDefaults(7);
    await old.arrived;

    const chapter = t.sidebar.locator(`[data-book-nav-chapter="${t.opened.id}"]`);
    await chapter.click();
    await expect(chapter.locator('xpath=ancestor::details')).toHaveAttribute('open', '');
    await t.createChapter('Fresh Chapter');
    await restarted.arrived;
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);

    // A draft stays in the open dialog while both outstanding reads settle.
    await t.openNewPage();
    const title = t.pageDialog.locator('[name="title"]');
    await title.fill('Unsaved draft');
    await title.focus();
    const hierarchy = page.locator('#book-order-dialog form');
    await hierarchy.evaluate((node) => { node.dataset.sameNode = 'yes'; });
    old.release();
    await old.delivered;
    restarted.release();
    await restarted.delivered;
    await page.waitForFunction(() => document.querySelector('[data-book-detail-live-region]').getAttribute('aria-busy') === null);

    await expect(t.pageDialog).toBeVisible();
    await expect(title).toHaveValue('Unsaved draft');
    await expect(title).toBeFocused();
    await expect(hierarchy).toHaveAttribute('data-same-node', 'yes');
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);
    await expect(t.sidebar.locator(`[data-book-nav-chapter="${t.opened.id}"]`).locator('xpath=ancestor::details')).toHaveAttribute('open', '');

    // The unsaved-changes guard still sees the draft.
    await page.keyboard.press('Escape');
    await expect(page.locator('#app-confirmation-dialog')).toBeVisible();
    await page.locator('#app-confirmation-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(title).toHaveValue('Unsaved draft');
    expect(t.log.pagePosts).toHaveLength(0);
    await t.kept();
  });
});

test('a failed Defaults read reports only itself, and its retry only reads', async ({ page }) => {
  await withBook(page, async (t) => {
    const old = t.reads.hold();
    const failed = t.reads.fail();
    await t.changeDefaults(7);
    await old.arrived;
    await t.createChapter('Fresh Chapter');
    await failed.arrived;
    await expect(t.feedback).toContainText('Chapter “Fresh Chapter” created.');
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);
    old.release();
    await old.delivered;
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);
    await expect(t.feedback).not.toContainText('could not refresh');

    await page.locator('[data-book-defaults-link]').click();
    const status = t.defaultsDialog.locator('[data-settings-fetch-save-status]');
    await expect(status).toContainText('Defaults were saved, but the Book detail could not refresh.');
    await t.defaultsDialog.locator('[data-book-defaults-refresh-retry]').click();
    await expect(status).toHaveText('Settings saved. Book detail refreshed.');
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);
    expect(t.log.chapterPosts).toHaveLength(1);
    expect(t.log.defaultsPosts).toHaveLength(1);
    await t.kept();
  });
});

test('a failed Notes read keeps the confirmed Chapter, and Retry refresh only reads', async ({ page }) => {
  await withBook(page, async (t) => {
    const old = t.reads.hold();
    const restarted = t.reads.hold();
    const failedHost = t.reads.fail();
    await t.changeDefaults(7);
    await old.arrived;
    await t.createChapter('Fresh Chapter');
    await restarted.arrived;
    await failedHost.arrived;

    await expect(t.feedback).toContainText('Chapter “Fresh Chapter” created.');
    await expect(t.feedback).toContainText('The Chapter was created, but Book contents could not refresh.');
    await expect(t.feedback.locator('[data-chapter-view]')).toHaveCount(1);
    old.release();
    await old.delivered;
    restarted.release();
    await restarted.delivered;

    // The Defaults read began after the save, so it brings the Chapter by itself.
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);
    await t.feedback.locator('[data-chapter-refresh-retry]').click();
    await expect(t.feedback).not.toContainText('could not refresh');
    await expect(page.locator('#note-create-dialog .notes-book-nav-chapter-title')).toHaveText(['Open Chapter', 'Fresh Chapter']);
    await expect.poll(t.chapterTitles).toEqual(['Open Chapter', 'Fresh Chapter']);
    expect(t.log.chapterPosts).toHaveLength(1);
    await t.kept();
  });
});
