/**
 * PM-1C2A — explicit operator recovery of project-directory ownership.
 *
 * Fixtures are real projects (created normally, so their directory trees are
 * genuine) whose ownership row and/or marker are then put into the unbound,
 * pending, conflicting, or damaged states PM-1C1 leaves for explicit recovery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import { createProjectPrimaryImageRepository } from '../src/data/project-primary-image-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createProjectOwnershipAdoptionRepository } from '../src/data/project-ownership-adoption-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectService } from '../src/services/project-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { createAssetActionService } from '../src/services/asset-action-service.js';
import { createPreviewCategorySettingsService } from '../src/services/preview-category-settings-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createProjectOwnershipRecoveryService } from '../src/services/project-ownership-recovery-service.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import { MANIFEST_FILENAME } from '../src/storage/manifest.js';
import {
  PROJECT_OWNERSHIP_MARKER_FILENAME,
  PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX,
  generateProjectOwnershipToken,
  readProjectOwnershipMarker,
  serializeProjectOwnershipMarker,
} from '../src/storage/project-ownership-marker.js';
import { createTestProjectOptionCatalogueService } from './helpers/project-option-catalogue.js';
import { snapshotTree, substituteProjectRoot } from './helpers/project-ownership.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function projectInput(title) {
  return {
    title, description: '', notes: '', status: 'tbd', priority: 'normal',
    plannedDate: null, publishedDate: null, patreonUrl: null,
  };
}

function eio(target) {
  return Object.assign(new Error(`EIO: i/o error, '${target}'`), { code: 'EIO' });
}

const recoveryFailure = (code, reason) => expect.objectContaining({
  name: 'ProjectOwnershipRecoveryError', code, ...(reason === undefined ? {} : { reason }),
});

const isCreate = (flags) => typeof flags === 'number' && (flags & fs.constants.O_CREAT) !== 0;

describe('PM-1C2A explicit project ownership recovery', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let ownershipRepository;
  let adoptionRepository;
  let assetCategoryService;
  let projectService;
  let coordinator;
  let logs;
  let maintenanceState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-ownership-recovery-'));
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
    logs = [];
    maintenanceState = { active: false };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── fixtures ──────────────────────────────────────────────────────────

  function createService(overrides = {}) {
    return createProjectOwnershipRecoveryService({
      ownershipRepository,
      adoptionRepository,
      projectsRoot,
      projectOperationCoordinator: coordinator,
      maintenanceState,
      applicationLogger: {
        info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry), error: (entry) => logs.push(entry),
      },
      ...overrides,
    });
  }

  // The PM-1C1 pass has classified every existing project.
  function finishAdoptionPass() {
    adoptionRepository.initialize();
    adoptionRepository.complete();
  }

  function dirOf(project) {
    return resolveProjectDir(projectsRoot, project.project_dir);
  }

  function markerPath(project) {
    return path.join(dirOf(project), PROJECT_OWNERSHIP_MARKER_FILENAME);
  }

  function markerBytes(project) {
    return fs.readFileSync(markerPath(project));
  }

  function quarantined(project) {
    return fs.readdirSync(dirOf(project)).filter((name) => name.startsWith(PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX));
  }

  function classify(project, reason, status = 'recovery-required') {
    adoptionRepository.setClassification(project.id, { status, reason });
  }

  /** A real project with no ownership row and no marker, left for recovery. */
  function unboundProject(title, reason = 'manifest-missing') {
    const project = projectService.create(projectInput(title));
    db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(project.id);
    fs.unlinkSync(markerPath(project));
    classify(project, reason);
    return project;
  }

  function boundProject(title) {
    const project = projectService.create(projectInput(title));
    return { project, token: ownershipRepository.findByProjectId(project.id).token };
  }

  function businessState() {
    return {
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      categories: db.prepare('SELECT * FROM project_asset_categories ORDER BY id').all(),
      tags: db.prepare('SELECT * FROM project_tags ORDER BY project_id, tag_id').all(),
    };
  }

  function expectBoundToMarker(project) {
    const row = ownershipRepository.findByProjectId(project.id);
    expect(row).toMatchObject({ state: 'bound' });
    expect(readProjectOwnershipMarker(dirOf(project))).toEqual({ status: 'valid', token: row.token });
    return row.token;
  }

  function recoverNow(service, project) {
    const status = service.getRecoveryStatus(project.id);
    return service.recover(project.id, { statusVersion: status.statusVersion });
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

  // ── status ────────────────────────────────────────────────────────────

  describe('status', () => {
    it('reports a safe, token-free, path-free status and an opaque version', () => {
      finishAdoptionPass();
      const project = unboundProject('Status');
      const status = createService().getRecoveryStatus(project.id);
      expect(status).toEqual({
        projectId: project.id,
        action: 'recover',
        reason: 'manifest-missing',
        plan: 'create-marker',
        binding: null,
        marker: 'missing',
        classification: { status: 'recovery-required', reason: 'manifest-missing' },
        statusVersion: expect.stringMatching(/^[0-9a-f]{32}$/),
      });
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain(projectsRoot);
      expect(serialized).not.toContain(project.project_dir);
    });

    it('never contains the ownership token', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Secret');
      fs.unlinkSync(markerPath(project));
      const status = createService().getRecoveryStatus(project.id);
      expect(status).toMatchObject({ action: 'recover', plan: 'restore-marker', binding: 'bound', marker: 'missing' });
      expect(JSON.stringify(status)).not.toContain(token);
    });

    it('reports a healthy bound project as needing nothing, and an unknown project as null', () => {
      finishAdoptionPass();
      const { project } = boundProject('Healthy');
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ action: 'none', reason: 'bound', marker: 'matching' });
      expect(service.getRecoveryStatus(9999)).toBeNull();
    });

    it('leaves automatic work to PM-1C1: retryable, not-yet-adopted, and unclassified pending projects', () => {
      const awaiting = projectService.create(projectInput('Awaiting'));
      db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(awaiting.id);
      fs.unlinkSync(markerPath(awaiting));
      const service = createService();
      // No lifecycle record yet: the one-time pass has not run.
      expect(service.getRecoveryStatus(awaiting.id)).toMatchObject({
        action: 'retry-later', reason: 'automatic-adoption-pending', plan: null,
      });

      finishAdoptionPass();
      classify(awaiting, 'manifest-unavailable', 'retryable');
      expect(service.getRecoveryStatus(awaiting.id)).toMatchObject({ action: 'retry-later', reason: 'manifest-unavailable' });

      const pending = projectService.create(projectInput('Pending'));
      db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(pending.id);
      expect(service.getRecoveryStatus(pending.id)).toMatchObject({
        action: 'retry-later', reason: 'automatic-adoption-pending',
      });
    });
  });

  // ── state machine ─────────────────────────────────────────────────────

  // ── stale classification retirement (PM-1C2B) ─────────────────────────

  describe('stale classification', () => {
    function staleHealthy(title, status = 'recovery-required', reason = 'manifest-missing') {
      const bound = boundProject(title);
      classify(bound.project, reason, status);
      return bound;
    }

    it.each(['recovery-required', 'retryable'])('a detailed status that verifies healthy ownership retires a stale %s classification', (status) => {
      finishAdoptionPass();
      const { project, token } = staleHealthy(`Stale ${status}`, status);
      const service = createService();
      expect(service.getAttentionHint(project.id)).not.toBeNull();
      const shown = service.getRecoveryStatus(project.id);
      expect(shown).toMatchObject({ action: 'none', reason: 'bound', marker: 'matching', classification: null });
      expect(adoptionRepository.getClassification(project.id)).toBeNull();
      expect(service.getAttentionHint(project.id)).toBeNull();
      expect(expectBoundToMarker(project)).toBe(token);
      expect(logs).toContainEqual(expect.objectContaining({ event: 'projects.ownership.classification_retired', projectId: project.id }));
    });

    it.each([
      ['recovery-required', 'marker-token-in-use'],
      ['retryable', 'project-directory-unavailable'],
    ])('never erases a newer %s classification written after the healthy observation', (status, reason) => {
      finishAdoptionPass();
      const { project } = staleHealthy('Race');
      const service = createService({
        adoptionRepository: {
          ...adoptionRepository,
          retireClassification(projectId, guard) {
            adoptionRepository.setClassification(projectId, { status, reason });
            return adoptionRepository.retireClassification(projectId, guard);
          },
        },
      });
      const shown = service.getRecoveryStatus(project.id);
      expect(shown).toMatchObject({ action: 'none', classification: { status: 'recovery-required', reason: 'manifest-missing' } });
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ status, reason });
    });

    it('never retires once the binding changed after the healthy observation', () => {
      finishAdoptionPass();
      const { project } = staleHealthy('Rebound');
      const service = createService({
        adoptionRepository: {
          ...adoptionRepository,
          retireClassification(projectId, guard) {
            db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(projectId);
            return adoptionRepository.retireClassification(projectId, guard);
          },
        },
      });
      service.getRecoveryStatus(project.id);
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ status: 'recovery-required' });
    });

    it('the repository guard requires the exact observed value and bound token', () => {
      finishAdoptionPass();
      const { project, token } = staleHealthy('Guard');
      const { revision } = adoptionRepository.readClassification(project.id);
      expect(adoptionRepository.retireClassification(project.id, { revision: `${revision} `, token })).toBe(false);
      expect(adoptionRepository.retireClassification(project.id, { revision, token: 'f'.repeat(64) })).toBe(false);
      expect(adoptionRepository.getClassification(project.id)).not.toBeNull();
      expect(adoptionRepository.retireClassification(project.id, { revision, token })).toBe(true);
      expect(adoptionRepository.getClassification(project.id)).toBeNull();
    });

    it('does not retire while another operation holds the project', () => {
      finishAdoptionPass();
      const { project } = staleHealthy('Busy');
      const service = createService();
      coordinator.run(project.id, () => service.getRecoveryStatus(project.id));
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ status: 'recovery-required' });
    });

    it('an unavailable marker, project directory (EIO) or maintenance never clears the classification', () => {
      finishAdoptionPass();
      const { project } = staleHealthy('Uncertain');
      const service = createService();
      const realLstat = fs.lstatSync;
      for (const failing of [PROJECT_OWNERSHIP_MARKER_FILENAME, path.basename(dirOf(project))]) {
        const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
          if (path.basename(String(target)) === failing) throw eio(target);
          return realLstat(target, ...rest);
        });
        try {
          expect(service.getRecoveryStatus(project.id)).toMatchObject({ action: 'retry-later' });
        } finally {
          spy.mockRestore();
        }
        expect(adoptionRepository.getClassification(project.id)).toMatchObject({ status: 'recovery-required', reason: 'manifest-missing' });
      }
      maintenanceState.active = true;
      try {
        expect(service.getRecoveryStatus(project.id)).toMatchObject({ action: 'retry-later', reason: 'maintenance' });
      } finally {
        maintenanceState.active = false;
      }
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ status: 'recovery-required' });
    });

    it('a genuine conflict (foreign, missing or different marker) never clears the classification', () => {
      finishAdoptionPass();
      const service = createService();
      const owner = boundProject('Foreign Owner');

      const foreign = staleHealthy('Foreign Marker');
      fs.copyFileSync(markerPath(owner.project), markerPath(foreign.project));
      expect(service.getRecoveryStatus(foreign.project.id)).toMatchObject({ action: 'blocked', reason: 'marker-token-in-use' });
      expect(adoptionRepository.getClassification(foreign.project.id)).not.toBeNull();

      const missing = staleHealthy('Missing Marker');
      fs.unlinkSync(markerPath(missing.project));
      expect(service.getRecoveryStatus(missing.project.id)).toMatchObject({ action: 'recover', plan: 'restore-marker' });
      expect(adoptionRepository.getClassification(missing.project.id)).not.toBeNull();

      const different = staleHealthy('Different Marker');
      const donor = boundProject('Donor');
      fs.copyFileSync(markerPath(donor.project), markerPath(different.project));
      db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(donor.project.id);
      expect(service.getRecoveryStatus(different.project.id)).toMatchObject({ action: 'recover', plan: 'replace-marker', marker: 'different' });
      expect(adoptionRepository.getClassification(different.project.id)).not.toBeNull();
    });
  });

  describe('recovery cases', () => {
    it('A: no row + no marker → fresh token, pending, marker, bound; classification cleared; manifest and metadata untouched', () => {
      finishAdoptionPass();
      const project = unboundProject('Case A');
      const manifest = '{"not":"read"}';
      fs.writeFileSync(path.join(dirOf(project), MANIFEST_FILENAME), manifest);
      const before = businessState();
      const pendingSpy = vi.spyOn(ownershipRepository, 'createPending');
      const boundSpy = vi.spyOn(ownershipRepository, 'markBound');

      const result = recoverNow(createService(), project);

      expect(result).toMatchObject({ outcome: 'recovered', plan: 'create-marker', recovery: { action: 'none', reason: 'bound' } });
      const token = expectBoundToMarker(project);
      expect(pendingSpy).toHaveBeenCalledWith(project.id, token);
      expect(boundSpy).toHaveBeenCalledWith(project.id, token);
      expect(adoptionRepository.getClassification(project.id)).toBeNull();
      expect(fs.readFileSync(path.join(dirOf(project), MANIFEST_FILENAME), 'utf8')).toBe(manifest);
      expect(businessState()).toEqual(before);
      expect(JSON.stringify(result)).not.toContain(token);
    });

    it('A: never creates a legacy manifest', () => {
      finishAdoptionPass();
      const project = unboundProject('No Manifest');
      recoverNow(createService(), project);
      expect(fs.existsSync(path.join(dirOf(project), MANIFEST_FILENAME))).toBe(false);
    });

    it('B: no row + valid unused marker X → binds X without rewriting the marker', () => {
      finishAdoptionPass();
      const project = unboundProject('Case B', 'manifest-project-mismatch');
      const token = generateProjectOwnershipToken();
      fs.writeFileSync(markerPath(project), serializeProjectOwnershipMarker(token));
      const bytes = markerBytes(project);
      const ino = fs.statSync(markerPath(project)).ino;
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ plan: 'adopt-marker', marker: 'unclaimed' });

      recoverNow(service, project);

      expect(expectBoundToMarker(project)).toBe(token);
      expect(markerBytes(project)).toEqual(bytes);
      expect(fs.statSync(markerPath(project)).ino).toBe(ino);
    });

    it('C: pending X + marker X → completes the pending binding', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Case C');
      db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(project.id);
      classify(project, 'pending-marker-malformed');
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ plan: 'complete-pending', binding: 'pending' });
      recoverNow(service, project);
      expect(expectBoundToMarker(project)).toBe(token);
    });

    it('D: pending X + no marker → publishes marker X and binds', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Case D');
      db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(project.id);
      fs.unlinkSync(markerPath(project));
      classify(project, 'manifest-missing');
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ plan: 'publish-pending' });
      recoverNow(service, project);
      expect(expectBoundToMarker(project)).toBe(token);
    });

    it('E: pending X + malformed marker → quarantines, publishes X, binds, removes quarantine', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Case E');
      db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(project.id);
      fs.writeFileSync(markerPath(project), 'creatorcrate-owner/1 partial');
      classify(project, 'pending-marker-malformed');
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ plan: 'replace-marker', marker: 'malformed' });
      expect(recoverNow(service, project)).toMatchObject({ plan: 'replace-marker', cleanup: 'removed' });
      expect(expectBoundToMarker(project)).toBe(token);
      expect(quarantined(project)).toEqual([]);
    });

    it('E: pending X + unowned valid marker Y → replaces Y with X', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Case E2');
      db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(project.id);
      fs.writeFileSync(markerPath(project), serializeProjectOwnershipMarker(generateProjectOwnershipToken()));
      classify(project, 'pending-marker-mismatch');
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ plan: 'replace-marker', marker: 'different' });
      recoverNow(service, project);
      expect(expectBoundToMarker(project)).toBe(token);
    });

    it('F: bound X + marker missing → restores marker X with the same token', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Case F');
      fs.unlinkSync(markerPath(project));
      const markSpy = vi.spyOn(ownershipRepository, 'markBound');
      const pendingSpy = vi.spyOn(ownershipRepository, 'createPending');
      expect(recoverNow(createService(), project)).toMatchObject({ plan: 'restore-marker' });
      expect(expectBoundToMarker(project)).toBe(token);
      expect(markSpy).not.toHaveBeenCalled();
      expect(pendingSpy).not.toHaveBeenCalled();
    });

    it('G: bound X + unowned marker Y → explicit replacement keeps X', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Case G');
      fs.writeFileSync(markerPath(project), serializeProjectOwnershipMarker(generateProjectOwnershipToken()));
      classify(project, 'bound-marker-mismatch');
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ plan: 'replace-marker', marker: 'different', binding: 'bound' });
      recoverNow(service, project);
      expect(expectBoundToMarker(project)).toBe(token);
      expect(quarantined(project)).toEqual([]);
      expect(adoptionRepository.getClassification(project.id)).toBeNull();
    });

    it('no row + malformed marker → replacement under a fresh token', () => {
      finishAdoptionPass();
      const project = unboundProject('Malformed', 'marker-malformed');
      fs.writeFileSync(markerPath(project), 'garbage');
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ plan: 'replace-marker', marker: 'malformed' });
      recoverNow(service, project);
      expectBoundToMarker(project);
      expect(quarantined(project)).toEqual([]);
    });

    it('an already bound project with a stale classification only clears the classification', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Stale Class');
      const service = createService();
      // The version excludes the classification. Reading the status after
      // classifying would itself retire it (see "stale classification").
      const { statusVersion } = service.getRecoveryStatus(project.id);
      classify(project, 'bound-marker-missing');
      expect(service.recover(project.id, { statusVersion })).toMatchObject({ outcome: 'already-bound' });
      expect(expectBoundToMarker(project)).toBe(token);
      expect(adoptionRepository.getClassification(project.id)).toBeNull();
    });

    it('a healthy project with nothing to clear is not recovered', () => {
      finishAdoptionPass();
      const { project } = boundProject('Nothing');
      expect(() => recoverNow(createService(), project)).toThrow(recoveryFailure('RECOVERY_NOT_REQUIRED'));
    });
  });

  // ── conflicts ─────────────────────────────────────────────────────────

  describe('conflicts', () => {
    it('refuses a marker whose token another project owns and leaves everything untouched', () => {
      finishAdoptionPass();
      const { project: b, token: bToken } = boundProject('Owner B');
      const a = unboundProject('Claimant A');
      fs.writeFileSync(markerPath(a), serializeProjectOwnershipMarker(bToken));
      const before = snapshotTree(dirOf(a));
      const service = createService();
      expect(service.getRecoveryStatus(a.id)).toMatchObject({
        action: 'blocked', reason: 'marker-token-in-use', marker: 'owned-by-another-project', plan: null,
      });

      expect(() => recoverNow(service, a)).toThrow(recoveryFailure('RECOVERY_BLOCKED', 'marker-token-in-use'));

      expect(ownershipRepository.findByProjectId(a.id)).toBeNull();
      expect(ownershipRepository.findByProjectId(b.id)).toEqual({ projectId: b.id, token: bToken, state: 'bound' });
      expect(snapshotTree(dirOf(a))).toEqual(before);
      expect(adoptionRepository.getClassification(a.id)).toMatchObject({ status: 'recovery-required', reason: 'marker-token-in-use' });
    });

    it('substitution: B’s directory (B marker) at A’s stored path is never stolen, bound or unbound', () => {
      finishAdoptionPass();
      const { project: a, token: aToken } = boundProject('Alpha');
      const { project: b, token: bToken } = boundProject('Beta');
      const substitution = substituteProjectRoot(dirOf(a), dirOf(b));
      const aTree = snapshotTree(dirOf(a));
      const bTree = snapshotTree(dirOf(b));
      const service = createService();

      // A bound: its stored path carries B's owned token.
      expect(service.getRecoveryStatus(a.id)).toMatchObject({ action: 'blocked', reason: 'marker-token-in-use' });
      expect(() => recoverNow(service, a)).toThrow(recoveryFailure('RECOVERY_BLOCKED', 'marker-token-in-use'));
      // A unbound: the same refusal.
      db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(a.id);
      expect(() => recoverNow(service, a)).toThrow(recoveryFailure('RECOVERY_BLOCKED', 'marker-token-in-use'));

      expect(snapshotTree(dirOf(a))).toEqual(aTree);
      expect(snapshotTree(dirOf(b))).toEqual(bTree);
      expect(ownershipRepository.findByProjectId(b.id)).toEqual({ projectId: b.id, token: bToken, state: 'bound' });
      expect(ownershipRepository.findByProjectId(a.id)).toBeNull();
      substitution.restore();
      expect(readProjectOwnershipMarker(dirOf(a))).toEqual({ status: 'valid', token: aToken });
    });

    it('refuses a non-regular marker entry without touching it', () => {
      finishAdoptionPass();
      const project = unboundProject('Dir Marker', 'marker-unsafe');
      fs.mkdirSync(markerPath(project));
      fs.writeFileSync(path.join(markerPath(project), 'inside'), 'x');
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ action: 'blocked', reason: 'marker-unsafe', marker: 'unsafe' });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_BLOCKED', 'marker-unsafe'));
      expect(fs.readFileSync(path.join(markerPath(project), 'inside'), 'utf8')).toBe('x');
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
    });

    it('refuses a symlinked marker without following or removing it', (ctx) => {
      finishAdoptionPass();
      const project = unboundProject('Link Marker', 'marker-unsafe');
      const outside = path.join(tmpDir, 'outside-marker');
      fs.writeFileSync(outside, serializeProjectOwnershipMarker(generateProjectOwnershipToken()));
      try { fs.symlinkSync(outside, markerPath(project), 'file'); } catch { ctx.skip(); }
      const outsideBytes = fs.readFileSync(outside);
      expect(() => recoverNow(createService(), project)).toThrow(recoveryFailure('RECOVERY_BLOCKED', 'marker-unsafe'));
      expect(fs.lstatSync(markerPath(project)).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(outside)).toEqual(outsideBytes);
    });

    it('refuses a structurally invalid stored path and never changes project_dir', () => {
      finishAdoptionPass();
      const project = unboundProject('Bad Path', 'project-directory-invalid');
      for (const bad of ['../escape', 'not-this-project', path.join(tmpDir, 'absolute')]) {
        db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run(bad, project.id);
        const service = createService();
        expect(service.getRecoveryStatus(project.id)).toMatchObject({ action: 'blocked', reason: 'project-directory-invalid' });
        expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_BLOCKED', 'project-directory-invalid'));
        expect(db.prepare('SELECT project_dir FROM projects WHERE id = ?').pluck().get(project.id)).toBe(bad);
      }
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
    });
  });

  // ── concurrency ───────────────────────────────────────────────────────

  describe('stale confirmation', () => {
    it('requires a status version', () => {
      finishAdoptionPass();
      const project = unboundProject('Blind');
      const service = createService();
      for (const statusVersion of [undefined, '', 'yes', 'x'.repeat(32)]) {
        expect(() => service.recover(project.id, { statusVersion })).toThrow(recoveryFailure('RECOVERY_CONFIRMATION_REQUIRED'));
      }
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
    });

    it('refuses a confirmation made before a marker appeared', () => {
      finishAdoptionPass();
      const project = unboundProject('Stale Marker');
      const service = createService();
      const shown = service.getRecoveryStatus(project.id);
      const foreign = serializeProjectOwnershipMarker(generateProjectOwnershipToken());
      fs.writeFileSync(markerPath(project), foreign);

      let error;
      try { service.recover(project.id, { statusVersion: shown.statusVersion }); } catch (err) { error = err; }
      expect(error).toEqual(recoveryFailure('RECOVERY_STATE_CHANGED'));
      expect(error.recovery).toMatchObject({ plan: 'adopt-marker' });
      expect(error.recovery.statusVersion).not.toBe(shown.statusVersion);
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe(foreign);
    });

    it('refuses a confirmation made before the ownership row or malformed content changed', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Stale Row');
      fs.writeFileSync(markerPath(project), 'garbage-1');
      classify(project, 'bound-marker-malformed');
      const service = createService();
      const shown = service.getRecoveryStatus(project.id);

      fs.writeFileSync(markerPath(project), 'garbage-2');
      expect(() => service.recover(project.id, { statusVersion: shown.statusVersion }))
        .toThrow(recoveryFailure('RECOVERY_STATE_CHANGED'));
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe('garbage-2');

      const reshown = service.getRecoveryStatus(project.id);
      db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(project.id);
      expect(() => service.recover(project.id, { statusVersion: reshown.statusVersion }))
        .toThrow(recoveryFailure('RECOVERY_STATE_CHANGED'));
      expect(ownershipRepository.findByProjectId(project.id)).toEqual({ projectId: project.id, token, state: 'pending' });
    });

    it('refuses while another operation holds the project', () => {
      finishAdoptionPass();
      const project = unboundProject('Busy');
      const service = createService();
      const { statusVersion } = service.getRecoveryStatus(project.id);
      expect(() => coordinator.run(project.id, () => service.recover(project.id, { statusVersion })))
        .toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'project-busy'));
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(service.recover(project.id, { statusVersion })).toMatchObject({ outcome: 'recovered' });
    });

    it('never overwrites a marker that appears while its own is being created', () => {
      finishAdoptionPass();
      const project = unboundProject('Race');
      const service = createService();
      const { statusVersion } = service.getRecoveryStatus(project.id);
      const foreign = serializeProjectOwnershipMarker(generateProjectOwnershipToken());
      const realOpen = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        if (path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME && isCreate(flags)) {
          fs.writeFileSync(target, foreign);
        }
        return realOpen(target, flags, ...rest);
      });
      expect(() => service.recover(project.id, { statusVersion })).toThrow(recoveryFailure('RECOVERY_STATE_CHANGED', 'marker-changed'));
      vi.restoreAllMocks();
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe(foreign);
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
    });

    it('during replacement, a newly appeared marker wins and the old one stays quarantined', () => {
      finishAdoptionPass();
      const project = unboundProject('Replace Race', 'marker-malformed');
      fs.writeFileSync(markerPath(project), 'old-malformed');
      const service = createService();
      const { statusVersion } = service.getRecoveryStatus(project.id);
      const foreign = serializeProjectOwnershipMarker(generateProjectOwnershipToken());
      const realOpen = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        if (path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME && isCreate(flags)) {
          fs.writeFileSync(target, foreign);
        }
        return realOpen(target, flags, ...rest);
      });
      expect(() => service.recover(project.id, { statusVersion })).toThrow(recoveryFailure('RECOVERY_STATE_CHANGED', 'marker-changed'));
      vi.restoreAllMocks();
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe(foreign);
      expect(quarantined(project)).toHaveLength(1);
      expect(fs.readFileSync(path.join(dirOf(project), quarantined(project)[0]), 'utf8')).toBe('old-malformed');
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
    });

    it('a marker swapped just before quarantine is detected and put back untouched', () => {
      finishAdoptionPass();
      const project = unboundProject('Swap', 'marker-malformed');
      fs.writeFileSync(markerPath(project), 'classified-content');
      const service = createService();
      const { statusVersion } = service.getRecoveryStatus(project.id);
      const realRename = fs.renameSync;
      let swapped = false;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (!swapped && path.basename(String(to)).startsWith(PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX)) {
          swapped = true;
          fs.unlinkSync(from);
          fs.writeFileSync(from, 'swapped-in-content');
        }
        return realRename(from, to);
      });
      expect(() => service.recover(project.id, { statusVersion })).toThrow(recoveryFailure('RECOVERY_STATE_CHANGED', 'marker-changed'));
      vi.restoreAllMocks();
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe('swapped-in-content');
      expect(quarantined(project)).toEqual([]);
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
    });
  });

  // ── interruption and faults ───────────────────────────────────────────

  describe('interrupted recovery', () => {
    function malformedPending(title) {
      const project = unboundProject(title, 'marker-malformed');
      fs.writeFileSync(markerPath(project), 'old-malformed-marker');
      return project;
    }

    function expectPreviousState(project) {
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe('old-malformed-marker');
      expect(quarantined(project)).toEqual([]);
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ reason: 'marker-malformed' });
    }

    it('pending creation failure changes nothing; retry succeeds', () => {
      finishAdoptionPass();
      const project = malformedPending('Fault Pending');
      const service = createService();
      const spy = vi.spyOn(ownershipRepository, 'createPending').mockImplementationOnce(() => { throw new Error('SQLITE_BUSY'); });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'recovery-failed'));
      spy.mockRestore();
      expectPreviousState(project);
      recoverNow(service, project);
      expectBoundToMarker(project);
    });

    it('quarantine failure (EIO) restores nothing it did not move and removes its pending row; retry succeeds', () => {
      finishAdoptionPass();
      const project = malformedPending('Fault Quarantine');
      const service = createService();
      const realRename = fs.renameSync;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (path.basename(String(to)).startsWith(PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX)) throw eio(from);
        return realRename(from, to);
      });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-quarantine-failed'));
      spy.mockRestore();
      expectPreviousState(project);
      recoverNow(service, project);
      expectBoundToMarker(project);
    });

    it('a quarantine rename that lands but reports EIO is detected and put back', () => {
      finishAdoptionPass();
      const project = malformedPending('Lost Reply');
      const service = createService();
      const realRename = fs.renameSync;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        realRename(from, to);
        if (path.basename(String(to)).startsWith(PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX)) throw eio(from);
      });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-quarantine-failed'));
      spy.mockRestore();
      expectPreviousState(project);
    });

    it('marker creation failure restores the quarantined marker and removes its pending row', () => {
      finishAdoptionPass();
      const project = malformedPending('Fault Create');
      const service = createService();
      const realOpen = fs.openSync;
      const spy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        if (path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME && isCreate(flags)) throw eio(target);
        return realOpen(target, flags, ...rest);
      });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-write-failed'));
      spy.mockRestore();
      expectPreviousState(project);
      recoverNow(service, project);
      expectBoundToMarker(project);
    });

    // Once the new marker's pathname is public, a failure before it is
    // confirmed leaves both it and the quarantined old marker exactly as
    // found: the public entry may already be a foreign replacement.
    function failAfterMarkerExposure({ replaceWith = null, failReadBack = false } = {}) {
      const realOpen = fs.openSync;
      const realFsync = fs.fsyncSync;
      const realClose = fs.closeSync;
      let markerFd = null;
      let markerTarget = null;
      let closed = false;
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        const isMarker = path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME;
        if (isMarker && closed && failReadBack) throw eio(target);
        const fd = realOpen(target, flags, ...rest);
        if (isMarker && isCreate(flags) && markerFd === null) {
          markerFd = fd;
          markerTarget = String(target);
        }
        return fd;
      });
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (fd === markerFd && !closed && !failReadBack) throw eio(fd);
        return realFsync(fd);
      });
      vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        realClose(fd);
        if (fd !== markerFd || closed) return;
        closed = true;
        if (replaceWith) {
          fs.unlinkSync(markerTarget);
          fs.writeFileSync(markerTarget, replaceWith);
        }
      });
    }

    function expectRetainedRemnant(project, publicMarker) {
      if (publicMarker === 'own') {
        expect(readProjectOwnershipMarker(dirOf(project))).toMatchObject({ status: 'valid' });
      } else {
        expect(markerBytes(project)).toEqual(Buffer.from(publicMarker, 'ascii'));
      }
      expect(quarantined(project)).toHaveLength(1);
      expect(fs.readFileSync(path.join(dirOf(project), quarantined(project)[0]), 'utf8')).toBe('old-malformed-marker');
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ reason: 'marker-write-remnant' });
    }

    it('marker fsync failure after exposure fails recovery and keeps the new marker and the quarantine', () => {
      finishAdoptionPass();
      const project = malformedPending('Fault Fsync');
      const service = createService();
      failAfterMarkerExposure();
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-write-remnant'));
      vi.restoreAllMocks();
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expectRetainedRemnant(project, 'own');
    });

    it('creation read-back failure fails recovery and keeps the new marker and the quarantine', () => {
      finishAdoptionPass();
      const project = malformedPending('Fault Readback');
      const service = createService();
      failAfterMarkerExposure({ failReadBack: true });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-write-remnant'));
      vi.restoreAllMocks();
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expectRetainedRemnant(project, 'own');
    });

    it('a foreign marker that replaces the unconfirmed new one survives byte-for-byte, with the quarantine', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Foreign Swap');
      fs.writeFileSync(markerPath(project), 'old-malformed-marker');
      classify(project, 'bound-marker-malformed');
      const service = createService();
      const foreign = serializeProjectOwnershipMarker(generateProjectOwnershipToken());
      failAfterMarkerExposure({ replaceWith: foreign });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-write-remnant'));
      vi.restoreAllMocks();
      // The existing binding is unchanged; nothing was bound to the unverified marker.
      expect(ownershipRepository.findByProjectId(project.id)).toEqual({ projectId: project.id, token, state: 'bound' });
      expectRetainedRemnant(project, foreign);
    });

    it('verification failure after publication rolls forward: pending X + marker X, old marker kept as evidence', () => {
      finishAdoptionPass();
      const project = malformedPending('Fault Verify');
      const service = createService();
      const realOpen = fs.openSync;
      let reads = -1;
      const spy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        if (path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME) {
          if (isCreate(flags)) reads = 0;
          else if (reads >= 0 && ++reads > 1) throw eio(target);
        }
        return realOpen(target, flags, ...rest);
      });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-unavailable'));
      spy.mockRestore();

      const row = ownershipRepository.findByProjectId(project.id);
      expect(row).toMatchObject({ state: 'pending' });
      expect(readProjectOwnershipMarker(dirOf(project))).toEqual({ status: 'valid', token: row.token });
      expect(quarantined(project)).toHaveLength(1);
      expect(fs.readFileSync(path.join(dirOf(project), quarantined(project)[0]), 'utf8')).toBe('old-malformed-marker');

      expect(service.getRecoveryStatus(project.id)).toMatchObject({ action: 'recover', plan: 'complete-pending' });
      recoverNow(service, project);
      expect(expectBoundToMarker(project)).toBe(row.token);
    });

    it('mark-bound failure never reports bound; retry completes the same token', () => {
      finishAdoptionPass();
      const project = malformedPending('Fault Bind');
      const service = createService();
      const spy = vi.spyOn(ownershipRepository, 'markBound').mockImplementationOnce(() => { throw new Error('SQLITE_IOERR'); });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'binding-failed'));
      spy.mockRestore();

      const row = ownershipRepository.findByProjectId(project.id);
      expect(row).toMatchObject({ state: 'pending' });
      expect(readProjectOwnershipMarker(dirOf(project))).toEqual({ status: 'valid', token: row.token });
      expect(quarantined(project)).toHaveLength(1);
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ status: 'recovery-required' });

      recoverNow(service, project);
      expect(expectBoundToMarker(project)).toBe(row.token);
    });

    it('post-bind cleanup failure keeps the binding and retains the quarantined marker', () => {
      finishAdoptionPass();
      const project = malformedPending('Fault Cleanup');
      const service = createService();
      const realUnlink = fs.unlinkSync;
      const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
        if (path.basename(String(target)).startsWith(PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX)) throw eio(target);
        return realUnlink(target);
      });
      expect(recoverNow(service, project)).toMatchObject({ outcome: 'recovered', cleanup: 'retained' });
      spy.mockRestore();
      expectBoundToMarker(project);
      expect(quarantined(project)).toHaveLength(1);
      expect(adoptionRepository.getClassification(project.id)).toBeNull();
      expect(logs.some((entry) => entry.event === 'projects.ownership.recovery_quarantine_retained')).toBe(true);
    });

    it('a restart after a crash between quarantine and publication binds without losing the old marker', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Crash Window');
      fs.writeFileSync(markerPath(project), 'old-bound-garbage');
      classify(project, 'bound-marker-malformed');
      // Simulated crash: the old marker reached quarantine, nothing else.
      const aside = path.join(dirOf(project), `${PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX}crashed`);
      fs.renameSync(markerPath(project), aside);

      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ plan: 'restore-marker' });
      recoverNow(service, project);
      expect(expectBoundToMarker(project)).toBe(token);
      expect(fs.readFileSync(aside, 'utf8')).toBe('old-bound-garbage');
    });
  });

  // ── SMB ───────────────────────────────────────────────────────────────

  describe('SMB unavailability', () => {
    it('an unreadable marker during inspection is retry-later, writes nothing, and is not a conflict', () => {
      finishAdoptionPass();
      const project = unboundProject('Share Down');
      const service = createService();
      const realLstat = fs.lstatSync;
      const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
        if (path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME) throw eio(target);
        return realLstat(target, ...rest);
      });
      const shown = service.getRecoveryStatus(project.id);
      expect(shown).toMatchObject({ action: 'retry-later', reason: 'marker-unavailable', marker: 'unavailable' });
      expect(() => service.recover(project.id, { statusVersion: shown.statusVersion }))
        .toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-unavailable'));
      spy.mockRestore();

      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ reason: 'manifest-missing' });
      recoverNow(service, project);
      expectBoundToMarker(project);
    });

    it('an access failure while resolving the stored directory is retry-later, never blocked', () => {
      finishAdoptionPass();
      const project = unboundProject('Flaky Lookup');
      const target = dirOf(project);
      const service = createService();
      // Each arming fails the resolver's first lstat of the stored directory
      // with EIO; the very next lstat (e.g. an immediate retry) succeeds.
      const realLstat = fs.lstatSync;
      let armed = false;
      vi.spyOn(fs, 'lstatSync').mockImplementation((p, ...rest) => {
        if (armed && typeof p === 'string' && path.resolve(p) === target) {
          armed = false;
          throw eio(p);
        }
        return realLstat(p, ...rest);
      });

      armed = true;
      const shown = service.getRecoveryStatus(project.id);
      expect(shown).toMatchObject({ action: 'retry-later', reason: 'project-directory-unavailable' });
      armed = true;
      // No Recover is authorized from an uncertain path state, and the
      // refusal is "unavailable", not a recorded block.
      expect(() => service.recover(project.id, { statusVersion: shown.statusVersion }))
        .toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'project-directory-unavailable'));
      vi.restoreAllMocks();

      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ reason: 'manifest-missing' });
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ action: 'recover' });
      recoverNow(service, project);
      expectBoundToMarker(project);
    });

    it('a missing project directory or unavailable projects root is retry-later, never recovery', () => {
      finishAdoptionPass();
      const project = unboundProject('Gone');
      const aside = `${dirOf(project)}.away`;
      fs.renameSync(dirOf(project), aside);
      const service = createService();
      const shown = service.getRecoveryStatus(project.id);
      expect(shown).toMatchObject({ action: 'retry-later', reason: 'project-directory-missing' });
      expect(() => service.recover(project.id, { statusVersion: shown.statusVersion }))
        .toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'project-directory-missing'));
      fs.renameSync(aside, dirOf(project));

      const rootAside = `${projectsRoot}.away`;
      fs.renameSync(projectsRoot, rootAside);
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ action: 'retry-later', reason: 'projects-root-unavailable' });
      fs.renameSync(rootAside, projectsRoot);

      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ reason: 'manifest-missing' });
      recoverNow(service, project);
      expectBoundToMarker(project);
    });

    it('EIO while quarantining or creating on a share keeps the previous state; retry succeeds', () => {
      finishAdoptionPass();
      const { project, token } = boundProject('Flaky Share');
      fs.writeFileSync(markerPath(project), 'flaky-old');
      classify(project, 'bound-marker-malformed');
      const service = createService();
      const realLink = fs.linkSync;
      const realOpen = fs.openSync;
      let createFailed = false;
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        if (!createFailed && path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME && isCreate(flags)) {
          createFailed = true;
          throw eio(target);
        }
        return realOpen(target, flags, ...rest);
      });
      // A share without link support: restore falls back to an exclusive-create copy.
      const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
      });
      expect(() => recoverNow(service, project)).toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-write-failed'));
      openSpy.mockRestore();
      linkSpy.mockRestore();
      expect(realLink).toBe(fs.linkSync);

      expect(ownershipRepository.findByProjectId(project.id)).toEqual({ projectId: project.id, token, state: 'bound' });
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe('flaky-old');
      expect(quarantined(project)).toEqual([]);
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ reason: 'bound-marker-malformed' });

      recoverNow(service, project);
      expect(expectBoundToMarker(project)).toBe(token);
    });

    it('without hard links, rollback never overwrites a marker that appears before the old one is restored', () => {
      finishAdoptionPass();
      const project = unboundProject('Rollback Race', 'marker-malformed');
      fs.writeFileSync(markerPath(project), 'old-malformed-marker');
      const service = createService();
      const { statusVersion } = service.getRecoveryStatus(project.id);
      const foreign = serializeProjectOwnershipMarker(generateProjectOwnershipToken());
      const isMarker = (target) => path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME;
      const realOpen = fs.openSync;
      const realRename = fs.renameSync;
      let published = false;
      let linkRefused = false;
      // Another actor creates a marker the moment rollback would place the
      // old one: after the path was seen free, before anything lands on it.
      const injectForeign = (target) => {
        if (linkRefused && isMarker(target) && !fs.existsSync(target)) fs.writeFileSync(target, foreign);
      };
      vi.spyOn(fs, 'linkSync').mockImplementation(() => {
        linkRefused = true;
        throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
      });
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        if (isMarker(target) && isCreate(flags)) {
          if (!published) {
            published = true;
            throw eio(target); // the replacement marker cannot be published → roll back
          }
          injectForeign(target);
        }
        return realOpen(target, flags, ...rest);
      });
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        injectForeign(to);
        return realRename(from, to);
      });
      expect(() => service.recover(project.id, { statusVersion }))
        .toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-write-failed'));
      vi.restoreAllMocks();

      expect(linkRefused).toBe(true);
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe(foreign);
      expect(quarantined(project)).toHaveLength(1);
      expect(fs.readFileSync(path.join(dirOf(project), quarantined(project)[0]), 'utf8')).toBe('old-malformed-marker');
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(adoptionRepository.getClassification(project.id)).toMatchObject({ reason: 'marker-malformed' });
      expect(logs).toContainEqual(expect.objectContaining({ event: 'projects.ownership.recovery_quarantine_retained' }));
    });

    it('without hard links, an unverified rollback copy is retained with the quarantine and recovery fails', () => {
      finishAdoptionPass();
      const project = unboundProject('Rollback Unverified', 'marker-malformed');
      fs.writeFileSync(markerPath(project), 'old-malformed-marker');
      const service = createService();
      const { statusVersion } = service.getRecoveryStatus(project.id);
      const isMarker = (target) => path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME;
      const realOpen = fs.openSync;
      const realFsync = fs.fsyncSync;
      const realUnlink = fs.unlinkSync;
      let published = false;
      let restoreFd = null;
      vi.spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
      });
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        if (isMarker(target) && isCreate(flags)) {
          if (!published) {
            published = true;
            throw eio(target); // the replacement marker cannot be published → roll back
          }
          restoreFd = realOpen(target, flags, ...rest);
          return restoreFd;
        }
        return realOpen(target, flags, ...rest);
      });
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (fd === restoreFd) throw eio(fd); // the rollback copy cannot be proven durable
        return realFsync(fd);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => realUnlink(target));
      expect(() => service.recover(project.id, { statusVersion }))
        .toThrow(recoveryFailure('RECOVERY_UNAVAILABLE', 'marker-write-failed'));
      const publicUnlinks = unlinkSpy.mock.calls.filter(([target]) => isMarker(target));
      vi.restoreAllMocks();

      expect(restoreFd).not.toBeNull();
      expect(publicUnlinks).toEqual([]);
      expect(fs.readFileSync(markerPath(project), 'utf8')).toBe('old-malformed-marker');
      expect(quarantined(project)).toHaveLength(1);
      expect(fs.readFileSync(path.join(dirOf(project), quarantined(project)[0]), 'utf8')).toBe('old-malformed-marker');
      expect(ownershipRepository.findByProjectId(project.id)).toBeNull();
      expect(logs).toContainEqual(expect.objectContaining({ event: 'projects.ownership.recovery_quarantine_retained' }));
    });

    it('maintenance defers recovery', () => {
      finishAdoptionPass();
      const project = unboundProject('Maintenance');
      maintenanceState.active = true;
      const service = createService();
      expect(service.getRecoveryStatus(project.id)).toMatchObject({ action: 'retry-later', reason: 'maintenance' });
      maintenanceState.active = false;
      recoverNow(service, project);
      expectBoundToMarker(project);
    });
  });

  // ── usability ─────────────────────────────────────────────────────────

  describe('after recovery', () => {
    it('scanner and asset mutations work immediately, verified by the normal PM-1B gate', () => {
      finishAdoptionPass();
      const project = unboundProject('Usable');
      fs.writeFileSync(path.join(dirOf(project), 'final', 'piece.png'), 'png-bytes');
      const scanner = createScanner();
      expect(() => scanner.scanProjectAssets(project.id)).toThrow(expect.objectContaining({ code: 'UNBOUND' }));

      recoverNow(createService(), project);

      scanner.scanProjectAssets(project.id);
      const asset = db.prepare('SELECT * FROM assets WHERE project_id = ? AND is_present = 1').get(project.id);
      expect(asset).toMatchObject({ relative_path: 'final/piece.png' });

      const actions = createAssetActionService({
        projectRepository: createProjectRepository(db),
        assetRepository: createAssetRepository(db),
        assetCategoryRepository: createAssetCategoryRepository(db),
        projectsRoot,
        projectOperationCoordinator: coordinator,
        alreadyCoordinatedCapability: Object.freeze({}),
        projectDirectoryOwnershipRepository: ownershipRepository,
      });
      actions.renameAsset(project.id, asset.id, 'renamed.png');
      expect(fs.existsSync(path.join(dirOf(project), 'final', 'renamed.png'))).toBe(true);
    });
  });
});
