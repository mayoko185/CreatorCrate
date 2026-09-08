import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

const oldDialogWidth = viewportWidth => (viewportWidth <= 540
  ? viewportWidth - 16
  : Math.min(51 * 16, viewportWidth - 32));

test('Book hierarchy dialog has narrow, distinct and precise responsive drag feedback', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-order-responsive-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({
      title: 'A long Book title with ordinary words and UnbrokenBookSegment0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    });
    const chapters = [];
    const chapterPages = [];
    const rootPages = [];
    for (let chapterIndex = 0; chapterIndex < 5; chapterIndex += 1) {
      const chapter = app.locals.chapterService.createChapter({
        bookId: book.id,
        title: `Chapter ${chapterIndex + 1} with a long title and UnbrokenChapterSegment0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ${chapterIndex}`,
      });
      chapters.push(chapter);
      const pages = [];
      if (chapterIndex !== 2) {
        for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
          pages.push(app.locals.noteService.createNote({
            chapterId: chapter.id,
            title: `Page ${pageIndex + 1} with a long title and UnbrokenPageSegment0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ${chapterIndex}${pageIndex}`,
          }));
        }
      }
      chapterPages.push(pages);
      if (chapterIndex < 4) {
        rootPages.push(app.locals.noteService.createNote({
          bookId: book.id,
          title: `Root Page ${chapterIndex + 1} with a long title and UnbrokenRootSegment0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ${chapterIndex}`,
        }));
      }
    }
    const emptyChapter = chapters[2];
    const loadedHierarchy = app.locals.noteService.getBookHierarchy(book.id);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    const failedRequests = [];
    const posts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('requestfailed', request => failedRequests.push(request.url()));
    page.on('request', request => { if (request.method() === 'POST') posts.push(request); });

    const dialog = page.locator('#book-order-dialog');
    const hierarchyInput = dialog.locator('[data-book-hierarchy-input]');
    const rootContainer = dialog.locator('[data-book-hierarchy-container="root"]');
    const item = key => dialog.locator(`[data-content-key="${key}"]`).first();
    const cardSurface = key => item(key).locator(':scope > .notes-book-content-copy');
    const open = async (width) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${base}/notes/books/${book.id}`);
      await page.getByRole('link', { name: 'Change order', exact: true }).click();
      await expect(dialog).toBeVisible();
    };
    const domHierarchy = () => rootContainer.evaluate(rootNode => (
      [...rootNode.querySelectorAll(':scope > [data-book-hierarchy-item]')].map(node => {
        const [type, rawId] = node.dataset.contentKey.split(':');
        const id = Number(rawId);
        if (type === 'page') return { type, id };
        return {
          type,
          id,
          pages: [...node.querySelectorAll(`:scope > .notes-book-content-copy > [data-book-hierarchy-container="chapter:${id}"] > [data-book-hierarchy-item]`)]
            .map(pageNode => Number(pageNode.dataset.contentKey.split(':')[1])),
        };
      })
    ));
    const expectResponsiveGeometry = async (width) => {
      const geometry = await dialog.evaluate(node => {
        const box = (element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
        };
        const body = node.querySelector('.app-dialog-body');
        const footer = node.querySelector('.app-dialog-footer');
        const card = node.querySelector('.app-dialog-card');
        const rootNode = node.querySelector('[data-book-hierarchy-container="root"]');
        const editor = node.querySelector('[data-book-hierarchy-editor]');
        const controls = [...node.querySelectorAll('[data-book-hierarchy-handle], .app-dialog-close, .app-dialog-footer button')];
        const titles = [...node.querySelectorAll('.notes-book-content-title')];
        const cardBox = box(card);
        return {
          documentWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          dialog: box(node),
          body: { ...box(body), clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, overflowY: getComputedStyle(body).overflowY },
          footer: box(footer),
          rootWidths: [rootNode.clientWidth, rootNode.scrollWidth],
          sectionWidths: [editor.clientWidth, editor.scrollWidth],
          controlsContained: controls.every((control) => {
            const rect = control.getBoundingClientRect();
            return rect.left >= cardBox.left && rect.right <= cardBox.right;
          }),
          titlesContained: titles.every(title => title.scrollWidth <= title.clientWidth),
          wrappedTitle: titles.some((title) => {
            const style = getComputedStyle(title);
            return title.getBoundingClientRect().height > Number.parseFloat(style.lineHeight) + 1;
          }),
        };
      });
      expect(geometry.documentWidth).toBe(width);
      expect(geometry.documentScrollWidth).toBe(width);
      expect(geometry.dialog.width).toBeLessThanOrEqual((oldDialogWidth(width) * 0.67) + 1);
      expect(geometry.dialog.left).toBeGreaterThanOrEqual(0);
      expect(geometry.dialog.right).toBeLessThanOrEqual(width);
      expect(geometry.rootWidths[1]).toBeLessThanOrEqual(geometry.rootWidths[0]);
      expect(geometry.sectionWidths[1]).toBeLessThanOrEqual(geometry.sectionWidths[0]);
      expect(geometry.controlsContained).toBe(true);
      expect(geometry.titlesContained).toBe(true);
      expect(geometry.wrappedTitle).toBe(true);
      expect(geometry.body.overflowY).toBe('auto');
      expect(geometry.body.scrollHeight).toBeGreaterThan(geometry.body.clientHeight);
      expect(geometry.footer.top).toBeGreaterThanOrEqual(geometry.body.bottom);
      expect(geometry.footer.bottom).toBeLessThanOrEqual(700);
      await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Close Change order', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await expect(dialog.locator('[data-book-hierarchy-destination], [data-book-hierarchy-move], .notes-book-hierarchy-move-controls')).toHaveCount(0);
      await expect(dialog.locator('.notes-book-content-title a')).toHaveCount(0);
      await expect(dialog.locator(`[data-book-hierarchy-container="chapter:${emptyChapter.id}"]`)).toHaveCSS('min-height', '40px');
      await expect(dialog.locator('[data-book-hierarchy-live]')).toHaveCount(1);
      await expect(dialog.locator('ol[data-book-hierarchy-container]')).toHaveCount(chapters.length + 1);
      expect(await dialog.locator('[id]').evaluateAll(nodes => new Set(nodes.map(node => node.id)).size === nodes.length)).toBe(true);
    };
    const expectRestored = async () => {
      expect(await domHierarchy()).toEqual(loadedHierarchy);
      const payload = JSON.parse(await hierarchyInput.inputValue());
      expect(payload.expected).toEqual(loadedHierarchy);
      expect(payload.target).toEqual(loadedHierarchy);
    };
    const transientIndicators = dialog.locator('.is-drop-before, .is-drop-after, .is-drop-empty, [data-drop-position]');
    const expectIndicatorsCleared = async () => {
      await expect(transientIndicators).toHaveCount(0);
      await expect(dialog.locator('.is-drop-target')).toHaveCount(0);
    };
    const beginNativeDrag = async (source, target, targetPosition) => {
      await source.scrollIntoViewIfNeeded();
      const sourceBox = await source.boundingBox();
      const targetBox = await target.boundingBox();
      expect(sourceBox).not.toBeNull();
      expect(targetBox).not.toBeNull();
      const sourcePoint = { x: sourceBox.x + (sourceBox.width / 2), y: sourceBox.y + (sourceBox.height / 2) };
      const targetPoint = { x: targetBox.x + targetPosition.x, y: targetBox.y + targetPosition.y };
      await page.mouse.move(sourcePoint.x, sourcePoint.y);
      await page.mouse.down();
      await page.mouse.move(sourcePoint.x + 6, sourcePoint.y + 6, { steps: 3 });
      await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
      // Chromium starts the native drag from the card surface, but stationary
      // mouse input is not guaranteed to emit a final dragover in headless mode.
      await target.dispatchEvent('dragover', { clientY: targetPoint.y });
    };
    const background = locator => locator.evaluate(node => getComputedStyle(node).backgroundColor);

    for (const width of [1280, 600, 390, 375]) {
      await open(width);
      await expectResponsiveGeometry(width);
    }
    await page.keyboard.press('Tab');
    await expect(dialog.locator('[data-book-hierarchy-handle]').first()).toBeFocused();
    await expect(dialog.locator('[data-book-hierarchy-handle]').first()).toHaveCSS('outline-style', 'solid');
    await dialog.getByRole('button', { name: 'Close Change order', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(posts).toHaveLength(0);

    await open(900);
    const nestedPage = item(`page:${chapterPages[0][0].id}`);
    const parentChapter = item(`chapter:${chapters[0].id}`);
    const rootPage = item(`page:${rootPages[0].id}`);
    await nestedPage.hover();
    const nestedHover = await background(nestedPage);
    expect(nestedHover).not.toBe(await background(parentChapter));
    await rootPage.hover();
    expect(nestedHover).not.toBe(await background(rootPage));

    const editorBackground = await background(dialog.locator('[data-book-hierarchy-editor]'));
    const rootBackground = await background(rootContainer);
    const beforeTarget = item(`page:${chapterPages[0][1].id}`);
    const beforeBox = await beforeTarget.boundingBox();
    await beginNativeDrag(cardSurface(`page:${chapterPages[0][0].id}`), beforeTarget, { x: beforeBox.width / 2, y: 2 });
    await expect(beforeTarget).toHaveClass(/is-drop-before/);
    await expect(dialog.locator('.is-drop-before')).toHaveCount(1);
    expect(await beforeTarget.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
    await expect(item(`page:${chapterPages[0][0].id}`)).toHaveCSS('opacity', '0.78');
    expect(await background(dialog.locator('[data-book-hierarchy-editor]'))).toBe(editorBackground);
    expect(await background(rootContainer)).toBe(rootBackground);
    await expect(dialog.locator('.is-drop-target')).toHaveCount(0);
    await page.mouse.up();
    await expectIndicatorsCleared();

    const afterBox = await beforeTarget.boundingBox();
    await beginNativeDrag(cardSurface(`page:${chapterPages[0][0].id}`), beforeTarget, { x: afterBox.width / 2, y: afterBox.height - 2 });
    await expect(beforeTarget).toHaveClass(/is-drop-after/);
    await expect(dialog.locator('.is-drop-after')).toHaveCount(1);
    expect(await beforeTarget.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
    await page.mouse.up();
    await expectIndicatorsCleared();

    const populatedChapter = dialog.locator(`[data-book-hierarchy-container="chapter:${chapters[0].id}"]`);
    await populatedChapter.scrollIntoViewIfNeeded();
    const populatedBox = await populatedChapter.boundingBox();
    await beginNativeDrag(cardSurface(`page:${chapterPages[0][0].id}`), populatedChapter, { x: 1, y: populatedBox.height - 1 });
    const finalChapterPage = populatedChapter.locator(':scope > [data-book-hierarchy-item]').last();
    await expect(finalChapterPage).toHaveAttribute('data-drop-position', 'append');
    await expect(finalChapterPage).toHaveClass(/is-drop-after/);
    await expect(dialog.locator('[data-drop-position="append"]')).toHaveCount(1);
    await page.mouse.up();
    await expectIndicatorsCleared();

    const emptyContainer = dialog.locator(`[data-book-hierarchy-container="chapter:${emptyChapter.id}"]`);
    await emptyContainer.scrollIntoViewIfNeeded();
    const emptyBackground = await background(emptyContainer);
    const emptyBox = await emptyContainer.boundingBox();
    await beginNativeDrag(cardSurface(`page:${rootPages[2].id}`), emptyContainer, { x: emptyBox.width / 2, y: emptyBox.height / 2 });
    await expect(emptyContainer).toHaveClass(/is-drop-empty/);
    await expect(emptyContainer).toHaveAttribute('data-drop-position', 'empty');
    await expect(emptyContainer).toHaveCSS('outline-style', 'dashed');
    expect(await background(emptyContainer)).toBe(emptyBackground);
    await expect(dialog.locator('.is-drop-target')).toHaveCount(0);
    await page.mouse.up();
    await expectIndicatorsCleared();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(posts).toHaveLength(0);

    await page.getByRole('link', { name: 'Change order', exact: true }).click();
    await expectRestored();
    await expectIndicatorsCleared();
    await cardSurface(`page:${rootPages[2].id}`).dragTo(emptyContainer);
    await expect(emptyContainer.locator(':scope > [data-book-hierarchy-item]')).toHaveCount(1);
    const reparentedPage = item(`page:${rootPages[2].id}`);
    await reparentedPage.hover();
    expect(await background(reparentedPage)).not.toBe(await background(item(`chapter:${emptyChapter.id}`)));
    await expectIndicatorsCleared();

    const submittedTarget = JSON.parse(await hierarchyInput.inputValue()).target;
    const response = page.waitForResponse(candidate => candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/notes/books/${book.id}/hierarchy/reorder`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await response).status()).toBe(302);
    await expect(page).toHaveURL(`${base}/notes/books/${book.id}`);
    expect(posts).toHaveLength(1);
    const payload = JSON.parse(new URLSearchParams(posts[0].postData()).get('hierarchy'));
    expect(payload.expected).toEqual(loadedHierarchy);
    expect(payload.target).toEqual(submittedTarget);
    expect(app.locals.noteService.getBookHierarchy(book.id)).toEqual(submittedTarget);
    expect(errors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
