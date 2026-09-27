/**
 * PM-1C2B — Project Detail ownership recovery client: one detailed status
 * request per explicit open, confirmation before POST carrying the displayed
 * statusVersion, no automatic retry, and no token in the rendered UI.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  enhanceProjectOwnershipRecovery,
  PROJECT_OWNERSHIP_REPLACEMENT_WARNING,
} from '../src/static/client/project-ownership-recovery.js';

const VERSION_A = 'a'.repeat(32);
const VERSION_B = 'b'.repeat(32);
const FOREIGN_TOKEN = 'f'.repeat(64);

function element(tag = 'div', attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  const listeners = new Map();
  const node = {
    tag, children: [], parent: null, dataset: {}, disabled: false, textContent: '', className: '', value: '',
    hidden: attrs.has('hidden'),
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute(name, value = '') { attrs.set(name, String(value)); if (name === 'hidden') node.hidden = true; },
    removeAttribute(name) { attrs.delete(name); if (name === 'hidden') node.hidden = false; },
    hasAttribute: (name) => attrs.has(name),
    addEventListener: (type, handler) => listeners.set(type, [...(listeners.get(type) || []), handler]),
    click() { (listeners.get('click') || []).forEach((handler) => handler({ preventDefault() {} })); },
    append(...children) { children.forEach((child) => { child.parent = node; node.children.push(child); }); },
    replaceChildren(...children) { node.children = []; node.append(...children); },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); node.parent = null; },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const name = selector.match(/^\[([^\]=]+)\]$/)?.[1];
      const found = [];
      const walk = (current) => current.children.forEach((child) => {
        if (name && child.hasAttribute(name)) found.push(child);
        walk(child);
      });
      walk(node);
      return found;
    },
    get text() {
      return [node.textContent, ...node.children.map((child) => child.text)].join(' ');
    },
  };
  return node;
}

function page({ notice = 'attention' } = {}) {
  const root = element('body');
  const noticeNode = element('div', { 'data-project-ownership-notice': notice });
  const open = element('button', { 'data-project-ownership-open': '' });
  noticeNode.append(open);
  const dialog = element('dialog', { id: 'project-ownership-dialog' });
  const body = element('div', {
    'data-project-ownership-dialog': '', 'data-project-id': '7', 'data-project-title': 'Moonlight',
  });
  const csrf = element('input', { 'data-project-ownership-csrf': '' });
  csrf.value = 'csrf-token';
  body.append(csrf, element('div', { 'data-project-ownership-summary': '' }), element('div', { 'data-project-ownership-status': '' }));
  const buttons = {};
  for (const name of ['recover', 'check']) {
    buttons[name] = element('button', { [`data-project-ownership-${name}`]: '', hidden: '' });
    body.append(buttons[name]);
  }
  dialog.append(body);
  root.append(noticeNode, dialog);
  const document = {
    nodeType: 9,
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    getElementById: (id) => (id === 'project-ownership-dialog' ? dialog : null),
    createElement: (tag) => element(tag),
  };
  const node = (name) => body.querySelector(`[data-project-ownership-${name}]`);
  return {
    document, root, open, buttons, dialog, body,
    summary: () => node('summary').text,
    status: () => node('status').textContent,
    notice: () => root.querySelector('[data-project-ownership-notice]'),
  };
}

const json = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const recoverStatus = (overrides = {}) => ({
  projectId: 7, action: 'recover', reason: 'manifest-missing', plan: 'create-marker', binding: null,
  marker: 'missing', classification: { status: 'recovery-required', reason: 'manifest-missing' },
  statusVersion: VERSION_A, ...overrides,
});
const healthy = { projectId: 7, action: 'none', reason: 'bound', plan: null, binding: 'bound', marker: 'matching',
  classification: null, statusVersion: VERSION_B };

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(responses, { confirm = vi.fn(async () => true), notice } = {}) {
  const ui = page({ notice });
  const fetch = vi.fn();
  responses.forEach((response) => fetch.mockResolvedValueOnce(response));
  const openDialog = vi.fn(() => true);
  const closeDialog = vi.fn(() => true);
  const controller = enhanceProjectOwnershipRecovery(ui.document, { fetch, openDialog, closeDialog, confirm });
  return { ui, fetch, openDialog, closeDialog, confirm, controller };
}

const posts = (fetch) => fetch.mock.calls.filter(([, options]) => options?.method === 'POST');

describe('project ownership recovery client', () => {
  it('does nothing until the operator opens the dialog, then requests status exactly once', async () => {
    const { ui, fetch, openDialog } = setup([json(200, { status: 'success', recovery: recoverStatus() })]);
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    ui.open.click();
    await flush();
    expect(openDialog).toHaveBeenCalledWith(ui.document, 'project-ownership-dialog', ui.open);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/projects/7/ownership-recovery');
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
    expect(ui.buttons.recover.hidden).toBe(false);
    expect(ui.summary()).toContain('Recovering confirms');
    expect(ui.summary()).not.toContain(PROJECT_OWNERSHIP_REPLACEMENT_WARNING);
  });

  it('shows no Recover action for retry-later and does not frame it as a conflict', async () => {
    const { ui, fetch } = setup([json(200, { status: 'success',
      recovery: { ...recoverStatus(), action: 'retry-later', reason: 'project-directory-unavailable', plan: null } })]);
    ui.open.click();
    await flush();
    expect(ui.buttons.recover.hidden).toBe(true);
    expect(ui.buttons.check.hidden).toBe(false);
    expect(ui.summary()).toContain('temporarily unavailable');
    expect(ui.summary()).toContain('retry automatically');
    expect(ui.summary()).not.toMatch(/another|conflict|belongs/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows the blocked explanation with no Recover or force action and no token', async () => {
    const { ui, fetch } = setup([json(200, { status: 'success', recovery: {
      ...recoverStatus(), action: 'blocked', reason: 'marker-token-in-use', plan: null, marker: 'owned-by-another-project',
    } })]);
    ui.open.click();
    await flush();
    expect(ui.buttons.recover.hidden).toBe(true);
    expect(ui.summary()).toContain('another CreatorCrate project');
    expect(ui.summary()).not.toMatch(/force/i);
    expect(ui.root.text).not.toContain(FOREIGN_TOKEN);
    expect(posts(fetch)).toHaveLength(0);
  });

  it('shows no recovery action for a healthy status and removes the stale notice', async () => {
    const { ui, fetch, confirm } = setup([json(200, { status: 'success', recovery: healthy })]);
    ui.open.click();
    await flush();
    expect(ui.buttons.recover.hidden).toBe(true);
    expect(ui.buttons.check.hidden).toBe(true);
    expect(ui.body.querySelector('[data-project-ownership-clear]')).toBeNull();
    expect(ui.notice()).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(0);
  });

  it('treats action none with a leftover classification as healthy: no action, no POST', async () => {
    const stale = { ...healthy, classification: { status: 'recovery-required', reason: 'manifest-missing' } };
    const { ui, fetch, confirm, controller } = setup([json(200, { status: 'success', recovery: stale })]);
    expect(ui.notice().getAttribute('data-project-ownership-notice')).toBe('attention');
    ui.open.click();
    await flush();
    expect(ui.notice()).toBeNull();
    expect(ui.buttons.recover.hidden).toBe(true);
    expect(ui.buttons.check.hidden).toBe(true);
    // Even a direct recover() call offers nothing for `none`.
    await controller.recover(ui.buttons.recover);
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('when a fresh check returns none the stale notice disappears without confirmation or POST', async () => {
    const stale = { ...healthy, classification: { status: 'recovery-required', reason: 'manifest-missing' } };
    const { ui, fetch, confirm } = setup([
      json(200, { status: 'success', recovery: { ...recoverStatus(), action: 'retry-later',
        reason: 'project-directory-unavailable', plan: null } }),
      json(200, { status: 'success', recovery: stale }),
    ]);
    ui.open.click();
    await flush();
    expect(ui.notice()).not.toBeNull();
    ui.buttons.check.click();
    await flush();
    expect(ui.notice()).toBeNull();
    expect(ui.buttons.recover.hidden).toBe(true);
    expect(ui.buttons.check.hidden).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(posts(fetch)).toHaveLength(0);
  });

  it('when a stale confirmation finds the project now healthy it removes the notice and asks nothing more', async () => {
    const { ui, fetch, confirm } = setup([
      json(200, { status: 'success', recovery: recoverStatus() }),
      json(409, { status: 'error', code: 'RECOVERY_STATE_CHANGED',
        recovery: { ...healthy, classification: { status: 'recovery-required', reason: 'manifest-missing' } } }),
    ]);
    ui.open.click();
    await flush();
    ui.buttons.recover.click();
    await flush();
    expect(posts(fetch)).toHaveLength(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ui.notice()).toBeNull();
    expect(ui.buttons.recover.hidden).toBe(true);
    expect(ui.status()).toBe('');
  });

  it('requires confirmation and POSTs the displayed statusVersion only once confirmed', async () => {
    const confirm = vi.fn(async () => false);
    const { ui, fetch } = setup([json(200, { status: 'success', recovery: recoverStatus() })], { confirm });
    ui.open.click();
    await flush();
    ui.buttons.recover.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    const [, request] = confirm.mock.calls[0];
    expect(request.message).toContain('currently stored folder belongs to “Moonlight”');
    expect(request.message).toContain('will not import legacy project metadata');
    expect(request.message).not.toContain(PROJECT_OWNERSHIP_REPLACEMENT_WARNING);
    expect(posts(fetch)).toHaveLength(0);
  });

  it('warns about marker replacement in the dialog and the confirmation', async () => {
    const confirm = vi.fn(async () => false);
    const { ui } = setup([json(200, { status: 'success',
      recovery: recoverStatus({ plan: 'replace-marker', marker: 'malformed' }) })], { confirm });
    ui.open.click();
    await flush();
    expect(ui.summary()).toContain(PROJECT_OWNERSHIP_REPLACEMENT_WARNING);
    ui.buttons.recover.click();
    await flush();
    expect(confirm.mock.calls[0][1].message).toContain(PROJECT_OWNERSHIP_REPLACEMENT_WARNING);
  });

  it('on success closes the dialog and replaces the warning with a healthy notice', async () => {
    const { ui, fetch, closeDialog } = setup([
      json(200, { status: 'success', recovery: recoverStatus() }),
      json(200, { status: 'success', outcome: 'recovered', recovery: healthy }),
    ]);
    ui.open.click();
    await flush();
    ui.buttons.recover.click();
    await flush();
    const [[url, options]] = posts(fetch);
    expect(url).toBe('/projects/7/ownership-recovery');
    expect(options.headers.Accept).toBe('application/json');
    const body = new URLSearchParams(options.body);
    expect(body.get('statusVersion')).toBe(VERSION_A);
    expect(body.get('_csrf')).toBe('csrf-token');
    expect(closeDialog).toHaveBeenCalledWith(ui.document, 'project-ownership-dialog');
    expect(ui.notice().getAttribute('data-project-ownership-notice')).toBe('resolved');
    expect(ui.notice().text).toContain('recovered');
    expect(ui.notice().querySelector('[data-project-ownership-open]')).toBeNull();
  });

  it('on a stale confirmation shows the fresh state and requires a new confirmation', async () => {
    const confirm = vi.fn(async () => true);
    const fresh = recoverStatus({ plan: 'replace-marker', marker: 'malformed', statusVersion: VERSION_B });
    const { ui, fetch } = setup([
      json(200, { status: 'success', recovery: recoverStatus() }),
      json(409, { status: 'error', code: 'RECOVERY_STATE_CHANGED', recovery: fresh }),
    ], { confirm });
    ui.open.click();
    await flush();
    ui.buttons.recover.click();
    await flush();
    expect(posts(fetch)).toHaveLength(1);
    expect(ui.status()).toContain('confirm again');
    expect(ui.summary()).toContain(PROJECT_OWNERSHIP_REPLACEMENT_WARNING);
    expect(ui.buttons.recover.hidden).toBe(false);
    expect(ui.notice()).not.toBeNull();

    // Nothing further happens by itself; the next attempt asks again and
    // carries the version now on screen.
    await flush();
    expect(posts(fetch)).toHaveLength(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(json(200, { status: 'success', outcome: 'recovered', recovery: healthy }));
    ui.buttons.recover.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(posts(fetch)[1][1].body).get('statusVersion')).toBe(VERSION_B);
  });

  it('on RECOVERY_UNAVAILABLE shows retry-later, hides Recover, keeps the notice, and never re-posts', async () => {
    vi.useFakeTimers();
    try {
      const { ui, fetch } = setup([
        json(200, { status: 'success', recovery: recoverStatus() }),
        json(503, { status: 'error', code: 'RECOVERY_UNAVAILABLE', reason: 'project-directory-unavailable',
          recovery: recoverStatus() }),
      ]);
      ui.open.click();
      await flush();
      ui.buttons.recover.click();
      await flush();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(posts(fetch)).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(ui.summary()).toContain('temporarily unavailable');
      expect(ui.summary()).not.toMatch(/another|conflict/i);
      expect(ui.buttons.recover.hidden).toBe(true);
      expect(ui.buttons.check.hidden).toBe(false);
      expect(ui.buttons.check.disabled).toBe(false);
      expect(ui.notice().getAttribute('data-project-ownership-notice')).toBe('attention');

      // "Check again" only re-reads status; it never recovers.
      fetch.mockResolvedValueOnce(json(200, { status: 'success', recovery: recoverStatus() }));
      ui.buttons.check.click();
      await flush();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(posts(fetch)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on RECOVERY_BLOCKED shows the returned reason without retrying or offering force', async () => {
    const { ui, fetch } = setup([
      json(200, { status: 'success', recovery: recoverStatus({ plan: 'adopt-marker', marker: 'unclaimed' }) }),
      json(409, { status: 'error', code: 'RECOVERY_BLOCKED', reason: 'marker-token-in-use',
        recovery: { ...recoverStatus(), action: 'blocked', reason: 'marker-token-in-use', plan: null,
          marker: 'owned-by-another-project', statusVersion: VERSION_B } }),
    ]);
    ui.open.click();
    await flush();
    ui.buttons.recover.click();
    await flush();
    await flush();
    expect(posts(fetch)).toHaveLength(1);
    expect(ui.buttons.recover.hidden).toBe(true);
    expect(ui.summary()).toContain('another CreatorCrate project');
    expect(ui.root.text).not.toMatch(/force/i);
  });
});
