import { openAppDialogById } from './app-dialogs.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { refreshProjectAssetsLiveRegion } from './live-regions.js';

/**
 * Project Assets Recovery Details (WP9): a presentation of the accepted recovery
 * API. It holds no recovery authority of its own.
 *
 * - GET  /projects/:id/assets/processing/recovery is SQLite-only. It runs once
 *   after page initialization (to decide whether an entry point is shown), on
 *   every dialog open, after every action below, and when the Processing
 *   dialogs report that recovery state may have changed. Nothing polls.
 * - POST …/recovery/refresh inspects files. It runs only when the user clicks
 *   Refresh, with exactly the evidence IDs currently listed.
 * - POST …/recovery/cleanup runs WP7B fresh-proof cleanup for exactly one
 *   evidence ID, only from an eligible private row's own button.
 * - POST /projects/:id/scan/manual is the existing manual scan; it alone
 *   accepts the project's current files and may clear the gate.
 *
 * `recoveryRequired` from GET is the only gate input: nothing here sets or
 * clears it locally, and no Recovery Details action touches Processing
 * Preview/Apply state.
 *
 * Archived projects render the dialog with `data-recovery-details-read-only`
 * (server-rendered from the project's archived state). Read-only mode keeps
 * the GET and drops every mutation: no Refresh, Cleanup or Manual Scan control
 * is rendered and the action functions refuse to send anything.
 */

export const RECOVERY_DETAILS_DIALOG_ID = 'processing-recovery-details-dialog';
// Dispatched on the document by the Processing dialogs when recovery state may
// have changed (gate reported, Apply finished or failed). It only triggers GET.
export const RECOVERY_DETAILS_SYNC_EVENT = 'creatorcrate:processing-recovery-sync';

const recoveryUrl = (projectId, action = '') => `/projects/${encodeURIComponent(projectId)}/assets/processing/recovery${action ? `/${action}` : ''}`;
const manualScanUrl = (projectId) => `/projects/${encodeURIComponent(projectId)}/scan/manual`;
const assetViewerUrl = (projectId, assetId) => `/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`;

export const RECOVERY_MESSAGES = Object.freeze({
  loading: 'Loading Recovery Details…',
  loadFailed: 'Recovery details could not be loaded.',
  refreshFailed: 'Recovery evidence could not be refreshed.',
  refreshing: 'Checking recovery files…',
  refreshed: 'Recovery files checked.',
  nothingToRefresh: 'No registered recovery files are listed to check.',
  cleanupFailed: 'Safe cleanup could not be completed.',
  cleaning: 'Running safe cleanup…',
  scanning: 'Scanning project files…',
  scanFailed: 'Scan failed. The project directory may be missing or inaccessible.',
  busy: 'Another operation is running on this project. Try again when it finishes.',
});

// ─── Presentation (pure: no DOM) ─────────────────────────────────────────

const OPERATION_LABELS = Object.freeze({
  'workflow-prompt': 'Workflow Prompt',
  watermark: 'Watermark',
  archive: 'Archive',
  convert: 'Conversion',
});

export function recoveryOperationLabel(operation) {
  return Object.hasOwn(OPERATION_LABELS, operation) ? OPERATION_LABELS[operation] : 'Recovery evidence';
}

const ROLE_LABELS = Object.freeze({
  'workflow-prompt': Object.freeze({
    'stage-output': 'Staged edited image',
    'original-backup': 'Original backup',
    'published-output': 'Tracking record for a published output',
  }),
  watermark: Object.freeze({
    'stage-output': 'Staged watermarked output',
    'destination-backup': 'Previous output backup',
    'staged-original': 'Original source recovery copy',
    'published-output': 'Tracking record for a published output',
  }),
  archive: Object.freeze({
    'archive-stage': 'Staged archive',
    'destination-backup': 'Previous archive backup',
    'published-archive': 'Tracking record for a published archive',
  }),
  convert: Object.freeze({
    'stage-output': 'Staged converted image',
    'original-backup': 'Original source backup',
    'staged-original': 'Original source recovery copy',
    'published-output': 'Tracking record for a published output',
    'originals-copy': 'Tracking record for an Originals copy',
  }),
});

export function recoveryArtifactRoleLabel(operation, artifactRole) {
  const roles = Object.hasOwn(ROLE_LABELS, operation) ? ROLE_LABELS[operation] : null;
  return roles && Object.hasOwn(roles, artifactRole) ? roles[artifactRole] : 'Recovery record';
}

// Producer tokens from WP3–WP6 (prefixed per operation; Workflow Prompt's are
// unprefixed) plus the WP8B manual-scan settlement reasons.
const REASON_TEXT = Object.freeze({
  pending: 'The project change had not finished when this file was recorded.',
  publicationFailed: 'Publishing the change into the project failed before recovery finished.',
  databaseFailed: 'The project files changed, but CreatorCrate could not finish updating its records.',
  restorationFailed: 'CreatorCrate could not confirm the previous project file was restored.',
  sourceRestorationFailed: 'CreatorCrate could not confirm the original source was restored.',
  provenanceFailed: 'CreatorCrate could not finish recording where the generated files came from.',
  publicUnclaimed: 'A new project file was created that CreatorCrate could not confirm as its own.',
  originalsWithdrawalFailed: 'CreatorCrate could not withdraw the Originals copy after rolling the change back.',
  committed: 'The project change committed; this retained copy is no longer needed for recovery.',
  rolledBack: 'The project change was rolled back and verified; this retained copy is no longer needed for recovery.',
  residue: 'Project state is resolved, but a private temporary file remains.',
  redundant: 'Another accepted project file contains the same content.',
  artifactMissing: 'The registered recovery file is already missing.',
});

const RETENTION_REASONS = Object.freeze(Object.fromEntries([
  ...['archive', 'watermark', 'conversion'].flatMap((prefix) => [
    [`${prefix}-publication-pending`, 'pending'],
    [`${prefix}-publication-failed`, 'publicationFailed'],
    [`${prefix}-database-failed`, 'databaseFailed'],
    [`${prefix}-restoration-failed`, 'restorationFailed'],
    [`${prefix}-provenance-reconciliation-failed`, 'provenanceFailed'],
    [`${prefix}-public-created-unclaimed`, 'publicUnclaimed'],
    [`${prefix}-committed`, 'committed'],
    [`${prefix}-verified-rollback`, 'rolledBack'],
    [`${prefix}-cleanup-residue`, 'residue'],
  ]),
  ['watermark-source-restoration-failed', 'sourceRestorationFailed'],
  ['conversion-source-restoration-failed', 'sourceRestorationFailed'],
  ['conversion-originals-withdrawal-failed', 'originalsWithdrawalFailed'],
  ['publication-pending', 'pending'],
  ['publication-failed', 'publicationFailed'],
  ['database-failed', 'databaseFailed'],
  ['restoration-failed', 'restorationFailed'],
  ['public-create-unclaimed', 'publicUnclaimed'],
  ['committed', 'committed'],
  ['rolled-back', 'rolledBack'],
  ['cleanup-residue', 'residue'],
  ['manual-scan-redundant', 'redundant'],
  ['manual-scan-artifact-missing', 'artifactMissing'],
].map(([token, key]) => [token, REASON_TEXT[key]])));

export function recoveryRetentionReasonText(reason) {
  return typeof reason === 'string' && Object.hasOwn(RETENTION_REASONS, reason)
    ? RETENTION_REASONS[reason]
    : 'Recovery information retained.';
}

const OBSERVATION_LABELS = Object.freeze({
  present: 'File present',
  missing: 'File missing',
  replaced: 'Path now contains a different file',
  changed: 'File contents changed',
  unavailable: 'File could not be inspected',
  'ownership-unknown': 'Ownership could not be verified',
  unchecked: 'Not refreshed',
});

export function recoveryObservationLabel(observation) {
  return Object.hasOwn(OBSERVATION_LABELS, observation) ? OBSERVATION_LABELS[observation] : 'Not refreshed';
}

const UNSAFE_OBSERVATIONS = new Set(['changed', 'replaced', 'unavailable', 'ownership-unknown']);

/** Only an eligible, dispensable PRIVATE evidence row ever offers WP7B cleanup. */
export function recoveryEntryCanCleanup(entry) {
  return entry?.kind === 'evidence'
    && entry.artifactClass === 'private'
    && entry.lifecycle === 'dispensable'
    && entry.cleanupPolicyEligible === true
    && typeof entry.evidenceId === 'string';
}

/** The IDs Refresh may inspect: listed evidence rows only, never group-only entries. */
export function refreshableEvidenceIds(entries) {
  return [...new Set((Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.kind === 'evidence' && typeof entry.evidenceId === 'string' && entry.evidenceId)
    .map((entry) => entry.evidenceId))];
}

function entryStatus(entry, readOnly = false) {
  if (entry.kind === 'mutation-group') return { label: 'Unresolved project mutation', tone: 'warning' };
  if (entry.artifactClass === 'public-tracking') return { label: 'Project-state tracking', tone: 'neutral' };
  if (entry.artifactClass !== 'private') return { label: 'Recovery information retained', tone: 'neutral' };
  if (entry.lifecycle === 'recovery-critical') return { label: 'Recovery copy retained', tone: 'warning' };
  if (entry.lifecycle === 'intent') return { label: 'Recovery state unresolved', tone: 'warning' };
  if (entry.lifecycle === 'dispensable') {
    return recoveryEntryCanCleanup(entry) && !readOnly
      ? { label: 'Safe cleanup can be retried', tone: 'draft' }
      : { label: 'Retained residue, cleanup unavailable', tone: 'neutral' };
  }
  return { label: 'Recovery information retained', tone: 'neutral' };
}

const READ_ONLY_NOTE = 'This archived project is read-only, so recovery actions are unavailable.';

// Archived projects cannot scan or clean up, so no recommendation asks for either.
function readOnlyRecommendation(entry) {
  if (entry.kind === 'mutation-group') return `No registered recovery file remains for this change. ${READ_ONLY_NOTE}`;
  if (entry.artifactClass === 'public-tracking') return `This tracks project state rather than a private cleanup file. ${READ_ONLY_NOTE}`;
  if (entry.artifactClass !== 'private') return 'CreatorCrate keeps this record as recorded.';
  if (entry.lifecycle === 'intent') return `CreatorCrate did not record how this change ended. ${READ_ONLY_NOTE}`;
  if (entry.lifecycle === 'recovery-critical') return `This copy may hold content that exists nowhere else, so CreatorCrate keeps it. ${READ_ONLY_NOTE}`;
  if (entry.lifecycle === 'dispensable') return `${READ_ONLY_NOTE} CreatorCrate leaves this file in place.`;
  return 'CreatorCrate keeps this record as recorded.';
}

function entryRecommendation(entry, recoveryRequired, readOnly = false) {
  if (readOnly) return readOnlyRecommendation(entry);
  if (entry.kind === 'mutation-group') {
    return 'No registered recovery file remains for this change. Inspect the project files, then run a manual scan when the current project state is correct.';
  }
  if (entry.artifactClass === 'public-tracking') {
    return recoveryRequired
      ? 'This tracks project state rather than a private cleanup file. Inspect the project files, then run a manual scan when the current project state is correct.'
      : 'This tracks project state rather than a private cleanup file. No cleanup is needed; the next manual scan retires this record.';
  }
  if (entry.artifactClass !== 'private') {
    return 'CreatorCrate keeps this record as recorded. Inspect the project files if anything looks wrong.';
  }
  if (entry.lifecycle === 'intent') {
    return 'CreatorCrate did not record how this change ended. Inspect the project files, then run a manual scan when the current project state is correct.';
  }
  if (entry.lifecycle === 'recovery-critical') {
    return 'This copy may hold content that exists nowhere else. Inspect the project files, then run a manual scan when the current project state is correct. The copy is kept afterward.';
  }
  if (entry.lifecycle === 'dispensable') {
    if (recoveryEntryCanCleanup(entry)) {
      return 'Cleanup can be retried safely. CreatorCrate checks the file again immediately before removing anything and keeps it if anything changed.';
    }
    if (UNSAFE_OBSERVATIONS.has(entry.observation)) return 'CreatorCrate cannot safely clean this path automatically.';
    return 'Automatic cleanup is unavailable for this file. CreatorCrate leaves it in place.';
  }
  return 'CreatorCrate keeps this record as recorded.';
}

const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

function entryPaths(entry) {
  if (entry.kind !== 'evidence') return [];
  const paths = [];
  const isPublic = entry.artifactClass === 'public-tracking';
  if (nonEmpty(entry.artifactPath)) paths.push({ label: isPublic ? 'Tracked project file' : 'Recovery file', value: entry.artifactPath });
  const seen = new Set([entry.artifactPath]);
  const related = [
    ['Source file', entry.sourcePath],
    ['Output file', entry.destinationPath],
  ];
  if (nonEmpty(entry.sourcePath) && entry.sourcePath === entry.destinationPath) {
    related.splice(0, 2, ['Project file', entry.sourcePath]);
  }
  for (const [label, value] of related) {
    if (!nonEmpty(value) || seen.has(value)) continue;
    seen.add(value);
    paths.push({ label, value });
  }
  return paths;
}

function technicalDetails(entry) {
  const rows = [
    ['Operation', entry.operation],
    ...(entry.kind === 'evidence' ? [
      ['Role', entry.artifactRole],
      ['Lifecycle', entry.lifecycle],
      ['Retention reason', entry.retentionReason],
      ['Observation', entry.observation],
    ] : []),
    ['Checkpoint', entry.checkpoint],
    ['Item', entry.itemKey],
    ['Run', entry.runId],
    ...(entry.kind === 'evidence' ? [['Evidence ID', entry.evidenceId]] : [['Mutation group', entry.mutationGroupId]]),
  ];
  return rows
    .filter(([, value]) => nonEmpty(value))
    .map(([label, value]) => ({ label, value }));
}

/**
 * Operator-facing view of one Recovery Details entry. Pure. Only the fields
 * named here are ever rendered: no absolute path, identity or hash exists in
 * the API, and nothing else of the entry is echoed.
 */
export function presentRecoveryEntry(entry, { recoveryRequired = false, projectId = null, readOnly = false } = {}) {
  const isGroup = entry?.kind === 'mutation-group';
  const operationLabel = recoveryOperationLabel(entry?.operation);
  const status = entryStatus(entry || {}, readOnly);
  const assetId = Number.isSafeInteger(entry?.assetId) && entry.assetId > 0 ? entry.assetId : null;
  return {
    key: isGroup ? `group:${entry.mutationGroupId}` : `evidence:${entry?.evidenceId}`,
    kind: isGroup ? 'mutation-group' : 'evidence',
    evidenceId: isGroup ? null : entry?.evidenceId ?? null,
    operationLabel,
    title: isGroup ? 'Unresolved project mutation' : recoveryArtifactRoleLabel(entry?.operation, entry?.artifactRole),
    statusLabel: status.label,
    statusTone: status.tone,
    paths: entryPaths(entry || {}),
    observationLabel: isGroup ? null : recoveryObservationLabel(entry?.observation),
    observedAt: isGroup ? null : entry?.observedAt ?? null,
    reasonText: isGroup ? null : recoveryRetentionReasonText(entry?.retentionReason),
    recordedAt: isGroup ? entry?.checkpointAt || entry?.createdAt || null : entry?.createdAt ?? null,
    recommendation: entryRecommendation(entry || {}, recoveryRequired, readOnly),
    canCleanup: !readOnly && recoveryEntryCanCleanup(entry),
    assetUrl: !isGroup && assetId !== null && projectId !== null ? assetViewerUrl(projectId, assetId) : null,
    technical: technicalDetails(entry || {}),
  };
}

const needsManualScan = (entry) => entry?.kind === 'mutation-group'
  || (entry?.kind === 'evidence' && entry.artifactClass === 'private'
    && (entry.lifecycle === 'recovery-critical' || entry.lifecycle === 'intent'));

/**
 * Top-of-dialog summary and the page's entry-point state, from one GET payload.
 * `readOnly` (archived) keeps the same entry-point state but never offers an
 * action the archived project cannot perform.
 */
export function presentRecoverySummary(details, { readOnly = false } = {}) {
  const recoveryRequired = details?.recoveryRequired === true;
  const entries = Array.isArray(details?.entries) ? details.entries : [];
  const entryPoint = recoveryRequired ? 'gated' : (entries.length > 0 ? 'evidence' : 'none');
  const paragraphs = [];
  let tone;
  if (readOnly) {
    tone = recoveryRequired ? 'warning' : (entries.length > 0 ? 'info' : 'success');
    paragraphs.push(entries.length > 0
      ? 'This archived project is read-only. Recovery information is available for review.'
      : 'This archived project is read-only. No registered recovery evidence is currently listed.');
    if (recoveryRequired) paragraphs.push('Recovery state for this project is unresolved.');
    return { tone, paragraphs, entryPoint, showManualScan: false, refreshIds: [] };
  }
  if (recoveryRequired) {
    tone = 'warning';
    paragraphs.push('Processing is blocked until you inspect the project and complete a successful manual scan.');
    if (entries.length === 0) {
      paragraphs.push('No registered recovery evidence is currently listed, but processing stays blocked until a manual scan succeeds.');
    }
  } else if (entries.length > 0) {
    tone = 'info';
    paragraphs.push('Processing can continue. Recovery evidence remains for review or safe cleanup.');
  } else {
    tone = 'success';
    paragraphs.push('No registered recovery evidence is currently listed. Processing is not blocked.');
  }
  return {
    tone,
    paragraphs,
    entryPoint,
    showManualScan: recoveryRequired || entries.some(needsManualScan),
    refreshIds: refreshableEvidenceIds(entries),
  };
}

const CLEANUP_REASON_TEXT = Object.freeze({
  'public-tracking': 'This record tracks project state, not a private cleanup file. Nothing was removed.',
  'recovery-critical': 'This recovery copy may hold content that exists nowhere else, so it was kept.',
  intent: 'The recovery state of this file is unresolved, so it was kept.',
  'checkpoint-active': 'A project change for this file is still unresolved. Run a manual scan first; nothing was removed.',
  'invalid-private-path': 'The recorded path is not a CreatorCrate temporary location, so nothing was removed.',
  'proof-incomplete': 'CreatorCrate does not have enough recorded proof to remove this file safely, so it was kept.',
  replaced: 'The path now contains a different file, so nothing was removed.',
  changed: 'The file contents changed, so nothing was removed.',
  unavailable: 'The file could not be inspected, so nothing was removed.',
  'ownership-unknown': 'CreatorCrate could not verify that it owns this file, so nothing was removed.',
  'cleanup-failed': 'The file could not be removed and was left in place.',
  'evidence-changed': 'The recovery record changed during cleanup, so nothing was removed.',
});

/** Human text for one WP7B cleanup result. Unknown statuses/reasons are never echoed. */
export function cleanupResultMessage(result) {
  if (result?.status === 'cleaned') return 'Cleanup completed.';
  if (result?.status === 'already-absent') return 'The recovery file was already absent; its recovery record was cleaned up.';
  if (result?.status === 'retained' || result?.status === 'blocked') {
    return Object.hasOwn(CLEANUP_REASON_TEXT, result.reason)
      ? CLEANUP_REASON_TEXT[result.reason]
      : 'Cleanup was not performed. The file was left in place.';
  }
  return RECOVERY_MESSAGES.cleanupFailed;
}

export function formatRecoveryTimestamp(value) {
  if (!nonEmpty(value)) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

// ─── DOM ─────────────────────────────────────────────────────────────────

function setVisible(node, visible) {
  if (!node) return;
  node.hidden = !visible;
  if (visible) node.removeAttribute?.('hidden');
  else node.setAttribute?.('hidden', '');
}

function setButtonBusy(button, busy, { busyLabel, idleLabel } = {}) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute?.('aria-disabled', String(busy));
  if (busy) button.setAttribute?.('aria-busy', 'true');
  else button.removeAttribute?.('aria-busy');
  if (busyLabel && idleLabel) button.textContent = busy ? busyLabel : idleLabel;
}

function el(document, tag, { className, text, attributes } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
  return node;
}

/**
 * Show exactly one page entry point for the GET state: the gated warning, the
 * restrained "evidence remains" link, or nothing. Applies to the page notice
 * and every Processing dialog footer entry.
 */
export function syncRecoveryEntryPoints(document, details) {
  const { entryPoint } = presentRecoverySummary(details);
  document.querySelectorAll?.('[data-recovery-details-entry]').forEach((container) => {
    container.setAttribute('data-recovery-state', entryPoint);
    setVisible(container, entryPoint !== 'none');
    container.querySelectorAll?.('[data-recovery-entry-variant]').forEach((variant) => {
      setVisible(variant, variant.getAttribute('data-recovery-entry-variant') === entryPoint);
    });
  });
  return entryPoint;
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

class RecoveryRequestError extends Error {
  constructor(status, code) {
    super('Recovery request failed.');
    this.status = status;
    this.code = code;
  }
}

function createController(document, root, deps) {
  const projectId = root.getAttribute('data-project-id');
  const csrf = root.getAttribute('data-csrf') || '';
  // Server-rendered from the project's archived state; never inferred from a 409.
  const readOnly = root.hasAttribute('data-recovery-details-read-only');
  const node = (name) => root.querySelector(`[data-recovery-details-${name}]`);
  const state = {
    details: null,
    loading: null,
    loadGeneration: 0,
    // Bumped by every completed action and every Processing sync so a GET
    // started before it is never reused (or rendered) after it.
    mutationSeq: 0,
    loadFailed: false,
    refreshing: false,
    scanning: false,
    cleaning: new Set(),
    // { evidenceId } while a cleanup may still restore focus; see onFocusIn.
    cleanupFocus: null,
  };

  async function request(url, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await deps.fetch(url, {
        method,
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new RecoveryRequestError(0, 'NETWORK');
    }
    const payload = await readJson(response);
    if (!response.ok || payload?.ok !== true) throw new RecoveryRequestError(response.status, payload?.error?.code);
    return payload;
  }

  function status(message) {
    const target = node('status');
    if (target) target.textContent = message || '';
  }

  function error(message) {
    const target = node('error');
    if (!target) return;
    const text = target.querySelector('[data-recovery-details-error-text]') || target;
    text.textContent = message || '';
    setVisible(target, Boolean(message));
  }

  function renderSummary(view) {
    const summary = node('summary');
    if (!summary) return;
    summary.className = `notice notice--${view.tone} processing-recovery-summary`;
    summary.replaceChildren(...view.paragraphs.map((text) => el(document, 'p', { text })));
  }

  function renderEntry(entry, recoveryRequired) {
    const view = presentRecoveryEntry(entry, { recoveryRequired, projectId, readOnly });
    const item = el(document, 'li', {
      className: `processing-recovery-entry processing-recovery-entry--${view.kind}`,
      attributes: { 'data-recovery-entry': view.key, 'data-recovery-entry-kind': view.kind },
    });

    const header = el(document, 'div', { className: 'processing-recovery-entry-header' });
    const heading = el(document, 'h3', { className: 'processing-recovery-entry-title' });
    heading.append(
      el(document, 'span', { className: 'processing-recovery-entry-operation', text: view.operationLabel }),
      el(document, 'span', { className: 'processing-recovery-entry-role', text: view.title }),
    );
    header.append(heading, el(document, 'span', {
      className: `status-badge status-badge--${view.statusTone} processing-recovery-entry-status`,
      text: view.statusLabel,
      attributes: { 'data-recovery-entry-status': '' },
    }));
    item.append(header);

    const facts = el(document, 'dl', { className: 'processing-recovery-entry-facts' });
    const fact = (label, value, { path = false, timestamp = null } = {}) => {
      facts.append(el(document, 'dt', { text: label }));
      const dd = el(document, 'dd');
      if (path) {
        dd.append(el(document, 'code', { className: 'processing-recovery-path', text: value }));
      } else if (timestamp) {
        dd.append(el(document, 'time', { text: value, attributes: { datetime: timestamp } }));
      } else {
        dd.textContent = value;
      }
      facts.append(dd);
    };
    view.paths.forEach(({ label, value }) => fact(label, value, { path: true }));
    if (view.observationLabel) {
      const checked = formatRecoveryTimestamp(view.observedAt);
      fact('File status', checked ? `${view.observationLabel} (checked ${checked})` : view.observationLabel);
    }
    if (view.reasonText) fact('Reason', view.reasonText);
    const recorded = formatRecoveryTimestamp(view.recordedAt);
    if (recorded) fact('Recorded', recorded, { timestamp: view.recordedAt });
    item.append(facts);

    item.append(el(document, 'p', {
      className: 'processing-recovery-entry-recommendation',
      text: view.recommendation,
      attributes: { 'data-recovery-entry-recommendation': '' },
    }));

    if (view.canCleanup || view.assetUrl) {
      const actions = el(document, 'div', { className: 'processing-recovery-entry-actions' });
      if (view.canCleanup) {
        const busy = state.cleaning.has(view.evidenceId);
        const button = el(document, 'button', {
          className: 'button button-small button-secondary',
          text: busy ? 'Cleaning up…' : 'Retry safe cleanup',
          attributes: { type: 'button', 'data-recovery-cleanup': view.evidenceId },
        });
        setButtonBusy(button, busy);
        button.addEventListener('click', (event) => {
          event?.preventDefault?.();
          void cleanup(view.evidenceId);
        });
        actions.append(button);
      }
      if (view.assetUrl) {
        actions.append(el(document, 'a', {
          className: 'button button-small button-secondary',
          text: 'Open related asset',
          attributes: { href: view.assetUrl, 'data-recovery-open-asset': '' },
        }));
      }
      item.append(actions);
    }

    if (view.technical.length > 0) {
      const details = el(document, 'details', { className: 'processing-recovery-entry-technical' });
      details.append(el(document, 'summary', { text: 'Technical details', attributes: { 'data-recovery-technical': '' } }));
      const list = el(document, 'dl');
      view.technical.forEach(({ label, value }) => {
        list.append(el(document, 'dt', { text: label }), el(document, 'dd', { text: value }));
      });
      details.append(list);
      item.append(details);
    }
    return item;
  }

  // Re-rendered entry controls, identified by entry key plus control name so
  // focus follows the same control onto its replacement.
  const ENTRY_CONTROLS = Object.freeze({
    cleanup: '[data-recovery-cleanup]',
    asset: '[data-recovery-open-asset]',
    technical: '[data-recovery-technical]',
  });

  /**
   * Semantic key of the focused element inside the re-rendered list:
   * `{ list: true }` for the list itself (the temporary fallback),
   * `{ entry, control }` for a known entry control, `{ entry }` for anything
   * else inside an entry. Controls outside the list survive a render as-is
   * and need no key.
   */
  function focusKey() {
    const active = document.activeElement;
    const list = node('list');
    if (!active || !list) return null;
    if (active === list) return { list: true };
    if (!list.contains?.(active)) return null;
    const entry = active.closest?.('[data-recovery-entry]')?.getAttribute('data-recovery-entry') ?? null;
    const control = Object.keys(ENTRY_CONTROLS).find((name) => active.matches?.(ENTRY_CONTROLS[name])) ?? null;
    return { entry, control };
  }

  const cleanupButton = (evidenceId) => Array.from(root.querySelectorAll('[data-recovery-cleanup]'))
    .find((button) => button.getAttribute('data-recovery-cleanup') === evidenceId) || null;
  const focusable = (target) => Boolean(target) && !target.disabled;
  const focusOn = (target) => target?.focus?.({ preventScroll: true });

  // The list while it has entries, else the dialog's Close; never <body>.
  function stableFallback() {
    const list = node('list');
    if (list?.querySelector('[data-recovery-entry]')) return list;
    return Array.from(root.querySelectorAll('[data-dialog-close]')).at(-1) || list;
  }

  // Focus the replacement of the control the key names. A control that is gone
  // or disabled (a busy cleanup button cannot take focus; browsers would drop
  // it to <body>) falls back to the list, or Close once no entry remains.
  function restoreFocus(key) {
    if (!key) return;
    if (key.list) {
      focusOn(node('list'));
      return;
    }
    const entry = Array.from(node('list')?.children || [])
      .find((item) => item.getAttribute?.('data-recovery-entry') === key.entry);
    const target = entry && key.control ? entry.querySelector(ENTRY_CONTROLS[key.control]) : null;
    focusOn(focusable(target) ? target : stableFallback());
  }

  /**
   * Cleanup focus ownership. A cleanup started from its focused button owns
   * focus only along its own path: that button, then the list it is parked on
   * while the button is disabled. The first focus move anywhere else (another
   * control, the dialog closing to its opener) cancels the intent for good,
   * whether the POST or the follow-up GET is still pending. Only one intent
   * exists at a time; a newer cleanup replaces it.
   */
  function onFocusIn(event) {
    const intent = state.cleanupFocus;
    const target = event?.target;
    if (!intent || !target) return;
    if (target === node('list') || target.getAttribute?.('data-recovery-cleanup') === intent.evidenceId) return;
    state.cleanupFocus = null;
  }

  /**
   * After a cleanup whose button had focus settles (POST plus authoritative
   * GET, or a failed POST), and only while it still owns focus: the row's
   * enabled button, else the list while entries remain, else Close.
   */
  function settleCleanupFocus(intent) {
    if (!intent || state.cleanupFocus !== intent) return;
    state.cleanupFocus = null;
    const active = document.activeElement;
    const button = cleanupButton(intent.evidenceId);
    if (active && active !== document.body && active !== node('list') && active !== button) return;
    focusOn(focusable(button) ? button : stableFallback());
  }

  function render() {
    const details = state.details;
    const list = node('list');
    const focus = focusKey();
    if (!details) {
      renderSummary(state.loading || !state.loadFailed
        ? { tone: 'info', paragraphs: [RECOVERY_MESSAGES.loading] }
        : { tone: 'error', paragraphs: [RECOVERY_MESSAGES.loadFailed] });
      list?.replaceChildren();
    } else {
      const view = presentRecoverySummary(details, { readOnly });
      renderSummary(view);
      list?.replaceChildren(...details.entries.map((entry) => renderEntry(entry, details.recoveryRequired)));
    }
    const view = details ? presentRecoverySummary(details, { readOnly }) : null;
    const refresh = node('refresh');
    setVisible(refresh, Boolean(!readOnly && view && view.refreshIds.length > 0));
    setButtonBusy(refresh, state.refreshing, { busyLabel: 'Refreshing…', idleLabel: 'Refresh' });
    setVisible(node('manual-scan-section'), Boolean(!readOnly && view?.showManualScan));
    setButtonBusy(node('manual-scan'), state.scanning, { busyLabel: 'Scanning…', idleLabel: 'Run Manual Scan' });
    if (state.loading && !state.refreshing && !state.scanning) root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
    restoreFocus(focus);
  }

  function applyDetails(payload) {
    if (state.loadFailed && state.details) error('');
    state.loadFailed = false;
    state.details = {
      recoveryRequired: payload.recoveryRequired === true,
      entries: Array.isArray(payload.entries) ? payload.entries : [],
    };
    syncRecoveryEntryPoints(document, state.details);
    render();
  }

  /** DB-only GET. A GET already in flight is shared unless an action completed after it began. */
  function load() {
    if (state.loading && state.loading.seq === state.mutationSeq) return state.loading.promise;
    const generation = ++state.loadGeneration;
    const seq = state.mutationSeq;
    const promise = (async () => {
      try {
        const payload = await request(recoveryUrl(projectId));
        if (generation !== state.loadGeneration) return state.details;
        applyDetails(payload);
        return state.details;
      } catch {
        if (generation !== state.loadGeneration) return state.details;
        // Entry points and any listed entries keep their last server-provided
        // state; nothing is cleared locally.
        state.loadFailed = true;
        if (state.details) error(RECOVERY_MESSAGES.loadFailed);
        return null;
      } finally {
        if (generation === state.loadGeneration) {
          const again = state.loading?.syncAgain;
          state.loading = null;
          render();
          if (again) void syncFromProcessing();
        }
      }
    })();
    state.loading = { seq, promise, afterSync: false, syncAgain: false };
    render();
    return promise;
  }

  /**
   * GET whose request begins now: any GET already in flight can no longer be
   * reused, and its response is ignored (its generation is superseded). Used
   * after every Recovery Details action and for Processing sync.
   */
  function loadFresh() {
    state.mutationSeq += 1;
    return load();
  }

  /**
   * Processing reported that recovery state may have changed (gate reported,
   * Apply settled). A GET that began before this signal cannot satisfy it, so
   * a fresh GET always starts, unless the in-flight GET was itself started by
   * an earlier sync: then this signal is coalesced into one trailing fresh GET
   * once that request settles (N signals during one sync GET => at most one
   * more GET). GET only: never Refresh, Cleanup or Manual Scan, and Processing
   * Preview/Apply state is not touched.
   */
  function syncFromProcessing() {
    const current = state.loading;
    if (current?.afterSync && current.seq === state.mutationSeq) {
      current.syncAgain = true;
      return current.promise;
    }
    const promise = loadFresh();
    state.loading.afterSync = true;
    return promise;
  }

  function errorMessage(err, fallback) {
    return err?.code === 'PROJECT_OPERATION_IN_PROGRESS' ? RECOVERY_MESSAGES.busy : fallback;
  }

  async function refresh() {
    if (readOnly || state.refreshing) return;
    const ids = state.details ? refreshableEvidenceIds(state.details.entries) : [];
    error('');
    if (ids.length === 0) {
      status(RECOVERY_MESSAGES.nothingToRefresh);
      return;
    }
    state.refreshing = true;
    status(RECOVERY_MESSAGES.refreshing);
    render();
    try {
      await request(recoveryUrl(projectId, 'refresh'), { method: 'POST', body: { evidenceIds: ids } });
      state.refreshing = false;
      status(RECOVERY_MESSAGES.refreshed);
      await loadFresh();
    } catch (err) {
      state.refreshing = false;
      status('');
      error(err?.status === 404 && err.code === 'RECOVERY_EVIDENCE_NOT_FOUND'
        ? `${RECOVERY_MESSAGES.refreshFailed} The list changed; reopen Recovery Details to see the current entries.`
        : errorMessage(err, RECOVERY_MESSAGES.refreshFailed));
      render();
    }
  }

  async function cleanup(evidenceId) {
    if (readOnly || state.cleaning.has(evidenceId)) return;
    const listed = state.details?.entries.find((entry) => entry.kind === 'evidence' && entry.evidenceId === evidenceId);
    if (!recoveryEntryCanCleanup(listed)) return;
    // Captured before the busy re-render replaces (and disables) the button.
    const intent = document.activeElement?.getAttribute?.('data-recovery-cleanup') === evidenceId
      ? { evidenceId }
      : null;
    if (intent) state.cleanupFocus = intent;
    state.cleaning.add(evidenceId);
    error('');
    status(RECOVERY_MESSAGES.cleaning);
    render();
    let message;
    try {
      const payload = await request(recoveryUrl(projectId, 'cleanup'), { method: 'POST', body: { evidenceIds: [evidenceId] } });
      const result = Array.isArray(payload.results) ? payload.results.find((entry) => entry?.evidenceId === evidenceId) : null;
      message = cleanupResultMessage(result);
    } catch (err) {
      state.cleaning.delete(evidenceId);
      status('');
      error(err?.status === 404 && err.code === 'RECOVERY_EVIDENCE_NOT_FOUND'
        ? 'This recovery record no longer exists.'
        : errorMessage(err, RECOVERY_MESSAGES.cleanupFailed));
      render();
      settleCleanupFocus(intent);
      return;
    }
    // The row stays until the server's current state says otherwise.
    state.cleaning.delete(evidenceId);
    status(message);
    await loadFresh();
    settleCleanupFocus(intent);
  }

  async function manualScan() {
    if (readOnly || state.scanning) return;
    state.scanning = true;
    error('');
    status(RECOVERY_MESSAGES.scanning);
    render();
    try {
      await request(manualScanUrl(projectId), { method: 'POST', body: {} });
    } catch (err) {
      state.scanning = false;
      status('');
      error(err?.status === 409 && err.code === 'PROJECT_ARCHIVED'
        ? 'Scanning is not available for archived projects.'
        : RECOVERY_MESSAGES.scanFailed);
      render();
      return;
    }
    state.scanning = false;
    status('Manual scan complete.');
    deps.refreshAssets(document);
    await loadFresh();
  }

  // A reopened dialog shows only what the new GET says, not an earlier action's message.
  function opened() {
    if (state.refreshing || state.scanning || state.cleaning.size > 0) return load();
    status('');
    error('');
    return load();
  }

  return { load, loadFresh, syncFromProcessing, opened, refresh, cleanup, manualScan, onFocusIn, state, readOnly };
}

/**
 * @param {Document} scope
 * @param {{ fetch?: Function, openDialog?: Function, refreshAssets?: Function }} [deps]
 */
export function enhanceProcessingRecoveryDetails(scope = globalThis.document, deps = {}) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument || globalThis.document;
  const root = document?.querySelector?.('[data-recovery-details]');
  if (!root || isEnhancementBound(root, 'processingRecoveryDetailsBound')) return null;
  markEnhancementBound(root, 'processingRecoveryDetailsBound');
  const resolved = {
    fetch: deps.fetch || ((...args) => globalThis.fetch(...args)),
    openDialog: deps.openDialog || openAppDialogById,
    refreshAssets: deps.refreshAssets || ((doc) => {
      try { refreshProjectAssetsLiveRegion(doc); } catch { /* the scan itself succeeded */ }
    }),
  };
  const controller = createController(document, root, resolved);

  // Opening never inspects files: it only reads the stored state again.
  document.addEventListener('click', (event) => {
    const trigger = event.target?.closest?.(`[data-dialog-open="${RECOVERY_DETAILS_DIALOG_ID}"]`);
    if (!trigger) return;
    if (!document.getElementById?.(RECOVERY_DETAILS_DIALOG_ID)?.__creatorCrateAppDialogState) {
      event.preventDefault?.();
      resolved.openDialog(document, RECOVERY_DETAILS_DIALOG_ID, trigger);
    }
    void controller.opened();
  });
  document.addEventListener(RECOVERY_DETAILS_SYNC_EVENT, () => { void controller.syncFromProcessing(); });
  // Any focus move, by keyboard, pointer or script, may cancel a cleanup's focus intent.
  document.addEventListener('focusin', controller.onFocusIn);

  root.querySelector('[data-recovery-details-refresh]')?.addEventListener('click', (event) => {
    event?.preventDefault?.();
    void controller.refresh();
  });
  root.querySelector('[data-recovery-details-manual-scan]')?.addEventListener('click', (event) => {
    event?.preventDefault?.();
    void controller.manualScan();
  });

  // One DB-only read decides whether the page advertises Recovery Details.
  void controller.load();
  return controller;
}
