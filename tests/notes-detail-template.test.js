import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import { describe, expect, it } from 'vitest';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const DETAIL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/detail.njk', import.meta.url));
const CHAPTER_DETAIL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/chapters/detail.njk', import.meta.url));
const CHAPTER_FORM_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/chapters/form.njk', import.meta.url));
const BOOK_FORM_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/books/form.njk', import.meta.url));
const BOOK_DETAIL_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/books/detail.njk', import.meta.url));
const BOOK_ORDER_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/notes/books/order.njk', import.meta.url));
const HIERARCHY_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/partials/notes-hierarchy.njk', import.meta.url));
const CSS_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const detailTemplate = fs.readFileSync(DETAIL_TEMPLATE_PATH, 'utf8');
const chapterDetailTemplate = fs.readFileSync(CHAPTER_DETAIL_TEMPLATE_PATH, 'utf8');
const chapterFormTemplate = fs.readFileSync(CHAPTER_FORM_TEMPLATE_PATH, 'utf8');
const bookFormTemplate = fs.readFileSync(BOOK_FORM_TEMPLATE_PATH, 'utf8');
const bookDetailTemplate = fs.readFileSync(BOOK_DETAIL_TEMPLATE_PATH, 'utf8');
const bookOrderTemplate = fs.readFileSync(BOOK_ORDER_TEMPLATE_PATH, 'utf8');
const hierarchyTemplate = fs.readFileSync(HIERARCHY_TEMPLATE_PATH, 'utf8');
const notesCss = fs.readFileSync(CSS_PATH, 'utf8');

function renderHierarchy(context) {
  const environment = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
  return environment.render('partials/notes-hierarchy.njk', context);
}

describe('Notes Page detail hierarchy and layout contract', () => {
  it('has and uses the shared hierarchy partial', () => {
    expect(fs.existsSync(HIERARCHY_TEMPLATE_PATH)).toBe(true);
    expect(detailTemplate).toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(detailTemplate).not.toContain('Move Page');
    expect(detailTemplate).not.toContain('Danger zone');
    expect(detailTemplate).not.toContain('/move');
    expect(detailTemplate).not.toContain('/delete');
    expect(detailTemplate).toContain('Edit Page');
  });

  it('renders a direct Book Page without inventing a Chapter', () => {
    const html = renderHierarchy({
      book: { id: 7, title: 'Direct Book' },
      note: { id: 11, title: 'Direct Page' },
    });

    expect(html).toContain('<nav class="notes-hierarchy" aria-label="Page hierarchy">');
    expect(html).toContain('<a class="notes-hierarchy-link" href="/notes/books/7">Direct Book</a>');
    expect(html).toContain('<span class="notes-hierarchy-kind">Page</span>');
    expect(html).toContain('<span class="notes-hierarchy-current">Direct Page</span>');
    expect(html).not.toContain('Chapter');
    expect(html).not.toContain('/notes/chapters/');
  });

  it('renders a Chapter Page with linked Book and Chapter ancestors', () => {
    const html = renderHierarchy({
      book: { id: 7, title: 'Chapter Book' },
      chapter: { id: 9, title: 'Chapter One' },
      note: { id: 11, title: 'Chapter Page' },
    });

    expect(html).toContain('<a class="notes-hierarchy-link" href="/notes/books/7">Chapter Book</a>');
    expect(html).toContain('<a class="notes-hierarchy-link" href="/notes/chapters/9">Chapter One</a>');
    expect(html).toContain('<li class="notes-hierarchy-item notes-hierarchy-item--current" aria-current="page">');
    expect(html).toContain('<span class="notes-hierarchy-current">Chapter Page</span>');
  });

  it('renders a Chapter detail with linked Book and current Chapter context', () => {
    const html = renderHierarchy({
      book: { id: 7, title: 'Chapter Book' },
      chapter: { id: 9, title: 'Current Chapter' },
    });

    expect(chapterDetailTemplate).toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(html).toContain('<a class="notes-hierarchy-link" href="/notes/books/7">Chapter Book</a>');
    expect(html).toContain('<li class="notes-hierarchy-item notes-hierarchy-item--current" aria-current="page">');
    expect(html).toContain('<span class="notes-hierarchy-kind">Chapter</span>');
    expect(html).toContain('<span class="notes-hierarchy-current">Current Chapter</span>');
    expect(html).not.toContain('<a class="notes-hierarchy-link" href="/notes/chapters/9">Current Chapter</a>');
  });

  it('renders Book detail with shared hierarchy and Book as the current item', () => {
    const html = renderHierarchy({
      book: { id: 7, title: 'Current Book' },
    });

    expect(bookDetailTemplate).toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(bookDetailTemplate).toContain('New Page');
    expect(bookDetailTemplate).toContain('New Chapter');
    expect(bookDetailTemplate).toContain('Edit Book');
    expect(bookDetailTemplate).toContain('Change order');
    expect(bookDetailTemplate).toContain('notes-book-content-row');
    expect(html).toContain('<li class="notes-hierarchy-item notes-hierarchy-item--current" aria-current="page">');
    expect(html).toContain('<span class="notes-hierarchy-kind">Book</span>');
    expect(html).toContain('<span class="notes-hierarchy-current">Current Book</span>');
    expect(html).not.toContain('<a class="notes-hierarchy-link" href="/notes/books/7">Current Book</a>');
  });

  it('keeps the Book order shell read-only and separate by content type', () => {
    expect(bookOrderTemplate).toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(bookOrderTemplate).toContain('Book ordering controls will be available here in a future update.');
    expect(bookOrderTemplate).toContain('notes-book-content-list');
    expect(bookOrderTemplate).not.toContain('<form');
    expect(bookOrderTemplate).not.toContain('draggable');
    expect(bookOrderTemplate).not.toContain('orderedNoteIds');
    expect(bookOrderTemplate).not.toContain('orderedChapterIds');
  });

  it('keeps Chapter detail actions content-first and removes normal-view reorder and deletion controls', () => {
    expect(chapterDetailTemplate).toContain('New Page');
    expect(chapterDetailTemplate).toContain('Edit Chapter');
    expect(chapterDetailTemplate).toContain('Change order');
    expect(chapterDetailTemplate).toContain('notes-chapter-page-list');
    expect(chapterDetailTemplate).toContain('Edit Page');
    expect(chapterDetailTemplate).not.toContain('moveUpOrderedNoteIds');
    expect(chapterDetailTemplate).not.toContain('moveDownOrderedNoteIds');
    expect(chapterDetailTemplate).not.toContain('Move up');
    expect(chapterDetailTemplate).not.toContain('Move down');
    expect(chapterDetailTemplate).not.toContain('Danger zone');
    expect(chapterDetailTemplate).not.toContain('/notes/chapters/{{ chapter.id }}/delete');
    expect(chapterDetailTemplate).toContain('emptyActionUrl = "/notes/new?chapterId=" ~ chapter.id');
    expect(notesCss).toContain('.notes-chapter-page-row');
    expect(notesCss).toContain('.notes-chapter-page-actions');
  });

  it('keeps Chapter edit focused with Save/Cancel and a separate collapsed delete form', () => {
    expect(chapterFormTemplate).toContain('{% set submitLabel = "Save" if action == "Edit" else "Create" %}');
    expect(chapterFormTemplate).toContain('{% include "partials/notes-hierarchy.njk" %}');
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
    expect(bookFormTemplate).toContain('{% include "partials/notes-hierarchy.njk" %}');
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

  it('keeps the detail layout content-dominant and stacks at narrow widths', () => {
    expect(detailTemplate).toContain('class="notes-detail-layout"');
    expect(detailTemplate).toContain('class="notes-detail-reading"');
    expect(detailTemplate).toContain('class="notes-detail-sidebar"');
    expect(detailTemplate).toContain('notes-detail-projects');
    expect(detailTemplate).toContain('notes-detail-assets');
    expect(detailTemplate).toContain('notes-detail-details');
    expect(notesCss).toContain('.notes-detail-layout');
    expect(notesCss).toContain('grid-template-columns: minmax(0, 1fr) minmax(14rem, 18rem);');
    expect(notesCss).toContain('@media (max-width: 767px)');
    expect(notesCss).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(notesCss).toContain('.notes-hierarchy-link:focus-visible');
  });
});
