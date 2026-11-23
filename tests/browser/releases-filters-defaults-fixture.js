import { expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseRepository } from '../../src/data/release-repository.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../../src/services/page-defaults-service.js';

/*
 * WP12 — shared isolated fixture for the Releases Filters & Defaults Chromium
 * acceptance specs. One real app per spec file on a temporary
 * SQLite/filesystem root (removed afterwards). Projects carry real catalogue
 * Project Types; releases carry planned dates (overdue / upcoming /
 * unscheduled), archived releases, and exact-asset membership.
 */

export const DIALOG = '#releases-filter-dialog';
export const TWO = Object.freeze(['sort', 'order']);

export function createReleasesFixture(label) {
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
    state.releases = createReleaseRepository(state.db);
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

  let count = 0;
  function project(title, { projectType = 'images', archived = false } = {}) {
    count += 1;
    const created = state.app.locals.projectService.create({ title: `${title} ${count}`, status: 'planned', projectType });
    if (archived) {
      state.db.prepare("UPDATE projects SET archived_at = CURRENT_TIMESTAMP, status = 'archived' WHERE id = ?")
        .run(created.id);
    }
    return { id: created.id, title: created.title, projectType };
  }

  function release(owner, title, { plannedDate = null, archived = false } = {}) {
    const created = state.releases.create({
      projectId: owner.id, title, description: '', notes: '', plannedDate,
    });
    if (archived) state.releases.archive(created.id);
    return { id: created.id, title };
  }

  function asset(owner, filename) {
    return state.db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at)
      VALUES (?, ?, ?, 'png', 'image/png', 1, 1, datetime('now'))
      RETURNING id
    `).get(owner.id, `${filename}-${count}`, filename).id;
  }

  function addAsset(releaseRecord, assetId) {
    state.releases.addReleaseAsset(releaseRecord.id, assetId, 'primary', 0);
  }

  // Earlier tests' releases and projects leave the listings; Releases
  // defaults clear.
  function isolate() {
    state.db.prepare('DELETE FROM release_assets').run();
    state.db.prepare('DELETE FROM releases').run();
    state.db.prepare("UPDATE projects SET archived_at = CURRENT_TIMESTAMP, status = 'archived' WHERE archived_at IS NULL").run();
    clearReleasesDefaults();
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

  function storedReleasesDefaults() {
    return Object.fromEntries(TWO.map((option) => [option, readPageDefault('releases', option)]));
  }

  function releasesKeys() {
    return state.db.prepare("SELECT key FROM app_meta WHERE key LIKE 'page_defaults.releases.%' ORDER BY key").all()
      .map(({ key }) => key);
  }

  function clearReleasesDefaults() {
    for (const option of TWO) {
      state.db.prepare('DELETE FROM app_meta WHERE key = ?').run(PAGE_DEFAULT_DEFINITIONS.releases[option].key);
    }
  }

  function generation() {
    return state.app.locals.pageDefaultsService.getMutationGeneration('releases');
  }

  return {
    state, start, stop, isolate, project, release, asset, addAsset, writePageDefault, readPageDefault,
    storedReleasesDefaults, releasesKeys, clearReleasesDefaults, generation,
    get baseURL() { return state.baseURL; },
  };
}

/** Records every POST, live Releases GET, defaults GET and page error for the lifetime of `page`. */
export function watch(page) {
  const control = { posts: [], gets: [], defaultsGets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      control.posts.push({ path: url.pathname, type: request.resourceType(), body: new URLSearchParams(request.postData() || '') });
    } else if (url.pathname === '/releases' && request.resourceType() === 'fetch') {
      control.gets.push(url);
    } else if (url.pathname === '/releases/defaults') {
      control.defaultsGets.push(url);
    }
  });
  control.defaultsPosts = () => control.posts.filter((post) => post.path.startsWith('/releases/defaults'));
  return control;
}

export function dialog(page) {
  return page.locator(DIALOG);
}

export async function enhanced(page) {
  await expect(page.locator('[data-releases-defaults-save]')).toBeEnabled();
  await page.waitForFunction(() => Boolean(document.__creatorCrateReleasesLiveFiltering));
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
  await expect(page.locator('[data-releases-live-region]')).not.toHaveAttribute('aria-busy', 'true');
}

export function dropdown(page, id) {
  return page.locator(`#${id}`);
}

export async function openDropdown(page, id) {
  const details = dropdown(page, id);
  if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
  await expect(details.locator('.asset-filter-multiselect-panel')).toBeVisible();
  return details;
}

export async function closeDropdown(page, id) {
  const current = dropdown(page, id);
  if (await current.evaluate((element) => element.open)) await current.locator('summary').click();
  await expect(current).toHaveJSProperty('open', false);
}

/** Clicks one option row of a dialog dropdown by its visible label. */
export async function choose(page, id, label, { search } = {}) {
  const details = await openDropdown(page, id);
  if (search !== undefined) await details.locator('[data-cc-dropdown-search]').fill(search);
  await details.locator('.asset-filter-multiselect-option label').getByText(label, { exact: true }).first().click();
  await settled(page);
  await closeDropdown(page, id);
  return dropdown(page, id);
}

export async function checkedValues(page, id) {
  return dropdown(page, id).locator('input:checked').evaluateAll((inputs) => inputs.map((input) => input.value));
}

export async function summaryText(page, id) {
  return (await dropdown(page, id).locator('[data-cc-dropdown-summary-current]').textContent()).trim();
}

export async function renderedTitles(page) {
  return page.locator('[data-releases-live-region] .releases-table tbody tr td:first-child a')
    .evaluateAll((links) => links.map((link) => link.textContent.trim()));
}

export async function totalCount(page) {
  const text = await page.locator('[data-releases-live-region] .results-meta').textContent();
  return Number(String(text).trim().split(/\s+/)[0]);
}

/** Exact displayed titles, in order (pass `sorted: true` to ignore order). */
export async function expectTitles(page, titles, { total = titles.length, sorted = false } = {}) {
  await expect.poll(() => totalCount(page)).toBe(total);
  if (sorted) {
    await expect.poll(async () => (await renderedTitles(page)).sort()).toEqual([...titles].sort());
  } else {
    await expect.poll(() => renderedTitles(page)).toEqual(titles);
  }
}

export async function pageAuthority(page) {
  return page.locator('[data-releases-defaults-authority]').evaluate((element) => JSON.parse(element.textContent));
}

export function query(page) {
  return new URL(page.url()).searchParams;
}

export function releasesUrl(baseURL, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    (Array.isArray(value) ? value : [value]).forEach((entry) => search.append(key, String(entry)));
  });
  const text = search.toString();
  return `${baseURL}/releases${text ? `?${text}` : ''}`;
}

/** No comma-joined arrays: every repeated value is its own parameter. */
export function expectRepeated(url, key, values) {
  const actual = new URL(url, 'http://x').searchParams.getAll(key);
  expect(actual.some((value) => value.includes(','))).toBe(false);
  expect(actual.map(String).sort()).toEqual(values.map(String).sort());
}
