import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { disableAuthState, enableAuthState, ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createBookContentRepository } from '../src/data/book-content-repository.js';
import { createBookPagePreviewSettingsRepository } from '../src/data/book-page-preview-settings-repository.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createChapterRepository } from '../src/data/chapter-repository.js';
import {
  createNoteDeletionSnapshotRepository,
  invalidateNoteDeletionSnapshotsForRestore,
} from '../src/data/note-deletion-snapshot-repository.js';
import { createNoteRepository } from '../src/data/note-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { deriveDisabledModeCsrfToken } from '../src/middleware/csrf.js';
import { createBackupService } from '../src/services/backup-service.js';
import { beginReplacementMaintenance } from '../src/services/managed-upload-tracker.js';
import {
  createNoteDeletionId,
  createNoteService,
  NOTE_DELETION_UNDO_WINDOW_MS,
  NoteDeletionUndoError,
  NoteNotFoundError,
  NoteOperationError,
  NoteValidationError,
} from '../src/services/note-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const SECRET = 'a'.repeat(64);
const T0 = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('Page deletion Undo', () => {
  let tmpDir;
  let dbPath;
  let db;
  let clock;
  let logInfo;
  let service;
  let ownerKey;
  let ids;

  function makeService(connection = db, overrides = {}) {
    return createNoteService({
      db: connection,
      noteRepository: createNoteRepository(connection),
      projectRepository: createProjectRepository(connection),
      assetRepository: createAssetRepository(connection),
      chapterRepository: createChapterRepository(connection),
      bookRepository: createBookRepository(connection),
      bookContentRepository: createBookContentRepository(connection),
      bookPagePreviewSettingsRepository: createBookPagePreviewSettingsRepository(connection),
      noteDeletionSnapshotRepository: createNoteDeletionSnapshotRepository(connection),
      noteDeletionUndoSecret: SECRET,
      applicationLogger: { info: logInfo },
      noteRevisionSettingsService: { getRevisionRetention: () => 10 },
      now: () => clock.value,
      ...overrides,
    });
  }

  function insertProject(title) {
    return Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
      VALUES (?, ?, '', '', 'tbd', 'images', NULL)
    `).run(title, title.toLowerCase()).lastInsertRowid);
  }

  function insertAsset(projectId, name) {
    return createAssetRepository(db).upsert(projectId, `${name}.png`, {
      filename: `${name}.png`, extension: '.png', mimeType: 'image/png', sizeBytes: 1,
    }).id;
  }

  function seed() {
    const books = createBookRepository(db);
    const chapters = createChapterRepository(db);
    const contents = createBookContentRepository(db);
    const bookId = Number(db.prepare(
      "INSERT INTO books (title, sort_order) VALUES ('Book', 0)"
    ).run().lastInsertRowid);
    expect(books.findById(bookId).created_at).toBeTruthy();

    const chapterId = chapters.create({ bookId, title: 'Chapter' }).id;
    contents.append(bookId, 'chapter', chapterId);
    const otherChapterId = chapters.create({ bookId, title: 'Other' }).id;
    contents.append(bookId, 'chapter', otherChapterId);
    expect(chapters.findById(chapterId).created_at).toBeTruthy();

    const projectId = insertProject('Linked');
    const assetId = insertAsset(projectId, 'linked');

    const first = service.createNote({ bookId, chapterId, title: 'First', content: 'first' }).id;
    const target = service.createNote({
      bookId, chapterId, title: 'Target', content: '# raw\n\n  markdown  ', projectIds: [projectId], assetIds: [assetId],
    }).id;
    const last = service.createNote({ bookId, chapterId, title: 'Last', content: 'last' }).id;
    const otherPage = service.createNote({ bookId, chapterId: otherChapterId, title: 'Elsewhere', content: 'x' }).id;

    service.updateNote(target, { title: 'Target v2', content: 'second' });
    service.updateNote(target, { title: 'Target v3', content: 'third', projectIds: [], assetIds: [] });
    service.updateNote(target, { title: 'Target', content: '# raw\n\n  markdown  ', projectIds: [projectId], assetIds: [assetId] });

    const directFirst = service.createNote({ bookId, title: 'Direct 1', content: 'd1' }).id;
    const direct = service.createNote({ bookId, title: 'Direct 2', content: 'd2' }).id;
    const directLast = service.createNote({ bookId, title: 'Direct 3', content: 'd3' }).id;
    const empty = service.createNote({ bookId, chapterId: otherChapterId, title: 'Empty', content: '' }).id;

    // Distinct timestamps prove that restore keeps rather than regenerates them.
    db.prepare(`
      UPDATE notes SET created_at = '2001-02-03 04:05:06', updated_at = '2002-03-04 05:06:07' WHERE id = ?
    `).run(target);

    return {
      bookId, chapterId, otherChapterId, projectId, assetId,
      first, target, last, otherPage, directFirst, direct, directLast, empty,
    };
  }

  function selectPreview(pageIds) {
    createBookPagePreviewSettingsRepository(db).replace(ids.bookId, {
      mode: 'selected', randomCount: 3, selectedPageIds: pageIds,
    });
  }

  function liveState(noteId, bookId = ids.bookId) {
    return {
      note: db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId),
      revisions: db.prepare('SELECT * FROM note_revisions WHERE note_id = ? ORDER BY id').all(noteId),
      projects: db.prepare('SELECT * FROM note_projects WHERE note_id = ? ORDER BY project_id').all(noteId),
      assets: db.prepare('SELECT * FROM note_assets WHERE note_id = ? ORDER BY asset_id').all(noteId),
      preview: db.prepare('SELECT * FROM book_page_preview_pages WHERE book_id = ? ORDER BY page_id').all(bookId),
      contents: db.prepare('SELECT * FROM book_contents WHERE book_id = ? ORDER BY sort_order').all(bookId),
      allNotes: db.prepare('SELECT * FROM notes ORDER BY id').all(),
    };
  }

  function snapshotRow(deletionId) {
    return db.prepare('SELECT * FROM note_deletion_snapshots WHERE id = ?').get(deletionId);
  }

  function del(noteId, { owner = ownerKey, svc = service } = {}) {
    return svc.deleteNoteWithUndo(noteId, { deletionId: createNoteDeletionId(), ownerKey: owner });
  }

  function restore(receipt, { svc = service } = {}) {
    return svc.restoreDeletedNote(receipt.deletionId, { ownerKey, undoToken: receipt.undoToken });
  }

  function expectRefusal(receipt, code, options) {
    const before = liveState(receipt.noteId);
    const row = snapshotRow(receipt.deletionId);
    let thrown;
    try {
      restore(receipt, options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NoteDeletionUndoError);
    expect(thrown.code).toBe(code);
    expect(liveState(receipt.noteId)).toEqual(before);
    expect(snapshotRow(receipt.deletionId)).toEqual(row);
  }

  function events() {
    return logInfo.mock.calls.map(([entry]) => entry.event);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-undo-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    clock = { value: T0 };
    logInfo = vi.fn();
    service = makeService();
    ownerKey = service.deriveNoteDeletionOwnerKey({ kind: 'session', identity: 'session-a' });
    ids = seed();
    logInfo.mockClear();
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('deleteNoteWithUndo', () => {
    it('deletes a Chapter Page and captures every raw row in one durable snapshot', () => {
      selectPreview([ids.target, ids.first]);
      const before = liveState(ids.target);
      expect(before.revisions).toHaveLength(3);

      const receipt = del(ids.target);

      expect(receipt).toMatchObject({
        noteId: ids.target,
        bookId: ids.bookId,
        chapterId: ids.chapterId,
        status: 'available',
        createdAt: T0,
        expiresAt: T0 + NOTE_DELETION_UNDO_WINDOW_MS,
      });
      expect(receipt.undoToken).toMatch(/^[0-9a-f]{64}$/);

      const after = liveState(ids.target);
      expect(after.note).toBeUndefined();
      expect(after.revisions).toEqual([]);
      expect(after.projects).toEqual([]);
      expect(after.assets).toEqual([]);

      const row = snapshotRow(receipt.deletionId);
      expect(row).toMatchObject({
        owner_key: ownerKey,
        note_id: ids.target,
        book_id: ids.bookId,
        chapter_id: ids.chapterId,
        created_at: T0,
        expires_at: T0 + NOTE_DELETION_UNDO_WINDOW_MS,
        restored_at: null,
        snapshot_version: 1,
      });
      const snapshot = JSON.parse(row.snapshot_json);
      expect(snapshot.graph.note).toEqual(before.note);
      expect(snapshot.graph.revisions).toEqual(before.revisions);
      expect(snapshot.graph.projectIds).toEqual([ids.projectId]);
      expect(snapshot.graph.assetIds).toEqual([ids.assetId]);
      expect(snapshot.before.pageSelected).toBe(true);
      expect(snapshot.before.pageOrder.map((p) => p.id)).toEqual([ids.first, ids.target, ids.last]);
      expect(snapshot.after.pageOrder).toEqual([
        { id: ids.first, sort_order: 0 },
        { id: ids.last, sort_order: 1 },
      ]);
      expect(snapshot.after.preview).toEqual({ mode: 'selected', selectedPageIds: [ids.first] });
      expect(snapshot.parent.bookCreatedAt).toBeTruthy();
      expect(snapshot.parent.chapterCreatedAt).toBeTruthy();
      expect(snapshot.before.bookContents).toBeNull();
    });

    it('captures the typed membership and root order of a direct Book Page', () => {
      const contentsBefore = liveState(ids.direct).contents;
      const receipt = del(ids.direct);
      const snapshot = JSON.parse(snapshotRow(receipt.deletionId).snapshot_json);

      expect(receipt.chapterId).toBeNull();
      expect(snapshot.before.bookContents).toEqual(contentsBefore);
      expect(liveState(ids.direct).contents.map((row) => row.sort_order)).toEqual([0, 1, 2, 3]);
      expect(snapshot.after.bookContents.some((row) => row.item_id === ids.direct && row.item_type === 'page')).toBe(false);
    });

    it('handles an empty Page with no history', () => {
      const receipt = del(ids.empty);
      expect(JSON.parse(snapshotRow(receipt.deletionId).snapshot_json).graph.revisions).toEqual([]);
      restore(receipt);
      expect(service.getNote(ids.empty).content).toBe('');
    });

    it('logs deletion only after commit, without secrets', () => {
      const receipt = del(ids.target);
      expect(events()).toEqual(['note.deleted']);
      const logged = JSON.stringify(logInfo.mock.calls);
      expect(logged).not.toContain(receipt.undoToken);
      expect(logged).not.toContain(receipt.deletionId);
      expect(logged).not.toContain(ownerKey);
      expect(logged).not.toContain('markdown');
    });

    it('keeps no token, secret or owner identity in the snapshot payload', () => {
      const receipt = del(ids.target);
      const { snapshot_json: json } = snapshotRow(receipt.deletionId);
      for (const secretValue of [SECRET, receipt.undoToken, ownerKey, 'session-a']) {
        expect(json).not.toContain(secretValue);
      }
    });

    it('rolls the deletion back when the snapshot cannot be stored', () => {
      selectPreview([ids.target]);
      const before = liveState(ids.target);
      db.exec(`
        CREATE TRIGGER fail_snapshot BEFORE INSERT ON note_deletion_snapshots
        BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END;
      `);

      const deletionId = createNoteDeletionId();
      let thrown;
      try {
        service.deleteNoteWithUndo(ids.target, { deletionId, ownerKey });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NoteOperationError);
      expect(thrown.code).toBe('UNDO_OPERATION_FAILED');
      expect(thrown.message).not.toContain('injected');
      expect(liveState(ids.target)).toEqual(before);
      expect(snapshotRow(deletionId)).toBeUndefined();
      expect(events()).toEqual([]);
    });

    it('leaves no recovery opportunity when the deletion itself fails', () => {
      const before = liveState(ids.direct);
      db.exec(`
        CREATE TRIGGER fail_delete BEFORE DELETE ON book_contents
        BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;
      `);

      expect(() => del(ids.direct)).toThrow(NoteOperationError);

      expect(liveState(ids.direct)).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS c FROM note_deletion_snapshots').get().c).toBe(0);
      expect(events()).toEqual([]);
    });

    it('rejects a reused deletion ID without deleting', () => {
      const receipt = del(ids.target);
      expect(() => service.deleteNoteWithUndo(ids.first, {
        deletionId: receipt.deletionId,
        ownerKey,
      })).toThrow(expect.objectContaining({ code: 'UNDO_DELETION_ID_CONFLICT' }));
      expect(service.getNote(ids.first).id).toBe(ids.first);
    });

    it('validates its trusted inputs and a missing Page', () => {
      expect(() => service.deleteNoteWithUndo(ids.first, { deletionId: 'short', ownerKey }))
        .toThrow(NoteValidationError);
      expect(() => service.deleteNoteWithUndo(ids.first, { deletionId: createNoteDeletionId(), ownerKey: 'user' }))
        .toThrow(NoteValidationError);
      expect(() => service.deleteNoteWithUndo(ids.first)).toThrow(NoteValidationError);
      expect(() => del(999999)).toThrow(NoteNotFoundError);
    });

    it('keeps ordinary deleteNote compatible and snapshot-free', () => {
      expect(service.deleteNote(ids.target)).toBe(true);
      expect(service.deleteNote(ids.direct)).toBe(true);
      expect(() => service.deleteNote(ids.target)).toThrow(NoteNotFoundError);
      expect(db.prepare('SELECT COUNT(*) AS c FROM note_deletion_snapshots').get().c).toBe(0);
      expect(events()).toEqual(['note.deleted', 'note.deleted']);
      expect(createNoteRepository(db).listForChapter(ids.chapterId).map((p) => p.sort_order)).toEqual([0, 1]);
    });

    it('is unavailable, not silently insecure, without a secret', () => {
      const unconfigured = makeService(db, { noteDeletionUndoSecret: undefined });
      expect(unconfigured.isNoteDeletionUndoConfigured()).toBe(false);
      for (const call of [
        () => unconfigured.deleteNoteWithUndo(ids.first, { deletionId: createNoteDeletionId(), ownerKey }),
        () => unconfigured.restoreDeletedNote(createNoteDeletionId(), { ownerKey, undoToken: 'x' }),
        () => unconfigured.getNoteDeletionUndo(createNoteDeletionId(), { ownerKey }),
        () => unconfigured.issueNoteDeletionUndoAction(createNoteDeletionId(), { ownerKey }),
        () => unconfigured.deriveNoteDeletionOwnerKey({ kind: 'session', identity: 'a' }),
      ]) {
        expect(call).toThrow(expect.objectContaining({ code: 'UNDO_NOT_CONFIGURED' }));
      }
      expect(service.getNote(ids.first).id).toBe(ids.first);
    });

    it.each([
      ['signing secret', { noteDeletionUndoSecret: undefined }],
      ['empty signing secret', { noteDeletionUndoSecret: '' }],
      ['snapshot repository', { noteDeletionSnapshotRepository: null }],
    ])('refuses the deletion and changes nothing without a %s', (_label, overrides) => {
      selectPreview([ids.target]);
      const unconfigured = makeService(db, overrides);
      const before = liveState(ids.target);
      expect(before.revisions.length).toBeGreaterThan(0);
      expect(before.projects).toHaveLength(1);
      expect(before.assets).toHaveLength(1);
      const siblings = createNoteRepository(db).listForChapter(ids.chapterId);

      let thrown;
      try {
        unconfigured.deleteNoteWithUndo(ids.target, { deletionId: createNoteDeletionId(), ownerKey });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NoteOperationError);
      expect(thrown.code).toBe('UNDO_NOT_CONFIGURED');
      expect(thrown.message).toBe('Page deletion Undo is not configured.');
      expect(liveState(ids.target)).toEqual(before);
      expect(createNoteRepository(db).listForChapter(ids.chapterId)).toEqual(siblings);
      expect(db.prepare('SELECT COUNT(*) AS c FROM note_deletion_snapshots').get().c).toBe(0);
      expect(events()).toEqual([]);

      // The intentional legacy API is untouched, and is never a hidden fallback.
      expect(unconfigured.deleteNote(ids.target)).toBe(true);
      expect(unconfigured.getNote(ids.first).id).toBe(ids.first);
      expect(() => unconfigured.getNote(ids.target)).toThrow(NoteNotFoundError);
      expect(db.prepare('SELECT COUNT(*) AS c FROM note_deletion_snapshots').get().c).toBe(0);
      expect(events()).toEqual(['note.deleted']);
    });
  });

  describe('restoreDeletedNote', () => {
    it('restores a Chapter Page exactly, with original IDs, history, links and order', () => {
      selectPreview([ids.target, ids.first]);
      const before = liveState(ids.target);
      const receipt = del(ids.target);
      logInfo.mockClear();

      const result = restore(receipt);

      expect(result).toEqual({
        deletionId: receipt.deletionId,
        noteId: ids.target,
        bookId: ids.bookId,
        chapterId: ids.chapterId,
        status: 'restored',
        restoredAt: T0,
      });
      expect(liveState(ids.target)).toEqual(before);
      expect(before.note.content).toBe('# raw\n\n  markdown  ');
      expect(before.note.created_at).toBe('2001-02-03 04:05:06');
      expect(before.note.updated_at).toBe('2002-03-04 05:06:07');
      expect(events()).toEqual(['note.deletion_undone']);
    });

    it('restores a direct Book Page with its root position', () => {
      const before = liveState(ids.direct);
      restore(del(ids.direct));
      expect(liveState(ids.direct)).toEqual(before);
    });

    it('keeps the raw payload of a malformed historical revision', () => {
      const revisionId = liveState(ids.target).revisions[0].id;
      db.prepare("UPDATE note_revisions SET project_ids_json = '[9999, 1]' WHERE id = ?").run(revisionId);
      const before = liveState(ids.target);
      restore(del(ids.target));
      expect(liveState(ids.target)).toEqual(before);
    });

    it('does not block on historical IDs that no longer exist', () => {
      const revisionId = liveState(ids.target).revisions[0].id;
      db.prepare("UPDATE note_revisions SET asset_ids_json = '[424242]' WHERE id = ?").run(revisionId);
      expect(restore(del(ids.target)).status).toBe('restored');
    });

    it('ignores unrelated sibling edits and changes in other Chapters', () => {
      const receipt = del(ids.target);
      service.updateNote(ids.first, { title: 'Renamed sibling', content: 'edited' });
      const editedSibling = db.prepare('SELECT * FROM notes WHERE id = ?').get(ids.first);
      service.createNote({ bookId: ids.bookId, chapterId: ids.otherChapterId, title: 'New', content: '' });

      restore(receipt);

      expect(db.prepare('SELECT * FROM notes WHERE id = ?').get(ids.first)).toEqual({
        ...editedSibling, sort_order: 0,
      });
      expect(createNoteRepository(db).listForChapter(ids.chapterId).map((p) => p.id))
        .toEqual([ids.first, ids.target, ids.last]);
    });

    it('allows undoing two deletions in reverse order, and refuses the out-of-order one', () => {
      const before = liveState(ids.target);
      const first = del(ids.target);
      const second = del(ids.first);

      expectRefusal(first, 'UNDO_ORDER_CHANGED');
      restore(second);
      restore(first);

      expect(liveState(ids.target)).toEqual(before);
    });

    it('creates no revision and keeps future IDs new', () => {
      const highestNote = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'notes'").get().seq;
      const highestRevision = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'note_revisions'").get().seq;
      const revisionCount = liveState(ids.target).revisions.length;

      restore(del(ids.target));

      expect(liveState(ids.target).revisions).toHaveLength(revisionCount);
      expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'notes'").get().seq).toBe(highestNote);
      expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'note_revisions'").get().seq).toBe(highestRevision);

      const created = service.createNote({ bookId: ids.bookId, chapterId: ids.chapterId, title: 'After', content: 'a' });
      expect(created.id).toBe(highestNote + 1);
      service.updateNote(created.id, { content: 'b' });
      expect(liveState(created.id).revisions[0].id).toBe(highestRevision + 1);
    });

    it('is single-use and clears the payload', () => {
      const receipt = del(ids.target);
      restore(receipt);

      const row = snapshotRow(receipt.deletionId);
      expect(row.snapshot_json).toBeNull();
      expect(row.restored_at).toBe(T0);
      expectRefusal(receipt, 'UNDO_ALREADY_RESTORED');
    });

    it('refuses at the exact expiry and accepts just before it', () => {
      const inTime = del(ids.target);
      const tooLate = del(ids.otherPage);
      clock.value = inTime.expiresAt - 1;
      expect(restore(inTime).status).toBe('restored');

      clock.value = tooLate.expiresAt;
      expect(() => restore(tooLate)).toThrow(expect.objectContaining({ code: 'UNDO_EXPIRED', status: 410 }));
      expect(liveState(tooLate.noteId).note).toBeUndefined();
    });

    it('refuses an expired Page even if cleanup keeps failing', () => {
      const repository = createNoteDeletionSnapshotRepository(db);
      const failing = makeService(db, {
        noteDeletionSnapshotRepository: {
          ...repository,
          clearExpiredSnapshots: () => { throw new Error('cleanup failure'); },
        },
      });
      const receipt = del(ids.target, { svc: failing });
      clock.value = receipt.expiresAt + 120_000;
      expectRefusal(receipt, 'UNDO_EXPIRED', { svc: failing });
      expect(snapshotRow(receipt.deletionId).snapshot_json).not.toBeNull();
    });

    it('refuses a wrong owner, and wrong or missing tokens, identically', () => {
      const receipt = del(ids.target);
      const otherOwner = service.deriveNoteDeletionOwnerKey({ kind: 'session', identity: 'session-b' });
      const attempts = [
        { ownerKey: otherOwner, undoToken: receipt.undoToken },
        { ownerKey: undefined, undoToken: receipt.undoToken },
        { ownerKey, undoToken: 'f'.repeat(64) },
        { ownerKey, undoToken: receipt.undoToken.slice(1) },
        { ownerKey, undoToken: undefined },
        { ownerKey, undoToken: '' },
        { ownerKey },
      ];
      for (const attempt of attempts) {
        expect(() => service.restoreDeletedNote(receipt.deletionId, attempt))
          .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      }
      expect(() => service.restoreDeletedNote(receipt.deletionId))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      expect(() => service.restoreDeletedNote(createNoteDeletionId(), { ownerKey, undoToken: receipt.undoToken }))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE', status: 404 }));
      expect(snapshotRow(receipt.deletionId).snapshot_json).not.toBeNull();
      expect(service.getNote(ids.first).id).toBe(ids.first);
    });

    it('binds owners by kind and tokens outside the disabled-mode CSRF oracle', () => {
      expect(service.deriveNoteDeletionOwnerKey({ kind: 'browser', identity: 'session-a' })).not.toBe(ownerKey);
      expect(() => service.deriveNoteDeletionOwnerKey({ kind: 'user', identity: 'a' })).toThrow(NoteValidationError);
      expect(() => service.deriveNoteDeletionOwnerKey({ kind: 'session', identity: '' })).toThrow(NoteValidationError);

      // A visitor can have any text HMACed as a CSRF token by choosing their cookie.
      const receipt = del(ids.target);
      const message = JSON.stringify([
        'note-deletion-undo-token', 1, receipt.deletionId, ownerKey, receipt.noteId, receipt.expiresAt,
      ]);
      expect(deriveDisabledModeCsrfToken(SECRET, message)).not.toBe(receipt.undoToken);
      expect(crypto.createHmac('sha256', SECRET)
        .update(Buffer.concat([Buffer.from([0xff]), Buffer.from(message)]))
        .digest('hex')).toBe(receipt.undoToken);
    });

    it('lets only one of two connections restore', () => {
      const secondDb = openDatabase(dbPath);
      try {
        const second = makeService(secondDb);
        const receipt = del(ids.target);
        expect(restore(receipt).status).toBe('restored');
        expect(() => restore(receipt, { svc: second }))
          .toThrow(expect.objectContaining({ code: 'UNDO_ALREADY_RESTORED' }));
      } finally {
        closeDatabase(secondDb);
      }
    });

    it('waits for the write lock: a locked attempt fails cleanly and stays retryable', () => {
      const secondDb = openDatabase(dbPath);
      try {
        secondDb.pragma('busy_timeout = 0');
        const second = makeService(secondDb);
        const receipt = del(ids.target);

        db.exec('BEGIN IMMEDIATE');
        let thrown;
        try {
          restore(receipt, { svc: second });
        } catch (error) {
          thrown = error;
        }
        db.exec('ROLLBACK');

        expect(thrown).toBeInstanceOf(NoteOperationError);
        expect(thrown.code).toBe('UNDO_OPERATION_FAILED');
        expect(snapshotRow(receipt.deletionId).restored_at).toBeNull();
        expect(restore(receipt, { svc: second }).status).toBe('restored');
      } finally {
        closeDatabase(secondDb);
      }
    });

    it('refuses when the Book is gone', () => {
      const receipt = del(ids.otherPage);
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM notes WHERE book_id = ?').run(ids.bookId);
      db.prepare('DELETE FROM book_contents WHERE book_id = ?').run(ids.bookId);
      db.prepare('DELETE FROM chapters WHERE book_id = ?').run(ids.bookId);
      db.prepare('DELETE FROM books WHERE id = ?').run(ids.bookId);
      db.pragma('foreign_keys = ON');
      expectRefusal(receipt, 'UNDO_PARENT_MISSING');
    });

    it('refuses when the Book has been replaced under the same ID', () => {
      const receipt = del(ids.target);
      db.prepare("UPDATE books SET created_at = '1999-01-01 00:00:00' WHERE id = ?").run(ids.bookId);
      expectRefusal(receipt, 'UNDO_PARENT_MISSING');
    });

    it('refuses when the Chapter is missing or now in another Book', () => {
      const moved = del(ids.target);
      const otherBook = Number(db.prepare("INSERT INTO books (title, sort_order) VALUES ('B2', 1)").run().lastInsertRowid);
      db.prepare('UPDATE chapters SET book_id = ? WHERE id = ?').run(otherBook, ids.chapterId);
      expectRefusal(moved, 'UNDO_PARENT_CHANGED');
      db.prepare('UPDATE chapters SET book_id = ? WHERE id = ?').run(ids.bookId, ids.chapterId);

      const removed = del(ids.empty);
      db.prepare('DELETE FROM notes WHERE chapter_id = ?').run(ids.otherChapterId);
      db.prepare("DELETE FROM book_contents WHERE item_type = 'chapter' AND item_id = ?").run(ids.otherChapterId);
      db.prepare('DELETE FROM chapters WHERE id = ?').run(ids.otherChapterId);
      expectRefusal(removed, 'UNDO_PARENT_CHANGED');
    });

    it('refuses when a linked Project or Asset is gone', () => {
      const projectGone = del(ids.target);
      db.prepare('DELETE FROM projects WHERE id = ?').run(ids.projectId);
      expectRefusal(projectGone, 'UNDO_ASSOCIATION_MISSING');
    });

    it('refuses when a linked Asset alone is gone', () => {
      const receipt = del(ids.target);
      db.prepare('DELETE FROM assets WHERE id = ?').run(ids.assetId);
      expectRefusal(receipt, 'UNDO_ASSOCIATION_MISSING');
    });

    it('refuses when sibling order changed, a sibling was added, or root order changed', () => {
      const reordered = del(ids.target);
      service.reorderNotes(ids.chapterId, [ids.last, ids.first]);
      expectRefusal(reordered, 'UNDO_ORDER_CHANGED');
      service.reorderNotes(ids.chapterId, [ids.first, ids.last]);

      const added = service.createNote({ bookId: ids.bookId, chapterId: ids.chapterId, title: 'New', content: '' });
      expectRefusal(reordered, 'UNDO_ORDER_CHANGED');
      service.deleteNote(added.id);
      expect(restore(reordered).status).toBe('restored');

      const root = del(ids.direct);
      const items = createBookContentRepository(db).listForBook(ids.bookId)
        .map((row) => ({ type: row.item_type, id: row.item_id }));
      createBookContentRepository(db).reorder(ids.bookId, [...items].reverse());
      expectRefusal(root, 'UNDO_ORDER_CHANGED');
    });

    it('does not compare root order for a Chapter Page', () => {
      const receipt = del(ids.target);
      const items = createBookContentRepository(db).listForBook(ids.bookId)
        .map((row) => ({ type: row.item_type, id: row.item_id }));
      createBookContentRepository(db).reorder(ids.bookId, [...items].reverse());
      expect(restore(receipt).status).toBe('restored');
    });

    it('refuses when the selection or preview mode conflicts', () => {
      selectPreview([ids.target, ids.first]);
      const selection = del(ids.target);
      selectPreview([ids.first, ids.last]);
      expectRefusal(selection, 'UNDO_PREVIEW_CHANGED');
      selectPreview([ids.first]);

      createBookPagePreviewSettingsRepository(db).replace(ids.bookId, {
        mode: 'random', randomCount: 3, selectedPageIds: [ids.first],
      });
      expectRefusal(selection, 'UNDO_PREVIEW_CHANGED');
    });

    it('ignores preview edits when the Page was not selected', () => {
      selectPreview([ids.first]);
      const receipt = del(ids.target);
      selectPreview([ids.last]);
      expect(restore(receipt).status).toBe('restored');
      expect(createBookPagePreviewSettingsRepository(db).listSelectedPageIds(ids.bookId)).toEqual([ids.last]);
    });

    it('refuses an occupied Page or revision ID', () => {
      const page = del(ids.target);
      db.prepare(`
        INSERT INTO notes (id, book_id, chapter_id, title, content, sort_order)
        VALUES (?, ?, ?, 'Squatter', '', 9)
      `).run(ids.target, ids.bookId, ids.otherChapterId);
      expectRefusal(page, 'UNDO_ID_CONFLICT');
      db.prepare('DELETE FROM notes WHERE id = ?').run(ids.target);

      const revisionId = JSON.parse(snapshotRow(page.deletionId).snapshot_json).graph.revisions[0].id;
      db.prepare(`
        INSERT INTO note_revisions (id, note_id, title, content, project_ids_json, asset_ids_json, source_updated_at)
        VALUES (?, ?, 'x', '', '[]', '[]', 'now')
      `).run(revisionId, ids.first);
      expectRefusal(page, 'UNDO_ID_CONFLICT');
    });

    it.each([
      ['revisions', 'note_revisions'],
      ['projects', 'note_projects'],
      ['assets', 'note_assets'],
      ['previews', 'book_page_preview_pages'],
    ])('rolls back fully on an injected failure writing %s, then succeeds', (_label, table) => {
      selectPreview([ids.target, ids.first]);
      const before = liveState(ids.target);
      const receipt = del(ids.target);
      const afterDelete = liveState(ids.target);
      const row = snapshotRow(receipt.deletionId);
      logInfo.mockClear();

      db.exec(`
        CREATE TRIGGER fail_restore BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END;
      `);
      let thrown;
      try {
        restore(receipt);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NoteOperationError);
      expect(thrown.code).toBe('UNDO_OPERATION_FAILED');
      expect(thrown.message).not.toContain('injected');
      expect(liveState(ids.target)).toEqual(afterDelete);
      expect(snapshotRow(receipt.deletionId)).toEqual(row);
      expect(events()).toEqual([]);

      db.exec('DROP TRIGGER fail_restore');
      restore(receipt);
      expect(liveState(ids.target)).toEqual(before);
    });

    it('rolls back when direct-root restoration fails and when consumption fails', () => {
      const before = liveState(ids.direct);
      const receipt = del(ids.direct);
      const afterDelete = liveState(ids.direct);

      db.exec(`
        CREATE TRIGGER fail_contents BEFORE INSERT ON book_contents
        BEGIN SELECT RAISE(ABORT, 'injected'); END;
      `);
      expect(() => restore(receipt)).toThrow(NoteOperationError);
      expect(liveState(ids.direct)).toEqual(afterDelete);
      db.exec('DROP TRIGGER fail_contents');

      db.exec(`
        CREATE TRIGGER fail_consume BEFORE UPDATE OF restored_at ON note_deletion_snapshots
        BEGIN SELECT RAISE(ABORT, 'injected'); END;
      `);
      expect(() => restore(receipt)).toThrow(NoteOperationError);
      expect(liveState(ids.direct)).toEqual(afterDelete);
      expect(snapshotRow(receipt.deletionId).snapshot_json).not.toBeNull();
      db.exec('DROP TRIGGER fail_consume');

      restore(receipt);
      expect(liveState(ids.direct)).toEqual(before);
    });
  });

  describe('getNoteDeletionUndo', () => {
    it('reports safe status through every state and never exposes the payload or a token', () => {
      const receipt = del(ids.target);
      const read = () => service.getNoteDeletionUndo(receipt.deletionId, { ownerKey });

      expect(read()).toEqual({
        deletionId: receipt.deletionId,
        noteId: ids.target,
        bookId: ids.bookId,
        chapterId: ids.chapterId,
        status: 'available',
        createdAt: T0,
        expiresAt: receipt.expiresAt,
        restoredAt: null,
      });
      restore(receipt);
      expect(read()).toMatchObject({ status: 'restored', restoredAt: T0 });
      expect(JSON.stringify(read())).not.toContain('markdown');

      const expiring = del(ids.first);
      clock.value = expiring.expiresAt;
      expect(service.getNoteDeletionUndo(expiring.deletionId, { ownerKey }).status).toBe('expired');
      expect(() => service.getNoteDeletionUndo(expiring.deletionId, { ownerKey: 'b'.repeat(64) }))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      expect(() => service.getNoteDeletionUndo('nope', { ownerKey }))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      expect(() => service.getNoteDeletionUndo(expiring.deletionId))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
    });
  });

  describe('issueNoteDeletionUndoAction', () => {
    function expectNoAction(deletionId, code, owner = ownerKey, svc = service) {
      expect(() => svc.issueNoteDeletionUndoAction(deletionId, { ownerKey: owner }))
        .toThrow(expect.objectContaining({ code }));
    }

    it('issues a working token from the owned opportunity alone', () => {
      selectPreview([ids.target]);
      const before = liveState(ids.target);
      const { deletionId } = del(ids.target);
      expect(service.getNoteDeletionUndo(deletionId, { ownerKey }).status).toBe('available');
      logInfo.mockClear();

      const action = service.issueNoteDeletionUndoAction(deletionId, { ownerKey });

      expect(action).toEqual({
        ...service.getNoteDeletionUndo(deletionId, { ownerKey }),
        undoToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      // Issuing neither consumes the opportunity nor records anything.
      expect(service.issueNoteDeletionUndoAction(deletionId, { ownerKey })).toEqual(action);
      expect(events()).toEqual([]);

      expect(service.restoreDeletedNote(deletionId, { ownerKey, undoToken: action.undoToken }))
        .toMatchObject({ noteId: ids.target, status: 'restored' });
      expect(liveState(ids.target)).toEqual(before);
    });

    it('reissues the original token through the same HMAC and stores no token', () => {
      const receipt = del(ids.target);
      const { undoToken } = service.issueNoteDeletionUndoAction(receipt.deletionId, { ownerKey });
      expect(undoToken).toBe(receipt.undoToken);

      const message = JSON.stringify([
        'note-deletion-undo-token', 1, receipt.deletionId, ownerKey, receipt.noteId, receipt.expiresAt,
      ]);
      expect(deriveDisabledModeCsrfToken(SECRET, message)).not.toBe(undoToken);
      expect(JSON.stringify(snapshotRow(receipt.deletionId))).not.toContain(undoToken);
    });

    it('exposes no payload, owner key or secret', () => {
      const { deletionId } = del(ids.target);
      const action = service.issueNoteDeletionUndoAction(deletionId, { ownerKey });
      expect(Object.keys(action).sort()).toEqual([
        'bookId', 'chapterId', 'createdAt', 'deletionId', 'expiresAt', 'noteId', 'restoredAt', 'status', 'undoToken',
      ]);
      const serialized = JSON.stringify(action);
      for (const hidden of [ownerKey, SECRET, 'markdown', 'snapshot']) {
        expect(serialized).not.toContain(hidden);
      }
    });

    it('issues nothing for a wrong, missing or malformed owner, or an unknown deletion', () => {
      const { deletionId } = del(ids.target);
      const otherSession = service.deriveNoteDeletionOwnerKey({ kind: 'session', identity: 'session-b' });
      const sameTextOtherKind = service.deriveNoteDeletionOwnerKey({ kind: 'browser', identity: 'session-a' });
      for (const owner of [otherSession, sameTextOtherKind, undefined, '', 'nope', ownerKey.toUpperCase()]) {
        expect(() => service.issueNoteDeletionUndoAction(deletionId, { ownerKey: owner }))
          .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      }
      expect(() => service.issueNoteDeletionUndoAction(deletionId))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      expectNoAction(createNoteDeletionId(), 'UNDO_UNAVAILABLE');
      expectNoAction('nope', 'UNDO_UNAVAILABLE');
      expectNoAction(undefined, 'UNDO_UNAVAILABLE');
    });

    it('still requires the token: the locator and owner alone cannot restore', () => {
      const { deletionId } = del(ids.target);
      const issued = service.issueNoteDeletionUndoAction(deletionId, { ownerKey });
      for (const undoToken of [undefined, '', 'f'.repeat(64), issued.undoToken.slice(1)]) {
        expect(() => service.restoreDeletedNote(deletionId, { ownerKey, undoToken }))
          .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      }
      const otherOwner = service.deriveNoteDeletionOwnerKey({ kind: 'session', identity: 'session-b' });
      expect(() => service.restoreDeletedNote(deletionId, { ownerKey: otherOwner, undoToken: issued.undoToken }))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      expect(() => service.getNote(ids.target)).toThrow(NoteNotFoundError);
      expect(snapshotRow(deletionId).snapshot_json).not.toBeNull();
    });

    it('issues until just before expiry and never at or after it, even if cleanup fails', () => {
      const { deletionId, expiresAt } = del(ids.target);
      clock.value = expiresAt - 1;
      expect(service.issueNoteDeletionUndoAction(deletionId, { ownerKey }).status).toBe('available');

      clock.value = expiresAt;
      expectNoAction(deletionId, 'UNDO_EXPIRED');

      const failingRepo = createNoteDeletionSnapshotRepository(db);
      failingRepo.clearExpiredSnapshots = () => { throw new Error('cleanup down'); };
      const noCleanup = makeService(db, { noteDeletionSnapshotRepository: failingRepo });
      expectNoAction(deletionId, 'UNDO_EXPIRED', ownerKey, noCleanup);
    });

    it('issues nothing once expiry has erased the payload or the receipt', () => {
      const { deletionId, expiresAt } = del(ids.target);
      clock.value = expiresAt + 11 * 60 * 1000;
      expectNoAction(deletionId, 'UNDO_EXPIRED');
      expect(snapshotRow(deletionId).snapshot_json).toBeNull();

      clock.value = expiresAt + DAY_MS + 11 * 60 * 1000;
      expectNoAction(deletionId, 'UNDO_UNAVAILABLE');
      expect(snapshotRow(deletionId)).toBeUndefined();
    });

    it('issues nothing once consumed, and a reissued token cannot replay', () => {
      const { deletionId } = del(ids.target);
      const { undoToken } = service.issueNoteDeletionUndoAction(deletionId, { ownerKey });
      service.restoreDeletedNote(deletionId, { ownerKey, undoToken });

      expectNoAction(deletionId, 'UNDO_ALREADY_RESTORED');
      expect(() => service.restoreDeletedNote(deletionId, { ownerKey, undoToken }))
        .toThrow(expect.objectContaining({ code: 'UNDO_ALREADY_RESTORED' }));
      expect(service.getNote(ids.target).id).toBe(ids.target);
    });

    it('issues nothing for an unsupported snapshot version or after backup invalidation', () => {
      const old = del(ids.target);
      db.prepare('UPDATE note_deletion_snapshots SET snapshot_version = 99 WHERE id = ?').run(old.deletionId);
      expectNoAction(old.deletionId, 'UNDO_UNAVAILABLE');

      const restored = del(ids.first);
      invalidateNoteDeletionSnapshotsForRestore(db);
      expectNoAction(restored.deletionId, 'UNDO_UNAVAILABLE');
    });

    it('issues nothing under a different signing secret, even for the stored owner key', () => {
      const { deletionId, undoToken } = del(ids.target);
      const rotated = makeService(db, { noteDeletionUndoSecret: 'b'.repeat(64) });
      const action = rotated.issueNoteDeletionUndoAction(deletionId, { ownerKey });
      expect(action.undoToken).not.toBe(undoToken);
      expect(() => service.restoreDeletedNote(deletionId, { ownerKey, undoToken: action.undoToken }))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      expect(rotated.deriveNoteDeletionOwnerKey({ kind: 'session', identity: 'session-a' })).not.toBe(ownerKey);
    });

    it('leaves a conflict for restoration to report, unchanged and retryable', () => {
      const { deletionId } = del(ids.target);
      service.createNote({ bookId: ids.bookId, chapterId: ids.chapterId, title: 'New sibling', content: '' });
      const { undoToken } = service.issueNoteDeletionUndoAction(deletionId, { ownerKey });
      expect(() => service.restoreDeletedNote(deletionId, { ownerKey, undoToken }))
        .toThrow(expect.objectContaining({ code: 'UNDO_ORDER_CHANGED' }));
      expect(service.issueNoteDeletionUndoAction(deletionId, { ownerKey }).undoToken).toBe(undoToken);
    });

    it('reports an unexpected read failure without leaking it', () => {
      const { deletionId } = del(ids.target);
      const brokenRepo = createNoteDeletionSnapshotRepository(db);
      brokenRepo.findReceipt = () => { throw new Error('SQLITE_IOERR private/path'); };
      const broken = makeService(db, { noteDeletionSnapshotRepository: brokenRepo });
      let thrown;
      try {
        broken.issueNoteDeletionUndoAction(deletionId, { ownerKey });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NoteOperationError);
      expect(thrown.code).toBe('UNDO_OPERATION_FAILED');
      expect(thrown.message).not.toContain('private/path');
    });
  });

  describe('expiry cleanup', () => {
    it('clears payloads after expiry, throttled, then removes receipts after 24 hours', () => {
      const receipt = del(ids.target);
      const read = () => service.getNoteDeletionUndo(receipt.deletionId, { ownerKey });

      clock.value = receipt.expiresAt - 1;
      read();
      clock.value = receipt.expiresAt;
      read();
      expect(snapshotRow(receipt.deletionId).snapshot_json).not.toBeNull();

      clock.value = receipt.expiresAt + 60_000;
      expect(read().status).toBe('expired');
      expect(snapshotRow(receipt.deletionId).snapshot_json).toBeNull();
      expect(snapshotRow(receipt.deletionId).restored_at).toBeNull();
      expectRefusal(receipt, 'UNDO_EXPIRED');

      clock.value = receipt.expiresAt + DAY_MS - 1;
      expect(read().status).toBe('expired');

      clock.value = receipt.expiresAt + DAY_MS + 60_000;
      expect(() => read()).toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      expect(snapshotRow(receipt.deletionId)).toBeUndefined();
    });

    it('runs at initialization and never fails construction', () => {
      const receipt = del(ids.target);
      clock.value = receipt.expiresAt;
      makeService();
      expect(snapshotRow(receipt.deletionId).snapshot_json).toBeNull();

      expect(() => makeService(db, {
        noteDeletionSnapshotRepository: {
          clearExpiredSnapshots() { throw new Error('locked'); },
        },
      })).not.toThrow();
    });

    it('retains restored receipts until 24 hours after expiry', () => {
      const receipt = del(ids.target);
      restore(receipt);
      clock.value = receipt.expiresAt + DAY_MS - 1;
      expect(service.getNoteDeletionUndo(receipt.deletionId, { ownerKey }).status).toBe('restored');
      clock.value = receipt.expiresAt + DAY_MS + 60_000;
      expect(() => service.getNoteDeletionUndo(receipt.deletionId, { ownerKey }))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
    });
  });

  describe('file-backed restart', () => {
    it('recovers the original Page after closing and reopening the database', () => {
      selectPreview([ids.target]);
      const before = liveState(ids.target);
      const receipt = del(ids.target);

      closeDatabase(db);
      db = openDatabase(dbPath);
      runMigrations(db, MIGRATIONS_DIR);
      clock.value = T0 + NOTE_DELETION_UNDO_WINDOW_MS - 1;
      const restarted = makeService();
      const sameOwner = restarted.deriveNoteDeletionOwnerKey({ kind: 'session', identity: 'session-a' });
      expect(sameOwner).toBe(ownerKey);

      expect(restarted.getNoteDeletionUndo(receipt.deletionId, { ownerKey: sameOwner }).status).toBe('available');
      expect(restarted.restoreDeletedNote(receipt.deletionId, {
        ownerKey: sameOwner, undoToken: receipt.undoToken,
      }).noteId).toBe(ids.target);

      expect(liveState(ids.target)).toEqual(before);
      expect(restarted.getNoteDeletionUndo(receipt.deletionId, { ownerKey: sameOwner }).status).toBe('restored');
      expect(snapshotRow(receipt.deletionId).snapshot_json).toBeNull();
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });

    it('recovers from the owner identity alone, without the token from the deletion call', () => {
      selectPreview([ids.target]);
      const before = liveState(ids.target);
      const { deletionId } = del(ids.target);

      closeDatabase(db);
      db = openDatabase(dbPath);
      runMigrations(db, MIGRATIONS_DIR);
      clock.value = T0 + NOTE_DELETION_UNDO_WINDOW_MS - 1;
      const restarted = makeService();
      const sameOwner = restarted.deriveNoteDeletionOwnerKey({ kind: 'session', identity: 'session-a' });

      expect(restarted.getNoteDeletionUndo(deletionId, { ownerKey: sameOwner }).status).toBe('available');
      const { undoToken } = restarted.issueNoteDeletionUndoAction(deletionId, { ownerKey: sameOwner });
      expect(restarted.restoreDeletedNote(deletionId, { ownerKey: sameOwner, undoToken }).noteId).toBe(ids.target);

      expect(liveState(ids.target)).toEqual(before);
      expect(() => restarted.issueNoteDeletionUndoAction(deletionId, { ownerKey: sameOwner }))
        .toThrow(expect.objectContaining({ code: 'UNDO_ALREADY_RESTORED' }));
    });
  });

  describe('schema', () => {
    it('matches the columns captured by snapshot version 1', () => {
      // A failure here means a new persisted column needs capture, restoration
      // and a snapshot version bump, not just an update to this list.
      const columns = (table) => db.pragma(`table_info(${table})`).map((column) => column.name);
      expect(columns('notes')).toEqual([
        'id', 'book_id', 'chapter_id', 'title', 'content', 'sort_order', 'created_at', 'updated_at',
      ]);
      expect(columns('note_revisions')).toEqual([
        'id', 'note_id', 'title', 'content', 'project_ids_json', 'asset_ids_json', 'source_updated_at', 'created_at',
      ]);
      expect(columns('note_projects')).toEqual(['note_id', 'project_id']);
      expect(columns('note_assets')).toEqual(['note_id', 'asset_id']);
      expect(columns('book_page_preview_pages')).toEqual(['book_id', 'page_id']);
      expect(columns('book_contents')).toEqual(['book_id', 'item_type', 'item_id', 'sort_order']);
    });

    it('enforces receipt-state constraints and declares no foreign keys', () => {
      expect(db.pragma('foreign_key_list(note_deletion_snapshots)')).toEqual([]);
      const indexes = db.pragma('index_list(note_deletion_snapshots)').map((index) => index.name);
      expect(indexes).toEqual(expect.arrayContaining([
        'note_deletion_snapshots_expires_at_idx',
        'note_deletion_snapshots_owner_note_created_idx',
      ]));

      const insert = (overrides = {}) => {
        const row = {
          id: 'c'.repeat(64),
          owner_key: 'd'.repeat(64),
          note_id: 1,
          book_id: 1,
          chapter_id: null,
          created_at: 10,
          expires_at: 20,
          restored_at: null,
          snapshot_version: 1,
          snapshot_json: '{}',
          ...overrides,
        };
        db.prepare(`
          INSERT INTO note_deletion_snapshots (
            id, owner_key, note_id, book_id, chapter_id, created_at, expires_at,
            restored_at, snapshot_version, snapshot_json
          ) VALUES (
            @id, @owner_key, @note_id, @book_id, @chapter_id, @created_at, @expires_at,
            @restored_at, @snapshot_version, @snapshot_json
          )
        `).run(row);
      };

      for (const invalid of [
        { id: 'short' },
        { id: 'Z'.repeat(64) },
        { owner_key: 'user-1' },
        { note_id: 0 },
        { expires_at: 10 },
        { restored_at: 15 },
        { snapshot_version: 0 },
        { snapshot_json: 'not json' },
      ]) {
        expect(() => insert(invalid)).toThrow(/CHECK constraint/);
      }
      expect(() => insert()).not.toThrow();
      expect(() => insert({ id: 'e'.repeat(64), restored_at: 15, snapshot_json: null })).not.toThrow();
    });
  });
});

describe('note_deletion_snapshots migration and backups', () => {
  const MIGRATION = '046_add_note_deletion_snapshots.sql';
  let root;
  let legacyMigrationsDir;

  function hasTable(db) {
    return Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_deletion_snapshots'"
    ).get());
  }

  function seedLegacyPage(db) {
    const bookId = Number(db.prepare("INSERT INTO books (title, sort_order) VALUES ('Old', 0)").run().lastInsertRowid);
    const noteId = Number(db.prepare(`
      INSERT INTO notes (book_id, title, content, sort_order) VALUES (?, 'Old page', 'kept', 0)
    `).run(bookId).lastInsertRowid);
    db.prepare("INSERT INTO book_contents (book_id, item_type, item_id, sort_order) VALUES (?, 'page', ?, 0)")
      .run(bookId, noteId);
    return { bookId, noteId };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-undo-migrate-'));
    legacyMigrationsDir = path.join(root, 'legacy-migrations');
    fs.mkdirSync(legacyMigrationsDir);
    for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
      if (name.endsWith('.sql') && name !== MIGRATION) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(legacyMigrationsDir, name));
      }
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is configured by createApp only when the persistent pepper is supplied', () => {
    const databasePath = path.join(root, 'app.db');
    const projectsRoot = path.join(root, 'projects');
    fs.mkdirSync(projectsRoot);
    const db = openDatabase(databasePath);
    try {
      runMigrations(db, MIGRATIONS_DIR);
      const build = (extra) => createApp(
        { appName: 'Test', db, projectsRoot },
        { appDataRoot: root, databasePath, ...extra },
      );
      expect(build({ authState: { csrfPepper: SECRET } }).locals.noteService.isNoteDeletionUndoConfigured()).toBe(true);
      expect(build({}).locals.noteService.isNoteDeletionUndoConfigured()).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  describe('createApp signing wiring', () => {
    const OWNER = { kind: 'browser', identity: 'visitor-cookie' };
    let databasePath;
    let projectsRoot;

    function build(db, opts) {
      return createApp(
        { appName: 'Test', db, projectsRoot },
        { appDataRoot: root, databasePath, ...opts },
      ).locals.noteService;
    }

    function open() {
      const db = openDatabase(databasePath);
      runMigrations(db, MIGRATIONS_DIR);
      return db;
    }

    beforeEach(() => {
      databasePath = path.join(root, 'wiring.db');
      projectsRoot = path.join(root, 'wiring-projects');
      fs.mkdirSync(projectsRoot);
    });

    it('signs with the persisted pepper, which is stable across a full restart', () => {
      const { csrfPepper } = ensureAuthEnablement(root);
      let db = open();
      try {
        const { noteId } = seedLegacyPage(db);
        const first = build(db, { authState: { csrfPepper } });
        const ownerKey = first.deriveNoteDeletionOwnerKey(OWNER);
        expect(ownerKey).toBe(crypto.createHmac('sha256', csrfPepper)
          .update(Buffer.from([0xff]))
          .update(JSON.stringify(['note-deletion-owner', 1, OWNER.kind, OWNER.identity]))
          .digest('hex'));
        const { deletionId } = first.deleteNoteWithUndo(noteId, {
          deletionId: createNoteDeletionId(), ownerKey,
        });

        closeDatabase(db);
        db = open();
        const reloaded = ensureAuthEnablement(root);
        expect(reloaded.csrfPepper).toBe(csrfPepper);
        const second = build(db, { authState: { csrfPepper: reloaded.csrfPepper } });
        const sameOwner = second.deriveNoteDeletionOwnerKey(OWNER);
        expect(sameOwner).toBe(ownerKey);

        expect(second.getNoteDeletionUndo(deletionId, { ownerKey: sameOwner }).status).toBe('available');
        const { undoToken } = second.issueNoteDeletionUndoAction(deletionId, { ownerKey: sameOwner });
        expect(second.restoreDeletedNote(deletionId, { ownerKey: sameOwner, undoToken }).noteId).toBe(noteId);
        expect(second.getNote(noteId).content).toBe('kept');
      } finally {
        closeDatabase(db);
      }
    });

    it('keeps the pepper when authentication is enabled and disabled again', () => {
      const { csrfPepper } = ensureAuthEnablement(root);
      enableAuthState(root, { sessionSecret: 'c'.repeat(64), csrfPepper });
      expect(ensureAuthEnablement(root).csrfPepper).toBe(csrfPepper);
      disableAuthState(root, { csrfPepper });
      expect(ensureAuthEnablement(root).csrfPepper).toBe(csrfPepper);
    });

    it('fails closed through createApp when no pepper is supplied', () => {
      const db = open();
      try {
        const { noteId } = seedLegacyPage(db);
        const service = build(db, {});
        expect(service.isNoteDeletionUndoConfigured()).toBe(false);
        expect(() => service.deleteNoteWithUndo(noteId, {
          deletionId: createNoteDeletionId(), ownerKey: 'a'.repeat(64),
        })).toThrow(expect.objectContaining({ code: 'UNDO_NOT_CONFIGURED' }));
        expect(service.getNote(noteId).id).toBe(noteId);
        expect(db.prepare('SELECT COUNT(*) AS c FROM note_deletion_snapshots').get().c).toBe(0);
      } finally {
        closeDatabase(db);
      }
    });

    it('takes the signing key only from server state, not from request-facing options', () => {
      const db = open();
      try {
        const service = build(db, { noteDeletionUndoSecret: SECRET });
        expect(service.isNoteDeletionUndoConfigured()).toBe(false);
      } finally {
        closeDatabase(db);
      }
    });
  });

  it('applies once to a populated database and preserves existing data', () => {
    const db = openDatabase(path.join(root, 'legacy.db'));
    try {
      runMigrations(db, legacyMigrationsDir);
      expect(hasTable(db)).toBe(false);
      const { noteId } = seedLegacyPage(db);
      const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);

      runMigrations(db, MIGRATIONS_DIR);
      expect(hasTable(db)).toBe(true);
      expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').all(MIGRATION)).toHaveLength(1);
      expect(db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId)).toEqual(note);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

      expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS c FROM note_deletion_snapshots').get().c).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  describe('managed backup restore', () => {
    let db;
    let databasePath;
    let backupService;
    let owner;

    function start(migrationsDir) {
      databasePath = path.join(root, 'creatorcrate.db');
      db = openDatabase(databasePath);
      runMigrations(db, migrationsDir);
      backupService = createBackupService({ appDataRoot: root, databasePath, migrationsDir: MIGRATIONS_DIR });
    }

    function makeLiveService(connection) {
      return createNoteService({
        db: connection,
        noteRepository: createNoteRepository(connection),
        projectRepository: createProjectRepository(connection),
        assetRepository: createAssetRepository(connection),
        chapterRepository: createChapterRepository(connection),
        bookRepository: createBookRepository(connection),
        bookContentRepository: createBookContentRepository(connection),
        bookPagePreviewSettingsRepository: createBookPagePreviewSettingsRepository(connection),
        noteDeletionSnapshotRepository: createNoteDeletionSnapshotRepository(connection),
        noteDeletionUndoSecret: SECRET,
      });
    }

    function restoreOwner(connection) {
      owner = beginReplacementMaintenance(connection, () => connection.open);
      return owner;
    }

    afterEach(() => {
      owner?.release();
      owner = null;
      try {
        closeDatabase(db);
      } catch {
        // already closed by a failed restore
      }
    });

    it('invalidates opportunities captured in the backup', async () => {
      start(MIGRATIONS_DIR);
      const { noteId } = seedLegacyPage(db);
      const service = makeLiveService(db);
      const ownerKey = service.deriveNoteDeletionOwnerKey({ kind: 'browser', identity: 'visitor' });
      const receipt = service.deleteNoteWithUndo(noteId, { deletionId: createNoteDeletionId(), ownerKey });
      const backup = await backupService.createBackup(db);

      const result = await backupService.restoreBackup(backup.filename, db, restoreOwner(db));
      db = result.db;

      expect(db.prepare('SELECT COUNT(*) AS c FROM note_deletion_snapshots').get().c).toBe(0);
      const restored = makeLiveService(db);
      expect(() => restored.restoreDeletedNote(receipt.deletionId, { ownerKey, undoToken: receipt.undoToken }))
        .toThrow(expect.objectContaining({ code: 'UNDO_UNAVAILABLE' }));
      expect(db.prepare('SELECT 1 FROM notes WHERE id = ?').get(noteId)).toBeUndefined();
    });

    it('leaves live opportunities intact when the restore rolls back', async () => {
      start(MIGRATIONS_DIR);
      const { noteId } = seedLegacyPage(db);
      const backup = await backupService.createBackup(db);
      const service = makeLiveService(db);
      const ownerKey = service.deriveNoteDeletionOwnerKey({ kind: 'browser', identity: 'visitor' });
      const receipt = service.deleteNoteWithUndo(noteId, { deletionId: createNoteDeletionId(), ownerKey });

      const failing = createBackupService({
        appDataRoot: root,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        _hooks: { afterStagedRestorePrepared() { throw new Error('injected'); } },
      });
      let thrown;
      try {
        await failing.restoreBackup(backup.filename, db, restoreOwner(db));
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.db).toBeTruthy();
      db = thrown.db;

      const recovered = makeLiveService(db);
      expect(recovered.restoreDeletedNote(receipt.deletionId, {
        ownerKey, undoToken: receipt.undoToken,
      }).noteId).toBe(noteId);
    });

    it('restores a backup from before the migration', async () => {
      start(legacyMigrationsDir);
      const { noteId } = seedLegacyPage(db);
      expect(hasTable(db)).toBe(false);
      const backup = await backupService.createBackup(db);

      const result = await backupService.restoreBackup(backup.filename, db, restoreOwner(db));
      db = result.db;

      expect(hasTable(db)).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS c FROM note_deletion_snapshots').get().c).toBe(0);
      expect(db.prepare('SELECT title FROM notes WHERE id = ?').get(noteId).title).toBe('Old page');
    });
  });
});
