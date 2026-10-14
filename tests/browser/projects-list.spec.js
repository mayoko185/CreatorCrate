import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

async function withProjectsApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-projects-list-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const active = app.locals.projectService.create({
      title: 'Active List Project With A Deliberately Long Title For Truncation',
      status: 'ready',
    });
    const archived = app.locals.projectService.create({ title: 'Archived List Project', status: 'ready' });
    db.prepare("UPDATE projects SET status = 'archived', archived_at = '2026-01-02 00:00:00' WHERE id = ?").run(archived.id);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, activeId: active.id, archivedId: archived.id });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const TITLE_BOUND = '[data-dashboard-title-info-bound="true"]';

// Hovering the sidebar expands it over the content, so "away" is the top-right corner.
async function moveAway(page) {
  const { width } = page.viewportSize();
  await page.mouse.move(width - 4, 4, { steps: 5 });
}

function currentPath(page) {
  const url = new URL(page.url());
  return url.pathname + url.search;
}

function listParts(page, projectId) {
  const row = page.locator(`tr[data-project-id="${projectId}"]`);
  return {
    row,
    title: row.locator('[data-calendar-info-trigger]'),
    card: page.locator(`#projects-list-info-${projectId}`),
  };
}

test('Projects List renders aligned columns and the shared hover/pin information card', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });

  await withProjectsApp(async ({ origin, activeId }) => {
    await page.goto(`${origin}/projects?view=list`);
    await page.locator(TITLE_BOUND).first().waitFor({ state: 'attached' });
    await expect(page.locator('.projects-list-table thead th')).toHaveText(
      ['Project', 'Status', 'Type', 'Assets', 'Updated'],
    );
    await expect(page.locator('.projects-list-table tbody tr').first().locator('td')).toHaveCount(5);
    await expect(page.locator('.projects-list-table tbody tr a:visible, .projects-list-table tbody tr .button:visible')).toHaveCount(0);
    const { row, title, card } = listParts(page, activeId);
    const thumb = row.locator('.projects-list-thumb');
    expect(await thumb.evaluate((node) => [node.offsetWidth, node.offsetHeight])).toEqual([48, 48]);
    expect(await title.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await row.evaluate((node) => getComputedStyle(node).transform)).toBe('none');

    // Transient hover follows the pointer and closes when it leaves.
    const titleBox = await title.boundingBox();
    await page.mouse.move(titleBox.x + 4, titleBox.y + 3, { steps: 4 });
    await expect(card).toBeVisible();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    const hoverBox = await card.boundingBox();
    await page.mouse.move(titleBox.x + titleBox.width - 4, titleBox.y + titleBox.height - 3, { steps: 6 });
    await expect.poll(async () => (await card.boundingBox()).x !== hoverBox.x).toBe(true);
    await moveAway(page);
    await expect(card).toBeHidden();
    await expect(title).toHaveAttribute('aria-expanded', 'false');

    // A click pins the card; clicks inside it neither close it nor navigate the row.
    await title.click();
    await expect(card).toBeVisible();
    await moveAway(page);
    await expect(card).toBeVisible();
    await card.locator('.asset-viewer-grid-card-info-heading').click();
    await expect(card).toBeVisible();
    expect(currentPath(page)).toBe('/projects?view=list');

    // Clicking the pinned title again, an outside click, and Escape all dismiss.
    await title.click();
    await expect(card).toBeHidden();
    await title.click();
    await expect(card).toBeVisible();
    await page.locator('.results-meta').click();
    await expect(card).toBeHidden();
    await title.click();
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(title).toBeFocused();

    // Keyboard activation pins as well, and the card's Open action navigates.
    await page.keyboard.press('Enter');
    await expect(card).toBeVisible();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    await card.getByRole('link', { name: 'Open project' }).click();
    await expect.poll(() => currentPath(page)).toBe(`/projects/${activeId}`);
  });
  expect(pageErrors).toEqual([]);
});

test('Projects List rows navigate from the background and offer Edit only for non-archived projects', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProjectsApp(async ({ origin, activeId, archivedId }) => {
    await page.goto(`${origin}/projects?view=list&status=ready&status=archived`);
    await page.locator(TITLE_BOUND).first().waitFor({ state: 'attached' });

    const archived = listParts(page, archivedId);
    await archived.title.click();
    await expect(archived.card.getByRole('link', { name: 'Open project' })).toBeVisible();
    await expect(archived.card.getByRole('link', { name: 'Edit project' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    const active = listParts(page, activeId);
    await active.row.locator('td').nth(1).click();
    await expect.poll(() => currentPath(page)).toBe(`/projects/${activeId}`);
  });
});

test('Projects List Edit opens the hosted Edit Project dialog and Cancel, errors and Save keep the list context', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProjectsApp(async ({ origin, activeId }) => {
    const listPath = '/projects?view=list&status=ready&sort=title&order=asc';
    const openEdit = async () => {
      const { title, card } = listParts(page, activeId);
      await title.click();
      await expect(card).toBeVisible();
      await card.getByRole('link', { name: 'Edit project' }).click();
      const dialog = page.locator('#project-edit-dialog');
      await expect(dialog).toBeVisible();
      expect(new URL(page.url()).searchParams.get('returnTo')).toBe(listPath);
      return dialog;
    };
    await page.goto(origin + listPath);
    await page.locator(TITLE_BOUND).first().waitFor({ state: 'attached' });

    // Cancel closes the dialog and returns to the exact list location.
    let dialog = await openEdit();
    await dialog.getByRole('button', { name: 'Close Edit Project' }).click();
    await expect.poll(() => currentPath(page)).toBe(listPath);
    await page.locator(TITLE_BOUND).first().waitFor({ state: 'attached' });

    // Validation errors stay in the dialog with the list return preserved.
    dialog = await openEdit();
    await dialog.locator('#title').fill('');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('#project-edit-dialog')).toBeVisible();
    await expect(page.locator('#project-edit-dialog #title')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#project-edit-dialog input[name="returnTo"]')).toHaveValue(listPath);

    // Save persists and lands back on the same list, showing the edit.
    await page.locator('#project-edit-dialog #title').fill('Renamed From The List');
    await page.locator('#project-edit-dialog').getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => currentPath(page)).toBe(listPath);
    await expect(listParts(page, activeId).title).toHaveText('Renamed From The List');
  });
});

test('Projects List information cards work after live replacement and Back/Forward', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProjectsApp(async ({ origin, activeId }) => {
    await page.goto(`${origin}/projects?view=grid`);
    await page.evaluate(() => { window.__projectsListMarker = true; });

    await page.getByRole('link', { name: 'List view' }).click();
    await expect(page.locator('[data-projects-list-table]')).toBeVisible();
    expect(await page.evaluate(() => window.__projectsListMarker)).toBe(true);
    await expect.poll(() => currentPath(page)).toBe('/projects?view=list');

    const { title, card } = listParts(page, activeId);
    await title.click();
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');

    await page.goBack();
    await expect(page.locator('.project-grid')).toBeVisible();
    await page.goForward();
    await expect(page.locator('[data-projects-list-table]')).toBeVisible();
    const replayed = listParts(page, activeId);
    await replayed.title.click();
    await expect(replayed.card).toBeVisible();
    expect(await page.evaluate(() => window.__projectsListMarker)).toBe(true);
  });
});

test('Projects List keeps aligned columns with horizontal scrolling at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await withProjectsApp(async ({ origin, activeId }) => {
    await page.goto(`${origin}/projects?view=list`);
    await page.locator(TITLE_BOUND).first().waitFor({ state: 'attached' });
    const scroller = page.locator('.projects-list-scroll');
    expect(await scroller.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const { row, title, card } = listParts(page, activeId);
    expect(await row.evaluate((node) => getComputedStyle(node).display)).toBe('table-row');
    await title.click();
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box.x >= 0 && box.x + box.width <= 375).toBe(true);
  });
});
