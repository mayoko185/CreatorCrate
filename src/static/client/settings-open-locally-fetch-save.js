import { isEnhancementBound, markEnhancementBound } from './dom.js';
import {
  captureRegionFocus,
  enhanceSettingsFetchSave,
  queueSettingsFetchSave,
  restoreRegionFocus,
} from './settings-fetch-save.js';

const OPEN_LOCALLY_FORM_SELECTOR = '#open-locally-save-form';
const OPEN_LOCALLY_PATH_SELECTOR = '[data-settings-open-locally-path]';
const OPEN_LOCALLY_REGION_SELECTOR = '[data-settings-open-locally-mapping-region]';
const FETCH_SAVE_STATUS_SELECTOR = '[data-settings-fetch-save-status]';

function openLocallyForms(scope) {
  if (!scope) return [];
  const forms = [];
  if (scope.matches?.(OPEN_LOCALLY_FORM_SELECTOR)) forms.push(scope);
  scope.querySelectorAll?.(OPEN_LOCALLY_FORM_SELECTOR).forEach((form) => forms.push(form));
  return forms;
}

function parseResponseHtml(form, html) {
  if (typeof html !== 'string' || html === '') return null;
  const DOMParser = form?.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (typeof DOMParser !== 'function') return null;
  return new DOMParser().parseFromString(html, 'text/html');
}

function currentMappingRegion(form) {
  return form?.closest?.(OPEN_LOCALLY_REGION_SELECTOR)
    || form?.ownerDocument?.querySelector?.(OPEN_LOCALLY_REGION_SELECTOR)
    || null;
}

function replaceMappingRegion(form, html) {
  const current = currentMappingRegion(form);
  const next = parseResponseHtml(form, html)?.querySelector?.(OPEN_LOCALLY_REGION_SELECTOR);
  if (!current || !next || !current.parentNode) return null;

  if (typeof current.replaceWith === 'function') current.replaceWith(next);
  else current.parentNode.replaceChild(next, current);
  return next;
}

function setReplacementStatus(region, message, state) {
  const form = region?.querySelector?.(OPEN_LOCALLY_FORM_SELECTOR);
  const status = form?.querySelector?.(FETCH_SAVE_STATUS_SELECTOR);
  if (!form || !status) return;
  form.setAttribute?.('data-settings-fetch-save-state', state);
  status.setAttribute?.('role', 'status');
  status.setAttribute?.('aria-live', 'polite');
  status.setAttribute?.('aria-atomic', 'true');
  status.textContent = message;
}

function enhanceReplacement(region) {
  if (!region) return;
  enhanceOpenLocallyFetchSave(region);
}

function submittedPath(payload) {
  return new globalThis.URLSearchParams(payload || '').get('windowsProjectsPath') || '';
}

function livePathValue(form) {
  const input = form?.ownerDocument?.querySelector?.(OPEN_LOCALLY_PATH_SELECTOR);
  return input ? String(input.value ?? '') : null;
}

function fetchSaveOptions() {
  return {
    onSuccess: ({ form, html, payload, superseded = false }) => {
      if (superseded) return;
      const current = currentMappingRegion(form);
      const focus = captureRegionFocus(current);
      const liveValue = livePathValue(form);
      const preserveLiveValue = liveValue !== null && liveValue !== submittedPath(payload);
      const region = replaceMappingRegion(form, html);
      const input = region?.querySelector?.(OPEN_LOCALLY_PATH_SELECTOR);
      if (preserveLiveValue && input) input.value = liveValue;
      setReplacementStatus(
        region,
        preserveLiveValue ? 'Current changes have not been saved.' : 'Settings saved.',
        preserveLiveValue ? 'unsaved' : 'saved',
      );
      enhanceReplacement(region);
      restoreRegionFocus(region, focus);
    },
    onValidationError: ({ form, html, payload, superseded = false }) => {
      if (superseded) return;
      const current = currentMappingRegion(form);
      const focus = captureRegionFocus(current);
      const liveValue = livePathValue(form);
      const preserveLiveValue = liveValue !== null && liveValue !== submittedPath(payload);
      const region = replaceMappingRegion(form, html);
      enhanceReplacement(region);
      const input = region?.querySelector?.(OPEN_LOCALLY_PATH_SELECTOR);
      if (preserveLiveValue && input) input.value = liveValue;
      setReplacementStatus(
        region,
        preserveLiveValue
          ? 'Could not save the submitted value. Current edits have not been saved.'
          : 'Could not save settings.',
        'error',
      );
      restoreRegionFocus(region, focus);
    },
  };
}

function bindSubmitInterception(form) {
  if (isEnhancementBound(form, 'settingsOpenLocallyFetchSaveBound')) return false;
  markEnhancementBound(form, 'settingsOpenLocallyFetchSaveBound');
  form.addEventListener('submit', (event) => {
    const control = form.ownerDocument?.querySelector?.(OPEN_LOCALLY_PATH_SELECTOR);
    if (queueSettingsFetchSave(control)) event.preventDefault();
  });
  return true;
}

// Open Locally keeps its real detached form controls for no-JS fallback. In JS,
// native Save and Enter feed the C7C state queue bound to the path control.
export function enhanceOpenLocallyFetchSave(scope = globalThis.document) {
  let bound = 0;
  for (const form of openLocallyForms(scope)) {
    const control = scope?.querySelector?.(OPEN_LOCALLY_PATH_SELECTOR)
      || form.ownerDocument?.querySelector?.(OPEN_LOCALLY_PATH_SELECTOR);
    if (control) {
      bound += enhanceSettingsFetchSave({ querySelectorAll: () => [control] }, fetchSaveOptions());
    }
    if (bindSubmitInterception(form)) bound += 1;
  }
  return bound;
}
