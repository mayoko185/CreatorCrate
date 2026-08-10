import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function insertProject(db, title) {
  return Number(db
    .prepare(
      `INSERT INTO projects (title, slug, description, notes, status, planned_date, published_date, patreon_url)
       VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)`
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

  it('GET /notes renders the page shell, active navigation, and empty-state action', async () => {
    const response = await agent.get('/notes').expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Notes</h1>');
    expect(response.text).toContain('<header class="page-heading">');
    expect(response.text).toContain('<a class="button button-primary" href="/notes/new">New Note</a>');
    expect(response.text).toContain('<h2 class="empty-state-heading">No notes yet</h2>');
    expect(response.text).toContain('Create your first note to keep ideas and working context in one place.');
    expect(response.text).toContain(
      '<a href="/notes" class="app-nav-link" data-nav-key="notes" aria-current="page">',
    );
    expect(response.text).not.toContain('class="notes-table"');
    expect(response.text).not.toContain('data-note-reorder-list');
    expect(response.text).not.toContain('data-note-reorder-handle');
    expect(response.text).not.toContain('data-notes-editor-form');
    expect(response.text).not.toContain('/vendor/toast-ui/editor/');
  });

  it('GET /notes/new renders the shared form contract and one CSRF field', async () => {
    const response = await agent.get('/notes/new').expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes — Create Note</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Notes — Create Note</h1>');
    expect(response.text).toContain('<header class="page-heading">');
    expect(response.text).toContain('<button class="button button-primary" type="submit" form="note-form">Create</button>');
    expect(response.text).toContain('<a class="button button-secondary" href="/notes">Cancel</a>');
    expect(response.text).toContain('<form id="note-form" method="post" action="/notes"');
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('data-notes-editor-host');
    expect(response.text).toContain('<textarea id="content" name="content" data-notes-editor-source');
    expect(response.text).not.toContain('/vendor/toast-ui/editor/');
    expect(response.text).toMatch(/<input[^>]+type="hidden"[^>]+name="_csrf"[^>]+value="[^"]+"/);
    expect(response.text).toContain('<label for="title">Title');
    expect(response.text).toContain('<input type="text" id="title" name="title"');
    expect(response.text).toContain('<label id="content-label" for="content">Content</label>');
    expect(response.text).toContain('<textarea id="content" name="content"');
    expect(response.text).toContain('<legend>Projects</legend>');
    expect(response.text).toContain('No projects available.');
    expect(response.text).toContain('<legend>Assets</legend>');
    expect(response.text).toContain('name="assetIds[]"');
    expect(response.text).toContain('No assets available.');
  });

  it('GET /notes/new renders accessible project options', async () => {
    const firstProjectId = insertProject(db, 'Alpha Project');
    const secondProjectId = insertProject(db, 'Beta Project');

    const response = await agent.get('/notes/new').expect(200);

    expect(response.text).toContain(`<label for="note-project-option-${firstProjectId}">`);
    expect(response.text).toContain(`<input id="note-project-option-${firstProjectId}" name="projectIds[]" type="checkbox" value="${firstProjectId}"`);
    expect(response.text).toContain('>Alpha Project</span>');
    expect(response.text).toContain(`<label for="note-project-option-${secondProjectId}">`);
    expect(response.text).toContain('>Beta Project</span>');
    expect(response.text).not.toMatch(/name="projectIds\[\]"[^>]*checked/);
  });

  it('does not expose the obsolete TOAST UI vendor mount', async () => {
    await agent.get('/vendor/toast-ui/editor/toastui-editor.css').expect(404);
  });

  it('GET /notes/new renders all asset options grouped by project with useful context', async () => {
    const firstProjectId = insertProject(db, 'Alpha Assets');
    const secondProjectId = insertProject(db, 'Beta Assets');
    const firstSharedId = insertAsset(db, firstProjectId, 'shared.txt', {
      relativePath: 'docs/shared.txt',
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const secondSharedId = insertAsset(db, firstProjectId, 'shared.txt', {
      relativePath: 'archive/shared.txt',
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const missingId = insertAsset(db, secondProjectId, 'missing.bin', {
      extension: 'bin',
      mimeType: 'application/octet-stream',
    });
    markAssetMissing(db, missingId);

    const response = await agent.get('/notes/new').expect(200);

    expect(response.text).toContain(`<summary id="note-assets-project-${firstProjectId}-trigger"`);
    expect(response.text).toContain('Alpha Assets (2 assets)');
    expect(response.text).toContain('Beta Assets (1 assets)');
    expect(response.text).toContain(
      `<input id="note-asset-option-${firstSharedId}" name="assetIds[]" type="checkbox" value="${firstSharedId}"`,
    );
    expect(response.text).toContain(
      `<input id="note-asset-option-${secondSharedId}" name="assetIds[]" type="checkbox" value="${secondSharedId}"`,
    );
    expect(response.text).toContain('docs/shared.txt');
    expect(response.text).toContain('archive/shared.txt');
    expect(response.text).toContain('>missing.bin</span>');
    expect(response.text).toContain('>Missing</span>');
    expect(response.text).not.toMatch(/name="assetIds\[\]"[^>]*checked/);
  });

  it('POST /notes creates a note, redirects to detail, and stores Markdown source unchanged', async () => {
    const content = '# Heading\n\n**bold** & <tag>\n- item';

    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Canonical Note', content })
      .expect(302);

    expect(response.headers.location).toMatch(/^\/notes\/\d+$/);
    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId)).toMatchObject({
      title: 'Canonical Note',
      content,
      projectIds: [],
      assetIds: [],
    });
  });

  it('POST /notes normalizes one project checkbox scalar', async () => {
    const projectId = insertProject(db, 'Single Project');

    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Single project note', content: '', projectIds: String(projectId) })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId).projectIds).toEqual([projectId]);
  });

  it('POST /notes creates a note with multiple projects', async () => {
    const firstProjectId = insertProject(db, 'First Project');
    const secondProjectId = insertProject(db, 'Second Project');

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        title: 'Multiple project note',
        content: '',
        projectIds: [String(firstProjectId), String(secondProjectId)],
      })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId).projectIds).toEqual([firstProjectId, secondProjectId]);
  });

  it('POST /notes normalizes one asset checkbox scalar without implicitly associating its project', async () => {
    const projectId = insertProject(db, 'Asset Parent');
    const assetId = insertAsset(db, projectId, 'scalar-asset.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });

    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Scalar asset note', content: '', assetIds: String(assetId) })
      .expect(302);

    const noteId = Number(response.headers.location.replace('/notes/', ''));
    expect(app.locals.noteService.getNote(noteId)).toMatchObject({
      projectIds: [],
      assetIds: [assetId],
    });
  });

  it('POST /notes creates multiple assets from multiple projects independently of project selections', async () => {
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
    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Missing asset note', content: 'body', assetIds: '999999' })
      .expect(422);

    expect(response.text).toContain('Asset 999999 not found.');
    expect(response.text).not.toContain('SQLITE');
    expect(response.text).not.toContain('FOREIGN KEY');
    expect(app.locals.noteService.listNotes()).toHaveLength(0);
  });

  it('POST /notes preserves attempted project and asset selections and complete option data after validation failure', async () => {
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

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        title: '',
        content: 'Attempted asset content',
        projectIds: String(secondProjectId),
        assetIds: [String(firstAssetId), String(secondAssetId)],
      })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('Attempted asset content');
    expect(response.text).toMatch(new RegExp(`id="note-project-option-${secondProjectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${firstAssetId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${secondAssetId}"[^>]*checked`));
    expect(response.text).toContain('>Validation Asset First</span>');
    expect(response.text).toContain('>Validation Asset Second</span>');
    expect(response.text).toContain('first-validation.txt');
    expect(response.text).toContain('second-validation.txt');
  });

  it('POST /notes deduplicates duplicate submitted project IDs', async () => {
    const projectId = insertProject(db, 'Duplicate Project');

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
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
    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Missing project note', content: 'body', projectIds: '999999' })
      .expect(422);

    expect(response.text).toContain('Project 999999 not found.');
    expect(response.text).not.toContain('SQLITE');
    expect(response.text).not.toContain('FOREIGN KEY');
    expect(app.locals.noteService.listNotes()).toHaveLength(0);
  });

  it('POST /notes preserves attempted project selections and the full option list after validation failure', async () => {
    const firstProjectId = insertProject(db, 'Validation First');
    const secondProjectId = insertProject(db, 'Validation Second');

    const response = await agent
      .post('/notes')
      .type('form')
      .send({
        _csrf: csrfToken,
        title: '',
        content: 'Attempted project content',
        projectIds: [String(firstProjectId), String(secondProjectId)],
      })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('Attempted project content');
    expect(response.text).toMatch(new RegExp(`id="note-project-option-${firstProjectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-project-option-${secondProjectId}"[^>]*checked`));
    expect(response.text).toContain('>Validation First</span>');
    expect(response.text).toContain('>Validation Second</span>');
  });

  it('POST /notes rerenders validation errors with submitted values', async () => {
    const attemptedContent = 'Attempted **Markdown**\nsecond line';

    const response = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, title: '', content: attemptedContent })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('field-error-message');
    expect(response.text).toContain('aria-describedby="title-error"');
    expect(response.text).toContain(attemptedContent);
    expect(app.locals.noteService.listNotes()).toHaveLength(0);
  });

  it('renders every note in the service canonical order with plain escaped excerpts', async () => {
    const first = app.locals.noteService.createNote({
      title: 'First Note',
      content: 'First body',
    });
    const second = app.locals.noteService.createNote({
      title: 'Second Note',
      content: '<script>alert("unsafe")</script>\n\n# Markdown **text**',
    });
    app.locals.noteService.reorderNotes([second.id, first.id]);

    const response = await agent.get('/notes').expect(200);
    const table = response.text.match(/<table class="data-table notes-table">[\s\S]*?<\/table>/)?.[0];

    expect(table).toBeDefined();
    expect(table.indexOf('Second Note')).toBeLessThan(table.indexOf('First Note'));
    expect(table).toContain(`<a class="notes-title-link" href="/notes/${second.id}">Second Note</a>`);
    expect(table).toContain(`<a class="notes-title-link" href="/notes/${first.id}">First Note</a>`);
    expect(table).toContain(second.updated_at);
    expect(table).toContain('&lt;script&gt;alert(');
    expect(table).toContain('# Markdown **text**');
    expect(table).not.toContain('<script>');
    expect(table).not.toContain('<strong>text</strong>');
  });

  it('does not split surrogate pairs in truncated excerpts', async () => {
    const emoji = '\u{1F600}';
    const content = `${emoji}${'a'.repeat(156)}${emoji} trailing text`;
    const note = app.locals.noteService.createNote({ title: 'Unicode Note', content });

    const response = await agent.get('/notes').expect(200);
    const excerpt = response.text.match(/<td class="notes-excerpt">([\s\S]*?)<\/td>/)?.[1];

    expect(excerpt).toBe(`${emoji}${'a'.repeat(156)}…`);
    expect(excerpt).toContain(emoji);
    expect(excerpt).not.toContain('\uFFFD');
    expect(excerpt).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(excerpt).toMatch(/…$/);
    expect(response.text).toContain(`<a class="notes-title-link" href="/notes/${note.id}">Unicode Note</a>`);
  });

  it('renders Notes reorder hooks only for multiple notes while preserving detail links', async () => {
    const notes = [
      app.locals.noteService.createNote({ title: 'First Note', content: 'First body' }),
      app.locals.noteService.createNote({ title: 'Second Note', content: 'Second body' }),
      app.locals.noteService.createNote({ title: 'Third Note', content: 'Third body' }),
    ];

    const response = await agent.get('/notes').expect(200);
    const rows = response.text.match(/<tr\b[^>]*data-note-reorder-item[^>]*>[\s\S]*?<\/tr>/g) || [];

    expect(response.text).toContain('<form id="notes-reorder-form"');
    expect(response.text).toContain('action="/notes/reorder"');
    expect(response.text).toContain('name="orderedNoteIds"');
    expect(response.text).toContain('data-note-reorder-list');
    expect(response.text).toContain('data-note-reorder-live');
    expect(rows).toHaveLength(notes.length);
    expect(rows.map((row) => row.match(/data-note-id="(\d+)"/)?.[1]))
      .toEqual(notes.map((note) => String(note.id)));

    for (const [index, row] of rows.entries()) {
      const note = notes[index];
      expect(row).toContain('data-note-reorder-handle');
      expect(row).toContain('draggable="true"');
      expect(row).toContain(`aria-label="Reorder ${note.title}"`);
      expect(row).toContain(`aria-posinset="${index + 1}"`);
      expect(row).toContain(`aria-setsize="${notes.length}"`);
      expect(row).toContain(`<a class="notes-title-link" href="/notes/${note.id}">${note.title}</a>`);
    }
  });

  it('POST /notes/reorder is static, CSRF-protected, persists the full order, and renders it on the next GET', async () => {
    const notes = [
      app.locals.noteService.createNote({ title: 'First Note', content: 'First body' }),
      app.locals.noteService.createNote({ title: 'Second Note', content: 'Second body' }),
      app.locals.noteService.createNote({ title: 'Third Note', content: 'Third body' }),
    ];
    const orderedIds = [notes[2].id, notes[0].id, notes[1].id];

    await agent
      .post('/notes/reorder')
      .type('form')
      .send({ orderedNoteIds: orderedIds.join(',') })
      .expect(403);
    expect(app.locals.noteService.listNotes().map((note) => note.id))
      .toEqual(notes.map((note) => note.id));

    const response = await agent
      .post('/notes/reorder')
      .type('form')
      .send({ _csrf: csrfToken, orderedNoteIds: orderedIds.join(',') })
      .expect(302);

    expect(response.headers.location).toBe('/notes?notice=note_reordered');
    expect(app.locals.noteService.listNotes().map((note) => note.id)).toEqual(orderedIds);
    expect(app.locals.noteService.listNotes().map((note) => note.sort_order)).toEqual([0, 1, 2]);

    const noticePage = await agent.get(response.headers.location).expect(200);
    expect(noticePage.text).toContain('Note order updated.');

    const page = await agent.get('/notes').expect(200);
    const table = page.text.match(/<table class="data-table notes-table">[\s\S]*?<\/table>/)?.[0] || '';
    const positions = orderedIds.map((id) => table.indexOf(`/notes/${id}`));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('rejects missing, duplicate, and unknown reorder IDs without changing the previous order', async () => {
    const notes = [
      app.locals.noteService.createNote({ title: 'First Note' }),
      app.locals.noteService.createNote({ title: 'Second Note' }),
      app.locals.noteService.createNote({ title: 'Third Note' }),
    ];
    const validOrder = [notes[1].id, notes[2].id, notes[0].id];
    app.locals.noteService.reorderNotes(validOrder);
    const before = app.locals.noteService.listNotes().map((note) => ({
      id: note.id,
      sort_order: note.sort_order,
      title: note.title,
      content: note.content,
    }));

    const payloads = [
      {},
      { orderedNoteIds: `${validOrder[0]},${validOrder[0]},${validOrder[2]}` },
      { orderedNoteIds: `${validOrder[0]},${validOrder[1]},999999` },
    ];

    for (const payload of payloads) {
      const response = await agent
        .post('/notes/reorder')
        .type('form')
        .send({ _csrf: csrfToken, ...payload })
        .expect(422);

      expect(response.text).toContain('submitted note order is invalid');
      expect(response.text).not.toContain('999999');
      expect(app.locals.noteService.listNotes().map((note) => ({
        id: note.id,
        sort_order: note.sort_order,
        title: note.title,
        content: note.content,
      }))).toEqual(before);
    }
  });

  it('supports empty and one-note reorder requests without rendering meaningless controls', async () => {
    await agent
      .post('/notes/reorder')
      .type('form')
      .send({ _csrf: csrfToken, orderedNoteIds: '' })
      .expect(302);

    const emptyPage = await agent.get('/notes').expect(200);
    expect(emptyPage.text).toContain('<h2 class="empty-state-heading">No notes yet</h2>');
    expect(emptyPage.text).not.toContain('data-note-reorder-list');
    expect(emptyPage.text).not.toContain('data-note-reorder-handle');

    const note = app.locals.noteService.createNote({ title: 'Only Note', content: 'Body' });
    await agent
      .post('/notes/reorder')
      .type('form')
      .send({ _csrf: csrfToken, orderedNoteIds: String(note.id) })
      .expect(302);

    const onePage = await agent.get('/notes').expect(200);
    expect(onePage.text).toContain(`<a class="notes-title-link" href="/notes/${note.id}">Only Note</a>`);
    expect(onePage.text).not.toContain('data-note-reorder-list');
    expect(onePage.text).not.toContain('data-note-reorder-handle');
    expect(onePage.text).not.toContain('>Order</th>');
  });

  it('does not change associations, appends after a reorder, and keeps remaining order after deletion', async () => {
    const projectId = insertProject(db, 'Ordering Association Project');
    const assetId = insertAsset(db, projectId, 'ordering-note-asset.png');
    const first = app.locals.noteService.createNote({
      title: 'First Note',
      content: 'First content',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const second = app.locals.noteService.createNote({
      title: 'Second Note',
      content: 'Second content',
      projectIds: [projectId],
    });
    const associationsBefore = {
      projects: db.prepare('SELECT note_id, project_id FROM note_projects ORDER BY note_id, project_id').all(),
      assets: db.prepare('SELECT note_id, asset_id FROM note_assets ORDER BY note_id, asset_id').all(),
    };
    const noteFieldsBefore = db.prepare(
      'SELECT id, title, content, created_at, updated_at FROM notes ORDER BY id'
    ).all();

    await agent
      .post('/notes/reorder')
      .type('form')
      .send({ _csrf: csrfToken, orderedNoteIds: `${second.id},${first.id}` })
      .expect(302);

    expect(db.prepare('SELECT note_id, project_id FROM note_projects ORDER BY note_id, project_id').all())
      .toEqual(associationsBefore.projects);
    expect(db.prepare('SELECT note_id, asset_id FROM note_assets ORDER BY note_id, asset_id').all())
      .toEqual(associationsBefore.assets);
    expect(db.prepare('SELECT id, title, content, created_at, updated_at FROM notes ORDER BY id').all())
      .toEqual(noteFieldsBefore);
    expect(app.locals.noteService.getNote(first.id)).toMatchObject({
      title: 'First Note',
      content: 'First content',
      projectIds: [projectId],
      assetIds: [assetId],
    });

    const appendResponse = await agent
      .post('/notes')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Appended Note', content: 'Appended content' })
      .expect(302);
    const appendedId = Number(appendResponse.headers.location.replace('/notes/', ''));
    const appended = app.locals.noteService.getNote(appendedId);
    expect(app.locals.noteService.listNotes().map((note) => note.id))
      .toEqual([second.id, first.id, appended.id]);
    expect(app.locals.noteService.listNotes().map((note) => note.sort_order)).toEqual([0, 1, 2]);

    await agent
      .post(`/notes/${second.id}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(app.locals.noteService.listNotes().map((note) => note.id))
      .toEqual([first.id, appended.id]);
    expect(app.locals.noteService.getNote(first.id).projectIds).toEqual([projectId]);
    expect(app.locals.noteService.getNote(first.id).assetIds).toEqual([assetId]);
  });

  it('renders sanitized Markdown detail content with edit and delete affordances', async () => {
    const content = '<script>alert("unsafe")</script>\n\n# Markdown **text**\nline two';
    const note = app.locals.noteService.createNote({ title: 'Detail Note', content });

    const response = await agent.get(`/notes/${note.id}`).expect(200);

    expect(response.text).toContain('<title>CreatorCrate — Notes — Detail Note</title>');
    expect(response.text).toContain('<h1 class="app-section-title">Notes — Detail Note</h1>');
    expect(response.text).toContain(`<a class="button" href="/notes/${note.id}/edit">Edit</a>`);
    expect(response.text).toContain('<a class="button button-secondary" href="/notes">Back to Notes</a>');
    expect(response.text).toContain(`<form method="post" action="/notes/${note.id}/delete" class="inline-form">`);
    expect(response.text).toContain('>Delete Note</button>');
    expect(response.text).toContain('&lt;script&gt;alert(');
    expect(response.text).not.toContain('<script>alert');
    expect(response.text).toContain('<h1>Markdown <strong>text</strong></h1>');
    expect(response.text).toContain('<p>line two</p>');
    expect(response.text).toContain('<dt>Created</dt>');
    expect(response.text).toContain('<dt>Updated</dt>');
    expect(response.text).not.toContain('<h2>Projects</h2>');
    expect(response.text).not.toContain('<h2>Assets</h2>');
    expect(response.text).not.toContain('data-notes-editor-form');
    expect(response.text).not.toContain('/vendor/toast-ui/editor/');

    const css = await agent.get('/creatorcrate.css').expect(200);
    expect(css.text).toContain('.notes-content');
    expect(css.text).toContain('.notes-content pre');
    expect(css.text).toContain('.notes-content table');
  });

  it('GET /notes/:id returns 404 for a nonexistent note', async () => {
    await agent.get('/notes/9999').expect(404);
  });

  it('GET /notes/:id/edit populates the shared form with existing values', async () => {
    const content = '# Existing\n**bold** & <script>alert("unsafe")</script>';
    const note = app.locals.noteService.createNote({
      title: 'Existing Note',
      content,
    });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);

    expect(response.text).toContain(`<title>CreatorCrate — Notes — Edit Existing Note</title>`);
    expect(response.text).toContain(`<form id="note-form" method="post" action="/notes/${note.id}"`);
    expect(response.text).toContain('data-notes-editor-form');
    expect(response.text).toContain('data-notes-editor-host');
    expect(response.text).toContain('<textarea id="content" name="content" data-notes-editor-source');
    expect(response.text).toContain('value="Existing Note"');
    expect(response.text).toContain('# Existing\n**bold** &amp; &lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;');
    expect(response.text).not.toContain('<strong>bold</strong>');
    expect(app.locals.noteService.getNote(note.id).content).toBe(content);
    expect(response.text).toContain('<legend>Projects</legend>');
    expect(response.text).toContain('<legend>Assets</legend>');
  });

  it('GET /notes/:id/edit preselects existing project associations', async () => {
    const firstProjectId = insertProject(db, 'Existing First');
    const secondProjectId = insertProject(db, 'Existing Second');
    const note = app.locals.noteService.createNote({
      title: 'Associated Note',
      content: 'content',
      projectIds: [firstProjectId, secondProjectId],
    });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);

    expect(response.text).toMatch(new RegExp(`id="note-project-option-${firstProjectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-project-option-${secondProjectId}"[^>]*checked`));
  });

  it('GET /notes/:id/edit preselects existing asset associations', async () => {
    const firstProjectId = insertProject(db, 'Edit Asset First Project');
    const secondProjectId = insertProject(db, 'Edit Asset Second Project');
    const firstAssetId = insertAsset(db, firstProjectId, 'edit-first.txt', {
      extension: 'txt',
      mimeType: 'text/plain',
    });
    const secondAssetId = insertAsset(db, secondProjectId, 'edit-second.bin', {
      extension: 'bin',
      mimeType: 'application/octet-stream',
    });
    const note = app.locals.noteService.createNote({
      title: 'Asset Edit Note',
      assetIds: [firstAssetId, secondAssetId],
    });

    const response = await agent.get(`/notes/${note.id}/edit`).expect(200);

    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${firstAssetId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${secondAssetId}"[^>]*checked`));
    expect(response.text).not.toMatch(/name="projectIds\[\]"[^>]*checked/);
  });

  it('POST /notes/:id updates title/content and project associations without clearing assets', async () => {
    const projectId = insertProject(db, 'Associated Project');
    const assetId = insertAsset(db, projectId);
    const note = app.locals.noteService.createNote({ title: 'Before', content: 'Before content' });
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
      })
      .expect(302);

    expect(response.headers.location).toBe(`/notes/${note.id}`);
    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      title: 'After',
      content: 'After content\nline two',
      projectIds: [projectId],
      assetIds: [assetId],
    });
  });

  it('POST /notes/:id adds and removes project associations', async () => {
    const firstProjectId = insertProject(db, 'Removed Project');
    const secondProjectId = insertProject(db, 'Added Project');
    const note = app.locals.noteService.createNote({ title: 'Before', projectIds: [firstProjectId] });

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
    const note = app.locals.noteService.createNote({
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
    const note = app.locals.noteService.createNote({ title: 'Independent asset', assetIds: [assetId] });

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
    const note = app.locals.noteService.createNote({
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
    const note = app.locals.noteService.createNote({ title: 'Clear projects', projectIds: [projectId] });

    await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: 'Clear projects', content: '' })
      .expect(302);

    expect(app.locals.noteService.getNote(note.id).projectIds).toEqual([]);
  });

  it('POST /notes/:id rerenders validation errors with attempted edit values', async () => {
    const note = app.locals.noteService.createNote({ title: 'Existing', content: 'Stored content' });
    const attemptedContent = 'Attempted edit\nsecond line';

    const response = await agent
      .post(`/notes/${note.id}`)
      .type('form')
      .send({ _csrf: csrfToken, title: '', content: attemptedContent })
      .expect(422);

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain(`<form id="note-form" method="post" action="/notes/${note.id}"`);
    expect(response.text).toContain(attemptedContent);
    expect(app.locals.noteService.getNote(note.id)).toMatchObject({
      title: 'Existing',
      content: 'Stored content',
    });
  });

  it('POST /notes/:id validation failure preserves attempted project selections', async () => {
    const firstProjectId = insertProject(db, 'Stored Project');
    const secondProjectId = insertProject(db, 'Attempted Project');
    const note = app.locals.noteService.createNote({ title: 'Existing', projectIds: [firstProjectId] });

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
    expect(response.text).toMatch(new RegExp(`id="note-project-option-${secondProjectId}"[^>]*checked`));
    expect(response.text).not.toMatch(new RegExp(`id="note-project-option-${firstProjectId}"[^>]*checked`));
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
    const note = app.locals.noteService.createNote({
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

    expect(response.text).toContain('Title is required.');
    expect(response.text).toContain('Attempted both content');
    expect(response.text).toMatch(new RegExp(`id="note-project-option-${attemptedProjectId}"[^>]*checked`));
    expect(response.text).not.toMatch(new RegExp(`id="note-project-option-${storedProjectId}"[^>]*checked`));
    expect(response.text).toMatch(new RegExp(`id="note-asset-option-${attemptedAssetId}"[^>]*checked`));
    expect(response.text).not.toMatch(new RegExp(`id="note-asset-option-${storedAssetId}"[^>]*checked`));
  });

  it('renders associated projects on note detail with project links', async () => {
    const firstProjectId = insertProject(db, 'Detail First');
    const secondProjectId = insertProject(db, 'Detail Second');
    const note = app.locals.noteService.createNote({
      title: 'Project Detail Note',
      projectIds: [firstProjectId, secondProjectId],
    });

    const response = await agent.get(`/notes/${note.id}`).expect(200);
    const projectsSection = response.text.match(/<section class="notes-detail-projects">[\s\S]*?<\/section>/)?.[0];

    expect(projectsSection).toBeDefined();
    expect(projectsSection).toContain('<h2>Projects</h2>');
    expect(projectsSection).toContain(`<a href="/projects/${firstProjectId}">Detail First</a>`);
    expect(projectsSection).toContain(`<a href="/projects/${secondProjectId}">Detail Second</a>`);
  });

  it('renders associated assets on note detail with project context and canonical viewer links', async () => {
    const firstProjectId = insertProject(db, 'Detail Asset First');
    const secondProjectId = insertProject(db, 'Detail Asset Second');
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
      title: 'Asset Detail Note',
      assetIds: [firstAssetId, secondAssetId],
    });

    const response = await agent.get(`/notes/${note.id}`).expect(200);
    const assetsSection = response.text.match(/<section class="notes-detail-assets">[\s\S]*?<\/section>/)?.[0];

    expect(assetsSection).toBeDefined();
    expect(assetsSection).toContain('<h2>Assets</h2>');
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
    const assetId = insertAsset(db, projectId, 'historical.bin', {
      extension: 'bin',
      mimeType: 'application/octet-stream',
    });
    markAssetMissing(db, assetId);
    const note = app.locals.noteService.createNote({ title: 'Historical asset note', assetIds: [assetId] });

    const response = await agent.get(`/notes/${note.id}`).expect(200);
    const assetsSection = response.text.match(/<section class="notes-detail-assets">[\s\S]*?<\/section>/)?.[0];

    expect(assetsSection).toContain(
      `<a class="notes-detail-asset-link" href="/projects/${projectId}/assets/${assetId}">historical.bin</a>`,
    );
    expect(assetsSection).toContain('Project: Historical Asset Project');
    expect(assetsSection).toContain('>Missing</span>');

    const editResponse = await agent.get(`/notes/${note.id}/edit`).expect(200);
    expect(editResponse.text).toMatch(new RegExp(`id="note-asset-option-${assetId}"[^>]*checked`));
    expect(editResponse.text).toContain('>Missing</span>');
  });

  it('GET and POST edit routes return 404 for a nonexistent note', async () => {
    await agent.get('/notes/9999/edit').expect(404);
    await agent
      .post('/notes/9999')
      .type('form')
      .send({ _csrf: csrfToken, title: 'Missing', content: '' })
      .expect(404);
  });

  it('POST /notes/:id/delete requires CSRF and cascades association rows', async () => {
    const projectId = insertProject(db, 'Delete Association Project');
    const assetId = insertAsset(db, projectId, 'delete-note-asset.png');
    const note = app.locals.noteService.createNote({ title: 'Delete me', content: 'Content' });
    app.locals.noteRepository.replaceProjects(note.id, [projectId]);
    app.locals.noteRepository.replaceAssets(note.id, [assetId]);

    await agent.post(`/notes/${note.id}/delete`).type('form').send({}).expect(403);
    expect(app.locals.noteRepository.findById(note.id)).toBeDefined();

    const response = await agent
      .post(`/notes/${note.id}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(response.headers.location).toBe('/notes');
    expect(app.locals.noteRepository.findById(note.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM note_projects WHERE note_id = ?').all(note.id)).toEqual([]);
    expect(db.prepare('SELECT * FROM note_assets WHERE note_id = ?').all(note.id)).toEqual([]);
  });

  it('POST /notes/:id/delete returns 404 for a nonexistent note', async () => {
    await agent
      .post('/notes/9999/delete')
      .type('form')
      .send({ _csrf: csrfToken })
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
});
