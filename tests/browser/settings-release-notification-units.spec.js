import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

test('timing unit dropdowns stay enhanced across autosave and validation replacement', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1280, height: 1600 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-notification-units-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    const posts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/settings/release-notifications') {
        posts.push(new URLSearchParams(request.postData() || ''));
      }
    });
    await page.goto(`${base}/settings/release-notifications`);

    const native = prefix => page.locator(`#release-notifications-${prefix}-unit`);
    const dropdown = prefix => page.locator(`#release-notifications-${prefix}-unit-dropdown`);
    const trigger = prefix => page.locator(`#release-notifications-${prefix}-unit-dropdown-trigger`);
    const option = (prefix, value) => dropdown(prefix).locator(`.asset-filter-multiselect-panel label:has(input[value="${value}"])`);
    const form = page.locator('#release-notifications-form');
    const saved = () => expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');

    // Initial load: the overdue group is visible by default and enhanced; the
    // advance and repeat groups are hidden but still enhanced and submitted.
    await expect(dropdown('overdue')).toBeVisible();
    await expect(native('overdue')).toBeHidden();
    await expect(native('overdue')).toHaveValue('hours');
    await expect(trigger('overdue')).toHaveAttribute('aria-label', 'Grace period unit: hours');
    for (const prefix of ['advance', 'repeat']) {
      await expect(dropdown(prefix)).toBeHidden();
      await expect(dropdown(prefix)).not.toHaveAttribute('hidden', '');
      await expect(native(prefix)).toHaveAttribute('hidden', '');
    }

    // Pointer selection: one autosave carrying one unit value; the replacement
    // region is enhanced again and focus returns to the trigger.
    await trigger('overdue').click();
    await expect(dropdown('overdue')).toHaveAttribute('open', '');
    await option('overdue', 'days').click();
    await saved();
    expect(posts).toHaveLength(1);
    expect(posts[0].getAll('overdueUnit')).toEqual(['days']);
    expect(posts[0].getAll('advanceUnit')).toHaveLength(1);
    expect(posts[0].getAll('repeatUnit')).toHaveLength(1);
    await expect(native('overdue')).toHaveValue('days');
    await expect(native('overdue')).toBeHidden();
    await expect(dropdown('overdue')).toBeVisible();
    await expect(dropdown('overdue')).not.toHaveAttribute('open', '');
    await expect(dropdown('overdue').locator('[data-cc-dropdown-summary-current]')).toHaveText('days');
    await expect(trigger('overdue')).toBeFocused();

    // Revealing the repeat group (a switch autosave) keeps its dropdown enhanced.
    await page.locator('#release-notifications-repeat-enabled').check({ force: true });
    await saved();
    await expect.poll(() => posts.length).toBe(2);
    await expect(dropdown('repeat')).toBeVisible();
    await expect(native('repeat')).toBeHidden();

    // Keyboard selection on the replaced region: open, arrow, Space.
    await trigger('repeat').focus();
    await page.keyboard.press('Enter');
    await expect(dropdown('repeat')).toHaveAttribute('open', '');
    await dropdown('repeat').locator('input[value="days"]').focus();
    await page.keyboard.press('ArrowUp');
    await saved();
    await expect.poll(() => posts.length).toBe(3);
    expect(posts[2].getAll('repeatUnit')).toEqual(['hours']);
    await expect(native('repeat')).toHaveValue('hours');
    await expect(trigger('repeat')).toBeFocused();
    await expect(trigger('repeat')).toHaveAttribute('aria-label', 'Repeat every unit: hours');

    // Validation failure (zero grace with the scheduled notification on) is
    // replaced by the 422 region; the dropdowns stay enhanced with the
    // submitted values, and a unit choice made there still posts once.
    const grace = page.locator('#release-notifications-overdue-amount');
    await grace.fill('0');
    await grace.press('Tab');
    await expect(page.locator('#release-notifications-errors')).toBeVisible();
    await expect(form).not.toHaveAttribute('aria-busy', 'true');
    await expect(native('overdue')).toHaveValue('days');
    await expect(native('overdue')).toBeHidden();
    await expect(dropdown('overdue')).toBeVisible();
    let before = posts.length;
    await trigger('overdue').click();
    await option('overdue', 'minutes').click();
    await expect.poll(() => posts.length).toBe(before + 1);
    expect(posts.at(-1).getAll('overdueUnit')).toEqual(['minutes']);
    expect(posts.at(-1).getAll('overdueAmount')).toEqual(['0']);
    await expect(form).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#release-notifications-errors')).toBeVisible();
    await expect(native('overdue')).toHaveValue('minutes');
    await expect(native('overdue')).toBeHidden();
    await expect(dropdown('overdue').locator('[data-cc-dropdown-summary-current]')).toHaveText('minutes');
    await expect(trigger('overdue')).toBeFocused();

    before = posts.length;
    await grace.fill('2');
    await grace.press('Tab');
    await saved();
    await expect(page.locator('#release-notifications-errors')).toHaveCount(0);
    expect(posts.at(-1).getAll('overdueUnit')).toEqual(['minutes']);
    await page.waitForTimeout(300);
    expect(posts.length).toBe(before + 1);

    const settings = app.locals.releaseNotificationService.getSettings();
    expect(settings.overdue.graceMinutes).toBe(2);
    expect(settings.overdueRepeat.intervalMinutes).toBe(60);
    expect(errors).toEqual([]);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try { closeDatabase(db); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
