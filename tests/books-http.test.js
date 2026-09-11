import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { BookContentIntegrityError } from '../src/services/book-service.js';
import { expectBookCoverForm } from './helpers/book-cover-form.js';
import { createTagRepository } from '../src/data/tag-repository.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function expectBookSections(dialog, { edit = false, hasCover = false } = {}) {
  expect(dialog).toContain('class="app-dialog project-form-dialog"');
  const sections = [...dialog.matchAll(/<section class="settings-section project-form-section project-edit-dialog-section"[^>]*>[\s\S]*?<\/section>/g)].map(([section]) => section);
  expect(sections).toHaveLength(2);
  expect(sections[0]).toContain('data-notes-dialog-compact-section data-notes-book-details-section');
  expect(sections[0]).toContain('<h3>Book details</h3>');
  for (const section of sections) {
    expect(section).toContain('class="project-form-section-body project-edit-dialog-section-body"');
    expect(section).toContain('field app-dialog-field');
  }
  expect(sections[1]).toContain('data-notes-book-actions-section');
  expect(sections[1]).toContain('<h3 id="book-actions-heading">Book actions</h3>');
  expect(dialog.match(/<h[1-6][^>]*>Book actions<\/h[1-6]>/g)).toHaveLength(1);
  expect(dialog).not.toContain('Secondary actions');
  expect(sections[1]).toContain('name="cover"');
  expect(sections[0]).not.toContain('notes-book-cover');
  const disclosures = [...sections[1].matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)]
    .map(([details]) => details).filter((details) => details.includes('<summary>Book cover</summary>'));
  expect(disclosures).toHaveLength(1);
  const disclosure = disclosures[0];
  expect(disclosure).toContain('class="notes-workspace-disclosure"');
  expect(disclosure).toContain('class="notes-workspace-disclosure-content"');
  expect(disclosure).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  expect(disclosure.match(/<input\b[^>]*type="file"[^>]*name="cover"/g)).toHaveLength(1);
  expect(disclosure).toContain('<label for="book-cover">');
  expect(disclosure).toContain('id="book-cover"');
  for (const markup of [dialog, disclosure]) {
    expect(markup.match(/class="notes-book-cover(?: |")/g) || []).toHaveLength(hasCover ? 1 : 0);
    expect(markup.match(/<img\b/g) || []).toHaveLength(hasCover ? 1 : 0);
  }
  if (!hasCover) expect(disclosure).not.toContain('notes-book-cover-placeholder');
  const ids = [...dialog.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  if (edit) {
    expect(sections[1]).toContain('form="book-delete-form"');
  }
}

function expectNewBookDialog(html, open) {
  expectBookCoverForm(html);
  const dialog = html.match(/<dialog\b[^>]*id="book-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  expectBookSections(dialog);
  expect(dialog).toContain('data-app-dialog');
  expect(dialog).toContain('aria-labelledby="book-create-dialog-title"');
  expect(dialog).toContain('<h2 id="book-create-dialog-title">New Book</h2>');
  expect(dialog).toContain('data-dialog-close aria-label="Close New Book"');
  expect(dialog).toContain('class="app-dialog-header"');
  expect(dialog).toContain('class="app-dialog-body"');
  expect(dialog).toContain('class="app-dialog-footer"');
  expect(/<dialog\b[^>]*\sopen(?:\s|>)/.test(dialog)).toBe(open);
  expect(dialog).not.toContain('data-dialog-backdrop-static');
  expect(dialog).toContain('data-dialog-form data-dialog-async="false" novalidate');
  expect(dialog.match(/<form\b/g)).toHaveLength(1);
  expect(html.match(/<form\b[^>]*id="book-form"/g)).toHaveLength(1);
  expect(dialog).toContain('<form id="book-form" method="post" action="/notes/books"');
  let formDepth = 0;
  for (const [tag] of html.matchAll(/<\/?form\b[^>]*>/g)) {
    formDepth += tag.startsWith('</') ? -1 : 1;
    expect(formDepth).toBeGreaterThanOrEqual(0);
    expect(formDepth).toBeLessThanOrEqual(1);
  }
  expect(formDepth).toBe(0);
  expect(html).toContain('<section class="notes-books-index" aria-label="Books">');
}

function expectEditBookDialog(html, bookId, open, hasCover = false) {
  const dialog = html.match(/<dialog\b[^>]*id="book-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  expectBookSections(dialog, { edit: true, hasCover });
  expect(dialog).toContain('data-app-dialog');
  expect(dialog).toContain('aria-labelledby="book-edit-dialog-title"');
  expect(dialog).toContain('<h2 id="book-edit-dialog-title">Edit Book</h2>');
  expect(dialog).toContain('data-dialog-close aria-label="Close Edit Book"');
  for (const part of ['header', 'body', 'footer']) expect(dialog).toContain('class="app-dialog-' + part + '"');
  expect(/<dialog\b[^>]*\sopen(?:\s|>)/.test(dialog)).toBe(open);
  expect(dialog).not.toContain('data-dialog-backdrop-static');
  expect(dialog).toContain('data-dialog-form data-dialog-async="false" novalidate');
  expect(dialog).toContain('type="submit" data-dialog-submit>Save</button>');
  expect(dialog).toContain('<form id="book-form" method="post" action="/notes/books/' + bookId + '"');
  expect(dialog).toMatch(/<form id="book-form"[\s\S]*?name="_csrf"[^>]+value="[^"]+"/);
  expect(dialog.match(/<form\b/g)).toHaveLength(2);
  for (const id of ['book-form', 'book-delete-form']) {
    expect(html.match(new RegExp('<form\\b[^>]*id="' + id + '"', 'g'))).toHaveLength(1);
  }
  let depth = 0;
  for (const [tag] of html.matchAll(/<\/?form\b[^>]*>/g)) {
    depth += tag.startsWith('</') ? -1 : 1;
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(depth).toBeLessThanOrEqual(1);
  }
  expect(depth).toBe(0);
  expect(html).toContain('class="notes-page-detail-layout"');
  expect(html).toContain('href="/notes/books/' + bookId + '/edit" data-dialog-open="book-edit-dialog"');
}

function expectNewChapterDialog(html, bookId, open, hasBookCover = false) {
  const dialog = html.match(/<dialog\b[^>]*id="chapter-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  expect(dialog).toContain('class="app-dialog project-form-dialog"');
  expect(dialog).toContain('class="app-dialog-form project-form project-edit-dialog-form"');
  const sections = [...dialog.matchAll(/<section class="settings-section project-form-section project-edit-dialog-section"[^>]*>([\s\S]*?)<\/section>/g)];
  expect(sections).toHaveLength(1);
  expect(dialog).not.toContain('Chapter Actions');
  expect(dialog).not.toContain('chapter-delete-form');
  expect(sections[0][1]).toMatch(/^\s*<h3>Basic information<\/h3>\s*<div class="project-form-section-body project-edit-dialog-section-body">/);
  expect(dialog.match(/>Basic information<\/h[1-6]>/g)).toHaveLength(1);
  expect(sections[0][1]).toContain('field app-dialog-field');
  expect(dialog.match(/name="title"/g)).toHaveLength(1);
  expect(dialog).toContain('<label for="chapter-create-title">');
  expect(dialog).toContain('id="chapter-create-title" name="title"');

  expect(dialog).toContain('data-app-dialog');
  expect(dialog).toContain('aria-labelledby="chapter-create-dialog-title"');
  expect(dialog).toContain('<h2 id="chapter-create-dialog-title">New Chapter</h2>');
  expect(dialog).toContain('data-dialog-close aria-label="Close New Chapter"');
  for (const part of ['header', 'body', 'footer']) expect(dialog).toContain('class="app-dialog-' + part + '"');
  expect(/<dialog\b[^>]*\sopen(?:\s|>)/.test(dialog)).toBe(open);
  expect(dialog).not.toContain('data-dialog-backdrop-static');
  expect(dialog).toContain('data-dialog-form data-dialog-async="false" novalidate');
  expect(dialog).toContain('<form id="chapter-form" method="post" action="/notes/books/' + bookId + '/chapters"');
  expect(dialog).toMatch(/name="_csrf"[^>]+value="[^"]+"/);
  expect(dialog.match(/<form\b/g)).toHaveLength(1);
  expect(html.match(/id="chapter-form"/g)).toHaveLength(1);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html).toContain('href="/notes/books/' + bookId + '/chapters/new" data-dialog-open="chapter-create-dialog"');
  expectEditBookDialog(html, bookId, false, hasBookCover);
  return dialog;
}

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
    `INSERT INTO projects (title, slug, description, notes, status, patreon_url)
     VALUES (?, ?, '', '', 'tbd', NULL)`
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

function expectBookDetailIconControl(html, { label, href, dialogTarget, dataHook }) {
  const control = html.match(new RegExp(`<a\\b[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?<\\/a>`))?.[0] || '';
  expect(control).not.toBe('');
  expect(control).toContain(`aria-label="${label}"`);
  expect(control).toContain(`data-tooltip="${label}"`);
  expect(control).toContain(`href="${href}"`);
  if (dialogTarget) {
    expect(control).toContain(`data-dialog-open="${dialogTarget}"`);
  }
  if (dataHook) {
    expect(control).toContain(dataHook);
  }
  expect(control).toContain('<svg');
  return control;
}

function expectBookDetailControlsInOrder(html, controls) {
  const positions = controls.map((control) => html.indexOf(control));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
}

function findBookDetailToolbar(html) {
  return html.match(
    /<div class="asset-viewer-display-controls" data-book-detail-toolbar>\s*<a class="button button-secondary" href="\/notes">Back to book list<\/a>\s*<div class="project-filter-actions project-filter-actions--projects">[\s\S]*?<\/div>\s*<\/div>/,
  )?.[0] || '';
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

  it('hosts New Chapter on Book detail and opens it through the direct URL', async () => {
    const book = app.locals.bookService.createBook({ title: 'Chapter Host' });
    const detail = await agent.get('/notes/books/' + book.id).expect(200);
    expectNewChapterDialog(detail.text, book.id, false);
    const direct = await agent.get('/notes/books/' + book.id + '/chapters/new').expect(200);
    expectNewChapterDialog(direct.text, book.id, true);
    expect(direct.text).toContain('No Pages or Chapters yet');
  });

  it('reopens New Chapter with values, errors and complete Book context on validation failure', async () => {
    const book = app.locals.bookService.createBook({ title: 'Validation Host' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Existing Chapter' });
    const page = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page' });
    const nested = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Nested Page' });
    const projectId = insertProject(db, 'Chapter Host Cover');
    const assetId = insertPreviewAsset(db, projectId);
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    for (const title of ['   ', 'x'.repeat(201)]) {
      const response = await agent.post('/notes/books/' + book.id + '/chapters').type('form')
        .send({ _csrf: csrfToken, title }).expect(422);
      const dialog = expectNewChapterDialog(response.text, book.id, true, true);
      expect(dialog).toContain('value="' + title + '"');
      expect(dialog).toContain('aria-describedby="chapter-create-title-error" aria-invalid="true"');
      expect(dialog).toMatch(/id="chapter-create-title-error">[^<]+/);
      expect(response.text).toContain('value="Validation Host"');
      expect(response.text).toContain('Existing Chapter');
      expect(response.text).toContain('href="/notes/' + page.id + '"');
      expect(response.text).toContain('href="/notes/' + nested.id + '"');
      expect(response.text).toContain('Change order');
      expect(findBookCoverImage(response.text, assetId, 'preview')).not.toBe('');
    }
    expect(app.locals.chapterService.listChapters(book.id)).toHaveLength(1);
  });

  it('renders an empty Books landing rather than the legacy flat Notes list', async () => {
    const response = await agent.get('/notes').expect(200);

    expect(response.text).toContain('<h1 class="app-section-title">Notes</h1>');
    expect(response.text.match(/href="\/notes\/books\/new" data-dialog-open="book-create-dialog"/g)).toHaveLength(2);
    expectNewBookDialog(response.text, false);
    expect(response.text).toContain('<h2 class="empty-state-heading">No books yet</h2>');
    expect(response.text).toContain('<header class="page-heading">');
    expect(response.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain('Change order');
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
    expect(response.text).toContain(`<a class="button button-small button-secondary" href="/notes/books/${book.id}/edit" data-dialog-invocation aria-label="Edit Book: Single Book">Edit Book</a>`);
    expect(response.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain('Change order');
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
    expect(booksList).toContain(`<a class="button button-small button-secondary" href="/notes/books/${second.id}/edit" data-dialog-invocation aria-label="Edit Book: Second Book">Edit Book</a>`);
    expect(booksList).toContain(`<a class="button button-small button-secondary" href="/notes/books/${first.id}/edit" data-dialog-invocation aria-label="Edit Book: First Book">Edit Book</a>`);
    expect(response.text).toContain('<a class="button button-secondary" href="/notes/books/order" data-dialog-open="books-order-dialog">Change order</a>');
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
    const managedBook = app.locals.bookService.createBook({ title: 'Managed cover' });
    const managedCover = app.locals.managedAssetRepository.insertCommitted({
      id: 'managed-cover', storageKey: 'book-covers/managed-cover/source.png',
      namespace: 'book-covers', mimeType: 'image/png', sizeBytes: 20,
      width: 2, height: 2, sha256: 'a'.repeat(64),
    });
    app.locals.bookPrimaryImageService.setManagedPrimaryImage(managedBook.id, managedCover.id);
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
    expect(locals.books.find((book) => book.id === managedBook.id)).toMatchObject({
      primaryImage: { selectedSource: { kind: 'managed_asset', id: managedCover.id },
        selectedAssetId: null, state: 'unavailable', previewUrl: null, thumbnailUrl: null },
    });
    expect(locals.books.find((book) => book.id === managedBook.id)).not.toHaveProperty('nsfwBlur');
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

  it('hosts top-level Book ordering on Notes before dynamic Book detail routing', async () => {
    const first = app.locals.bookService.createBook({ title: 'Order First Book' });
    const second = app.locals.bookService.createBook({ title: 'Order Second Book' });
    const third = app.locals.bookService.createBook({ title: 'Order Third Book' });
    const orderedBooks = [third, first, second];
    app.locals.bookService.reorderBooks(orderedBooks.map((book) => book.id));

    const response = await agent.get('/notes/books/order').expect(200);

    expect(response.text).toContain('id="books-order-dialog"');
    expect(response.text).toMatch(/<dialog[^>]*id="books-order-dialog"[^>]* open/);
    expect(response.text).toContain('class="notes-books-index"');
    expect((response.text.match(/<h1\b/g) || [])).toHaveLength(1);
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="notes-books-order-form" data-dialog-submit>Save</button>');
    const booksOrderDialog = response.text.match(/<dialog\b[^>]*id="books-order-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(booksOrderDialog).not.toContain('>Cancel<');
    expect(response.text).toContain('<h3 id="notes-books-order-heading">Books</h3>');
    expect(response.text).toContain('Drag a Book card to move it');
    expect(response.text).toContain('<form id="notes-books-order-form" method="post" action="/notes/books/reorder" data-book-reorder-form');
    expect(response.text).toContain(`<input type="hidden" name="orderedBookIds" data-book-order-input value="${orderedBooks.map((book) => book.id).join(',')}">`);
    expect(response.text).toContain('data-book-reorder-list');
    expect(response.text).toContain('data-book-reorder-live');
    expect((response.text.match(/data-book-reorder-item/g) || [])).toHaveLength(3);
    expect((response.text.match(/data-book-reorder-handle/g) || [])).toHaveLength(3);
    expect((response.text.match(/notes-reorder-row--compact/g) || [])).toHaveLength(3);
    expect((response.text.match(/draggable="true"/g) || [])).toHaveLength(9);
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
    expectNewBookDialog(form.text, true);
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
      expectNewBookDialog(response.text, true);
      expect(response.text).toContain(`value="${title}"`);
      expect(response.text).toContain('aria-describedby="title-error" aria-invalid="true"');
      expect(response.text).toContain(title ? 'Title must be 200 characters or fewer.' : 'Title is required.');
    }

    expect(app.locals.bookService.listBooks()).toEqual([]);
  });

  it('preserves the populated Books host on direct New Book and validation responses', async () => {
    const book = app.locals.bookService.createBook({ title: 'Existing Book' });
    const direct = await agent.get('/notes/books/new').expect(200);
    const invalid = await agent.post('/notes/books').type('form')
      .send({ _csrf: csrfToken, title: '   ' }).expect(422);
    for (const response of [direct, invalid]) {
      expectNewBookDialog(response.text, true);
      expect(response.text).toContain(`<a href="/notes/books/${book.id}">Existing Book</a>`);
    }
    expect(invalid.text).toContain('value="   "');
    expect(app.locals.bookService.listBooks()).toHaveLength(1);
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
    expect(response.text).toContain('<aside class="notes-page-detail-sidebar notes-book-detail-sidebar notes-surface notes-surface--compact">');
    expect(response.text).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    const navigator = response.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(navigator).not.toBe('');
    expect(navigator).not.toContain('notes-book-nav-book-link');
    expect(response.text).toContain('<section class="notes-detail-panel notes-detail-details" aria-labelledby="notes-book-details-heading">');
    expect(response.text).toContain('<h2 id="notes-book-details-heading">Details</h2>');
    expect(response.text).toContain('<dl class="detail-list">');
    expect(response.text).toContain('<dt>Created</dt>');
    expect(response.text).toContain(`<dd>${book.created_at}</dd>`);
    expect(response.text).toContain('<dt>Updated</dt>');
    expect(response.text).toContain(`<dd>${book.updated_at}</dd>`);
    expect(response.text).toContain('data-primary-image-state="none"');
    expect(response.text).not.toContain('class="book-outline"');
    expect(response.text).toContain('<section class="notes-detail-panel notes-page-previews"');
    expect(response.text).toContain('<p class="notes-page-previews-empty">No Pages to preview.</p>');
    expect(response.text).not.toContain('<h2 id="notes-book-content-heading">Content</h2>');
    expect(response.text).not.toContain('notes-book-section');
    expect(response.text).not.toContain('notes-book-content-list');
    expect(response.text).not.toContain('notes-book-chapters-heading');
    expect(response.text).not.toContain('notes-book-pages-heading');
    expect(response.text).not.toContain('No chapters yet');
    expect(response.text).not.toContain('No pages yet');
    expect(response.text).toContain(`<a class="button button-primary" href="/notes/new?bookId=${book.id}" data-dialog-open="note-create-dialog">New Page</a>`);
    expect(response.text).toContain(`<a class="button" href="/notes/books/${book.id}/chapters/new" data-dialog-open="chapter-create-dialog">New Chapter</a>`);
    const pageHeading = response.text.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0] || '';
    const toolbar = findBookDetailToolbar(response.text);
    expect(toolbar).not.toBe('');
    expect(pageHeading).not.toContain('aria-label="Edit book"');
    expect(pageHeading).not.toContain('aria-label="Book defaults"');
    expect(pageHeading).not.toContain('aria-label="Reset to default"');
    expect(response.text.indexOf(toolbar)).toBeGreaterThan(response.text.indexOf('</header>'));
    expect(response.text.indexOf(toolbar)).toBeLessThan(response.text.indexOf('<div class="notes-page-detail-layout">'));
    expectBookDetailIconControl(toolbar, {
      label: 'Edit book',
      href: `/notes/books/${book.id}/edit`,
      dialogTarget: 'book-edit-dialog',
    });
    expect(toolbar).not.toContain('aria-label="Change order"');
    expect(response.text).not.toMatch(/<a[^>]*>Change order<\/a>/);
    expect(response.text).not.toContain('>Manage</a>');
    expect(response.text).not.toContain('Move up');
    expect(response.text).not.toContain('Move down');
    expect(response.text).not.toContain('Danger zone');
    expectEditBookDialog(response.text, book.id, false);
    const host = response.text.replace(/<dialog\b[^>]*id="book-edit-dialog"[\s\S]*?<\/dialog>/, '');
    expect(host).not.toContain(`/notes/books/${book.id}/delete`);
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

  it('renders Page previews in place of the redundant outline while retaining the polished Book sidebar', async () => {
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
    const sidebar = response.text.match(/<aside class="notes-page-detail-sidebar notes-book-detail-sidebar[^"]*">[\s\S]*?<\/aside>/)?.[0] || '';
    expect(sidebar).not.toBe('');
    expect(sidebar).not.toContain('notes-book-nav-book-link');
    expect(sidebar).not.toContain('View Chapter');
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">${book.title}</a>`);
    const newPageDialog = response.text.match(/<dialog\b[^>]*id="note-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(newPageDialog).not.toBe('');
    expect(newPageDialog).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(newPageDialog).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">${book.title}</a>`);
    expect(newPageDialog).toContain(`<span class="notes-book-nav-chapter-title">${chapter.title}</span>`);
    expect(newPageDialog).not.toContain('View Chapter');
    expect(newPageDialog).toContain(`<a class="notes-book-nav-page-link" href="/notes/${chapterPage.id}">${chapterPage.title}</a>`);
    expect(newPageDialog).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directPage.id}">${directPage.title}</a>`);
    expect(response.text).not.toContain('class="book-outline"');
    const previews = response.text.match(/<section class="notes-detail-panel notes-page-previews"[\s\S]*?<\/section>/)?.[0] || '';
    expect(previews).toContain(`<a class="notes-page-preview-title" href="/notes/${chapterPage.id}">${chapterPage.title}</a>`);
    expect(previews).toContain(`<a class="notes-page-preview-title" href="/notes/${directPage.id}">${directPage.title}</a>`);
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

    const navigator = response.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(navigator).toContain('<span class="notes-book-nav-chapter-title">Chapter One</span>');
    expect(navigator).not.toContain('View Chapter');
    expect(response.text).not.toContain('class="book-outline"');
    expect(response.text).toContain('No Pages to preview.');
    expect(response.text).not.toMatch(/<a[^>]*>Change order<\/a>/);
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

    const previews = response.text.match(/<section class="notes-detail-panel notes-page-previews"[\s\S]*?<\/section>/)?.[0] || '';
    expect(previews).toContain(`<a class="notes-page-preview-title" href="/notes/${page.id}">Direct Page</a>`);
    expect(response.text).not.toContain('class="book-outline"');
    expect(response.text).not.toMatch(/<a[^>]*>Change order<\/a>/);
    expect(response.text).not.toContain('>Manage</a>');
    expect(locals.contents.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: 'page', id: page.id },
    ]);
    expect(locals.chapters).toEqual([]);
    expect(locals.pages.map(({ id }) => id)).toEqual([page.id]);
    expect(locals.canChangeOrder).toBe(false);
  });

  it('renders mixed Book contents and previews direct and Chapter Pages while excluding other Books', async () => {
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
    const navigator = response.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    const previews = response.text.match(/<section class="notes-detail-panel notes-page-previews"[\s\S]*?<\/section>/)?.[0] || '';

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
    expect(navigator.indexOf('Page A')).toBeLessThan(navigator.indexOf('Chapter X'));
    expect(navigator.indexOf('Chapter X')).toBeLessThan(navigator.indexOf('Page B'));
    expect(navigator.indexOf('Page B')).toBeLessThan(navigator.indexOf('Chapter Y'));
    expect(navigator).toContain(`href="/notes/${chapterPage.id}"`);
    expect(navigator).toContain(`href="/notes/${chapterPageSecond.id}"`);
    expect(previews.match(/class="notes-page-preview-item"/g)).toHaveLength(5);
    expect(previews.indexOf('Page A')).toBeLessThan(previews.indexOf('Chapter X Page A'));
    expect(previews.indexOf('Chapter X Page B')).toBeLessThan(previews.indexOf('Page B'));
    expect(previews.indexOf('Page B')).toBeLessThan(previews.indexOf('Chapter Y Page'));
    expect(previews).not.toContain(`href="/notes/${otherBookPage.id}"`);
    expect(response.text).not.toContain('class="book-outline"');
    const toolbar = findBookDetailToolbar(response.text);
    const toolbarControls = [
      expectBookDetailIconControl(toolbar, {
        label: 'Edit book',
        href: `/notes/books/${book.id}/edit`,
        dialogTarget: 'book-edit-dialog',
      }),
      expectBookDetailIconControl(toolbar, {
        label: 'Change order',
        href: `/notes/books/${book.id}/order`,
        dialogTarget: 'book-order-dialog',
      }),
      expectBookDetailIconControl(toolbar, {
        label: 'Book defaults',
        href: `/notes/books/${book.id}?defaults=1`,
        dialogTarget: 'book-defaults-dialog',
        dataHook: 'data-book-defaults-link',
      }),
      expectBookDetailIconControl(toolbar, {
        label: 'Reset to default',
        href: `/notes/books/${book.id}`,
        dataHook: 'data-book-reset',
      }),
    ];
    expectBookDetailControlsInOrder(toolbar, toolbarControls);
    expect(response.text).not.toContain('>Manage</a>');
    expect(response.text).not.toContain('Move up');
    expect(response.text).not.toContain('Move down');
    expect(response.text).not.toContain('Danger zone');

    const orderPage = await agent.get(`/notes/books/${book.id}/order`).expect(200);
    expect(orderPage.text).toContain('<title>CreatorCrate — Notes — Mixed Book</title>');
    expect(orderPage.text).toContain('<h1 class="app-section-title">Notes — Mixed Book</h1>');
    expect(orderPage.text).toMatch(/<dialog id="book-order-dialog"[^>]* open/);
    expect(orderPage.text).toMatch(/<dialog id="book-order-dialog"[^>]*data-dialog-backdrop-static/);
    expect(response.text).toMatch(/<dialog id="book-order-dialog"[^>]*data-app-dialog[^>]*data-dialog-backdrop-static[^>]*aria/);
    expect(orderPage.text).toContain('data-dialog-close aria-label="Close Change order"');
    expect(orderPage.text).not.toContain('class="book-outline"');
    expect(orderPage.text).toContain('class="notes-detail-panel notes-page-previews"');
    const ids = [...orderPage.text.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    let depth = 0;
    for (const [tag] of orderPage.text.matchAll(/<\/?form\b[^>]*>/g)) {
      depth += tag.startsWith('</') ? -1 : 1;
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
    for (const id of ['book-edit-dialog', 'chapter-create-dialog', 'book-order-dialog']) {
      expect(orderPage.text).toContain('data-dialog-open="' + id + '"');
    }
    expect(orderPage.text).toContain('<button class="button button-primary" type="submit" form="notes-book-order-form" data-dialog-submit>Save</button>');
    const bookOrderDialog = orderPage.text.match(/<dialog\b[^>]*id="book-order-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(bookOrderDialog).not.toContain('>Cancel</button>');
    expect(bookOrderDialog).toContain('<h3 id="notes-book-order-heading">Book hierarchy</h3>');
    expect(bookOrderDialog).not.toContain('<h3 id="notes-book-order-heading">Book contents</h3>');
    expect(bookOrderDialog).toContain('Drag cards to reorder. Select Save to apply changes.');
    expect(bookOrderDialog).not.toContain('Use the handles with Up, Down, Home, or End');
    expect(orderPage.text).toContain(`<form id="notes-book-order-form" method="post" action="/notes/books/${book.id}/hierarchy/reorder" data-book-hierarchy-form`);
    expect(orderPage.text).toMatch(/<form[^>]+data-book-hierarchy-form[\s\S]*?name="_csrf"[^>]+value="[^"]+"/);
    expect(orderPage.text.match(/name="hierarchy"/g) || []).toHaveLength(1);
    const hierarchyValue = orderPage.text.match(/name="hierarchy"[^>]*value="([^"]*)"/)?.[1]
      .replaceAll('&quot;', '"');
    expect(JSON.parse(hierarchyValue)).toEqual({
      version: 1,
      expected: [
        { type: 'page', id: pageA.id },
        { type: 'chapter', id: chapterX.id, pages: [chapterPage.id, chapterPageSecond.id] },
        { type: 'page', id: pageB.id },
        { type: 'chapter', id: chapterY.id, pages: [chapterYPage.id] },
      ],
      target: [
        { type: 'page', id: pageA.id },
        { type: 'chapter', id: chapterX.id, pages: [chapterPage.id, chapterPageSecond.id] },
        { type: 'page', id: pageB.id },
        { type: 'chapter', id: chapterY.id, pages: [chapterYPage.id] },
      ],
    });
    expect((orderPage.text.match(/data-book-hierarchy-item/g) || [])).toHaveLength(7);
    expect((orderPage.text.match(/notes-reorder-row--compact/g) || [])).toHaveLength(7);
    expect(orderPage.text).not.toContain('data-book-content-reorder-form');
    expect(orderPage.text).not.toContain('data-book-content-reorder-handle');
    expect((orderPage.text.match(/data-book-hierarchy-handle/g) || [])).toHaveLength(7);
    expect((orderPage.text.match(/draggable="true"/g) || [])).toHaveLength(7);
    expect((orderPage.text.match(/data-book-hierarchy-item[^>]*draggable="true"/g) || [])).toHaveLength(7);
    expect(orderPage.text).not.toMatch(/data-book-hierarchy-handle[^>]*draggable="true"/);
    expect(orderPage.text).toContain(`data-content-key="page:${pageA.id}"`);
    expect(orderPage.text).toContain(`data-content-key="chapter:${chapterX.id}"`);
    expect(orderPage.text).toContain(`data-content-key="page:${pageB.id}"`);
    expect(orderPage.text).toContain(`data-content-key="chapter:${chapterY.id}"`);
    expect(orderPage.text).toContain('data-book-hierarchy-container="root"');
    expect(orderPage.text).toContain(`data-book-hierarchy-container="chapter:${chapterX.id}"`);
    expect(orderPage.text).toContain(`data-book-hierarchy-container="chapter:${chapterY.id}"`);
    const orderDialog = orderPage.text.match(/<dialog\b[^>]*id="book-order-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    const hierarchyMarkers = [
      `data-content-key="page:${pageA.id}"`,
      `data-content-key="chapter:${chapterX.id}"`,
      `data-content-key="page:${chapterPage.id}"`,
      `data-content-key="page:${chapterPageSecond.id}"`,
      `data-content-key="page:${pageB.id}"`,
      `data-content-key="chapter:${chapterY.id}"`,
      `data-content-key="page:${chapterYPage.id}"`,
    ].map((marker) => orderDialog.indexOf(marker));
    expect(hierarchyMarkers.every((position) => position >= 0)).toBe(true);
    expect(hierarchyMarkers).toEqual([...hierarchyMarkers].sort((left, right) => left - right));
    expect(orderDialog).not.toContain('data-book-hierarchy-destination');
    expect(orderDialog).not.toMatch(/data-book-hierarchy-move(?:\s|>)/);
    expect(orderDialog).not.toContain('Destination for Page');
    expect(orderDialog).not.toContain('>Move</button>');
    expect((orderDialog.match(/data-book-hierarchy-live/g) || [])).toHaveLength(1);
    expect(orderPage.text).not.toContain('Book ordering controls will be available here in a future update.');
    expect(orderDialog).toContain('<h3 class="notes-book-content-title">Chapter X</h3>');
    expect(orderDialog).toContain('<h3 class="notes-book-content-title">Page A</h3>');
    expect(orderDialog).toContain('<h4 class="notes-book-content-title">Chapter X Page A</h4>');
    expect(orderDialog).not.toMatch(/<a\b[^>]*>Chapter X<\/a>/);
    expect(orderDialog).not.toMatch(/<a\b[^>]*>Page A<\/a>/);
    expect(orderDialog).not.toMatch(/<a\b[^>]*>Chapter X Page A<\/a>/);
    expect(orderDialog).not.toMatch(/<a\b/);
    expect(orderPage.text.match(/<form id="notes-book-order-form"[\s\S]*?<\/form>/)?.[0]).toContain('Chapter X Page A');
    expect(orderPage.text).not.toContain('Other Book Page');
    expect(orderPage.text).not.toContain('orderedChapterIds');
    expect(orderPage.text).not.toContain('orderedNoteIds');
    expect(orderPage.text).not.toContain('orderedItems');
    expect(listBookContents).toHaveBeenCalledTimes(2);
    expect(listChapters).not.toHaveBeenCalled();
    expect(listPages).not.toHaveBeenCalled();
  });

  it('renders controlled empty and one-item Book order pages', async () => {
    const emptyBook = app.locals.bookService.createBook({ title: 'Empty Order Book' });
    const empty = await agent.get(`/notes/books/${emptyBook.id}/order`).expect(200);
    expect(empty.text).toContain('This Book has no Chapters or Pages to order yet.');
    const emptyOrderDialog = empty.text.match(/<dialog\b[^>]*id="book-order-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(emptyOrderDialog).toContain('<h3 id="notes-book-order-heading">Book hierarchy</h3>');
    expect(emptyOrderDialog).not.toContain('>Cancel</button>');
    expect(emptyOrderDialog).toContain('data-dialog-backdrop-static');
    expect(empty.text).not.toContain('data-book-hierarchy-container="root"');
    expect(empty.text.match(/<form id="notes-book-order-form"/g)).toHaveLength(1);

    const oneBook = app.locals.bookService.createBook({ title: 'One Item Order Book' });
    const page = app.locals.noteService.createNote({
      bookId: oneBook.id,
      title: 'Only Order Page',
      content: 'Only content',
    });
    const one = await agent.get(`/notes/books/${oneBook.id}/order`).expect(200);
    expect(one.text).toContain('<button class="button button-primary" type="submit" form="notes-book-order-form" data-dialog-submit>Save</button>');
    expect(one.text.match(/name="hierarchy"/g) || []).toHaveLength(1);
    expect((one.text.match(/data-book-hierarchy-item/g) || [])).toHaveLength(1);
    expect((one.text.match(/data-book-hierarchy-handle/g) || [])).toHaveLength(1);
    expect(one.text).not.toContain('data-book-content-reorder-handle');
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
    expectBookDetailIconControl(response.text, {
      label: 'Change order',
      href: `/notes/books/${book.id}/order`,
      dialogTarget: 'book-order-dialog',
    });
    expect(locals.chapters).toEqual([chapter]);
    expect(locals.pages.map(({ id }) => id)).toEqual([page.id]);
  });

  it('enables Change order when one Chapter contains a Page', async () => {
    const book = app.locals.bookService.createBook({ title: 'Nested Page Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter' });
    const chapterPage = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Chapter Page',
      content: 'Nested content',
    });

    const renderCapture = captureBookDetailLocals(app);
    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    expect(response.text).toMatch(new RegExp(
      `<a\\b(?=[^>]*href="/notes/books/${book.id}/order")(?=[^>]*data-dialog-open="book-order-dialog")(?=[^>]*aria-label="Change order")[^>]*>`,
    ));
    const locals = renderCapture.get();
    renderCapture.restore();

    expect(locals.contents.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: 'chapter', id: chapter.id },
    ]);
    expect(locals.pages).toEqual([]);
    expect(locals.canChangeOrder).toBe(true);
    const navigator = response.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${chapterPage.id}">Chapter Page</a>`);
    expect(response.text).toContain(`<a class="notes-page-preview-title" href="/notes/${chapterPage.id}">Chapter Page</a>`);
    expect(response.text).not.toContain('class="book-outline"');
    expectBookDetailIconControl(response.text, {
      label: 'Change order',
      href: `/notes/books/${book.id}/order`,
      dialogTarget: 'book-order-dialog',
    });
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

  it.each([false, true])('hosts Edit Book with cover=%s and preserves the update redirect', async (hasCover) => {
    const book = app.locals.bookService.createBook({ title: 'Before' });
    if (hasCover) {
      const assetId = insertPreviewAsset(db, insertProject(db, 'Edit Cover'));
      app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    }

    const detail = await agent.get(`/notes/books/${book.id}`).expect(200);
    expectEditBookDialog(detail.text, book.id, false, hasCover);
    const form = await agent.get(`/notes/books/${book.id}/edit`).expect(200);
    expectEditBookDialog(form.text, book.id, true, hasCover);
    const pageHeading = form.text.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0];
    expect((form.text.match(/<h1\b/g) || [])).toHaveLength(1);
    expect(pageHeading).toBeDefined();
    expectBookDetailIconControl(detail.text, {
      label: 'Edit book',
      href: `/notes/books/${book.id}/edit`,
      dialogTarget: 'book-edit-dialog',
    });
    expect(pageHeading).not.toContain('>Edit<');
    expect(pageHeading).not.toContain('Manage');
    expect(pageHeading).not.toContain('Delete');
    expect(form.text).toContain(`<form id="book-form" method="post" action="/notes/books/${book.id}"`);
    expect(form.text).not.toContain('data-dialog-return-location');
    expect(form.text).toContain('value="Before"');
    expect(form.text).toContain('<h1 class="app-section-title">Notes — Before</h1>');
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

  it('threads an exact Books-list invocation through the Edit Book host, validation retry, and successful save', async () => {
    const book = app.locals.bookService.createBook({ title: 'Before list edit' });
    const returnTo = '/notes?sort=title&page=3&filter=active#book-17';

    const hosted = await agent
      .get(`/notes/books/${book.id}/edit`)
      .query({ returnTo })
      .expect(200);
    const hostedDialog = hosted.text.match(/<dialog\b[^>]*id="book-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(hostedDialog).toContain('name="returnTo" value="/notes?sort=title&amp;page=3&amp;filter=active#book-17" data-dialog-return-location');

    const invalid = await agent
      .post(`/notes/books/${book.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: '', returnTo })
      .expect(422);
    const invalidDialog = invalid.text.match(/<dialog\b[^>]*id="book-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(invalidDialog).toMatch(/<dialog\b[^>]*\bopen/);
    expect(invalidDialog).toContain('Title is required.');
    expect(invalidDialog).toContain('name="returnTo" value="/notes?sort=title&amp;page=3&amp;filter=active#book-17" data-dialog-return-location');

    const saved = await agent
      .post(`/notes/books/${book.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: 'After list edit', returnTo })
      .expect(302);
    expect(saved.headers.location).toBe(returnTo);
    expect(app.locals.bookService.getBook(book.id).title).toBe('After list edit');
  });

  it.each([
    ['external', 'https://example.com/notes?page=3'],
    ['protocol-relative', '//example.com/notes?page=3'],
    ['malformed', '/notes?filter=%'],
    ['unrelated local path', '/calendar?month=2026-07'],
    ['Book detail path', '/notes/books/1?page=3'],
  ])('rejects an %s Edit Book return destination', async (_label, returnTo) => {
    const book = app.locals.bookService.createBook({ title: 'Safe Book edit' });

    const hosted = await agent
      .get(`/notes/books/${book.id}/edit`)
      .query({ returnTo })
      .expect(200);
    expect(hosted.text).not.toContain('data-dialog-return-location');

    const saved = await agent
      .post(`/notes/books/${book.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: 'Safely updated', returnTo })
      .expect(302);
    expect(saved.headers.location).toBe(`/notes/books/${book.id}`);
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
    expectEditBookDialog(invalid.text, book.id, true);
    expect(invalid.text).toContain('<h1 class="app-section-title">Notes — Stored title</h1>');
    expect(invalid.text).not.toContain('notes-hierarchy');
    expect(invalid.text).toContain(`<form id="book-delete-form" method="post" action="/notes/books/${book.id}/delete">`);
    expect(invalid.text).not.toContain('form="book-form">Edit</button>');
    expect(app.locals.bookService.getBook(book.id).title).toBe('Stored title');
    for (const id of ['999999', '01', 'invalid', '0']) {
      await agent.get('/notes/books/' + id + '/edit').expect(404);
      await agent.post('/notes/books/' + id).type('form').send({ _csrf: csrfToken, title: '' }).expect(404);
    }
    await agent.post('/notes/books/999999').type('form').send({ _csrf: csrfToken, title: 'Missing' }).expect(404);
  });

  it('preserves submitted invalid titles and persisted Book context in the edit host', async () => {
    const book = app.locals.bookService.createBook({ title: 'Persisted context' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Existing Chapter' });
    const page = app.locals.noteService.createNote({ bookId: book.id, title: 'Existing Page', content: 'Content' });
    const title = '<script>' + 'x'.repeat(201);
    const response = await agent.post('/notes/books/' + book.id).type('form')
      .send({ _csrf: csrfToken, title }).expect(422);
    expectEditBookDialog(response.text, book.id, true);
    expect(response.text).toContain('value="&lt;script&gt;' + 'x'.repeat(201) + '"');
    expect(response.text).toContain('aria-describedby="title-error" aria-invalid="true"');
    expect(response.text).toContain('Notes — Persisted context</h1>');
    const bookOrderDialog = response.text.match(/<dialog\b[^>]*id="book-order-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(bookOrderDialog).toContain('<h3 class="notes-book-content-title">' + chapter.title + '</h3>');
    expect(bookOrderDialog).toContain('<h3 class="notes-book-content-title">' + page.title + '</h3>');
    expect(response.text).toContain('Change order');
    expect(app.locals.bookService.getBook(book.id).title).toBe('Persisted context');
    await agent.post('/notes/books/' + book.id).type('form').send({ title: 'No CSRF' }).expect(403);
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
