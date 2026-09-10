import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

function insertProject(db, { slug, status = 'tbd', projectType = 'images' }) {
  return db.prepare(`
    INSERT INTO projects (title, slug, status, project_type)
    VALUES (?, ?, ?, ?)
  `).run(slug, slug, status, projectType);
}

function writeMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

test('WP-E3A context-aware Project option deletion and stale-state reconciliation', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-option-delete-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    const service = app.locals.projectOptionCatalogueService;
    for (const [kind, name] of [
      ['projectType', 'Unused Type'],
      ['status', 'Used Status'],
      ['status', 'Persisted Label'],
      ['projectType', 'Used Type'],
      ['status', 'Default Blocked'],
      ['projectType', 'Combined Type'],
      ['status', 'Stale Unused'],
      ['status', 'Stale Referenced'],
      ['status', 'Stale Target Source'],
      ['status', 'Stale Target'],
    ]) service.addOption(kind, { name, color: '#123456' });

    insertProject(db, { slug: 'status-one', status: 'used-status' });
    insertProject(db, { slug: 'status-two', status: 'used-status' });
    insertProject(db, { slug: 'type-one', projectType: 'used-type' });
    const combinedOwner = Number(insertProject(db, {
      slug: 'combined-owner', projectType: 'combined-type',
    }).lastInsertRowid);
    const staleReferenced = Number(insertProject(db, {
      slug: 'stale-referenced-project', status: 'stale-referenced',
    }).lastInsertRowid);
    insertProject(db, { slug: 'stale-target-project', status: 'stale-target-source' });
    writeMeta(db, 'page_defaults.projects.status', 'default-blocked');
    db.prepare(`
      INSERT INTO project_page_defaults (project_id, page_key, option_key, value)
      VALUES (?, 'projects', 'projectType', 'combined-type')
    `).run(combinedOwner);

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const posts = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/project-options/')) {
        posts.push({ url: request.url(), body: new URLSearchParams(request.postData() || '') });
      }
    });
    await page.goto(`${base}/settings/defaults`);

    const region = kind => page.locator(`[data-settings-project-option-editor="${kind}"]`);
    const card = (kind, value) => region(kind).locator(`[data-project-option-value="${value}"]`);
    const dialog = page.locator('#app-confirmation-dialog');
    const openDelete = async (kind, value) => {
      await card(kind, value).locator('[data-project-option-delete]').click();
      await expect(dialog).toBeVisible();
    };
    const closeDialog = () => dialog.locator('[data-app-dialog-confirmation-confirm]').click();
    const chooseReplacement = async (value) => {
      await dialog.locator('[data-cc-dropdown] summary').click();
      await dialog.locator(`[data-cc-dropdown] input[type="radio"][value="${value}"]`).check();
    };

    await expect(card('status', 'archived')).toHaveCount(0);
    for (const [kind, value, blocker] of [
      ['status', 'tbd', 'New Project Status default'],
      ['project-type', 'images', 'New Project Type default'],
    ]) {
      const before = posts.length;
      await openDelete(kind, value);
      await expect(dialog).toContainText(blocker);
      await expect(dialog).not.toContainText('required by CreatorCrate');
      await expect(dialog.locator('select')).toHaveCount(0);
      await expect(dialog.locator('[data-app-dialog-confirmation-confirm]')).not.toHaveClass(/button-danger/);
      await closeDialog();
      expect(posts).toHaveLength(before);
    }

    writeMeta(db, 'page_defaults.new_project.status', 'planned');
    writeMeta(db, 'page_defaults.new_project.project_type', 'comic');
    db.prepare("UPDATE projects SET status = 'planned' WHERE status = 'tbd'").run();
    db.prepare("UPDATE projects SET project_type = 'comic' WHERE project_type = 'images'").run();
    await page.reload();
    for (const [kind, value] of [['status', 'tbd'], ['project-type', 'images']]) {
      await openDelete(kind, value);
      await expect(dialog).toContainText('This cannot be undone.');
      await closeDialog();
      await expect(card(kind, value)).toHaveCount(0);
      if (value === 'tbd') await page.reload();
    }

    for (const [kind, value, blocker] of [
      ['status', 'default-blocked', 'Global Projects Status filter default'],
      ['project-type', 'combined-type', 'Project-scoped Projects Type filter default'],
    ]) {
      const before = posts.length;
      await openDelete(kind, value);
      await expect(dialog).toContainText(blocker);
      await expect(dialog.locator('select')).toHaveCount(0);
      await closeDialog();
      expect(posts).toHaveLength(before);
    }
    expect(db.prepare("SELECT project_type FROM projects WHERE slug = 'combined-owner'").pluck().get())
      .toBe('combined-type');

    await openDelete('project-type', 'unused-type');
    await expect(dialog).toContainText('This cannot be undone.');
    await dialog.locator('[data-app-dialog-confirmation-cancel]').click();
    await expect(card('project-type', 'unused-type')).toBeVisible();
    await expect(card('project-type', 'unused-type').locator('[data-project-option-delete]')).toBeFocused();
    await openDelete('project-type', 'unused-type');
    await closeDialog();
    await expect(card('project-type', 'unused-type')).toHaveCount(0);
    const unusedPost = posts.find(post => post.url.endsWith('/project-type/unused-type/delete'));
    expect([...unusedPost.body.keys()]).toEqual(['_csrf']);

    await openDelete('status', 'used-status');
    await expect(dialog).toContainText('2 Projects currently use this status');
    const statusDropdown = dialog.locator('[data-cc-dropdown]');
    const statusSummary = statusDropdown.locator('summary');
    const statusSelect = dialog.locator('[data-project-option-delete-replacement]');
    await expect(statusDropdown).toBeVisible();
    await expect(statusSummary).toBeFocused();
    await expect(statusSummary).toHaveAttribute(
      'aria-label',
      /Replacement status filter: Choose a replacement/,
    );
    await expect(statusSelect).toHaveAttribute('name', 'replacement');
    await expect(statusSelect).toHaveAttribute('required', '');
    await expect(statusSelect).toHaveValue('');
    await expect(statusSelect.locator('option[value="used-status"]')).toHaveCount(0);
    await expect(statusSelect.locator('option[value="archived"]')).toHaveCount(0);
    await expect(statusSelect.locator('option[value="persisted-label"]')).toHaveText('Persisted Label');
    await expect(dialog.locator('[data-app-dialog-confirmation-confirm]')).toBeDisabled();

    await statusSummary.click();
    await expect(statusDropdown).toHaveAttribute('open', '');
    await dialog.locator('[data-app-dialog-confirmation-message]').click();
    await expect(statusDropdown).not.toHaveAttribute('open', '');
    await expect(dialog).toBeVisible();

    await statusSummary.click();
    await page.keyboard.press('Escape');
    await expect(statusDropdown).not.toHaveAttribute('open', '');
    await expect(dialog).toBeVisible();
    await expect(statusSummary).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(card('status', 'used-status').locator('[data-project-option-delete]')).toBeFocused();

    await openDelete('status', 'used-status');
    await expect(dialog.locator('[data-project-option-delete-replacement]')).toHaveValue('');
    await expect(dialog.locator('[data-cc-dropdown] [data-cc-dropdown-summary-current]'))
      .toHaveText('Choose a replacement');
    await expect(dialog.locator('[data-app-dialog-confirmation-confirm]')).toBeDisabled();
    await chooseReplacement('persisted-label');
    await expect(dialog.locator('[data-app-dialog-confirmation-confirm]')).toBeEnabled();
    await closeDialog();
    await expect(card('status', 'used-status')).toHaveCount(0);
    expect(db.prepare("SELECT status FROM projects WHERE slug LIKE 'status-%' ORDER BY slug").pluck().all())
      .toEqual(['persisted-label', 'persisted-label']);
    const referencedPost = posts.find(post => post.url.endsWith('/status/used-status/delete'));
    expect([...referencedPost.body.keys()]).toEqual(['_csrf', 'replacement']);
    expect(referencedPost.body.get('replacement')).toBe('persisted-label');

    await openDelete('project-type', 'used-type');
    await expect(dialog).toContainText('1 Project currently uses this type');
    await expect(dialog.locator('[data-cc-dropdown] summary')).toBeFocused();
    await chooseReplacement('comic');
    await closeDialog();
    expect(db.prepare("SELECT project_type FROM projects WHERE slug = 'type-one'").pluck().get()).toBe('comic');

    // Previously unused, now referenced: the authoritative error region changes retry to reassignment.
    await openDelete('status', 'stale-unused');
    insertProject(db, { slug: 'became-referenced', status: 'stale-unused' });
    await closeDialog();
    await expect(region('status').locator('[data-project-option-feedback]'))
      .toHaveAttribute('data-project-option-feedback-code', 'OPTION_REPLACEMENT_REQUIRED');
    await openDelete('status', 'stale-unused');
    await expect(dialog.locator('[data-cc-dropdown]')).toBeVisible();
    await dialog.locator('[data-app-dialog-confirmation-cancel]').click();

    // Previously referenced, now unused: replacement is rejected and retry becomes simple deletion.
    await openDelete('status', 'stale-referenced');
    await chooseReplacement('planned');
    db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('planned', staleReferenced);
    await closeDialog();
    await expect(region('status').locator('[data-project-option-feedback]'))
      .toHaveAttribute('data-project-option-feedback-code', 'OPTION_REPLACEMENT_UNEXPECTED');
    await openDelete('status', 'stale-referenced');
    await expect(dialog.locator('select')).toHaveCount(0);
    await expect(dialog).toContainText('This cannot be undone.');
    await dialog.locator('[data-app-dialog-confirmation-cancel]').click();

    // A vanished replacement is rejected without partial mutation and disappears on retry.
    await openDelete('status', 'stale-target-source');
    await chooseReplacement('stale-target');
    service.deleteOption('status', 'stale-target');
    await closeDialog();
    await expect(region('status').locator('[data-project-option-feedback]'))
      .toHaveAttribute('data-project-option-feedback-code', 'OPTION_REPLACEMENT_INVALID');
    expect(db.prepare("SELECT status FROM projects WHERE slug = 'stale-target-project'").pluck().get())
      .toBe('stale-target-source');
    await openDelete('status', 'stale-target-source');
    await expect(dialog.locator('option[value="stale-target"]')).toHaveCount(0);
    await dialog.locator('[data-app-dialog-confirmation-cancel]').click();
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
