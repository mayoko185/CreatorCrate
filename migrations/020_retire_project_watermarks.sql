-- Retire the abandoned project-local Watermarks default without touching
-- existing project-owned categories or their filesystem content. Migration 017
-- did not record category provenance, so existing `watermarks` rows must
-- remain ordinary user categories.
DELETE FROM asset_category_defaults
WHERE directory_slug = 'watermarks' COLLATE NOCASE;

-- The project-local provisioner is retired. This marker must not influence the
-- global <PROJECTS_ROOT>/watermarks source.
DELETE FROM app_meta
WHERE key = 'project_watermarks.provisioning';
