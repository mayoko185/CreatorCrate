import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { buildReleaseAssetPresentation } from '../src/services/release-asset-presenter.js';
import { createReleaseService } from '../src/services/release-service.js';
import { formatIsoTimestamp, formatSqliteTimestamp } from '../src/util/date.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

// B7a: the shared asset presentation partial emits the unified-viewer trigger
// only for a caller that names it (Release Manage Assets), and only on an
// eligible image. Release Detail, Project Assets and other users of the
// partial render exactly as before.

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const TRIGGER = 'data-release-assets-viewer-trigger';

function row(overrides = {}) {
  return {
    id: 17,
    project_id: 7,
    category_id: null,
    relative_path: 'renders/cover.png',
    nested_path: 'renders',
    filename: 'cover.png',
    extension: 'png',
    mime_type: 'image/png',
    size_bytes: 2048,
    modified_at: '2026-08-01 10:00:00',
    is_present: 1,
    ...overrides,
  };
}

function render(macro, asset, options) {
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
  env.addFilter('formatIsoTimestamp', formatIsoTimestamp);
  env.addFilter('formatSqliteTimestamp', formatSqliteTimestamp);
  return env.renderString(
    `{% import "partials/asset-presentation.njk" as cards %}{{ cards.${macro}(asset, options) }}`,
    { asset, options },
  );
}

function attributesOf(html, selectorAttribute) {
  const tag = html.match(new RegExp(`<a [^>]*${selectorAttribute}[^>]*>`))?.[0];
  if (!tag) return null;
  return Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] ?? '']));
}

describe('asset presentation partial: host-scoped viewer trigger', () => {
  const variants = [
    ['gridCard', 'asset-card-media-link', { hideBody: true }],
    ['listCard', 'asset-list-card-media-link', { filenameLink: false }],
  ];

  it.each(variants)('%s puts the server descriptor on the eligible image link only', (macro, linkClass, base) => {
    const asset = buildReleaseAssetPresentation(row(), { selected: true });
    const html = render(macro, asset, { ...base, viewerTrigger: TRIGGER });
    const attributes = attributesOf(html, TRIGGER);
    expect(attributes).toMatchObject({
      class: linkClass,
      href: '/projects/7/assets/17',
      [TRIGGER]: '',
      'data-viewer-project': '7',
      'data-viewer-asset': '17',
      'data-viewer-filename': 'cover.png',
      'data-viewer-preview-url': asset.preview_url.replaceAll('&', '&amp;'),
      'data-viewer-original-url': '/projects/7/assets/17/original',
      'data-viewer-details-url': '/projects/7/assets/17',
    });
    expect(asset.preview_url).toMatch(/^\/projects\/7\/assets\/17\/preview/);
    if (asset.preview_revision) expect(attributes['data-viewer-revision']).toBe(asset.preview_revision);
    // Exactly one trigger: never the card, the Details link or anything else.
    expect(html.match(new RegExp(TRIGGER, 'g'))).toHaveLength(1);
    expect(html).not.toMatch(new RegExp(`<article[^>]*${TRIGGER}`));
    expect(html).not.toMatch(new RegExp(`class="asset-details-link[^>]*${TRIGGER}`));
  });

  it.each(variants)('%s omits the original for a preview-only image', (macro, _linkClass, base) => {
    const asset = buildReleaseAssetPresentation(row({ filename: 'paint.kra', extension: 'kra', mime_type: 'application/x-krita' }));
    expect(asset.preview_url).toBeTruthy();
    expect(asset.original_url).toBeNull();
    const attributes = attributesOf(render(macro, asset, { ...base, viewerTrigger: TRIGGER }), TRIGGER);
    expect(attributes['data-viewer-preview-url']).toBeTruthy();
    expect(attributes).not.toHaveProperty('data-viewer-original-url');
  });

  it.each(variants)('%s never marks video, comic, missing or unsupported assets', (macro, _linkClass, base) => {
    const ineligible = [
      row({ filename: 'clip.mp4', extension: 'mp4', mime_type: 'video/mp4' }),
      row({ filename: 'book.cbz', extension: 'cbz', mime_type: 'application/vnd.comicbook+zip' }),
      row({ is_present: 0 }),
      row({ filename: 'notes.txt', extension: 'txt', mime_type: 'text/plain' }),
    ];
    ineligible.forEach((candidate) => {
      const html = render(macro, buildReleaseAssetPresentation(candidate), { ...base, viewerTrigger: TRIGGER });
      expect(html).not.toContain(TRIGGER);
      expect(html).not.toContain('data-viewer-');
    });
    const video = render(macro, buildReleaseAssetPresentation(ineligible[0]), { ...base, viewerTrigger: TRIGGER });
    expect(video).toContain('data-asset-video-preview-trigger');
  });

  it.each(variants)('%s is unchanged for callers that do not ask for the trigger', (macro, _linkClass, base) => {
    const asset = buildReleaseAssetPresentation(row());
    const without = render(macro, asset, base);
    expect(without).not.toContain('data-viewer-');
    expect(without).not.toContain('viewer-trigger');
    // Adding the trigger only adds attributes to the existing link.
    const withTrigger = render(macro, asset, { ...base, viewerTrigger: TRIGGER });
    expect(withTrigger.replace(/ data-release-assets-viewer-trigger[^>]*(?=>)/, '')).toBe(without);
  });
});

describe('Release Manage Assets page scoping', () => {
  let db;
  let app;
  let agent;
  let tmpDir;
  let projectsRoot;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-viewer-template-'));
    projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Two images (one selected), a video, an empty CBZ comic, a text file and
  // a selected image that goes missing.
  async function fixture() {
    const project = app.locals.projectService.create({ title: 'Viewer Scope', status: 'tbd' });
    const dir = path.join(projectsRoot, project.project_dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['01-a.png', '02-b.png', '06-gone.png']) {
      await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(path.join(dir, name));
    }
    fs.writeFileSync(path.join(dir, '03-clip.mp4'), Buffer.from('not really a video'));
    fs.writeFileSync(path.join(dir, '04-comic.cbz'), Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
    fs.writeFileSync(path.join(dir, '05-notes.txt'), 'notes');
    app.locals.assetScanner.scanProjectAssets(project.id);
    const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
      .all(project.id).map((asset) => [asset.filename, String(asset.id)]));
    const release = createReleaseService({ db }).createReleaseWithSelectedAssets(project.id, { title: 'Scope Release' },
      [Number(ids['01-a.png']), Number(ids['03-clip.mp4']), Number(ids['06-gone.png'])]);
    fs.rmSync(path.join(dir, '06-gone.png'));
    app.locals.assetScanner.scanProjectAssets(project.id);
    return { projectId: project.id, releaseId: release.id, ids };
  }

  const triggerIds = (html) => [...html.matchAll(/data-release-assets-viewer-trigger data-viewer-project="(\d+)" data-viewer-asset="(\d+)"/g)]
    .map((match) => match[2]).filter((id, index, all) => all.indexOf(id) === index).sort();

  it('marks only eligible image thumbnails in Grid and List', async () => {
    const f = await fixture();
    for (const view of ['grid', 'list']) {
      const html = (await agent.get(`/releases/${f.releaseId}/assets?selection=all&view=${view}&pageSize=all`).expect(200)).text;
      // The region markup existing tests and the live engine rely on is unchanged.
      expect(html).toContain('<section data-release-assets-live-region>');
      expect(triggerIds(html)).toEqual([f.ids['01-a.png'], f.ids['02-b.png']].sort());
      expect(html.match(/data-viewer-project="(\d+)"/g).every((attr) => attr.includes(`"${f.projectId}"`))).toBe(true);
      // Video keeps its player trigger; selection and Role controls are untouched.
      expect(html).toContain('data-asset-video-preview-trigger');
      expect(html).toContain(`id="release-asset-select-${f.ids['01-a.png']}"`);
      expect(html).not.toMatch(/<(input|select|label|form|article)[^>]*data-release-assets-viewer-trigger/);
      // No Slideshow action on this page (the shared viewer dialog's own
      // playback controls stay out of this check).
      const pageContent = html.replace(/<dialog id="unified-viewer-dialog"[\s\S]*?<\/dialog>/, '');
      expect(pageContent).not.toMatch(/slideshow/i);
    }
  });

  it('keeps the trigger on a published (read-only) workspace without enabling edits', async () => {
    const f = await fixture();
    db.prepare("UPDATE releases SET published_date = '2026-01-02' WHERE id = ?").run(f.releaseId);
    const html = (await agent.get(`/releases/${f.releaseId}/assets`).expect(200)).text;
    expect(html).toContain('Asset selections are locked and read-only.');
    expect(html).not.toContain('id="release-assets-form"');
    expect(html).not.toContain('name="selectedAssetIds"');
    expect(triggerIds(html)).toEqual([f.ids['01-a.png']]);
  });

  it('does not migrate Release Detail or Project Assets thumbnails', async () => {
    const f = await fixture();
    for (const url of [`/releases/${f.releaseId}`, `/releases/${f.releaseId}?view=list`, `/projects/${f.projectId}`]) {
      const html = (await agent.get(url).expect(200)).text;
      expect(html).not.toContain(TRIGGER);
      // B7b gives Release Detail its own host trigger
      // (tests/release-detail-viewer-template.test.js), and B7c gives Project
      // Detail's release strips theirs (tests/project-detail-viewer-template.test.js).
      if (url.startsWith('/projects/')) expect(html).toContain('data-project-detail-viewer-trigger');
    }
    const projectAssets = (await agent.get(`/projects/${f.projectId}/assets`).expect(200)).text;
    expect(projectAssets).not.toContain(TRIGGER);
    expect(projectAssets).toContain('data-project-assets-preview-id');
  });
});

// C2c: Release Manage Assets opts the shared partial's Read comic link in for
// every eligible candidate comic (CBZ, CBR, CB7), selected or not, with its
// own host-scoped attribute. Membership, Role and Save controls render as
// before; missing comics keep their notice.
describe('Release Manage Assets Read comic triggers (C2c)', () => {
  const COMIC = 'data-release-assets-comic-trigger';
  let db;
  let app;
  let agent;
  let tmpDir;
  let projectsRoot;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-assets-comic-'));
    projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // A selected CBZ, an unselected CBR, an unselected CB7, a selected image and
  // a selected CBZ that goes missing.
  async function fixture() {
    const project = app.locals.projectService.create({ title: 'Comic Scope', status: 'tbd' });
    const dir = path.join(projectsRoot, project.project_dir);
    fs.mkdirSync(dir, { recursive: true });
    await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png()
      .toFile(path.join(dir, '04-a.png'));
    for (const name of ['01-zip.cbz', '02-rar.cbr', '03-seven.cb7', '05-gone.cbz']) {
      fs.writeFileSync(path.join(dir, name), Buffer.from(`comic ${name}`));
    }
    app.locals.assetScanner.scanProjectAssets(project.id);
    const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
      .all(project.id).map((asset) => [asset.filename, String(asset.id)]));
    const release = createReleaseService({ db }).createReleaseWithSelectedAssets(project.id, { title: 'Comic Scope Release' },
      [Number(ids['01-zip.cbz']), Number(ids['04-a.png']), Number(ids['05-gone.cbz'])]);
    fs.rmSync(path.join(dir, '05-gone.cbz'));
    app.locals.assetScanner.scanProjectAssets(project.id);
    return { projectId: String(project.id), releaseId: release.id, ids };
  }

  const comicIds = (html) => [...html.matchAll(new RegExp(`${COMIC} data-comic-project="(\\d+)" data-comic-asset="(\\d+)"`, 'g'))]
    .map((match) => match[2]).filter((id, index, all) => all.indexOf(id) === index).sort();

  function comicTag(html, assetId) {
    const tag = html.match(new RegExp(`<a [^>]*${COMIC} [^>]*data-comic-asset="${assetId}"[^>]*>`))?.[0];
    if (!tag) return null;
    return Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] ?? '']));
  }

  it('offers Read comic for selected and unselected CBZ/CBR/CB7 candidates in Grid and List', async () => {
    const f = await fixture();
    const readable = ['01-zip.cbz', '02-rar.cbr', '03-seven.cb7'];
    for (const view of ['grid', 'list']) {
      const html = (await agent.get(`/releases/${f.releaseId}/assets?selection=all&view=${view}&pageSize=all`).expect(200)).text;
      const region = html.match(/<section data-release-assets-live-region>[\s\S]*$/)?.[0] || '';
      expect(comicIds(html)).toEqual(readable.map((name) => f.ids[name]).sort());
      expect(comicIds(region)).toEqual(comicIds(html));
      for (const [name, format] of [['01-zip.cbz', 'CBZ'], ['02-rar.cbr', 'CBR'], ['03-seven.cb7', 'CB7']]) {
        const id = f.ids[name];
        const attributes = comicTag(html, id);
        expect(attributes).toMatchObject({
          href: `/projects/${f.projectId}/assets/${id}`,
          'data-comic-project': f.projectId,
          'data-comic-asset': id,
          'data-comic-filename': name,
          'data-comic-project-name': 'Comic Scope',
          'data-comic-details-url': `/projects/${f.projectId}/assets/${id}`,
          'aria-label': `Read comic ${name}`,
        });
        expect(attributes['data-comic-source-revision']).toMatch(/\S/);
        expect(attributes).not.toHaveProperty('data-release-assets-viewer-trigger');
        expect(html).not.toContain(`${format} comic</span>`);
        expect(html).not.toContain('data-comic-thumbnail=');
        expect(html).toContain(`src="/projects/${f.projectId}/assets/${id}/preview?v=`);
        expect(html).toContain('loading="lazy"');
      }
      // Membership controls are unchanged: the selected comic is checked, the
      // unselected ones are not, and no control or card carries the trigger.
      expect(html).toMatch(new RegExp(`id="release-asset-select-${f.ids['01-zip.cbz']}"[^>]*checked`));
      expect(html).not.toMatch(new RegExp(`id="release-asset-select-${f.ids['02-rar.cbr']}"[^>]*checked`));
      expect(html).not.toMatch(new RegExp(`<(input|select|label|form|article|button)[^>]*${COMIC}`));
      // The missing comic keeps its notice and has no reader.
      expect(comicTag(html, f.ids['05-gone.cbz'])).toBeNull();
      // Images keep their own trigger; comic endpoints stay inert until loading.
      expect(html.match(/data-release-assets-viewer-trigger data-viewer-project/g)).toHaveLength(1);
      expect(html).not.toMatch(/<img[^>]+src=[^>]*\/comic|\/manifest|\/pages\//);
      expect(html).not.toContain('data-release-detail-comic-trigger');
      expect(html).not.toContain('data-project-assets-comic-trigger');
    }
  });

  it('keeps Read comic on a published workspace without enabling edits', async () => {
    const f = await fixture();
    db.prepare("UPDATE releases SET published_date = '2026-01-02' WHERE id = ?").run(f.releaseId);
    const html = (await agent.get(`/releases/${f.releaseId}/assets?selection=all&pageSize=all`).expect(200)).text;
    expect(html).toContain('Asset selections are locked and read-only.');
    expect(html).not.toContain('name="selectedAssetIds"');
    // A read-only workspace lists only the saved selection: its readable comic.
    expect(comicIds(html)).toEqual([f.ids['01-zip.cbz']]);
  });
});
