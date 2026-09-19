import { requestBookCoverReplacementConfirmation } from './book-cover-upload.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import {
  beginBookDetailDefaultsLiveRefresh,
  installBookDetailLiveRegionSnapshot,
  publishBookDetailLiveRegionSnapshotAtomically,
  refreshBookDetailLiveRegion,
} from './live-regions.js';
import { captureRegionFocus, restoreRegionFocus } from './settings-fetch-save.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

const FORM_SELECTOR = 'form[data-book-edit-autosave]';
const TITLE_SELECTOR = '[data-book-title-autosave]';
const COVER_SELECTOR = '[data-book-cover-autosave]';
const COVER_PRESENTATION_SELECTOR = '[data-book-current-cover-presentation]';

function setStatus(form, message, state) {
  form.setAttribute?.('data-book-edit-save-state', state);
  const status = form.querySelector?.('[data-book-edit-save-status]');
  if (status) status.textContent = message;
}

function clearErrors(form) {
  const summary = form.querySelector?.('.error-summary');
  summary?.remove?.();
  form.querySelectorAll?.('.field-error-message').forEach((message) => message.remove?.());
  form.querySelectorAll?.('.field-error').forEach((field) => field.classList?.remove?.('field-error'));
  form.querySelectorAll?.('[aria-invalid]').forEach((control) => {
    control.removeAttribute?.('aria-invalid');
    control.removeAttribute?.('aria-describedby');
  });
}

function showError(form, payload, kind) {
  const title = form.querySelector?.(TITLE_SELECTOR);
  const titleError = payload?.errors?.title;
  if (titleError && title) {
    const field = title.closest?.('.field');
    field?.classList?.add?.('field-error');
    title.setAttribute?.('aria-invalid', 'true');
    title.setAttribute?.('aria-describedby', 'title-error');
    const message = form.ownerDocument?.createElement?.('span');
    if (message) {
      message.className = 'field-error-message';
      message.id = 'title-error';
      message.textContent = titleError;
      title.insertAdjacentElement?.('afterend', message);
    }
  }
  const text = titleError || payload?.errors?.general || payload?.message
    || (kind === 'cover' ? 'Could not save the Book cover.' : 'Could not save the Book title.');
  if (!titleError) {
    const body = form.querySelector?.('.app-dialog-body');
    const summary = form.ownerDocument?.createElement?.('div');
    const paragraph = form.ownerDocument?.createElement?.('p');
    if (body && summary && paragraph) {
      summary.className = 'error-summary';
      summary.setAttribute?.('role', 'alert');
      paragraph.textContent = text;
      summary.appendChild?.(paragraph);
      body.prepend?.(summary);
    }
  }
  setStatus(form, `${text} Your current changes were kept.`, 'error');
}

function applyCurrentCover(form, currentCover) {
  if (!currentCover) return;
  const kind = form.querySelector?.('input[name="expectedCoverKind"]');
  const id = form.querySelector?.('input[name="expectedCoverId"]');
  const confirmed = form.querySelector?.('input[name="coverReplacementConfirmed"]');
  if (kind) kind.value = currentCover.kind || 'none';
  if (id) id.value = currentCover.id ?? '';
  if (confirmed) confirmed.value = 'false';
}

function updateVisibleTitle(form, title) {
  if (typeof title !== 'string') return;
  const document = form.ownerDocument;
  const heading = document?.querySelector?.('.app-section-title');
  if (heading) heading.textContent = `Notes — ${title}`;
  if (typeof document?.title === 'string') document.title = `CreatorCrate — Notes — ${title}`;
}

function setEditControlsDisabled(state, disabled) {
  for (const control of [state.title, state.cover]) {
    if (!control) continue;
    if (disabled) {
      if (!state.disabledControls.has(control)) state.disabledControls.set(control, Boolean(control.disabled));
      control.disabled = true;
    } else {
      control.disabled = state.disabledControls.get(control) || false;
    }
  }
  if (!disabled) state.disabledControls.clear();
}

function removeReconciliationRetry(state) {
  state.retryButton?.remove?.();
  state.retryButton = null;
}

function isEditBookDialogOpen(state) {
  const dialog = state.form.closest?.('[data-app-dialog]');
  const dialogState = dialog?.__creatorCrateAppDialogState;
  return Boolean(dialog && (dialog.open === true || dialogState?.open === true));
}

function captureEditBookFocus(state, retryFocused = false) {
  const body = state.form.querySelector?.('.app-dialog-body');
  const document = state.form.ownerDocument || globalThis.document;
  const activeElement = document?.activeElement;
  if (!body || (!retryFocused && (!activeElement || !body.contains?.(activeElement)))) return null;
  return {
    retryFocused: retryFocused || activeElement === state.retryButton
      || activeElement === state.refreshRetryButton,
    regionFocus: captureRegionFocus(body),
  };
}

function restoreEditBookFocus(state, focus) {
  if (!focus || !isEditBookDialogOpen(state)) return false;
  const dialog = state.form.closest?.('[data-app-dialog]');
  const document = state.form.ownerDocument || globalThis.document;
  const activeElement = document?.activeElement;
  if (activeElement && activeElement !== document?.body
    && activeElement.isConnected !== false && dialog.contains?.(activeElement)) return true;

  const body = state.form.querySelector?.('.app-dialog-body');
  if (restoreRegionFocus(body, focus.regionFocus)) return true;
  const target = state.title && !state.title.disabled && typeof state.title.focus === 'function'
    ? state.title
    : dialog.querySelector?.('[data-dialog-close]');
  if (!target || typeof target.focus !== 'function') return false;
  target.focus({ preventScroll: true });
  return true;
}

function focusEditBookRetry(state, key) {
  const button = state[key];
  if (!button || !isEditBookDialogOpen(state) || typeof button.focus !== 'function') return false;
  button.focus({ preventScroll: true });
  return true;
}

function showReconciliationFailure(state, retry, message = 'Could not restore current Book authority.') {
  setStatus(
    state.form,
    `${message} Title and cover changes remain blocked. Retry reconciliation to continue.`,
    'reconciliation-error',
  );
  const body = state.form.querySelector?.('.app-dialog-body');
  const button = state.form.ownerDocument?.createElement?.('button');
  if (body && button) {
    removeReconciliationRetry(state);
    button.type = 'button';
    button.className = 'button button-secondary';
    button.setAttribute?.('data-book-edit-reconciliation-retry', '');
    button.textContent = 'Retry reconciliation';
    button.addEventListener?.('click', retry);
    body.appendChild?.(button);
    state.retryButton = button;
    focusEditBookRetry(state, 'retryButton');
    return;
  }
  state.form.closest?.('[data-app-dialog]')?.querySelector?.('[data-dialog-close]')?.focus?.();
}

async function responsePayload(response) {
  try { return await response.json(); } catch { return null; }
}

function titleBody(form, title) {
  const body = new URLSearchParams();
  const csrf = form.querySelector?.('input[name="_csrf"]');
  if (csrf) body.set('_csrf', csrf.value);
  body.set('title', title);
  return body;
}

function coverBody(state, operation) {
  const { form } = state;
  const body = new FormData();
  const csrf = form.querySelector?.('input[name="_csrf"]');
  const kind = form.querySelector?.('input[name="expectedCoverKind"]');
  const id = form.querySelector?.('input[name="expectedCoverId"]');
  if (csrf) body.set('_csrf', csrf.value);
  operation.submittedTitle = state.acknowledgedTitle;
  body.set('title', operation.submittedTitle);
  body.set('expectedCoverKind', kind?.value || 'none');
  body.set('expectedCoverId', id?.value || '');
  body.set('coverReplacementConfirmed', kind?.value === 'none' ? 'false' : 'true');
  body.set('cover', operation.file, operation.file.name);
  return body;
}

function definiteEditRejection(response, payload) {
  return Boolean(
    response && !response.ok && payload?.status === 'error'
      && (payload?.code || payload?.errors),
  );
}

export function parseBookCoverAuthority(kind, id) {
  if (kind === 'none' && id === '') return { kind, id };
  if (kind === 'project_asset' && typeof id === 'string' && /^[1-9]\d*$/.test(id)
    && Number.isSafeInteger(Number(id))) return { kind, id };
  if (kind === 'managed_asset' && typeof id === 'string' && id.length > 0) return { kind, id };
  return null;
}

async function fetchBookEditAuthority(state) {
  const Parser = state.form.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  const destination = state.form.action || state.form.getAttribute?.('action');
  if (!destination || typeof globalThis.fetch !== 'function' || typeof Parser !== 'function') return null;
  try {
    const response = await globalThis.fetch(destination, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response?.ok || typeof response.text !== 'function') return null;
    const parsed = new Parser().parseFromString(await response.text(), 'text/html');
    const form = parsed?.querySelector?.(FORM_SELECTOR);
    const detailRegion = parsed?.querySelector?.('[data-book-detail-live-region]');
    const coverPresentation = form?.querySelector?.(COVER_PRESENTATION_SELECTOR);
    const title = form?.querySelector?.(TITLE_SELECTOR)?.value;
    const kind = form?.querySelector?.('input[name="expectedCoverKind"]')?.value;
    const id = form?.querySelector?.('input[name="expectedCoverId"]')?.value ?? '';
    const currentCover = parseBookCoverAuthority(kind, id);
    if (!form || !detailRegion || !coverPresentation || typeof title !== 'string'
      || !currentCover) return null;
    return { destination, detailRegion, coverPresentation, title, currentCover };
  } catch {
    return null;
  }
}

function installBookEditDialogPresentation(state, authority) {
  const current = state.form.querySelector?.(COVER_PRESENTATION_SELECTOR);
  if (!current || !authority?.coverPresentation) return false;
  if (typeof current.replaceWith === 'function') current.replaceWith(authority.coverPresentation);
  else if (typeof current.parentNode?.replaceChild === 'function') {
    current.parentNode.replaceChild(authority.coverPresentation, current);
  } else return false;
  return true;
}

async function publishAcknowledgedCoverPresentation(state) {
  const authority = await state.fetchAuthority(state);
  if (!authority) return false;
  const installed = state.publishDetailAndDialog(
    state.form.ownerDocument,
    authority.destination,
    state.authorityGeneration,
    authority.detailRegion,
    () => state.installDialogPresentation(state, authority),
  ) === 'installed';
  if (!installed) return false;
  state.acknowledgedTitle = authority.title;
  applyCurrentCover(state.form, authority.currentCover);
  return true;
}

async function reconcileEditBook(state, operation, reason = 'uncertain', recoveryFocus = null) {
  state.reconciling = true;
  state.form.setAttribute?.('aria-busy', 'true');
  setEditControlsDisabled(state, true);
  if (!state.pendingAfterReconcile) {
    state.pendingAfterReconcile = state.queue.splice(0);
    state.uncertainOperation = operation;
    state.reconciliationReason = reason;
  }
  const staleCover = state.reconciliationReason === 'stale-cover';
  setStatus(
    state.form,
    staleCover
      ? 'The Book cover changed elsewhere. Restoring current Book authority; your selected replacement was not applied.'
      : 'Could not confirm whether the Book change was saved. Restoring current Book authority.',
    'reconciling',
  );

  const authority = await state.fetchAuthority(state);
  const detailInstalled = authority && state.installDetail(
    state.form.ownerDocument,
    authority.destination,
    state.authorityGeneration,
    authority.detailRegion,
  ) === 'installed';
  const dialogInstalled = detailInstalled && state.installDialogPresentation(state, authority);
  if (!dialogInstalled) {
    showReconciliationFailure(state, async () => {
      const retryFocus = captureEditBookFocus(state);
      removeReconciliationRetry(state);
      state.authorityGeneration = state.beginRefresh(state.form.ownerDocument);
      if (await reconcileEditBook(
        state,
        state.uncertainOperation,
        state.reconciliationReason,
        retryFocus,
      )) void runQueue(state);
    }, staleCover
      ? 'The Book cover changed elsewhere, and your selected replacement was not applied. Could not restore current Book authority.'
      : 'Could not restore current Book authority.');
    return false;
  }

  const submittedTitle = state.uncertainOperation?.kind === 'title'
    ? state.uncertainOperation.title
    : state.uncertainOperation?.submittedTitle ?? null;
  if (submittedTitle !== null && state.title.value === submittedTitle) state.title.value = authority.title;
  state.acknowledgedTitle = authority.title;
  applyCurrentCover(state.form, authority.currentCover);
  updateVisibleTitle(state.form, authority.title);
  if (state.uncertainOperation?.kind === 'cover'
    && state.cover?.files?.[0] === state.uncertainOperation.file) state.cover.value = '';

  const pending = state.pendingAfterReconcile;
  state.pendingAfterReconcile = null;
  state.uncertainOperation = null;
  state.reconciliationReason = null;
  state.queue.unshift(...pending);
  state.reconciling = false;
  removeReconciliationRetry(state);
  setEditControlsDisabled(state, false);
  clearErrors(state.form);
  setStatus(
    state.form,
    staleCover
      ? 'The Book cover changed elsewhere. The current cover was refreshed. Your selected replacement was not applied; choose the file again to replace it.'
      : 'Current Book state restored.',
    'reconciled',
  );
  restoreEditBookFocus(state, recoveryFocus);
  return true;
}

function queueOperation(state, operation) {
  if (operation.kind === 'title' && state.queue.at(-1)?.kind === 'title') state.queue[state.queue.length - 1] = operation;
  else state.queue.push(operation);
  void runQueue(state);
}

function refreshAcknowledgedDetail(state) {
  if (!state.refreshUrl) return;
  const onError = () => showAcknowledgedRefreshFailure(state);
  const onComplete = () => {
    removeStatusRetry(state);
    setStatus(state.form, 'Book saved.', 'saved');
  };
  let outcome = state.refresh(
    state.form.ownerDocument,
    state.refreshUrl,
    state.authorityGeneration,
    { onComplete, onError },
  );
  if (outcome === 'superseded') {
    const currentGeneration = state.beginRefresh(state.form.ownerDocument);
    outcome = currentGeneration === null
      ? 'unavailable'
      : state.refresh(state.form.ownerDocument, state.refreshUrl, currentGeneration, { onComplete, onError });
  }
  if (outcome === 'unavailable') onError();
  if (outcome === 'superseded') onError();
}

function showAcknowledgedRefreshFailure(state) {
  const status = state.form.querySelector?.('[data-book-edit-save-status]');
  const body = state.form.querySelector?.('.app-dialog-body');
  if (status && !status.id) status.id = 'book-edit-save-status';
  setStatus(
    state.form,
    'The Book was saved, but its detail could not refresh. ',
    'saved-refresh-error',
  );
  showStatusRetry({
    state,
    status,
    mount: body,
    attribute: 'data-book-edit-refresh-retry',
    describedBy: status?.id || '',
    onRetry: ({ wasFocused } = {}) => retryAcknowledgedPresentation(
      state,
      captureEditBookFocus(state, wasFocused),
    ),
  });
}

async function retryAcknowledgedPresentation(state, recoveryFocus = null) {
  if (state.refreshRetryInFlight) return false;
  state.refreshRetryInFlight = true;
  const attempt = state.presentationVersion;
  setStatus(state.form, 'The Book was saved. Retrying its presentation refresh.', 'saved-refresh-pending');
  const authorityGeneration = state.beginRefresh(state.form.ownerDocument);
  const authority = await state.fetchAuthority(state);
  if (attempt !== state.presentationVersion) {
    state.refreshRetryInFlight = false;
    return false;
  }
  const installed = authority && authorityGeneration !== null && state.publishDetailAndDialog(
    state.form.ownerDocument,
    authority.destination,
    authorityGeneration,
    authority.detailRegion,
    () => state.installDialogPresentation(state, authority),
  ) === 'installed';
  state.refreshRetryInFlight = false;
  if (!installed) {
    showAcknowledgedRefreshFailure(state);
    if (recoveryFocus?.retryFocused) focusEditBookRetry(state, 'refreshRetryButton');
    return false;
  }

  if (state.title.value === state.acknowledgedTitle) state.title.value = authority.title;
  state.acknowledgedTitle = authority.title;
  applyCurrentCover(state.form, authority.currentCover);
  updateVisibleTitle(state.form, authority.title);
  clearErrors(state.form);
  removeStatusRetry(state);
  setStatus(state.form, 'Book saved. Presentation refreshed.', 'saved');
  restoreEditBookFocus(state, recoveryFocus);
  return true;
}

async function confirmCover(state, operation) {
  const kind = state.form.querySelector?.('input[name="expectedCoverKind"]')?.value || 'none';
  if (kind === 'none') return true;
  return requestBookCoverReplacementConfirmation(
    state.form.ownerDocument,
    operation.opener || state.cover,
  );
}

async function runQueue(state) {
  if (state.running || state.reconciling) return;
  state.running = true;
  state.form.setAttribute?.('aria-busy', 'true');
  if (state.authorityGeneration === null) {
    state.authorityGeneration = state.beginRefresh(state.form.ownerDocument);
  }

  while (state.queue.length > 0) {
    const operation = state.queue.shift();
    state.presentationVersion += 1;
    removeStatusRetry(state);
    if (operation.kind === 'cover') {
      try {
        if (!(await state.confirmCover(state, operation))) {
          if (state.cover?.files?.[0] === operation.file) state.cover.value = '';
          continue;
        }
      } catch {
        showError(state.form, { message: 'Could not confirm the Book cover replacement.' }, 'cover');
        if (state.cover?.files?.[0] === operation.file) state.cover.value = '';
        continue;
      }
    }

    clearErrors(state.form);
    setStatus(state.form, operation.kind === 'cover' ? 'Saving Book cover.' : 'Saving Book title.', 'pending');
    const body = operation.kind === 'cover'
      ? coverBody(state, operation)
      : titleBody(state.form, operation.title);
    const headers = operation.kind === 'title'
      ? { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
      : { Accept: 'application/json' };

    let response;
    let payload;
    try {
      response = await fetch(state.form.action || state.form.getAttribute?.('action'), {
        method: 'POST', body, headers, credentials: 'same-origin', redirect: 'follow',
      });
      payload = await responsePayload(response);
      if (definiteEditRejection(response, payload)) {
        if (operation.kind === 'cover' && payload?.code === 'STALE_SOURCE') {
          if (state.cover?.files?.[0] === operation.file) state.cover.value = '';
          if (!(await reconcileEditBook(state, operation, 'stale-cover'))) break;
          continue;
        }
        applyCurrentCover(state.form, payload?.currentCover);
        showError(state.form, payload, operation.kind);
        if (operation.kind === 'cover' && state.cover?.files?.[0] === operation.file) state.cover.value = '';
        continue;
      }
      if (!response?.ok || payload?.status !== 'success'
        || typeof payload?.book?.title !== 'string' || !payload?.currentCover) {
        if (!(await reconcileEditBook(state, operation))) break;
        continue;
      }

      state.refreshUrl = payload.refreshUrl || state.refreshUrl;
      state.acknowledgedTitle = payload.book.title;
      applyCurrentCover(state.form, payload.currentCover);
      updateVisibleTitle(state.form, payload.book?.title);
      if (operation.kind === 'cover' && state.cover?.files?.[0] === operation.file) state.cover.value = '';
      setStatus(state.form, operation.kind === 'cover' ? 'Book cover saved.' : 'Book title saved.', 'saved');
      if (operation.kind === 'cover') {
        if (!(await publishAcknowledgedCoverPresentation(state))) showAcknowledgedRefreshFailure(state);
      } else state.needsRefresh = true;
    } catch {
      if (!(await reconcileEditBook(state, operation))) break;
    }
  }

  state.running = false;
  if (!state.reconciling) {
    state.form.removeAttribute?.('aria-busy');
    if (state.needsRefresh) refreshAcknowledgedDetail(state);
    state.authorityGeneration = null;
    state.refreshUrl = null;
    state.needsRefresh = false;
  }
}

export function enhanceBookEditFetchSave(scope = globalThis.document, options = {}) {
  if (!scope || typeof scope.querySelectorAll !== 'function'
    || typeof globalThis.fetch !== 'function'
    || typeof globalThis.FormData !== 'function'
    || typeof globalThis.URLSearchParams !== 'function') return 0;

  let count = 0;
  scope.querySelectorAll(FORM_SELECTOR).forEach((form) => {
    if (isEnhancementBound(form, 'bookEditFetchSaveBound')) return;
    const title = form.querySelector?.(TITLE_SELECTOR);
    const cover = form.querySelector?.(COVER_SELECTOR);
    if (!title || !cover) return;
    markEnhancementBound(form, 'bookEditFetchSaveBound');
    count += 1;
    const state = {
      form,
      title,
      cover,
      queue: [],
      running: false,
      reconciling: false,
      pendingAfterReconcile: null,
      uncertainOperation: null,
      reconciliationReason: null,
      retryButton: null,
      refreshRetryButton: null,
      refreshRetryInFlight: false,
      presentationVersion: 0,
      disabledControls: new Map(),
      acknowledgedTitle: title.value,
      authorityGeneration: null,
      refreshUrl: null,
      needsRefresh: false,
      beginRefresh: options.beginRefresh || beginBookDetailDefaultsLiveRefresh,
      refresh: options.refresh || refreshBookDetailLiveRegion,
      fetchAuthority: options.fetchAuthority || fetchBookEditAuthority,
      installDetail: options.installDetail || installBookDetailLiveRegionSnapshot,
      installDialogPresentation: options.installDialogPresentation || installBookEditDialogPresentation,
      publishDetailAndDialog: options.publishDetailAndDialog
        || publishBookDetailLiveRegionSnapshotAtomically,
      confirmCover: options.confirmCover || confirmCover,
    };
    title.addEventListener?.('change', () => queueOperation(state, { kind: 'title', title: title.value }));
    cover.addEventListener?.('change', () => {
      const file = cover.files?.[0];
      if (file) queueOperation(state, { kind: 'cover', file, opener: cover });
    });
    form.addEventListener?.('submit', (event) => event.preventDefault?.());
  });
  return count;
}
