-- Place existing Notes into the first editable Book/Chapter hierarchy.
-- Notes remain the content entity; this migration only adds their required
-- Chapter parent and scopes ordering to that parent.

CREATE TABLE books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT books_sort_order CHECK (sort_order >= 0)
);

CREATE INDEX idx_books_sort_order
    ON books(sort_order, id);

CREATE TABLE chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT chapters_sort_order CHECK (sort_order >= 0),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE RESTRICT
);

CREATE INDEX idx_chapters_book_sort_order
    ON chapters(book_id, sort_order, id);

-- Capture the historical AUTOINCREMENT high-water mark before dropping the
-- legacy table. It can exceed the largest current Note ID after deletions.
CREATE TEMP TABLE notes_sequence_before_rebuild (
    seq INTEGER NOT NULL
);

INSERT INTO notes_sequence_before_rebuild (seq)
SELECT seq
FROM sqlite_sequence
WHERE name = 'notes';

-- Existing installations get one normal editable Book and Chapter. Their
-- timestamps bracket the migrated Notes rather than making them appear newer.
INSERT INTO books (title, sort_order, created_at, updated_at)
SELECT 'Notes', 0, MIN(created_at), MAX(updated_at)
FROM notes
HAVING COUNT(*) > 0;

INSERT INTO chapters (book_id, title, sort_order, created_at, updated_at)
SELECT books.id, 'Unfiled', 0, MIN(notes.created_at), MAX(notes.updated_at)
FROM books
CROSS JOIN notes
GROUP BY books.id
HAVING COUNT(notes.id) > 0;

-- Create the replacement before removing notes so child foreign-key metadata
-- continues to reference the restored notes table name after the swap.
CREATE TABLE notes_rebuilt_for_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT notes_sort_order CHECK (sort_order >= 0),
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE RESTRICT
);

INSERT INTO notes_rebuilt_for_chapters (
    id, chapter_id, title, content, sort_order, created_at, updated_at
)
WITH ordered_notes AS (
    SELECT
        id,
        title,
        content,
        created_at,
        updated_at,
        ROW_NUMBER() OVER (ORDER BY sort_order ASC, id ASC) - 1 AS chapter_sort_order
    FROM notes
), default_chapter AS (
    SELECT id
    FROM chapters
    ORDER BY id ASC
    LIMIT 1
)
SELECT
    ordered_notes.id,
    default_chapter.id,
    ordered_notes.title,
    ordered_notes.content,
    ordered_notes.chapter_sort_order,
    ordered_notes.created_at,
    ordered_notes.updated_at
FROM ordered_notes
CROSS JOIN default_chapter;

DROP TABLE notes;
ALTER TABLE notes_rebuilt_for_chapters RENAME TO notes;

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

CREATE INDEX idx_notes_chapter_sort_order
    ON notes(chapter_id, sort_order, id);
