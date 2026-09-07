import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const ID_REFERENCE_ATTRIBUTES = [
  'aria-controls',
  'aria-labelledby',
  'aria-describedby',
  'aria-activedescendant',
];

let buildRoot;
let viteDistRoot;
let assetManifest;

test.beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-workflow-rules-browser-build-'));
  viteDistRoot = path.join(buildRoot, 'client');
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  assetManifest = createAssetManifest({
    distRoot: viteDistRoot,
    manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json'),
  });
});

test.afterAll(() => {
  if (buildRoot) fs.rmSync(buildRoot, { recursive: true, force: true });
});

async function createFixture(page) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-workflow-rules-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;

  try {
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot,
      assetManifest,
      useViteAssets: true,
      viteDistRoot,
      authState: { csrfPepper },
    });
    const project = app.locals.projectService.create({
      title: 'Workflow Rules Browser',
      status: 'tbd',
    });
    const sourcePath = path.join(projectsRoot, project.project_dir, 'final', 'source.png');
    await sharp({
      create: { width: 12, height: 12, channels: 4, background: '#336699' },
    }).png().toFile(sourcePath);
    app.locals.assetScanner.scanProjectAssets(project.id);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${baseURL}/projects/${project.id}/assets?view=list`, { waitUntil: 'domcontentloaded' });

    return {
      project,
      async close() {
        if (server) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          server = null;
        }
        closeDatabase(db);
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function expectRowRelationships(row) {
  const relationships = await row.evaluate((element, attributes) => {
    const labels = Array.from(element.querySelectorAll('label[for]')).map((label) => ({
      forId: label.htmlFor,
      targetId: label.control?.id || null,
      targetInRow: Boolean(label.control && element.contains(label.control)),
    }));
    const aria = [];
    for (const attribute of attributes) {
      element.querySelectorAll(`[${attribute}]`).forEach((source) => {
        const ids = source.getAttribute(attribute)?.trim().split(/\s+/).filter(Boolean) || [];
        aria.push({
          attribute,
          sourceId: source.id || null,
          references: ids.map((id) => {
            const target = source.ownerDocument.getElementById(id);
            return { id, exists: Boolean(target), targetInRow: Boolean(target && element.contains(target)) };
          }),
        });
      });
    }
    return { labels, aria };
  }, ID_REFERENCE_ATTRIBUTES);

  expect(relationships.labels).toHaveLength(4);
  for (const label of relationships.labels) {
    expect(label.forId).toBe(label.targetId);
    expect(label.targetInRow).toBe(true);
  }
  expect(relationships.aria.map(({ attribute }) => attribute)).toContain('aria-controls');
  for (const relationship of relationships.aria) {
    expect(relationship.references.length).toBeGreaterThan(0);
    for (const reference of relationship.references) {
      expect(reference.exists, `${relationship.attribute} references ${reference.id}`).toBe(true);
      expect(reference.targetInRow, `${relationship.attribute} crosses workflow rows`).toBe(true);
    }
  }
}

test('cloned workflow-rule rows keep unique relationships and independent dropdowns', async ({ page }) => {
  const fixture = await createFixture(page);

  try {
    await page.getByRole('button', { name: 'Edit workflow prompts', exact: true }).click();
    const dialog = page.locator('#processing-workflow-dialog');
    const processingRoot = dialog.locator('[data-processing-root]');
    await expect(dialog).toBeVisible();
    await expect(processingRoot).toHaveAttribute('data-project-id', String(fixture.project.id));

    const positiveRules = dialog.locator('[data-processing-rules="positive"]');
    const positiveRows = positiveRules.locator('[data-processing-rule-row]');
    await expect(positiveRows).toHaveCount(1);
    await positiveRules.getByRole('button', { name: 'Add rule', exact: true }).click();
    await positiveRules.getByRole('button', { name: 'Add rule', exact: true }).click();
    await expect(positiveRows).toHaveCount(3);

    const liveRows = dialog.locator('[data-processing-rule-row]');
    await expect(liveRows).toHaveCount(4);
    const liveIds = await liveRows.locator('[id]').evaluateAll((elements) => elements.map(({ id }) => id));
    expect(liveIds).toHaveLength(32);
    expect(new Set(liveIds).size).toBe(liveIds.length);

    for (let index = 0; index < await liveRows.count(); index += 1) {
      await expectRowRelationships(liveRows.nth(index));
    }

    const first = positiveRows.nth(0);
    const second = positiveRows.nth(1);
    const third = positiveRows.nth(2);
    const firstDropdown = first.locator('[data-cc-dropdown]');
    const secondDropdown = second.locator('[data-cc-dropdown]');
    const thirdDropdown = third.locator('[data-cc-dropdown]');

    await firstDropdown.locator('summary').click();
    await expect(firstDropdown).toHaveAttribute('open', '');
    await expect(firstDropdown.locator('summary')).toHaveAttribute('aria-expanded', 'true');
    await expect(secondDropdown).not.toHaveAttribute('open', '');
    const firstPrepend = first.getByRole('radio', { name: 'Prepend', exact: true });
    const firstPrependId = await firstPrepend.getAttribute('id');
    await first.locator(`label[for="${firstPrependId}"]`).click();
    await expect(firstDropdown.locator('summary')).toBeFocused();
    await expect(first.locator('[data-processing-rule-operation]')).toHaveValue('prepend');
    await expect(first.locator('[data-cc-dropdown-summary-current]')).toHaveText('Prepend');
    await expect(second.locator('[data-processing-rule-operation]')).toHaveValue('remove');
    await expect(third.locator('[data-processing-rule-operation]')).toHaveValue('remove');

    const secondSummary = secondDropdown.locator('summary');
    await secondSummary.focus();
    await secondSummary.press('Enter');
    await expect(secondDropdown).toHaveAttribute('open', '');
    await expect(secondSummary).toHaveAttribute('aria-expanded', 'true');
    await expect(firstDropdown).not.toHaveAttribute('open', '');
    const secondAppend = second.getByRole('radio', { name: 'Append', exact: true });
    await secondAppend.focus();
    await secondAppend.press('Space');
    await expect(second.locator('[data-processing-rule-operation]')).toHaveValue('append');
    await expect(second.locator('[data-cc-dropdown-summary-current]')).toHaveText('Append');
    await expect(first.locator('[data-processing-rule-operation]')).toHaveValue('prepend');
    await expect(third.locator('[data-processing-rule-operation]')).toHaveValue('remove');

    await thirdDropdown.locator('summary').click();
    await expect(thirdDropdown).toHaveAttribute('open', '');
    await expect(secondDropdown).not.toHaveAttribute('open', '');
    const thirdReplace = third.getByRole('radio', { name: 'Replace', exact: true });
    const thirdReplaceId = await thirdReplace.getAttribute('id');
    await third.locator(`label[for="${thirdReplaceId}"]`).click();
    await expect(third.locator('[data-processing-rule-operation]')).toHaveValue('replace');
    await expect(third.locator('[data-processing-rule-text]')).toBeHidden();
    await expect(third.locator('[data-processing-rule-search]')).toBeVisible();
    await expect(first.locator('[data-processing-rule-operation]')).toHaveValue('prepend');
    await expect(second.locator('[data-processing-rule-operation]')).toHaveValue('append');

    for (const row of [first, second, third]) {
      const dropdown = row.locator('[data-cc-dropdown]');
      const summary = dropdown.locator('summary');
      await summary.click();
      await expect(dropdown).toHaveAttribute('open', '');
      await expect(summary).toHaveAttribute('aria-expanded', 'true');
      const panelId = await summary.getAttribute('aria-controls');
      await expect(row.locator(`#${panelId}`)).toBeVisible();
      await summary.press('Escape');
      await expect(dropdown).not.toHaveAttribute('open', '');
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await expectRowRelationships(row);
    }

    await expect(first.locator('[data-processing-rule-operation]')).toHaveValue('prepend');
    await expect(second.locator('[data-processing-rule-operation]')).toHaveValue('append');
    await expect(third.locator('[data-processing-rule-operation]')).toHaveValue('replace');
  } finally {
    await fixture.close();
  }
});
