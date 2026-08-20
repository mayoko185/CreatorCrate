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
  enhanceAssetAutoRenameOrdering,
  enhanceAssetRenames,
  enhanceAssetSelection,
} from './asset-ordering.js';
import { enhanceConfirmations } from './category-details.js';
import {
  enhanceAssetViewerInfoCards,
  enhanceProjectInfoCards,
} from './info-cards.js';
import { enhanceNumberInputs } from './number-input.js';
import {
  enhanceAssetViewerFilterDisclosures,
  enhanceDropdowns,
  enhanceProjectAssetCategoryFilter,
} from './dropdowns.js';
import {
  enhanceAssetGridSize,
  enhanceAssetListSize,
  enhanceProjectGridSize,
} from './size-preferences.js';
import {
  enhanceProjectAssetsPreviewSlideshow,
  enhanceSlideshow,
  SLIDESHOW_SCAFFOLD_SELECTOR,
  SLIDESHOW_SEQUENCE_SELECTOR,
} from './slideshow.js';
const PROJECTS_LIVE_REGION_SELECTOR = '[data-projects-live-region]';
const PROJECTS_FILTER_SELECTOR = '#project-filters';
const PROJECTS_LIVE_STATUS_SELECTOR = '[data-projects-live-status]';
const PROJECTS_LIVE_STATE_ATTRIBUTE = 'data-projects-live-state';
const PROJECTS_NSFW_FORM_SELECTOR = '[data-projects-nsfw-filter]';
const PROJECTS_NSFW_TOGGLE_SELECTOR = '[data-projects-nsfw-toggle]';
const RELEASES_LIVE_REGION_SELECTOR = '[data-releases-live-region]';
const RELEASES_FILTER_SELECTOR = '[data-releases-filter]';
const RELEASES_SEARCH_SELECTOR = '[data-releases-search]';
const RELEASES_LIVE_STATUS_SELECTOR = '[data-releases-live-status]';
const RELEASES_LIVE_STATE_ATTRIBUTE = 'data-releases-live-state';
const RELEASES_LIVE_DEBOUNCE_MS = 350;

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
  const controls = Array.from(region.querySelectorAll?.('input, select, textarea, button, summary') || []);
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
}

export function createLiveRegionEngine(config) {
  const {
    regionSelector,
    formSelector,
    linkSelector = null,
    searchSelector = null,
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
    isCurrentUrl = () => true,
  } = config || {};

  function regionFor(scope) {
    if (scope?.matches?.(regionSelector)) return scope;
    return scope?.querySelector?.(regionSelector) || null;
  }

  function formFor(region) {
    const selectors = Array.isArray(formSelector) ? formSelector : [formSelector];
    for (const selector of selectors) {
      const form = region?.querySelector?.(selector);
      if (form) return form;
    }
    return null;
  }

  function formsFor(region) {
    const selectors = Array.isArray(formSelector) ? formSelector : [formSelector];
    return selectors.flatMap((selector) => Array.from(region?.querySelectorAll?.(selector) || []));
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

  function replaceRegion(state, responseText, requestedUrl, historyMode) {
    const document = state.document;
    const windowObject = state.window;
    const parser = new windowObject.DOMParser();
    const parsed = parser.parseFromString(responseText, 'text/html');
    const nextRegion = parsed.querySelector?.(regionSelector);
    const currentRegion = regionFor(document);
    if (!nextRegion || !currentRegion || !currentRegion.parentNode) {
      throw new Error(missingRegionMessage);
    }

    onResponseParsed?.(state, parsed, nextRegion, engine);

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

  function loadError(state, generation, error, form, url, historyMode) {
    if (generation !== state.generation) return;
    state.controller = null;
    if (onLoadError?.(state, generation, error, form, url, historyMode, engine) === true) return;
    if (error?.name === 'AbortError') return;
    const region = regionFor(state.document);
    region?.removeAttribute?.('aria-busy');
    status(region, fallbackMessage, 'error');
    fallback(state, form, url, historyMode === 'replace');
  }

  function load(state, url, historyMode, form) {
    const generation = state.generation;
    const currentRegion = regionFor(state.document);
    if (!currentRegion) return;
    state.region = currentRegion;
    state.response = null;
    state.requestedUrl = url;
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
        if (!event.target?.name && !event.target?.getAttribute?.('name')) return;
        schedule(state, form);
      });
      if (searchSelector) {
        form.querySelector?.(searchSelector)?.addEventListener?.('input', () => {
          schedule(state, form, debounceMs);
        });
      }
      form.addEventListener?.('submit', (event) => {
        event.preventDefault?.();
        schedule(state, form);
      });
    });

    if (linkSelector) {
      region.querySelectorAll?.(linkSelector).forEach((link) => {
        if (isEnhancementBound(link, 'liveRegionLinkBound')) return;
        markEnhancementBound(link, 'liveRegionLinkBound');
        link.addEventListener?.('click', (event) => {
          if (event.defaultPrevented || event.button !== 0
            || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (!capabilities(state.window)) return;
          const href = link.href || link.getAttribute?.('href');
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
        engine,
      };
      document[stateKey] = state;
      enhanceRegion(region, state);
      onCreate?.(state, region, engine);
      windowObject.addEventListener?.('popstate', () => handlePopstate(state));
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
    load,
  };

  return engine;
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
    refreshUrl = state.controller && state.requestedUrl
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
  onRegionReplaced(state, nextRegion) {
    if (!state.nsfwSubmitting) return;
    state.nsfwRegionReplaced = true;
    const renderedEnabled = projectLiveRenderedNsfwEnabled(nextRegion);
    state.nsfwEnabled = renderedEnabled;
    updateProjectsNsfwControls(nextRegion, renderedEnabled, true);
  },
  onLoadComplete(state, generation, region) {
    if (state.nsfwRefreshGeneration !== generation) return;
    state.nsfwRefreshGeneration = null;
    state.nsfwSubmitting = false;
    state.nsfwRegionReplaced = false;
    state.nsfwEnabled = projectLiveRenderedNsfwEnabled(region);
    updateProjectsNsfwControls(region, state.nsfwEnabled);
  },
  onLoadError(state, generation) {
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
});

const releasesLiveEngine = createLiveRegionEngine({
  regionSelector: RELEASES_LIVE_REGION_SELECTOR,
  formSelector: RELEASES_FILTER_SELECTOR,
  linkSelector: 'nav[aria-label="View"] a[data-releases-view-link], .pagination a, [data-releases-reset]',
  searchSelector: RELEASES_SEARCH_SELECTOR,
  debounceMs: RELEASES_LIVE_DEBOUNCE_MS,
  defaultAction: '/releases',
  stateKey: '__creatorCrateReleasesLiveFiltering',
  historyState: { releases: true },
  statusSelector: RELEASES_LIVE_STATUS_SELECTOR,
  statusStateAttribute: RELEASES_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading releases.',
  fallbackMessage: 'Releases are loading as a full page.',
  responseErrorMessage: 'Releases response failed.',
  missingRegionMessage: 'Releases response did not contain the live region.',
  enhanceRegion() {},
  isCurrentUrl(url) {
    return url.pathname === '/releases';
  },
});

const PROJECT_ASSETS_LIVE_REGION_SELECTOR = '[data-project-assets-live-region]';
const PROJECT_ASSETS_FILTER_SELECTOR = ['#asset-filters', '.page-size-form'];
const PROJECT_ASSETS_SEARCH_SELECTOR = '#search';
const PROJECT_ASSETS_LIVE_STATUS_SELECTOR = '[data-project-assets-live-status]';
const PROJECT_ASSETS_LIVE_STATE_ATTRIBUTE = 'data-project-assets-live-state';
const PROJECT_ASSETS_NSFW_FORM_SELECTOR = '[data-project-assets-nsfw-filter]';
const PROJECT_ASSETS_NSFW_TOGGLE_SELECTOR = '[data-project-assets-nsfw-toggle]';
const PROJECT_ASSETS_LIVE_DEBOUNCE_MS = 350;

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
    refreshUrl = state.controller && state.requestedUrl
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
    });

  return true;
}

function bindProjectAssetsNsfwForm(state, region) {
  const form = projectAssetsNsfwForm(region);
  if (!form || isEnhancementBound(form, 'projectAssetsNsfwBound')) return;
  markEnhancementBound(form, 'projectAssetsNsfwBound');
  form.addEventListener?.('submit', (event) => submitProjectAssetsNsfwToggle(state, form, event));
}

function enhanceProjectAssetsLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceNumberInputs(region);
  enhanceAssetSelection(region);
  enhanceAssetRenames(region);
  enhanceAssetGridSize(region);
  enhanceAssetListSize(region);
  enhanceAssetAutoRenameOrdering(region);
  enhanceConfirmations(region);
  enhanceProjectAssetCategoryFilter(region);
  enhanceDropdowns(liveRegionDocument(region));
  enhanceSlideshow(liveRegionDocument(region));
  enhanceProjectAssetsPreviewSlideshow(region);
}

const projectAssetsLiveEngine = createLiveRegionEngine({
  regionSelector: PROJECT_ASSETS_LIVE_REGION_SELECTOR,
  formSelector: PROJECT_ASSETS_FILTER_SELECTOR,
  searchSelector: PROJECT_ASSETS_SEARCH_SELECTOR,
  linkSelector: 'nav.view-switcher a, .pagination a, [data-project-assets-reset]',
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
  onResponseParsed(state, parsed) {
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
    state.assetNsfwController = null;
    state.assetNsfwGeneration = 0;
    state.assetNsfwSubmitting = false;
    state.assetNsfwPostPending = false;
    state.assetNsfwNeedsRefresh = false;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwRegionReplaced = false;
    state.assetNsfwEnabled = projectAssetsRenderedNsfwEnabled(region);
    enhanceDropdowns(state.document);
  },
  onBindRegion(state, region) {
    bindProjectAssetsNsfwForm(state, region);
  },
  onInvalidate(state) {
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
    if (!state.assetNsfwSubmitting) return;
    state.assetNsfwRegionReplaced = true;
    const renderedEnabled = projectAssetsRenderedNsfwEnabled(nextRegion);
    state.assetNsfwEnabled = renderedEnabled;
    updateProjectAssetsNsfwControls(nextRegion, renderedEnabled, true);
  },
  onLoadComplete(state, generation, region) {
    if (state.assetNsfwRefreshGeneration !== generation) return;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwSubmitting = false;
    state.assetNsfwRegionReplaced = false;
    state.assetNsfwEnabled = projectAssetsRenderedNsfwEnabled(region);
    updateProjectAssetsNsfwControls(region, state.assetNsfwEnabled);
  },
  onLoadError(state, generation) {
    if (state.assetNsfwRefreshGeneration !== generation) return false;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwNeedsRefresh = false;
    state.assetNsfwSubmitting = false;
    state.assetNsfwRegionReplaced = false;
    const region = projectAssetsLiveEngine.getRegion(state.document);
    updateProjectAssetsNsfwControls(region, state.assetNsfwEnabled);
    region?.removeAttribute?.('aria-busy');
    projectAssetsLiveEngine.status(region, 'NSFW filter changed, but Project Assets could not refresh. Refresh the page to see updated previews.', 'error');
    return true;
  },
  isCurrentUrl(url) {
    return /^\/projects\/[1-9]\d*\/assets$/.test(url.pathname);
  },
});

export function enhanceProjectAssetsLiveFiltering(scope = globalThis.document) {
  return projectAssetsLiveEngine.enhance(scope);
}

/**
 * Reload the Project Assets live region using its active filter form. This is
 * intentionally shared with non-browser callers that mutate project files,
 * so the current query and presentation state remain authoritative.
 */
export function refreshProjectAssetsLiveRegion(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  const region = projectAssetsLiveEngine.getRegion(document);
  if (!document || !region) return false;

  projectAssetsLiveEngine.enhance(document);
  const state = document.__creatorCrateProjectAssetsLiveFiltering;
  const form = projectAssetsLiveEngine.getForm(region);
  if (!state || !form || !projectAssetsLiveEngine.capabilities(state.window)) return false;

  let url;
  try {
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
    url = state.controller && state.requestedUrl
      ? new state.window.URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href)
      : projectAssetsLiveEngine.url(form, state.window, { preservePage: true });
  } catch {
    return false;
  }

  projectAssetsLiveEngine.invalidate(state);
  projectAssetsLiveEngine.load(state, url, 'none', form);
  return true;
}

export function enhanceProjectsLiveFiltering(scope = globalThis.document) {
  return projectsLiveEngine.enhance(scope);
}

export function enhanceReleasesLiveFiltering(scope = globalThis.document) {
  return releasesLiveEngine.enhance(scope);
}

const ASSET_LIBRARY_LIVE_REGION_SELECTOR = '[data-asset-library-live-region]';
const ASSET_LIBRARY_FILTER_SELECTOR = '#asset-filters';
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
    refreshUrl = state.controller && state.requestedUrl
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
  enhanceSlideshow(liveRegionDocument(region));
  enhanceProjectAssetsPreviewSlideshow(region);
}

const assetLibraryLiveEngine = createLiveRegionEngine({
  regionSelector: ASSET_LIBRARY_LIVE_REGION_SELECTOR,
  formSelector: ASSET_LIBRARY_FILTER_SELECTOR,
  linkSelector: 'nav.view-switcher a, .pagination a, [data-asset-library-reset]',
  debounceMs: ASSET_LIBRARY_LIVE_DEBOUNCE_MS,
  defaultAction: '/assets',
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
    if (state.libNsfwRefreshGeneration !== generation) return;
    state.libNsfwRefreshGeneration = null;
    state.libNsfwSubmitting = false;
    state.libNsfwRegionReplaced = false;
    state.libNsfwEnabled = assetLibraryRenderedNsfwEnabled(region);
    updateAssetLibraryNsfwControls(region, state.libNsfwEnabled);
  },
  onLoadError(state, generation) {
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
    return url.pathname === '/assets';
  },
});

export function enhanceAssetLibraryLiveFiltering(scope = globalThis.document) {
  return assetLibraryLiveEngine.enhance(scope);
}

