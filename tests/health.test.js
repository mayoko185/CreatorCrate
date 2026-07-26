import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('HTTP routes', () => {
  let db;
  let app;

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-http-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db });
  });

  afterAll(() => {
    closeDatabase(db);
  });

  it('root page renders the app name and placeholder', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('CreatorCrate');
    expect(res.text).toContain('Project management');
    expect(res.text).toContain('next phase');
  });

  it('health endpoint returns ok when the database works', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });

  it('health endpoint returns error when the database is unreadable', async () => {
    const closedDb = {
      prepare: () => {
        throw new Error('database is closed');
      },
    };
    const badApp = createApp({ appName: 'CreatorCrate', db: closedDb });
    const res = await request(badApp).get('/health').expect(503);
    expect(res.body).toEqual({ status: 'error', database: 'error' });
  });

  it('unknown routes return 404 without a stack trace', async () => {
    const res = await request(app).get('/missing').expect(404);
    expect(res.text).toContain('Not found');
    expect(res.text).not.toContain('at ');
    expect(res.text).not.toContain('stack');
  });
});
