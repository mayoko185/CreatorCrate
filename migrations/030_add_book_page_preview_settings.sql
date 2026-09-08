CREATE TABLE book_page_preview_settings (
    book_id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL,
    random_count INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT book_page_preview_settings_mode CHECK (mode IN ('random', 'selected')),
    CONSTRAINT book_page_preview_settings_random_count CHECK (
        typeof(random_count) = 'integer' AND random_count BETWEEN 1 AND 25
    ),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE TABLE book_page_preview_pages (
    book_id INTEGER NOT NULL,
    page_id INTEGER NOT NULL,
    PRIMARY KEY (book_id, page_id),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (page_id) REFERENCES notes(id) ON DELETE CASCADE
);

-- A Page selection belongs to the Book that owned the Page when it was saved.
-- Chapter/direct moves within that Book retain the selection; cross-Book moves
-- remove it and intentionally do not transfer or later resurrect it.
CREATE TRIGGER book_page_preview_pages_remove_after_book_move
AFTER UPDATE OF book_id ON notes
WHEN OLD.book_id <> NEW.book_id
BEGIN
    DELETE FROM book_page_preview_pages
    WHERE book_id = OLD.book_id
      AND page_id = OLD.id;
END;
