import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

// WP6.3: GET /notes/projects/:projectId/new renders the closed Create Note
// dialog alone, for Project Detail to mount on demand (WP6.4). It is the shared
// Notes form: a required, always-visible Note location (the Move Page
// destinations) replaces Book contents, and the route's Project is the one
// locked connection whose Assets are offered. It submits to the WP6.2 POST.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function insertProject(db, title) {
  return Number(db.prepare(
    `INSERT INTO projects (title, slug, description, notes, status, patreon_url, project_type)
     VALUES (?, ?, '', '', 'tbd', NULL, 'images')`,
  ).run(title, title.toLowerCase().replace(/\s+/g, '-')).lastInsertRowid);
}

function insertAsset(db, projectId, filename, { present = true } = {}) {
  return db.prepare(`
    INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at)
    VALUES (?, ?, ?, 'png', 'image/png', 1, ?, datetime('now'))
    RETURNING id
  `).get(projectId, filename, filename, present ? 1 : 0).id;
}

const tagAttributes = (tag) => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] ?? '']),
);
const section = (html, heading) => html.match(new RegExp(`<section\\b[^>]*aria-labelledby="${heading}"[\\s\\S]*?</section>`))?.[0] || '';
const nativeOptions = (html, selectId) => {
  const select = html.match(new RegExp(`<select id="${selectId}"[\\s\\S]*?</select>`))?.[0] || '';
  return [...select.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)]
    .map(([, value, rest, label]) => ({ value, selected: /\bselected\b/.test(rest), label: label.trim() }));
};

describe('GET /notes/projects/:projectId/new (Project Detail Create Note dialog)', () => {
  let db;
  let app;
  let tmpDir;
  let agent;
  let csrfToken;
  let projectId;
  let otherProjectId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-notes-project-create-dialog-'));
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
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const getDialog = (id = projectId) => agent.get(`/notes/projects/${id}/new`);
  const createBooks = () => {
    const lore = app.locals.bookService.createBook({ title: 'Lore Book' });
    const first = app.locals.chapterService.createChapter({ bookId: lore.id, title: 'First Chapter' });
    const second = app.locals.chapterService.createChapter({ bookId: lore.id, title: 'Second Chapter' });
    const bare = app.locals.bookService.createBook({ title: 'Bare Book' });
    return { lore, first, second, bare };
  };

  describe('dialog rendering', () => {
    it('returns the closed Create Note dialog alone, named and wired to the WP6.2 POST', async () => {
      createBooks();
      const { text: html } = await getDialog().expect(200).expect('Content-Type', /html/);

      expect(html.trim().startsWith('<dialog')).toBe(true);
      expect(html).not.toMatch(/<html|<body|<main/);
      expect(html.match(/<dialog\b/g)).toHaveLength(1);
      const dialogTag = html.match(/<dialog\b[^>]*>/)[0];
      expect(tagAttributes(dialogTag)).toMatchObject({
        id: 'project-note-create-dialog', 'data-app-dialog': '', 'aria-labelledby': 'project-note-create-dialog-title',
      });
      expect(dialogTag).not.toMatch(/\sopen\b/);
      expect(html).toContain('<h2 id="project-note-create-dialog-title">Create Note</h2>');

      const formTag = html.match(/<form id="note-form"[^>]*>/)[0];
      expect(tagAttributes(formTag)).toMatchObject({
        method: 'post',
        action: `/notes/projects/${projectId}`,
        'data-notes-editor-form': '',
        'data-note-dialog-dirty': '',
        'data-dialog-form': '',
        'data-dialog-async': 'true',
        'data-dialog-reset-on-close': '',
      });
      expect(html.match(/<form\b/g)).toHaveLength(1);
      expect(html).toContain(`<input type="hidden" name="_csrf" value="${csrfToken}">`);
      // The shared editor, title and connections hooks, once each.
      for (const hook of ['data-notes-editor-host', 'data-notes-editor-source', 'data-note-connections', 'data-note-dialog-baseline']) {
        expect(html.match(new RegExp(`\\s${hook}(?=[\\s>=])`, 'g'))).toHaveLength(1);
      }
      expect(html).toContain('id="note-create-title" name="title"');
      expect(html).toMatch(/<button class="button button-primary" type="submit" form="note-form" data-dialog-submit>/);
    });

    it('repeats no element ID within the returned markup', async () => {
      createBooks();
      insertAsset(db, projectId, 'one.png');
      const { text: html } = await getDialog().expect(200);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThan(10);
      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    });

    it('is 404 for a malformed or unknown Project', async () => {
      await agent.get('/notes/projects/abc/new').expect(404);
      await agent.get('/notes/projects/0/new').expect(404);
      await agent.get('/notes/projects/999999/new').expect(404);
    });
  });

  describe('Note location', () => {
    it('replaces Book contents with a non-collapsible required location of direct Book and Chapter destinations', async () => {
      const { lore, first, second, bare } = createBooks();
      const { text: html } = await getDialog().expect(200);

      expect(html).not.toContain('Book contents');
      expect(html).not.toContain('notes-book-contents-disclosure');
      const location = section(html, 'notes-location-heading');
      expect(location).toContain('<h3 id="notes-location-heading">Note location</h3>');
      expect(location).toContain('data-note-location');
      expect(location).not.toMatch(/<details class="notes-|<summary class="notes-book-contents-toggle/);
      expect(location).toMatch(/<legend>Book or Chapter <span class="required" aria-label="required">\*<\/span><\/legend>/);
      expect(location).toContain('data-dialog-field="targetContainer"');

      const select = location.match(/<select id="note-location-target"[^>]*>/)[0];
      expect(tagAttributes(select)).toMatchObject({ name: 'targetContainer', required: '' });
      // Books in shelf order, as Move Page lists them, each followed by its Chapters.
      expect(nativeOptions(location, 'note-location-target')).toEqual([
        { value: '', selected: true, label: 'Choose a Book or Chapter' },
        { value: `book:${lore.id}`, selected: false, label: 'Book: Lore Book (direct Pages)' },
        { value: `chapter:${first.id}`, selected: false, label: 'Chapter: Lore Book / First Chapter' },
        { value: `chapter:${second.id}`, selected: false, label: 'Chapter: Lore Book / Second Chapter' },
        { value: `book:${bare.id}`, selected: false, label: 'Book: Bare Book (direct Pages)' },
      ]);
      // The shared single-select dropdown, showing the placeholder with nothing chosen.
      expect(location).toMatch(/id="note-location-dropdown" data-cc-dropdown data-cc-dropdown-mode="single"/);
      expect(location).toContain('<span data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">Choose a Book or Chapter</span>');
      expect(location.match(/type="radio" value="[^"]*" checked/g)).toEqual(['type="radio" value="" checked']);
    });

    it('submits no other parent field beside targetContainer', async () => {
      createBooks();
      const { text: html } = await getDialog().expect(200);
      for (const name of ['bookId', 'chapterId', 'targetBookId', 'targetChapterId']) {
        expect(html).not.toContain(`name="${name}"`);
      }
      expect(html.match(/name="targetContainer"/g)).toHaveLength(1);
      expect(html).not.toContain('form="note-move-form"');
      expect(html).not.toContain('note-move-dropdown');
    });

    it('explains that a Book is required, links to Book creation and disables Create when no Book exists', async () => {
      const { text: html } = await getDialog().expect(200);
      const location = section(html, 'notes-location-heading');
      expect(location).toContain('<h3 id="notes-location-heading">Note location</h3>');
      expect(location).toContain('A Book is required before a Note can be created.');
      expect(location).toContain('<a href="/notes/books/new">Create a Book</a>');
      expect(location).toContain('data-dialog-field="targetContainer"');
      expect(location).not.toContain('<select');
      expect(html).toMatch(/<button class="button button-primary" type="submit" form="note-form" data-dialog-submit disabled aria-describedby="note-location-unavailable">/);
      expect(html).toContain('id="note-location-unavailable"');
    });

    it('offers a Book that has no Chapters as its direct Pages only', async () => {
      const bare = app.locals.bookService.createBook({ title: 'Solo Book' });
      const { text: html } = await getDialog().expect(200);
      expect(nativeOptions(html, 'note-location-target').map((option) => option.value)).toEqual(['', `book:${bare.id}`]);
    });

    it('escapes and keeps long or similarly named destinations distinct', async () => {
      const long = 'A'.repeat(180);
      const book = app.locals.bookService.createBook({ title: `${long} <Saga>` });
      app.locals.bookService.createBook({ title: `${long} <Saga> II` });
      app.locals.chapterService.createChapter({ bookId: book.id, title: 'Part & One' });
      const { text: html } = await getDialog().expect(200);
      const labels = nativeOptions(html, 'note-location-target').map((option) => option.label);
      expect(labels).toContain(`Book: ${long} &lt;Saga&gt; (direct Pages)`);
      expect(labels).toContain(`Book: ${long} &lt;Saga&gt; II (direct Pages)`);
      expect(labels).toContain(`Chapter: ${long} &lt;Saga&gt; / Part &amp; One`);
      expect(new Set(labels).size).toBe(labels.length);
    });

    it('starts the dirty baseline at the unchosen location and the locked Project', async () => {
      createBooks();
      const { text: html } = await getDialog().expect(200);
      const baseline = JSON.parse(html.match(/<script type="application\/json" data-note-dialog-baseline>([\s\S]*?)<\/script>/)[1]);
      expect(baseline).toEqual({
        title: '', content: '', targetContainer: '', projectIds: [String(projectId)], assetIds: [], assets: [],
      });
    });
  });

  describe('connections', () => {
    it('shows the current Project selected and locked, without other Projects or a way to remove it', async () => {
      const { text: html } = await getDialog().expect(200);
      const connections = section(html, 'notes-connections-heading');
      const projects = connections.match(/<fieldset\b[^>]*data-note-locked-project[\s\S]*?<\/fieldset>/)[0];

      expect(projects).toContain(`data-note-locked-project="${projectId}"`);
      expect(projects).toContain('data-dialog-field="projectIds"');
      expect(projects).toMatch(/id="note-projects-form" data-cc-dropdown data-cc-dropdown-mode="multiple"[^>]*data-cc-dropdown-config-disabled data-cc-dropdown-disabled aria-disabled="true"/);
      expect(projects).toContain('<span data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">Host Project</span>');
      expect(projects).toContain('aria-label="Project: Host Project"');
      expect(projects).toContain('aria-describedby="note-locked-project-help"');
      const boxes = [...projects.matchAll(/<input [^>]*type="checkbox"[^>]*>/g)].map(([tag]) => tag);
      expect(boxes).toHaveLength(1);
      expect(tagAttributes(boxes[0])).toMatchObject({
        name: 'projectIds[]', value: String(projectId), checked: '', disabled: '', 'data-project-archived': 'false',
      });
      expect(projects).not.toContain('data-cc-dropdown-search');
      expect(connections).not.toContain('Other Project');
      expect(connections).toContain('<p class="help-text" id="note-locked-project-help">Notes created here are always connected to this project. The Project cannot be changed.</p>');
    });

    it('names what it creates a Note throughout, never a Page (WP6-F3)', async () => {
      createBooks();
      const { text: html } = await getDialog().expect(200);
      expect(html).toContain('<h2 id="project-note-create-dialog-title">Create Note</h2>');
      expect(html).toContain('<h3 id="notes-location-heading">Note location</h3>');
      expect(html).toContain('<h3 id="notes-editor-heading">Note contents</h3>');
      expect(html).toMatch(/<label for="note-create-title">Note title </);
      expect(html).toContain('<p class="notes-connections-description">Link this Note to assets from this project.</p>');
      expect(html).toContain('data-dialog-pending-message="Creating Note…"');
      expect(html).toContain('data-dialog-error-message="The Note could not be created."');
      // Book destinations keep their "(direct Pages)" wording: it names the Book's
      // existing Page list, the place the Note joins.
      const form = html.slice(html.indexOf('<form id="note-form"'), html.indexOf('</form>'));
      expect(form.replace(/\(direct Pages\)/g, '')).not.toMatch(/\bPages?\b/);
    });

    it('offers only the current Project\'s Assets, including missing files, through the shared asset selector', async () => {
      const present = insertAsset(db, projectId, 'present.png');
      const missing = insertAsset(db, projectId, 'missing.png', { present: false });
      insertAsset(db, otherProjectId, 'foreign.png');
      const { text: html } = await getDialog().expect(200);
      const connections = section(html, 'notes-connections-heading');

      expect(connections).toMatch(/<div data-note-assets>/);
      expect(connections).toContain('data-assets-url="/notes/asset-picker/assets"');
      expect(connections).toMatch(/<select id="note-assets-native" name="assetIds\[\]"[^>]*multiple/);
      const assets = nativeOptions(connections, 'note-assets-native');
      expect(assets.map((option) => option.value).sort()).toEqual([String(present), String(missing)].sort());
      expect(assets.every((option) => !option.selected)).toBe(true);
      expect(assets.find((option) => option.value === String(missing)).label).toContain('(Missing)');
      expect(assets.every((option) => option.label.includes('Project: Host Project'))).toBe(true);
      expect(connections).not.toContain('foreign.png');
      expect(connections).toContain('<input type="hidden" name="assetIds[]" value="">');
    });

    it('keeps the existing archived-Project rule: the Project stays locked and no Asset choices load', async () => {
      insertAsset(db, projectId, 'archived.png');
      db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(projectId);
      const { text: html } = await getDialog().expect(200);
      const connections = section(html, 'notes-connections-heading');
      expect(connections).toContain('<span data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">Host Project (Archived)</span>');
      expect(connections).toMatch(/data-project-archived="true"/);
      expect(connections).toMatch(/<div data-note-assets hidden>/);
      expect(nativeOptions(connections, 'note-assets-native')).toEqual([]);
    });
  });

  describe('regressions', () => {
    it('leaves the ordinary New Page and Edit Page dialogs as they were', async () => {
      const { lore, first } = createBooks();
      insertProject(db, 'Third Project');
      const { text: create } = await agent.get(`/notes/new?chapterId=${first.id}`).expect(200);
      expect(create).toContain('<h2 id="note-create-dialog-title">New Page</h2>');
      expect(create).toContain(`<input type="hidden" name="chapterId" value="${first.id}">`);
      expect(create).toContain('notes-book-contents-disclosure');
      expect(create).not.toContain('Note location');
      expect(create).not.toContain('data-note-locked-project');
      expect(create).toMatch(/id="note-projects-form" data-cc-dropdown data-cc-dropdown-mode="multiple" data-cc-dropdown-searchable/);
      expect(create).not.toMatch(/data-note-dialog-baseline>[^<]*targetContainer/);
      expect(create).toContain('<h3 id="notes-editor-heading">Page contents</h3>');
      expect(create).toContain('Link this Page to existing projects and assets.');
      expect(create).toMatch(/<label for="note-create-title">Page title </);
      expect(create).not.toMatch(/Note contents|Note title|Link this Note/);

      const page = await agent.post('/notes').type('form')
        .send({ _csrf: csrfToken, title: 'Existing', content: '', bookId: String(lore.id) }).expect(302);
      const noteId = page.headers.location.split('/').pop();
      const { text: edit } = await agent.get(`/notes/${noteId}`).expect(200);
      expect(edit).toContain('notes-book-contents-disclosure');
      expect(edit).not.toContain('Note location');
      expect(edit).not.toMatch(/data-note-dialog-baseline>[^<]*targetContainer/);
      expect(edit).toContain('<h3 id="notes-editor-heading">Page contents</h3>');
      expect(edit).toContain('Link this Page to existing projects and assets.');
      expect(edit).toMatch(/<label for="note-edit-title">Page title </);
      expect(edit).not.toMatch(/Note contents|Note title|Link this Note/);
      // Move Page keeps its own destinations, with the current location chosen.
      const move = nativeOptions(edit, 'note-move-target');
      expect(move.map((option) => option.value)).toContain(`chapter:${first.id}`);
      expect(move.find((option) => option.selected)).toMatchObject({ value: `book:${lore.id}` });
      expect(move.some((option) => option.value === '')).toBe(false);
    });

    it('creates through the unchanged WP6.2 POST with the fields the dialog submits', async () => {
      const { first } = createBooks();
      const asset = insertAsset(db, projectId, 'one.png');
      const response = await agent.post(`/notes/projects/${projectId}`)
        .set('Accept', 'application/json').type('form')
        .send({ _csrf: csrfToken, title: 'From dialog', content: 'Body', targetContainer: `chapter:${first.id}`, assetIds: ['', String(asset)] })
        .expect(201);
      expect(response.body.page).toMatchObject({ chapterId: first.id, projectIds: [projectId], assetIds: [asset] });
    });
  });
});
