import { BookContentIntegrityError, BookValidationError } from './book-service.js';

export class BookHierarchyValidationError extends BookValidationError {
  constructor(message, { code = 'HIERARCHY_INVALID', status = 400 } = {}) {
    super({ hierarchy: message });
    this.name = 'BookHierarchyValidationError';
    this.code = code;
    this.status = status;
  }
}

const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isObject = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function invalid(message) {
  throw new BookHierarchyValidationError(message);
}

function exactKeys(value, keys, label) {
  if (!isObject(value) || Object.keys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))) {
    invalid(`${label} must contain only ${keys.join(', ')}.`);
  }
}

function hierarchyShape(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  const chapters = new Set();
  const pages = new Set();
  function pageId(id) {
    if (!isId(id)) invalid(`${label} Page IDs must be positive safe integers.`);
    if (pages.has(id)) invalid(`${label} contains duplicate Page ${id}.`);
    pages.add(id);
    return id;
  }
  // Copy without sorting, coercing, deduplicating, or retaining caller references.
  return Array.from(value, (node) => {
    if (!isObject(node) || !['chapter', 'page'].includes(node.type)) {
      invalid(`${label} nodes must be Chapters or Pages.`);
    }
    if (node.type === 'page') {
      exactKeys(node, ['type', 'id'], `${label} root Page`);
      return { type: 'page', id: pageId(node.id) };
    }
    exactKeys(node, ['type', 'id', 'pages'], `${label} Chapter`);
    if (!isId(node.id)) invalid(`${label} Chapter IDs must be positive safe integers.`);
    if (chapters.has(node.id)) invalid(`${label} contains duplicate Chapter ${node.id}.`);
    chapters.add(node.id);
    if (!Array.isArray(node.pages)) invalid(`${label} Chapter pages must be an array of Page IDs.`);
    return { type: 'chapter', id: node.id, pages: Array.from(node.pages, pageId) };
  });
}

function submissionShape(value) {
  exactKeys(value, ['version', 'expected', 'target'], 'Hierarchy payload');
  if (value.version !== 1) invalid('Hierarchy payload version must be 1.');
  return {
    version: 1,
    expected: hierarchyShape(value.expected, 'expected'),
    target: hierarchyShape(value.target, 'target'),
  };
}

/** Parse one JSON string (the future hierarchy field). No HTTP transport wiring. */
export function parseBookHierarchyPayload(value) {
  if (typeof value !== 'string') invalid('Hierarchy must be a single JSON string.');
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid('Hierarchy must contain valid JSON.');
  }
  return submissionShape(parsed);
}

function integrity(condition, message) {
  if (!condition) {
    throw new BookContentIntegrityError(message, { code: 'HIERARCHY_INTEGRITY' });
  }
}

function inventory(rows, bookId, label) {
  integrity(Array.isArray(rows), `${label} inventory is required.`);
  const byId = new Map();
  for (const row of rows) {
    integrity(isObject(row) && isId(row.id) && row.book_id === bookId,
      `${label} must have valid IDs and belong to Book ${bookId}.`);
    integrity(!byId.has(row.id), `${label} inventory contains duplicate ID ${row.id}.`);
    byId.set(row.id, row);
  }
  return byId;
}

function validOrder(row) {
  return Number.isSafeInteger(row.sort_order) && row.sort_order >= 0;
}

/**
 * Pure snapshot validation. Package 2 must read ALL inventories and invoke this
 * inside its write transaction, before writing. No repository calls or logging.
 * Root gaps are valid; root ties are not. Chapter ties use the repository's ID
 * tie-breaker. Legacy chapters.sort_order and root notes.sort_order are ignored.
 */
export function buildCurrentBookHierarchy({ bookId, book, chapters, pages, memberships }) {
  if (!isId(bookId)) invalid('Book ID must be a positive safe integer.');
  integrity(isObject(book) && book.id === bookId, 'Current Book is missing or mismatched.');
  const chapterById = inventory(chapters, bookId, 'Chapter');
  const pageById = inventory(pages, bookId, 'Page');
  const chapterPages = new Map(chapters.map(({ id }) => [id, []]));
  const requiredRoots = new Set(chapters.map(({ id }) => `chapter:${id}`));
  for (const page of pages) {
    if (page.chapter_id === null) {
      requiredRoots.add(`page:${page.id}`);
    } else {
      integrity(isId(page.chapter_id) && chapterById.has(page.chapter_id),
        `Page ${page.id} references a missing or foreign Chapter.`);
      integrity(validOrder(page), `Page ${page.id} has invalid Chapter-local order.`);
      chapterPages.get(page.chapter_id).push(page);
    }
  }
  integrity(Array.isArray(memberships), 'Root membership inventory is required.');
  const seenRoots = new Set();
  const seenOrders = new Set();
  for (const row of memberships) {
    integrity(isObject(row) && row.book_id === bookId && isId(row.item_id)
      && ['chapter', 'page'].includes(row.item_type), 'Invalid or foreign root membership.');
    const key = `${row.item_type}:${row.item_id}`;
    const entity = row.item_type === 'chapter' ? chapterById.get(row.item_id) : pageById.get(row.item_id);
    integrity(entity && requiredRoots.has(key), `Root membership ${key} does not resolve to a root entity.`);
    integrity(!seenRoots.has(key), `Duplicate root membership ${key}.`);
    integrity(validOrder(row) && !seenOrders.has(row.sort_order), 'Invalid or ambiguous root order.');
    seenRoots.add(key);
    seenOrders.add(row.sort_order);
  }
  integrity(seenRoots.size === requiredRoots.size, 'Current root membership inventory is incomplete.');
  for (const rows of chapterPages.values()) {
    rows.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  }
  return [...memberships].sort((a, b) => a.sort_order - b.sort_order).map((row) => (
    row.item_type === 'chapter'
      ? { type: 'chapter', id: row.item_id, pages: chapterPages.get(row.item_id).map(({ id }) => id) }
      : { type: 'page', id: row.item_id }
  ));
}

function destinations(hierarchy) {
  const result = new Map();
  for (const node of hierarchy) {
    if (node.type === 'page') result.set(node.id, null);
    else for (const id of node.pages) result.set(id, node.id);
  }
  return result;
}

/** Validate an already parsed payload again, then return a detached, pure plan. */
export function planBookHierarchy(snapshot, payload) {
  // Integrity takes precedence over stale/target comparisons: never repair corruption.
  const currentHierarchy = buildCurrentBookHierarchy(snapshot);
  const { expected, target: targetHierarchy } = submissionShape(payload);
  if (JSON.stringify(currentHierarchy) !== JSON.stringify(expected)) {
    throw new BookHierarchyValidationError('Book hierarchy changed. Reload before changing its order.', {
      code: 'HIERARCHY_STALE', status: 409,
    });
  }
  const currentDestinations = destinations(currentHierarchy);
  const targetDestinations = destinations(targetHierarchy);
  const currentChapters = new Set(snapshot.chapters.map(({ id }) => id));
  const targetChapters = targetHierarchy.filter(({ type }) => type === 'chapter');
  if (targetChapters.length !== currentChapters.size
    || targetChapters.some(({ id }) => !currentChapters.has(id))) {
    invalid('Target must contain every current Chapter exactly once and no foreign Chapters.');
  }
  if (targetDestinations.size !== currentDestinations.size
    || [...targetDestinations.keys()].some((id) => !currentDestinations.has(id))) {
    invalid('Target must contain every current Book Page exactly once and no foreign Pages.');
  }
  const pageDestinationChanges = [...currentDestinations]
    .filter(([id, chapterId]) => targetDestinations.get(id) !== chapterId)
    .sort(([a], [b]) => a - b)
    .map(([pageId, currentChapterId]) => ({
      pageId, currentChapterId, targetChapterId: targetDestinations.get(pageId),
    }));
  return {
    currentHierarchy,
    targetHierarchy,
    rootTargetItems: targetHierarchy.map(({ type, id }) => ({ type, id })),
    chapterTargetOrders: new Map(targetChapters.map(({ id, pages }) => [id, [...pages]])),
    pageDestinationChanges,
    changed: JSON.stringify(currentHierarchy) !== JSON.stringify(targetHierarchy),
  };
}
