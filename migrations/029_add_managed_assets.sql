-- Application-owned immutable originals; no Project ownership or file lifecycle.
CREATE TABLE managed_assets (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
    storage_key TEXT NOT NULL UNIQUE CHECK (
        length(storage_key) > 0
        AND substr(storage_key, 1, 1) <> '/'
        AND instr(storage_key, char(92)) = 0
        AND instr(storage_key, ':') = 0
        AND instr(storage_key, char(0)) = 0
        AND instr('/' || storage_key || '/', '/../') = 0
        AND instr('/' || storage_key || '/', '/./') = 0
        AND instr('/' || storage_key || '/', '//') = 0
    ),
    namespace TEXT NOT NULL CHECK (namespace = 'book-covers'),
    mime_type TEXT NOT NULL CHECK (length(mime_type) > 0),
    size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes > 0),
    width INTEGER NOT NULL CHECK (typeof(width) = 'integer' AND width > 0),
    height INTEGER NOT NULL CHECK (typeof(height) = 'integer' AND height > 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE book_primary_images_new (
    book_id INTEGER PRIMARY KEY,
    asset_id INTEGER,
    managed_asset_id TEXT,
    CHECK ((asset_id IS NOT NULL) + (managed_asset_id IS NOT NULL) = 1),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY (managed_asset_id) REFERENCES managed_assets(id) ON DELETE RESTRICT
);

INSERT INTO book_primary_images_new (book_id, asset_id)
    SELECT book_id, asset_id FROM book_primary_images;
DROP TABLE book_primary_images;
ALTER TABLE book_primary_images_new RENAME TO book_primary_images;
CREATE INDEX idx_book_primary_images_asset_id ON book_primary_images(asset_id);
CREATE INDEX idx_book_primary_images_managed_asset_id ON book_primary_images(managed_asset_id);

-- The runner disables FKs for rebuilds. Fail atomically rather than commit
-- dangling references; a bare PRAGMA foreign_key_check would not throw.
CREATE TEMP TABLE managed_assets_fk_check (violations INTEGER CHECK (violations = 0));
INSERT INTO managed_assets_fk_check
    SELECT count(*) FROM pragma_foreign_key_check('book_primary_images');
DROP TABLE managed_assets_fk_check;
