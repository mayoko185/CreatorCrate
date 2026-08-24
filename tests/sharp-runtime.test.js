import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplicationContext } from '../src/app-context.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createSharpRuntime, SHARP_RUNTIME_CONFIGURATION } from '../src/services/sharp-runtime.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function createSharpApi() {
  return {
    concurrency: vi.fn(),
    cache: vi.fn(),
  };
}

describe('Sharp runtime initialization', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-sharp-runtime-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pins Sharp/libvips concurrency and cache exactly once', () => {
    const sharpApi = createSharpApi();
    const runtime = createSharpRuntime({ sharpApi });

    runtime.initialize();
    runtime.initialize();

    expect(sharpApi.concurrency).toHaveBeenCalledOnce();
    expect(sharpApi.concurrency).toHaveBeenCalledWith(1);
    expect(sharpApi.cache).toHaveBeenCalledOnce();
    expect(sharpApi.cache).toHaveBeenCalledWith(SHARP_RUNTIME_CONFIGURATION.cache);
  });

  it('initializes before the app service graph and survives auth-context rebuilds without reconfiguration', () => {
    const sharpApi = createSharpApi();
    const runtime = createSharpRuntime({ sharpApi });
    const appContext = createApplicationContext(
      { appName: 'CreatorCrate', appOpts: { sharpRuntime: runtime } },
      db,
    );

    appContext.replaceAuthConfig(null);

    expect(sharpApi.concurrency).toHaveBeenCalledOnce();
    expect(sharpApi.cache).toHaveBeenCalledOnce();
  });

  it('keeps Convert and Watermark operation modules free of Sharp global configuration', () => {
    for (const moduleUrl of [
      new URL('../src/services/asset-processing-service.js', import.meta.url),
      new URL('../src/services/watermark-engine.js', import.meta.url),
    ]) {
      const source = fs.readFileSync(moduleUrl, 'utf8');
      expect(source).not.toMatch(/sharp\.(?:concurrency|cache)\s*\(/);
    }
  });
});
