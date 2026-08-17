const ARTIFACT_COLUMNS = [
  'id',
  'project_id',
  'relative_path',
  'kind',
  'generated_by',
  'generated_mode',
  'generated_watermark_id',
  'sha256',
  'size_bytes',
  'created_at',
  'updated_at',
];

/**
 * Read access for non-asset files generated inside a project. Mutations are
 * intentionally performed by the owning operation's existing DB transaction.
 */
export function createGeneratedArtifactRepository(db) {
  const findByProjectAndPath = db.prepare(`
    SELECT ${ARTIFACT_COLUMNS.join(', ')}
    FROM generated_artifacts
    WHERE project_id = ? AND relative_path = ?
  `);
  const listByProject = db.prepare(`
    SELECT ${ARTIFACT_COLUMNS.join(', ')}
    FROM generated_artifacts
    WHERE project_id = ?
    ORDER BY relative_path COLLATE NOCASE ASC, id ASC
  `);

  return {
    findByProjectIdAndPath(projectId, relativePath) {
      return findByProjectAndPath.get(projectId, relativePath);
    },
    listByProjectId(projectId) {
      return listByProject.all(projectId);
    },
  };
}
