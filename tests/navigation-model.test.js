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
    // Dashboard, Projects, Asset Viewer, Releases, Calendar, Notes, Settings. No Health
    // (JSON-only), no dead links.
    expect(navigation.map((n) => n.href)).toEqual([
      '/', '/projects', '/assets', '/releases', '/calendar', '/notes', '/settings',
    ]);
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

describe('navigation model — Phase 2E: dedicated Calendar item', () => {
  it('contains exactly one Calendar item', () => {
    const calendarItems = NAVIGATION_ITEMS.filter((i) => i.key === 'calendar');
    expect(calendarItems).toHaveLength(1);
  });

  it('Calendar has href /calendar and a defined icon', () => {
    const item = NAVIGATION_ITEMS.find((i) => i.key === 'calendar');
    expect(item.href).toBe('/calendar');
    expect(item.icon).toBe('calendar');
  });

  it('Releases has href /releases', () => {
    const item = NAVIGATION_ITEMS.find((i) => i.key === 'releases');
    expect(item.label).toBe('Releases');
    expect(item.href).toBe('/releases');
  });

  it('item order is exactly Dashboard, Projects, Asset Viewer, Releases, Calendar, Notes, Settings', () => {
    expect(NAVIGATION_ITEMS.map((i) => i.label)).toEqual([
      'Dashboard',
      'Projects',
      'Asset Viewer',
      'Releases',
      'Calendar',
      'Notes',
      'Settings',
    ]);
  });

  it('Calendar appears immediately after Releases and Notes appears before Settings', () => {
    const keys = NAVIGATION_ITEMS.map((i) => i.key);
    const releasesIdx = keys.indexOf('releases');
    const calendarIdx = keys.indexOf('calendar');
    const notesIdx = keys.indexOf('notes');
    const settingsIdx = keys.indexOf('settings');
    expect(calendarIdx).toBe(releasesIdx + 1);
    expect(notesIdx).toBe(calendarIdx + 1);
    expect(settingsIdx).toBe(notesIdx + 1);
  });
});

describe('navigation model — Notes active state', () => {
  it('defines Notes with the top-level destination and notes icon', () => {
    expect(NAVIGATION_ITEMS.filter((item) => item.key === 'notes')).toHaveLength(1);
    expect(NAVIGATION_ITEMS.find((item) => item.key === 'notes')).toMatchObject({
      label: 'Notes',
      href: '/notes',
      icon: 'notes',
    });
  });

  it('is active for every rendered Books, Chapters, and direct Notes page route', () => {
    const renderedNotesPagePaths = [
      '/notes',
      '/notes/books/new',
      '/notes/books/order',
      '/notes/books/42',
      '/notes/books/42/edit',
      '/notes/books/42/order',
      '/notes/books/42/chapters/new',
      '/notes/chapters/7',
      '/notes/chapters/7/edit',
      '/notes/chapters/7/notes/order',
      '/notes/new',
      '/notes/42',
      '/notes/42/edit',
      '/notes?view=list',
    ];

    for (const path of renderedNotesPagePaths) {
      expect(activeKeys(path)).toEqual(['notes']);
    }
  });

  it('does not activate Notes for sibling prefixes', () => {
    expect(activeKeys('/notes-old')).toEqual([]);
    expect(activeKeys('/notes-archive')).toEqual([]);
    expect(activeKeys('/notebook')).toEqual([]);
  });
});

describe('navigation model — Asset Viewer active state', () => {
  it('has one exact /assets destination with the assets icon', () => {
    const item = NAVIGATION_ITEMS.find((i) => i.key === 'assets');
    expect(item).toMatchObject({
      label: 'Asset Viewer',
      href: '/assets',
      icon: 'assets',
      matches: ['/assets'],
    });
  });

  it('is active on /assets with or without a query string', () => {
    expect(activeKeys('/assets')).toEqual(['assets']);
    expect(activeKeys('/assets?view=list')).toEqual(['assets']);
  });

  it('does not capture project-scoped asset routes or unrelated asset paths', () => {
    expect(activeKeys('/assets/preview')).toEqual([]);
    expect(activeKeys('/projects/42/assets')).toEqual(['projects']);
    expect(activeKeys('/projects/42/assets/7')).toEqual(['projects']);
    expect(activeKeys('/projects/42/asset-categories')).not.toContain('assets');
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

describe('navigation model — Releases active state', () => {
  it('is active on the release list', () => {
    expect(activeKeys('/releases')).toEqual(['releases']);
  });

  it('is active on the new, detail, edit, publish, and asset routes', () => {
    expect(activeKeys('/releases/new')).toEqual(['releases']);
    expect(activeKeys('/releases/9')).toEqual(['releases']);
    expect(activeKeys('/releases/9/edit')).toEqual(['releases']);
    expect(activeKeys('/releases/9/publish')).toEqual(['releases']);
    expect(activeKeys('/releases/9/assets')).toEqual(['releases']);
  });

  // Phase 2E: /release-management is the release-record list/board — it has
  // no separate sidebar item, so it stays grouped under Releases.
  it('is active on the release-management route', () => {
    expect(activeKeys('/release-management')).toEqual(['releases']);
    expect(activeKeys('/release-management?view=board')).toEqual(['releases']);
  });

  // Phase 2E: /calendar now has its own dedicated sidebar item and must not
  // activate Releases.
  it('is not active on the canonical calendar route', () => {
    expect(activeKeys('/calendar')).not.toContain('releases');
  });
});

describe('navigation model — calendar active state', () => {
  it('is active on the canonical calendar route', () => {
    expect(activeKeys('/calendar')).toEqual(['calendar']);
  });

  it('is not active on /calendarized (no broad prefix matching)', () => {
    expect(activeKeys('/calendarized')).toEqual([]);
  });

  it('is not active on /releases/calendar (a different path)', () => {
    expect(activeKeys('/releases/calendar')).not.toContain('calendar');
  });
});

describe('navigation model — Settings hierarchy', () => {
  function settingsItem(path, opts = {}) {
    return buildShellModel({ appName: APP_NAME, path, ...opts })
      .navigation.find((item) => item.key === 'settings');
  }

  function currentSettingsChildKeys(path, opts = {}) {
    return settingsItem(path, opts).children
      .filter((child) => child.current)
      .map((child) => child.key);
  }

  it('owns the nine Settings destinations in the required order', () => {
    const settings = NAVIGATION_ITEMS.find((item) => item.key === 'settings');

    expect(settings.children.map(({ key, label, href }) => ({ key, label, href }))).toEqual([
      { key: 'overview', label: 'Overview', href: '/settings' },
      { key: 'security', label: 'Security', href: '/settings/security' },
      { key: 'backups', label: 'Backups', href: '/settings/backups' },
      { key: 'logs', label: 'Logs', href: '/settings/logs' },
      { key: 'defaults', label: 'Defaults', href: '/settings/defaults' },
      { key: 'nsfw-filter', label: 'NSFW Filter', href: '/settings/nsfw-filter' },
      { key: 'asset-categories', label: 'Asset Categories', href: '/settings/asset-categories' },
      { key: 'tags', label: 'Tags', href: '/settings/tags' },
      { key: 'open-locally', label: 'Open locally', href: '/settings/open-locally' },
    ]);
  });

  it('keeps Settings section-active while mapping each direct and secondary route to one current child', () => {
    const routesByChild = {
      overview: ['/settings', '/settings?notice=maintenance_mode_enabled'],
      security: [
        '/settings/security',
        '/settings/security/password',
        '/settings/security/disable',
        '/settings/security/enable',
      ],
      backups: [
        '/settings/backups',
        '/settings/backups/creatorcrate-2026-01-01T000000Z.sqlite/restore',
        '/settings/backups/creatorcrate-2026-01-01T000000Z.sqlite/delete',
      ],
      logs: ['/settings/logs', '/settings/logs/defaults', '/settings/logs/clear'],
      defaults: ['/settings/defaults'],
      'nsfw-filter': ['/settings/nsfw-filter'],
      'asset-categories': [
        '/settings/asset-categories',
        '/settings/asset-categories/browser-default',
        '/settings/asset-categories/preview-category',
        '/settings/asset-categories/reorder',
        '/settings/asset-categories/7',
        '/settings/asset-categories/7/enabled',
        '/settings/asset-categories/7/delete',
        '/settings/asset-categories/7/move-up',
        '/settings/asset-categories/7/move-down',
      ],
      tags: [
        '/settings/tags',
        '/settings/tags/7/edit',
        '/settings/tags/7/delete',
      ],
      'open-locally': ['/settings/open-locally', '/settings/open-locally/clear'],
    };

    for (const [childKey, paths] of Object.entries(routesByChild)) {
      for (const path of paths) {
        const settings = settingsItem(path);
        expect(settings.active).toBe(true);
        expect(currentSettingsChildKeys(path)).toEqual([childKey]);
      }
    }
  });

  it('represents Settings as section-active and its child as current', () => {
    const settings = settingsItem('/settings');

    expect(settings.active).toBe(true);
    expect(settings).not.toHaveProperty('current');
    expect(currentSettingsChildKeys('/settings')).toEqual(['overview']);
  });

  it('does not activate Settings or any child for unrelated paths and sibling-prefix collisions', () => {
    for (const path of [
      '/settings-old',
      '/settingss',
      '/settings/security-old',
      '/settings/backups-old',
      '/settings/logs-old',
      '/settings/defaults-old',
      '/settings/nsfw-filtered',
      '/settings/asset-categories-old',
      '/settings/tags-old',
      '/settings/open-locally-old',
      '/settings/unknown',
      '/settings/backups/creatorcrate.sqlite/restore-old',
    ]) {
      expect(settingsItem(path).active).toBe(false);
      expect(currentSettingsChildKeys(path)).toEqual([]);
    }
  });

  it('suppresses both Settings section-active and child-current state when noActive is set', () => {
    const settings = settingsItem('/settings/logs/clear', { noActive: true });

    expect(settings.active).toBe(false);
    expect(currentSettingsChildKeys('/settings/logs/clear', { noActive: true })).toEqual([]);
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

  it('an unrelated sibling prefix does not activate calendar', () => {
    expect(activeKeys('/calendarized')).toEqual([]);
    expect(activeKeys('/calendar-old')).toEqual([]);
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
      '/assets',
      '/assets?view=list',
      '/releases',
      '/calendar',
      '/release-management',
      '/release-management?view=board',
      '/releases/3',
      '/releases/3/edit',
      '/releases/3/publish',
      '/releases/3/assets',
      '/releases/new',
      '/settings',
      '/settings/backups',
      '/settings/backups/creatorcrate-2026-01-01T000000Z.sqlite/restore',
    ];
    for (const p of paths) {
      expect(activeKeys(p)).toHaveLength(1);
    }
  });

  it('no item is active on an unrecognized top-level path', () => {
    expect(activeKeys('/nope')).toEqual([]);
    expect(activeKeys('/settings-old')).toEqual([]);
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
    expect(buildShellModel({ appName: APP_NAME, path: '/assets' }).activeSection).toBe('Asset Viewer');
    expect(buildShellModel({ appName: APP_NAME, path: '/releases/3/edit' }).activeSection).toBe('Releases');
    expect(buildShellModel({ appName: APP_NAME, path: '/calendar' }).activeSection).toBe('Calendar');
    expect(buildShellModel({ appName: APP_NAME, path: '/' }).activeSection).toBe('Dashboard');
  });

  it('activeSection is null when no item is active', () => {
    expect(buildShellModel({ appName: APP_NAME, path: '/settings-old' }).activeSection).toBeNull();
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
