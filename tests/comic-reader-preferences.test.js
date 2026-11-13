import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMIC_READER_PREFERENCE_DEFAULTS,
  COMIC_READER_PREFERENCES_STORAGE_KEY,
  createComicReaderPreferences,
  normalizeComicReaderPreferences,
  parseStoredComicReaderPreferences,
} from '../src/static/client/comic-reader-preferences.js';

const KEY = 'creatorcrate-comic-reader-preferences';
const DEFAULTS = { direction: 'ltr', layout: 'single', alignment: 'cover-alone' };

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((key) => (data.has(key) ? data.get(key) : null)),
    setItem: vi.fn((key, value) => { data.set(key, String(value)); }),
    removeItem: vi.fn((key) => { data.delete(key); }),
  };
}

const storedWith = (value) => memoryStorage({ [KEY]: typeof value === 'string' ? value : JSON.stringify(value) });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('comic reader preference values', () => {
  it('uses one stable application storage key and the approved defaults', () => {
    expect(COMIC_READER_PREFERENCES_STORAGE_KEY).toBe(KEY);
    expect(COMIC_READER_PREFERENCE_DEFAULTS).toEqual(DEFAULTS);
    expect(Object.isFrozen(COMIC_READER_PREFERENCE_DEFAULTS)).toBe(true);
  });

  it('validates each field on its own, keeping valid ones and dropping extras', () => {
    expect(normalizeComicReaderPreferences({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' }))
      .toEqual({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
    expect(normalizeComicReaderPreferences({ direction: 'up', layout: 'spread', alignment: 'pair-from-first' }))
      .toEqual({ direction: 'ltr', layout: 'spread', alignment: 'pair-from-first' });
    expect(normalizeComicReaderPreferences({ direction: 'rtl', layout: 'double', alignment: 'pair-from-first' }))
      .toEqual({ direction: 'rtl', layout: 'single', alignment: 'pair-from-first' });
    expect(normalizeComicReaderPreferences({ direction: 'rtl', layout: 'spread', alignment: 'odd' }))
      .toEqual({ direction: 'rtl', layout: 'spread', alignment: 'cover-alone' });
    expect(normalizeComicReaderPreferences({ direction: 'RTL', layout: ['spread'], alignment: 1, page: 4, assetId: 9 }))
      .toEqual(DEFAULTS);
    for (const value of [null, undefined, 'rtl', 42, true, ['rtl']]) {
      expect(normalizeComicReaderPreferences(value)).toEqual(DEFAULTS);
    }
    const throwing = { get direction() { throw new Error('boom'); }, layout: 'spread' };
    expect(normalizeComicReaderPreferences(throwing)).toEqual({ ...DEFAULTS, layout: 'spread' });
    expect(Object.isFrozen(normalizeComicReaderPreferences({}))).toBe(true);
  });

  it('parses only stored JSON objects', () => {
    expect(parseStoredComicReaderPreferences(JSON.stringify({ direction: 'rtl' }))).toEqual({ ...DEFAULTS, direction: 'rtl' });
    for (const raw of [null, undefined, '', '{', 'rtl', '"rtl"', '[]', 'null', '42', 42, {}, 'x'.repeat(2000)]) {
      expect(parseStoredComicReaderPreferences(raw)).toBe(null);
    }
  });
});

describe('comic reader preference helper', () => {
  const a = { projectId: 7, assetId: 40, filename: 'issue.cbz' };
  const b = { ...a, assetId: 41 };
  const c = { ...a, projectId: 8 };
  const aKey = KEY + ':v1:comic:7:40';
  const defaultsKey = KEY + ':v1:defaults';
  const rtlPair = { direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' };
  const coverAlone = { ...DEFAULTS, layout: 'spread' };
  const record = (values) => JSON.stringify({ version: 1, ...values });

  it('persists all three fields independently by canonical project and asset IDs', () => {
    const storage = memoryStorage({ 'creatorcrate-asset-grid-size': 'large' });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(a)).toEqual(DEFAULTS);
    expect(helper.write(a, { ...rtlPair, page: 7, filename: a.filename })).toMatchObject({ persisted: true });
    expect(helper.write(b, coverAlone)).toMatchObject({ persisted: true });
    expect(helper.write(c, { ...DEFAULTS, direction: 'rtl' })).toMatchObject({ persisted: true });
    expect(helper.write(a, rtlPair)).toMatchObject({ persisted: true });
    expect(storage.setItem.mock.calls).toEqual([
      [aKey, record(rtlPair)],
      [KEY + ':v1:comic:7:41', record(coverAlone)],
      [KEY + ':v1:comic:8:40', record({ ...DEFAULTS, direction: 'rtl' })],
    ]);
    const fresh = createComicReaderPreferences({ storage });
    expect(fresh.read({ projectId: '7', assetId: '40', filename: 'renamed.cbz', sourceRevision: 'new' })).toEqual(rtlPair);
    expect(fresh.read(b)).toEqual(coverAlone);
    expect(fresh.read(c)).toEqual({ ...DEFAULTS, direction: 'rtl' });
    expect(fresh.read({ ...a, assetId: 42 })).toEqual(DEFAULTS);
    expect(createComicReaderPreferences({ storage: memoryStorage() }).read(a)).toEqual(DEFAULTS);
    expect(storage.data.get('creatorcrate-asset-grid-size')).toBe('large');
  });

  it.each([
    undefined, null, {}, { assetId: 40 }, { projectId: 7 },
    { ...a, projectId: '07' }, { ...a, assetId: ' 40' }, { ...a, assetId: '40:41' },
    { ...a, projectId: 0 }, { ...a, assetId: Number.MAX_SAFE_INTEGER + 1 },
    { ...a, assetId: -1 }, { ...a, projectId: 7.5 },
  ])('uses no storage or shared fallback for invalid identity %j', (identity) => {
    const storage = memoryStorage({ [aKey]: record(rtlPair) });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(identity)).toEqual(DEFAULTS);
    expect(helper.write(identity, rtlPair)).toBeNull();
    expect(helper.read(identity)).toEqual(DEFAULTS);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(helper.read(a)).toEqual(rtlPair);
  });

  it('snapshots valid legacy fields once and gives existing individual records precedence', () => {
    const legacy = '{"direction":"rtl","layout":"invalid"}';
    const storage = memoryStorage({ [KEY]: legacy, [aKey]: record(coverAlone) });
    const helper = createComicReaderPreferences({ storage });
    const migrated = { ...DEFAULTS, direction: 'rtl' };
    expect(helper.read(a)).toEqual(coverAlone);
    expect(helper.read(b)).toEqual(migrated);
    expect(storage.setItem.mock.calls).toEqual([[defaultsKey, record(migrated)]]);
    expect(helper.write(b, rtlPair)).toMatchObject({ persisted: true });
    expect(storage.data.get(KEY)).toBe(legacy);
    expect(storage.data.get(aKey)).toBe(record(coverAlone));
    storage.data.set(KEY, JSON.stringify(coverAlone));
    expect(createComicReaderPreferences({ storage }).read(c)).toEqual(migrated);
    expect(helper.read(c)).toEqual(migrated);
    expect(storage.getItem.mock.calls.filter(([key]) => key === KEY)).toHaveLength(1);
  });

  it.each(['{', '[]', '"rtl"', 'true', '', null])('ignores malformed or absent legacy data %j', (raw) => {
    const storage = storedWith(raw);
    expect(createComicReaderPreferences({ storage }).read(a)).toEqual(DEFAULTS);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('ignores malformed or incomplete records and validates fields independently', () => {
    const storage = memoryStorage({
      [aKey]: '{',
      [defaultsKey]: record({ direction: 'rtl' }),
    });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(a)).toEqual({ ...DEFAULTS, direction: 'rtl' });
    storage.data.set(aKey, '{"layout":"spread"}');
    expect(helper.read(a)).toEqual({ ...DEFAULTS, direction: 'rtl' });
    storage.data.set(aKey, record({ layout: 'spread', direction: 'up', alignment: false }));
    expect(helper.read(a)).toEqual(coverAlone);
    expect(helper.write(a, { layout: 'single', alignment: 'odd' })).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(helper.write(a, { layout: 'single' })).toMatchObject({ persisted: true });
    expect(storage.data.get(aKey)).toBe(record(DEFAULTS));
  });

  it('merges only the current patch after recovering storage', () => {
    const otherKey = KEY + ':v1:comic:8:40';
    const pair = { ...rtlPair, direction: 'ltr' };
    const storage = memoryStorage({ [otherKey]: record(coverAlone) });
    let denied = true;
    const helper = createComicReaderPreferences({ storage: () => (denied ? null : storage) });
    expect(helper.write(a, { layout: 'spread', alignment: 'cover-alone' }))
      .toEqual({ persisted: false, preferences: coverAlone });
    expect(helper.read(b)).toEqual(DEFAULTS);
    storage.data.set(aKey, record(pair));
    denied = false;

    expect(helper.write(a, { direction: 'rtl' })).toEqual({ persisted: true, preferences: rtlPair });
    expect(helper.read(a)).toEqual(rtlPair);
    expect(helper.write(a, { layout: 'spread', alignment: 'cover-alone' }))
      .toEqual({ persisted: true, preferences: { ...coverAlone, direction: 'rtl' } });
    expect(storage.setItem.mock.calls).toEqual([
      [aKey, record(rtlPair)],
      [aKey, record({ ...coverAlone, direction: 'rtl' })],
    ]);
    expect(storage.data.get(otherKey)).toBe(record(coverAlone));
  });

  it.each([
    {
      field: 'direction',
      fallback: DEFAULTS,
      saved: { ...rtlPair, direction: 'up' },
      patch: { direction: 'rtl' },
      expected: rtlPair,
    },
    {
      field: 'layout',
      fallback: coverAlone,
      saved: { ...rtlPair, layout: 'double' },
      patch: { layout: 'single' },
      expected: { ...rtlPair, layout: 'single' },
    },
    {
      field: 'alignment',
      fallback: { ...rtlPair, layout: 'single' },
      saved: { ...rtlPair, alignment: 'odd' },
      patch: { direction: 'ltr' },
      expected: { ...rtlPair, direction: 'ltr' },
    },
    {
      field: 'layout and alignment',
      fallback: { ...rtlPair, direction: 'ltr' },
      saved: { ...rtlPair, layout: 'double', alignment: 'odd' },
      patch: { layout: 'single' },
      expected: { ...rtlPair, layout: 'single' },
    },
    {
      field: 'layout and alignment before a spread edit',
      fallback: DEFAULTS,
      saved: { ...rtlPair, layout: 'double', alignment: 'odd' },
      patch: { layout: 'spread', alignment: 'pair-from-first' },
      expected: rtlPair,
    },
  ])('preserves valid saved fields when $field is invalid', ({ fallback, saved, patch, expected }) => {
    const otherKey = KEY + ':v1:comic:7:41';
    const storage = memoryStorage({ [otherKey]: record(coverAlone) });
    let denied = true;
    const helper = createComicReaderPreferences({ storage: () => (denied ? null : storage) });
    expect(helper.write(a, fallback)).toEqual({ persisted: false, preferences: fallback });
    storage.data.set(aKey, record(saved));
    denied = false;

    expect(helper.write(a, patch)).toEqual({ persisted: true, preferences: expected });
    expect(helper.read(a)).toEqual(expected);
    expect(createComicReaderPreferences({ storage }).read(a)).toEqual(expected);
    expect(storage.setItem.mock.calls).toEqual([[aKey, record(expected)]]);
    expect(storage.data.get(otherKey)).toBe(record(coverAlone));
  });

  it.each([null, '{', record({ direction: 'rtl' })])('uses remembered options for absent, malformed or missing fields (%j)', (raw) => {
    const storage = memoryStorage(raw === null ? {} : { [aKey]: raw });
    let denied = true;
    const helper = createComicReaderPreferences({ storage: () => (denied ? null : storage) });
    helper.write(a, { layout: 'spread', alignment: 'pair-from-first' });
    denied = false;
    expect(helper.write(a, { direction: 'rtl' })).toEqual({ persisted: true, preferences: rtlPair });
    expect(storage.data.get(aKey)).toBe(record(rtlPair));
  });

  it('ignores and preserves records with unsupported versions', () => {
    const future = JSON.stringify({ version: 2, ...rtlPair });
    const storage = memoryStorage({ [aKey]: future, [defaultsKey]: future });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(a)).toEqual(DEFAULTS);
    expect(helper.write(a, coverAlone)).toMatchObject({ persisted: false });
    expect(helper.read(a)).toEqual(coverAlone);
    expect(helper.read(b)).toEqual(DEFAULTS);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each([1, 2])('preserves oversized version-%i records through edits and resumes field-scoped persistence after replacement', (version) => {
    const future = 'x'.repeat(1024);
    const raw = JSON.stringify({ version, ...rtlPair, future });
    expect(raw.length).toBeGreaterThan(1024);
    const storage = memoryStorage({ [aKey]: raw });
    let denied = true;
    const helper = createComicReaderPreferences({ storage: () => (denied ? null : storage) });
    helper.write(a, coverAlone);
    denied = false;
    expect(createComicReaderPreferences({ storage }).read(a)).toEqual(DEFAULTS);
    expect(helper.write(a, { direction: 'rtl' }))
      .toEqual({ persisted: false, preferences: { ...coverAlone, direction: 'rtl' } });
    expect(helper.write(a, { layout: 'single' }))
      .toEqual({ persisted: false, preferences: { ...DEFAULTS, direction: 'rtl' } });
    expect(helper.read(a)).toEqual({ ...DEFAULTS, direction: 'rtl' });
    expect(storage.data.get(aKey)).toBe(raw);
    expect(JSON.parse(storage.data.get(aKey)).future).toBe(future);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();

    expect(helper.write(b, rtlPair)).toEqual({ persisted: true, preferences: rtlPair });
    expect(storage.data.get(aKey)).toBe(raw);
    storage.data.set(aKey, record({ ...rtlPair, direction: 'ltr' }));
    expect(helper.write(a, { direction: 'rtl' })).toEqual({ persisted: true, preferences: rtlPair });
    expect(storage.data.get(aKey)).toBe(record(rtlPair));
    expect(storage.setItem.mock.calls).toEqual([
      [KEY + ':v1:comic:7:41', record(rtlPair)],
      [aKey, record(rtlPair)],
    ]);
  });

  it.each([1, 2])('preserves oversized version-%i defaults instead of migrating over them', (version) => {
    const raw = JSON.stringify({ version, ...rtlPair, future: 'x'.repeat(1024) });
    const legacy = JSON.stringify({ direction: 'rtl' });
    const migrated = { ...DEFAULTS, direction: 'rtl' };
    const storage = memoryStorage({ [defaultsKey]: raw, [KEY]: legacy });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(a)).toEqual(migrated);
    expect(helper.read(b)).toEqual(migrated);
    expect(helper.write(a, { layout: 'spread' }))
      .toEqual({ persisted: true, preferences: { ...migrated, layout: 'spread' } });
    expect(helper.write(a, { direction: 'ltr' })).toMatchObject({ persisted: true });
    expect(createComicReaderPreferences({ storage }).read(c)).toEqual(migrated);
    expect(storage.data.get(defaultsKey)).toBe(raw);
    expect(storage.data.get(KEY)).toBe(legacy);
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([aKey, aKey]);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('does not retry a failed defaults snapshot over a subsequently oversized value', () => {
    const legacy = JSON.stringify({ direction: 'rtl' });
    const storage = memoryStorage({ [KEY]: legacy });
    storage.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError'); });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(a)).toEqual({ ...DEFAULTS, direction: 'rtl' });
    const raw = JSON.stringify({ version: 2, future: 'x'.repeat(1024) });
    storage.data.set(defaultsKey, raw);
    storage.setItem.mockClear();
    expect(helper.write(a, { layout: 'spread' })).toMatchObject({ persisted: true });
    expect(helper.write(b, { direction: 'ltr' })).toMatchObject({ persisted: true });
    expect(storage.data.get(defaultsKey)).toBe(raw);
    expect(storage.data.get(KEY)).toBe(legacy);
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([aKey, KEY + ':v1:comic:7:41']);
  });

  it('uses built-in defaults when both the existing snapshot and legacy value exceed the guard', () => {
    const raw = JSON.stringify({ version: 1, ...rtlPair, future: 'x'.repeat(1024) });
    const storage = memoryStorage({ [defaultsKey]: raw, [KEY]: raw });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(a)).toEqual(DEFAULTS);
    expect(helper.write(a, { direction: 'rtl' })).toMatchObject({ persisted: true });
    expect(storage.data.get(defaultsKey)).toBe(raw);
    expect(storage.data.get(KEY)).toBe(raw);
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([aKey]);
  });

  it.each([1024, 1025])('keeps the existing %i-character boundary for reads, writes and defaults migration', (length) => {
    const base = JSON.stringify({ version: 1, ...rtlPair, padding: '' });
    const raw = JSON.stringify({ version: 1, ...rtlPair, padding: 'x'.repeat(length - base.length) });
    expect(raw).toHaveLength(length);
    expect(parseStoredComicReaderPreferences(raw)).toEqual(length === 1024 ? rtlPair : null);
    const storage = memoryStorage({ [aKey]: raw });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(a)).toEqual(length === 1024 ? rtlPair : DEFAULTS);
    expect(helper.write(a, { direction: 'ltr' })).toEqual({
      persisted: length === 1024,
      preferences: length === 1024 ? { ...rtlPair, direction: 'ltr' } : DEFAULTS,
    });
    expect(storage.data.get(aKey)).toBe(length === 1024 ? record({ ...rtlPair, direction: 'ltr' }) : raw);
    expect(storage.setItem).toHaveBeenCalledTimes(length === 1024 ? 1 : 0);

    const defaultsStorage = memoryStorage({ [defaultsKey]: raw, [KEY]: JSON.stringify({ direction: 'rtl' }) });
    const defaultsHelper = createComicReaderPreferences({ storage: defaultsStorage });
    expect(defaultsHelper.read(a)).toEqual(length === 1024 ? rtlPair : { ...DEFAULTS, direction: 'rtl' });
    defaultsHelper.write(a, { direction: 'ltr' });
    expect(defaultsStorage.data.get(defaultsKey)).toBe(raw);
    expect(defaultsStorage.setItem.mock.calls.map(([key]) => key)).toEqual([aKey]);
  });

  it('isolates fallback edits when reaching storage or reading it throws', () => {
    const throwing = () => { throw new Error('SecurityError'); };
    for (const storage of [throwing, { getItem: throwing }, null, {}]) {
      const helper = createComicReaderPreferences({ storage });
      expect(helper.read(a)).toEqual(DEFAULTS);
      expect(helper.write(a, rtlPair)).toMatchObject({ persisted: false });
      expect(helper.read(a)).toEqual(rtlPair);
      expect(helper.read(b)).toEqual(DEFAULTS);
      expect(helper.read(c)).toEqual(DEFAULTS);
    }
  });

  it('retains a failed write against unchanged storage and accepts a newer stored choice without replay', () => {
    const storage = memoryStorage({ [aKey]: record(coverAlone) });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(a)).toEqual(coverAlone);
    storage.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError'); });
    expect(helper.write(a, rtlPair)).toMatchObject({ persisted: false });
    expect(helper.read(a)).toEqual(rtlPair);
    expect(helper.read(b)).toEqual(DEFAULTS);
    createComicReaderPreferences({ storage }).write(a, DEFAULTS);
    expect(helper.read(a)).toEqual(DEFAULTS);
    expect(storage.data.get(aKey)).toBe(record(DEFAULTS));
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('keeps local edits during write failures and merges against the saved record once writes succeed', () => {
    const storage = memoryStorage({ [aKey]: record(coverAlone) });
    const helper = createComicReaderPreferences({ storage });
    helper.read(a);
    const quotaError = () => { throw new Error('QuotaExceededError'); };
    storage.setItem.mockImplementationOnce(quotaError).mockImplementationOnce(quotaError);
    const pair = { ...rtlPair, direction: 'ltr' };
    expect(helper.write(a, { alignment: 'pair-from-first' })).toEqual({ persisted: false, preferences: pair });
    expect(helper.write(a, { direction: 'rtl' })).toEqual({ persisted: false, preferences: rtlPair });
    expect(helper.read(a)).toEqual(rtlPair);
    expect(storage.data.get(aKey)).toBe(record(coverAlone));

    const single = { ...DEFAULTS, layout: 'single' };
    expect(helper.write(a, { layout: 'single' })).toEqual({ persisted: true, preferences: single });
    expect(storage.data.get(aKey)).toBe(record(single));
  });

  it('keeps stored choices through access denial and honors changes made while denied', () => {
    const storage = memoryStorage({ [aKey]: record(coverAlone) });
    let available = true;
    const helper = createComicReaderPreferences({ storage: () => (available ? storage : null) });
    expect(helper.read(a)).toEqual(coverAlone);
    available = false;
    expect(helper.read(a)).toEqual(coverAlone);
    expect(helper.write(a, rtlPair)).toMatchObject({ persisted: false });
    expect(helper.read(a)).toEqual(rtlPair);
    expect(helper.read(c)).toEqual(DEFAULTS);
    storage.data.set(aKey, record(DEFAULTS));
    available = true;
    expect(helper.read(a)).toEqual(DEFAULTS);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('reads legacy after a read failure and retries a failed snapshot on a later edit', () => {
    const storage = storedWith({ direction: 'rtl' });
    const read = storage.getItem.getMockImplementation();
    storage.getItem.mockImplementation((key) => {
      if (key === KEY) throw new Error('SecurityError');
      return read(key);
    });
    const helper = createComicReaderPreferences({ storage });
    expect(helper.read(a)).toEqual(DEFAULTS);
    storage.getItem.mockImplementation(read);
    storage.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError'); });
    const migrated = { ...DEFAULTS, direction: 'rtl' };
    expect(helper.read(a)).toEqual(migrated);
    storage.data.set(KEY, JSON.stringify(coverAlone));
    expect(helper.read(b)).toEqual(migrated);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(helper.write(a, rtlPair)).toMatchObject({ persisted: true });
    expect(createComicReaderPreferences({ storage }).read(c)).toEqual(migrated);
  });

  it('uses localStorage and frozen preferences without requests or cookies', () => {
    const storage = memoryStorage();
    const fetch = vi.fn();
    const document = { cookie: '' };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('document', document);
    const helper = createComicReaderPreferences();
    expect(Object.isFrozen(helper)).toBe(true);
    expect(Object.isFrozen(helper.read(a))).toBe(true);
    expect(helper.write(a, rtlPair)).toMatchObject({ persisted: true });
    expect(createComicReaderPreferences().read(a)).toEqual(rtlPair);
    expect(Object.isFrozen(helper.read(a))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
  });
});
