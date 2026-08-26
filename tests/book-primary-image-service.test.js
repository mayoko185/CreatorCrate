import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createBookPrimaryImageRepository } from '../src/data/book-primary-image-repository.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import {
  BookPrimaryImageError,
  BOOK_PRIMARY_IMAGE_ERROR_CODES,
  createBookPrimaryImageService,
} from '../src/services/book-primary-image-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('book primary-image service', () => {
  let db;
  let assetRepository;
  let bookRepository;
  let primaryImageRepository;
  let service;
  let project;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    assetRepository = createAssetRepository(db);
    bookRepository = createBookRepository(db);
    primaryImageRepository = createBookPrimaryImageRepository(db);
    service = createBookPrimaryImageService({
      db,
      assetRepository,
      bookRepository,
      bookPrimaryImageRepository: primaryImageRepository,
    });
    project = createProject('Book image assets');
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
  });

  function createProject(title, { archived = false } = {}) {
    const created = createProjectRepository(db).create({
      title,
      slug: title.toLowerCase().replaceAll(' ', '-'),
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
    if (archived) {
      db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?")
        .run(created.id);
    }
    return created;
  }

  function createBook(title) {
    return bookRepository.create({ title });
  }

  function createAsset(
    projectId,
    relativePath,
    extension = 'png',
    mimeType = 'image/png',
  ) {
    return assetRepository.upsert(projectId, relativePath, {
      filename: path.basename(relativePath),
      extension,
      mimeType,
      sizeBytes: 100,
      modifiedAt: '2026-08-24T12:00:00.000Z',
    });
  }

  function expectCode(callback, code) {
    try {
      callback();
      throw new Error(`Expected ${code} error.`);
    } catch (err) {
      expect(err).toBeInstanceOf(BookPrimaryImageError);
      expect(err.code).toBe(code);
      return err;
    }
  }

  function createDeferred() {
    let resolve;
    const promise = new Promise((nextResolve) => {
      resolve = nextResolve;
    });
    return { promise, resolve };
  }

  it('sets a present supported image and retrieves the selected asset', () => {
    const book = createBook('Present image');
    const asset = createAsset(project.id, 'cover.png');

    expect(service.setPrimaryImage(book.id, asset.id)).toEqual({
      book_id: book.id,
      asset_id: asset.id,
    });
    expect(service.getPrimaryImage(book.id)).toMatchObject({ id: asset.id, is_present: 1 });
  });

  it('replaces a book selection and permits one asset for multiple books', () => {
    const firstBook = createBook('First book');
    const secondBook = createBook('Second book');
    const firstAsset = createAsset(project.id, 'first.png');
    const sharedAsset = createAsset(project.id, 'shared.png');

    service.setPrimaryImage(firstBook.id, firstAsset.id);
    service.setPrimaryImage(firstBook.id, sharedAsset.id);
    service.setPrimaryImage(secondBook.id, sharedAsset.id);

    expect(service.getPrimaryImage(firstBook.id).id).toBe(sharedAsset.id);
    expect(service.getPrimaryImage(secondBook.id).id).toBe(sharedAsset.id);
    expect(db.prepare('SELECT COUNT(*) FROM book_primary_images WHERE book_id = ?')
      .pluck().get(firstBook.id)).toBe(1);
  });

  it('allows an asset from another project, including an archived project', () => {
    const book = createBook('Cross project book');
    const otherProject = createProject('Other image project');
    const archivedProject = createProject('Archived image project', { archived: true });
    const otherAsset = createAsset(otherProject.id, 'other.png');
    const archivedAsset = createAsset(archivedProject.id, 'archived.png');

    expect(() => service.setPrimaryImage(book.id, otherAsset.id)).not.toThrow();
    expect(() => service.setPrimaryImage(book.id, archivedAsset.id)).not.toThrow();
    expect(service.getPrimaryImage(book.id).id).toBe(archivedAsset.id);
  });

  it('returns typed book and asset validation errors', () => {
    const book = createBook('Known book');
    const asset = createAsset(project.id, 'known.png');

    expectCode(
      () => service.setPrimaryImage(999999, asset.id),
      BOOK_PRIMARY_IMAGE_ERROR_CODES.BOOK_NOT_FOUND,
    );
    expectCode(
      () => service.setPrimaryImage(book.id, 999999),
      BOOK_PRIMARY_IMAGE_ERROR_CODES.ASSET_NOT_FOUND,
    );
    expectCode(
      () => service.setPrimaryImage('1', asset.id),
      BOOK_PRIMARY_IMAGE_ERROR_CODES.INVALID_ID,
    );
  });

  it('rejects missing and unsupported assets as new selections', () => {
    const book = createBook('Asset validation');
    const missing = createAsset(project.id, 'missing.png');
    const text = createAsset(project.id, 'notes.txt', 'txt', 'text/plain');
    assetRepository.markAllMissing(project.id);

    expectCode(
      () => service.setPrimaryImage(book.id, missing.id),
      BOOK_PRIMARY_IMAGE_ERROR_CODES.ASSET_MISSING,
    );
    assetRepository.restorePresent(project.id, ['notes.txt']);
    expectCode(
      () => service.setPrimaryImage(book.id, text.id),
      BOOK_PRIMARY_IMAGE_ERROR_CODES.ASSET_UNSUPPORTED,
    );
  });

  it('preserves merged-preview probe eligibility for KRA assets', async () => {
    const book = createBook('Krita book');
    const asset = createAsset(project.id, 'cover.kra', 'kra', 'application/x-krita');
    const previewProbe = vi.fn().mockResolvedValue({ quality: 'merged' });
    const probedService = createBookPrimaryImageService({
      db,
      assetRepository,
      bookRepository,
      bookPrimaryImageRepository: primaryImageRepository,
      previewProbe,
    });

    await expect(probedService.setPrimaryImage(book.id, asset.id)).resolves.toEqual({
      book_id: book.id,
      asset_id: asset.id,
    });
    expect(previewProbe).toHaveBeenCalledWith(
      asset.project_id,
      expect.objectContaining({ id: asset.id, extension: 'kra' }),
    );

    const rejectedProbeService = createBookPrimaryImageService({
      db,
      assetRepository,
      bookRepository,
      bookPrimaryImageRepository: primaryImageRepository,
      previewProbe: vi.fn().mockResolvedValue({ quality: 'thumbnail' }),
    });
    await expect(rejectedProbeService.setPrimaryImage(book.id, asset.id)).rejects.toMatchObject({
      code: BOOK_PRIMARY_IMAGE_ERROR_CODES.ASSET_UNSUPPORTED,
    });
  });

  it('uses guarded clear semantics and retains a newer selection after a stale clear', () => {
    const book = createBook('Guarded clear');
    const firstAsset = createAsset(project.id, 'first.png');
    const secondAsset = createAsset(project.id, 'second.png');
    service.setPrimaryImage(book.id, firstAsset.id);
    service.setPrimaryImage(book.id, secondAsset.id);

    expectCode(
      () => service.clearPrimaryImage(book.id, firstAsset.id),
      BOOK_PRIMARY_IMAGE_ERROR_CODES.STALE_CLEAR,
    );
    expect(service.getPrimaryImage(book.id).id).toBe(secondAsset.id);
    expect(service.clearPrimaryImage(book.id, secondAsset.id)).toBe(true);
    expect(service.getPrimaryImage(book.id)).toBeUndefined();
  });

  it('logs only effective primary-image selections and clears through the central logger', () => {
    const book = createBook('Activity book title must not be logged');
    const asset = createAsset(project.id, 'activity.png');
    const applicationLogRepository = createApplicationLogRepository(db);
    const loggingService = createBookPrimaryImageService({
      db,
      assetRepository,
      bookRepository,
      bookPrimaryImageRepository: primaryImageRepository,
      applicationLogger: createApplicationLogger({
        repository: applicationLogRepository,
        console: { error: vi.fn() },
        now: () => 1,
      }),
    });

    loggingService.setPrimaryImage(book.id, asset.id);
    loggingService.setPrimaryImage(book.id, asset.id);
    loggingService.clearPrimaryImage(book.id, asset.id);

    const records = applicationLogRepository.findPage({ kind: 'activity' });
    expect(records.map((record) => record.event)).toEqual([
      'book.primary_image.cleared',
      'book.primary_image.set',
    ]);
    const setRecord = records.find((record) => record.event === 'book.primary_image.set');
    expect(setRecord).toMatchObject({
      level: 'info',
      kind: 'activity',
      subsystem: 'notes',
      project_id: project.id,
    });
    expect(JSON.parse(setRecord.context_json)).toEqual({ bookId: book.id, assetId: asset.id });
    expect(`${setRecord.message}${setRecord.context_json}`).not.toContain('Activity book title');
  });

  it('does not let the retired logging snapshot lookup block a valid selection', () => {
    const book = createBook('Snapshot lookup failure');
    const asset = createAsset(project.id, 'snapshot.png');
    vi.spyOn(primaryImageRepository, 'findByBookId').mockImplementation(() => {
      throw new Error('forced logging snapshot failure');
    });

    expect(service.setPrimaryImage(book.id, asset.id)).toEqual({
      book_id: book.id,
      asset_id: asset.id,
    });
    expect(primaryImageRepository.findByBookId).not.toHaveBeenCalled();
    expect(db.prepare('SELECT asset_id FROM book_primary_images WHERE book_id = ?')
      .pluck().get(book.id)).toBe(asset.id);
  });

  it('logs only authoritative changes across overlapping asynchronous primary-image sets', async () => {
    const book = createBook('Overlapping selections');
    const asset = createAsset(project.id, 'cover.kra', 'kra', 'application/x-krita');
    const logRepository = createApplicationLogRepository(db);
    const firstProbe = createDeferred();
    let probeCount = 0;
    const loggingService = createBookPrimaryImageService({
      db,
      assetRepository,
      bookRepository,
      bookPrimaryImageRepository: primaryImageRepository,
      previewProbe: () => {
        probeCount += 1;
        return probeCount === 1 ? firstProbe.promise : { quality: 'merged' };
      },
      applicationLogger: createApplicationLogger({
        repository: logRepository,
        console: { error: vi.fn() },
        now: () => 1,
      }),
    });

    const firstSet = loggingService.setPrimaryImage(book.id, asset.id);
    loggingService.setPrimaryImage(book.id, asset.id);
    firstProbe.resolve({ quality: 'merged' });
    await firstSet;

    expect(logRepository.findPage({ kind: 'activity' }).filter((record) => (
      record.event === 'book.primary_image.set'
    ))).toHaveLength(1);

    const replacement = createAsset(project.id, 'replacement.png');
    const delayedRestore = createDeferred();
    let restoreProbeCount = 0;
    const restoringService = createBookPrimaryImageService({
      db,
      assetRepository,
      bookRepository,
      bookPrimaryImageRepository: primaryImageRepository,
      previewProbe: () => {
        restoreProbeCount += 1;
        return restoreProbeCount === 1 ? delayedRestore.promise : { quality: 'merged' };
      },
      applicationLogger: createApplicationLogger({
        repository: logRepository,
        console: { error: vi.fn() },
        now: () => 2,
      }),
    });

    const delayedSet = restoringService.setPrimaryImage(book.id, asset.id);
    restoringService.setPrimaryImage(book.id, replacement.id);
    delayedRestore.resolve({ quality: 'merged' });
    await delayedSet;

    expect(logRepository.findPage({ kind: 'activity' }).filter((record) => (
      record.event === 'book.primary_image.set'
    ))).toHaveLength(3);
    expect(service.getPrimaryImage(book.id).id).toBe(asset.id);
  });

  it('isolates logger failures from an authoritative primary-image selection', () => {
    const book = createBook('Logger isolation');
    const asset = createAsset(project.id, 'logger.png');
    const loggingService = createBookPrimaryImageService({
      db,
      assetRepository,
      bookRepository,
      bookPrimaryImageRepository: primaryImageRepository,
      applicationLogger: { info: vi.fn(() => { throw new Error('forced logger failure'); }) },
    });

    expect(loggingService.setPrimaryImage(book.id, asset.id)).toEqual({
      book_id: book.id,
      asset_id: asset.id,
    });
    expect(service.getPrimaryImage(book.id).id).toBe(asset.id);
  });

  it('attaches none, available, and unavailable primary-image models in input order without per-book lookups', () => {
    const noneBook = createBook('No image');
    const availableBook = createBook('Available image');
    const unavailableBook = createBook('Unavailable image');
    const availableAsset = createAsset(project.id, 'available.png');
    const unavailableAsset = createAsset(project.id, 'unavailable.png');
    service.setPrimaryImage(availableBook.id, availableAsset.id);
    service.setPrimaryImage(unavailableBook.id, unavailableAsset.id);
    assetRepository.markAllMissing(project.id);
    assetRepository.restorePresent(project.id, ['available.png']);
    const batchSpy = vi.spyOn(primaryImageRepository, 'findByBookIds');
    const singleSpy = vi.spyOn(primaryImageRepository, 'findByBookId');

    const books = service.attachPrimaryImages([unavailableBook, noneBook, availableBook]);

    expect(books.map((book) => book.id)).toEqual([unavailableBook.id, noneBook.id, availableBook.id]);
    expect(books.map((book) => book.primaryImage.state)).toEqual(['unavailable', 'none', 'available']);
    expect(books.every((book) => book.primaryImage.provenance === null)).toBe(true);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(singleSpy).not.toHaveBeenCalled();
  });

  it('maps batch repository failures to a controlled database error', () => {
    const book = createBook('Batch repository failure');
    const cause = new Error('forced batch repository failure');
    vi.spyOn(primaryImageRepository, 'findByBookIds').mockImplementation(() => {
      throw cause;
    });

    let thrown;
    try {
      service.attachPrimaryImages([book]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(BookPrimaryImageError);
    expect(thrown.code).toBe(BOOK_PRIMARY_IMAGE_ERROR_CODES.DATABASE_ERROR);
    expect(thrown.message).toBe('Primary image operation failed due to a database error.');
    expect(thrown.cause).toBe(cause);
  });

  it('lists multiple books using an asset with one collection lookup', () => {
    const firstBook = createBook('First selection');
    const secondBook = createBook('Second selection');
    const unusedBook = createBook('Unused selection');
    const asset = createAsset(project.id, 'shared.png');
    service.setPrimaryImage(firstBook.id, asset.id);
    service.setPrimaryImage(secondBook.id, asset.id);
    const listSpy = vi.spyOn(bookRepository, 'list');
    const findByIdSpy = vi.spyOn(bookRepository, 'findById');

    expect(service.listBooksForAsset(asset.id).map((book) => book.id)).toEqual([
      firstBook.id,
      secondBook.id,
    ]);
    expect(unusedBook.id).toBeGreaterThan(secondBook.id);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(findByIdSpy).not.toHaveBeenCalled();
  });
});
