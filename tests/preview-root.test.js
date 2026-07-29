import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// Phase 10.1A: application startup must receive the derived preview root
// explicitly, and it must be reachable through app.locals for later services
// without reading the environment or globals.

describe('preview root wiring (Phase 10.1A)', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let previewRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preview-wire-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    previewRoot = path.join(tmpDir, 'app', 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });

    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createApp exposes the preview root on app.locals', () => {
    app = createApp({
      appName: 'CreatorCrate',
      db,
      projectsRoot,
      previewRoot,
    });
    expect(app.locals.previewRoot).toBe(previewRoot);
  });

  it('createApp accepts a custom temporary preview root', () => {
    const customPreviewRoot = path.join(tmpDir, 'custom-previews');
    fs.mkdirSync(customPreviewRoot, { recursive: true });

    app = createApp({
      appName: 'CreatorCrate',
      db,
      projectsRoot,
      previewRoot: customPreviewRoot,
    });
    expect(app.locals.previewRoot).toBe(customPreviewRoot);
    expect(app.locals.previewRoot).not.toBe(previewRoot);
  });

  it('preview root defaults to undefined when not provided (back-compat)', () => {
    // Existing tests call createApp without previewRoot. The app must not
    // crash; previewRoot stays undefined until later phases consume it.
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
    expect(app.locals.previewRoot).toBeUndefined();
  });
});