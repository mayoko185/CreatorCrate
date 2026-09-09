import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  flattenBookPagePreviewCandidates,
  resolveBookPagePreviews,
} from '../src/routes/notes.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function page(id, title = `Page ${id}`, content = `Content ${id}`) {
  return { id, title, content, updated_at: `2026-09-${String(id).padStart(2, '0')} 12:00:00` };
}

function previewSection(html) {
  return html.match(/<section class="notes-detail-panel notes-page-previews"[\s\S]*?<\/section>/)?.[0] || '';
}

function captureBookDetailLocals(app) {
  let locals = null;
  const originalRender = app.response.render;
  app.response.render = function captureRender(view, renderLocals, callback) {
    if (view === 'notes/books/detail.njk') locals = renderLocals;
    return originalRender.call(this, view, renderLocals, callback);
  };
  return {
    get: () => locals,
    restore: () => { app.response.render = originalRender; },
  };
}

function insertProject(db, title) {
  return Number(db.prepare(`
    INSERT INTO projects (title, slug, description, notes, status, patreon_url)
    VALUES (?, ?, '', '', 'tbd', NULL)
  `).run(title, title.toLowerCase().replace(/\s+/g, '-')).lastInsertRowid);
}

function insertAsset(db, projectId, filename) {
  return db.prepare(`
    INSERT INTO assets (
      project_id, relative_path, filename, extension, mime_type, size_bytes,
      is_present, last_seen_at
    ) VALUES (?, ?, ?, 'png', 'image/png', 1, 1, datetime('now'))
    RETURNING id
  `).get(projectId, filename, filename).id;
}

describe('Book Page preview selection', () => {
  it('flattens direct and Chapter Pages in authoritative order with their existing content', () => {
    const book = { title: 'Preview Book' };
    const contents = [
      { type: 'page', page: page(1, 'Direct Page', '  Direct\n content  ') },
      { type: 'chapter', chapter: { title: 'Chapter One' }, pages: [
        page(2, 'Chapter Page', 'x'.repeat(170)),
        page(3, 'Empty Page', ''),
      ] },
    ];

    const candidates = flattenBookPagePreviewCandidates(book, contents);

    expect(candidates.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(candidates[0]).toMatchObject({
      title: 'Direct Page', contextKind: 'book', contextTitle: 'Preview Book',
      content: '  Direct\n content  ', updatedAt: '2026-09-01 12:00:00',
    });
    expect(candidates[1].content).toHaveLength(170);
    expect(candidates[2].content).toBe('');
  });

  it.each([1, 5, 25])('samples %i Random Pages without replacement', (randomCount) => {
    const candidates = Array.from({ length: 30 }, (_value, index) => ({ id: index + 1 }));
    const items = resolveBookPagePreviews(
      candidates,
      undefined,
      { mode: 'random', randomCount, selectedPageIds: [] },
      () => 0.5,
    );

    expect(items).toHaveLength(randomCount);
    expect(new Set(items.map(({ id }) => id)).size).toBe(randomCount);
  });

  it('returns every Random Page when fewer exist and keeps sampled membership in Book order', () => {
    const candidates = [1, 2, 3, 4, 5].map((id) => ({ id }));
    expect(resolveBookPagePreviews(
      candidates, undefined, { mode: 'random', randomCount: 25, selectedPageIds: [] }, () => 0,
    ).map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);

    const draws = [0.7, 0];
    const sampled = resolveBookPagePreviews(
      candidates, undefined, { mode: 'random', randomCount: 2, selectedPageIds: [] },
      () => draws.shift(),
    );
    expect(sampled.map(({ id }) => id)).toEqual([2, 4]);
  });

  it('re-evaluates Random membership for each invocation', () => {
    const candidates = [1, 2, 3].map((id) => ({ id }));
    const settings = { mode: 'random', randomCount: 1, selectedPageIds: [] };
    expect(resolveBookPagePreviews(candidates, undefined, settings, () => 0).map(({ id }) => id)).toEqual([1]);
    expect(resolveBookPagePreviews(candidates, undefined, settings, () => 0.99).map(({ id }) => id)).toEqual([3]);
  });

  it('keeps every Book Page eligible when there is no current Page', () => {
    const book = { title: 'Whole Book' };
    const repeated = page(2, 'Repeated');
    const candidates = flattenBookPagePreviewCandidates(book, [
      { type: 'page', page: page(1, 'Direct') },
      { type: 'chapter', chapter: { title: 'Chapter' }, pages: [repeated, page(3, 'Nested')] },
      { type: 'page', page: repeated },
    ]);

    expect(resolveBookPagePreviews(
      [candidates[0]], undefined, { mode: 'random', randomCount: 5, selectedPageIds: [] }, () => 0,
    ).map(({ id }) => id)).toEqual([1]);
    expect(resolveBookPagePreviews(
      candidates, undefined, { mode: 'random', randomCount: 5, selectedPageIds: [] }, () => 0.99,
    ).map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(new Set(candidates.map(({ id }) => id)).size).toBe(candidates.length);
  });

  it('keeps all valid Selected Pages eligible without a current-Page exclusion', () => {
    const candidates = [
      { id: 1, contextKind: 'book' },
      { id: 2, contextKind: 'chapter' },
      { id: 3, contextKind: 'book' },
    ];

    expect(resolveBookPagePreviews(candidates, undefined, {
      mode: 'selected', randomCount: 5, selectedPageIds: [3, 2, 1, 2, 999],
    }).map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(resolveBookPagePreviews(candidates, undefined, {
      mode: 'selected', randomCount: 5, selectedPageIds: [],
    })).toEqual([]);
  });

  it('resolves Selected IDs through the catalogue in Book order without duplicates or mutation', () => {
    const candidates = [
      { id: 1, contextKind: 'book' },
      { id: 2, contextKind: 'chapter' },
      { id: 3, contextKind: 'book' },
      { id: 4, contextKind: 'chapter' },
    ];
    const settings = { mode: 'selected', randomCount: 5, selectedPageIds: [4, 2, 2, 3, 999] };

    expect(resolveBookPagePreviews(candidates, undefined, settings).map(({ id }) => id)).toEqual([2, 3, 4]);
    expect(settings.selectedPageIds).toEqual([4, 2, 2, 3, 999]);
    expect(resolveBookPagePreviews(candidates, undefined, { ...settings, selectedPageIds: [] })).toEqual([]);
  });
});

describe('Book Page preview HTTP rendering', () => {
  let app;
  let agent;
  let csrfToken;
  let db;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-previews-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
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
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses Random/5 by default, includes a single Book Page, and re-samples per request', async () => {
    const book = app.locals.bookService.createBook({ title: 'Book Random Model' });
    const first = app.locals.noteService.createNote({ bookId: book.id, title: 'First Eligible' });
    const capture = captureBookDetailLocals(app);

    try {
      const singlePageResponse = await agent.get(`/notes/books/${book.id}`).expect(200);
      expect(capture.get().bookPagePreviews).toMatchObject({
        mode: 'random', items: [{ id: first.id }],
      });
      expect(previewSection(singlePageResponse.text)).toContain(`href="/notes/${first.id}"`);

      const second = app.locals.noteService.createNote({ bookId: book.id, title: 'Second Eligible' });
      app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
        mode: 'random', randomCount: 1, selectedPageIds: [],
      });
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.99);

      await agent.get(`/notes/books/${book.id}`).expect(200);
      expect(capture.get().bookPagePreviews.items.map(({ id }) => id)).toEqual([first.id]);
      await agent.get(`/notes/books/${book.id}`).expect(200);
      expect(capture.get().bookPagePreviews.items.map(({ id }) => id)).toEqual([second.id]);
    } finally {
      capture.restore();
    }
  });

  it('builds the Book-detail model from its single contents and persisted-settings loads', async () => {
    const book = app.locals.bookService.createBook({ title: 'Book Model' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Nested Context' });
    const direct = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Preview' });
    const nested = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Nested Preview' });
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: direct.id },
      { type: 'chapter', id: chapter.id },
    ]);
    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5, selectedPageIds: [nested.id, direct.id],
    });
    const authoritativeContents = app.locals.bookService.listBookContents(book.id);
    const contentsSpy = vi.spyOn(app.locals.bookService, 'listBookContents').mockReturnValue(authoritativeContents);
    const settingsSpy = vi.spyOn(app.locals.bookPagePreviewSettingsService, 'getBookPagePreviewSettings');
    const capture = captureBookDetailLocals(app);

    try {
      await agent.get(`/notes/books/${book.id}`).expect(200);
      const locals = capture.get();

      expect(contentsSpy).toHaveBeenCalledTimes(1);
      expect(contentsSpy).toHaveBeenCalledWith(book.id);
      expect(settingsSpy).toHaveBeenCalledTimes(1);
      expect(settingsSpy).toHaveBeenCalledWith(book.id);
      expect(locals.contents).toBe(authoritativeContents);
      expect(locals.bookContents).toBe(authoritativeContents);
      expect(locals.bookPagePreviews).toMatchObject({ mode: 'selected' });
      expect(locals.bookPagePreviews.items.map(({ id }) => id)).toEqual([direct.id, nested.id]);
      expect(locals.bookPagePreviews.items.map(({ contextKind }) => contextKind)).toEqual(['book', 'chapter']);
      expect(locals.bookPagePreviews.items.every((item) => !Object.hasOwn(item, 'content'))).toBe(true);
      expect(locals.bookPagePreviews.items.every((item) => typeof item.contentHtml === 'string')).toBe(true);
      expect(locals.bookPagePreviews.items.every((item) => typeof item.truncated === 'boolean')).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it('renders Markdown only after Random preview resolution', async () => {
    const book = app.locals.bookService.createBook({ title: 'Render After Resolution' });
    for (let index = 0; index < 4; index += 1) {
      app.locals.noteService.createNote({
        bookId: book.id,
        title: `Candidate ${index + 1}`,
        content: `Rendered body ${index + 1}`,
      });
    }
    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'random', randomCount: 1, selectedPageIds: [],
    });
    const renderMarkdownPreview = vi.spyOn(app.locals.markdownRenderer, 'renderMarkdownPreview');

    await agent.get(`/notes/books/${book.id}`).expect(200);

    expect(renderMarkdownPreview).toHaveBeenCalledTimes(1);
  });

  it('renders sanitized Markdown previews while preserving heading, link, code, table, image, and empty behavior', async () => {
    const book = app.locals.bookService.createBook({ title: 'Markdown Preview Book' });
    const rendered = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Rendered Page',
      content: [
        'Rendered',
        'Page',
        '====',
        '',
        'A paragraph with *emphasis*, **strong text**, and `inline code`.',
        '[safe link](https://example.com/path)',
        '[unsafe link](javascript:alert(1))',
        '',
        '<script>alert("preview")</script>',
        '',
        '![remote image](https://example.com/image.png)',
      ].join('\n'),
    });
    const codeTable = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Code and table',
      content: [
        '| Name | Value |',
        '| --- | --- |',
        '| note | 42 |',
        '',
        '```js',
        'const answer = 42;',
        '```',
      ].join('\n'),
    });
    const long = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Long Page',
      content: `${'x'.repeat(481)} OMITTED-LONG-TAIL`,
    });
    const differentHeading = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Different Title',
      content: '# Retained heading\n\nBody.',
    });
    const empty = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Empty Page',
      content: '   ',
    });
    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5,
      selectedPageIds: [empty.id, differentHeading.id, rendered.id, codeTable.id, long.id],
    });

    const capture = captureBookDetailLocals(app);
    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const previews = previewSection(response.text);

    expect(capture.get().bookPagePreviews.items.filter(({ truncated }) => truncated).map(({ title }) => title))
      .toEqual(['Long Page']);
    capture.restore();

    expect(previews).not.toContain('<h1>Rendered<br />\nPage</h1>');
    expect(previews).toContain('<h1>Retained heading</h1>');
    expect(previews).toContain('<em>emphasis</em>');
    expect(previews).toContain('<strong>strong text</strong>');
    expect(previews).toContain('<a href="https://example.com/path">safe link</a>');
    expect(previews).not.toMatch(/<a\b[^>]*href=["']javascript:/i);
    expect(previews).not.toContain('<script>');
    expect(previews).toContain('&lt;script&gt;alert("preview")&lt;/script&gt;');
    expect(previews).toContain('<code>inline code</code>');
    expect(previews).toContain('<pre><code class="language-js">const answer = 42;\n</code></pre>');
    expect(previews).toContain('<table>');
    expect(previews).not.toContain('<img');
    expect(previews).not.toContain('OMITTED-LONG-TAIL');
    expect(previews).toContain('No content yet');
    expect(previews.match(/class="notes-page-preview-truncated"/g)).toHaveLength(1);
    expect(previews).toContain('Preview truncated');
    expect(previews).not.toContain('notes-page-preview-excerpt');

    const detail = (await agent.get(`/notes/${long.id}`).expect(200)).text;
    expect(detail).toContain('OMITTED-LONG-TAIL');
    expect(detail).not.toContain('notes-page-preview-truncated');
  });

  it('distinguishes genuine empty content from a nonempty preview truncated before HTML can render', async () => {
    const book = app.locals.bookService.createBook({ title: 'Empty Preview States' });
    const empty = app.locals.noteService.createNote({ bookId: book.id, title: 'Empty', content: ' \n\t ' });
    const oversizedTable = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Oversized Table',
      content: [`| ${'h'.repeat(481)} |`, '| --- |', '| body |'].join('\n'),
    });
    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5, selectedPageIds: [empty.id, oversizedTable.id],
    });

    const capture = captureBookDetailLocals(app);
    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const items = capture.get().bookPagePreviews.items;
    capture.restore();
    const previews = previewSection(response.text);
    const emptyItem = previews.match(new RegExp(
      `<li class="notes-page-preview-item">\\s*<a class="notes-page-preview-title" href="/notes/${empty.id}"[\\s\\S]*?</li>`,
    ))?.[0];
    const truncatedItem = previews.match(new RegExp(
      `<li class="notes-page-preview-item">\\s*<a class="notes-page-preview-title" href="/notes/${oversizedTable.id}"[\\s\\S]*?</li>`,
    ))?.[0];

    expect(items.find(({ id }) => id === oversizedTable.id)).toMatchObject({ contentHtml: '', truncated: true });
    expect(emptyItem).toContain('No content yet');
    expect(emptyItem).not.toContain('Preview truncated');
    expect(truncatedItem).not.toContain('No content yet');
    expect(truncatedItem).toContain('Preview truncated');
    expect(truncatedItem).toContain('notes-page-preview-truncated');
  });

  it('supplies persisted Book previews across every shared Book-detail shell', async () => {
    const book = app.locals.bookService.createBook({ title: 'Shared Shell' });
    const page = app.locals.noteService.createNote({ bookId: book.id, title: 'Eligible Page' });
    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5, selectedPageIds: [page.id],
    });
    const capture = captureBookDetailLocals(app);

    try {
      for (const url of [
        `/notes/books/${book.id}`,
        `/notes/books/${book.id}/edit`,
        `/notes/books/${book.id}/order`,
        `/notes/books/${book.id}/chapters/new`,
        `/notes/new?bookId=${book.id}`,
        `/notes/books/${book.id}?defaults=1`,
      ]) {
        await agent.get(url).expect(200);
        expect(capture.get().bookPagePreviews).toMatchObject({
          mode: 'selected', items: [{ id: page.id }],
        });
      }

      await agent.post(`/notes/books/${book.id}/defaults`).type('form').send({
        _csrf: csrfToken,
        navigation: 'collapsed',
        previewMode: 'invalid',
        randomPageCount: '12',
      }).expect(422);
      expect(capture.get().bookPagePreviews).toMatchObject({
        mode: 'selected', items: [{ id: page.id }],
      });
    } finally {
      capture.restore();
    }
  });

  it('renders Random/5 previews on Book detail with direct and Chapter Pages, but not on Page detail', async () => {
    const book = app.locals.bookService.createBook({ title: 'Random Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Random Chapter' });
    const current = app.locals.noteService.createNote({ bookId: book.id, title: 'Book-owned Page' });
    const direct = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Candidate' });
    const nested = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Nested Candidate' });
    for (let index = 0; index < 2; index += 1) {
      app.locals.noteService.createNote({ chapterId: chapter.id, title: `Extra ${index}` });
    }

    const response = await agent.get(`/notes/books/${book.id}`).expect(200);
    const previews = previewSection(response.text);

    expect(previews.match(/class="notes-page-preview-item"/g)).toHaveLength(5);
    expect(previews).toContain(`href="/notes/${current.id}"`);
    expect(previews).toContain(`href="/notes/${direct.id}"`);
    expect(previews).not.toContain('Book: Random Book');
    expect(previews).toContain('Chapter: Random Chapter');
    expect(previews).toContain(`href="/notes/${nested.id}"`);
    expect(previewSection((await agent.get(`/notes/${current.id}`).expect(200)).text)).toBe('');
  });

  it('re-samples Random membership on each Book-detail request', async () => {
    const book = app.locals.bookService.createBook({ title: 'Repeated Random Book' });
    const first = app.locals.noteService.createNote({ bookId: book.id, title: 'First Random Candidate' });
    const second = app.locals.noteService.createNote({ bookId: book.id, title: 'Second Random Candidate' });
    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'random', randomCount: 1, selectedPageIds: [],
    });
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.99);

    const firstRequest = previewSection((await agent.get(`/notes/books/${book.id}`).expect(200)).text);
    const secondRequest = previewSection((await agent.get(`/notes/books/${book.id}`).expect(200)).text);

    expect(firstRequest).toContain(`href="/notes/${first.id}"`);
    expect(firstRequest).not.toContain(`href="/notes/${second.id}"`);
    expect(secondRequest).toContain(`href="/notes/${second.id}"`);
    expect(secondRequest).not.toContain(`href="/notes/${first.id}"`);
  });

  it('renders Selected previews in Book order and keeps every Page-detail shell preview-free', async () => {
    const book = app.locals.bookService.createBook({ title: 'Selected Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Selected Chapter' });
    const projectId = insertProject(db, 'Preview Project');
    const assetId = insertAsset(db, projectId, 'preview-asset.png');
    const current = app.locals.noteService.createNote({
      bookId: book.id, title: 'Current Direct', content: 'Stored current body',
      projectIds: [projectId], assetIds: [assetId],
    });
    const direct = app.locals.noteService.createNote({
      bookId: book.id, title: 'A very long direct preview title that must wrap without widening the Page detail content column',
      content: '  Direct\n preview   excerpt  ',
    });
    const nested = app.locals.noteService.createNote({
      chapterId: chapter.id, title: 'Nested Preview', content: '',
    });
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: current.id },
      { type: 'page', id: direct.id },
      { type: 'chapter', id: chapter.id },
    ]);
    db.prepare("UPDATE notes SET updated_at = '2026-09-07 10:11:12' WHERE id = ?").run(direct.id);
    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5, selectedPageIds: [nested.id, current.id, direct.id],
    });

    const settingsSpy = vi.spyOn(app.locals.bookPagePreviewSettingsService, 'getBookPagePreviewSettings');
    const contentsSpy = vi.spyOn(app.locals.bookService, 'listBookContents');
    const bookResponse = await agent.get(`/notes/books/${book.id}`).expect(200);
    const previews = previewSection(bookResponse.text);
    expect(previews).toContain(`href="/notes/${current.id}"`);
    expect(previews).toContain(`href="/notes/${direct.id}"`);
    expect(previews).toContain('A very long direct preview title');
    expect(previews).not.toContain('Book: Selected Book');
    const directItem = previews.match(new RegExp(
      `<li class="notes-page-preview-item">\\s*<a class="notes-page-preview-title" href="/notes/${direct.id}"[\\s\\S]*?</li>`,
    ))?.[0];
    expect(directItem).not.toContain('notes-page-preview-context');
    expect(previews).toMatch(/Direct<br \/>\r?\n\s*preview\s+excerpt/);
    expect(previews).toContain('Updated 2026-09-07 10:11:12');
    expect(previews).toContain(`href="/notes/${nested.id}"`);
    expect(previews).toContain('Chapter: Selected Chapter');
    expect(previews).toContain('No content yet');
    expect(previews.indexOf(current.title)).toBeLessThan(previews.indexOf(direct.title));
    expect(previews.indexOf(direct.title)).toBeLessThan(previews.indexOf(nested.title));

    settingsSpy.mockClear();
    contentsSpy.mockClear();
    const pageResponses = [
      await agent.get(`/notes/${current.id}`).expect(200),
      await agent.get(`/notes/${current.id}/edit`).expect(200),
      await agent.post(`/notes/${current.id}`).type('form').send({
        _csrf: csrfToken, title: ' ', content: 'Rejected draft',
      }).expect(422),
    ];

    for (const response of pageResponses) {
      expect(previewSection(response.text)).toBe('');
      expect(response.text).toContain('Stored current body');
      expect(response.text).toContain('notes-detail-projects');
      expect(response.text).toContain('notes-detail-assets');
    }

    expect(settingsSpy).not.toHaveBeenCalled();
    expect(contentsSpy).toHaveBeenCalledTimes(3);
    expect(contentsSpy).toHaveBeenCalledWith(book.id);
    expect(app.locals.bookPagePreviewSettingsService.getBookPagePreviewSettings(book.id).selectedPageIds)
      .toContain(current.id);
  });

  it('renders both Book-host empty states with Book-appropriate wording', async () => {
    const book = app.locals.bookService.createBook({ title: 'Empty State Book' });

    const random = previewSection((await agent.get(`/notes/books/${book.id}`).expect(200)).text);
    expect(random).toContain('No Pages to preview.');
    expect(random).not.toContain('No other Pages');

    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5, selectedPageIds: [],
    });
    const selected = previewSection((await agent.get(`/notes/books/${book.id}`).expect(200)).text);
    expect(selected).toContain('No selected Pages are available.');
    expect(selected).not.toContain('No other selected Pages');
  });
});
