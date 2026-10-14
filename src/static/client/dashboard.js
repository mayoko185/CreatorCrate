import {
  isEnhancementBound,
  liveRegionDocument,
  markEnhancementBound,
  setHidden,
} from './dom.js';
import {
  dismissActiveGridInfoCard,
  enhanceDashboardTitleInfoCards,
} from './info-cards.js';
import { createLiveRegionEngine } from './live-regions.js';
import { enhancePreviewMedia } from './preview.js';

const STATUS_FILTERS_SELECTOR = '[data-dashboard-status-filters]';
const STATUS_FILTER_SELECTOR = '[data-dashboard-status-filter]';
const PROJECTS_TABLE_SELECTOR = '[data-dashboard-projects-table]';
const PROJECT_ROW_SELECTOR = '[data-dashboard-project-row]';
const PROJECTS_SECTION_SELECTOR = '[data-dashboard-projects]';
const PROJECTS_COUNT_SELECTOR = '[data-dashboard-projects-count]';
const FILTER_EMPTY_SELECTOR = '[data-dashboard-projects-filter-empty]';
const TABLE_REGION_SELECTOR = '[data-dashboard-projects-table-region]';
const ALL_STATUSES = 'all';
const BOUND_KEY = 'dashboardStatusFiltersBound';

function projectCountText(visible, total) {
  return `${visible} of ${total} active ${total === 1 ? 'project' : 'projects'} · archived hidden`;
}

function createProjectTableFilter(section) {
  const group = section.querySelector(STATUS_FILTERS_SELECTOR);
  const table = section.querySelector(PROJECTS_TABLE_SELECTOR);
  // Only a table holding every active project can be filtered in place;
  // filtering a truncated table would report misleading counts.
  if (!group || table?.getAttribute('data-complete') !== 'true') return null;

  const buttons = [...group.querySelectorAll(STATUS_FILTER_SELECTOR)];
  const rows = [...table.querySelectorAll(PROJECT_ROW_SELECTOR)];
  if (!buttons.length || !rows.length) return null;

  const statuses = new Set(buttons.map((button) => button.getAttribute('data-dashboard-status-filter')));
  const count = section.querySelector(PROJECTS_COUNT_SELECTOR);
  const empty = section.querySelector(FILTER_EMPTY_SELECTOR);
  const tableRegion = section.querySelector(TABLE_REGION_SELECTOR);
  let selected = ALL_STATUSES;

  function apply(status) {
    selected = statuses.has(status) ? status : ALL_STATUSES;
    for (const button of buttons) {
      const pressed = button.getAttribute('data-dashboard-status-filter') === selected;
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
    let visible = 0;
    for (const row of rows) {
      const matches = selected === ALL_STATUSES || row.getAttribute('data-status') === selected;
      setHidden(row, !matches);
      if (matches) visible += 1;
    }
    // Hide the header-only table so a zero-match status reads as empty, not broken.
    setHidden(tableRegion, visible === 0);
    setHidden(empty, visible !== 0);
    if (count) count.textContent = projectCountText(visible, rows.length);
    return selected;
  }

  return { group, buttons, apply, selected: () => selected };
}

/**
 * Turns the Dashboard's status tabs into in-page row filters when the table
 * lists every active project. `initialStatus` restores a prior selection;
 * unknown values fall back to All.
 */
export function enhanceDashboardProjectTable(scope, { initialStatus } = {}) {
  const sections = scope?.querySelectorAll ? [...scope.querySelectorAll(PROJECTS_SECTION_SELECTOR)] : [];
  const controllers = [];
  for (const section of sections) {
    const filter = createProjectTableFilter(section);
    if (!filter || isEnhancementBound(filter.group, BOUND_KEY)) continue;
    markEnhancementBound(filter.group, BOUND_KEY);

    for (const button of filter.buttons) button.disabled = false;
    filter.group.addEventListener('click', (event) => {
      const button = event.target?.closest?.(STATUS_FILTER_SELECTOR);
      if (!button || !filter.group.contains(button)) return;
      filter.apply(button.getAttribute('data-dashboard-status-filter'));
    });
    filter.apply(initialStatus);
    controllers.push({ apply: filter.apply, selected: filter.selected });
  }
  return controllers;
}

const SCHEDULE_SELECTOR = '[data-dashboard-schedule]';
const SCHEDULE_QUICK_FORM_SELECTOR = '[data-dashboard-schedule-quick-form]';
const SCHEDULE_CUSTOM_FORM_SELECTOR = '[data-dashboard-schedule-custom-form]';
const SCHEDULE_CONTROLS_SELECTOR = '[data-dashboard-schedule-controls]';
const SCHEDULE_PICK_SELECTOR = '[data-dashboard-schedule-pick]';
const SCHEDULE_DATE_SELECTOR = '[data-dashboard-schedule-date]';
const SCHEDULE_SET_SELECTOR = '[data-dashboard-schedule-set]';
const SCHEDULE_ERROR_SELECTOR = '[data-dashboard-schedule-error]';
const SCHEDULE_STATUS_SELECTOR = '[data-dashboard-schedule-status]';
const SCHEDULE_UNDO_SELECTOR = '[data-dashboard-schedule-undo]';
const SCHEDULE_BOUND_KEY = 'dashboardScheduleBound';
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const SCHEDULE_MESSAGES = Object.freeze({
  busy: 'Another schedule change is still being saved. Try again when it finishes.',
  paused: 'Scheduling is paused until the dashboard is up to date. Use Retry refresh at the top of the dashboard, or reload the page.',
  emptyDate: 'Choose a date first.',
  invalidDate: 'Enter a valid date.',
  validation: 'This release can’t be scheduled for that date.',
  csrf: 'Your session’s security check failed. Reload the page, then try again.',
  notFound: 'This release is no longer available. Reload the page to see the current dashboard.',
  conflict: 'This release’s schedule was changed elsewhere, so nothing was overwritten. Reload the page to see its current schedule.',
  undoConflict: 'Undo wasn’t applied because this release’s schedule was changed elsewhere. Reload the page to see its current schedule.',
  unconfirmed: 'We couldn’t confirm whether this change was saved. Reload the page to see the current schedule before trying again.',
  failed: 'The schedule couldn’t be saved. Try again.',
});

const mutationGates = new WeakMap();

/**
 * The page-level gate allowing one schedule/Undo lifecycle at a time. A
 * lifecycle acquires it from its POST until its downstream callback settles,
 * so reconciliation never races a second write.
 *
 * `hold()` keeps writes closed beyond a lifecycle while the rendered
 * dashboard cannot be trusted (a refresh after a write failed); rows would
 * otherwise send expected schedules that may be stale. It returns the
 * release function, and `held` reports whether any hold remains.
 * `onReopen(listener)` runs the listener whenever the last hold is released,
 * so rows can withdraw a pause they reported, and returns an unsubscribe.
 */
export function getDashboardMutationGate(doc = globalThis.document) {
  const key = doc || globalThis;
  let gate = mutationGates.get(key);
  if (gate) return gate;
  let owner = null;
  const holds = new Set();
  const reopenListeners = new Set();
  gate = {
    get busy() { return owner !== null || holds.size > 0; },
    get held() { return holds.size > 0; },
    acquire() {
      if (owner || holds.size) return null;
      const token = {};
      owner = token;
      return () => { if (owner === token) owner = null; };
    },
    hold() {
      const token = {};
      holds.add(token);
      return () => {
        if (!holds.delete(token) || holds.size) return;
        for (const listener of [...reopenListeners]) {
          try { listener(); } catch { /* one row must not block the others */ }
        }
      };
    },
    onReopen(listener) {
      reopenListeners.add(listener);
      return () => { reopenListeners.delete(listener); };
    },
  };
  mutationGates.set(key, gate);
  return gate;
}

const schedulePickPresses = new WeakMap();

/**
 * Records a primary-button press on a suggested date anywhere on the page.
 * Pressing a button moves focus before its click fires, so without this a
 * custom-date input's blur would commit its unsent typed date first and take
 * the mutation gate from the date the user actually chose. Any later press
 * or key replaces the record, so a press that never becomes a click cannot
 * suppress a later ordinary blur.
 */
function getSchedulePickPress(doc) {
  let press = schedulePickPresses.get(doc);
  if (press) return press;
  press = { pick: null };
  doc.addEventListener?.('pointerdown', (event) => {
    press.pick = event.button === 0 ? event.target?.closest?.(SCHEDULE_PICK_SELECTOR) || null : null;
  }, true);
  doc.addEventListener?.('keydown', () => { press.pick = null; }, true);
  schedulePickPresses.set(doc, press);
  return press;
}

function isIsoDate(value) {
  const match = typeof value === 'string' ? ISO_DATE_PATTERN.exec(value) : null;
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  // Keyboard entry in a native date input reports intermediate years such as
  // 0002 or 0202 while the year is typed; never auto-submit those.
  if (year < 1000) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function readSchedulePair(value) {
  if (!value || typeof value !== 'object') return null;
  const { plannedDate, plannedTime } = value;
  if (plannedDate !== null && !isIsoDate(plannedDate)) return null;
  if (plannedTime !== null && !(typeof plannedTime === 'string' && ISO_TIME_PATTERN.test(plannedTime))) return null;
  return { plannedDate, plannedTime };
}

function sameSchedule(left, right) {
  return left.plannedDate === right.plannedDate && left.plannedTime === right.plannedTime;
}

function readRenderedSchedule(container) {
  const date = container.getAttribute('data-expected-planned-date');
  const time = container.getAttribute('data-expected-planned-time');
  // Both attributes are required: a missing expected schedule disables
  // enhancement rather than becoming an unconditional write.
  if (date === null || time === null) return null;
  return readSchedulePair({ plannedDate: date || null, plannedTime: time || null });
}

function formatScheduleDate(isoDate, now = new Date()) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const options = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (year !== now.getFullYear()) options.year = 'numeric';
  return new Intl.DateTimeFormat('en-US', options).format(new Date(Date.UTC(year, month - 1, day)));
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

/**
 * Classifies a schedule POST. Only a well-formed success echoing the
 * requested schedule is confirmed. Anything that may have committed without
 * proof (network loss, 5xx, a malformed 2xx) is `unconfirmed` and is never
 * retried.
 */
async function sendScheduleRequest(request, url, csrfToken, releaseId, payload) {
  let response;
  try {
    response = await request(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: 'unconfirmed', status: null };
  }
  const status = Number(response?.status) || null;
  const body = await readJson(response);
  if (response?.ok) {
    const release = body?.release;
    const previousSchedule = readSchedulePair(release?.previousSchedule);
    const schedule = readSchedulePair(release?.schedule);
    const requested = { plannedDate: payload.plannedDate, plannedTime: null };
    const expected = { plannedDate: payload.expectedPlannedDate, plannedTime: payload.expectedPlannedTime };
    const valid = body?.status === 'success' && typeof body.changed === 'boolean'
      && String(release?.id) === String(releaseId)
      && previousSchedule && sameSchedule(previousSchedule, expected)
      && schedule && sameSchedule(schedule, requested);
    return valid
      ? { kind: 'success', status, changed: body.changed, previousSchedule, schedule }
      : { kind: 'unconfirmed', status };
  }
  const message = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : null;
  if (status === 409) return { kind: 'conflict', status, currentSchedule: readSchedulePair(body?.currentSchedule) };
  if (status === 404) return { kind: 'not-found', status };
  if (status === 422) return { kind: 'validation', status, message };
  if (status === 403) return { kind: 'csrf', status };
  // Other client errors are rejected before the service runs; server errors
  // can follow a committed write.
  if (status >= 400 && status < 500) return { kind: 'failed', status };
  return { kind: 'unconfirmed', status };
}

function bindScheduleRow(container, options) {
  const releaseId = Number(container.getAttribute('data-release-id'));
  const url = container.getAttribute('data-schedule-url');
  const rendered = readRenderedSchedule(container);
  const quickForm = container.querySelector(SCHEDULE_QUICK_FORM_SELECTOR);
  const customForm = container.querySelector(SCHEDULE_CUSTOM_FORM_SELECTOR);
  const dateInput = customForm?.querySelector(SCHEDULE_DATE_SELECTOR);
  const setButton = customForm?.querySelector(SCHEDULE_SET_SELECTOR);
  const errorRegion = container.querySelector(SCHEDULE_ERROR_SELECTOR);
  const statusRegion = container.querySelector(SCHEDULE_STATUS_SELECTOR);
  const csrfToken = customForm?.querySelector('[name="_csrf"]')?.value;
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || url !== `/releases/${releaseId}/schedule`
    || !rendered || !dateInput || !errorRegion || !statusRegion || !csrfToken) return null;

  const fieldsets = [...container.querySelectorAll(SCHEDULE_CONTROLS_SELECTOR)];
  const picks = quickForm ? [...quickForm.querySelectorAll(SCHEDULE_PICK_SELECTOR)] : [];
  const doc = container.ownerDocument || globalThis.document;
  const state = { phase: 'idle', current: rendered, confirmation: null };

  // A row replaced while its request was pending must not repaint the
  // detached copy; callbacks still run so the caller learns the outcome.
  const connected = () => container.isConnected !== false;

  function setControlsDisabled(disabled) {
    for (const fieldset of fieldsets) fieldset.disabled = disabled;
  }

  function setBusy(busy) {
    if (busy) container.setAttribute('aria-busy', 'true');
    else container.removeAttribute('aria-busy');
  }

  // Why the visible error is shown. `paused` reports the page-level pause,
  // which the gate reopening makes obsolete. Only `validation` errors describe
  // the row's own input and stay true across a dashboard refresh; busy,
  // rejected and unresolved outcomes describe a moment the refresh ends.
  let shownError = null;

  function showError(message, { invalidDate = false, kind = 'transient' } = {}) {
    shownError = message ? { kind, message, invalidDate } : null;
    errorRegion.textContent = message || '';
    setHidden(errorRegion, !message);
    if (invalidDate) dateInput.setAttribute('aria-invalid', 'true');
    else dateInput.removeAttribute('aria-invalid');
  }

  function undoButton() {
    return statusRegion.querySelector(SCHEDULE_UNDO_SELECTOR);
  }

  async function notify(callback, payload) {
    try { await callback(payload); } catch { /* the row already reflects the server outcome */ }
  }

  function announce(message) {
    if (!message || !options.announce) return;
    try { options.announce(message, { releaseId }); } catch { /* announcements are best effort */ }
  }

  function canUndo(confirmation) {
    // The endpoint writes dates only, so a previous schedule with a time
    // cannot be restored exactly from here.
    return !sameSchedule(confirmation.previousSchedule, confirmation.schedule)
      && confirmation.previousSchedule.plannedTime === null;
  }

  function renderConfirmation() {
    const { schedule, previousSchedule } = state.confirmation;
    setHidden(quickForm, true);
    setHidden(customForm, true);
    const mark = doc.createElement('span');
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '✓ ';
    const text = doc.createElement('span');
    const label = formatScheduleDate(schedule.plannedDate);
    text.textContent = sameSchedule(previousSchedule, schedule) ? `Already scheduled for ${label}` : `Scheduled for ${label}`;
    const children = [mark, text];
    let undo = null;
    if (canUndo(state.confirmation)) {
      undo = doc.createElement('button');
      undo.setAttribute('type', 'button');
      undo.setAttribute('class', 'button button-small button-secondary');
      undo.setAttribute('data-dashboard-schedule-undo', '');
      undo.setAttribute('aria-label', `Undo scheduling for ${label}`);
      undo.textContent = 'Undo';
      children.push(undo);
    } else {
      // Keep focus inside the row after its controls are hidden.
      text.setAttribute('tabindex', '-1');
    }
    statusRegion.replaceChildren(...children);
    (undo || text).focus?.();
    return `${text.textContent}.`;
  }

  function restoreControls() {
    statusRegion.replaceChildren();
    setHidden(quickForm, false);
    setHidden(customForm, false);
    dateInput.value = '';
    setControlsDisabled(false);
    (picks[0] || dateInput).focus?.();
  }

  function settleRejected(outcome, action, trigger) {
    if (action === 'schedule') {
      state.phase = 'idle';
      statusRegion.textContent = '';
      setControlsDisabled(false);
    } else {
      state.phase = 'scheduled';
      const undo = undoButton();
      undo?.removeAttribute('aria-disabled');
      if (undo) undo.textContent = 'Undo';
    }
    if (!connected()) return;
    setBusy(false);
    const message = outcome.kind === 'validation' ? outcome.message || SCHEDULE_MESSAGES.validation
      : outcome.kind === 'csrf' ? SCHEDULE_MESSAGES.csrf : SCHEDULE_MESSAGES.failed;
    const validation = outcome.kind === 'validation';
    showError(message, { invalidDate: validation && trigger === dateInput, kind: validation ? 'validation' : 'rejected' });
    trigger?.focus?.();
    announce(message);
  }

  async function settleUnresolved(outcome, action, payload) {
    // The rendered schedule can no longer be trusted, so the row stays
    // locked until an authoritative refresh replaces it.
    state.phase = 'locked';
    if (connected()) {
      setBusy(false);
      if (action === 'schedule') statusRegion.textContent = '';
      else undoButton()?.setAttribute('disabled', '');
      const message = outcome.kind === 'not-found' ? SCHEDULE_MESSAGES.notFound
        : outcome.kind === 'conflict' ? (action === 'undo' ? SCHEDULE_MESSAGES.undoConflict : SCHEDULE_MESSAGES.conflict)
          : SCHEDULE_MESSAGES.unconfirmed;
      showError(message, { kind: 'unresolved' });
    }
    await notify(options.onReconcileRequired, {
      action,
      releaseId,
      reason: outcome.kind,
      status: outcome.status,
      attempted: { ...payload },
      currentSchedule: outcome.currentSchedule ? { ...outcome.currentSchedule } : null,
    });
  }

  async function settleConfirmed(outcome, action) {
    const { changed, previousSchedule, schedule } = outcome;
    const undone = state.confirmation;
    state.current = schedule;
    let message;
    if (action === 'schedule') {
      state.confirmation = { previousSchedule, schedule };
      state.phase = 'scheduled';
      if (connected()) {
        setBusy(false);
        message = renderConfirmation();
      }
    } else {
      state.confirmation = null;
      state.phase = 'idle';
      if (connected()) {
        setBusy(false);
        restoreControls();
        message = `Undid scheduling for ${formatScheduleDate(undone.schedule.plannedDate)}. This release needs a date again.`;
        statusRegion.textContent = message;
      }
    }
    announce(message);
    await notify(options.onScheduleConfirmed, {
      action,
      releaseId,
      changed,
      previousSchedule: { ...previousSchedule },
      schedule: { ...schedule },
    });
  }

  async function mutate(action, payload, trigger) {
    const releaseGate = options.gate.acquire();
    if (!releaseGate) {
      const paused = options.gate.held;
      const message = paused ? SCHEDULE_MESSAGES.paused : SCHEDULE_MESSAGES.busy;
      showError(message, { kind: paused ? 'paused' : 'busy' });
      announce(message);
      return;
    }
    try {
      state.phase = action === 'schedule' ? 'pending' : 'undoing';
      showError('');
      setBusy(true);
      if (action === 'schedule') {
        setControlsDisabled(true);
        statusRegion.textContent = 'Scheduling…';
      } else {
        // aria-disabled rather than disabled keeps keyboard focus on Undo.
        const undo = undoButton();
        undo?.setAttribute('aria-disabled', 'true');
        if (undo) undo.textContent = 'Undoing…';
      }

      const outcome = await sendScheduleRequest(options.request, url, csrfToken, releaseId, payload);
      if (outcome.kind === 'success') await settleConfirmed(outcome, action);
      else if (['validation', 'csrf', 'failed'].includes(outcome.kind)) settleRejected(outcome, action, trigger);
      else await settleUnresolved(outcome, action, payload);
    } finally {
      releaseGate();
    }
  }

  function scheduleDate(date, trigger) {
    if (state.phase !== 'idle') return;
    void mutate('schedule', {
      plannedDate: date,
      plannedTime: null,
      expectedPlannedDate: state.current.plannedDate,
      expectedPlannedTime: state.current.plannedTime,
    }, trigger);
  }

  quickForm?.addEventListener('submit', (event) => {
    // The endpoint answers JSON only; a native submit would navigate to it.
    event.preventDefault();
    const pick = event.submitter?.closest?.(SCHEDULE_PICK_SELECTOR);
    if (!pick || !picks.includes(pick)) return;
    const date = pick.getAttribute('data-planned-date');
    if (isIsoDate(date)) scheduleDate(date, pick);
  });

  // Once every segment of a native date input holds a value, each keystroke
  // fires change: typing 15 into the day reports the 1st first. Typed dates
  // therefore commit on Enter or when focus leaves the field; picker choices
  // commit on change.
  let typedDate = false;

  function submitCustomDate() {
    typedDate = false;
    if (state.phase !== 'idle') return;
    const { value } = dateInput;
    if (!value) showError(SCHEDULE_MESSAGES.emptyDate, { invalidDate: true, kind: 'validation' });
    else if (!isIsoDate(value)) showError(SCHEDULE_MESSAGES.invalidDate, { invalidDate: true, kind: 'validation' });
    else scheduleDate(value, dateInput);
  }

  function commitDate() {
    typedDate = false;
    // Cleared or incomplete values wait for an explicit submit to explain
    // themselves rather than flashing an error mid-entry.
    if (isIsoDate(dateInput.value)) scheduleDate(dateInput.value, dateInput);
  }

  customForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitCustomDate();
  });

  dateInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      // Handled here so implicit submission never depends on the hidden Set.
      event.preventDefault();
      submitCustomDate();
    } else if (!['Tab', 'Shift', 'Escape'].includes(event.key)) {
      typedDate = true;
    }
  });

  const pickPress = getSchedulePickPress(doc);

  dateInput.addEventListener('focus', () => { pickPress.pick = null; });

  dateInput.addEventListener('blur', () => {
    // A blur caused by pressing a suggested date defers to that date. The
    // draft stays typed, so Enter or a later blur can still commit it.
    if (pickPress.pick) {
      pickPress.pick = null;
      return;
    }
    if (typedDate && connected()) commitDate();
  });

  dateInput.addEventListener('change', () => {
    if (!typedDate) commitDate();
  });

  statusRegion.addEventListener('click', (event) => {
    const undo = event.target?.closest?.(SCHEDULE_UNDO_SELECTOR);
    if (!undo || state.phase !== 'scheduled' || !state.confirmation || !canUndo(state.confirmation)) return;
    if (undo.getAttribute('aria-disabled') === 'true' || undo.hasAttribute('disabled')) return;
    void mutate('undo', {
      plannedDate: state.confirmation.previousSchedule.plannedDate,
      plannedTime: null,
      expectedPlannedDate: state.current.plannedDate,
      expectedPlannedTime: state.current.plannedTime,
    }, undo);
  });

  // Retained rows survive the refresh that reopens the gate, so they clear
  // the pause themselves. The recovery status announces the reopening.
  // The subscription is the only page-level reference to the row, so a
  // retired row must dispose it or the gate keeps its subtree alive.
  let stopReopen = options.gate.onReopen?.(() => {
    if (!connected()) dispose();
    else if (shownError?.kind === 'paused') showError('');
  }) || null;

  function dispose() {
    stopReopen?.();
    stopReopen = null;
  }

  setControlsDisabled(false);
  // Set stays in the markup for no-JS submission; it is hidden only once
  // change-driven submission is wired.
  setHidden(setButton, true);

  return {
    releaseId,
    dispose,
    // The error a refreshed copy of this idle row should keep showing.
    retainableError: () => (state.phase === 'idle' && shownError?.kind === 'validation'
      ? { message: shownError.message, invalidDate: shownError.invalidDate }
      : null),
    // Shows an error the user already heard on the row this one replaced,
    // so it is not announced again.
    restoreError({ message, invalidDate }) {
      if (state.phase !== 'idle' || !message) return;
      showError(message, { invalidDate, kind: 'validation' });
    },
    getState: () => ({
      phase: state.phase,
      current: { ...state.current },
      confirmation: state.confirmation
        ? { previousSchedule: { ...state.confirmation.previousSchedule }, schedule: { ...state.confirmation.schedule } }
        : null,
    }),
  };
}

/**
 * Enables the "Needs a release date" quick-schedule and Undo controls.
 *
 * Both lifecycle callbacks are required because a confirmed write leaves the
 * rest of the dashboard stale until the caller reconciles it. Each is awaited
 * while the page-level mutation gate is held:
 *
 * - `onScheduleConfirmed({ action, releaseId, changed, previousSchedule, schedule })`
 * - `onReconcileRequired({ action, releaseId, reason, status, attempted, currentSchedule })`,
 *   where `reason` is `conflict`, `not-found` or `unconfirmed`.
 * - `announce(message, { releaseId })` (optional) receives each row outcome
 *   the user should hear: confirmations and rejected or blocked writes. Row
 *   status text is visual only, because a refresh can replace the row before
 *   assistive technology reads it.
 *
 * `action` is `schedule` or `undo`; schedules are `{ plannedDate, plannedTime }`.
 * Rows are bound once, so calling again binds only newly rendered rows. Each
 * returned controller's idempotent `dispose()` must be called once its row is
 * permanently removed, releasing the row's mutation-gate subscription.
 */
export function enhanceDashboardReleaseScheduling(scope, {
  onScheduleConfirmed,
  onReconcileRequired,
  announce,
  request = globalThis.fetch?.bind(globalThis),
  gate,
} = {}) {
  if (typeof onScheduleConfirmed !== 'function' || typeof onReconcileRequired !== 'function') {
    throw new TypeError('Dashboard scheduling requires onScheduleConfirmed and onReconcileRequired callbacks.');
  }
  if (typeof request !== 'function') throw new TypeError('Dashboard scheduling requires a request function.');
  const containers = scope?.querySelectorAll ? [...scope.querySelectorAll(SCHEDULE_SELECTOR)] : [];
  if (scope?.matches?.(SCHEDULE_SELECTOR)) containers.unshift(scope);
  const doc = scope?.nodeType === 9 ? scope : scope?.ownerDocument || globalThis.document;
  const options = {
    onScheduleConfirmed,
    onReconcileRequired,
    announce: typeof announce === 'function' ? announce : null,
    request,
    gate: gate || getDashboardMutationGate(doc),
  };
  const controllers = [];
  for (const container of containers) {
    if (isEnhancementBound(container, SCHEDULE_BOUND_KEY)) continue;
    const controller = bindScheduleRow(container, options);
    if (!controller) continue;
    markEnhancementBound(container, SCHEDULE_BOUND_KEY);
    controllers.push(controller);
  }
  return controllers;
}

const DASHBOARD_REGION_SELECTOR = '[data-dashboard]';
const DASHBOARD_TODAY_SELECTOR = '.dashboard-today';
const DASHBOARD_STATE_KEY = '__creatorCrateDashboardLiveRegion';
const NEEDS_DATE_SECTION_SELECTOR = '#needs-date';
const NEEDS_DATE_HEADING_ID = 'dashboard-needs-date-heading';
const NEEDS_DATE_LIST_SELECTOR = '[data-dashboard-needs-date-list]';
const NEEDS_DATE_ITEM_SELECTOR = '[data-dashboard-needs-date-item]';
const RETAINED_TITLES_SELECTOR = 'template[data-dashboard-retained-titles]';
const RETAINED_RELEASE_SELECTOR = '[data-dashboard-retained-release]';
const TITLE_INFO_SELECTOR = '[data-dashboard-title-info]';
const TITLE_TRIGGER_SELECTOR = `${TITLE_INFO_SELECTOR} > [data-calendar-info-trigger]`;
const TITLE_CARD_SELECTOR = `${TITLE_INFO_SELECTOR} > [data-calendar-info-card]`;
// Where each refreshed title belongs inside a Needs-a-date item.
const RETAINED_TITLE_TARGETS = Object.freeze({
  release: `.dashboard-item-title > ${TITLE_INFO_SELECTOR}`,
  project: `.dashboard-item-meta > ${TITLE_INFO_SELECTOR}`,
});
const DASHBOARD_RESPONSE_ERROR = 'Dashboard response failed.';
const DASHBOARD_MISSING_REGION = 'Dashboard response did not contain the dashboard.';
// Every server-owned region the refresh replaces. A response missing any of
// them is not a usable dashboard, so the current one stays in place.
const DASHBOARD_REQUIRED_SELECTORS = Object.freeze([
  '[data-dashboard-tile="overdue"]',
  '[data-dashboard-tile="needs-date"]',
  '[data-dashboard-tile="today"]',
  '[data-dashboard-tile="next7"]',
  '[data-dashboard-tile="missing-assets"]',
  '.dashboard-strip-days',
  NEEDS_DATE_SECTION_SELECTOR,
  '.dashboard-scheduled',
  '.dashboard-recent',
  PROJECTS_SECTION_SELECTOR,
]);
// Shell, dialog and nested-dashboard markup never belongs inside the region;
// installing it would duplicate page-level ids and controls.
const DASHBOARD_FOREIGN_SELECTOR = '[data-dashboard], main, header, dialog, #project-create-dialog';
const FOCUS_CANDIDATE_SELECTOR = [SCHEDULE_UNDO_SELECTOR, SCHEDULE_PICK_SELECTOR, SCHEDULE_DATE_SELECTOR].join(', ');

class DashboardRefreshError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'DashboardRefreshError';
    this.reason = reason;
  }
}

function settleDashboardRefresh(state, outcome) {
  const refresh = state.dashboardRefresh;
  if (!refresh) return;
  state.dashboardRefresh = null;
  refresh.resolve(outcome);
}

function refreshFailure(reason, { error = null, replaced = false } = {}) {
  return { status: 'failed', reason, replaced, error };
}

function classifyRefreshError(error, replaced) {
  if (replaced) return refreshFailure('install', { error, replaced: true });
  if (error instanceof DashboardRefreshError) return refreshFailure(error.reason, { error });
  if (error?.message === DASHBOARD_RESPONSE_ERROR) return refreshFailure('response', { error });
  if (error?.message === DASHBOARD_MISSING_REGION) return refreshFailure('invalid', { error });
  return refreshFailure('request', { error });
}

function validateDashboardResponse(state, parsed, nextRegion) {
  // A redirect (an expired session landing on the sign-in page) can still
  // answer 200, so the final URL must be the Dashboard itself.
  const finalUrl = new URL(state.response?.url || state.requestedUrl?.href || '/', state.window.location?.href);
  if (finalUrl.pathname !== '/') {
    throw new DashboardRefreshError('invalid', 'Dashboard response came from another page.');
  }
  // Without the requested titles a retained confirmation could only keep
  // popovers describing the release before it was scheduled.
  const missingRetainedTitles = state.dashboardRefresh.retainedIds.length > 0
    && nextRegion.querySelectorAll(RETAINED_TITLES_SELECTOR).length !== 1;
  if (parsed.querySelectorAll(DASHBOARD_REGION_SELECTOR).length !== 1
    || nextRegion.querySelector(DASHBOARD_FOREIGN_SELECTOR)
    || DASHBOARD_REQUIRED_SELECTORS.some((selector) => !nextRegion.querySelector(selector))
    || missingRetainedTitles) {
    throw new DashboardRefreshError('invalid', 'Dashboard response was incomplete.');
  }
}

function findByAttribute(root, selector, attribute, value) {
  if (!root || value === null || value === undefined) return null;
  return [...root.querySelectorAll(selector)].find((node) => node.getAttribute(attribute) === value) || null;
}

function findFocusableByAttribute(root, selector, attribute, value) {
  if (!root || value === null || value === undefined) return null;
  return [...root.querySelectorAll(selector)]
    .find((node) => node.getAttribute(attribute) === value && canFocus(node)) || null;
}

/**
 * Releases whose confirmations are on screen. Their rows are no longer in
 * the server's undated list, so a refresh asks the server for their current
 * title popovers.
 */
function retainedReleaseIds(state) {
  const region = dashboardLiveEngine.getRegion(state.document);
  const controllers = state.dashboardScheduling?.controllers;
  if (!region || !controllers) return [];
  return [...region.querySelectorAll(NEEDS_DATE_ITEM_SELECTOR)]
    .filter((item) => {
      const row = controllers.get(item.querySelector(SCHEDULE_SELECTOR))?.getState();
      return row?.phase === 'scheduled' && row.confirmation;
    })
    .map((item) => item.getAttribute('data-release-id'));
}

function describeFocus(active) {
  const owner = active.closest('[data-release-id], [data-project-id]');
  const ownerAttribute = owner?.hasAttribute('data-release-id') ? 'data-release-id' : 'data-project-id';
  return {
    element: active,
    id: active.getAttribute('id'),
    statusFilter: active.getAttribute('data-dashboard-status-filter') ?? active.getAttribute('data-dashboard-status-link'),
    releaseId: active.closest(NEEDS_DATE_ITEM_SELECTOR)?.getAttribute('data-release-id') ?? null,
    plannedDate: active.getAttribute('data-planned-date'),
    // Focus inside a title card returns to the card's trigger: the fresh card
    // renders closed, so none of its actions can take focus.
    titleCard: active.getAttribute('aria-controls') ?? active.closest(TITLE_CARD_SELECTOR)?.id ?? null,
    href: active.getAttribute('href'),
    owner: owner ? { attribute: ownerAttribute, value: owner.getAttribute(ownerAttribute) } : null,
    sectionHeadingId: active.closest('section[aria-labelledby]')?.getAttribute('aria-labelledby') ?? null,
  };
}

function captureDashboardState(state) {
  const doc = state.document;
  const region = dashboardLiveEngine.getRegion(doc);
  const controllers = state.dashboardScheduling?.controllers;
  const order = [];
  const retained = new Map();
  const drafts = new Map();
  const errors = new Map();
  const rows = controllers
    ? [...region.querySelectorAll(SCHEDULE_SELECTOR)].filter((container) => controllers.has(container))
    : [];
  for (const item of region.querySelectorAll(NEEDS_DATE_ITEM_SELECTOR)) {
    const releaseId = item.getAttribute('data-release-id');
    order.push(releaseId);
    const controller = controllers?.get(item.querySelector(SCHEDULE_SELECTOR));
    const row = controller?.getState();
    // The row's own scheduling state is the only record of a confirmed write
    // the server no longer lists as undated.
    if (row?.phase === 'scheduled' && row.confirmation) {
      retained.set(releaseId, item);
      continue;
    }
    if (row && row.phase !== 'idle') continue;
    const value = item.querySelector(SCHEDULE_DATE_SELECTOR)?.value;
    if (value) drafts.set(releaseId, value);
    const error = controller?.retainableError();
    if (error) errors.set(releaseId, error);
  }

  const filters = region.querySelector(STATUS_FILTERS_SELECTOR);
  const pressed = filters && isEnhancementBound(filters, BOUND_KEY)
    ? filters.querySelector(`${STATUS_FILTER_SELECTOR}[aria-pressed="true"]`)
    : null;

  const active = doc.activeElement;
  return {
    order,
    retained,
    drafts,
    errors,
    rows,
    projectStatus: pressed?.getAttribute('data-dashboard-status-filter') ?? undefined,
    focus: active && region.contains(active) ? describeFocus(active) : null,
    focusLost: !active || active === doc.body || active === doc.documentElement,
  };
}

/**
 * Replaces a retained item's release and project titles, with their
 * popovers, by the server's current rendering. The titles describe the
 * release's schedule and its project's next release, both of which the
 * confirmed write changed. Returns false when the server did not render
 * titles for the release because it is no longer an active unpublished
 * release.
 */
function refreshRetainedTitles(item, freshTitles) {
  if (!freshTitles) return false;
  const swaps = Object.entries(RETAINED_TITLE_TARGETS).map(([kind, selector]) => [
    item.querySelector(selector),
    freshTitles.querySelector(`[data-dashboard-retained-title="${kind}"] > ${TITLE_INFO_SELECTOR}`),
  ]);
  if (swaps.some(([current, next]) => !current || !next)) return false;
  for (const [current, next] of swaps) current.replaceWith(next);
  return true;
}

function reinsertConfirmations(doc, region, { order, retained }) {
  const list = region.querySelector(NEEDS_DATE_LIST_SELECTOR);
  const fresh = new Map([...(list?.querySelectorAll(NEEDS_DATE_ITEM_SELECTOR) || [])]
    .map((item) => [item.getAttribute('data-release-id'), item]));
  const titlesTemplate = region.querySelector(RETAINED_TITLES_SELECTOR);
  const freshTitles = new Map([...(titlesTemplate?.content.querySelectorAll(RETAINED_RELEASE_SELECTOR) || [])]
    .map((titles) => [titles.getAttribute('data-release-id'), titles]));
  // Template markup is only a source for the swap below; leaving it would
  // keep a second, inert copy of each popover in the region.
  titlesTemplate?.remove();
  // A release the server lists as undated again is shown from the fresh
  // markup; its confirmation is no longer true. One the server no longer
  // renders titles for cannot be shown truthfully, so it is not kept.
  const kept = new Map([...retained].filter(([releaseId, item]) => !fresh.has(releaseId)
    && refreshRetainedTitles(item, freshTitles.get(releaseId))));
  if (!kept.size) return new Set();

  let target = list;
  if (!target) {
    const section = region.querySelector(NEEDS_DATE_SECTION_SELECTOR);
    target = doc.createElement('ul');
    target.className = 'dashboard-needs-date-list';
    target.setAttribute('data-dashboard-needs-date-list', '');
    section.insertBefore(target, section.querySelector(':scope > .dashboard-empty-line'));
  }

  // Confirmations keep their place relative to the neighbours they had;
  // fresh items keep the server's order around them.
  const freshOrder = [...fresh.keys()];
  const sequence = [];
  const placed = new Set();
  let next = 0;
  const placeFreshThrough = (releaseId) => {
    while (next < freshOrder.length) {
      const candidate = freshOrder[next++];
      if (!placed.has(candidate)) {
        placed.add(candidate);
        sequence.push(fresh.get(candidate));
      }
      if (candidate === releaseId) return;
    }
  };
  for (const releaseId of order) {
    if (kept.has(releaseId)) sequence.push(kept.get(releaseId));
    else if (fresh.has(releaseId) && !placed.has(releaseId)) placeFreshThrough(releaseId);
  }
  placeFreshThrough(null);
  target.replaceChildren(...sequence);
  return new Set(kept.values());
}

function restoreDrafts(region, drafts, retainedItems) {
  for (const item of region.querySelectorAll(NEEDS_DATE_ITEM_SELECTOR)) {
    if (retainedItems.has(item)) continue;
    const draft = drafts.get(item.getAttribute('data-release-id'));
    const input = item.querySelector(SCHEDULE_DATE_SELECTOR);
    // Assigning value fires no change event, so a restored draft is never
    // submitted on the user's behalf.
    if (draft && input && !input.value) input.value = draft;
  }
}

/**
 * Re-shows validation errors on the fresh, still-undated rows of the releases
 * they belong to. A release the server no longer lists as undated has no
 * fresh row, so its error is dropped with it.
 */
function restoreRowErrors(state, region, errors, retainedItems) {
  const controllers = state.dashboardScheduling?.controllers;
  if (!controllers || !errors.size) return;
  for (const item of region.querySelectorAll(NEEDS_DATE_ITEM_SELECTOR)) {
    if (retainedItems.has(item)) continue;
    const error = errors.get(item.getAttribute('data-release-id'));
    if (error) controllers.get(item.querySelector(SCHEDULE_SELECTOR))?.restoreError(error);
  }
}

function restoreDashboardState(state, region) {
  const { snapshot, nextToday } = state.dashboardRefresh;
  const doc = state.document;
  const today = doc.querySelector(DASHBOARD_TODAY_SELECTOR);
  if (today && nextToday) today.replaceChildren(...nextToday.childNodes);

  const retainedItems = reinsertConfirmations(doc, region, snapshot);
  restoreDrafts(region, snapshot.drafts, retainedItems);
  enhancePreviewMedia(region);
  enhanceDashboardTitleInfoCards(region);
  enhanceDashboardProjectTable(region, { initialStatus: snapshot.projectStatus });
  state.dashboardScheduling?.bind(region);
  restoreRowErrors(state, region, snapshot.errors, retainedItems);
}

function canFocus(element) {
  return Boolean(element) && !element.disabled && element.getAttribute('aria-hidden') !== 'true'
    && !element.closest('[hidden], fieldset[disabled]') && element.getClientRects?.().length !== 0;
}

function findEquivalentFocus(region, focus) {
  const section = focus.sectionHeadingId
    ? findByAttribute(region, 'section[aria-labelledby]', 'aria-labelledby', focus.sectionHeadingId)
    : region;
  const owner = focus.owner && section
    ? findByAttribute(section, `[${focus.owner.attribute}]`, focus.owner.attribute, focus.owner.value)
    : null;
  const candidates = [
    focus.id ? findByAttribute(region, '[id]', 'id', focus.id) : null,
    focus.statusFilter ? findByAttribute(region, STATUS_FILTER_SELECTOR, 'data-dashboard-status-filter', focus.statusFilter) : null,
    focus.statusFilter ? findByAttribute(region, '[data-dashboard-status-link]', 'data-dashboard-status-link', focus.statusFilter) : null,
    focus.plannedDate ? findByAttribute(owner, SCHEDULE_PICK_SELECTOR, 'data-planned-date', focus.plannedDate) : null,
    focus.titleCard ? findByAttribute(region, TITLE_TRIGGER_SELECTOR, 'aria-controls', focus.titleCard) : null,
    // The first link with this href may sit in a closed title popover.
    focus.href ? findFocusableByAttribute(owner || section, 'a[href]', 'href', focus.href) : null,
  ];
  return candidates.find(canFocus) || null;
}

function releaseFocusTarget(region, releaseId) {
  const item = findByAttribute(region, NEEDS_DATE_ITEM_SELECTOR, 'data-release-id', releaseId);
  if (!item) return null;
  return [...item.querySelectorAll(FOCUS_CANDIDATE_SELECTOR)].find(canFocus)
    || item.querySelector(`${SCHEDULE_STATUS_SELECTOR} [tabindex="-1"]`);
}

function headingFocusTarget(region, headingId) {
  const heading = findByAttribute(region, '[id]', 'id', headingId);
  // Headings take programmatic focus only, so they stay out of the Tab order.
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}

function restoreDashboardFocus(state, region, { snapshot, releaseId }) {
  const { focus, focusLost } = snapshot;
  if (!focus && !(focusLost && releaseId !== null)) return;
  // A reinserted node loses focus even though it is the same element.
  const kept = focus?.element.isConnected && region.contains(focus.element) && canFocus(focus.element)
    ? focus.element
    : null;
  const target = kept
    || (focus && findEquivalentFocus(region, focus))
    || releaseFocusTarget(region, focus ? focus.releaseId : releaseId)
    || headingFocusTarget(region, focus?.sectionHeadingId ?? NEEDS_DATE_HEADING_ID);
  if (target && state.document.activeElement !== target) target.focus({ preventScroll: true });
}

const dashboardLiveEngine = createLiveRegionEngine({
  regionSelector: DASHBOARD_REGION_SELECTOR,
  formSelector: [],
  defaultAction: '/',
  stateKey: DASHBOARD_STATE_KEY,
  responseErrorMessage: DASHBOARD_RESPONSE_ERROR,
  missingRegionMessage: DASHBOARD_MISSING_REGION,
  onCreate(state) {
    state.dashboardRefresh = null;
    state.dashboardScheduling = null;
  },
  onInvalidate(state) {
    settleDashboardRefresh(state, { status: 'superseded' });
  },
  onResponseParsed(state, parsed, nextRegion) {
    validateDashboardResponse(state, parsed, nextRegion);
    // Captured at the last moment so drafts typed during the fetch survive.
    state.dashboardRefresh.snapshot = captureDashboardState(state);
    state.dashboardRefresh.nextToday = parsed.querySelector(DASHBOARD_TODAY_SELECTOR);
    dismissActiveGridInfoCard();
  },
  onRegionReplaced(state, nextRegion) {
    state.dashboardRefresh.replaced = true;
    try {
      restoreDashboardState(state, nextRegion);
    } finally {
      // Runs even when restoration fails part way, so rows already detached
      // never stay reachable through the gate.
      state.dashboardScheduling?.retire(state.dashboardRefresh.snapshot.rows, nextRegion);
    }
  },
  onLoadComplete(state, _generation, region) {
    const refresh = state.dashboardRefresh;
    if (!refresh) return;
    restoreDashboardFocus(state, region, refresh);
    settleDashboardRefresh(state, { status: 'refreshed' });
  },
  onLoadError(state, _generation, error) {
    dashboardLiveEngine.getRegion(state.document)?.removeAttribute('aria-busy');
    settleDashboardRefresh(state, classifyRefreshError(error, state.dashboardRefresh?.replaced));
    return true;
  },
  isCurrentUrl: () => false,
});

function dashboardState(scope) {
  const doc = liveRegionDocument(scope);
  if (!doc || !dashboardLiveEngine.getRegion(doc)) return null;
  dashboardLiveEngine.enhance(doc);
  const state = doc[DASHBOARD_STATE_KEY];
  return state && dashboardLiveEngine.capabilities(state.window) ? state : null;
}

/**
 * Replaces the Dashboard region with freshly rendered `GET /` markup, keeping
 * the page shell, header actions and dialogs. Counts and rows come only from
 * the server; the client carries over retained scheduling confirmations,
 * unsent custom dates, validation errors on rows still undated, the Projects
 * status filter and focus. Retained
 * confirmations are named in `?retain=` so the response carries their
 * current title popovers.
 *
 * Resolves (never rejects) with:
 * - `{ status: 'refreshed' }`
 * - `{ status: 'failed', reason, replaced, error }`, where `reason` is
 *   `unavailable`, `request`, `response`, `invalid` or `install`. Only
 *   `install` has `replaced: true`; otherwise the previous dashboard is intact.
 * - `{ status: 'superseded' }` when a later refresh took over.
 *
 * `releaseId` names the release whose mutation prompted the refresh, so focus
 * lost from that row returns to it.
 */
export function refreshDashboard(scope = globalThis.document, { releaseId = null } = {}) {
  const state = dashboardState(scope);
  if (!state) return Promise.resolve(refreshFailure('unavailable'));
  let url;
  try {
    url = new URL('/', state.window.location?.href);
  } catch (error) {
    return Promise.resolve(refreshFailure('unavailable', { error }));
  }
  const retainedIds = retainedReleaseIds(state);
  if (retainedIds.length) url.searchParams.set('retain', retainedIds.join(','));
  dashboardLiveEngine.invalidate(state);
  return new Promise((resolve) => {
    state.dashboardRefresh = {
      resolve,
      retainedIds,
      releaseId: releaseId === null || releaseId === undefined ? null : String(releaseId),
      snapshot: null,
      nextToday: null,
      replaced: false,
    };
    dashboardLiveEngine.load(state, url, 'none', null);
  });
}

/**
 * Enables Needs-a-date scheduling with an authoritative Dashboard refresh
 * after every confirmed schedule or Undo. The refresh runs inside
 * `onScheduleConfirmed`, so the page mutation gate stays held until the
 * replacement settles.
 *
 * `onRefreshFailed({ ...outcome, mutation })` is required and awaited under
 * the gate: a confirmed write whose refresh did not complete leaves the
 * Dashboard stale, and the caller owns recovery. It receives every outcome
 * other than `refreshed`, including `superseded`. `onReconcileRequired`,
 * `announce` and `request` pass through to enhanceDashboardReleaseScheduling.
 *
 * Returns `{ refresh(options) }` bound to the document, or null without a
 * Dashboard. Calling again binds only newly rendered rows.
 */
export function enhanceDashboardScheduleRefresh(scope, {
  onReconcileRequired,
  onRefreshFailed,
  announce,
  request,
} = {}) {
  if (typeof onReconcileRequired !== 'function' || typeof onRefreshFailed !== 'function') {
    throw new TypeError('Dashboard schedule refresh requires onReconcileRequired and onRefreshFailed callbacks.');
  }
  const state = dashboardState(scope);
  if (!state) return null;
  if (!state.dashboardScheduling) {
    const doc = state.document;
    // Rows are bound one at a time so each container maps to its controller.
    const controllers = new WeakMap();
    const options = {
      async onScheduleConfirmed(mutation) {
        const outcome = await refreshDashboard(doc, { releaseId: mutation.releaseId });
        if (outcome.status !== 'refreshed') await onRefreshFailed({ ...outcome, mutation });
      },
      onReconcileRequired,
      announce,
      request,
    };
    state.dashboardScheduling = {
      controllers,
      bind(root) {
        for (const container of root.querySelectorAll(SCHEDULE_SELECTOR)) {
          const [controller] = enhanceDashboardReleaseScheduling(container, options);
          if (controller) controllers.set(container, controller);
        }
      },
      // Disposes rows a replacement left behind. Retained confirmations were
      // moved into the new region, so they keep their subscriptions.
      retire(containers, region) {
        for (const container of containers) {
          if (region.contains(container)) continue;
          controllers.get(container)?.dispose();
          controllers.delete(container);
        }
      },
      handle: { refresh: (refreshOptions) => refreshDashboard(doc, refreshOptions) },
    };
  }
  state.dashboardScheduling.bind(dashboardLiveEngine.getRegion(state.document));
  return state.dashboardScheduling.handle;
}

const SYNC_SELECTOR = '[data-dashboard-sync]';
const SYNC_MESSAGE_SELECTOR = '[data-dashboard-sync-message]';
const SYNC_RETRY_SELECTOR = '[data-dashboard-sync-retry]';
const SYNC_RELOAD_SELECTOR = '[data-dashboard-sync-reload]';
const SYNC_DISMISS_SELECTOR = '[data-dashboard-sync-dismiss]';
const ANNOUNCER_SELECTOR = '[data-dashboard-announcer]';
const RELEASE_ROW_SELECTOR = '[data-dashboard-release-row]';
const SYNC_BOUND_KEY = 'dashboardSyncBound';
// Long enough for assistive technology to notice the cleared region, so an
// identical message is announced again.
const ANNOUNCE_DELAY_MS = 100;

const RECOVERY_MESSAGES = Object.freeze({
  refreshing: 'Refreshing the dashboard…',
  refreshed: 'Dashboard refreshed. Scheduling is available again.',
  undoUnavailable: 'Dashboard refreshed. Undo is no longer available for that change; open the release to change its date.',
  paused: 'Scheduling is paused until the dashboard refreshes.',
  stillFailing: 'Try again, or reload the page.',
});

function refreshProblem(outcome) {
  if (outcome.status === 'superseded') return 'the dashboard refresh was interrupted';
  // A replaced region whose enhancement failed may show current data with
  // controls that do not work, so it is never reported as refreshed.
  if (outcome.replaced) return 'the refreshed dashboard didn’t finish loading';
  return 'the dashboard couldn’t refresh';
}

function releaseName(title) {
  return title ? `“${title}”` : 'This release';
}

function reconcileLead({ action, reason }) {
  if (reason === 'conflict') {
    return action === 'undo'
      ? 'Undo wasn’t applied because this release’s schedule was changed elsewhere.'
      : 'Nothing was overwritten because this release’s schedule was changed elsewhere.';
  }
  if (reason === 'not-found') return 'This release no longer exists, so its schedule wasn’t changed.';
  return action === 'undo'
    ? 'We couldn’t confirm whether Undo was saved.'
    : 'We couldn’t confirm whether the schedule change was saved.';
}

function scheduleSentence(name, schedule) {
  return schedule.plannedDate
    ? `${name} is scheduled for ${formatScheduleDate(schedule.plannedDate)}.`
    : `${name} has no release date.`;
}

/**
 * Where the freshly rendered dashboard shows a release. A release being
 * reconciled is never a retained confirmation, because only rows in a
 * confirmed state are carried across a refresh, so any Needs-a-date item or
 * scheduled row for it is server state.
 */
function locateRelease(region, releaseId) {
  const id = String(releaseId);
  if (findByAttribute(region, NEEDS_DATE_ITEM_SELECTOR, 'data-release-id', id)) return { state: 'undated' };
  const row = findByAttribute(region, RELEASE_ROW_SELECTOR, 'data-release-id', id);
  const date = row?.querySelector('.dashboard-date-block time[datetime]')?.getAttribute('datetime');
  if (isIsoDate(date)) return { state: 'scheduled', plannedDate: date };
  return { state: 'unlisted' };
}

function reconciledMessage(followUp, region) {
  const { detail, title } = followUp;
  const lead = reconcileLead(detail);
  if (detail.reason === 'not-found') return `${lead} The dashboard has been refreshed.`;
  const name = releaseName(title);
  const located = region ? locateRelease(region, detail.releaseId) : { state: 'unlisted' };
  if (located.state === 'undated') return `${lead} ${name} currently has no release date.`;
  if (located.state === 'scheduled') {
    return `${lead} ${name} is currently scheduled for ${formatScheduleDate(located.plannedDate)}.`;
  }
  // The dashboard lists only part of each queue; a conflict response still
  // reported the schedule the server held when it refused the write.
  if (detail.currentSchedule) return `${lead} ${scheduleSentence(name, detail.currentSchedule)}`;
  return `${lead} ${name} isn’t listed on the dashboard right now. Open the release to check its schedule.`;
}

function blockedMessage(followUp, outcome) {
  const problem = refreshProblem(outcome);
  if (followUp.kind === 'saved') {
    const change = followUp.mutation.action === 'undo' ? 'Undo was saved' : 'The schedule change was saved';
    return `${change}, but ${problem}, so counts and lists may be out of date. ${RECOVERY_MESSAGES.paused}`;
  }
  const { detail, title } = followUp;
  const known = detail.reason === 'conflict' && detail.currentSchedule
    ? ` ${scheduleSentence(releaseName(title), detail.currentSchedule)}`
    : '';
  const problemSentence = `${problem.charAt(0).toUpperCase()}${problem.slice(1)}`;
  return `${reconcileLead(detail)}${known} ${problemSentence}, so it may not show the current schedule. ${RECOVERY_MESSAGES.paused}`;
}

function readSyncElements(doc) {
  const banner = doc.querySelector?.(SYNC_SELECTOR);
  const elements = {
    banner,
    message: banner?.querySelector(SYNC_MESSAGE_SELECTOR),
    retry: banner?.querySelector(SYNC_RETRY_SELECTOR),
    reload: banner?.querySelector(SYNC_RELOAD_SELECTOR),
    dismiss: banner?.querySelector(SYNC_DISMISS_SELECTOR),
    announcer: doc.querySelector?.(ANNOUNCER_SELECTOR),
  };
  // Each element must sit outside the refreshed region, or recovery could
  // not be offered or announced once a replacement removed it.
  const region = dashboardLiveEngine.getRegion(doc);
  const usable = Object.values(elements).every((element) => element && !region?.contains(element));
  return usable ? elements : null;
}

/**
 * Owns the page-level state after a schedule lifecycle could not leave the
 * dashboard verifiably current: a confirmed write whose refresh failed, or an
 * outcome (conflict, missing release, unconfirmed response) that needs the
 * server's current state. While unresolved it holds the mutation gate so no
 * row can write with expected schedules that may be stale; only an
 * authoritative refresh releases it. Recovery never repeats a POST.
 */
function createScheduleRecovery(doc, ui) {
  const gate = getDashboardMutationGate(doc);
  let pending = null;
  let retrying = false;
  let announceTimer = null;
  // The release a settled notice describes, where Dismiss returns focus.
  let noticeReleaseId = null;

  function announce(message) {
    clearTimeout(announceTimer);
    ui.announcer.textContent = '';
    announceTimer = setTimeout(() => { ui.announcer.textContent = message; }, ANNOUNCE_DELAY_MS);
  }

  function focusAfterBanner(releaseId) {
    const region = dashboardLiveEngine.getRegion(doc);
    if (!region) return;
    const target = (releaseId !== null && releaseFocusTarget(region, String(releaseId)))
      || headingFocusTarget(region, NEEDS_DATE_HEADING_ID);
    target?.focus?.({ preventScroll: true });
  }

  // `blocked` offers Retry refresh and reload, `refreshing` keeps them while a
  // retry runs, and `notice` reports a settled outcome until dismissed.
  function show(mode, message) {
    const active = doc.activeElement;
    const hadFocus = Boolean(active) && ui.banner.contains(active);
    ui.message.textContent = message;
    ui.banner.setAttribute('data-state', mode);
    ui.banner.classList.toggle('notice--warning', mode !== 'notice');
    ui.banner.classList.toggle('notice--info', mode === 'notice');
    setHidden(ui.retry, mode === 'notice');
    setHidden(ui.reload, mode === 'notice');
    setHidden(ui.dismiss, mode !== 'notice');
    // aria-disabled rather than disabled keeps keyboard focus on the button.
    if (mode === 'refreshing') ui.retry.setAttribute('aria-disabled', 'true');
    else ui.retry.removeAttribute('aria-disabled');
    ui.retry.textContent = mode === 'refreshing' ? 'Refreshing…' : 'Retry refresh';
    setHidden(ui.banner, false);
    // Focus on a control this mode hides moves to the control replacing it.
    if (hadFocus && active.closest('[hidden]')) (mode === 'notice' ? ui.dismiss : ui.retry).focus?.();
  }

  function hide(releaseId = null) {
    const hadFocus = ui.banner.contains(doc.activeElement);
    setHidden(ui.banner, true);
    ui.banner.removeAttribute('data-state');
    if (hadFocus) focusAfterBanner(releaseId);
  }

  function block(followUp, outcome, suffix = '') {
    if (!pending) pending = { release: gate.hold() };
    pending.followUp = followUp;
    const message = `${blockedMessage(followUp, outcome)}${suffix}`;
    show('blocked', message);
    announce(message);
  }

  function settledMessage(followUp) {
    const region = dashboardLiveEngine.getRegion(doc);
    if (followUp.kind === 'reconcile') return reconciledMessage(followUp, region);
    const { mutation } = followUp;
    // A replacement that failed part-way can drop the confirmation holding
    // Undo; say so rather than imply it is still available.
    const undoExpected = mutation.action === 'schedule' && mutation.changed
      && mutation.previousSchedule.plannedTime === null;
    const item = region && findByAttribute(region, NEEDS_DATE_ITEM_SELECTOR, 'data-release-id', String(mutation.releaseId));
    if (undoExpected && !item?.querySelector(SCHEDULE_UNDO_SELECTOR)) return RECOVERY_MESSAGES.undoUnavailable;
    return RECOVERY_MESSAGES.refreshed;
  }

  function settle(followUp) {
    const release = pending?.release;
    pending = null;
    release?.();
    const message = settledMessage(followUp);
    noticeReleaseId = followUp.releaseId;
    show('notice', message);
    announce(message);
  }

  async function retry() {
    if (!pending || retrying) return;
    retrying = true;
    show('refreshing', RECOVERY_MESSAGES.refreshing);
    announce(RECOVERY_MESSAGES.refreshing);
    try {
      const { followUp } = pending;
      const outcome = await refreshDashboard(doc, { releaseId: followUp.releaseId });
      if (outcome.status === 'refreshed') settle(followUp);
      else block(followUp, outcome, ` ${RECOVERY_MESSAGES.stillFailing}`);
    } finally {
      retrying = false;
    }
  }

  function bindControls() {
    if (isEnhancementBound(ui.banner, SYNC_BOUND_KEY)) return;
    markEnhancementBound(ui.banner, SYNC_BOUND_KEY);
    ui.retry.addEventListener('click', (event) => {
      event.preventDefault();
      if (ui.retry.getAttribute('aria-disabled') === 'true') return;
      void retry();
    });
    ui.dismiss.addEventListener('click', () => {
      if (!pending) hide(noticeReleaseId);
    });
  }

  return {
    bindControls,
    // Row outcomes pass through here; a newer outcome replaces a settled
    // notice about an earlier one.
    announceRow(message) {
      if (!pending && ui.banner.getAttribute('data-state') === 'notice') hide();
      announce(message);
    },
    async refreshFailed({ mutation, ...outcome }) {
      block({ kind: 'saved', mutation, releaseId: mutation.releaseId }, outcome);
    },
    async reconcile(detail) {
      const region = dashboardLiveEngine.getRegion(doc);
      const item = region && findByAttribute(region, NEEDS_DATE_ITEM_SELECTOR, 'data-release-id', String(detail.releaseId));
      const title = item?.querySelector(TITLE_TRIGGER_SELECTOR)?.textContent.trim() || null;
      const followUp = { kind: 'reconcile', detail, title, releaseId: detail.releaseId };
      const outcome = await refreshDashboard(doc, { releaseId: detail.releaseId });
      if (outcome.status === 'refreshed') settle(followUp);
      else block(followUp, outcome);
    },
  };
}

const scheduleRecoveries = new WeakMap();

/**
 * Activates Needs-a-date scheduling on the Dashboard: quick picks, custom
 * dates and Undo write through `POST /releases/:id/schedule`, every confirmed
 * write refreshes the dashboard from `GET /`, and outcomes that leave it
 * unverified are recovered through a page-level status offering Retry
 * refresh (a GET only) and a full reload.
 *
 * Controls stay disabled unless every part of the lifecycle can run, so a
 * native submit can never reach the JSON-only endpoint. Repeated calls bind
 * only newly rendered rows. Returns `{ refresh(options) }` or null.
 */
export function enhanceDashboardScheduling(scope = globalThis.document, { request } = {}) {
  const doc = liveRegionDocument(scope);
  if (!doc || !dashboardLiveEngine.getRegion(doc)) return null;
  let recovery = scheduleRecoveries.get(doc);
  if (!recovery) {
    const ui = readSyncElements(doc);
    if (!ui) return null;
    recovery = createScheduleRecovery(doc, ui);
    scheduleRecoveries.set(doc, recovery);
  }
  let handle;
  try {
    handle = enhanceDashboardScheduleRefresh(doc, {
      onReconcileRequired: recovery.reconcile,
      onRefreshFailed: recovery.refreshFailed,
      announce: recovery.announceRow,
      request,
    });
  } catch {
    return null;
  }
  if (handle) recovery.bindControls();
  return handle;
}
