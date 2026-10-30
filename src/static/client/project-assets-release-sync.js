import { updateAssetSelectionState } from './asset-ordering.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';
import { isProjectAssetsLoadInFlight, PROJECT_ASSETS_REGION_LOADED_EVENT } from './live-regions.js';
import { syncRenderedSelect } from './project-asset-category-sync.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// A release created from selected assets leaves the user on Project Assets, so
// the page re-reads the server's render of itself (a GET) and adopts only what
// depends on releases: the Add to release options and each shown asset's
// release sections. The asset region is not replaced, so selections, pending
// order, filters and drafts stay as they are. Until that answer arrives, or if
// it cannot be had, Add to release is unavailable rather than offering options
// known to be stale, and Retry refresh repeats only the GET.
const STATE_KEY = '__creatorCrateProjectAssetsReleaseSync';
const RETRY_KEY = 'retryButton';
const RELEASE_SELECT_SELECTOR = '[data-asset-selection-form] [data-release-select]';
const ASSET_CARD_SELECTOR = '[data-project-assets-live-region] [data-asset-id]';
const RELEASE_SECTION_SELECTOR = '.asset-card-associations, .asset-list-cell--releases, [data-asset-release-section]';
const NOTE_ATTRIBUTE = 'data-release-create-refresh-note';
const DISMISS_SELECTOR = '[data-release-create-dismiss]';
const TRIGGER_SELECTOR = '[data-asset-actions-panel] [data-dialog-open="release-create-dialog"]';

const REFRESHING_MESSAGE = 'Refreshing release information…';
const STALE_MESSAGE = 'The release was created, but this page could not refresh its release information. Add to release is unavailable until it refreshes.';

function syncState(document) {
  document[STATE_KEY] ||= { generation: 0, unresolved: false, resyncAfterLoad: false, [RETRY_KEY]: null };
  return document[STATE_KEY];
}

function feedbackElement(document) {
  return document.querySelector('[data-dialog-feedback]');
}

// The note and its Retry refresh sit beside the feedback text, so a later
// message from another dialog cannot take the only way back to a usable page.
function setNote(document, state, message, onRetry = null) {
  removeStatusRetry(state, RETRY_KEY);
  const feedback = feedbackElement(document);
  let note = feedback?.querySelector(`[${NOTE_ATTRIBUTE}]`);
  if (!message) {
    note?.remove();
    return null;
  }
  if (!feedback) return null;
  if (!note) {
    note = document.createElement('p');
    note.setAttribute(NOTE_ATTRIBUTE, '');
    feedback.append(note);
  }
  note.textContent = message;
  if (!onRetry) return null;
  return showStatusRetry({
    state,
    status: feedback,
    attribute: 'data-release-create-refresh-retry',
    key: RETRY_KEY,
    onRetry,
  });
}

function setReleaseTargetsAvailable(document, available) {
  const select = document.querySelector(RELEASE_SELECT_SELECTOR);
  if (!select) return;
  select.disabled = !available;
  syncCreatorCrateDropdownFromNative(select);
  if (!available) {
    const dropdown = select.nextElementSibling;
    if (dropdown?.open) dropdown.open = false;
  }
  if (select.form) updateAssetSelectionState(select.form, document);
}

// While the page is out of date its notice stays, with the way to recover.
function setDismissAvailable(document, available) {
  const dismiss = document.querySelector(DISMISS_SELECTOR);
  if (dismiss) dismiss.hidden = !available;
}

function resolve(document, state) {
  const retryHadFocus = Boolean(state[RETRY_KEY]) && document.activeElement === state[RETRY_KEY];
  state.unresolved = false;
  setNote(document, state, '');
  setReleaseTargetsAvailable(document, true);
  setDismissAvailable(document, true);
  if (retryHadFocus) document.querySelector(TRIGGER_SELECTOR)?.focus?.({ preventScroll: true });
}

function adoptReleaseSections(card, rendered) {
  const sections = card.querySelectorAll(RELEASE_SECTION_SELECTOR);
  const renderedSections = rendered.querySelectorAll(RELEASE_SECTION_SELECTOR);
  if (sections.length !== renderedSections.length) return;
  sections.forEach((section, index) => {
    const next = renderedSections[index];
    if (section.isEqualNode(next)) return;
    const wasOpen = Boolean(section.querySelector('details[open]'));
    const hadFocus = section.contains(section.ownerDocument.activeElement);
    section.replaceWith(next);
    if (wasOpen) next.querySelector('details')?.setAttribute('open', '');
    if (hadFocus) (next.querySelector('a, summary, [tabindex]') || card).focus?.({ preventScroll: true });
  });
}

// Throws for anything but this page's server render, which leaves the page as
// it was and reports the refresh as failed.
function adoptRenderedPage(document, parsed) {
  const select = document.querySelector(RELEASE_SELECT_SELECTOR);
  const rendered = parsed.querySelector(RELEASE_SELECT_SELECTOR);
  if (!select || !rendered
    || select.form?.getAttribute('action') !== rendered.form?.getAttribute('action')) {
    throw new Error('Release information refresh returned another page.');
  }
  syncRenderedSelect(select, rendered);

  const renderedCards = new Map(Array.from(parsed.querySelectorAll(ASSET_CARD_SELECTOR))
    .map((card) => [card.getAttribute('data-asset-id'), card]));
  document.querySelectorAll(ASSET_CARD_SELECTOR).forEach((card) => {
    const renderedCard = renderedCards.get(card.getAttribute('data-asset-id'));
    if (renderedCard) adoptReleaseSections(card, renderedCard);
  });
}

// The current page's own URL, except that "Not used by a release" no longer
// lists the assets that were just used; without that filter the render covers
// every asset the page is showing, whichever page of the results they are on.
function releaseInformationUrl(windowObject) {
  const url = new URL(windowObject.location.href);
  url.hash = '';
  if (url.searchParams.get('usage') === 'unused') {
    url.searchParams.delete('usage');
    url.searchParams.delete('page');
    url.searchParams.set('pageSize', 'all');
  }
  return url.href;
}

function refresh(document, { focusResult = false, afterRetry = false } = {}) {
  const state = syncState(document);
  const generation = state.generation + 1;
  state.generation = generation;
  state.unresolved = true;
  setNote(document, state, afterRetry ? REFRESHING_MESSAGE : '');
  setReleaseTargetsAvailable(document, false);
  setDismissAvailable(document, false);
  const windowObject = document.defaultView || globalThis;
  const fail = () => {
    if (generation !== state.generation) return;
    const retry = setNote(document, state, STALE_MESSAGE, ({ wasFocused }) => {
      refresh(document, { focusResult: wasFocused, afterRetry: true });
    });
    if (focusResult) retry?.focus?.();
  };
  let request;
  try {
    request = windowObject.fetch(releaseInformationUrl(windowObject), {
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
      if (!response?.ok || typeof response.text !== 'function') throw new Error('Release information refresh failed.');
      return response.text();
    })
    .then((html) => {
      // A later create or region load owns the release information now.
      if (generation !== state.generation) return;
      adoptRenderedPage(document, new windowObject.DOMParser().parseFromString(html, 'text/html'));
      resolve(document, state);
      if (focusResult) document.querySelector(TRIGGER_SELECTOR)?.focus?.({ preventScroll: true });
    })
    .catch(fail);
}

// A filter or view load already on its way when the create was confirmed may
// have been rendered before it, so its region is read again once it lands. Any
// later load is rendered after the create and is itself the authoritative
// page, which settles an unresolved refresh.
export function syncProjectAssetsReleaseHost(document) {
  syncState(document).resyncAfterLoad = isProjectAssetsLoadInFlight(document);
  refresh(document);
}

export function bindProjectAssetsReleaseSync(document) {
  document.addEventListener(PROJECT_ASSETS_REGION_LOADED_EVENT, () => {
    const state = syncState(document);
    if (state.resyncAfterLoad) {
      state.resyncAfterLoad = false;
      refresh(document);
      return;
    }
    if (!state.unresolved) return;
    state.generation += 1;
    resolve(document, state);
  });
}
