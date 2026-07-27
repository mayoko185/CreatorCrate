-- Phase 5B: Release planning domain.
-- Releases represent distribution events, not filesystem state.
-- A release is tied to a project and tracks publication workflow.

CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idea'
        CHECK (status IN ('idea', 'planned', 'drafting', 'ready', 'published', 'cancelled')),
    planned_date TEXT,
    published_date TEXT,
    patreon_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

-- Index for per-project release lookups.
CREATE INDEX IF NOT EXISTS idx_releases_project_id
    ON releases(project_id);

-- Index for status-based filtering.
CREATE INDEX IF NOT EXISTS idx_releases_status
    ON releases(status);

-- Index for upcoming releases (planned_date ordering).
CREATE INDEX IF NOT EXISTS idx_releases_planned_date
    ON releases(planned_date DESC)
    WHERE status IN ('idea', 'planned', 'drafting', 'ready');

-- Index for overdue releases (past planned_date, not yet published).
CREATE INDEX IF NOT EXISTS idx_releases_overdue
    ON releases(planned_date)
    WHERE status IN ('idea', 'planned', 'drafting', 'ready') AND planned_date IS NOT NULL;

-- Index for archive queries.
CREATE INDEX IF NOT EXISTS idx_releases_archived
    ON releases(archived_at)
    WHERE archived_at IS NOT NULL;
