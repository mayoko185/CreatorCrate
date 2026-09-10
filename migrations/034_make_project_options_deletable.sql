-- Archived is an operational Project state, not an editable catalogue entry.
-- Validate the persisted Status catalogue before changing any durable state.
-- The guard SELECT always produces one row, including when the app_meta row is
-- absent, so missing and semantically invalid catalogues both abort migration.
CREATE TEMP TABLE migration_034_status_catalogue_guard (
    is_mergeable INTEGER NOT NULL CHECK (is_mergeable = 1)
);

INSERT INTO migration_034_status_catalogue_guard (is_mergeable)
SELECT is_project_option_catalogue_v1_valid(catalogue.value)
FROM (
    SELECT (
        SELECT value
        FROM app_meta
        WHERE key = 'project_options.status_catalogue'
    ) AS value
) AS catalogue;

-- Filter only Archived from the validated ordered document so custom entries,
-- labels, colors, order, version, and any other document fields survive.
UPDATE app_meta
SET value = json_set(
    value,
    '$.entries',
    json(COALESCE(
        (
            SELECT json_group_array(json(entry.value))
            FROM json_each(app_meta.value, '$.entries') AS entry
            WHERE json_extract(entry.value, '$.value') IS NOT 'archived'
        ),
        '[]'
    ))
)
WHERE key = 'project_options.status_catalogue';

DROP TABLE migration_034_status_catalogue_guard;

-- Materialize Project creation defaults before removing the database defaults
-- that previously supplied them implicitly. These are one-time migration
-- inserts: later deletion of a seeded catalogue value must not recreate it.
INSERT INTO app_meta (key, value)
VALUES ('page_defaults.new_project.status', 'tbd')
ON CONFLICT(key) DO NOTHING;

INSERT INTO app_meta (key, value)
VALUES ('page_defaults.new_project.project_type', 'images')
ON CONFLICT(key) DO NOTHING;

-- Rebuild projects without static Status/Type defaults. Explicit values remain
-- application-owned literals; all other columns and constraints are unchanged.
CREATE TABLE projects_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    project_type TEXT NOT NULL,
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
-- old high-water mark as well, including when it exceeds every retained ID.
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
