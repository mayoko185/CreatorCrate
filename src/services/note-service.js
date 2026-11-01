import crypto from 'node:crypto';
import { NoteError } from '../data/note-repository.js';
import { BookContentIntegrityError, BookNotFoundError } from './book-service.js';
import { buildCurrentBookHierarchy, planBookHierarchy } from './book-hierarchy.js';
import { ChapterNotFoundError } from './chapter-service.js';

export const NOTE_TITLE_MAX = 200;

const REORDER_VALIDATION_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_SEQUENCE_LENGTH',
  'DUPLICATE_ID',
  'UNKNOWN_ID',
  'INVALID_ID',
]);

export class NoteValidationError extends Error {
  constructor(errors, { code } = {}) {
    super('Note validation failed');
    this.name = 'NoteValidationError';
    this.errors = errors;
    if (code) this.code = code;
  }
}

export class NoteNotFoundError extends Error {
  constructor(id) {
    super(`Note ${id} not found`);
    this.name = 'NoteNotFoundError';
    this.status = 404;
  }
}

export class NoteOperationError extends Error {
  constructor(message, { code = 'NOTE_OPERATION_FAILED', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NoteOperationError';
    this.status = 500;
    this.code = code;
  }
}

export class NoteRevisionNotFoundError extends Error {
  constructor(noteId, revisionId) {
    super(`Revision ${revisionId} for Note ${noteId} not found`);
    this.name = 'NoteRevisionNotFoundError';
    this.status = 404;
    this.code = 'NOTE_REVISION_NOT_FOUND';
  }
}

export class NoteRevisionMalformedError extends Error {
  constructor(noteId, revisionId, { cause } = {}) {
    super(
      `Revision ${revisionId} for Note ${noteId} is malformed.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'NoteRevisionMalformedError';
    this.code = 'MALFORMED_REVISION';
  }
}

export class NoteRevisionAssociationUnavailableError extends Error {
  constructor(noteId, revisionId, { missingProjectIds = [], missingAssetIds = [] } = {}) {
    super(`Revision ${revisionId} for Note ${noteId} references unavailable associations.`);
    this.name = 'NoteRevisionAssociationUnavailableError';
    this.code = 'REVISION_ASSOCIATION_UNAVAILABLE';
    this.missingProjectIds = missingProjectIds;
    this.missingAssetIds = missingAssetIds;
  }
}

export const NOTE_DELETION_UNDO_WINDOW_MS = 10 * 60 * 1000;
const NOTE_DELETION_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const NOTE_DELETION_CLEANUP_INTERVAL_MS = 60 * 1000;
const NOTE_DELETION_SNAPSHOT_VERSION = 1;
const NOTE_DELETION_LIST_LIMIT = 10;
const HEX_256_BIT = /^[0-9a-f]{64}$/;
const NOTE_DELETION_OWNER_KINDS = new Set(['session', 'browser']);

const UNDO_ERROR_STATUS = {
  UNDO_UNAVAILABLE: 404,
  UNDO_EXPIRED: 410,
};

export class NoteDeletionUndoError extends Error {
  constructor(code, message = 'This Page deletion cannot be undone.') {
    super(message);
    this.name = 'NoteDeletionUndoError';
    this.code = code;
    this.status = UNDO_ERROR_STATUS[code] ?? 409;
  }
}

/** A random 256-bit public locator for one Page deletion. */
export function createNoteDeletionId() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Purpose-bound HMAC for Undo values. The key is shared with disabled-mode CSRF,
 * where a visitor chooses the cookie string that gets HMACed and can read the
 * result, so that derivation is a chosen-message oracle over UTF-8 text. The
 * leading 0xFF byte can never appear in UTF-8, which keeps these messages
 * outside everything that oracle can sign.
 */
function noteDeletionHmac(secret, parts) {
  return crypto.createHmac('sha256', secret)
    .update(Buffer.from([0xff]))
    .update(JSON.stringify(parts))
    .digest('hex');
}

function hexValuesMatch(expected, submitted) {
  if (typeof submitted !== 'string' || !HEX_256_BIT.test(submitted)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPlainObject(value, fieldLabel) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NoteValidationError({ [fieldLabel]: 'Input must be an object.' });
  }
}

function assertPositiveIntegerId(value, fieldLabel = 'id') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new NoteValidationError({
      [fieldLabel]: `${fieldLabel} must be a positive integer.`,
    });
  }
}

function normalizeAssociationIds(value, fieldLabel, errors, { defaultValue } = {}) {
  if (value === undefined && defaultValue !== undefined) {
    return defaultValue;
  }

  if (!Array.isArray(value)) {
    errors[fieldLabel] = `${fieldLabel} must be an array.`;
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      errors[fieldLabel] = `${fieldLabel} must contain positive integer IDs.`;
      return [];
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }

  return normalized;
}

function normalizeTitle(value, errors, fallback = undefined) {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    errors.title = 'Title must be a string.';
    return '';
  }

  const title = value.trim();
  if (title.length === 0) {
    errors.title = 'Title is required.';
  } else if (title.length > NOTE_TITLE_MAX) {
    errors.title = `Title must be ${NOTE_TITLE_MAX} characters or fewer.`;
  }
  return title;
}

function normalizeContent(value, errors, fallback = '') {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    errors.content = 'Content must be a string.';
    return '';
  }
  return value;
}

function throwValidationIfNeeded(errors) {
  if (Object.keys(errors).length > 0) {
    throw new NoteValidationError(errors);
  }
}

function isForeignKeyConstraint(error) {
  return error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
    || /foreign key constraint failed/i.test(error?.message || '');
}

function isNoteRepositoryError(error) {
  return error instanceof NoteError;
}

/**
 * @param {object} deps
 * @param {object} deps.noteRepository
 * @param {object} deps.projectRepository
 * @param {object} deps.assetRepository
 * @param {object} deps.chapterRepository
 * @param {object} [deps.bookRepository]
 * @param {import('better-sqlite3').Database} [deps.db]
 * @param {object} [deps.bookContentRepository]
 * @param {object} [deps.applicationLogger]
 * @param {object} [deps.noteRevisionSettingsService]
 * @param {object} [deps.bookPagePreviewSettingsRepository]
 * @param {object} [deps.noteDeletionSnapshotRepository]
 * @param {string} [deps.noteDeletionUndoSecret] - persistent server-only key
 * @param {() => number} [deps.now] - epoch milliseconds
 */
export function createNoteService({
  db,
  noteRepository,
  projectRepository,
  assetRepository,
  chapterRepository,
  bookRepository,
  bookContentRepository,
  noteRevisionSettingsService = null,
  applicationLogger = null,
  bookPagePreviewSettingsRepository = null,
  noteDeletionSnapshotRepository = null,
  noteDeletionUndoSecret = null,
  now = () => Date.now(),
} = {}) {
  if (!noteRepository) {
    throw new Error('createNoteService requires a noteRepository dependency.');
  }
  if (!projectRepository) {
    throw new Error('createNoteService requires a projectRepository dependency.');
  }
  if (!assetRepository) {
    throw new Error('createNoteService requires an assetRepository dependency.');
  }
  if (!chapterRepository) {
    throw new Error('createNoteService requires a chapterRepository dependency.');
  }

  function logActivity(event, context) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'notes',
        message: 'Note activity completed.',
        context,
      });
    } catch {
      // Activity logging must never alter the completed Note operation.
    }
  }

  function noteContext(note) {
    return {
      bookId: note.book_id,
      ...(note.chapter_id === null ? {} : { chapterId: note.chapter_id }),
      noteId: note.id,
    };
  }

  function requireNote(id) {
    assertPositiveIntegerId(id);
    const note = noteRepository.findById(id);
    if (!note) {
      throw new NoteNotFoundError(id);
    }
    return note;
  }

  function requireChapter(id, fieldLabel = 'chapterId') {
    assertPositiveIntegerId(id, fieldLabel);
    const chapter = chapterRepository.findById(id);
    if (!chapter) {
      throw new ChapterNotFoundError(id);
    }
    return chapter;
  }

  function requireBook(id) {
    assertPositiveIntegerId(id, 'bookId');
    if (!bookRepository) {
      throw new Error('createNoteService requires a bookRepository dependency for Book-container operations.');
    }
    const book = bookRepository.findById(id);
    if (!book) {
      throw new BookNotFoundError(id);
    }
    return book;
  }

  function throwHierarchyMismatch(chapter, bookId) {
    throw new NoteValidationError({
      chapterId: `Chapter ${chapter.id} belongs to Book ${chapter.book_id}, not Book ${bookId}.`,
    }, { code: 'BOOK_CHAPTER_MISMATCH' });
  }

  function validateAssociationReferences(projectIds, assetIds) {
    const errors = {};

    for (const projectId of projectIds) {
      if (!projectRepository.findById(projectId)) {
        errors.projectIds = `Project ${projectId} not found.`;
        break;
      }
    }

    for (const assetId of assetIds) {
      if (!assetRepository.findById(assetId)) {
        errors.assetIds = `Asset ${assetId} not found.`;
        break;
      }
    }

    throwValidationIfNeeded(errors);
  }

  function normalizeCreateInput(input) {
    assertPlainObject(input, 'input');
    const errors = {};
    const hasChapterId = input.chapterId !== undefined && input.chapterId !== null;
    const hasBookId = input.bookId !== undefined;
    if (hasBookId && (typeof input.bookId !== 'number'
      || !Number.isSafeInteger(input.bookId)
      || input.bookId <= 0)) {
      errors.bookId = 'bookId must be a positive integer.';
    }
    if (hasChapterId && (typeof input.chapterId !== 'number'
      || !Number.isSafeInteger(input.chapterId)
      || input.chapterId <= 0)) {
      errors.chapterId = 'chapterId must be a positive integer.';
    }
    if (!hasBookId && !hasChapterId) {
      errors.bookId = 'bookId must be a positive integer.';
    }
    const title = normalizeTitle(input.title, errors);
    const content = normalizeContent(input.content, errors);
    const projectIds = normalizeAssociationIds(input.projectIds, 'projectIds', errors, {
      defaultValue: [],
    });
    const assetIds = normalizeAssociationIds(input.assetIds, 'assetIds', errors, {
      defaultValue: [],
    });

    throwValidationIfNeeded(errors);

    let bookId = input.bookId;
    let chapter = null;
    if (hasBookId) {
      requireBook(bookId);
    }
    if (hasChapterId) {
      chapter = requireChapter(input.chapterId);
      if (!hasBookId) {
        // Temporary compatibility for the existing chapter-only callers.
        bookId = chapter.book_id;
        if (bookRepository) requireBook(bookId);
      } else if (chapter.book_id !== bookId) {
        throwHierarchyMismatch(chapter, bookId);
      }
    }
    validateAssociationReferences(projectIds, assetIds);
    return {
      bookId,
      chapterId: hasChapterId ? input.chapterId : null,
      title,
      content,
      projectIds,
      assetIds,
    };
  }

  function normalizeUpdateInput(input) {
    assertPlainObject(input, 'input');
    const errors = {};
    if (Object.hasOwn(input, 'bookId')) {
      errors.bookId = 'bookId cannot be changed by updating a Note.';
    }
    if (Object.hasOwn(input, 'chapterId')) {
      errors.chapterId = 'chapterId cannot be changed by updating a Note.';
    }
    const title = Object.hasOwn(input, 'title')
      ? normalizeTitle(input.title, errors)
      : undefined;
    const content = Object.hasOwn(input, 'content')
      ? normalizeContent(input.content, errors)
      : undefined;
    const projectIds = Object.hasOwn(input, 'projectIds')
      ? normalizeAssociationIds(input.projectIds, 'projectIds', errors)
      : undefined;
    const assetIds = Object.hasOwn(input, 'assetIds')
      ? normalizeAssociationIds(input.assetIds, 'assetIds', errors)
      : undefined;

    throwValidationIfNeeded(errors);
    validateAssociationReferences(projectIds ?? [], assetIds ?? []);
    return { title, content, projectIds, assetIds };
  }

  function detail(note, associations = {}) {
    return {
      ...note,
      projectIds: associations.projectIds ?? noteRepository.listProjectsForNote(note.id),
      assetIds: associations.assetIds ?? noteRepository.listAssetsForNote(note.id),
    };
  }

  function getRevisionRetention() {
    return noteRevisionSettingsService?.getRevisionRetention?.() ?? 10;
  }

  function persistWithAssociations(
    id,
    values,
    { revisionRetention = id === undefined ? undefined : getRevisionRetention() } = {},
  ) {
    try {
      const input = { id, ...values };
      const result = revisionRetention === undefined
        ? noteRepository.saveWithAssociations(input)
        : noteRepository.saveWithAssociations(input, { revisionRetention });
      if (!result) {
        throw new NoteNotFoundError(id);
      }
      return { note: detail(result.note, result), changed: result.changed };
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        throw error;
      }
      if (isForeignKeyConstraint(error)) {
        throw new NoteValidationError({
          associations: 'One or more referenced projects or assets no longer exist.',
        });
      }
      throw error;
    }
  }

  function findRevision(noteId, revisionId) {
    try {
      return noteRepository.findRevision(noteId, revisionId);
    } catch (error) {
      if (isNoteRepositoryError(error) && error.code === 'MALFORMED_REVISION') {
        throw new NoteRevisionMalformedError(noteId, revisionId, { cause: error });
      }
      throw error;
    }
  }

  function requireRevision(noteId, revisionId) {
    assertPositiveIntegerId(revisionId, 'revisionId');
    const revision = findRevision(noteId, revisionId);
    if (!revision) throw new NoteRevisionNotFoundError(noteId, revisionId);
    return revision;
  }

  function validateHistoricalAssociations(noteId, revision) {
    const missingProjectIds = revision.projectIds.filter((id) => !projectRepository.findById(id));
    const missingAssetIds = revision.assetIds.filter((id) => !assetRepository.findById(id));
    if (missingProjectIds.length > 0 || missingAssetIds.length > 0) {
      throw new NoteRevisionAssociationUnavailableError(noteId, revision.id, {
        missingProjectIds,
        missingAssetIds,
      });
    }
  }

  function validateHistoricalRevision(noteId, revision) {
    const errors = {};
    const title = normalizeTitle(revision.title, errors);
    const content = normalizeContent(revision.content, errors);
    if (Object.keys(errors).length > 0 || title !== revision.title || content !== revision.content) {
      throw new NoteRevisionMalformedError(noteId, revision.id);
    }
  }

  const restoreRevisionTx = db && typeof db.transaction === 'function'
    ? db.transaction((noteId, revisionId) => {
      requireNote(noteId);
      const revision = requireRevision(noteId, revisionId);
      validateHistoricalRevision(noteId, revision);
      validateHistoricalAssociations(noteId, revision);
      return persistWithAssociations(noteId, {
        title: revision.title,
        content: revision.content,
        projectIds: revision.projectIds,
        assetIds: revision.assetIds,
      }, { revisionRetention: getRevisionRetention() });
    })
    : null;

  const createDirectBookPageTx = db && typeof db.transaction === 'function'
    ? db.transaction((values) => {
      const outcome = persistWithAssociations(undefined, values);
      bookContentRepository.append(values.bookId, 'page', outcome.note.id);
      return outcome;
    })
    : null;

  function persistDirectBookPage(values) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for direct Book Page creation.');
    }
    if (!createDirectBookPageTx) {
      throw new Error('createNoteService requires a db dependency for direct Book Page creation.');
    }
    return createDirectBookPageTx(values);
  }

  const deleteDirectBookPageTx = db && typeof db.transaction === 'function'
    ? db.transaction((note) => {
      const deleted = noteRepository.deleteById(note.id);
      if (!deleted) {
        throw new NoteNotFoundError(note.id);
      }

      const removed = bookContentRepository.remove(note.book_id, 'page', note.id);
      if (!removed) {
        throw new NoteOperationError(
          `Direct Book Page ${note.id} is missing from Book ${note.book_id}.`,
          { code: 'MEMBERSHIP_NOT_FOUND' },
        );
      }

      return deleted;
    })
    : null;

  function deleteDirectBookPage(note) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for direct Book Page deletion.');
    }
    if (!deleteDirectBookPageTx) {
      throw new Error('createNoteService requires a db dependency for direct Book Page deletion.');
    }
    return deleteDirectBookPageTx(note);
  }

  function performNoteDeletion(note) {
    if (note.chapter_id === null) {
      return deleteDirectBookPage(note);
    }

    const deleted = noteRepository.deleteById(note.id);
    if (!deleted) {
      throw new NoteNotFoundError(note.id);
    }
    return deleted;
  }

  // ─── Page deletion Undo ──────────────────────────────────────────────────

  const noteDeletionUndoConfigured = Boolean(
    db
    && typeof db.transaction === 'function'
    && bookRepository
    && bookContentRepository
    && bookPagePreviewSettingsRepository
    && noteDeletionSnapshotRepository
    && typeof noteDeletionUndoSecret === 'string'
    && noteDeletionUndoSecret.length > 0
  );

  function requireNoteDeletionUndo() {
    if (!noteDeletionUndoConfigured) {
      throw new NoteOperationError('Page deletion Undo is not configured.', {
        code: 'UNDO_NOT_CONFIGURED',
      });
    }
  }

  function assertHex256(value, fieldLabel) {
    if (typeof value !== 'string' || !HEX_256_BIT.test(value)) {
      throw new NoteValidationError({ [fieldLabel]: `${fieldLabel} is invalid.` });
    }
  }

  function undoTokenFor({ id, owner_key: ownerKey, note_id: noteId, expires_at: expiresAt }) {
    return noteDeletionHmac(noteDeletionUndoSecret, [
      'note-deletion-undo-token', 1, id, ownerKey, noteId, expiresAt,
    ]);
  }

  let nextNoteDeletionCleanupAt = 0;

  // Opportunistic and throttled. A failure only delays erasure: restoration
  // checks expires_at itself, so an uncleaned row still cannot be restored.
  function cleanupNoteDeletionSnapshots() {
    if (!noteDeletionSnapshotRepository) return;
    const current = now();
    if (current < nextNoteDeletionCleanupAt) return;
    nextNoteDeletionCleanupAt = current + NOTE_DELETION_CLEANUP_INTERVAL_MS;
    try {
      noteDeletionSnapshotRepository.clearExpiredSnapshots(current);
      noteDeletionSnapshotRepository.deleteReceiptsExpiredBy(
        current - NOTE_DELETION_RECEIPT_RETENTION_MS,
      );
    } catch {
      // Cleanup must never alter the Note operation that triggered it.
    }
  }

  function readAffectedOrdering(note) {
    return {
      pageOrder: (note.chapter_id === null
        ? noteRepository.listForBook(note.book_id)
        : noteRepository.listForChapter(note.chapter_id)
      ).map(({ id, sort_order }) => ({ id, sort_order })),
      bookContents: note.chapter_id === null
        ? bookContentRepository.listForBook(note.book_id)
        : null,
    };
  }

  function readPreviewSelection(bookId) {
    return {
      mode: bookPagePreviewSettingsRepository.findByBookId(bookId)?.mode ?? null,
      selectedPageIds: bookPagePreviewSettingsRepository.listSelectedPageIds(bookId),
    };
  }

  function captureBeforeDeletion(note) {
    const book = bookRepository.findById(note.book_id);
    const chapter = note.chapter_id === null ? null : chapterRepository.findById(note.chapter_id);
    if (!book || (note.chapter_id !== null && chapter?.book_id !== note.book_id)) {
      throw new BookContentIntegrityError(
        `Page ${note.id} has an inconsistent parent hierarchy.`,
        { code: 'HIERARCHY_INTEGRITY' },
      );
    }
    return {
      graph: noteRepository.readDeletionGraph(note.id),
      // Timestamps pin the parents' identity, not only their numeric IDs.
      parent: {
        bookCreatedAt: book.created_at,
        chapterCreatedAt: chapter ? chapter.created_at : null,
      },
      before: {
        ...readAffectedOrdering(note),
        pageSelected: bookPagePreviewSettingsRepository.isPageSelected(note.book_id, note.id),
      },
    };
  }

  const deleteNoteWithUndoTx = noteDeletionUndoConfigured
    ? db.transaction((noteId, deletionId, ownerKey) => {
      if (noteDeletionSnapshotRepository.findReceipt(deletionId)) {
        throw new NoteDeletionUndoError(
          'UNDO_DELETION_ID_CONFLICT',
          'This deletion ID has already been used.',
        );
      }

      const note = requireNote(noteId);
      const captured = captureBeforeDeletion(note);
      performNoteDeletion(note);

      const snapshotJson = JSON.stringify({
        ...captured,
        after: {
          ...readAffectedOrdering(note),
          preview: readPreviewSelection(note.book_id),
        },
      });
      const createdAt = now();
      const expiresAt = createdAt + NOTE_DELETION_UNDO_WINDOW_MS;
      noteDeletionSnapshotRepository.insert({
        id: deletionId,
        ownerKey,
        noteId: note.id,
        bookId: note.book_id,
        chapterId: note.chapter_id,
        createdAt,
        expiresAt,
        snapshotVersion: NOTE_DELETION_SNAPSHOT_VERSION,
        snapshotJson,
      });
      return { note, createdAt, expiresAt };
    })
    : null;

  function loadOwnedReceipt(deletionId, ownerKey) {
    const receipt = typeof deletionId === 'string' && HEX_256_BIT.test(deletionId)
      ? noteDeletionSnapshotRepository.findReceipt(deletionId)
      : undefined;
    if (!receipt || !hexValuesMatch(receipt.owner_key, ownerKey)) {
      throw new NoteDeletionUndoError('UNDO_UNAVAILABLE');
    }
    return receipt;
  }

  // The one eligibility rule shared by token issuance and restoration.
  function readActivePayload(receipt, current) {
    if (receipt.restored_at !== null) {
      throw new NoteDeletionUndoError('UNDO_ALREADY_RESTORED');
    }
    if (current >= receipt.expires_at) {
      throw new NoteDeletionUndoError('UNDO_EXPIRED');
    }
    if (receipt.snapshot_version !== NOTE_DELETION_SNAPSHOT_VERSION) {
      throw new NoteDeletionUndoError('UNDO_UNAVAILABLE');
    }
    const json = noteDeletionSnapshotRepository.findSnapshotJson(receipt.id);
    if (typeof json !== 'string') {
      throw new NoteDeletionUndoError('UNDO_EXPIRED');
    }
    return json;
  }

  function assertRestorable({ graph, parent, after, before }) {
    const { note } = graph;

    const book = bookRepository.findById(note.book_id);
    if (!book || book.created_at !== parent.bookCreatedAt) {
      throw new NoteDeletionUndoError('UNDO_PARENT_MISSING');
    }
    if (note.chapter_id !== null) {
      const chapter = chapterRepository.findById(note.chapter_id);
      if (!chapter
        || chapter.book_id !== note.book_id
        || chapter.created_at !== parent.chapterCreatedAt) {
        throw new NoteDeletionUndoError('UNDO_PARENT_CHANGED');
      }
    }

    if (noteRepository.findById(note.id)
      || graph.revisions.some(({ id }) => noteRepository.isRevisionIdOccupied(id))) {
      throw new NoteDeletionUndoError('UNDO_ID_CONFLICT');
    }

    if (graph.projectIds.some((id) => !projectRepository.findById(id))
      || graph.assetIds.some((id) => !assetRepository.findById(id))) {
      throw new NoteDeletionUndoError('UNDO_ASSOCIATION_MISSING');
    }

    const ordering = readAffectedOrdering(note);
    if (!sameJson(ordering.pageOrder, after.pageOrder)
      || !sameJson(ordering.bookContents, after.bookContents)) {
      throw new NoteDeletionUndoError('UNDO_ORDER_CHANGED');
    }

    // An unselected Page does not take part in the preview at all, so later
    // preview edits only conflict when a selection has to be reinstated.
    if (before.pageSelected && !sameJson(readPreviewSelection(note.book_id), after.preview)) {
      throw new NoteDeletionUndoError('UNDO_PREVIEW_CHANGED');
    }
  }

  function writeRestoredPage({ graph, before }) {
    const { note } = graph;
    noteRepository.restoreDeletedGraph(graph);
    noteRepository.restoreSortOrders(before.pageOrder.filter(({ id }) => id !== note.id));
    if (before.bookContents) {
      bookContentRepository.restoreRows(note.book_id, before.bookContents);
    }
    if (before.pageSelected) {
      bookPagePreviewSettingsRepository.restorePageSelection(note.book_id, note.id);
    }
  }

  function assertRestoredPage({ graph, before }) {
    const { note } = graph;
    const ordering = readAffectedOrdering(note);
    if (!sameJson(noteRepository.readDeletionGraph(note.id), graph)
      || !sameJson(ordering.pageOrder, before.pageOrder)
      || !sameJson(ordering.bookContents, before.bookContents)
      || bookPagePreviewSettingsRepository.isPageSelected(note.book_id, note.id) !== before.pageSelected) {
      throw new BookContentIntegrityError(
        `Restored Page ${note.id} does not match its deletion snapshot.`,
        { code: 'HIERARCHY_INTEGRITY' },
      );
    }
  }

  // Any throw rolls back every write here, including the consumption marker.
  const restoreDeletedNoteTx = noteDeletionUndoConfigured
    ? db.transaction((deletionId, ownerKey, undoToken) => {
      const receipt = loadOwnedReceipt(deletionId, ownerKey);
      if (!hexValuesMatch(undoTokenFor(receipt), undoToken)) {
        throw new NoteDeletionUndoError('UNDO_UNAVAILABLE');
      }

      // Read after the write lock is held: this instant decides expiry.
      const current = now();
      const snapshot = JSON.parse(readActivePayload(receipt, current));
      assertRestorable(snapshot);
      writeRestoredPage(snapshot);
      assertRestoredPage(snapshot);

      if (!noteDeletionSnapshotRepository.markRestored(receipt.id, current)) {
        throw new NoteDeletionUndoError('UNDO_ALREADY_RESTORED');
      }
      return { note: snapshot.graph.note, restoredAt: current };
    })
    : null;

  function rethrowUndoFailure(error, message) {
    if (error instanceof NoteDeletionUndoError
      || error instanceof NoteValidationError
      || error instanceof NoteNotFoundError
      || error instanceof NoteOperationError
      || error instanceof BookContentIntegrityError) {
      throw error;
    }
    throw new NoteOperationError(message, { code: 'UNDO_OPERATION_FAILED', cause: error });
  }

  cleanupNoteDeletionSnapshots();

  const moveChapterPageToDirectBookTx = db && typeof db.transaction === 'function'
    ? db.transaction((note, target) => {
      const moved = noteRepository.moveToContainer(note.id, target);
      if (!moved) {
        throw new NoteNotFoundError(note.id);
      }

      bookContentRepository.append(target.bookId, 'page', note.id);
      return moved;
    })
    : null;

  function moveChapterPageToDirectBook(note, target) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for Chapter Page movement to a direct Book Page.');
    }
    if (!moveChapterPageToDirectBookTx) {
      throw new Error('createNoteService requires a db dependency for Chapter Page movement to a direct Book Page.');
    }
    return moveChapterPageToDirectBookTx(note, target);
  }

  const moveDirectBookPageToChapterTx = db && typeof db.transaction === 'function'
    ? db.transaction((note, target) => {
      const sourceBookId = note.book_id;
      const moved = noteRepository.moveToContainer(note.id, target);
      if (!moved) {
        throw new NoteNotFoundError(note.id);
      }

      const removed = bookContentRepository.remove(sourceBookId, 'page', note.id);
      if (!removed) {
        throw new NoteOperationError(
          `Direct Book Page ${note.id} is missing from Book ${sourceBookId}.`,
          { code: 'MEMBERSHIP_NOT_FOUND' },
        );
      }

      return moved;
    })
    : null;

  function moveDirectBookPageToChapter(note, target) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for direct Book Page movement to a Chapter Page.');
    }
    if (!moveDirectBookPageToChapterTx) {
      throw new Error('createNoteService requires a db dependency for direct Book Page movement to a Chapter Page.');
    }
    return moveDirectBookPageToChapterTx(note, target);
  }

  const moveDirectBookPageToDirectBookTx = db && typeof db.transaction === 'function'
    ? db.transaction((note, target) => {
      const sourceBookId = note.book_id;
      const targetBookId = target.bookId;
      const moved = noteRepository.moveToContainer(note.id, target);
      if (!moved) {
        throw new NoteNotFoundError(note.id);
      }

      const removed = bookContentRepository.remove(sourceBookId, 'page', note.id);
      if (!removed) {
        throw new NoteOperationError(
          `Direct Book Page ${note.id} is missing from Book ${sourceBookId}.`,
          { code: 'MEMBERSHIP_NOT_FOUND' },
        );
      }

      bookContentRepository.append(targetBookId, 'page', note.id);
      return moved;
    })
    : null;

  function moveDirectBookPageToDirectBook(note, target) {
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for direct Book Page movement between direct Book Pages.');
    }
    if (!moveDirectBookPageToDirectBookTx) {
      throw new Error('createNoteService requires a db dependency for direct Book Page movement between direct Book Pages.');
    }
    return moveDirectBookPageToDirectBookTx(note, target);
  }

  function validateReorderInput(orderedIds) {
    if (!Array.isArray(orderedIds)) {
      throw new NoteValidationError({ orderedIds: 'orderedIds must be an array.' });
    }

    const seen = new Set();

    for (const id of orderedIds) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
        throw new NoteValidationError({ orderedIds: 'Note IDs must be positive integers.' });
      }
      if (seen.has(id)) {
        throw new NoteValidationError({ orderedIds: 'Note order must not contain duplicate IDs.' });
      }
      seen.add(id);
    }
  }

  function normalizeMoveTarget(target) {
    assertPlainObject(target, 'target');
    const errors = {};
    const hasChapterId = target.chapterId !== undefined && target.chapterId !== null;
    if (typeof target.bookId !== 'number'
      || !Number.isSafeInteger(target.bookId)
      || target.bookId <= 0) {
      errors.bookId = 'bookId must be a positive integer.';
    }
    if (hasChapterId && (typeof target.chapterId !== 'number'
      || !Number.isSafeInteger(target.chapterId)
      || target.chapterId <= 0)) {
      errors.chapterId = 'chapterId must be a positive integer.';
    }
    throwValidationIfNeeded(errors);
    return {
      bookId: target.bookId,
      chapterId: hasChapterId ? target.chapterId : null,
    };
  }

  function moveNoteToContainer(noteId, target, { knownTargetChapter = null } = {}) {
    const sourceNote = requireNote(noteId);
    const normalizedTarget = normalizeMoveTarget(target);
    if (!knownTargetChapter || bookRepository) {
      requireBook(normalizedTarget.bookId);
    }

    const targetChapter = normalizedTarget.chapterId === null
      ? null
      : knownTargetChapter || requireChapter(normalizedTarget.chapterId, 'chapterId');
    if (targetChapter && targetChapter.book_id !== normalizedTarget.bookId) {
      throwHierarchyMismatch(targetChapter, normalizedTarget.bookId);
    }

    try {
      if (sourceNote.chapter_id !== null && normalizedTarget.chapterId === null) {
        return { sourceNote, moved: moveChapterPageToDirectBook(sourceNote, normalizedTarget) };
      }
      if (sourceNote.chapter_id === null && normalizedTarget.chapterId !== null) {
        return { sourceNote, moved: moveDirectBookPageToChapter(sourceNote, normalizedTarget) };
      }
      if (sourceNote.chapter_id === null && normalizedTarget.chapterId === null) {
        if (sourceNote.book_id !== normalizedTarget.bookId) {
          return { sourceNote, moved: moveDirectBookPageToDirectBook(sourceNote, normalizedTarget) };
        }
      }

      const moved = noteRepository.moveToContainer(noteId, normalizedTarget);
      if (!moved) {
        throw new NoteNotFoundError(noteId);
      }
      return { sourceNote, moved };
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        throw error;
      }
      if (isNoteRepositoryError(error)) {
        if (error.code === 'TARGET_BOOK_NOT_FOUND' || error.code === 'BOOK_NOT_FOUND') {
          throw new BookNotFoundError(normalizedTarget.bookId);
        }
        if (error.code === 'TARGET_CHAPTER_NOT_FOUND' || error.code === 'CHAPTER_NOT_FOUND') {
          throw new ChapterNotFoundError(normalizedTarget.chapterId);
        }
        if (error.code === 'BOOK_CHAPTER_MISMATCH') {
          throw new NoteValidationError({
            chapterId: 'chapterId must belong to bookId.',
          }, { code: 'BOOK_CHAPTER_MISMATCH' });
        }
        throw new NoteValidationError({ noteId: 'Note move could not be completed.' });
      }
      throw error;
    }
  }

  function requireHierarchyDependencies() {
    if (!db || typeof db.transaction !== 'function') {
      throw new Error('createNoteService requires a db dependency for Book hierarchy reordering.');
    }
    if (!bookRepository) {
      throw new Error('createNoteService requires a bookRepository dependency for Book hierarchy reordering.');
    }
    if (!bookContentRepository) {
      throw new Error('createNoteService requires a bookContentRepository dependency for Book hierarchy reordering.');
    }
    if (typeof noteRepository.listAllForBook !== 'function') {
      throw new Error('createNoteService requires noteRepository.listAllForBook for Book hierarchy reordering.');
    }
  }

  function readBookHierarchySnapshot(bookId) {
    return {
      bookId,
      book: requireBook(bookId),
      chapters: chapterRepository.listForBook(bookId),
      pages: noteRepository.listAllForBook(bookId),
      memberships: bookContentRepository.listForBook(bookId),
    };
  }

  const reorderBookHierarchyTx = db && typeof db.transaction === 'function'
    ? db.transaction((bookId, submission) => {
      const snapshot = readBookHierarchySnapshot(bookId);
      const plan = planBookHierarchy(snapshot, submission);
      if (!plan.changed) {
        return { changed: false, hierarchy: plan.currentHierarchy };
      }

      const chapterById = new Map(snapshot.chapters.map((chapter) => [chapter.id, chapter]));
      for (const { pageId, targetChapterId } of plan.pageDestinationChanges) {
        moveNoteToContainer(
          pageId,
          { bookId, chapterId: targetChapterId },
          { knownTargetChapter: targetChapterId === null ? null : chapterById.get(targetChapterId) },
        );
      }

      bookContentRepository.reorder(bookId, plan.rootTargetItems);
      for (const [chapterId, pageIds] of plan.chapterTargetOrders) {
        noteRepository.reorder(chapterId, pageIds);
      }

      const finalSnapshot = readBookHierarchySnapshot(bookId);
      const finalHierarchy = buildCurrentBookHierarchy(finalSnapshot);
      if (JSON.stringify(finalHierarchy) !== JSON.stringify(plan.targetHierarchy)) {
        throw new BookContentIntegrityError(
          'Persisted Book hierarchy does not match the validated target.',
          { code: 'HIERARCHY_INTEGRITY' },
        );
      }

      return { changed: true, hierarchy: finalHierarchy };
    })
    : null;

  return {
    createNote(input) {
      const values = normalizeCreateInput(input);
      const { note: created } = values.chapterId === null
        ? persistDirectBookPage(values)
        : persistWithAssociations(undefined, values);
      logActivity('note.created', noteContext(created));
      return created;
    },

    getNote(id) {
      return detail(requireNote(id));
    },

    listNoteRevisions(id) {
      requireNote(id);
      return noteRepository.listRevisions(id);
    },

    getNoteRevision(noteId, revisionId) {
      requireNote(noteId);
      return requireRevision(noteId, revisionId);
    },

    restoreNoteRevision(noteId, revisionId) {
      if (!restoreRevisionTx) {
        throw new Error('createNoteService requires a db dependency for Note revision restore.');
      }
      assertPositiveIntegerId(noteId, 'noteId');
      const outcome = restoreRevisionTx.immediate(noteId, revisionId);
      if (outcome.changed) {
        logActivity('note.restored', {
          ...noteContext(outcome.note),
          revisionId,
        });
      }
      return outcome.note;
    },

    listNotes() {
      return noteRepository.list();
    },

    listNotesForChapter(chapterId) {
      requireChapter(chapterId);
      return noteRepository.listForChapter(chapterId);
    },

    listNotesForBook(bookId) {
      requireBook(bookId);
      return noteRepository.listForBook(bookId);
    },

    getBookHierarchy(bookId) {
      requireHierarchyDependencies();
      assertPositiveIntegerId(bookId, 'bookId');
      return buildCurrentBookHierarchy(readBookHierarchySnapshot(bookId));
    },

    updateNote(id, input) {
      const values = normalizeUpdateInput(input);
      const { note: updated, changed } = persistWithAssociations(id, values);
      if (changed) {
        logActivity('note.updated', noteContext(updated));
      }
      return updated;
    },

    deleteNote(id) {
      const note = requireNote(id);
      const deleted = performNoteDeletion(note);
      logActivity('note.deleted', noteContext(note));
      return deleted;
    },

    /**
     * False when Undo cannot be honored. A deletion that promises Undo must then
     * be refused; falling back to deleteNote would delete without recovery.
     */
    isNoteDeletionUndoConfigured() {
      return noteDeletionUndoConfigured;
    },

    /**
     * Derive the stored owner key from trusted server request context. Never
     * pass a value taken from a request body, query or custom header.
     *
     * @param {{ kind: 'session'|'browser', identity: string }} owner
     * @returns {string}
     */
    deriveNoteDeletionOwnerKey({ kind, identity } = {}) {
      requireNoteDeletionUndo();
      if (!NOTE_DELETION_OWNER_KINDS.has(kind) || typeof identity !== 'string' || identity.length === 0) {
        throw new NoteValidationError({ owner: 'owner is invalid.' });
      }
      return noteDeletionHmac(noteDeletionUndoSecret, ['note-deletion-owner', 1, kind, identity]);
    },

    /**
     * Delete a Page and commit its recovery snapshot in one transaction, or
     * refuse with UNDO_NOT_CONFIGURED and change nothing. The returned undoToken
     * is derived, never stored; issueNoteDeletionUndoAction derives it again.
     *
     * @param {number} noteId
     * @param {{ deletionId: string, ownerKey: string }} context
     */
    deleteNoteWithUndo(noteId, { deletionId, ownerKey } = {}) {
      requireNoteDeletionUndo();
      assertHex256(deletionId, 'deletionId');
      assertHex256(ownerKey, 'ownerKey');
      cleanupNoteDeletionSnapshots();

      let outcome;
      try {
        outcome = deleteNoteWithUndoTx.immediate(noteId, deletionId, ownerKey);
      } catch (error) {
        rethrowUndoFailure(error, 'The Page could not be deleted.');
      }

      const { note, createdAt, expiresAt } = outcome;
      logActivity('note.deleted', noteContext(note));
      return {
        deletionId,
        noteId: note.id,
        bookId: note.book_id,
        chapterId: note.chapter_id,
        title: note.title,
        status: 'available',
        createdAt,
        expiresAt,
        undoToken: undoTokenFor({
          id: deletionId, owner_key: ownerKey, note_id: note.id, expires_at: expiresAt,
        }),
      };
    },

    /**
     * Safe status of one owned deletion. Exposes neither the payload nor a token.
     *
     * @param {string} deletionId
     * @param {{ ownerKey: string }} context
     * @returns {{ deletionId: string, noteId: number, bookId: number, chapterId: number|null, status: 'available'|'restored'|'expired', createdAt: number, expiresAt: number, restoredAt: number|null }}
     */
    getNoteDeletionUndo(deletionId, { ownerKey } = {}) {
      requireNoteDeletionUndo();
      cleanupNoteDeletionSnapshots();
      const receipt = loadOwnedReceipt(deletionId, ownerKey);
      let status = 'available';
      if (receipt.restored_at !== null) status = 'restored';
      else if (now() >= receipt.expires_at) status = 'expired';
      return {
        deletionId: receipt.id,
        noteId: receipt.note_id,
        bookId: receipt.book_id,
        chapterId: receipt.chapter_id,
        status,
        createdAt: receipt.created_at,
        expiresAt: receipt.expires_at,
        restoredAt: receipt.restored_at,
      };
    },

    /**
     * The owner's active deletions directly inside one parent, newest first, so
     * a clean parent URL can rediscover them. Carries no payload and no token.
     * chapterId null means Pages directly in the Book.
     *
     * @param {{ ownerKey: string, bookId?: number, chapterId?: number|null, limit?: number }} context
     * @returns {{ deletions: Array<{ deletionId: string, noteId: number, bookId: number, chapterId: number|null, title: string|null, status: 'available', createdAt: number, expiresAt: number }>, hasMore: boolean }}
     */
    listNoteDeletionUndos({ ownerKey, bookId = null, chapterId = null, limit = NOTE_DELETION_LIST_LIMIT } = {}) {
      requireNoteDeletionUndo();
      assertHex256(ownerKey, 'ownerKey');
      cleanupNoteDeletionSnapshots();
      const rows = noteDeletionSnapshotRepository.listActiveForOwnerInParent(
        ownerKey, { bookId, chapterId }, now(), limit + 1,
      );
      return {
        deletions: rows.slice(0, limit)
          .filter((row) => row.snapshot_version === NOTE_DELETION_SNAPSHOT_VERSION)
          .map((row) => ({
            deletionId: row.id,
            noteId: row.note_id,
            bookId: row.book_id,
            chapterId: row.chapter_id,
            title: row.title,
            status: 'available',
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          })),
        hasMore: rows.length > limit,
      };
    },

    /**
     * Re-derive the action token of one active deletion for its verified owner,
     * so Undo survives navigation, refresh and restart. ownerKey must come from
     * deriveNoteDeletionOwnerKey over trusted server state. Never put the token
     * in a URL or log, and only return it in a no-store response.
     *
     * @param {string} deletionId
     * @param {{ ownerKey: string }} context
     * @returns {{ deletionId: string, noteId: number, bookId: number, chapterId: number|null, status: 'available', createdAt: number, expiresAt: number, restoredAt: null, undoToken: string }}
     * @throws {NoteDeletionUndoError} UNDO_UNAVAILABLE, UNDO_EXPIRED or UNDO_ALREADY_RESTORED
     */
    issueNoteDeletionUndoAction(deletionId, { ownerKey } = {}) {
      requireNoteDeletionUndo();
      cleanupNoteDeletionSnapshots();
      try {
        const receipt = loadOwnedReceipt(deletionId, ownerKey);
        readActivePayload(receipt, now());
        return {
          deletionId: receipt.id,
          noteId: receipt.note_id,
          bookId: receipt.book_id,
          chapterId: receipt.chapter_id,
          status: 'available',
          createdAt: receipt.created_at,
          expiresAt: receipt.expires_at,
          restoredAt: null,
          undoToken: undoTokenFor(receipt),
        };
      } catch (error) {
        return rethrowUndoFailure(error, 'The Page deletion could not be read.');
      }
    },

    /**
     * Restore a deleted Page completely or refuse with a NoteDeletionUndoError.
     * A refused or failed attempt changes nothing and keeps the opportunity.
     *
     * @param {string} deletionId
     * @param {{ ownerKey: string, undoToken: string }} context
     * @returns {{ deletionId: string, noteId: number, bookId: number, chapterId: number|null, status: 'restored', restoredAt: number }}
     */
    restoreDeletedNote(deletionId, { ownerKey, undoToken } = {}) {
      requireNoteDeletionUndo();
      cleanupNoteDeletionSnapshots();

      let outcome;
      try {
        outcome = restoreDeletedNoteTx.immediate(deletionId, ownerKey, undoToken);
      } catch (error) {
        rethrowUndoFailure(error, 'The Page could not be restored.');
      }

      const { note, restoredAt } = outcome;
      logActivity('note.deletion_undone', noteContext(note));
      return {
        deletionId,
        noteId: note.id,
        bookId: note.book_id,
        chapterId: note.chapter_id,
        status: 'restored',
        restoredAt,
      };
    },

    reorderNotes(chapterId, orderedIds) {
      requireChapter(chapterId);
      validateReorderInput(orderedIds);
      try {
        const reordered = noteRepository.reorder(chapterId, orderedIds);
        if (reordered.changed) {
          logActivity('note.reordered', { chapterId, affectedCount: reordered.length });
        }
        return reordered;
      } catch (error) {
        if (isNoteRepositoryError(error) && REORDER_VALIDATION_CODES.has(error.code)) {
          throw new NoteValidationError({
            orderedIds: 'Note order must contain every current note exactly once.',
          });
        }
        throw error;
      }
    },

    reorderBookPages(bookId, orderedIds) {
      requireBook(bookId);
      validateReorderInput(orderedIds);
      try {
        const reordered = noteRepository.reorderForBook(bookId, orderedIds);
        if (reordered.changed) {
          logActivity('note.reordered', { bookId, affectedCount: reordered.length });
        }
        return reordered;
      } catch (error) {
        if (isNoteRepositoryError(error) && REORDER_VALIDATION_CODES.has(error.code)) {
          throw new NoteValidationError({
            orderedIds: 'Note order must contain every current direct Book Page exactly once.',
          });
        }
        if (isNoteRepositoryError(error) && error.code === 'BOOK_NOT_FOUND') {
          throw new BookNotFoundError(bookId);
        }
        throw error;
      }
    },

    reorderBookHierarchy(bookId, submission) {
      requireHierarchyDependencies();
      assertPositiveIntegerId(bookId, 'bookId');
      const outcome = reorderBookHierarchyTx.immediate(bookId, submission);
      if (outcome.changed) {
        logActivity('book.hierarchy.reordered', { bookId });
      }
      return outcome;
    },

    moveNote(noteId, target) {
      const { sourceNote, moved } = moveNoteToContainer(noteId, target);
      if (sourceNote.book_id !== moved.book_id || sourceNote.chapter_id !== moved.chapter_id) {
        logActivity('note.moved', {
          ...noteContext(sourceNote),
          destinationBookId: moved.book_id,
          ...(moved.chapter_id === null ? {} : { destinationChapterId: moved.chapter_id }),
        });
      }
      return moved;
    },

    moveNoteToChapter(noteId, targetChapterId) {
      const targetChapter = requireChapter(targetChapterId, 'targetChapterId');
      const { sourceNote, moved } = moveNoteToContainer(
        noteId,
        { bookId: targetChapter.book_id, chapterId: targetChapterId },
        { knownTargetChapter: targetChapter },
      );
      if (sourceNote.book_id !== moved.book_id || sourceNote.chapter_id !== moved.chapter_id) {
        logActivity('note.moved', {
          ...noteContext(sourceNote),
          destinationBookId: moved.book_id,
          ...(moved.chapter_id === null ? {} : { destinationChapterId: moved.chapter_id }),
        });
      }
      return moved;
    },
  };
}
