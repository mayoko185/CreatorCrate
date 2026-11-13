// ─── Unified viewer: comic manifest source (Milestone C, C1a) ────────────────
//
// Fetches one comic's manifest from the Milestone A endpoint
//
//   GET /projects/:projectId/assets/:assetId/comic
//
// validates the WHOLE response strictly, and only then converts it into the
// existing viewer-sequence source contract (kind 'comic'). Nothing here opens
// a viewer, touches the DOM, fetches a numbered page, retries, polls or starts
// a preparation; C1b owns the session lifecycle (including HTTP 409 recovery).
//
// Contract with the server (src/routes/media.js publicComicManifest):
//   { projectId: int, assetId: int, format: 'cbz'|'cbr'|'cb7',
//     revision: 32 lowercase hex (opaque), pageCount: int 0..5000,
//     displayImageTypes: ['image/jpeg', …], preparation: { solid, state },
//     unavailablePositions: [int…], pages: [{ position, name, available,
//     problem, url }] }
// Each page URL is exactly
//   /projects/<projectId>/assets/<assetId>/comic/pages/<position>?v=<revision>
// and is used unchanged once validated (never rebuilt from member names).
//
// Canonical order: pages stay in server order, numbered 1..pageCount, with
// unavailable pages kept in place. Reading direction (LTR/RTL) and one/two
// page spreads are computed later from this order and never change it, so a
// page's identity (project + asset + position) is stable across layouts.

import {
  VIEWER_SOURCE_KIND_COMIC,
  VIEWER_SOURCE_MODE_SEQUENCE,
  buildViewerItemKey,
  createViewerSource,
  normalizeViewerUrl,
} from './viewer-sequence.js';

export const COMIC_SOURCE_FORMATS = Object.freeze(['cbz', 'cbr', 'cb7']);
/** Backend page limit (CBZ_READER_LIMITS.maxPages, shared by CBR/CB7). */
export const COMIC_SOURCE_MAX_PAGES = 5_000;
/** Backend member-path bound (maxPathLength); a page name is a basename. */
export const COMIC_SOURCE_MAX_NAME_LENGTH = 1_024;
/** Generous bound for a 5,000-page manifest with maximal names. */
export const COMIC_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
export const COMIC_DISPLAY_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const COMIC_PREPARATION_STATES = Object.freeze(['not-required', 'on-demand', 'preparing', 'ready']);

export const COMIC_SOURCE_ERROR = Object.freeze({
  HTTP: 'http-error',
  REDIRECTED: 'redirected',
  NETWORK: 'network',
  NOT_JSON: 'not-json',
  TOO_LARGE: 'too-large',
  INVALID_JSON: 'invalid-json',
  INVALID_MANIFEST: 'invalid-manifest',
  INVALID_REQUEST: 'invalid-request',
});

const REVISION_RE = /^[0-9a-f]{32}$/;
const PROBLEM_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ID_STRING_RE = /^[1-9]\d{0,15}$/;
const JSON_CONTENT_TYPE_RE = /^application\/json\s*(;|$)/i;

/**
 * A manifest could not be fetched or was refused. `code` is one of
 * COMIC_SOURCE_ERROR; `status` is the HTTP status when a response arrived
 * (null otherwise); `reason` names the failed validation rule. Messages are
 * fixed text: no server body is ever carried.
 */
export class ComicSourceError extends Error {
  constructor(code, message, { status = null, reason = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ComicSourceError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

function invalid(reason) {
  return new ComicSourceError(COMIC_SOURCE_ERROR.INVALID_MANIFEST, 'The comic manifest is invalid.', { reason });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// Expected identity from the caller: a positive safe integer or its canonical
// decimal string (hosts read ids from data attributes).
function expectedId(value) {
  if (isId(value)) return value;
  if (typeof value === 'string' && ID_STRING_RE.test(value) && isId(Number(value))) return Number(value);
  return null;
}

function expectedIdentity({ projectId, assetId } = {}) {
  const project = expectedId(projectId);
  const asset = expectedId(assetId);
  if (project === null || asset === null) {
    throw new ComicSourceError(COMIC_SOURCE_ERROR.INVALID_REQUEST, 'A comic needs a project and asset identity.',
      { reason: 'identity' });
  }
  return { projectId: project, assetId: asset };
}

/**
 * Root-relative manifest URL for a comic.
 *
 * @param {number|string} projectId
 * @param {number|string} assetId
 * @returns {string}
 */
export function comicManifestUrl(projectId, assetId) {
  const ids = expectedIdentity({ projectId, assetId });
  return `/projects/${ids.projectId}/assets/${ids.assetId}/comic`;
}

function expectedPageUrl(projectId, assetId, position, revision) {
  return `/projects/${projectId}/assets/${assetId}/comic/pages/${position}?v=${revision}`;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateDisplayImageTypes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > COMIC_DISPLAY_IMAGE_TYPES.length) {
    throw invalid('display-image-types');
  }
  const seen = new Set();
  for (const type of value) {
    if (typeof type !== 'string' || !COMIC_DISPLAY_IMAGE_TYPES.includes(type) || seen.has(type)) {
      throw invalid('display-image-types');
    }
    seen.add(type);
  }
  return Object.freeze([...value]);
}

function validatePreparation(value, format) {
  if (!isPlainObject(value) || typeof value.solid !== 'boolean'
    || typeof value.state !== 'string' || !COMIC_PREPARATION_STATES.includes(value.state)) {
    throw invalid('preparation');
  }
  // Only solid CBR/CB7 archives are prepared; everything else is 'not-required'.
  if ((value.solid === false) !== (value.state === 'not-required') || (format === 'cbz' && value.solid)) {
    throw invalid('preparation');
  }
  return Object.freeze({ solid: value.solid, state: value.state });
}

function validatePage(page, index, ids, revision) {
  const position = index + 1;
  if (!isPlainObject(page)) throw invalid('page');
  if (page.position !== position) throw invalid('page-position');
  if (typeof page.name !== 'string' || page.name.length === 0 || page.name.length > COMIC_SOURCE_MAX_NAME_LENGTH) {
    throw invalid('page-name');
  }
  if (typeof page.available !== 'boolean') throw invalid('page-available');
  if (page.available ? page.problem !== null : (typeof page.problem !== 'string' || !PROBLEM_RE.test(page.problem))) {
    throw invalid('page-problem');
  }
  // The exact server-issued page URL of this asset, position and revision:
  // root-relative, same-origin, no scheme, host, redirection or substitution.
  if (typeof page.url !== 'string' || normalizeViewerUrl(page.url) !== page.url
    || page.url !== expectedPageUrl(ids.projectId, ids.assetId, position, revision)) {
    throw invalid('page-url');
  }
  return Object.freeze({
    key: buildViewerItemKey({ projectId: ids.projectId, assetId: ids.assetId, position }),
    position,
    name: page.name,
    available: page.available,
    problem: page.problem,
    url: page.url,
  });
}

function validateUnavailablePositions(value, pages) {
  const expected = pages.filter((page) => !page.available).map((page) => page.position);
  if (!Array.isArray(value) || value.length !== expected.length
    || value.some((position, index) => position !== expected[index])) {
    throw invalid('unavailable-positions');
  }
  return Object.freeze(expected);
}

/**
 * Validate a parsed manifest body against the expected comic identity. The
 * manifest is accepted or rejected as a whole; nothing is repaired, reordered
 * or dropped. Returns a frozen copy holding only contract fields.
 *
 * @param {unknown} body
 * @param {{ projectId: number|string, assetId: number|string }} expected
 * @returns {Readonly<{ projectId: number, assetId: number, format: string,
 *   revision: string, pageCount: number, empty: boolean,
 *   displayImageTypes: ReadonlyArray<string>,
 *   preparation: Readonly<{ solid: boolean, state: string }>,
 *   unavailablePositions: ReadonlyArray<number>,
 *   pages: ReadonlyArray<Readonly<{ key: string, position: number, name: string,
 *     available: boolean, problem: string|null, url: string }>> }>}
 */
export function validateComicManifest(body, expected) {
  const ids = expectedIdentity(expected);
  if (!isPlainObject(body)) throw invalid('shape');
  if (body.projectId !== ids.projectId) throw invalid('project');
  if (body.assetId !== ids.assetId) throw invalid('asset');
  if (typeof body.format !== 'string' || !COMIC_SOURCE_FORMATS.includes(body.format)) throw invalid('format');
  if (typeof body.revision !== 'string' || !REVISION_RE.test(body.revision)) throw invalid('revision');
  const { pageCount } = body;
  if (!Number.isSafeInteger(pageCount) || pageCount < 0 || pageCount > COMIC_SOURCE_MAX_PAGES) {
    throw invalid('page-count');
  }
  // Bounded before any per-page work: the array length must equal pageCount.
  if (!Array.isArray(body.pages) || body.pages.length !== pageCount) throw invalid('page-count');

  const displayImageTypes = validateDisplayImageTypes(body.displayImageTypes);
  const preparation = validatePreparation(body.preparation, body.format);
  const pages = [];
  for (let index = 0; index < pageCount; index += 1) {
    pages.push(validatePage(body.pages[index], index, ids, body.revision));
  }
  const unavailablePositions = validateUnavailablePositions(body.unavailablePositions, pages);

  return Object.freeze({
    projectId: ids.projectId,
    assetId: ids.assetId,
    format: body.format,
    revision: body.revision,
    pageCount,
    empty: pageCount === 0,
    displayImageTypes,
    preparation,
    unavailablePositions,
    pages: Object.freeze(pages),
  });
}

// ─── Source conversion ───────────────────────────────────────────────────────

function unavailableReasonOf(problem) {
  return problem.toLowerCase().replace(/_/g, '-');
}

/**
 * Default source key: one comic asset. The revision is deliberately not part
 * of it, so a later manifest of the same comic reconciles page by page.
 */
export function comicSourceKey(projectId, assetId) {
  const ids = expectedIdentity({ projectId, assetId });
  return `comic:${ids.projectId}:${ids.assetId}`;
}

/**
 * Validate a manifest body and convert it into a frozen comic viewer source.
 * Throws ComicSourceError before anything is built when the manifest is
 * invalid. An empty comic yields a source with no items (`comic.empty`).
 *
 * @param {unknown} body - the parsed manifest JSON
 * @param {{ projectId: number|string, assetId: number|string, key?: string, label?: string }} options
 * @returns {Readonly<{ source: import('./viewer-sequence.js').ViewerSource,
 *   comic: ReturnType<typeof validateComicManifest> }>}
 */
export function createComicSource(body, { projectId, assetId, key, label } = {}) {
  const comic = validateComicManifest(body, { projectId, assetId });
  const items = comic.pages.map((page) => ({
    projectId: comic.projectId,
    assetId: comic.assetId,
    position: page.position,
    title: page.name,
    alt: `Page ${page.position}`,
    mediaUrl: page.url,
    revision: comic.revision,
    available: page.available,
    unavailableReason: page.available ? undefined : unavailableReasonOf(page.problem),
  }));
  const source = createViewerSource({
    key: key ?? comicSourceKey(comic.projectId, comic.assetId),
    label,
    kind: VIEWER_SOURCE_KIND_COMIC,
    mode: VIEWER_SOURCE_MODE_SEQUENCE,
    items,
    initialKey: comic.pages[0]?.key,
  });
  // The generic normalizer must not have dropped, renumbered or altered a page.
  const intact = source.droppedCount === 0 && source.items.length === comic.pageCount
    && source.items.every((item, index) => {
      const page = comic.pages[index];
      return item.key === page.key && item.position === page.position && item.mediaUrl === page.url
        && item.available === page.available && item.revision === comic.revision;
    });
  if (!intact) throw invalid('source');
  return Object.freeze({ source, comic });
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

function abortError(signal) {
  const { reason } = signal;
  if (reason instanceof Error) return reason;
  return new DOMException('The comic manifest request was aborted.', 'AbortError');
}

function discardBody(response) {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
  } catch {
    // The body is only being released.
  }
}

function tooLarge(status) {
  return new ComicSourceError(COMIC_SOURCE_ERROR.TOO_LARGE, 'The comic manifest is too large.', { status });
}

async function readBoundedText(response, maxBytes) {
  const declared = response.headers?.get?.('content-length');
  if (declared != null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    discardBody(response);
    throw tooLarge(response.status);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw tooLarge(response.status);
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw tooLarge(response.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(bytes);
}

/**
 * Fetch, validate and convert one comic's manifest. One credentialed
 * same-origin GET; no retry, no page or archive request.
 *
 * Rejects with the signal's abort reason (an AbortError) when cancelled, and
 * otherwise with ComicSourceError:
 * - 'http-error' (with `status`) for any unsuccessful status; the plain-text
 *   service body is never read or parsed.
 * - 'redirected' for any redirect; 'network' when no response arrived.
 * - 'not-json', 'too-large', 'invalid-json', 'invalid-manifest'.
 *
 * @param {{ projectId: number|string, assetId: number|string, signal?: AbortSignal,
 *   fetch?: typeof fetch, key?: string, label?: string, maxBytes?: number }} options
 * @returns {Promise<ReturnType<typeof createComicSource>>}
 */
export async function fetchComicSource({
  projectId, assetId, signal, fetch: fetchImpl = globalThis.fetch, key, label, maxBytes = COMIC_MANIFEST_MAX_BYTES,
} = {}) {
  const ids = expectedIdentity({ projectId, assetId });
  if (typeof fetchImpl !== 'function') {
    throw new ComicSourceError(COMIC_SOURCE_ERROR.NETWORK, 'The comic manifest cannot be requested.');
  }
  if (signal?.aborted) throw abortError(signal);

  let response;
  try {
    response = await fetchImpl(comicManifestUrl(ids.projectId, ids.assetId), {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    throw new ComicSourceError(COMIC_SOURCE_ERROR.NETWORK, 'The comic manifest could not be requested.', { cause: err });
  }
  if (signal?.aborted) {
    discardBody(response);
    throw abortError(signal);
  }

  const status = Number.isInteger(response?.status) ? response.status : null;
  if (response?.type === 'opaqueredirect' || response?.redirected === true
    || (status !== null && status >= 300 && status < 400)) {
    discardBody(response);
    throw new ComicSourceError(COMIC_SOURCE_ERROR.REDIRECTED, 'The comic manifest request was redirected.', { status });
  }
  if (response?.ok !== true) {
    discardBody(response);
    throw new ComicSourceError(COMIC_SOURCE_ERROR.HTTP, 'The comic manifest could not be loaded.', { status });
  }
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!JSON_CONTENT_TYPE_RE.test(contentType)) {
    discardBody(response);
    throw new ComicSourceError(COMIC_SOURCE_ERROR.NOT_JSON, 'The comic manifest is not JSON.', { status });
  }

  let text;
  try {
    text = await readBoundedText(response, maxBytes);
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    if (err instanceof ComicSourceError) throw err;
    throw new ComicSourceError(COMIC_SOURCE_ERROR.INVALID_JSON, 'The comic manifest could not be read.',
      { status, cause: err });
  }
  if (signal?.aborted) throw abortError(signal);

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new ComicSourceError(COMIC_SOURCE_ERROR.INVALID_JSON, 'The comic manifest is not valid JSON.',
      { status, cause: err });
  }
  try {
    return createComicSource(body, { projectId: ids.projectId, assetId: ids.assetId, key, label });
  } catch (err) {
    if (err instanceof ComicSourceError) err.status = status;
    throw err;
  }
}
