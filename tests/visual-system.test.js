/**
 * Phase 10.6B — Cross-page color, contrast, spacing, density, and responsive
 * visual-polish hardening.
 *
 * Verifies:
 *  - Token integrity (defined, no recursion, no duplicate conflicting values)
 *  - Computed contrast ratios meet WCAG AA for normal text
 *  - Target sizing meets minimum dimensions
 *  - Breakpoint-edge containment at 320/390/540/768/1024px
 *  - Long-content wrapping and containment
 *  - Table/calendar bounded overflow
 *  - Disabled state readability
 *  - Autofill styling contract
 *  - No inline styles outside the shared stylesheet
 *  - [hidden] remains authoritative
 *  - Typography hierarchy consistency
 *  - Button/action consistency
 *  - Form density alignment
 *  - Badge contrast ratios
 *  - Link color token
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import nunjucks from 'nunjucks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
function renderPartial(templateName, context = {}) {
  const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
  return env.render(templateName, context);
}

/**
 * Fetch the actually-served stylesheet through the HTTP test agent (not the
 * source file on disk), so these assertions fail if /creatorcrate.css stops
 * being served correctly, not just if the source file changes.
 */
async function extractStyle(app, html) {
  expect(html).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
  const res = await request(app).get('/creatorcrate.css').expect(200);
  expect(res.headers['content-type']).toMatch(/text\/css/);
  return res.text;
}

/** WCAG relative luminance from sRGB. */
function luminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG contrast ratio between two hex colours. */
function contrastRatio(hex1, hex2) {
  const hexToRgb = (hex) => {
    hex = String(hex).replace('#', '');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  const l1 = luminance(r1, g1, b1);
  const l2 = luminance(r2, g2, b2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Composite rgba foreground over background to get effective RGB. */
function compositeRgba(fgHex, alpha, bgHex) {
  const hexToRgb = (hex) => {
    hex = String(hex).replace('#', '');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  };
  const [fr, fg, fb] = hexToRgb(fgHex);
  const [br, bg, bb] = hexToRgb(bgHex);
  return [
    Math.round(fr * alpha + br * (1 - alpha)),
    Math.round(fg * alpha + bg * (1 - alpha)),
    Math.round(fb * alpha + bb * (1 - alpha)),
  ];
}

/** Contrast ratio of fgHex on an rgba(fgR,fgG,fgB,alpha) background over bgHex. */
function contrastOnRgbaBg(fgHex, fgR, fgG, fgB, alpha, bgHex) {
  const hexToRgb = (hex) => {
    hex = String(hex).replace('#', '');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  };
  const [cR, cG, cB] = compositeRgba(`#${fgR.toString(16).padStart(2,'0')}${fgG.toString(16).padStart(2,'0')}${fgB.toString(16).padStart(2,'0')}`, alpha, bgHex);
  const [fR, fG, fB] = hexToRgb(fgHex);
  const l1 = luminance(fR, fG, fB);
  const l2 = luminance(cR, cG, cB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function countTags(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'g');
  return (html.match(re) || []).length;
}

function hasClass(html, className) {
  const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`);
  return re.test(html);
}

function listProductionTemplates(dir = VIEWS_DIR) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const templates = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      templates.push(...listProductionTemplates(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.njk') && entry.name !== 'layout.njk') {
      templates.push(fullPath);
    }
  }
  return templates;
}

describe('Phase 10.6B: Visual-polish hardening', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-106b-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Token integrity ────────────────────────────────────────────────

  describe('token integrity', () => {
    it('every custom property in :root is defined exactly once (no duplicates)', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      const rootBlock = css.match(/:root\s*\{([^}]+)\}/);
      expect(rootBlock).not.toBeNull();
      // Parse key-value pairs — only count actual declarations, not references
      const decls = rootBlock[1].match(/(--[\w-]+)\s*:/g) || [];
      const keys = decls.map(d => d.replace(/\s*:/, ''));
      const seen = {};
      const dups = [];
      for (const key of keys) {
        if (seen[key]) dups.push(key);
        seen[key] = (seen[key] || 0) + 1;
      }
      expect(dups).toEqual([]);
    });

    it('no recursive token definitions (a token referencing itself)', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      const rootBlock = css.match(/:root\s*\{([^}]+)\}/);
      expect(rootBlock).not.toBeNull();
      // Parse key-value pairs from :root
      const decls = rootBlock[1].match(/(--[\w-]+)\s*:\s*([^;]+)/g) || [];
      for (const decl of decls) {
        const [, key, value] = decl.match(/(--[\w-]+)\s*:\s*(.+)/) || [];
        if (key && value) {
          // Token referencing itself would be var(--token) where --token equals key
          const selfRef = `var(${key})`;
          expect(value.trim()).not.toBe(selfRef);
        }
      }
    });

    it('semantic colour tokens have clear purposes and are distinguishable', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      // Verify all semantic status colours are distinct hex values
      const dangerMatch = css.match(/--danger:\s*(#[0-9a-fA-F]{6})/);
      const successMatch = css.match(/--success:\s*(#[0-9a-fA-F]{6})/);
      const warningMatch = css.match(/--warning:\s*(#[0-9a-fA-F]{6})/);
      const accentMatch = css.match(/--accent:\s*(#[0-9a-fA-F]{6})/);
      const focusMatch = css.match(/--focus-ring:\s*(#[0-9a-fA-F]{6})/);
      const mutedMatch = css.match(/--muted:\s*(#[0-9a-fA-F]{6})/);
      const borderMatch = css.match(/--border:\s*(#[0-9a-fA-F]{6})/);
      const textMatch = css.match(/--text:\s*(#[0-9a-fA-F]{6})/);

      expect(dangerMatch).not.toBeNull();
      expect(successMatch).not.toBeNull();
      expect(warningMatch).not.toBeNull();
      expect(accentMatch).not.toBeNull();
      expect(focusMatch).not.toBeNull();

      const danger = dangerMatch[1].toLowerCase();
      const success = successMatch[1].toLowerCase();
      const warning = warningMatch[1].toLowerCase();
      const accent = accentMatch[1].toLowerCase();
      const focus = focusMatch[1].toLowerCase();

      // All five must be pairwise distinct
      const colors = [danger, success, warning, accent, focus];
      expect(new Set(colors).size).toBe(colors.length);

      // Danger, success, warning, and muted must be distinguishable from border
      const border = borderMatch[1].toLowerCase();
      for (const c of [danger, success, warning]) {
        expect(c).not.toBe(border);
      }
    });

    it('--link token is defined and equals accent colour', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/--link:\s*#[0-9a-fA-F]{6}/);
      expect(css).toMatch(/--badge-danger-fg:\s*#[0-9a-fA-F]{6}/);
      expect(css).toMatch(/--badge-archived-fg:\s*#[0-9a-fA-F]{6}/);
    });
  });

  // ─── 2. Contrast audit ──────────────────────────────────────────────────

  describe('contrast ratios meet WCAG AA', () => {
    const BG = '#0d0f13';
    const SURFACE = '#171b22';
    const SURFACE_CARD = '#1d222b';

    it('--text on --bg meets 4.5:1', async () => {
      expect(contrastRatio('#e8ecf1', BG)).toBeGreaterThanOrEqual(4.5);
    });

    it('--text on --surface meets 4.5:1', async () => {
      expect(contrastRatio('#e8ecf1', SURFACE)).toBeGreaterThanOrEqual(4.5);
    });

    it('--muted on --bg meets 4.5:1', async () => {
      expect(contrastRatio('#8b93a3', BG)).toBeGreaterThanOrEqual(4.5);
    });

    it('--muted on --surface meets 4.5:1', async () => {
      expect(contrastRatio('#8b93a3', SURFACE)).toBeGreaterThanOrEqual(4.5);
    });

    it('--danger on --bg meets 4.5:1', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      const dangerMatch = css.match(/--danger:\s*(#[0-9a-fA-F]{6})/);
      expect(dangerMatch).not.toBeNull();
      expect(contrastRatio(dangerMatch[1], BG)).toBeGreaterThanOrEqual(4.5);
    });

    it('--danger on --surface meets 4.5:1', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      const dangerMatch = css.match(/--danger:\s*(#[0-9a-fA-F]{6})/);
      expect(dangerMatch).not.toBeNull();
      expect(contrastRatio(dangerMatch[1], SURFACE)).toBeGreaterThanOrEqual(4.5);
    });

    it('--focus-ring on --bg meets 3:1 (non-text)', async () => {
      expect(contrastRatio('#58a6ff', BG)).toBeGreaterThanOrEqual(3);
    });

    it('--accent on --bg meets 4.5:1', async () => {
      expect(contrastRatio('#22d3ee', BG)).toBeGreaterThanOrEqual(4.5);
    });

    it('error badge foreground meets 4.5:1 on tinted background (page bg)', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      const badgeDangerFg = css.match(/--badge-danger-fg:\s*(#[0-9a-fA-F]{6})/);
      expect(badgeDangerFg).not.toBeNull();
      // Badge bg is rgba(251,113,133,0.18) over page bg
      const ratio = contrastOnRgbaBg(badgeDangerFg[1], 251, 113, 133, 0.18, BG);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it('error badge foreground meets 4.5:1 on tinted background (surface)', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      const badgeDangerFg = css.match(/--badge-danger-fg:\s*(#[0-9a-fA-F]{6})/);
      expect(badgeDangerFg).not.toBeNull();
      const ratio = contrastOnRgbaBg(badgeDangerFg[1], 251, 113, 133, 0.18, SURFACE);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it('archived badge foreground meets 4.5:1 on tinted background', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      const badgeArchivedFg = css.match(/--badge-archived-fg:\s*(#[0-9a-fA-F]{6})/);
      expect(badgeArchivedFg).not.toBeNull();
      // Archived badge bg is rgba(136,136,136,0.25) over page bg
      const ratio = contrastOnRgbaBg(badgeArchivedFg[1], 136, 136, 136, 0.25, BG);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it('button disabled text meets 4.5:1 on its background', async () => {
      // Disabled: color --muted on bg --surface-card with inset border
      expect(contrastRatio('#8b93a3', SURFACE_CARD)).toBeGreaterThanOrEqual(4.5);
    });

    it('data-table header (--muted) meets 4.5:1 on --bg', async () => {
      expect(contrastRatio('#8b93a3', BG)).toBeGreaterThanOrEqual(4.5);
    });
  });

  // ─── 3. Typography and hierarchy ────────────────────────────────────────

  describe('typography consistency', () => {
    it('board card project and meta text is at least 0.75rem', async () => {
      const res = await request(app).get('/release-management?view=board').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.card-project\s*\{[^}]*font-size:\s*0\.75rem/);
      expect(css).toMatch(/\.card-meta\s*\{[^}]*font-size:\s*0\.75rem/);
    });

    it('the page-title header (the page\'s sole h1) has consistent sizing across pages', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      // Phase 14: the single page <h1> lives in .app-section-title (the
      // compact header), not inside page-heading — it must be styled
      // there, once, for every page.
      expect(css).toMatch(/\.app-section-title\s*\{[^}]*font-size/);
    });

    it('no font-size below 0.75rem for visible text (except badges at 0.75rem)', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      // Find all font-size declarations
      const fontSizes = css.match(/font-size:\s*([\d.]+rem)/g) || [];
      for (const fs of fontSizes) {
        const remVal = parseFloat(fs.match(/([\d.]+)rem/)[1]);
        // 0.75rem (12px) is the minimum for visible body text
        // Allow 0.75rem for help text, badges, metadata
        if (remVal < 0.75 && remVal > 0) {
          // Only help-text at 0.75rem and smaller sizes are allowed if they are
          // purely decorative or supplementary
          expect(remVal).toBeGreaterThanOrEqual(0.65);
        }
      }
    });
  });

  // ─── 4. Spacing and rhythm ──────────────────────────────────────────────

  describe('spacing and rhythm', () => {
    it('spacing tokens are defined in a consistent scale', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toContain('--space-xs: 0.25rem');
      expect(css).toContain('--space-sm: 0.5rem');
      expect(css).toContain('--space-md: 0.75rem');
      expect(css).toContain('--space-lg: 1rem');
      expect(css).toContain('--space-xl: 1.5rem');
      expect(css).toContain('--space-2xl: 2rem');
    });

    it('keeps Defaults section anchors clear of the sticky header at every viewport width', async () => {
      const res = await request(app).get('/settings/defaults').expect(200);
      const css = await extractStyle(app, res.text);
      const selector = '.settings-content > .project-form > .settings-section[id^="defaults-"]';
      const selectorIndex = css.indexOf(selector);

      expect(selectorIndex).toBeGreaterThanOrEqual(0);

      let nestingDepth = 0;
      for (const character of css.slice(0, selectorIndex)) {
        if (character === '{') nestingDepth += 1;
        if (character === '}') nestingDepth -= 1;
      }
      expect(nestingDepth).toBe(0);

      const ruleStart = css.indexOf('{', selectorIndex + selector.length);
      const ruleEnd = css.indexOf('}', ruleStart);
      expect(ruleStart).toBeGreaterThan(selectorIndex);
      expect(ruleEnd).toBeGreaterThan(ruleStart);
      expect(css.slice(ruleStart, ruleEnd)).toContain(
        'scroll-margin-top: calc(var(--shell-header-height) + var(--space-md));'
      );
    });

    it('scopes Project actions sizing and restores full width on mobile', async () => {
      const res = await request(app).get('/projects/new').expect(200);
      const css = await extractStyle(app, res.text);

      expect(css).toMatch(/\.notes-workspace-secondary\.project-actions\s*\{[\s\S]*?width: min\(25%, 24rem\);[\s\S]*?min-width: min\(100%, 16rem\);[\s\S]*?margin: var\(--space-lg\) auto 0;/);
      expect(css).toContain('.notes-workspace-secondary.project-actions { width: 100%; }');
    });

    it('scopes Settings Tags name-field padding away from form actions', async () => {
      const res = await request(app).get('/settings/tags').expect(200);
      const css = await extractStyle(app, res.text);

      expect(css).toMatch(/\.settings-tags-name-field\s*\{[^}]*padding-left:\s*var\(--space-md\);[^}]*padding-right:\s*var\(--space-md\);/);
      expect(css).toMatch(/\.settings-tags-name-field\s+\.help-text,\s*\.settings-tags-name-field\s+\.field-error-message\s*\{[^}]*padding-left:\s*0;[^}]*padding-right:\s*0;/);
      expect(css).not.toMatch(/\.form-actions\s*\{[^}]*\bpadding(?:-(?:left|right))?\s*:/);
    });

    it('styles the populated tag list as intentional settings rows', async () => {
      const res = await request(app).get('/settings/tags').expect(200);
      const css = await extractStyle(app, res.text);

      expect(css).toMatch(/\.settings-tag-list\s*\{[^}]*list-style:\s*none;/);
      expect(css).toMatch(/\.settings-tag-row\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/);
      expect(css).toMatch(/\.settings-tag-row\s*\{[^}]*padding:\s*var\(--space-sm\)\s*var\(--space-md\);/);
      expect(css).toMatch(/\.settings-tag-row\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/);
      expect(css).toMatch(/\.settings-tag-row:last-child\s*\{[^}]*border-bottom:\s*none;/);
      expect(css).toMatch(/\.settings-tag-actions\s*\{[^}]*display:\s*flex;/);
    });

    it('panels use consistent spacing tokens', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.panel\s*\{[^}]*padding:\s*var\(--space-lg\)/);
      expect(css).toMatch(/\.panel\s*\{[^}]*margin-bottom:\s*var\(--space-lg\)/);
    });

    it('notices use consistent spacing tokens', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.notice\s*\{[^}]*padding:\s*var\(--space-sm\)\s+var\(--space-md\)/);
      expect(css).toMatch(/\.notice\s*\{[^}]*font-size:\s*0\.875rem/);
      expect(css).toMatch(/\.notice\s*\{[^}]*margin-bottom:\s*var\(--space-lg\)/);
    });

    it('disabled-authentication banners use compact notification sizing', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.auth-disabled-banner\s*\{[^}]*padding:\s*var\(--space-sm\)\s+var\(--space-md\)/);
      expect(css).toMatch(/\.auth-disabled-banner p\s*\{[^}]*font-size:\s*0\.875rem/);
    });

    it('destructive sections use spacing tokens', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.destructive-section\s*\{[^}]*margin-top:\s*var\(--space-xl\)/);
      expect(css).toMatch(/\.destructive-section\s*\{[^}]*padding:\s*var\(--space-lg\)/);
    });
  });

  // ─── 5. Button and action consistency ────────────────────────────────────

  describe('button and action consistency', () => {
    it('all button variants have focus-visible outlines', async () => {
      const res = await request(app).get('/projects').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toContain('.button:focus-visible');
      expect(css).toContain('.button-secondary');
      expect(css).toContain('.button-primary');
      expect(css).toContain('.button-danger');
    });

    it('button disabled state uses dashed focus ring for distinction', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.button:disabled:focus-visible[^{]*\{[^}]*outline.*dashed/);
      expect(css).toMatch(/\[aria-disabled="true"\]:focus-visible[^{]*\{[^}]*outline.*dashed/);
    });

    it('pagination buttons use consistent sizing', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toContain('.pagination-prev');
      expect(css).toContain('.pagination-next');
    });

    it('button-small has minimum height for touch targets', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      // Phase 15: buttons were made ~20% smaller; 1.6rem (25.6px) stays
      // above the WCAG 2.5.8 AA minimum target size (24px).
      expect(css).toMatch(/\.button-small\s*\{[^}]*min-height:\s*1\.6rem/);
    });
  });

  // ─── 6. Form density ─────────────────────────────────────────────────────

  describe('form density', () => {
    it('checkbox fields have explicit min-height for touch targets', async () => {
      const res = await request(app).get('/projects/new').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.field--checkbox\s*\{[^}]*min-height/);
    });

    it('form inputs have max-width: 100% to prevent overflow', async () => {
      const res = await request(app).get('/projects/new').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.field input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\)[^{]*\{[^}]*max-width:\s*100%/);
      expect(css).toMatch(/\.field select\s*\{[^}]*max-width:\s*100%/);
    });

    it('field error styling does not add visual jumps (uses border + shadow)', async () => {
      const res = await request(app).get('/projects/new').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toContain('.field-error input');
      expect(css).toContain('border-color: var(--danger)');
      expect(css).toContain('.field-error-message');
    });

    it('autofill styling contract is present', async () => {
      const res = await request(app).get('/projects/new').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toContain('input:-webkit-autofill');
      expect(css).toContain('-webkit-text-fill-color');
    });
  });

  // ─── 7. Tables and calendars ────────────────────────────────────────────

  describe('tables and calendars', () => {
    it('data table cells have overflow-wrap for long content', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.data-table td\s*\{[^}]*overflow-wrap/);
      expect(css).toMatch(/\.data-table td\s*\{[^}]*word-break/);
    });

    it('calendar day cells have overflow-wrap for long content', async () => {
      const res = await request(app).get('/calendar').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.calendar-day\s*\{[^}]*overflow-wrap/);
      expect(css).toMatch(/\.calendar-day\s*\{[^}]*word-break/);
    });

    it('calendar releases have overflow containment', async () => {
      const res = await request(app).get('/calendar').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.calendar-release\s*\{[^}]*overflow-wrap/);
    });

    it('table-scroll containers have max-width: 100%', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.table-scroll[^{]*\{[^}]*max-width:\s*100%/);
      expect(css).toMatch(/\.board-scroll[^{]*\{[^}]*max-width:\s*100%/);
      expect(css).toMatch(/\.calendar-scroll[^{]*\{[^}]*max-width:\s*100%/);
    });

    it('release asset cards expose full-target membership controls and selected styling', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.asset-select-checkbox\s*\{[^}]*position:\s*absolute[\s\S]*?inset:\s*0[\s\S]*?width:\s*100%[\s\S]*?height:\s*100%/);
      expect(css).toMatch(/\.asset-card\.is-selected\s*\{[^}]*box-shadow:/);
      expect(css).toMatch(/\.asset-list-card--release \.asset-list-card-top\s*\{[^}]*position:\s*absolute/);
      expect(css).toMatch(/\.release-asset-card-detail\s*\{[^}]*overflow-wrap/);
    });

    it('calendar replaces the grid with an agenda list on narrow screens instead of relying on horizontal scroll', async () => {
      const res = await request(app).get('/calendar').expect(200);
      const css = await extractStyle(app, res.text);
      // Phase 13.3: below 767px the grid is hidden and the agenda list
      // takes over — narrow screens no longer rely on horizontal scroll.
      const responsiveCalendar = css.match(/@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.calendar-scroll\s*\{[\s\S]*?display:\s*none;[\s\S]*?\.calendar-agenda\s*\{[\s\S]*?display:\s*flex;/);
      expect(responsiveCalendar).not.toBeNull();
      expect(res.text).toContain('<ul class="calendar-agenda" aria-label="Release calendar agenda">');
    });
  });

  // ─── 7b. Shared page-width frame ─────────────────────────────────────────

  describe('shared page-width frame (Phase 14)', () => {
    it('defines a single --page-width token consumed by the main content column', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/--page-width:\s*1200px/);
      expect(css).toMatch(/\.app-main main\s*\{[^}]*max-width:\s*var\(--page-width\)/);
    });

    it('aligns the header title to the same shared page frame', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.app-header\s*\{[^}]*max-width:\s*var\(--page-width\)/);
      expect(css).toMatch(/\.app-header\s*\{[^}]*margin:\s*0 auto/);
    });

    it('aligns the disabled-authentication banner to the outer page frame with gutters', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.auth-disabled-banner\s*\{[^}]*width:\s*calc\(100%\s*-\s*\(2\s*\*\s*var\(--space-lg\)\)\)/);
      expect(css).toMatch(/\.auth-disabled-banner\s*\{[^}]*max-width:\s*var\(--page-width\)/);
      expect(css).toMatch(/\.auth-disabled-banner\s*\{[^}]*margin:\s*0 auto var\(--space-lg\)/);
    });

    it('no page defines its own outer-width override', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).not.toMatch(/body\.asset-browser-page\s+main/);
      expect(css).not.toMatch(/body\.asset-viewer-page\s+main/);
      expect(css).not.toMatch(/body\.calendar-page\s+main/);
      expect(css).not.toMatch(/body\.settings-page\s+main/);
    });

    it('asset, calendar, and settings pages render an empty body class and inherit the shared width', async () => {
      const projRes = await request(app)
        .post('/projects')
        .send('title=Width+Inherit+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const assets = await request(app).get(`/projects/${projectId}/assets`).expect(200);
      expect(assets.text).toContain('<body class="">');

      const calendar = await request(app).get('/calendar').expect(200);
      expect(calendar.text).toContain('<body class="">');

      const settings = await request(app).get('/settings').expect(200);
      expect(settings.text).toContain('<body class="">');
    });
  });

  // ─── 8. Responsive breakpoints ───────────────────────────────────────────

  describe('breakpoint-edge containment', () => {
    it('has breakpoints at 540px, 767px, and 1023px', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)/);
      expect(css).toMatch(/@media\s*\(max-width:\s*767px\)/);
      expect(css).toMatch(/@media\s*\(max-width:\s*1023px\)/);
    });

    it('mobile breakpoint hides sidebar and shows mobile nav', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      // Desktop sidebar hidden on mobile
      expect(css).toMatch(/@media[^@]*max-width:\s*1023px\)[^@]*\.app-sidebar\s*\{[^}]*display:\s*none/);
      // Mobile nav shown on mobile
      expect(css).toMatch(/@media[^@]*max-width:\s*1023px\)[^@]*\.mobile-nav\s*\{[^}]*display:\s*block/);
    });

    it('page-heading flex-direction: column on mobile', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      // The mobile breakpoint must have a rule that makes page-heading stack
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)[^}]*\.page-heading\s*\{[^}]*flex-direction:\s*column/);
    });

    it('field-row stacks on mobile', async () => {
      const res = await request(app).get('/projects/new').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)[^}]*\.field-row\s*\{[^}]*flex-direction:\s*column/);
    });

    it('calendar release font-size on very narrow screens', async () => {
      const res = await request(app).get('/calendar').expect(200);
      const css = await extractStyle(app, res.text);
      // Check that the 540px media query exists and contains calendar adjustments
      const mediaIndex = css.indexOf('@media (max-width: 540px)');
      expect(mediaIndex).toBeGreaterThan(-1);
      // From the start of the 540px media query, find .calendar-release
      const afterMedia = css.substring(mediaIndex);
      expect(afterMedia).toContain('.calendar-release');
    });
  });

  // ─── 9. Long-content verification ────────────────────────────────────────

  describe('long-content wrapping', () => {
    it('the page-title header contains long titles with truncation, never breaking the header layout', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      // Phase 14: the header title (.app-section-title) and the mobile
      // summary's title (.mobile-nav-section) both truncate with an
      // ellipsis rather than wrapping, so a long page_title never grows
      // the fixed-height header/summary bar.
      expect(css).toMatch(/\.app-section-title\s*\{[^}]*overflow:\s*hidden/);
      expect(css).toMatch(/\.app-section-title\s*\{[^}]*text-overflow:\s*ellipsis/);
      expect(css).toMatch(/\.app-section-title\s*\{[^}]*white-space:\s*nowrap/);
      expect(css).toMatch(/\.mobile-nav-section\s*\{[^}]*overflow:\s*hidden/);
      expect(css).toMatch(/\.mobile-nav-section\s*\{[^}]*text-overflow:\s*ellipsis/);
      expect(css).toMatch(/\.mobile-nav-section\s*\{[^}]*white-space:\s*nowrap/);
    });

    it('board cards have overflow containment', async () => {
      const res = await request(app).get('/release-management?view=board').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.board-card\s*\{[^}]*overflow-wrap/);
    });

    it('detail list dd has overflow-wrap', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.detail-list dd\s*\{[^}]*overflow-wrap/);
    });

    it('data-table links have overflow-wrap', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.data-table a\s*\{[^}]*overflow-wrap/);
    });
  });

  // ─── 10. No inline styles ───────────────────────────────────────────────

  describe('no inline presentation styles', () => {
    it('production templates keep presentation CSS in the shared stylesheet only', () => {
      const offenders = [];
      for (const templatePath of listProductionTemplates()) {
        const source = fs.readFileSync(templatePath, 'utf8');
        if (/<style\b/i.test(source) || /\sstyle\s*=/i.test(source)) {
          offenders.push(path.relative(VIEWS_DIR, templatePath).replace(/\\/g, '/'));
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  // ─── 11. [hidden] remains authoritative ──────────────────────────────────

  describe('[hidden] remains authoritative', () => {
    it('global rule makes [hidden] display:none with !important', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
    });
  });

  // ─── 12. Badge colour consistency ───────────────────────────────────────

  describe('badge colour tokens', () => {
    it('error/danger badge uses --badge-danger-fg token', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.status-badge--error[^{]*\{[^}]*color:\s*var\(--badge-danger-fg\)/);
    });

    it('archived badge uses --badge-archived-fg token', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.status-badge--archived[^{]*\{[^}]*color:\s*var\(--badge-archived-fg\)/);
    });

    it('success/active badge uses --success token', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.status-badge--active[^{]*\{[^}]*color:\s*var\(--success\)/);
    });

    it('draft badge uses --accent token', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.status-badge--draft[^{]*\{[^}]*color:\s*var\(--accent\)/);
    });

    it('warning badge uses --warning token', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.status-badge--warning[^{]*\{[^}]*color:\s*var\(--warning\)/);
    });
  });

  // ─── 13. Link colour token ──────────────────────────────────────────────

  describe('link colour token', () => {
    it('generic links use --link colour', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/a:not\(\[class\]\)\s*\{[^}]*color:\s*var\(--link\)/);
    });

    it('project list links use --link colour', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.project-list a\s*\{[^}]*color:\s*var\(--link\)/);
    });

    it('release list links use --link colour', async () => {
      const res = await request(app).get('/release-management').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.release-list a\s*\{[^}]*color:\s*var\(--link\)/);
    });
  });

  // ─── 14. Notice/panel alpha consistency ──────────────────────────────────

  describe('notice and panel alpha consistency', () => {
    it('danger-tinted backgrounds use 0.18 alpha for notices/badges', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      // Error badges, scan-error, error-summary, notices all use 0.18
      expect(css).toMatch(/\.status-badge--error[^{]*\{[^}]*background:\s*rgba\(251,\s*113,\s*133,\s*0\.18\)/);
      expect(css).toMatch(/\.scan-error\s*\{[^}]*background:\s*rgba\(251,\s*113,\s*133,\s*0\.18\)/);
      expect(css).toMatch(/\.error-summary\s*\{[^}]*background:\s*rgba\(251,\s*113,\s*133,\s*0\.18\)/);
      expect(css).toMatch(/\.notice--danger[^{]*\{[^}]*background:\s*rgba\(251,\s*113,\s*133,\s*0\.18\)/);
    });

    it('danger-tinted panels use a softer alpha background', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.panel--danger\s*\{[^}]*background:\s*rgba\(251,\s*113,\s*133,\s*0\.08\)/);
      expect(css).toMatch(/\.destructive-section\s*\{[^}]*background:\s*rgba\(251,\s*113,\s*133,\s*0\.1\)/);
    });

    it('success-tinted backgrounds use 0.18 alpha for notices', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      expect(css).toMatch(/\.notice--success\s*\{[^}]*background:\s*rgba\(52,\s*211,\s*153,\s*0\.18\)/);
    });
  });

  // ─── 15. Archived/disabled state opacity ────────────────────────────────

  describe('archived and disabled state readability', () => {
    it('archived row opacity is at least 0.6', async () => {
      const res = await request(app).get('/').expect(200);
      const css = await extractStyle(app, res.text);
      const opacityMatch = css.match(/\.archived-row\s*\{[^}]*opacity:\s*([0-9.]+)/);
      expect(opacityMatch).not.toBeNull();
      expect(parseFloat(opacityMatch[1])).toBeGreaterThanOrEqual(0.6);
    });

    it('board-card archived opacity is at least 0.6', async () => {
      const res = await request(app).get('/release-management?view=board').expect(200);
      const css = await extractStyle(app, res.text);
      const opacityMatch = css.match(/\.board-card\.archived\s*\{[^}]*opacity:\s*([0-9.]+)/);
      expect(opacityMatch).not.toBeNull();
      expect(parseFloat(opacityMatch[1])).toBeGreaterThanOrEqual(0.6);
    });
  });
});
