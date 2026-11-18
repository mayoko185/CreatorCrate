import {
  assetLibraryLiveSnapshot,
  navigateAssetLibraryLive,
  subscribeAssetLibraryLive,
} from './live-regions.js';
import {
  bindExplicitPageDefaultsDialog,
  createExplicitPageDefaults,
  describeExplicitPageSavedState,
  enhanceExplicitPageDefaults,
  explicitPageDefaultsController,
  parseExplicitPageDefaultsAuthority,
  readExplicitPageDefaultsAuthority,
  sameExplicitPageDefaultsValues,
} from './explicit-page-defaults.js';

/*
 * WP9a — Asset Library (Asset Viewer) defaults transport.
 *
 * Asset Library uses Global page defaults only (page key `assetViewer`); there
 * is no Global/Project-only scope here. This module owns, for the forthcoming
 * WP9b combined dialog:
 *   - explicit "Save new defaults" (one coherent snapshot of the nine
 *     saveable settings, acknowledged once, reconciled when uncertain);
 *   - Reset filters (GET-only navigation to the authoritative destination);
 *   - Reset defaults (one CSRF-protected deletion POST, never repeated);
 * and the request-lifecycle rules that keep them from capturing or
 * installing stale state.
 *
 * Three states are kept apart:
 *   1. current intention  — the installed authority's `current` values while
 *      no GET is pending/failed, plus the session Grid style choice;
 *   2. installed results  — only an 'installed' live-region notification
 *      (never a prepared/parsed response) counts as installed;
 *   3. acknowledged saved defaults — only a confirmed POST answer or an
 *      authoritative read updates them.
 *
 * OPT-IN BOUNDARY: `enhanceAssetLibraryFiltersDefaults` binds only a
 * `#asset-viewer-defaults-form` that carries `data-defaults-explicit-save` and
 * does NOT carry the legacy `data-asset-viewer-defaults-autosave` marker.
 * WP9b's combined Filters & Defaults dialog renders exactly that form, so the
 * explicit transport is the only defaults binding on the Asset Library page;
 * the legacy per-control autosave binding is retired there. The legacy
 * helpers below (`prepareAssetViewerLegacyDefaultsBody` /
 * `acknowledgeAssetViewerLegacyDefaults`) stay for any marker-carrying form.
 *
 * WP9b DIALOG BINDING (`bindAssetLibraryFiltersDefaultsDialog`): presentation
 * only. It shows the saved-state line from `savedMetadata()` (stored-key
 * presence, never value equality with fallbacks), applies the session Grid
 * style through `setGridStyle()` to the installed grid, holds the mutation
 * buttons while a POST/check is in flight, and offers the GET-only recovery
 * actions (`retryRefresh`, `retryReconcile`). It never posts and never
 * navigates on its own.
 *
 * WP10b: the controller, dialog binding and enhancement logic now live in
 * the shared explicit-page-defaults.js core (unchanged behaviour), which the
 * Projects dialog also uses; this module owns the Asset Library config and
 * its public names.
 *
 * WP9a F6/F7 MUTATION PROTOCOL. Every Save / Reset defaults POST carries the
 * server's durable defaults generation it was prepared from and a unique
 * operation identity. The server advances the generation atomically with the
 * write and rejects an obsolete generation with a correlated 409, so an older
 * request delivered late can never overwrite a newer one (in either arrival
 * order, across reloads). Only an answer that echoes this request's operation
 * identity, with a result consistent with its HTTP status and generation, is
 * the application's answer; any other response (a gateway 502/504, an
 * unrelated 2xx, a middleware 403) proves nothing about the write.
 */

export const ASSET_LIBRARY_DEFAULTS_FORM_SELECTOR = '#asset-viewer-defaults-form';
export const ASSET_LIBRARY_DEFAULTS_AUTOSAVE_ATTRIBUTE = 'data-asset-viewer-defaults-autosave';
export const ASSET_LIBRARY_DEFAULTS_RESET_SELECTOR = '[data-asset-library-defaults-reset]';
export const ASSET_LIBRARY_FILTERS_RESET_SELECTOR = '[data-asset-library-filters-reset]';
export const ASSET_LIBRARY_DEFAULTS_AUTHORITY_SELECTOR = '[data-asset-library-live-region] script[data-asset-library-defaults-authority]';
export const ASSET_LIBRARY_DEFAULTS_FIELDS = Object.freeze([
  'view', 'gridStyle', 'sort', 'order', 'pageSize', 'extension', 'category', 'presence', 'tag',
]);
const DEFAULTS_ENDPOINT = '/asset-viewer/defaults';
const DEFAULTS_RESET_ENDPOINT = '/asset-viewer/defaults/reset';
const RESET_FILTERS_URL = '/asset-viewer?resetFilters=1';
export const ASSET_LIBRARY_DEFAULTS_GENERATION_FIELD = 'defaultsGeneration';
export const ASSET_LIBRARY_DEFAULTS_OPERATION_FIELD = 'defaultsOperation';

export const ASSET_LIBRARY_DEFAULTS_MESSAGES = Object.freeze({
  saving: 'Saving defaults.',
  saved: 'Defaults saved.',
  savedRefreshFailed: 'Defaults were saved, but the Asset Viewer could not be refreshed. Retry to refresh the page.',
  saveInProgress: 'Defaults are already being saved.',
  loading: 'The Asset Viewer is still loading. Save again when it has finished.',
  loadFailed: 'The current filters did not load. Retry loading them before saving defaults.',
  resetPending: 'Reset filters has not finished. Save again when it has finished.',
  resetIncomplete: 'Reset filters did not finish. Retry loading the page before saving defaults.',
  unreadable: 'The current settings could not be read. Refresh the page before saving defaults.',
  unavailable: 'Defaults cannot be saved right now. Refresh the page and try again.',
  invalid: 'Defaults were not saved. Check the highlighted settings. Your current choices were kept.',
  csrf: 'Defaults were not saved because the session expired. Refresh the page and try again.',
  notSaved: 'Defaults were not saved. Your current choices were kept.',
  uncertain: 'Could not confirm whether the defaults were saved. Check again before changing them.',
  saveUnresolved: 'Could not confirm whether the defaults were saved, and the save may still finish. Reload the page before changing defaults again.',
  saveMatchesUnconfirmed: 'The saved defaults already match these settings, but this save could not be confirmed and may still finish. Reload the page before changing defaults again.',
  checking: 'Checking whether the defaults were saved.',
  resetDefaultsRunning: 'Defaults are already being reset.',
  resettingDefaults: 'Resetting defaults.',
  defaultsReset: 'Defaults reset to the application defaults.',
  defaultsResetRefreshFailed: 'Defaults were reset, but the Asset Viewer could not be refreshed. Retry to refresh the page.',
  defaultsNotReset: 'Defaults were not reset. Your saved defaults were kept.',
  defaultsResetUncertain: 'Could not confirm whether the defaults were reset. Check again before changing them.',
  resetDefaultsUnresolved: 'Could not confirm whether the defaults were reset, and the reset may still finish. Reload the page before changing defaults again.',
  resetMatchesUnconfirmed: 'No defaults are saved now, but this reset could not be confirmed and may still finish. Reload the page before changing defaults again.',
  busy: 'Wait for the current defaults change to finish.',
  saveConflict: 'Defaults were not saved because the saved defaults changed elsewhere. Your current choices were kept. Check the saved defaults, then save again.',
  resetConflict: 'Defaults were not reset because the saved defaults changed elsewhere. Check the saved defaults, then reset again.',
  saveOutcomeUnknown: 'Could not confirm whether the defaults were saved. The saved defaults have changed since, so this save can no longer finish. Check them before saving again.',
  resetOutcomeUnknown: 'Could not confirm whether the defaults were reset. The saved defaults have changed since, so this reset can no longer finish. Check them before changing them again.',
});

export function sameAssetLibraryDefaultsValues(left, right) {
  return sameExplicitPageDefaultsValues(ASSET_LIBRARY_PAGE, left, right);
}

/**
 * Validates the server's authoritative metadata. Anything incomplete is
 * rejected (null) so a caller fails closed instead of guessing.
 */
export function parseAssetLibraryDefaultsAuthority(value, options = {}) {
  return parseExplicitPageDefaultsAuthority(ASSET_LIBRARY_PAGE, value, options);
}

export function readAssetLibraryDefaultsAuthority(document) {
  return readExplicitPageDefaultsAuthority(ASSET_LIBRARY_PAGE, document);
}

// The temporary (never saved) filter context, in the server's canonical
// order: repeated Project / Project Type selections, Search, Usage.
const TEMPORARY_QUERY_KEYS = Object.freeze(['project', 'type', 'search', 'usage']);

/**
 * The Reset defaults refresh destination when the server's own `refreshUrl`
 * was not received: mirrors the route (temporary context of `returnTo`, page
 * 1, every default-backed control left to its post-deletion fallback). The
 * nine saveable keys and `page` are dropped; repeated values stay repeated.
 */
export function assetLibraryResetDefaultsDestination(returnTo, base) {
  let parsed;
  try {
    parsed = new URL(returnTo || '/asset-viewer', base || 'http://localhost/asset-viewer');
  } catch {
    return '/asset-viewer';
  }
  const query = new URLSearchParams();
  TEMPORARY_QUERY_KEYS.forEach((key) => {
    parsed.searchParams.getAll(key).forEach((value) => {
      const text = value.trim();
      if (text === '' || (key === 'usage' && text === 'all')) return;
      query.append(key, text);
    });
  });
  const search = query.toString();
  return search ? `/asset-viewer?${search}` : '/asset-viewer';
}

/**
 * Creates the Asset Library defaults controller for one document. All
 * collaborators are injectable for tests; the defaults use the shared
 * live-region engine, `fetch`, and the form's CSRF token.
 */
export function createAssetLibraryFiltersDefaults(document, options = {}) {
  return createExplicitPageDefaults(document, ASSET_LIBRARY_PAGE, options);
}

/*
 * Legacy Asset Viewer autosave (the existing per-control dialog) in the F6
 * fence. The form renders the generation it came from as a hidden
 * `defaultsGeneration` field. The shared autosave transport sends one
 * request at a time and captures a queued request's body early, so the
 * generation is substituted when each request is SENT: the rendered value
 * first, then one past the generation of each acknowledged save (a native
 * success redirect is only produced after the fenced write committed). A
 * conflict (409, never a redirect) leaves the generation unchanged, so every
 * later autosave from this page is refused until the page is reloaded.
 */
const legacyGenerations = new WeakMap();

function legacyGenerationState(form) {
  let entry = legacyGenerations.get(form);
  if (!entry) {
    const input = form?.querySelector?.(`input[name="${ASSET_LIBRARY_DEFAULTS_GENERATION_FIELD}"]`);
    const value = input?.value ?? input?.getAttribute?.('value') ?? '';
    entry = { generation: /^(0|[1-9]\d*)$/.test(value) ? Number(value) : null, inflight: null };
    legacyGenerations.set(form, entry);
  }
  return entry;
}

export function prepareAssetViewerLegacyDefaultsBody({ form, body }) {
  const entry = legacyGenerationState(form);
  entry.inflight = entry.generation;
  if (entry.generation !== null) body.set(ASSET_LIBRARY_DEFAULTS_GENERATION_FIELD, String(entry.generation));
  return body;
}

export function acknowledgeAssetViewerLegacyDefaults({ form }) {
  const entry = legacyGenerationState(form);
  if (entry.inflight !== null) entry.generation = entry.inflight + 1;
  entry.inflight = null;
  return true;
}

export function assetLibraryFiltersDefaultsController(document) {
  return explicitPageDefaultsController(document, ASSET_LIBRARY_PAGE);
}

export const ASSET_LIBRARY_DEFAULTS_DIALOG_ID = 'asset-viewer-filter-dialog';
const INDICATOR_SELECTOR = '[data-asset-library-defaults-indicator]';
const GRID_STYLE_CONTROL_SELECTOR = '[data-asset-library-grid-style]';
const LIBRARY_GRID_SELECTOR = '[data-asset-library-live-region] .asset-grid';
const SAVE_CONTROL_SELECTOR = '[data-asset-library-defaults-save]';
const RECOVERY_SELECTOR = '[data-asset-library-defaults-recovery]';
const RETRY_SELECTOR = '[data-asset-library-defaults-retry]';
const CHECK_SELECTOR = '[data-asset-library-defaults-check]';

export const ASSET_LIBRARY_SAVED_STATE_MESSAGES = Object.freeze({
  checking: 'Checking the saved defaults.',
  unreadable: 'The saved defaults could not be read. Reopen Filters & Defaults to check again.',
  none: 'No saved defaults',
  all: 'Defaults saved',
  differsFromSaved: 'Current settings differ from the saved defaults',
  differsFromApplication: 'Current settings differ from the application defaults',
});

/**
 * The saved-state line. Presence comes only from the server's stored-key
 * metadata: an explicitly saved fallback value still counts as saved. The
 * value comparison is used solely to say the current settings differ.
 */
export function describeAssetLibrarySavedState(metadata, current, options = {}) {
  return describeExplicitPageSavedState(ASSET_LIBRARY_PAGE, metadata, current, options);
}

/**
 * WP9b presentation binding for the combined dialog. Returns `sync`, which
 * the controller's onChange calls; everything it writes is derived from the
 * controller and the installed page, so it can run any number of times.
 */
export function bindAssetLibraryFiltersDefaultsDialog(document, controller, options = {}) {
  return bindExplicitPageDefaultsDialog(document, controller, ASSET_LIBRARY_PAGE, options);
}

// The Asset Library page config of the shared explicit defaults core.
const ASSET_LIBRARY_PAGE = Object.freeze({
  key: 'assetViewer',
  fields: ASSET_LIBRARY_DEFAULTS_FIELDS,
  multiFields: new Set(['extension', 'category', 'tag']),
  basePath: '/asset-viewer',
  defaultsEndpoint: DEFAULTS_ENDPOINT,
  resetEndpoint: DEFAULTS_RESET_ENDPOINT,
  resetFiltersUrl: RESET_FILTERS_URL,
  generationField: ASSET_LIBRARY_DEFAULTS_GENERATION_FIELD,
  operationField: ASSET_LIBRARY_DEFAULTS_OPERATION_FIELD,
  authoritySelector: ASSET_LIBRARY_DEFAULTS_AUTHORITY_SELECTOR,
  formSelector: ASSET_LIBRARY_DEFAULTS_FORM_SELECTOR,
  autosaveAttribute: ASSET_LIBRARY_DEFAULTS_AUTOSAVE_ATTRIBUTE,
  dialogId: ASSET_LIBRARY_DEFAULTS_DIALOG_ID,
  selectors: Object.freeze({
    indicator: INDICATOR_SELECTOR,
    gridStyleControl: GRID_STYLE_CONTROL_SELECTOR,
    grid: LIBRARY_GRID_SELECTOR,
    save: SAVE_CONTROL_SELECTOR,
    defaultsReset: ASSET_LIBRARY_DEFAULTS_RESET_SELECTOR,
    filtersReset: ASSET_LIBRARY_FILTERS_RESET_SELECTOR,
    recovery: RECOVERY_SELECTOR,
    retry: RETRY_SELECTOR,
    check: CHECK_SELECTOR,
  }),
  messages: ASSET_LIBRARY_DEFAULTS_MESSAGES,
  savedStateMessages: ASSET_LIBRARY_SAVED_STATE_MESSAGES,
  live: () => ({
    snapshot: assetLibraryLiveSnapshot,
    navigate: navigateAssetLibraryLive,
    subscribe: subscribeAssetLibraryLive,
  }),
  resetDefaultsDestination: (returnTo, base) => assetLibraryResetDefaultsDestination(returnTo, base),
});

/**
 * Binds the explicit-save transport to an opted-in WP9b form. Inert for the
 * legacy autosave dialog. Returns the controller or null.
 */
export function enhanceAssetLibraryFiltersDefaults(document = globalThis.document, options = {}) {
  return enhanceExplicitPageDefaults(document, ASSET_LIBRARY_PAGE, options);
}
