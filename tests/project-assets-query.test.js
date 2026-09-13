import { describe, expect, it } from 'vitest';
import { resolveAssetBrowserPresentation } from '../src/routes/project-assets-shared.js';

function createPageDefaultsService({ fallback = '25', saved = '50' } = {}) {
  return {
    getFallback: (_page, option) => option === 'pageSize' ? fallback : ({ view: 'grid', sort: 'filename', order: 'asc' })[option],
    resolve: (_page, option) => option === 'pageSize' ? saved : ({ view: 'grid', sort: 'filename', order: 'asc' })[option],
  };
}

describe('Project Assets query presentation', () => {
  it('preserves explicit all as the page-size contract value', () => {
    const presentation = resolveAssetBrowserPresentation(
      { pageSize: 'all' },
      createPageDefaultsService(),
    );

    expect(presentation.query.pageSize).toBe('all');
    expect(presentation.saved.pageSize).toBe('50');
  });

  it('preserves existing finite, malformed, and omitted page-size behavior', () => {
    const pageDefaultsService = createPageDefaultsService();

    expect(resolveAssetBrowserPresentation({ pageSize: '10' }, pageDefaultsService).query.pageSize).toBe('10');
    expect(resolveAssetBrowserPresentation({ pageSize: '1junk' }, pageDefaultsService).query.pageSize).toBe('1junk');
    expect(resolveAssetBrowserPresentation({}, pageDefaultsService).query.pageSize).toBe('50');
  });

  it('preserves saved all while explicit finite values still take precedence', () => {
    const pageDefaultsService = createPageDefaultsService({ saved: 'all' });

    expect(resolveAssetBrowserPresentation({}, pageDefaultsService).query.pageSize).toBe('all');
    expect(resolveAssetBrowserPresentation({ pageSize: '150' }, pageDefaultsService).query.pageSize).toBe('150');
    expect(resolveAssetBrowserPresentation({ pageSize: '200' }, pageDefaultsService).query.pageSize).toBe('200');
  });
});
