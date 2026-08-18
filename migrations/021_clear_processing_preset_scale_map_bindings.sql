-- Scale maps are now a single system-keyed execution resource, not preset bindings.
-- Preserve both the legacy schema and all historical map rows for compatibility.
UPDATE processing_presets
SET scale_map_id = NULL
WHERE scale_map_id IS NOT NULL;
