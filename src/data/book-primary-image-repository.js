/**
 * Book primary-image repository — SQL operations for retained book selections.
 * Validation and image policy belong to higher layers, not this repository.
 */

const REFERENCE_COLUMNS = ['book_id', 'asset_id'];
const SELECT_REFERENCES = `SELECT ${REFERENCE_COLUMNS.join(', ')} FROM book_primary_images`;

/**
 * Create a book primary-image repository bound to an existing database handle.
 * Methods intentionally do not create transactions so callers can compose them
 * inside a larger transaction.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function createBookPrimaryImageRepository(db) {
  const findByBookStmt = db.prepare(`${SELECT_REFERENCES} WHERE book_id = ?`);
  const findByAssetStmt = db.prepare(`${SELECT_REFERENCES}
    WHERE asset_id = ?
    ORDER BY book_id ASC`);
  const upsertStmt = db.prepare(`
    INSERT INTO book_primary_images (book_id, asset_id)
    VALUES (?, ?)
    ON CONFLICT(book_id) DO UPDATE SET
      asset_id = excluded.asset_id
    RETURNING ${REFERENCE_COLUMNS.join(', ')}
  `);
  const clearIfMatchesStmt = db.prepare(`
    DELETE FROM book_primary_images
    WHERE book_id = ? AND asset_id = ?
  `);

  return {
    /**
     * Find a book's retained primary-image reference.
     * @param {number} bookId
     * @returns {{book_id: number, asset_id: number}|undefined}
     */
    findByBookId(bookId) {
      return findByBookStmt.get(bookId);
    },

    /**
     * Find retained references for several books in one query.
     * @param {number[]} bookIds
     * @returns {Array<{book_id: number, asset_id: number}>}
     */
    findByBookIds(bookIds) {
      if (!Array.isArray(bookIds) || bookIds.length === 0) return [];

      const uniqueBookIds = [...new Set(bookIds)];
      const placeholders = uniqueBookIds.map(() => '?').join(', ');
      return db.prepare(`${SELECT_REFERENCES}
        WHERE book_id IN (${placeholders})
        ORDER BY book_id ASC`).all(...uniqueBookIds);
    },

    /**
     * Find every retained book reference to an asset.
     * @param {number} assetId
     * @returns {Array<{book_id: number, asset_id: number}>}
     */
    findByAssetId(assetId) {
      return findByAssetStmt.all(assetId);
    },

    /**
     * Set or replace the one selected reference for a book.
     * @param {number} bookId
     * @param {number} assetId
     * @returns {{book_id: number, asset_id: number}}
     */
    setPrimaryImage(bookId, assetId) {
      return upsertStmt.get(bookId, assetId);
    },

    /**
     * Set or replace a selection and report whether its effective value changed.
     * The caller must compose this operation in its authoritative transaction.
     * @param {number} bookId
     * @param {number} assetId
     * @returns {{selection: {book_id: number, asset_id: number}, changed: boolean}}
     */
    setPrimaryImageWithOutcome(bookId, assetId) {
      const previous = findByBookStmt.get(bookId);
      const selection = upsertStmt.get(bookId, assetId);
      return {
        selection,
        changed: previous?.asset_id !== selection?.asset_id,
      };
    },

    /**
     * Remove a selection only when it still points at the expected asset.
     * @param {number} bookId
     * @param {number} expectedAssetId
     * @returns {boolean} whether a matching row was removed
     */
    clearPrimaryImageIfMatches(bookId, expectedAssetId) {
      return clearIfMatchesStmt.run(bookId, expectedAssetId).changes === 1;
    },
  };
}
