CREATE TABLE project_page_default_scopes (
    project_id INTEGER NOT NULL,
    page_key TEXT NOT NULL,
    active_scope TEXT NOT NULL
        CHECK (active_scope IN ('global', 'project')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, page_key),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO project_page_default_scopes (project_id, page_key, active_scope)
SELECT
    projects.id,
    'projectAssets',
    CASE WHEN EXISTS (
        SELECT 1
        FROM project_page_defaults
        WHERE project_page_defaults.project_id = projects.id
          AND project_page_defaults.page_key = 'projectAssets'
    ) THEN 'project' ELSE 'global' END
FROM projects;
