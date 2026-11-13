import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { buildAssetRevisionToken } from '../src/services/preview-service.js';

// C2b: Read Comic presentation on the Asset Details page, rendered by the real
// route from indexed rows (no archive is opened; these rows have no file on
// disk). Only a present comic with an indexed-source revision gets the Asset
// Details Read Comic link, inside the existing media host, with the page's
// own identity and the server's indexed hint; missing and unanchored comics
// keep their notices, and images and videos keep their own media.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const COMIC_MIME = {
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  cb7: 'application/x-cb7',
};
const COMIC_TRIGGER = 'data-asset-details-comic-trigger';

function projectInput(title) {
  return {
    title,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: '',
    notes: '',
    status: 'tbd',
    projectType: 'images',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
  };
}

function linksWith(html, attribute) {
  return [...html.matchAll(/<a\s[^>]*>/g)].map((match) => match[0]).filter((tag) => tag.includes(attribute));
}

function attr(tag, name) {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
}

// The media host: from its opening tag to the Preview section's end.
function mediaHost(html) {
  const start = html.indexOf('data-asset-viewer-host');
  expect(start).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<div', start), html.indexOf('</section>', start));
}

describe('Asset Details Read Comic presentation (C2b)', () => {
  let db;
  let app;
  let tmpDir;
  let projectRepository;
  let assetRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-details-comic-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function addAsset(projectId, relativePath, extension, mimeType = COMIC_MIME[extension] ?? 'image/png') {
    return assetRepository.upsert(projectId, relativePath, {
      filename: path.posix.basename(relativePath),
      extension,
      mimeType,
      sizeBytes: 2048,
      modifiedAt: '2026-08-01 10:00:00',
      categoryId: null,
    });
  }

  function fixture() {
    const alpha = projectRepository.create(projectInput('Alpha Comics'));
    const beta = projectRepository.create(projectInput('Beta Comics'));
    const rows = {
      image: addAsset(alpha.id, 'cover.png', 'png'),
      cbz: addAsset(alpha.id, 'issue-1.cbz', 'cbz'),
      cbr: addAsset(alpha.id, 'issue-2.cbr', 'cbr'),
      cb7: addAsset(alpha.id, 'issue-3.cb7', 'cb7'),
      missing: addAsset(alpha.id, 'issue-4.cbz', 'cbz'),
      unanchored: addAsset(alpha.id, 'issue-5.cbz', 'cbz'),
      video: addAsset(alpha.id, 'clip.mp4', 'mp4', 'video/mp4'),
      betaCbz: addAsset(beta.id, 'issue-1.cbz', 'cbz'),
    };
    db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(rows.missing.id);
    db.prepare('UPDATE assets SET modified_at = \'\' WHERE id = ?').run(rows.unanchored.id);
    const fresh = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    const details = (projectId, assetId, query = '') => request(app).get(`/projects/${projectId}/assets/${assetId}${query}`);
    return { alpha, beta, rows, fresh, details };
  }

  it.each([['cbz', 'CBZ'], ['cbr', 'CBR'], ['cb7', 'CB7']])(
    'an eligible %s gets primary and failure Read Comic links with the page identity and the indexed hint',
    async (key, format) => {
      const { alpha, rows, fresh, details } = fixture();
      const row = fresh(rows[key].id);
      const response = await details(alpha.id, row.id);
      expect(response.status).toBe(200);
      const html = response.text;
      const host = mediaHost(html);
      const triggers = linksWith(html, COMIC_TRIGGER);
      expect(triggers).toHaveLength(2);
      const [trigger] = triggers;
      // Inside the existing media host, in its own comic frame.
      expect(host).toContain(COMIC_TRIGGER);
      expect(host).toContain('data-asset-comic-preview');
      expect(attr(trigger, 'data-comic-project')).toBe(String(alpha.id));
      expect(attr(trigger, 'data-comic-asset')).toBe(String(row.id));
      expect(attr(trigger, 'data-comic-title')).toBe(row.filename);
      expect(attr(trigger, 'data-comic-filename')).toBe(row.filename);
      expect(attr(trigger, 'data-comic-project-name')).toBe(alpha.title);
      // The C2a indexed hint (no fingerprint), never a manifest revision.
      expect(attr(trigger, 'data-comic-source-revision')).toBe(buildAssetRevisionToken(row));
      expect(attr(trigger, 'data-comic-source-revision')).toMatch(/^[0-9a-f]{16,}$/i);
      expect(trigger).not.toMatch(/\sdata-comic-revision=|\sdata-viewer-revision=/);
      // The canonical Asset Details href: modified clicks and no-JS navigate.
      expect(attr(trigger, 'href')).toBe(`/projects/${alpha.id}/assets/${row.id}`);
      expect(attr(trigger, 'aria-label')).toBe(`Read comic ${row.filename}`);
      expect(host).not.toContain(`${format} comic`);
      expect(host).toContain('Read comic');
      // The cover uses the ordinary Detail figure and native eager image.
      expect(host).not.toContain('data-asset-details-viewer-trigger');
      expect(host).not.toMatch(/data-comic-thumbnail|asset-comic-thumbnail|asset-comic-link/);
      expect(host).toContain('class="asset-preview-frame" data-preview-enhancement');
      expect(host).toContain('class="asset-preview-image"');
      expect(host).toMatch(new RegExp(`<img[^>]+src="/projects/${alpha.id}/assets/${row.id}/preview\\?v=[a-f0-9]{16}"`));
      expect(host).not.toContain('loading="lazy"');
      expect(triggers[1]).toContain('data-preview-fallback hidden');
      expect(host).not.toContain('Unsupported asset preview');
      expect(html).not.toMatch(/\/comic["?]|\/comic\/pages/);
      expect(html).not.toContain('data-project-assets-comic-trigger');
      expect(html).not.toContain('data-asset-library-comic-trigger');
    },
  );

  it('keeps the canonical href whatever asset-browser context the page carries', async () => {
    const { alpha, rows, details } = fixture();
    const html = (await details(alpha.id, rows.cbz.id, '?sort=filename&order=desc&view=list')).text;
    expect(attr(linksWith(html, COMIC_TRIGGER)[0], 'href')).toBe(`/projects/${alpha.id}/assets/${rows.cbz.id}`);
  });

  it('a comic of another project with the same filename carries its own identity and hint', async () => {
    const { alpha, beta, rows, fresh, details } = fixture();
    const alphaTrigger = linksWith((await details(alpha.id, rows.cbz.id)).text, COMIC_TRIGGER)[0];
    const betaTrigger = linksWith((await details(beta.id, rows.betaCbz.id)).text, COMIC_TRIGGER)[0];
    expect(attr(betaTrigger, 'data-comic-project')).toBe(String(beta.id));
    expect(attr(betaTrigger, 'data-comic-source-revision')).toBe(buildAssetRevisionToken(fresh(rows.betaCbz.id)));
    expect(attr(betaTrigger, 'data-comic-source-revision')).not.toBe(attr(alphaTrigger, 'data-comic-source-revision'));
    // A project-qualified route: the Beta comic is not part of Alpha.
    expect((await details(alpha.id, rows.betaCbz.id)).status).toBe(404);
  });

  it('a missing comic keeps the missing notice and has no reader trigger', async () => {
    const { alpha, rows, details } = fixture();
    const html = (await details(alpha.id, rows.missing.id)).text;
    const host = mediaHost(html);
    expect(host).toContain('Preview unavailable for missing assets.');
    expect(html).not.toContain(COMIC_TRIGGER);
    expect(html).not.toContain('data-comic-');
  });

  it('an unanchored comic keeps the unsupported notice and has no reader trigger', async () => {
    const { alpha, rows, details } = fixture();
    const html = (await details(alpha.id, rows.unanchored.id)).text;
    expect(mediaHost(html)).toContain('Unsupported asset preview');
    expect(html).not.toContain(COMIC_TRIGGER);
    expect(html).not.toContain('data-comic-');
  });

  it('a renamed comic renders a new hint (the accepted file render is authoritative)', async () => {
    const { alpha, rows, fresh, details } = fixture();
    const before = attr(linksWith((await details(alpha.id, rows.cbz.id)).text, COMIC_TRIGGER)[0], 'data-comic-source-revision');
    db.prepare('UPDATE assets SET filename = ?, relative_path = ? WHERE id = ?').run('issue-1b.cbz', 'issue-1b.cbz', rows.cbz.id);
    const trigger = linksWith((await details(alpha.id, rows.cbz.id)).text, COMIC_TRIGGER)[0];
    expect(attr(trigger, 'data-comic-source-revision')).toBe(buildAssetRevisionToken(fresh(rows.cbz.id)));
    expect(attr(trigger, 'data-comic-source-revision')).not.toBe(before);
    expect(attr(trigger, 'data-comic-title')).toBe('issue-1b.cbz');
    // The same render twice yields the same hint (no client or clock input).
    const again = linksWith((await details(alpha.id, rows.cbz.id)).text, COMIC_TRIGGER)[0];
    expect(attr(again, 'data-comic-source-revision')).toBe(attr(trigger, 'data-comic-source-revision'));
  });

  it('an image keeps its own viewer trigger and a video its own player; neither gets a comic link', async () => {
    const { alpha, rows, details } = fixture();
    const image = (await details(alpha.id, rows.image.id)).text;
    expect(mediaHost(image)).toContain('data-asset-details-viewer-trigger');
    expect(image).not.toContain(COMIC_TRIGGER);
    const video = (await details(alpha.id, rows.video.id)).text;
    expect(mediaHost(video)).toContain('data-asset-video');
    expect(video).not.toContain(COMIC_TRIGGER);
    expect(video).not.toContain('data-asset-details-viewer-trigger');
  });

  it('keeps Read Comic and the page actions in an archived (read-only) project', async () => {
    const { alpha, rows, details } = fixture();
    db.prepare('UPDATE projects SET status = \'archived\', archived_at = datetime(\'now\') WHERE id = ?').run(alpha.id);
    const html = (await details(alpha.id, rows.cbz.id)).text;
    expect(linksWith(html, COMIC_TRIGGER)).toHaveLength(2);
    expect(html).toContain('id="asset-preview-heading"');
  });
});
