import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// WP7.3: Project Detail "Reorder Notes". The button beside Create new note
// opens an in-page dialog that reads the WP7.2 order (GET
// /notes/projects/:id/order), reorders a draft with the shared Notes reorder
// engine (drag, Arrow Up/Down, Home/End), and saves it with exactly one POST to
// the same URL. A confirmed Save moves the existing cards at once and runs the
// existing GET-only Project Detail refresh; stale, refused and unconfirmed
// Saves never claim success and are never resent. Each test runs against its
// own isolated SQLite database and filesystem.

async function withProject(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-related-notes-order-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    const { projectService, bookService, chapterService, noteService } = app.locals;
    const project = projectService.create({ title: 'Order Project', status: 'tbd' });
    const other = projectService.create({ title: 'Other Project', status: 'tbd' });
    const single = projectService.create({ title: 'Single Project', status: 'tbd' });
    const empty = projectService.create({ title: 'Empty Project', status: 'tbd' });
    const book = bookService.createBook({ title: 'Lore' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'First Chapter' });
    const note = (title, projectIds) => noteService.createNote({
      chapterId: chapter.id, title, content: `${title} body text.`, projectIds,
    });
    const alpha = note('Alpha Page', [project.id]);
    const beta = note('Beta Page', [project.id, other.id]);
    const gamma = note('Gamma Page', [project.id]);
    const delta = note('Delta Page', [other.id]);
    const lone = note('Lone Page', [single.id]);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const hostPath = `/projects/${project.id}`;
    const orderPath = `/notes/projects/${project.id}/order`;

    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const log = { orderGets: 0, orderPosts: [], refreshes: 0, otherPosts: [] };
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === orderPath && request.method() === 'GET') log.orderGets += 1;
      else if (pathname === orderPath && request.method() === 'POST') log.orderPosts.push(request.postDataJSON());
      else if (pathname === hostPath && request.resourceType() === 'fetch' && request.method() === 'GET') log.refreshes += 1;
      else if (request.method() === 'POST') log.otherPosts.push(pathname);
    });

    const dialog = page.locator('#project-related-notes-order-dialog');
    const ids = (...notes) => notes.map((item) => String(item.id));
    const t = {
      app, db, origin, project, other, single, empty, book, chapter, alpha, beta, gamma, delta, lone,
      noteService, log, hostPath, orderPath, dialog, ids,
      trigger: page.locator('[data-project-related-notes-reorder]'),
      create: page.locator('[data-project-related-note-create]'),
      rows: dialog.locator('[data-project-related-notes-order-item]'),
      handle: (item) => dialog.locator(`[data-project-related-notes-order-item][data-note-id="${item.id}"] [data-project-related-notes-order-handle]`),
      row: (item) => dialog.locator(`[data-project-related-notes-order-item][data-note-id="${item.id}"]`),
      save: dialog.locator('[data-project-related-notes-order-save]'),
      cancel: dialog.getByRole('button', { name: 'Cancel', exact: true }),
      error: dialog.locator('[data-project-related-notes-order-error]'),
      status: dialog.locator('[data-project-related-notes-order-status]'),
      live: dialog.locator('[data-project-related-notes-order-live]'),
      feedback: page.locator('[data-dialog-feedback]'),
      refreshNote: page.locator('[data-project-related-notes-refresh-note]'),
      disclosure: (item) => page.locator(`[data-project-related-note-disclosure="${item.id}"]`),
      pin: (item) => page.locator(`[data-project-related-note-pin="${item.id}"]`),
      cardIds: () => page.locator('[data-project-related-note]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-project-related-note'))),
      rowIds: () => dialog.locator('[data-project-related-notes-order-item]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-note-id'))),
      serverOrder: (projectId = project.id) => noteService.listRelatedNotesForProject(projectId).notes.map((item) => String(item.id)),
      hierarchy: () => noteService.listNotesForChapter(chapter.id).map((item) => String(item.id)),
      async open(projectId = project.id) {
        await page.goto(`${origin}/projects/${projectId}`);
        await expect(page.locator('[data-project-related-note]:not([data-project-related-note-bound="true"])')).toHaveCount(0);
        await expect(page.locator('#project-related-notes-order-dialog[data-project-related-notes-order-dialog-bound="true"]')).toBeAttached();
      },
      async openDialog() {
        const before = log.orderGets;
        await t.trigger.click();
        await expect(dialog).toBeVisible();
        expect(log.orderGets).toBe(before + 1);
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

const key = (id) => `creatorcrate:related-notes:v1:note:${id}`;

test('A: Reorder Notes sits beside Create new note, enabled only with two or more Notes', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    await expect(t.trigger).toBeVisible();
    await expect(t.trigger).toBeEnabled();
    await expect(t.trigger).toHaveText('Reorder Notes');
    await expect(t.trigger).toHaveAttribute('aria-haspopup', 'dialog');
    // Directly beside Create new note, in the same action row, same styling.
    expect(await t.create.evaluate((node) => node.nextElementSibling?.hasAttribute('data-project-related-notes-reorder'))).toBe(true);
    expect(await t.trigger.getAttribute('class')).toBe(await t.create.getAttribute('class'));
    const createBox = await t.create.boundingBox();
    const triggerBox = await t.trigger.boundingBox();
    expect(Math.abs(createBox.y - triggerBox.y)).toBeLessThan(2);

    for (const projectId of [t.single.id, t.empty.id]) {
      await t.open(projectId);
      await expect(t.create).toBeEnabled();
      await expect(t.trigger).toBeVisible();
      await expect(t.trigger).toBeDisabled();
      await expect(t.trigger).toHaveAccessibleDescription('At least two related notes are needed to reorder them.');
    }

    // A replaced region (return refresh) still opens the dialog, once.
    await t.open();
    await page.evaluate(() => { document.querySelector('[data-project-related-notes-reorder]').__old = true; });
    const refreshes = t.log.refreshes;
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await expect.poll(() => t.log.refreshes).toBe(refreshes + 1);
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-project-related-notes-reorder]').__old === undefined)).toBe(true);
    await t.trigger.focus();
    await page.keyboard.press('Enter');
    await expect(t.dialog).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    expect(t.log.orderGets).toBe(1);
  });
});

test('B: the dialog opens in place on the authoritative order and reorders from the keyboard', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const url = page.url();
    // Repeated presses while the order loads send one read and open one dialog.
    await t.trigger.evaluate((node) => { node.click(); node.click(); });
    await expect(t.dialog).toBeVisible();
    expect(t.log.orderGets).toBe(1);
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    expect(page.url()).toBe(url);
    await expect(t.dialog.getByRole('heading', { level: 2 })).toHaveText('Reorder Notes');
    await expect(page.getByRole('dialog', { name: 'Reorder Notes' })).toBeVisible();
    await expect(t.dialog.locator('[data-project-related-notes-order-list]'))
      .toHaveAttribute('aria-label', 'Related Notes in Order Project');
    expect(await t.rowIds()).toEqual(t.serverOrder());
    expect(await t.rowIds()).toEqual(await t.cardIds());
    await expect(t.rows).toHaveCount(3);
    await expect(t.row(t.alpha)).toContainText('Alpha Page');
    await expect(t.dialog.locator('[data-dialog-close]').first()).toBeFocused();

    const [first, second, third] = await t.rowIds();
    const byId = { [t.alpha.id]: t.alpha, [t.beta.id]: t.beta, [t.gamma.id]: t.gamma };
    const firstNote = byId[first];
    await expect(t.handle(firstNote)).toHaveAccessibleName(`Reorder Note: ${firstNote.title}`);
    await t.handle(firstNote).focus();
    await page.keyboard.press('ArrowDown');
    expect(await t.rowIds()).toEqual([second, first, third]);
    await expect(t.live).toHaveText(`${firstNote.title} moved to position 2 of 3.`);
    await expect(t.row(firstNote).locator('[data-project-related-notes-order-position]')).toHaveText('Position 2 of 3');
    await expect(t.row(firstNote)).toHaveAttribute('aria-posinset', '2');
    await expect(t.handle(firstNote)).toBeFocused();
    await page.keyboard.press('End');
    expect(await t.rowIds()).toEqual([second, third, first]);
    await page.keyboard.press('Home');
    expect(await t.rowIds()).toEqual([first, second, third]);
    await page.keyboard.press('ArrowUp');
    expect(await t.rowIds()).toEqual([first, second, third]);

    // Focus stays inside the modal.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#project-related-notes-order-dialog')))).toBe(true);
    }
    // Nothing was written.
    expect(t.log.orderPosts).toEqual([]);
  });
});

test('C: Cancel, Close and Escape discard the draft; reopening reads the order again', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const original = t.serverOrder();
    const cards = await t.cardIds();
    await t.openDialog();
    const first = original[0];
    await t.dialog.locator(`[data-note-id="${first}"] [data-project-related-notes-order-handle]`).focus();
    await page.keyboard.press('End');
    expect((await t.rowIds()).at(-1)).toBe(first);

    await t.cancel.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.trigger).toBeFocused();
    expect(await t.cardIds()).toEqual(cards);
    expect(t.serverOrder()).toEqual(original);
    expect(t.log.orderPosts).toEqual([]);

    // Reopening reads again and shows the authoritative order.
    await t.openDialog();
    expect(await t.rowIds()).toEqual(original);
    await t.dialog.locator(`[data-note-id="${first}"] [data-project-related-notes-order-handle]`).focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Escape');
    await expect(t.dialog).toBeHidden();
    await expect(t.trigger).toBeFocused();
    await t.openDialog();
    expect(await t.rowIds()).toEqual(original);
    await t.dialog.locator('[data-dialog-close]').first().click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.orderGets).toBe(3);
    expect(t.log.orderPosts).toEqual([]);
    expect(t.serverOrder()).toEqual(original);
  });
});

test('D: a dragged order saves once, moves the cards at once and persists for this project only', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const hierarchy = t.hierarchy();
    const otherOrder = t.serverOrder(t.other.id);
    const original = t.serverOrder();
    await t.openDialog();
    // Drag the last row above the first.
    const [first, , last] = original;
    await t.dialog.locator(`[data-note-id="${last}"] [data-project-related-notes-order-handle]`)
      .dragTo(t.dialog.locator(`[data-project-related-notes-order-item][data-note-id="${first}"]`), { targetPosition: { x: 20, y: 1 } });
    const desired = [last, ...original.slice(0, 2)];
    expect(await t.rowIds()).toEqual(desired);
    expect(t.log.orderPosts).toEqual([]);

    // Hold the reconciliation read to see the immediate card order.
    let releaseRefresh;
    const refreshHeld = new Promise((resolve) => { releaseRefresh = resolve; });
    await page.route(`**${t.hostPath}`, async (route) => {
      if (route.request().resourceType() === 'fetch') await refreshHeld;
      await route.continue();
    });
    const cardsBefore = await page.locator('[data-project-related-note]').evaluateAll((cards) => cards.map((card) => { card.__kept = true; return card.id; }));
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.trigger).toBeFocused();
    await expect(t.feedback).toContainText('Note order saved.');
    expect(await t.cardIds()).toEqual(desired);
    // The same card elements were moved, not rebuilt.
    expect(await page.locator('[data-project-related-note]').evaluateAll((cards) => cards.every((card) => card.__kept === true))).toBe(true);
    expect(cardsBefore).toHaveLength(3);
    expect(t.log.orderPosts).toEqual([{ expectedNoteIds: original, orderedNoteIds: desired }]);
    releaseRefresh();
    await expect.poll(() => t.log.refreshes).toBe(1);
    await expect.poll(() => page.locator('[data-project-related-note]').evaluateAll((cards) => cards.some((card) => card.__kept))).toBe(false);
    await page.unroute(`**${t.hostPath}`);
    expect(await t.cardIds()).toEqual(desired);
    await expect(t.refreshNote).toHaveCount(0);

    expect(t.serverOrder()).toEqual(desired);
    expect(t.serverOrder(t.other.id)).toEqual(otherOrder);
    expect(t.hierarchy()).toEqual(hierarchy);
    expect(t.log.otherPosts).toEqual([]);
    await page.reload();
    await t.open();
    expect(await t.cardIds()).toEqual(desired);
    expect(t.log.orderPosts).toHaveLength(1);
  });
});

test('E: expansion and pins survive the immediate order and the reconciliation', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    // Gamma pinned (starts expanded) then collapsed by hand; Alpha expanded unpinned.
    await t.pin(t.gamma).click();
    await expect(t.disclosure(t.gamma)).toHaveAttribute('aria-expanded', 'true');
    await t.disclosure(t.gamma).click();
    await t.disclosure(t.alpha).click();
    const expectStates = async () => {
      await expect(t.disclosure(t.alpha)).toHaveAttribute('aria-expanded', 'true');
      await expect(t.disclosure(t.gamma)).toHaveAttribute('aria-expanded', 'false');
      await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'false');
      await expect(t.pin(t.gamma)).toHaveAttribute('aria-pressed', 'true');
      await expect(t.pin(t.alpha)).toHaveAttribute('aria-pressed', 'false');
      expect(await page.evaluate((k) => localStorage.getItem(k), key(t.gamma.id))).toBe('1');
      expect(await page.evaluate((k) => localStorage.getItem(k), key(t.alpha.id))).toBeNull();
    };
    await expectStates();

    const original = t.serverOrder();
    let releaseRefresh;
    const refreshHeld = new Promise((resolve) => { releaseRefresh = resolve; });
    await page.route(`**${t.hostPath}`, async (route) => {
      if (route.request().resourceType() === 'fetch') await refreshHeld;
      await route.continue();
    });
    await t.openDialog();
    await t.dialog.locator(`[data-note-id="${original[0]}"] [data-project-related-notes-order-handle]`).focus();
    await page.keyboard.press('End');
    const desired = await t.rowIds();
    await page.keyboard.press('Tab');
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(await t.cardIds()).toEqual(desired);
    await expectStates();
    releaseRefresh();
    await expect.poll(() => t.log.refreshes).toBe(1);
    await expect(t.feedback).toContainText('Note order saved.');
    await page.unroute(`**${t.hostPath}`);
    expect(await t.cardIds()).toEqual(desired);
    await expectStates();
    // Disclosure and Pin controls still work on the reconciled cards.
    await t.disclosure(t.beta).click();
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'true');
  });
});

test('F: a stale Save is refused, shows the current order for review, and can be saved again', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const original = t.serverOrder();
    await t.openDialog();
    await t.dialog.locator(`[data-note-id="${original[0]}"] [data-project-related-notes-order-handle]`).focus();
    await page.keyboard.press('End');
    const draft = await t.rowIds();

    // Elsewhere: another order is saved and a Note joins the project.
    const elsewhere = [original[1], original[0], original[2]];
    t.noteService.reorderRelatedNotesForProject(t.project.id, { expectedNoteIds: original.map(Number), orderedNoteIds: elsewhere.map(Number) });
    const joined = t.noteService.createNote({ chapterId: t.chapter.id, title: 'Joined Page', content: 'Joined.', projectIds: [t.project.id] });
    const current = t.serverOrder();
    expect(current).toContain(String(joined.id));

    const response = page.waitForResponse((r) => new URL(r.url()).pathname === t.orderPath && r.request().method() === 'POST');
    await t.save.click();
    expect((await response).status()).toBe(409);
    await expect(t.dialog).toBeVisible();
    await expect(t.error).toBeVisible();
    await expect(t.error).toHaveAttribute('role', 'alert');
    await expect(t.error).toContainText('Related Notes changed while this dialog was open, so your order was not saved.');
    expect(await t.rowIds()).toEqual(current);
    expect(t.serverOrder()).toEqual(current);
    expect(await t.cardIds()).not.toEqual(draft);
    await expect(t.feedback).toBeHidden();
    await expect(t.save).toBeEnabled();
    expect(t.log.orderPosts).toHaveLength(1);
    expect(t.log.refreshes).toBe(0);

    // Reorder the reviewed order and Save: the new snapshot is used.
    await t.dialog.locator(`[data-note-id="${joined.id}"] [data-project-related-notes-order-handle]`).focus();
    await page.keyboard.press('Home');
    const next = await t.rowIds();
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.orderPosts[1]).toEqual({ expectedNoteIds: current, orderedNoteIds: next });
    expect(t.serverOrder()).toEqual(next);
    await expect.poll(() => t.log.refreshes).toBe(1);
    await expect.poll(() => t.cardIds()).toEqual(next);
  });
});

test('G: validation, unreadable, network and refresh failures never claim or repeat a Save', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const original = t.serverOrder();
    const cards = await t.cardIds();
    await t.openDialog();
    await t.dialog.locator(`[data-note-id="${original[0]}"] [data-project-related-notes-order-handle]`).focus();
    await page.keyboard.press('End');
    const draft = await t.rowIds();

    // 422 from the real endpoint (a malformed snapshot reaches the server).
    await page.route(`**${t.orderPath}`, (route) => (route.request().method() === 'POST'
      ? route.continue({ postData: JSON.stringify({ expectedNoteIds: 'nope', orderedNoteIds: draft }) })
      : route.continue()), { times: 1 });
    await t.save.click();
    await expect(t.error).toContainText('expectedNoteIds must be an array of Note IDs.');
    await expect(t.dialog).toBeVisible();
    expect(await t.rowIds()).toEqual(draft);
    expect(t.serverOrder()).toEqual(original);
    await expect(t.save).toBeEnabled();
    await expect(t.feedback).toBeHidden();

    // Network failure: unknown outcome, draft kept, nothing resent.
    await page.route(`**${t.orderPath}`, (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()), { times: 1 });
    await t.save.click();
    await expect(t.status).toContainText('could not be confirmed, so it may or may not have been saved');
    const check = t.dialog.locator('[data-project-related-notes-order-check]');
    await expect(check).toHaveText('Check saved order');
    expect(await t.rowIds()).toEqual(draft);
    await page.waitForTimeout(300);
    expect(t.log.orderPosts).toHaveLength(2);
    const gets = t.log.orderGets;
    await check.click();
    await expect(t.error).toContainText('The saved order is still the order this dialog opened with');
    expect(t.log.orderGets).toBe(gets + 1);
    expect(t.log.orderPosts).toHaveLength(2);
    expect(await t.rowIds()).toEqual(draft);

    // An unreadable 200 is not a confirmation either.
    await page.route(`**${t.orderPath}`, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<p>?</p>' })
      : route.continue()), { times: 1 });
    await t.save.click();
    await expect(t.status).toContainText('could not be confirmed');
    await expect(t.dialog).toBeVisible();
    await expect(t.feedback).toBeHidden();
    expect(await t.cardIds()).toEqual(cards);
    expect(t.log.orderPosts).toHaveLength(3);
    expect(t.serverOrder()).toEqual(original);

    // Confirmed Save, failed reconciliation: the order stays, Retry is GET-only.
    await page.route(`**${t.hostPath}`, (route) => (route.request().resourceType() === 'fetch' ? route.abort() : route.continue()));
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.serverOrder()).toEqual(draft);
    expect(await t.cardIds()).toEqual(draft);
    await expect(t.feedback).toContainText('Note order saved.');
    await expect(t.refreshNote).toContainText('Related Notes could not be updated');
    const retry = page.locator('[data-project-related-notes-refresh-retry]');
    await expect(retry).toBeVisible();
    await page.unroute(`**${t.hostPath}`);
    const posts = t.log.orderPosts.length;
    await retry.click();
    await expect(t.refreshNote).toHaveCount(0);
    await expect(t.feedback).toContainText('Note order saved.');
    expect(t.log.orderPosts).toHaveLength(posts);
    expect(posts).toBe(4);
    expect(await t.cardIds()).toEqual(draft);
    expect(t.log.otherPosts).toEqual([]);
  });
});

test('G2: a Save in flight cannot be closed, and a vanished project locks Save', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    await t.openDialog();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**${t.orderPath}`, async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    });
    await t.dialog.locator('[data-project-related-notes-order-item] [data-project-related-notes-order-handle]').first().focus();
    await page.keyboard.press('End');
    await t.save.click();
    await expect(t.status).toContainText('Saving note order…');
    await expect(t.save).toBeDisabled();
    await page.keyboard.press('Escape');
    await t.cancel.click();
    await expect(t.dialog).toBeVisible();
    await expect(t.status).toContainText('Wait for the note order to finish saving');
    // The engine ignores moves while saving.
    const during = await t.rowIds();
    await t.dialog.locator('[data-project-related-notes-order-item] [data-project-related-notes-order-handle]').first().evaluate((node) => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(await t.rowIds()).toEqual(during);
    release();
    await expect(t.dialog).toBeHidden();
    await page.unroute(`**${t.orderPath}`);
    expect(t.log.orderPosts).toHaveLength(1);

    // The project disappears while the dialog is open: 404 locks Save.
    await t.openDialog();
    await page.route(`**${t.orderPath}`, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ status: 'error', code: 'PROJECT_NOT_FOUND', message: 'This project is no longer available.' }) })
      : route.continue()), { times: 1 });
    await t.dialog.locator('[data-project-related-notes-order-item] [data-project-related-notes-order-handle]').first().focus();
    await page.keyboard.press('End');
    await t.save.click();
    await expect(t.error).toContainText('This project is no longer available');
    await expect(t.save).toBeDisabled();
    await t.cancel.click();
    await expect(t.dialog).toBeHidden();
  });
});

test('H: Create, Edit, disclosure and return refresh keep working beside Reorder Notes', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    await t.openDialog();
    await t.dialog.locator('[data-project-related-notes-order-item] [data-project-related-notes-order-handle]').first().focus();
    await page.keyboard.press('End');
    const desired = await t.rowIds();
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect.poll(() => t.log.refreshes).toBe(1);

    // Create new note still opens Create Note in place.
    await t.create.click();
    const createDialog = page.locator('#project-note-create-dialog');
    await expect(createDialog).toBeVisible();
    await createDialog.locator('[data-dialog-close]').first().click();
    await expect(createDialog).toBeHidden();

    // Edit still opens the Notes Edit Page dialog in place.
    await page.locator(`[data-project-related-note-edit="${t.alpha.id}"]`).click();
    const editDialog = page.locator('#note-edit-dialog');
    await expect(editDialog).toBeVisible();
    await editDialog.locator('[data-dialog-close]').first().click();
    await expect(editDialog).toBeHidden();

    // The return refresh keeps the saved order and the button.
    const refreshes = t.log.refreshes;
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await expect.poll(() => t.log.refreshes).toBe(refreshes + 1);
    expect(await t.cardIds()).toEqual(desired);
    await t.disclosure(t.beta).click();
    await expect(t.disclosure(t.beta)).toHaveAttribute('aria-expanded', 'true');
    await t.openDialog();
    expect(await t.rowIds()).toEqual(desired);
    await t.cancel.click();

    // Narrow screens: no horizontal overflow, dialog usable.
    await page.setViewportSize({ width: 360, height: 740 });
    await t.openDialog();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await t.dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    await expect(t.save).toBeInViewport();
    await t.cancel.click();
  });
});

// ─── WP7.3-F1 ────────────────────────────────────────────────────────────────

const SAVED_EVENT = 'creatorcrate:project-related-notes-order-saved';

async function countSavedEvents(page) {
  await page.evaluate((name) => {
    window.__orderSaved = 0;
    document.addEventListener(name, () => { window.__orderSaved += 1; });
  }, SAVED_EVENT);
  return () => page.evaluate(() => window.__orderSaved);
}

function titleOf(t, id) {
  return [t.alpha, t.beta, t.gamma].find((item) => String(item.id) === String(id)).title;
}

// Moves the first row to the end: [a, b, c] -> [b, c, a].
async function moveFirstToEnd(t, page) {
  const [first] = await t.rowIds();
  await t.dialog.locator(`[data-note-id="${first}"] [data-project-related-notes-order-handle]`).focus();
  await page.keyboard.press('End');
  return t.rowIds();
}

test('F1-A: only a complete 200 acknowledgement of the submitted order confirms a Save', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const savedEvents = await countSavedEvents(page);
    const original = t.serverOrder();
    const cards = await t.cardIds();
    await t.openDialog();
    const desired = await moveFirstToEnd(t, page);
    expect(desired).toEqual([original[1], original[2], original[0]]);

    const project = { id: t.project.id, title: t.project.title, url: `/projects/${t.project.id}`, archived: false };
    const notesFor = (ids) => ids.map((id) => ({ id: Number(id), title: titleOf(t, id), url: `/notes/${id}` }));
    const answer = (ids, extra = {}) => ({
      status: 'success', message: 'Note order saved.', changed: true, project,
      notes: notesFor(ids), expectedNoteIds: ids.map(Number), saveUrl: t.orderPath, ...extra,
    });
    const cases = [
      ['200, empty order', 200, answer([])],
      ['200, the previous order', 200, answer(original)],
      ['201, otherwise plausible', 201, answer(desired)],
      ['200, missing Note ID', 200, answer(desired, { notes: notesFor(desired).map((note, i) => (i === 1 ? { title: note.title } : note)) })],
      ['200, non-canonical Note ID', 200, answer(desired, { notes: notesFor(desired).map((note, i) => (i === 0 ? { ...note, id: `0${note.id}` } : note)) })],
      ['200, Note IDs of the wrong type', 200, answer(desired, { notes: notesFor(desired).map((note) => ({ ...note, id: [note.id] })), expectedNoteIds: desired.map((id) => [Number(id)]) })],
      ['200, duplicated Note IDs', 200, answer([desired[0], desired[0], desired[2]])],
      ['200, partial order', 200, answer(desired.slice(0, 2))],
      ['200, contradictory order fields', 200, answer(desired, { expectedNoteIds: original.map(Number) })],
      ['200, another project', 200, answer(desired, { project: { ...project, id: t.other.id } })],
      ['200, no changed flag', 200, answer(desired, { changed: undefined })],
    ];

    const check = t.dialog.locator('[data-project-related-notes-order-check]');
    for (const [label, status, body] of cases) {
      const posts = t.log.orderPosts.length;
      await page.route(`**${t.orderPath}`, (route) => (route.request().method() === 'POST'
        ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
        : route.continue()), { times: 1 });
      await t.save.click();
      await expect(t.status, label).toContainText('could not be confirmed, so it may or may not have been saved');
      await expect(check, label).toHaveText('Check saved order');
      await expect(t.dialog, label).toBeVisible();
      expect(await t.rowIds(), label).toEqual(desired);
      expect(await t.cardIds(), label).toEqual(cards);
      await expect(t.feedback, label).toBeHidden();
      await expect(t.save, label).toBeEnabled();
      await page.waitForTimeout(150);
      expect(t.log.orderPosts.length, label).toBe(posts + 1);
      expect(t.log.orderPosts.at(-1), label).toEqual({ expectedNoteIds: original, orderedNoteIds: desired });
      expect(await savedEvents(), label).toBe(0);
      expect(t.log.refreshes, label).toBe(0);
    }
    expect(t.serverOrder()).toEqual(original);

    // The GET-only check is available and changes nothing it was not asked to.
    const gets = t.log.orderGets;
    const posts = t.log.orderPosts.length;
    await check.click();
    await expect(t.error).toContainText('The saved order is still the order this dialog opened with');
    expect(t.log.orderGets).toBe(gets + 1);
    expect(t.log.orderPosts).toHaveLength(posts);
    expect(await t.rowIds()).toEqual(desired);

    // A valid acknowledgement still confirms, once.
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    await expect(t.feedback).toContainText('Note order saved.');
    expect(await t.cardIds()).toEqual(desired);
    expect(t.serverOrder()).toEqual(desired);
    expect(await savedEvents()).toBe(1);
  });
});

test('F1-B: a JSON 500 after the reorder committed is uncertain, not a refusal', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const savedEvents = await countSavedEvents(page);
    const original = t.serverOrder();
    const cards = await t.cardIds();
    await t.openDialog();
    const desired = await moveFirstToEnd(t, page);

    // The real write commits; the route's following project lookup fails.
    const { projectService } = t.app.locals;
    const findById = projectService.findById;
    projectService.findById = function failOnce() {
      projectService.findById = findById;
      throw new Error('lookup failed after commit');
    };
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === t.orderPath && r.request().method() === 'POST');
    await t.save.click();
    const answer = await response;
    projectService.findById = findById;
    expect(answer.status()).toBe(500);
    expect(await answer.json()).toMatchObject({ status: 'error' });
    expect(t.serverOrder()).toEqual(desired);

    await expect(t.status).toContainText('could not be confirmed, so it may or may not have been saved');
    await expect(t.error).toBeHidden();
    const check = t.dialog.locator('[data-project-related-notes-order-check]');
    await expect(check).toHaveText('Check saved order');
    expect(await t.rowIds()).toEqual(desired);
    expect(await t.cardIds()).toEqual(cards);
    await expect(t.feedback).toBeHidden();
    await page.waitForTimeout(300);
    expect(t.log.orderPosts).toEqual([{ expectedNoteIds: original, orderedNoteIds: desired }]);
    expect(await savedEvents()).toBe(0);

    await check.click();
    await expect(t.error).toContainText('The saved order now matches your arrangement');
    expect(await t.rowIds()).toEqual(desired);
    expect(t.log.orderPosts).toHaveLength(1);
  });
});

test('F1-C: a late Check saved order keeps moves made while it read', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    await t.openDialog();
    const submitted = await moveFirstToEnd(t, page);

    // The write commits; its acknowledgement is lost.
    await page.route(`**${t.orderPath}`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      return route.abort();
    }, { times: 1 });
    await t.save.click();
    await expect(t.status).toContainText('could not be confirmed');
    expect(t.serverOrder()).toEqual(submitted);

    // Hold the check's read, move again meanwhile, then release it.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**${t.orderPath}`, async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.continue();
    }, { times: 1 });
    const gets = t.log.orderGets;
    await t.dialog.locator('[data-project-related-notes-order-check]').click();
    await expect(t.status).toContainText('Checking the saved note order');
    await expect.poll(() => t.log.orderGets).toBe(gets + 1);
    const newer = await moveFirstToEnd(t, page);
    expect(newer).toEqual([submitted[1], submitted[2], submitted[0]]);
    release();

    const savedText = submitted.map((id, index) => `${index + 1}. ${titleOf(t, id)}`).join(', ');
    await expect(t.error).toContainText(`The saved order is now: ${savedText}.`);
    await expect(t.error).toContainText('Your arrangement is still shown and is not saved');
    expect(await t.rowIds()).toEqual(newer);
    expect(t.serverOrder()).toEqual(submitted);
    expect(t.log.orderPosts).toHaveLength(1);

    // Save measures the newer draft against the order the server holds.
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.orderPosts[1]).toEqual({ expectedNoteIds: submitted, orderedNoteIds: newer });
    expect(t.serverOrder()).toEqual(newer);
    await expect.poll(() => t.cardIds()).toEqual(newer);
  });
});

test('F1-C2: a failed Check saved order keeps the arrangement and resends nothing', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    await t.openDialog();
    const draft = await moveFirstToEnd(t, page);
    await page.route(`**${t.orderPath}`, (route) => route.abort(), { times: 2 });
    await t.save.click();
    await expect(t.status).toContainText('could not be confirmed');
    await t.dialog.locator('[data-project-related-notes-order-check]').click();
    await expect(t.status).toContainText('The saved note order could not be read. Your arrangement is kept; check again.');
    await expect(t.dialog.locator('[data-project-related-notes-order-check]')).toHaveText('Check saved order');
    expect(await t.rowIds()).toEqual(draft);
    await page.waitForTimeout(200);
    expect(t.log.orderPosts).toHaveLength(1);
  });
});

test('F1-D: changed Notes during a check never replace the arrangement without the user', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    await t.openDialog();
    await moveFirstToEnd(t, page);
    await page.route(`**${t.orderPath}`, (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()), { times: 1 });
    await t.save.click();
    await expect(t.status).toContainText('could not be confirmed');

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**${t.orderPath}`, async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.continue();
    }, { times: 1 });
    const gets = t.log.orderGets;
    await t.dialog.locator('[data-project-related-notes-order-check]').click();
    await expect.poll(() => t.log.orderGets).toBe(gets + 1);
    // Elsewhere a Note joins the project; here the user keeps arranging.
    const joined = t.noteService.createNote({ chapterId: t.chapter.id, title: 'Joined Page', content: 'Joined.', projectIds: [t.project.id] });
    const local = await moveFirstToEnd(t, page);
    release();

    await expect(t.error).toContainText('The related notes for this project changed');
    expect(await t.rowIds()).toEqual(local);
    await expect(t.save).toBeDisabled();
    const reload = t.dialog.locator('[data-project-related-notes-order-reload]');
    await expect(reload).toHaveText('Show current order');
    // The stale permutation cannot be submitted, by button or by form.
    await t.dialog.locator('[data-project-related-notes-order-form]').evaluate((form) => form.requestSubmit());
    await page.waitForTimeout(200);
    expect(t.log.orderPosts).toHaveLength(1);
    expect(await t.rowIds()).toEqual(local);

    // The user's explicit choice reads (GET only) and shows the current order.
    const current = t.serverOrder();
    expect(current).toContain(String(joined.id));
    await reload.click();
    await expect(t.error).toContainText('The current saved order is shown');
    expect(await t.rowIds()).toEqual(current);
    await expect(t.save).toBeEnabled();
    expect(t.log.orderPosts).toHaveLength(1);

    await t.dialog.locator(`[data-note-id="${joined.id}"] [data-project-related-notes-order-handle]`).focus();
    await page.keyboard.press('Home');
    const next = await t.rowIds();
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.orderPosts[1]).toEqual({ expectedNoteIds: current, orderedNoteIds: next });
    expect(t.serverOrder()).toEqual(next);
  });
});

test('F1-E: dragging a row announces its new position once, without saving', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const original = t.serverOrder();
    await t.openDialog();
    await expect(t.live).toHaveText('');
    const [first, , last] = original;
    await t.dialog.locator(`[data-note-id="${last}"] [data-project-related-notes-order-handle]`)
      .dragTo(t.dialog.locator(`[data-project-related-notes-order-item][data-note-id="${first}"]`), { targetPosition: { x: 20, y: 1 } });
    expect(await t.rowIds()).toEqual([last, original[0], original[1]]);
    await expect(t.live).toHaveText(`${titleOf(t, last)} moved to position 1 of 3.`);
    await expect(t.live).toHaveAttribute('aria-live', 'polite');

    // Keyboard moves still announce, once each.
    await t.dialog.locator(`[data-note-id="${last}"] [data-project-related-notes-order-handle]`).focus();
    await page.keyboard.press('ArrowDown');
    await expect(t.live).toHaveText(`${titleOf(t, last)} moved to position 2 of 3.`);
    await page.waitForTimeout(200);
    expect(t.log.orderPosts).toEqual([]);
    expect(t.serverOrder()).toEqual(original);
  });
});

test('F2-A: an arrangement moved back to the saved order is recognised as matching it', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const original = t.serverOrder();
    await t.openDialog();
    await moveFirstToEnd(t, page);

    // The Save never reaches the server: its outcome is unknown here.
    await page.route(`**${t.orderPath}`, (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()), { times: 1 });
    await t.save.click();
    await expect(t.status).toContainText('could not be confirmed, so it may or may not have been saved');
    expect(t.serverOrder()).toEqual(original);

    // The user moves the draft back to the order the dialog opened with.
    await t.dialog.locator(`[data-note-id="${original[0]}"] [data-project-related-notes-order-handle]`).focus();
    await page.keyboard.press('Home');
    expect(await t.rowIds()).toEqual(original);

    const gets = t.log.orderGets;
    await t.dialog.locator('[data-project-related-notes-order-check]').click();
    await expect(t.error).toContainText('The saved order now matches your arrangement');
    await expect(t.error).not.toContainText('not in effect');
    await expect(t.error).not.toContainText('opened with');
    await expect(t.feedback).toBeHidden();
    expect(t.log.orderGets).toBe(gets + 1);
    expect(await t.rowIds()).toEqual(original);
    await page.waitForTimeout(200);
    expect(t.log.orderPosts).toHaveLength(1);
    expect(t.serverOrder()).toEqual(original);

    // A later explicit Save is measured against the order the server holds.
    const next = await moveFirstToEnd(t, page);
    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.orderPosts[1]).toEqual({ expectedNoteIds: original, orderedNoteIds: next });
    expect(t.serverOrder()).toEqual(next);
  });
});

test('F2-B: an unsaved arrangement over the unchanged saved order stays unsaved and can be saved', async ({ page }) => {
  await withProject(page, async (t) => {
    await t.open();
    const original = t.serverOrder();
    await t.openDialog();
    const draft = await moveFirstToEnd(t, page);
    expect(draft).toEqual([original[1], original[2], original[0]]);

    await page.route(`**${t.orderPath}`, (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()), { times: 1 });
    await t.save.click();
    await expect(t.status).toContainText('could not be confirmed');

    await t.dialog.locator('[data-project-related-notes-order-check]').click();
    await expect(t.error).toContainText('The saved order is still the order this dialog opened with, so your arrangement is not in effect');
    await expect(t.error).not.toContainText('matches your arrangement');
    await expect(t.feedback).toBeHidden();
    expect(await t.rowIds()).toEqual(draft);
    await expect(t.save).toBeEnabled();
    await page.waitForTimeout(200);
    expect(t.log.orderPosts).toHaveLength(1);
    expect(t.serverOrder()).toEqual(original);

    await t.save.click();
    await expect(t.dialog).toBeHidden();
    expect(t.log.orderPosts[1]).toEqual({ expectedNoteIds: original, orderedNoteIds: draft });
    expect(t.serverOrder()).toEqual(draft);
  });
});
