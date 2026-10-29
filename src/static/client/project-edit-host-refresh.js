import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { beginProjectsDefaultsLiveRefresh, refreshProjectsLiveRegion } from './live-regions.js';
import { PROJECT_EDIT_SAVED_EVENT } from './project-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// Projects and Project Assets keep their page after an Edit Project save
// (project-edit-dialog.js) and bring their own project content up to date
// from PROJECT_EDIT_SAVED_EVENT. The save is never repeated: Projects
// refreshes its live region with a GET (filters, view, page and scroll stay
// as shown) and offers Retry refresh if that fails; Project Assets applies the
// saved title in place and re-reads only its Open locally link (a GET), so
// asset selection, pending order and every other draft on the page are left
// alone. Project Detail and the Dashboard refresh
// themselves (project-detail-refresh.js, dashboard.js).
const PROJECTS_REGION_SELECTOR = '[data-projects-live-region]';
const PROJECT_ASSETS_TITLE_SOURCE_SELECTOR = '[data-project-assets-project-title]';
const PROJECT_ASSETS_REGION_SELECTOR = '[data-project-assets-live-region]';
const PROJECT_ASSETS_TITLE_SELECTOR = '[data-project-assets-title]';
const PROJECT_ASSETS_OPEN_LOCALLY_SELECTOR = '[data-project-assets-open-locally]';
const INFO_TRIGGER_SELECTOR = '[data-calendar-info-trigger]';
const BOUND_KEY = 'projectEditHostRefreshBound';
const STATE_KEY = '__creatorCrateProjectEditHostRefresh';
const RETRY_KEY = 'retryButton';
const OPEN_LOCALLY_RETRY_KEY = 'openLocallyRetryButton';

const SAVED_MESSAGE = 'Project updated.';
const PROJECTS_REFRESHING_MESSAGE = 'Project saved. Refreshing Projects…';
const PROJECTS_STALE_MESSAGE = 'Project saved, but Projects could not refresh. The information shown may be out of date.';
const OPEN_LOCALLY_REFRESHING_MESSAGE = 'Project saved. Refreshing Open locally…';
const OPEN_LOCALLY_STALE_MESSAGE = 'Project saved, but Open locally could not refresh. It is unavailable until it refreshes.';

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

function hostState(document) {
  document[STATE_KEY] ||= { [RETRY_KEY]: null, focusedTrigger: null };
  return document[STATE_KEY];
}

// The refreshed List replaces the title that opened an information card (the
// dialog returns focus to it), so focus lost with it moves to the same
// project's title in the new region. A project the save moved out of the
// active filters has no title there any more, so focus moves to the page's
// main content instead of being left on the document body. Focus the user
// has already moved elsewhere is never taken.
function restoreInfoCardFocus(document) {
  const previous = hostState(document).focusedTrigger;
  const active = document.activeElement;
  if (!previous || previous.isConnected || (active && active !== document.body)) return;
  const cardId = previous.getAttribute('aria-controls');
  const replacement = cardId
    ? document.querySelector(`${INFO_TRIGGER_SELECTOR}[aria-controls="${CSS.escape(cardId)}"]`)
    : null;
  (replacement || document.getElementById('main-content'))?.focus?.({ preventScroll: true });
}

function refreshProjectsAfterSave(document, { focusResult = false } = {}) {
  const state = hostState(document);
  removeStatusRetry(state, RETRY_KEY);
  const fail = () => {
    // The project is saved; only the List is stale, so Retry repeats the GET.
    const notice = setFeedback(document, PROJECTS_STALE_MESSAGE, 'error');
    const retry = notice ? showStatusRetry({
      state,
      status: notice,
      attribute: 'data-projects-edit-refresh-retry',
      key: RETRY_KEY,
      onRetry: ({ wasFocused }) => {
        setFeedback(document, PROJECTS_REFRESHING_MESSAGE, 'pending');
        refreshProjectsAfterSave(document, { focusResult: wasFocused });
      },
    }) : null;
    if (focusResult) retry?.focus?.();
  };
  const generation = beginProjectsDefaultsLiveRefresh(document);
  const result = generation === null ? 'unavailable' : refreshProjectsLiveRegion(document, null, generation, {
    // The page feedback reports the outcome; the region stays quiet.
    failureMessage: '',
    onError: fail,
    onSuccess: () => {
      setFeedback(document, SAVED_MESSAGE);
      restoreInfoCardFocus(document);
      if (focusResult) document.getElementById('main-content')?.focus?.({ preventScroll: true });
    },
  });
  if (result !== 'started') fail();
}

function replaceSuffix(value, oldSuffix, newSuffix) {
  return value.endsWith(oldSuffix) ? `${value.slice(0, -oldSuffix.length)}${newSuffix}` : value;
}

// Project Assets shows only the project title: in the page heading and
// document title, the category dialog's description and the list previews'
// accessible names. Each is updated from the saved title in place.
function applyProjectAssetsTitle(document, source, title) {
  const previous = source.getAttribute('data-project-assets-project-title');
  if (typeof title !== 'string' || !title || title === previous) return;
  source.setAttribute('data-project-assets-project-title', title);
  const previousHeading = `Assets — ${previous}`;
  const heading = `Assets — ${title}`;
  document.title = replaceSuffix(document.title, previousHeading, heading);
  document.querySelectorAll('.app-section-title, .mobile-nav-section').forEach((element) => {
    if (element.textContent.trim() === previousHeading) element.textContent = heading;
  });
  document.querySelectorAll(PROJECT_ASSETS_TITLE_SELECTOR).forEach((element) => {
    element.textContent = title;
  });
  document.querySelector(PROJECT_ASSETS_REGION_SELECTOR)?.querySelectorAll('[aria-label]').forEach((element) => {
    const label = element.getAttribute('aria-label');
    const next = replaceSuffix(label, ` from ${previous}`, ` from ${title}`);
    if (next !== label) element.setAttribute('aria-label', next);
  });
}

// A save can rename the project folder, so the Open locally link is re-read
// from the server's render of this page (a GET of the current URL, which
// carries the active category); only the link's href changes, so the asset
// region and its drafts stay as they are. Until that answer arrives, or if it
// cannot be had, the link is disabled rather than left pointing at a folder
// that may no longer exist, and Retry refresh repeats only the GET.
function refreshProjectAssetsOpenLocally(document, source, { focusResult = false, afterRetry = false } = {}) {
  const link = document.querySelector(PROJECT_ASSETS_OPEN_LOCALLY_SELECTOR);
  if (!link) return;
  const state = hostState(document);
  removeStatusRetry(state, OPEN_LOCALLY_RETRY_KEY);
  const generation = (state.openLocallyGeneration || 0) + 1;
  state.openLocallyGeneration = generation;
  link.removeAttribute('href');
  link.setAttribute('aria-disabled', 'true');
  const windowObject = document.defaultView || globalThis;
  const fail = () => {
    if (generation !== state.openLocallyGeneration || !link.isConnected) return;
    const notice = setFeedback(document, OPEN_LOCALLY_STALE_MESSAGE, 'error');
    const retry = notice ? showStatusRetry({
      state,
      status: notice,
      attribute: 'data-project-assets-open-locally-retry',
      key: OPEN_LOCALLY_RETRY_KEY,
      onRetry: ({ wasFocused }) => {
        setFeedback(document, OPEN_LOCALLY_REFRESHING_MESSAGE, 'pending');
        refreshProjectAssetsOpenLocally(document, source, { focusResult: wasFocused, afterRetry: true });
      },
    }) : null;
    if (focusResult) retry?.focus?.();
  };
  let request;
  try {
    request = windowObject.fetch(windowObject.location.href, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow',
      cache: 'no-store',
      headers: { Accept: 'text/html' },
    });
  } catch {
    fail();
    return;
  }
  Promise.resolve(request)
    .then((response) => {
      if (!response?.ok || typeof response.text !== 'function') throw new Error('Open locally refresh failed.');
      return response.text();
    })
    .then((html) => {
      // A newer refresh owns the link, or the region was re-rendered after
      // the save and already shows the server's current link.
      if (generation !== state.openLocallyGeneration || !link.isConnected) return;
      const parsed = new windowObject.DOMParser().parseFromString(html, 'text/html');
      const projectId = source.getAttribute('data-project-edit-id');
      const parsedSource = parsed.querySelector(PROJECT_ASSETS_TITLE_SOURCE_SELECTOR);
      if (!parsedSource || parsedSource.getAttribute('data-project-edit-id') !== projectId) {
        throw new Error('Open locally refresh returned another page.');
      }
      const href = parsed.querySelector(PROJECT_ASSETS_OPEN_LOCALLY_SELECTOR)?.getAttribute('href');
      // A first attempt leaves the dialog's own saved message in place.
      if (afterRetry) setFeedback(document, SAVED_MESSAGE);
      if (!href) {
        // The server no longer offers Open locally for this project.
        link.remove();
        if (focusResult) document.getElementById('main-content')?.focus?.({ preventScroll: true });
        return;
      }
      link.setAttribute('href', href);
      link.removeAttribute('aria-disabled');
      if (focusResult) link.focus?.({ preventScroll: true });
    })
    .catch(fail);
}

export function enhanceProjectEditHostRefresh(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  if (!document?.documentElement || isEnhancementBound(document.documentElement, BOUND_KEY)) return false;
  const projects = document.querySelector(PROJECTS_REGION_SELECTOR);
  const assetsSource = document.querySelector(PROJECT_ASSETS_TITLE_SOURCE_SELECTOR);
  if (!projects && !assetsSource) return false;
  markEnhancementBound(document.documentElement, BOUND_KEY);
  if (projects) {
    document.addEventListener('focusin', (event) => {
      hostState(document).focusedTrigger = event.target?.matches?.(INFO_TRIGGER_SELECTOR) ? event.target : null;
    });
  }
  document.addEventListener(PROJECT_EDIT_SAVED_EVENT, (event) => {
    if (projects) {
      refreshProjectsAfterSave(document);
      return;
    }
    // Only a save of the project this page shows changes it.
    if (String(event.detail?.projectId) !== assetsSource.getAttribute('data-project-edit-id')) return;
    applyProjectAssetsTitle(document, assetsSource, event.detail?.project?.title);
    refreshProjectAssetsOpenLocally(document, assetsSource);
  });
  return true;
}
