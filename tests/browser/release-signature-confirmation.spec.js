import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

test('signature manager mutations preserve drafts and stacked confirmation focus', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  const orderBodies = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/settings/release-signatures/order')) {
      orderBodies.push(request.postDataJSON());
    }
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-signature-confirm-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const entry = app.locals.releaseSignatureSettingsService.add({ name: 'Signature', body: 'Body' }).entries[0];
    app.locals.releaseSignatureSettingsService.setDefault(entry.id);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await page.goto(`http://127.0.0.1:${server.address().port}/releases`);
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    await page.locator('[data-dialog-open="release-signatures-dialog"]').first().click();
    const manager = page.locator('#release-signatures-dialog');
    await manager.evaluate((dialog) => {
      window.signatureUpdates = [];
      window.defaultNativeChanges = 0;
      dialog.addEventListener('release-signatures-configuration-updated', (event) => {
        window.signatureUpdates.push(event.detail.configuration);
      });
      dialog.querySelector('[data-release-signature-default-form] select').addEventListener('change', () => {
        window.defaultNativeChanges += 1;
      });
    });
    const chooseDefault = async (id) => {
      await manager.locator('#release-signatures-default summary').click();
      await manager.locator(`[data-release-signature-default-form] input[value="${id}"]`).check();
    };
    const deleteButton = manager.locator(`[data-signature-id="${entry.id}"] [data-release-signature-delete]`);
    await expect(manager.locator('[data-release-signature-save]')).toHaveCount(0);
    await expect(deleteButton).toHaveAttribute('aria-label', 'Delete signature');
    await expect(deleteButton.locator('svg')).toHaveCount(1);
    await expect(deleteButton).toHaveText('');
    const cardLayout = await manager.locator('[data-release-signature-item]').first().evaluate((card) => {
      const bounds = (selector) => card.querySelector(selector).getBoundingClientRect();
      const name = bounds('[name="name"]');
      const body = bounds('[name="body"]');
      const remove = bounds('[data-release-signature-delete]');
      const cardBox = card.getBoundingClientRect();
      const listBox = card.closest('[data-release-signatures-list]').getBoundingClientRect();
      return { name: { top: name.top, right: name.right }, body: { top: body.top, left: body.left, right: body.right },
        remove: { left: remove.left, right: remove.right, width: remove.width },
        card: { left: cardBox.left, right: cardBox.right }, list: { left: listBox.left, right: listBox.right } };
    });
    expect(Math.abs(cardLayout.name.top - cardLayout.body.top)).toBeLessThan(2);
    expect(cardLayout.name.right).toBeLessThan(cardLayout.body.left);
    expect(cardLayout.body.right).toBeLessThan(cardLayout.remove.left);
    expect(cardLayout.remove.width).toBeLessThan(45);
    expect(cardLayout.card.left).toBeGreaterThanOrEqual(cardLayout.list.left - 1);
    expect(cardLayout.card.right).toBeLessThanOrEqual(cardLayout.list.right + 1);
    const sectionSpacing = await manager.evaluate((dialog) => {
      const sectionBody = (heading) => dialog.querySelector(`#release-signatures-${heading}-heading`)
        .nextElementSibling;
      const contentEdges = (body) => {
        const box = body.getBoundingClientRect();
        const style = getComputedStyle(body);
        return { left: box.left + parseFloat(style.paddingLeft),
          right: box.right - parseFloat(style.paddingRight) };
      };
      const signatures = sectionBody('current');
      const list = signatures.querySelector('[data-release-signatures-list]');
      const card = list.querySelector('[data-release-signature-item]');
      const help = signatures.querySelector('[data-release-signature-reorder-live]');
      const edges = (element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right };
      };
      return { signatures: contentEdges(signatures), defaults: contentEdges(sectionBody('default')),
        add: contentEdges(sectionBody('add')), list: edges(list), card: edges(card), help: edges(help),
        listPadding: getComputedStyle(list).padding, helpPadding: getComputedStyle(help).padding,
        cardPaddingLeft: parseFloat(getComputedStyle(card).paddingLeft),
        cardGap: parseFloat(getComputedStyle(list).rowGap),
        overflowingElements: [...signatures.querySelectorAll('*')].filter((element) =>
            element.getBoundingClientRect().right > signatures.getBoundingClientRect().right + 1)
            .map((element) => element.tagName) };
    });
    for (const edges of [sectionSpacing.defaults, sectionSpacing.add,
      sectionSpacing.list, sectionSpacing.card, sectionSpacing.help]) {
      expect(Math.abs(edges.left - sectionSpacing.signatures.left)).toBeLessThan(2);
      expect(Math.abs(edges.right - sectionSpacing.signatures.right)).toBeLessThan(2);
    }
    expect(sectionSpacing.listPadding).toBe('0px');
    expect(sectionSpacing.helpPadding).toBe('0px');
    expect(sectionSpacing.cardPaddingLeft).toBeGreaterThan(0);
    expect(sectionSpacing.cardGap).toBeGreaterThan(0);
    expect(sectionSpacing.overflowingElements).toEqual([]);
    await page.setViewportSize({ width: 600, height: 800 });
    const narrowLayout = await manager.locator('[data-release-signature-item]').first().evaluate((card) => {
      const name = card.querySelector('[name="name"]').getBoundingClientRect();
      const body = card.querySelector('[name="body"]').getBoundingClientRect();
      const remove = card.querySelector('[data-release-signature-delete]').getBoundingClientRect();
      const list = card.closest('[data-release-signatures-list]').getBoundingClientRect();
      return { nameTop: name.top, nameRight: name.right, bodyTop: body.top,
        bodyLeft: body.left, bodyRight: body.right, removeLeft: remove.left, removeRight: remove.right, listRight: list.right };
    });
    expect(Math.abs(narrowLayout.nameTop - narrowLayout.bodyTop)).toBeLessThan(2);
    expect(narrowLayout.nameRight).toBeLessThan(narrowLayout.bodyLeft);
    expect(narrowLayout.bodyRight).toBeLessThan(narrowLayout.removeLeft);
    expect(narrowLayout.removeRight).toBeLessThanOrEqual(narrowLayout.listRight + 1);
    await page.setViewportSize({ width: 1280, height: 720 });
    await deleteButton.click();
    const confirmation = page.locator('#app-confirmation-dialog');
    await expect(confirmation).toBeVisible();
    await expect(manager).toBeVisible();
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(manager).toBeVisible();
    await expect(deleteButton).toBeFocused();
    await expect(deleteButton).toBeVisible();
    expect(app.locals.releaseSignatureSettingsService.getConfiguration().entries).toHaveLength(1);

    const add = manager.locator('[data-release-signature-add-form]');
    await add.locator('[name="name"]').fill('Second');
    await add.locator('[name="body"]').fill('line one\n<&>"');
    await page.route('**/settings/release-signatures', route => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ status: 'error', errors: { name: 'Rejected name.' } }),
    }), { times: 1 });
    await add.locator('[data-release-signature-add]').click();
    await expect(manager.locator('[data-dialog-status]')).toHaveText('Rejected name.');
    await expect(add.locator('[name="name"]')).toHaveValue('Second');
    await expect(add.locator('[name="body"]')).toHaveValue('line one\n<&>"');
    await add.locator('[data-release-signature-add]').click();
    await expect(manager.locator('[data-release-signature-item]')).toHaveCount(2);
    await expect(add.locator('[name="name"]')).toHaveValue('');
    const second = app.locals.releaseSignatureSettingsService.getConfiguration().entries[1];
    expect(app.locals.releaseSignatureSettingsService.getConfiguration().defaultId).toBe(entry.id);
    const secondCard = manager.locator(`[data-release-signature-item][data-signature-id="${second.id}"]`);
    await expect(secondCard.locator('[name="body"]')).toHaveValue('line one\n<&>"');

    await secondCard.locator('[name="name"]').fill('Edited <&>');
    await secondCard.locator('[name="body"]').focus();
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().entries[1].name).toBe('Edited <&>');
    await expect(manager.locator('[data-dialog-status]')).toHaveText('Signature saved.');
    await page.route(`**/settings/release-signatures/${second.id}`, route => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ status: 'error', errors: { body: 'Rejected body.' } }),
    }), { times: 1 });
    await secondCard.locator('[name="body"]').fill('updated\nplain <script>');
    await secondCard.focus();
    await expect(manager.locator('[data-dialog-status]')).toHaveText('Rejected body.');
    await expect(secondCard.locator('[name="body"]')).toHaveValue('updated\nplain <script>');
    await secondCard.locator('[name="body"]').fill('updated\nplain <script>!');
    await secondCard.focus();
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().entries[1].body).toBe('updated\nplain <script>!');
    expect(app.locals.releaseSignatureSettingsService.getConfiguration().entries[1].id).toBe(second.id);
    expect(app.locals.releaseSignatureSettingsService.getConfiguration().entries.map(({ id }) => id)).toEqual([entry.id, second.id]);
    await expect(secondCard.locator('[name="body"]')).toHaveValue('updated\nplain <script>!');
    await expect(manager.locator('[data-dialog-status]')).toHaveText('Signature saved.');

    const firstCard = manager.locator(`[data-release-signature-item][data-signature-id="${entry.id}"]`);
    await add.locator('[name="name"]').fill('unsaved add draft');
    await firstCard.locator('[name="body"]').fill('unsaved first draft');
    await manager.evaluate((dialog, id) => {
      const radio = dialog.querySelector(`[data-release-signature-default-form] input[value="${id}"]`);
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }, second.id);
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().defaultId).toBe(second.id);
    await expect(firstCard.locator('[name="body"]')).toHaveValue('unsaved first draft');
    await expect(add.locator('[name="name"]')).toHaveValue('unsaved add draft');
    await chooseDefault('');
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().defaultId).toBeNull();
    await chooseDefault(entry.id);
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().defaultId).toBe(entry.id);
    await page.route('**/settings/release-signatures/default', route => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ status: 'error', errors: { id: 'Rejected default.' } }),
    }), { times: 1 });
    await chooseDefault(second.id);
    await expect(manager.locator('[data-dialog-status]')).toHaveText('Rejected default.');
    await expect(manager.locator('[data-release-signature-default-form] select')).toHaveValue(entry.id);

    await secondCard.focus();
    await secondCard.press('ArrowUp');
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().entries.map(({ id }) => id))
      .toEqual([second.id, entry.id]);
    expect(orderBodies).toContainEqual({ orderedIds: [second.id, entry.id] });
    await expect(firstCard.locator('[name="body"]')).toHaveValue('unsaved first draft');
    await expect(add.locator('[name="name"]')).toHaveValue('unsaved add draft');
    await page.route('**/settings/release-signatures/order', route => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ status: 'error', errors: { orderedIds: 'Rejected order.' } }),
    }), { times: 1 });
    await secondCard.focus();
    await secondCard.press('ArrowDown');
    await expect(manager.locator('[data-dialog-status]')).toHaveText('Rejected order.');
    await expect(manager.locator('[data-release-signature-item]').first()).toHaveAttribute('data-signature-id', second.id);
    await expect(firstCard.locator('[name="body"]')).toHaveValue('unsaved first draft');
    await expect(manager.locator('[data-release-signatures-manager]')).not.toHaveAttribute('aria-busy', 'true');
    const excludedDrags = await manager.evaluate((dialog, id) => {
      const card = dialog.querySelector(`[data-release-signature-item][data-signature-id="${id}"]`);
      return ['[name="name"]', '[name="body"]', '[data-release-signature-delete]']
        .map((selector) => {
          const control = card.querySelector(selector);
          control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
          const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
          card.dispatchEvent(drag);
          control.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
          return drag.defaultPrevented;
        });
    }, second.id);
    expect(excludedDrags).toEqual([true, true, true]);
    const sourceBounds = await secondCard.boundingBox();
    const destinationBounds = await firstCard.boundingBox();
    await page.mouse.move(sourceBounds.x + sourceBounds.width - 4, sourceBounds.y + sourceBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(destinationBounds.x + destinationBounds.width - 4,
      destinationBounds.y + destinationBounds.height - 4, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().entries.map(({ id }) => id))
      .toEqual([entry.id, second.id]);
    await secondCard.focus();
    await secondCard.press('ArrowUp');
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().entries.map(({ id }) => id))
      .toEqual([second.id, entry.id]);
    await secondCard.locator('[data-release-signature-delete]').click();
    await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    await expect(manager.locator('[data-release-signature-item]')).toHaveCount(1);
    await expect(firstCard.locator('[name="body"]')).toHaveValue('unsaved first draft');
    await expect(add.locator('[name="name"]')).toHaveValue('unsaved add draft');

    await deleteButton.click();
    await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    await expect(manager.locator('[data-release-signature-item]')).toHaveCount(0);
    await expect(manager.locator('[data-release-signature-add-form] [name="name"]')).toBeFocused();
    await expect(manager.locator('[data-release-signature-default-form] select')).toHaveValue('');
    expect(app.locals.releaseSignatureSettingsService.getConfiguration().defaultId).toBeNull();
    expect(await page.evaluate(() => window.defaultNativeChanges)).toBe(0);
    const updates = await page.evaluate(() => window.signatureUpdates);
    expect(updates.length).toBeGreaterThanOrEqual(7);
    expect(updates.at(-1)).toEqual({ version: 1, entries: [], defaultId: null });
    await add.locator('[data-release-signature-add]').click();
    await expect(manager.locator('[data-release-signature-item]')).toHaveCount(1);
    expect(app.locals.releaseSignatureSettingsService.getConfiguration().defaultId).toBeNull();
    await manager.locator('[data-release-signature-item] [name="name"]').fill('Saved with Enter');
    await manager.locator('[data-release-signature-item] [name="name"]').press('Enter');
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().entries[0].name)
      .toBe('Saved with Enter');
    await expect(manager).toBeVisible();
    await add.locator('[name="name"]').fill('abandoned add');
    await add.locator('[name="body"]').fill('abandoned body');
    await manager.getByRole('button', { name: 'Close Manage signatures' }).click();
    await page.locator('[data-dialog-open="release-signatures-dialog"]').first().click();
    await expect(add.locator('[name="name"]')).toHaveValue('');
    await expect(add.locator('[name="body"]')).toHaveValue('');
    await expect(manager.locator('[data-release-signature-item] [name="name"]')).toHaveValue('Saved with Enter');
    const confirmedBody = app.locals.releaseSignatureSettingsService.getConfiguration().entries[0].body;
    const savedBody = manager.locator('[data-release-signature-item] [name="body"]');
    await page.route('**/settings/release-signatures/*', route => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ status: 'error', errors: { body: 'Rejected body.' } }),
    }), { times: 1 });
    await savedBody.fill('failed local body');
    await add.locator('[name="name"]').focus();
    await expect(manager.locator('[data-dialog-status]')).toHaveText('Rejected body.');
    await manager.getByRole('button', { name: 'Close Manage signatures' }).click();
    await page.locator('[data-dialog-open="release-signatures-dialog"]').first().click();
    await expect(savedBody).toHaveValue(confirmedBody);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('signature edit reconciliation distinguishes close cleanup from newer input', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-signature-reopen-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const entry = app.locals.releaseSignatureSettingsService.add({ name: 'Signature', body: 'Old' }).entries[0];
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await page.goto(`http://127.0.0.1:${server.address().port}/releases`);
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    const openManager = page.locator('[data-dialog-open="release-signatures-dialog"]').first();
    await openManager.click();
    const manager = page.locator('#release-signatures-dialog');
    const body = manager.locator(`[data-signature-id="${entry.id}"] [name="body"]`);
    const addName = manager.locator('[data-release-signature-add-form] [name="name"]');
    const holdEdit = async () => {
      let received;
      let release;
      const requestReceived = new Promise(resolve => { received = resolve; });
      const responseAllowed = new Promise(resolve => { release = resolve; });
      await page.route(`**/settings/release-signatures/${entry.id}`, async (route) => {
        received();
        await responseAllowed;
        await route.continue();
      }, { times: 1 });
      return { requestReceived, release };
    };

    const firstSave = await holdEdit();
    await body.fill('New');
    await addName.focus();
    await firstSave.requestReceived;
    await manager.getByRole('button', { name: 'Close Manage signatures' }).click();
    await openManager.click();
    await expect(body).toHaveValue('Old');
    firstSave.release();
    await expect(body).toHaveValue('New');
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().entries[0].body).toBe('New');

    const secondSave = await holdEdit();
    await body.fill('Saved again');
    await addName.focus();
    await secondSave.requestReceived;
    await body.fill('Newest');
    const newerSave = await holdEdit();
    secondSave.release();
    await expect.poll(() => app.locals.releaseSignatureSettingsService.getConfiguration().entries[0].body).toBe('Saved again');
    await expect(body).toHaveValue('Newest');
    await expect(body).toHaveJSProperty('defaultValue', 'Saved again');
    newerSave.release();
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
