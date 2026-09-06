/**
 * Book primary-image repository — SQL operations for retained book selections.
 * Validation and image policy belong to higher layers, not this repository.
 *
 * @typedef {object} BookPrimaryImageSelection
 * @property {number} book_id
 * @property {number|null} asset_id Project-only compatibility field.
 * @property {string|null} managed_asset_id
 * @property {{kind: 'project_asset', id: number}|{kind: 'managed_asset', id: string}} source
 */

const REFERENCE_COLUMNS = ['book_id', 'asset_id', 'managed_asset_id'];
const SELECT_REFERENCES = `SELECT ${REFERENCE_COLUMNS.join(', ')} FROM book_primary_images`;

function withSource(row) {
  if (!row) return undefined;
  return { ...row, source: row.asset_id !== null
    ? { kind: 'project_asset', id: row.asset_id }
    : { kind: 'managed_asset', id: row.managed_asset_id } };
}

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
    INSERT INTO book_primary_images (book_id, asset_id, managed_asset_id)
    VALUES (?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET
      asset_id = excluded.asset_id,
      managed_asset_id = excluded.managed_asset_id
    RETURNING ${REFERENCE_COLUMNS.join(', ')}
  `);
  const clearIfMatchesStmt = db.prepare(`
    DELETE FROM book_primary_images
    WHERE book_id = ? AND asset_id = ?
  `);
  const clearManagedIfMatchesStmt = db.prepare(`
    DELETE FROM book_primary_images WHERE book_id = ? AND managed_asset_id = ?
  `);

  return {
    /**
     * Find a book's retained primary-image reference.
     * @param {number} bookId
     * @returns {BookPrimaryImageSelection|undefined}
     */
    findByBookId(bookId) {
      return withSource(findByBookStmt.get(bookId));
    },

    /**
     * Find retained references for several books in one query.
     * @param {number[]} bookIds
     * @returns {BookPrimaryImageSelection[]}
     */
    findByBookIds(bookIds) {
      if (!Array.isArray(bookIds) || bookIds.length === 0) return [];

      const uniqueBookIds = [...new Set(bookIds)];
      const placeholders = uniqueBookIds.map(() => '?').join(', ');
      return db.prepare(`${SELECT_REFERENCES}
        WHERE book_id IN (${placeholders})
        ORDER BY book_id ASC`).all(...uniqueBookIds).map(withSource);
    },

    /**
     * Find every retained book reference to an asset.
     * @param {number} assetId
     * @returns {BookPrimaryImageSelection[]}
     */
    findByAssetId(assetId) {
      return findByAssetStmt.all(assetId).map(withSource);
    },

    /**
     * Set or replace the one selected reference for a book.
     * @param {number} bookId
     * @param {number} assetId
     * @returns {BookPrimaryImageSelection}
     */
    setPrimaryImage(bookId, assetId) {
      return withSource(upsertStmt.get(bookId, assetId, null));
    },

    /**
     * Set or replace a selection and report whether its effective value changed.
     * The caller must compose this operation in its authoritative transaction.
     * @param {number} bookId
     * @param {number} assetId
     * @returns {{selection: BookPrimaryImageSelection, changed: boolean}}
     */
    setPrimaryImageWithOutcome(bookId, assetId) {
      const previous = findByBookStmt.get(bookId);
      const selection = withSource(upsertStmt.get(bookId, assetId, null));
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

    setManagedPrimaryImageWithOutcome(bookId, managedAssetId) {
      const previous = findByBookStmt.get(bookId);
      const selection = withSource(upsertStmt.get(bookId, null, managedAssetId));
      return { selection, changed: previous?.managed_asset_id !== managedAssetId };
    },

    clearPrimaryImageSourceIfMatches(bookId, source) {
      if (source?.kind === 'project_asset') {
        return clearIfMatchesStmt.run(bookId, source.id).changes === 1;
      }
      if (source?.kind === 'managed_asset') {
        return clearManagedIfMatchesStmt.run(bookId, source.id).changes === 1;
      }
      throw new TypeError('Expected an explicit primary-image source.');
    },
  };
}
