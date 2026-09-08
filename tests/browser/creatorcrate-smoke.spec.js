import { test as base, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CSS_SOURCE_PATH = path.join(PROJECT_ROOT, 'src', 'static', 'creatorcrate.css');
const JS_SOURCE_PATH = path.join(PROJECT_ROOT, 'src', 'static', 'creatorcrate.js');
const LOAD_COUNTER_KEY = '__creatorcrate_browser_smoke_load_count__';
const DEFAULT_SERVER_START_TIMEOUT_MS = 30_000;
const SERVER_STOP_TIMEOUT_MS = 10_000;
const FRONTEND_RESOURCE_TYPES = new Set([
  'script',
  'stylesheet',
  'font',
  'image',
  'media',
  'fetch',
  'xhr',
  'manifest',
]);

const test = base.extend({
  devServer: async ({}, use) => {
    const server = await startCreatorCrateServer({ nodeEnv: 'development' });
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },

  productionServer: async ({}, use) => {
    await buildProductionAssets();
    if (process.env.CREATORCRATE_BROWSER_BASE_URL) {
      await use({ baseURL: process.env.CREATORCRATE_BROWSER_BASE_URL });
      return;
    }
    const server = await startCreatorCrateServer({ nodeEnv: 'production' });
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },
});

test.describe('CreatorCrate development browser smoke', () => {
  test('loads Vite development assets, executes application JS/CSS, and opens HMR WebSocket', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const navigationCount = trackMainFrameNavigations(page);

    await page.goto(`${devServer.baseURL}/projects`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('main#main-content')).toBeVisible();

    const html = await page.content();
    expect(html).toContain('src="/@vite/client"');
    expect(html).toContain('src="/client/main.js"');
    expect(html).not.toContain('src="/creatorcrate.js"');
    expect(html).not.toContain('href="/creatorcrate.css"');

    await expect.poll(() => diagnostics.successfulResponsePaths.has('/@vite/client')).toBe(true);
    await expect.poll(() => diagnostics.successfulResponsePaths.has('/client/main.js')).toBe(true);
    await expect.poll(
      () => [...diagnostics.successfulResponsePaths].some((resourcePath) => resourcePath.endsWith('.css')),
    ).toBe(true);

    await expect.poll(() => readBodyBackground(page)).toBe('rgb(13, 15, 19)');
    await waitForViteWebSocket(diagnostics);
    await exerciseSearchableProjectDropdown(page);

    expect(navigationCount()).toBe(1);
    assertNoToastUiRequests(diagnostics);
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps Project scheduling dropdown content in field items at the review width', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    await page.setViewportSize({ width: 1280, height: 800 });
    const response = await page.goto(`${devServer.baseURL}/projects/new`, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);

    const row = page.locator('.project-form .scheduling-row');
    const items = row.locator(':scope > .field.scheduling-field');
    await expect(items).toHaveCount(4);
    await expect(items.nth(0).locator('[data-cc-dropdown-mode="single"]')).toHaveCount(1);
    await expect(items.nth(1).locator('[data-cc-dropdown-mode="multiple"]')).toHaveCount(1);
    await expect(items.nth(1).locator('.help-text')).toHaveText('Add new tags in Settings › Tags.');

    const layout = await page.evaluate(() => {
      const rowElement = document.querySelector('.project-form .scheduling-row');
      const directItems = [...(rowElement?.children || [])];
      const statusItem = directItems.find((item) => item.querySelector('#project-status-form'));
      const tagsItem = directItems.find((item) => item.querySelector('#project-tags-form'));
      const plannedDateItem = document.querySelector('#plannedDate')?.closest('.field');
      const publishedDateItem = document.querySelector('#publishedDate')?.closest('.field');
      const tagsHelp = tagsItem?.querySelector('.help-text');
      const tagsFieldset = tagsItem?.querySelector('fieldset');
      const tops = [statusItem, tagsItem, plannedDateItem, publishedDateItem]
        .map((item) => item?.getBoundingClientRect().top || 0);

      return {
        directTags: directItems.map((item) => item.tagName),
        sameRow: Math.max(...tops) - Math.min(...tops) <= 1,
        tagsHelpIsRowChild: tagsHelp?.parentElement === rowElement,
        tagsHelpBelowControl: (tagsHelp?.getBoundingClientRect().top || 0)
          >= (tagsFieldset?.getBoundingClientRect().bottom || 0),
      };
    });
    expect(layout.directTags).toEqual(['DIV', 'DIV', 'DIV', 'DIV']);
    expect(layout.sameRow).toBe(true);
    expect(layout.tagsHelpIsRowChild).toBe(false);
    expect(layout.tagsHelpBelowControl).toBe(true);
    assertNoBrowserDiagnostics(diagnostics);

    await page.locator('#project-form').evaluate((form) => {
      form.querySelectorAll('input[name="status"]').forEach((input) => {
        input.checked = false;
      });
      form.submit();
    });
    await expect(page.locator('#status-error')).toBeVisible();

    const errorPlacement = await page.evaluate(() => {
      const rowElement = document.querySelector('.project-form .scheduling-row');
      const statusItem = [...(rowElement?.children || [])]
        .find((item) => item.querySelector('#project-status-form'));
      const error = document.querySelector('#status-error');
      return {
        direct: error?.parentElement === rowElement,
        belongsToStatus: Boolean(statusItem?.contains(error)),
      };
    });
    expect(errorPlacement.direct).toBe(false);
    expect(errorPlacement.belongsToStatus).toBe(true);
  });

  test('previews and applies Auto Rename for only explicitly selected assets', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const projectTitle = `Browser Auto Rename ${Date.now()}`;

    await page.goto(`${devServer.baseURL}/projects/new`, { waitUntil: 'domcontentloaded' });
    await page.locator('#title').fill(projectTitle);
    await Promise.all([
      page.waitForURL(/\/projects\/\d+$/),
      page.locator('button[type="submit"][form="project-form"]').click(),
    ]);

    const projectId = new URL(page.url()).pathname.split('/').at(-1);
    await page.goto(`${devServer.baseURL}/projects/${projectId}/asset-categories`, { waitUntil: 'domcontentloaded' });
    const categoryCard = page.locator('[data-category-id]').first();
    const categoryId = await categoryCard.getAttribute('data-category-id');
    const categorySlug = (await categoryCard.locator('.category-management-slug code').textContent()).trim();
    expect(categoryId).toMatch(/^[1-9]\d*$/);
    expect(categorySlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

    const projectDirectory = (await fs.readdir(devServer.projectsRoot, { withFileTypes: true }))
      .find((entry) => entry.isDirectory());
    expect(projectDirectory).toBeDefined();
    const projectPath = path.join(devServer.projectsRoot, projectDirectory.name);
    const filenames = [
      'asset-01.txt',
      'asset-02.txt',
      'asset-03.txt',
      'asset-04.txt',
      'asset-05.txt',
    ];
    await Promise.all(filenames.map((filename) => (
      fs.writeFile(path.join(projectPath, categorySlug, filename), `browser auto rename fixture: ${filename}`, 'utf8')
    )));

    await page.goto(`${devServer.baseURL}/projects/${projectId}/assets?category=${categoryId}&view=list`, {
      waitUntil: 'domcontentloaded',
    });
    await Promise.all([
      page.waitForURL((url) => new URL(url).pathname === `/projects/${projectId}/assets`),
      page.getByRole('button', { name: 'Scan Now', exact: true }).click(),
    ]);

    const surface = page.locator('[data-auto-rename-surface]');
    const assets = surface.locator('[data-auto-rename-asset]');
    await expect(assets).toHaveCount(filenames.length);
    const orderedAssetIds = await assets.evaluateAll((items) => (
      items.map((item) => Number(item.getAttribute('data-auto-rename-asset-id')))
    ));
    expect(orderedAssetIds).toHaveLength(filenames.length);
    const selectedIndexes = [2, 4];
    const selectedAssetIds = selectedIndexes.map((index) => orderedAssetIds[index]);
    const thirdCheckbox = assets.nth(2).locator('input[name="selectedAssetIds"]');
    const fifthCheckbox = assets.nth(4).locator('input[name="selectedAssetIds"]');
    await thirdCheckbox.focus();
    await page.keyboard.press('Space');
    await fifthCheckbox.focus();
    await page.keyboard.press('Space');
    await expect(thirdCheckbox).toBeChecked();
    await expect(fifthCheckbox).toBeChecked();
    await expect(surface.locator('[data-auto-rename-submit]')).toBeEnabled();

    const [previewRequest] = await Promise.all([
      page.waitForRequest((request) => (
        request.method() === 'POST'
        && new URL(request.url()).pathname === `/projects/${projectId}/assets/auto-rename/preview`
      )),
      page.waitForURL((url) => new URL(url).pathname === `/projects/${projectId}/assets`),
      surface.locator('[data-auto-rename-submit]').click(),
    ]);
    const previewBody = new URLSearchParams(previewRequest.postData() || '');
    expect(JSON.parse(previewBody.get('orderedAssetIds'))).toEqual(orderedAssetIds);
    expect(JSON.parse(previewBody.get('selectedAssetIds'))).toEqual(selectedAssetIds);

    const dialog = page.locator('#auto-rename-confirmation-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.auto-rename-confirmation-summary')).toContainText('2 assets:');
    await expect(dialog.locator('.auto-rename-confirmation-summary')).toContainText('2 to rename');
    await expect(dialog.locator('.auto-rename-confirmation-summary')).toContainText('0 unchanged');
    const items = dialog.locator('.auto-rename-confirmation-item');
    await expect(items).toHaveCount(2);
    expect((await items.locator('.auto-rename-confirmation-name--current code').allTextContents()).map((name) => name.trim()))
      .toEqual([filenames[2], filenames[4]]);
    expect(await items.locator('.status-badge').allTextContents()).toEqual(['Status: Rename', 'Status: Rename']);
    await expect(dialog).not.toContainText(filenames[0]);
    await expect(dialog).not.toContainText(filenames[1]);
    await expect(dialog).not.toContainText(filenames[3]);
    const proposedFilenames = (await items.locator('.auto-rename-confirmation-name--proposed code').allTextContents())
      .map((name) => name.trim());
    expect(proposedFilenames).toHaveLength(2);
    expect(proposedFilenames[0]).toMatch(/-01\.txt$/);
    expect(proposedFilenames[1]).toMatch(/-02\.txt$/);

    await Promise.all([
      page.waitForURL((url) => new URL(url).pathname === `/projects/${projectId}/assets`),
      dialog.getByRole('button', { name: 'Apply Auto Rename', exact: true }).click(),
    ]);

    for (const filename of filenames.filter((_filename, index) => selectedIndexes.includes(index))) {
      await expect.poll(() => fs.access(path.join(projectPath, categorySlug, filename))
        .then(() => true)
        .catch(() => false)).toBe(false);
    }
    for (const filename of filenames.filter((_filename, index) => !selectedIndexes.includes(index))) {
      await fs.access(path.join(projectPath, categorySlug, filename));
    }
    for (const filename of proposedFilenames) {
      await fs.access(path.join(projectPath, categorySlug, filename));
    }
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps adjacent project filters clickable after selecting a maximum-length Project', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    await page.setViewportSize({ width: 1600, height: 800 });
    const tagName = `T${Date.now()}`;
    await createBrowserTag(page, devServer.baseURL, tagName);

    const projectTitles = [
      `Browser Dropdown Short ${Date.now()}`,
      `Browser Dropdown Medium ${Date.now()}`,
      `Long Project ${'W'.repeat(187)}`,
    ];
    const projectIds = [];
    for (const title of projectTitles) {
      projectIds.push(await createBrowserProject(page, devServer.baseURL, title));
    }

    const longProjectTitle = projectTitles.at(-1);
    const longProjectId = projectIds.at(-1);
    const response = await page.goto(`${devServer.baseURL}/projects?project=${longProjectId}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.status()).toBe(200);

    const projectFilter = page.locator('#project-project-filter');
    const projectSummary = projectFilter.locator('summary');
    await expect(projectFilter.locator('.asset-filter-multiselect-summary-current')).toHaveText(longProjectTitle);

    const summaryGeometry = await page.evaluate(() => {
      const project = document.querySelector('#project-project-filter summary')?.getBoundingClientRect();
      const following = ['status', 'tag', 'sort', 'order'].map((name) => (
        document.querySelector(`#project-${name}-filter-trigger`)?.getBoundingClientRect()
      ));
      return {
        projectY: project?.y,
        followingY: following.map((rect) => rect?.y),
      };
    });
    expect(summaryGeometry.followingY.every((y) => Math.abs(summaryGeometry.projectY - y) <= 1)).toBe(true);

    const projectSummaryMetrics = await projectFilter.locator('.asset-filter-multiselect-summary-current').evaluate((element) => {
      const style = getComputedStyle(element);
      const surface = element.closest('[data-cc-dropdown-summary]');
      const trigger = element.closest('summary');
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
        surfaceWidth: surface?.getBoundingClientRect().width || 0,
        surfaceOverflow: surface ? getComputedStyle(surface).overflow : '',
        triggerRight: trigger?.getBoundingClientRect().right || 0,
        viewportWidth: window.innerWidth,
      };
    });
    expect(projectSummaryMetrics.clientWidth).toBeGreaterThan(0);
    expect(projectSummaryMetrics.scrollWidth).toBeGreaterThan(projectSummaryMetrics.surfaceWidth);
    expect(projectSummaryMetrics.surfaceOverflow).toBe('hidden');
    expect(projectSummaryMetrics.triggerRight).toBeLessThanOrEqual(projectSummaryMetrics.viewportWidth);
    expect(projectSummaryMetrics.overflow).toBe('hidden');
    expect(projectSummaryMetrics.textOverflow).toBe('ellipsis');
    expect(projectSummaryMetrics.whiteSpace).toBe('nowrap');

    async function hitAtCenter(selector) {
      const hit = await page.evaluate((targetSelector) => {
        const element = document.querySelector(targetSelector);
        const rect = element?.getBoundingClientRect();
        if (!element || !rect) return null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const target = document.elementFromPoint(x, y);
        return {
          x,
          y,
          targetId: target?.id || '',
          targetClass: target?.className || '',
          resolvesToElement: target === element || element.contains(target),
        };
      }, selector);
      expect(hit).not.toBeNull();
      expect(hit.resolvesToElement).toBe(true);
      await page.mouse.click(hit.x, hit.y);
    }

    for (const name of ['status', 'tag', 'sort', 'order']) {
      const trigger = page.locator(`#project-${name}-filter-trigger`);
      await hitAtCenter(`#project-${name}-filter-trigger`);
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator(`#project-${name}-filter-options`)).toBeVisible();
      await expect(projectFilter).not.toHaveAttribute('open');
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    }

    await expect(projectSummary).toBeVisible();

    const filterChanges = [
      { name: 'status', value: 'planned' },
      { name: 'tag', value: null },
      { name: 'sort', value: 'title' },
      { name: 'order', value: 'asc' },
    ];
    for (const change of filterChanges) {
      await page.goto(`${devServer.baseURL}/projects?project=${longProjectId}`, {
        waitUntil: 'domcontentloaded',
      });
      const filter = page.locator(`#project-${change.name}-filter`);
      const input = change.value === null
        ? filter.locator('input[name="tag"]').first()
        : filter.locator(`input[name="${change.name}"][value="${change.value}"]`);
      await expect(input).toHaveCount(1);

      const requests = [];
      const onRequest = (request) => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname === '/projects') requests.push(request);
      };
      page.on('request', onRequest);
      try {
        const responsePromise = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === 'GET' && url.pathname === '/projects';
        });
        await hitAtCenter(`#project-${change.name}-filter-trigger`);
        await expect(filter.locator('summary')).toHaveAttribute('aria-expanded', 'true');
        await input.scrollIntoViewIfNeeded();
        await hitAtCenter(`#project-${change.name}-filter-options input[name="${change.name}"]${change.value === null ? '' : `[value="${change.value}"]`}`);
        await responsePromise;
        await expect.poll(() => requests.length).toBe(1);
        await page.waitForTimeout(100);
        expect(requests).toHaveLength(1);
      } finally {
        page.off('request', onRequest);
      }
    }

    assertNoBrowserDiagnostics(diagnostics);
  });

  test('mounts the real Notes editor, persists Markdown, and rehydrates it on edit', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);

    await page.setViewportSize({ width: 1280, height: 800 });
    const chapterId = await createBrowserNotesHierarchy(page, devServer.baseURL);
    await page.goto(`${devServer.baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });
    await exerciseNotesEditor(page);

    expect(getToastUiRequests(diagnostics).length).toBeGreaterThan(0);
    expect(getLegacyToastUiRequests(diagnostics)).toEqual([]);
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('round-trips TOAST UI visual breaks through saved Page detail rendering', async ({ page, devServer }) => {
    const chapterId = await createBrowserNotesHierarchy(page, devServer.baseURL);
    await page.goto(`${devServer.baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });

    const editor = page.locator('[data-notes-editor-host] .toastui-editor-defaultUI');
    const surface = editor.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]');
    await expect(editor).toBeVisible();
    await expect(surface).toBeVisible();

    await page.locator('#note-form [name="title"]').fill('TOAST UI Break Round Trip');
    await surface.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('before');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('after');

    const submissions = [];
    const recordSubmission = (request) => {
      if (request.method() !== 'POST') return;
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/notes' || /^\/notes\/\d+$/.test(pathname)) submissions.push(request.postData() || '');
    };
    page.on('request', recordSubmission);

    try {
      await Promise.all([
        page.waitForURL(/\/notes\/\d+$/),
        page.locator('button[type="submit"][form="note-form"]').click(),
      ]);

      expect(new URLSearchParams(submissions.at(-1)).get('content').replaceAll('\r\n', '\n'))
        .toBe('before\n\n<br>\nafter');
      await expect(page.locator('.notes-content br')).toHaveCount(2);
      await expect(page.locator('.notes-content')).not.toContainText('<br>');
      await expect(page.locator('.notes-content')).toContainText('before');
      await expect(page.locator('.notes-content')).toContainText('after');
    } finally {
      page.off('request', recordSubmission);
    }
  });

  test('renders fenced code blocks with independent Copy controls at responsive widths', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const chapterId = await createBrowserNotesHierarchy(page, devServer.baseURL);
    await page.goto(`${devServer.baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });

    const editor = page.locator('[data-notes-editor-host] .toastui-editor-defaultUI');
    await expect(editor).toBeVisible();
    await selectNotesEditorMode(editor.locator('.toastui-editor-mode-switch'), 'Markdown');
    await page.locator('#note-form [name="title"]').fill('Rendered Code Copy');
    await editor.locator('.toastui-editor-md-container .ProseMirror[contenteditable="true"]').fill([
      'Inline `value` remains inline.',
      '',
      '```javascript',
      'const value = 1;',
      'console.log(value);',
      '```',
      '',
      '```text',
      'const deliberatelyLongVariableName = "This line is long enough to require horizontal scrolling inside the code block without moving the page";',
      '```',
      '',
      '```css',
      '.example { color: cyan; }',
      '```',
      '',
      '```html',
      '<br>',
      '```',
    ].join('\n'));
    await Promise.all([
      page.waitForURL(/\/notes\/\d+$/),
      page.locator('button[type="submit"][form="note-form"]').click(),
    ]);

    await expect(page.locator('.notes-content pre > code')).toHaveCount(4);
    await expect(page.locator('.notes-content pre > code.language-javascript')).toHaveCount(1);
    await expect(page.locator('.notes-content pre > code.language-css')).toHaveCount(1);
    await expect(page.locator('.notes-content p > code')).toHaveCount(1);
    await expect(page.locator('.notes-content p > .notes-code-copy')).toHaveCount(0);

    const codeText = await page.locator('.notes-content pre > code').evaluateAll((elements) => (
      elements.map((element) => element.textContent)
    ));
    expect(codeText[0]).toBe('const value = 1;\nconsole.log(value);\n');
    expect(codeText[3]).toBe('<br>\n');

    const copyButtons = page.locator('.notes-content pre > .notes-code-copy');
    await expect(copyButtons).toHaveCount(4);
    await expect(copyButtons).toHaveText(['Copy', 'Copy', 'Copy', 'Copy']);

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: devServer.baseURL });
    const clipboardAvailable = await page.evaluate(() => typeof navigator.clipboard?.writeText === 'function');
    if (clipboardAvailable) {
      await copyButtons.nth(0).click();
      await expect(copyButtons.nth(0)).toHaveText('Copied');
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()
        .then((text) => text.replaceAll('\r\n', '\n')))).toBe(codeText[0]);
      await expect(copyButtons.nth(0)).toHaveText('Copy', { timeout: 3_000 });

      await copyButtons.nth(3).click();
      await expect(copyButtons.nth(3)).toHaveText('Copied');
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()
        .then((text) => text.replaceAll('\r\n', '\n')))).toBe(codeText[3]);
      await expect(copyButtons.nth(0)).toHaveText('Copy');
    } else {
      await expect(copyButtons).toBeDisabled();
    }

    for (const viewport of [1280, 720, 375]) {
      await page.setViewportSize({ width: viewport, height: 800 });
      const geometry = await page.locator('.notes-content').evaluate((content) => {
        const rect = (element) => {
          const box = element?.getBoundingClientRect();
          return box
            ? {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
            }
            : null;
        };
        return {
          content: rect(content),
          blocks: [...content.querySelectorAll('pre')].map((pre) => {
            const code = pre.querySelector(':scope > code');
            const button = pre.querySelector(':scope > .notes-code-copy');
            const preStyle = getComputedStyle(pre);
            const codeStyle = code ? getComputedStyle(code) : null;
            return {
              pre: rect(pre),
              code: rect(code),
              button: rect(button),
              preClientWidth: pre.clientWidth,
              preScrollWidth: pre.scrollWidth,
              preOverflowX: preStyle.overflowX,
              prePadding: preStyle.padding,
              preLineHeight: preStyle.lineHeight,
              preBorder: preStyle.border,
              preBackground: preStyle.backgroundColor,
              preMinWidth: preStyle.minWidth,
              preMaxWidth: preStyle.maxWidth,
              codeClientWidth: code?.clientWidth,
              codeScrollWidth: code?.scrollWidth,
              codeOverflowX: codeStyle?.overflowX,
              codeLineHeight: codeStyle?.lineHeight,
              codePadding: codeStyle?.padding,
              codeFontFamily: codeStyle?.fontFamily,
            };
          }),
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
      expect(geometry.blocks).toHaveLength(4);
      geometry.blocks.forEach(({ pre, code, button }) => {
        expect(pre.left).toBeGreaterThanOrEqual(0);
        expect(pre.right).toBeLessThanOrEqual(viewport + 1);
        expect(button.left).toBeGreaterThanOrEqual(pre.left);
        expect(button.right).toBeLessThanOrEqual(pre.right + 1);
        expect(button.bottom).toBeLessThanOrEqual(code.top + 1);
      });
      expect(geometry.blocks[1].codeScrollWidth).toBeGreaterThan(geometry.blocks[1].codeClientWidth);
      expect(geometry.blocks[1].preOverflowX).toBe('auto');
      expect(geometry.blocks[1].codeOverflowX).toBe('auto');
      expect(geometry.blocks[1].preMinWidth).toBe('0px');
      expect(geometry.blocks[1].preMaxWidth).toBe('100%');
      expect(geometry.blocks[1].codeLineHeight).toBe('20.3px');
    }

    const longBlockScroll = await page.locator('.notes-content pre').nth(1).evaluate((pre) => {
      const code = pre.querySelector(':scope > code');
      const button = pre.querySelector(':scope > .notes-code-copy');
      const before = button.getBoundingClientRect();
      const preBox = pre.getBoundingClientRect();
      code.scrollLeft = code.scrollWidth;
      const after = button.getBoundingClientRect();
      return {
        before: { left: before.left, right: before.right },
        after: { left: after.left, right: after.right },
        pre: { left: preBox.left, right: preBox.right },
        scrollLeft: code.scrollLeft,
        pageScrollX: window.scrollX,
      };
    });
    expect(longBlockScroll.scrollLeft).toBeGreaterThan(0);
    expect(longBlockScroll.after.left).toBe(longBlockScroll.before.left);
    expect(longBlockScroll.after.right).toBe(longBlockScroll.before.right);
    expect(longBlockScroll.after.right).toBeLessThanOrEqual(longBlockScroll.pre.right + 1);
    expect(longBlockScroll.pageScrollX).toBe(0);

    await page.locator('.notes-content pre > code').first().selectText();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain('const value = 1;');

    await copyButtons.first().evaluate((button) => button.focus({ focusVisible: true }));
    await expect.poll(() => page.locator('.notes-content pre > .notes-code-copy').first().evaluate((button) => (
      getComputedStyle(button).outlineStyle
    ))).toBe('solid');
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps Page edit actions, Book navigator, and responsive workspace valid', async ({ page, browser, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const bookId = await createBrowserBook(page, devServer.baseURL, `Browser Edit Book ${Date.now()}`);
    const chapterId = await createBrowserChapter(page, devServer.baseURL, bookId, `Browser Edit Chapter ${Date.now()}`);
    await createBrowserDirectPage(page, devServer.baseURL, bookId, 'Browser Direct Edit Page');
    const directPageId = new URL(page.url()).pathname.split('/').at(-1);
    await createBrowserPage(page, devServer.baseURL, chapterId, 'Browser Chapter Edit Page');
    const chapterPageId = new URL(page.url()).pathname.split('/').at(-1);
    let directPageTitle = 'Browser Direct Edit Page';

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 720, height: 800 },
      { width: 375, height: 800 },
    ]) {
      await page.setViewportSize(viewport);

      await page.goto(`${devServer.baseURL}/notes/${directPageId}/edit`, { waitUntil: 'domcontentloaded' });
      await assertPageEditWorkspace(page, {
        bookTitle: `Browser Edit Book`,
        pageTitle: directPageTitle,
        cancelHref: `/notes/${directPageId}`,
      });
      await expect(page.locator('.notes-workspace-context .notes-book-nav')).toHaveCount(1);
      await expect(page.locator(`.notes-book-detail-sidebar--embedded .notes-book-nav-list > .notes-book-nav-page:has(a[href="/notes/${directPageId}"]) a[aria-current="page"]`))
        .toHaveCount(1);
      await expect(page.locator('.notes-book-detail-sidebar--embedded .notes-book-nav details[open]')).toHaveCount(0);
      await expect(page.locator('#note-create-dialog[open] .notes-page-nav, #note-edit-dialog[open] .notes-page-nav')).toHaveCount(0);

      if (viewport.width > 1024) {
        await page.locator('#note-form [name="title"]').fill('');
        const validationResponse = await Promise.all([
          page.waitForResponse((response) => (
            response.request().method() === 'POST'
            && new URL(response.url()).pathname === `/notes/${directPageId}`
            && response.status() === 422
          )),
          page.getByRole('button', { name: 'Save', exact: true }).click(),
        ]);
        expect(validationResponse[0].status()).toBe(422);
        await expect(page.locator('.field-error-message')).toHaveCount(1);
        await assertWorkspaceDimensions(page, { editorRequired: true, actionsRequired: true });
        expect(diagnostics.consoleErrors.filter((message) => message.includes('status of 422'))).toHaveLength(1);
        diagnostics.consoleErrors = diagnostics.consoleErrors.filter((message) => !message.includes('status of 422'));
        await page.locator('#note-form [name="title"]').fill('Browser Direct Edit Saved');
        await Promise.all([
          page.waitForURL(new RegExp(`/notes/${directPageId}$`)),
          page.getByRole('button', { name: 'Save', exact: true }).click(),
        ]);
        directPageTitle = 'Browser Direct Edit Saved';
        await expect(page.locator('h1.app-section-title')).toContainText(directPageTitle);
      }

      await page.goto(`${devServer.baseURL}/notes/${chapterPageId}/edit`, { waitUntil: 'domcontentloaded' });
      await assertPageEditWorkspace(page, {
        bookTitle: 'Browser Edit Book',
        pageTitle: 'Browser Chapter Edit Page',
        cancelHref: `/notes/${chapterPageId}`,
      });
      const containingChapterNav = page.locator('.notes-book-detail-sidebar--embedded .notes-book-nav-list > .notes-book-nav-chapter')
        .filter({ hasText: 'Browser Edit Chapter' });
      await expect(containingChapterNav.locator('details[open]')).toHaveCount(1);
      await expect(containingChapterNav.locator(`a[href="/notes/${chapterPageId}"][aria-current="page"]`)).toHaveCount(1);
      await expect(page.locator('.notes-book-detail-sidebar--embedded .notes-book-nav [aria-current="page"]')).toHaveCount(1);
      await expect(page.locator('#note-create-dialog[open] .notes-page-nav, #note-edit-dialog[open] .notes-page-nav')).toHaveCount(0);

      await page.goto(`${devServer.baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });
      await expandPageDialogBookContents(page);
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
      await expect(page.locator('#note-create-dialog [data-dialog-close]')).toBeVisible();
      await expect(page.locator('.notes-book-detail-sidebar--embedded .notes-book-nav-chapter.notes-book-nav-item--current > .notes-book-nav-disclosure[open]')).toHaveCount(1);
      await expect(page.locator('.notes-book-detail-sidebar--embedded').getByText('View Chapter', { exact: true })).toHaveCount(0);
      await expect(page.locator('.notes-workspace')).toContainText('Connections');
      await expect(page.locator('#note-create-dialog[open] .notes-workspace-disclosure, #note-edit-dialog[open] .notes-workspace-disclosure')).toHaveCount(0);
      await expect(page.locator('#note-create-dialog[open] .notes-workspace-secondary, #note-edit-dialog[open] .notes-workspace-secondary')).toHaveCount(0);
      await expect(page.locator('#note-form form')).toHaveCount(0);
      await expect(page.locator('[data-note-connections] #note-assets-form')).toBeAttached();
      await assertWorkspaceDimensions(page, { editorRequired: true });

      if (viewport.width > 1024) {
        await page.locator('#note-form [name="title"]').fill('');
        const createValidationResponse = await Promise.all([
          page.waitForResponse((response) => (
            response.request().method() === 'POST'
            && new URL(response.url()).pathname === '/notes'
            && response.status() === 422
          )),
          page.getByRole('button', { name: 'Create', exact: true }).click(),
        ]);
        expect(createValidationResponse[0].status()).toBe(422);
        await expect(page.locator('.field-error-message')).toHaveCount(1);
        await assertWorkspaceDimensions(page, { editorRequired: true });
        expect(diagnostics.consoleErrors.filter((message) => message.includes('status of 422'))).toHaveLength(1);
        diagnostics.consoleErrors = diagnostics.consoleErrors.filter((message) => !message.includes('status of 422'));
        await page.locator('#note-form [name="title"]').fill('Browser Created Edit Smoke Page');
        await Promise.all([
          page.waitForURL(/\/notes\/\d+$/),
          page.getByRole('button', { name: 'Create', exact: true }).click(),
        ]);
        await expect(page.locator('h1.app-section-title')).toContainText('Browser Created Edit Smoke Page');
      }

      await page.goto(`${devServer.baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });
      await expandPageDialogBookContents(page);
      const createChapterNav = page.locator('.notes-book-detail-sidebar--embedded .notes-book-nav-list > .notes-book-nav-chapter')
        .filter({ hasText: 'Browser Edit Chapter' });
      await expect(page.locator('.notes-workspace-context .notes-book-nav')).toHaveCount(1);
      await expect(createChapterNav.locator('details[open]')).toHaveCount(1);
      await expect(createChapterNav).toHaveClass(/notes-book-nav-item--current/);
      await expect(page.locator('.notes-book-detail-sidebar--embedded').getByText('View Chapter', { exact: true })).toHaveCount(0);
      await expect(page.locator('.notes-book-detail-sidebar--embedded .notes-book-nav [aria-current="page"]')).toHaveCount(0);
      await expect(page.locator('.notes-book-detail-sidebar--embedded .notes-book-nav .notes-book-nav-page-link[aria-current="page"]')).toHaveCount(0);
      await expect(page.locator('#note-create-dialog[open] .notes-page-nav, #note-edit-dialog[open] .notes-page-nav')).toHaveCount(0);
      await assertWorkspaceDimensions(page, { editorRequired: true });

      await page.goto(`${devServer.baseURL}/notes/new?bookId=${bookId}`, { waitUntil: 'domcontentloaded' });
      await expandPageDialogBookContents(page);
      await expect(page.locator('.notes-workspace-context .notes-book-nav')).toHaveCount(1);
      await expect(page.locator('.notes-book-detail-sidebar--embedded .notes-book-nav [aria-current="page"]')).toHaveCount(0);
      await expect(page.locator('.notes-book-detail-sidebar--embedded .notes-book-nav details[open]')).toHaveCount(0);
      await expect(page.locator('#note-create-dialog[open] .notes-page-nav, #note-edit-dialog[open] .notes-page-nav')).toHaveCount(0);
      await assertWorkspaceDimensions(page, { editorRequired: true });
    }

    const fallbackContext = await browser.newContext();
    try {
      const fallbackPage = await fallbackContext.newPage();
      await fallbackPage.route('**/*', (route) => {
        if (/@toast-ui|toastui/i.test(route.request().url())) return route.abort();
        return route.continue();
      });
      const response = await fallbackPage.goto(`${devServer.baseURL}/notes/new?chapterId=${chapterId}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(response?.status()).toBe(200);
      const fallback = fallbackPage.locator('[data-notes-editor-source]');
      await expect(fallback).toBeVisible();
      await expect(fallbackPage.locator('[data-notes-editor-host] .toastui-editor-defaultUI')).toHaveCount(0);
      const fallbackState = await fallback.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          width: box.width,
          parentWidth: element.parentElement?.getBoundingClientRect().width || 0,
          height: box.height,
          minHeight: style.minHeight,
          display: style.display,
          overflowX: style.overflowX,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      expect(fallbackState.width).toBeGreaterThan(0);
      expect(fallbackState.width).toBeCloseTo(fallbackState.parentWidth, 0);
      expect(fallbackState.height).toBeGreaterThanOrEqual(16 * 16);
      expect(fallbackState.display).toBe('block');
      expect(fallbackState.scrollWidth).toBeLessThanOrEqual(fallbackState.clientWidth);
    } finally {
      await fallbackContext.close();
    }

    expect(diagnostics.failedRequests.filter(({ url }) => new URL(url).pathname.startsWith('/notes/asset-picker/'))).toEqual([]);
    expect(diagnostics.failedResponses.filter(({ url }) => new URL(url).pathname.startsWith('/notes/asset-picker/'))).toEqual([]);
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps Chapter edit compact with Save/Cancel and a separate delete disclosure', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const bookTitle = `Browser Chapter Edit Book ${Date.now()}`;
    const chapterTitle = `Browser Chapter Edit ${Date.now()}`;
    const bookId = await createBrowserBook(page, devServer.baseURL, bookTitle);
    const chapterId = await createBrowserChapter(page, devServer.baseURL, bookId, chapterTitle);
    const chapterUrl = `${devServer.baseURL}/notes/chapters/${chapterId}`;
    const editUrl = `${chapterUrl}/edit`;
    const editedTitle = `${chapterTitle} Saved`;

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 375, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const response = await page.goto(chapterUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      await page.getByRole('link', { name: 'Edit Chapter', exact: true }).click();
      const editDialog = page.locator('#chapter-edit-dialog[open]');

      await expect(page.locator('h1.app-section-title')).toContainText(chapterTitle);
      await expect(editDialog).toBeVisible();
      await expect(editDialog.getByRole('heading', { name: 'Edit Chapter', exact: true })).toBeVisible();
      await expect(editDialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await expect(editDialog.locator('#chapter-edit-title')).toHaveValue(viewport.width > 1024 ? chapterTitle : editedTitle);
      await expect(editDialog.locator('details.notes-workspace-disclosure')).toHaveCount(1);
      await expect(editDialog.locator('details.notes-workspace-disclosure[open]')).toHaveCount(0);
      await expect(editDialog.getByRole('button', { name: 'Delete Chapter', exact: true })).toBeHidden();
      await expect(editDialog.locator('#chapter-delete-form')).toHaveAttribute('action', `/notes/chapters/${chapterId}/delete`);
      await expect(editDialog.locator('#chapter-delete-form input[name="_csrf"]')).toHaveCount(1);
      await expect(editDialog.locator('#chapter-delete-form button[data-confirm]')).toBeAttached();
      await expect(page.locator('main#main-content')).not.toContainText('Danger zone');

      const layoutState = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        mainRight: element.getBoundingClientRect().right,
      }));
      expect(layoutState.documentWidth).toBeLessThanOrEqual(layoutState.viewportWidth);
      expect(layoutState.mainRight).toBeLessThanOrEqual(layoutState.viewportWidth);

      if (viewport.width > 1024) {
        await editDialog.locator('#chapter-edit-title').fill(editedTitle);
        await Promise.all([
          page.waitForURL(new RegExp(`/notes/chapters/${chapterId}$`)),
          editDialog.getByRole('button', { name: 'Save', exact: true }).click(),
        ]);
        await expect(page.locator('h1.app-section-title')).toContainText(editedTitle);

        await page.getByRole('link', { name: 'Edit Chapter', exact: true }).click();
        await page.locator('#chapter-edit-dialog[open] #chapter-edit-title').fill('Unsaved Chapter Title');
        await page.locator('#chapter-edit-dialog[open] [data-dialog-close]').click();
        await expect(page.locator('#chapter-edit-dialog')).not.toHaveAttribute('open', '');
        await expect(page.locator('h1.app-section-title')).toContainText(editedTitle);
      }
    }

    await page.goto(chapterUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Edit Chapter', exact: true }).click();
    await page.locator('#chapter-edit-dialog[open] details.notes-workspace-disclosure summary').click();
    await expect(page.locator('#chapter-edit-dialog[open] details.notes-workspace-disclosure[open]')).toHaveCount(1);
    await expect(page.locator('#chapter-edit-dialog[open]').getByRole('button', { name: 'Delete Chapter', exact: true })).toBeVisible();
    const openLayoutState = await page.locator('main#main-content').evaluate((element) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(openLayoutState.documentWidth).toBeLessThanOrEqual(openLayoutState.viewportWidth);

    const confirmationDialog = page.locator('#app-confirmation-dialog');
    await page.locator('#chapter-edit-dialog[open]').getByRole('button', { name: 'Delete Chapter', exact: true }).click();
    await expect(confirmationDialog).toBeVisible();
    await expect(confirmationDialog).toContainText('Delete this Chapter permanently? This cannot be undone.');
    await Promise.all([
      page.waitForURL(new RegExp(`/notes/books/${bookId}$`)),
      confirmationDialog.getByRole('button', { name: 'Confirm', exact: true }).click(),
    ]);
    await expect(page.locator('h1.app-section-title')).toContainText(bookTitle);

    const nonEmptyChapterId = await createBrowserChapter(page, devServer.baseURL, bookId, 'Browser Non-empty Chapter');
    await createBrowserPage(page, devServer.baseURL, nonEmptyChapterId, 'Browser Non-empty Page');
    await page.goto(`${devServer.baseURL}/notes/chapters/${nonEmptyChapterId}/edit`, { waitUntil: 'domcontentloaded' });
    const nonEmptyCsrfToken = await page.locator('#chapter-delete-form input[name="_csrf"]').inputValue();
    const deleteResponse = await page.request.post(
      `${devServer.baseURL}/notes/chapters/${nonEmptyChapterId}/delete`,
      { form: { _csrf: nonEmptyCsrfToken } },
    );
    expect(deleteResponse.status()).toBe(409);
    await expect(await deleteResponse.text()).toContain('cannot be deleted while it contains Notes.');
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps Chapter detail in Book context with a safe responsive navigator stack', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const bookTitle = `Browser Chapter Navigator Book ${Date.now()}`;
    const directFirstTitle = 'Browser Navigator Direct First';
    const currentChapterTitle = 'Browser Navigator Current Chapter';
    const nestedPageTitles = ['Browser Navigator Nested First', 'Browser Navigator Nested Second'];
    const directSecondTitle = 'Browser Navigator Direct Second';
    const otherChapterTitle = 'Browser Navigator Other Chapter';
    const bookId = await createBrowserBook(page, devServer.baseURL, bookTitle);

    await createBrowserDirectPage(page, devServer.baseURL, bookId, directFirstTitle);
    const directFirstId = new URL(page.url()).pathname.split('/').at(-1);
    const chapterId = await createBrowserChapter(page, devServer.baseURL, bookId, currentChapterTitle);
    const nestedPageIds = [];
    for (const title of nestedPageTitles) {
      nestedPageIds.push(await createBrowserPage(page, devServer.baseURL, chapterId, title));
    }
    await createBrowserDirectPage(page, devServer.baseURL, bookId, directSecondTitle);
    const directSecondId = new URL(page.url()).pathname.split('/').at(-1);
    const otherChapterId = await createBrowserChapter(page, devServer.baseURL, bookId, otherChapterTitle);
    expect(otherChapterId).not.toBe(chapterId);

    const chapterUrl = `${devServer.baseURL}/notes/chapters/${chapterId}`;
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 720, height: 800 },
      { width: 375, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const response = await page.goto(chapterUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);

      await expect(page.locator('.notes-chapter-detail-layout')).toHaveCount(1);
      await expect(page.locator('header.page-heading')).toHaveCount(1);
      await expect(page.locator('h1.app-section-title')).toHaveCount(1);
      const navigator = page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav');
      await expect(navigator).toHaveCount(1);
      await expect(page.locator('.notes-chapter-detail-sidebar.notes-surface.notes-surface--compact')).toHaveCount(1);
       await expect(navigator.locator('.notes-book-nav-book-link'))
         .toHaveAttribute('href', `/notes/books/${bookId}`);
       await expect(page.locator('.notes-chapter-detail-content.notes-surface')).toHaveCount(1);
       await expect(page.locator('.notes-hierarchy')).toHaveCount(0);

      const headingComposition = await page.locator('main#main-content').evaluate((main) => {
        const heading = main.querySelector('header.page-heading');
        const layout = main.querySelector('.notes-chapter-detail-layout');
        const navigator = layout?.querySelector('.notes-chapter-detail-sidebar');
        const headingRect = heading?.getBoundingClientRect();
        const layoutRect = layout?.getBoundingClientRect();
        const navigatorRect = navigator?.getBoundingClientRect();
        return {
          headingBeforeLayout: Boolean(heading && layout
            && (heading.compareDocumentPosition(layout) & Node.DOCUMENT_POSITION_FOLLOWING)),
          headingWidth: headingRect?.width || 0,
          layoutWidth: layoutRect?.width || 0,
          headingBottom: headingRect?.bottom || 0,
          navigatorTop: navigatorRect?.top || 0,
        };
      });
      expect(headingComposition.headingBeforeLayout).toBe(true);
      expect(Math.abs(headingComposition.headingWidth - headingComposition.layoutWidth)).toBeLessThan(1);
      expect(headingComposition.navigatorTop).toBeGreaterThanOrEqual(headingComposition.headingBottom);

      const topLevelTitles = await navigator.locator('.notes-book-nav-list > .notes-book-nav-item').evaluateAll(
        (items) => items.map((item) => item.querySelector(
          '.notes-book-nav-summary .notes-book-nav-chapter-title, .notes-book-nav-page-link',
        )?.textContent?.trim()),
      );
      expect(topLevelTitles).toEqual([
        directFirstTitle,
        currentChapterTitle,
        directSecondTitle,
        otherChapterTitle,
      ]);
      await expect(navigator.locator('.notes-book-nav-list > .notes-book-nav-page')).toHaveCount(2);
      await expect(navigator.locator(`.notes-book-nav-page-link[href="/notes/${directFirstId}"]`)).toBeVisible();
      await expect(navigator.locator(`.notes-book-nav-page-link[href="/notes/${directSecondId}"]`)).toBeVisible();

      const currentNavItem = navigator.locator('.notes-book-nav-item--current');
      await expect(currentNavItem).toHaveCount(1);
      await expect(currentNavItem).toHaveClass(/notes-book-nav-chapter/);
      await expect(currentNavItem.locator('summary.notes-book-nav-summary .notes-book-nav-chapter-title')).toHaveText(currentChapterTitle);
      await expect(currentNavItem.locator('details[open]')).toHaveCount(1);
      await expect(currentNavItem.locator('ol.notes-book-nav-pages > .notes-book-nav-item')).toHaveCount(2);
      expect(await currentNavItem.locator('ol.notes-book-nav-pages > .notes-book-nav-item').evaluateAll(
        (items) => items.map((item) => item.textContent.trim()),
      )).toEqual(nestedPageTitles);
      for (const pageId of nestedPageIds) {
        await expect(currentNavItem.locator(`a[href="/notes/${pageId}"]`)).toBeVisible();
      }

      const unrelatedNavItem = navigator.locator('.notes-book-nav-list > .notes-book-nav-item')
        .filter({ hasText: otherChapterTitle });
      await expect(unrelatedNavItem.locator('details[open]')).toHaveCount(0);
      await expect(navigator.locator('[aria-current="page"]')).toHaveCount(0);

      await expect(page.locator('.notes-page-nav')).toHaveAttribute(
        'aria-label',
        `Pages in ${currentChapterTitle}`,
      );
      await expect(page.locator('.notes-page-nav-item')).toHaveCount(2);
      await expect(page.locator('.notes-page-nav [aria-current="page"]')).toHaveCount(0);
      for (const title of nestedPageTitles) {
        await expect(page.locator('.notes-page-nav')).toContainText(title);
      }
      await expect(page.locator('.notes-page-nav')).not.toContainText(directFirstTitle);
      await expect(page.locator('.notes-page-nav')).not.toContainText(directSecondTitle);
       await expect(page.getByRole('link', { name: 'New Page', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Edit Chapter', exact: true })).toBeVisible();

      const layout = await page.locator('.notes-chapter-detail-layout').evaluate((element) => {
        const navigator = element.querySelector('.notes-chapter-detail-sidebar')?.getBoundingClientRect();
        const content = element.querySelector('.notes-chapter-detail-content')?.getBoundingClientRect();
        return {
          columns: getComputedStyle(element).gridTemplateColumns,
          navigatorTop: navigator?.top || 0,
          contentTop: content?.top || 0,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
      if (viewport.width <= 767) {
        expect(layout.columns.split(' ').length).toBe(1);
        expect(layout.navigatorTop).toBeLessThan(layout.contentTop);
      } else {
        expect(layout.columns.split(' ').length).toBe(2);
      }
    }

    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps Page detail in Book context with a safe responsive navigator stack', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const bookTitle = `Browser Page Navigator Book ${Date.now()}`;
    const directFirstTitle = 'Browser Page Navigator Direct First';
    const currentChapterTitle = 'Browser Page Navigator Current Chapter';
    const nestedPageTitles = ['Browser Page Navigator Nested First', 'Browser Page Navigator Current Page'];
    const directSecondTitle = 'Browser Page Navigator Direct Second';
    const otherChapterTitle = 'Browser Page Navigator Other Chapter';
    const bookId = await createBrowserBook(page, devServer.baseURL, bookTitle);

    await createBrowserDirectPage(page, devServer.baseURL, bookId, directFirstTitle);
    const directFirstId = new URL(page.url()).pathname.split('/').at(-1);
    const chapterId = await createBrowserChapter(page, devServer.baseURL, bookId, currentChapterTitle);
    const nestedPageIds = [];
    for (const title of nestedPageTitles) {
      nestedPageIds.push(await createBrowserPage(page, devServer.baseURL, chapterId, title));
    }
    await createBrowserDirectPage(page, devServer.baseURL, bookId, directSecondTitle);
    const directSecondId = new URL(page.url()).pathname.split('/').at(-1);
    const otherChapterId = await createBrowserChapter(page, devServer.baseURL, bookId, otherChapterTitle);
    expect(otherChapterId).not.toBe(chapterId);

    const pageUrl = `${devServer.baseURL}/notes/${nestedPageIds[1]}`;
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 720, height: 800 },
      { width: 375, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);

      await expect(page.locator('.notes-page-detail-layout')).toHaveCount(1);
      await expect(page.locator('header.page-heading')).toHaveCount(1);
      await expect(page.locator('h1.app-section-title')).toHaveCount(1);
      const navigator = page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav');
      await expect(navigator).toHaveCount(1);
      await expect(page.locator('.notes-page-detail-sidebar.notes-surface.notes-surface--compact')).toHaveCount(1);
      await expect(navigator.locator('.notes-book-nav-book-link'))
        .toHaveAttribute('href', `/notes/books/${bookId}`);

      const headingComposition = await page.locator('main#main-content').evaluate((main) => {
        const heading = main.querySelector('header.page-heading');
        const layout = main.querySelector('.notes-page-detail-layout');
        const navigator = layout?.querySelector('.notes-page-detail-sidebar');
        const headingRect = heading?.getBoundingClientRect();
        const layoutRect = layout?.getBoundingClientRect();
        const navigatorRect = navigator?.getBoundingClientRect();
        return {
          headingBeforeLayout: Boolean(heading && layout
            && (heading.compareDocumentPosition(layout) & Node.DOCUMENT_POSITION_FOLLOWING)),
          headingWidth: headingRect?.width || 0,
          layoutWidth: layoutRect?.width || 0,
          headingBottom: headingRect?.bottom || 0,
          navigatorTop: navigatorRect?.top || 0,
        };
      });
      expect(headingComposition.headingBeforeLayout).toBe(true);
      expect(Math.abs(headingComposition.headingWidth - headingComposition.layoutWidth)).toBeLessThan(1);
      expect(headingComposition.navigatorTop).toBeGreaterThanOrEqual(headingComposition.headingBottom);

      const topLevelTitles = await navigator.locator('.notes-book-nav-list > .notes-book-nav-item').evaluateAll(
        (items) => items.map((item) => item.querySelector(
          '.notes-book-nav-summary .notes-book-nav-chapter-title, .notes-book-nav-page-link',
        )?.textContent?.trim()),
      );
      expect(topLevelTitles).toEqual([
        directFirstTitle,
        currentChapterTitle,
        directSecondTitle,
        otherChapterTitle,
      ]);
      await expect(navigator.locator(`.notes-book-nav-page-link[href="/notes/${directFirstId}"]`)).toBeVisible();
      await expect(navigator.locator(`.notes-book-nav-page-link[href="/notes/${directSecondId}"]`)).toBeVisible();

      const currentNavItem = navigator.locator('.notes-book-nav-item--current');
      await expect(currentNavItem).toHaveCount(1);
      await expect(currentNavItem.locator('details[open]')).toHaveCount(0);
      const containingChapter = navigator.locator('.notes-book-nav-list > .notes-book-nav-item')
        .filter({ hasText: currentChapterTitle });
      await expect(containingChapter.locator('details[open]')).toHaveCount(1);
      await expect(containingChapter.locator('summary.notes-book-nav-summary')).not.toHaveAttribute('aria-current', 'page');
      await expect(containingChapter.locator(`a[href="/notes/${nestedPageIds[1]}"]`))
        .toHaveAttribute('aria-current', 'page');
      expect(await containingChapter.locator('ol.notes-book-nav-pages > .notes-book-nav-item').evaluateAll(
        (items) => items.map((item) => item.textContent.trim()),
      )).toEqual(nestedPageTitles);

      const unrelatedNavItem = navigator.locator('.notes-book-nav-list > .notes-book-nav-item')
        .filter({ hasText: otherChapterTitle });
      await expect(unrelatedNavItem.locator('details[open]')).toHaveCount(0);
      await expect(navigator.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(page.locator('.notes-page-nav')).toHaveCount(0);
      await expect(page.locator('.notes-hierarchy')).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Edit Page', exact: true })).toBeVisible();
      await expect(page.locator('.notes-page-sidebar')).toContainText('Details');
      await expect(page.locator('.notes-detail-details')).toContainText('Created');
      await expect(page.locator('.notes-detail-details')).toContainText('Updated');
       await expect(page.locator('.notes-detail-kicker')).toHaveText(nestedPageTitles[1]);
       await expect(page.locator('.notes-detail-content')).not.toContainText('Reading view');
       await expect(page.locator('.notes-detail-content > .notes-detail-section-heading > h2')).toHaveCount(0);
      await expect(page.locator('.notes-detail-layout')).toHaveCount(0);
      await expect(page.locator('.notes-detail-reading')).toHaveCount(0);
      await expect(page.locator('.notes-detail-sidebar')).toHaveCount(0);

      const layout = await page.locator('.notes-page-detail-layout').evaluate((element) => {
        const navigator = element.querySelector('.notes-page-detail-sidebar')?.getBoundingClientRect();
        const details = element.querySelector('.notes-detail-details')?.getBoundingClientRect();
        const content = element.querySelector('.notes-page-detail-content')?.getBoundingClientRect();
        const layoutRect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const sidebarStack = element.querySelector('.notes-page-sidebar');
        const sidebarStackStyle = sidebarStack ? getComputedStyle(sidebarStack) : null;
        const gap = parseFloat(style.columnGap) || 0;
        const sidebarGap = parseFloat(sidebarStackStyle?.rowGap || '0') || 0;
        return {
          columns: style.gridTemplateColumns,
          primaryColumns: getComputedStyle(element.querySelector('.notes-page-detail-content')).gridTemplateColumns,
          layoutTop: layoutRect.top,
          layoutWidth: layoutRect.width,
          gap,
          sidebarGap,
          navigatorTop: navigator?.top || 0,
          navigatorBottom: navigator?.bottom || 0,
          navigatorLeft: navigator?.left || 0,
          navigatorWidth: navigator?.width || 0,
          detailsTop: details?.top || 0,
          detailsLeft: details?.left || 0,
          detailsWidth: details?.width || 0,
          contentTop: content?.top || 0,
          contentWidth: content?.width || 0,
          contentBottom: content?.bottom || 0,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
      if (viewport.width <= 767) {
        expect(layout.columns.split(' ').length).toBe(1);
        expect(layout.navigatorTop).toBeLessThan(layout.contentTop);
        expect(layout.contentTop).toBeLessThan(layout.detailsTop);
        expect(layout.detailsTop).toBeGreaterThanOrEqual(layout.contentBottom);
        expect(layout.contentWidth).toBeCloseTo(layout.layoutWidth, 0);
      } else {
        expect(layout.columns.split(' ').length).toBe(2);
        expect(layout.primaryColumns.split(' ').length).toBe(1);
        expect(Math.abs(layout.contentTop - layout.layoutTop)).toBeLessThan(1);
        expect(layout.navigatorWidth).toBeGreaterThanOrEqual(12 * 16);
        expect(layout.navigatorWidth).toBeLessThanOrEqual(16 * 16);
        expect(layout.contentWidth).toBeCloseTo(layout.layoutWidth - layout.navigatorWidth - layout.gap, 0);
        expect(layout.contentWidth).toBeGreaterThan(layout.navigatorWidth * 2);
        expect(layout.detailsTop).toBeGreaterThanOrEqual(layout.navigatorBottom + layout.sidebarGap - 1);
        expect(Math.abs(layout.detailsLeft - layout.navigatorLeft)).toBeLessThan(1);
        expect(layout.detailsWidth).toBeCloseTo(layout.navigatorWidth, 0);
      }
    }

    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps Book edit compact with Save/Cancel and a separate delete disclosure', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const originalBookTitle = `Browser Book Edit ${Date.now()}`;
    const chapterTitle = 'Book Edit Chapter';
    const directPageTitle = 'Book Edit Direct Page';
    const bookId = await createBrowserBook(page, devServer.baseURL, originalBookTitle);
    await createBrowserChapter(page, devServer.baseURL, bookId, chapterTitle);
    await createBrowserDirectPage(page, devServer.baseURL, bookId, directPageTitle);
    const bookUrl = `${devServer.baseURL}/notes/books/${bookId}`;
    const editUrl = `${bookUrl}/edit`;
    const editedBookTitle = `${originalBookTitle} Saved`;

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 375, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const response = await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      await page.getByRole('link', { name: 'Edit book', exact: true }).click();
      const editDialog = page.locator('#book-edit-dialog[open]');

      await expect(page.locator('h1.app-section-title')).toContainText(
        viewport.width > 1024 ? originalBookTitle : editedBookTitle,
      );
      await expect(editDialog).toBeVisible();
      await expect(editDialog.getByRole('heading', { name: 'Edit Book', exact: true })).toBeVisible();
      await expect(editDialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await expect(editDialog.locator('#title')).toHaveValue(viewport.width > 1024 ? originalBookTitle : editedBookTitle);
      await expect(editDialog.locator('#book-form .settings-section')).toHaveCount(2);
      await expect(editDialog.locator('#book-form form')).toHaveCount(0);
      await expect(editDialog.locator('details.notes-workspace-disclosure--delete')).toHaveCount(1);
      await expect(editDialog.locator('details.notes-workspace-disclosure--delete[open]')).toHaveCount(0);
      await expect(editDialog.getByRole('button', { name: 'Delete Book', exact: true })).toBeHidden();
      await expect(editDialog.locator('#book-delete-form')).toHaveAttribute('action', `/notes/books/${bookId}/delete`);
      await expect(editDialog.locator('#book-delete-form input[name="_csrf"]')).toHaveCount(1);
      await expect(page.locator('main#main-content')).not.toContainText('Danger zone');

      await editDialog.locator('details.notes-workspace-disclosure--delete summary').click();
      await expect(editDialog.locator('details.notes-workspace-disclosure--delete[open]')).toHaveCount(1);
      await expect(editDialog.getByRole('button', { name: 'Delete Book', exact: true })).toBeVisible();
      const openLayoutState = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        mainRight: element.getBoundingClientRect().right,
      }));
      expect(openLayoutState.documentWidth).toBeLessThanOrEqual(openLayoutState.viewportWidth);
      expect(openLayoutState.mainRight).toBeLessThanOrEqual(openLayoutState.viewportWidth);
      await editDialog.locator('details.notes-workspace-disclosure--delete summary').click();

      const layoutState = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        mainRight: element.getBoundingClientRect().right,
      }));
      expect(layoutState.documentWidth).toBeLessThanOrEqual(layoutState.viewportWidth);
      expect(layoutState.mainRight).toBeLessThanOrEqual(layoutState.viewportWidth);

      if (viewport.width > 1024) {
        await editDialog.locator('#title').fill(editedBookTitle);
        await Promise.all([
          page.waitForURL(new RegExp(`/notes/books/${bookId}$`)),
          editDialog.getByRole('button', { name: 'Save', exact: true }).click(),
        ]);
        await expect(page.locator('h1.app-section-title')).toContainText(editedBookTitle);
        await expect(page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav-chapter-title'))
          .toHaveText(chapterTitle);
        await expect(page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav')
          .getByRole('link', { name: directPageTitle, exact: true })).toBeVisible();

        await page.getByRole('link', { name: 'Edit book', exact: true }).click();
        await page.locator('#book-edit-dialog[open] #title').fill('Unsaved Book Title');
        await page.locator('#book-edit-dialog[open] [data-dialog-close]').click();
        await expect(page.locator('#book-edit-dialog')).not.toHaveAttribute('open', '');
        await expect(page.locator('h1.app-section-title')).toContainText(editedBookTitle);
      }
    }

    const emptyBookId = await createBrowserBook(page, devServer.baseURL, `Browser Empty Book ${Date.now()}`);
    await page.goto(`${devServer.baseURL}/notes/books/${emptyBookId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Edit book', exact: true }).click();
    await page.locator('#book-edit-dialog[open] details.notes-workspace-disclosure--delete summary').click();
    const confirmationDialog = page.locator('#app-confirmation-dialog');
    await page.locator('#book-edit-dialog[open]').getByRole('button', { name: 'Delete Book', exact: true }).click();
    await expect(confirmationDialog).toBeVisible();
    await expect(confirmationDialog).toContainText('Delete this Book permanently? This cannot be undone.');
    await Promise.all([
      page.waitForURL(/\/notes$/),
      confirmationDialog.getByRole('button', { name: 'Confirm', exact: true }).click(),
    ]);

    await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
    const nonEmptyCsrfToken = await page.locator('#book-delete-form input[name="_csrf"]').inputValue();
    const deleteResponse = await page.request.post(
      `${devServer.baseURL}/notes/books/${bookId}/delete`,
      { form: { _csrf: nonEmptyCsrfToken } },
    );
    expect(deleteResponse.status()).toBe(409);
    await expect(await deleteResponse.text()).toContain('cannot be deleted while it contains chapters');
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps the Books landing compact, ordered, and usable on narrow screens', async ({ page, devServer }) => {
    await page.setViewportSize({ width: 375, height: 800 });

    const emptyResponse = await page.goto(`${devServer.baseURL}/notes`, { waitUntil: 'domcontentloaded' });
    expect(emptyResponse?.status()).toBe(200);
    await expect(page.locator('h1.app-section-title')).toHaveText('Notes');
    await expect(page.locator('.page-heading-actions').getByRole('link', { name: 'New Book', exact: true })).toBeVisible();
     await expect(page.locator('.notes-books-index > .empty-state')).toContainText('No books yet');
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toHaveCount(0);
    await expect(page.locator('.notes-books-index .notes-book-card')).toHaveCount(0);
    await expect(page.locator('.table-scroll, .data-table')).toHaveCount(0);

    const firstBookTitle = `Browser Landing Book One ${Date.now()}`;
    await createBrowserBook(page, devServer.baseURL, firstBookTitle);
    await page.goto(`${devServer.baseURL}/notes`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.notes-books-index .notes-book-card')).toHaveCount(1);
    await expect(page.getByRole('link', { name: firstBookTitle, exact: true })).toHaveCount(1);
    await expect(page.getByRole('link', { name: `Edit Book: ${firstBookTitle}`, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toHaveCount(0);

    const secondBookTitle = `Browser Landing Book Two ${Date.now()}`;
    await createBrowserBook(page, devServer.baseURL, secondBookTitle);
    await page.goto(`${devServer.baseURL}/notes`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.notes-books-index .notes-book-card')).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: `Edit Book: ${firstBookTitle}`, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: `Edit Book: ${secondBookTitle}`, exact: true })).toBeVisible();
    await expect(page.locator('main#main-content')).not.toContainText('Manage');
    await expect(page.locator('main#main-content')).not.toContainText('Move up');
    await expect(page.locator('main#main-content')).not.toContainText('Move down');
    await expect(page.locator('main#main-content [draggable="true"]')).toHaveCount(0);

    const narrowState = await page.locator('main#main-content').evaluate((element) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      rowRight: Math.max(...[...element.querySelectorAll('.notes-books-index .notes-book-card')]
        .map((row) => row.getBoundingClientRect().right)),
    }));
    expect(narrowState.documentWidth).toBeLessThanOrEqual(narrowState.viewportWidth);
    expect(narrowState.rowRight).toBeLessThanOrEqual(narrowState.viewportWidth);

    await page.setViewportSize({ width: 1280, height: 800 });
    const desktopState = await page.locator('main#main-content').evaluate((element) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      rowRight: Math.max(...[...element.querySelectorAll('.notes-books-index .notes-book-card')]
        .map((row) => row.getBoundingClientRect().right)),
    }));
    expect(desktopState.documentWidth).toBeLessThanOrEqual(desktopState.viewportWidth);
    expect(desktopState.rowRight).toBeLessThanOrEqual(desktopState.viewportWidth);

    await page.getByRole('link', { name: 'Change order', exact: true }).click();
    await expect(page).toHaveURL(`${devServer.baseURL}/notes`);
    await expect(page.locator('#books-order-dialog[open]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Change order', exact: true, level: 2 })).toBeVisible();
    await expect(page.locator('#books-order-dialog[open]').getByRole('button', { name: 'Close Change order', exact: true })).toBeVisible();
    await expect(page.locator('.notes-books-order .notes-book-content-row')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(page.locator('#notes-books-order-form')).toHaveAttribute('action', '/notes/books/reorder');
    await expect(page.locator('#notes-books-order-form input[name="orderedBookIds"]')).toHaveValue(/\d+,\d+/);
    await expect(page.locator('[data-book-reorder-handle]')).toHaveCount(2);
  });

  test('reorders top-level Books by drag and keyboard, saves once, and cancels unsaved changes', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const titles = [
      `Browser Order Book One ${Date.now()}`,
      `Browser Order Book Two ${Date.now()}`,
      `Browser Order Book Three ${Date.now()}`,
    ];
    const bookIds = [];
    for (const title of titles) bookIds.push(await createBrowserBook(page, devServer.baseURL, title));

    const expectedInitialOrder = [...titles];
    const expectedDragOrder = [titles[1], titles[2], titles[0]];
    const expectedKeyboardOrder = [titles[1], titles[0], titles[2]];
    const orderTitles = () => page.locator('[data-book-reorder-item]').evaluateAll(
      (items) => items.map((item) => item.querySelector('.notes-book-content-title')?.textContent?.trim()),
    );
    const orderIds = () => page.locator('[data-book-reorder-item]').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-book-id')),
    );
    const assertOrderPageLayout = async () => {
      await expect(page.locator('h1.app-section-title')).toHaveCount(1);
      await expect(page.locator('.notes-books-order')).toContainText(
        'Drag a Book card to move it, or focus its handle and use Arrow Up, Arrow Down, Home, or End.',
      );
      await expect(page.locator('[data-book-reorder-item]')).toHaveCount(3);
      await expect(page.locator('[data-book-reorder-handle]')).toHaveCount(3);
      const layout = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        handleWidth: element.querySelector('[data-book-reorder-handle]')?.getBoundingClientRect().width || 0,
      }));
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.handleWidth).toBeLessThanOrEqual(48);
    };

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${devServer.baseURL}/notes/books/order`, { waitUntil: 'domcontentloaded' });
    await assertOrderPageLayout();
    expect(await orderTitles()).toEqual(expectedInitialOrder);
    expect(await orderIds()).toEqual(bookIds);

    const reorderRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/notes/books/reorder') reorderRequests.push(request);
    });
    const firstRow = page.locator('[data-book-reorder-item]').first();
    const lastRow = page.locator('[data-book-reorder-item]').last();
    const lastRowBox = await lastRow.boundingBox();
    expect(lastRowBox).not.toBeNull();
    await firstRow.locator('[data-book-reorder-handle]').dragTo(lastRow, {
      targetPosition: { x: Math.min(20, lastRowBox.width - 1), y: Math.max(1, lastRowBox.height - 2) },
    });
    expect(await orderTitles()).toEqual(expectedDragOrder);
    expect(await page.locator('#notes-books-order-form input[name="orderedBookIds"]').inputValue())
      .toBe(`${bookIds[1]},${bookIds[2]},${bookIds[0]}`);
    expect(reorderRequests).toHaveLength(0);

    await Promise.all([
      page.waitForURL((url) => url.pathname === '/notes'),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect(reorderRequests).toHaveLength(1);
    await expect(page.locator('.notes-books-index .notes-book-card')).toHaveCount(3);
    await expect(page.locator('.notes-books-index .notes-book-card').nth(0)).toContainText(titles[1]);
    await expect(page.locator('.notes-books-index .notes-book-card').nth(1)).toContainText(titles[2]);
    await expect(page.locator('.notes-books-index .notes-book-card').nth(2)).toContainText(titles[0]);
    expect(await page.locator('main#main-content').textContent()).not.toContain('Move up');
    expect(await page.locator('main#main-content').textContent()).not.toContain('Move down');

    await page.goto(`${devServer.baseURL}/notes/books/order`, { waitUntil: 'domcontentloaded' });
    expect(await orderTitles()).toEqual(expectedDragOrder);
    await assertOrderPageLayout();

    await page.locator('[data-book-reorder-item]').last().locator('[data-book-reorder-handle]').focus();
    await page.keyboard.press('ArrowUp');
    expect(await orderTitles()).toEqual(expectedKeyboardOrder);
    expect(await page.locator('[data-book-reorder-live]').textContent()).toContain('moved to position 2 of 3');
    expect(reorderRequests).toHaveLength(1);

    await page.setViewportSize({ width: 375, height: 800 });
    await assertOrderPageLayout();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

    await page.locator('#books-order-dialog[open]').getByRole('button', { name: 'Close Change order', exact: true }).click();
    await expect(page.locator('#books-order-dialog')).not.toHaveAttribute('open', '');
    await expect(page).toHaveURL(`${devServer.baseURL}/notes/books/order`);
    await page.goto(`${devServer.baseURL}/notes`, { waitUntil: 'domcontentloaded' });
    expect(reorderRequests).toHaveLength(1);
    const landingRows = page.locator('.notes-books-index .notes-book-card');
    await expect(landingRows.nth(0)).toContainText(titles[1]);
    await expect(landingRows.nth(1)).toContainText(titles[2]);
    await expect(landingRows.nth(2)).toContainText(titles[0]);

    await page.goto(`${devServer.baseURL}/notes/books/order`, { waitUntil: 'domcontentloaded' });
    expect(await orderTitles()).toEqual(expectedDragOrder);
    await assertOrderPageLayout();
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('reorders Chapter Pages by drag and keyboard, saves once, and cancels unsaved changes', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    await page.setViewportSize({ width: 1280, height: 800 });
    const bookId = await createBrowserBook(page, devServer.baseURL, `Browser Chapter Order Book ${Date.now()}`);
    const chapterTitle = `Browser Chapter Order ${Date.now()}`;
    const chapterId = await createBrowserChapter(page, devServer.baseURL, bookId, chapterTitle);
    const chapterUrl = `${devServer.baseURL}/notes/chapters/${chapterId}`;

    const emptyResponse = await page.goto(chapterUrl, { waitUntil: 'domcontentloaded' });
    expect(emptyResponse?.status()).toBe(200);
     await expect(page.locator('.notes-hierarchy')).toHaveCount(0);
     await expect(page.locator('.notes-chapter-detail-content.notes-surface')).toHaveCount(1);
    const chapterEmptyState = page.locator('.notes-chapter-detail-content .empty-state');
    await expect(chapterEmptyState).toContainText('No Pages yet');
    await expect(chapterEmptyState.getByRole('link', { name: 'New Page', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toHaveCount(0);
    await expect(page.locator('main#main-content')).not.toContainText('Move up');
    await expect(page.locator('main#main-content')).not.toContainText('Move down');
    await expect(page.locator('main#main-content')).not.toContainText('Danger zone');

    const directPageTitle = `Browser Direct Order Page ${Date.now()}`;
    await createBrowserDirectPage(page, devServer.baseURL, bookId, directPageTitle);
    const pageTitles = [
      'Browser Chapter Order Page One',
      'Browser Chapter Order Page Two',
      'Browser Chapter Order Page Three with a deliberately long title for wrapping',
    ];
    const pageIds = [];
    for (const title of pageTitles) pageIds.push(await createBrowserPage(page, devServer.baseURL, chapterId, title));
    await page.goto(chapterUrl, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.page-heading-actions').getByRole('link', { name: 'New Page', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit Chapter', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toBeVisible();
    await expect(page.locator('.notes-page-nav')).toHaveAttribute('aria-label', `Pages in ${chapterTitle}`);
    await expect(page.locator('.notes-page-nav-item')).toHaveCount(3);
    await expect(page.locator('.notes-page-nav [aria-current="page"]')).toHaveCount(0);
    for (const title of pageTitles) {
      await expect(page.locator('.notes-page-nav').getByRole('link', { name: title, exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: `Edit Page: ${title}`, exact: true })).toHaveCount(0);
    }
    await expect(page.locator('.notes-page-nav')).not.toContainText(directPageTitle);
    await expect(page.locator('main#main-content')).not.toContainText('Move up');
    await expect(page.locator('main#main-content')).not.toContainText('Move down');
    await expect(page.locator('main#main-content')).not.toContainText('Danger zone');

    const orderTitles = () => page.locator('[data-chapter-page-reorder-item]').evaluateAll(
      (items) => items.map((item) => item.querySelector('.notes-chapter-page-title')?.textContent?.trim()),
    );
    const orderIds = () => page.locator('[data-chapter-page-reorder-item]').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-note-id')),
    );
    const assertOrderPageLayout = async () => {
      await expect(page.locator('h1.app-section-title')).toHaveCount(1);
      await expect(page.locator('h1.app-section-title')).toHaveText(`Notes — ${chapterTitle}`);
      await expect(page.locator('.notes-hierarchy')).toHaveCount(0);
      await expect(page.locator('.notes-chapter-order')).toContainText(
        'Drag a Page card to move it, or focus its handle and use Arrow Up, Arrow Down, Home, or End.',
      );
      await expect(page.locator('[data-chapter-page-reorder-item]')).toHaveCount(3);
      await expect(page.locator('[data-chapter-page-reorder-handle]')).toHaveCount(3);
      const layout = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        handleWidth: element.querySelector('[data-chapter-page-reorder-handle]')?.getBoundingClientRect().width || 0,
        rowRight: Math.max(...[...element.querySelectorAll('[data-chapter-page-reorder-item]')]
          .map((row) => row.getBoundingClientRect().right)),
      }));
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.rowRight).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.handleWidth).toBeLessThanOrEqual(48);
    };

    await page.getByRole('link', { name: 'Change order', exact: true }).click();
    await expect(page).toHaveURL(chapterUrl);
    await expect(page.locator('#chapter-order-dialog[open]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Change order', exact: true, level: 2 })).toBeVisible();
    await assertOrderPageLayout();
    expect(await orderTitles()).toEqual(pageTitles);
    expect(await orderIds()).toEqual(pageIds);
    await expect(page.locator('.notes-chapter-order')).not.toContainText(directPageTitle);

    const reorderRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/notes/chapters/${chapterId}/notes/reorder`) {
        reorderRequests.push(request);
      }
    });

    const firstRow = page.locator('[data-chapter-page-reorder-item]').first();
    const thirdRow = page.locator('[data-chapter-page-reorder-item]').nth(2);
    const firstRowBox = await firstRow.boundingBox();
    expect(firstRowBox).not.toBeNull();
    await thirdRow.locator('[data-chapter-page-reorder-handle]').dragTo(firstRow, {
      targetPosition: { x: Math.min(20, firstRowBox.width - 1), y: 1 },
    });
    expect(await orderTitles()).toEqual([pageTitles[2], pageTitles[0], pageTitles[1]]);
    expect(await page.locator('#notes-chapter-order-form input[name="orderedNoteIds"]').inputValue())
      .toBe(`${pageIds[2]},${pageIds[0]},${pageIds[1]}`);
    expect(reorderRequests).toHaveLength(0);

    await Promise.all([
      page.waitForURL((url) => url.pathname === `/notes/chapters/${chapterId}`),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect(reorderRequests).toHaveLength(1);
    const persistedRows = page.locator('.notes-page-nav-item');
    await expect(persistedRows.nth(0)).toContainText(pageTitles[2]);
    await expect(persistedRows.nth(1)).toContainText(pageTitles[0]);
    await expect(persistedRows.nth(2)).toContainText(pageTitles[1]);
    await expect(page.locator('.notes-page-nav')).not.toContainText(directPageTitle);
    await expect(page.locator('main#main-content')).not.toContainText('Move up');
    await expect(page.locator('main#main-content')).not.toContainText('Move down');

    await page.goto(`${devServer.baseURL}/notes/chapters/${chapterId}/notes/order`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#chapter-order-dialog[open]')).toBeVisible();
    await assertOrderPageLayout();
    expect(await orderTitles()).toEqual([pageTitles[2], pageTitles[0], pageTitles[1]]);

    const movedHandle = page.locator(`[data-chapter-page-reorder-item][data-note-id="${pageIds[0]}"]`)
      .locator('[data-chapter-page-reorder-handle]');
    await movedHandle.focus();
    await page.keyboard.press('ArrowDown');
    expect(await orderTitles()).toEqual([pageTitles[2], pageTitles[1], pageTitles[0]]);
    await expect(movedHandle).toBeFocused();
    await expect(page.locator('[data-chapter-page-reorder-live]')).toContainText('moved to position 3 of 3');
    expect(reorderRequests).toHaveLength(1);

    await page.setViewportSize({ width: 375, height: 800 });
    await assertOrderPageLayout();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

    await page.locator('#chapter-order-dialog[open]').getByRole('button', { name: 'Close Change order', exact: true }).click();
    await expect(page.locator('#chapter-order-dialog')).not.toHaveAttribute('open', '');
    await expect(page).toHaveURL(`${devServer.baseURL}/notes/chapters/${chapterId}/notes/order`);
    await page.goto(chapterUrl, { waitUntil: 'domcontentloaded' });
    expect(reorderRequests).toHaveLength(1);
    const unchangedRows = page.locator('.notes-page-nav-item');
    await expect(unchangedRows.nth(0)).toContainText(pageTitles[2]);
    await expect(unchangedRows.nth(1)).toContainText(pageTitles[0]);
    await expect(unchangedRows.nth(2)).toContainText(pageTitles[1]);
    await expect(page.locator('.notes-page-nav')).not.toContainText(directPageTitle);
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps Book detail navigation, previews, and mixed content ordering aligned', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const bookTitle = `Browser Book Detail ${Date.now()}`;
    const bookId = await createBrowserBook(page, devServer.baseURL, bookTitle);
    const bookUrl = `${devServer.baseURL}/notes/books/${bookId}`;

    const emptyResponse = await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    expect(emptyResponse?.status()).toBe(200);
    const fullSidebar = page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded)');
    await expect(page.locator('h1.app-section-title')).toContainText(bookTitle);
    await expect(page.locator('.book-outline')).toHaveCount(0);
    await expect(fullSidebar).toBeVisible();
    await expect(fullSidebar.locator('.notes-book-cover')).toBeVisible();
    await expect(fullSidebar.locator('.notes-book-nav')).toContainText('No Pages or Chapters yet');
    await expect(page.locator('.notes-page-detail-content > .notes-page-previews')).toContainText('No Pages to preview.');
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toHaveCount(0);

    const pageATitle = 'Browser Page A';
    const chapterXTitle = 'Browser Chapter X';
    const nestedPageTitles = [
      'Browser Nested Chapter Page A',
      'Browser Nested Chapter Page B',
      'Browser Nested Chapter Page C with a deliberately long title for wrapping',
    ];
    const pageBTitle = 'Browser Page B';
    const chapterYTitle = 'Browser Chapter Y';
    await createBrowserDirectPage(page, devServer.baseURL, bookId, pageATitle);
    const pageAId = new URL(page.url()).pathname.split('/').at(-1);
    const chapterXId = await createBrowserChapter(page, devServer.baseURL, bookId, chapterXTitle);
    const nestedPageIds = [];
    for (const nestedPageTitle of nestedPageTitles) {
      nestedPageIds.push(await createBrowserPage(page, devServer.baseURL, chapterXId, nestedPageTitle));
    }
    await createBrowserDirectPage(page, devServer.baseURL, bookId, pageBTitle);
    const pageBId = new URL(page.url()).pathname.split('/').at(-1);
    const chapterYId = await createBrowserChapter(page, devServer.baseURL, bookId, chapterYTitle);

    const bookNavTopLevelTitles = () => page
      .locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav-list > .notes-book-nav-item')
      .evaluateAll((items) => items.map((item) => (
        item.querySelector('.notes-book-nav-chapter-title, .notes-book-nav-page-link')?.textContent?.trim()
      )));

    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    const nav = page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav');
    const previews = page.locator('.notes-page-detail-content > .notes-page-previews');
    await expect(page.locator('.book-outline')).toHaveCount(0);
    expect(await bookNavTopLevelTitles()).toEqual([pageATitle, chapterXTitle, pageBTitle, chapterYTitle]);
    await expect(nav.locator('.notes-book-nav-list > .notes-book-nav-page')).toHaveCount(2);
    await expect(nav.locator('.notes-book-nav-list > .notes-book-nav-chapter')).toHaveCount(2);
    const chapterXDisclosure = nav.locator('.notes-book-nav-chapter').nth(0).locator('.notes-book-nav-disclosure');
    const chapterYDisclosure = nav.locator('.notes-book-nav-chapter').nth(1).locator('.notes-book-nav-disclosure');
    await expect(chapterXDisclosure.locator('.notes-book-nav-pages > li')).toHaveCount(3);
    await expect(chapterXDisclosure.locator('.notes-book-nav-pages a')).toHaveText(nestedPageTitles);
    for (const [index, id] of nestedPageIds.entries()) {
      await expect(chapterXDisclosure.locator('.notes-book-nav-pages a').nth(index)).toHaveAttribute('href', `/notes/${id}`);
    }
    await expect(nav.locator('.notes-book-nav-list > .notes-book-nav-page > a').nth(0)).toHaveAttribute('href', `/notes/${pageAId}`);
    await expect(nav.locator('.notes-book-nav-list > .notes-book-nav-page > a').nth(1)).toHaveAttribute('href', `/notes/${pageBId}`);
    await expect(chapterYDisclosure.locator('.notes-book-nav-empty')).toHaveText('No Pages yet');
    await expect(previews.locator('.notes-page-preview-item')).toHaveCount(5);
    await expect(previews.locator('.notes-page-preview-title')).toHaveText([
      pageATitle,
      ...nestedPageTitles,
      pageBTitle,
    ]);
    const previewItems = previews.locator('.notes-page-preview-item');
    await expect(previewItems.filter({ has: page.getByRole('link', { name: pageATitle, exact: true }) })
      .locator('.notes-page-preview-context')).toHaveCount(0);
    await expect(previewItems.filter({ has: page.getByRole('link', { name: pageBTitle, exact: true }) })
      .locator('.notes-page-preview-context')).toHaveCount(0);
    for (const nestedPageTitle of nestedPageTitles) {
      await expect(previewItems.filter({ has: page.getByRole('link', { name: nestedPageTitle, exact: true }) })
        .locator('.notes-page-preview-context')).toHaveText(`Chapter: ${chapterXTitle}`);
    }
    await expect(page.locator('.asset-viewer-display-controls')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit book', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Book defaults', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toBeVisible();

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 720, height: 800 },
      { width: 390, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
      const layout = await page.locator('main#main-content').evaluate((main) => {
        const sidebar = main.querySelector('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded)')
          .getBoundingClientRect();
        const previews = main.querySelector('.notes-page-previews').getBoundingClientRect();
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          sidebar: { left: sidebar.left, right: sidebar.right, top: sidebar.top, bottom: sidebar.bottom },
          previews: { left: previews.left, right: previews.right, top: previews.top, bottom: previews.bottom },
        };
      });
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.previews.right).toBeLessThanOrEqual(layout.viewportWidth);
      if (viewport.width > 767) expect(layout.previews.left).toBeGreaterThan(layout.sidebar.left);
      else expect(layout.previews.top).toBeGreaterThanOrEqual(layout.sidebar.bottom);
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    const currentChapterDisclosure = page
      .locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav-chapter')
      .nth(0)
      .locator('.notes-book-nav-disclosure');
    const currentChapterSummary = currentChapterDisclosure.locator(':scope > .notes-book-nav-summary');
    await currentChapterSummary.focus();
    await page.keyboard.press('Enter');
    const afterEnter = await currentChapterDisclosure.evaluate(element => element.open);
    await currentChapterSummary.focus();
    await page.keyboard.press('Space');
    expect(await currentChapterDisclosure.evaluate(element => element.open)).toBe(!afterEnter);
    await currentChapterSummary.click();
    if (!(await currentChapterDisclosure.evaluate(element => element.open))) await currentChapterSummary.click();
    await expect(currentChapterDisclosure.locator('.notes-book-nav-pages')).toBeVisible();

    await Promise.all([
      page.waitForURL(new RegExp(`/notes/${nestedPageIds[0]}$`)),
      currentChapterDisclosure.locator(`a[href="/notes/${nestedPageIds[0]}"]`).click(),
    ]);
    await expect(page.locator('h1.app-section-title')).toContainText(nestedPageTitles[0]);
    await expect(page.locator('.notes-page-previews')).toHaveCount(0);
    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    await Promise.all([
      page.waitForURL(new RegExp(`/notes/${pageAId}$`)),
      page.locator(`.notes-page-preview-title[href="/notes/${pageAId}"]`).click(),
    ]);
    await expect(page.locator('h1.app-section-title')).toContainText(pageATitle);
    await page.goto(`${devServer.baseURL}/notes/chapters/${chapterXId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.app-section-title')).toContainText(chapterXTitle);

    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Change order', exact: true }).click();
    const orderDialog = page.locator('#book-order-dialog[open]');
    await expect(orderDialog).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Change order', exact: true, level: 2 })).toBeVisible();
    await expect(orderDialog.locator('[data-notes-book-order-page]')).toContainText(
      'Use each Page destination and Move control to move it between the Book root and Chapters.',
    );
    await expect(page.locator('#notes-book-order-form')).toHaveAttribute('action', `/notes/books/${bookId}/hierarchy/reorder`);
    await expect(page.locator('#notes-book-order-form input[name="_csrf"]')).toHaveCount(1);
    await expect(page.locator('#notes-book-order-form input[name="hierarchy"]')).toHaveCount(1);
    await expect(page.locator('#notes-book-order-form input[name="orderedItems"]')).toHaveCount(0);
    await expect(orderDialog.locator('[data-book-content-reorder-item], [data-book-content-reorder-handle]')).toHaveCount(0);
    await expect(orderDialog.locator('[data-book-hierarchy-container="root"]')).toHaveCount(1);
    await expect(orderDialog.locator(`[data-book-hierarchy-container="chapter:${chapterXId}"]`)).toHaveCount(1);
    await expect(orderDialog.locator('[data-book-hierarchy-handle]')).toHaveCount(7);
    expect(await orderDialog.locator('[data-book-hierarchy-container="root"] > [data-book-hierarchy-item]').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-content-key')),
    )).toEqual([
      `page:${pageAId}`,
      `chapter:${chapterXId}`,
      `page:${pageBId}`,
      `chapter:${chapterYId}`,
    ]);
    await expect(orderDialog.locator(`[data-book-hierarchy-container="chapter:${chapterXId}"] > [data-book-hierarchy-item]`))
      .toHaveCount(3);
    await expect(orderDialog.getByRole('link', { name: nestedPageTitles[0], exact: true })).toBeVisible();

    const hierarchyRequests = [];
    const pageMoveRequests = [];
    const legacyReorderRequests = [];
    const chapterReorderRequests = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() !== 'POST') return;
      if (pathname === `/notes/books/${bookId}/hierarchy/reorder`) hierarchyRequests.push(request);
      if (/^\/notes\/\d+\/move$/.test(pathname)) pageMoveRequests.push(request);
      if (pathname === `/notes/books/${bookId}/contents/reorder`) legacyReorderRequests.push(request);
      if (pathname === `/notes/books/${bookId}/chapters/reorder`) chapterReorderRequests.push(request);
    });

    const pageARow = orderDialog.locator(`[data-book-hierarchy-item][data-content-key="page:${pageAId}"]`);
    await pageARow.locator('[data-book-hierarchy-destination]').selectOption(`chapter:${chapterYId}`);
    await pageARow.locator('[data-book-hierarchy-move]').click();
    const draft = JSON.parse(await page.locator('#notes-book-order-form input[name="hierarchy"]').inputValue());
    expect(draft).toEqual({
      version: 1,
      expected: [
        { type: 'page', id: Number(pageAId) },
        { type: 'chapter', id: Number(chapterXId), pages: nestedPageIds.map(Number) },
        { type: 'page', id: Number(pageBId) },
        { type: 'chapter', id: Number(chapterYId), pages: [] },
      ],
      target: [
        { type: 'chapter', id: Number(chapterXId), pages: nestedPageIds.map(Number) },
        { type: 'page', id: Number(pageBId) },
        { type: 'chapter', id: Number(chapterYId), pages: [Number(pageAId)] },
      ],
    });
    expect(hierarchyRequests).toHaveLength(0);
    expect(pageMoveRequests).toHaveLength(0);
    expect(legacyReorderRequests).toHaveLength(0);
    expect(chapterReorderRequests).toHaveLength(0);
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/notes/books/${bookId}`),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect(hierarchyRequests).toHaveLength(1);
    expect(pageMoveRequests).toHaveLength(0);
    expect(legacyReorderRequests).toHaveLength(0);
    expect(chapterReorderRequests).toHaveLength(0);
    expect(JSON.parse(new URLSearchParams(hierarchyRequests[0].postData()).get('hierarchy'))).toEqual(draft);
    expect(await bookNavTopLevelTitles()).toEqual([chapterXTitle, pageBTitle, chapterYTitle]);
    const persistedPageAPreview = page.locator('.notes-page-preview-item')
      .filter({ has: page.getByRole('link', { name: pageATitle, exact: true }) });
    await expect(persistedPageAPreview.locator('.notes-page-preview-context')).toHaveText(`Chapter: ${chapterYTitle}`);
    await expect(page.locator('.notes-page-preview-title')).toHaveText([
      ...nestedPageTitles,
      pageBTitle,
      pageATitle,
    ]);

    await page.goto(`${devServer.baseURL}/notes/books/${bookId}/order`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#book-order-dialog[open]')).toBeVisible();
    const persistedHierarchy = JSON.parse(await page.locator('#notes-book-order-form input[name="hierarchy"]').inputValue());
    expect(persistedHierarchy.expected).toEqual(draft.target);
    expect(persistedHierarchy.target).toEqual(draft.target);
    const pageBRow = page.locator(`[data-book-hierarchy-item][data-content-key="page:${pageBId}"]`);
    await pageBRow.locator('[data-book-hierarchy-destination]').selectOption(`chapter:${chapterYId}`);
    await pageBRow.locator('[data-book-hierarchy-move]').click();
    const cancelledDraft = JSON.parse(await page.locator('#notes-book-order-form input[name="hierarchy"]').inputValue());
    expect(cancelledDraft.target).toEqual([
      { type: 'chapter', id: Number(chapterXId), pages: nestedPageIds.map(Number) },
      { type: 'chapter', id: Number(chapterYId), pages: [Number(pageAId), Number(pageBId)] },
    ]);
    expect(hierarchyRequests).toHaveLength(1);
    expect(pageMoveRequests).toHaveLength(0);
    expect(legacyReorderRequests).toHaveLength(0);
    expect(chapterReorderRequests).toHaveLength(0);

    await page.setViewportSize({ width: 390, height: 800 });
    const orderLayout = await page.locator('#book-order-dialog[open]').evaluate((main) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      rowRight: Math.max(...[...main.querySelectorAll('[data-book-hierarchy-item]')]
        .map(row => row.getBoundingClientRect().right)),
    }));
    expect(orderLayout.documentWidth).toBeLessThanOrEqual(orderLayout.viewportWidth);
    expect(orderLayout.rowRight).toBeLessThanOrEqual(orderLayout.viewportWidth);
    await page.locator('#book-order-dialog[open]').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#book-order-dialog')).not.toHaveAttribute('open', '');
    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    expect(hierarchyRequests).toHaveLength(1);
    expect(pageMoveRequests).toHaveLength(0);
    expect(legacyReorderRequests).toHaveLength(0);
    expect(chapterReorderRequests).toHaveLength(0);
    expect(await bookNavTopLevelTitles()).toEqual([chapterXTitle, pageBTitle, chapterYTitle]);
    await expect(nav.locator('.notes-book-nav-list > .notes-book-nav-page > a')).toHaveText(pageBTitle);
    await expect(page.locator('.book-outline')).toHaveCount(0);
    for (const mode of ['collapsed', 'expanded']) {
      await page.getByRole('link', { name: 'Book defaults', exact: true }).click();
      const defaults = page.locator('#book-defaults-dialog[open]');
      await expect(defaults.locator('#book-preview-mode')).toHaveValue('random');
      await expect(defaults.locator('#book-preview-count')).toHaveValue('5');
      const navigation = defaults.locator('[data-dialog-field="navigation"]');
      await navigation.locator('summary').click();
      await navigation.locator(`input[type="radio"][value="${mode}"]`).check();
      await defaults.getByRole('button', { name: 'Save defaults', exact: true }).click();
      await expect(page.locator('#book-defaults-dialog')).not.toHaveAttribute('open', '');
      await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
      await expect(nav.locator('.notes-book-nav-disclosure[open]')).toHaveCount(mode === 'expanded' ? 2 : 0);
      expect(await bookNavTopLevelTitles()).toEqual([chapterXTitle, pageBTitle, chapterYTitle]);
      await expect(previews.locator('.notes-page-preview-item')).toHaveCount(5);
    }
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('browses, selects, persists, and clears Notes picker assets', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const assetRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/notes/asset-picker/assets') assetRequests.push(request.url());
    });

    const projectTitle = `Browser Asset Picker Project With A Deliberately Long Project Name For Sidebar Wrapping ${Date.now()}`;
    const projectFormResponse = await page.goto(`${devServer.baseURL}/projects/new`, { waitUntil: 'domcontentloaded' });
    expect(projectFormResponse?.status()).toBe(200);
    await page.locator('#title').fill(projectTitle);
    await Promise.all([
      page.waitForURL(/\/projects\/\d+$/),
      page.locator('button[type="submit"][form="project-form"]').click(),
    ]);
    const projectId = new URL(page.url()).pathname.split('/').at(-1);
    await createAndScanBrowserPickerAssets(page, devServer.baseURL, devServer.projectsRoot, projectId);

    const chapterId = await createBrowserNotesHierarchy(page, devServer.baseURL);
    await page.goto(`${devServer.baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });

    const connections = page.locator('#note-create-dialog[open] [data-note-connections]');
    const projects = connections.locator('#note-projects-form');
    await expect(projects).toBeVisible();
    await projects.locator('summary').click();
    await projects.locator('input[type="search"]').fill('Browser Asset Picker');
    const projectOption = projects.getByRole('checkbox', { name: projectTitle, exact: true });
    await projectOption.check();
    await expect(projectOption).toBeChecked();
    await projects.locator('summary').click();
    await expect.poll(() => assetRequests.length).toBeGreaterThan(0);
    const firstAssetRequest = new URL(assetRequests[0]);
    expect(firstAssetRequest.searchParams.get('projectId')).toBe(projectId);
    expect(firstAssetRequest.searchParams.get('limit')).toBe('25');
    expect(firstAssetRequest.searchParams.has('cursor')).toBe(false);

    const assets = connections.locator('#note-assets-form');
    await expect(assets).toBeVisible();
    await assets.locator('summary').click();
    const assetSearch = assets.locator('input[type="search"]');
    await assetSearch.fill('path-needle');
    await expect(assets.getByRole('checkbox', { name: /path-target\.txt.*nested\/path-needle/ })).toBeVisible();
    await assetSearch.fill('');
    const firstFilename = 'asset-00.txt';
    const longAssetFilename = 'asset-01-this-is-a-deliberately-long-asset-filename-for-sidebar-wrapping-verification.txt';
    const firstCandidate = assets.getByRole('checkbox', { name: new RegExp(`^${firstFilename}`) });
    const secondCandidate = assets.getByRole('checkbox', { name: new RegExp(`^${longAssetFilename}`) });
    await firstCandidate.check();
    await secondCandidate.check();
    await expect(firstCandidate).toBeChecked();
    await expect(secondCandidate).toBeChecked();
    const secondAssetId = await secondCandidate.getAttribute('value');
    await firstCandidate.uncheck();
    await expect(firstCandidate).not.toBeChecked();
    await expect(secondCandidate).toBeChecked();
    const selectedAssetOption = page.locator(`#note-assets-native option[value="${secondAssetId}"]`);
    await expect(selectedAssetOption).toHaveJSProperty('selected', true);
    await assets.locator('summary').click();

    await page.setViewportSize({ width: 375, height: 800 });
    const narrowConnections = await page.locator('.notes-connections').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        cardRight: rect.right,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(narrowConnections.cardRight).toBeLessThanOrEqual(narrowConnections.viewportWidth);
    expect(narrowConnections.documentWidth).toBeLessThanOrEqual(narrowConnections.viewportWidth);
    await expect(assets).toContainText(longAssetFilename);
    await expect(projects.locator('input[type="search"]')).toBeAttached();
    await expect(assetSearch).toBeAttached();
    await expect(selectedAssetOption).toHaveJSProperty('selected', true);

    await page.locator('#note-form [name="title"]').fill('Browser Picker Note');
    await Promise.all([
      page.waitForURL(/\/notes\/\d+$/),
      page.locator('button[type="submit"][form="note-form"]').click(),
    ]);
    const noteId = new URL(page.url()).pathname.split('/').at(-1);
    await expect(page.locator('.notes-detail-assets')).toContainText(longAssetFilename);
    await expect(page.locator('.notes-detail-assets')).not.toContainText(firstFilename);

    await page.getByRole('link', { name: 'Edit Page', exact: true }).click();
    await expect(page.locator('#note-edit-dialog[open]')).toBeVisible();
    await expect(page.locator('#note-projects-form-trigger'))
      .toHaveAttribute('aria-label', `Projects: ${projectTitle}`);
    await expect(page.locator('#note-projects-form-trigger')).toContainText(projectTitle);
    await expect(page.locator(`#note-edit-dialog[open] #note-assets-native option[value="${secondAssetId}"]`))
      .toHaveJSProperty('selected', true);

    const editAssets = page.locator('#note-edit-dialog[open] #note-assets-form');
    await editAssets.locator('summary').click();
    const editCandidate = editAssets.getByRole('checkbox', { name: new RegExp(`^${longAssetFilename}`) });
    await expect(editCandidate).toBeChecked();
    await editCandidate.uncheck();
    await expect(editCandidate).not.toBeChecked();

    await Promise.all([
      page.waitForURL(new RegExp(`/notes/${noteId}$`)),
      page.locator('button[type="submit"][form="note-form"]').click(),
    ]);
    await expect(page.locator('.notes-detail-assets')).toHaveCount(0);
    expect(diagnostics.failedRequests.filter(({ url }) => new URL(url).pathname.startsWith('/notes/asset-picker/'))).toEqual([]);
    expect(diagnostics.failedResponses.filter(({ url }) => new URL(url).pathname.startsWith('/notes/asset-picker/'))).toEqual([]);
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('applies a real CSS HMR update without a full navigation', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const navigationCount = trackMainFrameNavigations(page);
    await installLoadCounter(page);

    await page.goto(`${devServer.baseURL}/projects`, { waitUntil: 'domcontentloaded' });
    await waitForViteWebSocket(diagnostics);
    const initialLoadCount = await readLoadCount(page);
    const initialNavigationCount = navigationCount();
    const originalCss = await fs.readFile(CSS_SOURCE_PATH);
    const probeCss = Buffer.concat([
      originalCss,
      Buffer.from('\n/* temporary CreatorCrate browser smoke CSS HMR probe */\nbody { background-color: rgb(13, 15, 20) !important; }\n'),
    ]);

    try {
      await fs.writeFile(CSS_SOURCE_PATH, probeCss);

      await expect.poll(
        () => readBodyBackground(page),
        { timeout: 30_000 },
      ).toBe('rgb(13, 15, 20)');
      await expect.poll(
        () => hasReceivedHmrMessage(diagnostics, 'update'),
        { timeout: 15_000 },
      ).toBe(true);

      expect(await readLoadCount(page)).toBe(initialLoadCount);
      expect(navigationCount()).toBe(initialNavigationCount);
      expect(diagnostics.webSockets.some((socket) => !socket.closed)).toBe(true);
      assertNoBrowserDiagnostics(diagnostics);
    } finally {
      await fs.writeFile(CSS_SOURCE_PATH, originalCss);
    }

    await expect.poll(
      () => readBodyBackground(page),
      { timeout: 15_000 },
    ).toBe('rgb(13, 15, 19)');
    expect(await fs.readFile(CSS_SOURCE_PATH)).toEqual(originalCss);
  });

  test('performs a healthy full-page reload when creatorcrate.js changes', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const navigationCount = trackMainFrameNavigations(page);
    await installLoadCounter(page);

    await page.goto(`${devServer.baseURL}/projects`, { waitUntil: 'domcontentloaded' });
    await waitForViteWebSocket(diagnostics);
    const initialLoadCount = await readLoadCount(page);
    const initialNavigationCount = navigationCount();
    const originalJs = await fs.readFile(JS_SOURCE_PATH);
    const probeJs = Buffer.concat([
      originalJs,
      Buffer.from('\n// temporary CreatorCrate browser smoke full-reload probe\n'),
    ]);

    try {
      await fs.writeFile(JS_SOURCE_PATH, probeJs);

      await expect.poll(
        () => readLoadCount(page),
        { timeout: 30_000 },
      ).toBeGreaterThan(initialLoadCount);
      await expect.poll(
        () => navigationCount(),
        { timeout: 15_000 },
      ).toBeGreaterThan(initialNavigationCount);
      await expect(page.locator('h1')).toHaveText('Projects');
      await expect.poll(() => readBodyBackground(page)).toBe('rgb(13, 15, 19)');

      // Re-run the existing searchable Project interaction after the reload. This
      // catches a broken document re-entry or duplicate initialization without
      // adding a test-only application marker.
      await exerciseSearchableProjectDropdown(page);
      expect(hasReceivedHmrMessage(diagnostics, 'full-reload')).toBe(true);
      assertNoBrowserDiagnostics(diagnostics);
    } finally {
      await fs.writeFile(JS_SOURCE_PATH, originalJs);
    }

    expect(await fs.readFile(JS_SOURCE_PATH)).toEqual(originalJs);
  });

  test('navigates server-rendered pages and submits the non-mutating project filter form', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);

    for (const pathname of ['/', '/projects', '/notes', '/settings']) {
      const response = await page.goto(`${devServer.baseURL}${pathname}`, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), pathname).toBe(200);
      await expect(page.locator('main#main-content'), pathname).toBeVisible();
    }

    await page.goto(`${devServer.baseURL}/projects`, { waitUntil: 'domcontentloaded' });
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      submitProjectSortFilter(page),
    ]);

    expect(response?.status()).toBe(200);
    const submittedUrl = new URL(page.url());
    expect(submittedUrl.pathname).toBe('/projects');
    expect(submittedUrl.searchParams.get('sort')).toBe('title');
    await expect(page.locator('h1')).toHaveText('Projects');
    await expect.poll(() => readBodyBackground(page)).toBe('rgb(13, 15, 19)');
    assertNoBrowserDiagnostics(diagnostics);
  });
});

test.describe('CreatorCrate production browser smoke', () => {
  test('loads hashed production assets, executes browser code, and has no Vite client or HMR socket', async ({ page, productionServer }) => {
    const diagnostics = observeBrowser(page, productionServer.baseURL);

    await page.goto(`${productionServer.baseURL}/projects`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('main#main-content')).toBeVisible();
    const editorAssetPaths = await readProductionEditorAssetPaths();

    const html = await page.content();
    expect(html).not.toContain('/@vite/client');
    expect(html).not.toContain('/creatorcrate.js');
    expect(html).not.toContain('/creatorcrate.css');

    const cssPaths = await page.locator('link[rel="stylesheet"][href^="/vite/"]').evaluateAll((links) => (
      links.map((link) => new URL(link.href).pathname)
    ));
    const javascriptPaths = await page.locator('script[type="module"][src^="/vite/"]').evaluateAll((scripts) => (
      scripts.map((script) => new URL(script.src).pathname)
    ));

    expect(cssPaths.length).toBeGreaterThan(0);
    expect(javascriptPaths.length).toBe(1);
    expect(cssPaths.every((resourcePath) => resourcePath.startsWith('/vite/'))).toBe(true);
    expect(javascriptPaths[0].startsWith('/vite/')).toBe(true);

    for (const resourcePath of [...cssPaths, ...javascriptPaths]) {
      await expect.poll(
        () => diagnostics.successfulResponsePaths.has(resourcePath),
      ).toBe(true);
    }

    await expect.poll(() => readBodyBackground(page)).toBe('rgb(13, 15, 19)');
    await exerciseSearchableProjectDropdown(page);
    expect(getRequestedPaths(diagnostics).filter((resourcePath) => editorAssetPaths.has(resourcePath))).toEqual([]);
    assertNoToastUiRequests(diagnostics);

    await exerciseServerNavigation(page, productionServer.baseURL);
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      submitProjectSortFilter(page),
    ]);
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).searchParams.get('sort')).toBe('title');
    await expect(page.locator('h1')).toHaveText('Projects');
    await expect.poll(() => readBodyBackground(page)).toBe('rgb(13, 15, 19)');

    await expectNoWebSocket(page, diagnostics);
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('mounts the real Notes editor and saves through production dynamic chunks', async ({ page, productionServer }) => {
    const diagnostics = observeBrowser(page, productionServer.baseURL);
    const editorAssetPaths = await readProductionEditorAssetPaths();

    await page.setViewportSize({ width: 1280, height: 800 });
    const chapterId = await createBrowserNotesHierarchy(page, productionServer.baseURL);
    await page.goto(`${productionServer.baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });
    await exerciseNotesEditor(page);

    await expect.poll(
      () => [...editorAssetPaths].every((resourcePath) => diagnostics.successfulResponsePaths.has(resourcePath)),
    ).toBe(true);
    expect(getRequestedPaths(diagnostics).filter((resourcePath) => resourcePath.includes('/vendor/toast-ui/editor'))).toEqual([]);
    expect(getLegacyToastUiRequests(diagnostics)).toEqual([]);
    assertNoBrowserDiagnostics(diagnostics);
  });
});

async function buildProductionAssets() {
  const buildCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm';
  const buildArguments = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm build'] : ['build'];
  await execFileAsync(buildCommand, buildArguments, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function readProductionEditorAssetPaths() {
  const manifestPath = path.join(PROJECT_ROOT, 'dist', 'client', '.vite', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const entry = manifest['client/main.js'];
  const dynamicEditorKey = entry.dynamicImports.find((key) => manifest[key]?.isDynamicEntry === true);
  const dynamicEditor = manifest[dynamicEditorKey];
  const editorStyles = Object.values(manifest).filter(
    (record) => record.src?.includes('@toast-ui/editor/dist/') && record.file?.endsWith('.css'),
  );

  expect(dynamicEditorKey).toBeDefined();
  expect(dynamicEditor).toBeDefined();
  return new Set([
    `/vite/${dynamicEditor.file}`,
    ...editorStyles.map((record) => `/vite/${record.file}`),
  ]);
}

async function startCreatorCrateServer({ nodeEnv }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'creatorcrate-browser-smoke-'));
  const appDataRoot = path.join(tempRoot, 'app');
  const projectsRoot = path.join(tempRoot, 'projects');
  const databasePath = path.join(appDataRoot, 'creatorcrate.db');
  await fs.mkdir(appDataRoot, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });

  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      PORT: String(port),
      APP_NAME: 'CreatorCrate Browser Smoke',
      APP_DATA_ROOT: appDataRoot,
      PROJECTS_ROOT: projectsRoot,
      DATABASE_PATH: databasePath,
      AUTO_SCAN_INTERVAL_MINUTES: '',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'false',
      HSTS_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-16_000);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_000);
  });

  try {
    await waitForHealth(child, baseURL);
  } catch (error) {
    await stopProcess(child);
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw new Error(
      `CreatorCrate ${nodeEnv} server did not become ready: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause: error },
    );
  }

  let stopped = false;
  return {
    baseURL,
    projectsRoot,
    tempRoot,
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopProcess(child);
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}

async function waitForHealth(child, baseURL) {
  const deadline = Date.now() + DEFAULT_SERVER_START_TIMEOUT_MS;
  let lastFailure = 'no response';

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`process exited before readiness (code=${child.exitCode}, signal=${child.signalCode})`);
    }

    try {
      const response = await fetch(`${baseURL}/health`);
      const body = await response.text();
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}: ${body}`;
    } catch (error) {
      lastFailure = error.message;
    }

    await delay(100);
  }

  throw new Error(`timed out waiting for ${baseURL}/health (${lastFailure})`);
}

async function findFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  try {
    child.kill('SIGTERM');
  } catch {
    // The process may have exited between the state check and kill().
  }

  if (await waitForExit(child, SERVER_STOP_TIMEOUT_MS)) return;

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
      });
    } catch {
      // A concurrently exiting process is already clean enough to ignore.
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // A concurrently exiting process is already clean enough to ignore.
    }
  }

  if (!await waitForExit(child, SERVER_STOP_TIMEOUT_MS)) {
    throw new Error(`Could not terminate CreatorCrate server process ${child.pid}.`);
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);

    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

function observeBrowser(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const diagnostics = {
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    failedResponses: [],
    requestedUrls: new Set(),
    successfulResponsePaths: new Set(),
    webSockets: [],
  };

  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.stack || error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    if (!isFrontendResource(request, origin)) return;
    diagnostics.failedRequests.push({
      url: request.url(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText || 'unknown request failure',
    });
  });
  page.on('request', (request) => {
    if (isFrontendResource(request, origin)) diagnostics.requestedUrls.add(request.url());
  });
  page.on('response', (response) => {
    const request = response.request();
    if (!isFrontendResource(request, origin)) return;
    const resourcePath = new URL(response.url()).pathname;
    if (response.status() >= 200 && response.status() < 400) diagnostics.successfulResponsePaths.add(resourcePath);
    else diagnostics.failedResponses.push({
      url: response.url(),
      status: response.status(),
      resourceType: request.resourceType(),
    });
  });
  page.on('websocket', (webSocket) => {
    const socket = {
      url: webSocket.url(),
      frames: [],
      closed: false,
    };
    diagnostics.webSockets.push(socket);
    webSocket.on('framereceived', (event) => socket.frames.push(normalizeWebSocketPayload(event)));
    webSocket.on('framesent', (event) => socket.frames.push(normalizeWebSocketPayload(event)));
    webSocket.on('close', () => { socket.closed = true; });
  });

  return diagnostics;
}

function normalizeWebSocketPayload(event) {
  if (typeof event === 'string') return event;
  if (typeof event?.payload === 'string') return event.payload;
  return JSON.stringify(event);
}

function isFrontendResource(request, origin) {
  if (!FRONTEND_RESOURCE_TYPES.has(request.resourceType())) return false;
  try {
    return new URL(request.url()).origin === origin;
  } catch {
    return false;
  }
}

function assertNoBrowserDiagnostics(diagnostics) {
  expect(diagnostics.pageErrors, 'unexpected pageerror events').toEqual([]);
  expect(diagnostics.consoleErrors, 'unexpected console.error events').toEqual([]);
  expect(diagnostics.failedRequests, 'failed frontend requests').toEqual([]);
  expect(diagnostics.failedResponses, 'non-success frontend responses').toEqual([]);
}

function getToastUiRequests(diagnostics) {
  return [...diagnostics.requestedUrls].filter((url) => (
    url.includes('@toast-ui') || url.includes('toastui-editor')
  ));
}

function getLegacyToastUiRequests(diagnostics) {
  return [...diagnostics.requestedUrls].filter((url) => url.includes('/vendor/toast-ui/editor'));
}

function assertNoToastUiRequests(diagnostics) {
  expect(getToastUiRequests(diagnostics)).toEqual([]);
}

function getRequestedPaths(diagnostics) {
  return [...diagnostics.requestedUrls].map((url) => new URL(url).pathname);
}

async function waitForViteWebSocket(diagnostics) {
  await expect.poll(
    () => diagnostics.webSockets.length,
    { timeout: 15_000 },
  ).toBeGreaterThan(0);
  await expect.poll(
    () => diagnostics.webSockets.some((socket) => socket.frames.some((payload) => payload.includes('"type":"connected"'))),
    { timeout: 15_000 },
  ).toBe(true);
  expect(diagnostics.webSockets.every((socket) => socket.url.startsWith('ws'))).toBe(true);
}

function hasReceivedHmrMessage(diagnostics, type) {
  return diagnostics.webSockets.some((socket) => socket.frames.some((payload) => (
    payload.includes(`"type":"${type}"`)
  )));
}

async function expectNoWebSocket(page, diagnostics) {
  const lateSocket = page.waitForEvent('websocket', { timeout: 1_000 })
    .then((webSocket) => webSocket.url())
    .catch(() => null);
  expect(await lateSocket).toBeNull();
  expect(diagnostics.webSockets).toEqual([]);
}

function trackMainFrameNavigations(page) {
  let count = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) count += 1;
  });
  return () => count;
}

async function installLoadCounter(page) {
  await page.addInitScript((key) => {
    try {
      const next = Number(window.sessionStorage.getItem(key) || '0') + 1;
      window.sessionStorage.setItem(key, String(next));
    } catch {
      // The assertion below will fail if the browser cannot expose storage.
    }
  }, LOAD_COUNTER_KEY);
}

async function readLoadCount(page) {
  return page.evaluate((key) => Number(window.sessionStorage.getItem(key) || '0'), LOAD_COUNTER_KEY);
}

async function readBodyBackground(page) {
  return page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);
}

async function createBrowserProject(page, baseURL, title) {
  const response = await page.goto(`${baseURL}/projects/new`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('#title').fill(title);
  await Promise.all([
    page.waitForURL(/\/projects\/\d+$/),
    page.locator('button[type="submit"][form="project-form"]').click(),
  ]);
  return new URL(page.url()).pathname.split('/').at(-1);
}

async function createBrowserTag(page, baseURL, name) {
  const response = await page.goto(`${baseURL}/settings/tags`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('#tag-name').fill(name);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/settings/tags'),
    page.getByRole('button', { name: 'Create Tag', exact: true }).click(),
  ]);
}

async function exerciseSearchableProjectDropdown(page) {
  const filter = page.locator('#project-project-filter');
  await expect(filter).toHaveCount(1);
  await expect(filter.locator('label[for="project-project-filter-search"]')).not.toHaveClass(/(?:^|\s)sr-only(?:\s|$)/);
  const summary = filter.locator('summary');
  await summary.focus();
  await summary.press('Enter');
  await expect(filter.locator('input[data-cc-dropdown-search]')).toHaveAccessibleName('Search projects');
  await filter.locator('input[data-cc-dropdown-search]').fill('creatorcrate-browser-smoke-no-match');
  await expect(filter.locator('[data-cc-dropdown-no-results]')).toBeVisible();
  await expect(filter.locator('summary')).toHaveAttribute('aria-expanded', 'true');
}

async function exerciseServerNavigation(page, baseURL) {
  for (const pathname of ['/', '/projects', '/notes', '/settings']) {
    const response = await page.goto(`${baseURL}${pathname}`, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), pathname).toBe(200);
    await expect(page.locator('main#main-content'), pathname).toBeVisible();
  }
  await page.goto(`${baseURL}/projects`, { waitUntil: 'domcontentloaded' });
}

async function submitProjectSortFilter(page) {
  await page.locator('#project-sort-filter-trigger').click();
  await page.locator('#project-sort-filter-options input[name="sort"][value="title"]').check();
  return page.locator('button[type="submit"][form="project-filters"]').click();
}

async function createAndScanBrowserPickerAssets(page, baseURL, projectsRoot, projectId) {
  const projectDirectories = await fs.readdir(projectsRoot, { withFileTypes: true });
  const projectDirectory = projectDirectories.find((entry) => entry.isDirectory());
  expect(projectDirectory).toBeDefined();
  const projectPath = path.join(projectsRoot, projectDirectory.name);
  const assetFiles = Array.from({ length: 25 }, (_value, index) => (
    `browse/asset-${String(index).padStart(2, '0')}.txt`
  ));
  assetFiles[1] = 'browse/asset-01-this-is-a-deliberately-long-asset-filename-for-sidebar-wrapping-verification.txt';
  assetFiles.push('nested/path-needle/path-target.txt');

  await Promise.all(assetFiles.map(async (relativePath) => {
    const filePath = path.join(projectPath, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `browser picker fixture: ${relativePath}`, 'utf8');
  }));

  const assetsResponse = await page.goto(`${baseURL}/projects/${projectId}/assets`, { waitUntil: 'domcontentloaded' });
  expect(assetsResponse?.status()).toBe(200);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === `/projects/${projectId}/assets`),
    page.getByRole('button', { name: 'Scan Now' }).click(),
  ]);
}

async function createBrowserNotesHierarchy(page, baseURL) {
  const bookId = await createBrowserBook(page, baseURL, `Browser Notes Book ${Date.now()}`);
  return createBrowserChapter(page, baseURL, bookId, `Browser Notes Chapter ${Date.now()}`);
}

async function createBrowserBook(page, baseURL, title) {
  const response = await page.goto(`${baseURL}/notes/books/new`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('#title').fill(title);
  await Promise.all([
    page.waitForURL(/\/notes\/books\/\d+$/),
    page.locator('#book-create-dialog[open] button[type="submit"]').click(),
  ]);
  return new URL(page.url()).pathname.split('/').at(-1);
}

async function createBrowserChapter(page, baseURL, bookId, title) {
  const response = await page.goto(`${baseURL}/notes/books/${bookId}/chapters/new`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('#chapter-create-dialog[open] [name="title"]').fill(title);
  await Promise.all([
    page.waitForURL(/\/notes\/chapters\/\d+$/),
    page.locator('#chapter-create-dialog[open] button[type="submit"]').click(),
  ]);
  return new URL(page.url()).pathname.split('/').at(-1);
}

async function createBrowserPage(page, baseURL, chapterId, title) {
  const response = await page.goto(`${baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('#note-create-dialog[open] [name="title"]').fill(title);
  await Promise.all([
    page.waitForURL(/\/notes\/\d+$/),
    page.locator('button[type="submit"][form="note-form"]').click(),
  ]);
  return new URL(page.url()).pathname.split('/').at(-1);
}

async function createBrowserDirectPage(page, baseURL, bookId, title) {
  const response = await page.goto(`${baseURL}/notes/new?bookId=${bookId}`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('#note-create-dialog[open] [name="title"]').fill(title);
  await Promise.all([
    page.waitForURL(/\/notes\/\d+$/),
    page.locator('button[type="submit"][form="note-form"]').click(),
  ]);
}

async function expandPageDialogBookContents(page) {
  const disclosure = page.locator('details.notes-book-contents-disclosure');
  const summary = disclosure.locator(':scope > summary');
  const navigator = disclosure.locator('.notes-book-detail-sidebar--embedded .notes-book-nav');
  await expect(disclosure).toHaveCount(1);
  await expect(disclosure).not.toHaveAttribute('open', '');
  await expect(summary.getByText('Expand', { exact: true })).toBeVisible();
  await expect(navigator).toBeHidden();
  await summary.click();
  await expect(disclosure).toHaveAttribute('open', '');
  await expect(summary.getByText('Collapse', { exact: true })).toBeVisible();
  await expect(navigator).toBeVisible();
}

async function exerciseNotesEditor(page) {
  const editor = page.locator('[data-notes-editor-host] .toastui-editor-defaultUI');
  await expect(editor).toBeVisible();
  await expect(page.locator('#content')).toBeHidden();
  await expandPageDialogBookContents(page);

  const workspace = page.locator('.notes-workspace');
  await expect(workspace).toBeVisible();
  await expect(page.locator('.notes-workspace-context')).toHaveAttribute('aria-label', 'Book contents');
  await expect(page.locator('.notes-workspace-context .notes-book-nav')).toHaveCount(1);
  await expect(page.locator('.notes-workspace-context')).not.toContainText('Hierarchy');
  await expect(page.locator('.notes-workspace-context')).not.toContainText('Back to Chapter');
  await expect(page.locator('.notes-workspace-context')).not.toContainText('Back to Book');
  await expect(page.locator('.notes-workspace-context')).not.toContainText('This Page will belong');
  await expect(page.locator('.notes-connections')).toContainText('Projects');
  await expect(page.locator('.notes-connections')).toContainText('Assets');
  await assertWorkspaceDimensions(page, { editorRequired: true });
  await page.setViewportSize({ width: 640, height: 800 });
  await assertWorkspaceDimensions(page, { editorRequired: true });
  await page.setViewportSize({ width: 1280, height: 800 });

  const modeSwitch = editor.locator('.toastui-editor-mode-switch');
  await expect(modeSwitch).toContainText('WYSIWYG');
  await expect(modeSwitch).toContainText('Markdown');
  await expect(modeSwitch.locator('.tab-item.active')).toContainText('WYSIWYG');

  const cssState = await editor.evaluate((element) => {
    const toolbar = element.querySelector('.toastui-editor-defaultUI-toolbar');
    return {
      editorBoxSizing: getComputedStyle(element).boxSizing,
      toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : 'missing',
    };
  });
  expect(cssState.editorBoxSizing).toBe('border-box');
  expect(cssState.toolbarDisplay).toBe('flex');

  const imageControls = await editor.locator('.toastui-editor-defaultUI-toolbar button').evaluateAll((buttons) => (
    buttons
      .filter((button) => /\bimage\b|\bupload\b/i.test([
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('data-tooltip-content'),
        button.className,
      ].filter(Boolean).join(' ')))
      .map((button) => button.outerHTML)
  ));
  expect(imageControls).toEqual([]);

  await page.locator('#note-form [name="title"]').fill('Browser Notes Round Trip');
  const wysiwygSurface = editor.locator('.toastui-editor-ww-container .toastui-editor-contents[contenteditable="true"]');
  await expect(wysiwygSurface).toBeVisible();
  await replaceNotesEditorText(page, wysiwygSurface, [
    'WYSIWYG-authored paragraph',
    ...Array.from({ length: 30 }, (_value, index) => `Long content paragraph ${index + 1}`),
  ]);
  const longContentState = await wysiwygSurface.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(longContentState.scrollHeight).toBeGreaterThan(longContentState.clientHeight);
  expect(longContentState.overflowY).toMatch(/auto|scroll/);

  await selectNotesEditorMode(modeSwitch, 'Markdown');
  const markdownSurface = editor.locator('.toastui-editor-md-container .ProseMirror[contenteditable="true"]');
  await expect(markdownSurface).toBeVisible();
  await expect(markdownSurface).toContainText('WYSIWYG-authored paragraph');
  await replaceNotesEditorText(page, markdownSurface, ['WYSIWYG-authored paragraph', '**Bold text**']);

  await selectNotesEditorMode(modeSwitch, 'WYSIWYG');
  await expect(wysiwygSurface).toContainText('WYSIWYG-authored paragraph');
  await expect(wysiwygSurface).toContainText('Bold text');
  await selectNotesEditorMode(modeSwitch, 'Markdown');
  await expect(markdownSurface).toContainText('**Bold text**');

  const noteSubmissions = [];
  const recordNoteSubmission = (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.startsWith('/notes/')) {
      noteSubmissions.push(request.postData() || '');
    } else if (request.method() === 'POST' && url.pathname === '/notes') {
      noteSubmissions.push(request.postData() || '');
    }
  };
  page.on('request', recordNoteSubmission);

  try {
    await Promise.all([
      page.waitForURL(/\/notes\/\d+$/),
      page.locator('button[type="submit"][form="note-form"]').click(),
    ]);

    const initialSubmission = new URLSearchParams(noteSubmissions.at(-1));
    expect(initialSubmission.get('content')).toContain('**Bold text**');
    await expect(page.locator('.notes-content')).toContainText('Bold text');
    await expect(page.locator('.notes-content strong')).toHaveText('Bold text');

    await expect(page.getByRole('link', { name: 'Edit Page', exact: true })).toBeVisible();
    await expect(page.locator('.notes-hierarchy')).toHaveCount(0);
    await expect(page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav')).toHaveCount(1);
    await expect(page.locator('.notes-page-sidebar')).toContainText('Details');
    await expect(page.locator('.notes-detail-details')).toContainText('Created');
    await expect(page.locator('.notes-detail-details')).toContainText('Updated');
     await expect(page.locator('.notes-detail-kicker')).toHaveText('Browser Notes Round Trip');
     await expect(page.locator('.notes-detail-content')).not.toContainText('Reading view');
     await expect(page.locator('.notes-detail-content > .notes-detail-section-heading > h2')).toHaveCount(0);
    await expect(page.locator('.notes-detail-layout')).toHaveCount(0);
    await expect(page.locator('.notes-detail-reading')).toHaveCount(0);
    await expect(page.locator('.notes-detail-sidebar')).toHaveCount(0);
    await expect(page.locator('main#main-content')).not.toContainText('Move Page');
    await expect(page.locator('main#main-content')).not.toContainText('Danger zone');

    const desktopDetailState = await page.locator('.notes-page-detail-layout').evaluate((element) => {
      const content = element.querySelector('.notes-page-detail-content')?.getBoundingClientRect();
      const sidebar = element.querySelector('.notes-page-sidebar')?.getBoundingClientRect();
      return {
        display: getComputedStyle(element).display,
        columns: getComputedStyle(element).gridTemplateColumns,
        contentWidth: content?.width || 0,
        sidebarWidth: sidebar?.width || 0,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(desktopDetailState.display).toBe('grid');
    expect(desktopDetailState.columns.split(' ').length).toBe(2);
    expect(desktopDetailState.contentWidth).toBeGreaterThan(desktopDetailState.sidebarWidth * 2);
    expect(desktopDetailState.documentWidth).toBeLessThanOrEqual(desktopDetailState.viewportWidth);

    await page.setViewportSize({ width: 640, height: 800 });
    const narrowDetailState = await page.locator('.notes-page-detail-layout').evaluate((element) => {
      const navigator = element.querySelector('.notes-page-detail-sidebar')?.getBoundingClientRect();
      const content = element.querySelector('.notes-page-detail-content')?.getBoundingClientRect();
      const details = element.querySelector('.notes-detail-details')?.getBoundingClientRect();
      return {
        columns: getComputedStyle(element).gridTemplateColumns,
        navigatorTop: navigator?.top || 0,
        contentTop: content?.top || 0,
        contentBottom: content?.bottom || 0,
        detailsTop: details?.top || 0,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(narrowDetailState.columns.split(' ').length).toBe(1);
    expect(narrowDetailState.navigatorTop).toBeLessThan(narrowDetailState.contentTop);
    expect(narrowDetailState.contentTop).toBeLessThan(narrowDetailState.detailsTop);
    expect(narrowDetailState.detailsTop).toBeGreaterThanOrEqual(narrowDetailState.contentBottom);
    expect(narrowDetailState.documentWidth).toBeLessThanOrEqual(narrowDetailState.viewportWidth);
    await page.setViewportSize({ width: 1280, height: 800 });

    const detailPath = new URL(page.url()).pathname;
    await page.goto(`${page.url()}/edit`, { waitUntil: 'domcontentloaded' });
    await expect(editor).toBeVisible();
    await expandPageDialogBookContents(page);
    await expect(page.locator('.notes-workspace-context')).toHaveAttribute('aria-label', 'Book contents');
    await expect(page.locator('.notes-workspace-context .notes-book-nav')).toHaveCount(1);
    await expect(page.locator('.notes-workspace-context')).not.toContainText('Back to Chapter');
    await expect(page.locator('.notes-workspace-context')).not.toContainText('Back to Book');
    await expect(page.locator('.notes-connections')).toContainText('Connections');
    await selectNotesEditorMode(modeSwitch, 'Markdown');
    await expect(markdownSurface).toContainText('**Bold text**');

    await selectNotesEditorMode(modeSwitch, 'WYSIWYG');
    await replaceNotesEditorText(page, wysiwygSurface, ['Edited WYSIWYG paragraph']);
    await selectNotesEditorMode(modeSwitch, 'Markdown');
    await replaceNotesEditorText(page, markdownSurface, ['Edited WYSIWYG paragraph', '**Edited bold**']);
    await expect(markdownSurface).toContainText('**Edited bold**');

    await Promise.all([
      page.waitForURL(new RegExp(`${detailPath.replaceAll('/', '\\/')}$`)),
      page.locator('button[type="submit"][form="note-form"]').click(),
    ]);

    const editedSubmission = new URLSearchParams(noteSubmissions.at(-1));
    expect(editedSubmission.get('content')).toContain('**Edited bold**');
    await expect(page.locator('.notes-content')).toContainText('Edited bold');
    await expect(page.locator('.notes-content strong')).toHaveText('Edited bold');
  } finally {
    page.off('request', recordNoteSubmission);
  }
}

async function assertPageEditWorkspace(page, {
  bookTitle,
  pageTitle,
  cancelHref,
}) {
  await expect(page.locator('h1.app-section-title')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  const dialog = page.locator('#note-edit-dialog');
  const editUrl = page.url();
  await page.locator('#note-form [name="title"]').fill('Unsaved dismissal change');
  await dialog.locator('[data-dialog-close]').click();
  await expect(dialog).not.toBeVisible();
  await page.goto(new URL(cancelHref, editUrl).href, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1.app-section-title')).toContainText(pageTitle);
  await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#note-form [name="title"]')).toHaveValue(pageTitle);
  await expandPageDialogBookContents(page);
  const context = page.locator('.notes-workspace-context');
  const navigator = context.locator('.notes-book-nav');
  await expect(context).toHaveAttribute('aria-label', 'Book contents');
  await expect(navigator).toHaveCount(1);
  await expect(navigator).toHaveAttribute('aria-label', new RegExp(`^Contents of ${bookTitle}`));
  await expect(navigator.locator('.notes-book-nav-book-link')).toContainText(bookTitle);
  await expect(context).not.toContainText('Book workspace');
  await expect(context).not.toContainText('Hierarchy');
  await expect(context).not.toContainText('Back to Chapter');
  await expect(context).not.toContainText('Back to Book');
  await expect(context).not.toContainText('This Page will belong');
  await expect(context.locator('.notes-hierarchy')).toHaveCount(0);
  await expect(page.locator('[aria-labelledby="notes-editor-heading"]')).toBeVisible();
  await expect(page.locator('.notes-connections')).toContainText('Projects');
  await expect(page.locator('.notes-connections')).toContainText('Assets');
  await expect(dialog.locator('.app-dialog-body > .notes-workspace-secondary')).toHaveCount(1);
  await expect(dialog.locator('#notes-page-actions-heading')).toHaveText('Page actions');
  await expect(page.locator('.notes-workspace-secondary')).not.toContainText('Secondary actions');
  await expect(page.locator('.notes-workspace-secondary h2')).toHaveCount(0);
  await expect(page.locator('[data-note-connections] #note-assets-form')).toBeAttached();
  await expect(page.locator('.notes-workspace-disclosure')).toHaveCount(2);
  await expect(page.locator('.notes-workspace-disclosure[open]')).toHaveCount(0);
  await expect(page.locator('#note-move-form')).toHaveAttribute('action', /\/notes\/\d+\/move$/);
  await expect(page.locator('#note-delete-form')).toHaveAttribute('action', /\/notes\/\d+\/delete$/);
  await expect(page.locator('#note-move-form input[name="_csrf"]')).toHaveCount(1);
  await expect(page.locator('#note-delete-form input[name="_csrf"]')).toHaveCount(1);
  await expect(page.locator('#note-move-target')).toHaveValue(/^(book|chapter):\d+$/);
  await expect(page.locator('.notes-workspace-secondary button[data-confirm]')).toBeAttached();
  await expect(page.locator('.notes-workspace-secondary select[name="targetContainer"]')).toHaveAttribute('form', 'note-move-form');
  await expect(page.locator('.notes-workspace-secondary button[type="submit"]').nth(0)).toHaveAttribute('form', 'note-move-form');
  await expect(page.locator('.notes-workspace-secondary button[data-confirm]')).toHaveAttribute('form', 'note-delete-form');
  await expect(page.locator('#note-form #note-move-form, #note-form #note-delete-form')).toHaveCount(0);
  await expect(page.locator('#note-form form')).toHaveCount(0);
  const formOwnership = await page.evaluate(() => {
    const noteForm = document.getElementById('note-form');
    const moveForm = document.getElementById('note-move-form');
    const deleteForm = document.getElementById('note-delete-form');
    const moveTarget = document.getElementById('note-move-target');
    const moveButton = document.querySelector('button[form="note-move-form"]');
    const deleteButton = document.querySelector('button[form="note-delete-form"]');
    return {
      nestedForms: noteForm?.querySelectorAll('form').length || 0,
      moveTargetOwned: moveForm?.elements.namedItem('targetContainer') === moveTarget,
      moveButtonOwned: Array.from(moveForm?.elements || []).includes(moveButton),
      deleteButtonOwned: Array.from(deleteForm?.elements || []).includes(deleteButton),
      moveValid: moveForm?.checkValidity() || false,
      noteFormHasMoveTarget: Array.from(noteForm?.elements || []).includes(moveTarget),
    };
  });
  expect(formOwnership).toEqual({
    nestedForms: 0,
    moveTargetOwned: true,
    moveButtonOwned: true,
    deleteButtonOwned: true,
    moveValid: true,
    noteFormHasMoveTarget: false,
  });
  await assertWorkspaceDimensions(page, { editorRequired: true, actionsRequired: true });
  await expect(page.locator('#note-form [name="title"]')).toHaveValue(pageTitle);
}

async function assertWorkspaceDimensions(page, { editorRequired = false, actionsRequired = false } = {}) {
  const dialog = page.locator('#note-create-dialog[open], #note-edit-dialog[open]');
  const disclosure = dialog.locator('details.notes-book-contents-disclosure');
  if (!await disclosure.evaluate((element) => element.open)) await expandPageDialogBookContents(page);
  await expect(dialog.locator('.notes-book-detail-sidebar--embedded .notes-book-nav')).toBeVisible();
  await expect(dialog.locator('[aria-labelledby="notes-editor-heading"]')).toBeVisible();
  await expect(dialog.locator('.notes-connections')).toBeVisible();
  if (editorRequired) {
    await expect(dialog.locator('[data-notes-editor-host] .toastui-editor-defaultUI')).toBeVisible();
  }
  const state = await dialog.evaluate((element) => {
    const form = element.querySelector('#note-form');
    const box = (selector) => element.querySelector(selector).getBoundingClientRect();
    const context = box('[aria-labelledby="notes-book-contents-heading"]');
    const editor = box('[aria-labelledby="notes-editor-heading"]');
    const connections = box('.notes-connections');
    const surface = box('.toastui-editor-defaultUI');
    return {
      display: getComputedStyle(form).display,
      direction: getComputedStyle(form).flexDirection,
      contextBottom: context.bottom,
      editorTop: editor.top,
      editorBottom: editor.bottom,
      connectionsTop: connections.top,
      connectionsBottom: connections.bottom,
      sectionWidths: [context.width, editor.width, connections.width],
      editorHeight: surface.height,
      toolbarHeight: box('.toastui-editor-defaultUI-toolbar').height,
      modeSwitchHeight: box('.toastui-editor-mode-switch').height,
      actionsTop: element.querySelector('.notes-workspace-secondary')?.getBoundingClientRect().top,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      overflowing: Array.from(element.querySelectorAll('.app-dialog-body, #note-form, .notes-editor-host'))
        .some((target) => target.scrollWidth > target.clientWidth + 1),
    };
  });
  expect(state.display).toBe('flex');
  expect(state.direction).toBe('column');
  expect(state.contextBottom).toBeLessThanOrEqual(state.editorTop);
  expect(state.editorBottom).toBeLessThanOrEqual(state.connectionsTop);
  for (const width of state.sectionWidths) {
    expect(width).toBeGreaterThan(0);
    expect(width).toBeCloseTo(state.sectionWidths[0], 0);
  }
  expect(state.editorHeight).toBeGreaterThanOrEqual(16 * 16);
  expect(state.toolbarHeight).toBeGreaterThan(0);
  expect(state.modeSwitchHeight).toBeGreaterThan(0);
  expect(state.documentWidth).toBeLessThanOrEqual(state.viewportWidth);
  expect(state.overflowing).toBe(false);
  if (actionsRequired) expect(state.connectionsBottom).toBeLessThanOrEqual(state.actionsTop);
  const submit = dialog.locator('.app-dialog-footer [data-dialog-submit]');
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await expect(submit).toBeEnabled();
}

async function selectNotesEditorMode(modeSwitch, mode) {
  const tab = modeSwitch.locator('.tab-item').filter({ hasText: mode });
  await expect(tab).toHaveCount(1);
  await tab.click();
  await expect(modeSwitch.locator('.tab-item.active')).toContainText(mode);
}

async function replaceNotesEditorText(page, surface, lines) {
  await surface.click();
  await page.keyboard.press('Control+A');
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type(line);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
