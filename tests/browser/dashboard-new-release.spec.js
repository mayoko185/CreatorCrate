import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

async function withDashboardApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-new-release-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
    const signature = app.locals.releaseSignatureSettingsService
      .add({ name: 'Dashboard Signature', body: 'Signed from the Dashboard' }).entries[0];
    const projects = app.locals.projectService;
    projects.create({ title: 'First Dashboard Project' });
    const target = projects.create({ title: 'Second Dashboard Project' });
    const undated = Number(db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at)
      VALUES (?, 'Waiting For A Date', '', '', NULL, NULL, NULL, NULL, NULL)
    `).run(target.id).lastInsertRowid);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ db, origin: `http://127.0.0.1:${server.address().port}`, projectId: target.id, signature, undated });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const SCHEDULE_BOUND = '[data-dashboard-schedule][data-dashboard-schedule-bound="true"]';

async function openDashboard(page, origin) {
  await page.goto(`${origin}/`);
  await page.locator(SCHEDULE_BOUND).first().waitFor({ state: 'attached' });
}

async function expectDialogOpenState(dialog, open) {
  await expect.poll(() => dialog.evaluate((element) => ({
    native: element.open,
    internal: element.__creatorCrateAppDialogState.open,
  }))).toEqual({ native: open, internal: open });
}

async function chooseInDropdown(form, dropdownId, selector) {
  const dropdown = form.locator(`#${dropdownId}`);
  if (!await dropdown.evaluate((element) => element.open)) await dropdown.locator('summary').click();
  await form.locator(selector).click({ force: true });
}

function duplicateIds(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const duplicates = new Set();
    for (const { id } of document.querySelectorAll('[id]')) (seen.has(id) ? duplicates : seen).add(id);
    return [...duplicates];
  });
}

// Every label/ARIA/picker reference inside the creation dialogs must resolve.
function unresolvedDialogReferences(page) {
  return page.evaluate(() => {
    const attributes = ['for', 'aria-describedby', 'aria-controls', 'aria-labelledby', 'data-date-picker-for', 'data-time-picker-for'];
    const missing = [];
    for (const dialog of document.querySelectorAll('#release-create-dialog, #project-create-dialog')) {
      for (const element of dialog.querySelectorAll('*')) {
        for (const attribute of attributes) {
          for (const id of (element.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
            if (!document.getElementById(id)) missing.push(`${attribute}=${id}`);
          }
        }
      }
    }
    return missing;
  });
}

function dialogCounts(page) {
  return page.evaluate(() => ({
    release: document.querySelectorAll('#release-create-dialog').length,
    project: document.querySelectorAll('#project-create-dialog').length,
    signatures: document.querySelectorAll('#release-signatures-dialog').length,
  }));
}

function refreshNow(page) {
  return page.evaluate(async () => {
    const { refreshDashboard } = await import('/client/dashboard.js');
    return refreshDashboard(document);
  });
}

test('Dashboard New Release opens the established dialog, rerenders validation in place, and creates one release', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withDashboardApp(async ({ db, origin, projectId, signature }) => {
    await openDashboard(page, origin);
    let navigations = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');
    const projectDialog = page.locator('#project-create-dialog');
    const newRelease = page.locator('.page-heading [data-dialog-open="release-create-dialog"]');

    await expect(newRelease).toHaveText('New Release');
    await newRelease.click();
    await expectDialogOpenState(dialog, true);
    await expectDialogOpenState(projectDialog, false);
    expect(navigations).toBe(0);
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(dialog.locator('h2')).toHaveText('New Release');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await unresolvedDialogReferences(page)).toEqual([]);

    // Project selection through the established searchable dropdown.
    await chooseInDropdown(form, 'release-create-project', `input[name="projectId"][value="${projectId}"]`);
    await expect(form.locator('#release-create-project summary')).toContainText('Second Dashboard Project');

    // Scheduling: fresh browser defaults, both custom pickers, and No set release date.
    const date = form.locator('input[name="plannedDate"]');
    const time = form.locator('input[name="plannedTime"]');
    const noDate = form.getByLabel('No set release date');
    await expect(form).toHaveAttribute('data-release-schedule-defaults', 'fresh');
    await expect(date).not.toHaveValue('');
    await expect(time).not.toHaveValue('');
    await form.getByRole('button', { name: 'Open calendar for scheduled date' }).click();
    await expect(form.locator('[data-date-picker-panel]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(form.locator('[data-date-picker-panel]')).toBeHidden();
    await expectDialogOpenState(dialog, true);
    await form.getByRole('button', { name: 'Open time picker for scheduled time' }).click();
    await expect(form.locator('[data-time-picker-panel]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(form.locator('[data-time-picker-panel]')).toBeHidden();
    await expectDialogOpenState(dialog, true);
    await form.getByLabel('Scheduled date', { exact: true }).fill('2027-03-04');
    await form.getByLabel('Scheduled time', { exact: true }).fill('08:15');
    await noDate.check();
    await expect(date).toBeDisabled();
    await expect(time).toBeDisabled();
    await noDate.uncheck();
    await expect(date).toHaveValue('2027-03-04');
    await expect(time).toHaveValue('08:15');
    await noDate.check();

    // Platforms and signatures.
    await chooseInDropdown(form, 'release-platforms', 'input[name="selectedPlatforms"][value="bluesky"]');
    await expect(form.locator('input[name="selectedPlatforms"][value="bluesky"]')).toBeChecked();
    await chooseInDropdown(form, 'release-description-signature', `[data-release-signature-field] input[type="radio"][value="${signature.id}"]`);
    await expect(form.locator('textarea[name="description"]')).toHaveValue('Signed from the Dashboard');
    await form.getByLabel('Notes').fill('Dashboard draft notes');
    const signaturesDialog = page.locator('#release-signatures-dialog');
    await form.getByRole('button', { name: 'Manage signatures' }).click();
    await expectDialogOpenState(signaturesDialog, true);
    await signaturesDialog.locator('[data-dialog-close]').first().click();
    await expectDialogOpenState(signaturesDialog, false);
    await expectDialogOpenState(dialog, true);

    // Missing title: the Dashboard comes back with only this dialog open.
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/releases'),
      dialog.getByRole('button', { name: 'Create release' }).click(),
    ]);
    await page.locator(SCHEDULE_BOUND).first().waitFor({ state: 'attached' });
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expectDialogOpenState(dialog, true);
    await expectDialogOpenState(projectDialog, false);
    await expect(page.locator('#release-create-field-title-error')).toBeVisible();
    await expect(form.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByLabel('Title')).toHaveAttribute('aria-describedby', 'release-create-field-title-error');
    await expect(form.locator(`input[name="projectId"][value="${projectId}"]`)).toBeChecked();
    await expect(form.locator('input[name="selectedPlatforms"][value="bluesky"]')).toBeChecked();
    await expect(form.locator('textarea[name="description"]')).toHaveValue('Signed from the Dashboard');
    await expect(form.getByLabel('Notes')).toHaveValue('Dashboard draft notes');
    await expect(noDate).toBeChecked();
    await expect(form.locator('input[name="returnTo"]')).toHaveValue('/');
    await noDate.uncheck();
    await expect(date).toHaveValue('2027-03-04');
    await expect(time).toHaveValue('08:15');
    expect(db.prepare('SELECT COUNT(*) AS count FROM releases').get().count).toBe(1);
    expect(await duplicateIds(page)).toEqual([]);

    // Corrected input creates exactly one release and opens its detail page.
    await form.getByLabel('Title').fill('Created From Dashboard');
    await Promise.all([
      page.waitForURL(/\/releases\/\d+$/),
      dialog.getByRole('button', { name: 'Create release' }).click(),
    ]);
    const created = db.prepare('SELECT id, project_id, planned_date, planned_time FROM releases WHERE title = ?').all('Created From Dashboard');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ project_id: projectId, planned_date: '2027-03-04', planned_time: '08:15' });
    expect(new URL(page.url()).pathname).toBe(`/releases/${created[0].id}`);
    expect(pageErrors).toEqual([]);
  });
});

test('Dashboard creation dialogs cancel cleanly, stay independent, and survive scheduling refreshes', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withDashboardApp(async ({ db, origin, undated }) => {
    await openDashboard(page, origin);
    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');
    const projectDialog = page.locator('#project-create-dialog');
    const newRelease = page.locator('.page-heading [data-dialog-open="release-create-dialog"]');
    const newProject = page.locator('.page-heading [data-dialog-open="project-create-dialog"]');

    // Keyboard activation, Escape dismissal, focus return and reset of abandoned input.
    await newRelease.focus();
    await page.keyboard.press('Enter');
    await expectDialogOpenState(dialog, true);
    await form.getByLabel('Title').fill('Abandoned draft');
    await page.keyboard.press('Escape');
    await expectDialogOpenState(dialog, false);
    await expect(newRelease).toBeFocused();
    await newRelease.click();
    await expectDialogOpenState(dialog, true);
    await expect(form.getByLabel('Title')).toHaveValue('');
    await dialog.locator('[data-dialog-close]').first().click();
    await expectDialogOpenState(dialog, false);

    // Each header action opens only its own dialog.
    await newProject.click();
    await expectDialogOpenState(projectDialog, true);
    await expectDialogOpenState(dialog, false);
    await expect(page.locator('#project-create-form').getByLabel('Title')).toBeVisible();
    await page.keyboard.press('Escape');
    await expectDialogOpenState(projectDialog, false);
    await expectDialogOpenState(dialog, false);

    // Quick scheduling refreshes the region but leaves both dialogs, their
    // listeners and any in-progress form values untouched.
    await page.evaluate(() => {
      document.querySelector('#release-create-dialog').dataset.testDialog = 'kept';
      document.querySelector('#project-create-dialog').dataset.testDialog = 'kept';
      document.querySelector('#release-create-form [name="title"]').value = 'Unsent release title';
    });
    const row = page.locator(`[data-dashboard-schedule][data-release-id="${undated}"]`);
    const pick = row.locator('[data-dashboard-schedule-pick]').first();
    const pickedDate = await pick.getAttribute('data-planned-date');
    await pick.click();
    await expect(row.locator('[data-dashboard-schedule-status]')).toContainText('Scheduled for');
    expect(db.prepare('SELECT planned_date FROM releases WHERE id = ?').get(undated).planned_date).toBe(pickedDate);
    await row.locator('[data-dashboard-schedule-undo]').click();
    await expect.poll(() => db.prepare('SELECT planned_date FROM releases WHERE id = ?').get(undated).planned_date).toBeNull();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await refreshNow(page)).status).toBe('refreshed');
    }
    await page.route((url) => url.pathname === '/', async (route) => {
      if (route.request().resourceType() === 'document') return route.continue();
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><main><dialog id="release-create-dialog"></dialog></main>' });
    }, { times: 1 });
    expect((await refreshNow(page)).status).toBe('failed');

    expect(await dialogCounts(page)).toEqual({ release: 1, project: 1, signatures: 1 });
    expect(await page.evaluate(() => [
      document.querySelector('#release-create-dialog').dataset.testDialog,
      document.querySelector('#project-create-dialog').dataset.testDialog,
    ])).toEqual(['kept', 'kept']);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await unresolvedDialogReferences(page)).toEqual([]);
    await expect(form.locator('[name="title"]')).toHaveValue('Unsent release title');

    await newRelease.click();
    await expectDialogOpenState(dialog, true);
    await expectDialogOpenState(projectDialog, false);
    await chooseInDropdown(form, 'release-create-project', 'input[name="projectId"] >> nth=0');
    await dialog.locator('[data-dialog-close]').first().click();
    await expectDialogOpenState(dialog, false);
    await newProject.click();
    await expectDialogOpenState(projectDialog, true);
    await projectDialog.locator('[data-dialog-close]').first().click();
    await expectDialogOpenState(projectDialog, false);
    expect(pageErrors).toEqual([]);
  });
});
