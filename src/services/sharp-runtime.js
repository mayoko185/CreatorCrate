import sharp from 'sharp';

// These are Sharp 0.35.3's observed runtime defaults. Pinning them makes the
// process-wide resource budget explicit without increasing it.
export const SHARP_RUNTIME_CONFIGURATION = Object.freeze({
  concurrency: 1,
  cache: Object.freeze({
    memory: 50,
    files: 20,
    items: 100,
  }),
});

export function createSharpRuntime({ sharpApi = sharp } = {}) {
  if (!sharpApi || typeof sharpApi.concurrency !== 'function' || typeof sharpApi.cache !== 'function') {
    throw new TypeError('createSharpRuntime requires Sharp concurrency and cache APIs.');
  }

  let initialized = false;

  return Object.freeze({
    initialize() {
      if (initialized) return;

      sharpApi.concurrency(SHARP_RUNTIME_CONFIGURATION.concurrency);
      sharpApi.cache(SHARP_RUNTIME_CONFIGURATION.cache);
      initialized = true;
    },
  });
}

// This singleton owns process-wide Sharp/libvips setup. App-graph rebuilds
// reuse it rather than configuring image services independently.
export const sharpRuntime = createSharpRuntime();
