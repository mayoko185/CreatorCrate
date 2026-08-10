import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VITE_ENTRY_KEY = 'client/main.js';
export const VITE_PUBLIC_PATH = '/vite';
export const VITE_DIST_ROOT = fileURLToPath(new URL('../dist/client', import.meta.url));
export const VITE_MANIFEST_PATH = path.join(VITE_DIST_ROOT, '.vite', 'manifest.json');
export const VITE_DEV_CLIENT_PATH = '/@vite/client';
export const VITE_DEV_ENTRY_PATH = `/${VITE_ENTRY_KEY}`;
export const VITE_DEV_ASSETS = Object.freeze({
  client: VITE_DEV_CLIENT_PATH,
  entry: VITE_DEV_ENTRY_PATH,
});

const IMPORT_FIELDS = ['imports', 'dynamicImports'];

export class AssetManifestError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AssetManifestError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new AssetManifestError(code, message, options);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLogicalPath(value, label, code = 'MANIFEST_MALFORMED') {
  if (typeof value !== 'string' || value.length === 0) {
    fail(code, `${label} must be a non-empty relative path.`);
  }

  if (
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('%') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes(':') ||
    value.startsWith('/')
  ) {
    fail(code, `${label} must be a safe relative path without URL or path traversal syntax.`);
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail(code, `${label} must not contain empty, ".", or ".." path segments.`);
  }

  return value;
}

function normalizeAssetPath(value, label, distRoot) {
  const normalized = normalizeLogicalPath(value, label);
  const candidate = path.resolve(distRoot, ...normalized.split('/'));
  const relative = path.relative(distRoot, candidate);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('MANIFEST_PATH_ESCAPE', `${label} must remain inside the Vite asset root "${distRoot}".`);
  }

  return normalized;
}

function normalizePublicBasePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\')) {
    fail('INVALID_CONFIGURATION', 'Vite asset publicBasePath must be an absolute URL path.');
  }

  const normalized = value.replace(/\/+$/, '') || '/';
  normalizeLogicalPath(normalized.slice(1) || 'root', 'Vite asset publicBasePath');
  return normalized;
}

function normalizeOptionalString(record, field, entryKey) {
  if (!Object.hasOwn(record, field)) return undefined;
  if (typeof record[field] !== 'string') {
    fail('MANIFEST_MALFORMED', `Manifest entry "${entryKey}" field "${field}" must be a string.`);
  }
  return record[field];
}

function normalizeOptionalBoolean(record, field, entryKey) {
  if (!Object.hasOwn(record, field)) return undefined;
  if (typeof record[field] !== 'boolean') {
    fail('MANIFEST_MALFORMED', `Manifest entry "${entryKey}" field "${field}" must be a boolean.`);
  }
  return record[field];
}

function normalizeStringList(record, field, entryKey, normalize) {
  if (!Object.hasOwn(record, field)) return [];
  if (!Array.isArray(record[field]) || record[field].some((value) => typeof value !== 'string')) {
    fail('MANIFEST_MALFORMED', `Manifest entry "${entryKey}" field "${field}" must be an array of strings.`);
  }
  return Object.freeze(record[field].map((value, index) => normalize(value, `Manifest entry "${entryKey}" field "${field}" item ${index}`)));
}

function parseManifest(rawText, manifestPath, distRoot) {
  let rawManifest;
  try {
    rawManifest = JSON.parse(rawText);
  } catch (err) {
    fail(
      'MANIFEST_MALFORMED',
      `Vite asset manifest at "${manifestPath}" is not valid JSON: ${err.message}`,
      { cause: err },
    );
  }

  if (!isRecord(rawManifest)) {
    fail('MANIFEST_MALFORMED', `Vite asset manifest at "${manifestPath}" must contain a JSON object.`);
  }

  const records = Object.create(null);
  for (const [entryKey, rawRecord] of Object.entries(rawManifest)) {
    normalizeLogicalPath(entryKey, `Manifest entry key "${entryKey}"`);
    if (!isRecord(rawRecord)) {
      fail('MANIFEST_MALFORMED', `Manifest entry "${entryKey}" must contain an object.`);
    }

    if (typeof rawRecord.file !== 'string') {
      fail('MANIFEST_MALFORMED', `Manifest entry "${entryKey}" must contain a string "file" field.`);
    }

    const src = normalizeOptionalString(rawRecord, 'src', entryKey);
    const name = normalizeOptionalString(rawRecord, 'name', entryKey);
    const isEntry = normalizeOptionalBoolean(rawRecord, 'isEntry', entryKey);
    const isDynamicEntry = normalizeOptionalBoolean(rawRecord, 'isDynamicEntry', entryKey);

    records[entryKey] = Object.freeze({
      file: normalizeAssetPath(rawRecord.file, `Manifest entry "${entryKey}" file`, distRoot),
      src: src === undefined ? undefined : normalizeLogicalPath(src, `Manifest entry "${entryKey}" src`),
      name,
      isEntry,
      isDynamicEntry,
      css: normalizeStringList(
        rawRecord,
        'css',
        entryKey,
        (value, label) => normalizeAssetPath(value, label, distRoot),
      ),
      assets: normalizeStringList(
        rawRecord,
        'assets',
        entryKey,
        (value, label) => normalizeAssetPath(value, label, distRoot),
      ),
      imports: normalizeStringList(rawRecord, 'imports', entryKey, (value, label) => normalizeLogicalPath(value, label)),
      dynamicImports: normalizeStringList(
        rawRecord,
        'dynamicImports',
        entryKey,
        (value, label) => normalizeLogicalPath(value, label),
      ),
    });
  }

  for (const [entryKey, record] of Object.entries(records)) {
    for (const field of IMPORT_FIELDS) {
      for (const importedKey of record[field]) {
        if (!Object.hasOwn(records, importedKey)) {
          fail(
            'MANIFEST_MALFORMED',
            `Manifest entry "${entryKey}" field "${field}" references unknown entry "${importedKey}".`,
          );
        }
      }
    }
  }

  return Object.freeze(records);
}

function readManifest(manifestPath, distRoot) {
  let rawText;
  try {
    rawText = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(
        'MANIFEST_MISSING',
        `Vite production asset manifest is missing at "${manifestPath}". Run pnpm build before starting in production.`,
        { cause: err },
      );
    }
    fail(
      'MANIFEST_READ_FAILED',
      `Vite asset manifest at "${manifestPath}" could not be read: ${err.message}`,
      { cause: err },
    );
  }

  return parseManifest(rawText, manifestPath, distRoot);
}

function collectStaticImports(manifest, entryKey) {
  const importedChunks = [];
  const seen = new Set([entryKey]);

  function visit(importedKey) {
    if (seen.has(importedKey)) return;
    seen.add(importedKey);

    const importedChunk = manifest[importedKey];
    for (const nestedKey of importedChunk.imports) visit(nestedKey);
    importedChunks.push(importedChunk);
  }

  for (const importedKey of manifest[entryKey].imports) visit(importedKey);
  return importedChunks;
}

function createPublicUrl(publicBasePath, assetPath) {
  return publicBasePath === '/' ? `/${assetPath}` : `${publicBasePath}/${assetPath}`;
}

export function createAssetManifest({
  manifestPath = VITE_MANIFEST_PATH,
  distRoot = VITE_DIST_ROOT,
  publicBasePath = VITE_PUBLIC_PATH,
  requiredEntries = [],
} = {}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const resolvedDistRoot = path.resolve(distRoot);
  const normalizedPublicBasePath = normalizePublicBasePath(publicBasePath);
  if (!Array.isArray(requiredEntries)) {
    fail('INVALID_CONFIGURATION', 'Vite asset manifest requiredEntries must be an array.');
  }

  const manifest = readManifest(resolvedManifestPath, resolvedDistRoot);
  for (const entryKey of requiredEntries) {
    const normalizedEntryKey = normalizeLogicalPath(entryKey, 'Required Vite asset entry', 'INVALID_CONFIGURATION');
    if (!Object.hasOwn(manifest, normalizedEntryKey)) {
      fail(
        'REQUIRED_ENTRY_MISSING',
        `Required Vite asset manifest entry "${normalizedEntryKey}" is missing from "${resolvedManifestPath}".`,
      );
    }
    if (manifest[normalizedEntryKey].isEntry !== true) {
      fail(
        'REQUIRED_ENTRY_NOT_ENTRY',
        `Required Vite asset manifest key "${normalizedEntryKey}" is not marked as an entry in "${resolvedManifestPath}".`,
      );
    }
  }

  return Object.freeze({
    entry(entryKey) {
      const normalizedEntryKey = normalizeLogicalPath(entryKey, 'Requested Vite asset entry', 'INVALID_ENTRY');
      if (!Object.hasOwn(manifest, normalizedEntryKey)) {
        fail(
          'UNKNOWN_ENTRY',
          `Vite asset manifest entry "${normalizedEntryKey}" was not found in "${resolvedManifestPath}".`,
        );
      }
      if (manifest[normalizedEntryKey].isEntry !== true) {
        fail(
          'NOT_ENTRY',
          `Vite asset manifest key "${normalizedEntryKey}" is not an entry and cannot be resolved through assets.entry().`,
        );
      }

      const entryRecord = manifest[normalizedEntryKey];
      const importedChunks = collectStaticImports(manifest, normalizedEntryKey);
      const orderedChunks = [...importedChunks, entryRecord];
      const css = [];
      const assets = [];
      const seenCss = new Set();
      const seenAssets = new Set();

      for (const chunk of orderedChunks) {
        for (const cssPath of chunk.css) {
          if (seenCss.has(cssPath)) continue;
          seenCss.add(cssPath);
          css.push(createPublicUrl(normalizedPublicBasePath, cssPath));
        }
        for (const assetPath of chunk.assets) {
          if (seenAssets.has(assetPath)) continue;
          seenAssets.add(assetPath);
          assets.push(createPublicUrl(normalizedPublicBasePath, assetPath));
        }
      }

      return Object.freeze({
        js: createPublicUrl(normalizedPublicBasePath, entryRecord.file),
        css: Object.freeze(css),
        preload: Object.freeze(importedChunks.map((chunk) => createPublicUrl(normalizedPublicBasePath, chunk.file))),
        assets: Object.freeze(assets),
      });
    },
  });
}

export function createUnavailableAssetManifest() {
  return Object.freeze({
    entry() {
      fail(
        'MANIFEST_NOT_CONFIGURED',
        'Vite asset resolution is not configured outside production. Build and inject the production manifest before using viteAssets.',
      );
    },
  });
}
