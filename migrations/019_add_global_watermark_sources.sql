ALTER TABLE watermarks ADD COLUMN source_relative_path TEXT;
ALTER TABLE watermarks ADD COLUMN source_present INTEGER NOT NULL DEFAULT 0
  CHECK (source_present IN (0, 1));
ALTER TABLE watermarks ADD COLUMN source_last_seen_at TEXT;
ALTER TABLE watermarks ADD COLUMN source_missing_at TEXT;

CREATE UNIQUE INDEX idx_watermarks_source_relative_path
  ON watermarks(source_relative_path)
  WHERE source_relative_path IS NOT NULL;

CREATE INDEX idx_watermarks_source_present
  ON watermarks(source_present, source_relative_path)
  WHERE source_relative_path IS NOT NULL;
