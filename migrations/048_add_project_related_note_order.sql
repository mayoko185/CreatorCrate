-- Project-specific presentation order for Project Detail Related Notes.
--
-- A row ranks one Note within one Project's Related Notes list. It never
-- decides which Notes qualify: that remains the union of direct Project links
-- (note_projects) and links to the Project's Assets (note_assets). Qualifying
-- Notes without a row follow the ranked ones in Notes hierarchy order, so an
-- install with no rows keeps today's order and no backfill is needed.
--
-- A row may outlive its Note's last qualifying link; reads ignore it, and the
-- Project's next successful reorder Save replaces every row for that Project.
-- Book, Chapter and Page sort_order columns are never read or written here.
CREATE TABLE project_related_note_order (
    project_id INTEGER NOT NULL
        CHECK (typeof(project_id) = 'integer' AND project_id > 0),
    note_id INTEGER NOT NULL
        CHECK (typeof(note_id) = 'integer' AND note_id > 0),
    sort_order INTEGER NOT NULL
        CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
    PRIMARY KEY (project_id, note_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

-- One position per Project; serves the ordered per-Project read.
CREATE UNIQUE INDEX project_related_note_order_project_sort_idx
    ON project_related_note_order (project_id, sort_order);

-- Serves the ON DELETE CASCADE from notes.
CREATE INDEX project_related_note_order_note_id_idx
    ON project_related_note_order (note_id);
