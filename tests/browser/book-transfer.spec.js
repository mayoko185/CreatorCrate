import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

test('Book transfer stays explicit, reports outcomes, and refreshes from canonical Notes authority', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-transfer-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const first = app.locals.bookService.createBook({ title: 'First Book' });
    const second = app.locals.bookService.createBook({ title: 'Second Book' });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base + '/notes');

    const opener = page.getByRole('button', { name: 'Import/Export Books', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Import/Export Books', exact: true });
    await opener.click();
    await expect(dialog).toBeVisible();
    await dialog.locator('.app-dialog-body').click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    await opener.click();
    await dialog.click({ position: { x: 1, y: 1 } });
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    await opener.click();
    await dialog.getByRole('button', { name: 'Close Import/Export Books' }).click();
    await expect(opener).toBeFocused();
    await opener.click();

    await dialog.getByRole('button', { name: 'Close Import/Export Books' }).click();
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    const orderDialog = page.getByRole('dialog', { name: 'Change book order', exact: true });
    await orderDialog.locator('[data-book-reorder-handle]').first().press('End');
    await expect(orderDialog.locator('[data-book-reorder-status]')).toHaveText('Book order saved.');
    await orderDialog.getByRole('button', { name: 'Close Change book order' }).click();
    await opener.click();

    const choices = dialog.locator('[data-book-export-choice]');
    await expect(choices).toHaveCount(2);
    expect(await choices.evaluateAll((nodes) => nodes.map((node) => node.value)))
      .toEqual([String(second.id), String(first.id)]);
    await expect(dialog.getByText('First Book', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Second Book', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Export selected' }).click();
    await expect(dialog.locator('[data-book-export-status]')).toHaveText('Select at least one Book to export.');

    let exportRequests = 0;
    const exportBodies = [];
    const exportContentTypes = [];
    await page.route('**/notes/books/export', async (route) => {
      exportRequests += 1;
      exportBodies.push(route.request().postData() || '');
      exportContentTypes.push(route.request().headers()['content-type'] || '');
      if (exportRequests === 1) {
        await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({
          status: 'error', code: 'INVALID_BOOKS', message: 'The selected Books are unavailable.',
        }) });
        return;
      }
      await route.continue();
    });
    const selectAll = dialog.getByRole('button', { name: 'Select all' });
    await selectAll.click();
    await expect(choices).toHaveCount(2);
    await expect(choices.nth(0)).toBeChecked();
    await expect(choices.nth(1)).toBeChecked();
    await expect(selectAll).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Export selected' }).click();
    await expect(dialog.locator('[data-book-export-status]')).toHaveText('The selected Books are unavailable.');
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export selected' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('creatorcrate-books.zip');
    const initialExport = new URLSearchParams(exportBodies[1]);
    const initialToken = await dialog.locator('[data-book-export-form] input[name="_csrf"]').inputValue();
    expect(exportContentTypes[1]).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect(initialExport.get('_csrf')).toBe(initialToken);
    expect(initialExport.getAll('bookIds')).toEqual([String(second.id), String(first.id)]);
    await expect(dialog.locator('[data-book-export-status]')).toHaveText('Book export download started.');
    await expect(dialog).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/notes');

    await dialog.locator('[data-book-export-form] input[name="_csrf"]').evaluate((input) => {
      input.value = 'stale-replaced-token';
    });

    const fileInput = dialog.locator('[data-book-import-archive]');
    const importButton = dialog.getByRole('button', { name: 'Import books' });
    let importRequests = 0;
    const importBodies = [];
    const importBodyBuffers = [];
    const importContentTypes = [];
    let failNextRefresh = true;
    let imported;
    await page.route('**/notes/books/import', async (route) => {
      importRequests += 1;
      importBodies.push(route.request().postData() || '');
      importBodyBuffers.push(route.request().postDataBuffer() || Buffer.alloc(0));
      importContentTypes.push(route.request().headers()['content-type'] || '');
      if (importRequests === 1) {
        await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({
          success: false, code: 'INVALID_ARCHIVE', message: 'This is not a CreatorCrate Books archive.',
        }) });
        return;
      }
      imported = app.locals.bookService.createBook({ title: 'Book-1' });
      await new Promise((resolve) => setTimeout(resolve, 75));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        success: true,
        importedBookCount: 1,
        destinationBookIds: [imported.id],
        refreshUrl: '/notes',
        books: [{
          sourceTitle: 'Book', destinationBookId: imported.id, destinationTitle: 'Book-1', renamed: true,
          coverOutcome: { kind: 'managed', sourceKind: 'project_asset', relinked: false },
        }],
        associations: {
          unresolvedProjectLocators: [{ locator: { slug: 'missing-project' } }],
          unresolvedAssetLocators: [{ locator: { project: { slug: 'missing-project' }, relativePath: 'art/cover.png' } }],
          historicalUnresolvedProjectCount: 1,
          historicalUnresolvedAssetCount: 0,
        },
        activity: { recorded: false, warning: 'activity_not_recorded' },
      }) });
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() === 'GET' && failNextRefresh) {
        failNextRefresh = false;
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'refresh failed' });
      } else await route.continue();
    });

    await importButton.click();
    await expect(dialog.locator('[data-book-import-status]')).toHaveText('Choose one CreatorCrate Books ZIP to import.');
    await fileInput.setInputFiles({ name: 'books.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture') });
    await page.waitForTimeout(50);
    expect(importRequests).toBe(0);
    await importButton.click();
    await expect(dialog.locator('[data-book-import-status]')).toHaveText('This is not a CreatorCrate Books archive.');
    await expect(fileInput).toHaveValue(/books\.zip$/);
    expect(importContentTypes[0]).toMatch(/^multipart\/form-data; boundary=/);
    expect(importBodies[0]).toContain('name="_csrf"');
    expect(importBodies[0]).toContain('name="archive"; filename="books.zip"');
    expect(importBodyBuffers[0].includes(Buffer.from('fixture'))).toBe(true);

    await dialog.locator('[data-book-import-form]').evaluate((form) => {
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });
    await expect(importButton).toBeDisabled();
    await expect(fileInput).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close Import/Export Books' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    await expect(page.locator('#book-transfer-dialog [data-book-import-status]')).toHaveText('Books imported, but page refresh failed.');
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(dialog.getByRole('button', { name: 'Retry refresh' })).toBeVisible();
    expect(importRequests).toBe(2);
    await expect(dialog.getByText('1 Book imported.')).toBeVisible();
    await expect(dialog.getByText('Book → Book-1')).toBeVisible();
    await expect(dialog.getByText(/Project cover source could not be relinked/)).toBeVisible();
    await expect(dialog.getByText(/2 portable associations were not relinked/)).toBeVisible();
    await expect(dialog.getByText(/1 historical unresolved association had no portable source locator/)).toBeVisible();
    await expect(dialog.getByText(/activity logging was not recorded/)).toBeVisible();
    await expect(dialog.locator('[data-book-import-status]')).toHaveText('Books imported, but page refresh failed.');

    await dialog.getByRole('button', { name: 'Retry refresh' }).click();
    await expect(dialog.locator('[data-book-import-status]')).toHaveText('Books imported and shelf refreshed.');
    expect(importRequests).toBe(2);
    await expect(page.locator('[data-notes-books-live-region] .notes-book-card-title', { hasText: 'Book-1' })).toBeVisible();
    await expect(dialog.locator('[data-book-export-choice]')).toHaveCount(3);
    await expect(dialog.getByLabel('Book-1', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Import books' })).toBeFocused();
    expect(importContentTypes[1]).toMatch(/^multipart\/form-data; boundary=/);
    expect(importBodies[1]).toContain('name="_csrf"');
    expect(importBodies[1]).toContain(initialToken);

    const replacementToken = await dialog.locator('[data-book-export-form] input[name="_csrf"]').inputValue();
    expect(replacementToken).toBe(initialToken);
    expect(replacementToken).not.toBe('stale-replaced-token');
    await dialog.getByLabel('Book-1', { exact: true }).check();
    const refreshedDownloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export selected' }).click();
    const refreshedDownload = await refreshedDownloadPromise;
    expect(refreshedDownload.suggestedFilename()).toBe('creatorcrate-books.zip');
    const refreshedExport = new URLSearchParams(exportBodies[2]);
    expect(exportContentTypes[2]).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect(refreshedExport.get('_csrf')).toBe(replacementToken);
    expect(refreshedExport.getAll('bookIds')).toEqual([String(imported.id)]);
    await expect(dialog.locator('[data-book-export-status]')).toHaveText('Book export download started.');
    await expect(dialog).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/notes');

    await dialog.getByRole('button', { name: 'Close Import/Export Books' }).click();
    await opener.click();
    await expect(dialog.getByLabel('Book-1', { exact: true })).toBeVisible();
    expect(importRequests).toBe(2);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await dialog.getByRole('button', { name: 'Close Import/Export Books' }).click();
      await opener.focus();
      const geometry = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollX: window.scrollX,
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      expect(geometry.scrollX).toBe(0);
      await opener.click();
    }
    expect(errors).toEqual([]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('empty Notes shelf gains its first exportable Book after import without navigation', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-transfer-empty-'));
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
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/notes');
    await page.getByRole('button', { name: 'Import/Export Books', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import/Export Books', exact: true });
    await expect(dialog.getByText('No Books are available to export.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Export selected' })).toBeDisabled();

    let importPosts = 0;
    await page.route('**/notes/books/import', async (route) => {
      importPosts += 1;
      const imported = app.locals.bookService.createBook({ title: 'First Imported Book' });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        success: true,
        importedBookCount: 1,
        destinationBookIds: [imported.id],
        refreshUrl: '/notes',
        books: [{
          sourceTitle: imported.title, destinationBookId: imported.id,
          destinationTitle: imported.title, renamed: false, coverOutcome: { kind: 'none' },
        }],
        associations: {
          unresolvedProjectLocators: [], unresolvedAssetLocators: [],
          historicalUnresolvedProjectCount: 0, historicalUnresolvedAssetCount: 0,
        },
        activity: { recorded: true },
      }) });
    });
    await dialog.locator('[data-book-import-archive]').setInputFiles({
      name: 'books.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture'),
    });
    expect(importPosts).toBe(0);
    await dialog.getByRole('button', { name: 'Import books' }).click();
    await expect(dialog.locator('[data-book-import-status]')).toHaveText('Books imported and shelf refreshed.');
    expect(importPosts).toBe(1);
    expect(new URL(page.url()).pathname).toBe('/notes');
    await expect(page.locator('[data-notes-books-live-region] .notes-book-card-title')).toHaveText('First Imported Book');
    await expect(dialog.getByLabel('First Imported Book', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Export selected' })).toBeEnabled();
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real WP6 archives survive in-flight disabling before and after canonical replacement', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-transfer-real-import-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Portable Book' });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await page.goto(`http://127.0.0.1:${server.address().port}/notes`);

    await page.getByRole('button', { name: 'Import/Export Books', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import/Export Books', exact: true });
    await dialog.getByRole('button', { name: 'Select all' }).click();
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export selected' }).click();
    const download = await downloadPromise;
    const archiveBytes = fs.readFileSync(await download.path());

    const importRequests = [];
    await page.route('**/notes/books/import', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/notes/books/import') return;
      importRequests.push({
        contentType: request.headers()['content-type'] || '',
        body: request.postDataBuffer() || Buffer.alloc(0),
      });
      await route.continue();
    });

    const archiveInput = dialog.locator('[data-book-import-archive]');
    const importButton = dialog.getByRole('button', { name: 'Import books' });
    const currentToken = () => dialog.locator('[data-book-import-form] input[name="_csrf"]').inputValue();
    const selectArchive = () => archiveInput.setInputFiles({
      name: 'creatorcrate-books.zip', mimeType: 'application/zip', buffer: archiveBytes,
    });

    const initialToken = await currentToken();
    await selectArchive();
    await expect(archiveInput).toHaveValue(/creatorcrate-books\.zip$/);
    expect(importRequests).toHaveLength(0);
    await importButton.click();
    await expect(dialog.locator('[data-book-import-status]')).toHaveText('Books imported and shelf refreshed.');
    await expect(page.locator('[data-notes-books-live-region] .notes-book-card-title')).toHaveCount(2);
    await expect(dialog.locator('[data-book-export-choice]')).toHaveCount(2);
    expect(importRequests).toHaveLength(1);
    expect(importRequests[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(importRequests[0].body.toString('latin1')).toContain('name="_csrf"');
    expect(importRequests[0].body.toString('latin1')).toContain(initialToken);
    expect(importRequests[0].body.toString('latin1')).toContain('name="archive"; filename="creatorcrate-books.zip"');
    expect(importRequests[0].body.includes(archiveBytes)).toBe(true);

    const replacementToken = await currentToken();
    await selectArchive();
    await importButton.click();
    await expect(dialog.locator('[data-book-import-status]')).toHaveText('Books imported and shelf refreshed.');
    await expect(page.locator('[data-notes-books-live-region] .notes-book-card-title')).toHaveCount(3);
    await expect(dialog.locator('[data-book-export-choice]')).toHaveCount(3);
    expect(importRequests).toHaveLength(2);
    expect(importRequests[1].body.toString('latin1')).toContain(replacementToken);
    expect(importRequests[1].body.toString('latin1')).toContain('name="archive"; filename="creatorcrate-books.zip"');
    expect(importRequests[1].body.includes(archiveBytes)).toBe(true);

    await archiveInput.setInputFiles({
      name: 'malformed.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip'),
    });
    await importButton.click();
    await expect(dialog.locator('[data-book-import-status]')).toHaveText('The supplied file is not a valid ZIP archive.');
    expect(importRequests).toHaveLength(3);
    expect(importRequests[2].body.toString('latin1')).toContain('name="archive"; filename="malformed.zip"');
    expect(importRequests[2].body.toString('latin1')).not.toContain('A Book transfer archive is required.');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
