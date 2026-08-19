import { isEnhancementBound, markEnhancementBound } from './dom.js';

const DATE_PICKER_FIELD_SELECTOR = '[data-date-picker-field]';
const DATE_PICKER_INPUT_SELECTOR = '[data-date-picker-input]';
const DATE_PICKER_TRIGGER_SELECTOR = '.date-picker-trigger';
const DATE_PICKER_PANEL_SELECTOR = '[data-date-picker-panel]';
const DATE_PICKER_BOUND_KEY = 'datePickerBound';
const TIME_PICKER_FIELD_SELECTOR = '[data-time-picker-field]';
const TIME_PICKER_INPUT_SELECTOR = '[data-time-picker-input]';
const TIME_PICKER_TRIGGER_SELECTOR = '[data-time-picker-trigger]';
const TIME_PICKER_PANEL_SELECTOR = '[data-time-picker-panel]';
const TIME_PICKER_BOUND_KEY = 'timePickerBound';

const WEEKDAY_SHORT_NAMES = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function padTwo(value) {
  return String(value).padStart(2, '0');
}

function formatIsoDate(year, month, day) {
  return `${year}-${padTwo(month)}-${padTwo(day)}`;
}

function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(-?\d{4,})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function parseTimeValue(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function formatTimeValue(hour, minute) {
  return `${padTwo(hour)}:${padTwo(minute)}`;
}

function localToday() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function firstWeekdayOffset(year, month) {
  // Monday-start (0 = Monday, 6 = Sunday) to align with WEEKDAY_SHORT_NAMES.
  return (new Date(year, month - 1, 1).getDay() + 6) % 7;
}

function previousMonth(year, month) {
  if (month === 1) {
    if (year - 1 < 1000) return null;
    return { year: year - 1, month: 12 };
  }
  return { year, month: month - 1 };
}

function nextMonth(year, month) {
  if (month === 12) {
    if (year + 1 > 9999) return null;
    return { year: year + 1, month: 1 };
  }
  return { year, month: month + 1 };
}

function findDatePickerParts(field) {
  const input = field.querySelector(DATE_PICKER_INPUT_SELECTOR);
  const panel = field.querySelector(DATE_PICKER_PANEL_SELECTOR);
  const trigger = field.querySelector(DATE_PICKER_TRIGGER_SELECTOR)
    || (panel && field.querySelector(`button[aria-controls="${panel.id}"]`));
  return { input, trigger, panel };
}

function datePickerState(field) {
  return {
    field,
    ...findDatePickerParts(field),
    open: false,
    viewYear: null,
    viewMonth: null,
  };
}

function renderDatePickerHeader(state) {
  const { viewYear, viewMonth } = state;
  const header = document.createElement('div');
  header.className = 'date-picker-header';

  const prev = previousMonth(viewYear, viewMonth);
  const next = nextMonth(viewYear, viewMonth);

  const prevButton = document.createElement('button');
  prevButton.type = 'button';
  prevButton.className = 'date-picker-nav date-picker-prev';
  prevButton.setAttribute('aria-label', 'Previous month');
  prevButton.textContent = '←';
  prevButton.disabled = prev === null;
  prevButton.addEventListener('click', () => {
    if (prev) {
      state.viewYear = prev.year;
      state.viewMonth = prev.month;
      renderDatePicker(state);
    }
  });

  const title = document.createElement('span');
  title.className = 'date-picker-month-title';
  title.setAttribute('aria-live', 'polite');
  title.textContent = `${MONTH_NAMES[viewMonth - 1]} ${viewYear}`;

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'date-picker-nav date-picker-next';
  nextButton.setAttribute('aria-label', 'Next month');
  nextButton.textContent = '→';
  nextButton.disabled = next === null;
  nextButton.addEventListener('click', () => {
    if (next) {
      state.viewYear = next.year;
      state.viewMonth = next.month;
      renderDatePicker(state);
    }
  });

  header.appendChild(prevButton);
  header.appendChild(title);
  header.appendChild(nextButton);
  return header;
}

function renderDatePickerGrid(state) {
  const { input, viewYear, viewMonth } = state;
  const selected = parseIsoDate(input?.value || '');
  const today = localToday();
  const firstDay = firstWeekdayOffset(viewYear, viewMonth);
  const days = daysInMonth(viewYear, viewMonth);
  const prev = previousMonth(viewYear, viewMonth);
  const prevDays = prev ? daysInMonth(prev.year, prev.month) : 31;
  const totalCells = Math.ceil((firstDay + days) / 7) * 7;

  const grid = document.createElement('div');
  grid.className = 'date-picker-grid';
  grid.setAttribute('aria-label', `${MONTH_NAMES[viewMonth - 1]} ${viewYear}`);

  const headerRow = document.createElement('div');
  headerRow.className = 'date-picker-weekdays';
  for (const name of WEEKDAY_SHORT_NAMES) {
    const cell = document.createElement('div');
    cell.className = 'date-picker-weekday';
    cell.textContent = name;
    headerRow.appendChild(cell);
  }
  grid.appendChild(headerRow);

  const cellsRow = document.createElement('div');
  cellsRow.className = 'date-picker-days';

  for (let i = 0; i < totalCells; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'date-picker-day picker-option';

    if (i < firstDay) {
      const day = prevDays - firstDay + 1 + i;
      cell.classList.add('is-out-of-month');
      cell.textContent = String(day);
      cell.disabled = true;
      cell.setAttribute(
        'aria-label',
        prev
          ? `${day} ${MONTH_NAMES[prev.month - 1]} ${prev.year}`
          : `${day} from previous month (unavailable)`,
      );
      cell.setAttribute('aria-disabled', 'true');
    } else if (i < firstDay + days) {
      const day = i - firstDay + 1;
      const iso = formatIsoDate(viewYear, viewMonth, day);
      cell.textContent = String(day);
      cell.setAttribute('aria-label', iso);
      cell.setAttribute('data-date', iso);

      const isToday = today.year === viewYear && today.month === viewMonth && today.day === day;
      const isSelected = selected && selected.year === viewYear && selected.month === viewMonth && selected.day === day;
      cell.classList.toggle('is-today', isToday);
      cell.classList.toggle('is-selected', isSelected);
      if (isToday) cell.setAttribute('aria-current', 'date');
      if (isSelected) cell.setAttribute('aria-selected', 'true');

      cell.addEventListener('click', () => {
        if (input) {
          input.value = iso;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeDatePicker(state, true);
      });
    } else {
      const day = i - firstDay - days + 1;
      const next = nextMonth(viewYear, viewMonth);
      cell.classList.add('is-out-of-month');
      cell.textContent = String(day);
      cell.disabled = true;
      cell.setAttribute('aria-label', `${day} ${MONTH_NAMES[(next?.month ?? 1) - 1]} ${next?.year ?? viewYear}`);
      cell.setAttribute('aria-disabled', 'true');
    }

    cellsRow.appendChild(cell);
  }
  grid.appendChild(cellsRow);
  return grid;
}

function renderDatePickerFooter(state) {
  const { input } = state;
  const footer = document.createElement('div');
  footer.className = 'date-picker-footer';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'date-picker-clear';
  clear.textContent = 'Clear';
  clear.setAttribute('aria-label', 'Clear selected date');
  clear.addEventListener('click', () => {
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeDatePicker(state, true);
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'date-picker-close';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close calendar');
  close.addEventListener('click', () => closeDatePicker(state, true));

  footer.appendChild(clear);
  footer.appendChild(close);
  return footer;
}

function renderDatePicker(state) {
  if (!state.panel) return;
  while (state.panel.firstChild) {
    state.panel.removeChild(state.panel.firstChild);
  }
  state.panel.appendChild(renderDatePickerHeader(state));
  state.panel.appendChild(renderDatePickerGrid(state));
  state.panel.appendChild(renderDatePickerFooter(state));
}

function findTimePickerParts(field) {
  const input = field.querySelector(TIME_PICKER_INPUT_SELECTOR);
  const panel = field.querySelector(TIME_PICKER_PANEL_SELECTOR);
  const trigger = field.querySelector(TIME_PICKER_TRIGGER_SELECTOR)
    || (panel && field.querySelector(`button[aria-controls="${panel.id}"]`));
  return { input, trigger, panel };
}

function timePickerState(field) {
  return {
    field,
    ...findTimePickerParts(field),
    open: false,
  };
}

function setTimePickerValue(state, hour, minute) {
  if (!state.input) return;
  state.input.value = formatTimeValue(hour, minute);
  state.input.dispatchEvent(new Event('input', { bubbles: true }));
  state.input.dispatchEvent(new Event('change', { bubbles: true }));
}

function renderTimePickerColumn(state, type, values, selectedValue) {
  const column = document.createElement('div');
  column.className = 'time-picker-column';
  column.setAttribute('aria-label', type === 'hour' ? 'Hours' : 'Minutes');

  const label = document.createElement('span');
  label.className = 'time-picker-column-label';
  label.textContent = type === 'hour' ? 'Hour' : 'Minute';
  column.appendChild(label);

  const options = document.createElement('div');
  options.className = 'time-picker-options';

  for (const value of values) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'time-picker-option picker-option';
    option.textContent = padTwo(value);
    option.setAttribute(`data-time-${type}`, String(value));
    option.setAttribute('aria-label', `${type === 'hour' ? 'Hour' : 'Minute'} ${padTwo(value)}`);
    option.setAttribute('aria-pressed', String(value === selectedValue));
    option.classList.toggle('is-selected', value === selectedValue);
    option.addEventListener('click', () => {
      const current = parseTimeValue(state.input?.value || '') || { hour: 0, minute: 0 };
      const next = type === 'hour'
        ? { hour: value, minute: current.minute }
        : { hour: current.hour, minute: value };
      setTimePickerValue(state, next.hour, next.minute);
      renderTimePicker(state);
      const selected = Array.from(state.panel?.querySelectorAll('.time-picker-option') || [])
        .find((candidate) => candidate.getAttribute(`data-time-${type}`) === String(value)
          && candidate.getAttribute('aria-pressed') === 'true');
      selected?.focus?.();
    });
    options.appendChild(option);
  }

  column.appendChild(options);

  return column;
}

function renderTimePickerFooter(state) {
  const footer = document.createElement('div');
  footer.className = 'date-picker-footer';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'date-picker-clear';
  clear.textContent = 'Clear';
  clear.setAttribute('aria-label', 'Clear selected time');
  clear.addEventListener('click', () => {
    if (state.input) {
      state.input.value = '';
      state.input.dispatchEvent(new Event('input', { bubbles: true }));
      state.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeTimePicker(state, true);
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'date-picker-close';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close time picker');
  close.addEventListener('click', () => closeTimePicker(state, true));

  footer.appendChild(clear);
  footer.appendChild(close);
  return footer;
}

function renderTimePicker(state) {
  if (!state.panel) return;
  while (state.panel.firstChild) {
    state.panel.removeChild(state.panel.firstChild);
  }

  const current = parseTimeValue(state.input?.value || '') || { hour: 0, minute: 0 };
  const header = document.createElement('div');
  header.className = 'date-picker-header';
  const title = document.createElement('span');
  title.className = 'date-picker-month-title';
  title.setAttribute('aria-live', 'polite');
  title.textContent = 'Select time';
  header.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'time-picker-grid';
  grid.appendChild(renderTimePickerColumn(state, 'hour', Array.from({ length: 24 }, (_, hour) => hour), current.hour));
  grid.appendChild(renderTimePickerColumn(state, 'minute', Array.from({ length: 60 }, (_, minute) => minute), current.minute));

  state.panel.appendChild(header);
  state.panel.appendChild(grid);
  state.panel.appendChild(renderTimePickerFooter(state));
}

function setViewFromValue(state) {
  const parsed = parseIsoDate(state.input?.value || '');
  if (parsed) {
    state.viewYear = parsed.year;
    state.viewMonth = parsed.month;
  } else {
    const today = localToday();
    state.viewYear = today.year;
    state.viewMonth = today.month;
  }
}

function closeDatePicker(state, restoreFocus = false) {
  if (!state.open) return;
  state.open = false;
  if (state.panel) {
    state.panel.hidden = true;
    state.panel.removeAttribute('open');
  }
  if (state.trigger) {
    state.trigger.setAttribute('aria-expanded', 'false');
  }
  if (restoreFocus) state.trigger?.focus?.();
}

function openDatePicker(state, allStates) {
  if (state.open) return;
  for (const other of allStates) {
    if (other !== state) closeDatePicker(other);
  }
  setViewFromValue(state);
  renderDatePicker(state);
  state.open = true;
  if (state.panel) {
    state.panel.hidden = false;
    state.panel.setAttribute('open', '');
  }
  if (state.trigger) {
    state.trigger.setAttribute('aria-expanded', 'true');
  }
  // Focus the selected day if present, otherwise the first focusable day.
  const selected = state.panel?.querySelector('.date-picker-day.is-selected');
  const firstDay = state.panel?.querySelector('.date-picker-day:not([disabled])');
  (selected || firstDay)?.focus?.();
}

function bindDatePickerState(state, allStates) {
  if (!state.trigger || !state.panel || !state.input) return;

  state.trigger.addEventListener('click', (event) => {
    event.preventDefault?.();
    if (state.open) {
      closeDatePicker(state, true);
    } else {
      openDatePicker(state, allStates);
    }
  });

  state.panel.addEventListener('click', (event) => event.stopPropagation());

  state.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      closeDatePicker(state, true);
    }
  });
}

function getDatePickerFields(scope) {
  return Array.from(scope?.querySelectorAll?.(DATE_PICKER_FIELD_SELECTOR) || []);
}

export function enhanceDatePickers(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const fields = getDatePickerFields(scope);
  if (fields.length === 0) return 0;

  const states = fields.map(datePickerState);

  // Bind per-field interactions once.
  states.forEach((state) => {
    if (isEnhancementBound(state.field, DATE_PICKER_BOUND_KEY)) return;
    markEnhancementBound(state.field, DATE_PICKER_BOUND_KEY);
    bindDatePickerState(state, states);
  });

  // Bind singleton document-level dismissal only once per scope.
  if (!isEnhancementBound(scope, 'datePickerDocumentBound')) {
    markEnhancementBound(scope, 'datePickerDocumentBound');

    document.addEventListener?.('click', (event) => {
      const target = event.target;
      const active = states.find((state) => state.open);
      if (!active) return;
      if (target && (active.field.contains(target) || active.panel.contains(target))) return;
      closeDatePicker(active);
    });

    document.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const active = states.find((state) => state.open);
      if (!active) return;
      // If focus is inside the active panel, the panel handler will close and
      // refocus the trigger. Only handle Escape when focus is outside the panel
      // to avoid double-preventDefault and inconsistent focus behavior.
      if (active.panel.contains(document.activeElement)) return;
      event.preventDefault?.();
      closeDatePicker(active, true);
    });
  }

  return fields.length;
}

function closeTimePicker(state, restoreFocus = false) {
  if (!state.open) return;
  state.open = false;
  if (state.panel) {
    state.panel.hidden = true;
    state.panel.removeAttribute('open');
  }
  if (state.trigger) {
    state.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) state.trigger.focus?.();
  }
}

function openTimePicker(state, allStates) {
  if (state.open) return;
  for (const other of allStates) {
    if (other !== state) closeTimePicker(other);
  }
  renderTimePicker(state);
  state.open = true;
  if (state.panel) {
    state.panel.hidden = false;
    state.panel.setAttribute('open', '');
  }
  if (state.trigger) {
    state.trigger.setAttribute('aria-expanded', 'true');
  }
  const selectedOptions = Array.from(state.panel?.querySelectorAll('.time-picker-option.is-selected') || []);
  selectedOptions.forEach((option) => option.scrollIntoView?.({ block: 'center' }));
  selectedOptions[0]?.focus?.();
}

function bindTimePickerState(state, allStates) {
  if (!state.trigger || !state.panel || !state.input) return;

  const open = (event) => {
    event?.preventDefault?.();
    if (!state.open) openTimePicker(state, allStates);
  };

  state.trigger.addEventListener('click', (event) => {
    event.preventDefault?.();
    if (state.open) closeTimePicker(state, true);
    else openTimePicker(state, allStates);
  });
  state.input.addEventListener('click', open);
  state.panel.addEventListener('click', (event) => event.stopPropagation());
  state.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      closeTimePicker(state, true);
    }
  });
}

export function enhanceTimePickers(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const fields = Array.from(scope.querySelectorAll(TIME_PICKER_FIELD_SELECTOR) || []);
  if (fields.length === 0) return 0;

  const states = fields.map(timePickerState);
  states.forEach((state) => {
    if (isEnhancementBound(state.field, TIME_PICKER_BOUND_KEY)) return;
    markEnhancementBound(state.field, TIME_PICKER_BOUND_KEY);
    bindTimePickerState(state, states);
  });

  if (!isEnhancementBound(scope, 'timePickerDocumentBound')) {
    markEnhancementBound(scope, 'timePickerDocumentBound');

    document.addEventListener?.('click', (event) => {
      const target = event.target;
      const active = states.find((state) => state.open);
      if (!active) return;
      if (target && (active.field.contains(target) || active.panel.contains(target))) return;
      closeTimePicker(active);
    });

    document.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const active = states.find((state) => state.open);
      if (!active) return;
      if (active.panel.contains(document.activeElement)) return;
      event.preventDefault?.();
      closeTimePicker(active, true);
    });
  }

  return fields.length;
}
