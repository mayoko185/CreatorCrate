ALTER TABLE watermark_scale_maps ADD COLUMN system_key TEXT;
CREATE UNIQUE INDEX watermark_scale_maps_system_key_unique
  ON watermark_scale_maps(system_key)
  WHERE system_key IS NOT NULL;

CREATE TABLE processing_presets (
  id INTEGER PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('watermark', 'workflow-prompt', 'convert')),
  display_name TEXT NOT NULL,
  system_key TEXT UNIQUE,
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version = 1),
  config_json TEXT NOT NULL,
  watermark_id INTEGER REFERENCES watermarks(id) ON DELETE SET NULL,
  scale_map_id INTEGER REFERENCES watermark_scale_maps(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX processing_presets_operation_display_name_unique
  ON processing_presets(operation_type, display_name COLLATE NOCASE);
