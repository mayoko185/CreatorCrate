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
    // Never rewrites a value that is already shown: a programmatic write
    // moves the caret and resets what the browser compares on change.
    if (unsentValues.has(control.name) && control.value !== unsentValues.get(control.name)) {
      control.value = unsentValues.get(control.name);
    }
  });
}

// WP11C-F4: the name or slug the person is in when an answer arrives.
function focusedDetailsControl(form) {
  const active = form?.ownerDocument?.activeElement;
  if (!active || active === form || typeof form.contains !== 'function' || !form.contains(active)) return null;
  return active.matches?.(CATEGORY_DETAILS_CONTROL_SELECTOR) ? active : null;
}

// The elements from `control` up to (not including) `container`, outermost first.
function pathWithin(container, control) {
  const path = [];
  let node = control;
  while (node && node !== container) {
    path.unshift(node);
    node = node.parentElement;
  }
  return node === container ? path : null;
}

function syncAttributes(element, source) {
  [...element.attributes].forEach(({ name }) => {
    if (!source.hasAttribute(name)) element.removeAttribute(name);
  });
  [...source.attributes].forEach(({ name, value }) => {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  });
}

// WP11C-F4: installs the answer's details form into the current one while
// the control the person is typing in never leaves the page. Taking a
// focused, edited field out of the page makes Chromium end that edit (change,
// blur, focusout), and change saves, so an older answer would send the newer
// typing by itself. Instead the form element and the focused control's own
// ancestors stay; everything else is the answer's markup, and the kept
// elements take the answer's attributes (its saved value as the control's
// default value, its error state). The person's typed value, caret and the
// browser's pending change stay, so a later real Tab or Enter still saves.
// Returns false when the answer has no matching form or another shape.
function installDetailsAroundFocus(form, html, control) {
  const next = matchingDetailsForm(form, parseResponseHtml(form, html));
  if (!next) return false;
  const kept = pathWithin(form, control);
  const counterpart = [...next.querySelectorAll(CATEGORY_DETAILS_CONTROL_SELECTOR)]
    .find((candidate) => candidate.name === control.name);
  const incoming = counterpart ? pathWithin(next, counterpart) : null;
  if (!kept || !incoming || kept.length !== incoming.length
    || kept.some((element, index) => element.tagName !== incoming[index].tagName)) return false;

  kept.forEach((keptElement, index) => {
    const parent = index === 0 ? form : kept[index - 1];
    const source = index === 0 ? next : incoming[index - 1];
    [...parent.childNodes].forEach((child) => { if (child !== keptElement) child.remove(); });
    let before = true;
    [...source.childNodes].forEach((child) => {
      if (child === incoming[index]) { before = false; return; }
      if (before) parent.insertBefore(child, keptElement);
      else parent.appendChild(child);
    });
    syncAttributes(keptElement, incoming[index]);
  });
  return true;
}

// WP11C-F7: every value shown, by field name, kept as it is. A stale refusal
// means none of it was saved, typed before or after the request.
function shownDetailValues(form) {
  const shown = new Map();
  form?.querySelectorAll?.(CATEGORY_DETAILS_CONTROL_SELECTOR).forEach((control) => shown.set(control.name, control.value));
  return shown;
}

// WP11C-F7: the saved details the form is based on (hidden, rendered from the
// database row), as field name -> value.
function reviewedDetailValues(form) {
  const reviewed = new Map();
  form?.querySelectorAll?.('input[data-category-details-reviewed]').forEach((input) => {
    reviewed.set(input.getAttribute('data-category-details-reviewed'), input.value);
  });
  return reviewed;
}

// WP11C-F7: after a stale refusal the saved baseline is what the server says
// is saved now, never the refused values. Setting the default value of a
// field the person has typed in leaves its value, caret and pending change.
function adoptReviewedBaseline(form) {
  const reviewed = reviewedDetailValues(form);
  form?.querySelectorAll?.(CATEGORY_DETAILS_CONTROL_SELECTOR).forEach((control) => {
    if (reviewed.has(control.name) && control.defaultValue !== reviewed.get(control.name)) {
      control.defaultValue = reviewed.get(control.name);
    }
  });
}

function replaceAndEnhanceDetailsForm(form, html, { focus = false, submittedBody, stale = false, message, state, bindControls } = {}) {
  const unsentValues = stale ? shownDetailValues(form)
    : submittedBody ? captureUnsentDetailValues(form, submittedBody) : new Map();
  const newerValues = stale && submittedBody ? captureUnsentDetailValues(form, submittedBody) : unsentValues;
  const control = focus ? focusedDetailsControl(form) : null;
  if (control) {
    const shownValue = control.value;
    if (installDetailsAroundFocus(form, html, control)) {
      if (stale) adoptReviewedBaseline(form);
      // The submitted value now shows as the server answered it; a newer
      // unsent value is left exactly as typed.
      if (!unsentValues.has(control.name) && control.value !== control.defaultValue && control.value === shownValue) {
        control.value = control.defaultValue;
      }
      restoreUnsentDetailValues(form, unsentValues);
      bindControls?.();
      if (message) setDetailsStatus(form, message, state);
      return { form, hasUnsentValues: newerValues.size > 0 };
    }
  }
  const capturedFocus = focus ? captureRegionFocus(form) : null;
  const next = replaceDetailsForm(form, html);
  if (!next) return null;
  if (stale) adoptReviewedBaseline(next);
  restoreUnsentDetailValues(next, unsentValues);
  enhanceCategoryDetails(next);
  if (message) setDetailsStatus(next, message, state);
  if (capturedFocus) restoreRegionFocus(next, capturedFocus);
  return { form: next, hasUnsentValues: newerValues.size > 0 };
}

// WP11C-F7: the answer refuses the save because the category changed
// elsewhere (it carries the details form marked stale).
function staleDetailsAnswer(form, response, html) {
  if (response?.status !== 409) return false;
  return matchingDetailsForm(form, parseResponseHtml(form, html))
    ?.getAttribute?.('data-category-details-conflict') === 'stale';
}

// WP11C-F7: a save queued behind one the server just committed is based on
// what that one saved (the server trims the name exactly like this), not on
// what the form showed when it was queued. It is still refused if anything
// else saved in between.
function chainReviewedDetails(nextBody, committedBody) {
  const displayName = committedBody?.get?.('displayName');
  const directorySlug = committedBody?.get?.('directorySlug');
  if (typeof displayName !== 'string' || typeof directorySlug !== 'string') return;
  nextBody.set('reviewedDisplayName', displayName.trim());
  nextBody.set('reviewedDirectorySlug', directorySlug);
}

// WP11C-A: a host that owns the page's category list (Settings category
// Delete) is told when each save's request is sent and when its answer is
// installed, so it can tell what that answer is evidence of. A new form node
// is not newer evidence by itself: the request may have been answered before
// a list read the host installed meanwhile. One per document; none elsewhere.
const detailsLifecycles = new WeakMap();

/** Registers `{ requestStarted(form) -> token, answerInstalled(form, token) }` for `document`. */
export function setCategoryDetailsLifecycle(document, lifecycle) {
  if (document) detailsLifecycles.set(document, lifecycle);
}

function detailsLifecycle(form) {
  return detailsLifecycles.get(form?.ownerDocument) || null;
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
    // WP11C-F4: an answer installed around a focused control keeps this form,
    // so the answer's new controls are bound here, each exactly once.
    const boundControls = new WeakSet();
    const bindControls = () => {
      form.querySelectorAll?.(CATEGORY_DETAILS_CONTROL_SELECTOR).forEach((control) => {
        if (boundControls.has(control)) return;
        boundControls.add(control);
        control.addEventListener('change', save);
      });
    };

    const startSave = (request) => {
      pending = true;
      activePayload = request.payload;
      form.setAttribute?.('aria-busy', 'true');
      setDetailsStatus(form, 'Saving category details.', 'pending');

      const action = form.action || form.getAttribute?.('action');
      const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();
      // WP11C-A: what the host knew when this request was sent.
      let started = null;
      const installed = (installedForm) => detailsLifecycle(form)?.answerInstalled?.(installedForm, started);
      Promise.resolve().then(() => {
        started = detailsLifecycle(form)?.requestStarted?.(form) ?? null;
        return globalThis.fetch(action, {
          method,
          body: request.body,
          credentials: 'same-origin',
          redirect: 'follow',
        });
      }).then(async (response) => {
        const html = await responseHtml(response);
        const nextRequest = queuedPayload;
        pending = false;
        activePayload = '';
        queuedPayload = null;

        if (nextRequest) {
          if (response?.ok && response.redirected) {
            chainReviewedDetails(nextRequest.body, request.body);
            nextRequest.payload = nextRequest.body.toString();
          }
          startSave(nextRequest);
          return;
        }

        form.removeAttribute?.('aria-busy');
        if (staleDetailsAnswer(form, response, html)) {
          const stale = replaceAndEnhanceDetailsForm(form, html, {
            focus: true,
            submittedBody: request.body,
            stale: true,
            bindControls,
          });
          const message = stale?.hasUnsentValues
            ? 'This category was changed somewhere else, so the earlier details were not saved. Current changes have not been saved either. Review the saved details, then save again.'
            : 'This category was changed somewhere else, so these details were not saved. Review the saved details, then save again.';
          setDetailsStatus(stale?.form || form, message, 'stale');
          if (stale) installed(stale.form);
          return;
        }
        if (!response?.ok || !response.redirected) {
          const refused = replaceAndEnhanceDetailsForm(form, html, {
            focus: true,
            submittedBody: request.body,
            state: 'error',
            bindControls,
          });
          if (!refused) {
            setDetailsStatus(form, 'Could not save category details. Your current changes were kept.', 'error');
            return;
          }
          // WP11C-F4: the refusal belongs to the submitted values, not to
          // anything typed after them.
          setDetailsStatus(
            refused.form,
            refused.hasUnsentValues
              ? 'Could not save the earlier category details. Current changes have not been saved.'
              : 'Could not save category details. Current changes have not been saved.',
            'error',
          );
          installed(refused.form);
          return;
        }

        const replacement = replaceAndEnhanceDetailsForm(form, html, {
          focus: true,
          submittedBody: request.body,
          state: 'saved',
          bindControls,
        });
        if (!replacement) {
          setDetailsStatus(form, 'Details saved.', 'saved');
          return;
        }
        // WP11C-F4: the submitted values are saved; anything typed after them
        // is not, and says so.
        setDetailsStatus(
          replacement.form,
          replacement.hasUnsentValues ? 'Earlier changes saved. Current changes have not been saved.' : 'Details saved.',
          'saved',
        );
        installed(replacement.form);
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
    bindControls();
  });
  return forms.length;
}
