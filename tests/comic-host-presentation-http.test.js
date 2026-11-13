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

// Read Comic presentation on Project Assets and the Global Asset Library,
// rendered by the real routes from indexed rows (no archive is opened: the
// rows below have no file on disk at all). Only a present comic with an
// indexed-source revision gets a host-scoped Read Comic link; it keeps the
// details href, never joins the image slideshow sequence, and carries the
// project-qualified identity plus the server's indexed revision hint.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const COMIC_MIME = {
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  cb7: 'application/x-cb7',
};

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

// Every <a ...> start tag carrying `attribute`.
function linksWith(html, attribute) {
  return [...html.matchAll(/<a\s[^>]*>/g)].map((match) => match[0]).filter((tag) => tag.includes(attribute));
}

function attr(tag, name) {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
}

function sequenceOf(html, attribute) {
  const script = html.match(new RegExp(`<script[^>]*${attribute}[^>]*>([\\s\\S]*?)</script>`));
  return JSON.parse(script[1]);
}

// The card (grid <article> or list <article>) of one asset id.
function cardOf(html, assetId) {
  const cards = [...html.matchAll(/<article class="asset-(?:list-)?card[\s\S]*?<\/article>/g)].map((match) => match[0]);
  return cards.find((card) => card.includes(`data-asset-id="${assetId}"`)) ?? null;
}

describe('Read Comic presentation on Project Assets and the Asset Library', () => {
  let db;
  let app;
  let tmpDir;
  let projectRepository;
  let assetRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-comic-host-presentation-'));
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
      // Same filename in another project.
      betaCbz: addAsset(beta.id, 'issue-1.cbz', 'cbz'),
    };
    db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(rows.missing.id);
    // A row whose scan metadata cannot anchor a revision: the comic service
    // refuses it, so no reader may be offered.
    db.prepare('UPDATE assets SET modified_at = \'\' WHERE id = ?').run(rows.unanchored.id);
    const fresh = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    return { alpha, beta, rows, fresh };
  }

  it('escapes the exact Unicode filename at both shared descriptor boundaries', async () => {
    const { alpha } = fixture();
    const row = addAsset(alpha.id, '巻 01 café & "final".cbz', 'cbz');
    for (const [url, attribute] of [
      ['/projects/' + alpha.id + '/assets?pageSize=all', 'data-project-assets-comic-trigger'],
      ['/asset-viewer?pageSize=all', 'data-asset-library-comic-trigger'],
    ]) {
      const { text } = await request(app).get(url).expect(200);
      const trigger = linksWith(text, attribute).find((tag) => attr(tag, 'data-comic-asset') === String(row.id));
      expect(attr(trigger, 'data-comic-filename')).toBe('巻 01 café &amp; &quot;final&quot;.cbz');
      if (attribute === 'data-project-assets-comic-trigger') {
        expect(attr(trigger, 'data-comic-filename')).not.toBe(attr(trigger, 'data-comic-title'));
      }
    }
  });

  describe.each(['grid', 'list'])('Project Assets %s', (view) => {
    it('offers Read Comic for present CBZ, CBR and CB7 comics with project-qualified identity and the indexed hint', async () => {
      const { alpha, rows, fresh } = fixture();
      const response = await request(app).get(`/projects/${alpha.id}/assets?view=${view}&pageSize=all`);
      expect(response.status).toBe(200);
      const html = response.text;
      const allTriggers = linksWith(html, 'data-project-assets-comic-trigger');
      expect(allTriggers).toHaveLength(6);
      const triggers = allTriggers.filter((tag) => !tag.includes('data-preview-fallback'));
      expect(triggers).toHaveLength(3);
      for (const [key, format] of [['cbz', 'CBZ'], ['cbr', 'CBR'], ['cb7', 'CB7']]) {
        const row = fresh(rows[key].id);
        const trigger = triggers.find((tag) => attr(tag, 'data-comic-asset') === String(row.id));
        expect(trigger, key).toBeTruthy();
        expect(attr(trigger, 'data-comic-project')).toBe(String(alpha.id));
        expect(attr(trigger, 'data-comic-source-revision')).toBe(buildAssetRevisionToken(row));
        expect(attr(trigger, 'data-comic-label')).toBe('Alpha Comics');
        expect(attr(trigger, 'data-comic-title')).toBe(row.filename.replace(/\.[^.]+$/, ''));
        expect(attr(trigger, 'data-comic-filename')).toBe(row.filename);
        expect(attr(trigger, 'data-comic-project-name')).toBe(alpha.title);
        expect(attr(trigger, 'data-comic-details-url')).toBe(attr(trigger, 'href'));
        // A real details href, so modified clicks and no-JS navigate.
        expect(attr(trigger, 'href')).toMatch(new RegExp(`^/projects/${alpha.id}/assets/${row.id}(\\?|$)`));
        expect(attr(trigger, 'aria-label')).toMatch(/^Read comic /);
        // Covers share native image media while activation remains Reader-only.
        expect(trigger).not.toContain('data-project-assets-preview-id');
        const card = cardOf(html, row.id);
        expect(card).toContain(format);
        expect(card).not.toContain('data-comic-thumbnail=');
        expect(card).not.toContain('asset-comic-thumbnail');
        expect(card).not.toContain(`${format} comic`);
        expect(card).toContain('data-preview-enhancement');
        expect(card).toContain('data-preview-image');
        expect(card).toMatch(new RegExp(`<img[^>]+src="/projects/${alpha.id}/assets/${row.id}/preview\\?v=[a-f0-9]{16}"`));
        expect(card).toContain(view === 'grid' ? 'asset-card-thumb' : 'asset-list-card-media-image');
        expect(allTriggers.find((tag) => tag.includes('data-preview-fallback')
          && attr(tag, 'data-comic-asset') === String(row.id))).toContain('hidden');
        if (view === 'grid') expect(card).toContain('Read comic');
      }
      expect(html).not.toMatch(/\/comic["?]|\/comic\/pages/);
      expect(html).not.toContain('data-asset-library-comic-trigger');
    });

    it('keeps comics out of the image slideshow sequence and image triggers', async () => {
      const { alpha, rows } = fixture();
      const html = (await request(app).get(`/projects/${alpha.id}/assets?view=${view}&pageSize=all`)).text;
      expect(sequenceOf(html, 'data-project-assets-viewer-sequence').map((entry) => entry.id)).toEqual([rows.image.id]);
      const previewIds = linksWith(html, 'data-project-assets-preview-id').map((tag) => attr(tag, 'data-project-assets-preview-id'));
      expect(previewIds).toEqual([String(rows.image.id)]);
      // The video keeps its own preview trigger.
      expect(linksWith(html, 'data-asset-video-preview-trigger')).toHaveLength(1);
      expect(linksWith(html, 'data-asset-video-preview-trigger')[0]).not.toContain('data-comic-');
    });

    it('keeps the missing and unanchored comic placeholders without a reader trigger', async () => {
      const { alpha, rows } = fixture();
      const html = (await request(app).get(`/projects/${alpha.id}/assets?view=${view}&pageSize=all`)).text;
      const missing = cardOf(html, rows.missing.id);
      expect(missing).toContain('Missing at last scan');
      expect(missing).not.toContain('data-comic-');
      const unanchored = cardOf(html, rows.unanchored.id);
      expect(unanchored).toContain('preview not supported');
      expect(unanchored).not.toContain('data-comic-');
    });

    it('keeps Read Comic in an archived project, which stays read-only', async () => {
      const { alpha } = fixture();
      db.prepare('UPDATE projects SET status = \'archived\', archived_at = datetime(\'now\') WHERE id = ?').run(alpha.id);
      const html = (await request(app).get(`/projects/${alpha.id}/assets?view=${view}&pageSize=all`)).text;
      expect(linksWith(html, 'data-project-assets-comic-trigger')).toHaveLength(6);
      expect(html).not.toContain('name="selectedAssetIds"');
    });
  });

  describe.each(['grid', 'list'])('Global Asset Library %s', (view) => {
    it('qualifies every Read Comic link and card by project and asset across projects', async () => {
      const { alpha, beta, rows, fresh } = fixture();
      const html = (await request(app).get(`/asset-viewer?view=${view}&pageSize=all`).redirects(3)).text;
      const allTriggers = linksWith(html, 'data-asset-library-comic-trigger');
      expect(allTriggers).toHaveLength(8);
      const triggers = allTriggers.filter((tag) => !tag.includes('data-preview-fallback'));
      expect(triggers).toHaveLength(4);
      expect(html).not.toContain('data-project-assets-comic-trigger');
      const alphaIssue = triggers.find((tag) => attr(tag, 'data-comic-asset') === String(rows.cbz.id));
      const betaIssue = triggers.find((tag) => attr(tag, 'data-comic-asset') === String(rows.betaCbz.id));
      expect(attr(alphaIssue, 'data-comic-project')).toBe(String(alpha.id));
      expect(attr(betaIssue, 'data-comic-project')).toBe(String(beta.id));
      expect(attr(alphaIssue, 'data-comic-label')).toBe('Alpha Comics');
      expect(attr(betaIssue, 'data-comic-label')).toBe('Beta Comics');
      // Equal filenames, distinct identities and hints.
      expect(attr(alphaIssue, 'data-comic-filename')).toBe('issue-1.cbz');
      expect(attr(betaIssue, 'data-comic-filename')).toBe('issue-1.cbz');
      expect(attr(alphaIssue, 'data-comic-project-name')).toBe(alpha.title);
      expect(attr(betaIssue, 'data-comic-project-name')).toBe(beta.title);
      expect(attr(alphaIssue, 'data-comic-details-url')).toBe(attr(alphaIssue, 'href'));
      expect(attr(alphaIssue, 'data-comic-details-url')).toMatch(new RegExp(`^/projects/${alpha.id}/assets/${rows.cbz.id}(\\?|$)`));
      expect(attr(betaIssue, 'data-comic-details-url')).toBe(attr(betaIssue, 'href'));
      expect(attr(betaIssue, 'data-comic-details-url')).toMatch(new RegExp(`^/projects/${beta.id}/assets/${rows.betaCbz.id}(\\?|$)`));
      expect(attr(alphaIssue, 'data-comic-source-revision')).toBe(buildAssetRevisionToken(fresh(rows.cbz.id)));
      expect(attr(betaIssue, 'data-comic-source-revision')).toBe(buildAssetRevisionToken(fresh(rows.betaCbz.id)));
      expect(attr(alphaIssue, 'data-comic-source-revision')).not.toBe(attr(betaIssue, 'data-comic-source-revision'));
      expect(attr(betaIssue, 'href')).toMatch(new RegExp(`^/projects/${beta.id}/assets/${rows.betaCbz.id}(\\?|$)`));
      expect(attr(betaIssue, 'aria-label')).toBe('Read comic issue-1.cbz from Beta Comics');
      expect(cardOf(html, rows.betaCbz.id)).toContain(`data-asset-project-id="${beta.id}"`);
      expect(cardOf(html, rows.cbz.id)).toContain(`data-asset-project-id="${alpha.id}"`);
      for (const [project, row] of [[alpha, rows.cbz], [beta, rows.betaCbz]]) {
        const card = cardOf(html, row.id);
        expect(card).toContain('data-preview-enhancement data-preview-state="loading"');
        expect(card).toContain(`src="/projects/${project.id}/assets/${row.id}/preview?`);
        expect(card).toContain('loading="lazy"');
        expect(card).toContain('decoding="async"');
        expect(card).toContain('data-preview-image');
        expect(card).toContain('data-preview-fallback hidden');
        expect(card).not.toMatch(/data-comic-thumbnail|asset-comic-thumbnail|CBZ comic/);
      }
      for (const tag of triggers) expect(tag).not.toContain('data-asset-library-preview-id');
      expect(html).not.toMatch(/\/comic["?]|\/comic\/pages/);
    });

    it('keeps comics out of the cross-project image sequence and keeps ineligible placeholders', async () => {
      const { rows } = fixture();
      const html = (await request(app).get(`/asset-viewer?view=${view}&pageSize=all`).redirects(3)).text;
      expect(sequenceOf(html, 'data-asset-library-viewer-sequence').map((entry) => entry.id)).toEqual([rows.image.id]);
      expect(cardOf(html, rows.missing.id)).not.toContain('data-comic-');
      expect(cardOf(html, rows.unanchored.id)).not.toContain('data-comic-');
      expect(cardOf(html, rows.unanchored.id)).toMatch(/cbz — preview not supported|CBZ<span class="sr-only"> — preview not supported/);
    });
  });
});
