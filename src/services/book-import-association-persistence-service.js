import { createAssetRepository } from '../data/asset-repository.js';
import {
  createBookImportAssociationRepository,
} from '../data/book-import-association-repository.js';
import { createProjectRepository } from '../data/project-repository.js';

export class BookImportAssociationPersistenceError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BookImportAssociationPersistenceError';
    this.code = code;
    this.status = 500;
  }
}

function integrityError(message) {
  return new BookImportAssociationPersistenceError(message, { code: 'IMPORT_INTEGRITY_ERROR' });
}

function requireId(value, entity) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw integrityError(`The validated import is missing a destination ${entity} ID.`);
  }
  return value;
}

function requireMapping(mapping, key, entity) {
  if (!(mapping instanceof Map)) {
    throw integrityError(`The validated import is missing its destination ${entity} mapping.`);
  }
  return requireId(mapping.get(key), entity);
}

function cloneProjectLocator(locator) {
  return { ...locator };
}

function cloneAssetLocator(locator) {
  return { ...locator, project: { ...locator.project } };
}

function emptyReport() {
  return {
    resolvedProjectAssociationCount: 0,
    resolvedAssetAssociationCount: 0,
    unresolvedProjectLocators: [],
    unresolvedAssetLocators: [],
    historicalUnresolvedProjectCount: 0,
    historicalUnresolvedAssetCount: 0,
  };
}

function addReport(target, source) {
  target.resolvedProjectAssociationCount += source.resolvedProjectAssociationCount;
  target.resolvedAssetAssociationCount += source.resolvedAssetAssociationCount;
  target.unresolvedProjectLocators.push(...source.unresolvedProjectLocators);
  target.unresolvedAssetLocators.push(...source.unresolvedAssetLocators);
  target.historicalUnresolvedProjectCount += source.historicalUnresolvedProjectCount;
  target.historicalUnresolvedAssetCount += source.historicalUnresolvedAssetCount;
}

function context(sourceBookKey, pageKey, revisionKey, locator) {
  return {
    sourceBookKey,
    pageKey,
    revisionKey,
    locator,
  };
}

/**
 * Resolves portable WP7 locators and persists Page/revision associations inside
 * WP8B's active IMMEDIATE transaction. Resolver misses are reportable portable
 * outcomes; resolver and write exceptions remain operational failures.
 */
export function createBookImportAssociationPersistenceService({
  db,
  projectRepository = db ? createProjectRepository(db) : undefined,
  assetRepository = db ? createAssetRepository(db) : undefined,
  repository = db ? createBookImportAssociationRepository(db) : undefined,
} = {}) {
  if (!db) throw new TypeError('createBookImportAssociationPersistenceService requires a database.');
  if (!projectRepository || !assetRepository || !repository) {
    throw new TypeError('createBookImportAssociationPersistenceService requires association repositories.');
  }

  function persistInTransaction(importResult) {
    if (!db.inTransaction) {
      throw new BookImportAssociationPersistenceError(
        'Book import associations require the active caller-owned transaction.',
        { code: 'TRANSACTION_CONTEXT_REQUIRED' },
      );
    }
    if (!Array.isArray(importResult?.books)) {
      throw integrityError('Book import association persistence requires the WP8 persistence result.');
    }

    const projectCache = new Map();
    const assetCache = new Map();
    const overall = emptyReport();

    function resolveProject(locator) {
      if (projectCache.has(locator.slug)) return projectCache.get(locator.slug);
      const project = projectRepository.findBySlug(locator.slug);
      const resolved = project ? requireId(project.id, 'Project') : null;
      projectCache.set(locator.slug, resolved);
      return resolved;
    }

    function resolveAsset(locator) {
      const key = `${locator.project.slug}\u0000${locator.relativePath}`;
      if (assetCache.has(key)) return assetCache.get(key);
      const projectId = resolveProject(locator.project);
      if (projectId === null) {
        assetCache.set(key, null);
        return null;
      }
      const asset = assetRepository.findByProjectIdAndPath(projectId, locator.relativePath);
      const resolved = asset ? requireId(asset.id, 'Asset') : null;
      assetCache.set(key, resolved);
      return resolved;
    }

    function resolveScope(associations, sourceBookKey, pageKey, revisionKey, report) {
      const projectIds = [];
      const assetIds = [];
      const seenProjects = new Set();
      const seenAssets = new Set();

      report.historicalUnresolvedProjectCount += associations.unresolvedProjectCount;
      report.historicalUnresolvedAssetCount += associations.unresolvedAssetCount;

      for (const locator of associations.projects) {
        if (seenProjects.has(locator.slug)) continue;
        seenProjects.add(locator.slug);
        const projectId = resolveProject(locator);
        if (projectId === null) {
          report.unresolvedProjectLocators.push(context(
            sourceBookKey, pageKey, revisionKey, cloneProjectLocator(locator),
          ));
        } else {
          projectIds.push(projectId);
        }
      }

      for (const locator of associations.assets) {
        const key = `${locator.project.slug}\u0000${locator.relativePath}`;
        if (seenAssets.has(key)) continue;
        seenAssets.add(key);
        const assetId = resolveAsset(locator);
        if (assetId === null) {
          report.unresolvedAssetLocators.push(context(
            sourceBookKey, pageKey, revisionKey, cloneAssetLocator(locator),
          ));
        } else {
          assetIds.push(assetId);
        }
      }
      return { projectIds, assetIds };
    }

    for (const importedBook of importResult.books) {
      if (!(importedBook.associations instanceof Map)) {
        throw integrityError(`Imported Book ${importedBook.sourceBookKey} is missing association descriptors.`);
      }
      const bookReport = emptyReport();
      for (const [pageKey, scopes] of importedBook.associations) {
        const pageId = requireMapping(importedBook.pageIdsBySourceKey, pageKey, 'Page');
        const current = resolveScope(
          scopes.page, importedBook.sourceBookKey, pageKey, null, bookReport,
        );
        for (const projectId of current.projectIds) {
          repository.insertPageProject(pageId, projectId);
          bookReport.resolvedProjectAssociationCount += 1;
        }
        for (const assetId of current.assetIds) {
          repository.insertPageAsset(pageId, assetId);
          bookReport.resolvedAssetAssociationCount += 1;
        }

        const revisionMapping = importedBook.revisionIdsByPageKey.get(pageKey);
        if (!(revisionMapping instanceof Map)) {
          throw integrityError(`Imported Page ${pageKey} is missing its destination revision mapping.`);
        }
        for (const [revisionKey, associations] of scopes.revisions) {
          const revisionId = requireMapping(revisionMapping, revisionKey, 'revision');
          const revision = resolveScope(
            associations, importedBook.sourceBookKey, pageKey, revisionKey, bookReport,
          );
          const updated = repository.updateRevisionAssociations({
            revisionId,
            noteId: pageId,
            projectIds: revision.projectIds,
            assetIds: revision.assetIds,
          });
          if (updated.changes !== 1) {
            throw integrityError(`Destination revision ${revisionId} is not owned by imported Page ${pageId}.`);
          }
          bookReport.resolvedProjectAssociationCount += revision.projectIds.length;
          bookReport.resolvedAssetAssociationCount += revision.assetIds.length;
        }
      }
      importedBook.associationOutcome = bookReport;
      addReport(overall, bookReport);
    }

    importResult.associationOutcome = overall;
    return overall;
  }

  return Object.freeze({ persistInTransaction });
}
