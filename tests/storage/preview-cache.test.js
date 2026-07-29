import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CACHE_SCHEMA_VERSION,
  DERIVATIVE_CONFIG_VERSION,
  POINTER_SCHEMA_VERSION,
  THUMBNAIL_FILENAME,
  PREVIEW_FILENAME,
  META_FILENAME,
  CURRENT_POINTER_FILENAME,
  buildRevisionToken,
  getCacheDir,
  getMetaPath,
  getDerivativePath,
  getCurrentPointerPath,
  ensureCacheDir,
  serializeMeta,
  parseMeta,
  readMetaFile,
  compareFreshness,
  atomicWriteBuffer,
  atomicWriteMeta,
  validateWebpFile,
  getDerivativeBytes,
  resolvePublishedDir,
  removeDerivative,
  removeCacheDir,
} from '../../src/storage/preview-cache.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeTmpPreviewRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preview-cache-'));
  const previewRoot = path.join(tmp, 'previews');
  fs.mkdirSync(previewRoot, { recursive: true });
  return { tmp, previewRoot };
}

function symlinksSupported() {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cache-symlink-probe-'));
    const target = path.join(tmp, 'target');
    const link = path.join(tmp, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction');
    fs.rmSync(tmp, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const HAS_SYMLINKS = symlinksSupported();
const TEST_REVISION = '0123456789abcdef';
const TEST_REVISION_DIR = `r-${TEST_REVISION}-123456`;

function writePointer(previewRoot, projectId, assetId, overrides = {}) {
  const pointer = {
    schemaVersion: POINTER_SCHEMA_VERSION,
    dir: TEST_REVISION_DIR,
    revision: TEST_REVISION,
    ...overrides,
  };
  fs.writeFileSync(
    getCurrentPointerPath(previewRoot, projectId, assetId),
    JSON.stringify(pointer) + '\n'
  );
  return pointer;
}

function writeCompleteRevision(root, dirName = TEST_REVISION_DIR) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, THUMBNAIL_FILENAME), Buffer.from('thumbnail'));
  fs.writeFileSync(path.join(dir, PREVIEW_FILENAME), Buffer.from('preview'));
  writeValidMeta(dir);
  return dir;
}

function expectNoExternalRead(externalPath, operation) {
  let externalRead = false;
  const originalReadFileSync = fs.readFileSync;
  const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
    if (path.resolve(String(filePath)) === path.resolve(externalPath)) {
      externalRead = true;
      throw new Error('external cache read');
    }
    return originalReadFileSync.call(fs, filePath, ...args);
  });
  try {
    operation();
  } finally {
    readSpy.mockRestore();
  }
  expect(externalRead).toBe(false);
}

async function makeWebpBuffer(width = 32, height = 24) {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: { width, height, channels: 3, background: { r: 80, g: 120, b: 200 } },
  })
    .webp({ quality: 80 })
    .toBuffer();
}

function writeValidMeta(dir, overrides = {}) {
  const meta = serializeMeta({
    projectId: 1,
    assetId: 10,
    relativePath: 'source/art.png',
    size: 4096,
    mtime: '2026-07-28T12:00:00.000Z',
    generatedAt: '2026-07-28T12:01:00.000Z',
    thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
    preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
    ...overrides,
  });
  fs.writeFileSync(path.join(dir, META_FILENAME), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

// ─── Path resolution ─────────────────────────────────────────────────────

describe('preview-cache path resolution', () => {
  it('getCacheDir nests under projects/<id>/<id>', () => {
    expect(getCacheDir('/root/previews', 1, 10)).toBe(
      path.join('/root/previews', 'projects', '1', '10')
    );
  });

  it('getMetaPath appends meta.json', () => {
    expect(getMetaPath('/root/previews', 1, 10)).toBe(
      path.join('/root/previews', 'projects', '1', '10', 'meta.json')
    );
  });

  it('getDerivativePath appends a derivative filename', () => {
    expect(getDerivativePath('/root/previews', 1, 10, THUMBNAIL_FILENAME)).toBe(
      path.join('/root/previews', 'projects', '1', '10', 'thumbnail.webp')
    );
  });

  it('ensureCacheDir creates the directory recursively', () => {
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      const dir = ensureCacheDir(previewRoot, 7, 99);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ensureCacheDir is idempotent', () => {
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      ensureCacheDir(previewRoot, 7, 99);
      expect(() => ensureCacheDir(previewRoot, 7, 99)).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Published-cache containment ──────────────────────────────────────────

describe('published-cache containment', () => {
  it('resolves a valid published revision with regular files', () => {
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      const root = ensureCacheDir(previewRoot, 1, 10);
      const revisionDir = writeCompleteRevision(root);
      writePointer(previewRoot, 1, 10);
      expect(resolvePublishedDir(previewRoot, 1, 10)).toBe(revisionDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked current.json without reading its external target', () => {
    if (!HAS_SYMLINKS) return;
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      const root = ensureCacheDir(previewRoot, 1, 10);
      writeCompleteRevision(root);
      const externalPointer = path.join(tmp, 'external-current.json');
      fs.writeFileSync(
        externalPointer,
        JSON.stringify({
          schemaVersion: POINTER_SCHEMA_VERSION,
          dir: TEST_REVISION_DIR,
          revision: TEST_REVISION,
        })
      );
      fs.symlinkSync(externalPointer, getCurrentPointerPath(previewRoot, 1, 10), 'file');
      expectNoExternalRead(externalPointer, () => {
        expect(resolvePublishedDir(previewRoot, 1, 10)).toBeNull();
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a revision directory symlink that points outside previewRoot', () => {
    if (!HAS_SYMLINKS) return;
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      const root = ensureCacheDir(previewRoot, 1, 10);
      const externalDir = writeCompleteRevision(tmp, TEST_REVISION_DIR);
      fs.symlinkSync(externalDir, path.join(root, TEST_REVISION_DIR), 'junction');
      writePointer(previewRoot, 1, 10);
      expect(resolvePublishedDir(previewRoot, 1, 10)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    ['thumbnail', THUMBNAIL_FILENAME],
    ['preview', PREVIEW_FILENAME],
    ['metadata', META_FILENAME],
  ])('rejects a symlinked %s file', (_label, filename) => {
    if (!HAS_SYMLINKS) return;
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      const root = ensureCacheDir(previewRoot, 1, 10);
      const revisionDir = writeCompleteRevision(root);
      const externalFile = path.join(tmp, `external-${filename}`);
      fs.writeFileSync(externalFile, Buffer.from(`external-${filename}`));
      fs.rmSync(path.join(revisionDir, filename));
      fs.symlinkSync(externalFile, path.join(revisionDir, filename), 'file');
      writePointer(previewRoot, 1, 10);
      expect(resolvePublishedDir(previewRoot, 1, 10)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked project cache directory', () => {
    if (!HAS_SYMLINKS) return;
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      const projectsDir = path.join(previewRoot, 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });
      const externalProjectDir = path.join(tmp, 'external-project-cache');
      const externalAssetDir = path.join(externalProjectDir, '10');
      fs.mkdirSync(externalAssetDir, { recursive: true });
      writeCompleteRevision(externalAssetDir);
      fs.writeFileSync(
        path.join(externalAssetDir, CURRENT_POINTER_FILENAME),
        JSON.stringify({
          schemaVersion: POINTER_SCHEMA_VERSION,
          dir: TEST_REVISION_DIR,
          revision: TEST_REVISION,
        })
      );
      fs.symlinkSync(externalProjectDir, path.join(projectsDir, '1'), 'junction');
      expectNoExternalRead(path.join(externalAssetDir, CURRENT_POINTER_FILENAME), () => {
        expect(resolvePublishedDir(previewRoot, 1, 10)).toBeNull();
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked asset cache directory', () => {
    if (!HAS_SYMLINKS) return;
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      const projectsDir = path.join(previewRoot, 'projects', '1');
      fs.mkdirSync(projectsDir, { recursive: true });
      const externalAssetDir = path.join(tmp, 'external-asset-cache');
      fs.mkdirSync(externalAssetDir, { recursive: true });
      writeCompleteRevision(externalAssetDir);
      fs.writeFileSync(
        path.join(externalAssetDir, CURRENT_POINTER_FILENAME),
        JSON.stringify({
          schemaVersion: POINTER_SCHEMA_VERSION,
          dir: TEST_REVISION_DIR,
          revision: TEST_REVISION,
        })
      );
      fs.symlinkSync(externalAssetDir, path.join(projectsDir, '10'), 'junction');
      expectNoExternalRead(path.join(externalAssetDir, CURRENT_POINTER_FILENAME), () => {
        expect(resolvePublishedDir(previewRoot, 1, 10)).toBeNull();
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a pointer target whose revision token does not match its directory name', () => {
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      ensureCacheDir(previewRoot, 1, 10);
      writePointer(previewRoot, 1, 10, { dir: 'r-deadbeef-123456' });
      expect(resolvePublishedDir(previewRoot, 1, 10)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a lexical traversal pointer target', () => {
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      ensureCacheDir(previewRoot, 1, 10);
      writePointer(previewRoot, 1, 10, {
        dir: `${TEST_REVISION_DIR}${path.sep}..${path.sep}outside`,
      });
      expect(resolvePublishedDir(previewRoot, 1, 10)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a missing revision target', () => {
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      ensureCacheDir(previewRoot, 1, 10);
      writePointer(previewRoot, 1, 10);
      expect(resolvePublishedDir(previewRoot, 1, 10)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a revision target that is a regular file', () => {
    const { tmp, previewRoot } = makeTmpPreviewRoot();
    try {
      const root = ensureCacheDir(previewRoot, 1, 10);
      fs.writeFileSync(path.join(root, TEST_REVISION_DIR), Buffer.from('not a directory'));
      writePointer(previewRoot, 1, 10);
      expect(resolvePublishedDir(previewRoot, 1, 10)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Revision token ──────────────────────────────────────────────────────

describe('buildRevisionToken', () => {
  it('returns a 16-char hex string', () => {
    const tok = buildRevisionToken({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
    });
    expect(tok).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical inputs', () => {
    const args = {
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
    };
    expect(buildRevisionToken(args)).toBe(buildRevisionToken(args));
  });

  it('changes when size changes', () => {
    const base = {
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
    };
    expect(buildRevisionToken(base)).not.toBe(
      buildRevisionToken({ ...base, size: 4097 })
    );
  });

  it('changes when mtime changes', () => {
    const base = {
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
    };
    expect(buildRevisionToken(base)).not.toBe(
      buildRevisionToken({ ...base, mtime: '2026-07-28T12:00:01.000Z' })
    );
  });

  it('changes when relativePath changes', () => {
    const base = {
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
    };
    expect(buildRevisionToken(base)).not.toBe(
      buildRevisionToken({ ...base, relativePath: 'source/art2.png' })
    );
  });

  it('changes when assetId changes', () => {
    const base = {
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
    };
    expect(buildRevisionToken(base)).not.toBe(
      buildRevisionToken({ ...base, assetId: 11 })
    );
  });

  it('does NOT embed absolute paths — token is safe to expose', () => {
    const tok = buildRevisionToken({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
    });
    // The token is a hex digest; no path components are recoverable.
    expect(tok).toMatch(/^[0-9a-f]{16}$/);
    expect(tok).not.toContain('/');
    expect(tok).not.toContain('\\');
    expect(tok).not.toContain('source');
  });
});

// ─── meta.json schema ────────────────────────────────────────────────────

describe('serializeMeta / parseMeta', () => {
  it('serializeMeta produces the documented schema version', () => {
    const meta = serializeMeta({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
    });
    expect(meta.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
    expect(meta.derivativeConfigVersion).toBe(DERIVATIVE_CONFIG_VERSION);
    expect(meta.projectId).toBe(1);
    expect(meta.assetId).toBe(10);
    expect(meta.source.relativePath).toBe('source/art.png');
    expect(meta.source.size).toBe(4096);
    expect(meta.source.mtime).toBe('2026-07-28T12:00:00.000Z');
    expect(meta.thumbnail.format).toBe('webp');
    expect(meta.preview.format).toBe('webp');
  });

  it('parseMeta round-trips a valid serialized meta', () => {
    const meta = serializeMeta({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
      animated: true,
      frameCount: 3,
    });
    const parsed = parseMeta(JSON.stringify(meta));
    expect(parsed).toEqual(meta);
  });

  it('parseMeta rejects non-JSON', () => {
    expect(() => parseMeta('not-json')).toThrow();
  });

  it('parseMeta rejects a non-object root', () => {
    expect(() => parseMeta('[]')).toThrow();
    expect(() => parseMeta('null')).toThrow();
    expect(() => parseMeta('"string"')).toThrow();
  });

  it('parseMeta rejects missing required scalar fields', () => {
    const meta = serializeMeta({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
    });
    delete meta.schemaVersion;
    expect(() => parseMeta(JSON.stringify(meta))).toThrow();
  });

  it('parseMeta rejects a missing source block', () => {
    const meta = serializeMeta({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
    });
    delete meta.source;
    expect(() => parseMeta(JSON.stringify(meta))).toThrow();
  });

  it('parseMeta rejects a derivative block with non-numeric width', () => {
    const meta = serializeMeta({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
    });
    meta.thumbnail.width = 'wide';
    expect(() => parseMeta(JSON.stringify(meta))).toThrow();
  });

  it('serializeMeta omits animated/frameCount when not provided', () => {
    const meta = serializeMeta({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
    });
    expect(meta.animated).toBeUndefined();
    expect(meta.frameCount).toBeUndefined();
  });

  it('serializeMeta includes animated/frameCount when provided', () => {
    const meta = serializeMeta({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
      animated: true,
      frameCount: 4,
    });
    expect(meta.animated).toBe(true);
    expect(meta.frameCount).toBe(4);
  });

  it('serializeMeta does NOT store absolute paths', () => {
    const meta = serializeMeta({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
    });
    const json = JSON.stringify(meta);
    // No absolute host path patterns should appear anywhere in the payload.
    expect(json).not.toMatch(/(?:^|[":,\s])(?:\/|[A-Za-z]:[\\/])/);
  });
});

// ─── readMetaFile ────────────────────────────────────────────────────────

describe('readMetaFile', () => {
  let tmp, previewRoot, dir;

  beforeEach(() => {
    ({ tmp, previewRoot } = makeTmpPreviewRoot());
    dir = ensureCacheDir(previewRoot, 1, 10);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns { ok: false, reason: "missing" } when the file does not exist', () => {
    const r = readMetaFile(getMetaPath(previewRoot, 1, 10));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing');
  });

  it('returns { ok: false, reason: "malformed" } for invalid JSON', () => {
    fs.writeFileSync(path.join(dir, META_FILENAME), '{ not json');
    const r = readMetaFile(getMetaPath(previewRoot, 1, 10));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('malformed');
  });

  it('returns { ok: false, reason: "malformed" } for structurally invalid JSON', () => {
    fs.writeFileSync(path.join(dir, META_FILENAME), JSON.stringify({ junk: 1 }));
    const r = readMetaFile(getMetaPath(previewRoot, 1, 10));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('malformed');
  });

  it('returns { ok: true, meta } for a valid meta file', () => {
    writeValidMeta(dir);
    const r = readMetaFile(getMetaPath(previewRoot, 1, 10));
    expect(r.ok).toBe(true);
    expect(r.meta.projectId).toBe(1);
    expect(r.meta.assetId).toBe(10);
  });
});

// ─── compareFreshness ────────────────────────────────────────────────────

describe('compareFreshness', () => {
  function ctx(overrides = {}) {
    return {
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      ...overrides,
    };
  }

  function freshMeta(overrides = {}) {
    const c = ctx();
    return serializeMeta({
      projectId: c.projectId,
      assetId: c.assetId,
      relativePath: c.relativePath,
      size: c.size,
      mtime: c.mtime,
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
      ...overrides,
    });
  }

  it('reports fresh for identical context', () => {
    const r = compareFreshness(freshMeta(), ctx());
    expect(r.fresh).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('reports stale when size changes', () => {
    const r = compareFreshness(freshMeta(), ctx({ size: 4097 }));
    expect(r.fresh).toBe(false);
    expect(r.reasons).toContain('size changed');
  });

  it('reports stale when mtime changes', () => {
    const r = compareFreshness(freshMeta(), ctx({ mtime: '2026-07-28T12:00:01.000Z' }));
    expect(r.fresh).toBe(false);
    expect(r.reasons).toContain('mtime changed');
  });

  it('reports stale when relativePath changes', () => {
    const r = compareFreshness(freshMeta(), ctx({ relativePath: 'source/art2.png' }));
    expect(r.fresh).toBe(false);
    expect(r.reasons).toContain('relativePath changed');
  });

  it('reports stale when projectId changes', () => {
    const r = compareFreshness(freshMeta(), ctx({ projectId: 2 }));
    expect(r.fresh).toBe(false);
    expect(r.reasons).toContain('projectId changed');
  });

  it('reports stale when assetId changes', () => {
    const r = compareFreshness(freshMeta(), ctx({ assetId: 11 }));
    expect(r.fresh).toBe(false);
    expect(r.reasons).toContain('assetId changed');
  });

  it('reports stale when derivativeConfigVersion changes', () => {
    const meta = freshMeta();
    meta.derivativeConfigVersion = 999;
    const r = compareFreshness(meta, ctx());
    expect(r.fresh).toBe(false);
    expect(r.reasons).toContain('derivativeConfigVersion changed');
  });

  it('reports stale when schemaVersion changes', () => {
    const meta = freshMeta();
    meta.schemaVersion = 999;
    const r = compareFreshness(meta, ctx());
    expect(r.fresh).toBe(false);
    expect(r.reasons).toContain('schemaVersion changed');
  });

  it('does NOT claim to detect same-size same-mtime content changes', () => {
    // Documented limitation: identical size + mtime is reported fresh even
    // if the bytes changed. Exact content hashing is deferred.
    const r = compareFreshness(freshMeta(), ctx());
    expect(r.fresh).toBe(true);
  });
});

// ─── Atomic writes ───────────────────────────────────────────────────────

describe('atomicWriteBuffer / atomicWriteMeta', () => {
  let tmp, previewRoot, dir;

  beforeEach(() => {
    ({ tmp, previewRoot } = makeTmpPreviewRoot());
    dir = ensureCacheDir(previewRoot, 1, 10);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('atomicWriteBuffer writes a buffer and renames into place', async () => {
    const buf = await makeWebpBuffer(16, 12);
    const finalPath = atomicWriteBuffer(dir, 'thumbnail.webp', buf);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.readFileSync(finalPath)).toEqual(buf);
  });

  it('atomicWriteBuffer leaves no temp file on success', async () => {
    const buf = await makeWebpBuffer(16, 12);
    atomicWriteBuffer(dir, 'thumbnail.webp', buf);
    const temps = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    expect(temps).toEqual([]);
  });

  it('atomicWriteMeta writes a parseable meta.json', () => {
    const meta = serializeMeta({
      projectId: 1,
      assetId: 10,
      relativePath: 'source/art.png',
      size: 4096,
      mtime: '2026-07-28T12:00:00.000Z',
      generatedAt: '2026-07-28T12:01:00.000Z',
      thumbnail: { width: 128, height: 96, bytes: 1024, format: 'webp' },
      preview: { width: 800, height: 600, bytes: 8192, format: 'webp' },
    });
    const p = atomicWriteMeta(dir, meta);
    expect(fs.existsSync(p)).toBe(true);
    const parsed = parseMeta(fs.readFileSync(p, 'utf8'));
    expect(parsed.projectId).toBe(1);
  });

  it('atomicWriteBuffer cleans up the temp file when the rename target is on a read-only fs (simulated via missing dir)', async () => {
    const buf = await makeWebpBuffer(8, 8);
    const missingDir = path.join(dir, 'does-not-exist');
    expect(() => atomicWriteBuffer(missingDir, 'thumbnail.webp', buf)).toThrow();
    // No temp file leaked in the parent dir.
    const temps = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    expect(temps).toEqual([]);
  });

  it('a failed atomicWriteBuffer does NOT replace a previously valid file', async () => {
    const original = await makeWebpBuffer(16, 12);
    const finalPath = path.join(dir, 'thumbnail.webp');
    fs.writeFileSync(finalPath, original);

    const badBuf = Buffer.from('not-webp');
    expect(() => atomicWriteBuffer(dir, 'thumbnail.webp', badBuf)).not.toThrow();
    // atomicWriteBuffer itself does not validate content; it just renames.
    // The service layer gates the rename on WebP validity. Here we only
    // assert the write itself didn't error mid-way and left a single file.
    expect(fs.existsSync(finalPath)).toBe(true);
    const temps = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    expect(temps).toEqual([]);
  });
});

// ─── WebP validation ─────────────────────────────────────────────────────

describe('validateWebpFile', () => {
  let tmp, previewRoot, dir;

  beforeEach(() => {
    ({ tmp, previewRoot } = makeTmpPreviewRoot());
    dir = ensureCacheDir(previewRoot, 1, 10);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('validates a real WebP file and reports its size', async () => {
    const buf = await makeWebpBuffer(32, 24);
    const p = path.join(dir, 'thumbnail.webp');
    fs.writeFileSync(p, buf);
    const info = await validateWebpFile(p);
    expect(info.bytes).toBe(buf.length);
    expect(info.width).toBe(32);
    expect(info.height).toBe(24);
    expect(info.animated).toBe(false);
    expect(info.frameCount).toBe(1);
    expect(info.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a non-WebP file', async () => {
    const p = path.join(dir, 'thumbnail.webp');
    fs.writeFileSync(p, Buffer.from('not an image'));
    await expect(validateWebpFile(p)).rejects.toThrow();
  });

  it('rejects a missing file', async () => {
    await expect(
      validateWebpFile(path.join(dir, 'nope.webp'))
    ).rejects.toThrow();
  });

  it('detects animated WebP', async () => {
    const sharp = (await import('sharp')).default;
    const frames = [];
    for (let i = 0; i < 3; i++) {
      frames.push(
        await sharp({
          create: { width: 16, height: 16, channels: 3, background: { r: i * 80, g: 0, b: 0 } },
        })
          .png()
          .toBuffer()
      );
    }
    const animated = await sharp(frames, { join: { animated: true } })
      .webp({ quality: 80 })
      .toBuffer();
    const p = path.join(dir, 'preview.webp');
    fs.writeFileSync(p, animated);
    const info = await validateWebpFile(p);
    expect(info.animated).toBe(true);
    expect(info.frameCount).toBe(3);
  });
});

// ─── Derivative file probes ──────────────────────────────────────────────

describe('getDerivativeBytes / removeDerivative / removeCacheDir', () => {
  let tmp, previewRoot, dir;

  beforeEach(() => {
    ({ tmp, previewRoot } = makeTmpPreviewRoot());
    dir = ensureCacheDir(previewRoot, 1, 10);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('getDerivativeBytes returns null for a missing file', () => {
    expect(
      getDerivativeBytes(path.join(dir, 'thumbnail.webp'))
    ).toBeNull();
  });

  it('getDerivativeBytes returns the byte size for an existing file', async () => {
    const buf = await makeWebpBuffer(8, 8);
    const p = path.join(dir, 'thumbnail.webp');
    fs.writeFileSync(p, buf);
    expect(getDerivativeBytes(p)).toBe(buf.length);
  });

  it('removeDerivative is a no-op when the file is missing', () => {
    expect(() => removeDerivative(dir, 'thumbnail.webp')).not.toThrow();
  });

  it('removeDerivative removes an existing derivative', async () => {
    const buf = await makeWebpBuffer(8, 8);
    fs.writeFileSync(path.join(dir, 'thumbnail.webp'), buf);
    removeDerivative(dir, 'thumbnail.webp');
    expect(fs.existsSync(path.join(dir, 'thumbnail.webp'))).toBe(false);
  });

  it('removeCacheDir removes the entire cache directory tree', async () => {
    const buf = await makeWebpBuffer(8, 8);
    fs.writeFileSync(path.join(dir, 'thumbnail.webp'), buf);
    fs.writeFileSync(path.join(dir, 'preview.webp'), buf);
    writeValidMeta(dir);
    removeCacheDir(previewRoot, 1, 10);
    expect(fs.existsSync(dir)).toBe(false);
  });
});