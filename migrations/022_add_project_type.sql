-- Classify projects for the upcoming project-list type filtering. SQLite can
-- add this non-null column safely because its default supplies existing rows.
ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'images'
  CHECK (project_type IN ('images', 'comic', 'animation', 'wallpaper'));
