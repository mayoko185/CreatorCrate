import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createGeneratedImageRebuildRepository } from '../src/data/generated-image-rebuild-repository.js';
import { GENERATED_IMAGE_REBUILD_KEY, InvalidGeneratedImageRebuildRecordError } from '../src/data/generated-image-rebuild-repository.js';
import {
  backgroundRebuildWindow, createGeneratedImageRebuildService, effectiveProjectImagePolicyChanged,
} from '../src/services/generated-image-rebuild-service.js';
import { createManagedUploadTracker, managedUploadTracker } from '../src/services/managed-upload-tracker.js';
import { createApplicationContext } from '../src/app-context.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const base = {
  thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
  preview: { format: 'webp', webpQuality: 90, maxDimension: 1600 },
};
const changed = { ...base, preview: { ...base.preview, webpQuality: 70 } };
const latest = { ...base, preview: { ...base.preview, webpQuality: 85 } };
const opened = [];

function fixture(preview, options = {}) {
  const db = openDatabase(':memory:');
  opened.push(db);
  runMigrations(db, MIGRATIONS_DIR);
  db.prepare("INSERT INTO projects (id, title, slug, project_dir, status, project_type) VALUES (1, 'One', 'one', 'one', 'ready', 'images')").run();
  db.prepare("INSERT INTO projects (id, title, slug, project_dir, status, project_type, archived_at) VALUES (2, 'Old', 'old', 'old', 'archived', 'images', datetime('now'))").run();
  const insert = db.prepare(`INSERT INTO assets
    (id, project_id, relative_path, filename, extension, mime_type, is_present, size_bytes, modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 10, '2026-01-01')`);
  insert.run(1, 1, 'one.png', 'one.png', 'png', 'image/png', 1);
  insert.run(2, 2, 'two.png', 'two.png', 'png', 'image/png', 1);
  insert.run(3, 1, 'missing.png', 'missing.png', 'png', 'image/png', 0);
  insert.run(4, 1, 'readme.txt', 'readme.txt', 'txt', 'text/plain', 1);
  for (const id of options.extraIds || []) insert.run(id, 1, `${id}.png`, `${id}.png`, 'png', 'image/png', 1);
  const repository = createGeneratedImageRebuildRepository(db, createAppMetaRepository(db));
  let policy = base;
  const imageSettings = {
    getPolicy: () => policy,
    getPresentationPolicy: () => ({ resolveAsset: (asset) => asset }),
  };
  const activeRepository = {
    ...repository,
    ...(options.get ? { get: options.get(repository.get) } : {}),
    ...(options.page ? { page: options.page(repository.page) } : {}),
    ...(options.save ? { save: options.save(repository.save) } : {}),
  };
  const build = (ensureTargetGeneration) => createGeneratedImageRebuildService({
    repository: activeRepository, imageSettings, previewService: { ensureTargetGeneration },
    maintenanceState: options.maintenanceState || { active: false },
    managedUploadTracker: options.tracker || { begin: () => ({ complete() {} }) },
    applicationLogger: options.applicationLogger,
    schedule: options.schedule,
    processingConcurrency: options.processingConcurrency,
    // Frontier durability is independent of the production cap, so these
    // scenarios keep the uncapped C - 1 window unless a test opts back in.
    maxBackgroundWindow: 'maxBackgroundWindow' in options ? options.maxBackgroundWindow : Infinity,
  });
  const service = build(preview);
  return { db, repository, service, build, setPolicy: (next) => { policy = next; } };
}

afterEach(() => { for (const db of opened.splice(0)) closeDatabase(db); });

describe('generated-image rebuild', () => {
  it.each(['', '{bad json', '{"version":9,"cursor":999,"mode":"manual"}'])(
    'repairs an untrusted record and processes the saved policy from the beginning', async (raw) => {
      const seen = [];
      const { db, repository, service, setPolicy } = fixture(async (_project, id, target) => {
        seen.push([id, target.preview.webpQuality]);
        return { cacheState: 'regenerated' };
      });
      setPolicy(changed);
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(GENERATED_IMAGE_REBUILD_KEY, raw);
      expect(() => repository.get()).toThrow(InvalidGeneratedImageRebuildRecordError);
      service.recover();
      expect(repository.get()).toMatchObject({ version: 1, phase: 'queued', mode: 'automatic',
        previousPolicy: null, targetPolicy: changed, reconcileAll: true, cursor: 0,
        attempted: 0, succeeded: 0, failed: 0, skipped: 0, failures: [] });
      service.signal();
      await service.waitForIdle();
      expect(seen).toEqual([[1, 70], [2, 70]]);
      expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 2, succeeded: 2 });
    },
  );

  it('replaces an incomplete version-one record instead of trusting its cursor', () => {
    const { db, repository, service, setPolicy } = fixture(async () => ({}));
    setPolicy(changed);
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
      GENERATED_IMAGE_REBUILD_KEY, '{"version":1,"runId":"old","mode":"manual","phase":"running","cursor":2}',
    );
    service.recover();
    expect(repository.get()).toMatchObject({ mode: 'automatic', phase: 'queued',
      previousPolicy: null, targetPolicy: changed, reconcileAll: true, cursor: 0 });
    expect(repository.get().runId).not.toBe('old');
  });
  it('ignores hidden quality changes under PNG and Original modes', () => {
    const png = { ...base, thumbnail: { ...base.thumbnail, format: 'png' },
      preview: { ...base.preview, format: 'png' } };
    expect(effectiveProjectImagePolicyChanged(png, {
      ...png, thumbnail: { ...png.thumbnail, webpQuality: 50 },
    })).toBe(false);
    const original = { ...base, preview: { ...base.preview, format: 'original' } };
    expect(effectiveProjectImagePolicyChanged(original, {
      ...original, preview: { ...original.preview, maxDimension: 800, webpQuality: 30 },
    })).toBe(false);
  });

  it('does not bulk-regenerate raster previews when switching to Original', async () => {
    const previous = { ...base, preview: { ...base.preview, webpQuality: 70 } };
    const original = { ...base, preview: { ...base.preview, format: 'original' } };
    const calls = [];
    const { service, setPolicy } = fixture(async (_projectId, assetId) => {
      calls.push(assetId);
      return { cacheState: 'regenerated' };
    });
    setPolicy(original);
    expect(service.queueAutomatic(previous, original)).toBe(true);
    service.signal();
    await service.waitForIdle();
    expect(calls).toEqual([]);
    expect(service.readStatus()).toMatchObject({ phase: 'completed', skipped: 2, attempted: 0 });
  });

  it('enumerates present project assets with a bounded keyset, including archived projects', () => {
    const { repository } = fixture(async () => ({}));
    expect(repository.bounds()).toEqual({ total: 2, upperBound: 2 });
    expect(repository.page(0, 2, 1).map((asset) => asset.id)).toEqual([1]);
    expect(repository.page(1, 2, 1).map((asset) => asset.id)).toEqual([2]);
  });

  it('queues effective changes and processes one asset at a time through the target API', async () => {
    const calls = [];
    let active = 0;
    let maximumActive = 0;
    const { service, setPolicy, repository } = fixture(async (_projectId, assetId, target, authority, options) => {
      expect(authority()).toBe(true);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      calls.push({ assetId, target, options });
      active -= 1;
      return { cacheState: 'regenerated' };
    });
    expect(service.queueAutomatic(base, { ...base, thumbnail: { ...base.thumbnail, webpQuality: 80 } })).toBe(false);
    setPolicy(changed);
    expect(service.queueAutomatic(base, changed)).toBe(true);
    expect(repository.get().phase).toBe('queued');
    service.signal();
    await service.waitForIdle();
    expect(calls.map((call) => call.assetId)).toEqual([1, 2]);
    expect(maximumActive).toBe(1);
    expect(calls.every((call) => call.options.force === false)).toBe(true);
    expect(service.readStatus()).toMatchObject({ phase: 'completed', attempted: 2, succeeded: 2, failed: 0, cursor: 2 });
  });

  it('resumes manual force from its durable cursor and continues after a failed asset', async () => {
    const calls = [];
    const { service, repository } = fixture(async (_projectId, assetId, _target, _authority, options) => {
      calls.push({ assetId, options });
      throw new Error('Unreadable source');
    });
    service.queueManual();
    const queued = repository.get();
    repository.save({ ...queued, phase: 'running', cursor: 1, attempted: 1, succeeded: 1 });
    service.signal();
    await service.waitForIdle();
    expect(calls).toEqual([{ assetId: 2, options: { force: true } }]);
    expect(service.readStatus()).toMatchObject({ phase: 'completed_with_failures', cursor: 2,
      attempted: 2, succeeded: 1, failed: 1 });
  });

  it('re-enumerates an unfinished automatic run and skips already fresh pairs', async () => {
    const seen = [];
    const { service, repository, setPolicy } = fixture(async (_projectId, assetId) => {
      seen.push(assetId);
      return { cacheState: assetId === 1 ? undefined : 'regenerated' };
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    const queued = repository.get();
    repository.save({ ...queued, phase: 'running', cursor: 1, attempted: 1, succeeded: 1 });
    service.recover();
    expect(repository.get()).toMatchObject({ phase: 'queued', cursor: 0, attempted: 0 });
    service.signal();
    await service.waitForIdle();
    expect(seen).toEqual([1, 2]);
    expect(service.readStatus()).toMatchObject({ phase: 'completed', skipped: 1,
      attempted: 1, succeeded: 1 });
  });

  it('keeps automatic progress when an auth graph is rebuilt without a process restart', () => {
    const { service, repository, setPolicy } = fixture(async () => ({}));
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    repository.save({ ...repository.get(), phase: 'running', cursor: 1, attempted: 1, succeeded: 1 });
    service.recover({ restartAutomatic: false });
    expect(repository.get()).toMatchObject({ phase: 'queued', cursor: 1, attempted: 1, succeeded: 1 });
  });

  it('reconciles an obsolete durable target to the saved policy on startup', () => {
    const { service, setPolicy, repository } = fixture(async () => ({}));
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    const oldRunId = repository.get().runId;
    setPolicy(latest);
    service.recover();
    expect(repository.get()).toMatchObject({ phase: 'queued', mode: 'automatic',
      targetPolicy: latest, reconcileAll: true, cursor: 0 });
    expect(repository.get().runId).not.toBe(oldRunId);
  });

  it('continues after one asset fails and reports a bounded failure sample', async () => {
    const seen = [];
    const { service, setPolicy } = fixture(async (_projectId, assetId) => {
      seen.push(assetId);
      if (assetId === 1) throw new Error('Unreadable source');
      return { cacheState: 'regenerated' };
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await service.waitForIdle();
    expect(seen).toEqual([1, 2]);
    expect(service.readStatus()).toMatchObject({ phase: 'completed_with_failures',
      attempted: 2, succeeded: 1, failed: 1, failures: [{ assetId: 1, message: 'Unreadable source' }] });
  });

  it('collapses rapid queued saves to the latest target without losing the original baseline', async () => {
    const seen = [];
    const { service, setPolicy } = fixture(async (_projectId, assetId, target) => {
      seen.push([assetId, target.preview.webpQuality]);
      return { cacheState: 'regenerated' };
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    setPolicy(latest);
    service.queueAutomatic(changed, latest);
    service.signal();
    await service.waitForIdle();
    expect(seen).toEqual([[1, 85], [2, 85]]);
    expect(service.readStatus()).toMatchObject({ targetPolicy: latest, previousPolicy: base,
      attempted: 2, succeeded: 2 });
  });

  it('supersedes an in-flight target and converges on the latest run', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const { service, setPolicy } = fixture(async (_projectId, assetId, target, authority) => {
      calls.push([assetId, target.preview.webpQuality]);
      if (target.preview.webpQuality === 70) {
        await gate;
        if (!authority()) throw new Error('Target image policy is obsolete.');
      }
      return { cacheState: 'regenerated' };
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await Promise.resolve();
    await Promise.resolve();
    setPolicy(latest);
    service.queueAutomatic(changed, latest);
    service.signal();
    release();
    await service.waitForIdle();
    expect(calls).toContainEqual([1, 85]);
    expect(calls).toContainEqual([2, 85]);
    expect(service.readStatus()).toMatchObject({ phase: 'completed', targetPolicy: latest,
      attempted: 2, succeeded: 2, failed: 0 });
  });

  it('stops at an asset boundary and leaves unfinished durable work for restart', async () => {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const calls = [];
    const { service, setPolicy, repository } = fixture(async (_projectId, assetId) => {
      calls.push(assetId);
      entered();
      await gate;
      return { cacheState: 'regenerated' };
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await started;
    service.stop();
    release();
    await service.waitForIdle();
    expect(calls).toEqual([1]);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 0 });
  });

  it('pauses for maintenance after the current asset and keeps its checkpoint', async () => {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const calls = [];
    const { service, setPolicy, repository } = fixture(async (_projectId, assetId) => {
      calls.push(assetId);
      entered();
      await gate;
      return { cacheState: 'regenerated' };
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await started;
    const pause = service.pauseForMaintenance();
    release();
    await service.waitForIdle();
    expect(calls).toEqual([1]);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 1, succeeded: 1 });
    service.stop();
    pause.release();
  });

  it('retries a transient page fault from the durable cursor', async () => {
    const scheduled = [];
    const seen = [];
    let pages = 0;
    const { service, repository, setPolicy } = fixture(async (_projectId, id) => {
      seen.push(id);
      return { cacheState: 'regenerated' };
    }, {
      page: (original) => (...args) => {
        if (++pages === 2) throw new Error('Transient page read');
        return original(...args);
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    const runId = repository.get().runId;
    service.signal();
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 2, succeeded: 2 });
    expect(scheduled.map((item) => item.delay)).toEqual([250]);
    scheduled.shift().callback();
    await service.waitForIdle();
    expect(seen).toEqual([1, 2]);
    expect(repository.get()).toMatchObject({ runId, phase: 'completed', cursor: 2, succeeded: 2 });
  });

  it('replaces a pending retry with the latest durable target', async () => {
    const scheduled = [];
    const seen = [];
    let fail = true;
    const { service, repository, setPolicy } = fixture(async (_projectId, id, target) => {
      seen.push([id, target.preview.webpQuality]);
      return { cacheState: 'regenerated' };
    }, {
      page: (original) => (...args) => {
        if (fail) { fail = false; throw new Error('Transient page read'); }
        return original(...args);
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    const obsoleteRunId = repository.get().runId;
    service.signal();
    await service.waitForIdle();
    setPolicy(latest);
    service.queueAutomatic(changed, latest);
    service.signal();
    await service.waitForIdle();
    expect(repository.get().runId).not.toBe(obsoleteRunId);
    expect(repository.get()).toMatchObject({ phase: 'completed', targetPolicy: latest });
    scheduled.shift().callback();
    await service.waitForIdle();
    expect(seen).toEqual([[1, 85], [2, 85]]);
  });

  it('bounds persistent runner faults and leaves a recoverable failed checkpoint', async () => {
    const scheduled = [];
    let pages = 0;
    const { service, repository, setPolicy } = fixture(async () => ({}), {
      page: () => () => { pages++; throw new Error('Database temporarily unreadable'); },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    repository.save({ ...repository.get(), phase: 'running', cursor: 1, attempted: 1, succeeded: 1 });
    service.signal();
    await service.waitForIdle();
    while (scheduled.length) {
      scheduled.shift().callback();
      await service.waitForIdle();
    }
    expect(pages).toBe(4);
    expect(repository.get()).toMatchObject({ phase: 'failed', cursor: 1, succeeded: 1,
      targetPolicy: changed, runnerError: 'Database temporarily unreadable' });
    service.signal();
    await service.waitForIdle();
    expect(pages).toBe(4);
    service.recover();
    expect(repository.get()).toMatchObject({ phase: 'queued', cursor: 1, targetPolicy: changed });
  });

  it('exhausts persistent checkpoint failures without advancing durable progress', async () => {
    const scheduled = [];
    let checkpointAttempts = 0;
    const { service, repository, setPolicy } = fixture(async () => ({ cacheState: 'regenerated' }), {
      save: (original) => (record) => {
        if (record.phase === 'running' && record.cursor === 2) {
          checkpointAttempts++;
          throw new Error('Checkpoint unavailable');
        }
        return original(record);
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    repository.save({ ...repository.get(), phase: 'running', cursor: 1, attempted: 1, succeeded: 1 });
    service.signal();
    await service.waitForIdle();
    for (const delay of [250, 500, 1000]) {
      expect(scheduled.map((item) => item.delay)).toEqual([delay]);
      scheduled.shift().callback();
      await service.waitForIdle();
    }
    expect(checkpointAttempts).toBe(4);
    expect(repository.get()).toMatchObject({ phase: 'failed', cursor: 1, attempted: 1,
      succeeded: 1, failed: 0, targetPolicy: changed, mode: 'automatic',
      runnerError: 'Checkpoint unavailable' });
    expect(scheduled).toHaveLength(0);
    service.signal();
    await service.waitForIdle();
    expect(checkpointAttempts).toBe(4);
  });

  it('stops an exhausted run when its terminal failed save also fails, then accepts a newer run', async () => {
    const scheduled = [];
    const logs = [];
    let generationAttempts = 0;
    let checkpointAttempts = 0;
    let terminalAttempts = 0;
    let writesFail = true;
    const { service, repository, setPolicy } = fixture(async () => {
      generationAttempts++;
      return { cacheState: 'regenerated' };
    }, {
      save: (original) => (record) => {
        if (writesFail && record.phase === 'running' && record.cursor === 2) {
          checkpointAttempts++;
          throw new Error('Checkpoint unavailable');
        }
        if (writesFail && record.phase === 'failed') {
          terminalAttempts++;
          throw new Error('Failure state unavailable');
        }
        return original(record);
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
      applicationLogger: { error: (entry) => logs.push(entry) },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    repository.save({ ...repository.get(), phase: 'running', cursor: 1, attempted: 1, succeeded: 1 });
    const exhaustedRunId = repository.get().runId;
    service.signal();
    await service.waitForIdle();
    for (const delay of [250, 500, 1000]) {
      expect(scheduled.map((item) => item.delay)).toEqual([delay]);
      scheduled.shift().callback();
      await service.waitForIdle();
    }
    expect(checkpointAttempts).toBe(4);
    expect(generationAttempts).toBe(4);
    expect(terminalAttempts).toBe(1);
    expect(repository.get()).toMatchObject({ runId: exhaustedRunId, phase: 'running', cursor: 1 });
    expect(scheduled).toHaveLength(0);
    expect(logs.some((entry) => entry.message.includes('exhausted retries; could not persist failed state'))).toBe(true);
    service.signal();
    await service.waitForIdle();
    expect(checkpointAttempts).toBe(4);
    expect(generationAttempts).toBe(4);
    expect(scheduled).toHaveLength(0);

    writesFail = false;
    setPolicy(latest);
    expect(service.queueAutomatic(changed, latest)).toBe(true);
    expect(repository.get().runId).not.toBe(exhaustedRunId);
    service.signal();
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ phase: 'completed', targetPolicy: latest });
    expect(scheduled).toHaveLength(0);
  });

  it('enters the bounded runner retry when rebuild state cannot be read in the finalizer', async () => {
    const scheduled = [];
    const logs = [];
    let hideRecord = false;
    let readsFail = false;
    const { service, repository, setPolicy } = fixture(async () => ({ cacheState: 'regenerated' }), {
      get: (original) => () => {
        // The runner sees no record and exits cleanly; only the finalizer's
        // own read then faults.
        if (hideRecord) { hideRecord = false; readsFail = true; return null; }
        if (readsFail) throw new Error('State unavailable');
        return original();
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
      applicationLogger: { error: (entry) => logs.push(entry) },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    const runId = repository.get().runId;
    hideRecord = true;
    service.signal();
    await service.waitForIdle();
    expect(logs.some((entry) => entry.message.includes('Could not read rebuild state after runner stopped'))).toBe(true);
    expect(scheduled.map((item) => item.delay)).toEqual([250]);
    expect(repository.get()).toMatchObject({ runId, phase: 'queued' });
    readsFail = false;
    scheduled.shift().callback();
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ runId, phase: 'completed', cursor: 2, succeeded: 2 });
    expect(scheduled).toHaveLength(0);
  });

  it('resets runner retries after a durable asset checkpoint', async () => {
    const scheduled = [];
    const attempts = new Map();
    const { service, repository, setPolicy } = fixture(async () => ({ cacheState: 'regenerated' }), {
      save: (original) => (record) => {
        if (record.phase === 'running' && record.cursor > 0) {
          const count = (attempts.get(record.cursor) || 0) + 1;
          attempts.set(record.cursor, count);
          if ((record.cursor === 1 && count <= 2) || (record.cursor === 2 && count <= 3)) {
            throw new Error('Transient checkpoint failure');
          }
        }
        return original(record);
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await service.waitForIdle();
    const delays = [];
    while (scheduled.length) {
      const retry = scheduled.shift();
      delays.push(retry.delay);
      retry.callback();
      await service.waitForIdle();
    }
    expect(delays).toEqual([250, 500, 250, 500, 1000]);
    expect(attempts.get(1)).toBe(3);
    expect(attempts.get(2)).toBe(4);
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 2,
      succeeded: 2, attempted: 2 });
  });

  it('carries failed automatic reconciliation into the latest target without carrying its counts', async () => {
    const png = { ...base, preview: { ...base.preview, format: 'png' } };
    const latestPng = { ...png, preview: { ...png.preview, webpQuality: 75 } };
    const scheduled = [];
    const cache = new Map([[1, 'webp'], [2, 'webp'], [5, 'webp']]);
    const seen = [];
    let failCheckpoint = true;
    const { db, service, repository, setPolicy } = fixture(async (_project, id, target) => {
      seen.push([id, target.preview.webpQuality]);
      cache.set(id, id === 5 ? `webp-${target.preview.webpQuality}` : target.preview.format);
      return { cacheState: 'regenerated' };
    }, {
      save: (original) => (record) => {
        if (failCheckpoint && record.phase === 'running' && record.cursor === 1) {
          throw new Error('Checkpoint unavailable');
        }
        return original(record);
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    db.prepare(`INSERT INTO assets (id, project_id, relative_path, filename, extension, mime_type,
      is_present, source_animated, size_bytes, modified_at)
      VALUES (5, 1, 'animated.gif', 'animated.gif', 'gif', 'image/gif', 1, 1, 10, '2026-01-01')`).run();
    setPolicy(png);
    service.queueAutomatic(base, png);
    const failedRunId = repository.get().runId;
    service.signal();
    await service.waitForIdle();
    while (scheduled.length) {
      scheduled.shift().callback();
      await service.waitForIdle();
    }
    expect(repository.get()).toMatchObject({ runId: failedRunId, phase: 'failed', cursor: 0 });
    expect(cache.get(2)).toBe('webp');
    failCheckpoint = false;
    setPolicy(latestPng);
    expect(service.queueAutomatic(png, latestPng)).toBe(true);
    expect(repository.get()).toMatchObject({ phase: 'queued', reconcileAll: true,
      targetPolicy: latestPng, cursor: 0, attempted: 0, succeeded: 0 });
    expect(repository.get().runId).not.toBe(failedRunId);
    service.signal();
    await service.waitForIdle();
    expect(seen).toContainEqual([2, 75]);
    expect(cache.get(2)).toBe('png');
    expect(repository.get()).toMatchObject({ phase: 'completed', targetPolicy: latestPng,
      attempted: 3, succeeded: 3, cursor: 5 });
  });

  it('keeps a completed automatic predecessor scoped to the latest change', async () => {
    const png = { ...base, preview: { ...base.preview, format: 'png' } };
    const latestPng = { ...png, preview: { ...png.preview, webpQuality: 75 } };
    const seen = [];
    const { db, service, repository, setPolicy } = fixture(async (_project, id, target) => {
      seen.push([id, target.preview.webpQuality]);
      return { cacheState: 'regenerated' };
    });
    db.prepare("UPDATE assets SET extension = 'gif', mime_type = 'image/gif', source_animated = 1 WHERE id = 2").run();
    setPolicy(png);
    service.queueAutomatic(base, png);
    service.signal();
    await service.waitForIdle();
    expect(repository.get().phase).toBe('completed');
    seen.length = 0;
    setPolicy(latestPng);
    expect(service.queueAutomatic(png, latestPng)).toBe(true);
    expect(repository.get().reconcileAll).toBe(false);
    service.signal();
    await service.waitForIdle();
    expect(seen).toEqual([[2, 75]]);
    expect(repository.get()).toMatchObject({ phase: 'completed', targetPolicy: latestPng,
      attempted: 1, skipped: 1 });
  });

  it('cancels a pending runner retry on shutdown without rescheduling', async () => {
    const scheduled = [];
    let pages = 0;
    const { service, repository, setPolicy } = fixture(async () => ({}), {
      page: () => () => { pages++; throw new Error('Transient page read'); },
      schedule: (callback) => { scheduled.push(callback); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await service.waitForIdle();
    expect(scheduled).toHaveLength(1);
    service.stop();
    scheduled.shift()();
    await service.waitForIdle();
    expect(pages).toBe(1);
    expect(repository.get().phase).toBe('running');
  });

  it('holds rebuild at an asset boundary through maintenance and resumes the latest target', async () => {
    const tracker = createManagedUploadTracker();
    const maintenanceState = { active: false };
    tracker.bindMaintenanceState(maintenanceState);
    let enter, release;
    const started = new Promise((resolve) => { enter = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    const { service, repository, setPolicy } = fixture(async (_projectId, id, target) => {
      seen.push([id, target.preview.webpQuality]);
      if (seen.length === 1) { enter(); await gate; }
      return { cacheState: 'regenerated' };
    }, { tracker, maintenanceState });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await started;
    const pause = service.pauseForMaintenance();
    expect(tracker.tryBeginMaintenance()).toBeNull();
    setPolicy(latest);
    service.queueAutomatic(changed, latest);
    service.signal();
    release();
    await pause.waitForIdle();
    expect(seen).toEqual([[1, 70]]);
    const owner = tracker.tryBeginMaintenance();
    expect(owner).not.toBeNull();
    expect(repository.get()).toMatchObject({ phase: 'queued', targetPolicy: latest });
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    owner.release();
    pause.release();
    await service.waitForIdle();
    expect(seen).toContainEqual([1, 85]);
    expect(repository.get()).toMatchObject({ phase: 'completed', targetPolicy: latest });
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Preview stub whose calls block until the test settles that asset. Calls
// the predicate rejects complete immediately as regenerated.
function gatedPreview(shouldGate = () => true) {
  const calls = [];
  const gates = new Map();
  const waiters = [];
  return {
    calls,
    started: (quality) => calls.filter((call) => quality === undefined || call.quality === quality)
      .map((call) => call.id),
    async preview(_projectId, id, target, _authority, options) {
      const call = { id, quality: target.preview.webpQuality, options };
      calls.push(call);
      for (const waiter of waiters.splice(0)) {
        if (calls.length >= waiter.count) waiter.resolve(); else waiters.push(waiter);
      }
      if (!shouldGate(call)) return { cacheState: 'regenerated' };
      const gate = deferred();
      gates.set(id, gate);
      const outcome = await gate.promise;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    release(id, outcome = { cacheState: 'regenerated' }) { gates.get(id).resolve(outcome); },
    waitForCalls(count) {
      if (calls.length >= count) return Promise.resolve();
      const waiter = deferred();
      waiters.push({ count, resolve: waiter.resolve });
      return waiter.promise;
    },
  };
}

// Lets already-settled work run to its next await; no wall-clock timing.
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('generated-image rebuild background window', () => {
  it('reserves at least one shared slot and never exceeds two in flight', () => {
    expect([1, 2, 3, 4, 8].map((capacity) => backgroundRebuildWindow(capacity))).toEqual([1, 1, 2, 2, 2]);
    expect(backgroundRebuildWindow(undefined)).toBe(1);
    expect([1, 2, 4, 8].map((capacity) => backgroundRebuildWindow(capacity, Infinity))).toEqual([1, 1, 3, 7]);
  });

  it.each([[1, 1, undefined], [2, 1, undefined], [3, 2, undefined], [4, 2, undefined], [4, 3, Infinity]])(
    'keeps at most B uncheckpointed logical assets at capacity %i', async (capacity, window, maxBackgroundWindow) => {
      const traversal = [1, 2, 9, 27, 30, 31];
      const gated = gatedPreview();
      let maxOutstanding = 0;
      const { service, repository } = fixture((...args) => {
        const cursor = repository.get().cursor;
        const committed = traversal.filter((id) => id <= cursor).length;
        maxOutstanding = Math.max(maxOutstanding, gated.calls.length + 1 - committed);
        return gated.preview(...args);
      }, { extraIds: [9, 27, 30, 31], processingConcurrency: capacity, maxBackgroundWindow });
      service.queueManual();
      service.signal();
      const released = new Set();
      while (released.size < traversal.length) {
        await flush();
        // Newest first, so completions arrive out of traversal order.
        const next = gated.started().filter((id) => !released.has(id)).at(-1);
        released.add(next);
        gated.release(next);
      }
      await service.waitForIdle();
      expect(maxOutstanding).toBe(window);
      expect(gated.started()).toEqual(traversal);
      expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 31, attempted: 6, succeeded: 6 });
    },
  );

  it('checkpoints out-of-order completions only through the contiguous traversal prefix', async () => {
    const gated = gatedPreview();
    const saves = [];
    const { service, repository } = fixture(gated.preview, {
      extraIds: [9, 27], processingConcurrency: 4,
      save: (original) => (record) => { saves.push(record); return original(record); },
    });
    service.queueManual();
    service.signal();
    await gated.waitForCalls(3);
    gated.release(2);
    gated.release(9);
    await flush();
    // The window [1, 2, 9] is full until asset 1 commits; 27 must wait.
    expect(gated.started()).toEqual([1, 2, 9]);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 0, attempted: 0, succeeded: 0 });
    gated.release(1);
    await gated.waitForCalls(4);
    expect(repository.get()).toMatchObject({ cursor: 9, attempted: 3, succeeded: 3 });
    // IDs 3 and 4 are ineligible rows; the cursor follows traversal entries.
    expect(saves.filter((record) => record.phase === 'running').map((record) => record.cursor)).toEqual([0, 9]);
    gated.release(27);
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 27, attempted: 4, succeeded: 4 });
  });

  it('lets a no-op asset hold its place until the frontier reaches it', async () => {
    const gated = gatedPreview();
    const { service, repository } = fixture((projectId, id, ...rest) => (id === 2
      ? Promise.resolve({ status: 'ready' })
      : gated.preview(projectId, id, ...rest)), { extraIds: [9, 27], processingConcurrency: 4 });
    service.queueManual();
    service.signal();
    await gated.waitForCalls(2);
    await flush();
    expect(gated.started()).toEqual([1, 9]);
    expect(repository.get()).toMatchObject({ cursor: 0, skipped: 0 });
    gated.release(1);
    await gated.waitForCalls(3);
    expect(repository.get()).toMatchObject({ cursor: 2, attempted: 1, succeeded: 1, skipped: 1 });
    gated.release(9);
    gated.release(27);
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 27,
      attempted: 3, succeeded: 3, skipped: 1 });
  });

  it('applies failure counts and samples in traversal order, not completion order', async () => {
    const gated = gatedPreview();
    const { service, repository } = fixture(gated.preview, { extraIds: [9, 27], processingConcurrency: 5 });
    service.queueManual();
    service.signal();
    await gated.waitForCalls(4);
    gated.release(27, new Error('late failure'));
    gated.release(2, new Error('early failure'));
    gated.release(9);
    await flush();
    expect(repository.get()).toMatchObject({ cursor: 0, attempted: 0, failed: 0, failures: [] });
    gated.release(1);
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ phase: 'completed_with_failures', cursor: 27,
      attempted: 4, succeeded: 2, failed: 2,
      failures: [{ assetId: 2, message: 'early failure' }, { assetId: 27, message: 'late failure' }] });
  });

  it('never checkpoints past an unresolved asset, so recovery revisits later work without double counts', async () => {
    const gated = gatedPreview();
    const published = new Set();
    const { service, repository, setPolicy, build } = fixture(async (...args) => {
      const result = await gated.preview(...args);
      published.add(args[1]);
      return result;
    }, { extraIds: [9, 27], processingConcurrency: 4 });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await gated.waitForCalls(3);
    gated.release(2);
    gated.release(9);
    await flush();
    expect([...published]).toEqual([2, 9]);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 0,
      attempted: 0, succeeded: 0, skipped: 0 });
    // The process goes away before the outcome for asset 1 is checkpointed.
    service.stop();
    gated.release(1);
    await service.waitForIdle();
    expect(published.has(1)).toBe(true);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 0, attempted: 0 });
    const revisited = [];
    const successor = build(async (_projectId, id) => {
      revisited.push(id);
      return published.has(id) ? { status: 'ready' } : { cacheState: 'regenerated' };
    });
    successor.recover({ restartAutomatic: false });
    expect(repository.get()).toMatchObject({ phase: 'queued', cursor: 0 });
    successor.signal();
    await successor.waitForIdle();
    expect(revisited).toEqual([1, 2, 9, 27]);
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 27,
      attempted: 1, succeeded: 1, skipped: 3, failed: 0 });
  });

  it('reconciles everything after superseding a started run whose cursor never advanced', async () => {
    const gated = gatedPreview((call) => call.quality === 70);
    const { service, repository, setPolicy } = fixture(gated.preview, {
      extraIds: [9], processingConcurrency: 4,
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await gated.waitForCalls(3);
    gated.release(2);
    await flush();
    // Asset 2 may already be published under the old target at cursor 0.
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 0, reconcileAll: false });
    setPolicy(latest);
    expect(service.queueAutomatic(changed, latest)).toBe(true);
    expect(repository.get()).toMatchObject({ phase: 'queued', reconcileAll: true, cursor: 0,
      previousPolicy: base, targetPolicy: latest });
    service.signal();
    gated.release(1);
    gated.release(9);
    await service.waitForIdle();
    expect(gated.started(85)).toEqual([1, 2, 9]);
    expect(repository.get()).toMatchObject({ phase: 'completed', targetPolicy: latest, succeeded: 3 });
  });

  it('stops refilling a superseded window and drains it before the successor starts', async () => {
    const gated = gatedPreview((call) => call.quality === 70);
    const { service, repository, setPolicy } = fixture(gated.preview, {
      extraIds: [9, 27], processingConcurrency: 4,
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await gated.waitForCalls(3);
    setPolicy(latest);
    service.queueAutomatic(changed, latest);
    service.signal();
    gated.release(2);
    await flush();
    expect(gated.started()).toEqual([1, 2, 9]);
    gated.release(1);
    await flush();
    expect(gated.started()).toEqual([1, 2, 9]);
    gated.release(9);
    await service.waitForIdle();
    expect(gated.started(70)).toEqual([1, 2, 9]);
    expect(gated.started(85)).toEqual([1, 2, 9, 27]);
    expect(repository.get()).toMatchObject({ phase: 'completed', targetPolicy: latest,
      cursor: 27, attempted: 4, succeeded: 4 });
  });

  it('holds maintenance until every outstanding asset settles and dispatches nothing new', async () => {
    const tracker = createManagedUploadTracker();
    const maintenanceState = { active: false };
    tracker.bindMaintenanceState(maintenanceState);
    const gated = gatedPreview();
    const { service, repository } = fixture(gated.preview, {
      extraIds: [9, 27], processingConcurrency: 4, tracker, maintenanceState,
    });
    service.queueManual();
    service.signal();
    await gated.waitForCalls(3);
    const pause = service.pauseForMaintenance();
    let idle = false;
    const drained = pause.waitForIdle().then(() => { idle = true; });
    gated.release(1);
    gated.release(9);
    await flush();
    expect(idle).toBe(false);
    expect(tracker.tryBeginMaintenance()).toBeNull();
    expect(gated.started()).toEqual([1, 2, 9]);
    gated.release(2);
    await drained;
    expect(gated.started()).toEqual([1, 2, 9]);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 9, succeeded: 3 });
    const owner = tracker.tryBeginMaintenance();
    expect(owner).not.toBeNull();
    owner.release();
    service.stop();
    pause.release();
  });

  it('drains the window without checkpointing on shutdown', async () => {
    const gated = gatedPreview();
    const { service, repository } = fixture(gated.preview, { extraIds: [9, 27], processingConcurrency: 4 });
    service.queueManual();
    service.signal();
    await gated.waitForCalls(3);
    service.stop();
    for (const id of [9, 1, 2]) gated.release(id);
    await service.waitForIdle();
    expect(gated.started()).toEqual([1, 2, 9]);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 0, attempted: 0 });
  });

  it('treats a pre-dispatch authority read fault as fatal, dispatches nothing after it, and retries', async () => {
    const scheduled = [];
    const gated = gatedPreview();
    let begins = 0;
    let armed = false;
    const { service, repository, setPolicy } = fixture(gated.preview, {
      extraIds: [9], processingConcurrency: 4,
      // Lifetimes go to the runner, then assets 1 and 2; the first state
      // read after asset 2 is admitted is its own authority check.
      tracker: { begin: () => { if (begins++ === 2) armed = true; return { complete() {} }; } },
      get: (original) => () => {
        if (armed) { armed = false; throw new Error('Rebuild state unavailable'); }
        return original();
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    const runId = repository.get().runId;
    service.signal();
    await gated.waitForCalls(1);
    await flush();
    // Asset 2 never reaches Preview, and the fault stops the same fill
    // before asset 9; the already-dispatched asset 1 keeps the run busy.
    expect(gated.started()).toEqual([1]);
    expect(begins).toBe(3);
    let idle = false;
    const drained = service.waitForIdle().then(() => { idle = true; });
    await flush();
    expect(idle).toBe(false);
    expect(scheduled).toEqual([]);
    gated.release(1);
    await drained;
    expect(gated.started()).toEqual([1]);
    // Asset 1 lies strictly before the fault, so it may commit.
    expect(repository.get()).toMatchObject({ runId, phase: 'running', cursor: 1,
      attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });
    expect(scheduled.map((item) => item.delay)).toEqual([250]);
    scheduled.shift().callback();
    await gated.waitForCalls(3);
    for (const id of [2, 9]) gated.release(id);
    await service.waitForIdle();
    expect(gated.started()).toEqual([1, 2, 9]);
    expect(scheduled).toEqual([]);
    expect(repository.get()).toMatchObject({ runId, phase: 'completed', cursor: 9,
      attempted: 3, succeeded: 3, skipped: 0, failed: 0, failures: [] });
  });

  it.each(['rewrapped', 'absorbed'])(
    'treats an authority read fault inside Preview Service as fatal when Preview %s it', async (mode) => {
      const scheduled = [];
      const gated = gatedPreview();
      const published = new Set();
      let armed = false;
      let faults = 0;
      const { service, repository, setPolicy } = fixture(async (projectId, id, target, authority, options) => {
        const result = await gated.preview(projectId, id, target, authority, options);
        if (id === 1 && faults++ === 0) {
          armed = true;
          try {
            authority();
          } catch (error) {
            if (mode === 'rewrapped') throw new Error('Preview generation failed', { cause: error });
            return { status: 'ready' };
          }
        }
        if (published.has(id)) return { status: 'ready' };
        published.add(id);
        return result;
      }, {
        extraIds: [9], processingConcurrency: 4,
        get: (original) => () => {
          if (armed) { armed = false; throw new Error('Rebuild state unavailable'); }
          return original();
        },
        schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
      });
      setPolicy(changed);
      service.queueAutomatic(base, changed);
      service.signal();
      await gated.waitForCalls(3);
      gated.release(2);
      gated.release(9);
      gated.release(1);
      await service.waitForIdle();
      expect(gated.started()).toEqual([1, 2, 9]);
      expect(published.has(1)).toBe(false);
      expect(repository.get()).toMatchObject({ phase: 'running', cursor: 0,
        attempted: 0, succeeded: 0, failed: 0, failures: [] });
      expect(scheduled.map((item) => item.delay)).toEqual([250]);
      scheduled.shift().callback();
      await gated.waitForCalls(6);
      for (const id of [1, 2, 9]) gated.release(id);
      await service.waitForIdle();
      expect(gated.started()).toEqual([1, 2, 9, 1, 2, 9]);
      expect(published.has(1)).toBe(true);
      expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 9,
        attempted: 1, succeeded: 1, skipped: 2, failed: 0, failures: [] });
    },
  );

  it('keeps a committed prefix, stops refill, and resumes after it when a later asset faults', async () => {
    const scheduled = [];
    const gated = gatedPreview();
    const published = new Set();
    let armed = false;
    let faults = 0;
    const { service, repository, setPolicy } = fixture(async (projectId, id, target, authority, options) => {
      const result = await gated.preview(projectId, id, target, authority, options);
      if (id === 2 && faults++ === 0) { armed = true; authority(); }
      if (published.has(id)) return { status: 'ready' };
      published.add(id);
      return result;
    }, {
      extraIds: [9, 27, 30], processingConcurrency: 4,
      get: (original) => () => {
        if (armed) { armed = false; throw new Error('Rebuild state unavailable'); }
        return original();
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await gated.waitForCalls(3);
    gated.release(1);
    await gated.waitForCalls(4);
    expect(repository.get()).toMatchObject({ cursor: 1, attempted: 1, succeeded: 1 });
    gated.release(2);
    await flush();
    gated.release(9);
    await flush();
    // Asset 9 frees a slot after the fault; asset 30 is never dispatched.
    expect(gated.started()).toEqual([1, 2, 9, 27]);
    gated.release(27);
    await service.waitForIdle();
    expect(gated.started()).toEqual([1, 2, 9, 27]);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 1,
      attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });
    expect(scheduled.map((item) => item.delay)).toEqual([250]);
    scheduled.shift().callback();
    await gated.waitForCalls(7);
    for (const id of [2, 9, 27]) gated.release(id);
    await gated.waitForCalls(8);
    gated.release(30);
    await service.waitForIdle();
    expect(gated.started()).toEqual([1, 2, 9, 27, 2, 9, 27, 30]);
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 30,
      attempted: 3, succeeded: 3, skipped: 2, failed: 0, failures: [] });
  });

  it.each([
    // Reviewer reproduction: C=4, B=3, traversal [1, 2, 9, 27], asset 2 faults.
    { label: 'after a committed prefix', faultId: 2, early: [1, 9],
      checkpoint: { cursor: 1, attempted: 1, succeeded: 1 },
      retried: [2, 9, 27], final: { attempted: 3, succeeded: 3, skipped: 1 } },
    { label: 'at the head', faultId: 1, early: [2, 9],
      checkpoint: { cursor: 0, attempted: 0, succeeded: 0 },
      retried: [1, 2, 9, 27], final: { attempted: 2, succeeded: 2, skipped: 2 } },
  ])('stops refill the moment an authority read faults $label while Preview stays pending', async (
    { faultId, early, checkpoint, retried, final },
  ) => {
    const scheduled = [];
    const logged = [];
    const gated = gatedPreview();
    const published = new Set();
    const tracker = createManagedUploadTracker();
    tracker.bindMaintenanceState({ active: false });
    const firstFault = new Error('Rebuild state unavailable');
    const faults = [];
    const trigger = deferred();
    let attempts = 0;
    const { service, repository, setPolicy } = fixture(async (projectId, id, target, authority, options) => {
      const faulting = id === faultId && attempts++ === 0;
      const generation = gated.preview(projectId, id, target, authority, options);
      if (faulting) {
        // After the window is dispatched: true, true, then a read fault that
        // Preview absorbs while it stays parked behind the gate.
        await trigger.promise;
        expect(authority()).toBe(true);
        expect(authority()).toBe(true);
        faults.push(firstFault);
        try { authority(); } catch (error) { expect(error).toBe(firstFault); }
      }
      const result = await generation;
      if (faulting) {
        // Later reads, successful or faulting, neither clear nor replace it.
        expect(authority()).toBe(true);
        faults.push(new Error('Later fault'));
        try { authority(); } catch { /* absorbed as well */ }
        return { status: 'ready' };
      }
      if (published.has(id)) return { status: 'ready' };
      published.add(id);
      return result;
    }, {
      extraIds: [9, 27], processingConcurrency: 4, tracker,
      get: (original) => () => {
        if (faults.length) throw faults.shift();
        return original();
      },
      applicationLogger: { error: (entry) => logged.push(entry) },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    const runId = repository.get().runId;
    service.signal();
    await gated.waitForCalls(3);
    await flush();
    expect(gated.started()).toEqual([1, 2, 9]);
    trigger.resolve();
    await flush();
    expect(faults).toEqual([]);
    let idle = false;
    const drained = service.waitForIdle().then(() => { idle = true; });
    for (const id of early) {
      gated.release(id);
      await flush();
      // Completions free window slots, but asset 27 is never dispatched.
      expect(gated.started()).toEqual([1, 2, 9]);
      expect(idle).toBe(false);
      expect(scheduled).toEqual([]);
      expect(logged).toEqual([]);
      expect(tracker.tryBeginMaintenance()).toBeNull();
    }
    expect(repository.get()).toMatchObject({ runId, phase: 'running', ...checkpoint, failed: 0, failures: [] });
    gated.release(faultId);
    await drained;
    expect(gated.started()).toEqual([1, 2, 9]);
    expect(repository.get()).toMatchObject({ runId, phase: 'running', ...checkpoint, failed: 0, failures: [] });
    expect(logged.map((entry) => entry.error)).toEqual([firstFault]);
    expect(logged[0].error).toBe(firstFault);
    expect(scheduled.map((item) => item.delay)).toEqual([250]);
    scheduled.shift().callback();
    let finished = false;
    const done = service.waitForIdle().then(() => { finished = true; });
    while (!finished) {
      await flush();
      for (const id of gated.started()) gated.release(id);
    }
    await done;
    expect(gated.started()).toEqual([1, 2, 9, ...retried]);
    expect(scheduled).toEqual([]);
    expect(repository.get()).toMatchObject({ runId, phase: 'completed', cursor: 27,
      ...final, failed: 0, failures: [] });
  });

  it('keeps an ordinary generation failure as an asset outcome without a runner retry', async () => {
    const scheduled = [];
    const gated = gatedPreview();
    const { service, repository, setPolicy } = fixture(gated.preview, {
      extraIds: [9], processingConcurrency: 4,
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await gated.waitForCalls(3);
    gated.release(1, new Error('Unreadable source'));
    gated.release(2);
    gated.release(9);
    await service.waitForIdle();
    expect(gated.started()).toEqual([1, 2, 9]);
    expect(scheduled).toEqual([]);
    expect(repository.get()).toMatchObject({ phase: 'completed_with_failures', cursor: 9,
      attempted: 3, succeeded: 2, failed: 1, failures: [{ assetId: 1, message: 'Unreadable source' }] });
  });

  it('treats an authority read that proves supersession as obsolete, not as a fault', async () => {
    const scheduled = [];
    const gated = gatedPreview((call) => call.quality === 70);
    const { service, repository, setPolicy } = fixture(async (projectId, id, target, authority, options) => {
      const result = await gated.preview(projectId, id, target, authority, options);
      if (!authority()) throw new Error('Target image policy is obsolete.');
      return result;
    }, {
      extraIds: [9], processingConcurrency: 4,
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    setPolicy(changed);
    service.queueAutomatic(base, changed);
    service.signal();
    await gated.waitForCalls(3);
    setPolicy(latest);
    service.queueAutomatic(changed, latest);
    service.signal();
    for (const id of [1, 2, 9]) gated.release(id);
    await service.waitForIdle();
    expect(gated.started(70)).toEqual([1, 2, 9]);
    expect(gated.started(85)).toEqual([1, 2, 9]);
    expect(scheduled).toEqual([]);
    expect(repository.get()).toMatchObject({ phase: 'completed', targetPolicy: latest, cursor: 9,
      attempted: 3, succeeded: 3, failed: 0, failures: [] });
  });

  it('stops dispatch and keeps the prior checkpoint when a window checkpoint fails', async () => {
    const scheduled = [];
    const gated = gatedPreview();
    const { service, repository } = fixture(gated.preview, {
      extraIds: [9, 27], processingConcurrency: 4,
      save: (original) => (record) => {
        if (record.phase === 'running' && record.cursor > 0) throw new Error('Checkpoint unavailable');
        return original(record);
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    });
    service.queueManual();
    service.signal();
    await gated.waitForCalls(3);
    gated.release(2);
    gated.release(1);
    gated.release(9);
    await service.waitForIdle();
    expect(gated.started()).toEqual([1, 2, 9]);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 0, attempted: 0 });
    expect(scheduled.map((item) => item.delay)).toEqual([250]);
    service.stop();
  });
});

describe('generated-image rebuild runner lifetime', () => {
  const quietLogger = { error() {}, info() {}, warn() {}, getRepository: () => null, rebindRepository() {} };

  // Nonblocking ownership probe: records whether replacement could have
  // taken the graph at this moment, handing any ownership straight back.
  function ownershipProbe(tracker) {
    const owner = tracker.tryBeginMaintenance();
    owner?.release();
    return { active: tracker.activeCount, replaceable: owner !== null };
  }

  it('keeps synchronous replacement out until the runner has checkpointed and finalized', async () => {
    const gated = gatedPreview();
    const writes = [];
    let context;
    let retired = false;
    let lateAccess = 0;
    const guard = (original) => (...args) => { if (retired) lateAccess++; return original(...args); };
    const { db, repository, service } = fixture(gated.preview, {
      processingConcurrency: 3, tracker: managedUploadTracker,
      get: guard, page: guard,
      save: (original) => (record) => {
        if (retired) lateAccess++;
        if (record.cursor > 0) {
          let replaceable;
          try { context.beginReplacement().release(); replaceable = true; } catch { replaceable = false; }
          writes.push({ phase: record.phase, cursor: record.cursor, open: db.open,
            active: managedUploadTracker.activeCount, replaceable });
        }
        return original(record);
      },
    });
    const newDb = openDatabase(':memory:');
    opened.push(newDb);
    const app = Object.assign(() => {}, { locals: { generatedImageRebuildService: service } });
    context = createApplicationContext({ appName: 'test', appOpts: { applicationLogger: quietLogger } }, db,
      ({ db: target }) => (target === db ? app : Object.assign(() => {}, { locals: {} })));
    await service.waitForIdle();
    service.queueManual();
    service.signal();
    await gated.waitForCalls(2);
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 0 });
    let atReplacement;
    const replaced = managedUploadTracker.waitForIdle().then(() => {
      const owner = context.beginReplacement();
      atReplacement = repository.get();
      closeDatabase(db);
      retired = true;
      context.replaceDatabase(newDb, owner);
      owner.release();
    });
    gated.release(1);
    gated.release(2);
    await replaced;
    await service.waitForIdle();
    await flush();
    // Both assets had settled (asset lifetimes zero) at every one of these
    // writes; only the runner's own lifetime kept replacement out.
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes.at(-1)).toMatchObject({ phase: 'completed', cursor: 2 });
    for (const write of writes) expect(write).toMatchObject({ open: true, active: 1, replaceable: false });
    expect(atReplacement).toMatchObject({ phase: 'completed', cursor: 2, succeeded: 2 });
    expect(context.db).toBe(newDb);
    expect(lateAccess).toBe(0);
    expect(managedUploadTracker.activeCount).toBe(0);
  });

  it('keeps the pause-then-wait replacement path deadlock-free', async () => {
    const gated = gatedPreview();
    const { db, repository, service } = fixture(gated.preview, {
      processingConcurrency: 3, tracker: managedUploadTracker,
    });
    const app = Object.assign(() => {}, { locals: { generatedImageRebuildService: service } });
    const context = createApplicationContext(
      { appName: 'test', appOpts: { applicationLogger: quietLogger } }, db, () => app);
    await service.waitForIdle();
    service.queueManual();
    service.signal();
    await gated.waitForCalls(2);
    const pending = context.beginReplacementAfterRebuild();
    gated.release(2);
    gated.release(1);
    const owner = await pending;
    expect(owner).toBeTruthy();
    expect(managedUploadTracker.activeCount).toBe(0);
    // The pause stopped refill; everything dispatched was checkpointed first.
    expect(repository.get()).toMatchObject({ cursor: 2, succeeded: 2 });
    // Release resumes the service, and its wake hands off to a successor
    // runner that finishes the run; each runner ends with its lifetime.
    owner.release();
    await service.waitForIdle();
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 2, succeeded: 2 });
    expect(managedUploadTracker.activeCount).toBe(0);
  });

  it.each([
    ['frontier checkpoint', (record) => record.phase === 'running' && record.cursor > 0],
    ['terminal finalizer', (record) => record.phase === 'completed'],
  ])('holds the runner lifetime through a %s fault, its retries, and the exhausted failed-state write',
    async (_label, faulty) => {
      const tracker = createManagedUploadTracker();
      const scheduled = [];
      const probes = [];
      let armed = false;
      const { service, repository } = fixture(async () => ({ cacheState: 'regenerated' }), {
        processingConcurrency: 3, tracker,
        save: (original) => (record) => {
          if (armed) probes.push({ phase: record.phase, cursor: record.cursor, ...ownershipProbe(tracker) });
          if (faulty(record)) throw new Error('State write unavailable');
          return original(record);
        },
        applicationLogger: { error: () => probes.push({ phase: 'fault', ...ownershipProbe(tracker) }) },
        schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
      });
      service.queueManual();
      service.signal();
      armed = true;
      await service.waitForIdle();
      const delays = [];
      while (scheduled.length) {
        expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
        const { callback, delay } = scheduled.shift();
        delays.push(delay);
        callback();
        await service.waitForIdle();
      }
      expect(delays).toEqual([250, 500, 1000]);
      expect(repository.get()).toMatchObject({ phase: 'failed', runnerError: 'State write unavailable' });
      expect(probes.filter((probe) => faulty(probe))).toHaveLength(4);
      expect(probes.filter((probe) => probe.phase === 'fault')).toHaveLength(4);
      expect(probes.at(-1)).toMatchObject({ phase: 'failed' });
      for (const probe of probes) expect(probe).toMatchObject({ active: 1, replaceable: false });
      expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    });

  it('releases the runner lifetime after an empty run and an idle signal', async () => {
    const tracker = createManagedUploadTracker();
    const { service, repository } = fixture(async () => ({ cacheState: 'regenerated' }), {
      tracker, page: () => () => [],
    });
    service.signal();
    expect(tracker.activeCount).toBe(1);
    await service.waitForIdle();
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    service.queueManual();
    service.signal();
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 0 });
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
  });

  // A real tracker whose lifetimes log each acquisition and completion, so
  // every acquired lifetime can be checked for exactly one completion.
  function countingTracker() {
    const tracker = createManagedUploadTracker();
    const completions = [];
    const events = [];
    const counted = Object.create(tracker, {
      begin: {
        value() {
          const lifetime = tracker.begin();
          if (!lifetime) return lifetime;
          const index = completions.push(0) - 1;
          events.push(`begin ${index}`);
          return { ...lifetime, complete() {
            completions[index]++;
            events.push(`complete ${index}`);
            lifetime.complete();
          } };
        },
      },
    });
    return { tracker: counted, completions, events };
  }

  // The first page read faults, so the first attempt leaves a same-run retry.
  function pendingRetryFixture(tracker, options = {}) {
    const scheduled = [];
    let pages = 0;
    const built = fixture(async () => ({ cacheState: 'regenerated' }), {
      tracker,
      page: (original) => (...args) => {
        if (++pages === 1) throw new Error('Transient page read');
        return original(...args);
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
      ...options,
    });
    built.setPolicy(changed);
    built.service.queueAutomatic(base, changed);
    return { ...built, scheduled };
  }

  it('releases a duplicate signal lifetime when a same-run retry is already pending', async () => {
    const { tracker, completions } = countingTracker();
    const { service, repository, scheduled } = pendingRetryFixture(tracker);
    const runId = repository.get().runId;
    service.signal();
    await service.waitForIdle();
    expect(scheduled.map((item) => item.delay)).toEqual([250]);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    service.signal();
    expect(completions).toEqual([1, 1]);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    await tracker.waitForIdle();
    // The pending timer stays the only retry, and it still runs the run.
    expect(scheduled).toHaveLength(1);
    scheduled.shift().callback();
    expect(tracker.activeCount).toBe(1);
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ runId, phase: 'completed', cursor: 2, succeeded: 2 });
    expect(scheduled).toHaveLength(0);
    expect(completions.every((count) => count === 1)).toBe(true);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
  });

  it('stops cleanly after a duplicate signal deferred to a pending retry', async () => {
    const { tracker, completions } = countingTracker();
    const { service, repository, scheduled } = pendingRetryFixture(tracker);
    service.signal();
    await service.waitForIdle();
    service.signal();
    service.stop();
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    scheduled.shift().callback();
    await service.waitForIdle();
    await tracker.waitForIdle();
    expect(repository.get().phase).toBe('running');
    expect(completions).toEqual([1, 1]);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
  });

  it('releases the signal lifetime and rethrows when the pending-retry state read throws', async () => {
    const { tracker, completions } = countingTracker();
    let readFault = null;
    const { service, repository, scheduled } = pendingRetryFixture(tracker, {
      get: (original) => () => { if (readFault) throw readFault; return original(); },
    });
    service.signal();
    await service.waitForIdle();
    readFault = new Error('State read unavailable');
    let thrown;
    try { service.signal(); } catch (error) { thrown = error; }
    expect(thrown).toBe(readFault);
    expect(completions).toEqual([1, 1]);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    await tracker.waitForIdle();
    readFault = null;
    expect(scheduled).toHaveLength(1);
    scheduled.shift().callback();
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 2, succeeded: 2 });
    expect(completions.every((count) => count === 1)).toBe(true);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
  });

  // Every rebuild-state read routes through a switchable fault and is logged
  // into the tracker's event stream, so a retry's lifetime acquisition can
  // be ordered against its first read.
  function unreadableFixture(preview = async () => ({ cacheState: 'regenerated' }), options = {}) {
    const { tracker, completions, events } = countingTracker();
    const scheduled = [];
    const logs = [];
    const state = { fault: null, reads: 0 };
    const built = fixture(preview, {
      tracker,
      get: (original) => () => {
        state.reads++;
        events.push('read');
        if (state.fault) throw state.fault;
        return original();
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
      applicationLogger: { error: (entry) => logs.push(entry) },
      ...options,
    });
    built.setPolicy(changed);
    built.service.queueAutomatic(base, changed);
    return { ...built, tracker, completions, events, scheduled, logs, state };
  }

  it('retries a queued run whose runner and recovery reads all fail, once the store recovers', async () => {
    const { service, repository, tracker, completions, events, scheduled, logs, state } = unreadableFixture();
    const runId = repository.get().runId;
    state.fault = new Error('State unavailable');
    service.signal();
    await service.waitForIdle();
    expect(scheduled.map((item) => item.delay)).toEqual([250]);
    expect(logs.map((entry) => entry.message)).toEqual([
      'Generated-image rebuild paused.', 'Could not read rebuild state after runner failure.']);
    expect(repository.get()).toMatchObject({ runId, phase: 'queued' });
    // The backoff holds no lifetime, so replacement is not blocked by it.
    expect(completions).toEqual([1]);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    state.fault = null;
    events.length = 0;
    scheduled.shift().callback();
    expect(events[0]).toMatch(/^begin /);
    await service.waitForIdle();
    expect(events.indexOf('read')).toBeGreaterThan(0);
    expect(repository.get()).toMatchObject({ runId, phase: 'completed', cursor: 2, succeeded: 2 });
    expect(scheduled).toHaveLength(0);
    expect(completions.every((count) => count === 1)).toBe(true);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
  });

  it('resumes a running record from its durable cursor after a fault whose recovery read also fails', async () => {
    const seen = [];
    const pageFault = new Error('Transient page read');
    let pages = 0;
    const fx = unreadableFixture(async (_projectId, id) => { seen.push(id); return { cacheState: 'regenerated' }; }, {
      page: (original) => (...args) => {
        if (++pages === 1) { fx.state.fault = new Error('State unavailable'); throw pageFault; }
        return original(...args);
      },
    });
    const { service, repository, scheduled, logs, state } = fx;
    repository.save({ ...repository.get(), phase: 'running', started: true, cursor: 1, attempted: 1, succeeded: 1 });
    service.signal();
    await service.waitForIdle();
    expect(scheduled.map((item) => item.delay)).toEqual([250]);
    expect(logs[0]).toMatchObject({ message: 'Generated-image rebuild paused.', error: pageFault });
    expect(logs[1]).toMatchObject({ message: 'Could not read rebuild state after runner failure.', error: state.fault });
    expect(repository.get()).toMatchObject({ phase: 'running', cursor: 1, attempted: 1, succeeded: 1 });
    state.fault = null;
    scheduled.shift().callback();
    await service.waitForIdle();
    expect(seen).toEqual([2]);
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 2, attempted: 2, succeeded: 2, failed: 0 });
  });

  it('spends the bounded budget while state stays unreadable, then stops without claiming a failed save', async () => {
    const { service, repository, tracker, completions, scheduled, logs, state } = unreadableFixture();
    const runId = repository.get().runId;
    state.fault = new Error('State unavailable');
    service.signal();
    await service.waitForIdle();
    for (const delay of [250, 500, 1000]) {
      expect(scheduled.map((item) => item.delay)).toEqual([delay]);
      scheduled.shift().callback();
      await service.waitForIdle();
    }
    expect(scheduled).toHaveLength(0);
    expect(logs.filter((entry) => entry.message.includes('exhausted retries'))).toEqual([
      expect.objectContaining({ message: expect.stringContaining('could not read state to persist failed state'),
        error: state.fault })]);
    expect(completions).toEqual([1, 1, 1, 1]);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    state.fault = null;
    expect(repository.get()).toMatchObject({ runId, phase: 'queued' });
    // Exhaustion leaves no timer; a later external signal picks the run up.
    service.signal();
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ runId, phase: 'completed', cursor: 2, succeeded: 2 });
  });

  it.each(['pause', 'stop'])('neutralizes an unreadable-state retry on %s without touching the store', async (mode) => {
    const { service, repository, tracker, completions, scheduled, state } = unreadableFixture();
    state.fault = new Error('State unavailable');
    service.signal();
    await service.waitForIdle();
    expect(scheduled).toHaveLength(1);
    const pause = mode === 'pause' ? service.pauseForMaintenance() : null;
    if (!pause) service.stop();
    const reads = state.reads;
    scheduled.shift().callback();
    expect(state.reads).toBe(reads);
    expect(completions).toEqual([1]);
    await (pause ?? service).waitForIdle();
    await tracker.waitForIdle();
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    state.fault = null;
    if (pause) {
      pause.release();
      await service.waitForIdle();
      expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 2, succeeded: 2 });
    } else {
      expect(repository.get().phase).toBe('queued');
    }
    expect(scheduled).toHaveLength(0);
    expect(completions.every((count) => count === 1)).toBe(true);
  });

  it('lets an unreadable-state retry observe a target that superseded it during backoff', async () => {
    const seen = [];
    const { service, repository, setPolicy, scheduled, state } = unreadableFixture(async (_projectId, id, target) => {
      seen.push([id, target.preview.webpQuality]);
      return { cacheState: 'regenerated' };
    });
    const obsoleteRunId = repository.get().runId;
    state.fault = new Error('State unavailable');
    service.signal();
    await service.waitForIdle();
    state.fault = null;
    setPolicy(latest);
    service.queueAutomatic(changed, latest);
    scheduled.shift().callback();
    await service.waitForIdle();
    expect(repository.get().runId).not.toBe(obsoleteRunId);
    expect(repository.get()).toMatchObject({ phase: 'completed', targetPolicy: latest });
    expect(seen).toEqual([[1, 85], [2, 85]]);
    expect(scheduled).toHaveLength(0);
  });

  it('keeps one unreadable-state retry and releases a duplicate signal lifetime while the store is down', async () => {
    const { service, repository, tracker, completions, scheduled, state } = unreadableFixture();
    state.fault = new Error('State unavailable');
    service.signal();
    await service.waitForIdle();
    let thrown;
    try { service.signal(); } catch (error) { thrown = error; }
    expect(thrown).toBe(state.fault);
    expect(completions).toEqual([1, 1]);
    expect(scheduled).toHaveLength(1);
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
    state.fault = null;
    scheduled.shift().callback();
    await service.waitForIdle();
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 2, succeeded: 2 });
    expect(scheduled).toHaveLength(0);
    expect(completions.every((count) => count === 1)).toBe(true);
  });

  it('hands a woken successor its lifetime before the predecessor releases, each exactly once', async () => {
    const { tracker, completions, events } = countingTracker();
    const gated = gatedPreview();
    const { service, repository } = fixture(gated.preview, { tracker, processingConcurrency: 3 });
    service.queueManual();
    service.signal();
    await gated.waitForCalls(2);
    // A duplicate signal against a live runner only requests a wake.
    service.signal(true);
    expect(completions).toHaveLength(3);
    gated.release(1);
    gated.release(2);
    await service.waitForIdle();
    await service.waitForIdle();
    await flush();
    expect(repository.get()).toMatchObject({ phase: 'completed', cursor: 2, succeeded: 2 });
    expect(completions).toEqual([1, 1, 1, 1]);
    expect(events.indexOf('begin 3')).toBeLessThan(events.indexOf('complete 0'));
    expect(ownershipProbe(tracker)).toEqual({ active: 0, replaceable: true });
  });
});
