import { isEnhancementBound, markEnhancementBound, liveRegionWindow } from './dom.js';
import { enhanceAppDialogs } from './app-dialogs.js';
import { enhanceDropdowns } from './dropdowns.js';
import { closePickersWithin, enhanceDatePickers } from './pickers.js';
import {
  beginReleaseLinkCheck,
  finishReleaseLinkCheck,
  RELEASE_EDIT_SAVED_EVENT,
} from './release-edit-dialog.js';
import {
  enhanceReleaseSocialPrepAutoLaunch,
  RELEASE_SOCIAL_PREP_COMPANION_IN_FLIGHT_ATTRIBUTE,
  RELEASE_SOCIAL_PREP_COMPANION_SETTLED_EVENT,
} from './release-social-prep-auto-launch.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// Release Detail refreshes in place after an Edit Release save: the page is
// fetched again with a GET and each server-rendered region whose content
// depends on editable release fields (data-release-detail-region) is replaced
// from that render. The Edit action, the Edit and Signatures dialogs, the
// selected assets and the dialog feedback notice sit outside every region and
// are never replaced. A region holding an open dialog or a companion request
// in flight is left alone and marked stale (data-release-detail-stale); once
// that dialog closes or that request settles, Release Detail is fetched again.
//
// Once the publishing companion (the native Posting Helper) has been launched,
// returning to this page (window focus, or the tab becoming visible, after it
// was left) refreshes the same regions once more, because the helper saves the
// Release link and posting state outside the browser. It is one GET per
// return, never a poll, and it reports nothing unless it fails.
const PAGE_SELECTOR = '[data-release-detail]';
const REGION_SELECTOR = '[data-release-detail-region]';
const STALE_ATTRIBUTE = 'data-release-detail-stale';
// Controls in a stale region that would act on the superseded release state.
const STALE_ACTION_SELECTOR = '[data-dialog-submit], [data-release-social-prep-companion-action]';
const STATE_KEY = '__creatorCrateReleaseDetailRefresh';
const BOUND_KEY = 'releaseDetailRefreshBound';
const RETRY_KEY = 'retryButton';
// Deep-link markers open a dialog or launch the companion on render; a
// refresh must never carry them into the regions it adopts.
const ONE_SHOT_PARAMS = ['edit', 'publish', 'prep', 'returnTo'];
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, [tabindex]';

const SAVED_MESSAGE = 'Release updated.';
const REFRESHING_MESSAGE = 'Release saved. Refreshing Release Detail…';
const STALE_MESSAGE = 'Release saved, but Release Detail could not refresh. The information shown may be out of date.';
const DEFERRED_MESSAGE = 'Release saved. Some Release Detail sections will refresh when the open dialog closes or the publishing companion request finishes.';
const STALE_DIALOG_MESSAGE = 'This release has changed. Close this dialog to load its current details.';
// A return refresh does not know whether anything changed.
const RETURN_STALE_DIALOG_MESSAGE = 'Release Detail is being updated. Close this dialog to load its current details.';
const RETURN_CHECKING_MESSAGE = 'Checking Release Detail for changes made in the Posting Helper…';
const RETURN_FAILED_MESSAGE = 'Release Detail could not check for changes made in the Posting Helper. The information shown may be out of date.';
const RETURN_SIGNED_OUT_MESSAGE = 'Your CreatorCrate sign-in has expired, so Release Detail could not check for changes made in the Posting Helper. Sign in again, then retry.';
const RELEASE_LINK_ATTRIBUTE = 'data-release-link';

// tone: 'success', 'error' or 'pending' (neither).
function setFeedback(document, message, tone = 'success') {
  const notice = document.querySelector('[data-dialog-feedback]');
  const text = notice?.querySelector('[data-dialog-feedback-text]');
  if (!notice || !text) return null;
  notice.classList.toggle('notice--error', tone === 'error');
  notice.classList.toggle('notice--success', tone === 'success');
  text.textContent = message;
  notice.hidden = false;
  return notice;
}

function refreshUrl(windowObject, releaseId) {
  const current = new URL(windowObject.location.href);
  const url = new URL(`/releases/${releaseId}`, current.origin);
  current.searchParams.forEach((value, name) => {
    if (!ONE_SHOT_PARAMS.includes(name)) url.searchParams.append(name, value);
  });
  return url;
}

function regionsByName(root) {
  const regions = new Map();
  root.querySelectorAll(REGION_SELECTOR).forEach((region) => {
    const name = region.getAttribute('data-release-detail-region');
    regions.set(name, regions.has(name) ? null : region);
  });
  return regions;
}

// An open dialog keeps its in-progress input; it is only replaced while closed.
function regionIsBusy(region) {
  const dialogBusy = Array.from(region.querySelectorAll('dialog')).some((dialog) => dialog.open
    || dialog.__creatorCrateAppDialogState?.open || dialog.__creatorCrateAppDialogState?.submitting);
  // The companion marks itself while its request is in flight. Its disabled
  // action is no signal: a stale region disables it after the request settles.
  const companionBusy = Boolean(region.querySelector(`[${RELEASE_SOCIAL_PREP_COMPANION_IN_FLIGHT_ATTRIBUTE}]`));
  return dialogBusy || companionBusy;
}

// A deferred region keeps its content but stops offering actions on the
// superseded state; its replacement brings current controls back.
function markStale(region, staleDialogMessage) {
  region.setAttribute(STALE_ATTRIBUTE, '');
  region.querySelectorAll(STALE_ACTION_SELECTOR).forEach((control) => { control.disabled = true; });
  region.querySelectorAll('dialog [data-dialog-status]').forEach((status) => {
    status.textContent = staleDialogMessage;
  });
}

// Focus inside a replaced region moves to the same control in its
// replacement: by id, then link target, then position.
function focusCounterpart(oldRegion, newRegion, active) {
  const escape = globalThis.CSS?.escape || ((value) => value);
  let target = null;
  if (active.id) target = newRegion.querySelector(`#${escape(active.id)}`);
  if (!target && active.getAttribute('href')) {
    target = newRegion.querySelector(`[href="${escape(active.getAttribute('href'))}"]`);
  }
  if (!target) {
    const index = Array.from(oldRegion.querySelectorAll(FOCUSABLE_SELECTOR)).indexOf(active);
    target = index >= 0 ? newRegion.querySelectorAll(FOCUSABLE_SELECTOR)[index] : null;
  }
  return target;
}

function applyRefresh(document, parsed, releaseId, staleDialogMessage) {
  const page = document.querySelector(PAGE_SELECTOR);
  const nextPage = parsed.querySelector(PAGE_SELECTOR);
  if (!page || nextPage?.getAttribute('data-release-detail') !== releaseId) return false;
  const current = regionsByName(document);
  const next = regionsByName(parsed);
  // Every region must be found exactly once on both sides before anything is
  // replaced, so a refresh never leaves a mix of old and new regions.
  if (current.size === 0 || [...current].some(([name, region]) => !region || !next.get(name))) return false;

  const windowObject = liveRegionWindow(document);
  const scrollX = windowObject.scrollX;
  const scrollY = windowObject.scrollY;
  const active = document.activeElement;
  let focusTarget = null;
  let focusLost = false;
  let deferred = false;

  current.forEach((region, name) => {
    if (regionIsBusy(region)) {
      markStale(region, staleDialogMessage);
      deferred = true;
      return;
    }
    const replacement = document.importNode(next.get(name), true);
    replacement.querySelectorAll('dialog[open]').forEach((dialog) => dialog.removeAttribute('open'));
    if (active && region.contains(active)) {
      focusTarget = focusCounterpart(region, replacement, active);
      focusLost = true;
    }
    closePickersWithin(region);
    region.replaceWith(replacement);
    enhanceReleaseSocialPrepAutoLaunch(replacement);
    enhanceDatePickers(replacement);
  });

  // A replaced Review & Publish dialog binds through the shared lifecycle.
  enhanceAppDialogs(document);
  enhanceDropdowns(document);

  const title = parsed.querySelector('title')?.textContent;
  if (title) document.title = title;
  const heading = document.querySelector('.app-section-title');
  const nextHeading = parsed.querySelector('.app-section-title')?.textContent;
  if (heading && nextHeading) heading.textContent = nextHeading;

  if (focusLost) (focusTarget || document.getElementById('main-content'))?.focus?.({ preventScroll: true });
  windowObject.scrollTo?.(scrollX, scrollY);
  return deferred ? 'deferred' : 'refreshed';
}

function refreshState(document) {
  // deferred: false, 'save' or 'return' (whichever refresh left regions stale).
  document[STATE_KEY] ||= {
    generation: 0, abort: null, loading: false, current: null, deferred: false, [RETRY_KEY]: null,
    releaseLink: null, returnListeners: null, away: false, returnRefresh: null, returnNotice: false,
  };
  return document[STATE_KEY];
}

/**
 * Fetches Release Detail again and replaces its release regions. Only a GET is
 * ever sent, so the save is never repeated. Each refresh supersedes any older
 * one still in flight, so a late response can never overwrite a newer save.
 * Resolves to 'refreshed', 'deferred' (some regions are busy and were marked
 * stale instead), 'failed', 'signed-out' or 'superseded'. The Release link
 * shown by the adopted render is kept as state.releaseLink.
 */
export function refreshReleaseDetail(document, releaseId, { staleDialogMessage = STALE_DIALOG_MESSAGE } = {}) {
  const state = refreshState(document);
  state.current = fetchReleaseDetail(document, releaseId, staleDialogMessage);
  return state.current;
}

function signedOut(windowObject, response) {
  if (response.status === 401) return true;
  // An expired session answers an HTML GET with a redirect to sign-in.
  try {
    return response.redirected && new URL(response.url, windowObject.location.href).pathname === '/login';
  } catch {
    return false;
  }
}

async function fetchReleaseDetail(document, releaseId, staleDialogMessage) {
  const state = refreshState(document);
  state.generation += 1;
  const generation = state.generation;
  state.abort?.abort();
  const windowObject = liveRegionWindow(document);
  const abort = typeof windowObject.AbortController === 'function' ? new windowObject.AbortController() : null;
  state.abort = abort;
  state.loading = true;
  let outcome = 'failed';
  try {
    const response = await windowObject.fetch(refreshUrl(windowObject, releaseId).href, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'text/html' },
      signal: abort?.signal,
    });
    const unauthenticated = signedOut(windowObject, response);
    const html = response.ok && !unauthenticated ? await response.text() : '';
    if (generation !== state.generation) return 'superseded';
    if (unauthenticated) outcome = 'signed-out';
    if (html) {
      const parsed = new windowObject.DOMParser().parseFromString(html, 'text/html');
      outcome = applyRefresh(document, parsed, releaseId, staleDialogMessage) || 'failed';
      if (outcome !== 'failed') {
        state.releaseLink = parsed.querySelector(`[data-release-detail-region="details"][${RELEASE_LINK_ATTRIBUTE}]`)
          ?.getAttribute(RELEASE_LINK_ATTRIBUTE) ?? null;
      }
    }
  } catch {
    if (generation !== state.generation) return 'superseded';
  }
  state.abort = null;
  state.loading = false;
  return outcome;
}

async function refreshAfterSave(document, releaseId, { focusResult = false } = {}) {
  const state = refreshState(document);
  removeStatusRetry(state, RETRY_KEY);
  const outcome = await refreshReleaseDetail(document, releaseId);
  // A newer save or retry owns the outcome now.
  if (outcome === 'superseded') return;
  // Stale regions wait for their dialog or companion request; until then the
  // page says it is not fully refreshed.
  state.deferred = outcome === 'deferred' ? 'save' : false;
  state.returnNotice = false;
  if (outcome === 'deferred') {
    setFeedback(document, DEFERRED_MESSAGE, 'pending');
    return;
  }
  if (outcome === 'refreshed') {
    setFeedback(document, SAVED_MESSAGE);
    if (focusResult) document.querySelector(`[data-release-edit-id="${releaseId}"]`)?.focus?.();
    return;
  }
  const notice = setFeedback(document, STALE_MESSAGE, 'error');
  const retry = notice ? showStatusRetry({
    state,
    status: notice,
    attribute: 'data-release-detail-refresh-retry',
    key: RETRY_KEY,
    onRetry: ({ wasFocused }) => {
      setFeedback(document, REFRESHING_MESSAGE);
      return refreshAfterSave(document, releaseId, { focusResult: wasFocused });
    },
  }) : null;
  if (focusResult) retry?.focus?.();
}

// Called when a dialog closes or a companion request settles: once no stale
// region is busy, Release Detail is fetched again (GET only). A refresh still
// in flight adopts whatever is free when it lands, so none is added.
function reconcileDeferred(document, releaseId) {
  const state = refreshState(document);
  if (!state.deferred) return;
  const stale = Array.from(document.querySelectorAll(`${REGION_SELECTOR}[${STALE_ATTRIBUTE}]`));
  // A settled companion re-enables its action; it stays disabled while stale.
  stale.forEach((region) => {
    region.querySelectorAll(STALE_ACTION_SELECTOR).forEach((control) => { control.disabled = true; });
  });
  if (state.loading || stale.some(regionIsBusy)) return;
  const reason = state.deferred;
  state.deferred = false;
  // Only a deferred save says so; a deferred return refresh stays quiet.
  if (reason === 'return') {
    void refreshOnReturn(document, releaseId);
    return;
  }
  setFeedback(document, REFRESHING_MESSAGE);
  void refreshAfterSave(document, releaseId);
}

// Waits for whichever refresh is newest: a superseded one hands over to its
// successor, which was requested later and so is at least as current.
async function settledRefresh(state, outcome) {
  let result = outcome;
  while ((result === 'superseded' || state.loading) && state.current) result = await state.current;
  return result;
}

/**
 * Refreshes Release Detail after the user returns from the publishing
 * companion (GET only: nothing is launched, prepared or marked posted).
 * Returns that arrive while it runs fold into one more refresh. An open Edit
 * Release dialog holds its save until the refreshed Release link has been
 * compared with the link the dialog loaded.
 */
async function refreshOnReturn(document, releaseId, { focusResult = false } = {}) {
  const state = refreshState(document);
  if (state.returnRefresh) {
    state.returnRefresh.again = true;
    return;
  }
  const run = { again: true };
  state.returnRefresh = run;
  let linkCheck = null;
  let outcome = 'failed';
  let owned = false;
  try {
    while (run.again) {
      run.again = false;
      // A save's refresh in flight keeps its own outcome and feedback.
      if (state.loading) await settledRefresh(state, 'superseded');
      linkCheck = beginReleaseLinkCheck(document, releaseId);
      outcome = await refreshReleaseDetail(document, releaseId, { staleDialogMessage: RETURN_STALE_DIALOG_MESSAGE });
      owned = outcome !== 'superseded';
      outcome = await settledRefresh(state, outcome);
    }
  } finally {
    state.returnRefresh = null;
  }

  const adopted = outcome === 'refreshed' || outcome === 'deferred';
  finishReleaseLinkCheck(document, linkCheck, adopted ? { releaseLink: state.releaseLink ?? '' } : { failed: true });
  // A newer save took this refresh over and reports its own outcome.
  if (!owned) return;
  if (adopted) {
    if (outcome === 'deferred') {
      state.deferred ||= 'return';
    } else if (state.deferred === 'save') {
      // Every region a save left stale has now been replaced.
      state.deferred = false;
      setFeedback(document, SAVED_MESSAGE);
    } else {
      state.deferred = false;
    }
    // Only this path's own failure notice is withdrawn once a refresh works.
    if (state.returnNotice) {
      state.returnNotice = false;
      removeStatusRetry(state, RETRY_KEY);
      const notice = document.querySelector('[data-dialog-feedback]');
      if (notice) notice.hidden = true;
    }
    if (focusResult) document.getElementById('main-content')?.focus?.({ preventScroll: true });
    return;
  }
  const notice = setFeedback(document, outcome === 'signed-out' ? RETURN_SIGNED_OUT_MESSAGE : RETURN_FAILED_MESSAGE, 'error');
  state.returnNotice = Boolean(notice);
  const retry = notice ? showStatusRetry({
    state,
    status: notice,
    attribute: 'data-release-detail-refresh-retry',
    key: RETRY_KEY,
    onRetry: ({ wasFocused }) => {
      setFeedback(document, RETURN_CHECKING_MESSAGE, 'pending');
      return refreshOnReturn(document, releaseId, { focusResult: wasFocused });
    },
  }) : null;
  if (focusResult) retry?.focus?.();
}

// Listens for the user coming back to this page once a companion launch has
// been attempted. One set of listeners serves every later launch; it is
// removed when the page is left (navigation, reload or bfcache).
function armReturnRefresh(document, releaseId) {
  const state = refreshState(document);
  if (state.returnListeners) return;
  const windowObject = liveRegionWindow(document);
  const listeners = new windowObject.AbortController();
  const { signal } = listeners;
  state.returnListeners = listeners;
  // The helper normally takes focus after the launch, but the page may
  // already be in the background when it is armed.
  state.away = document.visibilityState === 'hidden' || document.hasFocus?.() === false;
  const leave = () => { state.away = true; };
  // focus and visibilitychange both announce one return; only the first of
  // them after the page was left starts a refresh.
  const back = () => {
    if (!state.away || document.visibilityState === 'hidden') return;
    state.away = false;
    void refreshOnReturn(document, releaseId);
  };
  windowObject.addEventListener('blur', leave, { signal });
  windowObject.addEventListener('focus', back, { signal });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') leave();
    else back();
  }, { signal });
  windowObject.addEventListener('pagehide', () => {
    listeners.abort();
    state.returnListeners = null;
    state.away = false;
  }, { signal });
}

/**
 * Refreshes Release Detail in place after each acknowledged Edit Release save
 * of the release it shows. Binds once per document.
 */
export function enhanceReleaseDetailRefresh(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const releaseId = document?.querySelector?.(PAGE_SELECTOR)?.getAttribute('data-release-detail');
  if (!releaseId || isEnhancementBound(document.documentElement, BOUND_KEY)) return false;
  markEnhancementBound(document.documentElement, BOUND_KEY);
  document.addEventListener(RELEASE_EDIT_SAVED_EVENT, (event) => {
    if (String(event.detail?.releaseId ?? '') !== releaseId) return;
    void refreshAfterSave(document, releaseId);
  });
  // close does not bubble: capture it, then check once the dialog lifecycle
  // has finished closing (it clears its open state in its own listener).
  document.addEventListener('close', (event) => {
    if (!event.target?.closest?.(`[${STALE_ATTRIBUTE}]`)) return;
    liveRegionWindow(document).setTimeout(() => reconcileDeferred(document, releaseId), 0);
  }, true);
  document.addEventListener(RELEASE_SOCIAL_PREP_COMPANION_SETTLED_EVENT, (event) => {
    if (event.detail?.launchAttempted === true) armReturnRefresh(document, releaseId);
    if (!event.target?.closest?.(`[${STALE_ATTRIBUTE}]`)) return;
    reconcileDeferred(document, releaseId);
  });
  return true;
}
