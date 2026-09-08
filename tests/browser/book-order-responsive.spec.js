import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

test('Book hierarchy remains contained, scrollable and operable at narrow widths', async ({ page }) => {
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
    const rootPages = [];
    for (let chapterIndex = 0; chapterIndex < 5; chapterIndex += 1) {
      const chapter = app.locals.chapterService.createChapter({
        bookId: book.id,
        title: `Chapter ${chapterIndex + 1} with a long title and UnbrokenChapterSegment0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ${chapterIndex}`,
      });
      chapters.push(chapter);
      if (chapterIndex !== 2) {
        for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
          app.locals.noteService.createNote({
            chapterId: chapter.id,
            title: `Page ${pageIndex + 1} with a long title and UnbrokenPageSegment0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ${chapterIndex}${pageIndex}`,
          });
        }
      }
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
    const handle = key => item(key).locator(':scope > [data-book-hierarchy-handle]');
    const destination = key => item(key).locator('[data-book-hierarchy-destination]');
    const move = key => item(key).locator('[data-book-hierarchy-move]');
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
        const box = element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const body = node.querySelector('.app-dialog-body');
        const footer = node.querySelector('.app-dialog-footer');
        const card = node.querySelector('.app-dialog-card');
        const controls = [...node.querySelectorAll('[data-book-hierarchy-handle], [data-book-hierarchy-destination], [data-book-hierarchy-move], .app-dialog-close, .app-dialog-footer button')];
        const cardBox = box(card);
        return {
          documentWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          dialog: box(node),
          body: { ...box(body), clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, overflowY: getComputedStyle(body).overflowY },
          footer: box(footer),
          rootWidths: [node.querySelector('[data-book-hierarchy-container="root"]').clientWidth, node.querySelector('[data-book-hierarchy-container="root"]').scrollWidth],
          sectionWidths: [node.querySelector('[data-book-hierarchy-editor]').clientWidth, node.querySelector('[data-book-hierarchy-editor]').scrollWidth],
          controlsContained: controls.every(control => {
            const rect = control.getBoundingClientRect();
            return rect.left >= cardBox.left && rect.right <= cardBox.right;
          }),
        };
      });
      expect(geometry.documentWidth).toBe(width);
      expect(geometry.documentScrollWidth).toBe(width);
      expect(geometry.dialog.left).toBeGreaterThanOrEqual(0);
      expect(geometry.dialog.right).toBeLessThanOrEqual(width);
      expect(geometry.rootWidths[1]).toBeLessThanOrEqual(geometry.rootWidths[0]);
      expect(geometry.sectionWidths[1]).toBeLessThanOrEqual(geometry.sectionWidths[0]);
      expect(geometry.controlsContained).toBe(true);
      expect(geometry.body.overflowY).toBe('auto');
      expect(geometry.body.scrollHeight).toBeGreaterThan(geometry.body.clientHeight);
      expect(geometry.footer.top).toBeGreaterThanOrEqual(geometry.body.bottom);
      expect(geometry.footer.bottom).toBeLessThanOrEqual(700);
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Close Change order', exact: true })).toBeVisible();
      await expect(dialog.locator(`[data-book-hierarchy-container="chapter:${emptyChapter.id}"]`)).toHaveCSS('min-height', '40px');
      await expect(destination(`page:${rootPages[0].id}`).locator('option')).toHaveCount(chapters.length + 1);
      await expect(dialog.locator('[data-book-hierarchy-live]')).toHaveCount(1);
      await expect(dialog.locator('[data-book-hierarchy-destination]')).toHaveCount(16);
      await expect(dialog.locator('[data-book-hierarchy-move]')).toHaveCount(16);
      await expect(dialog.locator('ol[data-book-hierarchy-container]')).toHaveCount(chapters.length + 1);
      expect(await dialog.locator('[id]').evaluateAll(nodes => new Set(nodes.map(node => node.id)).size === nodes.length)).toBe(true);
      const footerButtons = await dialog.locator('.app-dialog-footer button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().left));
      expect(footerButtons[0]).toBeLessThan(footerButtons[1]);
    };
    const expectRestored = async () => {
      expect(await domHierarchy()).toEqual(loadedHierarchy);
      const payload = JSON.parse(await hierarchyInput.inputValue());
      expect(payload.expected).toEqual(loadedHierarchy);
      expect(payload.target).toEqual(loadedHierarchy);
    };

    await open(390);
    await expectResponsiveGeometry(390);
    const dragSource = handle(`page:${rootPages[2].id}`);
    const emptyContainer = dialog.locator(`[data-book-hierarchy-container="chapter:${emptyChapter.id}"]`);
    await emptyContainer.scrollIntoViewIfNeeded();
    await dragSource.dragTo(emptyContainer, { targetPosition: { x: 24, y: 20 } });
    await expect(emptyContainer.locator(':scope > [data-book-hierarchy-item]')).toHaveCount(1);
    await expectResponsiveGeometry(390);
    expect(JSON.parse(await hierarchyInput.inputValue()).target).not.toEqual(loadedHierarchy);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(posts).toHaveLength(0);

    await page.getByRole('link', { name: 'Change order', exact: true }).click();
    await expectRestored();
    await destination(`page:${rootPages[0].id}`).selectOption(`chapter:${chapters[0].id}`);
    await move(`page:${rootPages[0].id}`).click();
    await expect(handle(`page:${rootPages[0].id}`)).toBeFocused();
    await handle(`page:${rootPages[0].id}`).press('Home');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(posts).toHaveLength(0);

    await open(375);
    await expectResponsiveGeometry(375);
    await expectRestored();
    await item(`page:${rootPages[0].id}`).getByRole('link').focus();
    await page.keyboard.press('Tab');
    await expect(destination(`page:${rootPages[0].id}`)).toBeFocused();
    expect(await destination(`page:${rootPages[0].id}`).evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Tab');
    await expect(move(`page:${rootPages[0].id}`)).toBeFocused();
    await expect(move(`page:${rootPages[0].id}`)).toHaveCSS('outline-style', 'solid');
    await handle(`chapter:${chapters[0].id}`).focus();
    await handle(`chapter:${chapters[0].id}`).press('Home');
    await expect(handle(`chapter:${chapters[0].id}`)).toBeFocused();
    await expect(handle(`chapter:${chapters[0].id}`)).toHaveCSS('outline-style', 'solid');
    await destination(`page:${rootPages[0].id}`).selectOption(`chapter:${chapters[0].id}`);
    await move(`page:${rootPages[0].id}`).click();
    await dialog.getByRole('button', { name: 'Close Change order', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(posts).toHaveLength(0);

    await page.getByRole('link', { name: 'Change order', exact: true }).click();
    await expectRestored();
    await destination(`page:${rootPages[0].id}`).selectOption(`chapter:${chapters[0].id}`);
    await move(`page:${rootPages[0].id}`).click();
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
    await page.getByRole('link', { name: 'Change order', exact: true }).click();
    expect(await domHierarchy()).toEqual(submittedTarget);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
