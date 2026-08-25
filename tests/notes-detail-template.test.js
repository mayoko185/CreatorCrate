import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DETAIL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/detail.njk', import.meta.url));
const DETAILS_PANEL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/partials/notes-details-panel.njk', import.meta.url));
const CHAPTER_DETAIL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/chapters/detail.njk', import.meta.url));
const CHAPTER_FORM_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/chapters/form.njk', import.meta.url));
const BOOK_FORM_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/books/form.njk', import.meta.url));
const BOOK_DETAIL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/books/detail.njk', import.meta.url));
const BOOK_ORDER_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/books/order.njk', import.meta.url));
const NOTE_FORM_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/form.njk', import.meta.url));
const HIERARCHY_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/partials/notes-hierarchy.njk', import.meta.url));
const CSS_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const detailTemplate = fs.readFileSync(DETAIL_TEMPLATE_PATH, 'utf8');
const detailsPanelTemplate = fs.readFileSync(DETAILS_PANEL_TEMPLATE_PATH, 'utf8');
const chapterDetailTemplate = fs.readFileSync(CHAPTER_DETAIL_TEMPLATE_PATH, 'utf8');
const chapterFormTemplate = fs.readFileSync(CHAPTER_FORM_TEMPLATE_PATH, 'utf8');
const bookFormTemplate = fs.readFileSync(BOOK_FORM_TEMPLATE_PATH, 'utf8');
const bookDetailTemplate = fs.readFileSync(BOOK_DETAIL_TEMPLATE_PATH, 'utf8');
const bookOrderTemplate = fs.readFileSync(BOOK_ORDER_TEMPLATE_PATH, 'utf8');
const noteFormTemplate = fs.readFileSync(NOTE_FORM_TEMPLATE_PATH, 'utf8');
const notesCss = fs.readFileSync(CSS_PATH, 'utf8');

describe('Notes Page detail hierarchy and layout contract', () => {
  it('keeps Page detail free of the obsolete hierarchy breadcrumb', () => {
    expect(fs.existsSync(HIERARCHY_TEMPLATE_PATH)).toBe(false);
    expect(detailTemplate).not.toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(detailTemplate).not.toContain('notes-hierarchy');
    expect(detailTemplate).not.toContain('Move Page');
    expect(detailTemplate).not.toContain('Danger zone');
    expect(detailTemplate).not.toContain('/move');
    expect(detailTemplate).not.toContain('/delete');
    expect(detailTemplate).toContain('Edit Page');
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
    expect(bookOrderTemplate).toContain('Arrow Up, Arrow Down, Home, or End');
    expect(bookOrderTemplate).toContain('notes-book-content-list');
    expect(bookOrderTemplate).toContain('This Book has no Chapters or direct Pages to order yet.');
    expect(bookOrderTemplate).not.toContain('Book ordering controls will be available here in a future update.');
    expect(bookOrderTemplate).not.toContain('orderedNoteIds');
    expect(bookOrderTemplate).not.toContain('orderedChapterIds');
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
    expect(chapterDetailTemplate).not.toContain('/notes/chapters/{{ chapter.id }}/delete');
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

  it('keeps Chapter edit focused with Save/Cancel and a separate collapsed delete form', () => {
    expect(chapterFormTemplate).toContain('{% set submitLabel = "Save" if action == "Edit" else "Create" %}');
    expect(chapterFormTemplate).not.toContain('notes-hierarchy');
    expect(chapterFormTemplate).toContain('form="chapter-form">{{ submitLabel }}</button>');
    expect(chapterFormTemplate).toContain('class="settings-section"');
    expect(chapterFormTemplate).toContain('class="notes-detail-panel"');
    expect(chapterFormTemplate).toContain('class="notes-workspace-disclosure notes-workspace-disclosure--delete"');
    expect(chapterFormTemplate).toContain('action="/notes/chapters/{{ chapter.id }}/delete"');
    expect(chapterFormTemplate).toContain('name="_csrf"');
    expect(chapterFormTemplate).toContain('data-confirm="Delete this Chapter permanently? This cannot be undone."');
    expect(chapterFormTemplate).not.toContain('Danger zone');
    expect(chapterFormTemplate).not.toContain('>Manage<');
    expect(chapterFormTemplate).not.toContain('<details open');

    const chapterFormStart = chapterFormTemplate.indexOf('<form id="chapter-form"');
    const chapterFormEnd = chapterFormTemplate.indexOf('</form>', chapterFormStart);
    const deleteFormStart = chapterFormTemplate.indexOf('<form id="chapter-delete-form"');
    expect(chapterFormTemplate.slice(chapterFormTemplate.indexOf('>', chapterFormStart) + 1, chapterFormEnd)).not.toContain('<form');
    expect(deleteFormStart).toBeGreaterThan(chapterFormEnd);
    expect(notesCss).toContain('.notes-workspace-disclosure summary:focus-visible');
  });

  it('keeps Book edit focused with Save/Cancel and a separate collapsed delete form', () => {
    expect(bookFormTemplate).toContain('{% set submitLabel = "Save" if action == "Edit" else "Create" %}');
    expect(bookFormTemplate).not.toContain('notes-hierarchy');
    expect(bookFormTemplate).toContain('form="book-form">{{ submitLabel }}</button>');
    expect(bookFormTemplate).toContain('class="settings-section"');
    expect(bookFormTemplate).toContain('<label for="title">Title');
    expect(bookFormTemplate).toContain('class="notes-detail-panel"');
    expect(bookFormTemplate).toContain('class="notes-workspace-disclosure notes-workspace-disclosure--delete"');
    expect(bookFormTemplate).toContain('action="/notes/books/{{ book.id }}/delete"');
    expect(bookFormTemplate).toContain('name="_csrf"');
    expect(bookFormTemplate).toContain('data-confirm="Delete this Book permanently? This cannot be undone."');
    expect(bookFormTemplate).not.toContain('form="book-form">Edit</button>');
    expect(bookFormTemplate).not.toContain('Danger zone');
    expect(bookFormTemplate).not.toContain('>Manage<');
    expect(bookFormTemplate).not.toContain('<details open');

    const bookFormStart = bookFormTemplate.indexOf('<form id="book-form"');
    const bookFormEnd = bookFormTemplate.indexOf('</form>', bookFormStart);
    const deleteFormStart = bookFormTemplate.indexOf('<form id="book-delete-form"');
    expect(bookFormStart).toBeGreaterThanOrEqual(0);
    expect(bookFormEnd).toBeGreaterThan(bookFormStart);
    expect(bookFormTemplate.slice(bookFormTemplate.indexOf('>', bookFormStart) + 1, bookFormEnd)).not.toContain('<form');
    expect(deleteFormStart).toBeGreaterThan(bookFormEnd);
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
    expect(noteFormTemplate).toContain('<h2 id="notes-connections-heading">Connections</h2>');
    expect(noteFormTemplate).toContain('Link this Page to existing projects and assets.');
    expect(noteFormTemplate).toContain('<p class="notes-workspace-kicker">Writing surface</p>');
    expect(noteFormTemplate).toContain('<h2 id="notes-editor-heading">Page content</h2>');
    expect(noteFormTemplate).not.toContain('Secondary metadata');
    expect(notesCss).toContain('.notes-workspace-kicker');
    expect(notesCss).toContain('.notes-detail-kicker');
    expect(notesCss).toContain('.notes-detail-panel h2');
  });
});
