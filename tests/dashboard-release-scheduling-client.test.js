import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  enhanceDashboardReleaseScheduling,
  enhanceDashboardScheduleRefresh,
  getDashboardMutationGate,
  refreshDashboard,
} from '../src/static/client/dashboard.js';

// A minimal DOM supporting the attribute selectors the enhancer uses.
class FakeElement {
  constructor(doc, tagName, attributes = {}) {
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.dataset = {};
    this.value = attributes.value ?? '';
    this.text = '';
  }
  get disabled() { return this.attributes.has('disabled'); }
  set disabled(value) { if (value) this.attributes.set('disabled', ''); else this.attributes.delete('disabled'); }
  get isConnected() {
    let node = this;
    while (node.parent) node = node.parent;
    return node === this.ownerDocument.body;
  }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  append(...nodes) {
    for (const node of nodes) { node.parent = this; this.children.push(node); }
    return this;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.text = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  matches(selector) {
    const match = /^(\w+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector);
    if (!match) throw new Error(`Unsupported selector ${selector}`);
    const [, tag, attribute, value] = match;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (attribute && !this.attributes.has(attribute)) return false;
    return value === undefined || this.attributes.get(attribute) === value;
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.matches?.(selector)) return node;
    return null;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  listenerCount() { return [this, ...this.descendants()].reduce((sum, node) => sum + [...node.listeners.values()].flat().length, 0); }
  dispatch(type, init = {}) {
    const event = { type, target: init.target || this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (let node = event.target; node; node = node.parent) {
      for (const listener of node.listeners.get(type) || []) listener(event);
    }
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
}

function createDocument() {
  const doc = { nodeType: 9, activeElement: null, listeners: new Map() };
  doc.addEventListener = (type, listener) => {
    if (!doc.listeners.has(type)) doc.listeners.set(type, []);
    doc.listeners.get(type).push(listener);
  };
  doc.dispatch = (type, init) => { for (const listener of doc.listeners.get(type) || []) listener({ type, ...init }); };
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.body = new FakeElement(doc, 'body');
  doc.querySelectorAll = (selector) => doc.body.querySelectorAll(selector);
  return doc;
}

function hiddenFields(doc, { date, time }) {
  return [
    new FakeElement(doc, 'input', { type: 'hidden', name: '_csrf', value: 'csrf-token' }),
    new FakeElement(doc, 'input', { type: 'hidden', name: 'expectedPlannedDate', value: date }),
    new FakeElement(doc, 'input', { type: 'hidden', name: 'expectedPlannedTime', value: time }),
    new FakeElement(doc, 'input', { type: 'hidden', name: 'plannedTime', value: '' }),
  ];
}

function renderRow(doc, { id, picks = ['2026-10-13', '2026-10-14', '2026-10-16'], expectedDate = '', expectedTime = '', omitExpected = false }) {
  const el = (tag, attributes) => new FakeElement(doc, tag, attributes);
  const url = `/releases/${id}/schedule`;
  const item = el('li', { 'data-dashboard-needs-date-item': '', 'data-release-id': id });
  const attrs = { 'data-dashboard-schedule': '', 'data-release-id': id, 'data-schedule-url': url };
  if (!omitExpected) Object.assign(attrs, { 'data-expected-planned-date': expectedDate, 'data-expected-planned-time': expectedTime });
  const container = el('div', attrs);
  const hidden = { date: expectedDate, time: expectedTime };
  const pickButtons = picks.map((date) => el('button', {
    type: 'submit', name: 'plannedDate', value: date, 'data-dashboard-schedule-pick': '', 'data-planned-date': date,
  }));
  const quickFieldset = el('fieldset', { disabled: '', 'data-dashboard-schedule-controls': '' }).append(...pickButtons);
  const quickForm = el('form', { method: 'post', action: url, 'data-dashboard-schedule-quick-form': '' })
    .append(...hiddenFields(doc, hidden), quickFieldset);
  const dateInput = el('input', { type: 'date', name: 'plannedDate', required: '', 'data-dashboard-schedule-date': '' });
  const setButton = el('button', { type: 'submit', 'data-dashboard-schedule-set': '' });
  const customFieldset = el('fieldset', { disabled: '', 'data-dashboard-schedule-controls': '' }).append(dateInput, setButton);
  const customForm = el('form', { method: 'post', action: url, 'data-dashboard-schedule-custom-form': '' })
    .append(...hiddenFields(doc, hidden), customFieldset);
  const error = el('p', { id: `dashboard-schedule-error-${id}`, 'data-dashboard-schedule-error': '', hidden: '' });
  const status = el('div', { role: 'status', 'data-dashboard-schedule-status': '' });
  container.append(...(picks.length ? [quickForm] : []), customForm, error, status);
  item.append(container);
  doc.body.append(item);
  const row = {
    item, container, quickForm, customForm, quickFieldset, customFieldset, pickButtons, dateInput, setButton, error, status,
    pick(date) {
      const submitter = pickButtons.find((button) => button.getAttribute('data-planned-date') === date);
      return quickForm.dispatch('submit', { submitter });
    },
    // A press moves focus out of the field before the click submits.
    press(date, { button = 0, click = true } = {}) {
      const target = pickButtons.find((candidate) => candidate.getAttribute('data-planned-date') === date);
      doc.dispatch('pointerdown', { target, button });
      doc.activeElement?.dispatch('blur');
      target.focus();
      return click ? row.pick(date) : null;
    },
    type(value) {
      dateInput.focus();
      dateInput.dispatch('focus');
      dateInput.dispatch('keydown', { key: value.at(-1) });
      dateInput.value = value;
      dateInput.dispatch('change');
    },
    choose(value) {
      dateInput.value = value;
      return dateInput.dispatch('change');
    },
    submitCustom() { return customForm.dispatch('submit', { submitter: setButton }); },
    undoButton() { return status.querySelector('[data-dashboard-schedule-undo]'); },
    undo() { return row.undoButton().dispatch('click'); },
  };
  return row;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function success(id, previousSchedule, schedule, changed = true) {
  return jsonResponse(200, {
    status: 'success',
    message: 'Release scheduled.',
    changed,
    release: { id, previousSchedule, schedule },
  });
}

// Each request resolves only when the test settles it, exposing pending states.
function createRequest() {
  const calls = [];
  const request = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, body: JSON.parse(init.body), resolve, reject });
  });
  return { request, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// A real page gate whose reopen subscriptions can be counted.
function countingGate() {
  const gate = getDashboardMutationGate({});
  const subscribe = gate.onReopen;
  const live = new Set();
  gate.onReopen = (listener) => {
    const token = {};
    live.add(token);
    const stop = subscribe(listener);
    return () => { live.delete(token); stop(); };
  };
  return { gate, live };
}

function setup(rows = [{ id: 7 }], overrides = {}) {
  const doc = createDocument();
  const views = rows.map((row) => renderRow(doc, row));
  const { request, calls } = createRequest();
  const confirmed = [];
  const reconciled = [];
  const announced = [];
  const options = {
    request,
    onScheduleConfirmed: async (payload) => { confirmed.push(payload); },
    onReconcileRequired: async (payload) => { reconciled.push(payload); },
    announce: (message, context) => announced.push({ message, ...context }),
    ...overrides,
  };
  const controllers = enhanceDashboardReleaseScheduling(doc, options);
  return { doc, views, calls, confirmed, reconciled, announced, controllers, options };
}

const NO_DATE = { plannedDate: null, plannedTime: null };
const OCT_13 = { plannedDate: '2026-10-13', plannedTime: null };
const OCT_13_LABEL = new Date().getFullYear() === 2026 ? 'Tue, Oct 13' : 'Tue, Oct 13, 2026';

describe('enhanceDashboardReleaseScheduling', () => {
  it('requires the reconciliation callbacks before enabling any control', () => {
    const doc = createDocument();
    const row = renderRow(doc, { id: 7 });
    expect(() => enhanceDashboardReleaseScheduling(doc, { request: () => {} })).toThrow(TypeError);
    expect(row.quickFieldset.disabled).toBe(true);
    expect(row.customFieldset.disabled).toBe(true);
    expect(row.setButton.hasAttribute('hidden')).toBe(false);
  });

  it('enables the controls and hides Set only after binding', () => {
    const { views: [row] } = setup();
    expect(row.quickFieldset.disabled).toBe(false);
    expect(row.customFieldset.disabled).toBe(false);
    expect(row.setButton.hasAttribute('hidden')).toBe(true);
    expect(row.customForm.querySelector('[data-dashboard-schedule-set]')).toBe(row.setButton);
  });

  it('leaves a row without its rendered expected schedule unenhanced', () => {
    const { views: [row], controllers } = setup([{ id: 7, omitExpected: true }]);
    expect(controllers).toEqual([]);
    expect(row.quickFieldset.disabled).toBe(true);
    expect(row.setButton.hasAttribute('hidden')).toBe(false);
  });

  it('posts the picked date for that release with expected fields, CSRF and JSON conventions', () => {
    const { views: [, second], calls } = setup([{ id: 7 }, { id: 8 }]);
    const event = second.pick('2026-10-14');

    expect(event.defaultPrevented).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/releases/8/schedule');
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-token' },
    });
    expect(calls[0].body).toEqual({
      plannedDate: '2026-10-14', plannedTime: null, expectedPlannedDate: null, expectedPlannedTime: null,
    });
  });

  it('sends the schedule rendered for the row as the expected pair', () => {
    const { views: [row], calls } = setup([{ id: 9, expectedDate: '2026-11-01', expectedTime: '09:30' }]);
    row.pick('2026-10-13');
    expect(calls[0].body).toMatchObject({ expectedPlannedDate: '2026-11-01', expectedPlannedTime: '09:30' });
  });

  it('submits a custom date once on change and ignores the following submit', async () => {
    const { views: [row], calls } = setup();
    row.choose('2026-10-20');
    expect(row.submitCustom().defaultPrevented).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.plannedDate).toBe('2026-10-20');
  });

  it('never submits an empty or invalid custom date', () => {
    const { views: [row], calls } = setup();
    row.choose('');
    row.choose('0202-10-20');
    row.choose('2026-02-30');
    expect(calls).toHaveLength(0);
    expect(row.error.hasAttribute('hidden')).toBe(true);

    row.dateInput.value = '';
    expect(row.submitCustom().defaultPrevented).toBe(true);
    expect(calls).toHaveLength(0);
    expect(row.error.textContent).toBe('Choose a date first.');
    expect(row.error.hasAttribute('hidden')).toBe(false);
    expect(row.dateInput.getAttribute('aria-invalid')).toBe('true');
  });

  it('confirms a schedule in place, focuses Undo and reports the authoritative pairs', async () => {
    const { doc, views: [row], calls, confirmed, announced, controllers } = setup();
    row.pick('2026-10-13');
    expect(row.quickFieldset.disabled).toBe(true);
    expect(row.customFieldset.disabled).toBe(true);
    expect(row.container.getAttribute('aria-busy')).toBe('true');
    expect(row.status.textContent).toBe('Scheduling…');

    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();

    expect(row.item.isConnected).toBe(true);
    expect(row.quickForm.hasAttribute('hidden')).toBe(true);
    expect(row.customForm.hasAttribute('hidden')).toBe(true);
    expect(row.status.textContent).toBe(`✓ Scheduled for ${OCT_13_LABEL}Undo`);
    expect(doc.activeElement).toBe(row.undoButton());
    expect(row.undoButton().getAttribute('type')).toBe('button');
    expect(row.container.hasAttribute('aria-busy')).toBe(false);
    expect(announced).toEqual([{ message: `Scheduled for ${OCT_13_LABEL}.`, releaseId: 7 }]);
    expect(confirmed).toEqual([{
      action: 'schedule', releaseId: 7, changed: true, previousSchedule: NO_DATE, schedule: OCT_13,
    }]);
    expect(controllers[0].getState()).toEqual({
      phase: 'scheduled', current: OCT_13, confirmation: { previousSchedule: NO_DATE, schedule: OCT_13 },
    });
  });

  it('undoes with the confirmed schedule as the expected pair and restores the controls', async () => {
    const { doc, views: [row], calls, confirmed, announced } = setup();
    row.pick('2026-10-13');
    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();

    row.undo();
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('/releases/7/schedule');
    expect(calls[1].body).toEqual({
      plannedDate: null, plannedTime: null, expectedPlannedDate: '2026-10-13', expectedPlannedTime: null,
    });
    expect(row.undoButton().getAttribute('aria-disabled')).toBe('true');
    row.undo();
    expect(calls).toHaveLength(2);

    calls[1].resolve(success(7, OCT_13, NO_DATE));
    await flush();

    expect(row.quickForm.hasAttribute('hidden')).toBe(false);
    expect(row.customForm.hasAttribute('hidden')).toBe(false);
    expect(row.quickFieldset.disabled).toBe(false);
    expect(row.undoButton()).toBeNull();
    expect(doc.activeElement).toBe(row.pickButtons[0]);
    expect(row.status.textContent).toBe(`Undid scheduling for ${OCT_13_LABEL}. This release needs a date again.`);
    expect(announced.at(-1).message).toBe(row.status.textContent);
    expect(confirmed.at(-1)).toEqual({
      action: 'undo', releaseId: 7, changed: true, previousSchedule: OCT_13, schedule: NO_DATE,
    });

    row.pick('2026-10-14');
    expect(calls[2].body).toMatchObject({ expectedPlannedDate: null, expectedPlannedTime: null });
  });

  it('stops a stale Undo on 409 and hands the current schedule to reconciliation', async () => {
    const { views: [row], calls, confirmed, reconciled, controllers } = setup();
    row.pick('2026-10-13');
    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();

    row.undo();
    const current = { plannedDate: '2026-12-01', plannedTime: '18:00' };
    calls[1].resolve(jsonResponse(409, { status: 'error', code: 'SCHEDULE_CONFLICT', message: 'Changed.', currentSchedule: current }));
    await flush();

    expect(calls).toHaveLength(2);
    expect(confirmed).toHaveLength(1);
    expect(reconciled).toEqual([{
      action: 'undo', releaseId: 7, reason: 'conflict', status: 409,
      attempted: { plannedDate: null, plannedTime: null, expectedPlannedDate: '2026-10-13', expectedPlannedTime: null },
      currentSchedule: current,
    }]);
    expect(row.error.textContent).toMatch(/Undo wasn’t applied/);
    expect(row.undoButton().hasAttribute('disabled')).toBe(true);
    expect(controllers[0].getState().phase).toBe('locked');
    row.undo();
    row.pick('2026-10-14');
    expect(calls).toHaveLength(2);
  });

  it('locks a row after a schedule conflict without retrying', async () => {
    const { views: [row], calls, reconciled } = setup();
    row.pick('2026-10-13');
    calls[0].resolve(jsonResponse(409, { status: 'error', currentSchedule: OCT_13 }));
    await flush();
    expect(reconciled[0]).toMatchObject({ action: 'schedule', reason: 'conflict', currentSchedule: OCT_13 });
    expect(row.quickFieldset.disabled).toBe(true);
    expect(row.error.textContent).toMatch(/changed elsewhere, so nothing was overwritten/);
    expect(calls).toHaveLength(1);
  });

  it('shows the server validation message, keeps the chosen date and re-enables the row', async () => {
    const { doc, views: [row], calls, confirmed, reconciled } = setup();
    row.choose('2026-10-20');
    calls[0].resolve(jsonResponse(422, { status: 'error', message: 'Published releases cannot be rescheduled here.', errors: {} }));
    await flush();

    expect(row.error.textContent).toBe('Published releases cannot be rescheduled here.');
    expect(row.error.hasAttribute('hidden')).toBe(false);
    expect(row.dateInput.value).toBe('2026-10-20');
    expect(row.dateInput.getAttribute('aria-invalid')).toBe('true');
    expect(row.customFieldset.disabled).toBe(false);
    expect(row.status.textContent).toBe('');
    expect(doc.activeElement).toBe(row.dateInput);
    expect(confirmed).toEqual([]);
    expect(reconciled).toEqual([]);
  });

  it('explains a missing release and does not pretend it was scheduled', async () => {
    const { views: [row], calls, confirmed, reconciled } = setup();
    row.pick('2026-10-13');
    calls[0].resolve(jsonResponse(404, { status: 'error', code: 'RELEASE_NOT_FOUND', message: 'Release not found.' }));
    await flush();
    expect(row.error.textContent).toMatch(/no longer available/);
    expect(row.undoButton()).toBeNull();
    expect(row.quickForm.hasAttribute('hidden')).toBe(false);
    expect(confirmed).toEqual([]);
    expect(reconciled[0]).toMatchObject({ reason: 'not-found', status: 404 });
  });

  it('shows an actionable CSRF error without retrying', async () => {
    const { views: [row], calls } = setup();
    row.pick('2026-10-13');
    calls[0].resolve(jsonResponse(403, { status: 'error', message: 'Invalid or missing CSRF token.' }));
    await flush();
    expect(row.error.textContent).toMatch(/security check failed\. Reload the page/);
    expect(row.quickFieldset.disabled).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('allows one request per row and one lifecycle per page', async () => {
    const { doc, views: [first, second], calls, controllers } = setup([{ id: 7 }, { id: 8 }]);
    first.pick('2026-10-13');
    first.pick('2026-10-13');
    first.choose('2026-10-20');
    expect(calls).toHaveLength(1);

    second.choose('2026-10-21');
    expect(calls).toHaveLength(1);
    expect(second.error.textContent).toMatch(/still being saved/);
    expect(second.dateInput.value).toBe('2026-10-21');
    expect(controllers[1].getState().phase).toBe('idle');
    expect(getDashboardMutationGate(doc).busy).toBe(true);

    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();
    expect(getDashboardMutationGate(doc).busy).toBe(false);
    second.choose('2026-10-21');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('/releases/8/schedule');
  });

  it('holds the page gate until the downstream callback settles', async () => {
    let finishRefresh;
    const { doc, views: [first, second], calls } = setup([{ id: 7 }, { id: 8 }], {
      onScheduleConfirmed: () => new Promise((resolve) => { finishRefresh = resolve; }),
    });
    first.pick('2026-10-13');
    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();

    expect(getDashboardMutationGate(doc).busy).toBe(true);
    first.undo();
    second.pick('2026-10-13');
    expect(calls).toHaveLength(1);

    finishRefresh();
    await flush();
    expect(getDashboardMutationGate(doc).busy).toBe(false);
    first.undo();
    expect(calls).toHaveLength(2);
  });

  it('keeps writes paused while the gate is held for recovery, then accepts them once released', async () => {
    const { doc, views: [first, second], calls, announced, controllers } = setup([{ id: 7 }, { id: 8 }]);
    first.pick('2026-10-13');
    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();

    const gate = getDashboardMutationGate(doc);
    const release = gate.hold();
    expect(gate.held).toBe(true);
    expect(gate.busy).toBe(true);
    expect(gate.acquire()).toBeNull();

    second.choose('2026-10-21');
    first.undo();
    expect(calls).toHaveLength(1);
    expect(second.error.textContent).toMatch(/Scheduling is paused until the dashboard is up to date/);
    expect(second.dateInput.value).toBe('2026-10-21');
    expect(announced.at(-1).message).toMatch(/Scheduling is paused/);
    expect(controllers[0].getState().phase).toBe('scheduled');
    expect(first.undoButton().getAttribute('aria-disabled')).toBeNull();

    release();
    release();
    expect(gate.held).toBe(false);
    second.choose('2026-10-21');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('/releases/8/schedule');
  });

  it('withdraws only paused errors once the last recovery hold is released', async () => {
    const { doc, views: [first, second, third], calls, controllers } = setup([{ id: 7 }, { id: 8 }, { id: 9 }]);
    first.pick('2026-10-13');
    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();
    third.submitCustom();
    expect(third.error.textContent).toBe('Choose a date first.');

    const gate = getDashboardMutationGate(doc);
    const releaseRecovery = gate.hold();
    const releaseOther = gate.hold();
    first.undo();
    second.choose('2026-10-21');
    expect(first.error.textContent).toMatch(/Scheduling is paused/);
    expect(second.error.textContent).toMatch(/Scheduling is paused/);

    // A hold that remains keeps the pause truthful.
    releaseOther();
    expect(first.error.textContent).toMatch(/Scheduling is paused/);
    expect(first.error.hasAttribute('hidden')).toBe(false);

    doc.activeElement = first.undoButton();
    releaseRecovery();
    for (const row of [first, second]) {
      expect(row.error.textContent).toBe('');
      expect(row.error.hasAttribute('hidden')).toBe(true);
    }
    expect(third.error.textContent).toBe('Choose a date first.');
    expect(third.dateInput.getAttribute('aria-invalid')).toBe('true');
    expect(doc.activeElement).toBe(first.undoButton());
    expect(second.dateInput.value).toBe('2026-10-21');
    expect(controllers[0].getState().phase).toBe('scheduled');
    expect(first.undoButton().getAttribute('aria-disabled')).toBeNull();

    first.undo();
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ plannedDate: null, expectedPlannedDate: '2026-10-13' });
  });

  it('commits a typed date only on Enter or when focus leaves, never on intermediate changes', () => {
    const { views: [row], calls } = setup();
    // Typing 15 into the day of a complete date reports the 1st first.
    row.dateInput.dispatch('keydown', { key: '1' });
    row.choose('2027-02-01');
    row.dateInput.dispatch('keydown', { key: '5' });
    row.choose('2027-02-15');
    expect(calls).toHaveLength(0);

    row.dateInput.dispatch('keydown', { key: 'Enter' });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.plannedDate).toBe('2027-02-15');
  });

  it('commits a typed date when focus leaves the field and ignores a blur without typing', () => {
    const { views: [first, second], calls } = setup([{ id: 7 }, { id: 8 }]);
    first.dateInput.dispatch('blur');
    expect(calls).toHaveLength(0);

    second.dateInput.dispatch('keydown', { key: '2' });
    second.choose('2026-12-02');
    second.dateInput.dispatch('keydown', { key: 'Tab' });
    expect(calls).toHaveLength(0);
    second.dateInput.dispatch('blur');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/releases/8/schedule', body: { plannedDate: '2026-12-02' } });
  });

  it('lets a pressed suggested date take precedence over an unsent typed date, once', () => {
    const { views: [row], calls } = setup();
    row.type('2027-02-15');
    row.press('2026-10-14');
    row.pick('2026-10-14');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/releases/7/schedule',
      body: { plannedDate: '2026-10-14', plannedTime: null, expectedPlannedDate: null, expectedPlannedTime: null },
    });
  });

  it('never sends another release’s typed draft when a suggested date is pressed', async () => {
    const { views: [first, second], calls } = setup([{ id: 7 }, { id: 8 }]);
    second.type('2027-02-15');
    first.press('2026-10-16');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/releases/7/schedule', body: { plannedDate: '2026-10-16' } });
    calls[0].resolve(success(7, NO_DATE, { plannedDate: '2026-10-16', plannedTime: null }));
    await flush();

    // The draft stays with its own release and still commits on a later blur.
    second.dateInput.focus();
    second.dateInput.dispatch('focus');
    second.dateInput.dispatch('blur');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ url: '/releases/8/schedule', body: { plannedDate: '2027-02-15' } });
  });

  it('commits the draft on ordinary blurs once a suggested-date press is abandoned', () => {
    const { views: [row], calls } = setup();
    row.type('2027-02-15');
    row.press('2026-10-14', { click: false });
    expect(calls).toHaveLength(0);

    row.dateInput.focus();
    row.dateInput.dispatch('focus');
    row.dateInput.dispatch('blur');
    expect(calls).toHaveLength(1);
    expect(calls[0].body.plannedDate).toBe('2027-02-15');
  });

  it('treats a non-primary press on a suggested date as an ordinary blur', () => {
    const { views: [row], calls } = setup();
    row.type('2027-02-15');
    row.press('2026-10-14', { button: 2, click: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.plannedDate).toBe('2027-02-15');
  });

  it('keeps a suggested-date press behind the mutation gate', () => {
    const { views: [first, second], calls } = setup([{ id: 7 }, { id: 8 }]);
    first.pick('2026-10-13');
    second.type('2027-02-15');
    second.press('2026-10-14');
    expect(calls).toHaveLength(1);
    expect(second.error.textContent).toBe('Another schedule change is still being saved. Try again when it finishes.');
  });

  it('explains an empty date on Enter without sending anything', () => {
    const { views: [row], calls } = setup();
    const event = row.dateInput.dispatch('keydown', { key: 'Enter' });
    expect(event.defaultPrevented).toBe(true);
    expect(calls).toHaveLength(0);
    expect(row.error.textContent).toBe('Choose a date first.');
  });

  it('announces rejected writes so the inline error is not silent', async () => {
    const { views: [row], calls, announced } = setup();
    row.choose('2026-10-20');
    calls[0].resolve(jsonResponse(422, { status: 'error', message: 'Published releases cannot be rescheduled here.', errors: {} }));
    await flush();
    expect(announced).toEqual([{ message: 'Published releases cannot be rescheduled here.', releaseId: 7 }]);
  });

  it('confirms a no-op response without offering a meaningless Undo', async () => {
    const { doc, views: [row], calls, confirmed } = setup([{ id: 7, expectedDate: '2026-10-13' }]);
    row.pick('2026-10-13');
    calls[0].resolve(success(7, OCT_13, OCT_13, false));
    await flush();
    expect(row.status.textContent).toBe(`✓ Already scheduled for ${OCT_13_LABEL}`);
    expect(row.undoButton()).toBeNull();
    expect(doc.activeElement?.getAttribute('tabindex')).toBe('-1');
    expect(confirmed[0]).toMatchObject({ action: 'schedule', changed: false, schedule: OCT_13 });
  });

  it('marks a network failure as unconfirmed and blocks further writes from the row', async () => {
    const { views: [row], calls, confirmed, reconciled, controllers, doc } = setup();
    row.pick('2026-10-13');
    calls[0].reject(new TypeError('Failed to fetch'));
    await flush();

    expect(reconciled).toEqual([{
      action: 'schedule', releaseId: 7, reason: 'unconfirmed', status: null,
      attempted: { plannedDate: '2026-10-13', plannedTime: null, expectedPlannedDate: null, expectedPlannedTime: null },
      currentSchedule: null,
    }]);
    expect(confirmed).toEqual([]);
    expect(row.error.textContent).toMatch(/couldn’t confirm whether this change was saved/);
    expect(row.quickFieldset.disabled).toBe(true);
    expect(controllers[0].getState().phase).toBe('locked');
    expect(getDashboardMutationGate(doc).busy).toBe(false);
    row.pick('2026-10-13');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a non-JSON body', { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }],
    ['another release', success(8, NO_DATE, OCT_13)],
    ['a different date', success(7, NO_DATE, { plannedDate: '2026-10-14', plannedTime: null })],
    ['a missing previous schedule', jsonResponse(200, { status: 'success', changed: true, release: { id: 7, schedule: OCT_13 } })],
    ['a server error', jsonResponse(500, { status: 'error' })],
  ])('treats %s as unconfirmed rather than success', async (_label, response) => {
    const { views: [row], calls, confirmed, reconciled } = setup();
    row.pick('2026-10-13');
    calls[0].resolve(response);
    await flush();
    expect(confirmed).toEqual([]);
    expect(reconciled[0].reason).toBe('unconfirmed');
    expect(row.undoButton()).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('swallows callback failures so no promise rejection escapes', async () => {
    const { views: [row], calls } = setup([{ id: 7 }], {
      onScheduleConfirmed: async () => { throw new Error('refresh failed'); },
    });
    row.pick('2026-10-13');
    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();
    expect(row.undoButton()).not.toBeNull();
  });

  it('binds each row once and enhances newly rendered rows', async () => {
    const { doc, views: [row], calls, options } = setup();
    const listeners = row.container.listenerCount();
    expect(enhanceDashboardReleaseScheduling(doc, options)).toEqual([]);
    expect(row.container.listenerCount()).toBe(listeners);
    row.pick('2026-10-13');
    expect(calls).toHaveLength(1);
    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();

    const replacement = renderRow(doc, { id: 9 });
    const controllers = enhanceDashboardReleaseScheduling(doc, options);
    expect(controllers.map((controller) => controller.releaseId)).toEqual([9]);
    expect(replacement.quickFieldset.disabled).toBe(false);
    replacement.pick('2026-10-16');
    expect(calls[1].url).toBe('/releases/9/schedule');
    expect(row.undoButton()).not.toBeNull();
  });

  it('releases a disposed row from the recovery gate once, leaving live rows subscribed', async () => {
    const { gate, live } = countingGate();
    const { doc, views: [first, second], calls, controllers, options } = setup([{ id: 7 }, { id: 8 }], { gate });
    expect(live.size).toBe(2);
    expect(enhanceDashboardReleaseScheduling(doc, options)).toEqual([]);
    expect(live.size).toBe(2);

    const release = gate.hold();
    first.pick('2026-10-13');
    second.choose('2026-10-21');
    expect(calls).toHaveLength(0);
    first.item.remove();
    controllers[0].dispose();
    controllers[0].dispose();
    expect(live.size).toBe(1);
    expect(second.error.textContent).toMatch(/Scheduling is paused/);

    release();
    expect(second.error.textContent).toBe('');
    expect(second.dateInput.value).toBe('2026-10-21');
    expect(first.error.textContent).toMatch(/Scheduling is paused/);
    expect(live.size).toBe(1);

    const replacement = renderRow(doc, { id: 9 });
    enhanceDashboardReleaseScheduling(doc, options);
    expect(live.size).toBe(2);
    replacement.pick('2026-10-16');
    expect(calls[0].url).toBe('/releases/9/schedule');
  });

  it('does not repaint a row detached while its request was pending', async () => {
    const { views: [row], calls, confirmed } = setup();
    row.pick('2026-10-13');
    row.item.remove();
    calls[0].resolve(success(7, NO_DATE, OCT_13));
    await flush();
    expect(row.undoButton()).toBeNull();
    expect(row.status.textContent).toBe('Scheduling…');
    expect(confirmed).toHaveLength(1);
  });

  it('offers only validation errors on idle rows for a refresh to keep', async () => {
    const { views: [local, server, rejected, busy], calls, controllers } = setup([{ id: 7 }, { id: 8 }, { id: 9 }, { id: 10 }]);
    local.dateInput.value = '';
    local.submitCustom();
    expect(controllers[0].retainableError()).toEqual({ message: 'Choose a date first.', invalidDate: true });

    server.choose('2026-10-20');
    calls[0].resolve(jsonResponse(422, { status: 'error', message: 'Published releases cannot be rescheduled here.' }));
    await flush();
    expect(controllers[1].retainableError()).toEqual({ message: 'Published releases cannot be rescheduled here.', invalidDate: true });

    rejected.pick('2026-10-13');
    calls[1].resolve(jsonResponse(403, { status: 'error' }));
    await flush();
    expect(rejected.error.textContent).toMatch(/security check failed/);
    expect(controllers[2].retainableError()).toBeNull();

    rejected.pick('2026-10-13');
    busy.pick('2026-10-13');
    expect(busy.error.textContent).toMatch(/still being saved/);
    expect(controllers[3].retainableError()).toBeNull();
    // A pending row is not idle, and its error was cleared by the request.
    expect(controllers[2].retainableError()).toBeNull();

    calls[2].reject(new TypeError('Failed to fetch'));
    await flush();
    expect(controllers[2].getState().phase).toBe('locked');
    expect(controllers[2].retainableError()).toBeNull();
  });

  it('never offers a pause error, and a newer error replaces an older validation error', () => {
    const { gate } = countingGate();
    const { views: [row], controllers } = setup([{ id: 7 }], { gate });
    row.dateInput.value = '';
    row.submitCustom();
    const release = gate.hold();
    row.pick('2026-10-13');
    expect(row.error.textContent).toMatch(/Scheduling is paused/);
    expect(row.dateInput.hasAttribute('aria-invalid')).toBe(false);
    expect(controllers[0].retainableError()).toBeNull();
    release();
    expect(row.error.textContent).toBe('');
  });

  it('restores a validation error onto a replacement row silently, keeping it until corrected', async () => {
    const { doc, views: [row], calls, announced, controllers, options } = setup();
    row.dateInput.value = '';
    row.submitCustom();
    const error = controllers[0].retainableError();
    const announcements = announced.length;

    row.item.remove();
    controllers[0].dispose();
    const replacement = renderRow(doc, { id: 7 });
    const [next] = enhanceDashboardReleaseScheduling(doc, options);
    next.restoreError(error);
    expect(replacement.error.textContent).toBe('Choose a date first.');
    expect(replacement.error.hasAttribute('hidden')).toBe(false);
    expect(replacement.error.getAttribute('id')).toBe('dashboard-schedule-error-7');
    expect(replacement.dateInput.getAttribute('aria-invalid')).toBe('true');
    expect(announced).toHaveLength(announcements);
    // A restored error is itself retainable through a further refresh.
    expect(next.retainableError()).toEqual(error);

    replacement.choose('2026-10-20');
    expect(calls).toHaveLength(1);
    expect(replacement.error.hasAttribute('hidden')).toBe(true);
    expect(replacement.dateInput.hasAttribute('aria-invalid')).toBe(false);
    expect(next.retainableError()).toBeNull();
    // A row no longer idle never takes an old error.
    next.restoreError(error);
    expect(replacement.error.textContent).toBe('');
  });
});

describe('normal app initialization', () => {
  it('registers the integrated scheduling enhancer beside Projects filtering', () => {
    const source = fs.readFileSync(new URL('../src/static/creatorcrate.js', import.meta.url), 'utf8');
    expect(source).toMatch(/enhanceDashboardProjectTable\(document\);\s*enhanceDashboardScheduling\(document\);/);
    // Only the integrated enhancer may bind rows, so recovery is always wired.
    expect(source).not.toMatch(/enhanceDashboardReleaseScheduling|enhanceDashboardScheduleRefresh|refreshDashboard/);
  });
});

describe('enhanceDashboardScheduleRefresh', () => {
  it('requires the reconcile and refresh-failure callbacks', () => {
    const doc = createDocument();
    expect(() => enhanceDashboardScheduleRefresh(doc, { onReconcileRequired() {} })).toThrow(TypeError);
    expect(() => enhanceDashboardScheduleRefresh(doc, { onRefreshFailed() {} })).toThrow(TypeError);
  });

  it('reports a missing dashboard as unavailable instead of refreshing', async () => {
    const doc = createDocument();
    expect(enhanceDashboardScheduleRefresh(doc, { onReconcileRequired() {}, onRefreshFailed() {} })).toBeNull();
    await expect(refreshDashboard(doc)).resolves.toEqual({ status: 'failed', reason: 'unavailable', replaced: false, error: null });
  });
});
