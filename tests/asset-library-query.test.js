import { describe, expect, it } from 'vitest';
import {
  ASSET_LIBRARY_PAGE_SIZE_VALUES,
  buildAssetLibraryUrl,
  hasAssetLibraryQuery,
  isBareAssetLibraryRequest,
  parseAssetLibraryQuery,
} from '../src/routes/asset-library-query.js';

describe('Asset Viewer query foundation', () => {
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

  it('accepts positive pages and only the finite page-size allowlist', () => {
    expect(parseAssetLibraryQuery({ page: '7' }).page).toBe(7);
    expect(parseAssetLibraryQuery({ page: '0' }).page).toBe(1);
    expect(parseAssetLibraryQuery({ page: '-1' }).page).toBe(1);
    expect(parseAssetLibraryQuery({ page: '01' }).page).toBe(1);
    expect(parseAssetLibraryQuery({ page: '1.5' }).page).toBe(1);
    expect(parseAssetLibraryQuery({ page: '1e2' }).page).toBe(1);

    expect(parseAssetLibraryQuery({ pageSize: '50' }).pageSize).toBe(50);
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
      '/assets?project=12&category=source-files&tag=42&search=A%26B+%2F+r%C3%A9sum%C3%A9&extension=png&presence=missing&usage=used&sort=project&order=desc&page=3&pageSize=50&view=list',
    );

    expect(buildAssetLibraryUrl(parseAssetLibraryQuery({
      category: 'all',
      search: '  ',
      presence: 'all',
      usage: 'all',
      page: '1',
    }))).toBe('/assets');
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
      '/assets?category=final&category=krz&tag=1&tag=2&extension=krz&extension=png&sort=project&order=desc&page=2&pageSize=10&view=list',
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
      '/assets?category=final&category=krz&tag=1&tag=2&extension=krz&extension=png&sort=project&order=desc&page=2&pageSize=50&view=list',
    );
  });

  it('preserves explicit valid fallback presentation values for future defaults', () => {
    const parsed = parseAssetLibraryQuery({
      view: 'grid',
      sort: 'filename',
      order: 'asc',
      pageSize: '25',
    });

    expect(buildAssetLibraryUrl(parsed)).toBe('/assets?sort=filename&order=asc&pageSize=25&view=grid');
    expect(buildAssetLibraryUrl(parseAssetLibraryQuery({
      view: 'invalid',
      sort: 'invalid',
      order: 'invalid',
      pageSize: '20',
    }))).toBe('/assets');
  });

  it('omits null, malformed, and unsafe tag values from generated URLs', () => {
    const state = parseAssetLibraryQuery({ tag: '42', search: 'keep' });

    expect(buildAssetLibraryUrl(state, { tag: null })).toBe('/assets?search=keep');
    expect(buildAssetLibraryUrl(state, { tag: '42junk' })).toBe('/assets?search=keep');
    expect(buildAssetLibraryUrl({ tag: '9007199254740992' })).toBe('/assets');
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

    expect(buildAssetLibraryUrl(state)).toBe('/assets?sort=filename');
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
    })).toBe('/assets?project=4&sort=filename&page=2&pageSize=50&view=grid');
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

    expect(url).toBe('/assets?project=9&search=two');
    expect(new URL(`http://localhost${url}`).searchParams.getAll('project')).toEqual(['9']);
    expect(new URL(`http://localhost${url}`).searchParams.getAll('search')).toEqual(['two']);
  });
});
