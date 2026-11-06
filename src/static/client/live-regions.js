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
  enhanceAssetViewerFilterDisclosures,
  enhanceDropdowns,
  enhanceProjectAssetCategoryFilter,
  initializeCreatorCrateDropdown,
  syncCreatorCrateDropdownFromNative,
} from './dropdowns.js';
import {
  enhanceAssetGridSize,
  enhanceAssetGridStyle,
  enhanceAssetListSize,
  enhanceProjectGridSize,
} from './size-preferences.js';
import {
  enhanceProjectAssetsPreviewSlideshow,
  enhanceSlideshow,
  SLIDESHOW_SCAFFOLD_SELECTOR,
  SLIDESHOW_SEQUENCE_SELECTOR,
} from './slideshow.js';
import { enhanceNotesCodeBlocks } from './notes-editor.js';
import { RELEASE_ARCHIVED_EVENT, RELEASE_DELETED_EVENT, RELEASE_EDIT_SAVED_EVENT } from './release-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';
const PROJECTS_LIVE_REGION_SELECTOR = '[data-projects-live-region]';
const PROJECTS_FILTER_SELECTOR = '#project-filters';
const PROJECTS_LIVE_STATUS_SELECTOR = '[data-projects-live-status]';
const PROJECTS_LIVE_STATE_ATTRIBUTE = 'data-projects-live-state';
const PROJECTS_NSFW_FORM_SELECTOR = '[data-projects-nsfw-filter]';
const PROJECTS_NSFW_TOGGLE_SELECTOR = '[data-projects-nsfw-toggle]';
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
  function reportLoadFailure(state, url, historyMode) {
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
    const failure = { url, historyMode, notice };
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
        load(state, failure.url, failure.historyMode, null);
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

  function loadError(state, generation, error, form, url, historyMode) {
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
      reportLoadFailure(state, url, historyMode);
      return;
    }
    if (error?.name === 'AbortError') return;
    const region = regionFor(state.document);
    region?.removeAttribute?.('aria-busy');
    status(region, fallbackMessage, 'error');
    fallback(state, form, url, historyMode === 'replace');
  }

  function load(state, url, requestedHistoryMode, form) {
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
      loadError(state, generation, error, form, url, historyMode);
      return;
    }

    Promise.resolve(request)
      .then((response) => {
        if (generation !== state.generation) return null;
        if (!response?.ok || typeof response.text !== 'function') {
          throw new Error(responseErrorMessage);
        }
        state.response = response;
        return response.text();
      })
      .then((responseText) => {
        if (responseText === null || generation !== state.generation) return;
        replaceRegion(state, responseText, url, historyMode);
      })
      .then(() => {
        if (generation !== state.generation) return;
        state.controller = null;
        const region = regionFor(state.document);
        region?.removeAttribute?.('aria-busy');
        if (region) status(region, '', null);
        bindForm(state);
        onLoadComplete?.(state, generation, region, engine);
      })
      .catch((error) => loadError(state, generation, error, form, url, historyMode));
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

function submitProjectsNsfwToggle(state, form, event) {
  if (!projectsLiveEngine.capabilities(state.window)) return false;
  if (state.nsfwSubmitting) {
    event.preventDefault?.();
    return true;
  }

  let refreshUrl;
  try {
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
    refreshUrl = (state.controller || state.loadFailure) && state.requestedUrl
      ? new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href)
      : projectsLiveEngine.url(
        projectsLiveEngine.getForm(projectsLiveEngine.getRegion(state.document)),
        state.window,
        { preservePage: true },
      );
  } catch {
    return false;
  }

  event.preventDefault?.();
  projectsLiveEngine.invalidate(state);
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
      projectsLiveEngine.invalidate(state);
      updateProjectsNsfwControls(projectsLiveEngine.getRegion(state.document), payload.enabled, true);
      projectsLiveEngine.load(
        state,
        refreshUrl,
        'none',
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
  defaultAction: '/projects',
  stateKey: '__creatorCrateProjectsLiveFiltering',
  historyState: { projects: true },
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
    state.nsfwController = null;
    state.nsfwGeneration = 0;
    state.nsfwSubmitting = false;
    state.nsfwPostPending = false;
    state.nsfwNeedsRefresh = false;
    state.nsfwRefreshGeneration = null;
    state.nsfwRegionReplaced = false;
    state.nsfwEnabled = projectLiveRenderedNsfwEnabled(region);
    enhanceDropdowns(state.document);
    enhanceAssetViewerFilterDisclosures(state.document);
  },
  onBindRegion(state, region) {
    bindProjectsNsfwForm(state, region);
  },
  onInvalidate(state) {
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
  onLoadStart(state, generation) {
    const refreshesNsfw = state.nsfwNeedsRefresh && !state.nsfwPostPending;
    if (refreshesNsfw) state.nsfwNeedsRefresh = false;
    if (refreshesNsfw) state.nsfwRefreshGeneration = generation;
  },
  onResponseParsed(state, parsed) {
    reconcileExternalFilterForm(state, parsed, PROJECTS_FILTER_SELECTOR);
  },
  onRegionReplaced(state, nextRegion) {
    if (!state.nsfwSubmitting) return;
    state.nsfwRegionReplaced = true;
    const renderedEnabled = projectLiveRenderedNsfwEnabled(nextRegion);
    state.nsfwEnabled = renderedEnabled;
    updateProjectsNsfwControls(nextRegion, renderedEnabled, true);
  },
  onLoadComplete(state, generation, region) {
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
  onLoadError(state, generation) {
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

function enhanceReleaseAssetsLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceAssetViewerInfoCards(region);
  enhanceDashboardTitleInfoCards(region);
  enhanceNumberInputs(region);
  enhanceAssetSelection(liveRegionDocument(region));
  enhanceAssetGridSize(region);
  enhanceAssetListSize(region);
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
  },
  onResponseParsed(state, parsed, nextRegion) {
    reconcileExternalFilterForm(state, parsed, RELEASE_ASSETS_LIVE_FILTER_SELECTOR);
    enhanceAssetViewerFilterDisclosures(state.document);
    updateReleaseAssetsAuthoritativeMembership(state, parsed, nextRegion);
  },
  onRegionReplaced(state, region) {
    syncReleaseAssetsSelectionFormAction(state);
    reconcileReleaseAssetsSelection(state, region);
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
  const category = params.get('category');
  if (!/^[1-9]\d*$/.test(category || '')) return;

  inheritedProjectAssetsFilterDefaults(form).forEach((key) => params.delete(key));
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

function settleProjectAssetsRefresh(state, status, details = {}) {
  const waiter = state.projectAssetsRefreshWaiter;
  if (!waiter) return;
  state.projectAssetsRefreshWaiter = null;
  waiter.resolve({ status, url: waiter.url.href, ...details });
}

const PROJECT_ASSETS_DEFAULTS_REFRESH_ERROR_MESSAGE = 'Defaults were saved, but Project Assets could not refresh. Refresh the page to see the saved defaults.';

// An in-place restyle reconciles the presentation, so a Defaults-refresh error
// it supersedes is obsolete. Any other status (NSFW or filter failures) and any
// content change the failed load still owed (NSFW, categories) keep the error.
function clearResolvedProjectAssetsDefaultsRefreshError(state, region) {
  const statusElement = region.querySelector?.(PROJECT_ASSETS_LIVE_STATUS_SELECTOR);
  if (region.getAttribute?.(PROJECT_ASSETS_LIVE_STATE_ATTRIBUTE) !== 'error'
    || statusElement?.textContent !== PROJECT_ASSETS_DEFAULTS_REFRESH_ERROR_MESSAGE) return;
  if (state.assetNsfwSubmitting || state.assetNsfwNeedsRefresh || state.assetNsfwRefreshGeneration !== null
    || state.projectAssetCategoriesNeedSync) return;
  projectAssetsLiveEngine.status(region, '', null);
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
  enhanceSlideshow(liveRegionDocument(region));
  enhanceProjectAssetsPreviewSlideshow(region);
}

const projectAssetsLiveEngine = createLiveRegionEngine({
  regionSelector: PROJECT_ASSETS_LIVE_REGION_SELECTOR,
  formSelector: PROJECT_ASSETS_FILTER_SELECTOR,
  formScope: 'document',
  searchSelector: PROJECT_ASSETS_SEARCH_SELECTOR,
  linkSelector: 'nav.view-switcher a, .pagination a, [data-project-assets-reset]',
  linkScope: 'document',
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
  },
  transformParams: omitInheritedProjectAssetsFiltersForCategory,
  onResponseParsed(state, parsed) {
    const region = projectAssetsLiveEngine.getRegion(state.document);
    retainProjectAssetsOrderDraft(state, region);
    if (state.projectAssetsRefreshOwed) {
      state.projectAssetsSnapshot = captureProjectAssetsTransientState(state, region);
      state.projectAssetCategoriesNeedSync = true;
    } else {
      // A user's filter navigation starts a new selection, as always.
      clearRetainedAssetSelection(state.document);
    }
    if (state.projectAssetCategoriesNeedSync) state.projectAssetCategoriesPage = parsed;
    reconcileExternalFilterForm(state, parsed, '#asset-filters');
    reconcileProjectAssetsManualScanContext(state, parsed);
    if (state.projectAssetsRefreshOwed) reconcileProjectAssetsDependents(state, parsed);

    const currentResetForm = state.document?.querySelector?.(PROJECT_ASSETS_RESET_FORM_SELECTOR);
    const nextResetForm = parsed?.querySelector?.(PROJECT_ASSETS_RESET_FORM_SELECTOR);
    const nextResetAction = nextResetForm?.getAttribute?.('action');
    if (currentResetForm && nextResetAction !== null && nextResetAction !== undefined) {
      currentResetForm.setAttribute?.('action', nextResetAction);
    }

    const nextSequence = parsed.querySelector?.(`${SLIDESHOW_SCAFFOLD_SELECTOR} ${SLIDESHOW_SEQUENCE_SELECTOR}`);
    const currentSequence = state.document.querySelector?.(
      `${SLIDESHOW_SCAFFOLD_SELECTOR} ${SLIDESHOW_SEQUENCE_SELECTOR}`,
    );
    if (nextSequence && currentSequence) currentSequence.textContent = nextSequence.textContent || '[]';

    const nextDefaultsReturn = parsed.querySelector?.('#project-assets-defaults-form input[name="returnTo"]');
    const currentDefaultsReturn = state.document.querySelector?.('#project-assets-defaults-form input[name="returnTo"]');
    if (nextDefaultsReturn && currentDefaultsReturn) {
      currentDefaultsReturn.value = nextDefaultsReturn.value || '';
      const dialog = state.document.getElementById?.('project-assets-defaults-dialog');
      const dialogState = dialog?.__creatorCrateAppDialogState;
      if (dialogState?.savedValues) dialogState.savedValues.returnTo = currentDefaultsReturn.value;
    }
  },
  onCreate(state, region) {
    state.projectAssetsDefaultsRefreshGeneration = null;
    state.projectAssetsDefaultsRefreshError = null;
    state.projectAssetsDefaultsRefreshComplete = null;
    state.assetNsfwController = null;
    state.assetNsfwGeneration = 0;
    state.assetNsfwSubmitting = false;
    state.assetNsfwPostPending = false;
    state.assetNsfwNeedsRefresh = false;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwRegionReplaced = false;
    state.assetNsfwEnabled = projectAssetsRenderedNsfwEnabled(region);
    state.projectAssetsRefreshOwed = false;
    state.projectAssetsRefreshWaiter = null;
    state.projectAssetsRefreshRecoveries = [];
    state.projectAssetsSnapshot = null;
    state.projectAssetsReconciliation = null;
    state.projectAssetsOrderDrafts = new Map();
    enhanceDropdowns(state.document);
  },
  onBindRegion(state, region) {
    bindProjectAssetsNsfwForm(state, region);
  },
  onInvalidate(state) {
    // The caller learns its GET lost. projectAssetsRefreshOwed stays set, so
    // the next install (rendered after the mutation) reconciles and clears it.
    settleProjectAssetsRefresh(state, 'superseded');
    if (state.projectAssetsDefaultsRefreshGeneration !== null) {
      state.projectAssetsDefaultsRefreshGeneration = null;
      state.projectAssetsDefaultsRefreshError = null;
      state.projectAssetsDefaultsRefreshComplete = null;
    }
    if (state.assetNsfwPostPending) {
      state.assetNsfwGeneration += 1;
      state.assetNsfwController?.abort?.();
      state.assetNsfwController = null;
      state.assetNsfwPostPending = false;
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
  onLoadStart(state, generation) {
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
      restoreProjectAssetsOrderDrafts(state, nextRegion);
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
      notifyRefreshComplete?.();
    }
    if (state.assetNsfwRefreshGeneration !== generation) return;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwSubmitting = false;
    state.assetNsfwRegionReplaced = false;
    state.assetNsfwEnabled = projectAssetsRenderedNsfwEnabled(region);
    updateProjectAssetsNsfwControls(region, state.assetNsfwEnabled);
  },
  onLoadError(state, generation, error) {
    if (state.projectAssetsRefreshWaiter?.generation === generation) {
      settleProjectAssetsRefresh(state, 'failed', { error: error?.message || 'Project Assets refresh failed.' });
    }
    if (state.projectAssetsDefaultsRefreshGeneration === generation) {
      const notifyRefreshError = state.projectAssetsDefaultsRefreshError;
      state.projectAssetsDefaultsRefreshGeneration = null;
      state.projectAssetsDefaultsRefreshError = null;
      state.projectAssetsDefaultsRefreshComplete = null;
      const region = projectAssetsLiveEngine.getRegion(state.document);
      region?.removeAttribute?.('aria-busy');
      projectAssetsLiveEngine.status(region, PROJECT_ASSETS_DEFAULTS_REFRESH_ERROR_MESSAGE, 'error');
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

function startProjectAssetsMutationRefresh(scope, onRecovered = null) {
  const document = liveRegionDocument(scope);
  const region = projectAssetsLiveEngine.getRegion(document);
  if (!document || !region) return null;

  projectAssetsLiveEngine.enhance(document);
  const state = document.__creatorCrateProjectAssetsLiveFiltering;
  const form = projectAssetsLiveEngine.getForm(region);
  if (!state || !form || !projectAssetsLiveEngine.capabilities(state.window)) return null;

  // The refresh keeps the latest intended view: a debounced filter still owes
  // its navigation, an in-flight filter keeps its history mode, and load()
  // promotes a failed filter's. An idle page keeps its view and history entry.
  let url;
  let historyMode = 'none';
  try {
    if (state.timer) {
      url = projectAssetsLiveEngine.url(form, state.window);
      historyMode = 'push';
    } else if ((state.controller || state.loadFailure) && state.requestedUrl) {
      url = new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href);
      if (state.controller) historyMode = state.requestedHistoryMode || 'none';
    } else {
      url = projectAssetsLiveEngine.url(form, state.window, { preservePage: true });
    }
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
  } catch {
    return null;
  }

  projectAssetsLiveEngine.invalidate(state);
  state.projectAssetsRefreshOwed = true;
  if (typeof onRecovered === 'function') {
    state.projectAssetsRefreshRecoveries.push({ generation: state.generation, onRecovered });
  }
  const completion = new Promise((resolve) => {
    state.projectAssetsRefreshWaiter = { generation: state.generation, url, resolve };
  });
  projectAssetsLiveEngine.load(state, url, historyMode, form);
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
 */
export function refreshProjectAssetsAfterMutation(scope = globalThis.document, { onRecovered = null } = {}) {
  return startProjectAssetsMutationRefresh(scope, onRecovered)
    || Promise.resolve({ status: 'unavailable', url: null });
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

export function refreshProjectAssetsDefaultsLiveRegion(
  scope = globalThis.document,
  destination,
  authorityGeneration,
  { onComplete = null, onError = null, gridStyle = null } = {},
) {
  const document = liveRegionDocument(scope);
  const region = projectAssetsLiveEngine.getRegion(document);
  const state = document?.__creatorCrateProjectAssetsLiveFiltering;
  if (!document || !region || !state || !projectAssetsLiveEngine.capabilities(state.window)) return 'unavailable';
  if (state.generation !== authorityGeneration) return 'superseded';

  // A save that changed only the acknowledged grid style restyles the rendered
  // grid in place so selection, pending reorder, and card state survive. An
  // in-flight load may predate the save, so it still takes the full refresh.
  if ((gridStyle === 'uncropped' || gridStyle === 'cropped') && !state.controller) {
    region.querySelector?.('.asset-grid')?.setAttribute?.('data-grid-style', gridStyle);
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
  projectAssetsLiveEngine.load(
    state,
    url,
    'replace',
    projectAssetsLiveEngine.getForm(projectAssetsLiveEngine.getRegion(document)),
  );
  return 'started';
}

export function enhanceProjectsLiveFiltering(scope = globalThis.document) {
  return projectsLiveEngine.enhance(scope);
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

  let refreshUrl;
  try {
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
    refreshUrl = (state.controller || state.loadFailure) && state.requestedUrl
      ? new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href)
      : assetLibraryLiveEngine.url(
        assetLibraryLiveEngine.getForm(assetLibraryLiveEngine.getRegion(state.document)),
        state.window,
        { preservePage: true },
      );
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
        refreshUrl,
        'none',
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
  enhanceSlideshow(liveRegionDocument(region));
  enhanceProjectAssetsPreviewSlideshow(region);
}

const assetLibraryLiveEngine = createLiveRegionEngine({
  regionSelector: ASSET_LIBRARY_LIVE_REGION_SELECTOR,
  formSelector: ASSET_LIBRARY_FILTER_SELECTOR,
  formScope: 'document',
  linkSelector: 'nav.view-switcher a, .pagination a, [data-asset-library-reset]',
  linkScope: 'document',
  debounceMs: ASSET_LIBRARY_LIVE_DEBOUNCE_MS,
  defaultAction: '/asset-viewer',
  stateKey: '__creatorCrateAssetLibraryLiveFiltering',
  historyState: { assetLibrary: true },
  statusSelector: ASSET_LIBRARY_LIVE_STATUS_SELECTOR,
  statusStateAttribute: ASSET_LIBRARY_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading Asset Viewer.',
  fallbackMessage: 'Asset Viewer is loading as a full page.',
  responseErrorMessage: 'Asset Viewer response failed.',
  missingRegionMessage: 'Asset Viewer response did not contain the live region.',
  enhanceRegion: enhanceAssetLibraryLiveRegion,
  onResponseParsed(state, parsed) {
    reconcileExternalFilterForm(state, parsed, ASSET_LIBRARY_FILTER_SELECTOR);

    const currentResetForm = state.document?.querySelector?.(ASSET_LIBRARY_RESET_FORM_SELECTOR);
    const nextResetForm = parsed?.querySelector?.(ASSET_LIBRARY_RESET_FORM_SELECTOR);
    const nextResetAction = nextResetForm?.getAttribute?.('action');
    if (currentResetForm && nextResetAction !== null && nextResetAction !== undefined) {
      currentResetForm.setAttribute?.('action', nextResetAction);
    }

    const nextSequence = parsed.querySelector?.(`${SLIDESHOW_SCAFFOLD_SELECTOR} ${SLIDESHOW_SEQUENCE_SELECTOR}`);
    const currentSequence = state.document.querySelector?.(
      `${SLIDESHOW_SCAFFOLD_SELECTOR} ${SLIDESHOW_SEQUENCE_SELECTOR}`,
    );
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
    state.libNsfwController = null;
    state.libNsfwGeneration = 0;
    state.libNsfwSubmitting = false;
    state.libNsfwPostPending = false;
    state.libNsfwNeedsRefresh = false;
    state.libNsfwRefreshGeneration = null;
    state.libNsfwRegionReplaced = false;
    state.libNsfwEnabled = assetLibraryRenderedNsfwEnabled(region);
    enhanceDropdowns(state.document);
    enhanceAssetViewerFilterDisclosures(state.document);
  },
  onBindRegion(state, region) {
    bindAssetLibraryNsfwForm(state, region);
  },
  onInvalidate(state) {
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
  onLoadStart(state, generation) {
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
  onLoadError(state, generation) {
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
