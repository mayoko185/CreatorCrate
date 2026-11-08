// Milestone A F1a — Comic page rendition child (one job per process)
//
// Launched only by comic-rendition-process.js, never imported by the application. It receives
// one job over IPC (image bytes, the reader's header inspection and numeric bounds), runs the
// comic rendition algorithm with Sharp, sends exactly one terminal result and is then
// terminated by its parent. It opens no file, resolves no path, performs no authorization,
// touches no database, archive or cache, and launches nothing.
//
// It kills itself when its IPC channel disconnects (the parent exited or crashed), when a
// second job or a malformed message arrives, and when its watchdog (the job's deadline plus a
// margin) expires, so it cannot outlive its owner. A cold child also has a watchdog while it
// waits for its job; a preloaded spare (F1b, CREATORCRATE_RENDITION_SPARE) may wait for the
// application's lifetime and relies on the disconnect alone while idle.
//
// Sharp is loaded and configured before 'ready' is sent, so a ready child (cold or spare) needs
// no further initialization; no image is processed before a job arrives.
//
// Rendition algorithm (unchanged from A3.3a, which ran it in-process): every page is fully
// decoded (metadata(), then stats() over every pixel of the first frame, failOn 'error') before
// anything is returned; a valid static page within the bounds is reported unchanged, so the
// parent serves the bytes it already holds; animated GIF/WebP pages are rendered as their first
// frame; pages over the pixel bound (or, for WebP output, libwebp's 16,383-pixel edge) are
// downscaled preserving their displayed aspect ratio, with EXIF orientation applied; output over
// the byte bound is refused.

import sharp from 'sharp';
import { COMIC_RENDITION_MIME, COMIC_RENDITION_PROTOCOL } from './comic-rendition-process.js';
import { sharpRuntime } from './sharp-runtime.js';

const JPEG_QUALITY = 90;
const WEBP_QUALITY = 90;
const OUTPUT_FORMAT = Object.freeze({ jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'png' });

class RenditionFailure extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
}

function hardExit() {
  try {
    process.kill(process.pid, 'SIGKILL');
  } catch {
    // Fall through.
  }
  process.exit(70);
}

function displayedSize(width, height, orientation) {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/**
 * The rendition algorithm. `onPhase` is called right after each native operation started.
 * Resolves with { unchanged: true, mimeType, width, height } or
 * { unchanged: false, bytes, mimeType, width, height }; throws RenditionFailure.
 */
async function render(bytes, image, maxInputPixels, limits, onPhase) {
  const started = (phase, running) => {
    onPhase(phase);
    return running;
  };
  const invalid = (cause) => new RenditionFailure('PAGE_INVALID_IMAGE', cause);

  const decodeOptions = { failOn: 'error', limitInputPixels: maxInputPixels, sequentialRead: true };
  const pipeline = () => sharp(bytes, decodeOptions).timeout({ seconds: limits.timeoutSeconds });

  let metadata;
  try {
    metadata = await started('metadata', pipeline().metadata());
    if (metadata.format !== image.format) throw new Error('format mismatch');
  } catch (cause) {
    throw invalid(cause);
  }
  try {
    // Decodes every pixel of the first frame through libvips' streaming sink; memory stays
    // bounded by the scanline buffers, not by the image area.
    await started('stats', pipeline().stats());
  } catch (cause) {
    throw invalid(cause);
  }

  const shown = displayedSize(image.width, image.height, metadata.orientation ?? 1);
  const format = OUTPUT_FORMAT[image.format];
  const edgeLimit = format === 'webp' ? limits.maxWebpDimension : Infinity;
  const pixels = shown.width * shown.height;
  const scale = Math.min(1, Math.sqrt(limits.maxPixels / pixels), edgeLimit / Math.max(shown.width, shown.height));
  const oversized = scale < 1;

  if (!image.animated && !oversized && bytes.length <= limits.maxOutputBytes) {
    return { unchanged: true, mimeType: COMIC_RENDITION_MIME.unchanged[image.format], width: shown.width, height: shown.height };
  }

  let rendered;
  try {
    let converter = pipeline().autoOrient();
    if (oversized) {
      converter = converter.resize({
        width: Math.max(1, Math.floor(shown.width * scale)),
        height: Math.max(1, Math.floor(shown.height * scale)),
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    if (format === 'jpeg') converter = converter.jpeg({ quality: JPEG_QUALITY });
    else if (format === 'webp') converter = converter.webp({ quality: WEBP_QUALITY });
    else converter = converter.png();
    rendered = await started('convert', converter.toBuffer({ resolveWithObject: true }));
  } catch (cause) {
    throw invalid(cause);
  }
  if (rendered.data.length > limits.maxOutputBytes) throw new RenditionFailure('RENDITION_LIMIT_EXCEEDED');
  return {
    unchanged: false,
    bytes: rendered.data,
    mimeType: COMIC_RENDITION_MIME.converted[image.format],
    width: rendered.info.width,
    height: rendered.info.height,
  };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// The parent validated the job; the child checks it again before decoding anything.
function parseJob(message) {
  if (message === null || typeof message !== 'object' || message.type !== 'job'
    || message.v !== COMIC_RENDITION_PROTOCOL.version) return null;
  const { bytes, image, maxInputPixels, limits } = message;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > COMIC_RENDITION_PROTOCOL.maxInputBytes) return null;
  if (!image || !COMIC_RENDITION_PROTOCOL.formats.includes(image.format) || !positiveInteger(image.width)
    || !positiveInteger(image.height) || typeof image.animated !== 'boolean') return null;
  if (!positiveInteger(maxInputPixels) || !limits) return null;
  for (const key of ['maxPixels', 'maxOutputBytes', 'maxWebpDimension', 'timeoutSeconds']) {
    if (!positiveInteger(limits[key])) return null;
  }
  if (limits.maxOutputBytes > COMIC_RENDITION_PROTOCOL.maxOutputBytes) return null;
  return {
    bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    image,
    maxInputPixels,
    limits,
  };
}

function detailOf(err) {
  const text = String(err?.cause?.message ?? err?.message ?? '');
  return text.slice(0, COMIC_RENDITION_PROTOCOL.maxDetailLength);
}

function main() {
  if (typeof process.send !== 'function') {
    process.exitCode = 64;
    return;
  }
  // The parent is gone: nothing may outlive it.
  process.on('disconnect', hardExit);
  const spare = process.env.CREATORCRATE_RENDITION_SPARE === '1';
  let watchdog = spare ? null : setTimeout(hardExit, 60_000);
  sharpRuntime.initialize();
  let received = false;
  let finished = false;

  const finish = (message) => {
    if (finished) return;
    finished = true;
    process.send(message, (err) => {
      if (err) hardExit();
    });
  };

  process.on('message', (message) => {
    if (received) {
      hardExit();
      return;
    }
    received = true;
    const job = parseJob(message);
    if (!job) {
      finish({ type: 'result', ok: false, code: 'JOB_INVALID' });
      return;
    }
    clearTimeout(watchdog);
    watchdog = setTimeout(hardExit, job.limits.timeoutSeconds * 1000 + COMIC_RENDITION_PROTOCOL.watchdogMarginMs);
    render(job.bytes, job.image, job.maxInputPixels, job.limits, (phase) => process.send({ type: 'phase', phase }))
      .then((result) => finish({ type: 'result', ok: true, ...result }))
      .catch((err) => {
        const code = err instanceof RenditionFailure ? err.code : 'INTERNAL';
        const detail = detailOf(err);
        finish({ type: 'result', ok: false, code, ...(detail ? { detail } : {}) });
      });
  });
  process.send({ type: 'ready', v: COMIC_RENDITION_PROTOCOL.version });
}

main();
