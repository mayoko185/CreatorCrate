const SCALE_MAP_COLUMNS = [
  'id',
  'display_name',
  'system_key',
  'definition_json',
  'created_at',
  'updated_at',
];

/**
 * Database access for app-owned Watermark scale-map definitions. Validation
 * and JSON interpretation belong to the service, never to request callers.
 */
export function createWatermarkScaleMapRepository(db) {
  const findByIdStmt = db.prepare(`SELECT ${SCALE_MAP_COLUMNS.join(', ')} FROM watermark_scale_maps WHERE id = ?`);
  const listStmt = db.prepare(`
    SELECT ${SCALE_MAP_COLUMNS.join(', ')}
    FROM watermark_scale_maps
    ORDER BY display_name COLLATE NOCASE ASC, id ASC
  `);
  const insertStmt = db.prepare(`
    INSERT INTO watermark_scale_maps (display_name, definition_json)
    VALUES (?, ?)
    RETURNING ${SCALE_MAP_COLUMNS.join(', ')}
  `);
  const renameStmt = db.prepare(`
    UPDATE watermark_scale_maps
    SET display_name = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${SCALE_MAP_COLUMNS.join(', ')}
  `);
  const replaceStmt = db.prepare(`
    UPDATE watermark_scale_maps
    SET definition_json = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${SCALE_MAP_COLUMNS.join(', ')}
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM watermark_scale_maps
    WHERE id = ?
    RETURNING ${SCALE_MAP_COLUMNS.join(', ')}
  `);

  return {
    findById(id) { return findByIdStmt.get(id); },
    list() { return listStmt.all(); },
    create({ displayName, definitionJson }) { return insertStmt.get(displayName, definitionJson); },
    rename(id, displayName) { return renameStmt.get(displayName, id); },
    replaceDefinition(id, definitionJson) { return replaceStmt.get(definitionJson, id); },
    delete(id) { return deleteStmt.get(id); },
  };
}
