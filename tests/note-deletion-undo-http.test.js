import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createNoteDeletionSnapshotRepository } from '../src/data/note-deletion-snapshot-repository.js';
import { deriveDisabledModeCsrfToken } from '../src/middleware/csrf.js';
import { createNoteDeletionId } from '../src/services/note-service.js';
import { AUTH_CONFIG, extractCsrfToken, TEST_PASSWORD, TEST_USERNAME } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const ELEVEN_MINUTES_MS = 11 * 60 * 1000;
const LOCATOR = /^[0-9a-f]{64}$/;
const SECRET_BODY = 'Secret body of the deleted Page';

describe.each(['disabled', 'session'])('Page deletion recovery over HTTP (%s identity)', (mode) => {
  let root;
  let db;
  let projectsRoot;
  let csrfPepper;
  let app;
  let me;

  function buildApp(extra = {}) {
    return createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot: root,
      authState: { csrfPepper },
      ...(mode === 'session' ? { authConfig: AUTH_CONFIG } : {}),
      ...extra,
    });
  }

  function cookiesFrom(response, jar = {}) {
    for (const line of response.headers['set-cookie'] || []) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      jar[pair.slice(0, index)] = pair.slice(index + 1);
    }
    return jar;
  }

  const cookieHeader = (jar) => Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; ');

  // Real cookies and real session rows, so an identity can cross an app restart.
  async function identify(target = app) {
    if (mode === 'disabled') {
      const jar = cookiesFrom(await request(target).get('/health'));
      return {
        cookie: cookieHeader(jar),
        csrf: deriveDisabledModeCsrfToken(csrfPepper, decodeURIComponent(jar.cc_csrf_anon)),
      };
    }
    const loginPage = await request(target).get('/login').expect(200);
    const jar = cookiesFrom(loginPage);
    const login = await request(target).post('/login').set('Cookie', cookieHeader(jar)).type('form')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD, _csrf: extractCsrfToken(loginPage.text) })
      .expect(302);
    cookiesFrom(login, jar);
    const cookie = cookieHeader(jar);
    return { cookie, csrf: await csrfFor(target, cookie) };
  }

  async function csrfFor(target, cookie) {
    const page = await request(target).get('/projects/new').set('Cookie', cookie).expect(200);
    return extractCsrfToken(page.text);
  }

  const read = (url, who = me, target = app) => request(target).get(url)
    .set('Cookie', who.cookie).set('Accept', 'application/json');

  const postDelete = (noteId, deletionId, { who = me, target = app, accept = 'application/json', csrf = who.csrf } = {}) => request(target)
    .post(`/notes/${noteId}/delete`)
    .set('Cookie', who.cookie).set('Accept', accept).type('form')
    .send({ _csrf: csrf, ...(deletionId === undefined ? {} : { deletionId }) });

  const postRestore = (deletionId, undoToken, { who = me, target = app, csrf = who.csrf } = {}) => request(target)
    .post(`/notes/page-deletions/${deletionId}/restore`)
    .set('Cookie', who.cookie).set('Accept', 'application/json').type('form')
    .send({ _csrf: csrf, ...(undoToken === undefined ? {} : { undoToken }) });

  function seed(target = app) {
    const { bookService, chapterService, noteService } = target.locals;
    const book = bookService.createBook({ title: 'Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
    const first = noteService.createNote({ chapterId: chapter.id, title: 'First', content: 'one' });
    const note = noteService.createNote({ chapterId: chapter.id, title: 'Doomed', content: SECRET_BODY });
    const last = noteService.createNote({ chapterId: chapter.id, title: 'Last', content: 'three' });
    noteService.updateNote(note.id, { title: 'Doomed', content: `${SECRET_BODY} revised` });
    const direct = noteService.createNote({ bookId: book.id, title: 'Direct', content: 'direct' });
    return { book, chapter, first, note, last, direct };
  }

  const snapshotCount = () => db.prepare('SELECT COUNT(*) AS n FROM note_deletion_snapshots').get().n;
  const revisionIds = (noteId) => db.prepare('SELECT id FROM note_revisions WHERE note_id = ? ORDER BY id').all(noteId).map(({ id }) => id);
  const ownerKeyOf = (deletionId) => db.prepare('SELECT owner_key FROM note_deletion_snapshots WHERE id = ?').pluck().get(deletionId);

  function expectNoSecrets(text, deletionId) {
    expect(text).not.toContain(SECRET_BODY);
    expect(text).not.toContain('snapshot_json');
    expect(text).not.toContain('owner_key');
    expect(text).not.toContain('ownerKey');
    expect(text).not.toContain(csrfPepper);
    if (deletionId) expect(text).not.toContain(ownerKeyOf(deletionId));
  }

  async function deleteOk(noteId, deletionId = createNoteDeletionId(), options = {}) {
    const response = await postDelete(noteId, deletionId, options).expect(200);
    return { deletionId, response };
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-undo-http-'));
    projectsRoot = path.join(root, 'projects');
    fs.mkdirSync(projectsRoot);
    db = openDatabase(path.join(root, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    ({ csrfPepper } = ensureAuthEnablement(root));
    app = buildApp();
    me = await identify();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('Delete', () => {
    it('renders a fresh locator in every Delete form and writes nothing until a confirmed POST', async () => {
      const { note, book, chapter } = seed();
      const locatorIn = (html) => html.match(/id="note-delete-form"[^>]*>\s*<input[^>]*name="_csrf"[^>]*>\s*<input type="hidden" name="deletionId" value="([^"]*)"/)?.[1];

      const detail = await read(`/notes/${note.id}`).set('Accept', 'text/html').expect(200);
      const again = await read(`/notes/${note.id}`).set('Accept', 'text/html').expect(200);
      const direct = await read(`/notes/${note.id}/edit`).set('Accept', 'text/html').expect(200);
      const invalid = await request(app).post(`/notes/${note.id}`).set('Cookie', me.cookie).type('form')
        .send({ _csrf: me.csrf, title: '', content: '' }).expect(422);
      const locators = [detail, again, direct, invalid].map(({ text }) => locatorIn(text));
      for (const locator of locators) expect(locator).toMatch(LOCATOR);
      expect(new Set(locators).size).toBe(4);
      expect(detail.text).not.toContain('undoToken');

      // New Page forms delete nothing, so they carry nothing.
      expect((await read(`/notes/new?chapterId=${chapter.id}`).set('Accept', 'text/html')).text).not.toContain('name="deletionId"');
      expect((await read(`/notes/books/${book.id}`).set('Accept', 'text/html')).text).not.toContain('name="deletionId"');

      // Rendering, as a cancelled confirmation leaves it, creates no opportunity.
      expect(snapshotCount()).toBe(0);
      expect(app.locals.noteRepository.findById(note.id)).toBeDefined();
      await read(`/notes/page-deletions/${locators[0]}`).expect(404);

      await postDelete(note.id, locators[0]).expect(200);
      expect(snapshotCount()).toBe(1);
      expect((await read(`/notes/page-deletions/${locators[0]}`).expect(200)).body.page.id).toBe(note.id);
    });

    it('deletes a Chapter Page with safe recovery metadata and no token', async () => {
      const { note, chapter, first, last } = seed();
      const { deletionId, response } = await deleteOk(note.id);

      const row = db.prepare('SELECT expires_at, created_at FROM note_deletion_snapshots WHERE id = ?').get(deletionId);
      expect(response.body).toEqual({
        status: 'success',
        message: 'Page “Doomed” deleted.',
        page: { id: note.id, title: 'Doomed' },
        redirectUrl: `/notes/chapters/${chapter.id}?notice=page_deleted&undo=${deletionId}`,
        recovery: {
          available: true,
          deletionId,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          statusUrl: `/notes/page-deletions/${deletionId}`,
        },
      });
      expect(row.expires_at - row.created_at).toBe(10 * 60 * 1000);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.text).not.toContain('undoToken');
      expectNoSecrets(response.text, deletionId);
      expect(app.locals.noteRepository.findById(note.id)).toBeUndefined();
      expect(app.locals.noteRepository.findById(first.id)).toBeDefined();
      expect(app.locals.noteRepository.findById(last.id)).toBeDefined();
    });

    it('redirects a native POST to the parent with the public locator only', async () => {
      const { direct, book } = seed();
      const deletionId = createNoteDeletionId();
      const response = await postDelete(direct.id, deletionId, { accept: 'text/html' }).expect(302);
      expect(response.headers.location).toBe(`/notes/books/${book.id}?notice=page_deleted&undo=${deletionId}`);

      const { body: { undoToken } } = await read(`/notes/page-deletions/${deletionId}`).expect(200);
      expect(undoToken).toMatch(LOCATOR);
      expect(response.headers.location).not.toContain(undoToken);
    });

    it.each([
      ['missing', undefined],
      ['malformed', 'not-a-locator'],
      ['uppercase', 'A'.repeat(64)],
    ])('refuses a %s locator with the Page intact', async (_label, deletionId) => {
      const { note } = seed();
      const revisions = revisionIds(note.id);
      const json = await postDelete(note.id, deletionId).expect(422);
      expect(json.body).toMatchObject({ status: 'error', code: 'DELETION_ID_INVALID' });
      expect(json.body.message).toContain('Reload the Page');
      const native = await postDelete(note.id, deletionId, { accept: 'text/html' }).expect(422);
      expect(native.text).toContain('Reload the Page');
      expect(app.locals.noteRepository.findById(note.id)).toBeDefined();
      expect(revisionIds(note.id)).toEqual(revisions);
      expect(snapshotCount()).toBe(0);
    });

    it('refuses a reused locator rather than deleting again', async () => {
      const { note, last } = seed();
      const { deletionId } = await deleteOk(note.id);
      const response = await postDelete(last.id, deletionId).expect(409);
      expect(response.body.code).toBe('UNDO_DELETION_ID_CONFLICT');
      expect(app.locals.noteRepository.findById(last.id)).toBeDefined();
      expect(snapshotCount()).toBe(1);
    });

    it('rolls the deletion back when its snapshot cannot be written, and keeps the locator usable', async () => {
      const failing = buildApp({
        noteDeletionSnapshotRepository: {
          ...createNoteDeletionSnapshotRepository(db),
          insert() { throw new Error('SQLITE internal detail'); },
        },
      });
      const who = await identify(failing);
      const { note } = seed(failing);
      const revisions = revisionIds(note.id);
      const deletionId = createNoteDeletionId();
      const response = await postDelete(note.id, deletionId, { who, target: failing }).expect(500);
      expect(response.body).toEqual({
        status: 'error', code: 'PAGE_OPERATION_FAILED', message: 'The Page could not be deleted. No changes were made.',
      });
      expect(failing.locals.noteRepository.findById(note.id)).toBeDefined();
      expect(revisionIds(note.id)).toEqual(revisions);
      expect(snapshotCount()).toBe(0);

      await postDelete(note.id, deletionId).expect(200);
    });

    it('answers a safe 404 for a missing Page, and leaves CSRF refusal to delete nothing', async () => {
      const { note } = seed();
      expect((await postDelete(9999, createNoteDeletionId()).expect(404)).body).toEqual({
        status: 'error', code: 'PAGE_NOT_FOUND', message: 'This Page is no longer available.',
      });
      await postDelete(9999, createNoteDeletionId(), { accept: 'text/html' }).expect(404);

      await postDelete(note.id, createNoteDeletionId(), { csrf: 'wrong' }).expect(403);
      expect(app.locals.noteRepository.findById(note.id)).toBeDefined();
      expect(snapshotCount()).toBe(0);
    });
  });

  describe('status and token', () => {
    it('returns metadata and a token for the owned active record, without caching or secrets', async () => {
      const { note, chapter } = seed();
      const { deletionId } = await deleteOk(note.id);
      const response = await read(`/notes/page-deletions/${deletionId}`).expect(200);
      const row = db.prepare('SELECT created_at, expires_at FROM note_deletion_snapshots WHERE id = ?').get(deletionId);
      expect(response.body).toEqual({
        deletionId,
        status: 'available',
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        restoredAt: null,
        page: { id: note.id, url: `/notes/${note.id}` },
        parent: { kind: 'chapter', id: chapter.id, bookId: chapter.book_id, url: `/notes/chapters/${chapter.id}` },
        undoToken: expect.stringMatching(LOCATOR),
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expectNoSecrets(response.text, deletionId);
    });

    it('does not distinguish a stranger’s record from an unknown or malformed locator', async () => {
      const { note } = seed();
      const { deletionId } = await deleteOk(note.id);
      const stranger = await identify();

      const foreign = await read(`/notes/page-deletions/${deletionId}`, stranger).expect(404);
      const unknown = await read(`/notes/page-deletions/${createNoteDeletionId()}`).expect(404);
      const malformed = await read('/notes/page-deletions/nope').expect(404);
      expect(foreign.body).toEqual(unknown.body);
      expect(malformed.body).toEqual(unknown.body);
      expect(unknown.body).toEqual({
        status: 'error', code: 'UNDO_UNAVAILABLE', message: 'This Page deletion cannot be undone.',
      });
      expect(foreign.headers['cache-control']).toBe('private, no-store');
    });

    it('reports an expired record truthfully with no token', async () => {
      const { note, chapter } = seed();
      const { deletionId } = await deleteOk(note.id);
      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + ELEVEN_MINUTES_MS);

      const response = await read(`/notes/page-deletions/${deletionId}`).expect(410);
      expect(response.body).toMatchObject({
        status: 'expired', code: 'UNDO_EXPIRED', deletionId, page: { id: note.id }, parent: { url: `/notes/chapters/${chapter.id}` },
      });
      expect(response.body.undoToken).toBeUndefined();
      expectNoSecrets(response.text, deletionId);
    });

    it('reports a restored record as a receipt with no token', async () => {
      const { note } = seed();
      const { deletionId } = await deleteOk(note.id);
      const { body: { undoToken } } = await read(`/notes/page-deletions/${deletionId}`).expect(200);
      await postRestore(deletionId, undoToken).expect(200);

      const response = await read(`/notes/page-deletions/${deletionId}`).expect(200);
      expect(response.body).toMatchObject({ status: 'restored', restoredAt: expect.any(Number), page: { id: note.id } });
      expect(response.body.undoToken).toBeUndefined();
    });
  });

  describe('restore', () => {
    async function deleteAndGetToken(noteId) {
      const { deletionId } = await deleteOk(noteId);
      const { body: { undoToken } } = await read(`/notes/page-deletions/${deletionId}`).expect(200);
      return { deletionId, undoToken };
    }

    it('restores the original Page once and refuses to repeat it', async () => {
      const { note, chapter, first, last } = seed();
      const revisions = revisionIds(note.id);
      const before = app.locals.noteRepository.findById(note.id);
      const { deletionId, undoToken } = await deleteAndGetToken(note.id);

      const response = await postRestore(deletionId, undoToken).expect(200);
      expect(response.body).toEqual({
        status: 'restored',
        message: 'Page restored.',
        deletionId,
        page: { id: note.id, url: `/notes/${note.id}` },
        parent: { kind: 'chapter', id: chapter.id, bookId: chapter.book_id, url: `/notes/chapters/${chapter.id}` },
        restoredAt: expect.any(Number),
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.text).not.toContain(undoToken);
      expect(app.locals.noteRepository.findById(note.id)).toEqual(before);
      expect(revisionIds(note.id)).toEqual(revisions);
      expect(app.locals.noteService.listNotesForChapter(chapter.id).map(({ id }) => id))
        .toEqual([first.id, note.id, last.id]);
      await read(`/notes/${note.id}`).set('Accept', 'text/html').expect(200);

      const second = await postRestore(deletionId, undoToken).expect(409);
      expect(second.body).toMatchObject({
        status: 'error', code: 'UNDO_ALREADY_RESTORED', page: { id: note.id }, parent: { url: `/notes/chapters/${chapter.id}` },
      });
      expect(app.locals.noteService.listNotesForChapter(chapter.id)).toHaveLength(3);
    });

    it('refuses a wrong, missing or query-string token, CSRF failures and strangers, then still restores', async () => {
      const { note } = seed();
      const { deletionId, undoToken } = await deleteAndGetToken(note.id);
      const stranger = await identify();

      await postRestore(deletionId, 'f'.repeat(64)).expect(404);
      await postRestore(deletionId, undefined).expect(404);
      await request(app).post(`/notes/page-deletions/${deletionId}/restore?undoToken=${undoToken}`)
        .set('Cookie', me.cookie).set('Accept', 'application/json').type('form').send({ _csrf: me.csrf }).expect(404);
      await postRestore(deletionId, undoToken, { csrf: 'wrong' }).expect(403);
      await postRestore(deletionId, undoToken, { who: stranger }).expect(404);
      expect(app.locals.noteRepository.findById(note.id)).toBeUndefined();

      await postRestore(deletionId, undoToken).expect(200);
    });

    it('refuses an expired restore', async () => {
      const { note } = seed();
      const { deletionId, undoToken } = await deleteAndGetToken(note.id);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ELEVEN_MINUTES_MS);

      const response = await postRestore(deletionId, undoToken).expect(410);
      expect(response.body.code).toBe('UNDO_EXPIRED');
      expect(app.locals.noteRepository.findById(note.id)).toBeUndefined();
    });

    it('refuses on an ordering conflict and allows the retry once it clears', async () => {
      const { note, last } = seed();
      const older = await deleteAndGetToken(note.id);
      const newer = await deleteAndGetToken(last.id);

      const refused = await postRestore(older.deletionId, older.undoToken).expect(409);
      expect(refused.body).toMatchObject({ status: 'error', code: 'UNDO_ORDER_CHANGED' });
      expect(app.locals.noteRepository.findById(note.id)).toBeUndefined();

      await postRestore(newer.deletionId, newer.undoToken).expect(200);
      await postRestore(older.deletionId, older.undoToken).expect(200);
    });

    it('refuses when the parent has gone', async () => {
      const { bookService, chapterService, noteService } = app.locals;
      const book = bookService.createBook({ title: 'Lone Book' });
      const direct = noteService.createNote({ bookId: book.id, title: 'Only', content: '' });
      const bookDeletion = await deleteAndGetToken(direct.id);
      bookService.deleteBook(book.id);
      expect((await postRestore(bookDeletion.deletionId, bookDeletion.undoToken).expect(409)).body.code).toBe('UNDO_PARENT_MISSING');

      const home = bookService.createBook({ title: 'Home' });
      const chapter = chapterService.createChapter({ bookId: home.id, title: 'Lone Chapter' });
      const inChapter = noteService.createNote({ chapterId: chapter.id, title: 'Only', content: '' });
      const chapterDeletion = await deleteAndGetToken(inChapter.id);
      chapterService.deleteChapter(chapter.id);
      expect((await postRestore(chapterDeletion.deletionId, chapterDeletion.undoToken).expect(409)).body.code).toBe('UNDO_PARENT_CHANGED');
    });

    it('sanitizes an operational failure', async () => {
      const { note } = seed();
      const { deletionId, undoToken } = await deleteAndGetToken(note.id);
      const restore = vi.spyOn(app.locals.noteService, 'restoreDeletedNote').mockImplementationOnce(() => {
        throw new Error('SQLITE internal detail');
      });
      const response = await postRestore(deletionId, undoToken).expect(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'UNDO_OPERATION_FAILED',
        message: 'The Page deletion recovery could not be completed. No changes were made.',
      });
      restore.mockRestore();
      await postRestore(deletionId, undoToken).expect(200);
    });
  });

  describe('discovery and restart', () => {
    const discover = (query, who = me, target = app) => read(`/notes/page-deletions?${query}`, who, target);

    it('finds owned active deletions from a clean parent, newest first and each distinct', async () => {
      const { note, last, direct, chapter, book } = seed();
      const older = await deleteOk(note.id);
      const newer = await deleteOk(last.id);
      const inBook = await deleteOk(direct.id);

      const response = await discover(`chapterId=${chapter.id}`).expect(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body.status).toBe('success');
      expect(response.body.hasMore).toBe(false);
      expect(response.body.parent).toEqual({ kind: 'chapter', id: chapter.id, url: `/notes/chapters/${chapter.id}` });
      expect(response.body.deletions.map(({ deletionId, title }) => [deletionId, title])).toEqual([
        [newer.deletionId, 'Last'],
        [older.deletionId, 'Doomed'],
      ]);
      expect(response.body.deletions[0]).toEqual({
        deletionId: newer.deletionId,
        status: 'available',
        title: 'Last',
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
        page: { id: last.id, url: `/notes/${last.id}` },
        statusUrl: `/notes/page-deletions/${newer.deletionId}`,
      });
      expect(response.text).not.toContain('undoToken');
      expectNoSecrets(response.text, older.deletionId);

      // A Book lists only the Pages directly inside it.
      const bookList = await discover(`bookId=${book.id}`).expect(200);
      expect(bookList.body.deletions.map(({ deletionId }) => deletionId)).toEqual([inBook.deletionId]);
    });

    it('hides deletions from other owners', async () => {
      const { note, chapter } = seed();
      await deleteOk(note.id);
      const stranger = await identify();
      expect((await discover(`chapterId=${chapter.id}`, stranger).expect(200)).body.deletions).toEqual([]);
    });

    it('excludes restored and expired deletions', async () => {
      const { note, last, chapter } = seed();
      const restored = await deleteOk(last.id);
      const { body: { undoToken } } = await read(`/notes/page-deletions/${restored.deletionId}`).expect(200);
      await postRestore(restored.deletionId, undoToken).expect(200);
      expect((await discover(`chapterId=${chapter.id}`).expect(200)).body.deletions).toEqual([]);

      await deleteOk(note.id);
      expect((await discover(`chapterId=${chapter.id}`).expect(200)).body.deletions).toHaveLength(1);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ELEVEN_MINUTES_MS);
      expect((await discover(`chapterId=${chapter.id}`).expect(200)).body.deletions).toEqual([]);
    });

    it('is bounded and says so', async () => {
      const { noteService, bookService } = app.locals;
      const book = bookService.createBook({ title: 'Many' });
      for (let index = 0; index < 11; index += 1) {
        const page = noteService.createNote({ bookId: book.id, title: `P${index}`, content: '' });
        await deleteOk(page.id);
      }
      const { body } = await discover(`bookId=${book.id}`).expect(200);
      expect(body.deletions).toHaveLength(10);
      expect(body.hasMore).toBe(true);
      expect(body.deletions[0].title).toBe('P10');
    });

    it.each([
      ['no parent', ''],
      ['both parents', 'bookId=1&chapterId=1'],
      ['a malformed parent', 'bookId=01'],
    ])('rejects %s', async (_label, query) => {
      expect((await discover(query).expect(422)).body.code).toBe('PARENT_INVALID');
    });

    it('lets the same identity rediscover and restore after an application restart', async () => {
      const { note, chapter } = seed();
      const { deletionId } = await deleteOk(note.id);

      const restarted = buildApp();
      const who = { ...me, csrf: mode === 'session' ? await csrfFor(restarted, me.cookie) : me.csrf };
      const { body } = await discover(`chapterId=${chapter.id}`, who, restarted).expect(200);
      expect(body.deletions.map((deletion) => deletion.deletionId)).toEqual([deletionId]);
      const status = await read(body.deletions[0].statusUrl, who, restarted).expect(200);
      await postRestore(deletionId, status.body.undoToken, { who, target: restarted }).expect(200);
      expect(restarted.locals.noteRepository.findById(note.id)).toBeDefined();
    });
  });

  describe('lost responses', () => {
    it('settles a lost Delete response from the preallocated locator, without a second POST', async () => {
      const { note, chapter } = seed();
      const deletionId = createNoteDeletionId();

      // Before the POST commits, the locator proves nothing.
      await read(`/notes/page-deletions/${deletionId}`).expect(404);
      await postDelete(note.id, deletionId).expect(200); // Its response is ignored from here on.

      const { body } = await read(`/notes/page-deletions/${deletionId}`).expect(200);
      expect(body.page.id).toBe(note.id);
      expect(body.parent.url).toBe(`/notes/chapters/${chapter.id}`);
      expect(snapshotCount()).toBe(1);
    });

    it('settles a lost Restore response by reading, without repeating it', async () => {
      const { note } = seed();
      const { deletionId } = await deleteOk(note.id);
      const { body: { undoToken } } = await read(`/notes/page-deletions/${deletionId}`).expect(200);
      await postRestore(deletionId, undoToken).expect(200); // Its response is ignored from here on.

      const { body } = await read(`/notes/page-deletions/${deletionId}`).expect(200);
      expect(body).toMatchObject({ status: 'restored', page: { url: `/notes/${note.id}` } });
    });
  });

  describe('parent rendering', () => {
    const html = (url, who = me) => read(url, who).set('Accept', 'text/html').expect(200).then(({ text }) => text);

    it('exposes an owned locator as metadata on the right parent only, never a token', async () => {
      const { note, chapter, direct, book } = seed();
      const { deletionId, response } = await deleteOk(note.id);
      const inBook = await deleteOk(direct.id);
      const { body: { undoToken } } = await read(`/notes/page-deletions/${deletionId}`).expect(200);

      const parent = await html(response.body.redirectUrl);
      expect(parent).toContain('data-page-deletion-notice');
      expect(parent).toContain('Page deleted.');
      expect(parent).toContain(`data-page-deletion-id="${deletionId}"`);
      expect(parent).toContain(`data-page-deletion-status-url="/notes/page-deletions/${deletionId}"`);
      expect(parent).toMatch(/data-page-deletion-expires-at="\d+"/);
      expect(parent).toContain(`data-page-deletion-discovery-url="/notes/page-deletions?chapterId=${chapter.id}"`);
      expect(parent).not.toContain(undoToken);
      expect(parent).not.toContain('undoToken');
      expectNoSecrets(parent, deletionId);

      const bookParent = await html(inBook.response.body.redirectUrl);
      expect(bookParent).toContain(`data-page-deletion-id="${inBook.deletionId}"`);
      expect(bookParent).toContain(`data-page-deletion-discovery-url="/notes/page-deletions?bookId=${book.id}"`);

      // The same locator on another parent is not actionable there.
      expect(await html(`/notes/books/${book.id}?notice=page_deleted&undo=${deletionId}`)).not.toContain('data-page-deletion-id=');
    });

    it('treats fabricated, foreign, consumed and notice-free locators as no opportunity', async () => {
      const { note, chapter } = seed();
      const { deletionId } = await deleteOk(note.id);
      const stranger = await identify();
      const url = `/notes/chapters/${chapter.id}?notice=page_deleted&undo=`;

      const fabricated = await html(`${url}${createNoteDeletionId()}`);
      expect(fabricated).not.toContain('Page deleted.');
      expect(fabricated).not.toContain('data-page-deletion-notice');
      expect(fabricated).not.toContain('data-page-deletion-id=');
      expect(await html(`${url}<script>`)).not.toContain('<script>"');
      const foreign = await html(`${url}${deletionId}`, stranger);
      expect(foreign).not.toContain('Page deleted.');
      expect(foreign).not.toContain('data-page-deletion-id=');
      expect(await html(`${url}${deletionId}`)).toContain('Page deleted.');
      expect(await html(`/notes/chapters/${chapter.id}?undo=${deletionId}`)).not.toContain('data-page-deletion-id=');

      const clean = await html(`/notes/chapters/${chapter.id}`);
      expect(clean).not.toContain('data-page-deletion-notice');
      expect(clean).toContain(`data-page-deletion-discovery-url="/notes/page-deletions?chapterId=${chapter.id}"`);

      const { body: { undoToken } } = await read(`/notes/page-deletions/${deletionId}`).expect(200);
      await postRestore(deletionId, undoToken).expect(200);
      const consumed = await html(`${url}${deletionId}`);
      expect(consumed).not.toContain('Page deleted.');
      expect(consumed).not.toContain('data-page-deletion-id=');
    });
  });

  describe('regressions', () => {
    it('keeps Page Move local and Book and Chapter deletion unchanged', async () => {
      const { direct, chapter, book, first, note, last } = seed();
      const moved = await request(app).post(`/notes/${direct.id}/move`).set('Cookie', me.cookie).set('Accept', 'application/json').type('form')
        .send({ _csrf: me.csrf, targetContainer: `chapter:${chapter.id}` });
      expect(moved.status).toBe(200);
      expect(moved.body.status).toBe('success');
      expect(snapshotCount()).toBe(0);

      for (const page of [first, note, last, direct]) app.locals.noteService.deleteNote(page.id);
      await request(app).post(`/notes/chapters/${chapter.id}/delete`).set('Cookie', me.cookie).set('Accept', 'application/json').type('form')
        .send({ _csrf: me.csrf }).expect(200);
      await request(app).post(`/notes/books/${book.id}/delete`).set('Cookie', me.cookie).set('Accept', 'application/json').type('form')
        .send({ _csrf: me.csrf }).expect(200);
      expect(snapshotCount()).toBe(0);
    });
  });
});

describe('Page deletion recovery boundaries', () => {
  let root;
  let db;
  let projectsRoot;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-undo-http-'));
    projectsRoot = path.join(root, 'projects');
    fs.mkdirSync(projectsRoot);
    db = openDatabase(path.join(root, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses every recovery operation, and the deletion itself, when Undo is not configured', async () => {
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot: root });
    const { noteService, bookService, chapterService } = app.locals;
    const book = bookService.createBook({ title: 'Book' });
    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
    const note = noteService.createNote({ chapterId: chapter.id, title: 'Kept', content: 'Saved' });
    noteService.updateNote(note.id, { title: 'Kept', content: 'Saved again' });
    const revisions = db.prepare('SELECT COUNT(*) AS n FROM note_revisions WHERE note_id = ?').get(note.id).n;
    const deleteNote = vi.spyOn(noteService, 'deleteNote');
    const deletionId = createNoteDeletionId();

    const refused = await request(app).post(`/notes/${note.id}/delete`).set('Accept', 'application/json').type('form')
      .send({ deletionId }).expect(503);
    expect(refused.body).toMatchObject({ status: 'error', code: 'UNDO_NOT_CONFIGURED' });
    expect(refused.body.message).toContain('not deleted');
    await request(app).post(`/notes/${note.id}/delete`).set('Accept', 'text/html').type('form').send({ deletionId }).expect(503);
    expect(deleteNote).not.toHaveBeenCalled();
    expect(noteService.getNote(note.id)).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM note_revisions WHERE note_id = ?').get(note.id).n).toBe(revisions);

    for (const call of [
      request(app).get(`/notes/page-deletions/${deletionId}`),
      request(app).get(`/notes/page-deletions?chapterId=${chapter.id}`),
      request(app).post(`/notes/page-deletions/${deletionId}/restore`).type('form').send({ undoToken: 'a'.repeat(64) }),
    ]) {
      const response = await call.set('Accept', 'application/json').expect(503);
      expect(response.body.code).toBe('UNDO_NOT_CONFIGURED');
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('requires a login, and a lost session loses access to its recovery', async () => {
    const appDataRoot = root;
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot, authState: { csrfPepper }, authConfig: AUTH_CONFIG,
    });
    const { noteService, bookService } = app.locals;
    const book = bookService.createBook({ title: 'Book' });
    const note = noteService.createNote({ bookId: book.id, title: 'Doomed', content: '' });
    const kept = noteService.createNote({ bookId: book.id, title: 'Kept', content: '' });

    const login = async () => {
      const agent = request.agent(app);
      const page = await agent.get('/login').expect(200);
      await agent.post('/login').type('form')
        .send({ username: TEST_USERNAME, password: TEST_PASSWORD, _csrf: extractCsrfToken(page.text) }).expect(302);
      return { agent, csrf: extractCsrfToken((await agent.get('/projects/new').expect(200)).text) };
    };

    const anonymous = (call) => call.set('Accept', 'application/json').expect(401);
    await anonymous(request(app).post(`/notes/${kept.id}/delete`).type('form').send({ deletionId: createNoteDeletionId() }));
    await anonymous(request(app).get(`/notes/page-deletions/${createNoteDeletionId()}`));
    await anonymous(request(app).get(`/notes/page-deletions?bookId=${book.id}`));
    await anonymous(request(app).post(`/notes/page-deletions/${createNoteDeletionId()}/restore`).type('form').send({}));
    expect(noteService.getNote(kept.id)).toBeDefined();

    const { agent, csrf } = await login();
    const deletionId = createNoteDeletionId();
    await agent.post(`/notes/${note.id}/delete`).set('Accept', 'application/json').type('form')
      .send({ _csrf: csrf, deletionId }).expect(200);
    const { body: { undoToken } } = await agent.get(`/notes/page-deletions/${deletionId}`).set('Accept', 'application/json').expect(200);

    db.prepare('DELETE FROM sessions').run();
    await agent.get(`/notes/page-deletions/${deletionId}`).set('Accept', 'application/json').expect(401);

    const next = await login();
    await next.agent.get(`/notes/page-deletions/${deletionId}`).set('Accept', 'application/json').expect(404);
    expect((await next.agent.get(`/notes/page-deletions?bookId=${book.id}`).set('Accept', 'application/json').expect(200)).body.deletions).toEqual([]);
    await next.agent.post(`/notes/page-deletions/${deletionId}/restore`).set('Accept', 'application/json').type('form')
      .send({ _csrf: next.csrf, undoToken }).expect(404);
  });

  it('never lets a request body, query or header choose the owner', async () => {
    const { csrfPepper } = ensureAuthEnablement(root);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot: root, authState: { csrfPepper } });
    const { noteService, bookService } = app.locals;
    const book = bookService.createBook({ title: 'Book' });
    const note = noteService.createNote({ bookId: book.id, title: 'Doomed', content: '' });
    const jar = (response) => response.headers['set-cookie'].find((line) => line.startsWith('cc_csrf_anon=')).split(';')[0];
    const owner = jar(await request(app).get('/health'));
    const other = jar(await request(app).get('/health'));
    const deletionId = createNoteDeletionId();
    await request(app).post(`/notes/${note.id}/delete`).set('Cookie', owner).set('Accept', 'application/json').type('form')
      .send({ _csrf: deriveDisabledModeCsrfToken(csrfPepper, decodeURIComponent(owner.split('=')[1])), deletionId }).expect(200);
    const ownerKey = db.prepare('SELECT owner_key FROM note_deletion_snapshots WHERE id = ?').pluck().get(deletionId);

    await request(app).get(`/notes/page-deletions/${deletionId}?ownerKey=${ownerKey}`)
      .set('Cookie', other).set('X-Owner-Key', ownerKey).set('Accept', 'application/json').expect(404);
    // A browser with no identity yet has nothing to read.
    await request(app).get(`/notes/page-deletions/${deletionId}`).set('Accept', 'application/json').expect(404);
    expect((await request(app).get(`/notes/page-deletions?bookId=${book.id}`).set('Accept', 'application/json').expect(200)).body.deletions).toEqual([]);
  });
});
