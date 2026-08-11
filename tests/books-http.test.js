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
    expect(response.text).toContain('<h2 class="empty-state-heading">No books yet</h2>');
    expect(response.text).toContain('<header class="page-heading">');
    expect(response.text).not.toContain('Change order');
    expect(response.text).not.toContain('<h2>Books</h2>');
    expect(response.text).not.toContain('class="notes-table"');
    expect(response.text).not.toContain('class="data-table"');
    expect(response.text).not.toContain('class="table-scroll"');
    expect(response.text).not.toContain('href="/notes/new"');
  });

  it('renders a single Book without Change order and with an explicit Edit Book action', async () => {
    const book = app.locals.bookService.createBook({ title: 'Single Book' });

    const response = await agent.get('/notes').expect(200);

    expect(response.text).toContain(`<a href="/notes/books/${book.id}">Single Book</a>`);
    expect(response.text).toContain(`<a class="button button-small button-secondary" href="/notes/books/${book.id}/edit" aria-label="Edit Book: Single Book">Edit Book</a>`);
    expect(response.text).not.toContain('Change order');
    expect(response.text).not.toContain('>Manage</a>');
    expect(response.text).not.toContain('Move up');
    expect(response.text).not.toContain('Move down');
  });

  it('renders Books in canonical order and does not load legacy Notes into the landing', async () => {
    const first = app.locals.bookService.createBook({ title: 'First Book' });
    const second = app.locals.bookService.createBook({ title: 'Second Book' });
    const chapterId = Number(db.prepare(`
      INSERT INTO chapters (book_id, title, sort_order)
      VALUES (?, 'Legacy Chapter', 0)
    `).run(first.id).lastInsertRowid);
    db.prepare(`
      INSERT INTO notes (book_id, chapter_id, title, content, sort_order)
      VALUES (?, ?, 'Legacy Flat Note', '', 0)
    `).run(first.id, chapterId);
    app.locals.bookService.reorderBooks([second.id, first.id]);

    const response = await agent.get('/notes').expect(200);
    const booksList = response.text.match(/<ul class="notes-book-content-list" aria-label="Books">[\s\S]*?<\/ul>/)?.[0] || '';

    expect(booksList.indexOf('Second Book')).toBeLessThan(booksList.indexOf('First Book'));
    expect(booksList).toContain(`<a href="/notes/books/${second.id}">Second Book</a>`);
    expect(booksList).toContain(`<a href="/notes/books/${first.id}">First Book</a>`);
    expect(booksList).toContain(`<a class="button button-small button-secondary" href="/notes/books/${second.id}/edit" aria-label="Edit Book: Second Book">Edit Book</a>`);
    expect(booksList).toContain(`<a class="button button-small button-secondary" href="/notes/books/${first.id}/edit" aria-label="Edit Book: First Book">Edit Book</a>`);
    expect(response.text).toContain('<a class="button button-secondary" href="/notes/books/order">Change order</a>');
    expect(response.text).not.toContain('<table');
    expect(response.text).not.toContain('<th>Actions</th>');
    expect(response.text).not.toContain('<th>Order</th>');
    expect(response.text).not.toContain('>Manage</a>');
    expect(response.text).not.toContain('Move up');
    expect(response.text).not.toContain('Move down');
    expect(response.text).not.toContain('Legacy Flat Note');
  });

  it('renders the top-level Book order shell before dynamic Book detail routing', async () => {
    const first = app.locals.bookService.createBook({ title: 'Order First Book' });
    const second = app.locals.bookService.createBook({ title: 'Order Second Book' });

    const response = await agent.get('/notes/books/order').expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes — Change order</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Notes — Change order</h1>');
    expect(response.text).toContain('<a class="button button-secondary" href="/notes">Cancel</a>');
    expect(response.text).toContain('<h2 id="notes-books-order-heading">Change order</h2>');
    expect(response.text).toContain('Book ordering controls will be available here in a future update.');
    expect(response.text).toContain(`<a href="/notes/books/${first.id}">Order First Book</a>`);
    expect(response.text).toContain(`<a href="/notes/books/${second.id}">Order Second Book</a>`);
    expect(response.text).not.toContain('<form');
    expect(response.text).not.toContain('<button');
    expect(response.text).not.toContain('draggable="true"');
    expect(response.text).not.toContain('orderedBookIds');
    expect(response.text).not.toContain('Move up');
    expect(response.text).not.toContain('Move down');

    await agent.get(`/notes/books/${first.id}`).expect(200);
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
    expect(response.text).toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).toContain('<span class="notes-hierarchy-kind">Book</span>');
    expect(response.text).toContain(`<span class="notes-hierarchy-current">${book.title}</span>`);
    expect(response.text).toContain('<h2 id="notes-book-chapters-heading">Chapters</h2>');
    expect(response.text).toContain('<h3 class="empty-state-heading">No chapters yet</h3>');
    expect(response.text).toContain('<h2 id="notes-book-pages-heading">Pages</h2>');
    expect(response.text).toContain('<h3 class="empty-state-heading">No pages yet</h3>');
    expect(response.text).toContain(`<a class="button button-primary" href="/notes/new?bookId=${book.id}">New Page</a>`);
    expect(response.text).toContain(`<a class="button" href="/notes/books/${book.id}/chapters/new">New Chapter</a>`);
    expect(response.text).toContain(`href="/notes/books/${book.id}/edit"`);
    expect(response.text).toContain('>Edit Book</a>');
    expect(response.text).not.toContain('Change order');
    expect(response.text).not.toContain('>Manage</a>');
    expect(response.text).not.toContain('Move up');
    expect(response.text).not.toContain('Move down');
    expect(response.text).not.toContain('Danger zone');
    expect(response.text).not.toContain(`/notes/books/${book.id}/delete`);

    await agent.get('/notes/books/999999').expect(404);
    await agent.get('/notes/books/01').expect(404);
    await agent.get('/notes/books/999999/order').expect(404);
    await agent.get('/notes/books/01/order').expect(404);
  });

  it('renders a Book with Chapters and no direct Pages', async () => {
    const book = app.locals.bookService.createBook({ title: 'Chapter Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter One' });

    const response = await agent.get(`/notes/books/${book.id}`).expect(200);

    expect(response.text).toContain('<h2 id="notes-book-chapters-heading">Chapters</h2>');
    expect(response.text).toContain(`<span class="notes-book-content-kind">Chapter</span>`);
    expect(response.text).toContain(`<a href="/notes/chapters/${chapter.id}">Chapter One</a>`);
    expect(response.text).toContain(`<a class="button button-small button-secondary" href="/notes/chapters/${chapter.id}/edit" aria-label="Edit Chapter: Chapter One">Edit Chapter</a>`);
    expect(response.text).toContain('<h2 id="notes-book-pages-heading">Pages</h2>');
    expect(response.text).toContain('<h3 class="empty-state-heading">No pages yet</h3>');
    expect(response.text).not.toContain('Change order');
    expect(response.text).not.toContain('>Manage</a>');
  });

  it('renders direct Pages with canonical links and no Chapters', async () => {
    const book = app.locals.bookService.createBook({ title: 'Direct Pages Book' });
    const page = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Direct Page',
      content: 'Direct content',
    });

    const response = await agent.get(`/notes/books/${book.id}`).expect(200);

    expect(response.text).toContain('<h3 class="empty-state-heading">No chapters yet</h3>');
    expect(response.text).toContain('<h2 id="notes-book-pages-heading">Pages</h2>');
    expect(response.text).toContain(`<a href="/notes/${page.id}">Direct Page</a>`);
    expect(response.text).toContain(`<a class="button button-small button-secondary" href="/notes/${page.id}/edit" aria-label="Edit Page: Direct Page">Edit Page</a>`);
    expect(response.text).not.toContain('No pages yet');
    expect(response.text).not.toContain('Change order');
    expect(response.text).not.toContain('>Manage</a>');
  });

  it('renders both child types while excluding Chapter Pages and Pages from other Books', async () => {
    const book = app.locals.bookService.createBook({ title: 'Mixed Book' });
    const otherBook = app.locals.bookService.createBook({ title: 'Other Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Included Chapter' });
    const chapterPage = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Chapter Page',
      content: 'Nested content',
    });
    const directPage = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Included Direct Page',
      content: 'Direct content',
    });
    const otherBookPage = app.locals.noteService.createNote({
      bookId: otherBook.id,
      title: 'Other Book Page',
      content: 'Other content',
    });

    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const chaptersSection = response.text.match(
      /<section class="notes-book-section" aria-labelledby="notes-book-chapters-heading">[\s\S]*?<\/section>/,
    )?.[0] || '';
    const pagesSection = response.text.match(
      /<section class="notes-book-section" aria-labelledby="notes-book-pages-heading">[\s\S]*?<\/section>/,
    )?.[0] || '';

    expect(chaptersSection).toContain(`<a href="/notes/chapters/${chapter.id}">Included Chapter</a>`);
    expect(chaptersSection).toContain(`<a class="button button-small button-secondary" href="/notes/chapters/${chapter.id}/edit" aria-label="Edit Chapter: Included Chapter">Edit Chapter</a>`);
    expect(pagesSection).toContain(`<a href="/notes/${directPage.id}">Included Direct Page</a>`);
    expect(pagesSection).toContain(`<a class="button button-small button-secondary" href="/notes/${directPage.id}/edit" aria-label="Edit Page: Included Direct Page">Edit Page</a>`);
    expect(pagesSection).not.toContain(`href="/notes/${chapterPage.id}"`);
    expect(pagesSection).not.toContain('Chapter Page');
    expect(pagesSection).not.toContain(`href="/notes/${otherBookPage.id}"`);
    expect(pagesSection).not.toContain('Other Book Page');
    expect(response.text).toContain(`<a class="button button-secondary" href="/notes/books/${book.id}/order">Change order</a>`);
    expect(response.text).not.toContain('>Manage</a>');
    expect(response.text).not.toContain('Move up');
    expect(response.text).not.toContain('Move down');
    expect(response.text).not.toContain('Danger zone');

    const orderPage = await agent.get(`/notes/books/${book.id}/order`).expect(200);
    expect(orderPage.text).toContain('<title>CreatorCrate — Notes — Change order — Mixed Book</title>');
    expect(orderPage.text).toContain(`<span class="notes-hierarchy-current">${book.title}</span>`);
    expect(orderPage.text).toContain('Book ordering controls will be available here in a future update.');
    expect(orderPage.text).toContain(`<a href="/notes/chapters/${chapter.id}">Included Chapter</a>`);
    expect(orderPage.text).toContain(`<a href="/notes/${directPage.id}">Included Direct Page</a>`);
    expect(orderPage.text).not.toContain('Chapter Page');
    expect(orderPage.text).not.toContain('Other Book Page');
    expect(orderPage.text).not.toContain('draggable="true"');
    expect(orderPage.text).not.toContain('Move up');
    expect(orderPage.text).not.toContain('Move down');
    expect(orderPage.text).not.toContain('orderedChapterIds');
    expect(orderPage.text).not.toContain('orderedNoteIds');
    expect(orderPage.text).not.toContain('<form');
  });

  it('renders and updates the Book edit form', async () => {
    const book = app.locals.bookService.createBook({ title: 'Before' });

    const form = await agent.get(`/notes/books/${book.id}/edit`).expect(200);
    const pageHeading = form.text.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0];
    expect((form.text.match(/<h1\b/g) || [])).toHaveLength(1);
    expect(pageHeading).toBeDefined();
    expect(pageHeading).toContain('<button class="button button-primary" type="submit" form="book-form">Save</button>');
    expect(pageHeading).toContain(`<a class="button button-secondary" href="/notes/books/${book.id}">Cancel</a>`);
    expect(pageHeading).not.toContain('>Edit<');
    expect(pageHeading).not.toContain('Manage');
    expect(pageHeading).not.toContain('Delete');
    expect(form.text).toContain(`<form id="book-form" method="post" action="/notes/books/${book.id}"`);
    expect(form.text).toContain('value="Before"');
    expect(form.text).toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(form.text).toContain('<span class="notes-hierarchy-kind">Book</span>');
    expect(form.text).toContain('<span class="notes-hierarchy-current">Before</span>');
    expect(form.text).toContain('<label for="title">Title <span class="required" aria-label="required">*</span></label>');
    expect(form.text).toContain('<details class="notes-workspace-disclosure notes-workspace-disclosure--delete">');
    expect(form.text).toContain('<summary>Delete Book</summary>');
    expect(form.text).toContain(`<form id="book-delete-form" method="post" action="/notes/books/${book.id}/delete">`);
    expect(form.text).toMatch(new RegExp(`<form id="book-delete-form"[\\s\\S]*?name="_csrf"[^>]+value="[^"]+"`));
    expect(form.text).toContain('data-confirm="Delete this Book permanently? This cannot be undone."');
    expect(form.text).toContain('The Book must be empty before it can be deleted.');
    expect(form.text).not.toContain('form="book-form">Edit</button>');
    expect(form.text).not.toContain('Danger zone');
    expect(form.text).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);

    const bookFormStart = form.text.indexOf('<form id="book-form"');
    const bookFormEnd = form.text.indexOf('</form>', bookFormStart);
    const deleteFormStart = form.text.indexOf('<form id="book-delete-form"');
    const bookFormBody = form.text.slice(form.text.indexOf('>', bookFormStart) + 1, bookFormEnd);
    expect(bookFormStart).toBeGreaterThanOrEqual(0);
    expect(bookFormEnd).toBeGreaterThan(bookFormStart);
    expect(bookFormBody).not.toContain('<form');
    expect(deleteFormStart).toBeGreaterThan(bookFormEnd);

    const response = await agent
      .post(`/notes/books/${book.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: 'After' })
      .expect(302);

    expect(response.headers.location).toBe(`/notes/books/${book.id}`);
    expect(app.locals.bookService.getBook(book.id).title).toBe('After');
  });

  it('updates a Book title without disturbing its Chapters or direct Pages', async () => {
    const book = app.locals.bookService.createBook({ title: 'Container Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Existing Chapter' });
    const directPage = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Existing Direct Page',
      content: 'Direct content',
    });

    await agent
      .post(`/notes/books/${book.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: 'Renamed Container Book' })
      .expect(302);

    expect(app.locals.bookService.getBook(book.id).title).toBe('Renamed Container Book');
    expect(app.locals.chapterService.listChapters(book.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: chapter.id,
        book_id: book.id,
        title: 'Existing Chapter',
      })]),
    );
    expect(app.locals.noteService.listNotesForBook(book.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: directPage.id,
        book_id: book.id,
        title: 'Existing Direct Page',
      })]),
    );
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
    expect(invalid.text).toContain('<button class="button button-primary" type="submit" form="book-form">Save</button>');
    expect(invalid.text).toContain(`<a class="button button-secondary" href="/notes/books/${book.id}">Cancel</a>`);
    expect(invalid.text).toContain(`<span class="notes-hierarchy-current">Stored title</span>`);
    expect(invalid.text).toContain(`<form id="book-delete-form" method="post" action="/notes/books/${book.id}/delete">`);
    expect(invalid.text).not.toContain('form="book-form">Edit</button>');
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
