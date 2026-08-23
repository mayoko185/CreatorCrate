/**
 * Phase 10.5A — Shared page-level components: structural and rendered tests.
 *
 * Verifies:
 *  - Shared page-heading markup contract
 *  - Action variants (button/link parity, focus, disabled)
 *  - Visible form labels and error/help text
 *  - Status badges always contain readable text
 *  - Table wrapper and headers
 *  - Empty-state markup
 *  - Destructive section
 *  - No inline presentation styles outside the shared stylesheet
 *  - No duplicate IDs
 *  - No invalid nested interactive controls
 *  - Exactly one <h1> per page
 *  - Mobile-safe class structure (no horizontal overflow at 320px)
 *  - Notice variants have correct semantic class
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
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
const CREATORCRATE_CSS_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const ASSET_VIEWER_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/projects/asset-viewer.njk', import.meta.url));
const ASSET_EDIT_DIALOG_TEMPLATE_PATH = fileURLToPath(new URL('../src/views/partials/asset-edit-dialog.njk', import.meta.url));
const creatorCrateCss = fs.readFileSync(CREATORCRATE_CSS_PATH, 'utf8');
const assetViewerTemplate = fs.readFileSync(ASSET_VIEWER_TEMPLATE_PATH, 'utf8');
const assetEditDialogTemplate = fs.readFileSync(ASSET_EDIT_DIALOG_TEMPLATE_PATH, 'utf8');
function renderPartial(templateName, context = {}) {
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
  return env.render(templateName, context);
}

/**
 * Fetch the actually-served stylesheet through the HTTP test agent (not the
 * source file on disk), so these assertions fail if /creatorcrate.css stops
 * being served correctly, not just if the source file changes.
 */
async function extractStyle(agent, html) {
  expect(html).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
  const res = await agent.get('/creatorcrate.css').expect(200);
  expect(res.headers['content-type']).toMatch(/text\/css/);
  return res.text;
}

function listProductionTemplates(dir = VIEWS_DIR) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const templates = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      templates.push(...listProductionTemplates(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.njk') && entry.name !== 'layout.njk') {
      templates.push(fullPath);
    }
  }
  return templates;
}

/** Count opening tags matching a regex. */
function countTags(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'g');
  return (html.match(re) || []).length;
}

/** Extract the text content of all elements matching a class. */
function textsByClass(html, className) {
  const re = new RegExp(`class="[^"]*${className}[^"]*"`, 'g');
  const texts = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    // Find the next closing tag text
    const after = html.slice(m.index);
    const textMatch = after.match(/>([^<]+)</);
    if (textMatch) texts.push(textMatch[1].trim());
  }
  return texts;
}

/** Check if a class appears in the HTML. */
function hasClass(html, className) {
  const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`);
  return re.test(html);
}

function extractProjectCard(html, projectId) {
  const cards = html.match(/<article\b[^>]*data-project-card[^>]*>[\s\S]*?<\/article>/g) || [];
  return cards.find((card) => card.includes(`data-project-card-link href="/projects/${projectId}"`)) || '';
}

function hasNestedForms(html) {
  let depth = 0;
  for (const tag of html.match(/<\/?form\b[^>]*>/gi) || []) {
    if (tag.startsWith('</')) {
      depth -= 1;
    } else {
      if (depth > 0) return true;
      depth += 1;
    }
  }
  return depth !== 0;
}

describe('Notes Page navigation partial', () => {
  it('renders labelled semantic navigation with shallow links and typed current matching', () => {
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
    expect(html).toContain('<ol class="notes-page-nav-list">');
    expect(html).toContain('<a class="notes-page-nav-link" href="/notes/101">Opening Page</a>');
    expect(html).toContain('<a class="notes-page-nav-link" href="/notes/103">Closing Page</a>');
    expect(html).toContain('class="notes-page-nav-item notes-page-nav-item--current"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<span class="notes-page-nav-current">Current Page</span>');
    expect(html).not.toContain('href="/notes/102"');
    expect((html.match(/<li class="notes-page-nav-item/g) || []).length).toBe(3);
  });

  it('keeps every Page linked when no current Page is supplied', () => {
    const html = renderPartial('partials/notes-page-nav.njk', {
      pageNavLabel: 'Page siblings',
      pageNavPages: [
        { id: 201, title: 'First Page' },
        { id: 202, title: 'Second Page' },
      ],
    });

    expect((html.match(/<a class="notes-page-nav-link" href="\/notes\//g) || []).length).toBe(2);
    expect(html).not.toContain('aria-current="page"');
  });

  it('provides compact borderless outline styles with non-color current and focus states', () => {
    expect(creatorCrateCss).toContain('.notes-page-nav-list');
    expect(creatorCrateCss).toContain('list-style: none;');
    expect(creatorCrateCss).toContain('.notes-page-nav-link:focus-visible');
    expect(creatorCrateCss).toContain('.notes-page-nav-current');
    expect(creatorCrateCss).toContain('text-decoration-thickness: 0.12em;');
  });
});

describe('Compact Book navigator partial', () => {
  const book = { id: 42, title: 'The Navigator Book' };

  function renderBookNavigator(overrides = {}) {
    return renderPartial('partials/book-navigator.njk', {
      book,
      bookContents: [],
      ...overrides,
    });
  }

  function topLevelItems(html) {
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
        if (depth === 0 && /class="notes-book-nav-item notes-book-nav-(chapter|page)(?: [^"]*)?"/.test(match[0])) {
          start = match.index;
        }
        depth += 1;
      }
    }

    return items;
  }

  it('renders a labelled nav, Book link, and the supplied mixed top-level order', () => {
    const html = renderBookNavigator({
      bookContents: [
        {
          type: 'chapter',
          id: 10,
          sortOrder: 1,
          chapter: { title: 'Chapter One' },
          pages: [{ id: 101, title: 'Chapter Page' }],
        },
        { type: 'page', id: 201, sortOrder: 2, page: { title: 'Direct Page One' } },
        {
          type: 'chapter',
          id: 20,
          sortOrder: 3,
          chapter: { title: 'Chapter Two' },
          pages: [],
        },
        { type: 'page', id: 202, sortOrder: 4, page: { title: 'Direct Page Two' } },
      ],
    });

    expect(html).toMatch(/<nav[^>]*class="notes-book-nav"[^>]*aria-label="Contents of The Navigator Book"/);
    expect((html.match(/class="notes-book-nav-heading"/g) || [])).toHaveLength(1);
    expect(html).toContain('<p class="notes-book-nav-heading">Book contents</p>');
    expect(html).toMatch(/<a[^>]*class="notes-book-nav-book-link"[^>]*href="\/notes\/books\/42"[^>]*>The Navigator Book<\/a>/);

    const items = topLevelItems(html);
    expect(items).toHaveLength(4);
    expect(items[0]).toContain('Chapter One');
    expect(items[1]).toContain('Direct Page One');
    expect(items[2]).toContain('Chapter Two');
    expect(items[3]).toContain('Direct Page Two');
    expect(items[0]).toContain('<details class="notes-book-nav-disclosure"');
    expect(items[1]).toContain('href="/notes/201"');
    expect(items[2]).toContain('<details class="notes-book-nav-disclosure"');
    expect(items[3]).toContain('href="/notes/202"');
  });

  it('keeps Chapter Pages nested, ordered, and linked to shallow Page URLs', () => {
    const html = renderBookNavigator({
      bookContents: [{
        type: 'chapter',
        id: 10,
        chapter: { title: 'Chapter One' },
        pages: [
          { id: 101, title: 'Nested First' },
          { id: 102, title: 'Nested Second' },
        ],
      }, {
        type: 'chapter',
        id: 20,
        chapter: { title: 'Chapter Two' },
        pages: [{ id: 201, title: 'Other Chapter Page' }],
      }],
    });
    const items = topLevelItems(html);

    expect(items[0]).toContain('<ol class="notes-book-nav-pages">');
    expect(items[0].indexOf('Nested First')).toBeLessThan(items[0].indexOf('Nested Second'));
    expect(items[0]).toContain('href="/notes/101"');
    expect(items[0]).toContain('href="/notes/102"');
    expect(items[0]).not.toContain('Other Chapter Page');
    expect(items[1]).toContain('Other Chapter Page');
    expect(items[1]).toContain('href="/notes/201"');
    expect(items[0]).toContain('href="/notes/chapters/10"');
    expect(items[1]).toContain('href="/notes/chapters/20"');
  });

  it('marks and expands a current Chapter, including string-to-number ID matching', () => {
    const html = renderBookNavigator({
      bookContents: [
        { type: 'chapter', id: 10, chapter: { title: 'Current Chapter' }, pages: [] },
        { type: 'chapter', id: 20, chapter: { title: 'Other Chapter' }, pages: [] },
      ],
      navCurrentChapterId: '10',
    });
    const items = topLevelItems(html);

    expect(items[0]).toMatch(/<details class="notes-book-nav-disclosure" open>/);
    expect(items[0]).toMatch(/<a[^>]*href="\/notes\/chapters\/10"[^>]*aria-current="page"/);
    expect(items[1]).not.toContain(' open>');
  });

  it('expands the Chapter containing a current Page and marks that Page while keeping it linked', () => {
    const html = renderBookNavigator({
      bookContents: [
        { type: 'chapter', id: '10', chapter: { title: 'First Chapter' }, pages: [{ id: 101, title: 'First Page' }] },
        { type: 'chapter', id: 20, chapter: { title: 'Containing Chapter' }, pages: [{ id: '202', title: 'Current Page' }] },
        { type: 'page', id: 303, page: { title: 'Unrelated Direct Page' } },
      ],
      navCurrentPageId: 202,
    });
    const items = topLevelItems(html);

    expect(items[0]).not.toContain(' open>');
    expect(items[1]).toMatch(/<details class="notes-book-nav-disclosure" open>/);
    expect(items[1]).toMatch(/<a[^>]*href="\/notes\/202"[^>]*aria-current="page"[^>]*>Current Page<\/a>/);
    expect(items[1]).toMatch(/<li[^>]*class="[^\"]*notes-book-nav-page[^\"]*notes-book-nav-item--current[^\"]*"[^>]*>/);
    expect(items[2]).not.toContain('aria-current="page"');
    expect(items[2]).toContain('href="/notes/303"');
  });

  it('does not mark or expand items for null or undefined current IDs', () => {
    const contents = [{
      type: 'chapter',
      id: 10,
      chapter: { title: 'Chapter' },
      pages: [{ id: 101, title: 'Page' }],
    }];

    for (const overrides of [{ navCurrentChapterId: null, navCurrentPageId: null }, {}]) {
      const html = renderBookNavigator({ bookContents: contents, ...overrides });
      expect(html).not.toContain('aria-current="page"');
      expect(html).not.toContain(' open>');
    }
  });

  it('renders empty Book contents without navigator item errors', () => {
    const html = renderBookNavigator({ bookContents: [] });

    expect(html).toContain('notes-book-nav-list');
    expect(html).toContain('No Pages or Chapters yet');
    expect(html).not.toContain('notes-book-nav-chapter');
    expect(html).not.toContain('notes-book-nav-page');
  });

  it('provides compact hierarchy, focus, wrapping, and non-color current styles', () => {
    expect(creatorCrateCss).toContain('.notes-book-nav');
    expect(creatorCrateCss).toContain('.notes-book-nav-heading');
    expect(creatorCrateCss).toContain('.notes-book-nav-summary::-webkit-details-marker');
    expect(creatorCrateCss).toContain('.notes-book-nav-chapter-link {');
    expect(creatorCrateCss).toContain('display: inline;');
    expect(creatorCrateCss).toContain('.notes-book-nav-page--child');
    expect(creatorCrateCss).toContain('.notes-book-nav-page:not(.notes-book-nav-page--child)');
    expect(creatorCrateCss).toContain('min-width: 0;');
    expect(creatorCrateCss).toContain('overflow-wrap: anywhere;');
    expect(creatorCrateCss).toContain('.notes-book-nav-book-link:focus-visible');
    expect(creatorCrateCss).toMatch(/\.notes-book-nav-book-link\s*\{[\s\S]*?color: var\(--text\);/);
    expect(creatorCrateCss).toMatch(/\.notes-book-nav-chapter-link\s*\{[\s\S]*?color: var\(--text\);/);
    expect(creatorCrateCss).toMatch(/\.notes-book-nav-page-link\s*\{[\s\S]*?color: var\(--muted\);/);
    expect(creatorCrateCss).toContain('.notes-book-nav-book-link:hover');
    expect(creatorCrateCss).toContain('.notes-book-nav-chapter-link:hover');
    expect(creatorCrateCss).toContain('.notes-book-nav-page-link:hover');
    expect(creatorCrateCss).toContain('background: var(--surface-hover);');
    expect(creatorCrateCss).toContain('outline: 2px solid var(--focus-ring);');
    expect(creatorCrateCss).toMatch(/a:not\(\[class\]\)\s*\{[\s\S]*?color: var\(--link\);/);
    expect(creatorCrateCss).toMatch(/a:not\(\[class\]\):hover\s*\{[\s\S]*?color: var\(--accent-2\);/);
    expect(creatorCrateCss).toContain('.notes-book-nav-chapter-link[aria-current="page"]');
    expect(creatorCrateCss).toContain('.notes-book-nav-page.notes-book-nav-item--current > .notes-book-nav-page-link');
    expect(creatorCrateCss).toContain('.notes-book-nav-page.notes-book-nav-item--current:not(.notes-book-nav-page--child) > .notes-book-nav-page-link');
    expect(creatorCrateCss).not.toContain('.notes-book-nav-page--current > .notes-book-nav-page-link');
    expect(creatorCrateCss).toContain('text-decoration-thickness: 0.12em;');
  });
});

describe('Phase 10.5A: Shared page-level components', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let appDataRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shared-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Page heading contract ─────────────────────────────────────────
  //
  // Phase 14: the page-heading component is supporting content only
  // (description, badges, actions) — it never renders an <h1>. The page's
  // single <h1> lives in the compact top header instead, driven by the
  // template's `page_title` contract.

  describe('page-heading contract', () => {
    /** Extract the <header class="page-heading">…</header> block, if any. */
    function extractPageHeading(html) {
      const match = html.match(/<header class="page-heading">[\s\S]*?<\/header>/);
      return match ? match[0] : '';
    }

    it('project form has exactly one h1 from the header and carries form actions in page-heading', async () => {
      const res = await agent.get('/projects/new').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(res.text).toContain('<h1 class="app-section-title">Projects — Create Project</h1>');
      // The project form now renders Create/Save and Cancel inside the
      // page-heading actions wrapper; it must not be empty.
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      const heading = extractPageHeading(res.text);
      expect(countTags(heading, 'h1')).toBe(0);
      expect(heading).toContain('<div class="page-heading-actions">');
      expect(heading).toContain('form="project-form"');
      expect(heading).toContain('>Cancel</a>');
    });

    it('release form has exactly one h1 from the header and carries form actions in page-heading', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Heading+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/releases/new').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(res.text).toContain('<h1 class="app-section-title">Releases — Create Release</h1>');
      // The release form now renders Create/Save and Cancel inside the
      // page-heading actions wrapper; it must not be empty.
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      const heading = extractPageHeading(res.text);
      expect(countTags(heading, 'h1')).toBe(0);
      expect(heading).toContain('<div class="page-heading-actions">');
      expect(heading).toContain('form="release-form"');
      expect(heading).toContain('>Cancel</a>');
    });

    it('project list has exactly one h1, and page-heading carries supporting content only', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(res.text).toContain('<h1 class="app-section-title">Projects</h1>');
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(countTags(extractPageHeading(res.text), 'h1')).toBe(0);
    });

    it('Releases page has exactly one h1 and carries its view/actions in page-heading', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(res.text).toContain('<h1 class="app-section-title">Releases</h1>');
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(countTags(extractPageHeading(res.text), 'h1')).toBe(0);
    });

    it('dashboard has exactly one h1, and page-heading carries supporting content only', async () => {
      const res = await agent.get('/').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
      expect(res.text).toContain('<h1 class="app-section-title">Dashboard</h1>');
      // The dashboard page-heading now carries navigation actions only — no
      // description copy.
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(hasClass(res.text, 'page-heading-description')).toBe(false);
      expect(countTags(extractPageHeading(res.text), 'h1')).toBe(0);
    });

    it('has page-heading with New Project primary action', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(hasClass(res.text, 'page-heading')).toBe(true);
      expect(res.text).toContain('New Project');
      expect(res.text).toContain('button-primary');
      expect(res.text).toContain('href="/projects/new"');
    });

    it('the page-heading macro never emits an <h1>, even with description, badge, and actions', () => {
      const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
      const html = env.renderString(
        '{% import "partials/page-heading.njk" as pageHeading %}{% call pageHeading.render("desc", "success", "Ready") %}<a href="#">Action</a>{% endcall %}',
        {}
      );
      expect(html).toContain('page-heading');
      expect(html).not.toMatch(/<h1/);
    });

    it('the page-heading macro still renders no wrapper when called with no arguments', () => {
      const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
      const html = env.renderString(
        '{% import "partials/page-heading.njk" as pageHeading %}{{ pageHeading.render() }}',
        {}
      );
      expect(html.trim()).toBe('');
    });

    it('keeps caller-provided actions unchanged when no lead is supplied', () => {
      const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
      const html = env.renderString(
        '{% import "partials/page-heading.njk" as pageHeading %}{% call pageHeading.render() %}<a class="button button-primary" href="/new">Create</a>{% endcall %}',
        {}
      );
      expect(html).toContain('<header class="page-heading">');
      expect(html).toContain('<div class="page-heading-actions">');
      expect(html).toContain('<a class="button button-primary" href="/new">Create</a>');
      expect(html).not.toContain('page-heading-lead');
    });

    it('renders an optional far-left lead link before actions, including its extra class', () => {
      const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
      const html = env.renderString(
        '{% import "partials/page-heading.njk" as pageHeading %}{% call pageHeading.render("", "", "", "/projects/7", "Project: Long Project Title", "asset-viewer-project") %}<a href="/next">Next</a>{% endcall %}',
        {}
      );
      expect(html).toContain('<header class="page-heading">');
      expect(html).toContain('class="button button-secondary page-heading-lead asset-viewer-project"');
      expect(html).toContain('href="/projects/7"');
      expect(html).toContain('>Project: Long Project Title</a>');
      expect(html.indexOf('page-heading-lead')).toBeLessThan(html.indexOf('page-heading-actions'));
    });

    it('renders the page-heading wrapper for a lead-only invocation', () => {
      const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
      const html = env.renderString(
        '{% import "partials/page-heading.njk" as pageHeading %}{{ pageHeading.render("", "", "", "/projects/7", "Project: Solo") }}',
        {}
      );
      expect(html).toContain('<header class="page-heading">');
      expect(html).toContain('href="/projects/7"');
      expect(html).not.toContain('page-heading-actions');
    });
  });

  // ─── 2. Action variants ────────────────────────────────────────────────

  describe('action variants', () => {
    it('button-primary is rendered for primary actions', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(hasClass(res.text, 'button-primary')).toBe(true);
    });

    it('button-secondary is rendered for cancel links', async () => {
      const res = await agent.get('/projects/new').expect(200);
      expect(hasClass(res.text, 'button-secondary')).toBe(true);
    });

    it('project edit dialog includes the legacy destructive actions', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Danger+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = projRes.headers.location.replace('/projects/', '');

      const edit = await agent.get(`/projects/${id}?edit=1`).expect(200);
      const dialog = edit.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).not.toBe('');
      expect(hasClass(dialog, 'button-danger')).toBe(true);
      expect(dialog).toContain(`action="/projects/${id}/archive"`);
      expect(dialog).toContain(`action="/projects/${id}/delete"`);
    });
  });

  // ─── 3. Button/link parity ─────────────────────────────────────────────

  describe('button/link parity', () => {
    it('links and buttons with class button have consistent base styles', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = await extractStyle(agent, res.text);

      // .button base exists
      expect(css).toContain('.button {');

      // .button-primary exists
      expect(css).toContain('.button-primary');

      // .button-danger exists
      expect(css).toContain('.button-danger');

      // .button-secondary exists
      expect(css).toContain('.button-secondary');
    });

    it('buttons have focus-visible styles', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = await extractStyle(agent, res.text);
      expect(css).toContain('.button:focus-visible');
    });
  });

  // ─── 4. Visible form labels ─────────────────────────────────────────────

  describe('form labels and errors', () => {
    it('project form has visible labels for every control', async () => {
      const res = await agent.get('/projects/new').expect(200);
      // Every <label> must have a for= attribute matching an input id
      const labels = res.text.match(/<label[^>]*for="([^"]+)"[^>]*>/g) || [];
      expect(labels.length).toBeGreaterThan(0);

      for (const label of labels) {
        const forMatch = label.match(/for="([^"]+)"/);
        if (forMatch) {
          const inputId = forMatch[1];
          expect(res.text).toMatch(new RegExp(`id="${inputId}"`));
        }
      }
    });

    it('project form error state renders field-error-message text', async () => {
      const res = await agent
        .post('/projects')
        .send('title=')
        .send('status=invalid')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('field-error-message');
      expect(res.text).toContain('field-error');
    });

    it('project form required indicators use aria-label', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const requiredSpans = res.text.match(/<span class="required"[^>]*>/g) || [];
      for (const span of requiredSpans) {
        expect(span).toContain('aria-label="required"');
      }
    });
  });

  // ─── 5. Status badges ──────────────────────────────────────────────────

  describe('status badges', () => {
    it('project list uses status-badge with readable text', async () => {
      await agent
        .post('/projects')
        .send('title=Badge+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/projects').expect(200);
      // The status badge must contain text content (not just color)
      expect(res.text).toContain('status-badge');
      // The text "Tbd" must appear inside a badge
      expect(res.text).toMatch(/status-badge[^>]*>Tbd</);
    });

    it('project detail uses status-badge', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Badge+Detail')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('status-badge');
      expect(res.text).not.toMatch(/\bpriority\b/i);
    });

    it('status-badge variant classes are defined in CSS', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = await extractStyle(agent, res.text);
      // All semantic variants
      expect(css).toContain('.status-badge--neutral');
      expect(css).toContain('.status-badge--active');
      expect(css).toContain('.status-badge--success');
      expect(css).toContain('.status-badge--warning');
      expect(css).toContain('.status-badge--error');
      expect(css).toContain('.status-badge--draft');
      expect(css).toContain('.status-badge--published');
      expect(css).toContain('.status-badge--archived');
    });
  });

  describe('Project Type badges', () => {
    it.each([
      ['images', 'Images'],
      ['comic', 'Comic'],
      ['animation', 'Animation'],
      ['wallpaper', 'Wallpaper'],
    ])('renders the %s badge with its readable label and modifier', (projectType, label) => {
      const html = renderPartial('partials/project-type-badge.njk', { projectType });

      expect(html).toContain(`status-badge project-type-badge project-type-badge--${projectType}`);
      expect(html).toContain(`>${label}</span>`);
    });

    it('uses a neutral readable fallback for an unknown Project Type', () => {
      const html = renderPartial('partials/project-type-badge.njk', { projectType: 'legacy-type' });

      expect(html).toContain('status-badge--neutral project-type-badge project-type-badge--unknown');
      expect(html).toContain('>Legacy Type</span>');
    });

    it('renders Type beside unchanged Status badges in list and grid project cards', async () => {
      const created = await agent
        .post('/projects')
        .send('title=Project+Type+Card')
        .send('status=tbd')
        .send('projectType=animation')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = created.headers.location.replace('/projects/', '');

      for (const view of ['list', 'grid']) {
        const res = await agent.get(`/projects?view=${view}`).expect(200);
        const card = extractProjectCard(res.text, projectId);

        expect(card).toContain('>Tbd</span>');
        expect(card.match(/project-type-badge--animation/g) || []).toHaveLength(2);

        const typeMeta = card.match(/<dt>Type<\/dt>\s*<dd>[\s\S]*?<\/dd>/)?.[0] || '';
        expect(typeMeta.match(/project-type-badge--animation/g) || []).toHaveLength(1);

        if (view === 'list') {
          const indicators = card.match(/<div class="project-list-card-indicators"[\s\S]*?<\/div>/)?.[0] || '';
          expect(indicators.match(/project-type-badge--animation/g) || []).toHaveLength(1);
        } else {
          const indicators = card.match(/<div class="project-grid-card-status"[\s\S]*?<\/div>/)?.[0] || '';
          expect(indicators.match(/project-type-badge--animation/g) || []).toHaveLength(1);
        }
      }
    });

    it('renders Type beside Status once in the project detail summary', async () => {
      const created = await agent
        .post('/projects')
        .send('title=Project+Type+Detail')
        .send('status=ready')
        .send('projectType=wallpaper')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(created.headers.location).expect(200);
      const meta = res.text.match(/<div class="project-detail-meta">[\s\S]*?<\/nav>/)?.[0] || '';

      expect(meta).toContain('status-badge status-badge--active">Ready</span>');
      expect(meta.match(/project-type-badge--wallpaper/g) || []).toHaveLength(1);
      expect(meta.indexOf('status-badge--active')).toBeLessThan(meta.indexOf('project-type-badge--wallpaper'));
    });

    it('defines dedicated Project Type badge variants without changing Status badge classes', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = await extractStyle(agent, res.text);

      for (const projectType of ['images', 'comic', 'animation', 'wallpaper']) {
        expect(css).toContain(`.project-type-badge--${projectType}`);
      }
      expect(css).toContain('.status-badge--neutral');
      expect(css).toContain('.status-badge--active');
    });
  });

  // ─── 6. Table responsiveness ───────────────────────────────────────────

  describe('table responsiveness', () => {
    it('project list uses project card grid markup', async () => {
      db.prepare(
        `INSERT INTO projects (title, slug, description, notes, status, planned_date, published_date, patreon_url)
         VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)`
      ).run('Table Test', 'table-test');
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('<ul class="project-grid">');
      expect(res.text).toMatch(
        /<li class="project-grid-item">[\s\S]*?<article class="project-card project-card--grid project-grid-card" data-project-card>[\s\S]*?<a class="project-card-link" data-project-card-link href="\/projects\/\d+">Table Test<\/a>/
      );
    });

    it('data-table styles are defined with proper header styles', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = await extractStyle(agent, res.text);
      expect(css).toContain('.data-table');
      expect(css).toContain('.data-table th');
    });

    it('project cards expose a native focusable link without an extra tab stop', async () => {
      await agent
        .post('/projects')
        .send('title=Tabindex+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/projects').expect(200);
      const card = res.text.match(/<article class="project-card project-card--grid project-grid-card" data-project-card>[\s\S]*?<\/article>/);
      expect(card).not.toBeNull();
      expect(card[0]).toContain('data-project-card-link href="/projects/');
      expect(card[0]).toContain('>Tabindex Test</a>');
      expect(card[0]).not.toContain('tabindex="0"');
    });

    it('intrinsically wide release tables remain focusable and named', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Wide+Table+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Wide+Release')
        .send('status=tbd')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/releases').expect(200);
      expect(res.text).toMatch(/<div class="table-scroll" tabindex="0" aria-label="Release list">/);
    });
  });

  // ─── 7. Empty states ──────────────────────────────────────────────────

  describe('empty-state contract', () => {
    it('project list empty state uses shared partial', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('empty-state');
      expect(res.text).toContain('empty-state-heading');
    });

    it('empty-state heading is semantic and not an h1', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toMatch(/<h2 class="empty-state-heading">No projects yet<\/h2>/);
      expect(res.text).not.toMatch(/<p class="empty-state-heading">/);
      const emptyStateBlock = res.text.match(/class="empty-state"[\s\S]*?<\/div>/);
      if (emptyStateBlock) {
        expect(countTags(emptyStateBlock[0], 'h1')).toBe(0);
      }
    });

    it('project detail with no releases shows contextual empty state', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Empty+Releases')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(res.text).toContain('No release records for this project.');
      expect(countTags(res.text, 'h1')).toBe(1);
    });
  });

  // ─── 8. Destructive sections ───────────────────────────────────────────

  describe('destructive section', () => {
    it('project edit dialog keeps destructive actions in the established action section', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Destructive+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(`${createRes.headers.location}?edit=1`).expect(200);
      const dialog = res.text.match(/<dialog id="project-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).not.toBe('');
      expect(dialog).not.toContain('destructive-section');
      expect(dialog).not.toContain('Danger zone');
      expect(dialog).toContain('button-danger');
      expect(dialog).toContain('Archive project');
      expect(dialog).toContain('Delete project');
    });

    it('archived project detail has no destructive section', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=Archived+No+Destructive')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const id = createRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${id}/archive`).send({ _csrf: csrfToken }).expect(302);

      const res = await agent.get(`/projects/${id}`).expect(200);
      // Check HTML class attribute, not CSS definition (which appears in <style>)
      expect(hasClass(res.text, 'destructive-section')).toBe(false);
    });

    it('destructive-section CSS has danger border color', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = await extractStyle(agent, res.text);
      expect(css).toContain('.destructive-section');
      expect(css).toContain('border: 1px solid var(--danger)');
    });
  });

  // ─── 9. Notice variants ────────────────────────────────────────────────

  describe('notice variants', () => {
    it('release detail uses notice--warning for archived state', async () => {
      const projRes = await agent
        .post('/projects')
        .send('title=Notice+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const relRes = await agent
        .post('/releases')
        .send(`projectId=${projectId}`)
        .send('title=Archived+Release')
        .send('status=tbd')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent
        .post(`${relRes.headers.location}/archive`)
        .send({ _csrf: csrfToken })
        .expect(302);

      const detail = await agent.get(relRes.headers.location).expect(200);
      expect(detail.text).toContain('notice--warning');
    });

    it('notice variant CSS classes are defined', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = await extractStyle(agent, res.text);
      expect(css).toContain('.notice--info');
      expect(css).toContain('.notice--success');
      expect(css).toContain('.notice--warning');
      expect(css).toContain('.notice--error');
    });

    for (const variant of ['info', 'success', 'warning', 'error']) {
      it(`notice partial allowlists ${variant} variant`, () => {
        const html = renderPartial('partials/notice.njk', {
          noticeVariant: variant,
          noticeText: `${variant} message`,
        });
        expect(html).toContain(`class="notice notice--${variant}"`);
        expect(html).toContain(`${variant} message`);
      });
    }

    it('notice partial falls back safely for unknown and malicious variants', () => {
      const unknown = renderPartial('partials/notice.njk', {
        noticeVariant: 'unknown',
        noticeText: 'Plain message',
      });
      expect(unknown).toContain('class="notice notice--info"');

      const malicious = renderPartial('partials/notice.njk', {
        noticeVariant: 'error hacked-class',
        noticeText: '<strong>Escaped</strong>',
      });
      expect(malicious).toContain('class="notice notice--info"');
      expect(malicious).not.toContain('hacked-class');
      expect(malicious).toContain('&lt;strong&gt;Escaped&lt;/strong&gt;');
    });
  });

  // ─── 10. No inline presentation styles ─────────────────────────────────

  describe('no inline presentation styles', () => {
    it('production templates keep presentation CSS in the shared stylesheet only', () => {
      const offenders = [];
      for (const templatePath of listProductionTemplates()) {
        const source = fs.readFileSync(templatePath, 'utf8');
        if (/<style\b/i.test(source) || /\sstyle\s*=/i.test(source)) {
          offenders.push(path.relative(VIEWS_DIR, templatePath).replace(/\\/g, '/'));
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  // ─── 11. No duplicate IDs ─────────────────────────────────────────────

  describe('no duplicate IDs', () => {
    it('project form has no duplicate IDs', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const ids = res.text.match(/id="([^"]+)"/g) || [];
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });
  });

  // ─── 11b. Asset-category enabled switches ─────────────────────────────

  describe('asset-category enabled switch contract', () => {
    function checkboxIds(html) {
      return [...html.matchAll(/<input\b[^>]*type="checkbox"[^>]*id="([^"]+)"[^>]*>/g)]
        .map(([, id]) => id);
    }

    function expectAccessibleSwitches(html) {
      const ids = checkboxIds(html);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(html).toContain(`for="${id}"`);
      }
      expect(html).toContain('name="enabled" value="0"');
      expect(html).toContain('name="enabled"');
      expect(html).toContain('value="1"');
      const hiddenEnabledInputs = [...html.matchAll(/<input\b[^>]*type="hidden"[^>]*name="enabled"[^>]*>/g)]
        .map(([input]) => input);
      expect(hiddenEnabledInputs.length).toBeGreaterThan(0);
      for (const input of hiddenEnabledInputs) expect(input).toContain('tabindex="-1"');
      expect(html).toContain('form-switch-track');
      expect(html).toContain('form-switch-state--on');
      expect(html).toContain('form-switch-state--off');
    }

    function enabledForms(html) {
      return html.match(/<form\b[^>]*class="[^"]*\bcategory-enabled-form\b[^"]*"[^>]*>[\s\S]*?<\/form>/gi) || [];
    }

    function expectDirectEnabledSubmission(html, { fallback = true } = {}) {
      const forms = enabledForms(html);
      expect(forms.length).toBeGreaterThan(0);
      for (const form of forms) {
        expect(form).toContain('name="_csrf"');
        expect(form).toContain('data-autosubmit');
        if (fallback) {
          expect(form).toMatch(/<noscript>\s*<button[^>]*>Save status<\/button>\s*<\/noscript>/i);
        } else {
          expect(form).not.toContain('Save status');
        }
        const normalMarkup = form.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
        expect(normalMarkup).not.toMatch(/<button\b/i);
      }
    }

    it('project category rows keep slugs read-only, expose name editing, and use native labelled switches', async () => {
      const projectRes = await agent
        .post('/projects')
        .type('form')
        .send({ title: 'Switch Markup Project', status: 'tbd', priority: 'normal', _csrf: csrfToken })
        .expect(302);
      const projectId = projectRes.headers.location.replace('/projects/', '');
      const category = db.prepare(`
        SELECT * FROM project_asset_categories
        WHERE project_id = ?
        ORDER BY display_order ASC, id ASC
        LIMIT 1
      `).get(Number(projectId));

      const res = await agent.get(`/projects/${projectId}/assets?manage_categories=1`).expect(200);
      const categoryDialog = res.text.match(/<dialog id="project-asset-category-management-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(categoryDialog).not.toBe('');
      expect(categoryDialog).toContain('class="app-dialog-body project-asset-category-management-dialog-body"');
      expect(categoryDialog).toContain('<h3 id="project-asset-categories-default-category-heading">Asset browser default</h3>');
      expect(categoryDialog).toContain('<h3>Add a category</h3>');
      expect(categoryDialog).toContain('<h3>Categories</h3>');
      expect(categoryDialog).toContain(
        'Manage categories and asset browser defaults for Switch Markup Project. Changes here apply only to this project.'
      );
      expect(categoryDialog).not.toMatch(/Saved:\s*Inherit global default/);
      expect(categoryDialog).not.toMatch(/Effective:\s*All Categories/);
      expect(categoryDialog).not.toContain('data-asset-browser-default-saved');
      expect(categoryDialog).not.toContain('data-asset-browser-default-effective');
      expect(categoryDialog).not.toContain('project-category-management-panel-heading');
      expectAccessibleSwitches(categoryDialog);
      expectDirectEnabledSubmission(categoryDialog);
      expect(res.text).toContain(`/projects/${projectId}/asset-categories/${category.id}/enabled`);
      expect(res.text).toContain('>Save status</button>');
      expect(categoryDialog).toContain('data-asset-browser-default-live');
      expect(categoryDialog).toContain('data-asset-browser-default-status');
      expect(categoryDialog).not.toContain('>Save default</button>');
      expect(res.text).toContain('asset-browser-default-section--project');
      expect(res.text).toContain('asset-browser-default-control-row');
      expect(res.text).toContain('name="defaultCategory" class="cc-dropdown-native-select form-control"');
      expect(res.text).not.toContain('New categories are enabled by default.');
      expect(res.text).toContain('category-management-card');
      expect(res.text).toContain('category-management-add');
      expect(res.text).toContain('category-management-card-controls');
      expect(res.text).toContain('Changing a display name does not rename its directory.');
      expect(res.text).not.toContain('Changes the label only — the folder on disk is not renamed.');
      expect(res.text).toContain('data-category-reorder-list');
      expect(res.text).not.toContain('>Position</th>');
      expect(res.text).not.toContain('>Move Up</button>');
      expect(res.text).not.toContain('>Move Down</button>');
      expect(res.text).toContain('>Save status</button>');

      const defaultSection = res.text.match(/<section class="project-category-management-panel project-category-management-default-section[^"]*asset-browser-default-section--project[^"]*"[^>]*>[\s\S]*?<\/section>/)?.[0] || '';
      const defaultFieldRow = defaultSection.match(/<div class="field asset-browser-default-field-row">[\s\S]*?<\/div>/)?.[0] || '';
      expect(defaultFieldRow).toContain('asset-browser-default-field-row');
      expect(defaultFieldRow.indexOf('<label')).toBeGreaterThan(-1);
      expect(defaultSection.indexOf('<select')).toBeGreaterThan(defaultSection.indexOf('<legend>Default category</legend>'));
      expect(defaultSection).toContain('class="cc-dropdown-native-select form-control"');
      expect(defaultSection).toContain('asset-browser-default-dropdown-field');
      expect(defaultFieldRow).not.toMatch(/class="[^"]*(?:full-width|width-100|stretch)[^"]*"/i);
      expect(defaultSection.indexOf('asset-browser-default-control-row')).toBeGreaterThan(-1);
       expect(defaultSection).toContain('Apply selection');
       expect(defaultSection.indexOf('asset-browser-default-control-row')).toBeGreaterThan(-1);
      const addForm = res.text.match(new RegExp(
        `<form method="post" action="/projects/${projectId}/asset-categories"[^>]*>[\\s\\S]*?<\\/form>`
      ))?.[0] || '';
      expect(addForm.indexOf('project-category-management-add-row')).toBeGreaterThan(-1);
      expect(addForm.indexOf('project-category-management-add-submit')).toBeGreaterThan(addForm.indexOf('project-category-management-add-row'));
      expect(addForm.indexOf('for="add-displayName"')).toBeLessThan(addForm.indexOf('for="add-directorySlug"'));
      expect(addForm.indexOf('for="add-directorySlug"')).toBeLessThan(addForm.indexOf('class="field-label">Enabled</span>'));
       expect(addForm.indexOf('class="field-label">Enabled</span>')).toBeLessThan(addForm.indexOf('>Add</button>'));
       expect(addForm).toContain('>Add</button>');
       expect(addForm).toMatch(/<div class="project-category-management-add-submit form-actions">[\s\S]*>Add<\/button>/);
      expect(addForm).toMatch(/<input\s+type="checkbox"\s+id="add-enabled"[\s\S]*?checked/);
      expect(addForm).not.toContain('data-autosubmit');

      const categoryCards = res.text.match(/<article\b[^>]*data-category-reorder-item[^>]*>[\s\S]*?<\/article>/g) || [];
      expect(categoryCards.length).toBeGreaterThan(0);
      for (const card of categoryCards) {
        expect((card.match(/data-category-reorder-handle/g) || []).length).toBe(1);
        expect(card).toContain('Save name');
        expect(card).toContain('data-autosubmit');
        expect(card).toContain('>Delete</button>');
      }
      expect(res.text).not.toContain('<table class="data-table category-management-table">');

      const nameForm = res.text.match(new RegExp(
        `<form method="post" action="/projects/${projectId}/asset-categories/${category.id}/name"[^>]*>[\\s\\S]*?<\\/form>`
      ))?.[0];
      expect(nameForm).toBeDefined();
      expect(nameForm).toContain('name="_csrf"');
      expect(nameForm).toContain('name="displayName"');
      expect(nameForm).toContain(`value="${category.display_name}"`);
      expect(nameForm).toContain('>Save name</button>');
      expect(nameForm).not.toContain('directorySlug');

      const nameInputId = nameForm.match(/<input type="text" id="([^"]+)" name="displayName"/)?.[1];
      expect(nameInputId).toBe(`name-${category.id}`);
      expect(nameForm).toContain(`<label class="sr-only" for="${nameInputId}">`);
      expect(res.text).toContain(`<code>${category.directory_slug}</code>`);

      const ids = [...res.text.matchAll(/(?:^|\s)id="([^"]+)"/g)].map(([, id]) => id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(hasNestedForms(res.text)).toBe(false);
      expect((res.text.match(/<form\b/gi) || []).length).toBe((res.text.match(/<\/form>/gi) || []).length);
      expect(hasNestedForms(categoryDialog)).toBe(false);
      for (const form of categoryDialog.match(/<form\b[\s\S]*?<\/form>/gi) || []) {
        expect(form).toContain('name="_csrf"');
      }
    });

    it('keeps the Manage Categories dialog body scrollable when it exceeds the viewport', () => {
      // The shared dialog primitive caps the card at the viewport and scrolls
      // .app-dialog-body. Keep each management section content-sized so the
      // body owns overflow and lower controls remain reachable.
      expect(creatorCrateCss).toMatch(
        /#project-asset-category-management-dialog \.app-dialog-body > \*\s*\{\s*flex-shrink:\s*0;\s*\}/
      );
      const sharedDialogBodyRule = creatorCrateCss.match(
        /(?:^|\n)\s*\.app-dialog-body\s*\{([^}]*)\}/
      )?.[1] || '';
      expect(sharedDialogBodyRule).toMatch(/scrollbar-color:\s*var\(--border-strong\)\s+transparent/);
      expect(sharedDialogBodyRule).toMatch(/scrollbar-width:\s*thin/);
      expect(creatorCrateCss).toMatch(
        /\.app-dialog-body::\-webkit-scrollbar\s*\{[^}]*width:\s*0\.5rem/
      );
      expect(creatorCrateCss).toMatch(
        /\.app-dialog-body::\-webkit-scrollbar-thumb\s*\{[\s\S]*?background:\s*var\(--border-strong\)[\s\S]*?border:\s*2px solid var\(--surface-card\)[\s\S]*?border-radius:\s*999px/
      );
      expect(creatorCrateCss).toMatch(
        /\.app-dialog-body::\-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/
      );
      expect(creatorCrateCss).toMatch(
        /\.app-dialog-body::\-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*var\(--muted\)/
      );
      expect(creatorCrateCss).toMatch(
        /#project-asset-category-management-dialog \.asset-filter-multiselect-panel\[data-cc-dropdown-overlay\]\s*\{[^}]*position:\s*fixed/
      );
      // The shared scroll container must keep owning the dialog layout.
      expect(creatorCrateCss).toMatch(/\.app-dialog-body\s*\{[^}]*overflow-y:\s*auto/);
      expect(creatorCrateCss).toMatch(/\.app-dialog-card\s*\{[^}]*max-height:\s*calc\(100vh - 2rem\)/);
    });

    it('uses the shared settings-section layout for Asset Viewer and Edit Asset', () => {
      expect(assetViewerTemplate).toContain('settings-section asset-viewer-section asset-metadata-section');
      expect(assetViewerTemplate).toContain('settings-section asset-viewer-section asset-tags-section');
      expect(assetViewerTemplate).toContain('settings-section asset-viewer-section asset-release-usage-section');
      expect(assetViewerTemplate).toContain('asset-viewer-section-body asset-metadata-section-body');
      expect(assetViewerTemplate).toContain('asset-viewer-section-body asset-tags-section-body');
      expect(assetViewerTemplate).toContain('asset-viewer-section-body asset-release-usage-section-body');
      expect(assetViewerTemplate).toContain('project-detail-action-toolbar asset-viewer-action-toolbar');

      expect(assetEditDialogTemplate).toContain("'asset-edit-dialog asset-form-dialog'");
      expect(assetEditDialogTemplate).toContain('asset-edit-dialog-section-body asset-tags-edit-section-body');
      expect(assetEditDialogTemplate).toContain('asset-edit-dialog-section-body asset-primary-image-section-body');
      expect(assetEditDialogTemplate).toContain('asset-edit-dialog-section-body asset-edit-dialog-actions-body');

      expect(creatorCrateCss).toMatch(/#asset-edit-dialog\s*\{[^}]*width:\s*min\(51rem,\s*calc\(100vw - 2rem\)\)/);
      expect(creatorCrateCss).toMatch(/\.asset-form-dialog \.app-dialog-body > \*\s*\{\s*flex-shrink:\s*0;/);
      expect(creatorCrateCss).toMatch(/\.asset-form-dialog \.asset-filter-multiselect-panel\[data-cc-dropdown-overlay\]\s*\{[^}]*position:\s*fixed/);
      expect(creatorCrateCss).toMatch(/\.asset-viewer-action-toolbar\s*\{[^}]*margin:\s*var\(--space-lg\) 0 var\(--space-xl\)/);
      expect(creatorCrateCss).toMatch(/\.asset-viewer-section\s*\{[^}]*background:\s*var\(--surface\)/);
      expect(creatorCrateCss).toMatch(/\.asset-viewer-section > h3\s*\{[^}]*background:\s*var\(--surface-hover\)/);

      // The Viewer h3 sits inside a <section class="settings-section asset-viewer-section ...">,
      // so it is simultaneously matched by the generic `.settings-section h3` rule and the
      // Viewer-specific rule. Equal-specificity + later-source-order previously let the generic
      // rule win, silently defeating the Viewer header color. Prove the Viewer-specific selector
      // now wins the cascade outright, not merely that both rules exist.
      expect(assetViewerTemplate).toMatch(
        /<section class="settings-section asset-viewer-section[^"]*"[^>]*>\s*<h3[ >]/
      );

      const genericHeaderSelector = '.settings-section h3';
      const viewerHeaderSelector = '.settings-section.asset-viewer-section > h3';
      const viewerHeaderRule = new RegExp(
        `${viewerHeaderSelector.replace(/\./g, '\\.')}\\s*\\{[^}]*background:\\s*var\\(--surface-hover\\)`
      );
      expect(creatorCrateCss).toMatch(viewerHeaderRule);
      // Specificity: both selectors carry exactly one type selector (h3); the Viewer selector
      // must carry strictly more classes than the generic one to win regardless of source order.
      expect((viewerHeaderSelector.match(/\./g) ?? []).length).toBeGreaterThan(
        (genericHeaderSelector.match(/\./g) ?? []).length
      );
      // Confirm the defect precondition still holds: the generic rule appears LATER in source
      // than the Viewer-specific one, which is exactly the ordering that let equal-specificity
      // selectors misbehave before this fix. The specificity check above is what proves the
      // Viewer rule wins despite losing on source order.
      expect(creatorCrateCss.lastIndexOf(genericHeaderSelector)).toBeGreaterThan(
        creatorCrateCss.indexOf(viewerHeaderSelector)
      );

      // Same cascade defect, same fix, for the Viewer section's intended outer margin: the
      // shared `.settings-section { margin-bottom: ... }` rule has equal specificity to the
      // plain `.asset-viewer-section` margin rule and previously clobbered its margin-bottom.
      const genericSectionSelector = '.settings-section';
      const viewerSectionSelector = '.settings-section.asset-viewer-section';
      expect(creatorCrateCss).toMatch(
        /\.settings-section\s*\{[^}]*margin-bottom:\s*var\(--space-lg\)/
      );
      expect(creatorCrateCss).toMatch(
        new RegExp(
          `${viewerSectionSelector.replace(/\./g, '\\.')}\\s*\\{[^}]*margin:\\s*var\\(--space-xl\\) 0`
        )
      );
      expect((viewerSectionSelector.match(/\./g) ?? []).length).toBeGreaterThan(
        (genericSectionSelector.match(/\./g) ?? []).length
      );
      expect(creatorCrateCss.lastIndexOf('.settings-section {')).toBeGreaterThan(
        creatorCrateCss.indexOf(viewerSectionSelector)
      );

      expect(creatorCrateCss).toMatch(/\.asset-metadata-section-body\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
      expect(creatorCrateCss).toMatch(/@media \(max-width: 540px\)\s*\{[\s\S]*?\.asset-metadata-section-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);

      expect(assetViewerTemplate).not.toContain('asset-metadata-identity-heading');
      expect(assetViewerTemplate).not.toContain('>Identity</h4>');
      expect(assetViewerTemplate).not.toContain('Canonical relative path');
      expect(assetViewerTemplate).toContain('asset-metadata--summary');
      expect(assetViewerTemplate).toContain('/{{ project.slug }}/{% if asset.category %}{{ asset.category.directorySlug }}/{% endif %}');
      expect(assetViewerTemplate).toMatch(/<dl class="detail-list asset-metadata asset-metadata--summary">[\s\S]*?<dt>Filename<\/dt>\s*<dd><code>\{\{ asset\.filename \}\}<\/code><\/dd>[\s\S]*?<dt>Location<\/dt>\s*<dd>\/\{\{ project\.slug/);
      for (const heading of ['File details', 'State and history', 'ComfyUI Workflow']) {
        expect(assetViewerTemplate).toContain(`asset-metadata-group-title">${heading}</h4>`);
      }
      expect(assetViewerTemplate.match(/asset-metadata-group asset-metadata-group--panel/g)).toHaveLength(3);
      expect(assetViewerTemplate).toMatch(/asset-metadata-file-details-heading[\s\S]*?<dl class="detail-list asset-metadata">[\s\S]*?<dt>Category<\/dt>\s*<dd>/);
      expect(assetViewerTemplate).toMatch(/asset-metadata-state-heading[\s\S]*?<dl class="detail-list asset-metadata">[\s\S]*?<dt>Presence<\/dt>\s*<dd>[\s\S]*?status-badge\.njk/);
      expect(creatorCrateCss).toMatch(/\.asset-metadata-group--panel\s*\{[^}]*padding:\s*var\(--space-md\)[^}]*background:\s*var\(--surface-hover\)[^}]*border:\s*1px solid var\(--border\)[^}]*border-radius:\s*var\(--radius-md\)/);
      expect(assetViewerTemplate).toContain('asset-metadata-group--workflow');
      expect(creatorCrateCss).toMatch(/\.asset-metadata-group--workflow\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*min-width:\s*0/);
      expect(creatorCrateCss).toMatch(/\.asset-workflow-json\s*\{[^}]*overflow-x:\s*auto/);
      expect(creatorCrateCss).toMatch(/\.asset-workflow-json\s*\{[^}]*scrollbar-color:\s*var\(--border-strong\)\s+transparent[^}]*scrollbar-width:\s*thin/);
      expect(creatorCrateCss).toMatch(/\.asset-workflow-json::\-webkit-scrollbar\s*\{\s*height:\s*0\.45rem/);
      expect(creatorCrateCss).toMatch(/\.asset-workflow-json::\-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--border-strong\)[^}]*border-radius:\s*999px/);
      expect(assetViewerTemplate).toMatch(/\{% if asset\.imageDimensions %\}[\s\S]*?<dt>Width<\/dt>\s*<dd>\{\{ asset\.imageDimensions\.width \}\}<\/dd>[\s\S]*?<dt>Height<\/dt>\s*<dd>\{\{ asset\.imageDimensions\.height \}\}<\/dd>[\s\S]*?\{% endif %\}/);
      for (const label of [
        'Filename',
        'Location',
        'Category',
        'Extension',
        'MIME type',
        'Width',
        'Height',
        'Size',
        'Modified time',
        'Presence',
        'Last seen',
        'Missing since'
      ]) {
        expect(assetViewerTemplate).toContain(`<dt>${label}</dt>`);
      }
      expect(assetViewerTemplate).not.toContain('<dt>Recorded MIME type</dt>');
      expect(assetViewerTemplate).not.toContain('<dt>Recorded modified time</dt>');
      expect(assetViewerTemplate.indexOf('asset-metadata-file-details-heading')).toBeLessThan(
        assetViewerTemplate.indexOf('asset-metadata-state-heading')
      );
      expect(assetViewerTemplate.indexOf('asset-metadata-state-heading')).toBeLessThan(
        assetViewerTemplate.indexOf('asset-metadata-workflow-heading')
      );

      const assetViewerHelpTextSelector = '.settings-section .asset-viewer-section-body .help-text';
      const sharedSettingsHelpTextSelector = '.settings-section .help-text';
      expect(creatorCrateCss).toMatch(
        new RegExp(`${assetViewerHelpTextSelector.replace(/\./g, '\\.')}\\s*\\{[^}]*padding:\\s*0`)
      );
      expect(creatorCrateCss.indexOf(assetViewerHelpTextSelector)).toBeLessThan(
        creatorCrateCss.indexOf(sharedSettingsHelpTextSelector)
      );
      expect((assetViewerHelpTextSelector.match(/\./g) ?? []).length).toBeGreaterThan(
        (sharedSettingsHelpTextSelector.match(/\./g) ?? []).length
      );
    });

    it('global category cards use native labelled switches, complete reorder semantics, and scoped layout classes', async () => {
      const res = await agent.get('/settings/asset-categories').expect(200);
      const categories = db.prepare(
        'SELECT * FROM asset_category_defaults ORDER BY display_order ASC, id ASC'
      ).all();
      expectAccessibleSwitches(res.text);
      expectDirectEnabledSubmission(res.text);
      expect(res.text).toContain('category-management-add');
      expect(res.text).not.toContain('New global categories are enabled by default.');

      expect(res.text).toContain('data-category-reorder-list');
      expect(res.text).toContain('data-reorder-url="/settings/asset-categories/reorder"');
      expect(res.text).toContain('data-category-reorder-form');
      expect(res.text).toContain('name="orderedCategoryIds"');
      expect(res.text).toContain('data-category-reorder-live');

      const cards = res.text.match(/<article\b[^>]*data-category-reorder-item[^>]*>[\s\S]*?<\/article>/g) || [];
      expect(cards).toHaveLength(categories.length);
      expect(cards.map((card) => card.match(/data-category-id="(\d+)"/)?.[1]))
        .toEqual(categories.map((category) => String(category.id)));
      for (const [index, card] of cards.entries()) {
        const category = categories[index];
        const categoryId = category.id;
        expect((card.match(/data-category-reorder-handle/g) || []).length).toBe(1);
        expect(card).toContain(`draggable="true"`);
        expect(card).toContain(`aria-label="Reorder ${category.display_name}"`);
        expect(card).toContain(`aria-posinset="${index + 1}"`);
        expect(card).toContain(`aria-setsize="${categories.length}"`);
        expect(card).toContain(`action="/settings/asset-categories/${categoryId}"`);
        expect(card).toContain(`id="global-category-${categoryId}-display-name"`);
        expect(card).toContain(`for="global-category-${categoryId}-display-name"`);
        expect(card).toContain(`id="global-category-${categoryId}-directory-slug"`);
        expect(card).toContain(`for="global-category-${categoryId}-directory-slug"`);
        expect(card).toContain('name="displayName"');
        expect(card).toContain('name="directorySlug"');
        expect(card).toContain('>Save details</button>');
        expect(card).toContain(`/settings/asset-categories/${categoryId}/enabled`);
        expect(card).toContain('data-autosubmit');
        expect(card).toContain(`/settings/asset-categories/${categoryId}/delete`);
        expect(card).toContain('>Delete</button>');
      }

      expect(res.text).not.toContain('<th>Position</th>');
      expect(res.text).not.toContain('>Move Up</button>');
      expect(res.text).not.toContain('>Move Down</button>');
      expect(res.text).not.toContain('category-management-status');
      expect(res.text).not.toContain('status-badge');
      expect(res.text).not.toContain('category-management-table');
      expect(res.text).not.toContain('/settings/asset-categories?edit=');
      expect(res.text.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '')).not.toContain('>Save status</button>');
      expect(hasNestedForms(res.text)).toBe(false);
      expect((res.text.match(/<form\b/gi) || []).length).toBe((res.text.match(/<\/form>/gi) || []).length);

      const ids = [...res.text.matchAll(/(?:^|\s)id="([^"]+)"/g)].map(([, id]) => id);
      expect(new Set(ids).size).toBe(ids.length);

      const defaultSection = res.text.match(/<section class="settings-section asset-browser-default-section"[^>]*>[\s\S]*?<\/section>/)?.[0] || '';
      const defaultFieldRow = defaultSection.match(/<div class="field asset-browser-default-field-row">[\s\S]*?<\/div>/)?.[0] || '';
      expect(defaultFieldRow).toContain('class="form-control"');
      expect(defaultFieldRow.indexOf('<label')).toBeGreaterThan(-1);
      expect(defaultFieldRow.indexOf('<select')).toBeGreaterThan(defaultFieldRow.indexOf('<label'));
      expect(defaultFieldRow).not.toMatch(/class="[^"]*(?:full-width|width-100|stretch)[^"]*"/i);
      expect(defaultSection.indexOf('asset-browser-default-action-row')).toBeGreaterThan(defaultSection.indexOf('asset-browser-default-control-row'));
      const addForm = res.text.match(/<form method="post" action="\/settings\/asset-categories"[^>]*>[\s\S]*?<\/form>/)?.[0] || '';
      expect(addForm.indexOf('field-row')).toBeGreaterThan(-1);
      expect(addForm.indexOf('category-management-action-row')).toBeGreaterThan(addForm.indexOf('field-row'));
      expect(addForm).toContain('>Add Default</button>');
      expect(addForm).toMatch(/<div class="form-actions category-management-action-row">[\s\S]*>Add Default<\/button>/);
      expect(addForm).toMatch(/<input\s+type="checkbox"\s+id="add-enabled"[\s\S]*?checked/);
      expect(addForm).not.toContain('data-autosubmit');
    });

    it('archived project defaults and enabled rows remain read-only', async () => {
      const projectRes = await agent
        .post('/projects')
        .type('form')
        .send({ title: 'Archived Switch Markup', status: 'tbd', priority: 'normal', _csrf: csrfToken })
        .expect(302);
      const projectId = projectRes.headers.location.replace('/projects/', '');

      await agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
      const res = await agent.get(`/projects/${projectId}/assets?manage_categories=1`).expect(200);

      expect(res.text).not.toMatch(/class="[^"]*category-enabled-form[^"]*"/);
      expect(res.text).not.toContain('data-autosubmit');
      expect(res.text).not.toMatch(/<form method="post" action="\/projects\/\d+\/asset-categories\/default"/);
      expect(res.text).toMatch(/<input\s+type="checkbox"\s+id="project-category-enabled-\d+"[\s\S]*?disabled/);
    });

    it('switch and category layout styles are scoped and keyboard-visible', async () => {
      const res = await agent.get('/settings/asset-categories').expect(200);
      const css = await extractStyle(agent, res.text);

      expect(css).toContain('.form-switch');
      expect(css).toContain('.form-switch-control:focus-visible + .form-switch-label');
      expect(css).toContain('.form-switch-control:checked + .form-switch-label .form-switch-track');
      expect(css).toContain('.settings-category-management-section');
      expect(css).toMatch(/:is\(\.project-category-management-section, \.settings-category-management-section\)[\s\S]*?\.category-management-card/);
      expect(css).toContain('.settings-category-management-section .category-details-form');
      expect(css).toContain('.settings-category-management-section .category-details-form input:focus-visible');
      expect(css).toContain('.settings-category-management-section .category-management-details-actions');
      expect(css).toContain('.category-management-add');
      expect(css).toContain('.category-name-form');
      expect(css).toContain('.category-name-form input:focus-visible');
      expect(css).toContain('.asset-browser-default-control-row');
      expect(css).toContain('.asset-browser-default-field-row');
      expect(css).toMatch(/\.asset-browser-default-field-row[\s\S]*?flex-direction:\s*row/);
      expect(css).toMatch(/\.asset-browser-default-field-row[\s\S]*?flex-wrap:\s*wrap/);
      expect(css).toMatch(/\.asset-browser-default-field-row \.form-control[\s\S]*?width:\s*max-content/);
       expect(css).toMatch(/\.asset-browser-default-field-row \.form-control[\s\S]*?max-width:\s*100%/);
       expect(css).toMatch(/\.asset-browser-default-field-row \.form-control[\s\S]*?flex:\s*0 1 auto/);
       expect(css).toMatch(/#project-asset-category-management-dialog \.asset-browser-default-field-row\s*\{[^}]*width:\s*100%/);
       expect(css).toContain('.asset-browser-default-action-row > .button');
       expect(css).toContain('.category-management-form > .category-management-action-row > .button');
       expect(css).toMatch(/\.asset-browser-default-action-row\s*\{[\s\S]*?align-self:\s*flex-start;[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*100%/);
       expect(css).toMatch(/\.asset-browser-default-action-row > \.button\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?width:\s*auto/);
       expect(css).toMatch(/\.category-management-form > \.category-management-action-row\s*\{[\s\S]*?align-self:\s*flex-start;[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*100%/);
       expect(css).toMatch(/\.category-management-form > \.category-management-action-row > \.button\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?width:\s*auto/);
       expect(css).toContain('#project-asset-category-management-dialog .project-category-management-add-row');
       expect(css).toMatch(/#project-asset-category-management-dialog \.project-category-management-add-row\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/);
      expect(css).toMatch(/#project-asset-category-management-dialog \.project-category-management-add-submit\s*\{[\s\S]*?align-items:\s*flex-end/);
      expect(css).toMatch(/#project-asset-category-management-dialog\s*\{[\s\S]*?width:\s*min\(68rem,\s*calc\(100vw - 2rem\)\)/);
      expect(css).toMatch(/#project-asset-category-management-dialog \.project-category-management-default-section \.asset-browser-default-form\s*\{[\s\S]*?padding:\s*var\(--space-md\) var\(--space-lg\) 0/);
       expect(css).toMatch(/\.app-dialog \.asset-filter-multiselect-field\s*\{/);
       expect(css).toMatch(/\.asset-filter-multiselect-field\s*\{[\s\S]*?width:\s*max-content[\s\S]*?max-width:\s*min\(100%,\s*26rem\)/);
       expect(css).toMatch(/#project-asset-category-management-dialog \.project-category-management-panel > h3\s*\{[^}]*background:\s*var\(--surface-hover\)/);
       expect(css).toMatch(/#project-asset-category-management-dialog \.asset-filter-multiselect-panel\[data-cc-dropdown-overlay\]\s*\{[^}]*position:\s*fixed[^}]*min-width:\s*0/);
       expect(css).toMatch(/#project-asset-category-management-dialog \.project-category-management-add-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\) max-content max-content;[\s\S]*?align-items:\s*start;[\s\S]*?column-gap:/);
       expect(css).toMatch(/\.settings-section h3\s*\{[\s\S]*?padding:\s*var\(--space-sm\) var\(--space-md\);[\s\S]*?font-family:\s*var\(--mono\);[\s\S]*?text-transform:\s*uppercase/);
       expect(css).toMatch(/@media \(max-width:\s*767px\)[\s\S]*?project-category-management-add-row[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
      expect(css).toMatch(/@media \(max-width:\s*540px\)[\s\S]*?project-category-management-add-row[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
      expect(css).not.toMatch(/(?:^|\n)\s*(?:button|select|\.form-control)\s*\{/i);
      expect(css).toContain('.category-reorder-handle:focus-visible');
      expect(css).toContain('.category-management-card.is-drop-before');
      expect(css).not.toContain('.project-category-management-section .category-management-table');
      expect(css).toContain('.asset-select-cell input[type="checkbox"]');
      expect(css).not.toMatch(/(?:^|\n)\s*input\[type=['"]checkbox['"]\]\s*\{/i);
    });
  });

  // ─── 12. No second page h1 ────────────────────────────────────────────

  describe('single h1 per page', () => {
    it('project form has exactly one h1', async () => {
      const res = await agent.get('/projects/new').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('project detail has exactly one h1', async () => {
      const createRes = await agent
        .post('/projects')
        .send('title=H1+Test')
        .send('status=tbd')
        .send('priority=normal')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('project list has exactly one h1', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('dashboard has exactly one h1', async () => {
      const res = await agent.get('/').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });

    it('published work page has exactly one h1', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(countTags(res.text, 'h1')).toBe(1);
    });
  });

  // ─── 13. Mobile-safe class structure ───────────────────────────────────

  describe('mobile-safe class structure', () => {
    it('page-heading has mobile responsive CSS', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = await extractStyle(agent, res.text);
      // Mobile breakpoint exists
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)/);
      // page-heading flex-direction: column on mobile
      expect(css).toMatch(/\.page-heading\s*\{[^}]*flex/i);
      expect(css).toContain('flex-wrap');
    });

    it('heading action rows keep view switchers and buttons at their intrinsic heights', async () => {
      const res = await agent.get('/releases').expect(200);
      const css = await extractStyle(agent, res.text);

      expect(css).toMatch(/\.page-heading-actions\s*\{[^}]*align-items:\s*center/);
      expect(css).toMatch(/\.page-heading-actions\s*>\s*\.view-switcher\s*\{[^}]*margin-bottom:\s*0/);
      expect(css).toMatch(/\.view-switcher\s*\{[^}]*margin-bottom:\s*var\(--space-lg\)/);
    });

    it('data-table has responsive styles', async () => {
      const res = await agent.get('/projects').expect(200);
      const css = await extractStyle(agent, res.text);
      expect(css).toContain('.data-table');
      expect(css).toContain('.table-scroll');
    });

    it('field-row becomes column on mobile', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const css = await extractStyle(agent, res.text);
      // The mobile breakpoint must contain a rule that makes field-row stack
      // This is split across lines, so check for the class and the property separately
      expect(css).toContain('.field-row');
      // Check the mobile media query exists
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)/);
    });
  });
});
