/**
 * CreatorCrate "Open locally" custom-protocol URI builder.
 *
 * Contract (v2):
 *   creatorcrate-open://open?v=2&path=<absolute-windows-path>&select=<0|1>
 *
 * Pure string utility: no filesystem or database access, and no knowledge of
 * PROJECTS_ROOT or any absolute container path. The absolute Windows path is
 * composed from the configured Windows projects root plus the project/asset
 * relative paths; invalid inputs return null instead of an unsafe URI.
 */

const OPEN_LOCALLY_SCHEME = 'creatorcrate-open';
const OPEN_LOCALLY_HOST = 'open';
const OPEN_LOCALLY_VERSION = '2';

const DRIVE_LETTER_PATTERN = /^[A-Za-z]:[\\/]/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isAbsoluteLike(value) {
  return value.startsWith('/') || value.startsWith('\\') || DRIVE_LETTER_PATTERN.test(value);
}

function hasTraversalSegment(value) {
  return value.split(/[\\/]/).some((segment) => segment === '..');
}

function hasControlCharacters(value) {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

function validateWindowsRoot(windowsRoot) {
  if (!isNonEmptyString(windowsRoot)) return null;
  if (!DRIVE_LETTER_PATTERN.test(windowsRoot)) return null;
  // The Windows helper rejects both '.' and '..' segments; the root must
  // never contain either.
  if (windowsRoot.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) return null;
  if (hasControlCharacters(windowsRoot)) return null;
  // Normalize to backslashes and strip trailing separators so the composed
  // path is a canonical Windows path.
  const normalized = windowsRoot.replace(/[\\/]+$/, '').replace(/\//g, '\\');
  // A bare drive root ("C:\") normalizes to "C:", which is not an absolute
  // Windows path; the settings service rejects it at save time, and the
  // Windows helper refuses it too.
  if (/^[A-Za-z]:$/.test(normalized)) return null;
  return normalized;
}

function hasAlternateDataStreamSyntax(value) {
  // The Windows helper rejects a colon in any non-drive segment because it
  // could be alternate data stream syntax; the drive segment is only ever
  // part of the windows root, never of these relative paths.
  return value.split(/[\\/]/).some((segment) => segment.includes(':'));
}

function validateProjectDir(projectDir) {
  if (!isNonEmptyString(projectDir)) return null;
  if (isAbsoluteLike(projectDir)) return null;
  if (hasTraversalSegment(projectDir)) return null;
  if (hasControlCharacters(projectDir)) return null;
  // project_dir is always a single direct-child segment of PROJECTS_ROOT.
  if (projectDir.includes('/') || projectDir.includes('\\')) return null;
  if (hasAlternateDataStreamSyntax(projectDir)) return null;
  return projectDir;
}

function validateCategoryDir(categoryDir) {
  if (!isNonEmptyString(categoryDir)) return null;
  if (isAbsoluteLike(categoryDir)) return null;
  if (hasTraversalSegment(categoryDir)) return null;
  if (hasControlCharacters(categoryDir)) return null;
  // A category's directory_slug is always a single direct-child segment of the
  // project folder (e.g. "final", "wm-lq").
  if (categoryDir.includes('/') || categoryDir.includes('\\')) return null;
  if (hasAlternateDataStreamSyntax(categoryDir)) return null;
  return categoryDir;
}

function validateAssetRelativePath(assetRelativePath) {
  if (!isNonEmptyString(assetRelativePath)) return null;
  if (isAbsoluteLike(assetRelativePath)) return null;
  if (hasTraversalSegment(assetRelativePath)) return null;
  if (hasControlCharacters(assetRelativePath)) return null;
  if (hasAlternateDataStreamSyntax(assetRelativePath)) return null;
  return assetRelativePath.replace(/\\/g, '/');
}

/**
 * Absolute Windows path composed from the configured Windows projects root:
 *   windowsRoot\project_dir                          (project folder)
 *   windowsRoot\project_dir\category_dir             (one category's folder)
 *   windowsRoot\project_dir\relative_path            (a specific asset)
 * `assetRelativePath` takes precedence over `categoryDir` (an asset already
 * carries its own category segment). Returns null for invalid input.
 */
export function buildOpenLocallyPath({ windowsRoot, projectDir, categoryDir, assetRelativePath } = {}) {
  const root = validateWindowsRoot(windowsRoot);
  if (root === null) return null;
  const dir = validateProjectDir(projectDir);
  if (dir === null) return null;

  if (assetRelativePath !== undefined && assetRelativePath !== null) {
    const rel = validateAssetRelativePath(assetRelativePath);
    if (rel === null) return null;
    return `${root}\\${dir}\\${rel}`;
  }

  if (categoryDir !== undefined && categoryDir !== null) {
    const category = validateCategoryDir(categoryDir);
    if (category === null) return null;
    return `${root}\\${dir}\\${category}`;
  }

  return `${root}\\${dir}`;
}

/**
 * Build the "Open locally" URI. Opens a folder (select=0) for a project or a
 * category directory, or reveals an asset (select=1). Returns null for invalid
 * input.
 */
export function buildOpenLocallyUri({ windowsRoot, projectDir, categoryDir, assetRelativePath } = {}) {
  const path = buildOpenLocallyPath({ windowsRoot, projectDir, categoryDir, assetRelativePath });
  if (path === null) return null;
  const select = assetRelativePath === undefined || assetRelativePath === null ? '0' : '1';
  const query = `v=${OPEN_LOCALLY_VERSION}&path=${encodeURIComponent(path)}&select=${select}`;
  return `${OPEN_LOCALLY_SCHEME}://${OPEN_LOCALLY_HOST}?${query}`;
}
