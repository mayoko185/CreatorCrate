import { comicSourceKey } from './comic-source.js';

export const COMIC_READER_PREFERENCES_STORAGE_KEY = 'creatorcrate-comic-reader-preferences';
const RECORD_PREFIX = `${COMIC_READER_PREFERENCES_STORAGE_KEY}:v1:`;
const DEFAULTS_KEY = `${RECORD_PREFIX}defaults`;
const VERSION = 1;

const VALUES = Object.freeze({
  direction: Object.freeze(['ltr', 'rtl']),
  layout: Object.freeze(['single', 'spread']),
  alignment: Object.freeze(['cover-alone', 'pair-from-first']),
});

export const COMIC_READER_PREFERENCE_DEFAULTS = Object.freeze({
  direction: 'ltr',
  layout: 'single',
  alignment: 'cover-alone',
});

/**
 * Complete, frozen preferences from any value: each of `direction`, `layout`
 * and `alignment` is kept when valid and otherwise uses the corresponding
 * fallback value. Other properties are dropped.
 *
 * @param {unknown} value
 * @param {{ direction: string, layout: string, alignment: string }} [fallback] Validated preferences.
 * @returns {{ direction: string, layout: string, alignment: string }}
 */
export function normalizeComicReaderPreferences(value, fallback = COMIC_READER_PREFERENCE_DEFAULTS) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const name of Object.keys(VALUES)) {
    let candidate;
    try {
      candidate = source[name];
    } catch {
      candidate = undefined;
    }
    result[name] = VALUES[name].includes(candidate) ? candidate : fallback[name];
  }
  return Object.freeze(result);
}

function isOversizedRecord(raw) {
  return typeof raw === 'string' && raw.length > 1024;
}

function parseRecord(raw) {
  if (typeof raw !== 'string' || raw === '' || isOversizedRecord(raw)) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

export function parseStoredComicReaderPreferences(raw) {
  const record = parseRecord(raw);
  return record ? normalizeComicReaderPreferences(record) : null;
}

function recordKey(identity) {
  try {
    return `${RECORD_PREFIX}${comicSourceKey(identity?.projectId, identity?.assetId)}`;
  } catch {
    return null;
  }
}

function serialize(preferences) {
  return JSON.stringify({ version: VERSION, ...preferences });
}

export function createComicReaderPreferences({ storage = () => globalThis.localStorage } = {}) {
  const remembered = new Map();
  let migratedDefaults;
  let snapshotPending = false;

  function getStorage() {
    return typeof storage === 'function' ? storage() : storage;
  }

  function getItem(key) {
    try {
      return getStorage()?.getItem(key);
    } catch {
      return undefined;
    }
  }

  function setItem(key, raw) {
    try {
      const store = getStorage();
      if (!store) return false;
      store.setItem(key, raw);
      return true;
    } catch {
      return false;
    }
  }

  function readDefaults({ retrySnapshot = false } = {}) {
    if (migratedDefaults && !snapshotPending) return migratedDefaults;
    const raw = getItem(DEFAULTS_KEY);
    const record = parseRecord(raw);
    if (record?.version === VERSION) {
      snapshotPending = false;
      migratedDefaults = normalizeComicReaderPreferences(record);
      return migratedDefaults;
    }
    if (raw === undefined) return migratedDefaults || COMIC_READER_PREFERENCE_DEFAULTS;
    if (!migratedDefaults) {
      const legacy = getItem(COMIC_READER_PREFERENCES_STORAGE_KEY);
      if (legacy === undefined) return COMIC_READER_PREFERENCE_DEFAULTS;
      const imported = parseStoredComicReaderPreferences(legacy);
      migratedDefaults = imported || COMIC_READER_PREFERENCE_DEFAULTS;
      snapshotPending = Boolean(imported && !isOversizedRecord(raw) && !Object.hasOwn(record || {}, 'version')
        && !setItem(DEFAULTS_KEY, serialize(imported)));
    } else if (retrySnapshot && !isOversizedRecord(raw) && !Object.hasOwn(record || {}, 'version')) {
      snapshotPending = !setItem(DEFAULTS_KEY, serialize(migratedDefaults));
    }
    return migratedDefaults;
  }

  function read(identity) {
    const key = recordKey(identity);
    if (!key) return COMIC_READER_PREFERENCE_DEFAULTS;
    const defaults = readDefaults();
    const raw = getItem(key);
    const record = parseRecord(raw);
    const cached = remembered.get(key);
    // Keep a failed edit over the value it was based on. If storage has
    // changed since then, use the valid stored value and discard the edit.
    if (record?.version === VERSION && (!cached || cached.raw !== raw)) {
      const preferences = normalizeComicReaderPreferences(record);
      remembered.set(key, { raw, preferences });
      return preferences;
    }
    return cached?.preferences || defaults;
  }

  function write(identity, patch) {
    const key = recordKey(identity);
    if (!key || !patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
    const changes = {};
    for (const name of Object.keys(VALUES)) {
      if (!Object.hasOwn(patch, name)) continue;
      const value = patch[name];
      if (!VALUES[name].includes(value)) return null;
      changes[name] = value;
    }
    if (!Object.keys(changes).length) return null;

    const defaults = readDefaults({ retrySnapshot: true });
    const raw = getItem(key);
    const record = parseRecord(raw);
    const cached = remembered.get(key);
    const fallback = cached?.preferences || defaults;
    const stored = record?.version === VERSION ? normalizeComicReaderPreferences(record, fallback) : null;
    const next = normalizeComicReaderPreferences({ ...(stored || fallback), ...changes });
    const serialized = serialize(next);
    // Oversized values are present but unreadable; they and future schemas
    // may contain settings this version cannot preserve.
    const persisted = raw === serialized || (raw !== undefined && !isOversizedRecord(raw)
      && (!Object.hasOwn(record || {}, 'version') || record.version === VERSION)
      && setItem(key, serialized));
    // Keep local edits while writes still fail against the same record.
    const preferences = !persisted && stored && cached?.raw === raw
      ? normalizeComicReaderPreferences({ ...fallback, ...changes })
      : next;
    const previousRaw = raw === undefined ? cached?.raw : raw;
    remembered.set(key, { preferences, raw: persisted ? serialized : previousRaw });
    return { preferences, persisted };
  }

  return Object.freeze({ read, write });
}
