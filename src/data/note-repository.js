/**
 * Note repository — data-layer CRUD, ordering, and project/asset associations
 * for standalone notes.
 *
 * This repository owns the notes table and its junction tables exclusively and
 * must not be reached through project or asset repositories.
 */

const COLUMNS = ['id', 'chapter_id', 'title', 'content', 'sort_order', 'created_at', 'updated_at'];
const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM notes`;
const HIERARCHY_ORDER = `
  ORDER BY
    books.sort_order ASC,
    books.id ASC,
    chapters.sort_order ASC,
    chapters.id ASC,
    notes.sort_order ASC,
    notes.id ASC
`;
const NOTE_COLUMNS_QUALIFIED = COLUMNS.map((c) => `notes.${c}`).join(', ');

export class NoteError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'NoteError';
    this.code = code;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createNoteRepository(db) {
  const findByIdStmt = db.prepare(`${SELECT_ALL} WHERE id = ?`);
  const findChapterStmt = db.prepare('SELECT id FROM chapters WHERE id = ?');
  const listStmt = db.prepare(`
    SELECT ${NOTE_COLUMNS_QUALIFIED}
    FROM notes
    JOIN chapters ON chapters.id = notes.chapter_id
    JOIN books ON books.id = chapters.book_id
    ${HIERARCHY_ORDER}
  `);
  const listForChapterStmt = db.prepare(
    `${SELECT_ALL} WHERE chapter_id = ? ORDER BY sort_order ASC, id ASC`
  );
  const insertStmt = db.prepare(`
    INSERT INTO notes (chapter_id, title, content, sort_order)
    VALUES (?, ?, ?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const updateStmt = db.prepare(`
    UPDATE notes
    SET title = ?, content = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${COLUMNS.join(', ')}
  `);
  const deleteByIdStmt = db.prepare('DELETE FROM notes WHERE id = ?');
  const maxSortOrderStmt = db.prepare(
    'SELECT MAX(sort_order) AS max_order FROM notes WHERE chapter_id = ?'
  );
  const shiftOrdersStmt = db.prepare(`
    UPDATE notes
    SET sort_order = sort_order + ?
    WHERE chapter_id = ?
  `);
  const moveToChapterStmt = db.prepare(`
    UPDATE notes
    SET chapter_id = ?, sort_order = ?
    WHERE id = ?
    RETURNING ${COLUMNS.join(', ')}
  `);

  function validateExactOrder(chapterId, orderedIds, currentIds) {
    if (!Array.isArray(orderedIds)) {
      throw new NoteError('Note reorder input must be an array.', { code: 'INVALID_INPUT' });
    }

    if (orderedIds.length !== currentIds.length) {
      throw new NoteError(
        `Reorder sequence length ${orderedIds.length} does not match current note count for Chapter ${chapterId}.`,
        { code: 'INVALID_SEQUENCE_LENGTH' }
      );
    }

    const seen = new Set();
    for (const id of orderedIds) {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new NoteError(`Invalid note ID: ${id}.`, { code: 'INVALID_ID' });
      }
      if (seen.has(id)) {
        throw new NoteError(`Duplicate note ID: ${id}.`, { code: 'DUPLICATE_ID' });
      }
      seen.add(id);
    }

    const currentSet = new Set(currentIds);
    for (const id of orderedIds) {
      if (!currentSet.has(id)) {
        throw new NoteError(`Note ID ${id} does not exist for Chapter ${chapterId}.`, {
          code: 'UNKNOWN_ID',
        });
      }
    }
  }

  function rewriteChapterOrder(chapterId, orderedRows) {
    if (orderedRows.length === 0) return;

    const maxSortOrder = Math.max(...orderedRows.map((row) => row.sort_order));
    const temporaryOffset = maxSortOrder + orderedRows.length + 1;
    const shifted = shiftOrdersStmt.run(temporaryOffset, chapterId);
    if (shifted.changes !== orderedRows.length) {
      throw new NoteError(
        `Reorder preparation affected ${shifted.changes} rows, expected ${orderedRows.length}.`,
        { code: 'UPDATE_CHANGES_MISMATCH' }
      );
    }

    const whenClauses = orderedRows.map(() => 'WHEN ? THEN ?').join(' ');
    const setFinalOrderStmt = db.prepare(`
      UPDATE notes
      SET sort_order = CASE id ${whenClauses} ELSE sort_order END
      WHERE chapter_id = ?
    `);
    const finalOrderParams = [];
    for (let index = 0; index < orderedRows.length; index++) {
      finalOrderParams.push(orderedRows[index].id, index);
    }
    finalOrderParams.push(chapterId);

    const finalized = setFinalOrderStmt.run(...finalOrderParams);
    if (finalized.changes !== orderedRows.length) {
      throw new NoteError(
        `Reorder finalization affected ${finalized.changes} rows, expected ${orderedRows.length}.`,
        { code: 'UPDATE_CHANGES_MISMATCH' }
      );
    }
  }

  function compactChapterOrder(chapterId) {
    rewriteChapterOrder(chapterId, listForChapterStmt.all(chapterId));
  }

  const reorderTx = db.transaction((chapterId, orderedIds) => {
    const current = listForChapterStmt.all(chapterId);
    const currentIds = current.map((row) => row.id);

    validateExactOrder(chapterId, orderedIds, currentIds);
    const currentById = new Map(current.map((row) => [row.id, row]));
    rewriteChapterOrder(chapterId, orderedIds.map((id) => currentById.get(id)));
    return listForChapterStmt.all(chapterId);
  });

  const deleteAndCompactTx = db.transaction((id) => {
    const note = findByIdStmt.get(id);
    if (!note) return false;

    const deleted = deleteByIdStmt.run(id);
    if (deleted.changes !== 1) {
      throw new NoteError(`Note ${id} could not be deleted.`, { code: 'DELETE_CHANGES_MISMATCH' });
    }

    compactChapterOrder(note.chapter_id);
    return true;
  });

  const moveToChapterTx = db.transaction((noteId, targetChapterId) => {
    const note = findByIdStmt.get(noteId);
    if (!note) return undefined;

    if (!findChapterStmt.get(targetChapterId)) {
      throw new NoteError(`Chapter ${targetChapterId} does not exist.`, {
        code: 'TARGET_CHAPTER_NOT_FOUND',
      });
    }

    if (note.chapter_id === targetChapterId) return note;

    const { max_order: maxOrder } = maxSortOrderStmt.get(targetChapterId);
    const sortOrder = maxOrder === null ? 0 : maxOrder + 1;
    const moved = moveToChapterStmt.get(targetChapterId, sortOrder, noteId);
    compactChapterOrder(note.chapter_id);
    return moved;
  });

  // ─── Association statements ──────────────────────────────────────────────

  const findNoteStmt = db.prepare('SELECT id FROM notes WHERE id = ?');
  const findProjectStmt = db.prepare('SELECT id FROM projects WHERE id = ?');
  const findAssetStmt = db.prepare('SELECT id FROM assets WHERE id = ?');

  const insertNoteProjectStmt = db.prepare(`
    INSERT INTO note_projects (note_id, project_id)
    VALUES (?, ?)
    ON CONFLICT(note_id, project_id) DO NOTHING
  `);
  const deleteNoteProjectStmt = db.prepare(
    'DELETE FROM note_projects WHERE note_id = ? AND project_id = ?'
  );
  const clearNoteProjectsStmt = db.prepare(
    'DELETE FROM note_projects WHERE note_id = ?'
  );
  const listNoteProjectIdsStmt = db.prepare(
    'SELECT project_id FROM note_projects WHERE note_id = ? ORDER BY project_id ASC'
  );
  const listForProjectStmt = db.prepare(`
    SELECT ${NOTE_COLUMNS_QUALIFIED}
    FROM notes
    JOIN note_projects np ON np.note_id = notes.id
    JOIN chapters ON chapters.id = notes.chapter_id
    JOIN books ON books.id = chapters.book_id
    WHERE np.project_id = ?
    ${HIERARCHY_ORDER}
  `);

  const insertNoteAssetStmt = db.prepare(`
    INSERT INTO note_assets (note_id, asset_id)
    VALUES (?, ?)
    ON CONFLICT(note_id, asset_id) DO NOTHING
  `);
  const deleteNoteAssetStmt = db.prepare(
    'DELETE FROM note_assets WHERE note_id = ? AND asset_id = ?'
  );
  const clearNoteAssetsStmt = db.prepare(
    'DELETE FROM note_assets WHERE note_id = ?'
  );
  const listNoteAssetIdsStmt = db.prepare(
    'SELECT asset_id FROM note_assets WHERE note_id = ? ORDER BY asset_id ASC'
  );
  const listForAssetStmt = db.prepare(`
    SELECT ${NOTE_COLUMNS_QUALIFIED}
    FROM notes
    JOIN note_assets na ON na.note_id = notes.id
    JOIN chapters ON chapters.id = notes.chapter_id
    JOIN books ON books.id = chapters.book_id
    WHERE na.asset_id = ?
    ${HIERARCHY_ORDER}
  `);

  function replaceProjectsInTransaction(noteId, projectIds) {
    if (!Array.isArray(projectIds)) {
      throw new NoteError('Project IDs must be an array.', { code: 'INVALID_INPUT' });
    }
    if (!findNoteStmt.get(noteId)) {
      return undefined;
    }

    const desiredProjectIds = [...new Set(projectIds)];
    const currentProjectIds = listNoteProjectIdsStmt.all(noteId).map((row) => row.project_id);
    const currentSet = new Set(currentProjectIds);
    const desiredSet = new Set(desiredProjectIds);

    for (const projectId of currentProjectIds) {
      if (!desiredSet.has(projectId)) {
        deleteNoteProjectStmt.run(noteId, projectId);
      }
    }
    for (const projectId of desiredProjectIds) {
      if (!currentSet.has(projectId)) {
        insertNoteProjectStmt.run(noteId, projectId);
      }
    }

    return listNoteProjectIdsStmt.all(noteId).map((row) => row.project_id);
  }

  const replaceProjectsTx = db.transaction(replaceProjectsInTransaction);

  function replaceAssetsInTransaction(noteId, assetIds) {
    if (!Array.isArray(assetIds)) {
      throw new NoteError('Asset IDs must be an array.', { code: 'INVALID_INPUT' });
    }
    if (!findNoteStmt.get(noteId)) {
      return undefined;
    }

    const desiredAssetIds = [...new Set(assetIds)];
    const currentAssetIds = listNoteAssetIdsStmt.all(noteId).map((row) => row.asset_id);
    const currentSet = new Set(currentAssetIds);
    const desiredSet = new Set(desiredAssetIds);

    for (const assetId of currentAssetIds) {
      if (!desiredSet.has(assetId)) {
        deleteNoteAssetStmt.run(noteId, assetId);
      }
    }
    for (const assetId of desiredAssetIds) {
      if (!currentSet.has(assetId)) {
        insertNoteAssetStmt.run(noteId, assetId);
      }
    }

    return listNoteAssetIdsStmt.all(noteId).map((row) => row.asset_id);
  }

  const replaceAssetsTx = db.transaction(replaceAssetsInTransaction);

  function createNote(input = {}) {
    const { chapterId } = input;
    const result = maxSortOrderStmt.get(chapterId);
    const sortOrder = result.max_order === null ? 0 : result.max_order + 1;
    const title = typeof input.title === 'string' ? input.title : '';
    const content = typeof input.content === 'string' ? input.content : '';
    return insertStmt.get(chapterId, title, content, sortOrder);
  }

  function updateNote(id, input = {}) {
    const existing = findByIdStmt.get(id);
    if (!existing) return undefined;
    const title = typeof input.title === 'string' ? input.title : existing.title;
    const content = typeof input.content === 'string' ? input.content : existing.content;
    return updateStmt.get(title, content, id);
  }

  const saveWithAssociationsTx = db.transaction(({
    id, chapterId, title, content, projectIds, assetIds,
  } = {}) => {
    if (!Array.isArray(projectIds)) {
      throw new NoteError('Project IDs must be an array.', { code: 'INVALID_INPUT' });
    }
    if (!Array.isArray(assetIds)) {
      throw new NoteError('Asset IDs must be an array.', { code: 'INVALID_INPUT' });
    }

    const note = id === undefined
      ? createNote({ chapterId, title, content })
      : updateNote(id, { title, content });

    if (!note) return undefined;

    return {
      note,
      projectIds: replaceProjectsInTransaction(note.id, projectIds),
      assetIds: replaceAssetsInTransaction(note.id, assetIds),
    };
  });

  return {
    /**
     * Create a note, appending it after the current highest Chapter-local sort_order.
     *
     * @param {{ chapterId: number, title?: string, content?: string }} input
     * @returns {{ id: number, chapter_id: number, title: string, content: string, sort_order: number, created_at: string, updated_at: string }}
     */
    create(input = {}) {
      return createNote(input);
    },

    /**
     * @param {number} id
     * @returns {{ id: number, chapter_id: number, title: string, content: string, sort_order: number, created_at: string, updated_at: string }|undefined}
     */
    findById(id) {
      return findByIdStmt.get(id);
    },

    /**
     * List all Notes in deterministic hierarchy order. This is a temporary
     * compatibility method for the flat Notes service and has no global
     * sort_order meaning.
     *
     * @returns {Array<{ id: number, chapter_id: number, title: string, content: string, sort_order: number, created_at: string, updated_at: string }>}
     */
    list() {
      return listStmt.all();
    },

    /**
     * List Notes in one Chapter by local manual order.
     *
     * @param {number} chapterId
     * @returns {Array<{ id: number, chapter_id: number, title: string, content: string, sort_order: number, created_at: string, updated_at: string }>}
     */
    listForChapter(chapterId) {
      return listForChapterStmt.all(chapterId);
    },

    /**
     * Update a note's title and/or content. Only supplied fields are changed;
     * the other field keeps its current value. `updated_at` is always refreshed.
     *
     * @param {number} id
     * @param {{ title?: string, content?: string }} input
     * @returns {{ id: number, chapter_id: number, title: string, content: string, sort_order: number, created_at: string, updated_at: string }|undefined}
     */
    update(id, input = {}) {
      return updateNote(id, input);
    },

    /**
     * @param {number} id
     * @returns {boolean} true when a Note row was deleted and its source Chapter compacted
     */
    deleteById(id) {
      return deleteAndCompactTx(id);
    },

    /**
     * Persist a complete Chapter-local reorder. `orderedIds` must be an exact
     * permutation of the Notes in `chapterId`; positions are rewritten to
     * contiguous 0..n-1 values in the given order. Throws NoteError with
     * INVALID_INPUT, INVALID_SEQUENCE_LENGTH, INVALID_ID, DUPLICATE_ID,
     * UNKNOWN_ID, or UPDATE_CHANGES_MISMATCH when it cannot complete.
     *
     * @param {number} chapterId
     * @param {number[]} orderedIds
     * @returns {Array<{ id: number, chapter_id: number, title: string, content: string, sort_order: number, created_at: string, updated_at: string }>}
     */
    reorder(chapterId, orderedIds) {
      return reorderTx(chapterId, orderedIds);
    },

    /**
     * Move a Note to the end of another Chapter without changing content
     * timestamps or associations. Returns undefined for a missing Note;
     * throws NoteError with TARGET_CHAPTER_NOT_FOUND for a missing destination.
     * Moving to the current Chapter is a no-op and returns the unchanged Note.
     *
     * @param {number} noteId
     * @param {number} targetChapterId
     * @returns {{ id: number, chapter_id: number, title: string, content: string, sort_order: number, created_at: string, updated_at: string }|undefined}
     */
    moveToChapter(noteId, targetChapterId) {
      return moveToChapterTx(noteId, targetChapterId);
    },

    /**
     * Persist a note mutation and its complete project/asset associations in
     * one transaction. An omitted id creates a note; a supplied id updates it.
     *
     * @param {{ id?: number, chapterId?: number, title?: string, content?: string, projectIds: number[], assetIds: number[] }} input
     * @returns {{ note: object, projectIds: number[], assetIds: number[] }|undefined}
     */
    saveWithAssociations(input) {
      return saveWithAssociationsTx(input);
    },

    // ─── Project associations ─────────────────────────────────────────────

    /**
     * Replace all project associations for a note atomically. Duplicate input
     * IDs are deduplicated. Foreign-key violations (nonexistent note or project)
     * roll back the entire transaction.
     *
     * @param {number} noteId
     * @param {number[]} projectIds
     * @returns {number[]|undefined} resulting project IDs, or undefined if the note does not exist
     */
    replaceProjects(noteId, projectIds) {
      return replaceProjectsTx(noteId, projectIds);
    },

    /**
     * List the project IDs associated with a note in ascending order.
     *
     * @param {number} noteId
     * @returns {number[]}
     */
    listProjectsForNote(noteId) {
      return listNoteProjectIdsStmt.all(noteId).map((row) => row.project_id);
    },

    /**
     * List all Notes associated with a Project in hierarchy order.
     *
     * @param {number} projectId
     * @returns {Array<{ id: number, chapter_id: number, title: string, content: string, sort_order: number, created_at: string, updated_at: string }>}
     */
    listForProject(projectId) {
      return listForProjectStmt.all(projectId);
    },

    // ─── Asset associations ────────────────────────────────────────────────

    /**
     * Replace all asset associations for a note atomically. Duplicate input
     * IDs are deduplicated. Foreign-key violations (nonexistent note or asset)
     * roll back the entire transaction.
     *
     * @param {number} noteId
     * @param {number[]} assetIds
     * @returns {number[]|undefined} resulting asset IDs, or undefined if the note does not exist
     */
    replaceAssets(noteId, assetIds) {
      return replaceAssetsTx(noteId, assetIds);
    },

    /**
     * List the asset IDs associated with a note in ascending order.
     *
     * @param {number} noteId
     * @returns {number[]}
     */
    listAssetsForNote(noteId) {
      return listNoteAssetIdsStmt.all(noteId).map((row) => row.asset_id);
    },

    /**
     * List all Notes associated with an Asset in hierarchy order.
     *
     * @param {number} assetId
     * @returns {Array<{ id: number, chapter_id: number, title: string, content: string, sort_order: number, created_at: string, updated_at: string }>}
     */
    listForAsset(assetId) {
      return listForAssetStmt.all(assetId);
    },
  };
}
