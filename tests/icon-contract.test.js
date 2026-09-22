/**
 * Phase 10.4A — icon contract tests.
 *
 * Icons are inline SVG keyed by a fixed name. The macro must:
 *  - resolve a known key to decorative SVG (aria-hidden="true"),
 *  - render nothing for unknown keys (safe fallback),
 *  - never interpolate the name into the markup (no injection surface).
 */
import { describe, it, expect } from 'vitest';
import nunjucks from 'nunjucks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const ICON_TEMPLATE = readFileSync(path.join(VIEWS_DIR, 'partials', 'icons.njk'), 'utf8');
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });

// Public keys established by production navigation and template callers.
// Keep this list explicit so a typo or rename in the macro cannot redefine
// the contract that this test is meant to protect.
const KNOWN_ICON_KEYS = [
  'assets',
  'boxes',
  'calendar',
  'chevron-left',
  'chevron-right',
  'close',
  'content-filter',
  'convert',
  'copy',
  'dashboard',
  'database-backup',
  'details',
  'edit',
  'external-link',
  'folder-move',
  'fullscreen',
  'fullscreen-exit',
  'gauge',
  'grid',
  'list',
  'notes',
  'nsfw-filter',
  'open-locally',
  'original-size',
  'pause',
  'plus',
  'projects',
  'releases',
  'reset',
  'scroll-text',
  'select-all',
  'settings',
  'share-2',
  'shield-check',
  'sliders-horizontal',
  'slideshow',
  'sort',
  'tags',
  'trash',
  'warning',
  'watermark',
];

function renderIcon(name) {
  return env.renderString(
    '{% import "partials/icons.njk" as i %}{{ i.icon(name) }}',
    { name },
  );
}

describe('icon contract — known keys', () => {
  it('renders every established key as an inline SVG', () => {
    for (const key of KNOWN_ICON_KEYS) {
      expect(renderIcon(key), `Expected icon key "${key}" to render`).toMatch(
        /^<svg\b[\s\S]*<\/svg>$/,
      );
    }
  });
});

describe('icon contract — shared SVG markup', () => {
  it('keeps every icon local, decorative, and unfocusable', () => {
    const svgTags = ICON_TEMPLATE.match(/<svg\b[^>]*>/g) ?? [];
    expect(svgTags.length).toBeGreaterThan(0);

    for (const svgTag of svgTags) {
      expect(svgTag).toContain('aria-hidden="true"');
      expect(svgTag).toContain('focusable="false"');
      expect(svgTag).not.toMatch(/xlink:href|https?:\/\//);
    }
  });
});

describe('icon contract — Notes icon', () => {
  it('renders a document outline with text lines', () => {
    const out = renderIcon('notes');
    expect(out).toContain('<svg');
    expect(out).toContain('</svg>');
    expect(out).toContain('<path d="M6 3h8l4 4v14H6z"/>');
    expect(out).toContain('<path d="M14 3v5h5M9 12h6M9 16h6M9 20h4"/>');
  });
});

describe('icon contract — unknown / unsafe keys', () => {
  it('an unknown key renders nothing (safe empty fallback)', () => {
    expect(renderIcon('definitely-not-a-real-icon')).toBe('');
    expect(renderIcon('')).toBe('');
  });

  it('does not interpolate the name argument into the markup', () => {
    // A malicious-looking key must match no branch and emit nothing — the
    // value is compared, never placed inside the SVG.
    const payload = '"><script>alert(1)</script>';
    const out = renderIcon(payload);
    expect(out).toBe('');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain(payload);
  });
});
