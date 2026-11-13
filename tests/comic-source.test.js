// C1a — comic manifest fetch, strict validation and conversion into the
// viewer-sequence source contract (kind 'comic').
//
// Unit tests drive the real production functions with an injected fetch. The
// "actual endpoint" suite runs the real Milestone A application graph (SQLite,
// filesystem, comic runtime and readers) on a loopback server and feeds its
// manifest responses through the same adapter.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import sharp from 'sharp';
import { makeZip } from './helpers/zip-fixture.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';
import {
  COMIC_MANIFEST_MAX_BYTES,
  COMIC_SOURCE_ERROR,
  COMIC_SOURCE_MAX_PAGES,
  ComicSourceError,
  comicManifestUrl,
  comicSourceKey,
  createComicSource,
  fetchComicSource,
  validateComicManifest,
} from '../src/static/client/comic-source.js';
import {
  VIEWER_SOURCE_KIND_COMIC,
  VIEWER_SOURCE_MODE_SEQUENCE,
  canPlayViewerSlideshow,
  findViewerItemByIdentity,
  getViewerItem,
  reconcileViewerSource,
  selectInitialViewerItem,
  stepViewerSequence,
} from '../src/static/client/viewer-sequence.js';

const REV = '0123456789abcdef0123456789abcdef';
const OTHER_REV = 'fedcba9876543210fedcba9876543210';
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function pageUrl(projectId, assetId, position, revision = REV) {
  return `/projects/${projectId}/assets/${assetId}/comic/pages/${position}?v=${revision}`;
}

// A manifest in the exact shape publicComicManifest (src/routes/media.js) serializes.
function manifest({
  projectId = 7, assetId = 70, format = 'cbz', revision = REV, names = ['p1.jpg', 'p2.png', 'p3.webp'],
  problems = {}, preparation, ...rest
} = {}) {
  const pages = names.map((name, index) => {
    const position = index + 1;
    const problem = problems[position] ?? null;
    return { position, name, available: problem === null, problem, url: pageUrl(projectId, assetId, position, revision) };
  });
  return {
    projectId,
    assetId,
    format,
    revision,
    pageCount: pages.length,
    displayImageTypes: [...TYPES],
    preparation: preparation ?? { solid: false, state: 'not-required' },
    unavailablePositions: pages.filter((page) => !page.available).map((page) => page.position),
    pages,
    ...rest,
  };
}

const expected = { projectId: 7, assetId: 70 };

function reasonOf(fn) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ComicSourceError);
    expect(err.code).toBe(COMIC_SOURCE_ERROR.INVALID_MANIFEST);
    return err.reason;
  }
  throw new Error('expected the manifest to be rejected');
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function fetchReturning(response) {
  return vi.fn(async () => (typeof response === 'function' ? response() : response));
}

// ─── Validation and conversion ───────────────────────────────────────────────

describe('comic-source: valid manifests', () => {
  it.each([
    ['cbz', { solid: false, state: 'not-required' }],
    ['cbr', { solid: false, state: 'not-required' }],
    ['cbr', { solid: true, state: 'on-demand' }],
    ['cb7', { solid: true, state: 'ready' }],
    ['cb7', { solid: true, state: 'preparing' }],
  ])('accepts a %s manifest (%o) and builds a comic sequence in server order', (format, preparation) => {
    const body = manifest({ format, preparation, names: ['p1.jpg', 'p10.png', 'p2.png'] });
    const { source, comic } = createComicSource(body, expected);

    expect(comic).toMatchObject({
      projectId: 7, assetId: 70, format, revision: REV, pageCount: 3, empty: false, preparation,
      displayImageTypes: TYPES, unavailablePositions: [],
    });
    expect(source).toMatchObject({
      key: 'comic:7:70', kind: VIEWER_SOURCE_KIND_COMIC, mode: VIEWER_SOURCE_MODE_SEQUENCE,
      wrap: false, slideshow: false, droppedCount: 0, initialKey: 'p:7|a:70|n:1',
    });
    // Server order is canonical: never sorted by name.
    expect(source.items.map((item) => [item.key, item.position, item.title])).toEqual([
      ['p:7|a:70|n:1', 1, 'p1.jpg'], ['p:7|a:70|n:2', 2, 'p10.png'], ['p:7|a:70|n:3', 3, 'p2.png'],
    ]);
    // Server-issued URLs are used unchanged; every page carries the manifest revision.
    source.items.forEach((item, index) => {
      expect(item.mediaUrl).toBe(body.pages[index].url);
      expect(item.revision).toBe(REV);
      expect(item.projectId).toBe('7');
      expect(item.assetId).toBe('70');
      expect(item.originalUrl).toBeNull();
    });
    expect(comic.pages.map((page) => page.url)).toEqual(body.pages.map((page) => page.url));
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(comic)).toBe(true);
    expect(Object.isFrozen(comic.pages[0])).toBe(true);
  });

  it('accepts string ids from host data attributes and a caller source key/label', () => {
    const { source } = createComicSource(manifest(), { projectId: '7', assetId: '70', key: 'release:3', label: 'Book' });
    expect(source.key).toBe('release:3');
    expect(source.label).toBe('Book');
    expect(comicSourceKey('7', 70)).toBe('comic:7:70');
    expect(comicManifestUrl(7, '70')).toBe('/projects/7/assets/70/comic');
  });

  it('represents an empty comic without inventing a page', () => {
    const { source, comic } = createComicSource(manifest({ names: [] }), expected);
    expect(comic).toMatchObject({ pageCount: 0, empty: true, pages: [], unavailablePositions: [] });
    expect(source.items).toEqual([]);
    expect(source.initialKey).toBeNull();
    expect(source.kind).toBe(VIEWER_SOURCE_KIND_COMIC);
    expect(selectInitialViewerItem(source)).toEqual({ key: null, index: -1 });
    expect(stepViewerSequence(source, null, 'next')).toMatchObject({ reason: 'empty', key: null });
    expect(canPlayViewerSlideshow(source)).toBe(false);
  });

  it('builds exactly one non-wrapping, non-playing item for a one-page comic', () => {
    const { source } = createComicSource(manifest({ names: ['only.jpg'] }), expected);
    expect(source.items).toHaveLength(1);
    expect(source.wrap).toBe(false);
    expect(canPlayViewerSlideshow(source)).toBe(false);
    expect(stepViewerSequence(source, 'p:7|a:70|n:1', 'next')).toMatchObject({ moved: false, boundary: 'end' });
    expect(stepViewerSequence(source, 'p:7|a:70|n:1', 'previous')).toMatchObject({ moved: false, boundary: 'start' });
  });

  it('keeps an unavailable first page as position 1 and opens on it', () => {
    const body = manifest({ problems: { 1: 'PAGE_INVALID_IMAGE' } });
    const { source, comic } = createComicSource(body, expected);
    expect(comic.unavailablePositions).toEqual([1]);
    expect(comic.pages[0]).toMatchObject({ position: 1, available: false, problem: 'PAGE_INVALID_IMAGE' });
    expect(source.initialKey).toBe('p:7|a:70|n:1');
    expect(selectInitialViewerItem(source)).toEqual({ key: 'p:7|a:70|n:1', index: 0 });
    expect(source.items[0]).toMatchObject({
      position: 1, available: false, unavailableReason: 'page-invalid-image', mediaUrl: body.pages[0].url,
    });
    // An unknown current key also falls back to page 1, not the first available page.
    expect(stepViewerSequence(source, 'nope', 'next')).toMatchObject({ key: 'p:7|a:70|n:1', index: 0 });
  });

  it('keeps an unavailable middle page in place without renumbering later pages', () => {
    const body = manifest({ names: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'], problems: { 2: 'MEMBER_LIMIT_EXCEEDED' } });
    const { source, comic } = createComicSource(body, expected);
    expect(comic.unavailablePositions).toEqual([2]);
    expect(source.items.map((item) => [item.position, item.available])).toEqual([
      [1, true], [2, false], [3, true], [4, true],
    ]);
    expect(source.items[1].unavailableReason).toBe('member-limit-exceeded');
    // Navigation visits the missing page in place; the source never wraps.
    expect(stepViewerSequence(source, 'p:7|a:70|n:1', 'next')).toMatchObject({ key: 'p:7|a:70|n:2', moved: true });
    expect(stepViewerSequence(source, 'p:7|a:70|n:4', 'next')).toMatchObject({ moved: false, boundary: 'end', wrapped: false });
  });

  it('keeps duplicate basenames from different archive folders as distinct pages', () => {
    const { source, comic } = createComicSource(manifest({ names: ['01.jpg', '01.jpg', '01.jpg'] }), expected);
    expect(comic.pages.map((page) => page.name)).toEqual(['01.jpg', '01.jpg', '01.jpg']);
    expect(source.items.map((item) => item.key)).toEqual(['p:7|a:70|n:1', 'p:7|a:70|n:2', 'p:7|a:70|n:3']);
    expect(findViewerItemByIdentity(source.items, { projectId: 7, assetId: 70, position: 2 }).key).toBe('p:7|a:70|n:2');
  });

  it('keeps raw page labels as data while titles are plain text', () => {
    const name = '<img src=x onerror=alert(1)>\u0007 page.jpg';
    const { source, comic } = createComicSource(manifest({ names: [name] }), expected);
    expect(comic.pages[0].name).toBe(name);
    expect(source.items[0].title).toBe('<img src=x onerror=alert(1)> page.jpg');
    expect(source.items[0].alt).toBe('Page 1');
  });

  it('never drops a position for a large comic at the page limit', () => {
    const names = Array.from({ length: COMIC_SOURCE_MAX_PAGES }, (_, index) => `page-${index + 1}.jpg`);
    const { source } = createComicSource(manifest({ names }), expected);
    expect(source.items).toHaveLength(COMIC_SOURCE_MAX_PAGES);
    expect(source.droppedCount).toBe(0);
    expect(source.items.every((item, index) => item.position === index + 1)).toBe(true);
  });

  it('ignores unknown extra fields without carrying them over', () => {
    const body = manifest({ extra: '<script>' });
    body.pages[0].member = 'secret/path.jpg';
    const { comic } = createComicSource(body, expected);
    expect(comic).not.toHaveProperty('extra');
    expect(comic.pages[0]).not.toHaveProperty('member');
  });
});

describe('comic-source: strict rejection', () => {
  it('rejects a mismatched project or asset', () => {
    expect(reasonOf(() => validateComicManifest(manifest({ projectId: 8 }), expected))).toBe('project');
    expect(reasonOf(() => validateComicManifest(manifest({ assetId: 71 }), expected))).toBe('asset');
    expect(reasonOf(() => validateComicManifest({ ...manifest(), projectId: '7' }, expected))).toBe('project');
  });

  it('refuses a request without a valid identity', () => {
    for (const ids of [{}, { projectId: 7 }, { projectId: 0, assetId: 1 }, { projectId: '07', assetId: 1 }, { projectId: 1.5, assetId: 2 }]) {
      expect(() => validateComicManifest(manifest(), ids)).toThrow(ComicSourceError);
    }
  });

  it.each(['zip', 'rar', 'CBZ', '', null, 1])('rejects an unsupported format %p', (format) => {
    expect(reasonOf(() => validateComicManifest(manifest({ format }), expected))).toBe('format');
  });

  it.each([-1, 1.5, '3', null, Number.NaN, COMIC_SOURCE_MAX_PAGES + 1, Number.MAX_SAFE_INTEGER + 2])(
    'rejects page count %p', (pageCount) => {
      expect(reasonOf(() => validateComicManifest({ ...manifest(), pageCount }, expected))).toBe('page-count');
    },
  );

  it('rejects a page count that does not match the pages array', () => {
    expect(reasonOf(() => validateComicManifest({ ...manifest(), pageCount: 2 }, expected))).toBe('page-count');
    expect(reasonOf(() => validateComicManifest({ ...manifest(), pageCount: 4 }, expected))).toBe('page-count');
    expect(reasonOf(() => validateComicManifest({ ...manifest(), pages: 'x' }, expected))).toBe('page-count');
  });

  it('rejects duplicate, missing, zero-based or reordered positions', () => {
    const duplicate = manifest();
    duplicate.pages[2] = { ...duplicate.pages[1] };
    expect(reasonOf(() => validateComicManifest(duplicate, expected))).toBe('page-position');

    const missing = manifest({ names: ['a', 'b', 'c'] });
    missing.pages[1] = { ...missing.pages[1], position: 3 };
    expect(reasonOf(() => validateComicManifest(missing, expected))).toBe('page-position');

    const zero = manifest();
    zero.pages[0] = { ...zero.pages[0], position: 0 };
    expect(reasonOf(() => validateComicManifest(zero, expected))).toBe('page-position');

    const reordered = manifest();
    reordered.pages = [reordered.pages[1], reordered.pages[0], reordered.pages[2]];
    expect(reasonOf(() => validateComicManifest(reordered, expected))).toBe('page-position');

    const stringy = manifest();
    stringy.pages[0] = { ...stringy.pages[0], position: '1' };
    expect(reasonOf(() => validateComicManifest(stringy, expected))).toBe('page-position');
  });

  it('rejects malformed pages', () => {
    const cases = [
      [(m) => { m.pages[0] = null; }, 'page'],
      [(m) => { m.pages[0].name = ''; }, 'page-name'],
      [(m) => { m.pages[0].name = 'x'.repeat(1025); }, 'page-name'],
      [(m) => { m.pages[0].name = 5; }, 'page-name'],
      [(m) => { m.pages[0].available = 'true'; }, 'page-available'],
      [(m) => { m.pages[0].problem = 'PAGE_INVALID_IMAGE'; }, 'page-problem'],
      [(m) => { m.pages[0].problem = undefined; }, 'page-problem'],
      [(m) => { m.pages[0].available = false; m.unavailablePositions = [1]; }, 'page-problem'],
      [(m) => { m.pages[0].available = false; m.pages[0].problem = '<b>bad</b>'; m.unavailablePositions = [1]; }, 'page-problem'],
    ];
    for (const [mutate, reason] of cases) {
      const body = manifest();
      mutate(body);
      expect(reasonOf(() => validateComicManifest(body, expected))).toBe(reason);
    }
  });

  it('rejects unavailablePositions that disagree with the pages', () => {
    const problems = { 2: 'PAGE_INVALID_IMAGE' };
    for (const unavailablePositions of [[], [1], [2, 2], [3], ['2'], null, [2, 3]]) {
      expect(reasonOf(() => validateComicManifest(manifest({ problems, unavailablePositions }), expected)))
        .toBe('unavailable-positions');
    }
    const twoMissing = manifest({ problems: { 1: 'PAGE_INVALID_IMAGE', 3: 'PAGE_INVALID_IMAGE' } });
    twoMissing.unavailablePositions = [3, 1];
    expect(reasonOf(() => validateComicManifest(twoMissing, expected))).toBe('unavailable-positions');
  });

  it.each([
    '', '0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef', `${REV}0`, 'g'.repeat(32), 12345, null,
  ])('rejects revision %p', (revision) => {
    const body = manifest();
    body.revision = revision;
    expect(reasonOf(() => validateComicManifest(body, expected))).toBe('revision');
  });

  it('rejects display types and preparation metadata outside the contract', () => {
    for (const displayImageTypes of [[], ['image/svg+xml'], ['image/png', 'image/png'], 'image/png', [...TYPES, 'image/avif']]) {
      expect(reasonOf(() => validateComicManifest(manifest({ displayImageTypes }), expected))).toBe('display-image-types');
    }
    for (const [format, preparation] of [
      ['cbz', null], ['cbz', { solid: false, state: 'unknown' }], ['cbz', { solid: true, state: 'on-demand' }],
      ['cbr', { solid: true, state: 'not-required' }], ['cbr', { solid: false, state: 'ready' }],
      ['cb7', { solid: 'yes', state: 'ready' }],
    ]) {
      expect(reasonOf(() => validateComicManifest({ ...manifest({ format }), preparation }, expected))).toBe('preparation');
    }
  });

  it('rejects page URLs for another revision, asset, project or position, and unsafe URLs', () => {
    const urls = [
      pageUrl(7, 70, 1, OTHER_REV),
      pageUrl(7, 71, 1),
      pageUrl(8, 70, 1),
      pageUrl(7, 70, 2),
      `${pageUrl(7, 70, 1)}&next=//evil.example`,
      `https://evil.example${pageUrl(7, 70, 1)}`,
      `//evil.example${pageUrl(7, 70, 1)}`,
      `/\\evil.example${pageUrl(7, 70, 1)}`,
      'javascript:alert(1)',
      `${pageUrl(7, 70, 1)} `,
      pageUrl(7, 70, 1).replace('/comic/pages/', '/original/'),
      `/projects/7/assets/70/comic/pages/1?v=${REV}#x`,
      `/projects/7/assets/70/comic/pages/01?v=${REV}`,
      null,
    ];
    for (const url of urls) {
      const body = manifest();
      body.pages[0].url = url;
      expect(reasonOf(() => validateComicManifest(body, expected)), String(url)).toBe('page-url');
    }
  });

  it('rejects non-object bodies', () => {
    for (const body of [null, [], 'manifest', 3]) {
      expect(reasonOf(() => validateComicManifest(body, expected))).toBe('shape');
    }
  });

  it('publishes nothing when any part of a manifest is malformed', () => {
    // A single bad page late in the array rejects the whole manifest; no partial source escapes.
    const body = manifest({ names: Array.from({ length: 50 }, (_, index) => `p${index}.jpg`) });
    body.pages[49].url = pageUrl(7, 70, 49);
    let result;
    expect(() => { result = createComicSource(body, expected); }).toThrow(ComicSourceError);
    expect(result).toBeUndefined();
  });
});

describe('comic-source: B1 helper compatibility', () => {
  it('reconciles a refreshed manifest page by page and keeps the comic settings', () => {
    const first = createComicSource(manifest({ names: ['a', 'b', 'c'] }), expected).source;
    const next = createComicSource(manifest({ names: ['a', 'b', 'c'], revision: OTHER_REV }), expected).source;
    const result = reconcileViewerSource(first, 'p:7|a:70|n:2', next);
    expect(result).toMatchObject({ outcome: 'kept', key: 'p:7|a:70|n:2', revisionChanged: true, mediaChanged: true, reload: true });
    expect(result.source).toMatchObject({ kind: VIEWER_SOURCE_KIND_COMIC, wrap: false, slideshow: false });
    expect(result.item.mediaUrl).toBe(pageUrl(7, 70, 2, OTHER_REV));
  });

  it('is usable by the generic lookup helpers', () => {
    const { source } = createComicSource(manifest(), expected);
    expect(getViewerItem(source, 'p:7|a:70|n:3').title).toBe('p3.webp');
    expect(findViewerItemByIdentity(source.items, { assetId: 70 })).toBeNull();
  });
});

// ─── Fetch ───────────────────────────────────────────────────────────────────

describe('comic-source: fetch', () => {
  it('makes one credentialed same-origin GET for the manifest and nothing else', async () => {
    const fetch = fetchReturning(jsonResponse(manifest()));
    const controller = new AbortController();
    const { source, comic } = await fetchComicSource({ projectId: 7, assetId: '70', fetch, signal: controller.signal });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/projects/7/assets/70/comic');
    expect(init).toMatchObject({
      method: 'GET', credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
      headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    // No page or archive request: validation never fetches media.
    expect(fetch.mock.calls.every(([called]) => !/\/comic\/pages\/|\/original/.test(called))).toBe(true);
    expect(source.items).toHaveLength(3);
    expect(comic.revision).toBe(REV);
  });

  it.each([
    [404, 'Not found'], [415, 'Unsupported media type'], [422, 'The comic archive cannot be read.'],
    [503, '<html>busy</html>'], [500, 'Media error'], [409, 'stale'],
  ])('preserves HTTP %i as a safe error without reading the body', async (status, text) => {
    const response = new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const textSpy = vi.spyOn(response, 'text');
    const error = await fetchComicSource({ ...expected, fetch: fetchReturning(response) }).catch((err) => err);
    expect(error).toBeInstanceOf(ComicSourceError);
    expect(error).toMatchObject({ code: COMIC_SOURCE_ERROR.HTTP, status });
    expect(error.message).not.toContain(text);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('rejects redirects of every form', async () => {
    const cases = [
      { type: 'opaqueredirect', status: 0, ok: false, redirected: false, headers: new Headers() },
      new Response(null, { status: 302, headers: { Location: '/login' } }),
      Object.assign(jsonResponse(manifest()), {}),
    ];
    // A followed redirect that landed on JSON is still refused.
    Object.defineProperty(cases[2], 'redirected', { value: true });
    for (const response of cases) {
      const error = await fetchComicSource({ ...expected, fetch: fetchReturning(response) }).catch((err) => err);
      expect(error).toMatchObject({ code: COMIC_SOURCE_ERROR.REDIRECTED });
    }
  });

  it('rejects HTML and other non-JSON responses', async () => {
    for (const contentType of ['text/html; charset=utf-8', 'text/plain', 'application/jsonp', '']) {
      const response = new Response(JSON.stringify(manifest()), { status: 200, headers: contentType ? { 'Content-Type': contentType } : {} });
      if (!contentType) response.headers.delete('content-type');
      const error = await fetchComicSource({ ...expected, fetch: fetchReturning(response) }).catch((err) => err);
      expect(error, contentType).toMatchObject({ code: COMIC_SOURCE_ERROR.NOT_JSON, status: 200 });
    }
  });

  it('rejects invalid JSON and invalid UTF-8', async () => {
    for (const body of ['{"projectId":7,', '<!doctype html><p>sign in</p>', new Uint8Array([0x7b, 0xff, 0x7d])]) {
      const response = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      const error = await fetchComicSource({ ...expected, fetch: fetchReturning(response) }).catch((err) => err);
      expect(error).toMatchObject({ code: COMIC_SOURCE_ERROR.INVALID_JSON });
    }
  });

  it('bounds the response size by header and by streamed bytes', async () => {
    const declared = jsonResponse(manifest(), { headers: { 'Content-Length': String(COMIC_MANIFEST_MAX_BYTES + 1) } });
    await expect(fetchComicSource({ ...expected, fetch: fetchReturning(declared) }))
      .rejects.toMatchObject({ code: COMIC_SOURCE_ERROR.TOO_LARGE });
    const streamed = jsonResponse(manifest());
    await expect(fetchComicSource({ ...expected, fetch: fetchReturning(streamed), maxBytes: 64 }))
      .rejects.toMatchObject({ code: COMIC_SOURCE_ERROR.TOO_LARGE });
  });

  it('reports a malformed manifest with the response status and no source', async () => {
    const error = await fetchComicSource({ ...expected, fetch: fetchReturning(jsonResponse(manifest({ assetId: 99 }))) })
      .catch((err) => err);
    expect(error).toMatchObject({ code: COMIC_SOURCE_ERROR.INVALID_MANIFEST, reason: 'asset', status: 200 });
  });

  it('reports a network failure without retrying', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(fetchComicSource({ ...expected, fetch })).rejects.toMatchObject({ code: COMIC_SOURCE_ERROR.NETWORK, status: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not request anything when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = fetchReturning(jsonResponse(manifest()));
    await expect(fetchComicSource({ ...expected, fetch, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects with the abort when cancelled while the request is out', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = fetchComicSource({ ...expected, fetch, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with the abort when cancelled while the body streams, or after a response arrives', async () => {
    const controller = new AbortController();
    let push;
    const stream = new ReadableStream({ start(c) { push = c; } });
    const response = new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    const pending = fetchComicSource({ ...expected, fetch: fetchReturning(response), signal: controller.signal });
    push.enqueue(new TextEncoder().encode('{"projectId":'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    push.error(new DOMException('aborted', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // Fetch resolved, but the caller had already cancelled: no source is returned.
    const late = new AbortController();
    const fetch = vi.fn(async () => { late.abort(); return jsonResponse(manifest()); });
    await expect(fetchComicSource({ ...expected, fetch, signal: late.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses an invalid identity before fetching', async () => {
    const fetch = fetchReturning(jsonResponse(manifest()));
    await expect(fetchComicSource({ projectId: 'x', assetId: 1, fetch })).rejects.toMatchObject({ code: COMIC_SOURCE_ERROR.INVALID_REQUEST });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ─── Actual Milestone A endpoint ─────────────────────────────────────────────

if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describe('comic-source: actual manifest endpoint', () => {
  const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
  const COMICS = fileURLToPath(new URL('./fixtures/comic-archives/', import.meta.url));
  let env;

  async function make7z(entries) {
    const SevenZip = createRequire(import.meta.url)('7z-wasm');
    const module = await SevenZip({ print() {}, printErr() {} });
    module.FS.mkdirTree('/w');
    module.FS.chdir('/w');
    for (const [name, data] of entries) module.FS.writeFile('/w/' + name, data);
    const code = module.callMain(['a', '-t7z', '-mtc=off', '-mta=off', '-mtm=off', '-mmt=1', '-bsp0', '-bso0', '-bse0',
      '/out.7z', ...entries.map(([name]) => name)]);
    if (code !== 0) throw new Error('7z-wasm failed with ' + code);
    return Buffer.from(module.FS.readFile('/out.7z'));
  }

  beforeAll(async () => {
    const { openDatabase, runMigrations, closeDatabase } = await import('../src/db.js');
    const { createApp } = await import('../src/app.js');
    const { ensureAuthEnablement } = await import('../src/auth/auth-state.js');
    const { createProjectRepository } = await import('../src/data/project-repository.js');
    const { createAssetRepository } = await import('../src/data/asset-repository.js');
    const { formatProjectDirName } = await import('../src/storage/project-storage.js');
    const { createPreviewService } = await import('../src/services/preview-service.js');
    const { createComicRuntime } = await import('../src/services/comic-runtime.js');
    const { defaultComicPreparationCacheRoot } = await import('../src/services/comic-preparation-cache.js');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-comic-source-'));
    const appDataRoot = path.join(tmpDir, 'app');
    const projectsRoot = path.join(tmpDir, 'projects');
    const previewRoot = path.join(appDataRoot, 'previews');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(previewRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const db = openDatabase(path.join(appDataRoot, 'creatorcrate.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const projectRepo = createProjectRepository(db);
    const assetRepo = createAssetRepository(db);
    const runtime = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 } });
    await runtime.start();
    const previewService = createPreviewService({ db, projectsRoot, previewRoot });
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
      appDataRoot, authState: { csrfPepper }, comicRuntime: runtime, previewService,
    });
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      app(req, res);
    });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    const origin = `http://127.0.0.1:${port}`;

    const addAsset = (title, relPath, bytes, mimeType) => {
      let project = projectRepo.create({
        title, projectType: 'images', slug: slugify(title, { lowercase: true }), description: '', notes: '',
        status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const dir = formatProjectDirName(project.id, project.slug);
      const absPath = path.resolve(projectsRoot, dir);
      fs.mkdirSync(absPath, { recursive: true });
      project = projectRepo.setProjectDir(project.id, dir);
      bindTestProjectOwnership(db, project.id, absPath);
      fs.writeFileSync(path.join(absPath, relPath), bytes);
      const stat = fs.statSync(path.join(absPath, relPath));
      const asset = assetRepo.upsert(project.id, relPath, {
        filename: relPath, extension: relPath.split('.').pop().toLowerCase(), mimeType,
        sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
      });
      return { projectId: project.id, assetId: asset.id };
    };

    // The browser resolves the adapter's root-relative URL against the page origin.
    const fetch = vi.fn((url, init) => globalThis.fetch(origin + url, init));

    env = {
      runtime, requests, fetch, addAsset,
      async cleanup() {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
        await runtime.close();
        if (db.open) closeDatabase(db);
        fs.rmSync(defaultComicPreparationCacheRoot(appDataRoot), { recursive: true, force: true });
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
      },
    };
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  async function image(seed) {
    const raw = Buffer.alloc(24 * 32 * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 7 + seed) & 0xff;
    return sharp(raw, { raw: { width: 24, height: 32, channels: 3 } }).png().toBuffer();
  }

  // One adapter load: exactly one manifest request, no numbered page or original request,
  // and the accepted source matches the server's own JSON for the same revision.
  async function loadThroughAdapter(ids) {
    const before = env.requests.length;
    const result = await fetchComicSource({ ...ids, fetch: env.fetch, signal: new AbortController().signal });
    expect(env.requests.slice(before)).toEqual([`/projects/${ids.projectId}/assets/${ids.assetId}/comic`]);
    const server = await (await env.fetch(`/projects/${ids.projectId}/assets/${ids.assetId}/comic`)).json();
    expect(result.comic.revision).toBe(server.revision);
    expect(result.comic.pageCount).toBe(server.pageCount);
    expect(result.comic.pages.map((page) => [page.position, page.name, page.url]))
      .toEqual(server.pages.map((page) => [page.position, page.name, page.url]));
    expect(result.source.items.map((item) => item.mediaUrl)).toEqual(server.pages.map((page) => page.url));
    expect(env.requests.some((url) => /\/comic\/pages\/|\/original/.test(url))).toBe(false);
    return result;
  }

  it('accepts a real CBZ manifest with duplicate basenames and an unavailable page', async () => {
    const a = await image(1);
    const b = await image(2);
    const cbz = makeZip([
      { name: 'ch2/01.png', data: b },
      { name: 'ch1/01.png', data: a },
      { name: 'ch1/02.png', data: Buffer.alloc(0) },
      { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') },
    ]);
    const ids = env.addAsset('Source CBZ', 'book.cbz', cbz, 'application/vnd.comicbook+zip');
    const { source, comic } = await loadThroughAdapter(ids);
    expect(comic).toMatchObject({ format: 'cbz', pageCount: 3, preparation: { solid: false, state: 'not-required' } });
    // Server natural order (ch1/01, ch1/02, ch2/01), not archive order; equal basenames stay distinct.
    expect(comic.pages.map((page) => page.name)).toEqual(['01.png', '02.png', '01.png']);
    expect(comic.pages[1]).toMatchObject({ available: false, problem: 'PAGE_INVALID_IMAGE' });
    expect(comic.unavailablePositions).toEqual([2]);
    expect(source.items.map((item) => [item.position, item.available])).toEqual([[1, true], [2, false], [3, true]]);
    expect(source).toMatchObject({ kind: VIEWER_SOURCE_KIND_COMIC, wrap: false, slideshow: false });
  });

  it.each([
    ['comic-rar4.cbr', false],
    ['comic-rar5.cbr', false],
    ['comic-rar5-solid.cbr', true],
  ])('accepts a real CBR manifest (%s) without starting a preparation', async (fixture, solid) => {
    const ids = env.addAsset('Source CBR ' + fixture, 'book.cbr', fs.readFileSync(path.join(COMICS, fixture)),
      'application/vnd.comicbook-rar');
    const { source, comic } = await loadThroughAdapter(ids);
    expect(comic).toMatchObject({ format: 'cbr', pageCount: 6, preparation: { solid, state: solid ? 'on-demand' : 'not-required' } });
    expect(source.items.map((item) => item.position)).toEqual([1, 2, 3, 4, 5, 6]);
    // Reading a manifest never schedules archive extraction.
    expect(env.runtime.preparationCache.snapshot()).toMatchObject({ pending: 0, entries: 0 });
  });

  it('accepts a real CB7 manifest', async () => {
    const cb7 = await make7z([['b.png', await image(3)], ['a.png', await image(4)]]);
    const ids = env.addAsset('Source CB7', 'book.cb7', cb7, 'application/x-cb7');
    const { comic } = await loadThroughAdapter(ids);
    expect(comic).toMatchObject({ format: 'cb7', pageCount: 2 });
    expect(comic.pages.map((page) => page.name)).toEqual(['a.png', 'b.png']);
    expect(env.runtime.preparationCache.snapshot()).toMatchObject({ pending: 0, entries: 0 });
  });

  it('accepts a real empty comic as an empty source', async () => {
    const ids = env.addAsset('Source empty', 'empty.cbz', makeZip([{ name: 'ComicInfo.xml', data: Buffer.from('<x/>') }]),
      'application/vnd.comicbook+zip');
    const { source, comic } = await loadThroughAdapter(ids);
    expect(comic).toMatchObject({ pageCount: 0, empty: true });
    expect(source.items).toEqual([]);
  });

  it('rejects the real endpoint answer for another asset and preserves real HTTP errors', async () => {
    const a = env.addAsset('Source A', 'a.cbz', makeZip([{ name: '1.png', data: await image(5) }]), 'application/vnd.comicbook+zip');
    const png = env.addAsset('Source image', 'i.png', await image(6), 'image/png');
    const crossed = vi.fn((url, init) => env.fetch(`/projects/${a.projectId}/assets/${a.assetId}/comic`, init));
    await expect(fetchComicSource({ projectId: a.projectId, assetId: a.assetId + 1000, fetch: crossed }))
      .rejects.toMatchObject({ code: COMIC_SOURCE_ERROR.INVALID_MANIFEST, reason: 'asset' });
    await expect(fetchComicSource({ ...png, fetch: env.fetch }))
      .rejects.toMatchObject({ code: COMIC_SOURCE_ERROR.HTTP, status: 415 });
    await expect(fetchComicSource({ projectId: a.projectId, assetId: 999999, fetch: env.fetch }))
      .rejects.toMatchObject({ code: COMIC_SOURCE_ERROR.HTTP, status: 404 });
  });

  it('cancels a real manifest request safely', async () => {
    const ids = env.addAsset('Source cancel', 'c.cbz', makeZip([{ name: '1.png', data: await image(7) }]), 'application/vnd.comicbook+zip');
    const controller = new AbortController();
    const pending = fetchComicSource({ ...ids, fetch: env.fetch, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await env.runtime.preparationCache.whenIdle();
    // The service settles without leaving admission work behind.
    await expect.poll(() => env.runtime.admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
    // The comic remains readable afterwards.
    expect((await loadThroughAdapter(ids)).comic.pageCount).toBe(1);
  });
});
