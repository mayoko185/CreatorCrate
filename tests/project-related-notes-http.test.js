import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

// WP3A: Project Detail renders a server-side Related Notes section above
// Releases from the committed Notes read model as Notes Book Detail Page
// preview cards (WP6.1: no association badges), with this Project's asset
// previews through the shared list card, the complete sanitized Markdown Page
// hidden behind a Show note disclosure, and icon-only Edit/Pin hooks.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const tagAttributes = (tag) => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] ?? '']),
);

function region(html) {
  const start = html.indexOf('<div class="project-related-notes-region"');
  const end = html.indexOf('<section class="release-summary project-detail-releases');
  return start >= 0 && end > start ? html.slice(start, end) : '';
}

// Each note card is one list item; asset tiles inside it are articles too.
function cards(html) {
  return region(html).split('<li class="project-related-note-item">').slice(1);
}

function card(html, noteId) {
  return cards(html).find((item) => item.includes(`data-project-related-note="${noteId}"`)) || '';
}

function cardAssetIds(item) {
  return [...item.matchAll(/data-project-related-note-asset="(\d+)"/g)].map((m) => Number(m[1]));
}

describe('Project Detail Related Notes', () => {
  let db;
  let app;
  let agent;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-related-notes-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fixture() {
    const project = app.locals.projectService.create({ title: 'Related Project', status: 'tbd' });
    const other = app.locals.projectService.create({ title: 'Other Project', status: 'tbd' });
    const assets = createAssetRepository(db);
    const upsert = (projectId, relativePath, extension, mimeType) => assets.upsert(projectId, relativePath, {
      filename: relativePath.split('/').pop(), extension, mimeType, sizeBytes: 4096, modifiedAt: '2026-08-06 12:00:00',
    }).id;
    const ids = {
      image: upsert(project.id, 'art/cover.png', 'png', 'image/png'),
      video: upsert(project.id, 'clip.webm', 'webm', 'video/webm'),
      comic: upsert(project.id, 'book.cbz', 'cbz', 'application/vnd.comicbook+zip'),
      text: upsert(project.id, 'readme.txt', 'txt', 'text/plain'),
      gone: upsert(project.id, 'gone.png', 'png', 'image/png'),
      foreign: upsert(other.id, 'foreign.png', 'png', 'image/png'),
    };
    db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(ids.gone);

    const book = app.locals.bookService.createBook({ title: 'Lore' });
    const create = (input) => app.locals.noteService.createNote({ bookId: book.id, content: '', ...input });
    const notes = {
      direct: create({ title: 'Direct Page', content: '# Direct Page\n\nPlain **bold** text.', projectIds: [project.id] }),
      asset: create({ title: 'Asset Page', content: 'Asset _notes_.', assetIds: [ids.image, ids.foreign] }),
      both: create({
        title: 'Both Page',
        content: '',
        projectIds: [project.id, other.id],
        assetIds: [ids.video, ids.comic, ids.text, ids.gone],
      }),
      unrelated: create({ title: 'Other Only', projectIds: [other.id], assetIds: [ids.foreign] }),
    };
    return { project, other, ids, notes };
  }

  it('renders Related Notes above Releases as Book Detail cards, one per Note, without association badges', async () => {
    const f = fixture();
    const html = (await agent.get(`/projects/${f.project.id}`).expect(200)).text;

    const related = html.indexOf('<h2 id="project-related-notes-heading">Related Notes</h2>');
    const releases = html.indexOf('<h2>Releases</h2>');
    expect(related).toBeGreaterThan(0);
    expect(related).toBeLessThan(releases);
    // Directly above Releases: nothing but the region sits between them.
    expect(html.indexOf('<section', related)).toBe(html.indexOf('<section class="release-summary project-detail-releases'));
    expect(html.indexOf('</section>', html.indexOf('project-detail-hero'))).toBeLessThan(related);

    const ids = cards(html).map((item) => Number(item.match(/data-project-related-note="(\d+)"/)[1]));
    const expectedOrder = app.locals.noteService.listRelatedNotesForProject(f.project.id).notes.map((n) => n.id);
    expect(ids).toEqual(expectedOrder);
    expect(new Set(ids)).toEqual(new Set([f.notes.direct.id, f.notes.asset.id, f.notes.both.id]));
    expect(region(html)).not.toContain('Other Only');

    // Association badges are gone; the dual-linked Note still renders once.
    const section = region(html);
    expect(section).not.toContain('data-project-related-note-association');
    expect(section).not.toMatch(/Project note|Asset-associated note|status-badge/);
    expect(ids.filter((id) => id === f.notes.both.id)).toHaveLength(1);

    // The Notes Book Detail Page preview card list, card and title classes.
    expect(section).toContain('<ul class="notes-page-preview-list project-related-note-list">');
    for (const id of ids) {
      expect(card(html, id)).toMatch(new RegExp(`<article class="notes-page-preview-item project-related-note" id="project-related-note-${id}"`));
    }

    const direct = card(html, f.notes.direct.id);
    expect(direct).toContain(`<a class="notes-page-preview-title" href="/notes/${f.notes.direct.id}" data-project-related-note-page-link>Direct Page</a>`);
    expect(direct).not.toContain('data-project-related-note-asset=');
  });

  it('shows only this Project\'s assets through the shared list card, with each preview state', async () => {
    const f = fixture();
    const html = (await agent.get(`/projects/${f.project.id}`).expect(200)).text;

    const asset = card(html, f.notes.asset.id);
    expect(cardAssetIds(asset)).toEqual([f.ids.image]);
    expect(region(html)).not.toContain('foreign.png');
    expect(region(html)).not.toContain(`/projects/${f.other.id}/assets/`);

    // Present image: shared list card, revisioned thumbnail/preview URL, details link, filename.
    expect(asset).toContain('<article class="asset-list-card project-related-note-asset"');
    const imageLink = tagAttributes(asset.match(/<a class="asset-list-card-media-link"[^>]*>/)[0]);
    expect(imageLink.href).toBe(`/projects/${f.project.id}/assets/${f.ids.image}`);
    expect(asset).toMatch(new RegExp(`src="/projects/${f.project.id}/assets/${f.ids.image}/preview\\?v=[^"]+"`));
    expect(asset).toContain('<h4 class="asset-list-card-title">');
    expect(asset).toContain('>cover</a>');
    // WP7.4: the thumbnail and the filename both carry the Related Notes
    // image viewer trigger (opt-in); no other host's trigger is requested.
    expect(imageLink).toHaveProperty('data-project-related-note-viewer-trigger');
    expect(imageLink['data-viewer-asset']).toBe(String(f.ids.image));
    expect(imageLink['data-viewer-original-url']).toBe(`/projects/${f.project.id}/assets/${f.ids.image}/original`);
    const imageTitle = tagAttributes(asset.match(/<a class="asset-file-link"[^>]*>/)[0]);
    expect(imageTitle.href).toBe(imageLink.href);
    expect(imageTitle).toHaveProperty('data-project-related-note-viewer-trigger');
    expect(imageTitle['data-viewer-preview-url']).toBe(imageLink['data-viewer-preview-url']);
    expect(region(html)).not.toMatch(/data-project-(detail|assets)-viewer-trigger|data-project-assets-comic-trigger/);

    const both = card(html, f.notes.both.id);
    expect(cardAssetIds(both).sort((a, b) => a - b))
      .toEqual([f.ids.video, f.ids.comic, f.ids.text, f.ids.gone].sort((a, b) => a - b));
    const tile = (assetId) => both.match(new RegExp(
      `<li class="asset-list-item[^"]*" data-project-related-note-asset="${assetId}">[\\s\\S]*?</article>`,
    ))?.[0] ?? '';
    expect(tile(f.ids.video)).toContain('data-asset-video-preview-trigger');
    expect(tile(f.ids.video)).toContain(`data-video-src="/projects/${f.project.id}/assets/${f.ids.video}/original"`);
    // The video's filename opens the same shared video preview as its thumbnail.
    expect(tagAttributes(tile(f.ids.video).match(/<a class="asset-file-link"[^>]*>/)[0]))
      .toMatchObject({ 'data-asset-video-preview-trigger': '', 'data-video-src': `/projects/${f.project.id}/assets/${f.ids.video}/original` });
    // A readable comic keeps its placeholder, inside a Read comic link; its filename reads it too.
    expect(tile(f.ids.comic)).toContain('CBZ<span class="sr-only"> — preview not supported</span>');
    const comicLinks = tile(f.ids.comic).match(/<a class="asset-(list-card-media-link|file-link)"[^>]*>/g).map(tagAttributes);
    expect(comicLinks).toHaveLength(2);
    for (const link of comicLinks) {
      expect(link).toMatchObject({
        href: `/projects/${f.project.id}/assets/${f.ids.comic}`,
        'data-project-related-note-comic-trigger': '',
        'data-comic-project': String(f.project.id),
        'data-comic-asset': String(f.ids.comic),
      });
      expect(link['data-comic-source-revision']).toBeTruthy();
    }
    // Unsupported and missing files keep plain Asset Details links, with no trigger.
    expect(tile(f.ids.text)).toContain('TXT<span class="sr-only"> — preview not supported</span>');
    for (const id of [f.ids.text, f.ids.gone]) {
      expect(tile(id)).not.toMatch(/viewer-trigger|comic-trigger|data-comic-|data-asset-video-preview-trigger/);
      expect(tile(id)).toContain(`<a class="asset-file-link" href="/projects/${f.project.id}/assets/${id}">`);
    }
    expect(tile(f.ids.gone)).toMatch(/^<li class="asset-list-item is-missing"/);
    expect(tile(f.ids.gone)).toContain('<span class="sr-only">Missing at last scan</span>');
    expect(tile(f.ids.gone)).not.toContain('<img');
  });

  it('renders the complete sanitized Markdown Page hidden by default, with escaped plain text', async () => {
    const project = app.locals.projectService.create({ title: 'Safety', status: 'tbd' });
    const book = app.locals.bookService.createBook({ title: 'Safety Book' });
    const longContent = [
      ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'word '.repeat(30)}`),
      '| A | B |\n| --- | --- |\n| one | two |',
      '```js\nconst wide = 1;\n```',
      'Final paragraph marker.',
    ].join('\n\n');
    const unsafe = app.locals.noteService.createNote({
      bookId: book.id,
      title: '<img src=x onerror=alert(1)> Title',
      content: [
        '# <img src=x onerror=alert(1)> Title',
        '',
        '<script>alert("x")</script> **Bold** and [bad](javascript:alert(1)) and [ok](https://example.com).',
        '',
        '![remote](https://example.com/a.png)',
      ].join('\n'),
      projectIds: [project.id],
    });
    const long = app.locals.noteService.createNote({ bookId: book.id, title: 'Long', content: longContent, projectIds: [project.id] });
    const empty = app.locals.noteService.createNote({ bookId: book.id, title: 'Empty', content: '   ', projectIds: [project.id] });

    const html = (await agent.get(`/projects/${project.id}`).expect(200)).text;
    const unsafeCard = card(html, unsafe.id);
    expect(unsafeCard).toContain('&lt;img src=x onerror=alert(1)&gt; Title');
    expect(unsafeCard).not.toMatch(/<img[^>]*onerror/);
    expect(unsafeCard.match(/<div class="notes-content[\s\S]*?<\/div>/)[0]).not.toContain('<img');
    expect(unsafeCard).not.toContain('<script>');
    expect(unsafeCard).not.toContain('href="javascript:');
    // Images stay disabled, as on the Notes Page: the remote image never loads.
    expect(unsafeCard).not.toContain('src="https://example.com/a.png"');
    expect(unsafeCard).toContain('<strong>Bold</strong>');
    expect(unsafeCard).toContain('href="https://example.com"');
    // The leading heading repeating the title is suppressed, as on the Notes Page.
    expect(unsafeCard).not.toMatch(/<h1>/);

    // The whole Page, through its last element, with no truncation marker.
    const longCard = card(html, long.id);
    expect(longCard).not.toContain('Preview truncated');
    expect(longCard).not.toContain('notes-page-preview-truncated');
    expect(longCard).toContain('Paragraph 0');
    expect(longCard).toContain('Paragraph 39');
    expect(longCard).toContain('<table>');
    expect(longCard).toContain('<pre><code class="language-js">const wide = 1;');
    expect(longCard).toContain('<p>Final paragraph marker.</p>');
    // Exactly what the Notes Page renders for the same Page.
    const rendered = app.locals.markdownRenderer.renderMarkdown(longContent, { suppressLeadingH1Matching: 'Long' });
    expect(longCard).toContain(`<div class="notes-content book-page-preview-content">${rendered}</div>`);

    const emptyCard = card(html, empty.id);
    expect(emptyCard).toContain('<p class="notes-page-preview-empty-content">No content yet.</p>');
    expect(emptyCard).not.toContain('book-page-preview-content');

    for (const item of [unsafeCard, longCard, emptyCard]) {
      const id = Number(item.match(/data-project-related-note="(\d+)"/)[1]);
      const preview = tagAttributes(item.match(/<div class="project-related-note-preview"[^>]*>/)[0]);
      expect(preview).toMatchObject({ id: `project-related-note-${id}-preview`, hidden: '' });
      expect(item).toContain(`<p class="project-related-note-full-link"><a href="/notes/${id}">Open in notes</a></p>`);
      expect(item).not.toContain('Open the full page');
    }
  });

  it('gives every card distinct disclosure, Edit and Pin hooks outside the disclosure button', async () => {
    const f = fixture();
    const html = (await agent.get(`/projects/${f.project.id}`).expect(200)).text;
    const items = cards(html);
    expect(items).toHaveLength(3);

    const controlIds = new Set();
    for (const item of items) {
      const id = item.match(/data-project-related-note="(\d+)"/)[1];
      const button = item.match(/<button class="project-related-note-disclosure"[\s\S]*?<\/button>/)[0];
      const attrs = tagAttributes(button.match(/<button[^>]*>/)[0]);
      expect(attrs).toMatchObject({
        type: 'button',
        'aria-expanded': 'false',
        'aria-controls': `project-related-note-${id}-preview`,
        'data-project-related-note-disclosure': id,
      });
      expect(button).toMatch(/<span data-project-related-note-disclosure-label>Show note<\/span><span class="sr-only">: [^<]+<\/span>/);
      expect(button).not.toContain('Preview content');
      expect(button).not.toMatch(/data-project-related-note-(edit|pin)/);
      expect(item).toContain(`id="${attrs['aria-controls']}" data-project-related-note-preview="${id}" hidden`);
      controlIds.add(attrs['aria-controls']);

      // Edit opens the Notes Edit Page dialog in place (WP4); it is not a link.
      const edit = tagAttributes(item.match(/<button [^>]*data-project-related-note-edit[^>]*>/)[0]);
      expect(edit).toMatchObject({ type: 'button', 'aria-haspopup': 'dialog', 'data-project-related-note-edit': id });
      expect(edit).not.toHaveProperty('href');
      expect(edit['aria-label']).toMatch(/^Edit /);
      // Icon-only: the established Project Detail icon action and tooltip.
      expect(edit.class.split(' ')).toEqual(expect.arrayContaining(['button', 'button-small', 'button-secondary', 'project-detail-action', 'asset-tooltip']));
      expect(edit['data-tooltip']).toBe('Edit note');
      const pin = tagAttributes(item.match(/<button [^>]*data-project-related-note-pin[^>]*>/)[0]);
      expect(pin).toMatchObject({ type: 'button', 'aria-pressed': 'false', 'data-project-related-note-pin': id });
      expect(pin['aria-label']).toMatch(/^Pin /);
      expect(pin.class.split(' ')).toEqual(expect.arrayContaining(['project-detail-action', 'asset-tooltip']));
      expect(pin['data-tooltip']).toBe('Pin note');
      // Both controls are icons beside the title in one header row, before the preview.
      const header = item.match(/<div class="project-related-note-header">[\s\S]*?<\/div>\s*<\/div>/)[0];
      expect(header).toContain('class="project-related-note-title"');
      for (const hook of ['data-project-related-note-edit', 'data-project-related-note-pin']) {
        const control = header.match(new RegExp(`<button [^>]*${hook}[^>]*>([\\s\\S]*?)</button>`))[1];
        expect(control.trim()).toMatch(/^<svg [^>]*aria-hidden="true"[\s\S]*<\/svg>$/);
      }
      expect(item.indexOf('data-project-related-note-pin')).toBeLessThan(item.indexOf('data-project-related-note-preview'));
    }
    expect(controlIds.size).toBe(3);
    const allIds = [...html.matchAll(/\sid="(project-related-note[^"]*)"/g)].map((m) => m[1]);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('always shows the section, its one Create new note action and an empty state when no Note qualifies', async () => {
    const f = fixture();
    const html = (await agent.get(`/projects/${f.project.id}`).expect(200)).text;
    // Populated: one heading, one Create action before the cards, no empty state.
    const populated = region(html);
    expect(populated.match(/id="project-related-notes-heading"/g)).toHaveLength(1);
    expect(populated.match(/data-project-related-note-create/g)).toHaveLength(1);
    expect(populated.indexOf('data-project-related-note-create')).toBeLessThan(populated.indexOf('project-related-note-list'));
    expect(populated).not.toContain('No related notes yet.');

    const lonely = app.locals.projectService.create({ title: 'No Notes', status: 'tbd' });
    const emptyHtml = (await agent.get(`/projects/${lonely.id}`).expect(200)).text;
    const empty = region(emptyHtml);
    expect(emptyHtml.match(/data-project-detail-region="related-notes"/g)).toHaveLength(1);
    expect(empty).toContain('data-project-related-notes-state="empty"');
    expect(empty.match(/<h2 id="project-related-notes-heading">Related Notes<\/h2>/g)).toHaveLength(1);
    expect(empty).toContain('<h3 class="empty-state-heading">No related notes yet.</h3>');
    expect(empty).not.toContain('data-project-related-note=');
    expect(empty).not.toContain('project-related-note-list');
    // Above Releases, with nothing else between them.
    const related = emptyHtml.indexOf('<h2 id="project-related-notes-heading">');
    expect(related).toBeGreaterThan(emptyHtml.indexOf('project-detail-hero'));
    expect(emptyHtml.indexOf('<section', related)).toBe(emptyHtml.indexOf('<section class="release-summary project-detail-releases'));

    // The Create action: a real button (no navigation) in the section's
    // action row, opening a dialog, with its accessible name as visible text.
    // WP7.3: Reorder Notes follows it, disabled and described while no Note qualifies.
    const create = empty.match(/<div class="workflow-actions">\s*(<button[^>]*data-project-related-note-create[^>]*>)Create new note<\/button>\s*(<button[^>]*data-project-related-notes-reorder[^>]*>)Reorder Notes<\/button>\s*<span class="sr-only" id="project-related-notes-reorder-unavailable">At least two related notes are needed to reorder them.<\/span>\s*<\/div>/);
    expect(create).not.toBeNull();
    expect(tagAttributes(create[1])).toEqual({
      class: 'button button-secondary',
      type: 'button',
      'aria-haspopup': 'dialog',
      'data-project-related-note-create': '',
    });
    expect(tagAttributes(create[2])).toEqual({
      class: 'button button-secondary',
      type: 'button',
      id: 'project-related-notes-reorder',
      'aria-haspopup': 'dialog',
      'data-project-related-notes-reorder': '',
      disabled: '',
      'aria-describedby': 'project-related-notes-reorder-unavailable',
    });
    expect(empty).not.toContain('/notes/projects/');
  });

  it('shows an inline unavailable notice, without error detail, when the Notes read fails', async () => {
    const f = fixture();
    vi.spyOn(app.locals.noteService, 'listRelatedNotesForProject').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: secret internal detail');
    });
    const html = (await agent.get(`/projects/${f.project.id}`).expect(200)).text;

    const section = region(html);
    expect(section).toContain('data-project-related-notes-state="unavailable"');
    expect(section).toContain('<h2 id="project-related-notes-heading">Related Notes</h2>');
    expect(section).toContain("Related notes couldn't be loaded. Reload the page to try again.");
    expect(section).not.toContain('data-project-related-note=');
    expect(section).not.toContain('No related notes yet.');
    // Creating stays available while the read is unavailable.
    expect(section.match(/data-project-related-note-create/g)).toHaveLength(1);
    expect(html).not.toContain('secret internal detail');
    expect(html).not.toContain('SQLITE_BUSY');
    // The rest of Project Detail is intact.
    expect(html).toContain('<h2>Releases</h2>');
    expect(html).toContain('data-project-detail-region="hero"');
  });
});
