import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AssetManifestError,
  createAssetManifest,
  VITE_ENTRY_KEY,
} from '../src/asset-manifest.js';
import { loadProductionAssetManifest } from '../src/server.js';

function createFixtureManifest() {
  return {
    'common.js': {
      file: 'assets/common-C.js',
      css: ['assets/common.css'],
      assets: ['assets/common.svg'],
      imports: ['shared.js'],
    },
    'shared.js': {
      file: 'assets/shared-S.js',
      css: ['assets/common.css', 'assets/shared.css'],
      assets: ['assets/common.svg', 'assets/shared.svg'],
      imports: ['common.js'],
    },
    [VITE_ENTRY_KEY]: {
      file: 'assets/main-M.js',
      src: VITE_ENTRY_KEY,
      name: 'main',
      isEntry: true,
      css: ['assets/main.css', 'assets/common.css'],
      assets: ['assets/shared.svg'],
      imports: ['shared.js', 'common.js'],
    },
  };
}

describe('Vite asset manifest resolver', () => {
  let tmpDir;
  let distRoot;
  let manifestPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-manifest-'));
    distRoot = path.join(tmpDir, 'client');
    manifestPath = path.join(distRoot, '.vite', 'manifest.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(manifest) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }

  function load(manifest = createFixtureManifest(), options = {}) {
    writeManifest(manifest);
    return createAssetManifest({
      manifestPath,
      distRoot,
      requiredEntries: [VITE_ENTRY_KEY],
      ...options,
    });
  }

  it('loads a valid manifest and resolves entry JavaScript plus direct CSS', () => {
    const manifest = {
      [VITE_ENTRY_KEY]: {
        file: 'assets/main-HASH.js',
        src: VITE_ENTRY_KEY,
        isEntry: true,
        css: ['assets/main-HASH.css'],
      },
    };
    const assets = load(manifest);

    expect(assets.entry(VITE_ENTRY_KEY)).toEqual({
      js: '/vite/assets/main-HASH.js',
      css: ['/vite/assets/main-HASH.css'],
      preload: [],
      assets: [],
    });
  });

  it('loads a valid manifest through the production startup policy', () => {
    writeManifest(createFixtureManifest());
    const assets = loadProductionAssetManifest({ manifestPath, distRoot });

    expect(assets.entry(VITE_ENTRY_KEY)).toEqual({
      js: '/vite/assets/main-M.js',
      css: [
        '/vite/assets/common.css',
        '/vite/assets/shared.css',
        '/vite/assets/main.css',
      ],
      preload: ['/vite/assets/common-C.js', '/vite/assets/shared-S.js'],
      assets: ['/vite/assets/common.svg', '/vite/assets/shared.svg'],
    });
  });

  it('traverses static imports in deterministic dependency order and deduplicates CSS/assets', () => {
    const assets = load();

    expect(assets.entry(VITE_ENTRY_KEY)).toEqual({
      js: '/vite/assets/main-M.js',
      css: [
        '/vite/assets/common.css',
        '/vite/assets/shared.css',
        '/vite/assets/main.css',
      ],
      preload: [
        '/vite/assets/common-C.js',
        '/vite/assets/shared-S.js',
      ],
      assets: [
        '/vite/assets/common.svg',
        '/vite/assets/shared.svg',
      ],
    });
  });

  it('fails with a controlled error for an unknown or non-entry key', () => {
    const assets = load();

    expect(() => assets.entry('client/missing.js')).toThrow(AssetManifestError);
    expect(() => assets.entry('client/missing.js')).toThrow(/was not found/);
    expect(() => assets.entry('shared.js')).toThrow(AssetManifestError);
    expect(() => assets.entry('shared.js')).toThrow(/not an entry/);
  });

  it('fails clearly when a required entry is absent', () => {
    writeManifest({
      'other.js': { file: 'assets/other.js', isEntry: true },
    });

    expect(() => createAssetManifest({
      manifestPath,
      distRoot,
      requiredEntries: [VITE_ENTRY_KEY],
    })).toThrow(/Required Vite asset manifest entry "client\/main\.js" is missing/);
  });

  it('fails clearly for malformed JSON', () => {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{not-json');

    expect(() => createAssetManifest({ manifestPath, distRoot })).toThrow(AssetManifestError);
    expect(() => createAssetManifest({ manifestPath, distRoot })).toThrow(/is not valid JSON/);
  });

  it('does not hide malformed manifests from the production startup policy', () => {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{not-json');

    expect(() => loadProductionAssetManifest({ manifestPath, distRoot })).toThrow(AssetManifestError);
    expect(() => loadProductionAssetManifest({ manifestPath, distRoot })).toThrow(/is not valid JSON/);
  });

  it('fails clearly when the manifest is missing', () => {
    expect(() => createAssetManifest({ manifestPath, distRoot })).toThrow(AssetManifestError);
    expect(() => createAssetManifest({ manifestPath, distRoot })).toThrow(/production asset manifest is missing/);
  });

  it('fails clearly when production startup is missing the manifest', () => {
    expect(() => loadProductionAssetManifest({ manifestPath, distRoot })).toThrow(AssetManifestError);
    expect(() => loadProductionAssetManifest({ manifestPath, distRoot })).toThrow(/production asset manifest is missing/);
  });

  it('rejects asset paths and requested entries that could escape the expected root', () => {
    writeManifest({
      [VITE_ENTRY_KEY]: {
        file: '../outside.js',
        isEntry: true,
      },
    });

    expect(() => createAssetManifest({ manifestPath, distRoot })).toThrow(AssetManifestError);
    expect(() => createAssetManifest({ manifestPath, distRoot })).toThrow(/safe relative path|path segments|remain inside/);

    const assets = load({
      [VITE_ENTRY_KEY]: {
        file: 'assets/main.js',
        isEntry: true,
      },
    });
    expect(() => assets.entry('../outside.js')).toThrow(AssetManifestError);
    expect(() => assets.entry('../outside.js')).toThrow(/safe relative path|path segments/);
  });
});
