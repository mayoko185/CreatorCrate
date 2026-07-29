/**
 * Phase 10.4A — unit tests for the central navigation model.
 *
 * These exercise the pure matcher and shell builder with no database or
 * HTTP layer, so the active-state rules are pinned independently of the
 * rendered output.
 */
import { describe, it, expect } from 'vitest';
import {
  buildShellModel,
  isPathActive,
  pathMatchesPattern,
  NAVIGATION_ITEMS,
} from '../src/shell/navigation.js';

const APP_NAME = 'CreatorCrate';

function activeKeys(path, opts = {}) {
  return buildShellModel({ appName: APP_NAME, path, ...opts })
    .navigation.filter((n) => n.active)
    .map((n) => n.key);
}

describe('navigation model — destinations', () => {
  it('exposes only destinations that resolve to real page routes', () => {
    const { navigation } = buildShellModel({ appName: APP_NAME, path: '/' });
    // Dashboard, Projects, Releases. No Settings (no such route), no Health
    // (JSON-only), no dead links.
    expect(navigation.map((n) => n.href)).toEqual(['/', '/projects', '/releases']);
  });

  it('every navigation item has a stable key, label, href, and icon', () => {
    expect(NAVIGATION_ITEMS.length).toBeGreaterThan(0);
    for (const item of NAVIGATION_ITEMS) {
      expect(typeof item.key).toBe('string');
      expect(item.key.length).toBeGreaterThan(0);
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
      expect(typeof item.href).toBe('string');
      expect(item.href.startsWith('/')).toBe(true);
      expect(typeof item.icon).toBe('string');
      expect(item.icon.length).toBeGreaterThan(0);
      expect(Array.isArray(item.matches)).toBe(true);
      expect(item.matches.length).toBeGreaterThan(0);
    }
  });

  it('icon keys are unique across items', () => {
    const icons = NAVIGATION_ITEMS.map((i) => i.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('navigation model — dashboard active state', () => {
  it('is active only on the root path', () => {
    expect(activeKeys('/')).toEqual(['dashboard']);
    expect(activeKeys('/projects')).not.toContain('dashboard');
    expect(activeKeys('/releases')).not.toContain('dashboard');
  });
});

describe('navigation model — projects active state', () => {
  it('is active on the project list', () => {
    expect(activeKeys('/projects')).toEqual(['projects']);
  });

  it('is active on the new-project form', () => {
    expect(activeKeys('/projects/new')).toEqual(['projects']);
  });

  it('is active on project detail', () => {
    expect(activeKeys('/projects/42')).toEqual(['projects']);
  });

  it('is active on project edit', () => {
    expect(activeKeys('/projects/42/edit')).toEqual(['projects']);
  });

  it('is active on the asset browser', () => {
    expect(activeKeys('/projects/42/assets')).toEqual(['projects']);
  });

  it('is active on the asset viewer', () => {
    expect(activeKeys('/projects/42/assets/7')).toEqual(['projects']);
  });
});

describe('navigation model — releases active state', () => {
  it('is active on the release list', () => {
    expect(activeKeys('/releases')).toEqual(['releases']);
  });

  it('is active on the calendar, new, detail, edit, publish, and asset routes', () => {
    expect(activeKeys('/releases/calendar')).toEqual(['releases']);
    expect(activeKeys('/releases/new')).toEqual(['releases']);
    expect(activeKeys('/releases/9')).toEqual(['releases']);
    expect(activeKeys('/releases/9/edit')).toEqual(['releases']);
    expect(activeKeys('/releases/9/publish')).toEqual(['releases']);
    expect(activeKeys('/releases/9/assets')).toEqual(['releases']);
  });
});

describe('navigation model — prefix safety', () => {
  it('an unrelated sibling prefix does not activate projects', () => {
    // The classic naive-prefix bug: "/projects-old" must not match "/projects".
    expect(activeKeys('/projects-old')).toEqual([]);
    expect(activeKeys('/projectsx')).toEqual([]);
    expect(activeKeys('/project')).toEqual([]);
  });

  it('an unrelated sibling prefix does not activate releases', () => {
    expect(activeKeys('/releases-archive')).toEqual([]);
    expect(activeKeys('/releasesx')).toEqual([]);
  });

  it('a query string is stripped before matching', () => {
    expect(activeKeys('/projects?status=tbd&page=2')).toEqual(['projects']);
    expect(activeKeys('/projects/5/assets?view=grid')).toEqual(['projects']);
  });
});

describe('navigation model — active-count invariants', () => {
  it('at most one top-level item is active for any path', () => {
    const paths = [
      '/',
      '/projects',
      '/projects/new',
      '/projects/1',
      '/projects/1/edit',
      '/projects/1/assets',
      '/projects/1/assets/2',
      '/releases',
      '/releases/calendar',
      '/releases/3',
      '/releases/3/edit',
      '/releases/3/publish',
      '/releases/3/assets',
    ];
    for (const p of paths) {
      expect(activeKeys(p)).toHaveLength(1);
    }
  });

  it('no item is active on an unrecognized top-level path', () => {
    expect(activeKeys('/nope')).toEqual([]);
    expect(activeKeys('/settings')).toEqual([]);
  });

  it('no item is active on a controlled not-found path when noActive is set', () => {
    // A missing record under /projects/:id must not highlight Projects.
    expect(activeKeys('/projects/999999', { noActive: true })).toEqual([]);
    expect(activeKeys('/releases/999999', { noActive: true })).toEqual([]);
  });
});

describe('navigation model — active section (header source)', () => {
  it('exposes the active item label as activeSection', () => {
    expect(buildShellModel({ appName: APP_NAME, path: '/projects' }).activeSection).toBe('Projects');
    expect(buildShellModel({ appName: APP_NAME, path: '/releases/3/edit' }).activeSection).toBe('Releases');
    expect(buildShellModel({ appName: APP_NAME, path: '/' }).activeSection).toBe('Dashboard');
  });

  it('activeSection is null when no item is active', () => {
    expect(buildShellModel({ appName: APP_NAME, path: '/settings' }).activeSection).toBeNull();
    expect(buildShellModel({ appName: APP_NAME, path: '/projects-old' }).activeSection).toBeNull();
  });

  it('activeSection is null on a controlled not-found path when noActive is set', () => {
    // A missing record must not surface a section title in the header.
    expect(buildShellModel({ appName: APP_NAME, path: '/projects/999999', noActive: true }).activeSection).toBeNull();
  });
});

describe('navigation model — segment matcher primitives', () => {
  it('rejects partial-segment lookalikes', () => {
    expect(pathMatchesPattern('/projects', '/projects')).toBe(true);
    expect(pathMatchesPattern('/projects', '/projects-old')).toBe(false);
    expect(pathMatchesPattern('/projects', '/project')).toBe(false);
  });

  it('requires equal segment counts', () => {
    expect(pathMatchesPattern('/projects/:id', '/projects')).toBe(false);
    expect(pathMatchesPattern('/projects/:id', '/projects/5')).toBe(true);
    expect(pathMatchesPattern('/projects', '/projects/5')).toBe(false);
  });

  it(':param matches any non-empty segment but not an empty one', () => {
    expect(isPathActive(['/projects/:id'], '/projects/5')).toBe(true);
    expect(isPathActive(['/projects/:id'], '/projects/')).toBe(false);
  });

  it('the root pattern matches only the root path', () => {
    expect(pathMatchesPattern('/', '/')).toBe(true);
    expect(pathMatchesPattern('/', '/anything')).toBe(false);
  });
});
