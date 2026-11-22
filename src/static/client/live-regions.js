import {
  isEnhancementBound,
  liveRegionDocument,
  liveRegionWindow,
  markEnhancementBound,
} from './dom.js';
import {
  enhancePreviewMedia,
  enhanceProjectCards,
} from './preview.js';
import {
  captureAssetRenameDrafts,
  captureAssetSelection,
  captureAutoRenameOrderDraft,
  clearRetainedAssetSelection,
  enhanceAssetAutoRenameOrdering,
  enhanceAssetRenames,
  enhanceAssetSelection,
  restoreAssetRenameDrafts,
  restoreAssetSelection,
  restoreAutoRenameOrderDraft,
} from './asset-ordering.js';
import { enhanceAppDialogs, enhanceAutoSubmit } from './app-dialogs.js';
import {
  PROJECT_ASSET_CATEGORIES_CHANGED,
  syncProjectAssetCategoryConsumers,
} from './project-asset-category-sync.js';
import { enhanceAppConfirmationControls } from './confirm-dialog.js';
import {
  enhanceAssetViewerInfoCards,
  enhanceCalendarInfoCards,
  enhanceDashboardTitleInfoCards,
  enhanceProjectInfoCards,
  dismissActiveGridInfoCard,
} from './info-cards.js';
import { enhanceNumberInputs } from './number-input.js';
import {
  CC_DROPDOWN_SELECTOR,
  enhanceAssetViewerFilterDisclosures,
  enhanceDropdowns,
  enhanceProjectAssetCategoryFilter,
  initializeCreatorCrateDropdown,
  syncCreatorCrateDropdownFromNative,
  updateAssetViewerFilterDisclosureState,
} from './dropdowns.js';
import {
  ASSET_GRID_SIZE_CONFIG,
  ASSET_LIST_SIZE_CONFIG,
  enhanceAssetGridSize,
  enhanceAssetGridStyle,
  enhanceAssetListSize,
  enhanceProjectGridSize,
  gridSizeIsValid,
} from './size-preferences.js';
import {
  PROJECT_ASSETS_VIEWER_SEQUENCE_SELECTOR,
  refreshProjectAssetsViewer,
} from './project-assets-viewer.js';
import {
  ASSET_LIBRARY_VIEWER_SEQUENCE_SELECTOR,
  refreshAssetLibraryViewer,
} from './asset-library-viewer.js';
import { refreshReleaseAssetsViewer } from './release-assets-viewer.js';
import { enhanceNotesCodeBlocks } from './notes-editor.js';
import { RELEASE_ARCHIVED_EVENT, RELEASE_DELETED_EVENT, RELEASE_EDIT_SAVED_EVENT } from './release-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';
const PROJECTS_LIVE_REGION_SELECTOR = '[data-projects-live-region]';
const PROJECTS_FILTER_SELECTOR = '#project-filters';
const PROJECTS_LIVE_STATUS_SELECTOR = '[data-projects-live-status]';
const PROJECTS_LIVE_STATE_ATTRIBUTE = 'data-projects-live-state';
const PROJECTS_NSFW_FORM_SELECTOR = '[data-projects-nsfw-filter]';
const PROJECTS_NSFW_TOGGLE_SELECTOR = '[data-projects-nsfw-toggle]';
// WP10b: the results Search of the Projects Filters & Defaults dialog.
const PROJECTS_SEARCH_SELECTOR = '#projects-search';
const PROJECTS_DROPDOWN_SEARCH_SELECTOR = '#project-filters [data-cc-dropdown-search]';
const PROJECTS_LIVE_DEBOUNCE_MS = 350;
const RELEASES_LIVE_REGION_SELECTOR = '[data-releases-live-region]';
const RELEASES_FILTER_SELECTOR = '[data-releases-filter]';
const RELEASES_LIVE_STATUS_SELECTOR = '[data-releases-live-status]';
const RELEASES_LIVE_STATE_ATTRIBUTE = 'data-releases-live-state';
const RELEASES_DEFAULTS_FORM_SELECTOR = '#releases-defaults-form';
const CALENDAR_LIVE_REGION_SELECTOR = '[data-calendar-live-region]';
const CALENDAR_FILTER_SELECTOR = '#calendar-filters';
const CALENDAR_RESET_SELECTOR = '[data-calendar-reset]';
const CALENDAR_MONTH_DIALOG_ID = 'calendar-month-dialog';
const RELEASE_ASSETS_LIVE_REGION_SELECTOR = '[data-release-assets-live-region]';
const RELEASE_ASSETS_LIVE_FILTER_SELECTOR = '[data-release-assets-live-filter]';
const RELEASE_ASSETS_LIVE_FILTER_CONTROL_SELECTOR = [
  '[data-release-assets-live-filter-control]',
  '[data-release-assets-live-page-size]',
].join(', ');
const RELEASE_ASSETS_PAGE_SIZE_FORM_SELECTOR = '.page-size-form[data-release-assets-live-page-size-form]';
const RELEASE_ASSETS_LIVE_SEARCH_SELECTOR = '[data-release-assets-live-search]';
const RELEASE_ASSETS_LIVE_STATUS_SELECTOR = '[data-release-assets-live-status]';
const RELEASE_ASSETS_LIVE_STATE_ATTRIBUTE = 'data-release-assets-live-state';
const RELEASE_ASSETS_LIVE_DEBOUNCE_MS = 350;
const RELEASE_ASSETS_SELECTION_FORM_SELECTOR = '[data-asset-selection-form][id="release-assets-form"]';
const RELEASE_ASSETS_SELECTION_CHECKBOX_SELECTOR = 'input[type="checkbox"][name="selectedAssetIds"][form="release-assets-form"]';
const RELEASE_ASSETS_HIDDEN_MEMBERSHIP_SELECTOR = '[data-release-assets-hidden-membership]';
const RELEASE_ASSETS_PERSISTED_MEMBERSHIP_SELECTOR = '[data-release-assets-persisted-membership]';
const NOTES_BOOKS_LIVE_REGION_SELECTOR = '[data-notes-books-live-region]';
const NOTES_BOOKS_LIVE_STATUS_SELECTOR = '[data-notes-books-live-status]';
const NOTES_BOOKS_LIVE_STATE_ATTRIBUTE = 'data-notes-books-live-state';
const BOOK_DETAIL_LIVE_REGION_SELECTOR = '[data-book-detail-live-region]';
const BOOK_DETAIL_LIVE_STATUS_SELECTOR = '[data-book-detail-live-status]';
const BOOK_DETAIL_LIVE_STATE_ATTRIBUTE = 'data-book-detail-live-state';

function projectLiveNsfwForm(region) {
  return region?.querySelector?.(PROJECTS_NSFW_FORM_SELECTOR) || null;
}

function projectLiveNsfwEnabled(form) {
  const value = form?.querySelector?.('[data-projects-nsfw-value]')?.value
    || form?.querySelector?.('[data-projects-nsfw-value]')?.getAttribute?.('value');
  return value === '1';
}

function projectLiveRenderedNsfwEnabled(region) {
  return region?.querySelector?.(PROJECTS_NSFW_TOGGLE_SELECTOR)?.getAttribute?.('aria-pressed') === 'true';
}

function updateProjectsNsfwControls(scope, enabled, pending = false) {
  const controls = Array.from(scope?.querySelectorAll?.(PROJECTS_NSFW_TOGGLE_SELECTOR) || []);
  const label = enabled ? 'Disable NSFW filter' : 'Enable NSFW filter';
  controls.forEach((control) => {
    control.disabled = pending;
    if (pending) control.setAttribute?.('disabled', '');
    else control.removeAttribute?.('disabled');
    control.setAttribute?.('aria-pressed', String(enabled));
    control.setAttribute?.('aria-label', label);
    control.setAttribute?.('data-tooltip', label);
  });
  scope?.querySelectorAll?.(PROJECTS_NSFW_FORM_SELECTOR).forEach((form) => {
    const value = form.querySelector?.('[data-projects-nsfw-value]');
    if (value) value.value = enabled ? '0' : '1';
    if (pending) form.setAttribute?.('aria-busy', 'true');
    else form.removeAttribute?.('aria-busy');
  });
}

function liveRegionCaptureState(region, document) {
  const active = document?.activeElement;
  const focus = active && region?.contains?.(active)
    ? {
      id: active.id || active.getAttribute?.('id') || '',
      name: active.name || active.getAttribute?.('name') || '',
      type: active.type || active.getAttribute?.('type') || '',
      value: active.value ?? active.getAttribute?.('value') ?? '',
      selectionStart: Number.isInteger(active.selectionStart) ? active.selectionStart : null,
      selectionEnd: Number.isInteger(active.selectionEnd) ? active.selectionEnd : null,
    }
    : null;
  const openDisclosures = Array.from(region?.querySelectorAll?.('details') || [])
    .filter((details) => details.open === true)
    .map((details) => ({
      id: details.id || details.getAttribute?.('id') || '',
      controls: details.querySelector?.('summary')?.getAttribute?.('aria-controls') || '',
    }));
  return { focus, openDisclosures };
}

function liveRegionFindFocus(region, focus) {
  if (!region || !focus) return null;
  const controls = Array.from(region.querySelectorAll?.('input, select, textarea, button, summary, a[id]') || []);
  return controls.find((control) => {
    if (focus.id && (control.id || control.getAttribute?.('id')) === focus.id) return true;
    return Boolean(focus.name)
      && (control.name || control.getAttribute?.('name')) === focus.name
      && String(control.type || control.getAttribute?.('type') || '') === focus.type
      && String(control.value ?? control.getAttribute?.('value') ?? '') === String(focus.value);
  }) || null;
}

function liveRegionRestoreState(region, document, captured) {
  captured?.openDisclosures?.forEach(({ id, controls }) => {
    const details = Array.from(region?.querySelectorAll?.('details') || []).find((candidate) => (
      (id && (candidate.id || candidate.getAttribute?.('id')) === id)
        || (controls && candidate.querySelector?.('summary')?.getAttribute?.('aria-controls') === controls)
    ));
    if (details) details.open = true;
  });

  const focus = liveRegionFindFocus(region, captured?.focus);
  if (!focus) return;
  focus.focus?.({ preventScroll: true });
  if (captured.focus.selectionStart !== null && typeof focus.setSelectionRange === 'function') {
    focus.setSelectionRange(captured.focus.selectionStart, captured.focus.selectionEnd);
  }
}

function enhanceProjectsLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceNumberInputs(region);
  enhanceProjectCards(region);
  enhanceProjectGridSize(region);
  enhanceDropdowns(liveRegionDocument(region));
  enhanceProjectInfoCards(region);
  enhanceDashboardTitleInfoCards(region);
}

function liveFilterFailureMessage(label) {
  return (_state, _url, historyMode) => {
    if (historyMode === 'none') return `${label} couldn't be refreshed. The results shown may be out of date.`;
    if (historyMode === 'replace') return `${label} couldn't be loaded for this address. The previous results are still displayed and may not match it.`;
    return `${label} couldn't be updated. The requested filters were not applied, and the previous results are still displayed.`;
  };
}

function sameResponsePath(finalUrl, requestedUrl) {
  return finalUrl.pathname === requestedUrl.pathname;
}

// Two addresses name the same document state: same origin, path and query
// (the fragment is not part of the filter state). Exact query comparison:
// repeated keys and their order are significant and never normalized here.
function liveRegionSameAddress(url, href) {
  if (!url || !href) return false;
  let shown;
  try {
    shown = new URL(href);
  } catch {
    return false;
  }
  return url.origin === shown.origin && url.pathname === shown.pathname && url.search === shown.search;
}

export function createLiveRegionEngine(config) {
  const {
    regionSelector,
    formSelector,
    formScope = 'region',
    linkSelector = null,
    linkScope = 'region',
    searchSelector = null,
    changeSelector = null,
    debounceMs = 0,
    defaultAction = '/',
    stateKey = '__creatorCrateLiveRegion',
    historyState = null,
    statusSelector = null,
    statusStateAttribute = null,
    loadingMessage = '',
    fallbackMessage = '',
    responseErrorMessage = 'Live-region response failed.',
    missingRegionMessage = 'Live-region response did not contain the live region.',
    enhanceRegion = () => {},
    onCreate = null,
    onBindRegion = null,
    onInvalidate = null,
    onLoadStart = null,
    onResponseParsed = null,
    onRegionReplaced = null,
    onLoadComplete = null,
    onLoadError = null,
    onFormChange = null,
    transformParams = null,
    isCurrentUrl = () => true,
    loadFailureMessage = null,
    responseMatches = null,
    // Optional (state, link, url) hook: returns the destination a followed
    // live link navigates to (default: the link's own rendered address). It
    // runs before the click supersedes any debounced, pending or failed load.
    // Returning false means the hook took the click as intent for the load
    // already in flight: nothing is superseded and no request is sent.
    linkDestination = null,
    // Optional (state, finalUrl, requestedUrl) hook, called with the final
    // (post-redirect) address of the current load's successful response
    // before its body is read. A returned URL continues the same load there:
    // same generation, history mode and Retry address, no install between.
    followResponse = null,
  } = config || {};

  function regionFor(scope) {
    if (scope?.matches?.(regionSelector)) return scope;
    return scope?.querySelector?.(regionSelector) || null;
  }

  function formFor(region) {
    const root = formScope === 'document' ? liveRegionDocument(region) : region;
    const selectors = Array.isArray(formSelector) ? formSelector : [formSelector];
    for (const selector of selectors) {
      const form = root?.querySelector?.(selector);
      if (form) return form;
    }
    return null;
  }

  function formsFor(region) {
    const root = formScope === 'document' ? liveRegionDocument(region) : region;
    const selectors = Array.isArray(formSelector) ? formSelector : [formSelector];
    return selectors.flatMap((selector) => Array.from(root?.querySelectorAll?.(selector) || []));
  }

  function capabilities(windowObject) {
    return Boolean(
      typeof windowObject?.fetch === 'function'
        && typeof windowObject?.FormData === 'function'
        && typeof windowObject?.URLSearchParams === 'function'
        && typeof windowObject?.DOMParser === 'function'
        && typeof windowObject?.history?.pushState === 'function'
        && typeof windowObject?.history?.replaceState === 'function',
    );
  }

  function urlFor(form, windowObject, { preservePage = false } = {}) {
    const action = form?.action || form?.getAttribute?.('action') || defaultAction;
    const url = new URL(action, windowObject.location?.href || defaultAction);
    const params = new windowObject.URLSearchParams(new windowObject.FormData(form));
    transformParams?.(params, form);
    if (preservePage) {
      const currentUrl = new URL(windowObject.location?.href || url.href, url.href);
      if (!params.has('page') && currentUrl.searchParams.has('page')) {
        params.set('page', currentUrl.searchParams.get('page'));
      }
    } else {
      params.delete('page');
    }

    const emptyKeys = [];
    for (const [key, value] of params.entries()) {
      if (value === '') emptyKeys.push(key);
    }
    emptyKeys.forEach((key) => params.delete(key));

    url.search = params.toString();
    url.hash = '';
    return url;
  }

  function nativeSubmit(form) {
    if (!form) return false;
    const formPrototype = globalThis.HTMLFormElement?.prototype;
    if (typeof formPrototype?.submit === 'function') {
      formPrototype.submit.call(form);
      return true;
    }
    if (typeof form.submit === 'function') {
      form.submit();
      return true;
    }
    return false;
  }

  function navigate(windowObject, url) {
    const location = windowObject?.location;
    if (!location) return false;
    if (typeof location.assign === 'function') {
      location.assign(url.href || String(url));
      return true;
    }
    location.href = url.href || String(url);
    return true;
  }

  function status(region, message, state) {
    if (!region) return;
    if (statusStateAttribute) {
      if (state) region.setAttribute?.(statusStateAttribute, state);
      else region.removeAttribute?.(statusStateAttribute);
    }
    const statusElement = statusSelector ? region.querySelector?.(statusSelector) : null;
    if (statusElement) statusElement.textContent = message || '';
  }

  function controller(windowObject) {
    return typeof windowObject?.AbortController === 'function'
      ? new windowObject.AbortController()
      : null;
  }

  function responseUrl(response, requestedUrl, windowObject) {
    const candidate = response?.url || requestedUrl.href;
    return new URL(candidate, windowObject.location?.href || requestedUrl.href);
  }

  function invalidate(state) {
    onInvalidate?.(state, engine);
    state.generation += 1;
    state.controller?.abort?.();
    state.controller = null;
  }

  function installRegion(state, nextRegion, requestedUrl, historyMode) {
    const document = state.document;
    const windowObject = state.window;
    const currentRegion = regionFor(document);
    if (!nextRegion || !currentRegion || !currentRegion.parentNode) {
      throw new Error(missingRegionMessage);
    }

    const captured = liveRegionCaptureState(currentRegion, document);
    if (typeof currentRegion.replaceWith === 'function') currentRegion.replaceWith(nextRegion);
    else currentRegion.parentNode.replaceChild(nextRegion, currentRegion);

    const finalUrl = responseUrl(state.response, requestedUrl, windowObject);
    // WP10b F6: a push whose FINAL canonical address (after any redirect) is
    // the address shown at installation only reconciles the current entry:
    // the state did not change, so Back must not step through a copy of it
    // (e.g. a View reversed before its GET installed). Any other address,
    // including one shown earlier but not now, still adds an entry.
    if (historyMode === 'push' && liveRegionSameAddress(finalUrl, windowObject.location?.href)) {
      historyMode = 'replace';
    }
    if (historyMode === 'push') {
      windowObject.history.pushState(historyState, '', finalUrl.href);
    } else if (historyMode === 'replace' && finalUrl.href !== windowObject.location?.href) {
      windowObject.history.replaceState(historyState, '', finalUrl.href);
    }

    enhanceRegion(nextRegion, state);
    state.region = nextRegion;
    onRegionReplaced?.(state, nextRegion, engine);
    liveRegionRestoreState(nextRegion, document, captured);
    status(nextRegion, '', null);
  }

  function replaceRegion(state, responseText, requestedUrl, historyMode) {
    if (loadFailureMessage) {
      // A redirect to another page or record must not install its fragment.
      const finalUrl = responseUrl(state.response, requestedUrl, state.window);
      const matches = responseMatches
        ? responseMatches(finalUrl, requestedUrl, state)
        : isCurrentUrl(finalUrl, state);
      if (!matches) throw new Error(missingRegionMessage);
    }
    const parser = new state.window.DOMParser();
    const parsed = parser.parseFromString(responseText, 'text/html');
    const nextRegion = parsed.querySelector?.(regionSelector);
    if (!nextRegion) throw new Error(missingRegionMessage);
    onResponseParsed?.(state, parsed, nextRegion, engine);
    installRegion(state, nextRegion, requestedUrl, historyMode);
  }

  function fallback(state, form, requestedUrl, useRequestedUrl = false) {
    if (useRequestedUrl) {
      navigate(state.window, requestedUrl);
      return;
    }
    const currentForms = formsFor(regionFor(state.document));
    if (form && currentForms.includes(form)) {
      if (nativeSubmit(form)) return;
    }
    navigate(state.window, requestedUrl);
  }

  function topOpenDialog(state) {
    return Array.from(state.document.querySelectorAll?.('dialog[open]') || []).at(-1) || null;
  }

  function placeLoadFailureNotice(state) {
    const notice = state.loadFailure?.notice;
    if (!notice) return;
    // A modal makes the page inert, so Retry stays with the open dialog and
    // returns above the results when that dialog closes.
    const anchor = topOpenDialog(state)?.querySelector?.('form') || regionFor(state.document);
    if (anchor?.parentNode && anchor.previousElementSibling !== notice) {
      anchor.parentNode.insertBefore?.(notice, anchor);
    }
  }

  function clearLoadFailure(state) {
    if (!state.loadFailure) return;
    removeStatusRetry(state, 'loadFailureRetryButton');
    state.loadFailure.notice?.remove?.();
    state.loadFailure = null;
  }

  // The last valid results stay installed and the requested controls stay as
  // chosen. state.loadFailure owns the request Retry repeats until any newer
  // load or filter change supersedes it; only a successful install commits it.
  function reportLoadFailure(state, url, historyMode, generation = state.generation) {
    const region = regionFor(state.document);
    const message = loadFailureMessage(state, url, historyMode);
    region?.removeAttribute?.('aria-busy');
    status(region, message, 'error');
    clearLoadFailure(state);

    const notice = state.document.createElement?.('div');
    if (!notice) return;
    notice.className = 'notice notice--error app-dialog-feedback app-dialog-feedback--pinned';
    // The region's live status is inert behind a modal, so the notice speaks there.
    if (topOpenDialog(state)) notice.setAttribute?.('role', 'alert');
    notice.setAttribute?.('data-live-filter-failure', '');
    const text = state.document.createElement?.('p');
    text.textContent = message;
    notice.appendChild?.(text);
    // generation: the failed load, so a Retry can carry that load's ownership.
    const failure = { url, historyMode, notice, generation };
    state.loadFailure = failure;
    placeLoadFailureNotice(state);

    const retry = showStatusRetry({
      state,
      status: notice,
      mount: text,
      attribute: 'data-live-filter-retry',
      key: 'loadFailureRetryButton',
      label: 'Retry',
      onRetry: ({ wasFocused }) => {
        if (state.loadFailure !== failure) return;
        if (state.timer) state.window.clearTimeout?.(state.timer);
        state.timer = null;
        invalidate(state);
        // onLoadStart reads which failed load this Retry repeats.
        state.retryingLoadFailure = failure;
        try {
          load(state, failure.url, failure.historyMode, null);
        } finally {
          state.retryingLoadFailure = null;
        }
        if (!wasFocused) return;
        state.loadFailureFocusRetry = true;
        const target = topOpenDialog(state)?.querySelector?.('input:not([type="hidden"]), select, summary, button')
          || state.document.getElementById?.('main-content');
        target?.focus?.({ preventScroll: true });
      },
    });
    if (state.loadFailureFocusRetry) retry?.focus?.();
    state.loadFailureFocusRetry = false;
  }

  function loadError(state, generation, error, form, url, historyMode, retryUrl = url) {
    if (generation !== state.generation) return;
    state.controller = null;
    if (onLoadError?.(state, generation, error, form, url, historyMode, engine) === true) return;
    if (loadFailureMessage) {
      if (error?.name === 'AbortError') {
        const region = regionFor(state.document);
        region?.removeAttribute?.('aria-busy');
        status(region, '', null);
        return;
      }
      reportLoadFailure(state, retryUrl, historyMode, generation);
      return;
    }
    if (error?.name === 'AbortError') return;
    const region = regionFor(state.document);
    region?.removeAttribute?.('aria-busy');
    status(region, fallbackMessage, 'error');
    fallback(state, form, url, historyMode === 'replace');
  }

  // retryUrl: what Retry repeats if this load fails; a followed response
  // keeps the address of the load it continues.
  function load(state, url, requestedHistoryMode, form, retryUrl = url) {
    const generation = state.generation;
    const currentRegion = regionFor(state.document);
    if (!currentRegion) return;
    // A refresh of a failed request still owes that request's history entry.
    const historyMode = requestedHistoryMode === 'none' && state.loadFailure?.url?.href === url.href
      ? state.loadFailure.historyMode
      : requestedHistoryMode;
    clearLoadFailure(state);
    state.loadFailureFocusRetry = false;
    state.region = currentRegion;
    state.response = null;
    state.requestedUrl = url;
    state.requestedHistoryMode = historyMode;
    onLoadStart?.(state, generation, url, historyMode, engine);
    state.controller = controller(state.window);
    status(currentRegion, loadingMessage, 'loading');
    currentRegion.setAttribute?.('aria-busy', 'true');

    const options = {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { Accept: 'text/html' },
    };
    if (state.controller) options.signal = state.controller.signal;

    let request;
    try {
      request = state.window.fetch(url.href, options);
    } catch (error) {
      loadError(state, generation, error, form, url, historyMode, retryUrl);
      return;
    }

    // Set once this load hands its generation to a followed continuation.
    let followed = false;
    Promise.resolve(request)
      .then((response) => {
        if (generation !== state.generation) return null;
        if (!response?.ok || typeof response.text !== 'function') {
          throw new Error(responseErrorMessage);
        }
        const continuation = followResponse?.(state, responseUrl(response, url, state.window), url, engine);
        if (continuation) {
          followed = true;
          try { response.body?.cancel?.(); } catch { /* the body is not needed */ }
          load(state, continuation, historyMode, form, retryUrl);
          return null;
        }
        state.response = response;
        return response.text();
      })
      .then((responseText) => {
        if (followed || responseText === null || generation !== state.generation) return;
        // F7-R2b: newer intent absorbed into this load (e.g. a View clicked
        // while the body was still arriving) is asked again immediately
        // before installation: the read body is then obsolete and the same
        // load (generation, history mode, Retry address) continues instead.
        const continuation = followResponse?.(state, responseUrl(state.response, url, state.window), url, engine);
        if (continuation) {
          followed = true;
          load(state, continuation, historyMode, form, retryUrl);
          return;
        }
        replaceRegion(state, responseText, url, historyMode);
      })
      .then(() => {
        if (followed || generation !== state.generation) return;
        state.controller = null;
        const region = regionFor(state.document);
        region?.removeAttribute?.('aria-busy');
        if (region) status(region, '', null);
        bindForm(state);
        onLoadComplete?.(state, generation, region, engine);
      })
      .catch((error) => {
        if (!followed) loadError(state, generation, error, form, url, historyMode, retryUrl);
      });
  }

  function schedule(state, form, delay = 0) {
    const windowObject = state.window;
    if (!capabilities(windowObject)) {
      nativeSubmit(form);
      return;
    }

    if (state.timer) windowObject.clearTimeout?.(state.timer);
    state.timer = null;
    clearLoadFailure(state);
    invalidate(state);

    const start = () => {
      state.timer = null;
      let url;
      try {
        url = urlFor(form, windowObject);
      } catch {
        nativeSubmit(form);
        return;
      }
      load(state, url, 'push', form);
    };
    if (delay > 0) state.timer = windowObject.setTimeout(start, delay);
    else start();
  }

  function handlePopstate(state) {
    const url = new URL(state.window.location.href);
    if (!isCurrentUrl(url, state)) return;
    const region = regionFor(state.document);
    if (!region) return;
    const form = formFor(region);
    if (!capabilities(state.window)) {
      navigate(state.window, url);
      return;
    }
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
    invalidate(state);
    load(state, url, 'replace', form);
  }

  function bindForm(state) {
    const region = regionFor(state.document);
    const forms = formsFor(region);
    if (forms.length === 0) return 0;
    state.region = region;
    onBindRegion?.(state, region, engine);
    state.forms ||= new Set();
    forms.forEach((form) => {
      if (state.forms.has(form)) return;
      state.forms.add(form);

      form.addEventListener?.('change', (event) => {
        if (searchSelector && event.target?.matches?.(searchSelector)) return;
        if (changeSelector && !event.target?.matches?.(changeSelector)) return;
        if (!event.target?.name && !event.target?.getAttribute?.('name')) return;
        onFormChange?.(state, form, event, engine);
        schedule(state, form);
      });
      if (searchSelector && form.querySelector?.(searchSelector)) {
        form.addEventListener?.('input', (event) => {
          if (!event.target?.matches?.(searchSelector)) return;
          schedule(state, form, debounceMs);
        });
      }
      form.addEventListener?.('submit', (event) => {
        event.preventDefault?.();
        schedule(state, form);
      });
    });

    if (linkSelector) {
      const linkRoot = linkScope === 'document' ? state.document : region;
      linkRoot.querySelectorAll?.(linkSelector).forEach((link) => {
        if (isEnhancementBound(link, 'liveRegionLinkBound')) return;
        markEnhancementBound(link, 'liveRegionLinkBound');
        link.addEventListener?.('click', (event) => {
          if (event.defaultPrevented || event.button !== 0
            || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (!capabilities(state.window)) return;
          const ownerForm = link.form || link.closest?.('form');
          const href = link.href || link.getAttribute?.('href')
            || link.getAttribute?.('formaction')
            || ownerForm?.action || ownerForm?.getAttribute?.('action');
          if (!href) return;
          event.preventDefault?.();
          let url;
          try {
            url = new URL(href, state.window.location?.href || defaultAction);
            url.hash = '';
          } catch {
            return;
          }
          if (linkDestination) {
            let destination = null;
            try {
              destination = linkDestination(state, link, url, engine);
            } catch {
              // Keep the link's own address when no newer intent is readable.
            }
            if (destination === false) return;
            url = destination || url;
          }
          if (state.timer) state.window.clearTimeout?.(state.timer);
          state.timer = null;
          invalidate(state);
          load(state, url, 'push', null);
        });
      });
    }
    state.form = forms[0];
    return forms.length;
  }

  function enhance(scope = globalThis.document) {
    const document = liveRegionDocument(scope);
    const region = regionFor(scope);
    if (!document || !region) return 0;

    let state = document[stateKey];
    if (!state) {
      const windowObject = liveRegionWindow(document);
      state = {
        document,
        window: windowObject,
        region,
        form: null,
        forms: new Set(),
        controller: null,
        timer: null,
        generation: 0,
        response: null,
        requestedUrl: null,
        requestedHistoryMode: null,
        loadFailure: null,
        loadFailureRetryButton: null,
        loadFailureFocusRetry: false,
        retryingLoadFailure: null,
        engine,
      };
      document[stateKey] = state;
      enhanceRegion(region, state);
      onCreate?.(state, region, engine);
      windowObject.addEventListener?.('popstate', () => handlePopstate(state));
      if (loadFailureMessage) {
        const relocate = (event) => {
          if (event.target?.tagName === 'DIALOG') placeLoadFailureNotice(state);
        };
        document.addEventListener?.('toggle', relocate, true);
        document.addEventListener?.('close', relocate, true);
      }
    }

    return bindForm(state);
  }

  const engine = {
    enhance,
    getRegion: regionFor,
    getForm: formFor,
    capabilities,
    url: urlFor,
    nativeSubmit,
    navigate,
    status,
    controller,
    invalidate,
    installRegion,
    load,
    // WP7: a control associated with a live form through form="…" but placed
    // outside it changes the view the same way the form's own controls do.
    schedule,
  };

  return engine;
}

function reconcileExternalFilterForm(state, parsed, formSelector) {
  const currentForm = state.document?.querySelector?.(formSelector);
  const nextForm = parsed?.querySelector?.(formSelector);
  if (!currentForm || !nextForm || currentForm === nextForm) return;

  const captured = liveRegionCaptureState(currentForm, state.document);
  const children = Array.from(nextForm.childNodes || nextForm.children || []);
  currentForm.replaceChildren?.(...children);
  enhanceDropdowns(state.document);
  liveRegionRestoreState(currentForm, state.document, captured);
  // R2: the replaced children were rendered for the installed View; the
  // restored disclosures/focus are then reconciled with the current one. Focus
  // the restore could not place (its control is now in a hidden field) moves
  // to the View control instead of falling back to the body.
  syncViewDependentFields(currentForm, liveRegionFindFocus(currentForm, captured?.focus));
}

/*
 * R2: a combined Filters & Defaults field marked
 * data-filters-visible-when-view="<view>" is shown only while the form's
 * checked radio View matches. Hidden is presentation only: the field stays in
 * the DOM, enabled, with its value, name and form association, so an explicit
 * Save keeps it and returning to that View shows the same choice. The checked
 * View radio is the one source of truth; every path that changes it calls this
 * (the radio change listener, the toolbar View sync, form reconciliation), and
 * the server renders the initial state. It never schedules a request or Save.
 * A form without a radio View (Project Assets' native select) is untouched.
 */
function syncViewDependentFields(form, restoredFocus = null) {
  const fields = Array.from(form?.querySelectorAll?.('[data-filters-visible-when-view]') || []);
  if (fields.length === 0) return;
  const radios = Array.from(form.querySelectorAll?.('input[type="radio"][name="view"]') || []);
  const checked = radios.find((input) => input.checked);
  if (!checked) return;
  const viewSummary = checked.closest?.('details')?.querySelector?.('summary');
  applyViewDependentFields(fields, checked.value, {
    container: form,
    focusTarget: viewSummary || checked,
    restoredFocus,
  });
}

/*
 * R2/R3 shared core: shows each field whose data-filters-visible-when-view
 * matches `view` and hides the others (the complete wrapper, by the hidden
 * attribute only). A hidden field keeps its control, value, name, form
 * association and enabled state. A disclosure open inside a field being hidden
 * is closed (never reopened by showing it again), and focus inside it moves
 * to `focusTarget` (the visible View control). `restoredFocus` is focus a
 * replacement could not place because its control is now in a hidden field;
 * it counts only while the focus is not already inside `container`.
 */
function applyViewDependentFields(fields, view, { container, focusTarget, restoredFocus = null }) {
  fields.forEach((field) => {
    const visible = field.getAttribute?.('data-filters-visible-when-view') === view;
    if (visible) {
      if (field.hidden) field.hidden = false;
      return;
    }
    const active = field.ownerDocument?.activeElement;
    const focusInside = Boolean(active && field.contains?.(active))
      || Boolean(restoredFocus && field.contains?.(restoredFocus) && !container?.contains?.(active));
    Array.from(field.querySelectorAll?.('details') || []).forEach((details) => {
      if (details.open !== true) return;
      details.open = false;
      details.removeAttribute?.('open');
      updateAssetViewerFilterDisclosureState(details);
    });
    if (!field.hidden) field.hidden = true;
    if (focusInside) focusTarget?.focus?.({ preventScroll: true });
  });
}

/*
 * R3: Project Assets' View is the native select #asset-view-filter (joined to
 * #asset-filters by form="…", mirrored by a CreatorCrate dropdown), and its
 * Grid style / Grid size default / List size default fields sit beside it in
 * the Filters & Defaults dialog. The select's value is the one source of
 * truth; every path that changes it calls this: its own change (dialog
 * choice), the toolbar View sync (which sends no change event) and response
 * reconciliation (which may replace the View control on its own). Hidden is
 * presentation only, so Save keeps capturing the hidden values, Reset keeps
 * restoring them and browser-local sizes are never written here. It never
 * schedules a request or a Save.
 */
function syncProjectAssetsViewDependentFields(document, restoredFocus = null) {
  const control = document?.querySelector?.('#asset-view-filter');
  if (!control) return;
  const view = control.value === 'list' ? 'list' : 'grid';
  const dialog = control.closest?.('[data-app-dialog]') || control.closest?.('dialog');
  const fields = Array.from(dialog?.querySelectorAll?.('[data-filters-visible-when-view]') || []);
  if (fields.length === 0) return;
  const dropdown = control.closest?.('fieldset')?.querySelector?.(CC_DROPDOWN_SELECTOR);
  const summary = dropdown && !dropdown.hidden ? dropdown.querySelector?.('summary') : null;
  applyViewDependentFields(fields, view, {
    container: control.closest?.('[data-project-assets-live-misc]') || dialog,
    focusTarget: summary || control,
    restoredFocus,
  });
}

// R2: a user's own View radio choice updates the dependent fields at once
// (before the debounced or immediate GET); bound once per filter form.
function bindViewDependentFields(form) {
  if (!form || isEnhancementBound(form, 'viewDependentFieldsBound')) return;
  markEnhancementBound(form, 'viewDependentFieldsBound');
  form.addEventListener?.('change', (event) => {
    const target = event.target;
    if (target?.type !== 'radio' || (target.name || target.getAttribute?.('name')) !== 'view') return;
    syncViewDependentFields(form);
  });
  syncViewDependentFields(form);
}

function enhanceCalendarLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceCalendarInfoCards(region);
  enhanceDropdowns(liveRegionDocument(region));
}

const CALENDAR_DEFAULTS_REFRESH_FAILURE = 'Defaults were saved, but Calendar could not refresh. Refresh the page to see the saved defaults.';
const CALENDAR_SCROLLER_SELECTORS = ['.calendar-scroll', '.calendar-agenda'];

function resetCalendarRefresh(state) {
  state.calendarDefaultsRefreshGeneration = null;
  state.calendarDefaultsRefreshError = null;
  state.calendarDefaultsRefreshSuccess = null;
  state.calendarDefaultsRefreshMessage = null;
  state.calendarRefreshPreservesView = false;
  state.calendarViewSnapshot = null;
}

// A refresh that keeps the active Calendar (a saved release edit) also keeps
// where the user was: page and grid scroll, and focus on the same release.
function captureCalendarView(state) {
  const region = calendarLiveEngine.getRegion(state.document);
  const active = state.document.activeElement;
  const trigger = region?.contains?.(active) ? active.closest?.('[data-calendar-info-trigger]') : null;
  return {
    focusControls: trigger?.getAttribute?.('aria-controls') || null,
    scrollX: state.window.scrollX,
    scrollY: state.window.scrollY,
    scrollers: CALENDAR_SCROLLER_SELECTORS.map((selector) => {
      const element = region?.querySelector?.(selector);
      return { selector, left: element?.scrollLeft ?? 0, top: element?.scrollTop ?? 0 };
    }),
  };
}

function restoreCalendarView(state, nextRegion, snapshot) {
  snapshot.scrollers.forEach(({ selector, left, top }) => {
    const element = nextRegion.querySelector?.(selector);
    if (!element) return;
    element.scrollLeft = left;
    element.scrollTop = top;
  });
  if (state.calendarFocusWasInRegion) {
    // The edited release keeps focus where it is still shown; otherwise the
    // month heading takes it, as after any other Calendar refresh.
    const trigger = snapshot.focusControls
      ? Array.from(nextRegion.querySelectorAll?.('[data-calendar-info-trigger]') || [])
        .find((candidate) => candidate.getAttribute?.('aria-controls') === snapshot.focusControls)
      : null;
    (trigger || nextRegion.querySelector?.('[data-calendar-month-heading]'))?.focus?.({ preventScroll: true });
  }
  state.window.scrollTo?.(snapshot.scrollX, snapshot.scrollY);
}

const calendarLiveEngine = createLiveRegionEngine({
  regionSelector: CALENDAR_LIVE_REGION_SELECTOR,
  formSelector: CALENDAR_FILTER_SELECTOR,
  formScope: 'document',
  linkSelector: '[data-calendar-navigation], [data-calendar-reset], .calendar-view-switcher a',
  linkScope: 'document',
  defaultAction: '/calendar',
  stateKey: '__creatorCrateCalendarLiveFiltering',
  historyState: { calendar: true },
  statusSelector: '[data-calendar-live-status]',
  statusStateAttribute: 'data-calendar-live-state',
  loadingMessage: 'Loading calendar.',
  fallbackMessage: 'Calendar is loading as a full page.',
  responseErrorMessage: 'Calendar response failed.',
  missingRegionMessage: 'Calendar response did not contain the live region.',
  enhanceRegion: enhanceCalendarLiveRegion,
  onCreate(state) {
    resetCalendarRefresh(state);
    state.calendarHistoryMode = null;
    state.calendarStaleNoticeClear = null;
  },
  onInvalidate(state) {
    resetCalendarRefresh(state);
  },
  onLoadStart(state, _generation, _url, historyMode) {
    state.calendarHistoryMode = historyMode;
  },
  onResponseParsed(state, parsed) {
    reconcileExternalFilterForm(state, parsed, CALENDAR_FILTER_SELECTOR);
    const resetForm = state.document.querySelector?.(CALENDAR_RESET_SELECTOR)?.closest?.('form');
    const nextResetForm = parsed.querySelector?.(CALENDAR_RESET_SELECTOR)?.closest?.('form');
    if (resetForm && nextResetForm) resetForm.setAttribute('action', nextResetForm.getAttribute('action'));
    state.calendarFocusWasInRegion = calendarLiveEngine.getRegion(state.document)
      ?.contains?.(state.document.activeElement) || false;
    if (state.calendarRefreshPreservesView) state.calendarViewSnapshot = captureCalendarView(state);
    dismissActiveGridInfoCard();
  },
  onRegionReplaced(state, nextRegion) {
    if (state.calendarViewSnapshot) restoreCalendarView(state, nextRegion, state.calendarViewSnapshot);
    else if (state.calendarFocusWasInRegion) nextRegion.querySelector?.('[data-calendar-month-heading]')?.focus?.({ preventScroll: true });
    state.calendarFocusWasInRegion = false;
  },
  onLoadComplete(state, generation) {
    // Any completed load shows current data, so a stale-data notice ends.
    const clearStaleNotice = state.calendarStaleNoticeClear;
    state.calendarStaleNoticeClear = null;
    clearStaleNotice?.();
    if (state.calendarDefaultsRefreshGeneration !== generation) return;
    const notifyRefreshed = state.calendarDefaultsRefreshSuccess;
    resetCalendarRefresh(state);
    notifyRefreshed?.();
  },
  onLoadError(state, generation) {
    if (state.calendarDefaultsRefreshGeneration !== generation) return false;
    const notifyRefreshError = state.calendarDefaultsRefreshError;
    const message = state.calendarDefaultsRefreshMessage ?? CALENDAR_DEFAULTS_REFRESH_FAILURE;
    resetCalendarRefresh(state);
    const region = calendarLiveEngine.getRegion(state.document);
    region?.removeAttribute?.('aria-busy');
    calendarLiveEngine.status(region, message, 'error');
    notifyRefreshError?.();
    return true;
  },
  isCurrentUrl(url) {
    return url.pathname === '/calendar';
  },
  loadFailureMessage(state, url, historyMode) {
    const displayedMonth = calendarLiveEngine.getRegion(state.document)?.getAttribute?.('data-calendar-month');
    const requestedMonth = url.searchParams.get('month');
    if (requestedMonth && displayedMonth && requestedMonth !== displayedMonth) {
      return "The requested month couldn't be loaded. The previously displayed month is still shown.";
    }
    return liveFilterFailureMessage('Calendar')(state, url, historyMode);
  },
});

export function enhanceCalendarLiveFiltering(scope = globalThis.document) {
  const count = calendarLiveEngine.enhance(scope);
  const document = liveRegionDocument(scope);
  if (count > 0) enhanceCalendarReleaseEditRefresh(document);
  const dialog = document?.getElementById?.(CALENDAR_MONTH_DIALOG_ID);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  const pickerForm = dialog?.querySelector?.('#calendar-month-form');
  if (!dialogState || !pickerForm || isEnhancementBound(pickerForm, 'calendarMonthPickerBound')) return count;
  markEnhancementBound(pickerForm, 'calendarMonthPickerBound');

  const yearInput = pickerForm.querySelector('#calendar-month-year');
  const dropdown = pickerForm.querySelector('#calendar-month-select');
  // Enter can also emit change and submit before the live region is replaced.
  let enterCommittedYear = false;
  dialogState.onOpen = () => {
    enterCommittedYear = false;
    // A month that failed to load stays the pending choice until it resolves.
    const shownMonth = document.__creatorCrateCalendarLiveFiltering?.loadFailure?.url?.searchParams?.get?.('month')
      || calendarLiveEngine.getRegion(document)?.getAttribute?.('data-calendar-month');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(shownMonth || '')) return;
    const [year, month] = shownMonth.split('-');
    dropdown?.querySelectorAll?.('input[type="radio"]').forEach((option) => {
      option.checked = option.value === month;
    });
    initializeCreatorCrateDropdown(dropdown);
    if (yearInput) {
      yearInput.value = year;
      yearInput.setCustomValidity?.('');
    }
  };
  yearInput?.addEventListener?.('input', () => {
    enterCommittedYear = false;
    yearInput.setCustomValidity?.('');
  });
  const applySelection = () => {
    const month = dropdown?.querySelector?.('input[type="radio"]:checked')?.value;
    const year = yearInput?.value?.trim();
    if (!/^\d{4}$/.test(year || '') || Number(year) < 1000 || Number(year) > 9999 || !yearInput.checkValidity()) {
      yearInput.setCustomValidity?.('Enter a year from 1000 to 9999.');
      yearInput.reportValidity?.();
      return;
    }
    if (!/^(0[1-9]|1[0-2])$/.test(month || '')) return;
    const selectedMonth = `${year}-${month}`;
    const region = calendarLiveEngine.getRegion(document);
    if (selectedMonth === region?.getAttribute?.('data-calendar-month')
      && !document.__creatorCrateCalendarLiveFiltering?.loadFailure) return;
    const filterForm = calendarLiveEngine.getForm(region);
    const monthField = filterForm?.querySelector?.('input[name="month"]');
    if (!monthField || !filterForm?.requestSubmit) return;
    monthField.value = selectedMonth;
    filterForm.requestSubmit();
  };
  yearInput?.addEventListener?.('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    enterCommittedYear = true;
    applySelection();
  });
  pickerForm.addEventListener('change', (event) => {
    if ((event.target === yearInput && !enterCommittedYear)
      || (event.target?.type === 'radio' && dropdown?.contains?.(event.target))) {
      applySelection();
    }
  });
  pickerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!enterCommittedYear) applySelection();
  });
  return count;
}

export function beginCalendarDefaultsLiveRefresh(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  const region = calendarLiveEngine.getRegion(document);
  if (!document || !region) return null;
  calendarLiveEngine.enhance(document);
  const state = document.__creatorCrateCalendarLiveFiltering;
  if (!state || !calendarLiveEngine.capabilities(state.window)) return null;
  if (state.calendarDefaultsRefreshGeneration !== null) calendarLiveEngine.invalidate(state);
  return state.generation;
}

// Defaults refreshes drop the status and weekStart overrides (and view when
// Desktop view changed) so the saved defaults apply. preserveFilters keeps the
// active Calendar exactly as shown instead: every query parameter, a pending
// navigation's history mode, scroll and focus.
export function refreshCalendarLiveRegion(
  scope = globalThis.document,
  _destination,
  authorityGeneration,
  {
    onError = null,
    onSuccess = null,
    failureMessage = null,
    acknowledgedControls = null,
    preserveFilters = false,
  } = {},
) {
  const document = liveRegionDocument(scope);
  const region = calendarLiveEngine.getRegion(document);
  const state = document?.__creatorCrateCalendarLiveFiltering;
  if (!region || !state || !calendarLiveEngine.capabilities(state.window)) return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  const inFlight = Boolean((state.controller || state.loadFailure) && state.requestedUrl);
  const url = inFlight
    ? new URL(state.requestedUrl.href)
    : new URL(state.window.location.href);
  if (url.pathname !== '/calendar') return 'unavailable';
  if (!preserveFilters) {
    url.searchParams.delete('status');
    url.searchParams.delete('weekStart');
    if (acknowledgedControls?.has('calendarView')) url.searchParams.delete('view');
  }
  // Taking over a pending month or filter navigation keeps its history entry.
  const historyMode = preserveFilters && inFlight ? state.calendarHistoryMode || 'replace' : 'replace';
  if (state.timer) state.window.clearTimeout?.(state.timer);
  state.timer = null;
  calendarLiveEngine.invalidate(state);
  state.calendarDefaultsRefreshGeneration = state.generation;
  state.calendarDefaultsRefreshError = typeof onError === 'function' ? onError : null;
  state.calendarDefaultsRefreshSuccess = typeof onSuccess === 'function' ? onSuccess : null;
  state.calendarDefaultsRefreshMessage = failureMessage;
  state.calendarRefreshPreservesView = preserveFilters;
  calendarLiveEngine.load(state, url, historyMode, calendarLiveEngine.getForm(region));
  return 'started';
}

const CALENDAR_EDIT_MESSAGES = Object.freeze({
  saved: 'Release updated.',
  stale: 'Release saved, but Calendar could not refresh. The calendar shown may be out of date.',
  refreshing: 'Release saved. Refreshing Calendar…',
  savedError: false,
});

// An archived release leaves the Calendar (it lists active releases only).
// A confirmed Archive reports its own message; one this page only observed
// keeps that report, never in a success tone.
function calendarArchiveMessages({ message, confirmed }) {
  if (confirmed === true) {
    return {
      saved: message || 'Release archived.',
      stale: 'Release archived, but Calendar could not refresh. The calendar shown may be out of date.',
      refreshing: 'Release archived. Refreshing Calendar…',
      savedError: false,
    };
  }
  const prefix = message ? `${message} ` : '';
  return {
    saved: message || 'Calendar refreshed.',
    stale: `${prefix}Calendar could not refresh, so it may still show this release.`,
    refreshing: `${prefix}Refreshing Calendar…`,
    savedError: Boolean(message),
  };
}

// A deleted release leaves the Calendar the same way. A confirmed Delete
// reports its own message; a release this page only found gone keeps that
// report, never in a success tone.
function calendarDeleteMessages({ message, confirmed }) {
  if (confirmed === true) {
    return {
      saved: message || 'Release deleted.',
      stale: 'Release deleted, but Calendar could not refresh. The calendar shown may be out of date.',
      refreshing: 'Release deleted. Refreshing Calendar…',
      savedError: false,
    };
  }
  const prefix = message ? `${message} ` : '';
  return {
    saved: message || 'Calendar refreshed.',
    stale: `${prefix}Calendar could not refresh, so it may still show this release.`,
    refreshing: `${prefix}Refreshing Calendar…`,
    savedError: Boolean(message),
  };
}

// Edit Release save feedback uses the page's dialog feedback notice, which
// sits outside the live region so it survives refreshes.
function setCalendarEditFeedback(document, message, error) {
  const notice = document.querySelector?.('[data-dialog-feedback]');
  const text = notice?.querySelector?.('[data-dialog-feedback-text]');
  if (!notice || !text) return null;
  notice.classList.toggle('notice--error', error);
  notice.classList.toggle('notice--success', !error);
  text.textContent = message;
  notice.hidden = false;
  return notice;
}

/**
 * Refreshes Calendar with a GET after an acknowledged Edit Release save,
 * keeping the month, view, filters, week start, scroll and focus. The save is
 * never repeated: a failed refresh reports a saved release on a possibly
 * stale Calendar and offers Retry refresh, which only refreshes again. A
 * newer refresh or navigation supersedes an older one through the live
 * engine's generation, and any later completed load clears the stale notice.
 */
function refreshCalendarAfterReleaseEdit(document, { focusResult = false, messages = CALENDAR_EDIT_MESSAGES } = {}) {
  // A stale notice from an earlier failure stays armed: this refresh, or any
  // later completed load, clears it.
  removeStatusRetry(document.__creatorCrateCalendarLiveFiltering, 'calendarEditRetryButton');
  const fail = () => {
    const current = document.__creatorCrateCalendarLiveFiltering;
    const notice = setCalendarEditFeedback(document, messages.stale, true);
    if (!current || !notice) return;
    current.calendarStaleNoticeClear = () => {
      removeStatusRetry(current, 'calendarEditRetryButton');
      setCalendarEditFeedback(document, messages.saved, messages.savedError);
    };
    const retry = showStatusRetry({
      state: current,
      status: notice,
      attribute: 'data-calendar-edit-refresh-retry',
      key: 'calendarEditRetryButton',
      onRetry: ({ wasFocused }) => {
        setCalendarEditFeedback(document, messages.refreshing, messages.savedError);
        refreshCalendarAfterReleaseEdit(document, { focusResult: wasFocused, messages });
      },
    });
    if (focusResult) retry?.focus?.();
  };
  const generation = beginCalendarDefaultsLiveRefresh(document);
  const result = generation === null ? 'unavailable' : refreshCalendarLiveRegion(document, null, generation, {
    preserveFilters: true,
    // The visible save notice reports the outcome; the region stays quiet.
    failureMessage: '',
    onError: fail,
    onSuccess: () => {
      if (!focusResult) return;
      calendarLiveEngine.getRegion(document)?.querySelector?.('[data-calendar-month-heading]')?.focus?.();
    },
  });
  if (result !== 'started') fail();
}

function enhanceCalendarReleaseEditRefresh(document) {
  const root = document?.documentElement;
  if (!root || isEnhancementBound(root, 'calendarReleaseEditRefreshBound')) return;
  markEnhancementBound(root, 'calendarReleaseEditRefreshBound');
  document.addEventListener?.(RELEASE_EDIT_SAVED_EVENT, () => refreshCalendarAfterReleaseEdit(document));
  // An archived release (release-archive.js) leaves the Calendar through the
  // same GET-only refresh, keeping the month, view and filters.
  document.addEventListener?.(RELEASE_ARCHIVED_EVENT, (event) => {
    refreshCalendarAfterReleaseEdit(document, { messages: calendarArchiveMessages(event.detail ?? {}) });
  });
  // A deleted release (release-delete.js) leaves it the same way.
  document.addEventListener?.(RELEASE_DELETED_EVENT, (event) => {
    refreshCalendarAfterReleaseEdit(document, { messages: calendarDeleteMessages(event.detail ?? {}) });
  });
}

/*
 * WP10a F1: the destination an NSFW refresh re-requests. The legacy Filter
 * form holds at most one Project, so serializing it dropped repeated
 * project= selections and broadened the list under a restricted address.
 * The refresh therefore never rebuilds from that form; it re-requests the
 * destination that owns the current intent, with the history it is owed:
 *   - an in-flight GET: its URL and its own history mode (a pending push
 *     still pushes, a pending Back/Forward still only replaces);
 *   - a failed GET: its URL; load() promotes 'none' to the recorded mode;
 *   - otherwise: the installed location, adding no history entry.
 * Repeated keys stay repeated; nothing reduces them to the scalar alias.
 */
// WP10b: a debounced Search edit not yet requested is the newest intent: the
// combined filter form (which carries every repeated Project, Status, Type
// and Tag value, hidden-by-search choices included) with the push schedule()
// would have made. A push to the address already shown only reconciles it.
function projectsNsfwRefreshTarget(state) {
  const base = state.window.location?.href;
  let target;
  if (state.timer) {
    target = {
      url: projectsLiveEngine.url(
        projectsLiveEngine.getForm(projectsLiveEngine.getRegion(state.document)),
        state.window,
      ),
      historyMode: 'push',
    };
  } else if ((state.controller || state.loadFailure) && state.requestedUrl) {
    // F8: a failed followed continuation is retried from the address its
    // Retry repeats (the default navigation), which also owns its history.
    const owner = state.controller ? state.requestedUrl : state.loadFailure.url || state.requestedUrl;
    target = {
      url: new URL(owner.href, base || owner.href),
      historyMode: state.controller ? state.requestedHistoryMode || 'none' : 'none',
    };
  } else {
    const url = new URL(base);
    url.hash = '';
    if (url.pathname !== '/projects') throw new Error('Projects location is unavailable.');
    target = { url, historyMode: 'none' };
  }
  if (target.historyMode === 'push' && base) {
    const shown = new URL(base);
    shown.hash = '';
    if (shown.href === target.url.href) target.historyMode = 'replace';
  }
  return target;
}

// WP10b F1: a toolbar Grid/List link was rendered against the installed page,
// so it does not know a filter change that is still debounced, in flight or
// failed. The clicked View is newer intent applied to the latest intended
// filter destination (the same precedence the NSFW refresh uses); an idle
// page keeps the link's own canonical address. The dialog's View control
// follows the click, so a later filter change keeps the chosen View.
//
// F8: a default navigation (Reset filters: a bare /projects) is resolved by
// the server from the saved defaults, and only its redirect tells the
// restored address; adding `view` to it would stop that resolution. A View
// click while one is in flight is therefore recorded as that navigation's
// View (the latest click wins) and the load keeps running;
// followProjectsResetView applies it to the restored address. A View click on
// a failed one re-requests it with the View, exactly like its Retry.
function projectsViewLinkDestination(state, link, url) {
  if (!link?.closest?.('nav.view-switcher')) {
    // Pagination (or any other followed link) is newer intent.
    state.projectsResetView = null;
    return url;
  }
  const view = url.searchParams.get('view') === 'list' ? 'list' : 'grid';
  const form = projectsLiveEngine.getForm(projectsLiveEngine.getRegion(state.document));
  syncProjectsViewControl(form, view);

  if (!state.timer && state.controller && isProjectsDefaultNavigationUrl(state.requestedUrl)) {
    state.projectsResetView = view;
    return false;
  }
  if (!state.timer && !state.controller && isProjectsDefaultNavigationUrl(state.loadFailure?.url)) {
    state.projectsResetView = view;
    return new URL(state.loadFailure.url.href);
  }

  let base;
  if (state.timer) {
    base = projectsLiveEngine.url(form, state.window);
  } else if ((state.controller || state.loadFailure) && state.requestedUrl) {
    base = new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href);
  } else {
    return url;
  }
  if (base.pathname !== url.pathname) return url;
  // Mirror the link's own View encoding: an omitted view is the resolved
  // default the server chose to leave implicit.
  if (url.searchParams.has('view')) base.searchParams.set('view', url.searchParams.get('view'));
  else base.searchParams.delete('view');
  base.hash = '';
  return base;
}

// Mirrors the route's isProjectsDefaultNavigation(): no list parameter at all.
const PROJECTS_LIST_QUERY_KEYS = Object.freeze(['search', 'status', 'type', 'tag', 'project', 'sort', 'order', 'view', 'page']);

// The application fallback View: the only View a canonical address omits.
const PROJECTS_FALLBACK_VIEW = 'grid';

function isProjectsDefaultNavigationUrl(url) {
  return Boolean(url && url.pathname === '/projects'
    && !PROJECTS_LIST_QUERY_KEYS.some((key) => url.searchParams.has(key)));
}

/*
 * F8: the default navigation's response arrived at the address the server
 * restored from the saved defaults. With a View chosen meanwhile, the same
 * load continues there with only `view` replaced: same generation, history
 * mode and Retry address (the default navigation itself). An omitted `view`
 * on that address is the application fallback (the server only leaves the
 * fallback implicit), so a matching choice costs no follow-up GET. The View
 * is consumed here; a failed continuation hands it back for the Retry.
 */
function followProjectsResetView(state, finalUrl, requestedUrl) {
  const view = state.projectsResetView;
  if (!view || !isProjectsDefaultNavigationUrl(requestedUrl)) return null;
  state.projectsResetView = null;
  state.projectsResetFollowed = { generation: state.generation, view };
  // Another page (a redirect away) installs nothing and fails as usual.
  if (finalUrl.origin !== requestedUrl.origin || finalUrl.pathname !== requestedUrl.pathname) return null;
  if ((finalUrl.searchParams.get('view') || PROJECTS_FALLBACK_VIEW) === view) return null;
  const destination = new URL(finalUrl.href);
  destination.searchParams.set('view', view);
  destination.hash = '';
  state.projectsResetContinuing = true;
  return destination;
}

function syncProjectsViewControl(form, view) {
  const inputs = Array.from(form?.querySelectorAll?.('input[type="radio"][name="view"]') || []);
  const target = inputs.find((input) => input.value === view);
  if (!target || target.checked) return;
  inputs.forEach((input) => { input.checked = input === target; });
  const dropdown = target.closest?.(CC_DROPDOWN_SELECTOR);
  if (dropdown) initializeCreatorCrateDropdown(dropdown);
  syncViewDependentFields(form);
}

/*
 * WP10b F4: the destination of a followed toolbar View link, the clicked View
 * being newer intent than any pending filter navigation. `pendingUrl` is the
 * latest intended filter destination, or null on an idle page (the link's
 * own canonical address is then current). The View is mirrored from the link:
 * an omitted view is the resolved default the server chose to leave implicit.
 */
function applyToolbarView(url, pendingUrl) {
  if (!pendingUrl || pendingUrl.pathname !== url.pathname) return url;
  const destination = new URL(pendingUrl.href);
  if (url.searchParams.has('view')) destination.searchParams.set('view', url.searchParams.get('view'));
  else destination.searchParams.delete('view');
  destination.hash = '';
  return destination;
}

// WP10b read-only request-lifecycle notifications for the Projects defaults
// transport (projects-filters-defaults.js), mirroring the Asset Library ones:
// 'started', 'installed', 'failed', 'superseded'. Observers cannot change the
// engine's behaviour.
function notifyProjectsLive(state, detail) {
  state.projectsObservers?.forEach((listener) => {
    try {
      listener(detail);
    } catch {
      // A transport observer must never break live filtering.
    }
  });
}

function submitProjectsNsfwToggle(state, form, event) {
  if (!projectsLiveEngine.capabilities(state.window)) return false;
  if (state.nsfwSubmitting) {
    event.preventDefault?.();
    return true;
  }

  let refresh;
  try {
    refresh = projectsNsfwRefreshTarget(state);
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
  } catch {
    return false;
  }

  event.preventDefault?.();
  projectsLiveEngine.invalidate(state);
  // Any navigation started while the POST is pending (a link, Back/Forward,
  // a filter change) advances the engine generation and owns the intent.
  const navigationGeneration = state.generation;
  state.nsfwGeneration += 1;
  const generation = state.nsfwGeneration;
  const enabled = projectLiveNsfwEnabled(form);
  const previousEnabled = projectLiveRenderedNsfwEnabled(projectsLiveEngine.getRegion(state.document));
  state.nsfwSubmitting = true;
  state.nsfwPostPending = true;
  state.nsfwNeedsRefresh = false;
  state.nsfwRegionReplaced = false;
  state.nsfwPreviousEnabled = previousEnabled;
  state.nsfwEnabled = enabled;

  const controller = projectsLiveEngine.controller(state.window);
  state.nsfwController?.abort?.();
  state.nsfwController = controller;
  let requestBody;
  try {
    requestBody = new state.window.URLSearchParams(new state.window.FormData(form));
    requestBody.set('enabled', enabled ? '1' : '0');
  } catch {
    state.nsfwSubmitting = false;
    state.nsfwPostPending = false;
    updateProjectsNsfwControls(projectsLiveEngine.getRegion(state.document), previousEnabled);
    projectsLiveEngine.nativeSubmit(form);
    return true;
  }
  updateProjectsNsfwControls(projectsLiveEngine.getRegion(state.document), enabled, true);
  const options = {
    method: String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase(),
    body: requestBody,
    credentials: 'same-origin',
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  };
  if (controller) options.signal = controller.signal;

  let request;
  try {
    request = state.window.fetch(form.action || form.getAttribute?.('action'), options);
  } catch (error) {
    request = Promise.reject(error);
  }

  let persistedNsfwEnabled = null;
  Promise.resolve(request)
    .then(async (response) => {
      if (!response?.ok) throw new Error('NSFW filter update failed.');
      const payload = typeof response.json === 'function' ? await response.json() : null;
      if (payload?.status !== 'success' || typeof payload.enabled !== 'boolean') {
        throw new Error('NSFW filter update failed.');
      }
      return payload;
    })
    .then((payload) => {
      if (generation !== state.nsfwGeneration) return;
      state.nsfwController = null;
      state.nsfwPostPending = false;
      state.nsfwEnabled = payload.enabled;
      persistedNsfwEnabled = payload.enabled;
      state.nsfwNeedsRefresh = true;
      // A newer navigation during the POST owns the destination: refresh
      // what it requested (or installed), never the older captured target.
      let target = refresh;
      if (state.generation !== navigationGeneration) {
        try {
          target = projectsNsfwRefreshTarget(state);
        } catch {
          // Keep the captured destination when no newer one is readable.
        }
      }
      projectsLiveEngine.invalidate(state);
      updateProjectsNsfwControls(projectsLiveEngine.getRegion(state.document), payload.enabled, true);
      projectsLiveEngine.load(
        state,
        target.url,
        target.historyMode,
        projectsLiveEngine.getForm(projectsLiveEngine.getRegion(state.document)),
      );
    })
    .catch((error) => {
      if (generation !== state.nsfwGeneration) return;
      state.nsfwController = null;
      state.nsfwPostPending = false;
      state.nsfwSubmitting = false;
      state.nsfwNeedsRefresh = false;
      const region = projectsLiveEngine.getRegion(state.document);
      const enabledState = persistedNsfwEnabled === null
        ? (state.nsfwRegionReplaced
          ? projectLiveRenderedNsfwEnabled(region)
          : state.nsfwPreviousEnabled)
        : persistedNsfwEnabled;
      state.nsfwEnabled = enabledState;
      state.nsfwRegionReplaced = false;
      updateProjectsNsfwControls(region, enabledState);
      region?.removeAttribute?.('aria-busy');
      projectsLiveEngine.status(region, 'Could not update the NSFW filter. The previous setting was kept.', 'error');
    });

  return true;
}

function bindProjectsNsfwForm(state, region) {
  const form = projectLiveNsfwForm(region);
  if (!form || isEnhancementBound(form, 'projectsNsfwBound')) return;
  markEnhancementBound(form, 'projectsNsfwBound');
  form.addEventListener?.('submit', (event) => submitProjectsNsfwToggle(state, form, event));
}

const projectsLiveEngine = createLiveRegionEngine({
  regionSelector: PROJECTS_LIVE_REGION_SELECTOR,
  formSelector: PROJECTS_FILTER_SELECTOR,
  formScope: 'document',
  linkSelector: 'nav.view-switcher a, .pagination a, [data-projects-reset]',
  linkScope: 'document',
  searchSelector: PROJECTS_SEARCH_SELECTOR,
  debounceMs: PROJECTS_LIVE_DEBOUNCE_MS,
  defaultAction: '/projects',
  stateKey: '__creatorCrateProjectsLiveFiltering',
  historyState: { projects: true },
  linkDestination: projectsViewLinkDestination,
  followResponse: followProjectsResetView,
  statusSelector: PROJECTS_LIVE_STATUS_SELECTOR,
  statusStateAttribute: PROJECTS_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading projects.',
  fallbackMessage: 'Projects are loading as a full page.',
  responseErrorMessage: 'Projects response failed.',
  missingRegionMessage: 'Projects response did not contain the live region.',
  enhanceRegion: enhanceProjectsLiveRegion,
  onCreate(state, region) {
    state.projectsDefaultsRefreshGeneration = null;
    state.projectsDefaultsRefreshError = null;
    state.projectsDefaultsRefreshFailureMessage = null;
    state.projectsDefaultsRefreshSuccess = null;
    state.projectsObservers = new Set();
    state.projectsLoading = false;
    state.nsfwController = null;
    state.nsfwGeneration = 0;
    state.nsfwSubmitting = false;
    state.nsfwPostPending = false;
    state.nsfwNeedsRefresh = false;
    state.nsfwRefreshGeneration = null;
    state.nsfwRegionReplaced = false;
    state.nsfwEnabled = projectLiveRenderedNsfwEnabled(region);
    // F8: the View chosen for a pending (or failed, Retry-able) default
    // navigation, the one consumed by its in-flight continuation, and whether
    // the next load start is that continuation.
    state.projectsResetView = null;
    state.projectsResetFollowed = null;
    state.projectsResetContinuing = false;
    // Back/Forward is newer intent than a pending Reset's View. (Registered
    // before the engine's own popstate handling, which starts the load.)
    state.window?.addEventListener?.('popstate', () => {
      if (state.window.location?.pathname === '/projects') state.projectsResetView = null;
    });
    enhanceDropdowns(state.document);
    enhanceAssetViewerFilterDisclosures(state.document);
  },
  onBindRegion(state, region) {
    bindProjectsNsfwForm(state, region);
    bindViewDependentFields(state.document?.querySelector?.(PROJECTS_FILTER_SELECTOR));
  },
  onInvalidate(state) {
    const supersededLoading = state.projectsLoading;
    state.projectsLoading = false;
    notifyProjectsLive(state, { phase: 'superseded', generation: state.generation, loading: supersededLoading });
    if (state.projectsDefaultsRefreshGeneration !== null) {
      state.projectsDefaultsRefreshGeneration = null;
      state.projectsDefaultsRefreshError = null;
      state.projectsDefaultsRefreshFailureMessage = null;
      state.projectsDefaultsRefreshSuccess = null;
    }
    if (state.nsfwRefreshGeneration !== null) {
      state.nsfwNeedsRefresh = true;
      state.nsfwRefreshGeneration = null;
    }
  },
  onLoadStart(state, generation, url) {
    const continuing = state.projectsResetContinuing;
    state.projectsResetContinuing = false;
    if (!continuing) {
      state.projectsResetFollowed = null;
      // Any navigation other than the default navigation (or its Retry) is
      // newer intent than its View.
      if (!isProjectsDefaultNavigationUrl(url)) state.projectsResetView = null;
    }
    state.projectsLoading = true;
    notifyProjectsLive(state, { phase: 'started', generation, url: url?.href ?? null });
    const refreshesNsfw = state.nsfwNeedsRefresh && !state.nsfwPostPending;
    if (refreshesNsfw) state.nsfwNeedsRefresh = false;
    if (refreshesNsfw) state.nsfwRefreshGeneration = generation;
  },
  onResponseParsed(state, parsed) {
    // WP10b: the combined dialog's GET form is reconciled to the installed
    // response; typed option-search text and a still-typed results Search
    // (only trimmed by the server) survive it.
    const drafts = captureFilterDialogDrafts(state.document, PROJECTS_DROPDOWN_SEARCH_SELECTOR, PROJECTS_SEARCH_SELECTOR);
    reconcileExternalFilterForm(state, parsed, PROJECTS_FILTER_SELECTOR);
    restoreFilterDialogDrafts(state.document, drafts, PROJECTS_DROPDOWN_SEARCH_SELECTOR, PROJECTS_SEARCH_SELECTOR);
  },
  onRegionReplaced(state, nextRegion) {
    if (!state.nsfwSubmitting) return;
    state.nsfwRegionReplaced = true;
    const renderedEnabled = projectLiveRenderedNsfwEnabled(nextRegion);
    state.nsfwEnabled = renderedEnabled;
    updateProjectsNsfwControls(nextRegion, renderedEnabled, true);
  },
  onLoadComplete(state, generation, region) {
    state.projectsLoading = false;
    state.projectsResetFollowed = null;
    notifyProjectsLive(state, { phase: 'installed', generation, url: state.window?.location?.href ?? null });
    if (state.projectsDefaultsRefreshGeneration === generation) {
      const notifyRefreshed = state.projectsDefaultsRefreshSuccess;
      state.projectsDefaultsRefreshGeneration = null;
      state.projectsDefaultsRefreshError = null;
      state.projectsDefaultsRefreshFailureMessage = null;
      state.projectsDefaultsRefreshSuccess = null;
      notifyRefreshed?.();
    }
    if (state.nsfwRefreshGeneration !== generation) return;
    state.nsfwRefreshGeneration = null;
    state.nsfwSubmitting = false;
    state.nsfwRegionReplaced = false;
    state.nsfwEnabled = projectLiveRenderedNsfwEnabled(region);
    updateProjectsNsfwControls(region, state.nsfwEnabled);
  },
  onLoadError(state, generation, error, form, url) {
    state.projectsLoading = false;
    // F8: a failed continuation hands its View back for the Retry of the
    // default navigation, unless a newer View click already replaced it.
    const followed = state.projectsResetFollowed;
    state.projectsResetFollowed = null;
    if (followed?.generation === generation && !state.projectsResetView) state.projectsResetView = followed.view;
    notifyProjectsLive(state, {
      phase: 'failed', generation, url: url?.href ?? null, aborted: error?.name === 'AbortError',
    });
    if (state.projectsDefaultsRefreshGeneration === generation) {
      const notifyRefreshError = state.projectsDefaultsRefreshError;
      // An empty message keeps the region quiet for callers that report the
      // outcome themselves.
      const failureMessage = state.projectsDefaultsRefreshFailureMessage
        ?? 'Defaults were saved, but Projects could not refresh. Refresh the page to see the saved defaults.';
      state.projectsDefaultsRefreshGeneration = null;
      state.projectsDefaultsRefreshError = null;
      state.projectsDefaultsRefreshFailureMessage = null;
      state.projectsDefaultsRefreshSuccess = null;
      const region = projectsLiveEngine.getRegion(state.document);
      region?.removeAttribute?.('aria-busy');
      projectsLiveEngine.status(region, failureMessage, 'error');
      notifyRefreshError?.();
      return true;
    }
    if (state.nsfwRefreshGeneration !== generation) return false;
    state.nsfwRefreshGeneration = null;
    state.nsfwNeedsRefresh = false;
    state.nsfwSubmitting = false;
    state.nsfwRegionReplaced = false;
    const region = projectsLiveEngine.getRegion(state.document);
    updateProjectsNsfwControls(region, state.nsfwEnabled);
    region?.removeAttribute?.('aria-busy');
    projectsLiveEngine.status(region, 'NSFW filter changed, but Projects could not refresh. Refresh the page to see updated previews.', 'error');
    return true;
  },
  isCurrentUrl(url) {
    return url.pathname === '/projects';
  },
  loadFailureMessage: liveFilterFailureMessage('Projects'),
});

function enhanceReleasesLiveRegion(region) {
  enhanceDropdowns(liveRegionDocument(region));
}

// The Defaults form lives outside the live region, but its action carries the
// list's asset scope; adopt the response's action so a save after Reset or
// Back/Forward cannot restore a scope the list no longer has.
function reconcileReleasesDefaultsAction(state, parsed) {
  const currentForm = state.document?.querySelector?.(RELEASES_DEFAULTS_FORM_SELECTOR);
  const action = parsed?.querySelector?.(RELEASES_DEFAULTS_FORM_SELECTOR)?.getAttribute?.('action');
  if (currentForm && action) currentForm.setAttribute?.('action', action);
}

const releasesLiveEngine = createLiveRegionEngine({
  regionSelector: RELEASES_LIVE_REGION_SELECTOR,
  formSelector: RELEASES_FILTER_SELECTOR,
  formScope: 'document',
  linkSelector: '.pagination a, [data-releases-reset]',
  linkScope: 'document',
  defaultAction: '/releases',
  stateKey: '__creatorCrateReleasesLiveFiltering',
  historyState: { releases: true },
  statusSelector: RELEASES_LIVE_STATUS_SELECTOR,
  statusStateAttribute: RELEASES_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading releases.',
  fallbackMessage: 'Releases are loading as a full page.',
  responseErrorMessage: 'Releases response failed.',
  missingRegionMessage: 'Releases response did not contain the live region.',
  enhanceRegion: enhanceReleasesLiveRegion,
  onCreate(state) {
    state.releasesDefaultsRefreshGeneration = null;
    state.releasesDefaultsRefreshError = null;
    state.releasesDefaultsRefreshFailureMessage = null;
    state.releasesDefaultsRefreshSuccess = null;
  },
  onInvalidate(state) {
    if (state.releasesDefaultsRefreshGeneration === null) return;
    state.releasesDefaultsRefreshGeneration = null;
    state.releasesDefaultsRefreshError = null;
    state.releasesDefaultsRefreshFailureMessage = null;
    state.releasesDefaultsRefreshSuccess = null;
  },
  onResponseParsed(state, parsed) {
    reconcileExternalFilterForm(state, parsed, RELEASES_FILTER_SELECTOR);
    reconcileReleasesDefaultsAction(state, parsed);
  },
  onLoadComplete(state, generation) {
    if (state.releasesDefaultsRefreshGeneration !== generation) return;
    const notifyRefreshed = state.releasesDefaultsRefreshSuccess;
    state.releasesDefaultsRefreshGeneration = null;
    state.releasesDefaultsRefreshError = null;
    state.releasesDefaultsRefreshFailureMessage = null;
    state.releasesDefaultsRefreshSuccess = null;
    notifyRefreshed?.();
  },
  onLoadError(state, generation) {
    if (state.releasesDefaultsRefreshGeneration !== generation) return false;
    const notifyRefreshError = state.releasesDefaultsRefreshError;
    // An empty message keeps the region quiet for callers that report the
    // outcome themselves.
    const failureMessage = state.releasesDefaultsRefreshFailureMessage
      ?? 'Defaults were saved, but Releases could not refresh. Refresh the page to see the saved defaults.';
    state.releasesDefaultsRefreshGeneration = null;
    state.releasesDefaultsRefreshError = null;
    state.releasesDefaultsRefreshFailureMessage = null;
    state.releasesDefaultsRefreshSuccess = null;
    const region = releasesLiveEngine.getRegion(state.document);
    region?.removeAttribute?.('aria-busy');
    releasesLiveEngine.status(region, failureMessage, 'error');
    notifyRefreshError?.();
    return true;
  },
  isCurrentUrl(url) {
    return url.pathname === '/releases' || url.pathname === '/release-management';
  },
  loadFailureMessage: liveFilterFailureMessage('Releases'),
});

function releaseAssetId(control) {
  const rawId = control?.value ?? control?.getAttribute?.('value');
  const id = String(rawId ?? '');
  return /^[1-9]\d*$/.test(id) ? id : null;
}

const notesBooksLiveEngine = createLiveRegionEngine({
  regionSelector: NOTES_BOOKS_LIVE_REGION_SELECTOR,
  formSelector: '[data-notes-books-live-form]',
  defaultAction: '/notes',
  stateKey: '__creatorCrateNotesBooksLiveRegion',
  statusSelector: NOTES_BOOKS_LIVE_STATUS_SELECTOR,
  statusStateAttribute: NOTES_BOOKS_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Refreshing books.',
  responseErrorMessage: 'Books response failed.',
  missingRegionMessage: 'Books response did not contain the live region.',
  enhanceRegion: enhancePreviewMedia,
  onCreate(state) {
    state.notesBooksRefreshComplete = null;
    state.notesBooksRefreshError = null;
  },
  onLoadComplete(state) {
    const complete = state.notesBooksRefreshComplete;
    state.notesBooksRefreshComplete = null;
    state.notesBooksRefreshError = null;
    complete?.();
  },
  onLoadError(state) {
    const error = state.notesBooksRefreshError;
    state.notesBooksRefreshComplete = null;
    state.notesBooksRefreshError = null;
    const region = notesBooksLiveEngine.getRegion(state.document);
    region?.removeAttribute?.('aria-busy');
    notesBooksLiveEngine.status(region, 'Books could not refresh.', 'error');
    error?.();
    return true;
  },
  isCurrentUrl(url) {
    return url.pathname === '/notes';
  },
});

export function refreshNotesBooksLiveRegion(
  scope = globalThis.document,
  { onComplete = null, onError = null } = {},
) {
  const document = liveRegionDocument(scope);
  const region = notesBooksLiveEngine.getRegion(document);
  if (!document || !region) return 'unavailable';

  notesBooksLiveEngine.enhance(document);
  const state = document.__creatorCrateNotesBooksLiveRegion;
  if (!state || !notesBooksLiveEngine.capabilities(state.window)) return 'unavailable';

  let url;
  try {
    url = new URL('/notes', state.window.location?.href || 'http://creatorcrate.local/notes');
  } catch {
    return 'unavailable';
  }

  state.notesBooksRefreshComplete = typeof onComplete === 'function' ? onComplete : null;
  state.notesBooksRefreshError = typeof onError === 'function' ? onError : null;
  notesBooksLiveEngine.invalidate(state);
  notesBooksLiveEngine.load(state, url, 'none', null);
  return 'started';
}

export function beginNotesBooksLiveRefresh(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  const region = notesBooksLiveEngine.getRegion(document);
  if (!document || !region) return null;

  notesBooksLiveEngine.enhance(document);
  const state = document.__creatorCrateNotesBooksLiveRegion;
  if (!state || !notesBooksLiveEngine.capabilities(state.window)) return null;
  return state.generation;
}

export function installNotesBooksLiveRegionSnapshot(
  scope = globalThis.document,
  authorityGeneration,
  nextRegion,
) {
  const document = liveRegionDocument(scope);
  const state = document?.__creatorCrateNotesBooksLiveRegion;
  if (!document || !nextRegion || !state) return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  let url;
  try {
    url = new URL('/notes', state.window.location?.href || '/notes');
  } catch {
    return 'unavailable';
  }

  try {
    notesBooksLiveEngine.invalidate(state);
    state.response = { url: url.href };
    notesBooksLiveEngine.installRegion(state, nextRegion, url, 'none');
    const region = notesBooksLiveEngine.getRegion(document);
    region?.removeAttribute?.('aria-busy');
    notesBooksLiveEngine.status(region, '', null);
    return 'installed';
  } catch {
    return 'unavailable';
  }
}

// A read restarted by a Notes save was not asked for by anything the user is
// looking at, so the Chapters they opened and the link they are on stay. A
// Chapter opened by hand stays open even if the read carries a collapsed default.
function keepBookNavigatorState(state, nextRegion) {
  const currentRegion = bookDetailLiveEngine.getRegion(state.document);
  currentRegion?.querySelectorAll?.('[data-book-nav-chapter]').forEach((item) => {
    if (item.closest('details')?.open !== true) return;
    const chapter = item.getAttribute('data-book-nav-chapter');
    const details = nextRegion.querySelector(`[data-book-nav-chapter="${chapter}"]`)?.closest('details');
    if (details) details.open = true;
  });
  const active = state.document.activeElement;
  if (!active || !currentRegion?.contains?.(active)) return;
  const href = active.getAttribute('href');
  const chapter = active.querySelector?.('[data-book-nav-chapter]')?.getAttribute('data-book-nav-chapter');
  if (href) state.bookDetailFocusSelector = `a[href="${href}"]`;
  else if (chapter) state.bookDetailFocusSelector = `summary:has([data-book-nav-chapter="${chapter}"])`;
}

const bookDetailLiveEngine = createLiveRegionEngine({
  regionSelector: BOOK_DETAIL_LIVE_REGION_SELECTOR,
  formSelector: [],
  defaultAction: '/notes',
  stateKey: '__creatorCrateBookDetailLiveRegion',
  statusSelector: BOOK_DETAIL_LIVE_STATUS_SELECTOR,
  statusStateAttribute: BOOK_DETAIL_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Refreshing Book detail.',
  responseErrorMessage: 'Book detail response failed.',
  missingRegionMessage: 'Book detail response did not contain the live region.',
  enhanceRegion(region) {
    enhancePreviewMedia(region);
    enhanceNotesCodeBlocks(region);
  },
  onCreate(state) {
    state.bookDetailRefreshWaiters = [];
    state.bookDetailKeepNavigator = false;
    state.bookDetailFocusSelector = null;
  },
  onResponseParsed(state, parsed, nextRegion) {
    if (state.bookDetailKeepNavigator) keepBookNavigatorState(state, nextRegion);
    state.bookDetailKeepNavigator = false;
  },
  onRegionReplaced(state, nextRegion) {
    const selector = state.bookDetailFocusSelector;
    state.bookDetailFocusSelector = null;
    if (selector) nextRegion.querySelector?.(selector)?.focus?.({ preventScroll: true });
  },
  onLoadComplete(state) {
    const waiters = state.bookDetailRefreshWaiters.splice(0);
    waiters.forEach(({ onComplete }) => onComplete?.());
  },
  onLoadError(state) {
    const waiters = state.bookDetailRefreshWaiters.splice(0);
    const region = bookDetailLiveEngine.getRegion(state.document);
    region?.removeAttribute?.('aria-busy');
    bookDetailLiveEngine.status(region, 'Book detail could not refresh.', 'error');
    waiters.forEach(({ onError }) => onError?.());
    return true;
  },
  isCurrentUrl(url) {
    return /^\/notes\/books\/[1-9]\d*$/.test(url.pathname);
  },
});

export function beginBookDetailDefaultsLiveRefresh(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  const region = bookDetailLiveEngine.getRegion(document);
  if (!document || !region) return null;

  bookDetailLiveEngine.enhance(document);
  const state = document.__creatorCrateBookDetailLiveRegion;
  if (!state || !bookDetailLiveEngine.capabilities(state.window)) return null;
  return state.generation;
}

export function refreshBookDetailLiveRegion(
  scope = globalThis.document,
  destination,
  authorityGeneration,
  { onComplete = null, onError = null } = {},
) {
  const document = liveRegionDocument(scope);
  const region = bookDetailLiveEngine.getRegion(document);
  const state = document?.__creatorCrateBookDetailLiveRegion;
  if (!document || !region || !state || !bookDetailLiveEngine.capabilities(state.window)) return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  let url;
  try {
    url = new URL(destination, state.window.location?.href || '/notes');
  } catch {
    return 'unavailable';
  }
  if (!/^\/notes\/books\/[1-9]\d*$/.test(url.pathname)) return 'unavailable';

  url.search = '';
  url.hash = '';
  bookDetailLiveEngine.invalidate(state);
  state.bookDetailRefreshWaiters.push({
    onComplete: typeof onComplete === 'function' ? onComplete : null,
    onError: typeof onError === 'function' ? onError : null,
  });
  bookDetailLiveEngine.load(state, url, 'none', null);
  return 'started';
}

// A Notes save has just written to this Book, so anything read before it is out
// of date. Moving the generation rejects those reads, and one still loading starts
// again, keeping its waiters, so a Book Defaults refresh arrives with both changes.
export function supersedeBookDetailLiveRefresh(scope = globalThis.document) {
  const state = liveRegionDocument(scope)?.__creatorCrateBookDetailLiveRegion;
  if (!state) return;
  const url = state.controller ? state.requestedUrl : null;
  bookDetailLiveEngine.invalidate(state);
  if (!url) return;
  state.bookDetailKeepNavigator = true;
  bookDetailLiveEngine.load(state, url, 'none', null);
}

export function installBookDetailLiveRegionSnapshot(
  scope = globalThis.document,
  destination,
  authorityGeneration,
  nextRegion,
) {
  const document = liveRegionDocument(scope);
  const state = document?.__creatorCrateBookDetailLiveRegion;
  if (!document || !nextRegion || !state) return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  let url;
  try {
    url = new URL(destination, state.window.location?.href || '/notes');
  } catch {
    return 'unavailable';
  }
  if (!/^\/notes\/books\/[1-9]\d*$/.test(url.pathname)) return 'unavailable';

  url.search = '';
  url.hash = '';
  try {
    bookDetailLiveEngine.invalidate(state);
    state.response = { url: url.href };
    bookDetailLiveEngine.installRegion(state, nextRegion, url, 'none');
    return 'installed';
  } catch {
    return 'unavailable';
  }
}

export function publishBookDetailLiveRegionSnapshotAtomically(
  scope = globalThis.document,
  destination,
  authorityGeneration,
  nextRegion,
  publishPeer,
) {
  const document = liveRegionDocument(scope);
  const state = document?.__creatorCrateBookDetailLiveRegion;
  const currentRegion = bookDetailLiveEngine.getRegion(document);
  if (!document || !nextRegion || !state || !currentRegion || !currentRegion.parentNode
    || typeof publishPeer !== 'function') return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  let url;
  try {
    url = new URL(destination, state.window.location?.href || '/notes');
  } catch {
    return 'unavailable';
  }
  if (!/^\/notes\/books\/[1-9]\d*$/.test(url.pathname)) return 'unavailable';

  url.search = '';
  url.hash = '';
  const previousResponse = state.response;
  try {
    bookDetailLiveEngine.invalidate(state);
    state.response = { url: url.href };
    bookDetailLiveEngine.installRegion(state, nextRegion, url, 'none');
    if (publishPeer() !== true) throw new Error('Peer publication failed.');
    return 'installed';
  } catch {
    const publishedRegion = bookDetailLiveEngine.getRegion(document);
    if (publishedRegion !== currentRegion && publishedRegion?.parentNode) {
      if (typeof publishedRegion.replaceWith === 'function') publishedRegion.replaceWith(currentRegion);
      else publishedRegion.parentNode.replaceChild(currentRegion, publishedRegion);
    }
    state.region = currentRegion;
    state.response = previousResponse;
    return 'unavailable';
  }
}

function releaseAssetsSelectionControls(region, form) {
  const checkboxes = Array.from(region?.querySelectorAll?.(RELEASE_ASSETS_SELECTION_CHECKBOX_SELECTOR) || []);
  const hidden = Array.from(
    form?.querySelector?.(RELEASE_ASSETS_HIDDEN_MEMBERSHIP_SELECTOR)?.querySelectorAll?.(
      'input[type="hidden"][name="selectedAssetIds"]',
    ) || [],
  );
  return { checkboxes, hidden };
}

function releaseAssetsRenderedMembership(region, form) {
  const { checkboxes, hidden } = releaseAssetsSelectionControls(region, form);
  return new Set([
    ...hidden.map(releaseAssetId).filter(Boolean),
    ...checkboxes.filter((checkbox) => checkbox.checked).map(releaseAssetId).filter(Boolean),
  ]);
}

function releaseAssetsPersistedMembership(form) {
  const container = form?.querySelector?.(RELEASE_ASSETS_PERSISTED_MEMBERSHIP_SELECTOR);
  if (!container) return null;
  return new Set(Array.from(container.querySelectorAll?.('[data-release-assets-persisted-id]') || [])
    .map(releaseAssetId)
    .filter(Boolean));
}

function releaseAssetsMembershipOverrides(authoritativeSelected, renderedSelected) {
  const overrides = new Map();
  const assetIds = new Set([...authoritativeSelected, ...renderedSelected]);
  assetIds.forEach((assetId) => {
    const authoritative = authoritativeSelected.has(assetId);
    const rendered = renderedSelected.has(assetId);
    if (authoritative !== rendered) overrides.set(assetId, rendered);
  });
  return overrides;
}

function releaseAssetsResultingMembership(selectionState) {
  const selected = new Set(selectionState.authoritativeSelected);
  selectionState.overrides.forEach((checked, assetId) => {
    if (checked) selected.add(assetId);
    else selected.delete(assetId);
  });
  return selected;
}

// List information cards render the server's membership. Rewrite each from
// the draft: a pending change is marked unsaved, stored Role/Order are hidden
// for an unsaved addition (they belong to no saved membership) and relabelled
// as saved values while a saved selection is pending removal.
function syncReleaseAssetsMembershipInfo(region, selectionState) {
  const selected = releaseAssetsResultingMembership(selectionState);
  region.querySelectorAll?.('[data-release-asset-membership-info]')?.forEach?.((info) => {
    const assetId = String(info.getAttribute?.('data-release-asset-id') ?? '');
    const status = info.querySelector?.('[data-release-asset-membership-status]');
    if (!/^[1-9]\d*$/.test(assetId) || !status) return;
    const draftSelected = selected.has(assetId);
    const savedSelected = selectionState.authoritativeSelected.has(assetId);
    const pending = draftSelected !== savedSelected;
    status.textContent = `${draftSelected ? 'Selected' : 'Not selected'}${pending ? ' (unsaved)' : ''}`;
    info.parentElement?.querySelectorAll?.('[data-release-asset-stored-fact]')?.forEach?.((fact) => {
      fact.hidden = !savedSelected;
      const label = fact.querySelector?.('[data-release-asset-stored-fact-label]');
      const name = label?.getAttribute?.('data-release-asset-stored-fact-label');
      if (label && name) label.textContent = pending ? `Saved ${name.toLowerCase()}` : name;
    });
  });
}

function reconcileReleaseAssetsSelection(state, region = releaseAssetsLiveEngine.getRegion(state.document)) {
  const selectionState = state.releaseAssetsSelection;
  if (!selectionState) return;
  const form = state.document?.querySelector?.(RELEASE_ASSETS_SELECTION_FORM_SELECTOR);
  const hiddenContainer = form?.querySelector?.(RELEASE_ASSETS_HIDDEN_MEMBERSHIP_SELECTOR);
  if (!form || !hiddenContainer || !region) return;

  const checkboxes = Array.from(region.querySelectorAll?.(RELEASE_ASSETS_SELECTION_CHECKBOX_SELECTOR) || []);
  checkboxes.forEach((checkbox) => {
    const assetId = releaseAssetId(checkbox);
    if (assetId && selectionState.overrides.has(assetId)) {
      checkbox.checked = selectionState.overrides.get(assetId);
    }
  });

  const visibleIds = new Set(checkboxes.map(releaseAssetId).filter(Boolean));
  const hiddenInputs = Array.from(releaseAssetsResultingMembership(selectionState))
    .filter((assetId) => !visibleIds.has(assetId))
    .map((assetId) => {
      const input = state.document.createElement('input');
      input.setAttribute('type', 'hidden');
      input.setAttribute('name', 'selectedAssetIds');
      input.value = assetId;
      return input;
    });
  hiddenContainer.replaceChildren(...hiddenInputs);
  syncReleaseAssetsMembershipInfo(region, selectionState);
  // B7-F2: a selected draft member keeps a Role editor on recovery pages.
  restoreReleaseAssetsDraftRoleControls(state, region);

  // Keep the reviewed checkbox/card path responsible for styling, aria state,
  // and idempotent interaction binding after every replacement.
  enhanceAssetSelection(state.document);
}

function recordReleaseAssetsDraftMembership(state, checkbox) {
  const selectionState = state.releaseAssetsSelection;
  const assetId = releaseAssetId(checkbox);
  if (!selectionState || !assetId) return;
  const authoritative = selectionState.authoritativeSelected.has(assetId);
  if (checkbox.checked === authoritative) selectionState.overrides.delete(assetId);
  else selectionState.overrides.set(assetId, checkbox.checked);
  reconcileReleaseAssetsSelection(state);
}

function bindReleaseAssetsDraftMembership(state) {
  const form = state.document?.querySelector?.(RELEASE_ASSETS_SELECTION_FORM_SELECTOR);
  const region = releaseAssetsLiveEngine.getRegion(state.document);
  if (!form || !region) return;

  const renderedSelected = releaseAssetsRenderedMembership(region, form);
  const authoritativeSelected = releaseAssetsPersistedMembership(form) || renderedSelected;
  state.releaseAssetsSelection = {
    authoritativeSelected,
    overrides: releaseAssetsMembershipOverrides(authoritativeSelected, renderedSelected),
  };

  const recordFromEvent = (event) => {
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    const checkbox = event.target?.matches?.(RELEASE_ASSETS_SELECTION_CHECKBOX_SELECTOR)
      ? event.target
      : event.target?.closest?.('[data-asset-selectable-card]')?.querySelector?.(
        RELEASE_ASSETS_SELECTION_CHECKBOX_SELECTOR,
      );
    if (checkbox) recordReleaseAssetsDraftMembership(state, checkbox);
  };
  state.document.addEventListener?.('change', recordFromEvent);
  state.document.addEventListener?.('click', recordFromEvent);
  state.document.addEventListener?.('keydown', recordFromEvent);
  reconcileReleaseAssetsSelection(state, region);
}

function updateReleaseAssetsAuthoritativeMembership(state, parsed, nextRegion) {
  if (!state.releaseAssetsSelection) return;
  const nextForm = parsed?.querySelector?.(RELEASE_ASSETS_SELECTION_FORM_SELECTOR);
  if (!nextForm || !nextRegion) return;
  state.releaseAssetsSelection.authoritativeSelected = releaseAssetsPersistedMembership(nextForm)
    || releaseAssetsRenderedMembership(nextRegion, nextForm);
  state.releaseAssetsSelection.pendingFormAction = nextForm.getAttribute?.('action') || null;
}

// The Save form lives outside the replaced region, so only its action follows
// the installed response's normalized filter context; the node and its hidden
// membership inputs are kept. Applied once the region is installed so a failed
// install never leaves the form pointing at results that were not shown.
function syncReleaseAssetsSelectionFormAction(state) {
  const selectionState = state.releaseAssetsSelection;
  const action = selectionState?.pendingFormAction;
  if (!selectionState || !action) return;
  selectionState.pendingFormAction = null;
  state.document?.querySelector?.(RELEASE_ASSETS_SELECTION_FORM_SELECTOR)?.setAttribute?.('action', action);
}

/*
 * B7-F1: only a recoverable rejected legacy Save renders the Save form's
 * compact `roleOrder` carrier (a JSON array of [assetId, role, sortOrder]).
 * The Save form lives outside the replaced region, so the carrier marks
 * recovery mode for the page's lifetime. There a Role control edits the
 * matching carrier entry in place (asset ID and order kept, every other entry
 * untouched) and never posts a role update: the choice is persisted only by
 * Save. A saved member's per-asset autosubmit role form arriving in an
 * installed GET response is turned into the same draft control before the
 * shared autosubmit binding runs, and every Role control shows the carried
 * role, so a correction never reverts on navigation. A carried role that is
 * not one of the control's own options stays visibly invalid until a valid
 * option is chosen. Normal pages have no carrier and keep their role forms.
 */
const RELEASE_ASSETS_ROLE_ORDER_SELECTOR = '[data-release-assets-submitted-role-order] input[type="hidden"][name="roleOrder"]';
const RELEASE_ASSETS_ROLE_SELECT_SELECTOR = '.release-asset-role-form select[name="role"]';
const RELEASE_ASSETS_DRAFT_ROLE_SELECT_ATTRIBUTE = 'data-release-asset-draft-role-select';
const RELEASE_ASSETS_INVALID_ROLE_SUMMARY = 'Select a valid role';

function releaseAssetsRoleOrderInput(document) {
  return document?.querySelector?.(RELEASE_ASSETS_SELECTION_FORM_SELECTOR)
    ?.querySelector?.(RELEASE_ASSETS_ROLE_ORDER_SELECTOR) || null;
}

// The carrier exactly as rendered, or null when it is not a list of triples
// (left untouched: the server refuses a malformed carrier).
function readReleaseAssetsRoleOrder(input) {
  let entries;
  try {
    entries = JSON.parse(String(input?.value ?? ''));
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  return entries.every((entry) => Array.isArray(entry) && entry.length === 3) ? entries : null;
}

function releaseAssetsRoleSelectAssetId(select) {
  const id = String(select?.getAttribute?.(RELEASE_ASSETS_DRAFT_ROLE_SELECT_ATTRIBUTE)
    ?? /^role-(\d+)$/.exec(String(select?.id ?? select?.getAttribute?.('id') ?? ''))?.[1]
    ?? '');
  return /^[1-9]\d*$/.test(id) ? id : null;
}

// The established roles are the control's own server-rendered options.
function releaseAssetsRoleChoices(select) {
  return Array.from(select?.querySelectorAll?.('option') || [])
    .map((option) => String(option.getAttribute?.('value') ?? option.value ?? ''))
    .filter((value) => value !== '');
}

function showReleaseAssetsDraftRole(select, role) {
  const valid = releaseAssetsRoleChoices(select).includes(role);
  if (valid) {
    select.value = role;
    select.removeAttribute?.('aria-invalid');
  } else {
    select.value = '';
    if (select.value !== '' && 'selectedIndex' in select) select.selectedIndex = -1;
    select.setAttribute?.('aria-invalid', 'true');
  }
  select.closest?.('.release-asset-role-field')?.classList?.toggle?.('field-error', !valid);
  syncCreatorCrateDropdownFromNative(select);
  if (valid) return;
  // No option is chosen, so the shared summary keeps its last label; show the
  // correction prompt instead of a role the draft does not hold.
  const dropdown = select.closest?.('.release-asset-role-field')?.querySelector?.(CC_DROPDOWN_SELECTOR);
  const current = dropdown?.querySelector?.('[data-cc-dropdown-summary-current]');
  const summary = dropdown?.querySelector?.('summary');
  if (current) current.textContent = RELEASE_ASSETS_INVALID_ROLE_SUMMARY;
  if (summary) {
    summary.setAttribute?.('title', RELEASE_ASSETS_INVALID_ROLE_SUMMARY);
    const label = String(summary.getAttribute?.('aria-label') ?? '');
    const separator = label.indexOf(':');
    if (separator >= 0) {
      summary.setAttribute?.('aria-label', `${label.slice(0, separator + 1)} ${RELEASE_ASSETS_INVALID_ROLE_SUMMARY}`);
    }
  }
}

// Runs for every enhanced region, before enhanceAutoSubmit binds it.
function syncReleaseAssetsDraftRoleControls(region) {
  const input = releaseAssetsRoleOrderInput(liveRegionDocument(region));
  if (!input) return;
  const entries = readReleaseAssetsRoleOrder(input);
  region?.querySelectorAll?.(RELEASE_ASSETS_ROLE_SELECT_SELECTOR)?.forEach?.((select) => {
    const assetId = releaseAssetsRoleSelectAssetId(select);
    select.removeAttribute?.('data-autosubmit');
    select.closest?.('.release-asset-role-form')?.setAttribute?.('data-release-asset-draft-role', '');
    if (assetId) select.setAttribute?.(RELEASE_ASSETS_DRAFT_ROLE_SELECT_ATTRIBUTE, assetId);
    const entry = assetId && entries ? entries.find(([entryId]) => String(entryId) === assetId) : null;
    if (!entry) {
      // Not in the carried draft (e.g. a saved member the draft removes): its
      // role is not part of this Save, so it cannot be edited here.
      select.disabled = true;
      syncCreatorCrateDropdownFromNative(select);
      return;
    }
    showReleaseAssetsDraftRole(select, String(entry[1]));
  });
}

function recordReleaseAssetsDraftRole(state, select) {
  const input = releaseAssetsRoleOrderInput(state.document);
  const entries = readReleaseAssetsRoleOrder(input);
  const assetId = releaseAssetsRoleSelectAssetId(select);
  if (!entries || !assetId) return;
  const owned = entries.filter(([entryId]) => String(entryId) === assetId);
  if (owned.length === 0) return;
  const role = String(select.value ?? '');
  if (releaseAssetsRoleChoices(select).includes(role)) {
    owned.forEach((entry) => { entry[1] = role; });
    input.value = JSON.stringify(entries);
  }
  // Choosing the correction prompt itself keeps the carried role.
  showReleaseAssetsDraftRole(select, String(owned[0][1]));
}

/*
 * B7-F2: a live GET renders Role controls only for saved members, so a
 * selected draft member that is not saved yet (it is in the carrier because
 * the rejected Save submitted it) arrives with no editor. Every visible card
 * whose draft checkbox is selected and whose asset has a carrier entry gets a
 * recovery Role control cloned from the page's inert template (the server's
 * own draft control markup, with the asset ID and filename substituted into
 * attributes and text, never parsed as markup), placed where the server
 * renders Role for the Grid or List card, and showing the carried role. A
 * control created here is removed again when its asset is deselected (the
 * carrier entry is kept, so reselecting restores it) and is never created
 * twice. It has no form and no autosubmit: the delegated draft change handler
 * edits the carrier entry only. Normal, read-only and fail-closed pages render
 * no carrier or template, so nothing happens there.
 */
const RELEASE_ASSETS_DRAFT_ROLE_RESTORED_ATTRIBUTE = 'data-release-asset-draft-role-restored';
const RELEASE_ASSETS_DRAFT_ROLE_TEMPLATE_TOKEN = /cc-draft-role-asset-(?:id|filename)/g;
const RELEASE_ASSETS_DRAFT_ROLE_TEMPLATE_ID_TOKEN = 'cc-draft-role-asset-id';

function releaseAssetsDraftRoleTemplate(form) {
  return form?.querySelector?.('template[data-release-asset-draft-role-template]') || null;
}

// The template is rendered on its correction prompt. For a valid carried role
// the prompt is dropped (native option, radio row and width sizer), matching
// the server's markup for a valid draft role.
function dropReleaseAssetsDraftRolePrompt(control, select) {
  Array.from(select.querySelectorAll?.('option') || [])
    .filter((option) => String(option.getAttribute?.('value') ?? option.value ?? '') === '')
    .forEach((option) => option.remove?.());
  control.querySelectorAll?.('input[type="radio"][value=""]')?.forEach?.((radio) => {
    (radio.closest?.('.asset-filter-multiselect-option') || radio).remove?.();
  });
  control.querySelectorAll?.('.asset-filter-multiselect-summary-width > span')?.forEach?.((span) => {
    if (span.textContent === RELEASE_ASSETS_INVALID_ROLE_SUMMARY) span.remove?.();
  });
}

function instantiateReleaseAssetsDraftRoleControl(template, assetId, filename) {
  const control = template?.content?.cloneNode?.(true)?.querySelector?.('.release-asset-role-form');
  if (!control) return null;
  const substitute = (text) => String(text).replace(
    RELEASE_ASSETS_DRAFT_ROLE_TEMPLATE_TOKEN,
    (token) => (token === RELEASE_ASSETS_DRAFT_ROLE_TEMPLATE_ID_TOKEN ? assetId : filename),
  );
  [control, ...Array.from(control.querySelectorAll?.('*') || [])].forEach((element) => {
    (element.getAttributeNames?.() || []).forEach((name) => {
      const value = element.getAttribute?.(name);
      if (typeof value === 'string' && value.includes('cc-draft-role-asset-')) element.setAttribute(name, substitute(value));
    });
  });
  control.querySelectorAll?.('legend')?.forEach?.((legend) => {
    legend.textContent = substitute(legend.textContent ?? '');
  });
  const select = control.querySelector?.(`select[${RELEASE_ASSETS_DRAFT_ROLE_SELECT_ATTRIBUTE}]`);
  return select && releaseAssetsRoleSelectAssetId(select) === assetId ? { control, select } : null;
}

function createReleaseAssetsDraftRoleControl(form, assetId, filename, role) {
  const created = instantiateReleaseAssetsDraftRoleControl(releaseAssetsDraftRoleTemplate(form), assetId, filename);
  if (created && releaseAssetsRoleChoices(created.select).includes(role)) {
    dropReleaseAssetsDraftRolePrompt(created.control, created.select);
  }
  return created;
}

// Grid: the card's top action row, before the details link (as releaseGridRole).
// List: the Role column's value, in place of the unselected dash.
function placeReleaseAssetsDraftRoleControl(document, card, control) {
  const listCell = card.querySelector?.('.asset-list-cell--role dd');
  if (listCell) {
    control.setAttribute(RELEASE_ASSETS_DRAFT_ROLE_RESTORED_ATTRIBUTE, '');
    listCell.replaceChildren(control);
    return true;
  }
  const top = card.querySelector?.('.asset-card-top');
  if (!top) return false;
  const wrapper = document.createElement('div');
  wrapper.setAttribute('class', 'release-asset-grid-role');
  wrapper.setAttribute(RELEASE_ASSETS_DRAFT_ROLE_RESTORED_ATTRIBUTE, '');
  const label = document.createElement('span');
  label.setAttribute('class', 'release-asset-grid-role-label');
  label.textContent = 'Role';
  wrapper.appendChild(label);
  wrapper.appendChild(control);
  const details = Array.from(top.children || []).find((child) => child.matches?.('.asset-details-link'));
  if (details) top.insertBefore(wrapper, details);
  else top.appendChild(wrapper);
  return true;
}

function removeReleaseAssetsDraftRoleControls(document, card) {
  card.querySelectorAll?.(`[${RELEASE_ASSETS_DRAFT_ROLE_RESTORED_ATTRIBUTE}]`)?.forEach?.((node) => {
    const listCell = node.parentNode;
    if (node.matches?.('.release-asset-role-form') && listCell?.matches?.('.asset-list-cell--role dd')) {
      const dash = document.createElement('span');
      dash.setAttribute('class', 'dashboard-muted');
      dash.textContent = '—';
      listCell.replaceChildren(dash);
    } else {
      node.remove?.();
    }
  });
}

function restoreReleaseAssetsDraftRoleControls(state, region) {
  const document = state.document;
  const form = document?.querySelector?.(RELEASE_ASSETS_SELECTION_FORM_SELECTOR);
  const input = releaseAssetsRoleOrderInput(document);
  if (!form || !input || !region) return;
  const entries = readReleaseAssetsRoleOrder(input);
  const restored = [];
  region.querySelectorAll?.(RELEASE_ASSETS_SELECTION_CHECKBOX_SELECTOR)?.forEach?.((checkbox) => {
    const assetId = releaseAssetId(checkbox);
    const card = checkbox.closest?.('[data-asset-id]');
    if (!assetId || !card || String(card.getAttribute?.('data-asset-id') ?? '') !== assetId) return;
    const entry = entries ? entries.find(([entryId]) => String(entryId) === assetId) : null;
    if (!checkbox.checked || !entry) {
      removeReleaseAssetsDraftRoleControls(document, card);
      return;
    }
    // A server-rendered (converted) control or one restored earlier stays.
    if (card.querySelector?.(RELEASE_ASSETS_ROLE_SELECT_SELECTOR)) return;
    const role = String(entry[1]);
    const filename = String(checkbox.getAttribute?.('data-release-asset-filename') ?? '') || `asset ${assetId}`;
    const created = createReleaseAssetsDraftRoleControl(form, assetId, filename, role);
    if (!created || !placeReleaseAssetsDraftRoleControl(document, card, created.control)) return;
    restored.push([created.select, role]);
  });
  if (restored.length === 0) return;
  enhanceAssetViewerFilterDisclosures(document);
  enhanceDropdowns(document);
  restored.forEach(([select, role]) => showReleaseAssetsDraftRole(select, role));
}

function bindReleaseAssetsDraftRoles(state) {
  if (!releaseAssetsRoleOrderInput(state.document)) return;
  state.document.addEventListener?.('change', (event) => {
    const select = event.target;
    if (select?.matches?.(`select[${RELEASE_ASSETS_DRAFT_ROLE_SELECT_ATTRIBUTE}]`)) {
      recordReleaseAssetsDraftRole(state, select);
    }
  });
}

/*
 * WP16: Manage Assets has two entry points to ONE page size — the Filter
 * dialog's Page size and the Assets per page control beside pagination. The
 * installed response stays the authority for both (the dialog form is
 * reconciled from it and the pagination control is inside the region), so
 * between installs a page-size choice is recorded as the latest intent:
 *   - the other control mirrors it at once, so a following filter change, a
 *     failed GET or a reopened dialog never resubmits the older size;
 *   - a pagination-control submission carries the dialog's current filter
 *     intent (a debounced Search or failed filter is not dropped), with its
 *     own size;
 *   - a live link (pagination, Grid/List, Clear) followed before the size
 *     installed carries the intended size instead of the rendered one.
 * Only a successful install clears the intent; R5: any newer GET's own size
 * replaces it when that GET starts (syncReleaseAssetsRequestedPageSize).
 * Nothing here touches the
 * membership draft or sends anything but a GET.
 */
const RELEASE_ASSETS_PAGE_SIZE_CONTROL_SELECTOR = 'select[name="pageSize"][data-release-assets-live-page-size]';

function recordReleaseAssetsPageSizeIntent(state, source) {
  if (!source?.matches?.(RELEASE_ASSETS_PAGE_SIZE_CONTROL_SELECTOR)) return;
  const value = String(source.value ?? '');
  if (value === '') return;
  state.releaseAssetsPageSizeIntent = value;
  Array.from(state.document?.querySelectorAll?.(RELEASE_ASSETS_PAGE_SIZE_CONTROL_SELECTOR) || [])
    .forEach((control) => {
      if (control === source || control.value === value) return;
      control.value = value;
      syncCreatorCrateDropdownFromNative(control);
    });
}

function releaseAssetsPageSizeFormParams(params, form) {
  if (!form?.matches?.(RELEASE_ASSETS_PAGE_SIZE_FORM_SELECTOR)) return;
  const document = form.ownerDocument;
  const filter = document?.querySelector?.(RELEASE_ASSETS_LIVE_FILTER_SELECTOR);
  const windowObject = liveRegionWindow(document);
  if (!filter || typeof windowObject?.FormData !== 'function') return;
  const intent = new windowObject.URLSearchParams(new windowObject.FormData(filter));
  // The form's own canonical order and View are kept; only the filter values
  // follow the dialog, so nothing changes while no filter intent is pending.
  const rendered = new windowObject.URLSearchParams(params.toString());
  Array.from(new Set(params.keys())).forEach((key) => params.delete(key));
  const keep = (key, value) => {
    if (value !== null && value !== '') params.set(key, value);
  };
  keep('pageSize', rendered.get('pageSize'));
  ['search', 'extension', 'category'].forEach((key) => {
    keep(key, intent.has(key) ? intent.get(key) : rendered.get(key));
  });
  const selection = intent.has('selection') ? intent.get('selection') : rendered.get('selection');
  // 'selected' (saved membership) is the default Selection and stays implicit.
  if (selection === 'all') params.set('selection', 'all');
  // R3: View follows the dialog's hidden View (synced to every requested
  // GET), so a pending Grid/List choice is not reverted; Grid stays implicit
  // as in the rendered form.
  const view = intent.has('view') ? intent.get('view') : rendered.get('view');
  if (view === 'list') params.set('view', 'list');
  rendered.forEach((value, key) => {
    if (!['pageSize', 'search', 'extension', 'category', 'selection', 'view'].includes(key)) {
      params.append(key, value);
    }
  });
}

/*
 * R3: Grid/List, pagination and Clear links are rendered against the
 * installed response, so they know nothing of a filter or page-size change
 * that is still debounced, in flight or failed. The latest intended
 * destination is read from the engine's own load state, in R1's precedence:
 *   - a debounced Search not yet requested: the Filter dialog form;
 *   - an in-flight or failed GET: the URL it requested (or its Retry URL);
 *   - otherwise (idle): the link's own canonical address.
 * Only the clicked dimension then overrides that intent:
 *   - Grid/List: `view` (Grid stays implicit) and, as rendered View links
 *     already do, page one;
 *   - pagination: `page` (page one stays implicit);
 *   - Clear keeps its explicit filter reset from the link and takes only the
 *     intended View and page size, so it never resurrects a pending filter.
 * The membership draft lives outside the URL and is never touched here.
 */
function releaseAssetsIntendedUrl(state) {
  if (state.timer) {
    const form = releaseAssetsLiveEngine.getForm(releaseAssetsLiveEngine.getRegion(state.document));
    return form ? releaseAssetsLiveEngine.url(form, state.window) : null;
  }
  if (state.controller && state.requestedUrl) return state.requestedUrl;
  if (state.loadFailure) return state.loadFailure.url || state.requestedUrl || null;
  return null;
}

function releaseAssetsCopyParam(destination, source, key) {
  const value = source.searchParams.get(key);
  destination.searchParams.delete(key);
  if (value !== null && value !== '') destination.searchParams.set(key, value);
}

/*
 * R8: Clear replaces Search, Selection, Extension and Category at once, so
 * the address it requests is marked here (the engine starts the load
 * synchronously after this hook) and onLoadStart then brings the dialog's
 * filter controls to that destination before it installs, as R5 does for
 * Back/Forward. A filter edited while Clear is held or failed then changes
 * only its own dimension instead of reserializing the cleared restrictions.
 */
function releaseAssetsLinkDestination(state, link, url) {
  const clear = Boolean(link?.matches?.('[data-release-assets-reset]'));
  // The link's own address stands if no newer intent is readable.
  state.releaseAssetsClearHref = clear ? url.href : null;
  const destination = releaseAssetsIntendedLinkDestination(state, link, url);
  if (clear) state.releaseAssetsClearHref = destination.href;
  return destination;
}

function releaseAssetsIntendedLinkDestination(state, link, url) {
  let destination = url;
  const base = releaseAssetsIntendedUrl(state);
  const intended = base ? new URL(base.href, state.window.location?.href || base.href) : null;
  if (intended && intended.pathname === url.pathname) {
    if (link?.matches?.('[data-release-assets-reset]')) {
      destination = new URL(url.href);
      releaseAssetsCopyParam(destination, intended, 'view');
      releaseAssetsCopyParam(destination, intended, 'pageSize');
    } else if (link?.closest?.('nav.view-switcher')) {
      destination = intended;
      destination.searchParams.delete('page');
      releaseAssetsCopyParam(destination, url, 'view');
    } else if (link?.closest?.('.pagination')) {
      destination = intended;
      releaseAssetsCopyParam(destination, url, 'page');
    }
    destination.hash = '';
    // 25 is the service fallback and stays implicit, as in rendered links.
    if (destination !== url && destination.searchParams.get('pageSize') === '25') {
      destination.searchParams.delete('pageSize');
    }
  }

  const intendedSize = state.releaseAssetsPageSizeIntent;
  if (!intendedSize || (destination.searchParams.get('pageSize') || '25') === intendedSize) return destination;
  if (destination === url) destination = new URL(url.href);
  // 25 is the service fallback and stays implicit, as in rendered links.
  if (intendedSize === '25') destination.searchParams.delete('pageSize');
  else destination.searchParams.set('pageSize', intendedSize);
  return destination;
}

// R3: the Filter dialog's hidden View follows every requested GET (a View
// link, Back/Forward, Retry), so a Search typed while a View GET is pending
// or failed composes with that View instead of the installed one. A
// successful install reconciles the form from the response as before.
function syncReleaseAssetsRequestedView(state, url) {
  const input = state.document?.querySelector?.(`${RELEASE_ASSETS_LIVE_FILTER_SELECTOR} input[type="hidden"][name="view"]`);
  if (!input || !url?.searchParams) return;
  const view = url.searchParams.get('view') === 'list' ? 'list' : 'grid';
  if (input.value !== view) input.value = view;
}

/*
 * R5: every GET that starts (a page-size or filter change, a live link,
 * Back/Forward, Retry) is the newest intended navigation, so its own page
 * size replaces any earlier, now abandoned, page-size intent the moment it
 * starts, not when it installs. Both page-size controls are set to it without
 * a change event (no extra GET), so a following View/Clear/pagination link,
 * filter change, failed GET or reopened dialog composes with the requested
 * size. An omitted pageSize is the service default 25. P3-C4: the server
 * honours only the sizes the controls offer and renders any other value
 * (7, 201, abc, ALL, ...) at that same default 25, so such a request's
 * effective size is 25 and is recorded as such — an unsupported historic
 * value never survives as intent or keeps an older size on the controls.
 * With no page-size control rendered (read-only), no intent is recorded.
 * A later explicit size choice is recorded by onFormChange as before and
 * starts its own GET, so it still wins.
 */
function releaseAssetsPageSizeControlOffers(control, value) {
  return Array.from(control?.querySelectorAll?.('option') || [])
    .some((option) => String(option.value ?? option.getAttribute?.('value') ?? '') === value);
}

function syncReleaseAssetsRequestedPageSize(state, url) {
  if (!url?.searchParams) return;
  // A repeated pageSize is never one supported value to the server either.
  const sizes = url.searchParams.getAll('pageSize');
  const requested = sizes.length === 1 && sizes[0] !== '' ? sizes[0] : '25';
  const controls = Array.from(state.document?.querySelectorAll?.(RELEASE_ASSETS_PAGE_SIZE_CONTROL_SELECTOR) || []);
  const offered = (value) => controls.some((control) => releaseAssetsPageSizeControlOffers(control, value));
  const value = offered(requested) ? requested : '25';
  if (!offered(value)) {
    state.releaseAssetsPageSizeIntent = null;
    return;
  }
  state.releaseAssetsPageSizeIntent = value;
  controls.forEach((control) => {
    if (control.value === value || !releaseAssetsPageSizeControlOffers(control, value)) return;
    control.value = value;
    syncCreatorCrateDropdownFromNative(control);
  });
}

/*
 * R5: Back/Forward (and the Retry of a failed one, the engine's only
 * 'replace' loads here) replaces the whole intended navigation with the
 * history entry. The Filter dialog's Search/Selection/Extension/Category
 * still show the installed (or an abandoned pending) state, so they follow
 * the entry at once; a filter changed before the entry installs then composes
 * with it instead of resubmitting the abandoned values. Nothing is
 * dispatched, and an option the dialog does not render is left unchanged.
 * R8: a Clear GET is synchronized the same way when it starts.
 */
function syncReleaseAssetsHistoryFilters(state, url) {
  const form = state.document?.querySelector?.(RELEASE_ASSETS_LIVE_FILTER_SELECTOR);
  if (!form || !url?.searchParams) return;
  const search = form.querySelector?.(RELEASE_ASSETS_LIVE_SEARCH_SELECTOR);
  const searchValue = url.searchParams.get('search') || '';
  if (search && search.value !== searchValue) search.value = searchValue;
  const values = {
    selection: url.searchParams.get('selection') === 'all' ? 'all' : 'selected',
    extension: url.searchParams.get('extension') || '',
    category: url.searchParams.get('category') || '',
  };
  Object.entries(values).forEach(([name, value]) => {
    const radios = Array.from(form.querySelectorAll?.(`input[type="radio"][name="${name}"]`) || []);
    const target = radios.find((radio) => String(radio.value ?? '') === value);
    if (!target || target.checked) return;
    radios.forEach((radio) => { radio.checked = radio === target; });
    const dropdown = target.closest?.(CC_DROPDOWN_SELECTOR);
    if (dropdown) initializeCreatorCrateDropdown(dropdown);
  });
}

function enhanceReleaseAssetsLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceAssetViewerInfoCards(region);
  enhanceDashboardTitleInfoCards(region);
  enhanceNumberInputs(region);
  enhanceAssetSelection(liveRegionDocument(region));
  enhanceAssetGridSize(region);
  enhanceAssetListSize(region);
  syncReleaseAssetsDraftRoleControls(region);
  enhanceAutoSubmit(region);
  enhanceAssetViewerFilterDisclosures(region);
  enhanceDropdowns(liveRegionDocument(region));
  enhanceAssetGridStyle(region);
}

const releaseAssetsLiveEngine = createLiveRegionEngine({
  regionSelector: RELEASE_ASSETS_LIVE_REGION_SELECTOR,
  formSelector: [RELEASE_ASSETS_LIVE_FILTER_SELECTOR, RELEASE_ASSETS_PAGE_SIZE_FORM_SELECTOR],
  formScope: 'document',
  linkSelector: 'nav.view-switcher a, .pagination a, [data-release-assets-reset]',
  linkScope: 'document',
  linkDestination: releaseAssetsLinkDestination,
  transformParams: releaseAssetsPageSizeFormParams,
  searchSelector: RELEASE_ASSETS_LIVE_SEARCH_SELECTOR,
  changeSelector: RELEASE_ASSETS_LIVE_FILTER_CONTROL_SELECTOR,
  debounceMs: RELEASE_ASSETS_LIVE_DEBOUNCE_MS,
  defaultAction: '/releases',
  stateKey: '__creatorCrateReleaseAssetsLiveFiltering',
  historyState: { releaseAssets: true },
  statusSelector: RELEASE_ASSETS_LIVE_STATUS_SELECTOR,
  statusStateAttribute: RELEASE_ASSETS_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading Release Assets.',
  fallbackMessage: 'Release Assets are loading as a full page.',
  responseErrorMessage: 'Release Assets response failed.',
  missingRegionMessage: 'Release Assets response did not contain the live region.',
  enhanceRegion: enhanceReleaseAssetsLiveRegion,
  onCreate(state) {
    enhanceDropdowns(state.document);
    enhanceAssetViewerFilterDisclosures(state.document);
    bindReleaseAssetsDraftMembership(state);
    bindReleaseAssetsDraftRoles(state);
  },
  onFormChange(state, _form, event) {
    recordReleaseAssetsPageSizeIntent(state, event?.target);
  },
  onLoadStart(state, _generation, url, historyMode) {
    syncReleaseAssetsRequestedView(state, url);
    // R5: the requested GET owns page size (and, for history, the filters).
    syncReleaseAssetsRequestedPageSize(state, url);
    // R8: a Clear GET owns the filters the same way, from the moment it starts.
    const clearHref = state.releaseAssetsClearHref;
    state.releaseAssetsClearHref = null;
    if (historyMode === 'replace' || clearHref === url.href) syncReleaseAssetsHistoryFilters(state, url);
  },
  onResponseParsed(state, parsed, nextRegion) {
    reconcileExternalFilterForm(state, parsed, RELEASE_ASSETS_LIVE_FILTER_SELECTOR);
    enhanceAssetViewerFilterDisclosures(state.document);
    updateReleaseAssetsAuthoritativeMembership(state, parsed, nextRegion);
  },
  onRegionReplaced(state, region) {
    // The installed response now owns both page-size controls.
    state.releaseAssetsPageSizeIntent = null;
    syncReleaseAssetsSelectionFormAction(state);
    reconcileReleaseAssetsSelection(state, region);
    // Only a current response reaches this point. An open image viewer
    // reconciles with the installed thumbnails; drafts are already restored.
    refreshReleaseAssetsViewer(region);
  },
  onLoadError(state) {
    if (state.releaseAssetsSelection) state.releaseAssetsSelection.pendingFormAction = null;
    return false;
  },
  isCurrentUrl(url) {
    return /^\/releases\/[1-9]\d*\/assets$/.test(url.pathname);
  },
  responseMatches: sameResponsePath,
  loadFailureMessage: liveFilterFailureMessage('Release Assets'),
});

const PROJECT_ASSETS_LIVE_REGION_SELECTOR = '[data-project-assets-live-region]';
const PROJECT_ASSETS_FILTER_SELECTOR = ['#asset-filters', '.page-size-form'];
const PROJECT_ASSETS_RESET_FORM_SELECTOR = '#project-assets-filter-dialog .projects-filter-reset';
const PROJECT_ASSETS_SEARCH_SELECTOR = '#search';
const PROJECT_ASSETS_MANUAL_SCAN_FORM_SELECTOR = 'form[method="post"][action$="/scan/manual"]';
const PROJECT_ASSETS_MANUAL_SCAN_CONTEXT_SELECTOR = 'input[type="hidden"]:not([name="_csrf"])';
const PROJECT_ASSETS_LIVE_STATUS_SELECTOR = '[data-project-assets-live-status]';
const PROJECT_ASSETS_LIVE_STATE_ATTRIBUTE = 'data-project-assets-live-state';
const PROJECT_ASSETS_NSFW_FORM_SELECTOR = '[data-project-assets-nsfw-filter]';
const PROJECT_ASSETS_NSFW_TOGGLE_SELECTOR = '[data-project-assets-nsfw-toggle]';
const PROJECT_ASSETS_LIVE_DEBOUNCE_MS = 350;
export const PROJECT_ASSETS_REGION_LOADED_EVENT = 'project-assets-region-loaded';

// Package B: Reset filters is an ordinary live GET of ?resetFilters=1 whose
// destination (filters, Sort, View, page size and page 1) the server resolves
// from the effective saved/default state, so no request-time View can leak
// into it. Its lifecycle rides on the engine's own generation ownership: one
// load owns one Reset, and each phase is announced once on the document as
// PROJECT_ASSETS_FILTERS_RESET_EVENT with detail { id, phase, generation, url }:
// - 'started':    the Reset GET was issued (initial click, Retry, or a
//                 post-mutation refresh re-reading a failed Reset). A
//                 refresh re-reading a Reset still in flight carries that
//                 same Reset (F7-R1): no new 'started', no 'superseded'.
// - 'prepared':   its response was parsed and validated, before install;
//                 detail.parsed is that response document.
// - 'installed':  its region and controls are installed (after
//                 PROJECT_ASSETS_REGION_LOADED_EVENT for the same load).
// - 'failed':     it did not install; the last valid state stays, with Retry.
// - 'superseded': a newer load (newer user intent) took over before install.
// Only 'installed' means the Reset happened. Nothing here writes defaults or
// browser storage.
export const PROJECT_ASSETS_FILTERS_RESET_EVENT = 'project-assets-filters-reset';

function isProjectAssetsFiltersResetUrl(url) {
  return Boolean(url?.searchParams?.has?.('resetFilters'));
}

function announceProjectAssetsFiltersReset(state, reset, phase, extra = {}) {
  const document = state.document;
  const CustomEventConstructor = state.window?.CustomEvent || globalThis.CustomEvent;
  if (!document?.dispatchEvent || typeof CustomEventConstructor !== 'function') return;
  try {
    document.dispatchEvent(new CustomEventConstructor(PROJECT_ASSETS_FILTERS_RESET_EVENT, {
      detail: {
        id: reset.id,
        phase,
        generation: reset.generation,
        url: reset.url,
        ...extra,
      },
    }));
  } catch { /* a listener's failure is never the Reset's */ }
}

function beginProjectAssetsFiltersReset(state, generation, url) {
  state.projectAssetsFiltersResetId += 1;
  const reset = {
    id: state.projectAssetsFiltersResetId,
    generation,
    url: url?.href || String(url || ''),
    phase: 'pending',
  };
  state.projectAssetsFiltersReset = reset;
  announceProjectAssetsFiltersReset(state, reset, 'started');
}

function settleProjectAssetsFiltersReset(state, phase, generation = null) {
  const reset = state.projectAssetsFiltersReset;
  if (!reset || (generation !== null && reset.generation !== generation)) return;
  state.projectAssetsFiltersReset = null;
  announceProjectAssetsFiltersReset(state, reset, phase);
}

function projectAssetsNsfwForm(region) {
  return region?.querySelector?.(PROJECT_ASSETS_NSFW_FORM_SELECTOR) || null;
}

function projectAssetsNsfwEnabled(form) {
  const value = form?.querySelector?.('[data-project-assets-nsfw-value]')?.value
    || form?.querySelector?.('[data-project-assets-nsfw-value]')?.getAttribute?.('value');
  return value === '1';
}

function projectAssetsRenderedNsfwEnabled(region) {
  return region?.querySelector?.(PROJECT_ASSETS_NSFW_TOGGLE_SELECTOR)?.getAttribute?.('aria-pressed') === 'true';
}

function updateProjectAssetsNsfwControls(scope, enabled, pending = false) {
  const controls = Array.from(scope?.querySelectorAll?.(PROJECT_ASSETS_NSFW_TOGGLE_SELECTOR) || []);
  const label = enabled ? 'Disable NSFW filter' : 'Enable NSFW filter';
  controls.forEach((control) => {
    control.disabled = pending;
    if (pending) control.setAttribute?.('disabled', '');
    else control.removeAttribute?.('disabled');
    control.setAttribute?.('aria-pressed', String(enabled));
    control.setAttribute?.('aria-label', label);
    control.setAttribute?.('data-tooltip', label);
  });
  scope?.querySelectorAll?.(PROJECT_ASSETS_NSFW_FORM_SELECTOR).forEach((form) => {
    const value = form.querySelector?.('[data-project-assets-nsfw-value]');
    if (value) value.value = enabled ? '0' : '1';
    if (pending) form.setAttribute?.('aria-busy', 'true');
    else form.removeAttribute?.('aria-busy');
  });
}

function submitProjectAssetsNsfwToggle(state, form, event) {
  if (!projectAssetsLiveEngine.capabilities(state.window)) return false;
  if (state.assetNsfwSubmitting) {
    event.preventDefault?.();
    return true;
  }

  let refreshUrl;
  try {
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
    refreshUrl = (state.controller || state.loadFailure) && state.requestedUrl
      ? new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href)
      : projectAssetsLiveEngine.url(
        projectAssetsLiveEngine.getForm(projectAssetsLiveEngine.getRegion(state.document)),
        state.window,
        { preservePage: true },
      );
  } catch {
    return false;
  }

  event.preventDefault?.();
  projectAssetsLiveEngine.invalidate(state);
  state.assetNsfwGeneration += 1;
  const generation = state.assetNsfwGeneration;
  const enabled = projectAssetsNsfwEnabled(form);
  const previousEnabled = projectAssetsRenderedNsfwEnabled(projectAssetsLiveEngine.getRegion(state.document));
  state.assetNsfwSubmitting = true;
  state.assetNsfwPostPending = true;
  // WP10b F5: the filter destination this POST carries, for a toolbar View
  // click made before it answers.
  state.assetNsfwRefreshUrl = refreshUrl;
  state.assetNsfwNeedsRefresh = false;
  state.assetNsfwRegionReplaced = false;
  state.assetNsfwPreviousEnabled = previousEnabled;
  state.assetNsfwEnabled = enabled;

  const controller = projectAssetsLiveEngine.controller(state.window);
  state.assetNsfwController?.abort?.();
  state.assetNsfwController = controller;
  let requestBody;
  try {
    requestBody = new state.window.URLSearchParams(new state.window.FormData(form));
    requestBody.set('enabled', enabled ? '1' : '0');
  } catch {
    state.assetNsfwSubmitting = false;
    state.assetNsfwPostPending = false;
    updateProjectAssetsNsfwControls(projectAssetsLiveEngine.getRegion(state.document), previousEnabled);
    projectAssetsLiveEngine.nativeSubmit(form);
    return true;
  }
  updateProjectAssetsNsfwControls(projectAssetsLiveEngine.getRegion(state.document), enabled, true);
  const options = {
    method: String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase(),
    body: requestBody,
    credentials: 'same-origin',
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  };
  if (controller) options.signal = controller.signal;

  let request;
  try {
    request = state.window.fetch(form.action || form.getAttribute?.('action'), options);
  } catch (error) {
    request = Promise.reject(error);
  }

  Promise.resolve(request)
    .then(async (response) => {
      if (!response?.ok) throw new Error('NSFW filter update failed.');
      const payload = typeof response.json === 'function' ? await response.json() : null;
      if (payload?.status !== 'success' || typeof payload.enabled !== 'boolean') {
        throw new Error('NSFW filter update failed.');
      }
      return payload;
    })
    .then((payload) => {
      if (generation !== state.assetNsfwGeneration) return;
      state.assetNsfwController = null;
      state.assetNsfwPostPending = false;
      state.assetNsfwRefreshUrl = null;
      state.assetNsfwEnabled = payload.enabled;
      state.assetNsfwNeedsRefresh = true;
      projectAssetsLiveEngine.invalidate(state);
      updateProjectAssetsNsfwControls(projectAssetsLiveEngine.getRegion(state.document), payload.enabled, true);
      projectAssetsLiveEngine.load(
        state,
        refreshUrl,
        'none',
        projectAssetsLiveEngine.getForm(projectAssetsLiveEngine.getRegion(state.document)),
      );
    })
    .catch(() => {
      if (generation !== state.assetNsfwGeneration) return;
      state.assetNsfwController = null;
      state.assetNsfwPostPending = false;
      state.assetNsfwRefreshUrl = null;
      state.assetNsfwSubmitting = false;
      state.assetNsfwNeedsRefresh = false;
      const region = projectAssetsLiveEngine.getRegion(state.document);
      const enabledState = state.assetNsfwRegionReplaced
        ? projectAssetsRenderedNsfwEnabled(region)
        : state.assetNsfwPreviousEnabled;
      state.assetNsfwEnabled = enabledState;
      state.assetNsfwRegionReplaced = false;
      updateProjectAssetsNsfwControls(region, enabledState);
      region?.removeAttribute?.('aria-busy');
      projectAssetsLiveEngine.status(region, 'Could not update the NSFW filter. The previous setting was kept.', 'error');
      // The POST superseded a mutation refresh that still has to happen.
      if (state.projectAssetsRefreshOwed) refreshProjectAssetsLiveRegion(state.document);
    });

  return true;
}

function bindProjectAssetsNsfwForm(state, region) {
  const form = projectAssetsNsfwForm(region);
  if (!form || isEnhancementBound(form, 'projectAssetsNsfwBound')) return;
  markEnhancementBound(form, 'projectAssetsNsfwBound');
  form.addEventListener?.('submit', (event) => submitProjectAssetsNsfwToggle(state, form, event));
}

function inheritedProjectAssetsFilterDefaults(form) {
  const input = form?.querySelector?.('[data-project-assets-inherited-filter-defaults]');
  if (!input || input.disabled) return [];
  return [...new Set(String(input.value || '').split(',')
    .map((value) => value.trim())
    .filter((value) => value === 'tag' || value === 'extension'))];
}

function updateInheritedProjectAssetsFilterDefaults(form, event) {
  const name = event?.target?.name || event?.target?.getAttribute?.('name');
  if (name !== 'tag' && name !== 'extension') return;

  const input = form?.querySelector?.('[data-project-assets-inherited-filter-defaults]');
  if (!input) return;
  const remaining = inheritedProjectAssetsFilterDefaults(form).filter((key) => key !== name);
  input.value = remaining.join(',');
  input.disabled = remaining.length === 0;
}

function omitInheritedProjectAssetsFiltersForCategory(params, form) {
  const inherited = inheritedProjectAssetsFilterDefaults(form);
  // WP7: Select all is checked whenever no value is, including while an
  // inherited Tag/Extension default is suspended. Until the user chooses for
  // that key, its explicit-neutral `all` must not override the marker.
  inherited.forEach((key) => {
    const values = params.getAll(key);
    if (!values.includes('all')) return;
    params.delete(key);
    values.filter((value) => value !== 'all').forEach((value) => params.append(key, value));
  });
  const category = params.get('category');
  if (!/^[1-9]\d*$/.test(category || '')) return;

  inherited.forEach((key) => params.delete(key));
}

// WP7: View and Assets per page live in the Filters & Defaults Miscellaneous
// section, outside #asset-filters, and join it with form="asset-filters". A
// change there schedules the form's own load; a response reconciles them as it
// reconciles the form's children.
const PROJECT_ASSETS_LIVE_MISC_SELECTOR = '[data-project-assets-live-misc]';

function bindProjectAssetsAssociatedFilterControls(state) {
  const document = state.document;
  if (!document || isEnhancementBound(document, 'projectAssetsAssociatedFiltersBound')) return;
  markEnhancementBound(document, 'projectAssetsAssociatedFiltersBound');
  document.addEventListener?.('change', (event) => {
    const control = event.target;
    const form = control?.form;
    if (!form || form.id !== 'asset-filters' || form.contains?.(control)) return;
    if (!control.name && !control.getAttribute?.('name')) return;
    // R3: a dialog View choice shows its own presentation fields at once
    // (before the debounced GET); the GET itself is scheduled as before.
    if (control.id === 'asset-view-filter') syncProjectAssetsViewDependentFields(document);
    projectAssetsLiveEngine.schedule(state, form);
  });
}

function reconcileProjectAssetsAssociatedFilterControls(state, parsed) {
  let replaced = false;
  state.document?.querySelectorAll?.(PROJECT_ASSETS_LIVE_MISC_SELECTOR).forEach((current) => {
    const key = current.getAttribute?.('data-project-assets-live-misc');
    const next = parsed?.querySelector?.(`[data-project-assets-live-misc="${key}"]`);
    if (!next || current.isEqualNode?.(next)) return;
    const captured = liveRegionCaptureState(current, state.document);
    current.replaceChildren?.(...Array.from(next.childNodes || []));
    liveRegionRestoreState(current, state.document, captured);
    replaced = true;
  });
  if (replaced) enhanceDropdowns(state.document);
  // R3: the response's View (replaced or kept) decides the presentation
  // fields; they are never replaced themselves, so their values survive.
  syncProjectAssetsViewDependentFields(state.document);
}

// The Manual scan form sits in the page heading, outside the live region, and
// its scan redirect rebuilds the page URL from its hidden context fields. Copy
// the context the server rendered for the newly applied view so the scan
// returns to that view (including inheritedFilterDefaults) instead of the
// first render's filters. The _csrf input and submit button stay in place.
function reconcileProjectAssetsManualScanContext(state, parsed) {
  const currentForm = state.document?.querySelector?.(PROJECT_ASSETS_MANUAL_SCAN_FORM_SELECTOR);
  const nextForm = parsed?.querySelector?.(PROJECT_ASSETS_MANUAL_SCAN_FORM_SELECTOR);
  if (!currentForm || !nextForm || currentForm === nextForm) return;

  const contextInputs = (form) => Array.from(
    form.querySelectorAll?.(PROJECT_ASSETS_MANUAL_SCAN_CONTEXT_SELECTOR) || [],
  );
  contextInputs(currentForm).forEach((input) => input.remove?.());
  const nextInputs = contextInputs(nextForm);
  const csrf = currentForm.querySelector?.('input[name="_csrf"]');
  if (csrf) csrf.after?.(...nextInputs);
  else currentForm.prepend?.(...nextInputs);
}

const PROJECT_ASSETS_MEMBERSHIP_SELECTOR = '[data-project-assets-membership]';
const PROJECT_ASSETS_TOOLBAR_FOCUS_SELECTOR = '.asset-viewer-display-controls a, .asset-viewer-display-controls button';
const PROJECT_ASSETS_SCROLLER_SELECTOR = '.asset-list-scroll';
const PROJECT_ASSETS_FORM_DRAFT_SELECTORS = ['[data-release-select]', 'select[name="destinationCategory"]'];
const PROJECT_ASSETS_ARCHIVED_NOTICE_SELECTOR = '[data-project-assets-archived-notice]';
const PROJECT_ASSETS_REMOVE_MISSING_DIALOG_ID = 'remove-missing-assets-dialog';

function projectAssetsMembership(region) {
  try {
    const parsed = JSON.parse(region?.querySelector?.(PROJECT_ASSETS_MEMBERSHIP_SELECTOR)?.textContent ?? 'null');
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : null;
  } catch {
    return null;
  }
}

function projectAssetIdOf(element) {
  const owner = element?.closest?.('[data-asset-id], [data-auto-rename-asset-id]');
  return owner?.getAttribute?.('data-asset-id') ?? owner?.getAttribute?.('data-auto-rename-asset-id') ?? null;
}

// What a post-mutation install must carry over. Taken immediately before the
// replacement, so changes made while the GET was pending are included.
function captureProjectAssetsTransientState(state, region) {
  const document = state.document;
  const active = document.activeElement;
  const focusInRegion = Boolean(active && active !== region && region?.contains?.(active));
  return {
    selection: captureAssetSelection(region),
    renameDrafts: captureAssetRenameDrafts(region),
    gridStyle: region?.querySelector?.('.asset-grid')?.getAttribute?.('data-grid-style') ?? null,
    formDrafts: PROJECT_ASSETS_FORM_DRAFT_SELECTORS.map((selector) => ({
      selector,
      value: region?.querySelector?.(selector)?.value ?? null,
    })),
    openDetails: Array.from(region?.querySelectorAll?.('[data-asset-id] details') || [])
      .filter((details) => details.open === true)
      .map((details) => {
        const card = details.closest?.('[data-asset-id]');
        return {
          assetId: card?.getAttribute?.('data-asset-id'),
          index: Array.from(card?.querySelectorAll?.('details') || []).indexOf(details),
        };
      }),
    focus: focusInRegion ? {
      assetId: projectAssetIdOf(active),
      label: active.getAttribute?.('aria-label') || '',
      isOrderItem: Boolean(active.matches?.('[data-auto-rename-asset]')),
      control: liveRegionCaptureState(region, document).focus,
      visibleIds: Array.from(region?.querySelectorAll?.('[data-asset-id]') || [])
        .map((card) => card.getAttribute?.('data-asset-id')),
    } : null,
    scrollX: state.window.scrollX,
    scrollY: state.window.scrollY,
    scrollers: Array.from(region?.querySelectorAll?.(PROJECT_ASSETS_SCROLLER_SELECTOR) || [])
      .map((element) => ({ left: element.scrollLeft ?? 0, top: element.scrollTop ?? 0 })),
  };
}

// F10: the effective asset-filter context a region was rendered for. Its
// toolbar View links are the server's canonical address of that context
// (project path, every filter, Sort, Order, page and page size, with values
// that differ from the saved defaults made explicit), so the context is that
// address without `view`. A region without them has no known context.
function projectAssetsSelectionContext(region) {
  const href = region?.querySelector?.('nav.view-switcher a[href]')?.getAttribute?.('href');
  if (!href) return null;
  let url;
  try {
    url = new URL(href, 'http://creatorcrate.invalid');
  } catch {
    return null;
  }
  url.searchParams.delete('view');
  return `${url.pathname}?${projectAssetsParamsKey(url)}`;
}

// F10: a user navigation whose response renders the same effective context
// as the installed results changed only the Grid/List presentation, whatever
// started it (a toolbar or dialog View, Retry, Back/Forward). Both contexts
// come from server-rendered regions, so a pending Search, filter or page
// joined to a View click shows up as a different context. Reset filters, a
// Defaults refresh and an NSFW refresh are never pure View changes.
function projectAssetsPureViewChange(state, region, nextRegion) {
  const generation = state.generation;
  if (state.projectAssetsFiltersReset?.generation === generation
    || state.projectAssetsDefaultsRefreshGeneration === generation
    || state.assetNsfwRefreshGeneration === generation) return false;
  const installed = projectAssetsSelectionContext(region);
  return installed !== null && installed === projectAssetsSelectionContext(nextRegion);
}

// Unsaved orders by category, each held until its own surface renders again. A
// page reload ends them, and so does moving the order back to the saved one.
function retainProjectAssetsOrderDraft(state, region) {
  const draft = captureAutoRenameOrderDraft(region);
  if (draft) state.projectAssetsOrderDrafts.set(draft.categoryId, draft);
}

function restoreProjectAssetsOrderDrafts(state, region) {
  let order = { status: 'none', added: [], removed: [] };
  state.projectAssetsOrderDrafts.forEach((draft, categoryId) => {
    const result = restoreAutoRenameOrderDraft(region, draft, {
      onCheckAgain: () => refreshProjectAssetsLiveRegion(state.document),
    });
    if (result.status !== 'retained') state.projectAssetsOrderDrafts.delete(categoryId);
    if (result.status !== 'retained' || order.status === 'none') order = result;
  });
  return order;
}

function projectAssetFocusTarget(region, assetId, focus) {
  const card = region?.querySelector?.(`[data-asset-id="${assetId}"]`);
  if (!card) return null;
  const orderItem = region.querySelector?.(`[data-auto-rename-asset-id="${assetId}"]`);
  if (focus.isOrderItem && orderItem) return orderItem;
  const labelled = focus.label
    ? Array.from(card.querySelectorAll?.('[aria-label]') || [])
      .find((control) => control.getAttribute?.('aria-label') === focus.label)
    : null;
  return labelled || orderItem || card.querySelector?.('input[type="checkbox"]:not(:disabled), a[href], button:not(:disabled)') || card;
}

// Focus follows the same asset or control. A removed asset passes it to the next
// or previous shown asset, then the toolbar; a dialog opened since keeps its own.
function restoreProjectAssetsFocus(state, region, focus) {
  if (!focus || state.document.querySelector?.('dialog[open]')) return;
  if (liveRegionFindFocus(region, focus.control)) return;
  let target = null;
  if (focus.assetId) {
    target = projectAssetFocusTarget(region, focus.assetId, focus);
    const position = focus.visibleIds.indexOf(focus.assetId);
    const neighbors = [...focus.visibleIds.slice(position + 1), ...focus.visibleIds.slice(0, Math.max(position, 0)).reverse()];
    for (const assetId of neighbors) {
      if (target) break;
      target = projectAssetFocusTarget(region, assetId, { isOrderItem: focus.isOrderItem, label: '' });
    }
  } else if (focus.label) {
    target = Array.from(region.querySelectorAll?.('[aria-label]') || [])
      .find((control) => control.getAttribute?.('aria-label') === focus.label);
  }
  (target || region.querySelector?.(PROJECT_ASSETS_TOOLBAR_FOCUS_SELECTOR))?.focus?.({ preventScroll: true });
}

function restoreProjectAssetsTransientState(state, region, snapshot) {
  const membership = projectAssetsMembership(region);
  const grid = region.querySelector?.('.asset-grid');
  if (grid && snapshot.gridStyle) grid.setAttribute?.('data-grid-style', snapshot.gridStyle);
  snapshot.formDrafts.forEach(({ selector, value }) => {
    const select = region.querySelector?.(selector);
    if (!select || !value || !Array.from(select.options || []).some((option) => option.value === value && !option.disabled)) return;
    select.value = value;
    syncCreatorCrateDropdownFromNative(select);
  });
  const selection = restoreAssetSelection(region, snapshot.selection, membership);
  restoreAssetRenameDrafts(region, snapshot.renameDrafts);
  snapshot.openDetails.forEach(({ assetId, index }) => {
    const details = region.querySelector?.(`[data-asset-id="${assetId}"]`)?.querySelectorAll?.('details')?.[index];
    if (details) details.open = true;
  });

  const order = restoreProjectAssetsOrderDrafts(state, region);

  restoreProjectAssetsFocus(state, region, snapshot.focus);
  Array.from(region.querySelectorAll?.(PROJECT_ASSETS_SCROLLER_SELECTOR) || []).forEach((element, index) => {
    const position = snapshot.scrollers[index];
    if (!position) return;
    element.scrollLeft = position.left;
    element.scrollTop = position.top;
  });
  state.window.scrollTo?.(snapshot.scrollX, snapshot.scrollY);
  return { selection, order };
}

function adoptProjectAssetsRemoveMissingDialog(document, parsed) {
  const current = document.getElementById?.(PROJECT_ASSETS_REMOVE_MISSING_DIALOG_ID);
  const rendered = parsed.querySelector?.(`#${PROJECT_ASSETS_REMOVE_MISSING_DIALOG_ID}`);
  if (current && rendered) {
    const returnTo = current.querySelector?.('input[name="returnTo"]');
    const renderedReturnTo = rendered.querySelector?.('input[name="returnTo"]');
    if (returnTo && renderedReturnTo) returnTo.value = renderedReturnTo.value;
  } else if (current && !current.open) {
    // An open dialog stays until dismissed; the server guards its submission.
    current.remove?.();
  } else if (rendered) {
    const sibling = document.getElementById?.('project-assets-filter-dialog');
    if (sibling?.parentNode) {
      sibling.parentNode.insertBefore?.(rendered, sibling);
      enhanceAppDialogs(document);
    }
  }
}

// Mutation results shown outside the region: the heading actions (including
// Remove missing assets), its dialog, and the archived notice. Filter and
// processing category counts are handled by their existing reconcilers.
function reconcileProjectAssetsDependents(state, parsed) {
  const document = state.document;
  const heading = document.querySelector?.('.page-heading');
  const renderedHeading = parsed.querySelector?.('.page-heading');
  if (heading && renderedHeading && !heading.isEqualNode?.(renderedHeading)) {
    const active = document.activeElement;
    const focusLabel = heading.contains?.(active) ? active.getAttribute?.('aria-label') : null;
    heading.replaceWith?.(renderedHeading);
    if (focusLabel) {
      (Array.from(renderedHeading.querySelectorAll?.('[aria-label]') || [])
        .find((control) => control.getAttribute?.('aria-label') === focusLabel)
        || renderedHeading.querySelector?.('a, button'))?.focus?.({ preventScroll: true });
    }
  }
  const archivedNotice = document.querySelector?.(PROJECT_ASSETS_ARCHIVED_NOTICE_SELECTOR);
  const renderedArchivedNotice = parsed.querySelector?.(PROJECT_ASSETS_ARCHIVED_NOTICE_SELECTOR);
  if (archivedNotice && !renderedArchivedNotice) archivedNotice.remove?.();
  else if (!archivedNotice && renderedArchivedNotice) {
    document.querySelector?.('.page-heading')?.after?.(renderedArchivedNotice);
  }
  adoptProjectAssetsRemoveMissingDialog(document, parsed);
}

// Correction D (F6): the region's rendered size defaults are the fallback the
// Grid and List size controls use while no browser size is stored. A defaults
// reset changes what the server renders there but must not change what is
// displayed, so the fallback in use is carried onto each later region for as
// long as the server keeps rendering the post-reset default. Nothing is
// stored: a stored browser size still wins, and a later Save or scope change
// (a different rendered default) retires the carried value.
const PROJECT_ASSETS_SIZE_FALLBACKS = Object.freeze([
  { key: 'gridSize', attribute: 'data-project-assets-grid-size-default', config: ASSET_GRID_SIZE_CONFIG },
  { key: 'listSize', attribute: 'data-project-assets-list-size-default', config: ASSET_LIST_SIZE_CONFIG },
]);

function projectAssetsRenderedSizeFallback(region, attribute, config) {
  const value = region?.getAttribute?.(attribute);
  return gridSizeIsValid(value, config) ? value : config.defaultSize;
}

// Correction E (F6): every live load invalidates before it starts, so each
// request owns one generation, and only the current generation's response is
// parsed. A response whose generation is the one that was in flight when the
// reset was acknowledged was rendered against the defaults the reset removed:
// its size defaults are no evidence of a newer Save or scope change, so it
// carries the retained values without retiring them. Any later load owns a
// newer generation, so the marker only ever applies to that one response.
function carryProjectAssetsSizeFallbacks(state, nextRegion) {
  const carried = state.projectAssetsCarriedSizeFallbacks;
  const predatesRetention = state.projectAssetsSizeRetentionPredates !== null
    && state.projectAssetsSizeRetentionPredates === state.generation;
  state.projectAssetsSizeRetentionPredates = null;
  PROJECT_ASSETS_SIZE_FALLBACKS.forEach(({ key, attribute, config }) => {
    const entry = carried?.[key];
    if (!entry) return;
    if (!predatesRetention
      && projectAssetsRenderedSizeFallback(nextRegion, attribute, config) !== entry.rendered) {
      delete carried[key];
      return;
    }
    nextRegion?.setAttribute?.(attribute, entry.displayed);
  });
}

// Correction D (F7): from an acknowledged defaults reset until a region
// rendered after it installs, the region's page and view links still resolve
// their omitted values through the deleted defaults. They lose their
// destination (no href: no pointer, keyboard, middle-click or new-tab
// activation) and are marked unavailable; any installed region replaces them
// with links rendered against the defaults now persisted.
const PROJECT_ASSETS_STALE_LINK_SELECTOR = 'nav.view-switcher a[href], .pagination a[href]';
export const PROJECT_ASSETS_STALE_LINK_ATTRIBUTE = 'data-project-assets-stale-link';

function disableProjectAssetsStaleLinks(region) {
  region?.querySelectorAll?.(PROJECT_ASSETS_STALE_LINK_SELECTOR).forEach((link) => {
    link.removeAttribute?.('href');
    link.setAttribute?.('role', 'link');
    link.setAttribute?.('aria-disabled', 'true');
    link.setAttribute?.(PROJECT_ASSETS_STALE_LINK_ATTRIBUTE, '');
  });
}

function settleProjectAssetsRefresh(state, status, details = {}) {
  const waiter = state.projectAssetsRefreshWaiter;
  if (!waiter) return;
  state.projectAssetsRefreshWaiter = null;
  waiter.resolve({ status, url: waiter.url.href, ...details });
}

const PROJECT_ASSETS_DEFAULTS_REFRESH_ERROR_MESSAGE = 'Defaults were saved, but Project Assets could not refresh. Refresh the page to see the saved defaults.';
// WP6: a committed scope activation saved no values, so its refresh failure
// says what actually changed.
const PROJECT_ASSETS_DEFAULTS_ACTIVATION_REFRESH_ERROR_MESSAGE = 'Defaults scope changed, but Project Assets could not refresh. Refresh the page to see the loaded defaults.';
const PROJECT_ASSETS_DEFAULTS_REFRESH_ERROR_MESSAGES = new Set([
  PROJECT_ASSETS_DEFAULTS_REFRESH_ERROR_MESSAGE,
  PROJECT_ASSETS_DEFAULTS_ACTIVATION_REFRESH_ERROR_MESSAGE,
]);

// An in-place restyle reconciles the presentation, so a Defaults-refresh error
// it supersedes is obsolete. Any other status (NSFW or filter failures) and any
// content change the failed load still owed (NSFW, categories) keep the error.
function clearResolvedProjectAssetsDefaultsRefreshError(state, region) {
  const statusElement = region.querySelector?.(PROJECT_ASSETS_LIVE_STATUS_SELECTOR);
  if (region.getAttribute?.(PROJECT_ASSETS_LIVE_STATE_ATTRIBUTE) !== 'error'
    || !PROJECT_ASSETS_DEFAULTS_REFRESH_ERROR_MESSAGES.has(statusElement?.textContent)) return;
  if (state.assetNsfwSubmitting || state.assetNsfwNeedsRefresh || state.assetNsfwRefreshGeneration !== null
    || state.projectAssetCategoriesNeedSync) return;
  projectAssetsLiveEngine.status(region, '', null);
}

// The results-header Category dropdown is a second view of the Filter
// dialog's Category radios. A choice there checks the matching #asset-filters
// radio and sends one bubbling change, so category/presence coupling, URL
// building, history, page reset and failure/Retry stay the form's own. The
// value alone is ambiguous: All and Missing are both category=all, told apart
// by data-asset-category-presence.
const PROJECT_ASSETS_INLINE_CATEGORY_SELECTOR = '[data-project-assets-inline-category]';
const PROJECT_ASSETS_CATEGORY_PRESENCE_ATTRIBUTE = 'data-asset-category-presence';

function projectAssetsCategoryKey(input) {
  return {
    value: String(input?.value ?? input?.getAttribute?.('value') ?? ''),
    presence: input?.getAttribute?.(PROJECT_ASSETS_CATEGORY_PRESENCE_ATTRIBUTE) || 'all',
  };
}

function findProjectAssetsCategoryRadio(inputs, key) {
  return inputs.find((input) => {
    const candidate = projectAssetsCategoryKey(input);
    return candidate.value === key.value && candidate.presence === key.presence;
  }) || null;
}

function projectAssetsCanonicalCategoryRadios(document) {
  const form = document?.querySelector?.('#asset-filters');
  return Array.from(form?.querySelectorAll?.('input[type="radio"][name="category"]') || []);
}

function projectAssetsInlineCategoryRadios(field) {
  return Array.from(field?.querySelectorAll?.('input[type="radio"]') || []);
}

// Reflect the canonical form's Category radio without sending a change.
function syncProjectAssetsInlineCategory(document) {
  const field = document?.querySelector?.(PROJECT_ASSETS_INLINE_CATEGORY_SELECTOR);
  const canonical = projectAssetsCanonicalCategoryRadios(document).find((input) => input.checked);
  if (!field || !canonical) return;
  const inlineInputs = projectAssetsInlineCategoryRadios(field);
  const match = findProjectAssetsCategoryRadio(inlineInputs, projectAssetsCategoryKey(canonical));
  if (!match) return;
  inlineInputs.forEach((input) => { input.checked = input === match; });
  const dropdown = field.querySelector?.(CC_DROPDOWN_SELECTOR);
  if (dropdown) initializeCreatorCrateDropdown(dropdown);
}

function selectProjectAssetsInlineCategory(document, inlineInput) {
  if (!inlineInput?.checked) return;
  const canonicalInputs = projectAssetsCanonicalCategoryRadios(document);
  const canonical = findProjectAssetsCategoryRadio(canonicalInputs, projectAssetsCategoryKey(inlineInput));
  if (!canonical) {
    syncProjectAssetsInlineCategory(document);
    return;
  }
  if (canonical.checked) return;
  canonicalInputs.forEach((input) => { input.checked = input === canonical; });
  const EventConstructor = document.defaultView?.Event || globalThis.Event;
  canonical.dispatchEvent?.(new EventConstructor('change', { bubbles: true }));
}

function enhanceProjectAssetsInlineCategory(region) {
  const document = liveRegionDocument(region);
  const field = region?.querySelector?.(PROJECT_ASSETS_INLINE_CATEGORY_SELECTOR);
  if (field && !isEnhancementBound(field, 'projectAssetsInlineCategoryBound')) {
    markEnhancementBound(field, 'projectAssetsInlineCategoryBound');
    field.addEventListener?.('change', (event) => {
      if (event.target?.type !== 'radio') return;
      selectProjectAssetsInlineCategory(document, event.target);
    });
  }
  // Filter dialog Category/Show changes reach the inline control through the
  // engine's onFormChange; a replaced region syncs here after the dialog form
  // has been reconciled with the response.
  syncProjectAssetsInlineCategory(document);
}

function enhanceProjectAssetsLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceAssetViewerInfoCards(region);
  enhanceDashboardTitleInfoCards(region);
  enhanceNumberInputs(region);
  enhanceAssetSelection(region);
  enhanceAssetRenames(region);
  enhanceAssetGridSize(region);
  enhanceAssetListSize(region);
  enhanceAssetAutoRenameOrdering(region);
  enhanceAppConfirmationControls(region);
  enhanceProjectAssetCategoryFilter(liveRegionDocument(region));
  enhanceDropdowns(liveRegionDocument(region));
  enhanceProjectAssetsInlineCategory(region);
  // Image previews and the Slideshow button open the unified viewer through
  // one delegated binding; a replaced region only reconciles an open viewer
  // with the sequence onResponseParsed has just copied in.
  refreshProjectAssetsViewer(region);
}

/*
 * WP10b F5: a toolbar Grid/List link was rendered against the installed
 * Project Assets page, so it does not know a filter change that is still
 * debounced, in flight or failed, or one an unanswered NSFW POST is carrying.
 * The clicked View is newer intent applied to that latest intended filter
 * destination (the precedence the mutation refresh and NSFW refresh use); an
 * idle page keeps the link's own canonical address. The dialog's View control
 * follows the click, so a filter edit made before the response keeps the
 * chosen View. Selection, order drafts and defaults stay the engine's ordinary
 * navigation concerns: nothing here writes, posts or saves.
 *
 * F7: Reset filters is resolved by the server from the effective saved
 * defaults (it ignores a request-time View), and the restored address is only
 * known from its redirect. A View click while a Reset is in flight is
 * therefore recorded as the Reset's View (the latest click wins) and the
 * Reset keeps running; followProjectAssetsResetView applies it to the
 * restored address. A View click on a failed Reset re-requests that Reset
 * with the View, exactly like its Retry. A new Reset click starts a new Reset
 * without an earlier View; any other navigation drops it (onLoadStart).
 */
function projectAssetsViewLinkDestination(state, link, url) {
  if (link?.matches?.('[data-project-assets-reset]')) {
    state.projectAssetsResetView = null;
    return url;
  }
  if (!link?.closest?.('nav.view-switcher')) return url;
  const form = projectAssetsLiveEngine.getForm(projectAssetsLiveEngine.getRegion(state.document));
  const view = url.searchParams.get('view') === 'list' ? 'list' : 'grid';
  syncProjectAssetsViewControl(state.document, form, view);

  const reset = state.projectAssetsFiltersReset;
  // Only a Reset load still in flight owns the current generation.
  if (!state.timer && reset?.generation === state.generation) {
    state.projectAssetsResetView = view;
    return false;
  }
  if (!state.timer && isProjectAssetsFiltersResetUrl(state.loadFailure?.url)) {
    state.projectAssetsResetView = view;
    return new URL(state.loadFailure.url.href);
  }

  let pendingUrl = null;
  if (state.timer) {
    pendingUrl = projectAssetsLiveEngine.url(form, state.window);
  } else if ((state.controller || state.loadFailure) && state.requestedUrl) {
    pendingUrl = new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href);
  } else if (state.assetNsfwPostPending && state.assetNsfwRefreshUrl) {
    pendingUrl = new URL(state.assetNsfwRefreshUrl.href);
  }
  // A Reset address no longer owned by any load (e.g. an NSFW refresh of
  // one) carries no restorable filters; the link's own address stands.
  if (isProjectAssetsFiltersResetUrl(pendingUrl)) return url;
  return applyToolbarView(url, pendingUrl);
}

/*
 * F7: the Reset's own response arrived and redirected to the address the
 * server restored from the effective defaults. With a View chosen during the
 * Reset, the same load continues at that address with only `view` replaced:
 * one GET, one history entry, the Reset lifecycle (prepared/installed or
 * failed, with a Retry that repeats the Reset) carried over unchanged. The
 * View is consumed here, so a continuation never continues again unless a
 * newer View click arrives while it is in flight.
 */
function followProjectAssetsResetView(state, finalUrl, requestedUrl) {
  const view = state.projectAssetsResetView;
  const reset = state.projectAssetsFiltersReset;
  if (!view || reset?.generation !== state.generation) return null;
  state.projectAssetsResetView = null;
  reset.view = view;
  // Another page (a redirect away) installs nothing and fails as usual.
  if (finalUrl.origin !== requestedUrl.origin || finalUrl.pathname !== requestedUrl.pathname
    || finalUrl.searchParams.get('view') === view) return null;
  const destination = new URL(finalUrl.href);
  destination.searchParams.set('view', view);
  destination.hash = '';
  state.projectAssetsResetContinuing = true;
  return destination;
}

// The dialog View is a native select joined to #asset-filters by form="…"
// (outside the form element), mirrored by its CreatorCrate dropdown.
function syncProjectAssetsViewControl(document, form, view) {
  const control = document?.querySelector?.('#asset-view-filter') || form?.querySelector?.('[name="view"]');
  if (!control || control.value === view) return;
  if (control.tagName === 'SELECT') {
    if (!Array.from(control.options || []).some((option) => option.value === view && !option.disabled)) return;
    control.value = view;
    syncCreatorCrateDropdownFromNative(control);
    // R3: the toolbar sends no change event, so the fields follow here.
    syncProjectAssetsViewDependentFields(document);
    return;
  }
  control.value = view;
}

const projectAssetsLiveEngine = createLiveRegionEngine({
  regionSelector: PROJECT_ASSETS_LIVE_REGION_SELECTOR,
  formSelector: PROJECT_ASSETS_FILTER_SELECTOR,
  formScope: 'document',
  searchSelector: PROJECT_ASSETS_SEARCH_SELECTOR,
  linkSelector: 'nav.view-switcher a, .pagination a, [data-project-assets-reset]',
  linkScope: 'document',
  linkDestination: projectAssetsViewLinkDestination,
  followResponse: followProjectAssetsResetView,
  debounceMs: PROJECT_ASSETS_LIVE_DEBOUNCE_MS,
  defaultAction: '/projects',
  stateKey: '__creatorCrateProjectAssetsLiveFiltering',
  historyState: { projectAssets: true },
  statusSelector: PROJECT_ASSETS_LIVE_STATUS_SELECTOR,
  statusStateAttribute: PROJECT_ASSETS_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading Project Assets.',
  fallbackMessage: 'Project Assets are loading as a full page.',
  responseErrorMessage: 'Project Assets response failed.',
  missingRegionMessage: 'Project Assets response did not contain the live region.',
  enhanceRegion: enhanceProjectAssetsLiveRegion,
  onFormChange(state, form, event) {
    updateInheritedProjectAssetsFilterDefaults(form, event);
    syncProjectAssetsInlineCategory(state.document);
  },
  transformParams: omitInheritedProjectAssetsFiltersForCategory,
  onResponseParsed(state, parsed, nextRegion) {
    const region = projectAssetsLiveEngine.getRegion(state.document);
    carryProjectAssetsSizeFallbacks(state, nextRegion);
    retainProjectAssetsOrderDraft(state, region);
    state.projectAssetsViewSelection = null;
    state.projectAssetsResetClearedSelection = null;
    // F7-R1: a Reset an owed mutation refresh carried installs as a Reset.
    const installsReset = state.projectAssetsFiltersReset?.generation === state.generation;
    // F7-R2a: an owed refresh reconciles by identity only when this install
    // is the refresh's own re-read (or its Retry), or a pure Grid/List change.
    // A newer genuine filter, page, Back/Forward or NSFW navigation that took
    // over the refresh still satisfies it (the mutated data installs), but
    // keeps its own selection boundary: the selection is cleared.
    // F7-R3: the refresh's own re-read of a newer navigation it adopted keeps
    // that navigation's clearing decision (a pure View change still carries).
    const pureView = projectAssetsPureViewChange(state, region, nextRegion);
    const ownsSelection = state.projectAssetsRefreshOwnerGeneration === state.generation
      && !state.projectAssetsRefreshClearsSelection;
    const reconcilesRefresh = state.projectAssetsRefreshOwed && !installsReset
      && (ownsSelection || pureView);
    if (state.projectAssetsRefreshOwed) state.projectAssetCategoriesNeedSync = true;
    if (reconcilesRefresh) {
      state.projectAssetsSnapshot = captureProjectAssetsTransientState(state, region);
    } else if (pureView) {
      // F10: only the Grid/List presentation changed, so the selection (shown
      // and retained) carries over by identity, as the user left it.
      state.projectAssetsViewSelection = captureAssetSelection(region);
    } else {
      // A user's filter navigation (Reset filters included, even one a
      // mutation refresh carried, and one that took over an owed refresh)
      // starts a new selection, as always; the owed refresh reports it.
      if (state.projectAssetsRefreshOwed) state.projectAssetsResetClearedSelection = captureAssetSelection(region);
      clearRetainedAssetSelection(state.document);
    }
    if (state.projectAssetCategoriesNeedSync) state.projectAssetCategoriesPage = parsed;
    const reset = state.projectAssetsFiltersReset;
    if (reset && reset.generation === state.generation) {
      reset.phase = 'prepared';
      announceProjectAssetsFiltersReset(state, reset, 'prepared', { parsed });
    }
    reconcileExternalFilterForm(state, parsed, '#asset-filters');
    reconcileProjectAssetsAssociatedFilterControls(state, parsed);
    reconcileProjectAssetsManualScanContext(state, parsed);
    if (state.projectAssetsRefreshOwed) reconcileProjectAssetsDependents(state, parsed);

    const currentResetForm = state.document?.querySelector?.(PROJECT_ASSETS_RESET_FORM_SELECTOR);
    const nextResetForm = parsed?.querySelector?.(PROJECT_ASSETS_RESET_FORM_SELECTOR);
    const nextResetAction = nextResetForm?.getAttribute?.('action');
    if (currentResetForm && nextResetAction !== null && nextResetAction !== undefined) {
      currentResetForm.setAttribute?.('action', nextResetAction);
    }

    const nextSequence = parsed.querySelector?.(PROJECT_ASSETS_VIEWER_SEQUENCE_SELECTOR);
    const currentSequence = state.document.querySelector?.(PROJECT_ASSETS_VIEWER_SEQUENCE_SELECTOR);
    if (nextSequence && currentSequence) currentSequence.textContent = nextSequence.textContent || '[]';

    const nextDefaultsReturn = parsed.querySelector?.('#project-assets-defaults-form input[name="returnTo"]');
    const currentDefaultsReturn = state.document.querySelector?.('#project-assets-defaults-form input[name="returnTo"]');
    if (nextDefaultsReturn && currentDefaultsReturn) {
      currentDefaultsReturn.value = nextDefaultsReturn.value || '';
      const dialog = currentDefaultsReturn.closest?.('[data-app-dialog]');
      const dialogState = dialog?.__creatorCrateAppDialogState;
      if (dialogState?.savedValues) dialogState.savedValues.returnTo = currentDefaultsReturn.value;
    }
  },
  onCreate(state, region) {
    state.projectAssetsDefaultsRefreshGeneration = null;
    state.projectAssetsDefaultsRefreshError = null;
    state.projectAssetsDefaultsRefreshComplete = null;
    state.projectAssetsDefaultsRefreshFailureMessage = null;
    state.assetNsfwController = null;
    state.assetNsfwGeneration = 0;
    state.assetNsfwSubmitting = false;
    state.assetNsfwPostPending = false;
    state.assetNsfwRefreshUrl = null;
    state.assetNsfwNeedsRefresh = false;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwRegionReplaced = false;
    state.assetNsfwEnabled = projectAssetsRenderedNsfwEnabled(region);
    state.projectAssetsRefreshOwed = false;
    // F7-R2a: the load generation that is the owed refresh's own re-read of
    // the installed context (or its GET-only Retry). Any other generation is
    // a newer user navigation with its own selection boundary.
    state.projectAssetsRefreshOwnerGeneration = null;
    // F7-R3: the owed refresh re-reads a newer navigation that already
    // decided to clear the selection; settled with the owed refresh.
    state.projectAssetsRefreshClearsSelection = false;
    state.projectAssetsRefreshWaiter = null;
    state.projectAssetsRefreshRecoveries = [];
    state.projectAssetsSnapshot = null;
    state.projectAssetsReconciliation = null;
    state.projectAssetsOrderDrafts = new Map();
    state.projectAssetsCarriedSizeFallbacks = {};
    state.projectAssetsSizeRetentionPredates = null;
    state.projectAssetsFiltersReset = null;
    state.projectAssetsFiltersResetId = 0;
    // F7: the View chosen for a pending (or failed, Retry-able) Reset, and
    // whether the next load start is that Reset's followed continuation.
    state.projectAssetsResetView = null;
    state.projectAssetsResetContinuing = false;
    // F7-R1: the in-flight Reset a starting mutation refresh carries, held
    // only from that refresh's invalidation until its load starts; and the
    // selection such a Reset install cleared, held until it is reported.
    state.projectAssetsResetCarried = null;
    state.projectAssetsResetClearedSelection = null;
    // F10: the selection a pure Grid/List install carries over, held only
    // between that response's parse and its installation.
    state.projectAssetsViewSelection = null;
    enhanceDropdowns(state.document);
    bindProjectAssetsAssociatedFilterControls(state);
    // R3: the server rendered the fields for its View; a View select the
    // browser restored (form-state restoration) is reconciled the same way.
    syncProjectAssetsViewDependentFields(state.document);
  },
  onBindRegion(state, region) {
    bindProjectAssetsNsfwForm(state, region);
  },
  onInvalidate(state) {
    // A Reset not yet installed loses to the newer load about to start,
    // unless that load is a mutation refresh carrying it (F7-R1).
    if (!state.projectAssetsResetCarried || state.projectAssetsResetCarried !== state.projectAssetsFiltersReset) {
      settleProjectAssetsFiltersReset(state, 'superseded');
    }
    // The caller learns its GET lost. projectAssetsRefreshOwed stays set, so
    // the next install (rendered after the mutation) reconciles and clears it.
    settleProjectAssetsRefresh(state, 'superseded');
    if (state.projectAssetsDefaultsRefreshGeneration !== null) {
      state.projectAssetsDefaultsRefreshGeneration = null;
      state.projectAssetsDefaultsRefreshError = null;
      state.projectAssetsDefaultsRefreshComplete = null;
      state.projectAssetsDefaultsRefreshFailureMessage = null;
    }
    if (state.assetNsfwPostPending) {
      state.assetNsfwGeneration += 1;
      state.assetNsfwController?.abort?.();
      state.assetNsfwController = null;
      state.assetNsfwPostPending = false;
      state.assetNsfwRefreshUrl = null;
      state.assetNsfwSubmitting = false;
      state.assetNsfwNeedsRefresh = false;
      updateProjectAssetsNsfwControls(
        projectAssetsLiveEngine.getRegion(state.document),
        state.assetNsfwPreviousEnabled,
      );
    }
    if (state.assetNsfwRefreshGeneration !== null) {
      state.assetNsfwNeedsRefresh = true;
      state.assetNsfwRefreshGeneration = null;
    }
  },
  onLoadStart(state, generation, url) {
    const continuing = state.projectAssetsResetContinuing;
    state.projectAssetsResetContinuing = false;
    const carried = state.projectAssetsResetCarried;
    state.projectAssetsResetCarried = null;
    if (carried && carried === state.projectAssetsFiltersReset && isProjectAssetsFiltersResetUrl(url)) {
      // F7-R1: the same Reset, now owned by the refresh's generation.
      carried.generation = generation;
      carried.phase = 'pending';
    } else if (isProjectAssetsFiltersResetUrl(url)) beginProjectAssetsFiltersReset(state, generation, url);
    // Any other navigation is newer intent than a Reset's View.
    else if (!continuing) state.projectAssetsResetView = null;
    // F7-R2a: a Retry of the refresh's own failed re-read stays its own.
    const retried = state.retryingLoadFailure;
    if (retried && retried.generation !== generation
      && retried.generation === state.projectAssetsRefreshOwnerGeneration) {
      state.projectAssetsRefreshOwnerGeneration = generation;
    }
    const refreshesNsfw = state.assetNsfwNeedsRefresh && !state.assetNsfwPostPending;
    if (refreshesNsfw) state.assetNsfwNeedsRefresh = false;
    if (refreshesNsfw) state.assetNsfwRefreshGeneration = generation;
  },
  onRegionReplaced(state, nextRegion) {
    const snapshot = state.projectAssetsSnapshot;
    state.projectAssetsSnapshot = null;
    if (snapshot) {
      state.projectAssetsReconciliation = restoreProjectAssetsTransientState(state, nextRegion, snapshot);
    } else {
      state.projectAssetsReconciliation = null;
      const viewSelection = state.projectAssetsViewSelection;
      state.projectAssetsViewSelection = null;
      if (viewSelection) restoreAssetSelection(nextRegion, viewSelection, projectAssetsMembership(nextRegion));
      const order = restoreProjectAssetsOrderDrafts(state, nextRegion);
      // F7-R1: an owed refresh satisfied by a Reset install reports that the
      // Reset started a new selection; order drafts reconcile as usual.
      const cleared = state.projectAssetsResetClearedSelection;
      state.projectAssetsResetClearedSelection = null;
      if (cleared) state.projectAssetsReconciliation = { selection: { restored: [], retained: [], removed: cleared }, order };
    }
    if (!state.assetNsfwSubmitting) return;
    state.assetNsfwRegionReplaced = true;
    const renderedEnabled = projectAssetsRenderedNsfwEnabled(nextRegion);
    state.assetNsfwEnabled = renderedEnabled;
    updateProjectAssetsNsfwControls(nextRegion, renderedEnabled, true);
  },
  onLoadComplete(state, generation, region) {
    const Event = state.window?.Event || globalThis.Event;
    if (typeof Event === 'function') state.document.dispatchEvent?.(new Event(PROJECT_ASSETS_REGION_LOADED_EVENT));
    if (state.projectAssetCategoriesNeedSync && state.projectAssetCategoriesPage) {
      // The region is installed by now, so a consumer's error is not a failed load.
      try {
        syncProjectAssetCategoryConsumers(state.document, state.projectAssetCategoriesPage);
      } catch { /* its options stay as they were */ }
      state.projectAssetCategoriesPage = null;
      state.projectAssetCategoriesNeedSync = false;
    }
    // Each install starts with an empty status, so this ends once none is held.
    if (state.projectAssetsOrderDrafts.size > 0) {
      projectAssetsLiveEngine.status(region, 'Your unsaved category order was kept, but it cannot be shown in this view.', null);
    }
    if (state.projectAssetsRefreshOwed) {
      const reconciliation = state.projectAssetsReconciliation;
      const recoveries = state.projectAssetsRefreshRecoveries;
      state.projectAssetsRefreshOwed = false;
      state.projectAssetsRefreshOwnerGeneration = null;
      state.projectAssetsRefreshClearsSelection = false;
      state.projectAssetsRefreshRecoveries = [];
      state.projectAssetsReconciliation = null;
      if (state.projectAssetsRefreshWaiter?.generation === generation) {
        settleProjectAssetsRefresh(state, 'installed', { reconciliation });
      }
      // Each refresh that reported 'failed' or 'superseded' learns it is satisfied.
      recoveries.forEach((recovery) => {
        if (recovery.generation !== generation) recovery.onRecovered(reconciliation);
      });
    }
    if (state.projectAssetsDefaultsRefreshGeneration === generation) {
      const notifyRefreshComplete = state.projectAssetsDefaultsRefreshComplete;
      state.projectAssetsDefaultsRefreshGeneration = null;
      state.projectAssetsDefaultsRefreshError = null;
      state.projectAssetsDefaultsRefreshComplete = null;
      state.projectAssetsDefaultsRefreshFailureMessage = null;
      notifyRefreshComplete?.();
    }
    settleProjectAssetsFiltersReset(state, 'installed', generation);
    if (state.assetNsfwRefreshGeneration !== generation) return;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwSubmitting = false;
    state.assetNsfwRegionReplaced = false;
    state.assetNsfwEnabled = projectAssetsRenderedNsfwEnabled(region);
    updateProjectAssetsNsfwControls(region, state.assetNsfwEnabled);
  },
  onLoadError(state, generation, error) {
    // F7: a failed Reset (or its continuation) keeps its View for the Retry,
    // unless a newer View click already replaced it.
    const reset = state.projectAssetsFiltersReset;
    if (reset?.generation === generation && reset.view && !state.projectAssetsResetView) {
      state.projectAssetsResetView = reset.view;
    }
    settleProjectAssetsFiltersReset(state, 'failed', generation);
    if (state.projectAssetsRefreshWaiter?.generation === generation) {
      settleProjectAssetsRefresh(state, 'failed', { error: error?.message || 'Project Assets refresh failed.' });
    }
    if (state.projectAssetsDefaultsRefreshGeneration === generation) {
      const notifyRefreshError = state.projectAssetsDefaultsRefreshError;
      const failureMessage = state.projectAssetsDefaultsRefreshFailureMessage
        || PROJECT_ASSETS_DEFAULTS_REFRESH_ERROR_MESSAGE;
      state.projectAssetsDefaultsRefreshGeneration = null;
      state.projectAssetsDefaultsRefreshError = null;
      state.projectAssetsDefaultsRefreshComplete = null;
      state.projectAssetsDefaultsRefreshFailureMessage = null;
      const region = projectAssetsLiveEngine.getRegion(state.document);
      region?.removeAttribute?.('aria-busy');
      projectAssetsLiveEngine.status(region, failureMessage, 'error');
      notifyRefreshError?.();
      // An owed mutation refresh keeps the shared GET-only Retry.
      return !state.projectAssetsRefreshOwed;
    }
    if (state.assetNsfwRefreshGeneration !== generation) return false;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwNeedsRefresh = false;
    state.assetNsfwSubmitting = false;
    state.assetNsfwRegionReplaced = false;
    const region = projectAssetsLiveEngine.getRegion(state.document);
    updateProjectAssetsNsfwControls(region, state.assetNsfwEnabled);
    region?.removeAttribute?.('aria-busy');
    projectAssetsLiveEngine.status(region, 'NSFW filter changed, but Project Assets could not refresh. Refresh the page to see updated previews.', 'error');
    return !state.projectAssetsRefreshOwed;
  },
  isCurrentUrl(url) {
    return /^\/projects\/[1-9]\d*\/assets$/.test(url.pathname);
  },
  responseMatches: sameResponsePath,
  loadFailureMessage: liveFilterFailureMessage('Project Assets'),
});

export function enhanceProjectAssetsLiveFiltering(scope = globalThis.document) {
  const enhanced = projectAssetsLiveEngine.enhance(scope);
  const document = liveRegionDocument(scope);
  if (enhanced && document && !isEnhancementBound(document, 'projectAssetCategoryRefreshBound')) {
    markEnhancementBound(document, 'projectAssetCategoryRefreshBound');
    document.addEventListener?.(PROJECT_ASSET_CATEGORIES_CHANGED, () => {
      const state = document.__creatorCrateProjectAssetsLiveFiltering;
      if (state) state.projectAssetCategoriesNeedSync = true;
      refreshProjectAssetsLiveRegion(document);
    });
  }
  return enhanced;
}

function startProjectAssetsMutationRefresh(scope, onRecovered = null, staleNavigation = false) {
  const document = liveRegionDocument(scope);
  const region = projectAssetsLiveEngine.getRegion(document);
  if (!document || !region) return null;
  // Even when no refresh can start, the old links stay unsafe to follow.
  if (staleNavigation) disableProjectAssetsStaleLinks(region);

  projectAssetsLiveEngine.enhance(document);
  const state = document.__creatorCrateProjectAssetsLiveFiltering;
  const form = projectAssetsLiveEngine.getForm(region);
  if (!state || !form || !projectAssetsLiveEngine.capabilities(state.window)) return null;

  // The refresh keeps the latest intended view: a debounced filter still owes
  // its navigation, an in-flight filter keeps its history mode, and load()
  // promotes a failed filter's. An idle page keeps its view and history entry.
  // F7-R1: a Reset filters still in flight (its own GET or its View
  // continuation) is not newer intent the mutation outdates: the refresh
  // carries it. It re-reads the Reset address, so the server resolves the
  // saved defaults against the mutated data, keeps the Reset's latest View,
  // and the same Reset (id and edit boundary) completes at this install. A
  // failed Reset is re-read the same way, as its Retry would.
  const reset = state.projectAssetsFiltersReset;
  let url;
  let historyMode = 'none';
  let carriedReset = null;
  // F7-R3: selection ownership is separate from data ownership. While an
  // earlier refresh is still owed, a navigation the user started since (a
  // debounced, in-flight or failed filter/Search that is not that refresh's
  // own re-read) has already decided to clear the selection. This refresh
  // re-reads that navigation's destination and keeps its decision, as does
  // any later refresh re-reading this one. A navigation pending with no
  // refresh owed is adopted under WP09A and keeps the selection by identity.
  const owed = state.projectAssetsRefreshOwed;
  let adoptsNewerNavigation = false;
  try {
    if (!state.timer && state.controller && reset?.generation === state.generation) {
      url = new URL(reset.url, state.window.location?.href || reset.url);
      historyMode = state.requestedHistoryMode || 'none';
      carriedReset = reset;
    } else if (!state.timer && !state.controller && isProjectAssetsFiltersResetUrl(state.loadFailure?.url)) {
      url = new URL(state.loadFailure.url.href);
    } else if (state.timer) {
      url = projectAssetsLiveEngine.url(form, state.window);
      historyMode = 'push';
      // Typed after the owed refresh began (which cancelled any earlier timer).
      adoptsNewerNavigation = owed;
    } else if ((state.controller || state.loadFailure) && state.requestedUrl) {
      url = new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href);
      if (state.controller) historyMode = state.requestedHistoryMode || 'none';
      const adopted = state.controller ? state.generation : state.loadFailure?.generation;
      adoptsNewerNavigation = owed && adopted !== state.projectAssetsRefreshOwnerGeneration;
    } else {
      url = projectAssetsLiveEngine.url(form, state.window, { preservePage: true });
    }
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
  } catch {
    return null;
  }

  if (carriedReset) {
    // The latest View chosen for it (a click during the continuation is newer).
    state.projectAssetsResetView = state.projectAssetsResetView || carriedReset.view || null;
    state.projectAssetsResetCarried = carriedReset;
  }
  // The decision outlives each superseded refresh until an install settles it.
  const clearsSelection = (owed && state.projectAssetsRefreshClearsSelection) || adoptsNewerNavigation;
  projectAssetsLiveEngine.invalidate(state);
  state.projectAssetsRefreshOwed = true;
  // F7-R2a: this generation is the refresh's own install (it keeps the
  // selection by identity, as the established refresh contract does for an
  // adopted pending navigation too). A later navigation is newer intent.
  state.projectAssetsRefreshOwnerGeneration = state.generation;
  state.projectAssetsRefreshClearsSelection = clearsSelection;
  if (typeof onRecovered === 'function') {
    state.projectAssetsRefreshRecoveries.push({ generation: state.generation, onRecovered });
  }
  const completion = new Promise((resolve) => {
    state.projectAssetsRefreshWaiter = { generation: state.generation, url, resolve };
  });
  projectAssetsLiveEngine.load(state, url, historyMode, form);
  // A load that could not start does not keep the Reset it was to carry.
  if (state.projectAssetsResetCarried) {
    state.projectAssetsResetCarried = null;
    settleProjectAssetsFiltersReset(state, 'superseded');
  }
  return completion;
}

/**
 * Reload the Project Assets live region using its active filter form. This is
 * intentionally shared with non-browser callers that mutate project files,
 * so the current query and presentation state remain authoritative.
 * Returns whether the GET started, never whether content installed; a caller
 * that reports synchronization uses refreshProjectAssetsAfterMutation.
 */
export function refreshProjectAssetsLiveRegion(scope = globalThis.document) {
  return startProjectAssetsMutationRefresh(scope) !== null;
}

/**
 * Re-read Project Assets after an acknowledged mutation, keeping the user's
 * transient state by asset identity. Only ever issues GETs. Resolves once with
 * { status, url, ... }, never rejects:
 * - 'installed': this GET's region is installed, state reconciled, controls
 *   bound; { reconciliation: { selection, order } } says what survived.
 * - 'failed': the page is unchanged and shows the shared GET-only Retry.
 * - 'superseded': a newer load took over. The next load to install satisfies
 *   the refresh and reconciles the same state; a failure there shows Retry.
 * - 'unavailable': no refresh could start on this page.
 * onRecovered(reconciliation) runs if a later Retry or newer load satisfies a
 * refresh that had reported 'failed' or 'superseded'.
 * staleNavigation: the mutation made the region's rendered page and view links
 * obsolete, so they are unavailable until a newer region installs (F7).
 */
export function refreshProjectAssetsAfterMutation(
  scope = globalThis.document,
  { onRecovered = null, staleNavigation = false } = {},
) {
  return startProjectAssetsMutationRefresh(scope, onRecovered, staleNavigation === true)
    || Promise.resolve({ status: 'unavailable', url: null });
}

/**
 * Correction D (F6): after an acknowledged defaults reset whose effective
 * size defaults are now nextDefaults.gridSize / nextDefaults.listSize, keeps
 * the size fallbacks this page displays for every later region install. It
 * never writes browser storage. Returns whether the page could retain them.
 */
export function retainProjectAssetsDisplayedSizes(scope = globalThis.document, nextDefaults = {}) {
  const document = liveRegionDocument(scope);
  const region = projectAssetsLiveEngine.getRegion(document);
  if (!document || !region) return false;
  projectAssetsLiveEngine.enhance(document);
  const state = document.__creatorCrateProjectAssetsLiveFiltering;
  if (!state?.projectAssetsCarriedSizeFallbacks) return false;
  PROJECT_ASSETS_SIZE_FALLBACKS.forEach(({ key, attribute, config }) => {
    const rendered = nextDefaults?.[key];
    if (!gridSizeIsValid(rendered, config)) return;
    const displayed = projectAssetsRenderedSizeFallback(region, attribute, config);
    if (displayed === rendered) delete state.projectAssetsCarriedSizeFallbacks[key];
    else state.projectAssetsCarriedSizeFallbacks[key] = { displayed, rendered };
  });
  // Correction E (F6): a load in flight now was requested before the reset.
  state.projectAssetsSizeRetentionPredates = state.controller ? state.generation : null;
  return true;
}

/**
 * Correction E (F6): an acknowledged Save or scope activation is a newer
 * authority for the sizes it carries than any reset before it, even when its
 * size equals the post-reset default (which rendered defaults cannot tell
 * apart), so it ends their retention. The acknowledged sizes themselves are
 * applied by syncProjectAssetsSizePreferences, as before.
 */
export function releaseProjectAssetsRetainedSizes(scope = globalThis.document, acknowledged = {}) {
  const state = liveRegionDocument(scope)?.__creatorCrateProjectAssetsLiveFiltering;
  const carried = state?.projectAssetsCarriedSizeFallbacks;
  if (!carried) return false;
  PROJECT_ASSETS_SIZE_FALLBACKS.forEach(({ key, config }) => {
    if (gridSizeIsValid(acknowledged?.[key], config)) delete carried[key];
  });
  if (!carried.gridSize && !carried.listSize) state.projectAssetsSizeRetentionPredates = null;
  return true;
}

/**
 * Package B: the Reset filters load that owns the live region now, or null.
 * { id, generation, url, phase: 'pending' | 'prepared' }. While it is set the
 * live controls still show the pre-Reset state, so nothing may capture them
 * as the restored defaults (Save) or start a competing defaults operation.
 */
export function projectAssetsFiltersResetPending(scope = globalThis.document) {
  const reset = liveRegionDocument(scope)?.__creatorCrateProjectAssetsLiveFiltering?.projectAssetsFiltersReset;
  return reset ? { ...reset } : null;
}

/**
 * F12: whether the shared GET-only Retry on screen now repeats a failed Reset
 * filters GET. Any newer load or filter change supersedes that Retry (the
 * engine clears its load failure), so a failed Reset's ownership ends with it.
 */
export function projectAssetsFiltersResetRetryAvailable(scope = globalThis.document) {
  const state = liveRegionDocument(scope)?.__creatorCrateProjectAssetsLiveFiltering;
  if (!state || state.projectAssetsFiltersReset) return false;
  try {
    return isProjectAssetsFiltersResetUrl(state.loadFailure?.url);
  } catch {
    return false;
  }
}

export function isProjectAssetsLoadInFlight(scope = globalThis.document) {
  return Boolean(liveRegionDocument(scope)?.__creatorCrateProjectAssetsLiveFiltering?.controller);
}

export function beginProjectAssetsDefaultsLiveRefresh(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  const region = projectAssetsLiveEngine.getRegion(document);
  if (!document || !region) return null;

  projectAssetsLiveEngine.enhance(document);
  const state = document.__creatorCrateProjectAssetsLiveFiltering;
  if (!state || !projectAssetsLiveEngine.capabilities(state.window)) return null;

  if (state.projectAssetsDefaultsRefreshGeneration !== null) {
    projectAssetsLiveEngine.invalidate(state);
  }
  return state.generation;
}

function projectAssetsGridStyleIsValid(gridStyle) {
  return gridStyle === 'uncropped' || gridStyle === 'cropped';
}

// The one in-place restyle of the rendered Project Assets grid. List view has
// no grid, so there is nothing to restyle until a Grid render installs.
function setProjectAssetsGridStyle(region, gridStyle) {
  const grid = region?.querySelector?.('.asset-grid');
  if (!grid || !projectAssetsGridStyleIsValid(gridStyle)) return false;
  grid.setAttribute?.('data-grid-style', gridStyle);
  return true;
}

/** The Grid style the rendered Project Assets grid shows now, or null. */
export function projectAssetsRenderedGridStyle(scope = globalThis.document) {
  const region = liveRegionDocument(scope)?.querySelector?.(PROJECT_ASSETS_LIVE_REGION_SELECTOR);
  const gridStyle = region?.querySelector?.('.asset-grid')?.getAttribute?.('data-grid-style');
  return projectAssetsGridStyleIsValid(gridStyle) ? gridStyle : null;
}

/**
 * Applies a current Grid style choice to the rendered grid in place. It is
 * presentation only: no load, no navigation and no write, so it is safe while
 * a load is pending (the caller applies it again once that load installs).
 */
export function restyleProjectAssetsGrid(scope = globalThis.document, gridStyle) {
  const region = liveRegionDocument(scope)?.querySelector?.(PROJECT_ASSETS_LIVE_REGION_SELECTOR);
  return setProjectAssetsGridStyle(region, gridStyle);
}

export function refreshProjectAssetsDefaultsLiveRegion(
  scope = globalThis.document,
  destination,
  authorityGeneration,
  { onComplete = null, onError = null, gridStyle = null, failureMessage = null } = {},
) {
  const document = liveRegionDocument(scope);
  const region = projectAssetsLiveEngine.getRegion(document);
  const state = document?.__creatorCrateProjectAssetsLiveFiltering;
  if (!document || !region || !state || !projectAssetsLiveEngine.capabilities(state.window)) return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  // A save that changed only the acknowledged grid style restyles the rendered
  // grid in place so selection, pending reorder, and card state survive. An
  // in-flight load may predate the save, so it still takes the full refresh.
  if (projectAssetsGridStyleIsValid(gridStyle) && !state.controller) {
    setProjectAssetsGridStyle(region, gridStyle);
    clearResolvedProjectAssetsDefaultsRefreshError(state, region);
    return 'applied';
  }

  let url;
  try {
    url = new URL(destination, state.window.location?.href || '/projects');
  } catch {
    return 'unavailable';
  }
  if (!projectAssetsLiveEngine.capabilities(state.window)
    || !/^\/projects\/[1-9]\d*\/assets$/.test(url.pathname)) return 'unavailable';

  if (state.timer) state.window.clearTimeout?.(state.timer);
  state.timer = null;
  projectAssetsLiveEngine.invalidate(state);
  state.projectAssetsDefaultsRefreshGeneration = state.generation;
  state.projectAssetsDefaultsRefreshError = typeof onError === 'function' ? onError : null;
  // Fires only once this refresh's region is installed; failure or a newer
  // load clears it, so 'started' never implies the content was rendered.
  state.projectAssetsDefaultsRefreshComplete = typeof onComplete === 'function' ? onComplete : null;
  state.projectAssetsDefaultsRefreshFailureMessage = typeof failureMessage === 'string' ? failureMessage : null;
  projectAssetsLiveEngine.load(
    state,
    url,
    'replace',
    projectAssetsLiveEngine.getForm(projectAssetsLiveEngine.getRegion(document)),
  );
  return 'started';
}

const PROJECT_ASSETS_PRESENTATION_DEFAULT_KEYS = Object.freeze(['view', 'sort', 'order', 'pageSize']);
const PROJECT_ASSETS_FILTER_DEFAULT_KEYS = Object.freeze(['tag', 'extension']);

function projectAssetsFilterDefaultMembers(value) {
  const members = Array.isArray(value) ? value : [value];
  return members.map((member) => String(member ?? '')).filter((member) => member !== '' && member !== 'all');
}

// WP6: applies an activated scope's resolved defaults to the intended view
// with the server's own provenance rules (buildAssetDefaultsRedirectUrl and
// materializeSuspendedInheritedFilterDefaults): Category, Search, Show,
// Usage and page stay as they are; presentation keys take the loaded values;
// a restricting Tag/Extension default is marked inherited, and under a
// concrete Category it stays suspended (marked, not applied) so it returns
// when All Categories is chosen. An unrestricted default carries no marker.
function applyProjectAssetsDefaultsToParams(params, values, { filterDefaults = true } = {}) {
  PROJECT_ASSETS_PRESENTATION_DEFAULT_KEYS.forEach((key) => {
    if (typeof values?.[key] === 'string' && values[key] !== '') params.set(key, values[key]);
  });
  params.delete('notice');
  // WP7: a combined-dialog Save persisted the Tag/Extension already shown, so
  // the current filter (explicit or inherited) stays exactly as it is.
  if (!filterDefaults) return;
  const concreteCategory = /^[1-9]\d*$/.test(params.get('category') || '');
  const inherited = [];
  PROJECT_ASSETS_FILTER_DEFAULT_KEYS.forEach((key) => {
    params.delete(key);
    const members = projectAssetsFilterDefaultMembers(values?.[key]);
    if (members.length === 0) return;
    inherited.push(key);
    if (!concreteCategory) members.forEach((member) => params.append(key, member));
  });
  params.delete('inheritedFilterDefaults');
  if (inherited.length > 0) params.set('inheritedFilterDefaults', inherited.join(','));
  params.delete('notice');
}

function projectAssetsParamsKey(url) {
  return [...url.searchParams.entries()]
    .filter(([key]) => key !== 'notice')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('&');
}

export const PROJECT_ASSETS_DEFAULTS_SAVE_REFRESH_ERROR_MESSAGE = PROJECT_ASSETS_DEFAULTS_REFRESH_ERROR_MESSAGE;

// WP7: a combined-dialog Save persisted the values the page already shows, so
// the view itself does not change; only server-rendered presentation (Grid
// style, size fallbacks, and links built against the saved defaults) does. It
// re-reads the latest intended view through the post-mutation refresh, which
// keeps selection, category-order drafts, focus and scroll. That refresh puts
// back the old Grid style, so the saved one is applied once it installs.
function refreshProjectAssetsAfterCombinedSave(document, values, { onComplete = null, onError = null } = {}) {
  const installed = () => {
    setProjectAssetsGridStyle(projectAssetsLiveEngine.getRegion(document), values?.gridStyle);
    onComplete?.();
  };
  // A newer load (or a Retry) that satisfies a superseded or failed refresh
  // was rendered after the Save too, so it completes the Save the same way.
  const pending = startProjectAssetsMutationRefresh(document, installed);
  if (!pending) return 'unavailable';
  pending.then((result) => {
    if (result?.status === 'installed') {
      installed();
    } else if (result?.status === 'failed') {
      onError?.();
    }
  });
  return 'started';
}

/**
 * WP6: reloads Project Assets for acknowledged loaded defaults (a scope
 * activation, or an explicit Save's acknowledged effective values).
 * The base view is the latest intended one, as for a post-mutation refresh: a
 * debounced filter's form state, an in-flight or failed load's requested URL,
 * or the idle form with its current page. Only the eligible defaults are
 * replaced (applyProjectAssetsDefaultsToParams). Ownership is the same as a
 * Defaults save refresh: a newer load since authorityGeneration wins
 * ('superseded'), except for a combined-dialog Save (filterDefaults false),
 * which always reconciles the current view. When the view would not change, nothing is fetched: an
 * unchanged presentation reports 'applied', and a Grid style-only change
 * restyles in place. Returns refreshProjectAssetsDefaultsLiveRegion's outcomes.
 * failureMessage defaults to the activation wording; a Save passes its own.
 */
export function refreshProjectAssetsWithLoadedDefaults(
  scope = globalThis.document,
  authorityGeneration,
  values,
  {
    onComplete = null,
    onError = null,
    presentationUnchanged = false,
    gridStyle = null,
    failureMessage = PROJECT_ASSETS_DEFAULTS_ACTIVATION_REFRESH_ERROR_MESSAGE,
    filterDefaults = true,
  } = {},
) {
  const document = liveRegionDocument(scope);
  const region = projectAssetsLiveEngine.getRegion(document);
  const state = document?.__creatorCrateProjectAssetsLiveFiltering;
  const form = projectAssetsLiveEngine.getForm(region);
  if (!document || !region || !state || !form || !projectAssetsLiveEngine.capabilities(state.window)) return 'unavailable';
  if (!filterDefaults) {
    // Correction B (F3): a combined-dialog Save is an acknowledged mutation,
    // not a result to install. A filter change made while the POST was pending
    // (a newer generation) stays the current view, but its links were rendered
    // against the defaults as they were, so that view is still re-read against
    // the saved ones. The post-mutation refresh owns the base view (a debounced
    // form, an in-flight or failed request, or the idle form), never the
    // submitted snapshot, and stale responses still lose to its generation.
    // A Grid style-only Save still restyles in place, with no GET at all.
    if (gridStyle && !state.timer && !state.controller && !state.loadFailure) {
      return refreshProjectAssetsDefaultsLiveRegion(document, state.window.location?.href, state.generation, { gridStyle });
    }
    return refreshProjectAssetsAfterCombinedSave(document, values, { onComplete, onError });
  }
  if (state.generation !== authorityGeneration) return 'superseded';

  let base;
  try {
    if (state.timer) {
      base = projectAssetsLiveEngine.url(form, state.window);
    } else if ((state.controller || state.loadFailure) && state.requestedUrl) {
      base = new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href);
    } else {
      base = projectAssetsLiveEngine.url(form, state.window, { preservePage: true });
    }
  } catch {
    return 'unavailable';
  }
  const target = new URL(base.href);
  applyProjectAssetsDefaultsToParams(target.searchParams, values, { filterDefaults });

  const idle = !state.timer && !state.controller && !state.loadFailure;
  if (idle && projectAssetsParamsKey(base) === projectAssetsParamsKey(target)) {
    if (presentationUnchanged) return 'applied';
    if (gridStyle) {
      return refreshProjectAssetsDefaultsLiveRegion(document, target.href, authorityGeneration, { gridStyle });
    }
  }
  return refreshProjectAssetsDefaultsLiveRegion(document, target.href, authorityGeneration, {
    onComplete,
    onError,
    failureMessage,
  });
}

export function enhanceProjectsLiveFiltering(scope = globalThis.document) {
  return projectsLiveEngine.enhance(scope);
}

function projectsLiveState(scope) {
  const document = liveRegionDocument(scope);
  const region = projectsLiveEngine.getRegion(document);
  if (!document || !region) return null;
  projectsLiveEngine.enhance(document);
  const state = document.__creatorCrateProjectsLiveFiltering;
  if (!state || !projectsLiveEngine.capabilities(state.window)) return null;
  return state;
}

/**
 * WP10b read-only request state. `pending` covers an in-flight GET, a
 * debounced Search edit not yet requested, and an NSFW toggle that still owes
 * its refresh; `failed` means the installed results are not the latest
 * intent. `intendedUrl` is the latest intended destination: a debounced edit
 * (the filter form, as schedule() would push it), else the pending or failed
 * request, else the installed location.
 */
export function projectsLiveSnapshot(scope = globalThis.document) {
  const state = projectsLiveState(scope);
  if (!state) return null;
  const failedUrl = state.loadFailure?.url?.href ?? null;
  const pending = Boolean(state.projectsLoading || state.timer || state.nsfwSubmitting);
  const location = state.window?.location?.href ?? null;
  let debouncedUrl = null;
  if (state.timer) {
    try {
      debouncedUrl = projectsLiveEngine.url(
        projectsLiveEngine.getForm(projectsLiveEngine.getRegion(state.document)),
        state.window,
      )?.href ?? null;
    } catch {
      debouncedUrl = null;
    }
  }
  return {
    generation: state.generation,
    pending,
    failed: Boolean(state.loadFailure),
    failedUrl,
    requestedHistoryMode: debouncedUrl ? 'push' : state.requestedHistoryMode ?? null,
    intendedUrl: debouncedUrl || (pending && state.requestedUrl?.href) || failedUrl || location,
  };
}

export function subscribeProjectsLive(scope = globalThis.document, listener) {
  const state = projectsLiveState(scope);
  if (!state || typeof listener !== 'function') return null;
  state.projectsObservers.add(listener);
  return () => state.projectsObservers.delete(listener);
}

/**
 * WP10b canonical GET navigation through the one Projects engine: it
 * supersedes any older pending GET (or debounced edit) and returns the owning
 * generation. GET only; a failed load keeps the engine's GET-only Retry.
 */
export function navigateProjectsLive(scope = globalThis.document, destination, { historyMode = 'push' } = {}) {
  const state = projectsLiveState(scope);
  if (!state) return { status: 'unavailable' };
  let url;
  try {
    url = new URL(destination, state.window.location?.href || '/projects');
  } catch {
    return { status: 'unavailable' };
  }
  if (url.pathname !== '/projects') return { status: 'unavailable' };
  if (state.timer) state.window.clearTimeout?.(state.timer);
  state.timer = null;
  // F8: a new navigation (a new Reset filters included) drops an earlier
  // Reset's View.
  state.projectsResetView = null;
  projectsLiveEngine.invalidate(state);
  const generation = state.generation;
  projectsLiveEngine.load(
    state,
    url,
    ['push', 'replace', 'none'].includes(historyMode) ? historyMode : 'push',
    projectsLiveEngine.getForm(projectsLiveEngine.getRegion(state.document)),
  );
  return { status: 'started', generation };
}

export function beginProjectsDefaultsLiveRefresh(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  const region = projectsLiveEngine.getRegion(document);
  if (!document || !region) return null;

  projectsLiveEngine.enhance(document);
  const state = document.__creatorCrateProjectsLiveFiltering;
  if (!state || !projectsLiveEngine.capabilities(state.window)) return null;

  if (state.projectsDefaultsRefreshGeneration !== null) {
    projectsLiveEngine.invalidate(state);
  }
  return state.generation;
}

export function refreshProjectsLiveRegion(
  scope = globalThis.document,
  destination,
  authorityGeneration,
  { onError = null, onSuccess = null, failureMessage = null } = {},
) {
  const document = liveRegionDocument(scope);
  const region = projectsLiveEngine.getRegion(document);
  const state = document?.__creatorCrateProjectsLiveFiltering;
  if (!document || !region || !state || !projectsLiveEngine.capabilities(state.window)) return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  // A null destination keeps the Projects view as shown, taking over a
  // pending filter navigation rather than reverting it.
  const current = destination === null && (state.controller || state.loadFailure) && state.requestedUrl
    ? state.requestedUrl.href
    : destination ?? state.window.location?.href;
  let url;
  try {
    url = new URL(current, state.window.location?.href || '/projects');
  } catch {
    return 'unavailable';
  }
  if (!projectsLiveEngine.capabilities(state.window) || url.pathname !== '/projects') return 'unavailable';

  if (state.timer) state.window.clearTimeout?.(state.timer);
  state.timer = null;
  // F8: an explicit destination is newer intent; a null one takes over the
  // pending navigation, a pending Reset's View included.
  if (destination !== null) state.projectsResetView = null;
  projectsLiveEngine.invalidate(state);
  state.projectsDefaultsRefreshGeneration = state.generation;
  state.projectsDefaultsRefreshError = typeof onError === 'function' ? onError : null;
  state.projectsDefaultsRefreshFailureMessage = typeof failureMessage === 'string' ? failureMessage : null;
  // Fires only once this refresh's region is installed.
  state.projectsDefaultsRefreshSuccess = typeof onSuccess === 'function' ? onSuccess : null;
  projectsLiveEngine.load(
    state,
    url,
    'replace',
    projectsLiveEngine.getForm(projectsLiveEngine.getRegion(document)),
  );
  return 'started';
}

export function enhanceReleasesLiveFiltering(scope = globalThis.document) {
  return releasesLiveEngine.enhance(scope);
}

export function beginReleasesDefaultsLiveRefresh(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  const region = releasesLiveEngine.getRegion(document);
  if (!document || !region) return null;

  releasesLiveEngine.enhance(document);
  const state = document.__creatorCrateReleasesLiveFiltering;
  if (!state || !releasesLiveEngine.capabilities(state.window)) return null;

  if (state.releasesDefaultsRefreshGeneration !== null) {
    releasesLiveEngine.invalidate(state);
  }
  return state.generation;
}

export function refreshReleasesLiveRegion(
  scope = globalThis.document,
  destination,
  authorityGeneration,
  { onError = null, onSuccess = null, failureMessage = null } = {},
) {
  const document = liveRegionDocument(scope);
  const region = releasesLiveEngine.getRegion(document);
  const state = document?.__creatorCrateReleasesLiveFiltering;
  if (!document || !region || !state || !releasesLiveEngine.capabilities(state.window)) return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  // A null destination keeps the Releases view as shown, taking over a
  // pending filter navigation rather than reverting it.
  const current = destination === null && (state.controller || state.loadFailure) && state.requestedUrl
    ? state.requestedUrl.href
    : destination ?? state.window.location?.href;
  let url;
  try {
    url = new URL(current, state.window.location?.href || '/releases');
  } catch {
    return 'unavailable';
  }
  if (!releasesLiveEngine.capabilities(state.window) || url.pathname !== '/releases') return 'unavailable';

  if (state.timer) state.window.clearTimeout?.(state.timer);
  state.timer = null;
  releasesLiveEngine.invalidate(state);
  state.releasesDefaultsRefreshGeneration = state.generation;
  state.releasesDefaultsRefreshError = typeof onError === 'function' ? onError : null;
  state.releasesDefaultsRefreshFailureMessage = typeof failureMessage === 'string' ? failureMessage : null;
  // Fires only once this refresh's region is installed.
  state.releasesDefaultsRefreshSuccess = typeof onSuccess === 'function' ? onSuccess : null;
  releasesLiveEngine.load(
    state,
    url,
    'replace',
    releasesLiveEngine.getForm(releasesLiveEngine.getRegion(document)),
  );
  return 'started';
}

export function enhanceReleaseAssetsLiveFiltering(scope = globalThis.document) {
  return releaseAssetsLiveEngine.enhance(scope);
}

const ASSET_LIBRARY_LIVE_REGION_SELECTOR = '[data-asset-library-live-region]';
const ASSET_LIBRARY_FILTER_SELECTOR = '#asset-filters';
const ASSET_LIBRARY_RESET_FORM_SELECTOR = '.asset-viewer-filter-reset';
const ASSET_LIBRARY_LIVE_STATUS_SELECTOR = '[data-asset-library-live-status]';
const ASSET_LIBRARY_LIVE_STATE_ATTRIBUTE = 'data-asset-library-live-state';
const ASSET_LIBRARY_NSFW_FORM_SELECTOR = '[data-asset-library-nsfw-filter]';
const ASSET_LIBRARY_NSFW_TOGGLE_SELECTOR = '[data-asset-library-nsfw-toggle]';
const ASSET_LIBRARY_LIVE_DEBOUNCE_MS = 350;
// WP9b: the results Search of the combined Filters & Defaults dialog.
const ASSET_LIBRARY_SEARCH_SELECTOR = '#asset-library-search';
const ASSET_LIBRARY_DROPDOWN_SEARCH_SELECTOR = '#asset-filters [data-cc-dropdown-search]';

/*
 * WP9b NSFW refresh destination. The old filter form could only express one
 * Project and no Project Type, so rebuilding the refresh from it dropped
 * repeated selections. The refresh now uses the canonical filter state:
 *   - an in-flight or failed request: the URL it requested (its intent);
 *   - a debounced edit not yet requested: the filter form, which carries
 *     every repeated value (hidden-by-search choices included);
 *   - otherwise: the installed canonical location the server produced.
 * Repeated keys stay repeated; nothing is comma-joined or reduced to the
 * legacy scalar projectId alias.
 *
 * F1: an adopted destination also brings the navigation ownership it was
 * owed, so the installed results and the browser address agree:
 *   - a debounced edit would have pushed its URL ('push', as schedule());
 *   - an in-flight request keeps its own history mode;
 *   - a failed request is promoted to its recorded mode by load();
 *   - the installed location keeps its history entry ('none').
 * A push to the address already shown only reconciles it ('replace'), so the
 * refresh never adds a duplicate entry.
 *
 * F4: the serialized form URL can differ from the shown canonical address
 * even when the server canonicalizes it back to that address (an edit that
 * was undone within the debounce). The engine compares the FINAL canonical
 * response URL of every push with the shown address at installation (F6),
 * so such a refresh keeps the current entry.
 */
function assetLibraryNsfwRefreshTarget(state) {
  const base = state.window.location?.href;
  let url;
  let historyMode = 'none';
  if (state.timer) {
    url = assetLibraryLiveEngine.url(
      assetLibraryLiveEngine.getForm(assetLibraryLiveEngine.getRegion(state.document)),
      state.window,
    );
    historyMode = 'push';
  } else if (state.controller && state.libReset?.generation === state.generation) {
    // F9: a Reset filters (or its View continuation) in flight is refreshed
    // as that Reset, so the server re-resolves it and the View chosen for
    // it is applied again.
    url = new URL(state.libReset.url.href);
    if (!state.libResetView) state.libResetView = state.libReset.view;
    historyMode = state.requestedHistoryMode || 'none';
  } else if ((state.controller || state.loadFailure) && state.requestedUrl) {
    // A failed load is refreshed as what its Retry repeats (F9: a failed
    // Reset continuation repeats the Reset), so it keeps its owed entry.
    const failed = !state.controller && state.loadFailure?.url;
    url = new URL((failed || state.requestedUrl).href, base || state.requestedUrl.href);
    if (state.controller) historyMode = state.requestedHistoryMode || 'none';
  } else {
    url = new URL(base);
    url.hash = '';
    if (url.pathname !== '/asset-viewer') throw new Error('Asset Viewer location is unavailable.');
  }
  if (historyMode === 'push' && base) {
    const shown = new URL(base);
    shown.hash = '';
    if (shown.href === url.href) historyMode = 'replace';
  }
  return { url, historyMode };
}

/*
 * WP10b F4: a toolbar Grid/List link is rendered against the installed page,
 * so it knows nothing of a filter change that is still debounced, in flight,
 * failed, or held by the NSFW toggle. The clicked View is applied to the
 * latest intended filter destination, in the precedence the NSFW refresh
 * uses:
 *   - a debounced edit not yet requested: the filter form (every repeated
 *     Project / Project Type / Category / Tag / Extension value, hidden-by-
 *     search choices included);
 *   - an in-flight or failed GET: the URL it requested;
 *   - an NSFW POST still pending: the refresh destination it captured (which
 *     already adopted any debounced or pending edit);
 *   - otherwise (idle): the link's own canonical address.
 * The engine then supersedes the older load and pushes the View navigation.
 * The dialog's View control follows the click (no change event, no POST), so
 * a later filter edit and an explicit Save keep the chosen View.
 */
function assetLibraryViewLinkDestination(state, link, url) {
  // F9: the filtered-empty Reset link starts a new Reset without a View.
  if (link?.matches?.('[data-asset-library-reset]')) {
    state.libResetView = null;
    return url;
  }
  if (!link?.closest?.('nav.view-switcher')) return url;
  const form = assetLibraryLiveEngine.getForm(assetLibraryLiveEngine.getRegion(state.document));
  const view = url.searchParams.get('view') === 'list' ? 'list' : 'grid';
  syncProjectsViewControl(form, view);

  // F9: a Reset filters still in flight (or its View continuation) takes the
  // click as its View: the server's resolution is kept, nothing is aborted.
  const reset = state.libReset;
  if (!state.timer && reset?.generation === state.generation) {
    // Its final response is already installing: the View is applied to the
    // address the server resolved, as an ordinary View navigation.
    if (reset.installing) {
      if (reset.installing === view || !reset.canonical) return reset.installing === view ? false : url;
      return assetLibraryResetViewDestination(reset, view);
    }
    state.libResetView = view;
    return false;
  }
  // A failed Reset (or failed continuation) is re-requested with the View,
  // exactly like its Retry.
  if (!state.timer && isAssetLibraryFiltersResetUrl(state.loadFailure?.url)) {
    state.libResetView = view;
    return new URL(state.loadFailure.url.href);
  }

  let pendingUrl = null;
  if (state.timer) {
    pendingUrl = assetLibraryLiveEngine.url(form, state.window);
  } else if ((state.controller || state.loadFailure) && state.requestedUrl) {
    pendingUrl = new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href);
  } else if (state.libNsfwPostPending && state.libNsfwRefreshUrl) {
    pendingUrl = state.libNsfwRefreshUrl;
  }
  // An NSFW POST carrying a Reset: the click supersedes it (as any View
  // click does) and requests that Reset with the View.
  if (isAssetLibraryFiltersResetUrl(pendingUrl)) {
    state.libResetView = view;
    return new URL(pendingUrl.href);
  }
  return applyToolbarView(url, pendingUrl);
}

/*
 * Milestone 3 F9: Reset filters (?resetFilters=1, from the dialog through
 * navigateAssetLibraryLive or from the filtered-empty Reset link) is resolved
 * by the server from the effective saved defaults, ignoring any request-time
 * View, and its restored address is known only from its redirect. A toolbar
 * View click while it is in flight is recorded as the Reset's View (the
 * latest click wins) and the Reset keeps running. Its response then continues
 * the same load (engine followResponse: same generation, history mode and
 * Retry address) at the restored address with only the View replaced. A
 * View equal to the restored one costs no request. A failed Reset or failed
 * continuation keeps its View for Retry; a new Reset starts without one; any
 * other navigation drops it (onLoadStart). Nothing here writes defaults.
 */
function isAssetLibraryFiltersResetUrl(url) {
  return Boolean(url?.searchParams?.has?.('resetFilters'));
}

// The canonical address omits the application fallback View (Grid).
function assetLibraryUrlView(url) {
  return url?.searchParams?.get?.('view') === 'list' ? 'list' : 'grid';
}

// The server-restored address with `view` as the only override; the restored
// View itself is the restored address unchanged.
function assetLibraryResetViewDestination(reset, view) {
  const destination = new URL(reset.canonical.href);
  if (assetLibraryUrlView(reset.canonical) !== view) destination.searchParams.set('view', view);
  destination.hash = '';
  return destination;
}

function followAssetLibraryResetView(state, finalUrl, requestedUrl) {
  const reset = state.libReset;
  if (!reset || reset.generation !== state.generation) return null;
  const sameResource = finalUrl.origin === requestedUrl.origin && finalUrl.pathname === requestedUrl.pathname;
  if (isAssetLibraryFiltersResetUrl(requestedUrl) && sameResource && !isAssetLibraryFiltersResetUrl(finalUrl)) {
    reset.canonical = new URL(finalUrl.href);
    reset.canonical.hash = '';
  }
  const view = state.libResetView;
  // Another page (a redirect away) installs nothing and fails as usual.
  if (!view || !reset.canonical || !sameResource) {
    reset.installing = assetLibraryUrlView(finalUrl);
    return null;
  }
  state.libResetView = null;
  reset.view = view;
  if (assetLibraryUrlView(finalUrl) === view) {
    reset.installing = view;
    return null;
  }
  state.libResetContinuing = true;
  return assetLibraryResetViewDestination(reset, view);
}

// Drafts that live only in the dialog and must survive a reconciled filter
// form: the typed text of each dropdown's option search, and the raw results
// Search text when the server only normalized it (trimmed whitespace).
function captureAssetLibraryDialogDrafts(document) {
  return captureFilterDialogDrafts(document, ASSET_LIBRARY_DROPDOWN_SEARCH_SELECTOR, ASSET_LIBRARY_SEARCH_SELECTOR);
}

function restoreAssetLibraryDialogDrafts(document, drafts) {
  restoreFilterDialogDrafts(document, drafts, ASSET_LIBRARY_DROPDOWN_SEARCH_SELECTOR, ASSET_LIBRARY_SEARCH_SELECTOR);
}

// Shared by the combined Filters & Defaults dialogs (Asset Library, WP10b
// Projects): the drafts of a dialog's dropdown option searches and results
// Search that a reconciled filter form must not discard.
function captureFilterDialogDrafts(document, dropdownSearchSelector, resultsSearchSelector) {
  const searches = Array.from(document?.querySelectorAll?.(dropdownSearchSelector) || [])
    .map((input) => ({ id: input.id || input.getAttribute?.('id') || '', value: String(input.value ?? '') }))
    .filter((entry) => entry.id && entry.value !== '');
  const results = document?.querySelector?.(resultsSearchSelector);
  return {
    searches,
    results: results ? {
      value: String(results.value ?? ''),
      focused: document.activeElement === results,
      selectionStart: Number.isInteger(results.selectionStart) ? results.selectionStart : null,
      selectionEnd: Number.isInteger(results.selectionEnd) ? results.selectionEnd : null,
    } : null,
  };
}

function restoreFilterDialogDrafts(document, drafts, dropdownSearchSelector, resultsSearchSelector) {
  const EventConstructor = document?.defaultView?.Event || globalThis.Event;
  const searchInputs = Array.from(document?.querySelectorAll?.(dropdownSearchSelector) || []);
  drafts?.searches?.forEach(({ id, value }) => {
    const input = searchInputs.find((candidate) => (candidate.id || candidate.getAttribute?.('id')) === id);
    if (!input || String(input.value ?? '') !== '') return;
    input.value = value;
    if (typeof EventConstructor === 'function') input.dispatchEvent?.(new EventConstructor('input', { bubbles: true }));
  });
  const results = drafts?.results;
  const input = document?.querySelector?.(resultsSearchSelector);
  if (!results || !input) return;
  const rendered = String(input.value ?? '');
  if (rendered === results.value || rendered !== results.value.trim()) return;
  input.value = results.value;
  if (results.focused && results.selectionStart !== null && typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(results.selectionStart, results.selectionEnd ?? results.selectionStart);
  }
}

// WP9a: read-only request-lifecycle notifications for the Asset Library
// defaults transport (asset-library-filters-defaults.js). Phases are
// 'started', 'installed' (onLoadComplete: the region is installed and
// enhanced), 'failed' and 'superseded' (the generation was invalidated).
// A prepared response that fails to install reports 'failed', never
// 'installed'. Observers cannot change the engine's behaviour.
function notifyAssetLibraryLive(state, detail) {
  state.assetLibraryObservers?.forEach((listener) => {
    try {
      listener(detail);
    } catch {
      // A transport observer must never break live filtering.
    }
  });
}

function assetLibraryNsfwForm(region) {
  return region?.querySelector?.(ASSET_LIBRARY_NSFW_FORM_SELECTOR) || null;
}

function assetLibraryNsfwEnabled(form) {
  const value = form?.querySelector?.('[data-asset-library-nsfw-value]')?.value
    || form?.querySelector?.('[data-asset-library-nsfw-value]')?.getAttribute?.('value');
  return value === '1';
}

function assetLibraryRenderedNsfwEnabled(region) {
  return region?.querySelector?.(ASSET_LIBRARY_NSFW_TOGGLE_SELECTOR)?.getAttribute?.('aria-pressed') === 'true';
}

function updateAssetLibraryNsfwControls(scope, enabled, pending = false) {
  const controls = Array.from(scope?.querySelectorAll?.(ASSET_LIBRARY_NSFW_TOGGLE_SELECTOR) || []);
  const label = enabled ? 'Disable NSFW filter' : 'Enable NSFW filter';
  controls.forEach((control) => {
    control.disabled = pending;
    if (pending) control.setAttribute?.('disabled', '');
    else control.removeAttribute?.('disabled');
    control.setAttribute?.('aria-pressed', String(enabled));
    control.setAttribute?.('aria-label', label);
    control.setAttribute?.('data-tooltip', label);
  });
  scope?.querySelectorAll?.(ASSET_LIBRARY_NSFW_FORM_SELECTOR).forEach((form) => {
    const value = form.querySelector?.('[data-asset-library-nsfw-value]');
    if (value) value.value = enabled ? '0' : '1';
    if (pending) form.setAttribute?.('aria-busy', 'true');
    else form.removeAttribute?.('aria-busy');
  });
}

function submitAssetLibraryNsfwToggle(state, form, event) {
  if (!assetLibraryLiveEngine.capabilities(state.window)) return false;
  if (state.libNsfwSubmitting) {
    event.preventDefault?.();
    return true;
  }

  let refresh;
  try {
    refresh = assetLibraryNsfwRefreshTarget(state);
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
  } catch {
    return false;
  }

  event.preventDefault?.();
  assetLibraryLiveEngine.invalidate(state);
  state.libNsfwGeneration += 1;
  const generation = state.libNsfwGeneration;
  const enabled = assetLibraryNsfwEnabled(form);
  const previousEnabled = assetLibraryRenderedNsfwEnabled(assetLibraryLiveEngine.getRegion(state.document));
  state.libNsfwSubmitting = true;
  state.libNsfwPostPending = true;
  state.libNsfwNeedsRefresh = false;
  state.libNsfwRegionReplaced = false;
  state.libNsfwPreviousEnabled = previousEnabled;
  state.libNsfwEnabled = enabled;
  // F4: the destination a toolbar View link clicked during the POST adopts.
  state.libNsfwRefreshUrl = refresh.url;

  const controller = assetLibraryLiveEngine.controller(state.window);
  state.libNsfwController?.abort?.();
  state.libNsfwController = controller;
  let requestBody;
  try {
    requestBody = new state.window.URLSearchParams(new state.window.FormData(form));
    requestBody.set('enabled', enabled ? '1' : '0');
  } catch {
    state.libNsfwSubmitting = false;
    state.libNsfwPostPending = false;
    updateAssetLibraryNsfwControls(assetLibraryLiveEngine.getRegion(state.document), previousEnabled);
    assetLibraryLiveEngine.nativeSubmit(form);
    return true;
  }
  updateAssetLibraryNsfwControls(assetLibraryLiveEngine.getRegion(state.document), enabled, true);
  const options = {
    method: String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase(),
    body: requestBody,
    credentials: 'same-origin',
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  };
  if (controller) options.signal = controller.signal;

  let request;
  try {
    request = state.window.fetch(form.action || form.getAttribute?.('action'), options);
  } catch (error) {
    request = Promise.reject(error);
  }

  Promise.resolve(request)
    .then(async (response) => {
      if (!response?.ok) throw new Error('NSFW filter update failed.');
      const payload = typeof response.json === 'function' ? await response.json() : null;
      if (payload?.status !== 'success' || typeof payload.enabled !== 'boolean') {
        throw new Error('NSFW filter update failed.');
      }
      return payload;
    })
    .then((payload) => {
      if (generation !== state.libNsfwGeneration) return;
      state.libNsfwController = null;
      state.libNsfwPostPending = false;
      state.libNsfwEnabled = payload.enabled;
      state.libNsfwNeedsRefresh = true;
      assetLibraryLiveEngine.invalidate(state);
      updateAssetLibraryNsfwControls(assetLibraryLiveEngine.getRegion(state.document), payload.enabled, true);
      assetLibraryLiveEngine.load(
        state,
        refresh.url,
        refresh.historyMode,
        assetLibraryLiveEngine.getForm(assetLibraryLiveEngine.getRegion(state.document)),
      );
    })
    .catch(() => {
      if (generation !== state.libNsfwGeneration) return;
      state.libNsfwController = null;
      state.libNsfwPostPending = false;
      state.libNsfwSubmitting = false;
      state.libNsfwNeedsRefresh = false;
      const region = assetLibraryLiveEngine.getRegion(state.document);
      const enabledState = state.libNsfwRegionReplaced
        ? assetLibraryRenderedNsfwEnabled(region)
        : state.libNsfwPreviousEnabled;
      state.libNsfwEnabled = enabledState;
      state.libNsfwRegionReplaced = false;
      updateAssetLibraryNsfwControls(region, enabledState);
      region?.removeAttribute?.('aria-busy');
      assetLibraryLiveEngine.status(region, 'Could not update the NSFW filter. The previous setting was kept.', 'error');
    });

  return true;
}

function bindAssetLibraryNsfwForm(state, region) {
  const form = assetLibraryNsfwForm(region);
  if (!form || isEnhancementBound(form, 'assetLibraryNsfwBound')) return;
  markEnhancementBound(form, 'assetLibraryNsfwBound');
  form.addEventListener?.('submit', (event) => submitAssetLibraryNsfwToggle(state, form, event));
}

function enhanceAssetLibraryLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceNumberInputs(region);
  enhanceAssetGridSize(region);
  enhanceDropdowns(liveRegionDocument(region));
  enhanceAssetViewerFilterDisclosures(liveRegionDocument(region));
  enhanceAssetViewerInfoCards(region);
  enhanceDashboardTitleInfoCards(region);
  // Image previews and the Slideshow button open the unified viewer through
  // one delegated binding; a replaced region only reconciles an open viewer
  // with the sequence onResponseParsed has just copied in.
  refreshAssetLibraryViewer(region);
}

const assetLibraryLiveEngine = createLiveRegionEngine({
  regionSelector: ASSET_LIBRARY_LIVE_REGION_SELECTOR,
  formSelector: ASSET_LIBRARY_FILTER_SELECTOR,
  formScope: 'document',
  linkSelector: 'nav.view-switcher a, .pagination a, [data-asset-library-reset]',
  linkScope: 'document',
  searchSelector: ASSET_LIBRARY_SEARCH_SELECTOR,
  debounceMs: ASSET_LIBRARY_LIVE_DEBOUNCE_MS,
  defaultAction: '/asset-viewer',
  stateKey: '__creatorCrateAssetLibraryLiveFiltering',
  historyState: { assetLibrary: true },
  linkDestination: assetLibraryViewLinkDestination,
  followResponse: followAssetLibraryResetView,
  statusSelector: ASSET_LIBRARY_LIVE_STATUS_SELECTOR,
  statusStateAttribute: ASSET_LIBRARY_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading Asset Viewer.',
  fallbackMessage: 'Asset Viewer is loading as a full page.',
  responseErrorMessage: 'Asset Viewer response failed.',
  missingRegionMessage: 'Asset Viewer response did not contain the live region.',
  enhanceRegion: enhanceAssetLibraryLiveRegion,
  onResponseParsed(state, parsed) {
    const drafts = captureAssetLibraryDialogDrafts(state.document);
    reconcileExternalFilterForm(state, parsed, ASSET_LIBRARY_FILTER_SELECTOR);
    restoreAssetLibraryDialogDrafts(state.document, drafts);

    const currentResetForm = state.document?.querySelector?.(ASSET_LIBRARY_RESET_FORM_SELECTOR);
    const nextResetForm = parsed?.querySelector?.(ASSET_LIBRARY_RESET_FORM_SELECTOR);
    const nextResetAction = nextResetForm?.getAttribute?.('action');
    if (currentResetForm && nextResetAction !== null && nextResetAction !== undefined) {
      currentResetForm.setAttribute?.('action', nextResetAction);
    }

    const nextSequence = parsed.querySelector?.(ASSET_LIBRARY_VIEWER_SEQUENCE_SELECTOR);
    const currentSequence = state.document.querySelector?.(ASSET_LIBRARY_VIEWER_SEQUENCE_SELECTOR);
    if (nextSequence && currentSequence) currentSequence.textContent = nextSequence.textContent || '[]';

    const nextDefaultsReturn = parsed.querySelector?.('#asset-viewer-defaults-form input[name="returnTo"]');
    const currentDefaultsReturn = state.document.querySelector?.('#asset-viewer-defaults-form input[name="returnTo"]');
    if (nextDefaultsReturn && currentDefaultsReturn) {
      currentDefaultsReturn.value = nextDefaultsReturn.value || '';
      const dialog = state.document.getElementById?.('asset-viewer-defaults-dialog');
      const dialogState = dialog?.__creatorCrateAppDialogState;
      if (dialogState?.savedValues) dialogState.savedValues.returnTo = currentDefaultsReturn.value;
    }
  },
  onCreate(state, region) {
    state.assetViewerDefaultsRefreshGeneration = null;
    state.assetViewerDefaultsRefreshError = null;
    state.assetLibraryObservers = new Set();
    state.assetLibraryLoading = false;
    state.libNsfwController = null;
    state.libNsfwGeneration = 0;
    state.libNsfwSubmitting = false;
    state.libNsfwPostPending = false;
    state.libNsfwNeedsRefresh = false;
    state.libNsfwRefreshGeneration = null;
    state.libNsfwRefreshUrl = null;
    state.libNsfwRegionReplaced = false;
    state.libNsfwEnabled = assetLibraryRenderedNsfwEnabled(region);
    // F9: the Reset filters load in flight ({ generation, url, canonical,
    // view, installing }), the View chosen for a pending or failed Reset,
    // and whether the next load start is that Reset's View continuation.
    state.libReset = null;
    state.libResetView = null;
    state.libResetContinuing = false;
    enhanceDropdowns(state.document);
    enhanceAssetViewerFilterDisclosures(state.document);
  },
  onBindRegion(state, region) {
    bindAssetLibraryNsfwForm(state, region);
    bindViewDependentFields(state.document?.querySelector?.(ASSET_LIBRARY_FILTER_SELECTOR));
  },
  onInvalidate(state) {
    const supersededLoading = state.assetLibraryLoading;
    state.assetLibraryLoading = false;
    notifyAssetLibraryLive(state, {
      phase: 'superseded', generation: state.generation, loading: supersededLoading,
    });
    if (state.assetViewerDefaultsRefreshGeneration !== null) {
      state.assetViewerDefaultsRefreshGeneration = null;
      state.assetViewerDefaultsRefreshError = null;
    }
    if (state.libNsfwPostPending) {
      state.libNsfwGeneration += 1;
      state.libNsfwController?.abort?.();
      state.libNsfwController = null;
      state.libNsfwPostPending = false;
      state.libNsfwSubmitting = false;
      state.libNsfwNeedsRefresh = false;
      updateAssetLibraryNsfwControls(
        assetLibraryLiveEngine.getRegion(state.document),
        state.libNsfwPreviousEnabled,
      );
    }
    if (state.libNsfwRefreshGeneration !== null) {
      state.libNsfwNeedsRefresh = true;
      state.libNsfwRefreshGeneration = null;
    }
  },
  onLoadStart(state, generation, url) {
    const continuing = state.libResetContinuing;
    state.libResetContinuing = false;
    if (isAssetLibraryFiltersResetUrl(url)) {
      state.libReset = {
        generation, url: new URL(url.href), canonical: null, view: null, installing: null,
      };
    } else if (!continuing) {
      // Any other navigation is newer intent than a Reset's View.
      state.libReset = null;
      state.libResetView = null;
    }
    state.assetLibraryLoading = true;
    notifyAssetLibraryLive(state, { phase: 'started', generation, url: url?.href ?? null });
    const refreshesNsfw = state.libNsfwNeedsRefresh && !state.libNsfwPostPending;
    if (refreshesNsfw) state.libNsfwNeedsRefresh = false;
    if (refreshesNsfw) state.libNsfwRefreshGeneration = generation;
  },
  onRegionReplaced(state, nextRegion) {
    if (!state.libNsfwSubmitting) return;
    state.libNsfwRegionReplaced = true;
    const renderedEnabled = assetLibraryRenderedNsfwEnabled(nextRegion);
    state.libNsfwEnabled = renderedEnabled;
    updateAssetLibraryNsfwControls(nextRegion, renderedEnabled, true);
  },
  onLoadComplete(state, generation, region) {
    state.assetLibraryLoading = false;
    if (state.libReset?.generation === generation) state.libReset = null;
    notifyAssetLibraryLive(state, {
      phase: 'installed', generation, url: state.window?.location?.href ?? null,
    });
    if (state.assetViewerDefaultsRefreshGeneration === generation) {
      state.assetViewerDefaultsRefreshGeneration = null;
      state.assetViewerDefaultsRefreshError = null;
    }
    if (state.libNsfwRefreshGeneration !== generation) return;
    state.libNsfwRefreshGeneration = null;
    state.libNsfwSubmitting = false;
    state.libNsfwRegionReplaced = false;
    state.libNsfwEnabled = assetLibraryRenderedNsfwEnabled(region);
    updateAssetLibraryNsfwControls(region, state.libNsfwEnabled);
  },
  onLoadError(state, generation, error, form, url) {
    state.assetLibraryLoading = false;
    // F9: a failed Reset (or its continuation) keeps its View for the Retry,
    // unless a newer View click already replaced it.
    const reset = state.libReset;
    if (reset?.generation === generation) {
      if (reset.view && !state.libResetView) state.libResetView = reset.view;
      state.libReset = null;
    }
    notifyAssetLibraryLive(state, {
      phase: 'failed', generation, url: url?.href ?? null, aborted: error?.name === 'AbortError',
    });
    if (state.assetViewerDefaultsRefreshGeneration === generation) {
      const notifyRefreshError = state.assetViewerDefaultsRefreshError;
      state.assetViewerDefaultsRefreshGeneration = null;
      state.assetViewerDefaultsRefreshError = null;
      const region = assetLibraryLiveEngine.getRegion(state.document);
      region?.removeAttribute?.('aria-busy');
      assetLibraryLiveEngine.status(
        region,
        'Defaults were saved, but Asset Viewer could not refresh. Refresh the page to see the saved defaults.',
        'error',
      );
      notifyRefreshError?.();
      return true;
    }
    if (state.libNsfwRefreshGeneration !== generation) return false;
    state.libNsfwRefreshGeneration = null;
    state.libNsfwNeedsRefresh = false;
    state.libNsfwSubmitting = false;
    state.libNsfwRegionReplaced = false;
    const region = assetLibraryLiveEngine.getRegion(state.document);
    updateAssetLibraryNsfwControls(region, state.libNsfwEnabled);
    region?.removeAttribute?.('aria-busy');
    assetLibraryLiveEngine.status(region, 'NSFW filter changed, but the Asset Viewer could not refresh. Refresh the page to see updated previews.', 'error');
    return true;
  },
  isCurrentUrl(url) {
    return url.pathname === '/asset-viewer';
  },
  loadFailureMessage: liveFilterFailureMessage('Asset Viewer'),
});

export function enhanceAssetLibraryLiveFiltering(scope = globalThis.document) {
  return assetLibraryLiveEngine.enhance(scope);
}

function assetLibraryLiveState(scope) {
  const document = liveRegionDocument(scope);
  const region = assetLibraryLiveEngine.getRegion(document);
  if (!document || !region) return null;
  assetLibraryLiveEngine.enhance(document);
  const state = document.__creatorCrateAssetLibraryLiveFiltering;
  if (!state || !assetLibraryLiveEngine.capabilities(state.window)) return null;
  return state;
}

/**
 * WP9a read-only request state. `pending` covers an in-flight GET, a
 * debounced change not yet requested, and an NSFW toggle that still owes its
 * refresh; `failed` means the installed results are not the latest intent.
 * `intendedUrl` is the latest requested destination (pending or failed),
 * otherwise the installed location.
 */
export function assetLibraryLiveSnapshot(scope = globalThis.document) {
  const state = assetLibraryLiveState(scope);
  if (!state) return null;
  const failedUrl = state.loadFailure?.url?.href ?? null;
  const pending = Boolean(state.assetLibraryLoading || state.timer || state.libNsfwSubmitting);
  const location = state.window?.location?.href ?? null;
  // F3: a debounced edit not yet requested is the latest intention (the
  // filter form, as schedule() would push it), not the older request.
  let debouncedUrl = null;
  if (state.timer) {
    try {
      debouncedUrl = assetLibraryLiveEngine.url(
        assetLibraryLiveEngine.getForm(assetLibraryLiveEngine.getRegion(state.document)),
        state.window,
      )?.href ?? null;
    } catch {
      debouncedUrl = null;
    }
  }
  return {
    generation: state.generation,
    pending,
    failed: Boolean(state.loadFailure),
    failedUrl,
    requestedHistoryMode: debouncedUrl ? 'push' : state.requestedHistoryMode ?? null,
    intendedUrl: debouncedUrl || (pending && state.requestedUrl?.href) || failedUrl || location,
  };
}

export function subscribeAssetLibraryLive(scope = globalThis.document, listener) {
  const state = assetLibraryLiveState(scope);
  if (!state || typeof listener !== 'function') return null;
  state.assetLibraryObservers.add(listener);
  return () => state.assetLibraryObservers.delete(listener);
}

/**
 * WP9a canonical GET navigation through the one Asset Library engine: it
 * supersedes any older pending GET and returns the owning generation. GET
 * only; a failed load keeps the engine's GET-only Retry.
 */
export function navigateAssetLibraryLive(scope = globalThis.document, destination, { historyMode = 'push' } = {}) {
  const state = assetLibraryLiveState(scope);
  if (!state) return { status: 'unavailable' };
  let url;
  try {
    url = new URL(destination, state.window.location?.href || '/asset-viewer');
  } catch {
    return { status: 'unavailable' };
  }
  if (url.pathname !== '/asset-viewer') return { status: 'unavailable' };
  // F9: a new Reset filters starts without an earlier Reset's View.
  if (isAssetLibraryFiltersResetUrl(url)) state.libResetView = null;
  if (state.timer) state.window.clearTimeout?.(state.timer);
  state.timer = null;
  assetLibraryLiveEngine.invalidate(state);
  const generation = state.generation;
  assetLibraryLiveEngine.load(
    state,
    url,
    ['push', 'replace', 'none'].includes(historyMode) ? historyMode : 'push',
    assetLibraryLiveEngine.getForm(assetLibraryLiveEngine.getRegion(state.document)),
  );
  return { status: 'started', generation };
}

export function beginAssetViewerDefaultsLiveRefresh(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  const region = assetLibraryLiveEngine.getRegion(document);
  if (!document || !region) return null;

  assetLibraryLiveEngine.enhance(document);
  const state = document.__creatorCrateAssetLibraryLiveFiltering;
  if (!state || !assetLibraryLiveEngine.capabilities(state.window)) return null;

  if (state.assetViewerDefaultsRefreshGeneration !== null) {
    assetLibraryLiveEngine.invalidate(state);
  }
  return state.generation;
}

export function refreshAssetViewerLiveRegion(
  scope = globalThis.document,
  destination,
  authorityGeneration,
  { onError = null } = {},
) {
  const document = liveRegionDocument(scope);
  const region = assetLibraryLiveEngine.getRegion(document);
  const state = document?.__creatorCrateAssetLibraryLiveFiltering;
  if (!document || !region || !state || !assetLibraryLiveEngine.capabilities(state.window)) return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  let url;
  try {
    url = new URL(destination, state.window.location?.href || '/asset-viewer');
  } catch {
    return 'unavailable';
  }
  if (!assetLibraryLiveEngine.capabilities(state.window) || url.pathname !== '/asset-viewer') return 'unavailable';

  if (state.timer) state.window.clearTimeout?.(state.timer);
  state.timer = null;
  assetLibraryLiveEngine.invalidate(state);
  state.assetViewerDefaultsRefreshGeneration = state.generation;
  state.assetViewerDefaultsRefreshError = typeof onError === 'function' ? onError : null;
  assetLibraryLiveEngine.load(
    state,
    url,
    'replace',
    assetLibraryLiveEngine.getForm(assetLibraryLiveEngine.getRegion(document)),
  );
  return 'started';
}
