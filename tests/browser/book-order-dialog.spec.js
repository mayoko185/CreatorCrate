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
    const opener = page.getByRole('link', { name: 'Change order', exact: true });
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
        expect(await domHierarchy()).toEqual(target);
        const payload = JSON.parse(await hierarchyInput.inputValue());
        expect(payload.expected).toEqual(renderedHierarchy);
        expect(payload.target).toEqual(target);
        expect(posts).toHaveLength(0);
      };
      const persistencePosts = () => posts.filter((request) => {
        const pathname = new URL(request.url()).pathname;
        return pathname.includes('/hierarchy/reorder')
          || pathname.includes('/move')
          || pathname.includes('/notes/reorder')
          || pathname.includes('/contents/reorder');
      });

      await expect(dialog.getByRole('heading', { name: 'Book hierarchy', exact: true })).toBeVisible();
      await expect(dialog.getByText('Drag cards to reorder. Select Save to apply changes.', { exact: true })).toBeVisible();
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
      await handle(`page:${directPage.id}`).press('Home');
      target[0].pages = [directPage.id, chapterPageA.id, chapterPageB.id];
      await expect(handle(`page:${directPage.id}`)).toBeFocused();
      await expect(live).toContainText(`Page “${directPage.title}” moved to Chapter “${chapter.title}”, position 1 of 3.`);
      await expectDraft(target);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
      expect(persistencePosts()).toHaveLength(0);
      expect(JSON.parse(await hierarchyInput.inputValue())).toEqual(initialHierarchy);

      await opener.click();
      await expect(dialog).toBeVisible();
      expect(await domHierarchy()).toEqual(renderedHierarchy);
      await dragBefore(title(`page:${chapterPageA.id}`), title(`chapter:${chapterB.id}`));
      target = [
        { type: 'chapter', id: chapter.id, pages: [chapterPageB.id] },
        { type: 'page', id: directPage.id },
        { type: 'page', id: chapterPageA.id },
        { type: 'chapter', id: chapterB.id, pages: [chapterBPage.id] },
        { type: 'chapter', id: emptyChapter.id, pages: [] },
        { type: 'page', id: directPageB.id },
        { type: 'page', id: directPageC.id },
      ];
      await expectDraft(target);
      await expect(item(`chapter:${chapter.id}`)).toContainText(chapter.title);
      await expect(container(`chapter:${chapter.id}`).locator(':scope > [data-book-hierarchy-item]')).toHaveCount(1);
      await dialog.getByRole('button', { name: 'Close Change order', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      expect(persistencePosts()).toHaveLength(0);

      await opener.click();
      await expect(dialog).toBeVisible();
      expect(await domHierarchy()).toEqual(renderedHierarchy);
      expect(JSON.parse(await hierarchyInput.inputValue())).toEqual(initialHierarchy);
      await page.mouse.click(1, 1);
      await expect(dialog).toBeVisible();
      expect(await domHierarchy()).toEqual(renderedHierarchy);
      expect(persistencePosts()).toHaveLength(0);

      await dragToEnd(title(`page:${directPage.id}`), container(`chapter:${chapter.id}`));
      target = [
        { type: 'chapter', id: chapter.id, pages: [chapterPageA.id, chapterPageB.id, directPage.id] },
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

      expect(persistencePosts()).toHaveLength(0);
      const response = page.waitForResponse(candidate => (
        candidate.request().method() === 'POST'
        && new URL(candidate.url()).pathname === `/notes/books/${book.id}/hierarchy/reorder`
      ));
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await response).status()).toBe(302);
      await expect(page).toHaveURL(base + config.host);
      expect(config.read()).toEqual(target);
      expect(posts).toHaveLength(1);
      expect(new URL(posts[0].url()).pathname).toBe(`/notes/books/${book.id}/hierarchy/reorder`);
      expect(JSON.parse(new URLSearchParams(posts[0].postData()).get('hierarchy'))).toEqual({
        version: 1,
        expected: renderedHierarchy,
        target,
      });
      expect(new URLSearchParams(posts[0].postData()).has('orderedItems')).toBe(false);
      expect(new URLSearchParams(posts[0].postData()).has('orderedNoteIds')).toBe(false);
      expect(new URLSearchParams(posts[0].postData()).get('_csrf')).toBeTruthy();
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
      else if (close === 'X') await dialog.getByRole('button', { name: 'Close Change order', exact: true }).click();
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
