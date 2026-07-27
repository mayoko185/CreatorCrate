-- Phase 2: project metadata records.
CREATE TABLE IF NOT EXISTS projects (
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
    CONSTRAINT projects_status CHECK (status IN ('tbd', 'planned', 'in-progress', 'ready', 'published', 'archived')),
    CONSTRAINT projects_priority CHECK (priority IN ('low', 'normal', 'high')),
    CONSTRAINT projects_planned_date_format CHECK (planned_date IS NULL OR planned_date LIKE '____-__-__'),
    CONSTRAINT projects_published_date_format CHECK (published_date IS NULL OR published_date LIKE '____-__-__')
);

-- Active project lists are filtered by archived_at and sorted by updated_at.
CREATE INDEX IF NOT EXISTS idx_projects_archived_updated
    ON projects(archived_at, updated_at DESC);

-- Status filters are common in the UI and dashboard counts.
CREATE INDEX IF NOT EXISTS idx_projects_status_archived
    ON projects(status, archived_at);

-- List/search/sort by title.
CREATE INDEX IF NOT EXISTS idx_projects_title
    ON projects(title COLLATE NOCASE);

-- Search across descriptive text.
CREATE INDEX IF NOT EXISTS idx_projects_description
    ON projects(description COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_projects_notes
    ON projects(notes COLLATE NOCASE);
