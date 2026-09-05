-- Remove the obsolete release asset source role without discarding associations.
CREATE TABLE release_assets_new (
    release_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'attachment'
        CHECK (role IN ('primary', 'preview', 'attachment')),
    sort_order INTEGER NOT NULL DEFAULT 0
        CHECK (sort_order >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (release_id, asset_id),
    FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

INSERT INTO release_assets_new (release_id, asset_id, role, sort_order, created_at)
SELECT
    release_id,
    asset_id,
    CASE WHEN role = 'source' THEN 'attachment' ELSE role END,
    sort_order,
    created_at
FROM release_assets;

DROP TABLE release_assets;
ALTER TABLE release_assets_new RENAME TO release_assets;

CREATE INDEX idx_release_assets_asset_id
    ON release_assets(asset_id);

CREATE INDEX idx_release_assets_release_sort
    ON release_assets(release_id, sort_order);
