import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseService } from '../../src/services/release-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const DIALOG = '#asset-video-preview-dialog';

// Real, decodable WebM clips recorded by Chromium itself, so the intrinsic
// geometry and playback checks exercise the browser's media stack.
let landscapeWebm;
let portraitWebm;

async function recordWebm(browser, width, height) {
  const page = await browser.newPage();
  try {
    const base64 = await page.evaluate(async (size) => {
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      let frame = 0;
      const paint = () => {
        context.fillStyle = frame % 2 ? '#4f46e5' : '#f59e0b';
        context.fillRect(0, 0, size.width, size.height);
        frame += 1;
      };
      paint();
      const timer = setInterval(paint, 60);
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      recorder.stop();
      clearInterval(timer);
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let binary = '';
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      return btoa(binary);
    }, { width, height });
    return Buffer.from(base64, 'base64');
  } finally {
    await page.close();
  }
}

test.beforeAll(async ({ browser }) => {
  landscapeWebm = await recordWebm(browser, 160, 90);
  portraitWebm = await recordWebm(browser, 90, 160);
});

async function openFixture(page) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-video-preview-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  // A preview root enables the media router that serves /original.
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  fs.mkdirSync(previewRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  const close = async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    const project = app.locals.projectService.create({ title: 'Video Preview Browser Project', status: 'tbd' });
    const directory = path.join(projectsRoot, project.project_dir, 'renders');
    fs.mkdirSync(directory, { recursive: true });
    await sharp({ create: { width: 80, height: 60, channels: 4, background: '#10b981' } })
      .png().toFile(path.join(directory, 'still.png'));
    fs.writeFileSync(path.join(directory, 'landscape.webm'), landscapeWebm);
    fs.writeFileSync(path.join(directory, 'portrait.webm'), portraitWebm);
    app.locals.assetScanner.scanProjectAssets(project.id);
    const assets = app.locals.assetScanner.listProjectAssets(project.id);
    const byName = (name) => assets.find((asset) => asset.filename === name);
    const landscape = byName('landscape.webm');
    const portrait = byName('portrait.webm');
    const image = byName('still.png');
    expect(landscape.mime_type).toBe('video/webm');
    const release = createReleaseService({ db }).createReleaseWithSelectedAssets(
      project.id,
      { title: 'Video Preview Browser Release' },
      [landscape.id, portrait.id],
    );

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await page.setViewportSize({ width: 1100, height: 800 });
    // Record every play() call (surviving navigations) and optionally reject it,
    // so tests can prove which element plays and when.
    await page.addInitScript(() => {
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function play() {
        const calls = JSON.parse(sessionStorage.getItem('videoPlayCalls') || '[]');
        calls.push({
          inDialog: Boolean(this.closest('#asset-video-preview-dialog')),
          frame: this.hasAttribute('data-asset-video-frame'),
          src: this.getAttribute('src'),
          currentTime: this.currentTime,
          loop: this.loop,
          userActivation: navigator.userActivation ? navigator.userActivation.isActive : null,
        });
        sessionStorage.setItem('videoPlayCalls', JSON.stringify(calls));
        if (sessionStorage.getItem('rejectVideoPlay')) {
          return Promise.reject(new DOMException('Blocked by test', 'NotAllowedError'));
        }
        return original.call(this);
      };
    });
    return {
      baseURL: `http://127.0.0.1:${server.address().port}`,
      project,
      release,
      landscape,
      portrait,
      image,
      originalUrl: (asset) => `/projects/${project.id}/assets/${asset.id}/original`,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const playCalls = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('videoPlayCalls') || '[]'));
const videoLink = (page, fixture, asset) => page.locator(`a[data-asset-video-preview-trigger][data-video-src="${fixture.originalUrl(asset)}"]`);
const dialogVideos = (page) => page.locator(`${DIALOG} [data-asset-video-preview-slot] video`);
const loopBox = (page) => page.locator(`${DIALOG} [data-asset-video-loop]`);

// Wait until every card frame has loaded its metadata, so "passive" checks
// cover the metadata-load phase too.
async function waitForFrameMetadata(page) {
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-asset-video-frame]'))
    .every((video) => video.readyState >= 1 || video.error));
}

async function expectPreviewPlaying(page, fixture, asset, previousCalls) {
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(dialogVideos(page)).toHaveCount(1);
  const video = dialogVideos(page);
  await expect(video).toHaveAttribute('src', fixture.originalUrl(asset));
  await expect(video).toHaveAttribute('controls', '');
  await expect(video).toHaveAttribute('playsinline', '');
  await expect(video).toHaveAttribute('preload', 'metadata');
  await expect(video).not.toHaveAttribute('autoplay', /.*/);
  const calls = await playCalls(page);
  expect(calls).toHaveLength(previousCalls + 1);
  expect(calls.at(-1)).toMatchObject({
    inDialog: true, frame: false, src: fixture.originalUrl(asset), currentTime: 0, loop: false, userActivation: true,
  });
  await expect(loopBox(page)).not.toBeChecked();
  await expect.poll(() => video.evaluate((element) => !element.paused || element.ended)).toBe(true);
}

async function expectPreviewClosed(page, player) {
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(dialogVideos(page)).toHaveCount(0);
  expect(await player.evaluate((element) => ({
    paused: element.paused, src: element.getAttribute('src'), loop: element.loop, connected: element.isConnected,
  }))).toEqual({ paused: true, src: null, loop: false, connected: false });
  await expect(loopBox(page)).not.toBeChecked();
}

test('every video card surface opens the shared preview and plays it from the click, never passively', async ({ page }) => {
  const fixture = await openFixture(page);
  try {
    const surfaces = [
      `/projects/${fixture.project.id}/assets?view=grid`,
      `/projects/${fixture.project.id}/assets?view=list`,
      '/asset-viewer?view=grid',
      '/asset-viewer?view=list',
      `/releases/${fixture.release.id}/assets?view=grid`,
      `/releases/${fixture.release.id}/assets?view=list`,
      `/releases/${fixture.release.id}?view=grid`,
      `/releases/${fixture.release.id}?view=list`,
    ];
    for (const surface of surfaces) {
      await test.step(surface, async () => {
        await page.goto(`${fixture.baseURL}${surface}`);
        await waitForFrameMetadata(page);
        const before = (await playCalls(page)).length;
        const link = videoLink(page, fixture, fixture.landscape);
        await expect(link).toHaveCount(1);

        // Page load, metadata, hover, and focus never play.
        await link.hover();
        await link.focus();
        expect(await playCalls(page)).toHaveLength(before);
        await expect(page.locator(DIALOG)).toBeHidden();

        await link.click();
        await expectPreviewPlaying(page, fixture, fixture.landscape, before);
        await expect(page.locator(`${DIALOG} [data-asset-video-preview-details]`))
          .toHaveAttribute('href', await link.getAttribute('href'));
        const player = await dialogVideos(page).elementHandle();
        await page.keyboard.press('Escape');
        await expectPreviewClosed(page, player);
        // Card frames are never a play() target.
        expect((await playCalls(page)).every((call) => call.inDialog && !call.frame)).toBe(true);
      });
    }
  } finally {
    await fixture.close();
  }
});

test('Enter on a focused video link opens and plays through the same path', async ({ page }) => {
  const fixture = await openFixture(page);
  try {
    await page.goto(`${fixture.baseURL}/asset-viewer?view=grid`);
    await waitForFrameMetadata(page);
    await videoLink(page, fixture, fixture.portrait).focus();
    await page.keyboard.press('Enter');
    await expectPreviewPlaying(page, fixture, fixture.portrait, 0);
  } finally {
    await fixture.close();
  }
});

test('Loop, close paths, reopen, and switching videos reset transient playback state', async ({ page }) => {
  const fixture = await openFixture(page);
  try {
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=grid`);
    await waitForFrameMetadata(page);

    await videoLink(page, fixture, fixture.landscape).click();
    await expectPreviewPlaying(page, fixture, fixture.landscape, 0);
    const first = await dialogVideos(page).elementHandle();
    await loopBox(page).check();
    expect(await first.evaluate((element) => element.loop)).toBe(true);
    await loopBox(page).uncheck();
    expect(await first.evaluate((element) => element.loop)).toBe(false);
    await loopBox(page).check();
    // Toggling Loop never plays by itself.
    expect(await playCalls(page)).toHaveLength(1);

    // Close button.
    await page.locator(`${DIALOG} [data-dialog-close]`).click();
    await expectPreviewClosed(page, first);

    // Reopen: a fresh player at 0 with Loop off, played by the new click.
    await videoLink(page, fixture, fixture.landscape).click();
    await expectPreviewPlaying(page, fixture, fixture.landscape, 1);
    const second = await dialogVideos(page).elementHandle();
    expect(await second.evaluate((element, old) => element !== old, first)).toBe(true);
    await loopBox(page).check();

    // Switching straight to video B stops A completely; only B plays, Loop off.
    await videoLink(page, fixture, fixture.portrait).evaluate((link) => link.click());
    await expect(dialogVideos(page)).toHaveCount(1);
    await expect(dialogVideos(page)).toHaveAttribute('src', fixture.originalUrl(fixture.portrait));
    expect(await second.evaluate((element) => ({ paused: element.paused, connected: element.isConnected, loop: element.loop })))
      .toEqual({ paused: true, connected: false, loop: false });
    await expect(loopBox(page)).not.toBeChecked();
    expect(await dialogVideos(page).evaluate((element) => element.loop)).toBe(false);
    expect((await playCalls(page)).at(-1)).toMatchObject({ src: fixture.originalUrl(fixture.portrait), loop: false });

    // Backdrop dismissal.
    const third = await dialogVideos(page).elementHandle();
    await page.mouse.click(4, 4);
    await expectPreviewClosed(page, third);
  } finally {
    await fixture.close();
  }
});

test('the preview and card frames keep each video\'s intrinsic portrait or landscape geometry', async ({ page }) => {
  const fixture = await openFixture(page);
  try {
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=grid`);
    await waitForFrameMetadata(page);
    const frameRatio = (asset) => page.locator(`video[data-asset-video-frame][src="${fixture.originalUrl(asset)}"]`)
      .evaluate((element) => element.getBoundingClientRect().width / element.getBoundingClientRect().height);
    expect(await frameRatio(fixture.landscape)).toBeGreaterThan(1.2);
    expect(await frameRatio(fixture.portrait)).toBeLessThan(0.8);

    for (const [asset, landscape] of [[fixture.landscape, true], [fixture.portrait, false]]) {
      await videoLink(page, fixture, asset).click();
      const video = dialogVideos(page);
      await expect.poll(() => video.evaluate((element) => element.videoWidth)).toBeGreaterThan(0);
      const box = await video.boundingBox();
      expect(box.width > box.height).toBe(landscape);
      await page.keyboard.press('Escape');
    }
  } finally {
    await fixture.close();
  }
});

test('a rejected play() keeps the dialog open with native controls and no codec error', async ({ page }) => {
  const fixture = await openFixture(page);
  try {
    await page.goto(`${fixture.baseURL}/releases/${fixture.release.id}?view=grid`);
    await waitForFrameMetadata(page);
    await page.evaluate(() => sessionStorage.setItem('rejectVideoPlay', '1'));
    const errors = [];
    page.on('pageerror', (error) => errors.push(error));

    await videoLink(page, fixture, fixture.landscape).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    const video = dialogVideos(page);
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('controls', '');
    await expect(page.locator(`${DIALOG} [data-asset-video-error]`)).toBeHidden();
    await expect(page.locator(`${DIALOG} [data-asset-video-preview]`)).not.toHaveAttribute('data-video-state', /.*/);
    expect(await video.evaluate((element) => element.paused)).toBe(true);
    expect(await playCalls(page)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('selection, details, role, modifier clicks, view switches, and filters never play', async ({ page, context }) => {
  const fixture = await openFixture(page);
  try {
    const selectionUrl = `${fixture.baseURL}/releases/${fixture.release.id}/assets?view=grid`;
    await page.goto(selectionUrl);
    await waitForFrameMetadata(page);

    // The selection control only toggles selection.
    const checkbox = page.locator(`#release-asset-select-${fixture.landscape.id}`);
    const wasChecked = await checkbox.isChecked();
    await page.locator(`label[for="release-asset-select-${fixture.landscape.id}"]`).click();
    await expect(checkbox).toBeChecked({ checked: !wasChecked });
    await expect(page.locator(DIALOG)).toBeHidden();
    await page.locator(`label[for="release-asset-select-${fixture.landscape.id}"]`).click();

    // Release role control.
    const role = page.locator(`#role-${fixture.portrait.id}`);
    const roleSaved = page.waitForResponse((candidate) => candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname.endsWith(`/assets/${fixture.portrait.id}/role`));
    await role.selectOption('primary');
    await roleSaved;
    await page.waitForLoadState('load');
    await expect(page.locator(DIALOG)).toBeHidden();

    // Ctrl-click keeps opening the Asset Viewer in a new tab.
    await page.goto(selectionUrl);
    await waitForFrameMetadata(page);
    const link = videoLink(page, fixture, fixture.landscape);
    const popupPromise = context.waitForEvent('page');
    await link.click({ modifiers: ['Control'] });
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(new URL(popup.url()).pathname).toBe(`/projects/${fixture.project.id}/assets/${fixture.landscape.id}`);
    await popup.close();
    await expect(page.locator(DIALOG)).toBeHidden();

    // Grid/List switching (live region) and filtering never play.
    await page.goto(`${fixture.baseURL}/asset-viewer?view=grid`);
    await waitForFrameMetadata(page);
    await page.getByRole('link', { name: 'List view' }).click();
    await expect(page).toHaveURL(/view=list/);
    await waitForFrameMetadata(page);
    await page.getByRole('link', { name: 'Filter assets' }).click();
    const filterDialog = page.locator('#asset-viewer-filter-dialog');
    await expect(filterDialog).toBeVisible();
    const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/asset-viewer');
    await filterDialog.locator('#asset-extension-filter > summary').click();
    await filterDialog.locator('input[name="extension"][value="webm"]').check();
    await response;
    await filterDialog.locator('[data-dialog-close]').click();
    await expect(filterDialog).toBeHidden();
    await waitForFrameMetadata(page);
    // Re-rendered cards still use the shared dialog.
    await videoLink(page, fixture, fixture.portrait).click();
    await expectPreviewPlaying(page, fixture, fixture.portrait, 0);
    await page.keyboard.press('Escape');

    // Details link navigates to the Asset Viewer, which stays paused on load.
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=grid`);
    const card = page.locator(`article[data-asset-id="${fixture.landscape.id}"]`);
    await card.locator('.asset-details-link').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${fixture.project.id}/assets/${fixture.landscape.id}`));
    await expect(page.locator(DIALOG)).toBeHidden();

    // Back/forward restoration never restarts playback.
    await page.goBack();
    await waitForFrameMetadata(page);
    await page.goForward();

    const calls = await playCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ inDialog: true, src: fixture.originalUrl(fixture.portrait) });
  } finally {
    await fixture.close();
  }
});

test('the Asset Viewer player loads paused and Loop only toggles native looping', async ({ page }) => {
  const fixture = await openFixture(page);
  try {
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets/${fixture.landscape.id}`);
    const viewer = page.locator('.asset-preview-frame--video');
    const player = viewer.locator('video[data-asset-video]');
    await expect.poll(() => player.evaluate((element) => element.readyState)).toBeGreaterThanOrEqual(1);
    const loop = viewer.getByRole('checkbox', { name: 'Loop' });
    await expect(loop).not.toBeChecked();
    expect(await player.evaluate((element) => ({ paused: element.paused, loop: element.loop })))
      .toEqual({ paused: true, loop: false });

    await loop.check();
    expect(await player.evaluate((element) => ({ paused: element.paused, loop: element.loop })))
      .toEqual({ paused: true, loop: true });
    await loop.uncheck();
    expect(await player.evaluate((element) => element.loop)).toBe(false);
    expect(await playCalls(page)).toEqual([]);

    // Stand-in for the native Play control: Loop can change mid-playback
    // without pausing or restarting.
    await player.evaluate((element) => { element.muted = true; return element.play(); });
    await loop.check();
    expect(await player.evaluate((element) => element.loop)).toBe(true);
    expect(await playCalls(page)).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test('images keep using the slideshow and never the video dialog', async ({ page }) => {
  const fixture = await openFixture(page);
  try {
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=grid`);
    await waitForFrameMetadata(page);
    const sequence = JSON.parse(await page.locator('[data-slideshow-sequence]').first().textContent());
    expect(sequence.map((entry) => entry.id)).toEqual([fixture.image.id]);
    await page.locator(`a[data-project-assets-preview-id="${fixture.image.id}"]`).click();
    await expect(page.locator('[data-slideshow-scaffold]')).toBeVisible();
    await expect(page.locator(DIALOG)).toBeHidden();
    expect(await playCalls(page)).toEqual([]);
  } finally {
    await fixture.close();
  }
});
