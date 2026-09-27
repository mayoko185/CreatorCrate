import { closeAppDialogById, openAppDialogById } from './app-dialogs.js';
import { requestAppConfirmation } from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';

/**
 * Project Detail UI for explicit project-folder ownership recovery (PM-1C2B).
 *
 * The page renders the ownership notice only when durable SQLite state says
 * the project needs attention; this client fetches the detailed status (which
 * reads the folder's ownership marker) only when the operator opens the
 * dialog, once per open or explicit "Check again", and never polls. Recovery
 * is POSTed only after the shared confirmation dialog, carrying exactly the
 * `statusVersion` of the status on screen; a stale or failed attempt is never
 * retried automatically.
 */

const DIALOG_ID = 'project-ownership-dialog';
const RETRY_LATER_LEAD = 'Project storage is temporarily unavailable. CreatorCrate will retry automatically.';

const RETRY_LATER_DETAILS = {
  maintenance: 'CreatorCrate is in maintenance mode.',
  'automatic-adoption-pending': "CreatorCrate hasn't finished checking this project's folder yet.",
  'project-busy': 'Another operation is running on this project. Try again when it finishes.',
  'projects-root-unavailable': "The projects share can't be reached right now.",
  'project-directory-missing': "The project folder can't be found right now. If the projects share is connected, check that the folder still exists.",
};
const RETRY_LATER_DEFAULT = "The project folder couldn't be read or updated right now.";

const MARKER_DETAILS = {
  missing: "The project folder has no CreatorCrate ownership marker.",
  malformed: "The project folder's CreatorCrate ownership marker is damaged or unreadable.",
  unclaimed: "The project folder has a CreatorCrate ownership marker that isn't linked to any project.",
  different: "The project folder's CreatorCrate ownership marker doesn't match this project.",
  matching: "The project folder's ownership marker matches, but CreatorCrate hasn't finished linking it.",
};

const BLOCKED_DETAILS = {
  'marker-token-in-use': "The folder's ownership marker belongs to another CreatorCrate project. Check that this project's folder wasn't copied from or swapped with another project's folder.",
  'marker-unsafe': "The folder's ownership marker isn't a regular file.",
  'project-directory-unsafe': "The stored project folder isn't a safe project folder.",
  'project-directory-invalid': "The stored project folder isn't a valid project folder location.",
  'binding-without-directory': 'This project has no stored folder, but ownership records exist for it.',
};

export const PROJECT_OWNERSHIP_REPLACEMENT_WARNING = 'The existing CreatorCrate ownership marker will be set aside and replaced.';

/**
 * Operator-facing view of a public recovery status. Pure: no DOM. Reason
 * codes are mapped to plain text; anything unknown falls back to the
 * action's generic wording rather than being echoed.
 */
export function presentProjectOwnershipRecovery(recovery) {
  const action = recovery?.action;
  const reason = recovery?.reason;
  if (action === 'none') {
    return {
      tone: 'success',
      paragraphs: ['Project folder ownership is established. No recovery is needed.'],
      canRecover: false, canCheck: false,
    };
  }
  if (action === 'recover') {
    const paragraphs = ["CreatorCrate can't confirm that this project's stored folder belongs to it."];
    if (MARKER_DETAILS[recovery.marker]) paragraphs.push(MARKER_DETAILS[recovery.marker]);
    paragraphs.push('Recovering confirms that the currently stored folder is the correct folder for this project '
      + "and sets up CreatorCrate's ownership marker there. No files are moved, no other folder is chosen, "
      + 'and no project details are imported from the folder.');
    if (recovery.plan === 'replace-marker') paragraphs.push(PROJECT_OWNERSHIP_REPLACEMENT_WARNING);
    return { tone: 'warning', paragraphs, canRecover: true, canCheck: false };
  }
  if (action === 'blocked') {
    return {
      tone: 'error',
      paragraphs: [
        "CreatorCrate can't safely recover ownership of this project's folder.",
        BLOCKED_DETAILS[reason] || "The project folder's state needs manual attention.",
        'Resolve the folder on the projects share, then check again.',
      ],
      canRecover: false, canCheck: true,
    };
  }
  return {
    tone: 'info',
    paragraphs: [RETRY_LATER_LEAD, RETRY_LATER_DETAILS[reason] || RETRY_LATER_DEFAULT],
    canRecover: false, canCheck: true,
  };
}

export function projectOwnershipConfirmationMessage(recovery, projectTitle = '') {
  const project = projectTitle ? `“${projectTitle}”` : 'this CreatorCrate project';
  const message = [
    `Confirm that the project's currently stored folder belongs to ${project}.`,
    "Recovery will establish or repair CreatorCrate's ownership marker for that folder.",
    'It will not import legacy project metadata, move files, or choose a different folder.',
  ];
  if (recovery?.plan === 'replace-marker') message.push(PROJECT_OWNERSHIP_REPLACEMENT_WARNING);
  return message.join(' ');
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function setVisible(node, visible) {
  if (!node) return;
  node.hidden = !visible;
  if (visible) node.removeAttribute?.('hidden');
  else node.setAttribute?.('hidden', '');
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

function createController(document, body, deps) {
  const node = (name) => body.querySelector(`[data-project-ownership-${name}]`)
    || document.querySelector?.(`#${DIALOG_ID} [data-project-ownership-${name}]`);
  const projectId = body.getAttribute('data-project-id');
  const projectTitle = body.getAttribute('data-project-title') || '';
  const url = `/projects/${encodeURIComponent(projectId)}/ownership-recovery`;
  const state = { recovery: null, busy: false, generation: 0 };

  const buttons = () => ({ recover: node('recover'), check: node('check') });

  // Same contract as the shared dialog status: the dialog's
  // `data-dialog-state` carries the error styling.
  function status(message, isError = false) {
    setText(node('status'), message);
    const dialog = document.getElementById?.(DIALOG_ID);
    if (message) dialog?.setAttribute?.('data-dialog-state', isError ? 'error' : 'pending');
    else dialog?.removeAttribute?.('data-dialog-state');
  }

  function setBusy(busy) {
    state.busy = busy;
    if (busy) body.setAttribute('aria-busy', 'true');
    else body.removeAttribute('aria-busy');
    Object.values(buttons()).forEach((button) => { if (button) button.disabled = busy; });
  }

  function renderView(view) {
    const summary = node('summary');
    if (summary) {
      summary.className = `notice notice--${view.tone}`;
      summary.replaceChildren(...view.paragraphs.map((text) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        return paragraph;
      }));
    }
    const { recover, check } = buttons();
    setVisible(recover, view.canRecover);
    setVisible(check, view.canCheck);
  }

  // `recovery` becomes the status the operator is reviewing: the only one
  // whose statusVersion a confirmation may carry.
  function show(recovery) {
    state.recovery = recovery || null;
    renderView(presentProjectOwnershipRecovery(recovery));
  }

  // `action: none` is healthy from the operator's perspective whatever
  // internal classification remains: the page notice is stale and no
  // recovery action is offered.
  const isHealthy = (recovery) => recovery?.action === 'none';

  // Retry-later view without an actionable status: nothing can be confirmed
  // until the operator checks again.
  function showUnavailable(reason) {
    state.recovery = null;
    renderView(presentProjectOwnershipRecovery({ action: 'retry-later', reason }));
  }

  function resolveNotice(message) {
    const notice = document.querySelector?.('[data-project-ownership-notice]');
    if (!notice) return;
    if (!message) {
      notice.remove?.();
      return;
    }
    notice.className = 'notice notice--success project-ownership-notice';
    notice.setAttribute('data-project-ownership-notice', 'resolved');
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    notice.replaceChildren(paragraph);
  }

  async function load() {
    const generation = ++state.generation;
    state.recovery = null;
    renderView({ tone: 'info', paragraphs: ['Checking project storage…'], canRecover: false, canCheck: false });
    status('');
    setBusy(true);
    try {
      const response = await deps.fetch(url, {
        headers: { Accept: 'application/json' }, credentials: 'same-origin',
      });
      const payload = await readJson(response);
      if (generation !== state.generation) return;
      if (!response.ok || payload?.status !== 'success' || !payload.recovery) throw new Error('Status unavailable.');
      show(payload.recovery);
      if (isHealthy(payload.recovery)) resolveNotice(null);
    } catch {
      if (generation !== state.generation) return;
      showUnavailable(null);
      status("Couldn't check project storage. Try again.", true);
    } finally {
      if (generation === state.generation) setBusy(false);
    }
  }

  async function submit(statusVersion) {
    const generation = ++state.generation;
    status('');
    setBusy(true);
    let response;
    let payload;
    try {
      response = await deps.fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams({ _csrf: node('csrf')?.value || '', statusVersion }).toString(),
        credentials: 'same-origin',
      });
      payload = await readJson(response);
    } catch {
      payload = null;
    }
    if (generation === state.generation) setBusy(false);
    if (generation !== state.generation) return payload;

    if (response?.ok && payload?.status === 'success') {
      show(payload.recovery);
      if (isHealthy(payload.recovery)) {
        resolveNotice('Project folder ownership recovered.');
        deps.closeDialog(document, DIALOG_ID);
      }
      return payload;
    }
    switch (payload?.code) {
      case 'RECOVERY_STATE_CHANGED':
        if (payload.recovery) show(payload.recovery);
        else showUnavailable(null);
        if (isHealthy(state.recovery)) resolveNotice(null);
        else status('Project storage changed since you reviewed it. Review the current status and confirm again.');
        break;
      case 'RECOVERY_BLOCKED':
        show(payload.recovery || { action: 'blocked', reason: payload.reason });
        break;
      case 'RECOVERY_NOT_REQUIRED':
        show(payload.recovery || { action: 'none', classification: null });
        if (isHealthy(state.recovery)) resolveNotice(null);
        break;
      case 'RECOVERY_UNAVAILABLE':
        showUnavailable(payload.reason);
        break;
      default:
        status(response?.status === 404 ? 'Project not found.' : "Project ownership couldn't be recovered. Try again.", true);
    }
    return payload;
  }

  async function recover(opener) {
    const reviewed = state.recovery;
    if (state.busy || reviewed?.action !== 'recover') return;
    const confirmed = await deps.confirm(document, {
      title: 'Recover project ownership',
      message: projectOwnershipConfirmationMessage(reviewed, projectTitle),
      confirmLabel: 'Recover ownership',
      opener,
      destructive: reviewed.plan === 'replace-marker',
    });
    // Only the exact status that was on screen when confirmed may be sent.
    if (!confirmed || state.recovery !== reviewed || state.busy) return;
    await submit(reviewed.statusVersion);
  }

  return { load, recover, buttons, state };
}

/**
 * @param {Document} scope
 * @param {{ fetch?: Function, openDialog?: Function, closeDialog?: Function, confirm?: Function }} [deps]
 */
export function enhanceProjectOwnershipRecovery(scope = globalThis.document, deps = {}) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument || globalThis.document;
  const body = document?.querySelector?.('[data-project-ownership-dialog]');
  if (!body || isEnhancementBound(body, 'projectOwnershipRecoveryBound')) return null;
  markEnhancementBound(body, 'projectOwnershipRecoveryBound');
  const resolved = {
    fetch: deps.fetch || ((...args) => globalThis.fetch(...args)),
    openDialog: deps.openDialog || openAppDialogById,
    closeDialog: deps.closeDialog || closeAppDialogById,
    confirm: deps.confirm || requestAppConfirmation,
  };
  const controller = createController(document, body, resolved);

  document.querySelectorAll?.('[data-project-ownership-open]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.preventDefault?.();
      if (controller.state.busy) return;
      resolved.openDialog(document, DIALOG_ID, trigger);
      controller.load();
    });
  });
  const { recover, check } = controller.buttons();
  recover?.addEventListener('click', (event) => {
    event.preventDefault?.();
    controller.recover(recover);
  });
  check?.addEventListener('click', (event) => {
    event.preventDefault?.();
    if (!controller.state.busy) controller.load();
  });
  return controller;
}
