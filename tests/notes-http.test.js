import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { buildAssetPreviewModel } from '../src/services/asset-presentation.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function getNewNoteDialog(html) {
  return html.match(/<dialog\b[^>]*id="note-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
}

function getNoteDialogBaseline(dialog) {
  const serialized = dialog.match(/<script type="application\/json" data-note-dialog-baseline>([\s\S]*?)<\/script>/)?.[1];
  return serialized ? JSON.parse(serialized) : null;
}

function expectClosedBookContentsDisclosure(dialog) {
  const heading = dialog.indexOf('<h3 id="notes-book-contents-heading">Book contents</h3>');
  const disclosure = dialog.indexOf('<details class="notes-book-contents-disclosure">');
  const summary = dialog.indexOf('<summary class="notes-book-contents-toggle">');
  const body = dialog.indexOf('<div class="project-form-section-body project-edit-dialog-section-body">');
  const navigator = dialog.indexOf('<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded" aria-label="Book contents">');

  expect(dialog.match(/<details class="notes-book-contents-disclosure"(?:\s|>)/g)).toHaveLength(1);
  expect(dialog).not.toContain('<details class="notes-book-contents-disclosure" open>');
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(heading).toBeLessThan(disclosure);
  expect(disclosure).toBeLessThan(summary);
  expect(summary).toBeLessThan(body);
  expect(body).toBeLessThan(navigator);
  expect(dialog).toContain('notes-book-contents-toggle-label--expand">Expand</span>');
  expect(dialog).toContain('notes-book-contents-toggle-label--collapse">Collapse</span>');
}

function expectNewNoteDialog(html, open) {
  const dialog = getNewNoteDialog(html);
  expect(dialog).toContain('class="app-dialog project-form-dialog"');
  expect(dialog).toContain('data-app-dialog');
  expect(dialog).toContain('aria-labelledby="note-create-dialog-title"');
  expect(dialog).toContain('data-dialog-close aria-label="Close New Page"');
  expect(dialog).not.toContain('data-dialog-backdrop-static');
  expect(/<dialog\b[^>]*\sopen(?:\s|>)/.test(dialog)).toBe(open);
  expect(dialog).toContain('data-notes-editor-form data-note-dialog-dirty data-dialog-form data-dialog-async="false" novalidate');
  expect(dialog).toContain('type="application/json" data-note-dialog-baseline>');
  expect(dialog).toContain('class="app-dialog-body project-edit-dialog-body"');
  expect(dialog).toContain('class="app-dialog-footer"');
  expect(dialog.indexOf('</form>')).toBeLessThan(dialog.indexOf('class="app-dialog-footer"'));
  expect(dialog).toContain('type="submit" form="note-form" data-dialog-submit');
  expect(html.match(/<form\b[^>]*id="note-form"/g)).toHaveLength(1);
  expect(html.match(/\sdata-notes-editor-host(?:\s|>)/g)).toHaveLength(1);
  expect(html.match(/\sdata-notes-editor-source(?:\s|>)/g)).toHaveLength(1);
  expect(dialog.match(/name="_csrf"/g)).toHaveLength(1);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  const contents = dialog.indexOf('aria-label="Book contents"');
  const writing = dialog.indexOf('aria-labelledby="notes-editor-heading"');
  const connections = dialog.indexOf('aria-labelledby="notes-connections-heading"');
  expect(contents).toBeGreaterThan(dialog.indexOf('<form'));
  expect(writing).toBeGreaterThan(contents);
  expect(connections).toBeGreaterThan(writing);
  expect(dialog).not.toMatch(/notes-page-sidebar|notes-page-workspace-layout|class="notes-workspace-editor"/);
  expect(dialog).not.toContain('Move Page');
  expect(dialog).not.toContain('Delete Page');
  expectClosedBookContentsDisclosure(dialog);
  return dialog;
}

function getEditNoteDialog(html) {
  return html.match(/<dialog\b[^>]*id="note-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
}

function expectEditNoteDialog(html, noteId, open) {
  const dialog = getEditNoteDialog(html);
  expect(dialog).toContain('class="app-dialog project-form-dialog"');
  expect(dialog).toContain('data-app-dialog');
  expect(dialog).toContain('aria-labelledby="note-edit-dialog-title"');
  expect(dialog).toContain('data-dialog-close aria-label="Close Edit Page"');
  expect(dialog).not.toContain('data-dialog-backdrop-static');
  expect(/<dialog\b[^>]*\sopen(?:\s|>)/.test(dialog)).toBe(open);
  expect(html).toContain('class="notes-page-detail-layout"');
  expect(html).toContain('href="/notes/' + noteId + '/edit" data-dialog-open="note-edit-dialog"');
  expect(dialog).toContain('data-notes-editor-form data-note-dialog-dirty data-dialog-form data-dialog-async="false" novalidate');
  expect(dialog).toContain('type="application/json" data-note-dialog-baseline>');
  expect(dialog).toContain('type="submit" form="note-form" data-dialog-submit>Save</button>');
  expect(html.match(/<form\b[^>]*id="note-form"/g)).toHaveLength(1);
  expect(html.match(/\sdata-notes-editor-host(?:\s|>)/g)).toHaveLength(1);
  expect(html.match(/\sdata-notes-editor-source(?:\s|>)/g)).toHaveLength(1);
  expect(dialog.match(/<form\b/g)).toHaveLength(3);
  expect(dialog.match(/name="_csrf"/g)).toHaveLength(3);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const match of dialog.matchAll(/\s(?:for|aria-labelledby|aria-describedby)="([^"]+)"/g)) {
    for (const id of match[1].split(/\s+/)) expect(ids.filter(value => value === id)).toHaveLength(1);
  }
  const contents = dialog.indexOf('aria-label="Book contents"');
  const writing = dialog.indexOf('aria-labelledby="notes-editor-heading"');
  const connections = dialog.indexOf('aria-labelledby="notes-connections-heading"');
  const end = dialog.indexOf('</form>');
  expect(contents).toBeGreaterThan(dialog.indexOf('<form'));
  expect(writing).toBeGreaterThan(contents);
  expect(connections).toBeGreaterThan(writing);
  expect(end).toBeGreaterThan(connections);
  expect(dialog.indexOf('Move Page')).toBeGreaterThan(end);
  expect(dialog.indexOf('Delete Page')).toBeGreaterThan(end);
  expect(dialog.indexOf('<form id="note-move-form"')).toBeGreaterThan(end);
  expect(dialog.indexOf('<form id="note-delete-form"')).toBeGreaterThan(end);
  expect(dialog).not.toMatch(/notes-page-sidebar|notes-page-workspace-layout|class="notes-workspace-editor"/);
  expectClosedBookContentsDisclosure(dialog);
  return dialog;
}

function insertProject(db, title) {
  return Number(db
    .prepare(
      `INSERT INTO projects (title, slug, description, notes, status, patreon_url)
       VALUES (?, ?, '', '', 'tbd', NULL)`
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

function captureChapterDetailLocals(app) {
  const renders = [];
  const originalRender = app.response.render;
  app.response.render = function captureRender(view, renderLocals, callback) {
    if (view === 'notes/chapters/detail.njk') renders.push(renderLocals);
    return originalRender.call(this, view, renderLocals, callback);
  };

  return {
    all() {
      return renders;
    },
    restore() {
      app.response.render = originalRender;
    },
  };
}

function extractNoteProjectsField(html) {
  return html.match(/<fieldset class="field asset-filter-multiselect-field[^\"]*">\s*<legend>Projects<\/legend>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

function expectEditChapterDialog(html, chapterId, open) {
  const dialog = html.match(/<dialog\b[^>]*id="chapter-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  expect(dialog).toContain('class="app-dialog project-form-dialog"');
  expect(dialog).toContain('class="app-dialog-form project-form project-edit-dialog-form"');
  const sections = [...dialog.matchAll(/<section class="settings-section project-form-section project-edit-dialog-section"[^>]*>([\s\S]*?)<\/section>/g)];
  expect(sections).toHaveLength(2);
  expect(sections[1][1]).toMatch(/^\s*<h3 id="chapter-actions-heading">Chapter Actions<\/h3>\s*<div class="project-form-section-body project-edit-dialog-section-body">/);
  expect(dialog.match(/>Chapter Actions<\/h[1-6]>/g)).toHaveLength(1);
  expect(dialog).not.toContain('Secondary actions');
  expect(sections[1][1].match(/<h[1-6]\b/g)).toHaveLength(1);
  expect(sections[0][1]).toMatch(/^\s*<h3>Basic information<\/h3>\s*<div class="project-form-section-body project-edit-dialog-section-body">/);
  expect(dialog.match(/>Basic information<\/h[1-6]>/g)).toHaveLength(1);
  expect(sections[0][1]).toContain('field app-dialog-field');
  expect(dialog.match(/name="title"/g)).toHaveLength(1);
  expect(dialog).toContain('<label for="chapter-edit-title">');
  expect(dialog).toContain('id="chapter-edit-title" name="title"');

  expect(dialog).toContain('data-app-dialog');
  expect(dialog).toContain('aria-labelledby="chapter-edit-dialog-title"');
  expect(dialog).toContain('<h2 id="chapter-edit-dialog-title">Edit Chapter</h2>');
  expect(dialog).toContain('data-dialog-close aria-label="Close Edit Chapter"');
  expect(/<dialog\b[^>]*\sopen(?:\s|>)/.test(dialog)).toBe(open);
  expect(dialog).not.toContain('data-dialog-backdrop-static');
  expect(dialog).toContain('data-dialog-form data-dialog-async="false" novalidate');
  expect(dialog).toContain('type="submit" data-dialog-submit>Save</button>');
  expect(dialog).toContain('<form id="chapter-form" method="post" action="/notes/chapters/' + chapterId + '"');
  expect(dialog).toMatch(/<form id="chapter-form"[\s\S]*?name="_csrf"[^>]+value="[^"]+"/);
  expect(dialog.match(/<form\b/g)).toHaveLength(2);
  expect(html).toContain('class="notes-chapter-detail-layout"');
  expect(html).toContain('href="/notes/chapters/' + chapterId + '/edit" data-dialog-open="chapter-edit-dialog"');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(dialog).toContain('<label for="chapter-edit-title">');
  expect(dialog).toContain('id="chapter-edit-title" name="title"');
  let depth = 0;
  for (const [tag] of html.matchAll(/<\/?form\b[^>]*>/g)) {
    depth += tag.startsWith('</') ? -1 : 1;
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(depth).toBeLessThanOrEqual(1);
  }
  expect(depth).toBe(0);
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

  it.each(['book', 'chapter'])('hosts one New Page dialog on %s detail and preserves failed submissions', async (container) => {
    const { book, chapter } = createChapterContext(app);
    const id = container === 'book' ? book.id : chapter.id;
    const containerKey = `${container}Id`;
    const hostUrl = `/notes/${container === 'book' ? 'books' : 'chapters'}/${id}`;
    const hostTitle = container === 'book' ? book.title : chapter.title;
    const projectId = insertProject(db, `Hosted ${container} project`);
    const assetId = insertAsset(db, projectId, 'hosted-missing.png');
    markAssetMissing(db, assetId);
    archiveProject(db, projectId);

    const host = await agent.get(hostUrl).expect(200);
    expectNewNoteDialog(host.text, false);
    expect(host.text).toContain(`href="/notes/new?${containerKey}=${id}" data-dialog-open="note-create-dialog"`);
    const direct = await agent.get('/notes/new').query({ [containerKey]: id }).expect(200);
    expect(direct.headers.location).toBeUndefined();
    expectNewNoteDialog(direct.text, true);
    expect(direct.text).toContain(`<h1 class="app-section-title">Notes — ${hostTitle}</h1>`);

    const failed = await agent.post('/notes').type('form').send({
      _csrf: csrfToken, [containerKey]: String(id), title: ' ', content: '**Keep my draft**',
      projectIds: [String(projectId)], assetIds: [String(assetId)],
    }).expect(422);
    const dialog = expectNewNoteDialog(failed.text, true);
    expect(failed.text).toContain(`<h1 class="app-section-title">Notes — ${hostTitle}</h1>`);
    expect(dialog).toContain(`name="${containerKey}" value="${id}"`);
    expect(dialog).toContain('value=" "');
    expect(dialog).toContain('>**Keep my draft**</textarea>');
    expect(dialog).toContain('Title is required.');
    expect(dialog).toMatch(new RegExp(`name="projectIds\\[\\]"[^>]*value="${projectId}"[^>]*checked`));
    expect(dialog).toMatch(new RegExp(`name="assetIds\\[\\]"[^>]*value="${assetId}"[^>]*checked`));
    expect(dialog).toContain('Archived project');
    expect(dialog).toContain('(Missing)');
    expect(dialog).toContain(book.title);
    expect(dialog).toContain(chapter.title);
    const otherDialogs = [...failed.text.matchAll(/<dialog\b[^>]*>/g)]
      .map(([tag]) => tag).filter((tag) => !tag.includes('id="note-create-dialog"'));
    expect(otherDialogs.length).toBeGreaterThan(0);
    for (const tag of otherDialogs) expect(tag).not.toMatch(/\sopen(?:\s|>)/);
  });

  it('GET /notes/new renders the Chapter-scoped form contract and one CSRF field', async () => {
    const { book, chapter } = createChapterContext(app);
    const response = await agent.get('/notes/new').query({ chapterId: chapter.id }).expect(200);

    expectNewNoteDialog(response.text, true);
    expect(response.text).toContain(`<h1 class="app-section-title">Notes — ${chapter.title}</h1>`);
    expect(response.text).toContain('<header class="page-heading">');
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="note-form" data-dialog-submit>Create</button>');
    expect(response.text).toContain('data-dialog-close aria-label="Close New Page"');
    expect(response.text).toContain('<form id="note-form" method="post" action="/notes"');
    expect(response.text).toContain(`<input type="hidden" name="chapterId" value="${chapter.id}">`);
    expect(response.text).toContain('<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded" aria-label="Book contents">');
    expect(response.text).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(getNewNoteDialog(response.text)).not.toContain('>View Chapter</a>');
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
    expect(response.text).toContain('<label for="note-create-title">Page title');
    expect(response.text).toContain('<input type="text" id="note-create-title" name="title"');
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
    expect(response.text).toContain('data-note-assets hidden');
    expect(response.text).toContain('data-note-connections');
    expect(response.text).toContain('data-assets-url="/notes/asset-picker/assets"');
    expect(response.text).toContain('data-cc-dropdown-search');
    expect(response.text).not.toContain('data-notes-asset-picker');
    expect(response.text).not.toContain('Add assets');
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

    expectNewNoteDialog(response.text, true);
    expect(response.text).toContain('data-dialog-close aria-label="Close New Page"');
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
    expect(response.text).toContain('data-note-connections');
    expect(response.text).toContain('id="note-projects-form-search"');
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

  it('renders only selected active Project catalogues, retaining independent archived associations on 422', async () => {
    const { chapter } = createChapterContext(app);
    const a = insertProject(db, 'Context A');
    const b = insertProject(db, 'Context B');
    const archived = insertProject(db, 'Archived context');
    const unrelated = insertProject(db, 'Unrelated context');
    const aId = insertAsset(db, a, 'a-choice.png');
    insertAsset(db, b, 'b-choice.png');
    const retainedId = insertAsset(db, archived, 'retained-missing.png');
    insertAsset(db, archived, 'archived-unselected.png');
    insertAsset(db, unrelated, 'unrelated-choice.png');
    archiveProject(db, archived); markAssetMissing(db, retainedId);
    db.prepare(`INSERT INTO managed_assets (id, storage_key, namespace, mime_type, size_bytes, width, height, sha256)
      VALUES ('managed-cover', 'private-cover.png', 'book-covers', 'image/png', 1, 1, 1, ?)`).run('a'.repeat(64));
    for (const projectIds of [[a], [b], [a, b]]) {
      const response = await agent.post('/notes').type('form').send({
        _csrf: csrfToken, chapterId: chapter.id, title: '', projectIds,
        assetIds: [aId, retainedId],
      }).expect(422);
      const dialog = getNewNoteDialog(response.text);
      const choices = dialog.match(/<select id="note-assets-native"[\s\S]*?<\/select>/)[0];
      expect(choices.includes('a-choice.png')).toBe(projectIds.includes(a));
      expect(choices.includes('b-choice.png')).toBe(projectIds.includes(b));
      expect(dialog).toContain('<div data-note-assets>');
      expect(dialog).toContain('retained-missing.png — Project: Archived context (Archived project) (Missing)');
      expect(dialog).not.toContain('archived-unselected.png');
      expect(dialog).not.toContain('unrelated-choice.png');
      expect(dialog).not.toContain('private-cover.png');
      expect(dialog).not.toContain('managed-cover');
      expect(dialog).not.toContain('Add assets');
      expect(dialog).not.toContain('data-notes-asset-picker');
      expect(dialog).toContain('data-cc-dropdown-option-list role="group"');
      expect(choices).toContain('data-project-key="project:' + projectIds[0] + '"');
    }
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
    expect(response.text).toContain('data-note-assets hidden');
    expect(response.text).not.toMatch(/<li class="notes-selected-asset"/);
    expect(response.text).not.toContain('note-asset-picker-project-results');
    expect(response.text).not.toContain('note-asset-picker-asset-results');
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
      if (renderLocals.noteCreateDialogOpen) createLocals = renderLocals.noteCreateForm;
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

    const contextRail = response.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
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
    expect(navigator).not.toContain('>View Chapter</a>');
    expect(navigator).not.toMatch(/<a class="notes-book-nav-page-link" href="\/notes\/\d+"[^>]*aria-current="page"/);
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
    expect(getNewNoteDialog(response.text)).not.toContain('<nav class="notes-page-nav"');
    expect(response.text).toContain(`<input type="hidden" name="chapterId" value="${chapter.id}">`);
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="note-form" data-dialog-submit>Create</button>');
    expect(response.text).toContain('>Connections</h3>');
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
      if (renderLocals.noteCreateDialogOpen) createLocals = renderLocals.noteCreateForm;
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

    const contextRail = response.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
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
    expect(getNewNoteDialog(response.text)).not.toContain('<nav class="notes-page-nav"');
    expect(response.text).toContain(`<input type="hidden" name="bookId" value="${book.id}">`);
    expect(response.text).not.toContain('name="chapterId"');
  });

  it('GET /notes/new renders an empty Book navigator without the sibling Page nav', async () => {
    const { chapter } = createChapterContext(app);
    const directBook = app.locals.bookService.createBook({ title: 'Empty Direct Book' });

    const chapterResponse = await agent.get('/notes/new').query({ chapterId: chapter.id }).expect(200);
    const chapterRail = chapterResponse.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
    expect(chapterRail).toContain('<nav class="notes-book-nav"');
    expect(chapterRail).not.toContain('<nav class="notes-page-nav"');

    const bookResponse = await agent.get('/notes/new').query({ bookId: directBook.id }).expect(200);
    const bookRail = bookResponse.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
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

  describe('Connections Asset thumbnail model (Package 3A)', () => {
    function captureForms() {
      const forms = [];
      const original = app.response.render;
      const spy = vi.spyOn(app.response, 'render').mockImplementation(function(view, locals, callback) {
        const form = locals.noteEditForm || locals.noteCreateForm;
        if (form) forms.push(form);
        return original.call(this, view, locals, callback);
      });
      return { forms, restore: () => spy.mockRestore() };
    }

    function thumbnailFor(id, nsfwBlur = false) {
      const preview = buildAssetPreviewModel(app.locals.assetScanner.repository.findByIds([id])[0]);
      return { state: preview.state, sourceMetadataValid: preview.sourceMetadataValid,
        urls: { thumbnail: preview.urls.thumbnail }, nsfwBlur };
    }

    it.each(['book', 'chapter'])('enriches %s New/422 and Edit/422 models without changing selection', async container => {
      const { book, chapter } = createChapterContext(app);
      const projectId = insertProject(db, 'Thumbnail context');
      const direct = insertAsset(db, projectId, 'a-direct.png');
      const missing = insertAsset(db, projectId, 'b-missing.png');
      const unsupported = insertAsset(db, projectId, 'c-unsupported.txt', { extension: 'txt', mimeType: 'text/plain' });
      const incomplete = insertAsset(db, projectId, 'd-incomplete.png');
      const retained = insertAsset(db, insertProject(db, 'Outside context'), 'retained.png');
      markAssetMissing(db, missing);
      markAssetMissing(db, retained);
      db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', direct);
      const expected = new Map([direct, missing, unsupported, incomplete, retained].map(id => [String(id), thumbnailFor(id)]));
      const capture = captureForms();
      const repository = app.locals.assetScanner.repository;
      const batch = vi.spyOn(repository, 'findByIds');
      try {
        const context = { [container + 'Id']: container === 'book' ? book.id : chapter.id };
        await agent.get('/notes/new').query(context).expect(200);
        expect(capture.forms.at(-1).connections.assets).toEqual([]);
        expect(batch).not.toHaveBeenCalled();
        const body = { _csrf: csrfToken, ...context, title: ' ', projectIds: [projectId], assetIds: [direct, retained] };
        await agent.post('/notes').type('form').send(body).expect(422);
        const check = form => {
          expect(form.connections.assets.map(option => option.value)).toEqual([direct, missing, unsupported, incomplete].map(String));
          expect(form.connections.retained.map(option => option.value)).toEqual([String(retained)]);
          for (const option of [...form.connections.assets, ...form.connections.retained]) {
            expect(option.thumbnail).toEqual(expected.get(option.value));
            expect(option.selected).toBe([direct, retained].map(String).includes(option.value));
          }
          expect(form.connections.assets[0].thumbnail.urls.thumbnail).toEqual(expect.any(String));
          expect(form.connections.assets[2].thumbnail.state).toBe('unsupported');
          expect(form.connections.assets[3].thumbnail).toMatchObject({ state: 'previewable', sourceMetadataValid: false, urls: { thumbnail: null } });
        };
        check(capture.forms.at(-1));
        expect(batch).toHaveBeenCalledTimes(1);
        expect(batch).toHaveBeenLastCalledWith([direct, missing, unsupported, incomplete, retained]);
        const note = app.locals.noteService.createNote({ ...context, title: 'Saved', projectIds: [projectId], assetIds: [direct, retained] });
        await agent.get('/notes/' + note.id + '/edit').expect(200);
        check(capture.forms.at(-1));
        await agent.post('/notes/' + note.id).type('form').send(body).expect(422);
        check(capture.forms.at(-1));
        expect(batch).toHaveBeenCalledTimes(3);
        batch.mockReturnValueOnce([]);
        await agent.get('/notes/' + note.id + '/edit').expect(200);
        const unavailable = capture.forms.at(-1).connections;
        expect(unavailable.assets.map(option => option.value)).toEqual([direct, missing, unsupported, incomplete].map(String));
        expect(unavailable.retained[0]).toMatchObject({
          value: String(retained), selected: true,
          thumbnail: { state: 'missing', sourceMetadataValid: false, urls: { thumbnail: null }, nsfwBlur: false },
        });
        expect(unavailable.assets[0].selected).toBe(true);
      } finally { batch.mockRestore(); capture.restore(); }
    });

    it.each(['asset', 'project', 'disabled'])('shares %s NSFW presentation between forms and dynamic picker', async policy => {
      const projectId = insertProject(db, 'NSFW option');
      const id = insertAsset(db, projectId);
      db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id);
      const tag = app.locals.tagService.createTag({ name: 'NSFW' });
      app.locals.assetTagService.replaceAssetTags(id, policy === 'asset' || policy === 'disabled' ? [tag.id] : []);
      app.locals.projectTagService.replaceProjectTags(projectId, policy !== 'asset' ? [tag.id] : []);
      app.locals.nsfwFilterSettingsService.setEnabled(policy !== 'disabled');
      const { note } = createPage(app, { title: 'Tagged', projectIds: [projectId], assetIds: [id] });
      const capture = captureForms();
      try {
        await agent.get('/notes/' + note.id + '/edit').expect(200);
        const response = await agent.get('/notes/asset-picker/assets').query({ projectId }).expect(200);
        expect(response.body.items[0].thumbnail).toEqual(thumbnailFor(id, policy !== 'disabled'));
        expect(capture.forms.at(-1).connections.assets[0].thumbnail).toEqual(response.body.items[0].thumbnail);
      } finally { capture.restore(); }
    });

    it('batch-resolves only each picker page and preserves rows when full metadata is unavailable', async () => {
      const projectId = insertProject(db, 'Batch options');
      const ids = Array.from({ length: 26 }, (_, i) => insertAsset(db, projectId, 'asset-' + String(i).padStart(2, '0') + '.png'));
      const batch = vi.spyOn(app.locals.assetScanner.repository, 'findByIds').mockReturnValue([]);
      try {
        const first = await agent.get('/notes/asset-picker/assets').query({ projectId }).expect(200);
        expect(batch).toHaveBeenCalledExactlyOnceWith(ids.slice(0, 25));
        expect(first.body.items).toHaveLength(25);
        expect(first.body.items.every(item => item.thumbnail.state === 'missing' && item.thumbnail.urls.thumbnail === null)).toBe(true);
        const second = await agent.get('/notes/asset-picker/assets').query({ projectId, cursor: first.body.nextCursor }).expect(200);
        expect(batch).toHaveBeenCalledTimes(2);
        expect(batch).toHaveBeenLastCalledWith(ids.slice(25));
        expect(second.body.items.map(item => item.id)).toEqual(ids.slice(25));
        expect(second.body.nextCursor).toBeNull();
      } finally { batch.mockRestore(); }
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
        { id: matchingId, filename: 'alpha-file.png', relativePath: 'source/alpha-file.png', isPresent: true, thumbnail: { state: 'previewable', sourceMetadataValid: false, urls: { thumbnail: null }, nsfwBlur: false } },
        { id: missingId, filename: 'alpha-missing.bin', relativePath: 'alpha-missing.bin', isPresent: false, thumbnail: { state: 'missing', sourceMetadataValid: false, urls: { thumbnail: null }, nsfwBlur: false } },
      ]);
      expect(response.body.items.map((item) => Object.keys(item).sort())).toEqual([
        ['filename', 'id', 'isPresent', 'relativePath', 'thumbnail'],
        ['filename', 'id', 'isPresent', 'relativePath', 'thumbnail'],
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
    expect(response.text).toContain('Project: Validation Asset First');
    expect(response.text).toContain('Project: Validation Asset Second');
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

    const contextRail = response.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(navigator).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directBookPage.id}">Direct Failed Create Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${unrelatedPage.id}">Unrelated Failed Create Page</a>`);
    expect(navigator.indexOf('Direct Failed Create Page')).toBeLessThan(navigator.indexOf('Page Chapter'));
    expect(navigator.indexOf('Page Chapter')).toBeLessThan(navigator.indexOf('Unrelated Failed Create Chapter'));
    expect(navigator.indexOf('Second Existing Chapter Page')).toBeLessThan(navigator.indexOf('First Existing Chapter Page'));
    expect(navigator).not.toContain('>View Chapter</a>');
    expect(navigator).not.toMatch(/<a class="notes-book-nav-page-link" href="\/notes\/\d+"[^>]*aria-current="page"/);
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
    expect(getNewNoteDialog(response.text)).not.toContain('<nav class="notes-page-nav"');
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
    expect(response.text).toContain('aria-describedby="note-create-title-error"');
    expect(response.text).toContain(attemptedContent);
    expect(getNoteDialogBaseline(getNewNoteDialog(response.text))).toMatchObject({
      title: '', content: '', projectIds: [], assetIds: [],
    });
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
    expect(response.text).toContain('data-dialog-close aria-label="Close New Page"');
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
    const contextRail = response.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(navigator).toContain(`<nav class="notes-book-nav" aria-label="Contents of ${book.title}">`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directPage.id}">Direct Validation Existing Page</a>`);
    expect(navigator).not.toContain('>View Chapter</a>');
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${nestedPage.id}">Direct Validation Nested Page</a>`);
    expect(navigator.indexOf('Direct Validation Existing Page')).toBeLessThan(navigator.indexOf('Direct Validation Chapter'));
    expect(navigator).not.toContain('aria-current="page"');
    expect(navigator).not.toContain(' open>');
    expect(getNewNoteDialog(response.text)).not.toContain('<nav class="notes-page-nav"');
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

    expectEditNoteDialog(response.text, note.id, false);
    expect(response.text).toContain('<title>CreatorCrate — Notes — Page — Detail Note</title>');
    expect(response.text).toContain('<body class="notes-page-detail-page">');
    expect(response.text).toContain('<h1 class="app-section-title">Notes — Page — Detail Note</h1>');
    expect(response.text.match(/<h1 class="app-section-title">/g)).toHaveLength(1);
    expect(response.text).toContain(`<a class="button button-primary" href="/notes/${note.id}/edit" data-dialog-open="note-edit-dialog">Edit Page</a>`);
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('notes-hierarchy');
    expect(response.text).toContain('<div class="notes-page-detail-layout">');
    const polishedSidebar = response.text.match(/<aside class="notes-page-detail-sidebar notes-book-detail-sidebar[^"]*">[\s\S]*?<\/aside>/)?.[0] || '';
    expect(polishedSidebar).not.toBe('');
    expect(polishedSidebar).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(polishedSidebar).not.toContain('View Chapter');
    expect(polishedSidebar).toContain(`<a class="notes-book-nav-page-link" href="/notes/${note.id}" aria-current="page">Detail Note</a>`);
    expect(polishedSidebar).toContain('<details class="notes-book-nav-disclosure" open>');
    expect(getEditNoteDialog(response.text)).not.toContain('>View Chapter</a>');
    expect(getNewNoteDialog(response.text)).not.toContain('<nav class="notes-page-nav"');
    expect(response.text.replace(getEditNoteDialog(response.text), '')).not.toContain(`/notes/${note.id}/move`);
    expect(response.text.replace(getEditNoteDialog(response.text), '')).not.toContain('Move Page');
    expect(response.text).not.toContain('Danger zone');
    expect(response.text.replace(getEditNoteDialog(response.text), '')).not.toContain(`/notes/${note.id}/delete`);
    expect(response.text).not.toContain('>Delete Note</button>');
    expect(response.text).toContain('&lt;script&gt;alert(');
    expect(response.text).not.toContain('<script>alert');
    expect(response.text).toContain('<h1>Markdown <strong>text</strong></h1>');
    expect(response.text).toContain('<p>line two</p>');
    expect(response.text).toContain('<section class="project-detail-info project-detail-section notes-detail-details" aria-labelledby="notes-detail-details-heading">');
    expect(response.text).toContain('<h2 id="notes-detail-details-heading">Details</h2>');
    expect(response.text).toContain('<div class="project-detail-section-body">');
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
    expect(response.text).toContain('<section class="notes-detail-content" aria-labelledby="notes-detail-content-heading">');
    expect(response.text).toContain('<div class="notes-detail-section-heading">');
    expect(response.text).toContain('<p class="notes-detail-kicker notes-detail-content-heading" id="notes-detail-content-heading">Detail Note</p>');
    expect(response.text).not.toContain('aria-label="Page contents"');
    expect(response.text).not.toContain('>Reading view<');
    expect(response.text).not.toContain('<h2 id="notes-detail-content-heading">Content</h2>');
    expect(response.text).not.toContain('class="notes-detail-layout"');
    expect(response.text).not.toContain('class="notes-detail-reading"');
    expect(response.text).not.toContain('class="notes-detail-sidebar"');
    expect(response.text).toContain('notes-detail-details');
    expect(response.text).not.toContain('<h2>Projects</h2>');
    expect(response.text).not.toContain('<h2>Assets</h2>');
    expect(response.text.replace(getEditNoteDialog(response.text), '')).not.toContain('data-notes-editor-form');
    expect(response.text).not.toContain('/vendor/toast-ui/editor/');

    const css = await agent.get('/creatorcrate.css').expect(200);
    expect(css.text).toContain('.notes-content');
    expect(css.text).toContain('.notes-content pre');
    expect(css.text).toContain('.notes-content table');

    const bookDetail = await agent.get(`/notes/books/${book.id}`).expect(200);
    expect(bookDetail.text).toContain('<section class="notes-detail-panel notes-detail-details" aria-labelledby="notes-book-details-heading">');
    expect(bookDetail.text).not.toContain('<section class="project-detail-info project-detail-section notes-detail-details"');
  });

  it('creates, grows, renders, and prunes Revision history through the production HTTP path', async () => {
    const { book, chapter } = createChapterContext(app);
    const created = await agent.post('/notes').type('form').send({
      _csrf: csrfToken,
      chapterId: String(chapter.id),
      title: 'Revision zero',
      content: 'Zero',
    }).expect(302);
    const noteId = Number(created.headers.location.replace('/notes/', ''));
    const empty = await agent.get(`/notes/${noteId}`).expect(200);
    const emptySidebar = empty.text.slice(
      empty.text.indexOf('<div class="notes-page-sidebar">'),
      empty.text.indexOf('<div class="notes-page-detail-content">'),
    );
    const emptyHistory = emptySidebar.match(/<section class="[^"]*notes-revision-history[^"]*"[\s\S]*?<\/section>/)?.[0] || '';

    expect(emptySidebar.indexOf('notes-detail-details')).toBeLessThan(emptySidebar.indexOf('notes-revision-history'));
    expect(emptyHistory).toContain('<h2 id="notes-revision-history-heading">Revision history</h2>');
    expect(emptyHistory).toContain('No revisions yet. Previous versions will appear here after this Page is edited.');
    expect(emptyHistory).not.toContain('<details');

    await agent.post(`/notes/${noteId}`).type('form').send({
      _csrf: csrfToken,
      title: 'Revision one',
      content: 'One',
    }).expect(302);
    const firstRevisions = app.locals.noteService.listNoteRevisions(noteId);
    expect(firstRevisions).toHaveLength(1);

    const firstPopulated = await agent.get(`/notes/${noteId}`).expect(200);
    const firstHistory = firstPopulated.text.match(/<section class="[^"]*notes-revision-history[^"]*"[\s\S]*?<\/section>/)?.[0] || '';
    expect(firstHistory).toContain('<details class="notes-book-contents-disclosure">');
    expect(firstHistory).not.toContain('<details class="notes-book-contents-disclosure" open>');
    expect(firstHistory).toContain('<summary class="notes-book-contents-toggle">');
    expect(firstHistory).toContain(`href="/notes/${noteId}/revisions/${firstRevisions[0].id}">View</a>`);
    expect(firstHistory).not.toContain('No revisions yet.');

    await agent.post(`/notes/${noteId}`).type('form').send({
      _csrf: csrfToken,
      title: 'Revision two',
      content: 'Two',
    }).expect(302);
    const revisions = app.locals.noteService.listNoteRevisions(noteId);
    const populated = await agent.get(`/notes/${noteId}`).expect(200);
    const populatedSidebar = populated.text.slice(
      populated.text.indexOf('<div class="notes-page-sidebar">'),
      populated.text.indexOf('<div class="notes-page-detail-content">'),
    );

    expect(revisions).toHaveLength(2);
    expect(populatedSidebar.indexOf(`/notes/${noteId}/revisions/${revisions[0].id}`))
      .toBeLessThan(populatedSidebar.indexOf(`/notes/${noteId}/revisions/${revisions[1].id}`));
    expect(populatedSidebar).not.toContain('Revision zero');
    expect(populatedSidebar).not.toContain('Revision one');
    expect(populated.text).toContain('id="notes-detail-content-heading">Revision two</p>');

    app.locals.noteRevisionSettingsService.setRevisionRetention(1);
    await agent.post(`/notes/${noteId}`).type('form').send({
      _csrf: csrfToken,
      title: 'Revision three',
      content: 'Three',
    }).expect(302);
    const prunedRevisions = app.locals.noteService.listNoteRevisions(noteId);
    expect(prunedRevisions).toHaveLength(1);
    expect(prunedRevisions[0].id).not.toBe(revisions[0].id);
    const pruned = await agent.get(`/notes/${noteId}`).expect(200);
    expect(pruned.text).toContain(`/notes/${noteId}/revisions/${prunedRevisions[0].id}`);
    expect(pruned.text).not.toContain(`/notes/${noteId}/revisions/${revisions[0].id}`);

    const bookDetail = await agent.get(`/notes/books/${book.id}`).expect(200);
    expect(bookDetail.text).not.toContain('notes-revision-history');
  });

  it('renders a scoped historical revision through the current sanitized Markdown path', async () => {
    const availableProjectId = insertProject(db, 'Available historical project');
    const deletedProjectId = insertProject(db, 'Deleted historical project');
    const availableAssetId = insertAsset(db, availableProjectId, 'available-history.png');
    const deletedAssetId = insertAsset(db, availableProjectId, 'deleted-history.png');
    const { note } = createPage(app, {
      title: 'Historical title',
      content: '# Historical title\n\n<script>alert("unsafe")</script>\n\n**Historical body**',
      projectIds: [availableProjectId, deletedProjectId],
      assetIds: [availableAssetId, deletedAssetId],
    });
    app.locals.noteService.updateNote(note.id, {
      title: 'Current title', content: 'Current body', projectIds: [], assetIds: [],
    });
    const [revision] = app.locals.noteService.listNoteRevisions(note.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(deletedProjectId);
    db.prepare('DELETE FROM assets WHERE id = ?').run(deletedAssetId);

    const response = await agent.get(`/notes/${note.id}/revisions/${revision.id}`).expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes — Older revision — Historical title</title>');
    expect(response.text).toContain('<strong>Older revision.</strong> You are viewing historical Page content, not the current Page.');
    expect(response.text).toContain(`href="/notes/${note.id}">Back to current Page</a>`);
    expect(response.text).not.toContain('Edit Page');
    expect(response.text).toContain('<p><strong>Historical body</strong></p>');
    expect(response.text).toContain('&lt;script&gt;alert(');
    expect(response.text).not.toContain('<script>alert');
    expect(response.text).not.toContain('<h1>Historical title</h1>');
    expect(response.text).toContain(`href="/projects/${availableProjectId}">Available historical project</a>`);
    expect(response.text).toContain(`Project ${deletedProjectId} — Unavailable`);
    expect(response.text).toContain(`href="/projects/${availableProjectId}/assets/${availableAssetId}">available-history.png</a>`);
    expect(response.text).toContain(`Asset ${deletedAssetId} — Unavailable`);
    expect(response.text).toContain(`action="/notes/${note.id}/revisions/${revision.id}/restore"`);
    expect(response.text).toContain('name="_csrf"');
    expect(response.text).toContain('data-confirm-dialog-title="Restore revision?"');
    expect(response.text).toContain('data-confirm-dialog-confirm-label="Restore"');
  });

  it('returns 404 for malformed, missing, and cross-Page historical revision access', async () => {
    const first = createPage(app, { title: 'First history Page', content: 'First before' }).note;
    const second = createPage(app, { title: 'Second history Page', content: 'Second before' }).note;
    app.locals.noteService.updateNote(first.id, { title: 'First current', content: 'First current' });
    const [revision] = app.locals.noteService.listNoteRevisions(first.id);

    await agent.get(`/notes/${first.id}/revisions/01`).expect(404);
    await agent.get(`/notes/${first.id}/revisions/999999`).expect(404);
    await agent.get(`/notes/${second.id}/revisions/${revision.id}`).expect(404);
    await agent.get(`/notes/01/revisions/${revision.id}`).expect(404);
  });

  it('fails safely for malformed historical data without exposing payloads or changing the current Page', async () => {
    const { note } = createPage(app, { title: 'Malformed before', content: 'Before' });
    app.locals.noteService.updateNote(note.id, { title: 'Malformed current', content: 'Current' });
    const [revision] = app.locals.noteService.listNoteRevisions(note.id);
    const currentBefore = db.prepare('SELECT title, content FROM notes WHERE id = ?').get(note.id);
    const historyCountBefore = db.prepare('SELECT COUNT(*) AS count FROM note_revisions WHERE note_id = ?').get(note.id).count;
    db.prepare("UPDATE note_revisions SET project_ids_json = '{malformed' WHERE id = ?").run(revision.id);

    const view = await agent.get(`/notes/${note.id}/revisions/${revision.id}`).expect(500);
    const restore = await agent.post(`/notes/${note.id}/revisions/${revision.id}/restore`).type('form')
      .send({ _csrf: csrfToken }).expect(500);

    expect(view.text).not.toContain('{malformed');
    expect(restore.text).not.toContain('{malformed');
    expect(db.prepare('SELECT title, content FROM notes WHERE id = ?').get(note.id)).toEqual(currentBefore);
    expect(db.prepare('SELECT COUNT(*) AS count FROM note_revisions WHERE note_id = ?').get(note.id).count)
      .toBe(historyCountBefore);
  });

  it('restores through the service, redirects to current Page, and remains CSRF- and Note-scoped', async () => {
    const first = createPage(app, { title: 'Restore before', content: 'Before body' }).note;
    const second = createPage(app, { title: 'Other Page', content: 'Other body' }).note;
    app.locals.noteService.updateNote(first.id, { title: 'Restore current', content: 'Current body' });
    const [revision] = app.locals.noteService.listNoteRevisions(first.id);
    const restore = vi.spyOn(app.locals.noteService, 'restoreNoteRevision');

    await agent.post(`/notes/${first.id}/revisions/${revision.id}/restore`).type('form').send({}).expect(403);
    await agent.post(`/notes/${second.id}/revisions/${revision.id}/restore`).type('form')
      .send({ _csrf: csrfToken }).expect(404);
    const response = await agent.post(`/notes/${first.id}/revisions/${revision.id}/restore`).type('form')
      .send({ _csrf: csrfToken }).expect(302);

    expect(response.headers.location).toBe(`/notes/${first.id}`);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenLastCalledWith(first.id, revision.id);
    expect(app.locals.noteService.getNote(first.id)).toMatchObject({
      title: 'Restore before', content: 'Before body',
    });
  });

  it('renders an actionable restore error and preserves current state/history when historical associations are unavailable', async () => {
    const projectId = insertProject(db, 'Unavailable restore project');
    const assetId = insertAsset(db, projectId, 'unavailable-restore.png');
    const { note } = createPage(app, {
      title: 'Blocked before', content: 'Blocked before body', projectIds: [projectId], assetIds: [assetId],
    });
    app.locals.noteService.updateNote(note.id, {
      title: 'Blocked current', content: 'Blocked current body', projectIds: [], assetIds: [],
    });
    const [revision] = app.locals.noteService.listNoteRevisions(note.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    const before = app.locals.noteService.getNote(note.id);
    const historyBefore = app.locals.noteService.listNoteRevisions(note.id);

    const response = await agent.post(`/notes/${note.id}/revisions/${revision.id}/restore`).type('form')
      .send({ _csrf: csrfToken }).expect(409);

    expect(response.text).toContain('This revision cannot be restored because one or more linked Projects or Assets are unavailable. The current Page was not changed.');
    expect(response.text).toContain(`Project ${projectId} — Unavailable`);
    expect(response.text).toContain(`Asset ${assetId} — Unavailable`);
    expect(app.locals.noteService.getNote(note.id)).toEqual(before);
    expect(app.locals.noteService.listNoteRevisions(note.id)).toEqual(historyBefore);
  });

  it('suppresses a matching leading Markdown H1 only in Page detail while preserving Edit source', async () => {
    const title = 'Benji reference sheet [run15]';
    const content = `# ${title}\n\nBody remains.\n\n# Later heading`;
    const { note } = createPage(app, { title, content });

    for (const url of [`/notes/${note.id}`, `/notes/${note.id}/edit`]) {
      const response = await agent.get(url).expect(200);
      const renderedContent = response.text.match(/<div class="notes-content">([\s\S]*?)<\/div>/)?.[1] || '';
      expect(renderedContent).not.toContain(`<h1>${title}</h1>`);
      expect(renderedContent).toContain('<p>Body remains.</p>');
      expect(renderedContent).toContain('<h1>Later heading</h1>');
      expect(getEditNoteDialog(response.text)).toContain(content);
      expect(response.text).toContain(`id="notes-detail-content-heading">${title}</p>`);
    }

    const validationResponse = await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: '', content: `# ${title}\n\nAttempted edit` })
      .expect(422);
    const validationContent = validationResponse.text.match(/<div class="notes-content">([\s\S]*?)<\/div>/)?.[1] || '';
    expect(validationContent).not.toContain(`<h1>${title}</h1>`);
    expect(validationContent).toContain('<p>Body remains.</p>');
    expect(getEditNoteDialog(validationResponse.text)).toContain(`# ${title}\n\nAttempted edit`);
    expect(app.locals.noteService.getNote(note.id).content).toBe(content);
  });

  it.each([
    ['Page Title', '# Page   Title', false],
    ['FooBar', '# Foo<br>Bar', true],
    ['FooBar', 'Foo\nBar\n====', true],
    ['FooBar', 'Foo  \nBar\n====', true],
  ])('compares leading H1 whitespace through Page detail: %s / %s', async (title, heading, retained) => {
    const content = `${heading}\n\nBody remains.\n\n## Section`;
    const { note } = createPage(app, { title, content });
    const response = await agent.get(`/notes/${note.id}`).expect(200);
    const renderedContent = response.text.match(/<div class="notes-content">([\s\S]*?)<\/div>/)?.[1] || '';
    expect(renderedContent.includes('<h1>')).toBe(retained);
    if (retained) expect(renderedContent).toContain('<h1>Foo<br />\nBar</h1>');
    expect(renderedContent).toContain('<p>Body remains.</p>');
    expect(renderedContent).toContain('<h2>Section</h2>');
    expect(app.locals.noteService.getNote(note.id).content).toBe(content);
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
    expect(navigator).not.toContain('View Chapter');
    expect(navigator.indexOf('Last Chapter Page')).toBeLessThan(navigator.indexOf('First Chapter Page'));
    expect(navigator.indexOf('First Chapter Page')).toBeLessThan(navigator.indexOf('Current Chapter Page'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${second.id}" aria-current="page">Current Chapter Page</a>`);
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
    expect((navigator.match(/aria-current="page"/g) || [])).toHaveLength(1);
    expect(getEditNoteDialog(response.text)).not.toContain('>View Chapter</a>');
    expect(getNewNoteDialog(response.text)).not.toContain('<nav class="notes-page-nav"');
  });

  it('renders stored TOAST UI br syntax without changing the canonical Note source', async () => {
    const source = 'before<br>after';
    const { note } = createPage(app, { title: 'Stored Break Note', content: source });

    const response = await agent.get(`/notes/${note.id}`).expect(200);

    expect(response.text).toContain('<p>before<br />\nafter</p>');
    expect(response.text.replace(getEditNoteDialog(response.text), '')).not.toContain('&lt;br&gt;');
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
    expect(getNewNoteDialog(response.text)).not.toContain('<nav class="notes-page-nav"');
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
    expect(editResponse.text).toContain('<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded" aria-label="Book contents">');
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

  it.each(['book', 'chapter'])('hosts Edit Page for a %s Page with native update and independent associations', async (container) => {
    const { book, chapter } = createChapterContext(app);
    const projectId = insertProject(db, 'Edit hosted project');
    const assetId = insertAsset(db, projectId, 'edit-hosted-missing.png');
    markAssetMissing(db, assetId);
    archiveProject(db, projectId);
    const note = app.locals.noteService.createNote({
      [container + 'Id']: container === 'book' ? book.id : chapter.id,
      title: 'Hosted original', content: '**Original**', projectIds: [projectId], assetIds: [assetId],
    });
    const host = await agent.get('/notes/' + note.id).expect(200);
    expectEditNoteDialog(host.text, note.id, false);
    const direct = await agent.get('/notes/' + note.id + '/edit').expect(200);
    const dialog = expectEditNoteDialog(direct.text, note.id, true);
    expect(direct.headers.location).toBeUndefined();
    expect(dialog).toContain('Archived project');
    expect(dialog).toContain('(Missing)');
    expect(dialog).toContain('name="title" value="Hosted original"');
    expect(dialog).toContain('>**Original**</textarea>');
    expect(dialog).toContain(book.title);
    const moveSelect = dialog.match(/<select\b[^>]*id="note-move-target"[\s\S]*?<\/select>/)?.[0] || '';
    expect(dialog).toContain('id="note-move-dropdown"');
    expect(moveSelect).toContain('data-cc-dropdown-native-select');
    expect(moveSelect).toContain('name="targetContainer"');
    expect(moveSelect).toContain('form="note-move-form"');
    expect(moveSelect).toContain('aria-label="Move Page destination"');
    expect(dialog).toContain('<legend class="sr-only">Move Page destination</legend>');
    const currentTarget = container === 'chapter' ? 'chapter:' + chapter.id : 'book:' + book.id;
    expect(moveSelect.match(/<option\b[^>]* selected[^>]*>/g)).toEqual([
      '<option value="' + currentTarget + '" selected>',
    ]);
    expect(dialog).not.toContain('Current container:');
    expect(dialog).not.toContain('Target container');
    const response = await agent.post('/notes/' + note.id).type('form').send({
      _csrf: csrfToken, title: 'Hosted saved', content: '# Saved source', assetIds: String(assetId),
    }).expect(302);
    expect(response.headers.location).toBe('/notes/' + note.id);
    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      title: 'Hosted saved', content: '# Saved source', projectIds: [], assetIds: [assetId],
      book_id: book.id, chapter_id: container === 'chapter' ? chapter.id : null,
    });
  });

  it('links content and association errors to unique Edit controls while retaining valid selections', async () => {
    const projectId = insertProject(db, 'Error selection');
    const assetId = insertAsset(db, projectId, 'error-selection.png');
    const { note } = createPage(app, { title: 'Stored error context', content: 'Stored body' });
    const failed = await agent.post('/notes/' + note.id).type('form').send({
      _csrf: csrfToken, title: 'Attempted title', content: ['invalid', 'content'],
      projectIds: [String(projectId), 'invalid'], assetIds: [String(assetId), 'invalid'],
    }).expect(422);
    const dialog = expectEditNoteDialog(failed.text, note.id, true);
    expect(dialog).toContain('name="title" value="Attempted title"');
    expect(dialog).toContain('id="content-error">Content must be a string.');
    expect(dialog).toContain('aria-describedby="content-help content-error"');
    expect(dialog).toContain('id="projectIds-error"');
    expect(dialog).toContain('id="assetIds-error"');
    expect(dialog).toContain('aria-describedby="projectIds-error"');
    expect(dialog).toContain('aria-describedby="assetIds-error"');
    expect(dialog).toMatch(new RegExp('name="projectIds\\[\\]"[^>]*value="' + projectId + '"[^>]*checked'));
    expect(dialog).toMatch(new RegExp('id="note-asset-option-' + assetId + '"[^>]*checked'));
    expect(failed.text.replace(dialog, '')).toContain('Stored body');
    expect(app.locals.noteService.getNote(note.id).title).toBe('Stored error context');
  });

  it('GET /notes/:id/edit populates the shared form with existing values', async () => {
    const content = '# Existing\n**bold** & <script>alert("unsafe")</script>';
    const { book, chapter, note } = createPage(app, {
      title: 'Existing Note',
      content,
    });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);

    expect(response.text).toContain(`<title>CreatorCrate — Notes — Page — Existing Note</title>`);
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="note-form" data-dialog-submit>Save</button>');
    expect(response.text).not.toContain('<button class="button button-primary" type="submit" form="note-form">Edit</button>');
    expectEditNoteDialog(response.text, note.id, true);
    expect(response.text).toContain(`<form id="note-form" method="post" action="/notes/${note.id}"`);
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('data-notes-editor-host');
    expect(response.text).toContain('<textarea id="content" name="content" data-notes-editor-source');
    expect(response.text).toContain('value="Existing Note"');
    expect(response.text).toContain('# Existing\n**bold** &amp; &lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;');
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(getEditNoteDialog(response.text)).not.toContain('>View Chapter</a>');
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('Book workspace');
    expect(response.text).not.toContain('>Hierarchy</h2>');
    expect(response.text).not.toContain('Back to Chapter');
    expect(response.text).not.toContain('Back to Book');
    expect(response.text).not.toContain('This Page will belong');
    expect(getEditNoteDialog(response.text)).toContain('<details class="notes-book-nav-disclosure" open>');
    expect(getEditNoteDialog(response.text)).toContain('<span class="notes-book-nav-chapter-title">Page Chapter</span>');
    expect(response.text).not.toContain('name="chapterId"');
    expect(getEditNoteDialog(response.text)).not.toContain('<strong>bold</strong>');
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
    expect(response.text).toMatch(/<select[^>]*name="targetContainer"[^>]*required form="note-move-form"/);
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
      if (view === 'notes/detail.njk' && renderLocals.noteEditDialogOpen) editLocals = renderLocals;
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

    const contextRail = response.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(editLocals.bookContents).toBe(authoritativeContents);
    expect(editLocals.navCurrentPageId).toBe(current.id);
    expect(listBookContentsCalls).toContainEqual([book.id]);
    expect(contextRail).toContain('<nav class="notes-book-nav"');
    expect(navigator).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">${book.title}</a>`);
    expect(navigator.indexOf('Direct Edit Page')).toBeLessThan(navigator.indexOf('Page Chapter'));
    expect(navigator.indexOf('Page Chapter')).toBeLessThan(navigator.indexOf('Unrelated Edit Chapter'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directBookPage.id}">Direct Edit Page</a>`);
    expect(navigator).not.toContain('>View Chapter</a>');
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${current.id}" aria-current="page">Current Edit Page</a>`);
    expect(navigator.indexOf('Last Edit Page')).toBeLessThan(navigator.indexOf('First Edit Page'));
    expect(navigator.indexOf('First Edit Page')).toBeLessThan(navigator.indexOf('Current Edit Page'));
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(contextRail).toContain('<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded" aria-label="Book contents">');
    expect(contextRail).not.toContain('notes-hierarchy');
    expect(contextRail).not.toContain('Book workspace');
    expect(contextRail).not.toContain('Hierarchy');
    expect(contextRail).not.toContain('notes-workspace-back');
    expect(contextRail).not.toContain('notes-workspace-context-note');
    expect(contextRail).not.toContain('Back to Chapter');
    expect(contextRail).not.toContain('Back to Book');
    expect(contextRail).not.toContain('This Page will belong');
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="note-form" data-dialog-submit>Save</button>');
    expectEditNoteDialog(response.text, current.id, true);
    expect(response.text).toContain('>Connections</h3>');
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
    const contextRail = response.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(navigator.indexOf('First Direct Edit Chapter')).toBeLessThan(navigator.indexOf('Current Direct Edit Page'));
    expect(navigator.indexOf('Current Direct Edit Page')).toBeLessThan(navigator.indexOf('Second Direct Edit Chapter'));
    expect(navigator.indexOf('Second Direct Edit Chapter')).toBeLessThan(navigator.indexOf('Last Direct Edit Page'));
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${current.id}" aria-current="page">Current Direct Edit Page</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${last.id}">Last Direct Edit Page</a>`);
    expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(0);
    expect((navigator.match(/aria-current="page"/g) || [])).toHaveLength(1);
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(contextRail).toContain('<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded" aria-label="Book contents">');
    expect(contextRail).not.toContain('notes-hierarchy');
    expect(contextRail).not.toContain('Book workspace');
    expect(contextRail).not.toContain('Hierarchy');
    expect(contextRail).not.toContain('notes-workspace-back');
    expect(contextRail).not.toContain('notes-workspace-context-note');
    expect(contextRail).not.toContain('Back to Book');
    expect(contextRail).not.toContain('Back to Chapter');
    expect(contextRail).not.toContain('This Page will belong');
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('>Connections</h3>');
    expect(response.text).toContain('>Move Page</summary>');
    expect(response.text).toContain('>Delete Page</summary>');
  });

  it('GET /notes/:id/edit keeps the Book navigator for a sole Page', async () => {
    const { book, chapter, note } = createPage(app, { title: 'Sole Edit Page' });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);
    const contextRail = response.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';

    expect(navigator).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(navigator).not.toContain('>View Chapter</a>');
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${note.id}" aria-current="page">Sole Edit Page</a>`);
    expect(navigator).toContain('<details class="notes-book-nav-disclosure" open>');
    expect(response.text).not.toContain('<nav class="notes-page-nav"');
    expect(contextRail).toContain('<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded" aria-label="Book contents">');
    expect(contextRail).not.toContain('notes-hierarchy');
    expect(contextRail).not.toContain('Book workspace');
    expect(contextRail).not.toContain('Hierarchy');
    expect(contextRail).not.toContain('notes-workspace-back');
    expect(contextRail).not.toContain('notes-workspace-context-note');
    expect(contextRail).not.toContain('Back to Chapter');
    expect(contextRail).not.toContain('Back to Book');
    expect(contextRail).not.toContain('This Page will belong');
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('>Connections</h3>');
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
    expect(response.text).toContain('edit-first.txt (source/edit-first.txt) — Project: Edit Asset First Project');
    expect(response.text).toContain('edit-second.bin — Project: Edit Asset Second Project');
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

    expectEditNoteDialog(response.text, note.id, true);
    expect(response.text).toContain('id="note-edit-title" name="title" value=""');
    expect(response.text).toContain('aria-describedby="note-edit-title-error" aria-invalid="true"');
    expect(response.text).toContain('id="note-edit-title-error">Title is required.');
    expect(response.text).toContain('Stored content');
    expect(response.text).toContain(`<form id="note-form" method="post" action="/notes/${note.id}"`);
    expect(response.text).toContain(attemptedContent);
    expect(getNoteDialogBaseline(getEditNoteDialog(response.text))).toMatchObject({
      title: 'Existing', content: 'Stored content', projectIds: [], assetIds: [],
    });
    expect(response.text).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(getEditNoteDialog(response.text)).not.toContain('>View Chapter</a>');
    expect(response.text).not.toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(response.text).not.toContain('Book workspace');
    expect(response.text).not.toContain('>Hierarchy</h2>');
    expect(response.text).not.toContain('Back to Chapter');
    expect(response.text).not.toContain('Back to Book');
    expect(response.text).not.toContain('This Page will belong');
    expect(getEditNoteDialog(response.text)).toContain('<details class="notes-book-nav-disclosure" open>');
    expect(getEditNoteDialog(response.text)).toContain('<span class="notes-book-nav-chapter-title">Page Chapter</span>');
    expect(response.text).not.toContain('name="chapterId"');
    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      title: 'Existing',
      content: 'Stored content',
    });
    expect(app.locals.noteService.getNote(note.id).chapter_id).toBe(chapter.id);
  });

  it('reuses the Book preview cover pipeline for direct and Chapter Page detail render paths', async () => {
    const book = app.locals.bookService.createBook({ title: 'Covered Page Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Covered Chapter' });
    const directPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Covered Page' });
    const chapterPage = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Chapter Covered Page' });
    const projectId = insertProject(db, 'Covered Page Project');
    const assetId = insertAsset(db, projectId, 'page-cover.png');
    db.prepare("UPDATE assets SET modified_at = '2026-09-06 12:00:00' WHERE id = ?").run(assetId);
    const nsfwTag = app.locals.tagService.createTag({ name: 'NSFW' });
    app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
    app.locals.assetTagService.replaceAssetTags(assetId, [nsfwTag.id]);
    app.locals.nsfwFilterSettingsService.setEnabled(true);
    const attachPrimaryImages = vi.spyOn(app.locals.bookPrimaryImageService, 'attachPrimaryImages');

    const responses = [
      await agent.get(`/notes/${directPage.id}`).expect(200),
      await agent.get(`/notes/${chapterPage.id}`).expect(200),
      await agent.get(`/notes/${directPage.id}/edit`).expect(200),
      await agent.post(`/notes/${chapterPage.id}`).type('form')
        .send({ _csrf: csrfToken, title: '', content: 'Attempted covered content' }).expect(422),
    ];

    expect(attachPrimaryImages).toHaveBeenCalledTimes(responses.length);
    for (const call of attachPrimaryImages.mock.calls) {
      expect(call[0]).toHaveLength(1);
      expect(call[0][0].id).toBe(book.id);
    }
    for (const response of responses) {
      const cover = response.text.match(/<div class="notes-book-cover[\s\S]*?<\/div>/)?.[0] || '';
      expect(response.text.match(/class="notes-book-cover(?: |")/g)).toHaveLength(1);
      expect(cover).toContain(`href="/notes/books/${book.id}"`);
      expect(cover).toMatch(new RegExp(`src="/projects/${projectId}/assets/${assetId}/preview\\?v=`));
      expect(cover).toContain('asset-image--nsfw-blurred');
      expect(response.text.indexOf(cover)).toBeLessThan(response.text.indexOf('<nav class="notes-book-nav"'));
    }
    expect(getEditNoteDialog(responses[2].text)).toMatch(/<dialog\b[^>]*\sopen(?:\s|>)/);
    expect(responses[3].text).toContain('Attempted covered content');
    expect(responses[3].text).toContain('Title is required.');

    attachPrimaryImages.mockRestore();
  });

  it('renders the existing absent and unavailable Book cover fallbacks on Page detail', async () => {
    const noCoverBook = app.locals.bookService.createBook({ title: 'No Page Cover Book' });
    const noCoverPage = app.locals.noteService.createNote({ bookId: noCoverBook.id, title: 'No Cover Page' });
    const unavailableBook = app.locals.bookService.createBook({ title: 'Unavailable Page Cover Book' });
    const unavailablePage = app.locals.noteService.createNote({ bookId: unavailableBook.id, title: 'Unavailable Cover Page' });
    const projectId = insertProject(db, 'Unavailable Page Cover Project');
    const assetId = insertAsset(db, projectId, 'unavailable-page-cover.png');
    app.locals.bookPrimaryImageService.setPrimaryImage(unavailableBook.id, assetId);
    markAssetMissing(db, assetId);

    const noCover = await agent.get(`/notes/${noCoverPage.id}`).expect(200);
    const unavailable = await agent.get(`/notes/${unavailablePage.id}`).expect(200);
    const noCoverMarkup = noCover.text.match(/<div class="notes-book-cover[\s\S]*?<\/div>/)?.[0] || '';
    const unavailableMarkup = unavailable.text.match(/<div class="notes-book-cover[\s\S]*?<\/div>/)?.[0] || '';

    expect(noCoverMarkup).toContain('data-primary-image-state="none"');
    expect(noCoverMarkup).toContain('>No image</span>');
    expect(noCoverMarkup).not.toContain('<img');
    expect(unavailableMarkup).toContain('data-primary-image-state="unavailable"');
    expect(unavailableMarkup).toContain('>Image unavailable</span>');
    expect(unavailableMarkup).not.toContain('<img');
    expect(unavailableMarkup).not.toContain(`/projects/${projectId}/assets/${assetId}/preview`);
  });

  it('propagates asynchronous Page cover resolution failures through every detail render route', async () => {
    const { note } = createPage(app, { title: 'Cover Resolution Failure Page' });
    const resolutionFailure = vi.spyOn(app.locals.bookPrimaryImageService, 'attachPrimaryImages')
      .mockImplementation(() => { throw new Error('Page cover resolution failed'); });

    await agent.get(`/notes/${note.id}`).expect(500);
    await agent.get(`/notes/${note.id}/edit`).expect(500);
    await agent.post(`/notes/${note.id}`).type('form')
      .send({ _csrf: csrfToken, title: '', content: 'Attempted content' }).expect(500);
    expect(resolutionFailure).toHaveBeenCalledTimes(3);

    resolutionFailure.mockRestore();
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

    expectEditNoteDialog(response.text, note.id, true);
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

    const contextRail = response.text.match(/<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded"[\s\S]*?<\/aside>/)?.[0] || '';
    const navigator = contextRail.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    expect(navigator).toContain(`<a class="notes-book-nav-book-link" href="/notes/books/${book.id}">Page Book</a>`);
    expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${directPage.id}">Direct Edit Peer</a>`);
    expect(navigator).not.toContain('>View Chapter</a>');
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
    expect(getEditNoteDialog(response.text)).not.toContain('>View Chapter</a>');
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
    expect(editResponse.text).toContain('(Missing)');
    expect(editResponse.text).toContain('(Archived project)');
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
    expect(detail.text.replace(getEditNoteDialog(detail.text), '')).not.toContain('>Move Page</button>');

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
    it('decorates the owning Book across every Chapter shell render path', async () => {
      const book = app.locals.bookService.createBook({ title: 'Decorated Chapter Book' });
      const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Decorated Chapter' });
      const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Decorated Page' });
      const second = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Second Decorated Page' });
      const projectId = insertProject(db, 'Decorated Chapter Project');
      const assetId = insertAsset(db, projectId, 'chapter-cover.png');
      db.prepare("UPDATE assets SET modified_at = '2026-09-06 12:00:00' WHERE id = ?").run(assetId);
      const nsfwTag = app.locals.tagService.createTag({ name: 'NSFW' });
      app.locals.bookPrimaryImageService.setPrimaryImage(book.id, assetId);
      app.locals.assetTagService.replaceAssetTags(assetId, [nsfwTag.id]);
      app.locals.nsfwFilterSettingsService.setEnabled(true);
      const attachPrimaryImages = vi.spyOn(app.locals.bookPrimaryImageService, 'attachPrimaryImages');
      const capture = captureChapterDetailLocals(app);
      const responses = [];

      try {
        responses.push(await agent.get(`/notes/chapters/${chapter.id}`).expect(200));
        responses.push(await agent.get(`/notes/chapters/${chapter.id}/edit`).expect(200));
        responses.push(await agent.get(`/notes/chapters/${chapter.id}/notes/order`).expect(200));
        responses.push(await agent.post(`/notes/chapters/${chapter.id}/notes/reorder`).type('form')
          .send({ _csrf: csrfToken, orderedNoteIds: `${first.id},999999` }).expect(422));
        responses.push(await agent.post(`/notes/chapters/${chapter.id}`).type('form')
          .send({ _csrf: csrfToken, title: '' }).expect(422));
        responses.push(await agent.get(`/notes/new?chapterId=${chapter.id}`).expect(200));
      } finally {
        capture.restore();
      }

      expect(attachPrimaryImages).toHaveBeenCalledTimes(6);
      expect(capture.all()).toHaveLength(6);
      for (const [attachedBooks] of attachPrimaryImages.mock.calls) {
        expect(attachedBooks).toHaveLength(1);
        expect(attachedBooks[0].id).toBe(book.id);
      }
      for (const locals of capture.all()) {
        expect(locals.book).toMatchObject({
          id: book.id,
          primaryImage: {
            state: 'available',
            selectedAssetId: assetId,
            selectedSource: { kind: 'project_asset', id: assetId },
          },
          nsfwBlur: true,
        });
        expect(locals.book.primaryImage.previewUrl)
          .toMatch(new RegExp(`^/projects/${projectId}/assets/${assetId}/preview\\?v=`));
        expect(locals.noteCreateForm.book).toBe(locals.book);
        expect(locals.chapterEditForm.book).toBe(locals.book);
      }
      for (const response of responses) {
        expect(response.text).toContain('class="notes-chapter-detail-sidebar notes-book-detail-sidebar notes-surface notes-surface--compact"');
        expect(response.text).toContain(`src="/projects/${projectId}/assets/${assetId}/preview?v=`);
        expect(response.text).toContain('asset-image--nsfw-blurred');
      }
    });

    it('preserves Chapter Book cover fallback and Project NSFW association semantics', async () => {
      const nsfwTag = app.locals.tagService.createTag({ name: 'NSFW' });
      const inheritedBook = app.locals.bookService.createBook({ title: 'Inherited NSFW Chapter Book' });
      const inheritedChapter = app.locals.chapterService.createChapter({ bookId: inheritedBook.id, title: 'Inherited Chapter' });
      const inheritedProjectId = insertProject(db, 'Inherited Chapter Project');
      const inheritedAssetId = insertAsset(db, inheritedProjectId, 'inherited-chapter-cover.png');
      db.prepare("UPDATE assets SET modified_at = '2026-09-06 12:00:00' WHERE id = ?").run(inheritedAssetId);
      app.locals.bookPrimaryImageService.setPrimaryImage(inheritedBook.id, inheritedAssetId);
      app.locals.projectTagService.replaceProjectTags(inheritedProjectId, [nsfwTag.id]);

      const noCoverBook = app.locals.bookService.createBook({ title: 'No Cover Chapter Book' });
      const noCoverChapter = app.locals.chapterService.createChapter({ bookId: noCoverBook.id, title: 'No Cover Chapter' });
      const unavailableBook = app.locals.bookService.createBook({ title: 'Unavailable Chapter Book' });
      const unavailableChapter = app.locals.chapterService.createChapter({ bookId: unavailableBook.id, title: 'Unavailable Chapter' });
      const unavailableProjectId = insertProject(db, 'Unavailable Chapter Project');
      const unavailableAssetId = insertAsset(db, unavailableProjectId, 'unavailable-chapter-cover.png');
      app.locals.bookPrimaryImageService.setPrimaryImage(unavailableBook.id, unavailableAssetId);
      markAssetMissing(db, unavailableAssetId);
      const capture = captureChapterDetailLocals(app);
      const responses = [];

      try {
        app.locals.nsfwFilterSettingsService.setEnabled(true);
        responses.push(await agent.get(`/notes/chapters/${inheritedChapter.id}`).expect(200));
        responses.push(await agent.get(`/notes/chapters/${noCoverChapter.id}`).expect(200));
        responses.push(await agent.get(`/notes/chapters/${unavailableChapter.id}`).expect(200));
        app.locals.nsfwFilterSettingsService.setEnabled(false);
        responses.push(await agent.get(`/notes/chapters/${inheritedChapter.id}`).expect(200));
      } finally {
        capture.restore();
      }

      const [inherited, none, unavailable, disabled] = capture.all().map(({ book: renderedBook }) => renderedBook);
      expect(inherited).toMatchObject({
        primaryImage: { state: 'available', selectedAssetId: inheritedAssetId },
        nsfwBlur: true,
      });
      expect(none.primaryImage).toMatchObject({ state: 'none', selectedAssetId: null });
      expect(none).not.toHaveProperty('nsfwBlur');
      expect(unavailable.primaryImage).toMatchObject({
        state: 'unavailable',
        selectedAssetId: unavailableAssetId,
        thumbnailUrl: null,
        previewUrl: null,
      });
      expect(unavailable).not.toHaveProperty('nsfwBlur');
      expect(disabled).toMatchObject({
        primaryImage: { state: 'available', selectedAssetId: inheritedAssetId },
        nsfwBlur: false,
      });
      expect(responses[0].text).toContain(`src="/projects/${inheritedProjectId}/assets/${inheritedAssetId}/preview`);
      expect(responses[0].text).toContain('asset-image--nsfw-blurred');
      expect(responses[1].text).toContain('data-primary-image-state="none"');
      expect(responses[1].text).toContain('>No image</span>');
      expect(responses[2].text).toContain('data-primary-image-state="unavailable"');
      expect(responses[2].text).toContain('>Image unavailable</span>');
      expect(responses[2].text).not.toContain(`/projects/${unavailableProjectId}/assets/${unavailableAssetId}/preview`);
      expect(responses[3].text).toContain(`src="/projects/${inheritedProjectId}/assets/${inheritedAssetId}/preview`);
      expect(responses[3].text).not.toContain('asset-image--nsfw-blurred');
    });

    it('forwards unexpected Chapter Book decoration failures from every shell caller', async () => {
      const book = app.locals.bookService.createBook({ title: 'Failed Decoration Book' });
      const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Failed Decoration Chapter' });
      const first = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'First Failure Page' });
      app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Second Failure Page' });
      const decorationFailure = vi.spyOn(app.locals.bookPrimaryImageService, 'attachPrimaryImages')
        .mockImplementation(() => { throw new Error('Chapter Book decoration failed'); });

      await agent.get(`/notes/chapters/${chapter.id}`).expect(500);
      await agent.get(`/notes/chapters/${chapter.id}/edit`).expect(500);
      await agent.get(`/notes/chapters/${chapter.id}/notes/order`).expect(500);
      await agent.post(`/notes/chapters/${chapter.id}/notes/reorder`).type('form')
        .send({ _csrf: csrfToken, orderedNoteIds: `${first.id},999999` }).expect(500);
      await agent.post(`/notes/chapters/${chapter.id}`).type('form')
        .send({ _csrf: csrfToken, title: '' }).expect(500);
      await agent.get(`/notes/new?chapterId=${chapter.id}`).expect(500);
      expect(decorationFailure).toHaveBeenCalledTimes(6);
    });

    it('renders Book-detail defaults and icon toolbar in the required order', async () => {
      const book = app.locals.bookService.createBook({ title: 'Defaulted Book' });
      const first = app.locals.chapterService.createChapter({ bookId: book.id, title: 'First Chapter' });
      const second = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Second Chapter' });
      app.locals.noteService.createNote({ chapterId: first.id, title: 'Nested Page' });

      const collapsedResponse = await agent.get(`/notes/books/${book.id}`).expect(200);
      const sidebar = collapsedResponse.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
      const toolbar = collapsedResponse.text.match(/<div class="asset-viewer-display-controls" data-book-detail-toolbar>\s*<a class="button button-secondary" href="\/notes">Back to book list<\/a>\s*(<div class="project-filter-actions project-filter-actions--projects">[\s\S]*?<\/div>)\s*<\/div>/)?.[1] || '';
      const defaultsDialog = collapsedResponse.text.match(/<dialog id="book-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(sidebar.match(/<details class="notes-book-nav-disclosure"/g)).toHaveLength(2);
      expect(sidebar).not.toContain('<details class="notes-book-nav-disclosure" open>');
      expect(toolbar.indexOf('aria-label="Edit book"')).toBeLessThan(toolbar.indexOf('aria-label="Change order"'));
      expect(toolbar.indexOf('aria-label="Change order"')).toBeLessThan(toolbar.indexOf('aria-label="Book defaults"'));
      expect(toolbar.indexOf('aria-label="Book defaults"')).toBeLessThan(toolbar.indexOf('aria-label="Reset to default"'));

      for (const label of ['Edit book', 'Change order', 'Book defaults', 'Reset to default']) {
        const control = toolbar.match(new RegExp(`<a[^>]*aria-label="${label}"[\\s\\S]*?<\\/a>`))?.[0] || '';
        expect(control).toContain('<svg');
        expect(control).toContain(`data-tooltip="${label}"`);
        expect(control).not.toContain('title=');
      }
      expect(toolbar).toContain(`href="/notes/books/${book.id}/edit" data-dialog-open="book-edit-dialog"`);
      expect(toolbar).toContain(`href="/notes/books/${book.id}/order" data-dialog-open="book-order-dialog"`);
      expect(toolbar).toContain(`href="/notes/books/${book.id}?defaults=1" data-dialog-open="book-defaults-dialog"`);
      expect(toolbar).toContain(`href="/notes/books/${book.id}" aria-label="Reset to default"`);

      expect(defaultsDialog).toContain(`<form id="book-defaults-form" method="post" action="/notes/books/${book.id}/defaults"`);
      expect(defaultsDialog).toContain('data-dialog-form data-dialog-async novalidate');
      expect(defaultsDialog).toContain('name="_csrf"');
      expect(defaultsDialog).toContain('<legend>Chapter navigation</legend>');
      expect(defaultsDialog).toMatch(/<option value="expanded">Expanded<\/option>/);
      expect(defaultsDialog).toMatch(/<option value="collapsed" selected>Collapsed<\/option>/);
      expect(defaultsDialog).not.toMatch(/<dialog\b[^>]*\sopen(?:\s|>)/);
      expect(defaultsDialog).not.toMatch(/<button[^>]*>\s*Cancel\s*<\/button>/);
      expect(defaultsDialog).toContain('aria-label="Close Book defaults"');
      expect(defaultsDialog).toContain('type="submit" data-dialog-submit>Save defaults</button>');

      const openResponse = await agent.get(`/notes/books/${book.id}?defaults=1`).expect(200);
      const openDialog = openResponse.text.match(/<dialog id="book-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(openDialog).toMatch(/<dialog\b[^>]*\sopen(?:\s|>)/);
    });

    it('renders Book-scoped preview defaults with authoritative contextual Page choices', async () => {
      const book = app.locals.bookService.createBook({ title: 'Preview Book' });
      const directFirst = app.locals.noteService.createNote({ bookId: book.id, title: 'Duplicate' });
      const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Context Chapter' });
      const nested = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Duplicate' });
      const directLast = app.locals.noteService.createNote({ bookId: book.id, title: 'Last Page' });

      const response = await agent.get(`/notes/books/${book.id}?defaults=1`).expect(200);
      const dialog = response.text.match(/<dialog id="book-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(dialog).toContain('Navigation applies across Books. Page previews apply only to this Book.');
      expect(dialog).toMatch(/<select id="book-preview-mode" name="previewMode"[^>]*>[\s\S]*?<option value="random" selected>Random<\/option>/);
      expect(dialog).toMatch(/<select id="book-preview-count" name="randomPageCount"[^>]*>[\s\S]*?<option value="5" selected>5<\/option>/);
      expect(dialog).toContain('id="book-preview-pages-dropdown" data-cc-dropdown data-cc-dropdown-mode="multiple" data-cc-dropdown-searchable');
      expect(dialog).toMatch(/<select id="book-preview-pages" name="selectedPageIds"[^>]*multiple/);
      expect(dialog).toContain('type="search" autocomplete="off" data-cc-dropdown-search');
      expect(dialog).toContain('No Pages selected');

      const labels = [
        `Book: ${book.title} / ${directFirst.title}`,
        `Chapter: ${chapter.title} / ${nested.title}`,
        `Book: ${book.title} / ${directLast.title}`,
      ];
      const positions = labels.map((label) => dialog.indexOf(label));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
      expect(dialog).toContain(`value="${directFirst.id}"`);
      expect(dialog).toContain(`value="${nested.id}"`);
      expect(dialog).toContain(`value="${directLast.id}"`);
    });

    it('reopens stored Random and Selected preview settings without exposing stale foreign memberships', async () => {
      const book = app.locals.bookService.createBook({ title: 'Reopen Book' });
      const page = app.locals.noteService.createNote({ bookId: book.id, title: 'Local Page' });
      const otherBook = app.locals.bookService.createBook({ title: 'Foreign Book' });
      const foreignPage = app.locals.noteService.createNote({ bookId: otherBook.id, title: 'Foreign Page' });

      app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
        mode: 'random', randomCount: 17, selectedPageIds: [page.id],
      });
      let response = await agent.get(`/notes/books/${book.id}?defaults=1`).expect(200);
      let dialog = response.text.match(/<dialog id="book-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).toMatch(/<option value="random" selected>Random<\/option>/);
      expect(dialog).toMatch(/<option value="17" selected>17<\/option>/);
      expect(dialog).toMatch(new RegExp(`<option value="${page.id}" selected>`));

      app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
        mode: 'selected', randomCount: 9, selectedPageIds: [page.id],
      });
      db.prepare('INSERT INTO book_page_preview_pages (book_id, page_id) VALUES (?, ?)')
        .run(book.id, foreignPage.id);
      response = await agent.get(`/notes/books/${book.id}?defaults=1`).expect(200);
      dialog = response.text.match(/<dialog id="book-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).toMatch(/<option value="selected" selected>Selected<\/option>/);
      expect(dialog).toMatch(/<option value="9" selected>9<\/option>/);
      expect(dialog).toMatch(new RegExp(`<option value="${page.id}" selected>`));
      const pageSelect = dialog.match(/<select id="book-preview-pages"[\s\S]*?<\/select>/)?.[0] || '';
      expect(pageSelect).not.toContain(`value="${foreignPage.id}"`);
      expect(dialog).not.toContain('Foreign Page');
    });

    it('saves both preview modes, retains inactive configuration, deduplicates Pages, and isolates Books', async () => {
      const bookA = app.locals.bookService.createBook({ title: 'Preview A' });
      const chapter = app.locals.chapterService.createChapter({ bookId: bookA.id, title: 'Chapter A' });
      const first = app.locals.noteService.createNote({ bookId: bookA.id, title: 'First' });
      const second = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Second' });
      const bookB = app.locals.bookService.createBook({ title: 'Preview B' });
      const navigationKey = PAGE_DEFAULT_DEFINITIONS.bookDetail.navigation.key;

      await agent.post(`/notes/books/${bookA.id}/defaults`).set('Accept', 'application/json').type('form').send({
        _csrf: csrfToken,
        navigation: 'expanded',
        previewMode: 'random',
        randomPageCount: '1',
        selectedPageIds: [String(first.id), String(second.id), String(first.id)],
      }).expect(200);
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(bookA.id)).toEqual({
        mode: 'random', randomCount: 1, selectedPageIds: [first.id, second.id].sort((a, b) => a - b),
      });

      const native = await agent.post(`/notes/books/${bookA.id}/defaults`).type('form').send({
        _csrf: csrfToken,
        navigation: 'collapsed',
        previewMode: 'selected',
        randomPageCount: '25',
        selectedPageIds: [String(second.id), String(first.id)],
      }).expect(302);
      expect(native.headers.location).toBe(`/notes/books/${bookA.id}?notice=book_detail_defaults_saved`);
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(bookA.id)).toEqual({
        mode: 'selected', randomCount: 25, selectedPageIds: [first.id, second.id].sort((a, b) => a - b),
      });
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(bookB.id)).toEqual({
        mode: 'random', randomCount: 5, selectedPageIds: [],
      });
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(navigationKey)?.value).toBe('collapsed');
      expect(db.prepare("SELECT key FROM app_meta WHERE key LIKE '%book%preview%'").all()).toEqual([]);

      await agent.post(`/notes/books/${bookA.id}/defaults`).set('Accept', 'application/json').type('form').send({
        _csrf: csrfToken,
        navigation: 'expanded',
        previewMode: 'selected',
        randomPageCount: '25',
      }).expect(200);
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(bookA.id).selectedPageIds).toEqual([]);
    });

    it.each([
      ['invalid mode', { previewMode: 'rotating', randomPageCount: '5' }, 'previewMode'],
      ['zero count', { previewMode: 'random', randomPageCount: '0' }, 'randomPageCount'],
      ['high count', { previewMode: 'random', randomPageCount: '26' }, 'randomPageCount'],
      ['non-integer count', { previewMode: 'random', randomPageCount: '1.5' }, 'randomPageCount'],
      ['malformed Page', { previewMode: 'selected', randomPageCount: '5', selectedPageIds: '01' }, 'selectedPageIds'],
    ])('rejects %s without partially saving either settings domain', async (_label, preview, errorKey) => {
      const book = app.locals.bookService.createBook({ title: `Invalid ${_label}` });
      const page = app.locals.noteService.createNote({ bookId: book.id, title: 'Existing' });
      app.locals.pageDefaultsService.saveDefault('bookDetail', 'navigation', 'expanded');
      app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
        mode: 'selected', randomCount: 7, selectedPageIds: [page.id],
      });

      const response = await agent.post(`/notes/books/${book.id}/defaults`)
        .set('Accept', 'application/json').type('form').send({
          _csrf: csrfToken, navigation: 'collapsed', ...preview,
        }).expect(422);
      expect(response.body.errors).toHaveProperty(errorKey);
      expect(app.locals.pageDefaultsService.resolvePageDefaults('bookDetail')).toEqual({ navigation: 'expanded' });
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(book.id)).toEqual({
        mode: 'selected', randomCount: 7, selectedPageIds: [page.id],
      });
    });

    it('rejects a foreign-Book Page with 422 and rerenders submitted preview errors natively', async () => {
      const book = app.locals.bookService.createBook({ title: 'Owned Preview' });
      const localPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Local' });
      const foreignBook = app.locals.bookService.createBook({ title: 'Foreign Preview' });
      const foreignPage = app.locals.noteService.createNote({ bookId: foreignBook.id, title: 'Foreign' });
      app.locals.pageDefaultsService.saveDefault('bookDetail', 'navigation', 'expanded');
      app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
        mode: 'random', randomCount: 8, selectedPageIds: [localPage.id],
      });

      const response = await agent.post(`/notes/books/${book.id}/defaults`).type('form').send({
        _csrf: csrfToken,
        navigation: 'collapsed',
        previewMode: 'selected',
        randomPageCount: '12',
        selectedPageIds: String(foreignPage.id),
      }).expect(422);
      const dialog = response.text.match(/<dialog id="book-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).toMatch(/<dialog\b[^>]*\sopen(?:\s|>)/);
      expect(dialog).toContain('Every selected Page must belong to this Book.');
      expect(dialog).toMatch(/<option value="selected" selected>Selected<\/option>/);
      expect(dialog).toMatch(/<option value="12" selected>12<\/option>/);
      const pageSelect = dialog.match(/<select id="book-preview-pages"[\s\S]*?<\/select>/)?.[0] || '';
      expect(pageSelect).not.toContain(`value="${foreignPage.id}"`);
      expect(app.locals.pageDefaultsService.resolvePageDefaults('bookDetail')).toEqual({ navigation: 'expanded' });
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(book.id)).toEqual({
        mode: 'random', randomCount: 8, selectedPageIds: [localPage.id],
      });
    });

    it('rolls navigation back when preview persistence fails and leaves previews unchanged when navigation fails', async () => {
      const book = app.locals.bookService.createBook({ title: 'Atomic Defaults' });
      const page = app.locals.noteService.createNote({ bookId: book.id, title: 'Atomic Page' });
      app.locals.pageDefaultsService.saveDefault('bookDetail', 'navigation', 'collapsed');

      const previewFailure = vi.spyOn(app.locals.bookPagePreviewSettingsService, 'replaceBookPagePreviewSettings')
        .mockImplementationOnce(() => { throw new Error('preview persistence failed'); });
      await agent.post(`/notes/books/${book.id}/defaults`).set('Accept', 'application/json').type('form').send({
        _csrf: csrfToken,
        navigation: 'expanded',
        previewMode: 'selected',
        randomPageCount: '6',
        selectedPageIds: String(page.id),
      }).expect(500);
      expect(app.locals.pageDefaultsService.resolvePageDefaults('bookDetail')).toEqual({ navigation: 'collapsed' });
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(book.id)).toEqual({
        mode: 'random', randomCount: 5, selectedPageIds: [],
      });
      previewFailure.mockRestore();

      const navigationFailure = vi.spyOn(app.locals.pageDefaultsService, 'saveDefault')
        .mockImplementationOnce(() => { throw new Error('navigation persistence failed'); });
      await agent.post(`/notes/books/${book.id}/defaults`).set('Accept', 'application/json').type('form').send({
        _csrf: csrfToken,
        navigation: 'expanded',
        previewMode: 'selected',
        randomPageCount: '6',
        selectedPageIds: String(page.id),
      }).expect(500);
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(book.id)).toEqual({
        mode: 'random', randomCount: 5, selectedPageIds: [],
      });
      navigationFailure.mockRestore();
    });

    it('saves Book navigation defaults through app_meta for enhanced and native requests', async () => {
      const book = app.locals.bookService.createBook({ title: 'Saved Defaults Book' });
      const firstChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'First Chapter' });
      app.locals.chapterService.createChapter({ bookId: book.id, title: 'Second Chapter' });
      const currentPage = app.locals.noteService.createNote({ chapterId: firstChapter.id, title: 'Current Page' });
      const key = PAGE_DEFAULT_DEFINITIONS.bookDetail.navigation.key;

      const enhanced = await agent
        .post(`/notes/books/${book.id}/defaults`)
        .set('Accept', 'application/json')
        .type('form')
        .send({
          _csrf: csrfToken,
          navigation: 'expanded',
          previewMode: 'random',
          randomPageCount: '5',
        })
        .expect(200);
      expect(enhanced.body).toEqual({
        status: 'success',
        message: 'Book defaults saved successfully.',
        values: {
          navigation: 'expanded',
          previewMode: 'random',
          randomPageCount: '5',
          selectedPageIds: [],
        },
      });
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value).toBe('expanded');

      const expandedPage = await agent.get(`/notes/books/${book.id}`).expect(200);
      const [expandedSidebar = '', expandedNewPageNavigator = ''] = expandedPage.text
        .match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/g) || [];
      expect(expandedSidebar.match(/<details class="notes-book-nav-disclosure" open>/g)).toHaveLength(2);
      expect(expandedNewPageNavigator).toContain('class="notes-book-nav"');
      expect(expandedNewPageNavigator).not.toContain('<details class="notes-book-nav-disclosure" open>');

      for (const detailUrl of [`/notes/chapters/${firstChapter.id}`, `/notes/${currentPage.id}`]) {
        const detailResponse = await agent.get(detailUrl).expect(200);
        const detailNavigator = detailResponse.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
        expect(detailNavigator.match(/<details class="notes-book-nav-disclosure" open>/g)).toHaveLength(1);
      }

      const native = await agent
        .post(`/notes/books/${book.id}/defaults`)
        .type('form')
        .send({
          _csrf: csrfToken,
          navigation: 'collapsed',
          previewMode: 'random',
          randomPageCount: '5',
        })
        .expect(302);
      expect(native.headers.location).toBe(`/notes/books/${book.id}?notice=book_detail_defaults_saved`);
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value).toBe('collapsed');

      const resetPage = await agent.get(`/notes/books/${book.id}`).expect(200);
      const resetSidebar = resetPage.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
      expect(resetSidebar).not.toContain('<details class="notes-book-nav-disclosure" open>');
    });

    it('rejects invalid Book defaults, preserves storage, and protects the endpoint with CSRF', async () => {
      const book = app.locals.bookService.createBook({ title: 'Invalid Defaults Book' });
      const key = PAGE_DEFAULT_DEFINITIONS.bookDetail.navigation.key;
      app.locals.pageDefaultsService.saveDefault('bookDetail', 'navigation', 'expanded');
      app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
        mode: 'random', randomCount: 7, selectedPageIds: [],
      });

      const enhanced = await agent
        .post(`/notes/books/${book.id}/defaults`)
        .set('Accept', 'application/json')
        .type('form')
        .send({
          _csrf: csrfToken,
          navigation: 'partially-expanded',
          previewMode: 'random',
          randomPageCount: '5',
        })
        .expect(422);
      expect(enhanced.body).toMatchObject({
        status: 'error',
        values: { navigation: 'partially-expanded' },
      });
      expect(enhanced.body.errors.navigation).toContain('is not supported');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value).toBe('expanded');
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(book.id).randomCount).toBe(7);

      const native = await agent
        .post(`/notes/books/${book.id}/defaults`)
        .type('form')
        .send({
          _csrf: csrfToken,
          navigation: 'partially-expanded',
          previewMode: 'random',
          randomPageCount: '5',
        })
        .expect(422);
      const dialog = native.text.match(/<dialog id="book-defaults-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).toMatch(/<dialog\b[^>]*\sopen(?:\s|>)/);
      expect(dialog).toContain('Value &quot;partially-expanded&quot; is not supported for bookDetail.navigation.');
      expect(dialog).toContain('data-dialog-submitted-value');
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value).toBe('expanded');
      expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(book.id).randomCount).toBe(7);

      await agent
        .post(`/notes/books/${book.id}/defaults`)
        .type('form')
        .send({ navigation: 'collapsed' })
        .expect(403);
      await agent
        .post('/notes/books/999999/defaults')
        .type('form')
        .send({ _csrf: csrfToken, navigation: 'collapsed' })
        .expect(404);
      await agent.get('/notes/books/999999?defaults=1').expect(404);
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value).toBe('expanded');
    });

    it('propagates asynchronous Book render failures from native defaults validation', async () => {
      const book = app.locals.bookService.createBook({ title: 'Defaults Render Error Book' });
      const renderFailure = vi.spyOn(app.locals.bookPrimaryImageService, 'attachPrimaryImages')
        .mockImplementationOnce(() => { throw new Error('defaults validation render failed'); });

      await agent
        .post(`/notes/books/${book.id}/defaults`)
        .type('form')
        .send({
          _csrf: csrfToken,
          navigation: 'invalid',
          previewMode: 'random',
          randomPageCount: '5',
        })
        .expect(500);

      renderFailure.mockRestore();
    });

    it('enables Change order when one Chapter contains nested Pages', async () => {
      const book = app.locals.bookService.createBook({ title: 'Order Eligibility Book' });
      const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Only Top-Level Item' });
      app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Nested One' });
      app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Nested Two' });

      const oneItemPage = await agent.get(`/notes/books/${book.id}`).expect(200);
      const oneItemToolbar = oneItemPage.text.match(/<div class="asset-viewer-display-controls" data-book-detail-toolbar>\s*<a class="button button-secondary" href="\/notes">Back to book list<\/a>\s*(<div class="project-filter-actions project-filter-actions--projects">[\s\S]*?<\/div>)\s*<\/div>/)?.[1] || '';
      expect(oneItemToolbar).toContain('aria-label="Change order"');

      app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Top-Level Page' });
      const twoItemPage = await agent.get(`/notes/books/${book.id}`).expect(200);
      const twoItemToolbar = twoItemPage.text.match(/<div class="asset-viewer-display-controls" data-book-detail-toolbar>\s*<a class="button button-secondary" href="\/notes">Back to book list<\/a>\s*(<div class="project-filter-actions project-filter-actions--projects">[\s\S]*?<\/div>)\s*<\/div>/)?.[1] || '';
      expect(twoItemToolbar).toContain('aria-label="Change order"');
    });

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
      expect(response.text).toContain(`<a class="button button-primary" href="/notes/new?chapterId=${chapter.id}" data-dialog-open="note-create-dialog">New Page</a>`);
      expect(response.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain('Change order');
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

      const [navigator = '', pageDialogNavigator = ''] = response.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/g) || [];
      expect(chapterLocals.bookContents).toBe(authoritativeContents);
      expect(chapterLocals.navCurrentChapterId).toBe(chapter.id);
      expect(Object.hasOwn(chapterLocals, 'navCurrentPageId')).toBe(false);
      expect(Object.hasOwn(chapterLocals, 'bookDetailSidebarNavigationMode')).toBe(false);
      expect(listBookContentsCalls).toContainEqual([book.id]);
      expect(response.text).toContain('<div class="notes-chapter-detail-layout">');
      expect(response.text).toContain('<aside class="notes-chapter-detail-sidebar notes-book-detail-sidebar notes-surface notes-surface--compact">');
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
      expect(navigator).not.toContain('>View Chapter</a>');
      expect(navigator).toContain('<li class="notes-book-nav-item notes-book-nav-chapter notes-book-nav-item--current">');
      expect((navigator.match(/<details class="notes-book-nav-disclosure" open>/g) || [])).toHaveLength(1);
      expect((navigator.match(/<details class="notes-book-nav-disclosure"/g) || [])).toHaveLength(2);
      expect((navigator.match(/aria-current="page"/g) || [])).toHaveLength(0);
      expect(pageDialogNavigator).not.toContain('>View Chapter</a>');
      expect(response.text).toContain('<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded" aria-label="Book contents">');

      const pageNav = response.text.match(/<nav class="notes-page-nav"[\s\S]*?<\/nav>/)?.[0] || '';
      expect(pageNav).toContain(`<nav class="notes-page-nav" aria-label="Pages in ${chapter.title}">`);
      expect(pageNav).toContain(`<a class="notes-page-nav-link" href="/notes/${nestedFirst.id}">Nested First</a>`);
      expect(pageNav).toContain(`<a class="notes-page-nav-link" href="/notes/${nestedSecond.id}">Nested Second</a>`);
      expect(pageNav).not.toContain('Direct First');
      expect(pageNav).not.toContain('Direct Second');
      expect(response.text).toContain(`<a class="button button-primary" href="/notes/new?chapterId=${chapter.id}" data-dialog-open="note-create-dialog">New Page</a>`);
      expect(response.text).toContain(`<a class="button" href="/notes/chapters/${chapter.id}/edit" data-dialog-open="chapter-edit-dialog">Edit Chapter</a>`);
      expect(response.text).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}/notes/order" data-dialog-open="chapter-order-dialog">Change order</a>`);
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
      expect(response.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain('>Page 1<');
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
      expect(response.text).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}/notes/order" data-dialog-open="chapter-order-dialog">Change order</a>`);
      expect(pageNav).not.toContain('aria-current="page"');
      expect(response.text).not.toContain('Edit Page');
      expect(response.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain('>Page 1<');
      expect(response.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain('>Page 2<');
      expect(response.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain('>Page 3<');
      expect(response.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain(`/notes/chapters/${chapter.id}/notes/reorder`);
      expect(response.text).not.toContain('Move up');
      expect(response.text).not.toContain('Move down');
      expect(response.text).not.toContain('Danger zone');

      const orderPage = await agent.get(`/notes/chapters/${chapter.id}/notes/order`).expect(200);
      expect(orderPage.text).toMatch(/<dialog[^>]*id="chapter-order-dialog"[^>]* open/);
      expect((orderPage.text.match(/<h1\b/g) || [])).toHaveLength(1);
      expect(orderPage.text).toContain('class="notes-chapter-detail-layout"');
      expect(orderPage.text).not.toContain('notes-hierarchy');
      expect(orderPage.text).toContain('Drag a Page card to move it');
      expect(orderPage.text).toContain(`<button class="button button-primary" type="submit" form="notes-chapter-order-form" data-dialog-submit>Save</button>`);
      const chapterOrderDialog = orderPage.text.match(/<dialog\b[^>]*id="chapter-order-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(chapterOrderDialog).not.toContain('>Cancel<');
      expect(orderPage.text).toContain(`<form id="notes-chapter-order-form" method="post" action="/notes/chapters/${chapter.id}/notes/reorder"`);
      expect(orderPage.text).toContain(`<input type="hidden" name="orderedNoteIds" data-chapter-page-order-input value="${[first, second, third].map((note) => note.id).join(',')}">`);
      expect((orderPage.text.match(/data-chapter-page-reorder-item/g) || [])).toHaveLength(3);
      expect((orderPage.text.match(/data-chapter-page-reorder-handle/g) || [])).toHaveLength(3);
      expect((orderPage.text.match(/notes-reorder-row--compact/g) || [])).toHaveLength(3);
      expect(orderPage.text).toContain('aria-label="Reorder Page: First Chapter Page"');
      expect(orderPage.text).toContain('Position 1 of 3');
      const orderList = orderPage.text.match(/<ol\b[^>]*data-chapter-page-reorder-list[\s\S]*?<\/ol>/)?.[0] || '';
      expect(orderList.indexOf('First Chapter Page')).toBeLessThan(orderList.indexOf('Second Chapter Page'));
      expect(orderList.indexOf('Second Chapter Page')).toBeLessThan(orderList.indexOf('Third Chapter Page'));
      expect(orderList).not.toContain('Direct Book Page');
      expect(orderList).not.toContain('Other Chapter Page');
      expect(orderPage.text).toContain(`<a href="/notes/${first.id}">First Chapter Page</a>`);
      expect((orderPage.text.match(/draggable="true"/g) || [])).toHaveLength(9);
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

      const page = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Hosted Chapter Page' });
      const directPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Book Context' });
      const detail = await agent.get(`/notes/chapters/${chapter.id}`).expect(200);
      expectEditChapterDialog(detail.text, chapter.id, false);
      await agent.post(`/notes/chapters/${chapter.id}`).type('form').send({ title: 'No CSRF' }).expect(403);
      const form = await agent.get(`/notes/chapters/${chapter.id}/edit`).expect(200);
      expectEditChapterDialog(form.text, chapter.id, true);
      const pageHeading = form.text.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0];
      expect((form.text.match(/<h1\b/g) || [])).toHaveLength(1);
      expect(pageHeading).toBeDefined();
      expect(pageHeading).not.toContain('>Edit<');
      expect(pageHeading).not.toContain('Manage');
      expect(pageHeading).not.toContain('Delete');
      expect(form.text).toContain(`action="/notes/chapters/${chapter.id}"`);
      expect(form.text).toContain('value="Before Rename"');
      expect(form.text).toContain('<h1 class="app-section-title">Notes — Before Rename</h1>');
      expect(form.text).not.toContain('notes-hierarchy');
      expect(form.text).toContain('<label for="chapter-edit-title">Title <span class="required" aria-label="required">*</span></label>');
      expect(form.text).toContain('<details class="notes-workspace-disclosure notes-workspace-disclosure--delete">');
      expect(form.text).toContain('<summary>Delete Chapter</summary>');
      expect(form.text).toContain(`<form id="chapter-delete-form" method="post" action="/notes/chapters/${chapter.id}/delete">`);
      expect(form.text).toMatch(new RegExp(`<form id="chapter-delete-form"[\\s\\S]*?name="_csrf"[^>]+value="[^"]+"`));
      expect(form.text).toContain('data-confirm="Delete this Chapter permanently? This cannot be undone."');
      expect(form.text).toContain('The Chapter must be empty before it can be deleted.');
      expect(form.text).not.toContain('type="submit" form="chapter-form">Edit</button>');
      expect(form.text).not.toContain('Danger zone');
      expect(form.text).toContain('<details class="notes-workspace-disclosure notes-workspace-disclosure--delete">');

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
      expectEditChapterDialog(invalid.text, chapter.id, true);
      expect(invalid.text).toContain('aria-describedby="chapter-edit-title-error" aria-invalid="true"');
      expect(invalid.text).toContain('id="chapter-edit-title-error">Title is required.');
      expect(invalid.text).toContain('Hosted Chapter Page');
      expect(invalid.text).toContain('Direct Book Context');
      expect(invalid.text).toContain(`href="/notes/books/${book.id}"`);
      const longTitle = 'x'.repeat(201);
      const tooLong = await agent.post(`/notes/chapters/${chapter.id}`).type('form')
        .send({ _csrf: csrfToken, title: longTitle }).expect(422);
      expectEditChapterDialog(tooLong.text, chapter.id, true);
      expect(tooLong.text).toContain(`value="${longTitle}"`);
      expect(tooLong.text).toContain('Title must be 200 characters or fewer.');
      expect(app.locals.chapterService.getChapter(chapter.id).title).toBe('After Rename');
      expect(app.locals.noteService.getNote(page.id).chapter_id).toBe(chapter.id);
      expect(app.locals.noteService.getNote(directPage.id).chapter_id).toBeNull();
      expect(invalid.text).toContain('Title is required.');
      expect(invalid.text).toContain('value=""');
      expect(invalid.text).toContain('<h1 class="app-section-title">Notes — After Rename</h1>');
      expect(invalid.text).not.toContain('notes-hierarchy');

      await agent.get('/notes/chapters/not-an-id/edit').expect(404);
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
      const navigator = bookPage.text.match(/<nav class="notes-book-nav"[\s\S]*?<\/nav>/)?.[0] || '';
      expect(navigator).toContain(`<a class="notes-book-nav-page-link" href="/notes/${chapterPage.id}">Nested Chapter Page</a>`);
      expect(bookPage.text).toContain(`<a class="notes-page-preview-title" href="/notes/${chapterPage.id}">Nested Chapter Page</a>`);
      expect(bookPage.text).not.toContain('class="book-outline"');
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
        expect(response.text).toMatch(/<dialog id="book-order-dialog"[^>]* open/);
        const orderDialog = response.text.match(/<dialog id="book-order-dialog"[\s\S]*?<\/dialog>/)?.[0];
        expect(orderDialog).toContain('role="alert"');
        expect(orderDialog.match(/name="hierarchy"/g)).toHaveLength(1);
        expect(orderDialog).toContain('data-book-hierarchy-input');
        expect(orderDialog).not.toContain('name="orderedItems"');
        expect(response.text).not.toContain('class="book-outline"');
        expect(response.text).toContain('class="notes-detail-panel notes-page-previews"');
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
      expect(controlsPage.text).toContain(`<a class="button button-secondary" href="/notes/chapters/${chapter.id}/notes/order" data-dialog-open="chapter-order-dialog">Change order</a>`);
      expect(controlsPage.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain(`action="/notes/chapters/${chapter.id}/notes/reorder"`);
      expect(controlsPage.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain(`name="orderedNoteIds"`);
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
      expect(emptyPage.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain(`/notes/chapters/${chapter.id}/notes/reorder`);
      expect(emptyPage.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain('Change order');

      await agent
        .post(`/notes/chapters/${chapter.id}/notes/reorder`)
        .type('form')
        .send({ _csrf: csrfToken, orderedNoteIds: '' })
        .expect(302)
        .expect('Location', `/notes/chapters/${chapter.id}`);

      const note = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Only Page' });
      const singlePage = await agent.get(`/notes/chapters/${chapter.id}`).expect(200);
      expect(singlePage.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain(`/notes/chapters/${chapter.id}/notes/reorder`);
      expect(singlePage.text.match(/<main\b[\s\S]*?<\/main>/)?.[0]).not.toContain('Change order');
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
