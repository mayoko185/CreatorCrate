import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createAssetRepository } from '../../src/data/asset-repository.js';
import { createAppMetaRepository } from '../../src/data/app-meta-repository.js';
import { createTagRepository } from '../../src/data/tag-repository.js';
import { createReleaseService } from '../../src/services/release-service.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createComicRuntime } from '../../src/services/comic-runtime.js';
import { makeZip } from '../helpers/zip-fixture.js';

const ROOT = '[data-comic-thumbnail]';
const IMAGE = '[data-preview-image]';
const DIALOG = '#unified-viewer-dialog';
const hosts = ['project', 'library', 'details', 'manage', 'release'];
const evidence = process.env.CC_C_EVIDENCE;
const results = { hosts: {}, cleanup: {} };
if (evidence) fs.mkdirSync(path.join(evidence, 'screenshots'), { recursive: true });
test.setTimeout(45000);
let fixture;
let serial = 0;

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-thumbnail-hosts-'));
  let db; let runtime; let server; let app;
  const documentGates = new Map();
  const previewRefusals = new Map();
  const documentStyles = new Map();
  const previewRequests = [];
  const close = async () => {
    try {
      for (const gate of documentGates.values()) gate.release();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    } finally {
      try {
        app?.locals.comicMediaService?.stop();
        await app?.locals.comicMediaService?.pauseForMaintenance().waitForIdle();
        for (const owner of [app?.locals.generatedImageRebuildService, app?.locals.generatedImagePublicationLifecycle]) { owner?.stop(); await owner?.waitForIdle(); }
        await runtime?.close();
      } finally {
        if (db) closeDatabase(db);
        if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unsafe fixture cleanup');
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
        results.cleanup = { root, removed: !fs.existsSync(root), runtimeClosed: true, databaseClosed: true, serverClosed: true };
        if (evidence) fs.writeFileSync(path.join(evidence, 'browser-results.json'), JSON.stringify(results, null, 2));
      }
    }
  };
  fixture = { close };
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const previewRoot = path.join(appDataRoot, 'previews');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(previewRoot, { recursive: true });
  // A second compiled entry exposes the same module instances as the real bundle.
  const bridge = path.join(root, 'bridge.js');
  const source = fileURLToPath(new URL('../../src/static/client/', import.meta.url)).replaceAll('\\', '/');
  fs.writeFileSync(bridge, `export * from '${source}asset-viewer-refresh.js';\nexport * from '${source}preview.js';`);
  await build({ build: { outDir: viteDistRoot, rolldownOptions: { preserveEntrySignatures: 'strict', input: {
    main: fileURLToPath(new URL('../../client/main.js', import.meta.url)), bridge,
  } } }, logLevel: 'silent' });
  const built = JSON.parse(fs.readFileSync(path.join(viteDistRoot, '.vite/manifest.json')));
  const bridgeKey = Object.keys(built).find(key => built[key].name === 'bridge');
  built['test-bridge.js'] = { ...built[bridgeKey], src: 'test-bridge.js' };
  delete built[bridgeKey];
  const keys = Object.fromEntries(Object.keys(built).map(key => [key, /^[A-Za-z]:/.test(key) ? 'test-dependency/' + createHash('sha256').update(key).digest('hex').slice(0, 16) + '.js' : key]));
  const normalized = {};
  for (const [key, value] of Object.entries(built)) {
    const entry = { ...value };
    if (entry.src && keys[entry.src]) entry.src = keys[entry.src];
    for (const field of ['imports', 'dynamicImports']) if (entry[field]) entry[field] = entry[field].map(k => keys[k] || k);
    normalized[keys[key]] = entry;
  }
  fs.writeFileSync(path.join(viteDistRoot, '.vite/manifest.json'), JSON.stringify(normalized));
  const compiled = fs.readdirSync(path.join(viteDistRoot, 'assets')).filter(name => name.endsWith('.js'))
    .map(name => fs.readFileSync(path.join(viteDistRoot, 'assets', name), 'utf8')).join('\n');
  expect(compiled).not.toMatch(/enhanceComicThumbnails|data-comic-thumbnail|comicThumbnailState/);
  const bridgeURL = '/vite/' + Object.values(built).find(entry => entry.isEntry && entry.name === 'bridge').file;
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  runtime = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 } });
  await runtime.start();
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, comicRuntime: runtime,
    startGeneratedImageRebuild: false, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot, manifestPath: path.join(viteDistRoot, '.vite/manifest.json') }),
  });
  app.locals.generatedImagePublicationLifecycle.prepare();
  app.locals.generatedImagePublicationLifecycle.signal();
  await app.locals.generatedImagePublicationLifecycle.waitForIdle();
  const repo = createAssetRepository(db);
  const releases = createReleaseService({ db });
  const cover = await sharp({ create: { width: 48, height: 96, channels: 3, background: '#cf1973' } }).png().toBuffer();
  const other = await sharp({ create: { width: 96, height: 48, channels: 3, background: '#1ba339' } }).png().toBuffer();
  const sevenZip = await createRequire(import.meta.url)('7z-wasm')({ print() {}, printErr() {} });
  sevenZip.FS.writeFile('/cover.png', cover);
  sevenZip.callMain(['a', '-t7z', '/book.7z', '/cover.png']);
  const cb7 = Buffer.from(sevenZip.FS.readFile('/book.7z'));
  const cbr = fs.readFileSync(fileURLToPath(new URL('../fixtures/comic-archives/comic-rar5-solid.cbr', import.meta.url)));
  // Delay only the selected document on the server; browser Fetch routing can strand startup scripts.
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/test/cover-deferral.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end([...documentStyles.values()].join('\n'));
      return;
    }
    if (/\/assets\/\d+\/preview$/.test(pathname)) {
      const record = { url: req.url, status: null }; previewRequests.push(record);
      res.once('finish', () => { record.status = res.statusCode; });
      const refusal = previewRefusals.get(pathname);
      if (refusal) { res.writeHead(refusal, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' }); res.end('Unavailable Preview'); return; }
    }
    const current = new URL(req.url, 'http://127.0.0.1');
    const style = [...documentStyles].find(([destination]) => {
      const expected = new URL(destination, 'http://127.0.0.1');
      return expected.pathname === current.pathname
        && ['project', 'view'].every(key => expected.searchParams.get(key) === current.searchParams.get(key));
    })?.[1];
    if (style) {
      const write = res.write.bind(res), end = res.end.bind(res); let html = '';
      res.write = chunk => { html += chunk.toString(); return true; };
      res.end = chunk => { if (chunk) html += chunk.toString(); res.removeHeader('content-length'); write(html.replace('</head>', '<link rel="stylesheet" href="/test/cover-deferral.css"></head>')); end(); };
    }
    const gate = documentGates.get(req.url);
    if (!gate) return app(req, res);
    gate.entered = true;
    gate.promise.then(() => { if (!res.destroyed) app(req, res); });
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(baseURL + '/health', { signal: AbortSignal.timeout(15000) });
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok', database: 'ok' });
  fixture = { root, db, app, repo, releases, cover, other, cb7, cbr, bridgeURL,
    baseURL,
    previewRequests,
    refusePreview(f, status) { previewRefusals.set('/projects/' + f.project.id + '/assets/' + f.comic + '/preview', status); },
    styleDocument(destination, css) { documentStyles.set(destination, css); },
    pendingDocuments: () => documentGates.size,
    holdDocument(destination) {
      const { pathname, search } = new URL(destination);
      const key = pathname + search;
      expect(documentGates.has(key)).toBe(false);
      let release;
      const gate = { entered: false, promise: new Promise(resolve => { release = resolve; }),
        release() { documentGates.delete(key); release(); } };
      documentGates.set(key, gate);
      return gate;
    },
    create() {
      const project = app.locals.projectService.create({ title: `Thumbnail Host ${++serial}`, status: 'tbd', projectType: 'images' });
      const dir = path.join(projectsRoot, project.project_dir);
      function write(filename, bytes) {
        fs.writeFileSync(path.join(dir, filename), bytes);
        const stat = fs.statSync(path.join(dir, filename));
        return repo.upsert(project.id, filename, { filename, extension: filename.split('.').pop(),
          mimeType: { png: 'image/png', mp4: 'video/mp4', cbz: 'application/vnd.comicbook+zip',
            cbr: 'application/vnd.comicbook-rar', cb7: 'application/x-cb7' }[filename.split('.').pop()],
          sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() }).id;
      }
      const comic = write('a-book.cbz', makeZip([{ name: '001.png', data: cover }, { name: '002.png', data: other }]));
      const rar = write('b-book.cbr', cbr);
      const seven = write('c-book.cb7', cb7);
      const picture = write('picture.png', cover);
      const video = write('video.mp4', Buffer.from('video classification fixture'));
      const extra = write('z-later.cbz', makeZip([{ name: '001.png', data: other }]));
      const release = releases.createReleaseWithSelectedAssets(project.id, { title: 'Thumbnail Release' }, [seven, comic, rar, picture, video]);
      return { project, dir, write, comic, rar, seven, picture, video, extra, release,
        rewrite(format = 'cbz') {
          const filename = `a-book.${format}`;
          const bytes = format === 'cbr' ? cbr : makeZip([{ name: 'replacement.png', data: other }]);
          fs.writeFileSync(path.join(dir, filename), bytes);
          const later = new Date(Date.now() + 60000);
          fs.utimesSync(path.join(dir, filename), later, later);
          const stat = fs.statSync(path.join(dir, filename));
          db.prepare('UPDATE assets SET filename = ?, relative_path = ?, extension = ?, mime_type = ?, size_bytes = ?, modified_at = ?, source_generation = source_generation + 1 WHERE id = ?')
            .run(filename, filename, format, format === 'cbr' ? 'application/vnd.comicbook-rar' : 'application/vnd.comicbook+zip', stat.size, stat.mtime.toISOString(), comic);
        },
      };
    },
    close,
  };
});
test.afterEach(() => { expect(fixture?.pendingDocuments()).toBe(0); });
test.afterAll(async ({ browser }) => {
  try { expect(browser.contexts()).toHaveLength(0); }
  finally { await fixture?.close(); }
});

function url(host, f, view = 'grid') {
  const query = `view=${view}&sort=filename&order=asc&pageSize=all`;
  return {
    project: `/projects/${f.project.id}/assets?${query}`,
    library: `/asset-viewer?${query}&project=${f.project.id}`,
    details: `/projects/${f.project.id}/assets/${f.comic}`,
    manage: `/releases/${f.release.id}/assets?${query}&selection=all`,
    release: `/releases/${f.release.id}?${query}`,
  }[host];
}
function link(page, f, id = f.comic) {
  return page.locator(`a[data-comic-project="${f.project.id}"][data-comic-asset="${id}"]:visible`);
}
async function open(page, host, f, view = 'grid', nextURL = null) {
  const requests = [];
  const errors = [];
  page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.baseURL + (nextURL || url(host, f, view)));
  await page.waitForFunction(() => Boolean(document.querySelector('#unified-viewer-dialog')?.__creatorCrateUnifiedViewer), null, { timeout: 15000 });
  await page.evaluate(() => { window.sameDocument = true; });
  return { requests, errors };
}
const media = opener => opener.locator('xpath=ancestor::*[@data-preview-enhancement][1]');
const frame = (page, f, id = f.comic) => media(page.locator('a[data-comic-project="' + f.project.id + '"][data-comic-asset="' + id + '"]').first());
const image = (page, f, id = f.comic) => frame(page, f, id).locator(IMAGE);
async function loaded(opener) {
  await opener.scrollIntoViewIfNeeded();
  await expect(media(opener)).toHaveAttribute('data-preview-state', 'loaded');
  await expect(media(opener).locator(IMAGE)).toBeVisible();
  expect(await media(opener).locator(IMAGE).evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
}
async function refresh(page, host, f, nextURL = null) {
  if (host === 'details') {
    return page.evaluate(async bridgeURL => {
      const module = await import(bridgeURL);
      return (await module.refreshAssetViewer(document, { regions: ['file'] })).status;
    }, fixture.bridgeURL);
  }
  if (host === 'release') {
    await page.locator('[data-release-detail-region="heading"]').evaluate(el => { el.dataset.refreshMarker = 'true'; });
    await page.evaluate(id => document.dispatchEvent(new CustomEvent('release-edit-saved', { detail: { releaseId: id } })), f.release.id);
    await expect(page.locator('[data-release-detail-region="heading"][data-refresh-marker]')).toHaveCount(0);
  } else {
    const selector = { project: '[data-project-assets-live-region]', library: '[data-asset-library-live-region]', manage: '[data-release-assets-live-region]' }[host];
    await page.locator(selector).evaluate(el => { el.dataset.refreshMarker = 'true'; });
    await page.evaluate(({ nextURL, host }) => {
      const state = { [host === 'manage' ? 'releaseAssets' : host === 'project' ? 'projectAssets' : 'assetLibrary']: true };
      if (nextURL) history.replaceState(state, '', nextURL);
      dispatchEvent(new PopStateEvent('popstate', { state }));
    }, { nextURL, host });
    await expect(page.locator(`${selector}[data-refresh-marker]`)).toHaveCount(0);
    await expect(page.locator(selector)).not.toHaveAttribute('aria-busy', 'true');
  }
  expect(await page.evaluate(() => window.sameDocument)).toBe(true);
}
async function descriptor(opener) {
  return opener.evaluate(el => ({ projectId: Number(el.dataset.comicProject), assetId: Number(el.dataset.comicAsset),
    format: el.dataset.comicFilename.split('.').pop().toLowerCase(), sourceRevision: el.dataset.comicSourceRevision,
    url: el.closest('[data-preview-enhancement]').querySelector('[data-preview-image]').getAttribute('src') }));
}
const membership = page => page.locator('input[name="selectedAssetIds"]').evaluateAll(inputs => [...new Set(inputs.filter(el => el.type === 'hidden' || el.checked).map(el => el.value))].sort());

async function controlClickDetails(page, opener, f, timeout = 15000) {
  const context = page.context();
  const pages = context.pages();
  const listeners = [page.listenerCount('popup'), context.listenerCount('page'), context.listenerCount('response')];
  const sourceURL = page.url();
  const destination = new URL(await opener.getAttribute('href'), sourceURL);
  expect(destination.pathname).toBe(`/projects/${f.project.id}/assets/${f.comic}`);
  const filename = await opener.getAttribute('data-comic-filename');
  const created = [];
  const onPage = popup => created.push(popup);
  context.on('page', onPage);
  await opener.evaluate(anchor => {
    const observe = event => {
      window.detailsClick.observed = { trusted: event.isTrusted, control: event.ctrlKey, button: event.button, href: anchor.href };
    };
    window.detailsClick = { anchor, observe, observed: null };
    anchor.addEventListener('click', observe, { once: true, capture: true });
  });
  // Native Control-click tabs have no opener; watch this isolated context before clicking.
  // Popup creation and its initial blank load do not establish destination readiness.
  const popupPromise = context.waitForEvent('page', { timeout });
  popupPromise.catch(() => {});
  try {
    const hit = await opener.boundingBox();
    await opener.click({ modifiers: ['Control'], position: { x: hit.width - 12, y: hit.height - 12 }, timeout });
    const popup = await popupPromise;
    expect(await page.evaluate(() => window.detailsClick?.observed), 'A trusted Control-click must reach the actual card link')
      .toEqual({ trusted: true, control: true, button: 0, href: destination.href });
    await expect(popup).toHaveURL(destination.href, { timeout });
    await popup.waitForLoadState('domcontentloaded', { timeout });
    // Initial native-tab responses can precede Playwright's Page publication.
    const response = await popup.evaluate(() => ({
      url: document.URL, type: document.contentType,
      status: performance.getEntriesByType('navigation')[0]?.responseStatus,
    }));
    expect(response.url).toBe(destination.href);
    expect(response.status, 'The popup destination must return HTTP 200').toBe(200);
    expect(response.type).toBe('text/html');
    const host = popup.locator('[data-asset-viewer-host]');
    await expect(host).toHaveAttribute('data-asset-viewer-project-id', String(f.project.id), { timeout });
    await expect(host).toHaveAttribute('data-asset-viewer-asset-id', String(f.comic), { timeout });
    await expect(popup.locator('[data-asset-viewer-region="file-summary"]')).toHaveAttribute('data-asset-filename', filename, { timeout });
    const reader = link(popup, f);
    await expect(reader).toHaveAttribute('data-comic-project-name', f.project.title, { timeout });
    await popup.waitForFunction(() => Boolean(document.querySelector('#unified-viewer-dialog')?.__creatorCrateUnifiedViewer), null, { timeout });
    await reader.focus(); await popup.keyboard.press('Enter');
    await expect(popup.locator(DIALOG)).toBeVisible({ timeout });
    const image = popup.locator(`${DIALOG} .unified-viewer-page-image`).first();
    await expect(image).toBeVisible({ timeout });
    expect(await image.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await popup.keyboard.press('Escape');
    await expect(popup.locator(DIALOG)).toBeHidden({ timeout });
    expect(created).toEqual([popup]);
    await expect(page).toHaveURL(sourceURL, { timeout });
    expect(await page.evaluate(() => window.sameDocument)).toBe(true);
    await expect(page.locator(DIALOG)).toBeHidden({ timeout });
    return { url: popup.url(), status: response.status };
  } finally {
    await popupPromise.catch(() => {});
    context.off('page', onPage);
    await Promise.all(created.map(popup => popup.close()));
    await page.evaluate(() => {
      const click = window.detailsClick;
      click?.anchor.removeEventListener('click', click.observe, true);
      delete window.detailsClick;
    });
    expect(context.pages()).toEqual(pages);
    expect([page.listenerCount('popup'), context.listenerCount('page'), context.listenerCount('response')]).toEqual(listeners);
  }
}

async function interceptControlClick(opener, action, destination = null) {
  await opener.evaluate((anchor, { action, destination }) => {
    anchor.addEventListener('click', event => {
      if (!event.ctrlKey || event.button !== 0) return;
      event.preventDefault();
      if (action === 'blank') window.pendingDetailsPopup = window.open('about:blank');
      else if (action === 'destination') window.open(destination);
      else if (action === 'opener') location.assign(anchor.href);
    }, { once: true });
  }, { action, destination });
}

test.describe('Control-click destination synchronization', () => {
  test('immediate valid navigation remains usable and repeated clicks clean up pages and listeners', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    for (let index = 0; index < 3; index++) {
      const result = await controlClickDetails(page, link(page, f), f);
      expect(result).toEqual({ url: new URL(await link(page, f).getAttribute('href'), page.url()).href, status: 200 });
    }
  });

  test('a loaded about:blank popup waits for gated valid navigation', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    await interceptControlClick(link(page, f), 'blank');
    let settled = false;
    const completion = controlClickDetails(page, link(page, f), f);
    completion.then(() => { settled = true; }, () => { settled = true; });
    await expect.poll(() => page.context().pages().length).toBe(2).catch(async error => {
      await completion;
      throw error;
    });
    const popup = page.context().pages().find(candidate => candidate !== page);
    await popup.waitForLoadState();
    expect(popup.url()).toBe('about:blank');
    // A browser round trip proves the destination check is active before releasing navigation.
    await popup.evaluate(() => document.readyState);
    expect(settled).toBe(false);
    await page.evaluate(() => { window.pendingDetailsPopup.location.href = document.querySelector('a[data-comic-asset]').href; });
    expect((await completion).status).toBe(200);
  });

  test('native Control-click waits for a gated destination response', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    const destination = new URL(await link(page, f).getAttribute('href'), page.url()).href;
    const gate = fixture.holdDocument(destination);
    let settled = false;
    const completion = controlClickDetails(page, link(page, f), f);
    completion.then(() => { settled = true; }, () => { settled = true; });
    try {
      await expect.poll(() => gate.entered).toBe(true);
      expect(settled).toBe(false);
      expect(fixture.repo.findById(f.comic).is_present).toBe(1);
      expect(fs.existsSync(path.join(f.dir, 'a-book.cbz'))).toBe(true);
      gate.release();
      expect((await completion).status).toBe(200);
    } finally { gate.release(); await completion.catch(() => {}); }
  });

  test('rejects a popup that stays on about:blank', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    await interceptControlClick(link(page, f), 'blank');
    await expect(controlClickDetails(page, link(page, f), f, 1000)).rejects.toThrow(/toHaveURL/);
  });

  test('rejects a popup closed before destination readiness', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    await interceptControlClick(link(page, f), 'blank');
    const completion = controlClickDetails(page, link(page, f), f, 1000);
    const rejection = expect(completion).rejects.toThrow(/toHaveURL|closed/);
    await expect.poll(() => page.context().pages().length).toBe(2);
    await page.context().pages().find(candidate => candidate !== page).close();
    await rejection;
  });

  test('rejects HTTP 200 with an unrendered destination document', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    const destination = new URL(await link(page, f).getAttribute('href'), page.url()).href;
    await page.context().route(destination, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await interceptControlClick(link(page, f), 'destination', destination);
    await expect(controlClickDetails(page, link(page, f), f, 1000)).rejects.toThrow(/toHaveAttribute/);
  });

  test('rejects blocked startup and releases the owned script gate after failed navigation', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    const gate = fixture.holdDocument(fixture.baseURL + '/shell-navigation-continuity.js');
    const completion = controlClickDetails(page, link(page, f), f, 5000);
    const rejection = expect(completion).rejects.toThrow(/waitForLoadState/);
    try {
      await expect.poll(() => gate.entered).toBe(true);
      await rejection;
    } finally { gate.release(); await completion.catch(() => {}); }
    expect(fixture.pendingDocuments()).toBe(0);
  });

  for (const action of ['none', 'opener']) {
    test(`rejects ${action === 'none' ? 'suppressed popup creation' : 'navigation of the source page instead of a new tab'}`, async ({ page }) => {
      const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
      await interceptControlClick(link(page, f), action);
      await expect(controlClickDetails(page, link(page, f), f, 1000)).rejects.toThrow(/waiting for event "page"/);
    });
  }

  test('rejects a wrong destination URL even when its HTML has the expected asset identity', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    const destination = new URL(await link(page, f).getAttribute('href'), page.url()).href;
    const wrong = fixture.baseURL + '/wrong-details';
    const response = await page.request.get(destination);
    expect(response.status()).toBe(200);
    await page.context().route(wrong, route => route.fulfill({ response }));
    await interceptControlClick(link(page, f), 'destination', wrong);
    await expect(controlClickDetails(page, link(page, f), f, 1000)).rejects.toThrow(/toHaveURL/);
  });

  test('rejects a genuine missing-page HTTP 404 at the expected destination', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    const destination = new URL(await link(page, f).getAttribute('href'), page.url()).href;
    const missing = await page.request.get(fixture.baseURL + '/projects/2147483647/assets/2147483647');
    expect(missing.status()).toBe(404);
    await page.context().route(destination, route => route.fulfill({ response: missing }));
    await interceptControlClick(link(page, f), 'destination', destination);
    await expect(controlClickDetails(page, link(page, f), f, 1000)).rejects.toThrow(/must return HTTP 200/);
  });

  for (const identity of ['project', 'asset']) {
    test(`rejects the right URL with a wrong ${identity} identity`, async ({ page }) => {
      const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
      const destination = new URL(await link(page, f).getAttribute('href'), page.url()).href;
      const response = await page.request.get(destination);
      expect(response.status()).toBe(200);
      const html = (await response.text()).replace(`data-asset-viewer-${identity}-id="${identity === 'project' ? f.project.id : f.comic}"`, `data-asset-viewer-${identity}-id="2147483647"`);
      await page.context().route(destination, route => route.fulfill({ response, body: html }));
      await interceptControlClick(link(page, f), 'destination', destination);
      await expect(controlClickDetails(page, link(page, f), f, 5000)).rejects.toThrow(/toHaveAttribute/);
    });
  }

  test('rejects a destination whose Reader never initializes', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    const destination = new URL(await link(page, f).getAttribute('href'), page.url()).href;
    const response = await page.request.get(destination);
    expect(response.status()).toBe(200);
    const body = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    await page.context().route(destination, route => route.fulfill({ response, body }));
    await interceptControlClick(link(page, f), 'destination', destination);
    await expect(controlClickDetails(page, link(page, f), f, 5000)).rejects.toThrow(/waitForFunction/);
  });

  test('rejects unrelated extra pages and cleans up both pages', async ({ page }) => {
    const f = fixture.create(); await open(page, 'library', f); await loaded(link(page, f));
    await interceptControlClick(link(page, f), 'blank');
    const completion = controlClickDetails(page, link(page, f), f);
    const rejection = expect(completion).rejects.toThrow(/toEqual/);
    await expect.poll(() => page.context().pages().length).toBe(2);
    await page.context().newPage();
    await page.evaluate(() => { window.pendingDetailsPopup.location.href = document.querySelector('a[data-comic-asset]').href; });
    await rejection;
  });
});

async function projectStyle(page, value) {
  // WP7: Grid style is a default in Filters & Defaults, applied by Save.
  await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
  const dialog = page.locator('#project-assets-filter-dialog');
  await dialog.locator('[data-dialog-field="gridStyle"] summary').click();
  await dialog.locator('[data-dialog-field="gridStyle"] .asset-filter-multiselect-panel')
    .getByText(value === 'cropped' ? 'Cropped' : 'Uncropped', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
  await expect(page.locator('.asset-grid')).toHaveAttribute('data-grid-style', value);
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
}

test('Project Assets: all formats, filtered sorting, selection, style changes and archived restrictions', async ({ page }) => {
  const f = fixture.create();
  await open(page, 'project', f);
  for (const [id, format] of [[f.comic, 'cbz'], [f.rar, 'cbr'], [f.seven, 'cb7']]) {
    await loaded(link(page, f, id)); expect((await descriptor(link(page, f, id))).format).toBe(format);
  }
  const checkbox = page.locator(`input[type="checkbox"][value="${f.comic}"]`).first();
  await checkbox.check();
  const before = await checkbox.isChecked();
  await projectStyle(page, 'cropped');
  expect(await link(page, f).locator(IMAGE).evaluate(el => getComputedStyle(el).objectFit)).toBe('cover');
  await expect(checkbox).toBeChecked();
  await projectStyle(page, 'uncropped');
  await refresh(page, 'project', f, url('project', f, 'list') + '&search=a-book');
  await loaded(link(page, f));
  expect((await descriptor(link(page, f))).assetId).toBe(f.comic);
  expect(before).toBe(true);
  fixture.db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(f.project.id);
  await page.goto(fixture.baseURL + url('project', f));
  await loaded(link(page, f));
  await expect(page.locator('[data-auto-rename-submit]')).toHaveCount(0);
  await expect(page.locator('[data-project-assets-viewer-sequence]')).not.toContainText('a-book.cbz');
});

test('Project Assets: selection across Grid/List refresh (accepted baseline limitation)', async ({ page }) => {
  test.fail(true, 'The accepted baseline loses selection across a Grid/List region replacement.');
  const f = fixture.create(); await open(page, 'project', f); await loaded(link(page, f));
  await page.locator(`#asset-card-select-${f.comic}`).check();
  await refresh(page, 'project', f, url('project', f, 'list'));
  await expect(page.locator(`#asset-list-card-select-${f.comic}`)).toBeChecked();
});

test('Project Assets: comic loading and style/filter refresh preserve a pending category order', async ({ page }) => {
  const f = fixture.create();
  const categories = fixture.app.locals.projectAssetCategoryService;
  if (!categories.list(f.project.id).some(row => row.directory_slug === 'wip')) {
    categories.add(f.project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const category = categories.list(f.project.id).find(row => row.directory_slug === 'wip');
  const dir = path.join(f.dir, 'wip'); fs.mkdirSync(dir, { recursive: true });
  for (const id of [f.comic, f.rar, f.seven, f.picture, f.video, f.extra]) {
    const row = fixture.repo.findById(id);
    fs.renameSync(path.join(f.dir, row.relative_path), path.join(dir, row.filename));
    fixture.db.prepare('UPDATE assets SET relative_path = ?, category_id = ? WHERE id = ?').run(`wip/${row.filename}`, category.id, id);
  }
  await open(page, 'project', f);
  // Replacing an unfinished cover interest can retain native admission until retirement.
  await loaded(link(page, f));
  await refresh(page, 'project', f, url('project', f) + `&category=${category.id}`);
  const item = page.locator(`[data-auto-rename-asset-id="${f.comic}"]`);
  await item.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
  const draft = await page.locator('[data-auto-rename-order-input]').inputValue();
  expect(JSON.parse(draft)[0]).toBe(f.rar);
  await loaded(link(page, f));
  expect(await page.locator('[data-auto-rename-order-input]').inputValue()).toBe(draft);
  await projectStyle(page, 'cropped');
  expect(await page.locator('[data-auto-rename-order-input]').inputValue()).toBe(draft);
  await refresh(page, 'project', f, url('project', f, 'list') + `&category=${category.id}&search=book`);
  expect(await page.locator('[data-auto-rename-order-input]').inputValue()).toBe(draft);
});

test('Project Assets: cover completion preserves selected assets in a filtered subset', async ({ page }) => {
  const f = fixture.create(); let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  await page.route(`**/assets/${f.comic}/preview*`, async route => { entered(); await gate; await route.continue().catch(() => {}); });
  try {
    await open(page, 'project', f);
    await refresh(page, 'project', f, url('project', f) + '&search=a-book');
    await started;
    const selected = page.locator(`#asset-card-select-${f.comic}`);
    await selected.check();
    expect(await page.locator('input[name="selectedAssetIds"][type="checkbox"]').count()).toBeLessThan(6);
    release(); await loaded(link(page, f));
    await expect(selected).toBeChecked();
    await expect(page.locator(DIALOG)).toBeHidden();
  } finally { release(); }
});

for (const [view, style] of [['grid', 'uncropped'], ['grid', 'cropped'], ['list', 'uncropped']]) {
  for (const status of [404, 503]) {
    test(`Project Assets: ${view}/${style} Preview ${status} retains Reader activation, refresh focus and recovery`, async ({ page }) => {
      const f = fixture.create();
      createAppMetaRepository(fixture.db).setValue('page_defaults.project_assets.grid_style', style);
      const route = `**/assets/${f.comic}/preview*`;
      await page.route(route, request => request.fulfill({ status, contentType: 'text/plain', body: 'Controlled Preview failure' }));
      await open(page, 'project', f, view);
      const card = page.locator(`article[data-asset-id="${f.comic}"]`);
      const fallback = card.locator('a[data-preview-fallback]');
      await expect(fallback).toBeVisible();
      await expect(fallback).toHaveAccessibleName(/^Read comic a-book\.cbz/);
      await fallback.focus(); await page.keyboard.press('Enter');
      await expect(page.locator(`${DIALOG} .unified-viewer-page-image`).first()).toBeVisible();
      await refresh(page, 'project', f);
      await page.keyboard.press('Escape');
      await expect(fallback).toBeFocused();
      await fallback.click();
      await expect(page.locator(`${DIALOG} .unified-viewer-page-image`).first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(fallback).toBeFocused();
      await page.unroute(route);
      const reused = await card.locator('[data-preview-enhancement]').first().evaluate(async root => {
        const image = root.querySelector('[data-preview-image]');
        const primary = image.closest('a');
        root.dataset.previewState = 'loading';
        const source = new URL(image.src);
        source.searchParams.set('v', 'replacement-source-hint');
        image.src = source.href;
        await image.decode();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { loaded: root.dataset.previewState, primaryHidden: primary.hidden,
          fallbackHidden: root.querySelector('[data-preview-fallback]').hidden };
      });
      expect(reused).toEqual({ loaded: 'loaded', primaryHidden: false, fallbackHidden: true });
      await refresh(page, 'project', f);
      await loaded(link(page, f));
      await expect(fallback).toBeHidden();
      await link(page, f).click();
      await expect(page.locator(`${DIALOG} .unified-viewer-page-image`).first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(link(page, f)).toBeFocused();
    });
  }
}

test('Release Manage Assets: pending hidden membership, role/order and selection stay separate from preview', async ({ page }) => {
  const f = fixture.create();
  const saved = fixture.db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order').all(f.release.id);
  const control = await open(page, 'manage', f);
  await loaded(link(page, f));
  const checkbox = id => page.locator(`#release-asset-select-${id}`);
  await checkbox(f.extra).check(); await checkbox(f.comic).uncheck();
  await expect(page.locator(DIALOG)).toBeHidden();
  const draft = await membership(page);
  await link(page, f).click(); await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape'); expect(await membership(page)).toEqual(draft);
  await page.locator('[data-asset-grid-style-control]').selectOption('cropped', { force: true });
  expect(await membership(page)).toEqual(draft);
  await refresh(page, 'manage', f, url('manage', f, 'list') + '&search=picture');
  expect(await membership(page)).toEqual(draft);
  await refresh(page, 'manage', f, url('manage', f, 'grid'));
  await expect(checkbox(f.extra)).toBeChecked(); await expect(checkbox(f.comic)).not.toBeChecked();
  expect(await membership(page)).toEqual(draft);
  expect(fixture.db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order').all(f.release.id)).toEqual(saved);
  expect(control.requests.filter(req => req.method !== 'GET')).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('generated CBZ uses the shared host contract; ordinary images/videos and Project Detail stay unchanged', async ({ page }) => {
  const f = fixture.create();
  const generated = await fixture.app.locals.assetProcessingService.createArchives(f.project.id, [f.picture], {
    archives: [{ archiveFormat: 'cbz', imageFormat: 'webp', baseName: 'generated' }],
  });
  expect(generated.status).toBe('completed');
  await fixture.app.locals.assetScanner.scanProjectAssets(f.project.id, { kind: 'manual' });
  const row = fixture.repo.findByProjectIdAndPath(f.project.id, generated.generatedPaths[0]);
  expect(row.extension).toBe('cbz');
  await open(page, 'project', f); await loaded(link(page, f, row.id));
  expect((await descriptor(link(page, f, row.id))).assetId).toBe(row.id);
  const ordinary = page.locator(`article[data-asset-id="${f.picture}"]`);
  await expect(ordinary.locator('[data-preview-image]')).toHaveAttribute('src', /\/preview\?v=/);
  await expect(ordinary.locator(ROOT)).toHaveCount(0);
  await page.goto(fixture.baseURL + `/projects/${f.project.id}/assets/${f.video}`);
  await expect(page.locator('video[data-asset-video]')).toHaveCount(1);
  await expect(page.locator(ROOT)).toHaveCount(0);
  await page.goto(fixture.baseURL + `/projects/${f.project.id}`);
  await expect(page.locator(ROOT)).toHaveCount(0);
  await expect(page.locator('[data-project-detail-comic-trigger]')).toHaveCount(0);
});

async function pixel(page, f) {
  return image(page, f).evaluate(async img => {
    await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
    const digest = await crypto.subtle.digest('SHA-256', context.getImageData(0, 0, canvas.width, canvas.height).data);
    return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
  });
}

for (const host of hosts) {
  test(`${host}: native Preview startup, idempotence, normal-cache source/policy freshness and Reader originals`, async ({ page, request }) => {
    const f = fixture.create();
    const meta = createAppMetaRepository(fixture.db);
    const oldFormat = meta.getValue('images.preview.format');
    await page.addInitScript(() => {
      window.coverResources = { blobs: 0, fetches: [], imageListeners: 0 };
      const blob = URL.createObjectURL;
      URL.createObjectURL = function (...args) { window.coverResources.blobs++; return blob.apply(this, args); };
      const fetch = window.fetch;
      window.fetch = function (input, ...args) { window.coverResources.fetches.push(String(input?.url || input)); return fetch.call(this, input, ...args); };
      const add = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, ...args) {
        if (this instanceof HTMLImageElement && ['load', 'error'].includes(type)) window.coverResources.imageListeners++;
        return add.call(this, type, ...args);
      };
    });
    try {
      const control = await open(page, host, f); await loaded(link(page, f));
      await expect(page.locator(ROOT)).toHaveCount(0);
      await expect(image(page, f)).toHaveAttribute('src', new RegExp('^/projects/' + f.project.id + '/assets/' + f.comic + '/preview\\?v=[a-f0-9]{16}$'));
      if (host !== 'details') await expect(image(page, f)).toHaveAttribute('loading', 'lazy');
      const initialURL = await image(page, f).getAttribute('src');
      const initialPixel = await pixel(page, f);
      const initialRequests = fixture.previewRequests.filter(r => r.url === initialURL).length;
      expect(initialRequests).toBe(1);
      const listeners = await page.evaluate(() => window.coverResources.imageListeners);
      await page.evaluate(async bridge => {
        const module = await import(bridge);
        for (let i = 0; i < 4; i++) module.enhancePreviewMedia(document);
      }, fixture.bridgeURL);
      expect(await page.evaluate(() => window.coverResources.imageListeners)).toBe(listeners);
      expect(fixture.previewRequests.filter(r => r.url === initialURL)).toHaveLength(initialRequests);
      expect(await page.evaluate(() => window.coverResources.blobs)).toBe(0);
      expect(await page.evaluate(() => window.coverResources.fetches.filter(url => /\/assets\/\d+\/preview/.test(url)))).toEqual([]);
      await image(page, f).evaluate(img => { window.retainedCover = img; img.closest('a').focus(); });
      await refresh(page, host, f); await loaded(link(page, f));
      if (host === 'details' || host === 'release') {
        expect(await image(page, f).evaluate(img => img === window.retainedCover)).toBe(true);
        expect(fixture.previewRequests.filter(r => r.url === initialURL)).toHaveLength(initialRequests);
        await expect(link(page, f)).toBeFocused();
      }
      f.rewrite();
      await refresh(page, host, f); await loaded(link(page, f));
      const sourceURL = await image(page, f).getAttribute('src');
      expect(sourceURL).not.toBe(initialURL); expect(await pixel(page, f)).not.toBe(initialPixel);
      expect(fixture.previewRequests.filter(r => r.url === sourceURL)).toHaveLength(1);
      meta.setValue('images.preview.format', 'png');
      const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/assets/' + f.comic + '/preview'));
      await refresh(page, host, f); await loaded(link(page, f));
      const policyURL = await image(page, f).getAttribute('src');
      expect(policyURL).not.toBe(sourceURL); expect((await response).headers()['content-type']).toBe('image/png');
      expect(await image(page, f).evaluate(img => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data];
      })).toEqual([27, 163, 57, 255]);
      expect(control.requests.some(r => r.path.includes('/comic/thumbnail'))).toBe(false);
      expect(await page.evaluate(() => window.coverResources.blobs)).toBe(0);
      expect(await page.evaluate(() => window.coverResources.fetches.filter(url => /\/assets\/\d+\/preview/.test(url)))).toEqual([]);
      if (evidence) await page.screenshot({ path: path.join(evidence, 'screenshots', host + '-native.png'), fullPage: true });
      await link(page, f).press('Enter');
      await expect(page.locator(`${DIALOG} .unified-viewer-page-image`).first()).toBeVisible();
      await page.keyboard.press('Escape'); await expect(link(page, f)).toBeFocused();
      const manifest = await (await request.get(fixture.baseURL + '/projects/' + f.project.id + '/assets/' + f.comic + '/comic')).json();
      const original = await request.get(fixture.baseURL + manifest.pages[0].url);
      const originalHash = createHash('sha256').update(await original.body()).digest('hex');
      expect(originalHash).toBe(createHash('sha256').update(fixture.other).digest('hex'));
      expect(control.errors).toEqual([]);
      results.hosts[host] = { initialURL, sourceURL, policyURL, initialRequests, native: true, coverBlobCalls: 0, coverFetchCalls: 0, idempotentListeners: true, sourcePixelsChanged: true, pngPixel: [27, 163, 57, 255], readerOriginalSHA256: originalHash };
    } finally { meta.setValue('images.preview.format', oldFormat ?? 'webp'); }
  });

  test(`${host}: native unavailable fallback stays quiet, Reader remains accessible and accepted refresh recovers`, async ({ page }) => {
    const f = fixture.create(); fixture.refusePreview(f, 503);
    await open(page, host, f);
    const root = frame(page, f); await root.scrollIntoViewIfNeeded();
    await expect(root).toHaveAttribute('data-preview-state', 'failed');
    await expect(image(page, f)).toBeHidden();
    const fallback = link(page, f);
    await expect(fallback).toHaveAttribute('data-preview-fallback', '');
    await expect(fallback).toHaveAccessibleName(/^Read comic a-book\.cbz/);
    await fallback.click(); await expect(page.locator(DIALOG)).toBeVisible();
    await page.keyboard.press('Escape'); await expect(fallback).toBeFocused();
    await fallback.press('Enter'); await expect(page.locator(DIALOG)).toBeVisible();
    await page.keyboard.press('Escape'); await expect(fallback).toBeFocused();
    const before = fixture.previewRequests.filter(r => r.url.includes('/assets/' + f.comic + '/preview')).length;
    await page.evaluate(async bridge => { const m = await import(bridge); m.enhancePreviewMedia(document); m.enhancePreviewMedia(document); }, fixture.bridgeURL);
    expect(fixture.previewRequests.filter(r => r.url.includes('/assets/' + f.comic + '/preview'))).toHaveLength(before);
    if (evidence) await page.screenshot({ path: path.join(evidence, 'screenshots', host + '-fallback.png'), fullPage: true });
    fixture.refusePreview(f, 0); f.rewrite();
    await refresh(page, host, f); await loaded(link(page, f));
    await expect(link(page, f)).not.toHaveAttribute('data-preview-fallback');
    results.hosts[host] = { ...results.hosts[host], fallback: { pointer: true, enter: true, closeFocus: true, quiet: true, acceptedRefresh: true } };
  });

  test(`${host}: detached native callbacks do not mutate retired media or create cover work`, async ({ page }) => {
    const f = fixture.create(); const control = await open(page, host, f); await loaded(link(page, f));
    const before = control.requests.filter(r => r.path.endsWith('/assets/' + f.comic + '/preview')).length;
    const detached = await frame(page, f).evaluate(async (root, bridge) => {
      const copy = root.cloneNode(true), img = copy.querySelector('[data-preview-image]');
      delete copy.dataset.previewBound; copy.dataset.previewState = 'loading';
      Object.defineProperty(img, 'complete', { value: false });
      document.body.append(copy);
      (await import(bridge)).enhancePreviewMedia(document);
      copy.remove();
      img.dispatchEvent(new Event('load')); img.dispatchEvent(new Event('error'));
      (await import(bridge)).enhancePreviewMedia(document);
      return { connected: copy.isConnected, state: copy.dataset.previewState, blob: img.src.startsWith('blob:') };
    }, fixture.bridgeURL);
    expect(detached).toEqual({ connected: false, state: 'loading', blob: false });
    expect(control.requests.filter(r => r.path.endsWith('/assets/' + f.comic + '/preview'))).toHaveLength(before);
    results.hosts[host] = { ...results.hosts[host], detached };
  });
}

test('Global Library: native cross-project identity, pagination and hidden/offscreen lazy deferral', async ({ page }) => {
  const a = fixture.create(), b = fixture.create(); b.rewrite();
  const filename = 'cross-project-' + a.project.id + '-book.cbz';
  for (const f of [a, b]) {
    fs.renameSync(path.join(f.dir, 'a-book.cbz'), path.join(f.dir, filename));
    fixture.db.prepare('UPDATE assets SET filename=?,relative_path=? WHERE id=?').run(filename, filename, f.comic);
  }
  const control = await open(page, 'library', a, 'grid', '/asset-viewer?view=grid&search=' + filename + '&pageSize=all');
  await loaded(link(page, a)); await loaded(link(page, b));
  expect((await descriptor(link(page, a))).projectId).not.toBe((await descriptor(link(page, b))).projectId);
  expect(await pixel(page, a)).not.toBe(await pixel(page, b));
  await controlClickDetails(page, link(page, b), b);
  for (let i = 0; i < 12; i++) a.write('p' + String(i).padStart(2, '0') + '.png', fixture.cover);
  for (const row of fixture.repo.findByProjectId(a.project.id).filter(asset => asset.extension === 'png')) {
    await fixture.app.locals.previewService.getPreview(a.project.id, row.id);
  }
  a.extra = a.write('zz-native-later.cbz', makeZip([{ name: '001.png', data: fixture.other }]));
  const destination = url('library', a, 'list');
  fixture.styleDocument(destination, 'article[data-asset-id="' + a.extra + '"]{display:none!important}');
  await page.goto(fixture.baseURL + destination); await page.evaluate(() => { window.sameDocument = true; });
  const extra = page.locator('a[data-comic-project="' + a.project.id + '"][data-comic-asset="' + a.extra + '"]').first();
  await expect(extra).toHaveCount(1);
  const count = () => fixture.previewRequests.filter(r => r.url.includes('/assets/' + a.extra + '/preview')).length;
  expect(await extra.evaluate(el => getComputedStyle(el.closest('article')).display)).toBe('none');
  await page.waitForTimeout(150);
  expect(count()).toBe(0);
  await extra.evaluate(el => { const article = el.closest('article'); article.style.marginTop = '10000px'; article.style.setProperty('display', 'grid', 'important'); });
  await page.waitForTimeout(150);
  expect(count()).toBe(0);
  await loaded(extra); expect(count()).toBe(1);
  await page.locator('link[href="/test/cover-deferral.css"]').evaluate(el => el.remove());
  fixture.styleDocument(destination, '');
  await refresh(page, 'library', a, '/asset-viewer?view=list&project=' + a.project.id + '&pageSize=10&page=1');
  await expect(extra).toHaveCount(0);
  await refresh(page, 'library', a, '/asset-viewer?view=list&project=' + a.project.id + '&pageSize=10&page=2');
  await loaded(link(page, a, a.extra)); expect((await descriptor(link(page, a, a.extra))).assetId).toBe(a.extra);
  expect(control.errors).toEqual([]);
});

for (const host of ['project', 'library']) {
  test(`${host}: native NSFW concealment survives refresh and Preview failure`, async ({ page }) => {
    const f = fixture.create(); fixture.app.locals.nsfwFilterSettingsService.setEnabled(true);
    const tags = createTagRepository(fixture.db);
    const nsfw = fixture.db.prepare("SELECT id FROM tags WHERE normalized_name='nsfw'").get(); tags.assignToAsset(f.comic, nsfw.id);
    try {
      await open(page, host, f); await loaded(link(page, f));
      await expect(image(page, f)).toHaveClass(/asset-image--nsfw-blurred/);
      expect(await image(page, f).evaluate(img => getComputedStyle(img).filter)).toContain('blur(');
      f.rewrite(); fixture.refusePreview(f, 409); await refresh(page, host, f);
      await expect(frame(page, f)).toHaveAttribute('data-preview-state', 'failed');
      await expect(image(page, f)).toBeHidden(); await expect(image(page, f)).toHaveClass(/asset-image--nsfw-blurred/);
      await expect(link(page, f)).toHaveAttribute('data-preview-fallback', '');
    } finally { fixture.app.locals.nsfwFilterSettingsService.setEnabled(false); }
  });
}

for (const host of hosts) {
  test(`${host}: source withdrawal and superseded refresh cannot revive retired native pixels`, async ({ page, request }) => {
    const f = fixture.create(); await open(page, host, f); await loaded(link(page, f));
    const oldHTML = await (await request.get(fixture.baseURL + url(host, f))).text();
    await image(page, f).evaluate(img => { window.retiredNative = img; });
    let releaseOld, entered, calls = 0;
    const gate = new Promise(resolve => { releaseOld = resolve; }); const started = new Promise(resolve => { entered = resolve; });
    const currentURL = new URL(page.url());
    await page.route('**' + currentURL.pathname + currentURL.search, async route => {
      if (++calls === 1) { entered(); await gate; await route.fulfill({ contentType: 'text/html', body: oldHTML }).catch(() => {}); }
      else if (host === 'details') await route.fulfill({ status: 404, body: 'Gone' }); else await route.continue();
    });
    if (host === 'details') await page.evaluate(bridge => { window.olderRefresh = import(bridge).then(m => m.refreshAssetViewer(document, { regions: ['file'] })); }, fixture.bridgeURL);
    else if (host === 'release') await page.evaluate(id => document.dispatchEvent(new CustomEvent('release-edit-saved', { detail: { releaseId: id } })), f.release.id);
    else await page.evaluate(() => dispatchEvent(new PopStateEvent('popstate')));
    try {
      await started; fixture.db.prepare('UPDATE assets SET is_present=0 WHERE id=?').run(f.comic); await refresh(page, host, f);
      releaseOld(); if (host === 'details') await page.evaluate(() => window.olderRefresh);
      await expect(page.locator('[data-comic-asset="' + f.comic + '"]')).toHaveCount(0);
      const old = await page.evaluate(() => ({ connected: window.retiredNative.isConnected, src: window.retiredNative.getAttribute('src'), hidden: window.retiredNative.hidden }));
      if (host === 'details' || host === 'release') { expect(old.src).toBe(null); expect(old.hidden).toBe(true); }
      else expect(old.connected).toBe(false);
    } finally { releaseOld(); }
  });
}

test('Detail native pixels follow a same-size same-mtime source-generation change', async ({ page }) => {
  const f = fixture.create(), meta = createAppMetaRepository(fixture.db);
  const previous = meta.getValue('images.preview.format'); meta.setValue('images.preview.format', 'png');
  const make = async seed => {
    const width = 48, height = 96, raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 17 + Math.floor(i / 71) + seed) & 255;
    const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    return { archive: makeZip([{ name: '001.png', data: png }]), hash: createHash('sha256').update(await sharp(png).ensureAlpha().raw().toBuffer()).digest('hex') };
  };
  try {
    const first = await make(13), second = await make(149); expect(first.archive.length).toBe(second.archive.length);
    f.write('a-book.cbz', first.archive);
    await open(page, 'details', f); await loaded(link(page, f));
    const before = await descriptor(link(page, f)); expect(await pixel(page, f)).toBe(first.hash);
    const filename = path.join(f.dir, 'a-book.cbz'), stat = fs.statSync(filename), indexed = fixture.repo.findById(f.comic);
    fs.writeFileSync(filename, second.archive); fs.utimesSync(filename, stat.atime, stat.mtime);
    fixture.db.prepare('UPDATE assets SET source_generation=source_generation+1 WHERE id=?').run(f.comic);
    const afterRow = fixture.repo.findById(f.comic); expect(afterRow.size_bytes).toBe(indexed.size_bytes); expect(afterRow.modified_at).toBe(indexed.modified_at);
    await refresh(page, 'details', f); await loaded(link(page, f));
    const after = await descriptor(link(page, f)); expect(after.url).not.toBe(before.url); expect(after.sourceRevision).not.toBe(before.sourceRevision);
    expect(await pixel(page, f)).toBe(second.hash); expect(second.hash).not.toBe(first.hash);
    expect(fixture.previewRequests.filter(r => r.url === after.url)).toHaveLength(1);
    results.sameSizeGeneration = { first: first.hash, second: second.hash, archiveBytes: first.archive.length, indexedSizeUnchanged: true, indexedMtimeUnchanged: true, before: before.url, after: after.url };
  } finally { meta.setValue('images.preview.format', previous ?? 'webp'); }
});
