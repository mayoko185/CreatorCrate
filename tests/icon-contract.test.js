/**
 * Phase 10.4A — icon contract tests.
 *
 * Icons are inline SVG keyed by a fixed name. The macro must:
 *  - resolve known keys to decorative SVG (aria-hidden="true"),
 *  - render nothing for unknown keys (safe fallback),
 *  - never interpolate the name into the markup (no injection surface).
 */
import { describe, it, expect } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });

function renderIcon(name) {
  return env.renderString(
    '{% import "partials/icons.njk" as i %}{{ i.icon(name) }}',
    { name },
  );
}

describe('icon contract — known keys', () => {
  for (const key of ['dashboard', 'projects', 'releases']) {
    it(`"${key}" resolves to a decorative inline svg`, () => {
      const out = renderIcon(key);
      expect(out).toContain('<svg');
      expect(out).toContain('</svg>');
      // Decorative: hidden from assistive tech, not focusable.
      expect(out).toContain('aria-hidden="true"');
      expect(out).toContain('focusable="false"');
      // No remote dependency.
      expect(out).not.toMatch(/xlink:href|https?:\/\//);
    });
  }
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
