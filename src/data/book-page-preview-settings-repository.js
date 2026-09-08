export class BookPagePreviewSettingsRepositoryError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BookPagePreviewSettingsRepositoryError';
    this.code = code;
  }
}

const SETTINGS_COLUMNS = ['book_id', 'mode', 'random_count', 'created_at', 'updated_at'];

export function createBookPagePreviewSettingsRepository(db) {
  const findSettingsStmt = db.prepare(`
    SELECT ${SETTINGS_COLUMNS.join(', ')}
    FROM book_page_preview_settings
    WHERE book_id = ?
  `);
  const listSelectedPageIdsStmt = db.prepare(`
    SELECT preview.page_id
    FROM book_page_preview_pages AS preview
    JOIN notes AS page
      ON page.id = preview.page_id
     AND page.book_id = preview.book_id
    WHERE preview.book_id = ?
    ORDER BY preview.page_id ASC
  `);
  const upsertSettingsStmt = db.prepare(`
    INSERT INTO book_page_preview_settings (book_id, mode, random_count)
    VALUES (?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET
      mode = excluded.mode,
      random_count = excluded.random_count,
      updated_at = datetime('now')
  `);
  const clearSelectedPagesStmt = db.prepare(`
    DELETE FROM book_page_preview_pages
    WHERE book_id = ?
  `);
  const insertOwnedPageStmt = db.prepare(`
    INSERT INTO book_page_preview_pages (book_id, page_id)
    SELECT ?, id
    FROM notes
    WHERE id = ? AND book_id = ?
  `);

  function read(bookId) {
    const settings = findSettingsStmt.get(bookId);
    if (!settings) return undefined;
    return {
      ...settings,
      selected_page_ids: listSelectedPageIdsStmt.pluck().all(bookId),
    };
  }

  const replaceTx = db.transaction((bookId, { mode, randomCount, selectedPageIds }) => {
    upsertSettingsStmt.run(bookId, mode, randomCount);
    clearSelectedPagesStmt.run(bookId);

    for (const pageId of selectedPageIds) {
      if (insertOwnedPageStmt.run(bookId, pageId, bookId).changes !== 1) {
        throw new BookPagePreviewSettingsRepositoryError(
          `Page ${pageId} does not belong to Book ${bookId}.`,
          { code: 'PAGE_NOT_IN_BOOK' },
        );
      }
    }

    return read(bookId);
  });

  return {
    findByBookId(bookId) {
      return read(bookId);
    },

    replace(bookId, settings) {
      return replaceTx(bookId, settings);
    },
  };
}
