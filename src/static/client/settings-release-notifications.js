import {
  captureRegionFocus,
  enhanceSettingsFetchSave,
  restoreRegionFocus,
} from './settings-fetch-save.js';
import { isEnhancementBound, markEnhancementBound, setHidden } from './dom.js';
import { enhanceNumberInputs } from './number-input.js';
import { enhanceTimePickers } from './pickers.js';

const REGION_SELECTOR = '[data-settings-release-notifications-region]';
const SETTINGS_FORM_SELECTOR = '#release-notifications-form';
const TEST_FORM_SELECTOR = '[data-release-notification-test-form]';
const TEST_FAILURE_MESSAGE = 'Could not send the test notification. Try again.';

function regions(scope) {
  if (!scope) return [];
  const found = new Set();
  if (scope.matches?.(REGION_SELECTOR)) found.add(scope);
  scope.querySelectorAll?.(REGION_SELECTOR).forEach((region) => found.add(region));
  return [...found];
}

function parseHtml(document, html) {
  if (typeof html !== 'string' || html === '') return null;
  const DOMParser = document?.defaultView?.DOMParser || globalThis.DOMParser;
  if (typeof DOMParser !== 'function') return null;
  return new DOMParser().parseFromString(html, 'text/html');
}

function isChecked(form, name) {
  return form.querySelector?.(`input[type="checkbox"][name="${name}"]`)?.checked === true;
}

function detail(form, key) {
  return form.querySelector?.(`[data-release-notification-detail="${key}"]`) || null;
}

/**
 * Show timing sub-controls only for enabled reminders. Hidden controls still
 * submit, which the core validator expects. The overdue block stays visible
 * while a repeat is on so that an invalid repeat-without-overdue state can
 * still be corrected in place.
 */
export function syncReleaseNotificationTiming(form) {
  if (!form) return;
  setHidden(detail(form, 'advance'), !isChecked(form, 'advanceEnabled'));
  setHidden(detail(form, 'overdue'), !isChecked(form, 'overdueEnabled') && !isChecked(form, 'repeatEnabled'));
  setHidden(detail(form, 'repeat'), !isChecked(form, 'repeatEnabled'));
}

function channelStatus(document, channel) {
  return document?.querySelector?.(`[data-release-notification-channel-status="${channel}"]`) || null;
}

async function sendTest(form) {
  const document = form.ownerDocument || globalThis.document;
  const channel = form.getAttribute?.('data-release-notification-test-form');
  const current = channelStatus(document, channel);
  const button = current?.querySelector?.('[data-release-notification-test-button]');
  const status = current?.querySelector?.('[data-release-notification-test-status]');
  if (!current || !button || button.disabled) return;
  // Read before disabling: a disabled button drops focus.
  const restoreFocus = current.contains?.(document.activeElement);

  // Blocks accidental repeat clicks only; the server serializes real sends.
  button.disabled = true;
  button.setAttribute?.('aria-busy', 'true');
  if (status) status.textContent = 'Sending test notification.';

  let replacement = null;
  try {
    const response = await globalThis.fetch(form.action || form.getAttribute?.('action'), {
      method: 'POST',
      body: new globalThis.URLSearchParams(new globalThis.FormData(form)),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      credentials: 'same-origin',
    });
    const html = typeof response?.text === 'function' ? await response.text() : '';
    replacement = parseHtml(document, html)?.querySelector?.(
      `[data-release-notification-channel-status="${channel}"]`,
    ) || null;
  } catch {
    replacement = null;
  }

  // The region may have been replaced by an autosave while the test ran.
  const live = channelStatus(document, channel);
  if (replacement && live) {
    live.replaceWith(replacement);
    if (restoreFocus) replacement.querySelector?.('[data-release-notification-test-button]')?.focus?.({ preventScroll: true });
    return;
  }
  const liveButton = live?.querySelector?.('[data-release-notification-test-button]');
  const liveStatus = live?.querySelector?.('[data-release-notification-test-status]');
  if (liveButton) {
    liveButton.disabled = false;
    liveButton.removeAttribute?.('aria-busy');
    if (restoreFocus) liveButton.focus?.({ preventScroll: true });
  }
  if (liveStatus) liveStatus.textContent = TEST_FAILURE_MESSAGE;
}

function enhanceTestForms(region) {
  region.querySelectorAll?.(TEST_FORM_SELECTOR).forEach((form) => {
    if (isEnhancementBound(form, 'releaseNotificationTestBound')) return;
    markEnhancementBound(form, 'releaseNotificationTestBound');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      sendTest(form);
    });
  });
}

function replaceRegion(form, html) {
  const current = form?.closest?.(REGION_SELECTOR) || null;
  const next = parseHtml(form?.ownerDocument, html)?.querySelector?.(REGION_SELECTOR);
  if (!current || !next || !current.parentNode) return null;
  current.replaceWith(next);
  return next;
}

function setSavedStatus(region) {
  const form = region?.querySelector?.(SETTINGS_FORM_SELECTOR);
  const status = form?.querySelector?.('[data-settings-fetch-save-status]');
  if (!form || !status) return;
  form.setAttribute('data-settings-fetch-save-state', 'saved');
  status.textContent = 'Settings saved.';
}

function applyServerRegion({ form, html, superseded = false }, { saved }) {
  if (superseded) return;
  const focus = captureRegionFocus(form?.closest?.(REGION_SELECTOR));
  const region = replaceRegion(form, html);
  if (!region) return;
  if (saved) setSavedStatus(region);
  enhanceReleaseNotificationSettings(region);
  restoreRegionFocus(region, focus);
}

const fetchSaveOptions = Object.freeze({
  onSuccess: (detail) => applyServerRegion(detail, { saved: true }),
  onValidationError: (detail) => applyServerRegion(detail, { saved: false }),
});

export function enhanceReleaseNotificationSettings(scope = globalThis.document) {
  let bound = 0;
  for (const region of regions(scope)) {
    const form = region.querySelector?.(SETTINGS_FORM_SELECTOR);
    if (form && !isEnhancementBound(form, 'releaseNotificationTimingBound')) {
      markEnhancementBound(form, 'releaseNotificationTimingBound');
      form.addEventListener('change', () => syncReleaseNotificationTiming(form));
    }
    enhanceNumberInputs(region);
    enhanceTimePickers(region);
    enhanceTestForms(region);
    if (form) bound += enhanceSettingsFetchSave(form, fetchSaveOptions);
  }
  return bound;
}
