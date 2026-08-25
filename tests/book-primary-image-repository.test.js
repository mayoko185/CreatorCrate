import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createBookPrimaryImageRepository } from '../src/data/book-primary-image-repository.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('book primary-image repository', () => {
  let db;
  let assetRepository;
  let bookRepository;
  let repository;
  let project;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    assetRepository = createAssetRepository(db);
    bookRepository = createBookRepository(db);
    repository = createBookPrimaryImageRepository(db);
    project = createProject('Primary image assets');
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
  });

  function createProject(title) {
    return createProjectRepository(db).create({
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
  }

  function createBook(title) {
    return bookRepository.create({ title });
  }

  function createAsset(relativePath) {
    return assetRepository.upsert(project.id, relativePath, {
      filename: path.basename(relativePath),
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 100,
      modifiedAt: '2026-08-24T12:00:00.000Z',
    });
  }

  it('finds a stored relationship and returns undefined when one is missing', () => {
    const book = createBook('Stored relationship');
    const missingBook = createBook('Missing relationship');
    const asset = createAsset('stored.png');

    repository.setPrimaryImage(book.id, asset.id);

    expect(repository.findByBookId(book.id)).toEqual({
      book_id: book.id,
      asset_id: asset.id,
    });
    expect(repository.findByBookId(missingBook.id)).toBeUndefined();
  });

  it('finds matching relationships for several books and returns an empty array for no IDs', () => {
    const firstBook = createBook('First batch book');
    const secondBook = createBook('Second batch book');
    const firstAsset = createAsset('first.png');
    const secondAsset = createAsset('second.png');
    repository.setPrimaryImage(firstBook.id, firstAsset.id);
    repository.setPrimaryImage(secondBook.id, secondAsset.id);

    expect(repository.findByBookIds([secondBook.id, firstBook.id, secondBook.id])).toEqual([
      { book_id: firstBook.id, asset_id: firstAsset.id },
      { book_id: secondBook.id, asset_id: secondAsset.id },
    ]);
    expect(repository.findByBookIds([])).toEqual([]);
  });

  it('finds every book relationship for a shared asset', () => {
    const firstBook = createBook('First shared image book');
    const secondBook = createBook('Second shared image book');
    const asset = createAsset('shared.png');
    repository.setPrimaryImage(firstBook.id, asset.id);
    repository.setPrimaryImage(secondBook.id, asset.id);

    expect(repository.findByAssetId(asset.id)).toEqual([
      { book_id: firstBook.id, asset_id: asset.id },
      { book_id: secondBook.id, asset_id: asset.id },
    ]);
  });

  it('inserts a relationship and replaces its asset without adding another row', () => {
    const book = createBook('Replace relationship');
    const firstAsset = createAsset('first.png');
    const secondAsset = createAsset('second.png');

    expect(repository.setPrimaryImage(book.id, firstAsset.id)).toEqual({
      book_id: book.id,
      asset_id: firstAsset.id,
    });
    expect(repository.setPrimaryImage(book.id, secondAsset.id)).toEqual({
      book_id: book.id,
      asset_id: secondAsset.id,
    });
    expect(db.prepare(
      'SELECT COUNT(*) FROM book_primary_images WHERE book_id = ?'
    ).pluck().get(book.id)).toBe(1);
    expect(repository.findByBookId(book.id)).toEqual({
      book_id: book.id,
      asset_id: secondAsset.id,
    });
  });

  it('clears only a matching selection and preserves a newer selection for a stale asset', () => {
    const book = createBook('Guarded clear');
    const firstAsset = createAsset('first.png');
    const secondAsset = createAsset('second.png');
    repository.setPrimaryImage(book.id, firstAsset.id);

    expect(repository.clearPrimaryImageIfMatches(book.id, firstAsset.id)).toBe(true);
    expect(repository.findByBookId(book.id)).toBeUndefined();

    repository.setPrimaryImage(book.id, secondAsset.id);
    expect(repository.clearPrimaryImageIfMatches(book.id, firstAsset.id)).toBe(false);
    expect(repository.findByBookId(book.id)).toEqual({
      book_id: book.id,
      asset_id: secondAsset.id,
    });
  });
});
