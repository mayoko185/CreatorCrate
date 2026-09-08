import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

for (const javaScriptEnabled of [false, true]) {
  test(`New Book native empty cover succeeds (JavaScript=${javaScriptEnabled})`, async ({ browser }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-optional-cover-'));
    const db = openDatabase(':memory:');
    let server, context;
    try {
      const projectsRoot = path.join(root, 'projects');
      const appDataRoot = path.join(root, 'app');
      fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
      runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
      const { csrfPepper } = ensureAuthEnablement(appDataRoot);
      const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
      server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      context = await browser.newContext({ javaScriptEnabled });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/notes`);
      await page.getByRole('link', { name: 'New Book', exact: true }).first().click();
      const dialog = page.locator('#book-create-dialog');
      await expect(dialog).toBeVisible();
      await dialog.locator('[name="title"]').fill('Native optional cover');
      const response = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith('/notes/books'));
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      const submitted = await response;
      expect(submitted.status()).toBe(302);
      expect(submitted.request().postDataBuffer().toString()).toContain('filename=""\r\nContent-Type: application/octet-stream');
      await expect(page).toHaveURL(/\/notes\/books\/\d+$/);
      expect(db.prepare('SELECT title FROM books').all()).toEqual([{ title: 'Native optional cover' }]);
      expect(db.prepare('SELECT * FROM managed_assets').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM book_primary_images').all()).toEqual([]);
      expect(app.locals.managedUploadTracker.hasActive()).toBe(false);
    } finally {
      await context?.close();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      closeDatabase(db);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
