import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../src/db.js';
import { AUTH_CONFIG, authenticate } from './helpers/auth.js';
import { buildBookPrimaryImageModel, resolveBookPrimaryImageMedia } from '../src/services/primary-image-presenter.js';

describe('WP7C2 managed media HTTP and Book presentation', () => {
  let tmp, db, app, agent, record, book, sourceFile;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wp7c2-'));
    db = openDatabase(':memory:');
    runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
    app = createApp({ appName: 'CreatorCrate', db, previewRoot: path.join(tmp, 'previews') }, {
      appDataRoot: tmp, authConfig: AUTH_CONFIG,
    });
    ({ agent } = await authenticate(app));
    const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
    ({ record } = await app.locals.managedImageService.createCommittedImage({ bytes }));
    sourceFile = path.join(tmp, 'assets', record.storage_key);
    book = app.locals.bookService.createBook({ title: 'Managed cover' });
    app.locals.bookPrimaryImageService.setManagedPrimaryImage(book.id, record.id);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const url = (id, kind = 'thumbnail') => `/managed-assets/${id}/${kind}`;
  function selected() {
    expect(app.locals.bookPrimaryImageService.getPrimaryImageSource(book.id))
      .toEqual({ kind: 'managed_asset', id: record.id });
  }
  it.each(['thumbnail', 'preview'])('serves authenticated %s bytes with media headers; anonymous requests cannot generate media', async (kind) => {
    const spy = vi.spyOn(app.locals.managedAssetRepository, 'findById');
    const anonymous = await request(app).get(url(record.id, kind));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toContain('/login');
    expect(spy).not.toHaveBeenCalled();
    const res = await agent.get(url(record.id, kind)).expect(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect((await sharp(res.body).metadata()).format).toBe('webp');
    expect(res.body).toEqual((await app.locals.managedMediaService.getDerivative(record.id, kind)).bytes);
  });
  it.each(['missing', 'corrupt'])('keeps %s source selected and returns safe unavailable media and cover', async (damage) => {
    if (damage === 'missing') fs.unlinkSync(sourceFile);
    else fs.writeFileSync(sourceFile, 'corrupt');
    for (const kind of ['thumbnail', 'preview']) {
      const res = await agent.get(url(record.id, kind)).expect(404);
      expect(res.text).toBe('Not found');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
    const [presented] = await resolveBookPrimaryImageMedia(
      app.locals.bookPrimaryImageService.attachPrimaryImages([book]), app.locals.managedMediaService);
    expect(presented.primaryImage).toMatchObject({ state: 'unavailable', unavailableReason: 'source_unavailable',
      selectedAssetId: null, selectedSource: { kind: 'managed_asset', id: record.id }, thumbnailUrl: null, previewUrl: null });
    for (const route of ['/notes', `/notes/books/${book.id}`, `/notes/books/${book.id}/edit`]) {
      const res = await agent.get(route).expect(200);
      expect(res.text).toContain('Image unavailable');
      expect(res.text).not.toContain(url(record.id));
      expect(res.text).not.toContain(record.storage_key);
    }
    selected();
    expect(app.locals.managedAssetRepository.findById(record.id)).toBeDefined();
  });
  it('maps cache infrastructure failure to the existing safe 503 behavior', async () => {
    fs.writeFileSync(path.join(tmp, 'previews'), 'not a directory');
    const res = await agent.get(url(record.id)).expect(503);
    expect(res.text).toBe('Preview unavailable');
    expect(res.headers['cache-control']).toBe('no-store');
    selected();
  });
  it('rejects missing/malformed IDs before repository access and ignores path inputs', async () => {
    const lookup = vi.spyOn(app.locals.managedAssetRepository, 'findById');
    const projectLookup = vi.spyOn(app.locals.projectService, 'findById');
    const assetLookup = vi.spyOn(app.locals.assetScanner.repository, 'findById');
    for (const id of ['1', 'invalid', '..%5Csource.png', '%2Fetc%2Fpasswd']) {
      await agent.get(url(id)).expect(404);
    }
    expect(lookup).not.toHaveBeenCalled();
    await agent.get(url('00000000-0000-0000-0000-000000000000')).expect(404);
    const res = await agent.get(url(record.id)).query({ path: sourceFile, storage_key: '../other', kind: 'original' }).expect(200);
    expect((await sharp(res.body).metadata()).format).toBe('webp');
    for (const suffix of ['original', 'source.png', 'metadata']) await agent.get(`/managed-assets/${record.id}/${suffix}`).expect(404);
    await agent.get(`/managed-assets/${record.id}`).expect(404);
    await agent.get(`/assets/${record.storage_key}`).expect(404);
    expect(projectLookup).not.toHaveBeenCalled();
    expect(assetLookup).not.toHaveBeenCalled();
  });
  it.each(['available', 'unavailable'])('renders Chapter and Note navigation with a %s managed selection without inventing covers', async (state) => {
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
    const note = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Page' });
    if (state === 'unavailable') fs.unlinkSync(sourceFile);
    for (const route of [`/notes/chapters/${chapter.id}`, `/notes/chapters/${chapter.id}/edit`, `/notes/${note.id}`, `/notes/${note.id}/edit`, `/notes/new?chapterId=${chapter.id}`]) {
      const res = await agent.get(route).expect(200);
      expect(res.text).toContain(`/notes/books/${book.id}`);
      expect(res.text).not.toContain(record.storage_key);
      expect(res.text).not.toContain('/managed-assets/');
    }
    selected();
  });
  it('presents mixed Books without Project identity or Project lookup fallback', async () => {
    const project = { id: 42, primaryImage: buildBookPrimaryImageModel(
      { asset_id: 7, source: { kind: 'project_asset', id: 7 } },
      { id: 7, project_id: 9, is_present: 1, extension: 'png', mime_type: 'image/png', relative_path: 'cover.png', size_bytes: 100, modified_at: '2026-09-06 12:00:00' }) };
    const none = { id: 43, primaryImage: buildBookPrimaryImageModel(null, null) };
    const managed = app.locals.bookPrimaryImageService.attachPrimaryImages([book])[0];
    const result = await resolveBookPrimaryImageMedia([none, project, managed], app.locals.managedMediaService);
    expect(result[0]).toBe(none);
    expect(result[1]).toBe(project);
    expect(project.primaryImage.previewUrl).toContain('/projects/9/assets/7/preview');
    expect(result[2].primaryImage).toMatchObject({ state: 'available', selectedAssetId: null,
      selectedSource: { kind: 'managed_asset', id: record.id }, thumbnailUrl: url(record.id), previewUrl: url(record.id, 'preview') });
    const shelf = await agent.get('/notes').expect(200);
    expect(shelf.text).toContain(url(record.id));
    for (const route of [`/notes/books/${book.id}`, `/notes/books/${book.id}/edit`, `/notes/books/${book.id}/chapters/new`, `/notes/new?bookId=${book.id}`]) {
      const res = await agent.get(route).expect(200);
      expect(res.text).toContain(url(record.id, 'preview'));
      expect(res.text).not.toContain('asset-image--nsfw-blurred');
    }
    selected();
  });
});
