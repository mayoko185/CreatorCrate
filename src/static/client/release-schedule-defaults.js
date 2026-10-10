import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { closePickersWithin } from './pickers.js';

// New Release forms carry data-release-schedule-defaults: "fresh" when the
// server filled the schedule with placeholder defaults the browser should
// replace with its own local time, "keep" for explicit prefills and
// validation-error drafts that must stay exactly as rendered.
const FORM_SELECTOR = 'form[data-release-schedule-defaults]';
const NO_SET_DATE_SELECTOR = 'input[type="checkbox"][name="noSetReleaseDate"]';
// Hidden fields carrying the schedule set aside while the checkbox is checked,
// so it survives a validation rerender. Enabled (and submitted) only while a
// draft is held; their values may be intentionally blank.
const RETAINED_FIELDS = Object.freeze({
  plannedDate: 'input[type="hidden"][name="retainedPlannedDate"]',
  plannedTime: 'input[type="hidden"][name="retainedPlannedTime"]',
});
const DEFAULT_LEAD_MS = 60 * 60 * 1000;

function padTwo(value) {
  return String(value).padStart(2, '0');
}

// Date and time come from one future instant, so 23:30 rolls to 00:30 on the
// next day (and across month and year boundaries) consistently.
export function browserLocalScheduleDefaults(now = new Date()) {
  const future = new Date(now.getTime() + DEFAULT_LEAD_MS);
  return {
    plannedDate: `${future.getFullYear()}-${padTwo(future.getMonth() + 1)}-${padTwo(future.getDate())}`,
    plannedTime: `${padTwo(future.getHours())}:${padTwo(future.getMinutes())}`,
  };
}

function scheduleParts(form) {
  const date = form.querySelector('input[name="plannedDate"]');
  const time = form.querySelector('input[name="plannedTime"]');
  const triggers = [date, time]
    .map((input) => input?.closest?.('.picker-control')?.querySelector?.('.picker-trigger'))
    .filter(Boolean);
  return { checkbox: form.querySelector(NO_SET_DATE_SELECTOR), date, time, triggers };
}

function setScheduleValues(parts, { plannedDate, plannedTime }) {
  if (parts.date) parts.date.value = plannedDate;
  if (parts.time) parts.time.value = plannedTime;
}

function retainedInputs(form) {
  return {
    plannedDate: form.querySelector(RETAINED_FIELDS.plannedDate),
    plannedTime: form.querySelector(RETAINED_FIELDS.plannedTime),
  };
}

function readRetainedDraft(form) {
  const { plannedDate, plannedTime } = retainedInputs(form);
  if (!plannedDate || !plannedTime || plannedDate.disabled || plannedTime.disabled) return null;
  return { plannedDate: plannedDate.value, plannedTime: plannedTime.value };
}

// Hidden input values are their value attributes, so form.reset() never
// clears them; every draft change goes through here.
function writeRetainedDraft(form, retained) {
  Object.entries(retainedInputs(form)).forEach(([key, input]) => {
    if (!input) return;
    input.value = retained ? retained[key] : '';
    input.disabled = !retained;
  });
}

function setScheduleDisabled(form, parts, disabled) {
  if (disabled) closePickersWithin(form.querySelector('.scheduling-section') || form);
  [parts.date, parts.time, ...parts.triggers].forEach((control) => {
    if (control) control.disabled = disabled;
  });
}

function applyBrowserDefaults(parts) {
  setScheduleValues(parts, browserLocalScheduleDefaults());
}

function syncNoSetDate(form, state) {
  const parts = scheduleParts(form);
  if (parts.checkbox?.checked) {
    state.retained = {
      plannedDate: parts.date?.value ?? '',
      plannedTime: parts.time?.value ?? '',
    };
    writeRetainedDraft(form, state.retained);
    setScheduleValues(parts, { plannedDate: '', plannedTime: '' });
    setScheduleDisabled(form, parts, true);
    return;
  }
  setScheduleDisabled(form, parts, false);
  if (state.retained) setScheduleValues(parts, state.retained);
  else applyBrowserDefaults(parts);
  state.retained = null;
  writeRetainedDraft(form, null);
}

// A dialog reset (appDialogFinishClose) discards every scheduling draft so
// the next open starts unchecked from fresh browser-local defaults.
function resetToFresh(form, state) {
  const parts = scheduleParts(form);
  state.retained = null;
  state.fresh = true;
  writeRetainedDraft(form, null);
  if (parts.checkbox) parts.checkbox.checked = false;
  setScheduleDisabled(form, parts, false);
  applyBrowserDefaults(parts);
}

function refreshFreshDefaults(form, state) {
  const parts = scheduleParts(form);
  if (!state.fresh || parts.checkbox?.checked) return;
  applyBrowserDefaults(parts);
}

export function enhanceReleaseScheduleDefaults(scope = globalThis.document) {
  const forms = Array.from(scope?.querySelectorAll?.(FORM_SELECTOR) || []);
  forms.forEach((form) => {
    if (isEnhancementBound(form, 'releaseScheduleDefaultsBound')) return;
    markEnhancementBound(form, 'releaseScheduleDefaultsBound');
    const state = { fresh: form.dataset.releaseScheduleDefaults === 'fresh', retained: null };

    const parts = scheduleParts(form);
    if (parts.checkbox?.checked) {
      // A checked rerender restores the draft the server echoed back; with
      // none, unchecking falls back to fresh browser-local defaults.
      state.retained = readRetainedDraft(form);
      setScheduleDisabled(form, parts, true);
    } else {
      writeRetainedDraft(form, null);
      refreshFreshDefaults(form, state);
    }

    parts.checkbox?.addEventListener('change', () => {
      state.fresh = false;
      syncNoSetDate(form, state);
    });
    // Typed or picker-selected values are drafts, never stale defaults.
    [parts.date, parts.time].forEach((input) => input?.addEventListener('input', () => {
      state.fresh = false;
    }));
    form.addEventListener('reset', () => {
      // form.reset() restores attribute values first and the dialog then
      // applies its reset values synchronously; settle after both.
      queueMicrotask(() => resetToFresh(form, state));
    });

    const dialogState = form.closest('[data-app-dialog]')?.__creatorCrateAppDialogState;
    if (dialogState) {
      const previousOnOpen = dialogState.onOpen;
      dialogState.onOpen = (...args) => {
        // Recalculate on every fresh open so a long-idle page never offers a
        // stale or already-past default.
        refreshFreshDefaults(form, state);
        return previousOnOpen?.(...args);
      };
    }
  });
  return forms.length;
}
