CREATE TABLE watermarks (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE assets ADD COLUMN generated_watermark_id
  INTEGER REFERENCES watermarks(id) ON DELETE SET NULL;

ALTER TABLE generated_artifacts ADD COLUMN generated_watermark_id
  INTEGER REFERENCES watermarks(id) ON DELETE SET NULL;

CREATE INDEX idx_assets_generated_watermark
  ON assets(generated_watermark_id)
  WHERE generated_watermark_id IS NOT NULL;

CREATE INDEX idx_generated_artifacts_generated_watermark
  ON generated_artifacts(generated_watermark_id)
  WHERE generated_watermark_id IS NOT NULL;
