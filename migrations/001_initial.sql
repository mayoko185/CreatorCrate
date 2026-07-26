-- Phase 1 placeholder: application bookkeeping table.
-- schema_migrations is created by the migration runner before any migration runs.
CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
