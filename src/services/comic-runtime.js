// A3.3c-1 — Application ownership of comic resources
//
// The comic runtime owns, for the whole life of the application (one per process, created by
// server.js and handed to the application context like the processing pool), exactly:
//   - one comic admission (comic-admission.js): every comic manifest/page read and every
//     background preparation of every app graph waits in this one bounded state;
//   - one solid preparation cache (comic-preparation-cache.js) rooted at the reviewed automatic
//     private location for this installation (defaultComicPreparationCacheRoot(APP_DATA_ROOT):
//     platform temporary storage, never the app-data directory itself), protecting the projects
//     root;
//   - one rendition process supervisor (comic-rendition-process.js, F1a): every comic page
//     rendition of every graph runs in a disposable child process this supervisor launched and
//     tracks, so no graph or request ever owns a child of its own;
//   - F1b: when created with `renditionSpare` (the server's runtime only), that supervisor's one
//     preloaded spare child. It is launched once start() has settled (ready or degraded), so a
//     runtime that failed to start, never started or was built for a test or a rootless context
//     holds no idle child. The spare costs one idle child's resident memory
//     (COMIC_RENDITION_SPARE_BYTES) on top of the comic admission budget; see comic-admission.js.
//
// Lifecycle: created -> start() -> ready | degraded -> close() -> closed.
//   - start() runs the cache's recover() once. Only after it succeeds does `preparationCache`
//     return the cache, so a comic media service never sees a cache that has not been
//     recovered (the cache's own root trust, leftover removal and stranded accounting).
//   - recover() refusing the location (STAGING_UNAVAILABLE) is the exceptional degraded mode:
//     the cache is closed again (it published nothing), `preparationCache` stays null, comic
//     reads stay available on demand through the same admission, and no background preparation
//     runs. Any other recovery failure is not disguised as that: start() rejects with it.
//   - close() stops new preparations at once (the cache refuses schedule/lease from its first
//     step), cancels queued and running preparations, waits for their verified worker and
//     staging cleanup and for in-flight leases, removes published preparations, and resolves
//     with what remains on disk (stranded/strandedBytes/unmeasured). Idempotent. It also closes
//     the rendition supervisor in the same first step (no new rendition starts; active children
//     are killed, replenishment of the spare stops and the idle spare is killed) and resolves
//     only after every rendition child, spare included, is confirmed gone. An admission-only
//     ('disabled') runtime closes its supervisor the same way.
//
// App-graph replacement (live restore, auth reconfiguration) does not replace the runtime: the
// application context threads the same runtime into every graph it builds, so there is never a
// second admission, scheduler or cache owner. A graph's comic media service is stateless apart
// from these shared instances, and every read re-authorizes against the graph that serves it;
// a preparation is only ever served for the exact source identity, revision and page SHA-256 it
// was made from (comic-media-service.js), so preparations published before a replacement stay
// valid or are retired on their next use. F2: before a replacement retires a graph's database,
// the context pauses that graph's comic media service with its other background work: the
// graph's queued and running reads and preparations are cancelled and awaited (slots, workers,
// children and descriptors released) inside this shared runtime, which itself stays open.
//
// The admission has nothing of its own to close: it holds no timers or resources except for
// queued requests, and background requests only come from the cache's jobs, which close()
// cancels; foreground requests drain with the HTTP server.

import path from 'node:path';
import { createComicAdmission } from './comic-admission.js';
import { ComicPreparationCacheError, createComicPreparationCache } from './comic-preparation-cache.js';
import { createComicRenditionSupervisor } from './comic-rendition-process.js';

const NOTHING_RETAINED = Object.freeze({ stranded: 0, strandedBytes: 0, unmeasured: 0 });

/**
 * @param {object} options
 * @param {string} [options.appDataRoot] - APP_DATA_ROOT: the installation identity the cache
 *   location is derived from (not the cache directory itself).
 * @param {string} [options.projectsRoot] - PROJECTS_ROOT: protected from the cache physically.
 * @param {boolean} [options.preparation=true] - false: admission only, no cache (application
 *   contexts built without a runtime, e.g. tests).
 * @param {object} [options.admissionOptions] - createComicAdmission overrides (tests).
 * @param {object} [options.cacheOptions] - createComicPreparationCache limit overrides (tests).
 * @param {typeof createComicPreparationCache} [options.createPreparationCache] - injectable (tests).
 * @param {object} [options.renditionOptions] - createComicRenditionSupervisor options (tests).
 * @param {boolean} [options.renditionSpare=false] - F1b: keep one preloaded rendition child
 *   once start() has settled (server.js). Off for every other owner.
 */
export function createComicRuntime({
  appDataRoot, projectsRoot, preparation = true, admissionOptions, cacheOptions,
  createPreparationCache = createComicPreparationCache, renditionOptions, renditionSpare = false,
} = {}) {
  if (preparation) {
    for (const [name, value] of [['appDataRoot', appDataRoot], ['projectsRoot', projectsRoot]]) {
      if (typeof value !== 'string' || !path.isAbsolute(value)) {
        throw new TypeError(`The comic runtime requires an absolute ${name}.`);
      }
    }
  }
  const admission = createComicAdmission(admissionOptions);
  const renditions = createComicRenditionSupervisor(renditionOptions);
  // Construction does no I/O; it claims this installation's root for this process (a second
  // runtime for the same installation is refused here, never a competing owner).
  const cache = preparation
    ? createPreparationCache({ ...cacheOptions, instance: appDataRoot, protectedRoots: [projectsRoot] })
    : null;

  let state = preparation ? 'created' : 'disabled';
  let starting = null;
  let closing = null;
  let status = null;

  /**
   * Recover the cache before any comic service may use it. Resolves with
   * { state: 'ready', recovery } | { state: 'degraded', code, reason } | { state: 'disabled' };
   * rejects on anything but STAGING_UNAVAILABLE. Runs once; later calls return the same result.
   */
  function start() {
    starting ??= startOnce().then((result) => {
      // F1b: only a started runtime preloads; a no-op once close() has begun.
      if (renditionSpare) renditions.preload();
      return result;
    });
    return starting;
  }

  function startOnce() {
    return (async () => {
      if (state === 'disabled') return (status = Object.freeze({ state }));
      if (state !== 'created') throw new ComicPreparationCacheError('CACHE_CLOSED', 'The comic runtime is closed.');
      state = 'starting';
      try {
        const recovery = await cache.recover();
        state = 'ready';
        return (status = Object.freeze({ state, recovery }));
      } catch (err) {
        // Nothing was published; give the root back (and record anything left for next time).
        const retained = await cache.close().catch(() => null);
        if (!(err instanceof ComicPreparationCacheError && err.code === 'STAGING_UNAVAILABLE')) {
          state = 'failed';
          throw err;
        }
        state = 'degraded';
        return (status = Object.freeze({ state, code: err.code, reason: err.message, retained }));
      }
    })();
  }

  /** Shutdown. Idempotent; resolves with what the cache could not remove. */
  function close() {
    closing ??= (async () => {
      // Synchronously, before anything else: no new rendition starts and active children are
      // killed. Awaited below, after the cache: the result reports only when both are settled.
      const renditionsClosed = renditions.close();
      try {
        return await closeCache();
      } finally {
        await renditionsClosed;
      }
    })();
    return closing;
  }

  async function closeCache() {
    if (state === 'starting') await starting.catch(() => {});
    const previous = state;
    state = 'closing';
    try {
      // 'ready': the cache stops accepting work synchronously, inside this first step.
      // 'created': never started; closing only releases its claim on the root.
      if (previous === 'ready' || previous === 'created') return await cache.close();
      return NOTHING_RETAINED;
    } finally {
      state = 'closed';
    }
  }

  return Object.freeze({
    admission,
    /** The rendition process supervisor every comic media service of the application uses. */
    renditions,
    /** The recovered cache while ready; null before recovery, when degraded or disabled, and after close. */
    get preparationCache() {
      return state === 'ready' ? cache : null;
    },
    get state() {
      return state;
    },
    /** The start() result, or null before it settles. */
    get status() {
      return status;
    },
    start,
    close,
    /** Counters only (no paths): admission and cache. */
    snapshot() {
      return Object.freeze({
        state,
        admission: admission.snapshot(),
        renditions: renditions.snapshot(),
        cache: state === 'ready' || state === 'closing' ? cache.snapshot() : null,
      });
    },
  });
}

/**
 * Log a start() outcome through the application logger (and the console for the degraded
 * mode, like other startup problems). Never throws.
 */
export function reportComicRuntimeStart(result, applicationLogger, logger = console) {
  try {
    if (result?.state === 'ready') {
      const { removed, failed, uninspected } = result.recovery;
      applicationLogger?.[failed > 0 ? 'warn' : 'info']?.({
        kind: 'diagnostic',
        subsystem: 'comics',
        event: 'comics.preparation_cache.recovered',
        message: failed > 0
          ? 'Comic preparation cache recovered; some leftover staging could not be removed and stays accounted.'
          : 'Comic preparation cache recovered.',
        context: { removed, failed, uninspected },
      });
    } else if (result?.state === 'degraded') {
      logger?.warn?.(`[CreatorCrate] Comic preparation cache unavailable (${result.reason}); comics are read on demand without background preparation.`);
      applicationLogger?.warn?.({
        kind: 'diagnostic',
        subsystem: 'comics',
        event: 'comics.preparation_cache.unavailable',
        message: 'Comic preparation cache unavailable; comics are read on demand without background preparation.',
        context: {
          code: result.code,
          reason: result.reason,
          ...(result.retained ? { stranded: result.retained.stranded, unmeasured: result.retained.unmeasured } : {}),
        },
      });
    }
  } catch {
    // Diagnostics must not change startup behavior.
  }
}

/** Log a close() outcome; retained temporary storage is a warning. Never throws. */
export function reportComicRuntimeClose(result, applicationLogger) {
  try {
    if (!result || (result.stranded === 0 && result.unmeasured === 0)) return;
    applicationLogger?.warn?.({
      kind: 'diagnostic',
      subsystem: 'comics',
      event: 'comics.preparation_cache.retained',
      message: 'Comic preparation staging could not be removed at shutdown; the next start recovers it.',
      context: { stranded: result.stranded, strandedBytes: result.strandedBytes, unmeasured: result.unmeasured },
    });
  } catch {
    // Diagnostics must not change shutdown behavior.
  }
}
