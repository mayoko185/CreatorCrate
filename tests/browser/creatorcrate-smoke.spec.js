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

  test('mounts the real Notes editor, persists Markdown, and rehydrates it on edit', async ({ page, devServer }) => {
    const diagnostics = observeBrowser(page, devServer.baseURL);

    await page.goto(`${devServer.baseURL}/notes/new`, { waitUntil: 'domcontentloaded' });
    await exerciseNotesEditor(page);

    expect(getToastUiRequests(diagnostics).length).toBeGreaterThan(0);
    expect(getLegacyToastUiRequests(diagnostics)).toEqual([]);
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

async function exerciseNotesEditor(page) {
  const editor = page.locator('[data-notes-editor-host] .toastui-editor-defaultUI');
  await expect(editor).toBeVisible();
  await expect(page.locator('#content')).toBeHidden();

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
  await replaceNotesEditorText(page, wysiwygSurface, ['WYSIWYG-authored paragraph']);

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

    const detailPath = new URL(page.url()).pathname;
    await page.goto(`${page.url()}/edit`, { waitUntil: 'domcontentloaded' });
    await expect(editor).toBeVisible();
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
