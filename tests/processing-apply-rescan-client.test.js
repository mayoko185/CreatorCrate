import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshAssetsFromResult, rescanProjectAssetsAfterApply } from '../src/static/processing.js';

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

  it('T18: resolves after the one scan with the GET installation, without waiting for it', async () => {
    const fetch = vi.fn(async () => response({ ok: true, scan: { added: 1 } }));
    let install;
    const installation = new Promise((resolve) => { install = resolve; });
    const refreshAssets = vi.fn(() => installation);
    vi.stubGlobal('fetch', fetch);

    const rescan = await rescanProjectAssetsAfterApply({
      dataset: { projectId: '9', csrf: 'csrf-token' },
      ownerDocument: {},
    }, { refreshAssets });

    expect(fetch).toHaveBeenCalledTimes(1);
    install({ status: 'installed', url: null });
    await expect(rescan.installation).resolves.toEqual({ status: 'installed', url: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects when no Project Assets refresh can start', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ok: true })));
    await expect(rescanProjectAssetsAfterApply({
      dataset: { projectId: '9', csrf: 'csrf-token' },
      ownerDocument: {},
    }, { refreshAssets: () => null })).rejects.toThrow('Could not refresh the asset browser.');
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

// ─── WP12B: a result's Refresh assets ─────────────────────────────────────

function element() {
  const attributes = new Map();
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
  };
}

// A rendered Processing result: its summary, output names and settings stay put.
function resultRoot(operation) {
  const button = element();
  const feedback = element();
  feedback.hidden = true;
  const summary = element();
  summary.textContent = `${operation} summary`;
  const outputs = element();
  outputs.textContent = 'wp12b-set.zip — ZIP container, 3 entries, quality 90.';
  const setting = element();
  setting.value = 'webp';
  const nodes = {
    '[data-processing-refresh]': button,
    '[data-processing-refresh-status]': feedback,
    '[data-processing-result-body] p': summary,
    '[data-processing-result-body] li': outputs,
    '[data-processing-setting]': setting,
  };
  const ownerDocument = { nodeType: 9 };
  return {
    root: {
      dataset: { projectId: '9', csrf: 'csrf-token', processingOperation: operation },
      ownerDocument,
      querySelector: (selector) => nodes[selector] || null,
    },
    button,
    feedback,
    summary,
    outputs,
    setting,
    ownerDocument,
  };
}

function deferredRefresh() {
  const calls = [];
  const refreshAssets = vi.fn((document, options) => {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    calls.push({ document, options, resolve });
    return promise;
  });
  return { calls, refreshAssets };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe('Processing result Refresh assets (WP12B)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['rename', 'convert', 'workflow-prompt', 'watermark', 'archive'])(
    'T1–T7 %s: refreshes through one WP09A GET and keeps the result, outputs and settings',
    async (operation) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const page = resultRoot(operation);
      const { calls, refreshAssets } = deferredRefresh();

      const refresh = refreshAssetsFromResult(page.root, { refreshAssets });
      await flush();
      expect(refreshAssets).toHaveBeenCalledTimes(1);
      expect(calls[0].document).toBe(page.ownerDocument);

      calls[0].resolve({ status: 'installed', url: null, reconciliation: {} });
      await expect(refresh).resolves.toMatchObject({ status: 'installed' });
      expect(page.feedback.textContent).toBe('Assets refreshed.');
      expect(page.summary.textContent).toBe(`${operation} summary`);
      expect(page.outputs.textContent).toContain('wp12b-set.zip');
      expect(page.setting.value).toBe('webp');
      // T19: the refresh itself never posts Apply, a job or a scan.
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('T11/T12: shows pending until the region installs, then reports refreshed', async () => {
    const page = resultRoot('convert');
    const { calls, refreshAssets } = deferredRefresh();

    const refresh = refreshAssetsFromResult(page.root, { refreshAssets });
    await flush();
    expect(page.feedback).toMatchObject({ hidden: false, textContent: 'Refreshing assets…' });
    expect(page.feedback.getAttribute('data-state')).toBe('pending');
    expect(page.button.disabled).toBe(true);
    expect(page.button.getAttribute('aria-busy')).toBe('true');

    calls[0].resolve({ status: 'installed', url: null });
    await refresh;
    expect(page.feedback.textContent).toBe('Assets refreshed.');
    expect(page.button.disabled).toBe(false);
    expect(page.button.getAttribute('aria-busy')).toBe(null);
  });

  it('T13/T14: a failed GET keeps the result and a later GET-only Retry reports refreshed', async () => {
    const page = resultRoot('watermark');
    const { calls, refreshAssets } = deferredRefresh();

    const refresh = refreshAssetsFromResult(page.root, { refreshAssets });
    await flush();
    calls[0].resolve({ status: 'failed', url: null });
    await refresh;
    expect(page.feedback.textContent).toBe('Assets could not be refreshed. This result is unchanged. Use Retry to try again.');
    expect(page.feedback.getAttribute('data-state')).toBe('failed');
    expect(page.summary.textContent).toBe('watermark summary');
    expect(page.button.disabled).toBe(false);
    expect(page.button.textContent).toBe('Retry');

    // WP09A's shared Retry is a GET; its install recovers this refresh.
    calls[0].options.onRecovered({ selection: {}, order: {} });
    expect(page.feedback.textContent).toBe('Assets refreshed.');
    expect(page.button.textContent).toBe('Refresh assets');
    expect(refreshAssets).toHaveBeenCalledTimes(1);
  });

  it('T14: the result Retry is the same GET refresh, never Apply, a job or a scan', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const page = resultRoot('archive');
    const { calls, refreshAssets } = deferredRefresh();

    const failed = refreshAssetsFromResult(page.root, { refreshAssets });
    await flush();
    calls[0].resolve({ status: 'failed', url: null });
    await failed;
    expect(page.button.textContent).toBe('Retry');

    const retry = refreshAssetsFromResult(page.root, { refreshAssets });
    await flush();
    expect(page.feedback.textContent).toBe('Refreshing assets…');
    expect(page.button.textContent).toBe('Refresh assets');
    calls[1].resolve({ status: 'installed', url: null });
    await retry;
    expect(page.feedback.textContent).toBe('Assets refreshed.');
    // The failed attempt's late recovery no longer owns the report.
    calls[0].options.onRecovered({});
    expect(page.feedback.textContent).toBe('Assets refreshed.');
    expect(refreshAssets).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('T15: repeated clicks while pending join one refresh', async () => {
    const page = resultRoot('archive');
    const { calls, refreshAssets } = deferredRefresh();

    const first = refreshAssetsFromResult(page.root, { refreshAssets });
    expect(refreshAssetsFromResult(page.root, { refreshAssets })).toBe(first);
    expect(refreshAssetsFromResult(page.root, { refreshAssets })).toBe(first);
    await flush();
    expect(refreshAssets).toHaveBeenCalledTimes(1);
    calls[0].resolve({ status: 'installed', url: null });
    await first;

    void refreshAssetsFromResult(page.root, { refreshAssets });
    await flush();
    expect(refreshAssets).toHaveBeenCalledTimes(2);
  });

  it('T16: a superseded refresh never claims installation until a newer load installs it', async () => {
    const page = resultRoot('rename');
    const { calls, refreshAssets } = deferredRefresh();

    const refresh = refreshAssetsFromResult(page.root, { refreshAssets });
    await flush();
    calls[0].resolve({ status: 'superseded', url: null });
    await refresh;
    expect(page.feedback.textContent).toBe('A newer asset view is loading. Assets update when it finishes.');
    expect(page.feedback.textContent).not.toContain('refreshed');

    calls[0].options.onRecovered({});
    expect(page.feedback.textContent).toBe('Assets refreshed.');
  });

  it('reports an unavailable refresh truthfully', async () => {
    const page = resultRoot('convert');
    await refreshAssetsFromResult(page.root, {
      refreshAssets: async () => ({ status: 'unavailable', url: null }),
    });
    expect(page.feedback.textContent).toBe('Assets could not be refreshed on this page. Reload the page to see current assets.');
    expect(page.button.disabled).toBe(false);
  });
});
