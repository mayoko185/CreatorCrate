-- Persistent project-directory ownership binding (schema only).
--
-- Each row binds a project to the opaque ownership token that its project
-- directory's `.creatorcrate-owner` marker must carry. The token is random
-- (32 bytes, lowercase hex) and derived from nothing about the project, its
-- path, or its filesystem object identity.
--
-- `pending` records a token persisted before its marker is created and
-- verified; `bound` records a verified binding. No row means unbound.
--
-- This migration creates an empty table: it performs no filesystem access,
-- creates no marker, and binds no existing project.
CREATE TABLE project_directory_ownership (
    project_id INTEGER PRIMARY KEY
        REFERENCES projects(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE CHECK (
        length(token) = 64 AND token NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('pending', 'bound'))
);
