-- First-class notes table. Content is canonical Markdown; the data layer does not
-- interpret or render it.  Project/asset associations are a later slice.

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT notes_sort_order CHECK (sort_order >= 0)
);

CREATE INDEX IF NOT EXISTS idx_notes_sort_order
    ON notes(sort_order, id);