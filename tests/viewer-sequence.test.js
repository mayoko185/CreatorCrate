import { buildAssetPreviewModel } from '../src/services/asset-presentation.js';
import { projectImagePresentationPolicy } from '../src/services/project-image-policy.js';
import { describe, it, expect } from 'vitest';
import {
  VIEWER_COMIC_READER_DEFAULTS,
  VIEWER_LAYOUT_SINGLE,
  VIEWER_LAYOUT_SPREAD,
  VIEWER_READING_LTR,
  VIEWER_READING_RTL,
  VIEWER_RECONCILE_CLOSED,
  VIEWER_RECONCILE_IDLE,
  VIEWER_RECONCILE_KEPT,
  VIEWER_RECONCILE_REPLACED,
  VIEWER_SOURCE_KIND_COMIC,
  VIEWER_SOURCE_KIND_IMAGE,
  VIEWER_SOURCE_MODE_SEQUENCE,
  VIEWER_SOURCE_MODE_SINGLE,
  VIEWER_SPREAD_COVER_ALONE,
  VIEWER_SPREAD_PAIR_FROM_FIRST,
  buildViewerItemKey,
  canPlayViewerSlideshow,
  comicPageGroupBounds,
  createSingleImageSource,
  createSlideshowSource,
  createViewerSource,
  findViewerItemByIdentity,
  findViewerItemIndex,
  formatComicPageGroupLabel,
  getViewerItem,
  getViewerAssetContext,
  normalizeViewerAssetContext,
  listComicPageGroups,
  normalizeComicReaderOptions,
  normalizeViewerItem,
  normalizeViewerUrl,
  imageSourcesFromViewerTrigger,
  placeComicPageGroup,
  reconcileViewerSource,
  resolveComicPageGroup,
  selectInitialViewerItem,
  stepComicPageGroup,
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
      filename: '',
      projectName: null,
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

describe('viewer-sequence: source kind', () => {
  it('defaults every existing source to the image kind without changing its settings', () => {
    const entries = [entry(1, 1, 'a.png'), entry(1, 2, 'b.png')];
    expect(createViewerSource().kind).toBe(VIEWER_SOURCE_KIND_IMAGE);
    expect(createViewerSource({ kind: 'video', items: [rawItem(1, 1)] }).kind).toBe(VIEWER_SOURCE_KIND_IMAGE);
    const slideshow = createSlideshowSource({ entries });
    expect(slideshow).toMatchObject({ kind: VIEWER_SOURCE_KIND_IMAGE, wrap: true, slideshow: true, initialKey: null });
    expect(canPlayViewerSlideshow(slideshow)).toBe(true);
    expect(stepViewerSequence(slideshow, 'p:1|a:2', 'next')).toMatchObject({ key: 'p:1|a:1', wrapped: true });
    const single = createSingleImageSource({ entries, projectId: 1, assetId: 2 });
    expect(single).toMatchObject({ kind: VIEWER_SOURCE_KIND_IMAGE, mode: VIEWER_SOURCE_MODE_SINGLE });
    // Image initial selection still skips to the first available item.
    const images = sequence([rawItem(1, 1, { available: false }), rawItem(1, 2)]);
    expect(images.initialKey).toBeNull();
    expect(selectInitialViewerItem(images)).toEqual({ key: 'p:1|a:2', index: 1 });
    // Image items keep the existing tolerant normalization (no position required).
    expect(keys(images)).toEqual(['p:1|a:1', 'p:1|a:2']);
  });

  it('makes a comic a non-wrapping, non-playing sequence whatever the options say', () => {
    const pages = [comicPage(1), comicPage(2), comicPage(3)];
    const source = createViewerSource({ kind: VIEWER_SOURCE_KIND_COMIC, mode: 'single', items: pages, wrap: true, slideshow: true });
    expect(source).toMatchObject({ kind: VIEWER_SOURCE_KIND_COMIC, mode: VIEWER_SOURCE_MODE_SEQUENCE, wrap: false, slideshow: false });
    expect(keys(source)).toEqual(['p:7|a:70|n:1', 'p:7|a:70|n:2', 'p:7|a:70|n:3']);
    expect(canPlayViewerSlideshow(source)).toBe(false);
    expect(stepViewerSequence(source, 'p:7|a:70|n:3', 'next')).toMatchObject({ moved: false, boundary: 'end', wrapped: false });
  });

  it('opens a comic on page 1 even when it is unavailable', () => {
    const source = createViewerSource({ kind: VIEWER_SOURCE_KIND_COMIC, items: [comicPage(1, { available: false }), comicPage(2)] });
    expect(source.initialKey).toBe('p:7|a:70|n:1');
    expect(selectInitialViewerItem(source)).toEqual({ key: 'p:7|a:70|n:1', index: 0 });
    // A hand-built comic source without an initial key still never skips ahead.
    expect(selectInitialViewerItem({ ...source, initialKey: null })).toEqual({ key: 'p:7|a:70|n:1', index: 0 });
    // An explicit initial page is honored.
    const later = createViewerSource({ kind: VIEWER_SOURCE_KIND_COMIC, items: [comicPage(1), comicPage(2)], initialKey: 'p:7|a:70|n:2' });
    expect(later.initialKey).toBe('p:7|a:70|n:2');
    // An empty comic invents nothing.
    const empty = createViewerSource({ kind: VIEWER_SOURCE_KIND_COMIC, items: [] });
    expect(empty).toMatchObject({ kind: VIEWER_SOURCE_KIND_COMIC, initialKey: null, droppedCount: 0 });
    expect(empty.items).toEqual([]);
  });

  it('counts comic items without a page position as dropped instead of keeping them', () => {
    const source = createViewerSource({ kind: VIEWER_SOURCE_KIND_COMIC, items: [comicPage(1), rawItem(7, 70), comicPage(2)] });
    expect(keys(source)).toEqual(['p:7|a:70|n:1', 'p:7|a:70|n:2']);
    expect(source.droppedCount).toBe(1);
  });

  it('keeps the comic kind through reconciliation', () => {
    const source = createViewerSource({ kind: VIEWER_SOURCE_KIND_COMIC, key: 'comic:7:70', items: [comicPage(1), comicPage(2)] });
    const result = reconcileViewerSource(source, 'p:7|a:70|n:2', { key: 'comic:7:70', items: [comicPage(1), comicPage(2), rawItem(7, 70)] });
    expect(result).toMatchObject({ outcome: VIEWER_RECONCILE_KEPT, key: 'p:7|a:70|n:2' });
    expect(result.source).toMatchObject({ kind: VIEWER_SOURCE_KIND_COMIC, wrap: false, slideshow: false });
    expect(keys(result.source)).toEqual(['p:7|a:70|n:1', 'p:7|a:70|n:2']);
    const images = reconcileViewerSource(createSlideshowSource({ entries: [entry(1, 1, 'a.png')] }), 'p:1|a:1', [rawItem(1, 1)]);
    expect(images.source).toMatchObject({ kind: VIEWER_SOURCE_KIND_IMAGE, wrap: true, slideshow: true });
  });
});

// ─── C1c: reading direction and page grouping ────────────────────────────────

const SINGLE = { layout: VIEWER_LAYOUT_SINGLE };
const COVER = { layout: VIEWER_LAYOUT_SPREAD, alignment: VIEWER_SPREAD_COVER_ALONE };
const PAIR = { layout: VIEWER_LAYOUT_SPREAD, alignment: VIEWER_SPREAD_PAIR_FROM_FIRST };

function comicSource(count, extra = {}) {
  const pages = [];
  for (let position = 1; position <= count; position += 1) pages.push(comicPage(position, extra[position] || {}));
  return createViewerSource({ kind: VIEWER_SOURCE_KIND_COMIC, key: 'comic:7:70', items: pages });
}

const pageKey = (position) => `p:7|a:70|n:${position}`;
const spans = (groups) => groups.map(({ first, last }) => (first === last ? [first] : [first, last]));

describe('viewer-sequence: comic reader options', () => {
  it('defaults to Left-to-Right, Single Page, Cover Alone', () => {
    expect(VIEWER_COMIC_READER_DEFAULTS).toEqual({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
    expect(Object.isFrozen(VIEWER_COMIC_READER_DEFAULTS)).toBe(true);
  });

  it('applies a partial patch over a base and rejects any invalid value whole', () => {
    expect(normalizeComicReaderOptions({ direction: 'rtl' })).toEqual({ direction: 'rtl', layout: 'single', alignment: 'cover-alone' });
    const base = normalizeComicReaderOptions({ layout: 'spread', alignment: 'pair-from-first' });
    expect(normalizeComicReaderOptions({ direction: 'rtl' }, base)).toEqual({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
    expect(normalizeComicReaderOptions({}, base)).toEqual(base);
    expect(normalizeComicReaderOptions({ direction: 'rtl', unknown: 1 })).toEqual({ direction: 'rtl', layout: 'single', alignment: 'cover-alone' });
    for (const bad of [null, undefined, 'rtl', 7, [], { direction: 'RTL' }, { layout: 'double' },
      { alignment: 'cover' }, { direction: 'rtl', layout: 'nope' }, { direction: null }, { layout: 2 }]) {
      expect(normalizeComicReaderOptions(bad, base)).toBeNull();
    }
    expect(normalizeComicReaderOptions({ direction: 'rtl' }, { direction: 'sideways' })).toEqual({ direction: 'rtl', layout: 'single', alignment: 'cover-alone' });
    expect(Object.isFrozen(normalizeComicReaderOptions({}))).toBe(true);
  });
});

describe('viewer-sequence: comic page grouping', () => {
  const expected = {
    single: (n) => Array.from({ length: n }, (_, i) => [i + 1]),
    cover: [[], [[1]], [[1], [2]], [[1], [2, 3]], [[1], [2, 3], [4]], [[1], [2, 3], [4, 5]],
      [[1], [2, 3], [4, 5], [6]], [[1], [2, 3], [4, 5], [6, 7]], [[1], [2, 3], [4, 5], [6, 7], [8]]],
    pair: [[], [[1]], [[1, 2]], [[1, 2], [3]], [[1, 2], [3, 4]], [[1, 2], [3, 4], [5]],
      [[1, 2], [3, 4], [5, 6]], [[1, 2], [3, 4], [5, 6], [7]], [[1, 2], [3, 4], [5, 6], [7, 8]]],
  };

  for (let count = 0; count <= 8; count += 1) {
    it(`partitions ${count} page(s) exactly once in every layout, alignment and direction`, () => {
      expect(spans(listComicPageGroups(count, SINGLE))).toEqual(expected.single(count));
      expect(spans(listComicPageGroups(count, COVER))).toEqual(expected.cover[count]);
      expect(spans(listComicPageGroups(count, PAIR))).toEqual(expected.pair[count]);
      for (const layout of [SINGLE, COVER, PAIR]) {
        for (const direction of [VIEWER_READING_LTR, VIEWER_READING_RTL]) {
          const options = { ...layout, direction };
          const groups = listComicPageGroups(count, options);
          const covered = groups.flatMap(({ first, last }) => {
            expect(last - first).toBeGreaterThanOrEqual(0);
            expect(last - first).toBeLessThanOrEqual(layout === SINGLE ? 0 : 1);
            return Array.from({ length: last - first + 1 }, (_, i) => first + i);
          });
          // No position missing, duplicated, invented or renumbered.
          expect(covered).toEqual(Array.from({ length: count }, (_, i) => i + 1));
          // Every position resolves to the group that lists it.
          for (const group of groups) {
            for (let position = group.first; position <= group.last; position += 1) {
              expect(comicPageGroupBounds(position, count, options)).toEqual(group);
            }
          }
          // Direction never changes membership.
          expect(groups).toEqual(listComicPageGroups(count, { ...layout, direction: VIEWER_READING_LTR }));
        }
      }
    });
  }

  it('handles a one-page comic and an unpaired last page without inventing a blank page', () => {
    expect(comicPageGroupBounds(1, 1, COVER)).toEqual({ first: 1, last: 1 });
    expect(comicPageGroupBounds(1, 1, PAIR)).toEqual({ first: 1, last: 1 });
    expect(comicPageGroupBounds(6, 6, COVER)).toEqual({ first: 6, last: 6 });
    expect(comicPageGroupBounds(7, 7, PAIR)).toEqual({ first: 7, last: 7 });
  });

  it('resolves an anchor on either member of a group to the same group', () => {
    expect(comicPageGroupBounds(4, 7, COVER)).toEqual({ first: 4, last: 5 });
    expect(comicPageGroupBounds(5, 7, COVER)).toEqual({ first: 4, last: 5 });
    expect(comicPageGroupBounds(5, 7, PAIR)).toEqual({ first: 5, last: 6 });
    expect(comicPageGroupBounds(6, 7, PAIR)).toEqual({ first: 5, last: 6 });
    expect(comicPageGroupBounds(5, 7, SINGLE)).toEqual({ first: 5, last: 5 });
  });

  it('returns null for malformed or out-of-range positions and counts', () => {
    for (const [position, count] of [[0, 5], [6, 5], [-1, 5], [1.5, 5], ['1', 5], [null, 5], [1, -1], [1, 1.5], [1, '5'], [1, 0], [NaN, 5]]) {
      expect(comicPageGroupBounds(position, count, COVER)).toBeNull();
    }
    expect(listComicPageGroups(-1, COVER)).toEqual([]);
    expect(listComicPageGroups('3', COVER)).toEqual([]);
    // Invalid options fall back to the defaults (Single Page).
    expect(comicPageGroupBounds(3, 5, { layout: 'triple' })).toEqual({ first: 3, last: 3 });
    expect(spans(listComicPageGroups(3, null))).toEqual([[1], [2], [3]]);
  });

  it('places the earlier page left under LTR and right under RTL without mutating input', () => {
    const members = Object.freeze(['a', 'b']);
    expect(placeComicPageGroup(members, VIEWER_READING_LTR)).toEqual(['a', 'b']);
    expect(placeComicPageGroup(members, VIEWER_READING_RTL)).toEqual(['b', 'a']);
    expect(placeComicPageGroup(['a'], VIEWER_READING_RTL)).toEqual(['a']);
    expect(placeComicPageGroup(null, VIEWER_READING_RTL)).toEqual([]);
    expect(members).toEqual(['a', 'b']);
  });

  it('labels groups in canonical ascending page numbers', () => {
    expect(formatComicPageGroupLabel({ first: 1, last: 1 }, 7)).toBe('Page 1 of 7');
    expect(formatComicPageGroupLabel({ first: 2, last: 3 }, 7)).toBe('Pages 2–3 of 7');
    expect(formatComicPageGroupLabel(null, 7)).toBe('');
    expect(formatComicPageGroupLabel({ first: 1, last: 1 }, 0)).toBe('');
  });
});

describe('viewer-sequence: comic group resolution and stepping', () => {
  it('resolves the anchor group with canonical keys, visual placement and neighbours', () => {
    const source = comicSource(7);
    const ltr = resolveComicPageGroup(source, pageKey(5), { ...COVER, direction: 'ltr' });
    expect(ltr).toMatchObject({
      anchorKey: pageKey(5), anchorPosition: 5, first: 4, last: 5, groupIndex: 2, groupCount: 4, pageCount: 7,
      previousKey: pageKey(2), nextKey: pageKey(6), label: 'Pages 4–5 of 7',
    });
    expect(ltr.positions).toEqual([4, 5]);
    expect(ltr.keys).toEqual([pageKey(4), pageKey(5)]);
    expect(ltr.visibleItems.map((item) => item.position)).toEqual([4, 5]);
    const rtl = resolveComicPageGroup(source, pageKey(5), { ...COVER, direction: 'rtl' });
    // RTL swaps placement only: membership, keys, label and neighbours stay.
    expect(rtl.visibleItems.map((item) => item.position)).toEqual([5, 4]);
    expect({ ...rtl, visibleItems: null, options: null }).toEqual({ ...ltr, visibleItems: null, options: null });
    // The source itself is never reordered.
    expect(source.items.map((item) => item.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rtl.items[0]).toBe(source.items[3]);
  });

  it('keeps unavailable pages in their groups', () => {
    const one = comicSource(5, { 3: { available: false } });
    const group = resolveComicPageGroup(one, pageKey(2), COVER);
    expect(group.items.map((item) => [item.position, item.available])).toEqual([[2, true], [3, false]]);
    const both = comicSource(5, { 2: { available: false }, 3: { mediaUrl: null } });
    const pair = resolveComicPageGroup(both, pageKey(3), COVER);
    expect(pair.keys).toEqual([pageKey(2), pageKey(3)]);
    expect(pair.items.every((item) => !item.available)).toBe(true);
    // Stepping never skips them.
    expect(stepComicPageGroup(both, pageKey(1), 'next', COVER)).toMatchObject({ key: pageKey(2), moved: true });
    expect(stepComicPageGroup(both, pageKey(1), 'next', SINGLE)).toMatchObject({ key: pageKey(2), moved: true });
  });

  it('steps whole groups onto the first page of the destination group', () => {
    const source = comicSource(7);
    const walk = (options, start, direction) => {
      const visited = [];
      let key = start;
      for (let guard = 0; guard < 20; guard += 1) {
        const result = stepComicPageGroup(source, key, direction, options);
        if (!result.moved) {
          visited.push(result.boundary);
          return visited;
        }
        key = result.key;
        visited.push(findViewerItemIndex(source, key) + 1);
      }
      return visited;
    };
    expect(walk(COVER, pageKey(1), 'next')).toEqual([2, 4, 6, 'end']);
    expect(walk(PAIR, pageKey(1), 'next')).toEqual([3, 5, 7, 'end']);
    expect(walk(SINGLE, pageKey(1), 'next')).toEqual([2, 3, 4, 5, 6, 7, 'end']);
    // From the second member, Next leaves the group rather than stepping within it.
    expect(stepComicPageGroup(source, pageKey(5), 'next', COVER)).toMatchObject({ key: pageKey(6), index: 5, moved: true, wrapped: false });
    expect(stepComicPageGroup(source, pageKey(4), 'next', COVER)).toMatchObject({ key: pageKey(6) });
    expect(stepComicPageGroup(source, pageKey(5), 'previous', COVER)).toMatchObject({ key: pageKey(2) });
    expect(stepComicPageGroup(source, pageKey(3), 'previous', COVER)).toMatchObject({ key: pageKey(1) });
    expect(stepComicPageGroup(source, pageKey(6), 'previous', PAIR)).toMatchObject({ key: pageKey(3) });
    expect(walk(COVER, pageKey(7), 'previous')).toEqual([4, 2, 1, 'start']);
    expect(walk(PAIR, pageKey(7), 'previous')).toEqual([5, 3, 1, 'start']);
  });

  it('clamps at both ends without wrapping, and stays put in a one-group comic', () => {
    const source = comicSource(7);
    expect(stepComicPageGroup(source, pageKey(1), 'previous', COVER)).toMatchObject({ key: pageKey(1), moved: false, boundary: 'start' });
    expect(stepComicPageGroup(source, pageKey(7), 'next', COVER)).toMatchObject({ key: pageKey(7), moved: false, boundary: 'end' });
    // Anchor on the first member of the last group: still the end.
    expect(stepComicPageGroup(source, pageKey(6), 'next', COVER)).toMatchObject({ key: pageKey(6), moved: false, boundary: 'end' });
    const two = comicSource(2);
    expect(stepComicPageGroup(two, pageKey(2), 'previous', PAIR)).toMatchObject({ key: pageKey(2), moved: false, boundary: 'start' });
    const single = comicSource(1);
    for (const options of [SINGLE, COVER, PAIR]) {
      expect(stepComicPageGroup(single, pageKey(1), 'next', options)).toMatchObject({ moved: false, boundary: 'end' });
    }
  });

  it('matches stepViewerSequence one page at a time in Single Page layout', () => {
    const source = comicSource(5, { 2: { available: false } });
    for (let position = 1; position <= 5; position += 1) {
      for (const direction of ['next', 'previous']) {
        expect(stepComicPageGroup(source, pageKey(position), direction, SINGLE))
          .toEqual(stepViewerSequence(source, pageKey(position), direction));
      }
    }
  });

  it('handles empty comics, unknown anchors and non-comic sources safely', () => {
    const empty = comicSource(0);
    expect(resolveComicPageGroup(empty, null, COVER)).toBeNull();
    expect(stepComicPageGroup(empty, null, 'next', COVER)).toMatchObject({ key: null, index: -1, moved: false, reason: 'empty' });
    const source = comicSource(3);
    expect(resolveComicPageGroup(source, 'p:7|a:70|n:9', COVER)).toBeNull();
    expect(resolveComicPageGroup(source, null, COVER)).toBeNull();
    expect(stepComicPageGroup(source, 'missing', 'next', COVER)).toMatchObject({ key: pageKey(1), moved: false, reason: 'unknown-current' });
    const images = createSlideshowSource({ entries: [entry(1, 1, 'a.png'), entry(1, 2, 'b.png')] });
    expect(resolveComicPageGroup(images, 'p:1|a:1', COVER)).toBeNull();
    expect(stepComicPageGroup(images, 'p:1|a:1', 'next', COVER)).toBeNull();
    // A comic whose positions are not canonical 1..n is not grouped.
    const gapped = createViewerSource({ kind: VIEWER_SOURCE_KIND_COMIC, items: [comicPage(1), comicPage(3)] });
    expect(resolveComicPageGroup(gapped, pageKey(1), COVER)).toBeNull();
    expect(stepComicPageGroup(gapped, pageKey(1), 'next', COVER)).toBeNull();
    expect(resolveComicPageGroup(null, pageKey(1), COVER)).toBeNull();
  });

  it('never changes comic identities, order or the source object', () => {
    const source = comicSource(6);
    const before = JSON.stringify(source);
    for (const direction of ['ltr', 'rtl']) {
      for (const layout of [SINGLE, COVER, PAIR]) {
        for (let position = 1; position <= 6; position += 1) {
          const group = resolveComicPageGroup(source, pageKey(position), { ...layout, direction });
          expect(group.items.every((item) => source.items.includes(item))).toBe(true);
          stepComicPageGroup(source, pageKey(position), 'next', { ...layout, direction });
        }
      }
    }
    expect(JSON.stringify(source)).toBe(before);
    expect(Object.isFrozen(resolveComicPageGroup(source, pageKey(2), COVER))).toBe(true);
  });
});

describe('viewer asset metadata', () => {
  it('preserves exact filenames separately from formatted titles and URLs', () => {
    const filename = '  Episode  01 \u2014 \u732b.Original.CBZ  ';
    const item = normalizeViewerItem(rawItem(7, 40, { filename, title: 'Short title', projectName: 'Moon  Saga' }));
    expect(item).toMatchObject({ filename, title: 'Short title', projectName: 'Moon  Saga' });
    expect(normalizeViewerItem(item)).toEqual(item);
    expect(normalizeViewerItem(rawItem(7, 40)).filename).toBe('');
  });

  it('keeps optional project names independent of source labels', () => {
    const source = createSlideshowSource({ label: 'Asset Viewer', entries: [entry(1, 5, 'a.png')] });
    expect(getViewerAssetContext(source, source.items[0].key)).toEqual({
      projectId: '1', assetId: '5', filename: 'a.png', projectName: null, detailsUrl: '/projects/1/assets/5',
    });
    expect(getViewerAssetContext(source, null)).toBeNull();
  });

  it.each([
    {}, { assetId: 0, projectId: 1 }, { assetId: 2, projectId: 0 },
    { assetId: 2 }, { assetId: 2, projectId: 'other' },
    { assetId: '01', projectId: 1 }, { assetId: 2, projectId: '9007199254740992' },
    { assetId: 2, projectId: '1/../../elsewhere' },
  ])('never invents navigation for absent or invalid route identity: %j', (identity) => {
    expect(normalizeViewerAssetContext(identity)?.detailsUrl ?? null).toBeNull();
  });

  it('uses canonical numeric routing or preserves a supplied safe authoritative URL', () => {
    expect(normalizeViewerAssetContext({ projectId: 7, assetId: 40 }).detailsUrl).toBe('/projects/7/assets/40');
    const source = createViewerSource({ items: [rawItem(7, 40, { detailsUrl: null })] });
    expect(source.items[0].detailsUrl).toBeNull();
    expect(getViewerAssetContext(source, source.items[0].key).detailsUrl).toBe('/projects/7/assets/40');
    expect(normalizeViewerAssetContext({ assetId: 'opaque', detailsUrl: '/details?return=all' }).detailsUrl).toBe('/details?return=all');
    expect(normalizeViewerAssetContext({ assetId: 'opaque', detailsUrl: 'javascript:alert(1)' }).detailsUrl).toBeNull();
  });

  it('changes cross-project context per item without leaking names or destinations', () => {
    const source = createSlideshowSource({ key: 'global', label: 'Asset Viewer', entries: [
      { ...entry(7, 40, 'first.png'), projectName: 'First project' }, entry(8, 40, 'second.webp'),
    ] });
    expect(source.items.map((item) => item.key)).toEqual(['p:7|a:40', 'p:8|a:40']);
    const next = stepViewerSequence(source, source.items[0].key, 'next');
    expect(getViewerAssetContext(source, next.key)).toEqual({
      projectId: '8', assetId: '40', filename: 'second.webp', projectName: null, detailsUrl: '/projects/8/assets/40',
    });
  });

  it('accepts replacement metadata without reloading media or changing explicit slideshow settings', () => {
    const source = createSlideshowSource({ key: 'global', entries: [{ ...entry(7, 40, 'old.png'), projectName: 'Old' }] });
    const updated = reconcileViewerSource(source, source.items[0].key, [
      { ...source.items[0], filename: 'new.png', projectName: null, detailsUrl: '/projects/7/assets/40?pageSize=all' },
    ]);
    expect(updated).toMatchObject({ reload: false, preserveView: true, source: { key: 'global', slideshow: true, mode: 'sequence' } });
    expect(getViewerAssetContext(updated.source, updated.key)).toMatchObject({ filename: 'new.png', projectName: null, detailsUrl: '/projects/7/assets/40?pageSize=all' });
  });

  it('keeps comic archive context separate from page names, including empty sources', () => {
    const context = { projectId: 7, assetId: 70, filename: 'archive.cbz', projectName: 'Project' };
    for (const items of [[], [comicPage(1)]]) {
      const source = createViewerSource({ kind: 'comic', context, items });
      expect(getViewerAssetContext(source, source.items[0]?.key)).toEqual({
        ...context, projectId: '7', assetId: '70', detailsUrl: '/projects/7/assets/70',
      });
      expect(Object.isFrozen(source.context)).toBe(true);
    }
  });
});


describe('authoritative image rendition propagation', () => {
  const policy = (format = 'webp') => projectImagePresentationPolicy({
    thumbnail: { format: 'webp', webpQuality: 80, maxDimension: 256 },
    preview: { format, webpQuality: 90, maxDimension: 1600 },
  });
  function qualityEntry(projectId = 7, id = 17, format = 'webp', overrides = {}) {
    const asset = { id, project_id: projectId, filename: 'cover.png', relative_path: 'cover.png',
      extension: 'png', mime_type: 'image/png', is_present: 1, size_bytes: 100,
      modified_at: '2026-08-01 10:00:00', source_generation: 0, ...overrides };
    const preview = buildAssetPreviewModel(asset, policy(format));
    return { ...entry(projectId, id, asset.filename, preview.revision), previewUrl: preview.urls.preview,
      imageSources: preview.imageSources };
  }
  it.each(['webp', 'original'])('keeps explicit sources separate from legacy display under Preview=%s', (format) => {
    const raw = qualityEntry(7, 17, format);
    const source = createSingleImageSource({ entries: [raw], projectId: 7, assetId: 17 });
    const item = source.items[0];
    expect(item.mediaUrl).toBe(raw.previewUrl);
    expect(item.originalUrl).toBe(raw.originalUrl);
    expect(item.revision).toBe(raw.revision);
    expect(item.filename).toBe(raw.filename);
    expect(item.detailsUrl).toBe(raw.viewerUrl);
    expect(item.imageSources).toEqual({ ...raw.imageSources, projectId: '7', assetId: '17' });
    expect(item.imageSources.optimized.url).toContain('rendition=optimized');
    expect(item.imageSources.sourceRevision).not.toBe(item.imageSources.optimized.revision);
    expect(Object.isFrozen(item.imageSources)).toBe(true);
    expect(Object.isFrozen(item.imageSources.optimized)).toBe(true);
    expect(Object.isFrozen(item.imageSources.original)).toBe(true);
  });
  it('keeps per-item sources and mode through navigation and authoritative refresh without reloading media', () => {
    const entries = [qualityEntry(), qualityEntry(8, 17, 'original')];
    const source = createSlideshowSource({ key: 'library', entries });
    const next = stepViewerSequence(source, source.items[0].key, 'next');
    expect(getViewerItem(source, next.key).imageSources.projectId).toBe('8');
    expect(getViewerItem(source, next.key).imageSources.original.url).toBe(entries[1].imageSources.original.url);
    expect(source.items[0].imageSources.sourceRevision).not.toBe(source.items[1].imageSources.sourceRevision);
    const replacement = structuredClone(entries[1]);
    replacement.imageSources = qualityEntry(8, 17, 'original', { source_generation: 1 }).imageSources;
    const update = reconcileViewerSource(source, next.key, { key: 'library', items: [entries[0], replacement].map(viewerItemFromSlideshowEntry) });
    expect(update.item.imageSources).toEqual({ ...replacement.imageSources, projectId: '8', assetId: '17' });
    expect(update.item.imageSources.sourceRevision).toBe(replacement.imageSources.sourceRevision);
    expect(update.reload).toBe(false);
    expect(update.preserveView).toBe(true);
    expect(update.source.slideshow).toBe(true);
    const one = createSlideshowSource({ entries: [entries[1]] });
    expect(one.slideshow).toBe(true);
    expect(one.items[0].imageSources.projectId).toBe('8');
  });
  it('clears withdrawn or absent authoritative qualities without reviving legacy URLs', () => {
    const raw = qualityEntry();
    raw.imageSources.original = { eligible: false, url: raw.imageSources.original.url };
    raw.imageSources.optimized = { eligible: false, url: null, revision: null };
    const item = normalizeViewerItem(viewerItemFromSlideshowEntry(raw));
    expect(item.imageSources.original).toEqual({ eligible: false, url: null });
    expect(item.imageSources.optimized).toEqual({ eligible: false, url: null, revision: null });
    expect(item.imageSources.toggleEligible).toBe(false);
    expect(item.originalUrl).toBe(raw.originalUrl);
    const prior = createSlideshowSource({ entries: [qualityEntry()] });
    const { imageSources, ...legacy } = raw;
    const update = reconcileViewerSource(prior, prior.items[0].key, [viewerItemFromSlideshowEntry(legacy)]);
    expect(update.item.imageSources).toBeUndefined();
    expect(update.reload).toBe(false);
  });
  it.each([
    ['foreign owner', (s) => { s.projectId = 8; }],
    ['foreign URL', (s) => { s.original.url = s.original.url.replace('/7/', '/8/'); }],
    ['raw path', (s) => { s.original.url = 'G:\\private.png'; }],
    ['external URL', (s) => { s.original.url = 'file:///private.png'; }],
    ['swapped revisions', (s) => { [s.sourceRevision, s.optimized.revision] = [s.optimized.revision, s.sourceRevision]; }],
    ['missing revision', (s) => { s.sourceRevision = null; }],
    ['malformed revision', (s) => { s.sourceRevision = {}; }],
    ['missing URL', (s) => { s.original.url = null; }],
    ['false eligibility', (s) => { s.original.eligible = false; }],
    ['nonboolean eligibility', (s) => { s.original.eligible = 'true'; }],
    ['repeated precondition', (s) => { s.original.url += '&sourceRevision=' + s.sourceRevision; }],
  ])('rejects unsafe optional source metadata: %s', (_, mutate) => {
    const raw = qualityEntry();
    mutate(raw.imageSources);
    const sources = normalizeViewerItem(viewerItemFromSlideshowEntry(raw)).imageSources;
    expect(sources?.original.eligible ?? false).toBe(false);
    expect(sources?.original.url ?? null).toBeNull();
    expect(sources?.toggleEligible ?? false).toBe(false);
  });
  it.each(['kra', 'cbz', 'cbr', 'cb7', 'zip', '7z', 'mp4', 'webm'])('preserves server exclusions for %s', (extension) => {
    const raw = qualityEntry(7, 17, 'original', { extension, mime_type: extension === 'kra' ? 'application/x-krita' : 'application/octet-stream' });
    const sources = normalizeViewerItem({ ...viewerItemFromSlideshowEntry(raw), mediaUrl: '/legacy-preview' }).imageSources;
    expect(sources?.original.eligible ?? false).toBe(false);
    expect(sources?.toggleEligible ?? false).toBe(false);
  });
  it('withdraws optional quality metadata on unavailable items and comic pages', () => {
    const raw = viewerItemFromSlideshowEntry(qualityEntry());
    expect(normalizeViewerItem({ ...raw, available: false }).imageSources).toBeNull();
    expect(normalizeViewerItem({ ...raw, position: 1 }).imageSources).toBeNull();
  });
});


describe('optional image-source attribute parsing', () => {
  it.each([null, '', 'not JSON', '{', 'null'])('fails safely for %j', (value) => {
    expect(imageSourcesFromViewerTrigger({ getAttribute: () => value })).toBeNull();
  });
  it('does not invent metadata when no attribute host exists', () => {
    expect(imageSourcesFromViewerTrigger(null)).toBeNull();
  });
});
