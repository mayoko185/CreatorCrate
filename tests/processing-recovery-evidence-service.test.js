import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createProcessingRecoveryEvidenceRepository } from '../src/data/processing-recovery-evidence-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../src/data/project-directory-ownership-repository.js';
import {
  classifyEvidenceArtifact,
  createProcessingRecoveryEvidenceService,
  EVIDENCE_POLICY_CATALOG,
  isCleanupPolicyEligible,
} from '../src/services/processing-recovery-evidence-service.js';
import { bindTestProjectOwnership, snapshotTree } from './helpers/project-ownership.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const TOKEN = '0123456789abcdef';
const RUN = 'run-wp7a';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Accepted WP3–WP6 contracts. Private sample paths are exactly what stagingFile() produces
// (`<staging root>/<16-hex token>.<name>`); Archive shares the Watermark workspace.
const PRIVATE_SAMPLES = [
  ['workflow-prompt', 'stage-output', `.creatorcrate-workflow-prompts-staging/${TOKEN}.0.png`],
  ['workflow-prompt', 'original-backup', `.creatorcrate-workflow-prompts-staging/${TOKEN}.3.original`],
  ['watermark', 'stage-output', `.creatorcrate-watermark-staging/${TOKEN}.0.output`],
  ['watermark', 'destination-backup', `.creatorcrate-watermark-staging/${TOKEN}.1.destination`],
  ['watermark', 'staged-original', `.creatorcrate-watermark-staging/${TOKEN}.12.original`],
  ['archive', 'archive-stage', `.creatorcrate-watermark-staging/${TOKEN}.archive-0.cbz`],
  ['archive', 'destination-backup', `.creatorcrate-watermark-staging/${TOKEN}.archive-2.destination`],
  ['convert', 'stage-output', `.creatorcrate-convert-staging/${TOKEN}.0.output`],
  ['convert', 'original-backup', `.creatorcrate-convert-staging/${TOKEN}.4.source`],
  ['convert', 'staged-original', `.creatorcrate-convert-staging/${TOKEN}.4.original`],
];
const PUBLIC_SAMPLES = [
  ['workflow-prompt', 'published-output', 'Final/prompt.png'],
  ['watermark', 'published-output', 'Final/watermarked/a.png'],
  ['archive', 'published-archive', 'Set_jpg_q85.cbz'],
  ['convert', 'published-output', 'Final/a.webp'],
  ['convert', 'originals-copy', 'Final/originals/a.png'],
];

// Every function on node:fs and fs.promises, counted while `fn` runs.
function countFsCalls(fn) {
  const calls = [];
  const spies = [];
  for (const [target, prefix] of [[fs, 'fs'], [fs.promises, 'fs.promises']]) {
    for (const name of Object.keys(target)) {
      if (typeof target[name] !== 'function' || /^[A-Z]/.test(name)) continue;
      const original = target[name];
      try {
        spies.push(vi.spyOn(target, name).mockImplementation(function spied(...args) {
          calls.push({ name: `${prefix}.${name}`, arg: typeof args[0] === 'string' ? args[0] : args[0] });
          return original.apply(this, args);
        }));
      } catch {
        // Non-configurable members cannot be spied; none of them reads a file.
      }
    }
  }
  let pending = false;
  try {
    const result = fn();
    if (typeof result?.finally === 'function') {
      pending = true;
      return { result: result.finally(() => { for (const spy of spies) spy.mockRestore(); }), calls };
    }
    return { result, calls };
  } finally {
    if (!pending) for (const spy of spies) spy.mockRestore();
  }
}

describe('processing recovery evidence service (WP7A)', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let repo;
  let service;
  let projectA;
  let projectB;
  let coordinator;

  function insertProject(slug) {
    const id = Number(db.prepare(`
      INSERT INTO projects (title, slug, status, project_type) VALUES (?, ?, 'tbd', 'images')
    `).run(slug, slug).lastInsertRowid);
    const relDir = `${String(id).padStart(6, '0')}-${slug}`;
    db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run(relDir, id);
    const dir = path.join(projectsRoot, relDir);
    fs.mkdirSync(dir, { recursive: true });
    bindTestProjectOwnership(db, id, dir);
    return { id, dir };
  }

  function makeService(overrides = {}) {
    return createProcessingRecoveryEvidenceService({
      db,
      projectRepository: createProjectRepository(db),
      projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
      projectsRoot,
      repository: repo,
      projectOperationCoordinator: coordinator,
      ...overrides,
    });
  }

  function abs(project, relative) {
    return path.join(project.dir, ...relative.split('/'));
  }

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

  // One group + one evidence row. By default: a dispensable Convert stage whose recorded
  // identity and content proof are those of a real file written at its path.
  function addEvidence(project, {
    operation = 'convert', artifactRole = 'stage-output',
    artifactPath = `.creatorcrate-convert-staging/${TOKEN}.0.output`, bytes = Buffer.from('stage bytes'),
    write = true, identity, expectedSize, expectedSha256, lifecycle = 'dispensable', checkpoint,
    retentionReason = 'residue', groupId,
  } = {}) {
    const target = write ? writeFile(project, artifactPath, bytes) : abs(project, artifactPath);
    const group = groupId
      ? repo.findMutationGroup(project.id, groupId)
      : repo.createMutationGroup({ projectId: project.id, operation, runId: RUN, itemKey: 'item-0' });
    if (checkpoint) repo.markMutationCheckpoint(project.id, group.groupId, checkpoint);
    const row = repo.createEvidence({
      projectId: project.id,
      mutationGroupId: group.groupId,
      artifactRole,
      retentionReason,
      artifactPath,
      sourcePath: 'Final/source.png',
      destinationPath: 'Final/source.webp',
      identity: identity === undefined ? (write ? identityOf(target) : null) : identity,
      expectedSize: expectedSize === undefined ? bytes.length : expectedSize,
      expectedSha256: expectedSha256 === undefined ? sha256(bytes) : expectedSha256,
      lifecycle,
    });
    return { row, group: repo.findMutationGroup(project.id, group.groupId), target };
  }

  const refreshOne = (project, evidenceId) => service.refreshEvidence(project.id, [evidenceId])[0];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-evidence-service-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot);
    db = openDatabase(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);
    repo = createProcessingRecoveryEvidenceRepository(db);
    projectA = insertProject('project-a');
    projectB = insertProject('project-b');
    coordinator = createProjectOperationCoordinator();
    service = makeService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('policy catalog', () => {
    it('classifies every accepted WP3–WP6 operation/role from operation+role', () => {
      const classified = Object.fromEntries(Object.entries(EVIDENCE_POLICY_CATALOG).map(([operation, roles]) => [
        operation, Object.fromEntries(Object.keys(roles).map((role) => [role, classifyEvidenceArtifact(operation, role)])),
      ]));
      expect(classified).toEqual({
        'workflow-prompt': {
          'stage-output': 'private', 'original-backup': 'private', 'published-output': 'public-tracking',
        },
        watermark: {
          'stage-output': 'private', 'destination-backup': 'private', 'staged-original': 'private',
          'published-output': 'public-tracking',
        },
        archive: { 'archive-stage': 'private', 'destination-backup': 'private', 'published-archive': 'public-tracking' },
        convert: {
          'stage-output': 'private', 'original-backup': 'private', 'staged-original': 'private',
          'published-output': 'public-tracking', 'originals-copy': 'public-tracking',
        },
      });
    });

    it('fails closed for unknown operation/role combinations', () => {
      for (const [operation, role] of [
        ['archive', 'stage-output'], ['workflow-prompt', 'staged-original'], ['watermark', 'originals-copy'],
        ['convert', 'archive-stage'], ['unknown-op', 'stage-output'], ['convert', 'constructor'], ['__proto__', 'x'],
      ]) {
        expect(classifyEvidenceArtifact(operation, role)).toBe('unknown');
        expect(isCleanupPolicyEligible({
          operation, artifactRole: role, artifactPath: `.creatorcrate-convert-staging/${TOKEN}.0.output`,
          lifecycle: 'dispensable', identity: { dev: '1', ino: '2', birthtimeNs: null },
          expectedSize: 1, expectedSha256: 'a'.repeat(64),
        })).toBe(false);
      }
    });

    it.each(PRIVATE_SAMPLES)('lists %s / %s in its namespace as eligible only when dispensable with identity and proof', (operation, artifactRole, artifactPath) => {
      const { row } = addEvidence(projectA, { operation, artifactRole, artifactPath });
      const listed = service.listProjectEvidence(projectA.id).find((entry) => entry.evidenceId === row.evidenceId);
      expect(listed).toMatchObject({ artifactClass: 'private', cleanupPolicyEligible: true });
    });

    it.each(['zip', '7z', 'cbz'])('accepts the supported Archive stage format .%s', (extension) => {
      const { row } = addEvidence(projectA, {
        operation: 'archive', artifactRole: 'archive-stage',
        artifactPath: `.creatorcrate-watermark-staging/${TOKEN}.archive-12.${extension}`,
      });
      expect(service.listProjectEvidence(projectA.id)[0]).toMatchObject({ cleanupPolicyEligible: true });
      expect(refreshOne(projectA, row.evidenceId)).toMatchObject({ observation: 'present', cleanupPolicyEligible: true });
    });

    it.each(['txt', 'png', 'destination', 'foo'])('rejects the unsupported Archive stage lookalike .%s while listing and refreshing it', (extension) => {
      const { row } = addEvidence(projectA, {
        operation: 'archive', artifactRole: 'archive-stage',
        artifactPath: `.creatorcrate-watermark-staging/${TOKEN}.archive-0.${extension}`,
      });
      expect(service.listProjectEvidence(projectA.id)[0]).toMatchObject({ artifactClass: 'private', cleanupPolicyEligible: false });
      expect(refreshOne(projectA, row.evidenceId)).toMatchObject({ observation: 'present', cleanupPolicyEligible: false });
    });

    it('accepts the Archive .destination name only for destination-backup', () => {
      const evidence = {
        operation: 'archive', artifactRole: 'destination-backup',
        artifactPath: `.creatorcrate-watermark-staging/${TOKEN}.archive-0.destination`,
      };
      const { row } = addEvidence(projectA, evidence);
      expect(service.listProjectEvidence(projectA.id)[0].cleanupPolicyEligible).toBe(true);
      expect(isCleanupPolicyEligible({ ...row, artifactRole: 'archive-stage' })).toBe(false);
    });

    it.each(PUBLIC_SAMPLES)('never makes public %s / %s cleanup eligible', (operation, artifactRole, artifactPath) => {
      const { row } = addEvidence(projectA, { operation, artifactRole, artifactPath });
      const listed = service.listProjectEvidence(projectA.id).find((entry) => entry.evidenceId === row.evidenceId);
      expect(listed).toMatchObject({ artifactClass: 'public-tracking', cleanupPolicyEligible: false });
    });

    it('never makes convert/originals-copy eligible, even at a private-looking path', () => {
      const { row } = addEvidence(projectA, {
        artifactRole: 'originals-copy', artifactPath: `.creatorcrate-convert-staging/${TOKEN}.0.original`,
      });
      expect(service.listProjectEvidence(projectA.id).find((entry) => entry.evidenceId === row.evidenceId))
        .toMatchObject({ artifactClass: 'public-tracking', cleanupPolicyEligible: false });
    });

    it.each(['recovery-critical', 'intent'])('never makes %s private evidence eligible', (lifecycle) => {
      addEvidence(projectA, { lifecycle });
      expect(service.listProjectEvidence(projectA.id)[0]).toMatchObject({
        artifactClass: 'private', lifecycle, cleanupPolicyEligible: false,
      });
    });

    it.each([
      ['a live asset location', 'Final/a.webp'],
      ['another operation namespace', `.creatorcrate-watermark-staging/${TOKEN}.0.output`],
      ['a nested staging path', `.creatorcrate-convert-staging/sub/${TOKEN}.0.output`],
      ['a role name of another role', `.creatorcrate-convert-staging/${TOKEN}.0.source`],
      ['a non-token name', '.creatorcrate-convert-staging/evidence.0.output'],
    ])('never makes a private role at %s eligible', (_label, artifactPath) => {
      addEvidence(projectA, { artifactPath });
      expect(service.listProjectEvidence(projectA.id)[0]).toMatchObject({
        artifactClass: 'private', cleanupPolicyEligible: false,
      });
    });

    it('archive private roles must live in the Watermark workspace, not the Convert one', () => {
      addEvidence(projectA, {
        operation: 'archive', artifactRole: 'archive-stage', artifactPath: `.creatorcrate-convert-staging/${TOKEN}.archive-0.zip`,
      });
      expect(service.listProjectEvidence(projectA.id)[0].cleanupPolicyEligible).toBe(false);
    });

    it.each([
      ['identity-null', { identity: null }],
      ['no expected SHA-256', { expectedSha256: null }],
      ['no expected size', { expectedSize: null }],
    ])('never makes %s evidence eligible', (_label, overrides) => {
      addEvidence(projectA, overrides);
      expect(service.listProjectEvidence(projectA.id)[0].cleanupPolicyEligible).toBe(false);
    });
  });

  describe('DB-only listing', () => {
    it('returns unresolved evidence with mutation-group context and no absolute path', () => {
      const { row, group } = addEvidence(projectA, { checkpoint: 'replace' });
      const listed = service.listProjectEvidence(projectA.id);
      expect(listed).toEqual([{
        evidenceId: row.evidenceId,
        projectId: projectA.id,
        assetId: null,
        operation: 'convert',
        runId: RUN,
        mutationGroupId: group.groupId,
        itemKey: 'item-0',
        checkpoint: 'replace',
        checkpointAt: group.checkpointAt,
        artifactRole: 'stage-output',
        lifecycle: 'dispensable',
        observation: 'unchecked',
        observedAt: null,
        retentionReason: 'residue',
        artifactPath: `.creatorcrate-convert-staging/${TOKEN}.0.output`,
        sourcePath: 'Final/source.png',
        destinationPath: 'Final/source.webp',
        identityRecorded: true,
        contentProofRecorded: true,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        artifactClass: 'private',
        cleanupPolicyEligible: true,
      }]);
      expect(group.checkpointAt).toEqual(expect.any(String));
      expect(JSON.stringify(listed)).not.toContain(tmpDir);
      expect(JSON.stringify(listed)).not.toContain(projectA.dir);
    });

    it('performs zero filesystem calls of any kind (stat, open, read, hash, readdir)', () => {
      addEvidence(projectA);
      addEvidence(projectA, { operation: 'watermark', artifactRole: 'published-output', artifactPath: 'Final/w.png' });
      addEvidence(projectA, { identity: null, write: false });
      const { result, calls } = countFsCalls(() => service.listProjectEvidence(projectA.id));
      expect(result).toHaveLength(3);
      expect(calls).toEqual([]);
      // The listing reports what was last stored, even for a file that is gone now.
      fs.rmSync(abs(projectA, `.creatorcrate-convert-staging/${TOKEN}.0.output`));
      expect(service.listProjectEvidence(projectA.id).every((entry) => entry.observation === 'unchecked')).toBe(true);
    });

    it('never exposes another project’s evidence', () => {
      addEvidence(projectA);
      const foreign = addEvidence(projectB, { artifactPath: `.creatorcrate-convert-staging/${TOKEN}.9.output` });
      const listed = service.listProjectEvidence(projectA.id);
      expect(listed).toHaveLength(1);
      expect(listed.every((entry) => entry.projectId === projectA.id)).toBe(true);
      expect(JSON.stringify(listed)).not.toContain(foreign.row.evidenceId);
      expect(JSON.stringify(listed)).not.toContain(foreign.group.groupId);
    });
  });

  describe('targeted refresh: project isolation', () => {
    it('rejects another project’s evidence ID exactly like an unknown ID, with no filesystem access or mutation', () => {
      const own = addEvidence(projectA);
      const foreign = addEvidence(projectB);
      const before = repo.findEvidence(projectB.id, foreign.row.evidenceId);

      const foreignAttempt = countFsCalls(() => {
        try { service.refreshEvidence(projectA.id, [own.row.evidenceId, foreign.row.evidenceId]); } catch (err) { return err; }
        return null;
      });
      const unknownAttempt = countFsCalls(() => {
        try { service.refreshEvidence(projectA.id, [own.row.evidenceId, 'no-such-evidence']); } catch (err) { return err; }
        return null;
      });
      for (const attempt of [foreignAttempt, unknownAttempt]) {
        expect(attempt.result).toMatchObject({ code: 'RECOVERY_EVIDENCE_NOT_FOUND' });
        expect(attempt.calls).toEqual([]);
      }
      expect(foreignAttempt.result.message).toBe(unknownAttempt.result.message);
      expect(foreignAttempt.result.message).not.toContain(foreign.row.evidenceId);
      expect(repo.findEvidence(projectB.id, foreign.row.evidenceId)).toEqual(before);
      // The request is rejected as a whole: the caller's own row is not refreshed either.
      expect(repo.findEvidence(projectA.id, own.row.evidenceId).observation).toBe('unchecked');
    });

    it('inspects only the explicitly requested registered paths, never a directory listing', () => {
      const first = addEvidence(projectA);
      const second = addEvidence(projectA, { artifactPath: `.creatorcrate-convert-staging/${TOKEN}.1.output` });
      writeFile(projectA, `.creatorcrate-convert-staging/${TOKEN}.7.output`, Buffer.from('unregistered'));
      const { calls } = countFsCalls(() => service.refreshEvidence(projectA.id, [first.row.evidenceId]));
      expect(calls.filter((call) => /readdir|opendir|glob/i.test(call.name))).toEqual([]);
      const touched = calls.map((call) => call.arg).filter((arg) => typeof arg === 'string');
      expect(touched).not.toContain(second.target);
      expect(touched.some((arg) => arg.includes(`${TOKEN}.7.output`))).toBe(false);
      expect(touched.some((arg) => /\.json$/i.test(arg))).toBe(false);
      expect(repo.findEvidence(projectA.id, second.row.evidenceId).observation).toBe('unchecked');
    });
  });

  describe('targeted refresh: observations', () => {
    it('exact identity + matching content → present', () => {
      const { row } = addEvidence(projectA);
      expect(refreshOne(projectA, row.evidenceId)).toMatchObject({ observation: 'present', observedAt: expect.any(String) });
    });

    it('path absent → missing', () => {
      const { row, target } = addEvidence(projectA);
      fs.rmSync(target);
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('missing');
    });

    it('identity-null evidence whose path exists → ownership-unknown; absent → missing', () => {
      const unclaimed = addEvidence(projectA, { identity: null, lifecycle: 'intent' });
      const absent = addEvidence(projectA, {
        identity: null, lifecycle: 'intent', write: false, artifactPath: `.creatorcrate-convert-staging/${TOKEN}.1.output`,
      });
      const [first, second] = service.refreshEvidence(projectA.id, [unclaimed.row.evidenceId, absent.row.evidenceId]);
      expect(first.observation).toBe('ownership-unknown');
      expect(second.observation).toBe('missing');
    });

    it('inaccessible path → unavailable', () => {
      const { row, target } = addEvidence(projectA);
      const realLstat = fs.lstatSync.bind(fs);
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (path.resolve(String(filePath)) === target) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return realLstat(filePath, ...args);
      });
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('unavailable');
    });

    it('an unprovable project root → unavailable for every row, never missing, with no artifact inspection', () => {
      const first = addEvidence(projectA);
      const second = addEvidence(projectA, { artifactPath: `.creatorcrate-convert-staging/${TOKEN}.1.output` });
      fs.renameSync(projectA.dir, `${projectA.dir}.offline`);
      const { result, calls } = countFsCalls(() => service.refreshEvidence(
        projectA.id, [first.row.evidenceId, second.row.evidenceId],
      ));
      expect(result.map((entry) => entry.observation)).toEqual(['unavailable', 'unavailable']);
      expect(calls.some((call) => typeof call.arg === 'string' && call.arg.includes('.creatorcrate-convert-staging'))).toBe(false);
    });

    it('a different exact identity → replaced (the recorded identity is never overwritten)', () => {
      const { row, target } = addEvidence(projectA);
      fs.rmSync(target);
      fs.writeFileSync(target, Buffer.from('stage bytes')); // same bytes, new object
      expect(identityOf(target).ino).not.toBe(BigInt(row.identity.ino));
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('replaced');
      expect(repo.findEvidence(projectA.id, row.evidenceId).identity).toEqual(row.identity);
    });

    it('a recorded birth time is part of the exact identity', () => {
      const bytes = Buffer.from('born');
      const target = writeFile(projectA, `.creatorcrate-convert-staging/${TOKEN}.0.output`, bytes);
      const stats = fs.lstatSync(target, { bigint: true });
      const { row } = addEvidence(projectA, {
        write: false, bytes, identity: { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs + 1n },
      });
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('replaced');
    });

    it('exact identity + wrong content (same size) → changed', () => {
      const { row, target } = addEvidence(projectA);
      const descriptor = fs.openSync(target, 'r+');
      fs.writeSync(descriptor, Buffer.from('STAGE BYTES'), 0, 11, 0);
      fs.closeSync(descriptor);
      expect(identityOf(target).ino).toBe(BigInt(row.identity.ino));
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('changed');
    });

    it('exact identity + wrong size → changed', () => {
      const { row, target } = addEvidence(projectA);
      fs.appendFileSync(target, 'more');
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('changed');
    });

    it('exact identity with no recorded hash → present (size still checked when recorded)', () => {
      const plain = addEvidence(projectA, { expectedSha256: null, expectedSize: null });
      const sized = addEvidence(projectA, {
        expectedSha256: null, artifactPath: `.creatorcrate-convert-staging/${TOKEN}.1.output`,
      });
      fs.appendFileSync(sized.target, 'x');
      const [first, second] = service.refreshEvidence(projectA.id, [plain.row.evidenceId, sized.row.evidenceId]);
      expect(first.observation).toBe('present');
      expect(second.observation).toBe('changed');
    });

    it('a restored/recreated PUBLIC file with a different identity → replaced, not changed', () => {
      const { row, target } = addEvidence(projectA, {
        operation: 'convert', artifactRole: 'published-output', artifactPath: 'Final/a.webp', bytes: Buffer.from('published'),
      });
      fs.rmSync(target);
      fs.writeFileSync(target, Buffer.from('restored-different-bytes'));
      const refreshed = refreshOne(projectA, row.evidenceId);
      expect(refreshed).toMatchObject({ observation: 'replaced', artifactClass: 'public-tracking', cleanupPolicyEligible: false });
      expect(repo.findEvidence(projectA.id, row.evidenceId).identity).toEqual(row.identity);
    });

    it('unknown operation/role evidence is refreshed but stays ineligible', () => {
      const { row } = addEvidence(projectA, { operation: 'archive', artifactRole: 'legacy-thing' });
      expect(refreshOne(projectA, row.evidenceId)).toMatchObject({
        observation: 'present', artifactClass: 'unknown', cleanupPolicyEligible: false,
      });
      expect(repo.findEvidence(projectA.id, row.evidenceId)).not.toBeNull();
    });
  });

  describe('targeted refresh: exact bigint identity', () => {
    // Models the share's exact identity for one real file: every bigint lstat of it reports
    // `dev`/`ino`; bytes, size and times are real, Number stats are untouched.
    function modelExactIdentity(target, { dev, ino }) {
      const realIno = fs.lstatSync(target, { bigint: true }).ino;
      const realLstat = fs.lstatSync.bind(fs);
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        const stats = realLstat(filePath, ...args);
        if (typeof stats?.ino !== 'bigint' || stats.ino !== realIno) return stats;
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev, ino });
      });
    }

    it.each([
      ['dev = 0', 0n, 4242n],
      ['ino beyond 2^53', 7n, 9007199254740993n],
      ['uint64 maxima', 18446744073709551615n, 18446744073709551614n],
    ])('%s: matching exact identity → present, an off-by-one ino → replaced', (_label, dev, ino) => {
      const bytes = Buffer.from('exact');
      const target = writeFile(projectA, `.creatorcrate-convert-staging/${TOKEN}.0.output`, bytes);
      modelExactIdentity(target, { dev, ino });
      const exact = addEvidence(projectA, { write: false, bytes, identity: { dev, ino } });
      const nearby = addEvidence(projectA, { write: false, bytes, identity: { dev, ino: ino - 1n } });
      expect(exact.row.identity).toEqual({ dev: String(dev), ino: String(ino), birthtimeNs: null });
      const [same, other] = service.refreshEvidence(projectA.id, [exact.row.evidenceId, nearby.row.evidenceId]);
      expect(same.observation).toBe('present');
      expect(other.observation).toBe('replaced');
      expect(repo.findEvidence(projectA.id, exact.row.evidenceId).identity)
        .toEqual({ dev: String(dev), ino: String(ino), birthtimeNs: null });
    });
  });

  describe('targeted refresh: non-regular objects', () => {
    function readsUnder(calls, dir) {
      return calls.filter((call) => /open|readFile|read$/i.test(call.name)
        && typeof call.arg === 'string' && path.resolve(call.arg).startsWith(dir));
    }

    it('a directory at the registered path → replaced', () => {
      const { row, target } = addEvidence(projectA);
      fs.rmSync(target);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'inner'), 'x');
      const { result, calls } = countFsCalls(() => refreshOne(projectA, row.evidenceId));
      expect(result.observation).toBe('replaced');
      expect(calls.filter((call) => /readdir|opendir/i.test(call.name))).toEqual([]);
      expect(readsUnder(calls, target)).toEqual([]);
    });

    it('a junction/reparse substitute at the registered path → replaced, never followed', () => {
      const { row, target } = addEvidence(projectA);
      const outside = path.join(tmpDir, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret'), 'stage bytes');
      fs.rmSync(target);
      fs.symlinkSync(outside, target, 'junction');
      const { result, calls } = countFsCalls(() => refreshOne(projectA, row.evidenceId));
      expect(result.observation).toBe('replaced');
      expect(readsUnder(calls, outside)).toEqual([]);
    });

    it('a file symlink at the registered path → replaced, never hashed', (context) => {
      const { row, target } = addEvidence(projectA);
      const outside = path.join(tmpDir, 'outside-file');
      fs.writeFileSync(outside, 'stage bytes');
      fs.rmSync(target);
      try {
        fs.symlinkSync(outside, target, 'file');
      } catch (err) {
        if (err.code === 'EPERM') return context.skip();
        throw err;
      }
      const { result, calls } = countFsCalls(() => refreshOne(projectA, row.evidenceId));
      expect(result.observation).toBe('replaced');
      expect(readsUnder(calls, outside)).toEqual([]);
    });

    it('a staging root replaced by a junction → unavailable (cannot inspect safely), never followed', () => {
      const { row } = addEvidence(projectA);
      const stagingRoot = abs(projectA, '.creatorcrate-convert-staging');
      const outside = path.join(tmpDir, 'outside-root');
      fs.renameSync(stagingRoot, outside);
      fs.symlinkSync(outside, stagingRoot, 'junction');
      const { result, calls } = countFsCalls(() => refreshOne(projectA, row.evidenceId));
      expect(result.observation).toBe('unavailable');
      expect(readsUnder(calls, outside)).toEqual([]);
      expect(readsUnder(calls, stagingRoot)).toEqual([]);
    });
  });

  describe('targeted refresh: hardened content validation', () => {
    it('missing-before-hash: reinspects absence after the initially owned file disappears before open', () => {
      const { row, target } = addEvidence(projectA);
      const realOpen = fs.openSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let disappeared = false;
      const reinspections = [];
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (flags === 'r' && path.resolve(String(filePath)) === target) {
          fs.rmSync(target);
          disappeared = true;
        }
        return realOpen(filePath, flags, ...args);
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (disappeared && path.resolve(String(filePath)) === target) {
          reinspections.push({ bigint: args[0]?.bigint, inTransaction: db.inTransaction });
        }
        return realLstat(filePath, ...args);
      });

      expect(refreshOne(projectA, row.evidenceId).observation).toBe('missing');
      expect(disappeared).toBe(true);
      expect(reinspections).toEqual([{ bigint: true, inTransaction: false }]);
      expect(repo.findEvidence(projectA.id, row.evidenceId)).toMatchObject({
        observation: 'missing', identity: row.identity, expectedSize: row.expectedSize, expectedSha256: row.expectedSha256,
      });
    });

    it('foreign-replacement-before-hash: reports replaced without reading or adopting the foreign object', () => {
      const { row, target } = addEvidence(projectA);
      const realOpen = fs.openSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let replaced = false;
      const reinspections = [];
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (flags === 'r' && path.resolve(String(filePath)) === target) {
          // Keep A alive at another path so B cannot reuse its inode.
          fs.renameSync(target, `${target}.original`);
          fs.writeFileSync(target, 'foreign object');
          replaced = true;
        }
        return realOpen(filePath, flags, ...args);
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (replaced && path.resolve(String(filePath)) === target) {
          reinspections.push({ bigint: args[0]?.bigint, inTransaction: db.inTransaction });
        }
        return realLstat(filePath, ...args);
      });
      const read = vi.spyOn(fs, 'readFileSync');
      const enumerate = ['readdirSync', 'opendirSync'].map((name) => vi.spyOn(fs, name));

      expect(refreshOne(projectA, row.evidenceId).observation).toBe('replaced');
      expect(replaced).toBe(true);
      expect(reinspections).toEqual([{ bigint: true, inTransaction: false }]);
      expect(read).not.toHaveBeenCalled();
      expect(enumerate.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      read.mockRestore();
      expect(identityOf(target).ino).not.toBe(BigInt(row.identity.ino));
      expect(fs.readFileSync(target, 'utf8')).toBe('foreign object');
      expect(repo.findEvidence(projectA.id, row.evidenceId)).toMatchObject({
        observation: 'replaced', identity: row.identity, expectedSize: row.expectedSize, expectedSha256: row.expectedSha256,
      });
    });

    it('unavailable-during-validation: later EACCES and inaccessible reinspection persist unavailable', () => {
      const { row, target } = addEvidence(projectA);
      const realLstat = fs.lstatSync.bind(fs);
      const inspections = [];
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (path.resolve(String(filePath)) === target) {
          inspections.push({ bigint: args[0]?.bigint, inTransaction: db.inTransaction });
          if (inspections.length > 1) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return realLstat(filePath, ...args);
      });
      const read = vi.spyOn(fs, 'readFileSync');

      expect(refreshOne(projectA, row.evidenceId).observation).toBe('unavailable');
      expect(inspections).toEqual(Array(3).fill({ bigint: true, inTransaction: false }));
      expect(read).not.toHaveBeenCalled();
      expect(repo.findEvidence(projectA.id, row.evidenceId)).toMatchObject({ observation: 'unavailable', identity: row.identity });
    });

    it('a transient content-validation stat failure with the same inspectable identity remains unavailable', () => {
      const { row, target } = addEvidence(projectA);
      const realLstat = fs.lstatSync.bind(fs);
      let inspections = 0;
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (path.resolve(String(filePath)) === target && ++inspections === 2) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return realLstat(filePath, ...args);
      });
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('unavailable');
      expect(inspections).toBe(3);
      expect(repo.findEvidence(projectA.id, row.evidenceId).identity).toEqual(row.identity);
    });

    it('a content read failure with the same inspectable identity remains unavailable', () => {
      const { row } = addEvidence(projectA);
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      });
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('unavailable');
      expect(repo.findEvidence(projectA.id, row.evidenceId)).toMatchObject({
        observation: 'unavailable', identity: row.identity, expectedSize: row.expectedSize, expectedSha256: row.expectedSha256,
      });
    });

    it('failed-snapshot reinspection rejects a newly substituted intermediate junction without following it', () => {
      const { row, target } = addEvidence(projectA);
      const stagingRoot = path.dirname(target);
      const outside = path.join(tmpDir, 'outside-root');
      const realOpen = fs.openSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let substituted = false;
      const leafInspections = [];
      const parentReinspections = [];
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (flags === 'r' && path.resolve(String(filePath)) === target) {
          fs.renameSync(stagingRoot, outside);
          fs.symlinkSync(outside, stagingRoot, 'junction');
          substituted = true;
          throw Object.assign(new Error('unavailable'), { code: 'EACCES' });
        }
        return realOpen(filePath, flags, ...args);
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (substituted && path.resolve(String(filePath)) === target) leafInspections.push(filePath);
        if (substituted && path.resolve(String(filePath)) === stagingRoot) parentReinspections.push(filePath);
        return realLstat(filePath, ...args);
      });
      const read = vi.spyOn(fs, 'readFileSync');
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('unavailable');
      expect(substituted).toBe(true);
      expect(parentReinspections).toEqual([stagingRoot]);
      expect(leafInspections).toEqual([]);
      expect(read).not.toHaveBeenCalled();
    });

    // Live SMB sequence (WP4): before the first read-only open, the path reports later write
    // times T2; that open settles them back to T1, which every later stat reports. Only bigint
    // mtimeNs/ctimeNs are modelled; identity, size and bytes are real.
    function modelSmbSettling(target) {
      const STEP = 20448600n;
      const realIno = fs.lstatSync(target, { bigint: true }).ino;
      const realOpen = fs.openSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      const observed = [];
      let settled = false;
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if ((flags === undefined || flags === 'r') && path.resolve(String(filePath)) === target) settled = true;
        return realOpen(filePath, flags, ...args);
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        const stats = realLstat(filePath, ...args);
        if (typeof stats?.ino !== 'bigint' || stats.ino !== realIno) return stats;
        const step = settled ? 0n : STEP;
        const modelled = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          mtimeNs: stats.mtimeNs + step, ctimeNs: stats.ctimeNs + step,
        });
        observed.push(modelled.mtimeNs);
        return modelled;
      });
      return { observed, step: STEP };
    }

    it('SMB T2 → T1 settling during the first hash → present', () => {
      const { row, target } = addEvidence(projectA);
      const smb = modelSmbSettling(target);
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('present');
      const t1 = smb.observed.at(-1);
      expect(smb.observed).toContain(t1 + smb.step);
      expect(smb.observed.lastIndexOf(t1 + smb.step)).toBeLessThan(smb.observed.indexOf(t1));
      expect(smb.observed.slice(smb.observed.indexOf(t1)).every((value) => value === t1)).toBe(true);
    });

    it('a same-identity in-place rewrite right after the first hash → changed, never present', () => {
      const { row, target } = addEvidence(projectA);
      const realOpen = fs.openSync.bind(fs);
      const realClose = fs.closeSync.bind(fs);
      const hashDescriptors = new Set();
      let hashOpens = 0;
      let rewritten = false;
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        const descriptor = realOpen(filePath, flags, ...args);
        if (flags === 'r' && path.resolve(String(filePath)) === target) {
          hashDescriptors.add(descriptor);
          hashOpens += 1;
        }
        return descriptor;
      });
      vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
        const result = realClose(descriptor, ...args);
        const hashing = hashDescriptors.delete(descriptor);
        if (hashing && !rewritten) {
          rewritten = true;
          // The first hash read the expected bytes; a writer now replaces them in place.
          const writer = realOpen(target, 'r+');
          fs.writeSync(writer, Buffer.from('STAGE BYTES'), 0, 11, 0);
          realClose(writer);
          const later = new Date(Date.now() + 60_000);
          fs.utimesSync(target, later, later);
        }
        return result;
      });
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('changed');
      expect(rewritten).toBe(true);
      expect(identityOf(target).ino).toBe(BigInt(row.identity.ino));
      // The conditional rehash ran and saw the rewritten bytes.
      expect(hashOpens).toBe(2);
    });
  });

  describe('targeted refresh: observation-only persistence', () => {
    function groupRow(projectId, groupId) {
      return db.prepare('SELECT * FROM processing_recovery_mutation_groups WHERE project_id = ? AND group_id = ?')
        .get(projectId, groupId);
    }
    function evidenceRow(evidenceId) {
      return db.prepare('SELECT * FROM processing_recovery_evidence WHERE evidence_id = ?').get(evidenceId);
    }
    function counts() {
      return {
        groups: db.prepare('SELECT COUNT(*) FROM processing_recovery_mutation_groups').pluck().get(),
        evidence: db.prepare('SELECT COUNT(*) FROM processing_recovery_evidence').pluck().get(),
        // The processing recovery gate is stored in app_meta.
        appMeta: db.prepare('SELECT * FROM app_meta ORDER BY key').all(),
      };
    }

    it('changes only observation/observedAt: identity, proof, lifecycle, retention, checkpoint, rows and groups stay', () => {
      const replaced = addEvidence(projectA, { lifecycle: 'recovery-critical', checkpoint: 'replace' });
      const missing = addEvidence(projectA, {
        lifecycle: 'dispensable', artifactPath: `.creatorcrate-convert-staging/${TOKEN}.1.output`,
      });
      fs.rmSync(replaced.target);
      fs.writeFileSync(replaced.target, 'other object');
      fs.rmSync(missing.target);
      const before = [evidenceRow(replaced.row.evidenceId), evidenceRow(missing.row.evidenceId)];
      const groupsBefore = [groupRow(projectA.id, replaced.group.groupId), groupRow(projectA.id, missing.group.groupId)];
      const countsBefore = counts();
      const treeBefore = snapshotTree(projectA.dir);

      const refreshed = service.refreshEvidence(projectA.id, [replaced.row.evidenceId, missing.row.evidenceId]);
      expect(refreshed.map((entry) => entry.observation)).toEqual(['replaced', 'missing']);

      const after = [evidenceRow(replaced.row.evidenceId), evidenceRow(missing.row.evidenceId)];
      after.forEach((row, index) => {
        const { observation, observed_at: observedAt, updated_at: _updated, ...rest } = row;
        const { observation: _o, observed_at: _a, updated_at: _u, ...restBefore } = before[index];
        expect(rest).toEqual(restBefore);
        expect(observedAt).toEqual(expect.any(String));
        expect(observation).not.toBe('unchecked');
      });
      expect([groupRow(projectA.id, replaced.group.groupId), groupRow(projectA.id, missing.group.groupId)])
        .toEqual(groupsBefore);
      expect(groupsBefore[0].checkpoint).toBe('replace');
      expect(counts()).toEqual(countsBefore);
      expect(snapshotTree(projectA.dir)).toEqual(treeBefore);
      expect(refreshed[0].cleanupPolicyEligible).toBe(false);
    });

    it('persists all observations in one transaction after inspecting with no transaction open', () => {
      const first = addEvidence(projectA);
      const second = addEvidence(projectA, { artifactPath: `.creatorcrate-convert-staging/${TOKEN}.1.output` });
      const realLstat = fs.lstatSync.bind(fs);
      const inTransactionDuringInspection = [];
      vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
        inTransactionDuringInspection.push(db.inTransaction);
        return realLstat(...args);
      });
      const writes = [];
      const recording = Object.create(repo);
      recording.setEvidenceObservation = (...args) => {
        writes.push(db.inTransaction);
        return repo.setEvidenceObservation(...args);
      };
      service = makeService({ repository: recording });
      service.refreshEvidence(projectA.id, [first.row.evidenceId, second.row.evidenceId]);
      expect(inTransactionDuringInspection.length).toBeGreaterThan(0);
      expect(inTransactionDuringInspection.every((open) => open === false)).toBe(true);
      expect(writes).toEqual([true, true]);
    });

    it('an observation write failure propagates, rolls back every observation and touches no file', () => {
      const first = addEvidence(projectA);
      const second = addEvidence(projectA, { artifactPath: `.creatorcrate-convert-staging/${TOKEN}.1.output` });
      const failure = new Error('disk I/O error');
      const failing = Object.create(repo);
      let call = 0;
      failing.setEvidenceObservation = (...args) => {
        call += 1;
        if (call === 2) throw failure;
        return repo.setEvidenceObservation(...args);
      };
      service = makeService({ repository: failing });
      const treeBefore = snapshotTree(projectA.dir);
      const rowsBefore = [repo.findEvidence(projectA.id, first.row.evidenceId), repo.findEvidence(projectA.id, second.row.evidenceId)];
      const mutating = ['unlinkSync', 'rmSync', 'renameSync', 'writeFileSync', 'writeSync', 'rmdirSync', 'truncateSync', 'copyFileSync']
        .map((name) => vi.spyOn(fs, name));

      expect(() => service.refreshEvidence(projectA.id, [first.row.evidenceId, second.row.evidenceId])).toThrow(failure);
      expect(call).toBe(2);
      expect(mutating.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      expect([repo.findEvidence(projectA.id, first.row.evidenceId), repo.findEvidence(projectA.id, second.row.evidenceId)])
        .toEqual(rowsBefore);
      expect(snapshotTree(projectA.dir)).toEqual(treeBefore);
    });

    it('a stored observation is advisory: the file may change right after a refresh', () => {
      // Any cleanup (WP7B) must re-prove identity and content immediately before acting.
      const { row, target } = addEvidence(projectA);
      expect(refreshOne(projectA, row.evidenceId)).toMatchObject({ observation: 'present', cleanupPolicyEligible: true });
      fs.rmSync(target);
      fs.writeFileSync(target, 'foreign');
      const listed = service.listProjectEvidence(projectA.id)[0];
      expect(listed).toMatchObject({ observation: 'present', cleanupPolicyEligible: true });
      expect(Object.keys(listed)).not.toContain('safeToDelete');
      expect(refreshOne(projectA, row.evidenceId).observation).toBe('replaced');
    });
  });
  describe('WP7B cleanup', () => {
    const cleanupOne = async (entry) => (await service.cleanupEvidence(projectA.id, [entry.row.evidenceId]))[0];
    const error = (code = 'EACCES') => Object.assign(new Error('simulated filesystem failure'), { code });
    const differentPath = (index) => `.creatorcrate-convert-staging/${TOKEN}.${index}.output`;

    function replace(entry) {
      fs.renameSync(entry.target, `${entry.target}.old`);
      fs.writeFileSync(entry.target, 'foreign file');
    }

    function rewrite(entry) {
      const writer = fs.openSync(entry.target, 'r+');
      fs.writeSync(writer, Buffer.from('STAGE BYTES'), 0, 11, 0);
      fs.closeSync(writer);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(entry.target, later, later);
    }

    function expectRetained(entry, observation) {
      const current = repo.findEvidence(projectA.id, entry.row.evidenceId);
      expect(current).toMatchObject({ ...entry.row, observation, observedAt: expect.any(String), updatedAt: expect.any(String) });
      expect(repo.findMutationGroup(projectA.id, entry.group.groupId)).toEqual(entry.group);
    }

    // Fire after a successful snapshot's post-read fingerprint was captured, before
    // cleanup's separate pathname/continuity sweep. The returned stat is the old snapshot.
    function afterSnapshot(entry, action) {
      const realRead = fs.readFileSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let read = false;
      let postReadStats = 0;
      let fired = false;
      vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
        const bytes = realRead(...args);
        if (typeof args[0] === 'number') read = true;
        return bytes;
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        const stats = realLstat(filePath, ...args);
        if (!fired && read && path.resolve(String(filePath)) === entry.target && args[0]?.bigint) {
          postReadStats += 1;
          if (postReadStats === 2) {
            fired = true;
            action();
          }
        }
        return stats;
      });
      return () => expect(fired).toBe(true);
    }

    it('requires the shared coordinator rather than creating a second lock', () => {
      service = makeService({ projectOperationCoordinator: undefined });
      expect(() => service.cleanupEvidence(projectA.id, [])).toThrow('shared asynchronous projectOperationCoordinator');
    });

    it('holds the exact project lock from row/group refetch through filesystem work and metadata settlement', async () => {
      const entry = addEvidence(projectA);
      const seen = [];
      const recording = Object.create(repo);
      for (const method of ['findEvidence', 'findMutationGroup', 'deleteEvidence', 'deleteMutationGroup']) {
        recording[method] = (...args) => {
          seen.push([method, coordinator.isActive(projectA.id)]);
          return repo[method](...args);
        };
      }
      service = makeService({ repository: recording });
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((...args) => {
        expect(coordinator.isActive(projectA.id)).toBe(true);
        expect(() => coordinator.run(projectA.id, () => {})).toThrow();
        return realUnlink(...args);
      });
      const run = vi.spyOn(coordinator, 'runAsync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'cleaned' });
      expect(run).toHaveBeenCalledExactlyOnceWith(projectA.id, expect.any(Function));
      expect(unlink).toHaveBeenCalledExactlyOnceWith(entry.target);
      expect(seen.length).toBeGreaterThan(4);
      expect(seen.every(([, active]) => active)).toBe(true);
      expect(coordinator.isActive(projectA.id)).toBe(false);
    });

    it('queues behind processing and recomputes policy from rows/groups after acquiring the lock', async () => {
      const entry = addEvidence(projectA);
      expect(service.listProjectEvidence(projectA.id)[0].cleanupPolicyEligible).toBe(true);
      let release;
      const processing = coordinator.runAsync(projectA.id, () => new Promise((resolve) => { release = resolve; }));
      const pending = service.cleanupEvidence(projectA.id, [entry.row.evidenceId]);
      repo.setEvidenceLifecycle(projectA.id, entry.row.evidenceId, 'recovery-critical');
      repo.markMutationCheckpoint(projectA.id, entry.group.groupId, 'replace');
      const { result, calls } = countFsCalls(() => {
        release();
        return pending;
      });
      await processing;
      expect(await result).toEqual([expect.objectContaining({ status: 'blocked', reason: 'recovery-critical' })]);
      expect(calls).toEqual([]);
      expect(fs.existsSync(entry.target)).toBe(true);
    });

    it('rejects foreign and unknown IDs identically before any filesystem call or own-row deletion', async () => {
      const own = addEvidence(projectA);
      const foreign = addEvidence(projectB);
      for (const id of [foreign.row.evidenceId, 'unknown-evidence']) {
        const { result, calls } = countFsCalls(() => service.cleanupEvidence(projectA.id, [own.row.evidenceId, id]));
        await expect(result).rejects.toMatchObject({ code: 'RECOVERY_EVIDENCE_NOT_FOUND', message: 'Processing recovery evidence not found.' });
        expect(calls).toEqual([]);
      }
      expect(repo.findEvidence(projectA.id, own.row.evidenceId)).toEqual(own.row);
      expect(repo.findEvidence(projectB.id, foreign.row.evidenceId)).toEqual(foreign.row);
      expect(fs.existsSync(own.target)).toBe(true);
      expect(fs.existsSync(foreign.target)).toBe(true);
    });

    it('normalizes duplicate IDs in first-occurrence order with one unlink per row', async () => {
      const first = addEvidence(projectA);
      const second = addEvidence(projectA, { artifactPath: differentPath(1) });
      const unlink = vi.spyOn(fs, 'unlinkSync');
      const result = await service.cleanupEvidence(projectA.id, [second.row.evidenceId, first.row.evidenceId, second.row.evidenceId]);
      expect(result.map((item) => [item.evidenceId, item.status])).toEqual([
        [second.row.evidenceId, 'cleaned'], [first.row.evidenceId, 'cleaned'],
      ]);
      expect(unlink.mock.calls).toEqual([[second.target], [first.target]]);
    });

    it.each(PUBLIC_SAMPLES)('public %s / %s wins over a private-looking path and complete proof', async (operation, artifactRole) => {
      const artifactPath = PRIVATE_SAMPLES.find(([op]) => op === operation)[2];
      const entry = addEvidence(projectA, { operation, artifactRole, artifactPath });
      const { result, calls } = countFsCalls(() => cleanupOne(entry));
      expect(await result).toMatchObject({ status: 'blocked', reason: 'public-tracking' });
      expect(calls).toEqual([]);
      expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toEqual(entry.row);
      expect(repo.findMutationGroup(projectA.id, entry.group.groupId)).toEqual(entry.group);
      expect(fs.readFileSync(entry.target, 'utf8')).toBe('stage bytes');
    });

    it.each([
      ['unknown-role', { artifactRole: 'legacy-thing' }],
      ['invalid-private-path', { artifactPath: 'Final/output.webp' }],
      ['invalid-private-path', { operation: 'archive', artifactRole: 'archive-stage', artifactPath: `.creatorcrate-watermark-staging/${TOKEN}.archive-0.txt` }],
      ['intent', { lifecycle: 'intent' }],
      ['recovery-critical', { lifecycle: 'recovery-critical' }],
      ['checkpoint-active', { checkpoint: 'replace' }],
      ['proof-incomplete', { identity: null }],
      ['proof-incomplete', { expectedSize: null }],
      ['proof-incomplete', { expectedSha256: null }],
    ])('blocks %s before filesystem access', async (reason, overrides) => {
      const entry = addEvidence(projectA, overrides);
      const { result, calls } = countFsCalls(() => cleanupOne(entry));
      expect(await result).toMatchObject({ status: 'blocked', reason });
      expect(calls).toEqual([]);
      expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toEqual(entry.row);
      expect(repo.findMutationGroup(projectA.id, entry.group.groupId)).toEqual(entry.group);
    });

    it('blocks an unknown operation without filesystem access', async () => {
      const entry = addEvidence(projectA);
      const unknown = Object.create(repo);
      unknown.findEvidence = (...args) => ({ ...repo.findEvidence(...args), operation: 'future-operation', cleanupPolicyEligible: true });
      service = makeService({ repository: unknown });
      const { result, calls } = countFsCalls(() => cleanupOne(entry));
      expect(await result).toMatchObject({ status: 'blocked', reason: 'unknown-role' });
      expect(calls).toEqual([]);
      expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toEqual(entry.row);
    });

    it('ignores a supplied cached eligibility property and revalidates the private namespace', async () => {
      const entry = addEvidence(projectA, { artifactPath: 'Final/live.webp' });
      const cached = Object.create(repo);
      cached.findEvidence = (...args) => ({ ...repo.findEvidence(...args), cleanupPolicyEligible: true });
      service = makeService({ repository: cached });
      const { result, calls } = countFsCalls(() => cleanupOne(entry));
      expect(await result).toMatchObject({ status: 'blocked', reason: 'invalid-private-path' });
      expect(calls).toEqual([]);
    });

    it.each(PRIVATE_SAMPLES)('fresh proof removes approved private %s / %s', async (operation, artifactRole, artifactPath) => {
      const entry = addEvidence(projectA, { operation, artifactRole, artifactPath });
      const read = vi.spyOn(fs, 'readFileSync');
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toEqual({
        evidenceId: entry.row.evidenceId, artifactPath, status: 'cleaned', reason: 'removed', observation: 'missing',
      });
      expect(read.mock.calls.some(([descriptor]) => typeof descriptor === 'number')).toBe(true);
      expect(unlink).toHaveBeenCalledExactlyOnceWith(entry.target);
      expect(fs.existsSync(entry.target)).toBe(false);
      expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toBeNull();
      expect(repo.findMutationGroup(projectA.id, entry.group.groupId)).toBeNull();
    });

    it('confirms already-absent private evidence before metadata deletion, without unlink', async () => {
      const entry = addEvidence(projectA);
      fs.unlinkSync(entry.target);
      const unlink = vi.spyOn(fs, 'unlinkSync');
      const realLstat = fs.lstatSync.bind(fs);
      let missingChecks = 0;
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (path.resolve(String(filePath)) === entry.target) missingChecks += 1;
        return realLstat(filePath, ...args);
      });
      const recording = Object.create(repo);
      recording.deleteEvidence = (...args) => {
        expect(missingChecks).toBeGreaterThanOrEqual(2);
        return repo.deleteEvidence(...args);
      };
      service = makeService({ repository: recording });
      expect(await cleanupOne(entry)).toMatchObject({ status: 'already-absent', observation: 'missing' });
      expect(unlink).not.toHaveBeenCalled();
      expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toBeNull();
      expect(repo.findMutationGroup(projectA.id, entry.group.groupId)).toBeNull();
    });

    it('uses fresh proof when the stored observation is missing but the owned file is present', async () => {
      const entry = addEvidence(projectA);
      repo.setEvidenceObservation(projectA.id, entry.row.evidenceId, 'missing');
      const read = vi.spyOn(fs, 'readFileSync');
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'cleaned' });
      expect(read.mock.calls.some(([descriptor]) => typeof descriptor === 'number')).toBe(true);
      expect(unlink).toHaveBeenCalledExactlyOnceWith(entry.target);
    });

    it('stored present does not authorize hashing or unlinking a foreign replacement', async () => {
      const entry = addEvidence(projectA);
      repo.setEvidenceObservation(projectA.id, entry.row.evidenceId, 'present');
      replace(entry);
      const open = vi.spyOn(fs, 'openSync');
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'retained', reason: 'replaced' });
      expect(open.mock.calls.some(([filePath]) => filePath === entry.target)).toBe(false);
      expect(unlink).not.toHaveBeenCalled();
      expectRetained(entry, 'replaced');
      expect(fs.readFileSync(entry.target, 'utf8')).toBe('foreign file');
    });

    it.each(['directory', 'junction', 'symlink', 'nonregular'])('never follows or unlinks a %s substitute', async (kind) => {
      const entry = addEvidence(projectA);
      fs.unlinkSync(entry.target);
      const outside = path.join(tmpDir, 'outside');
      fs.mkdirSync(outside);
      if (kind === 'directory') fs.mkdirSync(entry.target);
      else if (kind === 'junction') fs.symlinkSync(outside, entry.target, 'junction');
      else {
        fs.writeFileSync(entry.target, 'stage bytes');
        // Model the no-follow lstat result for file symlinks/nonregular objects on
        // Windows without depending on an elevated symlink-creation privilege.
        const realLstat = fs.lstatSync.bind(fs);
        vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
          const stats = realLstat(filePath, ...args);
          if (path.resolve(String(filePath)) !== entry.target) return stats;
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
            isSymbolicLink: () => kind === 'symlink', isFile: () => false,
          });
        });
      }
      const open = vi.spyOn(fs, 'openSync');
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'retained', reason: 'replaced' });
      expect(open.mock.calls.some(([filePath]) => filePath === entry.target || String(filePath).startsWith(outside))).toBe(false);
      expect(unlink).not.toHaveBeenCalled();
      expectRetained(entry, 'replaced');
    });

    it('refuses an intermediate staging junction without following it', async () => {
      const entry = addEvidence(projectA);
      const staging = path.dirname(entry.target);
      const outside = path.join(tmpDir, 'outside-stage');
      fs.renameSync(staging, outside);
      fs.symlinkSync(outside, staging, 'junction');
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'retained', reason: 'unavailable' });
      expect(unlink).not.toHaveBeenCalled();
      expectRetained(entry, 'unavailable');
    });

    it('does not unlink same-identity changed bytes even when stored observation is present', async () => {
      const entry = addEvidence(projectA);
      repo.setEvidenceObservation(projectA.id, entry.row.evidenceId, 'present');
      rewrite(entry);
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'retained', reason: 'changed' });
      expect(unlink).not.toHaveBeenCalled();
      expectRetained(entry, 'changed');
    });

    it('allows bounded SMB T2 to T1 settling with two fresh content reads', async () => {
      const entry = addEvidence(projectA);
      const realOpen = fs.openSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let settled = false;
      let opens = 0;
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (flags === 'r' && path.resolve(String(filePath)) === entry.target) { settled = true; opens += 1; }
        return realOpen(filePath, flags, ...args);
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        const stats = realLstat(filePath, ...args);
        if (!settled && args[0]?.bigint && path.resolve(String(filePath)) === entry.target) {
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
            mtimeNs: stats.mtimeNs + 20_448_600n, ctimeNs: stats.ctimeNs + 20_448_600n,
          });
        }
        return stats;
      });
      expect(await cleanupOne(entry)).toMatchObject({ status: 'cleaned' });
      expect(opens).toBe(2);
    });

    it('conditional rehash catches a rewrite after the first successful hash', async () => {
      const entry = addEvidence(projectA);
      const realOpen = fs.openSync.bind(fs);
      const realClose = fs.closeSync.bind(fs);
      const descriptors = new Set();
      let rewritten = false;
      let opens = 0;
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        const descriptor = realOpen(filePath, flags, ...args);
        if (flags === 'r' && path.resolve(String(filePath)) === entry.target) { descriptors.add(descriptor); opens += 1; }
        return descriptor;
      });
      vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
        const result = realClose(descriptor);
        if (descriptors.delete(descriptor) && !rewritten) { rewritten = true; rewrite(entry); }
        return result;
      });
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'retained', reason: 'changed' });
      expect(opens).toBe(2);
      expect(unlink).not.toHaveBeenCalled();
      expectRetained(entry, 'changed');
    });

    it.each(['replace', 'rewrite', 'disappear'])('final pre-unlink continuity catches %s after a successful snapshot', async (change) => {
      const entry = addEvidence(projectA);
      const fired = afterSnapshot(entry, () => {
        if (change === 'replace') replace(entry);
        else if (change === 'rewrite') rewrite(entry);
        else fs.unlinkSync(entry.target);
      });
      const realUnlink = fs.unlinkSync.bind(fs);
      const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((...args) => realUnlink(...args));
      const result = await cleanupOne(entry);
      fired();
      expect(unlink).toHaveBeenCalledTimes(change === 'disappear' ? 1 : 0);
      if (change === 'disappear') {
        expect(result).toMatchObject({ status: 'already-absent' });
        expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toBeNull();
      } else {
        expect(result).toMatchObject({ status: 'retained', reason: change === 'replace' ? 'replaced' : 'changed' });
        expectRetained(entry, result.observation);
        if (change === 'replace') expect(fs.readFileSync(entry.target, 'utf8')).toBe('foreign file');
      }
    });

    it.each(['missing', 'replaced', 'unavailable', 'changed', 'present'])('unlink failure diagnoses current %s state', async (observation) => {
      const entry = addEvidence(projectA);
      const realUnlink = fs.unlinkSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let failed = false;
      vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath) => {
        failed = true;
        if (observation === 'missing') realUnlink(filePath);
        if (observation === 'replaced') replace(entry);
        if (observation === 'changed') rewrite(entry);
        throw error('EBUSY');
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (failed && observation === 'unavailable' && path.resolve(String(filePath)) === entry.target) throw error();
        return realLstat(filePath, ...args);
      });
      const result = await cleanupOne(entry);
      expect(failed).toBe(true);
      expect(result).toMatchObject({ observation, status: observation === 'missing' ? 'already-absent' : 'retained' });
      if (observation === 'missing') expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toBeNull();
      else expectRetained(entry, observation);
      if (observation === 'replaced') expect(fs.readFileSync(entry.target, 'utf8')).toBe('foreign file');
    });

    it('checks the fingerprint again at the exact-owned unlink helper last inspection', async () => {
      const entry = addEvidence(projectA);
      const realRead = fs.readFileSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let read = false;
      let postReadStats = 0;
      let rewritten = false;
      vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
        const bytes = realRead(...args);
        if (typeof args[0] === 'number') read = true;
        return bytes;
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (read && args[0]?.bigint && path.resolve(String(filePath)) === entry.target && ++postReadStats === 5) {
          rewritten = true;
          rewrite(entry);
        }
        return realLstat(filePath, ...args);
      });
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'retained', reason: 'changed' });
      expect(rewritten).toBe(true);
      expect(unlink).not.toHaveBeenCalled();
      expectRetained(entry, 'changed');
    });

    it.each(['replaced', 'unavailable', 'present'])('successful unlink with post-unlink %s is incomplete and retains metadata', async (observation) => {
      const entry = addEvidence(projectA);
      const realUnlink = fs.unlinkSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let unlinked = false;
      const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath) => {
        if (observation === 'replaced') { fs.renameSync(filePath, `${filePath}.old`); fs.writeFileSync(filePath, 'foreign file'); }
        else if (observation !== 'present') realUnlink(filePath);
        unlinked = true;
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (unlinked && observation === 'unavailable' && path.resolve(String(filePath)) === entry.target) throw error();
        return realLstat(filePath, ...args);
      });
      expect(await cleanupOne(entry)).toMatchObject({ status: 'retained', observation });
      expect(unlink).toHaveBeenCalledTimes(1);
      expectRetained(entry, observation);
      if (observation === 'replaced') expect(fs.readFileSync(entry.target, 'utf8')).toBe('foreign file');
    });

    it.each(['missing', 'replaced', 'unavailable'])('failed content snapshot reinspects %s with accepted precedence', async (observation) => {
      const entry = addEvidence(projectA);
      const realOpen = fs.openSync.bind(fs);
      const realLstat = fs.lstatSync.bind(fs);
      let changed = false;
      vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
        if (flags === 'r' && path.resolve(String(filePath)) === entry.target) {
          changed = true;
          if (observation === 'missing') fs.unlinkSync(entry.target);
          if (observation === 'replaced') replace(entry);
          throw error();
        }
        return realOpen(filePath, flags, ...args);
      });
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        if (changed && observation === 'unavailable' && path.resolve(String(filePath)) === entry.target) throw error();
        return realLstat(filePath, ...args);
      });
      const result = await cleanupOne(entry);
      expect(result).toMatchObject({ observation, status: observation === 'missing' ? 'already-absent' : 'retained' });
      if (observation !== 'missing') expectRetained(entry, observation);
    });

    it('same-identity unreadable content is unavailable rather than changed or missing', async () => {
      const entry = addEvidence(projectA);
      const realRead = fs.readFileSync.bind(fs);
      vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
        if (typeof args[0] === 'number') throw error();
        return realRead(...args);
      });
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'retained', reason: 'unavailable' });
      expect(unlink).not.toHaveBeenCalled();
      expectRetained(entry, 'unavailable');
    });

    it('an unproven project root retains evidence without inspecting its staging path', async () => {
      const entry = addEvidence(projectA);
      db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(projectA.id);
      const { result, calls } = countFsCalls(() => cleanupOne(entry));
      expect(await result).toMatchObject({ status: 'retained', reason: 'unavailable' });
      expect(calls).toEqual([]);
      expectRetained(entry, 'unavailable');
    });

    it('a root substitution after content proof retains evidence without unlink', async () => {
      const entry = addEvidence(projectA);
      const fired = afterSnapshot(entry, () => {
        fs.renameSync(projectA.dir, `${projectA.dir}-old`);
        fs.mkdirSync(projectA.dir);
      });
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'retained', reason: 'unavailable' });
      fired();
      expect(unlink).not.toHaveBeenCalled();
      expectRetained(entry, 'unavailable');
    });

    it.each(['checkpoint', 'lifecycle', 'proof'])('revalidates %s after the content proof before unlink', async (change) => {
      const entry = addEvidence(projectA);
      const fired = afterSnapshot(entry, () => {
        if (change === 'checkpoint') repo.markMutationCheckpoint(projectA.id, entry.group.groupId, 'replace');
        if (change === 'lifecycle') repo.setEvidenceLifecycle(projectA.id, entry.row.evidenceId, 'intent');
        if (change === 'proof') repo.updateEvidenceContentProof(projectA.id, entry.row.evidenceId, { expectedSize: 11, expectedSha256: '0'.repeat(64) });
      });
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'blocked', reason: { checkpoint: 'checkpoint-active', lifecycle: 'intent', proof: 'evidence-changed' }[change] });
      fired();
      expect(unlink).not.toHaveBeenCalled();
      expect(fs.existsSync(entry.target)).toBe(true);
    });

    it('deletes metadata only after unlink and confirmed absence, keeping siblings and unrelated checkpoint groups', async () => {
      const entry = addEvidence(projectA);
      const sibling = addEvidence(projectA, { groupId: entry.group.groupId, artifactPath: differentPath(1), lifecycle: 'recovery-critical' });
      const zero = repo.createMutationGroup({ projectId: projectA.id, operation: 'convert', runId: RUN });
      repo.markMutationCheckpoint(projectA.id, zero.groupId, 'unlink');
      const zeroBefore = repo.findMutationGroup(projectA.id, zero.groupId);
      const recording = Object.create(repo);
      recording.deleteEvidence = (...args) => {
        expect(fs.existsSync(entry.target)).toBe(false);
        return repo.deleteEvidence(...args);
      };
      service = makeService({ repository: recording });
      expect(await cleanupOne(entry)).toMatchObject({ status: 'cleaned' });
      expect(repo.findMutationGroup(projectA.id, entry.group.groupId)).toEqual(entry.group);
      expect(repo.findEvidence(projectA.id, sibling.row.evidenceId)).toEqual(sibling.row);
      expect(repo.findMutationGroup(projectA.id, zero.groupId)).toEqual(zeroBefore);
      await service.cleanupEvidence(projectA.id, []);
      expect(repo.findMutationGroup(projectA.id, zero.groupId)).toEqual(zeroBefore);
    });

    it.each(['evidence', 'group'])('%s deletion failure never recreates an unlinked file; retry reconciles absence', async (failureAt) => {
      const entry = addEvidence(projectA);
      const failing = Object.create(repo);
      failing[failureAt === 'evidence' ? 'deleteEvidence' : 'deleteMutationGroup'] = () => { throw new Error('disk I/O error'); };
      service = makeService({ repository: failing });
      const recreating = ['writeFileSync', 'writeSync', 'copyFileSync', 'mkdirSync', 'renameSync'].map((name) => vi.spyOn(fs, name));
      await expect(cleanupOne(entry)).rejects.toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', cause: { message: 'disk I/O error' } });
      expect(recreating.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      expect(fs.existsSync(entry.target)).toBe(false);
      expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toEqual(entry.row);
      expect(repo.findMutationGroup(projectA.id, entry.group.groupId)).toEqual(entry.group);
      service = makeService();
      const unlink = vi.spyOn(fs, 'unlinkSync');
      expect(await cleanupOne(entry)).toMatchObject({ status: 'already-absent' });
      expect(unlink).not.toHaveBeenCalled();
      expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toBeNull();
    });

    it('multi-row cleanup performs all filesystem work outside the single metadata transaction', async () => {
      const clean = addEvidence(projectA);
      const changed = addEvidence(projectA, { artifactPath: differentPath(1) });
      fs.appendFileSync(changed.target, 'changed');
      const observations = [];
      for (const method of ['lstatSync', 'openSync', 'readFileSync', 'unlinkSync']) {
        const original = fs[method].bind(fs);
        vi.spyOn(fs, method).mockImplementation((...args) => {
          observations.push(db.inTransaction);
          return original(...args);
        });
      }
      const writes = [];
      const recording = Object.create(repo);
      for (const method of ['deleteEvidence', 'setEvidenceObservation', 'deleteMutationGroup']) {
        recording[method] = (...args) => { writes.push(db.inTransaction); return repo[method](...args); };
      }
      service = makeService({ repository: recording });
      const transaction = vi.spyOn(db, 'transaction');
      expect((await service.cleanupEvidence(projectA.id, [clean.row.evidenceId, changed.row.evidenceId])).map((entry) => entry.status))
        .toEqual(['cleaned', 'retained']);
      expect(observations.length).toBeGreaterThan(5);
      expect(observations.every((value) => value === false)).toBe(true);
      expect(writes).toEqual([true, true, true]);
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('multi-row metadata rollback leaves safe filesystem deletions intact and every row retryable', async () => {
      const first = addEvidence(projectA);
      const second = addEvidence(projectA, { artifactPath: differentPath(1) });
      const changed = addEvidence(projectA, { artifactPath: differentPath(2) });
      fs.appendFileSync(changed.target, 'changed');
      const failing = Object.create(repo);
      const deletes = [];
      failing.deleteEvidence = (...args) => { deletes.push(args[1]); return repo.deleteEvidence(...args); };
      failing.setEvidenceObservation = () => { throw new Error('metadata failure'); };
      service = makeService({ repository: failing });
      await expect(service.cleanupEvidence(projectA.id, [first.row.evidenceId, second.row.evidenceId, changed.row.evidenceId]))
        .rejects.toMatchObject({ code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED' });
      expect(deletes).toEqual([first.row.evidenceId, second.row.evidenceId]);
      expect(fs.existsSync(first.target)).toBe(false);
      expect(fs.existsSync(second.target)).toBe(false);
      for (const entry of [first, second, changed]) expect(repo.findEvidence(projectA.id, entry.row.evidenceId)).toEqual(entry.row);
      service = makeService();
      const results = await service.cleanupEvidence(projectA.id, [first.row.evidenceId, second.row.evidenceId, changed.row.evidenceId]);
      expect(results.map((entry) => entry.status)).toEqual(['already-absent', 'already-absent', 'retained']);
    });

    it('preserves gates, checkpoint, lifecycle, context, proof and unrequested files without JSON or enumeration', async () => {
      const changed = addEvidence(projectA);
      rewrite(changed);
      const blocked = addEvidence(projectA, { checkpoint: 'replace', artifactPath: differentPath(1) });
      const unrequested = addEvidence(projectA, { artifactPath: differentPath(2) });
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('processing_recovery_required:1', 'test-gate')").run();
      const beforeGate = db.prepare('SELECT * FROM app_meta ORDER BY key').all();
      const { result, calls } = countFsCalls(() => service.cleanupEvidence(projectA.id, [changed.row.evidenceId, blocked.row.evidenceId]));
      expect((await result).map((entry) => entry.status)).toEqual(['retained', 'blocked']);
      expectRetained(changed, 'changed');
      expect(repo.findEvidence(projectA.id, blocked.row.evidenceId)).toEqual(blocked.row);
      expect(repo.findMutationGroup(projectA.id, blocked.group.groupId)).toEqual(blocked.group);
      expect(repo.findEvidence(projectA.id, unrequested.row.evidenceId)).toEqual(unrequested.row);
      expect(db.prepare('SELECT * FROM app_meta ORDER BY key').all()).toEqual(beforeGate);
      expect(calls.filter((call) => /readdir|opendir|glob/i.test(call.name))).toEqual([]);
      expect(calls.some((call) => typeof call.arg === 'string' && /\.json$/i.test(call.arg))).toBe(false);
      expect(calls.some((call) => call.arg === unrequested.target)).toBe(false);
    });

    it.each([['dev=0', 0n, 4242n], ['beyond 2^53', 7n, 9007199254740993n]])('cleans exact bigint %s identities', async (_label, dev, ino) => {
      const entry = addEvidence(projectA);
      const realLstat = fs.lstatSync.bind(fs);
      vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => {
        const stats = realLstat(filePath, ...args);
        if (args[0]?.bigint && path.resolve(String(filePath)) === entry.target) {
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev, ino });
        }
        return stats;
      });
      db.prepare('UPDATE processing_recovery_evidence SET identity_dev = ?, identity_ino = ? WHERE evidence_id = ?')
        .run(String(dev), String(ino), entry.row.evidenceId);
      expect(await cleanupOne(entry)).toMatchObject({ status: 'cleaned' });
      expect(fs.existsSync(entry.target)).toBe(false);
    });
  });
});
