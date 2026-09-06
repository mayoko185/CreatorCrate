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
    app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page' });
    app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Page Alpha' });
    app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Page Beta' });
    const config = {
      books: { host: '/notes', direct: '/notes/books/order', id: 'books-order-dialog', input: 'orderedBookIds', handle: 'data-book-reorder-handle', item: 'data-book-reorder-item', read: () => app.locals.bookService.listBooks().map(x => String(x.id)), peers: ['New Book'], redirect: '/notes?notice=book_reordered' },
      contents: { host: `/notes/books/${book.id}`, direct: `/notes/books/${book.id}/order`, id: 'book-order-dialog', input: 'orderedItems', handle: 'data-book-content-reorder-handle', item: 'data-book-content-reorder-item', read: () => app.locals.bookService.listBookContents(book.id).map(x => `${x.type}:${x.id}`), peers: ['Edit Book', 'New Chapter'] },
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
      await page.getByRole('link', { name: peer, exact: true }).click();
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
