const WATERMARK_COLUMNS = [
  'id',
  'display_name',
  'storage_key',
  'sha256',
  'width',
  'height',
  'created_at',
  'updated_at',
];

/**
 * Database access for app-owned Watermark resources. File mutations belong to
 * the Watermark service so registry writes never accept caller filesystem paths.
 */
export function createWatermarkRepository(db) {
  const findByIdStmt = db.prepare(`SELECT ${WATERMARK_COLUMNS.join(', ')} FROM watermarks WHERE id = ?`);
  const listStmt = db.prepare(`
    SELECT ${WATERMARK_COLUMNS.join(', ')}
    FROM watermarks
    ORDER BY display_name COLLATE NOCASE ASC, id ASC
  `);
  const insertStmt = db.prepare(`
    INSERT INTO watermarks (display_name, storage_key, sha256, width, height)
    VALUES (?, ?, ?, ?, ?)
    RETURNING ${WATERMARK_COLUMNS.join(', ')}
  `);
  const renameStmt = db.prepare(`
    UPDATE watermarks
    SET display_name = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${WATERMARK_COLUMNS.join(', ')}
  `);
  const replaceStmt = db.prepare(`
    UPDATE watermarks
    SET sha256 = ?, width = ?, height = ?, updated_at = datetime('now')
    WHERE id = ? AND sha256 = ?
    RETURNING ${WATERMARK_COLUMNS.join(', ')}
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM watermarks
    WHERE id = ? AND storage_key = ? AND sha256 = ?
    RETURNING ${WATERMARK_COLUMNS.join(', ')}
  `);

  return {
    findById(id) { return findByIdStmt.get(id); },
    list() { return listStmt.all(); },
    create({ displayName, storageKey, sha256, width, height }) {
      return insertStmt.get(displayName, storageKey, sha256, width, height);
    },
    rename(id, displayName) { return renameStmt.get(displayName, id); },
    replaceImage(id, expectedSha256, { sha256, width, height }) {
      return replaceStmt.get(sha256, width, height, id, expectedSha256);
    },
    delete(id, expected) {
      return deleteStmt.get(id, expected.storage_key, expected.sha256);
    },
  };
}
