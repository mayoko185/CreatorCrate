/**
 * Phase 10.4A — Central application-shell navigation model.
 *
 * One declarative source of truth for the top-level navigation areas. The
 * desktop sidebar (Phase 10.4B) and the mobile navigation will both consume
 * this model; neither should re-derive destinations or active-state rules.
 *
 * Constraints enforced here (see phase spec):
 *  - Only routes that actually render pages are listed — no dead links.
 *    `/health` is JSON-only and therefore intentionally absent.
 *  - Active matching is segment-aware, not a naive string prefix, so a
 *    sibling path like "/projects-old" never activates the "projects" item.
 *  - The model is computed server-side per request; there is no client-side
 *    route detection.
 *
 * Route → service boundary: this module knows only about paths and labels.
 * It never touches the repository or database.
 */

/**
 * Navigation item shape:
 *   key     — stable identifier (also used as the icon key and data-nav-key)
 *   label   — visible text
 *   href    — destination URL (must resolve to a real GET page route)
 *   icon    — semantic icon key consumed by the icon partial
 *   matches — array of ":param" path patterns that activate this item
 *
 * A pattern segment of ":name" matches exactly one non-empty path segment.
 * Matching requires equal segment counts (no partial match), which is what
 * keeps "/projects-old" from matching "/projects".
 */
const NAVIGATION_ITEMS = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    href: '/',
    icon: 'dashboard',
    matches: ['/'],
  },
  {
    key: 'projects',
    label: 'Projects',
    href: '/projects',
    icon: 'projects',
    matches: [
      '/projects',
      '/projects/new',
      '/projects/:id',
      '/projects/:id/edit',
      '/projects/:id/assets',
      '/projects/:projectId/assets/:assetId',
    ],
  },
  {
    key: 'releases',
    label: 'Published Work',
    href: '/releases',
    icon: 'releases',
    // Phase 2E: /releases is Published Work; /release-management (the
    // release-record list/board) and every release-record route stay
    // grouped under this item. /calendar now has its own dedicated sidebar
    // item (below) rather than being grouped here.
    matches: [
      '/releases',
      '/releases/new',
      '/releases/:id',
      '/releases/:id/edit',
      '/releases/:id/publish',
      '/releases/:id/assets',
      '/release-management',
    ],
  },
  {
    key: 'calendar',
    label: 'Calendar',
    href: '/calendar',
    icon: 'calendar',
    // Phase 2E: the canonical project-backed calendar route gets its own
    // dedicated primary-navigation item, discoverable independently of
    // Published Work.
    matches: ['/calendar'],
  },
  {
    key: 'settings',
    label: 'Settings',
    href: '/settings',
    icon: 'settings',
    matches: [
      '/settings',
      '/settings/backups',
      '/settings/backups/:filename/restore',
      '/settings/backups/:filename/delete',
      '/settings/security',
      '/settings/security/disable',
      '/settings/defaults',
    ],
  },
];

/**
 * Split a path into its non-empty segments, discarding any query string.
 *   "/"                  → []
 *   "/projects"          → ["projects"]
 *   "/projects/5/assets" → ["projects", "5", "assets"]
 *   "/projects?status=1" → ["projects"]
 *
 * @param {string} input
 * @returns {string[]}
 */
function splitSegments(input) {
  const path = typeof input === 'string' ? input.split('?')[0] : '';
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * Test whether a concrete request path matches a single ":param" pattern.
 * Segment counts must be equal; a ":name" segment matches any non-empty
 * path segment. Literal segments must match exactly.
 *
 * @param {string} pattern
 * @param {string} requestPath
 * @returns {boolean}
 */
export function pathMatchesPattern(pattern, requestPath) {
  const patternSegments = splitSegments(pattern);
  const pathSegments = splitSegments(requestPath);
  if (patternSegments.length !== pathSegments.length) return false;
  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i];
    if (segment.startsWith(':')) {
      if (pathSegments[i] === '') return false;
      continue;
    }
    if (segment !== pathSegments[i]) return false;
  }
  return true;
}

/**
 * True when the request path matches any of the item's declared patterns.
 *
 * @param {string[]} matchPatterns
 * @param {string} requestPath
 * @returns {boolean}
 */
export function isPathActive(matchPatterns, requestPath) {
  return matchPatterns.some((pattern) => pathMatchesPattern(pattern, requestPath));
}

/**
 * Build the shared shell view-model for a request.
 *
 * Exposed to layout.njk via `res.locals.shell` (set in app.js middleware) so
 * every rendered page — and the centralized error handler — receives one
 * consistent navigation model without any per-route assembly.
 *
 * @param {object} opts
 * @param {string} opts.appName
 * @param {string} opts.path        - req.path
 * @param {boolean} [opts.noActive] - when true, no item is marked active
 *   (used for controlled error / not-found pages so a missing record never
 *   highlights a section it never reached).
 * @returns {{
 *   appName: string,
 *   pageTitle: string,
 *   activeSection: string|null,
 *   currentPath: string,
 *   navigation: Array<{ key: string, label: string, href: string, icon: string, active: boolean }>
 * }}
 */
export function buildShellModel({ appName, path, noActive = false }) {
  const navigation = NAVIGATION_ITEMS.map((item) => ({
    key: item.key,
    label: item.label,
    href: item.href,
    icon: item.icon,
    active: noActive ? false : isPathActive(item.matches, path),
  }));

  // Phase 10.4B: the active item's label feeds the desktop shell header as a
  // section title. Computed here (not in the template) so Nunjucks never has
  // to search the navigation array — the model stays the single source of
  // truth. Null when no item is active (root-relative 404 / controlled
  // not-found), so the header falls back to the app name.
  const activeItem = navigation.find((n) => n.active) || null;

  return {
    appName,
    // Shell-level title context. Defaults to the app name; a page may still
    // override the document title via its own {% block title %}.
    pageTitle: appName,
    activeSection: activeItem ? activeItem.label : null,
    currentPath: path,
    navigation,
  };
}

export { NAVIGATION_ITEMS };
