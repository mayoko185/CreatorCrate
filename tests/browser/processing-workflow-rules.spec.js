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
      app,
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

// The rule-row's own surface: a point inside the row that hits no control.
async function rowSurfacePoint(row) {
  return row.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const y = box.top + (box.height / 2);
    for (let x = box.right - 2; x > box.left; x -= 1) {
      if (element.ownerDocument.elementFromPoint(x, y) === element) return { x, y };
    }
    for (let x = box.left + 1; x < box.right; x += 1) {
      if (element.ownerDocument.elementFromPoint(x, box.top + 2) === element) return { x, y: box.top + 2 };
    }
    throw new Error('row has no exposed surface');
  });
}

// A real primary-button press, move, and release (Chromium native drag).
async function mouseDrag(page, from, to, { release = true } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 3, from.y + 3, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  if (release) await page.mouse.up();
}

async function lowerHalf(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + (box.width / 2), y: box.y + (box.height * 0.8) };
}

async function ruleSummaries(rows) {
  return rows.evaluateAll((elements) => elements.map((row) => {
    const type = row.querySelector('[data-processing-rule-operation]').value;
    const value = type === 'replace'
      ? `${row.querySelector('[data-processing-rule-search]').value}>${row.querySelector('[data-processing-rule-replacement]').value}`
      : row.querySelector('[data-processing-rule-text]').value;
    return `${type}:${value}${row.hasAttribute('data-processing-rule-disabled') ? ':off' : ''}`;
  }));
}

async function expectNoDragResidue(dialog) {
  await expect(dialog.locator('.is-dragging, .is-drop-before, .is-drop-after, [data-drop-position]')).toHaveCount(0);
}

test('rule rows reorder by real mouse drag and keyboard within their own list while controls keep working', async ({ page }) => {
  const fixture = await createFixture(page);

  try {
    await page.getByRole('button', { name: 'Image workflows editor', exact: true }).click();
    const dialog = page.locator('#processing-workflow-dialog');
    await expect(dialog).toBeVisible();
    const positive = dialog.locator('[data-processing-rules="positive"]');
    const negative = dialog.locator('[data-processing-rules="negative"]');
    const positiveRows = positive.locator('[data-processing-rule-row]');
    const negativeRows = negative.locator('[data-processing-rule-row]');
    await positive.getByRole('button', { name: 'Add rule', exact: true }).click();
    await positive.getByRole('button', { name: 'Add rule', exact: true }).click();
    await negative.getByRole('button', { name: 'Add rule', exact: true }).click();
    for (const [index, text] of ['one', 'two', 'three'].entries()) {
      await positiveRows.nth(index).locator('[data-processing-rule-text]').fill(text);
    }
    await negativeRows.nth(0).locator('[data-processing-rule-text]').fill('n1');
    await negativeRows.nth(1).locator('[data-processing-rule-text]').fill('n2');
    await positiveRows.nth(1).getByRole('button', { name: 'Disable rule', exact: true }).click();
    await expect(positiveRows.nth(1)).toHaveAttribute('data-processing-rule-disabled', '');

    // Idle rows carry no extra visible affordance.
    const idle = await positiveRows.first().evaluate((row) => {
      const style = getComputedStyle(row);
      return {
        children: Array.from(row.children).map((child) => child.tagName),
        actions: row.querySelector('.processing-rule-actions').children.length,
        opacity: style.opacity,
        boxShadow: style.boxShadow,
        cursor: style.cursor,
        draggable: row.draggable,
        tabIndex: row.tabIndex,
        label: row.getAttribute('aria-label'),
      };
    });
    expect(idle).toEqual({
      children: ['DIV', 'INPUT', 'INPUT', 'INPUT', 'SPAN'],
      actions: 2,
      opacity: '1',
      boxShadow: 'none',
      cursor: 'auto',
      draggable: true,
      tabIndex: 0,
      label: 'Positive rule',
    });

    // A real mouse drag from the row surface (Preview invalidation is unit-tested;
    // this fixture's plain PNG has no workflow metadata, so Apply never enables).
    await mouseDrag(page, await rowSurfacePoint(positiveRows.nth(0)), await lowerHalf(positiveRows.nth(2)));
    await expect.poll(() => ruleSummaries(positiveRows)).toEqual(['remove:two:off', 'remove:three', 'remove:one']);
    await expectNoDragResidue(dialog);
    expect(await ruleSummaries(negativeRows)).toEqual(['remove:n1', 'remove:n2']);
    await expect(positive.locator('[data-processing-rule-reorder-live]')).toHaveText('Positive rule moved to position 3 of 3.');
    await expect(positiveRows.nth(0).getByRole('button', { name: 'Enable rule', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // Positive rows cannot be dropped into the Negative list.
    await mouseDrag(page, await rowSurfacePoint(positiveRows.nth(0)), await lowerHalf(negativeRows.nth(0)));
    await expectNoDragResidue(dialog);
    expect(await ruleSummaries(positiveRows)).toEqual(['remove:two:off', 'remove:three', 'remove:one']);
    expect(await ruleSummaries(negativeRows)).toEqual(['remove:n1', 'remove:n2']);

    // Pressing inside a text input selects text instead of dragging the row.
    const threeInput = positiveRows.nth(1).locator('[data-processing-rule-text]');
    const inputBox = await threeInput.boundingBox();
    await mouseDrag(
      page,
      { x: inputBox.x + 4, y: inputBox.y + (inputBox.height / 2) },
      await lowerHalf(positiveRows.nth(2)),
    );
    await expectNoDragResidue(dialog);
    expect(await ruleSummaries(positiveRows)).toEqual(['remove:two:off', 'remove:three', 'remove:one']);
    const selected = await threeInput.evaluate((input) => [input.selectionStart, input.selectionEnd]);
    expect(selected[1]).toBeGreaterThan(selected[0]);

    // Keys inside an input keep their text behavior.
    await threeInput.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Home');
    await expect(threeInput).toBeFocused();
    expect(await ruleSummaries(positiveRows)).toEqual(['remove:two:off', 'remove:three', 'remove:one']);

    // The focused row moves by keyboard and keeps focus.
    const oneRow = positiveRows.nth(2);
    await oneRow.focus();
    const focusRing = await oneRow.evaluate((row) => getComputedStyle(row).outlineStyle);
    expect(focusRing).not.toBe('none');
    await page.keyboard.press('Home');
    await expect.poll(() => ruleSummaries(positiveRows)).toEqual(['remove:one', 'remove:two:off', 'remove:three']);
    await expect(positiveRows.nth(0)).toBeFocused();
    await expect(positiveRows.nth(0)).toHaveAttribute('aria-posinset', '1');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => ruleSummaries(positiveRows)).toEqual(['remove:two:off', 'remove:one', 'remove:three']);
    await expect(positiveRows.nth(1)).toBeFocused();
    await expect(positive.locator('[data-processing-rule-reorder-live]')).toHaveText('Positive rule moved to position 2 of 3.');

    // The moved disabled row's toggle and X still work; a new row can move.
    await positiveRows.nth(0).getByRole('button', { name: 'Enable rule', exact: true }).click();
    await expect(positiveRows.nth(0)).not.toHaveAttribute('data-processing-rule-disabled', '');
    await positiveRows.nth(2).getByRole('button', { name: 'Remove rule', exact: true }).click();
    await positive.getByRole('button', { name: 'Add rule', exact: true }).click();
    await positiveRows.nth(2).locator('[data-processing-rule-text]').fill('four');
    await mouseDrag(page, await rowSurfacePoint(positiveRows.nth(2)), { ...(await lowerHalf(positiveRows.nth(0))), y: (await positiveRows.nth(0).boundingBox()).y + 3 });
    await expect.poll(() => ruleSummaries(positiveRows)).toEqual(['remove:four', 'remove:two', 'remove:one']);
    await expect(positiveRows.nth(0)).toHaveAttribute('aria-setsize', '3');

    // Preview submits the reordered arrays.
    const plan = page.waitForRequest((request) => request.url().endsWith('/workflow-prompt/plan'));
    await dialog.locator('[data-processing-preview]').click();
    const body = (await plan).postDataJSON();
    expect(body.options.positive.rules.map((rule) => rule.text)).toEqual(['four', 'two', 'one']);
    expect(body.options.negative.rules.map((rule) => rule.text)).toEqual(['n1', 'n2']);
  } finally {
    await fixture.close();
  }
});

test('a reordered preset saves, reloads in its own order, and a drag cut off by closing leaves no residue', async ({ page }) => {
  const fixture = await createFixture(page);

  try {
    const presets = fixture.app.locals.processingPresetService;
    const byName = (name) => presets.listPresets({ operationType: 'workflow-prompt' }).find((preset) => preset.displayName === name);
    const benji = byName('Benji');
    const oliver = byName('Oliver');
    const rulesOf = (preset) => preset.config.positive.rules ?? preset.config.positive;
    const benjiPositive = rulesOf(benji);

    await page.getByRole('button', { name: 'Image workflows editor', exact: true }).click();
    const dialog = page.locator('#processing-workflow-dialog');
    await expect(dialog).toBeVisible();
    const presetDropdown = dialog.locator('#workflow-preset-select-dropdown');
    const modified = dialog.locator('[data-processing-preset-modified]');
    const positiveRows = dialog.locator('[data-processing-rules="positive"] [data-processing-rule-row]');
    const choosePreset = async (name) => {
      await presetDropdown.locator('summary').click();
      const option = presetDropdown.getByRole('radio', { name, exact: true });
      await presetDropdown.locator(`label[for="${await option.getAttribute('id')}"]`).click();
      await expect(presetDropdown.locator('[data-cc-dropdown-summary-current]')).toHaveText(name);
    };

    await choosePreset('Benji');
    const loaded = await ruleSummaries(positiveRows);
    expect(loaded).toHaveLength(2);
    await expect(modified).toBeHidden();

    // An ineffective boundary move leaves the preset clean.
    await positiveRows.nth(0).focus();
    await page.keyboard.press('ArrowUp');
    await expect(modified).toBeHidden();

    await mouseDrag(page, await rowSurfacePoint(positiveRows.nth(0)), await lowerHalf(positiveRows.nth(1)));
    await expect.poll(() => ruleSummaries(positiveRows)).toEqual([loaded[1], loaded[0]]);
    await expect(modified).toBeVisible();

    const update = page.waitForResponse((response) => response.url().endsWith(`/processing/presets/${benji.id}/replace`));
    await dialog.getByRole('button', { name: 'Update preset', exact: true }).click();
    await update;
    await expect(modified).toBeHidden();
    expect(rulesOf(presets.getPreset(benji.id))).toEqual([benjiPositive[1], benjiPositive[0]]);

    await choosePreset('Oliver');
    expect(await ruleSummaries(positiveRows)).toHaveLength(rulesOf(oliver).length);
    await choosePreset('Benji');
    expect(await ruleSummaries(positiveRows)).toEqual([loaded[1], loaded[0]]);
    await expect(modified).toBeHidden();

    // Start a real drag, close the dialog under it, then reopen.
    await mouseDrag(page, await rowSurfacePoint(positiveRows.nth(0)), await lowerHalf(positiveRows.nth(1)), { release: false });
    await expect(positiveRows.nth(0)).toHaveClass(/is-dragging/);
    await dialog.evaluate((element) => element.close());
    await page.mouse.up();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Image workflows editor', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expectNoDragResidue(dialog);

    // One key press moves exactly one position after the reopen.
    await choosePreset('Benji');
    await positiveRows.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => ruleSummaries(positiveRows)).toEqual([loaded[0], loaded[1]]);
    await expect(positiveRows.nth(1)).toBeFocused();
    await expect(modified).toBeVisible();
    expect(rulesOf(presets.getPreset(benji.id))).toEqual([benjiPositive[1], benjiPositive[0]]);
  } finally {
    await fixture.close();
  }
});

test('cloned workflow-rule rows keep unique relationships and independent dropdowns', async ({ page }) => {
  const fixture = await createFixture(page);

  try {
    await page.getByRole('button', { name: 'Image workflows editor', exact: true }).click();
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

test('rule enable/disable toggle sits left of X, matches its size, and toggles by mouse and keyboard', async ({ page }) => {
  const fixture = await createFixture(page);

  try {
    await page.getByRole('button', { name: 'Image workflows editor', exact: true }).click();
    const dialog = page.locator('#processing-workflow-dialog');
    await expect(dialog).toBeVisible();
    const row = dialog.locator('[data-processing-rules="positive"] [data-processing-rule-row]').first();
    const toggle = row.getByRole('button', { name: 'Disable rule', exact: true });
    const remove = row.getByRole('button', { name: 'Remove rule', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('title', 'Disable rule');

    const heightBefore = (await row.boundingBox()).height;
    const toggleBox = await toggle.boundingBox();
    const removeBox = await remove.boundingBox();
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(removeBox.x);
    expect(removeBox.x - (toggleBox.x + toggleBox.width)).toBeLessThan(12);
    expect(Math.abs(toggleBox.y - removeBox.y)).toBeLessThan(2);
    expect(Math.abs(toggleBox.height - removeBox.height)).toBeLessThan(2);
    expect(Math.abs(toggleBox.width - removeBox.width)).toBeLessThan(8);
    await expect(toggle).toHaveText('');

    await row.locator('[data-processing-rule-text]').fill('keep me');
    await toggle.click();
    const enable = row.getByRole('button', { name: 'Enable rule', exact: true });
    await expect(enable).toHaveAttribute('aria-pressed', 'false');
    await expect(row).toHaveAttribute('data-processing-rule-disabled', '');
    await expect(row.locator('[data-processing-rule-text]')).toBeEditable();
    await expect(row.locator('[data-processing-rule-text]')).toHaveValue('keep me');
    expect(Math.abs((await row.boundingBox()).height - heightBefore)).toBeLessThan(1);
    await expect(dialog.locator('[data-processing-rules="positive"] [data-processing-rule-row]')).toHaveCount(1);

    await enable.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(row).not.toHaveAttribute('data-processing-rule-disabled', '');
    await toggle.press('Enter');
    await expect(enable).toHaveAttribute('aria-pressed', 'false');
    const focusRing = await enable.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.outlineStyle} ${style.boxShadow}`;
    });
    expect(focusRing).not.toBe('none none');

    await remove.click();
    await expect(dialog.locator('[data-processing-rules="positive"] [data-processing-rule-row]')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('a late Update answer after switching presets keeps the new preset selected and the next Update on it', async ({ page }) => {
  const fixture = await createFixture(page);

  try {
    const presets = fixture.app.locals.processingPresetService;
    const byName = (name) => presets.listPresets({ operationType: 'workflow-prompt' }).find((preset) => preset.displayName === name);
    const general = byName('General');
    const benji = byName('Benji');
    const benjiBefore = structuredClone(benji.config);
    const firstPositiveText = (preset) => (preset.config.positive.rules ?? preset.config.positive)[0].text;

    await page.getByRole('button', { name: 'Image workflows editor', exact: true }).click();
    const dialog = page.locator('#processing-workflow-dialog');
    await expect(dialog).toBeVisible();
    const select = dialog.locator('[data-processing-preset-select]');
    const presetDropdown = dialog.locator('#workflow-preset-select-dropdown');
    const visiblePreset = presetDropdown.locator('[data-cc-dropdown-summary-current]');
    const modified = dialog.locator('[data-processing-preset-modified]');
    const updateButton = dialog.getByRole('button', { name: 'Update preset', exact: true });
    const positiveRows = dialog.locator('[data-processing-rules="positive"] [data-processing-rule-row]');
    const choosePreset = async (name) => {
      await presetDropdown.locator('summary').click();
      const option = presetDropdown.getByRole('radio', { name, exact: true });
      await presetDropdown.locator(`label[for="${await option.getAttribute('id')}"]`).click();
      await expect(visiblePreset).toHaveText(name);
    };

    await choosePreset('General');
    await expect(select).toHaveValue(String(general.id));
    await positiveRows.first().locator('[data-processing-rule-text]').fill('general edited, ');
    await expect(modified).toBeVisible();

    let releaseGeneral;
    const generalHeld = new Promise((resolve) => { releaseGeneral = resolve; });
    const replaceUrls = [];
    await page.route('**/processing/presets/*/replace', async (route) => {
      replaceUrls.push(new URL(route.request().url()).pathname);
      if (replaceUrls.length === 1) await generalHeld;
      await route.continue();
    });
    const generalAnswer = page.waitForResponse((response) => response.url().endsWith(`/processing/presets/${general.id}/replace`));
    await updateButton.click();
    await expect.poll(() => replaceUrls.length).toBe(1);

    await choosePreset('Benji');
    await expect(select).toHaveValue(String(benji.id));
    const benjiRuleTexts = await positiveRows.evaluateAll((rows) => rows.map((row) => row.querySelector('[data-processing-rule-text]')?.value));
    releaseGeneral();
    await generalAnswer;
    await expect(dialog.locator('[data-processing-status]')).toHaveText('Preset updated.');

    // General received exactly what was sent while it was selected.
    expect(firstPositiveText(presets.getPreset(general.id))).toBe('general edited, ');
    // Benji still owns the native value, the visible label, and the rows.
    await expect(select).toHaveValue(String(benji.id));
    await expect(visiblePreset).toHaveText('Benji');
    expect(await positiveRows.evaluateAll((rows) => rows.map((row) => row.querySelector('[data-processing-rule-text]')?.value)))
      .toEqual(benjiRuleTexts);
    await expect(modified).toBeHidden();
    expect(presets.getPreset(benji.id).config).toEqual(benjiBefore);

    const benjiAnswer = page.waitForResponse((response) => response.url().endsWith(`/processing/presets/${benji.id}/replace`));
    await updateButton.click();
    await benjiAnswer;
    expect(replaceUrls).toEqual([`/processing/presets/${general.id}/replace`, `/processing/presets/${benji.id}/replace`]);
    expect(firstPositiveText(presets.getPreset(general.id))).toBe('general edited, ');
    expect(presets.getPreset(benji.id).config).toEqual(benjiBefore);
    await expect(visiblePreset).toHaveText('Benji');
  } finally {
    await fixture.close();
  }
});
