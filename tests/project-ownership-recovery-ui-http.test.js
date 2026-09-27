/**
 * PM-1C2B — Project Detail ownership notice. The notice is derived from
 * durable SQLite state only: rendering a project never reads its ownership
 * marker, and the detailed (marker-reading) recovery status is fetched only
 * when the operator opens the recovery dialog.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectOwnershipAdoptionRepository } from '../src/data/project-ownership-adoption-repository.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import { PROJECT_OWNERSHIP_MARKER_FILENAME } from '../src/storage/project-ownership-marker.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';
import { countMarkerOpens } from './helpers/project-ownership.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project detail ownership notice', () => {
  let ctx;

  afterEach(() => {
    if (!ctx) return;
    try { closeDatabase(ctx.db); } catch { /* already closed */ }
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    ctx = null;
  });

  async function setup() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-recovery-ui-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const db = openDatabase(path.join(tmpDir, 'creatorcrate.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const adoption = createProjectOwnershipAdoptionRepository(db);
    adoption.initialize();
    adoption.complete();
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { authConfig: AUTH_CONFIG });
    const { agent, csrfToken } = await authenticate(app);
    ctx = { tmpDir, projectsRoot, db, adoption, app, agent, csrfToken };
  }

  async function createProject(title) {
    const res = await ctx.agent.post('/projects').type('form')
      .send({ title, status: 'tbd', priority: 'normal', _csrf: ctx.csrfToken }).expect(302);
    const id = Number(res.headers.location.replace('/projects/', ''));
    const project = ctx.db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id);
    const dir = resolveProjectDir(ctx.projectsRoot, project.project_dir);
    const token = ctx.db.prepare('SELECT token FROM project_directory_ownership WHERE project_id = ?').pluck().get(id);
    return { id, dir, token, marker: path.join(dir, PROJECT_OWNERSHIP_MARKER_FILENAME) };
  }

  async function unboundProject(title, classification = { status: 'recovery-required', reason: 'manifest-missing' }) {
    const project = await createProject(title);
    ctx.db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(project.id);
    fs.unlinkSync(project.marker);
    if (classification) ctx.adoption.setClassification(project.id, classification);
    return project;
  }

  async function detail(id) {
    let html;
    const markerOpens = await countMarkerOpens(vi, async () => {
      html = (await ctx.agent.get(`/projects/${id}`).expect(200)).text;
    });
    return { html, markerOpens };
  }

  it('renders no notice or recovery UI for a healthy project, without reading its marker', async () => {
    await setup();
    const project = await createProject('Healthy');
    const { html, markerOpens } = await detail(project.id);
    expect(markerOpens).toBe(0);
    expect(html).not.toContain('data-project-ownership-notice');
    expect(html).not.toContain('data-project-ownership-dialog');
    expect(html).not.toContain('data-project-ownership-open');
  });

  it('offers the recovery dialog for a project durably classified for recovery, without reading its marker', async () => {
    await setup();
    const other = await createProject('Other Bound');
    const project = await unboundProject('Needs Recovery');
    const { html, markerOpens } = await detail(project.id);
    expect(markerOpens).toBe(0);
    expect(html).toContain('data-project-ownership-notice="attention"');
    expect(html).toContain('data-project-ownership-open');
    expect(html).toContain('id="project-ownership-dialog"');
    expect(html).toContain(`data-project-id="${project.id}"`);
    expect(html).toContain('data-project-ownership-recover');
    expect(html).not.toContain('data-project-ownership-clear');
    expect(html).not.toContain(other.token);
    expect(html).not.toContain(ctx.projectsRoot);
  });

  it('a stale classification on healthy ownership stops showing once the detailed status verified it, without any operator POST', async () => {
    await setup();
    const project = await createProject('Stale Notice');
    ctx.adoption.setClassification(project.id, { status: 'recovery-required', reason: 'manifest-missing' });

    const first = await detail(project.id);
    expect(first.markerOpens).toBe(0);
    expect(first.html).toContain('data-project-ownership-notice="attention"');

    // Opening the dialog: the detailed status reads the marker and finds it healthy.
    const status = await ctx.agent.get(`/projects/${project.id}/ownership-recovery`)
      .set('Accept', 'application/json').expect(200);
    expect(status.body.recovery).toMatchObject({ action: 'none', reason: 'bound', marker: 'matching', classification: null });
    expect(ctx.adoption.getClassification(project.id)).toBeNull();

    // A full reload converges to the healthy page, again with no marker read.
    for (let reload = 0; reload < 2; reload += 1) {
      const { html, markerOpens } = await detail(project.id);
      expect(markerOpens).toBe(0);
      expect(html).not.toContain('data-project-ownership-notice');
      expect(html).not.toContain('data-project-ownership-dialog');
      expect(html).not.toContain('data-project-ownership-clear');
    }
    expect(ctx.db.prepare('SELECT token FROM project_directory_ownership WHERE project_id = ?').pluck().get(project.id)).toBe(project.token);
  });

  it('a detailed status that cannot prove ownership healthy keeps the notice across reloads', async () => {
    await setup();
    const project = await unboundProject('Still Needs Recovery');
    const status = await ctx.agent.get(`/projects/${project.id}/ownership-recovery`)
      .set('Accept', 'application/json').expect(200);
    expect(status.body.recovery.action).toBe('recover');
    const { html } = await detail(project.id);
    expect(html).toContain('data-project-ownership-notice="attention"');
  });

  it('shows a retry-later notice for a retryable project, never a recovery action', async () => {
    await setup();
    const project = await unboundProject('Share Away', { status: 'retryable', reason: 'project-directory-unavailable' });
    const { html, markerOpens } = await detail(project.id);
    expect(markerOpens).toBe(0);
    expect(html).toContain('data-project-ownership-notice="unavailable"');
    const notice = html.slice(html.indexOf('data-project-ownership-notice'), html.indexOf('</div>', html.indexOf('data-project-ownership-notice')));
    expect(notice).toContain('will retry automatically');
    expect(notice).not.toMatch(/recover/i);
  });

  it('treats an unclassified pending binding as automatic work in progress', async () => {
    await setup();
    const project = await createProject('Pending');
    ctx.db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(project.id);
    const { html } = await detail(project.id);
    expect(html).toContain('data-project-ownership-notice="unavailable"');
  });

  // A known ownership refusal on a slug-changing update is a controlled 409
  // form conflict, never a 500, and nothing is moved or re-pointed.
  async function refusedRename(project, title) {
    const before = ctx.db.prepare('SELECT title, slug, project_dir FROM projects WHERE id = ?').get(project.id);
    const entries = fs.readdirSync(ctx.projectsRoot).sort();
    const res = await ctx.agent.post(`/projects/${project.id}`).type('form')
      .send({ title, status: 'tbd', priority: 'normal', _csrf: ctx.csrfToken });
    expect(res.status).toBe(409);
    expect(res.text).toContain('id="project-edit-dialog"');
    expect(res.text).toContain('error-summary');
    expect(res.text).not.toContain('Project update failed');
    expect(res.text).not.toContain(ctx.projectsRoot);
    expect(ctx.db.prepare('SELECT title, slug, project_dir FROM projects WHERE id = ?').get(project.id)).toEqual(before);
    expect(fs.readdirSync(ctx.projectsRoot).sort()).toEqual(entries);
    return res;
  }

  it('refuses renaming an unbound project with a controlled 409, not a 500', async () => {
    await setup();
    const project = await unboundProject('Unbound Rename');
    const res = await refusedRename(project, 'Unbound Renamed');
    expect(res.text).toContain('ownership is not established');
    expect(fs.existsSync(project.dir)).toBe(true);
  });

  it('refuses renaming a bound project whose marker belongs to another token with a controlled 409', async () => {
    await setup();
    const other = await createProject('Other Owner');
    const project = await createProject('Mismatched Marker');
    fs.copyFileSync(other.marker, project.marker);
    const res = await refusedRename(project, 'Mismatched Renamed');
    expect(res.text).not.toContain(project.token);
    expect(res.text).not.toContain(other.token);
    expect(fs.readFileSync(project.marker)).toEqual(fs.readFileSync(other.marker));
  });

  it('reports a temporarily missing project folder as a controlled ownership refusal, not a 500', async () => {
    await setup();
    const project = await createProject('Share Away Rename');
    const aside = `${project.dir}.aside`;
    fs.renameSync(project.dir, aside);
    try {
      await refusedRename(project, 'Share Away Renamed');
      expect(fs.existsSync(project.dir)).toBe(false);
    } finally {
      fs.renameSync(aside, project.dir);
    }
  });

  it('after recovery the notice is gone and gated folder operations work without a restart', async () => {
    await setup();
    const project = await unboundProject('Recover Then Rename');
    const rename = (title) => ctx.agent.post(`/projects/${project.id}`).type('form')
      .send({ title, status: 'tbd', priority: 'normal', _csrf: ctx.csrfToken });
    const refused = await rename('Renamed Too Early');
    expect(refused.status).not.toBe(302);
    expect(refused.text).toContain('ownership');

    // Opening the dialog: exactly one detailed status request, then confirm.
    const status = await ctx.agent.get(`/projects/${project.id}/ownership-recovery`)
      .set('Accept', 'application/json').expect(200);
    expect(status.body.recovery.action).toBe('recover');
    const res = await ctx.agent.post(`/projects/${project.id}/ownership-recovery`)
      .set('Accept', 'application/json')
      .type('form')
      .send({ _csrf: ctx.csrfToken, statusVersion: status.body.recovery.statusVersion })
      .expect(200);
    expect(res.body).toMatchObject({ outcome: 'recovered', recovery: { action: 'none' } });

    const { html } = await detail(project.id);
    expect(html).not.toContain('data-project-ownership-notice');
    await rename('Renamed After Recovery').expect(302);
  });
});
