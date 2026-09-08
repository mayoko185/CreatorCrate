import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

async function open(dropdown) {
  if (!await dropdown.evaluate(n => n.open)) await dropdown.locator('summary').click();
  await expect(dropdown.locator('summary')).toHaveAttribute('aria-expanded', 'true');
}

// Hit-testing, not just visibility: a visible search box can still be underneath
// the later Assets fieldset. Check the entire overlay, including its bottom edge.
async function unobscured(dropdown) {
  const panel = dropdown.locator('.asset-filter-multiselect-panel');
  await expect(panel).toHaveAttribute('data-cc-dropdown-overlay');
  await expect.poll(() => panel.evaluate(n => {
    const r = n.getBoundingClientRect();
    const search = n.querySelector('input[type=search]');
    const s = search.getBoundingClientRect();
    return getComputedStyle(n).position === 'fixed'
      && r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8
      && n.scrollWidth <= n.clientWidth
      && [[s.left + s.width / 2, s.top + s.height / 2], [r.left + 12, r.top + 12], [r.right - 12, r.bottom - 12]]
        .every(([x, y]) => n.contains(document.elementFromPoint(x, y)));
  })).toBe(true);
}

async function presentation(dropdown) {
  return dropdown.evaluate(n => {
    const pick = (selector, properties) => {
      const s = getComputedStyle(n.querySelector(selector));
      return Object.fromEntries(properties.map(k => [k, s[k]]));
    };
    return {
      trigger: pick('summary', ['backgroundColor', 'color', 'padding', 'borderRadius', 'fontSize', 'lineHeight', 'outlineColor']),
      panel: pick('.asset-project-filter-panel', ['backgroundColor', 'padding', 'borderRadius', 'gap', 'width', 'maxHeight', 'overflow']),
      search: pick('input[type=search]', ['backgroundColor', 'padding', 'fontSize', 'height']),
      label: pick('.asset-project-filter-search-label', ['color', 'fontSize']),
      option: pick('.asset-project-filter-option > label', ['padding', 'gap', 'fontSize']),
      list: pick('.asset-project-filter-option-list', ['gap', 'overflowY', 'scrollbarWidth']),
    };
  });
}

for (const edit of [false, true]) test(`${edit ? 'Edit' : 'New'}: real Projects parity, layering, associations, 422 and Escape`, async ({ page, browser }, testInfo) => {
  page.setDefaultTimeout(10000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-connections-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    for (const title of ['Alpha', 'Beta', ...Array.from({ length: 24 }, (_, i) => `Project ${i}`)]) {
      db.prepare("INSERT INTO projects (title, slug, description, notes, status) VALUES (?, ?, '', '', 'tbd')").run(title, title.toLowerCase().replaceAll(' ', '-'));
    }
    const insertAsset = db.prepare("INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at) VALUES (?, ?, ?, 'png', 'image/png', 1, 1, datetime('now'))");
    for (const id of [1, 2, 3]) insertAsset.run(id, `${id}.png`, `${id}.png`);
    for (let i = 0; i < 24; i++) insertAsset.run(2, `beta-${i}.png`, i === 23 ? 'beta-' + 'long-filename-'.repeat(15) + '.png' : `beta-${i}.png`);
    db.prepare("UPDATE assets SET modified_at = '2026-09-01T00:00:00.000Z' WHERE id IN (1, 2)").run();
    const nsfw = app.locals.tagService.createTag({ name: 'NSFW' });
    app.locals.assetTagService.replaceAssetTags(1, [nsfw.id]);
    app.locals.projectTagService.replaceProjectTags(2, [nsfw.id]);
    app.locals.nsfwFilterSettingsService.setEnabled(true);
    db.prepare("INSERT INTO managed_assets (id, storage_key, namespace, mime_type, size_bytes, width, height, sha256) VALUES ('managed-cover', 'private-cover.png', 'book-covers', 'image/png', 1, 1, 1, ?)").run('a'.repeat(64));
    const book = app.locals.bookService.createBook({ title: 'Connections Book' });
    const note = app.locals.noteService.createNote({ bookId: book.id, title: 'Connections Page', projectIds: [1], assetIds: [1, 3] });
    db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = 3").run();
    db.prepare("UPDATE assets SET is_present = 0 WHERE id = 3").run();
    const snapshot = () => ({ projects: db.prepare('SELECT * FROM note_projects').all(), assets: db.prepare('SELECT * FROM note_assets').all() });
    const before = snapshot();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/thumbnail?*', route => route.fulfill({ contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') }));

    // The actual /projects/ route, template, stylesheet and startup module.
    await page.goto(base + '/projects/');
    const source = page.locator('#project-project-filter');
    await open(source);
    await source.locator('input[type=search]').fill('Alpha');
    await source.locator('input[type=search]').press('Tab'); // All projects remains available while searching.
    await page.keyboard.press('ArrowDown'); // Native radio navigation selects Alpha and closes.
    await expect(source).not.toHaveAttribute('open');
    await expect(source.locator('summary')).toContainText('Alpha');
    await open(source);
    await source.locator('input[type=search]').fill('');
    const reference = await presentation(source);
    await source.locator('input[type=search]').fill('absent');
    await expect(source.locator('[data-cc-dropdown-no-results]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(source.locator('summary')).toBeFocused();
    // Shared non-searchable single/multiple consumers remain operational.
    await open(page.locator('#project-status-filter'));
    await page.keyboard.press('Escape');
    await open(page.locator('#project-sort-filter'));
    await page.keyboard.press('Escape');

    await page.goto(base + `/notes/books/${book.id}?defaults=1`);
    const pages = page.locator('#book-preview-pages-dropdown');
    await open(pages);
    await pages.locator('input[type=search]').fill('Connections Page');
    await pages.getByRole('checkbox', { name: /Connections Page/ }).check();
    await expect(pages.locator('.cc-dropdown-option-thumbnail')).toHaveCount(0);
    expect(await page.locator('#book-preview-pages').evaluate(n => Array.from(n.selectedOptions).map(o => o.value))).toEqual([String(note.id)]);
    await page.goto(base + (edit ? `/notes/${note.id}` : `/notes/books/${book.id}`));
    await page.getByRole('link', { name: edit ? 'Edit Page' : 'New Page', exact: true }).click();
    const dialog = page.locator(edit ? '#note-edit-dialog' : '#note-create-dialog');
    const projects = dialog.locator('#note-projects-form');
    const assets = dialog.locator('#note-assets-form');
    const chooseProject = async (name, checked) => {
      await open(projects);
      await projects.locator('input[type=search]').fill(name);
      await projects.getByRole('checkbox', { name, exact: true }).setChecked(checked);
    };
    const chooseAsset = async value => {
      // Keyboard opening also works when the correctly raised Projects panel overlaps this trigger.
      if (!await assets.evaluate(n => n.open)) {
        await assets.locator('summary').focus();
        await assets.locator('summary').press('Enter');
      }
      await open(assets);
      await assets.locator('input[type=search]').fill(`${value}.png`);
      await assets.locator(`input[value="${value}"]`).check();
    };
    if (edit) {
      await expect(projects.locator('input[value="1"]')).toBeChecked();
      await expect(assets.locator('input[value="1"]')).toBeChecked();
      await expect(dialog.locator('[data-note-retained-options]')).toContainText('(Missing)');
      await expect(dialog.locator('[data-note-retained-options]')).toContainText('(Archived project)');
    } else {
      await expect(dialog.locator('[data-note-assets]')).toBeHidden();
      expect(await assets.locator('summary').evaluate(n => { n.focus(); return document.activeElement === n; })).toBe(false);
    }
    await open(projects);
    await unobscured(projects);
    expect(await presentation(projects)).toEqual(reference);
    await expect(projects).toHaveAttribute('data-cc-dropdown-mode', 'multiple');
    await expect(projects).toHaveAttribute('data-cc-dropdown-searchable');
    await expect(projects.locator('summary')).toHaveAccessibleName(/^Projects:/);
    await expect(projects.locator('input[type=search]')).toHaveAccessibleName('Search projects');
    await expect(projects.locator('[data-cc-dropdown-option-list]')).toHaveAttribute('role', 'group');
    await projects.locator('input[type=search]').fill('absent');
    await expect(projects.locator('[data-cc-dropdown-no-results]')).toBeVisible();
    await projects.locator('input[type=search]').fill('Alpha');
    await projects.locator('input[type=search]').press('Enter'); // Never submits the Page.
    expect(snapshot()).toEqual(before);
    if (!edit) {
      await projects.locator('input[type=search]').press('Tab');
      await page.keyboard.press('Space');
    }
    await expect(projects.locator('input[value="1"]')).toBeChecked();
    await expect(dialog.locator('[data-note-assets]')).toBeVisible();
    await expect(dialog.locator('#note-assets-native option')).toHaveText(['1.png — Project: Alpha']);
    await projects.locator('input[type=search]').fill('');
    await unobscured(projects); // Assets is now present: catches the original z-index defect.
    await projects.locator('.asset-project-filter-option-list').evaluate(n => { n.scrollTop = n.scrollHeight; });
    expect(await projects.locator('.asset-project-filter-option-list').evaluate(n => n.scrollTop)).toBeGreaterThan(0);
    await dialog.locator('.app-dialog-body').evaluate(n => { n.scrollTop -= 30; });
    await unobscured(projects);
    await page.screenshot({ path: testInfo.outputPath('projects-open.png') });
    await chooseAsset(1);
    await expect(assets.locator('img')).toHaveAttribute('alt', '');
    await expect(assets.locator('img')).toHaveClass(/asset-image--nsfw-blurred/);
    await expect(assets.locator('[data-preview-enhancement]')).toHaveAttribute('data-preview-state', 'loaded');
    await expect(projects.locator('.cc-dropdown-option-thumbnail')).toHaveCount(0);
    await expect(assets.locator('summary img')).toHaveCount(0);
    if (edit) await expect(dialog.locator('[data-note-retained-options] [data-preview-fallback]')).toBeVisible();
    await expect(projects).not.toHaveAttribute('open');
    await unobscured(assets);
    await expect(assets.locator('summary')).toHaveAccessibleName(/^Assets filter:/);
    await expect(assets.locator('input[type=search]')).toHaveAccessibleName('Search assets');
    await chooseProject('Beta', true);
    await expect(assets).not.toHaveAttribute('open');
    await expect(dialog.locator('#note-assets-native option')).toHaveCount(26);
    await chooseAsset(2);
    await assets.locator('input[type=search]').fill('');
    await unobscured(assets);
    await assets.locator('.asset-project-filter-option-list').evaluate(n => { n.scrollTop = n.scrollHeight; });
    expect(await assets.locator('.asset-project-filter-option-list').evaluate(n => n.scrollTop)).toBeGreaterThan(0);
    const betaImage = assets.locator('label').filter({ has: page.locator('input[value="2"]') }).locator('img');
    await expect(betaImage).toHaveClass(/asset-image--nsfw-blurred/);
    await betaImage.click();
    await expect(assets.locator('input[value="2"]')).not.toBeChecked();
    await betaImage.click();
    await expect(assets.locator('input[value="2"]')).toBeChecked();
    // The remaining Beta rows intentionally have incomplete metadata.
    await expect(assets.locator('.cc-dropdown-option-thumbnail')).toHaveCount(26);
    await expect(assets.locator('img')).toHaveCount(2);
    for (const width of [1280, 390, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await open(assets);
      await assets.locator('input[type=search]').fill('');
      await unobscured(assets);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const list = assets.locator('.asset-project-filter-option-list');
      await list.evaluate(n => { n.scrollTop = n.scrollHeight; });
      expect(await list.evaluate(n => n.scrollTop)).toBeGreaterThan(0);
      await list.evaluate(n => { n.scrollTop = 0; });
      const box = assets.locator('.cc-dropdown-option-thumbnail').first();
      expect(await box.evaluate(n => ({ width: n.offsetWidth, height: n.offsetHeight }))).toEqual({ width: 32, height: 32 });
      await page.screenshot({ path: testInfo.outputPath(`assets-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(assets.locator('summary')).toBeFocused();
    await chooseProject('Beta', false); // Newly picked B is removed, even in Edit.
    await expect(dialog.locator('#note-assets-native option')).toHaveCount(1);
    await chooseProject('Beta', true);
    await expect(dialog.locator('#note-assets-native option')).toHaveCount(26);
    expect(await dialog.locator('#note-assets-native').evaluate(n => Array.from(n.selectedOptions).map(o => o.value))).toEqual(['1']);
    await chooseProject('Alpha', false);
    await expect(dialog.locator('#note-assets-native option')).toHaveCount(25);
    if (edit) await expect(dialog.locator('[data-note-retained-options] input:checked')).toHaveCount(2);
    await chooseAsset(2);
    await chooseProject('Beta', false);
    await expect(dialog.locator('[data-note-assets]')).toBeHidden();
    await chooseProject('Beta', true);
    await expect(dialog.locator('#note-assets-native option')).toHaveCount(25);
    await chooseAsset(2);
    expect(await dialog.locator('#note-assets-native').textContent()).not.toMatch(/3\.png — Project: Project 0|private-cover|managed-cover/);
    expect(snapshot()).toEqual(before); // Only submission is allowed to persist.

    app.locals.nsfwFilterSettingsService.setEnabled(false);
    await dialog.locator('[name="title"]').fill('');
    const invalid = page.waitForResponse(r => r.request().method() === 'POST');
    await dialog.getByRole('button', { name: edit ? 'Save' : 'Create', exact: true }).click();
    expect((await invalid).status()).toBe(422);
    await expect(dialog).toBeVisible();
    await expect(projects.locator('input[value="2"]')).toBeChecked();
    await expect(assets.locator('input[value="2"]')).toBeChecked();
    await expect(assets.locator('img.asset-image--nsfw-blurred')).toHaveCount(0);
    await open(projects);
    await unobscured(projects);
    await projects.locator('input[type=search]').fill('beta');
    await expect(projects.getByRole('checkbox', { name: 'Beta', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(n => n.id));
    expect(new Set(ids).size).toBe(ids.length);
    await expect(dialog.locator('[data-notes-asset-picker]')).toHaveCount(0);
    await expect(dialog.locator('[data-note-connections] [data-cc-dropdown]')).toHaveCount(2);
    if (edit) await dialog.locator('[data-note-retained-options] input[value="3"]').uncheck();
    await dialog.locator('[name="title"]').fill('Saved connections');
    const saved = page.waitForResponse(r => r.request().method() === 'POST');
    await dialog.getByRole('button', { name: edit ? 'Save' : 'Create', exact: true }).click();
    expect((await saved).status()).toBe(302);
    await expect(page).toHaveURL(/\/notes\/\d+$/);
    const savedId = Number(new URL(page.url()).pathname.split('/').pop());
    expect(db.prepare('SELECT project_id FROM note_projects WHERE note_id = ? ORDER BY project_id').all(savedId).map(r => r.project_id)).toEqual([2]);
    expect(db.prepare('SELECT asset_id FROM note_assets WHERE note_id = ? ORDER BY asset_id').all(savedId).map(r => r.asset_id)).toEqual(edit ? [1, 2] : [2]);
    await page.getByRole('link', { name: 'Edit Page', exact: true }).click();
    await open(page.locator('#note-projects-form'));
    await page.keyboard.press('Escape');
    await expect(page.locator('#note-edit-dialog')).toBeVisible();
    await page.locator('#note-edit-dialog .notes-workspace-disclosure--move > summary').click();
    await open(page.locator('#note-move-dropdown'));
    await page.keyboard.press('Escape');
    await expect(page.locator('#note-move-dropdown')).not.toHaveAttribute('open');
    await expect(page.locator('#note-edit-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#note-edit-dialog')).not.toBeVisible();

    // Real no-JavaScript fallback retains named checkboxes and native Assets.
    const fallback = await browser.newContext({ javaScriptEnabled: false });
    try {
      const p = await fallback.newPage();
      await p.goto(base + `/notes/${savedId}/edit`);
      await p.locator('#note-projects-form summary').click();
      await expect(p.locator('#note-projects-form input[value="2"]')).toBeChecked();
      await expect(p.locator('#note-assets-native')).toBeVisible();
      await expect(p.locator('#note-assets-form')).toBeHidden();
      await expect(p.locator('#note-assets-native option').first()).toHaveText('2.png — Project: Beta');
      await expect(p.locator('#note-assets-native img')).toHaveCount(0);
      await p.locator('#note-assets-native').selectOption(['2']);
      await p.locator('#note-edit-dialog [name="title"]').fill('Native saved');
      await p.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(p).toHaveURL(/\/notes\/\d+$/);
      expect(db.prepare('SELECT asset_id FROM note_assets WHERE note_id = ? ORDER BY asset_id').all(savedId).map(r => r.asset_id)).toEqual(edit ? [1, 2] : [2]);
    } finally { await fallback.close(); }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
