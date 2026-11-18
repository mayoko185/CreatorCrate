import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { createAssetRepository } from '../../src/data/asset-repository.js';
import { createGeneratedArtifactRepository } from '../../src/data/generated-artifact-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { defaultComicPreparationCacheRoot } from '../../src/services/comic-preparation-cache.js';
import { createComicRuntime } from '../../src/services/comic-runtime.js';
import { createPreviewService, buildAssetRevisionToken } from '../../src/services/preview-service.js';
import { createProcessingConcurrencyService } from '../../src/services/processing-concurrency-service.js';
import { AUTH_CONFIG, extractCsrfToken, TEST_PASSWORD, TEST_USERNAME } from '../helpers/auth.js';
import { makeZip } from '../helpers/zip-fixture.js';

const DIALOG = '#unified-viewer-dialog';
const POSITION = `${DIALOG} [data-unified-viewer-position]`;
const SHOWN = `${DIALOG} [data-unified-viewer-media] img.unified-viewer-page-image:not([hidden])`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const provenanceOf = (filename) => {
  const { dev, ino, birthtimeNs } = fs.statSync(filename, { bigint: true });
  return `v1:${dev}:${ino}:${birthtimeNs}`;
};

async function createFixture({ previewHooks, concurrency = 4 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-generated-discovery-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const previewRoot = path.join(appDataRoot, 'previews');
  const viteDistRoot = path.join(root, 'client');
  let db;
  let runtime;
  let server;
  let comicMediaService;
  let app;
  const close = async () => {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      try {
        comicMediaService?.stop();
        await comicMediaService?.pauseForMaintenance().waitForIdle();
        for (const owner of [app?.locals.generatedImageRebuildService, app?.locals.generatedImagePublicationLifecycle]) {
          owner?.stop(); await owner?.waitForIdle();
        }
        await runtime?.close();
      } finally {
        if (db) closeDatabase(db);
        try {
          fs.rmSync(defaultComicPreparationCacheRoot(appDataRoot), { recursive: true, force: true });
        } finally {
          fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
        }
      }
    }
  };
  try {
    fs.mkdirSync(projectsRoot);
    fs.mkdirSync(previewRoot, { recursive: true });
    await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
    db = openDatabase(path.join(root, 'test.db'));
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const renditionSpawns = [];
    const requests = [];
    const processing = createProcessingConcurrencyService({ concurrency });
    runtime = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 },
      renditionOptions: { hooks: { spawned: ({ pid }) => renditionSpawns.push(pid) } } });
    await runtime.start();
    const previewService = createPreviewService({ db, projectsRoot, previewRoot,
      comicSourceProvider: () => app.locals.comicMediaService, comicAdmissionLimits: runtime.admission.limits,
      processingConcurrencyService: processing, _hooks: previewHooks });
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
      appDataRoot, authConfig: AUTH_CONFIG, comicRuntime: runtime, previewService,
      processingConcurrencyService: processing,
      startGeneratedImageRebuild: false, useViteAssets: true, viteDistRoot,
      assetManifest: createAssetManifest({ distRoot: viteDistRoot,
        manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
    });
    comicMediaService = app.locals.comicMediaService;
    // Project creation binds the real directory ownership marker and database token.
    const project = app.locals.projectService.create({
      title: 'Generated Discovery', status: 'tbd', projectType: 'images',
    });
    const projectDir = path.join(projectsRoot, project.project_dir);
    const sourceNames = ['01.png', '02.png', '03.png'];
    for (const [index, name] of sourceNames.entries()) {
      await sharp({ create: { width: 60, height: 80, channels: 3,
        background: ['#224466', '#668822', '#882244'][index] } }).png().toFile(path.join(projectDir, name));
    }
    fs.writeFileSync(path.join(projectDir, 'clip.mp4'), 'video scan classification control');
    server = app.listen(0, '127.0.0.1');
    server.on('request', req => requests.push(req.url));
    await new Promise((resolve) => server.once('listening', resolve));
    return { baseURL: `http://127.0.0.1:${server.address().port}`, app, db, project, projectDir,
      sourceNames, assets: createAssetRepository(db), artifacts: createGeneratedArtifactRepository(db),
      runtime, renditionSpawns, comicMediaService, requests, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// Inspect bytes published by the actual Archives service, independently of the reader.
function readZipEntries(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { zip.close(); reject(streamError); return; }
          const chunks = [];
          stream.on('error', (readError) => { zip.close(); reject(readError); });
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function viewerState(page) {
  return page.locator(DIALOG).evaluate((dialog) => {
    const state = dialog.__creatorCrateUnifiedViewer.getState();
    return { comic: state.comic, reader: state.reader,
      imageTitles: state.source?.items.map((item) => item.title) ?? [], slideshow: state.source?.slideshow };
  });
}

async function openHost(page, url) {
  await page.goto(url);
  await expect(page.locator('script[type="module"][src^="/vite/"]')).toHaveCount(1);
  await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  await expect(page.locator(DIALOG)).toHaveCount(1);
  await expect(page.locator('[data-slideshow-scaffold]')).toHaveCount(0);
}

async function chooseReader(page, menu, label) {
  await page.locator(`${DIALOG} #unified-viewer-${menu}-dropdown summary`).click();
  await page.locator(`${DIALOG} #unified-viewer-${menu}-dropdown .asset-filter-multiselect-panel`)
    .getByText(label, { exact: true }).click();
}

async function filterCbz(page, dialogId, region) {
  // WP7 / WP9b: Project Assets and the Asset Library combine Filters &
  // Defaults behind the filter icon.
  const linkName = ['#project-assets-filter-dialog', '#asset-viewer-filter-dialog'].includes(dialogId)
    ? 'Filters & Defaults' : 'Filter assets';
  await page.getByRole('link', { name: linkName, exact: true }).click();
  const dialog = page.locator(dialogId);
  await expect(dialog).toBeVisible();
  await dialog.locator('#asset-extension-filter summary').click();
  const cbz = dialog.locator('input[name="extension"][value="cbz"]');
  await expect(cbz).toHaveCount(1);
  await dialog.locator(`label[for="${await cbz.getAttribute('id')}"]`).click();
  await expect(page).toHaveURL(/(?:\?|&)extension=cbz(?:&|$)/);
  await expect(page.locator(region)).not.toHaveAttribute('aria-busy', 'true');
  await dialog.locator('#asset-extension-filter summary').click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

test('generated WebP comics enter both asset browsers only through manual scanning and open the shared reader', async ({ page }) => {
  const f = await createFixture();
  const { project, assets, artifacts, app } = f;
  const projectURL = `${f.baseURL}/projects/${project.id}/assets?view=grid&pageSize=all`;
  const libraryURL = `${f.baseURL}/asset-viewer?view=grid&pageSize=all`;
  const paLink = (id) => page.locator(`[data-project-assets-comic-trigger][data-comic-asset="${id}"]:visible`);
  const libLink = (id) => page.locator(`[data-asset-library-comic-trigger][data-comic-project="${project.id}"][data-comic-asset="${id}"]:visible`);
  const requests = [];
  const errors = [];
  page.on('request', (request) => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  page.on('pageerror', (error) => errors.push(error.message));
  const comicRequests = () => requests.filter(({ path: pathname }) => /\/comic(?:\/pages\/\d+)?$/.test(pathname));
  let csrf;
  const scan = async (expected) => {
    const response = await page.request.post(`${f.baseURL}/projects/${project.id}/scan/manual`, {
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrf }, data: {},
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, scan: expected });
  };
  const artifactFor = (relativePath) => artifacts.findByProjectIdAndPath(project.id, relativePath);
  const rowFor = (relativePath) => assets.findByProjectIdAndPath(project.id, relativePath);
  const generate = async (assetIds, options) => {
    const response = await page.request.post(`${f.baseURL}/projects/${project.id}/assets/processing/archive/apply`, {
      headers: { 'X-CSRF-Token': csrf }, data: { scope: { type: 'selected', assetIds }, options },
    });
    expect(response.status()).toBe(202);
    const { jobId } = await response.json();
    let job;
    await expect.poll(async () => {
      const status = await page.request.get(`${f.baseURL}/processing/jobs/${jobId}`);
      expect(status.status()).toBe(200);
      job = (await status.json()).job;
      return job.state;
    }).toBe('succeeded');
    return job.result.result;
  };
  const cover = async (link, asset) => {
    const image = link.locator('[data-preview-image]');
    const root = link.locator('xpath=ancestor::*[@data-preview-enhancement][1]');
    await link.scrollIntoViewIfNeeded();
    await expect(link).toHaveAttribute('data-comic-project', String(project.id));
    await expect(link).toHaveAttribute('data-comic-asset', String(asset.id));
    await expect(link).toHaveAttribute('data-comic-source-revision', buildAssetRevisionToken(asset));
    await expect(image).toHaveAttribute('src', new RegExp(`^/projects/${project.id}/assets/${asset.id}/preview\\?v=[a-f0-9]{16}$`));
    await expect(root).toHaveAttribute('data-preview-state', 'loaded');
    await expect(image).toBeVisible();
    expect(await image.evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual([60, 80]);
    await expect(root.locator('[data-comic-thumbnail]')).toHaveCount(0);
  };
  function assertCatalogue(relativePath, id) {
    const stat = fs.statSync(path.join(f.projectDir, relativePath));
    const row = rowFor(relativePath);
    expect(row).toMatchObject({ ...(id ? { id } : {}), project_id: project.id, relative_path: relativePath,
      filename: path.posix.basename(relativePath), extension: 'cbz', mime_type: 'application/vnd.comicbook+zip',
      is_present: 1, missing_since: null, size_bytes: stat.size, modified_at: stat.mtime.toISOString(),
      generated_by: null });
    expect(f.db.prepare('SELECT generated_output_provenance FROM assets WHERE id = ?').get(row.id))
      .toEqual({ generated_output_provenance: null });
    expect(f.db.prepare('SELECT count(*) AS count FROM assets WHERE project_id = ? AND relative_path = ?')
      .get(project.id, relativePath).count).toBe(1);
    expect(buildAssetRevisionToken(row)).toMatch(/^[0-9a-f]+$/);
    return row;
  }
  try {
    // Login and scan use the same real session cookie jar as Chromium.
    await page.goto(`${f.baseURL}/login`);
    await page.locator('#username').fill(TEST_USERNAME);
    await page.locator('#password').fill(TEST_PASSWORD);
    await Promise.all([page.waitForURL((url) => url.pathname !== '/login'),
      page.getByRole('button', { name: 'Log in', exact: true }).click()]);
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'cc_session')).toBe(true);
    const projectPage = await page.request.get(projectURL);
    expect(projectPage.status()).toBe(200);
    csrf = extractCsrfToken(await projectPage.text());
    const rejected = await page.request.post(`${f.baseURL}/projects/${project.id}/scan/manual`, {
      headers: { Accept: 'application/json' }, data: {},
    });
    expect(rejected.status()).toBe(403);
    expect(assets.findByProjectId(project.id)).toEqual([]);
    await scan({ added: 4, updated: 0, missing: 0, total: 4 });
    const sources = f.sourceNames.map((name) => rowFor(name));
    expect(rowFor('clip.mp4')).toMatchObject({ extension: 'mp4', mime_type: 'video/mp4', is_present: 1 });
    const options = { archives: [
      { archiveFormat: 'cbz', imageFormat: 'webp', baseName: 'issue' },
      { archiveFormat: 'zip', imageFormat: 'webp', baseName: 'generic' },
    ] };
    const deniedGeneration = await page.request.post(`${f.baseURL}/projects/${project.id}/assets/processing/archive/apply`, {
      data: { scope: { type: 'selected', assetIds: sources.map(({ id }) => id) }, options },
    });
    expect(deniedGeneration.status()).toBe(403);
    expect(artifacts.listByProjectId(project.id)).toEqual([]);
    const generated = await generate(sources.map(({ id }) => id), options);
    expect(generated).toMatchObject({ status: 'completed', generatedCount: 2, sourceCount: 3 });
    const comicPath = generated.generatedPaths.find((name) => name.endsWith('.cbz'));
    const zipPath = generated.generatedPaths.find((name) => name.endsWith('.zip'));
    const entries = await readZipEntries(path.join(f.projectDir, comicPath));
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.name).toMatch(/\.webp$/);
      expect(await sharp(entry.bytes).metadata()).toMatchObject({ format: 'webp', width: 60, height: 80 });
    }
    const originalArtifact = artifactFor(comicPath);
    const bytes = fs.readFileSync(path.join(f.projectDir, comicPath));
    expect(originalArtifact).toMatchObject({ project_id: project.id, relative_path: comicPath,
      kind: 'archive-webp', generated_by: 'archives', sha256: sha256(bytes), size_bytes: bytes.length });
    expect(originalArtifact.output_provenance).toBe(provenanceOf(path.join(f.projectDir, comicPath)));
    expect(await readZipEntries(path.join(f.projectDir, zipPath))).toEqual(entries);
    expect(rowFor(comicPath)).toBeUndefined();
    expect(rowFor(zipPath)).toBeUndefined();
    const originalArtifacts = artifacts.listByProjectId(project.id);
    // No comic asset is inserted by the fixture: this HTTP route must discover it.
    await scan({ added: 1, updated: 0, missing: 0, total: 5 });
    const comic = assertCatalogue(comicPath);
    expect(comic.source_generation).toBe(0);
    expect(artifacts.listByProjectId(project.id)).toEqual(originalArtifacts);
    expect(rowFor(zipPath)).toBeUndefined();
    expect(artifactFor(zipPath)).toMatchObject({ generated_by: 'archives', kind: 'archive-webp' });
    const assertNoEagerComic = () => {
      expect(comicRequests()).toEqual([]);
      expect(requests.filter(({ path: pathname }) => new RegExp(
        `^/projects/${project.id}/assets/${comic.id}/(?:original|thumbnail|download)$`,
      ).test(pathname))).toEqual([]);
    };

    await openHost(page, projectURL);
    const assertCard = async (link) => {
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAccessibleName(/^Read comic /);
      await expect(link).toHaveAttribute('data-comic-project', String(project.id));
      await expect(link).toHaveAttribute('data-comic-source-revision', buildAssetRevisionToken(comic));
      await expect(link).toHaveAttribute('href', new RegExp(`^/projects/${project.id}/assets/${comic.id}(\\?|$)`));
      const card = link.locator('xpath=ancestor::article[1]');
      await expect(card).toContainText(path.posix.basename(comicPath));
      await expect(card.locator('[data-comic-thumbnail], .asset-comic-thumbnail, .asset-comic-thumbnail-badge')).toHaveCount(0);
      await expect(card.locator('img')).toHaveCount(1);
      await cover(link, comic);
      const details = card.locator('a.asset-details-link');
      if (await link.evaluate((node) => node.classList.contains('asset-card-media-link'))) {
        await expect(details).toHaveAttribute('href',
          new RegExp(`^/projects/${project.id}/assets/${comic.id}(\\?|$)`));
      }
    };
    await assertCard(paLink(comic.id));
    await page.locator('nav.view-switcher a[aria-label="List view"]').click();
    await expect(paLink(comic.id)).toHaveClass(/asset-list-card-media-link/);
    await assertCard(paLink(comic.id));
    assertNoEagerComic();
    await page.locator('[data-project-assets-slideshow-trigger]').click();
    await expect.poll(async () => (await viewerState(page)).imageTitles).toEqual(f.sourceNames);
    expect((await viewerState(page)).slideshow).toBe(true);
    expect((await viewerState(page)).comic).toBeNull();
    await page.keyboard.press('Escape');
    await filterCbz(page, '#project-assets-filter-dialog', '[data-project-assets-live-region]');
    await expect(page.locator('[data-project-assets-comic-trigger]:visible')).toHaveCount(1);
    await assertCard(paLink(comic.id));
    assertNoEagerComic();

    await openHost(page, libraryURL);
    await assertCard(libLink(comic.id));
    await expect(libLink(comic.id)).toHaveAttribute('aria-label', `Read comic ${comic.filename} from ${project.title}`);
    await page.locator('[data-asset-library-slideshow-trigger]').click();
    await expect.poll(async () => (await viewerState(page)).imageTitles).toEqual(f.sourceNames);
    expect((await viewerState(page)).comic).toBeNull();
    await page.keyboard.press('Escape');
    await filterCbz(page, '#asset-viewer-filter-dialog', '[data-asset-library-live-region]');
    await expect(page.locator('[data-asset-library-comic-trigger]:visible')).toHaveCount(1);
    await assertCard(libLink(comic.id));
    assertNoEagerComic();

    // Reader-only assertions start after login, generation and manual scanning.
    const readerStart = requests.length;
    const manifestPath = `/projects/${project.id}/assets/${comic.id}/comic`;
    const manifestResponse = page.waitForResponse((response) => new URL(response.url()).pathname === manifestPath);
    const pageResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `${manifestPath}/pages/1`);
    await libLink(comic.id).click();
    const [manifestHttp, delivered] = await Promise.all([manifestResponse, pageResponse]);
    expect(manifestHttp.status()).toBe(200);
    const manifest = await manifestHttp.json();
    expect(manifest).toMatchObject({ projectId: project.id, assetId: comic.id, format: 'cbz', pageCount: 3 });
    expect(manifest.pages.map(({ position }) => position)).toEqual([1, 2, 3]);
    expect(manifest.pages.every(({ name, available }) => name.endsWith('.webp') && available)).toBe(true);
    expect(delivered.status()).toBe(200);
    expect(delivered.url()).toBe(new URL(manifest.pages[0].url, f.baseURL).href);
    expect(new URL(delivered.url()).searchParams.get('v')).toBe(manifest.revision);
    expect(delivered.headers()['content-type']).toMatch(/^image\/webp/);
    expect(await sharp(await delivered.body()).metadata()).toMatchObject({ format: 'webp', width: 60, height: 80 });
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
    const rendered = async (count) => {
      await expect(page.locator(SHOWN)).toHaveCount(count);
      await expect.poll(() => page.locator(SHOWN).evaluateAll((images) =>
        images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0))).toBe(true);
    };
    await rendered(1);
    await chooseReader(page, 'direction', 'Right-to-Left');
    await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
    await chooseReader(page, 'layout', 'Two-Page Spread — Cover Alone');
    await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 3');
    await rendered(2);
    await chooseReader(page, 'layout', 'Single Page');
    await rendered(1);
    await chooseReader(page, 'layout', 'Two-Page Spread — Cover Alone');
    await rendered(2);
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(libLink(comic.id)).toBeFocused();
    await page.reload();
    await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
    await libLink(comic.id).click();
    await expect.poll(async () => (await viewerState(page)).comic?.state).toBe('ready');
    expect((await viewerState(page)).reader).toMatchObject({ direction: 'rtl', layout: 'spread' });
    await expect(page.locator(DIALOG)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(libLink(comic.id)).toBeFocused();
    expect(requests.slice(readerStart).filter(({ method }) => method !== 'GET')).toEqual([]);

    await scan({ added: 0, updated: 0, missing: 0, total: 5 });
    expect(assertCatalogue(comicPath, comic.id)).toEqual(comic);
    expect(artifacts.listByProjectId(project.id)).toEqual(originalArtifacts);
    const laterOptions = { archives: [{ archiveFormat: 'cbz', imageFormat: 'webp', baseName: 'later' }] };
    const later = await generate(sources.map(({ id }) => id), laterOptions);
    const laterPath = later.generatedPaths[0];
    expect(artifactFor(laterPath)).toMatchObject({ generated_by: 'archives' });
    expect(rowFor(laterPath)).toBeUndefined();
    fs.writeFileSync(path.join(f.projectDir, 'imported.cbz'), makeZip(entries.map(({ name, bytes: data }) => ({ name, data }))));
    expect(rowFor('imported.cbz')).toBeUndefined();
    expect(artifactFor('imported.cbz')).toBeUndefined();
    const beforeIncremental = artifacts.listByProjectId(project.id);
    await scan({ added: 2, updated: 0, missing: 0, total: 7 });
    expect(assertCatalogue(comicPath, comic.id)).toEqual(comic);
    const laterComic = assertCatalogue(laterPath);
    const imported = assertCatalogue('imported.cbz');
    expect(new Set([comic.id, laterComic.id, imported.id]).size).toBe(3);
    expect(artifacts.listByProjectId(project.id)).toEqual(beforeIncremental);
    for (const [url, trigger, dialog, region] of [
      [projectURL, paLink, '#project-assets-filter-dialog', '[data-project-assets-live-region]'],
      [libraryURL, libLink, '#asset-viewer-filter-dialog', '[data-asset-library-live-region]'],
    ]) {
      await openHost(page, url);
      await filterCbz(page, dialog, region);
      for (const row of [comic, laterComic, imported]) await expect(trigger(row.id)).toBeVisible();
      await expect(page.locator(region).locator('article')).toHaveCount(3);
    }
    // An ordinary imported comic follows the same reader route without artifact ownership.
    await libLink(imported.id).click();
    await expect.poll(async () => (await viewerState(page)).comic?.assetId).toBe(imported.id);
    await expect.poll(async () => (await viewerState(page)).comic?.state).toBe('ready');
    await rendered(1);
    await page.keyboard.press('Escape');

    const replacementOptions = { archives: [options.archives[0]] };
    await expect(app.locals.assetProcessingService.createArchives(project.id, sources.map(({ id }) => id), replacementOptions))
      .rejects.toMatchObject({ code: 'ARCHIVE_DESTINATION_CONFLICT' });
    const originalRow = assertCatalogue(comicPath, comic.id);
    const previousGeneratedRevision = f.db.prepare('SELECT revision FROM generated_image_publications WHERE asset_id = ?').get(comic.id).revision;
    await generate(sources.slice(1).map(({ id }) => id), {
      ...replacementOptions, replaceExistingArchives: true,
    });
    const replacement = assertCatalogue(comicPath, comic.id);
    expect(replacement.source_generation).toBe(originalRow.source_generation + 1);
    expect(replacement.size_bytes).not.toBe(originalRow.size_bytes);
    expect(buildAssetRevisionToken(replacement)).not.toBe(buildAssetRevisionToken(originalRow));
    expect(artifactFor(comicPath)).toMatchObject({ id: originalArtifact.id, generated_by: 'archives',
      size_bytes: replacement.size_bytes, sha256: sha256(fs.readFileSync(path.join(f.projectDir, comicPath))) });
    expect(artifactFor(comicPath).output_provenance).not.toBe(originalArtifact.output_provenance);
    expect(artifactFor(comicPath).output_provenance).toBe(provenanceOf(path.join(f.projectDir, comicPath)));
    const replacedArtifacts = artifacts.listByProjectId(project.id);
    await scan({ added: 0, updated: 0, missing: 0, total: 7 });
    expect(assertCatalogue(comicPath, comic.id)).toEqual(replacement);
    expect(artifacts.listByProjectId(project.id)).toEqual(replacedArtifacts);
    expect(rowFor(zipPath)).toBeUndefined();
    expect(artifactFor('imported.cbz')).toBeUndefined();
    await openHost(page, projectURL);
    await expect(paLink(comic.id)).toHaveAttribute('data-comic-source-revision', buildAssetRevisionToken(replacement));
    await cover(paLink(comic.id), replacement);
    const thumbURL = `${f.baseURL}/projects/${project.id}/assets/${comic.id}/preview`;
    const oldThumb = await page.request.get(`${thumbURL}?v=${previousGeneratedRevision}`);
    expect(oldThumb.status()).toBe(200);
    expect(oldThumb.headers()['cache-control']).toBe('private, max-age=0, must-revalidate');
    const currentThumb = await page.request.get(thumbURL);
    expect(currentThumb.status()).toBe(200);
    const newBytes = Buffer.from(await currentThumb.body());
    expect(Buffer.from(await oldThumb.body()).equals(newBytes)).toBe(true);
    const firstReplacementPage = (await readZipEntries(path.join(f.projectDir, comicPath)))[0].bytes;
    expect(newBytes.equals(await sharp(firstReplacementPage).autoOrient().webp({ quality: 90 }).toBuffer())).toBe(true);
    const published = f.db.prepare('SELECT * FROM generated_image_publications WHERE asset_id = ?').get(comic.id);
    expect(Buffer.from(await (await page.request.get(thumbURL)).body()).equals(newBytes)).toBe(true);
    expect(f.db.prepare('SELECT * FROM generated_image_publications WHERE asset_id = ?').get(comic.id)).toEqual(published);
    await paLink(comic.id).click();
    await expect.poll(async () => (await viewerState(page)).comic?.pageCount).toBe(2);
    await rendered(1);
    await page.keyboard.press('Escape');
    await expect(paLink(comic.id)).toBeFocused();
    const retainedArtifacts = artifacts.listByProjectId(project.id);
    fs.unlinkSync(path.join(f.projectDir, comicPath));
    await scan({ added: 0, updated: 0, missing: 1, total: 7 });
    expect(rowFor(comicPath)).toMatchObject({ id: comic.id, is_present: 0 });
    expect((await page.request.get(thumbURL)).status()).toBe(404);
    expect(artifacts.listByProjectId(project.id)).toEqual(retainedArtifacts);
    await openHost(page, projectURL);
    await expect(paLink(comic.id)).toHaveCount(0);
    await expect(page.locator(`article[data-asset-id="${comic.id}"] [data-preview-image]`)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('scanned CBZ, RAR4/RAR5 and solid/non-solid CB7 display the canonical reader page through normal Preview', async ({ page }) => {
  const f = await createFixture();
  try {
    await page.goto(`${f.baseURL}/login`);
    await page.locator('#username').fill(TEST_USERNAME);
    await page.locator('#password').fill(TEST_PASSWORD);
    await Promise.all([page.waitForURL(url => url.pathname !== '/login'),
      page.getByRole('button', { name: 'Log in', exact: true }).click()]);
    const projectURL = `${f.baseURL}/projects/${f.project.id}/assets`;
    const csrf = extractCsrfToken(await (await page.request.get(projectURL)).text());
    const first = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#c01973' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const later = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#1ba339' } }).png().toBuffer();
    const fixtures = [{ name: 'natural.cbz', format: 'cbz', first: 'page1.jpg',
      bytes: makeZip([{ name: 'page10.png', data: later }, { name: 'page2.png', data: later },
        { name: 'page1.jpg', data: first }]) }];
    for (const name of ['comic-rar4.cbr', 'comic-rar4-solid.cbr', 'comic-rar5.cbr', 'comic-rar5-solid.cbr']) {
      fixtures.push({ name, format: 'cbr', first: 'page1.jpg',
        bytes: fs.readFileSync(fileURLToPath(new URL(`../fixtures/comic-archives/${name}`, import.meta.url))) });
    }
    const seven = await createRequire(import.meta.url)('7z-wasm')({ print() {}, printErr() {} });
    seven.FS.writeFile('/page1.jpg', first); seven.FS.writeFile('/page2.png', later); seven.FS.writeFile('/page10.png', later);
    for (const solid of [true, false]) {
      const name = solid ? 'solid.cb7' : 'nonsolid.cb7';
      seven.callMain(['a', '-t7z', `-ms=${solid ? 'on' : 'off'}`, '/' + name,
        '/page10.png', '/page2.png', '/page1.jpg']);
      fixtures.push({ name, format: 'cb7', first: 'page1.jpg', bytes: Buffer.from(seven.FS.readFile('/' + name)) });
    }
    for (const item of fixtures) fs.writeFileSync(path.join(f.projectDir, item.name), item.bytes);
    fs.writeFileSync(path.join(f.projectDir, 'generic.zip'), fixtures[0].bytes);
    fs.writeFileSync(path.join(f.projectDir, 'generic.7z'), fixtures.at(-1).bytes);
    expect(f.assets.findByProjectId(f.project.id)).toEqual([]);
    const scan = await page.request.post(`${f.baseURL}/projects/${f.project.id}/scan/manual`, {
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrf }, data: {},
    });
    expect(scan.status()).toBe(200);
    expect((await scan.json()).scan).toMatchObject({ added: 11, total: 11 });
    expect(f.assets.findByProjectIdAndPath(f.project.id, 'generic.zip')).toBeUndefined();
    expect(f.assets.findByProjectIdAndPath(f.project.id, 'generic.7z')).toBeUndefined();
    for (const item of fixtures) {
      const asset = f.assets.findByProjectIdAndPath(f.project.id, item.name);
      expect(asset).toMatchObject({ extension: item.format, is_present: 1 });
      const base = `/projects/${f.project.id}/assets/${asset.id}`;
      const received = page.waitForResponse(response => new URL(response.url()).pathname === base + '/preview');
      await openHost(page, f.baseURL + base);
      const root = page.locator('[data-asset-comic-preview][data-preview-enhancement]');
      await expect(root).toHaveAttribute('data-preview-state', 'loaded');
      await expect(root).toHaveAttribute('data-comic-format', item.format);
      await expect(root.locator('[data-preview-image]')).toHaveAttribute('src', new RegExp(`^${base}/preview\\?v=[a-f0-9]{16}$`));
      await expect(page.locator('[data-comic-thumbnail]')).toHaveCount(0);
      const response = await received;
      expect(response.status()).toBe(200);
      expect(response.headers()).toMatchObject({ 'content-type': 'image/webp', 'cache-control': 'private, max-age=0, must-revalidate',
        'x-content-type-options': 'nosniff' });
      const bytes = Buffer.from(await response.body());
      expect(bytes.length).toBeLessThanOrEqual(32 * 1024 * 1024);
      const metadata = await sharp(bytes, { animated: true }).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.pages ?? 1).toBe(1);
      expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(1600);
      expect(metadata.orientation).toBeUndefined();
      const manifest = await (await page.request.get(f.baseURL + base + '/comic')).json();
      expect(manifest).toMatchObject({ format: item.format });
      expect(manifest.pages[0].name).toBe(item.first);
      if (item.format !== 'cbr') expect(manifest.pages.map(p => p.name)).toEqual(['page1.jpg', 'page2.png', 'page10.png']);
      const reader = await page.request.get(f.baseURL + manifest.pages[0].url);
      expect(reader.status()).toBe(200);
      const expected = await sharp(Buffer.from(await reader.body())).autoOrient().webp({ quality: 90 }).toBuffer();
      expect(bytes.equals(expected)).toBe(true);
      expect(await root.locator('[data-preview-image]').evaluate(img => [img.naturalWidth, img.naturalHeight]))
        .toEqual([metadata.width, metadata.height]);
      const published = f.db.prepare('SELECT * FROM generated_image_publications WHERE asset_id = ?').get(asset.id);
      const hit = await page.request.get(f.baseURL + base + '/preview');
      expect(hit.status()).toBe(200);
      expect(Buffer.from(await hit.body()).equals(bytes)).toBe(true);
      expect(f.db.prepare('SELECT * FROM generated_image_publications WHERE asset_id = ?').get(asset.id)).toEqual(published);
      await expect.poll(() => f.runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
    }
  } finally { await f.close(); }
});

test('a discovered catalogue stays interactive under shared processing saturation and releases detached callers', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const extracting = [];
  const f = await createFixture({ concurrency: 1, previewHooks: {
    beforePointerWrite: async () => { extracting.push(true); await gate; },
  } });
  let survivor;
  let queued;
  try {
    await page.goto(`${f.baseURL}/login`);
    await page.locator('#username').fill(TEST_USERNAME);
    await page.locator('#password').fill(TEST_PASSWORD);
    await Promise.all([page.waitForURL(url => url.pathname !== '/login'),
      page.getByRole('button', { name: 'Log in', exact: true }).click()]);
    const projectURL = `${f.baseURL}/projects/${f.project.id}/assets`;
    const csrf = extractCsrfToken(await (await page.request.get(projectURL)).text());
    const bytes = makeZip([{ name: 'page1.png', data: fs.readFileSync(path.join(f.projectDir, '01.png')) }]);
    for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(f.projectDir, `book-${String(i).padStart(2, '0')}.cbz`), bytes);
    expect((await page.request.post(`${f.baseURL}/projects/${f.project.id}/scan/manual`, {
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrf }, data: {},
    })).status()).toBe(200);
    const comics = f.assets.findByProjectId(f.project.id).filter(row => row.extension === 'cbz');
    expect(comics).toHaveLength(24);
    const requests = [];
    page.on('request', req => { if (req.url().includes('/preview')) requests.push(req.url()); });
    await page.setViewportSize({ width: 1500, height: 1200 });
    await openHost(page, projectURL + '?search=book-&view=grid&pageSize=10&sort=filename&order=asc');
    await expect.poll(() => extracting.length).toBe(1);
    const firstId = Number(new URL(requests[0]).pathname.split('/').at(-2));
    const absent = comics.find(row => row.id !== firstId);
    const endpoint = id => `${f.baseURL}/projects/${f.project.id}/assets/${id}/preview`;
    let queuedSettled = false;
    queued = page.request.get(endpoint(absent.id)).then(response => { queuedSettled = true; return response; });
    await expect.poll(() => f.requests.filter(url => url === new URL(endpoint(absent.id)).pathname).length).toBe(1);
    expect(queuedSettled).toBe(false);
    expect(extracting).toHaveLength(1);
    const selected = page.locator(`input[type="checkbox"][name="selectedAssetIds"][value="${firstId}"]`);
    await selected.check();
    await expect(selected).toBeChecked();
    await expect(page.locator(DIALOG)).toBeHidden();
    const sharedId = firstId;
    survivor = page.request.get(endpoint(sharedId));
    await expect.poll(() => f.requests.filter(url => new URL(url, f.baseURL).pathname === new URL(endpoint(sharedId)).pathname).length).toBe(2);
    expect(extracting).toHaveLength(1);
    // Navigation detaches all browser callers; the independently authorized caller survives.
    // A local navigation avoids waiting for a same-origin connection held by native covers.
    await page.goto('about:blank');
    // The empty filtered page adds no ordinary image work to the saturated pool.
    await page.goto(projectURL + '?search=no-matching-assets&view=list&pageSize=10');
    await expect(page.locator('[data-project-assets-live-region] [data-preview-image]')).toHaveCount(0);
    release();
    const response = await survivor;
    expect(response.status()).toBe(200);
    expect((await queued).status()).toBe(200);
    expect((await sharp(Buffer.from(await response.body())).metadata()).format).toBe('webp');
    await expect.poll(() => f.comicMediaService.isIdle()).toBe(true);
    expect(f.runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
    expect(f.runtime.renditions.snapshot()).toMatchObject({ active: 0, terminating: 0 });
    expect(requests.length).toBeLessThanOrEqual(10);
    for (const row of comics.slice(0, 5)) expect((await page.request.get(endpoint(row.id))).status()).toBe(200);
    expect(f.runtime.renditions.snapshot().launched).toBe(f.runtime.renditions.snapshot().exited);
  } finally { release(); if (survivor) await survivor.catch(() => {}); if (queued) await queued.catch(() => {}); await f.close(); }
});
