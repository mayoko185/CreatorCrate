/**
 * Phase 10.4B — desktop application-shell tests.
 *
 * Verifies the persistent collapsed sidebar and its pure-CSS expansion:
 *  - semantic shell landmarks (app-shell / aside / app-main / header / main);
 *  - skip link present, first focusable, targets #main-content;
 *  - primary navigation label;
 *  - collapsed sidebar structure;
 *  - hover expansion CSS (:hover) and keyboard expansion (:focus-within);
 *  - labels become visible on expansion;
 *  - accessible link names retained when collapsed (no display:none,
 *    visibility:hidden, aria-hidden, or duplicate aria-label);
 *  - exactly one active item, marked with aria-current;
 *  - active item distinguished structurally (accent bar), not color alone;
 *  - no duplicate page <h1>;
 *  - the no-overflow layout guarantee (fixed rail + reserved collapsed column);
 *  - reduced-motion rules cover shell transitions;
 *  - no JavaScript is required for navigation/sidebar behavior.
 *
 * CSS is asserted against the real served <style> block (extracted from the
 * rendered HTML), not the source, so these tests fail if the served output
 * regresses. Viewport pixel measurement is performed separately via Playwright
 * and reported; the invariant here is the CSS structure that guarantees it.
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
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { createAssetRepository } from '../src/data/asset-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

/** Extract the contents of the first served <style>...</style> block. */
function extractStyle(html) {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
}

/** Count active desktop nav links only (scoped to class="app-nav-link"). */
function countActive(html) {
  return (html.match(/class="app-nav-link" data-nav-key="[^"]+" aria-current="page"/g) || []).length;
}

/** hrefs of every rendered nav link, in document order. */
function navHrefs(html) {
  const re = /<a href="([^"]+)" class="app-nav-link"/g;
  const hrefs = [];
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

/** Keys of the desktop nav items marked active, in document order. */
function activeNavKeys(html) {
  const re = /class="app-nav-link" data-nav-key="([^"]+)" aria-current="page"/g;
  const keys = [];
  let m;
  while ((m = re.exec(html)) !== null) keys.push(m[1]);
  return keys;
}

/** Count opening <h1> tags. */
function countH1(html) {
  return (html.match(/<h1[\s>]/g) || []).length;
}

/** Count opening <main> tags. */
function countMain(html) {
  return (html.match(/<main[\s>]/g) || []).length;
}

describe('application shell (Phase 10.4B) — landmarks & structure', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let projectId;
  let assetId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shell-desktop-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: APP_NAME, db, projectsRoot });

    const projRes = await request(app)
      .post('/projects')
      .send('title=Desktop+Shell+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    projectId = projRes.headers.location.replace('/projects/', '');

    const slug = slugify('Desktop Shell Project', { lowercase: true });
    const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
    const dirName = entries.find((e) => e.endsWith(`-${slug}`));
    fs.writeFileSync(
      path.join(projectsRoot, 'tbd', dirName, 'cover.png'),
      Buffer.from('png'),
    );
    await request(app).post(`/projects/${projectId}/scan`).expect(302);
    const assetRepo = createAssetRepository(db);
    assetId = String(assetRepo.findByProjectId(Number(projectId))[0].id);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('semantic shell regions', () => {
    it('renders the app-shell wrapper with sidebar + main columns', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('class="app-shell"');
      expect(res.text).toContain('<aside class="app-sidebar">');
      expect(res.text).toContain('class="app-main"');
    });

    it('renders exactly one <main> with id main-content', async () => {
      const res = await request(app).get('/').expect(200);
      expect(countMain(res.text)).toBe(1);
      expect(res.text).toContain('<main id="main-content" tabindex="-1">');
    });

    it('renders a compact shell header inside the main column', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('<header class="app-header">');
      expect(res.text).toContain('class="app-section-title"');
    });

    it('the header section title reflects the active section, not a duplicate h1', async () => {
      const dash = await request(app).get('/').expect(200);
      // Dashboard active → section title is "Dashboard".
      expect(dash.text).toContain('class="app-section-title">Dashboard</p>');
      const proj = await request(app).get('/projects').expect(200);
      expect(proj.text).toContain('class="app-section-title">Projects</p>');
    });

    it('the header falls back to the app name when no section is active', async () => {
      // A 404 renders the error page with noActive → header shows the app name.
      const res = await request(app).get('/projects/999999').expect(404);
      expect(res.text).toContain(`class="app-section-title">${APP_NAME}</p>`);
    });

    it('does not wrap page content in nested <main> elements on any page', async () => {
      for (const url of ['/', '/projects', `/projects/${projectId}`, '/releases']) {
        const res = await request(app).get(url);
        expect(countMain(res.text)).toBe(1);
      }
    });
  });

  describe('skip link', () => {
    it('renders a skip link targeting #main-content', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('class="skip-link" href="#main-content"');
    });

    it('the skip link precedes the sidebar (first focusable element)', async () => {
      const res = await request(app).get('/').expect(200);
      const skipPos = res.text.indexOf('class="skip-link"');
      const asidePos = res.text.indexOf('<aside class="app-sidebar">');
      expect(skipPos).toBeGreaterThan(-1);
      expect(skipPos).toBeLessThan(asidePos);
    });
  });

  describe('primary navigation label', () => {
    it('labels the nav landmark as Primary', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('<nav class="app-nav" aria-label="Primary">');
    });
  });

  describe('collapsed sidebar state', () => {
    it('renders the sidebar with the persistent rail class', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('<aside class="app-sidebar">');
    });

    it('renders all three destinations', async () => {
      const res = await request(app).get('/').expect(200);
      expect(navHrefs(res.text)).toEqual(['/', '/projects', '/releases']);
    });

    it('renders a decorative icon + label span for every nav link', async () => {
      const res = await request(app).get('/').expect(200);
      // Each link carries an aria-hidden svg and a non-hidden label span.
      expect((res.text.match(/class="app-nav-label"/g) || []).length).toBe(3);
      expect((res.text.match(/class="app-nav-link" data-nav-key="[^"]+"/g) || []).length).toBe(3);
    });
  });

  describe('hover expansion CSS', () => {
    it('defines :hover expansion to the expanded width', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      expect(css).toMatch(/\.app-sidebar:hover\b/);
      expect(css).toMatch(/\.app-sidebar:hover[\s\S]*?width:\s*var\(--shell-sidebar-expanded\)/);
    });

    it('labels become visible on hover', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      expect(css).toMatch(/\.app-sidebar:hover \.app-nav-label[\s\S]*?opacity:\s*1/);
      expect(css).toMatch(/\.app-sidebar:hover \.app-nav-label[\s\S]*?width:\s*auto/);
    });
  });

  describe(':focus-within keyboard expansion CSS', () => {
    it('defines :focus-within expansion to the expanded width', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      expect(css).toMatch(/\.app-sidebar:focus-within\b/);
      expect(css).toMatch(/\.app-sidebar:focus-within[\s\S]*?width:\s*var\(--shell-sidebar-expanded\)/);
    });

    it('labels become visible on keyboard focus', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      expect(css).toMatch(/\.app-sidebar:focus-within \.app-nav-label[\s\S]*?opacity:\s*1/);
      expect(css).toMatch(/\.app-sidebar:focus-within \.app-nav-label[\s\S]*?width:\s*auto/);
    });

    it('collapsed labels are clipped, not removed from the a11y tree', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      const labelBlock = css.match(/\.app-nav-label\s*\{[^}]*\}/);
      expect(labelBlock).not.toBeNull();
      const rule = labelBlock[0];
      // Retained in the a11y tree: never display:none / visibility:hidden.
      expect(rule).not.toMatch(/display:\s*none/);
      expect(rule).not.toMatch(/visibility:\s*hidden/);
      // Clipped visually instead.
      expect(rule).toMatch(/opacity:\s*0/);
      expect(rule).toMatch(/overflow:\s*hidden/);
    });

    it('nav links expose strong focus-visible styling', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      expect(css).toMatch(/\.app-nav-link:focus-visible/);
      expect(css).toMatch(/\.app-nav-link:focus-visible[\s\S]*?outline/);
    });

    it('the skip link becomes visible only on focus', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      expect(css).toMatch(/\.skip-link\s*\{[\s\S]*?transform:\s*translateY\(/);
      expect(css).toMatch(/\.skip-link:focus[\s\S]*?translateY\(0\)/);
    });
  });

  describe('accessible link names when collapsed', () => {
    it('no nav link carries an aria-label (avoids duplicate accessible names)', async () => {
      const res = await request(app).get('/').expect(200);
      // Extract each nav anchor and assert it has no aria-label.
      const links = res.text.match(/<a href="[^"]+" class="app-nav-link"[^>]*>/g) || [];
      expect(links.length).toBe(3);
      for (const anchor of links) {
        expect(anchor).not.toMatch(/aria-label=/);
      }
    });

    it('label spans are never hidden from assistive tech via attributes', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).not.toMatch(/<span class="app-nav-label"[^>]*aria-hidden/);
      expect(res.text).not.toMatch(/<span class="app-nav-label"[^>]*hidden/);
    });

    it('each label span carries the destination text', async () => {
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('class="app-nav-label">Dashboard</span>');
      expect(res.text).toContain('class="app-nav-label">Projects</span>');
      expect(res.text).toContain('class="app-nav-label">Releases</span>');
    });

    it('icons inside links are decorative (aria-hidden) so the name is the label', async () => {
      const res = await request(app).get('/').expect(200);
      // Every svg inside a nav link is aria-hidden="true".
      const navBlock = res.text.match(
        /<nav class="app-nav"[\s\S]*?<\/nav>/,
      );
      expect(navBlock).not.toBeNull();
      const svgCount = (navBlock[0].match(/<svg/g) || []).length;
      const hiddenCount = (navBlock[0].match(/aria-hidden="true"/g) || []).length;
      expect(svgCount).toBe(3);
      expect(svgCount).toBe(hiddenCount);
    });
  });

  describe('active-state treatment', () => {
    it('marks exactly one item active on representative pages', async () => {
      const pages = [
        '/',
        '/projects',
        `/projects/${projectId}`,
        `/projects/${projectId}/assets`,
        `/projects/${projectId}/assets/${assetId}`,
        '/releases',
      ];
      for (const url of pages) {
        const res = await request(app).get(url).expect(200);
        expect(countActive(res.text)).toBe(1);
      }
    });

    it('the active item carries aria-current="page"', async () => {
      const res = await request(app).get('/projects').expect(200);
      expect(activeNavKeys(res.text)).toEqual(['projects']);
    });

    it('inactive items never carry aria-current', async () => {
      const res = await request(app).get('/').expect(200);
      expect(countActive(res.text)).toBe(1);
    });

    it('the active state is structural (accent bar), not color alone', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      // A ::before pseudo-element on the active link provides a non-color cue.
      expect(css).toMatch(/\.app-nav-link\[aria-current="page"\]::before/);
      const beforeBlock = css.match(
        /\.app-nav-link\[aria-current="page"\]::before\s*\{[\s\S]*?\}/,
      );
      expect(beforeBlock).not.toBeNull();
      expect(beforeBlock[0]).toMatch(/content:\s*""/);
      expect(beforeBlock[0]).toMatch(/width:\s*[0-9]+px/);
    });
  });

  describe('heading invariant', () => {
    it('no page renders more than one <h1>', async () => {
      for (const url of [
        '/',
        '/projects',
        `/projects/${projectId}`,
        `/projects/${projectId}/assets`,
        `/projects/${projectId}/assets/${assetId}`,
        '/releases',
      ]) {
        const res = await request(app).get(url);
        expect(countH1(res.text)).toBe(1);
      }
    });
  });

  describe('no-overflow layout guarantee', () => {
    it('the sidebar is position:fixed so its growth never enters the flow', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      const sidebarRule = css.match(/\.app-sidebar\s*\{[\s\S]*?\}/);
      expect(sidebarRule).not.toBeNull();
      expect(sidebarRule[0]).toMatch(/position:\s*fixed/);
      expect(sidebarRule[0]).toMatch(/width:\s*var\(--shell-sidebar-collapsed\)/);
    });

    it('the main column reserves only the collapsed width', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      const mainRule = css.match(/\.app-main\s*\{[\s\S]*?\}/);
      expect(mainRule).not.toBeNull();
      expect(mainRule[0]).toMatch(/margin-left:\s*var\(--shell-sidebar-collapsed\)/);
      expect(mainRule[0]).toMatch(/min-width:\s*0/);
    });

    it('the expanded width is larger than the collapsed width', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      expect(css).toMatch(/--shell-sidebar-collapsed:\s*(\d+)px/);
      expect(css).toMatch(/--shell-sidebar-expanded:\s*(\d+)px/);
      const collapsed = Number(css.match(/--shell-sidebar-collapsed:\s*(\d+)px/)[1]);
      const expanded = Number(css.match(/--shell-sidebar-expanded:\s*(\d+)px/)[1]);
      expect(expanded).toBeGreaterThan(collapsed);
    });

    it('the expanded sidebar overlays with a higher z-index than the header', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      // Sidebar z-index must be >= header so the overlay sits on top.
      const sb = css.match(/\.app-sidebar\s*\{[\s\S]*?z-index:\s*var\((--shell-z-sidebar)\)/);
      const hd = css.match(/\.app-header\s*\{[\s\S]*?z-index:\s*var\((--shell-z-header)\)/);
      expect(sb).not.toBeNull();
      expect(hd).not.toBeNull();
      const sidebarVal = Number(css.match(new RegExp(`${sb[1]}:\\s*(\\d+)`))[1]);
      const headerVal = Number(css.match(new RegExp(`${hd[1]}:\\s*(\\d+)`))[1]);
      expect(sidebarVal).toBeGreaterThan(headerVal);
    });
  });

  describe('reduced motion', () => {
    it('reduced-motion rules cover the shell width/label transitions', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\s*\}/);
      expect(reduced).not.toBeNull();
      const block = reduced[1];
      // Width + label transitions must be disabled.
      expect(block).toMatch(/\.app-sidebar\b/);
      expect(block).toMatch(/\.app-sidebar-brand\b/);
      expect(block).toMatch(/\.app-nav-label\b/);
      expect(block).toMatch(/\.skip-link\b/);
      expect(block).toMatch(/transition:\s*none !important/);
    });
  });

  describe('no JavaScript required', () => {
    it('no inline event handlers are attached to shell nav elements', async () => {
      const res = await request(app).get('/').expect(200);
      const navBlock = res.text.match(/<aside class="app-sidebar"[\s\S]*?<\/aside>/);
      expect(navBlock).not.toBeNull();
      // No mouse/focus/keyboard inline handlers driving expansion.
      expect(navBlock[0]).not.toMatch(/\son(mouse|focus|blur|key|click|enter|leave)/i);
    });

    it('expansion is expressed purely through CSS pseudo-classes', async () => {
      const css = extractStyle((await request(app).get('/').expect(200)).text);
      // The expansion triggers are :hover and :focus-within — not scripted.
      expect(css).toMatch(/\.app-sidebar:hover/);
      expect(css).toMatch(/\.app-sidebar:focus-within/);
    });
  });
});
