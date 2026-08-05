-- Replace the legacy release workflow values with the shared project vocabulary.
-- Rebuilding releases is required because SQLite cannot alter a CHECK constraint
-- in place. release_assets is rebuilt as well because it references releases.

ALTER TABLE releases RENAME TO releases_legacy;

CREATE TABLE releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'tbd'
        CHECK (status IN ('tbd', 'planned', 'in-progress', 'ready', 'published', 'cancelled')),
    planned_date TEXT,
    planned_time TEXT,
    published_date TEXT,
    patreon_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

INSERT INTO releases (
    id,
    project_id,
    title,
    description,
    notes,
    status,
    planned_date,
    planned_time,
    published_date,
    patreon_url,
    created_at,
    updated_at,
    archived_at
)
SELECT
    id,
    project_id,
    title,
    description,
    notes,
    CASE status
        WHEN 'idea' THEN 'tbd'
        WHEN 'drafting' THEN 'in-progress'
        ELSE status
    END,
    planned_date,
    planned_time,
    published_date,
    patreon_url,
    created_at,
    updated_at,
    archived_at
FROM releases_legacy;

DROP INDEX IF EXISTS idx_releases_project_id;
DROP INDEX IF EXISTS idx_releases_status;
DROP INDEX IF EXISTS idx_releases_planned_date;
DROP INDEX IF EXISTS idx_releases_overdue;
DROP INDEX IF EXISTS idx_releases_archived;

CREATE INDEX IF NOT EXISTS idx_releases_project_id
    ON releases(project_id);

CREATE INDEX IF NOT EXISTS idx_releases_status
    ON releases(status);

CREATE INDEX IF NOT EXISTS idx_releases_planned_date
    ON releases(planned_date DESC)
    WHERE status IN ('tbd', 'planned', 'in-progress', 'ready');

CREATE INDEX IF NOT EXISTS idx_releases_overdue
    ON releases(planned_date)
    WHERE status IN ('tbd', 'planned', 'in-progress', 'ready') AND planned_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_releases_archived
    ON releases(archived_at)
    WHERE archived_at IS NOT NULL;

CREATE TABLE release_assets_new (
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

INSERT INTO release_assets_new (release_id, asset_id, role, sort_order, created_at)
SELECT release_id, asset_id, role, sort_order, created_at
FROM release_assets;

DROP INDEX IF EXISTS idx_release_assets_asset_id;
DROP INDEX IF EXISTS idx_release_assets_release_sort;
DROP TABLE release_assets;
ALTER TABLE release_assets_new RENAME TO release_assets;

CREATE INDEX IF NOT EXISTS idx_release_assets_asset_id
    ON release_assets(asset_id);

CREATE INDEX IF NOT EXISTS idx_release_assets_release_sort
    ON release_assets(release_id, sort_order);

DROP TABLE releases_legacy;
