import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';
const DOWNLOAD_PATH = '/downloads/creatorcrate-open-locally-setup.exe';
const INSTALLER_FILENAME = 'CreatorCrate.OpenLocally-Setup.exe';

describe('downloads — Open locally installer HTTP', () => {
  let tmpDir;
  let downloadsRoot;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-downloads-'));
    downloadsRoot = path.join(tmpDir, 'downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildApp() {
    return createApp(
      { appName: APP_NAME, db, projectsRoot: path.join(tmpDir, 'projects') },
      { downloadsRoot }
    );
  }

  it('serves the installer with a download filename when the artifact exists', async () => {
    fs.writeFileSync(path.join(downloadsRoot, INSTALLER_FILENAME), 'fake-installer-bytes');

    const res = await request(buildApp()).get(DOWNLOAD_PATH).expect(200);

    expect(res.body).toEqual(Buffer.from('fake-installer-bytes'));
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(INSTALLER_FILENAME);
  });

  it('returns a clean 404 when the artifact is missing', async () => {
    await request(buildApp()).get(DOWNLOAD_PATH).expect(404);
  });

  it('does not serve an artifact outside the application-controlled downloads root', async () => {
    // The route only resolves the fixed filename under the downloads root;
    // any path traversal attempt must fall through to the plain 404.
    await request(buildApp()).get('/downloads/%2e%2e/creatorcrate.db').expect(404);
  });
});
