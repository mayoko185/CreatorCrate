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
import { createProjectRepository } from '../src/data/project-repository.js';

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

  it('keeps rootless-supported routes working while omitting filesystem-backed Assets routes', async () => {
    expect(app.locals.assetActionService).toBeNull();

    await request(app).get('/').expect(200);
    await request(app).get('/health').expect(200);

    const project = createProjectRepository(db).create({
      title: 'Rootless Assets Project',
      slug: 'rootless-assets-project',
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
    const res = await request(app)
      .post(`/projects/${project.id}/assets/1/rename`)
      .type('form')
      .send({ filename: 'renamed.png' })
      .expect(404);

    expect(res.text).toContain('Not found');
    expect(res.text).not.toContain('Something went wrong.');
    expect(res.text).not.toContain('TypeError');
    expect(res.text).not.toContain('assetActionService');
  });

  it.each([
    ['rename', (id) => `/projects/${id}/assets/1/rename`, { filename: 'renamed.png' }],
    ['move', (id) => `/projects/${id}/assets/1/move`, { destinationCategory: 'uncategorized' }],
    ['scan', (id) => `/projects/${id}/scan`, {}],
    ['batch move', (id) => `/projects/${id}/assets/move-selected`, {
      selectedAssetIds: '1',
      destinationCategory: 'uncategorized',
    }],
  ])('returns a controlled 404 for rootless filesystem-backed Assets %s', async (_label, buildPath, body) => {
    const project = createProjectRepository(db).create({
      title: 'Rootless Mutation Project',
      slug: 'rootless-mutation-project',
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });

    const res = await request(app)
      .post(buildPath(project.id))
      .type('form')
      .send(body)
      .expect(404);

    expect(res.text).toContain('Not found');
    expect(res.text).not.toContain('Something went wrong.');
    expect(res.text).not.toContain('TypeError');
    expect(res.text).not.toContain('assetActionService');
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
