import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createReleaseRepository } from '../../src/data/release-repository.js';

async function expectSignatureControlRow(form) {
  const row = form.locator('.release-signature-row');
  const field = row.locator('[data-release-signature-field]');
  const manage = row.locator('button[aria-label="Manage signatures"]');
  await expect(field).toHaveCount(1);
  await expect(manage).toHaveCount(1);
  await expect(manage.locator('svg')).toHaveCount(1);
  await expect(manage).toHaveText('');
  expect(await row.evaluate((element) => {
    const field = element.querySelector('[data-release-signature-field]');
    const button = element.querySelector('[aria-label="Manage signatures"]');
    return field.parentElement === element && button.parentElement === element;
  })).toBe(true);
}

async function expectSignatureControlRowFitsDialog(form) {
  const bounds = await form.locator('.release-signature-row').evaluate((row) => {
    const rect = (element) => {
      const { left, right, top, bottom, width } = element.getBoundingClientRect();
      return { left, right, top, bottom, width };
    };
    return {
      row: rect(row),
      field: rect(row.querySelector('[data-release-signature-field]')),
      button: rect(row.querySelector('button[aria-label="Manage signatures"]')),
      card: rect(row.closest('.app-dialog-card')),
    };
  });
  const { row, field, button, card } = bounds;
  expect(field.right).toBeLessThanOrEqual(button.left);
  expect(Math.min(field.bottom, button.bottom)).toBeGreaterThan(Math.max(field.top, button.top));
  expect(field.width).toBeGreaterThan(button.width);
  for (const control of [field, button]) {
    expect(control.left).toBeGreaterThanOrEqual(row.left - 1);
    expect(control.right).toBeLessThanOrEqual(row.right + 1);
    expect(control.left).toBeGreaterThanOrEqual(card.left - 1);
    expect(control.right).toBeLessThanOrEqual(card.right + 1);
  }
}

test('release signature controls stay on one row in New and Edit dialogs at 360px', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-signatures-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const project = app.locals.projectService.create({ title: 'Signature layout project' });
    const release = createReleaseRepository(db).create({ projectId: project.id, title: 'Signature layout release', description: '', notes: '' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await page.setViewportSize({ width: 360, height: 800 });
    const url = `http://127.0.0.1:${server.address().port}/releases`;

    await page.goto(url);
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    const createForm = page.locator('#release-create-form');
    await expectSignatureControlRow(createForm);
    await expectSignatureControlRowFitsDialog(createForm);

    await page.goto(`${url}/${release.id}`);
    await page.locator('[data-dialog-open="release-edit-dialog"]').first().click();
    const editForm = page.locator('#release-edit-form');
    await expectSignatureControlRow(editForm);
    await expectSignatureControlRowFitsDialog(editForm);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('identical trusted replacement relinquishes managed signature ownership', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-signatures-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const settings = app.locals.releaseSignatureSettingsService;
    const a = settings.add({ name: 'Alpha', body: 'Alpha body' }).entries[0];
    const b = settings.add({ name: 'Beta', body: 'Beta body' }).entries[1];
    settings.setDefault(a.id);
    app.locals.projectService.create({ title: 'Signature edit project' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await page.goto(`http://127.0.0.1:${server.address().port}/releases/new`);

    const form = page.locator('#release-form');
    const description = form.locator('textarea[name="description"]');
    const selected = form.locator('[data-release-signature-field] select');
    const choose = async (id) => {
      const dropdown = form.locator('#release-description-signature');
      if (!await dropdown.evaluate((element) => element.open)) await dropdown.locator('summary').click();
      await form.locator(`[data-release-signature-field] input[type="radio"][value="${id}"]`).click();
    };
    await expect(description).toHaveValue('Alpha body');
    await expect(selected).toHaveValue(a.id);

    await description.focus();
    await description.evaluate((textarea) => textarea.setSelectionRange(0, textarea.value.length));
    await page.keyboard.insertText('Alpha body');
    await expect(description).toHaveValue('Alpha body');
    await expect(selected).toHaveValue('');

    await choose('');
    await expect(description).toHaveValue('Alpha body');
    await choose(b.id);
    await expect(description).toHaveValue('Alpha body\n\nBeta body');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release signatures follow fresh draft, ownership, configuration, and limit rules', async ({ page }) => {
  test.setTimeout(60_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-signatures-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const settings = app.locals.releaseSignatureSettingsService;
    const a = settings.add({ name: 'Alpha', body: 'Alpha body' }).entries[0];
    const b = settings.add({ name: 'Beta', body: 'Beta body' }).entries[1];
    settings.setDefault(a.id);
    const project = app.locals.projectService.create({ title: 'Signature edit project' });
    const releases = createReleaseRepository(db);
    const emptyEdit = releases.create({ projectId: project.id, title: 'Empty edit', description: '', notes: '' });
    const matchingEdit = releases.create({ projectId: project.id, title: 'Matching edit', description: 'Alpha body', notes: '' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/releases`;
    await page.goto(url);
    const form = page.locator('#release-create-form');
    await expectSignatureControlRow(form);
    const description = form.locator('textarea[name="description"]');
    const selected = form.locator('[data-release-signature-field] select');
    const status = form.locator('[data-release-signature-status]');
    const choose = async (id) => {
      const dropdown = form.locator('#release-description-signature');
      if (!await dropdown.evaluate((element) => element.open)) await dropdown.locator('summary').click();
      await form.locator(`[data-release-signature-field] input[type="radio"][value="${id}"]`).click();
    };
    await expect(description).toHaveValue('Alpha body');
    await expect(selected).toHaveValue(a.id);
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    const signatureRowBounds = await form.locator('.release-signature-row').evaluate((row) => {
      const field = row.querySelector('[data-release-signature-field]').getBoundingClientRect();
      const button = row.querySelector('[aria-label="Manage signatures"]').getBoundingClientRect();
      return { fieldRight: field.right, buttonLeft: button.left, fieldBottom: field.bottom, buttonBottom: button.bottom };
    });
    expect(signatureRowBounds.buttonLeft).toBeGreaterThanOrEqual(signatureRowBounds.fieldRight);
    expect(Math.abs(signatureRowBounds.buttonBottom - signatureRowBounds.fieldBottom)).toBeLessThan(2);
    await page.locator('#release-create-dialog [data-dialog-close]').first().click();
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    await expect(description).toHaveValue('Alpha body');

    await description.evaluate((textarea) => {
      textarea.value = 'My edited Alpha body';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(description).toHaveValue('My edited Alpha body');
    await expect(selected).toHaveValue('');
    await choose(b.id);
    await expect(description).toHaveValue('My edited Alpha body\n\nBeta body');
    await page.goto(url);
    await expect(description).toHaveValue('Alpha body');
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();

    await choose(b.id);
    await expect(description).toHaveValue('Beta body');
    await choose(b.id);
    await expect(description).toHaveValue('Beta body');
    await choose('');
    await expect(description).toHaveValue('');
    await choose('');
    await expect(description).toHaveValue('');
    await expect(selected).toHaveValue('');
    await form.locator('[data-release-signature-field] input[type="radio"][value=""]')
      .dispatchEvent('change');
    expect(pageErrors).toEqual([]);
    await description.fill('A preface');
    await choose(a.id);
    await expect(description).toHaveValue('A preface\n\nAlpha body');
    await description.focus();
    await description.evaluate((textarea) => textarea.setSelectionRange(1, 1));
    await description.press('X');
    await expect(description).toHaveValue('AX preface\n\nAlpha body');
    await choose(b.id);
    await expect(description).toHaveValue('AX preface\n\nBeta body');
    await description.fill('AX preface\nX\nBeta body');
    await expect(selected).toHaveValue('');
    await choose(b.id);
    await expect(description).toHaveValue('AX preface\nX\nBeta body\n\nBeta body');
    await description.fill('AX preface\n\nBeta edited');
    await expect(selected).toHaveValue('');
    await choose(a.id);
    await expect(description).toHaveValue('AX preface\n\nBeta edited\n\nAlpha body');

    await page.evaluate(({ aId, bId }) => {
      document.querySelector('[data-release-signatures-manager]').dispatchEvent(new CustomEvent(
        'release-signatures-configuration-updated', {
          bubbles: true,
          detail: { configuration: { version: 1, defaultId: bId,
            entries: [
              { id: bId, name: 'Beta', body: 'Current Beta body' },
              { id: aId, name: 'Alpha renamed', body: 'New Alpha body' },
            ] } },
        },
      ));
    }, { aId: a.id, bId: b.id });
    await expect(description).toHaveValue('AX preface\n\nBeta edited\n\nAlpha body');
    await expect(selected).toHaveValue(a.id);
    await expect(form.locator('[data-release-signature-field] summary')).toContainText('Alpha renamed');
    await expect(selected.locator('option').nth(1)).toHaveAttribute('value', b.id);
    await choose(a.id);
    await expect(description).toHaveValue('AX preface\n\nBeta edited\n\nAlpha body');
    await choose(b.id);
    await expect(description).toHaveValue('AX preface\n\nBeta edited\n\nCurrent Beta body');
    await page.evaluate((aId) => {
      document.querySelector('[data-release-signatures-manager]').dispatchEvent(new CustomEvent(
        'release-signatures-configuration-updated', {
          bubbles: true, detail: { configuration: { version: 1, defaultId: null,
            entries: [{ id: aId, name: 'Alpha renamed', body: 'New Alpha body' }] } },
        },
      ));
    }, a.id);
    await expect(selected).toHaveValue('');
    await expect(status).toContainText('text was kept');
    await expect(description).toHaveValue('AX preface\n\nBeta edited\n\nCurrent Beta body');

    await page.goto(url);
    await expect(description).toHaveValue('Alpha body');
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    await form.evaluate((element) => element.reset());
    await expect(description).toHaveValue('');
    await expect(selected).toHaveValue('');
    await page.locator('#release-create-dialog [data-dialog-close]').first().click();
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    await expect(description).toHaveValue('');
    await description.fill('x'.repeat(3998));
    await choose(b.id);
    await expect(description).toHaveValue('x'.repeat(3998));
    await expect(selected).toHaveValue('');
    await expect(status).toContainText('4,000 characters');
    await choose('');
    await expect(description).toHaveValue('x'.repeat(3998));
    await expect(selected).toHaveValue('');
    await expect(status).toBeEmpty();
    expect(pageErrors).toEqual([]);
    await description.fill('x'.repeat(3989));
    await choose(b.id);
    await expect(selected).toHaveValue(b.id);
    await choose(a.id);
    await expect(description).toHaveValue(`${'x'.repeat(3989)}\n\nBeta body`);
    await expect(selected).toHaveValue(b.id);
    await expect(status).toContainText('4,000 characters');

    await page.goto(`${url}/new`);
    const standalone = page.locator('#release-form');
    await expectSignatureControlRow(standalone);
    await expect(standalone.locator('textarea[name="description"]')).toHaveValue('Alpha body');
    await standalone.locator('textarea[name="description"]').fill('Alpha body');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(standalone).toHaveAttribute('data-release-create-fresh', 'false');
    await expect(standalone.locator('textarea[name="description"]')).toHaveValue('Alpha body');
    await expect(standalone.locator('[data-release-signature-field] select')).toHaveValue('');

    await page.goto(`http://127.0.0.1:${server.address().port}/releases/${emptyEdit.id}`);
    await expectSignatureControlRow(page.locator('#release-edit-form'));
    await expect(page.locator('#release-edit-form textarea[name="description"]')).toHaveValue('');
    await expect(page.locator('#release-edit-form [data-release-signature-field] select')).toHaveValue('');
    await page.goto(`http://127.0.0.1:${server.address().port}/releases/${matchingEdit.id}`);
    await expect(page.locator('#release-edit-form textarea[name="description"]')).toHaveValue('Alpha body');
    await expect(page.locator('#release-edit-form [data-release-signature-field] select')).toHaveValue('');

    settings.setDefault(null);
    await page.goto(url);
    await expect(description).toHaveValue('');
    await expect(selected).toHaveValue('');
    await page.goto(`${url}/new?description=Alpha%20body`);
    await expect(page.locator('#release-form textarea[name="description"]')).toHaveValue('Alpha body');
    await expect(page.locator('#release-form [data-release-signature-field] select')).toHaveValue('');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
