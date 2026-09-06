import fs from 'node:fs';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DETAIL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/detail.njk', import.meta.url));
const DETAILS_PANEL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/partials/notes-details-panel.njk', import.meta.url));
const CHAPTER_DETAIL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/chapters/detail.njk', import.meta.url));
const CHAPTER_FORM_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/chapters/form.njk', import.meta.url));
const BOOK_DETAIL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/books/detail.njk', import.meta.url));
const BOOK_ORDER_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/books/order.njk', import.meta.url));
const NOTE_FORM_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/form.njk', import.meta.url));
const HIERARCHY_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/partials/notes-hierarchy.njk', import.meta.url));
const CSS_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const detailTemplate = fs.readFileSync(DETAIL_TEMPLATE_PATH, 'utf8');
const detailsPanelTemplate = fs.readFileSync(DETAILS_PANEL_TEMPLATE_PATH, 'utf8');
const chapterDetailTemplate = fs.readFileSync(CHAPTER_DETAIL_TEMPLATE_PATH, 'utf8');
const chapterFormTemplate = fs.readFileSync(CHAPTER_FORM_TEMPLATE_PATH, 'utf8');
const bookDetailTemplate = fs.readFileSync(BOOK_DETAIL_TEMPLATE_PATH, 'utf8');
const bookOrderTemplate = fs.readFileSync(BOOK_ORDER_TEMPLATE_PATH, 'utf8');
const noteFormTemplate = fs.readFileSync(NOTE_FORM_TEMPLATE_PATH, 'utf8').replace(/\{% include "notes\/(connections-fields|writing-fields)\.njk" %\}/g, (_match, name) => (
  fs.readFileSync(new URL(`../src/views/notes/${name}.njk`, import.meta.url), 'utf8')
));
const notesCss = fs.readFileSync(CSS_PATH, 'utf8');

describe('Notes Page detail hierarchy and layout contract', () => {
  it.each([
    ['shared navigator', fs.readFileSync(new URL('../src/views/partials/book-navigator.njk', import.meta.url), 'utf8'), 'notes-book-nav'],
    ['Book detail outline', bookDetailTemplate, 'book-outline'],
  ])('uses native chapter title disclosure in the %s', (_name, template, prefix) => {
    const disclosure = template.match(new RegExp('<details class="' + prefix + '-disclosure"[\\s\\S]*?</details>'))?.[0];
    expect(disclosure).toBeTruthy();
    const summary = disclosure.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1];
    expect(summary).toContain('{{ item.chapter.title }}');
    expect(summary).toContain(prefix + '-disclosure-indicator');
    expect(summary).not.toMatch(/<(?:a|button)\b|tabindex|onclick/);
    const body = disclosure.slice(disclosure.indexOf('</summary>') + '</summary>'.length);
    expect(body).toMatch(/<a[^>]*href="\/notes\/chapters\/{{ item.id }}"[^>]*>View Chapter<\/a>/);
    expect(body).toContain('href="/notes/{{ page.id }}"');
    expect(notesCss).toContain('.' + prefix + '-summary');
    expect(notesCss).toContain('.' + prefix + '-disclosure[open] .' + prefix + '-disclosure-indicator');
  });

  it('keeps Page detail free of the obsolete hierarchy breadcrumb', () => {
    expect(fs.existsSync(HIERARCHY_TEMPLATE_PATH)).toBe(false);
    expect(detailTemplate).not.toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(detailTemplate).not.toContain('notes-hierarchy');
    expect(detailTemplate).not.toContain('Move Page');
    expect(detailTemplate).not.toContain('Danger zone');
    expect(detailTemplate).not.toContain('/move');
    expect(detailTemplate).not.toContain('/delete');
    expect(detailTemplate).toContain('Edit Page');
    expect(detailTemplate).toContain('href="/notes/{{ note.id }}/edit" data-dialog-open="note-edit-dialog"');
    expect(detailTemplate).toContain('{% include "notes/form.njk" %}');
    expect(detailTemplate).toContain("{% set noteFormModel = noteEditForm %}");
  });

  it('removes the obsolete hierarchy partial and stylesheet rules', () => {
    expect(fs.existsSync(HIERARCHY_TEMPLATE_PATH)).toBe(false);
    expect(notesCss).not.toContain('.notes-hierarchy');
  });

  it('keeps Chapter detail free of the obsolete hierarchy breadcrumb', () => {
    expect(chapterDetailTemplate).not.toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(chapterDetailTemplate).not.toContain('notes-hierarchy');
  });

  it('renders Book detail with its layout identity and one surfaced outline', () => {
    expect(bookDetailTemplate).not.toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(bookDetailTemplate).toContain('page_title = "Notes');
    expect(bookDetailTemplate).toContain('~ book.title %}');
    expect(bookDetailTemplate).toContain('New Page');
    expect(bookDetailTemplate).toContain('New Chapter');
    expect(bookDetailTemplate).toContain('Edit Book');
    expect(bookDetailTemplate).toContain('Change order');
    expect(bookDetailTemplate).toContain('class="notes-surface"');
    expect(bookDetailTemplate).toContain('<nav class="book-outline"');
    const headingStart = bookDetailTemplate.indexOf('{% call pageHeading.render() %}');
    const surfaceStart = bookDetailTemplate.indexOf('<div class="notes-surface">');
    expect(headingStart).toBeGreaterThanOrEqual(0);
    expect(headingStart).toBeLessThan(surfaceStart);
    expect(bookDetailTemplate).toContain('book-outline-summary');
    expect(bookDetailTemplate).not.toContain('notes-book-content-row');
    expect(bookDetailTemplate).not.toContain('notes-hierarchy');
  });

  it('renders Book detail as one authoritative mixed contents list', () => {
    expect(bookDetailTemplate).toContain('{% for item in contents %}');
    expect(bookDetailTemplate).toContain("{% if item.type == 'chapter' %}");
    expect(bookDetailTemplate).toContain("{% elif item.type == 'page' %}");
    expect(bookDetailTemplate).toContain('{{ item.chapter.title }}');
    expect(bookDetailTemplate).toContain('{{ item.page.title }}');
    expect(bookDetailTemplate).toContain('/notes/chapters/{{ item.id }}');
    expect(bookDetailTemplate).toContain('/notes/{{ item.id }}');
    expect(bookDetailTemplate).toContain('No Pages or Chapters yet');
    expect(bookDetailTemplate).toContain('No Pages yet');
    expect(bookDetailTemplate).not.toContain('/notes/chapters/{{ item.id }}/edit');
    expect(bookDetailTemplate).not.toContain('/notes/{{ item.id }}/edit');
    expect(bookDetailTemplate).not.toContain('Edit Page');
    expect(bookDetailTemplate).not.toContain('Edit Chapter');
    expect(bookDetailTemplate).not.toContain('{% for chapter in chapters %}');
    expect(bookDetailTemplate).not.toContain('{% for page in pages %}');
    expect(bookDetailTemplate).not.toContain('notes-book-chapters-heading');
    expect(bookDetailTemplate).not.toContain('notes-book-pages-heading');
    expect(bookDetailTemplate).not.toContain('sort_order');
    expect(notesCss).toContain('.book-outline-list');
    expect(notesCss).toContain('.book-outline-summary::-webkit-details-marker');
    expect(notesCss).toContain('.book-outline-disclosure[open] .book-outline-disclosure-indicator');
    expect(notesCss).toContain('.book-outline-children');
    expect(notesCss).toContain('.book-outline-title:focus-visible');
    expect(bookDetailTemplate).toContain('class="book-outline-title-wrap"');
    expect(bookDetailTemplate).toContain('notes-surface');
    expect(notesCss).toContain('.book-outline-title-wrap');
    expect(notesCss).toContain('.book-outline-chapter .book-outline-title');
    expect(notesCss).toContain('display: inline;');
    expect(notesCss).toContain('.notes-book-content-row');
    expect(notesCss).toContain('.notes-book-content-actions');
  });

  it('renders the Book order page as one dedicated mixed reorder form', () => {
    expect(bookOrderTemplate).not.toContain('notes-hierarchy');
    expect(bookOrderTemplate).toContain('action="/notes/books/{{ book.id }}/contents/reorder"');
    expect(bookOrderTemplate).toContain('name="orderedItems"');
    expect(bookOrderTemplate).toContain('data-book-content-reorder-list');
    expect(bookOrderTemplate).toContain('data-book-content-reorder-item');
    expect(bookOrderTemplate).toContain('data-content-key="{{ item.type }}:{{ item.id }}"');
    expect(bookOrderTemplate).toContain('data-book-content-reorder-handle');
    expect(bookOrderTemplate).toContain('notes-reorder-row--compact');
    expect(bookOrderTemplate).toContain('Drag a Chapter or Page card to move it');
    expect(bookOrderTemplate).not.toContain('>Cancel<');
    expect(bookOrderTemplate).toContain('Arrow Up, Arrow Down, Home, or End');
    expect(bookOrderTemplate).toContain('notes-book-content-list');
    expect(bookOrderTemplate).toContain('This Book has no Chapters or direct Pages to order yet.');
    expect(bookOrderTemplate).not.toContain('Book ordering controls will be available here in a future update.');
    expect(bookOrderTemplate).not.toContain('orderedNoteIds');
    expect(bookOrderTemplate).not.toContain('orderedChapterIds');
    expect(notesCss).toMatch(/\.notes-reorder-row--compact\s*\{[\s\S]*?gap: var\(--space-xs\);[\s\S]*?padding: var\(--space-xs\) var\(--space-sm\);/);
    expect(notesCss).toMatch(/\.notes-reorder-row--compact \.notes-reorder-position\s*\{ margin-top: 0; \}/);
    expect(notesCss).toMatch(/\.notes-reorder-row--compact :is\([^)]*\.notes-reorder-position[^)]*\)\s*\{[\s\S]*?pointer-events: none;/);
  });

  it('keeps Chapter detail actions content-first and removes normal-view reorder and deletion controls', () => {
    expect(chapterDetailTemplate).toContain('<div class="notes-chapter-detail-layout">');
    expect(chapterDetailTemplate).toContain('<aside class="notes-chapter-detail-sidebar notes-surface notes-surface--compact">');
    expect(chapterDetailTemplate).toContain('<div class="notes-chapter-detail-content notes-surface">');
    expect(chapterDetailTemplate).toContain('{% include "partials/book-navigator.njk" %}');
    const chapterHeadingStart = chapterDetailTemplate.indexOf('{% call pageHeading.render() %}');
    const chapterLayoutStart = chapterDetailTemplate.indexOf('<div class="notes-chapter-detail-layout">');
    expect(chapterHeadingStart).toBeGreaterThanOrEqual(0);
    expect(chapterHeadingStart).toBeLessThan(chapterLayoutStart);
    expect(chapterDetailTemplate).toContain('New Page');
    expect(chapterDetailTemplate).toContain('Edit Chapter');
    expect(chapterDetailTemplate).toContain('Change order');
    expect(chapterDetailTemplate).toContain('{% include "partials/notes-page-nav.njk" %}');
    expect(chapterDetailTemplate).toContain('{% set pageNavPages = notes %}');
    expect(chapterDetailTemplate).toContain('{% set pageNavLabel = "Pages in " ~ chapter.title %}');
    expect(chapterDetailTemplate).not.toContain('pageNavCurrentId');
    expect(chapterDetailTemplate).not.toContain('Edit Page');
    expect(chapterDetailTemplate).not.toContain('Page {{ loop.index }}');
    expect(chapterDetailTemplate).not.toContain('moveUpOrderedNoteIds');
    expect(chapterDetailTemplate).not.toContain('moveDownOrderedNoteIds');
    expect(chapterDetailTemplate).not.toContain('Move up');
    expect(chapterDetailTemplate).not.toContain('Move down');
    expect(chapterDetailTemplate).not.toContain('Danger zone');
    expect(chapterDetailTemplate.split('{% block overlay %}')[0]).not.toContain('/notes/chapters/{{ chapter.id }}/delete');
    expect(chapterDetailTemplate).toContain('emptyActionUrl = "/notes/new?chapterId=" ~ chapter.id');
    expect(chapterDetailTemplate).not.toContain('book-outline');
    expect(notesCss).toContain('.notes-chapter-detail-layout');
    expect(notesCss).toContain('grid-template-columns: minmax(12rem, 16rem) minmax(0, 1fr);');
    expect(notesCss).toContain('.notes-chapter-detail-sidebar');
    expect(notesCss).toContain('.notes-surface--compact');
    expect(notesCss).toContain('background: var(--surface);');
    expect(notesCss).toContain('border: 1px solid var(--border);');
    expect(notesCss).toContain('border-radius: var(--radius-lg);');
    expect(notesCss).toMatch(/\.notes-book-nav-summary:hover,[\s\S]*?background: var\(--surface-hover\);/);
    expect(notesCss).toMatch(/\.notes-book-nav-page-link:hover,[\s\S]*?background: var\(--surface-hover\);/);
    expect(notesCss).toContain('.notes-page-nav');
    expect(notesCss).not.toContain('.notes-chapter-page-actions');
  });

  it.each(['New', 'Edit'])('renders %s Chapter with shared styling and separate deletion', (mode) => {
    const edit = mode === 'Edit';
    const env = nunjucks.configure(fileURLToPath(new URL('../src/views', import.meta.url)), {
      autoescape: true, noCache: true,
    });
    const book = { id: 7, title: 'Book', primaryImage: { state: 'none' } };
    const chapter = { id: 9, title: 'Chapter', book_id: 7 };
    const submitUrl = edit ? '/notes/chapters/9' : '/notes/books/7/chapters';
    const form = { values: { title: 'Chapter' }, errors: {}, submitUrl };
    for (const open of [false, true]) {
      const html = env.render(edit ? 'notes/chapters/detail.njk' : 'notes/books/detail.njk', {
        book, chapter, contents: [], notes: [], _csrf: 'csrf-token',
        chapterEditForm: form, chapterCreateForm: form,
        chapterEditDialogOpen: open, chapterCreateDialogOpen: open,
        bookEditForm: { book, values: { title: 'Book' }, errors: {}, submitUrl: '/notes/books/7' },
      });
      const id = edit ? 'chapter-edit-dialog' : 'chapter-create-dialog';
      const dialog = html.match(new RegExp('<dialog\\b[^>]*id="' + id + '"[\\s\\S]*?</dialog>'))?.[0] || '';
      const classes = (tag) => tag.match(/class="([^"]+)"/)?.[1].split(/\s+/);
      expect(classes(dialog)).toEqual(expect.arrayContaining(['app-dialog', 'project-form-dialog']));
      expect(dialog).toContain('data-app-dialog');
      expect(dialog).toContain('aria-labelledby="' + id + '-title"');
      expect(dialog).toContain('<h2 id="' + id + '-title">' + mode + ' Chapter</h2>');
      expect(dialog).toContain('data-dialog-close aria-label="Close ' + mode + ' Chapter"');
      expect(/<dialog\b[^>]*\sopen(?:\s|>)/.test(dialog)).toBe(open);
      expect(dialog).not.toContain('data-dialog-backdrop-static');
      for (const part of ['header', 'body', 'footer']) expect(dialog).toContain('class="app-dialog-' + part + '"');
      const forms = [...dialog.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(([value]) => value);
      expect(forms).toHaveLength(edit ? 2 : 1);
      expect(classes(forms[0])).toEqual(expect.arrayContaining(['app-dialog-form', 'project-form', 'project-edit-dialog-form']));
      expect(forms[0]).toContain('id="chapter-form" method="post" action="' + submitUrl + '"');
      expect(forms[0]).toContain('data-dialog-form data-dialog-async="false" novalidate');
      expect(forms[0]).toContain('type="submit" data-dialog-submit>' + (edit ? 'Save' : 'Create') + '</button>');
      const sections = [...forms[0].matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)];
      expect(sections).toHaveLength(1);
      expect(classes(sections[0][0])).toEqual(expect.arrayContaining([
        'settings-section', 'project-form-section', 'project-edit-dialog-section',
      ]));
      expect(dialog.match(/<h[1-6]\b[^>]*>Basic information<\/h[1-6]>/g)).toHaveLength(1);
      expect(sections[0][1]).toMatch(/^\s*<h3>Basic information<\/h3>\s*<div\b/);
      const body = sections[0][1].match(/<div\b[^>]*>([\s\S]*)<\/div>\s*$/)?.[0] || '';
      expect(classes(body)).toEqual(expect.arrayContaining(['project-form-section-body', 'project-edit-dialog-section-body']));
      expect(body).toContain('field app-dialog-field');
      expect(dialog.match(/name="title"/g)).toHaveLength(1);
      const titleId = edit ? 'chapter-edit-title' : 'chapter-create-title';
      expect(body).toContain('<label for="' + titleId + '">');
      expect(body).toContain('id="' + titleId + '" name="title" value="Chapter"');
      const ids = [...dialog.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
      for (const [, target] of dialog.matchAll(/<label\b[^>]*for="([^"]+)"/g)) expect(ids).toContain(target);
      for (const value of forms) expect(value).toContain('name="_csrf" value="csrf-token"');
      let depth = 0;
      for (const [tag] of dialog.matchAll(/<\/?form\b[^>]*>/g)) {
        depth += tag.startsWith('</') ? -1 : 1;
        expect(depth).toBeGreaterThanOrEqual(0);
        expect(depth).toBeLessThanOrEqual(1);
      }
      expect(depth).toBe(0);
      if (edit) {
        expect(forms[1]).toContain('id="chapter-delete-form" method="post" action="/notes/chapters/9/delete"');
        expect(forms[1]).toContain('data-confirm="Delete this Chapter permanently? This cannot be undone."');
        const deletion = dialog.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0] || '';
        expect(classes(deletion)).toEqual(expect.arrayContaining(['notes-workspace-disclosure', 'notes-workspace-disclosure--delete']));
        expect(deletion).toContain('<summary>Delete Chapter</summary>');
        expect(deletion).toContain(forms[1]);
        expect(dialog.indexOf(forms[1])).toBeGreaterThan(dialog.indexOf(forms[0]) + forms[0].length);
      } else {
        expect(dialog).not.toContain('chapter-delete-form');
      }
      expect(dialog).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
      expect(dialog).not.toContain('Danger zone');
      expect(dialog).not.toContain('>Manage<');
      expect(dialog).not.toContain('notes-hierarchy');
    }
    expect(notesCss).toContain('.notes-workspace-disclosure summary:focus-visible');
  });
  it('hosts rendered Book edit with shared styling, one actions section and separate deletion', () => {
    const env = nunjucks.configure(fileURLToPath(new URL('../src/views', import.meta.url)), {
      autoescape: true, noCache: true,
    });
    const book = { id: 7, title: 'Book', primaryImage: {
      state: 'available', previewUrl: '/projects/1/assets/42/preview', alt: 'Current cover',
      selectedSource: { kind: 'project_asset', id: 42 },
    } };
    const html = env.render('notes/books/detail.njk', {
      book, contents: [], _csrf: 'csrf-token', bookEditDialogOpen: true,
      bookEditForm: { book, values: { title: book.title }, errors: {}, submitUrl: '/notes/books/7' },
      chapterCreateForm: { values: {}, errors: {} },
    });
    const dialog = html.match(/<dialog\b[^>]*id="book-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(dialog).toMatch(/<dialog\b[^>]*data-app-dialog/);
    expect(dialog).toContain('aria-labelledby="book-edit-dialog-title"');
    expect(dialog).toContain('<h2 id="book-edit-dialog-title">Edit Book</h2>');
    expect(dialog).toContain('aria-label="Close Edit Book"');
    const classes = dialog.match(/<dialog\b[^>]*class="([^"]+)"/)?.[1].split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['app-dialog', 'project-form-dialog']));
    for (const part of ['header', 'body', 'footer']) expect(dialog).toContain('class="app-dialog-' + part + '"');
    const sections = [...dialog.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)].map(([section]) => section);
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section.match(/class="([^"]+)"/)[1].split(/\s+/)).toEqual(expect.arrayContaining([
        'settings-section', 'project-form-section', 'project-edit-dialog-section',
      ]));
      expect(section).toContain('project-form-section-body project-edit-dialog-section-body');
      expect(section).toContain('field app-dialog-field');
    }
    expect(sections[0]).toContain('<h3>Basic information</h3>');
    expect(sections[0]).toContain('<label for="title">Title');
    const actions = sections[1];
    expect(actions).toContain('aria-labelledby="book-actions-heading"');
    expect(actions).toContain('<h3 id="book-actions-heading">Book actions</h3>');
    expect(dialog.match(/<h[1-6]\b[^>]*>\s*Book actions\s*<\/h[1-6]>/g)).toHaveLength(1);
    expect(dialog).not.toContain('Secondary actions');
    expect(actions).toContain(book.primaryImage.previewUrl);
    expect(actions).toContain('name="cover"');
    expect(dialog.match(/class="notes-book-cover(?: |")/g)).toHaveLength(1);
    expect(dialog.match(/<img\b/g)).toHaveLength(1);
    expect(actions).toContain('form="book-delete-form"');
    expect(actions).toContain('data-confirm="Delete this Book permanently? This cannot be undone."');
    expect(actions).toContain('<summary>Delete Book</summary>');
    expect(dialog).not.toContain('<details open');
    expect(dialog).not.toContain('Danger zone');
    expect(dialog).not.toContain('>Manage<');
    expect(dialog).not.toContain('form="book-form">Edit</button>');
    expect(dialog).toContain('type="submit" data-dialog-submit>Save</button>');
    expect(dialog).toContain('data-dialog-form data-dialog-async="false"');
    const forms = [...dialog.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(([form]) => form);
    expect(forms).toHaveLength(2);
    expect(forms[0]).toContain('id="book-form" method="post" action="/notes/books/7"');
    expect(forms[1]).toContain('id="book-delete-form" method="post" action="/notes/books/7/delete"');
    for (const form of forms) expect(form).toContain('name="_csrf" value="csrf-token"');
    let depth = 0;
    for (const [tag] of dialog.matchAll(/<\/?form\b[^>]*>/g)) {
      depth += tag.startsWith('</') ? -1 : 1;
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
    const ids = [...dialog.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('extracts reusable Details markup without changing its visual contract', () => {
    expect(detailTemplate).toContain('{% set detailsHeadingId = "notes-detail-details-heading" %}');
    expect(detailTemplate).toContain('{% set detailsCreated = note.created_at %}');
    expect(detailTemplate).toContain('{% set detailsUpdated = note.updated_at %}');
    expect(detailTemplate).toContain('{% include "partials/notes-details-panel.njk" %}');
    expect(bookDetailTemplate).toContain('{% set detailsHeadingId = "notes-book-details-heading" %}');
    expect(bookDetailTemplate).toContain('{% set detailsCreated = book.created_at %}');
    expect(bookDetailTemplate).toContain('{% set detailsUpdated = book.updated_at %}');
    expect(bookDetailTemplate).toContain('{% include "partials/notes-details-panel.njk" %}');
    expect(detailsPanelTemplate).toContain('<section class="notes-detail-panel notes-detail-details" aria-labelledby="{{ detailsHeadingId }}">');
    expect(detailsPanelTemplate).toContain('<h2 id="{{ detailsHeadingId }}">Details</h2>');
    expect(detailsPanelTemplate).toContain('<dl class="detail-list">');
    expect(detailsPanelTemplate).toContain('<dt>Created</dt>');
    expect(detailsPanelTemplate).toContain('<dd>{{ detailsCreated }}</dd>');
    expect(detailsPanelTemplate).toContain('<dt>Updated</dt>');
    expect(detailsPanelTemplate).toContain('<dd>{{ detailsUpdated }}</dd>');

    const bookPrimaryImageStart = bookDetailTemplate.indexOf("{{ bookPrimaryImage.render(book, 'preview') }}");
    const bookNavigatorStart = bookDetailTemplate.indexOf('{% include "partials/book-navigator.njk" %}');
    const bookDetailsStart = bookDetailTemplate.indexOf('{% include "partials/notes-details-panel.njk" %}');
    expect(bookPrimaryImageStart).toBeLessThan(bookNavigatorStart);
    expect(bookNavigatorStart).toBeLessThan(bookDetailsStart);
  });

  it('keeps the detail layout content-dominant and stacks at narrow widths', () => {
    expect(detailTemplate).toContain('<div class="notes-page-detail-layout">');
    expect(detailTemplate).toContain('<div class="notes-page-sidebar">');
    expect(detailTemplate).toContain('<aside class="notes-page-detail-sidebar notes-surface notes-surface--compact">');
    expect(detailTemplate).toContain('{% include "partials/book-navigator.njk" %}');
    expect(detailTemplate).not.toContain('<h1');
    const pageHeadingStart = detailTemplate.indexOf('{% call pageHeading.render("Page") %}');
    const pageLayoutStart = detailTemplate.indexOf('<div class="notes-page-detail-layout">');
    const sidebarStart = detailTemplate.indexOf('<div class="notes-page-sidebar">');
    const navigatorStart = detailTemplate.indexOf('<aside class="notes-page-detail-sidebar');
    const detailsStart = detailTemplate.indexOf('{% include "partials/notes-details-panel.njk" %}');
    const contentStart = detailTemplate.indexOf('<div class="notes-page-detail-content">');
    const contentSurfaceStart = detailTemplate.indexOf('<section class="notes-detail-content"');
    const projectsStart = detailTemplate.indexOf('notes-detail-projects');
    const assetsStart = detailTemplate.indexOf('notes-detail-assets');
    expect(pageHeadingStart).toBeGreaterThanOrEqual(0);
    expect(pageHeadingStart).toBeLessThan(pageLayoutStart);
    expect(sidebarStart).toBeLessThan(navigatorStart);
    expect(navigatorStart).toBeLessThan(detailsStart);
    expect(detailsStart).toBeLessThan(contentStart);
    expect(contentStart).toBeLessThan(contentSurfaceStart);
    expect(contentSurfaceStart).toBeLessThan(projectsStart);
    expect(projectsStart).toBeLessThan(assetsStart);
    expect(detailTemplate).not.toContain('notes-detail-page-nav');
    expect(detailTemplate).not.toContain('{% include "partials/notes-page-nav.njk" %}');
    expect(detailTemplate).not.toContain('notes-hierarchy');
    expect(detailTemplate).toContain('<div class="notes-page-detail-content">');
    expect(detailTemplate).not.toContain('class="notes-detail-layout"');
    expect(detailTemplate).not.toContain('class="notes-detail-reading"');
    expect(detailTemplate).not.toContain('class="notes-detail-sidebar"');
    expect(detailTemplate).toContain('notes-detail-projects');
    expect(detailTemplate).toContain('notes-detail-assets');
    expect(detailTemplate).toContain('notes-detail-details');
    expect(notesCss).not.toContain('.notes-detail-layout');
    expect(notesCss).not.toContain('.notes-detail-reading');
    expect(notesCss).not.toContain('.notes-detail-sidebar');
    expect(notesCss).toContain('.notes-page-detail-layout');
    expect(notesCss).toContain('grid-template-columns: minmax(12rem, 16rem) minmax(0, 1fr);');
    expect(notesCss).toContain('.notes-page-sidebar');
    expect(notesCss).toMatch(/\.notes-page-sidebar\s*\{[\s\S]*?display: grid;[\s\S]*?gap: var\(--space-lg\);[\s\S]*?min-width: 0;/);
    expect(notesCss).toContain('.notes-page-detail-content');
    expect(notesCss).toContain('@media (max-width: 767px)');
    expect(notesCss).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(notesCss).toContain('.notes-page-sidebar { display: contents; }');
    expect(notesCss).not.toContain('.notes-hierarchy');
  });

  it('keeps the Page workspace section-heading hierarchy intentional', () => {
    expect(detailTemplate).toContain('<p class="notes-detail-kicker" id="notes-detail-content-heading">{{ note.title }}</p>');
    expect(detailTemplate).not.toContain('Reading view');
    expect(detailTemplate).not.toContain('<h2 id="notes-detail-content-heading">Content</h2>');
    expect(detailsPanelTemplate).toContain('<h2 id="{{ detailsHeadingId }}">Details</h2>');
    expect(detailTemplate).toContain('<h2 id="notes-detail-projects-heading">Projects</h2>');
    expect(detailTemplate).toContain('<h2 id="notes-detail-assets-heading">Assets</h2>');
    expect(noteFormTemplate).toContain('<h3 id="notes-connections-heading">Connections</h3>');
    expect(noteFormTemplate).toContain('Link this Page to existing projects and assets.');
    expect(noteFormTemplate).not.toContain('Writing surface');
    expect(noteFormTemplate).toContain('<h3 id="notes-editor-heading">Page contents</h3>');
    expect(noteFormTemplate).not.toContain('Secondary metadata');
    expect(notesCss).toContain('.notes-workspace-kicker');
    expect(notesCss).toContain('.notes-detail-kicker');
    expect(notesCss).toContain('.notes-detail-panel h2');
  });
});
