import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nunjucksInstrumentation = vi.hoisted(() => ({
  configure: vi.fn(),
  addGlobal: vi.fn(),
}));

vi.mock('nunjucks', () => ({
  default: {
    configure: (...args) => {
      nunjucksInstrumentation.configure(...args);
      return { addGlobal: nunjucksInstrumentation.addGlobal };
    },
  },
}));

import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Vite asset resolver app construction', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-vite-construction-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    nunjucksInstrumentation.configure.mockClear();
    nunjucksInstrumentation.addGlobal.mockClear();
  });

  it('registers the injected resolver as the viteAssets Nunjucks global without reading a manifest', () => {
    const assetManifest = { entry: vi.fn() };
    const app = createApp({ appName: 'CreatorCrate', db }, { assetManifest });

    expect(nunjucksInstrumentation.configure).toHaveBeenCalledWith(
      expect.stringContaining(`${path.sep}src${path.sep}views`),
      expect.objectContaining({ autoescape: true, express: app, noCache: true }),
    );
    expect(nunjucksInstrumentation.addGlobal).toHaveBeenCalledWith('viteAssets', assetManifest);
    expect(nunjucksInstrumentation.addGlobal).toHaveBeenCalledWith('useViteAssets', false);
    expect(app.locals.assetManifest).toBe(assetManifest);
    expect(app.locals.viteAssets).toBe(assetManifest);
    expect(app.locals.useViteAssets).toBe(false);
  });

  it('registers the explicit production asset mode when enabled by the server', () => {
    const assetManifest = { entry: vi.fn() };
    const app = createApp(
      { appName: 'CreatorCrate', db },
      { assetManifest, useViteAssets: true },
    );

    expect(nunjucksInstrumentation.addGlobal).toHaveBeenCalledWith('useViteAssets', true);
    expect(app.locals.useViteAssets).toBe(true);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
