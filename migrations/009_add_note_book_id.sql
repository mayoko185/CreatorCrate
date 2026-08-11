-- Allow Pages to live directly in a Book while retaining existing Chapter
-- membership. The same-Book relationship is enforced by the domain layer;
-- SQLite CHECK constraints cannot use the required cross-table subquery.

-- Capture the historical AUTOINCREMENT high-water mark before dropping the
-- legacy table. It can exceed the largest current Note ID after deletions.
CREATE TEMP TABLE notes_sequence_before_rebuild (
    seq INTEGER NOT NULL
);

INSERT INTO notes_sequence_before_rebuild (seq)
SELECT seq
FROM sqlite_sequence
WHERE name = 'notes';

-- The LEFT JOINs intentionally retain one replacement row per legacy Note.
-- A missing Chapter or Book produces NULL book_id and fails the replacement
-- table's NOT NULL constraint instead of silently discarding the Note.
CREATE TABLE notes_rebuilt_for_book_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    chapter_id INTEGER,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT notes_sort_order CHECK (sort_order >= 0),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE RESTRICT,
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE RESTRICT
);

INSERT INTO notes_rebuilt_for_book_pages (
    id, book_id, chapter_id, title, content, sort_order, created_at, updated_at
)
SELECT
    notes.id,
    books.id,
    notes.chapter_id,
    notes.title,
    notes.content,
    notes.sort_order,
    notes.created_at,
    notes.updated_at
FROM notes
LEFT JOIN chapters ON chapters.id = notes.chapter_id
LEFT JOIN books ON books.id = chapters.book_id;

-- Create the replacement before removing notes so child foreign-key metadata
-- continues to reference the restored notes table name after the swap.
DROP TABLE notes;
ALTER TABLE notes_rebuilt_for_book_pages RENAME TO notes;

-- The replacement-table inserts preserve current IDs, but not necessarily the
-- old high-water mark. Restore the larger captured value when it exists.
UPDATE sqlite_sequence
SET seq = MAX(seq, (SELECT seq FROM notes_sequence_before_rebuild))
WHERE name = 'notes'
  AND EXISTS (SELECT 1 FROM notes_sequence_before_rebuild);

INSERT INTO sqlite_sequence (name, seq)
SELECT 'notes', seq
FROM notes_sequence_before_rebuild
WHERE NOT EXISTS (
    SELECT 1
    FROM sqlite_sequence
    WHERE name = 'notes'
);

DROP TABLE notes_sequence_before_rebuild;

-- Supports direct Book Pages first, while retaining Chapter-local ordering.
CREATE INDEX idx_notes_book_chapter_sort_order
    ON notes(book_id, chapter_id, sort_order, id);

CREATE INDEX idx_notes_chapter_sort_order
    ON notes(chapter_id, sort_order, id);
