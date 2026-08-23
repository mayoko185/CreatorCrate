import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('release-management HTTP compatibility route', () => {
  let db;
  let agent;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-relmgmt-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('redirects the bare compatibility route to canonical Releases with 302', async () => {
    const res = await agent.get('/release-management').expect(302);

    expect(res.headers.location).toBe('/releases');
  });

  it('preserves incoming query strings on the canonical redirect', async () => {
    const res = await agent.get('/release-management?project=12&page=2').expect(302);

    expect(res.headers.location).toBe('/releases?project=12&page=2');
  });

  it('redirects legacy Board URLs without reintroducing a Board surface', async () => {
    const redirect = await agent.get('/release-management?view=board').expect(302);
    expect(redirect.headers.location).toBe('/releases?view=board');

    const rendered = await agent.get(redirect.headers.location).redirects(1).expect(200);
    expect(rendered.text).not.toContain('board-container');
    expect(rendered.text).not.toContain('name="view"');
  });
});
