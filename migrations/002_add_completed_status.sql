-- Add 'completed' to the projects.status CHECK constraint.
-- SQLite cannot ALTER a CHECK constraint in place, so the projects table is
-- rebuilt following the procedure at https://www.sqlite.org/lang_altertable.html#otherkinds.
--
-- The migration runner disables foreign_keys for the body of each migration,
-- so the rebuild preserves all child rows (releases [ON DELETE RESTRICT],
-- assets, project_asset_categories, project_tags, project_asset_browser_preferences,
-- and project_primary_images [all ON DELETE CASCADE]). With FKs ON, the
-- DROP below would cascade-delete those children.

CREATE TABLE projects_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'tbd',
    priority TEXT NOT NULL DEFAULT 'normal',
    planned_date TEXT,
    published_date TEXT,
    patreon_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT,
    project_dir TEXT,
    CONSTRAINT projects_status CHECK (status IN ('tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived')),
    CONSTRAINT projects_priority CHECK (priority IN ('low', 'normal', 'high')),
    CONSTRAINT projects_planned_date_format CHECK (planned_date IS NULL OR planned_date LIKE '____-__-__'),
    CONSTRAINT projects_published_date_format CHECK (published_date IS NULL OR published_date LIKE '____-__-__')
);

-- Copy every column verbatim, preserving ids so child FKs stay valid.
INSERT INTO projects_new (
    id, title, slug, description, notes, status, priority,
    planned_date, published_date, patreon_url,
    created_at, updated_at, archived_at, project_dir
)
SELECT
    id, title, slug, description, notes, status, priority,
    planned_date, published_date, patreon_url,
    created_at, updated_at, archived_at, project_dir
FROM projects;

DROP TABLE projects;

ALTER TABLE projects_new RENAME TO projects;

-- AUTOINCREMENT high-water mark (sqlite_sequence) is updated by the explicit-id
-- INSERTs above, so the next auto-generated id continues past the largest copied id.

CREATE INDEX IF NOT EXISTS idx_projects_archived_updated
    ON projects(archived_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_projects_status_archived
    ON projects(status, archived_at);

CREATE INDEX IF NOT EXISTS idx_projects_title
    ON projects(title COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_projects_description
    ON projects(description COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_projects_notes
    ON projects(notes COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_projects_project_dir
    ON projects(project_dir);
