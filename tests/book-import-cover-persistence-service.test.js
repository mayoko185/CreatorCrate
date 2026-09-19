import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createBookImportPersistenceRepository } from '../src/data/book-import-persistence-repository.js';
import { createBookPrimaryImageRepository } from '../src/data/book-primary-image-repository.js';
import { createManagedAssetRepository } from '../src/data/managed-asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  BookImportCoverPersistenceError,
  createBookImportCoverPersistenceService,
} from '../src/services/book-import-cover-persistence-service.js';
import { createBookImportPersistenceService } from '../src/services/book-import-persistence-service.js';
import { createManagedImageService } from '../src/services/managed-image-service.js';
import { makeAnimatedWebp } from './helpers/animated-webp.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const WHEN = '2026-09-18 12:00:00';

function locator(slug = 'cover-project', relativePath = 'art/cover.png') {
  return {
    project: { slug, title: 'Cover Project', projectType: 'images' },
    relativePath,
    filename: path.posix.basename(relativePath),
    extension: path.posix.extname(relativePath).slice(1),
    mimeType: 'image/png',
  };
}

function media(bytes, mimeType = 'image/webp') {
  return {
    path: 'validated/archive/path.webp',
    mimeType,
    sizeBytes: bytes.length,
    width: 2,
    height: 2,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function book(key, cover, { populated = false } = {}) {
  const page = {
    key: `${key}-page`, chapterKey: null, title: `${key} Page`, rawMarkdown: 'body',
    createdAt: WHEN, updatedAt: WHEN,
    associations: { projects: [], assets: [], unresolvedProjectCount: 0, unresolvedAssetCount: 0 },
    revisions: populated ? [{
      key: `${key}-revision`, title: 'Revision', rawMarkdown: 'old',
      sourceUpdatedAt: WHEN, createdAt: WHEN,
      associations: { projects: [], assets: [], unresolvedProjectCount: 0, unresolvedAssetCount: 0 },
    }] : [],
  };
  return {
    key,
    title: `Imported ${key}`,
    createdAt: WHEN,
    updatedAt: WHEN,
    rootContents: populated ? [{ type: 'page', key: page.key }] : [],
    chapters: [],
    pages: populated ? [page] : [],
    previewSettings: {
      mode: populated ? 'selected' : 'random',
      randomCount: 5,
      selectedPageKeys: populated ? [page.key] : [],
    },
    cover,
  };
}

const plan = (books) => ({ format: 'creatorcrate-books', version: 1, books });

function failingRepository(db, method, occurrence = 1) {
  const base = createBookImportPersistenceRepository(db);
  let calls = 0;
  return {
    ...base,
    [method](...args) {
      calls += 1;
      if (calls === occurrence) throw new Error(`Injected ${method} failure`);
      return base[method](...args);
    },
  };
}

describe('Book import cover persistence', () => {
  let db;
  let tmpDir;
  let managedRoot;
  let managedAssets;
  let managedImages;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-import-covers-'));
    managedRoot = path.join(tmpDir, 'managed');
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    managedAssets = createManagedAssetRepository(db);
    managedImages = createManagedImageService({
      managedAssetRoot: managedRoot,
      managedAssetRepository: managedAssets,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (db?.open) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function service(overrides = {}) {
    return createBookImportCoverPersistenceService({ db, managedImageService: managedImages, ...overrides });
  }

  function insertProjectAsset({ slug = 'cover-project', relativePath = 'art/cover.png',
    extension = 'png', mimeType = 'image/png', present = true } = {}) {
    const project = createProjectRepository(db).create({
      title: 'Cover Project', slug, description: '', notes: '', status: 'tbd',
      projectType: 'images', patreonUrl: null,
    });
    const asset = createAssetRepository(db).upsert(project.id, relativePath, {
      filename: path.posix.basename(relativePath), extension, mimeType,
      sizeBytes: 100, modifiedAt: '2026-09-18T12:00:00.000Z',
    });
    if (!present) db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
    return { project, asset: createAssetRepository(db).findById(asset.id) };
  }

  function managedRows() {
    return db.prepare('SELECT * FROM managed_assets ORDER BY id').all();
  }

  function storedBytes(record) {
    return fs.readFileSync(path.join(managedRoot, record.storage_key));
  }

  it('persists a mixed multi-Book import with exact animated managed bytes, Project relink, fallback, and no cover', async () => {
    const animatedManaged = await makeAnimatedWebp(2);
    const animatedFallback = await makeAnimatedWebp(3);
    const { asset } = insertProjectAsset();
    const createSpy = vi.fn((input) => managedImages.createCommittedImage(input));
    const authority = { ...managedImages, createCommittedImage: createSpy };
    let extensionObserved = false;

    const result = await service({ managedImageService: authority }).persistValidatedPlan(plan([
      book('none', { kind: 'none' }),
      book('managed', { kind: 'managed', media: media(animatedManaged) }),
      book('relinked', { kind: 'project_asset', source: locator(), media: media(animatedFallback) }),
      book('fallback', {
        kind: 'project_asset', source: locator('missing-project'), media: media(animatedFallback),
      }),
    ]), {
      persistAdditionalInTransaction(importContext) {
        extensionObserved = db.inTransaction && importContext.books.length === 4;
      },
    });

    expect(extensionObserved).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls.map(([input]) => input.bytes)).toEqual([animatedManaged, animatedFallback]);
    expect(createSpy.mock.calls.every(([input]) => input.namespace === 'book-covers')).toBe(true);
    expect(result.books.map(({ coverOutcome }) => coverOutcome)).toEqual([
      { kind: 'none' },
      expect.objectContaining({ kind: 'managed', managedAssetId: expect.any(String) }),
      expect.objectContaining({ kind: 'project_asset', destinationProjectAssetId: asset.id, relinked: true }),
      expect.objectContaining({
        kind: 'managed', sourceKind: 'project_asset', unresolvedReason: 'project_not_found',
        relinked: false, managedAssetId: expect.any(String),
      }),
    ]);
    expect(result.books[1].sourceCover).toBe(result.books[1].cover);
    expect(result.books[2].coverOutcome.locator).toEqual(locator());

    const rowsById = new Map(managedRows().map((row) => [row.id, row]));
    const rows = [
      rowsById.get(result.books[1].coverOutcome.managedAssetId),
      rowsById.get(result.books[3].coverOutcome.managedAssetId),
    ];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.mime_type, row.width, row.height, row.size_bytes, row.sha256])).toEqual([
      ['image/webp', 2, 2, animatedManaged.length,
        crypto.createHash('sha256').update(animatedManaged).digest('hex')],
      ['image/webp', 2, 2, animatedFallback.length,
        crypto.createHash('sha256').update(animatedFallback).digest('hex')],
    ]);
    expect(rows.map(storedBytes)).toEqual([animatedManaged, animatedFallback]);
    expect(db.prepare('SELECT asset_id, managed_asset_id FROM book_primary_images ORDER BY book_id').all())
      .toEqual([
        { asset_id: null, managed_asset_id: result.books[1].coverOutcome.managedAssetId },
        { asset_id: asset.id, managed_asset_id: null },
        { asset_id: null, managed_asset_id: result.books[3].coverOutcome.managedAssetId },
      ]);
  });

  it('creates no media and performs no Project lookup for a no-cover import', async () => {
    const projects = createProjectRepository(db);
    const projectSpy = vi.spyOn(projects, 'findBySlug');
    const createSpy = vi.fn((input) => managedImages.createCommittedImage(input));
    const result = await service({
      projectRepository: projects,
      managedImageService: { ...managedImages, createCommittedImage: createSpy },
    })
      .persistValidatedPlan(plan([book('none', { kind: 'none' })]));

    expect(result.books[0].coverOutcome).toEqual({ kind: 'none' });
    expect(projectSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('uses portable managed fallback for a matching but non-eligible destination Asset', async () => {
    const bytes = await makeAnimatedWebp(2);
    insertProjectAsset({ present: false });
    const result = await service().persistValidatedPlan(plan([book('fallback', {
      kind: 'project_asset', source: locator(), media: media(bytes),
    })]));

    expect(result.books[0].coverOutcome).toMatchObject({
      kind: 'managed', relinked: false, unresolvedReason: 'asset_missing',
    });
    expect(storedBytes(managedRows()[0])).toEqual(bytes);
  });

  it('compensates earlier prepared media when later preparation fails before Book persistence', async () => {
    const firstBytes = await makeAnimatedWebp(2);
    const secondBytes = await makeAnimatedWebp(3);
    let calls = 0;
    const authority = {
      ...managedImages,
      async createCommittedImage(input) {
        calls += 1;
        if (calls === 2) throw new TypeError('Injected image authority failure');
        return managedImages.createCommittedImage(input);
      },
    };

    await expect(service({ managedImageService: authority }).persistValidatedPlan(plan([
      book('one', { kind: 'managed', media: media(firstBytes) }),
      book('two', { kind: 'managed', media: media(secondBytes) }),
    ]))).rejects.toMatchObject({ code: 'COVER_PREPARATION_FAILED' });
    expect(db.prepare('SELECT COUNT(*) FROM books').pluck().get()).toBe(0);
    expect(managedRows()).toEqual([]);
    expect(fs.existsSync(path.join(managedRoot, 'book-covers'))
      ? fs.readdirSync(path.join(managedRoot, 'book-covers')) : []).toEqual([]);
  });

  it('treats resolver faults as operational failures and compensates prior preparation', async () => {
    const bytes = await makeAnimatedWebp(2);
    const projects = createProjectRepository(db);
    vi.spyOn(projects, 'findBySlug').mockImplementation(() => { throw new TypeError('resolver outage'); });

    let thrown;
    try {
      await service({ projectRepository: projects }).persistValidatedPlan(plan([
        book('managed', { kind: 'managed', media: media(bytes) }),
        book('project', { kind: 'project_asset', source: locator(), media: media(bytes) }),
      ]));
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: 'COVER_PREPARATION_FAILED' });
    expect(thrown.cause).toBeInstanceOf(TypeError);
    expect(managedRows()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM books').pluck().get()).toBe(0);
  });

  it.each([
    ['Book 2', 'insertBook', 2],
    ['Page', 'insertPage', 1],
    ['revision', 'insertRevision', 1],
    ['hierarchy', 'insertBookContent', 1],
    ['preview setting', 'insertPreviewSettings', 1],
    ['preview Page', 'insertPreviewPage', 1],
  ])('rolls back Books, content, cover selections, and prepared media after a %s failure', async (
    _label, method, occurrence,
  ) => {
    const bytes = await makeAnimatedWebp(2);
    db.prepare("INSERT INTO books (title, sort_order) VALUES ('Existing', 0)").run();
    const before = db.prepare('SELECT * FROM books').all();
    const persistenceService = createBookImportPersistenceService({
      db,
      repository: failingRepository(db, method, occurrence),
    });
    const books = method === 'insertBook'
      ? [book('one', { kind: 'managed', media: media(bytes) }), book('two', { kind: 'none' })]
      : [book('one', { kind: 'managed', media: media(bytes) }, { populated: true })];

    await expect(service({ persistenceService }).persistValidatedPlan(plan(books)))
      .rejects.toBeInstanceOf(BookImportCoverPersistenceError);
    expect(db.prepare('SELECT * FROM books').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) FROM book_primary_images').pluck().get()).toBe(0);
    expect(managedRows()).toEqual([]);
  });

  it('rolls back the full transaction and exact prepared asset after cover attachment fails', async () => {
    const bytes = await makeAnimatedWebp(2);
    const primaryImages = createBookPrimaryImageRepository(db);
    vi.spyOn(primaryImages, 'setManagedPrimaryImageWithOutcome')
      .mockImplementation(() => { throw new Error('Injected cover attachment failure'); });

    await expect(service({ primaryImageRepository: primaryImages }).persistValidatedPlan(plan([
      book('one', { kind: 'managed', media: media(bytes) }, { populated: true }),
    ]))).rejects.toMatchObject({ code: 'IMPORT_PERSISTENCE_FAILED' });
    expect(db.prepare('SELECT COUNT(*) FROM books').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM notes').pluck().get()).toBe(0);
    expect(managedRows()).toEqual([]);
  });

  it('compensates only the exact imported creation when identical managed media already exists', async () => {
    const bytes = await makeAnimatedWebp(2);
    const existing = await managedImages.createCommittedImage({ bytes, namespace: 'book-covers' });
    const primaryImages = createBookPrimaryImageRepository(db);
    vi.spyOn(primaryImages, 'setManagedPrimaryImageWithOutcome')
      .mockImplementation(() => { throw new Error('Injected cover attachment failure'); });

    await expect(service({ primaryImageRepository: primaryImages }).persistValidatedPlan(plan([
      book('one', { kind: 'managed', media: media(bytes) }),
    ]))).rejects.toBeInstanceOf(BookImportCoverPersistenceError);
    expect(managedRows()).toEqual([existing.record]);
    expect(storedBytes(existing.record)).toEqual(bytes);
  });

  it('preserves the database failure as primary and reports compensation failures separately', async () => {
    const bytes = await makeAnimatedWebp(2);
    const authority = {
      ...managedImages,
      compensate() { throw new Error('Injected compensation failure'); },
    };
    const persistenceService = createBookImportPersistenceService({
      db,
      repository: failingRepository(db, 'insertBook'),
    });

    let thrown;
    try {
      await service({ managedImageService: authority, persistenceService }).persistValidatedPlan(plan([
        book('one', { kind: 'managed', media: media(bytes) }),
      ]));
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({
      code: 'IMPORT_PERSISTENCE_FAILED',
      cleanupErrors: [expect.objectContaining({ message: 'Injected compensation failure' })],
    });
    expect(thrown.cause).toMatchObject({ code: 'IMPORT_PERSISTENCE_FAILED' });
  });

  it('lets WP8C extend the same transaction and compensates if that extension fails', async () => {
    const bytes = await sharp({ create: {
      width: 2, height: 2, channels: 3, background: '#123456',
    } }).png().toBuffer();

    await expect(service().persistValidatedPlan(plan([
      book('one', { kind: 'managed', media: media(bytes, 'image/png') }),
    ]), {
      persistAdditionalInTransaction() {
        expect(db.inTransaction).toBe(true);
        throw new Error('Injected WP8C association failure');
      },
    })).rejects.toBeInstanceOf(BookImportCoverPersistenceError);
    expect(db.prepare('SELECT COUNT(*) FROM books').pluck().get()).toBe(0);
    expect(managedRows()).toEqual([]);
  });
});
