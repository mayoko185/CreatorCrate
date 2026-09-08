import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { BookHierarchyValidationError } from '../src/services/book-hierarchy.js';
import { canChangeBookOrder } from '../src/routes/notes.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function decodeAttribute(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function orderDialog(html) {
  return html.match(/<dialog\b[^>]*id="book-order-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
}

function hierarchySubmission(html) {
  const dialog = orderDialog(html);
  const values = [...dialog.matchAll(/<input\b[^>]*name="hierarchy"[^>]*value="([^"]*)"[^>]*>/g)];
  expect(values).toHaveLength(1);
  return JSON.parse(decodeAttribute(values[0][1]));
}

describe('Book hierarchy HTTP integration', () => {
  let db;
  let app;
  let tmpDir;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-hierarchy-http-'));
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

  function createHierarchy(title = 'Hierarchy Book') {
    const book = app.locals.bookService.createBook({ title });
    const rootA = app.locals.noteService.createNote({ bookId: book.id, title: 'Root Page A', content: '' });
    const chapterA = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter A' });
    const pageA1 = app.locals.noteService.createNote({ chapterId: chapterA.id, title: 'Chapter A Page 1', content: '' });
    const pageA2 = app.locals.noteService.createNote({ chapterId: chapterA.id, title: 'Chapter A Page 2', content: '' });
    const rootB = app.locals.noteService.createNote({ bookId: book.id, title: 'Root Page B', content: '' });
    const chapterB = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter B' });
    const pageB1 = app.locals.noteService.createNote({ chapterId: chapterB.id, title: 'Chapter B Page 1', content: '' });
    return { book, rootA, rootB, chapterA, chapterB, pageA1, pageA2, pageB1 };
  }

  async function loadSubmission(bookId) {
    return hierarchySubmission((await agent.get(`/notes/books/${bookId}/order`).expect(200)).text);
  }

  function save(bookId, submission, status = 302) {
    return agent.post(`/notes/books/${bookId}/hierarchy/reorder`).type('form')
      .send({ _csrf: csrfToken, hierarchy: JSON.stringify(submission) }).expect(status);
  }

  it('applies the complete Change order eligibility matrix', () => {
    const page = { type: 'page', pages: [] };
    const emptyChapter = { type: 'chapter', pages: [] };
    const populatedChapter = { type: 'chapter', pages: [{ id: 1 }] };
    expect(canChangeBookOrder([])).toBe(false);
    expect(canChangeBookOrder([page])).toBe(false);
    expect(canChangeBookOrder([emptyChapter])).toBe(false);
    expect(canChangeBookOrder([populatedChapter])).toBe(true);
    expect(canChangeBookOrder([page, emptyChapter])).toBe(true);
  });

  it('persists each aggregate move shape and reloads the canonical Book hierarchy', async () => {
    const cases = [
      ['root-only reorder', ({ rootA, rootB, chapterA, chapterB, pageA1, pageA2, pageB1 }) => [
        { type: 'chapter', id: chapterA.id, pages: [pageA1.id, pageA2.id] },
        { type: 'page', id: rootB.id }, { type: 'page', id: rootA.id },
        { type: 'chapter', id: chapterB.id, pages: [pageB1.id] },
      ]],
      ['root to Chapter', ({ rootA, rootB, chapterA, chapterB, pageA1, pageA2, pageB1 }) => [
        { type: 'chapter', id: chapterA.id, pages: [pageA1.id, rootA.id, pageA2.id] },
        { type: 'page', id: rootB.id },
        { type: 'chapter', id: chapterB.id, pages: [pageB1.id] },
      ]],
      ['Chapter to root', ({ rootA, rootB, chapterA, chapterB, pageA1, pageA2, pageB1 }) => [
        { type: 'page', id: rootA.id },
        { type: 'chapter', id: chapterA.id, pages: [pageA2.id] },
        { type: 'page', id: pageA1.id }, { type: 'page', id: rootB.id },
        { type: 'chapter', id: chapterB.id, pages: [pageB1.id] },
      ]],
      ['Chapter A to Chapter B', ({ rootA, rootB, chapterA, chapterB, pageA1, pageA2, pageB1 }) => [
        { type: 'page', id: rootA.id },
        { type: 'chapter', id: chapterA.id, pages: [pageA2.id] },
        { type: 'page', id: rootB.id },
        { type: 'chapter', id: chapterB.id, pages: [pageB1.id, pageA1.id] },
      ]],
      ['combined move and reorder', ({ rootA, rootB, chapterA, chapterB, pageA1, pageA2, pageB1 }) => [
        { type: 'chapter', id: chapterB.id, pages: [rootB.id, pageA1.id] },
        { type: 'page', id: pageB1.id },
        { type: 'chapter', id: chapterA.id, pages: [rootA.id] },
        { type: 'page', id: pageA2.id },
      ]],
    ];

    for (const [label, targetFor] of cases) {
      const fixture = createHierarchy(label);
      const initial = await loadSubmission(fixture.book.id);
      const target = targetFor(fixture);
      await save(fixture.book.id, { ...initial, target }).expect('Location', `/notes/books/${fixture.book.id}`);
      expect(app.locals.noteService.getBookHierarchy(fixture.book.id), label).toEqual(target);
      const reloaded = await loadSubmission(fixture.book.id);
      expect(reloaded, label).toEqual({ version: 1, expected: target, target });
    }
  });

  it('accepts an unchanged hierarchy as a successful no-op', async () => {
    const fixture = createHierarchy('No-op Book');
    const emptyChapter = app.locals.chapterService.createChapter({
      bookId: fixture.book.id,
      title: 'Empty Chapter',
    });
    const response = await agent.get(`/notes/books/${fixture.book.id}/order`).expect(200);
    const dialog = orderDialog(response.text);
    const emptyChapterList = dialog.match(new RegExp(
      `<ol\\b[^>]*data-book-hierarchy-container="chapter:${emptyChapter.id}"[^>]*>[\\s\\S]*?<\\/ol>`,
    ))?.[0] || '';
    expect(dialog).toContain(`data-content-key="chapter:${emptyChapter.id}"`);
    expect(dialog).toContain(`<a href="/notes/chapters/${emptyChapter.id}">Empty Chapter</a>`);
    expect(emptyChapterList).not.toBe('');
    expect(emptyChapterList.match(/data-book-hierarchy-item/g) || []).toHaveLength(0);

    const submission = hierarchySubmission(response.text);
    const renderedHierarchy = [
      { type: 'page', id: fixture.rootA.id },
      { type: 'chapter', id: fixture.chapterA.id, pages: [fixture.pageA1.id, fixture.pageA2.id] },
      { type: 'page', id: fixture.rootB.id },
      { type: 'chapter', id: fixture.chapterB.id, pages: [fixture.pageB1.id] },
      { type: 'chapter', id: emptyChapter.id, pages: [] },
    ];
    expect(submission).toEqual({
      version: 1,
      expected: renderedHierarchy,
      target: renderedHierarchy,
    });
    const before = db.prepare('SELECT total_changes() AS count').get().count;
    await save(fixture.book.id, submission).expect('Location', `/notes/books/${fixture.book.id}`);
    expect(db.prepare('SELECT total_changes() AS count').get().count).toBe(before);
    expect(app.locals.noteService.getBookHierarchy(fixture.book.id)).toEqual(renderedHierarchy);
  });

  it('rejects missing, repeated, malformed, and unsupported hierarchy transport values', async () => {
    const { book } = createHierarchy('Strict Transport Book');
    const submission = await loadSubmission(book.id);
    const url = `/notes/books/${book.id}/hierarchy/reorder`;
    const requests = [
      { _csrf: csrfToken },
      { _csrf: csrfToken, hierarchy: [JSON.stringify(submission), JSON.stringify(submission)] },
      { _csrf: csrfToken, hierarchy: '{not json' },
      { _csrf: csrfToken, hierarchy: JSON.stringify({ ...submission, version: 2 }) },
    ];
    for (const body of requests) {
      const response = await agent.post(url).type('form').send(body).expect(422);
      expect(response.text).toContain('The submitted Book hierarchy is invalid. Nothing was saved.');
      expect(hierarchySubmission(response.text)).toEqual(submission);
    }
  });

  it('refreshes stale submissions without persisting the stale target', async () => {
    const fixture = createHierarchy('Stale Book');
    const stale = await loadSubmission(fixture.book.id);
    stale.target = [...stale.target].reverse();
    const added = app.locals.noteService.createNote({ bookId: fixture.book.id, title: 'Concurrent Page', content: '' });

    const response = await save(fixture.book.id, stale, 409);
    expect(response.text).toContain('Nothing was saved because the Book hierarchy changed. The current hierarchy has been refreshed.');
    const refreshed = hierarchySubmission(response.text);
    expect(refreshed.expected).toEqual(refreshed.target);
    expect(refreshed.target.at(-1)).toEqual({ type: 'page', id: added.id });
    expect(app.locals.noteService.getBookHierarchy(fixture.book.id)).toEqual(refreshed.target);
  });

  it('preserves a safe valid draft with authoritative labels on a 422 rerender', async () => {
    const fixture = createHierarchy('Trusted Book');
    app.locals.noteService.updateNote(fixture.rootA.id, { title: '<Trusted Page>', content: '' });
    const submission = await loadSubmission(fixture.book.id);
    submission.target = [...submission.target].reverse();
    vi.spyOn(app.locals.noteService, 'reorderBookHierarchy').mockImplementationOnce(() => {
      throw new BookHierarchyValidationError('Rejected for a non-stale validation reason.');
    });

    const response = await save(fixture.book.id, submission, 422);
    const dialog = orderDialog(response.text);
    expect(dialog).toContain('The submitted Book hierarchy is invalid. Nothing was saved.');
    expect(dialog).toContain('&lt;Trusted Page&gt;');
    expect(dialog).not.toContain('<Trusted Page>');
    expect(hierarchySubmission(response.text)).toEqual({
      version: 1,
      expected: submission.expected,
      target: submission.target,
    });
    expect(dialog.match(/name="hierarchy"/g)).toHaveLength(1);
    expect(dialog).toContain(`action="/notes/books/${fixture.book.id}/hierarchy/reorder"`);
    expect(dialog).toMatch(/name="_csrf"[^>]+value="[^"]+"/);
  });

  it('fails safely when the authoritative current hierarchy is corrupt', async () => {
    const fixture = createHierarchy('Corrupt Hierarchy Book');
    const submission = await loadSubmission(fixture.book.id);
    db.prepare(`
      DELETE FROM book_contents
      WHERE book_id = ? AND item_type = 'page' AND item_id = ?
    `).run(fixture.book.id, fixture.rootA.id);

    const response = await save(fixture.book.id, submission, 500);
    expect(response.text).toContain('<p class="error-status">500</p>');
    expect(response.text).not.toContain('data-book-hierarchy-form');
  });
});
