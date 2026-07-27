-- Phase 5A: Asset identity preservation.
-- Assets now track presence state instead of being deleted when files disappear.
-- This preserves asset identities (ID, metadata) so they can be restored if files return.

-- is_present: 1 = file currently exists on disk, 0 = file is missing
-- last_seen_at: timestamp when the file was last confirmed on disk
-- missing_since: timestamp when the file first went missing (NULL if present)

ALTER TABLE assets ADD COLUMN is_present INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN last_seen_at TEXT;
ALTER TABLE assets ADD COLUMN missing_since TEXT;

-- Index for finding missing assets (needed for queries)
CREATE INDEX IF NOT EXISTS idx_assets_missing
    ON assets(project_id, is_present, missing_since)
    WHERE is_present = 0;

-- Index for presence queries by project (filtering present vs missing)
CREATE INDEX IF NOT EXISTS idx_assets_present
    ON assets(project_id, is_present);
