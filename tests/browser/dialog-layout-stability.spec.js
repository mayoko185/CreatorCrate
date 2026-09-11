import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

test.use({
  launchOptions: {
    ignoreDefaultArgs: ['--hide-scrollbars'],
  },
});

test('keeps the page horizontally stable while a shared dialog locks background scrolling', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dialog-layout-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
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
    await new Promise((resolve) => server.once('listening', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto(`${baseURL}/projects`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.body.style.minHeight = '200vh';
      window.scrollTo(0, 100);
    });

    const landmark = page.locator('main#main-content');
    const dialog = page.locator('#project-create-dialog');
    const measureLayout = () => landmark.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        width: rect.width,
        scrollY: window.scrollY,
        scrollbarWidth: window.innerWidth - document.documentElement.clientWidth,
      };
    });
    const expectStable = (first, second) => {
      expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
    };

    const before = await measureLayout();
    expect(before.scrollbarWidth).toBeGreaterThan(0);
    expect(before.scrollY).toBeGreaterThan(0);

    await page.getByRole('link', { name: 'New Project', exact: true }).first().click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/app-dialog-open/);
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

    const open = await measureLayout();
    expectStable(before, open);
    expect(open.scrollY).toBe(before.scrollY);

    await page.mouse.move(5, 5);
    await page.mouse.wheel(0, 400);
    expect((await measureLayout()).scrollY).toBe(open.scrollY);

    const dialogBody = dialog.locator('.app-dialog-body');
    const dialogScroll = await dialogBody.evaluate((element) => {
      const initial = element.scrollTop;
      element.scrollTop = element.scrollHeight;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        initial,
        after: element.scrollTop,
      };
    });
    expect(dialogScroll.scrollHeight).toBeGreaterThan(dialogScroll.clientHeight);
    expect(dialogScroll.after).toBeGreaterThan(dialogScroll.initial);

    await dialog.getByRole('button', { name: 'Close New Project', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

    const after = await measureLayout();
    expectStable(open, after);
    expect(after.scrollY).toBe(open.scrollY);

    await page.mouse.move(5, 5);
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => (await measureLayout()).scrollY).toBeGreaterThan(after.scrollY);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
