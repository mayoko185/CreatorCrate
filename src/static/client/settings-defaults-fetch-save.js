import { enhanceDropdowns } from './dropdowns.js';
import { enhanceNumberInputs } from './number-input.js';
import {
  captureRegionFocus,
  enhanceSettingsFetchSave,
  restoreRegionFocus,
} from './settings-fetch-save.js';

const DEFAULTS_FORM_SELECTOR = '#settings-defaults-form';
const DEFAULTS_REGION_SELECTOR = '[data-settings-defaults-region]';

function defaultsForms(scope) {
  if (!scope) return [];
  const forms = [];
  if (scope.matches?.(DEFAULTS_FORM_SELECTOR)) forms.push(scope);
  scope.querySelectorAll?.(DEFAULTS_FORM_SELECTOR).forEach((form) => forms.push(form));
  return forms;
}

function parseResponseHtml(form, html) {
  if (typeof html !== 'string' || html === '') return null;
  const DOMParser = form?.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (typeof DOMParser !== 'function') return null;
  return new DOMParser().parseFromString(html, 'text/html');
}

function currentDefaultsRegion(form) {
  return form?.closest?.(DEFAULTS_REGION_SELECTOR)
    || form?.ownerDocument?.querySelector?.(DEFAULTS_REGION_SELECTOR)
    || null;
}

function replaceDefaultsRegion(form, html) {
  const parsed = parseResponseHtml(form, html);
  const current = currentDefaultsRegion(form);
  const next = parsed?.querySelector?.(DEFAULTS_REGION_SELECTOR);
  if (!current || !next || !current.parentNode) return null;

  if (typeof current.replaceWith === 'function') current.replaceWith(next);
  else current.parentNode.replaceChild(next, current);
  return next;
}

function placeStatus(form, controlName) {
  const status = form?.querySelector?.('[data-settings-fetch-save-status]');
  const control = [...(form?.querySelectorAll?.('[data-autosubmit="fetch"]') || [])]
    .find((candidate) => candidate.name === controlName);
  const section = control?.closest?.('.settings-defaults-section');
  if (status && section) section.appendChild(status);
  return status;
}

function setReplacementStatus(region, controlName, message, state) {
  const form = region?.querySelector?.(DEFAULTS_FORM_SELECTOR);
  const status = placeStatus(form, controlName);
  if (!form || !status) return;
  form.setAttribute?.('data-settings-fetch-save-state', state);
  status.setAttribute?.('role', 'status');
  status.setAttribute?.('aria-live', 'polite');
  status.setAttribute?.('aria-atomic', 'true');
  status.textContent = message;
}

function enhanceReplacement(region) {
  if (!region) return;
  enhanceDropdowns(region);
  enhanceNumberInputs(region);
  enhanceDefaultsFetchSave(region);
}

function fetchSaveOptions() {
  return {
    onStart: ({ form, controlName }) => placeStatus(form, controlName),
    onSuccess: ({ form, html, controlName, superseded = false }) => {
      if (superseded) return;
      const focus = captureRegionFocus(currentDefaultsRegion(form));
      const region = replaceDefaultsRegion(form, html);
      setReplacementStatus(region, controlName, 'Settings saved.', 'saved');
      enhanceReplacement(region);
      restoreRegionFocus(region, focus);
    },
    onValidationError: ({ form, html, superseded = false }) => {
      if (superseded) return;
      const focus = captureRegionFocus(currentDefaultsRegion(form));
      const region = replaceDefaultsRegion(form, html);
      enhanceReplacement(region);
      restoreRegionFocus(region, focus);
    },
  };
}

// The Defaults page intentionally delegates request serialization and queueing
// to C7C. It only consumes server-rendered HTML for the page-specific DOM work.
export function enhanceDefaultsFetchSave(scope = globalThis.document) {
  let bound = 0;
  for (const form of defaultsForms(scope)) {
    bound += enhanceSettingsFetchSave(form, fetchSaveOptions());
  }
  return bound;
}
