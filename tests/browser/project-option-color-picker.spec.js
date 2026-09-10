import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

test('WP6B1 shared local picker, lifecycle, viewport and reorder isolation', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1280, height: 1600 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-color-picker-'));
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
    const base = `http://127.0.0.1:${server.address().port}`;
    const errors = [], posts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST') posts.push(request);
    });
    await page.goto(base + '/settings/defaults');

    const region = kind => page.locator(`[data-settings-project-option-editor="${kind}"]`);
    const controls = kind => region(kind).locator('[data-project-option-color-control]');
    await page.evaluate(() => {
      window.colorEvents = [];
      document.addEventListener('project-option-color-change', e => window.colorEvents.push(e.detail));
    });
    for (const kind of ['status', 'project-type']) {
      for (const control of [region(kind).locator('[data-project-option-add-form] [data-project-option-color-control]')]) {
        const trigger = control.locator('summary');
        const panel = control.locator('.project-option-color-panel');
        const value = control.locator('[name="color"]');
        const initial = await value.inputValue();
        const name = region(kind).locator('[name="name"]');
        await name.fill('Keep this draft');
        await trigger.click();
        await expect(panel).toBeVisible();
        const palette = await panel.locator('.project-option-color-palette').evaluate(node => ({
          colors: [...node.querySelectorAll('button')].map(button => button.dataset.color),
          columns: getComputedStyle(node).gridTemplateColumns.split(' ').length,
        }));
        expect(palette).toEqual({
          colors: [
            '#64748B', '#EF4444', '#F97316', '#EAB308', '#22C55E', '#14B8A6',
            '#0EA5E9', '#3B82F6', '#8B5CF6', '#D946EF', '#EC4899', '#FFFFFF',
            '#AAAAAA', '#22D3EE', '#34D399', '#A78BFA', '#9CA3AF', '#FF8A94',
          ],
          columns: 6,
        });
        const dimensions = await panel.evaluate(node => ({
          panelWidth: node.getBoundingClientRect().width,
          viewportWidth: innerWidth,
        }));
        expect(dimensions.panelWidth).toBeLessThanOrEqual(272);
        expect(dimensions.panelWidth).toBeLessThan(dimensions.viewportWidth / 2);
        await expect(panel.locator('input')).toHaveValue(initial);
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await trigger.press('Tab');
        await expect(panel.locator('button').first()).toBeFocused();
        await panel.locator('[data-color="#EF4444"]').click();
        await expect(value).toHaveValue('#EF4444');
        await expect(panel.locator('[data-color="#EF4444"]')).toHaveAttribute('aria-pressed', 'true');
        const hex = panel.locator('input');
        await hex.fill(' a1b2c3 ');
        await hex.press('Enter');
        await expect(value).toHaveValue('#A1B2C3');
        await expect(trigger.locator('.project-option-color-code')).toHaveText('#A1B2C3');
        expect(await trigger.locator('.project-option-color-swatch').evaluate(n => n.style.getPropertyValue('--project-option-color'))).toBe('#A1B2C3');
        await hex.fill('red; background:url(bad)');
        await hex.press('Enter');
        await expect(hex).toHaveAttribute('aria-invalid', 'true');
        await expect(panel.locator('[role="status"]')).toContainText('six hexadecimal digits');
        await expect(value).toHaveValue('#A1B2C3');
        await expect(name).toHaveValue('Keep this draft');
        await hex.press('Escape');
        await expect(panel).not.toBeVisible();
        await expect(trigger).toBeFocused();
        await trigger.press('Enter');
        await expect(hex).toHaveValue('#A1B2C3');
        await trigger.click();
        await expect(panel).not.toBeVisible();
      }
    }
    expect(posts).toHaveLength(0);
    expect(await page.evaluate(() => window.colorEvents)).toHaveLength(4);
    const first = controls('status').first();
    const second = controls('status').last();
    await first.locator('summary').click();
    await second.locator('summary').click();
    await expect(first.locator('details')).not.toHaveAttribute('open');
    await expect(second.locator('details')).toHaveAttribute('open');
    await second.locator('input[type="text"]').focus();
    await page.evaluate(() => {
      const outside = document.createElement('div');
      outside.id = 'picker-outside-test';
      outside.style.cssText = 'position:fixed;top:100px;left:500px;width:20px;height:20px;z-index:2147483647';
      document.body.append(outside);
    });
    await page.locator('#picker-outside-test').click();
    await expect(second.locator('details')).not.toHaveAttribute('open');
    await expect(second.locator('summary')).toBeFocused();
    await page.locator('#picker-outside-test').evaluate(n => n.remove());

    // Real layout, deliberately anchor at each viewport boundary without a portal.
    const contained = async () => {
      await expect(first.locator('.project-option-color-panel')).toBeVisible();
      await expect.poll(() => first.locator('.project-option-color-panel').evaluate(panel => {
        const r = panel.getBoundingClientRect();
        return r.left >= 7 && r.top >= 7 && r.right <= innerWidth - 7 && r.bottom <= innerHeight - 7;
      })).toBe(true);
    };
    for (const [width, height, right, bottom] of [[900, 600, true, false], [900, 600, false, true], [900, 600, true, true], [320, 480, true, true]]) {
      await page.setViewportSize({ width, height });
      await first.evaluate((node, { right, bottom }) => {
        node.style.cssText = `position:fixed;z-index:90;${right ? 'right:8px' : 'left:8px'};${bottom ? 'bottom:8px' : 'top:80px'}`;
      }, { right, bottom });
      await first.locator('summary').click();
      await contained();
      await page.setViewportSize({ width: width - 20, height: height - 30 });
      await contained();
      await page.evaluate(() => window.scrollBy(0, -40));
      await contained();
      await first.locator('summary').press('Escape');
    }
    await first.evaluate(node => node.removeAttribute('style'));
    await page.setViewportSize({ width: 1280, height: 1600 });
    await first.locator('summary').click();
    await page.evaluate(() => window.scrollBy(0, 20));
    await contained();
    const isolated = await first.evaluate(node => {
      const card = node.closest('[data-project-option-card]');
      return [...node.querySelectorAll('summary, button, input[type="text"]')].every(control => {
        control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
        const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
        card.dispatchEvent(drag);
        return drag.defaultPrevented;
      });
    });
    expect(isolated).toBe(true);
    await first.locator('input[type="text"]').press('ArrowDown');
    expect(posts).toHaveLength(0);
    await first.locator('summary').press('Escape');
    const cards = region('status').locator('[data-project-option-card]');
    await region('status').scrollIntoViewIfNeeded();
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/reorder'));
    await cards.first().locator('.project-option-label').dragTo(cards.nth(1), { targetPosition: { x: 5, y: (await cards.nth(1).boundingBox()).height - 3 } });
    await response;
    await expect(region('status').locator('[data-project-option-list]')).not.toHaveAttribute('aria-busy', 'true');
    await expect(first.locator('summary')).toHaveCount(1);
    await first.locator('summary').click();
    await expect(first.locator('.project-option-color-panel')).toBeVisible();
    // Replacement while open cleans detached positioning, and initialization is idempotent.
    const result = await region('status').evaluate(async node => {
      const { enhanceProjectOptionColorPickers } = await import('/client/project-option-color-picker.js');
      const old = node.querySelector('details');
      const parsed = new DOMParser().parseFromString(await (await fetch('/settings/defaults')).text(), 'text/html');
      const next = parsed.querySelector('[data-settings-project-option-editor="status"]');
      node.replaceWith(next);
      const bound = enhanceProjectOptionColorPickers(next);
      const repeated = enhanceProjectOptionColorPickers(next);
      await new Promise(resolve => setTimeout(resolve, 0));
      return { bound, repeated, open: old.open, stale: Boolean(old.__creatorCrateDropdownOverlayState) };
    });
    expect(result.bound).toBeGreaterThan(0);
    expect(result).toMatchObject({ repeated: 0, open: false, stale: false });
    const eventCount = await page.evaluate(() => window.colorEvents.length);
    await first.locator('summary').click();
    await first.locator('[data-color="#FFFFFF"]').click();
    expect(await page.evaluate(() => window.colorEvents.length)).toBe(eventCount + 1);
    expect(posts).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
