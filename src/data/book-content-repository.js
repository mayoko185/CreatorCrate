const COLUMNS = ['book_id', 'item_type', 'item_id', 'sort_order'];
const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM book_contents`;
const ITEM_TYPES = new Set(['chapter', 'page']);

export class BookContentError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'BookContentError';
    this.code = code;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createBookContentRepository(db) {
  const listForBookStmt = db.prepare(
    `${SELECT_ALL} WHERE book_id = ? ORDER BY sort_order ASC`
  );
  const maxSortOrderStmt = db.prepare(
    'SELECT MAX(sort_order) AS max_order FROM book_contents WHERE book_id = ?'
  );
  const findMembershipStmt = db.prepare(`
    SELECT 1
    FROM book_contents
    WHERE book_id = ? AND item_type = ? AND item_id = ?
    LIMIT 1
  `);
  const insertStmt = db.prepare(`
    INSERT INTO book_contents (book_id, item_type, item_id, sort_order)
    VALUES (?, ?, ?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const deleteMembershipStmt = db.prepare(`
    DELETE FROM book_contents
    WHERE book_id = ? AND item_type = ? AND item_id = ?
  `);
  const shiftOrdersStmt = db.prepare(`
    UPDATE book_contents
    SET sort_order = sort_order + ?
    WHERE book_id = ?
  `);

  const appendTx = db.transaction((bookId, itemType, itemId) => {
    if (findMembershipStmt.get(bookId, itemType, itemId)) {
      throw new BookContentError(
        `Book ${bookId} already contains ${itemType} ${itemId}.`,
        { code: 'DUPLICATE_ITEM' }
      );
    }

    const { max_order: maxOrder } = maxSortOrderStmt.get(bookId);
    const sortOrder = maxOrder === null ? 0 : maxOrder + 1;
    return insertStmt.get(bookId, itemType, itemId, sortOrder);
  });

  const compactTx = db.transaction((bookId) => compactRows(bookId));

  const removeTx = db.transaction((bookId, itemType, itemId) => {
    const deleted = deleteMembershipStmt.run(bookId, itemType, itemId);
    if (deleted.changes === 0) return false;
    if (deleted.changes !== 1) {
      throw new BookContentError(
        `Removing ${itemType} ${itemId} from Book ${bookId} affected ${deleted.changes} rows.`,
        { code: 'DELETE_CHANGES_MISMATCH' }
      );
    }

    compactRows(bookId);
    return true;
  });

  const reorderTx = db.transaction((bookId, orderedItems) => {
    const current = listForBookStmt.all(bookId);
    const normalizedItems = validateExactOrder({ bookId, orderedItems, current });

    const changed = !current.every((row, index) => (
      row.item_type === normalizedItems[index].type && row.item_id === normalizedItems[index].id
    ));

    if (normalizedItems.length > 0) {
      rewriteOrders(bookId, current, normalizedItems);
    }

    const rows = listForBookStmt.all(bookId);
    Object.defineProperty(rows, 'changed', { value: changed });
    return rows;
  });

  function rewriteOrders(bookId, current, orderedItems) {
    const maxSortOrder = Math.max(...current.map((row) => row.sort_order));
    const temporaryOffset = maxSortOrder + current.length + 1;
    const shifted = shiftOrdersStmt.run(temporaryOffset, bookId);
    if (shifted.changes !== current.length) {
      throw new BookContentError(
        `Reorder preparation affected ${shifted.changes} rows, expected ${current.length}.`,
        { code: 'UPDATE_CHANGES_MISMATCH' }
      );
    }

    const whenClauses = orderedItems
      .map(() => 'WHEN item_type = ? AND item_id = ? THEN ?')
      .join(' ');
    const setFinalOrderStmt = db.prepare(`
      UPDATE book_contents
      SET sort_order = CASE ${whenClauses} ELSE sort_order END
      WHERE book_id = ?
    `);
    const finalOrderParams = [];
    for (let index = 0; index < orderedItems.length; index++) {
      finalOrderParams.push(orderedItems[index].type, orderedItems[index].id, index);
    }
    finalOrderParams.push(bookId);

    const finalized = setFinalOrderStmt.run(...finalOrderParams);
    if (finalized.changes !== current.length) {
      throw new BookContentError(
        `Reorder finalization affected ${finalized.changes} rows, expected ${current.length}.`,
        { code: 'UPDATE_CHANGES_MISMATCH' }
      );
    }
  }

  function compactRows(bookId) {
    const current = listForBookStmt.all(bookId);
    if (current.length === 0) return current;

    rewriteOrders(
      bookId,
      current,
      current.map((row) => ({ type: row.item_type, id: row.item_id }))
    );
    return listForBookStmt.all(bookId);
  }

  return {
    /** @returns {Array<{ book_id: number, item_type: string, item_id: number, sort_order: number }>} */
    listForBook(bookId) {
      assertId(bookId, 'Book');
      return listForBookStmt.all(bookId);
    },

    /** @returns {{ book_id: number, item_type: string, item_id: number, sort_order: number }} */
    append(bookId, itemType, itemId) {
      assertId(bookId, 'Book');
      assertItemType(itemType);
      assertId(itemId, 'item');
      return appendTx(bookId, itemType, itemId);
    },

    /** @returns {boolean} */
    remove(bookId, itemType, itemId) {
      assertId(bookId, 'Book');
      assertItemType(itemType);
      assertId(itemId, 'item');
      return removeTx(bookId, itemType, itemId);
    },

    /** @returns {Array<{ book_id: number, item_type: string, item_id: number, sort_order: number }>} */
    compact(bookId) {
      assertId(bookId, 'Book');
      return compactTx(bookId);
    },

    /**
     * `orderedItems` must be an exact permutation of the typed items in
     * `bookId`. Returns the reordered Book-content rows.
     */
    reorder(bookId, orderedItems) {
      assertId(bookId, 'Book');
      return reorderTx(bookId, orderedItems);
    },
  };
}

function validateExactOrder({ bookId, orderedItems, current }) {
  if (!Array.isArray(orderedItems)) {
    throw new BookContentError('Book-content reorder input must be an array.', {
      code: 'INVALID_INPUT',
    });
  }

  if (orderedItems.length !== current.length) {
    throw new BookContentError(
      `Reorder sequence length ${orderedItems.length} does not match current Book-content count ${current.length}.`,
      { code: 'INVALID_SEQUENCE_LENGTH' }
    );
  }

  const seen = new Set();
  const normalizedItems = [];
  for (const item of orderedItems) {
    assertPlainObject(item);
    const type = assertItemType(item.type);
    const id = assertId(item.id, 'item');
    const key = itemKey(type, id);

    if (seen.has(key)) {
      throw new BookContentError(`Duplicate ${type} ${id} in Book ${bookId}.`, {
        code: 'DUPLICATE_ITEM',
      });
    }
    seen.add(key);
    normalizedItems.push({ type, id });
  }

  const currentItems = new Set(current.map((row) => itemKey(row.item_type, row.item_id)));
  for (const { type, id } of normalizedItems) {
    if (!currentItems.has(itemKey(type, id))) {
      throw new BookContentError(`Book ${bookId} does not contain ${type} ${id}.`, {
        code: 'UNKNOWN_ITEM',
      });
    }
  }

  return normalizedItems;
}

function assertPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BookContentError('Each reordered item must be an object.', {
      code: 'INVALID_INPUT',
    });
  }
}

function assertId(value, entityName) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BookContentError(`Invalid ${entityName.toLowerCase()} ID: ${value}.`, {
      code: 'INVALID_ID',
    });
  }
  return value;
}

function assertItemType(value) {
  if (!ITEM_TYPES.has(value)) {
    throw new BookContentError(`Invalid item type: ${value}.`, {
      code: 'INVALID_ITEM_TYPE',
    });
  }
  return value;
}

function itemKey(type, id) {
  return `${type}:${id}`;
}
