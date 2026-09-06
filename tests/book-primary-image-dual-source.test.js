import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { openDatabase, closeDatabase, runMigrations } from '../src/db.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createManagedAssetRepository } from '../src/data/managed-asset-repository.js';
import { createBookPrimaryImageRepository } from '../src/data/book-primary-image-repository.js';
import { createBookPrimaryImageService } from '../src/services/book-primary-image-service.js';
import { createBookService } from '../src/services/book-service.js';
import { createManagedImageService } from '../src/services/managed-image-service.js';

describe('Book dual-source domain', () => {
  let db, books, assets, managed, selections, covers, service, book, projectAssets, records, logs;
  const projectSource = (id) => ({ kind: 'project_asset', id });
  const managedSource = (id) => ({ kind: 'managed_asset', id });
  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
    books = createBookRepository(db);
    assets = createAssetRepository(db);
    managed = createManagedAssetRepository(db);
    selections = createBookPrimaryImageRepository(db);
    logs = [];
    const applicationLogger = { info: (entry) => logs.push({ ...entry, inTransaction: db.inTransaction }) };
    covers = createBookPrimaryImageService({ db, bookRepository: books, assetRepository: assets,
      managedAssetRepository: managed, bookPrimaryImageRepository: selections, applicationLogger });
    service = createBookService({ bookRepository: books, bookContentRepository: {},
      chapterRepository: {}, noteRepository: {}, bookPrimaryImageService: covers, applicationLogger });
    book = books.create({ title: 'Original' });
    const project = createProjectRepository(db).create({ title: 'Images', slug: 'images',
      description: '', notes: '', status: 'tbd', priority: 'normal', plannedDate: null,
      publishedDate: null, patreonUrl: null });
    projectAssets = ['a.png', 'b.png'].map((filename) => assets.upsert(project.id, filename, {
      filename, extension: 'png', mimeType: 'image/png', sizeBytes: 20, modifiedAt: '2026-09-06',
    }));
    // Deliberately numeric-looking managed IDs: kind, never shape, selects the domain.
    records = ['1', '2'].map((id) => managed.insertCommitted({ id, storageKey: `book-covers/${id}/source.png`,
      namespace: 'book-covers', mimeType: 'image/png', sizeBytes: 20, width: 2, height: 2, sha256: 'a'.repeat(64) }));
  });
  afterEach(() => { vi.restoreAllMocks(); closeDatabase(db); });

  function select(source) {
    return source.kind === 'project_asset' ? covers.setPrimaryImage(book.id, source.id)
      : covers.setManagedPrimaryImage(book.id, source.id);
  }
  function stored(source) {
    expect(selections.findByBookId(book.id)).toEqual({ book_id: book.id,
      asset_id: source.kind === 'project_asset' ? source.id : null,
      managed_asset_id: source.kind === 'managed_asset' ? source.id : null, source });
    expect(db.prepare('SELECT count(*) n FROM book_primary_images WHERE book_id = ?').get(book.id).n).toBe(1);
  }

  it.each(['project-managed', 'managed-project', 'managed-managed', 'project-project'])(
    'switches %s, rejects stale clears/replacements, and clears the correct source', (transition) => {
      const [from, to] = transition.split('-');
      const first = from === 'project' ? projectSource(projectAssets[0].id) : managedSource(records[0].id);
      const second = to === 'project' ? projectSource(projectAssets[1].id) : managedSource(records[1].id);
      select(first);
      covers.assertExpectedPrimaryImageSource(book.id, first);
      select(second);
      stored(second);
      expect(covers.getPrimaryImageSource(book.id)).toEqual(second);
      expect(() => covers.clearPrimaryImageSource(book.id, first)).toThrow(expect.objectContaining({ code: 'STALE_CLEAR' }));
      expect(() => covers.assertExpectedPrimaryImageSource(book.id, first)).toThrow(expect.objectContaining({ code: 'STALE_SOURCE' }));
      expect(() => covers.setManagedPrimaryImage(book.id, records[0].id, { expectedSource: first }))
        .toThrow(expect.objectContaining({ code: 'STALE_SOURCE' }));
      if (from === 'project') expect(() => covers.clearPrimaryImage(book.id, first.id))
        .toThrow(expect.objectContaining({ code: 'STALE_CLEAR' }));
      stored(second);
      expect(covers.clearPrimaryImageSource(book.id, second)).toBe(true);
      expect(covers.getPrimaryImageSource(book.id)).toBeNull();
      covers.assertExpectedPrimaryImageSource(book.id, null);
      expect(managed.findById(records[0].id)).toBeDefined();
      expect(managed.findById(records[1].id)).toBeDefined();
    },
  );

  it('compares source kinds even when IDs refer to the same numeric value', () => {
    covers.setManagedPrimaryImage(book.id, String(projectAssets[0].id));
    expect(() => covers.assertExpectedPrimaryImageSource(book.id, projectSource(projectAssets[0].id)))
      .toThrow(expect.objectContaining({ code: 'STALE_SOURCE' }));
    expect(() => covers.clearPrimaryImage(book.id, projectAssets[0].id))
      .toThrow(expect.objectContaining({ code: 'STALE_CLEAR' }));
    expect(() => covers.assertExpectedPrimaryImageSource(book.id, { kind: 'project_asset', id: '1' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ID' }));
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'])('accepts WP7A verified %s metadata', (mime) => {
    db.prepare('UPDATE managed_assets SET mime_type = ? WHERE id = ?').run(mime, records[0].id);
    covers.setManagedPrimaryImage(book.id, records[0].id);
    stored(managedSource(records[0].id));
  });

  it.each(['missing', 'namespace', 'mime'])('rejects invalid managed eligibility: %s', (invalid) => {
    const record = invalid === 'missing' ? undefined : { ...records[0],
      ...(invalid === 'namespace' ? { namespace: 'other' } : { mime_type: 'image/svg+xml' }) };
    vi.spyOn(managed, 'findById').mockReturnValue(record);
    expect(() => covers.setManagedPrimaryImage(book.id, records[0].id)).toThrow(expect.objectContaining({
      code: invalid === 'missing' ? 'ASSET_NOT_FOUND' : 'ASSET_UNSUPPORTED',
    }));
    expect(selections.findByBookId(book.id)).toBeUndefined();
  });

  it('attaches mixed sources without passing managed IDs to Project lookups', () => {
    const projectBook = books.create({ title: 'Project' });
    const emptyBook = books.create({ title: 'Empty' });
    covers.setPrimaryImage(projectBook.id, projectAssets[0].id);
    const single = vi.spyOn(assets, 'findById');
    const batch = vi.spyOn(assets, 'findByIds');
    covers.setManagedPrimaryImage(book.id, records[0].id);
    expect(covers.getPrimaryImage(book.id)).toBeUndefined();
    const attached = covers.attachPrimaryImages([book, projectBook, emptyBook]);
    expect(single).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledExactlyOnceWith([projectAssets[0].id]);
    expect(attached[0].primaryImage).toMatchObject({ selectedSource: managedSource(records[0].id),
      selectedAssetId: null, state: 'unavailable', unavailableReason: 'source_unavailable',
      previewUrl: null, thumbnailUrl: null });
    expect(attached[1].primaryImage).toMatchObject({ selectedSource: projectSource(projectAssets[0].id),
      selectedAssetId: projectAssets[0].id, state: 'available' });
    expect(attached[2].primaryImage).toMatchObject({ selectedSource: null, state: 'none' });
    vi.spyOn(managed, 'findById').mockReturnValue(undefined);
    expect(covers.attachPrimaryImages([book])[0].primaryImage.unavailableReason).toBe('source_unavailable');
  });

  it('commits New and Edit Book saves together and logs only after commit', () => {
    const create = books.create;
    const update = books.update;
    vi.spyOn(books, 'create').mockImplementation((...args) => {
      expect(db.inTransaction).toBe(true);
      return create(...args);
    });
    vi.spyOn(books, 'update').mockImplementation((...args) => {
      expect(db.inTransaction).toBe(true);
      return update(...args);
    });
    const created = service.createBookWithManagedPrimaryImage({ title: ' New ' }, records[0].id);
    expect(created).not.toHaveProperty('then');
    expect(created.title).toBe('New');
    expect(covers.getPrimaryImageSource(created.id)).toEqual(managedSource(records[0].id));
    const updated = service.updateBookWithManagedPrimaryImage(created.id, { title: 'Edited' }, records[1].id,
      { expectedSource: managedSource(records[0].id) });
    expect(books.findById(updated.id).title).toBe('Edited');
    expect(covers.getPrimaryImageSource(updated.id)).toEqual(managedSource(records[1].id));
    expect(logs.map((entry) => entry.event)).toEqual([
      'book.primary_image.set', 'book.created', 'book.primary_image.set', 'book.updated',
    ]);
    expect(logs.every((entry) => entry.inTransaction === false)).toBe(true);
    service.updateBookWithManagedPrimaryImage(created.id, {}, records[1].id);
    expect(logs).toHaveLength(4);
  });

  it.each(['create', 'update'])('rolls back %s after a cover DB failure without success logs', (operation) => {
    covers.setPrimaryImage(book.id, projectAssets[0].id);
    logs.length = 0;
    // Fail after the real selection write, exercising rollback of both mutations.
    const original = selections.setManagedPrimaryImageWithOutcome;
    vi.spyOn(selections, 'setManagedPrimaryImageWithOutcome').mockImplementation((...args) => {
      original(...args);
      throw new Error('database failure');
    });
    expect(() => operation === 'create'
      ? service.createBookWithManagedPrimaryImage({ title: 'New' }, records[0].id)
      : service.updateBookWithManagedPrimaryImage(book.id, { title: 'Changed' }, records[0].id)).toThrow('database failure');
    expect(books.list()).toHaveLength(1);
    expect(books.findById(book.id).title).toBe('Original');
    stored(projectSource(projectAssets[0].id));
    expect(logs).toEqual([]);
    expect(managed.rollbackCommitted(records[0])).toBe(true);
  });

  it('rejects validation and stale Edit saves without partial changes', () => {
    covers.setManagedPrimaryImage(book.id, records[0].id);
    logs.length = 0;
    expect(() => service.createBookWithManagedPrimaryImage({ title: '' }, records[1].id)).toThrow('validation');
    expect(() => service.updateBookWithManagedPrimaryImage(book.id, { title: '' }, records[1].id)).toThrow('validation');
    expect(() => service.updateBookWithManagedPrimaryImage(book.id, { title: 'Changed' }, records[1].id,
      { expectedSource: null })).toThrow(expect.objectContaining({ code: 'STALE_SOURCE' }));
    expect(books.list()).toHaveLength(1);
    expect(books.findById(book.id).title).toBe('Original');
    stored(managedSource(records[0].id));
    expect(logs).toEqual([]);
  });

  it('refuses nested compound operations before mutation or logging', () => {
    expect(() => db.transaction(() => service.createBookWithManagedPrimaryImage({ title: 'New' }, records[0].id))())
      .toThrow('outer database transaction');
    expect(books.list()).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it('rolls back both writes and emits no success when the outer COMMIT itself fails', () => {
    db.exec(`CREATE TABLE deferred_cover_check (
      book_id INTEGER REFERENCES books(id) DEFERRABLE INITIALLY DEFERRED
    )`);
    const original = selections.setManagedPrimaryImageWithOutcome;
    vi.spyOn(selections, 'setManagedPrimaryImageWithOutcome').mockImplementation((...args) => {
      const result = original(...args);
      db.prepare('INSERT INTO deferred_cover_check VALUES (?)').run(99999);
      return result;
    });
    expect(() => service.createBookWithManagedPrimaryImage({ title: 'New' }, records[0].id)).toThrow();
    expect(books.list()).toHaveLength(1);
    expect(selections.findByBookIds(books.list().map((row) => row.id))).toEqual([]);
    expect(db.prepare('SELECT * FROM deferred_cover_check').all()).toEqual([]);
    expect(logs).toEqual([]);
    expect(managed.rollbackCommitted(records[0])).toBe(true);
  });

  it('repository managed operations compose and compare only the explicitly named source', () => {
    const source = managedSource(records[0].id);
    const first = selections.setManagedPrimaryImageWithOutcome(book.id, source.id);
    expect(first.changed).toBe(true);
    expect(first.selection.source).toEqual(source);
    expect(selections.setManagedPrimaryImageWithOutcome(book.id, source.id).changed).toBe(false);
    expect(selections.findByAssetId(projectAssets[0].id)).toEqual([]);
    expect(selections.clearPrimaryImageSourceIfMatches(book.id, projectSource(projectAssets[0].id))).toBe(false);
    expect(selections.clearPrimaryImageSourceIfMatches(book.id, managedSource(records[1].id))).toBe(false);
    expect(() => db.transaction(() => {
      selections.setPrimaryImage(book.id, projectAssets[0].id);
      throw new Error('rollback');
    })()).toThrow('rollback');
    stored(source);
    expect(selections.clearPrimaryImageSourceIfMatches(book.id, source)).toBe(true);
  });

  it('supports real WP7A rollback then guarded file compensation after a failed save', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wp7b-'));
    try {
      const ingestion = createManagedImageService({ managedAssetRoot: tmp, managedAssetRepository: managed });
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
      expect(db.inTransaction).toBe(false);
      const { record, ownershipToken } = await ingestion.createCommittedImage({ bytes });
      const file = path.join(tmp, record.storage_key);
      expect(fs.existsSync(file)).toBe(true);
      vi.spyOn(selections, 'setManagedPrimaryImageWithOutcome').mockImplementation(() => { throw new Error('save failed'); });
      expect(() => service.createBookWithManagedPrimaryImage({ title: 'New' }, record.id)).toThrow('save failed');
      expect(db.inTransaction).toBe(false);
      expect(books.list()).toHaveLength(1);
      ingestion.rollbackCommitted(ownershipToken);
      expect(managed.findById(record.id)).toBeUndefined();
      expect(fs.existsSync(file)).toBe(true);
      ingestion.compensate(ownershipToken);
      expect(fs.existsSync(file)).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
