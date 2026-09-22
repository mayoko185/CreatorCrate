/**
 * Shared page-component contracts and representative rendered integration.
 * Focused HTTP/browser suites own domain-specific page behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nunjucks from 'nunjucks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const CSS_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const css = fs.readFileSync(CSS_PATH, 'utf8');

function renderPartial(templateName, context = {}) {
  return nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true }).render(templateName, context);
}

function renderString(template) {
  return nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true }).renderString(template, {});
}

function listProductionTemplates(dir = VIEWS_DIR) {
  const templates = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) templates.push(...listProductionTemplates(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.njk')) templates.push(fullPath);
  }
  return templates;
}

function countTags(html, tag) {
  return (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
}

function topLevelBookItems(html) {
  const items = [];
  const tags = /<\/?li\b[^>]*>/g;
  let depth = 0;
  let start = null;
  let match;
  while ((match = tags.exec(html)) !== null) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0 && start !== null) {
        items.push(html.slice(start, match.index + match[0].length));
        start = null;
      }
    } else {
      if (depth === 0 && /class="notes-book-nav-item notes-book-nav-(chapter|page)(?: [^"]*)?"/.test(match[0])) start = match.index;
      depth += 1;
    }
  }
  return items;
}

describe('Notes navigation partials', () => {
  it('renders labelled Page navigation with shallow links and a non-linked current Page', () => {
    const html = renderPartial('partials/notes-page-nav.njk', {
      pageNavLabel: 'Pages in Chapter One',
      pageNavPages: [
        { id: 101, title: 'Opening Page' },
        { id: 102, title: 'Current Page' },
        { id: 103, title: 'Closing Page' },
      ],
      pageNavCurrentId: '102',
    });
    expect(html).toContain('<nav class="notes-page-nav" aria-label="Pages in Chapter One">');
    expect(html).toContain('<a class="notes-page-nav-link" href="/notes/101">Opening Page</a>');
    expect(html).toContain('<a class="notes-page-nav-link" href="/notes/103">Closing Page</a>');
    expect(html).toContain('class="notes-page-nav-item notes-page-nav-item--current"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<span class="notes-page-nav-current">Current Page</span>');
    expect(html).not.toContain('href="/notes/102"');
  });

  describe('compact Book navigator', () => {
    const book = { id: 42, title: 'The Navigator Book' };
    const renderNavigator = (overrides = {}) => renderPartial('partials/book-navigator.njk', {
      book, bookContents: [], ...overrides,
    });

    it('preserves mixed top-level order and nested shallow Page links', () => {
      const html = renderNavigator({ bookContents: [
        { type: 'chapter', id: 10, chapter: { title: 'Chapter One' }, pages: [
          { id: 101, title: 'Nested First' }, { id: 102, title: 'Nested Second' },
        ] },
        { type: 'page', id: 201, page: { title: 'Direct Page' } },
        { type: 'chapter', id: 20, chapter: { title: 'Chapter Two' }, pages: [] },
      ] });
      const items = topLevelBookItems(html);
      expect(html).toMatch(/<nav[^>]*class="notes-book-nav"[^>]*aria-label="Contents of The Navigator Book"/);
      expect(html).toContain('<a class="notes-book-nav-book-link" href="/notes/books/42">The Navigator Book</a>');
      expect(items).toHaveLength(3);
      expect(items[0]).toContain('Chapter One');
      expect(items[1]).toContain('Direct Page');
      expect(items[2]).toContain('Chapter Two');
      expect(items[0].indexOf('Nested First')).toBeLessThan(items[0].indexOf('Nested Second'));
      expect(items[0]).toContain('href="/notes/101"');
      expect(items[0]).toContain('href="/notes/102"');
      expect(items[0]).toContain('href="/notes/chapters/10"');
    });

    it('marks typed current IDs and expands only the containing Chapter', () => {
      const contents = [
        { type: 'chapter', id: 10, chapter: { title: 'First Chapter' }, pages: [{ id: 101, title: 'First Page' }] },
        { type: 'chapter', id: 20, chapter: { title: 'Second Chapter' }, pages: [{ id: '202', title: 'Current Page' }] },
      ];
      const chapterItems = topLevelBookItems(renderNavigator({ bookContents: contents, navCurrentChapterId: '10' }));
      const pageItems = topLevelBookItems(renderNavigator({ bookContents: contents, navCurrentPageId: 202 }));
      expect(chapterItems[0]).toMatch(/<details class="notes-book-nav-disclosure" open>/);
      expect(chapterItems[0]).toMatch(/href="\/notes\/chapters\/10"[^>]*aria-current="page"/);
      expect(chapterItems[1]).not.toContain(' open>');
      expect(pageItems[0]).not.toContain(' open>');
      expect(pageItems[1]).toMatch(/<details class="notes-book-nav-disclosure" open>/);
      expect(pageItems[1]).toMatch(/href="\/notes\/202"[^>]*aria-current="page"[^>]*>Current Page<\/a>/);
    });

    it('honors independent Book-link and Chapter-link suppression', () => {
      const contents = [{ type: 'chapter', id: 10, chapter: { title: 'Chapter' }, pages: [{ id: 101, title: 'Page' }] }];
      const withoutBook = renderNavigator({ bookContents: contents, bookNavHideBookLink: true });
      const withoutChapter = renderNavigator({ bookContents: contents, bookNavHideChapterLinks: true });
      expect(withoutBook).not.toContain('notes-book-nav-book-link');
      expect(withoutBook).toContain('href="/notes/chapters/10"');
      expect(withoutChapter).toContain('notes-book-nav-book-link');
      expect(withoutChapter).not.toContain('href="/notes/chapters/10"');
      expect(withoutChapter).toContain('href="/notes/101"');
    });

    it('honors explicit expanded and collapsed initial modes', () => {
      const contents = [
        { type: 'chapter', id: 10, chapter: { title: 'First' }, pages: [] },
        { type: 'chapter', id: 20, chapter: { title: 'Second' }, pages: [] },
      ];
      const expanded = renderNavigator({ bookContents: contents, bookNavInitialMode: 'expanded' });
      const collapsed = renderNavigator({ bookContents: contents, bookNavInitialMode: 'collapsed', navCurrentChapterId: 10 });
      expect(expanded.match(/<details class="notes-book-nav-disclosure" open>/g)).toHaveLength(2);
      expect(collapsed).not.toContain('<details class="notes-book-nav-disclosure" open>');
    });

    it('renders an accessible empty navigator without item markup', () => {
      const html = renderNavigator();
      expect(html).toContain('<nav class="notes-book-nav" aria-label="Contents of The Navigator Book">');
      expect(html).toContain('No Pages or Chapters yet');
      expect(html).not.toContain('notes-book-nav-chapter');
      expect(html).not.toContain('notes-book-nav-page');
    });
  });
});

describe('Shared component contracts', () => {
  describe('page heading', () => {
    it('keeps the page title outside the component while preserving caller actions', () => {
      const html = renderString('{% import "partials/page-heading.njk" as pageHeading %}{% call pageHeading.render("ignored", "success", "Ready") %}<a class="button button-primary" href="/new">Create</a>{% endcall %}');
      expect(html).toContain('<header class="page-heading">');
      expect(html).toContain('<div class="page-heading-actions">');
      expect(html).toContain('<a class="button button-primary" href="/new">Create</a>');
      expect(html).not.toMatch(/<h1/);
    });

    it('renders no empty wrapper without supporting content', () => {
      expect(renderString('{% import "partials/page-heading.njk" as pageHeading %}{{ pageHeading.render() }}').trim()).toBe('');
    });

    it('orders paired lead links in a labelled navigation region', () => {
      const html = renderString('{% import "partials/page-heading.njk" as pageHeading %}{{ pageHeading.render("", "", "", "/projects/7", "Back to project", "", "projects", "/releases/9", "Back to release", "", "releases") }}');
      const nav = html.match(/<nav class="page-heading-navigation" aria-label="Page navigation">([\s\S]*?)<\/nav>/)?.[1] || '';
      expect(nav.indexOf('href="/projects/7"')).toBeLessThan(nav.indexOf('href="/releases/9"'));
      expect(nav.match(/page-heading-lead--icon/g)).toHaveLength(2);
      expect(nav).toContain('aria-label="Back to project" data-tooltip="Back to project"');
      expect(nav).toContain('aria-label="Back to release" data-tooltip="Back to release"');
    });

    it('gives an icon-only lead one accessible tooltip name', () => {
      const html = renderString('{% import "partials/page-heading.njk" as pageHeading %}{{ pageHeading.render("", "", "", "/projects/7", "Long Project Title", "", "chevron-left") }}');
      const lead = html.match(/<a class="button button-secondary page-heading-lead page-heading-lead--icon asset-tooltip asset-tooltip--left"[\s\S]*?<\/a>/)?.[0] || '';
      expect(lead).toContain('aria-label="Long Project Title"');
      expect(lead).toContain('data-tooltip="Long Project Title"');
      expect(lead).not.toContain('title=');
      expect(lead).toMatch(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
      expect(lead.replace(/<[^>]+>/g, '').trim()).toBe('');
    });

    it('keeps heading actions wrap-safe without duplicating the owned 540px stacking rule', () => {
      const heading = [...css.matchAll(/\.page-heading\s*\{([^}]*)\}/g)].map((m) => m[1]).find((r) => /display:\s*flex/.test(r)) || '';
      const actions = [...css.matchAll(/\.page-heading-actions\s*\{([^}]*)\}/g)].map((m) => m[1]).find((r) => /display:\s*flex/.test(r)) || '';
      expect(heading).toMatch(/flex-wrap:\s*wrap/);
      expect(heading).toMatch(/min-width:\s*0/);
      expect(actions).toMatch(/align-items:\s*center/);
      expect(actions).toMatch(/flex-wrap:\s*wrap/);
      expect(actions).toMatch(/max-width:\s*100%/);
    });
  });

  it('defines shared button variants and a functional keyboard focus indicator', () => {
    for (const selector of ['.button {', '.button-primary', '.button-secondary', '.button-danger']) expect(css).toContain(selector);
    expect(css.match(/\.button:focus-visible\s*\{([^}]*)\}/)?.[1] || '').toMatch(/outline:/);
  });

  describe('badges', () => {
    it('keeps ordinary Status rendering independent from Project metadata', () => {
      const ordinary = renderPartial('partials/status-badge.njk', { status: 'present' });
      const project = renderPartial('partials/status-badge.njk', { status: 'present', projectStatusOption: {
        value: 'present', label: 'Project Present Label', color: '#123456', tintPercent: 18, foregroundColor: '#8495A7',
      } });
      expect(ordinary).toContain('status-badge status-badge--success">Present</span>');
      expect(ordinary).not.toContain('project-option-badge');
      expect(project).toContain('project-option-badge project-status-badge');
      expect(project).toContain('>Project Present Label</span>');
      expect(project).not.toContain('status-badge--success');
    });

    it('keeps Project Type metadata, legacy styling, and unknown fallback distinct', () => {
      const metadata = renderPartial('partials/project-type-badge.njk', { projectType: 'images', projectTypeOption: {
        value: 'images', label: 'Custom Images', color: '#123456', tintPercent: 18, foregroundColor: '#8495A7',
      } });
      const legacy = renderPartial('partials/project-type-badge.njk', { projectType: 'images' });
      const unknown = renderPartial('partials/project-type-badge.njk', { projectType: 'legacy-type' });
      expect(metadata).toContain('project-option-badge project-type-badge');
      expect(metadata).toContain('>Custom Images</span>');
      expect(metadata).not.toContain('project-type-badge--images');
      expect(legacy).toContain('project-type-badge--images');
      expect(legacy).not.toContain('project-option-badge');
      expect(unknown).toContain('status-badge--neutral project-type-badge project-type-badge--unknown');
      expect(unknown).toContain('>Legacy Type</span>');
    });

    it('defines every shared Status badge variant used by templates', () => {
      for (const variant of ['neutral', 'active', 'success', 'warning', 'error', 'draft', 'published', 'archived']) {
        expect(css).toContain(`.status-badge--${variant}`);
      }
    });
  });

  it('renders empty-state headings semantically without a page h1', () => {
    const html = renderPartial('partials/empty-state.njk', {
      emptyHeading: 'Nothing here', emptyDescription: 'Create the first item.', emptyActionUrl: '/new', emptyActionLabel: 'Create',
    });
    expect(html).toContain('<h2 class="empty-state-heading">Nothing here</h2>');
    expect(html).toContain('<a class="button button-primary" href="/new">Create</a>');
    expect(countTags(html, 'h1')).toBe(0);
  });

  it('allowlists Notice variants, preserves status semantics, and rejects class injection', () => {
    for (const [input, output] of new Map([['info', 'info'], ['success', 'success'], ['warning', 'warning'], ['error', 'error'], ['danger', 'error']])) {
      const html = renderPartial('partials/notice.njk', { noticeVariant: input, noticeText: `${input} message` });
      expect(html).toContain(`class="notice notice--${output}" role="status"`);
      expect(html).toContain(`${input} message`);
    }
    const malicious = renderPartial('partials/notice.njk', { noticeVariant: 'error hacked-class', noticeText: '<strong>Escaped</strong>' });
    expect(malicious).toContain('class="notice notice--info" role="status"');
    expect(malicious).not.toContain('hacked-class');
    expect(malicious).toContain('&lt;strong&gt;Escaped&lt;/strong&gt;');
  });

  it('keeps oversized category dialogs on the shared viewport-capped scroll path', () => {
    const functionalCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleBodies = (selector) => [...functionalCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1].split(',').map((part) => part.trim()).includes(selector))
      .map((match) => match[2]);
    const categoryDialogSections = ruleBodies('#project-asset-category-management-dialog .app-dialog-body > *')
      .find((rule) => /flex-shrink:\s*0/.test(rule)) || '';
    const dialogBody = ruleBodies('.app-dialog-body')
      .find((rule) => /min-height:\s*0/.test(rule) && /overflow-y:\s*auto/.test(rule)) || '';
    const dialogCard = ruleBodies('.app-dialog-card')
      .find((rule) => /max-height:\s*calc\(100vh - 2rem\)/.test(rule)) || '';
    expect(categoryDialogSections).toMatch(/flex-shrink:\s*0/);
    expect(dialogBody).toMatch(/min-height:\s*0/);
    expect(dialogBody).toMatch(/overflow-y:\s*auto/);
    expect(dialogCard).toMatch(/display:\s*flex/);
    expect(dialogCard).toMatch(/flex-direction:\s*column/);
    expect(dialogCard).toMatch(/max-height:\s*calc\(100vh - 2rem\)/);
    expect(dialogCard).toMatch(/overflow:\s*hidden/);
  });

  describe('production inline-style policy', () => {
    const allowedInlineStyles = {
      'partials/status-badge.njk': [{
        expectedCount: 1,
        openingTag: /<span\b(?=[^>]*\bclass="status-badge\s+project-option-badge\s+project-status-badge\{\{ projectStatusClass \}\}")(?=[^>]*\sstyle="--project-badge-bg: \{\{ projectStatusOption\.color \}\}; --project-badge-tint: \{\{ projectStatusOption\.tintPercent \}\}%; --project-badge-fg: \{\{ projectStatusOption\.foregroundColor \}\}")[^>]*>/g,
        styleAttribute: /\sstyle="--project-badge-bg: \{\{ projectStatusOption\.color \}\}; --project-badge-tint: \{\{ projectStatusOption\.tintPercent \}\}%; --project-badge-fg: \{\{ projectStatusOption\.foregroundColor \}\}"/,
      }],
      'partials/project-type-badge.njk': [{
        expectedCount: 1,
        openingTag: /<span\b(?=[^>]*\bclass="status-badge\s+project-option-badge\s+project-type-badge")(?=[^>]*\sstyle="--project-badge-bg: \{\{ projectTypeOption\.color \}\}; --project-badge-tint: \{\{ projectTypeOption\.tintPercent \}\}%; --project-badge-fg: \{\{ projectTypeOption\.foregroundColor \}\}")[^>]*>/g,
        styleAttribute: /\sstyle="--project-badge-bg: \{\{ projectTypeOption\.color \}\}; --project-badge-tint: \{\{ projectTypeOption\.tintPercent \}\}%; --project-badge-fg: \{\{ projectTypeOption\.foregroundColor \}\}"/,
      }],
      'settings/project-option-color-control.njk': [{
        expectedCount: 1,
        openingTag: /<span\b(?=[^>]*\bclass="project-option-color-swatch")(?=[^>]*\sstyle="--project-option-color: \{\{ color \}\}")[^>]*>/g,
        styleAttribute: /\sstyle="--project-option-color: \{\{ color \}\}"/,
      }],
    };

    function consumeAllowedInlineStyles(relativePath, source) {
      let remainder = source
        .replace(/\{#[\s\S]*?#\}/g, '')
        .replace(/<!--[\s\S]*?-->/g, '');
      const counts = [];
      for (const exception of allowedInlineStyles[relativePath] || []) {
        let actualCount = 0;
        remainder = remainder.replace(exception.openingTag, (openingTag) => {
          actualCount += 1;
          return openingTag.replace(exception.styleAttribute, '');
        });
        counts.push({ actualCount, expectedCount: exception.expectedCount });
      }
      return { counts, remainder };
    }

    it('keeps presentation CSS out of templates except narrow dynamic variables', () => {
      const violations = [];
      for (const templatePath of listProductionTemplates()) {
        const relativePath = path.relative(VIEWS_DIR, templatePath).replace(/\\/g, '/');
        const { counts, remainder } = consumeAllowedInlineStyles(relativePath, fs.readFileSync(templatePath, 'utf8'));
        for (const { actualCount, expectedCount } of counts) {
          if (actualCount !== expectedCount) violations.push(`${relativePath}: expected ${expectedCount} allowed inline style, found ${actualCount}`);
        }
        if (/<style\b/i.test(remainder) || /\sstyle\s*=/i.test(remainder)) violations.push(`${relativePath}: unauthorized inline style`);
      }
      expect(violations).toEqual([]);
    });

    it('does not broaden an exception by property, element context, occurrence, or template path', () => {
      const allowed = '<span class="project-option-color-swatch" style="--project-option-color: {{ color }}" aria-hidden="true">';
      const unrelated = '<span class="unrelated" style="--project-option-color: {{ color }}">';
      const duplicate = consumeAllowedInlineStyles('settings/project-option-color-control.njk', allowed + allowed);
      const moved = consumeAllowedInlineStyles('settings/project-option-color-control.njk', '<div class="project-option-color-swatch" style="--project-option-color: {{ color }}">');
      const extra = consumeAllowedInlineStyles('settings/project-option-color-control.njk', allowed + unrelated);
      expect(duplicate.counts).toEqual([{ actualCount: 2, expectedCount: 1 }]);
      expect(moved.counts).toEqual([{ actualCount: 0, expectedCount: 1 }]);
      expect(moved.remainder).toContain('style=');
      expect(extra.remainder).toContain('style=');
      expect(consumeAllowedInlineStyles('settings/project-option-color-control.njk', '<span style="color: {{ color }}">').remainder).toContain('style=');
      expect(consumeAllowedInlineStyles('settings/project-option-color-control.njk', '<span style="--project-option-other: {{ color }}">').remainder).toContain('style=');
      expect(consumeAllowedInlineStyles('settings/other.njk', allowed).remainder).toContain('style=');
    });
  });
});

describe('Representative page-component integration', () => {
  let db;
  let tmpDir;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shared-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const pageHeading = (html) => html.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0] || '';

  it('uses one layout-owned h1 and supporting-only headings on representative pages', async () => {
    for (const [url, title] of [['/', 'Dashboard'], ['/projects', 'Projects'], ['/releases', 'Releases']]) {
      const res = await agent.get(url).expect(200);
      expect(countTags(res.text, 'h1'), url).toBe(1);
      expect(res.text).toContain(`<h1 class="app-section-title">${title}</h1>`);
      expect(pageHeading(res.text), url).not.toBe('');
      expect(countTags(pageHeading(res.text), 'h1'), url).toBe(0);
    }
  });

  it('keeps Project form actions in the supporting page heading', async () => {
    const res = await agent.get('/projects/new').expect(200);
    const heading = pageHeading(res.text);
    expect(countTags(res.text, 'h1')).toBe(1);
    expect(res.text).toContain('<h1 class="app-section-title">Projects — Create Project</h1>');
    expect(heading).toContain('<div class="page-heading-actions">');
    expect(heading).toContain('form="project-form"');
    expect(heading).toContain('>Cancel</a>');
  });

  it('keeps Release form actions in the supporting page heading', async () => {
    await agent.post('/projects').type('form').send({ title: 'Heading Test', status: 'tbd', priority: 'normal', _csrf: csrfToken }).expect(302);
    const res = await agent.get('/releases/new').expect(200);
    const heading = pageHeading(res.text);
    expect(countTags(res.text, 'h1')).toBe(1);
    expect(res.text).toContain('<h1 class="app-section-title">Releases — Create Release</h1>');
    expect(heading).toContain('<div class="page-heading-actions">');
    expect(heading).toContain('form="release-form"');
    expect(heading).toContain('>Cancel</a>');
  });

  it('keeps the independent Project detail at one h1', async () => {
    const created = await agent.post('/projects').type('form').send({ title: 'Heading Detail', status: 'tbd', priority: 'normal', _csrf: csrfToken }).expect(302);
    const res = await agent.get(created.headers.location).expect(200);
    expect(countTags(res.text, 'h1')).toBe(1);
    expect(pageHeading(res.text)).not.toMatch(/<h1/);
  });

  it('associates every Project form label and required marker accessibly', async () => {
    const res = await agent.get('/projects/new').expect(200);
    const form = res.text.match(/<form id="project-form"[\s\S]*?<\/form>/)?.[0] || '';
    const labels = form.match(/<label[^>]*for="([^"]+)"[^>]*>/g) || [];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(form).toContain(`id="${label.match(/for="([^"]+)"/)?.[1]}"`);
    for (const marker of form.match(/<span class="required"[^>]*>/g) || []) expect(marker).toContain('aria-label="required"');
  });

  it('renders shared field-error hooks for invalid Project submissions', async () => {
    const res = await agent.post('/projects').type('form').send({ title: '', status: 'invalid', priority: 'normal', _csrf: csrfToken }).expect(422);
    expect(res.text).toContain('field-error-message');
    expect(res.text).toContain('field-error');
  });

  it('renders the Project form without duplicate IDs', async () => {
    const res = await agent.get('/projects/new').expect(200);
    const ids = [...res.text.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
