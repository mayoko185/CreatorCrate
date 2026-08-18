import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import {
  createAssetManifest,
  VITE_DEV_ASSETS,
  VITE_ENTRY_KEY,
} from '../src/asset-manifest.js';
import { ASSET_MODES } from '../src/app.js';
import { DEVELOPMENT_SECURITY_CSP, SECURITY_CSP } from '../src/middleware/security-headers.js';
import { loadProductionAssetManifest } from '../src/server.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Vite production asset app integration', () => {
  let tmpDir;
  let appDataRoot;
  let distRoot;
  let db;
  let app;
  let assets;
  let manifestPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-vite-http-'));
    appDataRoot = path.join(tmpDir, 'app');
    distRoot = path.join(tmpDir, 'dist', 'client');
    fs.mkdirSync(appDataRoot, { recursive: true });
    fs.mkdirSync(path.join(distRoot, 'assets'), { recursive: true });

    fs.writeFileSync(path.join(distRoot, 'assets', 'main-TEST.js'), 'window.__creatorcrateViteTest = true;');
    fs.writeFileSync(path.join(distRoot, 'assets', 'shared-TEST.js'), 'window.__creatorcrateViteSharedTest = true;');
    fs.writeFileSync(path.join(distRoot, 'assets', 'main-TEST.css'), 'body { color: rebeccapurple; }');
    fs.writeFileSync(path.join(distRoot, 'assets', 'shared-TEST.css'), 'body { background: black; }');
    manifestPath = path.join(distRoot, '.vite', 'manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
      'client/shared.js': {
        file: 'assets/shared-TEST.js',
        css: ['assets/shared-TEST.css'],
      },
      [VITE_ENTRY_KEY]: {
        file: 'assets/main-TEST.js',
        src: VITE_ENTRY_KEY,
        isEntry: true,
        css: ['assets/main-TEST.css', 'assets/shared-TEST.css'],
        imports: ['client/shared.js'],
      },
    }));

    assets = createAssetManifest({
      manifestPath,
      distRoot,
      requiredEntries: [VITE_ENTRY_KEY],
    });
    db = openDatabase(path.join(appDataRoot, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp(
      { appName: 'CreatorCrate', db },
      { appDataRoot, assetManifest: assets, assetMode: ASSET_MODES.PRODUCTION, viteDistRoot: distRoot },
    );
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves manifest-generated JavaScript with its content type and immutable cache policy', async () => {
    const response = await request(app).get(assets.entry(VITE_ENTRY_KEY).js).expect(200);

    expect(response.text).toContain('creatorcrateViteTest');
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('serves manifest-generated CSS with its content type', async () => {
    const entry = assets.entry(VITE_ENTRY_KEY);
    const response = await request(app).get(entry.css[entry.css.length - 1]).expect(200);

    expect(response.text).toContain('rebeccapurple');
    expect(response.headers['content-type']).toMatch(/^text\/css/);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('does not expose the private manifest directory and keeps the old static assets live', async () => {
    await request(app).get('/vite/.vite/manifest.json').expect(404);

    const javascript = await request(app).get('/creatorcrate.js').expect(200);
    const stylesheet = await request(app).get('/creatorcrate.css').expect(200);
    expect(javascript.headers['content-type']).toMatch(/javascript/);
    expect(stylesheet.headers['content-type']).toMatch(/^text\/css/);
  });

  it('renders production HTML from every manifest CSS and static preload URL, with page assets preserved', async () => {
    const entry = assets.entry(VITE_ENTRY_KEY);
    const response = await request(app).get('/notes/new').expect(200);

    for (const stylesheetUrl of entry.css) {
      const tag = `<link rel="stylesheet" href="${stylesheetUrl}">`;
      expect(response.text).toContain(tag);
      expect(response.text.split(tag).length - 1).toBe(1);
    }
    for (const preloadUrl of entry.preload) {
      const tag = `<link rel="modulepreload" href="${preloadUrl}">`;
      expect(response.text).toContain(tag);
      expect(response.text.split(tag).length - 1).toBe(1);
    }
    expect(response.text).toContain(`<script type="module" src="${entry.js}"></script>`);
    expect(response.text).not.toContain('/vendor/toast-ui/editor/');
    expect(response.text).not.toContain('href="/creatorcrate.css"');
    expect(response.text).not.toContain('src="/creatorcrate.js"');
    expect(response.text).not.toContain('/@vite/client');
    expect(response.headers['content-security-policy']).toBe(SECURITY_CSP);
    expect(response.headers['content-security-policy']).toContain("img-src 'self' data: blob:");
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).not.toContain("script-src 'self' blob:");
  });

  it('renders same-origin Vite development client and source entry without legacy main assets', async () => {
    const developmentApp = createApp(
      { appName: 'CreatorCrate', db },
      { appDataRoot, assetManifest: assets, assetMode: ASSET_MODES.DEVELOPMENT, viteDistRoot: distRoot },
    );
    const response = await request(developmentApp).get('/').expect(200);

    expect(response.text).toContain(`<script type="module" src="${VITE_DEV_ASSETS.client}"></script>`);
    expect(response.text).toContain(`<script type="module" src="${VITE_DEV_ASSETS.entry}"></script>`);
    expect(response.text).not.toContain('<link rel="stylesheet" href="/creatorcrate.css">');
    expect(response.text).not.toContain('<script type="module" src="/creatorcrate.js"></script>');
    expect(response.text).not.toContain('/vite/assets/main-TEST.js');
    expect(response.text).not.toContain('/vite/assets/main-TEST.css');
    expect(response.headers['content-security-policy']).toBe(DEVELOPMENT_SECURITY_CSP);
    expect(response.headers['content-security-policy']).toContain("img-src 'self' data: blob:");
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).not.toContain("script-src 'self' blob:");
  });

  it('fails production startup clearly when the manifest is absent', () => {
    fs.rmSync(manifestPath);
    expect(() => loadProductionAssetManifest({ manifestPath, distRoot })).toThrow(/production asset manifest is missing/);
  });

  it('keeps the legacy main assets for explicit non-production rendering', async () => {
    const legacyApp = createApp(
      { appName: 'CreatorCrate', db },
      { appDataRoot, assetManifest: assets, assetMode: ASSET_MODES.TEST, viteDistRoot: distRoot },
    );
    const response = await request(legacyApp).get('/').expect(200);

    expect(response.text).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
    expect(response.text).toContain('<script type="module" src="/creatorcrate.js"></script>');
    expect(response.text).not.toContain('/@vite/client');
    expect(response.text).not.toContain('/vite/assets/main-TEST.js');
    expect(response.text).not.toContain('/vite/assets/main-TEST.css');
    expect(response.headers['content-security-policy']).toBe(SECURITY_CSP);
  });

  it('exposes the injected resolver to the application and Nunjucks-facing locals', () => {
    expect(app.locals.assetManifest).toBe(assets);
    expect(app.locals.viteAssets).toBe(assets);
    expect(app.locals.viteAssets.entry(VITE_ENTRY_KEY).js).toBe('/vite/assets/main-TEST.js');
  });
});
