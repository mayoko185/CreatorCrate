-- Distinguish user-selected primary images from future automatic selections.
-- Existing rows read as manual through the non-null default, preserving the
-- existing project and asset relationships without rebuilding the table.

ALTER TABLE project_primary_images
    ADD COLUMN provenance TEXT NOT NULL DEFAULT 'manual'
        CHECK (provenance IN ('manual', 'automatic'));
