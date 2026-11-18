import { describe, expect, it } from 'vitest';
import {
  ASSET_LIBRARY_PAGE_SIZE_VALUES,
  buildAssetLibraryUrl,
  hasAssetLibraryQuery,
  isBareAssetLibraryRequest,
  parseAssetLibraryQuery,
} from '../src/routes/asset-library-query.js';

describe('Asset Viewer query foundation', () => {
  it('defines the exact supported page-size order', () => {
    expect(ASSET_LIBRARY_PAGE_SIZE_VALUES).toEqual([10, 25, 50, 100, 150, 200, 'all']);
  });

  it('normalizes every supported presentation value', () => {
    for (const view of ['grid', 'list']) {
      const parsed = parseAssetLibraryQuery({ view });
      expect(parsed.view).toBe(view);
      expect(parsed.presentation.view).toEqual({ value: view, state: 'valid' });
    }

    for (const sort of ['filename', 'modified', 'size', 'category', 'project']) {
      const parsed = parseAssetLibraryQuery({ sort });
      expect(parsed.sort).toBe(sort);
      expect(parsed.presentation.sort).toEqual({ value: sort, state: 'valid' });
    }

    for (const order of ['asc', 'desc']) {
      const parsed = parseAssetLibraryQuery({ order });
      expect(parsed.order).toBe(order);
      expect(parsed.presentation.order).toEqual({ value: order, state: 'valid' });
    }

    for (const pageSize of ASSET_LIBRARY_PAGE_SIZE_VALUES) {
      const parsed = parseAssetLibraryQuery({ pageSize: String(pageSize) });
      expect(parsed.pageSize).toBe(pageSize);
      expect(parsed.presentation.pageSize).toEqual({ value: pageSize, state: 'valid' });
    }

  });

  it('distinguishes omitted presentation values from explicit invalid values', () => {
    const omitted = parseAssetLibraryQuery({});
    expect(omitted.presentation).toEqual({
      view: { value: 'grid', state: 'omitted' },
      sort: { value: 'filename', state: 'omitted' },
      order: { value: 'asc', state: 'omitted' },
      pageSize: { value: 25, state: 'omitted' },
    });
    expect(omitted.queryWasNonBare).toBe(false);

    const invalid = parseAssetLibraryQuery({
      view: 'cards',
      sort: 'name',
      order: 'up',
      pageSize: '20',
    });
    expect(invalid).toMatchObject({ view: 'grid', sort: 'filename', order: 'asc', pageSize: 25 });
    expect(invalid.presentation).toEqual({
      view: { value: 'grid', state: 'invalid' },
      sort: { value: 'filename', state: 'invalid' },
      order: { value: 'asc', state: 'invalid' },
      pageSize: { value: 25, state: 'invalid' },
    });
    expect(invalid.queryWasNonBare).toBe(true);
  });

  it('marks explicitly valid fallback presentation values as valid', () => {
    const parsed = parseAssetLibraryQuery({
      view: 'grid',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
    });

    expect(Object.values(parsed.presentation).every(({ state }) => state === 'valid')).toBe(true);
  });

  it('normalizes projects, global category slugs, and rejects numeric category IDs', () => {
    expect(parseAssetLibraryQuery({ project: '42', category: 'source-files' })).toMatchObject({
      projectId: 42,
      category: 'source-files',
    });

    for (const project of ['0', '-1', '01', '1.5', '1e2', ' 2 ', 'not-a-number']) {
      expect(parseAssetLibraryQuery({ project }).projectId).toBeNull();
    }

    expect(parseAssetLibraryQuery({ category: 'all' }).category).toBe('all');
    expect(parseAssetLibraryQuery({ category: 'uncategorized' }).category).toBe('uncategorized');
    expect(parseAssetLibraryQuery({ category: '123' }).category).toBe('all');
    expect(parseAssetLibraryQuery({ category: 123 }).category).toBe('all');
    expect(parseAssetLibraryQuery({ category: 'Source Files' }).category).toBe('all');
    expect(parseAssetLibraryQuery({ category: 'source_files' }).category).toBe('all');
  });

  it('parses only strict positive safe integer tag IDs', () => {
    expect(parseAssetLibraryQuery({ tag: '42' }).tag).toBe(42);

    for (const tag of ['', '0', '-1', '1.5', '1junk', 'not-a-number', '9007199254740992', '01', ' 2 ']) {
      expect(parseAssetLibraryQuery({ tag }).tag).toBeNull();
    }

    expect(parseAssetLibraryQuery({}).tag).toBeNull();
  });

  it('parses repeated tag, category, and extension values as sorted unique selections', () => {
    const parsed = parseAssetLibraryQuery({
      tag: ['2', '1', '2', 'not-a-number', '0'],
      category: ['krz', 'all', 'final', 'krz', 'not a slug'],
      extension: ['.KRZ', 'png', 'png', '..invalid', ''],
    });

    expect(parsed).toMatchObject({
      tags: [1, 2],
      categories: ['final', 'krz'],
      extensions: ['krz', 'png'],
      tag: 1,
      category: 'final',
      extension: 'krz',
    });
  });

  it('keeps a single legacy value in the corresponding selection array', () => {
    expect(parseAssetLibraryQuery({ tag: '7', category: 'final', extension: '.PNG' })).toMatchObject({
      tags: [7],
      categories: ['final'],
      extensions: ['png'],
      tag: 7,
      category: 'final',
      extension: 'png',
    });
  });

  it('trims search text, omits empty search, and preserves meaningful intent', () => {
    expect(parseAssetLibraryQuery({ search: '  final render  ' }).search).toBe('final render');
    expect(parseAssetLibraryQuery({ search: '   ' }).search).toBeNull();
    expect(parseAssetLibraryQuery({ search: '  A+B & C / D  ' }).search).toBe('A+B & C / D');
    expect(parseAssetLibraryQuery({ search: 'x'.repeat(200) }).search).toHaveLength(128);
  });

  it('normalizes extensions to the existing dot-free lowercase convention', () => {
    expect(parseAssetLibraryQuery({ extension: '.PNG' }).extension).toBe('png');
    expect(parseAssetLibraryQuery({ extension: '  JPG  ' }).extension).toBe('jpg');
    expect(parseAssetLibraryQuery({ extension: '.' }).extension).toBeNull();
    expect(parseAssetLibraryQuery({ extension: '..png' }).extension).toBeNull();
  });

  it('uses the existing presence and usage values with all as fallback', () => {
    for (const presence of ['all', 'present', 'missing']) {
      expect(parseAssetLibraryQuery({ presence }).presence).toBe(presence);
    }
    for (const usage of ['all', 'used', 'unused']) {
      expect(parseAssetLibraryQuery({ usage }).usage).toBe(usage);
    }
    expect(parseAssetLibraryQuery({ presence: 'available', usage: 'referenced' })).toMatchObject({
      presence: 'all',
      usage: 'all',
    });
  });

  it('accepts positive pages and the supported page-size values', () => {
    expect(parseAssetLibraryQuery({ page: '7' }).page).toBe(7);
    expect(parseAssetLibraryQuery({ page: '0' }).page).toBe(1);
    expect(parseAssetLibraryQuery({ page: '-1' }).page).toBe(1);
    expect(parseAssetLibraryQuery({ page: '01' }).page).toBe(1);
    expect(parseAssetLibraryQuery({ page: '1.5' }).page).toBe(1);
    expect(parseAssetLibraryQuery({ page: '1e2' }).page).toBe(1);

    expect(parseAssetLibraryQuery({ pageSize: '150' }).pageSize).toBe(150);
    expect(parseAssetLibraryQuery({ pageSize: '200' }).pageSize).toBe(200);
    expect(parseAssetLibraryQuery({ pageSize: 'all' }).pageSize).toBe('all');
    expect(parseAssetLibraryQuery({ pageSize: '20' }).pageSize).toBe(25);
    expect(parseAssetLibraryQuery({ pageSize: '101' }).pageSize).toBe(25);
    expect(parseAssetLibraryQuery({ pageSize: '0' }).pageSize).toBe(25);
  });

  it('counts only supported query keys for bare-request detection', () => {
    expect(hasAssetLibraryQuery({ unknown: 'value' })).toBe(false);
    expect(isBareAssetLibraryRequest({ unknown: 'value' })).toBe(true);
    expect(parseAssetLibraryQuery({ unknown: 'value' }).queryWasNonBare).toBe(false);

    expect(hasAssetLibraryQuery({ unknown: 'value', view: 'invalid' })).toBe(true);
    expect(isBareAssetLibraryRequest({ unknown: 'value', view: 'invalid' })).toBe(false);
    expect(parseAssetLibraryQuery({ unknown: 'value', view: 'invalid' }).queryWasNonBare).toBe(true);
    expect(hasAssetLibraryQuery({ tag: '' })).toBe(true);
    expect(parseAssetLibraryQuery({ tag: '' }).tag).toBeNull();
  });

  it('omits fallback values and preserves active filters in deterministic order', () => {
    const parsed = parseAssetLibraryQuery({
      project: '12',
      category: 'source-files',
      tag: '42',
      search: 'A&B / résumé',
      extension: '.PNG',
      presence: 'missing',
      usage: 'used',
      sort: 'project',
      order: 'desc',
      page: '3',
      pageSize: '50',
      view: 'list',
      unknown: 'discard-me',
    });

    expect(buildAssetLibraryUrl(parsed)).toBe(
      '/asset-viewer?project=12&category=source-files&tag=42&search=A%26B+%2F+r%C3%A9sum%C3%A9&extension=png&presence=missing&usage=used&sort=project&order=desc&page=3&pageSize=50&view=list',
    );

    expect(buildAssetLibraryUrl(parseAssetLibraryQuery({
      category: 'all',
      search: '  ',
      presence: 'all',
      usage: 'all',
      page: '1',
    }))).toBe('/asset-viewer');
  });

  it('serializes every valid multi-value selection as repeated canonical parameters', () => {
    const parsed = parseAssetLibraryQuery({
      tag: ['2', '1', '2'],
      category: ['krz', 'final', 'all', 'final'],
      extension: ['.KRZ', 'png', 'png'],
      sort: 'project',
      order: 'desc',
      page: '2',
      pageSize: '10',
      view: 'list',
    });

    expect(buildAssetLibraryUrl(parsed)).toBe(
      '/asset-viewer?category=final&category=krz&tag=1&tag=2&extension=krz&extension=png&sort=project&order=desc&page=2&pageSize=10&view=list',
    );
    expect(new URL(`http://localhost${buildAssetLibraryUrl(parsed)}`).searchParams.getAll('tag'))
      .toEqual(['1', '2']);
    expect(new URL(`http://localhost${buildAssetLibraryUrl(parsed)}`).searchParams.getAll('category'))
      .toEqual(['final', 'krz']);
    expect(new URL(`http://localhost${buildAssetLibraryUrl(parsed)}`).searchParams.getAll('extension'))
      .toEqual(['krz', 'png']);
  });

  it('retains every selection when sorting, paging, resizing, and switching views', () => {
    const parsed = parseAssetLibraryQuery({
      tag: ['1', '2'],
      category: ['final', 'krz'],
      extension: ['png', 'krz'],
      page: '3',
      pageSize: '25',
      view: 'grid',
    });

    expect(buildAssetLibraryUrl(parsed, {
      sort: 'project',
      order: 'desc',
      page: 2,
      pageSize: 50,
      view: 'list',
    })).toBe(
      '/asset-viewer?category=final&category=krz&tag=1&tag=2&extension=krz&extension=png&sort=project&order=desc&page=2&pageSize=50&view=list',
    );
  });

  it('preserves explicit valid fallback presentation values for future defaults', () => {
    const parsed = parseAssetLibraryQuery({
      view: 'grid',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
    });

    expect(buildAssetLibraryUrl(parsed)).toBe('/asset-viewer?sort=filename&order=asc&pageSize=25&view=grid');
    expect(buildAssetLibraryUrl(parseAssetLibraryQuery({
      view: 'invalid',
      sort: 'invalid',
      order: 'invalid',
      pageSize: '20',
    }))).toBe('/asset-viewer');
  });

  it('round-trips View All through canonical URLs and view switching', () => {
    const parsed = parseAssetLibraryQuery({ pageSize: 'all', view: 'grid' });

    expect(buildAssetLibraryUrl(parsed)).toBe('/asset-viewer?pageSize=all&view=grid');
    expect(buildAssetLibraryUrl(parsed, { view: 'list' }))
      .toBe('/asset-viewer?pageSize=all&view=list');
  });

  it('retains route-marked neutral filters so saved defaults cannot reappear', () => {
    expect(buildAssetLibraryUrl({
      presence: 'all',
      explicitNeutralFilters: ['presence'],
    })).toBe('/asset-viewer?presence=all');
    expect(buildAssetLibraryUrl({
      categories: [],
      tags: [],
      extensions: [],
      explicitNeutralFilters: ['category', 'tag', 'extension'],
    })).toBe('/asset-viewer?category=all&tag=all&extension=all');
  });

  it('omits null, malformed, and unsafe tag values from generated URLs', () => {
    const state = parseAssetLibraryQuery({ tag: '42', search: 'keep' });

    expect(buildAssetLibraryUrl(state, { tag: null })).toBe('/asset-viewer?search=keep');
    expect(buildAssetLibraryUrl(state, { tag: '42junk' })).toBe('/asset-viewer?search=keep');
    expect(buildAssetLibraryUrl({ tag: '9007199254740992' })).toBe('/asset-viewer');
  });

  it('preserves a route-marked fallback for an invalid explicit value', () => {
    const parsed = parseAssetLibraryQuery({ sort: 'invalid' });
    const state = {
      ...parsed,
      sort: 'filename',
      presentation: {
        ...parsed.presentation,
        sort: { ...parsed.presentation.sort, preserveFallback: true },
      },
    };

    expect(buildAssetLibraryUrl(state)).toBe('/asset-viewer?sort=filename');
  });

  it('supports pagination, view, sorting, and clear-filter overrides without mutation', () => {
    const parsed = parseAssetLibraryQuery({
      project: '4',
      search: 'keep',
      presence: 'present',
      sort: 'size',
      page: '3',
      pageSize: '50',
      view: 'list',
    });
    const original = structuredClone(parsed);

    expect(buildAssetLibraryUrl(parsed, {
      page: 2,
      view: 'grid',
      sort: 'filename',
      search: null,
      presence: 'all',
      unknown: 'discard-me',
    })).toBe('/asset-viewer?project=4&sort=filename&page=2&pageSize=50&view=grid');
    expect(parsed).toEqual(original);
  });

  it('ignores unknown state and override keys and never creates duplicate keys', () => {
    const url = buildAssetLibraryUrl({
      projectId: 9,
      search: 'one',
      unknown: 'state-value',
    }, {
      search: 'two',
      unknown: 'override-value',
      project: 9,
    });

    expect(url).toBe('/asset-viewer?project=9&search=two');
    expect(new URL(`http://localhost${url}`).searchParams.getAll('project')).toEqual(['9']);
    expect(new URL(`http://localhost${url}`).searchParams.getAll('search')).toEqual(['two']);
  });
});

describe('Asset Viewer WP8 Project and Project Type query contract', () => {
  it('keeps a single legacy project value working with the scalar alias', () => {
    expect(parseAssetLibraryQuery({ project: '7' })).toMatchObject({
      projectId: 7,
      projectIds: [7],
      projectTypes: [],
    });
    expect(buildAssetLibraryUrl(parseAssetLibraryQuery({ project: '7' }))).toBe('/asset-viewer?project=7');
  });

  it('parses repeated project values into a deduplicated ascending selection', () => {
    const parsed = parseAssetLibraryQuery({ project: ['12', '7', '12', '30'] });
    expect(parsed.projectIds).toEqual([7, 12, 30]);
    // A multi-project request never narrows to its first or last ID.
    expect(parsed.projectId).toBeNull();
  });

  it('discards malformed project values individually, including comma-joined IDs', () => {
    const parsed = parseAssetLibraryQuery({
      project: ['', '0', '-3', '01', '1.5', '1e2', ' 2 ', 'x', '7,12', '9007199254740993', '12'],
    });
    expect(parsed.projectIds).toEqual([12]);
    expect(parsed.projectId).toBe(12);
    expect(parseAssetLibraryQuery({ project: '7,12' }).projectIds).toEqual([]);
    expect(parseAssetLibraryQuery({ project: { 0: '7' } }).projectIds).toEqual([]);
  });

  it('parses repeated Project Type values with the stable catalogue value syntax', () => {
    expect(parseAssetLibraryQuery({ type: 'comic' }).projectTypes).toEqual(['comic']);
    expect(parseAssetLibraryQuery({ type: ['images', 'comic', 'images'] }).projectTypes)
      .toEqual(['comic', 'images']);
    // Labels, case variants, padding and comma lists are not stable values.
    expect(parseAssetLibraryQuery({
      type: ['Images', ' comic ', 'comic,images', '', 'all', 'bad_value', 'two-part'],
    }).projectTypes).toEqual(['all', 'two-part']);
  });

  it('treats project and type as meaningful Asset Viewer query keys', () => {
    expect(hasAssetLibraryQuery({ type: 'comic' })).toBe(true);
    expect(isBareAssetLibraryRequest({ type: 'comic' })).toBe(false);
    expect(hasAssetLibraryQuery({ project: ['1', '2'] })).toBe(true);
  });

  it('serializes Projects and Types as repeated canonical parameters in public key order', () => {
    const parsed = parseAssetLibraryQuery({
      view: 'list',
      extension: 'png',
      type: ['images', 'comic'],
      category: 'source',
      project: ['12', '7'],
      page: '2',
    });
    const url = buildAssetLibraryUrl(parsed);
    expect(url).toBe('/asset-viewer?project=7&project=12&type=comic&type=images&category=source&extension=png&page=2&view=list');
    const params = new URL(`http://localhost${url}`).searchParams;
    expect(params.getAll('project')).toEqual(['7', '12']);
    expect(params.getAll('type')).toEqual(['comic', 'images']);
    expect(url).not.toContain('%2C');
    expect(url).not.toContain('7,12');
    // Parameter order in the request does not change the canonical URL.
    expect(buildAssetLibraryUrl(parseAssetLibraryQuery({
      page: '2', project: ['7', '12'], extension: 'png', view: 'list', category: 'source', type: ['comic', 'images'],
    }))).toBe(url);
  });

  it('retains Project and Type selections through sort, page, size and view changes', () => {
    const parsed = parseAssetLibraryQuery({ project: ['3', '1'], type: ['comic', 'animation'] });
    const prefix = '/asset-viewer?project=1&project=3&type=animation&type=comic';
    expect(buildAssetLibraryUrl(parsed, { page: 4 })).toBe(`${prefix}&page=4`);
    expect(buildAssetLibraryUrl(parsed, { sort: 'size', order: 'desc' })).toBe(`${prefix}&sort=size&order=desc`);
    expect(buildAssetLibraryUrl(parsed, { pageSize: 'all' })).toBe(`${prefix}&pageSize=all`);
    expect(buildAssetLibraryUrl(parsed, { view: 'list' })).toBe(`${prefix}&view=list`);
    expect(buildAssetLibraryUrl(parsed, { search: 'cover' })).toBe(`${prefix}&search=cover`);
    expect(buildAssetLibraryUrl(parsed, { categories: ['source'] })).toBe(`${prefix}&category=source`);
  });

  it('accepts array, legacy scalar and clearing overrides without mutating state', () => {
    const parsed = parseAssetLibraryQuery({ project: ['3', '1'], type: 'comic' });
    const original = structuredClone(parsed);

    expect(buildAssetLibraryUrl(parsed, { projectIds: [9, 2, 9] })).toBe('/asset-viewer?project=2&project=9&type=comic');
    expect(buildAssetLibraryUrl(parsed, { projectId: 5 })).toBe('/asset-viewer?project=5&type=comic');
    expect(buildAssetLibraryUrl(parsed, { project: 6 })).toBe('/asset-viewer?project=6&type=comic');
    expect(buildAssetLibraryUrl(parsed, { projectIds: [] })).toBe('/asset-viewer?type=comic');
    expect(buildAssetLibraryUrl(parsed, { projectId: null })).toBe('/asset-viewer?type=comic');
    expect(buildAssetLibraryUrl(parsed, { projectTypes: [] })).toBe('/asset-viewer?project=1&project=3');
    expect(buildAssetLibraryUrl(parsed, { type: ['images', 'Bad'] })).toBe('/asset-viewer?project=1&project=3&type=images');
    expect(parsed).toEqual(original);
  });

  it('keeps legacy scalar state callers compatible', () => {
    expect(buildAssetLibraryUrl({ projectId: 9 })).toBe('/asset-viewer?project=9');
    expect(buildAssetLibraryUrl({ project: 9 })).toBe('/asset-viewer?project=9');
    expect(buildAssetLibraryUrl({ projectId: '0' })).toBe('/asset-viewer');
    expect(buildAssetLibraryUrl({}, { presence: 'missing' })).toBe('/asset-viewer?presence=missing');
  });
});
