-- Prepare Project Status and Project Type for configurable catalogues by
-- removing only their fixed enumeration CHECK constraints. Preserve literal
-- values, defaults, retained columns, indexes, and the AUTOINCREMENT high-water
-- mark while rebuilding the parent table.

CREATE TABLE projects_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'tbd',
    project_type TEXT NOT NULL DEFAULT 'images',
    patreon_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT,
    project_dir TEXT
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

-- These versioned documents are the one-time catalogue seed. Runtime reads
-- must never recreate missing entries because a missing option may have been
-- deliberately deleted after this migration was applied.
INSERT INTO app_meta (key, value) VALUES
    (
        'project_options.status_catalogue',
        '{"version":1,"entries":[{"value":"tbd","label":"Tbd","color":"#AAAAAA"},{"value":"planned","label":"Planned","color":"#AAAAAA"},{"value":"in-progress","label":"In Progress","color":"#22D3EE"},{"value":"ready","label":"Ready","color":"#34D399"},{"value":"completed","label":"Completed","color":"#A78BFA"},{"value":"archived","label":"Archived","color":"#9CA3AF"}]}'
    ),
    (
        'project_options.project_type_catalogue',
        '{"version":1,"entries":[{"value":"images","label":"Images","color":"#22D3EE"},{"value":"comic","label":"Comic","color":"#A78BFA"},{"value":"animation","label":"Animation","color":"#34D399"},{"value":"wallpaper","label":"Wallpaper","color":"#FF8A94"}]}'
    )
ON CONFLICT(key) DO NOTHING;
