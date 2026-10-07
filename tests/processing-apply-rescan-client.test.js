import { afterEach, describe, expect, it, vi } from 'vitest';
import { rescanProjectAssetsAfterApply } from '../src/static/processing.js';

function response(payload, ok = true) {
  return { ok, json: vi.fn(async () => payload) };
}

describe('Processing Apply project asset rescan', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts one normal project scan and then refreshes the current asset browser', async () => {
    const fetch = vi.fn(async () => response({ ok: true, scan: { added: 1 } }));
    const refreshAssets = vi.fn(() => true);
    const document = {};
    vi.stubGlobal('fetch', fetch);

    await rescanProjectAssetsAfterApply({
      dataset: { projectId: '9', csrf: 'csrf-token' },
      ownerDocument: document,
    }, { refreshAssets });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/projects/9/scan', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: expect.objectContaining({ Accept: 'application/json', 'X-CSRF-Token': 'csrf-token' }),
    }));
    // The automatic refresh identifies itself so it never counts as the
    // manual scan that clears a processing recovery gate.
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ trigger: 'processing-refresh' });
    expect(refreshAssets).toHaveBeenCalledTimes(1);
    expect(refreshAssets).toHaveBeenCalledWith(document);
  });

  it('does not refresh the browser when the project scan fails', async () => {
    const fetch = vi.fn(async () => response({ ok: false, error: { message: 'Scan failed.' } }, false));
    const refreshAssets = vi.fn(() => true);
    vi.stubGlobal('fetch', fetch);

    await expect(rescanProjectAssetsAfterApply({
      dataset: { projectId: '9', csrf: 'csrf-token' },
      ownerDocument: {},
    }, { refreshAssets })).rejects.toThrow('Scan failed.');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(refreshAssets).not.toHaveBeenCalled();
  });
});
