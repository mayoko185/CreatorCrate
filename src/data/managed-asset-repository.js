import { randomUUID } from 'node:crypto';

const COLUMNS = 'id, storage_key, namespace, mime_type, size_bytes, width, height, sha256, created_at';

/**
 * SQL-only persistence for committed application-owned originals. Callers supply
 * verified metadata; this repository does not inspect or publish files.
 * No general update/delete API: committed originals may remain unreferenced.
 * Operations can participate in a caller-owned transaction.
 */
export function createManagedAssetRepository(db) {
  const creations = new WeakMap();
  // Connection-local receipts distinguish even byte-identical replacements.
  // INSERT invalidation also covers REPLACE when recursive triggers are off.
  // No durable schema change or ordinary asset deletion is involved.
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS managed_asset_creation_receipts (id TEXT PRIMARY KEY, nonce TEXT NOT NULL);
    CREATE TEMP TRIGGER IF NOT EXISTS managed_asset_creation_insert AFTER INSERT ON main.managed_assets
    BEGIN DELETE FROM managed_asset_creation_receipts WHERE id = NEW.id; END;
    CREATE TEMP TRIGGER IF NOT EXISTS managed_asset_creation_update AFTER UPDATE ON main.managed_assets
    BEGIN DELETE FROM managed_asset_creation_receipts WHERE id IN (OLD.id, NEW.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS managed_asset_creation_delete AFTER DELETE ON main.managed_assets
    BEGIN DELETE FROM managed_asset_creation_receipts WHERE id = OLD.id; END;
  `);
  const receiptStmt = db.prepare('INSERT INTO temp.managed_asset_creation_receipts (id, nonce) VALUES (?, ?)');
  const versionStmt = db.prepare('PRAGMA data_version');
  const insertStmt = db.prepare(`
    INSERT INTO managed_assets (id, storage_key, namespace, mime_type, size_bytes, width, height, sha256)
    VALUES (@id, @storageKey, @namespace, @mimeType, @sizeBytes, @width, @height, @sha256)
    RETURNING ${COLUMNS}
  `);
  const findStmt = db.prepare(`SELECT ${COLUMNS} FROM managed_assets WHERE id = ?`);
  const referencedStmt = db.prepare(`
    SELECT 1 FROM book_primary_images WHERE managed_asset_id = ? LIMIT 1
  `);
  const rollbackStmt = db.prepare(`
    DELETE FROM managed_assets
    WHERE ${COLUMNS.split(', ').map((column) => `${column} = @${column}`).join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM book_primary_images WHERE managed_asset_id = @id)
      AND EXISTS (SELECT 1 FROM temp.managed_asset_creation_receipts WHERE id = @id AND nonce = @nonce)
  `);
  const insert = db.transaction((metadata) => {
    const record = insertStmt.get(metadata);
    const nonce = randomUUID();
    receiptStmt.run(record.id, nonce);
    creations.set(record, { metadata: { ...record }, nonce, version: versionStmt.get().data_version });
    return record;
  });
  const rollback = db.transaction((expected) => {
    // TEMP triggers cannot observe another connection's writes: fail closed.
    if (versionStmt.get().data_version !== expected.version) return false;
    return rollbackStmt.run({ ...expected.metadata, nonce: expected.nonce }).changes === 1;
  });

  return {
    insertCommitted({ id, storageKey, namespace, mimeType, sizeBytes, width, height, sha256 }) {
      return insert({ id, storageKey, namespace, mimeType, sizeBytes, width, height, sha256 });
    },
    /**
     * Roll back only this instance's exact insertion result, never an ID, copy,
     * or lookup result. All persisted metadata and Book references are checked
     * in the DELETE itself. False means refusal; files are never touched.
     */
    rollbackCommitted(record) {
      const expected = creations.get(record);
      if (!expected || Object.keys(expected.metadata).some((key) => record[key] !== expected.metadata[key])) return false;
      const removed = rollback.immediate(expected);
      if (removed) creations.delete(record);
      return removed;
    },
    findById(id) {
      return findStmt.get(id);
    },
    /** Single-record metadata reads are bounded; no library listing API. */
    isReferenced(id) {
      return referencedStmt.get(id) !== undefined;
    },
  };
}
