import { enhanceDropdowns } from './dropdowns.js';
import {
  captureRegionFocus,
  enhanceSettingsFetchSave,
  restoreRegionFocus,
} from './settings-fetch-save.js';

const PREFERENCE_REGION_SELECTOR = '[data-settings-asset-category-preference]';

// WP11C-F2: dispatched (bubbling, cancelable) on a preference region before a
// save's answer replaces it, with detail { form, region, parsed, next, kind:
// 'saved' | 'refused', payload }. A page that knows the answer was rendered
// before something it already shows (a category default Delete on this page)
// cancels it, and the answer's render is then not installed.
export const ASSET_CATEGORY_PREFERENCE_ANSWER_EVENT = 'creatorcrate:asset-category-preference-answer';

// WP11C-F11: dispatched (bubbling, not cancelable) on a preference region
// when a save has settled and no answer render replaced the region: the
// answer was lost (network failure), unreadable (a 200 that is not the
// redirected Settings page), or not installed (cancelled, superseded, or
// without a matching region). detail { form, region, uncertain }: uncertain
// is true when the save may or may not have run (no answer was read), false
// for a refusal the server answered. Nothing here saves; a page that knows
// what can be chosen now reconciles the kept region's options. The event is
// dispatched after the form has left aria-busy, unless a queued save has
// already started (then that save owns the form, and its own settlement
// dispatches again).
export const ASSET_CATEGORY_PREFERENCE_SETTLED_EVENT = 'creatorcrate:asset-category-preference-settled';

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

function answerAccepted(form, parsed, kind, payload) {
  const region = currentPreferenceRegion(form);
  const CustomEventConstructor = form?.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
  if (!region || !parsed || typeof region.dispatchEvent !== 'function'
    || typeof CustomEventConstructor !== 'function') return true;
  return region.dispatchEvent(new CustomEventConstructor(ASSET_CATEGORY_PREFERENCE_ANSWER_EVENT, {
    bubbles: true,
    cancelable: true,
    detail: { form, region, parsed, next: matchingPreferenceRegion(form, parsed), kind, payload },
  }));
}

function settledWithoutAnswer(form, uncertain) {
  const region = currentPreferenceRegion(form);
  const CustomEventConstructor = form?.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
  if (!region || typeof region.dispatchEvent !== 'function'
    || typeof CustomEventConstructor !== 'function') return;
  region.dispatchEvent(new CustomEventConstructor(ASSET_CATEGORY_PREFERENCE_SETTLED_EVENT, {
    bubbles: true,
    detail: { form, region, uncertain },
  }));
}

function replacePreferenceRegion(form, parsed) {
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

// WP11C-B: a save is acknowledged only by its redirected Settings answer that
// renders this form's own preference region. Any other 200 (the login page
// after a logout, an unrelated page) is not an acknowledgement: fetch-save
// keeps the last acknowledged state and reports it as an error, and the
// refusal handler below settles it as uncertain (F11).
function preferenceAcknowledgement(form, { response, body }) {
  if (!response?.ok || !response.redirected) return null;
  return matchingPreferenceRegion(form, parseResponseHtml(form, body));
}

function fetchSaveOptions(form) {
  return {
    parseAcknowledgement: (answer) => preferenceAcknowledgement(form, answer),
    onSuccess: ({ form, html, payload, superseded = false }) => {
      if (superseded) return;
      const parsed = parseResponseHtml(form, html);
      if (!answerAccepted(form, parsed, 'saved', payload)) return;
      const focus = captureRegionFocus(currentPreferenceRegion(form));
      const region = replacePreferenceRegion(form, parsed);
      setReplacementStatus(region);
      enhanceReplacement(region);
      restoreRegionFocus(region, focus);
    },
    // WP11C-F11: a network failure (or an answer body that could not be
    // read) settles here with no answer to install.
    onError: ({ form, type, willContinue = false }) => {
      if (willContinue || type !== 'network') return;
      settledWithoutAnswer(form, true);
    },
    onValidationError: ({ form, html, payload, response, superseded = false }) => {
      if (!superseded) {
        const parsed = parseResponseHtml(form, html);
        if (answerAccepted(form, parsed, 'refused', payload)) {
          const focus = captureRegionFocus(currentPreferenceRegion(form));
          const region = replacePreferenceRegion(form, parsed);
          enhanceReplacement(region);
          restoreRegionFocus(region, focus);
          if (region) return;
        }
      }
      // WP11C-F11: no answer render was installed. A 200 that is not the
      // redirected Settings page cannot tell whether the save ran.
      settledWithoutAnswer(form, response?.ok === true);
    },
  };
}

// Settings-only C7C adoption: forms retain native POST/no-JS behavior; this module
// only applies server-rendered response fragments after C7C completes a fetch save.
export function enhanceAssetCategoryPreferencesFetchSave(scope = globalThis.document) {
  let bound = 0;
  for (const form of preferenceForms(scope)) {
    bound += enhanceSettingsFetchSave(form, fetchSaveOptions(form));
  }
  return bound;
}
