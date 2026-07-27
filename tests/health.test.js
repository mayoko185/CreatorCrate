import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createHealthRouter } from '../src/routes/health.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('HTTP routes', () => {
  let db;
  let app;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-http-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('root page renders the app name and dashboard', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('CreatorCrate');
    expect(res.text).toContain('New Project');
    expect(res.text).toContain('Project counts');
    expect(res.text).toContain('View All Projects');
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
    const healthApp = express();
    healthApp.use('/health', createHealthRouter({ db: closedDb }));
    const res = await request(healthApp).get('/health').expect(503);
    expect(res.body).toEqual({ status: 'error', database: 'error' });
  });

  it('unknown routes return 404 without a stack trace', async () => {
    const res = await request(app).get('/missing').expect(404);
    expect(res.text).toContain('Not found');
    expect(res.text).not.toContain('at ');
    expect(res.text).not.toContain('stack');
  });
});
