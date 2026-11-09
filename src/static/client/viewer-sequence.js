// ─── Unified viewer: content source and sequence contract ────────────────────
//
// Pure data model for the unified image/comic viewer. It normalizes
// server-provided content into a source of identity-addressed items and
// answers navigation and live-refresh questions about it. It never touches
// the DOM, fetches, renders, schedules timers or stores anything: the viewer
// controller acts on what these functions return.
//
// Contract summary
// - An item is identified by project + asset (+ optional one-based position
//   for comic pages), never by array index or filename. `key` is derived from
//   those fields only.
// - A source keeps the server's order exactly: it is never sorted, filtered by
//   type or extended on the client. Malformed entries and duplicate identities
//   are dropped (first occurrence wins) and counted in `droppedCount`.
// - A `single` source holds only the opened item, however many images the page
//   lists. A `sequence` source holds the complete ordered collection.
// - `wrap` and `slideshow` are explicit source settings; nothing assumes a
//   slideshow. A comic reader is a non-wrapping, non-slideshow sequence.
// - Revisions are opaque strings and URLs are server-provided root-relative
//   paths; both are compared by equality only and never constructed here.
// - Every returned source/item is frozen, and no function throws on malformed
//   input.

export const VIEWER_SOURCE_MODE_SINGLE = 'single';
export const VIEWER_SOURCE_MODE_SEQUENCE = 'sequence';

export const VIEWER_UNAVAILABLE_MISSING_MEDIA = 'missing-media';
export const VIEWER_UNAVAILABLE_DEFAULT = 'unavailable';

export const VIEWER_RECONCILE_KEPT = 'kept';
export const VIEWER_RECONCILE_REPLACED = 'replaced';
export const VIEWER_RECONCILE_CLOSED = 'closed';
export const VIEWER_RECONCILE_IDLE = 'idle';

// C0 controls, DEL and C1 controls never belong in labels, identities or URLs.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TOKEN_LENGTH = 512;

/**
 * @typedef {object} ViewerItem
 * @property {string} key            Stable identity derived from projectId/assetId/position.
 * @property {string|null} projectId Project identity where known.
 * @property {string} assetId        Asset identity.
 * @property {number|null} position  One-based page position for multi-part assets (comics).
 * @property {string} title          Plain-text display title.
 * @property {string} alt            Plain-text alternative text.
 * @property {string|null} mediaUrl  Server-provided display media URL.
 * @property {string|null} originalUrl Server-provided original media URL.
 * @property {string|null} detailsUrl  Server-provided Asset Details URL.
 * @property {string|null} revision  Opaque revision token.
 * @property {boolean} available     Whether the item has displayable media.
 * @property {string|null} unavailableReason Short code when unavailable.
 */

/**
 * @typedef {object} ViewerSource
 * @property {string|null} key
 * @property {string} label
 * @property {'single'|'sequence'} mode
 * @property {ReadonlyArray<ViewerItem>} items
 * @property {string|null} initialKey
 * @property {boolean} wrap
 * @property {boolean} slideshow
 * @property {number} droppedCount
 */

// ─── Scalar normalization ────────────────────────────────────────────────────

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

// Identity: a positive safe integer or a non-empty string without controls.
// Returns undefined for "absent" and null for "present but malformed".
function normalizeIdentity(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH || HAS_CONTROL_CHARACTER.test(trimmed)) return null;
    return trimmed;
  }
  return null;
}

function normalizePosition(value) {
  if (value === undefined || value === null) return undefined;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Accept only same-origin, root-relative URLs as produced by the server
 * presenters (`/projects/…`). Anything else — schemes, protocol-relative or
 * backslash forms, whitespace or control characters — is treated as absent.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeViewerUrl(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\s\\]/.test(value) || HAS_CONTROL_CHARACTER.test(value)) return null;
  return value;
}

function normalizeRevision(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  if (!value || value.length > MAX_TOKEN_LENGTH || HAS_CONTROL_CHARACTER.test(value)) return null;
  return value;
}

/**
 * Derive the stable item key. Each part is URI-encoded so separators can
 * never be forged by identity contents.
 *
 * @param {{ projectId?: unknown, assetId?: unknown, position?: unknown }} identity
 * @returns {string|null}
 */
export function buildViewerItemKey(identity) {
  const assetId = normalizeIdentity(identity?.assetId);
  const projectId = normalizeIdentity(identity?.projectId);
  const position = normalizePosition(identity?.position);
  if (!assetId || projectId === null || position === null) return null;
  const parts = [];
  if (projectId !== undefined) parts.push(`p:${encodeURIComponent(projectId)}`);
  parts.push(`a:${encodeURIComponent(assetId)}`);
  if (position !== undefined) parts.push(`n:${position}`);
  return parts.join('|');
}

// ─── Items ───────────────────────────────────────────────────────────────────

/**
 * Normalize one raw item. Returns null when its identity is missing or
 * malformed; every other field degrades to a safe default.
 *
 * Raw fields: assetId (required), projectId, position, title, alt, mediaUrl,
 * originalUrl, detailsUrl, revision, available (false marks it unavailable),
 * unavailableReason.
 *
 * @param {object} raw
 * @returns {ViewerItem|null}
 */
export function normalizeViewerItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const key = buildViewerItemKey(raw);
  if (!key) return null;

  const assetId = normalizeIdentity(raw.assetId);
  const projectId = normalizeIdentity(raw.projectId) ?? null;
  const position = normalizePosition(raw.position) ?? null;
  const mediaUrl = normalizeViewerUrl(raw.mediaUrl);
  const fallbackTitle = position !== null ? `Page ${position}` : `Asset ${assetId}`;
  const title = normalizeText(raw.title) || fallbackTitle;
  const alt = normalizeText(raw.alt) || title;

  let available = raw.available !== false && mediaUrl !== null;
  let unavailableReason = null;
  if (!available) {
    const requested = typeof raw.unavailableReason === 'string' && REASON_PATTERN.test(raw.unavailableReason)
      ? raw.unavailableReason
      : null;
    unavailableReason = requested
      ?? (mediaUrl === null ? VIEWER_UNAVAILABLE_MISSING_MEDIA : VIEWER_UNAVAILABLE_DEFAULT);
    available = false;
  }

  return Object.freeze({
    key,
    projectId,
    assetId,
    position,
    title,
    alt,
    mediaUrl,
    originalUrl: available ? normalizeViewerUrl(raw.originalUrl) : null,
    detailsUrl: normalizeViewerUrl(raw.detailsUrl),
    revision: normalizeRevision(raw.revision),
    available,
    unavailableReason,
  });
}

function normalizeItemList(rawItems) {
  const list = Array.isArray(rawItems) ? rawItems : [];
  const items = [];
  const seen = new Set();
  let droppedCount = 0;
  for (const raw of list) {
    // Already-normalized items pass through by re-normalizing their fields.
    const item = normalizeViewerItem(raw);
    if (!item || seen.has(item.key)) {
      droppedCount += 1;
      continue;
    }
    seen.add(item.key);
    items.push(item);
  }
  return { items, droppedCount };
}

/**
 * Find the item matching an identity. When the identity names no project, a
 * match is accepted only if exactly one item carries that asset (and
 * position), so equal local ids from different projects never cross over.
 *
 * @param {ReadonlyArray<ViewerItem>} items
 * @param {{ projectId?: unknown, assetId?: unknown, position?: unknown }} identity
 * @returns {ViewerItem|null}
 */
export function findViewerItemByIdentity(items, identity) {
  if (!Array.isArray(items)) return null;
  const assetId = normalizeIdentity(identity?.assetId);
  const projectId = normalizeIdentity(identity?.projectId);
  const position = normalizePosition(identity?.position);
  if (!assetId || projectId === null || position === null) return null;
  const wantedPosition = position ?? null;
  const matches = items.filter((item) => item?.assetId === assetId
    && item.position === wantedPosition
    && (projectId === undefined || item.projectId === projectId));
  return matches.length === 1 ? matches[0] : null;
}

// ─── Sources ─────────────────────────────────────────────────────────────────

function sourceKey(value) {
  const key = normalizeIdentity(value);
  return key || null;
}

/**
 * Build a normalized source.
 *
 * - `mode: 'single'` keeps only the initial item (by `initialKey`, else the
 *   first valid item); it never wraps and never plays a slideshow.
 * - `mode: 'sequence'` (the default for anything else) keeps every valid item
 *   in the given order. `wrap` and `slideshow` default to false.
 *
 * @param {object} [options]
 * @param {string} [options.key]
 * @param {string} [options.label]
 * @param {'single'|'sequence'} [options.mode]
 * @param {Array<object>} [options.items]
 * @param {string} [options.initialKey]
 * @param {boolean} [options.wrap]
 * @param {boolean} [options.slideshow]
 * @returns {ViewerSource}
 */
export function createViewerSource(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const mode = opts.mode === VIEWER_SOURCE_MODE_SINGLE ? VIEWER_SOURCE_MODE_SINGLE : VIEWER_SOURCE_MODE_SEQUENCE;
  const normalized = normalizeItemList(opts.items);
  let { items } = normalized;
  let { droppedCount } = normalized;
  const requestedInitial = typeof opts.initialKey === 'string' ? opts.initialKey : null;

  if (mode === VIEWER_SOURCE_MODE_SINGLE && items.length > 0) {
    const chosen = (requestedInitial && items.find((item) => item.key === requestedInitial)) || items[0];
    droppedCount += items.length - 1;
    items = [chosen];
  }

  const initialKey = requestedInitial && items.some((item) => item.key === requestedInitial)
    ? requestedInitial
    : null;
  const isSequence = mode === VIEWER_SOURCE_MODE_SEQUENCE;

  return Object.freeze({
    key: sourceKey(opts.key),
    label: normalizeText(opts.label),
    mode,
    items: Object.freeze(items),
    initialKey,
    wrap: isSequence && opts.wrap === true,
    slideshow: isSequence && opts.slideshow === true,
    droppedCount,
  });
}

/**
 * Map one entry of the existing server slideshow JSON
 * (`{ id, projectId?, filename, previewUrl, viewerUrl, originalUrl?, revision? }`)
 * to a raw viewer item. Field names follow buildSlideshowSequence in
 * src/services/workflow-query-service.js.
 *
 * @param {object} entry
 * @returns {object|null}
 */
export function viewerItemFromSlideshowEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return {
    projectId: entry.projectId,
    assetId: entry.id,
    title: entry.filename,
    alt: entry.filename,
    mediaUrl: entry.previewUrl,
    originalUrl: entry.originalUrl,
    detailsUrl: entry.viewerUrl,
    revision: entry.revision,
  };
}

function itemsFromSlideshowEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map(viewerItemFromSlideshowEntry);
}

/**
 * Explicit Slideshow action: the complete server-filtered image sequence in
 * server order, wrapping, with slideshow playback available.
 *
 * @param {{ key?: string, label?: string, entries?: Array<object>, initialKey?: string }} [options]
 * @returns {ViewerSource}
 */
export function createSlideshowSource({ key, label, entries, initialKey } = {}) {
  return createViewerSource({
    key,
    label,
    mode: VIEWER_SOURCE_MODE_SEQUENCE,
    items: itemsFromSlideshowEntries(entries),
    initialKey,
    wrap: true,
    slideshow: true,
  });
}

/**
 * Thumbnail opening: only the selected image, never the surrounding gallery.
 * Returns an empty single source when the identity is absent, ambiguous or
 * has no displayable media (the viewer should then not open).
 *
 * @param {{ key?: string, label?: string, entries?: Array<object>,
 *   projectId?: unknown, assetId?: unknown }} [options]
 * @returns {ViewerSource}
 */
export function createSingleImageSource({ key, label, entries, projectId, assetId } = {}) {
  const { items } = normalizeItemList(itemsFromSlideshowEntries(entries));
  const selected = findViewerItemByIdentity(items, { projectId, assetId });
  return createViewerSource({
    key,
    label,
    mode: VIEWER_SOURCE_MODE_SINGLE,
    items: selected?.available ? [selected] : [],
    initialKey: selected?.available ? selected.key : undefined,
  });
}

// ─── Lookup and navigation ───────────────────────────────────────────────────

function sourceItems(source) {
  return Array.isArray(source?.items) ? source.items : [];
}

/**
 * @param {ViewerSource} source
 * @param {string|null} key
 * @returns {number} index, or -1
 */
export function findViewerItemIndex(source, key) {
  if (typeof key !== 'string') return -1;
  return sourceItems(source).findIndex((item) => item.key === key);
}

/**
 * @param {ViewerSource} source
 * @param {string|null} key
 * @returns {ViewerItem|null}
 */
export function getViewerItem(source, key) {
  const index = findViewerItemIndex(source, key);
  return index === -1 ? null : sourceItems(source)[index];
}

/**
 * The item a viewer opens on: the source's initial item when present (even
 * if unavailable, so the viewer can say so), else the first available item,
 * else the first item, else null.
 *
 * @param {ViewerSource} source
 * @returns {{ key: string|null, index: number }}
 */
export function selectInitialViewerItem(source) {
  const items = sourceItems(source);
  let index = findViewerItemIndex(source, source?.initialKey);
  if (index === -1) index = items.findIndex((item) => item.available);
  if (index === -1 && items.length > 0) index = 0;
  return { key: index === -1 ? null : items[index].key, index };
}

/**
 * Whether slideshow playback may run: a slideshow source with at least two
 * available items.
 *
 * @param {ViewerSource} source
 * @returns {boolean}
 */
export function canPlayViewerSlideshow(source) {
  if (source?.slideshow !== true || source.mode !== VIEWER_SOURCE_MODE_SEQUENCE) return false;
  return sourceItems(source).filter((item) => item.available).length >= 2;
}

/**
 * Step from the current item. Unavailable items are visited by default (a
 * comic keeps missing pages in place); `skipUnavailable` passes over them.
 *
 * Result:
 * - `key`/`index`: the item to show (unchanged when the step cannot move).
 * - `moved`: whether a different item was chosen.
 * - `wrapped`: whether the step crossed a boundary on a wrapping source.
 * - `boundary`: 'start'|'end' when a non-wrapping step was clamped, else null.
 * - `reason`: 'empty' | 'unknown-current' | 'no-other-item' | null.
 *
 * An unknown current key yields the initial selection with `moved: false`.
 *
 * @param {ViewerSource} source
 * @param {string|null} currentKey
 * @param {1|-1|'next'|'previous'} direction
 * @param {{ skipUnavailable?: boolean }} [options]
 */
export function stepViewerSequence(source, currentKey, direction, options = {}) {
  const items = sourceItems(source);
  const delta = direction === 'previous' || direction === -1 ? -1 : 1;
  const skipUnavailable = options?.skipUnavailable === true;
  const result = (key, index, extra = {}) => ({
    key, index, moved: false, wrapped: false, boundary: null, reason: null, ...extra,
  });

  if (items.length === 0) return result(null, -1, { reason: 'empty' });
  const currentIndex = findViewerItemIndex(source, currentKey);
  if (currentIndex === -1) {
    const initial = selectInitialViewerItem(source);
    return result(initial.key, initial.index, { reason: 'unknown-current' });
  }

  const wrap = source.wrap === true;
  const count = items.length;
  const stay = (extra) => result(items[currentIndex].key, currentIndex, extra);
  const clamp = () => stay({ boundary: delta < 0 ? 'start' : 'end' });
  let wrapped = false;
  for (let steps = 1; steps < count; steps += 1) {
    let candidate = currentIndex + delta * steps;
    if (candidate < 0 || candidate >= count) {
      if (!wrap) return clamp();
      candidate = ((candidate % count) + count) % count;
      wrapped = true;
    }
    if (!skipUnavailable || items[candidate].available) {
      return result(items[candidate].key, candidate, { moved: true, wrapped });
    }
  }
  return wrap ? stay({ reason: 'no-other-item' }) : clamp();
}

// ─── Live-refresh reconciliation ─────────────────────────────────────────────

function replacementItems(replacement) {
  if (Array.isArray(replacement)) return { items: replacement, key: undefined, label: undefined };
  if (replacement && typeof replacement === 'object') {
    return { items: replacement.items, key: replacement.key, label: replacement.label };
  }
  return { items: [], key: undefined, label: undefined };
}

function neighborAfterRemoval(previousItems, previousIndex, nextSource) {
  const nextItems = nextSource.items;
  if (nextItems.length === 0) return -1;
  // Prefer the nearest surviving former successor, then predecessor.
  for (let i = previousIndex + 1; i < previousItems.length; i += 1) {
    const index = findViewerItemIndex(nextSource, previousItems[i].key);
    if (index !== -1) return index;
  }
  for (let i = previousIndex - 1; i >= 0; i -= 1) {
    const index = findViewerItemIndex(nextSource, previousItems[i].key);
    if (index !== -1) return index;
  }
  // No former neighbor survives: keep the same slot within the new order.
  return Math.min(Math.max(previousIndex, 0), nextItems.length - 1);
}

/**
 * Reconcile a source with authoritative replacement data after a live-region
 * refresh.
 *
 * `replacement` is the refreshed raw item list (or `{ key?, label?, items }`).
 * The previous source's mode, wrap and slideshow settings carry over; a
 * single source narrows the refreshed list back to its own item. A
 * replacement naming a different source key invalidates the source.
 *
 * Result:
 * - `source`: the next source (built only from the replacement data).
 * - `outcome`: 'kept' (current identity survived), 'replaced' (a neighbor
 *   takes over), 'closed' (nothing left to show / source invalidated), or
 *   'idle' (no current item was shown).
 * - `key`, `index`, `item`: the item to show next (null/-1 when closed).
 * - `revisionChanged`, `mediaChanged`, `originalChanged`,
 *   `availabilityChanged`: comparisons for a kept item.
 * - `reload`: the displayed media must be (re)loaded from `item`.
 * - `preserveView`: media/transform state may be kept as is.
 * - `reason`: 'source-changed' | 'empty' | 'removed' | null.
 *
 * @param {ViewerSource} previous
 * @param {string|null} currentKey
 * @param {Array<object>|{ key?: string, label?: string, items?: Array<object> }} replacement
 */
export function reconcileViewerSource(previous, currentKey, replacement) {
  const prior = previous && typeof previous === 'object' ? previous : createViewerSource();
  const incoming = replacementItems(replacement);
  const priorKey = sourceKey(prior.key);
  const incomingKey = sourceKey(incoming.key);
  const priorItems = sourceItems(prior);
  const previousIndex = findViewerItemIndex(prior, currentKey);
  const previousItem = previousIndex === -1 ? null : priorItems[previousIndex];

  const isSingle = prior.mode === VIEWER_SOURCE_MODE_SINGLE;
  const settings = {
    key: priorKey ?? incomingKey ?? undefined,
    label: incoming.label !== undefined ? incoming.label : prior.label,
    mode: isSingle ? VIEWER_SOURCE_MODE_SINGLE : VIEWER_SOURCE_MODE_SEQUENCE,
    wrap: prior.wrap === true,
    slideshow: prior.slideshow === true,
  };

  const closed = (source, reason) => ({
    source,
    outcome: previousItem ? VIEWER_RECONCILE_CLOSED : VIEWER_RECONCILE_IDLE,
    key: null,
    index: -1,
    item: null,
    revisionChanged: false,
    mediaChanged: false,
    originalChanged: false,
    availabilityChanged: false,
    reload: false,
    preserveView: false,
    reason,
  });

  if (priorKey && incomingKey && priorKey !== incomingKey) {
    return closed(createViewerSource({ ...settings, items: [] }), 'source-changed');
  }

  const full = normalizeItemList(incoming.items).items;
  let nextItems = full;
  if (isSingle) {
    const singleKey = priorItems[0]?.key ?? null;
    const survivor = singleKey ? full.find((item) => item.key === singleKey) : null;
    nextItems = survivor ? [survivor] : [];
  }

  if (!previousItem) {
    const source = createViewerSource({ ...settings, items: nextItems, initialKey: prior.initialKey ?? undefined });
    const initial = selectInitialViewerItem(source);
    return {
      ...closed(source, source.items.length === 0 ? 'empty' : null),
      key: initial.key,
      index: initial.index,
      item: initial.index === -1 ? null : source.items[initial.index],
    };
  }

  const keptIndex = nextItems.findIndex((item) => item.key === previousItem.key);
  if (keptIndex !== -1) {
    const source = createViewerSource({ ...settings, items: nextItems, initialKey: previousItem.key });
    const item = source.items[keptIndex];
    const revisionChanged = item.revision !== previousItem.revision;
    const mediaChanged = item.mediaUrl !== previousItem.mediaUrl;
    const originalChanged = item.originalUrl !== previousItem.originalUrl;
    const availabilityChanged = item.available !== previousItem.available;
    const reload = revisionChanged || mediaChanged || availabilityChanged;
    return {
      source,
      outcome: VIEWER_RECONCILE_KEPT,
      key: item.key,
      index: keptIndex,
      item,
      revisionChanged,
      mediaChanged,
      originalChanged,
      availabilityChanged,
      reload,
      preserveView: !reload && !originalChanged,
      reason: null,
    };
  }

  if (isSingle || nextItems.length === 0) {
    const source = createViewerSource({ ...settings, items: nextItems });
    return closed(source, full.length === 0 ? 'empty' : 'removed');
  }

  const provisional = createViewerSource({ ...settings, items: nextItems });
  const index = neighborAfterRemoval(priorItems, previousIndex, provisional);
  const item = provisional.items[index];
  return {
    source: createViewerSource({ ...settings, items: nextItems, initialKey: item.key }),
    outcome: VIEWER_RECONCILE_REPLACED,
    key: item.key,
    index,
    item,
    revisionChanged: true,
    mediaChanged: true,
    originalChanged: true,
    availabilityChanged: item.available !== previousItem.available,
    reload: true,
    preserveView: false,
    reason: 'removed',
  };
}
