import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

// WP7.2: GET/POST /notes/projects/:projectId/order — the server contract the
// WP7.3 Reorder Notes dialog reads and saves through.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function insertProject(db, title) {
  return Number(db.prepare(
    `INSERT INTO projects (title, slug, description, notes, status, patreon_url, project_type)
     VALUES (?, ?, '', '', 'tbd', NULL, 'images')`,
  ).run(title, title.toLowerCase().replace(/\s+/g, '-')).lastInsertRowid);
}

function insertAsset(db, projectId, filename) {
  return db.prepare(`
    INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at)
    VALUES (?, ?, ?, 'png', 'image/png', 1, 1, datetime('now'))
    RETURNING id
  `).get(projectId, filename, filename).id;
}

describe('/notes/projects/:projectId/order', () => {
  let db;
  let app;
  let tmpDir;
  let agent;
  let csrfToken;
  let projectId;
  let otherProjectId;
  let chapter;
  let a;
  let b;
  let c;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-related-order-http-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));

    projectId = insertProject(db, 'Host Project');
    otherProjectId = insertProject(db, 'Other Project');
    const book = app.locals.bookService.createBook({ title: 'Lore Book' });
    chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Lore Chapter' });
    const assetId = insertAsset(db, projectId, 'a.png');
    const create = (title, input) => app.locals.noteService.createNote({ chapterId: chapter.id, title, ...input }).id;
    a = create('Alpha', { projectIds: [projectId, otherProjectId] });
    b = create('Beta', { assetIds: [assetId] });
    c = create('Gamma', { projectIds: [projectId], assetIds: [assetId] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const read = (id) => agent.get(`/notes/projects/${id}/order`).set('Accept', 'application/json');
  const save = (id, body) => agent.post(`/notes/projects/${id}/order`)
    .set('Accept', 'application/json').set('X-CSRF-Token', csrfToken).send(body);
  const rankCount = () => db.prepare('SELECT COUNT(*) AS n FROM project_related_note_order').get().n;
  const pageOrder = () => db.prepare('SELECT id, sort_order FROM notes ORDER BY id').all();
  const projectContext = (id, title) => ({ id, title, url: `/projects/${id}`, archived: false });

  it('reads the effective order and project context without writing', async () => {
    const response = await read(projectId).expect(200);
    expect(response.body).toEqual({
      status: 'success',
      project: projectContext(projectId, 'Host Project'),
      notes: [
        { id: a, title: 'Alpha', url: `/notes/${a}` },
        { id: b, title: 'Beta', url: `/notes/${b}` },
        { id: c, title: 'Gamma', url: `/notes/${c}` },
      ],
      expectedNoteIds: [a, b, c],
      saveUrl: `/notes/projects/${projectId}/order`,
    });
    expect(rankCount()).toBe(0);

    const empty = insertProject(db, 'Empty Project');
    expect((await read(empty).expect(200)).body).toMatchObject({ notes: [], expectedNoteIds: [] });
    expect((await read(otherProjectId).expect(200)).body.expectedNoteIds).toEqual([a]);
  });

  it('returns 404 for missing or malformed Projects', async () => {
    for (const id of ['999999', '0', 'abc', '01']) {
      const got = await read(id).expect(404);
      expect(got.body).toMatchObject({ status: 'error', code: 'PROJECT_NOT_FOUND' });
      const posted = await save(id, { expectedNoteIds: [], orderedNoteIds: [] }).expect(404);
      expect(posted.body).toMatchObject({ status: 'error', code: 'PROJECT_NOT_FOUND' });
    }
  });

  it('saves a permutation and returns the authoritative order, which Project Detail then uses', async () => {
    const before = pageOrder();
    const response = await save(projectId, { expectedNoteIds: [a, b, c], orderedNoteIds: [c, a, b] }).expect(200);
    expect(response.body).toMatchObject({
      status: 'success',
      changed: true,
      project: projectContext(projectId, 'Host Project'),
      expectedNoteIds: [c, a, b],
      saveUrl: `/notes/projects/${projectId}/order`,
    });
    expect(response.body.notes.map((n) => n.id)).toEqual([c, a, b]);
    expect((await read(projectId).expect(200)).body.expectedNoteIds).toEqual([c, a, b]);
    expect((await read(otherProjectId).expect(200)).body.expectedNoteIds).toEqual([a]);
    expect(pageOrder()).toEqual(before);

    const detail = await agent.get(`/projects/${projectId}`).expect(200);
    const positions = [c, a, b].map((id) => detail.text.indexOf(`id="project-related-note-${id}"`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  });

  it('accepts canonical digit strings in a form-encoded body with the _csrf field', async () => {
    const body = [
      `_csrf=${encodeURIComponent(csrfToken)}`,
      ...[a, b, c].map((id) => `expectedNoteIds[]=${id}`),
      ...[b, c, a].map((id) => `orderedNoteIds[]=${id}`),
    ].join('&');
    const response = await agent.post(`/notes/projects/${projectId}/order`)
      .set('Accept', 'application/json').type('form').send(body).expect(200);
    expect(response.body.expectedNoteIds).toEqual([b, c, a]);
  });

  it('refuses malformed input with 422 field errors and persists nothing', async () => {
    const cases = [
      [{ orderedNoteIds: [a, b, c] }, 'expectedNoteIds'],
      [{ expectedNoteIds: [a, b, c], orderedNoteIds: `${a}` }, 'orderedNoteIds'],
      [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, `0${c}`] }, 'orderedNoteIds'],
      [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, { id: c }] }, 'orderedNoteIds'],
      [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, [c]] }, 'orderedNoteIds'],
      [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, -1] }, 'orderedNoteIds'],
      [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, b] }, 'orderedNoteIds'],
      [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b] }, 'orderedNoteIds'],
      [{ expectedNoteIds: [a, b, c], orderedNoteIds: [a, b, c, 999999] }, 'orderedNoteIds'],
    ];
    for (const [body, field] of cases) {
      const response = await save(projectId, body).expect(422);
      expect(response.body).toMatchObject({ status: 'error', code: 'VALIDATION' });
      expect(response.body.errors).toHaveProperty(field);
    }
    expect(rankCount()).toBe(0);
  });

  it('returns 409 with the current order for a stale snapshot and keeps the saved order', async () => {
    const snapshot = (await read(projectId)).body.expectedNoteIds;
    await save(projectId, { expectedNoteIds: snapshot, orderedNoteIds: [b, c, a] }).expect(200);

    const stale = await save(projectId, { expectedNoteIds: snapshot, orderedNoteIds: [c, b, a] }).expect(409);
    expect(stale.body).toMatchObject({
      status: 'error',
      code: 'RELATED_NOTES_ORDER_STALE',
      project: projectContext(projectId, 'Host Project'),
      expectedNoteIds: [b, c, a],
    });
    expect(stale.body.message).toMatch(/changed/i);

    const d = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Delta', projectIds: [projectId] }).id;
    const grown = await save(projectId, { expectedNoteIds: [b, c, a], orderedNoteIds: [a, b, c] }).expect(409);
    expect(grown.body.expectedNoteIds).toEqual([b, c, a, d]);
    expect((await read(projectId)).body.expectedNoteIds).toEqual([b, c, a, d]);
  });

  it('requires the CSRF token', async () => {
    await agent.post(`/notes/projects/${projectId}/order`).set('Accept', 'application/json')
      .send({ expectedNoteIds: [a, b, c], orderedNoteIds: [c, b, a] }).expect(403);
    expect(rankCount()).toBe(0);
  });

  it('allows reordering an archived Project', async () => {
    db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(projectId);
    const response = await save(projectId, { expectedNoteIds: [a, b, c], orderedNoteIds: [c, b, a] }).expect(200);
    expect(response.body.project).toMatchObject({ id: projectId, archived: true });
    expect(response.body.expectedNoteIds).toEqual([c, b, a]);
  });

  it('reports an unexpected failure as 500 without saving anything', async () => {
    vi.spyOn(app.locals.noteService, 'reorderRelatedNotesForProject').mockImplementation(() => {
      throw new Error('SQLITE_IOERR');
    });
    const response = await save(projectId, { expectedNoteIds: [a, b, c], orderedNoteIds: [c, b, a] }).expect(500);
    expect(response.body).toMatchObject({ status: 'error', code: 'RELATED_NOTES_ORDER_FAILED' });
    expect(JSON.stringify(response.body)).not.toMatch(/SQLITE/);
    expect(rankCount()).toBe(0);
  });

  it('leaves the existing Project Create Page and Create dialog routes working', async () => {
    const created = await agent.post(`/notes/projects/${projectId}`).set('Accept', 'application/json').type('form')
      .send({ _csrf: csrfToken, title: 'Epsilon', targetContainer: `chapter:${chapter.id}` }).expect(201);
    expect((await read(projectId)).body.expectedNoteIds).toEqual([a, b, c, created.body.page.id]);
    await agent.get(`/notes/projects/${projectId}/new`).expect(200);
  });
});
