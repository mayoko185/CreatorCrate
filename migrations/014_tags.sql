-- Phase 14: globally reusable project and asset tags.
-- The service layer supplies normalized_name from the user-facing display name;
-- keeping both values preserves capitalization without adding SQL normalization.

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Case-insensitive uniqueness is represented by the explicit normalized value.
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

-- Reverse lookup: which projects use this tag?
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

-- Reverse lookup: which assets use this tag?
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag_id
    ON asset_tags(tag_id);
