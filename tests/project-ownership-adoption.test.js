/**
 * PM-1C1 — automatic ownership adoption of existing projects and restart-safe
 * recovery of interrupted ownership-marker publication.
 *
 * Fixtures model a pre-PM-1B installation: a real project (created normally,
 * so its directory tree is genuine) whose ownership row and marker are then
 * removed, with a legacy `project.json` written the way older versions did.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import { createProjectPrimaryImageRepository } from '../src/data/project-primary-image-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import {
  createProjectOwnershipAdoptionRepository,
  PROJECT_OWNERSHIP_ADOPTION_KEY,
} from '../src/data/project-ownership-adoption-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectService } from '../src/services/project-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { createAutomaticProjectScanScheduler } from '../src/services/automatic-project-scan-scheduler.js';
import { createPreviewCategorySettingsService } from '../src/services/preview-category-settings-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProjectOwnershipAdoptionService } from '../src/services/project-ownership-adoption-service.js';
import { createApplicationContext } from '../src/app-context.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import { MANIFEST_FILENAME, formatManifestJson, serializeManifest } from '../src/storage/manifest.js';
import {
  PROJECT_OWNERSHIP_MARKER_FILENAME,
  generateProjectOwnershipToken,
  readProjectOwnershipMarker,
  serializeProjectOwnershipMarker,
} from '../src/storage/project-ownership-marker.js';
import { createTestProjectOptionCatalogueService } from './helpers/project-option-catalogue.js';
import { snapshotTree } from './helpers/project-ownership.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function projectInput(title) {
  return {
    title, description: '', notes: '', status: 'tbd', priority: 'normal',
    plannedDate: null, publishedDate: null, patreonUrl: null,
  };
}

const ownershipFailure = (code) => expect.objectContaining({ name: 'ProjectOwnershipError', code });

function eio(target) {
  return Object.assign(new Error(`EIO: i/o error, '${target}'`), { code: 'EIO' });
}

describe('PM-1C1 project ownership adoption', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let ownershipRepository;
  let adoptionRepository;
  let assetCategoryService;
  let projectService;
  let coordinator;
  let timers;
  let logs;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-ownership-adoption-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    ownershipRepository = createProjectDirectoryOwnershipRepository(db);
    adoptionRepository = createProjectOwnershipAdoptionRepository(db);
    assetCategoryService = createAssetCategoryService(createAssetCategoryRepository(db));
    projectService = createProjectService(db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository: createAssetBrowserPreferenceRepository(db),
      projectOptionCatalogueService: createTestProjectOptionCatalogueService(db),
      projectDirectoryOwnershipRepository: ownershipRepository,
    });
    coordinator = createProjectOperationCoordinator();
    timers = [];
    logs = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── fixtures ──────────────────────────────────────────────────────────

  function dirOf(project) {
    return resolveProjectDir(projectsRoot, project.project_dir);
  }

  function markerPath(project) {
    return path.join(dirOf(project), PROJECT_OWNERSHIP_MARKER_FILENAME);
  }

  function manifestPath(project) {
    return path.join(dirOf(project), MANIFEST_FILENAME);
  }

  function categoriesOf(projectId) {
    return db.prepare('SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY display_order')
      .all(projectId);
  }

  /** A project as a pre-PM-1B install has it: row + dir, no binding, no marker. */
  function legacyProject(title, { manifest = 'matching' } = {}) {
    const project = projectService.create(projectInput(title));
    db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(project.id);
    fs.unlinkSync(markerPath(project));
    if (manifest === 'matching') writeManifest(project, serializeManifest(project, categoriesOf(project.id)));
    return project;
  }

  function writeManifest(project, manifest) {
    fs.writeFileSync(manifestPath(project), typeof manifest === 'string' ? manifest : formatManifestJson(manifest));
  }

  function writeMarker(project, content) {
    fs.writeFileSync(markerPath(project), content);
  }

  function businessState() {
    return {
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      categories: db.prepare('SELECT * FROM project_asset_categories ORDER BY id').all(),
      tags: db.prepare('SELECT * FROM project_tags ORDER BY project_id, tag_id').all(),
    };
  }

  function createAdoption(overrides = {}) {
    return createProjectOwnershipAdoptionService({
      repository: createProjectOwnershipAdoptionRepository(db),
      ownershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectsRoot,
      applicationLogger: {
        info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry), error: (entry) => logs.push(entry),
      },
      schedule: (callback, delay) => { const handle = { callback, delay }; timers.push(handle); return handle; },
      cancel: (handle) => { const index = timers.indexOf(handle); if (index >= 0) timers.splice(index, 1); },
      ...overrides,
    });
  }

  /** One startup: prepare, signal, wait. */
  async function startup(overrides) {
    const adoption = createAdoption(overrides);
    adoption.prepare();
    adoption.signal();
    await adoption.waitForIdle();
    return adoption;
  }

  async function fireRetryTimer(adoption) {
    const handle = timers.shift();
    expect(handle).toBeDefined();
    handle.callback();
    await adoption.waitForIdle();
  }

  function createScanner() {
    return createAssetScanner(db, projectsRoot, {
      projectService,
      assetCategoryService,
      projectOperationCoordinator: coordinator,
      previewCategorySettingsService: createPreviewCategorySettingsService({
        appMetaRepository: createAppMetaRepository(db),
        assetCategoryService,
      }),
      projectPrimaryImageRepository: createProjectPrimaryImageRepository(db),
      projectDirectoryOwnershipRepository: ownershipRepository,
    });
  }

  /** Present assets of a project (a removed source stays as a missing row). */
  function assetRows(projectId) {
    return db.prepare(`SELECT relative_path FROM assets WHERE project_id = ? AND is_present = 1
      ORDER BY relative_path`).all(projectId).map((row) => row.relative_path);
  }

  function expectBoundToMarker(project) {
    const row = ownershipRepository.findByProjectId(project.id);
    expect(row).toMatchObject({ state: 'bound' });
    expect(readProjectOwnershipMarker(dirOf(project))).toEqual({ status: 'valid', token: row.token });
    return row.token;
  }

  function expectUntouchedUnbound(project, before) {
    expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
    expect(snapshotTree(dirOf(project))).toEqual(before);
  }

  /** Count legacy manifest filesystem touches (lstat + open) while `fn` runs. */
  async function countManifestTouches(fn) {
    const lstat = vi.spyOn(fs, 'lstatSync');
    const open = vi.spyOn(fs, 'openSync');
    try {
      await fn();
      return [...lstat.mock.calls, ...open.mock.calls]
        .filter(([target]) => typeof target === 'string' && path.basename(target) === MANIFEST_FILENAME).length;
    } finally {
      lstat.mockRestore();
      open.mockRestore();
    }
  }

  /** Make every fs call under `dir` fail with EIO (an unavailable share). */
  function injectEio(dir, { only = null } = {}) {
    const prefix = path.resolve(dir);
    const hit = (target) => typeof target === 'string' && path.resolve(target).startsWith(prefix)
      && (!only || path.basename(target) === only);
    for (const method of ['lstatSync', 'statSync', 'openSync']) {
      const original = fs[method].bind(fs);
      vi.spyOn(fs, method).mockImplementation((target, ...rest) => {
        if (hit(target)) throw eio(target);
        return original(target, ...rest);
      });
    }
    return () => vi.restoreAllMocks();
  }

  // ── clean upgrade ─────────────────────────────────────────────────────

  describe('clean upgrade', () => {
    it('binds a legacy project from its matching manifest without touching business metadata', async () => {
      const project = legacyProject('Alpha');
      const manifestBytes = fs.readFileSync(manifestPath(project));
      const before = businessState();

      const adoption = await startup();

      const token = expectBoundToMarker(project);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.readFileSync(manifestPath(project))).toEqual(manifestBytes);
      expect(businessState()).toEqual(before);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ state: 'bound', binding: 'bound' });
      expect(adoption.readiness()).toMatchObject({
        initialPassComplete: true, retryable: 0, recoveryRequired: 0,
        pass: { phase: 'completed', counts: expect.objectContaining({ adopted: 1 }) },
      });
      expect(timers).toEqual([]);
    });

    it('makes PM-1B-gated operations work immediately, without a restart', async () => {
      const project = legacyProject('Alpha');
      const scanner = createScanner();
      fs.writeFileSync(path.join(dirOf(project), 'final', 'art.png'), 'png');
      expect(() => scanner.scanProjectAssets(project.id)).toThrowError(ownershipFailure('UNBOUND'));
      expect(() => projectService.update(project.id, projectInput('Alpha Renamed')))
        .toThrowError(ownershipFailure('UNBOUND'));

      await startup();

      await scanner.scanProjectAssets(project.id);
      expect(assetRows(project.id)).toEqual(['final/art.png']);
      const renamed = projectService.update(project.id, projectInput('Alpha Renamed'));
      expect(renamed.project_dir).toMatch(/alpha-renamed$/);
      expect(fs.existsSync(path.join(resolveProjectDir(projectsRoot, renamed.project_dir), MANIFEST_FILENAME)))
        .toBe(true);
    });

    it('accepts a matching ID whose business fields are stale, importing none of them', async () => {
      const project = legacyProject('Alpha', { manifest: 'none' });
      writeManifest(project, {
        ...serializeManifest(project, categoriesOf(project.id)),
        title: 'Old Title', slug: 'old-title', description: 'stale', notes: 'stale notes',
        patreonUrl: 'https://example.invalid/old',
        assetCategories: [{ displayName: 'Legacy', directorySlug: 'legacy', displayOrder: 0, enabled: true }],
      });
      const before = businessState();

      await startup();

      expectBoundToMarker(project);
      expect(businessState()).toEqual(before);
    });

    it('classifies a DB-only project as not requiring ownership and creates nothing', async () => {
      const project = legacyProject('Alpha');
      fs.rmSync(dirOf(project), { recursive: true });
      db.prepare('UPDATE projects SET project_dir = NULL WHERE id = ?').run(project.id);

      const adoption = await startup();

      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(fs.readdirSync(projectsRoot)).toEqual([]);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ state: 'not-required' });
      expect(adoption.readiness().pass.counts.notRequired).toBe(1);
    });

    it('includes archived projects and ignores directories with no DB project', async () => {
      const project = legacyProject('Alpha');
      projectService.archive(project.id);
      const orphan = path.join(projectsRoot, '000999-orphan');
      fs.mkdirSync(orphan);
      fs.writeFileSync(path.join(orphan, MANIFEST_FILENAME), '{}');

      await startup();

      expectBoundToMarker(project);
      expect(fs.readdirSync(orphan)).toEqual([MANIFEST_FILENAME]);
    });
  });

  // ── definitive proof failures ─────────────────────────────────────────

  describe('unprovable projects stay unbound for explicit recovery', () => {
    it.each([
      ['missing', null, 'manifest-missing'],
      ['malformed JSON', '{"schemaVersion": 3, ', 'manifest-malformed'],
      ['invalid structure', JSON.stringify({ schemaVersion: 3, id: 1 }), 'manifest-malformed'],
      ['unsupported version', JSON.stringify({ schemaVersion: 2, id: 1, slug: 'alpha' }), 'manifest-unsupported'],
    ])('%s manifest', async (_label, content, reason) => {
      const project = legacyProject('Alpha', { manifest: 'none' });
      if (content !== null) writeManifest(project, content);
      const before = snapshotTree(dirOf(project));

      const adoption = await startup();

      expectUntouchedUnbound(project, before);
      expect(adoption.getProjectStatus(project.id)).toEqual({
        projectId: project.id, state: 'recovery-required', reason, binding: null,
      });
      expect(timers).toEqual([]);
      // Not retried continuously: neither a later signal nor a restart reads it.
      const touches = await countManifestTouches(async () => {
        adoption.signal();
        await adoption.waitForIdle();
        await startup();
      });
      expect(touches).toBe(0);
      expectUntouchedUnbound(project, before);
    });

    it('never binds A from a manifest naming B, and A stays fail-closed', async () => {
      const projectA = legacyProject('Alpha', { manifest: 'none' });
      const projectB = legacyProject('Beta');
      writeManifest(projectA, serializeManifest(projectB, categoriesOf(projectB.id)));
      const before = snapshotTree(dirOf(projectA));
      const businessBefore = businessState();

      const adoption = await startup();

      expectUntouchedUnbound(projectA, before);
      expectBoundToMarker(projectB);
      expect(adoption.getProjectStatus(projectA.id))
        .toMatchObject({ state: 'recovery-required', reason: 'manifest-project-mismatch' });
      expect(() => createScanner().scanProjectAssets(projectA.id)).toThrowError(ownershipFailure('UNBOUND'));
      expect(businessState()).toEqual(businessBefore);
      expect(adoption.listUnresolved()).toEqual([
        { projectId: projectA.id, state: 'recovery-required', reason: 'manifest-project-mismatch', binding: null },
      ]);
    });

    it('never follows a symlinked manifest', async () => {
      const project = legacyProject('Alpha', { manifest: 'none' });
      const outside = path.join(tmpDir, 'outside.json');
      fs.writeFileSync(outside, formatManifestJson(serializeManifest(project, categoriesOf(project.id))));
      try {
        fs.symlinkSync(outside, manifestPath(project));
      } catch {
        return; // symlink creation needs privileges on some Windows hosts
      }
      const adoption = await startup();
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(fs.existsSync(markerPath(project))).toBe(false);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ reason: 'manifest-unsafe' });
    });
  });

  // ── existing markers ──────────────────────────────────────────────────

  describe('existing marker without an ownership row', () => {
    it('adopts a valid marker token instead of replacing it (older DB restored)', async () => {
      const project = legacyProject('Alpha');
      const token = generateProjectOwnershipToken();
      writeMarker(project, serializeProjectOwnershipMarker(token));
      const markerBytes = fs.readFileSync(markerPath(project));

      await startup();

      expect(expectBoundToMarker(project)).toBe(token);
      expect(fs.readFileSync(markerPath(project))).toEqual(markerBytes);
    });

    it('does not adopt a valid marker without matching legacy proof', async () => {
      const project = legacyProject('Alpha', { manifest: 'none' });
      writeMarker(project, serializeProjectOwnershipMarker(generateProjectOwnershipToken()));
      const before = snapshotTree(dirOf(project));
      const adoption = await startup();
      expectUntouchedUnbound(project, before);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ reason: 'manifest-missing' });
    });

    it('does not adopt a marker token already bound to another project', async () => {
      const bound = projectService.create(projectInput('Bound'));
      const project = legacyProject('Alpha');
      writeMarker(project, fs.readFileSync(markerPath(bound)));
      const before = snapshotTree(dirOf(project));
      const adoption = await startup();
      expectUntouchedUnbound(project, before);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ reason: 'marker-token-in-use' });
    });

    it.each([
      ['malformed', 'creatorcrate-owner/1 nope\n', 'marker-malformed'],
    ])('leaves a %s marker untouched', async (_label, content, reason) => {
      const project = legacyProject('Alpha');
      writeMarker(project, content);
      const before = snapshotTree(dirOf(project));
      const adoption = await startup();
      expectUntouchedUnbound(project, before);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ state: 'recovery-required', reason });
    });

    it('leaves a directory at the marker name untouched', async () => {
      const project = legacyProject('Alpha');
      fs.mkdirSync(markerPath(project));
      const adoption = await startup();
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(fs.statSync(markerPath(project)).isDirectory()).toBe(true);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ reason: 'marker-unsafe' });
    });
  });

  describe('bound rows are never repaired', () => {
    it('does not reread the manifest for a bound, marked project', async () => {
      const project = projectService.create(projectInput('Alpha'));
      writeManifest(project, serializeManifest(project, categoriesOf(project.id)));
      const token = ownershipRepository.findByProjectId(project.id).token;
      const touches = await countManifestTouches(() => startup());
      expect(touches).toBe(0);
      expect(expectBoundToMarker(project)).toBe(token);
    });

    it.each([
      ['missing', (project) => fs.unlinkSync(markerPath(project)), 'bound-marker-missing'],
      ['different', (project) => writeMarker(project, serializeProjectOwnershipMarker(generateProjectOwnershipToken())),
        'bound-marker-mismatch'],
      ['malformed', (project) => writeMarker(project, 'garbage'), 'bound-marker-malformed'],
    ])('classifies a %s marker on a bound row for recovery', async (_label, damage, reason) => {
      const project = projectService.create(projectInput('Alpha'));
      writeManifest(project, serializeManifest(project, categoriesOf(project.id)));
      const token = ownershipRepository.findByProjectId(project.id).token;
      damage(project);
      const before = snapshotTree(dirOf(project));

      const adoption = await startup();

      expect(ownershipRepository.findByProjectId(project.id)).toEqual({ projectId: project.id, token, state: 'bound' });
      expect(snapshotTree(dirOf(project))).toEqual(before);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ state: 'recovery-required', reason, binding: 'bound' });
      expect(() => createScanner().scanProjectAssets(project.id)).toThrow();
    });
  });

  // ── pending recovery ──────────────────────────────────────────────────

  describe('pending recovery', () => {
    function pendingProject({ manifest = 'matching' } = {}) {
      const project = legacyProject('Alpha', { manifest });
      const token = generateProjectOwnershipToken();
      ownershipRepository.createPending(project.id, token);
      return { project, token };
    }

    it('1. pending X + marker X binds without re-reading the manifest', async () => {
      const { project, token } = pendingProject({ manifest: 'none' });
      writeMarker(project, serializeProjectOwnershipMarker(token));
      const adoption = await startup();
      expect(expectBoundToMarker(project)).toBe(token);
      expect(adoption.readiness().pass.counts.completed).toBe(1);
    });

    it('2. pending X + no marker + matching manifest publishes X and binds', async () => {
      const { project, token } = pendingProject();
      await startup();
      expect(expectBoundToMarker(project)).toBe(token);
    });

    it('2b. pending X + no marker + no proof keeps pending and writes nothing', async () => {
      const { project, token } = pendingProject({ manifest: 'none' });
      const adoption = await startup();
      expect(ownershipRepository.findByProjectId(project.id)).toMatchObject({ token, state: 'pending' });
      expect(fs.existsSync(markerPath(project))).toBe(false);
      expect(adoption.getProjectStatus(project.id))
        .toMatchObject({ state: 'recovery-required', reason: 'manifest-missing', binding: 'pending' });
      // Classified pending rows stay quiet on later runs.
      expect(await countManifestTouches(() => startup())).toBe(0);
    });

    it('3. pending X + marker Y is a conflict and nothing is overwritten', async () => {
      const { project, token } = pendingProject();
      const other = serializeProjectOwnershipMarker(generateProjectOwnershipToken());
      writeMarker(project, other);
      const adoption = await startup();
      expect(ownershipRepository.findByProjectId(project.id)).toMatchObject({ token, state: 'pending' });
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe(other);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ reason: 'pending-marker-mismatch' });
    });

    it('4. pending X + malformed (partial) marker is not overwritten', async () => {
      const { project, token } = pendingProject();
      const partial = serializeProjectOwnershipMarker(token).slice(0, 30);
      writeMarker(project, partial);
      const adoption = await startup();
      expect(ownershipRepository.findByProjectId(project.id)).toMatchObject({ state: 'pending' });
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe(partial);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ reason: 'pending-marker-malformed' });
    });

    it('5. pending X + marker read EIO stays pending and retryable', async () => {
      const { project, token } = pendingProject();
      writeMarker(project, serializeProjectOwnershipMarker(token));
      const restore = injectEio(dirOf(project), { only: PROJECT_OWNERSHIP_MARKER_FILENAME });
      const adoption = await startup();
      restore();
      expect(ownershipRepository.findByProjectId(project.id)).toMatchObject({ token, state: 'pending' });
      expect(adoption.getProjectStatus(project.id))
        .toMatchObject({ state: 'retryable', reason: 'marker-unavailable', binding: 'pending' });
      await fireRetryTimer(adoption);
      expect(expectBoundToMarker(project)).toBe(token);
    });

    it('6. pending X + missing marker + manifest EIO creates no marker', async () => {
      const { project, token } = pendingProject();
      const restore = injectEio(dirOf(project), { only: MANIFEST_FILENAME });
      const adoption = await startup();
      restore();
      expect(ownershipRepository.findByProjectId(project.id)).toMatchObject({ token, state: 'pending' });
      expect(fs.existsSync(markerPath(project))).toBe(false);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ reason: 'manifest-unavailable' });
      await startup(); // a normal later startup also retries
      expect(expectBoundToMarker(project)).toBe(token);
    });

    it('7. every crash point resumes idempotently across restarts', async () => {
      // After pending commit, before the marker.
      const a = pendingProject();
      // After the marker, before bound.
      const b = (() => {
        const project = legacyProject('Beta');
        const token = generateProjectOwnershipToken();
        ownershipRepository.createPending(project.id, token);
        writeMarker(project, serializeProjectOwnershipMarker(token));
        return { project, token };
      })();
      // Crash before pending commit: nothing durable.
      const c = legacyProject('Gamma');

      await startup();
      const bound = [a, b].map(({ project, token }) => expect(expectBoundToMarker(project)).toBe(token));
      expect(bound).toHaveLength(2);
      const cToken = expectBoundToMarker(c);
      const snapshot = () => ({
        rows: db.prepare('SELECT * FROM project_directory_ownership ORDER BY project_id').all(),
        trees: [a.project, b.project, c].map((project) => snapshotTree(dirOf(project))),
        record: JSON.parse(createAppMetaRepository(db).getValue(PROJECT_OWNERSHIP_ADOPTION_KEY)).counts,
      });
      const first = snapshot();
      await startup();
      await startup();
      expect(snapshot()).toEqual(first);
      expect(expectBoundToMarker(c)).toBe(cToken);
    });

    it('resumes an interrupted pass from its committed cursor', async () => {
      const projects = [legacyProject('Alpha'), legacyProject('Beta'), legacyProject('Gamma')];
      // A process that stops right after committing the first project.
      let first = null;
      first = createAdoption({
        batchSize: 1,
        applicationLogger: { info: (entry) => { if (entry.event === 'projects.ownership.adopted') first.stop(); } },
      });
      first.prepare();
      first.signal();
      await first.waitForIdle();
      const partial = createProjectOwnershipAdoptionRepository(db).get();
      expect(partial).toMatchObject({ phase: 'running', cursor: projects[0].id });
      expect(ownershipRepository.findByProjectId(projects[1].id)).toBeNull();

      const adoption = await startup({ batchSize: 1 });
      for (const project of projects) expectBoundToMarker(project);
      expect(adoption.readiness()).toMatchObject({ initialPassComplete: true });
    });
  });

  // ── SMB / unavailable storage ─────────────────────────────────────────

  describe('transiently unavailable storage', () => {
    it('keeps an unavailable project retryable while others bind, then retries without restart', async () => {
      const projectA = legacyProject('Alpha');
      const projectB = legacyProject('Beta');
      const beforeA = snapshotTree(dirOf(projectA));
      const restore = injectEio(dirOf(projectA));

      const adoption = await startup();

      restore();
      expect(ownershipRepository.findByProjectId(projectA.id)).toBeNull();
      expect(snapshotTree(dirOf(projectA))).toEqual(beforeA);
      expect(adoption.getProjectStatus(projectA.id))
        .toMatchObject({ state: 'retryable', reason: 'project-directory-unavailable' });
      expectBoundToMarker(projectB);
      expect(adoption.readiness()).toMatchObject({ initialPassComplete: true, retryable: 1 });
      expect(timers).toHaveLength(1);
      expect(timers[0].delay).toBe(60_000);

      await fireRetryTimer(adoption);

      expectBoundToMarker(projectA);
      expect(adoption.getProjectStatus(projectA.id)).toMatchObject({ state: 'bound' });
      expect(adoption.readiness().retryable).toBe(0);
      expect(timers).toEqual([]);
    });

    it('keeps a one-off EIO while resolving the stored directory retryable, then binds once healthy', async () => {
      const project = legacyProject('Alpha');
      const before = snapshotTree(dirOf(project));
      const target = dirOf(project);
      // The resolver's first lstat of the stored directory fails; any later
      // (immediate) lstat succeeds. That later success proves nothing about
      // the first failure.
      const realLstat = fs.lstatSync;
      let faulted = 0;
      vi.spyOn(fs, 'lstatSync').mockImplementation((p, ...rest) => {
        if (faulted === 0 && typeof p === 'string' && path.resolve(p) === target) {
          faulted += 1;
          throw eio(p);
        }
        return realLstat(p, ...rest);
      });

      const adoption = await startup();

      expect(faulted).toBe(1);
      vi.restoreAllMocks();
      expect(adoption.getProjectStatus(project.id))
        .toMatchObject({ state: 'retryable', reason: 'project-directory-unavailable' });
      expect(adoption.readiness()).toMatchObject({ retryable: 1, recoveryRequired: 0 });
      expectUntouchedUnbound(project, before);
      expect(timers).toHaveLength(1);

      // The next lifecycle run inspects again and adopts; no operator step.
      await fireRetryTimer(adoption);

      expectBoundToMarker(project);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ state: 'bound' });
      expect(adoption.readiness()).toMatchObject({ retryable: 0, recoveryRequired: 0 });
    });

    it('still classifies a structurally invalid stored path as recovery-required', async () => {
      const nested = legacyProject('Nested');
      const foreign = legacyProject('Foreign');
      db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run(`${nested.project_dir}/inner`, nested.id);
      db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run('../escape', foreign.id);

      const adoption = await startup();

      for (const project of [nested, foreign]) {
        expect(adoption.getProjectStatus(project.id))
          .toMatchObject({ state: 'recovery-required', reason: 'project-directory-invalid' });
        expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      }
      expect(timers).toEqual([]);
    });

    it('backs off while the share stays unavailable and never marks it conflicting', async () => {
      const project = legacyProject('Alpha');
      injectEio(dirOf(project));
      const adoption = await startup({ retryBaseDelayMs: 1000, retryMaxDelayMs: 3000 });
      const delays = [timers[0].delay];
      for (let i = 0; i < 3; i++) {
        await fireRetryTimer(adoption);
        delays.push(timers[0].delay);
      }
      expect(delays).toEqual([1000, 2000, 3000, 3000]);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ state: 'retryable' });
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
    });

    it('treats a missing projects root as unavailable, not as missing content', async () => {
      const project = legacyProject('Alpha');
      const offline = `${projectsRoot}.offline`;
      fs.renameSync(projectsRoot, offline);
      const adoption = await startup();
      expect(adoption.getProjectStatus(project.id))
        .toMatchObject({ state: 'retryable', reason: 'projects-root-unavailable' });
      fs.renameSync(offline, projectsRoot);
      await startup(); // the next startup retries it
      expectBoundToMarker(project);
    });

    it('does not hold a pending row hostage when the marker write fails', async () => {
      const project = legacyProject('Alpha');
      const original = fs.openSync.bind(fs);
      vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        if (typeof target === 'string' && path.basename(target) === PROJECT_OWNERSHIP_MARKER_FILENAME
          && typeof rest[0] === 'number' && (rest[0] & fs.constants.O_CREAT)) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return original(target, ...rest);
      });
      const adoption = await startup();
      vi.restoreAllMocks();
      expect(ownershipRepository.findByProjectId(project.id)).toMatchObject({ state: 'pending' });
      expect(fs.existsSync(markerPath(project))).toBe(false);
      expect(adoption.getProjectStatus(project.id)).toMatchObject({ state: 'retryable', reason: 'marker-write-failed' });
      await fireRetryTimer(adoption);
      expectBoundToMarker(project);
    });

    it('keeps a marker exposed by a failed write, never binds it, and never rewrites it later', async () => {
      const project = legacyProject('Alpha');
      const foreign = serializeProjectOwnershipMarker(generateProjectOwnershipToken());
      const realOpen = fs.openSync;
      const realFsync = fs.fsyncSync;
      const realClose = fs.closeSync;
      let markerFd = null;
      let closed = false;
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        const fd = realOpen(target, flags, ...rest);
        if (markerFd === null && typeof target === 'string' && path.basename(target) === PROJECT_OWNERSHIP_MARKER_FILENAME
          && typeof flags === 'number' && (flags & fs.constants.O_CREAT)) markerFd = fd;
        return fd;
      });
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (fd === markerFd && !closed) throw eio('fsync');
        return realFsync(fd);
      });
      vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        realClose(fd);
        if (fd !== markerFd || closed) return;
        closed = true;
        // A foreign writer replaces the exposed, unconfirmed marker.
        fs.unlinkSync(markerPath(project));
        fs.writeFileSync(markerPath(project), foreign);
      });

      const adoption = await startup();
      vi.restoreAllMocks();
      expect(ownershipRepository.findByProjectId(project.id)).toMatchObject({ state: 'pending' });
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe(foreign);
      expect(adoption.getProjectStatus(project.id))
        .toMatchObject({ state: 'recovery-required', reason: 'marker-write-remnant', binding: 'pending' });
      expect(timers).toHaveLength(0);

      // A later pass re-inspects from scratch: the foreign marker is a
      // conflict, never overwritten, removed, or bound.
      const later = await startup();
      expect(ownershipRepository.findByProjectId(project.id)).toMatchObject({ state: 'pending' });
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe(foreign);
      expect(later.getProjectStatus(project.id)).toMatchObject({ state: 'recovery-required' });
    });
  });

  // ── scanner and scheduler ─────────────────────────────────────────────

  describe('scanner transition and scheduling', () => {
    it('scanner fails closed before adoption and reconciles external changes after it', async () => {
      const project = legacyProject('Alpha');
      const finalDir = path.join(dirOf(project), 'final');
      fs.writeFileSync(path.join(finalDir, 'one.png'), 'one');
      const scanner = createScanner();

      expect(() => scanner.scanProjectAssets(project.id)).toThrowError(ownershipFailure('UNBOUND'));
      expect(assetRows(project.id)).toEqual([]);

      await startup();

      await scanner.scanProjectAssets(project.id);
      expect(assetRows(project.id)).toEqual(['final/one.png']);
      fs.writeFileSync(path.join(finalDir, 'two.png'), 'two');
      fs.unlinkSync(path.join(finalDir, 'one.png'));
      await scanner.scanProjectAssets(project.id);
      expect(assetRows(project.id)).toEqual(['final/two.png']);
    });

    function createScheduler(adoption, scanner) {
      const scanned = [];
      const scheduler = createAutomaticProjectScanScheduler({
        intervalMinutes: 5,
        logger: { log() {}, error() {} },
        getScanDependencies: () => ({
          projectService,
          appMetaRepository: createAppMetaRepository(db),
          projectOwnershipAdoption: adoption,
          assetScanner: {
            scanProjectAssets(projectId, options) {
              scanned.push(projectId);
              return scanner.scanProjectAssets(projectId, options);
            },
          },
        }),
      });
      return { scheduler, scanned };
    }

    it('does not scan ahead of the adoption pass; healthy projects scan once it completes', async () => {
      const healthy = legacyProject('Alpha');
      const unresolved = legacyProject('Beta', { manifest: 'none' });
      fs.writeFileSync(path.join(dirOf(healthy), 'final', 'art.png'), 'png');
      const adoption = createAdoption();
      adoption.prepare();
      const { scheduler, scanned } = createScheduler(adoption, createScanner());

      adoption.signal(); // startup: adoption signalled before the first cycle
      const result = await scheduler.runCycle();

      expect(adoption.isInitialPassComplete()).toBe(true);
      expect(result).toEqual({ scanned: 1, failed: 1 });
      expect(scanned).toEqual([healthy.id, unresolved.id]);
      expect(assetRows(healthy.id)).toEqual(['final/art.png']);
      expect(ownershipRepository.findByProjectId(unresolved.id)).toBeNull();
    });

    it('defers project scans while the pass cannot run', async () => {
      legacyProject('Alpha');
      const adoption = createAdoption();
      adoption.prepare();
      const pause = adoption.pauseForMaintenance();
      const { scheduler, scanned } = createScheduler(adoption, createScanner());
      const result = await scheduler.runCycle();
      expect(result).toMatchObject({ skipped: true, reason: 'ownership-adoption-pending' });
      expect(scanned).toEqual([]);
      pause.release();
      await adoption.waitForIdle();
      expect((await scheduler.runCycle()).scanned).toBe(1);
    });
  });

  // ── application context ───────────────────────────────────────────────

  describe('application context startup', () => {
    it('prepares and signals adoption before generated-image background work', () => {
      const calls = [];
      const fakeApp = Object.assign(() => {}, {
        locals: {
          projectOwnershipAdoption: {
            prepare: () => calls.push('adoption.prepare'),
            signal: () => calls.push('adoption.signal'),
          },
          generatedImageRebuildService: {
            recover: () => calls.push('rebuild.recover'), signal: () => calls.push('rebuild.signal'),
          },
          generatedImagePublicationLifecycle: {
            prepare: () => calls.push('publication.prepare'), signal: () => calls.push('publication.signal'),
          },
        },
      });
      const context = createApplicationContext({ appName: 'test', projectsRoot }, db, () => fakeApp);
      expect(calls).toEqual([
        'adoption.prepare', 'adoption.signal',
        'rebuild.recover', 'publication.prepare', 'rebuild.signal', 'publication.signal',
      ]);
      expect(context.projectOwnershipAdoption).toBe(fakeApp.locals.projectOwnershipAdoption);
    });
  });
});
