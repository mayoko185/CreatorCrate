import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createReleaseService } from '../src/services/release-service.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

// B7b: Release Detail asks the shared asset presentation partial for its own
// host-scoped unified-viewer trigger on eligible selected images only. Its
// saved membership, Role/Order presentation, release actions and read-only
// states render as before; Release Manage Assets' trigger never appears here.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const TRIGGER = 'data-release-detail-viewer-trigger';
const B7A_TRIGGER = 'data-release-assets-viewer-trigger';

function selectedSection(html) {
  return html.match(/<section class="asset-browser-layout" aria-label="Selected assets" data-selected-assets>[\s\S]*?<\/section>/)?.[0] || '';
}

const triggerIds = (html) => [...html.matchAll(new RegExp(`${TRIGGER} data-viewer-project="(\\d+)" data-viewer-asset="(\\d+)"`, 'g'))]
  .map((match) => match[2]);

const articleIds = (html) => [...html.matchAll(/<article [^>]*data-asset-id="(\d+)"/g)].map((match) => match[1]);

function triggerTag(html, assetId) {
  const tag = html.match(new RegExp(`<a [^>]*${TRIGGER} [^>]*data-viewer-asset="${assetId}"[^>]*>`))?.[0];
  if (!tag) return null;
  return Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] ?? '']));
}

describe('Release Detail unified viewer triggers', () => {
  let db;
  let app;
  let agent;
  let tmpDir;
  let projectsRoot;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-detail-viewer-'));
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

  // Selected, in saved order: two images, a video, an empty CBZ comic, a text
  // file and an image that goes missing. 08-unselected.png is not in the
  // release. (Preview-only originals are covered by the partial's own tests.)
  async function fixture() {
    const project = app.locals.projectService.create({ title: 'Detail Viewer', status: 'tbd' });
    const dir = path.join(projectsRoot, project.project_dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['01-a.png', '06-b.png', '07-gone.png', '08-unselected.png']) {
      await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(path.join(dir, name));
    }
    fs.writeFileSync(path.join(dir, '03-clip.mp4'), Buffer.from('not really a video'));
    fs.writeFileSync(path.join(dir, '04-comic.cbz'), Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
    fs.writeFileSync(path.join(dir, '05-notes.txt'), 'notes');
    app.locals.assetScanner.scanProjectAssets(project.id);
    const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
      .all(project.id).map((asset) => [asset.filename, String(asset.id)]));
    // Saved order puts the second image first.
    const order = ['06-b.png', '01-a.png', '03-clip.mp4', '04-comic.cbz', '05-notes.txt', '07-gone.png'];
    const release = createReleaseService({ db }).createReleaseWithSelectedAssets(project.id, { title: 'Detail Release' },
      order.map((name) => Number(ids[name])));
    fs.rmSync(path.join(dir, '07-gone.png'));
    app.locals.assetScanner.scanProjectAssets(project.id);
    return { projectId: String(project.id), releaseId: release.id, ids, order };
  }

  it('marks only eligible selected image thumbnails, in Grid and List, with server descriptors', async () => {
    const f = await fixture();
    for (const view of ['grid', 'list']) {
      const html = (await agent.get(`/releases/${f.releaseId}${view === 'list' ? '?view=list' : ''}`).expect(200)).text;
      const section = selectedSection(html);
      expect(section).not.toBe('');
      // Only the two present images, in saved order; nothing else on the page.
      expect(triggerIds(section)).toEqual([f.ids['06-b.png'], f.ids['01-a.png']]);
      expect(triggerIds(html)).toEqual(triggerIds(section));
      const attributes = triggerTag(section, f.ids['01-a.png']);
      expect(attributes).toMatchObject({
        class: view === 'grid' ? 'asset-card-media-link' : 'asset-list-card-media-link',
        href: `/projects/${f.projectId}/assets/${f.ids['01-a.png']}`,
        [TRIGGER]: '',
        'data-viewer-project': f.projectId,
        'data-viewer-asset': f.ids['01-a.png'],
        'data-viewer-filename': '01-a.png',
        'data-viewer-original-url': `/projects/${f.projectId}/assets/${f.ids['01-a.png']}/original`,
        'data-viewer-details-url': `/projects/${f.projectId}/assets/${f.ids['01-a.png']}`,
      });
      expect(attributes['data-viewer-preview-url']).toMatch(new RegExp(`^/projects/${f.projectId}/assets/${f.ids['01-a.png']}/preview`));
      expect(attributes['data-viewer-revision']).toBeTruthy();
      // Never on a card, a Details link, a filename link, a list title or a video.
      expect(html).not.toMatch(new RegExp(`<(article|button|li|section|form|input)[^>]*${TRIGGER}`));
      expect(html).not.toMatch(new RegExp(`class="asset-details-link[^>]*${TRIGGER}`));
      expect(html).not.toMatch(new RegExp(`class="[^"]*asset-file-link[^>]*${TRIGGER}`));
      expect(html).not.toMatch(new RegExp(`data-asset-video-preview-trigger[^>]*${TRIGGER}`));
      expect(section).toContain('data-asset-video-preview-trigger');
      // Release Manage Assets' host trigger never appears on Release Detail.
      expect(html).not.toContain(B7A_TRIGGER);
      // No Slideshow action (the shared viewer dialog's own controls aside).
      expect(html.replace(/<dialog id="unified-viewer-dialog"[\s\S]*?<\/dialog>/, '')).not.toMatch(/slideshow/i);
      expect(html).toContain('id="unified-viewer-dialog"');
      // Saved membership and order are presented exactly as saved.
      expect(articleIds(section)).toEqual(f.order.map((name) => f.ids[name]));
      expect(articleIds(section)).not.toContain(f.ids['08-unselected.png']);
    }
  });

  it('keeps Role and Order presentation and the Details/filename navigation', async () => {
    const f = await fixture();
    const grid = selectedSection((await agent.get(`/releases/${f.releaseId}`).expect(200)).text);
    const orders = [...grid.matchAll(/<strong>Order<\/strong> (\d+)/g)].map((match) => Number(match[1]));
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(orders).toHaveLength(f.order.length);
    expect(grid.match(/<strong>Role<\/strong> \w+/g)).toHaveLength(f.order.length);
    const assetUrl = `/projects/${f.projectId}/assets/${f.ids['01-a.png']}`;
    expect(grid).toContain(`<a class="asset-card-title-text asset-file-link" href="${assetUrl}">`);
    expect(grid).toMatch(new RegExp(`<a class="asset-details-link[^"]*" href="${assetUrl}"`));

    const list = selectedSection((await agent.get(`/releases/${f.releaseId}?view=list`).expect(200)).text);
    expect(list).toMatch(new RegExp(`<a class="button button-small button-secondary" href="${assetUrl}">Open asset</a>`));
    expect(list).toContain(`aria-controls="release-asset-list-info-${f.ids['01-a.png']}"`);
  });

  it('keeps triggers on published and archived releases without enabling edits', async () => {
    const f = await fixture();
    db.prepare("UPDATE releases SET published_date = '2026-01-02' WHERE id = ?").run(f.releaseId);
    const published = (await agent.get(`/releases/${f.releaseId}`).expect(200)).text;
    expect(published).toContain('This release is published.');
    expect(published).not.toContain(`href="/releases/${f.releaseId}/assets"`);
    expect(published).not.toContain('data-dialog-open="release-publish-dialog"');
    expect(triggerIds(selectedSection(published))).toEqual([f.ids['06-b.png'], f.ids['01-a.png']]);

    db.prepare("UPDATE releases SET archived_at = '2026-02-03 10:00:00' WHERE id = ?").run(f.releaseId);
    const archived = (await agent.get(`/releases/${f.releaseId}`).expect(200)).text;
    expect(archived).toContain('This release is archived and read-only.');
    expect(archived).toContain('data-release-detail-archived');
    expect(archived).not.toContain('data-release-edit-id=');
    expect(triggerIds(selectedSection(archived))).toEqual([f.ids['06-b.png'], f.ids['01-a.png']]);
  });

  it('leaves Project Detail strips and Release Manage Assets to their own hosts', async () => {
    const f = await fixture();
    const projectDetail = (await agent.get(`/projects/${f.projectId}`).expect(200)).text;
    expect(projectDetail).not.toContain(TRIGGER);
    // Project Detail strips carry their own host's trigger (B7c) instead.
    expect(projectDetail).toContain('data-project-detail-viewer-trigger');
    const manage = (await agent.get(`/releases/${f.releaseId}/assets`).expect(200)).text;
    expect(manage).not.toContain(TRIGGER);
    expect(manage).toContain(B7A_TRIGGER);
  });
});
