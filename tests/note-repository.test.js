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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-notes-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    repository = createNoteRepository(db);
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
      expect(names).toContain('title');
      expect(names).toContain('content');
      expect(names).toContain('sort_order');
      expect(names).toContain('created_at');
      expect(names).toContain('updated_at');
    });

    it('enforces sort_order >= 0', () => {
      expect(() => {
        db.exec("INSERT INTO notes (title, content, sort_order) VALUES ('t', 'c', -1)");
      }).toThrow(/constraint/i);
    });

    it('defaults title and content to empty strings', () => {
      db.exec("INSERT INTO notes (sort_order) VALUES (0)");
      const row = db.prepare('SELECT title, content FROM notes WHERE id = 1').get();
      expect(row.title).toBe('');
      expect(row.content).toBe('');
    });

    it('defaults sort_order to 0', () => {
      db.exec("INSERT INTO notes (title, content) VALUES ('t', 'c')");
      const row = db.prepare('SELECT sort_order FROM notes WHERE id = 1').get();
      expect(row.sort_order).toBe(0);
    });

    it('auto-increments id', () => {
      db.exec("INSERT INTO notes (title, content) VALUES ('a', 'b')");
      db.exec("INSERT INTO notes (title, content) VALUES ('c', 'd')");
      const ids = db.prepare('SELECT id FROM notes ORDER BY id').all().map((r) => r.id);
      expect(ids).toEqual([1, 2]);
    });

    it('sets created_at and updated_at automatically', () => {
      db.exec("INSERT INTO notes (title, content) VALUES ('t', 'c')");
      const row = db.prepare('SELECT created_at, updated_at FROM notes WHERE id = 1').get();
      expect(row.created_at).toBeTruthy();
      expect(row.updated_at).toBeTruthy();
    });

    it('allows content to hold multi-line markdown text', () => {
      const markdown = '# Heading\n\nParagraph with **bold**.\n\n- item 1\n- item 2\n';
      db.prepare("INSERT INTO notes (title, content, sort_order) VALUES (?, ?, 0)").run('t', markdown);
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
      // surviving: sort_orders 0 and 2, MAX(sort_order) = 2
      const fourth = repository.create({ title: 'Fourth' });
      expect(fourth.sort_order).toBe(3);
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
        CREATE UNIQUE INDEX notes_sort_order_unique
        ON notes(sort_order)
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
});
