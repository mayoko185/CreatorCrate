-- CreatorCrate fresh-install schema baseline.
-- schema_migrations is created by the migration runner before this migration runs.

CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

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
    project_dir TEXT,
    CONSTRAINT projects_status CHECK (status IN ('tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived')),
    CONSTRAINT projects_priority CHECK (priority IN ('low', 'normal', 'high')),
    CONSTRAINT projects_planned_date_format CHECK (planned_date IS NULL OR planned_date LIKE '____-__-__'),
    CONSTRAINT projects_published_date_format CHECK (published_date IS NULL OR published_date LIKE '____-__-__')
);

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

CREATE TABLE IF NOT EXISTS asset_category_defaults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL,
    directory_slug TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT asset_category_defaults_display_order CHECK (display_order >= 0),
    CONSTRAINT asset_category_defaults_enabled CHECK (enabled IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_category_defaults_slug
    ON asset_category_defaults(directory_slug COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_asset_category_defaults_order
    ON asset_category_defaults(display_order, id);

INSERT INTO asset_category_defaults (display_name, directory_slug, display_order, enabled) VALUES
    ('Final', 'final', 0, 1),
    ('WIP', 'wip', 1, 1),
    ('KRZ', 'krz', 2, 1),
    ('WM', 'wm', 3, 1),
    ('WM-LQ', 'wm-lq', 4, 1);

CREATE TABLE IF NOT EXISTS project_asset_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    directory_slug TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT project_asset_categories_display_order CHECK (display_order >= 0),
    CONSTRAINT project_asset_categories_enabled CHECK (enabled IN (0, 1)),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_asset_categories_project_slug
    ON project_asset_categories(project_id, directory_slug COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_project_asset_categories_order
    ON project_asset_categories(project_id, display_order, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_asset_categories_project_id_id
    ON project_asset_categories(project_id, id);

CREATE TABLE IF NOT EXISTS releases (
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

CREATE TABLE IF NOT EXISTS assets (
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

CREATE INDEX IF NOT EXISTS idx_assets_project_category
    ON assets(project_id, category_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_project_id_id
    ON assets(project_id, id);

CREATE TABLE IF NOT EXISTS release_assets (
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

CREATE INDEX IF NOT EXISTS idx_release_assets_asset_id
    ON release_assets(asset_id);

CREATE INDEX IF NOT EXISTS idx_release_assets_release_sort
    ON release_assets(release_id, sort_order);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    csrf_secret TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
    ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS project_asset_browser_preferences (
    project_id INTEGER PRIMARY KEY,
    default_category_mode TEXT NOT NULL,
    default_category_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT project_asset_browser_preferences_mode CHECK (
        default_category_mode IN ('inherit', 'all', 'category')
    ),
    CONSTRAINT project_asset_browser_preferences_shape CHECK (
        (
            default_category_mode = 'category'
            AND typeof(default_category_id) = 'integer'
            AND default_category_id > 0
        )
        OR (
            default_category_mode IN ('inherit', 'all')
            AND default_category_id IS NULL
        )
    ),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO app_meta (key, value)
VALUES ('asset_browser.default_category', 'all')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS project_primary_images (
    project_id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL,
    FOREIGN KEY (project_id)
        REFERENCES projects(id)
        ON DELETE CASCADE,
    FOREIGN KEY (project_id, asset_id)
        REFERENCES assets(project_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_primary_images_asset_id
    ON project_primary_images(asset_id);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_normalized_name
    ON tags(normalized_name);

CREATE TABLE IF NOT EXISTS project_tags (
    project_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, tag_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_tags_tag_id
    ON project_tags(tag_id);

CREATE TABLE IF NOT EXISTS asset_tags (
    asset_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (asset_id, tag_id),
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_tags_tag_id
    ON asset_tags(tag_id);
