/**
 * PM-2 — conservative legacy `project.json` cleanup.
 *
 * Fixtures are real projects (created normally, so bound with a marker) that
 * additionally carry a legacy manifest written the way older versions did.
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
import { createProjectOwnershipAdoptionRepository } from '../src/data/project-ownership-adoption-repository.js';
import {
  createLegacyManifestCleanupRepository,
  LEGACY_MANIFEST_CLEANUP_KEY,
} from '../src/data/legacy-manifest-cleanup-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectService } from '../src/services/project-service.js';
import { createAssetScanner } from '../src/services/asset-scanner.js';
import { createPreviewCategorySettingsService } from '../src/services/preview-category-settings-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createLegacyManifestCleanupService } from '../src/services/legacy-manifest-cleanup-service.js';
import { resolveProjectDir } from '../src/storage/project-storage.js';
import {
  MANIFEST_FILENAME, describeLegacyManifestDivergence, formatManifestJson, serializeManifest,
} from '../src/storage/manifest.js';
import {
  inspectLegacyManifestEntry,
  isLegacyManifestCleanupQuarantineName,
  removeProvenLegacyManifestEntry,
} from '../src/storage/legacy-manifest-cleanup.js';
import { PROJECT_OWNERSHIP_MARKER_FILENAME } from '../src/storage/project-ownership-marker.js';
import { createTestProjectOptionCatalogueService } from './helpers/project-option-catalogue.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function projectInput(title) {
  return {
    title, description: 'A description', notes: 'Some notes', status: 'tbd', priority: 'normal',
    plannedDate: null, publishedDate: null, patreonUrl: 'https://example.com/p',
  };
}

function eio(target) {
  return Object.assign(new Error(`EIO: i/o error, '${target}'`), { code: 'EIO' });
}

// Present a stats object with an unknown (zero) file ID, as SMB shares may.
function zeroIdentity(stats) {
  return new Proxy(stats, {
    get(target, key) {
      if (key === 'ino') return typeof target.ino === 'bigint' ? 0n : 0;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('PM-2 legacy manifest cleanup', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let ownershipRepository;
  let adoptionRepository;
  let cleanupRepository;
  let assetCategoryService;
  let projectService;
  let coordinator;
  let timers;
  let logs;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-legacy-manifest-cleanup-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    ownershipRepository = createProjectDirectoryOwnershipRepository(db);
    adoptionRepository = createProjectOwnershipAdoptionRepository(db);
    cleanupRepository = createLegacyManifestCleanupRepository(db);
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

  const dirOf = (project) => resolveProjectDir(projectsRoot, project.project_dir);
  const manifestPath = (project) => path.join(dirOf(project), MANIFEST_FILENAME);
  const markerPath = (project) => path.join(dirOf(project), PROJECT_OWNERSHIP_MARKER_FILENAME);
  const current = (project) => projectService.repository.findById(project.id);
  const categoriesOf = (projectId) => db.prepare(
    'SELECT * FROM project_asset_categories WHERE project_id = ? ORDER BY display_order, id',
  ).all(projectId);

  /** The exact bytes the legacy writer would produce for current DB state. */
  function legacyManifest(project, override = {}) {
    return { ...serializeManifest(current(project), categoriesOf(project.id)), ...override };
  }

  function writeManifest(project, manifest = legacyManifest(project), name = MANIFEST_FILENAME) {
    const content = typeof manifest === 'string' ? manifest : formatManifestJson(manifest);
    fs.writeFileSync(path.join(dirOf(project), name), content);
    return content;
  }

  function createProject(title, { manifest = true } = {}) {
    const project = projectService.create(projectInput(title));
    if (manifest) writeManifest(project);
    return current(project);
  }

  /** Every SQLite table except lifecycle/diagnostic state. */
  function sqliteState() {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT IN ('app_meta', 'application_logs', 'sqlite_sequence') ORDER BY name`).all();
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
  }

  const listRoot = (project) => fs.readdirSync(dirOf(project)).sort();

  function completeAdoptionPass() {
    adoptionRepository.initialize();
    adoptionRepository.complete();
  }

  const logger = {
    info: (entry) => logs.push({ level: 'info', ...entry }),
    warn: (entry) => logs.push({ level: 'warn', ...entry }),
    error: (entry) => logs.push({ level: 'error', ...entry }),
  };

  function createCleanup(overrides = {}) {
    return createLegacyManifestCleanupService({
      repository: cleanupRepository,
      ownershipRepository,
      adoptionRepository,
      projectOperationCoordinator: coordinator,
      projectsRoot,
      applicationLogger: logger,
      schedule: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
      cancel: () => {},
      ...overrides,
    });
  }

  async function runCleanup(cleanup = createCleanup(), { adopt = true } = {}) {
    if (adopt) completeAdoptionPass();
    cleanup.prepare();
    cleanup.signal();
    await cleanup.waitForIdle();
    return cleanup;
  }

  async function revisit(cleanup) {
    cleanup.signal();
    await cleanup.waitForIdle();
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

  // ── proven duplicate ──────────────────────────────────────────────────

  describe('proven duplicate', () => {
    it('removes an exactly equivalent manifest and changes nothing else', async () => {
      const project = createProject('Duplicate');
      const root = dirOf(project);
      fs.writeFileSync(path.join(root, 'custom.json'), '{"mine":true}\n');
      const enabledSlug = categoriesOf(project.id).find((c) => c.enabled)?.directory_slug;
      if (enabledSlug) fs.writeFileSync(path.join(root, enabledSlug, 'data.json'), formatManifestJson(legacyManifest(project)));
      await createScanner().scanProjectAssets(project.id);
      const assets = db.prepare('SELECT id, relative_path FROM assets WHERE project_id = ? ORDER BY id').all(project.id);
      expect(assets.length).toBeGreaterThan(0);
      // Relationships that must survive: a release with an asset and a primary image.
      const releaseId = db.prepare('INSERT INTO releases (project_id, title) VALUES (?, ?)').run(project.id, 'R1').lastInsertRowid;
      db.prepare('INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)').run(releaseId, assets[0].id);
      db.prepare('INSERT INTO project_primary_images (project_id, asset_id) VALUES (?, ?)').run(project.id, assets[0].id);

      const marker = fs.readFileSync(markerPath(project));
      const before = sqliteState();

      const cleanup = await runCleanup();

      expect(fs.existsSync(manifestPath(project))).toBe(false);
      expect(listRoot(project).filter((name) => isLegacyManifestCleanupQuarantineName(name))).toEqual([]);
      expect(fs.readFileSync(markerPath(project))).toEqual(marker);
      expect(fs.readFileSync(path.join(root, 'custom.json'), 'utf8')).toBe('{"mine":true}\n');
      if (enabledSlug) expect(fs.existsSync(path.join(root, enabledSlug, 'data.json'))).toBe(true);
      expect(sqliteState()).toEqual(before);
      expect(cleanup.readiness()).toMatchObject({
        passComplete: true,
        counts: { removed: 1, tempRemoved: 0, noManifest: 0, notRequired: 0 },
        current: { retryable: 0, ownershipNotReady: 0, retainedDivergent: 0, retainedInvalid: 0, retainedUnsafe: 0 },
      });
      expect(cleanupRepository.getEntry(project.id)).toBeNull();
      expect(logs.some((log) => log.event === 'projects.legacy_manifest.removed' && log.projectId === project.id)).toBe(true);

      // The project stays fully usable: user JSON is still indexed.
      await createScanner().scanProjectAssets(project.id);
      const after = db.prepare('SELECT id, relative_path FROM assets WHERE project_id = ? AND is_present = 1 ORDER BY id').all(project.id);
      expect(after).toEqual(expect.arrayContaining(assets));
    });

    it('is a no-op when run again, including a fresh pass after the record is lost', async () => {
      const project = createProject('Twice');
      const cleanup = await runCleanup();
      const state = sqliteState();
      const root = listRoot(project);

      await revisit(cleanup);
      expect(listRoot(project)).toEqual(root);
      expect(cleanup.readiness().counts.removed).toBe(1);

      db.prepare('DELETE FROM app_meta WHERE key = ?').run(LEGACY_MANIFEST_CLEANUP_KEY);
      const again = await runCleanup(createCleanup());
      expect(listRoot(project)).toEqual(root);
      expect(again.readiness().counts).toMatchObject({ removed: 0, noManifest: 1 });
      expect(sqliteState()).toEqual(state);
    });

    it('accepts an updatedAt that only lags the row (status change not mirrored by the old writer)', async () => {
      const project = createProject('Lagging');
      db.prepare("UPDATE projects SET updated_at = '2999-01-01 00:00:00' WHERE id = ?").run(project.id);
      await runCleanup();
      expect(fs.existsSync(manifestPath(project))).toBe(false);
    });

    it('works with the legacy writer categories after category edits', async () => {
      const project = projectService.create(projectInput('Categories'));
      const [first] = categoriesOf(project.id);
      db.prepare('UPDATE project_asset_categories SET display_name = ? WHERE id = ?').run('Renamed', first.id);
      writeManifest(project);
      await runCleanup();
      expect(fs.existsSync(manifestPath(project))).toBe(false);
    });

    it('counts DB-only projects as not required and never touches orphan directories', async () => {
      const dbOnly = createProject('DB only', { manifest: false });
      db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(dbOnly.id);
      db.prepare('UPDATE projects SET project_dir = NULL WHERE id = ?').run(dbOnly.id);
      const orphan = path.join(projectsRoot, '999-orphan');
      fs.mkdirSync(orphan);
      const orphanManifest = formatManifestJson({ ...serializeManifest({ id: 999, title: 'Orphan', slug: 'orphan' }), assetCategories: [] });
      fs.writeFileSync(path.join(orphan, MANIFEST_FILENAME), orphanManifest);

      const cleanup = await runCleanup();
      expect(fs.readFileSync(path.join(orphan, MANIFEST_FILENAME), 'utf8')).toBe(orphanManifest);
      expect(cleanup.readiness().counts).toMatchObject({ notRequired: 1 });
    });
  });

  // ── divergent ─────────────────────────────────────────────────────────

  describe('divergent valid manifest', () => {
    const variants = {
      title: (p) => ({ title: 'Old title' }),
      description: () => ({ description: 'Old description' }),
      notes: () => ({ notes: 'Old notes' }),
      slug: () => ({ slug: 'old-slug' }),
      patreonUrl: () => ({ patreonUrl: null }),
      createdAt: () => ({ createdAt: '2001-01-01T00:00:00.000Z' }),
      'newer updatedAt': () => ({ updatedAt: '2999-01-01T00:00:00.000Z' }),
      'category label': (p) => ({
        assetCategories: serializeManifest(p, categoriesOf(p.id)).assetCategories
          .map((c, i) => (i === 0 ? { ...c, displayName: 'Old label' } : c)),
      }),
      'category order': (p) => {
        const cats = serializeManifest(p, categoriesOf(p.id)).assetCategories;
        return { assetCategories: cats.map((c, i) => ({ ...cats[(i + 1) % cats.length], displayOrder: i })) };
      },
      'category removed': (p) => ({ assetCategories: serializeManifest(p, categoriesOf(p.id)).assetCategories.slice(0, -1) }),
      'non-empty tags': () => ({ tags: ['legacy-tag'] }),
      'non-null thumbnail': () => ({ thumbnail: 'cover.png' }),
      'unexpected extra field': () => ({ legacyField: 'x' }),
    };

    for (const [label, change] of Object.entries(variants)) {
      it(`retains a manifest with a different ${label}, byte-for-byte`, async () => {
        const project = createProject(`Divergent ${label}`, { manifest: false });
        const bytes = writeManifest(project, legacyManifest(project, change(current(project))));
        const before = sqliteState();

        const cleanup = await runCleanup();

        expect(fs.readFileSync(manifestPath(project), 'utf8')).toBe(bytes);
        expect(sqliteState()).toEqual(before);
        expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retained', reasons: ['manifest-divergent'] });
        expect(cleanup.readiness().current.retainedDivergent).toBe(1);

        // Terminal: a later run never revisits or rewrites it.
        await revisit(cleanup);
        expect(fs.readFileSync(manifestPath(project), 'utf8')).toBe(bytes);
      });
    }

    it('retains a manifest missing a serializer field', async () => {
      const project = createProject('Missing field', { manifest: false });
      const manifest = legacyManifest(project);
      delete manifest.thumbnail;
      const bytes = writeManifest(project, manifest);
      await runCleanup();
      expect(fs.readFileSync(manifestPath(project), 'utf8')).toBe(bytes);
    });
  });

  // ── invalid ───────────────────────────────────────────────────────────

  describe('malformed / unsupported / wrong ID / unsafe', () => {
    const cases = {
      'malformed JSON': [() => '{"schemaVersion": 3, "id": ', 'manifest-malformed', 'retainedInvalid'],
      'unsupported schema': [(p) => formatManifestJson(legacyManifest(p, { schemaVersion: 2 })), 'manifest-unsupported', 'retainedInvalid'],
      'structurally invalid': [(p) => formatManifestJson(legacyManifest(p, { assetCategories: 'x' })), 'manifest-malformed', 'retainedInvalid'],
      'wrong project ID': [(p) => formatManifestJson(legacyManifest(p, { id: p.id + 100 })), 'manifest-project-mismatch', 'retainedInvalid'],
      'UTF-8 BOM': [(p) => `﻿${formatManifestJson(legacyManifest(p))}`, 'manifest-malformed', 'retainedInvalid'],
      'invalid UTF-8': [(p) => Buffer.concat([Buffer.from(formatManifestJson(legacyManifest(p)).slice(0, -2)), Buffer.from([0xff, 0x0a])]), 'manifest-malformed', 'retainedInvalid'],
    };

    for (const [label, [content, reason, bucket]] of Object.entries(cases)) {
      it(`retains a ${label} manifest untouched`, async () => {
        const project = createProject(label, { manifest: false });
        const bytes = content(current(project));
        fs.writeFileSync(manifestPath(project), bytes);
        const cleanup = await runCleanup();
        expect(fs.readFileSync(manifestPath(project))).toEqual(Buffer.from(bytes));
        expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retained', reasons: [reason] });
        expect(cleanup.readiness().current[bucket]).toBe(1);
      });
    }

    it('retains a directory named project.json', async () => {
      const project = createProject('Dir manifest', { manifest: false });
      fs.mkdirSync(manifestPath(project));
      await runCleanup();
      expect(fs.statSync(manifestPath(project)).isDirectory()).toBe(true);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retained', reasons: ['manifest-unsafe'] });
    });

    it('retains a symlinked project.json (where the platform permits symlinks)', async () => {
      const project = createProject('Symlink', { manifest: false });
      const target = path.join(tmpDir, 'outside.json');
      fs.writeFileSync(target, formatManifestJson(legacyManifest(project)));
      try {
        fs.symlinkSync(target, manifestPath(project), 'file');
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EACCES') return; // no symlink privilege here
        throw err;
      }
      const cleanup = await runCleanup();
      expect(fs.lstatSync(manifestPath(project)).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(target)).toBe(true);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retained', reasons: ['manifest-unsafe'] });
      expect(cleanup.readiness().current.retainedUnsafe).toBe(1);
    });
  });

  it('retains an entry reported as a symlink (simulated, for platforms without symlink privilege)', async () => {
    const project = createProject('Simulated symlink');
    const bytes = fs.readFileSync(manifestPath(project));
    const target = manifestPath(project); // resolved outside the mock (it lstats too)
    const realLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation((entry, ...rest) => {
      const stats = realLstat(entry, ...rest);
      if (entry !== target) return stats;
      return new Proxy(stats, {
        get: (t, key) => (key === 'isSymbolicLink' ? () => true : (typeof t[key] === 'function' ? t[key].bind(t) : t[key])),
      });
    });
    await runCleanup();
    vi.restoreAllMocks();
    expect(fs.readFileSync(manifestPath(project))).toEqual(bytes);
    expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retained', reasons: ['manifest-unsafe'] });
  });

  // ── SMB / I/O ─────────────────────────────────────────────────────────

  describe('transient I/O', () => {
    function failOpens(predicate) {
      const realOpen = fs.openSync.bind(fs);
      return vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        if (typeof target === 'string' && predicate(target)) throw eio(target);
        return realOpen(target, ...rest);
      });
    }

    it('retains on marker EIO, continues with other projects, and removes after a healthy retry', async () => {
      const a = createProject('Offline A');
      const b = createProject('Healthy B');
      const bytes = fs.readFileSync(manifestPath(a));
      const spy = failOpens((target) => target === markerPath(a));

      const cleanup = await runCleanup();
      expect(fs.readFileSync(manifestPath(a))).toEqual(bytes);
      expect(fs.existsSync(manifestPath(b))).toBe(false);
      expect(cleanupRepository.getEntry(a.id)).toMatchObject({ status: 'retryable', reasons: ['marker-unavailable'] });
      expect(cleanup.readiness()).toMatchObject({ passComplete: true, current: { retryable: 1 } });
      expect(timers.at(-1).delay).toBe(60_000);

      spy.mockRestore();
      timers.at(-1).callback();
      await cleanup.waitForIdle();
      expect(fs.existsSync(manifestPath(a))).toBe(false);
      expect(cleanupRepository.getEntry(a.id)).toBeNull();
      expect(cleanup.readiness().counts.removed).toBe(2);
    });

    it('retains on manifest read EIO', async () => {
      const project = createProject('Read EIO');
      const bytes = fs.readFileSync(manifestPath(project));
      const spy = failOpens((target) => target === manifestPath(project));
      const cleanup = await runCleanup();
      spy.mockRestore(); // readFileSync itself goes through fs.openSync
      expect(fs.readFileSync(manifestPath(project))).toEqual(bytes);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retryable', reasons: ['manifest-unavailable'] });
      await revisit(cleanup);
      expect(fs.existsSync(manifestPath(project))).toBe(false);
    });

    it('retains when the projects root is unavailable', async () => {
      const project = createProject('Root down');
      const realStat = fs.statSync.bind(fs);
      const spy = vi.spyOn(fs, 'statSync').mockImplementation((target, ...rest) => {
        if (path.resolve(String(target)) === path.resolve(projectsRoot)) throw eio(target);
        return realStat(target, ...rest);
      });
      const cleanup = await runCleanup();
      expect(fs.existsSync(manifestPath(project))).toBe(true);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retryable', reasons: ['projects-root-unavailable'] });
      spy.mockRestore();
      await revisit(cleanup);
      expect(fs.existsSync(manifestPath(project))).toBe(false);
    });

    it('retains when the pre-delete ownership re-verification fails', async () => {
      const project = createProject('Reverify EIO');
      const bytes = fs.readFileSync(manifestPath(project));
      let markerOpens = 0;
      const spy = failOpens((target) => target === markerPath(project) && ++markerOpens === 2);
      const cleanup = await runCleanup();
      expect(markerOpens).toBe(2);
      expect(fs.readFileSync(manifestPath(project))).toEqual(bytes);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retryable', reasons: ['marker-unavailable'] });
      spy.mockRestore();
      await revisit(cleanup);
      expect(fs.existsSync(manifestPath(project))).toBe(false);
    });

    it('puts the file back when the moved entry cannot be re-verified', async () => {
      const project = createProject('Moved EIO');
      const bytes = fs.readFileSync(manifestPath(project));
      const spy = failOpens((target) => isLegacyManifestCleanupQuarantineName(path.basename(target)));
      const cleanup = await runCleanup();
      expect(fs.readFileSync(manifestPath(project))).toEqual(bytes);
      expect(listRoot(project).filter(isLegacyManifestCleanupQuarantineName)).toEqual([]);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retryable', reasons: ['manifest-unavailable'] });
      spy.mockRestore();
      await revisit(cleanup);
      expect(fs.existsSync(manifestPath(project))).toBe(false);
    });

    it('retains a verified duplicate in quarantine when unlink fails, and finishes later', async () => {
      const project = createProject('Unlink EIO');
      const realUnlink = fs.unlinkSync.bind(fs);
      const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
        if (isLegacyManifestCleanupQuarantineName(path.basename(String(target)))) throw eio(target);
        return realUnlink(target);
      });
      const cleanup = await runCleanup();
      expect(fs.existsSync(manifestPath(project))).toBe(false);
      expect(listRoot(project).filter(isLegacyManifestCleanupQuarantineName)).toHaveLength(1);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retryable', reasons: ['removal-incomplete'] });
      spy.mockRestore();
      await revisit(cleanup);
      expect(listRoot(project).filter(isLegacyManifestCleanupQuarantineName)).toEqual([]);
      expect(cleanupRepository.getEntry(project.id)).toBeNull();
      expect(cleanup.readiness().counts).toMatchObject({ removed: 0, tempRemoved: 1 });
    });

    it('retains when the project is busy with another operation', async () => {
      const project = createProject('Busy');
      let release;
      const busy = coordinator.runAsync(project.id, () => new Promise((resolve) => { release = resolve; }));
      const cleanup = await runCleanup();
      expect(fs.existsSync(manifestPath(project))).toBe(true);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retryable', reasons: ['project-busy'] });
      release();
      await busy;
      await revisit(cleanup);
      expect(fs.existsSync(manifestPath(project))).toBe(false);
    });
  });

  // ── replacement race ──────────────────────────────────────────────────

  describe('replacement race', () => {
    function replaceBeforeRename(project, replace) {
      const realRename = fs.renameSync.bind(fs);
      let replaced = false;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (!replaced && from === manifestPath(project)) {
          replaced = true;
          replace();
        }
        return realRename(from, to);
      });
    }

    function withZeroFileIds() {
      const realLstat = fs.lstatSync.bind(fs);
      const realFstat = fs.fstatSync.bind(fs);
      vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => zeroIdentity(realLstat(...args)));
      vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => zeroIdentity(realFstat(...args)));
    }

    const scenarios = {
      'a new file': (project, bytes) => () => { fs.unlinkSync(manifestPath(project)); fs.writeFileSync(manifestPath(project), bytes); },
      'rewritten in place': (project, bytes) => () => fs.writeFileSync(manifestPath(project), bytes),
    };

    for (const zeroIds of [false, true]) {
      for (const [label, makeReplace] of Object.entries(scenarios)) {
        it(`keeps a replacement (${label}${zeroIds ? ', zero file IDs' : ''})`, async () => {
          const project = createProject(`Race ${label} ${zeroIds}`);
          const replacement = formatManifestJson(legacyManifest(project, { title: 'Written meanwhile' }));
          if (zeroIds) withZeroFileIds();
          replaceBeforeRename(project, makeReplace(project, replacement));

          await runCleanup();

          expect(fs.readFileSync(manifestPath(project), 'utf8')).toBe(replacement);
          expect(listRoot(project).filter(isLegacyManifestCleanupQuarantineName)).toEqual([]);
          expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retryable', reasons: ['manifest-changed'] });
        });
      }
    }

    it('removes a proven duplicate with zero file IDs when nothing changed', async () => {
      const project = createProject('Zero IDs');
      withZeroFileIds();
      await runCleanup();
      expect(fs.existsSync(manifestPath(project))).toBe(false);
    });

    it('then judges the replacement on its own merits (divergent → retained)', async () => {
      const project = createProject('Race then judge');
      const replacement = formatManifestJson(legacyManifest(project, { title: 'Written meanwhile' }));
      replaceBeforeRename(project, () => fs.writeFileSync(manifestPath(project), replacement));
      const cleanup = await runCleanup();
      vi.restoreAllMocks();
      await revisit(cleanup);
      expect(fs.readFileSync(manifestPath(project), 'utf8')).toBe(replacement);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retained', reasons: ['manifest-divergent'] });
    });
  });

  // ── ownership not ready ───────────────────────────────────────────────

  describe('ownership not ready', () => {
    const states = {
      unbound: [(p) => db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(p.id), 'unbound'],
      pending: [(p) => db.prepare("UPDATE project_directory_ownership SET state = 'pending' WHERE project_id = ?").run(p.id), 'pending'],
      'recovery-required': [(p) => adoptionRepository.setClassification(p.id, { status: 'recovery-required', reason: 'manifest-missing' }), 'ownership-recovery-required'],
      'retryable ownership': [(p) => adoptionRepository.setClassification(p.id, { status: 'retryable', reason: 'marker-unavailable' }), 'ownership-retryable'],
      'marker mismatch': [(p) => fs.writeFileSync(markerPath(p), `creatorcrate-owner/1 ${'a'.repeat(64)}\n`), 'marker-mismatch'],
      'marker missing': [(p) => fs.unlinkSync(markerPath(p)), 'marker-missing'],
    };

    for (const [label, [apply, reason]] of Object.entries(states)) {
      it(`never deletes while ownership is ${label}, and reconsiders once bound`, async () => {
        const project = createProject(`Not ready ${label}`);
        const bytes = fs.readFileSync(manifestPath(project));
        const ownership = ownershipRepository.findByProjectId(project.id);
        const marker = fs.readFileSync(markerPath(project));
        apply(project);

        const cleanup = await runCleanup();
        expect(fs.readFileSync(manifestPath(project))).toEqual(bytes);
        expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'ownership-not-ready', reasons: [reason] });
        expect(cleanup.readiness().current.ownershipNotReady).toBe(1);

        // Ownership established (by adoption/recovery in real life).
        db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(project.id);
        db.prepare("INSERT INTO project_directory_ownership (project_id, token, state) VALUES (?, ?, 'bound')")
          .run(project.id, ownership.token);
        fs.writeFileSync(markerPath(project), marker);
        adoptionRepository.setClassification(project.id, null);

        await revisit(cleanup);
        expect(fs.existsSync(manifestPath(project))).toBe(false);
        expect(cleanupRepository.getEntry(project.id)).toBeNull();
      });
    }

    it('waits for the ownership adoption pass before doing anything', async () => {
      const project = createProject('Adoption running');
      adoptionRepository.initialize(); // running, not complete
      const cleanup = await runCleanup(createCleanup(), { adopt: false });
      expect(fs.existsSync(manifestPath(project))).toBe(true);
      expect(cleanup.readiness().pass).toMatchObject({ phase: 'running', cursor: 0 });
      expect(timers.at(-1).delay).toBe(5_000);

      adoptionRepository.complete();
      timers.at(-1).callback();
      await cleanup.waitForIdle();
      expect(fs.existsSync(manifestPath(project))).toBe(false);
    });
  });

  // ── temp manifests ────────────────────────────────────────────────────

  describe('legacy temp manifests', () => {
    const TEMP = '.0123456789ab.project.json.tmp';

    it('removes a temp equivalent to current DB state', async () => {
      const project = createProject('Temp equal', { manifest: false });
      writeManifest(project, legacyManifest(project), TEMP);
      const cleanup = await runCleanup();
      expect(listRoot(project)).not.toContain(TEMP);
      expect(cleanup.readiness().counts).toMatchObject({ tempRemoved: 1, removed: 0 });
    });

    it('removes both an equivalent final manifest and its equivalent temp', async () => {
      const project = createProject('Temp and final');
      writeManifest(project, legacyManifest(project), TEMP);
      const cleanup = await runCleanup();
      expect(listRoot(project).filter((name) => name.includes('project.json'))).toEqual([]);
      expect(cleanup.readiness().counts).toMatchObject({ tempRemoved: 1, removed: 1 });
    });

    it('retains a temp that differs from current DB state, even when the final is removed', async () => {
      const project = createProject('Temp differs');
      const bytes = writeManifest(project, legacyManifest(project, { notes: 'Unsaved notes' }), TEMP);
      await runCleanup();
      expect(fs.existsSync(manifestPath(project))).toBe(false);
      expect(fs.readFileSync(path.join(dirOf(project), TEMP), 'utf8')).toBe(bytes);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retained', reasons: ['temp-divergent'] });
    });

    it('retains a malformed (partially written) temp', async () => {
      const project = createProject('Temp partial', { manifest: false });
      const partial = formatManifestJson(legacyManifest(project)).slice(0, 40);
      writeManifest(project, partial, TEMP);
      await runCleanup();
      expect(fs.readFileSync(path.join(dirOf(project), TEMP), 'utf8')).toBe(partial);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retained', reasons: ['temp-malformed'] });
    });

    it('retains an unreadable temp as retryable', async () => {
      const project = createProject('Temp unreadable', { manifest: false });
      writeManifest(project, legacyManifest(project), TEMP);
      const realOpen = fs.openSync.bind(fs);
      vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        if (path.basename(String(target)) === TEMP) throw eio(target);
        return realOpen(target, ...rest);
      });
      await runCleanup();
      expect(listRoot(project)).toContain(TEMP);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retryable', reasons: ['temp-unavailable'] });
    });

    it('never touches similarly named or arbitrary user files, even with duplicate content', async () => {
      const project = createProject('Lookalikes', { manifest: false });
      const content = formatManifestJson(legacyManifest(project));
      const lookalikes = [
        '.abc.project.json.tmp', // not 12 hex digits
        '.0123456789AB.project.json.tmp', // uppercase hex
        '.0123456789ab.project.json.tmp.bak',
        'project.json.tmp',
        'project.json.bak',
        'Project.json.old',
        'old-project.json',
        'custom.json',
        '.project.json.cleanup-notours',
      ];
      for (const name of lookalikes) fs.writeFileSync(path.join(dirOf(project), name), content);
      const nested = path.join(dirOf(project), 'nested');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, MANIFEST_FILENAME), content);

      const cleanup = await runCleanup();

      for (const name of lookalikes) {
        expect(fs.readFileSync(path.join(dirOf(project), name), 'utf8')).toBe(content);
      }
      expect(fs.readFileSync(path.join(nested, MANIFEST_FILENAME), 'utf8')).toBe(content);
      expect(cleanup.readiness().counts).toMatchObject({ removed: 0, tempRemoved: 0, noManifest: 1 });
    });
  });

  // ── unrelated JSON ────────────────────────────────────────────────────

  it('leaves generated publication JSON under APP_DATA_ROOT untouched', async () => {
    const project = createProject('Previews');
    const previewDir = path.join(tmpDir, 'previews', String(project.id), 'asset', 'rev-1');
    fs.mkdirSync(previewDir, { recursive: true });
    const currentJson = path.join(tmpDir, 'previews', String(project.id), 'asset', 'current.json');
    fs.writeFileSync(currentJson, '{"revision":"rev-1"}\n');
    fs.writeFileSync(path.join(previewDir, 'meta.json'), '{"meta":1}\n');
    await runCleanup();
    expect(fs.readFileSync(currentJson, 'utf8')).toBe('{"revision":"rev-1"}\n');
    expect(fs.readFileSync(path.join(previewDir, 'meta.json'), 'utf8')).toBe('{"meta":1}\n');
  });

  // ── dry run ───────────────────────────────────────────────────────────

  describe('dry run', () => {
    it('classifies with the same predicate and deletes nothing', async () => {
      const dup = createProject('Would remove');
      const divergent = createProject('Divergent', { manifest: false });
      writeManifest(divergent, legacyManifest(divergent, { title: 'Old' }));
      const invalid = createProject('Invalid', { manifest: false });
      writeManifest(invalid, '{');
      const none = createProject('None', { manifest: false });
      const unbound = createProject('Unbound');
      db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(unbound.id);
      const offline = createProject('Offline');
      const before = [dup, divergent, invalid, unbound, offline].map((p) => fs.readFileSync(manifestPath(p)));
      const appMetaBefore = db.prepare('SELECT * FROM app_meta ORDER BY key').all();
      const realOpen = fs.openSync.bind(fs);
      const spy = vi.spyOn(fs, 'openSync').mockImplementation((target, ...rest) => {
        if (target === manifestPath(offline)) throw eio(target);
        return realOpen(target, ...rest);
      });

      const result = await createCleanup().dryRun();
      spy.mockRestore();

      const byId = Object.fromEntries(result.projects.map((p) => [p.projectId, p.classification]));
      expect(byId).toEqual({
        [dup.id]: 'would-remove',
        [divergent.id]: 'retain-divergent',
        [invalid.id]: 'retain-invalid',
        [none.id]: 'no-manifest',
        [unbound.id]: 'ownership-not-ready',
        [offline.id]: 'retry',
      });
      expect(result.summary).toMatchObject({ 'would-remove': 1, 'retain-divergent': 1, 'retain-invalid': 1, 'no-manifest': 1, 'ownership-not-ready': 1, retry: 1 });
      expect([dup, divergent, invalid, unbound, offline].map((p) => fs.readFileSync(manifestPath(p)))).toEqual(before);
      expect(db.prepare('SELECT * FROM app_meta ORDER BY key').all()).toEqual(appMetaBefore);
      expect(JSON.stringify(result)).not.toContain(projectsRoot);
    });
  });

  // ── fresh authoritative state ─────────────────────────────────────────

  describe('fresh authoritative state per project', () => {
    /** Cleanup whose first page fetch is followed by `edit` (a user edit landing before evaluation). */
    function cleanupEditingAfterPage(edit) {
      let edited = false;
      return createCleanup({
        repository: {
          ...cleanupRepository,
          page: (...args) => {
            const rows = cleanupRepository.page(...args);
            if (!edited && rows.length) { edited = true; edit(rows); }
            return rows;
          },
        },
      });
    }

    const edits = {
      notes: (id) => db.prepare('UPDATE projects SET notes = ? WHERE id = ?').run('Edited after page fetch', id),
      description: (id) => db.prepare('UPDATE projects SET description = ? WHERE id = ?').run('Edited description', id),
      title: (id) => db.prepare('UPDATE projects SET title = ? WHERE id = ?').run('Edited title', id),
      'category label': (id) => db.prepare(`UPDATE project_asset_categories SET display_name = ?
        WHERE id = (SELECT id FROM project_asset_categories WHERE project_id = ? ORDER BY display_order, id LIMIT 1)`)
        .run('Edited label', id),
    };

    for (const [label, edit] of Object.entries(edits)) {
      it(`retains a manifest whose ${label} changed in SQLite after the page was fetched`, async () => {
        const a = createProject('Page A');
        const b = createProject('Page B');
        const bytes = fs.readFileSync(manifestPath(b), 'utf8');
        let paged = null;
        let edited = null;
        const cleanup = cleanupEditingAfterPage((rows) => {
          paged = rows.find((row) => row.id === b.id);
          edit(b.id);
          edited = sqliteState();
        });

        await runCleanup(cleanup);

        expect(paged).toMatchObject({ title: b.title, notes: b.notes, description: b.description }); // stale row
        expect(fs.existsSync(manifestPath(a))).toBe(false);
        expect(fs.readFileSync(manifestPath(b), 'utf8')).toBe(bytes);
        expect(cleanupRepository.getEntry(b.id)).toMatchObject({ status: 'retained', reasons: ['manifest-divergent'] });
        expect(sqliteState()).toEqual(edited); // the edit stands; nothing imported
        expect(cleanup.readiness()).toMatchObject({ passComplete: true, counts: { removed: 1 } });
      });
    }

    it('skips a project deleted after the page was fetched and still advances the cursor', async () => {
      const a = createProject('Deleted later');
      const b = createProject('Survivor');
      const bytes = fs.readFileSync(manifestPath(a), 'utf8');
      const cleanup = cleanupEditingAfterPage(() => {
        db.pragma('foreign_keys = OFF');
        db.prepare('DELETE FROM projects WHERE id = ?').run(a.id);
        db.pragma('foreign_keys = ON');
      });
      await runCleanup(cleanup);
      expect(fs.readFileSync(manifestPath(a), 'utf8')).toBe(bytes);
      expect(fs.existsSync(manifestPath(b))).toBe(false);
      expect(cleanupRepository.getEntry(a.id)).toBeNull();
      expect(cleanup.readiness()).toMatchObject({ passComplete: true, counts: { removed: 1, noManifest: 0, notRequired: 0 } });
    });

    it('retains the reviewer reproduction updatedAt 2025-99-99T99:99:99.000Z', async () => {
      const project = createProject('Impossible updatedAt', { manifest: false });
      const bytes = writeManifest(project, legacyManifest(project, { updatedAt: '2025-99-99T99:99:99.000Z' }));
      await runCleanup();
      expect(fs.readFileSync(manifestPath(project), 'utf8')).toBe(bytes);
      expect(cleanupRepository.getEntry(project.id)).toMatchObject({ status: 'retained', reasons: ['manifest-divergent'] });
    });
  });

  // ── lifecycle ─────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('resumes an interrupted pass from its committed cursor after restart', async () => {
      const projects = [createProject('One'), createProject('Two'), createProject('Three')];
      let steps = 0;
      const tracker = { begin: () => (++steps > 1 ? null : { complete() {} }) };
      const first = await runCleanup(createCleanup({ managedUploadTracker: tracker }));
      first.stop();
      expect(first.readiness().pass).toMatchObject({ phase: 'running', cursor: projects[0].id });
      expect(fs.existsSync(manifestPath(projects[0]))).toBe(false);
      expect(fs.existsSync(manifestPath(projects[1]))).toBe(true);

      const restarted = await runCleanup(createCleanup());
      expect(projects.every((p) => !fs.existsSync(manifestPath(p)))).toBe(true);
      expect(restarted.readiness()).toMatchObject({ passComplete: true, counts: { removed: 3 } });
    });

    it('does not revisit completed or retained projects on later runs', async () => {
      const done = createProject('Done');
      const kept = createProject('Kept', { manifest: false });
      writeManifest(kept, legacyManifest(kept, { title: 'Old' }));
      const cleanup = await runCleanup();
      expect(timers).toEqual([]); // nothing left to revisit: no timer

      const spy = vi.spyOn(fs, 'readdirSync');
      await revisit(cleanup);
      expect(spy).not.toHaveBeenCalled();
      expect(fs.existsSync(manifestPath(done))).toBe(false);
      expect(fs.existsSync(manifestPath(kept))).toBe(true);
    });

    it('does not run while paused for maintenance', async () => {
      const project = createProject('Paused');
      completeAdoptionPass();
      const cleanup = createCleanup({ maintenanceState: { active: true } });
      cleanup.prepare();
      cleanup.signal();
      await cleanup.waitForIdle();
      expect(fs.existsSync(manifestPath(project))).toBe(true);
    });

    it('never stores paths or manifest content in lifecycle state', async () => {
      const project = createProject('Private', { manifest: false });
      writeManifest(project, legacyManifest(project, { notes: 'secret historical notes' }));
      await runCleanup();
      const meta = JSON.stringify(db.prepare("SELECT * FROM app_meta WHERE key GLOB 'legacy_manifest_cleanup*'").all());
      expect(meta).not.toContain('secret');
      expect(meta).not.toContain(projectsRoot);
      expect(JSON.stringify(logs)).not.toContain('secret');
    });
  });
});

// ── restoration rollback identity (primitive) ───────────────────────────

describe('PM-2 restoration rollback never deletes an unproven destination', () => {
  let dir;
  let manifest;
  const original = '{"original":true}\n';
  const foreign = '{"foreign":"replacement"}\n';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-legacy-manifest-rollback-'));
    manifest = path.join(dir, MANIFEST_FILENAME);
    fs.writeFileSync(manifest, original);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const quarantines = () => fs.readdirSync(dir).filter(isLegacyManifestCleanupQuarantineName);

  /**
   * Force the no-link exclusive-copy restore: the quarantine re-verification
   * fails once (EIO), link(2) is unsupported, and `afterCopyClosed(state)`
   * runs as soon as the operation's own copy is written and closed, before
   * that copy is verified. Setting `state.failNextDestinationOpen` makes the
   * copy's verification read fail once; `state.verificationFailed` records
   * that it did.
   */
  function forceExclusiveCopyRestore(afterCopyClosed) {
    const evidence = inspectLegacyManifestEntry(manifest).evidence;
    const realOpen = fs.openSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    const realFstat = fs.fstatSync.bind(fs);
    const state = { copyIdentity: null, failNextDestinationOpen: false, verificationFailed: false };
    let failedQuarantine = false;
    let copyFd = null;
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: link not supported'), { code: 'EPERM' });
    });
    vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
      if (!failedQuarantine && isLegacyManifestCleanupQuarantineName(path.basename(String(target)))) {
        failedQuarantine = true;
        throw eio(target);
      }
      if (state.failNextDestinationOpen && target === manifest) {
        state.failNextDestinationOpen = false;
        state.verificationFailed = true;
        throw eio(target);
      }
      const fd = realOpen(target, flags, ...rest);
      if (target === manifest && typeof flags === 'number' && (flags & fs.constants.O_EXCL)) copyFd = fd;
      return fd;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      if (fd !== copyFd) return realClose(fd);
      state.copyIdentity = realFstat(fd, { bigint: true });
      realClose(fd);
      copyFd = null;
      afterCopyClosed(state);
      return undefined;
    });
    return { evidence, state };
  }

  function replaceWithForeign({ zeroIds }) {
    return () => {
      fs.unlinkSync(manifest);
      fs.writeFileSync(manifest, foreign);
      if (!zeroIds) return;
      // From here on the share reports no usable file ID (SMB).
      const realLstat = fs.lstatSync.bind(fs);
      const realFstat = fs.fstatSync.bind(fs);
      vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => zeroIdentity(realLstat(...args)));
      vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => zeroIdentity(realFstat(...args)));
    };
  }

  it('keeps a foreign replacement that reports a zero file ID, and the quarantined original', () => {
    const unlink = vi.spyOn(fs, 'unlinkSync');
    const { evidence, state } = forceExclusiveCopyRestore(replaceWithForeign({ zeroIds: true }));

    const result = removeProvenLegacyManifestEntry(dir, MANIFEST_FILENAME, evidence);

    expect(state.copyIdentity.ino > 0n).toBe(true); // the operation's own copy had a known ID
    expect(fs.readFileSync(manifest, 'utf8')).toBe(foreign);
    // The only unlink of the destination is the simulated foreign actor's own.
    expect(unlink.mock.calls.filter(([target]) => String(target) === manifest)).toHaveLength(1);
    expect(quarantines()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, quarantines()[0]), 'utf8')).toBe(original);
    expect(result).toEqual({ status: 'unavailable', retained: true });
  });

  it('keeps a foreign replacement whose known file ID differs', () => {
    const { evidence } = forceExclusiveCopyRestore(replaceWithForeign({ zeroIds: false }));
    const result = removeProvenLegacyManifestEntry(dir, MANIFEST_FILENAME, evidence);
    expect(fs.readFileSync(manifest, 'utf8')).toBe(foreign);
    expect(quarantines()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, quarantines()[0]), 'utf8')).toBe(original);
    expect(result).toEqual({ status: 'unavailable', retained: true });
  });

  for (const zeroIds of [false, true]) {
    it(`retains its own unverified copy and the quarantined original${zeroIds ? ' (zero file IDs)' : ''}`, () => {
      const unlink = vi.spyOn(fs, 'unlinkSync');
      const { evidence, state } = forceExclusiveCopyRestore((s) => {
        s.failNextDestinationOpen = true;
        if (!zeroIds) return;
        const realLstat = fs.lstatSync.bind(fs);
        const realFstat = fs.fstatSync.bind(fs);
        vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => zeroIdentity(realLstat(...args)));
        vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => zeroIdentity(realFstat(...args)));
      });

      const result = removeProvenLegacyManifestEntry(dir, MANIFEST_FILENAME, evidence);

      expect(state.verificationFailed).toBe(true);
      // Previously removed when both file IDs matched; now always retained.
      expect(fs.readFileSync(manifest, 'utf8')).toBe(original);
      expect(unlink.mock.calls.filter(([target]) => String(target) === manifest)).toHaveLength(0);
      expect(quarantines()).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, quarantines()[0]), 'utf8')).toBe(original);
      expect(result).toEqual({ status: 'unavailable', retained: true });
    });
  }

  it('keeps a foreign file that replaces the unverified copy right after an identity check', () => {
    // Reviewer reproduction: the old rollback lstat'ed the destination, saw
    // its own copy's (known, matching) file ID, and then unlinked the
    // pathname, deleting whatever had replaced the copy in between.
    const realUnlink = fs.unlinkSync.bind(fs);
    const realWrite = fs.writeFileSync.bind(fs);
    const unlink = vi.spyOn(fs, 'unlinkSync');
    let replaced = null;
    const replace = (when) => {
      realUnlink(manifest);
      realWrite(manifest, foreign);
      replaced = when;
    };
    const { evidence, state } = forceExclusiveCopyRestore((s) => {
      s.failNextDestinationOpen = true;
      const realLstat = fs.lstatSync.bind(fs);
      vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
        const stats = realLstat(target, ...rest);
        // The identity observation: it sees the operation's own copy, and
        // the destination is replaced immediately afterwards.
        if (!replaced && s.verificationFailed && String(target) === manifest) {
          expect(stats.ino).toBe(s.copyIdentity.ino);
          replace('after-identity-check');
        }
        return stats;
      });
    });

    const result = removeProvenLegacyManifestEntry(dir, MANIFEST_FILENAME, evidence);
    // Rollback no longer observes the destination at all; the foreign actor
    // then replaces it once rollback has returned, as a later pass would see.
    if (!replaced) replace('after-rollback');

    expect(state.verificationFailed).toBe(true);
    expect(state.copyIdentity.ino > 0n).toBe(true);
    expect(fs.readFileSync(manifest, 'utf8')).toBe(foreign);
    expect(unlink.mock.calls.filter(([target]) => String(target) === manifest)).toHaveLength(0);
    expect(quarantines()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, quarantines()[0]), 'utf8')).toBe(original);
    expect(result).toEqual({ status: 'unavailable', retained: true });
  });

  it('keeps a foreign file already present before the copy (no overwrite)', () => {
    const { evidence } = forceExclusiveCopyRestore(() => {});
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      realRename(from, to);
      fs.writeFileSync(manifest, foreign);
    });
    const result = removeProvenLegacyManifestEntry(dir, MANIFEST_FILENAME, evidence);
    expect(fs.readFileSync(manifest, 'utf8')).toBe(foreign);
    expect(quarantines()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, quarantines()[0]), 'utf8')).toBe(original);
    expect(result).toEqual({ status: 'unavailable', retained: true });
  });

  it('completes a verified copy restoration and drops the quarantined original', () => {
    const { evidence, state } = forceExclusiveCopyRestore(() => {});
    const result = removeProvenLegacyManifestEntry(dir, MANIFEST_FILENAME, evidence);
    expect(state.copyIdentity).not.toBeNull();
    expect(state.verificationFailed).toBe(false);
    expect(fs.readFileSync(manifest, 'utf8')).toBe(original);
    expect(quarantines()).toHaveLength(0);
    expect(result).toEqual({ status: 'unavailable', retained: false });
  });
});

// ── canonical legacy updatedAt ──────────────────────────────────────────

describe('PM-2 legacy updatedAt validation', () => {
  const project = {
    id: 7, title: 'T', slug: 't', description: 'd', notes: 'n', patreon_url: null,
    created_at: '2026-01-01 00:00:00', updated_at: '2026-03-01 12:00:00',
  };
  const judge = (updatedAt) => describeLegacyManifestDivergence(
    { ...serializeManifest(project, []), updatedAt }, project, [],
  );

  it('accepts an equal timestamp', () => expect(judge('2026-03-01T12:00:00.000Z')).toBeNull());

  it('accepts a canonical older timestamp (approved lagging-mirror exception)', () => {
    expect(judge('2025-06-01T08:30:00.000Z')).toBeNull();
    expect(judge('2024-02-29T23:59:59.999Z')).toBeNull(); // a real leap day
  });

  const rejected = {
    newer: '2026-03-01T12:00:00.001Z',
    'reviewer reproduction': '2025-99-99T99:99:99.000Z',
    'impossible month': '2025-13-01T00:00:00.000Z',
    'impossible day': '2025-02-30T12:00:00.000Z',
    'invalid leap day': '2023-02-29T00:00:00.000Z',
    'day 31 of a 30-day month': '2025-04-31T00:00:00.000Z',
    'impossible minute': '2025-01-01T23:60:00.000Z',
    'hour 24 (JS normalizes to the next day)': '2025-01-01T24:00:00.000Z',
    'missing milliseconds': '2025-06-01T08:30:00Z',
    'offset instead of Z': '2025-06-01T08:30:00.000+00:00',
    'lowercase z': '2025-06-01T08:30:00.000z',
    'expanded year': '+002025-06-01T08:30:00.000Z',
    'SQLite form': '2025-06-01 08:30:00',
    'date only': '2025-06-01',
    malformed: 'yesterday',
    empty: '',
  };
  for (const [label, value] of Object.entries(rejected)) {
    it(`retains ${label}: ${JSON.stringify(value)}`, () => expect(judge(value)).toBe('updatedAt'));
  }

  it('retains non-string values', () => {
    expect(judge(null)).toBe('updatedAt');
    expect(judge(Date.parse('2025-06-01T08:30:00.000Z'))).toBe('updatedAt');
  });
});
