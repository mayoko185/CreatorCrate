-- Project-local Watermarks source convention.
-- The global default is added independently from the original baseline so
-- existing installations receive it through the normal migration runner.

INSERT INTO asset_category_defaults (display_name, directory_slug, display_order, enabled)
SELECT
    'Watermarks',
    'watermarks',
    COALESCE((SELECT MAX(display_order) + 1 FROM asset_category_defaults), 0),
    1
WHERE NOT EXISTS (
    SELECT 1
    FROM asset_category_defaults
    WHERE directory_slug = 'watermarks' COLLATE NOCASE
);

-- Existing projects own independent category rows. Add the new row only when
-- the project does not already have this slug; a project-specific category
-- customization remains authoritative.
INSERT INTO project_asset_categories (
    project_id,
    display_name,
    directory_slug,
    display_order,
    enabled
)
SELECT
    projects.id,
    defaults.display_name,
    defaults.directory_slug,
    COALESCE((
        SELECT MAX(existing.display_order) + 1
        FROM project_asset_categories existing
        WHERE existing.project_id = projects.id
    ), 0),
    1
FROM projects
JOIN asset_category_defaults defaults
  ON defaults.directory_slug = 'watermarks' COLLATE NOCASE
 AND defaults.enabled = 1
WHERE NOT EXISTS (
    SELECT 1
    FROM project_asset_categories existing
    WHERE existing.project_id = projects.id
      AND existing.directory_slug = 'watermarks' COLLATE NOCASE
);

-- Filesystem provisioning is deliberately completed by the existing project
-- category lifecycle after the migration commits. The marker makes that
-- one-time upgrade retryable without creating directories on every startup.
INSERT INTO app_meta (key, value)
VALUES ('project_watermarks.provisioning', 'pending')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
