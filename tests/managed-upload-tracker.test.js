import { admittedUpload } from './helpers/book-upload-lifetime.js';
import { describe, expect, it, vi } from 'vitest';
import { ManagedImageError } from '../src/services/managed-image-service.js';
import { EventEmitter } from 'node:events';
import { createManagedUploadTracker } from '../src/services/managed-upload-tracker.js';
import { createBookWithUploadedCover as createBookWithUploadedCoverHandler } from '../src/middleware/book-create-multipart.js';
import { updateBookWithUploadedCover as updateBookWithUploadedCoverHandler } from '../src/middleware/book-edit-multipart.js';
import { admitBookUpload, isBookMultipartRequest, withBookUploadLifetime } from '../src/middleware/book-upload-lifetime.js';

it('provides exclusive maintenance capabilities without mutating active uploads on refusal', () => {
  const tracker = createManagedUploadTracker();
  const state = { active: false };
  tracker.bindMaintenanceState(state);
  tracker.bindMaintenanceState(state);
  expect(tracker.activeCount).toBe(0);
  const upload = tracker.begin();
  expect(tracker.tryBeginMaintenance()).toBeNull();
  expect(state.active).toBe(false);
  expect(upload.signal.aborted).toBe(false);
  const second = tracker.begin();
  upload.complete.call(second);
  expect(tracker.activeCount).toBe(1);
  expect(tracker.tryBeginMaintenance()).toBeNull();
  second.complete();
  const firstOwner = tracker.tryBeginMaintenance();
  expect(Object.isFrozen(firstOwner)).toBe(true);
  expect(state.active).toBe(true);
  expect(tracker.begin()).toBeNull();
  expect(tracker.tryBeginMaintenance()).toBeNull();
  state.active = false;
  expect(state.active).toBe(true);
  expect(firstOwner.release()).toBe(true);
  const owner = tracker.tryBeginMaintenance();
  expect(firstOwner.release.call(owner)).toBe(false);
  expect(tracker.begin()).toBeNull();
  const otherAuthority = createManagedUploadTracker();
  otherAuthority.tryBeginMaintenance().release();
  expect(state.active).toBe(true);
  expect(owner.release()).toBe(true);
  expect(owner.release()).toBe(false);
  expect(state.active).toBe(false);
  const last = tracker.begin();
  expect(last).not.toBeNull();
  last.complete();
});

it('keeps legacy maintenance closure compatible without allowing it to clear an owner', () => {
  const tracker = createManagedUploadTracker();
  const state = { active: true };
  tracker.bindMaintenanceState(state);
  expect(tracker.begin()).toBeNull();
  expect(tracker.tryBeginMaintenance()).toBeNull();
  state.active = false;
  const owner = tracker.tryBeginMaintenance();
  state.active = true;
  state.active = false;
  expect(state.active).toBe(true);
  owner.release();
  expect(state.active).toBe(false);
});

it.each([
  ['POST', '/notes/books', 'multipart/form-data', true],
  ['POST', '/NOTES/BOOKS/', 'Multipart/form-data', true],
  ['POST', '/Notes/Books/001/', 'multipart/mixed', true],
  ['POST', '/notes/books/reorder', 'multipart/form-data', false],
  ['POST', '/notes/books/1/delete', 'multipart/form-data', false],
  ['POST', '/unrelated', 'multipart/form-data', false],
  ['PUT', '/notes/books', 'multipart/form-data', false],
  ['POST', '/notes/books', 'application/x-www-form-urlencoded', false],
])('scopes admission to %s %s (%s)', (method, path, type, expected) => {
  expect(isBookMultipartRequest({ method, path, headers: { 'content-type': type } })).toBe(expected);
});

it('does not release on close between deferred router layers, or during a template callback', async () => {
  const tracker = createManagedUploadTracker();
  const req = new EventEmitter();
  const res = new EventEmitter();
  let rendered;
  res.render = (_view, _options, callback) => { rendered = callback; };
  res.send = vi.fn();
  req.next = vi.fn();
  const lifetime = admitBookUpload(req, res, tracker);
  res.emit('close');
  expect(lifetime.operation.signal.aborted).toBe(true);
  expect(tracker.activeCount).toBe(1);
  await withBookUploadLifetime((_req, response) => response.render('view'))(req, res, req.next);
  expect(tracker.activeCount).toBe(1);
  rendered(null, 'html');
  expect(res.send).toHaveBeenCalledWith('html');
  expect(tracker.activeCount).toBe(0);
});

it('keeps ownership across deferred error dispatch after a template callback fails', async () => {
  const tracker = createManagedUploadTracker();
  const req = new EventEmitter();
  const res = new EventEmitter();
  let rendered;
  res.render = (_view, _options, callback) => { rendered = callback; };
  res.end = vi.fn();
  req.next = vi.fn();
  admitBookUpload(req, res, tracker);
  await withBookUploadLifetime((_req, response) => response.render('view'))(req, res, req.next);
  rendered(new Error('render failed'));
  res.emit('close');
  res.emit('finish');
  expect(req.next).toHaveBeenCalledOnce();
  expect(tracker.activeCount).toBe(1);
  expect(tracker.tryBeginMaintenance()).toBeNull();
  res.end('safe error');
  expect(tracker.activeCount).toBe(0);
});

it('does not overwrite synchronous template-error forwarding when its route returns', async () => {
  const tracker = createManagedUploadTracker();
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.render = (_view, _options, callback) => callback(new Error('render failed'));
  res.end = vi.fn();
  req.next = vi.fn();
  admitBookUpload(req, res, tracker);
  await withBookUploadLifetime((_req, response) => response.render('view'))(req, res, req.next);
  expect(req.next).toHaveBeenCalledOnce();
  expect(tracker.activeCount).toBe(1);
  res.end('safe error');
  expect(tracker.activeCount).toBe(0);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

it('tracks independent operations and idempotent completion without cancellation releasing ownership', () => {
  const tracker = createManagedUploadTracker();
  expect(tracker.hasActive()).toBe(false);
  const a = tracker.begin();
  expect(tracker.activeCount).toBe(1);
  const b = tracker.begin();
  expect(a).not.toBe(b);
  a.cancel();
  expect(a.signal.aborted).toBe(true);
  expect(b.signal.aborted).toBe(false);
  expect(tracker.activeCount).toBe(2);
  a.complete();
  a.complete();
  expect(tracker.hasActive()).toBe(true);
  expect(tracker.activeCount).toBe(1);
  b.complete();
  b.cancel();
  expect(b.signal.aborted).toBe(false);
  expect(tracker.hasActive()).toBe(false);
});

describe.each(['new', 'edit'])('%s managed upload tracking', (mode) => {
  function setup() {
    const tracker = createManagedUploadTracker();
    const req = Object.assign(new EventEmitter(), { body: { title: 'Book', expectedCoverKind: 'none' } });
    const res = new EventEmitter();
    const save = vi.fn(() => {
      expect(tracker.hasActive()).toBe(true);
      return { id: 1 };
    });
    const service = {
      createCommittedImage: vi.fn(async () => {
        expect(tracker.hasActive()).toBe(true);
        return { record: { id: 'managed' }, ownershipToken: {} };
      }),
      rollbackCommitted: vi.fn(() => expect(tracker.hasActive()).toBe(true)),
      compensate: vi.fn(() => expect(tracker.hasActive()).toBe(true)),
    };
    const bookService = { validateCreateBook() {}, validateUpdateBook() {},
      createBookWithManagedPrimaryImage: save, updateBookWithManagedPrimaryImage: save };
    const run = (request = req, response = res) => {
      const deps = { bookService, managedImageService: service, managedUploadTracker: tracker };
      return mode === 'new' ? createBookWithUploadedCover(request, response, deps, Buffer.from('image'))
        : updateBookWithUploadedCover(request, response, deps, 1, Buffer.from('image'));
    };
    return { tracker, req, res, save, service, run };
  }
  function idle(s) {
    expect(s.tracker.activeCount).toBe(0);
    expect(s.req.listenerCount('aborted')).toBe(0);
    expect(s.res.listenerCount('close')).toBe(0);
  }
  it('stays active through ingestion and durable save, then ignores response disconnect', async () => {
    const s = setup();
    const gate = deferred();
    s.service.createCommittedImage.mockImplementation(async () => {
      expect(s.tracker.activeCount).toBe(1);
      await gate.promise;
      return { record: { id: 'managed' }, ownershipToken: {} };
    });
    const result = s.run();
    expect(s.tracker.hasActive()).toBe(true);
    gate.resolve();
    expect(await result).toEqual({ id: 1 });
    idle(s);
    s.res.emit('close');
    expect(s.service.rollbackCommitted).not.toHaveBeenCalled();
  });
  it.each(['INVALID_IMAGE', 'STORAGE_ERROR', 'RECOVERY_REQUIRED'])('releases after ingestion %s failure settles', async (code) => {
    const s = setup();
    const gate = deferred();
    s.service.createCommittedImage.mockImplementation(async () => { await gate.promise; throw new ManagedImageError(code); });
    const result = s.run();
    const rejected = expect(result).rejects.toMatchObject({ code });
    expect(s.tracker.hasActive()).toBe(true);
    gate.resolve();
    await rejected;
    idle(s);
  });
  it.each(['success', 'rollback-refused', 'compensation-failed'])('tracks failed save cleanup until %s terminates', async (outcome) => {
    const s = setup();
    const entered = deferred();
    const gate = deferred();
    s.save.mockImplementation(() => { throw new Error('book failed'); });
    s.service.rollbackCommitted.mockImplementation(async () => {
      expect(s.tracker.hasActive()).toBe(true);
      if (outcome === 'rollback-refused') { entered.resolve(); await gate.promise; throw new Error(); }
    });
    s.service.compensate.mockImplementation(async () => {
      expect(s.tracker.hasActive()).toBe(true);
      entered.resolve();
      await gate.promise;
      if (outcome === 'compensation-failed') throw new Error();
    });
    const result = s.run();
    const rejected = expect(result).rejects.toThrow(outcome === 'success' ? 'book failed' : 'requires recovery');
    await entered.promise;
    expect(s.tracker.hasActive()).toBe(true);
    gate.resolve();
    await rejected;
    idle(s);
    if (outcome === 'rollback-refused') expect(s.service.compensate).not.toHaveBeenCalled();
  });
  it.each(['aborted', 'close'])('keeps cancelled work active through ingestion and cleanup (%s)', async (event) => {
    const s = setup();
    const ingest = deferred();
    const cleaning = deferred();
    const cleanup = deferred();
    s.service.createCommittedImage.mockImplementation(async () => {
      await ingest.promise;
      return { record: { id: 'managed' }, ownershipToken: {} };
    });
    s.service.compensate.mockImplementation(async () => { cleaning.resolve(); await cleanup.promise; });
    const result = s.run();
    (event === 'aborted' ? s.req : s.res).emit(event);
    expect(s.tracker.hasActive()).toBe(true);
    ingest.resolve();
    await cleaning.promise;
    expect(s.tracker.hasActive()).toBe(true);
    cleanup.resolve();
    expect(await result).toBeNull();
    expect(s.save).not.toHaveBeenCalled();
    idle(s);
  });
  it('cancels only one concurrent request', async () => {
    const s = setup();
    const gate = deferred();
    const first = deferred();
    s.service.createCommittedImage.mockImplementationOnce(async () => { await first.promise; return { record: { id: 'a' }, ownershipToken: {} }; })
      .mockImplementationOnce(async () => { await gate.promise; return { record: { id: 'b' }, ownershipToken: {} }; });
    const a = s.run();
    s.req.emit('aborted');
    const otherReq = Object.assign(new EventEmitter(), { body: s.req.body });
    const otherRes = new EventEmitter();
    const b = s.run(otherReq, otherRes);
    expect(s.tracker.activeCount).toBe(2);
    first.resolve();
    expect(await a).toBeNull();
    expect(s.tracker.activeCount).toBe(1);
    gate.resolve();
    expect(await b).toEqual({ id: 1 });
    expect(s.save).toHaveBeenCalledOnce();
    idle(s);
  });
});

const createBookWithUploadedCover = admittedUpload(createBookWithUploadedCoverHandler);

const updateBookWithUploadedCover = admittedUpload(updateBookWithUploadedCoverHandler);

describe('shutdown admission and drain', () => {
  it('resolves immediately when idle and stays closed across maintenance cleanup', async () => {
    const tracker = createManagedUploadTracker();
    const state = { active: false };
    tracker.bindMaintenanceState(state);
    const owner = tracker.tryBeginMaintenance();
    tracker.beginShutdown();
    await tracker.waitForIdle();
    owner.release();
    owner.release();
    state.active = false;
    const rebuilt = { active: false };
    tracker.bindMaintenanceState(rebuilt);
    expect(state.active).toBe(true);
    expect(rebuilt.active).toBe(true);
    expect(tracker.begin()).toBeNull();
    expect(tracker.tryBeginMaintenance()).toBeNull();
    tracker.beginShutdown();
    await tracker.waitForIdle();
  });
  it.each([1, 2])('waits for all %s leases, not cancellation, with independent waiters', async (count) => {
    const tracker = createManagedUploadTracker();
    const leases = Array.from({ length: count }, () => tracker.begin());
    tracker.beginShutdown();
    const settled = vi.fn();
    const first = tracker.waitForIdle().then(settled);
    const second = tracker.waitForIdle().then(settled);
    for (const lease of leases) lease.cancel();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    if (count === 2) {
      leases[0].complete();
      leases[0].complete();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
    }
    leases.at(-1).complete();
    await Promise.all([first, second]);
    expect(settled).toHaveBeenCalledTimes(2);
    await tracker.waitForIdle();
    expect(tracker.begin()).toBeNull();
  });
  it('clears old waiters without affecting a later active lifetime', async () => {
    const tracker = createManagedUploadTracker();
    const first = tracker.begin();
    const idle = tracker.waitForIdle();
    first.complete();
    await idle;
    const second = tracker.begin();
    const settled = vi.fn();
    const later = tracker.waitForIdle().then(settled);
    first.complete();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    second.complete();
    await later;
  });
});
