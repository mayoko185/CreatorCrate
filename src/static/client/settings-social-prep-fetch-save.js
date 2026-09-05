import {
  captureRegionFocus,
  enhanceSettingsFetchSave,
  restoreRegionFocus,
} from './settings-fetch-save.js';

const SOCIAL_PREP_REGION_SELECTOR = '[data-settings-social-prep-region]';

function socialPrepForms(scope) {
  if (!scope) return [];
  const forms = new Set();
  if (scope.matches?.(SOCIAL_PREP_REGION_SELECTOR)) {
    scope.querySelectorAll?.('form').forEach((form) => forms.add(form));
  }
  scope.querySelectorAll?.(`${SOCIAL_PREP_REGION_SELECTOR} form`).forEach((form) => forms.add(form));
  return [...forms];
}

function parseResponseHtml(form, html) {
  if (typeof html !== 'string' || html === '') return null;
  const DOMParser = form?.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (typeof DOMParser !== 'function') return null;
  return new DOMParser().parseFromString(html, 'text/html');
}

function replaceSocialPrepRegion(form, html) {
  const parsed = parseResponseHtml(form, html);
  const current = form?.closest?.(SOCIAL_PREP_REGION_SELECTOR) || null;
  const next = parsed?.querySelector?.(SOCIAL_PREP_REGION_SELECTOR);
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
  if (region) enhanceSocialPrepFetchSave(region);
}

function fetchSaveOptions() {
  return {
    onSuccess: ({ form, html, superseded = false }) => {
      if (superseded) return;
      const focus = captureRegionFocus(form?.closest?.(SOCIAL_PREP_REGION_SELECTOR));
      const region = replaceSocialPrepRegion(form, html);
      setReplacementStatus(region);
      enhanceReplacement(region);
      restoreRegionFocus(region, focus);
    },
    onValidationError: ({ form, html, superseded = false }) => {
      if (superseded) return;
      const focus = captureRegionFocus(form?.closest?.(SOCIAL_PREP_REGION_SELECTOR));
      const region = replaceSocialPrepRegion(form, html);
      enhanceReplacement(region);
      restoreRegionFocus(region, focus);
    },
  };
}

export function enhanceSocialPrepFetchSave(scope = globalThis.document) {
  let bound = 0;
  for (const form of socialPrepForms(scope)) {
    bound += enhanceSettingsFetchSave(form, fetchSaveOptions());
  }
  return bound;
}
