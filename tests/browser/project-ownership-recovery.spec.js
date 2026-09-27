import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createProjectOwnershipAdoptionRepository } from '../../src/data/project-ownership-adoption-repository.js';
import { resolveProjectDir } from '../../src/storage/project-storage.js';
import { PROJECT_OWNERSHIP_MARKER_FILENAME } from '../../src/storage/project-ownership-marker.js';

test('project ownership recovery: explicit open, confirmation, and live notice update', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-ownership-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const adoption = createProjectOwnershipAdoptionRepository(db);
    adoption.initialize();
    adoption.complete();
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const project = app.locals.projectService.create({ title: 'Moonlight', status: 'tbd' });
    const dir = resolveProjectDir(projectsRoot, db.prepare('SELECT project_dir FROM projects WHERE id = ?').pluck().get(project.id));
    db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(project.id);
    fs.unlinkSync(path.join(dir, PROJECT_OWNERSHIP_MARKER_FILENAME));
    adoption.setClassification(project.id, { status: 'recovery-required', reason: 'manifest-missing' });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('/ownership-recovery')) requests.push(request.method());
    });

    await page.goto(`${base}/projects/${project.id}`);
    const notice = page.locator('[data-project-ownership-notice]');
    await expect(notice).toHaveAttribute('data-project-ownership-notice', 'attention');
    await page.waitForTimeout(300);
    expect(requests).toEqual([]);

    await page.getByRole('button', { name: 'Review project ownership' }).click();
    const dialog = page.locator('#project-ownership-dialog');
    expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
    await expect(dialog.locator('[data-project-ownership-summary]')).toContainText('Recovering confirms');
    const recover = dialog.getByRole('button', { name: 'Recover project ownership' });
    await expect(recover).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Check again' })).toBeHidden();
    expect(requests).toEqual(['GET']);

    await recover.click();
    const confirmation = page.locator('#app-confirmation-dialog');
    await expect(confirmation).toContainText('currently stored folder belongs to “Moonlight”');
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmation).toBeHidden();
    await expect(dialog).toBeVisible();
    expect(requests).toEqual(['GET']);

    await recover.click();
    await confirmation.getByRole('button', { name: 'Recover ownership' }).click();
    await expect(dialog).toBeHidden();
    await expect(notice).toHaveAttribute('data-project-ownership-notice', 'resolved');
    await expect(notice).toContainText('Project folder ownership recovered.');
    expect(requests).toEqual(['GET', 'POST']);
    expect(db.prepare('SELECT state FROM project_directory_ownership WHERE project_id = ?').pluck().get(project.id)).toBe('bound');
    expect(errors).toEqual([]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
