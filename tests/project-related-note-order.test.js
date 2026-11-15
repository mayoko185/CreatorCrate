import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createNoteRepository, NoteError } from '../src/data/note-repository.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createBookContentRepository } from '../src/data/book-content-repository.js';
import { createChapterRepository } from '../src/data/chapter-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import {
  createNoteService,
  NoteRelatedOrderStaleError,
  NoteValidationError,
} from '../src/services/note-service.js';
import { ProjectNotFoundError } from '../src/services/project-service.js';

// WP7.2: project-specific Related Notes order. Ranks live in
// project_related_note_order (migration 048), are merged into the existing
// listRelatedForProject read, and are saved only through
// noteService.reorderRelatedNotesForProject.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const MIGRATION = '048_add_project_related_note_order.sql';

describe('migration 048: project_related_note_order', () => {
  let root;
  let db;

  afterEach(() => {
    if (db?.open) closeDatabase(db);
    if (root) fs.rmSync(root, { recursive: true, force: true });
    db = null;
    root = null;
  });

  function open({ before048 = false } = {}) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-related-order-migration-'));
    db = openDatabase(path.join(root, 'test.sqlite'));
    const dir = path.join(root, 'migrations');
    fs.mkdirSync(dir);
    for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
      if (!before048 || name < MIGRATION) fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
    }
    runMigrations(db, dir);
  }

  function seed() {
    db.exec(`
      INSERT INTO projects (id, title, slug, status, project_type) VALUES (1, 'One', 'one', 'tbd', 'images');
      INSERT INTO projects (id, title, slug, status, project_type) VALUES (2, 'Two', 'two', 'tbd', 'images');
      INSERT INTO books (id, title, sort_order) VALUES (1, 'Book', 0);
      INSERT INTO chapters (id, book_id, title, sort_order) VALUES (1, 1, 'Chapter', 0);
      INSERT INTO notes (id, book_id, chapter_id, title, content, sort_order) VALUES (1, 1, 1, 'A', '', 0);
      INSERT INTO notes (id, book_id, chapter_id, title, content, sort_order) VALUES (2, 1, 1, 'B', '', 1);
      INSERT INTO notes (id, book_id, chapter_id, title, content, sort_order) VALUES (3, 1, 1, 'C', '', 2);
      INSERT INTO note_projects (note_id, project_id) VALUES (1, 1), (2, 1), (3, 1), (2, 2);
    `);
  }

  it('creates the table, keys, checks and indexes on a fresh install', () => {
    open();
    const columns = db.prepare('PRAGMA table_info(project_related_note_order)').all();
    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: 'project_id', type: 'INTEGER', notnull: 1, pk: 1 },
      { name: 'note_id', type: 'INTEGER', notnull: 1, pk: 2 },
      { name: 'sort_order', type: 'INTEGER', notnull: 1, pk: 0 },
    ]);
    const fks = db.prepare('PRAGMA foreign_key_list(project_related_note_order)').all();
    expect(fks.map(({ table, from, to, on_delete: onDelete }) => ({ table, from, to, onDelete }))
      .sort((a, b) => a.table.localeCompare(b.table))).toEqual([
      { table: 'notes', from: 'note_id', to: 'id', onDelete: 'CASCADE' },
      { table: 'projects', from: 'project_id', to: 'id', onDelete: 'CASCADE' },
    ]);
    const indexes = db.prepare('PRAGMA index_list(project_related_note_order)').all()
      .map(({ name, unique }) => ({ name, unique })).filter(({ name }) => !name.startsWith('sqlite_'));
    expect(indexes.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'project_related_note_order_note_id_idx', unique: 0 },
      { name: 'project_related_note_order_project_sort_idx', unique: 1 },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('upgrades from 047 without touching existing data, idempotently, keeping hierarchy order', () => {
    open({ before048: true });
    seed();
    const snapshot = () => ({
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      notes: db.prepare('SELECT * FROM notes ORDER BY id').all(),
      chapters: db.prepare('SELECT * FROM chapters ORDER BY id').all(),
      links: db.prepare('SELECT * FROM note_projects ORDER BY note_id, project_id').all(),
    });
    const before = snapshot();

    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);

    expect(snapshot()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = ?').get(MIGRATION).n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_related_note_order').get().n).toBe(0);
    expect(createNoteRepository(db).listRelatedForProject(1).map((note) => note.id)).toEqual([1, 2, 3]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('cascades Project and Note deletion and enforces its checks', () => {
    open();
    seed();
    db.exec(`INSERT INTO project_related_note_order (project_id, note_id, sort_order)
      VALUES (1, 3, 0), (1, 1, 1), (1, 2, 2), (2, 2, 0)`);

    expect(() => db.prepare('INSERT INTO project_related_note_order VALUES (2, 1, -1)').run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO project_related_note_order VALUES (2, 1, 1.5)").run()).toThrow(/CHECK/);
    expect(() => db.prepare('INSERT INTO project_related_note_order VALUES (2, 1, 0)').run()).toThrow(/UNIQUE/);
    expect(() => db.prepare('INSERT INTO project_related_note_order VALUES (9, 1, 5)').run()).toThrow(/FOREIGN KEY/);

    db.prepare('DELETE FROM notes WHERE id = 2').run();
    expect(db.prepare('SELECT project_id, note_id FROM project_related_note_order ORDER BY project_id, sort_order').all())
      .toEqual([{ project_id: 1, note_id: 3 }, { project_id: 1, note_id: 1 }]);
    db.prepare('DELETE FROM projects WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_related_note_order').get().n).toBe(0);
  });
});

describe('project-specific Related Notes order', () => {
  let tmpDir;
  let dbPath;
  let db;
  let noteRepository;
  let chapterRepository;
  let service;
  let bookId;
  let chapterId;
  let projectNumber;

  function build() {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    noteRepository = createNoteRepository(db);
    chapterRepository = createChapterRepository(db);
    service = createNoteService({
      db,
      noteRepository,
      projectRepository: createProjectRepository(db),
      assetRepository: createAssetRepository(db),
      chapterRepository,
      bookRepository: createBookRepository(db),
      bookContentRepository: createBookContentRepository(db),
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-related-order-'));
    dbPath = path.join(tmpDir, 'test.db');
    build();
    bookId = Number(db.prepare("INSERT INTO books (title, sort_order) VALUES ('Book', 0)").run().lastInsertRowid);
    chapterId = chapterRepository.create({ bookId, title: 'Chapter' }).id;
    projectNumber = 1;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (db?.open) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject() {
    const n = projectNumber++;
    return Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, patreon_url, project_type)
      VALUES (?, ?, '', '', 'tbd', NULL, 'images')
    `).run(`Project ${n}`, `project-${n}`).lastInsertRowid);
  }

  function createAsset(projectId, name) {
    return Number(db.prepare('INSERT INTO assets (project_id, relative_path, filename) VALUES (?, ?, ?)')
      .run(projectId, `source/${name}`, name).lastInsertRowid);
  }

  function page(title, { projectIds = [], assetIds = [] } = {}) {
    return service.createNote({ chapterId, title, projectIds, assetIds }).id;
  }

  const ids = (projectId) => service.listRelatedNotesForProject(projectId).notes.map((note) => note.id);
  const ranks = (projectId) => noteRepository.listRelatedOrderForProject(projectId).map((row) => row.note_id);
  const reorder = (projectId, expectedNoteIds, orderedNoteIds) => service
    .reorderRelatedNotesForProject(projectId, { expectedNoteIds, orderedNoteIds });
  const hierarchy = () => db.prepare('SELECT id, book_id, chapter_id, sort_order FROM notes ORDER BY id').all();

  describe('default order', () => {
    it('keeps the exact hierarchy order without ranks, and handles empty and single-note Projects', () => {
      const empty = createProject();
      const single = createProject();
      const many = createProject();
      const asset = createAsset(many, 'a.png');
      const a = page('A', { projectIds: [many] });
      const b = page('B', { assetIds: [asset] });
      const c = page('C', { projectIds: [many, single], assetIds: [asset] });
      const directPage = service.createNote({ bookId, title: 'Direct', projectIds: [many] }).id;

      expect(ids(many)).toEqual([a, b, c, directPage]);
      expect(noteRepository.list().map((n) => n.id)).toEqual([a, b, c, directPage]);
      expect(ids(single)).toEqual([c]);
      expect(ids(empty)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM project_related_note_order').get().n).toBe(0);

      expect(reorder(empty, [], [])).toMatchObject({ projectId: empty, changed: false, notes: [] });
      expect(reorder(single, [c], [c]).notes.map((n) => n.id)).toEqual([c]);
    });

    it('breaks equal hierarchy positions by Note id', () => {
      const project = createProject();
      const first = page('First', { projectIds: [project] });
      const second = page('Second', { projectIds: [project] });
      db.prepare('UPDATE notes SET sort_order = 0 WHERE id IN (?, ?)').run(first, second);
      expect(ids(project)).toEqual([first, second]);
    });
  });

  describe('saved order', () => {
    it('persists across reads and a reopened database, without touching hierarchy order', () => {
      const project = createProject();
      const a = page('A', { projectIds: [project] });
      const b = page('B', { projectIds: [project] });
      const c = page('C', { projectIds: [project] });
      const before = hierarchy();

      const outcome = reorder(project, [a, b, c], [c, a, b]);
      expect(outcome).toMatchObject({ projectId: project, changed: true });
      expect(outcome.notes.map((n) => n.id)).toEqual([c, a, b]);
      expect(ids(project)).toEqual([c, a, b]);
      expect(hierarchy()).toEqual(before);
      expect(noteRepository.listForChapter(chapterId).map((n) => n.id)).toEqual([a, b, c]);

      closeDatabase(db);
      build();
      expect(ids(project)).toEqual([c, a, b]);
    });

    it('appends new Notes after ranked ones, hides unlinked ones and restores a retained rank', () => {
      const project = createProject();
      const a = page('A', { projectIds: [project] });
      const b = page('B', { projectIds: [project] });
      const c = page('C', { projectIds: [project] });
      reorder(project, [a, b, c], [c, b, a]);

      const d = page('D', { projectIds: [project] });
      const e = page('E', { projectIds: [project] });
      expect(ids(project)).toEqual([c, b, a, d, e]);

      service.updateNote(b, { title: 'B', content: '', projectIds: [], assetIds: [] });
      expect(ids(project)).toEqual([c, a, d, e]);
      expect(ranks(project)).toEqual([c, b, a]);

      service.updateNote(b, { title: 'B', content: '', projectIds: [project], assetIds: [] });
      expect(ids(project)).toEqual([c, b, a, d, e]);

      service.updateNote(b, { title: 'B', content: '', projectIds: [], assetIds: [] });
      reorder(project, [c, a, d, e], [e, c, a, d]);
      expect(ranks(project)).toEqual([e, c, a, d]);
      service.updateNote(b, { title: 'B', content: '', projectIds: [project], assetIds: [] });
      expect(ids(project)).toEqual([e, c, a, d, b]);
    });

    it('lets hierarchy changes reorder only unranked fallback Notes', () => {
      const project = createProject();
      const a = page('A', { projectIds: [project] });
      const b = page('B', { projectIds: [project] });
      reorder(project, [a, b], [b, a]);
      const c = page('C', { projectIds: [project] });
      const d = page('D', { projectIds: [project] });
      expect(ids(project)).toEqual([b, a, c, d]);

      service.reorderNotes(chapterId, [d, c, a, b]);
      expect(ids(project)).toEqual([b, a, d, c]);
    });
  });

  describe('scoping', () => {
    it('keeps shared Notes independently ranked per Project', () => {
      const one = createProject();
      const two = createProject();
      const a = page('A', { projectIds: [one, two] });
      const b = page('B', { projectIds: [one, two] });
      const c = page('C', { projectIds: [one, two] });

      reorder(one, [a, b, c], [c, b, a]);
      expect(ids(two)).toEqual([a, b, c]);
      reorder(two, [a, b, c], [b, c, a]);
      expect(ids(one)).toEqual([c, b, a]);
      expect(ids(two)).toEqual([b, c, a]);
    });

    it('orders asset-only and dual-linked Notes once, without foreign-Project Asset leaks', () => {
      const project = createProject();
      const other = createProject();
      const own = createAsset(project, 'own.png');
      const foreign = createAsset(other, 'foreign.png');
      const assetOnly = page('Asset only', { assetIds: [own] });
      const dual = page('Dual', { projectIds: [project], assetIds: [own] });
      const foreignOnly = page('Foreign asset only', { assetIds: [foreign] });
      const direct = page('Direct', { projectIds: [project] });

      expect(ids(project)).toEqual([assetOnly, dual, direct]);
      reorder(project, [assetOnly, dual, direct], [direct, dual, assetOnly]);
      expect(ids(project)).toEqual([direct, dual, assetOnly]);
      expect(() => reorder(project, [direct, dual, assetOnly], [direct, dual, assetOnly, foreignOnly]))
        .toThrow(NoteValidationError);
      expect(ids(other)).toEqual([foreignOnly]);
    });

    it('never lets one Project\'s ranks add Notes to another Project', () => {
      const one = createProject();
      const two = createProject();
      const a = page('A', { projectIds: [one] });
      const b = page('B', { projectIds: [one] });
      reorder(one, [a, b], [b, a]);
      expect(ids(two)).toEqual([]);
    });
  });

  describe('validation', () => {
    let project;
    let a;
    let b;
    let c;

    beforeEach(() => {
      project = createProject();
      a = page('A', { projectIds: [project] });
      b = page('B', { projectIds: [project] });
      c = page('C', { projectIds: [project] });
    });

    function refusal(fn) {
      try {
        fn();
      } catch (error) {
        return error;
      }
      throw new Error('expected a refusal');
    }

    it('refuses malformed submissions with field errors and saves nothing', () => {
      const cases = [
        [null, 'order'],
        [[a, b, c], 'order'],
        [{ orderedNoteIds: [a, b, c] }, 'expectedNoteIds'],
        [{ expectedNoteIds: [a, b, c] }, 'orderedNoteIds'],
        [{ expectedNoteIds: [a, b, c], orderedNoteIds: String(a) }, 'orderedNoteIds'],
        [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, String(c)] }, 'orderedNoteIds'],
        [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, [c]] }, 'orderedNoteIds'],
        [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, { id: c }] }, 'orderedNoteIds'],
        [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, 1.5] }, 'orderedNoteIds'],
        [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, 0] }, 'orderedNoteIds'],
        [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, b] }, 'orderedNoteIds'],
        [{ expectedNoteIds: [a, a, c], orderedNoteIds: [a, b, c] }, 'expectedNoteIds'],
      ];
      for (const [submission, field] of cases) {
        const error = refusal(() => service.reorderRelatedNotesForProject(project, submission));
        expect(error).toBeInstanceOf(NoteValidationError);
        expect(Object.keys(error.errors)).toContain(field);
      }
      expect(ranks(project)).toEqual([]);
    });

    it('refuses missing or extra Notes once the snapshot is current', () => {
      const stray = page('Stray');
      for (const ordered of [[a, b], [a, b, c, stray], [a, b, stray]]) {
        const error = refusal(() => reorder(project, [a, b, c], ordered));
        expect(error).toBeInstanceOf(NoteValidationError);
        expect(error.code).toBe('RELATED_NOTES_ORDER_INVALID');
        expect(error.errors).toHaveProperty('orderedNoteIds');
      }
      expect(ranks(project)).toEqual([]);
    });

    it('refuses invalid and nonexistent Projects', () => {
      expect(refusal(() => reorder(0, [], []))).toBeInstanceOf(NoteValidationError);
      expect(refusal(() => reorder('1', [], []))).toBeInstanceOf(NoteValidationError);
      expect(refusal(() => reorder(999999, [], []))).toBeInstanceOf(ProjectNotFoundError);
    });

    it('refuses stale membership and stale order with 409 and keeps the server order', () => {
      reorder(project, [a, b, c], [b, a, c]);

      const staleOrder = refusal(() => reorder(project, [a, b, c], [c, b, a]));
      expect(staleOrder).toBeInstanceOf(NoteRelatedOrderStaleError);
      expect(staleOrder).toMatchObject({ status: 409, code: 'RELATED_NOTES_ORDER_STALE', projectId: project });

      const d = page('D', { projectIds: [project] });
      expect(refusal(() => reorder(project, [b, a, c], [c, b, a]))).toBeInstanceOf(NoteRelatedOrderStaleError);
      service.updateNote(c, { title: 'C', content: '', projectIds: [], assetIds: [] });
      expect(refusal(() => reorder(project, [b, a, c, d], [d, c, b, a]))).toBeInstanceOf(NoteRelatedOrderStaleError);

      expect(ids(project)).toEqual([b, a, d]);
      expect(ranks(project)).toEqual([b, a, c]);
    });

    it('accepts a reorder after a content-only edit', () => {
      service.updateNote(b, { title: 'B renamed', content: 'New body' });
      expect(reorder(project, [a, b, c], [b, c, a]).notes.map((n) => n.id)).toEqual([b, c, a]);
    });
  });

  describe('concurrency and atomicity', () => {
    it('accepts the first of two saves based on one snapshot and refuses the second', () => {
      const project = createProject();
      const a = page('A', { projectIds: [project] });
      const b = page('B', { projectIds: [project] });
      const c = page('C', { projectIds: [project] });
      const snapshot = ids(project);

      reorder(project, snapshot, [c, b, a]);
      expect(() => reorder(project, snapshot, [b, a, c])).toThrow(NoteRelatedOrderStaleError);
      expect(ids(project)).toEqual([c, b, a]);
    });

    it('runs the write in an IMMEDIATE transaction', () => {
      const project = createProject();
      const a = page('A', { projectIds: [project] });
      // With another writer holding the lock, an IMMEDIATE transaction fails
      // at BEGIN, before reading the membership it would validate against.
      const spy = vi.spyOn(noteRepository, 'listRelatedForProject');
      const other = openDatabase(dbPath);
      other.pragma('busy_timeout = 0');
      db.pragma('busy_timeout = 0');
      other.exec('BEGIN IMMEDIATE');
      try {
        expect(() => reorder(project, [a], [a])).toThrow(/locked|busy/i);
      } finally {
        other.exec('ROLLBACK');
        closeDatabase(other);
      }
      expect(spy).not.toHaveBeenCalled();
      expect(reorder(project, [a], [a]).notes.map((n) => n.id)).toEqual([a]);
    });

    it('rolls every rank change back when a write fails', () => {
      const project = createProject();
      const a = page('A', { projectIds: [project] });
      const b = page('B', { projectIds: [project] });
      const c = page('C', { projectIds: [project] });
      const stale = page('Stale', { projectIds: [project] });
      reorder(project, [a, b, c, stale], [stale, c, b, a]);
      service.updateNote(stale, { title: 'Stale', content: '', projectIds: [], assetIds: [] });
      db.exec(`
        CREATE TEMP TRIGGER fail_related_rank BEFORE INSERT ON project_related_note_order
        WHEN NEW.note_id = ${a} BEGIN SELECT RAISE(ABORT, 'rank write failed'); END;
      `);

      expect(() => reorder(project, [c, b, a], [b, c, a])).toThrow(/rank write failed/);
      expect(ranks(project)).toEqual([stale, c, b, a]);
      expect(ids(project)).toEqual([c, b, a]);
    });

    it('refuses a write whose persisted order does not verify, rolling it back', () => {
      const project = createProject();
      const a = page('A', { projectIds: [project] });
      const b = page('B', { projectIds: [project] });
      vi.spyOn(noteRepository, 'replaceRelatedOrderForProject').mockImplementation((projectId) => {
        db.prepare('INSERT INTO project_related_note_order VALUES (?, ?, 0)').run(projectId, a);
        return [a];
      });
      expect(() => reorder(project, [a, b], [b, a])).toThrow(/does not match/);
      expect(ranks(project)).toEqual([]);
    });
  });

  describe('repository write guard', () => {
    it('refuses malformed rank input before writing', () => {
      const project = createProject();
      expect(() => noteRepository.replaceRelatedOrderForProject(project, 'x')).toThrow(NoteError);
      expect(() => noteRepository.replaceRelatedOrderForProject(project, [1, 1])).toThrow(/Duplicate/);
      expect(() => noteRepository.replaceRelatedOrderForProject(project, [0])).toThrow(/Invalid note ID/);
      expect(() => noteRepository.replaceRelatedOrderForProject(0, [])).toThrow(/Invalid project ID/);
    });
  });
});
