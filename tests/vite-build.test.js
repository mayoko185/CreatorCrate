import { describe, expect, beforeAll, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetManifest } from '../src/asset-manifest.js';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST_ROOT = path.join(PROJECT_ROOT, 'dist', 'client');
const MANIFEST_PATH = path.join(DIST_ROOT, '.vite', 'manifest.json');
const ENTRY_KEY = 'client/main.js';

function list(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function assetPath(asset) {
  expect(typeof asset).toBe('string');
  expect(path.isAbsolute(asset)).toBe(false);
  expect(asset.startsWith('../')).toBe(false);
  return path.join(DIST_ROOT, ...asset.split('/'));
}

function expectNonEmptyAsset(asset) {
  const filePath = assetPath(asset);
  expect(fs.existsSync(filePath)).toBe(true);
  expect(fs.statSync(filePath).size).toBeGreaterThan(0);
}

function manifestDependencyKeys(record) {
  return [...list(record.imports), ...list(record.dynamicImports)];
}

describe('Vite 8 CreatorCrate browser build', () => {
  let manifest;

  beforeAll(() => {
    const buildCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm';
    const buildArguments = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'];
    execFileSync(buildCommand, buildArguments, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  });

  it('bundles the real CreatorCrate browser module and stylesheet through one hashed entry', () => {
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);

    const entry = manifest[ENTRY_KEY];
    expect(entry).toBeDefined();
    expect(entry.src).toBe(ENTRY_KEY);
    expect(entry.isEntry).toBe(true);
    expect(entry.file).toMatch(/^assets\/main-[A-Za-z0-9_-]+\.js$/);

    const cssFiles = list(entry.css);
    expect(cssFiles).toHaveLength(1);
    expect(cssFiles[0]).toMatch(/^assets\/main-[A-Za-z0-9_-]+\.css$/);

    expectNonEmptyAsset(entry.file);
    expectNonEmptyAsset(cssFiles[0]);

    const javascript = fs.readFileSync(assetPath(entry.file), 'utf8');
    const stylesheet = fs.readFileSync(assetPath(cssFiles[0]), 'utf8');
    expect(javascript).toContain('data-preview-enhancement');
    expect(javascript).toContain('data-slideshow-scaffold');
    expect(javascript).toMatch(/import\(/);
    expect(javascript).not.toContain('globalThis.toastui');
    expect(javascript).not.toContain('creatorcrateViteFoundation');
    expect(stylesheet).toMatch(/--bg\s*:/);
    expect(stylesheet).toContain('.asset-browser-layout');
    expect(stylesheet).not.toContain('--creatorcrate-vite-foundation');

    const javascriptEntries = Object.values(manifest).filter(
      (record) => record.isEntry === true && record.file?.endsWith('.js')
    );
    expect(javascriptEntries).toHaveLength(1);

    const dynamicEditorKeys = list(entry.dynamicImports);
    expect(dynamicEditorKeys).toHaveLength(1);
    const dynamicEditor = manifest[dynamicEditorKeys[0]];
    expect(dynamicEditor).toBeDefined();
    expect(dynamicEditor.isDynamicEntry).toBe(true);
    expect(dynamicEditor.src).toMatch(/@toast-ui\/editor\/dist\/esm\/index\.js$/);
    expectNonEmptyAsset(dynamicEditor.file);
    expect(javascript).toContain('`/vite/`');
    expect(javascript).toContain(`import(\`./${path.basename(dynamicEditor.file)}\`)`);

    const editorStyles = Object.values(manifest).filter(
      (record) => record.src?.includes('@toast-ui/editor/dist/') && record.file?.endsWith('.css')
    );
    expect(editorStyles.map((record) => record.src)).toEqual(expect.arrayContaining([
      expect.stringMatching(/@toast-ui\/editor\/dist\/toastui-editor\.css$/),
      expect.stringMatching(/@toast-ui\/editor\/dist\/theme\/toastui-editor-dark\.css$/),
    ]));
    editorStyles.forEach((record) => expectNonEmptyAsset(record.file));
  });

  it('keeps manifest references valid and bundles entry dependencies', () => {
    const javascriptFiles = new Set();

    for (const record of Object.values(manifest)) {
      if (record.file) {
        expectNonEmptyAsset(record.file);
        if (record.file.endsWith('.js')) javascriptFiles.add(record.file);
      }
      for (const asset of [...list(record.css), ...list(record.assets)]) {
        expectNonEmptyAsset(asset);
      }
      for (const dependencyKey of manifestDependencyKeys(record)) {
        expect(manifest[dependencyKey]).toBeDefined();
      }
    }

    for (const file of javascriptFiles) {
      const source = fs.readFileSync(assetPath(file), 'utf8');
      expect(source).not.toMatch(/\bfrom\s*["'](?![./#])[^"']+["']/);
      expect(source).not.toMatch(/\bimport\s*\(\s*["'](?![./#])[^"']+["']\s*\)/);
      expect(source).not.toMatch(/\brequire\s*\(\s*["'](?![./#])[^"']+["']\s*\)/);
    }
  });

  it('resolves the actual Vite manifest through the backend asset helper', () => {
    const assets = createAssetManifest({
      manifestPath: MANIFEST_PATH,
      distRoot: DIST_ROOT,
      requiredEntries: [ENTRY_KEY],
    });
    const entry = assets.entry(ENTRY_KEY);

    expect(entry.js).toBe(`/vite/${manifest[ENTRY_KEY].file}`);
    expect(entry.css).toEqual(manifest[ENTRY_KEY].css.map((file) => `/vite/${file}`));
    expect(entry.preload).toEqual([]);
    expect(entry.assets).toEqual([]);
  });
});
