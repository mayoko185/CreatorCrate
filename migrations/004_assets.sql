-- Phase 4: project asset indexing and file metadata.
-- Tracks files discovered inside project directories through manual scans.
-- The filesystem remains authoritative; asset records are a cached index.

CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    filename TEXT NOT NULL,
    extension TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    modified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Primary project asset lookup (all assets for a project).
CREATE INDEX IF NOT EXISTS idx_assets_project_id
    ON assets(project_id);

-- Extension filtering in the asset list UI.
CREATE INDEX IF NOT EXISTS idx_assets_extension
    ON assets(extension);

-- Filename search (case-insensitive).
CREATE INDEX IF NOT EXISTS idx_assets_filename
    ON assets(filename COLLATE NOCASE);

-- Modified-date sorting (most recent first).
CREATE INDEX IF NOT EXISTS idx_assets_modified_at
    ON assets(modified_at DESC);

-- Unique path per project — prevents duplicate entries for the same file.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_project_path
    ON assets(project_id, relative_path);
