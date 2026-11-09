import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

// B7c: Project Detail's release-thumbnail strips mark eligible image links
// (and only those) with their own host-scoped unified-viewer trigger, through
// the shared asset presentation macro. Strip membership, order, the display
// limit, video tiles, release links and release actions render as before;
// no other host's trigger appears on the page.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const TRIGGER = 'data-project-detail-viewer-trigger';
const OTHER_TRIGGERS = ['data-release-detail-viewer-trigger', 'data-release-assets-viewer-trigger'];

function releaseItems(html) {
  const list = html.match(/<ul class="release-list">([\s\S]*?)<\/ul>/)?.[1] || '';
  return list.match(/<li>[\s\S]*?<\/li>/g) || [];
}

function releaseItem(html, releaseId) {
  return releaseItems(html).find((item) => item.includes(`<a href="/releases/${releaseId}">`)) || '';
}

const tagAttributes = (tag) => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] ?? '']),
);

// Every image link of a strip, in order, with its attributes.
function stripLinks(item) {
  return [...item.matchAll(/<a class="release-thumbnail-link"[^>]*>/g)].map((m) => tagAttributes(m[0]));
}

// Every thumbnail asset of a strip, in order (image links and video tiles).
function stripAssetIds(item) {
  const strip = item.match(/<div class="release-thumbnail-strip">[\s\S]*?<\/div>\s*$/)?.[0]
    ?? item.match(/<div class="release-thumbnail-strip">[\s\S]*/)?.[0] ?? '';
  return [...strip.matchAll(/<a class="(?:release-thumbnail-link|asset-list-card-media-link asset-video-link)" href="\/projects\/\d+\/assets\/(\d+)"/g)]
    .map((m) => m[1]);
}

describe('Project Detail release-strip unified viewer triggers', () => {
  let db;
  let app;
  let agent;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-detail-viewer-'));
    const projectsRoot = path.join(tmpDir, 'projects');
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

  // Two releases share b.png; two images share the filename same.png (in
  // different folders); a video, a Krita image (preview-only), a CBZ comic, a
  // text file and a missing image sit in the first release. A third release
  // is empty, and a fourth overflows the 12-thumbnail display limit.
  function fixture() {
    const project = app.locals.projectService.create({ title: 'Strip Viewer', status: 'tbd' });
    const projectId = String(project.id);
    const assets = createAssetRepository(db);
    const releases = createReleaseRepository(db);
    const upsert = (relativePath, extension, mimeType) => {
      const filename = relativePath.split('/').pop();
      return assets.upsert(project.id, relativePath, {
        filename, extension, mimeType, sizeBytes: 4096, modifiedAt: '2026-08-06 12:00:00',
      });
    };
    const a = upsert('a.png', 'png', 'image/png');
    const b = upsert('b.png', 'png', 'image/png');
    const sameOne = upsert('one/same.png', 'png', 'image/png');
    const sameTwo = upsert('two/same.png', 'png', 'image/png');
    const clip = upsert('clip.webm', 'webm', 'video/webm');
    const paint = upsert('paint.kra', 'kra', 'application/x-krita');
    const comic = upsert('book.cbz', 'cbz', 'application/vnd.comicbook+zip');
    const notes = upsert('notes.txt', 'txt', 'text/plain');
    const gone = upsert('gone.png', 'png', 'image/png');
    db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(gone.id);
    const overflow = Array.from({ length: 13 }, (_, index) => upsert(`fill-${index}.png`, 'png', 'image/png'));
    const create = (title) => releases.create({
      projectId: project.id, title, description: '', notes: '', plannedDate: null, plannedTime: null, patreonUrl: null, publishedDate: null,
    });
    const mixed = create('Mixed Release');
    const shared = create('Shared Release');
    const empty = create('Empty Release');
    const full = create('Full Release');
    // Saved order puts b.png before a.png.
    [b, a, clip, paint, comic, notes, gone, sameOne].forEach((asset, index) => releases.addReleaseAsset(mixed.id, asset.id, 'attachment', index));
    [sameTwo, b].forEach((asset, index) => releases.addReleaseAsset(shared.id, asset.id, 'attachment', index));
    overflow.forEach((asset, index) => releases.addReleaseAsset(full.id, asset.id, 'attachment', index));
    const ids = Object.fromEntries(Object.entries({ a, b, sameOne, sameTwo, clip, paint, comic, notes, gone })
      .map(([name, asset]) => [name, String(asset.id)]));
    return { projectId, ids, overflow: overflow.map((asset) => String(asset.id)), mixed, shared, empty, full };
  }

  it('marks only eligible strip images, in saved order, with server descriptors and their release', async () => {
    const f = fixture();
    const html = (await agent.get(`/projects/${f.projectId}`).expect(200)).text;
    const mixed = releaseItem(html, f.mixed.id);
    expect(mixed).not.toBe('');

    // Strip membership and order exactly as before: images and the video only.
    expect(stripAssetIds(mixed)).toEqual([f.ids.b, f.ids.a, f.ids.clip, f.ids.paint, f.ids.sameOne]);
    const links = stripLinks(mixed);
    expect(links.map((link) => link['data-viewer-asset'])).toEqual([f.ids.b, f.ids.a, f.ids.paint, f.ids.sameOne]);
    links.forEach((link) => {
      expect(link).toHaveProperty(TRIGGER, '');
      expect(link['data-viewer-release']).toBe(String(f.mixed.id));
      expect(link['data-viewer-project']).toBe(f.projectId);
    });

    const [b] = links;
    expect(b).toMatchObject({
      class: 'release-thumbnail-link',
      href: `/projects/${f.projectId}/assets/${f.ids.b}`,
      'aria-label': 'View b.png',
      'data-viewer-filename': 'b.png',
      'data-viewer-original-url': `/projects/${f.projectId}/assets/${f.ids.b}/original`,
      'data-viewer-details-url': `/projects/${f.projectId}/assets/${f.ids.b}`,
    });
    expect(b['data-viewer-preview-url']).toMatch(new RegExp(`^/projects/${f.projectId}/assets/${f.ids.b}/preview\\?v=`));
    expect(b['data-viewer-revision']).toBeTruthy();
    expect(b['data-viewer-preview-url']).toContain(b['data-viewer-revision']);
    // The thumbnail image itself is unchanged.
    expect(mixed).toContain(`<img class="release-thumbnail-image" src="/projects/${f.projectId}/assets/${f.ids.b}/thumbnail?v=${b['data-viewer-revision']}" alt="b.png" loading="lazy" decoding="async">`);

    // Preview-only (Krita): zoomable preview, no invented original.
    const paint = links.find((link) => link['data-viewer-asset'] === f.ids.paint);
    expect(paint['data-viewer-preview-url']).toMatch(/\/preview\?v=/);
    expect(paint).not.toHaveProperty('data-viewer-original-url');

    // The video keeps its own shared tile and trigger, never this one.
    expect(mixed).toMatch(new RegExp(`data-asset-video-preview-trigger data-video-src="/projects/${f.projectId}/assets/${f.ids.clip}/original"`));
    expect(mixed).not.toMatch(new RegExp(`<a [^>]*data-asset-video-preview-trigger[^>]*${TRIGGER}`));
    expect(mixed).not.toMatch(new RegExp(`<a [^>]*${TRIGGER}[^>]*data-asset-video-preview-trigger`));
    // Comic, unsupported and missing assets are not in the strip at all.
    for (const name of ['comic', 'notes', 'gone']) {
      expect(mixed).not.toContain(`/assets/${f.ids[name]}"`);
    }
    expect(html).not.toMatch(/\/manifest|\/pages\//);
  });

  it('keeps the same asset distinct per release, and duplicate filenames distinct per asset', async () => {
    const f = fixture();
    const html = (await agent.get(`/projects/${f.projectId}`).expect(200)).text;
    const shared = stripLinks(releaseItem(html, f.shared.id));
    const mixed = stripLinks(releaseItem(html, f.mixed.id));
    expect(shared.map((link) => [link['data-viewer-asset'], link['data-viewer-release']]))
      .toEqual([[f.ids.sameTwo, String(f.shared.id)], [f.ids.b, String(f.shared.id)]]);
    const bInMixed = mixed.find((link) => link['data-viewer-asset'] === f.ids.b);
    const bInShared = shared.find((link) => link['data-viewer-asset'] === f.ids.b);
    expect(bInMixed['data-viewer-release']).toBe(String(f.mixed.id));
    expect(bInShared['data-viewer-release']).toBe(String(f.shared.id));
    expect(bInShared['data-viewer-preview-url']).toBe(bInMixed['data-viewer-preview-url']);

    const sameOne = mixed.find((link) => link['data-viewer-filename'] === 'same.png');
    const sameTwo = shared.find((link) => link['data-viewer-filename'] === 'same.png');
    expect(sameOne['data-viewer-asset']).toBe(f.ids.sameOne);
    expect(sameTwo['data-viewer-asset']).toBe(f.ids.sameTwo);
    expect(sameOne['data-viewer-preview-url']).not.toBe(sameTwo['data-viewer-preview-url']);
  });

  it('keeps the display limit, the "+N more" link, empty releases and release links', async () => {
    const f = fixture();
    const html = (await agent.get(`/projects/${f.projectId}`).expect(200)).text;
    const full = releaseItem(html, f.full.id);
    expect(stripLinks(full).map((link) => link['data-viewer-asset'])).toEqual(f.overflow.slice(0, 12));
    expect(full).toContain(`<a class="release-thumbnail-more" href="/releases/${f.full.id}">+1 more</a>`);
    expect(full).not.toMatch(new RegExp(`release-thumbnail-more[^>]*${TRIGGER}`));
    const empty = releaseItem(html, f.empty.id);
    expect(empty).not.toBe('');
    expect(empty).not.toContain('release-thumbnail-strip');
    expect(empty).not.toContain(TRIGGER);
    // Release title links stay plain links; nothing but strip image links is a trigger.
    for (const release of [f.mixed, f.shared, f.empty, f.full]) {
      expect(html).toContain(`<a href="/releases/${release.id}">${release.title}</a>`);
    }
    expect(html).not.toMatch(new RegExp(`<(?!a class="release-thumbnail-link")[^>]*${TRIGGER}`));
    expect(html.match(new RegExp(TRIGGER, 'g'))).toHaveLength(
      stripLinks(releaseItem(html, f.mixed.id)).length + 2 + 12,
    );
    OTHER_TRIGGERS.forEach((other) => expect(html).not.toContain(other));
    // One shared viewer dialog; the video dialog stays separate; no Slideshow action.
    expect(html.match(/<dialog id="unified-viewer-dialog"/g)).toHaveLength(1);
    expect(html.match(/<dialog id="asset-video-preview-dialog"/g)).toHaveLength(1);
    expect(html.replace(/<dialog id="unified-viewer-dialog"[\s\S]*?<\/dialog>/, '')).not.toMatch(/slideshow/i);
  });

  it('keeps triggers for published, archived and read-only releases without enabling edits', async () => {
    const f = fixture();
    db.prepare("UPDATE releases SET published_date = '2026-01-02' WHERE id = ?").run(f.mixed.id);
    db.prepare("UPDATE releases SET archived_at = '2026-02-03 10:00:00' WHERE id = ?").run(f.shared.id);
    const html = (await agent.get(`/projects/${f.projectId}`).expect(200)).text;
    expect(releaseItem(html, f.mixed.id)).toContain('published 2026-01-02');
    expect(stripLinks(releaseItem(html, f.mixed.id))).toHaveLength(4);
    expect(stripLinks(releaseItem(html, f.shared.id))).toHaveLength(2);

    db.prepare("UPDATE projects SET archived_at = '2026-03-04 10:00:00' WHERE id = ?").run(Number(f.projectId));
    const archived = (await agent.get(`/projects/${f.projectId}`).expect(200)).text;
    expect(archived).toContain('This project is archived and read-only.');
    expect(archived).not.toContain(`href="/releases/new?projectId=${f.projectId}"`);
    expect(archived).not.toContain('id="project-edit-dialog"');
    expect(stripLinks(releaseItem(archived, f.mixed.id))).toHaveLength(4);
  });
});
