import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enhanceGeneratedImageRebuildStatus } from '../src/static/client/generated-image-rebuild-status.js';
import { presentGeneratedImageRebuild } from '../src/static/client/generated-image-rebuild-presenter.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(phase = 'idle') {
  const events = new Map();
  const windowEvents = new Map();
  const nodes = {
    '[data-rebuild-message]': { textContent: '' },
    '[data-rebuild-details]': { textContent: '', hidden: true },
    '[data-rebuild-action-error]': { textContent: '', hidden: true },
    '[data-generated-images-rebuild-button]': { disabled: false },
  };
  const card = {
    dataset: { rebuildPhase: phase, rebuildRunId: phase === 'idle' ? '' : 'initial' },
    querySelector: (selector) => nodes[selector] || null,
  };
  const window = {
    setTimeout, clearTimeout,
    addEventListener: (name, handler) => windowEvents.set(name, handler),
  };
  const document = {
    defaultView: window,
    location: { href: 'http://localhost/settings/defaults' },
    querySelector: (selector) => selector === '[data-generated-images-rebuild]' ? card : null,
    addEventListener: (name, handler) => events.set(name, handler),
  };
  return {
    document, card, nodes,
    submit(form) {
      let prevented = false;
      events.get('submit')({ target: form, preventDefault() { prevented = true; } });
      return prevented;
    },
    hide: () => windowEvents.get('pagehide')(),
  };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('generated-image rebuild Settings client', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses checked counts that include rebuilt, skipped, and failed assets', () => {
    expect(presentGeneratedImageRebuild({ phase: 'running', total: 10,
      succeeded: 3, skipped: 2, failed: 1 }).details)
      .toBe('6 of 10 checked · 3 rebuilt · 2 skipped · 1 failed');
  });

  it('polls queued and running states every two seconds and stops on completion', async () => {
    const ui = fixture('queued');
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ phase: 'running', runId: 'one',
        total: 10, succeeded: 3, skipped: 2, failed: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ phase: 'completed', runId: 'one',
        total: 10, succeeded: 7, skipped: 2, failed: 1 }) });
    vi.stubGlobal('fetch', fetch);
    enhanceGeneratedImageRebuildStatus(ui.document);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ui.nodes['[data-rebuild-message]'].textContent).toContain('Rebuilding generated images');
    expect(ui.nodes['[data-rebuild-details]'].textContent).toContain('6 of 10 checked');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ui.nodes['[data-rebuild-message]'].textContent).toBe('Rebuild complete.');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    ui.hide();
  });

  it('cancels active polling on page unload', async () => {
    const ui = fixture('queued');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    enhanceGeneratedImageRebuildStatus(ui.document);
    ui.hide();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes immediately after an image save and rejects an older in-flight status', async () => {
    const ui = fixture('running');
    const old = deferred();
    const current = deferred();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise));
    const controller = enhanceGeneratedImageRebuildStatus(ui.document);
    await vi.advanceTimersByTimeAsync(2_000);
    controller.imageSaveStarted();
    controller.imageSaveSucceeded();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    current.resolve({ ok: true, json: async () => ({ phase: 'running', runId: 'run-85', total: 1,
      succeeded: 0, skipped: 0, failed: 0 }) });
    await flush();
    old.resolve({ ok: true, json: async () => ({ phase: 'completed', runId: 'run-70', total: 1,
      succeeded: 1, skipped: 0, failed: 0 }) });
    await flush();
    expect(ui.card.dataset.rebuildRunId).toBe('run-85');
    expect(ui.card.dataset.rebuildPhase).toBe('running');
    ui.hide();
  });

  it('queues one manual POST at a time, acknowledges it in the card, and refreshes status', async () => {
    const ui = fixture();
    const post = deferred();
    const status = deferred();
    const fetch = vi.fn().mockReturnValueOnce(post.promise).mockReturnValueOnce(status.promise);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('FormData', class { constructor() {} *[Symbol.iterator]() { yield ['_csrf', 'token']; } });
    const form = { id: 'generated-images-rebuild-form', action: 'http://localhost/settings/defaults/generated-images/rebuild' };
    enhanceGeneratedImageRebuildStatus(ui.document);
    expect(ui.submit(form)).toBe(true);
    ui.submit(form);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ui.nodes['[data-generated-images-rebuild-button]'].disabled).toBe(true);
    post.resolve({ ok: true, redirected: true,
      url: 'http://localhost/settings/defaults?notice=generated_images_rebuild_queued' });
    await flush();
    expect(ui.nodes['[data-rebuild-message]'].textContent).toContain('Rebuild queued.');
    expect(ui.nodes['[data-generated-images-rebuild-button]'].disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    status.resolve({ ok: true, json: async () => ({ phase: 'running', runId: 'manual-run', total: 2 }) });
    await flush();
    expect(ui.card.dataset.rebuildRunId).toBe('manual-run');
    ui.hide();
  });

  it('shows an action error without claiming a rebuild was queued', async () => {
    const ui = fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, redirected: false,
      url: 'http://localhost/settings/defaults/generated-images/rebuild' }));
    vi.stubGlobal('FormData', class { constructor() {} *[Symbol.iterator]() { yield ['_csrf', 'token']; } });
    enhanceGeneratedImageRebuildStatus(ui.document);
    ui.submit({ id: 'generated-images-rebuild-form', action: '/settings/defaults/generated-images/rebuild' });
    await flush();
    expect(ui.card.dataset.rebuildPhase).toBe('idle');
    expect(ui.nodes['[data-rebuild-action-error]'].textContent).toContain('Could not queue');
    expect(ui.nodes['[data-rebuild-action-error]'].hidden).toBe(false);
    expect(ui.nodes['[data-generated-images-rebuild-button]'].disabled).toBe(false);
    ui.hide();
  });

  it('shows a manual action error on the current card after another Settings save re-rendered it', async () => {
    const ui = fixture();
    const post = deferred();
    const fetch = vi.fn().mockReturnValueOnce(post.promise);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('FormData', class { constructor() {} *[Symbol.iterator]() { yield ['_csrf', 'token']; } });
    enhanceGeneratedImageRebuildStatus(ui.document);
    ui.submit({ id: 'generated-images-rebuild-form', action: '/settings/defaults/generated-images/rebuild' });
    const staleNodes = ui.nodes;
    const replacement = fixture();
    ui.document.querySelector = replacement.document.querySelector;
    const controller = enhanceGeneratedImageRebuildStatus({ ownerDocument: ui.document });
    controller.imageSaveStarted();
    post.resolve({ ok: false, redirected: false,
      url: 'http://localhost/settings/defaults/generated-images/rebuild' });
    await flush();
    expect(replacement.nodes['[data-rebuild-action-error]'].textContent).toContain('Could not queue');
    expect(replacement.nodes['[data-rebuild-action-error]'].hidden).toBe(false);
    expect(staleNodes['[data-rebuild-action-error]'].textContent).toBe('');
    expect(replacement.card.dataset.rebuildPhase).toBe('idle');
    expect(replacement.nodes['[data-rebuild-message]'].textContent).toBe('');
    expect(replacement.nodes['[data-generated-images-rebuild-button]'].disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    ui.hide();
  });

  it('keeps the phase message live-updated while progress details update separately', async () => {
    const ui = fixture('running');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ phase: 'running', runId: 'one',
        total: 300, succeeded: 12, skipped: 0, failed: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ phase: 'running', runId: 'one',
        total: 300, succeeded: 13, skipped: 0, failed: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ phase: 'completed_with_failures', runId: 'one',
        total: 300, succeeded: 298, skipped: 0, failed: 2 }) }));
    enhanceGeneratedImageRebuildStatus(ui.document);
    await vi.advanceTimersByTimeAsync(2_000);
    const message = ui.nodes['[data-rebuild-message]'].textContent;
    expect(message).not.toContain('checked');
    expect(ui.nodes['[data-rebuild-details]'].textContent).toContain('12 of 300 checked');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ui.nodes['[data-rebuild-message]'].textContent).toBe(message);
    expect(ui.nodes['[data-rebuild-details]'].textContent).toContain('13 of 300 checked');
    expect(ui.nodes['[data-rebuild-details]'].hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ui.nodes['[data-rebuild-message]'].textContent).toContain('some images could not be rebuilt');
    expect(ui.nodes['[data-rebuild-details]'].textContent).toContain('300 of 300 checked');
    ui.hide();
  });
});
