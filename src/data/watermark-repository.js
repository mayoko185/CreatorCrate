const WATERMARK_COLUMNS = [
  'id',
  'display_name',
  'storage_key',
  'sha256',
  'width',
  'height',
  'created_at',
  'updated_at',
  'source_relative_path',
  'source_present',
  'source_last_seen_at',
  'source_missing_at',
];

/**
 * Database access for the shared global Watermark registry. Source paths are
 * stored as relative reconciliation keys; filesystem bytes remain outside the
 * database and are never accepted from HTTP callers.
 */
export function createWatermarkRepository(db) {
  const findByIdStmt = db.prepare(`SELECT ${WATERMARK_COLUMNS.join(', ')} FROM watermarks WHERE id = ?`);
  const listStmt = db.prepare(`
    SELECT ${WATERMARK_COLUMNS.join(', ')}
    FROM watermarks
    ORDER BY display_name COLLATE NOCASE ASC, id ASC
  `);
  const listSourceStmt = db.prepare(`
    SELECT ${WATERMARK_COLUMNS.join(', ')}
    FROM watermarks
    WHERE source_relative_path IS NOT NULL
    ORDER BY source_relative_path COLLATE NOCASE ASC, id ASC
  `);
  const findBySourcePathStmt = db.prepare(`
    SELECT ${WATERMARK_COLUMNS.join(', ')}
    FROM watermarks
    WHERE source_relative_path = ?
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
  const insertSourceStmt = db.prepare(`
    INSERT INTO watermarks (
      display_name,
      storage_key,
      sha256,
      width,
      height,
      source_relative_path,
      source_present,
      source_last_seen_at,
      source_missing_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)
    RETURNING ${WATERMARK_COLUMNS.join(', ')}
  `);
  const updateSourceStmt = db.prepare(`
    UPDATE watermarks
    SET sha256 = ?, width = ?, height = ?, source_present = 1,
        source_last_seen_at = ?, source_missing_at = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND source_relative_path = ?
    RETURNING ${WATERMARK_COLUMNS.join(', ')}
  `);
  const markSourceMissingStmt = db.prepare(`
    UPDATE watermarks
    SET source_present = 0,
        source_missing_at = COALESCE(source_missing_at, ?),
        updated_at = datetime('now')
    WHERE id = ? AND source_present = 1
    RETURNING ${WATERMARK_COLUMNS.join(', ')}
  `);

  return {
    findById(id) { return findByIdStmt.get(id); },
    list() { return listStmt.all(); },
    listSourceRecords() { return listSourceStmt.all(); },
    findBySourcePath(relativePath) { return findBySourcePathStmt.get(relativePath); },
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
    reconcileSources(sources, seenAt, { retainedSourcePaths = [] } = {}) {
      const reconcile = db.transaction(() => {
        const existing = listSourceStmt.all();
        const byPath = new Map(existing.map((record) => [record.source_relative_path, record]));
        const seen = new Set(retainedSourcePaths);
        const summary = { added: 0, updated: 0, restored: 0, removed: 0, total: 0 };

        for (const source of sources) {
          const current = byPath.get(source.relativePath);
          if (!current) {
            insertSourceStmt.get(
              source.displayName,
              source.storageKey,
              source.sha256,
              source.width,
              source.height,
              source.relativePath,
              seenAt,
            );
            summary.added += 1;
          } else {
            if (current.source_present === 0) summary.restored += 1;
            else if (current.sha256 !== source.sha256
              || current.width !== source.width
              || current.height !== source.height) summary.updated += 1;

            updateSourceStmt.get(
              source.sha256,
              source.width,
              source.height,
              seenAt,
              current.id,
              source.relativePath,
            );
          }
          seen.add(source.relativePath);
          summary.total += 1;
        }

        for (const current of existing) {
          if (current.source_present === 1 && !seen.has(current.source_relative_path)) {
            markSourceMissingStmt.get(seenAt, current.id);
            summary.removed += 1;
          }
        }

        return summary;
      });

      return reconcile();
    },
  };
}
