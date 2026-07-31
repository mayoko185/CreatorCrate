-- Phase 1: configurable asset categories.
-- Global defaults are an independent, ungoverned template list. Project
-- categories are independent rows copied from enabled defaults at creation
-- time — there is no live relationship back to the defaults afterward.

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

-- Case-insensitive uniqueness on directory_slug.
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_category_defaults_slug
    ON asset_category_defaults(directory_slug COLLATE NOCASE);

-- List defaults ordered by display_order, then id.
CREATE INDEX IF NOT EXISTS idx_asset_category_defaults_order
    ON asset_category_defaults(display_order, id);

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

-- Case-insensitive uniqueness on directory_slug within each project.
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_asset_categories_project_slug
    ON project_asset_categories(project_id, directory_slug COLLATE NOCASE);

-- List project categories ordered by display_order, then id.
CREATE INDEX IF NOT EXISTS idx_project_asset_categories_order
    ON project_asset_categories(project_id, display_order, id);

-- Seed enabled global defaults in canonical order.
INSERT INTO asset_category_defaults (display_name, directory_slug, display_order, enabled) VALUES
    ('Source', 'source', 0, 1),
    ('Exports', 'exports', 1, 1),
    ('Extras', 'extras', 2, 1),
    ('References', 'references', 3, 1),
    ('Thumbnails', 'thumbnails', 4, 1);
