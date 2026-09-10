import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

test('WP6A whole-card reorder, controls, isolation, reconciliation and reinitialization', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1280, height: 1600 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-option-reorder-'));
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
      if (request.method() === 'POST' && request.url().endsWith('/reorder')) posts.push(request);
    });
    await page.goto(base + '/settings/defaults');
    const region = kind => page.locator(`[data-settings-project-option-editor="${kind}"]`);
    const cards = kind => region(kind).locator('[data-project-option-card]');
    const order = kind => cards(kind).evaluateAll(nodes => nodes.map(node => node.dataset.projectOptionValue));
    const live = kind => region(kind).locator('[data-project-option-reorder-live]');
    const read = kind => (kind === 'status'
      ? app.locals.projectOptionCatalogueService.getStatusCatalogue()
      : app.locals.projectOptionCatalogueService.getProjectTypeCatalogue()).map(option => option.value);
    const settled = async kind => {
      await expect(region(kind).locator('[data-project-option-list]')).not.toHaveAttribute('aria-busy', 'true');
      await expect.poll(() => order(kind)).toEqual(read(kind));
    };
    await expect(cards('status').first()).toHaveAttribute('draggable', 'true');
    await expect(page.locator('[data-project-option-reorder-handle]')).toHaveCount(0);
    await expect(region('status').locator('[data-project-option-add-form]')).not.toHaveAttribute('draggable', 'true');
    const statusControls = cards('status').first().locator('.project-option-card-controls');
    await expect(statusControls.locator(':scope > form').nth(0)).toHaveAttribute('data-project-option-color-form', '');
    await expect(statusControls.locator(':scope > form').nth(1)).toHaveAttribute('data-project-option-delete-form', '');
    const expectCardGeometry = async (kind, width) => {
      await page.setViewportSize({ width, height: 1600 });
      const first = cards(kind).first();
      const geometry = await first.evaluate((card) => {
        const badge = card.querySelector('.project-option-badge').getBoundingClientRect();
        const color = card.querySelector('[data-project-option-color-trigger]').getBoundingClientRect();
        const remove = card.querySelector('[data-project-option-delete]').getBoundingClientRect();
        const bounds = card.getBoundingClientRect();
        return {
          badge: { left: badge.left, right: badge.right, top: badge.top, bottom: badge.bottom },
          color: { left: color.left, right: color.right, top: color.top, bottom: color.bottom },
          remove: { left: remove.left, right: remove.right, top: remove.top, bottom: remove.bottom },
          bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, height: bounds.height },
        };
      });
      expect(geometry.color.left - geometry.badge.right).toBeGreaterThanOrEqual(12);
      expect(geometry.remove.left - geometry.color.right).toBeGreaterThanOrEqual(16);
      expect(geometry.bounds.right - geometry.remove.right).toBeLessThanOrEqual(9);
      for (const item of [geometry.badge, geometry.color, geometry.remove]) {
        expect(item.left).toBeGreaterThanOrEqual(geometry.bounds.left);
        expect(item.right).toBeLessThanOrEqual(geometry.bounds.right);
        expect(item.top).toBeGreaterThanOrEqual(geometry.bounds.top);
        expect(item.bottom).toBeLessThanOrEqual(geometry.bounds.bottom);
      }
      expect(geometry.badge.right).toBeLessThanOrEqual(geometry.color.left);
      expect(geometry.color.right).toBeLessThanOrEqual(geometry.remove.left);
      await expect(first.locator('[data-project-option-color-trigger]')).toBeEnabled();
      await expect(first.locator('[data-project-option-delete]')).toBeEnabled();
      if (width <= 375) expect(geometry.bounds.height).toBeLessThanOrEqual(48);
      return geometry;
    };
    for (const width of [1280, 375, 320]) await expectCardGeometry('status', width);

    const expectCreationRowGeometry = async (width) => {
      await page.setViewportSize({ width, height: 1600 });
      const geometries = [];
      for (const kind of ['status', 'project-type']) {
        const geometry = await region(kind).locator('[data-project-option-add-form]').evaluate((row) => {
          const input = row.querySelector('input[name="name"]').getBoundingClientRect();
          const color = row.querySelector('[data-project-option-color-trigger]').getBoundingClientRect();
          const add = row.querySelector('button[type="submit"]').getBoundingClientRect();
          const bounds = row.getBoundingClientRect();
          return {
            input: { left: input.left, right: input.right, top: input.top, bottom: input.bottom, width: input.width },
            color: { left: color.left, right: color.right, top: color.top, bottom: color.bottom },
            add: { left: add.left, right: add.right, top: add.top, bottom: add.bottom },
            bounds: { left: bounds.left, right: bounds.right, width: bounds.width },
          };
        });
        expect(geometry.input.width).toBeLessThanOrEqual(288);
        expect(geometry.input.width).toBeLessThanOrEqual(geometry.bounds.width);
        if (width === 1280) expect(geometry.input.width).toBeLessThan(geometry.bounds.width / 2);
        for (const item of [geometry.input, geometry.color, geometry.add]) {
          expect(item.left).toBeGreaterThanOrEqual(geometry.bounds.left);
          expect(item.right).toBeLessThanOrEqual(geometry.bounds.right);
        }
        expect(geometry.color.right).toBeLessThanOrEqual(geometry.add.left);
        geometries.push(geometry);
      }
      expect(Math.abs(geometries[0].input.width - geometries[1].input.width)).toBeLessThanOrEqual(1);
    };
    for (const width of [1280, 375, 320]) await expectCreationRowGeometry(width);
    await page.setViewportSize({ width: 1280, height: 1600 });
    await expect(cards('status').first()).toHaveAttribute('aria-label', /Reorder Tbd/);

    for (const kind of ['status', 'project-type']) {
      const other = kind === 'status' ? 'project-type' : 'status';
      const untouched = await order(other);
      for (const surface of ['label', 'background']) {
        await region(kind).scrollIntoViewIfNeeded();
        const original = await order(kind);
        const first = cards(kind).first();
        const source = surface === 'label' ? first.locator('.project-option-label .project-option-badge') : first;
        const target = cards(kind).nth(1);
        const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/reorder'));
        await source.dragTo(target, {
          sourcePosition: surface === 'background' ? { x: 12, y: 3 } : undefined,
          targetPosition: { x: 5, y: (await target.boundingBox()).height - 3 },
        });
        expect((await response).status()).toBe(302);
        await settled(kind);
        const expected = [original[1], original[0], ...original.slice(2)];
        expect(await order(kind)).toEqual(expected);
        expect(new URLSearchParams(posts.at(-1).postData()).getAll('orderedValues[]')).toEqual(expected);
        expect([...new URLSearchParams(posts.at(-1).postData()).keys()]).toEqual(['_csrf', ...expected.map(() => 'orderedValues[]')]);
        expect(await order(other)).toEqual(untouched);
      }

      // Chromium retargets dragstart to the draggable card: preserve the pressed control.
      const exclusions = await cards(kind).first().evaluate(card => {
        const extra = document.createElement('div');
        extra.innerHTML = '<a href="#">Link</a><input><select><option>A</option></select><textarea></textarea><button>Future control</button><span role="button" tabindex="0">Picker</span>';
        card.append(extra);
        const controls = [...card.querySelectorAll('button, a, input:not([type="hidden"]), select, textarea, [role="button"]')];
        const results = controls.map(control => {
          control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
          const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
          card.dispatchEvent(event);
          return event.defaultPrevented;
        });
        extra.remove();
        return results;
      });
      expect(exclusions.length).toBeGreaterThanOrEqual(8);
      expect(exclusions.every(Boolean)).toBe(true);
      const count = posts.length;
      const first = cards(kind).first();
      await first.locator('[data-project-option-color-trigger]').click();
      await expect(first).not.toHaveClass(/is-dragging/);
      await first.focus();
      await page.keyboard.press('Tab');
      await expect(first.locator('[data-project-option-color-trigger]')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      expect(posts.length).toBe(count);
      // Prevent only the test's destructive submit; the delete click remains operable.
      await region(kind).evaluate(node => {
        node.addEventListener('submit', event => event.preventDefault(), { once: true });
        node.querySelector('[data-project-option-delete]').addEventListener('click', () => { node.dataset.deleteClicked = 'true'; }, { once: true });
      });
      await first.locator('[data-project-option-delete]').click();
      await expect(region(kind)).toHaveAttribute('data-delete-clicked', 'true');
      expect(posts.length).toBe(count);
      await page.keyboard.press('Escape');
      await expect(page.locator('#app-confirmation-dialog')).not.toBeVisible();

      const movedId = await first.getAttribute('id');
      const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/reorder'));
      await first.focus();
      await page.keyboard.press('End');
      await response;
      await settled(kind);
      await expect(page.locator(`#${movedId}`)).toBeFocused();
      await expect(live(kind)).toContainText('moved to position');
      await expect(cards(kind).last()).toHaveAttribute('id', movedId);
      expect(await order(other)).toEqual(untouched);
    }

    // Cross-catalogue destinations have no locally active drag and cannot accept it.
    for (const kind of ['status', 'project-type']) {
      const before = await order(kind);
      const other = kind === 'status' ? 'project-type' : 'status';
      const count = posts.length;
      await cards(kind).first().dragTo(cards(other).first());
      expect(await order(kind)).toEqual(before);
      expect(posts.length).toBe(count);
    }

    // Re-enhance both the existing and externally replaced region, without duplicate posts.
    await region('status').evaluate(async node => {
      const { enhanceProjectOptionReorder } = await import('/client/settings-project-option-reorder.js');
      enhanceProjectOptionReorder(document);
      enhanceProjectOptionReorder(node);
      const parsed = new DOMParser().parseFromString(await (await fetch('/settings/defaults')).text(), 'text/html');
      const next = parsed.querySelector('[data-settings-project-option-editor="status"]');
      node.replaceWith(next);
      enhanceProjectOptionReorder(next);
      enhanceProjectOptionReorder(next);
    });
    let count = posts.length;
    let response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/reorder'));
    await cards('status').last().focus();
    await page.keyboard.press('Home');
    await response;
    await settled('status');
    expect(posts.length).toBe(count + 1);

    // Validation returns authoritative markup even when the server catalogue changed.
    const baseline = read('status');
    app.locals.projectOptionCatalogueService.addOption('status', { name: 'New concurrent option', color: '#123456' });
    response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/reorder'));
    await cards('status').first().focus();
    await page.keyboard.press('ArrowDown');
    expect((await response).status()).toBe(422);
    await settled('status');
    expect(await order('status')).toEqual([...baseline, 'new-concurrent-option']);
    await expect(region('status').locator('[data-project-option-feedback]')).toBeVisible();

    // Network failure and malformed success both restore the last confirmed order.
    for (const failure of ['network', 'malformed']) {
      const before = await order('status');
      const focusedId = await cards('status').first().getAttribute('id');
      await page.route('**/project-options/status/reorder', route => failure === 'network'
        ? route.abort()
        : route.fulfill({ status: 302, headers: { location: '/malformed-option-response' } }));
      await page.route('**/malformed-option-response', route => route.fulfill({ status: 200, body: '<p>Missing catalogue</p>' }));
      await cards('status').first().focus();
      await page.keyboard.press('ArrowDown');
      await expect(live('status')).toContainText('previous order was restored');
      expect(await order('status')).toEqual(before);
      await expect(page.locator(`#${focusedId}`)).toBeFocused();
      await page.unrouteAll();
    }
    // A failed save does not strand the adapter in its pending state.
    response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/reorder'));
    await cards('status').last().focus();
    await page.keyboard.press('ArrowUp');
    expect((await response).status()).toBe(302);
    await settled('status');
    expect(errors).toEqual([]);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
