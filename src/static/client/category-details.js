import { isEnhancementBound, markEnhancementBound } from './dom.js';

const CATEGORY_DETAILS_FORM_SELECTOR = '[data-category-details-form]';

// In-place submit for the Settings "Save details" form. A native submit does a
// POST→redirect→GET, which reloads the whole page and jumps the scroll position
// back to the top. Instead we POST via fetch: on success the server issues its
// redirect (response.redirected === true) and the edited values are already in
// the inputs, so we just show a saved status without navigating. On a validation
// error the server re-renders the page directly (no redirect), so we fall back to
// a native submit to surface the server-rendered error state. The <noscript>-free
// native submit remains the behavior when fetch/FormData/URLSearchParams are
// unavailable.
export function enhanceCategoryDetails(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const forms = scope.querySelectorAll(CATEGORY_DETAILS_FORM_SELECTOR);
  forms.forEach((form) => {
    if (isEnhancementBound(form, 'categoryDetailsBound')) return;
    markEnhancementBound(form, 'categoryDetailsBound');

    let pending = false;
    form.addEventListener('submit', (event) => {
      if (pending) {
        event.preventDefault?.();
        return;
      }
      if (typeof globalThis.fetch !== 'function' || typeof globalThis.FormData !== 'function'
        || typeof globalThis.URLSearchParams !== 'function') {
        return; // No enhancement available — let the native submit proceed.
      }

      event.preventDefault?.();
      pending = true;
      const status = form.querySelector?.('[data-category-details-status]');
      form.setAttribute?.('aria-busy', 'true');
      form.setAttribute?.('data-category-details-state', 'pending');
      if (status) status.textContent = 'Saving category details.';

      const action = form.action || form.getAttribute?.('action');
      const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();
      globalThis.fetch(action, {
        method,
        body: new globalThis.URLSearchParams(new globalThis.FormData(form)),
        credentials: 'same-origin',
        redirect: 'follow',
      }).then((response) => {
        if (response?.ok && response.redirected) {
          pending = false;
          form.removeAttribute?.('aria-busy');
          form.removeAttribute?.('data-category-details-state');
          if (status) status.textContent = 'Details saved.';
          return;
        }
        // Validation or other non-redirect response: submit natively so the
        // server-rendered error state is shown.
        form.submit?.();
      }).catch(() => {
        form.submit?.();
      });
    });
  });
  return forms.length;
}
