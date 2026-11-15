import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { defaultComicPreparationCacheRoot } from '../../src/services/comic-preparation-cache.js';
import { createComicRuntime } from '../../src/services/comic-runtime.js';
import { createReleaseService } from '../../src/services/release-service.js';
import { makeZip } from '../helpers/zip-fixture.js';

// WP7.4: Related Notes assets on Project Detail open CreatorCrate's existing
// viewers in place of navigating to Asset Details: an eligible image (its
// thumbnail or filename) the one unified viewer in single-image mode, a
// readable comic the unified comic reader, a supported video the shared video
// preview dialog. Missing and unsupported files keep Asset Details. Sessions
// are owned by the Project Detail host per note and asset and follow the
// existing Related Notes refresh. Isolated SQLite, projects root and comic
// runtime in a temp directory removed afterwards.

const DIALOG = '#unified-viewer-dialog';
const VIDEO_DIALOG = '#asset-video-preview-dialog';
const TITLE = `${DIALOG} [data-unified-viewer-title]`;
const POSITION = `${DIALOG} [data-unified-viewer-position]`;
const NEXT = `${DIALOG} [data-unified-viewer-next]`;
const STRIP_TRIGGER = 'data-project-detail-viewer-trigger';

let fixture;

function png(size, shade) {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: shade, g: 90, b: 160 } } }).png().toBuffer();
}

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-related-notes-viewer-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const previewRoot = path.join(appDataRoot, 'previews');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(previewRoot, { recursive: true });
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const runtime = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 } });
  await runtime.start();
  const app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, comicRuntime: runtime,
  });
  await app.locals.generatedImagePublicationLifecycle.waitForIdle();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const pages = [await png(60, 10), await png(60, 90), await png(60, 170)];
  const { projectService, bookService, chapterService, noteService, assetScanner } = app.locals;
  const releaseService = createReleaseService({ db });
  let count = 0;

  fixture = {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    db,
    noteService,
    // One project: art.png (under Alpha and Beta), b.png (Gamma, and a release
    // strip), book.cbz (3 pages), clip.mp4, notes.txt and gone.png (missing).
    async create() {
      count += 1;
      const project = projectService.create({ title: `Notes Viewer ${count}`, status: 'tbd' });
      const dir = path.join(projectsRoot, project.project_dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'art.png'), await png(40, 40));
      fs.writeFileSync(path.join(dir, 'b.png'), await png(40, 120));
      fs.writeFileSync(path.join(dir, 'gone.png'), await png(40, 200));
      fs.writeFileSync(path.join(dir, 'book.cbz'), makeZip(pages.map((data, index) => ({ name: `p${index + 1}.png`, data }))));
      fs.writeFileSync(path.join(dir, 'clip.mp4'), Buffer.from('not really a video'));
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'notes');
      assetScanner.scanProjectAssets(project.id);
      fs.rmSync(path.join(dir, 'gone.png'));
      assetScanner.scanProjectAssets(project.id);
      const id = (relativePath) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND relative_path = ?')
        .get(project.id, relativePath).id;
      const ids = {
        art: id('art.png'), b: id('b.png'), comic: id('book.cbz'), video: id('clip.mp4'), text: id('notes.txt'), gone: id('gone.png'),
      };
      const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `Strip ${count}` }, [ids.b]);
      const book = bookService.createBook({ title: `Lore ${count}` });
      const chapter = chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
      const note = (title, assetIds) => noteService.createNote({
        chapterId: chapter.id, title, content: `${title} body`, projectIds: [project.id], assetIds,
      });
      const notes = {
        alpha: note('Alpha Page', [ids.art, ids.comic, ids.video, ids.text, ids.gone]),
        beta: note('Beta Page', [ids.art]),
        gamma: note('Gamma Page', [ids.b]),
      };
      return {
        project, projectId: String(project.id), dir, ids, notes, release, url: `/projects/${project.id}`,
        // A changed file and a rescan: a new revision for the same asset.
        async rewriteArt() {
          const full = path.join(dir, 'art.png');
          fs.writeFileSync(full, await png(48, 230));
          const later = new Date(Date.now() + 60_000);
          fs.utimesSync(full, later, later);
          assetScanner.scanProjectAssets(project.id);
        },
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      app.locals.generatedImageRebuildService.stop();
      app.locals.generatedImagePublicationLifecycle.stop();
      await app.locals.generatedImageRebuildService.waitForIdle();
      await app.locals.generatedImagePublicationLifecycle.waitForIdle();
      app.locals.comicMediaService.stop();
      await app.locals.comicMediaService.pauseForMaintenance().waitForIdle();
      await runtime.close();
      closeDatabase(db);
      fs.rmSync(defaultComicPreparationCacheRoot(appDataRoot), { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
});

test.afterAll(async () => { await fixture?.close(); });

async function open(page, f) {
  const control = { errors: [], mutations: [], manifests: [], refreshes: 0 };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET') control.mutations.push(`${request.method()} ${pathname}`);
    if (pathname.endsWith('/comic')) control.manifests.push(pathname);
    if (pathname === f.url && request.resourceType() === 'fetch') control.refreshes += 1;
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixture.baseURL + f.url);
  await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  await expect(page.locator('[data-project-related-note-editor][data-project-related-note-editor-bound="true"]')).toBeAttached();
  await page.evaluate(() => { window.__sameDocument = true; });
  return control;
}

const viewerState = (page) => page.evaluate(() => {
  const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
  const state = viewer.getState();
  const host = document.__creatorCrateProjectDetailViewer || {};
  return {
    open: state.open,
    session: state.session,
    sourceKey: state.source?.key ?? null,
    mode: state.source?.mode ?? null,
    count: state.count,
    context: state.context,
    revision: state.item?.revision ?? null,
    mediaUrl: state.item?.mediaUrl ?? null,
    originalUrl: state.item?.originalUrl ?? null,
    comic: state.comic ? { state: state.comic.state, projectId: String(state.comic.projectId), assetId: String(state.comic.assetId), sourceRevision: state.comic.sourceRevision } : null,
    note: host.note ? { kind: host.note.kind, noteId: host.note.noteId, assetId: host.note.assetId } : null,
    stripSession: host.session || 0,
    dialogs: document.querySelectorAll('#unified-viewer-dialog').length,
    openDialogs: document.querySelectorAll('dialog[open]').length,
  };
});

const card = (page, note) => page.locator(`[data-project-related-note="${note.id}"]`);
const tile = (page, note, assetId) => card(page, note).locator(`[data-project-related-note-asset="${assetId}"]`);
const media = (page, note, assetId) => tile(page, note, assetId).locator('.asset-list-card-media a[href]');
const filename = (page, note, assetId) => tile(page, note, assetId).locator('a.asset-file-link');
const strip = (page, f) => page.locator(`.project-detail-releases a[${STRIP_TRIGGER}][data-viewer-asset="${f.ids.b}"]`);
const detailsPath = (f, assetId) => `/projects/${f.projectId}/assets/${assetId}`;
const focusedIs = (page, locator) => locator.evaluate((node) => node === document.activeElement && node.isConnected);

// A return to the page (as project-related-notes-refresh.spec.js signals it)
// runs the existing Related Notes refresh: one GET, regions replaced.
async function returnRefresh(page, f) {
  const settled = page.waitForResponse((response) => new URL(response.url()).pathname === f.url
    && response.request().resourceType() === 'fetch');
  await page.evaluate(() => {
    const visibility = (value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    window.dispatchEvent(new FocusEvent('blur'));
    visibility('hidden');
    visibility('visible');
    window.dispatchEvent(new FocusEvent('focus'));
  });
  await settled;
  await expect.poll(() => page.evaluate(() => {
    const region = document.querySelector('[data-project-related-notes-region]');
    return Boolean(region) && !region.hasAttribute('data-before-refresh');
  })).toBe(true);
}

async function markRegion(page) {
  await page.locator('[data-project-related-notes-region]').evaluate((node) => node.setAttribute('data-before-refresh', ''));
}

async function closeViewer(page) {
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
}

test('A/F: an image thumbnail and filename open only that image in the unified viewer, by click and Enter', async ({ page }) => {
  const f = await fixture.create();
  const control = await open(page, f);
  const { alpha } = f.notes;
  const thumb = media(page, alpha, f.ids.art);
  const name = filename(page, alpha, f.ids.art);
  await expect(thumb).toHaveAttribute('href', detailsPath(f, f.ids.art));
  await expect(name).toHaveAttribute('href', detailsPath(f, f.ids.art));

  await thumb.click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(page.locator(TITLE)).toHaveText('art.png');
  const first = await viewerState(page);
  expect(first).toMatchObject({
    open: true, mode: 'single', count: 1, dialogs: 1, openDialogs: 1,
    sourceKey: `project-detail:${f.projectId}:note:${alpha.id}`,
    context: { projectId: f.projectId, assetId: String(f.ids.art), filename: 'art.png', projectName: f.project.title, detailsUrl: detailsPath(f, f.ids.art) },
    originalUrl: `${detailsPath(f, f.ids.art)}/original`,
    note: { kind: 'image', noteId: String(alpha.id), assetId: String(f.ids.art) },
    comic: null,
  });
  expect(first.mediaUrl.startsWith(`${detailsPath(f, f.ids.art)}/preview?v=`)).toBe(true);
  // Single image: no Previous/Next through the note's other assets.
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(TITLE)).toHaveText('art.png');
  await closeViewer(page);
  expect(await focusedIs(page, thumb)).toBe(true);
  expect(new URL(page.url()).pathname).toBe(f.url);

  // The filename opens the same viewer and gets focus back.
  await name.click();
  await expect(page.locator(TITLE)).toHaveText('art.png');
  expect((await viewerState(page)).note).toEqual({ kind: 'image', noteId: String(alpha.id), assetId: String(f.ids.art) });
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await focusedIs(page, name)).toBe(true);

  // Keyboard: Enter on the focused thumbnail and filename.
  for (const control of [thumb, name]) {
    await control.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(TITLE)).toHaveText('art.png');
    await closeViewer(page);
    expect(await focusedIs(page, control)).toBe(true);
  }

  // Viewing did not disclose, pin or edit the note.
  await expect(page.locator(`[data-project-related-note-disclosure="${alpha.id}"]`)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator(`[data-project-related-note-pin="${alpha.id}"]`)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // Modified and middle clicks are left to the browser (Asset Details).
  for (const control of [thumb, name]) {
    await page.evaluate(() => {
      window.__clicks = [];
      const record = (event) => { window.__clicks.push(event.defaultPrevented); event.preventDefault(); };
      window.addEventListener('click', record, { once: true });
      window.addEventListener('auxclick', record, { once: true });
    });
    await control.click({ modifiers: ['Control'] });
    await control.click({ button: 'middle' });
    expect(await page.evaluate(() => window.__clicks)).toEqual([false, false]);
  }
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(control.mutations).toEqual([]);
  expect(control.manifests).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('B: a readable comic opens the unified comic reader from its tile and filename', async ({ page }) => {
  const f = await fixture.create();
  const control = await open(page, f);
  const { alpha } = f.notes;
  const reader = media(page, alpha, f.ids.comic);
  const name = filename(page, alpha, f.ids.comic);
  // The placeholder look is kept, inside a Read comic link.
  await expect(reader).toHaveAccessibleName(/^Read comic book\.cbz/);
  await expect(reader.locator('.asset-list-card-media-placeholder')).toContainText('CBZ');
  await expect(reader.locator('img')).toHaveCount(0);
  const sourceRevision = await reader.getAttribute('data-comic-source-revision');
  expect(sourceRevision).toBeTruthy();
  expect(await name.getAttribute('data-comic-source-revision')).toBe(sourceRevision);

  await reader.click();
  await expect(page.locator(TITLE)).toHaveText('book.cbz');
  await expect.poll(async () => (await viewerState(page)).comic?.state).toBe('ready');
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
  const opened = await viewerState(page);
  expect(opened).toMatchObject({
    dialogs: 1,
    comic: { projectId: f.projectId, assetId: String(f.ids.comic), sourceRevision },
    context: { projectId: f.projectId, assetId: String(f.ids.comic), filename: 'book.cbz', detailsUrl: detailsPath(f, f.ids.comic) },
    note: { kind: 'comic', noteId: String(alpha.id), assetId: String(f.ids.comic) },
  });
  expect(control.manifests).toEqual([`${detailsPath(f, f.ids.comic)}/comic`]);
  // The reader owns page navigation.
  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
  // No legacy slideshow is involved.
  expect(await page.locator('[data-slideshow], #slideshow-dialog').count()).toBe(0);
  await closeViewer(page);
  expect(await focusedIs(page, reader)).toBe(true);

  await name.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(TITLE)).toHaveText('book.cbz');
  await expect.poll(async () => (await viewerState(page)).comic?.state).toBe('ready');
  await closeViewer(page);
  expect(await focusedIs(page, name)).toBe(true);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('C/D: a video opens the shared video preview; missing and unsupported files keep Asset Details', async ({ page }) => {
  const f = await fixture.create();
  const control = await open(page, f);
  const { alpha } = f.notes;
  for (const trigger of [media(page, alpha, f.ids.video), filename(page, alpha, f.ids.video)]) {
    await expect(trigger).toHaveAttribute('data-video-src', `${detailsPath(f, f.ids.video)}/original`);
    await trigger.click();
    await expect(page.locator(VIDEO_DIALOG)).toBeVisible();
    await expect(page.locator(`${VIDEO_DIALOG} [data-asset-video-preview-title]`)).toHaveText('clip');
    await expect(page.locator(`${VIDEO_DIALOG} [data-asset-video-preview-slot] video`)).toHaveAttribute('src', `${detailsPath(f, f.ids.video)}/original`);
    await expect(page.locator(`${VIDEO_DIALOG} [data-asset-video-preview-details]`)).toHaveAttribute('href', detailsPath(f, f.ids.video));
    // Undecodable bytes: the existing player error state, in the same dialog.
    await expect(page.locator(`${VIDEO_DIALOG} [data-asset-video-preview]`)).toHaveAttribute('data-video-state', 'failed');
    await expect(page.locator(DIALOG)).toBeHidden();
    expect((await viewerState(page)).open).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator(VIDEO_DIALOG)).toBeHidden();
    expect(await focusedIs(page, trigger)).toBe(true);
  }

  // Missing: no media link, no trigger; its filename still goes to Asset Details.
  await expect(tile(page, alpha, f.ids.gone).locator('.asset-list-card-media a')).toHaveCount(0);
  for (const id of [f.ids.gone, f.ids.text]) {
    await expect(tile(page, alpha, id).locator('[data-project-related-note-viewer-trigger], [data-project-related-note-comic-trigger], [data-asset-video-preview-trigger]')).toHaveCount(0);
    await filename(page, alpha, id).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(detailsPath(f, id));
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe(f.url);
    await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  }
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('E/F: refresh reconciles a surviving image, retires a removed one, and keeps the strip session', async ({ page }) => {
  const f = await fixture.create();
  const control = await open(page, f);
  const { alpha, gamma } = f.notes;

  // Same eligible asset with a new revision: the session updates in place.
  await media(page, alpha, f.ids.art).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(TITLE)).toHaveText('art.png');
  const before = await viewerState(page);
  await f.rewriteArt();
  await markRegion(page);
  await returnRefresh(page, f);
  await expect.poll(async () => (await viewerState(page)).revision).not.toBe(before.revision);
  const after = await viewerState(page);
  expect(after).toMatchObject({ open: true, session: before.session, sourceKey: before.sourceKey, dialogs: 1 });
  // Focus returns to the replaced thumbnail's current counterpart.
  await closeViewer(page);
  const counterpart = media(page, alpha, f.ids.art);
  expect(await focusedIs(page, counterpart)).toBe(true);
  // Refreshed tiles stay interactive, with one listener (one session per click).
  await counterpart.click();
  expect((await viewerState(page)).session).toBe(before.session + 1);
  await closeViewer(page);

  // A failed Notes read installed by a project refresh is no evidence.
  await media(page, alpha, f.ids.art).click();
  const kept = await viewerState(page);
  await page.route((url) => url.pathname === f.url, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.fallback();
    const response = await route.fetch();
    const html = (await response.text()).replace('data-project-related-notes>', 'data-project-related-notes data-project-related-notes-state="unavailable">')
      .replace(/<ul class="notes-page-preview-list project-related-note-list">[\s\S]*?<\/ul>\s*<\/div>\s*<\/section>/, '<div class="notice notice--error" data-project-related-notes-error><p>x</p></div></div></section>');
    return route.fulfill({ response, body: html });
  });
  expect(await page.evaluate(async (projectId) => {
    const { refreshProjectDetail } = await import('/client/project-detail-refresh.js');
    return refreshProjectDetail(document, projectId);
  }, f.projectId)).toBe('refreshed');
  await expect(page.locator('[data-project-related-notes-state="unavailable"]')).toHaveCount(1);
  expect(await viewerState(page)).toMatchObject({ open: true, session: kept.session, note: kept.note });
  await page.unrouteAll();

  // Superseded: an older answer that dropped the asset changes nothing.
  let releaseOld;
  const oldHeld = new Promise((resolve) => { releaseOld = resolve; });
  let calls = 0;
  await page.route((url) => url.pathname === f.url, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.fallback();
    calls += 1;
    if (calls === 1) {
      await oldHeld;
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stale</body></html>' }).catch(() => {});
    }
    return route.fallback();
  });
  const outcomes = page.evaluate(async (projectId) => {
    const { refreshProjectDetail } = await import('/client/project-detail-refresh.js');
    const older = refreshProjectDetail(document, projectId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const newer = refreshProjectDetail(document, projectId);
    return Promise.all([older, newer]);
  }, f.projectId);
  await expect.poll(() => calls).toBe(2);
  releaseOld();
  expect(await outcomes).toEqual(['superseded', 'refreshed']);
  expect(await viewerState(page)).toMatchObject({ open: true, session: kept.session, note: kept.note });
  await page.unrouteAll();
  await closeViewer(page);

  // An unrelated release-strip session survives a Related Notes refresh.
  await strip(page, f).click();
  await expect(page.locator(TITLE)).toHaveText('b.png');
  const stripState = await viewerState(page);
  expect(stripState).toMatchObject({ sourceKey: `project-detail:${f.projectId}:release:${f.release.id}`, note: null });
  fixture.noteService.updateNote(gamma.id, { assetIds: [] });
  await markRegion(page);
  await returnRefresh(page, f);
  expect(await viewerState(page)).toMatchObject({ open: true, session: stripState.session, stripSession: stripState.session });
  await closeViewer(page);
  await expect(strip(page, f)).toBeFocused();

  // Removing an open image's last association under its note retires it.
  fixture.noteService.updateNote(gamma.id, { assetIds: [f.ids.b] });
  await markRegion(page);
  await returnRefresh(page, f);
  await filename(page, gamma, f.ids.b).click();
  await expect(page.locator(TITLE)).toHaveText('b.png');
  expect((await viewerState(page)).note).toEqual({ kind: 'image', noteId: String(gamma.id), assetId: String(f.ids.b) });
  fixture.noteService.updateNote(gamma.id, { assetIds: [] });
  await markRegion(page);
  await returnRefresh(page, f);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await viewerState(page)).toMatchObject({ open: false, note: null });
  await expect(tile(page, gamma, f.ids.b)).toHaveCount(0);
  // Focus falls back to that note's title link.
  expect(await focusedIs(page, card(page, gamma).locator('[data-project-related-note-page-link]'))).toBe(true);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('E: an open comic is reconciled with its note and retired with it', async ({ page }) => {
  const f = await fixture.create();
  const control = await open(page, f);
  const { alpha } = f.notes;
  await media(page, alpha, f.ids.comic).click();
  await expect.poll(async () => (await viewerState(page)).comic?.state).toBe('ready');
  const opened = await viewerState(page);
  // Unchanged hint: nothing reloads.
  await markRegion(page);
  await returnRefresh(page, f);
  expect(await viewerState(page)).toMatchObject({ open: true, session: opened.session, comic: { state: 'ready' } });
  expect(control.manifests).toHaveLength(1);
  // The comic leaves the note: the reader is retired.
  fixture.noteService.updateNote(alpha.id, { assetIds: [f.ids.art, f.ids.video, f.ids.text, f.ids.gone] });
  await markRegion(page);
  await returnRefresh(page, f);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await viewerState(page)).toMatchObject({ open: false, note: null });
  expect(await focusedIs(page, card(page, alpha).locator('[data-project-related-note-page-link]'))).toBe(true);

  // Project retirement (the host's existing Delete path) closes a note session
  // and withdraws its triggers, leaving the plain Asset Details links.
  fixture.noteService.updateNote(alpha.id, { assetIds: [f.ids.art, f.ids.comic] });
  await markRegion(page);
  await returnRefresh(page, f);
  await media(page, alpha, f.ids.comic).click();
  await expect.poll(async () => (await viewerState(page)).comic?.state).toBe('ready');
  await page.evaluate(async () => {
    const { retireProjectDetailViewer } = await import('/client/project-detail-viewer.js');
    retireProjectDetailViewer(document);
  });
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('[data-project-related-note-viewer-trigger], [data-project-related-note-comic-trigger]')).toHaveCount(0);
  await expect(media(page, alpha, f.ids.comic)).toHaveAttribute('href', detailsPath(f, f.ids.comic));
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('G: the same asset under two notes keeps each note\'s own session and focus', async ({ page }) => {
  const f = await fixture.create();
  const control = await open(page, f);
  const { alpha, beta } = f.notes;
  await media(page, beta, f.ids.art).click();
  const betaState = await viewerState(page);
  expect(betaState).toMatchObject({
    sourceKey: `project-detail:${f.projectId}:note:${beta.id}`,
    note: { kind: 'image', noteId: String(beta.id), assetId: String(f.ids.art) },
  });
  await closeViewer(page);
  expect(await focusedIs(page, media(page, beta, f.ids.art))).toBe(true);

  await media(page, alpha, f.ids.art).click();
  expect(await viewerState(page)).toMatchObject({
    sourceKey: `project-detail:${f.projectId}:note:${alpha.id}`,
    note: { noteId: String(alpha.id) },
  });
  await closeViewer(page);
  expect(await focusedIs(page, media(page, alpha, f.ids.art))).toBe(true);

  // Beta drops the asset (it stays a project note): Beta's session closes
  // although Alpha still offers the same asset.
  await media(page, beta, f.ids.art).click();
  fixture.noteService.updateNote(beta.id, { assetIds: [] });
  await markRegion(page);
  await returnRefresh(page, f);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(media(page, alpha, f.ids.art)).toHaveCount(1);
  expect(await focusedIs(page, card(page, beta).locator('[data-project-related-note-page-link]'))).toBe(true);
  expect(control.errors).toEqual([]);
});

test('H/I: "Open in notes" wording, and the section\'s other controls still work', async ({ page }) => {
  const f = await fixture.create();
  const control = await open(page, f);
  const { alpha } = f.notes;
  await page.locator(`[data-project-related-note-disclosure="${alpha.id}"]`).click();
  const preview = page.locator(`[data-project-related-note-preview="${alpha.id}"]`);
  await expect(preview).toBeVisible();
  const link = preview.getByRole('link', { name: 'Open in notes' });
  await expect(link).toHaveAttribute('href', `/notes/${alpha.id}`);
  await expect(preview).not.toContainText('Open the full page');
  await expect(card(page, alpha).locator('[data-project-related-note-page-link]')).toHaveAttribute('href', `/notes/${alpha.id}`);

  // Pin, Edit, Create and Reorder still open their own controls.
  const pin = page.locator(`[data-project-related-note-pin="${alpha.id}"]`);
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await pin.click();
  for (const opener of [
    page.locator(`[data-project-related-note-edit="${alpha.id}"]`),
    page.locator('[data-project-related-note-create]'),
    page.locator('[data-project-related-notes-reorder]'),
  ]) {
    await opener.click();
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expect(page.locator(DIALOG)).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  }
  // The release strip still opens its own image.
  await strip(page, f).click();
  expect(await viewerState(page)).toMatchObject({ open: true, sourceKey: `project-detail:${f.projectId}:release:${f.release.id}`, note: null });
  await closeViewer(page);

  await link.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/notes/${alpha.id}`);
  expect(control.errors).toEqual([]);
});
