/**
 * Import-only association writes. Transaction ownership belongs to the Book
 * import cover persistence service; these primitives never open a transaction.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function createBookImportAssociationRepository(db) {
  const insertPageProjectStmt = db.prepare(`
    INSERT OR IGNORE INTO note_projects (note_id, project_id)
    VALUES (?, ?)
  `);
  const insertPageAssetStmt = db.prepare(`
    INSERT OR IGNORE INTO note_assets (note_id, asset_id)
    VALUES (?, ?)
  `);
  const updateRevisionAssociationsStmt = db.prepare(`
    UPDATE note_revisions
    SET project_ids_json = ?, asset_ids_json = ?
    WHERE id = ? AND note_id = ?
  `);

  return Object.freeze({
    insertPageProject(noteId, projectId) {
      return insertPageProjectStmt.run(noteId, projectId);
    },

    insertPageAsset(noteId, assetId) {
      return insertPageAssetStmt.run(noteId, assetId);
    },

    updateRevisionAssociations({ revisionId, noteId, projectIds, assetIds }) {
      return updateRevisionAssociationsStmt.run(
        JSON.stringify(projectIds),
        JSON.stringify(assetIds),
        revisionId,
        noteId,
      );
    },
  });
}
