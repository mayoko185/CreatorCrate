-- Phase B chunk 1: persisted asset-browser category preferences.
-- Project preferences are independent of project-owned category rows so a
-- disabled category can remain selected and become effective again later.

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

-- Existing projects begin with the explicit inherit state. New projects use
-- the repository's idempotent ensure operation until project creation wiring
-- is added in a later chunk.
INSERT INTO project_asset_browser_preferences (project_id, default_category_mode, default_category_id)
SELECT id, 'inherit', NULL
FROM projects;

-- The metadata key is initialized only when it does not already exist.
INSERT INTO app_meta (key, value)
VALUES ('asset_browser.default_category', 'all')
ON CONFLICT(key) DO NOTHING;
