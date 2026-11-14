import { describe, expect, beforeAll, afterAll, it } from 'vitest';
import os from 'node:os';
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetManifest } from '../src/asset-manifest.js';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
let testRoot;
let DIST_ROOT;
let MANIFEST_PATH;
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

  let compiled;

  beforeAll(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-vite-test-'));
    DIST_ROOT = path.join(testRoot, 'client');
    MANIFEST_PATH = path.join(DIST_ROOT, '.vite', 'manifest.json');
  });

  afterAll(() => {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  async function compile() {
    // Check before Vite can empty an output directory, including on a failed build.
    expect(path.relative(testRoot, DIST_ROOT), 'build output is test-owned').toBe('client');
    expect(path.relative(PROJECT_ROOT, DIST_ROOT).startsWith('..') || path.isAbsolute(path.relative(PROJECT_ROOT, DIST_ROOT)),
      'build output is outside the repository').toBe(true);
    if (!compiled) {
      compiled = await build({
        root: PROJECT_ROOT,
        configFile: path.join(PROJECT_ROOT, 'vite.config.js'),
        build: { outDir: DIST_ROOT },
        logLevel: 'silent',
      });
      manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    }
  }

  it('bundles the real CreatorCrate browser module and stylesheet through one hashed entry', async () => {
    await compile();
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
    for (const hook of [
      'data-unified-viewer', 'data-project-assets-preview-id', 'data-asset-library-preview-id',
      'data-asset-details-viewer-trigger', 'data-release-assets-viewer-trigger',
      'data-release-detail-viewer-trigger', 'data-project-detail-viewer-trigger',
      'data-unified-viewer-play', 'data-unified-viewer-speed', 'data-unified-viewer-direction',
      'data-unified-viewer-layout', 'requestFullscreen', 'pointercancel', 'touchmove',
      'lostpointercapture', 'prefers-reduced-motion',
    ]) expect(javascript, hook).toContain(hook);
    expect(javascript).not.toMatch(/data-slideshow-scaffold|__creatorCrateSlideshowState|slideshowBound|temporarySequenceActive/);
    expect(javascript).toMatch(/import\(/);
    expect(javascript).not.toContain('globalThis.toastui');
    expect(javascript).not.toContain('creatorcrateViteFoundation');
    expect(stylesheet).toMatch(/--bg\s*:/);
    expect(stylesheet).toContain('.asset-browser-layout');
    for (const selector of ['.unified-viewer-dialog', '.unified-viewer-stage', '.unified-viewer-controls', '.slideshow-trigger']) {
      expect(stylesheet, selector).toContain(selector);
    }
    expect(stylesheet).toMatch(/touch-action:\s*none/);
    expect(stylesheet).toContain('safe-area-inset-bottom');
    expect(stylesheet).not.toMatch(/\.slideshow-(?!trigger\b)[\w-]+|\[data-slideshow-/);
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

  it('keeps manifest references valid and bundles entry dependencies', async () => {
    await compile();
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

    const chunks = (Array.isArray(compiled) ? compiled : [compiled]).flatMap((result) => result.output)
      .filter((output) => output.type === 'chunk');
    const modules = chunks.flatMap((chunk) => Object.entries(chunk.modules))
      .filter(([, details]) => details.renderedLength > 0).map(([id]) => id.replaceAll('\\', '/'));
    for (const name of ['unified-viewer', 'viewer-content', 'viewer-viewport', 'viewer-fullscreen',
      'viewer-playback', 'viewer-sequence', 'comic-source', 'comic-reader-preferences', 'viewer-spread-layout',
      'project-assets-viewer', 'asset-library-viewer', 'asset-details-viewer', 'release-assets-viewer',
      'release-detail-viewer', 'project-detail-viewer']) {
      expect(modules.some((id) => id.endsWith(`/client/${name}.js`)), `${name} contributes compiled code`).toBe(true);
    }
    expect(modules.some((id) => id.endsWith('/client/slideshow.js'))).toBe(false);

    for (const file of javascriptFiles) {
      const source = fs.readFileSync(assetPath(file), 'utf8');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"`])(\.[^'"`]+)\1/g)) {
        expectNonEmptyAsset(path.posix.join(path.posix.dirname(file), match[2]));
      }
      expect(source).not.toMatch(/\bfrom\s*["'](?![./#])[^"']+["']/);
      expect(source).not.toMatch(/\bimport\s*\(\s*["'](?![./#])[^"']+["']\s*\)/);
      expect(source).not.toMatch(/\brequire\s*\(\s*["'](?![./#])[^"']+["']\s*\)/);
    }
  });

  it('resolves the actual Vite manifest through the backend asset helper', async () => {
    await compile();
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
