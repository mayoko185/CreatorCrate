import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createAssetCategoryRepository } from '../../src/data/asset-category-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseService } from '../../src/services/release-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

async function openFixture(page, { releaseDropdowns = false, releaseDetails = false, noAssets = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-info-card-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    const project = app.locals.projectService.create({
      title: 'Popup Browser Project',
      status: 'tbd',
    });
    if (!noAssets) {
      const assetDirectory = path.join(projectsRoot, project.project_dir, 'renders');
      fs.mkdirSync(assetDirectory, { recursive: true });
      await sharp({
        create: { width: 80, height: 60, channels: 4, background: '#4f46e5' },
      }).png().toFile(path.join(assetDirectory, 'popup.png'));
      if (releaseDropdowns) {
        for (const extension of ['avif', 'gif', 'jpeg', 'jpg', 'md', 'svg', 'txt', 'webp']) {
          fs.writeFileSync(path.join(assetDirectory, `asset.${extension}`), extension);
        }
        const categoryRepository = createAssetCategoryRepository(db);
        for (let index = 1; index <= 10; index += 1) {
          const directorySlug = `category-${index}`;
          categoryRepository.addProjectCategory({
            projectId: project.id,
            displayName: `Category ${String(index).padStart(2, '0')}`,
            directorySlug,
            displayOrder: 100 + index,
            enabled: true,
          });
          const categoryDirectory = path.join(projectsRoot, project.project_dir, directorySlug);
          fs.mkdirSync(categoryDirectory, { recursive: true });
          fs.writeFileSync(path.join(categoryDirectory, `category-${index}.txt`), String(index));
        }
      }
    }
    app.locals.assetScanner.scanProjectAssets(project.id);
    const releaseService = createReleaseService({ db });
    let release = null;
    let emptyRelease = null;
    if (releaseDetails) {
      const [selectedAsset] = app.locals.assetScanner.listProjectAssets(project.id);
      release = releaseService.createReleaseWithSelectedAssets(
        project.id,
        { title: 'Selected Assets Browser Release' },
        [selectedAsset.id],
      );
      emptyRelease = releaseService.createRelease(project.id, { title: 'Empty Browser Release' });
    } else if (releaseDropdowns) {
      release = releaseService.createRelease(project.id, { title: 'Dropdown Browser Release' });
    }

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    await page.setViewportSize({ width: 900, height: 640 });
    return {
      baseURL,
      releaseId: release?.id,
      emptyReleaseId: emptyRelease?.id,
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

async function expectDropdownPanelHitTestable(page, dropdown) {
  const panel = dropdown.locator('.asset-filter-multiselect-panel');
  await expect(panel).toBeVisible();
  const geometry = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      position: getComputedStyle(element).position,
      overlay: element.hasAttribute('data-cc-dropdown-overlay'),
    };
  });
  expect(geometry.position).toBe('fixed');
  expect(geometry.overlay).toBe(true);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);

  const lowerOption = panel.locator('.asset-filter-multiselect-option').last();
  await lowerOption.scrollIntoViewIfNeeded();
  const hit = await lowerOption.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(target?.closest?.('.asset-filter-multiselect-option') === element);
  });
  expect(hit).toBe(true);
}

async function expectReleaseResultOrder(page, resultSelector, { pagination = false } = {}) {
  const region = page.locator('[data-release-assets-live-region]');
  const result = region.locator(resultSelector);
  const count = region.locator('.release-asset-results-meta');
  await expect(result).toBeVisible();
  await expect(count).toBeVisible();

  const ordering = await region.evaluate((element, selector) => {
    const controlsElement = element.querySelector('.asset-viewer-display-controls');
    const resultElement = element.querySelector(selector);
    const countElement = element.querySelector('.release-asset-results-meta');
    const paginationElement = element.querySelector('.pagination');
    const follows = (first, second) => Boolean(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    };
    return {
      controlsBeforeCount: follows(controlsElement, countElement),
      countBeforeResult: follows(countElement, resultElement),
      resultBeforePagination: paginationElement ? follows(resultElement, paginationElement) : null,
      controls: box(controlsElement),
      result: box(resultElement),
      count: box(countElement),
      pagination: paginationElement ? box(paginationElement) : null,
      cssOrder: {
        controls: getComputedStyle(controlsElement).order,
        result: getComputedStyle(resultElement).order,
        count: getComputedStyle(countElement).order,
        pagination: paginationElement ? getComputedStyle(paginationElement).order : null,
      },
    };
  }, resultSelector);

  expect(ordering.controlsBeforeCount).toBe(true);
  expect(ordering.countBeforeResult).toBe(true);
  expect(ordering.controls.bottom).toBeLessThanOrEqual(ordering.count.top);
  expect(ordering.count.bottom).toBeLessThanOrEqual(ordering.result.top);
  expect(ordering.cssOrder.controls).toBe('0');
  expect(ordering.cssOrder.result).toBe('0');
  expect(ordering.cssOrder.count).toBe('0');
  if (pagination) {
    expect(ordering.resultBeforePagination).toBe(true);
    expect(ordering.result.bottom).toBeLessThanOrEqual(ordering.pagination.top);
    expect(ordering.cssOrder.pagination).toBe('0');
  } else {
    expect(ordering.pagination).toBeNull();
  }
  return ordering;
}

async function statusBadgeMetrics(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const parentStyle = getComputedStyle(element.parentElement);
    const rect = element.getBoundingClientRect();
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      paddingInlineStart: style.paddingInlineStart,
      paddingInlineEnd: style.paddingInlineEnd,
      paddingBlockStart: style.paddingBlockStart,
      paddingBlockEnd: style.paddingBlockEnd,
      height: rect.height,
      width: rect.width,
      transform: style.transform,
      parentFontSize: parentStyle.fontSize,
      parentLineHeight: parentStyle.lineHeight,
      parentTransform: parentStyle.transform,
    };
  });
}

async function expectReleaseDetailAssetAlignment(page, resultSelector) {
  const region = page.locator('[data-selected-assets]');
  await expect(region.locator('.asset-viewer-display-controls')).toBeVisible();
  await expect(region.locator('.results-meta')).toBeVisible();
  await expect(region.locator(resultSelector).first()).toBeVisible();

  const measurements = await region.evaluate((element, selector) => {
    const summary = element.closest('.project-detail-summary');
    const anchor = summary.querySelector('.project-detail-info');
    const controls = element.querySelector('.asset-viewer-display-controls');
    const metadata = element.querySelector('.results-meta');
    const result = element.querySelector(selector);
    const previous = element.previousElementSibling;
    const parentStyle = getComputedStyle(element.parentElement);
    const layoutStyle = getComputedStyle(element);
    return {
      anchorLeft: anchor.getBoundingClientRect().left,
      anchorRight: anchor.getBoundingClientRect().right,
      layoutLeft: element.getBoundingClientRect().left,
      layoutRight: element.getBoundingClientRect().right,
      controlsLeft: controls.getBoundingClientRect().left,
      metadataLeft: metadata.getBoundingClientRect().left,
      resultLeft: result.getBoundingClientRect().left,
      verticalGap: controls.getBoundingClientRect().top - previous.getBoundingClientRect().bottom,
      expectedVerticalGap: parseFloat(parentStyle.rowGap) + parseFloat(layoutStyle.marginTop),
      horizontalOverflow: element.scrollWidth - element.clientWidth,
    };
  }, resultSelector);

  const tolerance = 1;
  for (const left of [
    measurements.layoutLeft,
    measurements.controlsLeft,
    measurements.metadataLeft,
    measurements.resultLeft,
  ]) {
    expect(Math.abs(left - measurements.anchorLeft)).toBeLessThanOrEqual(tolerance);
  }
  expect(Math.abs(measurements.verticalGap - measurements.expectedVerticalGap)).toBeLessThanOrEqual(tolerance);
  expect(measurements.layoutRight).toBeLessThanOrEqual(measurements.anchorRight + tolerance);
  expect(measurements.horizontalOverflow).toBeLessThanOrEqual(tolerance);
  return measurements;
}

async function expectPointerFollowing(page, previewSelector, infoSelector) {
  const preview = page.locator(previewSelector).first();
  const info = page.locator(infoSelector).first();
  const box = await preview.boundingBox();
  expect(box).not.toBeNull();
  const firstPoint = { x: box.x + Math.min(24, box.width / 3), y: box.y + Math.min(24, box.height / 3) };
  const secondPoint = {
    x: Math.min(box.x + box.width - 5, firstPoint.x + 28),
    y: Math.min(box.y + box.height - 5, firstPoint.y + 22),
  };

  await page.mouse.move(firstPoint.x, firstPoint.y);
  await expect(info).toBeVisible();
  expect(await info.evaluate((node) => node.matches(':popover-open'))).toBe(true);
  const first = await info.boundingBox();
  await page.mouse.move(secondPoint.x, secondPoint.y, { steps: 4 });
  await expect.poll(async () => info.boundingBox()).not.toEqual(first);
  const second = await info.boundingBox();
  expect(Math.abs((second.x - first.x) - (secondPoint.x - firstPoint.x))).toBeLessThanOrEqual(2);
  expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThan(10);
  return { preview, info };
}

test('shared Asset Viewer and Projects info cards use cursor, top-layer, dialog, focus, and refresh lifecycles', async ({ page }) => {
  const fixture = await openFixture(page);
  try {
    await page.goto(`${fixture.baseURL}/asset-viewer`, { waitUntil: 'domcontentloaded' });
    const asset = await expectPointerFollowing(
      page,
      '[data-asset-viewer-preview]',
      '[data-asset-info-card]',
    );

    await asset.preview.evaluate((node) => {
      node.dispatchEvent(new PointerEvent('pointerenter', {
        clientX: window.innerWidth - 2,
        clientY: window.innerHeight - 2,
      }));
    });
    await expect(asset.info).toBeVisible();
    const edgeInfo = await asset.info.boundingBox();
    expect(edgeInfo.x).toBeGreaterThanOrEqual(8);
    expect(edgeInfo.y).toBeGreaterThanOrEqual(8);
    expect(edgeInfo.x + edgeInfo.width).toBeLessThanOrEqual(892);
    expect(edgeInfo.y + edgeInfo.height).toBeLessThanOrEqual(632);

    const topLayerHit = await asset.info.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '2147483647', background: 'rgba(255, 0, 0, 0.01)',
      });
      document.body.append(overlay);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      overlay.remove();
      return Boolean(hit?.closest?.('[data-asset-info-card]'));
    });
    expect(topLayerHit).toBe(true);

    await page.mouse.move(2, 2);
    const assetPreviewLink = asset.preview.locator('a').first();
    await assetPreviewLink.focus();
    await expect(asset.info).toBeVisible();
    const focusPosition = await asset.info.boundingBox();
    await page.mouse.move(10, 10);
    expect(await asset.info.boundingBox()).toEqual(focusPosition);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(assetPreviewLink).toBeFocused();
    await expect(asset.info).toBeVisible();

    await page.getByRole('link', { name: 'Filter assets' }).click();
    const assetFilterDialog = page.locator('#asset-viewer-filter-dialog');
    await expect(assetFilterDialog).toBeVisible();
    await expect(asset.info).not.toBeVisible();
    const oldAssetRegion = await page.locator('[data-asset-library-live-region]').elementHandle();
    const response = page.waitForResponse((candidate) => (
      candidate.request().method() === 'GET' && new URL(candidate.url()).pathname === '/asset-viewer'
    ));
    await assetFilterDialog.locator('#asset-extension-filter > summary').click();
    await assetFilterDialog.locator('input[name="extension"][value="png"]').check();
    await response;
    await expect(assetFilterDialog).toBeVisible();
    await expect.poll(async () => oldAssetRegion.evaluate((node) => node.isConnected)).toBe(false);
    await expect(page.locator('[data-asset-info-card]:popover-open')).toHaveCount(0);
    await assetFilterDialog.getByRole('button', { name: 'Close Filter' }).click();

    await page.getByRole('link', { name: 'Asset Viewer defaults' }).click();
    await expect(page.locator('#asset-viewer-defaults-dialog')).toBeVisible();
    await expect(page.locator('[data-asset-info-card]:popover-open')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto(`${fixture.baseURL}/projects`, { waitUntil: 'domcontentloaded' });
    const project = await expectPointerFollowing(
      page,
      '[data-project-grid-preview]',
      '[data-project-info-card]',
    );
    await page.getByRole('link', { name: 'Filter projects' }).click();
    await expect(page.locator('#projects-filter-dialog')).toBeVisible();
    await expect(project.info).not.toBeVisible();
    await page.locator('#projects-filter-dialog').getByRole('button', { name: 'Close Filter' }).click();

    await project.preview.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      node.dispatchEvent(new PointerEvent('pointerenter', {
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      }));
    });
    await expect(project.info).toBeVisible();
    await page.getByRole('link', { name: 'Projects defaults' }).click();
    await expect(page.locator('#projects-defaults-dialog')).toBeVisible();
    await expect(project.info).not.toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('Release Assets shared dropdowns remain visible, hit-testable, and reusable in a scrolling dialog', async ({ page }) => {
  const fixture = await openFixture(page, { releaseDropdowns: true });
  try {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto(`${fixture.baseURL}/releases/${fixture.releaseId}/assets`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Filter assets' }).click();

    const dialog = page.locator('#release-assets-filter-dialog');
    const body = dialog.locator('.app-dialog-body');
    const extension = dialog.locator('#release-asset-extension-filter');
    const category = dialog.locator('#release-asset-category-filter');
    await expect(dialog).toBeVisible();
    await expect(extension).toHaveAttribute('data-cc-dropdown-mode', 'single');
    await expect(category).toHaveAttribute('data-cc-dropdown-mode', 'single');
    await expect(dialog.locator('#release-asset-page-size-dropdown')).toHaveAttribute('data-cc-dropdown-mode', 'single');
    await expect(dialog.locator('.release-assets-filter-dialog-form')).toHaveCSS('padding-bottom', '16px');

    await extension.locator('summary').click();
    await expectDropdownPanelHitTestable(page, extension);
    const response = page.waitForResponse((candidate) => (
      candidate.request().method() === 'GET'
      && new URL(candidate.url()).pathname === `/releases/${fixture.releaseId}/assets`
    ));
    await extension.locator('input[value="txt"]').check();
    await response;
    await expect(dialog).toBeVisible();

    await category.locator('summary').click();
    await expectDropdownPanelHitTestable(page, category);
    const categoryResponse = page.waitForResponse((candidate) => (
      candidate.request().method() === 'GET'
      && new URL(candidate.url()).pathname === `/releases/${fixture.releaseId}/assets`
    ));
    await category.locator('.asset-filter-multiselect-option').last().locator('input').check();
    await categoryResponse;
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-release-assets-reset]')).toBeVisible();
    await expect(dialog.locator('.release-assets-filter-dialog-form')).toHaveCSS('padding-bottom', '16px');

    await page.setViewportSize({ width: 390, height: 360 });
    const scrollState = await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    });
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
    expect(scrollState.scrollTop).toBeGreaterThan(0);

    const currentCategory = dialog.locator('#release-asset-category-filter');
    if (await currentCategory.getAttribute('open') !== null) await currentCategory.locator('summary').click();
    await currentCategory.locator('summary').click();
    await expectDropdownPanelHitTestable(page, currentCategory);
    await currentCategory.locator('summary').click();
    await currentCategory.locator('summary').click();
    await expectDropdownPanelHitTestable(page, currentCategory);
  } finally {
    await fixture.close();
  }
});

test('Release Assets keeps the filtered count above grid, list, and empty results across live history updates', async ({ page }) => {
  const fixture = await openFixture(page, { releaseDropdowns: true });
  try {
    await page.goto(`${fixture.baseURL}/releases/${fixture.releaseId}/assets?pageSize=10`, { waitUntil: 'domcontentloaded' });
    await expectReleaseResultOrder(page, '.asset-grid', { pagination: true });

    const listResponse = page.waitForResponse((candidate) => (
      candidate.request().method() === 'GET'
      && new URL(candidate.url()).pathname === `/releases/${fixture.releaseId}/assets`
    ));
    await page.getByRole('link', { name: 'List view' }).click();
    await listResponse;
    await expectReleaseResultOrder(page, '.asset-list', { pagination: true });

    await page.goBack();
    await expect(page.getByRole('link', { name: 'Grid view' })).toHaveAttribute('aria-current', 'page');
    await expectReleaseResultOrder(page, '.asset-grid', { pagination: true });
    await page.goForward();
    await expect(page.getByRole('link', { name: 'List view' })).toHaveAttribute('aria-current', 'page');
    await expectReleaseResultOrder(page, '.asset-list', { pagination: true });

    await page.getByRole('link', { name: 'Filter assets' }).click();
    const searchResponse = page.waitForResponse((candidate) => (
      candidate.request().method() === 'GET'
      && new URL(candidate.url()).pathname === `/releases/${fixture.releaseId}/assets`
      && new URL(candidate.url()).searchParams.get('search') === 'no-matching-release-asset'
    ));
    await page.locator('#asset-search').fill('no-matching-release-asset');
    await searchResponse;
    await expect(page.locator('.empty-state-heading')).toHaveText('No matching project assets');
    await expectReleaseResultOrder(page, '.empty-state');
  } finally {
    await fixture.close();
  }
});

test('Release Assets keeps the count above the no-assets state', async ({ page }) => {
  const fixture = await openFixture(page, { releaseDropdowns: true, noAssets: true });
  try {
    await page.goto(`${fixture.baseURL}/releases/${fixture.releaseId}/assets`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.empty-state-heading')).toHaveText('No project assets');
    await expectReleaseResultOrder(page, '.empty-state');
  } finally {
    await fixture.close();
  }
});

test('Release Assets Project status badge matches Release detail at desktop and narrow widths', async ({ page }) => {
  const fixture = await openFixture(page, { releaseDropdowns: true });
  try {
    for (const viewport of [
      { width: 900, height: 640 },
      { width: 390, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${fixture.baseURL}/releases/${fixture.releaseId}/assets`, { waitUntil: 'domcontentloaded' });
      const assetsMetrics = await statusBadgeMetrics(
        page.locator('.release-workflow-status .status-badge'),
      );

      await page.goto(`${fixture.baseURL}/releases/${fixture.releaseId}`, { waitUntil: 'domcontentloaded' });
      const detailMetrics = await statusBadgeMetrics(
        page.locator('.project-detail-section .project-detail-meta .status-badge').first(),
      );
      expect(assetsMetrics).toEqual({
        ...detailMetrics,
        parentFontSize: assetsMetrics.parentFontSize,
        parentLineHeight: assetsMetrics.parentLineHeight,
      });
      expect(assetsMetrics.transform).toBe('none');
      expect(assetsMetrics.parentTransform).toBe('none');
      expect(detailMetrics.parentTransform).toBe('none');
    }
  } finally {
    await fixture.close();
  }
});

test('Release detail aligns selected grid, list, and empty states with the shared content anchor', async ({ page }) => {
  const fixture = await openFixture(page, { releaseDetails: true });
  try {
    for (const viewport of [
      { width: 900, height: 800 },
      { width: 390, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${fixture.baseURL}/releases/${fixture.releaseId}`, { waitUntil: 'domcontentloaded' });
      await expectReleaseDetailAssetAlignment(page, '.asset-grid-item');

      await page.getByRole('link', { name: 'List view' }).click();
      await expect(page).toHaveURL(new RegExp(`/releases/${fixture.releaseId}\\?view=list$`));
      await expectReleaseDetailAssetAlignment(page, '.asset-list-item');

      await page.goto(`${fixture.baseURL}/releases/${fixture.emptyReleaseId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-selected-assets] .empty-state-heading')).toHaveText('No assets selected');
      await expectReleaseDetailAssetAlignment(page, '.empty-state');
    }
  } finally {
    await fixture.close();
  }
});
