import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

// WP6.2: POST /notes/projects/:projectId creates a Notes Page from Project
// Detail through the existing createNote() path. The route's Project is the
// Page's authoritative direct connection, selected Assets must be this
// Project's own, and the Move Page-style targetContainer picks the location.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function insertProject(db, title) {
  return Number(db.prepare(
    `INSERT INTO projects (title, slug, description, notes, status, patreon_url, project_type)
     VALUES (?, ?, '', '', 'tbd', NULL, 'images')`,
  ).run(title, title.toLowerCase().replace(/\s+/g, '-')).lastInsertRowid);
}

function insertAsset(db, projectId, filename) {
  return db.prepare(`
    INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at)
    VALUES (?, ?, ?, 'png', 'image/png', 1, 1, datetime('now'))
    RETURNING id
  `).get(projectId, filename, filename).id;
}

describe('POST /notes/projects/:projectId (Project Detail Create Page)', () => {
  let db;
  let app;
  let tmpDir;
  let agent;
  let csrfToken;
  let projectId;
  let otherProjectId;
  let book;
  let chapter;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-notes-project-create-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));

    projectId = insertProject(db, 'Host Project');
    otherProjectId = insertProject(db, 'Other Project');
    book = app.locals.bookService.createBook({ title: 'Lore Book' });
    chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Lore Chapter' });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const postJson = (id, body) => agent.post(`/notes/projects/${id}`)
    .set('Accept', 'application/json').type('form')
    .send({ _csrf: csrfToken, ...body });
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const counts = () => ({
    notes: count('notes'), projects: count('note_projects'), assets: count('note_assets'), contents: count('book_contents'),
  });
  const linkedProjects = (noteId) => db.prepare('SELECT project_id FROM note_projects WHERE note_id = ? ORDER BY project_id')
    .all(noteId).map((row) => row.project_id);
  const linkedAssets = (noteId) => db.prepare('SELECT asset_id FROM note_assets WHERE note_id = ? ORDER BY asset_id')
    .all(noteId).map((row) => row.asset_id);

  describe('valid creation', () => {
    it('creates a direct Book Page linked to the route Project and reports its identity', async () => {
      const response = await postJson(projectId, {
        title: 'Book page', content: '# Heading\n\nBody', targetContainer: `book:${book.id}`,
      }).expect(201);

      const { page } = response.body;
      expect(response.body).toMatchObject({
        status: 'success',
        message: 'Note “Book page” created.',
        page: { title: 'Book page', bookId: book.id, chapterId: null, projectIds: [projectId], assetIds: [] },
        project: { id: projectId, url: `/projects/${projectId}` },
        values: { title: '', content: '' },
      });
      expect(page.url).toBe(`/notes/${page.id}`);
      const stored = app.locals.noteService.getNote(page.id);
      expect(stored).toMatchObject({ book_id: book.id, chapter_id: null, content: '# Heading\n\nBody' });
      expect(linkedProjects(page.id)).toEqual([projectId]);
      expect(app.locals.bookService.listBookContents(book.id)
        .filter((item) => item.type === 'page').map((item) => item.id)).toEqual([page.id]);
    });

    it('creates a Chapter Page with the derived Book and the selected Project Assets', async () => {
      const first = insertAsset(db, projectId, 'a.png');
      const second = insertAsset(db, projectId, 'b.png');
      const response = await postJson(projectId, {
        title: 'Chapter page', targetContainer: `chapter:${chapter.id}`, assetIds: [String(second), String(first), String(first)],
      }).expect(201);

      const id = response.body.page.id;
      expect(response.body.page).toMatchObject({ bookId: book.id, chapterId: chapter.id, projectIds: [projectId] });
      expect(response.body.page.assetIds.slice().sort((a, b) => a - b)).toEqual([first, second]);
      expect(linkedProjects(id)).toEqual([projectId]);
      expect(linkedAssets(id)).toEqual([first, second].sort((a, b) => a - b));
      expect(app.locals.noteService.getNote(id)).toMatchObject({ book_id: book.id, chapter_id: chapter.id });
    });

    it('accepts an Asset whose physical file is missing', async () => {
      const missing = insertAsset(db, projectId, 'gone.png');
      db.prepare("UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?").run(missing);
      const response = await postJson(projectId, {
        title: 'Missing asset page', targetContainer: `book:${book.id}`, assetIds: String(missing),
      }).expect(201);
      expect(linkedAssets(response.body.page.id)).toEqual([missing]);
    });

    it('appears in the Project read model through its direct Project connection', async () => {
      const response = await postJson(projectId, { title: 'Direct', targetContainer: `book:${book.id}` }).expect(201);
      const { notes } = app.locals.noteService.listRelatedNotesForProject(projectId);
      expect(notes.map((note) => note.id)).toContain(response.body.page.id);
    });
  });

  describe('project enforcement', () => {
    it('keeps the route Project when project fields are omitted, empty-listed or repeat it', async () => {
      for (const extra of [{}, { projectIds: String(projectId) }, { projectId: String(projectId), projectIds: [String(projectId)] }]) {
        const response = await postJson(projectId, { title: 'Kept', targetContainer: `book:${book.id}`, ...extra }).expect(201);
        expect(linkedProjects(response.body.page.id)).toEqual([projectId]);
      }
    });

    it.each([
      ['another projectIds value', () => ({ projectIds: String(otherProjectId) })],
      ['an additional projectIds value', () => ({ projectIds: [String(projectId), String(otherProjectId)] })],
      ['a conflicting projectId', () => ({ projectId: String(otherProjectId) })],
      ['a malformed projectIds value', () => ({ projectIds: 'abc' })],
    ])('refuses %s without creating anything', async (_label, extra) => {
      const before = counts();
      const response = await postJson(projectId, { title: 'Conflict', targetContainer: `book:${book.id}`, ...extra() }).expect(422);
      expect(response.body).toMatchObject({ status: 'error', code: 'VALIDATION', errors: { projectIds: expect.any(String) } });
      expect(counts()).toEqual(before);
    });

    it.each(['abc', '0', '01', '999999'])('reports project %s as unavailable', async (id) => {
      const before = counts();
      const response = await postJson(id, { title: 'Nowhere', targetContainer: `book:${book.id}` }).expect(404);
      expect(response.body).toEqual({
        status: 'error', code: 'PROJECT_NOT_FOUND', message: 'This project is no longer available.',
      });
      expect(counts()).toEqual(before);
    });

    it('keeps archived Projects eligible, as Notes connections already allow', async () => {
      db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(projectId);
      const assetId = insertAsset(db, projectId, 'archived.png');
      const response = await postJson(projectId, {
        title: 'Archived host', targetContainer: `book:${book.id}`, assetIds: String(assetId),
      }).expect(201);
      expect(linkedProjects(response.body.page.id)).toEqual([projectId]);
      expect(linkedAssets(response.body.page.id)).toEqual([assetId]);
    });

    it('still requires the CSRF token', async () => {
      const before = counts();
      await agent.post(`/notes/projects/${projectId}`).set('Accept', 'application/json').type('form')
        .send({ title: 'No token', targetContainer: `book:${book.id}` }).expect(403);
      expect(counts()).toEqual(before);
    });
  });

  describe('asset validation', () => {
    it('refuses another Project\'s Asset, even alongside an eligible one, without creating anything', async () => {
      const own = insertAsset(db, projectId, 'own.png');
      const foreign = insertAsset(db, otherProjectId, 'foreign.png');
      const before = counts();
      const response = await postJson(projectId, {
        title: 'Foreign', targetContainer: `chapter:${chapter.id}`, assetIds: [String(own), String(foreign)],
      }).expect(422);
      expect(response.body.errors).toEqual({ assetIds: `Asset ${foreign} does not belong to this project.` });
      expect(counts()).toEqual(before);
    });

    it.each([
      ['nonexistent', '987654', /not found/],
      ['malformed', 'x1', /positive integer/],
    ])('refuses a %s Asset ID through the existing validation', async (_label, value, message) => {
      const before = counts();
      const response = await postJson(projectId, {
        title: 'Bad asset', targetContainer: `book:${book.id}`, assetIds: value,
      }).expect(422);
      expect(response.body.errors.assetIds).toMatch(message);
      expect(counts()).toEqual(before);
    });
  });

  describe('location validation', () => {
    it.each([
      ['missing', {}],
      ['empty', { targetContainer: '' }],
      ['repeated', { targetContainer: [`book:1`, `book:1`] }],
      ['badly formatted', { targetContainer: 'shelf:1' }],
      ['non-canonical', { targetContainer: 'book:01' }],
    ])('refuses a %s location', async (_label, location) => {
      const before = counts();
      const response = await postJson(projectId, { title: 'Where', ...location }).expect(422);
      expect(response.body).toMatchObject({ code: 'VALIDATION', errors: { targetContainer: expect.any(String) } });
      expect(counts()).toEqual(before);
    });

    it('does not fall back to legacy parent fields when targetContainer is absent', async () => {
      const before = counts();
      const response = await postJson(projectId, { title: 'Legacy', bookId: String(book.id) }).expect(422);
      expect(response.body.errors).toHaveProperty('targetContainer');
      expect(counts()).toEqual(before);
    });

    it.each([
      ['Book', () => `book:${book.id + 1000}`, 'BOOK_NOT_FOUND'],
      ['Chapter', () => `chapter:${chapter.id + 1000}`, 'CHAPTER_NOT_FOUND'],
    ])('reports a nonexistent %s as unavailable', async (_label, target, code) => {
      const before = counts();
      const response = await postJson(projectId, { title: 'Gone', targetContainer: target() }).expect(404);
      expect(response.body.code).toBe(code);
      expect(counts()).toEqual(before);
    });

    it.each([
      ['a chapterId with a Book location', () => ({ targetContainer: `book:${book.id}`, chapterId: String(chapter.id) })],
      ['a different bookId with a Book location', () => ({ targetContainer: `book:${book.id}`, bookId: String(book.id + 1) })],
      ['a different chapterId with a Chapter location', () => ({ targetContainer: `chapter:${chapter.id}`, targetChapterId: String(chapter.id + 1) })],
      ['a malformed bookId with a Chapter location', () => ({ targetContainer: `chapter:${chapter.id}`, bookId: 'x' })],
    ])('refuses %s', async (_label, location) => {
      const before = counts();
      const response = await postJson(projectId, { title: 'Contradiction', ...location() }).expect(422);
      expect(response.body.code).toBe('VALIDATION');
      expect(counts()).toEqual(before);
    });

    it('refuses a Chapter location paired with another Book through the service hierarchy check', async () => {
      const otherBook = app.locals.bookService.createBook({ title: 'Other Book' });
      const before = counts();
      const response = await postJson(projectId, {
        title: 'Mismatch', targetContainer: `chapter:${chapter.id}`, bookId: String(otherBook.id),
      }).expect(422);
      expect(response.body.errors).toHaveProperty('chapterId');
      expect(counts()).toEqual(before);
    });

    it('accepts a matching bookId submitted with a Chapter location', async () => {
      const response = await postJson(projectId, {
        title: 'Consistent', targetContainer: `chapter:${chapter.id}`, bookId: String(book.id),
      }).expect(201);
      expect(response.body.page).toMatchObject({ bookId: book.id, chapterId: chapter.id });
    });

    // WP6.2-F1: the form parser turns `bookId[toString]=1` into an object whose
    // toString is a string; coercing it used to throw and answer 500.
    const postRaw = (id, fields) => agent.post(`/notes/projects/${id}`)
      .set('Accept', 'application/json').type('form')
      .send([`_csrf=${encodeURIComponent(csrfToken)}`, ...fields].join('&'));

    describe.each(['bookId', 'chapterId', 'targetBookId', 'targetChapterId'])('a malformed %s', (key) => {
      it.each([
        ['Book', () => `book:${book.id}`],
        ['Chapter', () => `chapter:${chapter.id}`],
      ])('is a validation error with a %s location, not an internal failure', async (_label, target) => {
        const before = counts();
        const response = await postRaw(projectId, [
          'title=Probe', `targetContainer=${encodeURIComponent(target())}`, `${key}[toString]=1`,
        ]);
        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({ status: 'error', code: 'VALIDATION', errors: { [key]: expect.any(String) } });
        expect(counts()).toEqual(before);
      });

      it('is a validation error when nested inside a repeated value', async () => {
        const before = counts();
        const response = await postRaw(projectId, [
          'title=Probe', `targetContainer=${encodeURIComponent(`chapter:${chapter.id}`)}`, `${key}[0][toString]=1`,
        ]);
        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({ status: 'error', code: 'VALIDATION', errors: { [key]: expect.any(String) } });
        expect(counts()).toEqual(before);
      });
    });

    it('accepts matching optional parent identifiers with Book and Chapter locations', async () => {
      const direct = await postJson(projectId, {
        title: 'Matching Book', targetContainer: `book:${book.id}`, bookId: String(book.id), targetBookId: String(book.id),
      }).expect(201);
      expect(direct.body.page).toMatchObject({ bookId: book.id, chapterId: null });

      const nested = await postJson(projectId, {
        title: 'Matching Chapter',
        targetContainer: `chapter:${chapter.id}`,
        bookId: String(book.id),
        targetBookId: String(book.id),
        chapterId: String(chapter.id),
        targetChapterId: String(chapter.id),
      }).expect(201);
      expect(nested.body.page).toMatchObject({ bookId: book.id, chapterId: chapter.id });
      expect(linkedProjects(nested.body.page.id)).toEqual([projectId]);
    });

    it('still refuses a repeated optional parent identifier as a contradiction', async () => {
      const before = counts();
      const response = await postJson(projectId, {
        title: 'Repeated', targetContainer: `book:${book.id}`, bookId: [String(book.id), String(book.id)],
      }).expect(422);
      expect(response.body.errors).toEqual({ bookId: 'This does not match the chosen Note location.' });
      expect(counts()).toEqual(before);
    });
  });

  describe('save behaviour and regressions', () => {
    it('keeps the existing title validation and leaves nothing behind', async () => {
      const assetId = insertAsset(db, projectId, 'kept.png');
      const before = counts();
      const response = await postJson(projectId, {
        title: '   ', content: 'draft', targetContainer: `book:${book.id}`, assetIds: String(assetId),
      }).expect(422);
      expect(response.body).toEqual({
        status: 'error', code: 'VALIDATION', message: 'Fix the highlighted fields and try again.',
        errors: { title: 'Title is required.' },
      });
      expect(counts()).toEqual(before);
    });

    it('calls createNote once and rolls back nothing-partial on an unexpected failure', async () => {
      const original = app.locals.noteService.createNote;
      let calls = 0;
      app.locals.noteService.createNote = (input) => {
        calls += 1;
        original(input);
        throw new Error('boom');
      };
      const before = counts();
      try {
        const response = await postJson(projectId, { title: 'Boom', targetContainer: `book:${book.id}` }).expect(500);
        expect(response.body).toEqual({
          status: 'error', code: 'PAGE_OPERATION_FAILED', message: 'The Note could not be created. No changes were made.',
        });
      } finally {
        app.locals.noteService.createNote = original;
      }
      expect(calls).toBe(1);
      expect(counts()).toEqual(before);
    });

    it('redirects a native submission to the new Page', async () => {
      const response = await agent.post(`/notes/projects/${projectId}`).type('form')
        .send({ _csrf: csrfToken, title: 'Native', targetContainer: `book:${book.id}` }).expect(302);
      expect(response.headers.location).toMatch(/^\/notes\/\d+$/);
    });

    it('leaves ordinary POST /notes creation unchanged', async () => {
      const assetId = insertAsset(db, otherProjectId, 'elsewhere.png');
      const response = await agent.post('/notes').set('Accept', 'application/json').type('form').send({
        _csrf: csrfToken, bookId: String(book.id), title: 'Ordinary',
        projectIds: [String(projectId), String(otherProjectId)], assetIds: String(assetId),
      }).expect(201);
      expect(Object.keys(response.body.page).sort()).toEqual(['bookId', 'chapterId', 'id', 'title', 'url']);
      expect(linkedProjects(response.body.page.id)).toEqual([projectId, otherProjectId]);
      expect(linkedAssets(response.body.page.id)).toEqual([assetId]);
    });
  });
});
