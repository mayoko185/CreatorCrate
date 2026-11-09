import { describe, it, expect } from 'vitest';
import {
  VIEWER_RECONCILE_CLOSED,
  VIEWER_RECONCILE_IDLE,
  VIEWER_RECONCILE_KEPT,
  VIEWER_RECONCILE_REPLACED,
  VIEWER_SOURCE_MODE_SEQUENCE,
  VIEWER_SOURCE_MODE_SINGLE,
  buildViewerItemKey,
  canPlayViewerSlideshow,
  createSingleImageSource,
  createSlideshowSource,
  createViewerSource,
  findViewerItemByIdentity,
  findViewerItemIndex,
  getViewerItem,
  normalizeViewerItem,
  normalizeViewerUrl,
  reconcileViewerSource,
  selectInitialViewerItem,
  stepViewerSequence,
  viewerItemFromSlideshowEntry,
} from '../src/static/client/viewer-sequence.js';

// Entries in the exact shape buildSlideshowSequence serializes.
function entry(projectId, id, filename, revision = `rev-${id}`) {
  return {
    id,
    projectId,
    filename,
    previewUrl: `/projects/${projectId}/assets/${id}/preview?v=${revision}`,
    viewerUrl: `/projects/${projectId}/assets/${id}`,
    originalUrl: `/projects/${projectId}/assets/${id}/original`,
    revision,
  };
}

function rawItem(projectId, assetId, extra = {}) {
  return {
    projectId,
    assetId,
    title: `asset-${assetId}.png`,
    mediaUrl: `/projects/${projectId}/assets/${assetId}/preview?v=r1`,
    originalUrl: `/projects/${projectId}/assets/${assetId}/original`,
    detailsUrl: `/projects/${projectId}/assets/${assetId}`,
    revision: 'r1',
    ...extra,
  };
}

function comicPage(position, extra = {}) {
  return {
    projectId: 7,
    assetId: 70,
    position,
    title: `Page ${position}`,
    mediaUrl: `/projects/7/assets/70/comic/pages/${position}?v=opaque.comic+rev/1`,
    revision: 'opaque.comic+rev/1',
    ...extra,
  };
}

function sequence(items, options = {}) {
  return createViewerSource({ key: 'project:1:assets', mode: VIEWER_SOURCE_MODE_SEQUENCE, items, ...options });
}

const keys = (source) => source.items.map((item) => item.key);

describe('viewer-sequence: item contract', () => {
  it('normalizes a complete item to plain frozen data', () => {
    const item = normalizeViewerItem(rawItem(1, 5));
    expect(item).toEqual({
      key: 'p:1|a:5',
      projectId: '1',
      assetId: '5',
      position: null,
      title: 'asset-5.png',
      alt: 'asset-5.png',
      mediaUrl: '/projects/1/assets/5/preview?v=r1',
      originalUrl: '/projects/1/assets/5/original',
      detailsUrl: '/projects/1/assets/5',
      revision: 'r1',
      available: true,
      unavailableReason: null,
    });
    expect(Object.isFrozen(item)).toBe(true);
  });

  it('drops items with missing or malformed identity and never throws', () => {
    const malformed = [
      undefined, null, 0, 'x', [], {},
      { assetId: 0 }, { assetId: -1 }, { assetId: 1.5 }, { assetId: '' }, { assetId: '  ' },
      { assetId: {} }, { assetId: 'a\u0000b' },
      { assetId: 1, projectId: 0 }, { assetId: 1, projectId: {} },
      { assetId: 1, position: 0 }, { assetId: 1, position: '2' }, { assetId: 1, position: 2.5 },
    ];
    for (const raw of malformed) {
      expect(normalizeViewerItem(raw)).toBeNull();
    }
    const source = createViewerSource({ items: malformed });
    expect(source.items).toEqual([]);
    expect(source.droppedCount).toBe(malformed.length);
    expect(() => createViewerSource(null)).not.toThrow();
    expect(() => createViewerSource({ items: 'nope' })).not.toThrow();
    expect(createViewerSource({ items: 'nope' }).items).toEqual([]);
  });

  it('degrades malformed optional fields to safe defaults', () => {
    const item = normalizeViewerItem({
      assetId: 9,
      title: 42,
      alt: null,
      mediaUrl: '/projects/1/assets/9/preview?v=x',
      originalUrl: 'javascript:alert(1)',
      detailsUrl: '//evil.example/assets/9',
      revision: { not: 'opaque' },
    });
    expect(item).toMatchObject({
      key: 'a:9', projectId: null, title: 'Asset 9', alt: 'Asset 9',
      originalUrl: null, detailsUrl: null, revision: null, available: true,
    });
  });

  it('accepts only server-style root-relative URLs', () => {
    expect(normalizeViewerUrl('/projects/1/assets/2/preview?v=a%20b')).toBe('/projects/1/assets/2/preview?v=a%20b');
    for (const unsafe of [
      'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://example.com/a.png', '//example.com/a.png',
      '/\\example.com', 'relative/path.png', '/with space', '/tab\there', '/nl\nhere', '', null, 5,
    ]) {
      expect(normalizeViewerUrl(unsafe)).toBeNull();
    }
  });

  it('keeps labels as plain text without interpreting markup', () => {
    const item = normalizeViewerItem(rawItem(1, 3, { title: '  <img src=x onerror=alert(1)>\u0007 cover ', alt: '' }));
    expect(item.title).toBe('<img src=x onerror=alert(1)> cover');
    expect(item.alt).toBe(item.title);
  });

  it('treats revisions as opaque values compared by equality only', () => {
    expect(normalizeViewerItem(rawItem(1, 1, { revision: 'sha256:AbC/+=.~' })).revision).toBe('sha256:AbC/+=.~');
    expect(normalizeViewerItem(rawItem(1, 1, { revision: 17 })).revision).toBe('17');
    expect(normalizeViewerItem(rawItem(1, 1, { revision: '' })).revision).toBeNull();
    expect(normalizeViewerItem(rawItem(1, 1, { revision: undefined })).revision).toBeNull();
  });

  it('marks unavailable items while keeping their identity', () => {
    const missingMedia = normalizeViewerItem(rawItem(1, 4, { mediaUrl: null }));
    expect(missingMedia).toMatchObject({
      key: 'p:1|a:4', available: false, unavailableReason: 'missing-media', mediaUrl: null, originalUrl: null,
    });
    const flagged = normalizeViewerItem(rawItem(1, 5, { available: false, unavailableReason: 'decode-failed' }));
    expect(flagged).toMatchObject({ available: false, unavailableReason: 'decode-failed', originalUrl: null });
    const badReason = normalizeViewerItem(rawItem(1, 6, { available: false, unavailableReason: '<b>x</b>' }));
    expect(badReason.unavailableReason).toBe('unavailable');
  });

  it('maps the existing slideshow entry shape without constructing URLs', () => {
    const raw = viewerItemFromSlideshowEntry(entry(2, 11, 'cover.png', 'abc'));
    expect(normalizeViewerItem(raw)).toMatchObject({
      key: 'p:2|a:11', title: 'cover.png', alt: 'cover.png',
      mediaUrl: '/projects/2/assets/11/preview?v=abc', originalUrl: '/projects/2/assets/11/original',
      detailsUrl: '/projects/2/assets/11', revision: 'abc',
    });
    // Entries serialized before projectId/revision existed still normalize.
    const legacy = { id: 3, filename: 'a.png', previewUrl: '/projects/1/assets/3/preview?v=z', viewerUrl: '/projects/1/assets/3' };
    expect(normalizeViewerItem(viewerItemFromSlideshowEntry(legacy))).toMatchObject({
      key: 'a:3', projectId: null, originalUrl: null, revision: null, available: true,
    });
    expect(viewerItemFromSlideshowEntry(null)).toBeNull();
  });
});

describe('viewer-sequence: identity', () => {
  it('derives keys from identity only, with separators that cannot be forged', () => {
    expect(buildViewerItemKey({ projectId: 1, assetId: 2 })).toBe('p:1|a:2');
    expect(buildViewerItemKey({ projectId: '1|a:2', assetId: 3 })).toBe('p:1%7Ca%3A2|a:3');
    expect(buildViewerItemKey({ assetId: 2, position: 4 })).toBe('a:2|n:4');
    expect(buildViewerItemKey({ projectId: 1 })).toBeNull();
  });

  it('keeps same filename and same local id in different projects apart', () => {
    const source = sequence([
      rawItem(1, 5, { title: 'cover.png' }),
      rawItem(2, 5, { title: 'cover.png' }),
      rawItem(2, 6, { title: 'cover.png' }),
    ]);
    expect(keys(source)).toEqual(['p:1|a:5', 'p:2|a:5', 'p:2|a:6']);
    expect(findViewerItemByIdentity(source.items, { projectId: 2, assetId: 5 }).key).toBe('p:2|a:5');
    // Without a project, an ambiguous local id selects nothing.
    expect(findViewerItemByIdentity(source.items, { assetId: 5 })).toBeNull();
    expect(findViewerItemByIdentity(source.items, { assetId: 6 }).key).toBe('p:2|a:6');
    expect(findViewerItemByIdentity(source.items, { projectId: 3, assetId: 6 })).toBeNull();
  });

  it('addresses multiple pages of one comic asset independently, keeping unavailable positions', () => {
    const source = createViewerSource({
      key: 'comic:7:70',
      items: [comicPage(1), comicPage(2, { mediaUrl: null, unavailableReason: 'page-unreadable' }), comicPage(3)],
      wrap: false,
    });
    expect(keys(source)).toEqual(['p:7|a:70|n:1', 'p:7|a:70|n:2', 'p:7|a:70|n:3']);
    expect(source.items.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(source.items[1]).toMatchObject({ available: false, unavailableReason: 'page-unreadable' });
    expect(source.items[0].revision).toBe('opaque.comic+rev/1');
    expect(source.items[2].mediaUrl).toBe('/projects/7/assets/70/comic/pages/3?v=opaque.comic+rev/1');
    expect(findViewerItemByIdentity(source.items, { assetId: 70, position: 3 }).key).toBe('p:7|a:70|n:3');
    expect(findViewerItemByIdentity(source.items, { assetId: 70 })).toBeNull();
    expect(source.wrap).toBe(false);
    expect(source.slideshow).toBe(false);
  });

  it('drops duplicate identities after the first occurrence', () => {
    const source = sequence([rawItem(1, 1, { title: 'first' }), rawItem(1, 2), rawItem(1, 1, { title: 'second' })]);
    expect(keys(source)).toEqual(['p:1|a:1', 'p:1|a:2']);
    expect(source.items[0].title).toBe('first');
    expect(source.droppedCount).toBe(1);
  });
});

describe('viewer-sequence: sources', () => {
  it('represents an empty source', () => {
    const source = createViewerSource();
    expect(source).toMatchObject({
      key: null, label: '', mode: VIEWER_SOURCE_MODE_SEQUENCE, initialKey: null, wrap: false, slideshow: false,
      droppedCount: 0,
    });
    expect(source.items).toEqual([]);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.items)).toBe(true);
    expect(selectInitialViewerItem(source)).toEqual({ key: null, index: -1 });
    expect(canPlayViewerSlideshow(source)).toBe(false);
    expect(stepViewerSequence(source, null, 'next')).toMatchObject({ key: null, index: -1, moved: false, reason: 'empty' });
  });

  it('opens a thumbnail as only the selected image', () => {
    const entries = [entry(1, 1, 'a.png'), entry(1, 2, 'b.png'), entry(1, 3, 'c.png')];
    const source = createSingleImageSource({ key: 'project:1:assets', label: 'Project One', entries, projectId: 1, assetId: 2 });
    expect(source.mode).toBe(VIEWER_SOURCE_MODE_SINGLE);
    expect(keys(source)).toEqual(['p:1|a:2']);
    expect(source.initialKey).toBe('p:1|a:2');
    expect(source.wrap).toBe(false);
    expect(source.slideshow).toBe(false);
    expect(canPlayViewerSlideshow(source)).toBe(false);
    expect(stepViewerSequence(source, 'p:1|a:2', 'next')).toMatchObject({ key: 'p:1|a:2', moved: false, boundary: 'end' });
    expect(stepViewerSequence(source, 'p:1|a:2', 'previous')).toMatchObject({ key: 'p:1|a:2', moved: false, boundary: 'start' });
  });

  it('refuses a thumbnail source for an unknown, ambiguous or media-less image', () => {
    const entries = [entry(1, 5, 'x.png'), entry(2, 5, 'x.png'), { id: 9, projectId: 1, filename: 'gone.png', previewUrl: null }];
    expect(createSingleImageSource({ entries, projectId: 1, assetId: 404 }).items).toEqual([]);
    expect(createSingleImageSource({ entries, assetId: 5 }).items).toEqual([]);
    expect(createSingleImageSource({ entries, projectId: 1, assetId: 9 }).items).toEqual([]);
    expect(keys(createSingleImageSource({ entries, projectId: 2, assetId: 5 }))).toEqual(['p:2|a:5']);
  });

  it('keeps only the initial item when a generic single source is given several', () => {
    const items = [rawItem(1, 1), rawItem(1, 2), rawItem(1, 3)];
    const source = createViewerSource({ mode: 'single', items, initialKey: 'p:1|a:3', wrap: true, slideshow: true });
    expect(keys(source)).toEqual(['p:1|a:3']);
    expect(source.wrap).toBe(false);
    expect(source.slideshow).toBe(false);
    expect(source.droppedCount).toBe(2);
  });

  it('builds the explicit slideshow from the complete server sequence in server order', () => {
    // Deliberately not sorted by id, filename or project: the server order is authoritative.
    const entries = [entry(3, 30, 'zeta.png'), entry(1, 4, 'alpha.png'), entry(2, 99, 'beta.png'), entry(1, 2, 'alpha.png')];
    const source = createSlideshowSource({ key: 'library', label: 'All assets', entries });
    expect(keys(source)).toEqual(['p:3|a:30', 'p:1|a:4', 'p:2|a:99', 'p:1|a:2']);
    expect(source).toMatchObject({ mode: VIEWER_SOURCE_MODE_SEQUENCE, wrap: true, slideshow: true, label: 'All assets' });
    expect(canPlayViewerSlideshow(source)).toBe(true);
    expect(selectInitialViewerItem(source)).toEqual({ key: 'p:3|a:30', index: 0 });
    // Inputs are not mutated or reordered.
    expect(entries.map((value) => value.id)).toEqual([30, 4, 99, 2]);
  });

  it('only plays a slideshow with at least two available items', () => {
    expect(canPlayViewerSlideshow(createSlideshowSource({ entries: [entry(1, 1, 'a.png')] }))).toBe(false);
    const oneAvailable = createViewerSource({
      items: [rawItem(1, 1), rawItem(1, 2, { available: false })], wrap: true, slideshow: true,
    });
    expect(canPlayViewerSlideshow(oneAvailable)).toBe(false);
    expect(canPlayViewerSlideshow(sequence([rawItem(1, 1), rawItem(1, 2)]))).toBe(false);
  });

  it('selects the initial item by identity, falling back deterministically', () => {
    const items = [rawItem(1, 1, { available: false }), rawItem(1, 2), rawItem(1, 3)];
    expect(selectInitialViewerItem(sequence(items, { initialKey: 'p:1|a:3' }))).toEqual({ key: 'p:1|a:3', index: 2 });
    // An explicitly requested unavailable item is still opened so the viewer can say so.
    expect(selectInitialViewerItem(sequence(items, { initialKey: 'p:1|a:1' }))).toEqual({ key: 'p:1|a:1', index: 0 });
    // Unknown initial key: first available item.
    const unknown = sequence(items, { initialKey: 'p:9|a:9' });
    expect(unknown.initialKey).toBeNull();
    expect(selectInitialViewerItem(unknown)).toEqual({ key: 'p:1|a:2', index: 1 });
    // Nothing available: first item.
    const none = sequence([rawItem(1, 1, { mediaUrl: null }), rawItem(1, 2, { mediaUrl: null })]);
    expect(selectInitialViewerItem(none)).toEqual({ key: 'p:1|a:1', index: 0 });
  });

  it('looks items up by key, never by position', () => {
    const source = sequence([rawItem(1, 10), rawItem(1, 20)]);
    expect(findViewerItemIndex(source, 'p:1|a:20')).toBe(1);
    expect(findViewerItemIndex(source, '1')).toBe(-1);
    expect(findViewerItemIndex(source, 1)).toBe(-1);
    expect(getViewerItem(source, 'p:1|a:10').assetId).toBe('10');
    expect(getViewerItem(source, 'missing')).toBeNull();
  });
});

describe('viewer-sequence: navigation', () => {
  const items = [rawItem(1, 1), rawItem(1, 2), rawItem(1, 3)];

  it('wraps previous/next at the boundaries when the source wraps', () => {
    const source = sequence(items, { wrap: true });
    expect(stepViewerSequence(source, 'p:1|a:1', 'next')).toEqual({
      key: 'p:1|a:2', index: 1, moved: true, wrapped: false, boundary: null, reason: null,
    });
    expect(stepViewerSequence(source, 'p:1|a:3', 'next')).toMatchObject({ key: 'p:1|a:1', index: 0, moved: true, wrapped: true });
    expect(stepViewerSequence(source, 'p:1|a:1', 'previous')).toMatchObject({ key: 'p:1|a:3', index: 2, moved: true, wrapped: true });
    expect(stepViewerSequence(source, 'p:1|a:2', -1)).toMatchObject({ key: 'p:1|a:1', moved: true, wrapped: false });
    expect(stepViewerSequence(source, 'p:1|a:2', 1)).toMatchObject({ key: 'p:1|a:3', moved: true });
  });

  it('clamps at the first and last item when the source does not wrap', () => {
    const source = sequence(items, { wrap: false });
    expect(stepViewerSequence(source, 'p:1|a:3', 'next')).toEqual({
      key: 'p:1|a:3', index: 2, moved: false, wrapped: false, boundary: 'end', reason: null,
    });
    expect(stepViewerSequence(source, 'p:1|a:1', 'previous')).toMatchObject({ key: 'p:1|a:1', moved: false, boundary: 'start' });
    expect(stepViewerSequence(source, 'p:1|a:2', 'next')).toMatchObject({ key: 'p:1|a:3', moved: true, boundary: null });
    expect(stepViewerSequence(source, 'p:1|a:2', 'previous')).toMatchObject({ key: 'p:1|a:1', moved: true });
  });

  it('does not move within a single-item sequence', () => {
    const wrapping = sequence([rawItem(1, 1)], { wrap: true });
    expect(stepViewerSequence(wrapping, 'p:1|a:1', 'next')).toMatchObject({ key: 'p:1|a:1', moved: false, reason: 'no-other-item' });
    const clamped = sequence([rawItem(1, 1)]);
    expect(stepViewerSequence(clamped, 'p:1|a:1', 'previous')).toMatchObject({ key: 'p:1|a:1', moved: false, boundary: 'start' });
  });

  it('answers an unknown current key with the initial selection', () => {
    const source = sequence(items, { wrap: true, initialKey: 'p:1|a:2' });
    expect(stepViewerSequence(source, 'p:2|a:2', 'next')).toMatchObject({
      key: 'p:1|a:2', index: 1, moved: false, reason: 'unknown-current',
    });
  });

  it('visits unavailable items by default and can skip them on request', () => {
    const pages = createViewerSource({
      items: [comicPage(1), comicPage(2, { available: false }), comicPage(3, { mediaUrl: null }), comicPage(4)],
    });
    expect(stepViewerSequence(pages, 'p:7|a:70|n:1', 'next')).toMatchObject({ key: 'p:7|a:70|n:2', moved: true });
    expect(stepViewerSequence(pages, 'p:7|a:70|n:1', 'next', { skipUnavailable: true }))
      .toMatchObject({ key: 'p:7|a:70|n:4', index: 3, moved: true });
    expect(stepViewerSequence(pages, 'p:7|a:70|n:4', 'previous', { skipUnavailable: true }))
      .toMatchObject({ key: 'p:7|a:70|n:1', moved: true });

    const tail = createViewerSource({ items: [comicPage(1), comicPage(2, { available: false })] });
    expect(stepViewerSequence(tail, 'p:7|a:70|n:1', 'next', { skipUnavailable: true }))
      .toMatchObject({ key: 'p:7|a:70|n:1', moved: false, boundary: 'end' });

    const looped = createViewerSource({ items: [rawItem(1, 1), rawItem(1, 2, { available: false })], wrap: true });
    expect(stepViewerSequence(looped, 'p:1|a:1', 'next', { skipUnavailable: true }))
      .toMatchObject({ key: 'p:1|a:1', moved: false, reason: 'no-other-item' });
    expect(stepViewerSequence(looped, 'p:1|a:2', 'next', { skipUnavailable: true }))
      .toMatchObject({ key: 'p:1|a:1', moved: true, wrapped: true });
  });
});

describe('viewer-sequence: live-refresh reconciliation', () => {
  const base = [rawItem(1, 1), rawItem(1, 2), rawItem(1, 3), rawItem(1, 4)];

  it('keeps the current item and its view when nothing about it changed', () => {
    const previous = sequence(base, { wrap: true, slideshow: true });
    const result = reconcileViewerSource(previous, 'p:1|a:2', base);
    expect(result).toMatchObject({
      outcome: VIEWER_RECONCILE_KEPT, key: 'p:1|a:2', index: 1,
      revisionChanged: false, mediaChanged: false, originalChanged: false, availabilityChanged: false,
      reload: false, preserveView: true, reason: null,
    });
    expect(result.source).toMatchObject({ key: 'project:1:assets', mode: 'sequence', wrap: true, slideshow: true, initialKey: 'p:1|a:2' });
  });

  it('keeps the current identity when the sequence is reordered', () => {
    const previous = sequence(base);
    const reordered = [base[3], base[1], base[0], base[2]];
    const result = reconcileViewerSource(previous, 'p:1|a:1', reordered);
    expect(keys(result.source)).toEqual(['p:1|a:4', 'p:1|a:2', 'p:1|a:1', 'p:1|a:3']);
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_KEPT, key: 'p:1|a:1', index: 2, reload: false, preserveView: true });
  });

  it('asks for a reload when the revision changes under the same identity', () => {
    const previous = sequence(base);
    const next = base.map((item) => (item.assetId === 3 ? { ...item, revision: 'r2' } : item));
    const result = reconcileViewerSource(previous, 'p:1|a:3', next);
    expect(result).toMatchObject({
      outcome: VIEWER_RECONCILE_KEPT, key: 'p:1|a:3', revisionChanged: true, mediaChanged: false,
      reload: true, preserveView: false,
    });
    expect(result.item.revision).toBe('r2');
  });

  it('asks for a reload when the display media URL changes under the same identity', () => {
    const previous = sequence(base);
    const next = base.map((item) => (item.assetId === 3
      ? { ...item, mediaUrl: '/projects/1/assets/3/original' }
      : item));
    const result = reconcileViewerSource(previous, 'p:1|a:3', next);
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_KEPT, revisionChanged: false, mediaChanged: true, reload: true, preserveView: false });
    expect(result.item.mediaUrl).toBe('/projects/1/assets/3/original');
  });

  it('reports an original URL change without reloading the display media', () => {
    const previous = sequence(base);
    const next = base.map((item) => (item.assetId === 3 ? { ...item, originalUrl: undefined } : item));
    const result = reconcileViewerSource(previous, 'p:1|a:3', next);
    expect(result).toMatchObject({
      outcome: VIEWER_RECONCILE_KEPT, originalChanged: true, mediaChanged: false, reload: false, preserveView: false,
    });
    expect(result.item.originalUrl).toBeNull();
  });

  it('reloads when the current item becomes unavailable', () => {
    const previous = sequence(base);
    const next = base.map((item) => (item.assetId === 2 ? { ...item, mediaUrl: null } : item));
    const result = reconcileViewerSource(previous, 'p:1|a:2', next);
    expect(result).toMatchObject({
      outcome: VIEWER_RECONCILE_KEPT, availabilityChanged: true, reload: true, preserveView: false,
    });
    expect(result.item).toMatchObject({ available: false, unavailableReason: 'missing-media' });
  });

  it('never carries the previous revision or URLs into the result', () => {
    const previous = sequence(base);
    const next = base.map((item) => ({ ...item, revision: 'r9', mediaUrl: `${item.mediaUrl}&n=9` }));
    const result = reconcileViewerSource(previous, 'p:1|a:1', next);
    expect(result.item.revision).toBe('r9');
    expect(result.source.items.every((item) => item.revision === 'r9' && item.mediaUrl.endsWith('&n=9'))).toBe(true);
    expect(previous.items[0].revision).toBe('r1');
  });

  it('moves to the nearest surviving neighbor when the current item is removed', () => {
    const previous = sequence(base);
    const withoutTwo = [base[0], base[2], base[3]];
    expect(reconcileViewerSource(previous, 'p:1|a:2', withoutTwo)).toMatchObject({
      outcome: VIEWER_RECONCILE_REPLACED, key: 'p:1|a:3', index: 1, reload: true, preserveView: false, reason: 'removed',
    });
    // The former successor survives even after reordering.
    expect(reconcileViewerSource(previous, 'p:1|a:2', [base[3], base[2], base[0]]))
      .toMatchObject({ outcome: VIEWER_RECONCILE_REPLACED, key: 'p:1|a:3', index: 1 });
    // Last item removed: the predecessor takes over.
    expect(reconcileViewerSource(previous, 'p:1|a:4', base.slice(0, 3)))
      .toMatchObject({ outcome: VIEWER_RECONCILE_REPLACED, key: 'p:1|a:3', index: 2 });
    // No former neighbor survives: keep the slot within the new order.
    const fresh = [rawItem(1, 8), rawItem(1, 9)];
    const result = reconcileViewerSource(previous, 'p:1|a:3', fresh);
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_REPLACED, key: 'p:1|a:9', index: 1 });
    expect(result.source.initialKey).toBe('p:1|a:9');
  });

  it('never selects a same-named or same-id item from a different project', () => {
    const previous = sequence([rawItem(1, 5, { title: 'cover.png' }), rawItem(1, 6)]);
    const next = [rawItem(2, 5, { title: 'cover.png' }), rawItem(1, 6)];
    const result = reconcileViewerSource(previous, 'p:1|a:5', next);
    expect(result.outcome).toBe(VIEWER_RECONCILE_REPLACED);
    expect(result.key).toBe('p:1|a:6');
    expect(result.item.projectId).toBe('1');
  });

  it('closes a single-image source when its only item is removed', () => {
    const entries = [entry(1, 1, 'a.png'), entry(1, 2, 'b.png')];
    const single = createSingleImageSource({ key: 'project:1:assets', entries, projectId: 1, assetId: 2 });
    const refreshed = [viewerItemFromSlideshowEntry(entries[0])];
    const result = reconcileViewerSource(single, 'p:1|a:2', refreshed);
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_CLOSED, key: null, index: -1, item: null, reason: 'removed' });
    expect(result.source.items).toEqual([]);
    expect(result.source.mode).toBe(VIEWER_SOURCE_MODE_SINGLE);
  });

  it('keeps a single-image source narrowed to its own item after a refresh', () => {
    const entries = [entry(1, 1, 'a.png'), entry(1, 2, 'b.png'), entry(1, 3, 'c.png')];
    const single = createSingleImageSource({ entries, projectId: 1, assetId: 2 });
    const refreshed = [entries[2], { ...entries[1], revision: 'new', previewUrl: '/projects/1/assets/2/preview?v=new' }, entries[0]]
      .map(viewerItemFromSlideshowEntry);
    const result = reconcileViewerSource(single, 'p:1|a:2', refreshed);
    expect(keys(result.source)).toEqual(['p:1|a:2']);
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_KEPT, index: 0, revisionChanged: true, mediaChanged: true, reload: true });
    expect(result.source.slideshow).toBe(false);
  });

  it('closes on an empty replacement sequence', () => {
    const previous = sequence(base, { wrap: true, slideshow: true });
    for (const empty of [[], { items: [] }, null, undefined, 'garbage']) {
      const result = reconcileViewerSource(previous, 'p:1|a:3', empty);
      expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_CLOSED, key: null, item: null, reload: false, reason: 'empty' });
      expect(result.source.items).toEqual([]);
      expect(canPlayViewerSlideshow(result.source)).toBe(false);
    }
  });

  it('invalidates when the replacement names a different source', () => {
    const previous = sequence(base);
    const result = reconcileViewerSource(previous, 'p:1|a:1', { key: 'project:2:assets', items: base });
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_CLOSED, reason: 'source-changed', key: null });
    expect(result.source.items).toEqual([]);
  });

  it('reports idle when no item was being shown', () => {
    const previous = sequence(base, { initialKey: 'p:1|a:3' });
    const result = reconcileViewerSource(previous, null, base.slice(1));
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_IDLE, key: 'p:1|a:3', index: 1, reload: false, preserveView: false });
    expect(reconcileViewerSource(previous, null, [])).toMatchObject({ outcome: VIEWER_RECONCILE_IDLE, key: null, reason: 'empty' });
  });

  it('accepts a replacement label and keeps non-wrapping comic settings', () => {
    const previous = createViewerSource({ key: 'comic:7:70', label: 'Issue 1', items: [comicPage(1), comicPage(2), comicPage(3)] });
    const result = reconcileViewerSource(previous, 'p:7|a:70|n:2', {
      key: 'comic:7:70',
      label: 'Issue 1 (rescanned)',
      items: [comicPage(1, { revision: 'next' }), comicPage(2, { revision: 'next', mediaUrl: '/projects/7/assets/70/comic/pages/2?v=next' }), comicPage(3)],
    });
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_KEPT, key: 'p:7|a:70|n:2', revisionChanged: true, reload: true });
    expect(result.source).toMatchObject({ label: 'Issue 1 (rescanned)', wrap: false, slideshow: false });
  });
});
