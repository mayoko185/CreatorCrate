import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import {
  AssetProcessingScopeError,
  createAssetProcessingScopeService,
} from '../src/services/asset-processing-scope-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset processing scope service', () => {
  let tmpDir;
  let db;
  let assetRepository;
  let projectRepository;
  let scopeService;
  let projectId;
  let projectSequence;

  function createProject(title = `Scope Project ${projectSequence}`) {
    projectSequence += 1;
    return projectRepository.create({
      title,
      slug: `scope-project-${projectSequence}`,
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
  }

  function addAsset(ownerProjectId, relativePath, { isPresent = 1 } = {}) {
    const filename = relativePath.split('/').at(-1);
    const extension = filename.includes('.') ? filename.split('.').at(-1) : '';
    const asset = assetRepository.upsert(ownerProjectId, relativePath, {
      filename,
      extension,
      mimeType: 'application/octet-stream',
      sizeBytes: 100,
      modifiedAt: null,
    });
    if (isPresent === 0) {
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?')
        .run(asset.id);
    }
    return assetRepository.findById(asset.id);
  }

  function addReferenceAssets() {
    return {
      root: addAsset(projectId, 'root.png'),
      finalA: addAsset(projectId, 'Final/a.png'),
      finalB: addAsset(projectId, 'Final/b.webp'),
      subC: addAsset(projectId, 'Final/sub/c.png'),
      deeperD: addAsset(projectId, 'Final/sub/deeper/d.png'),
      otherE: addAsset(projectId, 'Other/e.png'),
    };
  }

  function assetSnapshot() {
    return JSON.stringify(db.prepare(`
      SELECT id, project_id, relative_path, is_present, last_seen_at, missing_since, updated_at
      FROM assets
      ORDER BY id ASC
    `).all());
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-scope-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    assetRepository = createAssetRepository(db);
    projectRepository = createProjectRepository(db);
    projectSequence = 0;
    projectId = createProject().id;
    scopeService = createAssetProcessingScopeService({ projectRepository, assetRepository });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves explicit selected order and returns full indexed records', () => {
    const first = addAsset(projectId, 'first.png');
    const second = addAsset(projectId, 'second.png');

    const resolved = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'selected',
      assetIds: [second.id, first.id],
    });

    expect(resolved.scope).toEqual({ type: 'selected', assetIds: [second.id, first.id] });
    expect(resolved.assetIds).toEqual([second.id, first.id]);
    expect(resolved.assets.map((asset) => asset.relative_path)).toEqual([
      'second.png',
      'first.png',
    ]);
  });

  it('rejects foreign, missing, and not-present explicit assets', () => {
    const foreignProject = createProject('Foreign Scope Project');
    const foreign = addAsset(foreignProject.id, 'foreign.png');
    const missing = addAsset(projectId, 'missing.png', { isPresent: 0 });

    expect(() => scopeService.resolveAssetProcessingScope(projectId, {
      type: 'selected', assetIds: [foreign.id],
    })).toThrow(AssetProcessingScopeError);
    expect(() => scopeService.resolveAssetProcessingScope(projectId, {
      type: 'selected', assetIds: [foreign.id],
    })).toThrow(expect.objectContaining({ code: 'ASSET_PROJECT_MISMATCH' }));
    expect(() => scopeService.resolveAssetProcessingScope(projectId, {
      type: 'selected', assetIds: [999999],
    })).toThrow(expect.objectContaining({ code: 'ASSET_NOT_FOUND' }));
    expect(() => scopeService.resolveAssetProcessingScope(projectId, {
      type: 'selected', assetIds: [missing.id],
    })).toThrow(expect.objectContaining({ code: 'ASSET_MISSING' }));
  });

  it('rejects invalid and duplicate selected IDs', () => {
    const asset = addAsset(projectId, 'asset.png');
    for (const assetId of [0, -1, 1.5, '1', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => scopeService.resolveAssetProcessingScope(projectId, {
        type: 'selected', assetIds: [assetId],
      })).toThrow(expect.objectContaining({ code: 'INVALID_ASSET_ID' }));
    }

    expect(() => scopeService.resolveAssetProcessingScope(projectId, {
      type: 'selected', assetIds: [asset.id, asset.id],
    })).toThrow(expect.objectContaining({ code: 'DUPLICATE_ASSET_SELECTION' }));
    expect(() => scopeService.resolveAssetProcessingScope(projectId, {
      type: 'selected', assetIds: [],
    })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }));
  });

  it('maps Convert and Watermark non-recursive and recursive directory scopes', () => {
    addReferenceAssets();

    const nonRecursive = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Final', recursive: false,
    });
    const recursive = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Final', recursive: true,
    });

    expect(nonRecursive.assets.map((asset) => asset.relative_path)).toEqual([
      'Final/a.png',
      'Final/b.webp',
    ]);
    expect(recursive.assets.map((asset) => asset.relative_path)).toEqual([
      'Final/a.png',
      'Final/b.webp',
      'Final/sub/c.png',
      'Final/sub/deeper/d.png',
    ]);
  });

  it('resolves nested directories and normalizes Windows separators', () => {
    addReferenceAssets();

    const nonRecursive = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Final\\sub', recursive: false,
    });
    const recursive = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Final\\sub', recursive: true,
    });

    expect(nonRecursive.scope.relativePath).toBe('Final/sub');
    expect(nonRecursive.assets.map((asset) => asset.relative_path)).toEqual(['Final/sub/c.png']);
    expect(recursive.assets.map((asset) => asset.relative_path)).toEqual([
      'Final/sub/c.png',
      'Final/sub/deeper/d.png',
    ]);
  });

  it('resolves root non-recursively and recursively using deterministic repository order', () => {
    addReferenceAssets();

    const root = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: '', recursive: false,
    });
    const project = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: '', recursive: true,
    });

    expect(root.assets.map((asset) => asset.relative_path)).toEqual(['root.png']);
    expect(project.assets.map((asset) => asset.relative_path)).toEqual([
      'Final/a.png',
      'Final/b.webp',
      'Final/sub/c.png',
      'Final/sub/deeper/d.png',
      'Other/e.png',
      'root.png',
    ]);
  });

  it('uses directory boundaries for prefix safety', () => {
    addReferenceAssets();
    const finalized = addAsset(projectId, 'Finalized/foo.png');
    const submarine = addAsset(projectId, 'Final/submarine/g.png');

    const finalDirect = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Final', recursive: false,
    });
    const nestedRecursive = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Final/sub', recursive: true,
    });

    expect(finalDirect.assetIds).not.toContain(finalized.id);
    expect(nestedRecursive.assetIds).not.toContain(submarine.id);
    expect(nestedRecursive.assets.map((asset) => asset.relative_path)).toEqual([
      'Final/sub/c.png',
      'Final/sub/deeper/d.png',
    ]);
  });

  it('returns empty results for valid missing directories and excludes missing rows', () => {
    addReferenceAssets();
    const missing = addAsset(projectId, 'Final/missing.png', { isPresent: 0 });

    const empty = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Does/not/exist', recursive: true,
    });
    const final = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Final', recursive: true,
    });

    expect(empty.assets).toEqual([]);
    expect(final.assetIds).not.toContain(missing.id);
  });

  it('rejects absolute, traversal, malformed, and non-boolean directory scopes', () => {
    const invalidScopes = [
      { type: 'directory', relativePath: '../Other' },
      { type: 'directory', relativePath: 'Final/../Other' },
      { type: 'directory', relativePath: 'Final\\..\\Other' },
      { type: 'directory', relativePath: 'Final//sub' },
      { type: 'directory', relativePath: '/home/user/project' },
      { type: 'directory', relativePath: 'C:\\project\\Final' },
      { type: 'directory', relativePath: 'Final', recursive: 'yes' },
      { type: 'directory', recursive: false },
      { type: 'mixed', entries: [] },
      { type: 'mixed', entries: [{ type: 'directory', relativePath: '.' }] },
      { type: 'mixed', entries: [{ type: 'unknown', value: 1 }] },
      null,
      [],
    ];

    for (const scope of invalidScopes) {
      expect(() => scopeService.resolveAssetProcessingScope(projectId, scope))
        .toThrow(AssetProcessingScopeError);
    }
  });

  it('maps Workflow Prompt Editor mixed inputs in entry order with stable first-occurrence deduplication', () => {
    const root = addAsset(projectId, 'root.png');
    const finalA = addAsset(projectId, 'Final/a.png');
    const finalB = addAsset(projectId, 'Final/b.webp');
    const subC = addAsset(projectId, 'Final/sub/c.png');
    const deeperD = addAsset(projectId, 'Final/sub/deeper/d.png');

    const resolved = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'mixed',
      entries: [
        { type: 'asset', assetId: subC.id },
        { type: 'directory', relativePath: 'Final', recursive: false },
        { type: 'directory', relativePath: 'Final/sub', recursive: true },
        { type: 'asset', assetId: finalA.id },
        { type: 'asset', assetId: root.id },
      ],
    });

    expect(resolved.assetIds).toEqual([
      subC.id,
      finalA.id,
      finalB.id,
      deeperD.id,
      root.id,
    ]);
    expect(new Set(resolved.assetIds).size).toBe(resolved.assetIds.length);
  });

  it('does not filter directory scopes by operation type', () => {
    const kra = addAsset(projectId, 'Final/reference.kra');

    const resolved = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Final', recursive: false,
    });

    expect(resolved.assetIds).toEqual([kra.id]);
    expect(resolved.assets[0].extension).toBe('kra');
  });

  it('is read-only for both the database and filesystem', () => {
    const marker = path.join(tmpDir, 'marker.txt');
    fs.writeFileSync(marker, 'unchanged');
    addReferenceAssets();
    const beforeDatabase = assetSnapshot();
    const beforeFiles = fs.readdirSync(tmpDir).sort();

    const resolved = scopeService.resolveAssetProcessingScope(projectId, {
      type: 'directory', relativePath: 'Final', recursive: true,
    });

    expect(resolved.assets).toHaveLength(4);
    expect(assetSnapshot()).toBe(beforeDatabase);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(beforeFiles);
    expect(fs.readFileSync(marker, 'utf8')).toBe('unchanged');
  });
});
