import { enhanceDropdowns } from './dropdowns.js';
import {
  captureRegionFocus,
  enhanceSettingsFetchSave,
  restoreRegionFocus,
} from './settings-fetch-save.js';

const PREFERENCE_REGION_SELECTOR = '[data-settings-asset-category-preference]';

function preferenceForms(scope) {
  if (!scope) return [];
  const forms = new Set();
  if (scope.matches?.(PREFERENCE_REGION_SELECTOR)) {
    scope.querySelectorAll?.('form').forEach((form) => forms.add(form));
  }
  scope.querySelectorAll?.(`${PREFERENCE_REGION_SELECTOR} form`).forEach((form) => forms.add(form));
  return [...forms];
}

function parseResponseHtml(form, html) {
  if (typeof html !== 'string' || html === '') return null;
  const DOMParser = form?.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (typeof DOMParser !== 'function') return null;
  return new DOMParser().parseFromString(html, 'text/html');
}

function currentPreferenceRegion(form) {
  return form?.closest?.(PREFERENCE_REGION_SELECTOR) || null;
}

function preferenceIdentity(region) {
  return region?.getAttribute?.('data-settings-asset-category-preference')
    || region?.dataset?.settingsAssetCategoryPreference
    || null;
}

function matchingPreferenceRegion(form, parsed) {
  const identity = preferenceIdentity(currentPreferenceRegion(form));
  if (!identity) return null;
  return [...(parsed?.querySelectorAll?.(PREFERENCE_REGION_SELECTOR) || [])]
    .find((region) => preferenceIdentity(region) === identity)
    || null;
}

function replacePreferenceRegion(form, html) {
  const parsed = parseResponseHtml(form, html);
  const current = currentPreferenceRegion(form);
  const next = matchingPreferenceRegion(form, parsed);
  if (!current || !next || !current.parentNode) return null;

  if (typeof current.replaceWith === 'function') current.replaceWith(next);
  else current.parentNode.replaceChild(next, current);
  return next;
}

function setReplacementStatus(region) {
  const form = region?.querySelector?.('form');
  const status = form?.querySelector?.('[data-settings-fetch-save-status]');
  if (!form || !status) return;
  form.setAttribute?.('data-settings-fetch-save-state', 'saved');
  status.setAttribute?.('role', 'status');
  status.setAttribute?.('aria-live', 'polite');
  status.setAttribute?.('aria-atomic', 'true');
  status.textContent = 'Settings saved.';
}

function enhanceReplacement(region) {
  if (!region) return;
  enhanceDropdowns(region);
  enhanceAssetCategoryPreferencesFetchSave(region);
}

function fetchSaveOptions() {
  return {
    onSuccess: ({ form, html, superseded = false }) => {
      if (superseded) return;
      const focus = captureRegionFocus(currentPreferenceRegion(form));
      const region = replacePreferenceRegion(form, html);
      setReplacementStatus(region);
      enhanceReplacement(region);
      restoreRegionFocus(region, focus);
    },
    onValidationError: ({ form, html, superseded = false }) => {
      if (superseded) return;
      const focus = captureRegionFocus(currentPreferenceRegion(form));
      const region = replacePreferenceRegion(form, html);
      enhanceReplacement(region);
      restoreRegionFocus(region, focus);
    },
  };
}

// Settings-only C7C adoption: forms retain native POST/no-JS behavior; this module
// only applies server-rendered response fragments after C7C completes a fetch save.
export function enhanceAssetCategoryPreferencesFetchSave(scope = globalThis.document) {
  let bound = 0;
  for (const form of preferenceForms(scope)) {
    bound += enhanceSettingsFetchSave(form, fetchSaveOptions());
  }
  return bound;
}
