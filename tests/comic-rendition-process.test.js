// Milestone A F1a — process-isolated comic rendition: the supervisor and its child.
// Real child processes and real Sharp workloads; protocol violations use a misbehaving stand-in
// child (helpers/fake-rendition-child.js). A child counts as gone only when the supervisor's
// 'close' confirmation fired and the operating system no longer knows its pid.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { makeAnimatedWebp } from './helpers/animated-webp.js';

const {
  COMIC_RENDITION_PROTOCOL, ComicRenditionProcessError, createComicRenditionSupervisor,
} = await import('../src/services/comic-rendition-process.js');
const { renderComicPageStill } = await import('../src/services/comic-media-service.js');

// Real 36 MP renditions (several per test) run while other comic suites load the CPU; the
// default 5 s budget is too tight under that contention. No assertion depends on it.
vi.setConfig({ testTimeout: 30_000 });

const FAKE_CHILD = fileURLToPath(new URL('./helpers/fake-rendition-child.js', import.meta.url));
const MIB = 1024 * 1024;
const LIMITS = Object.freeze({ maxPixels: 25_000_000, maxOutputBytes: 32 * MIB, maxWebpDimension: 16_383, timeoutSeconds: 30 });
const img = {};
const supervisors = [];

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A supervisor that records every child it launched and the moment each was confirmed gone.
function observed(options = {}) {
  const children = [];
  const supervisor = createComicRenditionSupervisor({
    ...options,
    hooks: {
      spawned: ({ pid }) => children.push({ pid, spawnedAt: performance.now(), exitedAt: null }),
      exited: ({ pid, code, signal }) => {
        Object.assign(children.find((child) => child.pid === pid), { exitedAt: performance.now(), code, signal });
      },
    },
  });
  supervisors.push(supervisor);
  return { supervisor, children };
}

const fake = (mode, ...args) => observed({ childModule: FAKE_CHILD, childArgs: [mode, ...args] });

function job(bytes, image, limits = LIMITS) {
  return { bytes, image, maxInputPixels: 100_000_000, limits };
}

const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

function expectAllGone(children) {
  for (const child of children) {
    expect(child.exitedAt).not.toBeNull();
    expect(alive(child.pid)).toBe(false);
  }
}

beforeAll(async () => {
  const raw = (width, height) => {
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) pixels.fill((y * 13) & 0xff, y * width * 3, (y + 1) * width * 3);
    return sharp(pixels, { raw: { width, height, channels: 3 } });
  };
  img.png = await raw(48, 64).png().toBuffer();
  img.jpeg = await raw(48, 64).jpeg().toBuffer();
  img.animatedWebp = await makeAnimatedWebp(3, { width: 20, height: 30 });
  img.animatedGif = await sharp([
    { create: { width: 16, height: 24, channels: 3, background: '#ff0000' } },
    { create: { width: 16, height: 24, channels: 3, background: '#00ff00' } },
  ], { join: { animated: true } }).gif({ loop: 0 }).toBuffer();
  const big = await raw(400, 600).jpeg({ quality: 95 }).toBuffer();
  img.truncatedJpeg = big.subarray(0, Math.floor(big.length / 3));
  // 36 MP, over the 25 MP bound: metadata, a whole-image stats() decode, then a downscale.
  img.costly = await raw(6000, 6000).png({ compressionLevel: 1 }).toBuffer();
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.close();
    expect(supervisor.snapshot()).toMatchObject({ state: 'closed', active: 0, terminating: 0 });
  }
});

afterAll(() => {
  for (const key of Object.keys(img)) delete img[key];
});

const PNG = { format: 'png', width: 48, height: 64, animated: false };
const COSTLY = { format: 'png', width: 6000, height: 6000, animated: false };

describe('rendition in a disposable child', () => {
  it('returns a validated "unchanged" verdict for a valid static page without sending its bytes back', async () => {
    const { supervisor, children } = observed();
    const result = await supervisor.run(job(img.png, PNG));
    expect(result).toEqual({ unchanged: true, mimeType: 'image/png', width: 48, height: 64 });
    const jpeg = await supervisor.run(job(img.jpeg, { ...PNG, format: 'jpeg' }));
    expect(jpeg).toEqual({ unchanged: true, mimeType: 'image/jpeg', width: 48, height: 64 });
    // One child per job, each confirmed gone before its job settled.
    expect(children).toHaveLength(2);
    expectAllGone(children);
    expect(supervisor.snapshot()).toMatchObject({ active: 0, launched: 2, exited: 2 });

    // Through the exported rendition contract, the caller's own buffer is returned.
    const still = await renderComicPageStill(img.png, PNG, { renditions: supervisor });
    expect(still).toMatchObject({ mimeType: 'image/png', width: 48, height: 64, converted: false });
    expect(still.bytes).toBe(img.png);
  });

  it('renders animated WebP and GIF pages as single-frame stills', async () => {
    const { supervisor, children } = observed();
    const webp = await supervisor.run(job(img.animatedWebp, { format: 'webp', width: 20, height: 30, animated: true }));
    expect(webp).toMatchObject({ unchanged: false, mimeType: 'image/webp', width: 20, height: 30 });
    expect(Buffer.isBuffer(webp.bytes)).toBe(true);
    expect((await sharp(webp.bytes).metadata()).pages ?? 1).toBe(1);
    const gif = await supervisor.run(job(img.animatedGif, { format: 'gif', width: 16, height: 24, animated: true }));
    expect(gif).toMatchObject({ unchanged: false, mimeType: 'image/png', width: 16, height: 24 });
    expect(await sharp(gif.bytes).metadata()).toMatchObject({ format: 'png', width: 16, height: 24 });
    expectAllGone(children);
  });

  it('rejects truncated pixel data and an oversized output from the real child', async () => {
    const { supervisor, children } = observed();
    const truncated = await settle(supervisor.run(job(img.truncatedJpeg, { format: 'jpeg', width: 400, height: 600, animated: false })));
    expect(truncated.error).toBeInstanceOf(ComicRenditionProcessError);
    expect(truncated.error.code).toBe('PAGE_INVALID_IMAGE');
    // A conversion over the output bound is refused by the child before it is sent.
    const tiny = await settle(supervisor.run(job(img.animatedGif, { format: 'gif', width: 16, height: 24, animated: true },
      { ...LIMITS, maxOutputBytes: 10 })));
    expect(tiny.error.code).toBe('RENDITION_LIMIT_EXCEEDED');
    expectAllGone(children);
  });

  it('bounds input before launching and refuses an already-cancelled job without a child', async () => {
    const { supervisor, children } = observed();
    const oversized = Buffer.alloc(COMIC_RENDITION_PROTOCOL.maxInputBytes + 1);
    expect((await settle(supervisor.run(job(oversized, PNG)))).error.code).toBe('INPUT_LIMIT_EXCEEDED');
    await expect(supervisor.run(job(img.png, PNG, { ...LIMITS, maxOutputBytes: 33 * MIB }))).rejects.toThrow(TypeError);
    const controller = new AbortController();
    controller.abort();
    expect((await settle(supervisor.run(job(img.png, PNG), { signal: controller.signal }))).error.code).toBe('CANCELLED');
    expect((await settle(renderComicPageStill(img.png, PNG, { renditions: supervisor, signal: controller.signal }))).error)
      .toMatchObject({ code: 'CANCELLED', status: 503 });
    expect(children).toHaveLength(0);
    expect(supervisor.snapshot().launched).toBe(0);
  });
});

describe('genuine cancellation of native Sharp work', () => {
  // Abort when the child reports that a native operation has started; measure until settled.
  async function cancelAt(supervisor, children, phase) {
    const controller = new AbortController();
    const phases = [];
    let abortedAt = null;
    const outcome = await settle(supervisor.run(job(img.costly, COSTLY), {
      signal: controller.signal,
      onPhase: (name) => {
        phases.push(name);
        if (name === phase) {
          abortedAt = performance.now();
          controller.abort();
        }
      },
    }));
    const settledAt = performance.now();
    const child = children.at(-1);
    return { outcome, phases, abortedAt, settledAt, child, controller };
  }

  it('kills the child during a real stats() and during a real conversion, and settles only after it is gone', async () => {
    const { supervisor, children } = observed();
    // Uncancelled reference: the full rendition of the same page.
    const startedAt = performance.now();
    const full = await supervisor.run(job(img.costly, COSTLY));
    const fullMs = performance.now() - startedAt;
    expect(full).toMatchObject({ unchanged: false, mimeType: 'image/png', width: 5000, height: 5000 });

    for (const phase of ['stats', 'convert']) {
      const { outcome, phases, abortedAt, settledAt, child, controller } = await cancelAt(supervisor, children, phase);
      expect(outcome.error.code).toBe('CANCELLED');
      expect(phases.at(-1)).toBe(phase);
      // Confirmed exit came before the job settled, after the abort; the process is gone.
      expect(child.exitedAt).toBeGreaterThanOrEqual(abortedAt);
      expect(child.exitedAt).toBeLessThanOrEqual(settledAt);
      expect(alive(child.pid)).toBe(false);
      expect(child.signal).toBe('SIGKILL');
      // Native work did not run to its end: the cancellation settled long before it could have.
      expect(settledAt - abortedAt).toBeLessThan(Math.min(1_000, fullMs / 2));
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
    expect(supervisor.snapshot()).toMatchObject({ active: 0, terminating: 0 });
  });

  it('leaves no child process behind across repeated cancellations at every phase', async () => {
    const { supervisor, children } = observed();
    for (const phase of ['metadata', 'stats', 'convert', 'metadata', 'stats', 'convert']) {
      const { outcome } = await cancelAt(supervisor, children, phase);
      expect(outcome.error.code).toBe('CANCELLED');
    }
    expect(children).toHaveLength(6);
    expectAllGone(children);
    expect(supervisor.snapshot()).toMatchObject({ active: 0, terminating: 0, launched: 6, exited: 6 });
  });

  it('enforces the parent-owned deadline while native work runs', async () => {
    const { supervisor, children } = observed();
    const startedAt = performance.now();
    await supervisor.run(job(img.costly, COSTLY));
    const fullMs = performance.now() - startedAt;

    const phases = [];
    const deadlineMs = Math.max(400, Math.round(fullMs / 2));
    const begun = performance.now();
    const outcome = await settle(supervisor.run(job(img.costly, COSTLY), { deadlineMs, onPhase: (name) => phases.push(name) }));
    const elapsed = performance.now() - begun;
    expect(outcome.error.code).toBe('TIMEOUT');
    // Native work had started and was still running when the deadline killed it.
    expect(phases).toContain('metadata');
    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 5);
    expect(elapsed).toBeLessThan(fullMs);
    expectAllGone(children);

    // Through the service contract: the established structured timeout outcome.
    const page = await settle(renderComicPageStill(img.costly, COSTLY, {
      renditions: supervisor, limits: { ...LIMITS, timeoutSeconds: 1 },
    }));
    if (fullMs > 1_300) {
      expect(page.error).toMatchObject({ status: 503, code: 'DECODER_UNAVAILABLE', reason: 'TIMEOUT' });
      expect(page.error.message).toBe('The comic cannot be read right now.');
    }
    expectAllGone(children);
  });

  it('never accepts a result that completes after the deadline, even when the timer runs late', async () => {
    const { supervisor, children } = fake('late', '100');
    let blocked = 0;
    // Once the job is running, block this event loop past the deadline: the child's valid result
    // arrives meanwhile, so the result and the late timer become due together.
    const outcome = await settle(supervisor.run(job(img.png, PNG), {
      deadlineMs: 300,
      onPhase: () => {
        const until = performance.now() + 900;
        while (performance.now() < until) blocked += 1;
      },
    }));
    expect(blocked).toBeGreaterThan(0);
    expect(outcome.error.code).toBe('TIMEOUT');
    expectAllGone(children);
  });
});

describe('protocol failures', () => {
  const cases = [
    ['garbage', 'PROTOCOL_ERROR'],
    ['malformed-result', 'PROTOCOL_ERROR'],
    ['extra-key', 'PROTOCOL_ERROR'],
    ['unknown-type', 'PROTOCOL_ERROR'],
    ['phase-order', 'PROTOCOL_ERROR'],
    ['duplicate', 'PROTOCOL_ERROR'],
    ['oversized', 'OUTPUT_LIMIT_EXCEEDED'],
    ['exit-after-job', 'CHILD_EXITED'],
    ['crash-after-job', 'CHILD_EXITED'],
    ['exit-before-ready', 'STARTUP_FAILED'],
    ['wrong-version', 'PROTOCOL_ERROR'],
  ];

  for (const [mode, code] of cases) {
    it(`fails safely when the child ${mode.replaceAll('-', ' ')}`, async () => {
      const { supervisor, children } = fake(mode);
      const outcome = await settle(supervisor.run(job(img.png, PNG)));
      expect(outcome.error).toBeInstanceOf(ComicRenditionProcessError);
      expect(outcome.error.code).toBe(code);
      expect(outcome.value).toBeUndefined();
      expectAllGone(children);
      // Mapped to the existing outcomes without leaking anything from the child.
      const page = await settle(renderComicPageStill(img.png, PNG, { renditions: supervisor }));
      expect(page.error.status).toBe(code === 'OUTPUT_LIMIT_EXCEEDED' ? 422 : 503);
      expect(page.error.message).not.toMatch(/secret|shell|child|protocol/i);
      expectAllGone(children);
    });
  }

  it('refuses an "unchanged" verdict for a page that must be converted', async () => {
    const { supervisor, children } = fake('unchanged-animated');
    const outcome = await settle(supervisor.run(job(img.animatedGif, { format: 'gif', width: 48, height: 64, animated: true })));
    expect(outcome.error.code).toBe('PROTOCOL_ERROR');
    expectAllGone(children);
  });

  it('enforces the pixel limit on a converted result itself, beside the source-area bound (P3-A)', async () => {
    // A 36 MP source, so only the job's 25 MP limit can refuse a 6000×6000 claim.
    const SOURCE = { format: 'jpeg', width: 6000, height: 6000, animated: false };
    const claim = async (width, height) => {
      const { supervisor, children } = fake('converted', String(width), String(height));
      const outcome = await settle(supervisor.run(job(img.jpeg, SOURCE)));
      expectAllGone(children);
      return outcome;
    };
    const over = await claim(6000, 6000);
    expect(over.error).toBeInstanceOf(ComicRenditionProcessError);
    expect(over.error.code).toBe('PROTOCOL_ERROR');
    expect(over.value).toBeUndefined();
    expect((await claim(5001, 5000)).error.code).toBe('PROTOCOL_ERROR');
    // At and under the limit: accepted as sent.
    expect((await claim(5000, 5000)).value).toMatchObject({ unchanged: false, mimeType: 'image/jpeg', width: 5000, height: 5000 });
    expect((await claim(25_000_000, 1)).value).toMatchObject({ width: 25_000_000, height: 1 });
    expect((await claim(3000, 4000)).value).toMatchObject({ width: 3000, height: 4000 });
    // Invalid or unsafe dimensions, including pairs whose product would lose precision.
    for (const [width, height] of [[0, 100], [100, -1], [1.5, 100], ['NaN', 100], [2 ** 53, 1], [1e300, 1e300]]) {
      expect((await claim(width, height)).error.code).toBe('PROTOCOL_ERROR');
    }
    // The source-area bound still applies under a looser pixel limit.
    const { supervisor, children } = fake('converted', '7000', '7000');
    const larger = await settle(supervisor.run(job(img.jpeg, SOURCE, { ...LIMITS, maxPixels: 100_000_000 })));
    expect(larger.error.code).toBe('PROTOCOL_ERROR');
    expectAllGone(children);
    // Mapped to the existing structured outcome through the service contract.
    const page = await settle(renderComicPageStill(img.jpeg, SOURCE, { renditions: fake('converted', '6000', '6000').supervisor }));
    expect(page.error.status).toBe(503);
  });

  it('times out a child that never becomes ready, or never answers', async () => {
    for (const mode of ['never-ready', 'ignore']) {
      const { supervisor, children } = fake(mode);
      expect((await settle(supervisor.run(job(img.png, PNG), { deadlineMs: 1_500 }))).error.code).toBe('TIMEOUT');
      expectAllGone(children);
    }
  });

  it('reports a child module that cannot start', async () => {
    const { supervisor, children } = observed({ childModule: fileURLToPath(new URL('./helpers/does-not-exist.js', import.meta.url)) });
    expect((await settle(supervisor.run(job(img.png, PNG)))).error.code).toBe('STARTUP_FAILED');
    expectAllGone(children);
  });
});

describe('ownership and shutdown', () => {
  it('kills active children at close, awaits their exit, and refuses new jobs', async () => {
    const { supervisor, children } = fake('hang');
    const phases = [];
    const running = [1, 2].map(() => settle(supervisor.run(job(img.png, PNG), { onPhase: (name) => phases.push(name) })));
    await expect.poll(() => phases.length, { timeout: 10_000 }).toBe(2);
    expect(supervisor.snapshot()).toMatchObject({ active: 2 });
    const closing = supervisor.close();
    expect(supervisor.close()).toBe(closing);
    expect((await settle(supervisor.run(job(img.png, PNG)))).error.code).toBe('CLOSED');
    await closing;
    // The children spun in JavaScript (no handler could run) and were still killed.
    for (const outcome of await Promise.all(running)) expect(outcome.error.code).toBe('CLOSED');
    expect(children).toHaveLength(2);
    expectAllGone(children);
    expect(supervisor.snapshot()).toMatchObject({ state: 'closed', active: 0, launched: 2, exited: 2 });
  });

  it('terminates a real Sharp rendition at close', async () => {
    const { supervisor, children } = observed();
    let inStats;
    const reached = new Promise((resolve) => { inStats = resolve; });
    const running = settle(supervisor.run(job(img.costly, COSTLY), { onPhase: (name) => name === 'stats' && inStats() }));
    await reached;
    const closedAt = performance.now();
    await supervisor.close();
    expect(performance.now() - closedAt).toBeLessThan(1_000);
    expect((await running).error.code).toBe('CLOSED');
    expectAllGone(children);
  });
});

// F1b — the one preloaded spare. Real children and real Sharp, except where a lifecycle or
// protocol race needs the stand-in child. Waits poll observable state; no fixed sleeps decide.
describe('preloaded spare (F1b)', () => {
  const spareOf = (supervisor) => supervisor.snapshot().spare;
  const untilSpare = (supervisor, state) => expect.poll(() => spareOf(supervisor).state, { timeout: 15_000 }).toBe(state);
  const spares = (children) => children.filter((child) => child.spare);
  // `observed` records { pid } only; this variant also records which children were spares.
  function observedSpare(options = {}) {
    const children = [];
    const supervisor = createComicRenditionSupervisor({
      ...options,
      hooks: {
        spawned: ({ pid, spare }) => children.push({ pid, spare, spawnedAt: performance.now(), exitedAt: null }),
        exited: ({ pid, code, signal }) => {
          Object.assign(children.find((child) => child.pid === pid), { exitedAt: performance.now(), code, signal });
        },
      },
    });
    supervisors.push(supervisor);
    return { supervisor, children };
  }

  it('keeps exactly one idle, initialized spare that is sent nothing until a job claims it', async () => {
    // 'answer' replies to anything it receives: a job sent while idle would make the spare
    // talk, which retires it as failed. It stays ready, so nothing was sent.
    const { supervisor, children } = observedSpare({ childModule: FAKE_CHILD, childArgs: ['answer'] });
    expect(spareOf(supervisor).state).toBe('off');
    supervisor.preload();
    supervisor.preload();
    await untilSpare(supervisor, 'ready');
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ spare: true, exitedAt: null });
    expect(alive(children[0].pid)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spareOf(supervisor)).toEqual({ state: 'ready', launched: 1, claimed: 0, failed: 0 });
    expect(supervisor.snapshot()).toMatchObject({ active: 0, launched: 1, exited: 0 });
  });

  it('serves the first admitted job from the real spare, never reuses it and replenishes exactly one', async () => {
    const { supervisor, children } = observedSpare();
    supervisor.preload();
    await untilSpare(supervisor, 'ready');
    const [first] = children;
    const phases = [];
    const result = await supervisor.run(job(img.png, PNG), { onPhase: (name) => phases.push(name) });
    expect(result).toEqual({ unchanged: true, mimeType: 'image/png', width: 48, height: 64 });
    expect(phases).toEqual(['metadata', 'stats']);
    // The job ran in the spare (no cold child), which is gone; one replacement was launched.
    expect(first.exitedAt).not.toBeNull();
    expect(alive(first.pid)).toBe(false);
    expect(spareOf(supervisor)).toMatchObject({ claimed: 1 });
    await untilSpare(supervisor, 'ready');
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.spare)).toBe(true);
    expect(children[1].pid).not.toBe(first.pid);

    // Consecutive page turns: each consumes the ready spare; never more than one idle child.
    for (let turn = 0; turn < 4; turn += 1) {
      await untilSpare(supervisor, 'ready');
      await supervisor.run(job(img.jpeg, { ...PNG, format: 'jpeg' }));
      expect(children.filter((child) => child.exitedAt === null).length).toBeLessThanOrEqual(1);
    }
    await untilSpare(supervisor, 'ready');
    expect(spareOf(supervisor)).toEqual({ state: 'ready', launched: 6, claimed: 5, failed: 0 });
    expect(children).toHaveLength(6);
    expectAllGone(children.slice(0, 5));
  });

  it('renders identical output from a spare and from a cold child, and still rejects invalid pages', async () => {
    const cold = observedSpare();
    const warm = observedSpare();
    warm.supervisor.preload();
    const cases = [[img.animatedWebp, { format: 'webp', width: 20, height: 30, animated: true }],
      [img.animatedGif, { format: 'gif', width: 16, height: 24, animated: true }],
      [img.costly, COSTLY]];
    for (const [bytes, image] of cases) {
      await untilSpare(warm.supervisor, 'ready');
      const fromSpare = await warm.supervisor.run(job(bytes, image));
      const fromCold = await cold.supervisor.run(job(bytes, image));
      expect(fromSpare).toEqual(fromCold);
      expect(Buffer.compare(fromSpare.bytes, fromCold.bytes)).toBe(0);
    }
    await untilSpare(warm.supervisor, 'ready');
    const corrupt = await settle(warm.supervisor.run(job(img.truncatedJpeg, { format: 'jpeg', width: 400, height: 600, animated: false })));
    expect(corrupt.error).toMatchObject({ code: 'PAGE_INVALID_IMAGE' });
    expect(spareOf(warm.supervisor).claimed).toBe(4);
    expect(spares(cold.children)).toHaveLength(0);
  });

  it('uses a cold child at once when the spare is not ready, and bounds two concurrent jobs', async () => {
    const { supervisor, children } = observedSpare();
    supervisor.preload();
    // Not ready yet (it was launched in this tick): the job does not wait for it.
    expect(spareOf(supervisor).state).toBe('starting');
    const early = await supervisor.run(job(img.png, PNG));
    expect(early.unchanged).toBe(true);
    expect(spareOf(supervisor).claimed).toBe(0);
    await untilSpare(supervisor, 'ready');
    expect(spareOf(supervisor).launched).toBe(1);

    // Two at once: one claims the spare, the other starts cold; one replacement spare.
    const both = await Promise.all([1, 2].map(() => supervisor.run(job(img.png, PNG))));
    expect(both.map((result) => result.unchanged)).toEqual([true, true]);
    await untilSpare(supervisor, 'ready');
    expect(spareOf(supervisor)).toMatchObject({ launched: 2, claimed: 1, failed: 0 });
    // Children: spare 1 (claimed), cold (early), cold (concurrent), spare 2 (idle).
    expect(children).toHaveLength(4);
    expect(children.filter((child) => child.exitedAt === null)).toEqual([expect.objectContaining({ spare: true })]);
    expectAllGone(children.filter((child) => child.exitedAt !== null));
  });

  it('cancels a job at the claim and during native work in a claimed spare, confirming exit first', async () => {
    const { supervisor, children } = observedSpare();
    supervisor.preload();
    await untilSpare(supervisor, 'ready');

    // Already aborted: nothing is claimed.
    expect((await settle(supervisor.run(job(img.png, PNG), { signal: AbortSignal.abort() }))).error.code).toBe('CANCELLED');
    expect(spareOf(supervisor).claimed).toBe(0);

    // Aborted right after the claim (same tick): the claimed spare is killed and confirmed gone.
    const controller = new AbortController();
    const claimed = settle(supervisor.run(job(img.png, PNG), { signal: controller.signal }));
    expect(spareOf(supervisor).claimed).toBe(1);
    controller.abort();
    const atClaim = await claimed;
    expect(atClaim.error.code).toBe('CANCELLED');
    expect(children[0].exitedAt).not.toBeNull();
    expect(alive(children[0].pid)).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    // During a real stats() in a claimed spare.
    await untilSpare(supervisor, 'ready');
    const during = new AbortController();
    let abortedAt = null;
    const outcome = await settle(supervisor.run(job(img.costly, COSTLY), {
      signal: during.signal,
      onPhase: (name) => {
        if (name === 'stats') {
          abortedAt = performance.now();
          during.abort();
        }
      },
    }));
    const settledAt = performance.now();
    const child = children.find((entry) => entry.pid === children[1].pid);
    expect(outcome.error.code).toBe('CANCELLED');
    expect(child.spare).toBe(true);
    expect(child.exitedAt).toBeGreaterThanOrEqual(abortedAt);
    expect(child.exitedAt).toBeLessThanOrEqual(settledAt);
    expect(alive(child.pid)).toBe(false);
    expect(spareOf(supervisor)).toMatchObject({ claimed: 2, failed: 0 });
  });

  it('applies the whole deadline to a claimed spare and settles only after it is gone', async () => {
    const { supervisor, children } = observedSpare({ childModule: FAKE_CHILD, childArgs: ['hang'] });
    supervisor.preload();
    await untilSpare(supervisor, 'ready');
    const begun = performance.now();
    const outcome = await settle(supervisor.run(job(img.png, PNG), { deadlineMs: 300 }));
    const elapsed = performance.now() - begun;
    expect(outcome.error.code).toBe('TIMEOUT');
    expect(elapsed).toBeGreaterThanOrEqual(295);
    expect(children[0]).toMatchObject({ spare: true, signal: 'SIGKILL' });
    expect(children[0].exitedAt - begun).toBeLessThanOrEqual(elapsed);
    expect(alive(children[0].pid)).toBe(false);
  });

  it('retires a spare that fails before it is claimed, retries a bounded number of times, then stays cold', async () => {
    for (const mode of ['exit-before-ready', 'wrong-version', 'garbage-ready', 'never-ready']) {
      const { supervisor, children } = observedSpare({
        childModule: FAKE_CHILD, childArgs: [mode], spareRetryDelaysMs: [0, 0], spareReadyTimeoutMs: 300,
      });
      supervisor.preload();
      await expect.poll(() => spareOf(supervisor).state, { timeout: 15_000 }).toBe('disabled');
      expect(spareOf(supervisor)).toEqual({ state: 'disabled', launched: 3, claimed: 0, failed: 3 });
      expect(children).toHaveLength(3);
      expectAllGone(children);
      // No failed spare ever runs a job: the next job starts a cold child of its own, which
      // fails the same way with a structured outcome instead of succeeding.
      const outcome = await settle(supervisor.run(job(img.png, PNG), { deadlineMs: 500 }));
      expect(outcome.error).toBeInstanceOf(ComicRenditionProcessError);
      expect(['STARTUP_FAILED', 'PROTOCOL_ERROR', 'TIMEOUT']).toContain(outcome.error.code);
      expect(children).toHaveLength(4);
      expect(spareOf(supervisor)).toMatchObject({ launched: 3, claimed: 0 });
      expectAllGone(children);
    }
  });

  it('reports a spare module that cannot start without retrying forever', async () => {
    const { supervisor, children } = observedSpare({
      childModule: fileURLToPath(new URL('./helpers/does-not-exist.js', import.meta.url)), spareRetryDelaysMs: [0],
    });
    supervisor.preload();
    await expect.poll(() => spareOf(supervisor).state, { timeout: 15_000 }).toBe('disabled');
    expect(spareOf(supervisor)).toMatchObject({ launched: 2, failed: 2, claimed: 0 });
    expectAllGone(children);
  });

  it('handles a spare that exits unexpectedly, never claiming it, and replaces it', async () => {
    const { supervisor, children } = observedSpare({ spareRetryDelaysMs: [0] });
    supervisor.preload();
    await untilSpare(supervisor, 'ready');
    // The operating system kills the idle spare.
    process.kill(children[0].pid, 'SIGKILL');
    await expect.poll(() => children[0].exitedAt, { timeout: 15_000 }).not.toBeNull();
    expect(spareOf(supervisor)).toMatchObject({ failed: 1, claimed: 0 });
    // Retried after the (here zero) first delay; the replacement is a fresh, ready spare.
    await untilSpare(supervisor, 'ready');
    expect(children).toHaveLength(2);
    expect((await supervisor.run(job(img.png, PNG))).unchanged).toBe(true);
    expect(spareOf(supervisor)).toMatchObject({ claimed: 1, failed: 1 });

    // A spare that dies while idle (stand-in: ready, then exits) is never handed a job.
    const flaky = observedSpare({ childModule: FAKE_CHILD, childArgs: ['ready-then-exit', '50'], spareRetryDelaysMs: [0, 0] });
    flaky.supervisor.preload();
    await expect.poll(() => spareOf(flaky.supervisor).state, { timeout: 15_000 }).toBe('disabled');
    expect(spareOf(flaky.supervisor)).toMatchObject({ launched: 3, failed: 3, claimed: 0 });
    expectAllGone(flaky.children);
  }, 20_000);

  it('closes an idle spare, stops replenishment and refuses work, idempotently', async () => {
    const { supervisor, children } = observedSpare();
    supervisor.preload();
    await untilSpare(supervisor, 'ready');
    const closing = supervisor.close();
    expect(supervisor.close()).toBe(closing);
    supervisor.preload();
    await closing;
    expectAllGone(children);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({ state: 'closed', active: 0, launched: 1, exited: 1 });
    expect(spareOf(supervisor).state).toBe('off');
    expect((await settle(supervisor.run(job(img.png, PNG)))).error.code).toBe('CLOSED');
    await new Promise((resolve) => setImmediate(resolve));
    expect(children).toHaveLength(1);
  });

  it('closes a claimed spare, a cold child and the replacement spare together, awaiting each exit', async () => {
    const { supervisor, children } = observedSpare({ childModule: FAKE_CHILD, childArgs: ['hang'] });
    supervisor.preload();
    await untilSpare(supervisor, 'ready');
    const phases = [];
    const running = [1, 2].map(() => settle(supervisor.run(job(img.png, PNG), { onPhase: (name) => phases.push(name) })));
    await expect.poll(() => phases.length, { timeout: 10_000 }).toBe(2);
    // Close while the replacement may still be starting.
    await supervisor.close();
    for (const outcome of await Promise.all(running)) expect(outcome.error.code).toBe('CLOSED');
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(children.length).toBeLessThanOrEqual(3);
    expectAllGone(children);
    expect(supervisor.snapshot()).toMatchObject({ state: 'closed', active: 0, terminating: 0 });
    expect(supervisor.snapshot().launched).toBe(supervisor.snapshot().exited);
  });

  it('closes a spare that is still starting', async () => {
    const { supervisor, children } = observedSpare();
    supervisor.preload();
    expect(spareOf(supervisor).state).toBe('starting');
    await supervisor.close();
    expect(children).toHaveLength(1);
    expectAllGone(children);
  });

  it('leaves no process behind across repeated spare-served requests and rapid cancellation', async () => {
    const { supervisor, children } = observedSpare();
    supervisor.preload();
    for (let round = 0; round < 6; round += 1) {
      const controller = new AbortController();
      const pending = settle(supervisor.run(job(img.png, PNG), { signal: controller.signal }));
      if (round % 2 === 1) controller.abort();
      const outcome = await pending;
      if (round % 2 === 1) expect(outcome.error.code).toBe('CANCELLED');
      else expect(outcome.value.unchanged).toBe(true);
    }
    await supervisor.close();
    expectAllGone(children);
    expect(supervisor.snapshot().launched).toBe(children.length);
    expect(supervisor.snapshot().exited).toBe(children.length);
    expect(spares(children).length).toBeLessThanOrEqual(7);
  });

  it('never preloads in the process-wide default supervisor', async () => {
    const { defaultComicRenditionSupervisor } = await import('../src/services/comic-rendition-process.js');
    expect(defaultComicRenditionSupervisor().snapshot().spare.state).toBe('off');
  });
});
