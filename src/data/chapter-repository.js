const COLUMNS = ['id', 'book_id', 'title', 'sort_order', 'created_at', 'updated_at'];
const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM chapters`;

export class ChapterError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ChapterError';
    this.code = code;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createChapterRepository(db) {
  const findByIdStmt = db.prepare(`${SELECT_ALL} WHERE id = ?`);
  const listForBookStmt = db.prepare(`${SELECT_ALL} WHERE book_id = ? ORDER BY sort_order ASC, id ASC`);
  const maxSortOrderStmt = db.prepare(
    'SELECT MAX(sort_order) AS max_order FROM chapters WHERE book_id = ?'
  );
  const insertStmt = db.prepare(`
    INSERT INTO chapters (book_id, title, sort_order)
    VALUES (?, ?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const updateTitleStmt = db.prepare(`
    UPDATE chapters
    SET title = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${COLUMNS.join(', ')}
  `);
  const shiftOrdersStmt = db.prepare(`
    UPDATE chapters
    SET sort_order = sort_order + ?
    WHERE book_id = ?
  `);
  const deleteByIdStmt = db.prepare('DELETE FROM chapters WHERE id = ?');
  const hasNotesStmt = db.prepare('SELECT 1 FROM notes WHERE chapter_id = ? LIMIT 1');
  const setSortOrderStmt = db.prepare('UPDATE chapters SET sort_order = ? WHERE id = ?');

  const reorderTx = db.transaction((bookId, orderedIds) => {
    const current = listForBookStmt.all(bookId);
    const currentIds = current.map((row) => row.id);

    validateExactOrder({ bookId, orderedIds, currentIds });

    if (orderedIds.length > 0) {
      const maxSortOrder = Math.max(...current.map((row) => row.sort_order));
      const temporaryOffset = maxSortOrder + current.length + 1;
      const shifted = shiftOrdersStmt.run(temporaryOffset, bookId);
      if (shifted.changes !== current.length) {
        throw new ChapterError(
          `Reorder preparation affected ${shifted.changes} rows, expected ${current.length}.`,
          { code: 'UPDATE_CHANGES_MISMATCH' }
        );
      }

      const whenClauses = orderedIds.map(() => 'WHEN ? THEN ?').join(' ');
      const setFinalOrderStmt = db.prepare(`
        UPDATE chapters
        SET sort_order = CASE id ${whenClauses} ELSE sort_order END
        WHERE book_id = ?
      `);
      const finalOrderParams = [];
      for (let index = 0; index < orderedIds.length; index++) {
        finalOrderParams.push(orderedIds[index], index);
      }
      finalOrderParams.push(bookId);

      const finalized = setFinalOrderStmt.run(...finalOrderParams);
      if (finalized.changes !== current.length) {
        throw new ChapterError(
          `Reorder finalization affected ${finalized.changes} rows, expected ${current.length}.`,
          { code: 'UPDATE_CHANGES_MISMATCH' }
        );
      }
    }

    return listForBookStmt.all(bookId);
  });

  const deleteAndCompactTx = db.transaction((id) => {
    const chapter = findByIdStmt.get(id);
    if (!chapter) return false;

    if (hasNotesStmt.get(id)) {
      throw new ChapterError(`Chapter ${id} cannot be deleted while it contains Notes.`, {
        code: 'NOT_EMPTY',
      });
    }

    const deleted = deleteByIdStmt.run(id);
    if (deleted.changes !== 1) {
      throw new ChapterError(`Chapter ${id} could not be deleted.`, { code: 'DELETE_CHANGES_MISMATCH' });
    }

    const remaining = listForBookStmt.all(chapter.book_id);
    for (let index = 0; index < remaining.length; index++) {
      if (remaining[index].sort_order !== index) {
        setSortOrderStmt.run(index, remaining[index].id);
      }
    }

    return true;
  });

  return {
    /** @returns {Array<{ id: number, book_id: number, title: string, sort_order: number, created_at: string, updated_at: string }>} */
    listForBook(bookId) {
      return listForBookStmt.all(bookId);
    },

    /** @returns {{ id: number, book_id: number, title: string, sort_order: number, created_at: string, updated_at: string }|undefined} */
    findById(id) {
      return findByIdStmt.get(id);
    },

    /** @returns {{ id: number, book_id: number, title: string, sort_order: number, created_at: string, updated_at: string }} */
    create({ bookId, title }) {
      const { max_order: maxOrder } = maxSortOrderStmt.get(bookId);
      const sortOrder = maxOrder === null ? 0 : maxOrder + 1;
      return insertStmt.get(bookId, title, sortOrder);
    },

    /** @returns {{ id: number, book_id: number, title: string, sort_order: number, created_at: string, updated_at: string }|undefined} */
    update(id, { title }) {
      return updateTitleStmt.get(title, id);
    },

    /**
     * `orderedIds` must be an exact permutation of the Chapters in `bookId`.
     * Returns the reordered Chapter rows. Throws ChapterError with one of
     * INVALID_INPUT, INVALID_SEQUENCE_LENGTH, INVALID_ID, DUPLICATE_ID,
     * UNKNOWN_ID, or UPDATE_CHANGES_MISMATCH when the reorder cannot complete.
     */
    reorder(bookId, orderedIds) {
      return reorderTx(bookId, orderedIds);
    },

    /**
     * Returns true when an empty Chapter was deleted and false when it was missing.
     * Throws ChapterError with code NOT_EMPTY when it still has Notes, or
     * DELETE_CHANGES_MISMATCH if the deletion unexpectedly affects no row.
     */
    deleteAndCompact(id) {
      return deleteAndCompactTx(id);
    },
  };
}

function validateExactOrder({ bookId, orderedIds, currentIds }) {
  if (!Array.isArray(orderedIds)) {
    throw new ChapterError('Chapter reorder input must be an array.', { code: 'INVALID_INPUT' });
  }

  if (orderedIds.length !== currentIds.length) {
    throw new ChapterError(
      `Reorder sequence length ${orderedIds.length} does not match current chapter count ${currentIds.length}.`,
      { code: 'INVALID_SEQUENCE_LENGTH' }
    );
  }

  const seen = new Set();
  for (const id of orderedIds) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ChapterError(`Invalid chapter ID: ${id}.`, { code: 'INVALID_ID' });
    }
    if (seen.has(id)) {
      throw new ChapterError(`Duplicate chapter ID: ${id}.`, { code: 'DUPLICATE_ID' });
    }
    seen.add(id);
  }

  const currentSet = new Set(currentIds);
  for (const id of orderedIds) {
    if (!currentSet.has(id)) {
      throw new ChapterError(
        `Chapter ID ${id} does not exist for Book ${bookId}.`,
        { code: 'UNKNOWN_ID' }
      );
    }
  }
}
