ALTER TABLE release_social_platforms
  ADD COLUMN is_selected INTEGER NOT NULL DEFAULT 1 CHECK (is_selected IN (0, 1));
