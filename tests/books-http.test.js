import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Book HTTP routes', () => {
  let db;
  let app;
  let tmpDir;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-books-http-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders an empty Books landing rather than the legacy flat Notes list', async () => {
    const response = await agent.get('/notes').expect(200);

    expect(response.text).toContain('<h1 class="app-section-title">Notes</h1>');
    expect(response.text).toContain('<a class="button button-primary" href="/notes/books/new">New Book</a>');
    expect(response.text).toContain('<h2>Books</h2>');
    expect(response.text).toContain('<h2 class="empty-state-heading">No books yet</h2>');
    expect(response.text).not.toContain('class="notes-table"');
    expect(response.text).not.toContain('href="/notes/new"');
  });

  it('renders Books in canonical order and does not load legacy Notes into the landing', async () => {
    const first = app.locals.bookService.createBook({ title: 'First Book' });
    const second = app.locals.bookService.createBook({ title: 'Second Book' });
    const chapterId = Number(db.prepare(`
      INSERT INTO chapters (book_id, title, sort_order)
      VALUES (?, 'Legacy Chapter', 0)
    `).run(first.id).lastInsertRowid);
    db.prepare(`
      INSERT INTO notes (chapter_id, title, content, sort_order)
      VALUES (?, 'Legacy Flat Note', '', 0)
    `).run(chapterId);
    app.locals.bookService.reorderBooks([second.id, first.id]);

    const response = await agent.get('/notes').expect(200);
    const table = response.text.match(/<table class="data-table">[\s\S]*?<\/table>/)?.[0] || '';

    expect(table.indexOf('Second Book')).toBeLessThan(table.indexOf('First Book'));
    expect(table).toContain(`href="/notes/books/${second.id}"`);
    expect(table).toContain(`href="/notes/books/${first.id}"`);
    expect(response.text).not.toContain('Legacy Flat Note');
  });

  it('renders the create form with CSRF protection and creates a trimmed Book', async () => {
    const form = await agent.get('/notes/books/new').expect(200);
    expect(form.text).toContain('<form id="book-form" method="post" action="/notes/books"');
    expect(form.text).toMatch(/<input[^>]+name="_csrf"[^>]+value="[^"]+"/);
    expect(form.text).toContain('<input type="text" id="title" name="title"');
    expect(form.text).not.toContain('name="content"');

    await agent
      .post('/notes/books')
      .type('form')
      .send({ title: '  Trimmed Book  ' })
      .expect(403);

    const response = await agent
      .post('/notes/books')
      .type('form')
      .send({ _csrf: csrfToken, title: '  Trimmed Book  ' })
      .expect(302);

    const [book] = app.locals.bookService.listBooks();
    expect(book.title).toBe('Trimmed Book');
    expect(response.headers.location).toBe(`/notes/books/${book.id}`);
  });

  it('rerenders create validation errors for blank and overlong Book titles', async () => {
    for (const title of ['', 'a'.repeat(201)]) {
      const response = await agent
        .post('/notes/books')
        .type('form')
        .send({ _csrf: csrfToken, title })
        .expect(422);

      expect(response.text).toContain('field-error-message');
    }

    expect(app.locals.bookService.listBooks()).toEqual([]);
  });

  it('renders Book details and returns 404 for missing or malformed Book IDs', async () => {
    const book = app.locals.bookService.createBook({ title: 'Detail Book' });

    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    expect(response.text).toContain('<h2>Chapters</h2>');
    expect(response.text).toContain('<h2 class="empty-state-heading">No chapters yet</h2>');
    expect(response.text).toContain(`href="/notes/books/${book.id}/edit"`);
    expect(response.text).toContain(`action="/notes/books/${book.id}/delete"`);

    await agent.get('/notes/books/999999').expect(404);
    await agent.get('/notes/books/01').expect(404);
  });

  it('renders and updates the Book edit form', async () => {
    const book = app.locals.bookService.createBook({ title: 'Before' });

    const form = await agent.get(`/notes/books/${book.id}/edit`).expect(200);
    expect(form.text).toContain(`<form id="book-form" method="post" action="/notes/books/${book.id}"`);
    expect(form.text).toContain('value="Before"');

    const response = await agent
      .post(`/notes/books/${book.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: 'After' })
      .expect(302);

    expect(response.headers.location).toBe(`/notes/books/${book.id}`);
    expect(app.locals.bookService.getBook(book.id).title).toBe('After');
  });

  it('rerenders Book edit validation errors and returns 404 for missing Books', async () => {
    const book = app.locals.bookService.createBook({ title: 'Stored title' });

    const invalid = await agent
      .post(`/notes/books/${book.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: '' })
      .expect(422);

    expect(invalid.text).toContain('Title is required.');
    expect(invalid.text).toContain('value=""');
    expect(app.locals.bookService.getBook(book.id).title).toBe('Stored title');
    await agent.get('/notes/books/999999/edit').expect(404);
    await agent.post('/notes/books/999999').type('form').send({ _csrf: csrfToken, title: 'Missing' }).expect(404);
  });

  it('requires CSRF to delete empty Books and returns 404 for missing or malformed Books', async () => {
    const book = app.locals.bookService.createBook({ title: 'Empty Book' });

    await agent
      .post(`/notes/books/${book.id}/delete`)
      .type('form')
      .send({})
      .expect(403);

    expect(app.locals.bookService.getBook(book.id)).toMatchObject({ title: 'Empty Book' });

    const response = await agent
      .post(`/notes/books/${book.id}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe('/notes');
    expect(app.locals.bookService.listBooks()).toEqual([]);
    await agent.post('/notes/books/999999/delete').type('form').send({ _csrf: csrfToken }).expect(404);
    await agent.post('/notes/books/01/delete').type('form').send({ _csrf: csrfToken }).expect(404);
  });

  it('returns a conflict when deleting a non-empty Book', async () => {
    const book = app.locals.bookService.createBook({ title: 'Non-empty Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
    const chaptersBeforeDelete = app.locals.chapterService.listChapters(book.id);

    const response = await agent
      .post(`/notes/books/${book.id}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(409);

    expect(response.text).toContain('<p class="error-status">409</p>');
    expect(response.text).toContain('cannot be deleted while it contains chapters');
    expect(response.text).not.toContain('SQLITE_CONSTRAINT');
    expect(app.locals.bookService.getBook(book.id)).toMatchObject({ title: 'Non-empty Book' });
    expect(app.locals.chapterService.listChapters(book.id)).toEqual(chaptersBeforeDelete);
    expect(app.locals.chapterService.getChapter(chapter.id)).toMatchObject({ title: 'Chapter', book_id: book.id });
  });

  it('reorders Books with CSRF protection and renders the resulting order on the landing', async () => {
    const books = [
      app.locals.bookService.createBook({ title: 'First Book' }),
      app.locals.bookService.createBook({ title: 'Second Book' }),
      app.locals.bookService.createBook({ title: 'Third Book' }),
    ];
    const orderedIds = [books[2].id, books[0].id, books[1].id];

    await agent
      .post('/notes/books/reorder')
      .type('form')
      .send({ orderedBookIds: orderedIds.join(',') })
      .expect(403);

    const response = await agent
      .post('/notes/books/reorder')
      .type('form')
      .send({ _csrf: csrfToken, orderedBookIds: orderedIds.join(',') })
      .expect(302);

    expect(response.headers.location).toBe('/notes?notice=book_reordered');
    expect(app.locals.bookService.listBooks().map((book) => book.id)).toEqual(orderedIds);

    const landing = await agent.get('/notes').expect(200);
    const positions = orderedIds.map((id) => landing.text.indexOf(`/notes/books/${id}`));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('rerenders the Books landing for malformed IDs or an invalid reorder permutation', async () => {
    const first = app.locals.bookService.createBook({ title: 'First Book' });
    const second = app.locals.bookService.createBook({ title: 'Second Book' });
    const before = app.locals.bookService.listBooks().map((book) => book.id);

    for (const orderedBookIds of [`${first.id},01`, `${first.id},${first.id}`]) {
      const response = await agent
        .post('/notes/books/reorder')
        .type('form')
        .send({ _csrf: csrfToken, orderedBookIds })
        .expect(422);

      expect(response.text).toContain('submitted book order is invalid');
      expect(app.locals.bookService.listBooks().map((book) => book.id)).toEqual(before);
    }

    expect(second.id).toBeGreaterThan(first.id);
  });
});
