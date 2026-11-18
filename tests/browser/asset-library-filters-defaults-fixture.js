import { expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../../src/services/page-defaults-service.js';

/*
 * WP9b — shared isolated fixture for the Asset Library Filters & Defaults
 * Chromium acceptance specs. One real app per spec file on a temporary
 * SQLite/filesystem root (removed afterwards). Projects carry real catalogue
 * Project Types; every image is a real PNG/JPEG scanned by the real scanner.
 */

export const DIALOG = '#asset-viewer-filter-dialog';
export const NINE = Object.freeze(['view', 'gridStyle', 'sort', 'order', 'pageSize', 'extension', 'category', 'presence', 'tag']);
export const TEMPORARY = Object.freeze(['project', 'type', 'search', 'usage']);

export function createLibraryFixture(label) {
  const state = {};

  async function start() {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), `creatorcrate-${label}-`));
    state.projectsRoot = path.join(state.root, 'projects');
    const appDataRoot = path.join(state.root, 'app');
    fs.mkdirSync(state.projectsRoot);
    fs.mkdirSync(appDataRoot);
    state.db = openDatabase(path.join(state.root, 'test.db'));
    runMigrations(state.db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    state.app = createApp(
      { appName: 'CreatorCrate', db: state.db, projectsRoot: state.projectsRoot, previewRoot: path.join(state.root, 'previews') },
      { appDataRoot, authState: { csrfPepper } },
    );
    state.server = state.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => state.server.once('listening', resolve));
    state.baseURL = `http://127.0.0.1:${state.server.address().port}`;
  }

  async function stop() {
    if (state.server) {
      state.server.closeAllConnections();
      await new Promise((resolve) => state.server.close(resolve));
    }
    if (state.db) closeDatabase(state.db);
    if (state.root) fs.rmSync(state.root, { recursive: true, force: true });
  }

  let shade = 10;
  async function image(filePath, { width = 48, height = 48, jpeg = false } = {}) {
    shade = (shade + 41) % 230;
    const pipeline = sharp({ create: { width, height, channels: 3, background: { r: shade, g: 90, b: 160 } } });
    await (jpeg ? pipeline.jpeg() : pipeline.png()).toFile(filePath);
  }

  // Earlier tests' projects leave the active library.
  function isolate() {
    state.db.prepare("UPDATE projects SET archived_at = CURRENT_TIMESTAMP, status = 'archived' WHERE archived_at IS NULL").run();
    clearAssetViewerDefaults();
  }

  let count = 0;
  async function project(title, projectType, files) {
    count += 1;
    const created = state.app.locals.projectService.create({ title: `${title} ${count}`, status: 'tbd', projectType });
    const dir = path.join(state.projectsRoot, created.project_dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const name = typeof file === 'string' ? file : file.name;
      await image(path.join(dir, name), { jpeg: name.endsWith('.jpg'), ...(typeof file === 'string' ? {} : file) });
    }
    state.app.locals.assetScanner.scanProjectAssets(created.id);
    const ids = state.db.prepare('SELECT id, filename FROM assets WHERE project_id = ? ORDER BY id').all(created.id);
    return {
      id: created.id,
      title: created.title,
      type: projectType,
      assetIds: ids.map((row) => row.id),
      assetId: (filename) => ids.find((row) => row.filename === filename)?.id,
    };
  }

  function writePageDefault(page, option, value) {
    const key = PAGE_DEFAULT_DEFINITIONS[page][option].key;
    state.db.prepare(`
      INSERT INTO app_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  function readPageDefault(page, option) {
    return state.db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PAGE_DEFAULT_DEFINITIONS[page][option].key)?.value;
  }

  function clearAssetViewerDefaults() {
    for (const option of NINE) {
      state.db.prepare('DELETE FROM app_meta WHERE key = ?').run(PAGE_DEFAULT_DEFINITIONS.assetViewer[option].key);
    }
  }

  function generation() {
    return state.app.locals.pageDefaultsService.getMutationGeneration('assetViewer');
  }

  return {
    state, start, stop, isolate, project, writePageDefault, readPageDefault, clearAssetViewerDefaults, generation,
    get baseURL() { return state.baseURL; },
  };
}

/** Records every non-GET request and page error for the lifetime of `page`. */
export function watch(page) {
  const control = { posts: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      control.posts.push({ path: url.pathname, type: request.resourceType(), body: new URLSearchParams(request.postData() || '') });
    }
    else if (url.pathname === '/asset-viewer' && request.resourceType() === 'fetch') control.gets.push(url);
  });
  control.defaultsPosts = () => control.posts.filter((post) => post.path.startsWith('/asset-viewer/defaults'));
  return control;
}

export function dialog(page) {
  return page.locator(DIALOG);
}

export async function openDialog(page) {
  await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

export async function closeDialog(page) {
  await dialog(page).getByRole('button', { name: 'Close Filters & Defaults', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
}

export async function settled(page) {
  await expect(page.locator('[data-asset-library-live-region]')).not.toHaveAttribute('aria-busy', 'true');
}

export function dropdown(page, id) {
  return page.locator(`#${id}`);
}

/** Opens a dialog dropdown by its trigger (fixed overlay panel). */
export async function openDropdown(page, id) {
  const details = dropdown(page, id);
  if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
  await expect(details.locator('.asset-filter-multiselect-panel')).toBeVisible();
  return details;
}

/** Clicks one option row of a dialog dropdown by its visible label. */
export async function choose(page, id, label, { search } = {}) {
  const details = await openDropdown(page, id);
  if (search !== undefined) {
    await details.locator('[data-cc-dropdown-search]').fill(search);
  }
  // Exact label text, so "Cropped" never matches "Uncropped" nor "10" "100".
  await details.locator('.asset-filter-multiselect-option label').getByText(label, { exact: true }).first().click();
  await settled(page);
  // Single selects close themselves; a multi-select stays open for further
  // choices, so close it from its trigger as a user would.
  const current = dropdown(page, id);
  if (await current.evaluate((element) => element.open)) await current.locator('summary').click();
  await expect(current).toHaveJSProperty('open', false);
  return current;
}

export async function checkedValues(page, id) {
  return dropdown(page, id).locator('input:checked').evaluateAll((inputs) => inputs.map((input) => input.value));
}

export async function summaryText(page, id) {
  return (await dropdown(page, id).locator('[data-cc-dropdown-summary-current]').textContent()).trim();
}

export async function renderedAssetIds(page) {
  return page.locator('[data-asset-library-live-region] article[data-asset-id]')
    .evaluateAll((cards) => cards.map((card) => Number(card.dataset.assetId)));
}

export async function totalText(page) {
  return (await page.locator('[data-asset-library-live-region] .results-meta').textContent()).trim();
}

export async function pageAuthority(page) {
  return page.locator('[data-asset-library-defaults-authority]')
    .evaluate((element) => JSON.parse(element.textContent));
}

export function query(page) {
  return new URL(page.url()).searchParams;
}
