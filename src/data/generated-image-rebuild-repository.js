export const GENERATED_IMAGE_REBUILD_KEY = 'images.project_rebuild.v1';

export class InvalidGeneratedImageRebuildRecordError extends Error {
  constructor() {
    super('Invalid generated-image rebuild record.');
  }
}

const ELIGIBLE = `a.is_present = 1 AND p.project_dir IS NOT NULL AND p.project_dir <> ''
  AND (LOWER(a.extension) = 'png' AND LOWER(a.mime_type) = 'image/png'
    OR LOWER(a.extension) IN ('jpg', 'jpeg') AND LOWER(a.mime_type) = 'image/jpeg'
    OR LOWER(a.extension) = 'webp' AND LOWER(a.mime_type) = 'image/webp'
    OR LOWER(a.extension) = 'gif' AND LOWER(a.mime_type) = 'image/gif'
    OR LOWER(a.extension) IN ('kra', 'krz') AND LOWER(a.mime_type) = 'application/x-krita')`;

export function createGeneratedImageRebuildRepository(db, appMetaRepository) {
  const bounds = db.prepare(`SELECT COUNT(*) AS total, COALESCE(MAX(a.id), 0) AS upperBound
    FROM assets a JOIN projects p ON p.id = a.project_id WHERE ${ELIGIBLE}`);
  const page = db.prepare(`SELECT a.id, a.project_id, a.extension, a.source_animated, a.is_present,
      a.relative_path, a.size_bytes, a.modified_at
    FROM assets a JOIN projects p ON p.id = a.project_id
    WHERE ${ELIGIBLE} AND a.id > ? AND a.id <= ?
    ORDER BY a.id ASC LIMIT ?`);
  return {
    get() {
      const raw = appMetaRepository.getValue(GENERATED_IMAGE_REBUILD_KEY);
      if (raw === undefined) return null;
      let record;
      try { record = JSON.parse(raw); } catch { throw new InvalidGeneratedImageRebuildRecordError(); }
      if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1) {
        throw new InvalidGeneratedImageRebuildRecordError();
      }
      return record;
    },
    save(record) { appMetaRepository.setValue(GENERATED_IMAGE_REBUILD_KEY, JSON.stringify(record)); },
    bounds: () => bounds.get(),
    page: (cursor, upperBound, limit = 32) => page.all(cursor, upperBound, limit),
  };
}
