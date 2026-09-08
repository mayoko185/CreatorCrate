CREATE TABLE note_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    project_ids_json TEXT NOT NULL,
    asset_ids_json TEXT NOT NULL,
    source_updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX note_revisions_note_id_id_desc_idx
ON note_revisions (note_id, id DESC);
