-- Persistent application logs deliberately retain project IDs without a foreign key.
-- Historical diagnostics must survive project deletion.
CREATE TABLE application_logs (
  id INTEGER PRIMARY KEY,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  level TEXT NOT NULL CHECK (length(CAST(level AS BLOB)) BETWEEN 1 AND 16),
  kind TEXT NOT NULL CHECK (length(CAST(kind AS BLOB)) BETWEEN 1 AND 64),
  subsystem TEXT NOT NULL CHECK (length(CAST(subsystem AS BLOB)) BETWEEN 1 AND 64),
  event TEXT NOT NULL CHECK (length(CAST(event AS BLOB)) BETWEEN 1 AND 128),
  message TEXT NOT NULL CHECK (length(CAST(message AS BLOB)) BETWEEN 1 AND 4096),
  project_id INTEGER,
  correlation_id TEXT CHECK (correlation_id IS NULL OR length(CAST(correlation_id AS BLOB)) BETWEEN 1 AND 128),
  context_json TEXT NOT NULL CHECK (length(CAST(context_json AS BLOB)) <= 16384)
);

CREATE INDEX idx_application_logs_occurred_at_id
  ON application_logs(occurred_at_ms DESC, id DESC);

CREATE INDEX idx_application_logs_level_occurred_at_id
  ON application_logs(level, occurred_at_ms DESC, id DESC);
