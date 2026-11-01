/**
 * Persistence for Page deletion Undo opportunities. Callers own the surrounding
 * transaction. The raw snapshot is only available through `findSnapshotJson`
 * and must never reach a controller or view model.
 */

const RECEIPT_COLUMNS = [
  'id', 'owner_key', 'note_id', 'book_id', 'chapter_id',
  'created_at', 'expires_at', 'restored_at', 'snapshot_version',
];

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createNoteDeletionSnapshotRepository(db) {
  const insertStmt = db.prepare(`
    INSERT INTO note_deletion_snapshots (
      id, owner_key, note_id, book_id, chapter_id,
      created_at, expires_at, snapshot_version, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findReceiptStmt = db.prepare(`
    SELECT ${RECEIPT_COLUMNS.join(', ')}
    FROM note_deletion_snapshots
    WHERE id = ?
  `);
  // Reads one field inside SQLite, so the payload itself never reaches the caller.
  const ACTIVE_FOR_OWNER_SELECT = `
    SELECT id, note_id, book_id, chapter_id, created_at, expires_at, snapshot_version,
      json_extract(snapshot_json, '$.graph.note.title') AS title
    FROM note_deletion_snapshots
    WHERE owner_key = ? AND restored_at IS NULL AND snapshot_json IS NOT NULL AND expires_at > ?
  `;
  const NEWEST_FIRST = 'ORDER BY created_at DESC, rowid DESC LIMIT ?';
  const listActiveForChapterStmt = db.prepare(
    `${ACTIVE_FOR_OWNER_SELECT} AND chapter_id = ? ${NEWEST_FIRST}`
  );
  const listActiveForBookStmt = db.prepare(
    `${ACTIVE_FOR_OWNER_SELECT} AND book_id = ? AND chapter_id IS NULL ${NEWEST_FIRST}`
  );
  const findSnapshotJsonStmt = db.prepare(
    'SELECT snapshot_json FROM note_deletion_snapshots WHERE id = ?'
  ).pluck();
  const markRestoredStmt = db.prepare(`
    UPDATE note_deletion_snapshots
    SET restored_at = ?, snapshot_json = NULL
    WHERE id = ? AND restored_at IS NULL AND snapshot_json IS NOT NULL
  `);
  const clearExpiredSnapshotsStmt = db.prepare(`
    UPDATE note_deletion_snapshots
    SET snapshot_json = NULL
    WHERE expires_at <= ? AND snapshot_json IS NOT NULL
  `);
  const deleteOldReceiptsStmt = db.prepare(
    'DELETE FROM note_deletion_snapshots WHERE expires_at <= ?'
  );

  return {
    insert({
      id, ownerKey, noteId, bookId, chapterId, createdAt, expiresAt, snapshotVersion, snapshotJson,
    }) {
      insertStmt.run(
        id, ownerKey, noteId, bookId, chapterId, createdAt, expiresAt, snapshotVersion, snapshotJson,
      );
    },

    /** The row without its payload. */
    findReceipt(id) {
      return findReceiptStmt.get(id);
    },

    /**
     * Active opportunities of one owner directly inside a Chapter or, with
     * chapterId null, directly inside a Book. Newest first; metadata only.
     */
    listActiveForOwnerInParent(ownerKey, { bookId, chapterId }, current, limit) {
      return chapterId === null
        ? listActiveForBookStmt.all(ownerKey, current, bookId, limit)
        : listActiveForChapterStmt.all(ownerKey, current, chapterId, limit);
    },

    /** @returns {string|null|undefined} */
    findSnapshotJson(id) {
      return findSnapshotJsonStmt.get(id);
    },

    /**
     * Consume an active opportunity and clear its payload.
     *
     * @returns {boolean} true only for the single call that consumed it
     */
    markRestored(id, restoredAt) {
      return markRestoredStmt.run(restoredAt, id).changes === 1;
    },

    /** @returns {number} payloads cleared from rows expired at `now` */
    clearExpiredSnapshots(now) {
      return clearExpiredSnapshotsStmt.run(now).changes;
    },

    /** @returns {number} receipts removed whose expiry is at or before `cutoff` */
    deleteReceiptsExpiredBy(cutoff) {
      return deleteOldReceiptsStmt.run(cutoff).changes;
    },
  };
}

/**
 * Remove every Undo opportunity from a staged backup restore. Backups carry the
 * snapshots live when they were taken, and the signing secret lives outside the
 * database, so without this a restored file would resurrect old opportunities.
 * The staged file has already been migrated, so backups older than the table
 * arrive here with it present and empty. Never call this on an ordinary open.
 */
export function invalidateNoteDeletionSnapshotsForRestore(db) {
  return db.prepare('DELETE FROM note_deletion_snapshots').run().changes;
}
