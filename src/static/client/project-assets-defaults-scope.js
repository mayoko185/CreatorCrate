import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';
import { syncProjectAssetsSizePreferences } from './app-dialogs.js';
import { requestAppConfirmation } from './confirm-dialog.js';
import {
  beginProjectAssetsDefaultsLiveRefresh,
  PROJECT_ASSETS_FILTERS_RESET_EVENT,
  PROJECT_ASSETS_REGION_LOADED_EVENT,
  projectAssetsFiltersResetPending,
  projectAssetsFiltersResetRetryAvailable,
  projectAssetsRenderedGridStyle,
  refreshProjectAssetsAfterMutation,
  refreshProjectAssetsWithLoadedDefaults,
  releaseProjectAssetsRetainedSizes,
  restyleProjectAssetsGrid,
  retainProjectAssetsDisplayedSizes,
} from './live-regions.js';
import {
  previewProjectAssetsGridSize,
  previewProjectAssetsListSize,
  resolvedProjectAssetsSizes,
} from './size-preferences.js';
import {
  queueSettingsFetchSave,
  setFetchSaveStatus,
  suppressSettingsFetchSave,
} from './settings-fetch-save.js';

const MULTI_VALUE_KEYS = new Set(['extension', 'tag']);

// The WP4 explicit-save opt-in (DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE in
// projects-defaults-fetch-save.js, which imports this module). An opted-in
// form activates a scope instead of saving on a scope change (WP6).
const EXPLICIT_SAVE_ATTRIBUTE = 'data-defaults-explicit-save';
const ACTIVATE_SCOPE_INTENT = 'activate-scope';
// WP7: the combined Filters & Defaults dialog. Its Tag, Extension, Sort, Order,
// View and Page size are the live #asset-filters controls; the defaults form
// keeps hidden mirror selects for them, filled from the live values only when
// a Save is sent. Grid style and the size defaults are ordinary fields.
const LIVE_CONTROLS_ATTRIBUTE = 'data-defaults-live-controls';
const LIVE_FILTER_FORM_ID = 'asset-filters';
const LIVE_KEYS = Object.freeze(['view', 'sort', 'order', 'pageSize', 'tag', 'extension']);
const INDICATOR_SELECTOR = '[data-project-assets-defaults-indicator]';
const SAVED_DEFAULTS_SELECTOR = 'script[type="application/json"][data-project-assets-saved-defaults]';
const RESET_SELECTOR = '[data-project-assets-defaults-reset]';
const RESET_MESSAGES = Object.freeze({
  confirm: {
    global: 'Remove the saved Global Project Assets defaults? Project-only defaults saved for any project are kept, and the current filters and results stay as they are.',
    project: 'Remove the Project-only Project Assets defaults saved for this project? It will use Global defaults again. Global defaults and other projects are kept, and the current filters and results stay as they are.',
  },
  pending: (scope) => `Resetting ${SCOPE_LABELS[scope]} defaults.`,
  done: {
    global: 'Global defaults reset. Project-only defaults were kept.',
    project: 'Project-only defaults reset. This project now uses Global defaults.',
  },
  noop: {
    global: 'No Global defaults were saved, so nothing was reset.',
    project: 'No Project-only defaults were saved, so nothing was reset.',
  },
  failed: 'Defaults could not be reset. No changes were made.',
  refreshFailed: 'Defaults were reset, but Project Assets could not refresh, so its page and view links are unavailable. Retry, or reload the page.',
  unread: 'Defaults were reset, but the updated defaults could not be read. Reload the page before saving defaults.',
  uncertain: 'Could not confirm whether defaults were reset. Reload the page to check before saving defaults.',
  busy: 'Wait for the current defaults operation to finish before resetting defaults.',
  filtersResetting: 'Wait for Reset filters to finish before resetting defaults.',
  unavailable: 'Defaults could not be reset here. Reload the page and try again.',
});
// Package B: Reset filters is a live GET whose restored controls are not shown
// until its response installs, so it neither starts during a defaults
// operation nor lets one start while it owns the live region.
const FILTERS_RESET_SELECTOR = '[data-project-assets-reset]';
const FILTERS_RESET_MESSAGES = Object.freeze({
  busy: 'Wait for the current defaults operation to finish before resetting filters.',
});
const SCOPE_LABELS = Object.freeze({ global: 'Global', project: 'Project-only' });
const ACTIVATION_MESSAGES = Object.freeze({
  pending: (scope) => `Loading ${SCOPE_LABELS[scope]} defaults.`,
  loaded: (scope) => `${SCOPE_LABELS[scope]} defaults loaded.`,
  keptNewer: (scope) => `${SCOPE_LABELS[scope]} defaults are active. Your newer changes were kept and are not saved.`,
  failed: 'Defaults scope could not be changed. The previous scope is still active.',
  saveBusy: 'Wait for the current save to finish before changing the defaults scope.',
  filtersResetting: 'Wait for Reset filters to finish before changing the defaults scope.',
  checking: 'Checking which defaults scope is active.',
  unresolved: 'Could not confirm whether the defaults scope changed. Choose a scope to check again, or reload the page.',
  unrepresentable: 'Defaults scope changed, but its saved values could not be shown. Reload the page before saving defaults.',
  unavailable: 'Defaults scope could not be changed here. Reload the page and try again.',
});
const SAVE_BLOCKED_MESSAGES = Object.freeze({
  activating: 'Wait for the defaults scope to finish changing before saving.',
  unresolved: 'The active defaults scope could not be confirmed. Choose a scope to check it before saving.',
  reload: 'Reload the page before saving defaults.',
  mismatch: 'The selected defaults scope is not active yet. Choose it again before saving.',
  resetting: 'Wait for the defaults reset to finish before saving.',
  filtersResetting: 'Wait for Reset filters to finish before saving.',
  filtersResetIncomplete: 'Reset filters did not finish loading the active defaults. Retry it, or use Reset filters again, before saving.',
});

const FORM_SELECTOR = '#project-assets-defaults-form';
const SCOPE_SELECTOR = '[data-project-assets-defaults-scope]';
const VALUES_SELECTOR = 'script[type="application/json"][data-project-assets-default-values]';
const LOADED_SCOPE_SELECTOR = 'input[name="loadedScope"]';
const SCOPES = Object.freeze(['global', 'project']);
const states = new WeakMap();
const VALUE_KEYS = Object.freeze([
  'view',
  'gridStyle',
  'gridSize',
  'listSize',
  'sort',
  'order',
  'pageSize',
  'extension',
  'tag',
]);

function validScope(value) {
  return SCOPES.includes(value) ? value : null;
}

function scopeValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of VALUE_KEYS) {
    const fieldValue = value[key];
    if (MULTI_VALUE_KEYS.has(key) && Array.isArray(fieldValue)) {
      if (fieldValue.some((member) => typeof member !== 'string')) return null;
      result[key] = [...fieldValue];
      continue;
    }
    if (typeof fieldValue !== 'string') return null;
    result[key] = fieldValue;
  }
  return result;
}

function parseValues(script) {
  if (!script || typeof script.textContent !== 'string') return null;
  try {
    const parsed = JSON.parse(script.textContent);
    const global = scopeValues(parsed?.global);
    const project = scopeValues(parsed?.project);
    return global && project ? { global, project } : null;
  } catch {
    return null;
  }
}

// The active scope and both resolved snapshots a rendered Project Assets page
// carries in its defaults form.
function parseResponseDocument(parsed) {
  try {
    const responseForm = parsed?.querySelector?.(FORM_SELECTOR);
    const activeScope = validScope(responseForm?.querySelector?.(LOADED_SCOPE_SELECTOR)?.value);
    const values = parseValues(responseForm?.querySelector?.(VALUES_SELECTOR));
    const savedDefaults = parseSavedDefaultsScript(responseForm?.querySelector?.(SAVED_DEFAULTS_SELECTOR));
    return activeScope && values ? { ...values, activeScope, savedDefaults } : null;
  } catch {
    return null;
  }
}

function parseResponseState(form, html) {
  if (typeof html !== 'string' || html === '') return null;
  const DOMParser = form?.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (typeof DOMParser !== 'function') return null;
  try {
    return parseResponseDocument(new DOMParser().parseFromString(html, 'text/html'));
  } catch {
    return null;
  }
}

// WP7: the combined dialog keeps Grid style and the size defaults beside the
// live controls (associated with this form by form="…"), so fields are looked
// up in the whole dialog. A form outside a dialog keeps its own scope.
function fieldRoot(form) {
  return form.closest?.('[data-app-dialog]') || form;
}

function formFields(form) {
  const fields = {};
  const root = fieldRoot(form);
  for (const key of VALUE_KEYS) {
    const field = root.querySelector?.(`[data-dialog-field="${key}"]`);
    const select = field?.querySelector?.('select');
    if (!select) return null;
    fields[key] = select;
  }
  return fields;
}

function captureDraft(fields) {
  return Object.fromEntries(VALUE_KEYS.map((key) => {
    const field = fields[key];
    if (MULTI_VALUE_KEYS.has(key) && field?.multiple) {
      const selected = Array.from(field.options || [])
        .filter((option) => option.selected)
        .map((option) => String(option.value ?? ''))
        .filter((value) => value !== 'all');
      return [key, selected.length > 0 ? selected : 'all'];
    }
    return [key, String(field?.value ?? '')];
  }));
}

function captureSubmittedValues(fields) {
  const values = captureDraft(fields);
  return VALUE_KEYS.every((key) => (
    MULTI_VALUE_KEYS.has(key)
      ? values[key] === 'all' || Array.isArray(values[key]) || typeof values[key] === 'string'
      : typeof values[key] === 'string'
  )) ? values : null;
}

function draftIsRepresentable(fields, draft) {
  return VALUE_KEYS.every((key) => {
    const value = draft[key];
    if (MULTI_VALUE_KEYS.has(key) && fields[key]?.multiple) {
      if (value === 'all') return true;
      if (!Array.isArray(value)) return false;
      const available = new Set(Array.from(fields[key].options || []).map((option) => String(option.value ?? '')));
      return value.every((member) => available.has(String(member)));
    }
    return Array.from(fields[key].options || [])
      .some((option) => String(option.value ?? '') === value);
  });
}

function dispatchNativeEvent(select, type) {
  const EventConstructor = select?.ownerDocument?.defaultView?.Event || globalThis.Event;
  if (typeof EventConstructor === 'function') {
    select.dispatchEvent?.(new EventConstructor(type, { bubbles: true }));
  }
}

function validSavedDefaults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!validScope(value.activeScope) || typeof value.global?.saved !== 'boolean') return null;
  if (value.project !== undefined && typeof value.project?.saved !== 'boolean') return null;
  return value;
}

function parseSavedDefaultsScript(script) {
  if (!script || typeof script.textContent !== 'string') return null;
  try {
    return validSavedDefaults(JSON.parse(script.textContent));
  } catch {
    return null;
  }
}

function isLiveControlsForm(form) {
  return Boolean(form?.hasAttribute?.(LIVE_CONTROLS_ATTRIBUTE)) && isExplicitSaveForm(form);
}

function liveFilterForm(form) {
  return form?.ownerDocument?.getElementById?.(LIVE_FILTER_FORM_ID) || null;
}

function liveInheritedKeys(liveForm) {
  const input = liveForm?.querySelector?.('[data-project-assets-inherited-filter-defaults]');
  if (!input || input.disabled) return [];
  return String(input.value || '').split(',').map((value) => value.trim()).filter(Boolean);
}

// Removes one key from the live form's inherited marker, exactly as the user's
// own Tag/Extension choice does (updateInheritedProjectAssetsFilterDefaults).
function dropLiveInheritedKey(liveForm, key) {
  const input = liveForm?.querySelector?.('[data-project-assets-inherited-filter-defaults]');
  if (!input) return;
  const remaining = liveInheritedKeys(liveForm).filter((member) => member !== key);
  input.value = remaining.join(',');
  input.disabled = remaining.length === 0;
}

function liveSelectedMembers(data, key) {
  return [...new Set(data.getAll(key).map(String))].filter((value) => value !== '' && value !== 'all');
}

/**
 * The eligible defaults the page is using now, read from #asset-filters and the
 * controls associated with it. A displayed Tag/Extension selection is always
 * what is current. The inherited mark matters only while nothing is displayed
 * for its key: the saved default is then suspended under a concrete Category
 * (or about to be shown again), so the committed value is current rather than
 * the unrestricted control. A user's own choice clears that mark.
 * Correction B (F4): the mark alone never substitutes the committed snapshot
 * for a displayed selection, since a reset or scope change can replace that
 * snapshot while the selection stays on screen.
 */
function readLiveValues(state) {
  const liveForm = liveFilterForm(state.form);
  const FormDataConstructor = state.form.ownerDocument?.defaultView?.FormData || globalThis.FormData;
  if (!liveForm || typeof FormDataConstructor !== 'function') return null;
  let data;
  try {
    data = new FormDataConstructor(liveForm);
  } catch {
    return null;
  }
  const inherited = liveInheritedKeys(liveForm);
  const committed = effectiveValues(state) || {};
  const values = {};
  for (const key of LIVE_KEYS) {
    if (MULTI_VALUE_KEYS.has(key)) {
      const selected = liveSelectedMembers(data, key);
      if (selected.length === 0 && inherited.includes(key) && committed[key] !== undefined) {
        values[key] = Array.isArray(committed[key]) ? [...committed[key]] : committed[key];
        continue;
      }
      values[key] = selected.length > 0 ? selected : 'all';
      continue;
    }
    const value = data.get(key);
    values[key] = typeof value === 'string' && value !== '' ? value : committed[key];
  }
  return values;
}

// Copies the live values into the hidden mirror selects without sending any
// event, so a Save payload is built from exactly what the page shows.
function syncMirrorsFromLive(state) {
  const live = readLiveValues(state);
  if (!live) return false;
  const draft = { ...captureDraft(state.fields), ...live };
  if (!draftIsRepresentable(state.fields, draft)) return false;
  LIVE_KEYS.forEach((key) => {
    const select = state.fields[key];
    const value = draft[key];
    if (MULTI_VALUE_KEYS.has(key) && select.multiple) {
      const selected = new Set(value === 'all' ? [] : value.map(String));
      Array.from(select.options || []).forEach((option) => {
        option.selected = selected.has(String(option.value ?? ''));
      });
    } else {
      select.value = value;
    }
  });
  return true;
}

function sameValue(left, right) {
  const normalize = (value) => (Array.isArray(value) ? value.map(String).sort() : value);
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function currentDiffersFromActive(state) {
  const effective = effectiveValues(state);
  const live = readLiveValues(state);
  if (!effective || !live) return false;
  const current = { ...captureDraft(state.fields), ...live };
  return VALUE_KEYS.some((key) => !sameValue(current[key], effective[key]));
}

// Presence comes only from the server's saved-state metadata (key/row
// existence); the comparison is used solely for "differ from the active".
function describeSavedState(state) {
  const saved = state.savedDefaults;
  const active = validScope(state.committedScope);
  if (!saved || !active) return '';
  const parts = [active === 'project' ? 'Using Project only' : 'Using Global'];
  if (!saved.hasSavedDefaults) {
    parts.push('No saved defaults');
  } else {
    parts.push(saved.global.saved ? 'Global defaults saved' : 'No Global defaults saved');
    if (saved.project?.saved) {
      if (active !== 'project') parts.push('Project-only defaults saved, not in use');
      else if (saved.project.inheritance === 'partial') parts.push('Project-only defaults saved, others inherit Global');
      else parts.push('Project-only defaults saved');
    } else if (saved.project) {
      parts.push(active === 'project' ? 'Project inherits Global' : 'No Project-only defaults');
    }
  }
  if (isLiveControlsForm(state.form) && currentDiffersFromActive(state)) {
    parts.push('Current settings differ from the active defaults');
  }
  return `${parts.join(' · ')}.`;
}

function renderSavedIndicator(state) {
  const indicator = state.form.querySelector?.(INDICATOR_SELECTOR);
  if (!indicator) return;
  const text = describeSavedState(state);
  if (indicator.textContent !== text) indicator.textContent = text;
}

function writeSavedDefaults(state, savedDefaults) {
  const valid = validSavedDefaults(savedDefaults);
  if (!valid) return;
  state.savedDefaults = valid;
  const script = state.form.querySelector?.(SAVED_DEFAULTS_SELECTOR);
  if (script) script.textContent = JSON.stringify(valid).replace(/</g, '\\u003c');
}

function clearScopeError(form) {
  const scope = form.querySelector?.(SCOPE_SELECTOR);
  const error = scope?.querySelector?.('.field-error-message');
  error?.remove?.();
  scope?.querySelectorAll?.('input[name="scope"]').forEach((radio) => {
    radio.removeAttribute?.('aria-invalid');
    radio.removeAttribute?.('aria-describedby');
  });

  const dialogError = form.querySelector?.('[data-dialog-error]');
  const dialogErrorText = form.querySelector?.('[data-dialog-error-text]');
  const dialogErrorList = form.querySelector?.('[data-dialog-error-list]');
  const message = `${dialogErrorText?.textContent || ''} ${dialogErrorList?.textContent || ''}`;
  if (dialogError && /(scope|loaded scope)/i.test(message)) {
    dialogError.hidden = true;
    dialogError.setAttribute?.('hidden', '');
    if (dialogErrorText) dialogErrorText.textContent = '';
    if (dialogErrorList) dialogErrorList.textContent = '';
  }
}

function showScopeError(form, message) {
  const error = form.querySelector?.('[data-dialog-error]');
  if (error) {
    error.hidden = false;
    error.removeAttribute?.('hidden');
  }
  const errorText = form.querySelector?.('[data-dialog-error-text]');
  if (errorText) errorText.textContent = message;
  const status = form.querySelector?.('[data-dialog-status]');
  if (status) status.textContent = message;
}

function restoreLoadedScopeRadio(scope, loadedScope) {
  scope?.querySelectorAll?.('input[name="scope"]').forEach((radio) => {
    radio.checked = radio.value === loadedScope;
  });
}

function captureSuccessfulSubmission(state) {
  const scope = validScope(
    state.scopeControl.querySelector?.('input[name="scope"]:checked')?.value,
  );
  const loadedScope = validScope(state.loadedScope.value);
  const values = captureSubmittedValues(state.fields);
  if (!scope || scope !== loadedScope || !values) return null;
  return { scope, loadedScope, values };
}

function submissionFromPayload(state, payload) {
  if (typeof payload !== 'string') return null;
  const params = new globalThis.URLSearchParams(payload);
  const scope = validScope(params.get('scope'));
  const loadedScope = validScope(params.get('loadedScope'));
  if (!scope || scope !== loadedScope) return null;

  const values = Object.fromEntries(VALUE_KEYS.map((key) => {
    if (!MULTI_VALUE_KEYS.has(key)) return [key, params.get(key)];
    const selected = params.getAll(key).filter((value) => value !== 'all');
    if (!state.fields[key]?.multiple) return [key, selected[0] || 'all'];
    return [key, selected.length > 0 ? selected : 'all'];
  }));
  return scopeValues(values) ? { scope, loadedScope, values } : null;
}

function writeCommittedValues(state) {
  state.valuesScript.textContent = JSON.stringify({
    global: { ...state.committed.global },
    project: { ...state.committed.project },
  });
}

function reconcileSuccessfulSubmission(state, payload) {
  const submitted = state.pendingSubmission;
  state.pendingSubmission = null;
  const values = scopeValues(payload?.values);
  if (!submitted || !values) return;
  const global = submitted.scope === 'global' ? values : state.committed.global;
  const project = submitted.scope === 'project' ? values : state.committed.project;
  state.committed = {
    global: { ...global },
    project: { ...project },
  };
  state.drafts = {
    global: { ...state.committed.global },
    project: { ...state.committed.project },
  };
  state.committedScope = submitted.loadedScope;
  state.loadedScope.value = submitted.loadedScope;
  restoreLoadedScopeRadio(state.scopeControl, submitted.loadedScope);
  writeCommittedValues(state);
  clearScopeError(state.form);
}

export function beginProjectAssetsDefaultsAcknowledgement(form, payload) {
  const state = states.get(form);
  if (!state) return;
  const submitted = submissionFromPayload(state, payload);
  const current = captureSuccessfulSubmission(state);
  // A queued immutable payload may start after the editor has changed again.
  state.submissionRevision = submitted && current
    && JSON.stringify(submitted) === JSON.stringify(current) ? state.userRevision : null;
}

export function reconcileProjectAssetsDefaultsAcknowledgement(
  form,
  payload,
  { html = '', superseded = false } = {},
) {
  const state = states.get(form);
  const submitted = state ? submissionFromPayload(state, payload) : null;
  const authoritative = state ? parseResponseState(state.form, html) : null;
  if (!state || !submitted || !authoritative) return false;
  if (!draftIsRepresentable(state.fields, authoritative.global)
    || !draftIsRepresentable(state.fields, authoritative.project)) return false;

  state.committed = {
    global: { ...authoritative.global },
    project: { ...authoritative.project },
  };
  state.committedScope = authoritative.activeScope;
  writeCommittedValues(state);
  if (authoritative.savedDefaults) writeSavedDefaults(state, authoritative.savedDefaults);
  if (!superseded) {
    const acknowledged = authoritative[authoritative.activeScope];
    // A preview the Save persisted is now the stored size; a newer one stays.
    SIZE_KEYS.forEach((key) => {
      if (state.sizePreview[key] === acknowledged?.[key]) state.sizePreview[key] = null;
    });
    // Correction E (F6): the acknowledged sizes end any reset's retention.
    releaseProjectAssetsRetainedSizes(state.form.ownerDocument, acknowledged);
    syncProjectAssetsSizePreferences(state.form.closest?.('[data-app-dialog]'), acknowledged);
    applySizePreviews(state);
  }

  const unchanged = state.userRevision === state.submissionRevision
    || state.userRevision === state.reopenRevision;
  if (!superseded && unchanged) {
    state.drafts = {
      global: { ...state.committed.global },
      project: { ...state.committed.project },
    };
    restoreLoadedScopeRadio(state.scopeControl, authoritative.activeScope);
    if (!applyDraft(state, authoritative.activeScope)) return false;
    clearScopeError(state.form);
  }
  renderSavedIndicator(state);
  return true;
}

function effectiveValues(state) {
  const scope = validScope(state.committedScope);
  return scope ? state.committed[scope] : null;
}

/**
 * The acknowledged effective grid style when it is the only effective default
 * that differs from what the live region last rendered; otherwise null, so
 * scope switches or any other changed default keep the full refresh.
 */
export function projectAssetsDefaultsGridStyleOnlyChange(form) {
  const state = states.get(form);
  const effective = state ? effectiveValues(state) : null;
  if (!effective || !state.rendered || effective.gridStyle === state.rendered.gridStyle) return null;
  const othersUnchanged = VALUE_KEYS.every((key) => key === 'gridStyle'
    || JSON.stringify(effective[key]) === JSON.stringify(state.rendered[key]));
  return othersUnchanged ? effective.gridStyle : null;
}

/** A copy of the acknowledged effective defaults, for a later rendered mark. */
export function projectAssetsDefaultsEffectiveSnapshot(form) {
  const state = states.get(form);
  const effective = state ? effectiveValues(state) : null;
  return effective ? { ...effective } : null;
}

/**
 * Records what the live region now displays. Callers mark only after an
 * in-place restyle or an installed refresh, never when a refresh merely
 * starts, so a failed or superseded refresh keeps the older baseline.
 */
export function markProjectAssetsDefaultsRendered(form, values = projectAssetsDefaultsEffectiveSnapshot(form)) {
  const state = states.get(form);
  if (state && values) state.rendered = { ...values };
}

/**
 * Correction A (F2): in the combined dialog Grid style is a current setting,
 * like the live filter controls. Its control and the rendered grid always
 * agree: the grid is restyled in place whenever the control takes a value (a
 * user's choice, a loaded scope, an acknowledged Save) and again whenever a
 * new region installs, since the server renders the saved style. Nothing is
 * written; only Save new defaults persists the style.
 */
function applyCurrentGridStyle(state) {
  if (!isLiveControlsForm(state.form)) return;
  state.restyleGrid(state.form.ownerDocument, String(state.fields.gridStyle?.value ?? ''));
}

/** For the Save refresh: its install must not undo a newer Grid style choice. */
export function applyProjectAssetsCurrentGridStyle(form) {
  const state = states.get(form);
  if (state) applyCurrentGridStyle(state);
}

// The style in use now: what the grid shows, or in List view (no grid) what
// the control holds.
function currentGridStyle(state) {
  return projectAssetsRenderedGridStyle(state.form.ownerDocument)
    || String(state.fields.gridStyle?.value ?? '');
}

/**
 * User acceptance correction: in the combined dialog the Grid and List size
 * defaults preview live, like Grid style. A size the user chooses there is the
 * one shown (now, or when its view next renders) until a newer authority
 * replaces it: an acknowledged Save or scope activation of that size, or the
 * page's own size control. A preview is never stored; the stored browser size
 * and the region's saved fallback still decide everything else, and a reload
 * ends it.
 */
const SIZE_KEYS = Object.freeze(['gridSize', 'listSize']);
const MANUAL_SIZE_CONTROLS = Object.freeze({
  gridSize: '[data-asset-grid-size-controls]',
  listSize: '[data-asset-list-size-controls]',
});

function applySizePreviews(state) {
  if (!isLiveControlsForm(state.form)) return;
  const document = state.form.ownerDocument;
  SIZE_KEYS.forEach((key) => {
    const size = state.sizePreview[key];
    if (size) state.previewSize[key](document, size);
  });
}

// The sizes in use now: a preview, else what the size controls resolve.
function currentSizes(state) {
  let resolved = {};
  try {
    resolved = state.resolveSizes(state.form.ownerDocument) || {};
  } catch { /* the controls keep their values */ }
  return Object.fromEntries(SIZE_KEYS.map((key) => [key, state.sizePreview[key] || resolved[key] || null]));
}

// The page's own Grid or List size control is a newer, stored choice.
function manualSizeKey(target) {
  const control = target?.closest?.('[data-grid-size-slider], [data-grid-size-option-label]');
  if (!control?.closest?.('[data-project-assets-live-region]')) return null;
  return SIZE_KEYS.find((key) => control.closest?.(MANUAL_SIZE_CONTROLS[key])) || null;
}

function restoreCommittedStateOnOpen(state) {
  const loadedScope = validScope(state.committedScope);
  state.pendingSubmission = null;
  if (!loadedScope) {
    showScopeError(state.form, 'Project Assets defaults scope could not be restored safely.');
    return false;
  }

  state.drafts = {
    global: { ...state.committed.global },
    project: { ...state.committed.project },
  };
  // Reopening discards the unsaved size defaults, but not the Grid style in
  // use: it is current presentation, so the dialog reopens showing it.
  if (isLiveControlsForm(state.form)) {
    const gridStyle = currentGridStyle(state);
    if (gridStyle) state.drafts[loadedScope].gridStyle = gridStyle;
    // The sizes in use are current presentation too.
    const sizes = currentSizes(state);
    SIZE_KEYS.forEach((key) => {
      if (sizes[key]) state.drafts[loadedScope][key] = sizes[key];
    });
  }
  state.loadedScope.value = loadedScope;
  restoreLoadedScopeRadio(state.scopeControl, loadedScope);
  const restored = applyDraft(state, loadedScope);
  // Reopening discards drafts; it is not a new user edit.
  if (restored) state.reopenRevision = state.userRevision;
  return restored;
}

function bindDialogHooks(state) {
  const dialogState = state.form.closest?.('[data-app-dialog]')?.__creatorCrateAppDialogState;
  if (!dialogState || state.dialogState === dialogState) return;

  state.dialogState = dialogState;
  const onOpen = dialogState.onOpen;
  dialogState.onOpen = (...args) => {
    onOpen?.(...args);
    restoreCommittedStateOnOpen(state);
  };

  const onSuccessfulSubmit = dialogState.onSuccessfulSubmit;
  dialogState.onSuccessfulSubmit = (payload) => {
    const result = onSuccessfulSubmit?.(payload);
    reconcileSuccessfulSubmission(state, payload);
    return result === true;
  };
}

// An explicit-save form never autosaves, so its programmatic application only
// reconciles each native select with its visible dropdown and sends no input
// or change event (WP6: one live refresh, no filter navigation, no write).
function applyDraft(state, targetScope) {
  const currentScope = validScope(state.loadedScope.value);
  const targetDraft = state.drafts[targetScope];
  if (!currentScope || !targetDraft || !draftIsRepresentable(state.fields, targetDraft)) return false;

  const previousValues = captureDraft(state.fields);
  const dispatchEvents = !isExplicitSaveForm(state.form);
  state.applying = true;
  const applyValues = (draft) => {
    VALUE_KEYS.forEach((key) => {
      const select = state.fields[key];
      const value = draft[key];
      if (MULTI_VALUE_KEYS.has(key) && select.multiple) {
        const selected = new Set(value === 'all' ? [] : value);
        Array.from(select.options || []).forEach((option) => {
          option.selected = selected.has(String(option.value ?? ''));
        });
      } else {
        select.value = value;
      }
      syncCreatorCrateDropdownFromNative(select);
      if (!dispatchEvents) return;
      dispatchNativeEvent(select, 'input');
      dispatchNativeEvent(select, 'change');
    });
  };

  try {
    suppressSettingsFetchSave(state.form, () => applyValues(targetDraft));
    state.loadedScope.value = targetScope;
    clearScopeError(state.form);
    return true;
  } catch {
    suppressSettingsFetchSave(state.form, () => applyValues(previousValues));
    return false;
  } finally {
    state.applying = false;
    // No change event is sent above, so the grid follows the control here.
    applyCurrentGridStyle(state);
  }
}

function isExplicitSaveForm(form) {
  return Boolean(form?.hasAttribute?.(EXPLICIT_SAVE_ATTRIBUTE));
}

function setScopeControlsBusy(state, busy) {
  state.scopeControl.querySelectorAll?.('input[name="scope"]').forEach((radio) => {
    radio.disabled = busy;
  });
  if (busy) state.scopeControl.setAttribute?.('aria-busy', 'true');
  else state.scopeControl.removeAttribute?.('aria-busy');
}

// The defaults save transport marks its form aria-busy for the whole of a
// pending or queued save (settings-fetch-save.js).
function defaultsSaveInFlight(form) {
  return form.getAttribute?.('aria-busy') === 'true';
}

function showActivationError(state, message) {
  showScopeError(state.form, message);
  setFetchSaveStatus(state.form, message, 'error');
}

function parseActivationAcknowledgement(payload) {
  if (!payload || payload.status !== 'success') return null;
  const activeScope = validScope(payload.activation?.activeScope);
  const global = scopeValues(payload.defaults?.global);
  const project = scopeValues(payload.defaults?.project);
  if (!activeScope || !global || !project) return null;
  if (payload.defaults.scope !== undefined && validScope(payload.defaults.scope) !== activeScope) return null;
  return { activeScope, global, project, savedDefaults: validSavedDefaults(payload.savedDefaults) };
}

async function readJson(response) {
  try {
    return typeof response?.json === 'function' ? await response.json() : null;
  } catch {
    return null;
  }
}

// Milestone 1 contract: 200 + valid JSON is the acknowledgement. A 4xx, or a
// JSON error without `activation`, wrote nothing. A 500 carrying `activation`
// committed but could not read back, and anything unreadable may have
// committed: both are reconciled by a read, never by repeating the POST.
async function classifyActivationResponse(response) {
  const payload = await readJson(response);
  if (response?.ok === true) {
    const acknowledgement = parseActivationAcknowledgement(payload);
    return acknowledgement ? { outcome: 'acknowledged', acknowledgement } : { outcome: 'uncertain' };
  }
  if (payload && typeof payload === 'object' && payload.activation) return { outcome: 'uncertain' };
  const status = Number(response?.status);
  if (status >= 400 && status < 500) return { outcome: 'failed' };
  if (payload?.status === 'error') return { outcome: 'failed' };
  return { outcome: 'uncertain' };
}

function activationBody(state, targetScope) {
  const body = new globalThis.URLSearchParams();
  const csrf = state.form.querySelector?.('input[name="_csrf"]')?.value;
  if (typeof csrf === 'string') body.set('_csrf', csrf);
  const returnTo = state.form.querySelector?.('input[name="returnTo"]')?.value;
  if (typeof returnTo === 'string' && returnTo !== '') body.set('returnTo', returnTo);
  // No default value field is ever sent: activation saves nothing (WP3).
  body.set('intent', ACTIVATE_SCOPE_INTENT);
  body.set('scope', targetScope);
  return body;
}

function formAction(form) {
  return form.action || form.getAttribute?.('action') || '';
}

// The Project Assets page renders the authoritative active scope and both
// resolved snapshots into this form; it is the existing read path.
function reconciliationUrl(state) {
  const returnTo = state.form.querySelector?.('input[name="returnTo"]')?.value;
  if (typeof returnTo === 'string' && returnTo !== '') return returnTo;
  return String(formAction(state.form)).replace(/\/defaults$/, '');
}

function refreshAfterActivation(state, authorityGeneration) {
  // WP7: the loaded values replace what the live controls show, so a filter
  // change made while the activation was pending (Category, Search, …) becomes
  // the base view instead of a reason to skip loading the scope's values.
  if (isLiveControlsForm(state.form)) {
    authorityGeneration = state.beginRefresh(state.form.ownerDocument);
  }
  const effective = effectiveValues(state);
  if (!effective) return;
  const snapshot = { ...effective };
  const presentationUnchanged = Boolean(state.rendered) && VALUE_KEYS.every((key) => (
    JSON.stringify(snapshot[key]) === JSON.stringify(state.rendered[key])
  ));
  const refreshFailed = () => setFetchSaveStatus(
    state.form,
    'Defaults scope changed, but Project Assets could not refresh. Refresh the page to see the loaded defaults.',
    'saved-refresh-error',
  );
  let outcome;
  try {
    outcome = state.refreshActivation(state.form.ownerDocument, authorityGeneration, snapshot, {
      presentationUnchanged,
      gridStyle: projectAssetsDefaultsGridStyleOnlyChange(state.form),
      onComplete: () => markProjectAssetsDefaultsRendered(state.form, snapshot),
      onError: refreshFailed,
    });
  } catch {
    outcome = 'unavailable';
  }
  if (outcome === 'applied') markProjectAssetsDefaultsRendered(state.form, snapshot);
  if (outcome === 'unavailable') refreshFailed();
}

// Installs an acknowledged (or read-confirmed) active scope. Unsaved edits are
// replaced by that scope's saved values unless the user edited again while the
// request was pending; newer edits are kept as unsaved drafts.
function finishActivation(state, activation, authoritative) {
  state.activation = null;
  state.unresolved = false;
  // F9: the scope is settled; a later activation sets its own boundary.
  state.recoveryOwnership = null;
  setScopeControlsBusy(state, false);
  const activeScope = authoritative.activeScope;
  state.committed = {
    global: { ...authoritative.global },
    project: { ...authoritative.project },
  };
  state.committedScope = activeScope;
  writeCommittedValues(state);
  state.loadedScope.value = activeScope;
  restoreLoadedScopeRadio(state.scopeControl, activeScope);
  state.drafts = {
    global: { ...state.committed.global },
    project: { ...state.committed.project },
  };

  if (authoritative.savedDefaults) writeSavedDefaults(state, authoritative.savedDefaults);
  const live = isLiveControlsForm(state.form);
  let keptNewer = false;
  let message = ACTIVATION_MESSAGES.loaded(activeScope);
  if (state.userRevision !== activation.revision) {
    keptNewer = true;
    if (live) syncMirrorsFromLive(state);
    state.drafts[activeScope] = captureDraft(state.fields);
    message = ACTIVATION_MESSAGES.keptNewer(activeScope);
    clearScopeError(state.form);
    state.needsReload = false;
  } else if (applyDraft(state, activeScope)) {
    // Loading saved values is not a user edit.
    state.reopenRevision = state.userRevision;
    clearScopeError(state.form);
    state.needsReload = false;
  } else {
    state.needsReload = true;
    message = null;
    showActivationError(state, ACTIVATION_MESSAGES.unrepresentable);
  }
  if (message) setFetchSaveStatus(state.form, message, 'saved');

  // The loaded scope's sizes replace any preview, unless the user edited again.
  // Correction F (F8): of kept edits, only a size previewed while this request
  // was pending is newer than it; an older preview is replaced like the rest.
  SIZE_KEYS.forEach((key) => {
    const previewedSince = state.sizePreviewRevision[key] !== activation.sizePreviewRevision?.[key];
    if (!keptNewer || !previewedSince) state.sizePreview[key] = null;
  });
  releaseProjectAssetsRetainedSizes(state.form.ownerDocument, state.committed[activeScope]);
  syncProjectAssetsSizePreferences(state.form.closest?.('[data-app-dialog]'), state.committed[activeScope]);
  applySizePreviews(state);
  if (live && keptNewer) syncKeptSizeFields(state, activeScope);
  renderSavedIndicator(state);
  // WP7: newer edits to the live controls stand; loading the scope's values
  // over them would discard what the user just chose.
  if (live && keptNewer) return;
  refreshAfterActivation(state, activation.authorityGeneration);
}

// Correction F (F8): newer edits kept through an activation keep the size
// fields' pre-activation values, while the presentation now shows the
// activated scope's sizes (or a newer preview). The fields and the active
// draft take the sizes in use, so a later Save sends what is shown. No event
// is sent and nothing is written.
function syncKeptSizeFields(state, activeScope) {
  const sizes = currentSizes(state);
  const draft = { ...state.drafts[activeScope] };
  SIZE_KEYS.forEach((key) => {
    if (sizes[key]) draft[key] = sizes[key];
  });
  if (SIZE_KEYS.every((key) => draft[key] === state.drafts[activeScope][key])) return;
  const previous = state.drafts[activeScope];
  state.drafts[activeScope] = draft;
  if (!applyDraft(state, activeScope)) state.drafts[activeScope] = previous;
}

function failActivation(state, message = ACTIVATION_MESSAGES.failed) {
  state.activation = null;
  setScopeControlsBusy(state, false);
  restoreLoadedScopeRadio(state.scopeControl, state.committedScope);
  showActivationError(state, message);
  renderSavedIndicator(state);
}

// Reads the authoritative scope after an uncertain activation, or when the user
// asks to check again after a read failed. It never POSTs.
// Correction G (F9): a check after a failed read is still the original
// activation's recovery, so it reuses that activation's edit and per-key size
// preview revisions (kept in state.recoveryOwnership); edits made since the
// activation began stay newer than the scope it resolves to.
function reconcileActivation(state, activation) {
  const document = state.form.ownerDocument;
  const recovery = state.recoveryOwnership;
  const owned = activation || {
    id: state.operationId += 1,
    targetScope: null,
    revision: recovery ? recovery.revision : state.userRevision,
    sizePreviewRevision: { ...(recovery ? recovery.sizePreviewRevision : state.sizePreviewRevision) },
    authorityGeneration: state.beginRefresh(document),
  };
  state.activation = owned;
  setScopeControlsBusy(state, true);
  setFetchSaveStatus(state.form, ACTIVATION_MESSAGES.checking, 'pending');

  const unresolved = () => {
    if (state.activation?.id !== owned.id) return;
    state.activation = null;
    state.unresolved = true;
    // F9: a failed read keeps the original boundary for the next check.
    state.recoveryOwnership = {
      revision: owned.revision,
      sizePreviewRevision: { ...owned.sizePreviewRevision },
    };
    setScopeControlsBusy(state, false);
    restoreLoadedScopeRadio(state.scopeControl, state.committedScope);
    showActivationError(state, ACTIVATION_MESSAGES.unresolved);
  };

  Promise.resolve().then(() => globalThis.fetch(reconciliationUrl(state), {
    method: 'GET',
    headers: { Accept: 'text/html' },
    credentials: 'same-origin',
    redirect: 'follow',
  })).then(async (response) => {
    if (state.activation?.id !== owned.id) return;
    const html = response?.ok === true && typeof response.text === 'function' ? await response.text() : '';
    if (state.activation?.id !== owned.id) return;
    const authoritative = parseResponseState(state.form, html);
    if (!authoritative) {
      unresolved();
      return;
    }
    const previousScope = validScope(state.committedScope);
    if (authoritative.activeScope !== previousScope) {
      finishActivation(state, owned, authoritative);
      return;
    }
    // Nothing changed: refresh the stored snapshots only, keep the controls.
    if (authoritative.savedDefaults) writeSavedDefaults(state, authoritative.savedDefaults);
    state.committed = {
      global: { ...authoritative.global },
      project: { ...authoritative.project },
    };
    writeCommittedValues(state);
    state.unresolved = false;
    state.recoveryOwnership = null;
    if (owned.targetScope) {
      failActivation(state);
      return;
    }
    state.activation = null;
    setScopeControlsBusy(state, false);
    restoreLoadedScopeRadio(state.scopeControl, previousScope);
    clearScopeError(state.form);
    setFetchSaveStatus(state.form, `${SCOPE_LABELS[previousScope]} defaults are active.`, 'saved');
  }).catch(unresolved);
}

function activateScope(state, targetScope) {
  const acknowledgedScope = validScope(state.committedScope);
  if (state.activation || state.resetting || !acknowledgedScope) {
    restoreLoadedScopeRadio(state.scopeControl, acknowledgedScope);
    return;
  }
  if (filtersResetPending(state)) {
    restoreLoadedScopeRadio(state.scopeControl, acknowledgedScope);
    setFetchSaveStatus(state.form, ACTIVATION_MESSAGES.filtersResetting, 'error');
    return;
  }
  if (state.unresolved) {
    restoreLoadedScopeRadio(state.scopeControl, acknowledgedScope);
    reconcileActivation(state, null);
    return;
  }
  if (!targetScope || targetScope === acknowledgedScope) {
    restoreLoadedScopeRadio(state.scopeControl, acknowledgedScope);
    return;
  }
  if (defaultsSaveInFlight(state.form)) {
    restoreLoadedScopeRadio(state.scopeControl, acknowledgedScope);
    setFetchSaveStatus(state.form, ACTIVATION_MESSAGES.saveBusy, 'error');
    return;
  }
  if (typeof globalThis.fetch !== 'function' || typeof globalThis.URLSearchParams !== 'function') {
    restoreLoadedScopeRadio(state.scopeControl, acknowledgedScope);
    showActivationError(state, ACTIVATION_MESSAGES.unavailable);
    return;
  }

  state.operationId += 1;
  const activation = {
    id: state.operationId,
    targetScope,
    revision: state.userRevision,
    sizePreviewRevision: { ...state.sizePreviewRevision },
    authorityGeneration: state.beginRefresh(state.form.ownerDocument),
  };
  state.activation = activation;
  // The requested radio stays checked as the visible request, but the
  // acknowledged scope (loadedScope) does not change until the server says so.
  setScopeControlsBusy(state, true);
  setFetchSaveStatus(state.form, ACTIVATION_MESSAGES.pending(targetScope), 'pending');

  Promise.resolve().then(() => globalThis.fetch(formAction(state.form), {
    method: 'POST',
    body: activationBody(state, targetScope),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    credentials: 'same-origin',
    redirect: 'follow',
  })).then(classifyActivationResponse).then((result) => {
    if (state.activation?.id !== activation.id) return;
    if (result.outcome === 'acknowledged') finishActivation(state, activation, result.acknowledgement);
    else if (result.outcome === 'failed') failActivation(state);
    else reconcileActivation(state, activation);
  }, () => {
    if (state.activation?.id === activation.id) reconcileActivation(state, activation);
  });
}

/**
 * WP6: why an explicit Save must not run now, or null. A Save never targets
 * a scope the server has not acknowledged: not while an activation or its
 * reconciliation is pending, not after an unconfirmed outcome, and not when
 * the checked scope differs from the acknowledged one.
 */
export function projectAssetsDefaultsSaveBlockedReason(form) {
  const state = states.get(form);
  if (!state || !isExplicitSaveForm(form)) return null;
  if (state.activation) return SAVE_BLOCKED_MESSAGES.activating;
  if (state.resetting) return SAVE_BLOCKED_MESSAGES.resetting;
  if (filtersResetPending(state)) return SAVE_BLOCKED_MESSAGES.filtersResetting;
  if (state.filtersResetIncomplete) return SAVE_BLOCKED_MESSAGES.filtersResetIncomplete;
  if (state.unresolved) return SAVE_BLOCKED_MESSAGES.unresolved;
  if (state.needsReload) return SAVE_BLOCKED_MESSAGES.reload;
  const acknowledgedScope = validScope(state.committedScope);
  const checkedScope = validScope(state.scopeControl.querySelector?.('input[name="scope"]:checked')?.value);
  if (!acknowledgedScope || checkedScope !== acknowledgedScope
    || validScope(state.loadedScope.value) !== acknowledgedScope) return SAVE_BLOCKED_MESSAGES.mismatch;
  return null;
}

/**
 * WP7: called by the explicit-save transport just before a Save is queued.
 * The combined dialog's mirrors take the live values, so the payload holds
 * exactly what the page shows. Returns a refusal message, or null.
 */
export function prepareProjectAssetsDefaultsSave(form) {
  const state = states.get(form);
  if (!state || !isLiveControlsForm(form)) return null;
  return syncMirrorsFromLive(state)
    ? null
    : 'The current settings cannot be saved as defaults. Your current changes were kept.';
}

function resetEndpoint(state) {
  const configured = state.resetControl?.getAttribute?.('data-reset-action');
  if (configured) return configured;
  return `${String(formAction(state.form)).replace(/\/$/, '')}/reset`;
}

function resetBody(state, scope) {
  const body = new globalThis.URLSearchParams();
  const csrf = state.form.querySelector?.('input[name="_csrf"]')?.value;
  if (typeof csrf === 'string') body.set('_csrf', csrf);
  const returnTo = state.form.querySelector?.('input[name="returnTo"]')?.value;
  if (typeof returnTo === 'string' && returnTo !== '') body.set('returnTo', returnTo);
  body.set('scope', scope);
  return body;
}

// Milestone 1 reset contract: 200 + `reset` + readable `defaults` is the
// acknowledgement; a 4xx, or an error without `reset`, wrote nothing; a 500
// with `reset` committed but could not read back; anything else may have.
async function classifyResetResponse(response) {
  const payload = await readJson(response);
  if (response?.ok === true && payload?.status === 'success' && payload.reset) {
    const activeScope = validScope(payload.defaults?.scope);
    const global = scopeValues(payload.defaults?.global);
    const project = scopeValues(payload.defaults?.project);
    if (!activeScope || !global || !project) return { outcome: 'unread' };
    return {
      outcome: 'acknowledged',
      reset: payload.reset,
      authoritative: { activeScope, global, project, savedDefaults: validSavedDefaults(payload.savedDefaults) },
    };
  }
  if (payload && typeof payload === 'object' && payload.reset) return { outcome: 'unread' };
  const status = Number(response?.status);
  if (status >= 400 && status < 500) return { outcome: 'failed' };
  if (payload?.status === 'error') return { outcome: 'failed' };
  return { outcome: 'uncertain' };
}

function filtersResetPending(state) {
  return isLiveControlsForm(state.form) && projectAssetsFiltersResetPending(state.form.ownerDocument) !== null;
}

/**
 * Package B: the Reset filters lifecycle (live-regions.js) as this form sees
 * it. 'started' records the edit boundary the Reset began at, the same
 * revision counters a scope activation uses: userRevision (any eligible
 * control or defaults-field edit) and sizePreviewRevision (each Grid/List
 * size preview). An edit counted after this boundary is newer than the Reset.
 * 'installed' syncs the Save mirrors to the restored live controls without
 * events (no implicit save, no activation, no browser storage).
 * Package C: 'installed' also restores Grid style and the Grid/List size
 * defaults (restoreFiltersResetPresentation), each from its own boundary.
 */
function onFiltersResetInstalled(state, reset) {
  syncMirrorsFromLive(state);
  // F13: a region installed without a confirmed scope (its response could not
  // establish one) leaves Save refused until a GET-only check confirms the
  // scope; nothing cached stands in for the response's values.
  if (!reset.destination) {
    state.unresolved = true;
    restoreLoadedScopeRadio(state.scopeControl, state.committedScope);
    showActivationError(state, ACTIVATION_MESSAGES.unresolved);
    renderSavedIndicator(state);
    return;
  }
  // F14: only an owning Reset (or its Retry) that installed its authoritative
  // response and restored the presentation from it ends an incomplete Reset.
  if (restoreFiltersResetPresentation(state, reset) && state.filtersResetIncomplete) {
    state.filtersResetIncomplete = false;
    setFetchSaveStatus(state.form, `${SCOPE_LABELS[state.committedScope]} defaults are active.`, 'saved');
  }
  renderSavedIndicator(state);
}

/**
 * F13: the Reset response is the server's current page, so its active scope
 * and resolved snapshots are authoritative. Another tab may have changed the
 * scope while the Reset was pending; that scope is adopted here, at the
 * prepared boundary before the region installs, so the restored controls,
 * the scope radios, the saved-state metadata and the next Save all name the
 * same scope. Nothing is written and no activation is sent. A response that
 * cannot establish its scope (or names another scope without its saved-state
 * metadata) is not accepted: returns false and the install fails closed.
 */
function acceptFiltersResetAuthority(state, destination) {
  if (!destination || !draftIsRepresentable(state.fields, destination.global)
    || !draftIsRepresentable(state.fields, destination.project)) return false;
  const activeScope = destination.activeScope;
  if (activeScope === validScope(state.committedScope)) return true;
  if (destination.savedDefaults?.activeScope !== activeScope) return false;
  state.committed = {
    global: { ...destination.global },
    project: { ...destination.project },
  };
  state.committedScope = activeScope;
  writeCommittedValues(state);
  writeSavedDefaults(state, destination.savedDefaults);
  state.loadedScope.value = activeScope;
  restoreLoadedScopeRadio(state.scopeControl, activeScope);
  state.drafts = {
    global: { ...state.committed.global },
    project: { ...state.committed.project },
  };
  state.drafts[activeScope] = captureDraft(state.fields);
  // F14: the adopted scope's controls and presentation are not on screen
  // until a Reset installs; until then the controls still show the previous
  // scope, so Save stays refused (through a failed install and failed
  // Retries) until an owning Reset installs (onFiltersResetInstalled).
  state.filtersResetIncomplete = true;
  clearScopeError(state.form);
  setFetchSaveStatus(state.form, `${SCOPE_LABELS[activeScope]} defaults are active.`, 'saved');
  renderSavedIndicator(state);
  return true;
}

// Package C: the presentation settings Reset filters restores. They never
// appear in Project Assets URLs, so the server cannot restore them through
// the region it renders; the installed Reset response names their values.
const PRESENTATION_KEYS = Object.freeze(['gridStyle', 'gridSize', 'listSize']);

// The active scope's resolved values (saved override, else inherited Global,
// else the application fallback) from the installed Reset response. F13: the
// response's scope was adopted when it was prepared, so it is the active one;
// cached values never stand in for the response's.
function filtersResetDestination(state, reset) {
  const scope = validScope(state.committedScope);
  const response = reset?.destination;
  if (!scope || !response || response.activeScope !== scope) return null;
  return response[scope];
}

/**
 * Package C: an installed Reset filters puts Grid style and the Grid/List size
 * defaults back to the active scope's saved/default values, like every other
 * control it restores. Each setting is restored only if the user has not
 * chosen it since the Reset began (its own revision against the Reset's
 * boundary), so a newer choice stands and the untouched ones are restored.
 * The fields, their dropdowns and the active draft take the restored values
 * without events, the grid is restyled in place, and each restored size is
 * shown as a current-session preview: even a size equal to the browser's or
 * the application's, so neither a stored manual size nor a retained Reset
 * defaults size can replace it on a later install. Nothing is written: no
 * defaults request and no browser storage.
 */
// F14: returns true only when the presentation now follows the response
// (restored, or every setting kept as a newer choice).
function restoreFiltersResetPresentation(state, reset) {
  if (!isLiveControlsForm(state.form) || !reset) return false;
  const scope = validScope(state.loadedScope.value);
  const destination = filtersResetDestination(state, reset);
  if (!scope || !destination) return false;
  const restored = {};
  if (state.gridStyleRevision === reset.gridStyleRevision) restored.gridStyle = destination.gridStyle;
  SIZE_KEYS.forEach((key) => {
    if (state.sizePreviewRevision[key] === reset.sizePreviewRevision?.[key]) restored[key] = destination[key];
  });
  const keys = PRESENTATION_KEYS.filter((key) => typeof restored[key] === 'string' && restored[key] !== '');
  if (keys.length === 0) return true;
  const previous = state.drafts[scope];
  const draft = captureDraft(state.fields);
  keys.forEach((key) => {
    draft[key] = restored[key];
  });
  state.drafts[scope] = draft;
  if (!applyDraft(state, scope)) {
    state.drafts[scope] = previous;
    return false;
  }
  const sizes = {};
  SIZE_KEYS.forEach((key) => {
    if (!keys.includes(key)) return;
    state.sizePreview[key] = restored[key];
    sizes[key] = restored[key];
  });
  // An older Reset defaults retention must not bring back a pre-Reset size.
  releaseProjectAssetsRetainedSizes(state.form.ownerDocument, sizes);
  applySizePreviews(state);
  return true;
}

// The edit boundary a Reset filters began at: userRevision (any eligible
// edit), each size's preview revision and the Grid style revision.
function filtersResetBoundary(state) {
  return {
    revision: state.userRevision,
    sizePreviewRevision: { ...state.sizePreviewRevision },
    gridStyleRevision: state.gridStyleRevision,
  };
}

function handleFiltersResetEvent(state, detail) {
  if (!detail || typeof detail.id !== 'number') return;
  if (detail.phase === 'started') {
    // Package C: a Retry (or a refresh re-reading a failed Reset) is still
    // that Reset, so it keeps the original boundary; an edit made while the
    // original was pending stays newer than it.
    const boundary = state.filtersResetRecovery || filtersResetBoundary(state);
    state.filtersResetRecovery = null;
    state.filtersReset = { id: detail.id, ...boundary, destination: null };
    return;
  }
  if (state.filtersReset?.id !== detail.id) return;
  if (detail.phase === 'prepared') {
    const destination = parseResponseDocument(detail.parsed);
    state.filtersReset.destination = acceptFiltersResetAuthority(state, destination) ? destination : null;
    return;
  }
  const reset = state.filtersReset;
  state.filtersReset = null;
  // F14: an adopted scope this Reset did not install keeps Save refused; the
  // status says so instead of the adoption's "defaults are active".
  if (detail.phase !== 'installed' && state.filtersResetIncomplete) {
    setFetchSaveStatus(state.form, SAVE_BLOCKED_MESSAGES.filtersResetIncomplete, 'error');
  }
  if (detail.phase === 'failed') {
    state.filtersResetRecovery = {
      revision: reset.revision,
      sizePreviewRevision: { ...reset.sizePreviewRevision },
      gridStyleRevision: reset.gridStyleRevision,
    };
    return;
  }
  if (detail.phase === 'installed') onFiltersResetInstalled(state, reset);
}

// Reset filters is refused, before the live engine sees the click, while a
// defaults operation could still change what it would render or capture.
function guardFiltersReset(state) {
  state.form.ownerDocument?.addEventListener?.('click', (event) => {
    const control = event.target?.closest?.(FILTERS_RESET_SELECTOR);
    if (!control) return;
    // Package C: a new Reset filters click is a new Reset, not a Retry, so it
    // takes its own boundary.
    if (!state.activation && !state.resetting && !defaultsSaveInFlight(state.form)) {
      state.filtersResetRecovery = null;
      return;
    }
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    setFetchSaveStatus(state.form, FILTERS_RESET_MESSAGES.busy, 'error');
  }, true);
}

function setResetBusy(state, busy) {
  state.resetting = busy;
  if (state.resetControl) {
    state.resetControl.disabled = busy;
    if (busy) state.resetControl.setAttribute?.('aria-busy', 'true');
    else state.resetControl.removeAttribute?.('aria-busy');
  }
  setScopeControlsBusy(state, busy);
}

// Correction B (F4): a displayed Tag/Extension selection that was the saved
// default until this reset is no longer inherited from anything once the
// active default differs from it; it stays on screen as the user's current
// selection, so its inherited mark is dropped. A selection the active default
// still equals stays inherited, and a suspended one (nothing displayed) keeps
// its mark so the active default returns with All Categories.
function reconcileInheritedMarksAfterReset(state) {
  if (!isLiveControlsForm(state.form)) return;
  const liveForm = liveFilterForm(state.form);
  const FormDataConstructor = state.form.ownerDocument?.defaultView?.FormData || globalThis.FormData;
  const effective = effectiveValues(state);
  if (!liveForm || !effective || typeof FormDataConstructor !== 'function') return;
  let data;
  try {
    data = new FormDataConstructor(liveForm);
  } catch {
    return;
  }
  liveInheritedKeys(liveForm).forEach((key) => {
    if (!MULTI_VALUE_KEYS.has(key)) return;
    const selected = liveSelectedMembers(data, key);
    if (selected.length > 0 && !sameValue(selected, effective[key])) dropLiveInheritedKey(liveForm, key);
  });
}

// Correction C (F5): the effective defaults the server builds Project Assets
// navigation against. A value equal to its effective default is left out of
// the rendered links, so a reset that changes one of these leaves them
// resolving to the newly inherited default. Grid style and the size defaults
// never appear in links.
const NAVIGATION_DEFAULT_KEYS = Object.freeze(['view', 'sort', 'order', 'pageSize', 'tag', 'extension']);

function navigationDefaultsChanged(previous, next) {
  if (!previous || !next) return true;
  return NAVIGATION_DEFAULT_KEYS.some((key) => !sameValue(previous[key], next[key]));
}

// Correction C (F5): after an acknowledged reset the current view is re-read
// against the defaults now persisted, through the post-mutation refresh: it
// owns the latest intended view (a debounced edit, an in-flight or failed
// load, or the idle form with its page), explicit in every value, so the
// server renders links that keep it. It keeps selection, category-order
// drafts, focus and scroll, and only ever GETs; a newer load wins and settles
// it. A failure keeps the reset committed and leaves the shared GET Retry.
function refreshAfterReset(state, scope, previousEffective) {
  if (!isLiveControlsForm(state.form)) return;
  const effective = effectiveValues(state);
  if (!navigationDefaultsChanged(previousEffective, effective)) return;
  const snapshot = { ...effective };
  const doneMessage = RESET_MESSAGES.done[scope];
  const installed = () => {
    markProjectAssetsDefaultsRendered(state.form, snapshot);
    const status = state.form.querySelector?.('[data-settings-fetch-save-status]');
    if (status?.textContent === RESET_MESSAGES.refreshFailed) {
      setFetchSaveStatus(state.form, doneMessage, 'saved');
    }
  };
  const failed = () => setFetchSaveStatus(state.form, RESET_MESSAGES.refreshFailed, 'saved-refresh-error');
  let pending;
  try {
    // F7: the rendered page and view links stay unavailable until a region
    // rendered after this reset installs; a failure leaves them so.
    pending = state.refreshAfterMutation(state.form.ownerDocument, {
      onRecovered: installed,
      staleNavigation: true,
    });
  } catch {
    pending = null;
  }
  if (!pending || typeof pending.then !== 'function') {
    failed();
    return;
  }
  pending.then((result) => {
    if (result?.status === 'installed') installed();
    else if (result?.status === 'failed' || result?.status === 'unavailable') failed();
  }, failed);
}

// A reset removes saved values only. The live controls, the results and any
// unsaved Grid style or size choice stay as they are; the scope radio follows
// the server (a Project-only reset makes Global active again).
function finishReset(state, scope, reset, authoritative) {
  const previousEffective = effectiveValues(state);
  state.committed = {
    global: { ...authoritative.global },
    project: { ...authoritative.project },
  };
  state.committedScope = authoritative.activeScope;
  writeCommittedValues(state);
  reconcileInheritedMarksAfterReset(state);
  if (authoritative.savedDefaults) writeSavedDefaults(state, authoritative.savedDefaults);
  state.loadedScope.value = authoritative.activeScope;
  restoreLoadedScopeRadio(state.scopeControl, authoritative.activeScope);
  state.drafts[authoritative.activeScope] = captureDraft(state.fields);
  clearScopeError(state.form);
  const changed = reset?.changed !== false;
  // F6: the sizes on screen stay as they are, without writing browser storage.
  if (changed && isLiveControlsForm(state.form)) {
    try {
      state.retainDisplayedSizes(state.form.ownerDocument, effectiveValues(state));
    } catch { /* the current region keeps its sizes until a later install */ }
  }
  setFetchSaveStatus(state.form, changed ? RESET_MESSAGES.done[scope] : RESET_MESSAGES.noop[scope], 'saved');
  renderSavedIndicator(state);
  if (changed) refreshAfterReset(state, scope, previousEffective);
}

async function resetDefaults(state) {
  const scope = validScope(state.committedScope);
  if (state.unresolved) {
    setFetchSaveStatus(state.form, SAVE_BLOCKED_MESSAGES.unresolved, 'error');
    return;
  }
  if (state.needsReload) {
    setFetchSaveStatus(state.form, SAVE_BLOCKED_MESSAGES.reload, 'error');
    return;
  }
  if (state.activation || state.resetting || defaultsSaveInFlight(state.form) || !scope) {
    setFetchSaveStatus(state.form, RESET_MESSAGES.busy, 'error');
    return;
  }
  if (filtersResetPending(state)) {
    setFetchSaveStatus(state.form, RESET_MESSAGES.filtersResetting, 'error');
    return;
  }
  if (typeof globalThis.fetch !== 'function' || typeof globalThis.URLSearchParams !== 'function') {
    setFetchSaveStatus(state.form, RESET_MESSAGES.unavailable, 'error');
    return;
  }
  let confirmed = false;
  try {
    confirmed = await state.confirm(state.form.ownerDocument, {
      title: `Reset ${SCOPE_LABELS[scope]} defaults`,
      message: RESET_MESSAGES.confirm[scope],
      confirmLabel: 'Reset defaults',
      opener: state.resetControl,
    });
  } catch {
    confirmed = false;
  }
  // A dismissed confirmation deletes nothing. A scope or operation that
  // changed meanwhile would make the confirmed wording untrue: not sent.
  if (!confirmed || validScope(state.committedScope) !== scope
    || state.activation || state.resetting || defaultsSaveInFlight(state.form)
    || filtersResetPending(state)) return;

  setResetBusy(state, true);
  setFetchSaveStatus(state.form, RESET_MESSAGES.pending(scope), 'pending');
  let result;
  try {
    const response = await globalThis.fetch(resetEndpoint(state), {
      method: 'POST',
      body: resetBody(state, scope),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      credentials: 'same-origin',
      redirect: 'follow',
    });
    result = await classifyResetResponse(response);
  } catch {
    result = { outcome: 'uncertain' };
  }
  setResetBusy(state, false);
  if (result.outcome === 'acknowledged') {
    finishReset(state, scope, result.reset, result.authoritative);
    return;
  }
  restoreLoadedScopeRadio(state.scopeControl, state.committedScope);
  if (result.outcome === 'failed') {
    setFetchSaveStatus(state.form, RESET_MESSAGES.failed, 'error');
    return;
  }
  // Possibly committed: never repeated, and Save stays refused until a reload.
  state.needsReload = true;
  setFetchSaveStatus(
    state.form,
    result.outcome === 'unread' ? RESET_MESSAGES.unread : RESET_MESSAGES.uncertain,
    'error',
  );
}

/**
 * Whether a pending operation owns a revision boundary that an explicit
 * re-choice of the option already shown must be counted against: an
 * activation or its unresolved recovery (F9), a pending Reset filters
 * (Package C), or a failed Reset filters whose GET-only Retry is still the
 * one on screen (F12). A Retry keeps that Reset's boundary, so a choice made
 * between attempts stays newer than it; once newer navigation supersedes the
 * Retry, the failed Reset owns nothing.
 */
function shownChoiceIntentEligible(state) {
  if (state.applying) return false;
  if (state.activation || state.unresolved || state.filtersReset) return true;
  if (!state.filtersResetRecovery) return false;
  if (projectAssetsFiltersResetRetryAvailable(state.form.ownerDocument)) return true;
  state.filtersResetRecovery = null;
  return false;
}

/**
 * Correction G (F9), Correction H (F10), F11, F12: choosing the option a
 * dropdown already shows sends no change. While a pending operation owns a
 * revision boundary (shownChoiceIntentEligible) it is still an explicit
 * choice made after that boundary, so it is recorded once, for this field
 * only, by record(value), instead of reading as an untouched field. A
 * different option takes the ordinary change path instead (at its click the
 * native field still holds the shown value, so nothing is recorded here).
 * Nothing is dispatched and no request is sent.
 */
function bindShownChoiceIntent(state, key, record) {
  const field = state.fields[key];
  const wrapper = field?.closest?.('[data-dialog-field]');
  if (!field || !wrapper) return;
  const isShownRadio = (input) => input?.type === 'radio' && !input.disabled
    && input.checked !== false && String(input.value ?? '') !== ''
    && String(input.value ?? '') === String(field.value ?? '');
  const recordShown = (input) => {
    if (!shownChoiceIntentEligible(state) || !isShownRadio(input)) return false;
    record(String(input.value));
    return true;
  };
  // Correction H (F10): Space on the checked radio is the keyboard form of
  // that choice, and browsers send no click for it (Chromium) or a click
  // after keyup (others). One press is recorded once, on keyup; held-key
  // repeats are not new presses, and a keyboard click for the press already
  // recorded is skipped.
  let spacePress = null;
  let keyboardRecorded = null;
  const isPlainSpace = (event) => event?.key === ' ' && !event.isComposing
    && !event.altKey && !event.ctrlKey && !event.metaKey;
  wrapper.addEventListener?.('keydown', (event) => {
    if (!isPlainSpace(event) || event.repeat) return;
    spacePress = event.target?.checked === true && isShownRadio(event.target) ? event.target : null;
  });
  wrapper.addEventListener?.('keyup', (event) => {
    if (!isPlainSpace(event)) return;
    const pressed = spacePress;
    spacePress = null;
    if (!pressed || event.target !== pressed || !recordShown(pressed)) return;
    keyboardRecorded = pressed;
    globalThis.setTimeout?.(() => {
      if (keyboardRecorded === pressed) keyboardRecorded = null;
    }, 0);
  });
  wrapper.addEventListener?.('click', (event) => {
    const input = event.target;
    if (keyboardRecorded && input === keyboardRecorded && !event.detail) {
      keyboardRecorded = null;
      return;
    }
    recordShown(input);
  });
}

function bindLiveControls(state) {
  const document = state.form.ownerDocument;
  document?.addEventListener?.('change', (event) => {
    const control = event.target;
    if (control?.form?.id !== LIVE_FILTER_FORM_ID) return;
    const name = control.name || control.getAttribute?.('name');
    // Only eligible defaults count as edits an activation must not overwrite;
    // Category, Search, Presence and Release usage are current-only.
    if (LIVE_KEYS.includes(name)) state.userRevision += 1;
    renderSavedIndicator(state);
  });
  document?.addEventListener?.(PROJECT_ASSETS_FILTERS_RESET_EVENT, (event) => {
    handleFiltersResetEvent(state, event?.detail);
  });
  guardFiltersReset(state);
  document?.addEventListener?.(PROJECT_ASSETS_REGION_LOADED_EVENT, () => {
    // F12: any other load that installs supersedes a failed Reset's Retry.
    if (!state.filtersReset) state.filtersResetRecovery = null;
    // A newly installed region carries the saved Grid style, so an unsaved
    // current choice is put back. When the control holds the acknowledged
    // style there is nothing unsaved, and the region's own style (kept by a
    // post-mutation refresh, or just rendered) stays authoritative.
    const gridStyle = String(state.fields.gridStyle?.value ?? '');
    if (gridStyle !== effectiveValues(state)?.gridStyle) applyCurrentGridStyle(state);
    // The installed region resolves stored sizes; a newer preview is put back.
    applySizePreviews(state);
    renderSavedIndicator(state);
  });
  // The native change the dropdown sends for a mouse or keyboard choice.
  state.fields.gridStyle?.addEventListener?.('change', () => {
    if (state.applying) return;
    // Package C: counts Grid style choices, so a Reset filters can tell one
    // made after it began from an older unsaved style.
    state.gridStyleRevision += 1;
    applyCurrentGridStyle(state);
  });
  // F11: re-choosing the shown Grid style is a choice made after the pending
  // operation began, exactly as for the sizes below.
  bindShownChoiceIntent(state, 'gridStyle', () => {
    state.userRevision += 1;
    state.gridStyleRevision += 1;
    applyCurrentGridStyle(state);
  });
  SIZE_KEYS.forEach((key) => {
    state.fields[key]?.addEventListener?.('change', () => {
      if (state.applying) return;
      state.sizePreviewRevision[key] += 1;
      state.sizePreview[key] = String(state.fields[key].value ?? '') || null;
      applySizePreviews(state);
    });
    // Correction G (F9): the same for this size only.
    bindShownChoiceIntent(state, key, (value) => {
      state.userRevision += 1;
      state.sizePreviewRevision[key] += 1;
      state.sizePreview[key] = value;
      applySizePreviews(state);
    });
  });
  const endManualSizePreview = (event) => {
    const key = manualSizeKey(event?.target);
    if (key) state.sizePreview[key] = null;
  };
  ['input', 'change', 'click'].forEach((type) => {
    document?.addEventListener?.(type, endManualSizePreview);
  });
  Object.values(state.fields).forEach((select) => {
    select.addEventListener?.('change', () => renderSavedIndicator(state));
  });
  state.resetControl?.addEventListener?.('click', (event) => {
    event.preventDefault?.();
    resetDefaults(state);
  });
}

export function enhanceProjectAssetsDefaultsScope(scope = globalThis.document, options = {}) {
  const form = scope?.querySelector?.(FORM_SELECTOR);
  if (!form || isEnhancementBound(form, 'projectAssetsDefaultsScopeBound')) return 0;

  const scopeControl = form.querySelector?.(SCOPE_SELECTOR);
  const loadedScope = form.querySelector?.(LOADED_SCOPE_SELECTOR);
  const valuesScript = form.querySelector?.(VALUES_SELECTOR);
  const values = parseValues(valuesScript);
  const fields = formFields(form);
  const currentScope = validScope(loadedScope?.value);
  if (!scopeControl || !loadedScope || !values || !fields || !currentScope) {
    showScopeError(form, 'Project Assets defaults scope could not be changed safely.');
    return 0;
  }

  const state = {
    form,
    scopeControl,
    loadedScope,
    valuesScript,
    fields,
    committed: {
      global: { ...values.global },
      project: { ...values.project },
    },
    drafts: {
      global: { ...values.global },
      project: { ...values.project },
    },
    applying: false,
    pendingSubmission: null,
    dialogState: null,
    committedScope: currentScope,
    rendered: { ...values[currentScope] },
    userRevision: 0,
    submissionRevision: null,
    reopenRevision: null,
    // WP6 explicit-save activation ownership.
    operationId: 0,
    activation: null,
    unresolved: false,
    // F9: the unresolved activation's revision boundary, kept across failed reads.
    recoveryOwnership: null,
    needsReload: false,
    beginRefresh: options.beginRefresh || beginProjectAssetsDefaultsLiveRefresh,
    refreshActivation: options.refreshActivation || refreshProjectAssetsWithLoadedDefaults,
    refreshAfterMutation: options.refreshAfterMutation || refreshProjectAssetsAfterMutation,
    restyleGrid: options.restyleGrid || restyleProjectAssetsGrid,
    sizePreview: { gridSize: null, listSize: null },
    // F8: counts size previews, so an activation can tell which are newer.
    sizePreviewRevision: { gridSize: 0, listSize: 0 },
    previewSize: {
      gridSize: options.previewGridSize || previewProjectAssetsGridSize,
      listSize: options.previewListSize || previewProjectAssetsListSize,
    },
    resolveSizes: options.resolveSizes || resolvedProjectAssetsSizes,
    retainDisplayedSizes: options.retainDisplayedSizes || retainProjectAssetsDisplayedSizes,
    // WP7 combined dialog.
    savedDefaults: parseSavedDefaultsScript(form.querySelector?.(SAVED_DEFAULTS_SELECTOR)),
    resetting: false,
    // Package B: the Reset filters this form saw start, with its edit boundary.
    filtersReset: null,
    // Package C: a failed Reset filters' boundary, reused by its Retry.
    filtersResetRecovery: null,
    // F14: a Reset adopted a scope it has not yet installed; Save is refused.
    filtersResetIncomplete: false,
    // Package C: counts Grid style choices (Reset filters ownership).
    gridStyleRevision: 0,
    resetControl: fieldRoot(form).querySelector?.(RESET_SELECTOR) || null,
    confirm: options.confirm || requestAppConfirmation,
  };
  states.set(form, state);
  const liveControls = isLiveControlsForm(form);
  if (liveControls) syncMirrorsFromLive(state);
  state.drafts[currentScope] = captureDraft(fields);
  if (liveControls) bindLiveControls(state);
  renderSavedIndicator(state);

  bindDialogHooks(state);
  form.ownerDocument?.addEventListener?.('click', () => bindDialogHooks(state));
  globalThis.queueMicrotask?.(() => bindDialogHooks(state));

  form.addEventListener?.('submit', () => {
    state.pendingSubmission = captureSuccessfulSubmission(state);
    bindDialogHooks(state);
  });

  Object.values(fields).forEach((select) => {
    const capture = () => {
      const activeScope = validScope(loadedScope.value);
      if (!state.applying && activeScope) {
        state.userRevision += 1;
        state.drafts[activeScope] = captureDraft(fields);
      }
    };
    select.addEventListener?.('input', capture);
    select.addEventListener?.('change', capture);
  });

  scopeControl.querySelectorAll?.('input[name="scope"]').forEach((radio) => {
    radio.addEventListener?.('change', () => {
      // WP6: an explicit-save form activates the chosen saved scope; only the
      // legacy autosave form keeps the draft-hydrate-and-save path below.
      if (isExplicitSaveForm(form)) {
        if (radio.checked) activateScope(state, validScope(radio.value));
        return;
      }
      const targetScope = validScope(radio.value);
      const activeScope = validScope(loadedScope.value);
      if (!targetScope || !activeScope || !radio.checked || targetScope === activeScope) return;
      state.drafts[activeScope] = captureDraft(fields);
      if (!applyDraft(state, targetScope)) {
        restoreLoadedScopeRadio(scopeControl, activeScope);
        showScopeError(form, 'Project Assets defaults scope could not be changed safely.');
        return;
      }
      state.userRevision += 1;
      queueSettingsFetchSave(state.fields.view);
    });
  });

  markEnhancementBound(form, 'projectAssetsDefaultsScopeBound');
  return 1;
}
