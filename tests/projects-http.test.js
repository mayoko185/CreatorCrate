import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project HTTP workflow', () => {
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

  it('dashboard renders counts and a new project action', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('CreatorCrate');
    expect(res.text).toContain('New Project');
    expect(res.text).toContain('TBD');
    expect(res.text).toContain('View All Projects');
  });

  it('dashboard archived count reflects archived projects', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Archive+Count')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const id = createRes.headers.location.replace('/projects/', '');
    await request(app).post(`/projects/${id}/archive`);

    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('<span class="count">1</span> Archived');
  });

  it('project list renders', async () => {
    const res = await request(app).get('/projects').expect(200);
    expect(res.text).toContain('Projects');
    expect(res.text).toContain('No projects match');
  });

  it('new-project form renders', async () => {
    const res = await request(app).get('/projects/new').expect(200);
    expect(res.text).toContain('Create Project');
    expect(res.text).toContain('Title');
    expect(res.text).not.toContain('value="archived"');
  });

  it('valid create request redirects to detail', async () => {
    const res = await request(app)
      .post('/projects')
      .send('title=Test+Project')
      .send('description=A+test')
      .send('notes=notes')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    expect(res.headers.location).toMatch(/^\/projects\/\d+$/);
  });

  it('invalid create request rerenders with values and errors', async () => {
    const res = await request(app)
      .post('/projects')
      .send('title=')
      .send('description=A')
      .send('status=invalid')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Title is required');
    expect(res.text).toContain('A');
  });

  it('rejects archived status on create', async () => {
    const res = await request(app)
      .post('/projects')
      .send('title=Direct+Archive')
      .send('status=archived')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Status must be one of');
    expect(res.text).toContain('Direct Archive');
  });

  it('project detail renders', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Detail+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const location = createRes.headers.location;
    const res = await request(app).get(location).expect(200);
    expect(res.text).toContain('Detail Project');
    expect(res.text).toContain('Edit');
  });

  it('edit form renders', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Editable+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await request(app).get(`${createRes.headers.location}/edit`).expect(200);
    expect(res.text).toContain('Edit Project');
    expect(res.text).toContain('Editable Project');
    expect(res.text).not.toContain('value="archived"');
  });

  it('valid update redirects to detail', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Old+Name')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await request(app)
      .post(createRes.headers.location)
      .send('title=New+Name')
      .send('status=planned')
      .send('priority=high')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await request(app).get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('New Name');
  });

  it('rejects archived status on update', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Update+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await request(app)
      .post(createRes.headers.location)
      .send('title=Update+Archive')
      .send('status=archived')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Status must be one of');
  });

  it('missing project returns 404', async () => {
    await request(app).get('/projects/9999').expect(404);
  });

  it('invalid project id returns 404', async () => {
    await request(app).get('/projects/abc').expect(404);
  });

  it('archive action preserves the record and redirects', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=To+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const id = createRes.headers.location.replace('/projects/', '');

    const res = await request(app)
      .post(`/projects/${id}/archive`)
      .expect(302);
    expect(res.headers.location).toBe('/projects');

    const detail = await request(app).get(`/projects/${id}`).expect(200);
    expect(detail.text).toContain('Archived');
  });

  it('archived project is excluded from the default list', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Hidden+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const id = createRes.headers.location.replace('/projects/', '');
    await request(app).post(`/projects/${id}/archive`);

    const list = await request(app).get('/projects').expect(200);
    expect(list.text).not.toContain('Hidden Project');
  });

  it('archived project appears under archived filter and dashboard count', async () => {
    const createRes = await request(app)
      .post('/projects')
      .send('title=Filter+Archive')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const id = createRes.headers.location.replace('/projects/', '');
    await request(app).post(`/projects/${id}/archive`);

    const archivedList = await request(app).get('/projects?status=archived').expect(200);
    expect(archivedList.text).toContain('Filter Archive');

    const dashboard = await request(app).get('/').expect(200);
    expect(dashboard.text).toContain('<span class="count">1</span> Archived');
  });

  it('search and status query parameters affect results', async () => {
    await request(app)
      .post('/projects')
      .send('title=Searchable+Alpha')
      .send('description=find me')
      .send('status=planned')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    await request(app)
      .post('/projects')
      .send('title=Beta+One')
      .send('status=ready')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');

    const search = await request(app).get('/projects?search=alpha').expect(200);
    expect(search.text).toContain('Searchable Alpha');
    expect(search.text).not.toContain('Beta One');

    const status = await request(app).get('/projects?status=ready').expect(200);
    expect(status.text).toContain('Beta One');
    expect(status.text).not.toContain('Searchable Alpha');
  });

  it('pagination is bounded', async () => {
    for (let i = 1; i <= 30; i += 1) {
      await request(app)
        .post('/projects')
        .send(`title=Page+${i}`)
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded');
    }

    const page1 = await request(app).get('/projects?page=1').expect(200);
    expect(page1.text).toContain('Page 1 of 2');

    const huge = await request(app).get('/projects?page=999').expect(200);
    expect(huge.text).toContain('Page 2 of 2');
  });

  it('unknown routes still return safe 404', async () => {
    const res = await request(app).get('/not-a-real-route').expect(404);
    expect(res.text).toContain('Not found');
    expect(res.text).not.toContain('at ');
  });
});
