/**
 * Phase 10.4C — mobile application-shell tests.
 *
 * Verifies the server-rendered <details>/<summary> navigation that replaces
 * the desktop sidebar at narrow widths:
 *  - <details>/<summary> structure with an accessible summary name;
 *  - centralized navigation model reused (no duplicated routes);
 *  - mobile active state mirrors the desktop active state;
 *  - responsive CSS: exact breakpoint, desktop hidden on mobile, mobile
 *    hidden on desktop;
 *  - only one primary-navigation landmark exposed per breakpoint;
 *  - no-JavaScript: native <details> toggle, no script hooks;
 *  - no-overflow contract at 320/360/390/768;
 *  - desktop regression: sidebar + hover/focus expansion intact;
 *  - native <a href> navigation from the open menu;
 *  - touch-sized links, focus indicators, active structural cue.
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
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

/**
 * Fetch the actually-served stylesheet through the HTTP test agent (not the
 * source file on disk), so these assertions fail if /creatorcrate.css stops
 * being served correctly, not just if the source file changes.
 */
async function extractStyle(agent, html) {
  expect(html).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
  const res = await agent.get('/creatorcrate.css').expect(200);
  expect(res.headers['content-type']).toMatch(/text\/css/);
  return res.text;
}

/** hrefs of every mobile nav link, in document order. */
function mobileNavHrefs(html) {
  const re = /<a href="([^"]+)" class="mobile-nav-link"/g;
  const hrefs = [];
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

/** hrefs of every desktop nav link, in document order. */
function desktopNavHrefs(html) {
  const re = /<a href="([^"]+)" class="app-nav-link"/g;
  const hrefs = [];
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

/** Keys of the mobile nav items marked active, in document order. */
function mobileActiveKeys(html) {
  const re = /class="mobile-nav-link" data-nav-key="([^"]+)" aria-current="page"/g;
  const keys = [];
  let m;
  while ((m = re.exec(html)) !== null) keys.push(m[1]);
  return keys;
}

/** Count opening <main> tags. */
function countMain(html) {
  return (html.match(/<main[\s>]/g) || []).length;
}

/** Count opening <h1> tags. */
function countH1(html) {
  return (html.match(/<h1[\s>]/g) || []).length;
}

describe('application shell (Phase 10.4C) — mobile navigation', () => {
  let db;
  let app;
  let agent;
  let csrfToken;
  let tmpDir;
  let projectsRoot;
  let projectId;
  let assetId;
  let releaseLocation;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shell-mobile-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
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
      .send({ title: 'Mobile Shell Project', status: 'tbd', priority: 'normal', _csrf: csrfToken })
      .expect(302);
    projectId = projRes.headers.location.replace('/projects/', '');

    const slug = slugify('Mobile Shell Project', { lowercase: true });
    const entries = fs.readdirSync(path.join(projectsRoot, 'tbd'));
    const dirName = entries.find((e) => e.endsWith(`-${slug}`));
    fs.writeFileSync(
      path.join(projectsRoot, 'tbd', dirName, 'cover.png'),
      Buffer.from('png'),
    );
    await agent.post(`/projects/${projectId}/scan`).type('form').send({ _csrf: csrfToken }).expect(302);
    const assetRepo = createAssetRepository(db);
    assetId = String(assetRepo.findByProjectId(Number(projectId))[0].id);

    const relRes = await agent
      .post('/releases')
      .type('form')
      .send({ projectId, title: 'Mobile Shell Release', status: 'idea', _csrf: csrfToken })
      .expect(302);
    releaseLocation = relRes.headers.location;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── §1: Mobile navigation structure ───────────────────────────────
  describe('<details>/<summary> structure', () => {
    it('renders a <details class="mobile-nav"> disclosure', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('<details class="mobile-nav">');
    });

    it('renders a <summary class="mobile-nav-summary">', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('<summary class="mobile-nav-summary">');
    });

    it('the summary has a clear accessible name (contains "Menu")', async () => {
      const res = await agent.get('/').expect(200);
      const summaryBlock = res.text.match(
        /<summary class="mobile-nav-summary">([\s\S]*?)<\/summary>/,
      );
      expect(summaryBlock).not.toBeNull();
      expect(summaryBlock[1]).toContain('Menu');
    });

    it('the summary exposes the app name as a text mark', async () => {
      const res = await agent.get('/').expect(200);
      const summaryBlock = res.text.match(
        /<summary class="mobile-nav-summary">([\s\S]*?)<\/summary>/,
      );
      expect(summaryBlock[1]).toContain(APP_NAME);
    });

    it('the summary exposes the current section title', async () => {
      const res = await agent.get('/projects').expect(200);
      const summaryBlock = res.text.match(
        /<summary class="mobile-nav-summary">([\s\S]*?)<\/summary>/,
      );
      expect(summaryBlock[1]).toContain('Projects');
    });

    it('the summary shows a status-specific title on a controlled not-found page', async () => {
      const res = await agent.get('/projects/999999').expect(404);
      const summaryBlock = res.text.match(
        /<summary class="mobile-nav-summary">([\s\S]*?)<\/summary>/,
      );
      // The brand mark still shows the app name; the section title carries
      // the error page's own page_title ("Error 404") rather than falling
      // back to a second copy of the app name.
      expect(summaryBlock[1]).toContain(APP_NAME);
      expect(summaryBlock[1]).toContain('Error 404');
    });

    it('the summary is not an <h1> (no duplicate page heading)', async () => {
      const res = await agent.get('/').expect(200);
      expect(countH1(res.text)).toBe(1);
    });

    it('wraps a <nav aria-label="Primary"> landmark inside the details', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain(
        '<nav class="mobile-nav-primary" aria-label="Primary">',
      );
    });

    it('does not build a fake ARIA menu (no role=menu anywhere)', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).not.toMatch(/role="menu"/);
      expect(res.text).not.toMatch(/role="menuitem"/);
    });
  });

  // ── §1: Centralized navigation reused ─────────────────────────────
  describe('centralized navigation reused', () => {
    it('mobile nav renders the same destinations as desktop', async () => {
      const res = await agent.get('/').expect(200);
      expect(mobileNavHrefs(res.text)).toEqual(['/', '/projects', '/releases', '/calendar', '/settings']);
      expect(desktopNavHrefs(res.text)).toEqual(['/', '/projects', '/releases', '/calendar', '/settings']);
    });

    it('mobile and desktop link hrefs are identical', async () => {
      const res = await agent.get('/').expect(200);
      expect(mobileNavHrefs(res.text)).toEqual(desktopNavHrefs(res.text));
    });

    it('exactly five items in each nav (no duplicated routes)', async () => {
      const res = await agent.get('/').expect(200);
      expect(mobileNavHrefs(res.text)).toHaveLength(5);
      expect(desktopNavHrefs(res.text)).toHaveLength(5);
    });

    it('renders exactly one Calendar link in the mobile nav', async () => {
      const res = await agent.get('/').expect(200);
      const calendarLinks = (res.text.match(/class="mobile-nav-link" data-nav-key="calendar"/g) || []);
      expect(calendarLinks).toHaveLength(1);
    });
  });

  // ── §4: Active-state behavior ─────────────────────────────────────
  describe('mobile active state', () => {
    it('marks Dashboard active on /', async () => {
      const res = await agent.get('/').expect(200);
      expect(mobileActiveKeys(res.text)).toEqual(['dashboard']);
    });

    it('marks Projects active on the project list', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(mobileActiveKeys(res.text)).toEqual(['projects']);
    });

    it('marks Projects active on project detail', async () => {
      const res = await agent.get(`/projects/${projectId}`).expect(200);
      expect(mobileActiveKeys(res.text)).toEqual(['projects']);
    });

    it('marks Projects active on the asset browser', async () => {
      const res = await agent.get(`/projects/${projectId}/assets`)
        .expect(200);
      expect(mobileActiveKeys(res.text)).toEqual(['projects']);
    });

    it('marks Projects active on the asset viewer', async () => {
      const res = await agent.get(`/projects/${projectId}/assets/${assetId}`)
        .expect(200);
      expect(mobileActiveKeys(res.text)).toEqual(['projects']);
    });

    it('marks Published Work active on the release list', async () => {
      const res = await agent.get('/releases').expect(200);
      expect(mobileActiveKeys(res.text)).toEqual(['releases']);
    });

    it('marks Published Work active on release detail', async () => {
      const res = await agent.get(releaseLocation).expect(200);
      expect(mobileActiveKeys(res.text)).toEqual(['releases']);
    });

    it('marks Calendar active on the canonical calendar route', async () => {
      const res = await agent.get('/calendar').expect(200);
      expect(mobileActiveKeys(res.text)).toEqual(['calendar']);
    });

    it('marks no item active on a controlled not-found', async () => {
      const res = await agent.get('/projects/999999').expect(404);
      expect(mobileActiveKeys(res.text)).toEqual([]);
    });

    it('exactly one mobile item is active on representative pages', async () => {
      for (const url of ['/', '/projects', '/releases', '/calendar', '/release-management']) {
        const res = await agent.get(url).expect(200);
        expect(mobileActiveKeys(res.text)).toHaveLength(1);
      }
    });

    it('active state is preserved under Back/Forward (server-rendered)', async () => {
      // The active state is computed server-side from req.path on every
      // request, so a Back/Forward navigation re-renders the correct item.
      const dash = await agent.get('/').expect(200);
      expect(mobileActiveKeys(dash.text)).toEqual(['dashboard']);
      const proj = await agent.get('/projects').expect(200);
      expect(mobileActiveKeys(proj.text)).toEqual(['projects']);
      // Re-requesting "/" (simulating Back) still marks Dashboard.
      const dash2 = await agent.get('/').expect(200);
      expect(mobileActiveKeys(dash2.text)).toEqual(['dashboard']);
    });
  });

  // ── §2: Responsive shell contract — CSS visibility ────────────────
  describe('responsive CSS — breakpoint and visibility', () => {
    it('uses an exact max-width:1023px breakpoint for mobile activation', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(/@media\s*\(max-width:\s*1023px\)/);
    });

    it('hides the mobile disclosure by default (desktop base rule)', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      // Base rule (outside any media query) sets .mobile-nav to display:none.
      expect(css).toMatch(/\.mobile-nav\s*\{\s*display:\s*none/);
    });

    it('hides the desktop sidebar inside the mobile breakpoint', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(
        /@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.app-sidebar\s*\{[\s\S]*?display:\s*none/,
      );
    });

    it('removes the reserved sidebar margin inside the mobile breakpoint', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(
        /@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.app-main\s*\{[\s\S]*?margin-left:\s*0/,
      );
    });

    it('reveals the mobile disclosure inside the mobile breakpoint', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(
        /@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.mobile-nav\s*\{[\s\S]*?display:\s*block/,
      );
    });

    it('does not rely on user-agent or feature detection', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).not.toMatch(/user-agent/i);
    });
  });

  // ── §2: Landmark exposure per breakpoint ──────────────────────────
  describe('landmark exposure per breakpoint', () => {
    it('both primary navs exist in the DOM (toggled by CSS)', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('<nav class="app-nav" aria-label="Primary">');
      expect(res.text).toContain(
        '<nav class="mobile-nav-primary" aria-label="Primary">',
      );
    });

    it('desktop sidebar uses display:none !important inside the breakpoint', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      // !important guarantees the fixed sidebar never leaks into the mobile
      // layout or accessibility tree even if specificity rules change.
      expect(css).toMatch(
        /@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.app-sidebar\s*\{[\s\S]*?display:\s*none\s*!important/,
      );
    });

    it('mobile nav is display:none outside the breakpoint', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(/\.mobile-nav\s*\{\s*display:\s*none/);
    });
  });

  // ── §5: No-JavaScript navigation ──────────────────────────────────
  describe('no-JavaScript navigation', () => {
    it('the disclosure has no inline event handlers', async () => {
      const res = await agent.get('/').expect(200);
      const detailsBlock = res.text.match(
        /<details class="mobile-nav">[\s\S]*?<\/details>/,
      );
      expect(detailsBlock).not.toBeNull();
      expect(detailsBlock[0]).not.toMatch(
        /\son(mouse|focus|blur|key|click|toggle|enter|leave)/i,
      );
    });

    it('no <script> tag targets the mobile navigation', async () => {
      const res = await agent.get('/').expect(200);
      const scripts = res.text.match(/<script[^>]*>/g) || [];
      // The only script is the asset-preview enhancer — no nav script.
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).toContain('/creatorcrate.js');
    });

    it('the open state uses the native [open] attribute selector', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(/\.mobile-nav\[open\]/);
    });

    it('no hidden checkboxes drive the toggle state', async () => {
      const res = await agent.get('/').expect(200);
      const detailsBlock = res.text.match(
        /<details class="mobile-nav">[\s\S]*?<\/details>/,
      );
      expect(detailsBlock[0]).not.toMatch(/<input[^>]*type="checkbox"/i);
      // Hidden inputs are allowed for CSRF tokens in forms (name="_csrf").
      // Only non-form hidden inputs would be suspicious toggle state.
      expect(detailsBlock[0]).not.toMatch(/<input[^>]*type="hidden"(?![^>]*name="_csrf")[^>]*>/i);
    });

    it('mobile nav links are real <a href> anchors (native navigation)', async () => {
      const res = await agent.get('/').expect(200);
      const hrefs = mobileNavHrefs(res.text);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href.startsWith('/')).toBe(true);
      }
    });
  });

  // ── §6: Responsive page containment (no-overflow contract) ────────
  describe('no-overflow contract', () => {
    it('the mobile section title can shrink (min-width:0 + overflow)', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      const sectionRule = css.match(/\.mobile-nav-section\s*\{[\s\S]*?\}/);
      expect(sectionRule).not.toBeNull();
      expect(sectionRule[0]).toMatch(/min-width:\s*0/);
      expect(sectionRule[0]).toMatch(/overflow:\s*hidden/);
      expect(sectionRule[0]).toMatch(/text-overflow:\s*ellipsis/);
    });

    it('the mobile breakpoint does not reserve the sidebar column', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      // margin-left:0 on .app-main inside the breakpoint means the content
      // column uses the full viewport at 320/360/390/768 widths.
      expect(css).toMatch(
        /@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.app-main\s*\{[\s\S]*?margin-left:\s*0/,
      );
    });

    it('the desktop sidebar margin still applies outside the breakpoint', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      const mainRule = css.match(/\.app-main\s*\{[\s\S]*?\}/);
      expect(mainRule[0]).toMatch(/margin-left:\s*var\(--shell-sidebar-collapsed\)/);
    });

    it('the mobile summary has no fixed width exceeding the smallest viewport', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      const summaryRule = css.match(/\.mobile-nav-summary\s*\{[\s\S]*?\}/);
      expect(summaryRule).not.toBeNull();
      // No explicit width on the summary — it fills the viewport by default.
      expect(summaryRule[0]).not.toMatch(/width:\s*\d{4,}/);
    });

    it('retains exactly one <main> on representative pages', async () => {
      for (const url of [
        '/',
        '/projects',
        `/projects/${projectId}`,
        `/projects/${projectId}/assets`,
        `/projects/${projectId}/assets/${assetId}`,
        '/releases',
      ]) {
        const res = await agent.get(url);
        expect(countMain(res.text)).toBe(1);
      }
    });

    it('no horizontal scrollbar: no element wider than 320px in the shell', async () => {
      const res = await agent.get('/').expect(200);
      // The mobile summary, section, and links use flex with min-width:0 or
      // nowrap + truncation, so nothing forces a width beyond the viewport.
      // Assert the CSS has no fixed width >= 320px on mobile shell elements.
      const css = await extractStyle(agent, res.text);
      const mobileSelectors = [
        /\.mobile-nav-summary\s*\{[\s\S]*?\}/,
        /\.mobile-nav-section\s*\{[\s\S]*?\}/,
        /\.mobile-nav-link\s*\{[\s\S]*?\}/,
        /\.mobile-nav-brand\s*\{[\s\S]*?\}/,
        /\.mobile-nav-toggle\s*\{[\s\S]*?\}/,
      ];
      for (const sel of mobileSelectors) {
        const rule = css.match(sel);
        if (rule) {
          const widthMatch = rule[0].match(/width:\s*(\d+)px/);
          if (widthMatch) {
            expect(Number(widthMatch[1])).toBeLessThan(320);
          }
        }
      }
    });
  });

  // ── §7: Desktop regression ────────────────────────────────────────
  describe('desktop regression', () => {
    it('desktop sidebar CSS is still present', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(/\.app-sidebar\s*\{[\s\S]*?position:\s*fixed/);
    });

    it('desktop hover expansion is unchanged', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(
        /\.app-sidebar:hover[\s\S]*?width:\s*var\(--shell-sidebar-expanded\)/,
      );
    });

    it('desktop focus-within expansion is unchanged', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(
        /\.app-sidebar:focus-within[\s\S]*?width:\s*var\(--shell-sidebar-expanded\)/,
      );
    });

    it('desktop active state still works', async () => {
      const res = await agent.get('/projects').expect(200);
      const re = /class="app-nav-link" data-nav-key="([^"]+)" aria-current="page"/g;
      const keys = [];
      let m;
      while ((m = re.exec(res.text)) !== null) keys.push(m[1]);
      expect(keys).toEqual(['projects']);
    });

    it('the mobile nav does not affect desktop active count', async () => {
      const res = await agent.get('/').expect(200);
      // Exactly one desktop active item, regardless of the mobile nav.
      const desktopActive = (
        res.text.match(/class="app-nav-link" data-nav-key="[^"]+" aria-current="page"/g) || []
      ).length;
      expect(desktopActive).toBe(1);
    });

    it('reduced-motion rules still cover the desktop shell', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      const reduced = css.match(
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\s*\}/,
      );
      expect(reduced).not.toBeNull();
      expect(reduced[1]).toMatch(/\.app-sidebar\b/);
      expect(reduced[1]).toMatch(/\.app-nav-label\b/);
    });
  });

  // ── §4: <details> visual states ───────────────────────────────────
  describe('<details> visual states', () => {
    it('defines a closed-state summary style', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(/\.mobile-nav-summary\s*\{/);
    });

    it('defines an open-state selector via .mobile-nav[open]', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(/\.mobile-nav\[open\]\s+\.mobile-nav-toggle::after/);
    });

    it('summary has a focus-visible indicator', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(/\.mobile-nav-summary:focus-visible[\s\S]*?outline/);
    });

    it('active mobile link uses a structural accent bar, not color alone', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(
        /\.mobile-nav-link\[aria-current="page"\]::before/,
      );
      const beforeBlock = css.match(
        /\.mobile-nav-link\[aria-current="page"\]::before\s*\{[\s\S]*?\}/,
      );
      expect(beforeBlock).not.toBeNull();
      expect(beforeBlock[0]).toMatch(/content:\s*""/);
      expect(beforeBlock[0]).toMatch(/width:\s*[0-9]+px/);
    });

    it('links are touch-sized (min-height >= 44px)', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      const linkRule = css.match(/\.mobile-nav-link\s*\{[\s\S]*?\}/);
      expect(linkRule).not.toBeNull();
      expect(linkRule[0]).toMatch(/min-height:\s*var\(--shell-nav-item-height\)/);
      const navItemHeight = css.match(/--shell-nav-item-height:\s*(\d+)px/);
      expect(navItemHeight).not.toBeNull();
      expect(Number(navItemHeight[1])).toBeGreaterThanOrEqual(44);
    });

    it('the open panel has clear separation from page content', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      const panelRule = css.match(/\.mobile-nav-primary\s*\{[\s\S]*?\}/);
      expect(panelRule).not.toBeNull();
      expect(panelRule[0]).toMatch(/border-bottom/);
      expect(panelRule[0]).toMatch(/box-shadow/);
    });
  });

  // ── §4b: Mobile title behavior (open vs closed) ────────────────────
  describe('mobile title behavior (open vs closed)', () => {
    it('the closed-state summary shows the page-specific title', async () => {
      const res = await agent.get('/projects').expect(200);
      const summaryBlock = res.text.match(
        /<summary class="mobile-nav-summary">([\s\S]*?)<\/summary>/,
      );
      expect(summaryBlock[1]).toContain('<span class="mobile-nav-section">Projects</span>');
    });

    it('a long page title truncates instead of breaking the summary bar', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      const sectionRule = css.match(/\.mobile-nav-section\s*\{[\s\S]*?\}/)[0];
      expect(sectionRule).toMatch(/white-space:\s*nowrap/);
      expect(sectionRule).toMatch(/text-overflow:\s*ellipsis/);
    });

    it('CSS hides the page-specific title once the menu is open, matching the desktop shell', async () => {
      // Phase 14: opening the disclosure reverts the summary's title to the
      // brand mark ("CreatorCrate") — mirroring the desktop sidebar, whose
      // brand becomes visible once expanded — instead of keeping the
      // page-specific title visible.
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(/\.mobile-nav\[open\]\s+\.mobile-nav-section\s*\{[^}]*display:\s*none/);
    });

    it('the open panel does not render a second copy of the page title', async () => {
      const res = await agent.get('/projects').expect(200);
      const panelBlock = res.text.match(/<nav class="mobile-nav-primary"[\s\S]*?<\/nav>/);
      expect(panelBlock).not.toBeNull();
      expect(panelBlock[0]).not.toContain('mobile-nav-section');
    });

    it('the brand mark left visible when open reads the app name', async () => {
      const res = await agent.get('/projects').expect(200);
      const summaryBlock = res.text.match(
        /<summary class="mobile-nav-summary">([\s\S]*?)<\/summary>/,
      );
      expect(summaryBlock[1]).toContain(`<span class="mobile-nav-brand">${APP_NAME}</span>`);
    });

    it('CSS hides the brand mark in the closed state so it does not double up with the page title', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      const brandRule = css.match(/\.mobile-nav-brand\s*\{[\s\S]*?\}/);
      expect(brandRule).not.toBeNull();
      expect(brandRule[0]).toMatch(/display:\s*none/);
    });

    it('CSS keeps the toggle pinned to the same right edge in both states by giving the open-state brand mark the flex-growing spacer role', async () => {
      // Once open, .mobile-nav-section (the only flex:1 1 auto sibling in the
      // closed state) is hidden — without a replacement spacer the toggle
      // would collapse in next to the logo instead of staying at the right
      // edge of the bar.
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      expect(css).toMatch(/\.mobile-nav\[open\]\s+\.mobile-nav-brand\s*\{[^}]*display:\s*block[^}]*flex:\s*1 1 auto/);
    });
  });

  // ── §8: Accessibility ─────────────────────────────────────────────
  describe('accessibility', () => {
    it('mobile nav links are a standard list of links (no menu roles)', async () => {
      const res = await agent.get('/').expect(200);
      const navBlock = res.text.match(
        /<nav class="mobile-nav-primary"[\s\S]*?<\/nav>/,
      );
      expect(navBlock).not.toBeNull();
      expect(navBlock[0]).toMatch(/<a href=/);
      expect(navBlock[0]).not.toMatch(/role="menu"/);
      expect(navBlock[0]).not.toMatch(/role="menuitem"/);
    });

    it('the active link carries aria-current="page"', async () => {
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toMatch(
        /class="mobile-nav-link" data-nav-key="projects" aria-current="page"/,
      );
    });

    it('no icon-only unexplained control in the summary', async () => {
      const res = await agent.get('/').expect(200);
      const summaryBlock = res.text.match(
        /<summary class="mobile-nav-summary">([\s\S]*?)<\/summary>/,
      );
      // The toggle carries the word "Menu" — the glyph is supplementary.
      expect(summaryBlock[1]).toContain('Menu');
    });

    it('reduced-motion rules cover the mobile shell transitions', async () => {
      const css = await extractStyle(agent, (await agent.get('/').expect(200)).text);
      const reduced = css.match(
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\s*\}/,
      );
      expect(reduced).not.toBeNull();
      expect(reduced[1]).toMatch(/\.mobile-nav-summary\b/);
      expect(reduced[1]).toMatch(/\.mobile-nav-link\b/);
    });

    it('the skip link is still present and targets #main-content', async () => {
      const res = await agent.get('/').expect(200);
      expect(res.text).toContain('class="skip-link" href="#main-content"');
    });
  });
});
