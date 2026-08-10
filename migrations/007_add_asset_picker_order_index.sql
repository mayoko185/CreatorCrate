-- Supports bounded project-scoped asset picker traversal in the canonical
-- filename order used by the asset browser.
CREATE INDEX IF NOT EXISTS idx_assets_picker_project_filename
    ON assets(project_id, filename COLLATE NOCASE, id);
