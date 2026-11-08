// A3.3b-1 — comic admission: bounded active work, bounded waiting, cancellation, wait
// deadlines, release on every outcome and the background lane A3.3b-2 preparation will use.
// Tasks are gated by explicit promises, so no assertion depends on timing.
import { describe, expect, it } from 'vitest';
import {
  COMIC_ADMISSION_DEFAULTS,
  ComicAdmissionError,
  createComicAdmission,
  estimateComicOperationBytes,
} from '../src/services/comic-admission.js';

const MIB = 1024 * 1024;

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

// Starts a task that records its start and waits for its gate.
function gated(admission, log, name, options = {}) {
  const g = gate();
  const started = gate();
  const result = admission.run(async () => {
    log.push(name);
    started.open();
    await g.promise;
    if (options.fail) throw new Error(name + ' failed');
    return name;
  }, { weightBytes: MIB, ...options });
  result.catch(() => {});
  return { result, open: g.open, started: started.promise };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function codeOf(promise) {
  const err = await promise.then(() => null, (caught) => caught);
  expect(err).toBeInstanceOf(ComicAdmissionError);
  return err.code;
}

function expectIdle(admission) {
  expect(admission.snapshot()).toEqual({ active: 0, activeBackground: 0, reservedBytes: 0, queued: 0, queuedBackground: 0 });
}

describe('bounded active work', () => {
  it('never runs more than maxActive and admits waiting work in FIFO order', async () => {
    const admission = createComicAdmission({ maxActive: 2 });
    const log = [];
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((name) => gated(admission, log, name));
    await Promise.all([tasks[0].started, tasks[1].started]);
    expect(log).toEqual(['a', 'b']);
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 3 });

    tasks[1].open();
    await tasks[2].started;
    expect(log).toEqual(['a', 'b', 'c']);
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 2 });
    for (const task of tasks) task.open();
    expect(await Promise.all(tasks.map((task) => task.result))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(log).toEqual(['a', 'b', 'c', 'd', 'e']);
    expectIdle(admission);
  });

  it('bounds summed weight, never lets a light request overtake a heavy head, and clamps oversized weights', async () => {
    const admission = createComicAdmission({ maxActive: 3, memoryBudgetBytes: 100 * MIB, foregroundReserveBytes: 40 * MIB });
    const log = [];
    const first = gated(admission, log, 'first', { weightBytes: 60 * MIB });
    const heavy = gated(admission, log, 'heavy', { weightBytes: 60 * MIB });
    const light = gated(admission, log, 'light', { weightBytes: 1 * MIB });
    await first.started;
    await flush();
    // 'light' would fit the budget but waits behind the heavy head.
    expect(log).toEqual(['first']);
    expect(admission.snapshot()).toMatchObject({ active: 1, reservedBytes: 60 * MIB, queued: 2 });
    first.open();
    await Promise.all([heavy.started, light.started]);
    expect(log).toEqual(['first', 'heavy', 'light']);
    heavy.open();
    light.open();
    await Promise.all([first.result, heavy.result, light.result]);

    // A weight above the whole budget runs, alone.
    const huge = gated(admission, log, 'huge', { weightBytes: 500 * MIB });
    const after = gated(admission, log, 'after', { weightBytes: 1 * MIB });
    await huge.started;
    await flush();
    expect(admission.snapshot()).toMatchObject({ active: 1, reservedBytes: 100 * MIB, queued: 1 });
    huge.open();
    after.open();
    await Promise.all([huge.result, after.result]);
    expectIdle(admission);
  });
});

describe('bounded waiting', () => {
  it('refuses at once when the queue is full, without running or retaining the request', async () => {
    const admission = createComicAdmission({ maxActive: 1, maxQueued: 2 });
    const log = [];
    const running = gated(admission, log, 'running');
    const waiting = [gated(admission, log, 'w1'), gated(admission, log, 'w2')];
    let ran = false;
    expect(await codeOf(admission.run(() => { ran = true; }, { weightBytes: MIB }))).toBe('QUEUE_FULL');
    expect(ran).toBe(false);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 2 });
    running.open();
    for (const task of waiting) task.open();
    await Promise.all([running.result, ...waiting.map((task) => task.result)]);
    expectIdle(admission);

    // maxQueued 0: admitted immediately or refused, never waits.
    const noWait = createComicAdmission({ maxActive: 1, maxQueued: 0 });
    const only = gated(noWait, log, 'only');
    expect(await codeOf(noWait.run(() => {}, { weightBytes: MIB }))).toBe('QUEUE_FULL');
    only.open();
    await only.result;
    expectIdle(noWait);
  });

  it('removes a cancelled queued request, never starts it, and lets later work proceed', async () => {
    const admission = createComicAdmission({ maxActive: 1 });
    const log = [];
    const running = gated(admission, log, 'running');
    const controller = new AbortController();
    const cancelled = gated(admission, log, 'cancelled', { signal: controller.signal });
    const later = gated(admission, log, 'later');
    expect(admission.snapshot().queued).toBe(2);
    controller.abort();
    expect(await codeOf(cancelled.result)).toBe('CANCELLED');
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1 });
    running.open();
    later.open();
    await Promise.all([running.result, later.result]);
    expect(log).toEqual(['running', 'later']);
    expectIdle(admission);

    // Already aborted: refused before queueing.
    const aborted = AbortSignal.abort();
    expect(await codeOf(admission.run(() => {}, { weightBytes: MIB, signal: aborted }))).toBe('CANCELLED');
    expectIdle(admission);
  });

  it('times out a wait without starting the work, and a shorter per-call wait applies', async () => {
    const admission = createComicAdmission({ maxActive: 1, queueTimeoutMs: 10_000 });
    const log = [];
    const running = gated(admission, log, 'running');
    let ran = false;
    expect(await codeOf(admission.run(() => { ran = true; }, { weightBytes: MIB, queueTimeoutMs: 15 }))).toBe('ADMISSION_TIMEOUT');
    expect(ran).toBe(false);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
    // A per-call wait can only shorten the configured bound.
    const short = createComicAdmission({ maxActive: 1, queueTimeoutMs: 15 });
    const blocker = gated(short, log, 'blocker');
    expect(await codeOf(short.run(() => {}, { weightBytes: MIB, queueTimeoutMs: 60_000 }))).toBe('ADMISSION_TIMEOUT');
    running.open();
    blocker.open();
    await Promise.all([running.result, blocker.result]);
    expectIdle(admission);
    expectIdle(short);
  });
});

describe('release on every outcome', () => {
  it('releases after rejection, a synchronous throw and success, and keeps FIFO progress', async () => {
    const admission = createComicAdmission({ maxActive: 1 });
    const log = [];
    const first = gated(admission, log, 'first', { fail: true });
    const order = [];
    const sync = admission.run(() => { order.push('sync'); throw new TypeError('sync'); }, { weightBytes: MIB });
    const failing = admission.run(async () => { order.push('async'); throw new Error('async'); }, { weightBytes: MIB });
    const ok = admission.run(async () => { order.push('ok'); return 7; }, { weightBytes: MIB });
    first.open();
    await expect(first.result).rejects.toThrow('first failed');
    await expect(sync).rejects.toThrow(TypeError);
    await expect(failing).rejects.toThrow('async');
    expect(await ok).toBe(7);
    expect(order).toEqual(['sync', 'async', 'ok']);
    expectIdle(admission);
  });

  it('leaks no reservation across many mixed outcomes', async () => {
    const admission = createComicAdmission({ maxActive: 2, maxQueued: 500 });
    const runs = [];
    for (let i = 0; i < 300; i += 1) {
      const controller = new AbortController();
      const run = admission.run(async () => {
        await flush();
        if (i % 3 === 0) throw new Error('fail');
        return i;
      }, { weightBytes: (1 + (i % 5)) * MIB, signal: controller.signal });
      if (i % 7 === 0) controller.abort();
      runs.push(run.then(() => 'ok', (err) => err.code ?? 'error'));
    }
    const outcomes = await Promise.all(runs);
    expect(outcomes.filter((outcome) => outcome === 'CANCELLED').length).toBeGreaterThan(0);
    expect(outcomes.filter((outcome) => outcome === 'ok').length).toBeGreaterThan(0);
    expectIdle(admission);
  });
});

describe('background lane (A3.3b-2 preparation)', () => {
  it('keeps a slot and the reserve for the foreground and yields to waiting foreground work', async () => {
    const admission = createComicAdmission({
      maxActive: 2, memoryBudgetBytes: 100 * MIB, foregroundReserveBytes: 50 * MIB,
      maxBackgroundActive: 1, maxBackgroundQueued: 2,
    });
    const log = [];
    const prepA = gated(admission, log, 'prepA', { lane: 'background', weightBytes: 40 * MIB });
    await prepA.started;
    // Only one background at a time: the second waits even though a slot is free.
    const prepB = gated(admission, log, 'prepB', { lane: 'background', weightBytes: 40 * MIB });
    await flush();
    expect(admission.snapshot()).toMatchObject({ active: 1, activeBackground: 1, queuedBackground: 1 });
    // Foreground passes the waiting background request and gets the kept slot.
    const page = gated(admission, log, 'page', { weightBytes: 50 * MIB });
    await page.started;
    expect(log).toEqual(['prepA', 'page']);

    // With foreground work waiting, a freed background slot goes to the foreground.
    const page2 = gated(admission, log, 'page2', { weightBytes: 10 * MIB });
    prepA.open();
    await page2.started;
    expect(log).toEqual(['prepA', 'page', 'page2']);
    expect(admission.snapshot()).toMatchObject({ active: 2, activeBackground: 0, queuedBackground: 1 });
    // Background never takes the last slot or the reserve, even with no foreground waiting.
    page2.open();
    await page2.result;
    await flush();
    expect(log).toEqual(['prepA', 'page', 'page2']);
    page.open();
    await prepB.started;
    expect(admission.snapshot()).toMatchObject({ active: 1, activeBackground: 1, queuedBackground: 0 });
    prepB.open();
    await Promise.all([prepA.result, prepB.result, page.result]);
    expectIdle(admission);
  });

  it('bounds background waiting by its own queue, deadline and signal', async () => {
    const admission = createComicAdmission({
      maxActive: 2, memoryBudgetBytes: 100 * MIB, foregroundReserveBytes: 50 * MIB,
      maxBackgroundQueued: 1, backgroundQueueTimeoutMs: 20,
    });
    const log = [];
    const prep = gated(admission, log, 'prep', { lane: 'background', weightBytes: 40 * MIB });
    await prep.started;
    const waitingPrep = admission.run(() => {}, { lane: 'background', weightBytes: 40 * MIB });
    expect(await codeOf(admission.run(() => {}, { lane: 'background', weightBytes: 40 * MIB }))).toBe('QUEUE_FULL');
    expect(await codeOf(waitingPrep)).toBe('ADMISSION_TIMEOUT');
    const controller = new AbortController();
    const cancelled = admission.run(() => {}, { lane: 'background', weightBytes: 40 * MIB, signal: controller.signal });
    controller.abort();
    expect(await codeOf(cancelled)).toBe('CANCELLED');
    // Work that could never fit beside the foreground reserve is a configuration error.
    await expect(admission.run(() => {}, { lane: 'background', weightBytes: 60 * MIB })).rejects.toThrow(TypeError);
    prep.open();
    await prep.result;
    expectIdle(admission);
  });

  it('fits a default-limit solid preparation beside light foreground use only', async () => {
    const preparation = estimateComicOperationBytes('preparation', 'cbr');
    const { memoryBudgetBytes, foregroundReserveBytes } = COMIC_ADMISSION_DEFAULTS;
    expect(preparation).toBeLessThanOrEqual(memoryBudgetBytes - foregroundReserveBytes);
    // Two foreground decoder reads fit together; a third waits.
    const decoderPage = estimateComicOperationBytes('page', 'cb7');
    expect(2 * decoderPage).toBeLessThanOrEqual(memoryBudgetBytes);
    expect(3 * decoderPage).toBeGreaterThan(memoryBudgetBytes);
    // Tightened reader limits lower the estimate; CBZ never prepares.
    expect(estimateComicOperationBytes('manifest', 'cbr', { maxMemoryBytes: 64 * MIB }))
      .toBeLessThan(estimateComicOperationBytes('manifest', 'cbr'));
    expect(estimateComicOperationBytes('page', 'cbr', { maxMemoryBytes: 64 * MIB, maxMemberBytes: 16 * MIB }))
      .toBeLessThan(decoderPage);
    // F1a: a page's rendition share counts the child process (baseline, its input copy, the
    // Sharp reserve and one output-sized IPC copy) besides the member the parent holds.
    // F1b-P3: plus the parent's serialized job copy of the member and the explicit margin.
    const {
      COMIC_RENDITION_PROCESS_BYTES, COMIC_RENDITION_RESERVE_BYTES, COMIC_RENDITION_MARGIN_BYTES,
    } = await import('../src/services/comic-admission.js');
    expect(estimateComicOperationBytes('page', 'cbz')).toBe(64 * MIB + 64 * MIB + COMIC_RENDITION_PROCESS_BYTES
      + 64 * MIB + COMIC_RENDITION_RESERVE_BYTES + 32 * MIB + COMIC_RENDITION_MARGIN_BYTES);
    expect(() => estimateComicOperationBytes('preparation', 'cbz')).toThrow(TypeError);
  });

  it('covers the measured 96 MP page workload with headroom and keeps two default pages together (F1b-P3)', () => {
    const page = Math.max(estimateComicOperationBytes('page', 'cbz'), estimateComicOperationBytes('page', 'cbr'));
    expect(page).toBe(672 * MIB);
    // Linux, Node 24.19: 568-570 MiB (576 first run) for a 52.4 MiB member, 608-615.5 MiB for a
    // 62.3 MiB member, about 615-622 MiB extrapolated to the 64 MiB bound: at least 48 MiB above.
    expect(page - 622 * MIB).toBeGreaterThanOrEqual(48 * MIB);
    const { memoryBudgetBytes, foregroundReserveBytes, maxDecoderActive } = COMIC_ADMISSION_DEFAULTS;
    expect(memoryBudgetBytes).toBe(2 * page);
    expect(foregroundReserveBytes).toBe(page);
    expect(maxDecoderActive).toBe(2);
    // The budget alone would now fit three decoder-only operations: the decoder bound must hold.
    expect(3 * estimateComicOperationBytes('manifest', 'cbr')).toBeLessThanOrEqual(memoryBudgetBytes);
  });

  it('admits the default-limit combinations exactly as before the recalibration (F1b-P3)', async () => {
    const admission = createComicAdmission();
    const w = {
      page: estimateComicOperationBytes('page', 'cbr'),
      cbzPage: estimateComicOperationBytes('page', 'cbz'),
      manifest: estimateComicOperationBytes('manifest', 'cb7'),
      cbzManifest: estimateComicOperationBytes('manifest', 'cbz'),
      prep: estimateComicOperationBytes('preparation', 'cbr'),
    };
    const log = [];
    const start = (name, weight, options = {}) => gated(admission, log, name, { weightBytes: weight, ...options });

    // One large page; two run together; a third waits.
    const p1 = start('p1', w.page, { decoder: true, fail: true });
    const p2 = start('p2', w.cbzPage);
    const p3 = start('p3', w.cbzPage);
    await Promise.all([p1.started, p2.started]);
    await flush();
    expect(log).toEqual(['p1', 'p2']);
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 1, reservedBytes: w.page + w.cbzPage });
    // A failure releases its reservation; the waiting page then starts.
    p1.open();
    await expect(p1.result).rejects.toThrow('p1 failed');
    await p3.started;
    p2.open();
    p3.open();
    await Promise.all([p2.result, p3.result]);
    expectIdle(admission);

    // Three decoder operations fit the budget now, but only two run; the third heads the queue
    // (FIFO), so a CBZ manifest behind it waits too, as when the budget refused the third.
    const m = [1, 2, 3].map((n) => start('m' + n, w.manifest, { decoder: true }));
    const z = start('z', w.cbzManifest);
    await Promise.all([m[0].started, m[1].started]);
    await flush();
    expect(log.slice(3)).toEqual(['m1', 'm2']);
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 2, reservedBytes: 2 * w.manifest });
    m[0].open();
    await Promise.all([m[2].started, z.started]);
    expect(admission.snapshot()).toMatchObject({ active: 3, queued: 0 });
    for (const task of [...m, z]) task.open();
    await Promise.all([...m, z].map((task) => task.result));
    expectIdle(admission);

    // Background preparation: admitted when idle; the foreground keeps one page's memory and one
    // decoder slot, and a second decoder page waits as it did before.
    const prep = start('prep', w.prep, { lane: 'background', decoder: true });
    await prep.started;
    const f1 = start('f1', w.page, { decoder: true });
    await f1.started;
    const f2 = start('f2', w.page, { decoder: true });
    await flush();
    expect(admission.snapshot()).toMatchObject({ active: 2, activeBackground: 1, queued: 1 });
    // With a foreground decoder read active, no preparation is admitted beside it.
    prep.open();
    await f2.started;
    const prep2 = start('prep2', w.prep, { lane: 'background', decoder: true });
    await flush();
    expect(admission.snapshot()).toMatchObject({ active: 2, activeBackground: 0, queuedBackground: 1 });
    f1.open();
    f2.open();
    await prep2.started;
    prep2.open();
    await Promise.all([prep.result, f1.result, f2.result, prep2.result]);
    expectIdle(admission);
  });

  it('bounds decoder operations independently of weight and releases decoder slots on every outcome', async () => {
    const admission = createComicAdmission({ maxActive: 3, maxDecoderActive: 1, maxBackgroundActive: 0 });
    const log = [];
    const plain = gated(admission, log, 'plain');
    const a = gated(admission, log, 'a', { decoder: true, fail: true });
    const b = gated(admission, log, 'b', { decoder: true });
    const c = gated(admission, log, 'c', { decoder: true });
    await Promise.all([a.started, plain.started]);
    await flush();
    expect(log).toEqual(['plain', 'a']);
    // A queued decoder request heads the line: later foreground work never overtakes it.
    const after = gated(admission, log, 'after');
    await flush();
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 3 });
    a.open();
    await expect(a.result).rejects.toThrow('a failed');
    await b.started;
    const controller = new AbortController();
    const cancelled = admission.run(() => {}, { decoder: true, weightBytes: MIB, signal: controller.signal });
    controller.abort();
    expect(await codeOf(cancelled)).toBe('CANCELLED');
    b.open();
    await c.started;
    for (const task of [c, plain, after]) task.open();
    await Promise.all([b.result, c.result, plain.result, after.result]);
    expectIdle(admission);
    await expect(admission.run(() => {}, { weightBytes: MIB, decoder: 'yes' })).rejects.toThrow(TypeError);
    // A background decoder job needs a decoder slot to spare for the foreground.
    const single = createComicAdmission({ maxDecoderActive: 1, memoryBudgetBytes: 100 * MIB, foregroundReserveBytes: 10 * MIB });
    await expect(single.run(() => {}, { lane: 'background', decoder: true, weightBytes: MIB })).rejects.toThrow(TypeError);
    expect(await single.run(() => 'ok', { lane: 'background', weightBytes: MIB })).toBe('ok');
  });
});

describe('configuration', () => {
  it('rejects invalid options and keeps background below the foreground capacity', async () => {
    expect(() => createComicAdmission({ bogus: 1 })).toThrow(TypeError);
    expect(() => createComicAdmission({ maxActive: 0 })).toThrow(TypeError);
    expect(() => createComicAdmission({ maxActive: 2, maxBackgroundActive: 2 })).toThrow(TypeError);
    expect(() => createComicAdmission({ memoryBudgetBytes: 10 * MIB, foregroundReserveBytes: 10 * MIB })).toThrow(TypeError);
    expect(() => createComicAdmission({ maxActive: 1, maxBackgroundActive: 0 })).not.toThrow();
    const admission = createComicAdmission();
    await expect(admission.run(() => {}, {})).rejects.toThrow(TypeError);
    await expect(admission.run(() => {}, { weightBytes: MIB, lane: 'urgent' })).rejects.toThrow(TypeError);
    // A single-slot admission keeps no background slot unless one is requested (and refused).
    expect(createComicAdmission({ maxActive: 1 }).limits.maxBackgroundActive).toBe(0);
    expect(() => createComicAdmission({ maxActive: 1, maxBackgroundActive: 1 })).toThrow(TypeError);
    expectIdle(admission);
    expect(admission.limits).toMatchObject({ maxActive: 3, maxQueued: 32, maxBackgroundActive: 1 });
  });
});
