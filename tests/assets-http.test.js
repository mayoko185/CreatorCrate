import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import {
  STATUS_DIR_MAP,
  formatProjectDirName,
  buildProjectRelPath,
} from '../src/storage/project-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;

  function createProjectAndDir(title, status = 'tbd') {
    // Create via HTTP
    return request(app)
      .post('/projects')
      .send(`title=${encodeURIComponent(title)}`)
      .send(`status=${status}`)
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded');
  }

  function getProjectDir(title, status = 'tbd') {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const statusDir = STATUS_DIR_MAP[status];
    const entries = fs.readdirSync(path.join(projectsRoot, statusDir));
    const matching = entries.filter((e) => e.endsWith(`-${slug}`));
    if (matching.length === 0) return null;
    return path.join(projectsRoot, statusDir, matching[0]);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-assets-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Assets page ────────────────────────────────────────────────

  it('assets page renders for a valid project', async () => {
    const createRes = await createProjectAndDir('Asset View Test');
    const res = await request(app)
      .get(`${createRes.headers.location}/assets`)
      .expect(200);

    expect(res.text).toContain('Assets');
    expect(res.text).toContain('Asset View Test');
    expect(res.text).toContain('Scan Now');
  });

  it('assets page shows no assets message for empty project', async () => {
    const createRes = await createProjectAndDir('Empty Assets');
    const res = await request(app)
      .get(`${createRes.headers.location}/assets`)
      .expect(200);

    expect(res.text).toContain('No assets found');
    expect(res.text).toContain('Scan Now');
  });

  it('assets page returns 404 for missing project', async () => {
    await request(app).get('/projects/99999/assets').expect(404);
  });

  it('assets page returns 404 for invalid project id', async () => {
    await request(app).get('/projects/abc/assets').expect(404);
  });

  it('assets page shows scanned assets', async () => {
    const createRes = await createProjectAndDir('Scanned Assets');
    const id = createRes.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Scanned Assets');

    // Add files manually
    fs.writeFileSync(path.join(projectDir, 'render.png'), 'png content');
    fs.writeFileSync(path.join(projectDir, 'sketch.kra'), 'krita content');

    // Run scan
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Check assets page
    const res = await request(app).get(`/projects/${id}/assets`).expect(200);
    expect(res.text).toContain('render.png');
    expect(res.text).toContain('sketch.kra');
    expect(res.text).toContain('2 assets');
  });

  // ─── Scan action ────────────────────────────────────────────────

  it('scan button triggers scan and shows result', async () => {
    const createRes = await createProjectAndDir('Scan Action Test');
    const id = createRes.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Scan Action Test');

    fs.writeFileSync(path.join(projectDir, 'file.png'), 'png');

    const res = await request(app)
      .post(`/projects/${id}/scan`)
      .expect(302);

    expect(res.headers.location).toContain(`/projects/${id}/assets`);
    expect(res.headers.location).toContain('scan_result');
  });

  it('scan with no changes shows appropriate message', async () => {
    const createRes = await createProjectAndDir('No Change Scan');
    const id = createRes.headers.location.replace('/projects/', '');

    // Scan empty project
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Scan again — should show no changes
    const res = await request(app).post(`/projects/${id}/scan`).expect(302);
    expect(res.headers.location).toContain('scan_result=no_changes');
  });

  it('scan handles missing project safely', async () => {
    await request(app).post('/projects/99999/scan').expect(404);
  });

  it('scan handles invalid project id safely', async () => {
    await request(app).post('/projects/abc/scan').expect(404);
  });

  it('scan handles missing directory gracefully', async () => {
    const createRes = await createProjectAndDir('Missing Dir Scan');
    const id = createRes.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Missing Dir Scan');

    // Remove the directory
    fs.rmSync(projectDir, { recursive: true, force: true });

    // Scan — should redirect with error, not crash
    const res = await request(app)
      .post(`/projects/${id}/scan`)
      .expect(302);

    // Redirects to assets page with scan_error flag
    expect(res.headers.location).toContain('scan_error=1');
  });

  it('scan does not leak absolute paths on error', async () => {
    const createRes = await createProjectAndDir('No Path Leak');
    const id = createRes.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('No Path Leak');

    fs.rmSync(projectDir, { recursive: true, force: true });

    const res = await request(app)
      .post(`/projects/${id}/scan`)
      .expect(302);

    // The redirect path should not contain absolute filesystem paths
    expect(res.headers.location).not.toMatch(/[A-Z]:\\/);
  });

  // ─── Filtering ──────────────────────────────────────────────────

  it('filters assets by extension', async () => {
    const createRes = await createProjectAndDir('Filter By Extension');
    const id = createRes.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Filter By Extension');

    fs.writeFileSync(path.join(projectDir, 'photo.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'icon.jpg'), 'jpg');

    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res = await request(app)
      .get(`/projects/${id}/assets?extension=png`)
      .expect(200);

    expect(res.text).toContain('photo.png');
    expect(res.text).not.toContain('icon.jpg');
  });

  it('searches assets by filename', async () => {
    const createRes = await createProjectAndDir('Search Assets');
    const id = createRes.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Search Assets');

    fs.writeFileSync(path.join(projectDir, 'sunset-final.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'sunset-sketch.kra'), 'kra');
    fs.writeFileSync(path.join(projectDir, 'other.webp'), 'webp');

    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res = await request(app)
      .get(`/projects/${id}/assets?search=sunset`)
      .expect(200);

    expect(res.text).toContain('sunset-final.png');
    expect(res.text).toContain('sunset-sketch.kra');
    expect(res.text).not.toContain('other.webp');
  });

  // ─── Dashboard ──────────────────────────────────────────────────

  it('dashboard shows total asset count when assets exist', async () => {
    const createRes = await createProjectAndDir('Dashboard Asset');
    const id = createRes.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Dashboard Asset');

    fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('Total assets');
  });

  it('dashboard shows asset count of 0 when no assets exist', async () => {
    // Create a project but no files — scan won't happen, so totalAssets = 0
    await createProjectAndDir('No Asset Project');

    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('Total assets');
    expect(res.text).toContain('0');
  });

  it('project detail page links to assets', async () => {
    const createRes = await createProjectAndDir('Detail Link');
    const res = await request(app)
      .get(createRes.headers.location)
      .expect(200);

    expect(res.text).toContain('View Assets');
    expect(res.text).toContain(`/projects/`);
    expect(res.text).toContain(`/assets`);
  });

  it('does not render spoofed scan_result in query string', async () => {
    const createRes = await createProjectAndDir('Spoof Test');
    const id = createRes.headers.location.replace('/projects/', '');
    const projectDir = getProjectDir('Spoof Test');

    // Add and scan a file legitimately first
    fs.writeFileSync(path.join(projectDir, 'file.png'), 'png');
    await request(app).post(`/projects/${id}/scan`).expect(302);

    // Now request with a spoofed scan_result parameter
    const res = await request(app)
      .get(`/projects/${id}/assets?scan_result=added=999`)
      .expect(200);

    // The spoofed value must NOT appear as a scan success message
    expect(res.text).not.toContain('added=999');
    expect(res.text).not.toContain('999');
  });

  it('validates filter parameters cannot alter internal state display', async () => {
    const createRes = await createProjectAndDir('Filter Spoof');
    const id = createRes.headers.location.replace('/projects/', '');

    // Request with an invalid sort value that was previously allowed
    const res = await request(app)
      .get(`/projects/${id}/assets?sort=invalid_sort&order=asc`)
      .expect(200);

    // The page should render without error and use defaults
    expect(res.text).toContain('Assets');
  });

  it('404 for invalid project id on assets page does not contain stack traces', async () => {
    const res = await request(app).get('/projects/99999/assets').expect(404);
    expect(res.text).not.toContain('at ');
    expect(res.text).not.toContain('Error:');
  });
});
