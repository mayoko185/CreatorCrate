/**
 * Phase 10.6A — keyboard, focus, and interaction-state hardening tests.
 *
 * Covers the contracts that are central to keyboard-only and reduced-motion
 * use but are not exhaustively asserted elsewhere:
 *  - no positive tabindex anywhere on representative pages;
 *  - no focusable control hidden behind [hidden] or off-screen (except the
 *    skip link, which is intentionally off-screen until focused);
 *  - skip link is the first focus target and main carries tabindex="-1";
 *  - every shared interactive pattern exposes a :focus-visible rule;
 *  - scrollable wrappers use :focus-visible (not bare :focus), so a mouse
 *    click inside a scroll region does not leave a persistent ring;
 *  - reduced-motion media query covers summary-card hover transitions;
 *  - form validation errors associate fields with aria-invalid and
 *    aria-describedby, and preserve submitted values;
 *  - asset viewer actions follow a logical DOM/focus order.
 *
 * CSS assertions extract the real served <style> block, matching the pattern
 * used by shell-desktop / shell-mobile / page-components.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';
const STYLESHEET_PATH = fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url));
const SERVED_CSS = fs.readFileSync(STYLESHEET_PATH, 'utf8');

/** Return the served local stylesheet linked by the rendered page. */
function extractStyle(html) {
  expect(html).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
  return SERVED_CSS;
}

/** Match a positive tabindex value (1, 2, 3, ...). Excludes 0 and -1. */
function positiveTabindexMatches(html) {
  return html.match(/tabindex="([1-9]\d*)"/g) || [];
}

/**
 * Collect hidden regions that still contain active interactive descendants.
 * Inert regions, disabled form controls, and hidden CreatorCrate dropdown
 * replicas are intentionally excluded because none expose those descendants to
 * the keyboard/accessibility surface; the paired native select remains visible.
 */
function hiddenFocusableOffenders(html) {
  const offenders = [];
  const hiddenRe = /<(\w+)([^>]*)\bhidden\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = hiddenRe.exec(html)) !== null) {
    const regionAttributes = `${m[2]} ${m[3]}`;
    if (/\binert(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i.test(regionAttributes)) continue;
    if (/\bdata-cc-dropdown\b/i.test(regionAttributes)) continue;
    const inner = m[4];
    const interactive = [...inner.matchAll(/<(?:a|button|input|select|textarea)\b([^>]*)>/gi)]
      .some(([, attributes]) => !/\bdisabled(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i.test(attributes));
    const tabindexed = inner.match(/tabindex="0"/i);
    if (interactive || tabindexed) {
      offenders.push(m[0].slice(0, 80));
    }
  }
  return offenders;
}

/** Ordered list of [class, href] for every <a> in the HTML. */
function anchorSequence(html) {
  const re = /<a\s+[^>]*>/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const cls = (tag.match(/class="([^"]*)"/) || [, ''])[1];
    const href = (tag.match(/href="([^"]*)"/) || [, ''])[1];
    out.push({ cls, href });
  }
  return out;
}

describe('Phase 10.6A: keyboard and focus-state hardening', () => {
  let db;
  let app;
  let agent;
  let csrfToken;
  let tmpDir;
  let projectsRoot;
  let projectId;
  let assetIds;
  let releaseLocation;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-kbd-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: APP_NAME, db, projectsRoot }, { authConfig: AUTH_CONFIG });

    const auth = await authenticate(app);
    agent = auth.agent;
    csrfToken = auth.csrfToken;

    const projRes = await agent
      .post('/projects')
      .type('form')
      .send({ title: 'Keyboard Test Project', status: 'tbd', priority: 'normal', _csrf: csrfToken })
      .expect(302);
    projectId = projRes.headers.location.replace('/projects/', '');

    // Two scanned assets so the viewer exercises Previous/Next ordering.
    const slug = slugify('Keyboard Test Project', { lowercase: true });
    const entries = fs.readdirSync(projectsRoot);
    const dirName = entries.find((e) => e.endsWith(`-${slug}`));
    const projectDir = path.join(projectsRoot, dirName);
    fs.writeFileSync(path.join(projectDir, 'alpha.png'), Buffer.from('png'));
    fs.writeFileSync(path.join(projectDir, 'beta.png'), Buffer.from('png2'));
    await agent.post(`/projects/${projectId}/scan`).type('form').send({ _csrf: csrfToken }).expect(302);
    const assetRepo = createAssetRepository(db);
    assetIds = assetRepo
      .findByProjectId(Number(projectId))
      .map((a) => String(a.id));

    const relRes = await agent
      .post('/releases')
      .type('form')
      .send({ projectId, title: 'Keyboard Test Release', status: 'tbd', _csrf: csrfToken })
      .expect(302);
    releaseLocation = relRes.headers.location;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── §1: Focus order — no positive tabindex ──────────────────────────
  describe('focus order', () => {
    it('uses no positive tabindex on any representative page', async () => {
      const pages = [
        '/',
        '/projects',
        '/projects/new',
        `/projects/${projectId}`,
        `/projects/${projectId}/edit`,
        `/projects/${projectId}/asset-categories`,
        `/projects/${projectId}/assets`,
        `/projects/${projectId}/assets/${assetIds[1]}`,
        '/releases',
        '/calendar',
        '/releases',
        '/releases/new',
        releaseLocation,
        `${releaseLocation}/edit`,
        `${releaseLocation}/assets`,
        `${releaseLocation}/publish`,
      ];
      for (const url of pages) {
        const res = await agent.get(url);
        const offenders = positiveTabindexMatches(res.text);
        expect(offenders, `${url}: ${offenders.join(', ')}`).toEqual([]);
      }
    });

    it('scrollable regions carry tabindex="0" and a name (not positive)', async () => {
      const res = await agent.get('/releases').expect(200);
      // The release list table is an intrinsically wide scroll region.
      expect(res.text).toMatch(
        /<div class="table-scroll" tabindex="0" aria-label="Release list">/,
      );
      // No positive tabindex on that wrapper.
      expect(res.text).not.toMatch(/tabindex="[1-9]\d*"/);
    });
  });

  // ─– §2: No hidden focusable controls ────────────────────────────────
  describe('no hidden focusable controls', () => {
    it('no [hidden] element contains an interactive descendant', async () => {
      const pages = [
        '/',
        `/projects/${projectId}/assets`,
        `/projects/${projectId}/assets/${assetIds[0]}`,
        `/projects/${projectId}/asset-categories`,
      ];
      for (const url of pages) {
        const res = await agent.get(url).expect(200);
        const offenders = hiddenFocusableOffenders(res.text);
        expect(offenders, `${url}: ${offenders.join(' | ')}`).toEqual([]);
      }
    });
  });

  // ── §3: Skip-link target and main focus contract ────────────────────
  describe('skip-link and main target', () => {
    it('main carries tabindex="-1" (programmatic focus target)', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('<main id="main-content" tabindex="-1">');
    });

    it('the skip link is the first anchor in the document', async () => {
      const res = await agent.get('/').expect(200);
      const links = anchorSequence(res.text);
      expect(links.length).toBeGreaterThan(0);
      expect(links[0].cls).toContain('skip-link');
      expect(links[0].href).toBe('#main-content');
    });

    it('there is exactly one element with id main-content', async () => {
      const res = await agent.get('/').expect(200);
      const count = (res.text.match(/id="main-content"/g) || []).length;
      expect(count).toBe(1);
    });
  });

  // ── §4: Focus-visible contract for all shared actions ───────────────
  describe('focus-visible selectors for shared actions', () => {
    let css;

    beforeEach(async () => {
      css = extractStyle((await agent.get('/').expect(200)).text);
    });

    // Selectors that MUST carry a :focus-visible rule somewhere in the CSS.
    // Some are grouped (e.g. ".field input, .field textarea, .field select"),
    // so we check for the selector fragment + ":focus-visible" presence.
    const sharedActions = [
      '.button',
      '.app-nav-link',
      '.mobile-nav-link',
      '.mobile-nav-summary',
      '.view-switcher-option',
      '.pagination-prev',
      '.pagination-next',
      '.asset-filter-multiselect summary',
      '.asset-file-link',
      '.summary-card',
      '.field input',
      '.table-scroll',
      '.calendar-scroll',
    ];

    for (const selector of sharedActions) {
      it(`${selector} has a :focus-visible rule`, () => {
        // Match the selector fragment (e.g. ".button") followed by ":focus-visible"
        // somewhere in the CSS. This works for both standalone and grouped rules.
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped + ':focus-visible');
        expect(css).toMatch(re);
      });
    }
  });

  // ── §7: Scroll-region focus contract ────────────────────────────────
  describe('scroll-region focus contract', () => {
    let css;

    beforeEach(async () => {
      css = extractStyle((await agent.get('/').expect(200)).text);
    });

    const wrappers = ['.table-scroll', '.calendar-scroll'];

    for (const wrapper of wrappers) {
      it(`${wrapper} uses :focus-visible`, () => {
        const sel = wrapper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(css).toMatch(new RegExp(`${sel}:focus-visible\\s*\\{`));
      });

      it(`${wrapper} does NOT use bare :focus (avoids mouse-click ring)`, () => {
        const sel = wrapper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Matches ".table-scroll:focus {" but NOT ".table-scroll:focus-visible {"
        // because the latter has "-visible" between ":focus" and the brace.
        expect(css).not.toMatch(new RegExp(`${sel}:focus\\s*\\{`));
      });
    }
  });

  // ── §9: Reduced-motion coverage ─────────────────────────────────────
  describe('reduced-motion coverage', () => {
    let reduced;

    beforeEach(async () => {
      const css = extractStyle((await agent.get('/').expect(200)).text);
      const m = css.match(
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\s*\}/,
      );
      reduced = m ? m[1] : '';
    });

    it('the reduced-motion block exists', () => {
      expect(reduced.length).toBeGreaterThan(0);
    });

    it('covers summary-card hover transitions', () => {
      expect(reduced).toMatch(/\.summary-card\b/);
    });

    it('covers all previously-listed elements (no regression)', () => {
      for (const sel of [
        '.app-sidebar',
        '.app-nav-label',
        '.skip-link',
        '.button',
        '.view-switcher-option',
        '.mobile-nav-link',
      ]) {
        expect(reduced).toMatch(
          new RegExp(sel.replace(/\./g, '\\.')),
        );
      }
      expect(reduced).toMatch(/transition:\s*none !important/);
    });
  });

  // ── §6: Form label/error associations ───────────────────────────────
  describe('form label and error associations', () => {
    it('invalid fields get aria-invalid and aria-describedby on re-render', async () => {
      const res = await agent
        .post('/projects')
        .type('form')
        .send({ title: '', status: 'invalid', priority: 'normal', _csrf: csrfToken })
        .expect(422);

      const html = res.text;
      // The title field is required and was empty.
      expect(html).toMatch(/id="title"[^>]*aria-invalid="true"/);
      expect(html).toMatch(/id="title"[^>]*aria-describedby="title-error"/);
      // The matching error message element exists.
      expect(html).toMatch(/id="title-error"/);
      expect(html).toContain('field-error-message');
    });

    it('submitted values are preserved on validation failure', async () => {
      const res = await agent
        .post('/projects')
        .type('form')
        .send({ title: 'Preserved Title', status: 'invalid', priority: 'normal', _csrf: csrfToken })
        .expect(422);

      // The title the user typed must survive the round-trip.
      expect(res.text).toMatch(
        /id="title"\s+name="title"\s+value="Preserved Title"/,
      );
    });

    it('every visible label has a matching control id', async () => {
      const res = await agent.get('/projects/new').expect(200);
      const labels = res.text.match(/<label[^>]*for="([^"]+)"[^>]*>/g) || [];
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        const forId = label.match(/for="([^"]+)"/)[1];
        expect(res.text).toMatch(new RegExp(`id="${forId}"`));
      }
    });
  });

  // ── §8: Viewer focus order ──────────────────────────────────────────
  describe('asset viewer focus order', () => {
    it('breadcrumb links precede heading-action links in DOM order', async () => {
      // Visit the second asset so a "Previous" action is present.
      const res = await agent.get(`/projects/${projectId}/assets/${assetIds[1]}`)
        .expect(200);

      const seq = anchorSequence(res.text);
      const breadcrumbIdx = seq.findIndex((a) =>
        a.cls.includes('asset-viewer-back'),
      );
      const prevIdx = seq.findIndex((a) => a.cls.includes('asset-viewer-prev'));

      expect(breadcrumbIdx).toBeGreaterThan(-1);
      // If a Previous action rendered, it must come after the breadcrumb.
      if (prevIdx !== -1) {
        expect(prevIdx).toBeGreaterThan(breadcrumbIdx);
      }
    });

    it('breadcrumb project link precedes the back link', async () => {
      const res = await agent.get(`/projects/${projectId}/assets/${assetIds[0]}`)
        .expect(200);

      const seq = anchorSequence(res.text);
      const projectIdx = seq.findIndex((a) =>
        a.cls.includes('asset-viewer-project'),
      );
      const backIdx = seq.findIndex((a) =>
        a.cls.includes('asset-viewer-back'),
      );
      expect(projectIdx).toBeGreaterThan(-1);
      expect(backIdx).toBeGreaterThan(-1);
      expect(projectIdx).toBeLessThan(backIdx);
    });

    it('unavailable viewer actions are absent (not fake-disabled links)', async () => {
      // The first asset has no Previous; the link must be omitted entirely.
      const res = await agent.get(`/projects/${projectId}/assets/${assetIds[0]}`)
        .expect(200);
      expect(res.text).not.toMatch(/class="[^"]*asset-viewer-prev"/);
    });
  });

  // ── §4/§5: Sidebar and mobile-nav keyboard behavior (CSS contracts) ─
  describe('sidebar keyboard expansion', () => {
    it('sidebar expands on :focus-within with an accessible focus ring', async () => {
      const css = extractStyle((await agent.get('/').expect(200)).text);
      expect(css).toMatch(
        /\.app-sidebar:focus-within[\s\S]*?width:\s*var\(--shell-sidebar-expanded\)/,
      );
      expect(css).toMatch(/\.app-nav-link:focus-visible[\s\S]*?outline/);
    });

    it('no inline keyboard/focus handlers drive sidebar expansion', async () => {
      const res = await agent.get('/').expect(200);
      const aside = res.text.match(
        /<aside class="app-sidebar"[\s\S]*?<\/aside>/,
      );
      expect(aside).not.toBeNull();
      expect(aside[0]).not.toMatch(
        /\son(mouse|focus|blur|key|click|enter|leave)/i,
      );
    });
  });
});
