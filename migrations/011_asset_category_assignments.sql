-- Phase 2 chunk 1: asset-category assignment fields.
-- Adds a nullable category_id (owned by the project's asset categories) and
-- a nested_path (the directory portion below the category root) to assets.
-- SQLite has no ALTER TABLE ADD FOREIGN KEY, so the table is rebuilt.
--
-- release_assets is the only table with a foreign key into assets (checked
-- against every migration file). It is dropped before the assets rebuild and
-- recreated with its original schema and rows restored afterward, so the
-- rebuild never runs with a dangling child reference and never needs
-- `PRAGMA foreign_keys=OFF`.
--
-- Existing rows are copied with category_id = NULL (no inference) and
-- nested_path derived from the stored relative_path/filename pair.

-- Parent side of the new composite foreign key: project_asset_categories(id)
-- is already unique (PRIMARY KEY), so (project_id, id) is trivially unique
-- too — this index just gives SQLite the explicit composite unique index a
-- composite foreign key requires.
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_asset_categories_project_id_id
    ON project_asset_categories(project_id, id);

-- ─── Preserve release_assets rows across the assets rebuild ────────────────

CREATE TABLE release_assets_backup_011 AS SELECT * FROM release_assets;

DROP TABLE release_assets;

-- ─── Rebuild assets with category_id and nested_path ────────────────────────

CREATE TABLE assets_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    category_id INTEGER,
    relative_path TEXT NOT NULL,
    nested_path TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL,
    extension TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    modified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_present INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    missing_since TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, category_id) REFERENCES project_asset_categories(project_id, id)
        ON DELETE NO ACTION
        DEFERRABLE INITIALLY DEFERRED
);

-- category_id = NULL for every existing row (no inference performed here).
-- nested_path is derived from relative_path with the stored filename
-- stripped safely (no separator parsing): everything before "/" + filename,
-- or '' when relative_path *is* the filename (a root file).
INSERT INTO assets_new (
    id, project_id, category_id, relative_path, nested_path, filename, extension,
    mime_type, size_bytes, modified_at, created_at, updated_at,
    is_present, last_seen_at, missing_since
)
SELECT
    id, project_id, NULL, relative_path,
    CASE WHEN relative_path = filename THEN ''
         ELSE substr(relative_path, 1, length(relative_path) - length(filename) - 1)
    END,
    filename, extension, mime_type, size_bytes, modified_at, created_at, updated_at,
    is_present, last_seen_at, missing_since
FROM assets;

-- release_assets was already dropped above, so no child table references
-- `assets` at this point — dropping it here cannot violate a foreign key.
DROP TABLE assets;

ALTER TABLE assets_new RENAME TO assets;

-- Recreate every pre-existing assets index unchanged.
CREATE INDEX IF NOT EXISTS idx_assets_project_id
    ON assets(project_id);

CREATE INDEX IF NOT EXISTS idx_assets_extension
    ON assets(extension);

CREATE INDEX IF NOT EXISTS idx_assets_filename
    ON assets(filename COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_assets_modified_at
    ON assets(modified_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_project_path
    ON assets(project_id, relative_path);

CREATE INDEX IF NOT EXISTS idx_assets_missing
    ON assets(project_id, is_present, missing_since)
    WHERE is_present = 0;

CREATE INDEX IF NOT EXISTS idx_assets_present
    ON assets(project_id, is_present);

-- New lookup index for category-aware asset queries.
CREATE INDEX IF NOT EXISTS idx_assets_project_category
    ON assets(project_id, category_id);

-- ─── Restore release_assets with its original schema and rows ──────────────

CREATE TABLE release_assets (
    release_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'attachment'
        CHECK (role IN ('primary', 'preview', 'attachment', 'source')),
    sort_order INTEGER NOT NULL DEFAULT 0
        CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (release_id, asset_id),
    FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

INSERT INTO release_assets SELECT * FROM release_assets_backup_011;

DROP TABLE release_assets_backup_011;

CREATE INDEX IF NOT EXISTS idx_release_assets_asset_id
    ON release_assets(asset_id);

CREATE INDEX IF NOT EXISTS idx_release_assets_release_sort
    ON release_assets(release_id, sort_order);
