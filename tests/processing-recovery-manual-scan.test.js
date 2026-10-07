import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createProcessingRecoveryEvidenceRepository } from '../src/data/processing-recovery-evidence-repository.js';
import { createProcessingRecoveryGateRepository } from '../src/data/processing-recovery-gate-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import {
  createProcessingRecoveryEvidenceService,
  EVIDENCE_POLICY_CATALOG,
  isCleanupPolicyEligible,
  MANUAL_SCAN_RETENTION,
} from '../src/services/processing-recovery-evidence-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createManualScanAcceptanceAuthority } from '../src/services/manual-scan-acceptance.js';
import { createAutomaticProjectScanScheduler } from '../src/services/automatic-project-scan-scheduler.js';
import { deriveDisabledModeCsrfToken } from '../src/middleware/csrf.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const TOKEN = '0123456789abcdef';
const RUN = 'run-wp8b';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const PROMPT_BACKUP = `.creatorcrate-workflow-prompts-staging/${TOKEN}.0.original`;
const PROMPT_STAGE = `.creatorcrate-workflow-prompts-staging/${TOKEN}.0.png`;
const WATERMARK_STAGE = `.creatorcrate-watermark-staging/${TOKEN}.0.output`;
const ARCHIVE_STAGE = `.creatorcrate-watermark-staging/${TOKEN}.archive-0.cbz`;
const ARCHIVE_BACKUP = `.creatorcrate-watermark-staging/${TOKEN}.archive-0.destination`;
const CONVERT_STAGE = `.creatorcrate-convert-staging/${TOKEN}.0.output`;
const CONVERT_BACKUP = `.creatorcrate-convert-staging/${TOKEN}.0.source`;

// Filesystem calls that create, change or remove anything. WP8B must make none of them.
const MUTATING_FS = /^(?:fs|fs\.promises)\.(?:unlink|rm|rmdir|rename|write|writeFile|appendFile|copyFile|cp|truncate|ftruncate|utimes|futimes|lutimes|chmod|fchmod|lchmod|chown|fchown|lchown|mkdir|mkdtemp|symlink|link)(?:Sync)?$/;

function spyFs() {
  const calls = [];
  for (const [target, prefix] of [[fs, 'fs'], [fs.promises, 'fs.promises']]) {
    for (const name of Object.keys(target)) {
      if (typeof target[name] !== 'function' || /^[A-Z]/.test(name)) continue;
      const original = target[name];
      try {
        vi.spyOn(target, name).mockImplementation(function spied(...args) {
          calls.push({ name: `${prefix}.${name}`, args });
          return original.apply(this, args);
        });
      } catch {
        // Non-configurable members cannot be spied; none of them mutates a file.
      }
    }
  }
  return calls;
}

describe('WP8B manual-scan recovery acceptance', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let repo;
  let gate;
  let coordinator;
  let acceptanceAuthority;
  let service;
  let projectA;
  let projectB;

  function insertProject(slug) {
    const id = Number(db.prepare(`INSERT INTO projects (title, slug, status, project_type)
      VALUES (?, ?, 'tbd', 'images')`).run(slug, slug).lastInsertRowid);
    const relative = `${String(id).padStart(6, '0')}-${slug}`;
    db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run(relative, id);
    const dir = path.join(projectsRoot, relative);
    fs.mkdirSync(dir, { recursive: true });
    bindTestProjectOwnership(db, id, dir);
    return { id, dir };
  }

  function makeService(overrides = {}) {
    return createProcessingRecoveryEvidenceService({
      db,
      repository: repo,
      projectRepository: createProjectRepository(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectsRoot,
      projectOperationCoordinator: coordinator,
      processingRecoveryGate: gate,
      manualScanAcceptance: acceptanceAuthority.verifier,
      ...overrides,
    });
  }

  const abs = (project, relative) => path.join(project.dir, ...relative.split('/'));

  function writeFile(project, relative, bytes) {
    const target = abs(project, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return target;
  }

  function identityOf(target) {
    const stats = fs.lstatSync(target, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  }

  function addGroup(project = projectA, { operation = 'workflow-prompt', checkpoint = 'unlink' } = {}) {
    const group = repo.createMutationGroup({ projectId: project.id, operation, runId: RUN, itemKey: 'asset:1' });
    if (checkpoint) repo.markMutationCheckpoint(project.id, group.groupId, checkpoint);
    return repo.findMutationGroup(project.id, group.groupId);
  }

  // A PRIVATE row whose recorded identity and proof are those of a real file at its path
  // (unless `write` is false or overridden). Defaults: a Prompt original backup of `Final/a.png`.
  function addPrivate(project = projectA, {
    group, operation = 'workflow-prompt', artifactRole = 'original-backup', artifactPath = PROMPT_BACKUP,
    bytes = Buffer.from('ORIGINAL BYTES A'), write = true, identity, lifecycle = 'recovery-critical',
    sourcePath = 'Final/a.png', destinationPath = null, retentionReason = 'restoration-failed',
    expectedSize, expectedSha256,
  } = {}) {
    const target = write ? writeFile(project, artifactPath, bytes) : abs(project, artifactPath);
    const owner = group ?? addGroup(project, { operation });
    const row = repo.createEvidence({
      projectId: project.id, mutationGroupId: owner.groupId, artifactRole, retentionReason, artifactPath,
      sourcePath, destinationPath,
      identity: identity === undefined ? (write ? identityOf(target) : null) : identity,
      expectedSize: expectedSize === undefined ? bytes.length : expectedSize,
      expectedSha256: expectedSha256 === undefined ? sha256(bytes) : expectedSha256,
      lifecycle,
    });
    return { row, group: repo.findMutationGroup(project.id, owner.groupId), target };
  }

  function addPublic(project = projectA, {
    group, operation = 'workflow-prompt', artifactRole = 'published-output', artifactPath = 'Final/a.png',
    bytes = Buffer.from('PUBLISHED'), write = true, identity, lifecycle = 'recovery-critical',
  } = {}) {
    const target = write ? writeFile(project, artifactPath, bytes) : abs(project, artifactPath);
    const owner = group ?? addGroup(project, { operation });
    const row = repo.createEvidence({
      projectId: project.id, mutationGroupId: owner.groupId, artifactRole, retentionReason: 'publication-failed',
      artifactPath, identity: identity === undefined ? (write ? identityOf(target) : null) : identity,
      expectedSize: bytes.length, expectedSha256: sha256(bytes), lifecycle,
    });
    return { row, group: repo.findMutationGroup(project.id, owner.groupId), target };
  }

  // The manual scan's acceptance hook, as the scanner runs it: inside the project's lock,
  // with a fresh one-shot acceptance minted by this fixture's own authority.
  const accept = (project = projectA) => coordinator.run(project.id, () => acceptanceAuthority.grant
    .withAcceptance(project.id, (acceptance) => service.reconcileAfterManualScan(project.id, acceptance)));
  const evidence = (entry, project = projectA) => repo.findEvidence(project.id, entry.row.evidenceId);
  const group = (entry, project = projectA) => repo.findMutationGroup(project.id, entry.group.groupId);

  function snapshot() {
    return {
      groups: db.prepare('SELECT * FROM processing_recovery_mutation_groups ORDER BY group_id').all(),
      evidence: db.prepare('SELECT * FROM processing_recovery_evidence ORDER BY evidence_id').all(),
      gate: db.prepare("SELECT * FROM app_meta WHERE key GLOB 'processing.recovery_required.*' ORDER BY key").all(),
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wp8b-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot);
    db = openDatabase(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);
    repo = createProcessingRecoveryEvidenceRepository(db);
    gate = createProcessingRecoveryGateRepository(db);
    coordinator = createProjectOperationCoordinator();
    acceptanceAuthority = createManualScanAcceptanceAuthority();
    projectA = insertProject('project-a');
    projectB = insertProject('project-b');
    service = makeService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.exec('DROP TRIGGER IF EXISTS wp8b_fail');
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('policy catalog live targets', () => {
    it('names the persisted live-target field for every private role, none for public roles', () => {
      const targets = Object.fromEntries(Object.entries(EVIDENCE_POLICY_CATALOG).flatMap(([operation, roles]) => (
        Object.entries(roles).map(([role, policy]) => [`${operation}/${role}`, policy.liveTarget ?? null]))));
      expect(targets).toEqual({
        'workflow-prompt/stage-output': 'destinationPath',
        'workflow-prompt/original-backup': 'sourcePath',
        'workflow-prompt/published-output': null,
        'watermark/stage-output': 'destinationPath',
        'watermark/destination-backup': 'destinationPath',
        'watermark/staged-original': 'sourcePath',
        'watermark/published-output': null,
        'archive/archive-stage': 'destinationPath',
        'archive/destination-backup': 'destinationPath',
        'archive/published-archive': null,
        'convert/stage-output': 'destinationPath',
        'convert/original-backup': 'sourcePath',
        'convert/staged-original': 'sourcePath',
        'convert/published-output': null,
        'convert/originals-copy': null,
      });
    });
  });

  describe('serialization and authority', () => {
    it('refuses to run outside any operation, without an acceptance, and without the gate dependency', () => {
      addGroup();
      gate.markRecoveryRequired(projectA.id);
      const before = snapshot();
      const notAuthorized = expect.objectContaining({ code: 'RECOVERY_RECONCILIATION_NOT_AUTHORIZED' });
      // Direct call with no owner at all.
      expect(() => service.reconcileAfterManualScan(projectA.id)).toThrow(notAuthorized);
      // A live acceptance outside the project operation still fails the coordinator sanity check.
      expect(() => acceptanceAuthority.grant.withAcceptance(projectA.id, (acceptance) => (
        service.reconcileAfterManualScan(projectA.id, acceptance)))).toThrow('inside the manual scan');
      // Inside the project's own operation, no caller-supplied value stands in for the acceptance.
      for (const forged of [undefined, null, true, 'manual', projectA.id, { manual: true },
        { projectId: projectA.id }, Object.create(null)]) {
        expect(() => coordinator.run(projectA.id, () => service.reconcileAfterManualScan(projectA.id, forged)))
          .toThrow(notAuthorized);
      }
      // A service without the verifier can never settle, even with a live acceptance.
      expect(() => coordinator.run(projectA.id, () => acceptanceAuthority.grant.withAcceptance(projectA.id,
        (acceptance) => makeService({ manualScanAcceptance: undefined }).reconcileAfterManualScan(projectA.id, acceptance))))
        .toThrow(notAuthorized);
      expect(() => coordinator.run(projectA.id, () => makeService({ processingRecoveryGate: undefined })
        .reconcileAfterManualScan(projectA.id))).toThrow('processingRecoveryGate');
      expect(snapshot()).toEqual(before);
      expect(gate.isRecoveryRequired(projectA.id)).toBe(true);
    });

    it('an acceptance is project-bound, one-shot and dead once its callback returns', () => {
      const ofProject = (state, project) => ({
        groups: state.groups.filter((row) => row.project_id === project.id),
        evidence: state.evidence.filter((row) => row.project_id === project.id),
        gate: state.gate.filter((row) => row.key.endsWith(`.${project.id}`)),
      });
      const a = addPrivate();
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      gate.markRecoveryRequired(projectA.id);
      const b = addPrivate(projectB);
      writeFile(projectB, 'Final/a.png', 'ORIGINAL BYTES A');
      const bPublic = addPublic(projectB, { group: b.group, artifactPath: 'Final/p.png' });
      const bEmpty = addGroup(projectB, { operation: 'convert', checkpoint: null });
      gate.markRecoveryRequired(projectB.id);
      const bBefore = ofProject(snapshot(), projectB);
      expect(bBefore.gate).toHaveLength(1);
      const calls = spyFs();
      let stale;
      const tryCall = (projectId, value) => {
        try { return service.reconcileAfterManualScan(projectId, value); } catch (err) { return err.code; }
      };
      const outcomes = coordinator.run(projectA.id, () => coordinator.run(projectB.id, () => (
        acceptanceAuthority.grant.withAcceptance(projectA.id, (acceptance) => {
          stale = acceptance;
          const crossProject = tryCall(projectB.id, acceptance);
          const bAfterCross = ofProject(snapshot(), projectB);
          const first = tryCall(projectA.id, acceptance);
          const second = tryCall(projectA.id, acceptance);
          return { crossProject, bAfterCross, first, second };
        })
      )));
      vi.restoreAllMocks();
      expect(outcomes.crossProject).toBe('RECOVERY_RECONCILIATION_NOT_AUTHORIZED');
      expect(outcomes.bAfterCross).toEqual(bBefore);
      expect(outcomes.first).toMatchObject({ privateMadeDispensable: 1 });
      expect(outcomes.second).toBe('RECOVERY_RECONCILIATION_NOT_AUTHORIZED');
      // Only project A's own settlement read anything; project B was never inspected.
      expect(calls.filter((call) => typeof call.args[0] === 'string' && call.args[0].startsWith(projectB.dir)))
        .toEqual([]);
      expect(evidence(a).lifecycle).toBe('dispensable');
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);

      // Stale after its callback returned: rejected outside and inside either project's operation.
      gate.markRecoveryRequired(projectA.id);
      addGroup(projectA, { operation: 'convert', checkpoint: 'replace' });
      const before = snapshot();
      expect(tryCall(projectA.id, stale)).toBe('RECOVERY_RECONCILIATION_NOT_AUTHORIZED');
      expect(coordinator.run(projectA.id, () => tryCall(projectA.id, stale))).toBe('RECOVERY_RECONCILIATION_NOT_AUTHORIZED');
      expect(coordinator.run(projectB.id, () => tryCall(projectB.id, stale))).toBe('RECOVERY_RECONCILIATION_NOT_AUTHORIZED');
      expect(snapshot()).toEqual(before);
      expect(ofProject(before, projectB)).toEqual(bBefore);
      expect(evidence(b, projectB)).toMatchObject({ lifecycle: 'recovery-critical', retentionReason: 'restoration-failed' });
      expect(evidence(bPublic, projectB)).not.toBeNull();
      expect(group(b, projectB).checkpoint).toBe('unlink');
      expect(repo.findMutationGroup(projectB.id, bEmpty.groupId)).not.toBeNull();
      expect(gate.isRecoveryRequired(projectB.id)).toBe(true);
    });

    it('an unrelated suspended operation (isActive true, no scan) cannot authorize settlement', async () => {
      // Reviewer reproduction against the rooted application's own Recovery Evidence service.
      const app = createApp(
        { appName: 'CreatorCrate', db, projectsRoot },
        { appDataRoot: tmpDir, projectOperationCoordinator: coordinator, authState: { csrfPepper: 'a'.repeat(64) } },
      );
      const appService = app.locals.processingRecoveryEvidenceService;
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A'); // would otherwise become dispensable
      const published = addPublic(projectA, { group: backup.group, artifactPath: 'Final/p.png' });
      const empty = addGroup(projectA, { operation: 'convert', checkpoint: null });
      gate.markRecoveryRequired(projectA.id);
      const before = snapshot();
      const scanSpy = vi.spyOn(app.locals.assetScanner, 'scanProjectAssets');

      let release;
      let entered;
      const started = new Promise((resolve) => { entered = resolve; });
      const unrelated = coordinator.runAsync(projectA.id, async () => {
        entered();
        await new Promise((resolve) => { release = resolve; });
        return 'unrelated-done';
      });
      await started;
      expect(coordinator.isActive(projectA.id)).toBe(true);
      expect(scanSpy).not.toHaveBeenCalled();

      const calls = spyFs();
      const attempts = [undefined, null, {}, { manual: true }, { projectId: projectA.id }].map((value) => {
        try {
          appService.reconcileAfterManualScan(projectA.id, value);
          return 'settled';
        } catch (err) {
          return err.code;
        }
      });
      const reads = calls.filter((call) => typeof call.args[0] === 'string' && call.args[0].startsWith(projectsRoot));
      expect(scanSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      expect(attempts).toEqual(Array(5).fill('RECOVERY_RECONCILIATION_NOT_AUTHORIZED'));
      expect(reads).toEqual([]);

      expect(snapshot()).toEqual(before);
      expect(evidence(backup)).toMatchObject({
        lifecycle: 'recovery-critical', retentionReason: 'restoration-failed', observation: backup.row.observation,
      });
      expect(group(backup).checkpoint).toBe('unlink');
      expect(evidence(published)).not.toBeNull();
      expect(repo.findMutationGroup(projectA.id, empty.groupId)).not.toBeNull();
      expect(gate.isRecoveryRequired(projectA.id)).toBe(true);
      // The unrelated operation still owns the project and completes normally.
      expect(coordinator.isActive(projectA.id)).toBe(true);
      expect(() => coordinator.run(projectA.id, () => {})).toThrow(expect.objectContaining({
        code: 'PROJECT_OPERATION_IN_PROGRESS',
      }));
      release();
      await expect(unrelated).resolves.toBe('unrelated-done');
      expect(coordinator.isActive(projectA.id)).toBe(false);
      expect(fs.readFileSync(backup.target, 'utf8')).toBe('ORIGINAL BYTES A');
    });

    it('performs all filesystem inspection with no transaction open, then exactly one settlement transaction', () => {
      const unique = addPrivate();
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      const redundant = addPrivate(projectA, {
        artifactPath: PROMPT_STAGE, artifactRole: 'stage-output', bytes: Buffer.from('EDITED'),
        sourcePath: 'Final/b.png', destinationPath: 'Final/b.png',
      });
      writeFile(projectA, 'Final/b.png', 'EDITED');
      const realTransaction = db.transaction.bind(db);
      const transactions = vi.spyOn(db, 'transaction').mockImplementation((fn) => realTransaction(fn));
      const realRead = fs.readFileSync.bind(fs);
      const reads = [];
      vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
        reads.push(db.inTransaction);
        return realRead(...args);
      });
      const writesInTransaction = [];
      for (const method of ['setEvidenceObservation', 'setEvidenceLifecycle', 'setEvidenceRetentionReason',
        'clearMutationCheckpoint', 'deleteMutationGroup', 'deleteEvidence']) {
        const original = repo[method];
        repo[method] = (...args) => { writesInTransaction.push(db.inTransaction); return original(...args); };
      }
      accept();
      // Unique backup, redundant stage and its live target (the differing target fails its size check unread).
      expect(reads.length).toBe(3);
      expect(reads.every((inside) => inside === false)).toBe(true);
      expect(writesInTransaction.length).toBeGreaterThan(0);
      expect(writesInTransaction.every(Boolean)).toBe(true);
      expect(transactions).toHaveBeenCalledOnce();
      expect(evidence(unique).lifecycle).toBe('recovery-critical');
      expect(evidence(redundant).lifecycle).toBe('dispensable');
    });

    it('creates, changes, renames and removes no file anywhere', () => {
      const unique = addPrivate();
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      const missing = addPrivate(projectA, { artifactPath: CONVERT_BACKUP, operation: 'convert', write: false,
        identity: { dev: 1n, ino: 2n } });
      const published = addPublic(projectA, { group: unique.group, artifactPath: 'Final/c.png' });
      const originals = addPublic(projectA, { operation: 'convert', artifactRole: 'originals-copy',
        artifactPath: 'Final/originals/a.png', bytes: Buffer.from('ORIGINAL') });
      gate.markRecoveryRequired(projectA.id);
      const calls = spyFs();
      accept();
      vi.restoreAllMocks();
      expect(calls.filter((call) => MUTATING_FS.test(call.name))).toEqual([]);
      expect(calls.filter((call) => call.name.endsWith('openSync') && !['r', 0].includes(call.args[1]))).toEqual([]);
      expect(calls.filter((call) => /readdir|opendir|glob/i.test(call.name))).toEqual([]);
      expect(fs.readFileSync(unique.target, 'utf8')).toBe('ORIGINAL BYTES A');
      expect(fs.readFileSync(published.target, 'utf8')).toBe('PUBLISHED');
      expect(fs.readFileSync(originals.target, 'utf8')).toBe('ORIGINAL');
      expect(evidence(missing).lifecycle).toBe('dispensable');
    });

    it('the settlement source contains no destructive filesystem primitive', () => {
      const source = service.reconcileAfterManualScan.toString();
      expect(source).not.toMatch(/unlink|removeFile|rename|rmSync|cleanupEvidence|cleanupRow/);
    });
  });

  describe('checkpoints, groups and the gate', () => {
    it('clears a checkpoint and deletes the zero-evidence group, with no filesystem inspection', () => {
      const empty = addGroup(projectA, { operation: 'convert', checkpoint: 'replace' });
      gate.markRecoveryRequired(projectA.id);
      const calls = spyFs();
      const summary = accept();
      vi.restoreAllMocks();
      expect(calls).toEqual([]);
      expect(repo.findMutationGroup(projectA.id, empty.groupId)).toBeNull();
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
      expect(summary).toEqual({
        publicTrackingRetired: 0, privateMadeDispensable: 0, privateRetained: 0, groupsResolved: 1, groupsRemoved: 1,
      });
    });

    it('keeps a group only while evidence remains; checkpoint-null zero-evidence groups go', () => {
      const retained = addPrivate();
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      const uncheckpointedEmpty = addGroup(projectA, { checkpoint: null });
      const publicOnly = addPublic(projectA, { artifactPath: 'Final/p.png' });
      accept();
      expect(group(retained)).toMatchObject({ checkpoint: null, checkpointAt: null });
      expect(repo.findMutationGroup(projectA.id, uncheckpointedEmpty.groupId)).toBeNull();
      expect(group(publicOnly)).toBeNull();
    });

    it('mixed public/private group: public retired, checkpoint cleared, unique private kept, group kept, gate clear', () => {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      const published = addPublic(projectA, { group: backup.group, artifactPath: 'Final/a.png', write: false,
        identity: identityOf(abs(projectA, 'Final/a.png')) });
      gate.markRecoveryRequired(projectA.id);
      expect(accept()).toMatchObject({ publicTrackingRetired: 1, privateRetained: 1, groupsResolved: 1, groupsRemoved: 0 });
      expect(evidence(published)).toBeNull();
      expect(evidence(backup)).toMatchObject({ lifecycle: 'recovery-critical', retentionReason: 'restoration-failed' });
      expect(group(backup)).toMatchObject({ checkpoint: null });
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });

    it('works with the gate already clear and is idempotent', () => {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
      accept();
      expect(evidence(backup).lifecycle).toBe('recovery-critical');
      // The user repairs the live file from the retained copy; a later manual scan sees it.
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      accept();
      expect(evidence(backup)).toMatchObject({
        lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.redundant, observation: 'present',
      });
      expect(fs.existsSync(backup.target)).toBe(true);
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });

    it('never touches another project’s groups, evidence or gate', () => {
      addGroup(projectA, { checkpoint: 'replace' });
      const other = addPrivate(projectB);
      writeFile(projectB, 'Final/a.png', 'ORIGINAL BYTES A');
      const otherEmpty = addGroup(projectB, { checkpoint: 'unlink' });
      addPublic(projectB, { artifactPath: 'Final/p.png' });
      gate.markRecoveryRequired(projectA.id);
      gate.markRecoveryRequired(projectB.id);
      const projectBRows = () => snapshot().evidence.filter((row) => row.project_id === projectB.id);
      const projectBGroups = () => snapshot().groups.filter((row) => row.project_id === projectB.id);
      const beforeRows = projectBRows();
      const beforeGroups = projectBGroups();
      accept(projectA);
      expect(projectBRows()).toEqual(beforeRows);
      expect(projectBGroups()).toEqual(beforeGroups);
      expect(repo.findMutationGroup(projectB.id, otherEmpty.groupId)).not.toBeNull();
      expect(evidence(other, projectB).lifecycle).toBe('recovery-critical');
      expect(gate.isRecoveryRequired(projectB.id)).toBe(true);
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });
  });

  describe('private copies: the central product rule', () => {
    it('unique Prompt original-backup (A) vs accepted source (B): checkpoint and gate clear, copy stays critical', () => {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      gate.markRecoveryRequired(projectA.id);
      const before = evidence(backup);
      accept();
      const after = evidence(backup);
      expect(after).toMatchObject({
        lifecycle: 'recovery-critical', retentionReason: 'restoration-failed', observation: 'present',
        identity: before.identity, expectedSize: before.expectedSize, expectedSha256: before.expectedSha256,
        artifactPath: before.artifactPath,
      });
      expect(group(backup)).toMatchObject({ checkpoint: null });
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
      expect(fs.readFileSync(backup.target, 'utf8')).toBe('ORIGINAL BYTES A');
      expect(isCleanupPolicyEligible(after)).toBe(false);
    });

    it('WP7B cleanup still refuses the retained unique copy after acceptance', async () => {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      accept();
      const [result] = await service.cleanupEvidence(projectA.id, [backup.row.evidenceId]);
      expect(result).toMatchObject({ status: 'blocked', reason: 'recovery-critical' });
      expect(fs.readFileSync(backup.target, 'utf8')).toBe('ORIGINAL BYTES A');
    });

    it('matching original-backup/source: dispensable manual-scan-redundant, file stays; later WP7B can clean it', async () => {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      gate.markRecoveryRequired(projectA.id);
      expect(accept()).toMatchObject({ privateMadeDispensable: 1, privateRetained: 0 });
      expect(evidence(backup)).toMatchObject({
        lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.redundant, observation: 'present',
      });
      expect(fs.readFileSync(backup.target, 'utf8')).toBe('ORIGINAL BYTES A');
      expect(group(backup)).toMatchObject({ checkpoint: null });
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
      // Deletion stays a separate explicit WP7B action with its own fresh proof.
      const [result] = await service.cleanupEvidence(projectA.id, [backup.row.evidenceId]);
      expect(result).toMatchObject({ status: 'cleaned' });
      expect(fs.readFileSync(abs(projectA, 'Final/a.png'), 'utf8')).toBe('ORIGINAL BYTES A');
    });

    it('accepted source missing: a valid original stays critical, nothing restored', () => {
      const backup = addPrivate(projectA, { operation: 'convert', artifactRole: 'staged-original',
        artifactPath: `.creatorcrate-convert-staging/${TOKEN}.0.original`, destinationPath: 'Final/a.png' });
      gate.markRecoveryRequired(projectA.id);
      accept();
      expect(evidence(backup).lifecycle).toBe('recovery-critical');
      expect(fs.existsSync(abs(projectA, 'Final/a.png'))).toBe(false);
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });

    it.each([
      ['watermark', WATERMARK_STAGE, 'Final/watermarked/a.png'],
      ['convert', CONVERT_STAGE, 'Final/a.webp'],
    ])('%s stage-output: matching destination → dispensable; differing/missing → protected', (operation, stagePath, destination) => {
      const options = { operation, artifactRole: 'stage-output', artifactPath: stagePath, bytes: Buffer.from('OUTPUT'),
        sourcePath: 'Final/a.png', destinationPath: destination };
      const stage = addPrivate(projectA, options);
      writeFile(projectA, destination, 'OUTPUT');
      accept();
      expect(evidence(stage)).toMatchObject({ lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.redundant });

      fs.rmSync(stage.target);
      fs.rmSync(abs(projectA, destination));
      const differing = addPrivate(projectA, options);
      writeFile(projectA, destination, 'OTHER OUTPUT');
      accept();
      expect(evidence(differing)).toMatchObject({ lifecycle: 'recovery-critical', retentionReason: 'restoration-failed' });

      fs.rmSync(abs(projectA, destination));
      accept();
      expect(evidence(differing).lifecycle).toBe('recovery-critical');
      expect(fs.existsSync(differing.target)).toBe(true);
    });

    it('a Prompt stage compares with the in-place source path (its persisted destination)', () => {
      const stage = addPrivate(projectA, { artifactRole: 'stage-output', artifactPath: PROMPT_STAGE,
        bytes: Buffer.from('EDITED'), sourcePath: 'Final/a.png', destinationPath: 'Final/a.png' });
      writeFile(projectA, 'Final/a.png', 'EDITED');
      accept();
      expect(evidence(stage).lifecycle).toBe('dispensable');
    });

    it('Archive: archive-stage and destination-backup compare with the persisted archive destination', () => {
      const stageGroup = addGroup(projectA, { operation: 'archive' });
      const stage = addPrivate(projectA, { group: stageGroup, operation: 'archive', artifactRole: 'archive-stage',
        artifactPath: ARCHIVE_STAGE, bytes: Buffer.from('NEW ARCHIVE'), sourcePath: 'Final/a.png',
        destinationPath: 'Set_jpg_q85.cbz' });
      const backup = addPrivate(projectA, { group: stageGroup, operation: 'archive', artifactRole: 'destination-backup',
        artifactPath: ARCHIVE_BACKUP, bytes: Buffer.from('OLD ARCHIVE'), sourcePath: 'Set_jpg_q85.cbz',
        destinationPath: 'Set_jpg_q85.cbz' });
      // A decoy at the stage's `sourcePath` holding the stage bytes must not be the target.
      writeFile(projectA, 'Final/a.png', 'OLD ARCHIVE');
      writeFile(projectA, 'Set_jpg_q85.cbz', 'NEW ARCHIVE');
      accept();
      expect(evidence(stage).lifecycle).toBe('dispensable');
      expect(evidence(backup)).toMatchObject({ lifecycle: 'recovery-critical', retentionReason: 'restoration-failed' });

      writeFile(projectA, 'Set_jpg_q85.cbz', 'OLD ARCHIVE');
      accept();
      expect(evidence(backup)).toMatchObject({ lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.redundant });
    });

    it('fails closed when the role’s persisted live-target field is null', () => {
      const backup = addPrivate(projectA, { sourcePath: null, destinationPath: 'Final/a.png' });
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      accept();
      expect(evidence(backup).lifecycle).toBe('recovery-critical');
    });

    it('a recorded size without a hash cannot prove redundancy', () => {
      const backup = addPrivate(projectA, { expectedSha256: null });
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      accept();
      expect(evidence(backup)).toMatchObject({ lifecycle: 'recovery-critical', observation: 'present' });
    });
  });

  describe('private artifact fresh proof', () => {
    it('artifact missing → dispensable manual-scan-artifact-missing, row kept, nothing deleted', () => {
      const backup = addPrivate(projectA, { write: false, identity: { dev: 1n, ino: 2n } });
      accept();
      expect(evidence(backup)).toMatchObject({
        lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.artifactMissing, observation: 'missing',
      });
      expect(group(backup)).toMatchObject({ checkpoint: null });
    });

    it('artifact replaced by a foreign identity → observation replaced, protected, never hashed or adopted', () => {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      fs.renameSync(backup.target, `${backup.target}.old`);
      fs.writeFileSync(backup.target, 'ORIGINAL BYTES A');
      const realOpen = fs.openSync.bind(fs);
      const opened = [];
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
        opened.push(path.resolve(String(filePath)));
        return realOpen(filePath, ...args);
      });
      gate.markRecoveryRequired(projectA.id);
      accept();
      expect(opened).not.toContain(backup.target);
      expect(evidence(backup)).toMatchObject({
        lifecycle: 'recovery-critical', observation: 'replaced', identity: backup.row.identity,
      });
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
      expect(fs.readFileSync(backup.target, 'utf8')).toBe('ORIGINAL BYTES A');
    });

    it('artifact changed under its own identity → changed, protected', () => {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      fs.writeFileSync(backup.target, 'ORIGINAL BYTES Z');
      accept();
      expect(evidence(backup)).toMatchObject({ lifecycle: 'recovery-critical', observation: 'changed' });
    });

    it('identity-null private intent with a present path → ownership-unknown, recovery-critical, not adopted', () => {
      const backup = addPrivate(projectA, { identity: null, lifecycle: 'intent', retentionReason: 'publication-pending' });
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      gate.markRecoveryRequired(projectA.id);
      accept();
      expect(evidence(backup)).toMatchObject({
        lifecycle: 'recovery-critical', observation: 'ownership-unknown', identity: null,
        retentionReason: 'publication-pending',
      });
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });

    it('intent rows: unique → recovery-critical; redundant → dispensable; absent → dispensable', () => {
      const unique = addPrivate(projectA, { lifecycle: 'intent', retentionReason: 'publication-pending' });
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      accept();
      expect(evidence(unique)).toMatchObject({ lifecycle: 'recovery-critical', retentionReason: 'publication-pending' });

      const redundant = addPrivate(projectA, { lifecycle: 'intent', artifactPath: PROMPT_STAGE,
        artifactRole: 'stage-output', bytes: Buffer.from('NEW BYTES B'), destinationPath: 'Final/a.png' });
      const absent = addPrivate(projectA, { lifecycle: 'intent', artifactPath: CONVERT_BACKUP, operation: 'convert',
        write: false, identity: null });
      accept();
      expect(evidence(redundant)).toMatchObject({ lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.redundant });
      expect(evidence(absent)).toMatchObject({ lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.artifactMissing });
    });

    it.each(['changed', 'replaced'])('already-dispensable %s residue stays dispensable', (change) => {
      const residue = addPrivate(projectA, { lifecycle: 'dispensable', retentionReason: 'cleanup-residue' });
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      if (change === 'changed') fs.writeFileSync(residue.target, 'ORIGINAL BYTES Z');
      else { fs.rmSync(residue.target); fs.writeFileSync(residue.target, 'foreign'); }
      accept();
      expect(evidence(residue)).toMatchObject({ lifecycle: 'dispensable', retentionReason: 'cleanup-residue', observation: change });
    });

    it('an unprovable project root retains every private copy without inspecting it', () => {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      const lifecycleIntent = addPrivate(projectA, { lifecycle: 'intent', artifactPath: CONVERT_BACKUP, operation: 'convert' });
      fs.rmSync(path.join(projectA.dir, '.creatorcrate-owner'), { force: true });
      db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(projectA.id);
      gate.markRecoveryRequired(projectA.id);
      accept();
      expect(evidence(backup)).toMatchObject({ lifecycle: 'recovery-critical', observation: 'unavailable' });
      expect(evidence(lifecycleIntent)).toMatchObject({ lifecycle: 'recovery-critical', observation: 'unavailable' });
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });
  });

  describe('public tracking and unknown evidence', () => {
    it.each([
      ['workflow-prompt', 'published-output', 'Final/a.png'],
      ['watermark', 'published-output', 'Final/watermarked/a.png'],
      ['archive', 'published-archive', 'Set_jpg_q85.cbz'],
      ['convert', 'published-output', 'Final/a.webp'],
      ['convert', 'originals-copy', 'Final/originals/a.png'],
    ])('%s/%s: tracking row retired as metadata only; the public file survives untouched', (operation, artifactRole, artifactPath) => {
      const entry = addPublic(projectA, { operation, artifactRole, artifactPath });
      const before = fs.lstatSync(entry.target, { bigint: true });
      gate.markRecoveryRequired(projectA.id);
      expect(accept()).toMatchObject({ publicTrackingRetired: 1 });
      expect(evidence(entry)).toBeNull();
      expect(group(entry)).toBeNull();
      const after = fs.lstatSync(entry.target, { bigint: true });
      expect(fs.readFileSync(entry.target, 'utf8')).toBe('PUBLISHED');
      expect([after.ino, after.mtimeNs, after.size]).toEqual([before.ino, before.mtimeNs, before.size]);
    });

    it('public tracking rows are never inspected or hashed', () => {
      addPublic(projectA, { operation: 'convert', artifactRole: 'originals-copy', artifactPath: 'Final/originals/a.png' });
      const calls = spyFs();
      accept();
      vi.restoreAllMocks();
      expect(calls).toEqual([]);
    });

    it('identity-null public row (created-but-unowned) is retired without adopting the present path', () => {
      const entry = addPublic(projectA, { identity: null });
      const identityWrites = vi.spyOn(repo, 'attachEvidenceIdentity');
      accept();
      expect(identityWrites).not.toHaveBeenCalled();
      expect(evidence(entry)).toBeNull();
      expect(fs.readFileSync(entry.target, 'utf8')).toBe('PUBLISHED');
    });

    it('unknown operation/role evidence is preserved exactly; its checkpoint still clears', () => {
      const unknownGroup = addGroup(projectA, { operation: 'convert', checkpoint: 'restore' });
      const unknown = addPrivate(projectA, { group: unknownGroup, operation: 'convert', artifactRole: 'future-role',
        artifactPath: 'Final/future.bin', lifecycle: 'intent', retentionReason: 'future-reason' });
      const before = evidence(unknown);
      gate.markRecoveryRequired(projectA.id);
      accept();
      expect(evidence(unknown)).toEqual(before);
      expect(repo.findMutationGroup(projectA.id, unknownGroup.groupId)).toMatchObject({ checkpoint: null });
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
      expect(fs.existsSync(unknown.target)).toBe(true);
    });
  });

  describe('hardened live-target proof', () => {
    function settleOnFirstRead(target) {
      const realOpen = fs.openSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let settled = false;
      let opens = 0;
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (flags === 'r' && path.resolve(String(filePath)) === target) { settled = true; opens += 1; }
        return realOpen(filePath, flags, ...args);
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        const stats = realLstat(filePath, ...args);
        if (!settled && args[0]?.bigint && path.resolve(String(filePath)) === target) {
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
            mtimeNs: stats.mtimeNs + 20_448_600n, ctimeNs: stats.ctimeNs + 20_448_600n,
          });
        }
        return stats;
      });
      return () => opens;
    }

    it('SMB T2 → T1 settling during the live target’s first read still proves redundancy', () => {
      const backup = addPrivate();
      const live = writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      const opens = settleOnFirstRead(live);
      accept();
      expect(opens()).toBe(2);
      expect(evidence(backup)).toMatchObject({ lifecycle: 'dispensable', retentionReason: MANUAL_SCAN_RETENTION.redundant });
    });

    it('SMB T2 → T1 settling on the private copy itself still proves redundancy', () => {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      const opens = settleOnFirstRead(backup.target);
      accept();
      expect(opens()).toBe(2);
      expect(evidence(backup).lifecycle).toBe('dispensable');
    });

    it('stale first target hash: an in-place rewrite after the first read keeps the copy protected', () => {
      const backup = addPrivate();
      const live = writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      const realOpen = fs.openSync.bind(fs);
      const realClose = fs.closeSync.bind(fs);
      const descriptors = new Set();
      let opens = 0;
      let rewritten = false;
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        const descriptor = realOpen(filePath, flags, ...args);
        if (flags === 'r' && path.resolve(String(filePath)) === live) { descriptors.add(descriptor); opens += 1; }
        return descriptor;
      });
      vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
        const result = realClose(descriptor, ...args);
        if (descriptors.delete(descriptor) && !rewritten) {
          rewritten = true;
          const writer = realOpen(live, 'r+');
          fs.writeSync(writer, Buffer.from('ORIGINAL BYTES Z'), 0, 16, 0);
          realClose(writer);
          const later = new Date(Date.now() + 60_000);
          fs.utimesSync(live, later, later);
        }
        return result;
      });
      gate.markRecoveryRequired(projectA.id);
      accept();
      expect(rewritten).toBe(true);
      expect(opens).toBe(2);
      expect(evidence(backup)).toMatchObject({ lifecycle: 'recovery-critical', retentionReason: 'restoration-failed' });
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });

    it('a private copy rewritten while the live target is read is not made redundant', () => {
      const backup = addPrivate();
      const live = writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      const realOpen = fs.openSync.bind(fs);
      let fired = false;
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (!fired && flags === 'r' && path.resolve(String(filePath)) === live) {
          fired = true;
          const writer = realOpen(backup.target, 'r+');
          fs.writeSync(writer, Buffer.from('Z'), 0, 1, 0);
          fs.closeSync(writer);
          const later = new Date(Date.now() + 60_000);
          fs.utimesSync(backup.target, later, later);
        }
        return realOpen(filePath, flags, ...args);
      });
      accept();
      expect(fired).toBe(true);
      expect(evidence(backup)).toMatchObject({ lifecycle: 'recovery-critical', observation: 'changed' });
    });

    it('a live target that is a directory or unreadable keeps the copy protected without failing acceptance', () => {
      const backup = addPrivate();
      fs.mkdirSync(abs(projectA, 'Final/a.png'), { recursive: true });
      gate.markRecoveryRequired(projectA.id);
      accept();
      expect(evidence(backup).lifecycle).toBe('recovery-critical');
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });

    it('a live target symlink is never followed', (context) => {
      const backup = addPrivate();
      const elsewhere = writeFile(projectA, 'Other/a.png', 'ORIGINAL BYTES A');
      fs.mkdirSync(abs(projectA, 'Final'), { recursive: true });
      try {
        fs.symlinkSync(elsewhere, abs(projectA, 'Final/a.png'), 'file');
      } catch {
        context.skip();
      }
      accept();
      expect(evidence(backup).lifecycle).toBe('recovery-critical');
    });
  });

  describe('atomic settlement failures', () => {
    function fail(sql) {
      db.exec(`CREATE TRIGGER wp8b_fail ${sql} BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
    }

    function prepareMixed() {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'ORIGINAL BYTES A');
      addPublic(projectA, { group: backup.group, artifactPath: 'Final/p.png' });
      addGroup(projectA, { operation: 'convert', checkpoint: 'replace' });
      gate.markRecoveryRequired(projectA.id);
      return backup;
    }

    it.each([
      ['evidence persistence', 'BEFORE UPDATE ON processing_recovery_evidence'],
      ['public row retirement', 'BEFORE DELETE ON processing_recovery_evidence'],
      ['checkpoint clear', 'BEFORE UPDATE OF checkpoint ON processing_recovery_mutation_groups'],
      ['group removal', 'BEFORE DELETE ON processing_recovery_mutation_groups'],
      ['gate clear', "BEFORE DELETE ON app_meta WHEN OLD.key LIKE 'processing.recovery_required.%'"],
    ])('%s failure rolls back the whole settlement; the gate stays set; a retry succeeds', (label, trigger) => {
      const backup = prepareMixed();
      const before = snapshot();
      fail(trigger);
      expect(() => accept()).toThrow(expect.objectContaining({ code: 'RECOVERY_RECONCILIATION_FAILED' }));
      expect(snapshot()).toEqual(before);
      expect(gate.isRecoveryRequired(projectA.id)).toBe(true);
      expect(fs.readFileSync(backup.target, 'utf8')).toBe('ORIGINAL BYTES A');
      db.exec('DROP TRIGGER wp8b_fail');
      expect(accept()).toMatchObject({ publicTrackingRetired: 1, privateMadeDispensable: 1, groupsResolved: 2 });
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
      expect(evidence(backup).lifecycle).toBe('dispensable');
    });
  });

  describe('HTTP: only POST /scan/manual accepts project state', () => {
    let app;
    let agent;
    let csrf;

    async function startApp() {
      app = createApp(
        { appName: 'CreatorCrate', db, projectsRoot },
        { appDataRoot: tmpDir, projectOperationCoordinator: coordinator, authState: { csrfPepper: 'a'.repeat(64) } },
      );
      agent = request.agent(app);
      const response = await agent.get(`/projects/${projectA.id}/assets/processing/recovery`).expect(200);
      const cookie = response.headers['set-cookie'].find((value) => value.startsWith('cc_csrf_anon='));
      csrf = deriveDisabledModeCsrfToken('a'.repeat(64), decodeURIComponent(cookie.split(';')[0].split('=')[1]));
    }

    const scan = (suffix, body = {}, project = projectA) => agent.post(`/projects/${project.id}/scan${suffix}`)
      .set('Accept', 'application/json').set('X-CSRF-Token', csrf).send(body);
    const details = (project = projectA) => agent.get(`/projects/${project.id}/assets/processing/recovery`).expect(200);

    function prepareUnique() {
      const backup = addPrivate();
      writeFile(projectA, 'Final/a.png', 'NEW BYTES B');
      const emptyGroup = addGroup(projectA, { operation: 'convert', checkpoint: 'replace' });
      const published = addPublic(projectA, { group: backup.group, artifactPath: 'Final/p.png' });
      const redundant = addPrivate(projectA, { operation: 'convert', artifactRole: 'stage-output',
        artifactPath: CONVERT_STAGE, bytes: Buffer.from('OUTPUT'), sourcePath: 'Final/a.png',
        destinationPath: 'Final/a.webp' });
      writeFile(projectA, 'Final/a.webp', 'OUTPUT');
      gate.markRecoveryRequired(projectA.id);
      return { backup, emptyGroup, published, redundant };
    }

    beforeEach(startApp);

    it('manual scan runs scanner then settlement inside one coordinator section and reports bounded counts', async () => {
      const { backup, emptyGroup, published, redundant } = prepareUnique();
      const runs = vi.spyOn(coordinator, 'run');
      const asyncRuns = vi.spyOn(coordinator, 'runAsync');
      const scanSpy = vi.spyOn(app.locals.assetScanner, 'scanProjectAssets');
      const response = await scan('/manual').expect(200);
      expect(scanSpy).toHaveBeenCalledExactlyOnceWith(projectA.id, { afterScan: expect.any(Function) });
      // One shared-coordinator section covers scan and settlement; no second lock is taken.
      expect(runs).toHaveBeenCalledExactlyOnceWith(projectA.id, expect.any(Function));
      expect(asyncRuns).not.toHaveBeenCalled();
      expect(response.body).toEqual({
        ok: true,
        scan: expect.objectContaining({ total: expect.any(Number) }),
        recovery: { publicTrackingRetired: 1, privateMadeDispensable: 1, privateRetained: 1, groupsResolved: 3 },
      });
      expect(response.text).not.toContain(projectA.dir);
      expect(repo.findMutationGroup(projectA.id, emptyGroup.groupId)).toBeNull();
      expect(evidence(published)).toBeNull();
      expect(evidence(backup).lifecycle).toBe('recovery-critical');
      expect(evidence(redundant).lifecycle).toBe('dispensable');
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);

      // Recovery Details (SQLite only) shows retained unique and dispensable residue, no empty group.
      const calls = spyFs();
      const view = await details();
      vi.restoreAllMocks();
      expect(calls.filter((call) => /stat|open|read(?!dir)|readdir/i.test(call.name)
        && typeof call.args[0] === 'string' && call.args[0].startsWith(projectsRoot))).toEqual([]);
      expect(view.body.recoveryRequired).toBe(false);
      expect(view.body.entries.map((entry) => [entry.kind, entry.artifactRole, entry.lifecycle, entry.checkpoint])).toEqual([
        ['evidence', 'original-backup', 'recovery-critical', null],
        ['evidence', 'stage-output', 'dispensable', null],
      ]);
    });

    it('the settlement runs only after the scan committed, under the scanner’s own lock', async () => {
      prepareUnique();
      writeFile(projectA, 'Final/scanned-first.png', 'x');
      const seen = [];
      const realScan = app.locals.assetScanner.scanProjectAssets;
      vi.spyOn(app.locals.assetScanner, 'scanProjectAssets').mockImplementation((id, options) => realScan(id, options && {
        afterScan: (result, acceptance) => {
          seen.push({
            active: coordinator.isActive(id),
            reentrant: (() => { try { coordinator.run(id, () => {}); return 'allowed'; } catch (err) { return err.code; } })(),
            committed: db.prepare('SELECT COUNT(*) FROM assets WHERE project_id = ? AND relative_path = ?').pluck()
              .get(id, 'Final/scanned-first.png'),
            inTransaction: db.inTransaction,
            gated: gate.isRecoveryRequired(id),
          });
          return options.afterScan(result, acceptance);
        },
      }));
      await scan('/manual').expect(200);
      expect(seen).toEqual([{
        active: true, reentrant: 'PROJECT_OPERATION_IN_PROGRESS', committed: 1, inTransaction: false, gated: true,
      }]);
      expect(coordinator.isActive(projectA.id)).toBe(false);
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });

    it('the route\'s acceptance settles exactly once and is dead after the scan callback returns', async () => {
      const { backup, redundant } = prepareUnique();
      const appService = app.locals.processingRecoveryEvidenceService;
      const settle = vi.spyOn(db, 'transaction');
      const realScan = app.locals.assetScanner.scanProjectAssets;
      const seen = [];
      let stale;
      vi.spyOn(app.locals.assetScanner, 'scanProjectAssets').mockImplementation((id, options) => realScan(id, options && {
        afterScan: (result, acceptance) => {
          stale = acceptance;
          seen.push(typeof acceptance === 'object' && acceptance !== null && Object.keys(acceptance).length === 0);
          const settlesBefore = settle.mock.calls.length;
          const value = options.afterScan(result, acceptance);
          seen.push(settle.mock.calls.length - settlesBefore);
          // A second consumption of the same acceptance inside the same callback is refused.
          try { appService.reconcileAfterManualScan(id, acceptance); seen.push('settled twice'); } catch (err) { seen.push(err.code); }
          return value;
        },
      }));
      await scan('/manual').expect(200);
      vi.restoreAllMocks();
      expect(seen).toEqual([true, 1, 'RECOVERY_RECONCILIATION_NOT_AUTHORIZED']);
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
      expect(evidence(backup).lifecycle).toBe('recovery-critical');
      expect(evidence(redundant).lifecycle).toBe('dispensable');

      // After the callback returned the acceptance is stale, even under a later project operation.
      gate.markRecoveryRequired(projectA.id);
      const unclaimed = addPrivate(projectA, { operation: 'convert', artifactRole: 'stage-output',
        artifactPath: CONVERT_STAGE.replace('.0.', '.1.'), bytes: Buffer.from('OUTPUT'), sourcePath: 'Final/a.png',
        destinationPath: 'Final/a.webp' });
      const before = snapshot();
      for (const call of [
        () => appService.reconcileAfterManualScan(projectA.id, stale),
        () => coordinator.run(projectA.id, () => appService.reconcileAfterManualScan(projectA.id, stale)),
        () => coordinator.run(projectB.id, () => appService.reconcileAfterManualScan(projectB.id, stale)),
      ]) {
        expect(call).toThrow(expect.objectContaining({ code: 'RECOVERY_RECONCILIATION_NOT_AUTHORIZED' }));
      }
      expect(snapshot()).toEqual(before);
      expect(evidence(unclaimed).lifecycle).toBe('recovery-critical');
      expect(gate.isRecoveryRequired(projectA.id)).toBe(true);
    });

    it('a manual scan cannot interleave with a queued cleanup or processing operation', async () => {
      prepareUnique();
      const before = snapshot();
      let release;
      const held = coordinator.runAsync(projectA.id, () => new Promise((resolve) => { release = resolve; }));
      const blocked = await scan('/manual');
      expect(blocked.status).toBe(500);
      expect(snapshot()).toEqual(before);
      release();
      await held;
      await scan('/manual').expect(200);
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });

    it('a failed manual scan performs no settlement', async () => {
      prepareUnique();
      const before = snapshot();
      fs.writeFileSync(path.join(projectA.dir, '.creatorcrate-owner'), `creatorcrate-owner/1 ${'c'.repeat(64)}\n`);
      const realScan = app.locals.assetScanner.scanProjectAssets;
      const received = [];
      vi.spyOn(app.locals.assetScanner, 'scanProjectAssets').mockImplementation((id, options) => realScan(id, {
        afterScan: (...args) => { received.push(args); return options.afterScan(...args); },
      }));
      const response = await scan('/manual');
      expect(response.status).toBe(409);
      expect(received).toEqual([]);
      expect(snapshot()).toEqual(before);
    });

    it.each([
      ['processing-refresh', { trigger: 'processing-refresh' }],
      ['unmarked', {}],
      ['body claiming manual', { trigger: 'manual' }],
    ])('automatic /scan (%s) leaves evidence, tracking rows, checkpoints and gate unchanged', async (label, body) => {
      prepareUnique();
      const before = snapshot();
      const scanSpy = vi.spyOn(app.locals.assetScanner, 'scanProjectAssets');
      const response = await scan('', body).expect(200);
      expect(scanSpy).toHaveBeenCalledExactlyOnceWith(projectA.id);
      expect(response.body).not.toHaveProperty('recovery');
      expect(snapshot()).toEqual(before);
    });

    it('a form /scan also never reconciles', async () => {
      prepareUnique();
      const before = snapshot();
      const scanSpy = vi.spyOn(app.locals.assetScanner, 'scanProjectAssets');
      await agent.post(`/projects/${projectA.id}/scan`).type('form').send({ _csrf: csrf }).expect(302);
      expect(scanSpy).toHaveBeenCalledExactlyOnceWith(projectA.id);
      expect(snapshot()).toEqual(before);
    });

    it('scheduled automatic scans never reconcile', async () => {
      prepareUnique();
      const before = snapshot();
      const scheduler = createAutomaticProjectScanScheduler({
        intervalMinutes: 5,
        getScanDependencies: () => ({
          projectService: app.locals.projectService,
          assetScanner: app.locals.assetScanner,
          appMetaRepository: createAppMetaRepository(db),
        }),
        logger: { log() {}, error() {} },
      });
      const scanSpy = vi.spyOn(app.locals.assetScanner, 'scanProjectAssets');
      expect(await scheduler.runCycle()).toMatchObject({ failed: 0 });
      expect(scanSpy).toHaveBeenCalled();
      expect(scanSpy.mock.calls.every(([, options]) => options?.afterScan === undefined)).toBe(true);
      expect(snapshot()).toEqual(before);
    });

    it('form manual scan keeps its redirect contract and settles', async () => {
      prepareUnique();
      const response = await agent.post(`/projects/${projectA.id}/scan/manual`).type('form').send({ _csrf: csrf }).expect(302);
      expect(new URL(response.headers.location, 'http://localhost').searchParams.get('scan_result')).toBe('ok');
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
    });

    it('settlement failure reports a scan failure, keeps the committed scan, and a retry succeeds', async () => {
      const { backup } = prepareUnique();
      writeFile(projectA, 'Final/new-after-failure.png', 'x');
      const before = snapshot();
      db.exec("CREATE TRIGGER wp8b_fail BEFORE DELETE ON app_meta WHEN OLD.key LIKE 'processing.recovery_required.%' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
      const failed = await scan('/manual').expect(500);
      expect(failed.body).toMatchObject({ ok: false, error: { code: 'SCAN_FAILED' } });
      expect(snapshot()).toEqual(before);
      // The scanner's own committed reconciliation is not undone.
      expect(db.prepare('SELECT COUNT(*) FROM assets WHERE project_id = ? AND relative_path = ?').pluck()
        .get(projectA.id, 'Final/new-after-failure.png')).toBe(1);
      const form = await agent.post(`/projects/${projectA.id}/scan/manual`).type('form').send({ _csrf: csrf }).expect(302);
      expect(new URL(form.headers.location, 'http://localhost').searchParams.get('scan_error')).toBe('filesystem');
      db.exec('DROP TRIGGER wp8b_fail');
      await scan('/manual').expect(200);
      expect(gate.isRecoveryRequired(projectA.id)).toBe(false);
      expect(evidence(backup).lifecycle).toBe('recovery-critical');
    });

    it('archived projects keep the existing manual-scan rejection, with no settlement', async () => {
      prepareUnique();
      db.prepare("UPDATE projects SET archived_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(projectA.id);
      const before = snapshot();
      const response = await scan('/manual').expect(409);
      expect(response.body.error.code).toBe('PROJECT_ARCHIVED');
      expect(snapshot()).toEqual(before);
    });
  });
});
