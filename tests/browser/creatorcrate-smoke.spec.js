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
    await exerciseProjectFilterEnhancement(page);

    expect(navigationCount()).toBe(1);
    assertNoToastUiRequests(diagnostics);
    assertNoBrowserDiagnostics(diagnostics);
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

    await page.locator('#title').fill('TOAST UI Break Round Trip');
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
    await page.locator('#title').fill('Rendered Code Copy');
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
        expectedCurrentContainer: 'direct Page',
      });
      await expect(page.locator('.notes-workspace-context .notes-book-nav')).toHaveCount(1);
      await expect(page.locator(`.notes-book-nav-list > .notes-book-nav-page:has(a[href="/notes/${directPageId}"]) a[aria-current="page"]`))
        .toHaveCount(1);
      await expect(page.locator('.notes-book-nav details[open]')).toHaveCount(0);
      await expect(page.locator('.notes-page-nav')).toHaveCount(0);

      if (viewport.width > 1024) {
        await page.locator('#title').fill('');
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
        await page.locator('#title').fill('Browser Direct Edit Saved');
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
        expectedCurrentContainer: 'Browser Edit Chapter',
      });
      const containingChapterNav = page.locator('.notes-book-nav-list > .notes-book-nav-chapter')
        .filter({ hasText: 'Browser Edit Chapter' });
      await expect(containingChapterNav.locator('details[open]')).toHaveCount(1);
      await expect(containingChapterNav.locator(`a[href="/notes/${chapterPageId}"][aria-current="page"]`)).toHaveCount(1);
      await expect(page.locator('.notes-book-nav [aria-current="page"]')).toHaveCount(1);
      await expect(page.locator('.notes-page-nav')).toHaveCount(0);

      await page.goto(`${devServer.baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Cancel', exact: true })).toHaveAttribute('href', `/notes/chapters/${chapterId}`);
      await expect(page.locator(`.notes-book-nav-chapter-link[href="/notes/chapters/${chapterId}"][aria-current="page"]`)).toHaveCount(1);
      await expect(page.locator('.notes-workspace')).toContainText('Connections');
      await expect(page.locator('.notes-workspace-disclosure')).toHaveCount(0);
      await expect(page.locator('.notes-workspace-secondary')).toHaveCount(0);
      await expect(page.locator('#note-form form')).toHaveCount(0);
      await expect(page.locator('[data-notes-asset-picker]')).toBeAttached();
      await assertWorkspaceDimensions(page, { editorRequired: true });

      if (viewport.width > 1024) {
        await page.locator('#title').fill('');
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
        await page.locator('#title').fill('Browser Created Edit Smoke Page');
        await Promise.all([
          page.waitForURL(/\/notes\/\d+$/),
          page.getByRole('button', { name: 'Create', exact: true }).click(),
        ]);
        await expect(page.locator('h1.app-section-title')).toContainText('Browser Created Edit Smoke Page');
      }

      await page.goto(`${devServer.baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });
      const createChapterNav = page.locator('.notes-book-nav-list > .notes-book-nav-chapter')
        .filter({ hasText: 'Browser Edit Chapter' });
      await expect(page.locator('.notes-workspace-context .notes-book-nav')).toHaveCount(1);
      await expect(createChapterNav.locator('details[open]')).toHaveCount(1);
      await expect(createChapterNav.locator(`a[href="/notes/chapters/${chapterId}"][aria-current="page"]`)).toHaveCount(1);
      await expect(page.locator('.notes-book-nav [aria-current="page"]')).toHaveCount(1);
      await expect(page.locator('.notes-book-nav .notes-book-nav-page-link[aria-current="page"]')).toHaveCount(0);
      await expect(page.locator('.notes-page-nav')).toHaveCount(0);
      await assertWorkspaceDimensions(page, { editorRequired: true });

      await page.goto(`${devServer.baseURL}/notes/new?bookId=${bookId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.notes-workspace-context .notes-book-nav')).toHaveCount(1);
      await expect(page.locator('.notes-book-nav [aria-current="page"]')).toHaveCount(0);
      await expect(page.locator('.notes-book-nav details[open]')).toHaveCount(0);
      await expect(page.locator('.notes-page-nav')).toHaveCount(0);
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
      const response = await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);

      await expect(page.locator('h1.app-section-title')).toHaveCount(1);
      await expect(page.locator('.page-heading-actions').getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await expect(page.locator('.page-heading-actions').getByRole('link', { name: 'Cancel', exact: true }))
        .toHaveAttribute('href', `/notes/chapters/${chapterId}`);
      await expect(page.locator('.page-heading-actions').getByRole('link', { name: 'Delete', exact: true })).toHaveCount(0);
      await expect(page.locator('h1.app-section-title')).toContainText(`Notes — Edit ${chapterTitle}`);
      await expect(page.locator('.notes-hierarchy')).toHaveCount(0);
      await expect(page.locator('.notes-workspace')).toHaveCount(0);
      await expect(page.locator('#chapter-form form')).toHaveCount(0);
      await expect(page.locator('details.notes-workspace-disclosure')).toHaveCount(1);
      await expect(page.locator('details.notes-workspace-disclosure[open]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete Chapter', exact: true })).toBeHidden();
      await expect(page.locator('#chapter-delete-form')).toHaveAttribute('action', `/notes/chapters/${chapterId}/delete`);
      await expect(page.locator('#chapter-delete-form input[name="_csrf"]')).toHaveCount(1);
      await expect(page.locator('#chapter-delete-form button[data-confirm]')).toBeAttached();
      await expect(page.locator('main#main-content')).not.toContainText('Danger zone');

      const layoutState = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        mainRight: element.getBoundingClientRect().right,
      }));
      expect(layoutState.documentWidth).toBeLessThanOrEqual(layoutState.viewportWidth);
      expect(layoutState.mainRight).toBeLessThanOrEqual(layoutState.viewportWidth);

      if (viewport.width > 1024) {
        await page.locator('#title').fill(editedTitle);
        await Promise.all([
          page.waitForURL(new RegExp(`/notes/chapters/${chapterId}$`)),
          page.getByRole('button', { name: 'Save', exact: true }).click(),
        ]);
        await expect(page.locator('h1.app-section-title')).toContainText(editedTitle);

        await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
        await Promise.all([
          page.waitForURL(new RegExp(`/notes/chapters/${chapterId}$`)),
          page.getByRole('link', { name: 'Cancel', exact: true }).click(),
        ]);
        await expect(page.locator('h1.app-section-title')).toContainText(editedTitle);
      }
    }

    await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('details.notes-workspace-disclosure summary').click();
    await expect(page.locator('details.notes-workspace-disclosure[open]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Delete Chapter', exact: true })).toBeVisible();
    const openLayoutState = await page.locator('main#main-content').evaluate((element) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(openLayoutState.documentWidth).toBeLessThanOrEqual(openLayoutState.viewportWidth);

    page.once('dialog', (dialog) => dialog.accept());
    await Promise.all([
      page.waitForURL(new RegExp(`/notes/books/${bookId}$`)),
      page.getByRole('button', { name: 'Delete Chapter', exact: true }).click(),
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
      await expect(page.locator('.notes-book-nav')).toHaveCount(1);
      await expect(page.locator('.notes-chapter-detail-sidebar.notes-surface.notes-surface--compact')).toHaveCount(1);
       await expect(page.locator('.notes-book-nav-book-link'))
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

      const topLevelTitles = await page.locator('.notes-book-nav-list > .notes-book-nav-item').evaluateAll(
        (items) => items.map((item) => item.querySelector(
          '.notes-book-nav-chapter-link, .notes-book-nav-page-link',
        )?.textContent?.trim()),
      );
      expect(topLevelTitles).toEqual([
        directFirstTitle,
        currentChapterTitle,
        directSecondTitle,
        otherChapterTitle,
      ]);
      await expect(page.locator('.notes-book-nav-list > .notes-book-nav-page')).toHaveCount(2);
      await expect(page.locator(`.notes-book-nav-page-link[href="/notes/${directFirstId}"]`)).toBeVisible();
      await expect(page.locator(`.notes-book-nav-page-link[href="/notes/${directSecondId}"]`)).toBeVisible();

      const currentNavItem = page.locator('.notes-book-nav-item--current');
      await expect(currentNavItem).toHaveCount(1);
      await expect(currentNavItem.locator('.notes-book-nav-chapter-link'))
        .toHaveAttribute('aria-current', 'page');
      await expect(currentNavItem.locator('details[open]')).toHaveCount(1);
      await expect(currentNavItem.locator('ol.notes-book-nav-pages > .notes-book-nav-item')).toHaveCount(2);
      expect(await currentNavItem.locator('ol.notes-book-nav-pages > .notes-book-nav-item').evaluateAll(
        (items) => items.map((item) => item.textContent.trim()),
      )).toEqual(nestedPageTitles);
      for (const pageId of nestedPageIds) {
        await expect(currentNavItem.locator(`a[href="/notes/${pageId}"]`)).toBeVisible();
      }

      const unrelatedNavItem = page.locator('.notes-book-nav-list > .notes-book-nav-item')
        .filter({ hasText: otherChapterTitle });
      await expect(unrelatedNavItem.locator('details[open]')).toHaveCount(0);
      await expect(page.locator('.notes-book-nav [aria-current="page"]')).toHaveCount(1);

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
      await expect(page.locator('.notes-book-nav')).toHaveCount(1);
      await expect(page.locator('.notes-page-detail-sidebar.notes-surface.notes-surface--compact')).toHaveCount(1);
      await expect(page.locator('.notes-book-nav-book-link'))
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

      const topLevelTitles = await page.locator('.notes-book-nav-list > .notes-book-nav-item').evaluateAll(
        (items) => items.map((item) => item.querySelector(
          '.notes-book-nav-chapter-link, .notes-book-nav-page-link',
        )?.textContent?.trim()),
      );
      expect(topLevelTitles).toEqual([
        directFirstTitle,
        currentChapterTitle,
        directSecondTitle,
        otherChapterTitle,
      ]);
      await expect(page.locator(`.notes-book-nav-page-link[href="/notes/${directFirstId}"]`)).toBeVisible();
      await expect(page.locator(`.notes-book-nav-page-link[href="/notes/${directSecondId}"]`)).toBeVisible();

      const currentNavItem = page.locator('.notes-book-nav-item--current');
      await expect(currentNavItem).toHaveCount(1);
      await expect(currentNavItem.locator('details[open]')).toHaveCount(0);
      const containingChapter = page.locator('.notes-book-nav-list > .notes-book-nav-item')
        .filter({ hasText: currentChapterTitle });
      await expect(containingChapter.locator('details[open]')).toHaveCount(1);
      await expect(containingChapter.locator('.notes-book-nav-chapter-link')).not.toHaveAttribute('aria-current', 'page');
      await expect(containingChapter.locator(`a[href="/notes/${nestedPageIds[1]}"]`))
        .toHaveAttribute('aria-current', 'page');
      expect(await containingChapter.locator('ol.notes-book-nav-pages > .notes-book-nav-item').evaluateAll(
        (items) => items.map((item) => item.textContent.trim()),
      )).toEqual(nestedPageTitles);

      const unrelatedNavItem = page.locator('.notes-book-nav-list > .notes-book-nav-item')
        .filter({ hasText: otherChapterTitle });
      await expect(unrelatedNavItem.locator('details[open]')).toHaveCount(0);
      await expect(page.locator('.notes-book-nav [aria-current="page"]')).toHaveCount(1);
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
    const editUrl = `${devServer.baseURL}/notes/books/${bookId}/edit`;
    const editedBookTitle = `${originalBookTitle} Saved`;

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 375, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const response = await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);

      await expect(page.locator('h1.app-section-title')).toHaveCount(1);
      await expect(page.locator('.page-heading-actions').getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await expect(page.locator('.page-heading-actions').getByRole('link', { name: 'Cancel', exact: true }))
        .toHaveAttribute('href', `/notes/books/${bookId}`);
      await expect(page.locator('.page-heading-actions').getByRole('link', { name: 'Delete', exact: true })).toHaveCount(0);
      await expect(page.locator('h1.app-section-title')).toHaveText(
        `Notes — Edit ${viewport.width > 1024 ? originalBookTitle : editedBookTitle}`,
      );
      await expect(page.locator('.notes-hierarchy')).toHaveCount(0);
      await expect(page.locator('.notes-workspace')).toHaveCount(0);
      await expect(page.locator('#book-form .settings-section')).toBeVisible();
      await expect(page.locator('#book-form form')).toHaveCount(0);
      await expect(page.locator('details.notes-workspace-disclosure')).toHaveCount(1);
      await expect(page.locator('details.notes-workspace-disclosure[open]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete Book', exact: true })).toBeHidden();
      await expect(page.locator('#book-delete-form')).toHaveAttribute('action', `/notes/books/${bookId}/delete`);
      await expect(page.locator('#book-delete-form input[name="_csrf"]')).toHaveCount(1);
      await expect(page.locator('#book-delete-form button[data-confirm]')).toBeAttached();
      await expect(page.locator('main#main-content')).not.toContainText('Danger zone');

      await page.locator('details.notes-workspace-disclosure summary').click();
      await expect(page.locator('details.notes-workspace-disclosure[open]')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Delete Book', exact: true })).toBeVisible();
      const openLayoutState = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        mainRight: element.getBoundingClientRect().right,
      }));
      expect(openLayoutState.documentWidth).toBeLessThanOrEqual(openLayoutState.viewportWidth);
      expect(openLayoutState.mainRight).toBeLessThanOrEqual(openLayoutState.viewportWidth);
      await page.locator('details.notes-workspace-disclosure summary').click();

      const layoutState = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        mainRight: element.getBoundingClientRect().right,
      }));
      expect(layoutState.documentWidth).toBeLessThanOrEqual(layoutState.viewportWidth);
      expect(layoutState.mainRight).toBeLessThanOrEqual(layoutState.viewportWidth);

      if (viewport.width > 1024) {
        await page.locator('#title').fill(editedBookTitle);
        await Promise.all([
          page.waitForURL(new RegExp(`/notes/books/${bookId}$`)),
          page.getByRole('button', { name: 'Save', exact: true }).click(),
        ]);
        await expect(page.locator('h1.app-section-title')).toContainText(editedBookTitle);
        await expect(page.getByRole('link', { name: chapterTitle, exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: directPageTitle, exact: true })).toBeVisible();

        await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
        await Promise.all([
          page.waitForURL(new RegExp(`/notes/books/${bookId}$`)),
          page.getByRole('link', { name: 'Cancel', exact: true }).click(),
        ]);
        await expect(page.locator('h1.app-section-title')).toContainText(editedBookTitle);
      }
    }

    const emptyBookId = await createBrowserBook(page, devServer.baseURL, `Browser Empty Book ${Date.now()}`);
    await page.goto(`${devServer.baseURL}/notes/books/${emptyBookId}/edit`, { waitUntil: 'domcontentloaded' });
    await page.locator('details.notes-workspace-disclosure summary').click();
    page.once('dialog', (dialog) => dialog.accept());
    await Promise.all([
      page.waitForURL(/\/notes$/),
      page.getByRole('button', { name: 'Delete Book', exact: true }).click(),
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
    await expect(page.locator('.empty-state')).toContainText('No books yet');
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toHaveCount(0);
    await expect(page.locator('.notes-books-index .notes-book-content-row')).toHaveCount(0);
    await expect(page.locator('.table-scroll, .data-table')).toHaveCount(0);

    const firstBookTitle = `Browser Landing Book One ${Date.now()}`;
    await createBrowserBook(page, devServer.baseURL, firstBookTitle);
    await page.goto(`${devServer.baseURL}/notes`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.notes-books-index .notes-book-content-row')).toHaveCount(1);
    await expect(page.getByRole('link', { name: firstBookTitle, exact: true })).toHaveCount(1);
    await expect(page.getByRole('link', { name: `Edit Book: ${firstBookTitle}`, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toHaveCount(0);

    const secondBookTitle = `Browser Landing Book Two ${Date.now()}`;
    await createBrowserBook(page, devServer.baseURL, secondBookTitle);
    await page.goto(`${devServer.baseURL}/notes`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.notes-books-index .notes-book-content-row')).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: `Edit Book: ${firstBookTitle}`, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: `Edit Book: ${secondBookTitle}`, exact: true })).toBeVisible();
    await expect(page.locator('main#main-content')).not.toContainText('Manage');
    await expect(page.locator('main#main-content')).not.toContainText('Move up');
    await expect(page.locator('main#main-content')).not.toContainText('Move down');
    await expect(page.locator('[draggable="true"]')).toHaveCount(0);

    const narrowState = await page.locator('main#main-content').evaluate((element) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      rowRight: Math.max(...[...element.querySelectorAll('.notes-books-index .notes-book-content-row')]
        .map((row) => row.getBoundingClientRect().right)),
    }));
    expect(narrowState.documentWidth).toBeLessThanOrEqual(narrowState.viewportWidth);
    expect(narrowState.rowRight).toBeLessThanOrEqual(narrowState.viewportWidth);

    await page.setViewportSize({ width: 1280, height: 800 });
    const desktopState = await page.locator('main#main-content').evaluate((element) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      rowRight: Math.max(...[...element.querySelectorAll('.notes-books-index .notes-book-content-row')]
        .map((row) => row.getBoundingClientRect().right)),
    }));
    expect(desktopState.documentWidth).toBeLessThanOrEqual(desktopState.viewportWidth);
    expect(desktopState.rowRight).toBeLessThanOrEqual(desktopState.viewportWidth);

    await Promise.all([
      page.waitForURL(/\/notes\/books\/order$/),
      page.getByRole('link', { name: 'Change order', exact: true }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'Change order', exact: true, level: 2 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cancel', exact: true })).toHaveAttribute('href', '/notes');
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
      await expect(page.locator('.notes-books-order')).toContainText('Drag a handle to move a Book');
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
    await expect(page.locator('.notes-books-index .notes-book-content-row')).toHaveCount(3);
    await expect(page.locator('.notes-books-index .notes-book-content-row').nth(0)).toContainText(titles[1]);
    await expect(page.locator('.notes-books-index .notes-book-content-row').nth(1)).toContainText(titles[2]);
    await expect(page.locator('.notes-books-index .notes-book-content-row').nth(2)).toContainText(titles[0]);
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
    await expect(page.locator('main#main-content')).toContainText('Save');

    await Promise.all([
      page.waitForURL((url) => url.pathname === '/notes'),
      page.getByRole('link', { name: 'Cancel', exact: true }).click(),
    ]);
    expect(reorderRequests).toHaveLength(1);
    const landingRows = page.locator('.notes-books-index .notes-book-content-row');
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
    await expect(page.locator('.empty-state')).toContainText('No Pages yet');
    await expect(page.locator('.empty-state').getByRole('link', { name: 'New Page', exact: true })).toBeVisible();
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
      await expect(page.locator('h1.app-section-title')).toHaveText(`Notes — Change order — ${chapterTitle}`);
      await expect(page.locator('.notes-hierarchy')).toHaveCount(0);
      await expect(page.locator('.notes-chapter-order')).toContainText('Drag a handle to move a Page');
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

    await Promise.all([
      page.waitForURL(/\/notes\/chapters\/\d+\/notes\/order$/),
      page.getByRole('link', { name: 'Change order', exact: true }).click(),
    ]);
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
    await expect(page.locator('main#main-content')).toContainText('Save');

    await Promise.all([
      page.waitForURL((url) => url.pathname === `/notes/chapters/${chapterId}`),
      page.getByRole('link', { name: 'Cancel', exact: true }).click(),
    ]);
    expect(reorderRequests).toHaveLength(1);
    const unchangedRows = page.locator('.notes-page-nav-item');
    await expect(unchangedRows.nth(0)).toContainText(pageTitles[2]);
    await expect(unchangedRows.nth(1)).toContainText(pageTitles[0]);
    await expect(unchangedRows.nth(2)).toContainText(pageTitles[1]);
    await expect(page.locator('.notes-page-nav')).not.toContainText(directPageTitle);
    assertNoBrowserDiagnostics(diagnostics);
  });

  test('keeps Book detail as one surfaced semantic mixed outline with native Chapter disclosure', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);
    const bookTitle = `Browser Book Detail ${Date.now()}`;
    const emptyBookId = await createBrowserBook(page, devServer.baseURL, bookTitle);
    const bookUrl = `${devServer.baseURL}/notes/books/${emptyBookId}`;

    const emptyResponse = await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    expect(emptyResponse?.status()).toBe(200);
    await expect(page.locator('h1.app-section-title')).toHaveCount(1);
    await expect(page.locator('h1.app-section-title')).toContainText(bookTitle);
    await expect(page.locator('.notes-hierarchy')).toHaveCount(0);
    await expect(page.locator('.notes-surface')).toHaveCount(1);
    await expect(page.locator('.notes-surface > .book-outline')).toHaveCount(1);
    await expect(page.locator('.book-outline')).toHaveCount(1);
    await expect(page.locator('.book-outline-list')).toHaveCount(0);
    await expect(page.locator('.book-outline-empty')).toHaveCount(1);
    await expect(page.locator('.book-outline-empty')).toContainText('No Pages or Chapters yet');
    await expect(page.locator('h2')).toHaveCount(0);
    await expect(page.locator('.page-heading-actions').getByRole('link', { name: 'New Page', exact: true })).toBeVisible();
    await expect(page.locator('.page-heading-actions').getByRole('link', { name: 'New Chapter', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit Book', exact: true })).toBeVisible();
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
    await createBrowserDirectPage(page, devServer.baseURL, emptyBookId, pageATitle);
    const pageAId = new URL(page.url()).pathname.split('/').at(-1);
    const chapterXId = await createBrowserChapter(page, devServer.baseURL, emptyBookId, chapterXTitle);
    const nestedPageIds = [];
    for (const nestedPageTitle of nestedPageTitles) {
      nestedPageIds.push(await createBrowserPage(page, devServer.baseURL, chapterXId, nestedPageTitle));
    }
    await createBrowserDirectPage(page, devServer.baseURL, emptyBookId, pageBTitle);
    const pageBId = new URL(page.url()).pathname.split('/').at(-1);
    const chapterYId = await createBrowserChapter(page, devServer.baseURL, emptyBookId, chapterYTitle);
    expect(pageAId).toBe(chapterXId);

    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.notes-hierarchy')).toHaveCount(0);
    await expect(page.locator('.notes-surface')).toHaveCount(1);
    await expect(page.locator('.notes-surface > .book-outline')).toHaveCount(1);
    await expect(page.locator('.book-outline')).toHaveCount(1);
    await expect(page.locator('.book-outline-list')).toHaveCount(1);
    await expect(page.locator('.book-outline-list > .book-outline-item')).toHaveCount(4);
    await expect(page.locator('.book-outline-list > .book-outline-page')).toHaveCount(2);
    await expect(page.locator('.book-outline-list > .book-outline-chapter')).toHaveCount(2);
    const outlineTopLevelTitles = () => page.locator('.book-outline-list > .book-outline-item').evaluateAll(
      (items) => items.map((item) => item.querySelector('.book-outline-title')?.textContent?.trim()),
    );
    expect(await outlineTopLevelTitles()).toEqual([pageATitle, chapterXTitle, pageBTitle, chapterYTitle]);
    await expect(page.locator('.book-outline-list > .book-outline-page').nth(0).locator('.book-outline-title'))
      .toHaveAttribute('href', `/notes/${pageAId}`);
    await expect(page.locator('.book-outline-list > .book-outline-page').nth(1).locator('.book-outline-title'))
      .toHaveAttribute('href', `/notes/${pageBId}`);
    await expect(page.locator('.book-outline-chapter').nth(0).locator('details > summary .book-outline-title'))
      .toHaveAttribute('href', `/notes/chapters/${chapterXId}`);
    await expect(page.locator('.book-outline-chapter').nth(1).locator('details > summary .book-outline-title'))
      .toHaveAttribute('href', `/notes/chapters/${chapterYId}`);
    await expect(page.locator('.book-outline-chapter').nth(0).locator('.book-outline-count')).toHaveText('3 Pages');
    await expect(page.locator('.book-outline-chapter').nth(1).locator('.book-outline-count')).toHaveText('0 Pages');
    await expect(page.locator('.book-outline-chapter details[open]')).toHaveCount(0);
    await expect(page.locator('.book-outline-chapter').nth(0).locator('ol.book-outline-children > li')).toHaveCount(3);
    expect(await page.locator('.book-outline-chapter').nth(0).locator('ol.book-outline-children .book-outline-title').allTextContents())
      .toEqual(nestedPageTitles);
    await expect(page.locator('.book-outline-chapter').nth(1)).toContainText('No Pages yet');
    await expect(page.locator('.book-outline')).not.toContainText('Edit Page');
    await expect(page.locator('.book-outline')).not.toContainText('Edit Chapter');
    await expect(page.locator('.book-outline')).not.toContainText('Move up');
    await expect(page.locator('.book-outline')).not.toContainText('Move down');
    await expect(page.locator('.book-outline [draggable="true"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'New Page', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New Chapter', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit Book', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Change order', exact: true })).toBeVisible();
    await expect(page.locator('main#main-content')).not.toContainText('Manage');
    await expect(page.locator('main#main-content')).not.toContainText('Move up');
    await expect(page.locator('main#main-content')).not.toContainText('Move down');
    await expect(page.locator('main#main-content')).not.toContainText('Danger zone');
    await expect(page.locator('main#main-content')).not.toContainText('Delete');

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 720, height: 800 },
      { width: 375, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
      const layout = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        mainRect: element.getBoundingClientRect(),
        headingRect: element.querySelector('header.page-heading')?.getBoundingClientRect(),
        surfaceRect: element.querySelector('.notes-surface')?.getBoundingClientRect(),
        outlineRight: element.querySelector('.book-outline')?.getBoundingClientRect().right || 0,
      }));
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(Math.abs(layout.headingRect.width - layout.surfaceRect.width)).toBeLessThan(1);
      expect(Math.abs(layout.headingRect.left - layout.surfaceRect.left)).toBeLessThan(1);
      expect(Math.abs(layout.headingRect.right - layout.surfaceRect.right)).toBeLessThan(1);
      expect(layout.surfaceRect.top).toBeGreaterThanOrEqual(layout.headingRect.bottom);
      expect(layout.surfaceRect.left).toBeGreaterThanOrEqual(layout.mainRect.left);
      expect(layout.surfaceRect.right).toBeLessThanOrEqual(layout.mainRect.right);
      expect(layout.outlineRight).toBeLessThanOrEqual(layout.viewportWidth);
      await expect(page.locator('.book-outline-item.notes-surface')).toHaveCount(0);

      const viewportChapterDetails = page.locator('.book-outline-chapter').nth(0).locator('details');
      const viewportChapterSummary = viewportChapterDetails.locator('.book-outline-summary');
      const viewportChapterIndicator = viewportChapterDetails.locator('.book-outline-disclosure-indicator');
      const viewportChapterCount = viewportChapterDetails.locator('.book-outline-count');
      await viewportChapterDetails.locator('.book-outline-disclosure-indicator').click();
      expect(page.url()).toBe(bookUrl);
      await expect(viewportChapterDetails).toHaveAttribute('open', '');
      await expect(viewportChapterDetails.locator('ol.book-outline-children')).toBeVisible();
      await expect(viewportChapterDetails.locator('ol.book-outline-children > li')).toHaveCount(3);
      await viewportChapterIndicator.click();
      expect(page.url()).toBe(bookUrl);
      await expect(viewportChapterDetails).not.toHaveAttribute('open', '');
      await viewportChapterCount.click();
      expect(page.url()).toBe(bookUrl);
      await expect(viewportChapterDetails).toHaveAttribute('open', '');
      await viewportChapterCount.click();
      expect(page.url()).toBe(bookUrl);
      await expect(viewportChapterDetails).not.toHaveAttribute('open', '');
      if (viewport.width > 540) {
        const whitespacePoint = await viewportChapterSummary.evaluate((summary) => {
          const title = summary.querySelector('.book-outline-title');
          const count = summary.querySelector('.book-outline-count');
          const summaryBox = summary.getBoundingClientRect();
          const titleBox = title.getBoundingClientRect();
          const countBox = count.getBoundingClientRect();
          const x = titleBox.right + ((countBox.left - titleBox.right) / 2);
          const y = summaryBox.top + (summaryBox.height / 2);
          const hit = document.elementFromPoint(x, y);
          return {
            x,
            y,
            gap: countBox.left - titleBox.right,
            hitsTitle: Boolean(hit?.closest('.book-outline-title')),
          };
        });
        expect(whitespacePoint.gap).toBeGreaterThan(0);
        expect(whitespacePoint.hitsTitle).toBe(false);
        await page.mouse.click(whitespacePoint.x, whitespacePoint.y);
        expect(page.url()).toBe(bookUrl);
        await expect(viewportChapterDetails).toHaveAttribute('open', '');
      }
      if (viewport.width <= 540) {
        const countLayout = await viewportChapterDetails.locator('.book-outline-summary').evaluate((summary) => ({
          countTop: summary.querySelector('.book-outline-count').getBoundingClientRect().top,
          titleBottom: summary.querySelector('.book-outline-title').getBoundingClientRect().bottom,
        }));
        expect(countLayout.countTop).toBeGreaterThanOrEqual(countLayout.titleBottom);
      }
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    const chapterXDetails = page.locator('.book-outline-chapter').nth(0).locator('details');
    const chapterXSummary = chapterXDetails.locator('.book-outline-summary');
    await chapterXSummary.focus();
    await expect(chapterXSummary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(chapterXDetails).toHaveAttribute('open', '');
    expect(page.url()).toBe(bookUrl);
    await chapterXSummary.focus();
    await page.keyboard.press('Space');
    await expect(chapterXDetails).not.toHaveAttribute('open', '');
    expect(page.url()).toBe(bookUrl);
    await chapterXSummary.focus();
    await page.keyboard.press('Space');
    await expect(chapterXDetails).toHaveAttribute('open', '');
    expect(page.url()).toBe(bookUrl);
    await chapterXSummary.focus();
    await page.keyboard.press('Enter');
    await expect(chapterXDetails).not.toHaveAttribute('open', '');

    const chapterUrl = `${devServer.baseURL}/notes/chapters/${chapterXId}`;
    const chapterToggleKey = `__creatorcrate_book_outline_chapter_toggle_${chapterXId}`;
    const assertChapterTitleActivation = async (activate) => {
      await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
      const details = page.locator('.book-outline-chapter').nth(0).locator('details');
      const title = details.locator('summary .book-outline-title');
      await page.evaluate((toggleKey) => {
        sessionStorage.removeItem(toggleKey);
        document.querySelector('.book-outline-chapter details').addEventListener('toggle', () => {
          sessionStorage.setItem(toggleKey, 'toggled');
        }, { once: true });
      }, chapterToggleKey);
      await Promise.all([
        page.waitForURL(chapterUrl),
        activate(title),
      ]);
      expect(await page.evaluate((toggleKey) => sessionStorage.getItem(toggleKey), chapterToggleKey)).toBeNull();
    };

    await assertChapterTitleActivation((title) => title.click());
    await assertChapterTitleActivation(async (title) => {
      await title.focus();
      await expect(title).toBeFocused();
      await page.keyboard.press('Enter');
    });

    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    await chapterXDetails.locator('.book-outline-disclosure-indicator').click();
    await expect(chapterXDetails).toHaveAttribute('open', '');
    await expect(chapterXDetails.locator('ol.book-outline-children')).toBeVisible();
    await expect(chapterXDetails.locator('ol.book-outline-children > li')).toHaveCount(3);
    await chapterXDetails.locator('.book-outline-disclosure-indicator').click();
    await expect(chapterXDetails).not.toHaveAttribute('open', '');
    await expect(chapterXDetails.locator('ol.book-outline-children')).toBeHidden();
    const chapterYDetails = page.locator('.book-outline-chapter').nth(1).locator('details');
    await chapterYDetails.locator('.book-outline-disclosure-indicator').click();
    await expect(chapterYDetails).toHaveAttribute('open', '');
    await expect(chapterYDetails.locator('.book-outline-empty')).toBeVisible();
    await chapterYDetails.locator('.book-outline-disclosure-indicator').click();
    await expect(chapterYDetails).not.toHaveAttribute('open', '');

    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    await Promise.all([
      page.waitForURL(new RegExp(`/notes/${pageAId}$`)),
      page.getByRole('link', { name: pageATitle, exact: true }).click(),
    ]);
    await expect(page.locator('h1.app-section-title')).toContainText(pageATitle);
    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    await Promise.all([
      page.waitForURL(new RegExp(`/notes/chapters/${chapterXId}$`)),
      page.getByRole('link', { name: chapterXTitle, exact: true }).click(),
    ]);
    await expect(page.locator('h1.app-section-title')).toContainText(chapterXTitle);
    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.book-outline-chapter').nth(0).locator('.book-outline-disclosure-indicator').click();
    await Promise.all([
      page.waitForURL(new RegExp(`/notes/${nestedPageIds[0]}$`)),
      page.locator('.book-outline-chapter').nth(0).locator('ol.book-outline-children .book-outline-title').first().click(),
    ]);
    await expect(page.locator('h1.app-section-title')).toContainText(nestedPageTitles[0]);
    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    await page.goto(`${devServer.baseURL}/notes/${pageAId}/edit`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.app-section-title')).toContainText(`Notes — Edit ${pageATitle}`);
    await page.goto(`${devServer.baseURL}/notes/chapters/${chapterXId}/edit`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1.app-section-title')).toContainText(`Notes — Edit ${chapterXTitle}`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(bookUrl, { waitUntil: 'domcontentloaded' });
    await Promise.all([
      page.waitForURL(/\/notes\/books\/\d+\/order$/),
      page.getByRole('link', { name: 'Change order', exact: true }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'Change order', exact: true, level: 2 })).toBeVisible();
    await expect(page.locator('.notes-book-order')).toContainText('Drag a handle to move a Chapter or Page');
    await expect(page.locator('#notes-book-order-form')).toHaveAttribute('action', `/notes/books/${emptyBookId}/contents/reorder`);
    await expect(page.locator('#notes-book-order-form')).toHaveCount(1);
    await expect(page.locator('#notes-book-order-form input[name="_csrf"]')).toHaveCount(1);
    await expect(page.locator('#notes-book-order-form input[name="orderedItems"]')).toHaveValue(
      `page:${pageAId},chapter:${chapterXId},page:${pageBId},chapter:${chapterYId}`,
    );
    await expect(page.locator('[data-book-content-reorder-item]')).toHaveCount(4);
    await expect(page.locator('[data-book-content-reorder-handle]')).toHaveCount(4);
    expect(await page.locator('[data-book-content-reorder-item]').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-content-key')),
    )).toEqual([
      `page:${pageAId}`,
      `chapter:${chapterXId}`,
      `page:${pageBId}`,
      `chapter:${chapterYId}`,
    ]);
    expect(await page.locator('.notes-book-content-kind').allTextContents())
      .toEqual(['Page', 'Chapter', 'Page', 'Chapter']);
    for (const nestedPageTitle of nestedPageTitles) {
      await expect(page.locator('.notes-book-order')).not.toContainText(nestedPageTitle);
    }
    await expect(page.locator('.notes-book-order')).not.toContainText('Other Book');

    const orderTitles = () => page.locator('[data-book-content-reorder-item]').evaluateAll(
      (items) => items.map((item) => item.querySelector('.notes-book-content-title')?.textContent?.trim()),
    );
    const orderKeys = () => page.locator('[data-book-content-reorder-item]').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-content-key')),
    );
    const assertBookOrderLayout = async () => {
      const layout = await page.locator('main#main-content').evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        handleWidth: element.querySelector('[data-book-content-reorder-handle]')?.getBoundingClientRect().width || 0,
        rowRight: Math.max(...[...element.querySelectorAll('[data-book-content-reorder-item]')]
          .map((row) => row.getBoundingClientRect().right)),
      }));
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.rowRight).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.handleWidth).toBeLessThanOrEqual(48);
    };
    await assertBookOrderLayout();

    const reorderRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/notes/books/${emptyBookId}/contents/reorder`) {
        reorderRequests.push(request);
      }
    });

    const firstRow = page.locator('[data-book-content-reorder-item]').first();
    const chapterYRow = page.locator(`[data-content-key="chapter:${chapterYId}"]`);
    const firstRowBox = await firstRow.boundingBox();
    expect(firstRowBox).not.toBeNull();
    await chapterYRow.locator('[data-book-content-reorder-handle]').dragTo(firstRow, {
      targetPosition: { x: Math.min(20, firstRowBox.width - 1), y: 1 },
    });
    expect(await orderTitles()).toEqual([chapterYTitle, pageATitle, chapterXTitle, pageBTitle]);
    expect(await orderKeys()).toEqual([
      `chapter:${chapterYId}`,
      `page:${pageAId}`,
      `chapter:${chapterXId}`,
      `page:${pageBId}`,
    ]);
    await expect(page.locator('#notes-book-order-form input[name="orderedItems"]')).toHaveValue(
      `chapter:${chapterYId},page:${pageAId},chapter:${chapterXId},page:${pageBId}`,
    );
    expect(reorderRequests).toHaveLength(0);

    await Promise.all([
      page.waitForURL((url) => url.pathname === `/notes/books/${emptyBookId}`),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect(reorderRequests).toHaveLength(1);
    expect(await outlineTopLevelTitles()).toEqual([chapterYTitle, pageATitle, chapterXTitle, pageBTitle]);
    for (const nestedPageTitle of nestedPageTitles) {
      await expect(page.locator('.book-outline')).toContainText(nestedPageTitle);
    }

    await page.goto(`${devServer.baseURL}/notes/books/${emptyBookId}/order`, { waitUntil: 'domcontentloaded' });
    expect(await orderKeys()).toEqual([
      `chapter:${chapterYId}`,
      `page:${pageAId}`,
      `chapter:${chapterXId}`,
      `page:${pageBId}`,
    ]);
    const movedHandle = page.locator(`[data-content-key="page:${pageAId}"]`)
      .locator('[data-book-content-reorder-handle]');
    await movedHandle.focus();
    await page.keyboard.press('ArrowDown');
    expect(await orderTitles()).toEqual([chapterYTitle, chapterXTitle, pageATitle, pageBTitle]);
    await expect(movedHandle).toBeFocused();
    await expect(page.locator('[data-book-content-reorder-live]')).toContainText('moved to position 3 of 4');
    expect(reorderRequests).toHaveLength(1);

    await page.setViewportSize({ width: 375, height: 800 });
    await assertBookOrderLayout();
    await expect(page.locator('main#main-content')).toContainText('Save');
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/notes/books/${emptyBookId}`),
      page.getByRole('link', { name: 'Cancel', exact: true }).click(),
    ]);
    expect(reorderRequests).toHaveLength(1);
    expect(await outlineTopLevelTitles()).toEqual([chapterYTitle, pageATitle, chapterXTitle, pageBTitle]);
    for (const nestedPageTitle of nestedPageTitles) {
      await expect(page.locator('.book-outline')).toContainText(nestedPageTitle);
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

    const disclosure = page.locator('.notes-asset-picker-disclosure');
    await disclosure.locator('summary').click();
    const projectSearch = page.locator('#note-asset-picker-project-search');
    await projectSearch.fill('Browser Asset Picker');
    const projectResults = page.locator('#note-asset-picker-project-results');
    await expect(projectResults.locator('button')).toContainText(projectTitle);

    expect(
      [...diagnostics.requestedUrls].some((url) => new URL(url).pathname === '/notes/asset-picker/projects'),
    ).toBe(true);
    const assetSearch = page.locator('#note-asset-picker-asset-search');
    await expect(assetSearch).toBeDisabled();
    await projectResults.locator('button').first().click();
    await expect(assetSearch).toBeEnabled();
    await page.locator('#note-projects-form-trigger').click();
    await page.locator(`#note-project-option-${projectId}`).check();
    await expect(page.locator(`#note-project-option-${projectId}`)).toBeChecked();
    await page.locator('#note-projects-form-trigger').click();
    await expect.poll(() => assetRequests.length).toBe(1);
    const firstAssetRequest = new URL(assetRequests[0]);
    expect(firstAssetRequest.searchParams.get('projectId')).toBe(projectId);
    expect(firstAssetRequest.searchParams.get('q')).toBe('');
    expect(firstAssetRequest.searchParams.has('cursor')).toBe(false);

    const assetResults = page.locator('#note-asset-picker-asset-results');
    await expect(assetResults.locator('[data-asset-id]')).toHaveCount(25);
    const loadMore = page.getByRole('button', { name: 'Load more' });
    await expect(loadMore).toBeEnabled();

    await assetSearch.fill('path-needle');
    await expect(assetResults.locator('[data-asset-id]')).toHaveCount(1);
    await expect(assetResults).toContainText('path-target.txt');
    await expect(assetResults).toContainText('nested/path-needle');

    await assetSearch.fill('');
    await expect(assetResults.locator('[data-asset-id]')).toHaveCount(25);
    await expect(loadMore).toBeEnabled();
    await loadMore.click();
    await expect(assetResults.locator('[data-asset-id]')).toHaveCount(26);
    await expect(assetResults).toContainText('path-target.txt');
    await expect(loadMore).toBeDisabled();

    const firstCandidate = assetResults.locator('[data-asset-id]').first();
    const firstAssetId = await firstCandidate.getAttribute('data-asset-id');
    const firstFilename = await firstCandidate.locator('.notes-asset-picker-asset-filename').textContent();
    await firstCandidate.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(firstCandidate.getByRole('button', { name: 'Selected', exact: true })).toBeDisabled();
    await expect(page.locator('.notes-selected-asset')).toHaveCount(1);
    await expect(page.locator('.notes-selected-assets')).toContainText(firstFilename);

    const longAssetFilename = 'asset-01-this-is-a-deliberately-long-asset-filename-for-sidebar-wrapping-verification.txt';
    const secondCandidate = assetResults.locator('[data-asset-id]').filter({ hasText: longAssetFilename });
    const secondAssetId = await secondCandidate.getAttribute('data-asset-id');
    const secondFilename = await secondCandidate.locator('.notes-asset-picker-asset-filename').textContent();
    await secondCandidate.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(secondCandidate.getByRole('button', { name: 'Selected', exact: true })).toBeDisabled();
    await expect(page.locator('.notes-selected-asset')).toHaveCount(2);
    await expect(page.locator('.notes-selected-assets')).toContainText(secondFilename);

    await page.locator('.notes-selected-asset').filter({ hasText: firstFilename }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.notes-selected-asset')).toHaveCount(1);
    await expect(page.locator('.notes-selected-assets')).not.toContainText(firstFilename);
    await expect(secondCandidate.getByRole('button', { name: 'Selected', exact: true })).toBeDisabled();
    await expect(firstCandidate.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    await expect(page.locator(`#note-form input[name="assetIds[]"][value="${secondAssetId}"]`)).toBeChecked();
    await expect(page.locator(`#note-form input[name="assetIds[]"][value="${firstAssetId}"]`)).toHaveCount(0);

    await page.setViewportSize({ width: 375, height: 800 });
    const narrowConnections = await page.locator('.notes-connections').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll('input, button, select, [data-asset-id]')]
        .map((control) => control.getBoundingClientRect());
      return {
        cardRight: rect.right,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        controlsFit: controls.every((control) => control.right <= window.innerWidth + 1),
      };
    });
    expect(narrowConnections.cardRight).toBeLessThanOrEqual(narrowConnections.viewportWidth);
    expect(narrowConnections.documentWidth).toBeLessThanOrEqual(narrowConnections.viewportWidth);
    expect(narrowConnections.controlsFit).toBe(true);
    await expect(page.locator('.notes-selected-assets')).toContainText(longAssetFilename);
    await expect(page.locator('#note-asset-picker-project-search')).toBeVisible();
    await expect(page.locator('#note-asset-picker-asset-search')).toBeVisible();
    await expect(secondCandidate.getByRole('button', { name: 'Selected', exact: true })).toBeDisabled();

    await page.locator('#title').fill('Browser Picker Note');
    await Promise.all([
      page.waitForURL(/\/notes\/\d+$/),
      page.locator('button[type="submit"][form="note-form"]').click(),
    ]);
    const noteId = new URL(page.url()).pathname.split('/').at(-1);
    await expect(page.locator('.notes-detail-assets')).toContainText(secondFilename);
    await expect(page.locator('.notes-detail-assets')).not.toContainText(firstFilename);

    await page.getByRole('link', { name: 'Edit Page', exact: true }).click();
    await page.waitForURL(new RegExp(`/notes/${noteId}/edit$`));
    await expect(page.locator('#note-projects-form-trigger'))
      .toHaveAttribute('aria-label', `Projects: ${projectTitle}`);
    await expect(page.locator('#note-projects-form-trigger')).toContainText(projectTitle);
    await expect(page.locator('.notes-selected-asset')).toHaveCount(1);
    await expect(page.locator('.notes-selected-assets')).toContainText(secondFilename);
    await expect(page.locator(`#note-form input[name="assetIds[]"][value="${secondAssetId}"]`)).toBeChecked();

    const editDisclosure = page.locator('.notes-asset-picker-disclosure');
    await editDisclosure.locator('summary').click();
    await page.locator('#note-asset-picker-project-search').fill('Browser Asset Picker');
    await expect(page.locator('#note-asset-picker-project-results button')).toContainText(projectTitle);
    await page.locator('#note-asset-picker-project-results button').first().click();
    const editCandidate = page.locator(`#note-asset-picker-asset-results [data-asset-id="${secondAssetId}"]`);
    await expect(editCandidate.getByRole('button', { name: 'Selected', exact: true })).toBeDisabled();

    await page.locator('.notes-selected-asset').filter({ hasText: secondFilename }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.notes-selected-asset')).toHaveCount(0);
    await expect(page.locator('.notes-selected-assets-empty')).toBeVisible();
    await expect(editCandidate.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    await expect(page.locator('#note-form input[name="assetIds[]"][type="hidden"]')).toHaveCount(1);

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

      // Re-run the existing project-filter interaction after the reload. This
      // catches a broken document re-entry or duplicate initialization without
      // adding a test-only application marker.
      await exerciseProjectFilterEnhancement(page);
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
    await exerciseProjectFilterEnhancement(page);
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

    await page.goto(`${productionServer.baseURL}/notes/new`, { waitUntil: 'domcontentloaded' });
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
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await execFileAsync(pnpmCommand, ['build'], {
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

async function exerciseProjectFilterEnhancement(page) {
  const filter = page.locator('[data-asset-project-filter]');
  await expect(filter).toHaveCount(1);
  const summary = filter.locator('summary');
  await summary.focus();
  await summary.press('Enter');
  await filter.locator('input[data-asset-project-filter-search]').fill('creatorcrate-browser-smoke-no-match');
  await expect(filter.locator('[data-asset-project-filter-no-results]')).toBeVisible();
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
    page.locator('main#main-content button[type="submit"]').first().click(),
  ]);
  return new URL(page.url()).pathname.split('/').at(-1);
}

async function createBrowserChapter(page, baseURL, bookId, title) {
  const response = await page.goto(`${baseURL}/notes/books/${bookId}/chapters/new`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('#title').fill(title);
  await Promise.all([
    page.waitForURL(/\/notes\/chapters\/\d+$/),
    page.locator('main#main-content button[type="submit"]').first().click(),
  ]);
  return new URL(page.url()).pathname.split('/').at(-1);
}

async function createBrowserPage(page, baseURL, chapterId, title) {
  const response = await page.goto(`${baseURL}/notes/new?chapterId=${chapterId}`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('#title').fill(title);
  await Promise.all([
    page.waitForURL(/\/notes\/\d+$/),
    page.locator('button[type="submit"][form="note-form"]').click(),
  ]);
  return new URL(page.url()).pathname.split('/').at(-1);
}

async function createBrowserDirectPage(page, baseURL, bookId, title) {
  const response = await page.goto(`${baseURL}/notes/new?bookId=${bookId}`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('#title').fill(title);
  await Promise.all([
    page.waitForURL(/\/notes\/\d+$/),
    page.locator('button[type="submit"][form="note-form"]').click(),
  ]);
}

async function exerciseNotesEditor(page) {
  const editor = page.locator('[data-notes-editor-host] .toastui-editor-defaultUI');
  await expect(editor).toBeVisible();
  await expect(page.locator('#content')).toBeHidden();

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
  const desktopState = await workspace.evaluate((element) => {
    const context = element.querySelector('.notes-workspace-context')?.getBoundingClientRect();
    const editorArea = element.querySelector('.notes-workspace-editor')?.getBoundingClientRect();
    const connections = element.querySelector('.notes-connections')?.getBoundingClientRect();
    const sidebar = element.querySelector('.notes-page-sidebar')?.getBoundingClientRect();
    const editorBox = element.querySelector('.toastui-editor-defaultUI')?.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      display: style.display,
      columns: style.gridTemplateColumns,
      contextWidth: context?.width || 0,
      sidebarWidth: sidebar?.width || 0,
      editorWidth: editorArea?.width || 0,
      connectionsWidth: connections?.width || 0,
      editorHeight: editorBox?.height || 0,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(desktopState.display).toBe('grid');
  expect(desktopState.columns.split(' ').length).toBe(2);
  expect(desktopState.contextWidth).toBeCloseTo(desktopState.sidebarWidth, 0);
  expect(desktopState.connectionsWidth).toBeCloseTo(desktopState.sidebarWidth, 0);
  expect(desktopState.editorWidth).toBeGreaterThan(desktopState.sidebarWidth * 2);
  expect(desktopState.editorHeight).toBeGreaterThanOrEqual(16 * 16);
  expect(desktopState.editorHeight).toBeLessThan(desktopState.viewportHeight * 0.5);
  expect(desktopState.documentWidth).toBeLessThanOrEqual(desktopState.viewportWidth);

  await page.setViewportSize({ width: 640, height: 800 });
  const narrowState = await workspace.evaluate((element) => {
    const context = element.querySelector('.notes-workspace-context')?.getBoundingClientRect();
    const editorArea = element.querySelector('.notes-workspace-editor')?.getBoundingClientRect();
    const connections = element.querySelector('.notes-connections')?.getBoundingClientRect();
    return {
      columns: getComputedStyle(element).gridTemplateColumns,
      contextTop: context?.top || 0,
      editorTop: editorArea?.top || 0,
      connectionsTop: connections?.top || 0,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(narrowState.columns.split(' ').length).toBe(1);
  expect(narrowState.contextTop).toBeLessThan(narrowState.editorTop);
  expect(narrowState.editorTop).toBeLessThan(narrowState.connectionsTop);
  expect(narrowState.documentWidth).toBeLessThanOrEqual(narrowState.viewportWidth);
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

  await page.locator('#title').fill('Browser Notes Round Trip');
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
    await expect(page.locator('.notes-book-nav')).toHaveCount(1);
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
  expectedCurrentContainer,
}) {
  await expect(page.locator('h1.app-section-title')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Cancel', exact: true })).toHaveAttribute('href', cancelHref);
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
  await expect(page.locator('.notes-workspace-current-container')).toContainText(expectedCurrentContainer);
  await expect(page.locator('.notes-workspace-editor')).toBeVisible();
  await expect(page.locator('.notes-connections')).toContainText('Projects');
  await expect(page.locator('.notes-connections')).toContainText('Assets');
  await expect(page.locator('.notes-page-sidebar > .notes-workspace-secondary')).toHaveCount(1);
  await expect(page.locator('.notes-workspace-secondary .notes-workspace-kicker')).toHaveText('Page actions');
  await expect(page.locator('.notes-workspace-secondary')).not.toContainText('Secondary actions');
  await expect(page.locator('.notes-workspace-secondary h2')).toHaveCount(0);
  await expect(page.locator('[data-notes-asset-picker]')).toBeAttached();
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
  await expect(page.locator('#title')).toHaveValue(pageTitle);
}

async function assertWorkspaceDimensions(page, { editorRequired = false, actionsRequired = false } = {}) {
  if (editorRequired) {
    await expect(page.locator('[data-notes-editor-host] .toastui-editor-defaultUI')).toBeVisible();
  }

  const state = await page.locator('.notes-page-workspace-layout').evaluate((element) => {
    const workspace = element.querySelector('.notes-workspace');
    const editorHostWrapper = workspace?.querySelector('.notes-editor');
    const editorHost = workspace?.querySelector('.notes-editor-host');
    const editor = element.querySelector('.notes-workspace-editor')?.getBoundingClientRect();
    const editorSurface = workspace?.querySelector('.toastui-editor-defaultUI')?.getBoundingClientRect();
    const computed = (target) => target ? getComputedStyle(target) : null;
    const dimensions = (target) => {
      const box = target?.getBoundingClientRect();
      const style = computed(target);
      return {
        height: box?.height || 0,
        minHeight: style?.minHeight || '',
        computedHeight: style?.height || '',
        display: style?.display || '',
        flexGrow: style?.flexGrow || '',
        alignSelf: style?.alignSelf || '',
      };
    };
    const context = workspace?.querySelector('.notes-workspace-context')?.getBoundingClientRect();
    const connections = workspace?.querySelector('.notes-connections')?.getBoundingClientRect();
    const sidebar = workspace?.querySelector('.notes-page-sidebar')?.getBoundingClientRect();
    const actions = element.querySelector('.notes-workspace-secondary')?.getBoundingClientRect();
    const outerStyle = getComputedStyle(element);
    const workspaceStyle = workspace ? getComputedStyle(workspace) : null;
    return {
      outerColumns: outerStyle.gridTemplateColumns,
      columns: workspaceStyle?.gridTemplateColumns || '',
      editorWidth: editor?.width || 0,
      editorHeight: editorSurface?.height || 0,
      contextTop: context?.top || 0,
      contextWidth: context?.width || 0,
      editorTop: editor?.top || 0,
      connectionsTop: connections?.top || 0,
      connectionsWidth: connections?.width || 0,
      sidebarWidth: sidebar?.width || 0,
      actionsTop: actions?.top || 0,
      actionsLeft: actions?.left || 0,
      actionsWidth: actions?.width || 0,
      actionsBottom: actions?.bottom || 0,
      editorLeft: editor?.left || 0,
      editorBottom: editor?.bottom || 0,
      editorHostWrapper: dimensions(editorHostWrapper),
      editorHost: dimensions(editorHost),
      editorRoot: dimensions(workspace?.querySelector('.toastui-editor-defaultUI')),
      toolbar: dimensions(workspace?.querySelector('.toastui-editor-defaultUI-toolbar')),
      main: dimensions(workspace?.querySelector('.toastui-editor-main')),
      mainContainer: dimensions(workspace?.querySelector('.toastui-editor-main-container')),
      wwContainer: dimensions(workspace?.querySelector('.toastui-editor-ww-container')),
      contents: dimensions(workspace?.querySelector('.toastui-editor-ww-container .toastui-editor-contents')),
      modeSwitch: dimensions(workspace?.querySelector('.toastui-editor-mode-switch')),
      status: dimensions(workspace?.querySelector('.toastui-editor-md-tab-container, .toastui-editor-md-preview')),
      writingSurface: dimensions(workspace?.querySelector('.toastui-editor-ww-container, .toastui-editor-md-container')),
      editorVariable: computed(workspace)?.getPropertyValue('--notes-editor-min-height').trim() || '',
      path: window.location.pathname,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(state.documentWidth).toBeLessThanOrEqual(state.viewportWidth);
  expect(state.editorWidth).toBeGreaterThan(0);
  expect(state.editorHeight).toBeGreaterThanOrEqual(16 * 16);
  expect(state.editorHostWrapper.height).toBeCloseTo(state.editorHeight, 0);
  expect(state.editorHost.height).toBeCloseTo(state.editorHeight, 0);
  expect(state.editorRoot.height).toBeCloseTo(state.editorHeight, 0);
  expect(state.main.height).toBeGreaterThan(200);
  expect(state.toolbar.height).toBeGreaterThan(0);
  expect(state.modeSwitch.height).toBeGreaterThan(0);
  if (actionsRequired) {
    const sidebarWidth = state.sidebarWidth || state.connectionsWidth || state.contextWidth;
    expect(state.actionsWidth).toBeCloseTo(sidebarWidth, 0);
  }
  if (state.viewportWidth <= 1023) {
    expect(state.outerColumns.split(' ').length).toBe(1);
    expect(state.columns.split(' ').length).toBe(1);
    expect(state.contextTop).toBeLessThan(state.editorTop);
    expect(state.editorTop).toBeLessThan(state.connectionsTop);
    if (actionsRequired) expect(state.connectionsTop).toBeLessThan(state.actionsTop);
  } else {
    expect(state.outerColumns.split(' ').length).toBe(2);
    expect(state.columns.split(' ').length).toBe(2);
    expect(state.contextWidth).toBeCloseTo(state.sidebarWidth, 0);
    expect(state.connectionsWidth).toBeCloseTo(state.sidebarWidth, 0);
    if (actionsRequired) expect(state.connectionsTop).toBeLessThan(state.actionsTop);
    expect(state.sidebarWidth).toBeGreaterThanOrEqual(12 * 16);
    expect(state.sidebarWidth).toBeLessThanOrEqual(16 * 16);
    expect(state.editorWidth).toBeGreaterThan(state.sidebarWidth * 2);
  }
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
