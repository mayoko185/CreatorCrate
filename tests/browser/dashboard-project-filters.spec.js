import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

async function withDashboardApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-filters-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const catalogue = app.locals.projectOptionCatalogueService;
    catalogue.addOption('status', { name: 'Editorial Review', color: '#123456' });
    const statuses = catalogue.getStatusCatalogue().map(({ value }) => value).filter((value) => value !== 'archived');
    const [firstStatus, secondStatus] = statuses;
    const projects = app.locals.projectService;
    projects.create({ title: 'First A', status: firstStatus });
    projects.create({ title: 'First B', status: firstStatus });
    projects.create({ title: 'Review C', status: 'editorial-review' });
    const emptyStatus = statuses.find((value) => ![firstStatus, 'editorial-review'].includes(value));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, firstStatus, secondStatus, emptyStatus });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const BOUND = '[data-dashboard-status-filters][data-dashboard-status-filters-bound="true"]';

function tab(page, value) {
  return page.locator(`[data-dashboard-status-filter="${value}"]`);
}

test('filters the complete projects table in place by status', async ({ page }) => {
  await withDashboardApp(async ({ origin, firstStatus, emptyStatus }) => {
    await page.goto(`${origin}/`);
    await page.locator(BOUND).waitFor({ state: 'attached' });
    const startUrl = page.url();
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));

    const rows = page.locator('[data-dashboard-project-row]');
    const visibleRows = page.locator('[data-dashboard-project-row]:visible');
    const count = page.locator('[data-dashboard-projects-count]');
    const empty = page.locator('[data-dashboard-projects-filter-empty]');

    await expect(tab(page, 'all')).toBeEnabled();
    await expect(tab(page, 'all')).toHaveAttribute('aria-pressed', 'true');
    await expect(visibleRows).toHaveCount(3);

    await tab(page, firstStatus).click();
    await expect(tab(page, firstStatus)).toHaveAttribute('aria-pressed', 'true');
    await expect(tab(page, 'all')).toHaveAttribute('aria-pressed', 'false');
    await expect(visibleRows).toHaveCount(2);
    await expect(count).toHaveText('2 of 3 active projects · archived hidden');

    await tab(page, 'editorial-review').click();
    await expect(visibleRows).toHaveCount(1);
    await expect(visibleRows.first()).toContainText('Review C');
    await expect(count).toHaveText('1 of 3 active projects · archived hidden');

    await tab(page, emptyStatus).click();
    await expect(visibleRows).toHaveCount(0);
    await expect(page.locator('#dashboard-projects-table')).toBeHidden();
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText('No projects match this status.');
    await expect(count).toHaveText('0 of 3 active projects · archived hidden');
    await expect(tab(page, 'all')).toBeEnabled();

    await tab(page, 'all').click();
    await expect(empty).toBeHidden();
    await expect(visibleRows).toHaveCount(3);
    await expect(rows).toHaveCount(3);
    await expect(count).toHaveText('3 of 3 active projects · archived hidden');
    await expect(page.locator('[data-dashboard-status-filter][aria-pressed="true"]')).toHaveCount(1);

    expect(page.url()).toBe(startUrl);
    expect(requests).toEqual([]);
  });
});

test('keeps the status filters usable at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await withDashboardApp(async ({ origin, firstStatus }) => {
    await page.goto(`${origin}/`);
    await page.locator(BOUND).waitFor({ state: 'attached' });
    await tab(page, firstStatus).click();
    await expect(page.locator('[data-dashboard-project-row]:visible')).toHaveCount(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
