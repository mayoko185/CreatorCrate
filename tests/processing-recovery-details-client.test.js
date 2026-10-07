/**
 * WP9 Recovery Details client: entry-point visibility from the DB-only GET,
 * GET-only dialog opens, explicit Refresh/Cleanup/Manual Scan requests, human
 * presentation, and no Processing Preview side effects. Uses a purpose-built
 * DOM shim (no jsdom dependency in this project).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  cleanupResultMessage,
  enhanceProcessingRecoveryDetails,
  presentRecoveryEntry,
  presentRecoverySummary,
  RECOVERY_DETAILS_DIALOG_ID,
  RECOVERY_DETAILS_SYNC_EVENT,
  recoveryArtifactRoleLabel,
  recoveryEntryCanCleanup,
  recoveryOperationLabel,
  recoveryRetentionReasonText,
  refreshableEvidenceIds,
} from '../src/static/client/processing-recovery-details.js';

// ─── DOM shim ──────────────────────────────────────────────────────────────

function parseSelector(selector) {
  const match = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
  if (!match) throw new Error(`Unsupported selector in test shim: ${selector}`);
  return { name: match[1], value: match[2] };
}

function makeDocument() {
  const listeners = new Map();
  const document = {
    nodeType: 9,
    activeElement: null,
    defaultView: null,
    createElement: (tag) => makeNode(document, tag),
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) || []), handler]); },
    dispatchEvent(event) { (listeners.get(event.type) || []).forEach((handler) => handler(event)); return true; },
    getElementById(id) { return document.body.find((node) => node.getAttribute('id') === id); },
    querySelector(selector) { return document.body.querySelector(selector); },
    querySelectorAll(selector) { return document.body.querySelectorAll(selector); },
    listeners,
  };
  document.body = makeNode(document, 'body');
  document.activeElement = document.body;
  return document;
}

// Like a browser: removing the focused element (or an ancestor) drops focus to <body>.
function blurIfRemoved(document, removed) {
  if (document.activeElement && removed.contains(document.activeElement)) document.activeElement = document.body;
}

function makeNode(document, tag, attributes = {}) {
  const attrs = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
  const listeners = new Map();
  let ownText = '';
  const node = {
    tag,
    children: [],
    parent: null,
    dataset: {},
    disabled: false,
    className: '',
    hidden: attrs.has('hidden'),
    get textContent() { return [ownText, ...node.children.map((child) => child.textContent)].join(''); },
    set textContent(value) { node.children = []; ownText = String(value); },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute(name, value = '') { attrs.set(name, String(value)); if (name === 'hidden') node.hidden = true; },
    removeAttribute(name) { attrs.delete(name); if (name === 'hidden') node.hidden = false; },
    hasAttribute: (name) => attrs.has(name),
    attributeNames: () => [...attrs.keys()],
    addEventListener: (type, handler) => listeners.set(type, [...(listeners.get(type) || []), handler]),
    append(...children) {
      children.forEach((child) => {
        if (child.parent) child.remove();
        child.parent = node;
        node.children.push(child);
      });
    },
    replaceChildren(...children) {
      node.children.forEach((child) => { blurIfRemoved(document, child); child.parent = null; });
      node.children = [];
      ownText = '';
      node.append(...children);
    },
    remove() {
      blurIfRemoved(document, node);
      if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
      node.parent = null;
    },
    matches(selector) {
      const { name, value } = parseSelector(selector);
      return attrs.has(name) && (value === undefined || attrs.get(name) === value);
    },
    closest(selector) {
      for (let current = node; current; current = current.parent) {
        if (current.matches?.(selector)) return current;
      }
      return null;
    },
    contains(other) {
      for (let current = other; current; current = current.parent) if (current === node) return true;
      return false;
    },
    find(predicate) {
      for (const child of node.children) {
        if (predicate(child)) return child;
        const found = child.find(predicate);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (current) => current.children.forEach((child) => {
        if (child.matches(selector)) found.push(child);
        walk(child);
      });
      walk(node);
      return found;
    },
    querySelector(selector) { return node.querySelectorAll(selector)[0] || null; },
    // Like a browser: a disabled control refuses focus (activeElement is
    // unchanged); a real focus change fires a bubbling focusin, seen at the document.
    focus() {
      if (node.disabled || document.activeElement === node) return;
      document.activeElement = node;
      document.dispatchEvent({ type: 'focusin', target: node });
    },
    blur() { if (document.activeElement === node) document.activeElement = document.body; },
    click() {
      const event = { type: 'click', target: node, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      if (node.disabled) return;
      for (let current = node; current; current = current.parent) {
        (current.listenersFor?.('click') || []).forEach((handler) => handler(event));
      }
      document.dispatchEvent(event);
    },
    listenersFor: (type) => listeners.get(type) || [],
  };
  return node;
}

function visible(node) {
  for (let current = node; current; current = current.parent) if (current.hidden) return false;
  return true;
}

// Mirrors processing-recovery-details.njk (entry points, dialog) and one
// Processing dialog root whose Preview state must never change.
function buildPage({ readOnly = false } = {}) {
  const document = makeDocument();
  const el = (tag, attributes, ...children) => {
    const node = makeNode(document, tag, attributes);
    node.append(...children);
    return node;
  };
  const opener = () => el('button', { 'data-dialog-open': RECOVERY_DETAILS_DIALOG_ID });
  const pageEntry = el('div', { 'data-recovery-details-entry': '', 'data-page-entry': '', hidden: '' },
    el('div', { 'data-recovery-entry-variant': 'gated', hidden: '' }, opener()),
    el('div', { 'data-recovery-entry-variant': 'evidence', hidden: '' }, opener()));
  const dialogEntry = el('div', { 'data-recovery-details-entry': '', 'data-dialog-entry': '', hidden: '' },
    el('p', { 'data-recovery-entry-variant': 'gated', hidden: '' }, opener()),
    el('p', { 'data-recovery-entry-variant': 'evidence', hidden: '' }, opener()));
  const applyButton = el('button', { 'data-processing-apply': '' });
  const processingRoot = el('div', { 'data-processing-root': '' }, dialogEntry, applyButton);
  processingRoot.__ccPreviewValid = true;
  processingRoot.__ccLastPreviewBody = '{"assetIds":[1]}';
  const errorText = el('p', { 'data-recovery-details-error-text': '' });
  // Archived markup carries the read-only flag and omits Refresh/Manual Scan.
  const root = el('div', {
    'data-recovery-details': '', 'data-project-id': '7', 'data-csrf': 'csrf-token',
    ...(readOnly ? { 'data-recovery-details-read-only': '' } : {}),
  },
  el('button', { 'data-dialog-close': '', 'data-header-close': '' }),
  el('div', { 'data-recovery-details-summary': '' }),
  ...(readOnly ? [] : [
    el('section', { 'data-recovery-details-manual-scan-section': '', hidden: '' },
      el('button', { 'data-recovery-details-manual-scan': '' })),
    el('button', { 'data-recovery-details-refresh': '', hidden: '' }),
  ]),
  el('div', { 'data-recovery-details-error': '', hidden: '' }, errorText),
  el('div', { 'data-recovery-details-status': '' }),
  el('ul', { 'data-recovery-details-list': '', tabindex: '-1' }),
  el('button', { 'data-dialog-close': '', 'data-footer-close': '' }));
  const dialog = el('dialog', { id: RECOVERY_DETAILS_DIALOG_ID }, root);
  // Archived projects render no Processing dialogs.
  document.body.append(pageEntry, ...(readOnly ? [] : [processingRoot]), dialog);
  const part = (name) => root.querySelector(`[data-recovery-details-${name}]`);
  return {
    document, root, dialog, pageEntry, dialogEntry, processingRoot, applyButton, part,
    pageOpener: pageEntry.querySelector(`[data-dialog-open="${RECOVERY_DETAILS_DIALOG_ID}"]`),
    entries: () => part('list').children,
    entry: (key) => part('list').children.find((child) => child.getAttribute('data-recovery-entry') === key),
    variant: (container) => container.querySelectorAll('[data-recovery-entry-variant]')
      .filter(visible).map((node) => node.getAttribute('data-recovery-entry-variant')),
  };
}

function json(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/** A fetch whose GET always answers with the current server state. */
function server(initial) {
  const state = { ...initial, entries: [...initial.entries] };
  const calls = [];
  const handlers = { refresh: null, cleanup: null, scan: null, get: null };
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, url, body, headers: init.headers });
    if (method === 'GET' && url === '/projects/7/assets/processing/recovery') {
      if (handlers.get) return handlers.get();
      return json({ ok: true, recoveryRequired: state.recoveryRequired, entries: state.entries });
    }
    if (method === 'POST' && url === '/projects/7/assets/processing/recovery/refresh') return handlers.refresh(body);
    if (method === 'POST' && url === '/projects/7/assets/processing/recovery/cleanup') return handlers.cleanup(body);
    if (method === 'POST' && url === '/projects/7/scan/manual') return handlers.scan(body);
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  return { state, calls, handlers, fetch };
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const posts = (calls) => calls.filter((call) => call.method !== 'GET');
const gets = (calls) => calls.filter((call) => call.method === 'GET');

// ─── Fixtures (shape of listProjectRecoveryDetails) ────────────────────────

const base = {
  kind: 'evidence', projectId: 7, runId: 'run-1', mutationGroupId: 'group-1', itemKey: 'asset:3',
  checkpoint: null, checkpointAt: null, observation: 'unchecked', observedAt: null,
  identityRecorded: true, contentProofRecorded: true,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
};
const CRITICAL = {
  ...base, evidenceId: 'ev-critical', assetId: 3, operation: 'workflow-prompt', artifactRole: 'original-backup',
  lifecycle: 'recovery-critical', retentionReason: 'restoration-failed', artifactClass: 'private',
  artifactPath: '.creatorcrate-workflow-prompts-staging/0123456789abcdef.0.original',
  sourcePath: 'Final/a.png', destinationPath: null, cleanupPolicyEligible: false, observation: 'present',
};
const INTENT = {
  ...base, evidenceId: 'ev-intent', assetId: null, operation: 'watermark', artifactRole: 'staged-original',
  lifecycle: 'intent', retentionReason: 'watermark-publication-pending', artifactClass: 'private',
  artifactPath: '.creatorcrate-watermark-staging/0123456789abcdef.0.original',
  sourcePath: 'Final/b.png', destinationPath: 'Social/b.webp', cleanupPolicyEligible: false,
};
const ELIGIBLE = {
  ...base, evidenceId: 'ev-eligible', assetId: null, operation: 'convert', artifactRole: 'stage-output',
  lifecycle: 'dispensable', retentionReason: 'conversion-cleanup-residue', artifactClass: 'private',
  artifactPath: '.creatorcrate-convert-staging/0123456789abcdef.0.output',
  sourcePath: 'Final/c.png', destinationPath: 'Final/c.webp', cleanupPolicyEligible: true, observation: 'present',
};
const INELIGIBLE = {
  ...base, evidenceId: 'ev-ineligible', assetId: null, operation: 'archive', artifactRole: 'destination-backup',
  lifecycle: 'dispensable', retentionReason: 'archive-committed', artifactClass: 'private',
  artifactPath: '.creatorcrate-watermark-staging/0123456789abcdef.archive-0.destination',
  sourcePath: null, destinationPath: 'Archives/set.zip', cleanupPolicyEligible: false, observation: 'changed',
};
const PUBLIC = {
  ...base, evidenceId: 'ev-public', assetId: 4, operation: 'watermark', artifactRole: 'published-output',
  lifecycle: 'dispensable', retentionReason: 'watermark-committed', artifactClass: 'public-tracking',
  artifactPath: 'Social/d.webp', sourcePath: 'Final/d.png', destinationPath: 'Social/d.webp',
  // Adversarial: public tracking never offers cleanup, whatever the flags say.
  cleanupPolicyEligible: true,
};
const ORIGINALS_COPY = {
  ...base, evidenceId: 'ev-originals', assetId: null, operation: 'convert', artifactRole: 'originals-copy',
  lifecycle: 'dispensable', retentionReason: 'conversion-committed', artifactClass: 'public-tracking',
  artifactPath: 'Originals/e.png', sourcePath: 'Final/e.png', destinationPath: null, cleanupPolicyEligible: true,
};
const GROUP = {
  kind: 'mutation-group', mutationGroupId: 'group-only', operation: 'convert', runId: 'run-2', itemKey: 'Final/f.png',
  checkpoint: 'unlink', checkpointAt: '2026-10-01T11:00:00.000Z',
  createdAt: '2026-10-01T11:00:00.000Z', updatedAt: '2026-10-01T11:00:00.000Z', evidenceCount: 0,
};

async function setup(initial, options) {
  const page = buildPage(options);
  const backend = server(initial);
  const refreshAssets = vi.fn();
  const openDialog = vi.fn();
  const controller = enhanceProcessingRecoveryDetails(page.document, {
    fetch: backend.fetch, refreshAssets, openDialog,
  });
  await flush();
  return { ...page, ...backend, controller, refreshAssets, openDialog };
}

async function openDialog(page) {
  page.pageOpener.click();
  await flush();
}

// ─── Presentation ──────────────────────────────────────────────────────────

describe('Recovery Details presentation', () => {
  it('maps operations, roles and reasons to human text and never echoes unknown tokens', () => {
    expect(recoveryOperationLabel('workflow-prompt')).toBe('Workflow Prompt');
    expect(recoveryOperationLabel('watermark')).toBe('Watermark');
    expect(recoveryOperationLabel('archive')).toBe('Archive');
    expect(recoveryOperationLabel('convert')).toBe('Conversion');
    expect(recoveryOperationLabel('rename-v9')).toBe('Recovery evidence');

    expect(recoveryArtifactRoleLabel('workflow-prompt', 'original-backup')).toBe('Original backup');
    expect(recoveryArtifactRoleLabel('workflow-prompt', 'stage-output')).toBe('Staged edited image');
    expect(recoveryArtifactRoleLabel('watermark', 'destination-backup')).toBe('Previous output backup');
    expect(recoveryArtifactRoleLabel('watermark', 'staged-original')).toBe('Original source recovery copy');
    expect(recoveryArtifactRoleLabel('archive', 'archive-stage')).toBe('Staged archive');
    expect(recoveryArtifactRoleLabel('archive', 'destination-backup')).toBe('Previous archive backup');
    expect(recoveryArtifactRoleLabel('convert', 'original-backup')).toBe('Original source backup');
    expect(recoveryArtifactRoleLabel('convert', 'staged-original')).toBe('Original source recovery copy');
    expect(recoveryArtifactRoleLabel('convert', 'originals-copy')).toMatch(/^Tracking record/);
    expect(recoveryArtifactRoleLabel('archive', 'published-archive')).toMatch(/^Tracking record/);
    expect(recoveryArtifactRoleLabel('convert', 'mystery')).toBe('Recovery record');

    expect(recoveryRetentionReasonText('manual-scan-redundant')).toBe('Another accepted project file contains the same content.');
    expect(recoveryRetentionReasonText('manual-scan-artifact-missing')).toBe('The registered recovery file is already missing.');
    expect(recoveryRetentionReasonText('watermark-source-restoration-failed')).toBe('CreatorCrate could not confirm the original source was restored.');
    expect(recoveryRetentionReasonText('conversion-source-restoration-failed')).toBe('CreatorCrate could not confirm the original source was restored.');
    expect(recoveryRetentionReasonText('archive-cleanup-residue')).toBe('Project state is resolved, but a private temporary file remains.');
    expect(recoveryRetentionReasonText('cleanup-residue')).toBe('Project state is resolved, but a private temporary file remains.');
    expect(recoveryRetentionReasonText('conversion-committed')).toMatch(/^The project change committed; this retained copy is no longer needed/);
    expect(recoveryRetentionReasonText('something-new')).toBe('Recovery information retained.');
  });

  it('offers cleanup only for eligible dispensable PRIVATE evidence', () => {
    expect(recoveryEntryCanCleanup(ELIGIBLE)).toBe(true);
    expect(recoveryEntryCanCleanup(INELIGIBLE)).toBe(false);
    expect(recoveryEntryCanCleanup({ ...CRITICAL, cleanupPolicyEligible: true })).toBe(false);
    expect(recoveryEntryCanCleanup({ ...INTENT, cleanupPolicyEligible: true })).toBe(false);
    expect(recoveryEntryCanCleanup(PUBLIC)).toBe(false);
    expect(recoveryEntryCanCleanup(ORIGINALS_COPY)).toBe(false);
    expect(recoveryEntryCanCleanup(GROUP)).toBe(false);
    expect(recoveryEntryCanCleanup({ ...ELIGIBLE, cleanupPolicyEligible: 'true' })).toBe(false);
  });

  it('never says a stored observation makes a file safe to delete now', () => {
    const view = presentRecoveryEntry(ELIGIBLE);
    expect(view.statusLabel).toBe('Safe cleanup can be retried');
    expect(`${view.statusLabel} ${view.recommendation}`).not.toMatch(/safe to delete/i);
    expect(view.recommendation).toMatch(/checks the file again immediately before removing anything/);
  });

  it('summarises gated, gated-empty, ungated-with-evidence and empty states distinctly', () => {
    expect(presentRecoverySummary({ recoveryRequired: true, entries: [CRITICAL] })).toMatchObject({
      entryPoint: 'gated', tone: 'warning', showManualScan: true,
      paragraphs: ['Processing is blocked until you inspect the project and complete a successful manual scan.'],
    });
    const gatedEmpty = presentRecoverySummary({ recoveryRequired: true, entries: [] });
    expect(gatedEmpty.entryPoint).toBe('gated');
    expect(gatedEmpty.showManualScan).toBe(true);
    expect(gatedEmpty.paragraphs.join(' ')).toMatch(/processing stays blocked until a manual scan succeeds/);
    const evidence = presentRecoverySummary({ recoveryRequired: false, entries: [ELIGIBLE] });
    expect(evidence).toMatchObject({ entryPoint: 'evidence', tone: 'info', showManualScan: false });
    expect(evidence.paragraphs[0]).toBe('Processing can continue. Recovery evidence remains for review or safe cleanup.');
    expect(presentRecoverySummary({ recoveryRequired: false, entries: [] }).entryPoint).toBe('none');
    expect(presentRecoverySummary({ recoveryRequired: false, entries: [GROUP] }).showManualScan).toBe(true);
  });

  it('maps every WP7B cleanup status and reason without echoing raw values', () => {
    expect(cleanupResultMessage({ status: 'cleaned', reason: 'removed' })).toBe('Cleanup completed.');
    expect(cleanupResultMessage({ status: 'already-absent', reason: 'already-absent' }))
      .toBe('The recovery file was already absent; its recovery record was cleaned up.');
    for (const reason of ['public-tracking', 'recovery-critical', 'intent', 'checkpoint-active', 'invalid-private-path',
      'proof-incomplete', 'replaced', 'changed', 'unavailable', 'ownership-unknown', 'cleanup-failed']) {
      for (const status of ['retained', 'blocked']) {
        const message = cleanupResultMessage({ status, reason });
        expect(message).not.toBe(reason);
        if (reason.includes('-')) expect(message).not.toContain(reason);
        expect(message).not.toBe('Cleanup was not performed. The file was left in place.');
      }
    }
    expect(cleanupResultMessage({ status: 'blocked', reason: '<img src=x>' })).toBe('Cleanup was not performed. The file was left in place.');
    expect(cleanupResultMessage({ status: 'weird' })).toBe('Safe cleanup could not be completed.');
  });

  it('refreshes only evidence IDs, never mutation groups', () => {
    expect(refreshableEvidenceIds([CRITICAL, GROUP, ELIGIBLE, CRITICAL])).toEqual(['ev-critical', 'ev-eligible']);
    expect(refreshableEvidenceIds([GROUP])).toEqual([]);
  });
});

// ─── Entry points and page load ───────────────────────────────────────────

describe('Recovery Details entry points', () => {
  it('page initialization performs exactly one DB-only GET and no refresh, cleanup or scan', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL, ELIGIBLE] });
    expect(page.calls).toEqual([expect.objectContaining({ method: 'GET', url: '/projects/7/assets/processing/recovery' })]);
    expect(posts(page.calls)).toEqual([]);
  });

  it('gated with entries shows the strong warning and Recovery Details everywhere', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL] });
    expect(visible(page.pageEntry)).toBe(true);
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
    expect(page.variant(page.dialogEntry)).toEqual(['gated']);
    expect(page.pageEntry.getAttribute('data-recovery-state')).toBe('gated');
  });

  it('gated with zero entries still offers Recovery Details and Manual Scan', async () => {
    const page = await setup({ recoveryRequired: true, entries: [] });
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
    await openDialog(page);
    expect(page.part('summary').textContent).toMatch(/Processing is blocked/);
    expect(page.part('summary').textContent).toMatch(/No registered recovery evidence is currently listed/);
    expect(visible(page.part('manual-scan'))).toBe(true);
    expect(visible(page.part('refresh'))).toBe(false);
  });

  it('ungated with entries hides the strong warning and keeps a restrained link', async () => {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL] });
    expect(page.variant(page.pageEntry)).toEqual(['evidence']);
    expect(page.variant(page.dialogEntry)).toEqual(['evidence']);
  });

  it('ungated with zero entries hides every persistent entry point', async () => {
    const page = await setup({ recoveryRequired: false, entries: [] });
    expect(visible(page.pageEntry)).toBe(false);
    expect(visible(page.dialogEntry)).toBe(false);
    expect(page.variant(page.pageEntry)).toEqual([]);
  });

  it('a failed initial GET leaves the entry points as rendered and never clears anything', async () => {
    const page = buildPage();
    const fetch = vi.fn(async () => json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'SQLITE_BUSY at /srv/x' } }, 500));
    enhanceProcessingRecoveryDetails(page.document, { fetch, refreshAssets: vi.fn(), openDialog: vi.fn() });
    await flush();
    expect(visible(page.pageEntry)).toBe(false);
    expect(page.part('summary').textContent).toBe('Recovery details could not be loaded.');
    expect(page.root.textContent).not.toContain('SQLITE_BUSY');
  });

  it('the Processing sync event re-reads with GET only', async () => {
    const page = await setup({ recoveryRequired: false, entries: [] });
    page.state.recoveryRequired = true;
    page.document.dispatchEvent({ type: RECOVERY_DETAILS_SYNC_EVENT });
    await flush();
    expect(posts(page.calls)).toEqual([]);
    expect(gets(page.calls)).toHaveLength(2);
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
  });
});

// ─── Dialog ────────────────────────────────────────────────────────────────

describe('Recovery Details dialog', () => {
  it('opening performs GET only (never refresh) and shows current state on every reopen', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL] });
    await openDialog(page);
    expect(posts(page.calls)).toEqual([]);
    expect(gets(page.calls)).toHaveLength(2);
    expect(page.entries()).toHaveLength(1);

    page.state.entries = [CRITICAL, ELIGIBLE];
    page.state.recoveryRequired = false;
    await openDialog(page);
    expect(posts(page.calls)).toEqual([]);
    expect(page.entries()).toHaveLength(2);
    expect(page.part('summary').textContent).toMatch(/^Processing can continue/);
  });

  it('shares one GET when the dialog opens while the initial GET is in flight', async () => {
    const page = buildPage();
    let release;
    const fetch = vi.fn(() => new Promise((resolve) => {
      release = () => resolve(json({ ok: true, recoveryRequired: false, entries: [ELIGIBLE] }));
    }));
    enhanceProcessingRecoveryDetails(page.document, { fetch, refreshAssets: vi.fn(), openDialog: vi.fn() });
    page.pageOpener.click();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(page.entries()).toHaveLength(1);
  });

  it('renders human operation, role, reason, status and paths for evidence', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL] });
    await openDialog(page);
    const item = page.entry('evidence:ev-critical');
    const text = item.textContent;
    expect(text).toContain('Workflow Prompt');
    expect(text).toContain('Original backup');
    expect(text).toContain('Recovery copy retained');
    expect(text).toContain('CreatorCrate could not confirm the previous project file was restored.');
    expect(text).toContain('File present');
    expect(text).toContain('.creatorcrate-workflow-prompts-staging/0123456789abcdef.0.original');
    expect(text).toContain('Final/a.png');
    expect(item.querySelectorAll('[data-recovery-cleanup]')).toHaveLength(0);
  });

  it('renders no absolute path, raw identity or hash even if the payload carried them', async () => {
    const leaky = {
      ...CRITICAL,
      absolutePath: 'C:\\Projects\\secret\\file.png',
      identity: { dev: '2049', ino: '777777' },
      expectedSha256: 'f'.repeat(64),
      expectedSize: 987654,
      projectDir: '/srv/projects/000007-moon',
    };
    const page = await setup({ recoveryRequired: true, entries: [leaky] });
    await openDialog(page);
    const text = page.root.textContent;
    for (const secret of ['C:\\Projects', '777777', '2049', 'f'.repeat(16), '987654', '/srv/projects']) {
      expect(text).not.toContain(secret);
    }
  });

  it('renders a mutation group as an unresolved mutation with no file status, path or cleanup', async () => {
    const page = await setup({ recoveryRequired: true, entries: [GROUP] });
    await openDialog(page);
    const item = page.entry('group:group-only');
    expect(item.textContent).toContain('Unresolved project mutation');
    expect(item.textContent).toContain('Conversion');
    expect(item.textContent).toMatch(/No registered recovery file remains for this change/);
    expect(item.textContent).toMatch(/run a manual scan/);
    expect(item.textContent).not.toContain('File status');
    expect(item.textContent).not.toContain('Recovery file');
    expect(item.querySelectorAll('[data-recovery-cleanup]')).toHaveLength(0);
    expect(visible(page.part('manual-scan'))).toBe(true);
    // Nothing to inspect: no Refresh at all.
    expect(visible(page.part('refresh'))).toBe(false);
  });

  it('gives cleanup only to the eligible dispensable private row', async () => {
    const entries = [
      { ...CRITICAL, cleanupPolicyEligible: true },
      { ...INTENT, cleanupPolicyEligible: true },
      ELIGIBLE, INELIGIBLE, PUBLIC, ORIGINALS_COPY, GROUP,
    ];
    const page = await setup({ recoveryRequired: false, entries });
    await openDialog(page);
    const buttons = page.root.querySelectorAll('[data-recovery-cleanup]');
    expect(buttons.map((button) => button.getAttribute('data-recovery-cleanup'))).toEqual(['ev-eligible']);
    expect(buttons[0].textContent).toBe('Retry safe cleanup');
    expect(page.entry('evidence:ev-intent').textContent).toContain('Recovery state unresolved');
    expect(page.entry('evidence:ev-ineligible').textContent).toContain('CreatorCrate cannot safely clean this path automatically.');
    expect(page.entry('evidence:ev-public').textContent).toContain('Project-state tracking');
    expect(page.entry('evidence:ev-public').textContent).toContain('tracks project state rather than a private cleanup file');
    expect(page.entry('evidence:ev-originals').textContent).toContain('Tracking record for an Originals copy');
  });

  it('links a related asset through the established asset viewer route only when assetId exists', async () => {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE] });
    await openDialog(page);
    const links = page.root.querySelectorAll('[data-recovery-open-asset]');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/projects/7/assets/3']);
  });
});

// ─── Refresh ───────────────────────────────────────────────────────────────

describe('Recovery Details Refresh', () => {
  it('posts exactly the listed evidence IDs (no groups) and then re-reads with GET', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL, GROUP, ELIGIBLE] });
    await openDialog(page);
    page.handlers.refresh = vi.fn(async () => {
      page.state.entries = [{ ...CRITICAL, observation: 'missing' }, GROUP, ELIGIBLE];
      return json({ ok: true, results: [] });
    });
    page.part('refresh').click();
    await flush();
    const refreshCalls = posts(page.calls);
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]).toMatchObject({
      url: '/projects/7/assets/processing/recovery/refresh', body: { evidenceIds: ['ev-critical', 'ev-eligible'] },
    });
    expect(refreshCalls[0].headers).toMatchObject({ 'X-CSRF-Token': 'csrf-token' });
    expect(page.calls.at(-1)).toMatchObject({ method: 'GET' });
    expect(page.entry('evidence:ev-critical').textContent).toContain('File missing');
    expect(page.part('status').textContent).toBe('Recovery files checked.');
  });

  it('sends no request when only group entries are listed', async () => {
    const page = await setup({ recoveryRequired: true, entries: [GROUP] });
    await openDialog(page);
    page.handlers.refresh = vi.fn();
    await page.controller.refresh();
    expect(page.handlers.refresh).not.toHaveBeenCalled();
    expect(posts(page.calls)).toEqual([]);
  });

  it('keeps the listed entries when Refresh fails', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL, ELIGIBLE] });
    await openDialog(page);
    page.handlers.refresh = async () => json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'EIO /mnt/smb/x' } }, 500);
    page.part('refresh').click();
    await flush();
    expect(page.entries()).toHaveLength(2);
    expect(page.part('error-text').textContent).toBe('Recovery evidence could not be refreshed.');
    expect(page.root.textContent).not.toContain('EIO');
    expect(page.part('refresh').disabled).toBe(false);
  });

  it('shows a busy, disabled Refresh while the request runs', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL] });
    await openDialog(page);
    let finish;
    page.handlers.refresh = () => new Promise((resolve) => { finish = () => resolve(json({ ok: true, results: [] })); });
    page.part('refresh').click();
    await flush();
    expect(page.part('refresh').disabled).toBe(true);
    expect(page.part('refresh').getAttribute('aria-busy')).toBe('true');
    page.part('refresh').click();
    expect(posts(page.calls)).toHaveLength(1);
    finish();
    await flush();
    expect(page.part('refresh').disabled).toBe(false);
  });
});

// ─── Cleanup ───────────────────────────────────────────────────────────────

describe('Recovery Details safe cleanup', () => {
  async function cleanupPage(result) {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE] });
    await openDialog(page);
    let release;
    page.handlers.cleanup = vi.fn((body) => new Promise((resolve) => {
      release = (after = () => {}) => { after(); resolve(json({ ok: true, results: [{ evidenceId: body.evidenceIds[0], ...result }] })); };
    }));
    const button = page.root.querySelector('[data-recovery-cleanup]');
    button.focus();
    button.click();
    await flush();
    return { page, release: async (after) => { release(after); await flush(); } };
  }

  it('posts exactly the selected evidence ID and keeps the row until GET says otherwise', async () => {
    const { page, release } = await cleanupPage({ status: 'cleaned', reason: 'removed', observation: 'missing' });
    expect(page.handlers.cleanup).toHaveBeenCalledTimes(1);
    expect(posts(page.calls)[0]).toMatchObject({
      url: '/projects/7/assets/processing/recovery/cleanup', body: { evidenceIds: ['ev-eligible'] },
    });
    // In flight: the row is still listed and its button is busy and disabled.
    const busy = page.root.querySelector('[data-recovery-cleanup]');
    expect(page.entry('evidence:ev-eligible')).toBeTruthy();
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    busy.click();
    expect(page.handlers.cleanup).toHaveBeenCalledTimes(1);

    const getsBefore = gets(page.calls).length;
    await release(() => { page.state.entries = [CRITICAL]; });
    expect(gets(page.calls)).toHaveLength(getsBefore + 1);
    expect(page.entry('evidence:ev-eligible')).toBeFalsy();
    expect(page.part('status').textContent).toBe('Cleanup completed.');
  });

  it('does not remove the row when the server response says success but GET still lists it', async () => {
    const { page, release } = await cleanupPage({ status: 'cleaned', reason: 'removed', observation: 'missing' });
    await release();
    expect(page.entry('evidence:ev-eligible')).toBeTruthy();
  });

  it('keeps a retained row visible with a human reason', async () => {
    const { page, release } = await cleanupPage({ status: 'retained', reason: 'changed', observation: 'changed' });
    await release(() => { page.state.entries = [CRITICAL, { ...ELIGIBLE, observation: 'changed' }]; });
    expect(page.entry('evidence:ev-eligible').textContent).toContain('File contents changed');
    expect(page.part('status').textContent).toBe('The file contents changed, so nothing was removed.');
  });

  it('renders a blocked result safely', async () => {
    const { page, release } = await cleanupPage({ status: 'blocked', reason: 'checkpoint-active' });
    await release();
    expect(page.part('status').textContent).toMatch(/^A project change for this file is still unresolved/);
    expect(page.root.textContent).not.toContain('checkpoint-active');
  });

  it('preserves the listed entries on an infrastructure failure', async () => {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE] });
    await openDialog(page);
    page.handlers.cleanup = async () => json({ ok: false, error: { code: 'RECOVERY_EVIDENCE_PERSISTENCE_FAILED', message: 'raw /abs/path' } }, 500);
    page.root.querySelector('[data-recovery-cleanup]').click();
    await flush();
    expect(page.entries()).toHaveLength(2);
    expect(page.part('error-text').textContent).toBe('Safe cleanup could not be completed.');
    expect(page.root.textContent).not.toContain('/abs/path');
    expect(page.root.querySelector('[data-recovery-cleanup]').disabled).toBe(false);
  });

  it('keeps focus on the cleanup control across re-render', async () => {
    const { page, release } = await cleanupPage({ status: 'retained', reason: 'cleanup-failed', observation: 'present' });
    await release();
    expect(page.document.activeElement?.getAttribute('data-recovery-cleanup')).toBe('ev-eligible');
  });

  it('moves focus to the list when the focused cleanup row disappears', async () => {
    const { page, release } = await cleanupPage({ status: 'cleaned', reason: 'removed', observation: 'missing' });
    await release(() => { page.state.entries = [CRITICAL]; });
    expect(page.document.activeElement).toBe(page.part('list'));
  });
});

// ─── Manual scan and gate sync ────────────────────────────────────────────

describe('Recovery Details manual scan', () => {
  it('uses only /scan/manual, re-reads GET, and moves the gated warning to the restrained link', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL, GROUP] });
    await openDialog(page);
    page.handlers.scan = vi.fn(async () => {
      // WP8B: the gate clears while the unique recovery copy stays protected.
      page.state.recoveryRequired = false;
      page.state.entries = [{ ...CRITICAL, observation: 'present' }];
      return json({ ok: true, scan: { added: 0, updated: 0, missing: 0, total: 1 } });
    });
    page.part('manual-scan').click();
    await flush();
    expect(posts(page.calls).map((call) => call.url)).toEqual(['/projects/7/scan/manual']);
    expect(posts(page.calls)[0].headers).toMatchObject({ Accept: 'application/json', 'X-CSRF-Token': 'csrf-token' });
    expect(page.calls.at(-1)).toMatchObject({ method: 'GET' });
    expect(page.variant(page.pageEntry)).toEqual(['evidence']);
    expect(page.variant(page.dialogEntry)).toEqual(['evidence']);
    expect(page.entries()).toHaveLength(1);
    expect(page.part('summary').textContent).toMatch(/^Processing can continue/);
    expect(page.refreshAssets).toHaveBeenCalledTimes(1);
    expect(page.part('status').textContent).toBe('Manual scan complete.');
  });

  it('does not clear the warning locally when the scan fails', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL] });
    await openDialog(page);
    page.handlers.scan = async () => json({ ok: false, error: { code: 'SCAN_FAILED', message: 'Project scan failed.' } }, 500);
    page.part('manual-scan').click();
    await flush();
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
    expect(page.part('error-text').textContent).toBe('Scan failed. The project directory may be missing or inaccessible.');
    expect(page.entries()).toHaveLength(1);
    expect(page.refreshAssets).not.toHaveBeenCalled();
  });

  it('hides the persistent entry point after the final entry disappears with the gate clear', async () => {
    const page = await setup({ recoveryRequired: true, entries: [GROUP] });
    await openDialog(page);
    page.handlers.scan = async () => {
      page.state.recoveryRequired = false;
      page.state.entries = [];
      return json({ ok: true, scan: {} });
    };
    page.part('manual-scan').click();
    await flush();
    expect(visible(page.pageEntry)).toBe(false);
    expect(visible(page.dialogEntry)).toBe(false);
    expect(page.part('summary').textContent).toMatch(/^No registered recovery evidence is currently listed/);
    expect(visible(page.part('manual-scan'))).toBe(false);
  });
});

describe('Recovery Details isolation from Processing', () => {
  it('opening, refreshing, cleaning and scanning never touch Processing Preview state', async () => {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE] });
    page.handlers.refresh = async () => json({ ok: true, results: [] });
    page.handlers.cleanup = async () => json({ ok: true, results: [{ evidenceId: 'ev-eligible', status: 'retained', reason: 'changed' }] });
    page.handlers.scan = async () => json({ ok: true, scan: {} });
    await openDialog(page);
    page.part('refresh').click();
    await flush();
    page.root.querySelector('[data-recovery-cleanup]').click();
    await flush();
    page.part('manual-scan').click();
    await flush();
    expect(page.processingRoot.__ccPreviewValid).toBe(true);
    expect(page.processingRoot.__ccLastPreviewBody).toBe('{"assetIds":[1]}');
    expect(page.applyButton.disabled).toBe(false);
    expect(page.applyButton.hasAttribute('aria-disabled')).toBe(false);
  });
});

// ─── Archived (read-only) ─────────────────────────────────────────────────

describe('Recovery Details on an archived project', () => {
  const archived = (initial) => setup(initial, { readOnly: true });

  it('shows the restrained entry point for evidence and renders entries through GET', async () => {
    const page = await archived({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE] });
    expect(page.controller.readOnly).toBe(true);
    expect(visible(page.pageEntry)).toBe(true);
    expect(page.variant(page.pageEntry)).toEqual(['evidence']);
    await openDialog(page);
    expect(gets(page.calls)).toHaveLength(2);
    expect(posts(page.calls)).toEqual([]);
    expect(page.entries()).toHaveLength(2);
    const critical = page.entry('evidence:ev-critical').textContent;
    expect(critical).toContain('Original backup');
    expect(critical).toContain('.creatorcrate-workflow-prompts-staging/0123456789abcdef.0.original');
    expect(critical).toContain('CreatorCrate could not confirm the previous project file was restored.');
    expect(page.part('summary').textContent)
      .toBe('This archived project is read-only. Recovery information is available for review.');
    // Read navigation to the established viewer remains.
    expect(page.root.querySelectorAll('[data-recovery-open-asset]').map((link) => link.getAttribute('href')))
      .toEqual(['/projects/7/assets/3']);
  });

  it('renders no cleanup action, even for a row that would normally be eligible', async () => {
    const page = await archived({ recoveryRequired: false, entries: [ELIGIBLE] });
    await openDialog(page);
    expect(page.root.querySelectorAll('[data-recovery-cleanup]')).toHaveLength(0);
    const text = page.entry('evidence:ev-eligible').textContent;
    expect(text).not.toContain('Safe cleanup can be retried');
    expect(text).not.toMatch(/Cleanup can be retried/);
    expect(text).toContain('This archived project is read-only, so recovery actions are unavailable.');
  });

  it('has no Refresh or Manual Scan control, whatever the GET state', async () => {
    const page = await archived({ recoveryRequired: true, entries: [CRITICAL, INTENT, GROUP, ELIGIBLE] });
    await openDialog(page);
    expect(page.part('refresh')).toBeNull();
    expect(page.part('manual-scan')).toBeNull();
    expect(page.part('manual-scan-section')).toBeNull();
    expect(presentRecoverySummary({ recoveryRequired: true, entries: [GROUP] }, { readOnly: true }))
      .toMatchObject({ showManualScan: false, refreshIds: [] });
  });

  it('gated: readable unresolved/read-only wording with no impossible instruction', async () => {
    const page = await archived({ recoveryRequired: true, entries: [CRITICAL, INTENT, GROUP, PUBLIC] });
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
    await openDialog(page);
    const summary = page.part('summary').textContent;
    expect(summary).toContain('This archived project is read-only.');
    expect(summary).toContain('Recovery state for this project is unresolved.');
    expect(page.root.textContent).not.toMatch(/manual scan|safe cleanup|cleanup can be retried|Processing is blocked until/i);
  });

  it('gated with zero entries stays accessible and read-only', async () => {
    const page = await archived({ recoveryRequired: true, entries: [] });
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
    await openDialog(page);
    expect(page.part('summary').textContent).toMatch(/^This archived project is read-only\. No registered recovery evidence/);
    expect(page.part('summary').textContent).toContain('unresolved');
  });

  it('ungated with no entries hides the persistent entry point', async () => {
    const page = await archived({ recoveryRequired: false, entries: [] });
    expect(visible(page.pageEntry)).toBe(false);
    expect(page.variant(page.pageEntry)).toEqual([]);
  });

  it('client controls cannot generate a recovery mutation POST', async () => {
    const page = await archived({ recoveryRequired: true, entries: [CRITICAL, ELIGIBLE, GROUP] });
    page.handlers.refresh = vi.fn();
    page.handlers.cleanup = vi.fn();
    page.handlers.scan = vi.fn();
    await openDialog(page);
    // Click every rendered button (Close included): none may send a mutation.
    const buttons = [];
    const walk = (node) => node.children.forEach((child) => { if (child.tag === 'button') buttons.push(child); walk(child); });
    walk(page.root);
    expect(buttons.length).toBeGreaterThan(0);
    buttons.forEach((button) => button.click());
    await page.controller.refresh();
    await page.controller.cleanup('ev-eligible');
    await page.controller.manualScan();
    page.document.dispatchEvent({ type: RECOVERY_DETAILS_SYNC_EVENT });
    await flush();
    expect(posts(page.calls)).toEqual([]);
    expect(page.handlers.refresh).not.toHaveBeenCalled();
    expect(page.handlers.cleanup).not.toHaveBeenCalled();
    expect(page.handlers.scan).not.toHaveBeenCalled();
  });
});

// ─── Request generations ──────────────────────────────────────────────────

/** Holds every GET until the test answers it, in any order. */
function holdGets(page) {
  const held = [];
  page.handlers.get = () => new Promise((resolve) => {
    held.push({ answer: (payload) => resolve(json({ ok: true, ...payload })) });
  });
  return held;
}

describe('Recovery Details request generations', () => {
  const UNGATED = { recoveryRequired: false, entries: [ELIGIBLE] };
  const GATED = { recoveryRequired: true, entries: [ELIGIBLE] };

  it('a GET begun before a Processing sync cannot satisfy it; the fresh gated response wins', async () => {
    const page = await setup({ recoveryRequired: false, entries: [] });
    const held = holdGets(page);
    void page.controller.load(); // GET A: begins while the server is ungated.
    expect(held).toHaveLength(1);
    // The server becomes gated; Preview gets 409; processing.js dispatches sync.
    page.document.dispatchEvent({ type: RECOVERY_DETAILS_SYNC_EVENT });
    expect(held).toHaveLength(2); // GET B starts after the signal.

    held[1].answer(GATED);
    await flush();
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
    held[0].answer(UNGATED);
    await flush();
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
    expect(page.dialogEntry.getAttribute('data-recovery-state')).toBe('gated');
    expect(posts(page.calls)).toEqual([]);
  });

  it('a stale pre-sync response that lands first is ignored too', async () => {
    const page = await setup({ recoveryRequired: false, entries: [] });
    const held = holdGets(page);
    void page.controller.load();
    page.document.dispatchEvent({ type: RECOVERY_DETAILS_SYNC_EVENT });
    held[0].answer(UNGATED);
    await flush();
    expect(page.pageEntry.getAttribute('data-recovery-state')).toBe('none');
    expect(page.controller.state.loading).not.toBeNull();
    held[1].answer(GATED);
    await flush();
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
    expect(page.controller.state.loading).toBeNull();
  });

  it('sync performs GET only and leaves Processing Preview/Apply untouched', async () => {
    const page = await setup({ recoveryRequired: false, entries: [ELIGIBLE] });
    page.state.recoveryRequired = true;
    page.document.dispatchEvent({ type: RECOVERY_DETAILS_SYNC_EVENT });
    await flush();
    expect(page.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /projects/7/assets/processing/recovery',
      'GET /projects/7/assets/processing/recovery',
    ]);
    expect(page.processingRoot.__ccPreviewValid).toBe(true);
    expect(page.processingRoot.__ccLastPreviewBody).toBe('{"assetIds":[1]}');
    expect(page.applyButton.disabled).toBe(false);
    expect(page.applyButton.hasAttribute('aria-disabled')).toBe(false);
  });

  it('repeated sync signals during one sync GET coalesce into a single trailing GET', async () => {
    const page = await setup({ recoveryRequired: false, entries: [] });
    const held = holdGets(page);
    void page.controller.load(); // A (pre-sync)
    for (let i = 0; i < 5; i += 1) page.document.dispatchEvent({ type: RECOVERY_DETAILS_SYNC_EVENT });
    expect(held).toHaveLength(2); // A, plus B for the first sync; the rest wait for B.
    held[0].answer(UNGATED);
    held[1].answer(UNGATED);
    await flush();
    expect(held).toHaveLength(3); // one trailing GET C begins after B settles
    held[2].answer(GATED);
    await flush();
    expect(held).toHaveLength(3);
    expect(page.variant(page.pageEntry)).toEqual(['gated']);
    expect(posts(page.calls)).toEqual([]);
  });

  it('cleanup: a GET begun before cleanup cannot overwrite the post-cleanup GET', async () => {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE] });
    await openDialog(page);
    const held = holdGets(page);
    void page.controller.load(); // A: still lists the residue
    page.handlers.cleanup = async () => json({ ok: true, results: [{ evidenceId: 'ev-eligible', status: 'cleaned', reason: 'removed' }] });
    page.root.querySelector('[data-recovery-cleanup]').click();
    await flush();
    expect(held).toHaveLength(2);
    held[1].answer({ recoveryRequired: false, entries: [CRITICAL] });
    await flush();
    held[0].answer({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE] });
    await flush();
    expect(page.entry('evidence:ev-eligible')).toBeFalsy();
    expect(page.entries()).toHaveLength(1);
  });

  it('manual scan: a GET begun before the scan cannot restore the cleared gate', async () => {
    const page = await setup({ recoveryRequired: true, entries: [CRITICAL] });
    await openDialog(page);
    const held = holdGets(page);
    void page.controller.load(); // A: gated
    page.handlers.scan = async () => json({ ok: true, scan: {} });
    page.part('manual-scan').click();
    await flush();
    expect(held).toHaveLength(2);
    held[1].answer({ recoveryRequired: false, entries: [CRITICAL] });
    await flush();
    held[0].answer({ recoveryRequired: true, entries: [CRITICAL] });
    await flush();
    expect(page.variant(page.pageEntry)).toEqual(['evidence']);
  });

  it('refresh: the post-refresh GET is authoritative over an earlier GET', async () => {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL] });
    await openDialog(page);
    const held = holdGets(page);
    void page.controller.load();
    page.handlers.refresh = async () => json({ ok: true, results: [] });
    page.part('refresh').click();
    await flush();
    expect(held).toHaveLength(2);
    held[1].answer({ recoveryRequired: false, entries: [{ ...CRITICAL, observation: 'missing' }] });
    await flush();
    held[0].answer({ recoveryRequired: false, entries: [CRITICAL] });
    await flush();
    expect(page.entry('evidence:ev-critical').textContent).toContain('File missing');
  });
});

// ─── Cleanup focus ────────────────────────────────────────────────────────

describe('Recovery Details cleanup focus', () => {
  async function focusedCleanup(entries, respond) {
    const page = await setup({ recoveryRequired: false, entries });
    await openDialog(page);
    let release;
    page.handlers.cleanup = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const button = page.root.querySelector('[data-recovery-cleanup]');
    button.focus();
    expect(page.document.activeElement).toBe(button);
    button.click();
    await flush();
    return {
      page,
      async settle(after) {
        after?.();
        release(respond());
        await flush();
      },
    };
  }
  const result = (status, reason) => () => json({ ok: true, results: [{ evidenceId: 'ev-eligible', status, reason }] });
  const active = (page) => page.document.activeElement;

  it('busy cleanup parks focus on the list, never on the disabled button or <body>', async () => {
    const { page } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    const busy = page.root.querySelector('[data-recovery-cleanup]');
    expect(busy.disabled).toBe(true);
    expect(active(page)).toBe(page.part('list'));
    expect(active(page)).not.toBe(page.document.body);
    expect(active(page).disabled).not.toBe(true);
  });

  it('retained: focus returns to the re-enabled Retry safe cleanup button', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    await settle();
    const button = page.root.querySelector('[data-recovery-cleanup]');
    expect(button.disabled).toBe(false);
    expect(active(page)).toBe(button);
  });

  it('failure: focus returns to the re-enabled button', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE],
      () => json({ ok: false, error: { code: 'INTERNAL_ERROR' } }, 500));
    await settle();
    const button = page.root.querySelector('[data-recovery-cleanup]');
    expect(button.disabled).toBe(false);
    expect(active(page)).toBe(button);
  });

  it('row stays but is no longer eligible: focus the list', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    await settle(() => { page.state.entries = [CRITICAL, { ...ELIGIBLE, cleanupPolicyEligible: false }]; });
    expect(page.entry('evidence:ev-eligible')).toBeTruthy();
    expect(page.root.querySelectorAll('[data-recovery-cleanup]')).toHaveLength(0);
    expect(active(page)).toBe(page.part('list'));
  });

  it('cleaned row disappears while others remain: focus the list', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('cleaned', 'removed'));
    await settle(() => { page.state.entries = [CRITICAL]; });
    expect(active(page)).toBe(page.part('list'));
  });

  it('final row cleaned: focus the dialog Close button', async () => {
    const { page, settle } = await focusedCleanup([ELIGIBLE], result('cleaned', 'removed'));
    await settle(() => { page.state.entries = []; });
    expect(page.entries()).toHaveLength(0);
    expect(active(page).hasAttribute('data-footer-close')).toBe(true);
  });

  it('focus the user moved elsewhere during cleanup is left alone', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    const headerClose = page.root.querySelector('[data-header-close]');
    headerClose.focus();
    await settle();
    expect(active(page)).toBe(headerClose);
  });

  // ─── User-moved focus cancels cleanup's restoration intent ───

  const ELIGIBLE_2 = { ...ELIGIBLE, evidenceId: 'ev-eligible-2', artifactPath: '.creatorcrate-convert-staging/0123456789abcdef.1.output' };
  const control = (page, evidenceId, selector) => page.entry(`evidence:${evidenceId}`)?.querySelector(selector) ?? null;
  const technical = (page, evidenceId = 'ev-eligible') => control(page, evidenceId, '[data-recovery-technical]');
  const cleanupOf = (page, evidenceId) => control(page, evidenceId, '[data-recovery-cleanup]');
  const expectNotStolen = (page) => {
    expect(active(page)).not.toBe(page.document.body);
    expect(active(page).getAttribute('data-recovery-cleanup')).not.toBe('ev-eligible');
  };
  // Holds the next authoritative GET until answer() is called.
  const holdGet = (page) => {
    const held = {};
    page.handlers.get = () => new Promise((resolve) => {
      held.answer = () => {
        page.handlers.get = null;
        resolve(json({ ok: true, recoveryRequired: false, entries: page.state.entries }));
      };
    });
    return held;
  };

  it('user moves to Technical details while busy: the replacement summary keeps focus', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    expect(active(page)).toBe(page.part('list'));
    const before = technical(page);
    before.focus();
    expect(active(page)).toBe(before);
    expect(page.controller.state.cleanupFocus).toBe(null);
    await settle();
    const after = technical(page);
    expect(after).not.toBe(before);
    expect(active(page)).toBe(after);
    expect(cleanupOf(page, 'ev-eligible').disabled).toBe(false);
    expectNotStolen(page);
  });

  it("user moves to another entry's cleanup button: focus stays on that action", async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE, ELIGIBLE_2], result('retained', 'changed'));
    cleanupOf(page, 'ev-eligible-2').focus();
    await settle();
    expect(active(page)).toBe(cleanupOf(page, 'ev-eligible-2'));
    expectNotStolen(page);
  });

  it('user moves to the related asset link: the replacement link keeps focus', async () => {
    const withAsset = { ...ELIGIBLE, assetId: 9 };
    const { page, settle } = await focusedCleanup([CRITICAL, withAsset], result('retained', 'changed'));
    control(page, 'ev-eligible', '[data-recovery-open-asset]').focus();
    await settle();
    const link = control(page, 'ev-eligible', '[data-recovery-open-asset]');
    expect(link.getAttribute('href')).toBe('/projects/7/assets/9');
    expect(active(page)).toBe(link);
    expectNotStolen(page);
  });

  it('user moves to the footer Close: focus remains on Close', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    const close = page.root.querySelector('[data-footer-close]');
    close.focus();
    await settle();
    expect(active(page)).toBe(close);
  });

  it('user moves after the POST but before the authoritative GET: focus is still not stolen', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    const held = holdGet(page);
    await settle();
    // POST settled, GET pending: the intent still owns focus (parked on the list).
    expect(held.answer).toBeTypeOf('function');
    expect(active(page)).toBe(page.part('list'));
    expect(page.controller.state.cleanupFocus).toEqual({ evidenceId: 'ev-eligible' });
    technical(page).focus();
    held.answer();
    await flush();
    expect(active(page)).toBe(technical(page));
    expectNotStolen(page);
  });

  it('no user movement: the list through the POST and the GET, then the re-enabled button', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    const held = holdGet(page);
    await settle();
    expect(active(page)).toBe(page.part('list'));
    held.answer();
    await flush();
    expect(active(page)).toBe(cleanupOf(page, 'ev-eligible'));
    expect(page.controller.state.cleanupFocus).toBe(null);
  });

  it("failure after the user moved: the user's control keeps focus", async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE],
      () => json({ ok: false, error: { code: 'INTERNAL_ERROR' } }, 500));
    technical(page).focus();
    await settle();
    expect(cleanupOf(page, 'ev-eligible').disabled).toBe(false);
    expect(active(page)).toBe(technical(page));
    expectNotStolen(page);
  });

  it('chosen control disappears while the cleaned row stays: the list, never the original cleanup button', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    technical(page, 'ev-critical').focus();
    await settle(() => { page.state.entries = [ELIGIBLE]; });
    expect(page.entry('evidence:ev-critical')).toBeFalsy();
    expect(cleanupOf(page, 'ev-eligible').disabled).toBe(false);
    expect(active(page)).toBe(page.part('list'));
    expectNotStolen(page);
  });

  it('chosen control disappears with other entries left: the list', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE, ELIGIBLE_2], result('retained', 'changed'));
    technical(page).focus();
    await settle(() => { page.state.entries = [CRITICAL, ELIGIBLE_2]; });
    expect(page.entry('evidence:ev-eligible')).toBeFalsy();
    expect(active(page)).toBe(page.part('list'));
  });

  it('chosen control disappears with the final row: the dialog Close', async () => {
    const { page, settle } = await focusedCleanup([ELIGIBLE], result('cleaned', 'removed'));
    technical(page).focus();
    await settle(() => { page.state.entries = []; });
    expect(page.entries()).toHaveLength(0);
    expect(active(page).hasAttribute('data-footer-close')).toBe(true);
  });

  it('dialog closed to its opener during cleanup: completion leaves the opener focused', async () => {
    const { page, settle } = await focusedCleanup([CRITICAL, ELIGIBLE], result('retained', 'changed'));
    // The dialog module returns focus to the opener on close.
    page.pageOpener.focus();
    await settle();
    expect(active(page)).toBe(page.pageOpener);
  });

  it('a newer focused cleanup replaces the earlier intent; the earlier one never steals focus', async () => {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE, ELIGIBLE_2] });
    await openDialog(page);
    const releases = {};
    page.handlers.cleanup = vi.fn((body) => new Promise((resolve) => {
      const [evidenceId] = body.evidenceIds;
      releases[evidenceId] = () => resolve(json({ ok: true, results: [{ evidenceId, status: 'retained', reason: 'changed' }] }));
    }));
    cleanupOf(page, 'ev-eligible').focus();
    cleanupOf(page, 'ev-eligible').click();
    await flush();
    cleanupOf(page, 'ev-eligible-2').focus();
    cleanupOf(page, 'ev-eligible-2').click();
    await flush();
    expect(active(page)).toBe(page.part('list'));
    releases['ev-eligible']();
    await flush();
    expect(active(page)).toBe(page.part('list'));
    releases['ev-eligible-2']();
    await flush();
    expect(active(page)).toBe(cleanupOf(page, 'ev-eligible-2'));
  });

  it('a plain re-render keeps a focused entry control on its replacement', async () => {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE] });
    await openDialog(page);
    const before = technical(page, 'ev-critical');
    before.focus();
    page.document.dispatchEvent({ type: RECOVERY_DETAILS_SYNC_EVENT });
    await flush();
    expect(technical(page, 'ev-critical')).not.toBe(before);
    expect(active(page)).toBe(technical(page, 'ev-critical'));
  });

  it('a cleanup started without focus on its button does not move focus afterwards', async () => {
    const page = await setup({ recoveryRequired: false, entries: [CRITICAL, ELIGIBLE] });
    await openDialog(page);
    page.handlers.cleanup = result('retained', 'changed');
    page.root.querySelector('[data-header-close]').focus();
    page.root.querySelector('[data-recovery-cleanup]').click();
    await flush();
    expect(active(page).hasAttribute('data-header-close')).toBe(true);
  });
});
