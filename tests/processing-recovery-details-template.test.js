/**
 * WP9 Recovery Details markup on /projects/:id/assets: the dialog and its
 * entry points render hidden (the client reveals them from the DB-only GET),
 * archived projects get a read-only dialog and page entry point with no
 * Refresh/Manual Scan control, and rendering the page or reading the GET never
 * observes recovery files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PRIVATE_PATH = '.creatorcrate-convert-staging/0123456789abcdef.0.output';

function tag(html, attribute) {
  return html.match(new RegExp(`<[a-z]+\\b[^>]*\\s${attribute}(?![\\w-])[^>]*>`))?.[0] || '';
}

describe('Recovery Details markup', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-recovery-details-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject(title) {
    const res = await agent
      .post('/projects')
      .send(`title=${encodeURIComponent(title)}`)
      .send('status=tbd')
      .send('priority=normal')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded');
    return Number(res.headers.location.replace('/projects/', ''));
  }

  // A real, eligible private residue file: a refresh would record `present`.
  function addPresentEvidence(projectId) {
    const repository = app.locals.processingRecoveryEvidenceRepository;
    const project = app.locals.projectService.findById(projectId);
    const target = path.join(projectsRoot, project.project_dir, ...PRIVATE_PATH.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'stage');
    const stats = fs.lstatSync(target, { bigint: true });
    const group = repository.createMutationGroup({
      projectId, operation: 'convert', runId: 'run-wp9', itemKey: 'Final/source.png',
    });
    return repository.createEvidence({
      projectId, mutationGroupId: group.groupId, artifactRole: 'stage-output',
      retentionReason: 'conversion-cleanup-residue', artifactPath: PRIVATE_PATH,
      sourcePath: 'Final/source.png', destinationPath: 'Final/source.webp',
      identity: { dev: stats.dev, ino: stats.ino }, expectedSize: 5,
      expectedSha256: createHash('sha256').update('stage').digest('hex'), lifecycle: 'dispensable',
    });
  }

  it('renders the dialog and hidden entry points for an unarchived project', async () => {
    const id = await createProject('Recovery Markup');
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    const html = res.text;

    const dialog = tag(html, 'id="processing-recovery-details-dialog"');
    expect(dialog).toContain('data-app-dialog');
    expect(dialog).toContain('aria-labelledby="processing-recovery-details-dialog-title"');
    expect(dialog).not.toContain('data-dialog-backdrop-static');
    expect(html).toContain('<h2 id="processing-recovery-details-dialog-title">Recovery Details</h2>');
    const card = tag(html, 'data-recovery-details');
    expect(card).toContain(`data-project-id="${id}"`);
    expect(card).toMatch(/data-csrf="[^"]+"/);
    expect(tag(html, 'data-recovery-details-status')).toContain('aria-live="polite"');
    expect(tag(html, 'data-recovery-details-error')).toContain('role="alert"');
    expect(html).toContain("A successful manual scan accepts the project's current files as the state to continue from. It does not delete recovery copies");

    // One page entry point plus one in each Processing dialog footer, all hidden until GET.
    const entryPoints = html.match(/<div class="processing-recovery-entry-point[^"]*"[^>]*>/g) || [];
    expect(entryPoints).toHaveLength(6);
    for (const entry of entryPoints) {
      expect(entry).toContain('data-recovery-details-entry');
      expect(entry).toMatch(/\shidden\b/);
    }
    expect(html.match(/data-recovery-entry-variant="gated"[^>]*hidden/g)).toHaveLength(6);
    expect(html.match(/data-recovery-entry-variant="evidence"[^>]*hidden/g)).toHaveLength(6);
    // The page entry point sits outside the live-filtered asset region.
    expect(html.indexOf('processing-recovery-entry-point--page')).toBeLessThan(html.indexOf('data-project-assets-live-region'));
    expect(html.match(/data-dialog-open="processing-recovery-details-dialog"/g)).toHaveLength(12);
  });

  async function archive(id) {
    await agent.post(`/projects/${id}/archive`).send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(app.locals.projectService.findById(id).archived_at).toBeTruthy();
  }

  it('renders read-only Recovery Details for an archived project with evidence', async () => {
    const id = await createProject('Archived Recovery Markup');
    const row = addPresentEvidence(id);
    await archive(id);
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    const html = res.text;

    // Exactly one dialog and one page entry point (Processing dialogs stay absent).
    expect(html.match(/id="processing-recovery-details-dialog"/g)).toHaveLength(1);
    const card = tag(html, 'data-recovery-details');
    expect(card).toContain(`data-project-id="${id}"`);
    expect(card).toContain('data-recovery-details-read-only');
    const entryPoints = html.match(/<div class="processing-recovery-entry-point[^"]*"[^>]*>/g) || [];
    expect(entryPoints).toHaveLength(1);
    expect(entryPoints[0]).toContain('processing-recovery-entry-point--page');
    expect(html).not.toContain('processing-recovery-entry-point--dialog');
    expect(html).not.toContain('data-processing-root');
    expect(html.match(/data-dialog-open="processing-recovery-details-dialog"/g)).toHaveLength(2);

    // Read-only wording; no mutation control and no impossible instruction.
    expect(html).toContain('Recovery state is unresolved. This archived project is read-only.');
    expect(html).toContain('Recovery information remains for this archived project.');
    expect(html).toContain('This archived project is read-only. The list shows the last recorded state for review.');
    expect(html).not.toContain('data-recovery-details-refresh');
    expect(html).not.toContain('data-recovery-details-manual-scan');
    expect(html).not.toContain('Run Manual Scan');
    expect(html).not.toContain('Manual recovery required.');
    expect(html).not.toContain('Refresh checks the listed files on disk');

    // The accepted GET still serves archived projects.
    const details = await agent.get(`/projects/${id}/assets/processing/recovery`)
      .set('Accept', 'application/json').expect(200);
    expect(details.body.entries.map((entry) => entry.evidenceId)).toEqual([row.evidenceId]);
  });

  it('renders the archived entry point hidden even with no evidence (the client decides from GET)', async () => {
    const id = await createProject('Archived Recovery Empty');
    await archive(id);
    const res = await agent.get(`/projects/${id}/assets`).expect(200);
    const entry = res.text.match(/<div class="processing-recovery-entry-point[^"]*"[^>]*>/g) || [];
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatch(/\shidden\b/);
    expect(res.text.match(/data-recovery-entry-variant="(gated|evidence)"[^>]*hidden/g)).toHaveLength(2);
  });

  it('keeps every mutation control for an unarchived project', async () => {
    const id = await createProject('Unarchived Recovery Controls');
    const html = (await agent.get(`/projects/${id}/assets`).expect(200)).text;
    expect(tag(html, 'data-recovery-details')).not.toContain('data-recovery-details-read-only');
    expect(html).toContain('data-recovery-details-refresh');
    expect(html).toContain('data-recovery-details-manual-scan');
  });

  it('page load and the DB-only GET never observe recovery files', async () => {
    const id = await createProject('Recovery Page Load');
    const row = addPresentEvidence(id);

    await agent.get(`/projects/${id}/assets`).expect(200);
    const details = await agent.get(`/projects/${id}/assets/processing/recovery`)
      .set('Accept', 'application/json').expect(200);
    expect(details.body.entries.map((entry) => entry.evidenceId)).toEqual([row.evidenceId]);

    const stored = app.locals.processingRecoveryEvidenceRepository.findEvidence(id, row.evidenceId);
    expect(stored.observation).toBe('unchecked');
    expect(stored.observedAt).toBeNull();
  });
});
