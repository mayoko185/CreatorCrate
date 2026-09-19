import {
  createBookImportAssociationPersistenceService,
} from './book-import-association-persistence-service.js';
import {
  createBookImportCoverPersistenceService,
} from './book-import-cover-persistence-service.js';

function publicCoverOutcome(outcome) {
  if (outcome.kind === 'none') return { kind: 'none' };
  if (outcome.kind === 'project_asset') {
    return { kind: 'project_asset', relinked: true, locator: outcome.locator };
  }
  if (outcome.sourceKind === 'project_asset') {
    return {
      kind: 'managed',
      sourceKind: 'project_asset',
      relinked: false,
      locator: outcome.locator,
      unresolvedReason: outcome.unresolvedReason,
    };
  }
  return { kind: 'managed', sourceKind: 'managed' };
}

function publicAssociationReport(report) {
  return {
    resolvedProjectAssociationCount: report.resolvedProjectAssociationCount,
    resolvedAssetAssociationCount: report.resolvedAssetAssociationCount,
    unresolvedProjectLocators: report.unresolvedProjectLocators,
    unresolvedAssetLocators: report.unresolvedAssetLocators,
    historicalUnresolvedProjectCount: report.historicalUnresolvedProjectCount,
    historicalUnresolvedAssetCount: report.historicalUnresolvedAssetCount,
  };
}

/**
 * Final backend-only WP8 orchestration boundary. It accepts an already
 * validated WP7 plan, delegates media/core/cover persistence to WP8A/B, adds
 * associations synchronously inside that transaction, then records one
 * best-effort aggregate activity after commit.
 */
export function createBookImportOrchestrationService({
  db,
  managedImageService,
  applicationLogger,
  coverPersistenceService = db && managedImageService
    ? createBookImportCoverPersistenceService({ db, managedImageService })
    : undefined,
  associationPersistenceService = db
    ? createBookImportAssociationPersistenceService({ db })
    : undefined,
} = {}) {
  if (!coverPersistenceService || typeof coverPersistenceService.persistValidatedPlan !== 'function') {
    throw new TypeError('createBookImportOrchestrationService requires WP8B cover persistence.');
  }
  if (!associationPersistenceService
    || typeof associationPersistenceService.persistInTransaction !== 'function') {
    throw new TypeError('createBookImportOrchestrationService requires WP8C association persistence.');
  }
  if (!applicationLogger || typeof applicationLogger.info !== 'function') {
    throw new TypeError('createBookImportOrchestrationService requires an application logger.');
  }

  async function importValidatedPlan(validatedPlan) {
    const persisted = await coverPersistenceService.persistValidatedPlan(validatedPlan, {
      persistAdditionalInTransaction(result) {
        associationPersistenceService.persistInTransaction(result);
      },
    });

    const associations = publicAssociationReport(persisted.associationOutcome);
    const books = persisted.books.map((book) => ({
      sourceBookKey: book.sourceBookKey,
      sourceTitle: book.sourceTitle,
      destinationBookId: book.destinationBookId,
      destinationTitle: book.destinationTitle,
      renamed: book.renamed,
      coverOutcome: publicCoverOutcome(book.coverOutcome),
      associations: publicAssociationReport(book.associationOutcome),
    }));
    const unresolvedAssociationCount = associations.unresolvedProjectLocators.length
      + associations.unresolvedAssetLocators.length
      + associations.historicalUnresolvedProjectCount
      + associations.historicalUnresolvedAssetCount;
    const context = {
      importedBookCount: books.length,
      renamedBookCount: books.filter((book) => book.renamed).length,
      unresolvedAssociationCount,
      destinationBookIds: books.map((book) => book.destinationBookId),
    };

    let activityRecorded = false;
    try {
      activityRecorded = applicationLogger.info({
        event: 'book.imported',
        kind: 'activity',
        subsystem: 'notes',
        message: 'Book import completed.',
        context,
      }) !== false;
    } catch {
      // Post-commit activity is deliberately non-fatal.
    }

    return {
      success: true,
      importedBookCount: books.length,
      destinationBookIds: context.destinationBookIds,
      books,
      associations,
      activity: activityRecorded
        ? { recorded: true }
        : { recorded: false, warning: 'activity_not_recorded' },
    };
  }

  return Object.freeze({ importValidatedPlan });
}
