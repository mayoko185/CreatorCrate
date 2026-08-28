import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { captureRegionFocus, restoreRegionFocus } from './settings-fetch-save.js';

const CATEGORY_DETAILS_FORM_SELECTOR = '[data-category-details-form]';
const CATEGORY_DETAILS_CONTROL_SELECTOR = 'input[name="displayName"], input[name="directorySlug"]';

function categoryDetailsEnhancementAvailable() {
  return typeof globalThis.fetch === 'function'
    && typeof globalThis.FormData === 'function'
    && typeof globalThis.URLSearchParams === 'function';
}

function detailsForms(scope) {
  if (!scope) return [];
  const forms = new Set();
  if (scope.matches?.(CATEGORY_DETAILS_FORM_SELECTOR)) forms.add(scope);
  scope.querySelectorAll?.(CATEGORY_DETAILS_FORM_SELECTOR).forEach((form) => forms.add(form));
  return [...forms];
}

function categoryDetailsIdentity(form) {
  return form?.getAttribute?.('data-category-details-id')
    || form?.dataset?.categoryDetailsId
    || null;
}

function parseResponseHtml(form, html) {
  if (typeof html !== 'string' || html === '') return null;
  const DOMParser = form?.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (typeof DOMParser !== 'function') return null;
  return new DOMParser().parseFromString(html, 'text/html');
}

function matchingDetailsForm(form, parsed) {
  const identity = categoryDetailsIdentity(form);
  if (!identity) return null;
  return [...(parsed?.querySelectorAll?.(CATEGORY_DETAILS_FORM_SELECTOR) || [])]
    .find((candidate) => categoryDetailsIdentity(candidate) === identity)
    || null;
}

function replaceDetailsForm(form, html) {
  const next = matchingDetailsForm(form, parseResponseHtml(form, html));
  if (!next || !form?.parentNode) return null;

  if (typeof form.replaceWith === 'function') form.replaceWith(next);
  else form.parentNode.replaceChild(next, form);
  return next;
}

async function responseHtml(response) {
  if (typeof response?.text !== 'function') return '';
  return response.text();
}

function setDetailsStatus(form, message, state) {
  form?.setAttribute?.('data-category-details-state', state);
  const status = form?.querySelector?.('[data-category-details-status]');
  if (!status) return;
  status.setAttribute?.('role', 'status');
  status.setAttribute?.('aria-live', 'polite');
  status.setAttribute?.('aria-atomic', 'true');
  status.textContent = message;
}

function captureUnsentDetailValues(form, submittedBody) {
  const unsentValues = new Map();
  form?.querySelectorAll?.(CATEGORY_DETAILS_CONTROL_SELECTOR).forEach((control) => {
    if (control.value !== submittedBody?.get?.(control.name)) {
      unsentValues.set(control.name, control.value);
    }
  });
  return unsentValues;
}

function restoreUnsentDetailValues(form, unsentValues) {
  form?.querySelectorAll?.(CATEGORY_DETAILS_CONTROL_SELECTOR).forEach((control) => {
    if (unsentValues.has(control.name)) control.value = unsentValues.get(control.name);
  });
}

function replaceAndEnhanceDetailsForm(form, html, { focus = false, submittedBody, message, state } = {}) {
  const capturedFocus = focus ? captureRegionFocus(form) : null;
  const unsentValues = submittedBody ? captureUnsentDetailValues(form, submittedBody) : new Map();
  const next = replaceDetailsForm(form, html);
  if (!next) return null;
  restoreUnsentDetailValues(next, unsentValues);
  enhanceCategoryDetails(next);
  if (message) setDetailsStatus(next, message, state);
  if (capturedFocus) restoreRegionFocus(next, capturedFocus);
  return { form: next, hasUnsentValues: unsentValues.size > 0 };
}

// Settings category details retain their native POST/no-JS path. JavaScript
// saves complete field payloads in sequence and applies only the matching
// server-rendered details form, never the surrounding category list or Add form.
export function enhanceCategoryDetails(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const forms = detailsForms(scope);
  forms.forEach((form) => {
    if (isEnhancementBound(form, 'categoryDetailsBound')) return;
    if (!categoryDetailsEnhancementAvailable()) return;
    markEnhancementBound(form, 'categoryDetailsBound');

    let pending = false;
    let activePayload = '';
    let queuedPayload = null;

    const startSave = (request) => {
      pending = true;
      activePayload = request.payload;
      form.setAttribute?.('aria-busy', 'true');
      setDetailsStatus(form, 'Saving category details.', 'pending');

      const action = form.action || form.getAttribute?.('action');
      const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();
      Promise.resolve().then(() => globalThis.fetch(action, {
        method,
        body: request.body,
        credentials: 'same-origin',
        redirect: 'follow',
      })).then(async (response) => {
        const html = await responseHtml(response);
        const nextRequest = queuedPayload;
        pending = false;
        activePayload = '';
        queuedPayload = null;

        if (nextRequest) {
          startSave(nextRequest);
          return;
        }

        form.removeAttribute?.('aria-busy');
        if (!response?.ok || !response.redirected) {
          if (!replaceAndEnhanceDetailsForm(form, html, {
            focus: true,
            submittedBody: request.body,
            message: 'Could not save category details. Current changes have not been saved.',
            state: 'error',
          })) {
            setDetailsStatus(form, 'Could not save category details. Your current changes were kept.', 'error');
          }
          return;
        }

        const replacement = replaceAndEnhanceDetailsForm(form, html, {
          focus: true,
          submittedBody: request.body,
          state: 'saved',
        });
        if (!replacement) {
          setDetailsStatus(form, 'Details saved.', 'saved');
          return;
        }
        setDetailsStatus(
          replacement.form,
          replacement.hasUnsentValues ? 'Current changes have not been saved.' : 'Details saved.',
          'saved',
        );
      }).catch(() => {
        const nextRequest = queuedPayload;
        pending = false;
        activePayload = '';
        queuedPayload = null;
        if (nextRequest) {
          startSave(nextRequest);
          return;
        }

        form.removeAttribute?.('aria-busy');
        setDetailsStatus(form, 'Could not save category details. Your current changes were kept.', 'error');
      });
    };

    const save = () => {
      const body = new globalThis.URLSearchParams(new globalThis.FormData(form));
      const payload = body.toString();
      if (pending) {
        queuedPayload = payload === activePayload ? null : { body, payload };
        return;
      }
      startSave({ body, payload });
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault?.();
      save();
    });
    form.querySelectorAll?.(CATEGORY_DETAILS_CONTROL_SELECTOR).forEach((control) => {
      control.addEventListener('change', save);
    });
  });
  return forms.length;
}
