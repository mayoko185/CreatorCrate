CREATE TABLE project_page_defaults (
    project_id INTEGER NOT NULL,
    page_key TEXT NOT NULL,
    option_key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, page_key, option_key),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
