import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createComicAdmission } from '../src/services/comic-admission.js';
import { createComicRenditionSupervisor } from '../src/services/comic-rendition-process.js';
import { buildAssetPreviewModel } from '../src/services/asset-presentation.js';
import { makeZip } from './helpers/zip-fixture.js';

let h;
const binary = (res, done) => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); };
beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-r3-cutover-'));
  const projectsRoot = path.join(root, 'projects'), appDataRoot = path.join(root, 'app'), previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  const native = createComicRenditionSupervisor();
  const renditions = { ...native, run: vi.fn(native.run) }, admission = createComicAdmission();
  const app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper: '1'.repeat(64) }, comicRuntime: { admission, renditions },
  });
  await app.locals.generatedImagePublicationLifecycle.waitForIdle();
  const project = app.locals.projectService.create({ title: 'Cutover', status: 'tbd', projectType: 'images' });
  const assets = createAssetRepository(db), meta = createAppMetaRepository(db);
  h = { root, db, app, native, renditions, admission, project, meta, assets, projectsRoot };
});
afterEach(async () => {
  h.app.locals.generatedImageRebuildService?.stop(); h.app.locals.generatedImagePublicationLifecycle?.stop();
  await h.app.locals.generatedImageRebuildService?.waitForIdle(); await h.app.locals.generatedImagePublicationLifecycle?.waitForIdle();
  h.app.locals.comicMediaService.stop(); await h.app.locals.comicMediaService.pauseForMaintenance().waitForIdle();
  await h.native.close();
  expect(h.admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  expect(h.native.snapshot()).toMatchObject({ active: 0, terminating: 0 });
  closeDatabase(h.db);
  if (!path.resolve(h.root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unsafe fixture cleanup');
  fs.rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});
describe('atomic comic card cutover', () => {
  it.each(['png', 'webp'])('delivers the card through actual configured %s Preview and preserves original Reader bytes', async format => {
    const raw = Buffer.alloc(1100 * 900 * 3); let seed = 1234567;
    for (let i = 0; i < raw.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[i] = seed & 255; }
    const original = await sharp(raw, { raw: { width: 1100, height: 900, channels: 3 } }).png().toBuffer();
    const filename = path.join(h.projectsRoot, h.project.project_dir, 'book.cbz');
    fs.writeFileSync(filename, makeZip([{ name: 'page1.png', data: original }]));
    const stat = fs.statSync(filename);
    const asset = h.assets.upsert(h.project.id, 'book.cbz', { filename: 'book.cbz', extension: 'cbz',
      mimeType: 'application/vnd.comicbook+zip', sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    for (const [key, value] of Object.entries({ 'thumbnail.format': 'png', 'thumbnail.max_dimension': '64',
      'preview.format': format, 'preview.max_dimension': '960', 'preview.webp_quality': '35' })) h.meta.setValue('images.'+key, value);
    const descriptor = buildAssetPreviewModel(asset, h.app.locals.projectImageSettingsService.getPresentationPolicy()).comic.cover;
    expect(descriptor.revisionHint).toMatch(/^[a-f0-9]{16}$/);
    expect(descriptor.urls.preview).toBe(`/projects/${h.project.id}/assets/${asset.id}/preview?v=${descriptor.revisionHint}`);
    const base = `/projects/${h.project.id}/assets/${asset.id}`;
    const manifest = (await request(h.app).get(base+'/comic')).body;
    const before = await request(h.app).get(manifest.pages[0].url).buffer(true).parse(binary);
    expect(before.body.equals(original)).toBe(true);
    const preview = await request(h.app).get(descriptor.urls.preview).buffer(true).parse(binary);
    expect(preview.status).toBe(200);
    expect(preview.headers).toMatchObject({ 'content-type': `image/${format}`, 'cache-control': 'private, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff' });
    expect(await sharp(preview.body).metadata()).toMatchObject({ format, width: 960, height: 785 });
    if (format === 'png') expect(preview.body.length).toBeGreaterThan(512 * 1024);
    expect(preview.body.length).toBeLessThanOrEqual(32 * 1024 * 1024);
    const thumbnail = await request(h.app).get(base+'/thumbnail').buffer(true).parse(binary);
    expect(thumbnail.status).toBe(200);
    expect(await sharp(thumbnail.body).metadata()).toMatchObject({ format: 'png', width: 64, height: 52 });
    const encoded = () => h.renditions.run.mock.calls.filter(([job]) => job.purpose === 'image-derivative');
    expect(encoded().map(([job]) => job.kind)).toEqual(['thumbnail', 'preview']);
    const warm = await request(h.app).get(descriptor.urls.preview).set('If-None-Match', '*').buffer(true).parse(binary);
    expect(warm.status).toBe(200); expect(warm.body.equals(preview.body)).toBe(true); expect(encoded()).toHaveLength(2);
    const after = await request(h.app).get(manifest.pages[0].url).buffer(true).parse(binary);
    expect(after.body.equals(original)).toBe(true);
    expect(h.app.locals.comicMediaService.getComicThumbnail).toBeUndefined();
    expect(h.app.locals.comicMediaService.renderComicFirstPage).toBeUndefined();
    expect((await request(h.app).get(base+'/comic/thumbnail')).status).toBe(404);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n).toBe(1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM generated_artifacts').get().n).toBe(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM generated_image_derivatives').get().n).toBe(2);
  });
});
