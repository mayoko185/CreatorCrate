/**
 * PM-1C2A — explicit ownership recovery HTTP contract: status read, recover
 * with a confirmed status version, conflict/unavailable errors, and the
 * application-wide authentication/CSRF protection. No token or path ever
 * reaches a response body.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectOwnershipAdoptionRepository } from '../src/data/project-ownership-adoption-repository.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import {
  PROJECT_OWNERSHIP_MARKER_FILENAME,
  readProjectOwnershipMarker,
  serializeProjectOwnershipMarker,
} from '../src/storage/project-ownership-marker.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const TOKEN_RE = /[0-9a-f]{64}/;

describe('project ownership recovery HTTP', () => {
  let ctx;

  afterEach(() => {
    if (!ctx) return;
    try { closeDatabase(ctx.db); } catch { /* already closed */ }
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    ctx = null;
  });

  async function setup() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-recovery-http-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const db = openDatabase(path.join(tmpDir, 'creatorcrate.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const adoption = createProjectOwnershipAdoptionRepository(db);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { authConfig: AUTH_CONFIG });
    const { agent, csrfToken } = await authenticate(app);
    ctx = { tmpDir, projectsRoot, db, adoption, app, agent, csrfToken };
    return ctx;
  }

  async function createProject(title) {
    const res = await ctx.agent.post('/projects').type('form')
      .send({ title, status: 'tbd', priority: 'normal', _csrf: ctx.csrfToken }).expect(302);
    const id = Number(res.headers.location.replace('/projects/', ''));
    const project = ctx.db.prepare('SELECT id, project_dir FROM projects WHERE id = ?').get(id);
    const dir = resolveProjectDir(ctx.projectsRoot, project.project_dir);
    const token = ctx.db.prepare('SELECT token FROM project_directory_ownership WHERE project_id = ?').pluck().get(id);
    return { id, dir, marker: path.join(dir, PROJECT_OWNERSHIP_MARKER_FILENAME), token };
  }

  // Unbound and classified for explicit recovery, after a completed pass.
  async function unboundProject(title) {
    const project = await createProject(title);
    ctx.db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(project.id);
    fs.unlinkSync(project.marker);
    ctx.adoption.initialize();
    ctx.adoption.complete();
    ctx.adoption.setClassification(project.id, { status: 'recovery-required', reason: 'manifest-missing' });
    return project;
  }

  async function status(id) {
    const res = await ctx.agent.get(`/projects/${id}/ownership-recovery`).set('Accept', 'application/json').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return res.body.recovery;
  }

  function post(id, body) {
    return ctx.agent.post(`/projects/${id}/ownership-recovery`)
      .set('Accept', 'application/json')
      .send({ _csrf: ctx.csrfToken, ...body });
  }

  it('reports status and recovers with a confirmed version, exposing no token or path', async () => {
    await setup();
    const project = await unboundProject('Recover Me');
    const shown = await status(project.id);
    expect(shown).toMatchObject({ action: 'recover', plan: 'create-marker', marker: 'missing', binding: null });

    const res = await post(project.id, { statusVersion: shown.statusVersion }).expect(200);
    expect(res.body).toMatchObject({
      status: 'success', outcome: 'recovered', recovery: { action: 'none', reason: 'bound', marker: 'matching' },
    });
    const token = ctx.db.prepare("SELECT token FROM project_directory_ownership WHERE project_id = ? AND state = 'bound'")
      .pluck().get(project.id);
    expect(readProjectOwnershipMarker(project.dir)).toEqual({ status: 'valid', token });
    expect(res.text).not.toContain(token);
    expect(res.text).not.toMatch(TOKEN_RE);
    expect(res.text).not.toContain(ctx.projectsRoot);
    expect(ctx.adoption.getClassification(project.id)).toBeNull();
  });

  it('a plain form confirmation redirects to the project', async () => {
    await setup();
    const project = await unboundProject('Form Post');
    const { statusVersion } = await status(project.id);
    await ctx.agent.post(`/projects/${project.id}/ownership-recovery`).type('form')
      .send({ statusVersion, _csrf: ctx.csrfToken })
      .expect(302).expect('Location', `/projects/${project.id}`);
  });

  it('rejects a stale confirmation with 409 and the fresh status', async () => {
    await setup();
    const project = await unboundProject('Stale');
    const shown = await status(project.id);
    fs.writeFileSync(project.marker, 'appeared meanwhile');
    const res = await post(project.id, { statusVersion: shown.statusVersion }).expect(409);
    expect(res.body).toMatchObject({ status: 'error', code: 'RECOVERY_STATE_CHANGED', recovery: { plan: 'replace-marker' } });
    expect(fs.readFileSync(project.marker, 'utf8')).toBe('appeared meanwhile');
  });

  it('requires a status version', async () => {
    await setup();
    const project = await unboundProject('Blind');
    const res = await post(project.id, {}).expect(400);
    expect(res.body).toMatchObject({ code: 'RECOVERY_CONFIRMATION_REQUIRED' });
  });

  it('reports an unavailable directory as 503 retry-later', async () => {
    await setup();
    const project = await unboundProject('Away');
    fs.renameSync(project.dir, `${project.dir}.away`);
    const shown = await status(project.id);
    expect(shown).toMatchObject({ action: 'retry-later', reason: 'project-directory-missing' });
    const res = await post(project.id, { statusVersion: shown.statusVersion }).expect(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body).toMatchObject({ code: 'RECOVERY_UNAVAILABLE', reason: 'project-directory-missing' });
    expect(ctx.adoption.getClassification(project.id)).toMatchObject({ reason: 'manifest-missing' });
  });

  it('refuses a marker whose token another project owns (409) without exposing it', async () => {
    await setup();
    const owner = await createProject('Owner');
    const project = await unboundProject('Claimant');
    fs.writeFileSync(project.marker, serializeProjectOwnershipMarker(owner.token));
    const shown = await status(project.id);
    expect(shown).toMatchObject({ action: 'blocked', reason: 'marker-token-in-use', marker: 'owned-by-another-project' });
    const res = await post(project.id, { statusVersion: shown.statusVersion }).expect(409);
    expect(res.body).toMatchObject({ code: 'RECOVERY_BLOCKED', reason: 'marker-token-in-use' });
    expect(res.text).not.toContain(owner.token);
    expect(readProjectOwnershipMarker(project.dir)).toEqual({ status: 'valid', token: owner.token });
    expect(readProjectOwnershipMarker(owner.dir)).toEqual({ status: 'valid', token: owner.token });
  });

  it('returns 404 for an unknown project', async () => {
    await setup();
    await ctx.agent.get('/projects/9999/ownership-recovery').set('Accept', 'application/json').expect(404);
    await post(9999, { statusVersion: 'a'.repeat(32) }).expect(404);
  });

  it('requires CSRF and authentication', async () => {
    await setup();
    const project = await unboundProject('Protected');
    const { statusVersion } = await status(project.id);
    await ctx.agent.post(`/projects/${project.id}/ownership-recovery`).set('Accept', 'application/json')
      .send({ statusVersion }).expect(403);
    const anonymous = await request(ctx.app).get(`/projects/${project.id}/ownership-recovery`);
    expect([302, 401]).toContain(anonymous.status);
    const anonymousPost = await request(ctx.app).post(`/projects/${project.id}/ownership-recovery`)
      .send({ statusVersion });
    expect([302, 401, 403]).toContain(anonymousPost.status);
    expect(ctx.db.prepare('SELECT COUNT(*) FROM project_directory_ownership WHERE project_id = ?').pluck().get(project.id)).toBe(0);
  });
});
