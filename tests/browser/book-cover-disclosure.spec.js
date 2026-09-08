import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

test('actual New/Edit Book cover disclosures preserve native interaction and replacement warning', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-cover-disclosure-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const empty = app.locals.bookService.createBook({ title: 'No cover' });
    const buffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: 'red' } }).png().toBuffer();
    const file = { name: 'cover.png', mimeType: 'image/png', buffer };
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/notes`);
    await page.getByRole('link', { name: 'New Book', exact: true }).first().click();
    const create = page.locator('#book-create-dialog');
    const cover = dialog => dialog.locator('details').filter({ has: page.locator('summary', { hasText: /^Book cover$/ }) });
    const toggle = async disclosure => {
      const summary = disclosure.locator('summary');
      await expect(disclosure).not.toHaveAttribute('open');
      await summary.click();
      await expect(disclosure).toHaveAttribute('open');
      await summary.click();
      await summary.focus();
      await summary.press('Enter');
      await expect(disclosure).toHaveAttribute('open');
      await summary.press('Space');
      await expect(disclosure).not.toHaveAttribute('open');
      await summary.press('Enter');
      await expect(disclosure.locator('[name="cover"]')).toBeVisible();
    };

    const expectBookSpacing = async bookDialog => {
      await expect(bookDialog.getByRole('heading', { name: 'Book details', exact: true })).toHaveCount(1);
      const spacing = await bookDialog.evaluate(node => {
        const readPadding = element => {
          const style = getComputedStyle(element);
          return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
        };
        const detailsSection = node.querySelector('[data-notes-book-details-section]');
        const detailsBody = detailsSection.querySelector('.project-edit-dialog-section-body');
        const actionsSection = node.querySelector('[data-notes-book-actions-section]');
        const actionsBody = actionsSection.querySelector('.project-edit-dialog-section-body');
        const disclosureContent = actionsSection.querySelector('.notes-workspace-disclosure-content');
        return {
          detailsSection: readPadding(detailsSection),
          detailsBody: readPadding(detailsBody),
          actionsSection: readPadding(actionsSection),
          actionsBody: readPadding(actionsBody),
          disclosureContentBottom: getComputedStyle(disclosureContent).paddingBottom,
          dialogBodyBottom: getComputedStyle(node.querySelector('.app-dialog-body')).paddingBottom,
          headingMargins: getComputedStyle(detailsSection.querySelector('h3')).marginInline,
        };
      });
      expect(spacing.detailsSection).toEqual(['0px', '0px', '0px', '0px']);
      expect(spacing.detailsBody).toEqual(['12px', '12px', '12px', '12px']);
      expect(spacing.actionsSection[2]).toBe('0px');
      expect(spacing.actionsBody[2]).toBe('8px');
      expect(spacing.disclosureContentBottom).toBe('0px');
      expect(spacing.dialogBodyBottom).toBe('8px');
      expect(spacing.headingMargins).toBe('0px');
      await expect(bookDialog.locator('.app-dialog-footer').getByRole('button')).toBeVisible();
    };
    await expectBookSpacing(create);
    await expect(create).toBeVisible();
    await expect(cover(create).locator('img')).toHaveCount(0);
    await toggle(cover(create));
    await create.locator('[name="title"]').fill('Uploaded cover');
    await cover(create).locator('[name="cover"]').setInputFiles(file);
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/notes\/books\/\d+$/);
    await page.getByRole('link', { name: 'Edit book', exact: true }).click();
    const edit = page.locator('#book-edit-dialog');
    const disclosure = cover(edit);
    const deletion = edit.locator('details').filter({ has: page.locator('summary', { hasText: /^Delete Book$/ }) });
    const disclosureStyle = locator => locator.evaluate(node => {
      const read = element => {
        const style = getComputedStyle(element);
        return Object.fromEntries(['borderTop', 'backgroundColor', 'padding', 'fontSize', 'fontWeight', 'color'].map(key => [key, style[key]]));
      };
      return [read(node), read(node.querySelector('summary')), read(node.querySelector('.notes-workspace-disclosure-content')),
        getComputedStyle(node.querySelector('summary'), '::after').content];
    });
    expect(await disclosureStyle(disclosure)).toEqual(await disclosureStyle(deletion));
    await expect(disclosure.locator('img')).toHaveCount(1);
    await expect(disclosure.locator('img')).not.toBeVisible();
    await toggle(disclosure);
    await expect(disclosure.locator('img')).toBeVisible();
    await expect.poll(() => disclosure.locator('img').evaluate(n => n.naturalWidth)).toBe(20);
    await expect(deletion).not.toHaveAttribute('open');
    await deletion.locator('summary').click();
    await expect(disclosure).toHaveAttribute('open');
    await disclosure.locator('summary').click();
    await expect(disclosure.locator('img')).not.toBeVisible();
    await expect(deletion).toHaveAttribute('open');
    await deletion.locator('summary').press('Space');
    await expect(deletion).not.toHaveAttribute('open');
    await expect(disclosure).not.toHaveAttribute('open');
    await disclosure.locator('summary').click();
    await disclosure.locator('[name="cover"]').setInputFiles(file);
    expect(await disclosure.locator('[name="cover"]').evaluate(n => n.files.length)).toBe(1);
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    const warning = page.getByRole('dialog', { name: 'Replace cover image?' });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('The previous image or Asset will not be deleted.');
    await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(edit).toBeVisible();
    await expect(edit.locator('[name="coverReplacementConfirmed"]')).toHaveValue('false');
    await expect(edit.getByRole('heading', { name: 'Book actions', exact: true })).toHaveCount(1);

    await expectBookSpacing(edit);
    await expect(edit.locator('img')).toHaveCount(1);
    await expect(page.locator('form form')).toHaveCount(0);
    expect(await page.locator('[id]').evaluateAll(nodes => new Set(nodes.map(n => n.id)).size === nodes.length)).toBe(true);
    await page.keyboard.press('Escape');
    await page.goto(`${base}/notes/books/${empty.id}/edit`);
    await expect(cover(edit).locator('img, .notes-book-cover')).toHaveCount(0);
    await toggle(cover(edit));
    await cover(edit).locator('[name="cover"]').setInputFiles(file);
    expect(await cover(edit).locator('[name="cover"]').evaluate(n => n.files.length)).toBe(1);
    await page.setViewportSize({ width: 390, height: 640 });
    await expectBookSpacing(edit);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
