import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { BookContentIntegrityError } from '../src/services/book-service.js';
import { createTagRepository } from '../src/data/tag-repository.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function captureBookDetailLocals(app) {
  let locals = null;
  const originalRender = app.response.render;
  app.response.render = function captureRender(view, renderLocals, callback) {
    if (view === 'notes/books/detail.njk') locals = renderLocals;
    return originalRender.call(this, view, renderLocals, callback);
  };

  return {
    get() {
      return locals;
    },
    restore() {
      app.response.render = originalRender;
    },
  };
}

function captureBooksIndexLocals(app) {
  let locals = null;
  const originalRender = app.response.render;
  app.response.render = function captureRender(view, renderLocals, callback) {
    if (view === 'notes/books/index.njk') locals = renderLocals;
    return originalRender.call(this, view, renderLocals, callback);
  };

  return {
    get() {
      return locals;
    },
    restore() {
      app.response.render = originalRender;
    },
  };
}

function insertProject(db, title) {
  return Number(db.prepare(
    `INSERT INTO projects (title, slug, description, notes, status, planned_date, published_date, patreon_url)
     VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)`
  ).run(title, title.toLowerCase().replace(/\s+/g, '-')).lastInsertRowid);
}

function insertPreviewAsset(db, projectId, filename = 'book-cover.png') {
  return Number(db.prepare(
    `INSERT INTO assets (
       project_id, relative_path, filename, extension, mime_type, size_bytes,
       modified_at, is_present, last_seen_at
     ) VALUES (?, ?, ?, 'png', 'image/png', 1, '2026-08-24 12:00:00', 1, datetime('now'))
       RETURNING id`
  ).get(projectId, `covers/${filename}`, filename).id);
}

function findBookCoverImage(html, assetId, size) {
  return html.match(new RegExp(
    `<img\\b[^>]*src="/projects/\\d+/assets/${assetId}/${size}\\?v=[^"]*"[^>]*>`,
  ))?.[0] || '';
}

describe('Book HTTP routes', () => {
  let db;
  let app;
  let tmpDir;
  let agent;
  let csrfToken;
  let tagRepository;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-books-http-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    tagRepository = createTagRepository(db);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper }, tagRepository },
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
    const booksList = response.text.match(/<ul class="notes-book-shelf" aria-label="Books">[\s\S]*?<\/ul>/)?.[0] || '';

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

  it('renders available, unavailable, and absent Book covers without changing Book order', async () => {
    const availableBook = app.locals.bookService.createBook({ title: 'Available Cover' });
    const unavailableBook = app.locals.bookService.createBook({ title: 'Unavailable Cover' });
    const noCoverBook = app.locals.bookService.createBook({ title: 'No Cover' });
    const availableProjectId = insertProject(db, 'Available Cover Project');
    const unavailableProjectId = insertProject(db, 'Unavailable Cover Project');
    const availableAssetId = insertPreviewAsset(db, availableProjectId, 'available-cover.png');
    const unavailableAssetId = insertPreviewAsset(db, unavailableProjectId, 'unavailable-cover.png');

    app.locals.bookPrimaryImageService.setPrimaryImage(availableBook.id, availableAssetId);
    app.locals.bookPrimaryImageService.setPrimaryImage(unavailableBook.id, unavailableAssetId);
    db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?')
      .run(unavailableAssetId);

    const attachPrimaryImages = vi.spyOn(app.locals.bookPrimaryImageService, 'attachPrimaryImages');
    const renderCapture = captureBooksIndexLocals(app);
    const response = await agent.get('/notes').expect(200);
    const locals = renderCapture.get();
    renderCapture.restore();

    expect(attachPrimaryImages).toHaveBeenCalledTimes(1);
    expect(locals.books.map((book) => book.id)).toEqual([
      availableBook.id,
      unavailableBook.id,
      noCoverBook.id,
    ]);
    expect(locals.books.map((book) => book.primaryImage.state)).toEqual([
      'available',
      'unavailable',
      'none',
    ]);
    expect(response.text).toMatch(
      new RegExp(`src="/projects/${availableProjectId}/assets/${availableAssetId}/thumbnail\\?v=`),
    );
    expect(response.text).toContain('Image unavailable');
    expect(response.text).toContain('data-primary-image-state="unavailable"');
    expect(response.text).toContain('data-primary-image-state="none"');
    expect(response.text).not.toMatch(
      new RegExp(`<img[^>]*src="/projects/${unavailableProjectId}/assets/${unavailableAssetId}/thumbnail`),
    );
    expect(response.text).toContain(`<a href="/notes/books/${availableBook.id}">Available Cover</a>`);
    expect(response.text).toContain(`href="/notes/books/${noCoverBook.id}/edit"`);
  });


  it('applies the existing effective-asset NSFW blur policy to Book covers in one batch', async () => {
    const nsfwTag = app.locals.tagService.createTag({ name: 'NSFW' });
    const directBook = app.locals.bookService.createBook({ title: 'Direct NSFW cover' });
    const inheritedBook = app.locals.bookService.createBook({ title: 'Inherited NSFW cover' });
    const safeBook = app.locals.bookService.createBook({ title: 'Safe cover' });
    const unavailableBook = app.locals.bookService.createBook({ title: 'Unavailable NSFW cover' });
    const noImageBook = app.locals.bookService.createBook({ title: 'No image cover' });
    const directProjectId = insertProject(db, 'Direct NSFW project');
    const inheritedProjectId = insertProject(db, 'Inherited NSFW project');
    const safeProjectId = insertProject(db, 'Safe project');
    const unavailableProjectId = insertProject(db, 'Unavailable NSFW project');
    const directAssetId = insertPreviewAsset(db, directProjectId, 'direct-nsfw.png');
    const inheritedAssetId = insertPreviewAsset(db, inheritedProjectId, 'inherited-nsfw.png');
    const safeAssetId = insertPreviewAsset(db, safeProjectId, 'safe.png');
    const unavailableAssetId = insertPreviewAsset(db, unavailableProjectId, 'unavailable-nsfw.png');

    app.locals.bookPrimaryImageService.setPrimaryImage(directBook.id, directAssetId);
    app.locals.bookPrimaryImageService.setPrimaryImage(inheritedBook.id, inheritedAssetId);
    app.locals.bookPrimaryImageService.setPrimaryImage(safeBook.id, safeAssetId);
    app.locals.bookPrimaryImageService.setPrimaryImage(unavailableBook.id, unavailableAssetId);
    app.locals.assetTagService.replaceAssetTags(directAssetId, [nsfwTag.id]);
    app.locals.projectTagService.replaceProjectTags(inheritedProjectId, [nsfwTag.id]);
    db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?')
      .run(unavailableAssetId);
    app.locals.nsfwFilterSettingsService.setEnabled(true);

    const assetTagLookups = vi.spyOn(tagRepository, 'listForAssetIds');
    const projectTagLookups = vi.spyOn(tagRepository, 'listForProjectIds');
    const renderCapture = captureBooksIndexLocals(app);
    const response = await agent.get('/notes').expect(200);
    const locals = renderCapture.get();
    renderCapture.restore();

    expect(assetTagLookups).toHaveBeenCalledTimes(1);
    expect(assetTagLookups).toHaveBeenCalledWith([directAssetId, inheritedAssetId, safeAssetId]);
    expect(projectTagLookups).toHaveBeenCalledTimes(1);
    expect(projectTagLookups).toHaveBeenCalledWith([directProjectId, inheritedProjectId, safeProjectId]);

    expect(findBookCoverImage(response.text, directAssetId, 'thumbnail')).toContain('asset-image--nsfw-blurred');
    expect(findBookCoverImage(response.text, inheritedAssetId, 'thumbnail')).toContain('asset-image--nsfw-blurred');
    expect(findBookCoverImage(response.text, safeAssetId, 'thumbnail')).not.toContain('asset-image--nsfw-blurred');
    expect(locals.books.find((book) => book.id === directBook.id)?.nsfwBlur).toBe(true);
    expect(locals.books.find((book) => book.id === inheritedBook.id)?.nsfwBlur).toBe(true);
    expect(locals.books.find((book) => book.id === safeBook.id)?.nsfwBlur).toBe(false);
    expect(locals.books.find((book) => book.id === unavailableBook.id)).not.toHaveProperty('nsfwBlur');
    expect(locals.books.find((book) => book.id === noImageBook.id)).not.toHaveProperty('nsfwBlur');

    assetTagLookups.mockClear();
    projectTagLookups.mockClear();
    app.locals.nsfwFilterSettingsService.setEnabled(false);

    const disabled = await agent.get('/notes').expect(200);

    expect(assetTagLookups).not.toHaveBeenCalled();
    expect(projectTagLookups).not.toHaveBeenCalled();
    expect(findBookCoverImage(disabled.text, directAssetId, 'thumbnail')).not.toContain('asset-image--nsfw-blurred');
  });

  it('keeps Book detail primary-image NSFW blur consistent with the Books index', async () => {
    const nsfwTag = app.locals.tagService.createTag({ name: 'NSFW' });
    const book = app.locals.bookService.createBook({ title: 'Detail NSFW cover' });
    const projectId = insertProject(db, 'Detail NSFW project');
    const assetId = insertPreviewAsset(db, projectId, 'detail-nsfw.png');

    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    app.locals.assetTagService.replaceAssetTags(assetId, [nsfwTag.id]);
    app.locals.nsfwFilterSettingsService.setEnabled(true);

    const indexCapture = captureBooksIndexLocals(app);
    const index = await agent.get('/notes').expect(200);
    const indexLocals = indexCapture.get();
    indexCapture.restore();
    const detailCapture = captureBookDetailLocals(app);
    const detail = await agent.get(`/notes/books/${book.id}`).expect(200);
    const detailLocals = detailCapture.get();
    detailCapture.restore();

    expect(indexLocals.books.find((candidate) => candidate.id === book.id)?.nsfwBlur).toBe(true);
    expect(detailLocals.book.nsfwBlur).toBe(true);
    expect(findBookCoverImage(index.text, assetId, 'thumbnail')).toContain('asset-image--nsfw-blurred');
    expect(findBookCoverImage(detail.text, assetId, 'preview')).toContain('asset-image--nsfw-blurred');

    app.locals.nsfwFilterSettingsService.setEnabled(false);
    const disabled = await agent.get(`/notes/books/${book.id}`).expect(200);

    expect(findBookCoverImage(disabled.text, assetId, 'preview')).not.toContain('asset-image--nsfw-blurred');
  });

  it('renders the dedicated top-level Book reorder page before dynamic Book detail routing', async () => {
    const first = app.locals.bookService.createBook({ title: 'Order First Book' });
    const second = app.locals.bookService.createBook({ title: 'Order Second Book' });
    const third = app.locals.bookService.createBook({ title: 'Order Third Book' });
    const orderedBooks = [third, first, second];
    app.locals.bookService.reorderBooks(orderedBooks.map((book) => book.id));

    const response = await agent.get('/notes/books/order').expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes — Change order</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Notes — Change order</h1>');
    expect((response.text.match(/<h1\b/g) || [])).toHaveLength(1);
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="notes-books-order-form">Save</button>');
    expect(response.text).toContain('<a class="button button-secondary" href="/notes">Cancel</a>');
    expect(response.text).toContain('<h2 id="notes-books-order-heading">Change order</h2>');
    expect(response.text).toContain('Drag a handle to move a Book');
    expect(response.text).toContain('<form id="notes-books-order-form" method="post" action="/notes/books/reorder" data-book-reorder-form>');
    expect(response.text).toContain(`<input type="hidden" name="orderedBookIds" data-book-order-input value="${orderedBooks.map((book) => book.id).join(',')}">`);
    expect(response.text).toContain('data-book-reorder-list');
    expect(response.text).toContain('data-book-reorder-live');
    expect((response.text.match(/data-book-reorder-item/g) || [])).toHaveLength(3);
    expect((response.text.match(/data-book-reorder-handle/g) || [])).toHaveLength(3);
    expect((response.text.match(/draggable="true"/g) || [])).toHaveLength(6);
    const orderList = response.text.match(/<ol[\s\S]*?data-book-reorder-list[\s\S]*?<\/ol>/)?.[0] || '';
    expect(orderList.indexOf('Order Third Book')).toBeLessThan(orderList.indexOf('Order First Book'));
    expect(orderList.indexOf('Order First Book')).toBeLessThan(orderList.indexOf('Order Second Book'));
    expect(response.text).toContain('aria-label="Reorder Order Third Book"');
    expect(response.text).toContain('Position 1 of 3');
    expect(response.text).not.toContain('Book ordering controls will be available here in a future update.');
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

    const renderCapture = captureBookDetailLocals(app);
    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const locals = renderCapture.get();
    renderCapture.restore();
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).toContain(`<title>CreatorCrate — Notes — ${book.title}</title>`);
    expect(response.text).toContain(`<h1 class="app-section-title">Notes — ${book.title}</h1>`);
    expect((response.text.match(/<h1\b/g) || [])).toHaveLength(1);
    expect(response.text).toContain('<div class="notes-page-detail-layout">');
    expect(response.text).toContain('<aside class="notes-page-detail-sidebar notes-surface notes-surface--compact">');
    expect(response.text).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">${book.title}</a>`);
    expect(response.text).toContain('<section class="notes-detail-panel notes-detail-details" aria-labelledby="notes-book-details-heading">');
    expect(response.text).toContain('<h2 id="notes-book-details-heading">Details</h2>');
    expect(response.text).toContain('<dl class="detail-list">');
    expect(response.text).toContain('<dt>Created</dt>');
    expect(response.text).toContain(`<dd>${book.created_at}</dd>`);
    expect(response.text).toContain('<dt>Updated</dt>');
    expect(response.text).toContain(`<dd>${book.updated_at}</dd>`);
    expect(response.text).toContain('data-primary-image-state="none"');
    expect((response.text.match(/class="notes-surface"/g) || [])).toHaveLength(1);
    expect(response.text).toMatch(/<div class="notes-surface">\s*<nav class="book-outline"[\s\S]*?<\/nav>\s*<\/div>/);
    expect(response.text).toContain(`<nav class="book-outline" aria-label="Contents of ${book.title}">`);
    expect(response.text).toContain('<p class="book-outline-empty">No Pages or Chapters yet</p>');
    expect((response.text.match(/class="book-outline-empty"/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('<h2 id="notes-book-content-heading">Content</h2>');
    expect(response.text).not.toContain('notes-book-section');
    expect(response.text).not.toContain('notes-book-content-list');
    expect(response.text).not.toContain('notes-book-chapters-heading');
    expect(response.text).not.toContain('notes-book-pages-heading');
    expect(response.text).not.toContain('No chapters yet');
    expect(response.text).not.toContain('No pages yet');
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
    expect(locals.contents).toEqual([]);
    expect(locals.bookContents).toBe(locals.contents);
    expect(locals.book.primaryImage).toMatchObject({ state: 'none', previewUrl: null });
    expect(locals.chapters).toEqual([]);
    expect(locals.pages).toEqual([]);
    expect(locals.canChangeOrder).toBe(false);

    await agent.get('/notes/books/999999').expect(404);
    await agent.get('/notes/books/01').expect(404);
    await agent.get('/notes/books/999999/order').expect(404);
    await agent.get('/notes/books/01/order').expect(404);
  });

  it('renders the primary-image preview and shared Book contents sidebar without replacing the outline', async () => {
    const book = app.locals.bookService.createBook({ title: 'Sidebar Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Sidebar Chapter' });
    const chapterPage = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Sidebar Chapter Page',
      content: 'Nested content',
    });
    const directPage = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Sidebar Direct Page',
      content: 'Direct content',
    });
    const projectId = insertProject(db, 'Sidebar Cover Project');
    const assetId = insertPreviewAsset(db, projectId, 'sidebar-cover.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);

    const attachPrimaryImages = vi.spyOn(app.locals.bookPrimaryImageService, 'attachPrimaryImages');
    const renderCapture = captureBookDetailLocals(app);
    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const locals = renderCapture.get();
    renderCapture.restore();

    expect(attachPrimaryImages).toHaveBeenCalledTimes(1);
    expect(locals.contents).toBe(locals.bookContents);
    expect(locals.book.primaryImage).toMatchObject({
      state: 'available',
      selectedAssetId: assetId,
    });
    expect(response.text).toMatch(new RegExp(
      `src="/projects/${projectId}/assets/${assetId}/preview\\?v=`,
    ));
    expect(response.text).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">${book.title}</a>`);
    expect(response.text).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">${chapter.title}</a>`);
    expect(response.text).toContain(`<a class="notes-book-nav-page-link" href="/notes/${chapterPage.id}">${chapterPage.title}</a>`);
    expect(response.text).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directPage.id}">${directPage.title}</a>`);
    expect(response.text).toContain(`<nav class="book-outline" aria-label="Contents of ${book.title}">`);
    expect(response.text).toContain(`<a class="book-outline-title" href="/notes/chapters/${chapter.id}">${chapter.title}</a>`);
    expect(response.text).toContain(`<a class="book-outline-title" href="/notes/${directPage.id}">${directPage.title}</a>`);
  });

  it('renders unavailable and absent Book primary-image fallbacks in the detail sidebar', async () => {
    const unavailableBook = app.locals.bookService.createBook({ title: 'Unavailable Sidebar Cover' });
    const noImageBook = app.locals.bookService.createBook({ title: 'No Sidebar Cover' });
    const projectId = insertProject(db, 'Unavailable Sidebar Cover Project');
    const assetId = insertPreviewAsset(db, projectId, 'unavailable-sidebar-cover.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(unavailableBook.id, assetId);
    db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?')
      .run(assetId);

    const unavailable = await agent.get(`/notes/books/${unavailableBook.id}`).expect(200);
    expect(unavailable.text).toContain('data-primary-image-state="unavailable"');
    expect(unavailable.text).toContain('Image unavailable');
    expect(unavailable.text).not.toMatch(/<img class="notes-book-cover-image/);

    const none = await agent.get(`/notes/books/${noImageBook.id}`).expect(200);
    expect(none.text).toContain('data-primary-image-state="none"');
    expect(none.text).toContain('>No image</span>');
    expect(none.text).not.toMatch(/<img class="notes-book-cover-image/);
  });

  it('renders a Book with Chapters and no direct Pages', async () => {
    const book = app.locals.bookService.createBook({ title: 'Chapter Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter One' });

    const renderCapture = captureBookDetailLocals(app);
    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const locals = renderCapture.get();
    renderCapture.restore();

    const outline = response.text.match(/<nav class="book-outline"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(outline).toContain('<ol class="book-outline-list">');
    expect(outline).toContain('<li class="book-outline-item book-outline-chapter">');
    expect(outline).toContain('<details class="book-outline-disclosure">');
    expect(outline).toContain('<summary class="book-outline-summary">');
    expect(outline).toContain(`<a class="book-outline-title" href="/notes/chapters/${chapter.id}">Chapter One</a>`);
    expect(outline).toContain('<span class="book-outline-count">0 Pages</span>');
    expect(outline).toContain('<p class="book-outline-empty">No Pages yet</p>');
    expect(outline).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
    expect(outline).not.toContain('<h2 id="notes-book-content-heading">Content</h2>');
    expect(outline).not.toContain('Edit Chapter');
    expect(outline).not.toContain('/edit');
    expect((outline.match(/<li class="book-outline-item book-outline-chapter">/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('Change order');
    expect(response.text).not.toContain('>Manage</a>');
    expect(locals.contents.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: 'chapter', id: chapter.id },
    ]);
    expect(locals.chapters).toEqual([chapter]);
    expect(locals.pages).toEqual([]);
    expect(locals.canChangeOrder).toBe(false);
  });

  it('renders direct Pages with canonical links and no Chapters', async () => {
    const book = app.locals.bookService.createBook({ title: 'Direct Pages Book' });
    const page = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Direct Page',
      content: 'Direct content',
    });

    const renderCapture = captureBookDetailLocals(app);
    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const locals = renderCapture.get();
    renderCapture.restore();

    const outline = response.text.match(/<nav class="book-outline"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(outline).toMatch(new RegExp(
      `<li class="book-outline-item book-outline-page">[\\s\\S]*?<a class="book-outline-title" href="/notes/${page.id}">Direct Page<\/a>[\\s\\S]*?<\/li>`,
    ));
    expect((outline.match(/<li class="book-outline-item book-outline-page">/g) || [])).toHaveLength(1);
    expect(outline).not.toContain('<details');
    expect(outline).not.toContain('Edit Page');
    expect(outline).not.toContain('/edit');
    expect(outline).not.toContain('<h2 id="notes-book-content-heading">Content</h2>');
    expect(outline).not.toContain('notes-book-chapters-heading');
    expect(outline).not.toContain('notes-book-pages-heading');
    expect(outline).not.toContain('No Pages or Chapters yet');
    expect(outline).not.toContain('No pages yet');
    expect(outline).not.toContain('No chapters yet');
    expect(response.text).not.toContain('Change order');
    expect(response.text).not.toContain('>Manage</a>');
    expect(locals.contents.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: 'page', id: page.id },
    ]);
    expect(locals.chapters).toEqual([]);
    expect(locals.pages.map(({ id }) => id)).toEqual([page.id]);
    expect(locals.canChangeOrder).toBe(false);
  });

  it('renders both child types while excluding Chapter Pages and Pages from other Books', async () => {
    const book = app.locals.bookService.createBook({ title: 'Mixed Book' });
    const otherBook = app.locals.bookService.createBook({ title: 'Other Book' });
    const pageA = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Page A',
      content: 'Page A content',
    });
    const chapterX = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter X' });
    const chapterPage = app.locals.noteService.createNote({
      chapterId: chapterX.id,
      title: 'Chapter X Page A',
      content: 'Nested content A',
    });
    const chapterPageSecond = app.locals.noteService.createNote({
      chapterId: chapterX.id,
      title: 'Chapter X Page B',
      content: 'Nested content B',
    });
    const pageB = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Page B',
      content: 'Page B content',
    });
    const chapterY = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Y' });
    const chapterYPage = app.locals.noteService.createNote({
      chapterId: chapterY.id,
      title: 'Chapter Y Page',
      content: 'Nested content Y',
    });
    const otherBookPage = app.locals.noteService.createNote({
      bookId: otherBook.id,
      title: 'Other Book Page',
      content: 'Other content',
    });
    const contents = [
      { type: 'page', id: pageA.id, sortOrder: 0, page: pageA },
      {
        type: 'chapter',
        id: chapterX.id,
        sortOrder: 1,
        chapter: chapterX,
        pages: [chapterPage, chapterPageSecond],
      },
      { type: 'page', id: pageB.id, sortOrder: 2, page: pageB },
      {
        type: 'chapter',
        id: chapterY.id,
        sortOrder: 3,
        chapter: chapterY,
        pages: [chapterYPage],
      },
    ];
    const listBookContents = vi.spyOn(app.locals.bookService, 'listBookContents').mockReturnValue(contents);
    const listChapters = vi.spyOn(app.locals.chapterService, 'listChapters');
    const listPages = vi.spyOn(app.locals.noteService, 'listNotesForBook');
    const renderCapture = captureBookDetailLocals(app);

    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const locals = renderCapture.get();
    renderCapture.restore();
    const outline = response.text.match(/<nav class="book-outline"[\s\S]*?<\/nav>/)?.[0] || '';
    const topLevelStarts = [...outline.matchAll(
      /<li class="book-outline-item (?:book-outline-page|book-outline-chapter)">/g,
    )].map(({ index }) => index);
    const topLevelItems = topLevelStarts.map((start, index) => (
      outline.slice(start, topLevelStarts[index + 1] ?? outline.length)
    ));
    const topLevelTitles = topLevelItems.map((item) => item.match(
      /<a class="book-outline-title"[^>]*>([^<]+)<\/a>/,
    )?.[1]);
    const chapterXChildTitles = [...topLevelItems[1].matchAll(
      /<li class="book-outline-item book-outline-page book-outline-page--child">[\s\S]*?<a class="book-outline-title"[^>]*>([^<]+)<\/a>/g,
    )].map(([, title]) => title);

    expect(listBookContents).toHaveBeenCalledWith(book.id);
    expect(listChapters).not.toHaveBeenCalled();
    expect(listPages).not.toHaveBeenCalled();
    expect(chapterX.id).toBe(pageA.id);
    expect(locals.contents).toBe(contents);
    expect(locals.contents.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: 'page', id: pageA.id },
      { type: 'chapter', id: chapterX.id },
      { type: 'page', id: pageB.id },
      { type: 'chapter', id: chapterY.id },
    ]);
    expect(locals.chapters).toEqual([chapterX, chapterY]);
    expect(locals.pages).toEqual([pageA, pageB]);
    expect(locals.canChangeOrder).toBe(true);
    expect(outline).toContain('<ol class="book-outline-list">');
    expect(topLevelTitles).toEqual(['Page A', 'Chapter X', 'Page B', 'Chapter Y']);
    expect(topLevelStarts).toHaveLength(4);
    expect(topLevelItems[1]).toContain(`<a class="book-outline-title" href="/notes/chapters/${chapterX.id}">Chapter X</a>`);
    expect(topLevelItems[3]).toContain(`<a class="book-outline-title" href="/notes/chapters/${chapterY.id}">Chapter Y</a>`);
    expect(topLevelItems[0]).toContain(`<a class="book-outline-title" href="/notes/${pageA.id}">Page A</a>`);
    expect(topLevelItems[2]).toContain(`<a class="book-outline-title" href="/notes/${pageB.id}">Page B</a>`);
    expect(topLevelItems[1]).toContain('<span class="book-outline-count">2 Pages</span>');
    expect(topLevelItems[3]).toContain('<span class="book-outline-count">1 Page</span>');
    expect(chapterXChildTitles).toEqual(['Chapter X Page A', 'Chapter X Page B']);
    expect(topLevelItems[1]).not.toContain('Chapter Y Page');
    expect(topLevelItems[3]).not.toContain('Chapter X Page A');
    expect(outline).not.toContain(`href="/notes/${otherBookPage.id}">Other Book Page</a>`);
    expect(outline).not.toContain('Other Book Page');
    expect((outline.match(/<li class="book-outline-item book-outline-page book-outline-page--child">/g) || [])).toHaveLength(3);
    expect((outline.match(/<details class="book-outline-disclosure">/g) || [])).toHaveLength(2);
    expect(outline).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
    expect(outline).not.toContain('<h2 id="notes-book-content-heading">Content</h2>');
    expect(outline).not.toContain('Edit Chapter');
    expect(outline).not.toContain('Edit Page');
    expect(outline).not.toContain('/edit');
    expect((outline.match(new RegExp(`<a class="book-outline-title" href="/notes/${pageA.id}">Page A<\/a>`, 'g')) || [])).toHaveLength(1);
    expect((outline.match(new RegExp(`<a class="book-outline-title" href="/notes/${pageB.id}">Page B<\/a>`, 'g')) || [])).toHaveLength(1);
    expect(response.text).toContain(`<a class="button button-secondary" href="/notes/books/${book.id}/order">Change order</a>`);
    expect(response.text).not.toContain('>Manage</a>');
    expect(response.text).not.toContain('Move up');
    expect(response.text).not.toContain('Move down');
    expect(response.text).not.toContain('Danger zone');

    const orderPage = await agent.get(`/notes/books/${book.id}/order`).expect(200);
    expect(orderPage.text).toContain('<title>CreatorCrate — Notes — Change order — Mixed Book</title>');
    expect(orderPage.text).toContain('<h1 class="app-section-title">Notes — Change order — Mixed Book</h1>');
    expect(orderPage.text).not.toContain('notes-hierarchy');
    expect(orderPage.text).toContain('<button class="button button-primary" type="submit" form="notes-book-order-form">Save</button>');
    expect(orderPage.text).toContain(`<a class="button button-secondary" href="/notes/books/${book.id}">Cancel</a>`);
    expect(orderPage.text).toContain(`<form id="notes-book-order-form" method="post" action="/notes/books/${book.id}/contents/reorder" data-book-content-reorder-form>`);
    expect(orderPage.text).toMatch(/<form[^>]+data-book-content-reorder-form[\s\S]*?name="_csrf"[^>]+value="[^"]+"/);
    expect(orderPage.text.match(/name="orderedItems"/g) || []).toHaveLength(1);
    expect(orderPage.text).toContain(`<input type="hidden" name="orderedItems" data-book-content-order-input value="${contents.map(({ type, id }) => `${type}:${id}`).join(',')}">`);
    expect((orderPage.text.match(/data-book-content-reorder-item/g) || [])).toHaveLength(4);
    expect((orderPage.text.match(/data-book-content-reorder-handle/g) || [])).toHaveLength(4);
    expect((orderPage.text.match(/draggable="true"/g) || [])).toHaveLength(8);
    expect(orderPage.text).toContain(`data-content-key="page:${pageA.id}"`);
    expect(orderPage.text).toContain(`data-content-key="chapter:${chapterX.id}"`);
    expect(orderPage.text).toContain(`data-content-key="page:${pageB.id}"`);
    expect(orderPage.text).toContain(`data-content-key="chapter:${chapterY.id}"`);
    expect(orderPage.text).toContain('aria-label="Reorder Chapter: Chapter X"');
    expect(orderPage.text).toContain('aria-label="Reorder Page: Page A"');
    expect(orderPage.text).toContain('Position 1 of 4');
    const orderList = orderPage.text.match(/<ol[\s\S]*?data-book-content-reorder-list[\s\S]*?<\/ol>/)?.[0] || '';
    expect(orderList.indexOf('Page A')).toBeLessThan(orderList.indexOf('Chapter X'));
    expect(orderList.indexOf('Chapter X')).toBeLessThan(orderList.indexOf('Page B'));
    expect(orderList.indexOf('Page B')).toBeLessThan(orderList.indexOf('Chapter Y'));
    expect(orderPage.text).not.toContain('Book ordering controls will be available here in a future update.');
    expect(orderPage.text).toContain(`<a href="/notes/chapters/${chapterX.id}">Chapter X</a>`);
    expect(orderPage.text).toContain(`<a href="/notes/${pageA.id}">Page A</a>`);
    expect(orderPage.text).not.toContain('Chapter Page');
    expect(orderPage.text).not.toContain('Other Book Page');
    expect(orderPage.text).not.toContain('orderedChapterIds');
    expect(orderPage.text).not.toContain('orderedNoteIds');
    expect(listBookContents).toHaveBeenCalledTimes(2);
    expect(listChapters).not.toHaveBeenCalled();
    expect(listPages).not.toHaveBeenCalled();
  });

  it('renders controlled empty and one-item Book order pages', async () => {
    const emptyBook = app.locals.bookService.createBook({ title: 'Empty Order Book' });
    const empty = await agent.get(`/notes/books/${emptyBook.id}/order`).expect(200);
    expect(empty.text).toContain('This Book has no Chapters or direct Pages to order yet.');
    expect(empty.text).toContain(`<a class="button button-secondary" href="/notes/books/${emptyBook.id}">Cancel</a>`);
    expect(empty.text).not.toContain('data-book-content-reorder-list');
    expect(empty.text).not.toContain('<form id="notes-book-order-form"');

    const oneBook = app.locals.bookService.createBook({ title: 'One Item Order Book' });
    const page = app.locals.noteService.createNote({
      bookId: oneBook.id,
      title: 'Only Order Page',
      content: 'Only content',
    });
    const one = await agent.get(`/notes/books/${oneBook.id}/order`).expect(200);
    expect(one.text).toContain('<button class="button button-primary" type="submit" form="notes-book-order-form">Save</button>');
    expect(one.text).toContain(`<input type="hidden" name="orderedItems" data-book-content-order-input value="page:${page.id}">`);
    expect((one.text.match(/data-book-content-reorder-item/g) || [])).toHaveLength(1);
    expect((one.text.match(/data-book-content-reorder-handle/g) || [])).toHaveLength(1);
    expect(one.text).not.toContain('Chapter Page');
  });

  it('enables Change order for one Chapter and one direct Page', async () => {
    const book = app.locals.bookService.createBook({ title: 'Two Contents Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
    const page = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Direct Page',
      content: 'Direct content',
    });

    const renderCapture = captureBookDetailLocals(app);
    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const locals = renderCapture.get();
    renderCapture.restore();

    expect(locals.contents).toHaveLength(2);
    expect(locals.canChangeOrder).toBe(true);
    expect(response.text).toContain(`<a class="button button-secondary" href="/notes/books/${book.id}/order">Change order</a>`);
    expect(locals.chapters).toEqual([chapter]);
    expect(locals.pages.map(({ id }) => id)).toEqual([page.id]);
  });

  it('does not count Chapter Pages as Book-level contents', async () => {
    const book = app.locals.bookService.createBook({ title: 'Nested Page Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
    const chapterPage = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Chapter Page',
      content: 'Nested content',
    });

    const renderCapture = captureBookDetailLocals(app);
    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const locals = renderCapture.get();
    renderCapture.restore();

    expect(locals.contents.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: 'chapter', id: chapter.id },
    ]);
    expect(locals.pages).toEqual([]);
    expect(locals.canChangeOrder).toBe(false);
    const chapterOutline = response.text.match(new RegExp(
      `<li class="book-outline-item book-outline-chapter">[\\s\\S]*?<a class="book-outline-title" href="/notes/chapters/${chapter.id}">Chapter</a>[\\s\\S]*?</details>\\s*</li>`,
    ))?.[0] || '';
    expect(chapterOutline).toMatch(new RegExp(
      `<li class="book-outline-item book-outline-page book-outline-page--child">\\s*<a class="book-outline-title" href="/notes/${chapterPage.id}">Chapter Page</a>`,
    ));
    expect(response.text).not.toMatch(new RegExp(
      `<li class="book-outline-item book-outline-page">\\s*<a class="book-outline-title" href="/notes/${chapterPage.id}">Chapter Page</a>`,
    ));
    expect(response.text).not.toContain('Change order');
  });

  it('propagates BookContentIntegrityError without falling back to legacy child queries', async () => {
    const book = app.locals.bookService.createBook({ title: 'Corrupt Book' });
    const integrityError = new BookContentIntegrityError('Book contents are inconsistent.', {
      code: 'CONTENT_ITEM_NOT_FOUND',
    });
    const listBookContents = vi.spyOn(app.locals.bookService, 'listBookContents')
      .mockImplementation(() => { throw integrityError; });
    const listChapters = vi.spyOn(app.locals.chapterService, 'listChapters');
    const listPages = vi.spyOn(app.locals.noteService, 'listNotesForBook');

    await agent.get('/not-found').expect(404);
    const response = await agent.get(`/notes/books/${book.id}`).expect(500);

    expect(response.text).toContain('<p class="error-status">500</p>');
    const logs = app.locals.applicationLogRepository
      .findPage({ level: 'error', kind: 'diagnostic', subsystem: 'http' })
      .filter((entry) => entry.event === 'runtime.http.unhandled_error');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 'error',
      kind: 'diagnostic',
      subsystem: 'http',
      event: 'runtime.http.unhandled_error',
    });
    expect(JSON.parse(logs[0].context_json)).toEqual({
      method: 'GET',
      status: 500,
      error: {
        name: 'BookContentIntegrityError',
        message: 'Book contents are inconsistent.',
        code: 'CONTENT_ITEM_NOT_FOUND',
      },
    });
    expect(listBookContents).toHaveBeenCalledWith(book.id);
    expect(listChapters).not.toHaveBeenCalled();
    expect(listPages).not.toHaveBeenCalled();
  });


  it('preserves final 500 responses when an injected runtime logger throws', async () => {
    const normalBook = app.locals.bookService.createBook({ title: 'Normal logger failure' });
    const normalError = new BookContentIntegrityError('Book contents are inconsistent.', {
      bookId: normalBook.id,
    });
    vi.spyOn(app.locals.bookService, 'listBookContents')
      .mockImplementation(() => { throw normalError; });

    const normalResponse = await agent
      .get(`/notes/books/${normalBook.id}`)
      .set('Accept', 'application/json')
      .expect(500);
    const normalLogs = app.locals.applicationLogRepository
      .findPage({ level: 'error', kind: 'diagnostic', subsystem: 'http' })
      .filter((entry) => entry.event === 'runtime.http.unhandled_error');
    expect(normalLogs).toHaveLength(1);

    await agent
      .post('/notes/books/999999')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Missing' })
      .expect(404);
    const logsAfter4xx = app.locals.applicationLogRepository
      .findPage({ level: 'error', kind: 'diagnostic', subsystem: 'http' })
      .filter((entry) => entry.event === 'runtime.http.unhandled_error');
    expect(logsAfter4xx).toHaveLength(1);

    const loggerFailure = new Error('simulated injected logger failure');
    const applicationLogger = {
      error: vi.fn(() => { throw loggerFailure; }),
      info: vi.fn(),
      warn: vi.fn(),
      rebindRepository: vi.fn(),
      prune: vi.fn(),
    };
    const failingProjectsRoot = path.join(tmpDir, 'projects');
    const failingAppDataRoot = path.join(tmpDir, 'app');
    const failingTagRepository = createTagRepository(db);
    const { csrfPepper } = ensureAuthEnablement(failingAppDataRoot);
    const failingApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot: failingProjectsRoot },
      {
        appDataRoot: failingAppDataRoot,
        authState: { csrfPepper },
        tagRepository: failingTagRepository,
        applicationLogger,
      },
    );
    const { agent: failingAgent } = await getDisabledModeCsrf(failingApp, failingAppDataRoot);
    const failingBook = failingApp.locals.bookService.createBook({ title: 'Throwing logger failure' });
    const failingError = new BookContentIntegrityError('Book contents are inconsistent.', {
      bookId: failingBook.id,
    });
    vi.spyOn(failingApp.locals.bookService, 'listBookContents')
      .mockImplementation(() => { throw failingError; });

    const failingResponse = await failingAgent
      .get(`/notes/books/${failingBook.id}`)
      .set('Accept', 'application/json')
      .expect(500);

    expect(applicationLogger.error).toHaveBeenCalledTimes(1);
    expect(failingResponse.status).toBe(normalResponse.status);
    expect(failingResponse.text).toBe(normalResponse.text);
    expect(failingResponse.headers['content-type']).toBe(normalResponse.headers['content-type']);
    expect(failingResponse.headers['cache-control']).toBe(normalResponse.headers['cache-control']);
    expect(failingResponse.text).not.toContain(loggerFailure.message);
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
    expect(form.text).toContain('<h1 class="app-section-title">Notes — Edit Before</h1>');
    expect(form.text).not.toContain('notes-hierarchy');
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
    expect(invalid.text).toContain('<h1 class="app-section-title">Notes — Edit Stored title</h1>');
    expect(invalid.text).not.toContain('notes-hierarchy');
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
