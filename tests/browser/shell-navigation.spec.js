import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const COLLAPSED_SIDEBAR_WIDTH = 64;
const EXPANDED_SIDEBAR_WIDTH = 240;
const CONTINUITY_STORAGE_KEY = 'creatorcrate:shell-navigation-continuity';
const PROJECTS_SAVED_DEFAULTS_SEARCH = '?sort=title&order=asc';
const ASSET_VIEWER_SAVED_DEFAULTS_SEARCH = '?sort=category&order=desc&pageSize=50';

let baseURL;
let db;
let root;
let server;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shell-navigation-'));
  const appDataRoot = path.join(root, 'app');
  const projectsRoot = path.join(root, 'projects');
  fs.mkdirSync(appDataRoot);
  fs.mkdirSync(projectsRoot);

  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const app = createApp(
    { appName: 'CreatorCrate', db, projectsRoot },
    { appDataRoot, authState: { csrfPepper } }
  );
  app.locals.pageDefaultsService.saveDefault('projects', 'sort', 'title');
  app.locals.pageDefaultsService.saveDefault('projects', 'order', 'asc');
  app.locals.pageDefaultsService.saveDefault('assetViewer', 'sort', 'category');
  app.locals.pageDefaultsService.saveDefault('assetViewer', 'order', 'desc');
  app.locals.pageDefaultsService.saveDefault('assetViewer', 'pageSize', '50');

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__creatorCrateShellFirstFrame = null;
    document.addEventListener('DOMContentLoaded', () => {
      requestAnimationFrame(() => {
        const sidebar = document.querySelector('.app-sidebar');
        const mobileNav = document.querySelector('.mobile-nav');
        const activeElement = document.activeElement;
        window.__creatorCrateShellFirstFrame = {
          pathname: location.pathname,
          search: location.search,
          sidebarWidth: sidebar?.getBoundingClientRect().width ?? null,
          sidebarHovered: sidebar?.matches(':hover') ?? false,
          sidebarFocusWithin: sidebar?.matches(':focus-within') ?? false,
          mobileOpen: mobileNav?.open ?? null,
          continuity: document.documentElement.dataset.shellNavigationContinuity ?? null,
          activeElement: describeElement(activeElement),
        };
      });
    }, { once: true });

    function describeElement(element) {
      if (!element) return null;
      return {
        tagName: element.tagName,
        className: element.className || '',
        navKey: element.getAttribute?.('data-nav-key'),
        pathname: element.href ? new URL(element.href).pathname : null,
      };
    }
  });
});

test('desktop Projects navigation survives saved-default canonicalization through its first frame', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

  const link = page.locator('.app-nav-link[data-nav-key="projects"]');
  await expect(link).toHaveAttribute('href', '/projects');
  await link.hover();
  await expect.poll(() => sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);
  await beginShellMutationObservation(page);
  const outgoingDocument = await documentIdentity(page);
  const held = await holdDocumentRequest(page, '/projects');
  const redirectResponse = page.waitForResponse(`${baseURL}/projects`);
  const pendingState = await preparePendingShellStateReport(page);

  await clickWithMouse(page, link);
  await held.requested;
  const pending = await pendingState;

  expect(pending.documentIdentity).toBe(outgoingDocument);
  expect(pending.pathname).toBe('/');
  expect(pending.sidebarWidth).toBe(EXPANDED_SIDEBAR_WIDTH);
  expect(pending.sidebarHovered).toBe(true);
  expect(pending.sidebarFocusWithin).toBe(false);
  expect(pending.activeElement).toMatchObject({ tagName: 'BODY', navKey: null, pathname: null });
  expect(pending.shellMutations).toEqual([]);

  held.release();
  const response = await redirectResponse;
  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe(`/projects${PROJECTS_SAVED_DEFAULTS_SEARCH}`);
  const firstFrame = await readDestinationFirstFrame(page, '/projects');

  expect(await documentIdentity(page)).not.toBe(outgoingDocument);
  expect(new URL(page.url()).search).toBe(PROJECTS_SAVED_DEFAULTS_SEARCH);
  expect(firstFrame).toMatchObject({
    pathname: '/projects',
    search: PROJECTS_SAVED_DEFAULTS_SEARCH,
    sidebarWidth: EXPANDED_SIDEBAR_WIDTH,
    sidebarHovered: false,
    sidebarFocusWithin: false,
    mobileOpen: false,
    continuity: 'desktop',
  });
  expect(firstFrame.activeElement).toMatchObject({ tagName: 'BODY' });
  expect(await continuityStorage(page)).toBeNull();
  expect(await sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);
  await page.mouse.move(900, 500);
  await expect.poll(() => sidebarWidth(page)).toBe(COLLAPSED_SIDEBAR_WIDTH);
  await page.locator('.app-nav-link[data-nav-key="projects"]').hover();
  await expect.poll(() => sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);

  await page.goto(`${baseURL}/notes`, { waitUntil: 'domcontentloaded' });
  const unrelatedFirstFrame = await readDestinationFirstFrame(page, '/notes');
  expect(unrelatedFirstFrame).toMatchObject({
    sidebarWidth: COLLAPSED_SIDEBAR_WIDTH,
    sidebarFocusWithin: false,
    continuity: null,
  });
});

test('mobile Projects navigation survives saved-default canonicalization through its first frame', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

  const mobileNav = page.locator('details.mobile-nav');
  await mobileNav.locator('summary').click();
  await expect(mobileNav).toHaveAttribute('open', '');
  const link = mobileNav.locator('.mobile-nav-link[data-nav-key="projects"]');
  await expect(link).toHaveAttribute('href', '/projects');
  const redirectResponse = page.waitForResponse(`${baseURL}/projects`);

  await clickWithMouse(page, link);
  const response = await redirectResponse;
  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe(`/projects${PROJECTS_SAVED_DEFAULTS_SEARCH}`);
  const firstFrame = await readDestinationFirstFrame(page, '/projects');

  expect(new URL(page.url()).search).toBe(PROJECTS_SAVED_DEFAULTS_SEARCH);
  expect(firstFrame).toMatchObject({
    pathname: '/projects',
    search: PROJECTS_SAVED_DEFAULTS_SEARCH,
    sidebarWidth: 0,
    mobileOpen: true,
  });
  expect(await continuityStorage(page)).toBeNull();
});

test('desktop Asset Viewer navigation survives saved-default canonicalization through its first frame', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

  const link = page.locator('.app-nav-link[data-nav-key="assets"]');
  await expect(link).toHaveAttribute('href', '/asset-viewer');
  await link.hover();
  await expect.poll(() => sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);
  const redirectResponse = page.waitForResponse(`${baseURL}/asset-viewer`);

  await clickWithMouse(page, link);
  const response = await redirectResponse;
  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe(`/asset-viewer${ASSET_VIEWER_SAVED_DEFAULTS_SEARCH}`);
  const firstFrame = await readDestinationFirstFrame(page, '/asset-viewer');

  expect(new URL(page.url()).search).toBe(ASSET_VIEWER_SAVED_DEFAULTS_SEARCH);
  expect(firstFrame).toMatchObject({
    pathname: '/asset-viewer',
    search: ASSET_VIEWER_SAVED_DEFAULTS_SEARCH,
    sidebarWidth: EXPANDED_SIDEBAR_WIDTH,
    sidebarHovered: false,
    sidebarFocusWithin: false,
    continuity: 'desktop',
  });
  expect(await continuityStorage(page)).toBeNull();
});

test('mobile Asset Viewer navigation survives saved-default canonicalization through its first frame', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });

  const mobileNav = page.locator('details.mobile-nav');
  await mobileNav.locator('summary').click();
  await expect(mobileNav).toHaveAttribute('open', '');
  const link = mobileNav.locator('.mobile-nav-link[data-nav-key="assets"]');
  await expect(link).toHaveAttribute('href', '/asset-viewer');
  const redirectResponse = page.waitForResponse(`${baseURL}/asset-viewer`);

  await clickWithMouse(page, link);
  const response = await redirectResponse;
  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe(`/asset-viewer${ASSET_VIEWER_SAVED_DEFAULTS_SEARCH}`);
  const firstFrame = await readDestinationFirstFrame(page, '/asset-viewer');

  expect(new URL(page.url()).search).toBe(ASSET_VIEWER_SAVED_DEFAULTS_SEARCH);
  expect(firstFrame).toMatchObject({
    pathname: '/asset-viewer',
    search: ASSET_VIEWER_SAVED_DEFAULTS_SEARCH,
    sidebarWidth: 0,
    mobileOpen: true,
  });
  expect(await continuityStorage(page)).toBeNull();
});

test('a stored target for one pathname is rejected by a different pathname', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ key, target }) => {
    sessionStorage.setItem(key, JSON.stringify({
      shell: 'desktop',
      activation: 'pointer',
      target,
      createdAt: Date.now(),
    }));
  }, { key: CONTINUITY_STORAGE_KEY, target: `${baseURL}/projects` });

  await page.goto(`${baseURL}/notes`, { waitUntil: 'domcontentloaded' });
  const firstFrame = await readDestinationFirstFrame(page, '/notes');

  expect(firstFrame).toMatchObject({
    pathname: '/notes',
    sidebarWidth: COLLAPSED_SIDEBAR_WIDTH,
    continuity: null,
  });
  expect(await continuityStorage(page)).toBeNull();
});

test('a later prevented main-nav activation leaves no continuity for an independent visit', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  const sourceDocument = await documentIdentity(page);
  const link = page.locator('.app-nav-link[data-nav-key="projects"]');
  await link.hover();
  await expect.poll(() => sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);
  await page.evaluate(() => {
    document.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-nav-key="projects"]')) event.preventDefault();
    });
  });

  await clickWithMouse(page, link);

  expect(new URL(page.url()).pathname).toBe('/');
  expect(await documentIdentity(page)).toBe(sourceDocument);
  expect(await continuityStorage(page)).toBeNull();

  await page.goto(`${baseURL}/projects`, { waitUntil: 'domcontentloaded' });
  const firstFrame = await readDestinationFirstFrame(page, '/projects');
  expect(firstFrame).toMatchObject({
    pathname: '/projects',
    search: PROJECTS_SAVED_DEFAULTS_SEARCH,
    sidebarWidth: COLLAPSED_SIDEBAR_WIDTH,
    continuity: null,
  });
  expect(await continuityStorage(page)).toBeNull();
});

test('prevented-activation cleanup does not remove newer continuity state', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  const link = page.locator('.app-nav-link[data-nav-key="projects"]');
  await link.hover();
  await expect.poll(() => sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);
  const newerState = await page.evaluate((key) => {
    const replacement = JSON.stringify({
      shell: 'desktop',
      activation: 'pointer',
      target: `${location.origin}/notes`,
      createdAt: Date.now() + 1,
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest?.('[data-nav-key="projects"]')) return;
      event.preventDefault();
      sessionStorage.setItem(key, replacement);
    });
    return replacement;
  }, CONTINUITY_STORAGE_KEY);

  await clickWithMouse(page, link);

  expect(await continuityStorage(page)).toBe(newerState);
  await page.evaluate((key) => sessionStorage.removeItem(key), CONTINUITY_STORAGE_KEY);
});

test('desktop keyboard main-nav navigation restores focus continuity in the destination', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  await page.mouse.move(900, 500);

  const link = page.locator('.app-nav-link[data-nav-key="notes"]');
  await link.focus();
  await expect.poll(() => sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);
  await beginShellMutationObservation(page);
  const outgoingDocument = await documentIdentity(page);
  const held = await holdDocumentRequest(page, '/notes');
  const pendingState = await preparePendingShellStateReport(page);

  await page.keyboard.press('Enter');
  await held.requested;
  const pending = await pendingState;

  expect(pending.documentIdentity).toBe(outgoingDocument);
  expect(pending.sidebarWidth).toBe(EXPANDED_SIDEBAR_WIDTH);
  expect(pending.sidebarHovered).toBe(false);
  expect(pending.sidebarFocusWithin).toBe(true);
  expect(pending.activeElement).toMatchObject({ tagName: 'A', navKey: 'notes', pathname: '/notes' });
  expect(pending.shellMutations).toEqual([]);

  held.release();
  const firstFrame = await readDestinationFirstFrame(page, '/notes');

  expect(await documentIdentity(page)).not.toBe(outgoingDocument);
  expect(firstFrame).toMatchObject({
    pathname: '/notes',
    sidebarWidth: EXPANDED_SIDEBAR_WIDTH,
    sidebarHovered: false,
    sidebarFocusWithin: true,
    mobileOpen: false,
  });
  expect(firstFrame.activeElement).toMatchObject({ tagName: 'A', navKey: 'notes', pathname: '/notes' });
  expect(await continuityStorage(page)).toBeNull();
  await page.locator('#main-content').focus();
  await expect.poll(() => sidebarWidth(page)).toBe(COLLAPSED_SIDEBAR_WIDTH);
});

test('desktop Settings keyboard navigation keeps its submenu open in the destination first frame', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(`${baseURL}/projects`, { waitUntil: 'domcontentloaded' });
  await page.mouse.move(900, 500);

  const link = page.locator('.app-nav-child-link[data-nav-key="settings-security"]');
  await link.focus();
  await expect.poll(() => sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);
  await expect.poll(() => settingsSubmenuState(page)).toMatchObject({ visible: true, opacity: 1 });
  await beginShellMutationObservation(page);
  const outgoingDocument = await documentIdentity(page);
  const held = await holdDocumentRequest(page, '/settings/security');
  const pendingState = await preparePendingShellStateReport(page);

  await page.keyboard.press('Enter');
  await held.requested;
  const pending = await pendingState;

  expect(pending.documentIdentity).toBe(outgoingDocument);
  expect(pending.sidebarWidth).toBe(EXPANDED_SIDEBAR_WIDTH);
  expect(pending.sidebarFocusWithin).toBe(true);
  expect(pending.activeElement).toMatchObject({
    tagName: 'A',
    navKey: 'settings-security',
    pathname: '/settings/security',
  });
  expect(pending.settingsSubmenu).toMatchObject({ visible: true, opacity: 1 });
  expect(pending.shellMutations).toEqual([]);

  held.release();
  const firstFrame = await readDestinationFirstFrame(page, '/settings/security');

  expect(await documentIdentity(page)).not.toBe(outgoingDocument);
  expect(firstFrame).toMatchObject({
    pathname: '/settings/security',
    sidebarWidth: EXPANDED_SIDEBAR_WIDTH,
    sidebarHovered: false,
    sidebarFocusWithin: true,
  });
  expect(firstFrame.activeElement).toMatchObject({
    tagName: 'A',
    navKey: 'settings-security',
    pathname: '/settings/security',
  });
  expect(await settingsSubmenuState(page)).toMatchObject({ visible: true, opacity: 1 });
  expect(await continuityStorage(page)).toBeNull();
});

test('mobile main-nav navigation arrives with the native menu open on its first frame', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`${baseURL}/projects`, { waitUntil: 'domcontentloaded' });

  const mobileNav = page.locator('details.mobile-nav');
  await mobileNav.locator('summary').click();
  await expect(mobileNav).toHaveAttribute('open', '');
  const link = mobileNav.locator('.mobile-nav-child-link[data-nav-key="settings-security"]');
  await beginShellMutationObservation(page);
  const outgoingDocument = await documentIdentity(page);
  const held = await holdDocumentRequest(page, '/settings/security');
  const pendingState = await preparePendingShellStateReport(page);

  await clickWithMouse(page, link);
  await held.requested;
  const pending = await pendingState;

  expect(pending.documentIdentity).toBe(outgoingDocument);
  expect(pending.pathname).toBe('/projects');
  expect(pending.mobileOpen).toBe(true);
  expect(pending.activeElement).toMatchObject({
    tagName: 'SUMMARY',
    navKey: null,
    pathname: null,
  });
  expect(pending.shellMutations).toEqual([]);

  held.release();
  const firstFrame = await readDestinationFirstFrame(page, '/settings/security');

  expect(await documentIdentity(page)).not.toBe(outgoingDocument);
  expect(firstFrame).toMatchObject({
    pathname: '/settings/security',
    sidebarWidth: 0,
    sidebarHovered: false,
    sidebarFocusWithin: false,
    mobileOpen: true,
  });
  expect(firstFrame.activeElement).toMatchObject({ tagName: 'BODY' });
  expect(await continuityStorage(page)).toBeNull();

  await mobileNav.locator('summary').click();
  await expect(mobileNav).not.toHaveAttribute('open', '');
  await page.goto(`${baseURL}/projects`, { waitUntil: 'domcontentloaded' });
  expect(await page.locator('details.mobile-nav').evaluate((details) => details.open)).toBe(false);
});

test('modified desktop activation opens a new tab without navigating the source document', async ({ page, context }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  const sourceDocument = await documentIdentity(page);
  const link = page.locator('.app-nav-link[data-nav-key="projects"]');
  await link.hover();
  await expect.poll(() => sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);
  expect(await continuityStorage(page)).toBeNull();

  const newPagePromise = context.waitForEvent('page');
  await link.click({ modifiers: ['Control'] });
  const newPage = await newPagePromise;
  try {
    await newPage.waitForURL((url) => url.pathname === '/projects', { waitUntil: 'domcontentloaded' });
    expect(new URL(newPage.url()).pathname).toBe('/projects');
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await documentIdentity(page)).toBe(sourceDocument);
    expect(await sidebarWidth(page)).toBe(EXPANDED_SIDEBAR_WIDTH);
    expect(await continuityStorage(page)).toBeNull();
    expect(await newPage.locator('.app-sidebar').evaluate((sidebar) => sidebar.getBoundingClientRect().width))
      .toBe(COLLAPSED_SIDEBAR_WIDTH);
  } finally {
    await newPage.close();
  }
});

async function beginShellMutationObservation(page) {
  await page.evaluate(() => {
    window.__creatorCrateShellMutations = [];
    const roots = [document.querySelector('.app-sidebar'), document.querySelector('.mobile-nav')].filter(Boolean);
    const observer = new MutationObserver((records) => {
      window.__creatorCrateShellMutations.push(...records.map((record) => ({
        attributeName: record.attributeName,
        className: record.target.className || '',
        navKey: record.target.getAttribute?.('data-nav-key'),
      })));
    });
    roots.forEach((rootElement) => observer.observe(rootElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ['class', 'open', 'style'],
    }));
  });
}

async function clickWithMouse(page, locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function preparePendingShellStateReport(page) {
  let resolveReport;
  const report = new Promise((resolve) => { resolveReport = resolve; });
  await page.exposeFunction('__creatorCrateReportPendingShellState', resolveReport);
  await page.evaluate(() => {
    setTimeout(() => {
      const sidebar = document.querySelector('.app-sidebar');
      const mobileNav = document.querySelector('.mobile-nav');
      const activeElement = document.activeElement;
      const settingsSubmenu = document.querySelector('.app-nav-link[data-nav-key="settings"]')
        ?.closest('.app-nav-item')?.querySelector('.app-nav-children');
      const submenuStyle = settingsSubmenu ? getComputedStyle(settingsSubmenu) : null;
      window.__creatorCrateReportPendingShellState({
        documentIdentity: performance.timeOrigin,
        pathname: location.pathname,
        sidebarClassName: sidebar?.className ?? null,
        sidebarWidth: sidebar?.getBoundingClientRect().width ?? null,
        sidebarHovered: sidebar?.matches(':hover') ?? false,
        sidebarFocusWithin: sidebar?.matches(':focus-within') ?? false,
        mobileClassName: mobileNav?.className ?? null,
        mobileOpen: mobileNav?.open ?? null,
        activeElement: activeElement ? {
          tagName: activeElement.tagName,
          className: activeElement.className || '',
          navKey: activeElement.getAttribute?.('data-nav-key'),
          pathname: activeElement.href ? new URL(activeElement.href).pathname : null,
        } : null,
        settingsSubmenu: settingsSubmenu ? {
          visible: settingsSubmenu.getBoundingClientRect().height > 0,
          opacity: Number(submenuStyle.opacity),
          maxHeight: submenuStyle.maxHeight,
        } : null,
        shellMutations: window.__creatorCrateShellMutations || [],
      });
    }, 250);
  });
  return report;
}

async function holdDocumentRequest(page, pathname) {
  let releaseRequest;
  let signalRequested;
  const requested = new Promise((resolve) => { signalRequested = resolve; });
  const release = new Promise((resolve) => { releaseRequest = resolve; });
  const url = `${baseURL}${pathname}`;

  await page.route(url, async (route) => {
    expect(route.request().resourceType()).toBe('document');
    signalRequested();
    await release;
    await route.continue();
  }, { times: 1 });

  return { requested, release: releaseRequest };
}

async function readDestinationFirstFrame(page, pathname) {
  await page.waitForURL((url) => url.pathname === pathname, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.__creatorCrateShellFirstFrame)).toMatchObject({ pathname });
  return page.evaluate(() => window.__creatorCrateShellFirstFrame);
}

async function sidebarWidth(page) {
  return page.locator('.app-sidebar').evaluate((sidebar) => sidebar.getBoundingClientRect().width);
}

async function settingsSubmenuState(page) {
  return page.locator('.app-nav-link[data-nav-key="settings"]')
    .locator('xpath=..')
    .locator('.app-nav-children')
    .evaluate((submenu) => ({
      visible: submenu.getBoundingClientRect().height > 0,
      opacity: Number(getComputedStyle(submenu).opacity),
    }));
}

async function documentIdentity(page) {
  return page.evaluate(() => performance.timeOrigin);
}

async function continuityStorage(page) {
  return page.evaluate((key) => sessionStorage.getItem(key), CONTINUITY_STORAGE_KEY);
}
