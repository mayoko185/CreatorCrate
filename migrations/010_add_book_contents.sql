-- Introduce the authoritative Book-level sequence for Chapters and direct Pages.
-- Chapter Pages remain ordered by notes.sort_order within their Chapter and are
-- intentionally not represented here. Item ownership is enforced by the domain
-- layer because SQLite cannot express the required polymorphic relationship.
CREATE TABLE book_contents (
    book_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (book_id, item_type, item_id),
    UNIQUE (book_id, sort_order),
    CONSTRAINT book_contents_item_type CHECK (item_type IN ('chapter', 'page')),
    CONSTRAINT book_contents_sort_order CHECK (sort_order >= 0),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE RESTRICT
);

-- Historical mixed ordering does not exist. Preserve each existing sequence,
-- placing all Chapters before all direct Pages and numbering from zero per Book.
INSERT INTO book_contents (book_id, item_type, item_id, sort_order)
WITH ordered_items AS (
    SELECT
        chapters.book_id,
        'chapter' AS item_type,
        chapters.id AS item_id,
        0 AS item_group,
        chapters.sort_order AS legacy_sort_order
    FROM chapters

    UNION ALL

    SELECT
        notes.book_id,
        'page' AS item_type,
        notes.id AS item_id,
        1 AS item_group,
        notes.sort_order AS legacy_sort_order
    FROM notes
    WHERE notes.chapter_id IS NULL
)
SELECT
    book_id,
    item_type,
    item_id,
    ROW_NUMBER() OVER (
        PARTITION BY book_id
        ORDER BY item_group ASC, legacy_sort_order ASC, item_id ASC
    ) - 1 AS sort_order
FROM ordered_items;
