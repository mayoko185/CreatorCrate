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

  it('scopes the richer Book navigator treatment to polished detail and embedded dialog hosts', () => {
    expect(bookDetailTemplate).toContain(
      '<aside class="notes-page-detail-sidebar notes-book-detail-sidebar notes-surface notes-surface--compact">',
    );
    expect(detailTemplate).toContain(
      '<aside class="notes-page-detail-sidebar notes-book-detail-sidebar notes-surface notes-surface--compact">',
    );
    expect(chapterDetailTemplate).toContain(
      '<aside class="notes-chapter-detail-sidebar notes-book-detail-sidebar notes-surface notes-surface--compact">',
    );
    expect(noteFormTemplate).toContain(
      '<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded" aria-label="Book contents">',
    );

    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav\s*\{[^}]*margin-top: var\(--space-lg\);/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar--embedded \.notes-book-nav\s*\{[^}]*margin-top: 0;/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-heading\s*\{[^}]*margin: 0 0 var\(--space-md\);[^}]*padding: 0 0 var\(--space-sm\);[^}]*border-bottom: 1px solid var\(--border\);/);
    expect(notesCss).not.toContain('.notes-book-detail-sidebar .notes-book-nav-list > .notes-book-nav-item + .notes-book-nav-item {');
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-list > \.notes-book-nav-chapter \+ \.notes-book-nav-item,\s*\.notes-book-detail-sidebar \.notes-book-nav-list > \.notes-book-nav-page \+ \.notes-book-nav-chapter\s*\{[^}]*margin-top: var\(--space-md\);[^}]*padding-top: var\(--space-md\);[^}]*border-top: 1px solid var\(--border\);/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-summary\s*\{[^}]*min-height: 2\.5rem;[^}]*padding: var\(--space-sm\) var\(--space-md\);/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-disclosure > p\.notes-book-nav-page--child\s*\{[^}]*margin: var\(--space-xs\) 0 var\(--space-sm\);[^}]*border: 0;/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-pages\s*\{[^}]*gap: var\(--space-xs\);[^}]*border-inline-start: 1px solid var\(--border-strong\);/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-pages > \.notes-book-nav-page--child\s*\{[^}]*margin: 0;[^}]*border: 0;/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-page:not\(\.notes-book-nav-page--child\) > \.notes-book-nav-page-link\s*\{[^}]*position: relative;[^}]*min-height: 2\.5rem;[^}]*padding-inline-start: calc\(/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-page:not\(\.notes-book-nav-page--child\) > \.notes-book-nav-page-link::before\s*\{[^}]*position: absolute;[^}]*inset-block: var\(--space-sm\);[^}]*inset-inline-start: calc\(var\(--notes-book-nav-marker-column\) \+ var\(--notes-book-nav-marker-gap\)\);[^}]*width: 1px;[^}]*background: var\(--border-strong\);/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-page-link\s*\{[^}]*color: var\(--muted\);[^}]*font-weight: 400;/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-pages > \.notes-book-nav-page--child > \.notes-book-nav-page-link\s*\{[^}]*color: var\(--muted\);[^}]*font-weight: 400;/);
    expect(notesCss).toMatch(/\.notes-book-nav-chapter-title,\s*\.notes-book-nav-page-link\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-item--current > \.notes-book-nav-disclosure > \.notes-book-nav-summary\s*\{[^}]*border-inline-start: 0;[^}]*background: rgba\(34, 211, 238, 0\.12\);[^}]*box-shadow: inset 0 0 0 1px rgba\(34, 211, 238, 0\.35\);/);
    expect(notesCss).not.toMatch(/\.notes-book-nav-summary,\s*\.notes-book-detail-sidebar \.notes-book-nav-page\.notes-book-nav-item--current > \.notes-book-nav-page-link\s*\{[^}]*background: rgba\(34, 211, 238, 0\.12\);/);
    expect(notesCss).not.toMatch(/\.notes-book-nav-summary:hover,\s*\.notes-book-detail-sidebar \.notes-book-nav-page\.notes-book-nav-item--current > \.notes-book-nav-page-link:hover\s*\{[^}]*background: rgba\(34, 211, 238, 0\.17\);/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-page\.notes-book-nav-item--current > \.notes-book-nav-page-link\[aria-current="page"\]\s*\{[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none;[^}]*color: var\(--accent\);[^}]*font-weight: 700;[^}]*text-decoration: none;/);
    expect(notesCss).toMatch(/\.notes-book-detail-sidebar \.notes-book-nav-page\.notes-book-nav-item--current > \.notes-book-nav-page-link\[aria-current="page"\]:hover,[^}]*:focus-visible\s*\{[^}]*background: var\(--surface-hover\);[^}]*text-decoration: underline;/);
    expect(notesCss).toContain('.notes-book-detail-sidebar .notes-book-nav-summary:focus-visible');
    expect(notesCss).not.toContain('.notes-book-detail-sidebar .notes-book-nav-book-link {');
  });

  it('wraps only the Page-dialog Book contents body in a closed native disclosure', () => {
    const headingStart = noteFormTemplate.indexOf('<h3 id="notes-book-contents-heading">Book contents</h3>');
    const disclosureStart = noteFormTemplate.indexOf('<details class="notes-book-contents-disclosure">');
    const summaryStart = noteFormTemplate.indexOf('<summary class="notes-book-contents-toggle">');
    const bodyStart = noteFormTemplate.indexOf('<div class="project-form-section-body project-edit-dialog-section-body">');
    const navigatorStart = noteFormTemplate.indexOf('<aside class="notes-workspace-context notes-book-detail-sidebar notes-book-detail-sidebar--embedded" aria-label="Book contents">');

    expect(headingStart).toBeGreaterThanOrEqual(0);
    expect(headingStart).toBeLessThan(disclosureStart);
    expect(disclosureStart).toBeLessThan(summaryStart);
    expect(summaryStart).toBeLessThan(bodyStart);
    expect(bodyStart).toBeLessThan(navigatorStart);
    expect(noteFormTemplate).not.toContain('<details class="notes-book-contents-disclosure" open>');
    expect(noteFormTemplate).toContain('<span class="notes-book-contents-toggle-label notes-book-contents-toggle-label--expand">Expand</span>');
    expect(noteFormTemplate).toContain('<span class="notes-book-contents-toggle-label notes-book-contents-toggle-label--collapse">Collapse</span>');
    const summary = noteFormTemplate.slice(summaryStart, noteFormTemplate.indexOf('</summary>', summaryStart));
    expect(summary).not.toContain('Book contents');
    expect(summary).not.toMatch(/aria-label|aria-expanded/);
    expect(noteFormTemplate).not.toContain('bookNavInitialMode');
    expect(notesCss).toMatch(/\[data-notes-dialog-compact-section\] > \.notes-book-contents-disclosure > \.project-edit-dialog-section-body\s*\{[^}]*padding: 0\.75rem;/);
    expect(notesCss).toMatch(/\.notes-book-contents-toggle\s*\{[^}]*border: 1px solid var\(--border\);[^}]*border-top: 0;[^}]*background: var\(--surface\);[^}]*color: var\(--muted\);/);
    expect(notesCss).toMatch(/\.notes-book-contents-toggle:focus-visible\s*\{[^}]*outline: 2px solid var\(--focus-ring\);/);
    expect(notesCss).toMatch(/\.notes-book-contents-disclosure\[open\] \.notes-book-contents-toggle-label--expand\s*\{[^}]*display: none;/);
    expect(notesCss).toMatch(/\.notes-book-contents-disclosure\[open\] \.notes-book-contents-toggle-label--collapse\s*\{[^}]*display: inline;/);
  });

  it('bounds polished Page dialog navigator options without adding Book detail-only content', () => {
    const hideHeadingStart = noteFormTemplate.indexOf('{% set bookNavHideHeading = true %}');
    const hideChapterLinksStart = noteFormTemplate.indexOf('{% set bookNavHideChapterLinks = true %}');
    const navigatorStart = noteFormTemplate.indexOf('{% include "partials/book-navigator.njk" %}');
    const hideChapterLinksReset = noteFormTemplate.indexOf('{% set bookNavHideChapterLinks = false %}');
    const hideHeadingReset = noteFormTemplate.indexOf('{% set bookNavHideHeading = false %}');

    expect(hideHeadingStart).toBeLessThan(hideChapterLinksStart);
    expect(hideChapterLinksStart).toBeLessThan(navigatorStart);
    expect(navigatorStart).toBeLessThan(hideChapterLinksReset);
    expect(hideChapterLinksReset).toBeLessThan(hideHeadingReset);
    expect(noteFormTemplate).not.toContain('bookNavInitialMode');
    expect(noteFormTemplate).not.toContain('bookPrimaryImage');
    expect(noteFormTemplate).not.toContain('notes-book-cover');
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

  it('renders Book detail with its polished navigator and the shared preview host instead of the retired outline', () => {
    expect(bookDetailTemplate).not.toContain('{% include "partials/notes-hierarchy.njk" %}');
    expect(bookDetailTemplate).toContain('page_title = "Notes');
    expect(bookDetailTemplate).toContain('~ book.title %}');
    expect(bookDetailTemplate).toContain('New Page');
    expect(bookDetailTemplate).toContain('New Chapter');
    expect(bookDetailTemplate).toContain('Edit Book');
    expect(bookDetailTemplate).toContain('Change order');
    expect(bookDetailTemplate).toContain('{% include "partials/book-navigator.njk" %}');
    expect(bookDetailTemplate).toContain('{% include "partials/book-page-previews.njk" %}');
    expect(bookDetailTemplate).not.toContain('<nav class="book-outline"');
    expect(bookDetailTemplate).not.toContain('book-outline-summary');
    expect(bookDetailTemplate).not.toMatch(/<div class="notes-page-detail-content">\s*<div class="notes-surface">/);
    expect(bookDetailTemplate).not.toContain('notes-book-content-row');
    expect(bookDetailTemplate).not.toContain('notes-hierarchy');
  });

  it('keeps Page detail preview-free while preserving the polished Book navigator', () => {
    expect(detailTemplate).toContain('{% include "partials/book-navigator.njk" %}');
    expect(detailTemplate).not.toContain('{% include "partials/book-page-previews.njk" %}');
    expect(detailTemplate).toContain('notes-detail-content');
    expect(detailTemplate).toContain('notes-detail-projects');
    expect(detailTemplate).toContain('notes-detail-assets');
  });

  it('renders the Book order page as one canonical mixed hierarchy form', () => {
    const env = nunjucks.configure(fileURLToPath(new URL('../src/views', import.meta.url)), {
      autoescape: true,
    });
    const hierarchy = {
      version: 1,
      expected: [
        { type: 'chapter', id: 11, pages: [21] },
        { type: 'page', id: 22 },
      ],
      target: [
        { type: 'chapter', id: 11, pages: [21] },
        { type: 'page', id: 22 },
      ],
    };
    const html = env.render('notes/books/order.njk', {
      book: { id: 7 },
      bookHierarchy: {
        submission: JSON.stringify(hierarchy),
        items: [
          {
            type: 'chapter', id: 11, chapter: { title: 'First Chapter' },
            pages: [{ id: 21, title: 'Nested Page' }],
          },
          { type: 'page', id: 22, page: { title: 'Root Page' } },
        ],
      },
    });

    expect(html).toContain('<form id="notes-book-order-form" method="post" action="/notes/books/7/hierarchy/reorder" data-book-hierarchy-form');
    expect(html.match(/name="hierarchy"/g)).toHaveLength(1);
    const hierarchyValue = html.match(/name="hierarchy" data-book-hierarchy-input value="([^"]+)"/)?.[1];
    expect(hierarchyValue).toBeTruthy();
    expect(JSON.parse(hierarchyValue.replaceAll('&quot;', '"'))).toEqual(hierarchy);
    expect(html).not.toMatch(/name="(?:orderedItems|orderedNoteIds)"/);
    expect(html).toContain('data-book-hierarchy-editor');
    const extractHierarchyContainer = (containerKey) => {
      const startPattern = new RegExp(`<ol\\b[^>]*data-book-hierarchy-container="${containerKey}"[^>]*>`);
      const startMatch = startPattern.exec(html);
      expect(startMatch).toBeTruthy();
      const tagPattern = /<\/?ol\b[^>]*>/g;
      tagPattern.lastIndex = startMatch.index;
      let depth = 0;
      let tagMatch;
      while ((tagMatch = tagPattern.exec(html))) {
        depth += tagMatch[0].startsWith('</') ? -1 : 1;
        if (depth === 0) return html.slice(startMatch.index, tagPattern.lastIndex);
      }
      throw new Error(`Unclosed hierarchy container: ${containerKey}`);
    };
    const directItemKeys = (container) => {
      const keys = [];
      const tagPattern = /<\/?(?:ol|li)\b[^>]*>/g;
      let listDepth = 0;
      let tagMatch;
      while ((tagMatch = tagPattern.exec(container))) {
        const tag = tagMatch[0];
        if (tag.startsWith('<ol')) listDepth += 1;
        if (tag.startsWith('</ol')) listDepth -= 1;
        if (tag.startsWith('<li') && listDepth === 1) {
          keys.push(tag.match(/data-content-key="([^"]+)"/)?.[1]);
        }
      }
      return keys;
    };
    const rootContainer = extractHierarchyContainer('root');
    const chapterContainer = extractHierarchyContainer('chapter:11');
    expect(directItemKeys(rootContainer)).toEqual(['chapter:11', 'page:22']);
    expect(directItemKeys(chapterContainer)).toEqual(['page:21']);
    expect(directItemKeys(rootContainer)).not.toContain('page:21');
    expect(rootContainer).toContain(chapterContainer);
    expect(html).not.toContain('data-book-content-reorder-');
    expect(html).toContain('Use the handles with Up, Down, Home, or End to reorder within the current container. Use each Page destination and Move control to move it between the Book root and Chapters. Dragging remains available. Select Save to apply the draft hierarchy.');
    expect(html).toContain('notes-book-content-list');
    const hierarchyForm = html.match(/<form id="notes-book-order-form"[\s\S]*?<\/form>/)?.[0];
    expect(hierarchyForm).toBeTruthy();
    expect(hierarchyForm).toMatch(/<button class="button button-primary" type="submit" form="notes-book-order-form" data-dialog-submit>Save<\/button>/);
    expect(hierarchyForm).toMatch(/<button class="button button-secondary" type="button" data-dialog-close>Cancel<\/button>/);

    const emptyHtml = env.render('notes/books/order.njk', {
      book: { id: 7 },
      bookHierarchy: { submission: JSON.stringify({ version: 1, expected: [], target: [] }), items: [] },
    });
    expect(emptyHtml).toContain('This Book has no Chapters or Pages to order yet.');
    expect(emptyHtml).not.toContain('data-book-hierarchy-container="root"');
    expect(emptyHtml).not.toContain('data-dialog-submit');
    expect(notesCss).toMatch(/\.notes-reorder-row--compact\s*\{[\s\S]*?gap: var\(--space-xs\);[\s\S]*?padding: var\(--space-xs\) var\(--space-sm\);/);
    expect(notesCss).toMatch(/\.notes-reorder-row--compact \.notes-reorder-position\s*\{ margin-top: 0; \}/);
    expect(notesCss).toMatch(/\.notes-reorder-row--compact :is\([^)]*\.notes-reorder-position[^)]*\)\s*\{[\s\S]*?pointer-events: none;/);
  });

  it('keeps Chapter detail actions content-first and removes normal-view reorder and deletion controls', () => {
    expect(chapterDetailTemplate).toContain('<div class="notes-chapter-detail-layout">');
    expect(chapterDetailTemplate).toContain('<aside class="notes-chapter-detail-sidebar notes-book-detail-sidebar notes-surface notes-surface--compact">');
    expect(chapterDetailTemplate).toContain('<div class="notes-chapter-detail-content notes-surface">');
    expect(chapterDetailTemplate).toContain('{% import "partials/book-primary-image.njk" as bookPrimaryImage %}');
    const coverStart = chapterDetailTemplate.indexOf("{{ bookPrimaryImage.render(book, 'preview') }}");
    const hideChapterLinksStart = chapterDetailTemplate.indexOf('{% set bookNavHideChapterLinks = true %}');
    const navigatorStart = chapterDetailTemplate.indexOf('{% include "partials/book-navigator.njk" %}');
    const hideChapterLinksReset = chapterDetailTemplate.indexOf('{% set bookNavHideChapterLinks = false %}');
    const pageDialogStart = chapterDetailTemplate.indexOf('{% include "notes/create-dialog.njk" %}');
    expect(coverStart).toBeGreaterThanOrEqual(0);
    expect(coverStart).toBeLessThan(hideChapterLinksStart);
    expect(hideChapterLinksStart).toBeLessThan(navigatorStart);
    expect(navigatorStart).toBeLessThan(hideChapterLinksReset);
    expect(hideChapterLinksReset).toBeLessThan(pageDialogStart);
    expect(chapterDetailTemplate).not.toContain('bookNavHideBookLink');
    expect(chapterDetailTemplate).not.toContain('navCurrentPageId');
    expect(chapterDetailTemplate).not.toContain('bookNavInitialMode');
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
    expect(sections[0]).toContain('<h3>Book details</h3>');
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

  it('lets Page detail opt into the established Project Details presentation without changing Book detail', () => {
    expect(detailTemplate).toContain('{% set detailsHeadingId = "notes-detail-details-heading" %}');
    expect(detailTemplate).toContain('{% set detailsCreated = note.created_at %}');
    expect(detailTemplate).toContain('{% set detailsUpdated = note.updated_at %}');
    const pagePresentationStart = detailTemplate.indexOf('{% set notesDetailsPresentation = "project-section" %}');
    const pageDetailsStart = detailTemplate.indexOf('{% include "partials/notes-details-panel.njk" %}');
    const pagePresentationReset = detailTemplate.indexOf('{% set notesDetailsPresentation = none %}');
    expect(pagePresentationStart).toBeLessThan(pageDetailsStart);
    expect(pageDetailsStart).toBeLessThan(pagePresentationReset);
    expect(detailTemplate).toContain('{% include "partials/notes-details-panel.njk" %}');
    expect(bookDetailTemplate).toContain('{% set detailsHeadingId = "notes-book-details-heading" %}');
    expect(bookDetailTemplate).toContain('{% set detailsCreated = book.created_at %}');
    expect(bookDetailTemplate).toContain('{% set detailsUpdated = book.updated_at %}');
    expect(bookDetailTemplate).toContain('{% include "partials/notes-details-panel.njk" %}');
    expect(bookDetailTemplate).not.toContain('notesDetailsPresentation');
    expect(detailsPanelTemplate).toContain("{% if notesDetailsPresentation == 'project-section' %}project-detail-info project-detail-section{% else %}notes-detail-panel{% endif %} notes-detail-details");
    expect(detailsPanelTemplate).toContain('<h2 id="{{ detailsHeadingId }}">Details</h2>');
    expect(detailsPanelTemplate).toContain("{% if notesDetailsPresentation == 'project-section' %}<div class=\"project-detail-section-body\">{% endif %}");
    expect(detailsPanelTemplate).toContain('<dl class="detail-list">');
    expect(detailsPanelTemplate).toContain('<dt>Created</dt>');
    expect(detailsPanelTemplate).toContain('<dd>{{ detailsCreated }}</dd>');
    expect(detailsPanelTemplate).toContain('<dt>Updated</dt>');
    expect(detailsPanelTemplate).toContain('<dd>{{ detailsUpdated }}</dd>');
    expect(notesCss).toMatch(/\.project-detail-section > h2\s*\{[^}]*font-size: 0\.75rem;[^}]*font-family: var\(--mono\);[^}]*text-transform: uppercase;[^}]*color: var\(--muted\);[^}]*border-bottom: 1px solid var\(--border\);/);
    expect(notesCss).toMatch(/\.project-detail-section-body\s*\{[^}]*padding: var\(--space-md\) var\(--space-lg\);/);
    expect(notesCss).not.toContain('.notes-detail-details.project-detail-section');

    const bookPrimaryImageStart = bookDetailTemplate.indexOf("{{ bookPrimaryImage.render(book, 'preview') }}");
    const bookNavigatorStart = bookDetailTemplate.indexOf('{% include "partials/book-navigator.njk" %}');
    const bookDetailsStart = bookDetailTemplate.indexOf('{% include "partials/notes-details-panel.njk" %}');
    expect(bookPrimaryImageStart).toBeLessThan(bookNavigatorStart);
    expect(bookNavigatorStart).toBeLessThan(bookDetailsStart);

    expect(detailTemplate).toContain('{% import "partials/book-primary-image.njk" as bookPrimaryImage %}');
    const pagePrimaryImageStart = detailTemplate.indexOf("{{ bookPrimaryImage.render(book, 'preview') }}");
    const pageNavigatorStart = detailTemplate.indexOf('{% include "partials/book-navigator.njk" %}');
    expect(pagePrimaryImageStart).toBeGreaterThanOrEqual(0);
    expect(pagePrimaryImageStart).toBeLessThan(pageNavigatorStart);
    expect(detailTemplate).not.toContain('<img');
    expect(detailTemplate).not.toContain('class="notes-book-cover');
  });

  it('places Book controls on the Projects toolbar path and bounds the Book navigator overrides', () => {
    const headingEnd = bookDetailTemplate.indexOf('{% endcall %}');
    const noticeInclude = bookDetailTemplate.indexOf('{% include "partials/notice.njk" %}');
    const toolbarStart = bookDetailTemplate.indexOf('<div class="asset-viewer-display-controls" data-book-detail-toolbar>');
    const projectActionsStart = bookDetailTemplate.indexOf('<div class="project-filter-actions project-filter-actions--projects">');
    const layoutStart = bookDetailTemplate.indexOf('<div class="notes-page-detail-layout">');
    expect(headingEnd).toBeLessThan(noticeInclude);
    expect(noticeInclude).toBeLessThan(toolbarStart);
    expect(toolbarStart).toBeLessThan(projectActionsStart);
    expect(projectActionsStart).toBeLessThan(layoutStart);

    const initialModeStart = bookDetailTemplate.indexOf('{% set bookNavInitialMode = bookDetailSidebarNavigationMode %}');
    const hideBookLinkStart = bookDetailTemplate.indexOf('{% set bookNavHideBookLink = true %}');
    const hideChapterLinksStart = bookDetailTemplate.indexOf('{% set bookNavHideChapterLinks = true %}');
    const navigatorStart = bookDetailTemplate.indexOf('{% include "partials/book-navigator.njk" %}');
    const hideChapterLinksReset = bookDetailTemplate.indexOf('{% set bookNavHideChapterLinks = false %}');
    const hideBookLinkReset = bookDetailTemplate.indexOf('{% set bookNavHideBookLink = false %}');
    const initialModeReset = bookDetailTemplate.indexOf('{% set bookNavInitialMode = none %}');
    expect(initialModeStart).toBeLessThan(hideBookLinkStart);
    expect(hideBookLinkStart).toBeLessThan(hideChapterLinksStart);
    expect(hideChapterLinksStart).toBeLessThan(navigatorStart);
    expect(navigatorStart).toBeLessThan(hideChapterLinksReset);
    expect(hideChapterLinksReset).toBeLessThan(hideBookLinkReset);
    expect(hideBookLinkReset).toBeLessThan(initialModeReset);
  });

  it('keeps the detail layout content-dominant and stacks at narrow widths', () => {
    expect(detailTemplate).toContain('<div class="notes-page-detail-layout">');
    expect(detailTemplate).toContain('<div class="notes-page-sidebar">');
    expect(detailTemplate).toContain('<aside class="notes-page-detail-sidebar notes-book-detail-sidebar notes-surface notes-surface--compact">');
    const hideChapterLinksStart = detailTemplate.indexOf('{% set bookNavHideChapterLinks = true %}');
    const navigatorStart = detailTemplate.indexOf('{% include "partials/book-navigator.njk" %}');
    const hideChapterLinksReset = detailTemplate.indexOf('{% set bookNavHideChapterLinks = false %}');
    expect(hideChapterLinksStart).toBeLessThan(navigatorStart);
    expect(navigatorStart).toBeLessThan(hideChapterLinksReset);
    expect(detailTemplate).not.toContain('bookNavInitialMode');
    expect(detailTemplate).not.toContain('<h1');
    const pageHeadingStart = detailTemplate.indexOf('{% call pageHeading.render("Page") %}');
    const pageLayoutStart = detailTemplate.indexOf('<div class="notes-page-detail-layout">');
    const sidebarStart = detailTemplate.indexOf('<div class="notes-page-sidebar">');
    const sidebarNavigatorStart = detailTemplate.indexOf('<aside class="notes-page-detail-sidebar');
    const detailsStart = detailTemplate.indexOf('{% include "partials/notes-details-panel.njk" %}');
    const contentStart = detailTemplate.indexOf('<div class="notes-page-detail-content">');
    const contentSurfaceStart = detailTemplate.indexOf('<section class="notes-detail-content"');
    const projectsStart = detailTemplate.indexOf('notes-detail-projects');
    const assetsStart = detailTemplate.indexOf('notes-detail-assets');
    expect(pageHeadingStart).toBeGreaterThanOrEqual(0);
    expect(pageHeadingStart).toBeLessThan(pageLayoutStart);
    expect(sidebarStart).toBeLessThan(sidebarNavigatorStart);
    expect(sidebarNavigatorStart).toBeLessThan(detailsStart);
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

  it('restores the small Page content heading and scopes its corrected size', () => {
    expect(detailTemplate).toContain('{% block body_class %}notes-page-detail-page{% endblock %}');
    expect(detailTemplate).toContain('<section class="notes-detail-content" aria-labelledby="notes-detail-content-heading">');
    expect(detailTemplate).toContain('<div class="notes-detail-section-heading">');
    expect(detailTemplate).toContain('<p class="notes-detail-kicker notes-detail-content-heading" id="notes-detail-content-heading">{{ note.title }}</p>');
    expect(detailTemplate).not.toContain('aria-label="Page contents"');
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
    expect(notesCss).toMatch(/\.app-section-title\s*\{[^}]*font-size: 0\.8125rem;/);
    expect(notesCss).not.toContain('.notes-page-detail-page .app-section-title');
    expect(notesCss).toMatch(/\.notes-page-detail-page \.notes-detail-content-heading\s*\{[^}]*font-size: 1rem;/);
    expect(notesCss).toContain('.notes-detail-panel h2');
  });
});
