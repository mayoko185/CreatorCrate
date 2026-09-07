import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function createSessionProbe({ throwing = false } = {}) {
  const getSession = vi.fn(() => {
    if (throwing) throw new Error('session storage is unavailable');
    return { username: 'admin', csrfSecret: 'b'.repeat(32) };
  });
  return {
    getSession,
    authService: {
      getSession,
      login: vi.fn(),
      logout: vi.fn(),
    },
  };
}

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

  describe('database-independent maintenance boundary', () => {
    it('serves the same maintenance health response with or without a session cookie and never resolves it', async () => {
      const maintenanceState = { active: true };
      const session = createSessionProbe();
      const maintenanceApp = createApp(
        { appName: 'CreatorCrate', db },
        { maintenanceState, authConfig: AUTH_CONFIG, authService: session.authService },
      );

      try {
        const withoutCookie = await request(maintenanceApp).get('/health').expect(503);
        const withCookie = await request(maintenanceApp)
          .get('/health')
          .set('Cookie', 'cc_session=maintenance-probe')
          .expect(503);

        expect(withoutCookie.body).toEqual({ status: 'maintenance', database: 'unavailable' });
        expect(withCookie.body).toEqual(withoutCookie.body);
        const trailingSlash = await request(maintenanceApp)
          .get('/health/')
          .set('Cookie', 'cc_session=maintenance-probe')
          .set('Accept', 'application/json')
          .expect(503);
        expect(trailingSlash.body).toEqual({
          status: 'error',
          message: 'Service temporarily unavailable for maintenance.',
        });
        expect(session.getSession).not.toHaveBeenCalled();
      } finally {
        maintenanceState.active = false;
      }
    });

    it('keeps maintenance health independent of a closed database and a throwing session dependency', async () => {
      const maintenanceState = { active: true };
      const session = createSessionProbe({ throwing: true });
      const maintenanceApp = createApp(
        { appName: 'CreatorCrate', db },
        { maintenanceState, authConfig: AUTH_CONFIG, authService: session.authService },
      );
      closeDatabase(db);
      db = null;

      try {
        const getResponse = await request(maintenanceApp)
          .get('/health')
          .set('Cookie', 'cc_session=maintenance-probe')
          .expect(503);
        await request(maintenanceApp)
          .head('/health')
          .set('Cookie', 'cc_session=maintenance-probe')
          .expect(503);

        expect(getResponse.body).toEqual({ status: 'maintenance', database: 'unavailable' });
        expect(session.getSession).not.toHaveBeenCalled();
      } finally {
        maintenanceState.active = false;
      }
    });

    it.each(['get', 'head'])('serves real static assets during maintenance for %s without session resolution', async (method) => {
      const maintenanceState = { active: true };
      const session = createSessionProbe({ throwing: true });
      const maintenanceApp = createApp(
        { appName: 'CreatorCrate', db },
        { maintenanceState, authConfig: AUTH_CONFIG, authService: session.authService },
      );

      try {
        await request(maintenanceApp)[method]('/creatorcrate.css')
          .set('Cookie', 'cc_session=maintenance-probe')
          .expect(200);

        expect(session.getSession).not.toHaveBeenCalled();
      } finally {
        maintenanceState.active = false;
      }
    });

    it.each(['get', 'head'])('terminates static-looking maintenance misses for %s before session resolution', async (method) => {
      const maintenanceState = { active: true };
      const session = createSessionProbe({ throwing: true });
      const maintenanceApp = createApp(
        { appName: 'CreatorCrate', db },
        { maintenanceState, authConfig: AUTH_CONFIG, authService: session.authService },
      );

      try {
        const response = await request(maintenanceApp)[method]('/missing.js')
          .set('Cookie', 'cc_session=maintenance-probe')
          .set('Accept', 'application/json')
          .expect(503);

        if (method === 'get') {
          expect(response.body).toEqual({
            status: 'error',
            message: 'Service temporarily unavailable for maintenance.',
          });
        }
        expect(session.getSession).not.toHaveBeenCalled();
      } finally {
        maintenanceState.active = false;
      }
    });

    it('preserves normal health, static, and authenticated static-miss handling', async () => {
      const maintenanceState = { active: false };
      const session = createSessionProbe();
      const normalApp = createApp(
        { appName: 'CreatorCrate', db },
        { maintenanceState, authConfig: AUTH_CONFIG, authService: session.authService },
      );
      const cookie = 'cc_session=normal-probe';

      const health = await request(normalApp).get('/health').set('Cookie', cookie).expect(200);
      expect(health.body).toEqual({ status: 'ok', database: 'ok' });
      expect(session.getSession).toHaveBeenCalledTimes(1);

      await request(normalApp).head('/health').set('Cookie', cookie).expect(200);
      expect(session.getSession).toHaveBeenCalledTimes(2);

      await request(normalApp).get('/creatorcrate.css').set('Cookie', cookie).expect(200);
      expect(session.getSession).toHaveBeenCalledTimes(2);

      const missing = await request(normalApp).get('/missing.js').set('Cookie', cookie).expect(404);
      expect(missing.text).not.toContain('temporarily unavailable');
      expect(session.getSession).toHaveBeenCalledTimes(3);
    });
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
