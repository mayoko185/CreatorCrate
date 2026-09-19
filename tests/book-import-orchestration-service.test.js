import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import {
  createBookImportAssociationRepository,
} from '../src/data/book-import-association-repository.js';
import { createManagedAssetRepository } from '../src/data/managed-asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import {
  createBookImportAssociationPersistenceService,
} from '../src/services/book-import-association-persistence-service.js';
import {
  createBookImportOrchestrationService,
} from '../src/services/book-import-orchestration-service.js';
import { createManagedImageService } from '../src/services/managed-image-service.js';
import { makeAnimatedWebp } from './helpers/animated-webp.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const WHEN = '2026-09-18 12:00:00';

function projectLocator(slug = 'portable-project') {
  return { slug, title: 'Portable Project', projectType: 'images' };
}

function assetLocator(slug = 'portable-project', relativePath = 'art/page.png') {
  return {
    project: projectLocator(slug),
    relativePath,
    filename: path.posix.basename(relativePath),
    extension: path.posix.extname(relativePath).slice(1),
    mimeType: 'image/png',
  };
}

function associations({ projects = [], assets = [], unresolvedProjectCount = 0,
  unresolvedAssetCount = 0 } = {}) {
  return { projects, assets, unresolvedProjectCount, unresolvedAssetCount };
}

function media(bytes) {
  return {
    path: 'validated/cover.webp',
    mimeType: 'image/webp',
    sizeBytes: bytes.length,
    width: 2,
    height: 2,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function book(key, { title = `Imported ${key}`, cover = { kind: 'none' }, pageAssociations,
  revisionAssociations, duplicateCurrentLocators = false } = {}) {
  const current = pageAssociations ?? associations();
  if (duplicateCurrentLocators) {
    current.projects = [...current.projects, ...current.projects];
    current.assets = [...current.assets, ...current.assets];
  }
  const revision = revisionAssociations === undefined ? [] : [{
    key: `${key}-revision`,
    title: `${key} revision`,
    rawMarkdown: 'old body',
    sourceUpdatedAt: WHEN,
    createdAt: WHEN,
    associations: revisionAssociations,
  }];
  return {
    key,
    title,
    createdAt: WHEN,
    updatedAt: WHEN,
    rootContents: [{ type: 'page', key: `${key}-page` }],
    chapters: [],
    pages: [{
      key: `${key}-page`,
      chapterKey: null,
      title: `${key} Page`,
      rawMarkdown: 'body',
      createdAt: WHEN,
      updatedAt: WHEN,
      associations: current,
      revisions: revision,
    }],
    previewSettings: { mode: 'selected', randomCount: 5, selectedPageKeys: [`${key}-page`] },
    cover,
  };
}

const plan = (books) => ({ format: 'creatorcrate-books', version: 1, books });

describe('Book import orchestration', () => {
  let db;
  let tmpDir;
  let managedRoot;
  let managedImages;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-import-orchestration-'));
    managedRoot = path.join(tmpDir, 'managed');
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    managedImages = createManagedImageService({
      managedAssetRoot: managedRoot,
      managedAssetRepository: createManagedAssetRepository(db),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (db?.open) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertProjectAsset(slug = 'portable-project', relativePath = 'art/page.png') {
    const project = createProjectRepository(db).create({
      title: 'Portable Project', slug, description: '', notes: '', status: 'tbd',
      projectType: 'images', patreonUrl: null,
    });
    const asset = createAssetRepository(db).upsert(project.id, relativePath, {
      filename: path.posix.basename(relativePath), extension: 'png', mimeType: 'image/png',
      sizeBytes: 10, modifiedAt: '2026-09-18T12:00:00.000Z',
    });
    return { project, asset };
  }

  function realLogger() {
    return createApplicationLogger({
      repository: createApplicationLogRepository(db),
      console: { error() {} },
    });
  }

  function service(overrides = {}) {
    return createBookImportOrchestrationService({
      db,
      managedImageService: managedImages,
      applicationLogger: realLogger(),
      ...overrides,
    });
  }

  it('resolves Page and revision locators with fresh IDs and reports mixed misses deterministically', async () => {
    const animated = await makeAnimatedWebp(2);
    const { project, asset } = insertProjectAsset();
    const projects = createProjectRepository(db);
    const assets = createAssetRepository(db);
    const projectSpy = vi.spyOn(projects, 'findBySlug');
    const assetSpy = vi.spyOn(assets, 'findByProjectIdAndPath');
    const associationPersistenceService = createBookImportAssociationPersistenceService({
      db, projectRepository: projects, assetRepository: assets,
    });
    db.prepare("INSERT INTO books (title, sort_order) VALUES ('Imported one', 0)").run();
    const persistedLogger = realLogger();
    const logSpy = vi.fn((input) => {
      expect(db.inTransaction).toBe(false);
      expect(db.prepare('SELECT COUNT(*) FROM managed_assets').pluck().get()).toBe(2);
      return persistedLogger.info(input);
    });
    const logger = { info: logSpy };

    const resolvedProjects = [projectLocator()];
    const resolvedAssets = [assetLocator()];
    const missingProjects = [projectLocator('missing-project')];
    const missingAssets = [assetLocator('portable-project', 'art/missing.png')];
    const assetsWithMissingProjects = [assetLocator('missing-asset-project', 'art/orphan.png')];
    const result = await service({ applicationLogger: logger, associationPersistenceService })
      .importValidatedPlan(plan([
        book('one', {
          title: 'Imported one',
          cover: { kind: 'none' },
          pageAssociations: associations({
            projects: [...resolvedProjects, ...missingProjects],
            assets: [...resolvedAssets, ...missingAssets, ...assetsWithMissingProjects],
            unresolvedProjectCount: 2,
            unresolvedAssetCount: 3,
          }),
          revisionAssociations: associations({
            projects: [...resolvedProjects, ...missingProjects],
            assets: [...resolvedAssets, ...missingAssets],
            unresolvedProjectCount: 5,
            unresolvedAssetCount: 7,
          }),
        }),
        book('managed', {
          cover: { kind: 'managed', media: media(animated) },
          pageAssociations: associations({ projects: resolvedProjects, assets: resolvedAssets }),
          duplicateCurrentLocators: true,
        }),
        book('relinked', {
          cover: { kind: 'project_asset', source: assetLocator(), media: media(animated) },
        }),
        book('fallback', {
          cover: {
            kind: 'project_asset', source: assetLocator('missing-cover'), media: media(animated),
          },
        }),
      ]));

    expect(result).toMatchObject({
      success: true,
      importedBookCount: 4,
      activity: { recorded: true },
      associations: {
        resolvedProjectAssociationCount: 3,
        resolvedAssetAssociationCount: 3,
        historicalUnresolvedProjectCount: 7,
        historicalUnresolvedAssetCount: 10,
      },
    });
    expect(result.books.map((entry) => [entry.sourceTitle, entry.destinationTitle, entry.renamed]))
      .toEqual([
        ['Imported one', 'Imported one-1', true],
        ['Imported managed', 'Imported managed', false],
        ['Imported relinked', 'Imported relinked', false],
        ['Imported fallback', 'Imported fallback', false],
      ]);
    expect(result.books.map((entry) => entry.coverOutcome)).toEqual([
      { kind: 'none' },
      { kind: 'managed', sourceKind: 'managed' },
      { kind: 'project_asset', relinked: true, locator: assetLocator() },
      expect.objectContaining({
        kind: 'managed', sourceKind: 'project_asset', relinked: false,
        locator: assetLocator('missing-cover'), unresolvedReason: 'project_not_found',
      }),
    ]);
    expect(result.associations.unresolvedProjectLocators).toEqual([
      expect.objectContaining({
        sourceBookKey: 'one', pageKey: 'one-page', revisionKey: null,
        locator: projectLocator('missing-project'),
      }),
      expect.objectContaining({
        sourceBookKey: 'one', pageKey: 'one-page', revisionKey: 'one-revision',
        locator: projectLocator('missing-project'),
      }),
    ]);
    expect(result.associations.unresolvedAssetLocators).toEqual([
      expect.objectContaining({
        sourceBookKey: 'one', pageKey: 'one-page', revisionKey: null,
        locator: assetLocator('portable-project', 'art/missing.png'),
      }),
      expect.objectContaining({
        sourceBookKey: 'one', pageKey: 'one-page', revisionKey: null,
        locator: assetLocator('missing-asset-project', 'art/orphan.png'),
      }),
      expect.objectContaining({
        sourceBookKey: 'one', pageKey: 'one-page', revisionKey: 'one-revision',
        locator: assetLocator('portable-project', 'art/missing.png'),
      }),
    ]);

    const pages = db.prepare('SELECT id, title FROM notes ORDER BY id').all();
    const pageByTitle = new Map(pages.map((row) => [row.title, row.id]));
    expect(db.prepare('SELECT note_id, project_id FROM note_projects ORDER BY note_id').all())
      .toEqual([
        { note_id: pageByTitle.get('one Page'), project_id: project.id },
        { note_id: pageByTitle.get('managed Page'), project_id: project.id },
      ]);
    expect(db.prepare('SELECT note_id, asset_id FROM note_assets ORDER BY note_id').all())
      .toEqual([
        { note_id: pageByTitle.get('one Page'), asset_id: asset.id },
        { note_id: pageByTitle.get('managed Page'), asset_id: asset.id },
      ]);
    const revision = db.prepare(`
      SELECT note_id, project_ids_json, asset_ids_json FROM note_revisions
    `).get();
    expect(revision).toEqual({
      note_id: pageByTitle.get('one Page'),
      project_ids_json: JSON.stringify([project.id]),
      asset_ids_json: JSON.stringify([asset.id]),
    });
    expect(new Set(result.destinationBookIds).size).toBe(4);
    expect(projectSpy.mock.calls.filter(([slug]) => slug === 'portable-project')).toHaveLength(1);
    expect(assetSpy.mock.calls.filter(([, relativePath]) => relativePath === 'art/page.png'))
      .toHaveLength(1);
    expect(assetSpy.mock.calls.some(([, relativePath]) => relativePath === 'art/orphan.png'))
      .toBe(false);
    expect(logSpy).toHaveBeenCalledOnce();
    const activity = createApplicationLogRepository(db).findPage({ kind: 'activity' });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ event: 'book.imported', subsystem: 'notes' });
    expect(JSON.parse(activity[0].context_json)).toEqual({
      importedBookCount: 4,
      renamedBookCount: 1,
      unresolvedAssociationCount: 22,
      destinationBookIds: result.destinationBookIds,
    });
    const storedManaged = db.prepare('SELECT * FROM managed_assets ORDER BY id').all();
    expect(storedManaged).toHaveLength(2);
    for (const row of storedManaged) {
      expect(fs.readFileSync(path.join(managedRoot, row.storage_key))).toEqual(animated);
    }
  });

  it('rolls back all Books and compensates all media after a later-Book association write failure', async () => {
    const animated = await makeAnimatedWebp(2);
    insertProjectAsset();
    const base = createBookImportAssociationRepository(db);
    let insertions = 0;
    const repository = {
      ...base,
      insertPageProject(...args) {
        insertions += 1;
        if (insertions === 2) throw new Error('Injected later association failure');
        return base.insertPageProject(...args);
      },
    };
    const associationPersistenceService = createBookImportAssociationPersistenceService({ db, repository });
    const applicationLogger = { info: vi.fn(() => true) };

    await expect(service({ associationPersistenceService, applicationLogger })
      .importValidatedPlan(plan([
        book('first', {
          cover: { kind: 'managed', media: media(animated) },
          pageAssociations: associations({ projects: [projectLocator()] }),
        }),
        book('second', {
          cover: { kind: 'managed', media: media(animated) },
          pageAssociations: associations({ projects: [projectLocator()] }),
        }),
      ]))).rejects.toMatchObject({ code: 'IMPORT_PERSISTENCE_FAILED' });

    expect(db.prepare('SELECT COUNT(*) FROM books').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM notes').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM note_projects').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM managed_assets').pluck().get()).toBe(0);
    expect(applicationLogger.info).not.toHaveBeenCalled();
  });

  it('does not downgrade an Asset resolver fault to unresolved', async () => {
    const animated = await makeAnimatedWebp(2);
    insertProjectAsset();
    const assetRepository = createAssetRepository(db);
    vi.spyOn(assetRepository, 'findByProjectIdAndPath')
      .mockImplementation(() => { throw new TypeError('Injected resolver failure'); });
    const associationPersistenceService = createBookImportAssociationPersistenceService({
      db, assetRepository,
    });
    const applicationLogger = { info: vi.fn(() => true) };

    await expect(service({ associationPersistenceService, applicationLogger })
      .importValidatedPlan(plan([book('fault', {
        cover: { kind: 'managed', media: media(animated) },
        pageAssociations: associations({ assets: [assetLocator()] }),
      })]))).rejects.toMatchObject({ code: 'IMPORT_PERSISTENCE_FAILED' });
    expect(db.prepare('SELECT COUNT(*) FROM books').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM managed_assets').pluck().get()).toBe(0);
    expect(applicationLogger.info).not.toHaveBeenCalled();
  });

  it('keeps the committed import and media when post-commit activity throws', async () => {
    const animated = await makeAnimatedWebp(2);
    const result = await service({
      applicationLogger: { info() { throw new Error('Injected activity failure'); } },
    }).importValidatedPlan(plan([book('activity-failure', {
      cover: { kind: 'managed', media: media(animated) },
    })]));

    expect(result.activity).toEqual({ recorded: false, warning: 'activity_not_recorded' });
    expect(db.prepare('SELECT title FROM books').pluck().all()).toEqual(['Imported activity-failure']);
    expect(db.prepare('SELECT COUNT(*) FROM notes').pluck().get()).toBe(1);
    const rows = db.prepare('SELECT * FROM managed_assets ORDER BY id').all();
    expect(rows).toHaveLength(1);
    expect(fs.readFileSync(path.join(managedRoot, rows[0].storage_key))).toEqual(animated);
  });
});
