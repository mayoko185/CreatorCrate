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
import { createAssetRepository } from '../../src/data/asset-repository.js';
import { createNoteDeletionId } from '../../src/services/note-service.js';

// Undo on the parent of a deleted Page: real deletions against the real server and
// built client, with one restore POST per activation, and reads settling everything
// that is uncertain.

test.beforeAll(() => {
  execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
});

async function withUndo(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-undo-flow-'));
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

    const { noteService, chapterService, bookService, bookPagePreviewSettingsService } = app.locals;
    const book = bookService.createBook({ title: 'Host Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Host Chapter' });
    const a = noteService.createNote({ chapterId: chapter.id, title: 'Page A', content: 'Body A' });
    const b = noteService.createNote({ chapterId: chapter.id, title: 'Page B', content: 'Body B' });
    const c = noteService.createNote({ chapterId: chapter.id, title: 'Page C', content: 'Body C' });
    const direct = noteService.createNote({ bookId: book.id, title: 'Direct Page', content: 'Body direct' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const chapterPath = `/notes/chapters/${chapter.id}`;
    const bookPath = `/notes/books/${book.id}`;

    const errors = [];
    const log = { restores: 0, deletes: 0, statusGets: 0, fetchGets: [], requests: [] };
    const track = (target) => {
      target.on('pageerror', (error) => errors.push(error.message));
      target.on('request', (request) => {
        const { pathname } = new URL(request.url());
        log.requests.push(`${request.method()} ${pathname}`);
        if (request.method() === 'POST' && /^\/notes\/page-deletions\/[^/]+\/restore$/.test(pathname)) log.restores += 1;
        if (request.method() === 'POST' && /^\/notes\/\d+\/delete$/.test(pathname)) log.deletes += 1;
        if (request.method() === 'GET' && /^\/notes\/page-deletions\/[^/]+$/.test(pathname)) log.statusGets += 1;
        if (request.method() === 'GET' && request.resourceType() === 'fetch') log.fetchGets.push(pathname);
      });
    };
    track(page);

    const alerts = page.locator('[data-page-deletion-undo-alert]');
    const alertFor = (title) => alerts.filter({ hasText: `“${title}”` });
    const undoFor = (title) => alertFor(title).locator('[data-page-deletion-undo]');
    const confirmation = page.locator('#app-confirmation-dialog');
    const t = {
      app, db, book, chapter, a, b, c, direct, origin, chapterPath, bookPath, log, track, alerts, alertFor, undoFor, confirmation,
      noteService, bookService, chapterService, bookPagePreviewSettingsService,
      exists: (note) => Boolean(db.prepare('SELECT id FROM notes WHERE id = ?').get(note.id)),
      noteCount: () => db.prepare('SELECT COUNT(*) AS n FROM notes').get().n,
      snapshot: (id) => db.prepare('SELECT * FROM note_deletion_snapshots WHERE id = ?').get(id),
      activeIds: () => db.prepare('SELECT id FROM note_deletion_snapshots WHERE restored_at IS NULL ORDER BY created_at, rowid').all().map(({ id }) => id),
      idOf: (title) => alertFor(title).getAttribute('data-page-deletion-undo-alert'),
      expire: (id, at = null) => db.prepare('UPDATE note_deletion_snapshots SET expires_at = COALESCE(?, created_at + 1) WHERE id = ?').run(at, id),
      savedOrder: () => noteService.listNotesForChapter(chapter.id).map((note) => note.title),
      pageTitles: () => page.locator('.notes-chapter-pages .notes-page-nav-link').allTextContents(),
      mark: () => page.evaluate(() => { window.__undoDocument = true; }),
      marked: () => page.evaluate(() => window.__undoDocument === true),
      deletePage: async (note, target = page) => {
        await target.goto(`${origin}/notes/${note.id}`);
        await target.locator('.page-heading [data-dialog-open="note-edit-dialog"]').click();
        const dialog = target.locator('#note-edit-dialog');
        await expect(dialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]')).toBeVisible();
        await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
        await dialog.locator('button[form="note-delete-form"]').click();
        await target.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
        await expect(target).toHaveURL(new RegExp(`/notes/(chapters|books)/\\d+$`));
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

// Holds the request before it reaches the server.
async function holdBeforeServer(page, url, method = 'POST') {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let arrive;
  const arrived = new Promise((resolve) => { arrive = resolve; });
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    arrive();
    await released;
    return route.continue();
  }, { times: 1 });
  return { arrived, release };
}

const STATUS_URL = '**/notes/page-deletions/*';
const RESTORE_URL = '**/notes/page-deletions/*/restore';

test('flow 1: a saved Chapter Page round trip restores the original with one POST', async ({ page }) => {
  await withUndo(page, async (t) => {
    const projectId = Number(t.db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
      VALUES ('Linked Project', 'linked-project', '', '', 'tbd', 'images', NULL)
    `).run().lastInsertRowid);
    const assetId = createAssetRepository(t.db).upsert(projectId, 'linked.png', {
      filename: 'linked.png', extension: '.png', mimeType: 'image/png', sizeBytes: 1,
    }).id;
    t.noteService.updateNote(t.b.id, { title: 'Page B', content: 'Saved **Markdown**', projectIds: [projectId], assetIds: [assetId] });
    t.noteService.updateNote(t.b.id, { title: 'Page B', content: 'Saved **Markdown** again', projectIds: [projectId], assetIds: [assetId] });
    const revisions = t.db.prepare('SELECT id FROM note_revisions WHERE note_id = ? ORDER BY id').all(t.b.id);
    expect(revisions.length).toBeGreaterThan(0);
    const before = t.noteCount();

    await t.deletePage(t.b);
    expect(t.log.deletes).toBe(1);
    expect(t.exists(t.b)).toBe(false);
    await expect(page).toHaveURL(new RegExp(`${t.chapterPath}$`));
    const alert = t.alertFor('Page B');
    await expect(alert).toHaveClass(/notice--success/);
    await expect(alert).toContainText('Page “Page B” deleted.');
    await expect(alert).toContainText('Undo is available until');
    await expect(alert).toContainText('minutes left');
    await expect(page.locator('[data-page-deletion-notice]')).toHaveCount(0);
    expect(await t.pageTitles()).toEqual(['Page A', 'Page C']);

    await t.mark();
    const held = await holdBeforeServer(page, RESTORE_URL);
    await t.undoFor('Page B').dblclick();
    await held.arrived;
    await expect(alert).toContainText('Restoring');
    await expect(t.undoFor('Page B')).toHaveAttribute('aria-disabled', 'true');
    await t.undoFor('Page B').evaluate((button) => { button.click(); button.click(); });
    expect(t.exists(t.b)).toBe(false);
    held.release();

    await expect(alert).toContainText('Page “Page B” restored.');
    await expect(alert).not.toContainText('Refreshing');
    expect(t.log.restores).toBe(1);
    expect(await t.marked()).toBe(true);
    expect(new URL(page.url()).pathname).toBe(t.chapterPath);
    await expect(t.undoFor('Page B')).toBeHidden();
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);
    const view = alert.getByRole('link', { name: 'View Page' });
    await expect(view).toHaveAttribute('href', `/notes/${t.b.id}`);
    // The second click of that double-click never opens the link that replaced Undo.
    expect(new URL(page.url()).pathname).toBe(t.chapterPath);

    await view.click();
    await expect(page).toHaveURL(new RegExp(`/notes/${t.b.id}$`));
    await expect(page.locator('.notes-page-detail-content')).toContainText('Saved Markdown again');
    await expect(page.locator('.notes-revision-list-item')).toHaveCount(revisions.length);
    await expect(page.getByRole('link', { name: 'Linked Project' })).toBeVisible();
    await expect(page.locator('.notes-detail-asset-link', { hasText: 'linked.png' })).toBeVisible();
    expect(t.db.prepare('SELECT id FROM note_revisions WHERE note_id = ? ORDER BY id').all(t.b.id)).toEqual(revisions);
    expect(t.noteCount()).toBe(before);
    expect(t.log.restores).toBe(1);
  });
});

test('flow 2: a direct Book Page returns to its place with its preview selection, without a reload', async ({ page }) => {
  await withUndo(page, async (t) => {
    const later = t.noteService.createNote({ bookId: t.book.id, title: 'Later Page', content: '' });
    t.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(t.book.id, {
      mode: 'selected', randomCount: 3, selectedPageIds: [t.a.id, t.direct.id],
    });
    const contents = () => t.bookService.listBookContents(t.book.id).map((item) => item.title ?? item.id);
    const before = contents();

    await t.deletePage(t.direct);
    await expect(page).toHaveURL(new RegExp(`${t.bookPath}$`));
    await expect(t.undoFor('Direct Page')).toBeVisible();
    const choice = page.locator(`#book-preview-pages option[value="${t.direct.id}"]`);
    await expect(choice).toHaveCount(0);
    await t.mark();
    await t.undoFor('Direct Page').click();
    await expect(t.alertFor('Direct Page')).toContainText('Page “Direct Page” restored.');
    await expect(t.alertFor('Direct Page')).not.toContainText('Refreshing');
    expect(t.log.restores).toBe(1);
    expect(await t.marked()).toBe(true);
    expect(new URL(page.url()).pathname).toBe(t.bookPath);
    expect(contents()).toEqual(before);
    await expect(page.locator(`.notes-book-nav a[href="/notes/${t.direct.id}"]`).first()).toBeAttached();
    const links = await page.locator('.notes-page-detail-sidebar .notes-book-nav a[href^="/notes/"]').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute('href')),
    );
    expect(links.indexOf(`/notes/${t.direct.id}`)).toBeLessThan(links.indexOf(`/notes/${later.id}`));
    await expect(choice).toHaveCount(1);
    expect(await choice.evaluate((option) => option.selected)).toBe(true);
    expect(await page.locator(`#book-preview-pages option[value="${t.a.id}"]`).evaluate((option) => option.selected)).toBe(true);
    expect(t.bookPagePreviewSettingsService.getBookPagePreviewSettings(t.book.id).selectedPageIds).toContain(t.direct.id);
  });
});

test('flow 3: Undo is found again after a reload and a return, and its token stays out of storage and URLs', async ({ page }) => {
  await withUndo(page, async (t) => {
    const tokens = [];
    page.on('response', async (response) => {
      if (/\/notes\/page-deletions\/[0-9a-f]{64}$/.test(new URL(response.url()).pathname)) {
        const body = await response.json().catch(() => null);
        if (body?.undoToken) tokens.push(body.undoToken);
      }
    });
    await t.deletePage(t.b);
    await expect(t.undoFor('Page B')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
    expect(t.log.statusGets).toBe(0);

    await page.reload();
    await expect(t.undoFor('Page B')).toBeVisible();
    await page.locator('.notes-chapter-pages a', { hasText: 'Page A' }).click();
    await expect(page).toHaveURL(new RegExp(`/notes/${t.a.id}$`));
    await page.goto(t.origin + t.chapterPath);
    await expect(t.undoFor('Page B')).toBeVisible();
    await page.locator('.page-heading').click();

    await t.undoFor('Page B').click();
    await expect(t.alertFor('Page B')).toContainText('Page “Page B” restored.');
    expect(t.log.restores).toBe(1);
    expect(tokens).toHaveLength(1);
    const exposed = await page.evaluate(() => JSON.stringify([
      { ...sessionStorage }, { ...localStorage }, location.href, history.state, document.documentElement.outerHTML,
    ]));
    expect(exposed).not.toContain(tokens[0]);
    expect(t.log.requests.join('\n')).not.toContain(tokens[0]);
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);
  });
});

test('flow 4: Dismiss hides one alert in this tab and leaves its record and the others alone', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.a);
    await t.deletePage(t.c);
    await expect(t.alerts).toHaveCount(2);
    const dismissedId = await t.idOf('Page C');
    await t.alertFor('Page C').locator('[data-chapter-feedback-dismiss]').click();
    await expect(t.alertFor('Page C')).toHaveCount(0);
    await expect(t.undoFor('Page A')).toBeVisible();

    await page.reload();
    await expect(t.undoFor('Page A')).toBeVisible();
    await expect(t.alertFor('Page C')).toHaveCount(0);
    expect(t.snapshot(dismissedId).restored_at).toBeNull();
    expect(t.snapshot(dismissedId).snapshot_json).toBeTruthy();
    expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).toContain(dismissedId);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(dismissedId);

    // Another tab has its own dismissals, and Undo there still works.
    const other = await page.context().newPage();
    t.track(other);
    await other.goto(t.origin + t.chapterPath);
    const otherAlert = other.locator(`[data-page-deletion-undo-alert="${dismissedId}"]`);
    await otherAlert.locator('[data-page-deletion-undo]').click();
    await expect(otherAlert).toContainText('Page “Page C” restored.');
    expect(t.exists(t.c)).toBe(true);
    await other.close();
  });
});

test('flow 4b: without browser storage, Dismiss still hides the alert for this document', async ({ page }) => {
  await withUndo(page, async (t) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } });
    });
    await t.deletePage(t.c);
    await expect(t.undoFor('Page C')).toBeVisible();
    await t.alertFor('Page C').locator('[data-chapter-feedback-dismiss]').click();
    await expect(t.alerts).toHaveCount(0);
  });
});

test('flow 5: an expired opportunity says so, sends no restore, and leaves others usable', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.a);
    await t.deletePage(t.c);
    await expect(t.alerts).toHaveCount(2);
    const older = await t.idOf('Page A');
    t.expire(older);
    await t.undoFor('Page A').click();
    const alert = t.alertFor('Page A');
    await expect(alert).toContainText('Undo expired. The Page remains deleted.');
    await expect(alert).toHaveClass(/notice--warning/);
    await expect(t.undoFor('Page A')).toBeHidden();
    await expect(alert.locator('[data-chapter-feedback-dismiss]')).toBeFocused();
    expect(t.log.restores).toBe(0);
    expect(t.exists(t.a)).toBe(false);
    await expect(t.undoFor('Page C')).toBeVisible();
    await alert.locator('[data-chapter-feedback-dismiss]').click();
    await expect(alert).toHaveCount(0);

    // The deadline passing while the page is open reads the server, and needs no click.
    const newer = await t.idOf('Page C');
    t.expire(newer, Date.now() + 1500);
    await page.reload();
    await expect(t.undoFor('Page C')).toBeVisible();
    t.expire(newer, Date.now() - 1);
    await expect(t.alertFor('Page C')).toContainText('Undo expired. The Page remains deleted.', { timeout: 10_000 });
    expect(t.log.restores).toBe(0);
    expect(t.exists(t.c)).toBe(false);

    // A new load offers nothing for it.
    await page.reload();
    await expect(page.locator('.notes-chapter-pages')).toBeVisible();
    await expect(t.alerts).toHaveCount(0);
  });
});

test('flow 5b: a deadline this clock passed early does not end what the server still allows', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.c);
    await expect(t.undoFor('Page C')).toBeVisible();
    const id = await t.idOf('Page C');
    await page.clock.install({ time: Date.now() + 11 * 60_000 });
    await page.reload();
    await expect(t.undoFor('Page C')).toBeVisible();
    await page.clock.runFor(2000);
    await expect(t.undoFor('Page C')).toHaveAttribute('aria-disabled', 'false');
    await expect(t.alertFor('Page C')).toContainText('Undo is available');
    expect(t.snapshot(id).restored_at).toBeNull();
    await t.undoFor('Page C').click();
    await expect(t.alertFor('Page C')).toContainText('restored.');
    expect(t.log.restores).toBe(1);
  });
});

test('flow 6: two deletions stay distinct, the older one is refused safely, and newest-first restores both', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.a);
    await t.deletePage(t.b);
    await expect(t.alerts).toHaveCount(2);
    await expect(t.alerts.first()).toContainText('Page B');
    await expect(t.alerts.last()).toContainText('Page A');
    const idA = await t.idOf('Page A');
    const idB = await t.idOf('Page B');
    expect(idA).not.toBe(idB);

    await t.undoFor('Page A').focus();
    await page.keyboard.press('Enter');
    const alertA = page.locator(`[data-page-deletion-undo-alert="${idA}"]`);
    await expect(alertA).toContainText('Pages around it have changed');
    await expect(alertA).toContainText('Undo the newer deletion of Page “Page B” first');
    await expect(alertA).toHaveClass(/notice--warning/);
    expect(t.log.restores).toBe(1);
    expect(t.exists(t.a)).toBe(false);
    expect(t.snapshot(idA).restored_at).toBeNull();
    await expect(alertA.locator('[data-page-deletion-undo]')).toBeFocused();
    await expect(alertA.locator('[data-page-deletion-undo]')).toHaveAttribute('aria-disabled', 'false');

    await page.locator(`[data-page-deletion-undo-alert="${idB}"] [data-page-deletion-undo]`).click();
    await expect(page.locator(`[data-page-deletion-undo-alert="${idB}"]`)).toContainText('Page “Page B” restored.');
    expect(t.exists(t.a)).toBe(false);
    expect(t.exists(t.b)).toBe(true);

    await alertA.locator('[data-page-deletion-undo]').click();
    await expect(page.locator(`[data-page-deletion-undo-alert="${idA}"]`)).toContainText('Page “Page A” restored.');
    expect(t.log.restores).toBe(3);
    expect(t.savedOrder()).toEqual(['Page A', 'Page B', 'Page C']);
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);
    const ids = t.noteService.listNotesForChapter(t.chapter.id).map((note) => note.id);
    expect(ids).toEqual([t.a.id, t.b.id, t.c.id]);
  });
});

test('flow 7: a committed restore with a lost answer is confirmed by reading, never by repeating', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.b);
    await page.route(RESTORE_URL, async (route) => {
      await route.fetch();
      await route.abort();
    }, { times: 1 });
    await t.undoFor('Page B').click();
    const alert = t.alertFor('Page B');
    await expect(alert).toContainText('Page “Page B” restored.');
    await expect(alert).not.toContainText('Refreshing');
    expect(t.log.restores).toBe(1);
    expect(t.exists(t.b)).toBe(true);
    await expect(alert.getByRole('link', { name: 'View Page' })).toHaveAttribute('href', `/notes/${t.b.id}`);
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);
  });
});

test('flow 7b: an unconfirmed restore that did not commit returns Undo only for a new user action', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.b);
    await page.route(RESTORE_URL, (route) => route.abort(), { times: 1 });
    await t.undoFor('Page B').click();
    const alert = t.alertFor('Page B');
    await expect(alert).toContainText('The restore was not confirmed');
    expect(t.exists(t.b)).toBe(false);
    await expect(t.undoFor('Page B')).toHaveAttribute('aria-disabled', 'false');
    await t.undoFor('Page B').click();
    await expect(alert).toContainText('Page “Page B” restored.');
    expect(t.exists(t.b)).toBe(true);
  });
});

test('flow 7c: when the status read fails too, only Check again is offered and nothing is claimed', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.b);
    await page.route(RESTORE_URL, async (route) => {
      await route.fetch();
      await route.abort();
    }, { times: 1 });
    const statusReads = [];
    await page.route(STATUS_URL, (route) => {
      statusReads.push(1);
      return statusReads.length === 2 ? route.abort() : route.fallback();
    });
    await t.undoFor('Page B').click();
    const alert = t.alertFor('Page B');
    const check = alert.locator('[data-page-deletion-undo-retry]');
    await expect(check).toHaveText('Check again');
    await expect(alert).toContainText('could not be checked');
    await expect(alert).not.toContainText('restored.');
    await expect(t.undoFor('Page B')).toBeHidden();
    await expect(check).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(alert).toContainText('Page “Page B” restored.');
    expect(t.log.restores).toBe(1);
  });
});

test('flow 8: a failed parent read keeps the success, Retry refresh only reads, and an old read cannot win', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.b);
    await expect(t.undoFor('Page B')).toBeVisible();
    await t.mark();
    await page.evaluate(() => {
      document.querySelector('#note-create-dialog [name="title"]').value = 'Parent draft';
    });

    // An older read of the parent, answered from before the restore, arrives last.
    let parentReads = 0;
    let arrive;
    const arrived = new Promise((resolve) => { arrive = resolve; });
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    await page.route(`**${t.chapterPath}`, async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.fallback();
      parentReads += 1;
      if (parentReads === 2) return route.abort();
      if (parentReads > 2) return route.fallback();
      const response = await route.fetch();
      const body = await response.text();
      arrive();
      await released;
      return route.fulfill({ status: response.status(), headers: response.headers(), body });
    });
    await page.locator('.page-heading [data-dialog-open="chapter-order-dialog"]').click();
    await arrived;
    await page.locator('#chapter-order-dialog').getByRole('button', { name: /close/i }).click();
    await expect(page.locator('#chapter-order-dialog')).toBeHidden();

    await t.undoFor('Page B').click();
    const alert = t.alertFor('Page B');
    const retry = alert.locator('[data-page-deletion-undo-retry]');
    await expect(retry).toHaveText('Retry refresh');
    await expect(alert).toContainText('Page “Page B” restored.');
    await expect(alert).toContainText('could not refresh');
    await expect(alert).toHaveClass(/notice--success/);
    await expect(alert.getByRole('link', { name: 'View Page' })).toBeVisible();
    expect(t.exists(t.b)).toBe(true);
    expect(await t.pageTitles()).toEqual(['Page A', 'Page C']);

    const posts = t.log.restores;
    await retry.click();
    await expect(alert).not.toContainText('could not refresh');
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);
    expect(t.log.restores).toBe(posts);
    expect(posts).toBe(1);

    release();
    await page.waitForTimeout(200);
    expect(await t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);
    expect(await t.marked()).toBe(true);
    await expect(page.locator('#note-create-dialog [name="title"]')).toHaveValue('Parent draft');
  });
});

test('flow 9: a committed Delete with a lost answer reaches the parent with real Undo, one POST', async ({ page }) => {
  await withUndo(page, async (t) => {
    const lose = async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fetch();
      return route.abort();
    };
    await page.route(`**/notes/${t.b.id}/delete`, lose, { times: 1 });
    await t.deletePage(t.b);
    expect(t.log.deletes).toBe(1);
    expect(t.log.statusGets).toBe(1);
    await expect(t.undoFor('Page B')).toBeVisible();
    await t.undoFor('Page B').click();
    await expect(t.alertFor('Page B')).toContainText('Page “Page B” restored.');
    expect(t.log.deletes).toBe(1);

    // The status read fails as well: unknown, GET-only Check again, then the handoff.
    await page.route(`**/notes/${t.c.id}/delete`, lose, { times: 1 });
    await page.route(STATUS_URL, (route) => route.abort(), { times: 1 });
    await page.goto(`${t.origin}/notes/${t.c.id}`);
    await page.locator('.page-heading [data-dialog-open="note-edit-dialog"]').click();
    const dialog = page.locator('#note-edit-dialog');
    await dialog.locator('.notes-workspace-disclosure--delete > summary').click();
    await dialog.locator('button[form="note-delete-form"]').click();
    await t.confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    const check = dialog.locator('[data-dialog-delete-check-retry]');
    await expect(check).toBeVisible();
    await expect(dialog.locator('[data-dialog-delete-error]')).toContainText('could not be checked');
    expect(t.log.deletes).toBe(2);
    await check.click();
    await expect(page).toHaveURL(new RegExp(`${t.chapterPath}$`));
    await expect(t.undoFor('Page C')).toBeVisible();
    expect(t.log.deletes).toBe(2);
  });
});

test('flow 10: wrong, stale and malformed locators claim nothing, and restore fails closed', async ({ page, browser }) => {
  await withUndo(page, async (t) => {
    const notice = page.locator('[data-page-deletion-notice]');
    for (const query of [`?notice=page_deleted&undo=${createNoteDeletionId()}`, '?notice=page_deleted&undo=nope', '?notice=page_deleted', '?notice=page_deleted&undo=a&undo=b']) {
      await page.goto(`${t.origin}${t.chapterPath}${query}`);
      await expect(page.locator('.notes-chapter-pages')).toBeVisible();
      await expect(notice).toHaveCount(0);
      await expect(t.alerts).toHaveCount(0);
      await expect(page.locator('.notice', { hasText: 'deleted' })).toHaveCount(0);
      expect(new URL(page.url()).search).toBe('');
    }

    await t.deletePage(t.b);
    await expect(t.undoFor('Page B')).toBeVisible();
    const id = await t.idOf('Page B');

    // Another parent names nothing for this locator.
    await page.goto(`${t.origin}${t.bookPath}?notice=page_deleted&undo=${id}`);
    await expect(page.locator('.notes-book-nav').first()).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(t.alerts).toHaveCount(0);

    // Another owner: no notice, no token, nothing listed.
    const stranger = await browser.newContext();
    const foreign = await stranger.newPage();
    await foreign.goto(`${t.origin}${t.chapterPath}?notice=page_deleted&undo=${id}`);
    await expect(foreign.locator('.notes-chapter-pages')).toBeVisible();
    await expect(foreign.locator('[data-page-deletion-notice]')).toHaveCount(0);
    await expect(foreign.locator('[data-page-deletion-undo-alert]')).toHaveCount(0);
    const status = await foreign.evaluate((url) => fetch(url).then(async (r) => ({ code: r.status, body: await r.json() })), `/notes/page-deletions/${id}`);
    expect(status.code).toBe(404);
    expect(status.body.undoToken).toBeUndefined();
    await stranger.close();

    // No token, however good the CSRF token: refused, and still recoverable.
    await page.goto(t.origin + t.chapterPath);
    await expect(t.undoFor('Page B')).toBeVisible();
    const refused = await page.evaluate(async (url) => {
      const body = new URLSearchParams({ _csrf: document.querySelector('input[name="_csrf"]').value });
      const response = await fetch(url, { method: 'POST', body, headers: { Accept: 'application/json' } });
      return response.status;
    }, `/notes/page-deletions/${id}/restore`);
    expect(refused).toBeGreaterThanOrEqual(400);
    expect(t.exists(t.b)).toBe(false);

    // Already restored from another tab: the first tab says so and sends nothing.
    const other = await page.context().newPage();
    await other.goto(t.origin + t.chapterPath);
    await other.locator(`[data-page-deletion-undo-alert="${id}"] [data-page-deletion-undo]`).click();
    await expect(other.locator(`[data-page-deletion-undo-alert="${id}"]`)).toContainText('restored.');
    await other.close();
    const restoresBefore = t.log.restores;
    await t.undoFor('Page B').click();
    await expect(t.alertFor('Page B')).toContainText('was already restored.');
    await expect(t.alertFor('Page B')).not.toContainText('Checking');
    await expect(t.alertFor('Page B').getByRole('link', { name: 'View Page' })).toHaveAttribute('href', `/notes/${t.b.id}`);
    expect(t.log.restores).toBe(restoresBefore);
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);

    // A receipt does not claim a Page that has gone again.
    await page.goto(t.origin + t.chapterPath);
    await t.deletePage(t.c);
    await expect(t.undoFor('Page C')).toBeVisible();
    const second = await t.idOf('Page C');
    const tab = await page.context().newPage();
    await tab.goto(t.origin + t.chapterPath);
    await tab.locator(`[data-page-deletion-undo-alert="${second}"] [data-page-deletion-undo]`).click();
    await expect(tab.locator(`[data-page-deletion-undo-alert="${second}"]`)).toContainText('restored.');
    await tab.close();
    t.noteService.deleteNote(t.c.id);
    await t.undoFor('Page C').click();
    await expect(t.alertFor('Page C')).toContainText('no longer available');
    await expect(t.alertFor('Page C').getByRole('link', { name: 'View Page' })).toBeHidden();
  });
});

test('flow 10b: losing the session or identity fails closed', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.a);
    await t.deletePage(t.c);
    await expect(t.alerts).toHaveCount(2);
    await page.route(STATUS_URL, (route) => route.fulfill({
      status: 401, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'Authentication required.' }),
    }), { times: 1 });
    await t.undoFor('Page C').click();
    await expect(t.alertFor('Page C')).toContainText('session could not be verified');
    await expect(t.undoFor('Page C')).toBeHidden();
    expect(t.log.restores).toBe(0);

    // A real change of browser identity: the record is simply not this visitor's.
    await page.context().clearCookies();
    await t.undoFor('Page A').click();
    await expect(t.alertFor('Page A')).toContainText('cannot be undone from here');
    await expect(t.undoFor('Page A')).toBeHidden();
    expect(t.log.restores).toBe(0);
    expect(t.exists(t.a)).toBe(false);
  });
});

test('flow 10c: a failed discovery read is truthful and offers a GET-only check', async ({ page }) => {
  await withUndo(page, async (t) => {
    await page.route('**/notes/page-deletions?*', (route) => route.abort(), { times: 1 });
    await t.deletePage(t.b);
    await expect(page.locator('[data-page-deletion-notice]')).toContainText('Page deleted.');
    const failure = page.locator('[data-page-deletion-undo-check-failed]');
    await expect(failure).toContainText('Could not check');
    await expect(t.alerts).toHaveCount(0);
    await failure.locator('[data-page-deletion-undo-recheck]').click();
    await expect(t.undoFor('Page B')).toBeVisible();
    await expect(failure).toHaveCount(0);
    await expect(page.locator('[data-page-deletion-notice]')).toHaveCount(0);
    expect(t.log.restores).toBe(0);
  });
});

test('flow 11: drafts survive Undo, ordering drafts stay unsaved, and the warnings tell the truth', async ({ page }) => {
  await withUndo(page, async (t) => {
    // The copy, and a cancelled deletion keeps the draft.
    await page.goto(`${t.origin}/notes/${t.b.id}`);
    await page.locator('.page-heading [data-dialog-open="note-edit-dialog"]').click();
    const edit = page.locator('#note-edit-dialog');
    await edit.locator('.notes-workspace-disclosure--delete > summary').click();
    await expect(edit.locator('.notes-workspace-warning', { hasText: 'revision history' })).toContainText('for ten minutes');
    await expect(edit.locator('.notes-workspace-warning', { hasText: 'revision history' })).not.toContainText('cannot be undone');
    await edit.locator('[name="title"]').fill('Draft Title');
    await edit.locator('button[form="note-delete-form"]').click();
    await expect(t.confirmation).toContainText('Undo can restore the saved Page for ten minutes');
    await expect(t.confirmation).toContainText('Undo cannot restore them');
    await expect(t.confirmation).not.toContainText('cannot be undone');
    await t.confirmation.locator('[data-app-dialog-confirmation-cancel]').click();
    await expect(edit.locator('[name="title"]')).toHaveValue('Draft Title');
    expect(t.log.deletes).toBe(0);
    await t.confirmation.waitFor({ state: 'hidden' });
    await edit.locator('button[form="note-delete-form"]').click();
    await t.confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    await expect(page).toHaveURL(new RegExp(`${t.chapterPath}$`));
    await expect(t.undoFor('Page B')).toBeVisible();

    // A Chapter order draft and a New Page draft begun while the restore is pending.
    await page.evaluate(() => {
      document.querySelector('#note-create-dialog [name="title"]').value = 'Parent draft';
    });
    const held = await holdBeforeServer(page, RESTORE_URL);
    await t.undoFor('Page B').click();
    await held.arrived;
    await page.locator('.page-heading [data-dialog-open="chapter-order-dialog"]').click();
    const order = page.locator('#chapter-order-dialog');
    await expect(order.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await order.locator(`[data-note-id="${t.a.id}"] [data-chapter-page-reorder-handle]`).focus();
    await page.keyboard.press('End');
    const draft = () => order.locator('.notes-chapter-page-title').allTextContents();
    expect(await draft()).toEqual(['Page C', 'Page A']);

    held.release();
    await expect(t.alertFor('Page B')).toContainText('Page “Page B” restored.');
    await expect(t.alertFor('Page B')).not.toContainText('Refreshing');
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);
    expect(await draft()).toEqual(['Page C', 'Page A']);
    expect(t.savedOrder()).toEqual(['Page A', 'Page B', 'Page C']);
    await page.keyboard.press('Escape');
    await expect(order).toBeHidden();
    expect(t.savedOrder()).toEqual(['Page A', 'Page B', 'Page C']);
    await page.locator('.page-heading [data-dialog-open="chapter-order-dialog"]').click();
    await expect.poll(draft).toEqual(['Page A', 'Page B', 'Page C']);
    await page.keyboard.press('Escape');
    await expect(page.locator('#note-create-dialog [name="title"]')).toHaveValue('Parent draft');
  });
});

test('flow 11b: an open Book Defaults draft survives Undo on the Book', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.direct);
    await expect(t.undoFor('Direct Page')).toBeVisible();
    const held = await holdBeforeServer(page, RESTORE_URL);
    await t.undoFor('Direct Page').click();
    await held.arrived;
    await page.locator('[data-book-defaults-link]').click();
    const defaults = page.locator('#book-defaults-dialog');
    await expect(defaults).toBeVisible();
    await defaults.locator('[name="randomPageCount"]').evaluate((input) => { input.value = '7'; });
    await defaults.locator('.notes-workspace-disclosure, details').first().evaluate((node) => { node.open = true; }).catch(() => {});
    held.release();
    await expect(page.locator(`#book-preview-pages option[value="${t.direct.id}"]`)).toHaveCount(1);
    await expect(defaults).toBeVisible();
    await expect(defaults.locator('[name="randomPageCount"]')).toHaveValue('7');
    expect(t.log.restores).toBe(1);
  });
});

// Scripts the parent's fetch reads by arrival, in one permanent handler: a read named
// in `held` waits for settle(n, how); any other goes through.
async function scriptParentReads(page, parentPath, { held = [], aborted = [] }) {
  const gates = new Map();
  const gate = (n) => {
    if (!gates.has(n)) {
      const entry = {};
      entry.arrived = new Promise((resolve) => { entry.arrive = resolve; });
      entry.settled = new Promise((resolve) => { entry.settle = resolve; });
      gates.set(n, entry);
    }
    return gates.get(n);
  };
  const reads = {
    count: 0,
    arrived: (n) => gate(n).arrived,
    settle: (n, how = 'continue') => gate(n).settle(how),
  };
  await page.route(`**${parentPath}`, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.fallback();
    reads.count += 1;
    const n = reads.count;
    gate(n).arrive();
    if (aborted.includes(n)) return route.abort();
    if (!held.includes(n)) return route.fallback();
    return (await gate(n).settled) === 'abort' ? route.abort() : route.fallback();
  });
  return reads;
}

// Opens Change order, whose verification read takes over the turn, and closes it with
// that read still waiting.
async function overtakeWithClosedOrderCheck(page, reads, n) {
  await page.locator('.page-heading [data-dialog-open="chapter-order-dialog"]').click();
  await reads.arrived(n);
  await page.locator('#chapter-order-dialog').getByRole('button', { name: /close/i }).click();
  await expect(page.locator('#chapter-order-dialog')).toBeHidden();
}

test('flow 13: a newer read that fails unreported does not end Undo\'s refresh', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.b);
    await expect(t.undoFor('Page B')).toBeVisible();
    await t.mark();
    await page.evaluate(() => {
      document.querySelector('#note-create-dialog [name="title"]').value = 'Parent draft';
    });
    const reads = await scriptParentReads(page, t.chapterPath, { held: [1, 2] });
    await t.undoFor('Page B').click();
    await reads.arrived(1);
    await overtakeWithClosedOrderCheck(page, reads, 2);
    reads.settle(2, 'abort');
    reads.settle(1);

    const alert = t.alertFor('Page B');
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);
    await expect(alert).toContainText('Page “Page B” restored.');
    await expect(alert).not.toContainText('Refreshing');
    await expect(alert.locator('[data-page-deletion-undo-retry]')).toHaveCount(0);
    await expect(alert.getByRole('link', { name: 'View Page' })).toBeVisible();
    expect(reads.count).toBe(3);
    expect(t.log.restores).toBe(1);
    expect(t.log.deletes).toBe(1);
    expect(await t.marked()).toBe(true);
    await expect(page.locator('#note-create-dialog [name="title"]')).toHaveValue('Parent draft');
  });
});

test('flow 13b: when the read Undo goes back for fails too, Retry refresh recovers by reading', async ({ page }) => {
  await withUndo(page, async (t) => {
    await t.deletePage(t.b);
    await expect(t.undoFor('Page B')).toBeVisible();
    const reads = await scriptParentReads(page, t.chapterPath, { held: [1, 2], aborted: [3] });
    await t.undoFor('Page B').click();
    await reads.arrived(1);
    await overtakeWithClosedOrderCheck(page, reads, 2);
    reads.settle(2, 'abort');
    reads.settle(1);

    const alert = t.alertFor('Page B');
    const retry = alert.locator('[data-page-deletion-undo-retry]');
    await expect(retry).toHaveText('Retry refresh');
    await expect(alert).toContainText('Page “Page B” restored.');
    await expect(alert.getByRole('link', { name: 'View Page' })).toBeVisible();
    expect(await t.pageTitles()).toEqual(['Page A', 'Page C']);
    await retry.click();
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C']);
    await expect(alert).not.toContainText('could not refresh');
    expect(t.log.restores).toBe(1);
  });
});

test('flow 13c: a narrower newer read does not cost a restored Page its preview selection', async ({ page }) => {
  await withUndo(page, async (t) => {
    t.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(t.book.id, {
      mode: 'selected', randomCount: 3, selectedPageIds: [t.a.id, t.direct.id],
    });
    await t.deletePage(t.direct);
    await expect(t.undoFor('Direct Page')).toBeVisible();
    const choice = page.locator(`#book-preview-pages option[value="${t.direct.id}"]`);
    await expect(choice).toHaveCount(0);
    const reads = await scriptParentReads(page, t.bookPath, { held: [1] });
    await t.undoFor('Direct Page').click();
    await reads.arrived(1);

    const chapters = page.locator('#chapter-create-dialog');
    await page.locator('.page-heading [data-dialog-open="chapter-create-dialog"]').click();
    await chapters.locator('[name="title"]').fill('Fresh Chapter');
    await chapters.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(chapters).toBeHidden();
    await reads.arrived(2);
    await expect(page.locator('.notes-book-nav-chapter-title', { hasText: 'Fresh Chapter' }).first()).toBeAttached();
    reads.settle(1);

    await expect(choice).toHaveCount(1);
    expect(await choice.evaluate((option) => option.selected)).toBe(true);
    await expect(t.alertFor('Direct Page')).toContainText('Page “Direct Page” restored.');
    await expect(t.alertFor('Direct Page')).not.toContainText('Refreshing');
    expect(t.log.restores).toBe(1);
    expect(t.chapterService.listChapters(t.book.id).map((chapter) => chapter.title)).toContain('Fresh Chapter');

    // A later autosave sends the restored Page with the rest of the selection.
    await page.locator('[data-book-defaults-link]').click();
    await expect(page.locator('#book-defaults-dialog')).toBeVisible();
    await page.locator('#book-preview-count').evaluate((select) => {
      select.value = '7';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => t.bookPagePreviewSettingsService.getBookPagePreviewSettings(t.book.id).randomCount).toBe(7);
    expect(t.bookPagePreviewSettingsService.getBookPagePreviewSettings(t.book.id).selectedPageIds.map(Number).sort((x, y) => x - y))
      .toEqual([t.a.id, t.direct.id].sort((x, y) => x - y));
    expect(t.log.restores).toBe(1);
  });
});

test('flow 13d: New Page keeps the same obligation when a newer read fails unreported', async ({ page }) => {
  await withUndo(page, async (t) => {
    await page.goto(t.origin + t.chapterPath);
    const reads = await scriptParentReads(page, t.chapterPath, { held: [1, 2] });
    const dialog = page.locator('#note-create-dialog');
    await page.locator('.page-heading [data-dialog-open="note-create-dialog"]').click();
    await expect(dialog.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]')).toBeVisible();
    await dialog.locator('[name="title"]').fill('Page D');
    await dialog.locator('[data-dialog-submit]').first().click();
    await expect(dialog).toBeHidden();
    await reads.arrived(1);
    await overtakeWithClosedOrderCheck(page, reads, 2);
    reads.settle(2, 'abort');
    reads.settle(1);
    await expect.poll(() => t.pageTitles()).toEqual(['Page A', 'Page B', 'Page C', 'Page D']);
    await expect(page.locator('[data-dialog-feedback]')).not.toContainText('could not refresh');
    expect(t.noteCount()).toBe(5);
  });
});

async function expectLaidOut(page, alert) {
  const box = await alert.boundingBox();
  const dismiss = await alert.locator('[data-chapter-feedback-dismiss]').boundingBox();
  const undo = await alert.locator('[data-page-deletion-undo]').boundingBox();
  expect(box.x + box.width - (dismiss.x + dismiss.width)).toBeLessThan(40);
  expect(dismiss.x + dismiss.width).toBeLessThanOrEqual(box.x + box.width);
  const overlaps = undo.x < dismiss.x + dismiss.width && dismiss.x < undo.x + undo.width
    && undo.y < dismiss.y + dismiss.height && dismiss.y < undo.y + undo.height;
  expect(overlaps).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await alert.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}

test('flow 12: keyboard use, focus, far-right Dismiss, and 320px with long titles', async ({ page }) => {
  await withUndo(page, async (t) => {
    const long = `Averyveryveryveryveryveryveryveryveryveryveryveryverylongunbrokentitle ${'and more words '.repeat(6)}`.trim();
    t.noteService.updateNote(t.c.id, { title: long, content: 'Body C' });
    await t.deletePage(t.a);
    await t.deletePage(t.c);
    await expect(t.alerts).toHaveCount(2);

    await page.setViewportSize({ width: 1280, height: 800 });
    for (const index of [0, 1]) await expectLaidOut(page, t.alerts.nth(index));
    await page.setViewportSize({ width: 320, height: 700 });
    for (const index of [0, 1]) await expectLaidOut(page, t.alerts.nth(index));

    await expect(page.getByRole('button', { name: 'Undo deletion of Page “Page A”' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dismiss the notice about Page “Page A”' })).toBeVisible();

    // A refusal keeps focus on its Undo.
    const undoA = t.undoFor('Page A');
    await undoA.focus();
    await page.keyboard.press('Space');
    await expect(t.alertFor('Page A')).toContainText('Pages around it have changed');
    await expect(undoA).toBeFocused();
    await expectLaidOut(page, t.alertFor('Page A'));

    // Keyboard Undo moves to View Page; holding the key does not send a second POST.
    const restoresBefore = t.log.restores;
    await t.alerts.first().locator('[data-page-deletion-undo]').focus();
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    const view = t.alerts.first().getByRole('link', { name: 'View Page' });
    await expect(view).toBeFocused();
    expect(t.log.restores).toBe(restoresBefore + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(new URL(page.url()).pathname).toBe(t.chapterPath);

    // Keyboard Dismiss moves to the next alert, then to the page's own action.
    await t.alerts.first().locator('[data-chapter-feedback-dismiss]').focus();
    await page.keyboard.press('Enter');
    await expect(t.alerts).toHaveCount(1);
    await expect(t.undoFor('Page A')).toBeFocused();
    await t.alerts.first().locator('[data-chapter-feedback-dismiss]').focus();
    await page.keyboard.press('Enter');
    await expect(t.alerts).toHaveCount(0);
    await expect(page.locator('.page-heading [data-dialog-open]').first()).toBeFocused();
  });
});
