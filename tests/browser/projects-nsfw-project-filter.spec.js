import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// WP10a F1: the enhanced Projects NSFW toggle refreshes the list it shows.
// The legacy Filter form holds a single Project, so the refresh must come
// from the installed (or pending/failed) destination, never from that form.

const FILLER_COUNT = 28;
const NSFW_BOUND = '[data-projects-nsfw-filter][data-projects-nsfw-bound="true"]';

async function withProjectsApp(run, { extra } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-projects-nsfw-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot); fs.mkdirSync(previewRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, { appDataRoot, authState: { csrfPepper } });
    const filler = [];
    for (let index = 1; index <= FILLER_COUNT; index += 1) {
      const title = `Filler Project ${String(index).padStart(2, '0')}`;
      filler.push(app.locals.projectService.create({ title, status: 'ready', projectType: 'images' }).id);
    }
    const fixture = extra ? await extra({ app, db }) : {};
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, filler, ...fixture });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function pathOf(url) {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

function projectsQuery(ids, extra = {}) {
  const params = new URLSearchParams();
  ids.forEach((id) => params.append('project', String(id)));
  Object.entries(extra).forEach(([key, value]) => {
    (Array.isArray(value) ? value : [value]).forEach((entry) => params.append(key, String(entry)));
  });
  return `/projects?${params.toString()}`;
}

// Every live GET of the Projects listing (fetch, not document navigations).
function recordLiveGets(page) {
  const gets = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/projects' && request.resourceType() === 'fetch') {
      gets.push(url);
    }
  });
  return gets;
}

async function renderedIds(page) {
  return page.locator('[data-projects-live-region] [data-project-card]').evaluateAll((nodes) => nodes.map((node) => {
    const id = node.getAttribute('data-project-id')
      || (node.querySelector('[data-project-card-link]')?.getAttribute('href') || '').split('/').pop();
    return Number(id);
  }));
}

async function resultCount(page) {
  const text = await page.locator('[data-projects-live-region] .results-meta').textContent();
  return Number(String(text).trim().split(/\s+/)[0]);
}

async function expectListing(page, ids, total = ids.length) {
  await expect.poll(() => resultCount(page)).toBe(total);
  await expect.poll(async () => (await renderedIds(page)).sort((a, b) => a - b))
    .toEqual([...ids].sort((a, b) => a - b));
}

// Grid is the default View, so its canonical URLs omit `view`.
function viewOf(url) {
  return new URL(url, 'http://x').searchParams.get('view') ?? 'grid';
}

function projectValues(url) {
  return new URL(url, 'http://x').searchParams.getAll('project');
}

function expectProjects(url, ids) {
  const values = projectValues(url);
  expect(values.some((value) => value.includes(','))).toBe(false);
  expect(values.map(Number).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
}

async function waitForEnhancement(page) {
  await page.locator(NSFW_BOUND).waitFor({ state: 'attached' });
}

const toggle = (page) => page.locator('#projects-nsfw-toggle');

// Toggles NSFW and waits until the refresh has settled (control re-enabled
// with the new pressed state).
async function toggleNsfw(page) {
  const before = await toggle(page).getAttribute('aria-pressed');
  const expected = before === 'true' ? 'false' : 'true';
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', expected);
  await expect(toggle(page)).toBeEnabled();
  await expect(page.locator('[data-projects-live-region]')).not.toHaveAttribute('aria-busy', 'true');
  return expected;
}

async function historyLength(page) {
  return page.evaluate(() => window.history.length);
}

async function renderedLinkHrefs(page) {
  return page.locator('[data-projects-live-region] nav.view-switcher a, [data-projects-live-region] .pagination a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
}

async function nsfwReturnTo(page) {
  return page.locator('[data-projects-nsfw-filter] input[name="returnTo"]').inputValue();
}

test.describe('Projects NSFW toggle keeps the multi-Project restriction', () => {
  test('A: two Projects stay selected through the NSFW refresh, links and reload', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await withProjectsApp(async ({ origin, filler }) => {
      const selected = [filler[6], filler[11]];
      const start = projectsQuery(selected, { sort: 'title', order: 'asc', view: 'list' });
      await page.goto(`${origin}${start}`);
      await waitForEnhancement(page);
      expectProjects(page.url(), selected);
      await expectListing(page, selected);

      const gets = recordLiveGets(page);
      const lengthBefore = await historyLength(page);
      const addressBefore = pathOf(page.url());
      await toggleNsfw(page);

      // The refresh request carried both Projects as repeated parameters.
      expect(gets).toHaveLength(1);
      expectProjects(gets[0].href, selected);
      expect(gets[0].searchParams.get('sort')).toBe('title');
      expect(gets[0].searchParams.get('order')).toBe('asc');
      expect(viewOf(gets[0].href)).toBe('list');

      // Results, count, address and history agree: no broadening, no entry.
      await expectListing(page, selected);
      await expect(page.locator('[data-projects-live-region] .pagination')).toHaveCount(0);
      expect(pathOf(page.url())).toBe(addressBefore);
      expect(await historyLength(page)).toBe(lengthBefore);

      // Generated links keep both Projects.
      const hrefs = await renderedLinkHrefs(page);
      expect(hrefs.length).toBeGreaterThan(0);
      hrefs.forEach((href) => expectProjects(href, selected));
      expectProjects(await nsfwReturnTo(page), selected);

      // Reload reproduces the same two-Project listing.
      await page.reload();
      await waitForEnhancement(page);
      expectProjects(page.url(), selected);
      await expectListing(page, selected);

      // A Grid/List switch after the toggle still restricts to both.
      await page.locator('[data-projects-live-region] nav.view-switcher a[aria-label="Grid view"]').click();
      await expect.poll(() => viewOf(page.url())).toBe('grid');
      expectProjects(page.url(), selected);
      await expectListing(page, selected);
    });
    expect(pageErrors).toEqual([]);
  });

  test('B: Status, Type, Tag, Search, Sort and View survive alongside two Projects', async ({ page }) => {
    await withProjectsApp(async ({ origin, matchA, matchB, wrongStatus, tagId }) => {
      const selected = [matchA, matchB, wrongStatus];
      const start = projectsQuery(selected, {
        status: 'planned', type: 'comic', tag: tagId, search: 'Needle', sort: 'title', order: 'desc', view: 'grid',
      });
      await page.goto(`${origin}${start}`);
      await waitForEnhancement(page);
      await expectListing(page, [matchA, matchB]);
      // Descending title order: "Needle B" before "Needle A".
      expect(await renderedIds(page)).toEqual([matchB, matchA]);

      const gets = recordLiveGets(page);
      const addressBefore = pathOf(page.url());
      await toggleNsfw(page);

      expect(gets).toHaveLength(1);
      const sent = gets[0].searchParams;
      expectProjects(gets[0].href, selected);
      expect(sent.getAll('status')).toEqual(['planned']);
      expect(sent.getAll('type')).toEqual(['comic']);
      expect(sent.getAll('tag')).toEqual([String(tagId)]);
      expect(sent.get('search')).toBe('Needle');
      expect(sent.get('sort')).toBe('title');
      expect(sent.get('order')).toBe('desc');
      expect(viewOf(gets[0].href)).toBe('grid');

      await expectListing(page, [matchA, matchB]);
      expect(await renderedIds(page)).toEqual([matchB, matchA]);
      expect(pathOf(page.url())).toBe(addressBefore);

      await page.reload();
      await waitForEnhancement(page);
      await expectListing(page, [matchA, matchB]);
    }, {
      extra: ({ app }) => {
        const tag = app.locals.tagService.createTag({ name: 'F1 Needle Tag' });
        const make = (title, status, projectType, tagIds) => app.locals.projectService
          .create({ title, status, projectType }, { tagIds }).id;
        const matchA = make('Needle A', 'planned', 'comic', [tag.id]);
        const matchB = make('Needle B', 'planned', 'comic', [tag.id]);
        // Selected, but its Status does not match.
        const wrongStatus = make('Needle C', 'ready', 'comic', [tag.id]);
        // Match every other dimension but are not selected.
        make('Needle D', 'planned', 'comic', [tag.id]);
        make('Needle E', 'planned', 'comic', [tag.id]);
        return { matchA, matchB, wrongStatus, tagId: tag.id };
      },
    });
  });

  test('C: a single Project chosen in the combined Filters & Defaults dialog survives the toggle', async ({ page }) => {
    await withProjectsApp(async ({ origin, filler }) => {
      const chosen = filler[3];
      await page.goto(`${origin}/projects?view=list`);
      await waitForEnhancement(page);
      await expectListing(page, (await renderedIds(page)), FILLER_COUNT);

      // WP10b: the Projects multi-select filters live.
      await page.locator('[data-dialog-open="projects-filter-dialog"]').click();
      const dialog = page.locator('#projects-filter-dialog');
      await expect(dialog).toBeVisible();
      await dialog.locator('#project-project-filter summary').click();
      await dialog.locator(`#project-project-filter input[name="project"][value="${chosen}"]`).check();
      await expect.poll(() => projectValues(page.url())).toEqual([String(chosen)]);
      await expectListing(page, [chosen]);
      // A multi-select stays open for more choices: Escape closes it first,
      // then the dialog.
      await page.keyboard.press('Escape');
      await expect(dialog.locator('#project-project-filter')).toHaveJSProperty('open', false);
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      const gets = recordLiveGets(page);
      await toggleNsfw(page);
      expect(gets).toHaveLength(1);
      expectProjects(gets[0].href, [chosen]);
      await expectListing(page, [chosen]);
      expect(projectValues(page.url())).toEqual([String(chosen)]);
    });
  });

  test('D: an unrestricted listing stays unrestricted and keeps its page', async ({ page }) => {
    await withProjectsApp(async ({ origin, filler }) => {
      await page.goto(`${origin}/projects?view=list&sort=title&order=asc&page=2`);
      await waitForEnhancement(page);
      await expectListing(page, filler.slice(25), FILLER_COUNT);
      await expect(page.locator('.pagination')).toContainText('Page 2 of 2');

      const gets = recordLiveGets(page);
      await toggleNsfw(page);
      expect(gets).toHaveLength(1);
      expect(gets[0].searchParams.getAll('project')).toEqual([]);
      expect(gets[0].searchParams.get('page')).toBe('2');
      await expectListing(page, filler.slice(25), FILLER_COUNT);
      await expect(page.locator('.pagination')).toContainText('Page 2 of 2');
      expect(projectValues(page.url())).toEqual([]);
      const hrefs = await renderedLinkHrefs(page);
      hrefs.forEach((href) => expect(projectValues(href)).toEqual([]));
    });
  });
});

test.describe('Projects NSFW toggle during pending navigation', () => {
  // Holds matching live GETs until released; returns a release function.
  async function holdLiveGets(page, predicate) {
    const held = [];
    let releaseAll = null;
    const gate = new Promise((resolve) => { releaseAll = resolve; });
    await page.route((url) => url.pathname === '/projects', async (route) => {
      const request = route.request();
      if (request.method() === 'GET' && request.resourceType() === 'fetch' && predicate(new URL(request.url()))) {
        held.push(request.url());
        await gate;
      }
      await route.fallback();
    });
    return { held, release: () => releaseAll() };
  }

  test('A: a pending Grid/List navigation keeps its destination and history entry', async ({ page }) => {
    await withProjectsApp(async ({ origin, filler }) => {
      const selected = [filler[6], filler[11]];
      await page.goto(`${origin}${projectsQuery(selected, { sort: 'title', order: 'asc', view: 'list' })}`);
      await waitForEnhancement(page);
      const lengthBefore = await historyLength(page);
      const gate = await holdLiveGets(page, (url) => viewOf(url.href) === 'grid');
      const gets = recordLiveGets(page);

      await page.locator('[data-projects-live-region] nav.view-switcher a[aria-label="Grid view"]').click();
      await expect.poll(() => gate.held.length).toBe(1);
      await toggle(page).click();
      gate.release();
      await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
      await expect(toggle(page)).toBeEnabled();

      // The refresh re-requested the pending Grid destination, both Projects.
      const last = gets.at(-1);
      expect(viewOf(last.href)).toBe('grid');
      expectProjects(last.href, selected);
      await expect.poll(() => viewOf(page.url())).toBe('grid');
      expectProjects(page.url(), selected);
      await expectListing(page, selected);
      await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveCount(1);
      // Exactly the one entry the Grid navigation owed.
      expect(await historyLength(page)).toBe(lengthBefore + 1);

      await page.reload();
      await waitForEnhancement(page);
      await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveCount(1);
      await expectListing(page, selected);
    });
  });

  test('B/C: a newer navigation during the NSFW POST keeps ownership', async ({ page }) => {
    await withProjectsApp(async ({ origin, filler }) => {
      const selected = [filler[6], filler[11]];
      await page.goto(`${origin}${projectsQuery(selected, { sort: 'title', order: 'asc', view: 'list' })}`);
      await waitForEnhancement(page);
      const lengthBefore = await historyLength(page);

      let releasePost = null;
      const postGate = new Promise((resolve) => { releasePost = resolve; });
      let postSeen = false;
      await page.route('**/projects/nsfw-filter', async (route) => {
        postSeen = true;
        await postGate;
        await route.fallback();
      });
      const gets = recordLiveGets(page);

      await toggle(page).click();
      await expect.poll(() => postSeen).toBe(true);
      // A newer navigation while the NSFW POST is pending installs Grid.
      await page.locator('[data-projects-live-region] nav.view-switcher a[aria-label="Grid view"]').click();
      await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveCount(1);
      await expect.poll(() => viewOf(page.url())).toBe('grid');

      releasePost();
      await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
      await expect(toggle(page)).toBeEnabled();
      await expect(page.locator('[data-projects-live-region]')).not.toHaveAttribute('aria-busy', 'true');

      // The NSFW refresh followed the newer (Grid) intent; no stale List.
      const last = gets.at(-1);
      expect(viewOf(last.href)).toBe('grid');
      expectProjects(last.href, selected);
      await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveCount(1);
      expect(viewOf(page.url())).toBe('grid');
      await expectListing(page, selected);
      expect(await historyLength(page)).toBe(lengthBefore + 1);
    });
  });

  test('D: a failed navigation is re-requested with its owed history entry', async ({ page }) => {
    await withProjectsApp(async ({ origin, filler }) => {
      const selected = [filler[6], filler[11]];
      await page.goto(`${origin}${projectsQuery(selected, { sort: 'title', order: 'asc', view: 'list' })}`);
      await waitForEnhancement(page);
      const lengthBefore = await historyLength(page);
      let failGrid = true;
      await page.route((url) => url.pathname === '/projects', async (route) => {
        const request = route.request();
        if (failGrid && request.method() === 'GET' && request.resourceType() === 'fetch'
          && viewOf(request.url()) === 'grid') {
          await route.abort();
          return;
        }
        await route.fallback();
      });

      await page.locator('[data-projects-live-region] nav.view-switcher a[aria-label="Grid view"]').click();
      await expect(page.locator('[data-live-filter-failure]')).toBeVisible();
      expect(viewOf(page.url())).toBe('list');
      failGrid = false;

      const gets = recordLiveGets(page);
      await toggleNsfw(page);
      expect(gets).toHaveLength(1);
      expect(viewOf(gets[0].href)).toBe('grid');
      expectProjects(gets[0].href, selected);
      await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveCount(1);
      expect(viewOf(page.url())).toBe('grid');
      await expectListing(page, selected);
      expect(await historyLength(page)).toBe(lengthBefore + 1);
    });
  });

  test('E: Back/Forward then NSFW refreshes the shown destination', async ({ page }) => {
    await withProjectsApp(async ({ origin, filler }) => {
      const selected = [filler[6], filler[11]];
      const listPath = projectsQuery(selected, { sort: 'title', order: 'asc', view: 'list' });
      await page.goto(`${origin}${listPath}`);
      await waitForEnhancement(page);
      await page.locator('[data-projects-live-region] nav.view-switcher a[aria-label="Grid view"]').click();
      await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveCount(1);
      const lengthAfterGrid = await historyLength(page);

      await page.goBack();
      await expect(page.locator('[data-projects-live-region] .projects-list-table')).toHaveCount(1);
      expect(pathOf(page.url())).toBe(listPath);
      const gets = recordLiveGets(page);
      await toggleNsfw(page);
      expect(gets).toHaveLength(1);
      expect(viewOf(gets[0].href)).toBe('list');
      expectProjects(gets[0].href, selected);
      await expect(page.locator('[data-projects-live-region] .projects-list-table')).toHaveCount(1);
      expect(pathOf(page.url())).toBe(listPath);
      await expectListing(page, selected);
      expect(await historyLength(page)).toBe(lengthAfterGrid);

      await page.goForward();
      await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveCount(1);
      expectProjects(page.url(), selected);
      await expectListing(page, selected);

      // A pending Back navigation owns the NSFW refresh too.
      let release = null;
      const gate = new Promise((resolve) => { release = resolve; });
      let held = false;
      await page.route((url) => url.pathname === '/projects', async (route) => {
        const request = route.request();
        if (!held && request.method() === 'GET' && request.resourceType() === 'fetch'
          && viewOf(request.url()) === 'list') {
          held = true;
          await gate;
        }
        await route.fallback();
      });
      await page.goBack();
      await expect.poll(() => held).toBe(true);
      await toggle(page).click();
      release();
      await expect(toggle(page)).toBeEnabled();
      await expect(page.locator('[data-projects-live-region] .projects-list-table')).toHaveCount(1);
      expect(pathOf(page.url())).toBe(listPath);
      await expectListing(page, selected);
      expect(await historyLength(page)).toBe(lengthAfterGrid);
    });
  });
});
