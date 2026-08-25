import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function insertProject(db, title) {
  return Number(db
    .prepare(
      `INSERT INTO projects (title, slug, description, notes, status, planned_date, published_date, patreon_url)
       VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)`
    )
    .run(title, title.toLowerCase().replace(/\s+/g, '-')).lastInsertRowid);
}

function insertAsset(db, projectId, filename = 'note-asset.png', {
  relativePath = filename,
  extension = 'png',
  mimeType = 'image/png',
} = {}) {
  return db.prepare(`
    INSERT INTO assets (
      project_id, relative_path, filename, extension, mime_type, size_bytes,
      is_present, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, 1, 1, datetime('now'))
      RETURNING id
  `).get(projectId, relativePath, filename, extension, mimeType).id;
}

function markAssetMissing(db, assetId) {
  db.prepare(`
    UPDATE assets
    SET is_present = 0, missing_since = datetime('now')
    WHERE id = ?
  `).run(assetId);
}

function archiveProject(db, projectId) {
  db.prepare(`
    UPDATE projects
    SET status = 'archived', archived_at = datetime('now')
    WHERE id = ?
  `).run(projectId);
}

function createChapterContext(app) {
  const book = app.locals.bookService.createBook({ title: 'Page Book' });
  const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Page Chapter' });
  return { book, chapter };
}

function createPage(app, input = {}) {
  const { book, chapter } = createChapterContext(app);
  const note = app.locals.noteService.createNote({ chapterId: chapter.id, ...input });
  return { book, chapter, note };
}

function extractNoteProjectsField(html) {
  return html.match(/<fieldset class="field asset-filter-multiselect-field[^\"]*">\s*<legend>Projects<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

describe('top-level Notes HTTP slice', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let appDataRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-notes-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    appDataRoot = path.join(tmpDir, 'app');
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

  it('GET /notes renders the page shell and active navigation', async () => {
    const response = await agent.get('/notes').expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Notes</h1>');
    expect(response.text).toContain('<header class="page-heading">');
    expect(response.text).toContain(
      '<a href="/notes" class="app-nav-link" data-nav-key="notes" aria-current="page">',
    );
  });

  it('GET /notes/new renders the Chapter-scoped form contract and one CSRF field', async () => {
    const { book, chapter } = createChapterContext(app);
    const response = await agent.get('/notes/new').query({ chapterId: chapter.id }).expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes — Create Note</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Notes — Create Note</h1>');
    expect(response.text).toContain('<header class="page-heading">');
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="note-form">Create</button>');
    expect(response.text).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}">Cancel</a>`);
    expect(response.text).toContain('<form id="note-form" method="post" action="/notes"');
    expect(response.text).toContain(`<input type="hidden" name="chapterId" value="${chapter.id}">`);
    expect(response.text).toContain('<aside class="notes-workspace-context" aria-label="Book contents">');
    expect(response.text).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(response.text).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}" aria-current="page">Page Chapter</a>`);
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('Book workspace');
    expect(response.text).not.toContain('>Hierarchy</h2>');
    expect(response.text).not.toContain('Back to Chapter');
    expect(response.text).not.toContain('Back to Book');
    expect(response.text).not.toContain('This Page will belong');
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('data-notes-editor-host');
    expect(response.text).toContain('<textarea id="content" name="content" data-notes-editor-source');
    expect(response.text).not.toContain('/vendor/toast-ui/editor/');
    expect(response.text).toMatch(/<input[^>]+type="hidden"[^>]+name="_csrf"[^>]+value="[^"]+"/);
    expect(response.text).toContain('<label for="title">Page title');
    expect(response.text).toContain('<input type="text" id="title" name="title"');
    expect(response.text).toContain('<label id="content-label" for="content">Content</label>');
    expect(response.text).toContain('<textarea id="content" name="content"');
    expect(response.text).toContain('<legend>Projects</legend>');
    const projectsField = extractNoteProjectsField(response.text);
    expect(projectsField).not.toBe('');
    expect(projectsField).toContain('asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown');
    expect(projectsField).toContain('data-cc-dropdown data-cc-dropdown-mode="multiple"');
    expect(projectsField).toContain('id="note-projects-form-trigger" aria-controls="note-projects-form-options"');
    expect(projectsField).toContain('aria-label="Projects: No projects selected"');
    expect(projectsField).toContain('<p class="asset-filter-multiselect-empty">No projects available. <a href="/projects/new">Create a project</a>.</p>');
    expect(projectsField).not.toContain('aria-invalid');
    expect(projectsField).not.toContain('projectIds-error');
    expect(response.text).toContain('<legend>Assets</legend>');
    expect(response.text).toContain('name="assetIds[]"');
    expect(response.text).toMatch(/<ul class="notes-selected-assets" aria-label="Selected assets">\s*<\/ul>/);
    expect(response.text).toContain('No assets selected.');
    expect(response.text).toContain('<details class="notes-asset-picker-disclosure">');
    expect(response.text).toContain('<summary>Add assets</summary>');
    expect(response.text).toContain('<div id="note-asset-picker" class="notes-asset-picker" data-notes-asset-picker');
    expect(response.text).toContain('data-projects-url="/notes/asset-picker/projects"');
    expect(response.text).toContain('data-assets-url="/notes/asset-picker/assets"');
    expect(response.text).toContain('data-note-form-id="note-form"');
    expect(response.text).toContain('<label for="note-asset-picker-project-search">Project search</label>');
    expect(response.text).toContain('<ul id="note-asset-picker-project-results" class="notes-asset-picker-results" aria-label="Project search results"></ul>');
    expect(response.text).toContain('<label for="note-asset-picker-asset-search">Asset search</label>');
    expect(response.text).toContain('<input type="search" id="note-asset-picker-asset-search" autocomplete="off" disabled>');
    expect(response.text).toContain('<ul id="note-asset-picker-asset-results" class="notes-asset-picker-results" aria-label="Asset search results"></ul>');
    expect(response.text).toContain('<button type="button" class="button button-secondary" disabled>Load more</button>');
    expect(response.text).toContain('role="status" aria-live="polite"');
    expect(response.text).toContain('role="alert" aria-live="assertive"');
    expect(response.text).not.toContain('No assets available.');
    expect(response.text).not.toContain('Move Page');
    expect(response.text).not.toContain('Delete Page');

    const noteForm = response.text.match(/<form id="note-form"[\s\S]*?<\/form>/)?.[0];
    expect(noteForm).toBeDefined();
    expect(noteForm).toContain('name="title"');
    expect(noteForm).toContain('name="content"');
    expect(noteForm).toContain('<input type="hidden" name="assetIds[]" value="">');
  });

  it('GET /notes/new renders the direct Book-scoped form contract', async () => {
    const book = app.locals.bookService.createBook({ title: 'Direct Book Page Book' });
    const response = await agent.get('/notes/new').query({ bookId: book.id }).expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes — Create Note</title>');
    expect(response.text).toContain(`<a class="button button-secondary" href="/notes/books/${book.id}">Cancel</a>`);
    expect(response.text).toContain(`<input type="hidden" name="bookId" value="${book.id}">`);
    expect(response.text).not.toContain('name="chapterId"');
    expect(response.text).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Direct Book Page Book</a>`);
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('Book workspace');
    expect(response.text).not.toContain('>Hierarchy</h2>');
    expect(response.text).not.toContain('Back to Book');
    expect(response.text).not.toContain('This Page will belong');
    expect(response.text).not.toContain('Back to Chapter');
    expect(response.text).not.toContain('Move Page');
    expect(response.text).not.toContain('Delete Page');
    expect(response.text).toContain('data-notes-asset-picker');
    expect(response.text).toContain('data-projects-url="/notes/asset-picker/projects"');
    expect(response.text).toContain('data-assets-url="/notes/asset-picker/assets"');
  });

  it('GET /notes/new renders accessible project options', async () => {
    const { chapter } = createChapterContext(app);
    const firstProjectId = insertProject(db, 'Alpha Project');
    const secondProjectId = insertProject(db, 'Beta Project');

    const response = await agent.get('/notes/new').query({ chapterId: chapter.id }).expect(200);

    const projectsField = extractNoteProjectsField(response.text);
    expect(projectsField).toContain(`<input id="note-projects-form-option-1" name="projectIds[]" type="checkbox" value="${firstProjectId}"`);
    expect(response.text).toContain('>Alpha Project</span>');
    expect(projectsField).toContain(`<input id="note-projects-form-option-2" name="projectIds[]" type="checkbox" value="${secondProjectId}"`);
    expect(response.text).toContain('>Beta Project</span>');
    expect(projectsField).not.toMatch(/name="projectIds\[\]"[^>]*checked/);
  });

  it('does not expose the obsolete TOAST UI vendor mount', async () => {
    await agent.get('/vendor/toast-ui/editor/toastui-editor.css').expect(404);
  });

  it('GET /notes/new renders no asset options when the library contains unrelated assets', async () => {
    const { chapter } = createChapterContext(app);
    const projectId = insertProject(db, 'Large Asset Library');
    const filenames = Array.from({ length: 40 }, (_value, index) => `unselected-${index}.png`);
    for (const filename of filenames) insertAsset(db, projectId, filename);

    const response = await agent.get('/notes/new').query({ chapterId: chapter.id }).expect(200);

    expect(response.text).toContain('<input type="hidden" name="assetIds[]" value="">');
    expect(response.text.match(/<input[^>]+name="assetIds\[\]"[^>]+type="checkbox"/g) || []).toHaveLength(0);
    expect(response.text).toMatch(/<ul class="notes-selected-assets" aria-label="Selected assets">\s*<\/ul>/);
    expect(response.text).not.toMatch(/<li class="notes-selected-asset"/);
    expect(response.text).toMatch(/<ul id="note-asset-picker-project-results"[^>]*><\/ul>/);
    expect(response.text).toMatch(/<ul id="note-asset-picker-asset-results"[^>]*><\/ul>/);
    for (const filename of filenames) expect(response.text).not.toContain(filename);
  });

  it('GET /notes/new requires an existing canonical Chapter ID', async () => {
    for (const chapterId of [undefined, '0', '01', 'not-an-id', '999999']) {
      await agent.get('/notes/new').query(chapterId === undefined ? {} : { chapterId }).expect(404);
    }
  });

  it('GET /notes/new rejects missing, malformed, nonexistent, and conflicting Book contexts', async () => {
    const { book, chapter } = createChapterContext(app);

    for (const bookId of ['0', '01', 'not-an-id', '999999']) {
      await agent.get('/notes/new').query({ bookId }).expect(404);
    }
    await agent.get('/notes/new').query({ bookId: book.id, chapterId: chapter.id }).expect(404);
  });

  it('GET /notes/new renders a Chapter-targeted create in the authoritative mixed Book navigator', async () => {
    const { book, chapter } = createChapterContext(app);
    const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First New Chapter Page' });
    const second = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Second New Chapter Page' });
    const directBookPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Book Page' });
    const unrelatedChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Unrelated Create Chapter' });
    const unrelatedPage = app.locals.noteService.createNote({ chapterId: unrelatedChapter.id, title: 'Unrelated Create Page' });
    app.locals.noteService.reorderNotes(chapter.id, [second.id, first.id]);
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: directBookPage.id },
      { type: 'chapter', id: chapter.id },
      { type: 'chapter', id: unrelatedChapter.id },
    ]);

    const authoritativeContents = app.locals.bookService.listBookContents(book.id);
    const listBookContents = vi.spyOn(app.locals.bookService, 'listBookContents')
      .mockReturnValue(authoritativeContents);
    const originalRender = app.response.render;
    let createLocals;
    app.response.render = function captureCreateRender(view, renderLocals, callback) {
      if (view === 'notes/form.njk' && renderLocals.action === 'Create') createLocals = renderLocals;
      return originalRender.call(this, view, renderLocals, callback);
    };

    let response;
    let listBookContentsCalls = [];
    try {
      response = await agent.get('/notes/new').query({ chapterId: chapter.id }).expect(200);
      listBookContentsCalls = listBookContents.mock.calls;
    } finally {
      app.response.render = originalRender;
      listBookContents.mockRestore();
    }

    const contextRail = response.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(createLocals.bookContents).toBe(authoritativeContents);
    expect(createLocals.navCurrentChapterId).toBe(chapter.id);
    expect(createLocals.navCurrentPageId).toBeNull();
    expect(listBookContentsCalls).toContainEqual([book.id]);
    expect(contextRail).toContain('<nav class="notes-book-nav"');
    expect(navigator).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">${book.title}</a>`);
    expect(navigator.indexOf('Direct Book Page')).toBeLessThan(navigator.indexOf('Page Chapter'));
    expect(navigator.indexOf('Page Chapter')).toBeLessThan(navigator.indexOf('Unrelated Create Chapter'));
    expect(navigator.indexOf('Second New Chapter Page')).toBeLessThan(navigator.indexOf('First New Chapter Page'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directBookPage.id}">Direct Book Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${unrelatedPage.id}">Unrelated Create Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}" aria-current="page">Page Chapter</a>`);
    expect(navigator).not.toMatch(/<a class="notes-book-nav-page-link"[^>]*aria-current="page"/);
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(response.text).toContain(`<input type="hidden" name="chapterId" value="${chapter.id}">`);
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="note-form">Create</button>');
    expect(response.text).toContain('>Connections</h2>');
    expect(response.text).not.toContain('Move Page');
    expect(response.text).not.toContain('Delete Page');
  });

  it('GET /notes/new renders direct Book create in mixed order with no current item', async () => {
    const book = app.locals.bookService.createBook({ title: 'Direct New Page Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Direct Create Chapter' });
    const nestedPage = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Nested Direct Create Page' });
    const first = app.locals.noteService.createNote({ bookId: book.id, title: 'First New Direct Page' });
    const second = app.locals.noteService.createNote({ bookId: book.id, title: 'Second New Direct Page' });
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: second.id },
      { type: 'chapter', id: chapter.id },
      { type: 'page', id: first.id },
    ]);

    const authoritativeContents = app.locals.bookService.listBookContents(book.id);
    const listBookContents = vi.spyOn(app.locals.bookService, 'listBookContents')
      .mockReturnValue(authoritativeContents);
    const originalRender = app.response.render;
    let createLocals;
    app.response.render = function captureCreateRender(view, renderLocals, callback) {
      if (view === 'notes/form.njk' && renderLocals.action === 'Create') createLocals = renderLocals;
      return originalRender.call(this, view, renderLocals, callback);
    };

    let response;
    let listBookContentsCalls = [];
    try {
      response = await agent.get('/notes/new').query({ bookId: book.id }).expect(200);
      listBookContentsCalls = listBookContents.mock.calls;
    } finally {
      app.response.render = originalRender;
      listBookContents.mockRestore();
    }

    const contextRail = response.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(createLocals.bookContents).toBe(authoritativeContents);
    expect(createLocals.navCurrentChapterId).toBeNull();
    expect(createLocals.navCurrentPageId).toBeNull();
    expect(listBookContentsCalls).toContainEqual([book.id]);
    expect(contextRail).toContain('<nav class="notes-book-nav"');
    expect(navigator.indexOf('Second New Direct Page')).toBeLessThan(navigator.indexOf('Direct Create Chapter'));
    expect(navigator.indexOf('Direct Create Chapter')).toBeLessThan(navigator.indexOf('First New Direct Page'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${nestedPage.id}">Nested Direct Create Page</a>`);
    expect(navigator).not.toContain('aria-current="page"');
    expect(navigator).not.toContain(' open>');
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(response.text).toContain(`<input type="hidden" name="bookId" value="${book.id}">`);
    expect(response.text).not.toContain('name="chapterId"');
  });

  it('GET /notes/new renders an empty Book navigator without the sibling Page nav', async () => {
    const { chapter } = createChapterContext(app);
    const directBook = app.locals.bookService.createBook({ title: 'Empty Direct Book' });

    const chapterResponse = await agent.get('/notes/new').query({ chapterId: chapter.id }).expect(200);
    const chapterRail = chapterResponse.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    expect(chapterRail).toContain('<nav class="notes-book-nav"');
    expect(chapterRail).not.toContain('<nav class="notes-page-nav"');

    const bookResponse = await agent.get('/notes/new').query({ bookId: directBook.id }).expect(200);
    const bookRail = bookResponse.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    expect(bookRail).toContain('<nav class="notes-book-nav"');
    expect(bookRail).toContain('No Pages or Chapters yet');
    expect(bookRail).not.toContain('<nav class="notes-page-nav"');
  });

  describe('asset picker project endpoint', () => {
    it('requires a trimmed 2–100 character query', async () => {
      for (const query of [undefined, '', ' ', 'a', 'a'.repeat(101)]) {
        const response = await agent.get('/notes/asset-picker/projects').query(
          query === undefined ? {} : { q: query },
        ).expect(400);
        expect(response.body.status).toBe('error');
      }
    });

    it('trims case-insensitive matches, includes archived projects, and returns only picker fields', async () => {
      const activeId = insertProject(db, 'Alpha Illustrations');
      const archivedId = insertProject(db, 'ALPHA Archive');
      archiveProject(db, archivedId);
      insertProject(db, 'Unrelated Project');

      const response = await agent.get('/notes/asset-picker/projects').query({ q: '  alpha  ' }).expect(200);

      expect(Object.keys(response.body)).toEqual(['items', 'nextCursor']);
      expect(response.body.items).toEqual([
        { id: archivedId, title: 'ALPHA Archive', archived: true },
        { id: activeId, title: 'Alpha Illustrations', archived: false },
      ]);
      expect(response.body.items.map((item) => Object.keys(item).sort()))
        .toEqual([['archived', 'id', 'title'], ['archived', 'id', 'title']]);
      expect(response.body.nextCursor).toBeNull();
    });

    it('enforces the default and maximum bounds and supports continuation cursors', async () => {
      for (let index = 0; index < 21; index += 1) {
        insertProject(db, `Bound Project ${String(index).padStart(2, '0')}`);
      }

      const defaultPage = await agent.get('/notes/asset-picker/projects').query({ q: 'bound' }).expect(200);
      const maximumPage = await agent.get('/notes/asset-picker/projects').query({ q: 'bound', limit: '20' }).expect(200);
      const continuation = await agent.get('/notes/asset-picker/projects').query({
        q: 'bound', limit: '20', cursor: maximumPage.body.nextCursor,
      }).expect(200);

      expect(defaultPage.body.items).toHaveLength(20);
      expect(defaultPage.body.nextCursor).toEqual(expect.any(String));
      expect(maximumPage.body.items).toHaveLength(20);
      expect(continuation.body.items).toHaveLength(1);
      expect(continuation.body.nextCursor).toBeNull();
    });

    it('rejects invalid limits and malformed or query-mismatched cursors', async () => {
      insertProject(db, 'Cursor Project One');
      insertProject(db, 'Cursor Project Two');

      for (const limit of ['0', '-1', '1.5', '21', 'not-a-number']) {
        await agent.get('/notes/asset-picker/projects').query({ q: 'cursor', limit }).expect(400);
      }
      await agent.get('/notes/asset-picker/projects').query({ q: 'cursor', cursor: 'not-a-cursor' }).expect(400);

      const first = await agent.get('/notes/asset-picker/projects').query({ q: 'cursor', limit: '1' }).expect(200);
      await agent.get('/notes/asset-picker/projects').query({
        q: 'project', limit: '1', cursor: first.body.nextCursor,
      }).expect(400);
    });
  });

  describe('asset picker asset endpoint', () => {
    it('returns project-scoped minimal picker rows, including missing assets', async () => {
      const projectId = insertProject(db, 'Picker Assets');
      const matchingId = insertAsset(db, projectId, 'alpha-file.png', { relativePath: 'source/alpha-file.png' });
      const missingId = insertAsset(db, projectId, 'alpha-missing.bin');
      insertAsset(db, insertProject(db, 'Foreign Picker Assets'), 'alpha-foreign.png');
      markAssetMissing(db, missingId);

      const response = await agent.get('/notes/asset-picker/assets').query({ projectId, q: 'ALPHA' }).expect(200);

      expect(Object.keys(response.body)).toEqual(['project', 'items', 'nextCursor']);
      expect(response.body.project).toEqual({ id: projectId, title: 'Picker Assets', archived: false });
      expect(response.body.items).toEqual([
        { id: matchingId, filename: 'alpha-file.png', relativePath: 'source/alpha-file.png', isPresent: true },
        { id: missingId, filename: 'alpha-missing.bin', relativePath: 'alpha-missing.bin', isPresent: false },
      ]);
      expect(response.body.items.map((item) => Object.keys(item).sort())).toEqual([
        ['filename', 'id', 'isPresent', 'relativePath'],
        ['filename', 'id', 'isPresent', 'relativePath'],
      ]);
    });

    it('allows archived projects and empty queries while searching filenames and relative paths', async () => {
      const projectId = insertProject(db, 'Archived Picker Assets');
      const filenameId = insertAsset(db, projectId, 'filename-needle.png', { relativePath: 'art/output.png' });
      const pathId = insertAsset(db, projectId, 'ordinary.png', { relativePath: 'nested/path-needle/ordinary.png' });
      archiveProject(db, projectId);

      const browse = await agent.get('/notes/asset-picker/assets').query({ projectId, q: '' }).expect(200);
      const filename = await agent.get('/notes/asset-picker/assets').query({ projectId, q: '  FILENAME-NEEDLE  ' }).expect(200);
      const relativePath = await agent.get('/notes/asset-picker/assets').query({ projectId, q: 'path-needle' }).expect(200);

      expect(browse.body.project.archived).toBe(true);
      expect(browse.body.items.map((item) => item.id)).toEqual([filenameId, pathId]);
      expect(filename.body.items.map((item) => item.id)).toEqual([filenameId]);
      expect(relativePath.body.items.map((item) => item.id)).toEqual([pathId]);
    });

    it('enforces asset page bounds and validates continuation cursor scope', async () => {
      const projectId = insertProject(db, 'Paged Picker Assets');
      const otherProjectId = insertProject(db, 'Other Paged Picker Assets');
      for (let index = 0; index < 26; index += 1) {
        insertAsset(db, projectId, `page-${String(index).padStart(2, '0')}.png`);
      }

      const first = await agent.get('/notes/asset-picker/assets').query({ projectId }).expect(200);
      const second = await agent.get('/notes/asset-picker/assets').query({
        projectId, cursor: first.body.nextCursor,
      }).expect(200);

      expect(first.body.items).toHaveLength(25);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      expect(second.body.items).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();
      await agent.get('/notes/asset-picker/assets').query({ projectId, limit: '26' }).expect(400);
      await agent.get('/notes/asset-picker/assets').query({ projectId, limit: 'not-an-integer' }).expect(400);
      await agent.get('/notes/asset-picker/assets').query({ projectId, cursor: 'not-a-cursor' }).expect(400);
      await agent.get('/notes/asset-picker/assets').query({
        projectId, q: 'page', cursor: first.body.nextCursor,
      }).expect(400);
      await agent.get('/notes/asset-picker/assets').query({
        projectId: otherProjectId, cursor: first.body.nextCursor,
      }).expect(400);
    });

    it('rejects malformed project IDs and unknown projects', async () => {
      for (const projectId of [undefined, '', '0', '01', '1.0', '-1', 'not-an-id']) {
        await agent.get('/notes/asset-picker/assets').query(
          projectId === undefined ? {} : { projectId },
        ).expect(400);
      }
      await agent.get('/notes/asset-picker/assets').query({ projectId: '999999' }).expect(404);
      await agent.get('/notes/asset-picker/assets').query({ projectId: '1', q: 'a'.repeat(101) }).expect(400);
    });
  });

  it('POST /notes creates a note, redirects to detail, and stores Markdown source unchanged', async () => {
    const { chapter } = createChapterContext(app);
    const content = '# Heading\n\n**bold** & <tag>\n- item';

    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, chapterId: String(chapter.id), title: 'Canonical Note', content })
      .expect(302);

    expect(response.headers.location).toMatch(/^\/notes\/\d+$/);
    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId)).toMatchObject({
      chapter_id: chapter.id,
      title: 'Canonical Note',
      content,
      projectIds: [],
      assetIds: [],
    });
  });

  it('POST /notes creates a direct Book Page with associations and redirects to shallow detail', async () => {
    const book = app.locals.bookService.createBook({ title: 'Direct Create Book' });
    const firstProjectId = insertProject(db, 'Direct Create Project');
    const secondProjectId = insertProject(db, 'Direct Create Other Project');
    const firstAssetId = insertAsset(db, firstProjectId, 'direct-first.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const secondAssetId = insertAsset(db, secondProjectId, 'direct-second.kra', {
      extension: 'kra',
      mimeType: 'application/x-krita',
    });
    const content = '# Direct Book Markdown\n\nBody';

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        bookId: String(book.id),
        title: 'Direct Book Page',
        content,
        projectIds: [String(firstProjectId), String(secondProjectId)],
        assetIds: [String(firstAssetId), String(secondAssetId)],
      })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(response.headers.location).toBe(`/notes/${noteId}`);
    expect(app.locals.noteService.getNote(noteId)).toMatchObject({
      book_id: book.id,
      chapter_id: null,
      title: 'Direct Book Page',
      content,
      projectIds: [firstProjectId, secondProjectId],
      assetIds: [firstAssetId, secondAssetId],
    });
    expect(db.prepare('SELECT book_id, chapter_id FROM notes WHERE id = ?').get(noteId)).toEqual({
      book_id: book.id,
      chapter_id: null,
    });
  });

  it('POST /notes normalizes one project checkbox scalar', async () => {
    const { chapter } = createChapterContext(app);
    const projectId = insertProject(db, 'Single Project');

    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, chapterId: String(chapter.id), title: 'Single project note', content: '', projectIds: String(projectId) })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId).projectIds).toEqual([projectId]);
  });

  it('POST /notes creates a note with multiple projects', async () => {
    const { chapter } = createChapterContext(app);
    const firstProjectId = insertProject(db, 'First Project');
    const secondProjectId = insertProject(db, 'Second Project');

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        chapterId: String(chapter.id),
        title: 'Multiple project note',
        content: '',
        projectIds: [String(firstProjectId), String(secondProjectId)],
      })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId).projectIds).toEqual([firstProjectId, secondProjectId]);
  });

  it('POST /notes normalizes one asset checkbox scalar without implicitly associating its project', async () => {
    const { chapter } = createChapterContext(app);
    const projectId = insertProject(db, 'Asset Parent');
    const assetId = insertAsset(db, projectId, 'scalar-asset.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });

    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, chapterId: String(chapter.id), title: 'Scalar asset note', content: '', assetIds: String(assetId) })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId)).toMatchObject({
      projectIds: [],
      assetIds: [assetId],
    });
  });

  it('POST /notes creates multiple assets from multiple projects independently of project selections', async () => {
    const { chapter } = createChapterContext(app);
    const firstProjectId = insertProject(db, 'First Asset Project');
    const secondProjectId = insertProject(db, 'Second Asset Project');
    const firstAssetId = insertAsset(db, firstProjectId, 'first.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const secondAssetId = insertAsset(db, secondProjectId, 'second.kra', {
      extension: 'kra',
      mimeType: 'application/x-krita',
    });

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        chapterId: String(chapter.id),
        title: 'Multiple asset note',
        content: '',
        projectIds: String(secondProjectId),
        assetIds: [String(firstAssetId), String(secondAssetId)],
      })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId)).toMatchObject({
      projectIds: [secondProjectId],
      assetIds: [firstAssetId, secondAssetId],
    });
    expect(app.locals.noteService.getNote(noteId).projectIds).not.toContain(firstProjectId);
  });

  it('POST /notes deduplicates duplicate submitted asset IDs', async () => {
    const { chapter } = createChapterContext(app);
    const projectId = insertProject(db, 'Duplicate Asset Project');
    const assetId = insertAsset(db, projectId, 'duplicate.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        chapterId: String(chapter.id),
        title: 'Duplicate asset note',
        content: '',
        assetIds: [String(assetId), String(assetId)],
      })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId).assetIds).toEqual([assetId]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM note_assets WHERE note_id = ?').get(noteId).count).toBe(1);
  });

  it('POST /notes renders a normal validation response for a nonexistent asset', async () => {
    const { chapter } = createChapterContext(app);
    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, chapterId: String(chapter.id), title: 'Missing asset note', content: 'body', assetIds: '999999' })
      .expect(422);

    expect(response.text).toContain('Asset 999999 not found.');
    expect(response.text).toContain('value="Missing asset note"');
    expect(response.text).toContain('>body</textarea>');
    expect(response.text).not.toContain('SQLITE');
    expect(response.text).not.toContain('FOREIGN KEY');
    expect(app.locals.noteService.listNotes()).toHaveLength(0);
  });

  it('POST /notes rehydrates only submitted assets after a validation failure', async () => {
    const { chapter } = createChapterContext(app);
    const firstProjectId = insertProject(db, 'Validation Asset First');
    const secondProjectId = insertProject(db, 'Validation Asset Second');
    const firstAssetId = insertAsset(db, firstProjectId, 'first-validation.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const secondAssetId = insertAsset(db, secondProjectId, 'second-validation.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const unrelatedFilenames = Array.from({ length: 30 }, (_value, index) => `unrelated-validation-${index}.txt`);
    for (const filename of unrelatedFilenames) insertAsset(db, firstProjectId, filename, {
      extension: 'txt',
      mimeType: 'text/plain',
    });

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        chapterId: String(chapter.id),
        title: '',
        content: 'Attempted asset content',
        projectIds: String(secondProjectId),
        assetIds: [String(firstAssetId), String(secondAssetId)],
      })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain(`<input type="hidden" name="chapterId" value="${chapter.id}">`);
    expect(response.text).toContain('Attempted asset content');
    expect(response.text).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${secondProjectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${firstAssetId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${secondAssetId}"[^>]*checked`));
    expect(response.text).toContain('>Validation Asset First</span>');
    expect(response.text).toContain('>Validation Asset Second</span>');
    expect(response.text).toContain('first-validation.txt');
    expect(response.text).toContain('second-validation.txt');
    expect(response.text.match(/id="note-asset-option-\d+"/g) || []).toHaveLength(2);
    for (const filename of unrelatedFilenames) expect(response.text).not.toContain(filename);
  });

  it('POST /notes keeps the Chapter-targeted Book navigator after a validation failure', async () => {
    const { book, chapter } = createChapterContext(app);
    const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Existing Chapter Page' });
    const second = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Second Existing Chapter Page' });
    const directBookPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Failed Create Page' });
    const unrelatedChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Unrelated Failed Create Chapter' });
    const unrelatedPage = app.locals.noteService.createNote({ chapterId: unrelatedChapter.id, title: 'Unrelated Failed Create Page' });
    app.locals.noteService.reorderNotes(chapter.id, [second.id, first.id]);
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: directBookPage.id },
      { type: 'chapter', id: chapter.id },
      { type: 'chapter', id: unrelatedChapter.id },
    ]);

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        chapterId: String(chapter.id),
        title: '',
        content: 'Attempted create content',
      })
      .expect(422);

    const contextRail = response.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(navigator).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directBookPage.id}">Direct Failed Create Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${unrelatedPage.id}">Unrelated Failed Create Page</a>`);
    expect(navigator.indexOf('Direct Failed Create Page')).toBeLessThan(navigator.indexOf('Page Chapter'));
    expect(navigator.indexOf('Page Chapter')).toBeLessThan(navigator.indexOf('Unrelated Failed Create Chapter'));
    expect(navigator.indexOf('Second Existing Chapter Page')).toBeLessThan(navigator.indexOf('First Existing Chapter Page'));
    expect(navigator).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}" aria-current="page">Page Chapter</a>`);
    expect(navigator).not.toMatch(/<a class="notes-book-nav-page-link"[^>]*aria-current="page"/);
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('value=""');
    expect(response.text).toContain('Attempted create content');
    expect(response.text).toContain(`<input type="hidden" name="chapterId" value="${chapter.id}">`);
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('Book workspace');
    expect(response.text).not.toContain('>Hierarchy</h2>');
    expect(response.text).not.toContain('Back to Chapter');
    expect(response.text).not.toContain('Back to Book');
    expect(response.text).not.toContain('This Page will belong');
    expect(app.locals.noteService.listNotesForChapter(chapter.id)).toHaveLength(2);
  });

  it('POST /notes deduplicates duplicate submitted project IDs', async () => {
    const { chapter } = createChapterContext(app);
    const projectId = insertProject(db, 'Duplicate Project');

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        chapterId: String(chapter.id),
        title: 'Duplicate project note',
        content: '',
        projectIds: [String(projectId), String(projectId)],
      })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId).projectIds).toEqual([projectId]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM note_projects WHERE note_id = ?').get(noteId).count).toBe(1);
  });

  it('POST /notes renders a normal validation response for a nonexistent project', async () => {
    const { chapter } = createChapterContext(app);
    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, chapterId: String(chapter.id), title: 'Missing project note', content: 'body', projectIds: '999999' })
      .expect(422);

    expect(response.text).toContain('Project 999999 not found.');
    expect(response.text).not.toContain('SQLITE');
    expect(response.text).not.toContain('FOREIGN KEY');
    expect(app.locals.noteService.listNotes()).toHaveLength(0);
  });

  it('POST /notes preserves project error ARIA on the standard dropdown and checkboxes', async () => {
    const { chapter } = createChapterContext(app);
    const availableProjectId = insertProject(db, 'Available Project');

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        chapterId: String(chapter.id),
        title: 'Project error note',
        content: 'body',
        projectIds: [String(availableProjectId), '999999'],
      })
      .expect(422);

    const projectsField = extractNoteProjectsField(response.text);
    expect(response.text).toContain('Project 999999 not found.');
    expect(projectsField).toContain('field-error');
    expect(projectsField).toMatch(/<summary[^>]*aria-describedby="projectIds-error"[^>]*aria-invalid="true"/);
    expect(projectsField).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${availableProjectId}"[^>]*checked[^>]*aria-describedby="projectIds-error"[^>]*aria-invalid="true"`));
    expect(response.text).toContain('id="projectIds-error"');
  });

  it('POST /notes preserves attempted project selections and the full option list after validation failure', async () => {
    const { chapter } = createChapterContext(app);
    const firstProjectId = insertProject(db, 'Validation First');
    const secondProjectId = insertProject(db, 'Validation Second');

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        chapterId: String(chapter.id),
        title: '',
        content: 'Attempted project content',
        projectIds: [String(firstProjectId), String(secondProjectId)],
      })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('Attempted project content');
    expect(response.text).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${firstProjectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${secondProjectId}"[^>]*checked`));
    expect(response.text).toContain('>Validation First</span>');
    expect(response.text).toContain('>Validation Second</span>');
  });

  it('POST /notes rerenders validation errors with submitted values', async () => {
    const { chapter } = createChapterContext(app);
    const attemptedContent = 'Attempted **Markdown**\nsecond line';

    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, chapterId: String(chapter.id), title: '', content: attemptedContent })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('field-error-message');
    expect(response.text).toContain('aria-describedby="title-error"');
    expect(response.text).toContain(attemptedContent);
    expect(app.locals.noteService.listNotes()).toHaveLength(0);
  });

  it('POST /notes rerenders direct Book validation with navigator and selected state intact', async () => {
    const book = app.locals.bookService.createBook({ title: 'Direct Validation Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Direct Validation Chapter' });
    const nestedPage = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Direct Validation Nested Page' });
    const directPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Validation Existing Page' });
    const firstProjectId = insertProject(db, 'Direct Validation Project');
    const secondProjectId = insertProject(db, 'Direct Validation Other Project');
    const firstAssetId = insertAsset(db, firstProjectId, 'direct-validation-first.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const secondAssetId = insertAsset(db, secondProjectId, 'direct-validation-second.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const attemptedContent = 'Direct attempted content';
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: directPage.id },
      { type: 'chapter', id: chapter.id },
    ]);

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        bookId: String(book.id),
        title: '',
        content: attemptedContent,
        projectIds: [String(firstProjectId), String(secondProjectId)],
        assetIds: [String(firstAssetId), String(secondAssetId)],
      })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain(`<input type="hidden" name="bookId" value="${book.id}">`);
    expect(response.text).not.toContain('name="chapterId"');
    expect(response.text).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Direct Validation Book</a>`);
    expect(response.text).toContain(`<a class="button button-secondary" href="/notes/books/${book.id}">Cancel</a>`);
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('Book workspace');
    expect(response.text).not.toContain('>Hierarchy</h2>');
    expect(response.text).not.toContain('Back to Book');
    expect(response.text).not.toContain('Back to Chapter');
    expect(response.text).not.toContain('This Page will belong');
    expect(response.text).toContain(attemptedContent);
    expect(response.text).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${firstProjectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${secondProjectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${firstAssetId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${secondAssetId}"[^>]*checked`));
    expect(response.text).toContain('direct-validation-first.txt');
    expect(response.text).toContain('direct-validation-second.txt');
    const contextRail = response.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(navigator).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directPage.id}">Direct Validation Existing Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">Direct Validation Chapter</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${nestedPage.id}">Direct Validation Nested Page</a>`);
    expect(navigator.indexOf('Direct Validation Existing Page')).toBeLessThan(navigator.indexOf('Direct Validation Chapter'));
    expect(navigator).not.toContain('aria-current="page"');
    expect(navigator).not.toContain(' open>');
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(app.locals.noteService.listNotes()).toHaveLength(2);
  });

  it('POST /notes rejects missing or malformed Chapter IDs and a Chapter removed after rendering', async () => {
    await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Unfiled', content: '' })
      .expect(404);
    await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, chapterId: '01', title: 'Malformed', content: '' })
      .expect(404);

    const { book, chapter } = createChapterContext(app);
    await agent.get('/notes/new').query({ chapterId: chapter.id }).expect(200);

    await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        bookId: String(book.id),
        chapterId: String(chapter.id),
        title: 'Conflicting hierarchy',
        content: '',
      })
      .expect(404);

    app.locals.chapterService.deleteChapter(chapter.id);

    await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, chapterId: String(chapter.id), title: 'Removed parent', content: '' })
      .expect(404);
  });

  it('POST /notes remains CSRF-protected with Chapter context', async () => {
    const { chapter } = createChapterContext(app);

    await agent
      .post('/notes')
      .type('form')
      .send({ chapterId: String(chapter.id), title: 'No CSRF', content: '' })
      .expect(403);
  });

  it('POST /notes remains CSRF-protected with direct Book context', async () => {
    const book = app.locals.bookService.createBook({ title: 'Protected Direct Book' });

    await agent
      .post('/notes')
      .type('form')
      .send({ bookId: String(book.id), title: 'No CSRF', content: '' })
      .expect(403);

    expect(app.locals.noteService.listNotes()).toHaveLength(0);
  });

  it('renders sanitized Markdown detail content with the persistent Book navigator', async () => {
    const content = '<script>alert("unsafe")</script>\n\n# Markdown **text**\nline two';
    const { book, chapter } = createChapterContext(app);
    const note = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Detail Note', content });

    const response = await agent.get(`/notes/${note.id}`).expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes — Page — Detail Note</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Notes — Page — Detail Note</h1>');
    expect(response.text).toContain(`<a class="button button-primary" href="/notes/${note.id}/edit">Edit Page</a>`);
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('notes-hierarchy');
    expect(response.text).toContain('<div class="notes-page-detail-layout">');
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(response.text).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">Page Chapter</a>`);
    expect(response.text).toContain(`<a class="notes-book-nav-page-link" href="/notes/${note.id}" aria-current="page">Detail Note</a>`);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(response.text).not.toContain(`/notes/${note.id}/move`);
    expect(response.text).not.toContain('Move Page');
    expect(response.text).not.toContain('Danger zone');
    expect(response.text).not.toContain(`/notes/${note.id}/delete`);
    expect(response.text).not.toContain('>Delete Note</button>');
    expect(response.text).toContain('&lt;script&gt;alert(');
    expect(response.text).not.toContain('<script>alert');
    expect(response.text).toContain('<h1>Markdown <strong>text</strong></h1>');
    expect(response.text).toContain('<p>line two</p>');
    expect(response.text).toContain('<section class="notes-detail-panel notes-detail-details" aria-labelledby="notes-detail-details-heading">');
    expect(response.text).toContain('<h2 id="notes-detail-details-heading">Details</h2>');
    expect(response.text).toContain('<dl class="detail-list">');
    expect(response.text).toContain('<dt>Created</dt>');
    expect(response.text).toContain(`<dd>${note.created_at}</dd>`);
    expect(response.text).toContain('<dt>Updated</dt>');
    expect(response.text).toContain(`<dd>${note.updated_at}</dd>`);
    const pageSidebarStart = response.text.indexOf('<div class="notes-page-sidebar">');
    const pageContentStart = response.text.indexOf('<div class="notes-page-detail-content">');
    const pageSidebar = response.text.slice(pageSidebarStart, pageContentStart);
    expect(pageSidebarStart).toBeGreaterThanOrEqual(0);
    expect(pageContentStart).toBeGreaterThan(pageSidebarStart);
    expect(pageSidebar).toContain('notes-book-nav');
    expect(pageSidebar).toContain('notes-detail-details');
    expect(response.text).toContain('<section class="notes-detail-content"');
    expect(response.text).toContain(`<p class="notes-detail-kicker" id="notes-detail-content-heading">${note.title}</p>`);
    expect(response.text).not.toContain('>Reading view<');
    expect(response.text).not.toContain('<h2 id="notes-detail-content-heading">Content</h2>');
    expect(response.text).not.toContain('class="notes-detail-layout"');
    expect(response.text).not.toContain('class="notes-detail-reading"');
    expect(response.text).not.toContain('class="notes-detail-sidebar"');
    expect(response.text).toContain('notes-detail-details');
    expect(response.text).not.toContain('<h2>Projects</h2>');
    expect(response.text).not.toContain('<h2>Assets</h2>');
    expect(response.text).not.toContain('data-notes-editor-form');
    expect(response.text).not.toContain('/vendor/toast-ui/editor/');

    const css = await agent.get('/creatorcrate.css').expect(200);
    expect(css.text).toContain('.notes-content');
    expect(css.text).toContain('.notes-content pre');
    expect(css.text).toContain('.notes-content table');
  });

  it('renders a Chapter Page in the authoritative mixed Book navigator', async () => {
    const book = app.locals.bookService.createBook({ title: 'Mixed Navigator Book' });
    const directFirst = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct First Page' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Containing Chapter' });
    const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Chapter Page' });
    const second = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Current Chapter Page' });
    const third = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Last Chapter Page' });
    const otherChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Unrelated Chapter' });
    app.locals.noteService.createNote({ chapterId: otherChapter.id, title: 'Unrelated Chapter Page' });
    const directLast = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Last Page' });
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: directFirst.id },
      { type: 'chapter', id: chapter.id },
      { type: 'page', id: directLast.id },
      { type: 'chapter', id: otherChapter.id },
    ]);
    app.locals.noteService.reorderNotes(chapter.id, [third.id, first.id, second.id]);

    const authoritativeContents = app.locals.bookService.listBookContents(book.id);
    const listBookContents = vi.spyOn(app.locals.bookService, 'listBookContents')
      .mockReturnValue(authoritativeContents);
    const originalRender = app.response.render;
    let pageLocals;
    app.response.render = function capturePageRender(view, renderLocals, callback) {
      if (view === 'notes/detail.njk') pageLocals = renderLocals;
      return originalRender.call(this, view, renderLocals, callback);
    };

    let response;
    let listBookContentsCalls = [];
    try {
      response = await agent.get(`/notes/${second.id}`).expect(200);
      listBookContentsCalls = listBookContents.mock.calls;
    } finally {
      app.response.render = originalRender;
      listBookContents.mockRestore();
    }
    const navigator = response.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(pageLocals.bookContents).toBe(authoritativeContents);
    expect(pageLocals.navCurrentPageId).toBe(second.id);
    expect(listBookContentsCalls).toContainEqual([book.id]);
    expect(navigator).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">${book.title}</a>`);
    expect(navigator.indexOf('Direct First Page')).toBeLessThan(navigator.indexOf('Containing Chapter'));
    expect(navigator.indexOf('Containing Chapter')).toBeLessThan(navigator.indexOf('Direct Last Page'));
    expect(navigator.indexOf('Direct Last Page')).toBeLessThan(navigator.indexOf('Unrelated Chapter'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directFirst.id}">Direct First Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directLast.id}">Direct Last Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">Containing Chapter</a>`);
    expect(navigator.indexOf('Last Chapter Page')).toBeLessThan(navigator.indexOf('First Chapter Page'));
    expect(navigator.indexOf('First Chapter Page')).toBeLessThan(navigator.indexOf('Current Chapter Page'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${second.id}" aria-current="page">Current Chapter Page</a>`);
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
    expect((navigator.match(/aria-current="page"/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
  });

  it('renders stored TOAST UI br syntax without changing the canonical Note source', async () => {
    const source = 'before<br>after';
    const { note } = createPage(app, { title: 'Stored Break Note', content: source });

    const response = await agent.get(`/notes/${note.id}`).expect(200);

    expect(response.text).toContain('<p>before<br />\nafter</p>');
    expect(response.text).not.toContain('&lt;br&gt;');
    expect(app.locals.noteService.getNote(note.id).content).toBe(source);
    expect(db.prepare('SELECT content FROM notes WHERE id = ?').get(note.id).content).toBe(source);
  });

  it('renders a direct Book Page at its mixed top-level position without opening a Chapter', async () => {
    const book = app.locals.bookService.createBook({ title: 'Direct Page Book' });
    const firstChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'First Chapter' });
    app.locals.noteService.createNote({ chapterId: firstChapter.id, title: 'First Chapter Page' });
    const current = app.locals.noteService.createNote({ bookId: book.id, title: 'Current Direct Page' });
    const secondChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Second Chapter' });
    app.locals.noteService.createNote({ chapterId: secondChapter.id, title: 'Second Chapter Page' });
    const directLast = app.locals.noteService.createNote({ bookId: book.id, title: 'Last Direct Page' });
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'chapter', id: firstChapter.id },
      { type: 'page', id: current.id },
      { type: 'chapter', id: secondChapter.id },
      { type: 'page', id: directLast.id },
    ]);

    const response = await agent.get(`/notes/${current.id}`).expect(200);
    const navigator = response.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(navigator.indexOf('First Chapter')).toBeLessThan(navigator.indexOf('Current Direct Page'));
    expect(navigator.indexOf('Current Direct Page')).toBeLessThan(navigator.indexOf('Second Chapter'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${current.id}" aria-current="page">Current Direct Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directLast.id}">Last Direct Page</a>`);
    expect((navigator.match(/aria-current="page"/g) || [])).toHaveLength(1);
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(0);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
  });

  it('round-trips a direct Book Page through detail, edit, update, and delete', async () => {
    const book = app.locals.bookService.createBook({ title: 'Direct Round-trip Book' });
    const createResponse = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        bookId: String(book.id),
        title: 'Direct Page Before',
        content: 'Direct content before',
      })
      .expect(302);
    const noteId = Number(createResponse.headers.location.replace('/notes/', ''));

    const detailResponse = await agent.get(`/notes/${noteId}`).expect(200);
    expect(detailResponse.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(detailResponse.text).not.toContain('notes-hierarchy');
    expect(detailResponse.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Direct Round-trip Book</a>`);
    expect(detailResponse.text).toContain(`<a class="notes-book-nav-page-link" href="/notes/${noteId}" aria-current="page">Direct Page Before</a>`);
    expect(detailResponse.text).not.toContain('<nav class="notes-page-nav"');
    expect(detailResponse.text).not.toContain('notes-hierarchy-kind">Chapter');
    expect(detailResponse.text).not.toContain('/notes/chapters/');
    expect(detailResponse.text).not.toContain('Back to Chapter');

    const editResponse = await agent.get(`/notes/${noteId}/edit`).expect(200);
    expect(editResponse.text).toContain('<aside class="notes-workspace-context" aria-label="Book contents">');
    expect(editResponse.text).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(editResponse.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Direct Round-trip Book</a>`);
    expect(editResponse.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(editResponse.text).not.toContain('Book workspace');
    expect(editResponse.text).not.toContain('>Hierarchy</h2>');
    expect(editResponse.text).not.toContain('Back to Book');
    expect(editResponse.text).not.toContain('Back to Chapter');
    expect(editResponse.text).not.toContain('This Page will belong');
    expect(editResponse.text).not.toContain('name="chapterId"');

    const updateResponse = await agent
      .post(`/notes/${noteId}`)
      .type('form')
      .send({
        _csrf: csrfToken,
        title: 'Direct Page After',
        content: 'Direct content after',
      })
      .expect(302);
    expect(updateResponse.headers.location).toBe(`/notes/${noteId}`);
    expect(app.locals.noteService.getNote(noteId)).toMatchObject({
      book_id: book.id,
      chapter_id: null,
      title: 'Direct Page After',
      content: 'Direct content after',
    });

    const deleteResponse = await agent
      .post(`/notes/${noteId}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);
    expect(deleteResponse.headers.location).toBe(`/notes/books/${book.id}`);
    expect(app.locals.noteRepository.findById(noteId)).toBeUndefined();
  });

  it('GET /notes/:id returns 404 for a nonexistent note', async () => {
    await agent.get('/notes/9999').expect(404);
  });

  it('GET /notes/:id/edit populates the shared form with existing values', async () => {
    const content = '# Existing\n**bold** & <script>alert("unsafe")</script>';
    const { book, chapter, note } = createPage(app, {
      title: 'Existing Note',
      content,
    });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);

    expect(response.text).toContain(`<title>CreatorCrate — Notes — Edit Existing Note</title>`);
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="note-form">Save</button>');
    expect(response.text).not.toContain('<button class="button button-primary" type="submit" form="note-form">Edit</button>');
    expect(response.text).toContain(`<a class="button button-secondary" href="/notes/${note.id}">Cancel</a>`);
    expect(response.text).toContain(`<form id="note-form" method="post" action="/notes/${note.id}"`);
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('data-notes-editor-host');
    expect(response.text).toContain('<textarea id="content" name="content" data-notes-editor-source');
    expect(response.text).toContain('value="Existing Note"');
    expect(response.text).toContain('# Existing\n**bold** &amp; &lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;');
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(response.text).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">Page Chapter</a>`);
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('Book workspace');
    expect(response.text).not.toContain('>Hierarchy</h2>');
    expect(response.text).not.toContain('Back to Chapter');
    expect(response.text).not.toContain('Back to Book');
    expect(response.text).not.toContain('This Page will belong');
    expect(response.text).toContain(`/notes/chapters/${chapter.id}`);
    expect(response.text).not.toContain('name="chapterId"');
    expect(response.text).not.toContain('<strong>bold</strong>');
    expect(app.locals.noteService.getNote(note.id).content).toBe(content);
    expect(response.text).toContain('<legend>Projects</legend>');
    expect(extractNoteProjectsField(response.text)).toContain('data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">No projects selected</span>');
    expect(response.text).toContain('<legend>Assets</legend>');
    expect(response.text).toContain('<details class="notes-workspace-disclosure notes-workspace-disclosure--move">');
    expect(response.text).toContain('<details class="notes-workspace-disclosure notes-workspace-disclosure--delete">');
    expect(response.text).toContain(`<form id="note-move-form" method="post" action="/notes/${note.id}/move" hidden>`);
    expect(response.text).toContain(`<form id="note-delete-form" method="post" action="/notes/${note.id}/delete" hidden>`);
    expect(response.text).toMatch(/<form id="note-move-form"[\s\S]*?name="_csrf"[^>]+value="[^"]+"/);
    expect(response.text).toMatch(/<form id="note-delete-form"[\s\S]*?name="_csrf"[^>]+value="[^"]+"/);
    expect(response.text).toContain('name="targetContainer" required form="note-move-form"');
    expect(response.text).toContain('type="submit" form="note-move-form">Move Page</button>');
    expect(response.text).toContain('type="submit" form="note-delete-form" data-confirm="Delete this Page permanently? This cannot be undone.">Delete Page</button>');
    expect(response.text).toContain(`value="book:${book.id}"`);
    expect(response.text).toContain(`value="chapter:${chapter.id}"`);
    const noteFormStart = response.text.indexOf('<form id="note-form"');
    const noteFormEnd = response.text.indexOf('</form>', noteFormStart);
    const noteForm = response.text.slice(response.text.indexOf('>', noteFormStart) + 1, noteFormEnd);
    expect(noteFormStart).toBeGreaterThanOrEqual(0);
    expect(noteForm).not.toContain('<form');
  });

  it('GET /notes/:id/edit renders the authoritative Book navigator inside the workspace context rail', async () => {
    const { book, chapter } = createChapterContext(app);
    const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Edit Page' });
    const current = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Current Edit Page' });
    const last = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Last Edit Page' });
    const directBookPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Edit Page' });
    const unrelatedChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Unrelated Edit Chapter' });
    app.locals.noteService.createNote({ chapterId: unrelatedChapter.id, title: 'Unrelated Edit Page' });
    app.locals.noteService.reorderNotes(chapter.id, [last.id, first.id, current.id]);
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: directBookPage.id },
      { type: 'chapter', id: chapter.id },
      { type: 'chapter', id: unrelatedChapter.id },
    ]);

    const authoritativeContents = app.locals.bookService.listBookContents(book.id);
    const listBookContents = vi.spyOn(app.locals.bookService, 'listBookContents')
      .mockReturnValue(authoritativeContents);
    const originalRender = app.response.render;
    let editLocals;
    app.response.render = function captureEditRender(view, renderLocals, callback) {
      if (view === 'notes/form.njk' && renderLocals.action === 'Edit') editLocals = renderLocals;
      return originalRender.call(this, view, renderLocals, callback);
    };

    let response;
    let listBookContentsCalls = [];
    try {
      response = await agent.get(`/notes/${current.id}/edit`).expect(200);
      listBookContentsCalls = listBookContents.mock.calls;
    } finally {
      app.response.render = originalRender;
      listBookContents.mockRestore();
    }

    const contextRail = response.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(editLocals.bookContents).toBe(authoritativeContents);
    expect(editLocals.navCurrentPageId).toBe(current.id);
    expect(listBookContentsCalls).toContainEqual([book.id]);
    expect(contextRail).toContain('<nav class="notes-book-nav"');
    expect(navigator).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">${book.title}</a>`);
    expect(navigator.indexOf('Direct Edit Page')).toBeLessThan(navigator.indexOf('Page Chapter'));
    expect(navigator.indexOf('Page Chapter')).toBeLessThan(navigator.indexOf('Unrelated Edit Chapter'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directBookPage.id}">Direct Edit Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">Page Chapter</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${current.id}" aria-current="page">Current Edit Page</a>`);
    expect(navigator.indexOf('Last Edit Page')).toBeLessThan(navigator.indexOf('First Edit Page'));
    expect(navigator.indexOf('First Edit Page')).toBeLessThan(navigator.indexOf('Current Edit Page'));
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(contextRail).toContain('<aside class="notes-workspace-context" aria-label="Book contents">');
    expect(contextRail).not.toContain('notes-hierarchy');
    expect(contextRail).not.toContain('Book workspace');
    expect(contextRail).not.toContain('Hierarchy');
    expect(contextRail).not.toContain('notes-workspace-back');
    expect(contextRail).not.toContain('notes-workspace-context-note');
    expect(contextRail).not.toContain('Back to Chapter');
    expect(contextRail).not.toContain('Back to Book');
    expect(contextRail).not.toContain('This Page will belong');
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="note-form">Save</button>');
    expect(response.text).toContain(`<a class="button button-secondary" href="/notes/${current.id}">Cancel</a>`);
    expect(response.text).toContain('>Connections</h2>');
    expect(response.text).toContain('>Move Page</summary>');
    expect(response.text).toContain('>Delete Page</summary>');
  });

  it('GET /notes/:id/edit renders a direct Book Page at its mixed top-level position', async () => {
    const book = app.locals.bookService.createBook({ title: 'Direct Edit Book' });
    const firstChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'First Direct Edit Chapter' });
    app.locals.noteService.createNote({ chapterId: firstChapter.id, title: 'First Chapter Edit Page' });
    const current = app.locals.noteService.createNote({ bookId: book.id, title: 'Current Direct Edit Page' });
    const secondChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Second Direct Edit Chapter' });
    app.locals.noteService.createNote({ chapterId: secondChapter.id, title: 'Second Chapter Edit Page' });
    const last = app.locals.noteService.createNote({ bookId: book.id, title: 'Last Direct Edit Page' });
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'chapter', id: firstChapter.id },
      { type: 'page', id: current.id },
      { type: 'chapter', id: secondChapter.id },
      { type: 'page', id: last.id },
    ]);

    const response = await agent.get(`/notes/${current.id}/edit`).expect(200);
    const contextRail = response.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(navigator.indexOf('First Direct Edit Chapter')).toBeLessThan(navigator.indexOf('Current Direct Edit Page'));
    expect(navigator.indexOf('Current Direct Edit Page')).toBeLessThan(navigator.indexOf('Second Direct Edit Chapter'));
    expect(navigator.indexOf('Second Direct Edit Chapter')).toBeLessThan(navigator.indexOf('Last Direct Edit Page'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${current.id}" aria-current="page">Current Direct Edit Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${last.id}">Last Direct Edit Page</a>`);
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(0);
    expect((navigator.match(/aria-current="page"/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(contextRail).toContain('<aside class="notes-workspace-context" aria-label="Book contents">');
    expect(contextRail).not.toContain('notes-hierarchy');
    expect(contextRail).not.toContain('Book workspace');
    expect(contextRail).not.toContain('Hierarchy');
    expect(contextRail).not.toContain('notes-workspace-back');
    expect(contextRail).not.toContain('notes-workspace-context-note');
    expect(contextRail).not.toContain('Back to Book');
    expect(contextRail).not.toContain('Back to Chapter');
    expect(contextRail).not.toContain('This Page will belong');
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('>Connections</h2>');
    expect(response.text).toContain('>Move Page</summary>');
    expect(response.text).toContain('>Delete Page</summary>');
  });

  it('GET /notes/:id/edit keeps the Book navigator for a sole Page', async () => {
    const { book, chapter, note } = createPage(app, { title: 'Sole Edit Page' });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);
    const contextRail = response.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(navigator).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">Page Chapter</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${note.id}" aria-current="page">Sole Edit Page</a>`);
    expect(navigator).toContain('<details class="notes-book-nav-disclosure" open>');
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(contextRail).toContain('<aside class="notes-workspace-context" aria-label="Book contents">');
    expect(contextRail).not.toContain('notes-hierarchy');
    expect(contextRail).not.toContain('Book workspace');
    expect(contextRail).not.toContain('Hierarchy');
    expect(contextRail).not.toContain('notes-workspace-back');
    expect(contextRail).not.toContain('notes-workspace-context-note');
    expect(contextRail).not.toContain('Back to Chapter');
    expect(contextRail).not.toContain('Back to Book');
    expect(contextRail).not.toContain('This Page will belong');
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('>Connections</h2>');
    expect(response.text).toContain('>Move Page</summary>');
    expect(response.text).toContain('>Delete Page</summary>');
  });

  it('GET /notes/:id/edit preselects existing project associations', async () => {
    const firstProjectId = insertProject(db, 'Existing First');
    const secondProjectId = insertProject(db, 'Existing Second');
    const { note } = createPage(app, {
      title: 'Associated Note',
      content: 'content',
      projectIds: [firstProjectId, secondProjectId],
    });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);

    const projectsField = extractNoteProjectsField(response.text);
    expect(projectsField).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${firstProjectId}"[^>]*checked`));
    expect(projectsField).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${secondProjectId}"[^>]*checked`));
    expect(projectsField).toContain('data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">2 projects selected</span>');
  });

  it('GET /notes/:id/edit renders the selected project title in the summary', async () => {
    const projectId = insertProject(db, 'Single Summary Project');
    const { note } = createPage(app, {
      title: 'Single Association Note',
      projectIds: [projectId],
    });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);
    const projectsField = extractNoteProjectsField(response.text);

    expect(projectsField).toContain('data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">Single Summary Project</span>');
    expect(projectsField).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${projectId}"[^>]*checked`));
  });

  it('GET /notes/:id/edit preselects existing asset associations', async () => {
    const firstProjectId = insertProject(db, 'Edit Asset First Project');
    const secondProjectId = insertProject(db, 'Edit Asset Second Project');
    const firstAssetId = insertAsset(db, firstProjectId, 'edit-first.txt', {
      relativePath: 'source/edit-first.txt',
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const secondAssetId = insertAsset(db, secondProjectId, 'edit-second.bin', {
      extension: 'bin',
      mimeType: 'application/octet-stream',
    });
    const unrelatedFilenames = Array.from({ length: 30 }, (_value, index) => `unrelated-edit-${index}.txt`);
    for (const filename of unrelatedFilenames) insertAsset(db, firstProjectId, filename, {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const { note } = createPage(app, {
      title: 'Asset Edit Note',
      assetIds: [firstAssetId, secondAssetId],
    });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);

    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${firstAssetId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${secondAssetId}"[^>]*checked`));
    expect(response.text).toContain('edit-first.txt');
    expect(response.text).toContain('Edit Asset First Project');
    expect(response.text).toContain('source/edit-first.txt');
    expect(response.text).toContain('aria-label="Deselect edit-first.txt"');
    expect(response.text).toContain('aria-label="Deselect edit-second.bin"');
    expect(response.text).not.toMatch(/name="projectIds\[\]"[^>]*checked/);
    expect(response.text.match(/id="note-asset-option-\d+"/g) || []).toHaveLength(2);
    expect(response.text.match(/name="assetIds\[\]"[^>]*type="checkbox"/g) || []).toHaveLength(2);
    for (const filename of unrelatedFilenames) expect(response.text).not.toContain(filename);
  });

  it('POST /notes/:id updates title/content and project associations without clearing assets', async () => {
    const projectId = insertProject(db, 'Associated Project');
    const assetId = insertAsset(db, projectId);
    const { chapter, note } = createPage(app, { title: 'Before', content: 'Before content' });
    const { chapter: otherChapter } = createChapterContext(app);
    app.locals.noteRepository.replaceProjects(note.id, [projectId]);
    app.locals.noteRepository.replaceAssets(note.id, [assetId]);

    const response = await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({
        _csrf: csrfToken,
        title: 'After',
        content: 'After content\nline two',
        projectIds: String(projectId),
        assetIds: String(assetId),
        chapterId: String(otherChapter.id),
      })
      .expect(302);

    expect(response.headers.location).toBe(`/notes/${note.id}`);
    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      title: 'After',
      content: 'After content\nline two',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    expect(app.locals.noteService.getNote(note.id).chapter_id).toBe(chapter.id);
  });

  it('POST /notes/:id adds and removes project associations', async () => {
    const firstProjectId = insertProject(db, 'Removed Project');
    const secondProjectId = insertProject(db, 'Added Project');
    const { note } = createPage(app, { title: 'Before', projectIds: [firstProjectId] });

    const response = await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: 'After', content: '', projectIds: String(secondProjectId) })
      .expect(302);

    expect(response.headers.location).toBe(`/notes/${note.id}`);
    expect(app.locals.noteService.getNote(note.id).projectIds).toEqual([secondProjectId]);
  });

  it('POST /notes/:id adds and removes asset associations without changing projects', async () => {
    const firstProjectId = insertProject(db, 'Asset Removed Project');
    const secondProjectId = insertProject(db, 'Asset Added Project');
    const firstAssetId = insertAsset(db, firstProjectId, 'removed.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const secondAssetId = insertAsset(db, secondProjectId, 'added.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const { note } = createPage(app, {
      title: 'Before',
      projectIds: [firstProjectId],
      assetIds: [firstAssetId],
    });

    await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({
        _csrf: csrfToken,
        title: 'After',
        content: '',
        projectIds: String(firstProjectId),
        assetIds: String(secondAssetId),
      })
      .expect(302);

    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      projectIds: [firstProjectId],
      assetIds: [secondAssetId],
    });
  });

  it('POST /notes/:id keeps asset associations when their parent project is not associated', async () => {
    const projectId = insertProject(db, 'Unassociated Asset Parent');
    const assetId = insertAsset(db, projectId, 'independent.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const { note } = createPage(app, { title: 'Independent asset', assetIds: [assetId] });

    await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({
        _csrf: csrfToken,
        title: 'Independent asset updated',
        content: '',
        projectIds: [],
        assetIds: String(assetId),
      })
      .expect(302);

    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      projectIds: [],
      assetIds: [assetId],
    });
  });

  it('POST /notes/:id clears assets without changing project associations', async () => {
    const projectId = insertProject(db, 'Clear Assets Project');
    const assetId = insertAsset(db, projectId, 'clear-me.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const { note } = createPage(app, {
      title: 'Clear assets',
      projectIds: [projectId],
      assetIds: [assetId],
    });

    await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({
        _csrf: csrfToken,
        title: 'Clear assets',
        content: '',
        projectIds: String(projectId),
        assetIds: '',
      })
      .expect(302);

    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      projectIds: [projectId],
      assetIds: [],
    });
  });

  it('POST /notes/:id with no project values clears all project associations', async () => {
    const projectId = insertProject(db, 'Cleared Project');
    const { note } = createPage(app, { title: 'Clear projects', projectIds: [projectId] });

    await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: 'Clear projects', content: '' })
      .expect(302);

    expect(app.locals.noteService.getNote(note.id).projectIds).toEqual([]);
  });

  it('POST /notes/:id rerenders validation errors with attempted edit values', async () => {
    const { book, chapter, note } = createPage(app, { title: 'Existing', content: 'Stored content' });
    const attemptedContent = 'Attempted edit\nsecond line';

    const response = await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: '', content: attemptedContent })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain(`<form id="note-form" method="post" action="/notes/${note.id}"`);
    expect(response.text).toContain(attemptedContent);
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(response.text).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">Page Chapter</a>`);
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('Book workspace');
    expect(response.text).not.toContain('>Hierarchy</h2>');
    expect(response.text).not.toContain('Back to Chapter');
    expect(response.text).not.toContain('Back to Book');
    expect(response.text).not.toContain('This Page will belong');
    expect(response.text).toContain(`/notes/chapters/${chapter.id}`);
    expect(response.text).not.toContain('name="chapterId"');
    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      title: 'Existing',
      content: 'Stored content',
    });
    expect(app.locals.noteService.getNote(note.id).chapter_id).toBe(chapter.id);
  });

  it('POST /notes/:id validation failure preserves attempted project selections', async () => {
    const firstProjectId = insertProject(db, 'Stored Project');
    const secondProjectId = insertProject(db, 'Attempted Project');
    const { note } = createPage(app, { title: 'Existing', projectIds: [firstProjectId] });

    const response = await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({
        _csrf: csrfToken,
        title: '',
        content: 'Attempted edit content',
        projectIds: String(secondProjectId),
      })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('Attempted edit content');
    expect(response.text).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${secondProjectId}"[^>]*checked`));
    expect(response.text).not.toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${firstProjectId}"[^>]*checked`));
    expect(response.text).toContain('>Stored Project</span>');
    expect(response.text).toContain('>Attempted Project</span>');
  });

  it('POST /notes/:id validation failure preserves attempted project and asset selections', async () => {
    const storedProjectId = insertProject(db, 'Stored Both Project');
    const attemptedProjectId = insertProject(db, 'Attempted Both Project');
    const storedAssetId = insertAsset(db, storedProjectId, 'stored-both.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const attemptedAssetId = insertAsset(db, attemptedProjectId, 'attempted-both.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const { note } = createPage(app, {
      title: 'Existing both',
      projectIds: [storedProjectId],
      assetIds: [storedAssetId],
    });

    const response = await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({
        _csrf: csrfToken,
        title: '',
        content: 'Attempted both content',
        projectIds: String(attemptedProjectId),
        assetIds: String(attemptedAssetId),
      })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('Attempted both content');
    expect(response.text).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${attemptedProjectId}"[^>]*checked`));
    expect(response.text).not.toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${storedProjectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${attemptedAssetId}"[^>]*checked`));
    expect(response.text).not.toMatch(new RegExp(`id="note-asset-option-${storedAssetId}"[^>]*checked`));
  });

  it('POST /notes/:id keeps the Book navigator and edit state after a validation failure', async () => {
    const { book, chapter } = createChapterContext(app);
    const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Edit Sibling' });
    const current = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Current Edit Sibling' });
    const last = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Last Edit Sibling' });
    const directPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Edit Peer' });
    app.locals.noteService.reorderNotes(chapter.id, [last.id, first.id, current.id]);
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: directPage.id },
      { type: 'chapter', id: chapter.id },
    ]);
    const projectId = insertProject(db, 'Failed Edit Project');
    const assetId = insertAsset(db, projectId, 'failed-edit.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });

    const response = await agent
      .post(`/notes/${current.id}`)
      .type('form')
      .send({
        _csrf: csrfToken,
        title: '',
        content: 'Attempted edit content',
        projectIds: String(projectId),
        assetIds: String(assetId),
      })
      .expect(422);

    const contextRail = response.text.match(/<aside class="notes-workspace-context"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(navigator).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directPage.id}">Direct Edit Peer</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">Page Chapter</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${current.id}" aria-current="page">Current Edit Sibling</a>`);
    expect(navigator.indexOf('Direct Edit Peer')).toBeLessThan(navigator.indexOf('Page Chapter'));
    expect(navigator.indexOf('Last Edit Sibling')).toBeLessThan(navigator.indexOf('First Edit Sibling'));
    expect(navigator.indexOf('First Edit Sibling')).toBeLessThan(navigator.indexOf('Current Edit Sibling'));
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('Attempted edit content');
    expect(response.text).toContain(`<form id="note-form" method="post" action="/notes/${current.id}"`);
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('Book workspace');
    expect(response.text).not.toContain('>Hierarchy</h2>');
    expect(response.text).not.toContain('Back to Chapter');
    expect(response.text).not.toContain('Back to Book');
    expect(response.text).not.toContain('This Page will belong');
    expect(response.text).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}">Page Chapter</a>`);
    expect(response.text).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${projectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${assetId}"[^>]*checked`));
    expect(response.text).toContain('failed-edit.txt');
    expect(app.locals.noteService.getNote(current.id)).toMatchObject({
      title: 'Current Edit Sibling',
      content: '',
    });
  });

  it('renders associated projects on note detail with project links', async () => {
    const firstProjectId = insertProject(db, 'Detail First');
    const secondProjectId = insertProject(db, 'Detail Second');
    const { chapter } = createChapterContext(app);
    const note = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Project Detail Note',
      projectIds: [firstProjectId, secondProjectId],
    });

    const response = await agent.get(`/notes/${note.id}`).expect(200);
    const projectsSection = response.text.match(/<section[^>]*class="[^"]*\bnotes-detail-projects\b[^"]*"[^>]*>[\s\S]*?<\/section>/)?.[0];

    expect(projectsSection).toBeDefined();
    expect(projectsSection).toContain('>Projects</h2>');
    expect(projectsSection).toContain(`<a href="/projects/${firstProjectId}">Detail First</a>`);
    expect(projectsSection).toContain(`<a href="/projects/${secondProjectId}">Detail Second</a>`);
  });

  it('renders associated assets on note detail with project context and canonical viewer links', async () => {
    const firstProjectId = insertProject(db, 'Detail Asset First');
    const secondProjectId = insertProject(db, 'Detail Asset Second');
    const { chapter } = createChapterContext(app);
    const firstAssetId = insertAsset(db, firstProjectId, 'detail-first.txt', {
      relativePath: 'source/detail-first.txt',
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const secondAssetId = insertAsset(db, secondProjectId, 'detail-second.kra', {
      extension: 'kra',
      mimeType: 'application/x-krita',
    });
    const note = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Asset Detail Note',
      assetIds: [firstAssetId, secondAssetId],
    });

    const response = await agent.get(`/notes/${note.id}`).expect(200);
    const assetsSection = response.text.match(/<section[^>]*class="[^"]*\bnotes-detail-assets\b[^"]*"[^>]*>[\s\S]*?<\/section>/)?.[0];

    expect(assetsSection).toBeDefined();
    expect(assetsSection).toContain('>Assets</h2>');
    expect(assetsSection).toContain(
      `<a class="notes-detail-asset-link" href="/projects/${firstProjectId}/assets/${firstAssetId}">detail-first.txt</a>`,
    );
    expect(assetsSection).toContain(
      `<a class="notes-detail-asset-link" href="/projects/${secondProjectId}/assets/${secondAssetId}">detail-second.kra</a>`,
    );
    expect(assetsSection).toContain('Project: Detail Asset First');
    expect(assetsSection).toContain('Project: Detail Asset Second');
    expect(assetsSection).toContain('source/detail-first.txt');
    expect(response.text).not.toContain('<h2>Projects</h2>');
  });

  it('preserves a missing historical asset on Notes detail with its viewer link', async () => {
    const projectId = insertProject(db, 'Historical Asset Project');
    const { chapter } = createChapterContext(app);
    const assetId = insertAsset(db, projectId, 'historical.bin', {
      extension: 'bin',
      mimeType: 'application/octet-stream',
    });
    markAssetMissing(db, assetId);
    archiveProject(db, projectId);
    const note = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Historical asset note',
      assetIds: [assetId],
    });

    const response = await agent.get(`/notes/${note.id}`).expect(200);
    const assetsSection = response.text.match(/<section[^>]*class="[^"]*\bnotes-detail-assets\b[^"]*"[^>]*>[\s\S]*?<\/section>/)?.[0];

    expect(assetsSection).toContain(
      `<a class="notes-detail-asset-link" href="/projects/${projectId}/assets/${assetId}">historical.bin</a>`,
    );
    expect(assetsSection).toContain('Project: Historical Asset Project');
    expect(assetsSection).toContain('>Missing</span>');

    const editResponse = await agent.get(`/notes/${note.id}/edit`).expect(200);
    expect(editResponse.text).toMatch(new RegExp(`id="note-asset-option-${assetId}"[^>]*checked`));
    expect(editResponse.text).toContain('>Missing</span>');
    expect(editResponse.text).toContain('>Archived project</span>');
  });

  it('GET and POST edit routes return 404 for a nonexistent note', async () => {
    await agent.get('/notes/9999/edit').expect(404);
    await agent
      .post('/notes/9999')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Missing', content: '' })
      .expect(404);
  });

  it('POST /notes/:id remains CSRF-protected', async () => {
    const { note } = createPage(app, { title: 'Protected Page', content: 'Stored content' });

    await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({ title: 'Updated', content: 'Changed content' })
      .expect(403);

    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      title: 'Protected Page',
      content: 'Stored content',
    });
  });

  it('GET and POST edit routes return 404 when a Page Book is missing', async () => {
    const { book, note } = createPage(app, { title: 'Orphaned Page', content: 'Content' });
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM books WHERE id = ?').run(book.id);
    db.pragma('foreign_keys = ON');

    await agent.get(`/notes/${note.id}/edit`).expect(404);
    await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: 'Updated', content: 'Content' })
      .expect(404);
  });

  it('POST /notes/:id/delete returns to the owning Chapter, compacts Pages, and cascades association rows', async () => {
    const projectId = insertProject(db, 'Delete Association Project');
    const assetId = insertAsset(db, projectId, 'delete-note-asset.png');
    const { chapter } = createChapterContext(app);
    const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Page', content: 'Content' });
    const note = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Delete me', content: 'Content' });
    const last = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Last Page', content: 'Content' });
    app.locals.noteRepository.replaceProjects(note.id, [projectId]);
    app.locals.noteRepository.replaceAssets(note.id, [assetId]);

    await agent.post(`/notes/${note.id}/delete`).type('form').send({}).expect(403);
    expect(app.locals.noteRepository.findById(note.id)).toBeDefined();

    const response = await agent
      .post(`/notes/${note.id}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe(`/notes/chapters/${chapter.id}`);
    expect(app.locals.noteRepository.findById(note.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM note_projects WHERE note_id = ?').all(note.id)).toEqual([]);
    expect(db.prepare('SELECT * FROM note_assets WHERE note_id = ?').all(note.id)).toEqual([]);

    const chapterPage = await agent.get(response.headers.location).expect(200);
    expect(chapterPage.text).toContain(`<a class="notes-page-nav-link" href="/notes/${first.id}">First Page</a>`);
    expect(chapterPage.text).toContain(`<a class="notes-page-nav-link" href="/notes/${last.id}">Last Page</a>`);
    expect(chapterPage.text).not.toContain(`<a href="/notes/${note.id}">Delete me</a>`);
    expect(chapterPage.text.indexOf('First Page')).toBeLessThan(chapterPage.text.indexOf('Last Page'));
  });

  it('POST /notes/:id/delete returns 404 for malformed and nonexistent Page IDs', async () => {
    await agent
      .post('/notes/01/delete')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(404);

    await agent
      .post('/notes/9999/delete')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(404);
  });

  it('POST /notes/:id/move moves a Page across Chapters and preserves its data', async () => {
    const sourceBook = app.locals.bookService.createBook({ title: 'Source Book' });
    const sourceChapter = app.locals.chapterService.createChapter({
      bookId: sourceBook.id,
      title: 'Source Chapter',
    });
    const targetBook = app.locals.bookService.createBook({ title: 'Target Book' });
    const targetChapter = app.locals.chapterService.createChapter({
      bookId: targetBook.id,
      title: 'Target Chapter',
    });
    const projectId = insertProject(db, 'Move Page Project');
    const assetId = insertAsset(db, projectId, 'move-page-asset.png');
    const first = app.locals.noteService.createNote({
      chapterId: sourceChapter.id,
      title: 'First Source Page',
      content: 'First content',
    });
    const moved = app.locals.noteService.createNote({
      chapterId: sourceChapter.id,
      title: 'Moved Page',
      content: '**Preserve this Markdown**',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const last = app.locals.noteService.createNote({
      chapterId: sourceChapter.id,
      title: 'Last Source Page',
      content: 'Last content',
    });
    const existing = app.locals.noteService.createNote({
      chapterId: targetChapter.id,
      title: 'Existing Target Page',
      content: 'Existing content',
    });
    const before = app.locals.noteService.getNote(moved.id);

    const detail = await agent.get(`/notes/${moved.id}`).expect(200);
    expect(detail.text).not.toContain(`<form method="post" action="/notes/${moved.id}/move"`);
    expect(detail.text).not.toContain('<select id="target-chapter" name="targetChapterId" required>');
    expect(detail.text).not.toContain('>Move Page</button>');

    const response = await agent
      .post(`/notes/${moved.id}/move`)
      .type('form')
      .send({ _csrf: csrfToken, targetChapterId: String(targetChapter.id) })
      .expect(302);

    expect(response.headers.location).toBe(`/notes/chapters/${targetChapter.id}`);

    const after = app.locals.noteService.getNote(moved.id);
    expect(after).toMatchObject({
      chapter_id: targetChapter.id,
      title: before.title,
      content: before.content,
      projectIds: before.projectIds,
      assetIds: before.assetIds,
      created_at: before.created_at,
      updated_at: before.updated_at,
    });
    expect(app.locals.noteService.listNotesForChapter(sourceChapter.id).map((note) => note.id))
      .toEqual([first.id, last.id]);
    expect(app.locals.noteService.listNotesForChapter(targetChapter.id).map((note) => note.id))
      .toEqual([existing.id, moved.id]);
    expect(db.prepare('SELECT id, sort_order FROM notes WHERE chapter_id = ? ORDER BY sort_order').all(sourceChapter.id))
      .toEqual([
        { id: first.id, sort_order: 0 },
        { id: last.id, sort_order: 1 },
      ]);
    expect(db.prepare('SELECT id, sort_order FROM notes WHERE chapter_id = ? ORDER BY sort_order').all(targetChapter.id))
      .toEqual([
        { id: existing.id, sort_order: 0 },
        { id: moved.id, sort_order: 1 },
      ]);

    const sourcePage = await agent.get(`/notes/chapters/${sourceChapter.id}`).expect(200);
    expect(sourcePage.text).not.toContain(`<a href="/notes/${moved.id}">Moved Page</a>`);
    const targetPage = await agent.get(response.headers.location).expect(200);
    expect(targetPage.text.indexOf('Existing Target Page')).toBeLessThan(targetPage.text.indexOf('Moved Page'));
  });

  it('POST /notes/:id/move allows a same-Chapter no-op and requires CSRF', async () => {
    const { chapter, note } = createPage(app, { title: 'Same Chapter Page', content: 'Content' });
    const before = app.locals.noteService.getNote(note.id);

    await agent
      .post(`/notes/${note.id}/move`)
      .type('form')
      .send({ targetChapterId: String(chapter.id) })
      .expect(403);
    expect(app.locals.noteService.getNote(note.id)).toEqual(before);

    const response = await agent
      .post(`/notes/${note.id}/move`)
      .type('form')
      .send({ _csrf: csrfToken, targetChapterId: String(chapter.id) })
      .expect(302);

    expect(response.headers.location).toBe(`/notes/chapters/${chapter.id}`);
    expect(app.locals.noteService.listNotesForChapter(chapter.id).map((page) => page.id)).toEqual([note.id]);
    expect(app.locals.noteService.getNote(note.id)).toEqual(before);
  });

  it('POST /notes/:id/move supports direct Book destinations', async () => {
    const sourceBook = app.locals.bookService.createBook({ title: 'Direct Move Source' });
    const targetBook = app.locals.bookService.createBook({ title: 'Direct Move Target' });
    const note = app.locals.noteService.createNote({
      bookId: sourceBook.id,
      title: 'Direct Move Page',
      content: 'Direct content',
    });

    const edit = await agent.get(`/notes/${note.id}/edit`).expect(200);
    expect(edit.text).toContain(`value="book:${sourceBook.id}"`);
    expect(edit.text).toContain(`value="book:${targetBook.id}"`);

    const response = await agent
      .post(`/notes/${note.id}/move`)
      .type('form')
      .send({ _csrf: csrfToken, targetContainer: `book:${targetBook.id}` })
      .expect(302);

    expect(response.headers.location).toBe(`/notes/books/${targetBook.id}`);
    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      book_id: targetBook.id,
      chapter_id: null,
      title: 'Direct Move Page',
      content: 'Direct content',
    });
  });

  it('POST /notes/:id/move rejects malformed and missing Page or Chapter IDs', async () => {
    const { chapter, note } = createPage(app, { title: 'Validation Page', content: 'Content' });

    for (const targetChapterId of ['01', '0', 'not-an-id']) {
      await agent
        .post(`/notes/${note.id}/move`)
        .type('form')
        .send({ _csrf: csrfToken, targetChapterId })
        .expect(422);
    }

    await agent
      .post(`/notes/${note.id}/move`)
      .type('form')
      .send({ _csrf: csrfToken, targetChapterId: '999999' })
      .expect(404);
    await agent
      .post('/notes/01/move')
      .type('form')
      .send({ _csrf: csrfToken, targetChapterId: String(chapter.id) })
      .expect(404);
    await agent
      .post('/notes/999999/move')
      .type('form')
      .send({ _csrf: csrfToken, targetChapterId: String(chapter.id) })
      .expect(404);
  });

  it('does not add Notes controls to project or asset pages', async () => {
    const projectId = insertProject(db, 'Scope Regression Project');
    const projectPage = await agent.get('/projects').expect(200);
    const projectDetailPage = await agent.get(`/projects/${projectId}`).expect(200);
    const assetPage = await agent.get('/assets').expect(200);

    for (const page of [projectPage, projectDetailPage, assetPage]) {
      expect(page.text).not.toContain('class="notes-table"');
      expect(page.text).not.toContain('New Note');
      expect(page.text).not.toContain('href="/notes/new"');
    }
  });

  describe('Book Chapters', () => {
    it('renders only the Book Chapters in canonical order and has an empty state', async () => {
      const book = app.locals.bookService.createBook({ title: 'Chapter Book' });
      const otherBook = app.locals.bookService.createBook({ title: 'Other Book' });
      const first = app.locals.chapterService.createChapter({ bookId: book.id, title: 'First Chapter' });
      const second = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Second Chapter' });
      app.locals.chapterService.createChapter({ bookId: otherBook.id, title: 'Unrelated Chapter' });

      const response = await agent.get(`/notes/books/${book.id}`).expect(200);

      expect(response.text).toContain('New Chapter');
      expect(response.text).toContain('Edit Book');
      expect(response.text).toContain(`/notes/chapters/${first.id}`);
      expect(response.text.indexOf('First Chapter')).toBeLessThan(response.text.indexOf('Second Chapter'));
      expect(response.text).not.toContain('Unrelated Chapter');
      expect(response.text).not.toContain('<h2>Details</h2>');

      const emptyBook = app.locals.bookService.createBook({ title: 'Empty Chapter Book' });
      const emptyResponse = await agent.get(`/notes/books/${emptyBook.id}`).expect(200);
      expect(emptyResponse.text).toContain('No Pages or Chapters yet');
    });

    it('renders and creates a Chapter with a trimmed title', async () => {
      const book = app.locals.bookService.createBook({ title: 'Create Chapter Book' });

      const form = await agent.get(`/notes/books/${book.id}/chapters/new`).expect(200);
      expect(form.text).toContain(`<form id="chapter-form" method="post" action="/notes/books/${book.id}/chapters"`);
      expect(form.text).toMatch(/name="_csrf"\s+value="[^"]+"/);

      const response = await agent
        .post(`/notes/books/${book.id}/chapters`)
        .type('form')
        .send({ _csrf: csrfToken, title: '  Created Chapter  ' })
        .expect(302);

      expect(response.headers.location).toMatch(/^\/notes\/chapters\/\d+$/);
      const chapterId = Number(response.headers.location.replace('/notes/chapters/', ''));
      expect(app.locals.chapterService.getChapter(chapterId)).toMatchObject({
        book_id: book.id,
        title: 'Created Chapter',
      });
    });

    it('validates Chapter creation and returns 404 for missing or malformed Books', async () => {
      const book = app.locals.bookService.createBook({ title: 'Validated Chapter Book' });

      for (const title of ['', 'x'.repeat(201)]) {
        const response = await agent
          .post(`/notes/books/${book.id}/chapters`)
          .type('form')
          .send({ _csrf: csrfToken, title })
          .expect(422);
        expect(response.text).toContain('Title');
      }
      expect(app.locals.chapterService.listChapters(book.id)).toEqual([]);

      await agent.get('/notes/books/not-an-id/chapters/new').expect(404);
      await agent.get('/notes/books/999999/chapters/new').expect(404);
      await agent
        .post('/notes/books/999999/chapters')
        .type('form')
        .send({ _csrf: csrfToken, title: 'Missing Book Chapter' })
        .expect(404);
    });

    it('renders an empty Chapter with parent Book context and a New Page action', async () => {
      const book = app.locals.bookService.createBook({ title: 'Parent Book' });
      const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Detail Chapter' });

      const response = await agent.get(`/notes/chapters/${chapter.id}`).expect(200);
      expect(response.text).toContain('Detail Chapter');
      expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
      expect(response.text).toContain('<div class="notes-chapter-detail-content notes-surface">');
      expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Parent Book</a>`);
      expect(response.text).toContain('Edit Chapter');
      expect(response.text).toContain('No Pages yet');
      expect(response.text).toContain(`<a class="button button-primary" href="/notes/new?chapterId=${chapter.id}">New Page</a>`);
      expect(response.text).not.toContain('Change order');
      expect(response.text).not.toContain('Move up');
      expect(response.text).not.toContain('Move down');
      expect(response.text).not.toContain('Danger zone');
    });

    it('renders Chapter detail with the authoritative mixed Book navigator and local Page outline', async () => {
      const book = app.locals.bookService.createBook({ title: 'Navigator Book' });
      const directFirst = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct First' });
      const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Current Chapter' });
      const nestedFirst = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Nested First' });
      const nestedSecond = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Nested Second' });
      const otherChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Other Chapter' });
      const otherNested = app.locals.noteService.createNote({ chapterId: otherChapter.id, title: 'Other Nested' });
      const directSecond = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Second' });
      const authoritativeContents = [
        {
          type: 'chapter',
          id: chapter.id,
          sortOrder: 20,
          chapter,
          pages: [nestedSecond, nestedFirst],
        },
        { type: 'page', id: directSecond.id, sortOrder: 21, page: directSecond },
        {
          type: 'chapter',
          id: otherChapter.id,
          sortOrder: 22,
          chapter: otherChapter,
          pages: [otherNested],
        },
        { type: 'page', id: directFirst.id, sortOrder: 23, page: directFirst },
      ];
      const listBookContents = vi.spyOn(app.locals.bookService, 'listBookContents')
        .mockReturnValue(authoritativeContents);
      const originalRender = app.response.render;
      let chapterLocals;
      app.response.render = function captureChapterRender(view, renderLocals, callback) {
        if (view === 'notes/chapters/detail.njk') chapterLocals = renderLocals;
        return originalRender.call(this, view, renderLocals, callback);
      };

      let response;
      let listBookContentsCalls = [];
      try {
        response = await agent.get(`/notes/chapters/${chapter.id}`).expect(200);
        listBookContentsCalls = listBookContents.mock.calls;
      } finally {
        app.response.render = originalRender;
        listBookContents.mockRestore();
      }

      const navigator = response.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
      expect(chapterLocals.bookContents).toBe(authoritativeContents);
      expect(chapterLocals.navCurrentChapterId).toBe(chapter.id);
      expect(Object.hasOwn(chapterLocals, 'navCurrentPageId')).toBe(false);
      expect(listBookContentsCalls).toContainEqual([book.id]);
      expect(response.text).toContain('<div class="notes-chapter-detail-layout">');
      expect(navigator).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
      expect(navigator).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">${book.title}</a>`);
      expect(navigator.indexOf('Current Chapter')).toBeLessThan(navigator.indexOf('Direct Second'));
      expect(navigator.indexOf('Direct Second')).toBeLessThan(navigator.indexOf('Other Chapter'));
      expect(navigator.indexOf('Other Chapter')).toBeLessThan(navigator.indexOf('Direct First'));
      expect(navigator.indexOf('Nested Second')).toBeLessThan(navigator.indexOf('Nested First'));
      expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directSecond.id}">Direct Second</a>`);
      expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directFirst.id}">Direct First</a>`);
      expect(navigator).toMatch(
        new RegExp(`<li class="notes-book-nav-item notes-book-nav-page">\\s*<a class="notes-book-nav-page-link" href="/notes/${directSecond.id}">`),
      );
      expect(navigator).toMatch(
        new RegExp(`<li class="notes-book-nav-item notes-book-nav-page">\\s*<a class="notes-book-nav-page-link" href="/notes/${directFirst.id}">`),
      );
      expect(navigator).toContain(`<a class="notes-book-nav-chapter-link" href="/notes/chapters/${chapter.id}" aria-current="page">Current Chapter</a>`);
      expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
      expect((navigator.match(/<details class="notes-book-nav-disclosure"/g) || [])).toHaveLength(2);
      expect((navigator.match(/aria-current="page"/g) || [])).toHaveLength(1);

      const pageNav = response.text.match(/<nav class="notes-page-nav"[\s\S]*?<\/nav>/)?.[0] || '';
      expect(pageNav).toContain(`<nav class="notes-page-nav" aria-label="Pages in ${chapter.title}">`);
      expect(pageNav).toContain(`<a class="notes-page-nav-link" href="/notes/${nestedFirst.id}">Nested First</a>`);
      expect(pageNav).toContain(`<a class="notes-page-nav-link" href="/notes/${nestedSecond.id}">Nested Second</a>`);
      expect(pageNav).not.toContain('Direct First');
      expect(pageNav).not.toContain('Direct Second');
      expect(response.text).toContain(`<a class="button button-primary" href="/notes/new?chapterId=${chapter.id}">New Page</a>`);
      expect(response.text).toContain(`<a class="button" href="/notes/chapters/${chapter.id}/edit">Edit Chapter</a>`);
      expect(response.text).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}/notes/order">Change order</a>`);
      expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
      expect(response.text).toContain('<div class="notes-chapter-detail-content notes-surface">');
    });

    it('renders a Chapter Page with a shallow Page link', async () => {
      const { chapter } = createChapterContext(app);
      const note = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Only Page' });

      const response = await agent.get(`/notes/chapters/${chapter.id}`).expect(200);

      expect(response.text).toContain('Only Page');
      expect(response.text).toContain(`<nav class="notes-page-nav" aria-label="Pages in Page Chapter">`);
      expect(response.text).toContain(`<a class="notes-page-nav-link" href="/notes/${note.id}">Only Page</a>`);
      expect(response.text).not.toContain('Edit Page');
      expect(response.text).not.toContain('>Page 1<');
    });

    it('renders only Chapter Pages in canonical Chapter-local order', async () => {
      const { book, chapter } = createChapterContext(app);
      const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Chapter Page' });
      const second = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Second Chapter Page' });
      const third = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Third Chapter Page' });
      const directBookPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Book Page' });
      const { chapter: otherChapter } = createChapterContext(app);
      const unrelated = app.locals.noteService.createNote({ chapterId: otherChapter.id, title: 'Other Chapter Page' });

      const response = await agent.get(`/notes/chapters/${chapter.id}`).expect(200);

      const pageNav = response.text.match(/<nav class="notes-page-nav"[\s\S]*?<\/nav>/)?.[0] || '';
      expect(pageNav).toContain('aria-label="Pages in Page Chapter"');
      expect(pageNav).toContain(`<a class="notes-page-nav-link" href="/notes/${first.id}">First Chapter Page</a>`);
      expect(pageNav).toContain(`<a class="notes-page-nav-link" href="/notes/${second.id}">Second Chapter Page</a>`);
       expect(pageNav).toContain(`<a class="notes-page-nav-link" href="/notes/${third.id}">Third Chapter Page</a>`);
       expect(response.text.indexOf('First Chapter Page')).toBeLessThan(response.text.indexOf('Second Chapter Page'));
       expect(response.text.indexOf('Second Chapter Page')).toBeLessThan(response.text.indexOf('Third Chapter Page'));
       expect(pageNav).not.toContain('Other Chapter Page');
       expect(pageNav).not.toContain('Direct Book Page');
      expect(response.text).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}/notes/order">Change order</a>`);
      expect(pageNav).not.toContain('aria-current="page"');
      expect(response.text).not.toContain('Edit Page');
      expect(response.text).not.toContain('>Page 1<');
      expect(response.text).not.toContain('>Page 2<');
      expect(response.text).not.toContain('>Page 3<');
      expect(response.text).not.toContain(`/notes/chapters/${chapter.id}/notes/reorder`);
      expect(response.text).not.toContain('Move up');
      expect(response.text).not.toContain('Move down');
      expect(response.text).not.toContain('Danger zone');

      const orderPage = await agent.get(`/notes/chapters/${chapter.id}/notes/order`).expect(200);
      expect(orderPage.text).toContain('<title>CreatorCrate — Notes — Change order — Page Chapter</title>');
      expect((orderPage.text.match(/<h1\b/g) || [])).toHaveLength(1);
      expect(orderPage.text).toContain('<h1 class="app-section-title">Notes — Change order — Page Chapter</h1>');
      expect(orderPage.text).not.toContain('notes-hierarchy');
      expect(orderPage.text).toContain('Drag a handle to move a Page');
      expect(orderPage.text).toContain(`<button class="button button-primary" type="submit" form="notes-chapter-order-form">Save</button>`);
      expect(orderPage.text).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}">Cancel</a>`);
      expect(orderPage.text).toContain(`<form id="notes-chapter-order-form" method="post" action="/notes/chapters/${chapter.id}/notes/reorder"`);
      expect(orderPage.text).toContain(`<input type="hidden" name="orderedNoteIds" data-chapter-page-order-input value="${[first, second, third].map((note) => note.id).join(',')}">`);
      expect((orderPage.text.match(/data-chapter-page-reorder-item/g) || [])).toHaveLength(3);
      expect((orderPage.text.match(/data-chapter-page-reorder-handle/g) || [])).toHaveLength(3);
      expect(orderPage.text).toContain('aria-label="Reorder Page: First Chapter Page"');
      expect(orderPage.text).toContain('Position 1 of 3');
      const orderList = orderPage.text.match(/<ol[\s\S]*?data-chapter-page-reorder-list[\s\S]*?<\/ol>/)?.[0] || '';
      expect(orderList.indexOf('First Chapter Page')).toBeLessThan(orderList.indexOf('Second Chapter Page'));
      expect(orderList.indexOf('Second Chapter Page')).toBeLessThan(orderList.indexOf('Third Chapter Page'));
      expect(orderPage.text).not.toContain('Direct Book Page');
      expect(orderPage.text).not.toContain('Other Chapter Page');
      expect(orderPage.text).toContain(`<a href="/notes/${first.id}">First Chapter Page</a>`);
      expect((orderPage.text.match(/draggable="true"/g) || [])).toHaveLength(6);
      expect(orderPage.text).not.toContain('Move up');
      expect(orderPage.text).not.toContain('Move down');
    });

    it('returns 404 for missing or malformed Chapters', async () => {

      await agent.get('/notes/chapters/not-an-id').expect(404);
      await agent.get('/notes/chapters/999999').expect(404);
      await agent.get('/notes/chapters/not-an-id/notes/order').expect(404);
      await agent.get('/notes/chapters/999999/notes/order').expect(404);
    });

    it('edits a Chapter and rerenders validation failures', async () => {
      const book = app.locals.bookService.createBook({ title: 'Edit Chapter Book' });
      const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Before Rename' });

      const form = await agent.get(`/notes/chapters/${chapter.id}/edit`).expect(200);
      const pageHeading = form.text.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0];
      expect((form.text.match(/<h1\b/g) || [])).toHaveLength(1);
      expect(pageHeading).toBeDefined();
      expect(pageHeading).toContain('<button class="button button-primary" type="submit" form="chapter-form">Save</button>');
      expect(pageHeading).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}">Cancel</a>`);
      expect(pageHeading).not.toContain('>Edit<');
      expect(pageHeading).not.toContain('Manage');
      expect(pageHeading).not.toContain('Delete');
      expect(form.text).toContain(`action="/notes/chapters/${chapter.id}"`);
      expect(form.text).toContain('value="Before Rename"');
      expect(form.text).toContain('<h1 class="app-section-title">Notes — Edit Before Rename</h1>');
      expect(form.text).not.toContain('notes-hierarchy');
      expect(form.text).toContain('<label for="title">Title <span class="required" aria-label="required">*</span></label>');
      expect(form.text).toContain('<details class="notes-workspace-disclosure notes-workspace-disclosure--delete">');
      expect(form.text).toContain('<summary>Delete Chapter</summary>');
      expect(form.text).toContain(`<form id="chapter-delete-form" method="post" action="/notes/chapters/${chapter.id}/delete">`);
      expect(form.text).toMatch(new RegExp(`<form id="chapter-delete-form"[\\s\\S]*?name="_csrf"[^>]+value="[^"]+"`));
      expect(form.text).toContain('data-confirm="Delete this Chapter permanently? This cannot be undone."');
      expect(form.text).toContain('The Chapter must be empty before it can be deleted.');
      expect(form.text).not.toContain('type="submit" form="chapter-form">Edit</button>');
      expect(form.text).not.toContain('Danger zone');
      expect(form.text).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);

      const chapterFormStart = form.text.indexOf('<form id="chapter-form"');
      const chapterFormEnd = form.text.indexOf('</form>', chapterFormStart);
      const chapterFormBody = form.text.slice(form.text.indexOf('>', chapterFormStart) + 1, chapterFormEnd);
      const deleteFormStart = form.text.indexOf('<form id="chapter-delete-form"');
      expect(chapterFormStart).toBeGreaterThanOrEqual(0);
      expect(chapterFormEnd).toBeGreaterThan(chapterFormStart);
      expect(chapterFormBody).not.toContain('<form');
      expect(deleteFormStart).toBeGreaterThan(chapterFormEnd);

      const response = await agent
        .post(`/notes/chapters/${chapter.id}`)
        .type('form')
        .send({ _csrf: csrfToken, title: '  After Rename  ' })
        .expect(302);
      expect(response.headers.location).toBe(`/notes/chapters/${chapter.id}`);
      expect(app.locals.chapterService.getChapter(chapter.id).title).toBe('After Rename');

      const invalid = await agent
        .post(`/notes/chapters/${chapter.id}`)
        .type('form')
        .send({ _csrf: csrfToken, title: '' })
        .expect(422);
      expect(invalid.text).toContain('Title is required.');
      expect(invalid.text).toContain('value=""');
      expect(invalid.text).toContain('<h1 class="app-section-title">Notes — Edit After Rename</h1>');
      expect(invalid.text).not.toContain('notes-hierarchy');
      expect(invalid.text).toContain('<button class="button button-primary" type="submit" form="chapter-form">Save</button>');
      expect(invalid.text).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}">Cancel</a>`);

      await agent.get('/notes/chapters/999999/edit').expect(404);
      await agent
        .post('/notes/chapters/999999')
        .type('form')
        .send({ _csrf: csrfToken, title: 'Missing' })
        .expect(404);
    });

    it('deletes an empty Chapter, rejects non-empty Chapters, and preserves CSRF protection', async () => {
      const book = app.locals.bookService.createBook({ title: 'Delete Chapter Book' });
      const empty = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Empty Chapter' });

      await agent.post(`/notes/chapters/${empty.id}/delete`).type('form').send({}).expect(403);
      const deleted = await agent
        .post(`/notes/chapters/${empty.id}/delete`)
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(302);
      expect(deleted.headers.location).toBe(`/notes/books/${book.id}`);
      expect(app.locals.chapterService.listChapters(book.id).map((chapter) => chapter.id)).not.toContain(empty.id);

      const nonEmpty = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Non-empty Chapter' });
      db.prepare(`
        INSERT INTO notes (book_id, chapter_id, title, content, sort_order)
        VALUES (?, ?, 'Chapter Note', '', 0)
      `).run(book.id, nonEmpty.id);
      const nonEmptyEdit = await agent.get(`/notes/chapters/${nonEmpty.id}/edit`).expect(200);
      expect(nonEmptyEdit.text).toContain('The Chapter must be empty before it can be deleted.');
      await agent
        .post(`/notes/chapters/${nonEmpty.id}/delete`)
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(409);
      expect(app.locals.chapterService.listChapters(book.id).map((chapter) => chapter.id)).toContain(nonEmpty.id);

      await agent
        .post('/notes/chapters/999999/delete')
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(404);
    });

    it('reorders Chapters only within their Book and renders authoritative Book-content order', async () => {
      const book = app.locals.bookService.createBook({ title: 'Reorder Chapter Book' });
      const otherBook = app.locals.bookService.createBook({ title: 'Other Reorder Book' });
      const first = app.locals.chapterService.createChapter({ bookId: book.id, title: 'First Ordered Chapter' });
      const second = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Second Ordered Chapter' });
      const other = app.locals.chapterService.createChapter({ bookId: otherBook.id, title: 'Other Ordered Chapter' });
      const orderedIds = [second.id, first.id];

      await agent
        .post(`/notes/books/${book.id}/chapters/reorder`)
        .type('form')
        .send({ orderedChapterIds: orderedIds.join(',') })
        .expect(403);
      expect(app.locals.chapterService.listChapters(book.id).map((chapter) => chapter.id))
        .toEqual([first.id, second.id]);

      await agent
        .post(`/notes/books/${book.id}/chapters/reorder`)
        .type('form')
        .send({ _csrf: csrfToken, orderedChapterIds: orderedIds.join(',') })
        .expect(302)
        .expect('Location', `/notes/books/${book.id}`);
      expect(app.locals.chapterService.listChapters(book.id).map((chapter) => chapter.id)).toEqual(orderedIds);

      for (const orderedChapterIds of [`${second.id},${other.id}`, 'not-an-id']) {
        const response = await agent
          .post(`/notes/books/${book.id}/chapters/reorder`)
          .type('form')
          .send({ _csrf: csrfToken, orderedChapterIds })
          .expect(422);
        expect(response.text).toContain('submitted chapter order is invalid');
        expect(app.locals.chapterService.listChapters(book.id).map((chapter) => chapter.id)).toEqual(orderedIds);
      }

      const bookPage = await agent.get(`/notes/books/${book.id}`).expect(200);
      const bookContents = app.locals.bookService.listBookContents(book.id);
      expect(bookContents.map(({ type, id }) => ({ type, id }))).toEqual([
        { type: 'chapter', id: first.id },
        { type: 'chapter', id: second.id },
      ]);
      expect(bookPage.text.indexOf('First Ordered Chapter')).toBeLessThan(bookPage.text.indexOf('Second Ordered Chapter'));
    });

    it('reorders mixed Book contents by typed identity and persists only the target Book order', async () => {
      const book = app.locals.bookService.createBook({ title: 'Mixed Reorder Book' });
      const pageA = app.locals.noteService.createNote({
        bookId: book.id,
        title: 'Page A',
        content: 'Page A content',
      });
      const chapterX = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter X' });
      const pageB = app.locals.noteService.createNote({
        bookId: book.id,
        title: 'Page B',
        content: 'Page B content',
      });
      const chapterY = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Y' });
      const chapterPage = app.locals.noteService.createNote({
        chapterId: chapterX.id,
        title: 'Nested Chapter Page',
        content: 'Nested content',
      });
      const otherBook = app.locals.bookService.createBook({ title: 'Other Mixed Reorder Book' });
      const otherChapter = app.locals.chapterService.createChapter({ bookId: otherBook.id, title: 'Foreign Chapter' });
      const otherPage = app.locals.noteService.createNote({
        bookId: otherBook.id,
        title: 'Foreign Page',
        content: 'Foreign content',
      });
      const otherContentsBefore = db.prepare(`
        SELECT item_type, item_id, sort_order
        FROM book_contents
        WHERE book_id = ?
        ORDER BY sort_order
      `).all(otherBook.id);

      expect(chapterX.id).toBe(pageA.id);
      expect(chapterY.id).toBe(pageB.id);
      const orderedItems = [
        `chapter:${chapterY.id}`,
        `page:${pageA.id}`,
        `chapter:${chapterX.id}`,
        `page:${pageB.id}`,
      ].join(',');

      const response = await agent
        .post(`/notes/books/${book.id}/contents/reorder`)
        .type('form')
        .send({ _csrf: csrfToken, orderedItems })
        .expect(302);

      expect(response.headers.location).toBe(`/notes/books/${book.id}`);
      expect(db.prepare(`
        SELECT item_type, item_id, sort_order
        FROM book_contents
        WHERE book_id = ?
        ORDER BY sort_order
      `).all(book.id)).toEqual([
        { item_type: 'chapter', item_id: chapterY.id, sort_order: 0 },
        { item_type: 'page', item_id: pageA.id, sort_order: 1 },
        { item_type: 'chapter', item_id: chapterX.id, sort_order: 2 },
        { item_type: 'page', item_id: pageB.id, sort_order: 3 },
      ]);
      expect(db.prepare(`
        SELECT item_type, item_id, sort_order
        FROM book_contents
        WHERE book_id = ?
        ORDER BY sort_order
      `).all(otherBook.id)).toEqual(otherContentsBefore);

      const bookPage = await agent.get(response.headers.location).expect(200);
      expect(bookPage.text.indexOf('Chapter Y')).toBeLessThan(bookPage.text.indexOf('Page A'));
      expect(bookPage.text.indexOf('Page A')).toBeLessThan(bookPage.text.indexOf('Chapter X'));
      expect(bookPage.text.indexOf('Chapter X')).toBeLessThan(bookPage.text.indexOf('Page B'));
      const chapterXOutline = bookPage.text.match(new RegExp(
        `<li class="book-outline-item book-outline-chapter">[\\s\\S]*?<a class="book-outline-title" href="/notes/chapters/${chapterX.id}">Chapter X</a>[\\s\\S]*?</details>\\s*</li>`,
      ))?.[0] || '';
      expect(chapterXOutline).toMatch(new RegExp(
        `<li class="book-outline-item book-outline-page book-outline-page--child">\\s*<a class="book-outline-title" href="/notes/${chapterPage.id}">Nested Chapter Page</a>`,
      ));
      expect(bookPage.text).not.toMatch(new RegExp(
        `<li class="book-outline-item book-outline-page">\\s*<a class="book-outline-title" href="/notes/${chapterPage.id}">Nested Chapter Page</a>`,
      ));
      expect(bookPage.text).not.toContain('Foreign Chapter');
      expect(bookPage.text).not.toContain('Foreign Page');
      expect(chapterPage.chapter_id).toBe(chapterX.id);
      expect(otherChapter.book_id).toBe(otherBook.id);
      expect(otherPage.book_id).toBe(otherBook.id);
    });

    it('requires CSRF and rejects malformed or non-permutation mixed Book orders atomically', async () => {
      const book = app.locals.bookService.createBook({ title: 'Mixed Validation Book' });
      const pageA = app.locals.noteService.createNote({
        bookId: book.id,
        title: 'Validation Page A',
        content: 'Page A content',
      });
      const chapterX = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Validation Chapter X' });
      const pageB = app.locals.noteService.createNote({
        bookId: book.id,
        title: 'Validation Page B',
        content: 'Page B content',
      });
      const chapterY = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Validation Chapter Y' });
      const chapterPage = app.locals.noteService.createNote({
        chapterId: chapterX.id,
        title: 'Validation Chapter Page',
        content: 'Nested content',
      });
      const otherBook = app.locals.bookService.createBook({ title: 'Validation Other Book' });
      const otherChapter = app.locals.chapterService.createChapter({ bookId: otherBook.id, title: 'Other Chapter' });
      const otherPage = app.locals.noteService.createNote({
        bookId: otherBook.id,
        title: 'Other Page',
        content: 'Other content',
      });
      const reorderUrl = `/notes/books/${book.id}/contents/reorder`;
      const validItems = [
        `chapter:${chapterY.id}`,
        `page:${pageA.id}`,
        `chapter:${chapterX.id}`,
        `page:${pageB.id}`,
      ];
      const before = db.prepare(`
        SELECT item_type, item_id, sort_order
        FROM book_contents
        WHERE book_id = ?
        ORDER BY sort_order
      `).all(book.id);

      await agent
        .post(reorderUrl)
        .type('form')
        .send({ orderedItems: validItems.join(',') })
        .expect(403);
      expect(db.prepare(`
        SELECT item_type, item_id, sort_order
        FROM book_contents
        WHERE book_id = ?
        ORDER BY sort_order
      `).all(book.id)).toEqual(before);

      const invalidValues = [
        'section:1,page:1,chapter:2,page:2',
        'chapter:1.5,page:1,chapter:2,page:2',
        'chapter:1e2,page:1,chapter:2,page:2',
        'chapter:0,page:1,chapter:2,page:2',
        'chapter:-1,page:1,chapter:2,page:2',
        'chapter:01,page:1,chapter:2,page:2',
        'chapter:1,,page:1,chapter:2',
        'chapter:1,page:1,chapter:2,page:2,',
        `${validItems.join(',')}\n`,
        [
          `chapter:${chapterY.id}`,
          `page:${pageA.id}`,
          `chapter:${chapterX.id}`,
          `chapter:${chapterX.id}`,
        ].join(','),
        [
          `chapter:${chapterY.id}`,
          `page:${pageA.id}`,
          `chapter:${chapterX.id}`,
        ].join(','),
        [
          `chapter:${chapterY.id}`,
          `page:${pageA.id}`,
          `chapter:${chapterX.id}`,
          'page:999999',
        ].join(','),
        [
          `chapter:${chapterY.id}`,
          `page:${pageA.id}`,
          `chapter:${chapterX.id}`,
          `chapter:${otherChapter.id}`,
        ].join(','),
        [
          `chapter:${chapterY.id}`,
          `page:${pageA.id}`,
          `chapter:${chapterX.id}`,
          `page:${otherPage.id}`,
        ].join(','),
        [
          `chapter:${chapterY.id}`,
          `page:${pageA.id}`,
          `chapter:${chapterX.id}`,
          `page:${chapterPage.id}`,
        ].join(','),
      ];

      for (const orderedItems of invalidValues) {
        const response = await agent
          .post(reorderUrl)
          .type('form')
          .send({ _csrf: csrfToken, orderedItems })
          .expect(422);
        expect(response.text).toContain('submitted Book content order is invalid');
        expect(db.prepare(`
          SELECT item_type, item_id, sort_order
          FROM book_contents
          WHERE book_id = ?
          ORDER BY sort_order
        `).all(book.id)).toEqual(before);
      }

      await agent
        .post(reorderUrl)
        .type('form')
        .send({ _csrf: csrfToken, orderedItems: [validItems.join(','), validItems.join(',')] })
        .expect(422);
      expect(db.prepare(`
        SELECT item_type, item_id, sort_order
        FROM book_contents
        WHERE book_id = ?
        ORDER BY sort_order
      `).all(book.id)).toEqual(before);

      const typeSwapBook = app.locals.bookService.createBook({ title: 'Type Swap Book' });
      const typeSwapPage = app.locals.noteService.createNote({
        bookId: typeSwapBook.id,
        title: 'Type Swap Page',
        content: 'Type swap content',
      });
      const typeSwapBefore = db.prepare(`
        SELECT item_type, item_id, sort_order
        FROM book_contents
        WHERE book_id = ?
        ORDER BY sort_order
      `).all(typeSwapBook.id);
      await agent
        .post(`/notes/books/${typeSwapBook.id}/contents/reorder`)
        .type('form')
        .send({ _csrf: csrfToken, orderedItems: `chapter:${typeSwapPage.id}` })
        .expect(422);
      expect(db.prepare(`
        SELECT item_type, item_id, sort_order
        FROM book_contents
        WHERE book_id = ?
        ORDER BY sort_order
      `).all(typeSwapBook.id)).toEqual(typeSwapBefore);

      for (const bookId of ['01', 'not-an-id', '999999']) {
        await agent
          .post(`/notes/books/${bookId}/contents/reorder`)
          .type('form')
          .send({ _csrf: csrfToken, orderedItems: validItems.join(',') })
          .expect(404);
      }
    });

    it('handles empty and one-item Book content reorder posts', async () => {
      const emptyBook = app.locals.bookService.createBook({ title: 'Empty Reorder Book' });

      await agent
        .post(`/notes/books/${emptyBook.id}/contents/reorder`)
        .type('form')
        .send({ _csrf: csrfToken, orderedItems: '' })
        .expect(302)
        .expect('Location', `/notes/books/${emptyBook.id}`);
      expect(db.prepare('SELECT COUNT(*) AS count FROM book_contents WHERE book_id = ?').get(emptyBook.id).count)
        .toBe(0);

      const oneItemBook = app.locals.bookService.createBook({ title: 'One Item Reorder Book' });
      const page = app.locals.noteService.createNote({
        bookId: oneItemBook.id,
        title: 'Only Book Page',
        content: 'Only content',
      });

      await agent
        .post(`/notes/books/${oneItemBook.id}/contents/reorder`)
        .type('form')
        .send({ _csrf: csrfToken, orderedItems: `page:${page.id}` })
        .expect(302)
        .expect('Location', `/notes/books/${oneItemBook.id}`);
      expect(db.prepare('SELECT item_type, item_id, sort_order FROM book_contents WHERE book_id = ?').all(oneItemBook.id))
        .toEqual([{ item_type: 'page', item_id: page.id, sort_order: 0 }]);
    });

    it('reorders Pages only within their Chapter and returns to that Chapter', async () => {
      const { chapter } = createChapterContext(app);
      const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Ordered Page' });
      const second = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Second Ordered Page' });
      const { chapter: otherChapter } = createChapterContext(app);
      const other = app.locals.noteService.createNote({ chapterId: otherChapter.id, title: 'Other Chapter Page' });
      const updatedAtBefore = db.prepare('SELECT id, updated_at FROM notes ORDER BY id').all();
      const orderedIds = [second.id, first.id];

      const controlsPage = await agent.get(`/notes/chapters/${chapter.id}`).expect(200);
      expect(controlsPage.text).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}/notes/order">Change order</a>`);
      expect(controlsPage.text).not.toContain(`action="/notes/chapters/${chapter.id}/notes/reorder"`);
      expect(controlsPage.text).not.toContain(`name="orderedNoteIds"`);
      expect(controlsPage.text).not.toContain('Move up');
      expect(controlsPage.text).not.toContain('Move down');

      const response = await agent
        .post(`/notes/chapters/${chapter.id}/notes/reorder`)
        .type('form')
        .send({ _csrf: csrfToken, orderedNoteIds: orderedIds.join(',') })
        .expect(302);

      expect(response.headers.location).toBe(`/notes/chapters/${chapter.id}`);
      expect(app.locals.noteService.listNotesForChapter(chapter.id).map((note) => note.id)).toEqual(orderedIds);
      expect(app.locals.noteService.listNotesForChapter(otherChapter.id).map((note) => note.id)).toEqual([other.id]);
      expect(db.prepare('SELECT id, updated_at FROM notes ORDER BY id').all()).toEqual(updatedAtBefore);

      const chapterPage = await agent.get(response.headers.location).expect(200);
      expect(chapterPage.text.indexOf('Second Ordered Page')).toBeLessThan(chapterPage.text.indexOf('First Ordered Page'));
    });

    it('renders no Page reorder controls for empty or single-Page Chapters', async () => {
      const { chapter } = createChapterContext(app);

      const emptyPage = await agent.get(`/notes/chapters/${chapter.id}`).expect(200);
      expect(emptyPage.text).not.toContain(`/notes/chapters/${chapter.id}/notes/reorder`);
      expect(emptyPage.text).not.toContain('Change order');

      await agent
        .post(`/notes/chapters/${chapter.id}/notes/reorder`)
        .type('form')
        .send({ _csrf: csrfToken, orderedNoteIds: '' })
        .expect(302)
        .expect('Location', `/notes/chapters/${chapter.id}`);

      const note = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Only Page' });
      const singlePage = await agent.get(`/notes/chapters/${chapter.id}`).expect(200);
      expect(singlePage.text).not.toContain(`/notes/chapters/${chapter.id}/notes/reorder`);
      expect(singlePage.text).not.toContain('Change order');
      expect(singlePage.text).not.toContain('Move up');
      expect(singlePage.text).not.toContain('Move down');

      await agent
        .post(`/notes/chapters/${chapter.id}/notes/reorder`)
        .type('form')
        .send({ _csrf: csrfToken, orderedNoteIds: String(note.id) })
        .expect(302);
    });

    it('requires CSRF and rejects malformed or non-local Page reorder payloads', async () => {
      const { chapter } = createChapterContext(app);
      const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Page' });
      const second = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Second Page' });
      const { chapter: otherChapter } = createChapterContext(app);
      const other = app.locals.noteService.createNote({ chapterId: otherChapter.id, title: 'Other Page' });
      const before = app.locals.noteService.listNotesForChapter(chapter.id).map((note) => note.id);
      const reorderUrl = `/notes/chapters/${chapter.id}/notes/reorder`;

      await agent
        .post(reorderUrl)
        .type('form')
        .send({ orderedNoteIds: `${second.id},${first.id}` })
        .expect(403);

      for (const payload of [
        { orderedNoteIds: 'not-an-id' },
        { orderedNoteIds: `${first.id},${first.id}` },
        { orderedNoteIds: String(first.id) },
        { orderedNoteIds: `${first.id},${second.id},999999` },
        { orderedNoteIds: `${first.id},${other.id}` },
      ]) {
        const response = await agent
          .post(reorderUrl)
          .type('form')
          .send({ _csrf: csrfToken, ...payload })
          .expect(422);

        expect(response.text).toContain('submitted note order is invalid');
        expect(response.text).not.toContain('999999');
        expect(app.locals.noteService.listNotesForChapter(chapter.id).map((note) => note.id)).toEqual(before);
      }

      for (const chapterId of ['01', '999999']) {
        await agent
          .post(`/notes/chapters/${chapterId}/notes/reorder`)
          .type('form')
          .send({ _csrf: csrfToken, orderedNoteIds: `${first.id},${second.id}` })
          .expect(404);
      }
    });
  });
});
