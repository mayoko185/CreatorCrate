import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// Change order saves in place: Chapter Detail is never navigated or replaced, a
// draft stays in the dialog until Save, and a confirmed POST is never repeated.

async function withChapter(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-order-flow-'));
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

    const { noteService, chapterService, bookService } = app.locals;
    const book = bookService.createBook({ title: 'Order Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Order Chapter' });
    const [a, b, c] = ['Page A', 'Page B', 'Page C']
      .map((title) => noteService.createNote({ chapterId: chapter.id, title }));
    const hostPath = `/notes/chapters/${chapter.id}`;
    const postPath = `${hostPath}/notes/reorder`;
    const origin = `http://127.0.0.1:${server.address().port}`;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + hostPath);
    const log = { navigations: [], posts: [], gets: [] };
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) log.navigations.push(frame.url()); });
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST' && pathname === postPath) log.posts.push(request);
      if (request.method() === 'GET' && pathname === hostPath) log.gets.push(request);
    });
    await page.evaluate(() => { window.__pageOrderDocument = true; });

    const dialog = page.locator('#chapter-order-dialog');
    const handle = (note) => dialog.locator(`[data-note-id="${note.id}"] [data-chapter-page-reorder-handle]`);
    await run({
      app, origin, book, chapter, a, b, c, hostPath, postPath, log, dialog, handle,
      trigger: page.locator('.page-heading [data-dialog-open="chapter-order-dialog"]'),
      save: dialog.getByRole('button', { name: 'Save', exact: true }),
      summary: dialog.locator('[data-dialog-error]'),
      feedback: page.locator('[data-dialog-feedback]'),
      saved: () => noteService.listNotesForChapter(chapter.id).map((note) => note.title),
      dialogTitles: () => dialog.locator('.notes-chapter-page-title').allTextContents(),
      numbers: () => dialog.locator('.notes-chapter-page-number').allTextContents(),
      mainTitles: () => page.locator('.notes-chapter-pages .notes-page-nav-link').allTextContents(),
      navTitles: () => page.locator('.notes-chapter-detail-sidebar .notes-book-nav-item--current .notes-book-nav-pages a').allTextContents(),
      kept: async () => {
        expect(log.navigations).toEqual([]);
        expect(await page.evaluate(() => window.__pageOrderDocument === true)).toBe(true);
        expect(new URL(page.url()).pathname).toBe(hostPath);
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

const CBA = ['Page C', 'Page B', 'Page A'];
const ABC = ['Page A', 'Page B', 'Page C'];
const BAC = ['Page B', 'Page A', 'Page C'];

test('keyboard reorder saves in place, once, and everything showing the order follows', async ({ page }) => {
  await withChapter(page, async (t) => {
    await page.evaluate(() => {
      document.querySelector('.notes-chapter-detail-sidebar [data-book-nav-chapter]').closest('details').open = true;
      document.querySelector('#note-create-dialog [name="title"]').value = 'Page draft';
    });
    await t.trigger.click();
    await expect(t.dialog).toBeVisible();
    expect(await t.dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
    expect(await t.dialogTitles()).toEqual(ABC);

    await t.handle(t.a).focus();
    await page.keyboard.press('End');
    await expect(t.handle(t.a)).toBeFocused();
    await t.handle(t.b).focus();
    await page.keyboard.press('End');
    await expect(t.handle(t.b)).toBeFocused();
    await expect(page.locator('[data-chapter-page-reorder-live]')).toContainText('moved to position 3 of 3');
    expect(await t.dialogTitles()).toEqual(['Page C', 'Page A', 'Page B']);
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    expect(await t.dialogTitles()).toEqual(CBA);
    expect(await t.mainTitles()).toEqual(ABC);

    await expect(t.save).toBeEnabled();
    await t.save.focus();
    await page.keyboard.press('Enter');
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page order saved.');
    await expect(t.trigger).toBeFocused();
    expect(t.saved()).toEqual(CBA);
    expect(t.log.posts).toHaveLength(1);
    await expect.poll(() => t.mainTitles()).toEqual(CBA);
    await expect.poll(() => t.navTitles()).toEqual(CBA);
    await expect(page.locator('h1.app-section-title')).toHaveText('Notes — Order Chapter');
    await expect(page.locator('.notes-chapter-detail-sidebar [data-book-nav-chapter]').locator('xpath=ancestor::details')).toHaveAttribute('open', '');
    await expect(page.locator('#note-create-dialog [name="title"]')).toHaveValue('Page draft');
    await t.kept();

    // Reopening shows the saved order with its numbers, and the controls still work.
    await t.trigger.click();
    await expect(t.dialog).toBeVisible();
    expect(await t.dialogTitles()).toEqual(CBA);
    expect(await t.numbers()).toEqual(['Page 1', 'Page 2', 'Page 3']);
    await t.handle(t.c).focus();
    await page.keyboard.press('ArrowDown');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toEqual(['Page B', 'Page C', 'Page A']);
    expect(t.log.posts).toHaveLength(2);
    await t.kept();
  });
});

test('drag reordering still works and saves in place', async ({ page }) => {
  await withChapter(page, async (t) => {
    await t.trigger.click();
    await t.handle(t.c).dragTo(t.dialog.locator(`[data-note-id="${t.a.id}"]`), { targetPosition: { x: 20, y: 1 } });
    expect(await t.dialogTitles()).toEqual(['Page C', 'Page A', 'Page B']);
    expect(t.log.posts).toHaveLength(0);
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toEqual(['Page C', 'Page A', 'Page B']);
    await expect.poll(() => t.mainTitles()).toEqual(['Page C', 'Page A', 'Page B']);
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('every dismissal discards the draft and persists nothing', async ({ page }) => {
  await withChapter(page, async (t) => {
    for (const dismiss of [
      () => page.keyboard.press('Escape'),
      () => t.dialog.getByRole('button', { name: 'Close Change order', exact: true }).click(),
      () => page.mouse.click(5, 5),
    ]) {
      await t.trigger.click();
      await t.handle(t.a).focus();
      await page.keyboard.press('End');
      expect(await t.dialogTitles()).toEqual(['Page B', 'Page C', 'Page A']);
      await dismiss();
      await expect(t.dialog).toBeHidden();
      await expect(t.trigger).toBeFocused();
      expect(await t.dialogTitles()).toEqual(ABC);
      await expect(t.dialog.locator('[name="orderedNoteIds"]')).toHaveValue(`${t.a.id},${t.b.id},${t.c.id}`);
      expect(await t.mainTitles()).toEqual(ABC);
    }
    expect(t.log.posts).toHaveLength(0);
    expect(t.saved()).toEqual(ABC);
    await t.kept();
  });
});

test('Save in flight blocks duplicates, moves and dismissal', async ({ page }) => {
  await withChapter(page, async (t) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === t.postPath, async (route) => {
      await held;
      await route.fallback();
    });
    await t.trigger.click();
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    await t.save.click();
    await expect(t.save).toBeDisabled();
    await page.evaluate(() => document.getElementById('notes-chapter-order-form').requestSubmit());
    await t.handle(t.a).focus();
    await page.keyboard.press('End');
    expect(await t.dialogTitles()).toEqual(BAC);
    await page.keyboard.press('Escape');
    await t.dialog.getByRole('button', { name: 'Close Change order', exact: true }).click();
    await expect(t.dialog).toBeVisible();
    expect(t.log.posts).toHaveLength(1);
    release();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page order saved.');
    expect(t.saved()).toEqual(BAC);
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('a stale draft is refused in place, kept, and yields to the current Pages on close', async ({ page }) => {
  await withChapter(page, async (t) => {
    const { noteService } = t.app.locals;
    await t.trigger.click();
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => t.log.gets.length).toBe(1);

    noteService.deleteNote(t.c.id);
    const getsBefore = t.log.gets.length;
    await t.save.click();
    await expect(t.summary).toContainText('have changed, so this order was not saved');
    await expect(t.save).toBeFocused();
    await expect(t.dialog).toBeVisible();
    expect(await t.dialogTitles()).toEqual(BAC);
    expect(t.saved()).toEqual(['Page A', 'Page B']);
    expect(t.log.posts).toHaveLength(1);

    // The host shows what the read found; the draft waits for the user.
    await expect.poll(() => t.log.gets.length).toBe(getsBefore + 1);
    await expect.poll(() => t.mainTitles()).toEqual(['Page A', 'Page B']);
    expect(await t.dialogTitles()).toEqual(BAC);
    await expect(t.feedback).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    await expect(t.trigger).toBeFocused();
    expect(await t.dialogTitles()).toEqual(['Page A', 'Page B']);

    // The refused order did not become the baseline, and replaced controls work.
    await t.trigger.click();
    await expect(t.summary).toBeHidden();
    expect(await t.dialogTitles()).toEqual(['Page A', 'Page B']);
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    await expect(t.handle(t.a)).toBeFocused();
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toEqual(['Page B', 'Page A']);
    expect(t.log.posts).toHaveLength(2);
    await t.kept();
  });
});

test('opening picks up Pages changed elsewhere and leaves a started draft alone', async ({ page }) => {
  await withChapter(page, async (t) => {
    const { noteService } = t.app.locals;
    noteService.reorderNotes(t.chapter.id, [t.c.id, t.a.id, t.b.id]);
    const added = noteService.createNote({ chapterId: t.chapter.id, title: 'Page D' });
    await t.trigger.click();
    await expect.poll(() => t.dialogTitles()).toEqual(['Page C', 'Page A', 'Page B', 'Page D']);
    await expect.poll(() => t.mainTitles()).toEqual(['Page C', 'Page A', 'Page B', 'Page D']);
    await t.handle(added).focus();
    await page.keyboard.press('Home');
    await expect(t.handle(added)).toBeFocused();
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toEqual(['Page D', 'Page C', 'Page A', 'Page B']);

    // The read that opens the dialog answers after the user has begun moving.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      await held;
      return route.fulfill({ response });
    });
    noteService.deleteNote(t.c.id);
    await t.trigger.click();
    await t.handle(added).focus();
    await page.keyboard.press('End');
    release();
    await expect.poll(() => t.mainTitles()).toEqual(['Page D', 'Page A', 'Page B']);
    expect(await t.dialogTitles()).toEqual(['Page C', 'Page A', 'Page B', 'Page D']);
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    expect(await t.dialogTitles()).toEqual(['Page D', 'Page A', 'Page B']);
    await t.kept();
  });
});

test('uncertain and refused outcomes never claim success or replace the document', async ({ page }) => {
  await withChapter(page, async (t) => {
    await t.trigger.click();
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');

    for (const handler of [
      (route) => route.abort(),
      (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>login</html>' }),
      (route) => route.fulfill({ status: 500, contentType: 'text/html', body: '<html>SQLITE secret</html>' }),
      (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":' }),
    ]) {
      await page.unrouteAll();
      await page.route((url) => url.pathname === t.postPath, handler);
      const postsBefore = t.log.posts.length;
      await t.save.click();
      await expect(t.summary).toContainText('Could not confirm whether the Page order was saved');
      await expect(t.summary).not.toContainText('secret');
      await expect(t.save).toBeEnabled();
      await expect(t.save).toBeFocused();
      expect(await t.dialogTitles()).toEqual(BAC);
      expect(t.log.posts).toHaveLength(postsBefore + 1);
      await expect(t.feedback).toBeHidden();
    }
    expect(t.saved()).toEqual(ABC);

    await page.unrouteAll();
    await page.route((url) => url.pathname === t.postPath, (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', code: 'CHAPTER_OPERATION_FAILED', message: 'The Page order could not be saved. No changes were made.' }),
    }));
    await t.save.click();
    await expect(t.summary).toContainText('No changes were made.');
    await expect(t.summary).not.toContainText('Could not confirm');
    expect(await t.dialogTitles()).toEqual(BAC);

    await page.unrouteAll();
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    await expect(t.trigger).toBeFocused();
    await t.trigger.click();
    await expect(t.summary).toBeHidden();
    expect(await t.dialogTitles()).toEqual(ABC);
    await page.keyboard.press('Escape');
    await t.kept();
  });
});

test('a deleted Chapter is refused in place', async ({ page }) => {
  await withChapter(page, async (t) => {
    await t.trigger.click();
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => t.log.gets.length).toBe(1);
    const { noteService, chapterService } = t.app.locals;
    [t.a, t.b, t.c].forEach((note) => noteService.deleteNote(note.id));
    chapterService.deleteChapter(t.chapter.id);
    await t.save.click();
    await expect(t.summary).toContainText('This Chapter is no longer available.');
    await expect(t.dialog).toBeVisible();
    expect(await t.dialogTitles()).toEqual(BAC);
    await t.kept();
  });
});

test('a failed refresh keeps the confirmed order and retries with GET only', async ({ page }) => {
  await withChapter(page, async (t) => {
    await t.trigger.click();
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => t.log.gets.length).toBe(1);

    let fail = true;
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (route.request().method() === 'GET' && fail) return route.abort();
      return route.fallback();
    });
    await t.save.click();
    const retry = t.feedback.locator('[data-chapter-refresh-retry]');
    await expect(retry).toBeVisible();
    await expect(t.feedback).toContainText('Page order saved.');
    await expect(t.feedback).toContainText('could not refresh');
    await expect(t.dialog).toBeHidden();
    expect(await t.mainTitles()).toEqual(BAC);
    expect(await t.navTitles()).toEqual(BAC);
    expect(t.saved()).toEqual(BAC);

    fail = false;
    t.app.locals.noteService.createNote({ chapterId: t.chapter.id, title: 'Page D' });
    const getsBefore = t.log.gets.length;
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(retry).toHaveCount(0);
    await expect.poll(() => t.mainTitles()).toEqual([...BAC, 'Page D']);
    await expect(t.feedback).toContainText('Page order saved.');
    await expect(t.feedback.locator('[data-chapter-refresh-note]')).toHaveCount(0);
    await expect(t.trigger).toBeFocused();
    expect(t.log.gets).toHaveLength(getsBefore + 1);
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('a slow refresh cannot restore an older order or an older Chapter title', async ({ page }) => {
  await withChapter(page, async (t) => {
    await t.trigger.click();
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => t.log.gets.length).toBe(1);

    // Hold the refresh that follows the reorder until the rename has finished.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let holding = true;
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (route.request().method() !== 'GET' || !holding) return route.fallback();
      holding = false;
      const stale = await route.fetch();
      await held;
      return route.fulfill({ response: stale });
    });
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect.poll(() => holding).toBe(false);

    const edit = page.locator('#chapter-edit-dialog');
    await page.locator('.page-heading [data-dialog-open="chapter-edit-dialog"]').click();
    await edit.locator('[name="title"]').fill('Renamed');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('h1.app-section-title')).toHaveText('Notes — Renamed');
    await expect(page.locator('.notes-chapter-detail-sidebar .notes-book-nav-chapter-title')).toHaveText(['Renamed']);

    release();
    await page.waitForTimeout(200);
    await expect(page.locator('.notes-chapter-detail-sidebar .notes-book-nav-chapter-title')).toHaveText(['Renamed']);
    await expect(page.locator('.notes-chapter-pages [aria-label="Pages in Renamed"]')).toHaveCount(1);
    expect(await t.mainTitles()).toEqual(BAC);

    // The rename did not disturb the ordering dialog's Chapter or saved order.
    await t.trigger.click();
    await expect(page.locator('#chapter-order-dialog [aria-label="Pages in Renamed"]')).toHaveCount(1);
    expect(await t.dialogTitles()).toEqual(BAC);
    await page.keyboard.press('Escape');
    await t.kept();
  });
});

// Opens once to show A/B/C, changes the saved order behind the page, then reopens
// with the opening read failing.
async function reopenWithFailedRead(page, t) {
  await t.trigger.click();
  await expect(t.save).toBeEnabled();
  expect(await t.dialogTitles()).toEqual(ABC);
  await page.keyboard.press('Escape');
  await expect(t.dialog).toBeHidden();
  t.app.locals.noteService.reorderNotes(t.chapter.id, [t.c.id, t.b.id, t.a.id]);
  const failing = { on: true };
  await page.route((url) => url.pathname === t.hostPath, (route) => (
    route.request().method() === 'GET' && failing.on ? route.abort() : route.fallback()
  ));
  await t.trigger.click();
  await expect(t.summary).toContainText('current Page order could not be confirmed');
  return failing;
}

const recheckOf = (t) => t.dialog.locator('[data-chapter-order-recheck]');

test('a failed opening read blocks every way of saving the stale order', async ({ page }) => {
  await withChapter(page, async (t) => {
    await reopenWithFailedRead(page, t);
    await expect(t.dialog).toBeVisible();
    await expect(t.save).toBeDisabled();
    await expect(recheckOf(t)).toHaveText('Check again');
    await expect(t.dialog.locator('[data-notes-chapter-order-page]')).toHaveAttribute('inert', '');

    await t.save.click({ force: true });
    await page.evaluate(() => {
      const form = document.getElementById('notes-chapter-order-form');
      form.requestSubmit();
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    // Nothing but the lock remains once the disabled state is taken away.
    await t.save.evaluate((save) => { save.disabled = false; save.focus(); });
    await page.keyboard.press('Enter');
    await t.save.click();

    await page.waitForTimeout(100);
    expect(t.log.posts).toHaveLength(0);
    await expect(t.dialog).toBeVisible();
    expect(await t.dialogTitles()).toEqual(ABC);
    expect(t.saved()).toEqual(CBA);
    await t.kept();
  });
});

test('Check again reads only, shows the current order, and restores saving', async ({ page }) => {
  await withChapter(page, async (t) => {
    await page.evaluate(() => {
      document.querySelector('#note-create-dialog [name="title"]').value = 'Page draft';
    });
    const failing = await reopenWithFailedRead(page, t);

    // A second failure offers it again, where focus was.
    const getsBefore = t.log.gets.length;
    await recheckOf(t).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => t.log.gets.length).toBe(getsBefore + 1);
    await expect(recheckOf(t)).toBeFocused();
    await expect(t.save).toBeDisabled();

    failing.on = false;
    await page.keyboard.press('Enter');
    await expect.poll(() => t.dialogTitles()).toEqual(CBA);
    expect(t.log.gets).toHaveLength(getsBefore + 2);
    expect(t.log.posts).toHaveLength(0);
    await expect(t.save).toBeEnabled();
    await expect(t.summary).toBeHidden();
    await expect(recheckOf(t)).toHaveCount(0);
    await expect(t.dialog.locator('[data-notes-chapter-order-page]')).not.toHaveAttribute('inert', '');
    await expect(t.dialog.locator('[data-dialog-close]').first()).toBeFocused();
    expect(await t.mainTitles()).toEqual(CBA);
    expect(await t.numbers()).toEqual(['Page 1', 'Page 2', 'Page 3']);

    // The restored list takes the established keyboard and pointer moves.
    await t.handle(t.a).focus();
    await page.keyboard.press('Home');
    await expect(t.handle(t.a)).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    expect(await t.dialogTitles()).toEqual(['Page C', 'Page A', 'Page B']);
    await t.handle(t.b).dragTo(t.dialog.locator(`[data-note-id="${t.c.id}"]`), { targetPosition: { x: 20, y: 1 } });
    expect(await t.dialogTitles()).toEqual(['Page B', 'Page C', 'Page A']);

    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Page order saved.');
    await expect(t.trigger).toBeFocused();
    expect(t.log.posts).toHaveLength(1);
    expect(t.saved()).toEqual(['Page B', 'Page C', 'Page A']);
    await expect.poll(() => t.mainTitles()).toEqual(['Page B', 'Page C', 'Page A']);
    await expect.poll(() => t.navTitles()).toEqual(['Page B', 'Page C', 'Page A']);
    await expect(page.locator('#note-create-dialog [name="title"]')).toHaveValue('Page draft');
    await t.kept();
  });
});

test('a failed read can be dismissed, and reopening starts clean', async ({ page }) => {
  await withChapter(page, async (t) => {
    const failing = await reopenWithFailedRead(page, t);
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    await expect(t.trigger).toBeFocused();

    await t.trigger.click();
    await expect(recheckOf(t)).toBeVisible();
    await t.dialog.getByRole('button', { name: 'Close Change order', exact: true }).click();
    await expect(t.dialog).toBeHidden();

    await t.trigger.click();
    await expect(recheckOf(t)).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(t.dialog).toBeHidden();

    failing.on = false;
    await t.trigger.click();
    await expect.poll(() => t.dialogTitles()).toEqual(CBA);
    await expect(t.save).toBeEnabled();
    await expect(t.summary).toBeHidden();
    await expect(recheckOf(t)).toHaveCount(0);
    expect(t.log.posts).toHaveLength(0);
    await t.kept();
  });
});

test('a read from an earlier opening cannot restore its order', async ({ page }) => {
  await withChapter(page, async (t) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let first = true;
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (route.request().method() !== 'GET' || !first) return route.fallback();
      first = false;
      const stale = await route.fetch();
      await held;
      return route.fulfill({ response: stale });
    });
    await t.trigger.click();
    await expect.poll(() => first).toBe(false);
    await expect(t.save).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();

    t.app.locals.noteService.reorderNotes(t.chapter.id, [t.c.id, t.b.id, t.a.id]);
    await t.trigger.click();
    await expect.poll(() => t.dialogTitles()).toEqual(CBA);
    await expect(t.save).toBeEnabled();

    release();
    await page.waitForTimeout(200);
    expect(await t.dialogTitles()).toEqual(CBA);
    expect(await t.mainTitles()).toEqual(CBA);
    await expect(t.save).toBeEnabled();
    await expect(t.summary).toBeHidden();
    await t.kept();
  });
});

test('a late failure from an earlier opening leaves the verified order alone', async ({ page }) => {
  await withChapter(page, async (t) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let first = true;
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (route.request().method() !== 'GET' || !first) return route.fallback();
      first = false;
      await held;
      return route.abort();
    });
    await t.trigger.click();
    await expect.poll(() => first).toBe(false);
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();

    t.app.locals.noteService.reorderNotes(t.chapter.id, [t.c.id, t.b.id, t.a.id]);
    await t.trigger.click();
    await expect.poll(() => t.dialogTitles()).toEqual(CBA);
    await expect(t.save).toBeEnabled();

    release();
    await page.waitForTimeout(200);
    await expect(t.save).toBeEnabled();
    await expect(t.summary).toBeHidden();
    await expect(recheckOf(t)).toHaveCount(0);
    expect(await t.dialogTitles()).toEqual(CBA);
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowUp');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toEqual(['Page C', 'Page A', 'Page B']);
    await t.kept();
  });
});

test('a read answering after dismissal leaves the next opening unverified', async ({ page }) => {
  await withChapter(page, async (t) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let holding = true;
    await page.route((url) => url.pathname === t.hostPath, async (route) => {
      if (route.request().method() !== 'GET' || !holding) return route.fallback();
      const response = await route.fetch();
      await held;
      return route.fulfill({ response });
    });
    await t.trigger.click();
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    release();
    await expect.poll(() => t.log.gets.length).toBe(1);
    await page.waitForTimeout(100);
    await page.evaluate(() => document.getElementById('notes-chapter-order-form').requestSubmit());
    await page.waitForTimeout(50);
    expect(t.log.posts).toHaveLength(0);
    await expect(t.summary).toBeHidden();
    await t.kept();
  });
});

test('an uncertain Save keeps its draft when the read finds another sequence of the same Pages', async ({ page }) => {
  await withChapter(page, async (t) => {
    await page.evaluate(() => {
      document.querySelector('#note-create-dialog [name="title"]').value = 'Page draft';
    });
    await t.trigger.click();
    await expect(t.save).toBeEnabled();
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    expect(await t.dialogTitles()).toEqual(BAC);

    t.app.locals.noteService.reorderNotes(t.chapter.id, [t.c.id, t.b.id, t.a.id]);
    await page.route((url) => url.pathname === t.postPath, (route) => route.abort());
    await t.save.click();
    await expect(t.summary).toContainText('Could not confirm whether the Page order was saved');
    await expect(t.summary).toContainText('has changed since this order was arranged');
    await expect(t.save).toBeDisabled();
    await expect(t.dialog.locator('[data-dialog-close]').first()).toBeFocused();
    expect(await t.dialogTitles()).toEqual(BAC);
    await expect.poll(() => t.mainTitles()).toEqual(CBA);
    await expect(t.feedback).toBeHidden();

    await page.evaluate(() => document.getElementById('notes-chapter-order-form').requestSubmit());
    await page.waitForTimeout(100);
    expect(t.log.posts).toHaveLength(1);
    expect(t.saved()).toEqual(CBA);

    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    await expect(t.trigger).toBeFocused();
    expect(await t.dialogTitles()).toEqual(CBA);
    await page.unrouteAll();
    await t.trigger.click();
    await expect(t.save).toBeEnabled();
    await expect(t.summary).toBeHidden();
    expect(await t.dialogTitles()).toEqual(CBA);
    expect(t.log.posts).toHaveLength(1);
    await expect(page.locator('#note-create-dialog [name="title"]')).toHaveValue('Page draft');
    await t.kept();
  });
});

test('a draft started during the opening read yields to a changed sequence, not to a failure', async ({ page }) => {
  await withChapter(page, async (t) => {
    const holdRead = async (settle) => {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      await page.unrouteAll();
      await page.route((url) => url.pathname === t.hostPath, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        await held;
        return settle === 'abort' ? route.abort() : route.fulfill({ response });
      });
      return release;
    };

    // The read fails over the draft: the draft stays, and a retry finding the same
    // saved order makes it saveable.
    let release = await holdRead('abort');
    await t.trigger.click();
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    release();
    await expect(recheckOf(t)).toBeFocused();
    expect(await t.dialogTitles()).toEqual(BAC);
    await page.unrouteAll();
    await page.keyboard.press('Enter');
    await expect(t.save).toBeEnabled();
    expect(await t.dialogTitles()).toEqual(BAC);
    expect(t.log.posts).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    expect(await t.dialogTitles()).toEqual(ABC);

    // The read finds another sequence: the draft cannot override what it never saw.
    release = await holdRead('fulfill');
    t.app.locals.noteService.reorderNotes(t.chapter.id, [t.c.id, t.b.id, t.a.id]);
    await t.trigger.click();
    await t.handle(t.a).focus();
    await page.keyboard.press('ArrowDown');
    release();
    await expect(t.summary).toContainText('has changed since this order was arranged');
    await expect(t.save).toBeDisabled();
    expect(await t.dialogTitles()).toEqual(BAC);
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    expect(await t.dialogTitles()).toEqual(CBA);
    expect(t.log.posts).toHaveLength(0);
    expect(t.saved()).toEqual(CBA);
    await t.kept();
  });
});

test('a Page removed behind a failed read is picked up by Check again', async ({ page }) => {
  await withChapter(page, async (t) => {
    const failing = await reopenWithFailedRead(page, t);
    t.app.locals.noteService.deleteNote(t.b.id);
    failing.on = false;
    await recheckOf(t).click();
    await expect.poll(() => t.dialogTitles()).toEqual(['Page C', 'Page A']);
    await expect(t.save).toBeEnabled();
    await t.handle(t.a).focus();
    await page.keyboard.press('Home');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.saved()).toEqual(['Page A', 'Page C']);
    expect(t.log.posts).toHaveLength(1);
    await t.kept();
  });
});

test('the direct order URL stays native', async ({ page }) => {
  await withChapter(page, async (t) => {
    await page.goto(`${t.origin}${t.hostPath}/notes/order`);
    await expect(t.dialog).toBeVisible();
    await t.handle(t.a).focus();
    await page.keyboard.press('End');
    await t.save.click();
    await expect(page).toHaveURL(t.origin + t.hostPath);
    expect(t.saved()).toEqual(['Page B', 'Page C', 'Page A']);
  });
});
