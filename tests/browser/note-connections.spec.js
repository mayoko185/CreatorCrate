import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

async function fixture(page, edit = false) {
  const env = nunjucks.configure(fileURLToPath(new URL('../../src/views', import.meta.url)), { autoescape: true });
  const requests = [];
  const posts = [];
  const model = {
    connections: { hasContext: edit, assets: edit ? [{
      id: 'note-asset-option-10', value: '10', label: 'a.png — Project: Alpha', selected: true,
      attributes: [['data-project-key', 'project:1'], ['data-persisted', 'true']],
    }] : [], retained: edit ? [{
      id: 'note-asset-option-30', value: '30', label: 'missing.png — Project: Archived (Archived project) (Missing)',
      attributes: [['data-project-key', 'project:3'], ['data-persisted', 'true']],
    }] : [] },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      posts.push(new URLSearchParams(body)); res.writeHead(204).end(); return;
    }
    if (url.pathname.startsWith('/client/')) {
      const name = url.pathname.slice('/client/'.length);
      if (!/^[a-z-]+\.js$/.test(name)) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await fs.readFile(new URL(`../../src/static/client/${name}`, import.meta.url))); return;
    }
    if (url.pathname === '/notes/asset-picker/assets') {
      const id = url.searchParams.get('projectId'); requests.push(id);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ project: { id: Number(id), title: id === '1' ? 'Alpha' : 'Beta', archived: false },
        items: [{ id: Number(id) * 10, filename: id === '1' ? 'a.png' : 'b.png', isPresent: true }], nextCursor: null })); return;
    }
    const html = env.renderString(`{% import "partials/dropdown.njk" as dropdown %}
      <form method="post" action="/save">{% include "notes/connections-fields.njk" %}<button>Save</button></form>`, {
      noteFormModel: model, errors: {}, projects: [{ id: 1, title: 'Alpha' }, { id: 2, title: 'Beta' }, { id: 3, title: 'Archived', archived: true }],
      selectedProjectIds: edit ? ['1'] : [], selectedAssetIds: edit ? ['10', '30'] : [],
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`${html}<script type="module">
      import { enhanceDropdowns } from '/client/dropdowns.js';
      import { enhanceNoteConnections } from '/client/note-connections.js';
      enhanceNoteConnections(); enhanceDropdowns();
      window.reinitialize = () => { enhanceDropdowns(); return enhanceNoteConnections(); };
      window.ready = true;
    </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.ready);
  } catch (error) { await close(); throw error; }
  return { requests, posts, close };
}

async function project(page, title, checked) {
  const dropdown = page.locator('#note-projects-form');
  if (!await dropdown.evaluate(node => node.open)) await dropdown.locator('summary').click();
  await dropdown.locator('input[type=search]').fill(title);
  await dropdown.getByRole('checkbox', { name: title, exact: true }).setChecked(checked);
}

test('New: shared Project search/keyboard, dependent Assets, A+B reconciliation and native submission', async ({ page }) => {
  const f = await fixture(page);
  try {
    await expect(page.locator('[data-note-assets]')).toBeHidden();
    await page.locator('#note-projects-form summary').focus();
    await page.keyboard.press('Enter');
    const search = page.locator('#note-projects-form-search');
    await search.fill('no match');
    await expect(page.locator('#note-projects-form-no-results')).toBeVisible();
    await search.fill('alpha'); await search.press('Enter');
    expect(f.posts).toHaveLength(0);
    await search.press('Tab'); await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeChecked();
    await expect(page.locator('[data-note-assets]')).toBeVisible();
    await expect(page.locator('#note-assets-native option')).toHaveText(['a.png — Project: Alpha']);
    await search.press('Escape');
    await expect(page.locator('#note-projects-form summary')).toBeFocused();
    await page.locator('#note-assets-form summary').click();
    await page.locator('#note-assets-form-search').fill('a.png');
    await page.getByRole('checkbox', { name: 'a.png — Project: Alpha', exact: true }).check();
    await project(page, 'Beta', true);
    await expect(page.locator('#note-assets-native option')).toHaveCount(2);
    await project(page, 'Alpha', false);
    await expect(page.locator('#note-assets-native option')).toHaveText(['b.png — Project: Beta']);
    await page.locator('#note-assets-form summary').click();
    await page.locator('#note-assets-form-search').fill('b.png');
    await page.getByRole('checkbox', { name: 'b.png — Project: Beta', exact: true }).check();
    expect(await page.evaluate(() => window.reinitialize())).toBe(0);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => f.posts.length).toBe(1);
    expect(f.posts[0].getAll('projectIds[]')).toEqual(['2']);
    expect(f.posts[0].getAll('assetIds[]').filter(Boolean)).toEqual(['20']);
    expect(f.requests).toEqual(['1', '2']);
    await expect(page.locator('[data-notes-asset-picker]')).toHaveCount(0);
    const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(node => node.id));
    expect(new Set(ids).size).toBe(ids.length);
  } finally { await f.close(); }
});

test('Edit/422: initialize selected Assets, retain archived/missing and independent persisted associations', async ({ page }) => {
  const f = await fixture(page, true);
  try {
    await expect(page.locator('[data-note-assets]')).toBeVisible();
    await expect(page.locator('#note-assets-form input[type=checkbox]')).toBeChecked();
    await expect(page.locator('[data-note-retained-options] input')).toBeChecked();
    await project(page, 'Alpha', false);
    await expect(page.locator('[data-note-assets]')).toBeHidden();
    await expect(page.locator('[data-note-retained-options] input:checked')).toHaveCount(2);
    expect(await page.evaluate(() => new FormData(document.querySelector('form')).getAll('assetIds[]').filter(Boolean))).toEqual(['10', '30']);
    await project(page, 'Beta', true);
    await expect(page.locator('#note-assets-native option')).toHaveText(['b.png — Project: Beta']);
    await expect(page.locator('[data-note-retained-options]')).toContainText('(Archived project) (Missing)');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => f.posts.length).toBe(1);
    expect(f.posts[0].getAll('assetIds[]').filter(Boolean)).toEqual(['10', '30']);
    expect(f.requests).toEqual(['2']);
  } finally { await f.close(); }
});

test('ignores a late deselected-Project response and keeps persisted selections on catalogue failure', async ({ page }) => {
  const f = await fixture(page, true);
  try {
    let late;
    await page.route('**/notes/asset-picker/assets*', route => { late = route; });
    await project(page, 'Beta', true);
    await expect.poll(() => Boolean(late)).toBe(true);
    await project(page, 'Beta', false);
    await late.fulfill({ json: { project: { id: 2, title: 'Beta' }, items: [{ id: 20, filename: 'late.png', isPresent: true }], nextCursor: null } }).catch(() => {});
    await expect(page.locator('#note-assets-native option')).toHaveText(['a.png — Project: Alpha']);
    await page.unroute('**/notes/asset-picker/assets*');
    await page.route('**/notes/asset-picker/assets*', route => route.fulfill({ status: 500, body: 'Unavailable' }));
    await project(page, 'Beta', true);
    await expect(page.locator('[data-note-assets-status]')).toContainText('could not be loaded');
    expect(await page.evaluate(() => new FormData(document.querySelector('form')).getAll('assetIds[]').filter(Boolean))).toEqual(['10', '30']);
    await project(page, 'Alpha', false);
    await project(page, 'Alpha', true);
    await expect(page.locator('#note-assets-form input[type=checkbox]')).toBeChecked();
  } finally { await f.close(); }
});

test('loads every existing endpoint page and searches the shared Asset dropdown', async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.route('**/notes/asset-picker/assets*', route => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      return route.fulfill({ json: { project: { id: 2, title: 'Beta' },
        items: [{ id: cursor ? 21 : 20, filename: cursor ? 'second.png' : 'first.png', isPresent: true }],
        nextCursor: cursor ? null : 'page-two' } });
    });
    await project(page, 'Beta', true);
    await expect(page.locator('#note-assets-native option')).toHaveCount(2);
    await page.locator('#note-assets-form summary').click();
    const search = page.locator('#note-assets-form-search');
    await search.fill('second'); await search.press('Tab'); await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: 'second.png — Project: Beta', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'first.png — Project: Beta', exact: true })).toBeHidden();
    await search.fill('absent');
    await expect(page.locator('#note-assets-form-no-results')).toBeVisible();
  } finally { await f.close(); }
});
