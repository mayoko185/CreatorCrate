import { isEnhancementBound, markEnhancementBound, liveRegionWindow } from './dom.js';
import { enhancePreviewMedia } from './preview.js';
import { PROJECT_EDIT_SAVED_EVENT } from './project-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// Project Detail refreshes in place after an Edit Project save: the page is
// fetched again with a GET and each server-rendered region whose content
// depends on editable project fields (data-project-detail-region) is replaced
// from that render, together with the page heading and document title. The
// Releases section, the dialogs and the dialog feedback notice sit outside
// every region and are never replaced. Scroll position and focus are kept.
const PAGE_SELECTOR = '[data-project-detail]';
const REGION_SELECTOR = '[data-project-detail-region]';
const STATE_KEY = '__creatorCrateProjectDetailRefresh';
const BOUND_KEY = 'projectDetailRefreshBound';
const RETRY_KEY = 'retryButton';
// Deep-link and notice markers apply to the first render only; a refresh
// must never carry them into the regions it adopts.
const ONE_SHOT_PARAMS = ['edit', 'returnTo', 'notice'];
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, [tabindex]';

const SAVED_MESSAGE = 'Project updated.';
const REFRESHING_MESSAGE = 'Project saved. Refreshing Project Detail…';
const STALE_MESSAGE = 'Project saved, but Project Detail could not refresh. The information shown may be out of date.';
const SIGNED_OUT_MESSAGE = 'Project saved, but your CreatorCrate sign-in has expired, so Project Detail could not refresh. Sign in again, then retry.';

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

function refreshUrl(windowObject, projectId) {
  const current = new URL(windowObject.location.href);
  const url = new URL(`/projects/${projectId}`, current.origin);
  current.searchParams.forEach((value, name) => {
    if (!ONE_SHOT_PARAMS.includes(name)) url.searchParams.append(name, value);
  });
  return url;
}

function regionsByName(root) {
  const regions = new Map();
  root.querySelectorAll(REGION_SELECTOR).forEach((region) => {
    const name = region.getAttribute('data-project-detail-region');
    regions.set(name, regions.has(name) ? null : region);
  });
  return regions;
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

function applyRefresh(document, parsed, projectId) {
  const page = document.querySelector(PAGE_SELECTOR);
  const nextPage = parsed.querySelector(PAGE_SELECTOR);
  if (!page || nextPage?.getAttribute('data-project-detail') !== projectId) return false;
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

  current.forEach((region, name) => {
    const replacement = document.importNode(next.get(name), true);
    if (active && region.contains(active)) {
      focusTarget = focusCounterpart(region, replacement, active);
      focusLost = true;
    }
    region.replaceWith(replacement);
    enhancePreviewMedia(replacement);
  });

  // The heading and title carry the project title.
  const title = parsed.querySelector('title')?.textContent;
  if (title) document.title = title;
  for (const selector of ['.app-section-title', '.mobile-nav-section']) {
    const nextText = parsed.querySelector(selector)?.textContent;
    if (nextText) document.querySelectorAll(selector).forEach((element) => { element.textContent = nextText; });
  }

  if (focusLost) (focusTarget || document.getElementById('main-content'))?.focus?.({ preventScroll: true });
  windowObject.scrollTo?.(scrollX, scrollY);
  return 'refreshed';
}

function refreshState(document) {
  document[STATE_KEY] ||= { generation: 0, abort: null, [RETRY_KEY]: null };
  return document[STATE_KEY];
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

/**
 * Fetches Project Detail again and replaces its project regions. Only a GET
 * is ever sent, so the save is never repeated. Each refresh supersedes any
 * older one still in flight, so a late response can never overwrite a newer
 * save. Resolves to 'refreshed', 'failed', 'signed-out' or 'superseded'.
 */
export async function refreshProjectDetail(document, projectId) {
  const state = refreshState(document);
  state.generation += 1;
  const generation = state.generation;
  state.abort?.abort();
  const windowObject = liveRegionWindow(document);
  const abort = typeof windowObject.AbortController === 'function' ? new windowObject.AbortController() : null;
  state.abort = abort;
  let outcome = 'failed';
  try {
    const response = await windowObject.fetch(refreshUrl(windowObject, projectId).href, {
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
      outcome = applyRefresh(document, parsed, projectId) || 'failed';
    }
  } catch {
    if (generation !== state.generation) return 'superseded';
  }
  state.abort = null;
  return outcome;
}

async function refreshAfterSave(document, projectId, { focusResult = false } = {}) {
  const state = refreshState(document);
  removeStatusRetry(state, RETRY_KEY);
  const outcome = await refreshProjectDetail(document, projectId);
  // A newer save or retry owns the outcome now.
  if (outcome === 'superseded') return;
  if (outcome === 'refreshed') {
    setFeedback(document, SAVED_MESSAGE);
    if (focusResult) document.querySelector(`[data-project-edit-id="${projectId}"]`)?.focus?.();
    return;
  }
  // The save itself succeeded: only the page is stale, so the retry repeats
  // the GET, never the save.
  const notice = setFeedback(document, outcome === 'signed-out' ? SIGNED_OUT_MESSAGE : STALE_MESSAGE, 'error');
  const retry = notice ? showStatusRetry({
    state,
    status: notice,
    attribute: 'data-project-detail-refresh-retry',
    key: RETRY_KEY,
    onRetry: ({ wasFocused }) => {
      setFeedback(document, REFRESHING_MESSAGE, 'pending');
      return refreshAfterSave(document, projectId, { focusResult: wasFocused });
    },
  }) : null;
  if (focusResult) retry?.focus?.();
}

export function enhanceProjectDetailRefresh(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const page = document?.querySelector?.(PAGE_SELECTOR);
  if (!page || isEnhancementBound(document.documentElement, BOUND_KEY)) return false;
  markEnhancementBound(document.documentElement, BOUND_KEY);
  document.addEventListener(PROJECT_EDIT_SAVED_EVENT, (event) => {
    // The page marker sits on a region, so it is read from the current one.
    const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail');
    // Only a save of the project this page shows changes it.
    if (String(event.detail?.projectId) !== projectId) return;
    void refreshAfterSave(document, projectId);
  });
  return true;
}
