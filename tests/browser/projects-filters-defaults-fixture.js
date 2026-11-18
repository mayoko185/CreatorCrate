import { expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../../src/services/page-defaults-service.js';

/*
 * WP10b — shared isolated fixture for the Projects Filters & Defaults
 * Chromium acceptance specs. One real app per spec file on a temporary
 * SQLite/filesystem root (removed afterwards). Projects carry real
 * catalogue statuses, Project Types and tags.
 */

export const DIALOG = '#projects-filter-dialog';
export const SEVEN = Object.freeze(['view', 'gridStyle', 'sort', 'order', 'status', 'projectType', 'tag']);

export function createProjectsFixture(label) {
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

  let count = 0;
  let tagCount = 0;
  function tag(name) {
    tagCount += 1;
    const created = state.app.locals.tagService.createTag({ name: `${name} ${tagCount}` });
    return { id: created.id, name: `${name} ${tagCount}` };
  }

  function project(title, { status = 'planned', projectType = 'images', tags = [], archived = false } = {}) {
    count += 1;
    const created = state.app.locals.projectService.create({ title: `${title} ${count}`, status, projectType });
    if (tags.length > 0) state.app.locals.projectTagService.replaceProjectTags(created.id, tags.map((entry) => entry.id));
    if (archived) {
      state.db.prepare("UPDATE projects SET archived_at = CURRENT_TIMESTAMP, status = 'archived' WHERE id = ?")
        .run(created.id);
    }
    return { id: created.id, title: created.title, status, projectType };
  }

  // Earlier tests' projects leave the active listing; Projects defaults clear.
  function isolate() {
    state.db.prepare("UPDATE projects SET archived_at = CURRENT_TIMESTAMP, status = 'archived' WHERE archived_at IS NULL").run();
    state.db.prepare('DELETE FROM project_tags').run();
    state.app.locals.nsfwFilterSettingsService.setEnabled(false);
    clearProjectsDefaults();
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

  function storedProjectsDefaults() {
    return Object.fromEntries(SEVEN.map((option) => [option, readPageDefault('projects', option)]));
  }

  function clearProjectsDefaults() {
    for (const option of SEVEN) {
      state.db.prepare('DELETE FROM app_meta WHERE key = ?').run(PAGE_DEFAULT_DEFINITIONS.projects[option].key);
    }
  }

  function generation() {
    return state.app.locals.pageDefaultsService.getMutationGeneration('projects');
  }

  return {
    state, start, stop, isolate, tag, project, writePageDefault, readPageDefault, storedProjectsDefaults,
    clearProjectsDefaults, generation,
    get baseURL() { return state.baseURL; },
  };
}

/** Records every POST, live Projects GET and page error for the lifetime of `page`. */
export function watch(page) {
  const control = { posts: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      control.posts.push({ path: url.pathname, type: request.resourceType(), body: new URLSearchParams(request.postData() || '') });
    } else if (url.pathname === '/projects' && request.resourceType() === 'fetch') {
      control.gets.push(url);
    }
  });
  control.defaultsPosts = () => control.posts.filter((post) => post.path.startsWith('/projects/defaults'));
  return control;
}

export function dialog(page) {
  return page.locator(DIALOG);
}

export async function enhanced(page) {
  await page.locator('[data-projects-nsfw-filter][data-projects-nsfw-bound="true"]').waitFor({ state: 'attached' });
  await expect(page.locator('[data-projects-defaults-save]')).toBeEnabled();
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
  await expect(page.locator('[data-projects-live-region]')).not.toHaveAttribute('aria-busy', 'true');
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

/** Clicks one option row of a dialog dropdown by its visible label. */
export async function choose(page, id, label, { search } = {}) {
  const details = await openDropdown(page, id);
  if (search !== undefined) await details.locator('[data-cc-dropdown-search]').fill(search);
  await details.locator('.asset-filter-multiselect-option label').getByText(label, { exact: true }).first().click();
  await settled(page);
  const current = dropdown(page, id);
  if (await current.evaluate((element) => element.open)) await current.locator('summary').click();
  await expect(current).toHaveJSProperty('open', false);
  return current;
}

/** Toggles one option of a dialog dropdown by its value (labels may carry a suffix). */
export async function chooseValue(page, id, value) {
  const details = await openDropdown(page, id);
  await details.locator(`.asset-filter-multiselect-option input[value="${value}"]`).click();
  await settled(page);
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

export async function renderedIds(page) {
  return page.locator('[data-projects-live-region]').evaluate((region) => {
    const ids = [...region.querySelectorAll('[data-project-card-link], tr[data-project-id], [data-project-id]')]
      .map((node) => Number(node.getAttribute('data-project-id')
        || (node.getAttribute('href') || '').split('/').pop()))
      .filter((id) => Number.isInteger(id) && id > 0);
    return [...new Set(ids)];
  });
}

export async function totalCount(page) {
  const text = await page.locator('[data-projects-live-region] .results-meta').textContent();
  return Number(String(text).trim().split(/\s+/)[0]);
}

export async function expectListing(page, ids, total = ids.length) {
  await expect.poll(() => totalCount(page)).toBe(total);
  await expect.poll(async () => (await renderedIds(page)).sort((a, b) => a - b))
    .toEqual([...ids].sort((a, b) => a - b));
}

export async function pageAuthority(page) {
  return page.locator('[data-projects-defaults-authority]').evaluate((element) => JSON.parse(element.textContent));
}

export function query(page) {
  return new URL(page.url()).searchParams;
}

export function projectsUrl(baseURL, ids = [], extra = {}) {
  const params = new URLSearchParams();
  ids.forEach((id) => params.append('project', String(id)));
  Object.entries(extra).forEach(([key, value]) => {
    (Array.isArray(value) ? value : [value]).forEach((entry) => params.append(key, String(entry)));
  });
  const text = params.toString();
  return `${baseURL}/projects${text ? `?${text}` : ''}`;
}

/** No comma-joined arrays: every repeated value is its own parameter. */
export function expectRepeated(url, key, values) {
  const actual = new URL(url, 'http://x').searchParams.getAll(key);
  expect(actual.some((value) => value.includes(','))).toBe(false);
  expect(actual.map(String).sort()).toEqual(values.map(String).sort());
}
