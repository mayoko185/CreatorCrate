import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// Playwright's default headless shell launches with the back/forward cache
// disabled; the full Chromium build with it enabled exercises real restores.
test.use({ channel: 'chromium', launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] } });

// Playwright's default headless shell launches with the back/forward cache
// disabled; the full Chromium build with it enabled exercises real restores.
test.use({ channel: 'chromium', launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] } });

test('Export logs downloads every matching entry without disturbing the Logs page', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-logs-export-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const repository = app.locals.applicationLogRepository;
    repository.clear();
    for (let index = 0; index < 40; index += 1) {
      repository.insert({
        occurredAtMs: Date.now() - (40 - index) * 1000, level: 'warn', kind: 'diagnostic',
        subsystem: 'settings', event: `export.match-${index}`, message: 'Matching entry.', context: {},
      });
    }
    repository.insert({
      occurredAtMs: Date.now(), level: 'info', kind: 'activity',
      subsystem: 'settings', event: 'export.filtered-out', message: 'Other level.', context: {},
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const exportRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/settings/logs/export') exportRequests.push(request.url());
    });

    const logsUrl = `${base}/settings/logs?level=warn&pageSize=25&page=2`;
    await page.goto(logsUrl);
    const exportButton = page.getByRole('button', { name: 'Export logs', exact: true });
    const status = page.locator('[data-logs-export-status]');
    await expect(exportButton).toBeVisible();
    await expect(exportButton).toHaveAccessibleDescription(/Exports all matching entries across pages\. Review before sharing\./);
    await expect(page.getByText('Page 2 of 2')).toBeVisible();

    await exportButton.focus();
    const downloadPromise = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^creatorcrate-logs-\d{8}T\d{6}Z\.txt$/);
    const text = fs.readFileSync(await download.path(), 'utf8');
    expect(text).toContain('Entries exported: 40');
    expect(text).toContain('Event: export.match-0\n');
    expect(text).toContain('Event: export.match-39\n');
    expect(text).not.toContain('export.filtered-out');
    await expect(status).toHaveText('Logs export download started.');
    await expect(exportButton).toBeFocused();
    expect(exportRequests).toHaveLength(1);
    const exportQuery = new URL(exportRequests[0]).searchParams;
    expect([...exportQuery.entries()]).toEqual([['level', 'warn'], ['kind', ''], ['subsystem', ''], ['time', '']]);
    expect(page.url()).toBe(logsUrl);
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(page.locator('[data-log-id]')).toHaveCount(15);

    // Repeated activation while a request is pending issues one request only.
    let releaseExport;
    const held = new Promise((resolve) => { releaseExport = resolve; });
    await page.route('**/settings/logs/export?*', async (route) => {
      await held;
      await route.continue();
    });
    exportRequests.length = 0;
    const secondDownload = page.waitForEvent('download');
    await exportButton.click();
    await expect(status).toHaveText('Preparing logs export…');
    await expect(exportButton).toHaveAttribute('aria-disabled', 'true');
    await expect(exportButton).toBeFocused();
    await exportButton.click({ force: true });
    await page.keyboard.press('Enter');
    releaseExport();
    await secondDownload;
    await expect(status).toHaveText('Logs export download started.');
    expect(exportRequests).toHaveLength(1);
    await page.unroute('**/settings/logs/export?*');

    // Controlled JSON failures and HTML bodies are reported, never saved.
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    await page.route('**/settings/logs/export?*', (route) => route.fulfill({
      status: 422,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ status: 'error', code: 'EXPORT_TOO_LARGE', message: 'The logs export would be larger than 20 MiB. Narrow the filters and try again.' }),
    }));
    await exportButton.click();
    await expect(status).toHaveText('The logs export would be larger than 20 MiB. Narrow the filters and try again.');
    await page.unroute('**/settings/logs/export?*');
    await page.route('**/settings/logs/export?*', (route) => route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Sign in</title>',
    }));
    await exportButton.click();
    await expect(status).toHaveText('Logs export failed. Try again.');
    await page.unroute('**/settings/logs/export?*');
    expect(downloads).toBe(0);

    // Back/forward cache: leaving with an export in flight cancels it, and the
    // restored page exports again with one request per activation.
    const holdExports = async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      await page.route('**/settings/logs/export?*', async (route) => {
        await gate;
        await route.continue().catch(() => {});
      });
      return release;
    };
    const leaveAndRestore = async () => {
      await page.evaluate(() => {
        window.__logsDocumentMarker = true;
        window.__logsRestoredFromCache = false;
        window.addEventListener('pageshow', (event) => {
          if (event.persisted) window.__logsRestoredFromCache = true;
        }, { once: true });
      });
      await page.goto(`${base}/settings/backups`);
      // A cache restore fires pageshow, not load.
      await page.goBack({ waitUntil: 'commit' });
      await expect(page).toHaveURL(logsUrl);
      await expect.poll(() => page.evaluate(() => [window.__logsDocumentMarker, window.__logsRestoredFromCache])).toEqual([true, true]);
    };
    const expectLogsPageState = async () => {
      expect(page.url()).toBe(logsUrl);
      await expect(page.getByText('Page 2 of 2')).toBeVisible();
      await expect(page.locator('[data-log-id]')).toHaveCount(15);
      await expect(page.locator('[data-logs-filter-form] [name="level"]:checked')).toHaveValue('warn');
    };
    const expectRestoredIdle = async () => {
      await expect(exportButton).toBeVisible();
      await expect(exportButton).not.toHaveAttribute('aria-disabled', /.*/);
      await expect(status).toHaveText('');
      await expectLogsPageState();
    };
    const exportOnce = async (activate) => {
      exportRequests.length = 0;
      const downloadPromise = page.waitForEvent('download');
      await activate();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/^creatorcrate-logs-\d{8}T\d{6}Z\.txt$/);
      await expect(status).toHaveText('Logs export download started.');
      expect(exportRequests).toHaveLength(1);
    };

    // Chromium keeps a no-store page in the cache only until script receives a
    // no-store response, so restores start from a fresh load and successful
    // exports come last, matching the reported Logs → Settings → Back path.
    await page.goto(logsUrl);
    downloads = 0;
    for (let trip = 0; trip < 2; trip += 1) {
      const releaseHeld = await holdExports();
      exportRequests.length = 0;
      await exportButton.click();
      await expect(status).toHaveText('Preparing logs export…');
      await expect(exportButton).toHaveAttribute('aria-disabled', 'true');
      expect(exportRequests).toHaveLength(1);
      await leaveAndRestore();
      releaseHeld();
      await page.unroute('**/settings/logs/export?*');
      await expectRestoredIdle();
      await page.waitForTimeout(250);
      expect(downloads).toBe(0);
      await expect(status).toHaveText('');
    }

    await exportOnce(() => exportButton.click());
    await exportOnce(async () => { await exportButton.focus(); await page.keyboard.press('Enter'); });
    await exportOnce(async () => { await exportButton.focus(); await page.keyboard.press('Space'); });
    expect(downloads).toBe(3);
    await expectLogsPageState();

    // Narrow screens keep the toolbar and warning without horizontal scrolling.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(exportButton).toBeVisible();
    await expect(page.locator('#logs-export-help')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await new Promise((resolve) => server ? server.close(resolve) : resolve());
    try { closeDatabase(db); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
