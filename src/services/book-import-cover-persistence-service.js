import { createAssetRepository } from '../data/asset-repository.js';
import { createBookPrimaryImageRepository } from '../data/book-primary-image-repository.js';
import { createProjectRepository } from '../data/project-repository.js';
import {
  classifyBookPrimaryImageAssetEligibility,
} from './book-primary-image-service.js';
import { createBookImportPersistenceService } from './book-import-persistence-service.js';

const COVER_NAMESPACE = 'book-covers';

export class BookImportCoverPersistenceError extends Error {
  constructor(message, { code, cause, cleanupErrors = [] } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BookImportCoverPersistenceError';
    this.code = code;
    this.status = 500;
    this.cleanupErrors = cleanupErrors;
  }
}

function cloneLocator(locator) {
  return {
    project: { ...locator.project },
    relativePath: locator.relativePath,
    filename: locator.filename,
    extension: locator.extension,
    mimeType: locator.mimeType,
  };
}

function requirePlan(validatedPlan) {
  if (!Array.isArray(validatedPlan?.books) || validatedPlan.books.length === 0) {
    throw new BookImportCoverPersistenceError(
      'Book cover preparation requires a non-empty validated WP7 plan.',
      { code: 'IMPORT_INTEGRITY_ERROR' },
    );
  }
}

function preparationFailure(cause, cleanupErrors) {
  if (cause instanceof BookImportCoverPersistenceError && cleanupErrors.length === 0) return cause;
  return new BookImportCoverPersistenceError('Book cover preparation failed.', {
    code: cause?.code === 'IMPORT_INTEGRITY_ERROR' ? cause.code : 'COVER_PREPARATION_FAILED',
    cause,
    cleanupErrors,
  });
}

function persistenceFailure(cause, cleanupErrors) {
  return new BookImportCoverPersistenceError('The validated Book import could not be persisted.', {
    code: cause?.code ?? 'IMPORT_PERSISTENCE_FAILED',
    cause,
    cleanupErrors,
  });
}

/**
 * WP8B cover preparation and transactional attachment. Managed media is
 * prepared before the caller-owned Book transaction, while exact ownership
 * tokens remain private until commit or compensation.
 */
export function createBookImportCoverPersistenceService({
  db,
  managedImageService,
  persistenceService = db ? createBookImportPersistenceService({ db }) : undefined,
  projectRepository = db ? createProjectRepository(db) : undefined,
  assetRepository = db ? createAssetRepository(db) : undefined,
  primaryImageRepository = db ? createBookPrimaryImageRepository(db) : undefined,
  previewProbe,
} = {}) {
  if (!db || typeof db.transaction !== 'function') {
    throw new TypeError('createBookImportCoverPersistenceService requires a database.');
  }
  if (!managedImageService
    || typeof managedImageService.createCommittedImage !== 'function'
    || typeof managedImageService.rollbackCommitted !== 'function'
    || typeof managedImageService.compensate !== 'function') {
    throw new TypeError('createBookImportCoverPersistenceService requires managed-image authority.');
  }
  if (!persistenceService || typeof persistenceService.persistValidatedPlanInTransaction !== 'function') {
    throw new TypeError('createBookImportCoverPersistenceService requires transaction-aware Book persistence.');
  }
  if (!projectRepository || !assetRepository || !primaryImageRepository) {
    throw new TypeError('createBookImportCoverPersistenceService requires cover repositories.');
  }

  const preparedStates = new WeakMap();

  function compensatePrepared(state) {
    const cleanupErrors = [];
    for (const prepared of [...state.preparedManaged].reverse()) {
      let rowRemoved = false;
      try {
        managedImageService.rollbackCommitted(prepared.ownershipToken);
        rowRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (rowRemoved) {
        try {
          managedImageService.compensate(prepared.ownershipToken);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    return cleanupErrors;
  }

  async function resolveProjectCover(source) {
    const project = projectRepository.findBySlug(source.project.slug);
    if (!project) return { resolved: false, reason: 'project_not_found' };
    const asset = assetRepository.findByProjectIdAndPath(project.id, source.relativePath);
    if (!asset) return { resolved: false, reason: 'asset_not_found' };

    let eligibility = classifyBookPrimaryImageAssetEligibility(asset);
    if (!eligibility.eligible && eligibility.classification?.kind === 'krita'
      && eligibility.classification.extension === 'kra' && typeof previewProbe === 'function') {
      const probe = await previewProbe(project, asset);
      eligibility = classifyBookPrimaryImageAssetEligibility(asset, { kritaQuality: probe?.quality });
    }
    if (!eligibility.eligible) return { resolved: false, reason: eligibility.reason };
    return { resolved: true, project, asset, kritaQuality: eligibility.classification?.kind === 'krita' ? 'merged' : null };
  }

  async function prepareManaged(book, sourceKind, unresolved = null) {
    const { record, ownershipToken } = await managedImageService.createCommittedImage({
      bytes: book.cover.media.bytes,
      namespace: COVER_NAMESPACE,
    });
    return {
      sourceBookKey: book.key,
      kind: 'managed',
      sourceKind,
      record,
      ownershipToken,
      unresolved,
    };
  }

  async function prepareValidatedPlanCovers(validatedPlan) {
    requirePlan(validatedPlan);
    const state = { validatedPlan, coversByBookKey: new Map(), preparedManaged: [] };
    try {
      for (const book of validatedPlan.books) {
        if (book.cover.kind === 'none') {
          state.coversByBookKey.set(book.key, { sourceBookKey: book.key, kind: 'none' });
          continue;
        }
        if (book.cover.kind === 'managed') {
          const prepared = await prepareManaged(book, 'managed');
          state.preparedManaged.push(prepared);
          state.coversByBookKey.set(book.key, prepared);
          continue;
        }
        if (book.cover.kind !== 'project_asset') {
          throw new BookImportCoverPersistenceError('The validated plan contains an unknown cover kind.', {
            code: 'IMPORT_INTEGRITY_ERROR',
          });
        }

        const resolved = await resolveProjectCover(book.cover.source);
        if (resolved.resolved) {
          state.coversByBookKey.set(book.key, {
            sourceBookKey: book.key,
            kind: 'project_asset',
            project: resolved.project,
            asset: resolved.asset,
            kritaQuality: resolved.kritaQuality,
            locator: cloneLocator(book.cover.source),
          });
          continue;
        }
        const prepared = await prepareManaged(book, 'project_asset', {
          locator: cloneLocator(book.cover.source),
          reason: resolved.reason,
        });
        state.preparedManaged.push(prepared);
        state.coversByBookKey.set(book.key, prepared);
      }
    } catch (cause) {
      throw preparationFailure(cause, compensatePrepared(state));
    }

    const handle = Object.freeze({});
    preparedStates.set(handle, state);
    return handle;
  }

  function attachCovers(persistenceResult, state) {
    for (const importedBook of persistenceResult.books) {
      const prepared = state.coversByBookKey.get(importedBook.sourceBookKey);
      if (!prepared) {
        throw new BookImportCoverPersistenceError(
          `Missing prepared cover for Book ${importedBook.sourceBookKey}.`,
          { code: 'IMPORT_INTEGRITY_ERROR' },
        );
      }
      let coverOutcome;
      if (prepared.kind === 'none') {
        coverOutcome = { kind: 'none' };
      } else if (prepared.kind === 'project_asset') {
        const currentProject = projectRepository.findById(prepared.project.id);
        const currentAsset = assetRepository.findById(prepared.asset.id);
        if (currentProject?.slug !== prepared.locator.project.slug
          || currentAsset?.project_id !== prepared.project.id
          || currentAsset?.relative_path !== prepared.locator.relativePath) {
          throw new BookImportCoverPersistenceError(
            `Resolved Project cover for Book ${importedBook.sourceBookKey} changed before persistence.`,
            { code: 'PROJECT_COVER_CHANGED' },
          );
        }
        const eligibility = classifyBookPrimaryImageAssetEligibility(currentAsset, {
          kritaQuality: prepared.kritaQuality,
        });
        if (!eligibility.eligible) {
          throw new BookImportCoverPersistenceError(
            `Resolved Project cover for Book ${importedBook.sourceBookKey} is no longer eligible.`,
            { code: 'PROJECT_COVER_CHANGED' },
          );
        }
        const selection = primaryImageRepository.setPrimaryImage(
          importedBook.destinationBookId,
          currentAsset.id,
        );
        if (selection?.source?.kind !== 'project_asset' || selection.source.id !== currentAsset.id) {
          throw new Error('Primary image repository returned an invalid Project selection.');
        }
        coverOutcome = {
          kind: 'project_asset',
          locator: prepared.locator,
          destinationProjectAssetId: currentAsset.id,
          relinked: true,
        };
      } else {
        const selection = primaryImageRepository.setManagedPrimaryImageWithOutcome(
          importedBook.destinationBookId,
          prepared.record.id,
        ).selection;
        if (selection?.source?.kind !== 'managed_asset' || selection.source.id !== prepared.record.id) {
          throw new Error('Primary image repository returned an invalid managed selection.');
        }
        coverOutcome = prepared.sourceKind === 'managed'
          ? { kind: 'managed', managedAssetId: prepared.record.id }
          : {
            kind: 'managed',
            sourceKind: 'project_asset',
            locator: prepared.unresolved.locator,
            managedAssetId: prepared.record.id,
            unresolvedReason: prepared.unresolved.reason,
            relinked: false,
          };
      }
      importedBook.sourceCover = importedBook.cover;
      importedBook.coverOutcome = coverOutcome;
    }
    return persistenceResult;
  }

  const persistPreparedTransaction = db.transaction((state, persistAdditionalInTransaction) => {
    const result = attachCovers(
      persistenceService.persistValidatedPlanInTransaction(state.validatedPlan),
      state,
    );
    if (persistAdditionalInTransaction) {
      const extensionResult = persistAdditionalInTransaction(result);
      if (extensionResult && typeof extensionResult.then === 'function') {
        throw new TypeError('Import transaction extensions must be synchronous.');
      }
    }
    return result;
  });

  function persistPreparedPlan(preparation, { persistAdditionalInTransaction } = {}) {
    const state = preparedStates.get(preparation);
    if (!state) {
      throw new BookImportCoverPersistenceError('Book cover preparation is invalid or already consumed.', {
        code: 'INVALID_PREPARATION',
      });
    }
    if (db.inTransaction) {
      throw new BookImportCoverPersistenceError(
        'WP8B import persistence must own the outer database transaction.',
        { code: 'TRANSACTION_OWNERSHIP_REQUIRED' },
      );
    }
    if (persistAdditionalInTransaction !== undefined
      && typeof persistAdditionalInTransaction !== 'function') {
      throw new TypeError('persistAdditionalInTransaction must be a function.');
    }

    try {
      const result = persistPreparedTransaction.immediate(state, persistAdditionalInTransaction);
      preparedStates.delete(preparation);
      return result;
    } catch (cause) {
      const cleanupErrors = compensatePrepared(state);
      preparedStates.delete(preparation);
      throw persistenceFailure(cause, cleanupErrors);
    }
  }

  async function persistValidatedPlan(validatedPlan, options) {
    const preparation = await prepareValidatedPlanCovers(validatedPlan);
    return persistPreparedPlan(preparation, options);
  }

  return Object.freeze({
    prepareValidatedPlanCovers,
    persistPreparedPlan,
    persistValidatedPlan,
  });
}
