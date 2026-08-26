const COLUMNS = ['id', 'title', 'sort_order', 'created_at', 'updated_at'];
const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM books`;

export class BookError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'BookError';
    this.code = code;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createBookRepository(db) {
  const findByIdStmt = db.prepare(`${SELECT_ALL} WHERE id = ?`);
  const listStmt = db.prepare(`${SELECT_ALL} ORDER BY sort_order ASC, id ASC`);
  const maxSortOrderStmt = db.prepare('SELECT MAX(sort_order) AS max_order FROM books');
  const insertStmt = db.prepare(`
    INSERT INTO books (title, sort_order)
    VALUES (?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const updateTitleStmt = db.prepare(`
    UPDATE books
    SET title = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${COLUMNS.join(', ')}
  `);
  const shiftOrdersStmt = db.prepare('UPDATE books SET sort_order = sort_order + ?');
  const deleteByIdStmt = db.prepare('DELETE FROM books WHERE id = ?');
  const hasChaptersStmt = db.prepare('SELECT 1 FROM chapters WHERE book_id = ? LIMIT 1');
  const setSortOrderStmt = db.prepare('UPDATE books SET sort_order = ? WHERE id = ?');

  const reorderTx = db.transaction((orderedIds) => {
    const current = listStmt.all();
    const currentIds = current.map((row) => row.id);

    validateExactOrder({
      orderedIds,
      currentIds,
      entityName: 'Book',
      ErrorType: BookError,
    });

    const changed = !currentIds.every((id, index) => id === orderedIds[index]);

    if (orderedIds.length > 0) {
      const maxSortOrder = Math.max(...current.map((row) => row.sort_order));
      const temporaryOffset = maxSortOrder + current.length + 1;
      const shifted = shiftOrdersStmt.run(temporaryOffset);
      if (shifted.changes !== current.length) {
        throw new BookError(
          `Reorder preparation affected ${shifted.changes} rows, expected ${current.length}.`,
          { code: 'UPDATE_CHANGES_MISMATCH' }
        );
      }

      const whenClauses = orderedIds.map(() => 'WHEN ? THEN ?').join(' ');
      const idPlaceholders = orderedIds.map(() => '?').join(', ');
      const setFinalOrderStmt = db.prepare(`
        UPDATE books
        SET sort_order = CASE id ${whenClauses} ELSE sort_order END
        WHERE id IN (${idPlaceholders})
      `);
      const finalOrderParams = [];
      for (let index = 0; index < orderedIds.length; index++) {
        finalOrderParams.push(orderedIds[index], index);
      }
      finalOrderParams.push(...orderedIds);

      const finalized = setFinalOrderStmt.run(...finalOrderParams);
      if (finalized.changes !== current.length) {
        throw new BookError(
          `Reorder finalization affected ${finalized.changes} rows, expected ${current.length}.`,
          { code: 'UPDATE_CHANGES_MISMATCH' }
        );
      }
    }

    const rows = listStmt.all();
    Object.defineProperty(rows, 'changed', { value: changed });
    return rows;
  });

  const deleteAndCompactTx = db.transaction((id) => {
    if (!findByIdStmt.get(id)) return false;

    if (hasChaptersStmt.get(id)) {
      throw new BookError(`Book ${id} cannot be deleted while it contains chapters.`, {
        code: 'NOT_EMPTY',
      });
    }

    const deleted = deleteByIdStmt.run(id);
    if (deleted.changes !== 1) {
      throw new BookError(`Book ${id} could not be deleted.`, { code: 'DELETE_CHANGES_MISMATCH' });
    }

    const remaining = listStmt.all();
    for (let index = 0; index < remaining.length; index++) {
      if (remaining[index].sort_order !== index) {
        setSortOrderStmt.run(index, remaining[index].id);
      }
    }

    return true;
  });

  return {
    /** @returns {Array<{ id: number, title: string, sort_order: number, created_at: string, updated_at: string }>} */
    list() {
      return listStmt.all();
    },

    /** @returns {{ id: number, title: string, sort_order: number, created_at: string, updated_at: string }|undefined} */
    findById(id) {
      return findByIdStmt.get(id);
    },

    /** @returns {{ id: number, title: string, sort_order: number, created_at: string, updated_at: string }} */
    create({ title }) {
      const { max_order: maxOrder } = maxSortOrderStmt.get();
      const sortOrder = maxOrder === null ? 0 : maxOrder + 1;
      return insertStmt.get(title, sortOrder);
    },

    /** @returns {{ id: number, title: string, sort_order: number, created_at: string, updated_at: string }|undefined} */
    update(id, { title }) {
      return updateTitleStmt.get(title, id);
    },

    /**
     * `orderedIds` must be an exact permutation of all current Book IDs.
     * Returns the reordered Book rows. Throws BookError with one of
     * INVALID_INPUT, INVALID_SEQUENCE_LENGTH, INVALID_ID, DUPLICATE_ID,
     * UNKNOWN_ID, or UPDATE_CHANGES_MISMATCH when the reorder cannot complete.
     */
    reorder(orderedIds) {
      return reorderTx(orderedIds);
    },

    /**
     * Returns true when an empty Book was deleted and false when it was missing.
     * Throws BookError with code NOT_EMPTY when it still has Chapters, or
     * DELETE_CHANGES_MISMATCH if the deletion unexpectedly affects no row.
     */
    deleteAndCompact(id) {
      return deleteAndCompactTx(id);
    },
  };
}

function validateExactOrder({ orderedIds, currentIds, entityName, ErrorType }) {
  if (!Array.isArray(orderedIds)) {
    throw new ErrorType(`${entityName} reorder input must be an array.`, { code: 'INVALID_INPUT' });
  }

  if (orderedIds.length !== currentIds.length) {
    throw new ErrorType(
      `Reorder sequence length ${orderedIds.length} does not match current ${entityName.toLowerCase()} count ${currentIds.length}.`,
      { code: 'INVALID_SEQUENCE_LENGTH' }
    );
  }

  const seen = new Set();
  for (const id of orderedIds) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ErrorType(`Invalid ${entityName.toLowerCase()} ID: ${id}.`, { code: 'INVALID_ID' });
    }
    if (seen.has(id)) {
      throw new ErrorType(`Duplicate ${entityName.toLowerCase()} ID: ${id}.`, { code: 'DUPLICATE_ID' });
    }
    seen.add(id);
  }

  const currentSet = new Set(currentIds);
  for (const id of orderedIds) {
    if (!currentSet.has(id)) {
      throw new ErrorType(`${entityName} ID ${id} does not exist.`, { code: 'UNKNOWN_ID' });
    }
  }
}
