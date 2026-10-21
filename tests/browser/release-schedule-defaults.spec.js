import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createReleaseRepository } from '../../src/data/release-repository.js';

// Auckland is UTC+13 in December, so 10:30Z is 23:30 local on New Year's Eve:
// the +1 hour default must roll the browser-local date into the next year.
test.use({ timezoneId: 'Pacific/Auckland' });
const NEW_YEARS_EVE_2330_LOCAL = new Date('2026-12-31T10:30:00Z');
const HOUR_MS = 60 * 60 * 1000;

async function withReleaseApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-schedule-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ app, db, origin: `http://127.0.0.1:${server.address().port}` });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function scheduleControls(form) {
  return {
    checkbox: form.locator('input[name="noSetReleaseDate"]'),
    date: form.locator('input[name="plannedDate"]'),
    time: form.locator('input[name="plannedTime"]'),
    dateTrigger: form.locator('.date-picker-trigger'),
    timeTrigger: form.locator('[data-time-picker-trigger]'),
    datePanel: form.locator('[data-date-picker-panel]'),
    timePanel: form.locator('[data-time-picker-panel]'),
  };
}

async function expectSchedule(controls, plannedDate, plannedTime, { disabled = false } = {}) {
  await expect(controls.date).toHaveValue(plannedDate);
  await expect(controls.time).toHaveValue(plannedTime);
  for (const control of [controls.date, controls.time, controls.dateTrigger, controls.timeTrigger]) {
    if (disabled) await expect(control).toBeDisabled();
    else await expect(control).toBeEnabled();
  }
}

// The hidden retained-draft fields: null when no draft is held (disabled and
// empty, so nothing is submitted), otherwise the exact retained values.
async function expectRetainedDraft(form, draft) {
  const fields = await form.locator('input[type="hidden"][data-release-schedule-retained]')
    .evaluateAll((inputs) => inputs.map((input) => ({ name: input.name, value: input.value, disabled: input.disabled })));
  expect(fields).toEqual(draft
    ? [
      { name: 'retainedPlannedDate', value: draft.plannedDate, disabled: false },
      { name: 'retainedPlannedTime', value: draft.plannedTime, disabled: false },
    ]
    : [
      { name: 'retainedPlannedDate', value: '', disabled: true },
      { name: 'retainedPlannedTime', value: '', disabled: true },
    ]);
}

// Counts every form reset from page load, so a stale close event that fires
// during initialization is observed too.
async function countFormResets(page) {
  await page.addInitScript(() => {
    window.__formResets = [];
    window.addEventListener('reset', (event) => window.__formResets.push(event.target.id), true);
  });
}

const formResets = (page, formId) => page.evaluate(
  (id) => window.__formResets.filter((target) => target === id).length,
  formId,
);

// Lets any queued native close event run before asserting.
const settleTasks = (page) => page.evaluate(() => new Promise((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => resolve();
  channel.port2.postMessage(null);
}));

async function expectDialogOpenState(dialog, open) {
  await expect.poll(() => dialog.evaluate((element) => ({
    native: element.open,
    internal: element.__creatorCrateAppDialogState.open,
  }))).toEqual({ native: open, internal: open });
}

async function chooseProject(form, projectId) {
  const dropdown = form.locator('#release-create-project');
  if (!await dropdown.evaluate((element) => element.open)) await dropdown.locator('summary').click();
  await form.locator(`input[name="projectId"][value="${projectId}"]`).click({ force: true });
}

test('New Release dialog uses browser-local defaults, toggles undated schedules, and resets on close', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.clock.install({ time: NEW_YEARS_EVE_2330_LOCAL });

  await withReleaseApp(async ({ app, origin }) => {
    app.locals.projectService.create({ title: 'Schedule project' });
    await page.goto(`${origin}/releases`);
    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');
    const controls = scheduleControls(form);
    const openDialog = () => page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    const closeDialog = () => dialog.locator('[data-dialog-close]').first().click();

    await expect(form).toHaveAttribute('data-release-schedule-defaults', 'fresh');
    await expect(controls.checkbox).not.toBeChecked();
    await expectSchedule(controls, '2027-01-01', '00:30');

    // A page left idle must not offer the defaults computed at load time.
    await page.clock.setSystemTime(new Date(NEW_YEARS_EVE_2330_LOCAL.getTime() + 2 * HOUR_MS));
    await openDialog();
    await expect(dialog).toHaveAttribute('open', '');
    await expectSchedule(controls, '2027-01-01', '02:30');

    await controls.date.fill('2027-02-14');
    await controls.time.fill('18:45');

    // Keyboard toggle closes the open custom picker and disables every control.
    await controls.timeTrigger.click();
    await expect(controls.timePanel).toBeVisible();
    await controls.checkbox.focus();
    await page.keyboard.press('Space');
    await expect(controls.checkbox).toBeChecked();
    await expect(controls.timePanel).toBeHidden();
    await expect(controls.timeTrigger).toHaveAttribute('aria-expanded', 'false');
    await expectSchedule(controls, '', '', { disabled: true });
    await expectRetainedDraft(form, { plannedDate: '2027-02-14', plannedTime: '18:45' });
    await expect(controls.checkbox).toBeFocused();

    await page.keyboard.press('Space');
    await expect(controls.checkbox).not.toBeChecked();
    await expectSchedule(controls, '2027-02-14', '18:45');
    await expectRetainedDraft(form, null);

    // The date picker closes the same way.
    await controls.dateTrigger.click();
    await expect(controls.datePanel).toBeVisible();
    await controls.checkbox.focus();
    await page.keyboard.press('Space');
    await expect(controls.datePanel).toBeHidden();
    await expectSchedule(controls, '', '', { disabled: true });
    await expectRetainedDraft(form, { plannedDate: '2027-02-14', plannedTime: '18:45' });
    await controls.dateTrigger.click({ force: true });
    await expect(controls.datePanel).toBeHidden();

    // Closing discards the checked state and retained draft.
    await closeDialog();
    await expect(dialog).not.toHaveAttribute('open', '');
    await page.clock.setSystemTime(new Date(NEW_YEARS_EVE_2330_LOCAL.getTime() + 5 * HOUR_MS));
    await openDialog();
    await expect(controls.checkbox).not.toBeChecked();
    await expectSchedule(controls, '2027-01-01', '05:30');
    await expectRetainedDraft(form, null);
    // The discarded draft cannot come back through the checkbox either.
    await controls.checkbox.check();
    await expectRetainedDraft(form, { plannedDate: '2027-01-01', plannedTime: '05:30' });
    await controls.checkbox.uncheck();
    await expectSchedule(controls, '2027-01-01', '05:30');

    // Edited-but-unchecked drafts are also cleared on reopen.
    await controls.date.fill('2027-04-01');
    await closeDialog();
    await openDialog();
    await expectSchedule(controls, '2027-01-01', '05:30');
    expect(pageErrors).toEqual([]);
  });
});

test('validation rerenders keep checkbox state, retained drafts, blanks, explicit schedules, and project context', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.clock.install({ time: NEW_YEARS_EVE_2330_LOCAL });

  await withReleaseApp(async ({ app, origin }) => {
    app.locals.projectService.create({ title: 'Other project' });
    const project = app.locals.projectService.create({ title: 'Rerender project' });
    await page.goto(`${origin}/releases/new?projectId=${project.id}`);
    const form = page.locator('#release-form');
    const controls = scheduleControls(form);
    const submit = () => page.getByRole('button', { name: 'Create', exact: true }).click();
    const selectedProject = form.locator('input[name="projectId"][type="radio"]:checked');

    const checkedRoundTrip = async () => {
      await submit();
      await expect(page.locator('#title-error')).toBeVisible();
      await expect(form).toHaveAttribute('data-release-schedule-defaults', 'keep');
      await expect(selectedProject).toHaveValue(String(project.id));
      await expect(controls.checkbox).toBeChecked();
      await expectSchedule(controls, '', '', { disabled: true });
    };

    await expect(form).toHaveAttribute('data-release-schedule-defaults', 'fresh');
    await expectSchedule(controls, '2027-01-01', '00:30');
    await controls.date.fill('2027-02-14');
    await controls.time.fill('18:45');
    await controls.checkbox.check();
    await checkedRoundTrip();
    await expectRetainedDraft(form, { plannedDate: '2027-02-14', plannedTime: '18:45' });
    // Idle time on the rerender never swaps in generated defaults.
    await page.clock.setSystemTime(new Date(NEW_YEARS_EVE_2330_LOCAL.getTime() + 2 * HOUR_MS));
    // The checked rerender restores the retained draft exactly on uncheck.
    await controls.checkbox.uncheck();
    await expectSchedule(controls, '2027-02-14', '18:45');
    await expectRetainedDraft(form, null);

    // Repeated toggles and a second checked round trip keep the same draft.
    await controls.checkbox.check();
    await controls.checkbox.uncheck();
    await expectSchedule(controls, '2027-02-14', '18:45');
    await controls.checkbox.check();
    await checkedRoundTrip();
    await controls.checkbox.uncheck();
    await expectSchedule(controls, '2027-02-14', '18:45');

    // Intentionally blank and partial schedules come back as they were.
    await controls.date.fill('');
    await controls.time.fill('');
    await controls.checkbox.check();
    await checkedRoundTrip();
    await expectRetainedDraft(form, { plannedDate: '', plannedTime: '' });
    await controls.checkbox.uncheck();
    await expectSchedule(controls, '', '');

    await controls.date.fill('2027-05-05');
    await controls.checkbox.check();
    await checkedRoundTrip();
    await controls.checkbox.uncheck();
    await expectSchedule(controls, '2027-05-05', '');

    await controls.date.fill('2027-03-03');
    await controls.time.fill('10:15');
    await submit();
    await expect(page.locator('#title-error')).toBeVisible();
    await expect(controls.checkbox).not.toBeChecked();
    await expect(selectedProject).toHaveValue(String(project.id));
    await expectSchedule(controls, '2027-03-03', '10:15');

    // A long idle on a rerendered page never replaces the submitted draft.
    await page.clock.setSystemTime(new Date(NEW_YEARS_EVE_2330_LOCAL.getTime() + 3 * HOUR_MS));
    await controls.date.fill('');
    await controls.time.fill('');
    await submit();
    await expect(page.locator('#title-error')).toBeVisible();
    await expectSchedule(controls, '', '');
    expect(pageErrors).toEqual([]);
  });
});

test('server-opened New Release dialog rerender keeps the checked draft', async ({ page }) => {
  // appDialogOpen() re-shows an [open] dialog as modal; the close event that
  // queues must not finish the lifecycle and reset the rerendered form.
  test.setTimeout(60_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await countFormResets(page);
  await page.clock.install({ time: NEW_YEARS_EVE_2330_LOCAL });

  await withReleaseApp(async ({ app, origin }) => {
    app.locals.projectService.create({ title: 'Other project' });
    const project = app.locals.projectService.create({ title: 'Dialog rerender project' });
    await page.goto(`${origin}/releases`);
    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');
    const controls = scheduleControls(form);
    const selectedProject = page.locator('#release-create-dialog input[name="projectId"]:checked');
    const submit = () => dialog.locator('[data-dialog-submit]').click();
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    await chooseProject(form, project.id);
    await controls.date.fill('2027-02-14');
    await controls.time.fill('18:45');
    await controls.checkbox.check();
    await submit();

    await expect(page.locator('#title-error')).toBeVisible();
    await settleTasks(page);
    await expect(dialog).toHaveAttribute('open', '');
    await expectDialogOpenState(dialog, true);
    expect(await formResets(page, 'release-create-form')).toBe(0);
    await expect(controls.checkbox).toHaveJSProperty('defaultChecked', true);
    await expect(controls.checkbox).toBeChecked({ timeout: 3_000 });
    await expectSchedule(controls, '', '', { disabled: true });
    await expectRetainedDraft(form, { plannedDate: '2027-02-14', plannedTime: '18:45' });
    await expect(selectedProject).toHaveValue(String(project.id));

    // Unchecking restores the retained draft rather than fresh defaults.
    await controls.checkbox.uncheck();
    await expectSchedule(controls, '2027-02-14', '18:45');
    await expectRetainedDraft(form, null);

    // Explicit schedule values survive a server-opened rerender as submitted.
    await controls.date.fill('2027-03-03');
    await controls.time.fill('10:15');
    await submit();
    await expect(page.locator('#title-error')).toBeVisible();
    await settleTasks(page);
    await expectDialogOpenState(dialog, true);
    expect(await formResets(page, 'release-create-form')).toBe(0);
    await expect(controls.checkbox).not.toBeChecked();
    await expectSchedule(controls, '2027-03-03', '10:15');
    await expect(selectedProject).toHaveValue(String(project.id));

    // Intentionally blank schedules stay blank.
    await controls.date.fill('');
    await controls.time.fill('');
    await submit();
    await expect(page.locator('#title-error')).toBeVisible();
    await settleTasks(page);
    await expectDialogOpenState(dialog, true);
    expect(await formResets(page, 'release-create-form')).toBe(0);
    await expectSchedule(controls, '', '');
    await expect(selectedProject).toHaveValue(String(project.id));

    // Closing the rerendered dialog is still an accepted dismissal: it follows
    // the return location and the next open starts from a fresh draft.
    await dialog.locator('[data-dialog-close]').first().click();
    await expect(page).toHaveURL(`${origin}/releases`);
    await expectDialogOpenState(dialog, false);
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    await expectDialogOpenState(dialog, true);
    await expect(controls.checkbox).not.toBeChecked();
    await expect(controls.date).toBeEnabled();
    await expect(controls.date).toHaveValue('2027-01-01');
    await expect(controls.time).toHaveValue(/^00:\d\d$/);
    await expectRetainedDraft(form, null);
    expect(pageErrors).toEqual([]);
  });
});

test('selected-assets New Release dialog rerender keeps its handoff context and draft', async ({ page }) => {
  test.setTimeout(60_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await countFormResets(page);
  await page.clock.install({ time: NEW_YEARS_EVE_2330_LOCAL });

  await withReleaseApp(async ({ app, db, origin }) => {
    const project = app.locals.projectService.create({ title: 'Handoff project' });
    const insertAsset = db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at)
      VALUES (?, ?, ?, 'png', 'image/png', 1, 1, datetime('now')) RETURNING id
    `);
    const assetIds = ['handoff-a.png', 'handoff-b.png'].map((name) => insertAsset.get(project.id, name, name).id);
    await page.goto(`${origin}/releases`);
    await page.evaluate(({ projectId, ids }) => {
      const handoff = document.createElement('form');
      handoff.method = 'post';
      handoff.action = `/releases?new=assets&projectId=${projectId}`;
      const fields = [
        ['_csrf', document.querySelector('#release-create-form input[name="_csrf"]').value],
        ...ids.map((id) => ['selectedAssetIds', String(id)]),
      ];
      fields.forEach(([name, value]) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        handoff.append(input);
      });
      document.body.append(handoff);
      handoff.submit();
    }, { projectId: project.id, ids: assetIds });

    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');
    const controls = scheduleControls(form);
    const selectedAssetIds = () => form.locator('input[name="selectedAssetIds"]')
      .evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
    await expect(form.locator('input[name="releaseCreateFlow"]')).toHaveValue('selected-assets');
    await settleTasks(page);
    await expectDialogOpenState(dialog, true);
    expect(await formResets(page, 'release-create-form')).toBe(0);
    await expect(form.locator('#title')).toHaveValue('Handoff project');
    expect(await selectedAssetIds()).toEqual(assetIds);

    await form.locator('#title').fill('');
    await controls.date.fill('2027-02-14');
    await controls.time.fill('');
    await controls.checkbox.check();
    await dialog.locator('[data-dialog-submit]').click();
    await expect(page.locator('#title-error')).toBeVisible();
    await settleTasks(page);
    await expectDialogOpenState(dialog, true);
    expect(await formResets(page, 'release-create-form')).toBe(0);
    await expect(form.locator('input[name="releaseCreateFlow"]')).toHaveValue('selected-assets');
    expect(await selectedAssetIds()).toEqual(assetIds);
    await expect(form.locator('input[name="projectId"]:checked')).toHaveValue(String(project.id));
    await expect(controls.checkbox).toBeChecked();
    await expectSchedule(controls, '', '', { disabled: true });
    await expectRetainedDraft(form, { plannedDate: '2027-02-14', plannedTime: '' });
    await controls.checkbox.uncheck();
    await expectSchedule(controls, '2027-02-14', '');

    // A valid checked submission still creates an undated release.
    await controls.checkbox.check();
    await form.locator('#title').fill('Undated handoff');
    await dialog.locator('[data-dialog-submit]').click();
    await expect(page).toHaveURL(/\/releases\/\d+\/assets$/);
    const createdId = Number(new URL(page.url()).pathname.split('/')[2]);
    expect(createReleaseRepository(db).findById(createdId)).toMatchObject({ planned_date: null, planned_time: null });
    expect(pageErrors).toEqual([]);
  });
});

test('New Release dismissals reset once, rejected closes keep drafts, and rapid reopen drops stale closes', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await countFormResets(page);
  await page.clock.install({ time: NEW_YEARS_EVE_2330_LOCAL });

  await withReleaseApp(async ({ app, origin }) => {
    app.locals.projectService.create({ title: 'Dismissal project' });
    await page.goto(`${origin}/releases`);
    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');
    const controls = scheduleControls(form);
    const title = form.locator('#title');
    const opener = page.locator('[data-dialog-open="release-create-dialog"]').first();
    const closeButton = dialog.locator('[data-dialog-close]').first();
    const resets = () => formResets(page, 'release-create-form');
    const enterDraft = async () => {
      await title.fill('Abandoned draft');
      await controls.checkbox.check();
      await expectSchedule(controls, '', '', { disabled: true });
    };
    const expectFreshDraft = async () => {
      await expect(title).toHaveValue('');
      await expect(controls.checkbox).not.toBeChecked();
      // Fresh browser-local defaults; the faked clock keeps running.
      await expect(controls.date).toHaveValue('2027-01-01');
      await expect(controls.time).toHaveValue(/^00:\d\d$/);
      await expect(controls.date).toBeEnabled();
    };
    await settleTasks(page);
    expect(await resets()).toBe(0);

    const dismissals = [
      ['button', () => closeButton.click()],
      ['backdrop', () => page.mouse.click(4, 4)],
      ['Escape', () => page.keyboard.press('Escape')],
    ];
    let expectedResets = 0;
    for (const [label, dismiss] of dismissals) {
      await opener.click();
      await expectDialogOpenState(dialog, true);
      await enterDraft();
      await title.focus();
      await dismiss();
      await expectDialogOpenState(dialog, false);
      await settleTasks(page);
      expectedResets += 1;
      expect(await resets(), `${label} dismissal`).toBe(expectedResets);
      await opener.click();
      await expectFreshDraft();
      await settleTasks(page);
      expect(await resets(), `${label} reopen`).toBe(expectedResets);
      await closeButton.click();
      await expectDialogOpenState(dialog, false);
      await settleTasks(page);
      expectedResets += 1;
    }
    expect(await resets()).toBe(expectedResets);

    // A rejected close keeps the dialog and its draft.
    await opener.click();
    await enterDraft();
    await dialog.evaluate((element) => { element.__creatorCrateAppDialogState.beforeClose = () => false; });
    await closeButton.click();
    await title.focus();
    await page.keyboard.press('Escape');
    await settleTasks(page);
    await expectDialogOpenState(dialog, true);
    expect(await resets()).toBe(expectedResets);
    await expect(title).toHaveValue('Abandoned draft');
    await expect(controls.checkbox).toBeChecked();
    await dialog.evaluate((element) => { element.__creatorCrateAppDialogState.beforeClose = null; });

    // Close and reopen before the native close event is delivered: the closed
    // lifecycle resets once, and its late event neither resets the new draft
    // nor finalizes or steals focus from the reopened dialog.
    const result = await page.evaluate(async () => {
      const dialogElement = document.getElementById('release-create-dialog');
      const formElement = document.getElementById('release-create-form');
      const titleInput = formElement.querySelector('#title');
      const dateInput = formElement.querySelector('input[name="plannedDate"]');
      const resetsBefore = window.__formResets.length;
      dialogElement.querySelector('[data-dialog-close]').click();
      const closedNatively = !dialogElement.open;
      document.querySelector('[data-dialog-open="release-create-dialog"]').click();
      const resetsOnReopen = window.__formResets.length - resetsBefore;
      // Let the reset's settle microtasks run, then type before the stale
      // close event (a task) is delivered.
      await Promise.resolve();
      await Promise.resolve();
      const abandonedTitle = titleInput.value;
      const abandonedChecked = formElement.querySelector('input[name="noSetReleaseDate"]').checked;
      titleInput.value = 'Reopened draft';
      dateInput.value = '2027-07-07';
      dateInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
      return {
        closedNatively,
        resetsOnReopen,
        resetsAfterStaleClose: window.__formResets.length - resetsBefore,
        abandonedTitle,
        abandonedChecked,
        nativeOpen: dialogElement.open,
        internalOpen: dialogElement.__creatorCrateAppDialogState.open,
        focusInDialog: dialogElement.contains(document.activeElement),
      };
    });
    expect(result).toEqual({
      closedNatively: true,
      resetsOnReopen: 1,
      resetsAfterStaleClose: 1,
      abandonedTitle: '',
      abandonedChecked: false,
      nativeOpen: true,
      internalOpen: true,
      focusInDialog: true,
    });
    expectedResets += 1;
    await expect(title).toHaveValue('Reopened draft');
    await expect(controls.date).toHaveValue('2027-07-07');
    await expect(controls.date).toBeEnabled();

    await closeButton.click();
    await expectDialogOpenState(dialog, false);
    await settleTasks(page);
    expect(await resets()).toBe(expectedResets + 1);
    expect(pageErrors).toEqual([]);
  });
});

test('standalone New Release supports 12h display with canonical values; Edit Release is untouched', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // 12:30 local -> 13:30 default, displayed as 1:30 PM.
  await page.clock.install({ time: new Date('2026-12-30T23:30:00Z') });

  await withReleaseApp(async ({ app, db, origin }) => {
    app.locals.clockFormatSettingsService.setClockFormat('12h');
    const project = app.locals.projectService.create({ title: 'Twelve hour project' });
    const releases = createReleaseRepository(db);
    const existing = releases.create({
      projectId: project.id, title: 'Existing', description: '', notes: '', plannedDate: '2026-05-05', plannedTime: '08:00',
    });

    await page.goto(`${origin}/releases/new?projectId=${project.id}`);
    const form = page.locator('#release-form');
    const controls = scheduleControls(form);
    await expect(form.locator('[data-time-picker-field]')).toHaveAttribute('data-clock-format', '12h');
    await expectSchedule(controls, '2026-12-31', '13:30');
    await controls.timeTrigger.click();
    await expect(controls.timePanel.locator('.date-picker-month-title')).toHaveText('1:30 PM');
    await controls.timePanel.locator('[data-time-period="AM"]').click();
    await expect(controls.time).toHaveValue('01:30');

    await controls.checkbox.focus();
    await page.keyboard.press('Space');
    await expect(controls.timePanel).toBeHidden();
    await expectSchedule(controls, '', '', { disabled: true });
    await page.keyboard.press('Space');
    await expectSchedule(controls, '2026-12-31', '01:30');
    await page.keyboard.press('Space');

    await form.locator('#title').fill('Undated standalone');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/releases\/\d+$/);
    const createdId = Number(new URL(page.url()).pathname.split('/')[2]);
    expect(releases.findById(createdId)).toMatchObject({ planned_date: null, planned_time: null });

    // Explicit prefills are kept as rendered.
    await page.goto(`${origin}/releases/new?projectId=${project.id}&plannedDate=2027-06-01&plannedTime=07:05`);
    await expect(form).toHaveAttribute('data-release-schedule-defaults', 'keep');
    await expectSchedule(controls, '2027-06-01', '07:05');

    // Explicitly blank prefills are intentional values, never defaulted.
    for (const [query, plannedDate, plannedTime] of [
      ['plannedDate=2027-02-14&plannedTime=', '2027-02-14', ''],
      ['plannedDate=&plannedTime=18:45', '', '18:45'],
      ['plannedDate=&plannedTime=', '', ''],
    ]) {
      await page.goto(`${origin}/releases/new?projectId=${project.id}&${query}`);
      await expect(form).toHaveAttribute('data-release-schedule-defaults', 'keep');
      await expectSchedule(controls, plannedDate, plannedTime);
    }

    await page.goto(`${origin}/releases/${existing.id}`);
    await page.locator(`[data-release-edit-id="${existing.id}"]`).first().click();
    const editForm = page.locator('#release-edit-form');
    await expect(editForm.locator('input[name="noSetReleaseDate"]')).toHaveCount(0);
    await expect(editForm.locator('input[name="plannedDate"]')).toHaveValue('2026-05-05');
    await expect(editForm.locator('input[name="plannedTime"]')).toHaveValue('08:00');
    await expect(editForm.locator('input[name="plannedDate"]')).toBeEnabled();
    // Edit Release still discards an abandoned draft on close.
    await editForm.locator('input[name="plannedDate"]').fill('2026-09-09');
    await page.locator('#release-edit-dialog [data-dialog-close]').first().click();
    await expect(page.locator('#release-edit-dialog')).not.toHaveAttribute('open', '');
    await page.locator(`[data-release-edit-id="${existing.id}"]`).first().click();
    await expect(editForm.locator('input[name="plannedDate"]')).toHaveValue('2026-05-05');
    expect(pageErrors).toEqual([]);
  });
});
