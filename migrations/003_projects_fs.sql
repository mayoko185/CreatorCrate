-- Phase 3: project directory tracking.
-- Adds a nullable relative path field for each project's directory under PROJECTS_ROOT.

ALTER TABLE projects ADD COLUMN project_dir TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_project_dir
    ON projects(project_dir);
