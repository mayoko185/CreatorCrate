import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

test('WP6B2 add, color, delete and authoritative catalogue reconciliation', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1280, height: 1600 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-option-mutations-'));
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
    app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Referenced Status',
      color: '#123456',
    });
    db.prepare(`
      INSERT INTO projects (title, slug, status, project_type)
      VALUES ('Referenced owner', 'referenced-owner', 'referenced-status', 'images')
    `).run();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    const posts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/project-options/')) {
        posts.push({ url: request.url(), body: new URLSearchParams(request.postData() || '') });
      }
    });
    await page.goto(`${base}/settings/defaults`);

    const region = kind => page.locator(`[data-settings-project-option-editor="${kind}"]`);
    const card = (kind, value) => region(kind).locator(`[data-project-option-value="${value}"]`);
    const add = kind => region(kind).locator('[data-project-option-add-form]');
    const feedback = kind => region(kind).locator('[data-project-option-feedback]');
    const dialog = page.locator('#app-confirmation-dialog');
    const confirmDelete = async () => {
      await expect(page.locator('#app-confirmation-dialog')).toBeVisible();
      await page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
    };
    const expectEnhanced = async kind => {
      await expect(region(kind).locator('[data-project-option-card]').first()).toHaveAttribute('draggable', 'true');
      await expect(region(kind).locator('[data-project-option-color-control] details').first()).toHaveCount(1);
    };
    const expectReplacementDropdown = async () => {
      await card('status', 'referenced-status').locator('[data-project-option-delete]').click();
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[data-cc-dropdown]')).toBeVisible();
      await expect(dialog.locator('[data-cc-dropdown] summary')).toBeFocused();
      await expect(dialog.locator('[data-project-option-delete-replacement]')).toHaveValue('');
      await dialog.locator('[data-app-dialog-confirmation-cancel]').click();
    };

    // Add uses only the creation draft and current picker color. A second mechanical
    // click while the delayed request is pending cannot enqueue another mutation.
    let delayedAdds = 0;
    await page.route('**/project-options/status/add', async (route) => {
      delayedAdds += 1;
      await new Promise(resolve => setTimeout(resolve, 150));
      await route.continue();
    });
    await add('status').locator('[data-project-option-color-trigger]').click();
    await add('status').locator('[data-color="#D946EF"]').click();
    await add('status').locator('[name="name"]').fill('Client Review');
    await add('status').locator('button[type="submit"]').evaluate(button => {
      button.click();
      button.click();
    });
    await expect(card('status', 'client-review')).toBeVisible();
    expect(delayedAdds).toBe(1);
    const statusAdd = posts.find(post => post.url.endsWith('/project-options/status/add'));
    expect([...statusAdd.body.keys()]).toEqual(['_csrf', 'name', 'color']);
    expect(statusAdd.body.get('name')).toBe('Client Review');
    expect(statusAdd.body.get('color')).toBe('#D946EF');
    expect(statusAdd.body.has('value')).toBe(false);
    expect(statusAdd.body.has('label')).toBe(false);
    await expect(add('status').locator('[name="name"]')).toHaveValue('');
    await expectEnhanced('status');
    await expectReplacementDropdown();
    await page.unrouteAll();

    await add('project-type').locator('[name="name"]').fill('Storyboard');
    await add('project-type').locator('button[type="submit"]').click();
    await expect(card('project-type', 'storyboard')).toBeVisible();
    await expect(card('status', 'storyboard')).toHaveCount(0);
    await expectEnhanced('project-type');

    // Server validation replaces only Status and preserves its submitted draft.
    await add('status').locator('[name="name"]').fill('Client Review');
    await add('status').locator('button[type="submit"]').click();
    await expect(feedback('status')).toHaveAttribute('data-project-option-feedback-code', 'VALIDATION_ERROR');
    await expect(add('status').locator('[name="name"]')).toHaveValue('Client Review');
    await expect(card('project-type', 'storyboard')).toBeVisible();

    // A network failure never invents success and leaves the recoverable Add draft.
    await page.route('**/project-options/status/add', route => route.abort());
    await add('status').locator('[name="name"]').fill('Network Draft');
    await add('status').locator('button[type="submit"]').click();
    await expect(feedback('status')).toContainText('network request failed');
    await expect(add('status').locator('[name="name"]')).toHaveValue('Network Draft');
    await expect(card('status', 'network-draft')).toHaveCount(0);
    await page.unrouteAll();

    // Reorder replacement must retain mutation enhancement for the realistic sequence.
    const moving = card('status', 'client-review');
    const reorderResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().endsWith('/project-options/status/reorder'));
    await moving.focus();
    await page.keyboard.press('Home');
    await reorderResponse;
    await expect(card('status', 'client-review')).toHaveAttribute('aria-posinset', '1');
    await expectReplacementDropdown();

    // Color persistence is immediate on a committed picker selection. Disabling the
    // form while delayed prevents a later intent from racing an older response.
    let delayedColors = 0;
    await page.route('**/project-options/status/client-review/color', async (route) => {
      delayedColors += 1;
      await new Promise(resolve => setTimeout(resolve, 150));
      await route.continue();
    });
    const statusColorResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().endsWith('/project-options/status/client-review/color'));
    await card('status', 'client-review').locator('[data-project-option-color-trigger]').click();
    await card('status', 'client-review').locator('[data-color="#0EA5E9"]').evaluate(button => {
      button.click();
      button.parentElement.querySelector('[data-color="#EF4444"]').click();
    });
    await statusColorResponse;
    await expect(card('status', 'client-review').locator('.project-option-color-code')).toHaveText('#0EA5E9');
    await expect(card('status', 'client-review').locator('.project-status-badge'))
      .toHaveAttribute('style', /--project-badge-bg: #0EA5E9; --project-badge-tint: 18%; --project-badge-fg: #30B2EC/);
    expect(delayedColors).toBe(1);
    const colorPost = posts.find(post => post.url.endsWith('/status/client-review/color'));
    expect([...colorPost.body.keys()]).toEqual(['_csrf', 'color']);
    expect(colorPost.body.get('color')).toBe('#0EA5E9');
    expect(colorPost.body.has('name')).toBe(false);
    expect(colorPost.body.has('orderedValues[]')).toBe(false);
    await expectEnhanced('status');
    await expectReplacementDropdown();
    await page.unrouteAll();

    const typeColorResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().endsWith('/project-options/project-type/storyboard/color'));
    await card('project-type', 'storyboard').locator('[data-project-option-color-trigger]').click();
    await card('project-type', 'storyboard').locator('[data-color="#F97316"]').click();
    await typeColorResponse;
    await expect(card('project-type', 'storyboard').locator('.project-option-color-code')).toHaveText('#F97316');
    await expect(card('project-type', 'storyboard').locator('.project-type-badge'))
      .toHaveAttribute('style', /--project-badge-bg: #F97316; --project-badge-tint: 18%; --project-badge-fg: #FA8737/);
    await expect(card('status', 'client-review').locator('.project-option-color-code')).toHaveText('#0EA5E9');

    // Network color failure rolls the local picker back to its last authoritative color.
    await page.route('**/project-options/status/client-review/color', route => route.abort());
    await card('status', 'client-review').locator('[data-project-option-color-trigger]').click();
    await card('status', 'client-review').locator('[data-color="#22C55E"]').click();
    await expect(feedback('status')).toContainText('network request failed');
    await expect(card('status', 'client-review').locator('.project-option-color-code')).toHaveText('#0EA5E9');
    await page.unrouteAll();

    await card('status', 'client-review').locator('summary').press('Escape');
    await page.route('**/project-options/status/client-review/color', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<p>Missing catalogue region</p>',
    }));
    await card('status', 'client-review').locator('[data-project-option-color-trigger]').click();
    await card('status', 'client-review').locator('[data-color="#EAB308"]').click();
    await expect(feedback('status')).toContainText('server response was incomplete');
    await expect(card('status', 'client-review').locator('.project-option-color-code')).toHaveText('#0EA5E9');
    await page.unrouteAll();

    // A saved-default blocker is informational and cannot issue a destructive request.
    const postsBeforeBlocked = posts.length;
    const tbdDelete = card('status', 'tbd').locator('[data-project-option-delete]');
    await expect(tbdDelete).toHaveAttribute('data-project-option-delete-mode', 'blocked');
    await tbdDelete.click();
    await expect(dialog).toContainText('“Tbd” cannot be deleted yet');
    await expect(dialog).toContainText('Blocked by New Project Status default. Change that default first.');
    await expect(dialog).not.toContainText('required by CreatorCrate');
    await expect(dialog.locator('[data-project-option-delete-replacement]')).toHaveCount(0);
    await confirmDelete();
    expect(posts).toHaveLength(postsBeforeBlocked);
    await expect(card('status', 'tbd')).toBeVisible();

    // A safe delete sends no remap data and removes only the confirmed Type option.
    await card('project-type', 'storyboard').locator('[data-project-option-delete]').evaluate(button => {
      button.click();
      button.click();
    });
    await confirmDelete();
    await expect(card('project-type', 'storyboard')).toHaveCount(0);
    await expect(card('status', 'client-review')).toBeVisible();
    const deletePost = posts.find(post => post.url.endsWith('/project-type/storyboard/delete'));
    expect([...deletePost.body.keys()]).toEqual(['_csrf']);
    expect(deletePost.body.has('replacement')).toBe(false);
    expect(deletePost.body.has('remap')).toBe(false);
    await expectEnhanced('project-type');

    // Delete the custom Status to finish the end-to-end lifecycle.
    await card('status', 'client-review').locator('[data-project-option-delete]').click();
    await confirmDelete();
    await expect(card('status', 'client-review')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
