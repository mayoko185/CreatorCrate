import { refreshPageDeletionParent } from './chapter-dialogs.js';
import { readPageDeletionStatus, refusedWithoutWriting } from './dialog-record-delete.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// Undo on a Book or Chapter whose Page was deleted. Each active deletion this owner
// has in this parent gets its own alert in the existing notice style, found by the
// discovery read on every load, so a refresh or a return finds it again. The action
// token is read only when Undo is activated and lives only in that call. The restore
// POST is sent once per activation and never repeated: an uncertain answer is settled
// by reading the status, and the parent is brought up to date by reads alone.
const DELETION_ID = /^[0-9a-f]{64}$/;
const PAGE_URL = /^\/notes\/[1-9]\d*$/;
const DISMISSED_KEY = 'creatorcrate.pageDeletionUndo.dismissed';
const DISMISSED_LIMIT = 50;
const RETRY_KEY = 'retryButton';
const CLOCK_INTERVAL_MS = 30_000;
// Past the deadline by this much the server, not this clock, says it has ended.
const EXPIRY_CHECK_GRACE_MS = 500;
const VARIANTS = ['notice--success', 'notice--warning', 'notice--error'];
const HEADING_ACTION_SELECTOR = '.page-heading [data-dialog-open], [data-book-detail-toolbar] [data-dialog-open]';

const controllers = new WeakMap();

function readDismissed(ctrl) {
  try {
    const stored = JSON.parse(ctrl.window.sessionStorage.getItem(DISMISSED_KEY) || '[]');
    if (Array.isArray(stored)) stored.filter((id) => DELETION_ID.test(id)).forEach((id) => ctrl.dismissed.add(id));
  } catch { /* Without storage a dismissal lasts as long as this document. */ }
  return ctrl.dismissed;
}

// Only public locators, and only in this tab. The server's record is untouched.
function rememberDismissed(ctrl, id) {
  ctrl.dismissed.add(id);
  try {
    ctrl.window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ctrl.dismissed].slice(-DISMISSED_LIMIT)));
  } catch { /* As above. */ }
}

function pageName(entry) {
  return entry.title ? `Page “${entry.title}”` : 'This Page';
}

function deadlineText(ctrl, entry) {
  if (entry.expiresAt <= ctrl.window.Date.now()) return '';
  const time = new ctrl.window.Date(entry.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return ` until ${time}`;
}

function remainingText(ctrl, entry) {
  const remaining = entry.expiresAt - ctrl.window.Date.now();
  if (remaining <= 0) return '';
  if (remaining < 60_000) return ' (less than a minute left)';
  const minutes = Math.ceil(remaining / 60_000);
  return ` (about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left)`;
}

function createAction(ctrl, { label, ariaLabel, attribute, onClick }) {
  const button = ctrl.document.createElement('button');
  button.type = 'button';
  button.className = 'button button-small button-secondary';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.setAttribute(attribute, '');
  button.addEventListener('click', onClick);
  return button;
}

function regionFor(ctrl) {
  if (!ctrl.region) {
    ctrl.region = ctrl.document.createElement('div');
    ctrl.region.className = 'page-deletion-undo-alerts';
    ctrl.region.setAttribute('data-page-deletion-undo-alerts', '');
    ctrl.root.after(ctrl.region);
  }
  return ctrl.region;
}

function firstAction(entry) {
  if (entry[RETRY_KEY]) return entry[RETRY_KEY];
  if (!entry.view.hidden) return entry.view;
  if (!entry.undo.hidden) return entry.undo;
  return entry.dismiss;
}

// The one way an alert changes. Focus held by a control this change takes away goes
// to what the alert now offers; focus the user has moved elsewhere stays there.
function show(ctrl, entry, {
  message, variant = 'success', undo = false, pending = false, view = null, clock = false, retry = null,
}) {
  const active = ctrl.document.activeElement;
  const heldNow = active === entry.undo && (!undo || pending || Boolean(view) || Boolean(retry));
  const holdingFocus = heldNow
    || (entry.holdFocus && (active === ctrl.document.body || !active || entry.alert.contains(active)));
  removeStatusRetry(entry, RETRY_KEY);
  entry.alert.classList.remove(...VARIANTS);
  entry.alert.classList.add(`notice--${variant}`);
  entry.message.textContent = message;
  entry.actionable = undo && !pending;
  entry.clock.hidden = !clock;
  entry.remaining.hidden = !clock;
  paintClock(ctrl, entry);
  entry.undo.hidden = !undo;
  entry.undo.setAttribute('aria-disabled', String(pending));
  entry.view.hidden = !view;
  if (view) entry.view.href = view;
  entry.dismiss.setAttribute('aria-disabled', String(entry.busy));
  if (retry) {
    showStatusRetry({
      state: entry,
      status: entry.text,
      mount: entry.actions,
      attribute: 'data-page-deletion-undo-retry',
      key: RETRY_KEY,
      label: retry.label,
      onRetry: ({ wasFocused }) => {
        entry.holdFocus = wasFocused;
        retry.onRetry();
      },
    })?.classList.add('button-small');
  }
  if (holdingFocus) firstAction(entry).focus?.({ preventScroll: true });
  entry.holdFocus = holdingFocus && pending;
}

function paintClock(ctrl, entry) {
  if (entry.clock.hidden) return;
  entry.clock.textContent = ` Undo is available${deadlineText(ctrl, entry)}`;
  entry.remaining.textContent = `${remainingText(ctrl, entry)}.`;
}

function showAvailable(ctrl, entry, lead = `${pageName(entry)} deleted.`, variant = 'success') {
  show(ctrl, entry, { message: lead, variant, undo: true, clock: true });
  scheduleExpiryCheck(ctrl, entry);
}

function close(ctrl, entry) {
  ctrl.window.clearTimeout(entry.timer);
  entry.timer = null;
  entry.actionable = false;
  stopClockIfIdle(ctrl);
}

function showExpired(ctrl, entry) {
  close(ctrl, entry);
  show(ctrl, entry, {
    message: `${pageName(entry)}: Undo expired. The Page remains deleted.`,
    variant: 'warning',
  });
}

function showUnavailable(ctrl, entry) {
  close(ctrl, entry);
  show(ctrl, entry, {
    message: `${pageName(entry)}: this deletion cannot be undone from here.`,
    variant: 'warning',
  });
}

function showUnauthorized(ctrl, entry) {
  close(ctrl, entry);
  show(ctrl, entry, {
    message: `${pageName(entry)}: your session could not be verified, so nothing was restored. Reload this page after signing in to check again.`,
    variant: 'error',
  });
}

async function syncParent(ctrl, entry, confirmed, view) {
  entry.busy = true;
  show(ctrl, entry, { message: `${confirmed} Refreshing this page…`, pending: true, view });
  const result = await refreshPageDeletionParent(ctrl.document, ctrl.parentUrl);
  entry.busy = false;
  if (result === false) {
    show(ctrl, entry, {
      message: `${confirmed} This page could not refresh, so its list may be out of date.`,
      view,
      retry: { label: 'Retry refresh', onRetry: () => syncParent(ctrl, entry, confirmed, view) },
    });
    return;
  }
  show(ctrl, entry, { message: confirmed, view });
}

function confirmedPageUrl(entry, payload) {
  const url = payload?.page?.url;
  return typeof url === 'string' && PAGE_URL.test(url) ? url : entry.page;
}

function showRestored(ctrl, entry, payload) {
  close(ctrl, entry);
  return syncParent(ctrl, entry, `${pageName(entry)} restored.`, confirmedPageUrl(entry, payload));
}

// A receipt says what happened earlier, not that the Page is still there.
async function showAlreadyRestored(ctrl, entry, payload) {
  close(ctrl, entry);
  const url = confirmedPageUrl(entry, payload);
  entry.busy = true;
  show(ctrl, entry, { message: `${pageName(entry)} was already restored. Checking it…`, pending: true });
  let gone = false;
  try {
    const response = await ctrl.window.fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    });
    gone = response.status === 404;
  } catch { /* Reported as the receipt alone, with its link. */ }
  entry.busy = false;
  if (gone) {
    show(ctrl, entry, { message: `${pageName(entry)} was already restored, but is no longer available.`, variant: 'warning' });
    return;
  }
  await syncParent(ctrl, entry, `${pageName(entry)} was already restored.`, url);
}

// What a status read means for an alert whose last action changed nothing it knows of.
function settleFromStatus(ctrl, entry, status, onUnknown) {
  if (status.state === 'restored') return showAlreadyRestored(ctrl, entry, status.payload);
  if (status.state === 'expired') return showExpired(ctrl, entry);
  if (status.state === 'unavailable') return showUnavailable(ctrl, entry);
  if (status.state === 'unauthorized') return showUnauthorized(ctrl, entry);
  return onUnknown();
}

async function readStatus(ctrl, entry) {
  return readPageDeletionStatus(ctrl.window, entry.statusUrl);
}

// A read only: nothing is restored however it answers.
async function recheck(ctrl, entry) {
  entry.busy = true;
  show(ctrl, entry, {
    message: `${pageName(entry)}: checking whether Undo is still available…`, undo: true, pending: true,
  });
  const status = await readStatus(ctrl, entry);
  entry.busy = false;
  if (status.state === 'available') {
    showAvailable(ctrl, entry);
    return;
  }
  await settleFromStatus(ctrl, entry, status, () => show(ctrl, entry, {
    message: `${pageName(entry)} remains deleted. Could not check whether Undo is still available.`,
    variant: 'warning',
    retry: { label: 'Check again', onRetry: () => recheck(ctrl, entry) },
  }));
}

// Reads until the answer is known. The POST may have committed, so Undo stays away
// until a read says it did not.
async function reconcileRestore(ctrl, entry) {
  entry.busy = true;
  show(ctrl, entry, { message: `Could not confirm whether ${pageName(entry)} was restored. Checking…`, variant: 'warning', pending: true });
  const status = await readStatus(ctrl, entry);
  entry.busy = false;
  if (status.state === 'restored') {
    await showRestored(ctrl, entry, status.payload);
    return;
  }
  if (status.state === 'available') {
    showAvailable(ctrl, entry, `The restore was not confirmed, and ${pageName(entry)} is still deleted.`, 'warning');
    return;
  }
  await settleFromStatus(ctrl, entry, status, () => show(ctrl, entry, {
    message: `Could not confirm whether ${pageName(entry)} was restored, and it could not be checked. Nothing will be sent again.`,
    variant: 'warning',
    retry: { label: 'Check again', onRetry: () => reconcileRestore(ctrl, entry) },
  }));
}

function refusalMessage(ctrl, entry, payload) {
  const message = `${pageName(entry)}: ${payload?.message || 'it could not be restored.'}`;
  if (payload?.code !== 'UNDO_ORDER_CHANGED') return message;
  const newer = [...ctrl.entries.values()]
    .filter((other) => other !== entry && other.actionable && other.createdAt > entry.createdAt)
    .pop();
  return newer
    ? `${message} Undo the newer deletion of ${pageName(newer)} first, then try again.`
    : `${message} If you deleted other Pages here more recently, undo those first.`;
}

async function postRestore(ctrl, entry, undoToken) {
  const body = new ctrl.window.URLSearchParams({
    _csrf: ctrl.document.querySelector('input[name="_csrf"]')?.value || '',
    undoToken,
  });
  let response;
  let payload = null;
  try {
    response = await ctrl.window.fetch(`${entry.statusUrl}/restore`, {
      method: 'POST',
      body,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    });
    payload = await response.json().catch(() => null);
  } catch {
    await reconcileRestore(ctrl, entry);
    return;
  }
  if (response.ok && payload?.status === 'restored') {
    await showRestored(ctrl, entry, payload);
    return;
  }
  if (response.status === 401 || response.status === 403) {
    entry.busy = false;
    showUnauthorized(ctrl, entry);
    return;
  }
  if (!refusedWithoutWriting(payload, response)) {
    await reconcileRestore(ctrl, entry);
    return;
  }
  entry.busy = false;
  if (payload.code === 'UNDO_ALREADY_RESTORED') await showAlreadyRestored(ctrl, entry, payload);
  else if (payload.code === 'UNDO_EXPIRED') showExpired(ctrl, entry);
  else if (payload.code === 'UNDO_UNAVAILABLE') showUnavailable(ctrl, entry);
  else showAvailable(ctrl, entry, refusalMessage(ctrl, entry, payload), 'warning');
}

async function activateUndo(ctrl, entry) {
  if (entry.busy || !entry.actionable) return;
  entry.busy = true;
  ctrl.window.clearTimeout(entry.timer);
  show(ctrl, entry, { message: `Restoring ${pageName(entry)}…`, undo: true, pending: true });
  const status = await readStatus(ctrl, entry);
  if (status.state === 'available') {
    await postRestore(ctrl, entry, status.payload.undoToken);
    return;
  }
  entry.busy = false;
  await settleFromStatus(ctrl, entry, status, () => show(ctrl, entry, {
    message: `${pageName(entry)} remains deleted. Could not check whether Undo is still available, so nothing was sent.`,
    variant: 'warning',
    retry: { label: 'Check again', onRetry: () => recheck(ctrl, entry) },
  }));
}

function scheduleExpiryCheck(ctrl, entry) {
  ctrl.window.clearTimeout(entry.timer);
  const remaining = entry.expiresAt - ctrl.window.Date.now();
  // Already past on this clock and still open on the server: this clock is off, and
  // activating Undo reads the status anyway.
  if (entry.checkedPastDeadline && remaining <= 0) return;
  entry.timer = ctrl.window.setTimeout(() => {
    if (entry.busy || !entry.actionable) return;
    entry.checkedPastDeadline = true;
    void recheck(ctrl, entry);
  }, Math.max(0, remaining) + EXPIRY_CHECK_GRACE_MS);
}

function tickClocks(ctrl) {
  ctrl.entries.forEach((entry) => paintClock(ctrl, entry));
}

function startClock(ctrl) {
  if (!ctrl.clockTimer) ctrl.clockTimer = ctrl.window.setInterval(() => tickClocks(ctrl), CLOCK_INTERVAL_MS);
}

function stopClockIfIdle(ctrl) {
  if ([...ctrl.entries.values()].some((entry) => !entry.clock.hidden && entry.timer)) return;
  ctrl.window.clearInterval(ctrl.clockTimer);
  ctrl.clockTimer = null;
}

function dismissEntry(ctrl, entry) {
  if (entry.busy) return;
  const hadFocus = entry.alert.contains(ctrl.document.activeElement);
  const others = [...ctrl.entries.values()].filter((other) => other !== entry);
  rememberDismissed(ctrl, entry.id);
  ctrl.entries.delete(entry.id);
  ctrl.window.clearTimeout(entry.timer);
  removeStatusRetry(entry, RETRY_KEY);
  entry.alert.remove();
  stopClockIfIdle(ctrl);
  if (!hadFocus) return;
  const next = others[0] ? firstAction(others[0]) : ctrl.document.querySelector(HEADING_ACTION_SELECTOR);
  next?.focus?.({ preventScroll: true });
}

function createEntry(ctrl, deletion) {
  const { document } = ctrl;
  const entry = {
    id: deletion.deletionId,
    title: typeof deletion.title === 'string' && deletion.title ? deletion.title : null,
    createdAt: deletion.createdAt,
    expiresAt: deletion.expiresAt,
    page: PAGE_URL.test(deletion.page?.url || '') ? deletion.page.url : null,
    statusUrl: `/notes/page-deletions/${deletion.deletionId}`,
    busy: false,
    actionable: false,
    holdFocus: false,
    checkedPastDeadline: false,
    timer: null,
    [RETRY_KEY]: null,
  };
  const name = entry.title ? `Page “${entry.title}”` : 'this Page';

  entry.alert = document.createElement('div');
  entry.alert.className = 'notice notice--success app-dialog-feedback';
  entry.alert.setAttribute('role', 'status');
  entry.alert.setAttribute('data-page-deletion-undo-alert', entry.id);
  entry.text = document.createElement('p');
  entry.text.setAttribute('data-dialog-feedback-text', '');
  entry.message = document.createElement('span');
  entry.message.setAttribute('data-page-deletion-undo-message', '');
  entry.clock = document.createElement('span');
  entry.clock.setAttribute('data-page-deletion-undo-deadline', '');
  // The deadline is enough for a screen reader; the count would announce itself.
  entry.remaining = document.createElement('span');
  entry.remaining.setAttribute('aria-hidden', 'true');
  entry.actions = document.createElement('span');
  entry.actions.className = 'page-deletion-undo-actions';
  entry.undo = createAction(ctrl, {
    label: 'Undo',
    ariaLabel: `Undo deletion of ${name}`,
    attribute: 'data-page-deletion-undo',
    onClick: () => { void activateUndo(ctrl, entry); },
  });
  entry.view = document.createElement('a');
  entry.view.textContent = 'View Page';
  entry.view.hidden = true;
  entry.view.setAttribute('data-page-deletion-undo-view', '');
  // The link takes Undo's place, so a double-click on Undo must not also follow it.
  entry.view.addEventListener('click', (event) => {
    if (event.detail > 1) event.preventDefault();
  });
  entry.dismiss = createAction(ctrl, {
    label: 'Dismiss',
    ariaLabel: `Dismiss the notice about ${name}`,
    attribute: 'data-chapter-feedback-dismiss',
    onClick: () => dismissEntry(ctrl, entry),
  });
  entry.actions.append(entry.undo, entry.view);
  entry.text.append(entry.message, entry.clock, entry.remaining, ' ', entry.actions, ' ', entry.dismiss);
  entry.alert.append(entry.text);
  regionFor(ctrl).append(entry.alert);
  ctrl.entries.set(entry.id, entry);
  showAvailable(ctrl, entry);
  startClock(ctrl);
  return entry;
}

// The parent's rendered notice has handed over to the alert naming the same deletion.
function retireRenderedNotice(ctrl, entry) {
  const notice = ctrl.document.querySelector('[data-page-deletion-notice]');
  if (!notice) return;
  const hadFocus = notice.contains(ctrl.document.activeElement);
  notice.removeAttribute('data-page-deletion-notice');
  notice.classList.remove('app-dialog-feedback--pinned');
  notice.hidden = true;
  notice.querySelector('[data-dialog-feedback-text]')?.replaceChildren();
  if (hadFocus && entry) firstAction(entry).focus?.({ preventScroll: true });
}

function clearDiscoveryFailure(ctrl) {
  removeStatusRetry(ctrl.failure, RETRY_KEY);
  ctrl.failure?.alert.remove();
  ctrl.failure = null;
}

// An existing "Page deleted." stands: the server verified it. Only Undo is unknown.
function showDiscoveryFailure(ctrl, focusRetry) {
  clearDiscoveryFailure(ctrl);
  const { document } = ctrl;
  const alert = document.createElement('div');
  alert.className = 'notice notice--warning app-dialog-feedback';
  alert.setAttribute('role', 'status');
  alert.setAttribute('data-page-deletion-undo-check-failed', '');
  const text = document.createElement('p');
  text.setAttribute('data-dialog-feedback-text', '');
  text.textContent = 'Could not check for recent Page deletions that can be undone. ';
  const failure = { alert, [RETRY_KEY]: null };
  const actions = document.createElement('span');
  actions.className = 'page-deletion-undo-actions';
  const dismiss = createAction(ctrl, {
    label: 'Dismiss',
    ariaLabel: 'Dismiss the Undo check notice',
    attribute: 'data-chapter-feedback-dismiss',
    onClick: () => {
      clearDiscoveryFailure(ctrl);
      document.querySelector(HEADING_ACTION_SELECTOR)?.focus?.({ preventScroll: true });
    },
  });
  text.append(actions, ' ', dismiss);
  alert.append(text);
  regionFor(ctrl).prepend(alert);
  ctrl.failure = failure;
  const retry = showStatusRetry({
    state: failure,
    status: text,
    mount: actions,
    attribute: 'data-page-deletion-undo-recheck',
    key: RETRY_KEY,
    label: 'Check again',
    onRetry: ({ wasFocused }) => {
      if (wasFocused) dismiss.focus({ preventScroll: true });
      void discover(ctrl, wasFocused);
    },
  });
  retry?.classList.add('button-small');
  if (focusRetry) retry?.focus({ preventScroll: true });
}

async function discover(ctrl, focusRetry = false) {
  let response = null;
  let payload = null;
  try {
    response = await ctrl.window.fetch(ctrl.discoveryUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    });
    payload = await response.json();
  } catch { /* Reported below, with Check again. */ }
  if (!response?.ok || payload?.status !== 'success' || !Array.isArray(payload.deletions)) {
    showDiscoveryFailure(ctrl, focusRetry);
    return;
  }
  const hadFailureFocus = ctrl.failure?.alert.contains(ctrl.document.activeElement);
  clearDiscoveryFailure(ctrl);
  const dismissed = readDismissed(ctrl);
  let located = null;
  payload.deletions.forEach((deletion) => {
    if (deletion?.status !== 'available' || !DELETION_ID.test(deletion.deletionId || '')) return;
    const known = ctrl.entries.get(deletion.deletionId);
    const entry = known || (dismissed.has(deletion.deletionId) ? null : createEntry(ctrl, deletion));
    if (deletion.deletionId === ctrl.locatedId) located = entry || true;
  });
  if (located) retireRenderedNotice(ctrl, located === true ? null : located);
  if (hadFailureFocus) ctrl.document.querySelector(HEADING_ACTION_SELECTOR)?.focus?.({ preventScroll: true });
  if (payload.hasMore && !ctrl.limitNote) {
    ctrl.limitNote = ctrl.document.createElement('p');
    ctrl.limitNote.className = 'page-deletion-undo-limit';
    ctrl.limitNote.textContent = 'Only the 10 most recent deletions are shown here.';
    regionFor(ctrl).append(ctrl.limitNote);
  }
}

export function enhancePageDeletionUndo(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const root = document?.querySelector?.('[data-page-deletion-recovery]');
  if (!root || controllers.has(document)) return;
  const discoveryUrl = root.getAttribute('data-page-deletion-discovery-url') || '';
  const parent = discoveryUrl.match(/\?(chapterId|bookId)=([1-9]\d*)$/);
  if (!parent) return;
  const ctrl = {
    document,
    window: document.defaultView || globalThis,
    root,
    discoveryUrl,
    parentUrl: `/notes/${parent[1] === 'chapterId' ? 'chapters' : 'books'}/${parent[2]}`,
    locatedId: root.getAttribute('data-page-deletion-id'),
    entries: new Map(),
    dismissed: new Set(),
    region: null,
    failure: null,
    limitNote: null,
    clockTimer: null,
  };
  controllers.set(document, ctrl);
  void discover(ctrl);
}
