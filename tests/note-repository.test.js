import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createNoteRepository, NoteError } from '../src/data/note-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('note repository', () => {
  let tmpDir;
  let dbPath;
  let db;
  let repository;
  let defaultBookId;
  let defaultChapterId;
  let rawCreate;
  let strictCreate;
  let rawReorder;
  let rawSaveWithAssociations;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-notes-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    repository = createNoteRepository(db);
    defaultBookId = Number(db.prepare(
      "INSERT INTO books (title, sort_order) VALUES ('Default Book', 0)"
    ).run().lastInsertRowid);
    defaultChapterId = Number(db.prepare(
      "INSERT INTO chapters (book_id, title, sort_order) VALUES (?, 'Default Chapter', 0)"
    ).run(defaultBookId).lastInsertRowid);
    strictCreate = repository.create.bind(repository);
    rawCreate = (input = {}) => {
      const chapterId = input.chapterId;
      const inferredBookId = chapterId == null
        ? defaultBookId
        : db.prepare('SELECT book_id FROM chapters WHERE id = ?').pluck().get(chapterId);
      return strictCreate({ bookId: input.bookId ?? inferredBookId, ...input });
    };
    rawReorder = repository.reorder.bind(repository);
    rawSaveWithAssociations = repository.saveWithAssociations.bind(repository);
    repository.create = (input = {}) => {
      const chapterId = Object.hasOwn(input, 'chapterId') ? input.chapterId : defaultChapterId;
      const bookId = Object.hasOwn(input, 'bookId')
        ? input.bookId
        : chapterId == null
          ? defaultBookId
          : db.prepare('SELECT book_id FROM chapters WHERE id = ?').pluck().get(chapterId);
      return strictCreate({ bookId, chapterId, ...input });
    };
    repository.reorder = (orderedIds) => rawReorder(defaultChapterId, orderedIds);
    repository.saveWithAssociations = (input = {}) => {
      const chapterId = Object.hasOwn(input, 'chapterId') ? input.chapterId : defaultChapterId;
      const bookId = Object.hasOwn(input, 'bookId')
        ? input.bookId
        : chapterId == null
          ? defaultBookId
          : db.prepare('SELECT book_id FROM chapters WHERE id = ?').pluck().get(chapterId);
      return rawSaveWithAssociations({ bookId, chapterId, ...input });
    };
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Schema behavior ───────────────────────────────────────────────────

  describe('schema', () => {
    it('creates the notes table with all expected columns', () => {
      const columns = db.prepare("PRAGMA table_info('notes')").all();
      const names = columns.map((c) => c.name);
      expect(names).toContain('id');
      expect(names).toContain('book_id');
      expect(names).toContain('chapter_id');
      expect(names).toContain('title');
      expect(names).toContain('content');
      expect(names).toContain('sort_order');
      expect(names).toContain('created_at');
      expect(names).toContain('updated_at');
    });

    it('enforces sort_order >= 0', () => {
      expect(() => {
        db.prepare('INSERT INTO notes (book_id, chapter_id, title, content, sort_order) VALUES (?, ?, ?, ?, ?)')
          .run(defaultBookId, defaultChapterId, 't', 'c', -1);
      }).toThrow(/constraint/i);
    });

    it('defaults title and content to empty strings', () => {
      db.prepare('INSERT INTO notes (book_id, chapter_id, sort_order) VALUES (?, ?, 0)')
        .run(defaultBookId, defaultChapterId);
      const row = db.prepare('SELECT title, content FROM notes WHERE id = 1').get();
      expect(row.title).toBe('');
      expect(row.content).toBe('');
    });

    it('defaults sort_order to 0', () => {
      db.prepare("INSERT INTO notes (book_id, chapter_id, title, content) VALUES (?, ?, 't', 'c')")
        .run(defaultBookId, defaultChapterId);
      const row = db.prepare('SELECT sort_order FROM notes WHERE id = 1').get();
      expect(row.sort_order).toBe(0);
    });

    it('auto-increments id', () => {
      db.prepare("INSERT INTO notes (book_id, chapter_id, title, content) VALUES (?, ?, 'a', 'b')")
        .run(defaultBookId, defaultChapterId);
      db.prepare("INSERT INTO notes (book_id, chapter_id, title, content) VALUES (?, ?, 'c', 'd')")
        .run(defaultBookId, defaultChapterId);
      const ids = db.prepare('SELECT id FROM notes ORDER BY id').all().map((r) => r.id);
      expect(ids).toEqual([1, 2]);
    });

    it('sets created_at and updated_at automatically', () => {
      db.prepare("INSERT INTO notes (book_id, chapter_id, title, content) VALUES (?, ?, 't', 'c')")
        .run(defaultBookId, defaultChapterId);
      const row = db.prepare('SELECT created_at, updated_at FROM notes WHERE id = 1').get();
      expect(row.created_at).toBeTruthy();
      expect(row.updated_at).toBeTruthy();
    });

    it('allows content to hold multi-line markdown text', () => {
      const markdown = '# Heading\n\nParagraph with **bold**.\n\n- item 1\n- item 2\n';
      db.prepare("INSERT INTO notes (book_id, chapter_id, title, content, sort_order) VALUES (?, ?, ?, ?, 0)")
        .run(defaultBookId, defaultChapterId, 't', markdown);
      const row = db.prepare('SELECT content FROM notes WHERE id = 1').get();
      expect(row.content).toBe(markdown);
    });
  });

  // ─── Creation ──────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a note with default title and content', () => {
      const note = repository.create();
      expect(note.title).toBe('');
      expect(note.content).toBe('');
      expect(note.sort_order).toBe(0);
      expect(note.id).toBeGreaterThan(0);
    });

    it('creates a note with explicit title and content', () => {
      const note = repository.create({ title: 'My Note', content: '# Hello' });
      expect(note.title).toBe('My Note');
      expect(note.content).toBe('# Hello');
    });

    it('appends at increasing sort_order', () => {
      const first = repository.create({ title: 'First' });
      const second = repository.create({ title: 'Second' });
      const third = repository.create({ title: 'Third' });
      expect(first.sort_order).toBe(0);
      expect(second.sort_order).toBe(1);
      expect(third.sort_order).toBe(2);
    });

    it('appends after the highest sort_order even after deletions leave gaps', () => {
      const first = repository.create({ title: 'First' });
      const second = repository.create({ title: 'Second' });
      const third = repository.create({ title: 'Third' });
      // sort_orders are 0, 1, 2
      repository.deleteById(second.id);
      // deletion compacts the source Chapter before the next append
      const fourth = repository.create({ title: 'Fourth' });
      expect(fourth.sort_order).toBe(2);
    });
  });

  // ─── Find by ID ────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns the note by id', () => {
      const created = repository.create({ title: 'Find me', content: 'body' });
      const found = repository.findById(created.id);
      expect(found).toBeDefined();
      expect(found.id).toBe(created.id);
      expect(found.title).toBe('Find me');
      expect(found.content).toBe('body');
    });

    it('returns undefined for a non-existent id', () => {
      expect(repository.findById(999999)).toBeUndefined();
    });
  });

  // ─── Ordered list ──────────────────────────────────────────────────────

  describe('list', () => {
    it('returns notes ordered by sort_order then id', () => {
      repository.create({ title: 'Alpha' });
      repository.create({ title: 'Beta' });
      repository.create({ title: 'Gamma' });
      const notes = repository.list();
      expect(notes.map((n) => n.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
      expect(notes.map((n) => n.sort_order)).toEqual([0, 1, 2]);
    });

    it('returns an empty array when no notes exist', () => {
      expect(repository.list()).toEqual([]);
    });
  });

  // ─── Update ────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates title', () => {
      const note = repository.create({ title: 'Old' });
      const updated = repository.update(note.id, { title: 'New' });
      expect(updated.title).toBe('New');
      expect(updated.content).toBe(note.content);
    });

    it('updates content', () => {
      const note = repository.create({ content: 'old body' });
      const updated = repository.update(note.id, { content: 'new body' });
      expect(updated.content).toBe('new body');
      expect(updated.title).toBe(note.title);
    });

    it('updates both title and content', () => {
      const note = repository.create({ title: 'A', content: 'B' });
      const updated = repository.update(note.id, { title: 'C', content: 'D' });
      expect(updated.title).toBe('C');
      expect(updated.content).toBe('D');
    });

    it('refreshes updated_at on every mutation', () => {
      const note = repository.create({ title: 'Before' });
      const beforeUpdatedAt = note.updated_at;

      // Small delay to ensure datetime changes
      const start = Date.now();
      while (Date.now() - start < 1100) {
        // wait at least 1 second for SQLite datetime('now') granularity
      }

      const updated = repository.update(note.id, { title: 'After' });
      expect(updated.updated_at).not.toBe(beforeUpdatedAt);
    });

    it('returns undefined for non-existent id', () => {
      expect(repository.update(999999, { title: 'X' })).toBeUndefined();
    });

    it('does not change sort_order on update', () => {
      const note = repository.create({ title: 'Ordered' });
      const updated = repository.update(note.id, { title: 'Renamed' });
      expect(updated.sort_order).toBe(note.sort_order);
    });
  });

  // ─── Delete ────────────────────────────────────────────────────────────

  describe('deleteById', () => {
    it('deletes a note', () => {
      const note = repository.create({ title: 'Delete me' });
      expect(repository.deleteById(note.id)).toBe(true);
      expect(repository.findById(note.id)).toBeUndefined();
    });

    it('returns false for non-existent id', () => {
      expect(repository.deleteById(999999)).toBe(false);
    });
  });

  // ─── Reorder ───────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('reorders notes to contiguous zero-based positions', () => {
      const n1 = repository.create({ title: 'A' });
      const n2 = repository.create({ title: 'B' });
      const n3 = repository.create({ title: 'C' });
      const reversedIds = [n3.id, n2.id, n1.id];

      const reordered = repository.reorder(reversedIds);

      expect(reordered.map((n) => n.id)).toEqual(reversedIds);
      expect(reordered.map((n) => n.sort_order)).toEqual([0, 1, 2]);
    });

    it('reorders an arbitrary permutation without colliding with a unique order constraint', () => {
      const n1 = repository.create({ title: 'A' });
      const n2 = repository.create({ title: 'B' });
      const n3 = repository.create({ title: 'C' });
      const n4 = repository.create({ title: 'D' });
      const n5 = repository.create({ title: 'E' });
      const orderedIds = [n3.id, n1.id, n5.id, n2.id, n4.id];

      db.exec(`
        CREATE UNIQUE INDEX notes_chapter_sort_order_unique
        ON notes(chapter_id, sort_order)
      `);

      const reordered = repository.reorder(orderedIds);

      expect(reordered.map((n) => n.id)).toEqual(orderedIds);
      expect(reordered.map((n) => n.sort_order)).toEqual([0, 1, 2, 3, 4]);
    });

    it('rejects reorder with missing IDs', () => {
      const n1 = repository.create({ title: 'A' });
      const n2 = repository.create({ title: 'B' });
      expect(() => repository.reorder([n1.id])).toThrow();
    });

    it('rejects reorder with duplicate IDs', () => {
      const n1 = repository.create({ title: 'A' });
      const n2 = repository.create({ title: 'B' });
      expect(() => repository.reorder([n1.id, n1.id])).toThrow();
    });

    it('rejects reorder with an unknown ID', () => {
      const n1 = repository.create({ title: 'A' });
      const n2 = repository.create({ title: 'B' });
      expect(() => repository.reorder([n1.id, 999999])).toThrow();
    });

    it('rejects non-array input', () => {
      repository.create({ title: 'A' });
      expect(() => repository.reorder('not an array')).toThrow();
    });

    it('rejects non-positive and unsafe IDs without changing the current order', () => {
      repository.create({ title: 'A' });
      repository.create({ title: 'B' });
      const before = repository.list();

      expect(() => repository.reorder([0, 1])).toThrow();
      expect(() => repository.reorder([-1, 2])).toThrow();

      expect(repository.list()).toEqual(before);
    });

    it('accepts the empty set when no notes exist', () => {
      expect(repository.reorder([])).toEqual([]);
    });

    it('rolls back the entire reorder when the final update fails', () => {
      const n1 = repository.create({ title: 'A' });
      const n2 = repository.create({ title: 'B' });
      const n3 = repository.create({ title: 'C' });
      const before = repository.list();

      db.exec(`
        CREATE TRIGGER fail_note_reorder
        BEFORE UPDATE OF sort_order ON notes
        WHEN OLD.sort_order >= 5 AND NEW.sort_order = 0
        BEGIN
          SELECT RAISE(ABORT, 'forced note reorder failure');
        END
      `);

      expect(() => repository.reorder([n3.id, n2.id, n1.id])).toThrow(/forced note reorder failure/);
      expect(repository.list()).toEqual(before);
    });
  });

  // ─── Append ordering ──────────────────────────────────────────────────

  describe('append ordering', () => {
    it('places each new note at the end of the current manual order', () => {
      repository.create({ title: 'First' });
      repository.create({ title: 'Second' });
      repository.create({ title: 'Third' });
      const notes = repository.list();
      expect(notes.map((n) => n.sort_order)).toEqual([0, 1, 2]);
    });

    it('continues after the highest sort_order after a reorder', () => {
      const n1 = repository.create({ title: 'A' });
      const n2 = repository.create({ title: 'B' });
      repository.reorder([n2.id, n1.id]);
      // After reorder: n2=0, n1=1
      const n3 = repository.create({ title: 'C' });
      expect(n3.sort_order).toBe(2);
    });
  });

  // ─── Association schema ─────────────────────────────────────────────────

  describe('association schema', () => {
    function createProject(title = 'Test Project') {
      return Number(db.prepare(`
        INSERT INTO projects (
          title, slug, description, notes, status,
          planned_date, published_date, patreon_url
        ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
      `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
    }

    function createAsset(projectId, relativePath) {
      const filename = relativePath.split('/').pop();
      return Number(db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename)
        VALUES (?, ?, ?)
      `).run(projectId, relativePath, filename).lastInsertRowid);
    }

    it('creates note_projects with the expected columns and composite primary key', () => {
      const columns = db.prepare("PRAGMA table_info('note_projects')").all();
      const names = columns.map((c) => c.name);
      expect(names).toEqual(['note_id', 'project_id']);

      const pkColumns = columns.filter((c) => c.pk > 0).map((c) => c.name);
      expect(pkColumns.sort()).toEqual(['note_id', 'project_id']);
    });

    it('creates note_assets with the expected columns and composite primary key', () => {
      const columns = db.prepare("PRAGMA table_info('note_assets')").all();
      const names = columns.map((c) => c.name);
      expect(names).toEqual(['note_id', 'asset_id']);

      const pkColumns = columns.filter((c) => c.pk > 0).map((c) => c.name);
      expect(pkColumns.sort()).toEqual(['asset_id', 'note_id']);
    });

    it('enforces foreign key from note_projects.note_id to notes.id', () => {
      const projectId = createProject();
      expect(() => {
        db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?)').run(999999, projectId);
      }).toThrow(/FOREIGN KEY/i);
    });

    it('enforces foreign key from note_projects.project_id to projects.id', () => {
      const note = repository.create({ title: 'FK Test' });
      expect(() => {
        db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?)').run(note.id, 999999);
      }).toThrow(/FOREIGN KEY/i);
    });

    it('enforces foreign key from note_assets.note_id to notes.id', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/test.png');
      expect(() => {
        db.prepare('INSERT INTO note_assets (note_id, asset_id) VALUES (?, ?)').run(999999, assetId);
      }).toThrow(/FOREIGN KEY/i);
    });

    it('enforces foreign key from note_assets.asset_id to assets.id', () => {
      const note = repository.create({ title: 'FK Test' });
      expect(() => {
        db.prepare('INSERT INTO note_assets (note_id, asset_id) VALUES (?, ?)').run(note.id, 999999);
      }).toThrow(/FOREIGN KEY/i);
    });

    it('does not allow duplicate note_projects rows', () => {
      const note = repository.create({ title: 'Dup Test' });
      const projectId = createProject();
      db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?)').run(note.id, projectId);
      expect(() => {
        db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?)').run(note.id, projectId);
      }).toThrow(/UNIQUE constraint failed/i);
    });

    it('does not allow duplicate note_assets rows', () => {
      const note = repository.create({ title: 'Dup Test' });
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/test.png');
      db.prepare('INSERT INTO note_assets (note_id, asset_id) VALUES (?, ?)').run(note.id, assetId);
      expect(() => {
        db.prepare('INSERT INTO note_assets (note_id, asset_id) VALUES (?, ?)').run(note.id, assetId);
      }).toThrow(/UNIQUE constraint failed/i);
    });
  });

  // ─── Project associations ──────────────────────────────────────────────

  describe('project associations', () => {
    function createProject(title = 'Test Project') {
      return Number(db.prepare(`
        INSERT INTO projects (
          title, slug, description, notes, status,
          planned_date, published_date, patreon_url
        ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
      `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
    }

    it('replaces project associations for a note', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project 1');
      const p2 = createProject('Project 2');

      const result = repository.replaceProjects(note.id, [p1, p2]);
      expect(result).toEqual([p1, p2]);
      expect(repository.listProjectsForNote(note.id)).toEqual([p1, p2]);
    });

    it('adds new and removes old project associations on replacement', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project 1');
      const p2 = createProject('Project 2');
      const p3 = createProject('Project 3');

      repository.replaceProjects(note.id, [p1, p2]);
      const result = repository.replaceProjects(note.id, [p2, p3]);

      expect(result).toEqual([p2, p3]);
      expect(repository.listProjectsForNote(note.id)).toEqual([p2, p3]);
    });

    it('clears all project associations when replacing with an empty array', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project 1');
      const p2 = createProject('Project 2');

      repository.replaceProjects(note.id, [p1, p2]);
      expect(repository.replaceProjects(note.id, [])).toEqual([]);
      expect(repository.listProjectsForNote(note.id)).toEqual([]);
    });

    it('deduplicates duplicate project IDs in replacement input', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project 1');
      const p2 = createProject('Project 2');

      const result = repository.replaceProjects(note.id, [p1, p1, p2, p2]);
      expect(result).toEqual([p1, p2]);

      const rowCount = db.prepare('SELECT COUNT(*) AS count FROM note_projects WHERE note_id = ?')
        .get(note.id).count;
      expect(rowCount).toBe(2);
    });

    it('replaces project associations idempotently', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project 1');
      const p2 = createProject('Project 2');

      repository.replaceProjects(note.id, [p1, p2]);
      const firstAssignment = db.prepare(`
        SELECT note_id, project_id
        FROM note_projects
        WHERE note_id = ? AND project_id = ?
      `).get(note.id, p1);

      const result = repository.replaceProjects(note.id, [p1, p2]);
      expect(result).toEqual([p1, p2]);

      const secondAssignment = db.prepare(`
        SELECT note_id, project_id
        FROM note_projects
        WHERE note_id = ? AND project_id = ?
      `).get(note.id, p1);
      expect(secondAssignment).toEqual(firstAssignment);
    });

    it('returns undefined when replacing projects for a nonexistent note', () => {
      const projectId = createProject();
      expect(repository.replaceProjects(999999, [projectId])).toBeUndefined();
      expect(repository.replaceProjects(999999, [])).toBeUndefined();
    });

    it('rolls back the entire replacement on foreign-key violation', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project 1');
      const p2 = createProject('Project 2');
      repository.replaceProjects(note.id, [p1, p2]);

      const before = db.prepare(`
        SELECT note_id, project_id
        FROM note_projects
        WHERE note_id = ?
        ORDER BY project_id
      `).all(note.id);

      expect(() => repository.replaceProjects(note.id, [p2, 999999]))
        .toThrow(/FOREIGN KEY/i);

      expect(db.prepare(`
        SELECT note_id, project_id
        FROM note_projects
        WHERE note_id = ?
        ORDER BY project_id
      `).all(note.id)).toEqual(before);
    });

    it('lists notes for a project in canonical global order', () => {
      const p1 = createProject('Project 1');
      const n1 = repository.create({ title: 'Third' });
      const n2 = repository.create({ title: 'First' });
      const n3 = repository.create({ title: 'Second' });

      // Assign in a different order than sort_order
      repository.replaceProjects(n1.id, [p1]);
      repository.replaceProjects(n2.id, [p1]);
      repository.replaceProjects(n3.id, [p1]);

      // Reorder: n2=0 (First), n3=1 (Second), n1=2 (Third)
      repository.reorder([n2.id, n3.id, n1.id]);

      const notes = repository.listForProject(p1);
      expect(notes.map((n) => n.id)).toEqual([n2.id, n3.id, n1.id]);
      expect(notes.map((n) => n.title)).toEqual(['First', 'Second', 'Third']);
    });

    it('returns an empty array for a project with no associated notes', () => {
      const p1 = createProject('Empty Project');
      expect(repository.listForProject(p1)).toEqual([]);
    });

    it('cascades project associations when a note is deleted', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project 1');
      const p2 = createProject('Project 2');
      repository.replaceProjects(note.id, [p1, p2]);

      repository.deleteById(note.id);

      expect(repository.listProjectsForNote(note.id)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM note_projects WHERE note_id = ?')
        .get(note.id).count).toBe(0);
      expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(p1)).toEqual({ id: p1 });
      expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(p2)).toEqual({ id: p2 });
    });

    it('cascades project associations when a project is deleted', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project 1');
      const p2 = createProject('Project 2');
      repository.replaceProjects(note.id, [p1, p2]);

      db.prepare('DELETE FROM projects WHERE id = ?').run(p1);

      expect(repository.listProjectsForNote(note.id)).toEqual([p2]);
      expect(repository.findById(note.id)).toBeDefined();
    });

    it('rejects non-array project IDs input', () => {
      const note = repository.create({ title: 'Note' });
      expect(() => repository.replaceProjects(note.id, 'not an array')).toThrow(NoteError);
    });

    it('lists project IDs in ascending order', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project A');
      const p2 = createProject('Project B');
      const p3 = createProject('Project C');

      // Insert in a different order than the IDs
      repository.replaceProjects(note.id, [p3, p1, p2]);

      const ids = repository.listProjectsForNote(note.id);
      expect(ids).toEqual([p1, p2, p3]);
    });
  });

  // ─── Asset associations ─────────────────────────────────────────────────

  describe('asset associations', () => {
    function createProject(title = 'Test Project') {
      return Number(db.prepare(`
        INSERT INTO projects (
          title, slug, description, notes, status,
          planned_date, published_date, patreon_url
        ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
      `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
    }

    function createAsset(projectId, relativePath) {
      const filename = relativePath.split('/').pop();
      return Number(db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename)
        VALUES (?, ?, ?)
      `).run(projectId, relativePath, filename).lastInsertRowid);
    }

    it('replaces asset associations for a note', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/first.png');
      const a2 = createAsset(projectId, 'source/second.png');

      const result = repository.replaceAssets(note.id, [a1, a2]);
      expect(result).toEqual([a1, a2]);
      expect(repository.listAssetsForNote(note.id)).toEqual([a1, a2]);
    });

    it('adds new and removes old asset associations on replacement', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/first.png');
      const a2 = createAsset(projectId, 'source/second.png');
      const a3 = createAsset(projectId, 'source/third.png');

      repository.replaceAssets(note.id, [a1, a2]);
      const result = repository.replaceAssets(note.id, [a2, a3]);

      expect(result).toEqual([a2, a3]);
      expect(repository.listAssetsForNote(note.id)).toEqual([a2, a3]);
    });

    it('clears all asset associations when replacing with an empty array', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/first.png');
      const a2 = createAsset(projectId, 'source/second.png');

      repository.replaceAssets(note.id, [a1, a2]);
      expect(repository.replaceAssets(note.id, [])).toEqual([]);
      expect(repository.listAssetsForNote(note.id)).toEqual([]);
    });

    it('deduplicates duplicate asset IDs in replacement input', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/first.png');
      const a2 = createAsset(projectId, 'source/second.png');

      const result = repository.replaceAssets(note.id, [a1, a1, a2, a2]);
      expect(result).toEqual([a1, a2]);

      const rowCount = db.prepare('SELECT COUNT(*) AS count FROM note_assets WHERE note_id = ?')
        .get(note.id).count;
      expect(rowCount).toBe(2);
    });

    it('replaces asset associations idempotently', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/first.png');
      const a2 = createAsset(projectId, 'source/second.png');

      repository.replaceAssets(note.id, [a1, a2]);
      const firstAssignment = db.prepare(`
        SELECT note_id, asset_id
        FROM note_assets
        WHERE note_id = ? AND asset_id = ?
      `).get(note.id, a1);

      const result = repository.replaceAssets(note.id, [a1, a2]);
      expect(result).toEqual([a1, a2]);

      const secondAssignment = db.prepare(`
        SELECT note_id, asset_id
        FROM note_assets
        WHERE note_id = ? AND asset_id = ?
      `).get(note.id, a1);
      expect(secondAssignment).toEqual(firstAssignment);
    });

    it('returns undefined when replacing assets for a nonexistent note', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/test.png');
      expect(repository.replaceAssets(999999, [assetId])).toBeUndefined();
      expect(repository.replaceAssets(999999, [])).toBeUndefined();
    });

    it('rolls back the entire replacement on foreign-key violation', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/first.png');
      const a2 = createAsset(projectId, 'source/second.png');
      repository.replaceAssets(note.id, [a1, a2]);

      const before = db.prepare(`
        SELECT note_id, asset_id
        FROM note_assets
        WHERE note_id = ?
        ORDER BY asset_id
      `).all(note.id);

      expect(() => repository.replaceAssets(note.id, [a2, 999999]))
        .toThrow(/FOREIGN KEY/i);

      expect(db.prepare(`
        SELECT note_id, asset_id
        FROM note_assets
        WHERE note_id = ?
        ORDER BY asset_id
      `).all(note.id)).toEqual(before);
    });

    it('lists notes for an asset in canonical global order', () => {
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/asset.png');
      const n1 = repository.create({ title: 'Third' });
      const n2 = repository.create({ title: 'First' });
      const n3 = repository.create({ title: 'Second' });

      repository.replaceAssets(n1.id, [a1]);
      repository.replaceAssets(n2.id, [a1]);
      repository.replaceAssets(n3.id, [a1]);

      // Reorder: n2=0 (First), n3=1 (Second), n1=2 (Third)
      repository.reorder([n2.id, n3.id, n1.id]);

      const notes = repository.listForAsset(a1);
      expect(notes.map((n) => n.id)).toEqual([n2.id, n3.id, n1.id]);
      expect(notes.map((n) => n.title)).toEqual(['First', 'Second', 'Third']);
    });

    it('returns an empty array for an asset with no associated notes', () => {
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/empty.png');
      expect(repository.listForAsset(a1)).toEqual([]);
    });

    it('cascades asset associations when a note is deleted', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/first.png');
      const a2 = createAsset(projectId, 'source/second.png');
      repository.replaceAssets(note.id, [a1, a2]);

      repository.deleteById(note.id);

      expect(repository.listAssetsForNote(note.id)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM note_assets WHERE note_id = ?')
        .get(note.id).count).toBe(0);
      expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(a1)).toEqual({ id: a1 });
      expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(a2)).toEqual({ id: a2 });
    });

    it('cascades asset associations when an asset is deleted', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/first.png');
      const a2 = createAsset(projectId, 'source/second.png');
      repository.replaceAssets(note.id, [a1, a2]);

      db.prepare('DELETE FROM assets WHERE id = ?').run(a1);

      expect(repository.listAssetsForNote(note.id)).toEqual([a2]);
      expect(repository.findById(note.id)).toBeDefined();
    });

    it('rejects non-array asset IDs input', () => {
      const note = repository.create({ title: 'Note' });
      expect(() => repository.replaceAssets(note.id, 'not an array')).toThrow(NoteError);
    });

    it('lists asset IDs in ascending order', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject();
      const a1 = createAsset(projectId, 'source/a.png');
      const a2 = createAsset(projectId, 'source/b.png');
      const a3 = createAsset(projectId, 'source/c.png');

      // Insert in a different order than the IDs
      repository.replaceAssets(note.id, [a3, a1, a2]);

      const ids = repository.listAssetsForNote(note.id);
      expect(ids).toEqual([a1, a2, a3]);
    });
  });

  // ─── Independence of associations ──────────────────────────────────────

  describe('association independence', () => {
    function createProject(title = 'Test Project') {
      return Number(db.prepare(`
        INSERT INTO projects (
          title, slug, description, notes, status,
          planned_date, published_date, patreon_url
        ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
      `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
    }

    function createAsset(projectId, relativePath) {
      const filename = relativePath.split('/').pop();
      return Number(db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename)
        VALUES (?, ?, ?)
      `).run(projectId, relativePath, filename).lastInsertRowid);
    }

    it('associating an asset does not implicitly associate its project', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject('Owning Project');
      const assetId = createAsset(projectId, 'source/asset.png');

      repository.replaceAssets(note.id, [assetId]);

      expect(repository.listAssetsForNote(note.id)).toEqual([assetId]);
      expect(repository.listProjectsForNote(note.id)).toEqual([]);
      expect(repository.listForProject(projectId)).toEqual([]);
    });

    it('associating a project does not implicitly associate its assets', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject('Owning Project');
      const assetId = createAsset(projectId, 'source/asset.png');

      repository.replaceProjects(note.id, [projectId]);

      expect(repository.listProjectsForNote(note.id)).toEqual([projectId]);
      expect(repository.listAssetsForNote(note.id)).toEqual([]);
      expect(repository.listForAsset(assetId)).toEqual([]);
    });

    it('allows a note to have both project and asset associations independently', () => {
      const note = repository.create({ title: 'Note' });
      const p1 = createProject('Project A');
      const p2 = createProject('Project B');
      const a1 = createAsset(p1, 'source/alpha.png');
      const a2 = createAsset(p2, 'source/beta.png');
      const a3 = createAsset(p1, 'source/gamma.png');

      repository.replaceProjects(note.id, [p1, p2]);
      repository.replaceAssets(note.id, [a1, a2, a3]);

      expect(repository.listProjectsForNote(note.id)).toEqual([p1, p2]);
      expect(repository.listAssetsForNote(note.id)).toEqual([a1, a2, a3]);
    });

    it('removing a project association does not affect asset associations', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject('Project');
      const assetId = createAsset(projectId, 'source/asset.png');

      repository.replaceProjects(note.id, [projectId]);
      repository.replaceAssets(note.id, [assetId]);
      repository.replaceProjects(note.id, []);

      expect(repository.listProjectsForNote(note.id)).toEqual([]);
      expect(repository.listAssetsForNote(note.id)).toEqual([assetId]);
    });

    it('removing an asset association does not affect project associations', () => {
      const note = repository.create({ title: 'Note' });
      const projectId = createProject('Project');
      const assetId = createAsset(projectId, 'source/asset.png');

      repository.replaceProjects(note.id, [projectId]);
      repository.replaceAssets(note.id, [assetId]);
      repository.replaceAssets(note.id, []);

      expect(repository.listProjectsForNote(note.id)).toEqual([projectId]);
      expect(repository.listAssetsForNote(note.id)).toEqual([]);
    });

    it('saves a note and both independent association sets together', () => {
      const projectId = createProject('Project');
      const assetId = createAsset(projectId, 'source/asset.png');

      const result = repository.saveWithAssociations({
        title: 'Atomic note',
        content: 'body',
        projectIds: [projectId],
        assetIds: [assetId],
      });

      expect(result.note).toMatchObject({ title: 'Atomic note', content: 'body' });
      expect(result.projectIds).toEqual([projectId]);
      expect(result.assetIds).toEqual([assetId]);
    });

    it('rolls back note creation when an association write fails', () => {
      const projectId = createProject('Project');
      const assetId = createAsset(projectId, 'source/asset.png');
      db.exec(`
        CREATE TRIGGER fail_atomic_note_create
        BEFORE INSERT ON note_assets
        BEGIN
          SELECT RAISE(ABORT, 'forced atomic note create failure');
        END
      `);

      expect(() => repository.saveWithAssociations({
        title: 'Should roll back',
        content: 'body',
        projectIds: [projectId],
        assetIds: [assetId],
      })).toThrow(/forced atomic note create failure/);

      expect(repository.list()).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM note_projects').get().count).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM note_assets').get().count).toBe(0);
    });

    it('rolls back note fields and both association replacements when an update fails', () => {
      const firstProjectId = createProject('First project');
      const secondProjectId = createProject('Second project');
      const firstAssetId = createAsset(firstProjectId, 'source/first.png');
      const secondAssetId = createAsset(secondProjectId, 'source/second.png');
      const note = repository.saveWithAssociations({
        title: 'Before',
        content: 'original',
        projectIds: [firstProjectId],
        assetIds: [firstAssetId],
      }).note;

      db.exec(`
        CREATE TRIGGER fail_atomic_note_update
        BEFORE INSERT ON note_assets
        BEGIN
          SELECT RAISE(ABORT, 'forced atomic note update failure');
        END
      `);

      expect(() => repository.saveWithAssociations({
        id: note.id,
        title: 'After',
        content: 'changed',
        projectIds: [secondProjectId],
        assetIds: [secondAssetId],
      })).toThrow(/forced atomic note update failure/);

      expect(repository.findById(note.id)).toMatchObject({ title: 'Before', content: 'original' });
      expect(repository.listProjectsForNote(note.id)).toEqual([firstProjectId]);
      expect(repository.listAssetsForNote(note.id)).toEqual([firstAssetId]);
    });
  });

  // ─── Chapter hierarchy ─────────────────────────────────────────────────

  describe('Chapter hierarchy', () => {
    function createBook(title, sortOrder) {
      return Number(db.prepare('INSERT INTO books (title, sort_order) VALUES (?, ?)')
        .run(title, sortOrder).lastInsertRowid);
    }

    function createChapter(bookId, title, sortOrder) {
      return Number(db.prepare(`
        INSERT INTO chapters (book_id, title, sort_order)
        VALUES (?, ?, ?)
      `).run(bookId, title, sortOrder).lastInsertRowid);
    }

    function createProject(title) {
      return Number(db.prepare(`
        INSERT INTO projects (title, slug, status) VALUES (?, ?, 'tbd')
      `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
    }

    function createAsset(projectId, relativePath) {
      const filename = relativePath.split('/').pop();
      return Number(db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename)
        VALUES (?, ?, ?)
      `).run(projectId, relativePath, filename).lastInsertRowid);
    }

    it('requires a Book and appends independently in each Chapter', () => {
      expect(() => strictCreate({ chapterId: defaultChapterId, title: 'Missing Book' }))
        .toThrow(NoteError);
      expect(() => rawCreate({ chapterId: 999999, title: 'Missing Parent' })).toThrow(NoteError);

      const bookId = createBook('Scoped Book', 1);
      const firstChapterId = createChapter(bookId, 'First', 0);
      const secondChapterId = createChapter(bookId, 'Second', 1);
      const first = rawCreate({ chapterId: firstChapterId, title: 'First note' });
      const second = rawCreate({ chapterId: firstChapterId, title: 'Second note' });
      const other = rawCreate({ chapterId: secondChapterId, title: 'Other note' });

      expect([first.chapter_id, first.sort_order]).toEqual([firstChapterId, 0]);
      expect([second.chapter_id, second.sort_order]).toEqual([firstChapterId, 1]);
      expect([other.chapter_id, other.sort_order]).toEqual([secondChapterId, 0]);
    });

    it('lists only one Chapter by sort_order then id and keeps list() hierarchy-aware', () => {
      const firstBookId = createBook('First Book', 2);
      const secondBookId = createBook('Second Book', 1);
      const lateChapterId = createChapter(firstBookId, 'Late Chapter', 1);
      const earlyChapterId = createChapter(firstBookId, 'Early Chapter', 0);
      const secondBookChapterId = createChapter(secondBookId, 'Only Chapter', 0);
      const insert = db.prepare(`
        INSERT INTO notes (book_id, chapter_id, title, content, sort_order)
        VALUES (?, ?, ?, '', ?)
      `);
      const late = Number(insert.run(firstBookId, lateChapterId, 'Late', 0).lastInsertRowid);
      const earlySecond = Number(insert.run(firstBookId, earlyChapterId, 'Early second', 1).lastInsertRowid);
      const earlyFirst = Number(insert.run(firstBookId, earlyChapterId, 'Early first', 0).lastInsertRowid);
      const otherBook = Number(insert.run(secondBookId, secondBookChapterId, 'Other book', 0).lastInsertRowid);

      expect(repository.listForChapter(earlyChapterId).map((note) => note.id))
        .toEqual([earlyFirst, earlySecond]);
      expect(repository.listForChapter(lateChapterId).map((note) => note.id)).toEqual([late]);
      expect(repository.list().map((note) => note.id)).toEqual([
        otherBook,
        earlyFirst,
        earlySecond,
        late,
      ]);
    });

    it('lists project and asset associations in hierarchy order', () => {
      const firstBookId = createBook('Association First Book', 4);
      const secondBookId = createBook('Association Second Book', 3);
      const lateChapterId = createChapter(firstBookId, 'Late', 1);
      const earlyChapterId = createChapter(firstBookId, 'Early', 0);
      const otherBookChapterId = createChapter(secondBookId, 'Only', 0);
      const late = rawCreate({ chapterId: lateChapterId, title: 'Late' });
      const early = rawCreate({ chapterId: earlyChapterId, title: 'Early' });
      const otherBook = rawCreate({ chapterId: otherBookChapterId, title: 'Other book' });
      const projectId = createProject('Hierarchy Association Project');
      const assetId = createAsset(projectId, 'source/hierarchy.png');

      for (const note of [late, early, otherBook]) {
        repository.replaceProjects(note.id, [projectId]);
        repository.replaceAssets(note.id, [assetId]);
      }

      expect(repository.listForProject(projectId).map((note) => note.id))
        .toEqual([otherBook.id, early.id, late.id]);
      expect(repository.listForAsset(assetId).map((note) => note.id))
        .toEqual([otherBook.id, early.id, late.id]);
    });

    it('reorders an exact Chapter permutation without affecting other Chapters or timestamps', () => {
      const bookId = createBook('Reorder Book', 3);
      const chapterId = createChapter(bookId, 'Reorder', 0);
      const otherChapterId = createChapter(bookId, 'Other', 1);
      const first = rawCreate({ chapterId, title: 'First' });
      const second = rawCreate({ chapterId, title: 'Second' });
      const third = rawCreate({ chapterId, title: 'Third' });
      const other = rawCreate({ chapterId: otherChapterId, title: 'Other' });
      const beforeTimestamps = repository.listForChapter(chapterId)
        .map((note) => [note.id, note.updated_at]);

      const reordered = rawReorder(chapterId, [third.id, first.id, second.id]);

      expect(reordered.map((note) => [note.id, note.sort_order])).toEqual([
        [third.id, 0],
        [first.id, 1],
        [second.id, 2],
      ]);
      expect(repository.listForChapter(otherChapterId)).toEqual([other]);
      expect(repository.listForChapter(chapterId).map((note) => [note.id, note.updated_at]))
        .toEqual(beforeTimestamps.sort((a, b) => [third.id, first.id, second.id].indexOf(a[0])
          - [third.id, first.id, second.id].indexOf(b[0])));
    });

    it('rejects duplicate, missing, extra, and cross-Chapter reorder IDs without mutation', () => {
      const bookId = createBook('Validation Book', 4);
      const chapterId = createChapter(bookId, 'Target', 0);
      const otherChapterId = createChapter(bookId, 'Other', 1);
      const first = rawCreate({ chapterId, title: 'First' });
      const second = rawCreate({ chapterId, title: 'Second' });
      const other = rawCreate({ chapterId: otherChapterId, title: 'Other' });
      const beforeTarget = repository.listForChapter(chapterId);
      const beforeOther = repository.listForChapter(otherChapterId);

      for (const orderedIds of [
        [first.id, first.id],
        [first.id],
        [first.id, 999999],
        [first.id, other.id],
      ]) {
        expect(() => rawReorder(chapterId, orderedIds)).toThrow(NoteError);
        expect(repository.listForChapter(chapterId)).toEqual(beforeTarget);
        expect(repository.listForChapter(otherChapterId)).toEqual(beforeOther);
      }
    });

    it('deletes atomically, cascades associations, compacts only its source Chapter, and preserves timestamps', () => {
      const bookId = createBook('Delete Book', 5);
      const chapterId = createChapter(bookId, 'Source', 0);
      const otherChapterId = createChapter(bookId, 'Other', 1);
      const first = rawCreate({ chapterId, title: 'First' });
      const deleted = rawCreate({ chapterId, title: 'Deleted' });
      const last = rawCreate({ chapterId, title: 'Last' });
      const other = rawCreate({ chapterId: otherChapterId, title: 'Other' });
      const projectId = createProject('Delete Project');
      const assetId = createAsset(projectId, 'source/delete.png');
      repository.replaceProjects(deleted.id, [projectId]);
      repository.replaceAssets(deleted.id, [assetId]);
      const sourceTimestamps = repository.listForChapter(chapterId)
        .filter((note) => note.id !== deleted.id)
        .map((note) => [note.id, note.updated_at]);

      expect(repository.deleteById(deleted.id)).toBe(true);
      expect(repository.findById(deleted.id)).toBeUndefined();
      expect(repository.listProjectsForNote(deleted.id)).toEqual([]);
      expect(repository.listAssetsForNote(deleted.id)).toEqual([]);
      expect(repository.listForChapter(chapterId).map((note) => [note.id, note.sort_order]))
        .toEqual([[first.id, 0], [last.id, 1]]);
      expect(repository.listForChapter(chapterId).map((note) => [note.id, note.updated_at]))
        .toEqual(sourceTimestamps);
      expect(repository.listForChapter(otherChapterId)).toEqual([other]);
      expect(repository.deleteById(999999)).toBe(false);
    });

    it('moves a Note to empty and populated Chapters by append while preserving content, timestamps, and associations', () => {
      const bookId = createBook('Move Book', 6);
      const sourceChapterId = createChapter(bookId, 'Source', 0);
      const emptyChapterId = createChapter(bookId, 'Empty', 1);
      const populatedChapterId = createChapter(bookId, 'Populated', 2);
      const first = rawCreate({ chapterId: sourceChapterId, title: 'First', content: 'first body' });
      const moved = rawCreate({ chapterId: sourceChapterId, title: 'Moved', content: 'moved body' });
      const destination = rawCreate({ chapterId: populatedChapterId, title: 'Destination' });
      const projectId = createProject('Move Project');
      const assetId = createAsset(projectId, 'source/move.png');
      repository.replaceProjects(moved.id, [projectId]);
      repository.replaceAssets(moved.id, [assetId]);
      const beforeMove = repository.findById(moved.id);

      const movedToEmpty = repository.moveToChapter(moved.id, emptyChapterId);
      expect(movedToEmpty).toMatchObject({
        id: moved.id,
        chapter_id: emptyChapterId,
        sort_order: 0,
        title: beforeMove.title,
        content: beforeMove.content,
        created_at: beforeMove.created_at,
        updated_at: beforeMove.updated_at,
      });
      expect(repository.listForChapter(sourceChapterId).map((note) => [note.id, note.sort_order]))
        .toEqual([[first.id, 0]]);
      expect(repository.listProjectsForNote(moved.id)).toEqual([projectId]);
      expect(repository.listAssetsForNote(moved.id)).toEqual([assetId]);

      const movedToPopulated = repository.moveToChapter(moved.id, populatedChapterId);
      expect(movedToPopulated).toMatchObject({ chapter_id: populatedChapterId, sort_order: 1 });
      expect(repository.listForChapter(populatedChapterId).map((note) => note.id))
        .toEqual([destination.id, moved.id]);
      expect(repository.findById(moved.id)).toMatchObject({
        title: beforeMove.title,
        content: beforeMove.content,
        created_at: beforeMove.created_at,
        updated_at: beforeMove.updated_at,
      });
    });

    it('defines same-Chapter move as a no-op and distinguishes missing Notes from missing destinations', () => {
      const bookId = createBook('Move Validation Book', 7);
      const chapterId = createChapter(bookId, 'Source', 0);
      const note = rawCreate({ chapterId, title: 'Note' });
      const before = repository.findById(note.id);

      expect(repository.moveToChapter(note.id, chapterId)).toEqual(before);
      expect(repository.moveToChapter(999999, chapterId)).toBeUndefined();
      try {
        repository.moveToChapter(note.id, 999999);
        throw new Error('Expected a missing destination Chapter error.');
      } catch (error) {
        expect(error).toBeInstanceOf(NoteError);
        expect(error.code).toBe('TARGET_CHAPTER_NOT_FOUND');
      }
      expect(repository.findById(note.id)).toEqual(before);
    });

    it('rolls back a cross-Chapter move when source compaction fails', () => {
      const bookId = createBook('Move Rollback Book', 8);
      const sourceChapterId = createChapter(bookId, 'Source', 0);
      const destinationChapterId = createChapter(bookId, 'Destination', 1);
      const moved = rawCreate({ chapterId: sourceChapterId, title: 'Moved' });
      const survivor = rawCreate({ chapterId: sourceChapterId, title: 'Survivor' });
      const destination = rawCreate({ chapterId: destinationChapterId, title: 'Destination' });
      const projectId = createProject('Rollback Project');
      const assetId = createAsset(projectId, 'source/rollback.png');
      repository.replaceProjects(moved.id, [projectId]);
      repository.replaceAssets(moved.id, [assetId]);
      const beforeSource = repository.listForChapter(sourceChapterId);
      const beforeDestination = repository.listForChapter(destinationChapterId);
      const beforeProjects = repository.listProjectsForNote(moved.id);
      const beforeAssets = repository.listAssetsForNote(moved.id);

      db.exec(`
        CREATE TRIGGER fail_note_move_compaction
        BEFORE UPDATE OF sort_order ON notes
        WHEN OLD.chapter_id = ${sourceChapterId} AND OLD.sort_order >= 4 AND NEW.sort_order = 0
        BEGIN
          SELECT RAISE(ABORT, 'forced note move compaction failure');
        END
      `);

      expect(() => repository.moveToChapter(moved.id, destinationChapterId))
        .toThrow(/forced note move compaction failure/);
      expect(repository.findById(moved.id)).toMatchObject({ chapter_id: sourceChapterId, sort_order: 0 });
      expect(repository.listForChapter(sourceChapterId)).toEqual(beforeSource);
      expect(repository.listForChapter(destinationChapterId)).toEqual(beforeDestination);
      expect(repository.listProjectsForNote(moved.id)).toEqual(beforeProjects);
      expect(repository.listAssetsForNote(moved.id)).toEqual(beforeAssets);
      expect(repository.findById(survivor.id)).toMatchObject({ chapter_id: sourceChapterId, sort_order: 1 });
      expect(repository.findById(destination.id)).toMatchObject({ chapter_id: destinationChapterId, sort_order: 0 });
    });
  });

  // ─── Direct Book Pages ─────────────────────────────────────────────────

  describe('direct Book Pages', () => {
    function createBook(title, sortOrder) {
      return Number(db.prepare('INSERT INTO books (title, sort_order) VALUES (?, ?)')
        .run(title, sortOrder).lastInsertRowid);
    }

    function createChapter(bookId, title, sortOrder) {
      return Number(db.prepare(`
        INSERT INTO chapters (book_id, title, sort_order)
        VALUES (?, ?, ?)
      `).run(bookId, title, sortOrder).lastInsertRowid);
    }

    function createProject(title) {
      return Number(db.prepare(`
        INSERT INTO projects (title, slug, status) VALUES (?, ?, 'tbd')
      `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
    }

    function createAsset(projectId, relativePath) {
      const filename = relativePath.split('/').pop();
      return Number(db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename)
        VALUES (?, ?, ?)
      `).run(projectId, relativePath, filename).lastInsertRowid);
    }

    it('creates direct-Book and matching Chapter Pages', () => {
      const bookId = createBook('Create Book', 0);
      const chapterId = createChapter(bookId, 'Create Chapter', 0);

      const direct = strictCreate({ bookId, title: 'Direct' });
      const chapterPage = strictCreate({ bookId, chapterId, title: 'Chapter' });

      expect(direct).toMatchObject({ book_id: bookId, chapter_id: null, sort_order: 0 });
      expect(chapterPage).toMatchObject({ book_id: bookId, chapter_id: chapterId, sort_order: 0 });
    });

    it('rejects a Chapter Page whose Book does not match the Chapter', () => {
      const firstBookId = createBook('First Book', 0);
      const secondBookId = createBook('Second Book', 1);
      const chapterId = createChapter(firstBookId, 'First Chapter', 0);

      expect(() => strictCreate({ bookId: secondBookId, chapterId, title: 'Invalid' }))
        .toThrow(NoteError);
      expect(db.prepare('SELECT COUNT(*) AS count FROM notes').get().count).toBe(0);
    });

    it('returns direct-Book hierarchy fields from findById', () => {
      const bookId = createBook('Find Book', 0);
      const direct = strictCreate({ bookId, chapterId: null, title: 'Find Direct' });

      expect(repository.findById(direct.id)).toMatchObject({
        id: direct.id,
        book_id: bookId,
        chapter_id: null,
      });
    });

    it('lists only direct Pages for a Book in local order', () => {
      const bookId = createBook('List Book', 0);
      const otherBookId = createBook('Other Book', 1);
      const chapterId = createChapter(bookId, 'Chapter', 0);
      const first = strictCreate({ bookId, title: 'First Direct' });
      const chapterPage = strictCreate({ bookId, chapterId, title: 'Chapter Page' });
      const second = strictCreate({ bookId, title: 'Second Direct' });
      strictCreate({ bookId: otherBookId, title: 'Other Direct' });

      expect(repository.listForBook(bookId).map((note) => note.id)).toEqual([first.id, second.id]);
      expect(repository.listForBook(bookId).every((note) => note.chapter_id === null)).toBe(true);
      expect(repository.listForChapter(chapterId).map((note) => note.id)).toEqual([chapterPage.id]);
    });

    it('keeps hierarchy listing deterministic without defining mixed Book content order', () => {
      const bookId = createBook('Hierarchy Book', 0);
      const chapterId = createChapter(bookId, 'Chapter', 0);
      const chapterPage = strictCreate({ bookId, chapterId, title: 'Chapter Page' });
      const direct = strictCreate({ bookId, title: 'Direct Page' });

      expect(repository.listForBook(bookId).map((note) => note.id)).toEqual([direct.id]);
      expect(repository.list().filter((note) => note.book_id === bookId).map((note) => note.id))
        .toEqual([chapterPage.id, direct.id]);
    });

    it('reorders direct Pages without including Chapter Pages', () => {
      const bookId = createBook('Reorder Book', 0);
      const chapterId = createChapter(bookId, 'Chapter', 0);
      const chapterPage = strictCreate({ bookId, chapterId, title: 'Chapter Page' });
      const first = strictCreate({ bookId, title: 'First Direct' });
      const second = strictCreate({ bookId, title: 'Second Direct' });

      const reordered = repository.reorderForBook(bookId, [second.id, first.id]);

      expect(reordered.map((note) => [note.id, note.sort_order])).toEqual([
        [second.id, 0],
        [first.id, 1],
      ]);
      expect(repository.listForChapter(chapterId)).toEqual([chapterPage]);
    });

    it('moves a Chapter Page to a direct Book container', () => {
      const bookId = createBook('Chapter To Book', 0);
      const chapterId = createChapter(bookId, 'Source', 0);
      const existingDirect = strictCreate({ bookId, title: 'Existing Direct' });
      const moved = strictCreate({ bookId, chapterId, title: 'Moved' });

      const result = repository.moveToContainer(moved.id, { bookId, chapterId: null });

      expect(result).toMatchObject({ book_id: bookId, chapter_id: null, sort_order: 1 });
      expect(repository.listForChapter(chapterId)).toEqual([]);
      expect(repository.listForBook(bookId).map((note) => note.id))
        .toEqual([existingDirect.id, moved.id]);
    });

    it('moves a direct Book Page to a Chapter container', () => {
      const bookId = createBook('Book To Chapter', 0);
      const chapterId = createChapter(bookId, 'Target', 0);
      const destination = strictCreate({ bookId, chapterId, title: 'Destination' });
      const moved = strictCreate({ bookId, title: 'Moved' });

      const result = repository.moveToContainer(moved.id, { bookId, chapterId });

      expect(result).toMatchObject({ book_id: bookId, chapter_id: chapterId, sort_order: 1 });
      expect(repository.listForBook(bookId)).toEqual([]);
      expect(repository.listForChapter(chapterId).map((note) => note.id))
        .toEqual([destination.id, moved.id]);
    });

    it('moves a Page across Books into a Chapter with the matching target Book', () => {
      const sourceBookId = createBook('Source Book', 0);
      const targetBookId = createBook('Target Book', 1);
      const sourceChapterId = createChapter(sourceBookId, 'Source', 0);
      const targetChapterId = createChapter(targetBookId, 'Target', 0);
      const moved = strictCreate({ bookId: sourceBookId, chapterId: sourceChapterId, title: 'Moved' });

      const result = repository.moveToContainer(moved.id, {
        bookId: targetBookId,
        chapterId: targetChapterId,
      });

      expect(result).toMatchObject({
        book_id: targetBookId,
        chapter_id: targetChapterId,
        sort_order: 0,
      });
      expect(repository.listForChapter(sourceChapterId)).toEqual([]);
    });

    it('rejects a mismatched move target without changing the Page', () => {
      const firstBookId = createBook('First Book', 0);
      const secondBookId = createBook('Second Book', 1);
      const firstChapterId = createChapter(firstBookId, 'First', 0);
      const secondChapterId = createChapter(secondBookId, 'Second', 0);
      const moved = strictCreate({ bookId: firstBookId, chapterId: firstChapterId, title: 'Moved' });
      const before = repository.findById(moved.id);

      expect(() => repository.moveToContainer(moved.id, {
        bookId: firstBookId,
        chapterId: secondChapterId,
      })).toThrow(NoteError);
      expect(repository.findById(moved.id)).toEqual(before);
    });

    it('compacts direct-Book order without compacting Chapter order on delete', () => {
      const bookId = createBook('Delete Book', 0);
      const chapterId = createChapter(bookId, 'Chapter', 0);
      const first = strictCreate({ bookId, title: 'First Direct' });
      const deleted = strictCreate({ bookId, title: 'Deleted Direct' });
      const last = strictCreate({ bookId, title: 'Last Direct' });
      const chapterPage = strictCreate({ bookId, chapterId, title: 'Chapter Page' });

      expect(repository.deleteById(deleted.id)).toBe(true);
      expect(repository.listForBook(bookId).map((note) => [note.id, note.sort_order])).toEqual([
        [first.id, 0],
        [last.id, 1],
      ]);
      expect(repository.listForChapter(chapterId).map((note) => [note.id, note.sort_order]))
        .toEqual([[chapterPage.id, 0]]);
    });

    it('includes direct Pages in reverse project queries', () => {
      const bookId = createBook('Project Book', 0);
      const chapterId = createChapter(bookId, 'Chapter', 0);
      const projectId = createProject('Direct Project');
      const direct = strictCreate({ bookId, title: 'Direct' });
      const chapterPage = strictCreate({ bookId, chapterId, title: 'Chapter' });
      repository.replaceProjects(direct.id, [projectId]);
      repository.replaceProjects(chapterPage.id, [projectId]);

      expect(repository.listForProject(projectId).map((note) => note.id).sort((a, b) => a - b))
        .toEqual([direct.id, chapterPage.id].sort((a, b) => a - b));
    });

    it('includes direct Pages in reverse asset queries', () => {
      const bookId = createBook('Asset Book', 0);
      const chapterId = createChapter(bookId, 'Chapter', 0);
      const projectId = createProject('Direct Asset Project');
      const assetId = createAsset(projectId, 'source/direct.png');
      const direct = strictCreate({ bookId, title: 'Direct' });
      const chapterPage = strictCreate({ bookId, chapterId, title: 'Chapter' });
      repository.replaceAssets(direct.id, [assetId]);
      repository.replaceAssets(chapterPage.id, [assetId]);

      expect(repository.listForAsset(assetId).map((note) => note.id).sort((a, b) => a - b))
        .toEqual([direct.id, chapterPage.id].sort((a, b) => a - b));
    });

    it('preserves direct Page associations when moving containers', () => {
      const bookId = createBook('Association Book', 0);
      const chapterId = createChapter(bookId, 'Chapter', 0);
      const projectId = createProject('Association Project');
      const assetId = createAsset(projectId, 'source/associated.png');
      const direct = strictCreate({ bookId, title: 'Direct' });
      repository.replaceProjects(direct.id, [projectId]);
      repository.replaceAssets(direct.id, [assetId]);

      repository.moveToContainer(direct.id, { bookId, chapterId });

      expect(repository.listProjectsForNote(direct.id)).toEqual([projectId]);
      expect(repository.listAssetsForNote(direct.id)).toEqual([assetId]);
    });
  });
});
