import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// B4 correction: a fullscreen-entry request still pending when the unified
// viewer is closed or destroyed, then granted by the browser. Run in real
// Chromium against the compiled production bundle (built here into a temp
// directory), as the original reproduction was. The race is the reviewer's
// same-click sequence: a listener added after the viewer's own on the
// fullscreen button closes or destroys the viewer in the same click, so the
// request (which has user activation) is pending when it does; Chromium then
// grants it to the card of the now-closed dialog, blurring the page to
// <body> after the change (without a focusout event). A fullscreenchange log
// proves each round really took that path; replaying these tests on the
// pre-correction logic leaves focus on <body> and, after destroy, the card
// fullscreen.
// The viewer is driven through the bundle's controller from an isolated test
// opener; media is served by page.route; no user data is used.

const DIALOG = '#unified-viewer-dialog';
const ROUNDS = 3;

let fixture;
let image;

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-unified-viewer-fullscreen-pending-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  image = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 40, b: 40 } } }).webp().toBuffer();
  fixture = {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(db);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
});
test.afterAll(async () => { await fixture?.close(); });

// The production page with an isolated opener and a second focus target, a
// fullscreenchange log, and the bundle's controller (no source modules).
async function openPage(page) {
  await page.route('**/test-media/**', (route) => route.fulfill({ status: 200, contentType: 'image/webp', body: image }));
  await page.goto(`${fixture.baseURL}/assets`, { waitUntil: 'domcontentloaded' });
  expect(await page.evaluate(() => Boolean(document.querySelector('script[type="module"][src^="/vite/"]')))).toBe(true);
  await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'test-viewer-host';
    host.innerHTML = '<button type="button" id="test-opener">Open viewer</button>'
      + '<button type="button" id="test-other">Somewhere else</button>';
    document.querySelector('main').prepend(host);
    const describe = (element) => (!element ? null : element === document.body ? 'body'
      : element.id ? `#${element.id}` : element.matches('[data-unified-viewer-card]') ? 'card' : element.tagName.toLowerCase());
    window.__describe = describe;
    window.__fullscreenLog = [];
    document.addEventListener('fullscreenchange', () => {
      window.__fullscreenLog.push({ element: describe(document.fullscreenElement) });
    });
    window.__viewer = () => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
    // Bind a replacement controller to the same dialog card the way a fresh
    // page initialization would: run the production bundle again (a second
    // module instance), whose init binds the dialog once its controller is gone.
    window.__rebind = async (round) => {
      const src = document.querySelector('script[type="module"][src^="/vite/"]').src;
      await import(`${src}?rebind=${round}`);
      return Boolean(window.__viewer());
    };
    window.__source = () => ({
      key: 'pending-fullscreen-test',
      label: 'Pending fullscreen test',
      mode: 'sequence',
      wrap: false,
      items: [1, 2].map((id) => ({
        projectId: 7,
        assetId: id,
        title: `image-${id}.webp`,
        mediaUrl: `/test-media/image-${id}`,
        detailsUrl: `/projects/7/assets/${id}`,
        revision: 'r1',
      })),
    });
  });
}

async function openViewer(page) {
  await page.locator('#test-opener').focus();
  const session = await page.evaluate(() => window.__viewer().open(window.__source(), { opener: document.getElementById('test-opener') }));
  expect(session).toBeGreaterThan(0);
  await expect(page.locator(`${DIALOG} [data-unified-viewer-media] img.unified-viewer-image:not([hidden])`)).toBeVisible();
  await page.evaluate(() => { window.__fullscreenLog.length = 0; });
}

// Arm a one-shot action that runs in the same click, after the viewer's own
// fullscreen handler has requested fullscreen.
async function armSameClick(page, action) {
  await page.evaluate((name) => {
    const button = document.querySelector('[data-unified-viewer-fullscreen]');
    button.addEventListener('click', () => {
      const viewer = window.__viewer();
      window.__pendingAtAction = viewer.fullscreen.getState().pending;
      if (name === 'close-button') document.querySelector('#unified-viewer-dialog [data-dialog-close]').click();
      else if (name === 'controller-close') viewer.close();
      else if (name === 'close-then-user-focus') {
        viewer.close();
        // The dialog's close event is queued; the user's own move follows it.
        setTimeout(() => document.getElementById('test-other').focus(), 0);
      } else if (name === 'close-then-reopen') {
        viewer.close();
        setTimeout(() => {
          window.__reopened = viewer.open(window.__source(), { opener: document.getElementById('test-opener') });
        }, 0);
      } else if (name === 'destroy') viewer.destroy();
    }, { once: true });
  }, action);
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  expect(await page.evaluate(() => window.__pendingAtAction)).toBe(true);
}

const settled = (page) => expect.poll(() => page.evaluate(() => {
  const log = window.__fullscreenLog;
  return log.length >= 2 && log.at(-1).element === null && document.fullscreenElement === null;
}), { timeout: 10_000 }).toBe(true);

const snapshot = (page) => page.evaluate(() => {
  const dialog = document.getElementById('unified-viewer-dialog');
  const card = dialog.querySelector('[data-unified-viewer-card]');
  const active = document.activeElement;
  return {
    log: window.__fullscreenLog.slice(),
    fullscreenElement: document.fullscreenElement ? 'set' : null,
    active: active === document.body ? 'body' : active?.id ? `#${active.id}` : active?.tagName.toLowerCase() || null,
    activeInDialog: dialog.contains(active),
    dialogOpen: dialog.open,
    scrollLocked: document.body.classList.contains('app-dialog-open'),
    bodyOverflow: getComputedStyle(document.body).overflow,
    viewerAttached: Boolean(dialog.__creatorCrateUnifiedViewer),
    rootFullscreen: Boolean(dialog.querySelector('[data-unified-viewer][data-viewer-fullscreen]')),
    chromeHidden: card.hasAttribute('data-viewer-chrome-hidden'),
    buttonHidden: dialog.querySelector('[data-unified-viewer-fullscreen]').hidden,
  };
});

test('closing during a pending entry: the late grant is released and focus returns to the opener', async ({ page }) => {
  await openPage(page);
  for (const action of ['close-button', 'controller-close']) {
    for (let round = 0; round < ROUNDS; round += 1) {
      await openViewer(page);
      await armSameClick(page, action);
      await settled(page);
      await expect(page.locator('#test-opener')).toBeFocused();
      const state = await snapshot(page);
      // The race really happened: the closed viewer's card was granted fullscreen.
      expect(state.log[0], `${action} round ${round}`).toEqual({ element: 'card' });
      expect(state).toMatchObject({
        fullscreenElement: null, active: '#test-opener', dialogOpen: false, scrollLocked: false,
        rootFullscreen: false, chromeHidden: false, buttonHidden: true,
      });
      expect(state.bodyOverflow).not.toBe('hidden');
      const viewer = await page.evaluate(() => {
        const { open, fullscreen } = window.__viewer().getState();
        return { open, fullscreen, detail: window.__viewer().fullscreen.getState() };
      });
      expect(viewer).toMatchObject({ open: false, fullscreen: false, detail: { active: false, pending: false, chromeHidden: false } });
    }
  }
});

test('closing during a pending entry keeps a deliberate focus move and never serves a reopened session', async ({ page }) => {
  await openPage(page);
  for (let round = 0; round < ROUNDS; round += 1) {
    await openViewer(page);
    await armSameClick(page, 'close-then-user-focus');
    await settled(page);
    await expect(page.locator('#test-other')).toBeFocused();
    const state = await snapshot(page);
    expect(state.log[0]).toEqual({ element: 'card' });
  }

  for (let round = 0; round < ROUNDS; round += 1) {
    await openViewer(page);
    await armSameClick(page, 'close-then-reopen');
    await settled(page);
    const state = await snapshot(page);
    expect(state).toMatchObject({ fullscreenElement: null, dialogOpen: true, scrollLocked: true, rootFullscreen: false });
    expect(state.active).not.toBe('#test-opener');
    const viewer = await page.evaluate(() => ({ ...window.__viewer().getState(), source: undefined, item: undefined, reopened: window.__reopened }));
    expect(viewer).toMatchObject({ open: true, fullscreen: false });
    expect(viewer.session).toBe(viewer.reopened);
    // The reopened session still enters and leaves fullscreen normally.
    await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement?.matches('[data-unified-viewer-card]')))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
    await expect(page.locator(DIALOG)).toBeVisible();
    await page.evaluate(() => window.__viewer().close());
    await expect(page.locator('#test-opener')).toBeFocused();
  }
});

test('destroying during a pending entry: the late grant is released and nothing is revived', async ({ page }) => {
  for (let round = 0; round < ROUNDS; round += 1) {
    await openPage(page);
    await openViewer(page);
    const requestsBefore = await page.evaluate(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/test-media/')).length);
    await armSameClick(page, 'destroy');
    await settled(page);
    const state = await snapshot(page);
    expect(state.log[0], `destroy round ${round}`).toMatchObject({ element: 'card' });
    expect(state).toMatchObject({
      fullscreenElement: null, dialogOpen: false, scrollLocked: false, viewerAttached: false,
      rootFullscreen: false, chromeHidden: false, buttonHidden: true,
    });
    // Inactive: its controls do nothing, and no media is requested.
    await page.evaluate(() => {
      const dialog = document.getElementById('unified-viewer-dialog');
      dialog.querySelector('[data-unified-viewer-fullscreen]').click();
      dialog.querySelector('[data-unified-viewer-next]').click();
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    const after = await snapshot(page);
    expect(after).toMatchObject({ fullscreenElement: null, rootFullscreen: false, buttonHidden: true, dialogOpen: false });
    expect(await page.evaluate(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/test-media/')).length)).toBe(requestsBefore);
  }
});

test('normal fullscreen entry, Escape exit, close from fullscreen and Escape-to-close are unchanged', async ({ page }) => {
  await openPage(page);
  const dialog = page.locator(DIALOG);
  await openViewer(page);
  await dialog.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement?.matches('[data-unified-viewer-card]')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();

  await openViewer(page);
  await dialog.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement?.matches('[data-unified-viewer-card]')))).toBe(true);
  await page.mouse.move(10, 10);
  await dialog.getByRole('button', { name: 'Close Image Preview' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  await expect(page.locator('#test-opener')).toBeFocused();
  const state = await snapshot(page);
  expect(state).toMatchObject({ scrollLocked: false, rootFullscreen: false, chromeHidden: false });
});

// ─── F3 / F4 (re-review) ─────────────────────────────────────────────────────
//
// F3: the viewer is closed from ACTIVE fullscreen (its exit request starts,
// and the binder's dismissal hook hands the opener focus return over because
// the page is inert), then the controller is destroyed in the dialog's close
// event, before the native exit has landed. On the pre-correction logic the
// destroy dropped that focus return and focus ended on <body>.
//
// F4: controller A's native request is granted, but delivery of its
// completion to A is held back (the only gated step: requestFullscreen and
// exitFullscreen are Chromium's own). A is destroyed in the same click, a
// replacement controller B is bound to the same dialog card by running the
// production bundle again, and B enters fullscreen natively. A's completion is
// then delivered. On the pre-correction logic A's cleanup exited B's
// fullscreen, because it only compared document.fullscreenElement with the card.

const REPEATS = 5;

const mediaRequests = (page) => page.evaluate(() => performance.getEntriesByType('resource')
  .filter((entry) => entry.name.includes('/test-media/')).length);

const exited = (page) => expect.poll(() => page.evaluate(() => {
  const log = window.__fullscreenLog;
  return log.length >= 1 && log.at(-1).element === null && document.fullscreenElement === null;
}), { timeout: 10_000 }).toBe(true);

// The fullscreen participant's ownership claim on the card (viewer-fullscreen.js).
const claimLeft = (page) => page.evaluate(() => Symbol.for('creatorcrate.viewerFullscreenClaim')
  in document.querySelector('[data-unified-viewer-card]'));

const frames = (page, count = 3) => page.evaluate((n) => new Promise((resolve) => {
  const step = (left) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(n);
}), count);

async function enterFullscreen(page) {
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement?.matches('[data-unified-viewer-card]')))).toBe(true);
}

async function expectDestroyedAndInert(page, requestsBefore) {
  const state = await snapshot(page);
  expect(state).toMatchObject({
    fullscreenElement: null, dialogOpen: false, scrollLocked: false, viewerAttached: false,
    rootFullscreen: false, chromeHidden: false, buttonHidden: true,
  });
  expect(state.bodyOverflow).not.toBe('hidden');
  // Nothing was revived: its controls do nothing and no media is requested.
  await page.evaluate(() => {
    const dialog = document.getElementById('unified-viewer-dialog');
    dialog.querySelector('[data-unified-viewer-fullscreen]').click();
    dialog.querySelector('[data-unified-viewer-next]').click();
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await frames(page);
  const after = await snapshot(page);
  expect(after).toMatchObject({ fullscreenElement: null, rootFullscreen: false, buttonHidden: true, dialogOpen: false, viewerAttached: false });
  expect(await mediaRequests(page)).toBe(requestsBefore);
  expect(await claimLeft(page)).toBe(false);
  return state;
}

test('F3: destroy while the exit from active fullscreen is underway still returns focus to the opener', async ({ page }) => {
  for (const variant of ['opener', 'fallback']) {
    for (let round = 0; round < REPEATS; round += 1) {
      const label = `${variant} round ${round}`;
      await openPage(page);
      await openViewer(page);
      await enterFullscreen(page);
      const requestsBefore = await mediaRequests(page);
      await page.evaluate((removeOpener) => {
        window.__fullscreenLog.length = 0;
        window.__atDestroy = null;
        // Registered after the shared binder's own close handling, so the
        // viewer's dismissal hook has already handed the focus return over.
        document.getElementById('unified-viewer-dialog').addEventListener('close', () => {
          window.__atDestroy = {
            fullscreenElement: window.__describe(document.fullscreenElement),
            exitsLanded: window.__fullscreenLog.length,
          };
          window.__viewer().destroy();
          if (removeOpener) document.getElementById('test-opener').remove();
        }, { once: true });
      }, variant === 'fallback');
      await page.locator(DIALOG).getByRole('button', { name: 'Close Image Preview' }).click();
      await exited(page);
      // The race really happened: the card was still fullscreen at destroy.
      expect(await page.evaluate(() => window.__atDestroy), label).toEqual({ fullscreenElement: 'card', exitsLanded: 0 });
      const expected = variant === 'opener' ? '#test-opener' : '#main-content';
      await expect.poll(() => page.evaluate(() => window.__describe(document.activeElement)), { message: label }).toBe(expected);
      const state = await expectDestroyedAndInert(page, requestsBefore);
      expect(state.log, label).toEqual([{ element: null }]);
      // Focus stays where it was returned (no second, later restoration).
      expect(await page.evaluate(() => window.__describe(document.activeElement)), label).toBe(expected);
    }
  }
});

test('F3: close() then destroy() in one task from active fullscreen returns focus once the exit lands', async ({ page }) => {
  for (let round = 0; round < REPEATS; round += 1) {
    await openPage(page);
    await openViewer(page);
    await enterFullscreen(page);
    const requestsBefore = await mediaRequests(page);
    const atDestroy = await page.evaluate(() => {
      window.__fullscreenLog.length = 0;
      const viewer = window.__viewer();
      viewer.close();
      const fullscreenElement = window.__describe(document.fullscreenElement);
      viewer.destroy();
      viewer.destroy();
      return fullscreenElement;
    });
    expect(atDestroy, `round ${round}`).toBe('card');
    await exited(page);
    await expect(page.locator('#test-opener')).toBeFocused();
    await expectDestroyedAndInert(page, requestsBefore);
  }
});

test('F4: a destroyed controller\'s delayed completion never exits the fullscreen its replacement entered', async ({ page }) => {
  for (let round = 0; round < REPEATS; round += 1) {
    const label = `round ${round}`;
    await openPage(page);
    await openViewer(page);
    // A requests fullscreen natively; only the delivery of the completion to
    // A is held. A is destroyed in the same click, while it is pending.
    await page.evaluate(() => {
      const card = document.querySelector('[data-unified-viewer-card]');
      window.__nativeA = null;
      window.__deliverA = null;
      card.requestFullscreen = function gatedRequest(options) {
        delete card.requestFullscreen;
        const native = Element.prototype.requestFullscreen.call(this, options);
        window.__nativeA = 'pending';
        native.then(() => { window.__nativeA = 'granted'; }, () => { window.__nativeA = 'refused'; });
        return new Promise((resolve, reject) => {
          window.__deliverA = () => native.then(resolve, reject);
        });
      };
      window.__first = window.__viewer();
      document.querySelector('[data-unified-viewer-fullscreen]').addEventListener('click', () => {
        window.__pendingAtAction = window.__first.fullscreen.getState().pending;
        window.__first.destroy();
      }, { once: true });
    });
    await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
    expect(await page.evaluate(() => window.__pendingAtAction), label).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__nativeA)).toBe('granted');
    expect(await page.evaluate(() => window.__fullscreenLog[0]), label).toEqual({ element: 'card' });

    // B: bound to the same dialog card; it releases A's orphaned grant itself
    // when its session opens, then enters fullscreen natively.
    expect(await page.evaluate((index) => window.__rebind(index), round)).toBe(true);
    expect(await page.evaluate(() => window.__viewer() !== window.__first)).toBe(true);
    await openViewer(page);
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
    await enterFullscreen(page);
    await expect.poll(() => page.evaluate(() => window.__viewer().fullscreen.getState().active)).toBe(true);
    await page.mouse.move(20, 20);
    const before = await page.evaluate(() => {
      const viewer = window.__viewer();
      // Counts exit requests from here on (calling through to the native one).
      const nativeExit = Document.prototype.exitFullscreen;
      window.__exitCalls = 0;
      document.exitFullscreen = function countedExit() {
        window.__exitCalls += 1;
        return nativeExit.call(this);
      };
      const { session, key, playback } = viewer.getState();
      return { session, key, playback, active: window.__describe(document.activeElement), log: window.__fullscreenLog.length };
    });
    expect(before.active, label).toBe('button');

    // A's completion is delivered last.
    await page.evaluate(() => window.__deliverA());
    await frames(page, 4);
    const after = await page.evaluate(() => {
      const viewer = window.__viewer();
      const dialog = document.getElementById('unified-viewer-dialog');
      const { open, session, key, playback, fullscreen } = viewer.getState();
      return {
        exitCalls: window.__exitCalls,
        fullscreenElement: window.__describe(document.fullscreenElement),
        log: window.__fullscreenLog.length,
        open, session, key, playback, fullscreen,
        detail: viewer.fullscreen.getState(),
        dialogOpen: dialog.open,
        rootFullscreen: Boolean(dialog.querySelector('[data-unified-viewer][data-viewer-fullscreen]')),
        buttonLabel: dialog.querySelector('[data-unified-viewer-fullscreen]').getAttribute('aria-label'),
        active: window.__describe(document.activeElement),
      };
    });
    expect(after, label).toMatchObject({
      exitCalls: 0, fullscreenElement: 'card', log: before.log,
      open: true, session: before.session, key: before.key, playback: before.playback, fullscreen: true,
      detail: { active: true, pending: false }, dialogOpen: true, rootFullscreen: true,
      buttonLabel: 'Exit fullscreen', active: before.active,
    });

    // B stays functional: it navigates, then leaves fullscreen and closes normally.
    await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
    await expect.poll(() => page.evaluate(() => window.__viewer().getState().index)).toBe(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
    expect(await page.evaluate(() => window.__exitCalls), label).toBe(1);
    await expect(page.locator(DIALOG)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator('#test-opener')).toBeFocused();
    // Neither controller's fullscreen claim is left on the card.
    expect(await claimLeft(page), label).toBe(false);
  }
});

// ─── F5 (re-review) ──────────────────────────────────────────────────────────
//
// Controller A's native request is granted after A was destroyed (delivery of
// its completion to A is held, as in F4). Its orphaned fullscreen is then
// released by a REAL native exitFullscreen(), and while that exit is still
// outstanding, replacement controller B (the production bundle evaluated
// again, bound to the same card) tries to enter fullscreen. On the
// pre-correction logic Chromium granted B's request and A's earlier exit then
// removed B's fullscreen. Here B's attempt must be refused before the native
// API, the control must show it as unavailable, and once the old exit has
// completed a fresh explicit request must enter and keep fullscreen.
//
// Nothing about the native calls is delayed or faked: requestFullscreen and
// exitFullscreen are wrapped only to count calls and observe their native
// promises. The overlap is produced inside one task (user activation from a
// real key press), so the native exit is provably still outstanding when B
// tries: the card is still document.fullscreenElement, no fullscreenchange has
// been delivered since, and the native exit promise is unsettled.

const OVERLAP_REPEATS = 3;

// A: open, request natively with completion delivery held, destroyed in the
// same click; the native grant lands. B: bound to the card, not yet opened.
async function orphanedGrantWithReplacement(page, round) {
  await openPage(page);
  await openViewer(page);
  await page.evaluate(() => {
    const card = document.querySelector('[data-unified-viewer-card]');
    window.__nativeA = null;
    window.__deliverA = null;
    card.requestFullscreen = function gatedRequest(options) {
      delete card.requestFullscreen;
      const native = Element.prototype.requestFullscreen.call(this, options);
      window.__nativeA = 'pending';
      native.then(() => { window.__nativeA = 'granted'; }, () => { window.__nativeA = 'refused'; });
      return new Promise((resolve, reject) => {
        window.__deliverA = () => native.then(resolve, reject);
      });
    };
    window.__first = window.__viewer();
    document.querySelector('[data-unified-viewer-fullscreen]').addEventListener('click', () => {
      window.__pendingAtAction = window.__first.fullscreen.getState().pending;
      window.__first.destroy();
    }, { once: true });
  });
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  expect(await page.evaluate(() => window.__pendingAtAction)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__nativeA)).toBe('granted');
  expect(await page.evaluate(() => window.__fullscreenLog[0])).toEqual({ element: 'card' });
  expect(await page.evaluate(() => window.__describe(document.fullscreenElement))).toBe('card');

  expect(await page.evaluate((index) => window.__rebind(`f5-${index}`), round)).toBe(true);
  expect(await page.evaluate(() => window.__viewer() !== window.__first)).toBe(true);
  // Count native calls from here on (pass-through only).
  await page.evaluate(() => {
    const card = document.querySelector('[data-unified-viewer-card]');
    const nativeExit = Document.prototype.exitFullscreen;
    const nativeRequest = Element.prototype.requestFullscreen;
    window.__exits = [];
    window.__requestCalls = 0;
    document.exitFullscreen = function countedExit() {
      const entry = { state: 'pending' };
      window.__exits.push(entry);
      const promise = nativeExit.call(this);
      promise.then(() => { entry.state = 'resolved'; }, () => { entry.state = 'rejected'; });
      return promise;
    };
    card.requestFullscreen = function countedRequest(options) {
      window.__requestCalls += 1;
      return nativeRequest.call(this, options);
    };
  });
}

// In one task with user activation (a key press): the old fullscreen is
// released (by A's delivered cleanup or B's own open, in the given order),
// then B tries to enter, by a direct controller call and by its button.
async function overlapAttempt(page, ordering) {
  await page.evaluate((order) => {
    window.__attempt = null;
    window.addEventListener('keydown', async (event) => {
      if (event.code !== 'KeyQ') return;
      const viewer = window.__viewer();
      const logBefore = window.__fullscreenLog.length;
      const microtasks = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
      if (order === 'a-cleanup-first') {
        window.__deliverA();
        await microtasks();
        viewer.open(window.__source(), { opener: document.getElementById('test-opener') });
      } else {
        viewer.open(window.__source(), { opener: document.getElementById('test-opener') });
        window.__deliverA();
        await microtasks();
      }
      const button = document.querySelector('#unified-viewer-dialog [data-unified-viewer-fullscreen]');
      const exitsAtAttempt = window.__exits.map((entry) => entry.state);
      const atAttempt = {
        fullscreenElement: window.__describe(document.fullscreenElement),
        changesSince: window.__fullscreenLog.length - logBefore,
        exitStates: exitsAtAttempt,
        detail: viewer.fullscreen.getState(),
        ariaDisabled: button.getAttribute('aria-disabled'),
        buttonHidden: button.hidden,
        label: button.getAttribute('aria-label'),
      };
      const direct = viewer.fullscreen.enter();
      button.click();
      window.__attempt = {
        ...atAttempt,
        direct,
        requestCalls: window.__requestCalls,
        after: viewer.fullscreen.getState(),
        rootFullscreen: Boolean(document.querySelector('#unified-viewer-dialog [data-unified-viewer][data-viewer-fullscreen]')),
      };
    }, { capture: true, once: true });
  }, ordering);
  await page.keyboard.press('KeyQ');
  await expect.poll(() => page.evaluate(() => window.__attempt !== null)).toBe(true);
  return page.evaluate(() => window.__attempt);
}

// The old exit completes; the control becomes available with nothing queued.
async function expectOldExitSettled(page, label) {
  await expect.poll(() => page.evaluate(() => document.fullscreenElement), { message: label }).toBe(null);
  await expect.poll(() => page.evaluate(() => window.__viewer().fullscreen.getState().entryBlocked), { message: label }).toBe(false);
  await frames(page, 6);
  const settledState = await page.evaluate(() => {
    const button = document.querySelector('#unified-viewer-dialog [data-unified-viewer-fullscreen]');
    return {
      fullscreenElement: document.fullscreenElement,
      requestCalls: window.__requestCalls,
      exitStates: window.__exits.map((entry) => entry.state),
      ariaDisabled: button.getAttribute('aria-disabled'),
      label: button.getAttribute('aria-label'),
      detail: window.__viewer().fullscreen.getState(),
      exitInFlight: Symbol.for('creatorcrate.viewerFullscreenExit') in document.querySelector('[data-unified-viewer-card]'),
    };
  });
  expect(settledState, label).toMatchObject({
    fullscreenElement: null, requestCalls: 0, exitStates: ['resolved'],
    ariaDisabled: null, label: 'Enter fullscreen',
    detail: { active: false, pending: false, entryBlocked: false }, exitInFlight: false,
  });
}

// B enters by a fresh explicit click, keeps it, cannot be altered by A, and
// leaves and closes normally.
async function expectReplacementEntersAndKeeps(page, label) {
  await expect(page.locator(DIALOG)).toBeVisible();
  const logBefore = await page.evaluate(() => window.__fullscreenLog.length);
  await enterFullscreen(page);
  await expect.poll(() => page.evaluate(() => window.__viewer().fullscreen.getState().active)).toBe(true);
  await page.mouse.move(20, 20);
  // A's stale handle and stray events cannot alter B's fullscreen.
  const staleExit = await page.evaluate(() => {
    const result = window.__first.fullscreen.exit();
    document.dispatchEvent(new Event('fullscreenchange'));
    return result;
  });
  expect(staleExit, label).toBe(false);
  await frames(page, 8);
  const held = await page.evaluate(() => {
    const dialog = document.getElementById('unified-viewer-dialog');
    return {
      fullscreenElement: window.__describe(document.fullscreenElement),
      requestCalls: window.__requestCalls,
      exits: window.__exits.length,
      detail: window.__viewer().fullscreen.getState(),
      rootFullscreen: Boolean(dialog.querySelector('[data-unified-viewer][data-viewer-fullscreen]')),
      label: dialog.querySelector('[data-unified-viewer-fullscreen]').getAttribute('aria-label'),
    };
  });
  expect(held, label).toMatchObject({
    fullscreenElement: 'card', requestCalls: 1, exits: 1,
    detail: { active: true, pending: false, entryBlocked: false }, rootFullscreen: true, label: 'Exit fullscreen',
  });
  // B's entry (and the synthetic event above) only: the card never left.
  expect(await page.evaluate((from) => window.__fullscreenLog.slice(from), logBefore), label)
    .toEqual([{ element: 'card' }, { element: 'card' }]);

  // B stays functional: it navigates, then leaves fullscreen and closes normally.
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect.poll(() => page.evaluate(() => window.__viewer().getState().index)).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  expect(await page.evaluate(() => window.__exits.length), label).toBe(2);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await claimLeft(page), label).toBe(false);
  expect(await page.evaluate(() => Symbol.for('creatorcrate.viewerFullscreenExit')
    in document.querySelector('[data-unified-viewer-card]')), label).toBe(false);
}

test('F5: a replacement cannot enter fullscreen while the orphaned fullscreen\'s native exit is outstanding', async ({ page }) => {
  for (const ordering of ['a-cleanup-first', 'b-open-first']) {
    for (let round = 0; round < OVERLAP_REPEATS; round += 1) {
      const label = `${ordering} round ${round}`;
      await orphanedGrantWithReplacement(page, `${ordering}-${round}`);
      const attempt = await overlapAttempt(page, ordering);
      // The overlap really happened: the old exit was issued natively (once)
      // and was still outstanding when B tried.
      expect(attempt, label).toMatchObject({
        fullscreenElement: 'card', changesSince: 0, exitStates: ['pending'],
        detail: { active: false, pending: false, entryBlocked: true },
        ariaDisabled: 'true', buttonHidden: false,
        label: 'Enter fullscreen (unavailable while fullscreen closes)',
      });
      // Refused before the native API, by the direct call and the button alike.
      expect(attempt, label).toMatchObject({
        direct: false, requestCalls: 0,
        after: { active: false, pending: false, entryBlocked: true }, rootFullscreen: false,
      });
      await expectOldExitSettled(page, label);
      await expectReplacementEntersAndKeeps(page, label);
    }
  }
});

test('F5 control: a replacement that waits for the old exit enters and keeps fullscreen', async ({ page }) => {
  for (let round = 0; round < OVERLAP_REPEATS; round += 1) {
    const label = `control round ${round}`;
    await orphanedGrantWithReplacement(page, `control-${round}`);
    await page.evaluate(() => window.__deliverA());
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
    await expect.poll(() => page.evaluate(() => window.__exits.map((entry) => entry.state))).toEqual(['resolved']);
    await openViewer(page);
    expect(await page.evaluate(() => window.__viewer().fullscreen.getState()), label)
      .toMatchObject({ active: false, pending: false, entryBlocked: false });
    await expectOldExitSettled(page, label);
    await expectReplacementEntersAndKeeps(page, label);
  }
});

// A different native fullscreen target is not evidence that an earlier exit
// completed. Hold only completion delivery; invoke every native operation
// immediately and record the underlying promise state separately.
test('F6: another fullscreen element cannot release a pending native exit guard', async ({ page }) => {
  for (let round = 0; round < OVERLAP_REPEATS; round += 1) {
    const label = `F6 round ${round}`;
    await orphanedGrantWithReplacement(page, `f6-${round}`);
    await page.evaluate(() => {
      const nativeExit = Document.prototype.exitFullscreen;
      document.exitFullscreen = function gatedExit() {
        const entry = { state: 'pending', delivered: false };
        window.__exits.push(entry);
        const native = nativeExit.call(this);
        native.then(() => { entry.state = 'resolved'; }, () => { entry.state = 'rejected'; });
        if (window.__exits.length !== 1) return native;
        return new Promise((resolve, reject) => {
          window.__deliverExit = () => {
            entry.delivered = true;
            native.then(resolve, reject);
          };
        });
      };
      window.__f6Attempt = null;
      window.addEventListener('keydown', async (event) => {
        if (event.code !== 'KeyQ') return;
        window.__deliverA();
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
        const atIssue = window.__exits.map((entry) => ({ ...entry }));
        await document.documentElement.requestFullscreen();
        const viewer = window.__viewer();
        viewer.open(window.__source(), { opener: document.getElementById('test-opener') });
        const card = document.querySelector('[data-unified-viewer-card]');
        const button = card.querySelector('[data-unified-viewer-fullscreen]');
        const claim = card[Symbol.for('creatorcrate.viewerFullscreenClaim')];
        const detail = viewer.fullscreen.getState();
        const direct = viewer.fullscreen.enter();
        const toggle = viewer.fullscreen.toggle();
        button.click();
        window.__f6Attempt = {
          atIssue,
          native: window.__exits.map((entry) => ({ ...entry })),
          element: window.__describe(document.fullscreenElement),
          detail, direct, toggle,
          requestCalls: window.__requestCalls,
          exitInFlight: Symbol.for('creatorcrate.viewerFullscreenExit') in card,
          claimUnchanged: card[Symbol.for('creatorcrate.viewerFullscreenClaim')] === claim,
          ariaDisabled: button.getAttribute('aria-disabled'),
          label: button.getAttribute('aria-label'),
        };
      }, { once: true, capture: true });
    });
    await page.keyboard.press('KeyQ');
    await expect.poll(() => page.evaluate(() => window.__f6Attempt !== null)).toBe(true);
    const attempt = await page.evaluate(() => window.__f6Attempt);
    expect(attempt, label).toMatchObject({
      atIssue: [{ state: 'pending', delivered: false }],
      native: [{ state: 'pending', delivered: false }],
      element: 'html', detail: { active: false, pending: false, entryBlocked: true },
      direct: false, toggle: false, requestCalls: 0, exitInFlight: true, claimUnchanged: true,
      ariaDisabled: 'true', label: 'Enter fullscreen (unavailable while fullscreen closes)',
    });
    // Release completion delivery while the issued native exit is outstanding.
    await page.evaluate(() => window.__deliverExit());
    await expectOldExitSettled(page, label);
    await expectReplacementEntersAndKeeps(page, label);
  }
});
