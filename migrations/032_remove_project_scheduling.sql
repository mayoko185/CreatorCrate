-- Remove obsolete Project-level scheduling. Release scheduling remains unchanged.
-- SQLite cannot drop these columns while their named CHECK constraints exist, so
-- rebuild only projects and preserve every retained value, ID, index, and the
-- AUTOINCREMENT high-water mark.

CREATE TABLE projects_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'tbd',
    project_type TEXT NOT NULL DEFAULT 'images'
        CHECK (project_type IN ('images', 'comic', 'animation', 'wallpaper')),
    patreon_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT,
    project_dir TEXT,
    CONSTRAINT projects_status CHECK (status IN ('tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived'))
);

INSERT INTO projects_new (
    id, title, slug, description, notes, status, project_type, patreon_url,
    created_at, updated_at, archived_at, project_dir
)
SELECT
    id, title, slug, description, notes, status, project_type, patreon_url,
    created_at, updated_at, archived_at, project_dir
FROM projects;

-- Explicit-ID copies preserve only the largest retained ID. Carry forward the
-- old high-water mark as well, including when projects is currently empty.
UPDATE sqlite_sequence
SET seq = (
    SELECT MAX(seq)
    FROM sqlite_sequence
    WHERE name IN ('projects', 'projects_new')
)
WHERE name = 'projects_new';

INSERT INTO sqlite_sequence (name, seq)
SELECT 'projects_new', seq
FROM sqlite_sequence
WHERE name = 'projects'
  AND NOT EXISTS (
      SELECT 1 FROM sqlite_sequence WHERE name = 'projects_new'
  );

DROP TABLE projects;

ALTER TABLE projects_new RENAME TO projects;

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
