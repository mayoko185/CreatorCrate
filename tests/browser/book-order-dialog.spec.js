import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

for (const kind of ['books', 'contents', 'pages']) {
 test(`${kind}: hosted order lifecycle, native persistence and validation`, async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-order-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Alpha' });
    const directPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page' });
    const chapterPageA = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Page Alpha' });
    const chapterPageB = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Page Beta' });
    const chapterB = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Beta' });
    const chapterBPage = app.locals.noteService.createNote({ chapterId: chapterB.id, title: 'Page Gamma' });
    const emptyChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Empty Chapter' });
    const directPageB = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page Two' });
    const directPageC = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page Three' });
    const config = {
      books: { host: '/notes', direct: '/notes/books/order', id: 'books-order-dialog', input: 'orderedBookIds', handle: 'data-book-reorder-handle', item: 'data-book-reorder-item', read: () => app.locals.bookService.listBooks().map(x => String(x.id)), peers: ['New Book'], redirect: '/notes?notice=book_reordered' },
      contents: { host: `/notes/books/${book.id}`, direct: `/notes/books/${book.id}/order`, id: 'book-order-dialog', input: 'hierarchy', read: () => app.locals.noteService.getBookHierarchy(book.id), peers: ['Edit Book', 'New Chapter'] },
      pages: { host: `/notes/chapters/${chapter.id}`, direct: `/notes/chapters/${chapter.id}/notes/order`, id: 'chapter-order-dialog', input: 'orderedNoteIds', handle: 'data-chapter-page-reorder-handle', item: 'data-chapter-page-reorder-item', read: () => app.locals.noteService.listNotesForChapter(chapter.id).map(x => String(x.id)), peers: ['Edit Chapter'] },
    }[kind];
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const errors = [], posts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') posts.push(request); });
    await page.goto(base + config.host);
    const openerLabel = { books: 'Change book order', contents: 'Reorder book contents', pages: 'Change order' }[kind];
    const closeLabel = { books: 'Close Change book order', contents: 'Close Reorder book contents', pages: 'Close Change order' }[kind];
    const opener = page.getByRole('link', { name: openerLabel, exact: true });
    const dialog = page.locator('#' + config.id);
    const input = dialog.locator(`[name="${config.input}"]`);

    if (kind === 'contents') {
      await page.setViewportSize({ width: 1280, height: 1600 });
      await expect(opener).toHaveCount(1);
      await expect(opener).toHaveAttribute('href', config.direct);
      await opener.click();
      expect(await dialog.evaluate(node => node.matches(':modal'))).toBe(true);
      await expect(page.locator('body')).toHaveClass(/app-dialog-open/);
      const structure = await dialog.locator('[data-notes-book-order-page]').evaluate(section => {
        const heading = section.querySelector(':scope > #notes-book-order-heading');
        const body = section.querySelector(':scope > .project-edit-dialog-section-body');
        const rowHeading = body?.querySelector('.notes-book-content-title');
        const sectionStyle = getComputedStyle(section);
        const bodyStyle = getComputedStyle(body);
        const rowHeadingStyle = getComputedStyle(rowHeading);
        return {
          directChildren: [heading?.tagName, body?.className],
          hasSettingsSectionClass: section.classList.contains('settings-section'),
          borderWidths: [
            sectionStyle.borderTopWidth,
            sectionStyle.borderRightWidth,
            sectionStyle.borderBottomWidth,
            sectionStyle.borderLeftWidth,
          ],
          bodyPadding: [bodyStyle.paddingTop, bodyStyle.paddingRight, bodyStyle.paddingBottom, bodyStyle.paddingLeft],
          headingPadding: getComputedStyle(heading).padding,
          headingSize: getComputedStyle(heading).fontSize,
          headingTransform: getComputedStyle(heading).textTransform,
          footerOutsideBody: !body.contains(section.closest('form').querySelector('footer')),
          rowHeadingPadding: [rowHeadingStyle.paddingTop, rowHeadingStyle.paddingRight, rowHeadingStyle.paddingBottom, rowHeadingStyle.paddingLeft],
        };
      });
      expect(structure.directChildren).toEqual(['H3', 'project-edit-dialog-section-body']);
      expect(structure.hasSettingsSectionClass).toBe(false);
      expect(structure.borderWidths).toEqual(['1px', '1px', '1px', '1px']);
      expect(structure.bodyPadding.every(value => value !== '0px')).toBe(true);
      expect(structure.headingPadding).toBe('8px 12px');
      expect(structure.headingSize).toBe('12px');
      expect(structure.headingTransform).toBe('uppercase');
      expect(structure.footerOutsideBody).toBe(true);
      expect(structure.rowHeadingPadding).toEqual(['0px', '0px', '0px', '0px']);

      const form = dialog.locator('#notes-book-order-form');
      await expect(form).toHaveAttribute('action', `/notes/books/${book.id}/hierarchy/reorder`);
      await expect(form).toHaveAttribute('data-book-hierarchy-form', '');
      await expect(dialog.locator('[name="hierarchy"]')).toHaveCount(1);
      await expect(dialog.locator('[name="orderedItems"]')).toHaveCount(0);
      await expect(dialog.locator('[data-book-content-reorder-handle]')).toHaveCount(0);
      await expect(dialog.locator('[data-book-hierarchy-handle]')).toHaveCount(9);
      await expect(dialog.locator('[draggable="true"]')).toHaveCount(9);

      const hierarchyInput = dialog.locator('[name="hierarchy"]');
      const initialValue = await hierarchyInput.inputValue();
      const initialHierarchy = JSON.parse(initialValue);
      const renderedHierarchy = [
        { type: 'chapter', id: chapter.id, pages: [chapterPageA.id, chapterPageB.id] },
        { type: 'page', id: directPage.id },
        { type: 'chapter', id: chapterB.id, pages: [chapterBPage.id] },
        { type: 'chapter', id: emptyChapter.id, pages: [] },
        { type: 'page', id: directPageB.id },
        { type: 'page', id: directPageC.id },
      ];
      expect(initialHierarchy).toEqual({
        version: 1,
        expected: renderedHierarchy,
        target: renderedHierarchy,
      });

      const rootItems = dialog.locator('[data-book-hierarchy-container="root"] > [data-book-hierarchy-item]');
      await expect(rootItems).toHaveCount(6);
      await expect(rootItems.nth(0)).toContainText('Chapter Alpha');
      await expect(rootItems.nth(1)).toContainText('Direct Page');
      const chapterPages = dialog.locator(`[data-book-hierarchy-container="chapter:${chapter.id}"] > [data-book-hierarchy-item]`);
      await expect(chapterPages).toHaveCount(2);
      await expect(chapterPages.nth(0)).toContainText('Page Alpha');
      await expect(chapterPages.nth(1)).toContainText('Page Beta');
      const emptyPages = dialog.locator(`[data-book-hierarchy-container="chapter:${emptyChapter.id}"]`);
      await expect(emptyPages).toHaveCount(1);
      await expect(emptyPages).toHaveCSS('min-height', '40px');

      const item = (key) => dialog.locator(`[data-content-key="${key}"]`).first();
      const handle = (key) => item(key).locator(':scope > [data-book-hierarchy-handle]');
      const title = (key) => item(key).locator(':scope > .notes-book-content-copy > .notes-book-content-title');
      const container = (key) => dialog.locator(`[data-book-hierarchy-container="${key}"]`);
      const live = dialog.locator('[data-book-hierarchy-live]');
      const status = dialog.locator('[data-book-hierarchy-status]');
      const dragToEnd = async (source, destination, { proveIndicator = false } = {}) => {
        const children = destination.locator(':scope > [data-book-hierarchy-item]');
        const target = await children.count() > 0 ? children.last() : destination;
        await source.scrollIntoViewIfNeeded();
        await target.scrollIntoViewIfNeeded();
        const from = await source.boundingBox();
        const to = await target.boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, { steps: 4 });
        await page.mouse.move(to.x + 8, to.y + to.height - 3, { steps: 12 });
        if (proveIndicator) {
          await target.dispatchEvent('dragover', { clientY: to.y + to.height - 3 });
          if (await children.count() > 0) await expect(target).toHaveClass(/is-drop-after/);
          else await expect(destination).toHaveClass(/is-drop-empty/);
        }
        await page.mouse.up();
      };
      const dragBefore = async (source, target) => {
        await source.scrollIntoViewIfNeeded();
        await target.scrollIntoViewIfNeeded();
        const from = await source.boundingBox();
        const to = await target.boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, { steps: 4 });
        await page.mouse.move(to.x + 4, to.y + 2, { steps: 12 });
        await page.mouse.up();
      };
      const domHierarchy = () => container('root').evaluate((root) => (
        [...root.querySelectorAll(':scope > [data-book-hierarchy-item]')].map((node) => {
          const [type, rawId] = node.dataset.contentKey.split(':');
          const id = Number(rawId);
          if (type === 'page') return { type, id };
          const pages = [...node.querySelectorAll(`:scope > .notes-book-content-copy > [data-book-hierarchy-container="chapter:${id}"] > [data-book-hierarchy-item]`)]
            .map((pageNode) => Number(pageNode.dataset.contentKey.split(':')[1]));
          return { type, id, pages };
        })
      ));
      const expectDraft = async (target) => {
        await expect(status).toHaveText('Book hierarchy saved.');
        expect(await domHierarchy()).toEqual(target);
        const payload = JSON.parse(await hierarchyInput.inputValue());
        expect(payload.expected).toEqual(target);
        expect(payload.target).toEqual(target);
      };
      const persistencePosts = () => posts.filter((request) => {
        const pathname = new URL(request.url()).pathname;
        return pathname.includes('/hierarchy/reorder')
          || pathname.includes('/move')
          || pathname.includes('/notes/reorder')
          || pathname.includes('/contents/reorder');
      });

      await expect(dialog.getByRole('heading', { name: 'Book hierarchy', exact: true })).toBeVisible();
      await expect(dialog.getByText('Changes are saved immediately.', { exact: false })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      await expect(dialog.locator('[data-book-hierarchy-destination]')).toHaveCount(0);
      await expect(dialog.locator('[data-book-hierarchy-move]')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await expect(title(`page:${directPage.id}`)).toHaveText(directPage.title);
      await expect(title(`chapter:${chapter.id}`)).toHaveText(chapter.title);
      await expect(title(`page:${chapterPageA.id}`)).toHaveText(chapterPageA.title);
      await expect(dialog.locator('.notes-book-content-title a')).toHaveCount(0);

      let target = [
        { type: 'chapter', id: chapter.id, pages: [chapterPageA.id, chapterPageB.id, directPage.id] },
        { type: 'chapter', id: chapterB.id, pages: [chapterBPage.id] },
        { type: 'chapter', id: emptyChapter.id, pages: [] },
        { type: 'page', id: directPageB.id },
        { type: 'page', id: directPageC.id },
      ];
      await dragToEnd(title(`page:${directPage.id}`), container(`chapter:${chapter.id}`), { proveIndicator: true });
      await expectDraft(target);
      await expect(dialog).toBeVisible();
      await handle(`page:${directPage.id}`).press('Home');
      target[0].pages = [directPage.id, chapterPageA.id, chapterPageB.id];
      await expect(handle(`page:${directPage.id}`)).toBeFocused();
      await expect(live).toContainText(`Page “${directPage.title}” moved to Chapter “${chapter.title}”, position 1 of 3.`);
      await expectDraft(target);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
      expect(config.read()).toEqual(target);
      expect(JSON.parse(await hierarchyInput.inputValue())).toEqual({ version: 1, expected: target, target });

      await opener.click();
      await expect(dialog).toBeVisible();
      expect(await domHierarchy()).toEqual(target);
      await dragBefore(title(`page:${chapterPageA.id}`), title(`chapter:${chapterB.id}`));
      target = [
        { type: 'chapter', id: chapter.id, pages: [directPage.id, chapterPageB.id] },
        { type: 'page', id: chapterPageA.id },
        { type: 'chapter', id: chapterB.id, pages: [chapterBPage.id] },
        { type: 'chapter', id: emptyChapter.id, pages: [] },
        { type: 'page', id: directPageB.id },
        { type: 'page', id: directPageC.id },
      ];
      await expectDraft(target);
      await expect(item(`chapter:${chapter.id}`)).toContainText(chapter.title);
      await expect(container(`chapter:${chapter.id}`).locator(':scope > [data-book-hierarchy-item]')).toHaveCount(2);
      await dialog.getByRole('button', { name: closeLabel, exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      expect(config.read()).toEqual(target);

      await opener.click();
      await expect(dialog).toBeVisible();
      expect(await domHierarchy()).toEqual(target);
      expect(JSON.parse(await hierarchyInput.inputValue())).toEqual({ version: 1, expected: target, target });
      const persistenceCountBeforeBackdropDismiss = persistencePosts().length;
      await dialog.locator('.app-dialog-body').click({ position: { x: 4, y: 4 } });
      await expect(dialog).toBeVisible();
      await page.mouse.click(1, 1);
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      expect(await domHierarchy()).toEqual(target);
      expect(config.read()).toEqual(target);

      await opener.click();
      await expect(dialog).toBeVisible();
      expect(await domHierarchy()).toEqual(target);
      expect(persistencePosts()).toHaveLength(persistenceCountBeforeBackdropDismiss);

      await dragToEnd(title(`page:${directPage.id}`), container(`chapter:${chapter.id}`));
      target = [
        { type: 'chapter', id: chapter.id, pages: [chapterPageB.id, directPage.id] },
        { type: 'page', id: chapterPageA.id },
        { type: 'chapter', id: chapterB.id, pages: [chapterBPage.id] },
        { type: 'chapter', id: emptyChapter.id, pages: [] },
        { type: 'page', id: directPageB.id },
        { type: 'page', id: directPageC.id },
      ];
      await expectDraft(target);

      await dragBefore(title(`page:${chapterPageA.id}`), title(`chapter:${chapterB.id}`));
      target = [
        { type: 'chapter', id: chapter.id, pages: [chapterPageB.id, directPage.id] },
        { type: 'page', id: chapterPageA.id },
        { type: 'chapter', id: chapterB.id, pages: [chapterBPage.id] },
        { type: 'chapter', id: emptyChapter.id, pages: [] },
        { type: 'page', id: directPageB.id },
        { type: 'page', id: directPageC.id },
      ];
      await expectDraft(target);
      await expect(item(`chapter:${chapter.id}`)).toContainText(chapter.title);
      await expect(container(`chapter:${chapter.id}`).locator(':scope > [data-book-hierarchy-item]')).toHaveCount(2);

      await dragToEnd(title(`page:${chapterPageB.id}`), container(`chapter:${chapterB.id}`));
      target[0].pages = [directPage.id];
      target[2].pages = [chapterBPage.id, chapterPageB.id];
      await expectDraft(target);

      await dragBefore(title(`page:${directPageC.id}`), title(`chapter:${chapterB.id}`));
      target = [target[0], target[1], { type: 'page', id: directPageC.id }, target[2], target[3], target[4]];
      await expectDraft(target);

      await dragToEnd(title(`chapter:${chapterB.id}`), container('root'));
      target = [target[0], target[1], target[2], target[4], target[5], target[3]];
      await expectDraft(target);
      expect(target[5]).toEqual({ type: 'chapter', id: chapterB.id, pages: [chapterBPage.id, chapterPageB.id] });

      await dragToEnd(title(`page:${directPageB.id}`), emptyPages, { proveIndicator: true });
      target[3].pages = [directPageB.id];
      target.splice(4, 1);
      await expectDraft(target);

      const beforeIllegal = JSON.stringify(target);
      await dragToEnd(title(`chapter:${chapter.id}`), container(`chapter:${chapterB.id}`));
      expect(JSON.stringify(await domHierarchy())).toBe(beforeIllegal);
      await expectDraft(target);

      await handle(`page:${chapterPageB.id}`).press('Home');
      target[4].pages = [chapterPageB.id, chapterBPage.id];
      await expect(handle(`page:${chapterPageB.id}`)).toBeFocused();
      await expectDraft(target);
      await handle(`page:${chapterPageB.id}`).press('ArrowDown');
      target[4].pages = [chapterBPage.id, chapterPageB.id];
      await expectDraft(target);

      await handle(`chapter:${chapterB.id}`).press('Home');
      target = [target[4], ...target.slice(0, 4)];
      await expectDraft(target);
      await handle(`chapter:${chapterB.id}`).press('ArrowDown');
      [target[0], target[1]] = [target[1], target[0]];
      await expectDraft(target);
      await handle(`chapter:${chapterB.id}`).press('ArrowUp');
      [target[0], target[1]] = [target[1], target[0]];
      await expectDraft(target);
      await handle(`chapter:${chapterB.id}`).press('End');
      target = [...target.slice(1), target[0]];
      await expect(handle(`chapter:${chapterB.id}`)).toBeFocused();
      await expectDraft(target);

      await expect(status).toHaveText('Book hierarchy saved.');
      expect(config.read()).toEqual(target);
      expect(persistencePosts().length).toBeGreaterThan(0);
      const lastPost = persistencePosts().at(-1);
      expect(new URL(lastPost.url()).pathname).toBe(`/notes/books/${book.id}/hierarchy/reorder`);
      expect(new URLSearchParams(lastPost.postData()).has('orderedItems')).toBe(false);
      expect(new URLSearchParams(lastPost.postData()).has('orderedNoteIds')).toBe(false);
      expect(new URLSearchParams(lastPost.postData()).get('_csrf')).toBeTruthy();

      const concurrentPage = app.locals.noteService.createNote({
        bookId: book.id,
        title: 'Concurrent hierarchy Page',
        content: '',
      });
      const retiredEditor = await dialog.locator('[data-book-hierarchy-editor]').elementHandle();
      const conflict = page.waitForResponse(candidate => candidate.request().method() === 'POST'
        && new URL(candidate.url()).pathname === `/notes/books/${book.id}/hierarchy/reorder`);
      const reconciliationRequest = page.waitForRequest(candidate => candidate.method() === 'GET'
        && new URL(candidate.url()).pathname === `/notes/books/${book.id}/order`);
      await handle(`chapter:${chapterB.id}`).press('Home');
      expect((await conflict).status()).toBe(409);
      expect(new URL((await reconciliationRequest).url()).pathname).toBe(`/notes/books/${book.id}/order`);
      await expect(dialog.locator(`[data-content-key="page:${concurrentPage.id}"]`)).toHaveCount(1);
      await expect(status).toContainText('current hierarchy has been refreshed');
      const reconciled = app.locals.noteService.getBookHierarchy(book.id);
      expect(JSON.parse(await hierarchyInput.inputValue())).toEqual({
        version: 1,
        expected: reconciled,
        target: reconciled,
      });
      await expect(page.locator(`[data-book-detail-live-region] a[href="/notes/${concurrentPage.id}"]`).first()).toBeVisible();

      const postsAfterReconciliation = persistencePosts().length;
      await retiredEditor.evaluate(editor => {
        editor.querySelector('[data-book-hierarchy-handle]')?.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'End',
          bubbles: true,
          cancelable: true,
        }));
      });
      await expect.poll(() => persistencePosts().length).toBe(postsAfterReconciliation);

      const freshMove = page.waitForResponse(candidate => candidate.request().method() === 'POST'
        && new URL(candidate.url()).pathname === `/notes/books/${book.id}/hierarchy/reorder`);
      await handle(`page:${concurrentPage.id}`).press('Home');
      expect((await freshMove).status()).toBe(200);
      await expect(status).toHaveText('Book hierarchy saved.');
      const freshSubmission = JSON.parse(new URLSearchParams(persistencePosts().at(-1).postData()).get('hierarchy'));
      expect(freshSubmission.expected).toEqual(reconciled);
      expect(config.read()).toEqual(freshSubmission.target);
      expect(errors).toEqual([]);
      return;
    }
    if (kind === 'books') {
      const initial = config.read();
      await expect(opener).toHaveCount(1);
      await opener.click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      await expect(dialog.getByText('Changes are saved immediately.', { exact: false })).toBeVisible();
      const retainedList = await dialog.locator('[data-book-reorder-list]').elementHandle();

      const response = page.waitForResponse(candidate => (
        candidate.request().method() === 'POST'
        && new URL(candidate.url()).pathname === '/notes/books/reorder'
      ));
      await dialog.locator('[data-book-reorder-handle]').first().press('End');
      expect((await response).status()).toBe(200);
      await expect(dialog.locator('[data-book-reorder-status]')).toHaveText('Book order saved.');
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(base + config.host);

      const expected = [...initial].reverse();
      expect(config.read()).toEqual(expected);
      await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(expected.join(','));
      const shelfLinks = page.locator('[data-notes-books-live-region] .notes-book-card-title a');
      await expect(shelfLinks).toHaveCount(expected.length);
      expect(await shelfLinks.evaluateAll(links => links.map(link => link.getAttribute('href').split('/').pop())))
        .toEqual(expected);
      expect(await dialog.locator('[data-book-reorder-list]').evaluate((list, original) => list === original, retainedList)).toBe(true);
      expect(await retainedList.evaluate(list => list.__creatorCrateBookReorderState.retired)).toBe(false);
      await expect(dialog.locator('[data-book-reorder-handle]').last()).toBeFocused();
      expect(new URLSearchParams(posts[0].postData()).get(config.input)).toBe(expected.join(','));
      expect(new URLSearchParams(posts[0].postData()).get('_csrf')).toBeTruthy();

      await dialog.locator('.app-dialog-body').click({ position: { x: 4, y: 4 } });
      await expect(dialog).toBeVisible();
      await page.mouse.click(1, 1);
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      expect(config.read()).toEqual(expected);

      await opener.click();
      await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(expected.join(','));
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      expect(config.read()).toEqual(expected);

      await opener.click();
      await dialog.getByRole('button', { name: closeLabel, exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      expect(config.read()).toEqual(expected);

      await opener.click();
      await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(expected.join(','));
      expect(posts).toHaveLength(1);
      expect(errors).toEqual([]);
      return;
    }
    const initial = config.read();
    await expect(opener).toHaveCount(1);
    await expect(opener).toHaveAttribute('href', config.direct);
    for (const close of ['Escape', 'X']) {
      await opener.click();
      await expect(page).toHaveURL(base + config.host);
      expect(await dialog.evaluate(n => n.matches(':modal'))).toBe(true);
      await expect(page.locator('body')).toHaveClass(/app-dialog-open/);
      await expect(dialog.getByRole('link', { name: 'Cancel', exact: true })).toHaveCount(0);
      await dialog.locator(`[${config.handle}]`).first().press('End');
      if (close === 'Escape') await page.keyboard.press('Escape');
      else if (close === 'X') await dialog.getByRole('button', { name: closeLabel, exact: true }).click();
      else await dialog.getByRole('link', { name: 'Cancel', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
      expect(posts).toHaveLength(0);
      expect(config.read()).toEqual(initial);
    }
    for (const peer of config.peers) {
      await page.getByRole('link', { name: peer === 'Edit Book' ? 'Edit book' : peer, exact: true }).click();
      await expect(page.getByRole('dialog', { name: peer, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await opener.click();
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await page.keyboard.press('Escape');
    }
    expect(await page.locator('[id]').evaluateAll(nodes => new Set(nodes.map(n => n.id)).size === nodes.length)).toBe(true);
    await expect(page.locator('form form')).toHaveCount(0);
    await page.goto(base + config.direct);
    expect(await dialog.evaluate(n => n.matches(':modal'))).toBe(true);
    await expect(page.locator('main')).toBeVisible();
    await expect(input).toHaveValue(initial.join(','));
    await page.keyboard.press('Escape');
    await page.goto(base + config.host);
    await opener.click();
    const handles = dialog.locator(`[${config.handle}]`);
    const cards = dialog.locator(`[${config.item}]`);
    const cardBodies = cards.locator(':scope > div[draggable="true"]');
    // Real mouse input is essential: Chromium retargets native dragstart to
    // the draggable body rather than the button/label originally pressed.
    await cardBodies.first().evaluate(body => {
      const fixture = document.createElement('div');
      fixture.id = 'pointer-exclusion-fixture';
      fixture.innerHTML = '<button type="button">Probe button</button><label for="probe-check">Probe label</label><input id="probe-check" type="checkbox"><span role="button" tabindex="0">Probe role</span>';
      fixture.querySelectorAll('button, [role="button"]').forEach(control => {
        control.addEventListener('click', () => { control.dataset.activated = 'yes'; });
      });
      body.append(fixture);
    });
    const mouseDrag = async (source) => {
      const from = await source.boundingBox();
      const to = await cards.last().boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 5 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height - 3, { steps: 15 });
      await page.mouse.up();
    };
    for (const selector of ['#pointer-exclusion-fixture button', '#pointer-exclusion-fixture label', '#pointer-exclusion-fixture [role="button"]', 'a']) {
      const control = cards.first().locator(selector).first();
      await mouseDrag(control);
      await expect(input).toHaveValue(initial.join(','));
      expect(await input.evaluate(n => new FormData(n.form).get(n.name))).toBe(initial.join(','));
      expect(config.read()).toEqual(initial);
      expect(posts).toHaveLength(0);
      if (selector === 'a') {
        await control.evaluate(n => n.addEventListener('click', event => {
          n.dataset.activated = String(!event.defaultPrevented);
          event.preventDefault();
        }, { once: true }));
        await control.click();
        await expect(control).toHaveAttribute('data-activated', 'true');
      } else {
        await control.click();
        if (selector.endsWith('label')) await expect(dialog.locator('#probe-check')).toBeChecked();
        else await expect(control).toHaveAttribute('data-activated', 'yes');
      }
    }
    // Deterministic lifecycle checks, deliberately retargeting dragstart.
    expect(await cards.evaluateAll((rows) => {
      const first = rows[0], second = rows[1];
      const excluded = first.querySelector('#pointer-exclusion-fixture button');
      const body = first.querySelector('[draggable="true"]');
      const down = target => target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
      const drag = row => {
        const event = new DragEvent('dragstart', { bubbles: true, cancelable: true });
        row.dispatchEvent(event);
        return !event.defaultPrevented;
      };
      const end = row => row.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      const results = [];
      down(excluded); results.push(!drag(first)); end(first);
      down(excluded); down(body); results.push(drag(first)); end(first);
      for (const terminal of ['pointerup', 'pointercancel', 'dragend']) {
        down(excluded);
        first.dispatchEvent(terminal === 'dragend' ? new DragEvent(terminal, { bubbles: true }) : new PointerEvent(terminal, { bubbles: true }));
        results.push(drag(first)); end(first);
      }
      down(excluded); results.push(drag(second)); end(second);
      return results;
    })).toEqual([true, true, true, true, true, true]);
    await dialog.locator('#pointer-exclusion-fixture').evaluate(n => n.remove());
    await mouseDrag(handles.first());
    await expect(input).toHaveValue([...initial].reverse().join(','));
    await handles.first().press('End');
    await expect(handles.last()).toBeFocused();
    await expect(input).toHaveValue(initial.join(','));
    await handles.first().press('ArrowDown');
    await expect(input).toHaveValue([...initial].reverse().join(','));
    await handles.last().press('Home');
    await expect(input).toHaveValue(initial.join(','));
    await expect(cards.first()).toHaveClass(/notes-reorder-row--compact/);
    expect(await cards.first().evaluate((row) => {
      const styles = getComputedStyle(row);
      const kind = row.querySelector('.notes-book-content-kind, .notes-chapter-page-number');
      const position = row.querySelector('.notes-reorder-position');
      return [styles.paddingBlockStart, styles.paddingInlineStart, styles.gap,
        getComputedStyle(kind).marginBottom, getComputedStyle(position).marginTop];
    })).toEqual(['4px', '8px', '4px', '0px', '0px']);
    expect(await cards.first().locator('a').evaluate((link) => {
      const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(true);
    await cardBodies.first().dragTo(handles.last(), {
      sourcePosition: { x: 3, y: 3 }, targetPosition: { x: 5, y: 30 },
    });
    await expect(input).toHaveValue([...initial].reverse().join(','));
    await handles.first().press('End');
    await expect(input).toHaveValue(initial.join(','));
    await handles.first().press('End');
    const expected = [...initial].reverse();
    const response = page.waitForResponse(r => r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await response).status()).toBe(302);
    await expect(page).toHaveURL(base + (config.redirect || config.host));
    expect(config.read()).toEqual(expected);
    expect(new URLSearchParams(posts[0].postData()).get(config.input)).toBe(expected.join(','));
    expect(new URLSearchParams(posts[0].postData()).get('_csrf')).toBeTruthy();
    await page.goto(base + config.direct);
    await expect(input).toHaveValue(expected.join(','));
    await input.evaluate(n => n.form.addEventListener('formdata', event => event.formData.set(n.name, 'invalid'), { once: true }));
    const invalid = page.waitForResponse(r => r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await invalid).status()).toBe(422);
    await expect(dialog).toBeVisible();
    await expect(input).toHaveValue(expected.join(','));
    expect(config.read()).toEqual(expected);
    expect(errors).toEqual([]);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
 });
}

test('books: changed membership installs one fresh shelf and reorder controller', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-membership-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const posts = [];
    let reconciliationGets = 0;
    let recoveryInstalled = false;
    let concurrentBook;
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });

    await page.goto(`${base}/notes`);
    await page.route('**/notes/books/reorder', async (route) => {
      if (concurrentBook) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      concurrentBook = app.locals.bookService.createBook({ title: 'Concurrent Book' });
      await route.abort('failed');
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      reconciliationGets += 1;
      if (!recoveryInstalled && reconciliationGets > 1) return route.abort('failed');
      return route.continue();
    });
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    const dialog = page.locator('#books-order-dialog');
    const retiredList = await dialog.locator('[data-book-reorder-list]').elementHandle();
    const initialIds = app.locals.bookService.listBooks().map(book => String(book.id));
    const reconciliation = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/notes');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    expect((await reconciliation).status()).toBe(200);

    const canonicalIds = app.locals.bookService.listBooks().map(book => String(book.id));
    expect(canonicalIds).toContain(String(concurrentBook.id));
    await expect(dialog.locator('[data-book-reorder-item]')).toHaveCount(canonicalIds.length);
    await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(canonicalIds.join(','));
    expect(await dialog.locator('[data-book-reorder-item]').evaluateAll(items => items.map(item => item.dataset.bookId)))
      .toEqual(canonicalIds);
    expect(await page.locator('[data-notes-books-live-region] .notes-book-card-title a').evaluateAll(links => (
      links.map(link => link.getAttribute('href').split('/').pop())
    ))).toEqual(canonicalIds);
    await expect(dialog.locator('[data-book-reorder-handle]').first()).toBeFocused();
    expect(reconciliationGets).toBe(1);
    recoveryInstalled = true;

    const postsAfterRecovery = posts.length;
    await retiredList.evaluate(list => {
      list.querySelector('[data-book-reorder-handle]')?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End', bubbles: true, cancelable: true,
      }));
    });
    await expect.poll(() => posts.length).toBe(postsAfterRecovery);
    expect(postsAfterRecovery).toBe(1);
    expect(new URLSearchParams(posts[0].postData()).get('orderedBookIds')).not.toContain(String(concurrentBook.id));

    const saved = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/notes/books/reorder');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    expect((await saved).status()).toBe(200);
    expect(posts).toHaveLength(2);
    const deliberateOrder = new URLSearchParams(posts[1].postData()).get('orderedBookIds').split(',');
    expect(deliberateOrder).toContain(String(concurrentBook.id));
    expect(deliberateOrder).not.toEqual(initialIds);
    expect(app.locals.bookService.listBooks().map(book => String(book.id))).toEqual(deliberateOrder);
    await expect(dialog.locator('[data-book-reorder-status]')).toHaveText('Book order saved.');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: failed membership recovery keeps Retry through close and reopen, then recovers', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-retry-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let failRecovery = true;
    let recoveryGets = 0;
    let concurrentBookCreated = false;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });

    await page.goto(`${base}/notes`);
    const initialShelfIds = await page.locator('[data-notes-books-live-region] .notes-book-card-title a')
      .evaluateAll(links => links.map(link => link.getAttribute('href').split('/').pop()));
    await page.route('**/notes/books/reorder', async (route) => {
      if (concurrentBookCreated) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (!concurrentBookCreated) {
        app.locals.bookService.createBook({ title: 'Concurrent Book' });
        concurrentBookCreated = true;
      }
      await route.abort('failed');
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      recoveryGets += 1;
      if (failRecovery) {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /(data-book-order-input value=")[^"]*(")/,
          (_match, prefix, suffix) => `${prefix}999${suffix}`,
        );
        return route.fulfill({ response, body });
      }
      return route.continue();
    });
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    const dialog = page.locator('#books-order-dialog');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    const retry = dialog.getByRole('button', { name: 'Retry reconciliation', exact: true });
    await expect(retry).toBeVisible();
    await expect(retry).toBeFocused();
    await expect(dialog.locator('[data-book-reorder-status]')).not.toContainText('close and reopen');
    expect(posts).toHaveLength(1);
    expect(await page.locator('[data-notes-books-live-region] .notes-book-card-title a')
      .evaluateAll(links => links.map(link => link.getAttribute('href').split('/').pop())))
      .toEqual(initialShelfIds);
    expect((await dialog.locator('[data-book-reorder-item]').evaluateAll(items => (
      items.map(item => item.dataset.bookId).sort()
    )))).toEqual([...initialShelfIds].sort());

    await dialog.getByRole('button', { name: 'Close Change book order', exact: true }).click();
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    await expect(retry).toBeVisible();
    expect(posts).toHaveLength(1);

    failRecovery = false;
    await retry.click();
    const canonicalIds = app.locals.bookService.listBooks().map(book => String(book.id));
    await expect(dialog.locator('[data-book-reorder-item]')).toHaveCount(canonicalIds.length);
    await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(canonicalIds.join(','));
    await expect(dialog.locator('[data-book-reorder-handle]').first()).toBeFocused();
    expect(recoveryGets).toBe(2);

    const saved = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/notes/books/reorder');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    expect((await saved).status()).toBe(200);
    expect(posts).toHaveLength(2);
    await expect(dialog.locator('[data-book-reorder-status]')).toHaveText('Book order saved.');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: successful save publishes one complete snapshot after concurrent membership change', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-post-save-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let concurrentBook;
    let notesGets = 0;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });
    await page.route('**/notes/books/reorder', async (route) => {
      if (concurrentBook) return route.continue();
      const response = await route.fetch();
      concurrentBook = app.locals.bookService.createBook({ title: 'Concurrent Book' });
      await route.fulfill({ response });
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() === 'GET') notesGets += 1;
      await route.continue();
    });

    await page.goto(`${base}/notes`);
    notesGets = 0;
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    const dialog = page.locator('#books-order-dialog');
    const retiredList = await dialog.locator('[data-book-reorder-list]').elementHandle();
    const synchronized = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/notes');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    expect((await synchronized).status()).toBe(200);

    const canonicalIds = app.locals.bookService.listBooks().map(book => String(book.id));
    expect(canonicalIds).toContain(String(concurrentBook.id));
    expect(notesGets).toBe(1);
    expect(await page.locator('[data-notes-books-live-region] .notes-book-card-title a').evaluateAll(links => (
      links.map(link => link.getAttribute('href').split('/').pop())
    ))).toEqual(canonicalIds);
    expect(await dialog.locator('[data-book-reorder-item]').evaluateAll(items => items.map(item => item.dataset.bookId)))
      .toEqual(canonicalIds);
    await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(canonicalIds.join(','));
    expect(await retiredList.evaluate(list => list.__creatorCrateBookReorderState.retired)).toBe(true);
    await expect(dialog.locator('[data-book-reorder-handle]').first()).toBeFocused();

    const savedAgain = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/notes/books/reorder');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    expect((await savedAgain).status()).toBe(200);
    expect(posts).toHaveLength(2);
    expect(new URLSearchParams(posts[1].postData()).get('orderedBookIds')).toContain(String(concurrentBook.id));
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: controlled rejection publishes one complete snapshot after concurrent membership change', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-rejection-sync-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const initialIds = app.locals.bookService.listBooks().map(book => String(book.id));
    let concurrentBook;
    let notesGets = 0;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });
    await page.route('**/notes/books/reorder', async (route) => {
      if (concurrentBook) return route.continue();
      concurrentBook = app.locals.bookService.createBook({ title: 'Concurrent Book' });
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'error',
          message: 'The submitted book order is stale.',
          orderedBookIds: initialIds.map(Number),
        }),
      });
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() === 'GET') notesGets += 1;
      await route.continue();
    });

    await page.goto(`${base}/notes`);
    notesGets = 0;
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    const dialog = page.locator('#books-order-dialog');
    const synchronized = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/notes');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    expect((await synchronized).status()).toBe(200);

    const canonicalIds = app.locals.bookService.listBooks().map(book => String(book.id));
    expect(notesGets).toBe(1);
    expect(posts).toHaveLength(1);
    expect(await page.locator('[data-notes-books-live-region] .notes-book-card-title a').evaluateAll(links => (
      links.map(link => link.getAttribute('href').split('/').pop())
    ))).toEqual(canonicalIds);
    expect(await dialog.locator('[data-book-reorder-item]').evaluateAll(items => items.map(item => item.dataset.bookId)))
      .toEqual(canonicalIds);
    await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(canonicalIds.join(','));
    await expect(dialog.locator('[data-book-reorder-status]')).toContainText('stale');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: controlled rejection canonicalizes before queued intent while closed', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-rejection-queue-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    app.locals.bookService.createBook({ title: 'Book Gamma' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const initialIds = app.locals.bookService.listBooks().map(book => String(book.id));

    await page.goto(`${base}/notes`);
    const opener = page.getByRole('link', { name: 'Change book order', exact: true });
    await opener.click();
    const dialog = page.locator('#books-order-dialog');
    const retiredList = await dialog.locator('[data-book-reorder-list]').elementHandle();
    const posts = [];
    let notesGets = 0;
    let rejectFirstPost = true;
    let releaseRejection;
    const rejectionGate = new Promise(resolve => { releaseRejection = resolve; });
    let markFirstPostStarted;
    const firstPostStarted = new Promise(resolve => { markFirstPostStarted = resolve; });
    let releaseCanonical;
    const canonicalGate = new Promise(resolve => { releaseCanonical = resolve; });
    let markCanonicalStarted;
    const canonicalStarted = new Promise(resolve => { markCanonicalStarted = resolve; });

    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });
    await page.route('**/notes/books/reorder', async (route) => {
      if (!rejectFirstPost) return route.continue();
      rejectFirstPost = false;
      markFirstPostStarted();
      await rejectionGate;
      return route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'error',
          message: 'The submitted book order is stale.',
          orderedBookIds: initialIds.map(Number),
        }),
      });
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      notesGets += 1;
      if (notesGets !== 1) return route.continue();
      markCanonicalStarted();
      await canonicalGate;
      return route.continue();
    });

    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    await firstPostStarted;
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    const queuedOrder = (await dialog.locator('[name="orderedBookIds"]').inputValue()).split(',');
    expect(queuedOrder).not.toEqual(initialIds);
    expect(posts).toHaveLength(1);

    await dialog.getByRole('button', { name: 'Close Change book order', exact: true }).click();
    await page.evaluate(() => {
      const focusGuard = document.createElement('button');
      focusGuard.id = 'controlled-rejection-queue-focus-guard';
      focusGuard.textContent = 'Focus guard';
      document.body.appendChild(focusGuard);
      focusGuard.focus();
    });
    releaseRejection();
    await canonicalStarted;

    expect(notesGets).toBe(1);
    expect(posts).toHaveLength(1);
    await expect(dialog.locator('[data-book-reorder-form]')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#controlled-rejection-queue-focus-guard')).toBeFocused();
    await retiredList.evaluate(list => {
      const item = list.querySelector('[data-book-reorder-item]');
      list.querySelector('[data-book-reorder-handle]')?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End', bubbles: true, cancelable: true,
      }));
      item?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
      list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    });
    expect(posts).toHaveLength(1);

    const canonicalResponse = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/notes');
    const queuedSave = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/notes/books/reorder');
    releaseCanonical();
    expect((await canonicalResponse).status()).toBe(200);
    expect((await queuedSave).status()).toBe(200);
    await expect.poll(() => posts.length).toBe(2);
    expect(new URLSearchParams(posts[1].postData()).get('orderedBookIds')).toBe(queuedOrder.join(','));
    await expect.poll(() => notesGets).toBe(2);
    await expect(page.locator('#controlled-rejection-queue-focus-guard')).toBeFocused();
    expect(await retiredList.evaluate(list => ({
      retired: list.__creatorCrateBookReorderState.retired,
      acknowledgedIds: list.__creatorCrateBookReorderState.acknowledgedIds,
    }))).toEqual({ retired: false, acknowledgedIds: queuedOrder });

    await opener.click();
    expect(await dialog.locator('[data-book-reorder-item]').evaluateAll(items => items.map(item => item.dataset.bookId)))
      .toEqual(queuedOrder);
    await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(queuedOrder.join(','));
    expect(app.locals.bookService.listBooks().map(book => String(book.id))).toEqual(queuedOrder);
    expect(posts).toHaveLength(2);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: post-save synchronization failure publishes neither region and Retry does not replay the mutation', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-post-save-retry-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let concurrentBook;
    let malformed = true;
    let notesGets = 0;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });
    await page.route('**/notes/books/reorder', async (route) => {
      const response = await route.fetch();
      if (!concurrentBook) concurrentBook = app.locals.bookService.createBook({ title: 'Concurrent Book' });
      await route.fulfill({ response });
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      notesGets += 1;
      if (!malformed) return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /(data-book-order-input value=")[^"]*(")/,
        (_match, prefix, suffix) => `${prefix}999${suffix}`,
      );
      await route.fulfill({ response, body });
    });

    await page.goto(`${base}/notes`);
    notesGets = 0;
    const initialShelfIds = await page.locator('[data-notes-books-live-region] .notes-book-card-title a')
      .evaluateAll(links => links.map(link => link.getAttribute('href').split('/').pop()));
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    const dialog = page.locator('#books-order-dialog');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    const retry = dialog.getByRole('button', { name: 'Retry reconciliation', exact: true });
    await expect(retry).toBeVisible();
    await expect(retry).toBeFocused();
    expect(posts).toHaveLength(1);
    expect(await page.locator('[data-notes-books-live-region] .notes-book-card-title a').evaluateAll(links => (
      links.map(link => link.getAttribute('href').split('/').pop())
    ))).toEqual(initialShelfIds);
    expect((await dialog.locator('[data-book-reorder-item]').evaluateAll(items => items.map(item => item.dataset.bookId).sort())))
      .toEqual([...initialShelfIds].sort());

    malformed = false;
    await retry.click();
    const canonicalIds = app.locals.bookService.listBooks().map(book => String(book.id));
    await expect(dialog.locator('[data-book-reorder-item]')).toHaveCount(canonicalIds.length);
    await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(canonicalIds.join(','));
    expect(posts).toHaveLength(1);
    expect(notesGets).toBe(2);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: successful save reconciles atomically to empty authority', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-post-save-empty-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });
    await page.route('**/notes/books/reorder', async (route) => {
      const response = await route.fetch();
      for (const book of app.locals.bookService.listBooks()) app.locals.bookService.deleteBook(book.id);
      await route.fulfill({ response });
    });

    await page.goto(`${base}/notes`);
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    const dialog = page.locator('#books-order-dialog');
    const retiredList = await dialog.locator('[data-book-reorder-list]').elementHandle();
    await dialog.locator('[data-book-reorder-handle]').first().press('End');

    await expect(page.locator('[data-notes-books-live-region] .empty-state-heading')).toHaveText('No books yet');
    await expect(dialog.locator('[data-notes-book-order-page] .empty-state-heading')).toHaveText('No books yet');
    await expect(dialog.locator('[data-book-reorder-list], [data-book-order-input], [data-book-reorder-handle]')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Retry reconciliation', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close Change book order', exact: true })).toBeFocused();
    expect(await retiredList.evaluate(list => ({
      retired: list.__creatorCrateBookReorderState.retired,
      acknowledgedIds: list.__creatorCrateBookReorderState.acknowledgedIds,
    }))).toEqual({ retired: true, acknowledgedIds: [] });
    expect(posts).toHaveLength(1);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: a save completed after dialog close synchronizes hosted editor authority before reopen', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-closed-refresh-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let releaseResponse;
    let notesGets = 0;
    let reorderRequests = 0;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });
    await page.route('**/notes/books/reorder', async (route) => {
      reorderRequests += 1;
      const response = await route.fetch();
      if (reorderRequests === 1) {
        app.locals.bookService.createBook({ title: 'Concurrent Book' });
        await new Promise(resolve => { releaseResponse = resolve; });
      }
      await route.fulfill({ response });
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() === 'GET') notesGets += 1;
      await route.continue();
    });

    await page.goto(`${base}/notes`);
    notesGets = 0;
    const opener = page.getByRole('link', { name: 'Change book order', exact: true });
    await opener.click();
    const dialog = page.locator('#books-order-dialog');
    const retiredList = await dialog.locator('[data-book-reorder-list]').elementHandle();
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    await expect.poll(() => typeof releaseResponse).toBe('function');
    await dialog.getByRole('button', { name: 'Close Change book order', exact: true }).click();
    await page.evaluate(() => {
      const focusGuard = document.createElement('button');
      focusGuard.id = 'closed-dialog-focus-guard';
      focusGuard.textContent = 'Focus guard';
      document.body.appendChild(focusGuard);
      focusGuard.focus();
    });
    releaseResponse();

    const canonicalIds = app.locals.bookService.listBooks().map(book => String(book.id));
    await expect(page.locator('[data-notes-books-live-region] .notes-book-card-title a')).toHaveCount(canonicalIds.length);
    expect(await page.locator('[data-notes-books-live-region] .notes-book-card-title a').evaluateAll(links => (
      links.map(link => link.getAttribute('href').split('/').pop())
    ))).toEqual(canonicalIds);
    await expect(dialog.locator('[data-book-reorder-item]')).toHaveCount(canonicalIds.length);
    expect(await dialog.locator('[data-book-reorder-item]').evaluateAll(items => items.map(item => item.dataset.bookId)))
      .toEqual(canonicalIds);
    await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(canonicalIds.join(','));
    expect(notesGets).toBe(1);
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#closed-dialog-focus-guard')).toBeFocused();
    expect(await retiredList.evaluate(list => list.__creatorCrateBookReorderState.retired)).toBe(true);
    await retiredList.evaluate(list => {
      const item = list.querySelector('[data-book-reorder-item]');
      list.querySelector('[data-book-reorder-handle]')?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End', bubbles: true, cancelable: true,
      }));
      item?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
      list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => posts.length).toBe(1);

    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    expect(await dialog.locator('[data-book-reorder-item]').evaluateAll(items => items.map(item => item.dataset.bookId)))
      .toEqual(canonicalIds);
    await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(canonicalIds.join(','));
    const deliberateSave = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/notes/books/reorder');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    expect((await deliberateSave).status()).toBe(200);
    await expect.poll(() => posts.length).toBe(2);
    const deliberateIds = new URLSearchParams(posts[1].postData()).get('orderedBookIds').split(',');
    expect(deliberateIds.sort()).toEqual([...canonicalIds].sort());
    await expect(dialog.locator('[data-book-reorder-status]')).toContainText('saved');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: a save completed after dialog close installs empty hosted authority without stealing focus', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-closed-empty-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let releaseResponse;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });
    await page.route('**/notes/books/reorder', async (route) => {
      const response = await route.fetch();
      for (const book of app.locals.bookService.listBooks()) app.locals.bookService.deleteBook(book.id);
      await new Promise(resolve => { releaseResponse = resolve; });
      await route.fulfill({ response });
    });

    await page.goto(`${base}/notes`);
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    const dialog = page.locator('#books-order-dialog');
    const retiredList = await dialog.locator('[data-book-reorder-list]').elementHandle();
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    await expect.poll(() => typeof releaseResponse).toBe('function');
    await dialog.getByRole('button', { name: 'Close Change book order', exact: true }).click();
    await page.evaluate(() => {
      const focusGuard = document.createElement('button');
      focusGuard.id = 'closed-empty-focus-guard';
      focusGuard.textContent = 'Focus guard';
      document.body.appendChild(focusGuard);
      focusGuard.focus();
    });
    releaseResponse();

    await expect(page.locator('[data-notes-books-live-region] .empty-state-heading')).toHaveText('No books yet');
    await expect(dialog.locator('[data-notes-book-order-page] .empty-state-heading')).toHaveText('No books yet');
    await expect(dialog.locator('[data-book-reorder-list], [data-book-order-input], [data-book-reorder-handle]')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Retry reconciliation', exact: true })).toHaveCount(0);
    await expect(page.locator('#closed-empty-focus-guard')).toBeFocused();
    expect(await retiredList.evaluate(list => ({
      retired: list.__creatorCrateBookReorderState.retired,
      acknowledgedIds: list.__creatorCrateBookReorderState.acknowledgedIds,
    }))).toEqual({ retired: true, acknowledgedIds: [] });
    expect(posts).toHaveLength(1);

    await dialog.evaluate(element => {
      element.showModal();
      element.__creatorCrateAppDialogState.open = true;
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-notes-book-order-page] .empty-state-heading')).toHaveText('No books yet');
    await expect(dialog.locator('[data-book-reorder-list], [data-book-order-input], [data-book-reorder-handle]')).toHaveCount(0);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: closed post-save synchronization failure blocks stale authority until Retry succeeds', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-closed-retry-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let releaseResponse;
    let malformed = true;
    let notesGets = 0;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });
    await page.route('**/notes/books/reorder', async (route) => {
      const response = await route.fetch();
      app.locals.bookService.createBook({ title: 'Concurrent Book' });
      await new Promise(resolve => { releaseResponse = resolve; });
      await route.fulfill({ response });
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      notesGets += 1;
      if (!malformed) return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /(data-book-order-input value=")[^"]*(")/,
        (_match, prefix, suffix) => `${prefix}999${suffix}`,
      );
      await route.fulfill({ response, body });
    });

    await page.goto(`${base}/notes`);
    notesGets = 0;
    const initialShelfIds = await page.locator('[data-notes-books-live-region] .notes-book-card-title a')
      .evaluateAll(links => links.map(link => link.getAttribute('href').split('/').pop()));
    const opener = page.getByRole('link', { name: 'Change book order', exact: true });
    await opener.click();
    const dialog = page.locator('#books-order-dialog');
    const retiredList = await dialog.locator('[data-book-reorder-list]').elementHandle();
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    await expect.poll(() => typeof releaseResponse).toBe('function');
    await dialog.getByRole('button', { name: 'Close Change book order', exact: true }).click();
    await page.evaluate(() => {
      const focusGuard = document.createElement('button');
      focusGuard.id = 'closed-retry-focus-guard';
      focusGuard.textContent = 'Focus guard';
      document.body.appendChild(focusGuard);
      focusGuard.focus();
    });
    releaseResponse();

    const hiddenRetry = dialog.locator('[data-book-reorder-reconciliation-retry]');
    await expect.poll(() => notesGets).toBe(1);
    await expect(hiddenRetry).toBeAttached();
    await expect(page.locator('#closed-retry-focus-guard')).toBeFocused();
    expect(await page.locator('[data-notes-books-live-region] .notes-book-card-title a').evaluateAll(links => (
      links.map(link => link.getAttribute('href').split('/').pop())
    ))).toEqual(initialShelfIds);
    expect(await retiredList.evaluate(list => list.__creatorCrateBookReorderState.retired)).toBe(true);
    expect(posts).toHaveLength(1);

    await opener.click();
    const retry = dialog.getByRole('button', { name: 'Retry reconciliation', exact: true });
    await expect(retry).toBeVisible();
    await expect(dialog.locator('[data-book-reorder-form]')).toHaveAttribute('aria-busy', 'true');
    malformed = false;
    await retry.click();
    const canonicalIds = app.locals.bookService.listBooks().map(book => String(book.id));
    await expect(dialog.locator('[data-book-reorder-item]')).toHaveCount(canonicalIds.length);
    expect(await dialog.locator('[data-book-reorder-item]').evaluateAll(items => items.map(item => item.dataset.bookId)))
      .toEqual(canonicalIds);
    await expect(dialog.locator('[name="orderedBookIds"]')).toHaveValue(canonicalIds.join(','));
    await expect(retry).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(notesGets).toBe(2);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('books: empty membership is canonical, while missing non-empty editor still requires Retry', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-order-empty-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes/books/reorder') posts.push(request);
    });

    await page.goto(`${base}/notes`);
    let loseResponse = true;
    let emptyAuthorityGets = 0;
    await page.route('**/notes/books/reorder', async (route) => {
      if (!loseResponse) return route.continue();
      loseResponse = false;
      await route.fetch();
      await route.abort('failed');
    });
    await page.route('**/notes', async (route) => {
      if (route.request().method() === 'GET') emptyAuthorityGets += 1;
      return route.continue();
    });
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    let dialog = page.locator('#books-order-dialog');
    const retiredList = await dialog.locator('[data-book-reorder-list]').elementHandle();
    for (const book of app.locals.bookService.listBooks()) app.locals.bookService.deleteBook(book.id);
    const emptyRecovery = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/notes');
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    expect((await emptyRecovery).status()).toBe(200);
    expect(emptyAuthorityGets).toBe(1);

    await expect(page.locator('[data-notes-books-live-region] .empty-state-heading')).toHaveText('No books yet');
    await expect(dialog.locator('[data-notes-book-order-page] .empty-state-heading')).toHaveText('No books yet');
    await expect(dialog.locator('[data-book-reorder-list], [data-book-order-input], [data-book-reorder-handle]')).toHaveCount(0);
    await expect(dialog.locator('[data-notes-book-order-page]')).toHaveJSProperty('__creatorCrateBookReorderState', undefined);
    await expect(dialog.getByRole('button', { name: 'Retry reconciliation', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close Change book order', exact: true })).toBeFocused();
    expect(await retiredList.evaluate(list => ({
      retired: list.__creatorCrateBookReorderState.retired,
      acknowledgedIds: list.__creatorCrateBookReorderState.acknowledgedIds,
      queuedIds: list.__creatorCrateBookReorderState.queuedIds,
    }))).toEqual({ retired: true, acknowledgedIds: [], queuedIds: null });
    await retiredList.evaluate(list => {
      const item = list.querySelector('[data-book-reorder-item]');
      list.querySelector('[data-book-reorder-handle]')?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End', bubbles: true, cancelable: true,
      }));
      item?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
      list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => posts.length).toBe(1);
    await dialog.getByRole('button', { name: 'Close Change book order', exact: true }).click();
    await expect(dialog).not.toBeVisible();

    app.locals.bookService.createBook({ title: 'Book Gamma' });
    app.locals.bookService.createBook({ title: 'Book Delta' });
    await page.goto(`${base}/notes`);
    let malformRecovery = true;
    await page.route('**/notes', async (route) => {
      if (route.request().method() !== 'GET' || !malformRecovery) return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /<ol(?=[^>]*data-book-reorder-list)[\s\S]*?<\/ol>/,
        '',
      );
      return route.fulfill({ response, body });
    });
    await page.getByRole('link', { name: 'Change book order', exact: true }).click();
    dialog = page.locator('#books-order-dialog');
    app.locals.bookService.createBook({ title: 'Concurrent Book' });
    await dialog.locator('[data-book-reorder-handle]').first().press('End');
    const retry = dialog.getByRole('button', { name: 'Retry reconciliation', exact: true });
    await expect(retry).toBeVisible();
    await expect(retry).toBeFocused();

    malformRecovery = false;
    for (const book of app.locals.bookService.listBooks()) app.locals.bookService.deleteBook(book.id);
    await retry.click();
    await expect(dialog.locator('[data-notes-book-order-page] .empty-state-heading')).toHaveText('No books yet');
    await expect(dialog.getByRole('button', { name: 'Retry reconciliation', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close Change book order', exact: true })).toBeFocused();
    expect(posts).toHaveLength(2);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('contents: empty hierarchy is canonical, while missing non-empty editor still requires Retry', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-hierarchy-empty-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Book Alpha' });
    let chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Alpha' });
    let pageItem = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const posts = [];
    page.on('request', request => {
      if (request.method() === 'POST'
        && new URL(request.url()).pathname === `/notes/books/${book.id}/hierarchy/reorder`) posts.push(request);
    });

    await page.goto(`${base}/notes/books/${book.id}`);
    await page.getByRole('link', { name: 'Reorder book contents', exact: true }).click();
    let dialog = page.locator('#book-order-dialog');
    const retiredEditor = await dialog.locator('[data-book-hierarchy-editor]').elementHandle();
    app.locals.noteService.deleteNote(pageItem.id);
    app.locals.chapterService.deleteChapter(chapter.id);
    const emptyRecovery = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/notes/books/${book.id}/order`);
    await dialog.locator('[data-book-hierarchy-handle]').first().press('End');
    expect((await emptyRecovery).status()).toBe(200);

    await expect(page.locator('[data-book-detail-live-region] .notes-book-nav-empty')).toHaveText('No Pages or Chapters yet');
    await expect(page.locator('[data-book-detail-live-region] .notes-page-previews-empty')).toBeVisible();
    await expect(dialog.getByText('This Book has no Chapters or Pages to order yet.', { exact: true })).toBeVisible();
    await expect(dialog.locator('[data-book-hierarchy-list], [data-book-hierarchy-container], [data-book-hierarchy-handle]')).toHaveCount(0);
    expect(await dialog.locator('[data-book-hierarchy-editor]').evaluate(
      editor => Boolean(editor.__creatorCrateBookHierarchyState),
    )).toBe(false);
    await expect(dialog.locator('[data-book-hierarchy-input]')).toHaveValue(JSON.stringify({ version: 1, expected: [], target: [] }));
    await expect(dialog.getByRole('button', { name: 'Retry reconciliation', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close Reorder book contents', exact: true })).toBeFocused();
    expect(await retiredEditor.evaluate(editor => ({
      retired: editor.__creatorCrateBookHierarchyState.retired,
      expected: editor.__creatorCrateBookHierarchyState.expected,
      acknowledged: editor.__creatorCrateBookHierarchyState.acknowledgedHierarchy,
      queued: editor.__creatorCrateBookHierarchyState.queuedHierarchy,
    }))).toEqual({ retired: true, expected: [], acknowledged: [], queued: null });
    await retiredEditor.evaluate(editor => {
      const item = editor.querySelector('[data-book-hierarchy-item]');
      editor.querySelector('[data-book-hierarchy-handle]')?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End', bubbles: true, cancelable: true,
      }));
      item?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
      editor.querySelector('[data-book-hierarchy-container]')
        ?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => posts.length).toBe(1);

    chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Beta' });
    pageItem = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page Two' });
    await page.goto(`${base}/notes/books/${book.id}`);
    let malformRecovery = true;
    await page.route(`**/notes/books/${book.id}/order`, async (route) => {
      if (route.request().method() !== 'GET' || !malformRecovery) return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(' data-book-hierarchy-editor', '');
      return route.fulfill({ response, body });
    });
    await page.getByRole('link', { name: 'Reorder book contents', exact: true }).click();
    dialog = page.locator('#book-order-dialog');
    const concurrentPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Concurrent Page' });
    await dialog.locator('[data-book-hierarchy-handle]').first().press('End');
    const retry = dialog.getByRole('button', { name: 'Retry reconciliation', exact: true });
    await expect(retry).toBeVisible();
    await expect(retry).toBeFocused();

    malformRecovery = false;
    app.locals.noteService.deleteNote(pageItem.id);
    app.locals.noteService.deleteNote(concurrentPage.id);
    app.locals.chapterService.deleteChapter(chapter.id);
    await retry.click();
    await expect(dialog.getByText('This Book has no Chapters or Pages to order yet.', { exact: true })).toBeVisible();
    await expect(dialog.locator('[data-book-hierarchy-input]')).toHaveValue(JSON.stringify({ version: 1, expected: [], target: [] }));
    await expect(dialog.getByRole('button', { name: 'Retry reconciliation', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close Reorder book contents', exact: true })).toBeFocused();
    expect(posts).toHaveLength(2);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('contents: successful reorder synchronizes concurrent membership before another move', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-hierarchy-success-sync-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Book Alpha' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Alpha' });
    app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Chapter Page' });
    app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const postStatuses = [];
    page.on('response', response => {
      if (response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/notes/books/${book.id}/hierarchy/reorder`) {
        postStatuses.push(response.status());
      }
    });

    await page.goto(`${base}/notes/books/${book.id}`);
    await page.getByRole('link', { name: 'Reorder book contents', exact: true }).click();
    const dialog = page.locator('#book-order-dialog');
    const oldEditor = await dialog.locator('[data-book-hierarchy-editor]').elementHandle();
    let releaseSnapshot;
    const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
    let markSnapshotStarted;
    const snapshotStarted = new Promise(resolve => { markSnapshotStarted = resolve; });
    let delayNextSnapshot = true;
    await page.route(`**/notes/books/${book.id}/order`, async (route) => {
      if (route.request().method() !== 'GET' || !delayNextSnapshot) return route.continue();
      delayNextSnapshot = false;
      markSnapshotStarted();
      await snapshotGate;
      return route.continue();
    });

    const firstPost = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/notes/books/${book.id}/hierarchy/reorder`);
    const snapshotResponse = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/notes/books/${book.id}/order`);
    await dialog.locator('[data-book-hierarchy-handle]').first().press('End');
    expect((await firstPost).status()).toBe(200);
    await snapshotStarted;

    await expect(dialog.locator('[data-book-hierarchy-form]')).toHaveAttribute('aria-busy', 'true');
    const concurrentPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Concurrent Page' });
    releaseSnapshot();
    expect((await snapshotResponse).status()).toBe(200);

    const concurrentKey = `page:${concurrentPage.id}`;
    await expect(page.locator('[data-book-detail-live-region] .notes-book-nav-page-link', { hasText: 'Concurrent Page' })).toHaveCount(1);
    await expect(dialog.locator(`[data-book-hierarchy-item][data-content-key="${concurrentKey}"]`)).toHaveCount(1);
    await expect.poll(async () => dialog.locator('[data-book-hierarchy-input]').evaluate((input, key) => {
      const hierarchy = JSON.parse(input.value).expected;
      const keys = hierarchy.flatMap(entry => entry.type === 'chapter'
        ? [`chapter:${entry.id}`, ...entry.pages.map(id => `page:${id}`)]
        : [`page:${entry.id}`]);
      return keys.includes(key);
    }, concurrentKey)).toBe(true);
    expect(await oldEditor.evaluate(editor => editor.__creatorCrateBookHierarchyState.retired)).toBe(true);

    const nextPost = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/notes/books/${book.id}/hierarchy/reorder`);
    await dialog.locator(`[data-book-hierarchy-item][data-content-key="${concurrentKey}"] [data-book-hierarchy-handle]`).press('Home');
    expect((await nextPost).status()).toBe(200);
    await expect.poll(() => postStatuses).toEqual([200, 200]);
    await expect(dialog.locator('[data-book-hierarchy-form]')).not.toHaveAttribute('aria-busy', 'true');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('contents: controlled rejection installs one canonical snapshot after concurrent membership change while closed', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-hierarchy-rejection-sync-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Book Alpha' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Alpha' });
    app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Chapter Page' });
    app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const hierarchyPath = `/notes/books/${book.id}/hierarchy/reorder`;
    const orderPath = `/notes/books/${book.id}/order`;
    let rejectFirstPost = true;
    let orderGets = 0;
    let detailOnlyGets = 0;
    let hierarchyPosts = 0;
    let releaseSnapshot;
    const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
    let markSnapshotStarted;
    const snapshotStarted = new Promise(resolve => { markSnapshotStarted = resolve; });

    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === hierarchyPath) {
        hierarchyPosts += 1;
      }
      if (request.method() !== 'GET') return;
      const pathname = new URL(request.url()).pathname;
      if (pathname === orderPath) orderGets += 1;
      if (pathname === `/notes/books/${book.id}`) detailOnlyGets += 1;
    });
    await page.route(`**${hierarchyPath}`, async (route) => {
      if (route.request().method() !== 'POST' || !rejectFirstPost) return route.continue();
      rejectFirstPost = false;
      const submission = JSON.parse(new URLSearchParams(route.request().postData()).get('hierarchy'));
      const authority = [...submission.expected.slice(1), submission.expected[0]];
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'error',
          code: 'HIERARCHY_STALE',
          message: 'Nothing was saved because the Book hierarchy changed.',
          hierarchy: authority,
          refreshUrl: `/notes/books/${book.id}`,
        }),
      });
    });
    let gateNextSnapshot = true;
    await page.route(`**${orderPath}`, async (route) => {
      if (route.request().method() !== 'GET' || !gateNextSnapshot) return route.continue();
      gateNextSnapshot = false;
      markSnapshotStarted();
      await snapshotGate;
      return route.continue();
    });

    await page.goto(`${base}/notes/books/${book.id}`);
    await page.getByRole('link', { name: 'Reorder book contents', exact: true }).click();
    const dialog = page.locator('#book-order-dialog');
    const oldEditor = await dialog.locator('[data-book-hierarchy-editor]').elementHandle();
    const initialDetailGets = detailOnlyGets;
    await dialog.locator('[data-book-hierarchy-handle]').first().press('End');
    await snapshotStarted;

    await expect(dialog.locator('[data-book-hierarchy-form]')).toHaveAttribute('aria-busy', 'true');
    expect(hierarchyPosts).toBe(1);
    await oldEditor.evaluate(editor => {
      editor.querySelector('[data-book-hierarchy-handle]')?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Home', bubbles: true, cancelable: true,
      }));
    });
    expect(hierarchyPosts).toBe(1);

    await dialog.getByRole('button', { name: 'Close Reorder book contents', exact: true }).click();
    await page.evaluate(() => {
      const focusGuard = document.createElement('button');
      focusGuard.id = 'controlled-rejection-focus-guard';
      focusGuard.textContent = 'Focus guard';
      document.body.appendChild(focusGuard);
      focusGuard.focus();
    });
    const concurrentPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Concurrent Page' });
    releaseSnapshot();

    await expect(page.locator('[data-book-detail-live-region] .notes-book-nav-page-link', { hasText: 'Concurrent Page' })).toHaveCount(1);
    await expect(page.locator('#controlled-rejection-focus-guard')).toBeFocused();
    expect(orderGets).toBe(1);
    expect(detailOnlyGets).toBe(initialDetailGets);
    expect(await oldEditor.evaluate(editor => editor.__creatorCrateBookHierarchyState.retired)).toBe(true);

    await page.getByRole('link', { name: 'Reorder book contents', exact: true }).click();
    const concurrentKey = `page:${concurrentPage.id}`;
    await expect(dialog.locator(`[data-book-hierarchy-item][data-content-key="${concurrentKey}"]`)).toHaveCount(1);
    await expect.poll(async () => dialog.locator('[data-book-hierarchy-input]').evaluate((input, key) => {
      const hierarchy = JSON.parse(input.value).expected;
      const keys = hierarchy.flatMap(entry => entry.type === 'chapter'
        ? [`chapter:${entry.id}`, ...entry.pages.map(id => `page:${id}`)]
        : [`page:${entry.id}`]);
      return keys.includes(key);
    }, concurrentKey)).toBe(true);

    const nextPost = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === hierarchyPath);
    await dialog.locator(`[data-book-hierarchy-item][data-content-key="${concurrentKey}"] [data-book-hierarchy-handle]`).press('Home');
    expect((await nextPost).status()).toBe(200);
    expect(hierarchyPosts).toBe(2);
    await expect(dialog.locator('[data-book-hierarchy-form]')).not.toHaveAttribute('aria-busy', 'true');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('contents: closed dialog installs canonical empty authority after a successful reorder', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-hierarchy-closed-success-sync-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Book Alpha' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Alpha' });
    const directPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let posts = 0;
    page.on('request', request => {
      if (request.method() === 'POST'
        && new URL(request.url()).pathname === `/notes/books/${book.id}/hierarchy/reorder`) posts += 1;
    });

    await page.goto(`${base}/notes/books/${book.id}`);
    const opener = page.getByRole('link', { name: 'Reorder book contents', exact: true });
    await opener.click();
    const dialog = page.locator('#book-order-dialog');
    const oldEditor = await dialog.locator('[data-book-hierarchy-editor]').elementHandle();
    let releaseSnapshot;
    const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
    let markSnapshotStarted;
    const snapshotStarted = new Promise(resolve => { markSnapshotStarted = resolve; });
    let delayNextSnapshot = true;
    await page.route(`**/notes/books/${book.id}/order`, async (route) => {
      if (route.request().method() !== 'GET' || !delayNextSnapshot) return route.continue();
      delayNextSnapshot = false;
      markSnapshotStarted();
      await snapshotGate;
      return route.continue();
    });

    const snapshotResponse = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/notes/books/${book.id}/order`);
    await dialog.locator('[data-book-hierarchy-handle]').first().press('End');
    await snapshotStarted;
    await dialog.getByRole('button', { name: 'Close Reorder book contents', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();

    app.locals.noteService.deleteNote(directPage.id);
    app.locals.chapterService.deleteChapter(chapter.id);
    releaseSnapshot();
    expect((await snapshotResponse).status()).toBe(200);
    await expect(opener).toBeFocused();
    expect(await oldEditor.evaluate(editor => editor.__creatorCrateBookHierarchyState.retired)).toBe(true);
    expect(posts).toBe(1);

    await opener.click();
    await expect(dialog.getByText('This Book has no Chapters or Pages to order yet.', { exact: true })).toBeVisible();
    await expect(dialog.locator('[data-book-hierarchy-input]')).toHaveValue(JSON.stringify({ version: 1, expected: [], target: [] }));
    await expect(dialog.locator('[data-book-hierarchy-handle]')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Retry reconciliation', exact: true })).toHaveCount(0);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
