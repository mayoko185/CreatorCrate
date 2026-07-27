-- Phase 5C: Release asset selection layer.
-- Assets remain owned by projects; releases select assets.
-- Deleting a release removes selections. Deleting an asset removes selections.
-- Assets themselves are never deleted because of release relationships.

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

-- Index for reverse lookups: "which releases use this asset?"
CREATE INDEX IF NOT EXISTS idx_release_assets_asset_id
    ON release_assets(asset_id);

-- Index for release asset ordering.
CREATE INDEX IF NOT EXISTS idx_release_assets_release_sort
    ON release_assets(release_id, sort_order);
