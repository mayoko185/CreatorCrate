-- Remove the obsolete release-owned status column.
-- Published and cancelled rows are converted to the durable metadata that
-- replaces their old terminal status before the table is rebuilt.
-- A published row without a date uses date(updated_at), then
-- date(created_at) as the deterministic fallback. A cancelled row without
-- an archive timestamp uses updated_at, then created_at.

UPDATE releases
SET published_date = COALESCE(date(updated_at), date(created_at))
WHERE status = 'published'
  AND published_date IS NULL;

UPDATE releases
SET archived_at = COALESCE(updated_at, created_at)
WHERE status = 'cancelled'
  AND archived_at IS NULL;

DROP INDEX IF EXISTS idx_releases_project_id;
DROP INDEX IF EXISTS idx_releases_status;
DROP INDEX IF EXISTS idx_releases_planned_date;
DROP INDEX IF EXISTS idx_releases_overdue;
DROP INDEX IF EXISTS idx_releases_archived;

ALTER TABLE releases RENAME TO releases_with_status;

CREATE TABLE releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
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
    planned_date,
    planned_time,
    published_date,
    patreon_url,
    created_at,
    updated_at,
    archived_at
FROM releases_with_status;

CREATE TABLE release_assets_without_status (
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

INSERT INTO release_assets_without_status (release_id, asset_id, role, sort_order, created_at)
SELECT release_id, asset_id, role, sort_order, created_at
FROM release_assets;

DROP INDEX IF EXISTS idx_release_assets_asset_id;
DROP INDEX IF EXISTS idx_release_assets_release_sort;
DROP TABLE release_assets;
ALTER TABLE release_assets_without_status RENAME TO release_assets;

CREATE INDEX IF NOT EXISTS idx_releases_project_id
    ON releases(project_id);

CREATE INDEX IF NOT EXISTS idx_releases_planned_date
    ON releases(planned_date DESC)
    WHERE archived_at IS NULL AND published_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_releases_overdue
    ON releases(planned_date)
    WHERE archived_at IS NULL AND published_date IS NULL AND planned_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_releases_archived
    ON releases(archived_at)
    WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_release_assets_asset_id
    ON release_assets(asset_id);

CREATE INDEX IF NOT EXISTS idx_release_assets_release_sort
    ON release_assets(release_id, sort_order);

DROP TABLE releases_with_status;
