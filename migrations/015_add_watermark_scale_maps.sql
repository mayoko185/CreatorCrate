CREATE TABLE watermark_scale_maps (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
