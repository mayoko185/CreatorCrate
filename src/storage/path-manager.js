import fs from 'node:fs';
import path from 'node:path';

export class StorageError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options] - `code` lets a
   *   caller tell a proven unsafe path from "could not look"; `cause` keeps
   *   the original filesystem error.
   */
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
    if (code) this.code = code;
  }
}

/**
 * Ensure the preview root directory exists and is a directory.
 *
 * Phase 10.1A: derived as APP_DATA_ROOT/previews. Idempotent — accepts an
 * existing valid directory. The parent must already exist (created by
 * validateMounts); this only ensures the previews child. Never creates the
 * preview root if a non-directory file occupies the path.
 *
 * Error messages do not leak absolute paths.
 *
 * @param {string} previewRoot - Absolute path to the preview root.
 * @throws {StorageError} if the path exists but is not a directory,
 *   or if it cannot be created or accessed.
 */
export function ensurePreviewRoot(previewRoot) {
  try {
    const stats = fs.statSync(previewRoot);
    if (!stats.isDirectory()) {
      throw new StorageError(
        `"${path.basename(previewRoot)}" exists but is not a directory.`
      );
    }
    return;
  } catch (err) {
    if (err instanceof StorageError) throw err;
    if (err.code === 'ENOENT') {
      try {
        fs.mkdirSync(previewRoot, { recursive: true });
      } catch (mkdirErr) {
        throw new StorageError(
          `Cannot create preview root "${path.basename(previewRoot)}".`
        );
      }
      return;
    }
    throw new StorageError(
      `Cannot access preview root "${path.basename(previewRoot)}".`
    );
  }
}
