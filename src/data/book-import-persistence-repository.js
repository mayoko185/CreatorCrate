const BOOK_COLUMNS = ['id', 'title', 'sort_order', 'created_at', 'updated_at'];
const CHAPTER_COLUMNS = ['id', 'book_id', 'title', 'sort_order', 'created_at', 'updated_at'];
const PAGE_COLUMNS = [
  'id', 'book_id', 'chapter_id', 'title', 'content', 'sort_order', 'created_at', 'updated_at',
];
const REVISION_COLUMNS = [
  'id', 'note_id', 'title', 'content', 'project_ids_json', 'asset_ids_json',
  'source_updated_at', 'created_at',
];

/**
 * Import-only write primitives. Transaction ownership deliberately remains with
 * the persistence service so one archive is committed or rolled back as a unit.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function createBookImportPersistenceRepository(db) {
  const listBookTitlesStmt = db.prepare(
    'SELECT title FROM books ORDER BY sort_order ASC, id ASC',
  );
  const maxBookSortOrderStmt = db.prepare('SELECT MAX(sort_order) AS max_order FROM books');
  const insertBookStmt = db.prepare(`
    INSERT INTO books (title, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    RETURNING ${BOOK_COLUMNS.join(', ')}
  `);
  const insertChapterStmt = db.prepare(`
    INSERT INTO chapters (book_id, title, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    RETURNING ${CHAPTER_COLUMNS.join(', ')}
  `);
  const insertPageStmt = db.prepare(`
    INSERT INTO notes (
      book_id, chapter_id, title, content, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING ${PAGE_COLUMNS.join(', ')}
  `);
  const insertBookContentStmt = db.prepare(`
    INSERT INTO book_contents (book_id, item_type, item_id, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  const insertRevisionStmt = db.prepare(`
    INSERT INTO note_revisions (
      note_id, title, content, project_ids_json, asset_ids_json,
      source_updated_at, created_at
    ) VALUES (?, ?, ?, '[]', '[]', ?, ?)
    RETURNING ${REVISION_COLUMNS.join(', ')}
  `);
  const insertPreviewSettingsStmt = db.prepare(`
    INSERT INTO book_page_preview_settings (book_id, mode, random_count)
    VALUES (?, ?, ?)
  `);
  const insertPreviewPageStmt = db.prepare(`
    INSERT INTO book_page_preview_pages (book_id, page_id)
    SELECT ?, id
    FROM notes
    WHERE id = ? AND book_id = ?
  `);

  return {
    listBookTitles() {
      return listBookTitlesStmt.pluck().all();
    },

    nextBookSortOrder() {
      const { max_order: maxOrder } = maxBookSortOrderStmt.get();
      return maxOrder === null ? 0 : maxOrder + 1;
    },

    insertBook({ title, sortOrder, createdAt, updatedAt }) {
      return insertBookStmt.get(title, sortOrder, createdAt, updatedAt);
    },

    insertChapter({ bookId, title, sortOrder, createdAt, updatedAt }) {
      return insertChapterStmt.get(bookId, title, sortOrder, createdAt, updatedAt);
    },

    insertPage({ bookId, chapterId, title, content, sortOrder, createdAt, updatedAt }) {
      return insertPageStmt.get(
        bookId, chapterId, title, content, sortOrder, createdAt, updatedAt,
      );
    },

    insertBookContent({ bookId, itemType, itemId, sortOrder }) {
      return insertBookContentStmt.run(bookId, itemType, itemId, sortOrder);
    },

    insertRevision({ noteId, title, content, sourceUpdatedAt, createdAt }) {
      return insertRevisionStmt.get(noteId, title, content, sourceUpdatedAt, createdAt);
    },

    insertPreviewSettings({ bookId, mode, randomCount }) {
      return insertPreviewSettingsStmt.run(bookId, mode, randomCount);
    },

    insertPreviewPage({ bookId, pageId }) {
      return insertPreviewPageStmt.run(bookId, pageId, bookId);
    },
  };
}
