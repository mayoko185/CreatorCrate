-- Note-to-project and note-to-asset junction tables.
-- These are pure relationship tables: a note may be linked to any number of
-- projects and any number of assets independently.  Associating an asset does
-- NOT implicitly associate the project that owns the asset.

CREATE TABLE IF NOT EXISTS note_projects (
    note_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    PRIMARY KEY (note_id, project_id),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_projects_project_id
    ON note_projects(project_id);

CREATE TABLE IF NOT EXISTS note_assets (
    note_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    PRIMARY KEY (note_id, asset_id),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_assets_asset_id
    ON note_assets(asset_id);
