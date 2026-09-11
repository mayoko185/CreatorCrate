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
import { createProcessingJobService } from '../../src/services/processing-job-service.js';
import { createProjectOperationCoordinator } from '../../src/services/project-operation-coordinator.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestPath(request) {
  return new URL(request.url()).pathname;
}

function processingState(page) {
  return page.locator('#processing-convert-dialog [data-processing-root]').evaluate((root) => ({
    busy: root.__ccProcessingBusy,
    jobId: root.__ccProcessingJob?.id || null,
    jobState: root.__ccProcessingJob?.state || null,
    pollGeneration: root.__ccProcessingJobPollGeneration,
    polling: root.__ccProcessingJobPolling !== null && root.__ccProcessingJobPolling !== undefined,
    timer: root.__ccProcessingJobPollTimer !== null && root.__ccProcessingJobPollTimer !== undefined,
    submission: root.__ccProcessingSubmission
      ? { ...root.__ccProcessingSubmission }
      : null,
  }));
}

let buildRoot;
let viteDistRoot;
let assetManifest;

test.beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-browser-build-'));
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

async function createFixture(page, executeConvert) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  const projectOperationCoordinator = createProjectOperationCoordinator();
  const processingJobService = createProcessingJobService({ projectOperationCoordinator });
  const executionCalls = [];
  const renameExecutionCalls = [];
  let server;

  try {
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const alreadyCoordinatedProcessingExecutor = {
      async convertAssets(...args) {
        executionCalls.push(args);
        return executeConvert(...args);
      },
      async renameAssets(_projectId, assetIds, options, updateProgress) {
        renameExecutionCalls.push({ assetIds, options });
        updateProgress({ completed: 0, total: assetIds.length });
        updateProgress({ completed: assetIds.length, total: assetIds.length });
        return { requestedCount: assetIds.length, changedCount: options.renames.length };
      },
    };
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot,
      assetManifest,
      useViteAssets: true,
      viteDistRoot,
      authState: { csrfPepper },
      projectOperationCoordinator,
      processingJobService,
      alreadyCoordinatedProcessingExecutor,
    });
    const project = app.locals.projectService.create({
      title: 'Processing Browser Lifecycle',
      status: 'tbd',
    });
    expect(project.id).toBe(1);

    const sourcePath = path.join(projectsRoot, project.project_dir, 'final', 'source.png');
    await sharp({
      create: { width: 12, height: 12, channels: 4, background: '#336699' },
    }).png().toFile(sourcePath);
    const secondSourcePath = path.join(projectsRoot, project.project_dir, 'final', 'second.jpg');
    await sharp({
      create: { width: 12, height: 12, channels: 3, background: '#993366' },
    }).jpeg().toFile(secondSourcePath);
    app.locals.assetScanner.scanProjectAssets(project.id);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${baseURL}/projects/${project.id}/assets?view=list`, { waitUntil: 'domcontentloaded' });

    const dialog = page.locator('#processing-convert-dialog');
    const processingRoot = dialog.locator('[data-processing-root]');
    await expect(processingRoot).toHaveAttribute('data-project-id', String(project.id));
    await expect(processingRoot).toHaveAttribute('data-project-id', '1');

    return {
      app,
      baseURL,
      db,
      dialog,
      executionCalls,
      processingJobService,
      project,
      projectOperationCoordinator,
      renameExecutionCalls,
      root,
      secondSourcePath,
      sourcePath,
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

async function openAndPreviewConvert(page, fixture) {
  await page.locator('.asset-select-checkbox').first().setChecked(true);
  await page.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(fixture.dialog).toBeVisible();
  await expect(fixture.dialog.locator('[data-processing-root]')).toHaveAttribute(
    'data-project-id',
    String(fixture.project.id),
  );

  const previewResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && requestPath(response.request()) === `/projects/${fixture.project.id}/assets/processing/convert/plan`
  ));
  await fixture.dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  expect((await previewResponse).status()).toBe(200);
  await expect(fixture.dialog.locator('[data-processing-status]')).toHaveText('Preview ready.');
  await expect(fixture.dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
}

function startCoordinatorHolder(fixture) {
  const release = deferred();
  const jobId = fixture.processingJobService.enqueue({
    projectId: fixture.project.id,
    operation: 'browser-test-holder',
    assetCount: 0,
    execute: () => release.promise,
  });
  return { jobId, release };
}

test('Project Assets scan notices keep compact readable spacing at desktop and narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await createFixture(page, async () => ({ convertedCount: 0 }));

  try {
    await Promise.all([
      page.waitForURL(/scan_result=ok/),
      page.getByRole('button', { name: 'Scan Now', exact: true }).click(),
    ]);

    const scanNotice = page.locator('.scan-success').first();
    await expect(scanNotice).toBeVisible();

    const readMetrics = () => scanNotice.evaluate((node) => {
      const paragraph = node.querySelector('p');
      const style = getComputedStyle(node);
      const paragraphStyle = getComputedStyle(paragraph);
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      return {
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        paragraphMargins: [paragraphStyle.marginTop, paragraphStyle.marginBottom],
        lineCount: range.getClientRects().length,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });

    expect(await readMetrics()).toEqual({
      padding: ['8px', '20px', '8px', '20px'],
      paragraphMargins: ['0px', '0px'],
      lineCount: 1,
      clientHeight: expect.any(Number),
      scrollHeight: expect.any(Number),
      clientWidth: 1440,
      scrollWidth: 1440,
    });
    let metrics = await readMetrics();
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);

    await page.setViewportSize({ width: 375, height: 667 });
    metrics = await readMetrics();
    expect(metrics.padding).toEqual(['8px', '20px', '8px', '20px']);
    expect(metrics.paragraphMargins).toEqual(['0px', '0px']);
    expect(metrics.lineCount).toBeGreaterThan(1);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
    expect(metrics.scrollWidth).toBe(metrics.clientWidth);
    expect(metrics.clientWidth).toBe(375);
  } finally {
    await fixture.close();
  }
});

test('Project Assets action cards and Rename dialog remain contained across desktop and narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await createFixture(page, async () => ({ convertedCount: 0 }));

  try {
    const category = fixture.db.prepare(`
      SELECT id
      FROM project_asset_categories
      WHERE project_id = ? AND directory_slug = 'final'
    `).get(fixture.project.id);
    const longCategoryName = `Final ${'unbroken'.repeat(14)} renders`;
    fixture.db.prepare('UPDATE project_asset_categories SET display_name = ? WHERE id = ?')
      .run(longCategoryName, category.id);
    fixture.db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('open_locally.windows_projects_path', 'D:\\example');
    const missingPath = path.join(path.dirname(fixture.sourcePath), 'missing-heading-action.png');
    fs.copyFileSync(fixture.sourcePath, missingPath);
    fixture.app.locals.assetScanner.scanProjectAssets(fixture.project.id);
    fs.rmSync(missingPath);
    for (let index = 0; index < 6; index += 1) {
      const filename = `${'x'.repeat(72)}-${index}.png`;
      fs.copyFileSync(fixture.sourcePath, path.join(path.dirname(fixture.sourcePath), filename));
    }
    fixture.app.locals.assetScanner.scanProjectAssets(fixture.project.id);

    const expectNoDocumentOverflow = async () => {
      const viewport = page.viewportSize();
      expect(await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollX: window.scrollX,
        overflowing: Array.from(document.querySelectorAll('body *')).map((node) => {
          const rect = node.getBoundingClientRect();
          return { node, rect };
        }).filter(({ node, rect }) => !node.closest('.asset-filter-multiselect-summary')
          && rect.width > 0
          && (rect.left < -1.5 || rect.right > document.documentElement.clientWidth + 0.5))
          .slice(0, 8).map(({ node, rect }) => ({
            tag: node.tagName,
            className: node.className?.baseVal ?? node.className ?? '',
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          })),
        tooltipOverflowing: Array.from(document.querySelectorAll('[data-tooltip]')).map((node) => {
          const rect = node.getBoundingClientRect();
          const pseudo = getComputedStyle(node, '::after');
          const width = parseFloat(pseudo.width) + parseFloat(pseudo.paddingLeft) + parseFloat(pseudo.paddingRight)
            + parseFloat(pseudo.borderLeftWidth) + parseFloat(pseudo.borderRightWidth);
          const left = pseudo.right === '0px' ? rect.right - width
            : (pseudo.left === '0px' ? rect.left : rect.left + (rect.width - width) / 2);
          return { label: node.dataset.tooltip, left: Math.round(left), right: Math.round(left + width), width: Math.round(width) };
        }).filter(({ left, right }) => left < 0 || right > document.documentElement.clientWidth),
      }))).toEqual({ clientWidth: viewport.width, scrollWidth: viewport.width, scrollX: 0, overflowing: [], tooltipOverflowing: [] });
    };
    const expectEstablishedIconControls = async (controls, expectedIcon = [20, 20]) => {
      const metrics = await controls.evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const icon = node.querySelector('svg')?.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          width: rect.width,
          height: rect.height,
          icon: icon ? [icon.width, icon.height] : null,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        };
      }));
      expect(metrics.length).toBeGreaterThan(0);
      for (const metric of metrics) {
        expect(metric.width).toBeGreaterThanOrEqual(36);
        expect(metric.height).toBe(38);
        expect(metric.icon).toEqual(expectedIcon);
        expect(metric.padding).toEqual(['8px', '8px', '8px', '8px']);
      }
    };

    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?category=${category.id}&view=grid`);
    const desktopPanel = page.locator('[data-asset-actions-panel]').first();
    const desktopGroups = desktopPanel.locator('.asset-action-group');
    await expect(desktopGroups).toHaveCount(3);
    const desktopLayout = await desktopGroups.evaluateAll((groups) => groups.map((group) => {
      const rect = group.getBoundingClientRect();
      return { heading: group.querySelector('h3').textContent.trim(), left: rect.left, right: rect.right, top: rect.top, width: rect.width };
    }));
    expect(desktopLayout.map(({ heading }) => heading)).toEqual(['Release', 'File', 'Processing']);
    expect(desktopLayout[1].width).toBeGreaterThan(desktopLayout[0].width);
    expect(desktopLayout[1].width).toBeGreaterThan(desktopLayout[2].width);
    expect(desktopLayout[0].width).toBeGreaterThan(desktopLayout[2].width);
    expect(new Set(desktopLayout.map(({ top }) => Math.round(top))).size).toBe(1);
    const desktopGroupBounds = await desktopPanel.locator('.asset-action-groups').boundingBox();
    const desktopBodyRow = await desktopPanel.locator('.project-detail-section-body').evaluate((body) => {
      const cards = body.querySelector('.asset-action-groups').getBoundingClientRect();
      const utilities = body.querySelector('.asset-actions-category-row').getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const bodyStyle = getComputedStyle(body);
      const utilityControls = Array.from(body.querySelectorAll('.asset-selection-tools .project-filter-control'));
      return {
        bodyContentLeft: Math.round(bodyRect.left + parseFloat(bodyStyle.paddingLeft)),
        bodyContentRight: Math.round(bodyRect.right - parseFloat(bodyStyle.paddingRight)),
        cardsLeft: Math.round(cards.left),
        cardsRight: Math.round(cards.right),
        cardsTop: Math.round(cards.top),
        utilitiesLeft: Math.round(utilities.left),
        utilitiesRight: Math.round(utilities.right),
        utilitiesTop: Math.round(utilities.top),
        utilityLabels: utilityControls.map((node) => node.getAttribute('aria-label')),
      };
    });
    expect(desktopBodyRow.cardsLeft).toBe(desktopBodyRow.bodyContentLeft);
    expect(desktopBodyRow.utilitiesRight).toBe(desktopBodyRow.bodyContentRight);
    expect(desktopBodyRow.cardsTop).toBe(desktopBodyRow.utilitiesTop);
    expect(desktopBodyRow.utilitiesLeft - desktopBodyRow.cardsRight).toBeGreaterThanOrEqual(16);
    expect(desktopBodyRow.utilityLabels).toEqual(['Select all visible', 'Clear selection', 'Manage Categories']);
    expect(desktopGroupBounds.width).toBeLessThan(desktopBodyRow.utilitiesLeft - desktopBodyRow.cardsLeft);

    const desktopFileGroup = desktopGroups.filter({ has: page.getByRole('heading', { name: 'File', exact: true }) });
    const desktopFileField = desktopFileGroup.locator('.bulk-move-field');
    const desktopFileControls = desktopFileGroup.locator('.project-filter-control');
    const desktopFileRow = await desktopFileGroup.locator('.asset-action-group-controls').evaluate((controls) => {
      const items = Array.from(controls.children).map((node) => node.getBoundingClientRect());
      const trigger = controls.querySelector('.bulk-move-field summary').getBoundingClientRect();
      return {
        centers: items.map(({ top, height }) => Math.round(top + height / 2)),
        gaps: items.slice(1).map((item, index) => Math.round(item.left - items[index].right)),
        visibleDropdownGap: Math.round(items[1].left - trigger.right),
        reservedFieldTail: Math.round(items[0].right - trigger.right),
        fieldWidth: items[0].width,
        controlsLeft: items[0].left,
        controlsRight: items.at(-1).right,
        containerLeft: controls.getBoundingClientRect().left,
        containerRight: controls.getBoundingClientRect().right,
      };
    });
    expect(new Set(desktopFileRow.centers).size).toBe(1);
    expect(desktopFileRow.gaps).toEqual([8, 8, 8, 8, 8]);
    expect(desktopFileRow.visibleDropdownGap).toBe(8);
    expect(desktopFileRow.reservedFieldTail).toBe(0);
    expect(desktopFileRow.fieldWidth).toBeGreaterThanOrEqual(160);
    expect(desktopFileRow.fieldWidth).toBeLessThanOrEqual(192);
    expect(Math.abs(desktopFileRow.controlsLeft - desktopFileRow.containerLeft)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(desktopFileRow.controlsRight - desktopFileRow.containerRight)).toBeLessThanOrEqual(0.5);
    expect(await desktopFileControls.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))))
      .toEqual(['Convert', 'Rename', 'Move selected', 'Copy selected', 'Delete selected']);
    const moveIconMarkup = await desktopFileGroup.getByRole('button', { name: 'Move selected', exact: true })
      .locator('svg').innerHTML();
    const openLocallyIconMarkup = await page.locator('.asset-viewer-display-controls')
      .getByRole('link', { name: 'Open locally', exact: true })
      .locator('svg').innerHTML();
    expect(moveIconMarkup).not.toBe(openLocallyIconMarkup);
    await expectEstablishedIconControls(desktopFileControls, [18, 20]);

    const desktopFileDropdown = desktopFileField.locator('[data-cc-dropdown]');
    await desktopFileDropdown.locator('summary').click();
    await desktopFileDropdown.locator('.asset-filter-multiselect-panel label', { hasText: longCategoryName }).click();
    await expect(desktopFileDropdown.locator('[data-cc-dropdown-summary-current]')).toHaveText(longCategoryName);
    const longCategoryGeometry = await desktopFileGroup.locator('.asset-action-group-controls').evaluate((controls) => {
      const field = controls.querySelector('.bulk-move-field').getBoundingClientRect();
      const trigger = controls.querySelector('.bulk-move-field summary').getBoundingClientRect();
      const convert = controls.querySelector('[aria-label="Convert"]').getBoundingClientRect();
      return {
        fieldWidth: Math.round(field.width),
        triggerWidth: Math.round(trigger.width),
        visibleDropdownGap: Math.round(convert.left - trigger.right),
      };
    });
    expect(longCategoryGeometry.fieldWidth).toBeLessThanOrEqual(192);
    expect(longCategoryGeometry.triggerWidth).toBe(longCategoryGeometry.fieldWidth);
    expect(longCategoryGeometry.visibleDropdownGap).toBe(8);
    await expectNoDocumentOverflow();

    for (const fieldSelector of ['.bulk-move-field', '.bulk-release-field']) {
      const field = desktopPanel.locator(fieldSelector);
      const dropdown = field.locator('[data-cc-dropdown]');
      await dropdown.locator('summary').click();
      await expect(dropdown).toHaveAttribute('open', '');
      const clipping = await field.evaluate((node) => {
        const actionPanel = node.closest('.asset-actions-panel');
        const card = node.closest('.asset-action-group');
        const panel = node.querySelector('.asset-filter-multiselect-panel');
        const panelRect = panel.getBoundingClientRect();
        const actionRect = actionPanel.getBoundingClientRect();
        return {
          actionOverflow: getComputedStyle(actionPanel).overflow,
          cardOverflow: getComputedStyle(card).overflow,
          panelBottom: panelRect.bottom,
          actionBottom: actionRect.bottom,
          panelBorderBottomWidth: getComputedStyle(panel).borderBottomWidth,
        };
      });
      expect(clipping.actionOverflow).toBe('visible');
      expect(clipping.cardOverflow).toBe('visible');
      expect(clipping.panelBottom).toBeGreaterThan(clipping.actionBottom);
      expect(clipping.panelBorderBottomWidth).toBe('1px');
      await dropdown.locator('summary').click();
    }
    await expectNoDocumentOverflow();

    await page.setViewportSize({ width: 375, height: 667 });

    for (const view of ['grid', 'list']) {
      await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?category=${category.id}&view=${view}`);
      await expectNoDocumentOverflow();

      const metadata = page.locator('.asset-results-metadata');
      await expect(metadata.locator('[data-selected-count]')).toHaveText('0 of 9 selected');
      await expect(metadata.locator('.asset-results-category')).toHaveText(`Category: ${longCategoryName}`);
      const metadataLayout = await metadata.evaluate((node) => {
        const container = node.getBoundingClientRect();
        return Array.from(node.children).map((child) => {
          const rect = child.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, containerLeft: container.left, containerRight: container.right };
        });
      });
      expect(metadataLayout).toHaveLength(2);
      expect(metadataLayout[1].top).toBeGreaterThan(metadataLayout[0].top);
      for (const item of metadataLayout) {
        expect(item.left).toBeGreaterThanOrEqual(item.containerLeft);
        expect(item.right).toBeLessThanOrEqual(item.containerRight);
      }

      const headingActions = page.locator('.page-heading-actions .project-assets-heading-action');
      await expect(headingActions).toHaveCount(3);
      expect(await headingActions.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))))
        .toEqual(['Scan Now', 'Remove missing assets', 'Edit project']);
      await expectEstablishedIconControls(headingActions);

      const toolbar = page.locator('[data-project-assets-live-region] .asset-viewer-display-controls .project-filter-actions--projects');
      const toolbarLabels = await toolbar.locator('.project-filter-control').evaluateAll(
        (nodes) => nodes.map((node) => node.getAttribute('aria-label')),
      );
      expect(toolbarLabels).toEqual([
        'Filter assets',
        'Project Assets defaults',
        'Open locally',
        expect.stringMatching(/^(Enable|Disable) NSFW filter$/),
        'Start slideshow',
      ]);
      await expectEstablishedIconControls(toolbar.locator('.project-filter-control'));
      const rowMetrics = await page.evaluate(() => {
        const measure = (containerSelector, controlSelector) => {
          const container = document.querySelector(containerSelector);
          const controls = Array.from(container.querySelectorAll(controlSelector));
          const rects = controls.map((node) => node.getBoundingClientRect());
          return {
            right: Math.round(rects.at(-1).right),
            containerRight: Math.round(container.getBoundingClientRect().right),
            gaps: rects.slice(1).map((rect, index) => Math.round(rect.left - rects[index].right)),
          };
        };
        return {
          heading: measure('.page-heading-actions', '.project-assets-heading-action'),
          toolbar: measure('[data-project-assets-live-region] .project-filter-actions--projects', '.project-filter-control'),
        };
      });
      expect(rowMetrics.heading.gaps).toEqual([8, 8]);
      expect(rowMetrics.toolbar.gaps).toEqual([8, 8, 8, 8]);
      expect(rowMetrics.heading.right).toBe(rowMetrics.heading.containerRight);
      expect(rowMetrics.toolbar.right).toBe(rowMetrics.toolbar.containerRight);
      expect(Math.abs(rowMetrics.heading.right - rowMetrics.toolbar.right)).toBeLessThanOrEqual(1);

      const panel = page.locator('[data-asset-actions-panel]').first();
      const mobileBodyLayout = await panel.locator('.project-detail-section-body').evaluate((body) => {
        const cards = body.querySelector('.asset-action-groups').getBoundingClientRect();
        const utilities = body.querySelector('.asset-actions-category-row').getBoundingClientRect();
        return {
          cardsTop: Math.round(cards.top),
          cardsLeft: Math.round(cards.left),
          cardsRight: Math.round(cards.right),
          utilitiesTop: Math.round(utilities.top),
          utilitiesLeft: Math.round(utilities.left),
          utilitiesRight: Math.round(utilities.right),
        };
      });
      expect(mobileBodyLayout.utilitiesTop).toBeGreaterThan(mobileBodyLayout.cardsTop);
      expect(mobileBodyLayout.cardsLeft).toBeGreaterThanOrEqual(0);
      expect(mobileBodyLayout.cardsRight).toBeLessThanOrEqual(375);
      expect(mobileBodyLayout.utilitiesLeft).toBeGreaterThanOrEqual(0);
      expect(mobileBodyLayout.utilitiesRight).toBeLessThanOrEqual(375);
      const mobileGroups = await panel.locator('.asset-action-group').evaluateAll((groups) => groups.map((group) => {
        const rect = group.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top };
      }));
      expect(new Set(mobileGroups.map(({ top }) => Math.round(top))).size).toBe(3);
      for (const group of mobileGroups) {
        expect(group.left).toBeGreaterThanOrEqual(0);
        expect(group.right).toBeLessThanOrEqual(375);
      }
      for (const [heading, fieldClass, minimumWidth, labels] of [
        ['Release', '.bulk-release-field', 160, ['Add to release', 'New release']],
        ['File', '.bulk-move-field', 160, ['Convert', 'Rename', 'Move selected', 'Copy selected', 'Delete selected']],
      ]) {
        const group = panel.locator('.asset-action-group').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
        const field = await group.locator(fieldClass).boundingBox();
        expect(field.width).toBeGreaterThanOrEqual(minimumWidth);
        const controls = group.locator('.project-filter-control');
        expect(await controls.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))).toEqual(labels);
        await expectEstablishedIconControls(controls, [18, 20]);
      }
      const mobileFileDropdown = panel.locator('.bulk-move-field [data-cc-dropdown]');
      await mobileFileDropdown.locator('summary').click();
      await expect(mobileFileDropdown).toHaveAttribute('open', '');
      const mobileDropdownBounds = await mobileFileDropdown.locator('.asset-filter-multiselect-panel').boundingBox();
      expect(mobileDropdownBounds.x).toBeGreaterThanOrEqual(0);
      expect(mobileDropdownBounds.x + mobileDropdownBounds.width).toBeLessThanOrEqual(375);
      await mobileFileDropdown.locator('summary').click();
      const processingControls = panel.locator('.processing-action-group .project-filter-control');
      expect(await processingControls.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))))
        .toEqual(['Watermark', 'Image workflows editor', 'Archives']);
      await expectEstablishedIconControls(processingControls, [18, 20]);

      const details = view === 'grid'
        ? page.locator('.asset-card--project .asset-details-link').first()
        : page.locator('.asset-list-card--project .asset-details-link').first();
      expect(await details.evaluate((node) => {
        const style = getComputedStyle(node);
        const iconStyle = getComputedStyle(node.querySelector('svg'));
        return [style.width, style.height, iconStyle.width, iconStyle.height];
      })).toEqual(['32px', '32px', '20px', '20px']);
    }

    await page.goto(`${fixture.baseURL}/assets?view=grid`);
    const globalDetails = page.locator('.asset-card:not(.asset-card--project) .asset-details-link').first();
    await expect(globalDetails).toBeVisible();
    expect(await globalDetails.evaluate((node) => {
      const style = getComputedStyle(node);
      const iconStyle = getComputedStyle(node.querySelector('svg'));
      return [style.width, style.height, iconStyle.width, iconStyle.height];
    })).toEqual(['28px', '28px', '18px', '18px']);

    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?category=${category.id}&view=list`);
    const checkboxes = page.locator('.asset-select-checkbox');
    await expect(checkboxes).toHaveCount(8);
    for (const checkbox of await checkboxes.all()) await checkbox.setChecked(true);
    await page.getByRole('button', { name: 'Rename', exact: true }).click();

    const dialog = page.locator('#processing-rename-dialog');
    const renameList = dialog.locator('[data-processing-rename-list]');
    await expect(dialog).toBeVisible();
    await expect(renameList.locator('.processing-rename-item')).toHaveCount(8);
    const dialogLayout = await dialog.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const list = node.querySelector('[data-processing-rename-list]');
      const firstRow = list.querySelector('.processing-rename-item');
      const firstField = firstRow.querySelector('.asset-card-rename-field');
      const firstInput = firstField.querySelector('input');
      const body = node.querySelector('.app-dialog-body');
      return {
        dialog: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        list: { clientWidth: list.clientWidth, scrollWidth: list.scrollWidth, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight,
          overflowX: getComputedStyle(list).overflowX, overflowY: getComputedStyle(list).overflowY },
        row: { clientWidth: firstRow.clientWidth, scrollWidth: firstRow.scrollWidth },
        field: { clientWidth: firstField.clientWidth, scrollWidth: firstField.scrollWidth },
        inputWidth: firstInput.getBoundingClientRect().width,
        bodyOverflowY: getComputedStyle(body).overflowY,
      };
    });
    expect(dialogLayout.dialog.left).toBeGreaterThanOrEqual(0);
    expect(dialogLayout.dialog.right).toBeLessThanOrEqual(375);
    expect(dialogLayout.dialog.top).toBeGreaterThanOrEqual(0);
    expect(dialogLayout.dialog.bottom).toBeLessThanOrEqual(667);
    expect(dialogLayout.list.scrollWidth).toBeLessThanOrEqual(dialogLayout.list.clientWidth);
    expect(dialogLayout.row.scrollWidth).toBeLessThanOrEqual(dialogLayout.row.clientWidth);
    expect(dialogLayout.field.scrollWidth).toBeLessThanOrEqual(dialogLayout.field.clientWidth);
    expect(dialogLayout.list.scrollHeight).toBeGreaterThan(dialogLayout.list.clientHeight);
    expect(dialogLayout.list.overflowX).toBe('hidden');
    expect(dialogLayout.list.overflowY).toBe('auto');
    expect(dialogLayout.bodyOverflowY).toBe('auto');
    expect(dialogLayout.inputWidth).toBeGreaterThan(160);
    await expect(renameList.locator('.asset-rename-extension').first()).toHaveText(/\.(?:jpg|png)/);
    await expect(dialog.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expectNoDocumentOverflow();
  } finally {
    await fixture.close();
  }
});

test('Rename populates current selections and reuses plan, apply, polling, rescan, and live refresh', async ({ page }) => {
  const requests = [];
  const fixture = await createFixture(page, async () => ({ convertedCount: 0 }));
  page.on('request', (request) => requests.push({
    method: request.method(),
    path: requestPath(request),
    body: request.postDataJSON?.(),
  }));

  try {
    let renameButton = page.getByRole('button', { name: 'Rename', exact: true });
    await expect(renameButton).toBeDisabled();

    const checkboxes = page.locator('.asset-select-checkbox');
    await expect(checkboxes).toHaveCount(2);
    await checkboxes.nth(0).setChecked(true);
    await expect(renameButton).toBeEnabled();
    await checkboxes.nth(1).setChecked(true);
    await expect(renameButton).toBeEnabled();

    const selected = await checkboxes.evaluateAll((nodes) => nodes.map((node) => ({
      assetId: Number(node.value),
      basename: node.dataset.assetBasename,
      filename: node.dataset.assetFilename,
      extension: node.dataset.assetExtension,
    })));
    await renameButton.focus();
    await renameButton.press('Enter');

    const dialog = page.locator('#processing-rename-dialog');
    await expect(dialog).toBeVisible();
    const inputs = dialog.locator('[data-processing-rename-basename]');
    await expect(inputs).toHaveCount(2);
    await expect(inputs.nth(0)).toBeFocused();
    for (let index = 0; index < selected.length; index += 1) {
      await expect(inputs.nth(index)).toHaveValue(selected[index].basename);
      await expect(inputs.nth(index)).toHaveAttribute('data-asset-id', String(selected[index].assetId));
      await expect(dialog.getByText(selected[index].filename, { exact: true })).toBeVisible();
      await expect(inputs.nth(index).locator('xpath=following-sibling::*[1]')).toHaveText(`.${selected[index].extension}`);
    }

    const basenames = ['first-renamed', 'second-renamed'];
    await inputs.nth(0).fill(basenames[0]);
    await inputs.nth(1).fill(basenames[1]);
    const planPath = `/projects/${fixture.project.id}/assets/processing/rename/plan`;
    const applyPath = `/projects/${fixture.project.id}/assets/processing/rename/apply`;
    const expectedBody = {
      scope: { type: 'selected', assetIds: selected.map(({ assetId }) => assetId) },
      options: {
        renames: selected.map(({ assetId }, index) => ({ assetId, basename: basenames[index] })),
      },
    };

    const planResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST' && requestPath(response.request()) === planPath
    ));
    await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
    expect((await planResponse).status()).toBe(200);
    expect(requests.find(({ method, path }) => method === 'POST' && path === planPath)?.body).toEqual(expectedBody);
    await expect(dialog.locator('[data-processing-plan-items]')).toContainText('first-renamed');
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

    await inputs.nth(0).fill('first-renamed-again');
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await inputs.nth(0).fill(basenames[0]);
    await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

    const applyResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST' && requestPath(response.request()) === applyPath
    ));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await applyResponse).status()).toBe(202);
    await expect(dialog.locator('[data-processing-status]')).toHaveText('Applied. Assets refreshed.', { timeout: 10_000 });
    expect(requests.find(({ method, path }) => method === 'POST' && path === applyPath)?.body).toEqual(expectedBody);
    expect(fixture.renameExecutionCalls).toEqual([{
      assetIds: expectedBody.scope.assetIds,
      options: expectedBody.options,
    }]);
    expect(requests.some(({ method, path }) => method === 'POST' && path === `/projects/${fixture.project.id}/scan`)).toBe(true);
    await dialog.getByRole('button', { name: 'Close Rename', exact: true }).click();
    await expect(dialog).toBeHidden();

    renameButton = page.getByRole('button', { name: 'Rename', exact: true });
    await expect(renameButton).toBeDisabled();
    const replacementCheckboxes = page.locator('.asset-select-checkbox');
    await replacementCheckboxes.nth(1).setChecked(true);
    await expect(renameButton).toBeEnabled();
    await renameButton.press('Enter');
    await expect(inputs).toHaveCount(1);
    await expect(inputs.nth(0)).toHaveValue(selected[1].basename);
    await expect(inputs.nth(0)).toHaveAttribute('data-asset-id', String(selected[1].assetId));
    await inputs.nth(0).press('Escape');
    await expect(dialog).toBeHidden();
    await expect(renameButton).toBeFocused();
  } finally {
    await fixture.close();
  }
});

test('close and reopen before a delayed 202 keeps only the reopened generation polling', async ({ page }) => {
  const applyCaptured = deferred();
  const releaseApplyResponse = deferred();
  const applyFulfilled = deferred();
  const requests = [];
  const fixture = await createFixture(page, async () => ({
    convertedCount: 1,
    requestedCount: 1,
    convertedAssetIds: [],
    assets: [],
    format: 'webp',
    quality: 85,
    originalHandling: 'keep',
  }));
  const holder = startCoordinatorHolder(fixture);
  const applyPath = `/projects/${fixture.project.id}/assets/processing/convert/apply`;

  page.on('request', (request) => requests.push({ method: request.method(), path: requestPath(request) }));
  await page.route(`**${applyPath}`, async (route) => {
    try {
      const response = await route.fetch();
      const payload = await response.json();
      applyCaptured.resolve({ payload, status: response.status() });
      await releaseApplyResponse.promise;
      await route.fulfill({ response });
      applyFulfilled.resolve();
    } catch (error) {
      applyCaptured.reject(error);
      applyFulfilled.reject(error);
      throw error;
    }
  });

  try {
    await expect.poll(() => fixture.processingJobService.getJob(holder.jobId)?.state).toBe('running');
    await openAndPreviewConvert(page, fixture);
    await fixture.dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    const captured = await applyCaptured.promise;
    expect(captured.status).toBe(202);
    expect(captured.payload.jobId).toEqual(expect.any(String));
    await expect.poll(() => fixture.processingJobService.getJob(captured.payload.jobId)?.state).toBe('queued');

    await fixture.dialog.getByRole('button', { name: 'Close Convert', exact: true }).click();
    await expect(fixture.dialog).toBeHidden();
    await page.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(fixture.dialog).toBeVisible();
    expect((await processingState(page)).submission).toMatchObject({ closed: false });

    holder.release.resolve({ held: true });
    await expect.poll(() => fixture.processingJobService.getJob(captured.payload.jobId)?.state).toBe('succeeded');
    expect(fixture.executionCalls).toHaveLength(1);
    releaseApplyResponse.resolve();
    await applyFulfilled.promise;

    await expect(fixture.dialog.locator('[data-processing-status]')).toHaveText('Applied. Assets refreshed.');
    const jobPath = `/processing/jobs/${captured.payload.jobId}`;
    expect(requests.filter(({ method, path }) => method === 'GET' && path === jobPath)).toHaveLength(1);
    expect(requests.filter(({ method, path }) => method === 'POST' && path === `${jobPath}/cancel`)).toHaveLength(0);
    expect(await processingState(page)).toMatchObject({
      busy: false,
      jobId: null,
      polling: false,
      timer: false,
      submission: null,
    });
  } finally {
    holder.release.resolve({ held: true });
    releaseApplyResponse.resolve();
    await page.unroute(`**${applyPath}`).catch(() => {});
    await fixture.close();
  }
});

test('closing a genuinely queued job cancels once and prevents delayed execution', async ({ page }) => {
  const requests = [];
  const fixture = await createFixture(page, async () => ({ convertedCount: 1 }));
  const holder = startCoordinatorHolder(fixture);
  page.on('request', (request) => requests.push({ method: request.method(), path: requestPath(request) }));

  try {
    await expect.poll(() => fixture.processingJobService.getJob(holder.jobId)?.state).toBe('running');
    await openAndPreviewConvert(page, fixture);
    const applyResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && requestPath(response.request()) === `/projects/${fixture.project.id}/assets/processing/convert/apply`
    ));
    await fixture.dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    const applyResponse = await applyResponsePromise;
    expect(applyResponse.status()).toBe(202);
    const { jobId } = await applyResponse.json();
    await expect.poll(() => fixture.processingJobService.getJob(jobId)?.state).toBe('queued');

    const cancelPath = `/processing/jobs/${jobId}/cancel`;
    const cancellationResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST' && requestPath(response.request()) === cancelPath
    ));
    await fixture.dialog.getByRole('button', { name: 'Close Convert', exact: true }).click();
    expect((await cancellationResponse).status()).toBe(200);
    await expect.poll(() => fixture.processingJobService.getJob(jobId)?.state).toBe('cancelled');

    holder.release.resolve({ held: true });
    await expect.poll(() => fixture.processingJobService.getJob(holder.jobId)?.state).toBe('succeeded');
    expect(fixture.processingJobService.getJob(jobId)?.state).toBe('cancelled');
    expect(fixture.executionCalls).toHaveLength(0);
    expect(fs.existsSync(fixture.sourcePath.replace(/\.png$/u, '.webp'))).toBe(false);
    expect(requests.filter(({ method, path }) => method === 'POST' && path === cancelPath)).toHaveLength(1);
    expect(await processingState(page)).toMatchObject({
      busy: false,
      jobId: null,
      polling: false,
      timer: false,
      submission: null,
    });
  } finally {
    holder.release.resolve({ held: true });
    await fixture.close();
  }
});

test('overlapping stale and current polls complete, rescan, and refresh exactly once', async ({ page }) => {
  const executionStarted = deferred();
  const releaseExecution = deferred();
  const firstPollCaptured = deferred();
  const releaseFirstPoll = deferred();
  const firstPollFulfilled = deferred();
  const secondPollArrived = deferred();
  const allowSecondPollFetch = deferred();
  const secondPollFulfilled = deferred();
  const requests = [];
  const fixture = await createFixture(page, async (_projectId, _assetIds, _options, updateProgress) => {
    updateProgress({ completed: 0, total: 1 });
    executionStarted.resolve();
    await releaseExecution.promise;
    updateProgress({ completed: 1, total: 1 });
    return {
      convertedCount: 1,
      requestedCount: 1,
      convertedAssetIds: [],
      assets: [],
      format: 'webp',
      quality: 85,
      originalHandling: 'keep',
    };
  });
  let jobId;
  let jobPollCount = 0;

  page.on('request', (request) => requests.push({
    method: request.method(),
    path: requestPath(request),
    resourceType: request.resourceType(),
  }));
  await page.route('**/processing/jobs/*', async (route) => {
    const pathName = requestPath(route.request());
    if (!jobId || pathName !== `/processing/jobs/${jobId}` || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    jobPollCount += 1;
    try {
      if (jobPollCount === 1) {
        const response = await route.fetch();
        const payload = await response.json();
        firstPollCaptured.resolve({ payload, response });
        await releaseFirstPoll.promise;
        await route.fulfill({ response });
        firstPollFulfilled.resolve();
        return;
      }
      if (jobPollCount === 2) {
        secondPollArrived.resolve();
        await allowSecondPollFetch.promise;
        const response = await route.fetch();
        await route.fulfill({ response });
        secondPollFulfilled.resolve(await response.json());
        return;
      }
      throw new Error(`Unexpected processing poll ${jobPollCount}.`);
    } catch (error) {
      firstPollCaptured.reject(error);
      secondPollArrived.reject(error);
      firstPollFulfilled.reject(error);
      secondPollFulfilled.reject(error);
      throw error;
    }
  });

  try {
    await openAndPreviewConvert(page, fixture);
    const applyResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && requestPath(response.request()) === `/projects/${fixture.project.id}/assets/processing/convert/apply`
    ));
    await fixture.dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    const applyResponse = await applyResponsePromise;
    expect(applyResponse.status()).toBe(202);
    ({ jobId } = await applyResponse.json());
    await executionStarted.promise;
    const firstPoll = await firstPollCaptured.promise;
    expect(firstPoll.payload.job).toMatchObject({ id: jobId, state: 'running' });

    await fixture.dialog.getByRole('button', { name: 'Close Convert', exact: true }).click();
    await expect(fixture.dialog).toBeHidden();
    await page.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(fixture.dialog).toBeVisible();
    await secondPollArrived.promise;

    releaseExecution.resolve();
    await expect.poll(() => fixture.processingJobService.getJob(jobId)?.state).toBe('succeeded');
    allowSecondPollFetch.resolve();
    const secondPoll = await secondPollFulfilled.promise;
    expect(secondPoll.job).toMatchObject({ id: jobId, state: 'succeeded' });
    await expect(fixture.dialog.locator('[data-processing-status]')).toHaveText('Applied. Assets refreshed.');

    const scanPath = `/projects/${fixture.project.id}/scan`;
    const assetsPath = `/projects/${fixture.project.id}/assets`;
    const completionCounts = () => ({
      scan: requests.filter(({ method, path }) => method === 'POST' && path === scanPath).length,
      refresh: requests.filter(({ method, path, resourceType }) => (
        method === 'GET' && path === assetsPath && resourceType === 'fetch'
      )).length,
      cancel: requests.filter(({ method, path }) => (
        method === 'POST' && path === `/processing/jobs/${jobId}/cancel`
      )).length,
    });
    expect(completionCounts()).toEqual({ scan: 1, refresh: 1, cancel: 0 });

    releaseFirstPoll.resolve();
    await firstPollFulfilled.promise;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    expect(jobPollCount).toBe(2);
    expect(completionCounts()).toEqual({ scan: 1, refresh: 1, cancel: 0 });
    expect(fixture.executionCalls).toHaveLength(1);
    expect(await processingState(page)).toMatchObject({
      busy: false,
      jobId: null,
      polling: false,
      timer: false,
      submission: null,
    });
  } finally {
    releaseExecution.resolve();
    allowSecondPollFetch.resolve();
    releaseFirstPoll.resolve();
    await page.unroute('**/processing/jobs/*').catch(() => {});
    await fixture.close();
  }
});
