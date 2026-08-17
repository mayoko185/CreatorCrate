CREATE TABLE generated_artifacts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  generated_mode TEXT,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, relative_path)
);

CREATE INDEX idx_generated_artifacts_project_path
  ON generated_artifacts(project_id, relative_path);
