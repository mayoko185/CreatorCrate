// Disposable rendition child, launched only by comic-rendition-process.js. Receives one
// bounded image job over IPC; it has no file paths, database, archive, cache or authority.
// Sharp is configured before ready. Parent disconnect, duplicate jobs and a watchdog terminate
// it, including native work that JavaScript cancellation cannot interrupt.
//
// Reader renditions fully decode the first frame and preserve eligible original page bytes.
// Shared derivatives validate the original first frame, then invoke image-derivative.js with
// the ordinary effective policy over the reader IPC channel; they also exit cleanly.

import sharp from 'sharp';
import { COMIC_RENDITION_MIME, COMIC_RENDITION_PROTOCOL,
  validComicDerivativePolicy } from './comic-rendition-process.js';
import { generateDerivative } from './image-derivative.js';
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

async function renderDerivative(job, onPhase) {
  const bytes = job.bytes;
  const invalid = () => new RenditionFailure('PAGE_INVALID_IMAGE');
  const signatures = {
    jpeg: bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    png: bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    gif: bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6)),
    webp: bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP',
  };
  if (!signatures[job.image.format]) throw invalid();
  const inputOptions = { failOn: 'error', limitInputPixels: job.maxInputPixels,
    sequentialRead: true, page: 0, pages: 1 };
  const pipeline = () => sharp(bytes, inputOptions).timeout({ seconds: job.limits.timeoutSeconds });
  try {
    onPhase('metadata');
    const metadata = await pipeline().metadata();
    if (metadata.format !== job.image.format || metadata.width !== job.image.width
      || (metadata.pageHeight ?? metadata.height) !== job.image.height
      || ((metadata.pages ?? 1) > 1) !== job.image.animated) throw invalid();
    onPhase('stats');
    await pipeline().stats();
    onPhase('convert');
    const result = await generateDerivative(bytes, job.kind, false, job.policy,
    { inputOptions, timeoutSeconds: job.limits.timeoutSeconds });
    if (result.buffer.length > job.limits.maxOutputBytes
      || (result.format === 'webp' && Math.max(result.width, result.height) > job.limits.maxWebpDimension)
      || result.width * result.height > job.limits.maxPixels) throw new RenditionFailure('RENDITION_LIMIT_EXCEEDED');
    return result;
  } catch (error) {
    throw error instanceof RenditionFailure ? error : invalid();
  }
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
  const derivative = message.purpose === 'image-derivative';
  if (message.purpose !== undefined && !derivative) return null;
  if (derivative && (typeof message.jobId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.jobId)
    || Object.keys(message).some((key) => !['type', 'v', 'purpose', 'jobId', 'bytes', 'image', 'maxInputPixels', 'limits',
      ...(derivative ? ['kind', 'policy'] : [])].includes(key))
    || maxInputPixels > 100_000_000 || image.width * image.height > maxInputPixels
    || Math.max(image.width, image.height) > 65_535 || limits.timeoutSeconds > 30)) return null;
  if (derivative && (!validComicDerivativePolicy(message.kind, message.policy)
    || limits.maxPixels > 25_000_000 || limits.maxWebpDimension > 16_383)) return null;
  return {
    ...(derivative ? { purpose: message.purpose, jobId: message.jobId } : {}),
    ...(derivative ? { kind: message.kind, policy: message.policy } : {}),
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

  let derivativeIdentity = null;
  const send = (message, callback) => process.send(message, callback);
  const finish = (message) => {
    if (finished) return;
    finished = true;
    send({ ...message, ...derivativeIdentity }, (err) => {
      if (err) hardExit();
      if (derivativeIdentity) {
        clearTimeout(watchdog);
        process.removeListener('disconnect', hardExit);
        process.disconnect();
      }
    });
  };

  const receive = (message) => {
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
    if (job.purpose) derivativeIdentity = { purpose: job.purpose, jobId: job.jobId };
    clearTimeout(watchdog);
    watchdog = setTimeout(hardExit, job.limits.timeoutSeconds * 1000 + COMIC_RENDITION_PROTOCOL.watchdogMarginMs);
    const onPhase = (phase) => send({ type: 'phase', phase });
    const running = job.purpose === 'image-derivative' ? renderDerivative(job, onPhase)
      : render(job.bytes, job.image, job.maxInputPixels, job.limits, onPhase);
    running
      .then((result) => finish({ type: 'result', ok: true, ...result }))
      .catch((err) => {
        const code = err instanceof RenditionFailure ? err.code : 'INTERNAL';
        const detail = detailOf(err);
        finish({ type: 'result', ok: false, code, ...(detail ? { detail } : {}) });
      });
  };
  process.on('message', receive);
  send({ type: 'ready', v: COMIC_RENDITION_PROTOCOL.version });
}

main();
