-- Phase D1: one retained primary-image reference per project.
-- The selected asset is deliberately stored separately from projects so
-- existing projects receive no selection and projects need not be rebuilt.

-- SQLite requires the referenced parent columns of a composite foreign key to
-- be covered by one unique key with the same column order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_project_id_id
    ON assets(project_id, id);

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

-- Supports cleanup when an asset row is hard-deleted.
CREATE INDEX IF NOT EXISTS idx_project_primary_images_asset_id
    ON project_primary_images(asset_id);
